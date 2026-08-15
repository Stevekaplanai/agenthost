"use strict";

// Dormant Foundation-B candidate: the root-owned durable recovery store
// (BUILD-PLAN Phase 1c; ROOT-SERVICE-STATE-MACHINES §4; IPC contract §4.1
// RecoveryView, §6 recovery.request/recovery.inspect). A recovery is a
// PID-1-authored teardown of a claim's worker: requested -> stopping ->
// cleaning -> complete, or -> quarantined with a fixed reason if any cleanup
// proof fails. The caller only requests (with a non-authorizing claim ref);
// PID 1 selects the target, drives the fixed teardown, and authors every fact —
// the request never carries a PID, signal, path, or success boolean.
//
// Semantics over an injected append-only log adapter; substrate deferred.
// DORMANT: not wired into any boot path; activation gated at Phase 1f. Every
// returned view is validated against the compiled RecoveryView.

const { randomBytes: defaultRandomBytes } = require("node:crypto");

const QUARANTINE_REASONS = new Set(["child_unknown", "descendant_alive", "reap_unproven", "mount_present", "store_unavailable"]);
const TERMINAL = new Set(["complete", "quarantined"]);
// Service-authored teardown progression; quarantine is reachable from any live
// step. Terminal states are absorbing.
const TRANSITIONS = Object.freeze({
  requested: new Set(["stopping", "quarantined"]),
  stopping: new Set(["cleaning", "quarantined"]),
  cleaning: new Set(["complete", "quarantined"]),
  complete: new Set(),
  quarantined: new Set(),
});

class RecoveryStoreError extends Error {
  constructor(code, message) { super(message); this.name = "RecoveryStoreError"; this.code = code; }
}
function fail(code, message) { throw new RecoveryStoreError(code, message); }

function createRecoveryStore({ log, now = Date.now, randomBytes = defaultRandomBytes, validateRecoveryView } = {}) {
  if (!log || typeof log.append !== "function" || typeof log.readAll !== "function") {
    throw new Error("recovery store requires an append-only log adapter { append, readAll }");
  }
  if (typeof validateRecoveryView !== "function") throw new Error("recovery store requires the compiled validateRecoveryView");

  const recoveries = new Map(); // ref -> record

  function nowMs() {
    const v = Number(now());
    if (!Number.isSafeInteger(v) || v <= 0) fail("STORE_UNAVAILABLE", "recovery clock is invalid");
    return v;
  }
  function newRef() { return "rec_" + randomBytes(18).toString("base64url"); }

  function viewOf(record) {
    const view = { ref: record.ref, claimRef: record.claimRef, state: record.state, startedAtMs: record.startedAtMs, finishedAtMs: record.finishedAtMs, quarantineReason: record.quarantineReason };
    validateRecoveryView(view);
    return Object.freeze(view);
  }

  function replay() {
    let records;
    try { records = log.readAll(); } catch { fail("STORE_UNAVAILABLE", "recovery log is unreadable"); }
    for (const r of records || []) {
      if (!r || r.type !== "recovery") continue;
      const record = { ref: r.ref, claimRef: r.claimRef, state: r.state, startedAtMs: r.startedAtMs, finishedAtMs: r.finishedAtMs, quarantineReason: r.quarantineReason };
      recoveries.set(record.ref, record);
      viewOf(record);
    }
  }
  replay();

  function persist(record) {
    viewOf(record);
    try { log.append({ type: "recovery", ...record }); } catch { fail("STORE_UNAVAILABLE", "recovery change could not be persisted"); }
    recoveries.set(record.ref, { ...record });
  }

  function activeForClaim(claimRef) {
    for (const r of recoveries.values()) if (r.claimRef === claimRef && !TERMINAL.has(r.state)) return r;
    return null;
  }

  // recovery.request: record a new recovery for a claim. One live recovery per
  // claim at a time. claimRef is a non-authorizing reference.
  function request({ claimRef } = {}) {
    if (typeof claimRef !== "string" || claimRef.length === 0) fail("INVALID_REQUEST", "claimRef is required");
    if (activeForClaim(claimRef)) fail("RECOVERY_IN_PROGRESS", "the claim already has a live recovery");
    const record = { ref: newRef(), claimRef, state: "requested", startedAtMs: nowMs(), finishedAtMs: null, quarantineReason: null };
    persist(record);
    return viewOf(record);
  }

  function get(ref) {
    const record = recoveries.get(ref);
    return record ? viewOf(record) : null;
  }

  // Service-authored progression through the fixed teardown.
  function advance(ref, to) {
    const record = recoveries.get(ref);
    if (!record) fail("STORE_UNAVAILABLE", "recovery not found");
    if (to === "quarantined") fail("INVALID_REQUEST", "use quarantine(ref, reason) to quarantine");
    if (!TRANSITIONS[record.state].has(to)) fail("INVALID_TRANSITION", `cannot move ${record.state} -> ${to}`);
    const next = { ...record, state: to, finishedAtMs: to === "complete" ? nowMs() : record.finishedAtMs };
    persist(next);
    return viewOf(next);
  }

  // Quarantine a live recovery with a fixed reason when cleanup cannot be proven.
  function quarantine(ref, reasonCode) {
    const record = recoveries.get(ref);
    if (!record) fail("STORE_UNAVAILABLE", "recovery not found");
    if (!TRANSITIONS[record.state].has("quarantined")) fail("INVALID_TRANSITION", `cannot quarantine from ${record.state}`);
    if (!QUARANTINE_REASONS.has(reasonCode)) fail("INVALID_REQUEST", "quarantine reason is not in the fixed set");
    const next = { ...record, state: "quarantined", finishedAtMs: nowMs(), quarantineReason: reasonCode };
    persist(next);
    return viewOf(next);
  }

  return Object.freeze({ request, get, advance, quarantine, QUARANTINE_REASONS, TRANSITIONS });
}

module.exports = { createRecoveryStore, RecoveryStoreError, QUARANTINE_REASONS };
