// A consequence gate must say WHICH rule held the card (Cardinal Rule 16).
//
// Measured on the box 2026-08-10: t_7aff2a25 ("Note the odd group ownership on
// engine worktree git internals") sat `ready` behind a consequence gate with
// exactly ONE audit line:
//
//   {"event":"autonomy_consequence_gated",
//    "detail":"hermes: Note the odd group ownership on engine worktree git int",
//    "tid":"t_7aff2a25"}
//
// The detail is the assignee and a truncated title. It never says why. Four
// separate rules inside gitProposalGateReason all return the bare string
// "consequence", so the log could not distinguish them and the operator saw only
// "1 task awaiting approval [1 consequence_gate]".
//
// Why this is more than a logging nit: a git rung-1 grant is a CAPABILITY
// question, not one of Rule 13's three questions (does it reach anyone else, is
// it irreversible, is it a business judgment only the operator can make). If the
// autonomy level is what is holding the card, calling that a "consequence" tells
// the operator something irreversible is waiting when nothing is. Naming the
// cause is what lets that be seen -- and seen BEFORE anyone changes gate
// behaviour on an inference.
//
// The autocommit investigation (2026-08-10) settled the sequencing empirically:
// three fixes, each revealing the next layer, and every confident diagnosis made
// from a truncated line was wrong while every one made after the layer could
// speak was right. So this change is legibility ONLY -- no branch, order, or
// verdict is altered.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import chains from "../container/chains-lib.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const gate = fs.readFileSync(path.join(repoRoot, "container", "gate.js"), "utf8");

// ---- RUNNING test. This one executes the real predicate. ----
// It is the evidence that the wording list was not the holder, which is the
// whole reason the missing cause mattered: the obvious suspect was innocent and
// nothing in the log could show it.
test("the wording list is provably NOT what gated the measured card", () => {
  const title = "Note the odd group ownership on engine worktree git internals";
  assert.equal(
    chains.humanGateReason({ title, body: "" }, { classifierFollows: true }), null,
    "the board path's own pre-filter clears this title -- so a consequence gate on it came from elsewhere",
  );
  assert.equal(
    chains.humanGateReason({ title, body: "" }), null,
    "and it clears the stricter default path too, so no allowlist opt-in is masking a match",
  );
});

// A card that genuinely trips the list must still gate, so the cause string
// cannot have been bought by weakening the gate.
//
// Asserts the exact verdict, not merely non-null. Kimi caught the first version
// of this test claiming more in its name than it checked -- and the value is
// "consequence", not "wording", so the original name was wrong twice over. A
// test whose name overclaims is the fake-builder lesson in miniature.
test("a genuinely dangerous card still gates, and still reports consequence", () => {
  for (const title of ["Deploy the box to production", "Send the launch email to the list"]) {
    assert.equal(
      chains.humanGateReason({ title, body: "" }, { classifierFollows: true }), "consequence",
      title + " must still return the consequence verdict, unchanged by this commit",
    );
  }
  assert.equal(
    chains.humanGateReason({ title: "Refactor the parser", body: "" }, { classifierFollows: true }), null,
    "and ordinary work must still come back clean -- the gate did not get broader either",
  );
});

// ---- SOURCE-READING tests, and labelled as such. ----
// boardTick is not exported and has no injection seam -- the same limit
// gated-backlog-reminder.test.js records for the same code path. These show the
// code says the right thing, not that it does it. Stated plainly rather than
// dressed up as behavioural coverage (the PR #127 fake-builder lesson).
test("every consequence branch carries a distinct cause", () => {
  const decision = gate.match(/function gitProposalGateDecision\(task, settings\)[\s\S]*?\n\}/);
  assert.ok(decision, "gitProposalGateDecision must exist as the single place the branches are decided");
  const body = decision[0];
  for (const marker of [
    /cause: reason \? /,                       // the no-change path
    /already merged/,                          // status === "merged"
    /structured git-ladder policy/,            // structuredGitLadder wording match
    /does not grant git rung 1/,               // the capability case -- the suspected holder
  ]) {
    assert.match(body, marker, "each branch must name its own cause, or the log cannot tell them apart");
  }
  assert.ok(
    !/return "consequence";/.test(body),
    "no branch may return a bare verdict -- that is exactly the shape that lost the cause",
  );
});

test("the reason wrapper stays thin, so there is no second copy to drift", () => {
  assert.match(
    gate,
    /function gitProposalGateReason\(task, settings\) \{\s*return gitProposalGateDecision\(task, settings\)\.reason;\s*\}/,
    "every existing caller must keep working through a one-line wrapper, not a duplicated branch chain",
  );
});

test("the audit line appends the cause and keeps the recognisable prefix", () => {
  assert.match(
    gate,
    /audit\(event, String\(gated\.assignee\) \+ ": " \+ String\(gated\.title\)\.slice\(0, 55\)\s*\+ \(decision\.cause \? " -- " \+ String\(decision\.cause\)\.slice\(0, 120\) : ""\)/,
    "the cause is appended and bounded; the assignee+title prefix is how the operator recognises the card",
  );
});
