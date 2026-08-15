// Phase B slice 2: the read-only timeline routes, exercised against a REAL
// booted room service with a real transcript on disk.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
process.env.ROOM_TURN_TIMEOUT_MS = "700";
const { createRoomServer } = require("../desktop/room/room.js");
const { createTranscript } = require("../desktop/room/transcript.js");

// Engines that never run: these tests are about reading history, and a booted
// room must not spawn anything to serve a timeline request.
const inertEngines = {
  ran: 0,
  availability: () => ({ ok: true }),
  async run() { inertEngines.ran++; return { text: "should never happen", usage: null }; },
};

async function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "timeline-routes-"));
  const file = path.join(dir, "transcript.jsonl");
  const transcript = createTranscript(file);
  const room = createRoomServer({
    transcript,
    engines: inertEngines,
    sessionsFile: path.join(dir, "engine-sessions.json"),
    roster: ["claude", "codex"],
  });
  await new Promise((r) => room.server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + room.server.address().port;
  const close = () => new Promise((r) => { room.server.closeAllConnections(); room.server.close(r); });
  return { dir, file, transcript, room, base, close };
}

const get = async (base, p) => {
  const res = await fetch(base + p);
  return { status: res.status, body: await res.json().catch(() => null) };
};

test("bounds describe the scrub track, and say so honestly when there is no history", async () => {
  const s = await boot();
  const empty = await get(s.base, "/timeline/bounds");
  assert.equal(empty.status, 200);
  assert.equal(empty.body.bounds, null, "an empty room has no track, not a zero-length one");

  const a = s.transcript.append("steve", "hello", { to: "claude" });
  const b = s.transcript.append("claude", "hi back");
  const filled = await get(s.base, "/timeline/bounds");
  assert.equal(filled.body.bounds.first, a.at);
  assert.equal(filled.body.bounds.last, b.at);
  assert.equal(filled.body.bounds.count, 2);
  assert.equal(filled.body.source, "desktop");
  await s.close();
});

test("/timeline/at returns the thread AS IT STOOD, not the whole file", async () => {
  const s = await boot();
  const q = s.transcript.append("steve", "question one", { to: "claude" });
  const r = s.transcript.append("claude", "answer one");
  await new Promise((x) => setTimeout(x, 5));
  s.transcript.append("steve", "question two", { to: "codex" });

  const mid = await get(s.base, "/timeline/at?t=" + r.at);
  assert.deepEqual(mid.body.entries.map((e) => e.text), ["question one", "answer one"],
    "scrubbing back must not show messages from the future");
  assert.ok(mid.body.entries[0].at >= q.at);

  const now = await get(s.base, "/timeline/at?t=" + Date.now());
  assert.equal(now.body.entries.length, 3);
  await s.close();
});

test("engine states are derived for the moment being viewed", async () => {
  const s = await boot();
  const asked = s.transcript.append("steve", "codex, thoughts?", { to: "codex" });
  await new Promise((x) => setTimeout(x, 5));
  const answered = s.transcript.append("codex", "here they are");

  const during = await get(s.base, "/timeline/at?t=" + asked.at);
  assert.equal(during.body.states.codex, "answering", "asked but not yet replied");
  assert.equal(during.body.states.claude, "idle", "never addressed");

  const after = await get(s.base, "/timeline/at?t=" + answered.at);
  assert.equal(after.body.states.codex, "idle", "replied, so no longer answering");
  // Only the roster this room actually had — a room customised with
  // ROOM_ENGINES replays with its own engines, not an invented five.
  assert.deepEqual(Object.keys(after.body.states).sort(), ["claude", "codex"]);
  await s.close();
});

test("a long history is capped, and the view says how much it left out", async () => {
  // The transcript is never pruned, and building the response is synchronous,
  // so an uncapped "everything before this moment" would block the same event
  // loop that serves live chat.
  const s = await boot();
  for (let i = 0; i < 520; i++) s.transcript.append("claude", "message " + i);
  const view = await get(s.base, "/timeline/at?t=" + Date.now());
  assert.equal(view.body.entries.length, 500, "the window is bounded");
  assert.equal(view.body.omitted, 20, "and it reports what it dropped rather than implying that is all");
  assert.equal(view.body.entries[view.body.entries.length - 1].text, "message 519",
    "the window is the MOST RECENT slice before the chosen moment");
  await s.close();
});

