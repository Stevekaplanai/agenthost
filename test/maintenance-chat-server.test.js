// Chat-server tests. The request→stream→exit→cleanup LOGIC is driven through
// _handleConnection with a MOCK socket (an EventEmitter), so it runs everywhere
// including the Windows dev box (which cannot bind a unix domain socket). One real
// unix-socket smoke test is skipped on win32 (Rule 10 — the socket bind itself is
// Linux-only and is box-verified). ESM.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import serverMod from "../container/maintenance-chat-server.js";
import runnerMod from "../container/maintenance-chat-runner.js";
import laneMod from "../container/maintenance-agent-lane.js";
const { createChatServer, encodeFrame, createFrameDecoder } = serverMod;
const { createChatRunner } = runnerMod;
const { createAgentLaneArbiter } = laneMod;

function clearLatch() {
  return { trip() {}, isQuarantined: () => false };
}

// Mock runner: records run/kill, exposes per-run emit for the test to drive.
function mockRunner() {
  const calls = { run: [], deliver: [], kill: [], ready: [] };
  const handles = new Map();
  return {
    calls, handles,
    run(args) { calls.run.push(args); handles.set(args.runId, { onOutput: args.onOutput, onExit: args.onExit }); return { runId: args.runId }; },
    deliver(args) { calls.deliver.push(args); handles.set(args.runId, { onOutput: args.onOutput, onExit: args.onExit }); return { runId: args.runId }; },
    kill(runId, sig) { calls.kill.push([runId, sig]); return true; },
    engineReady(engineId) { calls.ready.push(engineId); return true; },
    emitOut(runId, s, t) { handles.get(runId).onOutput(runId, s, t); },
    emitExit(runId, info) { handles.get(runId).onExit(runId, info); },
  };
}

// A mock socket: an EventEmitter that captures written frames (decoded) and can be
// fed inbound frames + a close event. Stands in for a real net.Socket.
function mockSocket() {
  const sock = new EventEmitter();
  sock.destroyed = false;
  sock.writtenRaw = [];
  const dec = createFrameDecoder();
  sock.frames = []; // server→client frames, decoded
  sock.write = (buf) => { sock.writtenRaw.push(buf); for (const f of dec.push(buf)) sock.frames.push(f); return true; };
  sock.destroy = () => { if (!sock.destroyed) { sock.destroyed = true; sock.emit("close"); } };
  // client → server
  sock.feed = (obj) => sock.emit("data", encodeFrame(obj));
  sock.feedRaw = (buf) => sock.emit("data", buf);
  return sock;
}

// Drive a connection through the server's handler with a mock socket.
function drive(server) {
  const sock = mockSocket();
  server._handleConnection(sock);
  return sock;
}

function containedRunnerDeps(children) {
  return {
    agentLaneArbiter: createAgentLaneArbiter(),
    launchContained: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = 8000 + children.length;
      child.exitCode = null;
      child.signalCode = null;
      child.kill = (signal) => { child.killedWith = signal; return true; };
      children.push(child);
      return {
        child,
        handlePid: child.pid,
        namespaceIdentity: Object.freeze({ pid: child.pid + 100, startTime: 1, bootId: "test-boot" }),
      };
    },
    proveGone: () => true,
    teardownContained: (handle) => { handle.child.killedWith = "SIGKILL"; },
  };
}

test("construction requires the shared root quarantine latch", () => {
  assert.throws(() => createChatServer({ runner: mockRunner() }), /quarantine latch/);
});

test("framing: encode/decode round-trips; partial chunks reassemble byte-by-byte", () => {
  const dec = createFrameDecoder();
  const all = Buffer.concat([encodeFrame({ t: "run", runId: "x" }), encodeFrame({ t: "out", runId: "x", stream: "stdout", text: "hi" })]);
  const got = [];
  for (const byte of all) got.push(...dec.push(Buffer.from([byte])));
  assert.deepEqual(got, [{ t: "run", runId: "x" }, { t: "out", runId: "x", stream: "stdout", text: "hi" }]);
});

