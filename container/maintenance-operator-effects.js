"use strict";

// Dormant Foundation-B candidate: the FIXED operator effect-binding (BUILD-PLAN
// Phase 1f; the composition-root fragment Hermes flagged for review before
// cutover). It maps each O-class canonical target to EXACTLY one store/driver op,
// remapping target field names to the store's argument names in one audited
// place — the spot a wrong mapping would silently point an operator action at the
// wrong target. The four O-class actions (IPC contract §6):
//
//   stop_resume         { expectedStopVersion }                        -> stopStore.resume({ expectedVersion })
//   stop_engage         { expectedStopVersion, reasonCode, summary }   -> stopStore.engage({ expectedVersion, reasonCode, summary })
//   budget_policy_change{ expectedVersion, costLimitEnabled, costLimitMicros } -> budgetStore.setPolicy(same)
//   worker_cancel       { workerRef, expectedWorkerVersion, reasonCode } -> cancelWorker(same)
//
// The proof was already verified + one-use-consumed by the protocol before an
// effect runs (validateRequest -> consumeOperatorProofForRequest); these effects
// add NO authority and receive ONLY the canonical target. `cancelWorker` (the
// live worker teardown) is injected because it composes the recovery path; the
// stores are injected so this stays free of the reserved storage-substrate
// decision. The composition root passes the resulting map to the operator
// handlers as their `effects`.
//
// DORMANT: not wired into any boot path; staged for the atomic Phase 1f cutover.

function req(obj, keys, label) {
  for (const k of keys) if (!(k in (obj || {}))) { const e = new Error(`operator effect ${label}: missing ${k}`); e.code = "INVALID_REQUEST"; throw e; }
}

function createOperatorEffects({ stopStore, budgetStore, cancelWorker } = {}) {
  if (!stopStore || typeof stopStore.resume !== "function" || typeof stopStore.engage !== "function") throw new Error("operator effects require the stop store (resume, engage)");
  if (!budgetStore || typeof budgetStore.setPolicy !== "function") throw new Error("operator effects require the budget store (setPolicy)");
  if (typeof cancelWorker !== "function") throw new Error("operator effects require a cancelWorker(target) teardown");

  return Object.freeze({
    stop_resume(target) {
      req(target, ["expectedStopVersion"], "stop_resume");
      return stopStore.resume({ expectedVersion: target.expectedStopVersion });
    },
    stop_engage(target) {
      req(target, ["expectedStopVersion", "reasonCode", "summary"], "stop_engage");
      return stopStore.engage({ expectedVersion: target.expectedStopVersion, reasonCode: target.reasonCode, summary: target.summary });
    },
    budget_policy_change(target) {
      req(target, ["expectedVersion", "costLimitEnabled", "costLimitMicros"], "budget_policy_change");
      return budgetStore.setPolicy({ expectedVersion: target.expectedVersion, costLimitEnabled: target.costLimitEnabled, costLimitMicros: target.costLimitMicros });
    },
    worker_cancel(target) {
      req(target, ["workerRef", "expectedWorkerVersion", "reasonCode"], "worker_cancel");
      return cancelWorker({ workerRef: target.workerRef, expectedWorkerVersion: target.expectedWorkerVersion, reasonCode: target.reasonCode });
    },
  });
}

module.exports = { createOperatorEffects };
