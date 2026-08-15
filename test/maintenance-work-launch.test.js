import { test } from "node:test";
import assert from "node:assert/strict";
import { createStopStore } from "../container/maintenance-stop-store.js";
import { createClaimsStore } from "../container/maintenance-claims-store.js";
import { createRunsStore } from "../container/maintenance-runs-store.js";
import { createBudgetStore } from "../container/maintenance-budget-store.js";
import { createAuditStore } from "../container/maintenance-audit-store.js";
import { createWorkLauncher } from "../container/maintenance-work-launch.js";

function memoryLog(records = []) {
  return { records, append: (r) => records.push(JSON.parse(JSON.stringify(r))), readAll: () => records.slice() };
}
const pass = () => {};
const POLICY = { policyVersion: 1, costLimitEnabled: true, costLimitMicros: 10_000_000 };
const LIMITS = { maxExecs: 5, maxLifetimeMs: 3_600_000, maxTokenUnits: 1_000_000, maxHandoffs: 8, maxConsecutiveSamePair: 2, softStopPermille: 800 };
const RUN = { id: "run_1", kind: "board_task", taskId: "task_1", chainId: "chain_1", profileId: "profile_x", repoId: "repo_y", workMode: "new", engines: ["claude"], summary: "" };
const STARTP = { mode: "new", taskId: "task_1", runId: "run_1", chainId: "chain_1", engine: "claude", profileId: "profile_x", repoId: "repo_y" };

function setup({ spawn, worstCase = { tokenUnits: 100, costMicros: 2_000_000 }, resumeStop = true, acceptRun = true } = {}) {
  const stopStore = createStopStore({ log: memoryLog(), validateStopView: pass });
  if (resumeStop) stopStore.resume({ expectedVersion: 1 }); // fresh STOP defaults engaged (first_secure_migration)
  const claimsStore = createClaimsStore({ log: memoryLog(), validateClaimView: pass });
  const runsStore = createRunsStore({ log: memoryLog(), validateRunView: pass });
  const budgetStore = createBudgetStore({ log: memoryLog(), policy: POLICY, structuralLimits: LIMITS });
  const auditStore = createAuditStore({ log: memoryLog() });
  if (acceptRun) runsStore.accept(RUN);
  const launcher = createWorkLauncher({
    stopStore, claimsStore, runsStore, budgetStore, auditStore,
    spawn: spawn || (({ workerRef }) => ({ childRef: "child_" + workerRef })),
    worstCaseFor: () => worstCase,
  });
  return { stopStore, claimsStore, runsStore, budgetStore, auditStore, launcher };
}

test("happy launch: atomic authorize -> spawn -> child observed, lane taken", () => {
  const s = setup();
  const r = s.launcher.start(STARTP);
  assert.equal(r.claim.state, "active");
  assert.equal(r.claim.workerRef, r.worker.workerRef);
  assert.equal(s.runsStore.get("run_1").status, "running");
  assert.equal(s.budgetStore.view("chain_1").reservedCostMicros, 2_000_000);
  assert.equal(s.launcher.laneState().busy, true);
  const audits = s.auditStore.read({ afterSeq: 0 }).events.map((e) => e.eventCode);
  assert.deepEqual(audits, ["launch_authorized", "spawn_attempted", "child_observed"]);
});

test("STOP-first: an engaged STOP denies launch with no mutation", () => {
  const s = setup({ resumeStop: false }); // STOP stays engaged
  assert.throws(() => s.launcher.start(STARTP), (e) => e.code === "STOP_ENGAGED");
  assert.equal(s.launcher.laneState().busy, false);
  assert.equal(s.runsStore.get("run_1").status, "queued");
});

test("one lane: a second concurrent launch is LANE_BUSY", () => {
  const s = setup();
  s.launcher.start(STARTP);
  assert.throws(() => s.launcher.start(STARTP), (e) => e.code === "LANE_BUSY");
});

test("an unaccepted run or a binding mismatch is rejected", () => {
  const s = setup({ acceptRun: false });
  assert.throws(() => s.launcher.start(STARTP), (e) => e.code === "RUN_NOT_ACCEPTED");
  const s2 = setup();
  assert.throws(() => s2.launcher.start({ ...STARTP, repoId: "repo_other" }), (e) => e.code === "RUN_CONFLICT");
});