test("run → stream → exit multiplexes by runId over one connection", () => {
  const runner = mockRunner();
  const server = createChatServer({ runner, agentLaneQuarantine: clearLatch() });
  const c = drive(server);
  c.feed({ t: "run", runId: "r1", engineId: "gemini", prompt: "hi" });
  c.feed({ t: "run", runId: "r2", engineId: "claude", prompt: "yo" });
  assert.equal(runner.calls.run.length, 2);
  runner.emitOut("r1", "stdout", "A1");
  runner.emitOut("r2", "stdout", "B1");
  runner.emitOut("r1", "stdout", "A2");
  runner.emitExit("r2", { exitCode: 0, signalName: null });
  runner.emitExit("r1", { exitCode: 0, signalName: null });
  assert.deepEqual(c.frames.filter((f) => f.t === "out"), [
    { t: "out", runId: "r1", stream: "stdout", text: "A1" },
    { t: "out", runId: "r2", stream: "stdout", text: "B1" },
    { t: "out", runId: "r1", stream: "stdout", text: "A2" },
  ]);
  // JSON.stringify omits undefined keys, so a clean exit frame has no `error` key.
  assert.deepEqual(c.frames.filter((f) => f.t === "exit"), [
    { t: "exit", runId: "r2", exitCode: 0, signalName: null },
    { t: "exit", runId: "r1", exitCode: 0, signalName: null },
  ]);
});

test("SECURITY: delivery frames carry data, never caller execution authority", () => {
  const runner = mockRunner();
  const c = drive(createChatServer({ runner, agentLaneQuarantine: clearLatch() }));
  c.feed({
    t: "delivery",
    runId: "delivery-1",
    channel: "discord",
    target: "user:123",
    message: "hello",
    uid: 999,
    bin: "/bin/sh",
    argv: ["-c", "id"],
    env: { GIT_PUSH_TOKEN: "caller-choice" },
  });
  assert.equal(runner.calls.deliver.length, 1);
  assert.deepEqual(Object.keys(runner.calls.deliver[0]).sort(), [
    "channel", "message", "onExit", "onOutput", "runId", "target",
  ].sort());
  assert.deepEqual(
    {
      runId: runner.calls.deliver[0].runId,
      channel: runner.calls.deliver[0].channel,
      target: runner.calls.deliver[0].target,
      message: runner.calls.deliver[0].message,
    },
    { runId: "delivery-1", channel: "discord", target: "user:123", message: "hello" },
  );
});

test("kill frame forwards to runner", () => {
  const runner = mockRunner();
  const c = drive(createChatServer({ runner, agentLaneQuarantine: clearLatch() }));
  c.feed({ t: "run", runId: "r1", engineId: "gemini", prompt: "hi" });
  c.feed({ t: "kill", runId: "r1", signal: "SIGTERM" });
  assert.deepEqual(runner.calls.kill, [["r1", "SIGTERM"]]);
});

test("connection drop SIGKILLs every run that connection started (no orphans)", () => {
  const runner = mockRunner();
  const c = drive(createChatServer({ runner, agentLaneQuarantine: clearLatch() }));
  c.feed({ t: "run", runId: "r1", engineId: "gemini", prompt: "hi" });
  c.feed({ t: "run", runId: "r2", engineId: "claude", prompt: "yo" });
  // a run that already exited must NOT be re-killed on drop
  runner.emitExit("r2", { exitCode: 0, signalName: null });
  c.destroy(); // gate drops
  const killed = runner.calls.kill.map((k) => k[0]).sort();
  assert.deepEqual(killed, ["r1"], "only the still-active run is SIGKILLed on drop");
  assert.ok(runner.calls.kill.every((k) => k[1] === "SIGKILL"));
});

