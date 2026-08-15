// "Stuck" and "waiting for you" are different facts, and the alert said stuck
// for both.
//
// A card assigned to an execution engine that stops progressing is a
// malfunction. A card assigned to a PERSON that stops progressing is the board
// working as designed — it is holding a decision only they can make.
//
// Live cost, 2026-08-10: two cards assigned to Steve, both legitimately awaiting
// his decision, pushed "1 stuck card" every half hour indefinitely. The failure
// mode is not the buzzing — it is learning to swipe past board pushes, so the
// next one, which is real, gets swiped too. The board push is his primary alert
// channel, which is what makes the wording load-bearing rather than cosmetic.
//
// A source assertion, labelled as one: the sweep is not exported, and this
// detects the distinction being collapsed again, which a grep can honestly do.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const src = fs.readFileSync(
  path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");
const i = src.indexOf("board_stuck_detected");
const near = src.slice(Math.max(0, i - 2600), i + 400);

test("the alert separates engine-held cards from ones awaiting a person", () => {
  assert.ok(near.includes("engineHeld") && near.includes("personHeld"),
    "the two cases must be counted apart before either is announced");
  assert.match(near, /AUTONOMOUS_EXEC_ENGINES\.has/,
    "the split must be decided by whether the assignee is an execution engine, not by a name list");
});

test("a person-held card is never announced as stuck", () => {
  assert.match(near, /awaiting you/,
    "a decision waiting on a human must say so; calling it stuck reports a malfunction that did not happen");
});

test("the nudge is not silenced for person-held cards", () => {
  // Suppressing them would be the opposite failure: a decision nobody is
  // reminded of is exactly what this board exists to prevent.
  const suppressed = /personHeld\.length\s*===?\s*0\s*\)\s*return/.test(near)
    || /if\s*\(\s*!engineHeld\.length\s*\)\s*return/.test(near);
  assert.equal(suppressed, false,
    "person-held cards must still alert -- only the wording changes");
});

test("the audit line records which kind was found", () => {
  const after = src.slice(i, i + 400);
  assert.match(after, /engine-held/);
  assert.match(after, /awaiting a person/);
});
