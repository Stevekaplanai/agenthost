"use strict";

// Dormant Foundation-B candidate: the gateway operator-auth ISSUER + one-use
// OperatorProof registry (BUILD-PLAN Phase 1f, adversarial proof #9; IPC contract
// §5 authorization class O, §6 `operator.action.begin`, §3.1 operator target
// digest).
//
// The compiled protocol (`maintenance-protocol.js` `consumeOperatorProofForRequest`
// / `operatorProof`) ALREADY verifies and one-use-consumes an `OperatorProof` for
// the four O-class methods — `stop.resume`, operator `stop.engage`, `work.cancel`
// (`worker_cancel`), and `budget.policy.set` (`budget_policy_change`) — recomputing
// the canonical target digest WITHOUT the proof and rejecting any mismatch. What
// it needs but did not yet have:
//   (1) the operator-proof REGISTRY its verifier consumes from, whose `consume`
//       returns `null` on any miss/mismatch and EXACTLY the five-field record on a
//       hit, and is one-use; and
//   (2) the `operator.action.begin` ISSUER (PID 1's side) that mints a one-use
//       proof bound to the gateway epoch, operator session, action enum, canonical
//       target digest, and a 30-second expiry.
// This module supplies exactly those two and reuses the protocol's verification —
// it reimplements no digest, target, or consume logic.
//
// DORMANT: not wired into any boot path (`entrypoint.sh`/`start.sh`/`gate.js`) and
// not referenced by the supervisor dispatch. Binding each O-class handler to its
// fixed store effect and routing full requests is the Phase 1f integration step
// and is intentionally NOT done here. Activation is the separate Phase 1f event.

const { randomBytes: defaultRandomBytes } = require("node:crypto");

// The four compiled operator actions (IPC contract §6 operator.action.begin).
const OPERATOR_ACTIONS = new Set(["stop_resume", "stop_engage", "worker_cancel", "budget_policy_change"]);
const PROOF_TTL_MS = 30_000; // §5: one-use, 30-second expiry.
const SHA_RE = /^sha256:[0-9a-f]{64}$/;
const PROOF_KIND = "operator_proof";

class OperatorGatewayError extends Error {
  constructor(code, message) { super(message); this.name = "OperatorGatewayError"; this.code = code; }
}
function gfail(code, message) { throw new OperatorGatewayError(code, message); }

// One-use OperatorProof registry. Each record is bound to (connectionId,
// gatewayEpoch, kind); `consume` enforces that binding, removes the handle on the
// FIRST presentation (one-use, even a mismatched one — a stolen handle cannot be
// retried), and returns EXACTLY the five fields the protocol verifier requires:
// {action, targetDigest, operatorSessionDigest, issuedAtMs, expiresAtMs}. Any
// miss/mismatch returns null so the verifier fails closed with OPERATOR_AUTH_REQUIRED.
function createOperatorProofRegistry({ randomBytes = defaultRandomBytes } = {}) {
  const entries = new Map(); // actionHandle -> { record, connectionId, epoch, kind }

  function newHandle() {
    // "op_" + base64url(18 bytes) = 24 chars → matches the contract OpaqueRef
    // pattern ^[a-z]+_[A-Za-z0-9_-]{22,86}$ (also a valid Handle).
    const bytes = randomBytes(18);
    if (!Buffer.isBuffer(bytes) || bytes.length !== 18) throw new Error("operator proof handle needs 18 random bytes");
    return "op_" + bytes.toString("base64url");
  }

  function issue({ connectionId, epoch, action, targetDigest, operatorSessionDigest, issuedAtMs } = {}) {
    const record = { action, targetDigest, operatorSessionDigest, issuedAtMs, expiresAtMs: issuedAtMs + PROOF_TTL_MS };
    let handle = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = newHandle();
      if (!entries.has(candidate)) { handle = candidate; break; }
    }
    if (!handle) throw new Error("could not allocate a unique operator proof handle");
    entries.set(handle, { record, connectionId, epoch, kind: PROOF_KIND });
    return { actionHandle: handle, expiresAtMs: record.expiresAtMs };
  }

  function consume(actionHandle, { connectionId, epoch, kind } = {}) {
    const entry = entries.get(actionHandle);
    if (!entry) return null;              // unknown or already consumed (one-use)
    entries.delete(actionHandle);         // one-use: burn on any presentation
    if (entry.kind !== kind || entry.connectionId !== connectionId || entry.epoch !== epoch) return null;
    return { ...entry.record };           // exactly the five verifier-required fields
  }

  // Gate-loss / disconnect cleanup: drop every outstanding proof for a connection.
  function revokeConnection(connectionId) {
    let revoked = 0;
    for (const [handle, entry] of entries) {
      if (entry.connectionId === connectionId) { entries.delete(handle); revoked += 1; }
    }
    return revoked;
  }

  function size() { return entries.size; }

  return Object.freeze({ issue, consume, revokeConnection, size });
}

// The `operator.action.begin` issuer. Login/Origin/CSRF/user-gesture checks are the
// authenticated HTTP gateway's job and run BEFORE this (contract §5); this is the
// PID-1 side that mints the one-use proof. It does NOT independently prove a human
// was present — audits attribute O-class actions to source=gate.
function createOperatorGateway({ registry, now } = {}) {
  if (!registry || typeof registry.issue !== "function" || typeof registry.consume !== "function") {
    throw new Error("operator gateway requires an operator-proof registry");
  }
  if (typeof now !== "function") throw new Error("operator gateway requires a now() clock");

  function beginOperatorAction({ connectionId, gatewayEpoch, action, operatorSessionDigest, targetDigest } = {}) {
    if (!OPERATOR_ACTIONS.has(action)) gfail("ACTION_NOT_ALLOWED", "unknown operator action");
    if (typeof connectionId !== "string" || connectionId.length === 0 || connectionId.length > 128) {
      gfail("OPERATOR_AUTH_REQUIRED", "operator action requires a connection identity");
    }
    if (typeof gatewayEpoch !== "string" || gatewayEpoch.length === 0) {
      gfail("OPERATOR_AUTH_REQUIRED", "operator action requires the gateway epoch");
    }
    if (typeof operatorSessionDigest !== "string" || !SHA_RE.test(operatorSessionDigest)) {
      gfail("OPERATOR_AUTH_REQUIRED", "operator action requires the operator session digest");
    }
    if (typeof targetDigest !== "string" || !SHA_RE.test(targetDigest)) {
      gfail("OPERATOR_AUTH_REQUIRED", "operator action requires a canonical target digest");
    }
    const issuedAtMs = now();
    if (!Number.isSafeInteger(issuedAtMs) || issuedAtMs < 0) {
      gfail("OPERATOR_AUTH_REQUIRED", "operator action requires the service clock");
    }
    const { actionHandle, expiresAtMs } = registry.issue({
      connectionId, epoch: gatewayEpoch, action, targetDigest, operatorSessionDigest, issuedAtMs,
    });
    // The OperatorProof view (§4.2): exactly {actionHandle, action, targetDigest, expiresAtMs}.
    return { operatorProof: { actionHandle, action, targetDigest, expiresAtMs } };
  }

  return Object.freeze({ beginOperatorAction });
}

module.exports = { createOperatorProofRegistry, createOperatorGateway, OperatorGatewayError, OPERATOR_ACTIONS, PROOF_TTL_MS };
