// Tests for the Agent Replay index (desktop/room/timeline.js), phase B slice 1.
// Every case runs the real functions against a real file on disk — the lesson
// from phase A, where two tests that only pattern-matched the source text let
// two defects through.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const timeline = require("../desktop/room/timeline.js");
const { createTranscript } = require("../desktop/room/transcript.js");

function freshTranscript() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "timeline-"));
  const file = path.join(dir, "transcript.jsonl");
  return { file, t: createTranscript(file) };
}

test("indexes a real transcript, in order, with seek offsets that resolve", () => {
  const { file, t } = freshTranscript();
  t.append("steve", "first", { to: "claude" });
  t.append("claude", "second");
  t.append("codex", "third");

  const idx = timeline.buildIndex(file);
  assert.equal(idx.source, "desktop");
  assert.deepEqual(idx.entries.map((e) => e.seq), [0, 1, 2]);
  assert.deepEqual(idx.entries.map((e) => e.who), ["steve", "claude", "codex"]);
  assert.equal(idx.entries[0].to, "claude");

  // The records must resolve to the right entries — this is the whole point of
  // the index (answer from memory, never re-parse per frame).
  const read = timeline.entriesFor(idx, idx.entries);
  assert.deepEqual(read.map((e) => e.text), ["first", "second", "third"]);
});

test("a corrupt line is skipped without shifting the entries around it", () => {
  const { file, t } = freshTranscript();
  t.append("steve", "before");
  fs.appendFileSync(file, "{not json\n");
  t.append("claude", "after");

  const idx = timeline.buildIndex(file);
  assert.deepEqual(idx.entries.map((e) => e.who), ["steve", "claude"]);
  // seq stays dense over the entries that exist, and the offsets still resolve.
  assert.deepEqual(idx.entries.map((e) => e.seq), [0, 1]);
  assert.deepEqual(timeline.entriesFor(idx, idx.entries).map((e) => e.text), ["before", "after"]);
});

test("a missing transcript is an empty index, never a throw", () => {
  const idx = timeline.buildIndex(path.join(os.tmpdir(), "does-not-exist-" + Date.now(), "t.jsonl"));
  assert.deepEqual(idx.entries, []);
  assert.equal(idx.size, 0);
  assert.equal(timeline.bounds(idx), null, "no history means no slider range at all");
});

test("upTo returns the thread as of an instant, not the whole file", () => {
  const { file, t } = freshTranscript();
  const a = t.append("steve", "one", { to: "claude" });
  const b = t.append("claude", "two");
  t.append("codex", "three");
  const idx = timeline.buildIndex(file);

  const asOf = timeline.upTo(idx, b.at);
  assert.deepEqual(asOf.map((e) => e.who), ["steve", "claude"],
    "scrubbing to an instant shows the thread as it stood then, not the whole file");
  assert.ok(asOf[0].at >= a.at);
  assert.equal(timeline.upTo(idx, Date.now()).length, 3);
});

test("bounds describe the scrub track", () => {
  const { file, t } = freshTranscript();
  const first = t.append("steve", "start");
  const last = t.append("claude", "end");
  const b = timeline.bounds(timeline.buildIndex(file));
  assert.equal(b.first, first.at);
  assert.equal(b.last, last.at);
  assert.equal(b.count, 2);
});

test("an entry with no usable timestamp never lands at the epoch", () => {
  // A hand-edited or pre-timestamp line would otherwise sort as the oldest
  // event in the room and drag the slider's start back to 1970.
  const { file, t } = freshTranscript();
  t.append("steve", "real");
  fs.appendFileSync(file, JSON.stringify({ who: "ghost", text: "no timestamp" }) + "\n");
  const idx = timeline.buildIndex(file);
  assert.equal(idx.entries.length, 2, "it is still indexed");
  const b = timeline.bounds(idx);
  assert.equal(b.count, 1, "but it is excluded from the time track");
  assert.ok(b.first > 0);
  assert.ok(!timeline.upTo(idx, Date.now()).some((e) => e.who === "ghost"));
});

test("refresh reuses the index when nothing changed, rebuilds when it did", () => {
  const { file, t } = freshTranscript();
  t.append("steve", "one");
  const first = timeline.buildIndex(file);

  const same = timeline.refreshIndex(file, first);
  assert.equal(same, first, "an unchanged file must not be re-read — this runs on every scrub frame");

  t.append("claude", "two");
  const grown = timeline.refreshIndex(file, first);
  assert.notEqual(grown, first);
  assert.equal(grown.entries.length, 2);

  // A truncated or replaced file must rebuild rather than trust stale offsets.
  fs.writeFileSync(file, JSON.stringify({ at: Date.now(), who: "steve", text: "reset" }) + "\n");
  const rebuilt = timeline.refreshIndex(file, grown);
  assert.equal(rebuilt.entries.length, 1);
  assert.deepEqual(timeline.entriesFor(rebuilt, rebuilt.entries).map((e) => e.text), ["reset"]);
});

