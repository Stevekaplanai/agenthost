"use strict";

// Dormant Foundation-B candidate: gate-loss reconciliation steps 4-8 (BUILD-PLAN
// Phase 1f; ROOT-SERVICE-STATE-MACHINES §2). Phase 1a already performs steps 1-3
// (block work by leaving READY, revoke the epoch + all connection handles, kill
// and reap the old gate + revoke the native active-gate latch). This reconciler
// performs the governed-worker teardown + accounting 1a left as no-op hooks:
//
//   4. stop every governed worker owned by the old epoch;
//   5. prove direct-child reap + descendant absence + containment empty + writable
//      mount/namespace revocation (carried by the recovery driver's proveGone,
//      proven on real Linux in Phase 1d);
//   6. settle ambiguous usage to the full reservation (conservative);
//   7. mark affected claims/runs interrupted;
//   8. quarantine any lane whose cleanup cannot be proven.
//
// Only after reconcile() returns may the supervisor start a replacement gate
// (step 9). PID 1 selects the recorded epoch workers — nothing here is
// caller-asserted, no pid/signal is chosen by anyone. Every recovery fact is
// authored source=service by the recovery driver; this orchestrator invents no
// audit code of its own. FAIL-CLOSED: a worker whose teardown errors is treated
// as cleanup-unproven (quarantined), never as a silent success.
//
// DORMANT: not wired into the supervisor's boot path; staged for the atomic
// Phase 1f cutover.

class GateLossError extends Error {
  constructor(code, message) { super(message); this.name = "GateLossError"; this.code = code; }
}
function fail(code, message) { throw new GateLossError(code, message); }

// enumerateEpochWorkers(epoch) -> array of recorded targets
//   { claimRef, workerRef, runId, chainId, engine, taskId } owned by the lost
//   epoch (in the one-lane model, 0 or 1). recoverWorker(target) -> { quarantined }
//   is the Phase-1d recovery driver's fixed teardown for one worker.
function createGateLossReconciler({ enumerateEpochWorkers, recoverWorker } = {}) {
  if (typeof enumerateEpochWorkers !== "function") throw new Error("gate-loss reconciler requires enumerateEpochWorkers(epoch)");
  if (typeof recoverWorker !== "function") throw new Error("gate-loss reconciler requires recoverWorker(target)");

  // Steps 4-8 for the lost epoch. Returns
  //   { reconciled, epoch, workers: [{ workerRef, quarantined }], anyQuarantined }.
  // reconciled is true once EVERY recorded worker has been driven through teardown
  // + accounting; a lane whose cleanup could not be proven is quarantined and NOT
  // released (it stays off the one-lane ceiling), but reconciliation still
  // completes so a replacement gate may start.
  async function reconcile({ epoch } = {}) {
    if (typeof epoch !== "string" || epoch.length === 0) fail("INVALID_REQUEST", "epoch is required");
    const targets = enumerateEpochWorkers(epoch);
    if (!Array.isArray(targets)) fail("INTERNAL_RESPONSE_INVALID", "enumerateEpochWorkers must return an array");

    const workers = [];
    for (const target of targets) {
      if (!target || typeof target.workerRef !== "string") fail("INTERNAL_RESPONSE_INVALID", "epoch worker target is missing a recorded workerRef");
      let quarantined;
      try {
        const out = await recoverWorker(target); // steps 4-7 + step 8 (quarantine on unproven)
        quarantined = !!(out && out.quarantined);
      } catch {
        // A teardown that errors leaves cleanup UNPROVEN — fail closed: quarantine
        // the lane rather than let it read as recovered.
        quarantined = true;
      }
      workers.push({ workerRef: target.workerRef, quarantined });
    }
    const anyQuarantined = workers.some((w) => w.quarantined);
    return Object.freeze({ reconciled: true, epoch, workers: Object.freeze(workers), anyQuarantined });
  }

  return Object.freeze({ reconcile });
}

module.exports = { createGateLossReconciler, GateLossError };
