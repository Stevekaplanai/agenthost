"use strict";

// Dormant Foundation-B candidate: the atomic work.start launch transaction
// (BUILD-PLAN Phase 1d; ROOT-SERVICE-STATE-MACHINES §3, §5, §6; IPC contract §6
// work.start, §9 atomicity). work.start is the ONLY caller operation that
// acquires a claim, reserves budget, persists launch intent, and spawns — there
// is no separate claim.acquire/budget.reserve, so there is no check-to-launch
// gap.
//
// Ordering enforced here (all pre-spawn checks are non-mutating; then the
// mutation sequence commits before spawn):
//   1. STOP not engaged;         2. the single lane is free (agentBusy);
//   3. an already-accepted worker run whose binding matches;  4. claim acquired
//   per mode;  5. budget reserved (fixed-profile worst case);  6. launch intent
//   + audit (launch_authorized);  7. a durable spawn-attempt marker immediately
//   before the spawn;  8. spawn;  9. child observed -> run running + worker
//   attached.
//
// Crash-point spawn outcomes (§5 terminal accounting, §6):
//   - observed child            -> running; settle later from trusted usage.
//   - PROVEN no child (conclusive synchronous result) -> refund exactly once,
//     claim failed, run failed, lane freed.
//   - AMBIGUOUS (marker written, child unknown) -> full-charge the reservation,
//     quarantine the claim (not releasable), run interrupted, lane freed.
//
// The physical process spawn, service-created containment (PID ns / cgroup),
// and descendant/mount cleanup proof are INJECTED via `spawn` and proven on real
// Linux in a follow-on increment. DORMANT: not wired into any boot path;
// activation is the atomic, separately-gated Phase 1f event. `agentBusy` remains
// the one-lane ceiling — never a lane pool.

const { randomBytes: defaultRandomBytes } = require("node:crypto");

const PRELAUNCH_RUN = new Set(["queued", "waiting", "gated"]);

class WorkLaunchError extends Error {
  constructor(code, message) { super(message); this.name = "WorkLaunchError"; this.code = code; }
}
function fail(code, message) { throw new WorkLaunchError(code, message); }

