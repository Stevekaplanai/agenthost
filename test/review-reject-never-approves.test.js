// A REJECT must never come out the other side as an approval.
//
// The API-fallback reviewer's rejection had no branch. `if (apiM)` handled
// APPROVE and returned; a REJECT hit a comment that said "treat as a real
// reject" and then fell straight through to the no-verdict handling below,
// whose FIRST branch auto-approves when no other reviewer is available:
//
//   "--- auto-approve (no reviewers available) ---
//    All reviewers failed or unavailable. Task auto-approved to keep the board
//    moving."
//
// So the task completed and pushed "Task approved" on an explicit REJECT. That
// branch is reachable exactly when it is most likely: it requires every other
// reviewer to be down, and codex has been failing every review all day, which
// makes engineRecentlyFailed(codex) true and noFallbackReviewer() with it.
//
// Rule 13 gives up a lot of gates. It never gives up this one: "No setting or
// trust level ever lets an agent merge UNREVIEWED code." Shipping REJECTED code
// is worse than shipping unreviewed code -- the review ran, said no, and the
// system recorded yes.
//
// ---------------------------------------------------------------------------
// ON THE SHAPE OF THIS TEST, honestly: it reads gate.js as TEXT and asserts on
// control flow, the same pattern as test/gate-command-center.test.js:874. It
// executes nothing. It cannot prove the runtime behaviour and it will need
// updating if the surrounding code is refactored.
//
// It is here anyway because the alternative was nothing: this branch sits deep
// inside board dispatch behind a durable claim, a kanban CLI, a chains file and
// a lease, and there is no seam to call it through. The absence of any test on
// this path is how a reject-becomes-approve shipped in the first place. A weak
// guard on the one invariant that must not break beats an honest gap.
//
// If someone extracts the verdict decision into a pure function, delete this
// and test that instead. That is the real fix.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const src = fs.readFileSync(path.join(process.cwd(), "container", "gate.js"), "utf8");

// The API-fallback reviewer's block: from its verdict parse to the no-verdict
// handling that follows it.
const REJECT_MARK = "// API reviewer REJECTED.";
const FALLTHROUGH_MARK = "if (noFallbackReviewer(author, fallbackApi))";

test("the API fallback reviewer's REJECT branch exists at all", () => {
  assert.ok(src.includes(REJECT_MARK), "the REJECT case must be handled where the fallback verdict is parsed");
  assert.ok(src.includes(FALLTHROUGH_MARK), "the no-verdict auto-approve branch is still the thing being guarded against");
  assert.ok(src.indexOf(REJECT_MARK) < src.indexOf(FALLTHROUGH_MARK),
    "the REJECT case must come BEFORE the auto-approve branch it must not reach");
});

test("a rejected task parks for the operator and never reaches auto-approve", () => {
  const between = src.slice(src.indexOf(REJECT_MARK), src.indexOf(FALLTHROUGH_MARK));

  assert.match(between, /parkForReview\(/,
    "a rejection must park for the operator -- it is a verdict, not a missing verdict");
  assert.match(between, /audit\("autonomy_reject"/,
    "and must be audited as a REJECT, so the log does not read like a no-verdict");
  assert.match(between, /finishClaimedBoardTask\(task, holder, release, false\)/,
    "and must release the claim WITHOUT marking the task done");
  assert.doesNotMatch(between, /hermesKanban\(\["complete"/,
    "a rejected task must never be completed on the board");

  // The whole point: control flow must not continue into the auto-approve.
  const tail = between.slice(between.lastIndexOf("});"));
  assert.match(tail, /\breturn\b/,
    "the REJECT branch must RETURN -- falling through is what turned a reject into an approve");
});

test("the no-verdict auto-approve still describes itself as no-verdict only", () => {
  const idx = src.indexOf(FALLTHROUGH_MARK);
  const preceding = src.slice(idx - 400, idx);
  assert.doesNotMatch(preceding, /or rejected/,
    "the comment above the auto-approve must no longer claim it handles rejections, because it must not receive any");
});

// ---------------------------------------------------------------------------
// The same invariant, one surface further out: when the review layer approves
// something NOTHING reviewed, the operator must be told that.
//
// All three auto-approve sites audited their cause honestly -- "no reviewers",
// "all reviewers down", "no verdict, no reviewers" -- and then pushed the
// operator a notification reading only "Task auto-approved". On a phone that is
// indistinguishable from a task that passed a real review. The log was honest
// and the surface he actually reads was not, which is Rule 16's whole subject.
//
// It matters most exactly when it is wrong most: the branch requires every
// reviewer to be down, and codex has been failing every review all day
// (P0-CODEX-CANNOT-REVIEW), so this is the live case, not a hypothetical.
//
// Same text-assertion caveat as everything above: this reads source, it does
// not execute the path. Delete it in favour of a real test the moment the push
// decision gains a seam.
test("an auto-approve push must name the reason nothing reviewed it", () => {
  assert.doesNotMatch(src, /pushPayload\("Task auto-approved"/,
    'a bare "Task auto-approved" push cannot be told apart from a real approval');

  const titles = [...src.matchAll(/pushPayload\("(Auto-approved:[^"]*)"/g)].map((m) => m[1]);
  assert.ok(titles.length >= 3,
    "every auto-approve site must push a cause-carrying title; found " + titles.length);

  for (const title of titles) {
    assert.ok(title.length <= 38,
      'push titles are clamped at PUSH_TITLE_MAX=38; "' + title + '" is ' + title.length +
      " and would be silently truncated -- a cause cut in half is not a cause");
    assert.match(title, /no reviewer available|no usable verdict/,
      'the title must say WHICH failure produced the approval, not merely that one happened: "' + title + '"');
  }
});
