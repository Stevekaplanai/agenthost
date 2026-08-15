// Behavior tests for the Agent Room server (desktop/room/room.js): the whole
// HTTP+SSE surface booted with FAKE engines and a scratch transcript, so the
// serial queue, the waterfall (later engines see earlier replies), the honest
// no-reply markers, restart replay, and the loopback guard are all proven
// without spawning a real CLI. The real engine IO is thin glue over the
// conformance-tested adapters; the live five-engine run is the plan's
// definition-of-DONE check on Steve's machine.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// Must land before room.js is required: the hung-engine test needs a turn
// timeout measured in milliseconds, not the production five minutes.
process.env.ROOM_TURN_TIMEOUT_MS = "700";
const { createRoomServer } = require("../desktop/room/room.js");
const { createTranscript } = require("../desktop/room/transcript.js");

function fakeEngines(overrides = {}) {
  const calls = [];
  return {
    calls,
    availability(id) {
      if (overrides.unavailable && overrides.unavailable.includes(id)) {
        return { ok: false, note: "no key — test says so" };
      }
      return { ok: true };
    },
    async run(id, opts) {
      calls.push({ id, mode: opts.mode, replies: opts.replies.map((r) => r.eng) });
      if (overrides.fail && overrides.fail.includes(id)) throw new Error(id + " blew up");
      if (overrides.empty && overrides.empty.includes(id)) return { text: "", usage: null };
      opts.onDelta("partial-");
      return { text: id + " says hi", usage: { inputTokens: 1, outputTokens: 2, costUsd: null, plan: "test" } };
    },
  };
}

async function boot(overrides) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "room-server-"));
  const transcript = createTranscript(path.join(dir, "transcript.jsonl"));
  const engines = fakeEngines(overrides);
  const room = createRoomServer({ transcript, engines, sessionsFile: path.join(dir, "engine-sessions.json") });
  await new Promise((r) => room.server.listen(0, "127.0.0.1", r));
  const port = room.server.address().port;
  const base = "http://127.0.0.1:" + port;
  // closeAllConnections: undici's keep-alive pool and any open SSE stream
  // would otherwise hold server.close() open forever.
  const close = () => new Promise((r) => { room.server.closeAllConnections(); room.server.close(r); });
  return { dir, transcript, engines, room, base, close };
}

// The queue settles asynchronously; wait until the thread holds n entries.
async function waitForEntries(base, n) {
  for (let i = 0; i < 200; i++) {
    const res = await fetch(base + "/room/thread");
    const { entries } = await res.json();
    if (entries.length >= n) return entries;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("thread never reached " + n + " entries");
}

test("directed send: steve's message + the engine's reply land durably", async () => {
  const s = await boot();
  const res = await fetch(s.base + "/room/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "hello claude", to: "claude" }),
  });
  const sent = await res.json();
  assert.ok(sent.ok);
  assert.deepEqual(sent.targets, ["claude"]);
  const entries = await waitForEntries(s.base, 2);
  assert.equal(entries[0].who, "steve");
  assert.equal(entries[0].to, "claude");
  assert.equal(entries[1].who, "claude");
  assert.equal(entries[1].text, "claude says hi");
  assert.equal(s.engines.calls[0].mode, "directed");
  // Restart replay: a fresh transcript instance sees the same thread.
  const replay = createTranscript(s.transcript.file);
  assert.equal(replay.entries.length, 2);
  await s.close();
});

test("@everyone: all five answer in order; later engines see earlier replies; missing engines mark honestly", async () => {
  const s = await boot({ unavailable: ["hermes"], fail: ["kimi"], empty: ["gemini"] });
  await fetch(s.base + "/room/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "team check-in", to: "everyone" }),
  });
  const entries = await waitForEntries(s.base, 6); // steve + 5 outcomes
  assert.deepEqual(entries.map((e) => e.who), ["steve", "claude", "codex", "kimi", "gemini", "hermes"]);
  assert.equal(entries[1].text, "claude says hi");
  assert.equal(entries[2].text, "codex says hi");
  assert.ok(entries[3].text.startsWith("(no reply — kimi blew up"));
  assert.ok(entries[4].text.includes("returned no text"));
  assert.ok(entries[5].text.includes("no key"));
  // The waterfall: codex's run saw claude's reply from THIS turn. Failed and
  // empty replies never enter the reply chain.
  const codexCall = s.engines.calls.find((c) => c.id === "codex");
  assert.deepEqual(codexCall.replies, ["claude"]);
  assert.equal(codexCall.mode, "team");
  await s.close();
});