function createWorkLauncher({ stopStore, claimsStore, runsStore, budgetStore, auditStore, spawn, worstCaseFor, randomBytes = defaultRandomBytes } = {}) {
  for (const [name, v] of Object.entries({ stopStore, claimsStore, runsStore, budgetStore, auditStore, spawn, worstCaseFor })) {
    if (!v) throw new Error(`work launcher requires ${name}`);
  }
  // The single live lane (agentBusy). One worker at a time — never a pool.
  let lane = { busy: false, workerRef: null };
  const newWorkerRef = () => "wrk_" + randomBytes(18).toString("base64url");

  function audit(eventCode, detail, { runId, taskId, engine }) {
    auditStore.appendService({ eventCode, detail, runId, taskId, engine });
  }

  // The atomic launch transaction. Pre-spawn checks mutate nothing; the mutation
  // sequence (claim, budget, intent, marker) commits before the spawn syscall.
  function start({ mode, taskId, runId, chainId, engine, profileId, repoId, claimRef, objective } = {}) {
    // 1. STOP-first (STOP and work.start serialize on one boundary).
    if (stopStore.get().engaged) fail("STOP_ENGAGED", "STOP is engaged; no new work");
    // 2. one live lane.
    if (lane.busy) fail("LANE_BUSY", "the single worker lane is occupied");
    // 3. an already-accepted worker run whose complete binding matches.
    const run = runsStore.get(runId);
    if (!run || run.authority !== "worker") fail("RUN_NOT_ACCEPTED", "no accepted worker run for this id");
    if (!PRELAUNCH_RUN.has(run.status)) fail("RUN_NOT_ACCEPTED", "run is not in a pre-launch state");
    if (run.taskId !== taskId || run.chainId !== chainId || run.profileId !== profileId || run.repoId !== repoId) fail("RUN_CONFLICT", "work.start binding does not match the accepted run");
    if (!run.engines.includes(engine)) fail("RUN_CONFLICT", "engine is not part of the accepted run");

    // 4. claim per mode. `new` requires no existing claim; review/correction act
    // on the current claim (a fixed reviewer engine differs from the author).
    let claim;
    if (mode === "new") {
      claim = claimsStore.create({ taskId, runId, chainId, authorEngine: engine });
    } else if (mode === "review" || mode === "correction") {
      if (typeof claimRef !== "string") fail("RUN_CONFLICT", `${mode} requires the current claim`);
      const current = claimsStore.get(claimRef);
      if (!current) fail("RUN_CONFLICT", "claim not found");
      if (mode === "review") {
        if (current.state !== "awaiting_review") fail("INVALID_TRANSITION", "review requires an awaiting_review claim");
        if (current.authorEngine === engine) fail("RUN_CONFLICT", "the reviewer engine must differ from the author");
        claim = claimsStore.transition(claimRef, { expectedVersion: current.version, to: "reviewing" });
      } else {
        if (current.state !== "correction_required") fail("INVALID_TRANSITION", "correction requires a correction_required claim");
        claim = claimsStore.transition(claimRef, { expectedVersion: current.version, to: "active" });
      }
    } else {
      fail("INVALID_REQUEST", "mode must be new, review, or correction");
    }

    // 5. reserve the fixed-profile worst case (chain/loop guards would also apply
    // here — DEFERRED to the chain-guard increment).
    const workerRef = newWorkerRef();
    const worst = worstCaseFor({ profileId });
    try {
      budgetStore.reserve({ chainId, workerRef, tokenUnits: worst.tokenUnits, costMicros: worst.costMicros });
    } catch (error) {
      // Reservation failed: the claim we just moved is now ambiguous work with
      // no worker; interrupt it so the lane/claim do not leak. Fail closed.
      claimsStore.transition(claim.ref, { expectedVersion: claim.version, to: "interrupted" });
      if (error.code === "BUDGET_EXHAUSTED") fail("BUDGET_EXHAUSTED", "the chain budget is exhausted");
      throw error;
    }

    // 6. launch intent + audit outbox (commit before spawn).
    audit("launch_authorized", { claimRef: claim.ref, workerRef, profileId }, { runId, taskId, engine });
    // Take the lane now: authorization has committed.
    lane = { busy: true, workerRef, claimRef: claim.ref, runId, chainId, taskId, engine, runVersion: run.version };

    // 7. durable spawn-attempt marker immediately before the spawn syscall.
    audit("spawn_attempted", { claimRef: claim.ref, workerRef }, { runId, taskId, engine });

    // 8. spawn (injected; real containment + child observation is Phase-1d Linux work).
    let child;
    try {
      child = spawn({ workerRef, profileId, engine, repoId, objective });
    } catch (error) {
      if (error && error.conclusiveNoChild === true) {
        // Proven synchronous no-child: refund exactly once, fail closed.
        budgetStore.refund({ workerRef });
        claimsStore.transition(claim.ref, { expectedVersion: claim.version, to: "failed" });
        runsStore.serviceTransition(runId, { expectedVersion: run.version, to: "failed" });
        audit("budget_settled", { chainId, workerRef, tokenUnits: 0, costMicros: 0, mode: "proven_no_spawn_refund" }, { runId, taskId, engine });
        lane = { busy: false, workerRef: null };
        fail("SPAWN_FAILED", "spawn proved no child; reservation refunded");
      }
      // Ambiguous: charge the full reservation, quarantine (not releasable).
      budgetStore.settle({ workerRef, trusted: false });
      claimsStore.transition(claim.ref, { expectedVersion: claim.version, to: "quarantined" });
      runsStore.serviceTransition(runId, { expectedVersion: run.version, to: "interrupted" });
      lane = { busy: false, workerRef: null };
      fail("LAUNCH_AMBIGUOUS", "spawn result is ambiguous; charged full reservation and quarantined");
    }
    if (!child || typeof child.childRef !== "string") fail("INTERNAL_RESPONSE_INVALID", "spawn must return a kernel-observed child identity");

    // 9. child observed: record running + attach the worker to the claim.
    audit("child_observed", { claimRef: claim.ref, workerRef }, { runId, taskId, engine });
    const running = runsStore.serviceTransition(runId, { expectedVersion: run.version, to: "running" });
    claim = claimsStore.attachWorker(claim.ref, { expectedVersion: claim.version, workerRef });
    return { claim, worker: { workerRef, childRef: child.childRef }, run: running };
  }

  // Observed exit: settle exactly once from trusted usage (or full charge if
  // absent), detach the worker, record the run terminal, and free the lane. The
  // claim's SEMANTIC transition (active -> awaiting_review, etc.) is the caller's
  // separate CAS and is not done here.
  function completeWorker({ workerRef, claimRef, runId, engine, taskId, chainId, outcome, usage } = {}) {
    if (!lane.busy || lane.workerRef !== workerRef) fail("STALE_HANDLE", "worker is not the active lane worker");
    const claim = claimsStore.get(claimRef);
    const run = runsStore.get(runId);
    const trusted = usage && Number.isSafeInteger(usage.tokenUnits) && Number.isSafeInteger(usage.costMicros);
    const settled = budgetStore.settle({ workerRef, trusted, observedTokenUnits: trusted ? usage.tokenUnits : null, observedCostMicros: trusted ? usage.costMicros : null });
    audit("budget_settled", { chainId, workerRef, tokenUnits: settled.view.tokenUnits, costMicros: settled.view.costMicros, mode: settled.mode }, { runId, taskId, engine });
    const detached = claimsStore.detachWorker(claim.ref, { expectedVersion: claim.version });
    const runTerminal = outcome === "failed" ? "failed" : outcome === "interrupted" ? "interrupted" : "completed";
    if (run.status === "running") runsStore.serviceTransition(runId, { expectedVersion: run.version, to: runTerminal });
    lane = { busy: false, workerRef: null };
    return { claim: detached, budget: settled.view };
  }

  function laneState() { return { busy: lane.busy, workerRef: lane.workerRef }; }

  // The full binding of the CURRENT lane worker (for the exit-driven completion
  // path — PID 1 observed the containment chain finish and must settle with the
  // exact identifiers the launch captured, never reconstructed ones).
  function laneBinding(workerRef) {
    if (!lane.busy || lane.workerRef !== workerRef) return null;
    return { claimRef: lane.claimRef, runId: lane.runId, chainId: lane.chainId, taskId: lane.taskId, engine: lane.engine };
  }

  // Free the lane for a specific worker after an out-of-band teardown (recovery
  // / gate-loss). Only the current lane worker can release it.
  function releaseLane(workerRef) {
    if (lane.busy && lane.workerRef === workerRef) { lane = { busy: false, workerRef: null }; return true; }
    return false;
  }

  return Object.freeze({ start, completeWorker, laneState, laneBinding, releaseLane });
}

module.exports = { createWorkLauncher, WorkLaunchError };
