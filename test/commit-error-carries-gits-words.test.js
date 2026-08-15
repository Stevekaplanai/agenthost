// "failed safely" describes the handling, not the fault.
//
// With the ownership problem fixed, the commit reached this block and every
// approved task failed with "private Git commit failed safely" — a phrase that
// says only that something was caught. The engine had written real work and
// nobody could tell why it would not commit.
//
// Same shape, one layer deeper, as the two error paths fixed earlier today.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const src = fs.readFileSync(
  path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");

test("the commit failure carries git's own words", () => {
  assert.ok(!src.includes('return { error: "private Git commit failed safely" };'),
    "the bare phrase must not come back -- it names our handling instead of the fault");
  assert.ok(src.includes('"private Git commit failed: "'),
    "the message must be a prefix to a real reason, not a reason in itself");
});

test("stderr is preferred, with a fallback so it is never silent", () => {
  const i = src.indexOf('"private Git commit failed: "');
  const block = src.slice(Math.max(0, i - 700), i + 200);
  assert.ok(block.includes("e.stderr"), "git explains itself on stderr");
  assert.ok(block.includes("e.message"), "a failure with no stderr must still say something");
  assert.ok(block.includes('"no output"'),
    "and one with neither must say THAT, rather than returning an empty reason");
});

test("the reason is bounded", () => {
  const i = src.indexOf('"private Git commit failed: "');
  assert.ok(src.slice(i, i + 200).includes("slice(0, 200)"),
    "an error line is a place a repo path or a token could otherwise travel");
});

// A catch block that can itself throw turns a handled failure into an unhandled
// one — in the exact path whose job is to make failures legible. String() throws
// on a value with no valid primitive conversion. (Codex, reviewing this change.)
test("the reason extraction cannot itself throw", () => {
  const i = src.indexOf('"private Git commit failed: "');
  const block = src.slice(Math.max(0, i - 900), i + 200);
  assert.match(block, /catch \{ why = "unreadable error object"; \}/,
    "an error object that cannot be converted must still yield a reason, not an exception");

  // And the property, exercised rather than grepped: the shape used here must
  // survive the values that break a bare String().
  const lastLine = (v) => {
    try { return String(v == null ? "" : v).trim().split("\n").filter(Boolean).pop() || ""; }
    catch { return ""; }
  };
  for (const hostile of [Object.create(null), Symbol("x"), { toString() { throw new Error("no"); } }]) {
    assert.doesNotThrow(() => lastLine(hostile), "must survive: " + String(typeof hostile));
  }
});