test("resending the same durable id cannot double-post", async () => {
  const s = await boot();
  const body = JSON.stringify({ text: "once only", to: "claude", id: "run-once" });
  const headers = { "Content-Type": "application/json" };
  await fetch(s.base + "/room/send", { method: "POST", headers, body });
  await waitForEntries(s.base, 2);
  const retry = await fetch(s.base + "/room/send", { method: "POST", headers, body });
  assert.equal((await retry.json()).duplicate, true, "the retry must report itself as a duplicate");
  await new Promise((r) => setTimeout(r, 150));
  const entries = await waitForEntries(s.base, 2);
  assert.equal(entries.filter((e) => e.text === "once only").length, 1);
  assert.equal(entries.filter((e) => e.who === "claude").length, 1);
  // The transcript staying clean is NOT enough: an enqueued retry would spend
  // a second real engine call (real money/quota) whose reply is then silently
  // deduped away, leaving a stuck "answering..." bubble in the UI.
  assert.equal(s.engines.calls.filter((c) => c.id === "claude").length, 1,
    "a retried send must not run the engine again");
  await s.close();
});

test("a directed turn queued behind another sees the earlier reply, not a stale snapshot", async () => {
  const s = await boot();
  const realRun = s.engines.run;
  const seenHistories = [];
  s.engines.run = async (id, opts) => {
    seenHistories.push({ id, texts: opts.history.map((e) => e.text) });
    await new Promise((r) => setTimeout(r, 30));
    return realRun(id, opts);
  };
  const headers = { "Content-Type": "application/json" };
  // Both sends land while the first turn is still running.
  await Promise.all([
    fetch(s.base + "/room/send", { method: "POST", headers, body: JSON.stringify({ text: "first question", to: "claude" }) }),
    fetch(s.base + "/room/send", { method: "POST", headers, body: JSON.stringify({ text: "second question", to: "codex" }) }),
  ]);
  await waitForEntries(s.base, 4);
  const second = seenHistories.find((h) => h.id === "codex");
  assert.ok(second.texts.includes("claude says hi"),
    "the second turn must see the reply that landed while it waited: " + JSON.stringify(second.texts));
  assert.ok(!second.texts.includes("second question"),
    "and must not be handed its own prompt as history");
  await s.close();
});

test("turns run serially: a second send waits for the first", async () => {
  const s = await boot();
  let inFlight = 0;
  let maxInFlight = 0;
  const realRun = s.engines.run;
  s.engines.run = async (id, opts) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 30));
    const out = await realRun(id, opts);
    inFlight--;
    return out;
  };
  const headers = { "Content-Type": "application/json" };
  await Promise.all([
    fetch(s.base + "/room/send", { method: "POST", headers, body: JSON.stringify({ text: "a", to: "claude" }) }),
    fetch(s.base + "/room/send", { method: "POST", headers, body: JSON.stringify({ text: "b", to: "codex" }) }),
  ]);
  await waitForEntries(s.base, 4);
  assert.equal(maxInFlight, 1, "the serial queue must never overlap turns");
  await s.close();
});

test("a hung engine is timed out, killed, and marked honestly", async () => {
  const s = await boot();
  let cancelCalled = false;
  s.engines.run = (id, opts) => new Promise((resolve) => {
    // Hang until the room cancels us -- the shape of a wedged CLI.
    opts.cancelToken.cancel = () => { cancelCalled = true; resolve({ text: "", usage: null }); };
  });
  await fetch(s.base + "/room/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "hang forever", to: "claude" }),
  });
  const entries = await waitForEntries(s.base, 2);
  assert.ok(cancelCalled, "the room must cancel a hung engine");
  assert.ok(entries[1].text.includes("timed out"), "the marker must say it timed out, got: " + entries[1].text);
  await s.close();
});

