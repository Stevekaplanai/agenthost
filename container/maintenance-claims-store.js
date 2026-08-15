"use strict";

// Dormant Foundation-B candidate: the root-owned durable claims store
// (BUILD-PLAN Phase 1c; ROOT-SERVICE-STATE-MACHINES §3; IPC contract §4.1
// ClaimView, §6 claim.transition/claim.release). One task has one claim with a
// monotonic version; transitions are CAS on the expected version and confined
// to the legal matrix. Only completed/failed/cancelled/interrupted are
// releasable; quarantined is deliberately not.
//
// Semantics over an injected append-only log adapter ({ append, readAll }); the
// physical substrate is a separate reserved decision. DORMANT: not wired into
// any boot path; activation is the atomic, separately-gated Phase 1f event.
// Every returned view is validated against the compiled ClaimView.

const { randomBytes: defaultRandomBytes } = require("node:crypto");

const RELEASABLE = new Set(["completed", "failed", "cancelled", "interrupted"]);

// Legal target states from each state (superset of caller + service-authored
// transitions). Terminal releasable states may only go to `released`;
// quarantined and released are absorbing.
const TRANSITIONS = Object.freeze({
  active: ["awaiting_review", "failed", "interrupted", "cancelled", "quarantined"],
  awaiting_review: ["reviewing", "failed", "interrupted", "cancelled", "quarantined"],
  reviewing: ["completed", "correction_required", "failed", "interrupted", "cancelled", "quarantined"],
  correction_required: ["active", "failed", "interrupted", "cancelled", "quarantined"],
  completed: ["released"],
  failed: ["released"],
  cancelled: ["released"],
  interrupted: ["released"],
  quarantined: [],
  released: [],
});
// States in which a governed worker may be attached to the claim.
const WORKER_ATTACHABLE = new Set(["active", "reviewing"]);

class ClaimsStoreError extends Error {
  constructor(code, message) { super(message); this.name = "ClaimsStoreError"; this.code = code; }
}
function fail(code, message) { throw new ClaimsStoreError(code, message); }

function createClaimsStore({ log, now = Date.now, randomBytes = defaultRandomBytes, validateClaimView } = {}) {
  if (!log || typeof log.append !== "function" || typeof log.readAll !== "function") {
    throw new Error("claims store requires an append-only log adapter { append, readAll }");
  }
  if (typeof validateClaimView !== "function") throw new Error("claims store requires the compiled validateClaimView");

  const claims = new Map(); // ref -> record

  function nowMs() {
    const v = Number(now());
    if (!Number.isSafeInteger(v) || v <= 0) fail("STORE_UNAVAILABLE", "claims clock is invalid");
    return v;
  }
  function newRef() { return "clm_" + randomBytes(18).toString("base64url"); }

  function viewOf(record) {
    const view = {
      ref: record.ref, taskId: record.taskId, runId: record.runId, chainId: record.chainId,
      authorEngine: record.authorEngine, state: record.state, version: record.version,
      workerRef: record.workerRef, recoveryRef: record.recoveryRef, updatedAtMs: record.updatedAtMs,
    };
    validateClaimView(view);
    return Object.freeze(view);
  }

  function replay() {
    let records;
    try { records = log.readAll(); } catch { fail("STORE_UNAVAILABLE", "claims log is unreadable"); }
    for (const r of records || []) {
      if (!r || r.type !== "claim") continue;
      claims.set(r.ref, { ...r });
      delete claims.get(r.ref).type;
      viewOf(claims.get(r.ref)); // every persisted record must validate
    }
  }
  replay();

  function persist(record) {
    viewOf(record); // validate before persisting
    try { log.append({ type: "claim", ...record }); } catch { fail("STORE_UNAVAILABLE", "claim change could not be persisted"); }
    claims.set(record.ref, { ...record });
  }

  function requireClaim(ref, expectedVersion) {
    const record = claims.get(ref);
    if (!record) fail("STORE_UNAVAILABLE", "claim not found");
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== record.version) fail("STALE_VERSION", "expectedVersion does not match the claim");
    return record;
  }

  // mode=new: no existing claim for the task; create an active claim, recording
  // the author engine. taskId uniqueness is the caller's (one-lane) guarantee.
  function create({ taskId, runId, chainId, authorEngine } = {}) {
    for (const [k, v] of Object.entries({ taskId, runId, chainId, authorEngine })) {
      if (typeof v !== "string" || v.length === 0) fail("INVALID_REQUEST", `${k} is required`);
    }
    const record = { ref: newRef(), taskId, runId, chainId, authorEngine, state: "active", version: 1, workerRef: null, recoveryRef: null, updatedAtMs: nowMs() };
    persist(record);
    return viewOf(record);
  }

  function get(ref) {
    const record = claims.get(ref);
    return record ? viewOf(record) : null;
  }

  // All current claim views (used by boot reconciliation).
  function list() {
    return [...claims.values()].map(viewOf);
  }

  // Generic CAS transition confined to the legal matrix. `released` carries the
  // extra terminal/cleanup guards.
  function transition(ref, { expectedVersion, to, reasonCode } = {}) {
    const record = requireClaim(ref, expectedVersion);
    const allowed = TRANSITIONS[record.state] || [];
    if (!allowed.includes(to)) fail("INVALID_TRANSITION", `cannot move ${record.state} -> ${to}`);
    if (to === "released") {
      if (!RELEASABLE.has(record.state)) fail("CLAIM_NOT_TERMINAL", "only completed/failed/cancelled/interrupted are releasable");
      if (record.workerRef !== null || record.recoveryRef !== null) fail("CLEANUP_UNPROVEN", "a claim with a worker or recovery cannot be released");
      if (reasonCode !== record.state) fail("INVALID_REQUEST", "release reasonCode must equal the current terminal state");
    }
    const next = { ...record, state: to, version: record.version + 1, updatedAtMs: nowMs() };
    persist(next);
    return viewOf(next);
  }

  // Attach/detach a governed worker (opaque ref). Attach only where a worker may
  // run; detach models proven cleanup and is allowed from any live state.
  function attachWorker(ref, { expectedVersion, workerRef } = {}) {
    const record = requireClaim(ref, expectedVersion);
    if (!WORKER_ATTACHABLE.has(record.state)) fail("INVALID_TRANSITION", `cannot attach a worker in ${record.state}`);
    if (record.workerRef !== null) fail("WORKER_ACTIVE", "the claim already has a worker");
    if (typeof workerRef !== "string") fail("INVALID_REQUEST", "workerRef is required");
    persist({ ...record, workerRef, version: record.version + 1, updatedAtMs: nowMs() });
    return get(ref);
  }
  function detachWorker(ref, { expectedVersion } = {}) {
    const record = requireClaim(ref, expectedVersion);
    persist({ ...record, workerRef: null, version: record.version + 1, updatedAtMs: nowMs() });
    return get(ref);
  }

  return Object.freeze({ create, get, list, transition, attachWorker, detachWorker, RELEASABLE, TRANSITIONS });
}

module.exports = { createClaimsStore, ClaimsStoreError, RELEASABLE, TRANSITIONS };
