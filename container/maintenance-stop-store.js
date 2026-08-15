"use strict";

// Dormant Foundation-B candidate: the root-owned durable STOP store (BUILD-PLAN
// Phase 1c; ROOT-SERVICE-STATE-MACHINES §7). STOP has a monotonically
// increasing root-owned version; the first secure migration starts STOPPED;
// resume is explicit and never inferred. This module owns the STOP SEMANTICS
// over an injected append-only log adapter, so the physical storage substrate
// (one journal for all stores vs per-store files — a reserved substrate
// decision) is decided separately without changing this logic.
//
// DORMANT: not wired into any boot path; activation is the atomic,
// separately-gated Phase 1f event. Every returned view is validated against the
// compiled StopView before it leaves the store.

// reasonCodes an operator/service STOP may carry (IPC contract §6 stop.engage);
// the initial first-secure default is distinct and never re-inferred.
const ENGAGE_REASONS = Object.freeze(["operator_stop", "integrity_failure", "budget_emergency", "shutdown"]);
const FIRST_SECURE_REASON = "first_secure_migration";

class StopStoreError extends Error {
  constructor(code, message) { super(message); this.name = "StopStoreError"; this.code = code; }
}
function fail(code, message) { throw new StopStoreError(code, message); }

function createStopStore({ log, now = Date.now, validateStopView } = {}) {
  if (!log || typeof log.append !== "function" || typeof log.readAll !== "function") {
    throw new Error("STOP store requires an append-only log adapter { append, readAll }");
  }
  if (typeof validateStopView !== "function") throw new Error("STOP store requires the compiled validateStopView");
  if (typeof now !== "function") throw new Error("STOP store requires a clock");

  function nowMs() {
    const value = Number(now());
    if (!Number.isSafeInteger(value) || value <= 0) fail("STORE_UNAVAILABLE", "STOP clock is invalid");
    return value;
  }

  function viewOf(record) {
    const view = {
      engaged: record.engaged,
      version: record.version,
      reasonCode: record.reasonCode,
      summary: record.summary,
      changedAtMs: record.changedAtMs,
    };
    // Defensive: the store must never return a view that violates the contract.
    validateStopView(view);
    return Object.freeze(view);
  }

  // Reconstruct current STOP by replaying the log; the highest version wins.
  // Versions must be a gapless 1..n sequence, else the store is unavailable.
  function replay() {
    let records;
    try { records = log.readAll(); } catch { fail("STORE_UNAVAILABLE", "STOP log is unreadable"); }
    const stops = (records || []).filter((r) => r && r.type === "stop");
    if (stops.length === 0) {
      const seed = { type: "stop", engaged: true, version: 1, reasonCode: FIRST_SECURE_REASON, summary: "Maintenance foundation is stopped until activation.", changedAtMs: nowMs() };
      viewOf(seed); // validate before persisting
      try { log.append(seed); } catch { fail("STORE_UNAVAILABLE", "STOP seed could not be persisted"); }
      return seed;
    }
    stops.sort((a, b) => a.version - b.version);
    for (let i = 0; i < stops.length; i += 1) {
      if (stops[i].version !== i + 1) fail("STORE_UNAVAILABLE", "STOP version sequence has a gap");
      viewOf(stops[i]); // every persisted record must validate
    }
    return stops[stops.length - 1];
  }

  let current = replay();

  function get() { return viewOf(current); }

  function requireVersion(expectedVersion) {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) fail("INVALID_REQUEST", "expectedStopVersion is invalid");
    if (expectedVersion !== current.version) fail("STALE_VERSION", "expectedStopVersion does not match the current STOP version");
  }

  function commit(next) {
    viewOf(next); // validate before persisting
    try { log.append(next); } catch { fail("STORE_UNAVAILABLE", "STOP change could not be persisted"); }
    current = next;
    return get();
  }

  // Engage STOP: monotonic version bump, explicit reason. CAS on the expected
  // version; a stale expectation changes nothing.
  function engage({ expectedVersion, reasonCode, summary = null } = {}) {
    requireVersion(expectedVersion);
    if (!ENGAGE_REASONS.includes(reasonCode)) fail("INVALID_REQUEST", "reasonCode is not an allowed STOP reason");
    if (summary !== null && (typeof summary !== "string" || summary.length > 500)) fail("INVALID_REQUEST", "summary is invalid");
    if (current.engaged && current.reasonCode === reasonCode && (current.summary ?? null) === (summary ?? null)) {
      // Already engaged with the same reason/summary: monotonic no-op re-engage
      // still advances the version so ordering stays strictly increasing.
    }
    return commit({ type: "stop", engaged: true, version: current.version + 1, reasonCode, summary: summary ?? null, changedAtMs: nowMs() });
  }

  // Resume: explicit only, CAS on the expected version. A resumed view carries
  // null reasonCode and null summary (enforced by the contract view).
  function resume({ expectedVersion } = {}) {
    requireVersion(expectedVersion);
    return commit({ type: "stop", engaged: false, version: current.version + 1, reasonCode: null, summary: null, changedAtMs: nowMs() });
  }

  return Object.freeze({ get, engage, resume, ENGAGE_REASONS });
}

module.exports = { createStopStore, StopStoreError, ENGAGE_REASONS, FIRST_SECURE_REASON };
