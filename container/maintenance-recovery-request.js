"use strict";

// Dormant Foundation-B candidate: the live recovery.request handler (BUILD-PLAN
// Phase 1f; IPC contract §6 recovery.request; ROOT-SERVICE-STATE-MACHINES §4/§5;
// proof #6 execution). Class C/M.
//
// PID 1 SELECTS its recorded target: the caller supplies only {claimRef,
// expectedVersion} — never a pid, signal, or success flag. The handler resolves
// the recorded worker for the claim, CAS-checks the version, and drives the
// already-proven (Phase 1d) recovery driver's FIXED teardown, returning a
// RecoveryView. Eligibility is fail-closed:
//   - no such claim / stale version / no recorded worker / non-recoverable state
//     -> RECOVERY_NOT_ELIGIBLE;
//   - a quarantined claim -> RECOVERY_QUARANTINED;
//   - degraded persistence -> best-effort emergency containment (if a direct
//     teardown handle is wired) but NO durable success: STORE_UNAVAILABLE with a
//     fatal-restart signal (§6 "emergency containment is allowed degraded ...
//     cannot report durable success, keeps the lane quarantined, and proceeds to
//     fatal restart"). Never a false success.
//
// The recovery driver authors every recovery fact source=service. DORMANT: not
// wired into any boot path; staged for the atomic Phase 1f cutover.

class RecoveryRequestError extends Error {
  constructor(code, message) { super(message); this.name = "RecoveryRequestError"; this.code = code; }
}
function fail(code, message) { throw new RecoveryRequestError(code, message); }

// Claim states with a live worker that can be torn down. Terminal/released states
// have nothing live to recover; quarantined is handled explicitly above.
const RECOVERABLE_CLAIM_STATES = new Set(["active", "reviewing", "correction_required", "awaiting_review"]);

// emergencyContain(target): optional direct teardown for the degraded path — a
// containment collapse that does NOT depend on the (degraded) durable stores. The
// composition root wires it; without it, degraded mode still fails closed.
function createRecoveryRequestHandler({ claimsStore, recoveryDriver, storesHealthy = null, emergencyContain = null } = {}) {
  if (!claimsStore || typeof claimsStore.get !== "function") throw new Error("recovery.request requires the claims store");
  if (!recoveryDriver || typeof recoveryDriver.recover !== "function") throw new Error("recovery.request requires the recovery driver");
  const healthy = typeof storesHealthy === "function" ? storesHealthy : () => true;

  async function request({ claimRef, expectedVersion } = {}) {
    if (typeof claimRef !== "string" || claimRef.length === 0) fail("RECOVERY_NOT_ELIGIBLE", "claimRef is required");
    if (!Number.isSafeInteger(expectedVersion)) fail("RECOVERY_NOT_ELIGIBLE", "expectedVersion must be a safe integer");

    const claim = claimsStore.get(claimRef);
    if (!claim) fail("RECOVERY_NOT_ELIGIBLE", "no such claim");
    if (claim.version !== expectedVersion) fail("RECOVERY_NOT_ELIGIBLE", "claim version is stale");
    if (claim.state === "quarantined") fail("RECOVERY_QUARANTINED", "claim is quarantined and cannot be recovered");
    if (!claim.workerRef) fail("RECOVERY_NOT_ELIGIBLE", "claim has no recorded worker to recover");
    if (!RECOVERABLE_CLAIM_STATES.has(claim.state)) fail("RECOVERY_NOT_ELIGIBLE", `claim state ${claim.state} is not recoverable`);

    // PID 1 selects the recorded worker; nothing here is caller-asserted.
    const target = { claimRef, workerRef: claim.workerRef, runId: claim.runId, chainId: claim.chainId, engine: claim.authorEngine, taskId: claim.taskId };

    if (!healthy()) {
      // Degraded: attempt emergency containment (if wired) but never claim durable
      // success. Fail closed and signal a fatal restart; the lane stays quarantined.
      if (typeof emergencyContain === "function") {
        try { await emergencyContain(target); } catch { /* best-effort only */ }
      }
      const err = new RecoveryRequestError("STORE_UNAVAILABLE", "recovery persistence is degraded; containment attempted, fatal restart required");
      err.fatalRestart = true;
      throw err;
    }

    const out = await recoveryDriver.recover(target);
    return { recovery: out.recovery, quarantined: out.quarantined };
  }

  return Object.freeze({ request });
}

module.exports = { createRecoveryRequestHandler, RecoveryRequestError, RECOVERABLE_CLAIM_STATES };
