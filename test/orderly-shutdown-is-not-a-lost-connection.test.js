// "A planned SIGTERM that checkpoints its work is not a lost connection."
// (Steve, 2026-08-11.)
//
// Measured on the box that day: the gate went down at 12:43:00 with a run in
// flight, root's socket cleanup latched the shared agent lane, and the latch had
// no clear -- so every engine answered ready:false until the machine was
// restarted. `claude` has no readiness check and returns true by default, which
// is the proof it was never about credentials. The gate restarts on every
// deploy, so every deploy with active work was a permanent kill of autonomous
// dispatch.
//
// These tests pin the fix and, just as importantly, pin what the fix must NOT
// become. The lane may reopen only on termination proof that ROOT gathered.
// Believing the gate when it says it shut down cleanly would trade a false
// positive for a real hole -- the hazard was never "the connection dropped", it
// is an orphaned agent-uid engine still running unsupervised.
//
// Behavioural throughout: everything goes through the real arbiter and the real
// server connection handler, driven by mock sockets. ESM.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createChatServer, encodeFrame, createFrameDecoder } = require("../container/maintenance-chat-server.js");
const { createAgentLaneArbiter } = require("../container/maintenance-agent-lane.js");

// A mock socket: an EventEmitter that decodes what the server writes and can be
// fed inbound frames plus a close. Stands in for a real net.Socket.
function mockSocket() {
  const sock = new EventEmitter();
  sock.destroyed = false;
  const dec = createFrameDecoder();
  sock.frames = [];
  sock.write = (buf) => { for (const f of dec.push(buf)) sock.frames.push(f); return true; };
  sock.destroy = () => { if (!sock.destroyed) { sock.destroyed = true; sock.emit("close"); } };
  sock.feed = (obj) => sock.emit("data", encodeFrame(obj));
  return sock;
}

// A runner that launches nothing. Each run gets a distinct observed identity, as
// the real contained launch does, so the server has something to prove against.
function mockRunner() {
  const killed = [];
  const identities = new Map();
  let next = 9000;
  return {
    killed,
    identities,
    run({ runId }) {
      identities.set(runId, Object.freeze({ pid: (next += 2), startTime: 11, bootId: "test-boot" }));
      return { runId, accepted: true };
    },
    kill(runId, signal) { killed.push([runId, signal]); return true; },
    childIdentity(runId) { return identities.get(runId) || null; },
    engineReady() { return true; },
    runAutonomous({ runId }) { return this.run({ runId }); },
    deliver({ runId }) { return this.run({ runId }); },
  };
}

// A hand-cranked timer queue: the proof loop retries on a timer, and a test that
// slept for real would be slow and flaky. `drain` runs whatever is pending until
// the loop settles.
function manualTimers() {
  const queue = [];
  return {
    setTimer(fn) { queue.push(fn); return { unref() {} }; },
    drain(limit = 50) {
      let ran = 0;
      while (queue.length > 0 && ran < limit) { queue.shift()(); ran += 1; }
      return ran;
    },
  };
}

// The real arbiter, with every clearOnProof call recorded. A test that wants to
// prove the gate CANNOT clear needs to see attempts, not just outcomes.
function spyingArbiter(options) {
  const arbiter = createAgentLaneArbiter(options);
  const clearAttempts = [];
  return {
    ...arbiter,
    clearAttempts,
    clearOnProof(latch) {
      const released = arbiter.clearOnProof(latch);
      clearAttempts.push({ latch, released });
      return released;
    },
  };
}

function startedConnection(server) {
  const sock = mockSocket();
  server._handleConnection(sock);
  return sock;
}

