// Handoff re-proposal CIRCUIT BREAKER (Steve, 2026-07-20). The failsafe for the
// overnight runaway: the autonomous board spawned 55 near-identical cards over 11
// HOURS -- all ONE task ("write dev-mode-epics.html to ~/artifacts and verify")
// that never converged, re-proposed under endlessly-varied titles. The retry loop
// was already bounded (MAX_REJECT_CYCLES); the LEAK was that every failed/rejected
// cycle ALSO proposed a fresh standalone HANDOFF card for the same work, and that
// path had no cap. The breaker caps re-proposals of the same task (grouped by
// token signature, the SAME notion of "same task" the loop detector uses) and,
// on the (cap+1)th, parks the originating card ONCE for a human instead of
// spawning. These tests lock the boundaries that matter and FEED THE REAL
// INCIDENT so a regression that re-opens the runaway fails loudly.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  handoffSignature,
  matchHandoffSignature,
  handoffBreakerStep,
  HANDOFF_SHARED_TOKEN_FLOOR,
  MAX_HANDOFF_REPROPOSALS,
} from "../container/gate.js";

// The ACTUAL varied titles from the incident report (the same one task, worded
// five different ways). A title-equality breaker would give each its own counter
// and never catch the runaway -- these MUST all fold to one signature.
const INCIDENT_EPICS_TITLES = [
  "Write the drafted dev-mode-epics.html to ~/artifacts and verify",
  "Save the corrected dev-mode-epics HTML to the artifacts folder and verify it",
  "Find the raw HTML and write dev-mode-epics.html to artifacts then verify",
  "Re-create the dev-mode epics task with the HTML content included and verify",
  "Pull the dev-mode epics card body via a chat-turn shell and write the html",
];
// The ONE genuinely distinct card that was on the same board -- it must NOT be
// swept into the epics loop's counter (task self-review point (d)).
const DISTINCT_PRD = "Review the Dev Mode PRD";

test("constants are sane: cap is small and below the loop-detector floor", () => {
  assert.equal(MAX_HANDOFF_REPROPOSALS, 2, "cap should be 2 (propose twice, park the 3rd)");
  assert.ok(HANDOFF_SHARED_TOKEN_FLOOR >= 3, "need >=3 shared tokens to group (kills the 2-generic-word false group)");
});

test("handoffSignature: same tokens -> same key; too-short -> empty (never counted)", () => {
  const a = handoffSignature("Write dev-mode epics html to artifacts");
  const b = handoffSignature("epics html write artifacts dev mode"); // same token set, reordered
  assert.equal(a, b, "token SET is order-independent -> stable key");
  assert.equal(handoffSignature("go"), "", "a title with <2 significant tokens is unidentifiable");
  assert.equal(handoffSignature(""), "", "empty title -> empty signature");
  assert.equal(handoffSignature(null), "", "null title never throws -> empty signature");
});

test("matchHandoffSignature: varied incident titles fold to ONE bucket", () => {
  // Seed the bucket with the first incident title, then every OTHER varied title
  // must match that same bucket key (not seed its own).
  const seedSig = handoffSignature(INCIDENT_EPICS_TITLES[0]);
  const known = [seedSig];
  for (const title of INCIDENT_EPICS_TITLES.slice(1)) {
    const matched = matchHandoffSignature(title, known);
    assert.equal(matched, seedSig, `"${title}" should fold into the epics bucket, got "${matched}"`);
  }
});

test("matchHandoffSignature: the distinct PRD-review card does NOT fold into the epics loop", () => {
  // This is the false-group the task explicitly warns against: {dev,mode,prd}
  // shares only the 2 GENERIC words dev+mode with the epics seed. The >=3 shared
  // significant-token floor must exclude it, or a legit distinct card gets
  // wrongly counted toward (and eventually blocked by) the runaway.
  const seedSig = handoffSignature(INCIDENT_EPICS_TITLES[0]);
  const matched = matchHandoffSignature(DISTINCT_PRD, [seedSig]);
  assert.notEqual(matched, seedSig, "the distinct PRD card must NOT match the epics bucket");
  assert.equal(matched, handoffSignature(DISTINCT_PRD), "it should seed its OWN signature instead");
});

test("matchHandoffSignature: fully unrelated cards never group", () => {
  const seedSig = handoffSignature(INCIDENT_EPICS_TITLES[0]);
  for (const t of [
    "Fix the Gemini terminal GEMINI_API_KEY not loading in the box",
    "Add a click-to-call phone number to the Curb Club sticky header",
  ]) {
    assert.notEqual(matchHandoffSignature(t, [seedSig]), seedSig, `"${t}" must not join the epics bucket`);
  }
});

