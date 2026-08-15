import { test } from "node:test";
import assert from "node:assert/strict";
import { createClaimsStore } from "../container/maintenance-claims-store.js";
import { createRunsStore } from "../container/maintenance-runs-store.js";
import { createBudgetStore } from "../container/maintenance-budget-store.js";
import { createBootReconciler } from "../container/maintenance-boot-reconciler.js";

function memoryLog(records = []) {
  return { records, append: (r) => records.push(JSON.parse(JSON.stringify(r))), readAll: () => records.slice() };
}
const pass = () => {};
const POLICY = { policyVersion: 1, costLimitEnabled: true, costLimitMicros: 10_000_000 };
const LIMITS = { maxExecs: 5, maxLifetimeMs: 3_600_000, maxTokenUnits: 1_000_000, maxHandoffs: 8, maxConsecutiveSamePair: 2, softStopPermille: 800 };

// Build a fresh, independent set of stores sharing distinct logs.
function makeStores() {
  const claimsStore = createClaimsStore({ log: memoryLog(), validateClaimView: pass });
  const runsStore = createRunsStore({ log: memoryLog(), validateRunView: pass });
  const budgetStore = createBudgetStore({ log: memoryLog(), policy: POLICY, structuralLimits: LIMITS });
  return { claimsStore, runsStore, budgetStore };
}

// Set up one in-flight claim (worker attached, budget reserved, run running)
// and one parked claim (no worker), as if a crash happened mid-flight.
function seedInFlightAndParked(s) {
  // in-flight
  s.runsStore.accept({ id: "run_inflight", kind: "board_task", taskId: "task_a", chainId: "chain_a", profileId: "profile_x", repoId: "repo_y", workMode: "new", engines: ["claude"], summary: "" });
  s.runsStore.serviceTransition("run_inflight", { expectedVersion: 1, to: "running" });
  s.budgetStore.reserve({ chainId: "chain_a", workerRef: "wrk_inflight", tokenUnits: 100, costMicros: 2_000_000 });
  let c = s.claimsStore.create({ taskId: "task_a", runId: "run_inflight", chainId: "chain_a", authorEngine: "claude" });
  c = s.claimsStore.attachWorker(c.ref, { expectedVersion: c.version, workerRef: "wrk_inflight" });
  const inflightRef = c.ref;

  // parked (awaiting_review, no worker)
  s.runsStore.accept({ id: "run_parked", kind: "board_task", taskId: "task_b", chainId: "chain_b", profileId: "profile_x", repoId: "repo_y", workMode: "new", engines: ["codex"], summary: "" });
  let p = s.claimsStore.create({ taskId: "task_b", runId: "run_parked", chainId: "chain_b", authorEngine: "codex" });
  p = s.claimsStore.transition(p.ref, { expectedVersion: p.version, to: "awaiting_review" });
  const parkedRef = p.ref;
  return { inflightRef, parkedRef };
}

test("boot reconciliation interrupts in-flight work and preserves parked work", () => {
  const s = makeStores();
  const { inflightRef, parkedRef } = seedInFlightAndParked(s);
  const reconciler = createBootReconciler(s);
  const summary = reconciler.reconcile();

  assert.deepEqual(summary.interrupted, [inflightRef]);
  assert.deepEqual(summary.parked, [parkedRef]);
  assert.deepEqual(summary.settled, ["wrk_inflight"]);

  // in-flight claim is now interrupted with its worker detached
  const inflight = s.claimsStore.get(inflightRef);
  assert.equal(inflight.state, "interrupted");
  assert.equal(inflight.workerRef, null);

  // its run is interrupted
  assert.equal(s.runsStore.get("run_inflight").status, "interrupted");

  // its budget was conservatively full-charged (settled == reservation, nothing reserved)
  const budget = s.budgetStore.view("chain_a");
  assert.equal(budget.costMicros, 2_000_000);
  assert.equal(budget.reservedCostMicros, 0);

  // parked claim is untouched (preserved, not launched)
  const parked = s.claimsStore.get(parkedRef);
  assert.equal(parked.state, "awaiting_review");
  assert.equal(s.runsStore.get("run_parked").status, "queued");
});

test("reconciliation is idempotent: a second pass changes nothing new", () => {
  const s = makeStores();
  const { inflightRef } = seedInFlightAndParked(s);
  const reconciler = createBootReconciler(s);
  reconciler.reconcile();
  const second = reconciler.reconcile();
  // the interrupted claim is terminal now, so it is neither interrupted again nor parked
  assert.deepEqual(second.interrupted, []);
  assert.ok(!second.parked.includes(inflightRef));
  assert.deepEqual(second.settled, []);
});

test("terminal claims are left untouched", () => {
  const s = makeStores();
  let c = s.claimsStore.create({ taskId: "task_c", runId: "run_c", chainId: "chain_c", authorEngine: "claude" });
  c = s.claimsStore.transition(c.ref, { expectedVersion: c.version, to: "failed" });
  const summary = createBootReconciler(s).reconcile();
  assert.deepEqual(summary.interrupted, []);
  assert.deepEqual(summary.parked, []);
  assert.equal(s.claimsStore.get(c.ref).state, "failed");
});

test("an in-flight claim whose worker never reserved budget is still interrupted", () => {
  const s = makeStores();
  s.runsStore.accept({ id: "run_x", kind: "loop", taskId: "task_x", chainId: "chain_x", profileId: "profile_x", repoId: "repo_y", workMode: "new", engines: ["claude"], summary: "" });
  s.runsStore.serviceTransition("run_x", { expectedVersion: 1, to: "running" });
  let c = s.claimsStore.create({ taskId: "task_x", runId: "run_x", chainId: "chain_x", authorEngine: "claude" });
  c = s.claimsStore.attachWorker(c.ref, { expectedVersion: c.version, workerRef: "wrk_noreserve" });
  const summary = createBootReconciler(s).reconcile();
  assert.deepEqual(summary.interrupted, [c.ref]);
  assert.deepEqual(summary.settled, []); // nothing to settle, tolerated
  assert.equal(s.claimsStore.get(c.ref).state, "interrupted");
  assert.equal(s.runsStore.get("run_x").status, "interrupted");
});