test("an orderly close whose children are all provably gone reopens the lane", () => {
  const runner = mockRunner();
  const timers = manualTimers();
  const lane = createAgentLaneArbiter();
  const proved = [];
  const server = createChatServer({
    runner,
    agentLaneQuarantine: lane,
    proveGone: (identity) => { proved.push(identity.pid); return true; },
    setTimer: timers.setTimer,
  });

  const gate = startedConnection(server);
  gate.feed({ t: "run", runId: "r1", engineId: "gemini", prompt: "one" });
  gate.feed({ t: "run", runId: "r2", engineId: "claude", prompt: "two" });
  assert.equal(lane.isQuarantined(), false);

  gate.destroy(); // the deploy's SIGTERM reaches the gate

  assert.deepEqual(
    runner.killed.map((k) => k[0]).sort(),
    ["r1", "r2"],
    "a lost gate must still not orphan agent-uid engines",
  );
  assert.deepEqual(proved.sort(), [9002, 9004], "root proved each child it killed, by observed identity");
  assert.equal(lane.isQuarantined(), false, "every child is provably gone, so the lane reopens");
  assert.deepEqual(lane.heldReasons(), []);
  assert.equal(timers.drain(), 0, "nothing is left waiting once the proof succeeded");
});

test("the lane is latched BEFORE any signal is sent, and only a proof takes it back off", () => {
  const order = [];
  const runner = mockRunner();
  const realKill = runner.kill.bind(runner);
  runner.kill = (runId, signal) => { order.push(["kill", runId]); return realKill(runId, signal); };
  const lane = createAgentLaneArbiter({
    record: (reason) => order.push(["trip", reason]),
    recordClear: (reason) => order.push(["clear", reason]),
  });
  const server = createChatServer({
    runner,
    agentLaneQuarantine: lane,
    proveGone: () => true,
    setTimer: manualTimers().setTimer,
  });

  const gate = startedConnection(server);
  gate.feed({ t: "run", runId: "r1", engineId: "gemini", prompt: "hi" });
  gate.destroy();

  assert.deepEqual(order, [
    ["trip", "chat_connection_lost_with_active_run"],
    ["kill", "r1"],
    ["clear", "chat_connection_lost_with_active_run"],
  ], "fail closed first, kill second, reopen only after the proof");
});

test("a close where one child cannot be proven gone leaves the lane shut, naming that run", () => {
  const runner = mockRunner();
  const timers = manualTimers();
  const lane = createAgentLaneArbiter();
  const server = createChatServer({
    runner,
    agentLaneQuarantine: lane,
    // r_gone dies; r_stuck is still alive at every check.
    proveGone: (identity) => identity.pid === 9002,
    setTimer: timers.setTimer,
    terminationProofAttempts: 3,
  });

  const gate = startedConnection(server);
  gate.feed({ t: "run", runId: "r_gone", engineId: "gemini", prompt: "one" });
  gate.feed({ t: "run", runId: "r_stuck", engineId: "claude", prompt: "two" });
  gate.destroy();

  assert.equal(lane.isQuarantined(), true, "one unproven child holds the whole lane shut");
  timers.drain();
  assert.equal(lane.isQuarantined(), true, "running out of attempts is not proof of anything");

  const reason = lane.view().reason;
  assert.match(reason, /r_stuck/, "the reason names the run that could not be accounted for");
  assert.doesNotMatch(reason, /r_gone/, "a child that was proven gone is not blamed");
  assert.match(reason, /still alive/, "and says what actually failed, not just that something did");
});

test("an unreadable /proc is not permission to reopen, and the reason carries what it said", () => {
  const runner = mockRunner();
  const timers = manualTimers();
  const lane = createAgentLaneArbiter();
  const server = createChatServer({
    runner,
    agentLaneQuarantine: lane,
    proveGone: () => { throw Object.assign(new Error("EPERM reading /proc/9002/stat"), { code: "EPERM" }); },
    setTimer: timers.setTimer,
    terminationProofAttempts: 2,
  });

  const gate = startedConnection(server);
  gate.feed({ t: "run", runId: "r_opaque", engineId: "gemini", prompt: "x" });
  gate.destroy();
  timers.drain();

  assert.equal(lane.isQuarantined(), true, "ambiguity fails closed");
  assert.match(lane.view().reason, /r_opaque/);
  assert.match(lane.view().reason, /EPERM reading \/proc\/9002\/stat/, "the cause comes from the thing that failed");
});