test("a scrub frame is served from memory, with no disk read at all", () => {
  const { file, t } = freshTranscript();
  t.append("steve", "one", { to: "claude" });
  t.append("claude", "two");
  const idx = timeline.buildIndex(file);

  // Prove it by making the file unreadable to a disk path: rename it away.
  // entriesFor must still answer, because the entries were parsed at build
  // time (the file was already read whole then, so this costs no extra I/O).
  const moved = file + ".moved";
  fs.renameSync(file, moved);
  try {
    const served = timeline.entriesFor(idx, timeline.upTo(idx, Date.now()));
    assert.deepEqual(served.map((e) => e.text), ["one", "two"],
      "a scrub must not re-read the transcript per frame");
  } finally {
    fs.renameSync(moved, file);
  }
});

test("engine state ignores entries with no explicit recipient", () => {
  const { file, t } = freshTranscript();
  // A legacy or hand-edited line with no `to`. Treated as a question to
  // everybody, it would leave every engine reading "answering" forever.
  fs.appendFileSync(file, JSON.stringify({ at: Date.now() - 1000, who: "steve", text: "ambient musing" }) + "\n");
  const idx = timeline.buildIndex(file);
  const states = timeline.statesAt(idx, Date.now(), ["claude", "codex"]);
  assert.deepEqual(states, { claude: "idle", codex: "idle" });

  // An explicit @everyone still counts as asking everyone.
  const t2 = createTranscript(file);
  t2.append("steve", "team?", { to: "everyone" });
  const idx2 = timeline.buildIndex(file);
  const asked = timeline.statesAt(idx2, Date.now(), ["claude", "codex"]);
  assert.deepEqual(asked, { claude: "answering", codex: "answering" });
});

test("engine state follows max file-order sequence when timestamps move backwards", () => {
  const { file } = freshTranscript();
  const write = (entry) => fs.appendFileSync(file, JSON.stringify(entry) + "\n");

  // File order is the real causal order on this machine. The timestamps are
  // deliberately scrambled the way a pulled box turn or a clock correction
  // can scramble them: question, reply, then a newer unanswered question.
  write({ at: 300, who: "steve", to: "claude", text: "first question" });
  write({ at: 100, who: "claude", text: "first answer" });
  write({ at: 200, who: "steve", to: "claude", text: "second question" });
  let idx = timeline.buildIndex(file);
  assert.deepEqual(timeline.statesAt(idx, Infinity, ["claude"]), { claude: "answering" },
    "the max question seq is newer than the max reply seq, regardless of timestamp sort order");

  write({ at: 150, who: "claude", text: "second answer" });
  idx = timeline.buildIndex(file);
  assert.deepEqual(timeline.statesAt(idx, Infinity, ["claude"]), { claude: "idle" },
    "a later file-order reply clears the question even when its timestamp sorts earlier");
});

test("Replay keeps exact within-source order through a clock correction", () => {
  const { file } = freshTranscript();
  const write = (entry) => fs.appendFileSync(file, JSON.stringify(entry) + "\n");
  write({ at: 300, source: "box:box-1", who: "box:claude", text: "box first" });
  write({ at: 200, source: "desktop", who: "steve", text: "local middle" });
  write({ at: 100, source: "box:box-1", who: "box:codex", text: "box second" });

  const idx = timeline.buildIndex(file);
  assert.deepEqual(idx.entries.map((e) => e.seq), [1, 0, 2]);
  assert.deepEqual(idx.entries.map((e) => e.orderAt), [200, 300, 300]);
  assert.deepEqual(timeline.entriesFor(idx, timeline.upTo(idx, 250)).map((e) => e.text), ["local middle"],
    "the later box turn cannot appear before its causal predecessor just because its raw clock moved back");
  assert.deepEqual(timeline.entriesFor(idx, timeline.upTo(idx, 300)).map((e) => e.text),
    ["local middle", "box first", "box second"]);
});

test("the viewer never writes: indexing leaves the transcript byte-identical", () => {
  const { file, t } = freshTranscript();
  t.append("steve", "untouched");
  t.append("claude", "also untouched");
  const before = fs.readFileSync(file);

  const idx = timeline.buildIndex(file);
  timeline.entriesFor(idx, idx.entries);
  timeline.refreshIndex(file, idx);
  timeline.upTo(idx, Date.now());
  timeline.bounds(idx);
  timeline.enginesSeen(idx, Date.now(), ["claude"]);
  timeline.statesAt(idx, Date.now(), ["claude"]);

  assert.deepEqual(fs.readFileSync(file), before,
    "Replay VIEWS history — it must never modify the room's only durable record");
});
