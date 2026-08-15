// "2 tasks awaiting approval" is a status without a cause, and it is the exact
// shape Rule 16 exists to remove.
//
// The cost was real and measured. On 2026-08-10 two codex cards sat gated for
// six hours. The hourly audit line said only the count. There are TWO gates --
// wording and consequence -- they take DIFFERENT override keys, and granting the
// wrong key does nothing at all, silently. So an operator reading that line
// could not act on it: the only way to learn which key applied was to
// reimplement the gate decision by hand against the card's title, which is what
// I ended up doing.
//
// The information was never missing. gateReasonFor() is called on every card in
// the same filter, three lines above the audit call, and its answer was dropped.
import test from "node:test";
import assert from "node:assert/strict";
import gate from "../container/gate.js";

const { gatedBacklogBreakdown } = gate;

test("a single consequence-gated card names the key an operator must grant", () => {
  assert.equal(gatedBacklogBreakdown(["consequence"]), "1 consequence_gate");
});

test("the two gates are counted separately, because they take different keys", () => {
  const out = gatedBacklogBreakdown(["wording", "consequence", "consequence"]);
  assert.match(out, /1 wording_gate/);
  assert.match(out, /2 consequence_gate/);
});

test("a gate the caller could not classify says so instead of guessing", () => {
  // Folding an unknown reason into either bucket would send an operator to grant
  // a key that does nothing -- the same silent failure, one layer further on.
  assert.equal(gatedBacklogBreakdown([null]), "1 unclassified");
  assert.equal(gatedBacklogBreakdown(["something-new"]), "1 unclassified");
});

test("an empty or missing backlog produces no phrase to append", () => {
  assert.equal(gatedBacklogBreakdown([]), "");
  assert.equal(gatedBacklogBreakdown(undefined), "");
});

test("the real gate decision for the cards that actually stalled resolves to consequence", async () => {
  // Not a hypothetical. These are the two live card titles that sat for six
  // hours, run through the REAL decision function rather than a fixture, so this
  // test fails if the classification changes underneath the breakdown.
  const chains = (await import("../container/chains-lib.js")).default;
  const stalled = [
    "Review the patch and deploy the changes to the agenthost-internal container.",
    "Review the patch at /workspace/gate.js and deploy if correct",
  ];
  const reasons = stalled.map((title) =>
    chains.humanGateReason({ title }, { classifierFollows: true }));
  assert.deepEqual(reasons, ["consequence", "consequence"],
    "both stalled cards are held by the consequence gate -- the audit line must be able to say so");
  assert.equal(gatedBacklogBreakdown(reasons), "2 consequence_gate",
    "which is exactly the phrase that would have ended a six-hour stall in one read");
});