test("a runner that cannot produce an identity leaves the lane shut and says so", () => {
  const runner = mockRunner();
  runner.childIdentity = () => null; // e.g. the run already settled unproven
  const timers = manualTimers();
  const lane = createAgentLaneArbiter();
  const server = createChatServer({
    runner,
    agentLaneQuarantine: lane,
    proveGone: () => { throw new Error("proveGone must never be reached without an identity"); },
    setTimer: timers.setTimer,
    terminationProofAttempts: 2,
  });

  const gate = startedConnection(server);
  gate.feed({ t: "run", runId: "r_unobserved", engineId: "gemini", prompt: "x" });
  gate.destroy();
  timers.drain();

  assert.equal(lane.isQuarantined(), true);
  assert.match(lane.view().reason, /r_unobserved/);
  assert.match(lane.view().reason, /no longer held an observed identity/);
});

test("a close with no active runs does not trip at all", () => {
  const runner = mockRunner();
  const lane = createAgentLaneArbiter({ record: () => assert.fail("an idle close must never latch the lane") });
  const server = createChatServer({
    runner,
    agentLaneQuarantine: lane,
    proveGone: () => assert.fail("there is nothing to prove"),
    setTimer: manualTimers().setTimer,
  });

  const gate = startedConnection(server);
  gate.feed({ t: "ready", engineId: "gemini" });
  gate.destroy();

  assert.equal(lane.isQuarantined(), false);
  assert.deepEqual(runner.killed, []);
});

test("SECURITY: no socket frame the server handles can clear the quarantine", () => {
  const runner = mockRunner();
  const timers = manualTimers();
  const lane = spyingArbiter();
  let restarts = 0;
  const server = createChatServer({
    runner,
    agentLaneQuarantine: lane,
    proveGone: () => false, // nothing is ever provably gone in this test
    setTimer: timers.setTimer,
    terminationProofAttempts: 2,
    fatalContainment: () => { restarts += 1; },
  });

  // Latch the lane the way a gate restart does, and exhaust the proof.
  const first = startedConnection(server);
  first.feed({ t: "run", runId: "r1", engineId: "gemini", prompt: "x" });
  first.destroy();
  timers.drain();
  assert.equal(lane.isQuarantined(), true);
  const attemptsBefore = lane.clearAttempts.length;

  // Now try to talk the lane open over the socket. Every frame type the server
  // handles, plus shapes that carry things that LOOK like a latch: the reason
  // string, a lookalike object, and the view's own contents. None of it is the
  // object identity clearOnProof requires, and no handler calls it at all.
  const gate = startedConnection(server);
  const forgeries = [
    { quarantined: true, reason: "chat_connection_lost_with_active_run" },
    "chat_connection_lost_with_active_run",
    lane.view().reason,
    { ...lane.view() },
    null,
    0,
  ];
  const frames = [
    { t: "run", runId: "r2", engineId: "gemini", prompt: "x" },
    { t: "autonomous", runId: "r3", engineId: "codex", prompt: "x", worktree: "/data/home/agent/workspaces/w" },
    { t: "delivery", runId: "r4", channel: "telegram", target: "@x", message: "hi" },
    { t: "kill", runId: "r1" },
    { t: "ready", engineId: "gemini" },
    { t: "quarantine" },
    { t: "fatal_containment" },
    { t: "clear" },
    { t: "clearOnProof" },
    { t: "unquarantine" },
  ];
  for (const frame of frames) {
    gate.feed(frame);
    for (const forged of forgeries) {
      gate.feed({ ...frame, latch: forged, clear: forged, proof: forged, clearOnProof: forged });
    }
  }
  timers.drain();

  assert.equal(lane.isQuarantined(), true, "the gate cannot talk its way out of the lane it closed");
  assert.equal(
    lane.clearAttempts.length,
    attemptsBefore,
    "no frame handler even reaches the clear -- it is not on the wire at all",
  );
  assert.ok(
    gate.frames.some((f) => f.t === "unsupported" && f.requested === "clear"),
    "an unknown verb is refused out loud rather than vanishing",
  );
  assert.equal(restarts, 1, "the one real restart fuse still works, and it TRIPS rather than clears");
  assert.ok(lane.heldReasons().includes("gate_reported_fatal_git_containment"));
});

