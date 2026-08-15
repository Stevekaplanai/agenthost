"use strict";

// Dormant Foundation-B candidate: the operator-authority composition (BUILD-PLAN
// Phase 1f, Step 4a — piece 1 of the composition root). It assembles four
// already-reviewed dormant modules into the single O-class authority surface the
// cutover will mount behind the socket:
//
//   #9 proof gateway + one-use registry  (maintenance-operator-gateway.js)
//   fixed effect-binding                 (maintenance-operator-effects.js)
//   the four O-class handlers + audit    (maintenance-operator-handlers.js)
//   the real trusted stores              (injected: stop + budget + cancelWorker)
//
// This is the security heart of activation: every operator STOP/resume,
// worker-cancel, and budget-policy change flows begin -> mint proof -> (protocol
// consumes the one-use, target-bound proof) -> handler -> effect -> store through
// exactly this surface. The composition owns NO authority of its own — it only
// wires the pieces and hands PID 1 the proof registry to inject into the protocol
// context (and to revoke on gate loss).
//
// DORMANT: not wired into entrypoint.sh/start.sh/gate.js; the composition root
// (piece 5 of 4a) mounts this behind the dispatcher at the gated cutover.

const { createOperatorProofRegistry, createOperatorGateway } = require("./maintenance-operator-gateway.js");
const { createOperatorEffects } = require("./maintenance-operator-effects.js");
const { createOperatorHandlers } = require("./maintenance-operator-handlers.js");

// createOperatorAuthority({ stopStore, budgetStore, cancelWorker, now, audit? })
//   stopStore    : the trusted STOP store (resume/engage)
//   budgetStore  : the trusted budget store (setPolicy)
//   cancelWorker : injected worker teardown for worker_cancel — the seam that
//                  ties O-class cancel to the recovery/worker path; PID 1 owns it
//   now          : () => ms service clock (proof issuance/expiry)
//   audit        : optional (eventCode, detail) => void, fired ONLY after a
//                  successful operator.action.begin (source=gate caller audit)
function createOperatorAuthority({ stopStore, budgetStore, cancelWorker, now, audit = null } = {}) {
  if (!stopStore || typeof stopStore.resume !== "function" || typeof stopStore.engage !== "function") {
    throw new Error("operator authority requires a stop store with resume/engage");
  }
  if (!budgetStore || typeof budgetStore.setPolicy !== "function") {
    throw new Error("operator authority requires a budget store with setPolicy");
  }
  if (typeof cancelWorker !== "function") throw new Error("operator authority requires a cancelWorker teardown");
  if (typeof now !== "function") throw new Error("operator authority requires a now() clock");

  const registry = createOperatorProofRegistry();
  const gateway = createOperatorGateway({ registry, now });
  const effects = createOperatorEffects({ stopStore, budgetStore, cancelWorker });
  const handlers = createOperatorHandlers({ gateway, effects, audit });

  return Object.freeze({
    // PID 1 injects this into the protocol context as `operatorProofRegistry`
    // (consumed one-use during validateRequest) and calls revokeConnection on
    // gate loss so no proof survives an epoch.
    registry,
    // operator.action.begin issuer (C/M): authenticates action+target, mints the
    // one-use proof, and records the source=gate caller audit on success.
    beginOperatorAction: handlers.beginOperatorAction,
    // The four O-class dispatch handlers. Each receives ONLY the canonical target
    // the protocol already validated + consumed the proof for, and performs
    // exactly one store/teardown op.
    stopResume: handlers.stopResume,
    stopEngage: handlers.stopEngage,
    workerCancel: handlers.workerCancel,
    budgetPolicySet: handlers.budgetPolicySet,
  });
}

module.exports = { createOperatorAuthority };
