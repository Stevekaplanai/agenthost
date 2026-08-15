// Duplicate-loop detector (Steve, 2026-07-19). detectLoopClusters flags a pile-up
// of near-duplicate queued cards -- the failsafe for the overnight incident where
// the autonomous review pipeline re-proposed the same RT-12/RT-13 ARD review 9x in
// varied wording, invisible until Steve manually counted the queued column. These
// tests lock the two boundaries that matter: it MUST fire on the real varied-title
// case, and MUST stay silent on genuinely distinct cards.
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectLoopClusters, LOOP_ALERT_THRESHOLD } from "../container/gate.js";

// mk: minimal board card. Real cards carry id/title/status/body/assignee; the
// detector only reads id/title/status.
const mk = (id, title, status = "ready") => ({ id, title, status });

test("the real 9-card RT-12/RT-13 loop (VARIED titles) fires as one cluster", () => {
  // These are the actual incident titles (paraphrased from the task report): NOT
  // string-identical, but semantically the same loop. A title-equality detector
  // would miss every one of them.
  const tasks = [
    mk("t1", "Review rev-3 Dev Mode ARD for RT-12 and RT-13 bypasses"),
    mk("t2", "Adversarially verify the two RT-12/RT-13 gaps in the Dev Mode ARD"),
    mk("t3", "Attack RT-12 worker-identity binding and RT-13 retarget under the ARD"),
    mk("t4", "Tighten ARD 3.4 deep-freeze for RT-12 and RT-13 Dev Mode"),
    mk("t5", "Re-verify RT-12 and RT-13 ARD Dev Mode bypasses adversarially"),
    mk("t6", "Harden the RT-12/RT-13 Dev Mode ARD against the identified gaps"),
    mk("t7", "Attack the RT-12 and RT-13 Dev Mode ARD freeze once more"),
    mk("t8", "Verify RT-12 RT-13 Dev Mode ARD retarget binding gaps"),
    mk("t9", "Deep-freeze RT-12 and RT-13 in the Dev Mode ARD rev-3"),
  ];
  const clusters = detectLoopClusters(tasks);
  assert.ok(clusters.length >= 1, "expected at least one loop cluster");
  const biggest = clusters[0];
  assert.ok(biggest.count >= LOOP_ALERT_THRESHOLD, `cluster count ${biggest.count} should be >= threshold ${LOOP_ALERT_THRESHOLD}`);
  // It should catch the bulk of the pile-up, not just the threshold minimum.
  assert.ok(biggest.count >= 7, `expected the varied-title loop to cluster tightly, got ${biggest.count}`);
});

test("3 genuinely DISTINCT cards do NOT alert (no false positive)", () => {
  const tasks = [
    mk("a", "Write the Founding 50 welcome email sequence in Resend"),
    mk("b", "Fix the Gemini terminal GEMINI_API_KEY not loading in the box"),
    mk("c", "Add a click-to-call phone number to the Curb Club sticky header"),
  ];
  const clusters = detectLoopClusters(tasks);
  assert.equal(clusters.length, 0, "unrelated cards must not form a loop cluster");
});

test("a normal 2-3 RELATED follow-ups stay under the threshold (no over-fire)", () => {
  // Related work, but only 3 cards -- below the >=4 floor. Should not alert even if
  // they cluster, because a runaway loop is defined by VOLUME, not mere similarity.
  const tasks = [
    mk("r1", "Add the pricing section to the AgentHost landing page"),
    mk("r2", "Add the FAQ section to the AgentHost landing page"),
    mk("r3", "Add the testimonials section to the AgentHost landing page"),
  ];
  const clusters = detectLoopClusters(tasks);
  assert.equal(clusters.length, 0, "3 similar cards is under the alert floor");
});

test("threshold boundary: 3 identical cards silent, 4 fires", () => {
  const three = [1, 2, 3].map((i) => mk("x" + i, "Re-verify the RT-12 RT-13 ARD deep-freeze bypasses"));
  assert.equal(detectLoopClusters(three).length, 0, "3 is below threshold");
  const four = [1, 2, 3, 4].map((i) => mk("y" + i, "Re-verify the RT-12 RT-13 ARD deep-freeze bypasses"));
  const c = detectLoopClusters(four);
  assert.equal(c.length, 1, "4 identical cards must fire");
  assert.equal(c[0].count, 4);
});

test("only queued-ish cards count -- running/done/review don't inflate a cluster", () => {
  const base = "Re-verify the RT-12 RT-13 ARD deep-freeze bypasses";
  const tasks = [
    mk("q1", base, "ready"),
    mk("q2", base, "triage"),
    mk("q3", base, "todo"),
    mk("q4", base, "running"), // in-flight, not a pile-up
    mk("q5", base, "done"),    // finished
    mk("q6", base, "review"),  // being judged
  ];
  // Only 3 are queued-ish (ready/triage/todo) -> below threshold -> silent.
  assert.equal(detectLoopClusters(tasks).length, 0, "non-queued statuses must not inflate the cluster");
});

test("blocked cards DO count (proposed-handoff children are created blocked)", () => {
  // createProposedHandoffs mints children with initial-status blocked; a genuine
  // loop of them piles up in `blocked` before any human promotes them.
  const base = "Attack RT-12 worker-identity binding and RT-13 retarget under the ARD";
  const tasks = [1, 2, 3, 4, 5].map((i) => mk("b" + i, base, "blocked"));
  const c = detectLoopClusters(tasks);
  assert.equal(c.length, 1, "a pile of blocked handoff-children is a loop too");
  assert.equal(c[0].count, 5);
});

test("cluster key is STABLE across ticks (so alert dedup recognizes the same loop)", () => {
  const base = "Re-verify the RT-12 RT-13 ARD deep-freeze bypasses";
  const t1 = [1, 2, 3, 4].map((i) => mk("k" + i, base));
  const t2 = [1, 2, 3, 4, 5].map((i) => mk("k" + i, base)); // same loop, one more card
  const k1 = detectLoopClusters(t1)[0].key;
  const k2 = detectLoopClusters(t2)[0].key;
  assert.equal(k1, k2, "the same recurring loop must produce the same key for idempotent dedup");
});

test("empty / malformed input never throws", () => {
  assert.equal(detectLoopClusters([]).length, 0);
  assert.equal(detectLoopClusters(null).length, 0);
  assert.equal(detectLoopClusters(undefined).length, 0);
  assert.equal(detectLoopClusters([{ id: "n", status: "ready" }]).length, 0); // no title
  assert.equal(detectLoopClusters([{ title: "x", status: "ready" }]).length, 0); // no id, single card
});
