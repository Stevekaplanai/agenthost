// Chat-client tests: the ChildProcess-shaped object gate.js's 5 call sites rely on.
// Drives the client against a mock socket (EventEmitter) so it runs everywhere. ESM.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import clientMod from "../container/maintenance-chat-client.js";
import serverMod from "../container/maintenance-chat-server.js";
const { runViaChatSocket, runChannelDeliveryViaChatSocket, tripRootAgentLaneQuarantine, requestRootFatalContainment } = clientMod;
const { encodeFrame, createFrameDecoder } = serverMod;

// A mock socket that captures the run frame the client sends and lets the test feed
// server→client frames back.
function mockSocket() {
  const s = new EventEmitter();
  s.destroyed = false;
  s.sent = []; // decoded frames the client wrote
  const dec = createFrameDecoder();
  s.write = (buf) => { for (const f of dec.push(buf)) s.sent.push(f); return true; };
  s.destroy = () => { if (!s.destroyed) { s.destroyed = true; s.emit("close"); } };
  s.feed = (obj) => s.emit("data", encodeFrame(obj));
  return s;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test("sends a run frame with the exact fields; NOTHING else (no argv/env/bin)", async () => {
  const s = mockSocket();
  const child = runViaChatSocket("gemini", "hello", { withContinue: false, sessionId: null, connect: () => s });
  s.emit("connect");
  await tick();
  assert.equal(s.sent.length, 1);
  const f = s.sent[0];
  assert.equal(f.t, "run");
  assert.equal(f.engineId, "gemini");
  assert.equal(f.prompt, "hello");
  assert.equal(f.withContinue, false);
  assert.equal(f.sessionId, null);
  // exactly these keys — gate supplies no argv, env, bin, or flag
  assert.deepEqual(Object.keys(f).sort(), ["engineId", "prompt", "runId", "sessionId", "t", "withContinue"].sort());
  assert.ok(typeof f.runId === "string" && f.runId.startsWith("chatrun_"));
});

test("a gate-owned relay can bind the exact autonomous run id before root launches it", async () => {
  const s = mockSocket();
  const requestedRunId = "dshautorun_1234567890_1";
  const child = runViaChatSocket("deepseek", "task", {
    connect: () => s,
    requestedRunId,
    requestFrame: { t: "autonomous", worktree: "/data/home/agent/workspaces/deepseek/repo" },
  });
  s.emit("connect");
  await tick();
  assert.equal(child.runId, requestedRunId);
  assert.equal(s.sent[0].runId, requestedRunId);
  assert.deepEqual(Object.keys(s.sent[0]).sort(), ["engineId", "prompt", "runId", "t", "worktree"].sort());
});

test("delivery sends only validated data fields to the root broker", async () => {
  const s = mockSocket();
  const child = runChannelDeliveryViaChatSocket("discord", "user:123", "hello", { connect: () => s });
  s.emit("connect");
  await tick();
  assert.equal(s.sent.length, 1);
  const f = s.sent[0];
  assert.deepEqual(Object.keys(f).sort(), ["channel", "message", "runId", "t", "target"].sort());
  assert.equal(f.t, "delivery");
  assert.equal(f.channel, "discord");
  assert.equal(f.target, "user:123");
  assert.equal(f.message, "hello");
  assert.ok(f.runId.startsWith("delivery_"));
  assert.equal("bin" in f || "argv" in f || "env" in f || "uid" in f || "token" in f, false);
  child.kill("SIGTERM");
});

test("streams stdout/stderr as 'data' Buffers; exit fires exit THEN close with code+signal", async () => {
  const s = mockSocket();
  const child = runViaChatSocket("claude", "hi", { connect: () => s });
  s.emit("connect");
  const out = []; const err = []; const events = [];
  child.stdout.on("data", (b) => out.push(b.toString()));
  child.stderr.on("data", (b) => err.push(b.toString()));
  child.on("exit", (code, sig) => events.push(["exit", code, sig]));
  child.on("close", (code, sig) => events.push(["close", code, sig]));
  const runId = s.sent[0].runId;
  s.feed({ t: "out", runId, stream: "stdout", text: "tok1" });
  s.feed({ t: "out", runId, stream: "stdout", text: "tok2" });
  s.feed({ t: "out", runId, stream: "stderr", text: "warn" });
  s.feed({ t: "exit", runId, exitCode: 0, signalName: null });
  await tick();
  assert.deepEqual(out, ["tok1", "tok2"]);
  assert.deepEqual(err, ["warn"]);
  assert.deepEqual(events, [["exit", 0, null], ["close", 0, null]]);
  assert.equal(child.exitCode, 0);
  assert.equal(child.terminationProven, true, "an explicit runner exit frame proves termination");
});

test("the client preserves bounded root and connect failure causes on stderr", async () => {
  const s = mockSocket();
  const child = runViaChatSocket("claude-assist", "draft", { connect: () => s, runIdPrefix: "assist" });
  const errors = [];
  child.stderr.on("data", (b) => errors.push(b.toString()));
  s.emit("connect");
  assert.equal(s.sent[0].engineId, "claude-assist");
  assert.match(s.sent[0].runId, /^assist_/);
  s.feed({ t: "exit", runId: s.sent[0].runId, exitCode: null, signalName: null,
    error: "agent_lane_quarantined: " + "x".repeat(10000) + "END-MUST-BE-CUT" });
  await tick();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /agent_lane_quarantined/);
  assert.ok(errors[0].length <= 2048);
  assert.doesNotMatch(errors[0], /END-MUST-BE-CUT/);

  const disconnected = runViaChatSocket("claude-assist", "draft", {
    connect: () => { throw new Error("chat broker unavailable: " + "y".repeat(10000) + "END-MUST-BE-CUT"); },
  });
  const connectErrors = [];
  disconnected.stderr.on("data", (b) => connectErrors.push(b.toString()));
  await tick();
  assert.equal(connectErrors.length, 1);
  assert.match(connectErrors[0], /chat broker unavailable/);
  assert.ok(connectErrors[0].length <= 2048);
  assert.doesNotMatch(connectErrors[0], /END-MUST-BE-CUT/);
});

