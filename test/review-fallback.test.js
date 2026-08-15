// C1 succession: the review gate must survive the Codex wind-down. These tests
// pin (a) the API fallback reviewer pool and its selection order, (b) that the
// fallback path is injection-inert (the reviewer's reply is never fed to the
// board-intent or artifact writers the chat path uses), and (c) that the
// spawned-reviewer sets are UNCHANGED — the fallback adds a tier, it does not
// loosen the sandbox rule that keeps hermes out of spawned review.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const gate = fs.readFileSync(path.join(repoRoot, "container", "gate.js"), "utf8");

const sourceSet = (name) => {
  const match = gate.match(new RegExp(`const ${name} = new Set\\((\\[[^\\]]*\\])\\)`));
  assert.ok(match, `${name} is defined`);
  return JSON.parse(match[1]).sort();
};

test("the spawned reviewer sets are unchanged by the fallback tier", () => {
  assert.deepEqual(sourceSet("REVIEW_ENGINES"), ["claude", "codex", "gemini", "kimi"], "spawned review now includes Gemini and Kimi as sandboxed reviewers");
  assert.deepEqual(sourceSet("AUTONOMOUS_EXEC_ENGINES"), ["claude", "codex", "deepseek", "gemini", "hermes", "kimi"], "unattended execution includes the six contained non-Cursor engines");
  assert.deepEqual(sourceSet("GIT_CHANGE_ENGINES"), ["claude", "codex", "deepseek", "gemini", "hermes", "kimi"], "git-write authority includes all 6 exec engines with per-engine rung caps");
});

test("the API fallback pool exists, is ordered, and gemini is its first row", () => {
  const match = gate.match(/const API_REVIEW_ENGINES = (\[[^\]]*\])/);
  assert.ok(match, "API_REVIEW_ENGINES is defined");
  assert.deepEqual(JSON.parse(match[1]), ["gemini"], "gemini is the fallback reviewer");
});

test("the fallback is consulted only when no spawned reviewer exists", () => {
  assert.match(
    gate,
    /const spawnReviewer = pickReviewer\(author\);[\s\S]{0,400}const apiReviewer = spawnReviewer \? null : pickApiReviewer\(author\);/,
    "pickApiReviewer runs only when pickReviewer returned nothing",
  );
  // The spawned branch now picks its TRANSPORT by FOUNDATION_B --
  // runReviewViaChatSocket (root runs the engine as agent) when the flag is on,
  // runAutonomousTask (local spawn, where gate IS agent) when it is off. That is
  // the P0-CODEX-CANNOT-REVIEW fix: the reviewer was the one call site never
  // migrated to Foundation B, so it spawned as uid 997 and could not read
  // agent-owned 0600 credentials.
  //
  // The regex was widened, NOT weakened, and the distinction matters: this test
  // never existed to pin which runner is called. It exists to pin that the
  // spawned and API branches feed ONE verdict pipeline, so a fallback verdict
  // can never take a different path than a spawned one. That property is
  // asserted below and is unchanged.
  assert.match(
    gate,
    /\(spawnReviewer\s*\?\s*\([\s\S]{0,600}?runReviewViaChatSocket\(spawnReviewer, prompt[\s\S]{0,400}?runAutonomousTask\(eng, prompt,[\s\S]{0,300}:\s*runGeminiReviewOnce\(prompt\)\s*\)/,
    "the run site branches spawned-vs-API on the same verdict pipeline",
  );
  // ONE pipeline: whatever ran, exactly one .then consumes it.
  const site = gate.replace(/\r\n/g, "\n").slice(gate.replace(/\r\n/g, "\n").indexOf("(spawnReviewer\n"));
  assert.match(site.slice(0, 900), /runGeminiReviewOnce\(prompt\)\s*\)\.then\(\(result\)/,
    "both branches must be consumed by the same .then -- a second pipeline is how a fallback verdict starts being treated differently");
});

test("the fallback reviewer is injection-inert: its reply reaches only the verdict parser", () => {
  const start = gate.indexOf("function runGeminiReviewOnce(");
  assert.ok(start >= 0, "runGeminiReviewOnce is defined");
  const end = gate.indexOf("\nfunction ", start + 1);
  const body = gate.slice(start, end);
  for (const forbidden of ["runBoardIntents", "parseBoardIntents", "writeArtifacts", "parseArtifactBlocks", "appendTeamThread"]) {
    assert.ok(!body.includes(forbidden), `runGeminiReviewOnce never calls ${forbidden} — a poisoned result must not smuggle actions through the reviewer`);
  }
  assert.ok(body.includes("recordUsage(\"gemini\""), "metered review spend is recorded, never invisible");
  assert.ok(body.includes("beginEngineActivity(\"gemini\""), "a fallback review shows on the activity light like every other Gemini call");
  // The fail-closed BEHAVIOR (null on error/timeout/empty/SAFETY-block) is
  // proven by test/gemini-review-once.test.js against the real injected-fetch
  // path — not by a source pin.
});

test("a fallback APPROVE parks for the operator instead of completing (asymmetric trust)", () => {
  assert.match(
    gate,
    /if \(approved && apiReviewer\) \{[\s\S]{0,2200}parkForReview\(task, "the fallback reviewer \(/,
    "the API tier may reject autonomously but its approvals wait for a human — it cannot inspect the real work",
  );
  assert.match(gate, /audit\("autonomy_review_fallback_approve"/, "the parked approval is auditable");
});

test("gemini's fallback review requires its credential and an active engine", () => {
  assert.match(
    gate,
    /function pickApiReviewer\(author\) \{\s*return API_REVIEW_ENGINES\.find\(\(e\) => e !== author && engineActive\(e\) && geminiApiKeyPresent\(\)\)/,
    "author-exclusion, engine toggle, and credential presence all gate the fallback",
  );
});

test("the no-reviewer park message names the GEMINI_API_KEY remedy", () => {
  assert.match(gate, /add GEMINI_API_KEY to box secrets, or reassign the task/, "the operator is told the new remedy, not just the Codex login");
});