test("active connection loss trips the root latch before killing the child", () => {
  const events = [];
  const runner = mockRunner();
  runner.kill = (runId, signal) => { events.push(["kill", runId, signal]); return true; };
  const latch = {
    isQuarantined: () => false,
    trip: (reason) => events.push(["trip", reason]),
  };
  const c = drive(createChatServer({ runner, agentLaneQuarantine: latch }));
  c.feed({ t: "run", runId: "r1", engineId: "gemini", prompt: "hi" });
  c.destroy();
  assert.equal(events[0][0], "trip", "root quarantine is monotonic before any best-effort kill");
  assert.deepEqual(events[1], ["kill", "r1", "SIGKILL"]);
});

test("the authenticated quarantine frame trips root and has no clear or caller-supplied reason", () => {
  const runner = mockRunner();
  const reasons = [];
  const latch = {
    isQuarantined: () => reasons.length > 0,
    trip: (reason) => { reasons.push(reason); },
  };
  const c = drive(createChatServer({ runner, agentLaneQuarantine: latch }));
  c.feed({ t: "quarantine", reason: "caller-controlled text must be ignored" });
  assert.deepEqual(reasons, ["gate_reported_unproven_agent_termination"]);
  assert.ok(c.frames.some((f) => f.t === "quarantine_ack" && f.quarantined === true));
});

test("only the exact fatal-containment frame starts one controlled restart", () => {
  const runner = mockRunner();
  const reasons = [];
  let restarts = 0;
  const latch = {
    isQuarantined: () => reasons.length > 0,
    trip: (reason) => { reasons.push(reason); },
  };
  const c = drive(createChatServer({
    runner,
    agentLaneQuarantine: latch,
    fatalContainment: () => { restarts += 1; },
  }));
  c.feed({ t: "fatal_containment", reason: "caller text is forbidden" });
  assert.equal(restarts, 0, "extra caller-controlled fields must reject the restart verb");
  c.feed({ t: "fatal_containment" });
  c.feed({ t: "fatal_containment" });
  assert.equal(restarts, 1, "the fatal restart fuse is monotonic for this boot");
  assert.deepEqual(reasons, ["gate_reported_fatal_git_containment"]);
  assert.ok(c.frames.some((f) => f.t === "fatal_containment_ack" && f.restarting === true));
});

test("a tripped root latch refuses run and readiness without touching the runner", () => {
  const runner = mockRunner();
  const latch = { isQuarantined: () => true, trip() {} };
  const c = drive(createChatServer({ runner, agentLaneQuarantine: latch }));
  c.feed({ t: "run", runId: "r1", engineId: "gemini", prompt: "hi" });
  c.feed({ t: "ready", engineId: "gemini" });
  assert.equal(runner.calls.run.length, 0);
  assert.equal(runner.calls.ready.length, 0);
  assert.ok(c.frames.some((f) => f.t === "exit" && f.runId === "r1" && f.error === "agent_lane_quarantined"));
  assert.ok(c.frames.some((f) => f.t === "ready" && f.engineId === "gemini" && f.ready === false));
});

test("chat and Assist quarantine refuse only their own lane", () => {
  const runner = mockRunner();
  const shared = { isQuarantined: () => true, trip() {} };
  const assist = { isQuarantined: () => false, trip() {} };
  const c = drive(createChatServer({
    runner,
    agentLaneQuarantine: shared,
    assistLaneQuarantine: assist,
  }));
  c.feed({ t: "run", runId: "chat-blocked", engineId: "claude", prompt: "chat" });
  c.feed({ t: "run", runId: "assist-live", engineId: "claude-assist", prompt: "draft" });
  assert.deepEqual(runner.calls.run.map((call) => call.runId), ["assist-live"]);
  assert.ok(c.frames.some((f) => f.t === "exit" && f.runId === "chat-blocked" && f.error === "agent_lane_quarantined"));

  const reverseRunner = mockRunner();
  const reverse = drive(createChatServer({
    runner: reverseRunner,
    agentLaneQuarantine: { isQuarantined: () => false, trip() {} },
    assistLaneQuarantine: { isQuarantined: () => true, trip() {} },
  }));
  reverse.feed({ t: "run", runId: "chat-live", engineId: "claude", prompt: "chat" });
  reverse.feed({ t: "run", runId: "assist-blocked", engineId: "claude-assist", prompt: "draft" });
  assert.deepEqual(reverseRunner.calls.run.map((call) => call.runId), ["chat-live"]);
  assert.ok(reverse.frames.some((f) => f.t === "exit" && f.runId === "assist-blocked" && f.error === "agent_lane_quarantined"));
});

