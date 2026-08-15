"use strict";

// Dormant Foundation-B candidate: the recovery / gate-loss teardown driver
// (BUILD-PLAN Phase 1d; ROOT-SERVICE-STATE-MACHINES §4, §5). PID 1 authors every
// recovery fact: on a cancel or gate loss it requests a recovery, tears down the
// worker's containment, PROVES the worker is gone, settles the budget
// conservatively (full charge for ambiguous/unknown usage), marks the claim and
// run interrupted, and completes the recovery. If descendant/cleanup cannot be
// proven, it QUARANTINES the recovery and the claim (not releasable) instead.
//
// The caller supplies no PID, signal, path, or success boolean — this driver
// selects the recorded worker and drives the fixed teardown. DORMANT: not wired
// into any boot path; activation is the atomic, separately-gated Phase 1f event.

const TOLERATED_BUDGET = new Set(["NOT_RESERVED", "ALREADY_FINALIZED"]);

function createRecoveryDriver({ recoveryStore, claimsStore, runsStore, budgetStore, auditStore, teardownWorker, verifyGone, releaseLane, delay } = {}) {
  for (const [name, v] of Object.entries({ recoveryStore, claimsStore, runsStore, budgetStore, auditStore, teardownWorker, verifyGone })) {
    if (!v) throw new Error(`recovery driver requires ${name}`);
  }
  const wait = delay || ((ms) => new Promise((r) => setTimeout(r, ms)));

  async function proveGone(workerRef, graceMs) {
    const deadline = graceMs || 4000;
    for (let waited = 0; waited < deadline; waited += 50) {
      if (verifyGone(workerRef)) return true;
      await wait(50);
    }
    return verifyGone(workerRef);
  }

  function settleConservatively(workerRef) {
    try { budgetStore.settle({ workerRef, trusted: false }); } // full_charge: ambiguous/unknown usage
    catch (error) { if (!TOLERATED_BUDGET.has(error && error.code)) throw error; }
  }

  // Recover the recorded worker for a claim. Returns { recovery, quarantined }.
  async function recover({ claimRef, workerRef, runId, chainId, engine = null, taskId = null, graceMs } = {}) {
    const rec = recoveryStore.request({ claimRef }); // requested
    recoveryStore.advance(rec.ref, "stopping");
    teardownWorker(workerRef); // fixed teardown (TERM/grace/KILL abstracted into the containment collapse)

    const gone = await proveGone(workerRef, graceMs);
    settleConservatively(workerRef);

    const claim = claimsStore.get(claimRef);
    const run = runsStore.get(runId);
    const detached = claim && claim.workerRef ? claimsStore.detachWorker(claimRef, { expectedVersion: claim.version }) : claim;

    if (!gone) {
      // Cleanup unproven: quarantine the recovery and the claim (not releasable).
      recoveryStore.quarantine(rec.ref, "descendant_alive");
      if (detached && detached.state !== "quarantined") claimsStore.transition(claimRef, { expectedVersion: detached.version, to: "quarantined" });
      if (run && run.status === "running") runsStore.serviceTransition(runId, { expectedVersion: run.version, to: "interrupted" });
      auditStore.appendService({ eventCode: "recovery_quarantined", detail: { claimRef, recoveryRef: rec.ref, reasonCode: "descendant_alive" }, runId, taskId, engine });
      if (releaseLane) releaseLane(workerRef);
      return { recovery: recoveryStore.get(rec.ref), quarantined: true };
    }

    recoveryStore.advance(rec.ref, "cleaning");
    if (detached) claimsStore.transition(claimRef, { expectedVersion: detached.version, to: "interrupted" });
    if (run && run.status === "running") runsStore.serviceTransition(runId, { expectedVersion: run.version, to: "interrupted" });
    recoveryStore.advance(rec.ref, "complete");
    auditStore.appendService({ eventCode: "recovery_completed", detail: { claimRef, recoveryRef: rec.ref }, runId, taskId, engine });
    if (releaseLane) releaseLane(workerRef);
    return { recovery: recoveryStore.get(rec.ref), quarantined: false };
  }

  return Object.freeze({ recover });
}

module.exports = { createRecoveryDriver };
