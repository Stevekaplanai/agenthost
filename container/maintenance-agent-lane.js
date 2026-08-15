"use strict";

// Root-owned, boot-scoped admission + quarantine for every heavyweight agent
// process. One opaque lease spans spawn through terminal process-tree proof.
//
// QUARANTINE IS A SET OF LATCHES, NOT ONE MONOTONIC FLAG.
//
// Until 2026-08-11 this held a single `trippedView`: the first trip won, every
// later trip was silently dropped, and nothing could ever clear it -- only a
// container restart. That made the gate restarting while any run was active a
// permanent kill of all autonomous dispatch, because root's socket cleanup trips
// here on connection loss. Measured live: gateway_shutdown 12:43:00, then every
// engine answered ready:false until the machine was restarted.
//
// The fix has to add a clear, and the moment a clear exists first-trip-wins
// becomes actively dangerous:
//
//   - trip("authority_gate_loss") latches.
//   - trip("chat_connection_lost_with_active_run") is swallowed as a no-op.
//   - the connection's children are later proven gone, its clear runs, and the
//     AUTHORITY GATE LOSS -- an unrelated safety reason -- is cleared with it.
//
// So each trip now creates and returns its OWN latch. `isQuarantined()` is true
// while ANY latch is held, and a proof clears exactly the one latch it is a proof
// about. Seven call sites trip this; a proof about run termination must not
// reopen a lane closed for a reason it says nothing about.
//
// A latch is an object reference, deliberately: `clearOnProof` compares by
// IDENTITY, so the only caller who can clear a latch is the caller that received
// it from `trip()`. Nothing that arrives as data can forge one -- a JSON frame
// off the gate socket can carry any string, number or shape it likes and can
// never equal a live object. That is what keeps the gate from clearing the very
// quarantine its own disappearance created.
//
// `record` fires on every trip (each latch is now consequential -- none are
// dropped), `recordClear` on every clear that actually released a latch. Before
// this, the single most consequential state in the autonomy system could be
// entered through seven call sites that between them wrote NOTHING anywhere: on
// 2026-08-11 the operator-visible audit log's last `agent_lane_quarantined` entry
// was from two days earlier, because that event is written by the gate for the
// trips the GATE initiates and root's own trips were silent. Wired here rather
// than at the call sites deliberately: a rule that every future trip site must
// remember to log is a rule with an expiry date, and this one had already expired
// seven times over.
function createAgentLaneArbiter({ maxReasonBytes = 256, record = null, recordClear = null } = {}) {
  const limit = Number.isSafeInteger(maxReasonBytes) && maxReasonBytes > 0 ? maxReasonBytes : 256;
  const clearView = Object.freeze({ quarantined: false, reason: null });
  const latches = new Set(); // insertion-ordered; every member is an independent reason to stay closed
  let activeLease = null;
  let leaseSequence = 0;

  function boundedReason(value) {
    const raw = Buffer.from(String(value || "unspecified"), "utf8");
    if (raw.length <= limit) return raw.toString("utf8");
    let end = limit;
    while (end > 0 && (raw[end] & 0xc0) === 0x80) end -= 1;
    return raw.subarray(0, end).toString("utf8");
  }

  function trip(reason) {
    const latch = Object.freeze({ quarantined: true, reason: boundedReason(reason) });
    latches.add(latch);
    // Never allowed to throw: a broken recorder must not be able to stop the
    // latch from latching, or the observability fix becomes a safety hole.
    if (typeof record === "function") {
      try { record(latch.reason); } catch {}
    }
    return latch;
  }

  // Release ONE latch, and only for the holder of that latch. Returns false for
  // anything else -- an already-cleared latch, a latch from a different arbiter,
  // a lookalike object, or any value at all that came off a wire. Callers get a
  // boolean rather than a throw because a clear that finds nothing to clear is
  // the fail-closed outcome, not an error.
  function clearOnProof(latch) {
    if (!latches.delete(latch)) return false;
    if (typeof recordClear === "function") {
      // Pass the post-release state the ARBITER can actually see: is any other
      // latch still holding the lane? The recorder must not claim "dispatch is
      // possible again" while another reason still holds it -- that is the exact
      // Rule-16 lie this whole change exists to stop, and an earlier draft made
      // it (a proof about ONE connection's children was logged as the lane
      // reopening, even when it was being replaced by a stronger "termination
      // unproven" latch, or when an unrelated authority-loss latch still held).
      // The arbiter does NOT assert anything about child termination -- that is
      // the caller's fact, not the arbiter's, so it is deliberately not stated.
      try { recordClear(latch.reason, { stillQuarantined: latches.size > 0 }); } catch {}
    }
    return true;
  }

  function acquire(owner) {
    if (latches.size > 0 || activeLease) return null;
    const lease = Object.freeze({
      sequence: ++leaseSequence,
      owner: String(owner || "unspecified"),
    });
    activeLease = lease;
    return lease;
  }

  function release(lease) {
    if (!lease || activeLease !== lease) return false;
    activeLease = null;
    return true;
  }

  return Object.freeze({
    trip,
    clearOnProof,
    acquire,
    release,
    isBusy: () => activeLease !== null,
    isQuarantined: () => latches.size > 0,
    // The OLDEST held latch, preserving the previous first-trip-wins reporting.
    // Reasons are surfaced one at a time on purpose: the operator needs the
    // reason the lane closed, and a joined list of every latch reads as noise.
    view: () => (latches.size > 0 ? latches.values().next().value : clearView),
    heldReasons: () => Array.from(latches, (latch) => latch.reason),
  });
}

module.exports = { createAgentLaneArbiter };
