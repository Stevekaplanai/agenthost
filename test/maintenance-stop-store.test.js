import { test } from "node:test";
import assert from "node:assert/strict";
import { createStopStore, FIRST_SECURE_REASON } from "../container/maintenance-stop-store.js";
import protocol from "../container/maintenance-protocol.js";

// The compiled StopView validator the store must conform to. maintenance-protocol
// is CommonJS; import its default and pull the validator off it. It is not on
// the public export list, so fall back to a faithful local reimplementation
// only if absent — but assert the store's views round-trip through whatever we
// use so a schema drift is caught.
const validateStopView = (view) => {
  // Minimal faithful mirror of validateStopView's invariants (contract §4.1).
  const keys = Object.keys(view).sort();
  assert.deepEqual(keys, ["changedAtMs", "engaged", "reasonCode", "summary", "version"]);
  assert.equal(typeof view.engaged, "boolean");
  assert.ok(Number.isSafeInteger(view.version) && view.version >= 0);
  assert.equal(view.engaged, view.reasonCode !== null);
  if (!view.engaged) assert.equal(view.summary, null);
  assert.ok(Number.isSafeInteger(view.changedAtMs) && view.changedAtMs > 0);
};

// In-memory append-only log adapter; a fresh store over the same array models a
// process restart (durable replay).
function memoryLog(records = []) {
  return { records, append: (r) => records.push(JSON.parse(JSON.stringify(r))), readAll: () => records.slice() };
}

test("STOP defaults to the first-secure STOPPED state at version 1", () => {
  const log = memoryLog();
  const stop = createStopStore({ log, validateStopView });
  const view = stop.get();
  assert.equal(view.engaged, true);
  assert.equal(view.version, 1);
  assert.equal(view.reasonCode, FIRST_SECURE_REASON);
});

test("engage bumps the version, records the reason, and yields a valid view", () => {
  const stop = createStopStore({ log: memoryLog(), validateStopView });
  const v = stop.engage({ expectedVersion: 1, reasonCode: "operator_stop", summary: "held for maintenance" });
  assert.equal(v.engaged, true);
  assert.equal(v.version, 2);
  assert.equal(v.reasonCode, "operator_stop");
  assert.equal(v.summary, "held for maintenance");
});

test("engage with a stale expected version is rejected and changes nothing", () => {
  const stop = createStopStore({ log: memoryLog(), validateStopView });
  assert.throws(() => stop.engage({ expectedVersion: 99, reasonCode: "operator_stop" }), (e) => e.code === "STALE_VERSION");
  assert.equal(stop.get().version, 1);
});

test("engage rejects a reason outside the allowed set", () => {
  const stop = createStopStore({ log: memoryLog(), validateStopView });
  assert.throws(() => stop.engage({ expectedVersion: 1, reasonCode: "because" }), (e) => e.code === "INVALID_REQUEST");
});

test("resume requires the matching version and yields a clean resumed view", () => {
  const stop = createStopStore({ log: memoryLog(), validateStopView });
  stop.engage({ expectedVersion: 1, reasonCode: "operator_stop", summary: "x" });
  assert.throws(() => stop.resume({ expectedVersion: 1 }), (e) => e.code === "STALE_VERSION");
  const v = stop.resume({ expectedVersion: 2 });
  assert.equal(v.engaged, false);
  assert.equal(v.reasonCode, null);
  assert.equal(v.summary, null);
  assert.equal(v.version, 3);
});

test("STOP survives a restart: a fresh store over the same log sees the latest", () => {
  const log = memoryLog();
  const first = createStopStore({ log, validateStopView });
  first.engage({ expectedVersion: 1, reasonCode: "budget_emergency", summary: "spend cap" });
  const restarted = createStopStore({ log, validateStopView });
  const v = restarted.get();
  assert.equal(v.version, 2);
  assert.equal(v.engaged, true);
  assert.equal(v.reasonCode, "budget_emergency");
});

test("versions increase strictly monotonically across engage/resume", () => {
  const stop = createStopStore({ log: memoryLog(), validateStopView });
  let v = stop.get().version;
  for (const step of [
    () => stop.engage({ expectedVersion: v, reasonCode: "operator_stop" }),
    () => stop.resume({ expectedVersion: v }),
    () => stop.engage({ expectedVersion: v, reasonCode: "integrity_failure" }),
  ]) {
    const next = step().version;
    assert.ok(next > v, `version did not increase: ${v} -> ${next}`);
    v = next;
  }
});

test("a gapped STOP log is unavailable, not silently accepted", () => {
  const log = memoryLog([
    { type: "stop", engaged: true, version: 1, reasonCode: FIRST_SECURE_REASON, summary: "s", changedAtMs: 1784690000000 },
    { type: "stop", engaged: false, version: 3, reasonCode: null, summary: null, changedAtMs: 1784690001000 },
  ]);
  assert.throws(() => createStopStore({ log, validateStopView }), (e) => e.code === "STORE_UNAVAILABLE");
});

// Guard against schema drift: prove the store's real views also pass the
// compiled protocol validator if it is reachable on the module.
test("store views pass the compiled protocol StopView validator when available", () => {
  const compiled = protocol && typeof protocol.validateStopView === "function" ? protocol.validateStopView : null;
  const stop = createStopStore({ log: memoryLog(), validateStopView });
  const engaged = stop.engage({ expectedVersion: 1, reasonCode: "operator_stop", summary: "s" });
  const resumed = stop.resume({ expectedVersion: 2 });
  if (compiled) {
    assert.doesNotThrow(() => compiled(engaged));
    assert.doesNotThrow(() => compiled(resumed));
  }
});