test("replay describes the engines the history involved, not just today's roster", async () => {
  // This room's roster is claude+codex, but the history also involves gemini.
  // Replaying with only today's roster would silently drop it from the view.
  const s = await boot();
  s.transcript.append("steve", "gemini, take this one", { to: "gemini" });
  const view = await get(s.base, "/timeline/at?t=" + Date.now());
  assert.ok(Object.keys(view.body.states).includes("gemini"),
    "an engine that was in the room then must appear: " + JSON.stringify(view.body.states));
  assert.equal(view.body.states.gemini, "answering");
  await s.close();
});

test("bad timestamps are refused rather than guessed at", async () => {
  const s = await boot();
  assert.equal((await get(s.base, "/timeline/at")).status, 400);
  assert.equal((await get(s.base, "/timeline/at?t=yesterday")).status, 400);
  await s.close();
});

test("the timeline routes obey the same loopback guard as the room", async () => {
  const s = await boot();
  const http = await import("node:http");
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: s.room.server.address().port,
      path: "/timeline/bounds", headers: { Host: "evil.example.com" } },
      (res) => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject);
    req.end();
  });
  assert.equal(status, 403, "history must not be readable by a rebound host either");
  await s.close();
});

test("serving the timeline never runs an engine and never writes the transcript", async () => {
  const s = await boot();
  s.transcript.append("steve", "just reading", { to: "claude" });
  const before = fs.readFileSync(s.file);
  const ranBefore = inertEngines.ran;

  await get(s.base, "/timeline/bounds");
  await get(s.base, "/timeline/at?t=" + Date.now());

  assert.equal(inertEngines.ran, ranBefore, "Replay VIEWS history — it never re-runs a turn");
  assert.deepEqual(fs.readFileSync(s.file), before, "and never modifies the record it is reading");
  await s.close();
});

test("phase C: one scrub covers both machines, without inventing box engine states", async () => {
  // Box turns live in the SAME transcript (the desktop appends what it pulls),
  // so the timeline shows both sides with no change to the viewer — which is
  // why the index carries a source from the start.
  const s = await boot();
  const boxTime = Date.now() - 60000;
  s.transcript.append("box:hermes", "said this on the box an hour ago", { id: "box:h1", at: boxTime });
  s.transcript.append("steve", "and this on the desktop", { to: "claude" });

  const view = await get(s.base, "/timeline/at?t=" + Date.now());
  const speakers = view.body.entries.map((e) => e.who);
  assert.ok(speakers.includes("box:hermes"), "box turns appear in the scrub: " + JSON.stringify(speakers));
  assert.ok(speakers.includes("steve"), "alongside desktop turns");

  // The box's own time survived into the timeline, so the two sides interleave
  // by when things were actually said.
  const boxEntry = view.body.entries.find((e) => e.who === "box:hermes");
  assert.equal(boxEntry.at, boxTime);

  // But this room must not claim to know what an engine on another machine was
  // doing — it never asked it anything.
  assert.ok(!Object.keys(view.body.states).some((id) => id.startsWith("box:")),
    "no invented state for a remote engine: " + JSON.stringify(view.body.states));
  await s.close();
});

test("the two machines interleave by when things were SAID, not when they arrived", async () => {
  // A box reply pulled after the fact carries the box's own timestamp, so it
  // belongs BEFORE a question typed later — even though it reached this file
  // afterwards. Without the sort, a backlog pulled after the laptop slept lands
  // as one block at the end instead of woven into the conversation.
  const s = await boot();
  const t0 = Date.now() - 60000;
  s.transcript.append("steve", "asked at t0", { to: "claude", at: t0 });
  s.transcript.append("steve", "asked at t0+40s", { to: "claude", at: t0 + 40000 });
  // Pulled last, but said in between.
  s.transcript.append("box:hermes", "the box said this at t0+20s", { id: "box:h9", at: t0 + 20000 });

  const view = await get(s.base, "/timeline/at?t=" + Date.now());
  assert.deepEqual(view.body.entries.map((e) => e.text), [
    "asked at t0",
    "the box said this at t0+20s",
    "asked at t0+40s",
  ], "one conversation, in the order it actually happened");
  await s.close();
});
