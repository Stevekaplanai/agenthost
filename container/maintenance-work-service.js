"use strict";

// Dormant Foundation-B candidate: the work.* handler composition (BUILD-PLAN
// Phase 1f, Step 4a — piece 3). Wires the atomic launch transaction
// (maintenance-work-launch.js) + the live worker-view registry
// (maintenance-worker-registry.js) + the protocol handle registry into the four
// IPC work.* dispatch handlers. Each handler returns the exact §6 success data;
// the protocol's validateResponse is the authoritative shape check at the edge.
//
//   work.start  (R/M) : launcher.start -> observe worker -> mint connection-bound
//                       claim+worker handles -> { claimHandle, workerHandle,
//                       claim, worker, budget }.
//   work.inspect(C/Q) : resolve workerRef -> { worker, claim, budget }.
//   work.cancel (O/M) : the O-class effect already consumed the proof upstream;
//                       beginCancel drives running->stopping -> { worker }.
//                       (Exposed here as the cancelWorker seam the operator
//                       effect binds to; it takes the canonical target only.)
//   completeWorker    : reap settlement (launcher) + terminal worker view — an
//                       internal PID-1 step, not a caller method.
//
// One live worker at a time (agentBusy). DORMANT: no boot wiring; the physical
// spawn/containment is injected and proven on real Linux separately. Output-chunk
// spooling for work.output.read is a following brick.

const { createWorkLauncher } = require("./maintenance-work-launch.js");
const { createWorkerRegistry } = require("./maintenance-worker-registry.js");

function createWorkService({
  stopStore, claimsStore, runsStore, budgetStore, auditStore,
  handles, spawn, worstCaseFor, now = Date.now, randomBytes,
} = {}) {
  for (const [name, v] of Object.entries({ stopStore, claimsStore, runsStore, budgetStore, auditStore, handles, spawn, worstCaseFor })) {
    if (!v) throw new Error(`work service requires ${name}`);
  }
  if (typeof handles.issue !== "function" || typeof handles.resolve !== "function") {
    throw new Error("work service requires a protocol handle registry { issue, resolve, ... }");
  }

  const launcher = createWorkLauncher({ stopStore, claimsStore, runsStore, budgetStore, auditStore, spawn, worstCaseFor, randomBytes });
  const workers = createWorkerRegistry({ now });

  // Per-connection identity is supplied by PID 1 on each request.
  function conn(ctx) {
    if (!ctx || typeof ctx.connectionId !== "string" || typeof ctx.gatewayEpoch !== "string") {
      const e = new Error("work service requires connectionId + gatewayEpoch in context");
      e.code = "STALE_EPOCH";
      throw e;
    }
    return { connectionId: ctx.connectionId, epoch: ctx.gatewayEpoch };
  }

  // work.start — atomic acquire+reserve+intent+spawn, then materialize the worker
  // view and issue the connection-bound handles the later CAS methods resolve.
  function start(request, ctx) {
    const p = request.params;
    const claimRefIn = p.mode === "new" ? undefined : handles.resolve(p.claimHandle, { ...conn(ctx), kind: "claim" }).ref;
    const out = launcher.start({
      mode: p.mode, taskId: p.taskId, runId: p.runId, chainId: p.chainId,
      engine: p.engine, profileId: p.profileId, repoId: p.repoId, claimRef: claimRefIn,
      objective: p.objective, // delivered into the jailed engine's argv ({objective} slot)
    });
    const worker = workers.observe({ workerRef: out.worker.workerRef, claimRef: out.claim.ref });
    const budget = budgetStore.view(out.claim.chainId);
    const claimHandle = handles.issue({ ...conn(ctx), kind: "claim", value: { ref: out.claim.ref } });
    const workerHandle = handles.issue({ ...conn(ctx), kind: "worker", value: { ref: worker.ref } });
    return { data: { claimHandle, workerHandle, claim: out.claim, worker, budget }, summary: "Work started." };
  }

  // work.inspect — resolve the opaque worker ref to the current bundle.
  function inspect(request) {
    const worker = workers.get(request.params.workerRef);
    if (!worker) { const e = new Error("no such worker"); e.code = "STORE_UNAVAILABLE"; throw e; }
    const claim = claimsStore.get(worker.claimRef);
    if (!claim) { const e = new Error("worker claim is gone"); e.code = "STORE_UNAVAILABLE"; throw e; }
    const budget = budgetStore.view(claim.chainId);
    return { data: { worker, claim, budget }, summary: "Worker inspected." };
  }

  // The O-class worker_cancel effect seam: the protocol already verified and
  // consumed the one-use proof; this performs exactly the stopping transition.
  function cancelWorker(target) {
    return workers.beginCancel({ workerRef: target.workerRef, expectedWorkerVersion: target.expectedWorkerVersion, reasonCode: target.reasonCode });
  }

  // Internal reap step (PID 1, not a caller method): settle once + terminal view.
  function completeWorker(args) {
    const settled = launcher.completeWorker(args);
    const worker = workers.complete({ workerRef: args.workerRef, outcome: args.outcome, exitCode: args.exitCode ?? null, signalName: args.signalName ?? null });
    return { claim: settled.claim, budget: settled.budget, worker };
  }

  // Exit-driven completion (PID 1-internal): the containment chain finished, so
  // settle + terminalize using the EXACT binding the launch captured (never a
  // reconstructed one). Idempotent: an already-terminal or unknown worker is a
  // no-op (returns null). Outcome mapping: an operator cancel in flight
  // (stopping) -> cancelled; clean exit 0 -> completed; killed by signal ->
  // interrupted; any other exit -> failed. No trusted usage is available from a
  // raw exit, so the budget settles at the reserved worst case (fail-closed).
  function completeFromExit(workerRef, { exitCode = null, signalName = null } = {}) {
    const view = workers.get(workerRef);
    if (!view || !["running", "stopping"].includes(view.state)) return null;
    const binding = launcher.laneBinding(workerRef);
    if (!binding) return null; // lane already released (recovery/cancel path settled first)
    const outcome = view.state === "stopping" ? "cancelled"
      : signalName ? "interrupted"
      : exitCode === 0 ? "completed" : "failed";
    return completeWorker({
      workerRef, claimRef: binding.claimRef, runId: binding.runId, chainId: binding.chainId,
      taskId: binding.taskId, engine: binding.engine, outcome, usage: null,
      exitCode: signalName ? null : exitCode, signalName: signalName || null,
    });
  }

  return Object.freeze({ start, inspect, cancelWorker, completeWorker, completeFromExit, laneState: launcher.laneState, workerView: workers.get });
}

module.exports = { createWorkService };
