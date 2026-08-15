// The agent-lane quarantine is the single most consequential state in the
// autonomy system: no engine may run, and only a container restart undoes it.
// Until 2026-08-11 it could be entered through SEVEN root-side call sites that
// between them wrote NOTHING anywhere -- no audit line, no log, no journal.
//
// What that cost: the gate restarted at 12:43 with active work, root's socket
// cleanup latched the quarantine, and every engine on the box became
// undispatchable. The operator's audit log showed its newest
// `agent_lane_quarantined` entry from TWO DAYS EARLIER, because that event is
// written by the gate for the trips the GATE initiates. Root's were silent.
// Hours went into re-deriving a fact the system already had and discarded.
//
// The recorder is wired into trip() itself, not into the call sites, precisely
// so a future eighth trip site cannot forget it.
import test from "node:test";
import assert from "node:assert/strict";
import { createAgentLaneArbiter } from "../container/maintenance-agent-lane.js";

test("the latching trip is recorded, with its reason", () => {
  const seen = [];
  const lane = createAgentLaneArbiter({ record: (reason) => seen.push(reason) });
  lane.trip("chat_connection_lost_with_active_run");
  assert.deepEqual(seen, ["chat_connection_lost_with_active_run"],
    "the operator must be able to read WHICH of the seven paths fired");
  assert.equal(lane.isQuarantined(), true);
});

// This test previously asserted the OPPOSITE -- that only the first trip is
// recorded -- because the latch was monotonic and later trips were discarded
// entirely. That contract changed when the latch became a SET (each trip mints
// its own, cleared individually on proof), and this test correctly failed on the
// merge rather than silently passing against the wrong model.
//
// Under stacking, dropping later records would HIDE real latches: a lane held for
// three reasons would show one, and the operator would prove one hazard gone and
// not understand why dispatch stayed dead.
test("every trip is recorded, because under stacking every latch is separately consequential", () => {
  const seen = [];
  const lane = createAgentLaneArbiter({ record: (reason) => seen.push(reason) });
  lane.trip("chat_connection_lost_with_active_run");
  lane.trip("duplicate_run_id_on_active_lane");
  lane.trip("authority_gate_loss:whatever");
  assert.deepEqual(seen, [
    "chat_connection_lost_with_active_run",
    "duplicate_run_id_on_active_lane",
    "authority_gate_loss:whatever",
  ], "each latch holds the lane shut on its own, so each must be readable");
  assert.equal(lane.isQuarantined(), true);
});

test("a recorder that throws cannot stop the lane from latching", () => {
  // The observability fix must never become a safety hole: if writing the line
  // fails, the quarantine still has to happen.
  const lane = createAgentLaneArbiter({ record: () => { throw new Error("disk full"); } });
  assert.doesNotThrow(() => lane.trip("chat_connection_lost_with_active_run"));
  assert.equal(lane.isQuarantined(), true, "the latch is not conditional on being able to log it");
  assert.equal(lane.acquire("anyone"), null, "and a quarantined lane still refuses every lease");
});

test("no recorder at all is still valid, and still quarantines", () => {
  const lane = createAgentLaneArbiter();
  assert.doesNotThrow(() => lane.trip("chat_connection_lost_with_active_run"));
  assert.equal(lane.isQuarantined(), true);
});

test("the reason is bounded before it is recorded, never after", () => {
  // The reason can carry gate-supplied text (authority_gate_loss:<reason>), so
  // what reaches the audit log must already be the bounded form -- otherwise the
  // truncation that protects the latch does not protect the log.
  const seen = [];
  const lane = createAgentLaneArbiter({ maxReasonBytes: 16, record: (r) => seen.push(r) });
  lane.trip("x".repeat(500));
  assert.equal(seen[0].length, 16, "the recorder receives the bounded reason");
  assert.equal(seen[0], lane.view().reason, "and exactly what the latch itself kept");
});

// recordClear must state ONLY what the arbiter can see. The independent reviewer
// (Kimi/Moonshot) caught the recorder claiming "every child was proven gone, so
// dispatch is possible again" on every release -- false at the site where a
// connection-loss latch is REPLACED by a stronger "termination unproven" latch,
// and false under stacking whenever another latch still holds the lane. That is
// the exact Rule-16 lie the whole readiness change exists to stop, reproduced in
// its own recorder.
test("recordClear reports whether the lane is STILL held, and never claims proof it cannot see", () => {
  const cleared = [];
  const lane = createAgentLaneArbiter({ recordClear: (reason, info) => cleared.push({ reason, info }) });

  const a = lane.trip("chat_connection_lost_with_active_run");
  const b = lane.trip("authority_gate_loss:whatever");

  // Release ONE while another still holds the lane. The arbiter must tell the
  // recorder the lane is still quarantined, so the recorder cannot honestly say
  // "dispatch is possible again".
  lane.clearOnProof(a);
  assert.equal(cleared.length, 1);
  assert.equal(cleared[0].reason, "chat_connection_lost_with_active_run");
  assert.equal(cleared[0].info.stillQuarantined, true,
    "another latch holds the lane, so the release must NOT read as a reopen");
  assert.equal(lane.isQuarantined(), true);

  // Release the last one. Now, and only now, the lane is genuinely clear.
  lane.clearOnProof(b);
  assert.equal(cleared[1].info.stillQuarantined, false,
    "the last latch gone means the lane truly reopened");
  assert.equal(lane.isQuarantined(), false);
});
