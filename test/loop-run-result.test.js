"use strict";
// The Loops tab could tell you a run FINISHED and never what it SAID.
//
// Three defects, one symptom (card t_ccb561da, Steve 2026-08-12):
//   1. the stored `output` is the raw claude stream-json event stream, not the
//      final result text;
//   2. `output` is capped at the FIRST 64KB and the terminal `result` event
//      arrives LAST, so any chatty run lost its result entirely -- both newest
//      live records on the box sat exactly at the cap, results already gone;
//   3. the field was fetched and typed in the UI and never rendered.
//
// finalResultText is the fix for 1 and 2 and is tested here WITHOUT spawning a
// claude: the extraction is pure, so it can be proven against real stream shapes
// rather than asserted in a comment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { finalResultText } = require("../container/gate.js");

const line = (o) => JSON.stringify(o);

test("the final result is taken from the stream's terminal result event", () => {
  const stream = [
    line({ type: "system", subtype: "init", session_id: "abc" }),
    line({ type: "assistant", message: { content: [{ type: "text", text: "thinking out loud" }] } }),
    line({ type: "result", subtype: "success", result: "Found 3 error groups: ENOENT x12, EACCES x4, timeout x1." }),
  ].join("\n");
  assert.equal(finalResultText(stream), "Found 3 error groups: ENOENT x12, EACCES x4, timeout x1.");
});

test("a leading fragment does not stop the scan — the tail is what matters", () => {
  // A 64KB tail slice almost always begins mid-line. Scanning from the END is
  // why that costs nothing.
  const tail = '{"type":"assistant","mess' + "\n" + line({ type: "result", result: "the answer" });
  assert.equal(finalResultText(tail), "the answer");
});

test("a failed run still says WHY instead of falling back to stream noise", () => {
  // Rule 16: the failure shapes carry their cause in different fields.
  assert.equal(finalResultText(line({ type: "result", subtype: "error", error: "rate limited until 09:00" })),
    "rate limited until 09:00");
  assert.equal(finalResultText(line({ type: "result", subtype: "error_max_turns", message: "hit the turn cap" })),
    "hit the turn cap");
});

test("unparseable output degrades to its LAST words, never its first", () => {
  // A non-JSON runner, a killed process, a partial line. "Some text" beats
  // "nothing", and today's behaviour is nothing — but it must be the END, since
  // whatever a run was doing, its last words are the ones worth reading.
  const plain = "starting\nworking\nall done: 4 files changed";
  assert.equal(finalResultText(plain), plain);
  const long = "x".repeat(200) + "THE-END";
  assert.ok(finalResultText(long, 20).endsWith("THE-END"), "keeps the tail, not the head");
});

test("empty and whitespace-only output yield an empty result, not noise", () => {
  assert.equal(finalResultText(""), "");
  assert.equal(finalResultText("   \n  \n"), "");
  assert.equal(finalResultText(undefined), "");
  assert.equal(finalResultText(null), "");
});

test("a result event with no usable text is skipped, not returned blank", () => {
  // An empty terminal event must not beat real text earlier in the stream.
  const stream = [
    line({ type: "result", result: "the real answer" }),
    line({ type: "result", result: "   " }),
  ].join("\n");
  assert.equal(finalResultText(stream), "the real answer");
});

test("the result is capped so a run record stays readable on a phone", () => {
  const huge = line({ type: "result", result: "y".repeat(50_000) });
  assert.equal(finalResultText(huge).length, 8 * 1024, "default cap is 8KB");
  assert.equal(finalResultText(huge, 100).length, 100, "and is overridable");
});

test("THE REGRESSION: a result after 64KB of chatter is still found", () => {
  // This is the exact live failure. The head-capped `output` field drops
  // everything past 64KB; the tail is accumulated unconditionally so the
  // terminal event survives.
  const chatter = Array.from({ length: 2000 }, (_, i) =>
    line({ type: "assistant", message: { content: [{ type: "text", text: "step " + i + " ".repeat(40) }] } })).join("\n");
  const full = chatter + "\n" + line({ type: "result", result: "FINAL ANSWER" });
  assert.ok(full.length > 64 * 1024, "fixture must exceed the cap or it proves nothing");
  // What the tail buffer would hold (last 64KB), which is what the fix reads.
  assert.equal(finalResultText(full.slice(-64 * 1024)), "FINAL ANSWER");
});
