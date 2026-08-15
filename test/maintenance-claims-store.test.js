import { test } from "node:test";
import assert from "node:assert/strict";
import { createClaimsStore } from "../container/maintenance-claims-store.js";

function memoryLog(records = []) {
  return { records, append: (r) => records.push(JSON.parse(JSON.stringify(r))), readAll: () => records.slice() };
}

const OPAQUE = /^[a-z]+_[A-Za-z0-9_-]{22,86}$/;
const ENGINES = new Set(["claude", "codex", "gemini", "hermes"]);
const STATES = new Set(["active", "awaiting_review", "reviewing", "correction_required", "completed", "failed", "cancelled", "interrupted", "released", "quarantined"]);

// Faithful mirror of validateClaimView invariants (contract §4.1).
function validateClaimView(v) {
  assert.deepEqual(Object.keys(v).sort(), ["authorEngine", "chainId", "recoveryRef", "ref", "runId", "state", "taskId", "updatedAtMs", "version", "workerRef"]);
  assert.match(v.ref, OPAQUE);
  assert.ok(ENGINES.has(v.authorEngine));
  assert.ok(STATES.has(v.state));
  assert.ok(Number.isSafeInteger(v.version) && v.version >= 1);
  for (const k of ["workerRef", "recoveryRef"]) assert.ok(v[k] === null || OPAQUE.test(v[k]));
  if (v.state === "released") { assert.equal(v.workerRef, null); assert.equal(v.recoveryRef, null); }
  assert.ok(Number.isSafeInteger(v.updatedAtMs) && v.updatedAtMs > 0);
}

const make = (log = memoryLog()) => createClaimsStore({ log, validateClaimView });
const seed = { taskId: "task_1", runId: "run_1", chainId: "chain_1", authorEngine: "claude" };

test("create yields an active claim at version 1 with a valid ref", () => {
  const c = make();
  const v = c.create(seed);
  assert.equal(v.state, "active");
  assert.equal(v.version, 1);
  assert.match(v.ref, OPAQUE);
  assert.equal(v.workerRef, null);
});

test("the author -> review -> complete -> release happy path", () => {
  const c = make();
  let v = c.create(seed);
  v = c.transition(v.ref, { expectedVersion: 1, to: "awaiting_review" });
  assert.equal(v.state, "awaiting_review");
  v = c.transition(v.ref, { expectedVersion: 2, to: "reviewing" });
  v = c.transition(v.ref, { expectedVersion: 3, to: "completed" });
  v = c.transition(v.ref, { expectedVersion: 4, to: "released", reasonCode: "completed" });
  assert.equal(v.state, "released");
  assert.equal(v.version, 5);
});

test("the correction loop reviewing -> correction_required -> active", () => {
  const c = make();
  let v = c.create(seed);
  v = c.transition(v.ref, { expectedVersion: 1, to: "awaiting_review" });
  v = c.transition(v.ref, { expectedVersion: 2, to: "reviewing" });
  v = c.transition(v.ref, { expectedVersion: 3, to: "correction_required" });
  assert.equal(v.state, "correction_required");
  v = c.transition(v.ref, { expectedVersion: 4, to: "active" });
  assert.equal(v.state, "active");
});

test("an illegal transition is rejected", () => {
  const c = make();
  const v = c.create(seed);
  assert.throws(() => c.transition(v.ref, { expectedVersion: 1, to: "completed" }), (e) => e.code === "INVALID_TRANSITION");
});

test("a stale expected version is rejected", () => {
  const c = make();
  const v = c.create(seed);
  assert.throws(() => c.transition(v.ref, { expectedVersion: 99, to: "awaiting_review" }), (e) => e.code === "STALE_VERSION");
});

test("release requires proven cleanup (no attached worker)", () => {
  const c = make();
  let v = c.create(seed);
  v = c.transition(v.ref, { expectedVersion: 1, to: "awaiting_review" });
  v = c.transition(v.ref, { expectedVersion: 2, to: "reviewing" });
  v = c.attachWorker(v.ref, { expectedVersion: 3, workerRef: "wrk_abcdefghijklmnopqrstuvwx" });
  v = c.transition(v.ref, { expectedVersion: 4, to: "completed" });
  assert.throws(() => c.transition(v.ref, { expectedVersion: 5, to: "released", reasonCode: "completed" }), (e) => e.code === "CLEANUP_UNPROVEN");
  v = c.detachWorker(v.ref, { expectedVersion: 5 });
  v = c.transition(v.ref, { expectedVersion: 6, to: "released", reasonCode: "completed" });
  assert.equal(v.state, "released");
});

test("release reasonCode must equal the current terminal state", () => {
  const c = make();
  let v = c.create(seed);
  v = c.transition(v.ref, { expectedVersion: 1, to: "failed" });
  assert.throws(() => c.transition(v.ref, { expectedVersion: 2, to: "released", reasonCode: "completed" }), (e) => e.code === "INVALID_REQUEST");
  v = c.transition(v.ref, { expectedVersion: 2, to: "released", reasonCode: "failed" });
  assert.equal(v.state, "released");
});

test("quarantined is not releasable and is absorbing", () => {
  const c = make();
  let v = c.create(seed);
  v = c.transition(v.ref, { expectedVersion: 1, to: "quarantined" });
  assert.throws(() => c.transition(v.ref, { expectedVersion: 2, to: "released", reasonCode: "quarantined" }), (e) => e.code === "INVALID_TRANSITION");
  assert.throws(() => c.transition(v.ref, { expectedVersion: 2, to: "active" }), (e) => e.code === "INVALID_TRANSITION");
});

test("released is absorbing", () => {
  const c = make();
  let v = c.create(seed);
  v = c.transition(v.ref, { expectedVersion: 1, to: "cancelled" });
  v = c.transition(v.ref, { expectedVersion: 2, to: "released", reasonCode: "cancelled" });
  assert.throws(() => c.transition(v.ref, { expectedVersion: 3, to: "active" }), (e) => e.code === "INVALID_TRANSITION");
});

test("a worker can only attach in active/reviewing and only once", () => {
  const c = make();
  let v = c.create(seed);
  v = c.attachWorker(v.ref, { expectedVersion: 1, workerRef: "wrk_abcdefghijklmnopqrstuvwx" });
  assert.throws(() => c.attachWorker(v.ref, { expectedVersion: 2, workerRef: "wrk_zyxwvutsrqponmlkjihgfedcb" }), (e) => e.code === "WORKER_ACTIVE");
  v = c.detachWorker(v.ref, { expectedVersion: 2 });
  v = c.transition(v.ref, { expectedVersion: 3, to: "awaiting_review" });
  assert.throws(() => c.attachWorker(v.ref, { expectedVersion: 4, workerRef: "wrk_abcdefghijklmnopqrstuvwx" }), (e) => e.code === "INVALID_TRANSITION");
});

test("state survives a restart via durable replay", () => {
  const log = memoryLog();
  const c1 = make(log);
  let v = c1.create(seed);
  v = c1.transition(v.ref, { expectedVersion: 1, to: "awaiting_review" });
  const c2 = make(log);
  const reloaded = c2.get(v.ref);
  assert.equal(reloaded.state, "awaiting_review");
  assert.equal(reloaded.version, 2);
  // continued transitions work against the reloaded version
  const done = c2.transition(v.ref, { expectedVersion: 2, to: "reviewing" });
  assert.equal(done.state, "reviewing");
});