test("budget exhaustion fails closed and does not leak the lane or claim", () => {
  const s = setup({ worstCase: { tokenUnits: 100, costMicros: 20_000_000 } }); // exceeds cap
  assert.throws(() => s.launcher.start(STARTP), (e) => e.code === "BUDGET_EXHAUSTED");
  assert.equal(s.launcher.laneState().busy, false);
});

test("proven no-child spawn: refund exactly once, claim failed, lane freed", () => {
  const s = setup({ spawn: () => { const e = new Error("no child"); e.conclusiveNoChild = true; throw e; } });
  assert.throws(() => s.launcher.start(STARTP), (e) => e.code === "SPAWN_FAILED");
  const b = s.budgetStore.view("chain_1");
  assert.equal(b.costMicros, 0);          // nothing settled
  assert.equal(b.reservedCostMicros, 0);  // reservation refunded
  assert.equal(s.runsStore.get("run_1").status, "failed");
  assert.equal(s.launcher.laneState().busy, false);
});

test("ambiguous spawn: full charge, claim quarantined (not releasable), lane freed", () => {
  const s = setup({ spawn: () => { throw new Error("unknown"); } });
  assert.throws(() => s.launcher.start(STARTP), (e) => e.code === "LAUNCH_AMBIGUOUS");
  const b = s.budgetStore.view("chain_1");
  assert.equal(b.costMicros, 2_000_000);   // full reservation charged
  assert.equal(b.reservedCostMicros, 0);
  assert.equal(s.runsStore.get("run_1").status, "interrupted");
  assert.equal(s.launcher.laneState().busy, false);
});

test("completeWorker settles once, frees the lane, and lets a new launch proceed", () => {
  const s = setup();
  const r = s.launcher.start(STARTP);
  const done = s.launcher.completeWorker({ workerRef: r.worker.workerRef, claimRef: r.claim.ref, runId: "run_1", engine: "claude", taskId: "task_1", chainId: "chain_1", outcome: "completed", usage: { tokenUnits: 30, costMicros: 500_000 } });
  assert.equal(done.budget.costMicros, 500_000);    // trusted usage, not full charge
  assert.equal(done.claim.workerRef, null);
  assert.equal(s.runsStore.get("run_1").status, "completed");
  assert.equal(s.launcher.laneState().busy, false);
  // a fresh accepted run can now launch on the freed lane
  s.runsStore.accept({ ...RUN, id: "run_2", taskId: "task_2" });
  const r2 = s.launcher.start({ ...STARTP, runId: "run_2", taskId: "task_2" });
  assert.equal(r2.run.status, "running");
});

test("review mode requires an awaiting_review claim and a reviewer engine != author", () => {
  const s = setup();
  const r = s.launcher.start(STARTP);
  s.launcher.completeWorker({ workerRef: r.worker.workerRef, claimRef: r.claim.ref, runId: "run_1", engine: "claude", taskId: "task_1", chainId: "chain_1", outcome: "completed", usage: { tokenUnits: 1, costMicros: 1 } });
  // author (claude) moves the claim to awaiting_review (caller CAS); lane is free
  const reloaded = s.claimsStore.get(r.claim.ref);
  s.claimsStore.transition(r.claim.ref, { expectedVersion: reloaded.version, to: "awaiting_review" });
  // a review run whose binding allows either engine
  s.runsStore.accept({ ...RUN, id: "run_rev", workMode: "review", engines: ["claude", "codex"] });
  // same-engine review (author == reviewer) is rejected
  assert.throws(() => s.launcher.start({ ...STARTP, runId: "run_rev", mode: "review", claimRef: r.claim.ref, engine: "claude" }), (e) => e.code === "RUN_CONFLICT");
  // a different reviewer engine is accepted and moves the claim to reviewing
  const rev = s.launcher.start({ ...STARTP, runId: "run_rev", mode: "review", claimRef: r.claim.ref, engine: "codex" });
  assert.equal(rev.claim.state, "reviewing");
  assert.equal(rev.claim.workerRef, rev.worker.workerRef);
});
