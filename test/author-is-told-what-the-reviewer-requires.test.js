// The author and the reviewer must hold the SAME contract.
//
// They did not, and the loop could never close. The board prompt asked for "a
// concise plain-text result: what you did, what you found" -- so the engine
// produced exactly that, and the reviewer rejected it every time:
//
//   codex:  "Created LADDER-PROOF.md with `PROOF 2026-08-10`. No other changes."
//   gemini: "REJECTED ... only a self-summary and is missing the raw artifact
//            (diff/file contents) and the VERIFY command's actual output, which
//            is an automatic REJECT under our handoff contract."
//
// Neither engine was at fault. The charter told the author to send "evidence" --
// a word -- while the reviewer enforced a specification. The work was correct
// both times; the file really was written.
//
// A SOURCE assertion, labelled as one. autonomousPrompt is not exported, and
// exporting it purely to satisfy a test would widen the module's surface. This
// detects one regression -- the requirement going missing again -- which a grep
// can honestly detect. It does not claim the engine obeys it; the live card
// passing review is what proves that.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const src = fs.readFileSync(
  path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");
const fn = src.slice(
  src.indexOf("function autonomousPrompt"),
  src.indexOf("function autonomousPrompt") + 6000);

test("the board prompt demands the raw artifact, not a description of it", () => {
  assert.match(fn, /RAW artifact/,
    "the reviewer rejects a summary; the author has to be told that in the reviewer's own terms");
  assert.match(fn, /not a description of them/,
    "'evidence' is a word and 'the actual diff or file contents' is a specification -- the vagueness is the defect");
});

test("it demands the literal output of the verifying command", () => {
  assert.match(fn, /literal output of the command that verifies it/);
  assert.match(fn, /never retype, summarize, or predict it/,
    "a retyped or predicted output is indistinguishable from a fabricated one, which is worse than none");
});

test("the requirement is scoped to runs that can actually produce an artifact", () => {
  // A read-only run has nothing to diff. Demanding one would swap an impossible
  // contract for another impossible contract, and the loop still never closes.
  const idx = fn.indexOf("EVIDENCE IS REQUIRED");
  assert.ok(idx > 0, "the evidence clause must exist");
  const before = fn.slice(Math.max(0, idx - 400), idx);
  assert.match(before, /rung1Granted\s*\n?\s*\?/,
    "the clause must hang off the writable-workspace branch, not be asked of every run");
});

test("the read-only branch is left alone", () => {
  assert.match(fn, /ONLY writable path is your scratch dir/,
    "the read-only instruction still tells that run to produce output as text -- unchanged");
});