test("connection loss quarantines and proves chat and Assist children independently", () => {
  const runner = mockRunner();
  const sharedReasons = [];
  const assistReasons = [];
  const latch = (reasons) => ({
    isQuarantined: () => false,
    trip(reason) { reasons.push(reason); return { reason }; },
    clearOnProof() { return false; },
  });
  const c = drive(createChatServer({
    runner,
    agentLaneQuarantine: latch(sharedReasons),
    assistLaneQuarantine: latch(assistReasons),
    proveGone: () => false,
    terminationProofAttempts: 1,
  }));
  c.feed({ t: "run", runId: "chat-child", engineId: "claude", prompt: "chat" });
  c.feed({ t: "run", runId: "assist-child", engineId: "claude-assist", prompt: "draft" });
  c.destroy();
  assert.equal(sharedReasons[0], "chat_connection_lost_with_active_run");
  assert.equal(assistReasons[0], "assist_connection_lost_with_active_run");
  assert.match(sharedReasons[1], /chat-child/);
  assert.doesNotMatch(sharedReasons[1], /assist-child/);
  assert.match(assistReasons[1], /assist-child/);
  assert.doesNotMatch(assistReasons[1], /chat-child/);
  assert.deepEqual(runner.calls.kill.sort(), [
    ["assist-child", "SIGKILL"],
    ["chat-child", "SIGKILL"],
  ]);
});

test("two authenticated sockets still share one root-global heavyweight lane", () => {
  const children = [];
  const runner = createChatRunner({
    profiles: {
      gemini: {
        bin: "gemini",
        cwd: "/tmp",
        stdin: "ignore",
        argvTemplate: ["-p", "{prompt}"],
        envAllowlist: [],
        credentialNames: [],
      },
    },
    secretsPath: "/x",
    withCharter: (s) => s,
    ...containedRunnerDeps(children),
  });
  const server = createChatServer({ runner, agentLaneQuarantine: clearLatch() });
  const firstGate = drive(server);
  const replacementGate = drive(server);
  firstGate.feed({ t: "run", runId: "r1", engineId: "gemini", prompt: "first" });
  replacementGate.feed({ t: "run", runId: "r2", engineId: "gemini", prompt: "second" });
  assert.equal(children.length, 1);
  assert.ok(replacementGate.frames.some((f) => f.t === "exit" && f.runId === "r2" && f.error === "agent_lane_busy"));

  firstGate.destroy();
  replacementGate.feed({ t: "run", runId: "r3", engineId: "gemini", prompt: "still blocked" });
  assert.equal(children.length, 1, "socket loss and its SIGKILL do not release admission before close");
  assert.ok(replacementGate.frames.some((f) => f.t === "exit" && f.runId === "r3" && f.error === "agent_lane_busy"));
  children[0].emit("close", null, "SIGKILL");

  replacementGate.feed({ t: "run", runId: "r4", engineId: "gemini", prompt: "after close" });
  assert.equal(children.length, 2);
});

