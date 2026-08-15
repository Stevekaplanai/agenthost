"use strict";

// Dormant Foundation-B candidate: boot reconciliation (BUILD-PLAN Phase 1b/1c;
// ROOT-SERVICE-STATE-MACHINES §1 BOOT_RECONCILING, §6 crash-point outcomes, §2
// gate-loss order). On boot, before the socket or gate becomes usable, PID 1
// reconciles the durable stores:
//   - A claim with a worker still attached is AMBIGUOUS after a crash: settle
//     its budget conservatively (the full reservation), interrupt its
//     worker-authority run, detach the worker, and mark the claim interrupted.
//     Consequential work is never replayed.
//   - A non-terminal claim with no attached worker is preserved as PARKED data;
//     its old connection handles are already invalid on restart. It is never
//     auto-launched.
//   - Terminal claims are left as-is.
//
// This orchestrates the already-proven stores; the physical worker teardown
// proof (descendant/containment/mount) is Phase 1d. DORMANT: not wired into any
// boot path; activation is the atomic, separately-gated Phase 1f event.

const CLAIM_TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted", "released", "quarantined"]);
const RUN_TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted", "skipped"]);
const TOLERATED_BUDGET = new Set(["NOT_RESERVED", "ALREADY_FINALIZED"]);

function createBootReconciler({ claimsStore, runsStore, budgetStore, log = () => {} } = {}) {
  if (!claimsStore || typeof claimsStore.list !== "function") throw new Error("boot reconciler requires a claims store with list()");
  if (!runsStore || typeof runsStore.get !== "function") throw new Error("boot reconciler requires a runs store");
  if (!budgetStore || typeof budgetStore.settle !== "function") throw new Error("boot reconciler requires a budget store");

  function conservativelySettle(workerRef) {
    if (!workerRef) return false;
    try {
      budgetStore.settle({ workerRef, trusted: false }); // full_charge: missing usage is charged in full
      return true;
    } catch (error) {
      if (TOLERATED_BUDGET.has(error && error.code)) return false; // no reservation / already finalized
      throw error;
    }
  }

  function interruptRun(runId) {
    if (!runId) return false;
    const run = runsStore.get(runId);
    if (!run || run.authority !== "worker" || RUN_TERMINAL.has(run.status)) return false;
    runsStore.serviceTransition(run.id, { expectedVersion: run.version, to: "interrupted" });
    return true;
  }

  // Reconcile all durable claims. Returns a summary; makes no launch.
  function reconcile() {
    const interrupted = [];
    const parked = [];
    const settled = [];
    for (const claim of claimsStore.list()) {
      if (CLAIM_TERMINAL.has(claim.state)) continue;
      if (claim.workerRef !== null) {
        // Ambiguous in-flight work: settle conservatively, interrupt run, detach, interrupt claim.
        if (conservativelySettle(claim.workerRef)) settled.push(claim.workerRef);
        interruptRun(claim.runId);
        const detached = claimsStore.detachWorker(claim.ref, { expectedVersion: claim.version });
        claimsStore.transition(claim.ref, { expectedVersion: detached.version, to: "interrupted" });
        interrupted.push(claim.ref);
        log(`reconcile: interrupted in-flight claim ${claim.ref}`);
      } else {
        // Preserved as parked data; never auto-launched.
        parked.push(claim.ref);
      }
    }
    return { interrupted, parked, settled };
  }

  return Object.freeze({ reconcile });
}

module.exports = { createBootReconciler };