test("a reply that arrived survives a turn that is stopped afterwards", async () => {
  const s = await boot();
  s.engines.run = (id, opts) => new Promise((resolve) => {
    opts.onDelta("the answer");
    // Answered, then wedged — the codex shape measured on 2026-07-31.
    opts.cancelToken.cancel = () => resolve({ text: "the answer", usage: null });
  });
  await fetch(s.base + "/room/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "answer then hang", to: "claude" }),
  });
  const entries = await waitForEntries(s.base, 2);
  assert.ok(entries[1].text.startsWith("the answer"), "the reply must not be discarded: " + entries[1].text);
  assert.ok(entries[1].text.includes("stopped this turn"), "and the cut must be disclosed");
  await s.close();
});

test("participants reports live states and key-missing notes", async () => {
  const s = await boot({ unavailable: ["kimi", "hermes"] });
  const res = await fetch(s.base + "/room/participants");
  const { participants } = await res.json();
  assert.deepEqual(participants.map((p) => p.id), ["claude", "codex", "kimi", "gemini", "hermes"]);
  assert.equal(participants.find((p) => p.id === "kimi").state, "missing");
  assert.ok(participants.find((p) => p.id === "kimi").note.includes("no key"));
  assert.equal(participants.find((p) => p.id === "claude").state, "idle");
  await s.close();
});

test("the loopback guard refuses foreign Hosts and Origins", async () => {
  const s = await boot();
  // fetch() overwrites a custom Host header with the URL's own, so the forged
  // Host (the DNS-rebinding shape) needs a raw request.
  const http = await import("node:http");
  const forgedStatus = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: s.room.server.address().port, path: "/room/thread", headers: { Host: "evil.example.com" } },
      (res) => { res.resume(); resolve(res.statusCode); }
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(forgedStatus, 403);
  const crossSite = await fetch(s.base + "/room/send", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://evil.example.com" },
    body: JSON.stringify({ text: "injected", to: "claude" }),
  });
  assert.equal(crossSite.status, 403);
  const entries = await waitForEntries(s.base, 0);
  assert.equal(entries.length, 0, "nothing may land from a refused request");
  await s.close();
});

test("bad sends are rejected with clear errors", async () => {
  const s = await boot();
  const headers = { "Content-Type": "application/json" };
  const empty = await fetch(s.base + "/room/send", { method: "POST", headers, body: JSON.stringify({ text: "  " }) });
  assert.equal(empty.status, 400);
  const unknown = await fetch(s.base + "/room/send", { method: "POST", headers, body: JSON.stringify({ text: "hi", to: "skynet" }) });
  assert.equal(unknown.status, 400);
  const notJson = await fetch(s.base + "/room/send", { method: "POST", headers, body: "{nope" });
  assert.equal(notJson.status, 400);
  await s.close();
});

test("SSE stream delivers hello, live messages, and deltas", async () => {
  const s = await boot();
  const res = await fetch(s.base + "/room/stream");
  const reader = res.body.getReader();
  let streamText = "";
  const readUntil = async (needle) => {
    for (let i = 0; i < 100; i++) {
      if (streamText.includes(needle)) return;
      const { value, done } = await reader.read();
      if (done) break;
      streamText += Buffer.from(value).toString("utf8");
    }
    assert.ok(streamText.includes(needle), "stream should carry " + needle + "; got: " + streamText.slice(0, 500));
  };
  await readUntil("event: hello");
  await fetch(s.base + "/room/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "stream me", to: "claude" }),
  });
  await readUntil("stream me");        // steve's message event
  await readUntil("partial-");         // the engine's delta
  await readUntil("claude says hi");   // the engine's completed message
  await reader.cancel();
  await s.close();
});
