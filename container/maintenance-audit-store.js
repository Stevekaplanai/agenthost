"use strict";

// Dormant Foundation-B candidate: the root-owned durable audit store (BUILD-PLAN
// Phase 1c; IPC contract §4.1 AuditView, §4.2 caller-audit details, §4.3
// service-audit details, §6 audit.append/audit.read). Two append surfaces keep
// the flight recorder honest:
//   - appendCaller(): source=gate. Only the six caller event codes with their
//     exact severity + detail (§4.2); a service-only code is rejected
//     EVENT_CODE_RESERVED — the gate can never forge a service-authored fact.
//   - appendService(): source=service, PID 1 alone. The seventeen service codes
//     with their FIXED severity + exact detail (§4.3).
// Reads are a byte-bounded forward page filtered by source/severity/run/task.
//
// Semantics over an injected append-only log adapter; substrate deferred.
// DORMANT: not wired into any boot path; activation gated at Phase 1f.

const ACTION_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const SHA_RE = /^sha256:[0-9a-f]{64}$/;

class AuditStoreError extends Error {
  constructor(code, message) { super(message); this.name = "AuditStoreError"; this.code = code; }
}
function fail(code, message) { throw new AuditStoreError(code, message); }

const isPlainObject = (v) => v && typeof v === "object" && !Array.isArray(v);
function exactKeys(detail, keys) {
  if (!isPlainObject(detail)) return false;
  const actual = Object.keys(detail).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((k, i) => k === expected[i]);
}
const inSet = (v, set) => typeof v === "string" && set.has(v);

// §4.2 caller-audit event codes: allowed severities + exact detail validator.
const CALLER_EVENTS = {
  client_disconnected: { sev: new Set(["info"]), detail: (d) => exactKeys(d, ["surface"]) && inSet(d.surface, new Set(["chat", "team_chat", "board", "terminal"])) },
  operator_action_requested: { sev: new Set(["info"]), detail: (d) => exactKeys(d, ["action", "targetDigest"]) && ACTION_ID_RE.test(d.action || "") && SHA_RE.test(d.targetDigest || "") },
  gateway_degraded: { sev: new Set(["warning", "error"]), detail: (d) => exactKeys(d, ["reasonCode"]) && inSet(d.reasonCode, new Set(["service_timeout", "service_unavailable", "response_invalid", "contract_mismatch"])) },
  scheduler_denied: { sev: new Set(["info", "warning"]), detail: (d) => exactKeys(d, ["reasonCode"]) && inSet(d.reasonCode, new Set(["stopped", "lane_busy", "claim_conflict", "budget_exhausted", "profile_unavailable", "run_not_accepted", "repository_unavailable"])) },
  scheduler_parked: { sev: new Set(["info", "warning"]), detail: (d) => exactKeys(d, ["reasonCode"]) && inSet(d.reasonCode, new Set(["awaiting_review", "correction_required", "human_gate", "global_quarantine"])) },
  ui_action: { sev: new Set(["info"]), detail: (d) => exactKeys(d, ["action"]) && inSet(d.action, new Set(["view_opened", "run_inspected", "history_paged", "stop_status_viewed"])) },
};

// §4.3 service-audit event codes: FIXED severity + exact detail validator.
const nnint = (v) => Number.isSafeInteger(v) && v >= 0;
const store6 = new Set(["claims", "runs", "stop", "budgets", "audit", "idempotency"]);
const SERVICE_EVENTS = {
  unexpected_peer: { sev: "warning", detail: (d) => exactKeys(d, ["reasonCode"]) && inSet(d.reasonCode, new Set(["wrong_uid", "wrong_gid", "wrong_pid", "second_connection"])) },
  gateway_connected: { sev: "info", detail: (d) => exactKeys(d, ["epochDigest"]) && SHA_RE.test(d.epochDigest || "") },
  gateway_lost: { sev: "warning", detail: (d) => exactKeys(d, ["reasonCode"]) && inSet(d.reasonCode, new Set(["eof", "protocol", "heartbeat_timeout", "process_exit", "drain"])) },
  launch_authorized: { sev: "info", detail: (d) => exactKeys(d, ["claimRef", "workerRef", "profileId"]) },
  spawn_attempted: { sev: "info", detail: (d) => exactKeys(d, ["claimRef", "workerRef"]) },
  child_observed: { sev: "info", detail: (d) => exactKeys(d, ["claimRef", "workerRef"]) },
  worker_signal_sent: { sev: "warning", detail: (d) => exactKeys(d, ["workerRef", "signalCode"]) && inSet(d.signalCode, new Set(["term", "kill"])) },
  worker_reaped: { sev: "info", detail: (d) => exactKeys(d, ["workerRef", "exitCode", "signalName"]) },
  containment_revoked: { sev: "info", detail: (d) => exactKeys(d, ["workerRef"]) },
  recovery_completed: { sev: "warning", detail: (d) => exactKeys(d, ["claimRef", "recoveryRef"]) },
  recovery_quarantined: { sev: "error", detail: (d) => exactKeys(d, ["claimRef", "recoveryRef", "reasonCode"]) && inSet(d.reasonCode, new Set(["child_unknown", "descendant_alive", "reap_unproven", "mount_present", "store_unavailable"])) },
  budget_reserved: { sev: "info", detail: (d) => exactKeys(d, ["chainId", "workerRef", "tokenUnits", "costMicros"]) && nnint(d.tokenUnits) && nnint(d.costMicros) },
  budget_settled: { sev: "info", detail: (d) => exactKeys(d, ["chainId", "workerRef", "tokenUnits", "costMicros", "mode"]) && nnint(d.tokenUnits) && nnint(d.costMicros) && inSet(d.mode, new Set(["observed", "full_charge", "proven_no_spawn_refund"])) },
  stop_changed: { sev: "warning", detail: (d) => exactKeys(d, ["engaged", "version", "reasonCode"]) && typeof d.engaged === "boolean" && nnint(d.version) },
  migration_step: { sev: "info", detail: (d) => exactKeys(d, ["step"]) && typeof d.step === "string" },
  store_degraded: { sev: "error", detail: (d) => exactKeys(d, ["store", "reasonCode"]) && inSet(d.store, store6) && inSet(d.reasonCode, new Set(["open_failed", "owner_mismatch", "mode_mismatch", "wrong_type", "symlink", "corrupt", "disk_full", "sync_failed"])) },
  record_quarantined: { sev: "warning", detail: (d) => exactKeys(d, ["store", "reasonCode"]) && inSet(d.store, store6) && inSet(d.reasonCode, new Set(["schema_invalid", "torn_write", "redaction_failed"])) },
};

