"use strict";

// Dormant Foundation-B candidate: the operator-authority SURFACE (BUILD-PLAN
// Phase 1f; adversarial proof #9 consuming side; IPC contract §5 class O, §6
// O-class methods). The four FIXED consuming handlers —
//   stop_resume, stop_engage (operator), worker_cancel, budget_policy_change —
// each performing its fixed effect AFTER the compiled protocol has already
// verified and one-use-consumed the OperatorProof (validateRequest ->
// consumeOperatorProofForRequest). Plus a beginOperatorAction that records the
// source=gate caller audit (operator_action_requested, §4.2) and delegates
// issuance to the #9 gateway.
//
// The effect map is INJECTED by the (Phase 1f) composition root, so this surface
// is decoupled from store internals and each handler passes ONLY its canonical
// target to the effect — never a caller-controlled extra. This is what the
// contract means by "the operator handlers are fixed": the method->effect binding
// lives in one compiled place, not in generic RPC routing.
//
// DORMANT: not wired into any boot path (entrypoint.sh/start.sh/gate.js). It is
// STAGED for the atomic Phase 1f cutover, which requires its own independent pass
// (it is not covered by the proof-level red-team of the frozen revision).

const OPERATOR_ACTIONS = ["stop_resume", "stop_engage", "worker_cancel", "budget_policy_change"];

class OperatorHandlerError extends Error {
  constructor(code, message) { super(message); this.name = "OperatorHandlerError"; this.code = code; }
}
function fail(code, message) { throw new OperatorHandlerError(code, message); }

// effects: { stop_resume, stop_engage, worker_cancel, budget_policy_change }, each
//   a function(canonicalTarget) => result, bound by the composition root to the
//   real store/driver op (stopStore.resume / stopStore.engage /
//   recoveryDriver.recover / budgetStore.setPolicy).
// gateway: the #9 operator gateway (beginOperatorAction issuer).
// audit: optional (eventCode, detail) sink for the source=gate caller audit.
function createOperatorHandlers({ gateway, effects, audit = null } = {}) {
  if (!gateway || typeof gateway.beginOperatorAction !== "function") throw new Error("operator handlers require the #9 gateway");
  if (!effects || typeof effects !== "object") throw new Error("operator handlers require an effects map");
  for (const action of OPERATOR_ACTIONS) {
    if (typeof effects[action] !== "function") throw new Error(`operator handlers require a fixed effect for ${action}`);
  }
  const auditFn = typeof audit === "function" ? audit : null;

  // operator.action.begin: mint the proof (the gateway validates action + digests),
  // then record the source=gate caller audit. Auditing only AFTER a successful
  // issue avoids recording rejected/garbage requests.
  function beginOperatorAction(params = {}) {
    const result = gateway.beginOperatorAction(params);
    if (auditFn) auditFn("operator_action_requested", { action: params.action, targetDigest: params.targetDigest });
    return result;
  }

  // Perform the fixed effect for an already-authorized O-class request. The proof
  // was verified + consumed by the protocol before we get here; the handler adds
  // no authority of its own and forwards ONLY the canonical target.
  function perform(action, canonicalTarget) {
    const effect = effects[action];
    if (typeof effect !== "function") fail("ACTION_NOT_ALLOWED", `no fixed effect for ${action}`);
    return effect(canonicalTarget);
  }

  return Object.freeze({
    beginOperatorAction,
    // Canonical targets per IPC contract §6 (the exact objects the protocol
    // recomputes the target digest from):
    stopResume: (target) => perform("stop_resume", target),                 // { expectedStopVersion }
    stopEngage: (target) => perform("stop_engage", target),                 // { expectedStopVersion, reasonCode, summary }
    workerCancel: (target) => perform("worker_cancel", target),             // { workerRef, expectedWorkerVersion, reasonCode }
    budgetPolicySet: (target) => perform("budget_policy_change", target),   // { expectedVersion, costLimitEnabled, costLimitMicros }
  });
}

module.exports = { createOperatorHandlers, OperatorHandlerError, OPERATOR_ACTIONS };
