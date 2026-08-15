import { test } from "node:test";
import assert from "node:assert/strict";
import { createRunsStore } from "../container/maintenance-runs-store.js";

function memoryLog(records = []) {
  return { records, append: (r) => records.push(JSON.parse(JSON.stringify(r))), readAll: () => records.slice() };
}
const RUN_STATUSES = new Set(["queued", "running", "waiting", "gated", "completed", "failed", "cancelled", "interrupted", "skipped"]);

// Faithful mirror of RunView invariants (contract §4.1).
function validateRunView(v) {
  const keys = ["artifacts", "authority", "chainId", "createdAtMs", "engines", "finishedAtMs", "id", "kind", "nextActions", "profileId", "repoId", "startedAtMs", "status", "summary", "taskId", "updatedAtMs", "version", "workMode"];
  assert.deepEqual(Object.keys(v).sort(), keys);
  assert.ok(RUN_STATUSES.has(v.status));
  assert.ok(v.authority === "gate" || v.authority === "worker");
  if (v.kind === "system") {
    assert.equal(v.authority, "gate");
    for (const k of ["taskId", "chainId", "profileId", "repoId", "workMode"]) assert.equal(v[k], null);
  } else {
    for (const k of ["taskId", "chainId", "profileId", "repoId", "workMode"]) assert.notEqual(v[k], null);
  }
  assert.ok(Number.isSafeInteger(v.version) && v.version >= 1);
  assert.ok(Number.isSafeInteger(v.createdAtMs) && v.createdAtMs > 0);
}

const make = (log = memoryLog()) => createRunsStore({ log, validateRunView });
const workerRun = { id: "run_1", kind: "board_task", taskId: "task_1", chainId: "chain_1", profileId: "profile_x", repoId: "repo_y", workMode: "new", engines: ["claude"], summary: "" };
const systemRun = { id: "run_sys", kind: "system", taskId: null, chainId: null, profileId: null, repoId: null, workMode: null, engines: [], summary: "boot" };

test("accept creates a queued worker-authority run with non-null bindings", () => {
  const r = make();
  const v = r.accept(workerRun);
  assert.equal(v.status, "queued");
  assert.equal(v.authority, "worker");
  assert.equal(v.taskId, "task_1");
  assert.equal(v.version, 1);
});

test("accept derives gate authority and null bindings for a system run", () => {
  const r = make();
  const v = r.accept(systemRun);
  assert.equal(v.authority, "gate");
  assert.equal(v.taskId, null);
});

test("duplicate accept is idempotent for an identical binding and conflicts otherwise", () => {
  const r = make();
  r.accept(workerRun);
  assert.equal(r.accept(workerRun).id, "run_1");
  assert.throws(() => r.accept({ ...workerRun, engines: ["codex"] }), (e) => e.code === "RUN_CONFLICT");
});

test("the gate may park and restore a pre-launch worker run but not write running", () => {
  const r = make();
  let v = r.accept(workerRun);
  v = r.gateTransition("run_1", { expectedVersion: 1, to: "waiting" });
  assert.equal(v.status, "waiting");
  v = r.gateTransition("run_1", { expectedVersion: 2, to: "queued" });
  assert.equal(v.status, "queued");
  assert.throws(() => r.gateTransition("run_1", { expectedVersion: 3, to: "running" }), (e) => e.code === "INVALID_TRANSITION");
  assert.throws(() => r.gateTransition("run_1", { expectedVersion: 3, to: "completed" }), (e) => e.code === "INVALID_TRANSITION");
});

test("the gate may mark a never-launched worker run cancelled/skipped", () => {
  const r = make();
  r.accept(workerRun);
  const v = r.gateTransition("run_1", { expectedVersion: 1, to: "cancelled" });
  assert.equal(v.status, "cancelled");
});

test("PID 1 records worker running and terminal; the gate cannot touch it after launch", () => {
  const r = make();
  r.accept(workerRun);
  let v = r.serviceTransition("run_1", { expectedVersion: 1, to: "running" });
  assert.equal(v.status, "running");
  assert.ok(v.startedAtMs > 0);
  // gate cannot transition a launched worker run
  assert.throws(() => r.gateTransition("run_1", { expectedVersion: 2, to: "waiting" }), (e) => e.code === "INVALID_TRANSITION");
  v = r.serviceTransition("run_1", { expectedVersion: 2, to: "completed" });
  assert.equal(v.status, "completed");
  assert.ok(v.finishedAtMs > 0);
});

test("service transitions do not apply to gate-authority runs", () => {
  const r = make();
  r.accept(systemRun);
  assert.throws(() => r.serviceTransition("run_sys", { expectedVersion: 1, to: "running" }), (e) => e.code === "INVALID_TRANSITION");
});

test("gate-authority runs follow the compiled matrix; terminal repeats only its state", () => {
  const r = make();
  r.accept(systemRun);
  let v = r.gateTransition("run_sys", { expectedVersion: 1, to: "running" });
  v = r.gateTransition("run_sys", { expectedVersion: 2, to: "completed" });
  assert.equal(v.status, "completed");
  // terminal repeat allowed
  v = r.gateTransition("run_sys", { expectedVersion: 3, to: "completed" });
  assert.equal(v.status, "completed");
  // illegal out-of-terminal rejected
  assert.throws(() => r.gateTransition("run_sys", { expectedVersion: 4, to: "running" }), (e) => e.code === "INVALID_TRANSITION");
});

test("an illegal gate matrix move is rejected", () => {
  const r = make();
  r.accept(systemRun);
  r.gateTransition("run_sys", { expectedVersion: 1, to: "running" });
  // running -> queued is not in the matrix
  assert.throws(() => r.gateTransition("run_sys", { expectedVersion: 2, to: "queued" }), (e) => e.code === "INVALID_TRANSITION");
});

test("a stale expected version is rejected", () => {
  const r = make();
  r.accept(workerRun);
  assert.throws(() => r.gateTransition("run_1", { expectedVersion: 99, to: "waiting" }), (e) => e.code === "STALE_VERSION");
});

test("state survives a restart via durable replay", () => {
  const log = memoryLog();
  const r1 = make(log);
  r1.accept(workerRun);
  r1.serviceTransition("run_1", { expectedVersion: 1, to: "running" });
  const r2 = make(log);
  const v = r2.get("run_1");
  assert.equal(v.status, "running");
  assert.equal(v.version, 2);
  const done = r2.serviceTransition("run_1", { expectedVersion: 2, to: "interrupted" });
  assert.equal(done.status, "interrupted");
});
