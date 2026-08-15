"use strict";

// Dormant Foundation-B candidate: the run-event ledger (BUILD-PLAN Phase 1f,
// Step 4a — piece 5) backing IPC run.events. The runs store holds current
// RunView state; it does not keep the append-only, seq'd event history the
// contract exposes (accepted / gate_* / service_* events, §4.1 RunEventView).
// This ledger is that history: run.accept and gate/service transitions record an
// event here; run.events serves a byte/limit-bounded forward page.
//
// Contract invariants enforced at record time (mirrors validateRunEventView so a
// bad event can never reach the ledger): eventCode<->source<->status agree; a
// single-engine event pins `engine` to its one entry, a multi-engine event nulls
// it; seq is monotonic per ledger generation. read() returns exactly the
// run.events success shape { ledgerGeneration, events, nextCursor, hasMore,
// truncated } with an opaque continuation cursor.
//
// DORMANT: no boot wiring; the durable append is injected at activation.

const GATE_RUN_EVENT_CODES = new Set([
  "accepted", "gate_queued", "gate_running", "gate_waiting", "gate_gated",
  "gate_completed", "gate_failed", "gate_cancelled", "gate_interrupted", "gate_skipped",
]);
const SERVICE_RUN_EVENT_CODES = new Set([
  "service_launch_intent", "service_spawn_attempt", "service_child_observed",
  "service_running", "service_completed", "service_failed",
  "service_cancelled", "service_interrupted", "service_quarantined", "service_retention",
]);
const EVENT_STATUSES = Object.freeze({
  accepted: new Set(["queued"]),
  gate_queued: new Set(["queued"]), gate_running: new Set(["running"]),
  gate_waiting: new Set(["waiting"]), gate_gated: new Set(["gated"]),
  gate_completed: new Set(["completed"]), gate_failed: new Set(["failed"]),
  gate_cancelled: new Set(["cancelled"]), gate_interrupted: new Set(["interrupted"]),
  gate_skipped: new Set(["skipped"]),
  service_launch_intent: new Set(["queued"]), service_spawn_attempt: new Set(["queued"]),
  service_child_observed: new Set(["running"]), service_running: new Set(["running"]),
  service_completed: new Set(["completed"]), service_failed: new Set(["failed"]),
  service_cancelled: new Set(["cancelled"]), service_interrupted: new Set(["interrupted"]),
  service_quarantined: new Set(["quarantined"]), service_retention: new Set(["queued", "running", "waiting", "gated", "completed", "failed", "cancelled", "interrupted", "skipped"]),
});
const STABLE_RE = /^[a-z]+_[A-Za-z0-9_-]{1,86}$/;

class RunEventLedgerError extends Error {
  constructor(code, message) { super(message); this.name = "RunEventLedgerError"; this.code = code; }
}
function fail(code, message) { throw new RunEventLedgerError(code, message); }

// Opaque continuation cursor (>= 22 chars after the prefix, per OPAQUE_RE).
const encodeCursor = (seq) => "cur_" + String(seq).padStart(22, "0");

function createRunEventLedger({ now = Date.now, ledgerGeneration = 0, persist = null } = {}) {
  if (!Number.isSafeInteger(ledgerGeneration) || ledgerGeneration < 0) throw new Error("ledgerGeneration must be a non-negative safe integer");
  const events = [];

  // Record one run event. Fails closed on any contract disagreement so the
  // ledger can only ever hold protocol-valid RunEventViews.
  function record({ runId, eventCode, source, status, kind, engine = null, engines, summary = "", nextActions = [], artifacts = [], runVersion } = {}) {
    if (typeof runId !== "string" || !STABLE_RE.test(runId)) fail("INVALID_REQUEST", "runId must be a stable id");
    const codes = source === "gate" ? GATE_RUN_EVENT_CODES : source === "service" ? SERVICE_RUN_EVENT_CODES : null;
    if (!codes) fail("INVALID_REQUEST", "source must be gate or service");
    if (!codes.has(eventCode)) fail("INVALID_REQUEST", `eventCode ${eventCode} is not a ${source} run event`);
    if (!EVENT_STATUSES[eventCode].has(status)) fail("INVALID_REQUEST", `eventCode ${eventCode} disagrees with status ${status}`);
    if (!Array.isArray(engines) || engines.length === 0 || engines.length > 20) fail("INVALID_REQUEST", "engines must be a 1..20 array");
    if (engines.length === 1) {
      if (engine !== engines[0]) fail("INVALID_REQUEST", "single-engine event must pin engine to its one entry");
    } else if (engine !== null) {
      fail("INVALID_REQUEST", "multi-engine event must null engine");
    }
    if (!Number.isSafeInteger(runVersion) || runVersion < 1) fail("INVALID_REQUEST", "runVersion must be >= 1");
    const event = Object.freeze({
      seq: events.length + 1, runId, eventCode, source, atMs: now(), status,
      kind, engine, engines: Object.freeze([...engines]), summary,
      nextActions: Object.freeze([...nextActions]), artifacts: Object.freeze([...artifacts]), runVersion,
    });
    if (persist) persist(event); // durable before exposed
    events.push(event);
    return event;
  }

  // read({ afterSeq, limit }) -> { ledgerGeneration, events, nextCursor, hasMore, truncated }
  function read({ afterSeq, limit } = {}) {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) fail("INVALID_REQUEST", "afterSeq must be a non-negative safe integer");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) fail("INVALID_REQUEST", "limit must be 1..200");
    const start = afterSeq; // events[i] has seq i+1
    const page = events.slice(start, start + limit);
    const hasMore = start + limit < events.length;
    return {
      ledgerGeneration,
      events: page,
      nextCursor: hasMore ? encodeCursor(page[page.length - 1].seq) : null,
      hasMore,
      truncated: false,
    };
  }

  return Object.freeze({ record, read, size: () => events.length });
}

module.exports = { createRunEventLedger, RunEventLedgerError, GATE_RUN_EVENT_CODES, SERVICE_RUN_EVENT_CODES };
