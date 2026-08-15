// `triage` is a trap state: the board hands it out to nobody, so the gate must
// stop asking — and must say so once instead of going quiet.
//
// Measured against the live CLI on 2026-08-09 (TRIAGE-IS-A-TRAP-STATE):
//
//   claim    -> refuses: "cannot claim <id>: status=triage lock=(none)"  EXIT 0
//   promote  -> refuses: "promote only applies to 'todo' or 'blocked'"
//   complete -> refuses: "unknown id or terminal state"
//   block    -> no-ops; it only acts on `running`
//   archive  -> the ONLY verb that moves it
//
// canonical-board maps triage into the "queued" LANE, which is correct for the
// UI — the operator should see it waiting — and the gate reused that same lane
// as its DISPATCH predicate. So boardTick picked the card up every tick, the
// board refused, and neither side could move it: 22 identical audit rows in
// twenty minutes for one card.
//
// The bridge note attributes this to RUNNER_QUEUEDISH. That constant drives
// stuck-detection (gate.js ~14245), not dispatch; changing it would not have
// stopped the loop. The dispatch predicate is BOARD_COLUMN. Pinned here because
// the next person to read that note will otherwise edit the wrong constant.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import canonicalBoard from "../container/canonical-board.js";

const LF = String.fromCharCode(10);
const src = fs.readFileSync(path.join(process.cwd(), "container", "gate.js"), "utf8")
  .split(String.fromCharCode(13) + LF).join(LF);

test("triage still displays in the queued lane -- dispatch is fixed, not the UI", () => {
  // The tempting fix is to remap triage out of "queued". That stops dispatch by
  // HIDING the card from the column the operator watches: a loud loop traded for
  // a silent disappearance. Display and dispatch are different questions.
  assert.equal(canonicalBoard.RAW_STATUS_LANE.triage, "queued",
    "triage must keep displaying as queued; the fix belongs in the dispatch predicate");
});

test("both dispatch filters exclude unclaimable statuses", () => {
  // Two filters select cards each tick: `eligible` (dispatch) and `gatedAll`
  // (the awaiting-approval announcement). A trapped card left in the second
  // would stop looping and start nagging instead -- same card, new noise.
  const filters = [...src.matchAll(/BOARD_COLUMN\[t\.status\] === "queued"/g)];
  assert.ok(filters.length >= 2, "expected both the eligible and gatedAll filters");

  for (const m of filters) {
    const window = src.slice(m.index, m.index + 200);
    assert.match(window, /!BOARD_UNCLAIMABLE\.has\(String\(t\.status \|\| ""\)\)/,
      "every queued-lane filter must also exclude unclaimable statuses");
  }
});

test("triage is the unclaimable set, and the set is not empty by accident", () => {
  const m = src.match(/const BOARD_UNCLAIMABLE = new Set\(\[([^\]]*)\]\)/);
  assert.ok(m, "BOARD_UNCLAIMABLE must exist");
  assert.match(m[1], /"triage"/, "triage is the measured trap state");
});

test("a trapped card is announced ONCE, and names the verb that moves it", () => {
  const start = src.indexOf("PARK LOUDLY, ONCE");
  assert.ok(start > 0, "the park-loudly block must exist -- silence is the other failure mode");
  const block = src.slice(start, start + 2000);

  assert.match(block, /trappedAudited\.has\(key\)/, "must dedup, or it recreates the 22-rows flood");
  assert.match(block, /trappedAudited\.add\(key\)/);
  assert.match(block, /audit\("autonomy_task_unclaimable"/, "and must audit under its own event name");
  assert.match(block, /only archive moves it/,
    "the message must name the ONE verb that works -- a reader who does not know that tries claim and promote first");

  // CORRECTED (Kimi K3, LOW, #330). This used to assert that keying on
  // id:status is what lets a returning card speak again. It is not: a card that
  // leaves triage and falls back in produces the SAME key and stays suppressed.
  // The assertion passed while the property did not hold -- a test agreeing with
  // a comment, both wrong about the code, which is the exact defect this change
  // is about.
  //
  // What actually makes it true is FORGETTING the card when it is seen out of
  // the trap. Assert that instead.
  assert.match(block, /trappedAudited\.delete\(k\)/,
    "the card must be forgotten once it escapes, or the dedup silences it forever");
  assert.match(block, /String\(t\.id\) \+ ":"/,
    "and the clear must be keyed by id prefix, so any status it returns from is cleared");
});

// The announcement must fire on a BUSY board too.
//
// (Kimi K3, MEDIUM, reviewing #330.) The park-loudly block was written inside
// `if (!eligible.length)`, so it only ran on a board with nothing dispatchable.
// Any board with real work would never announce a trapped card -- exactly the
// silent parking the bridge note objected to, and exactly the property the PR
// body claimed to have. A guard that only speaks when nothing else is happening
// is the quiet failure this whole change exists to remove.
test("the trapped-card announcement runs every tick, not only on an idle board", () => {
  const start = src.indexOf("PARK LOUDLY, ONCE");
  assert.ok(start > 0, "the park-loudly block must exist");

  const before = src.slice(0, start);
  const idleBranch = before.lastIndexOf("if (!eligible.length) {");
  const closed = idleBranch === -1
    ? true
    // If an idle-branch opener appears before the block, it must have been
    // closed before it -- otherwise the announcement is nested inside it.
    : before.slice(idleBranch).includes("\n    }");
  assert.ok(closed,
    "the announcement must not be nested inside the !eligible.length branch -- "
    + "a busy board would never announce a trapped card");
});
