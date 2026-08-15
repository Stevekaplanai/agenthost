import { test } from "node:test";
import assert from "node:assert/strict";
import { createAuditStore } from "../container/maintenance-audit-store.js";

function memoryLog(records = []) {
  return { records, append: (r) => records.push(JSON.parse(JSON.stringify(r))), readAll: () => records.slice() };
}
const make = (log = memoryLog()) => createAuditStore({ log });
const DIGEST = "sha256:" + "a".repeat(64);

test("a caller (gate) event with an allowed severity and exact detail is accepted as source=gate", () => {
  const a = make();
  const v = a.appendCaller({ eventCode: "ui_action", severity: "info", detail: { action: "run_inspected" } });
  assert.equal(v.source, "gate");
  assert.equal(v.seq, 1);
  assert.equal(v.eventCode, "ui_action");
});

test("the gate cannot write a service-only event code", () => {
  const a = make();
  for (const code of ["child_observed", "budget_settled", "stop_changed", "gateway_lost"]) {
    assert.throws(() => a.appendCaller({ eventCode: code, severity: "info", detail: {} }), (e) => e.code === "EVENT_CODE_RESERVED", `${code} should be reserved`);
  }
});

test("a caller event with a disallowed severity is rejected", () => {
  const a = make();
  assert.throws(() => a.appendCaller({ eventCode: "ui_action", severity: "error", detail: { action: "view_opened" } }), (e) => e.code === "INVALID_REQUEST");
});

test("a caller event with a wrong detail shape or enum value is rejected", () => {
  const a = make();
  assert.throws(() => a.appendCaller({ eventCode: "client_disconnected", severity: "info", detail: { surface: "carrier_pigeon" } }), (e) => e.code === "INVALID_REQUEST");
  assert.throws(() => a.appendCaller({ eventCode: "client_disconnected", severity: "info", detail: { surface: "chat", extra: 1 } }), (e) => e.code === "INVALID_REQUEST");
  assert.throws(() => a.appendCaller({ eventCode: "operator_action_requested", severity: "info", detail: { action: "x", targetDigest: "not-a-digest" } }), (e) => e.code === "INVALID_REQUEST");
});

test("a service event records source=service with its fixed severity", () => {
  const a = make();
  const v = a.appendService({ eventCode: "gateway_lost", detail: { reasonCode: "heartbeat_timeout" } });
  assert.equal(v.source, "service");
  assert.equal(v.severity, "warning");
  const q = a.appendService({ eventCode: "recovery_quarantined", detail: { claimRef: "clm_x", recoveryRef: "rec_y", reasonCode: "reap_unproven" } });
  assert.equal(q.severity, "error");
});

test("a service event with a wrong detail shape is rejected", () => {
  const a = make();
  assert.throws(() => a.appendService({ eventCode: "worker_signal_sent", detail: { workerRef: "wrk_x", signalCode: "hup" } }), (e) => e.code === "INVALID_REQUEST");
  assert.throws(() => a.appendService({ eventCode: "budget_settled", detail: { chainId: "c", workerRef: "w", tokenUnits: -1, costMicros: 0, mode: "observed" } }), (e) => e.code === "INVALID_REQUEST");
});

test("sequence numbers are strictly increasing across sources", () => {
  const a = make();
  const s1 = a.appendCaller({ eventCode: "ui_action", severity: "info", detail: { action: "view_opened" } });
  const s2 = a.appendService({ eventCode: "gateway_connected", detail: { epochDigest: DIGEST } });
  const s3 = a.appendCaller({ eventCode: "scheduler_denied", severity: "warning", detail: { reasonCode: "lane_busy" } });
  assert.deepEqual([s1.seq, s2.seq, s3.seq], [1, 2, 3]);
});

test("read returns a filtered forward page with a cursor", () => {
  const a = make();
  a.appendCaller({ eventCode: "ui_action", severity: "info", detail: { action: "view_opened" } });
  a.appendService({ eventCode: "gateway_connected", detail: { epochDigest: DIGEST } });
  a.appendService({ eventCode: "gateway_lost", detail: { reasonCode: "eof" } });
  const onlyService = a.read({ afterSeq: 0, source: "service" });
  assert.equal(onlyService.events.length, 2);
  assert.ok(onlyService.events.every((e) => e.source === "service"));
  const afterFirst = a.read({ afterSeq: 1, limit: 1 });
  assert.equal(afterFirst.events.length, 1);
  assert.equal(afterFirst.events[0].seq, 2);
  assert.equal(afterFirst.hasMore, true);
});

test("read enforces the 1..200 limit", () => {
  const a = make();
  assert.throws(() => a.read({ limit: 0 }), (e) => e.code === "INVALID_REQUEST");
  assert.throws(() => a.read({ limit: 201 }), (e) => e.code === "INVALID_REQUEST");
});

test("events survive a restart via durable replay with a continuous sequence", () => {
  const log = memoryLog();
  const a1 = make(log);
  a1.appendCaller({ eventCode: "ui_action", severity: "info", detail: { action: "history_paged" } });
  a1.appendService({ eventCode: "migration_step", detail: { step: "secure_dirs" } });
  const a2 = make(log);
  const page = a2.read({ afterSeq: 0 });
  assert.equal(page.events.length, 2);
  const next = a2.appendService({ eventCode: "stop_changed", detail: { engaged: true, version: 2, reasonCode: "operator_stop" } });
  assert.equal(next.seq, 3);
});

test("a gapped audit log is unavailable, not silently accepted", () => {
  const log = memoryLog([
    { type: "audit", seq: 1, atMs: 1784690000000, eventCode: "ui_action", source: "gate", severity: "info", runId: null, taskId: null, engine: null, detail: { action: "view_opened" } },
    { type: "audit", seq: 3, atMs: 1784690001000, eventCode: "ui_action", source: "gate", severity: "info", runId: null, taskId: null, engine: null, detail: { action: "view_opened" } },
  ]);
  assert.throws(() => make(log), (e) => e.code === "STORE_UNAVAILABLE");
});
