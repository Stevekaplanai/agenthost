// "claim+block did not stick" is a failure with no cause, and the cause was
// already in hand: the card's status is in the show output the check just read.
//
// Live cost, 2026-08-10: the governed-write proof card hit this. The audit trail
// read autonomy_forceblock_fail -> autonomy_await_review -> autonomy_task_unclaimable
// across three events before anything said the word `triage` -- a state from
// which ONLY archive can move a card. The one word explaining the whole sequence
// was available at the first event and printed at the third.
//
// A source assertion, labelled as one: forceBlock is not exported and this
// detects the reason going missing again, which a grep can honestly detect.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const src = fs.readFileSync(
  path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");

test("the forceblock failure reports the status that refused it", () => {
  const i = src.indexOf("autonomy_forceblock_fail");
  assert.ok(i > 0, "the event must exist");
  const near = src.slice(Math.max(0, i - 900), i + 300);
  assert.ok(near.includes("String(s2") && near.includes("status:"),
    "it must parse the card's actual status out of the show output it already has");
  assert.ok(near.includes("{1,32}") || near.includes("slice(0, 32)"),
    "and bound it -- an audit line is a place a surprising value can bloat or smuggle text");
  assert.match(src.slice(i, i + 200), /status=/,
    "and put that status in the audit detail, not just the fact of failure");
});

test("triage is called out as terminal, because it is", () => {
  const i = src.indexOf("autonomy_forceblock_fail");
  const near = src.slice(i, i + 400);
  assert.match(near, /triage/,
    "a card in triage can only be archived -- saying so at the first failure saves the next reader two events of guessing");
});