function createAuditStore({ log, now = Date.now } = {}) {
  if (!log || typeof log.append !== "function" || typeof log.readAll !== "function") {
    throw new Error("audit store requires an append-only log adapter { append, readAll }");
  }
  const events = [];
  let seq = 0;

  function nowMs() {
    const v = Number(now());
    if (!Number.isSafeInteger(v) || v <= 0) fail("STORE_UNAVAILABLE", "audit clock is invalid");
    return v;
  }
  function replay() {
    let records;
    try { records = log.readAll(); } catch { fail("STORE_UNAVAILABLE", "audit log is unreadable"); }
    for (const r of records || []) {
      if (!r || r.type !== "audit") continue;
      if (r.seq !== seq + 1) fail("STORE_UNAVAILABLE", "audit sequence has a gap");
      seq = r.seq;
      events.push(r);
    }
  }
  replay();

  function commit(entry) {
    const record = { type: "audit", seq: seq + 1, atMs: nowMs(), ...entry };
    try { log.append(record); } catch { fail("STORE_UNAVAILABLE", "audit event could not be persisted"); }
    seq = record.seq;
    events.push(record);
    const view = { ...record };
    delete view.type;
    return Object.freeze(view);
  }

  function normalizeRefs({ runId = null, taskId = null, engine = null }) {
    for (const [k, v] of Object.entries({ runId, taskId, engine })) {
      if (v !== null && typeof v !== "string") fail("INVALID_REQUEST", `${k} must be a string or null`);
    }
    return { runId, taskId, engine };
  }

  // source=gate. Rejects service-only codes and enforces the §4.2 severity+detail.
  function appendCaller({ eventCode, severity, runId = null, taskId = null, engine = null, detail } = {}) {
    if (SERVICE_EVENTS[eventCode]) fail("EVENT_CODE_RESERVED", "service-only event code cannot be written by the gate");
    const spec = CALLER_EVENTS[eventCode];
    if (!spec) fail("INVALID_REQUEST", "unknown caller event code");
    if (!spec.sev.has(severity)) fail("INVALID_REQUEST", "severity is not allowed for this event code");
    if (!spec.detail(detail)) fail("INVALID_REQUEST", "detail does not match the event code schema");
    const refs = normalizeRefs({ runId, taskId, engine });
    return commit({ eventCode, source: "gate", severity, ...refs, detail });
  }

  // source=service, PID 1 only. Enforces the §4.3 fixed severity + exact detail.
  function appendService({ eventCode, runId = null, taskId = null, engine = null, detail } = {}) {
    const spec = SERVICE_EVENTS[eventCode];
    if (!spec) fail("INVALID_REQUEST", "unknown service event code");
    if (!spec.detail(detail)) fail("INVALID_REQUEST", "detail does not match the service event code schema");
    const refs = normalizeRefs({ runId, taskId, engine });
    return commit({ eventCode, source: "service", severity: spec.sev, ...refs, detail });
  }

  // Byte-bounded forward page after `afterSeq`, filtered.
  function read({ afterSeq = 0, limit = 200, source = null, severity = null, runId = null, taskId = null } = {}) {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) fail("INVALID_REQUEST", "afterSeq is invalid");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) fail("INVALID_REQUEST", "limit must be 1..200");
    const out = [];
    for (const r of events) {
      if (r.seq <= afterSeq) continue;
      if (source && r.source !== source) continue;
      if (severity && r.severity !== severity) continue;
      if (runId && r.runId !== runId) continue;
      if (taskId && r.taskId !== taskId) continue;
      const view = { ...r }; delete view.type;
      out.push(Object.freeze(view));
      if (out.length >= limit) break;
    }
    const nextCursor = out.length ? out[out.length - 1].seq : afterSeq;
    return { events: out, nextCursor, hasMore: events.some((r) => r.seq > nextCursor) };
  }

  return Object.freeze({ appendCaller, appendService, read, CALLER_EVENTS: Object.keys(CALLER_EVENTS), SERVICE_EVENTS: Object.keys(SERVICE_EVENTS) });
}

module.exports = { createAuditStore, AuditStoreError };
