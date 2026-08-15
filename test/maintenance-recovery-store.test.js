import { test } from "node:test";
import assert from "node:assert/strict";
import { createRecoveryStore } from "../container/maintenance-recovery-store.js";

function memoryLog(records = []) {
  return { records, append: (r) => records.push(JSON.parse(JSON.stringify(r))), readAll: () => records.slice() };
}
const OPAQUE = /^[a-z]+_[A-Za-z0-9_-]{22,86}$/;
const STATES = new Set(["requested", "stopping", "cleaning", "complete", "quarantined"]);
const ACTION_ID = /^[a-z][a-z0-9_-]{0,63}$/;

// Faithful mirror of RecoveryView invariants (contract §4.1).
function validateRecoveryView(v) {
  assert.deepEqual(Object.keys(v).sort(), ["claimRef", "finishedAtMs", "quarantineReason", "ref", "startedAtMs", "state"]);
  assert.match(v.ref, OPAQUE);
  assert.match(v.claimRef, OPAQUE);
  assert.ok(STATES.has(v.state));
  assert.ok(Number.isSafeInteger(v.startedAtMs) && v.startedAtMs > 0);
  assert.ok(v.finishedAtMs === null || (Number.isSafeInteger(v.finishedAtMs) && v.finishedAtMs > 0));
  assert.ok(v.quarantineReason === null || ACTION_ID.test(v.quarantineReason));
}

const make = (log = memoryLog()) => createRecoveryStore({ log, validateRecoveryView });
const CLAIM = "clm_abcdefghijklmnopqrstuvwx";

test("request records a recovery in the requested state with a valid ref", () => {
  const r = make();
  const v = r.request({ claimRef: CLAIM });
  assert.equal(v.state, "requested");
  assert.match(v.ref, OPAQUE);
  assert.equal(v.claimRef, CLAIM);
  assert.equal(v.finishedAtMs, null);
  assert.equal(v.quarantineReason, null);
});

test("only one live recovery per claim at a time", () => {
  const r = make();
  r.request({ claimRef: CLAIM });
  assert.throws(() => r.request({ claimRef: CLAIM }), (e) => e.code === "RECOVERY_IN_PROGRESS");
});

test("the fixed teardown progression requested -> stopping -> cleaning -> complete", () => {
  const r = make();
  let v = r.request({ claimRef: CLAIM });
  v = r.advance(v.ref, "stopping");
  assert.equal(v.state, "stopping");
  v = r.advance(v.ref, "cleaning");
  assert.equal(v.state, "cleaning");
  v = r.advance(v.ref, "complete");
  assert.equal(v.state, "complete");
  assert.ok(v.finishedAtMs > 0);
});

test("an out-of-order advance is rejected", () => {
  const r = make();
  const v = r.request({ claimRef: CLAIM });
  assert.throws(() => r.advance(v.ref, "complete"), (e) => e.code === "INVALID_TRANSITION");
  assert.throws(() => r.advance(v.ref, "cleaning"), (e) => e.code === "INVALID_TRANSITION");
});

test("quarantine with a fixed reason is reachable from any live step and is terminal", () => {
  const r = make();
  let v = r.request({ claimRef: CLAIM });
  v = r.advance(v.ref, "stopping");
  v = r.quarantine(v.ref, "reap_unproven");
  assert.equal(v.state, "quarantined");
  assert.equal(v.quarantineReason, "reap_unproven");
  assert.ok(v.finishedAtMs > 0);
  assert.throws(() => r.advance(v.ref, "cleaning"), (e) => e.code === "INVALID_TRANSITION");
});

test("quarantine rejects a reason outside the fixed set", () => {
  const r = make();
  const v = r.request({ claimRef: CLAIM });
  assert.throws(() => r.quarantine(v.ref, "because"), (e) => e.code === "INVALID_REQUEST");
});

test("advance cannot be used to quarantine", () => {
  const r = make();
  const v = r.request({ claimRef: CLAIM });
  assert.throws(() => r.advance(v.ref, "quarantined"), (e) => e.code === "INVALID_REQUEST");
});

test("after a terminal recovery, a fresh recovery may be requested for the same claim", () => {
  const r = make();
  let v = r.request({ claimRef: CLAIM });
  v = r.advance(v.ref, "stopping");
  v = r.quarantine(v.ref, "descendant_alive");
  const again = r.request({ claimRef: CLAIM });
  assert.equal(again.state, "requested");
  assert.notEqual(again.ref, v.ref);
});

test("state survives a restart via durable replay", () => {
  const log = memoryLog();
  const r1 = make(log);
  let v = r1.request({ claimRef: CLAIM });
  v = r1.advance(v.ref, "stopping");
  const r2 = make(log);
  const reloaded = r2.get(v.ref);
  assert.equal(reloaded.state, "stopping");
  const done = r2.advance(v.ref, "cleaning");
  assert.equal(done.state, "cleaning");
});
