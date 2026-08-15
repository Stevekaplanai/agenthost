"use strict";

// Dormant Foundation-B candidate: the live worker-view registry (BUILD-PLAN
// Phase 1f, Step 4a — piece 2 of the composition root). The Phase-1d launch
// transaction (maintenance-work-launch.js) proves the atomic
// acquire -> spawn -> child-observed sequence but tracks only the one-lane
// { busy, workerRef }; it never materializes the WorkerView that the IPC read
// and cancel methods (work.inspect, work.cancel, and — with the output-spool
// brick — work.output.read) must return. This registry is that missing surface.
//
// It records the observed child as a `running` WorkerView, drives the
// operator-cancel `stopping` transition (the seam createOperatorEffects.cancelWorker
// binds to), and records the terminal outcome at completion — ONE live worker at
// a time, never a pool, matching the agentBusy ceiling. Terminal workers are
// retained so work.inspect can still resolve them after completion.
//
// Every view it emits satisfies the protocol's WorkerView contract
// (validateWorkerView): version >= 1 and strictly increasing; terminal states
// carry finishedAtMs + outputEof; non-terminal states never carry finishedAtMs.
//
// DORMANT: no boot wiring. Output-chunk spooling for work.output.read is a
// following brick; this registry owns the WorkerView state lifecycle only.

const OPAQUE_RE = /^[a-z]+_[A-Za-z0-9_-]{22,86}$/;
const SIGNAL_RE = /^[A-Z][A-Z0-9]{1,31}$/;
// Live states from which an operator cancel may begin.
const CANCELLABLE = new Set(["starting", "running"]);
const OUTCOME_STATE = Object.freeze({
  completed: "completed", failed: "failed", cancelled: "cancelled", interrupted: "interrupted",
});

class WorkerRegistryError extends Error {
  constructor(code, message) { super(message); this.name = "WorkerRegistryError"; this.code = code; }
}
function fail(code, message) { throw new WorkerRegistryError(code, message); }

function createWorkerRegistry({ now = Date.now } = {}) {
  const workers = new Map(); // workerRef -> mutable record
  let liveRef = null;        // the single non-terminal worker (one-lane)

  function viewOf(r) {
    return Object.freeze({
      ref: r.ref, claimRef: r.claimRef, state: r.state, version: r.version,
      exitCode: r.exitCode, signalName: r.signalName,
      outputNextSeq: r.outputNextSeq, outputEof: r.outputEof,
      startedAtMs: r.startedAtMs, finishedAtMs: r.finishedAtMs,
    });
  }

  // Record the kernel-observed child as a running worker (called by the work.start
  // handler with the launcher's { workerRef, claim.ref }). One live worker only.
  function observe({ workerRef, claimRef } = {}) {
    if (typeof workerRef !== "string" || !OPAQUE_RE.test(workerRef)) fail("INVALID_REQUEST", "workerRef must be an opaque ref");
    if (typeof claimRef !== "string" || !OPAQUE_RE.test(claimRef)) fail("INVALID_REQUEST", "claimRef must be an opaque ref");
    if (liveRef) fail("LANE_BUSY", "a live worker already exists (one-lane)");
    if (workers.has(workerRef)) fail("INVALID_REQUEST", "worker ref is already recorded");
    const t = now();
    const r = {
      ref: workerRef, claimRef, state: "running", version: 1,
      exitCode: null, signalName: null, outputNextSeq: 0, outputEof: false,
      startedAtMs: t, finishedAtMs: null,
    };
    workers.set(workerRef, r);
    liveRef = workerRef;
    return viewOf(r);
  }

  function get(workerRef) {
    const r = workers.get(workerRef);
    return r ? viewOf(r) : null;
  }

  function live() { return liveRef ? viewOf(workers.get(liveRef)) : null; }

  // Operator cancel: running/starting -> stopping, version bumped. This is the
  // teardown seam the O-class worker_cancel effect (cancelWorker) drives; the
  // physical TERM/KILL/reap is the recovery driver's job, recorded via complete().
  function beginCancel({ workerRef, expectedWorkerVersion, reasonCode } = {}) {
    const r = workers.get(workerRef);
    if (!r) fail("STALE_HANDLE", "no such worker");
    if (!Number.isSafeInteger(expectedWorkerVersion) || r.version !== expectedWorkerVersion) fail("STALE_VERSION", "worker version is stale");
    if (reasonCode !== "operator_cancel") fail("INVALID_REQUEST", "reasonCode must be operator_cancel");
    if (!CANCELLABLE.has(r.state)) fail("INVALID_TRANSITION", "only a live worker can be cancelled");
    r.state = "stopping";
    r.version += 1;
    return viewOf(r);
  }

  // Record the terminal outcome after reap (from the launcher's completeWorker /
  // recovery). Frees the lane. Terminal WorkerView carries finishedAtMs + eof.
  function complete({ workerRef, outcome, exitCode = null, signalName = null } = {}) {
    const r = workers.get(workerRef);
    if (!r) fail("STALE_HANDLE", "no such worker");
    if (!OUTCOME_STATE[outcome]) fail("INVALID_REQUEST", "outcome must be completed|failed|cancelled|interrupted");
    if (exitCode !== null && (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255)) fail("INVALID_REQUEST", "exitCode must be 0..255 or null");
    if (signalName !== null && !SIGNAL_RE.test(signalName)) fail("INVALID_REQUEST", "signalName is malformed");
    if (exitCode !== null && signalName !== null) fail("INVALID_REQUEST", "a worker exits by code or signal, not both");
    r.state = OUTCOME_STATE[outcome];
    r.version += 1;
    r.finishedAtMs = now();
    r.outputEof = true;
    r.exitCode = exitCode;
    r.signalName = signalName;
    if (liveRef === workerRef) liveRef = null;
    return viewOf(r);
  }

  return Object.freeze({ observe, get, live, beginCancel, complete });
}

module.exports = { createWorkerRegistry, WorkerRegistryError };
