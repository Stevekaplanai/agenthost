// Durability tests for the Agent Room transcript (desktop/room/transcript.js).
// The transcript is a durable-execution object (plan Rule 14 flag 3): these
// tests prove the properties the room's definition of DONE leans on -- the
// thread survives a restart byte-for-byte, a retried append can't double-post,
// and one corrupt line can't eat the thread.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTranscript, TEXT_MAX } from "../desktop/room/transcript.js";

function freshFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "room-transcript-"));
  return path.join(dir, "sub", "transcript.jsonl"); // parent dir does not exist yet
}

test("appends survive a restart (reload replays the whole thread)", () => {
  const file = freshFile();
  const t1 = createTranscript(file);
  t1.append("steve", "hello room", { id: "m1", to: "everyone" });
  t1.append("claude", "hello Steve", { id: "m1-r-claude" });

  const t2 = createTranscript(file); // the "restart"
  assert.equal(t2.entries.length, 2);
  assert.equal(t2.entries[0].who, "steve");
  assert.equal(t2.entries[0].text, "hello room");
  assert.equal(t2.entries[0].to, "everyone");
  assert.equal(t2.entries[1].who, "claude");
  assert.equal(t2.seq(), 2);
});

test("id dedup makes appends idempotent, in memory and across restarts", () => {
  const file = freshFile();
  const t1 = createTranscript(file);
  assert.ok(t1.append("steve", "once", { id: "dup" }));
  assert.equal(t1.append("steve", "twice", { id: "dup" }), null);
  assert.equal(t1.entries.length, 1);

  // The dedup guarantee must span restarts: the id set rebuilds from disk.
  const t2 = createTranscript(file);
  assert.equal(t2.append("steve", "thrice", { id: "dup" }), null);
  assert.equal(t2.entries.length, 1);
  assert.equal(fs.readFileSync(file, "utf8").trim().split("\n").length, 1);
});

test("a corrupt line is skipped without losing the entries around it", () => {
  const file = freshFile();
  const t1 = createTranscript(file);
  t1.append("steve", "before");
  fs.appendFileSync(file, "{not json\n");
  fs.appendFileSync(file, JSON.stringify({ who: 42, text: "bad who" }) + "\n");
  const t2 = createTranscript(file);
  t2.append("claude", "after");
  const t3 = createTranscript(file);
  assert.deepEqual(t3.entries.map((e) => e.text), ["before", "after"]);
});

test("legacy entries without a usable timestamp stay after timed history", () => {
  const file = freshFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ who: "steve", text: "untimed legacy" }) + "\n");
  fs.appendFileSync(file, JSON.stringify({ at: 200, who: "claude", text: "timed" }) + "\n");

  const transcript = createTranscript(file);
  assert.deepEqual(transcript.entries.map((e) => e.text), ["timed", "untimed legacy"],
    "adding causal ordering must not move legacy untimed lines to the top");
});

test("an untimed legacy line cannot reset one source's causal clock", () => {
  const file = freshFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const entry of [
    { at: 300, source: "box:box-1", who: "box:claude", text: "box first" },
    { source: "box:box-1", who: "box:system", text: "untimed legacy" },
    { at: 100, source: "box:box-1", who: "box:codex", text: "box second" },
  ]) fs.appendFileSync(file, JSON.stringify(entry) + "\n");

  const transcript = createTranscript(file);
  assert.deepEqual(transcript.entries.map((e) => e.text), ["box first", "box second", "untimed legacy"]);
  assert.deepEqual(transcript.entries.map((e) => e.orderAt), [300, 300, 0]);
});

test("a new timed append stays ahead of loaded untimed legacy history", () => {
  const file = freshFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ at: 100, source: "desktop", who: "steve", text: "timed" }) + "\n");
  fs.appendFileSync(file, JSON.stringify({ source: "desktop", who: "steve", text: "untimed legacy" }) + "\n");

  const live = createTranscript(file);
  live.append("steve", "new timed", { at: 200, source: "desktop" });
  assert.deepEqual(live.entries.map((e) => e.text), ["timed", "new timed", "untimed legacy"]);
  assert.deepEqual(createTranscript(file).entries.map((e) => e.text), ["timed", "new timed", "untimed legacy"]);
});

test("entries without an id never dedup, and text is capped at TEXT_MAX", () => {
  const file = freshFile();
  const t = createTranscript(file);
  assert.ok(t.append("steve", "same text"));
  assert.ok(t.append("steve", "same text")); // no id -> both land
  const long = t.append("claude", "x".repeat(TEXT_MAX + 500));
  assert.equal(long.text.length, TEXT_MAX);
  assert.equal(t.entries.length, 3);
});

test("said-order survives a restart when pulled entries arrived out of order", () => {
  const file = freshFile();
  const t0 = Date.now() - 60000;
  const live = createTranscript(file);
  live.append("steve", "first", { id: "first", at: t0 });
  live.append("steve", "last", { id: "last", at: t0 + 40000 });
  live.append("box:hermes", "middle", { id: "middle", at: t0 + 20000 });
  assert.deepEqual(live.entries.map((e) => e.text), ["first", "middle", "last"],
    "the live room inserts a pulled turn where it was said");

  const restarted = createTranscript(file);
  assert.deepEqual(restarted.entries.map((e) => e.text), ["first", "middle", "last"],
    "replaying the append-only file must preserve the same visible order");
});

test("a source keeps causal order when its clock moves backwards", () => {
  const file = freshFile();
  const live = createTranscript(file);
  live.append("box:claude", "box first", { id: "box-first", at: 300, source: "box:box-1" });
  live.append("steve", "local middle", { id: "local-middle", at: 200, source: "desktop" });
  live.append("box:codex", "box second", { id: "box-second", at: 100, source: "box:box-1" });

  assert.deepEqual(live.entries.map((e) => e.text), ["local middle", "box first", "box second"],
    "wall-clock correction must not reverse two turns from the same box");
  assert.deepEqual(live.entries.map((e) => e.orderAt), [200, 300, 300]);

  const restarted = createTranscript(file);
  assert.deepEqual(restarted.entries.map((e) => e.text), ["local middle", "box first", "box second"],
    "restart must rebuild the same causal order from the durable transcript");
  const stored = fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(stored.map((e) => e.source), ["box:box-1", "desktop", "box:box-1"]);
  assert.deepEqual(stored.map((e) => e.orderAt), [300, 200, 300]);
});