// ---- THE INCIDENT REPLAY ----------------------------------------------------
// Feed the real varied-title re-proposal sequence through the ACTUAL breaker step
// (handoffBreakerStep -- the same pure function createProposedHandoffs calls in
// production) and assert it caps + parks after MAX_HANDOFF_REPROPOSALS instead of
// allowing unbounded spawn. THIS is the test that proves the 55-card runaway is
// stopped.
test("INCIDENT REPLAY: the varied epics re-proposals cap + park, they do NOT spawn forever", () => {
  const counter = {};
  const actions = INCIDENT_EPICS_TITLES.map((t) => handoffBreakerStep(counter, t).action);
  // First MAX_HANDOFF_REPROPOSALS spawn; every one after that parks.
  const expected = INCIDENT_EPICS_TITLES.map((_, i) => (i < MAX_HANDOFF_REPROPOSALS ? "spawn" : "park"));
  assert.deepEqual(actions, expected, `expected ${expected.join(",")} got ${actions.join(",")}`);
  // Exactly ONE bucket, pinned at the cap (not climbing past it).
  const keys = Object.keys(counter);
  assert.equal(keys.length, 1, "all varied titles must collapse to a single counter bucket");
  assert.equal(counter[keys[0]], MAX_HANDOFF_REPROPOSALS, "counter pins AT the cap, never past it");
});

test("INCIDENT REPLAY: keeps parking on continued re-proposals (no runaway resumes)", () => {
  const counter = {};
  // Drive the cap with the first title repeated, then simulate 20 more varied
  // re-proposals -- a real overnight runaway. Every one past the cap must park.
  for (let i = 0; i < MAX_HANDOFF_REPROPOSALS; i++) handoffBreakerStep(counter, INCIDENT_EPICS_TITLES[0]);
  let parks = 0, spawns = 0;
  for (let i = 0; i < 20; i++) {
    const d = handoffBreakerStep(counter, INCIDENT_EPICS_TITLES[i % INCIDENT_EPICS_TITLES.length]);
    if (d.action === "park") parks++; else spawns++;
  }
  assert.equal(spawns, 0, "past the cap, NOTHING spawns -- the runaway is fully stopped");
  assert.equal(parks, 20, "every re-proposal past the cap parks for the human");
});

test("the distinct PRD card still SPAWNS while the epics loop is capped (no collateral block)", () => {
  const counter = {};
  // Drive the epics bucket to its cap.
  for (const t of INCIDENT_EPICS_TITLES) handoffBreakerStep(counter, t);
  // A genuinely distinct card proposed on the same board must still be allowed
  // through -- the breaker parks only the runaway, not everything.
  const d = handoffBreakerStep(counter, DISTINCT_PRD);
  assert.equal(d.action, "spawn", "the distinct card must spawn, not be caught in the epics cap");
});

test("unidentifiable (too-short) titles always spawn and are never counted", () => {
  const counter = {};
  for (let i = 0; i < 10; i++) {
    const d = handoffBreakerStep(counter, "go"); // < 2 significant tokens
    assert.equal(d.action, "spawn", "an unidentifiable proposal can't be grouped -> never capped");
    assert.equal(d.sig, "", "no signature -> not counted");
  }
  assert.equal(Object.keys(counter).length, 0, "unidentifiable proposals leave the counter empty");
});

test("two genuinely different tasks each get their OWN cap (independent buckets)", () => {
  const counter = {};
  const taskA = "Write the dev-mode epics html artifact and verify it";
  const taskB = "Draft the Founding 50 welcome email sequence in Resend and review";
  // Interleave: A, B, A, B, A -> A hits cap on its 3rd, B still under.
  assert.equal(handoffBreakerStep(counter, taskA).action, "spawn"); // A #1
  assert.equal(handoffBreakerStep(counter, taskB).action, "spawn"); // B #1
  assert.equal(handoffBreakerStep(counter, taskA).action, "spawn"); // A #2
  assert.equal(handoffBreakerStep(counter, taskB).action, "spawn"); // B #2
  assert.equal(handoffBreakerStep(counter, taskA).action, "park");  // A #3 -> capped
  assert.equal(handoffBreakerStep(counter, taskB).action, "park");  // B #3 -> capped
  assert.equal(Object.keys(counter).length, 2, "two distinct tasks -> two buckets");
});

test("handoffBreakerStep never throws on junk input (load-bearing: can't wedge boardTick)", () => {
  assert.doesNotThrow(() => handoffBreakerStep(null, "some title"));
  assert.doesNotThrow(() => handoffBreakerStep({}, null));
  assert.doesNotThrow(() => handoffBreakerStep(undefined, undefined));
  // A junk counter value on a matched signature must not blow up the arithmetic.
  const c = { "dev,epics,html": "not-a-number" };
  assert.doesNotThrow(() => handoffBreakerStep(c, "Write dev epics html"));
});

test("cap is respected exactly at the boundary (cap-th spawns, cap+1-th parks)", () => {
  const counter = {};
  const title = "Write the dev-mode epics html artifact to disk and verify it";
  const results = [];
  for (let i = 0; i < MAX_HANDOFF_REPROPOSALS + 1; i++) results.push(handoffBreakerStep(counter, title).action);
  // e.g. cap=2 -> [spawn, spawn, park]
  assert.deepEqual(
    results,
    [...Array(MAX_HANDOFF_REPROPOSALS).fill("spawn"), "park"],
    "the cap-th proposal spawns; the (cap+1)-th parks"
  );
});