test("a malformed prompt-stdin profile returns a named exit instead of escaping the socket handler", () => {
  const children = [];
  const runner = createChatRunner({
    profiles: {
      "claude-brand-dna": {
        engineId: "claude-brand-dna",
        bin: "claude",
        cwd: "/tmp",
        stdin: "prompt",
        promptSentinel: "{prompt}",
        argvTemplate: ["-p", "{prompt}"],
        envAllowlist: [],
        credentialNames: [],
      },
    },
    secretsPath: "/x",
    withCharter: (s) => s,
    ...containedRunnerDeps(children),
  });
  const c = drive(createChatServer({ runner, agentLaneQuarantine: clearLatch() }));

  assert.doesNotThrow(() => c.feed({
    t: "run", runId: "brand-dna-bad-profile", engineId: "claude-brand-dna", prompt: "site copy",
  }));
  assert.equal(children.length, 0, "an invalid profile must not reach containment launch");
  assert.ok(c.frames.some((frame) => frame.t === "exit"
    && frame.runId === "brand-dna-bad-profile"
    && /prompt_stdin_profile_invalid: argv template contains a prompt sentinel/.test(frame.error)),
  "the broker must return the profile cause in its normal terminal frame");
});

test("a duplicate live runId cannot emit a fake terminal event for the owner", () => {
  const children = [];
  const trips = [];
  const runner = createChatRunner({
    profiles: {
      gemini: {
        bin: "gemini",
        cwd: "/tmp",
        stdin: "ignore",
        argvTemplate: ["-p", "{prompt}"],
        envAllowlist: [],
        credentialNames: [],
      },
    },
    secretsPath: "/x",
    withCharter: (s) => s,
    ...containedRunnerDeps(children),
  });
  const latch = {
    trip: (reason) => trips.push(reason),
    isQuarantined: () => false,
  };
  const server = createChatServer({ runner, agentLaneQuarantine: latch });
  const owner = drive(server);
  const duplicate = drive(server);
  owner.feed({ t: "run", runId: "same", engineId: "gemini", prompt: "owner" });
  duplicate.feed({ t: "run", runId: "same", engineId: "gemini", prompt: "duplicate" });

  assert.equal(duplicate.destroyed, true);
  assert.deepEqual(trips, ["duplicate_run_id_on_active_lane"]);
  assert.equal(runner.activeCount(), 1, "the original child remains owned until its actual close");
  assert.equal(owner.frames.some((f) => f.t === "exit" && f.runId === "same"), false);
  assert.equal(duplicate.frames.some((f) => f.t === "exit" && f.runId === "same"), false,
    "the duplicate cannot impersonate the original terminal event");

  children[0].emit("close", 0, null);
  assert.equal(runner.activeCount(), 0);
  assert.ok(owner.frames.some((f) => f.t === "exit" && f.runId === "same" && f.exitCode === 0));
});

test("SECURITY: peer with wrong uid is rejected — no run dispatches", () => {
  const runner = mockRunner();
  const server = createChatServer({ runner, gateUid: 999, peerUid: () => 1001, agentLaneQuarantine: clearLatch() });
  const c = drive(server);
  c.feed({ t: "run", runId: "r1", engineId: "gemini", prompt: "x" });
  assert.equal(runner.calls.run.length, 0, "wrong-uid peer must not dispatch");
  assert.equal(c.destroyed, true, "wrong-uid connection is destroyed");
});

test("SECURITY: a matching gate uid IS accepted", () => {
  const runner = mockRunner();
  const c = drive(createChatServer({ runner, gateUid: 999, peerUid: () => 999, agentLaneQuarantine: clearLatch() }));
  c.feed({ t: "run", runId: "r1", engineId: "gemini", prompt: "x" });
  assert.equal(runner.calls.run.length, 1);
});

test("SECURITY: unknown peer uid (probe null) falls back to socket-mode gating, still accepts", () => {
  const runner = mockRunner();
  const c = drive(createChatServer({ runner, gateUid: 999, peerUid: () => null, agentLaneQuarantine: clearLatch() }));
  c.feed({ t: "run", runId: "r1", engineId: "gemini", prompt: "x" });
  assert.equal(runner.calls.run.length, 1, "null probe defers to the 0660 root:gate socket mode");
});

test("bad request (missing runId/engineId) returns exit error, spawns nothing", () => {
  const runner = mockRunner();
  const c = drive(createChatServer({ runner, agentLaneQuarantine: clearLatch() }));
  c.feed({ t: "run", engineId: "gemini" }); // no runId
  assert.equal(runner.calls.run.length, 0);
  assert.ok(c.frames.some((f) => f.t === "exit" && f.error === "bad_request"));
});