test("ignores frames for a different runId (multiplex isolation)", async () => {
  const s = mockSocket();
  const child = runViaChatSocket("gemini", "hi", { connect: () => s });
  s.emit("connect");
  const out = [];
  child.stdout.on("data", (b) => out.push(b.toString()));
  s.feed({ t: "out", runId: "SOMEONE_ELSE", stream: "stdout", text: "leak" });
  await tick();
  assert.deepEqual(out, [], "output for another runId must not leak into this child");
});

test("kill() sends a kill frame for this runId", async () => {
  const s = mockSocket();
  const child = runViaChatSocket("gemini", "hi", { connect: () => s });
  s.emit("connect");
  await tick();
  const runId = s.sent[0].runId;
  child.kill("SIGTERM");
  const kf = s.sent.find((f) => f.t === "kill");
  assert.deepEqual(kf, { t: "kill", runId, signal: "SIGTERM" });
});

test("kill before connect suppresses the run and proves no root child exists", async () => {
  const s = mockSocket();
  const child = runViaChatSocket("gemini", "hi", { connect: () => s });
  let closed = null;
  child.on("close", (code, sig) => { closed = [code, sig]; });

  assert.equal(child.kill("SIGTERM"), true);
  s.emit("connect");
  await tick();

  assert.deepEqual(s.sent, [], "an already-cancelled proxy must never send a run frame");
  assert.deepEqual(closed, [null, "SIGTERM"]);
  assert.equal(child.terminationProven, true,
    "cancelling before the run request proves root never launched a child");
});

test("fail-closed: a socket error before exit ends the run (exit null), never hangs", async () => {
  const s = mockSocket();
  const child = runViaChatSocket("gemini", "hi", { connect: () => s });
  s.emit("connect");
  let closed = null;
  child.on("close", (code, sig) => { closed = [code, sig]; });
  s.emit("error", new Error("boom"));
  await tick();
  assert.deepEqual(closed, [null, null], "socket error yields a fast fail-closed exit");
  assert.equal(child.terminationProven, false,
    "a lost broker connection is not misrepresented as proof the root-side child exited");
});

test("fail-closed: connect() throwing ends the run without hanging", async () => {
  const child = runViaChatSocket("gemini", "hi", { connect: () => { throw new Error("no socket"); } });
  let closed = false;
  child.on("close", () => { closed = true; });
  await tick();
  assert.equal(closed, true);
  assert.equal(child.terminationProven, true,
    "a connect failure before any run frame cannot have orphaned a child");
});

test("a throwing run-frame write is unproven because root may have received a partial frame", async () => {
  const s = mockSocket();
  s.write = () => { throw new Error("partial write"); };
  const child = runViaChatSocket("gemini", "hi", { connect: () => s });
  const errors = [];
  child.stderr.on("data", (b) => errors.push(b.toString()));
  let closed = false;
  child.on("close", () => { closed = true; });
  s.emit("connect");
  await tick();
  assert.equal(closed, true);
  assert.equal(child.terminationProven, false);
  assert.deepEqual(errors, ["partial write"], "a synchronous broker write failure names its own cause");
});

test("exit reports signalName (killed distinguishable from real exit)", async () => {
  const s = mockSocket();
  const child = runViaChatSocket("gemini", "hi", { connect: () => s });
  s.emit("connect");
  let ev = null;
  child.on("exit", (code, sig) => { ev = [code, sig]; });
  const runId = s.sent[0].runId;
  s.feed({ t: "exit", runId, exitCode: null, signalName: "SIGKILL" });
  await tick();
  assert.deepEqual(ev, [null, "SIGKILL"]);
});

test("root quarantine helper sends one fixed frame and resolves only after root acknowledges", async () => {
  const s = mockSocket();
  const result = tripRootAgentLaneQuarantine({ connect: () => s, timeoutMs: 100 });
  s.emit("connect");
  assert.deepEqual(s.sent, [{ t: "quarantine" }]);
  s.feed({ t: "quarantine_ack", quarantined: true });
  assert.equal(await result, true);
});

test("root quarantine helper fails soft on connection and framing failures", async () => {
  assert.equal(await tripRootAgentLaneQuarantine({ connect: () => { throw new Error("down"); }, timeoutMs: 5 }), false);
  const s = mockSocket();
  const result = tripRootAgentLaneQuarantine({ connect: () => s, timeoutMs: 100 });
  s.emit("connect");
  s.emit("error", new Error("lost"));
  assert.equal(await result, false);
});

test("fatal containment helper sends one exact no-argument restart frame", async () => {
  const s = mockSocket();
  const result = requestRootFatalContainment({ connect: () => s, timeoutMs: 100 });
  s.emit("connect");
  assert.deepEqual(s.sent, [{ t: "fatal_containment" }]);
  s.feed({ t: "fatal_containment_ack", restarting: true });
  assert.equal(await result, true);
});