test("a termination proof cannot reopen a lane latched for an unrelated reason", () => {
  // Direction A: the unrelated reason is latched FIRST.
  {
    const runner = mockRunner();
    const timers = manualTimers();
    const lane = createAgentLaneArbiter();
    const server = createChatServer({
      runner,
      agentLaneQuarantine: lane,
      proveGone: () => true,
      setTimer: timers.setTimer,
    });
    lane.trip("authority_gate_loss");

    const gate = startedConnection(server);
    gate.feed({ t: "run", runId: "r1", engineId: "gemini", prompt: "x" });
    gate.destroy();
    timers.drain();

    assert.equal(lane.isQuarantined(), true, "proving a child gone says nothing about the authority gate");
    assert.deepEqual(lane.heldReasons(), ["authority_gate_loss"]);
  }

  // Direction B -- the one first-trip-wins could never survive: the unrelated
  // reason is latched AFTER the connection loss. Under the old monotonic latch
  // this trip was swallowed as a no-op and the connection's proof cleared the
  // lane outright, silently discarding a duplicate-runId safety trip.
  {
    const runner = mockRunner();
    const timers = manualTimers();
    const lane = createAgentLaneArbiter();
    let allowProof = false;
    const server = createChatServer({
      runner,
      agentLaneQuarantine: lane,
      proveGone: () => allowProof,
      setTimer: timers.setTimer,
      terminationProofAttempts: 10,
    });

    const gate = startedConnection(server);
    gate.feed({ t: "run", runId: "r1", engineId: "gemini", prompt: "x" });
    gate.destroy();
    assert.deepEqual(lane.heldReasons(), ["chat_connection_lost_with_active_run"]);

    lane.trip("duplicate_run_id_on_active_lane");
    allowProof = true;
    timers.drain();

    assert.deepEqual(
      lane.heldReasons(),
      ["duplicate_run_id_on_active_lane"],
      "the connection's own latch is released; the unrelated one is untouched",
    );
    assert.equal(lane.isQuarantined(), true);
  }
});

test("clearing is idempotent: a second proof cannot release a latch twice", () => {
  const lane = createAgentLaneArbiter();
  const connectionLatch = lane.trip("chat_connection_lost_with_active_run");
  assert.equal(lane.clearOnProof(connectionLatch), true);
  assert.equal(lane.isQuarantined(), false);

  // A later, unrelated closure must not be undone by re-presenting the old latch.
  lane.trip("authority_gate_loss");
  assert.equal(lane.clearOnProof(connectionLatch), false, "a spent latch releases nothing");
  assert.equal(lane.isQuarantined(), true);
  assert.deepEqual(lane.heldReasons(), ["authority_gate_loss"]);
});

test("the lane a proof reopened accepts work again, and a second gate can dispatch", () => {
  const runner = mockRunner();
  const timers = manualTimers();
  const lane = createAgentLaneArbiter();
  const server = createChatServer({
    runner,
    agentLaneQuarantine: lane,
    proveGone: () => true,
    setTimer: timers.setTimer,
  });

  const dying = startedConnection(server);
  dying.feed({ t: "run", runId: "r1", engineId: "gemini", prompt: "x" });
  dying.destroy();

  // The replacement gate that a deploy brings up. Before this fix its every
  // request came back agent_lane_quarantined until the container restarted.
  const replacement = startedConnection(server);
  replacement.feed({ t: "run", runId: "r2", engineId: "gemini", prompt: "after the deploy" });
  replacement.feed({ t: "ready", engineId: "claude" });

  assert.equal(
    replacement.frames.some((f) => f.t === "exit" && f.error === "agent_lane_quarantined"),
    false,
    "a deploy must not leave dispatch dead",
  );
  assert.ok(replacement.frames.some((f) => f.t === "ready" && f.engineId === "claude" && f.ready === true));
});