test("oversize frame drops the connection (memory-safety)", () => {
  const runner = mockRunner();
  const c = drive(createChatServer({ runner, agentLaneQuarantine: clearLatch() }));
  const head = Buffer.allocUnsafe(4); head.writeUInt32BE(5 * 1024 * 1024, 0);
  c.feedRaw(head);
  assert.equal(c.destroyed, true, "oversize length header drops the connection");
  assert.equal(runner.calls.run.length, 0);
});

test("malformed JSON frame drops the connection", () => {
  const runner = mockRunner();
  const c = drive(createChatServer({ runner, agentLaneQuarantine: clearLatch() }));
  const body = Buffer.from("{not json");
  const head = Buffer.allocUnsafe(4); head.writeUInt32BE(body.length, 0);
  c.feedRaw(Buffer.concat([head, body]));
  assert.equal(c.destroyed, true);
});

// Real unix-socket bind is Linux-only — box-verified there, skipped on the Windows dev box.
test("real unix socket listen + connect (linux only)", { skip: process.platform === "win32" }, async () => {
  const net = await import("node:net");
  const os = await import("node:os");
  const path = await import("node:path");
  const runner = mockRunner();
  const sock = path.join(os.tmpdir(), `chat-real-${process.pid}.sock`);
  const server = createChatServer({ runner, socketPath: sock, agentLaneQuarantine: clearLatch() });
  await server.listen();
  await new Promise((resolve, reject) => {
    const client = net.connect(sock);
    client.once("connect", () => { client.write(encodeFrame({ t: "run", runId: "r1", engineId: "gemini", prompt: "hi" })); setTimeout(() => { client.destroy(); resolve(); }, 30); });
    client.once("error", reject);
  });
  assert.equal(runner.calls.run.length, 1);
  server.close();
});

test("an unknown frame type is refused OUT LOUD, not dropped in silence", () => {
  // The dispatch chain handled six types and had no else. A frame with any other
  // `t` fell off the end silently: the gate saw a successful write, root did
  // nothing, and the caller waited for a reply that was never coming.
  //
  // Live cost, 2026-08-10. PR #338 ("codex authors AS AGENT") shipped a gate that
  // sends { t: "autonomous", worktree }. Root has no such handler. Merged, codex
  // would have failed with the SAME error as before, and the obvious reading would
  // have been that the CODEX_HOME diagnosis was wrong -- when it was right and only
  // half the fix existed. A protocol whose unknown verbs are silent makes every
  // half-built feature look like a wrong theory.
  const runner = mockRunner();
  const c = drive(createChatServer({ runner, agentLaneQuarantine: clearLatch() }));

  // NOT "autonomous". This test was written while that verb was unimplemented and
  // used it as the specimen of an unknown frame -- correctly, at the time. Root
  // now HANDLES it (the autonomous arm, chat-server ~line 155), so the specimen
  // became a real verb and the test began asserting that a supported frame is
  // refused. The property here is worth keeping and has nothing to do with which
  // verb is unimplemented today, so the specimen must be one that can never
  // become real.
  c.feed({ t: "no-such-verb", worktree: "/data/home/agent/wt" });

  const reply = c.frames.find((f) => f.t === "unsupported");
  assert.ok(reply, "an unhandled frame MUST produce a reply -- silence is the defect");
  assert.equal(reply.error, "unsupported_frame_type");
  assert.equal(reply.requested, "no-such-verb",
    "echo which frame was refused, or the caller cannot tell WHICH of its sends vanished");

  // Refusing must not be a side door: root replies, it does not act.
  assert.equal(c.frames.filter((f) => f.t === "exit").length, 0,
    "an unsupported frame must not start or terminate a run");
  assert.equal(c.destroyed, false, "and must not tear down the connection");
});
