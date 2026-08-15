// Phase 1f Step 4a (piece 2): the live worker-view registry. Every emitted view
// is checked against the REAL protocol WorkerView contract by round-tripping it
// through protocol.validateResponse("work.cancel", ...) — the one method whose
// success data is a bare {worker} — so the registry cannot drift from the
// contract the IPC edge enforces.

import { test } from "node:test";
import assert from "node:assert/strict";
import protocol from "../container/maintenance-protocol.js";
import registryMod from "../container/maintenance-worker-registry.js";

const { createWorkerRegistry } = registryMod;

const EPOCH = "gw_" + "a".repeat(32);
const REQ = "req_" + "b".repeat(32);
const WREF = "wrk_" + "a".repeat(24);
const WREF2 = "wrk_" + "d".repeat(24);
const CREF = "clm_" + "c".repeat(24);

// Authoritatively validate a WorkerView through the real protocol edge.
function assertValidWorkerView(worker, expectedWorkerVersion) {
  const response = {
    v: 1, gatewayEpoch: EPOCH, requestId: REQ, ok: true, status: "success", code: "OK",
    summary: "ok.", rootCause: null, retry: { safe: false, afterMs: null }, stopCondition: null,
    nextActions: [], artifacts: [], data: { worker }, serverTimeMs: 1,
  };
  return protocol.validateResponse("work.cancel", response, {
    requestId: REQ, gatewayEpoch: EPOCH, expectedWorkerRef: worker.ref, expectedWorkerVersion,
  });
}

test("observe records a running WorkerView (v1) and marks the lane live", () => {
  const reg = createWorkerRegistry({ now: () => 1000 });
  const w = reg.observe({ workerRef: WREF, claimRef: CREF });
  assert.equal(w.ref, WREF);
  assert.equal(w.claimRef, CREF);
  assert.equal(w.state, "running");
  assert.equal(w.version, 1);
  assert.equal(w.finishedAtMs, null);
  assert.equal(w.outputEof, false);
  assert.equal(w.startedAtMs, 1000);
  assert.deepEqual(reg.live(), w);
  assert.deepEqual(reg.get(WREF), w);
});

test("one lane: a second observe while a worker is live is LANE_BUSY", () => {
  const reg = createWorkerRegistry({ now: () => 1 });
  reg.observe({ workerRef: WREF, claimRef: CREF });
  assert.throws(() => reg.observe({ workerRef: WREF2, claimRef: CREF }), (e) => e.code === "LANE_BUSY");
});

test("beginCancel drives running -> stopping with a newer version (a valid work.cancel view)", () => {
  const reg = createWorkerRegistry({ now: () => 1 });
  reg.observe({ workerRef: WREF, claimRef: CREF });
  const stopping = reg.beginCancel({ workerRef: WREF, expectedWorkerVersion: 1, reasonCode: "operator_cancel" });
  assert.equal(stopping.state, "stopping");
  assert.equal(stopping.version, 2);
  assert.equal(stopping.finishedAtMs, null);
  const validated = assertValidWorkerView(stopping, 1);
  assert.equal(validated.data.worker.state, "stopping");
});

test("beginCancel fails closed on a stale version, a non-operator reason, and a dead ref", () => {
  const reg = createWorkerRegistry({ now: () => 1 });
  reg.observe({ workerRef: WREF, claimRef: CREF });
  assert.throws(() => reg.beginCancel({ workerRef: WREF, expectedWorkerVersion: 99, reasonCode: "operator_cancel" }), (e) => e.code === "STALE_VERSION");
  assert.throws(() => reg.beginCancel({ workerRef: WREF, expectedWorkerVersion: 1, reasonCode: "timeout" }), (e) => e.code === "INVALID_REQUEST");
  assert.throws(() => reg.beginCancel({ workerRef: WREF2, expectedWorkerVersion: 1, reasonCode: "operator_cancel" }), (e) => e.code === "STALE_HANDLE");
});

test("complete records a terminal WorkerView (finishedAtMs + eof) and frees the lane", () => {
  const reg = createWorkerRegistry({ now: () => 5000 });
  reg.observe({ workerRef: WREF, claimRef: CREF });
  const done = reg.complete({ workerRef: WREF, outcome: "completed", exitCode: 0 });
  assert.equal(done.state, "completed");
  assert.equal(done.version, 2);
  assert.equal(done.finishedAtMs, 5000);
  assert.equal(done.outputEof, true);
  assert.equal(done.exitCode, 0);
  assert.equal(reg.live(), null, "lane freed");
  // completed is a valid work.cancel terminal view; still resolvable via get()
  assertValidWorkerView(done, 1);
  assert.deepEqual(reg.get(WREF), done);
});

test("cancel then complete: stopping -> cancelled, versions strictly increasing", () => {
  const reg = createWorkerRegistry({ now: () => 1 });
  reg.observe({ workerRef: WREF, claimRef: CREF });
  reg.beginCancel({ workerRef: WREF, expectedWorkerVersion: 1, reasonCode: "operator_cancel" });
  const cancelled = reg.complete({ workerRef: WREF, outcome: "cancelled", signalName: "SIGKILL" });
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.version, 3);
  assert.equal(cancelled.signalName, "SIGKILL");
  assertValidWorkerView(cancelled, 2);
});

test("complete fails closed on a bad outcome and on both exitCode+signalName", () => {
  const reg = createWorkerRegistry({ now: () => 1 });
  reg.observe({ workerRef: WREF, claimRef: CREF });
  assert.throws(() => reg.complete({ workerRef: WREF, outcome: "exploded" }), (e) => e.code === "INVALID_REQUEST");
  assert.throws(() => reg.complete({ workerRef: WREF, outcome: "failed", exitCode: 1, signalName: "SIGTERM" }), (e) => e.code === "INVALID_REQUEST");
});

test("the lane reopens after completion: a fresh worker may be observed", () => {
  const reg = createWorkerRegistry({ now: () => 1 });
  reg.observe({ workerRef: WREF, claimRef: CREF });
  reg.complete({ workerRef: WREF, outcome: "completed", exitCode: 0 });
  const w2 = reg.observe({ workerRef: WREF2, claimRef: CREF });
  assert.equal(w2.state, "running");
  assert.equal(reg.live().ref, WREF2);
});
