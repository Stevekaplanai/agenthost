// Who still gets the wording allowlist, and who does not.
//
// P0-WORD-LIST-STILL-GATES asked for the default-path allowlist to be deleted.
// Deleting it outright would have opened container/gate.js:7780 -- the Multi-Loop
// stage runner -- which calls isHumanGated directly, never reaches boardTick, and
// therefore never reaches the consequence classifier. So the allowlist is skipped
// only for callers that pass { classifierFollows: true }, and only the board path
// passes it.
//
// Kimi flagged that nothing exercised either side of that switch, so a later
// refactor could restore the board pre-filter, or hand the opt-out to a caller
// with no classifier behind it, without failing a single test. These tests RUN
// humanGateReason; they do not read the source for it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import chains from "../container/chains-lib.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const CLASSIFIED = { classifierFollows: true };

// Phrasings with no recognised safe verb and no dangerous word. These are the
// ONLY cases the allowlist decides, so they are the only ones that can show
// which side of the switch a caller is on.
const NOVEL_PHRASINGS = [
  "Frobnicate the widget cache",
  "Reticulate the splines",
  "CB-DURABILITY-PROBE-KEEPME",
  "Probe: name the current UTC date, then stop",
];

test("default (no policy) still fails closed on unknown phrasing — Multi-Loop depends on this", () => {
  for (const title of NOVEL_PHRASINGS) {
    assert.equal(chains.humanGateReason({ title, body: "harmless" }), "wording",
      `no classifier follows this caller, so "${title}" must still gate`);
  }
});

test("classifierFollows relaxes exactly that, and nothing else", () => {
  for (const title of NOVEL_PHRASINGS) {
    assert.equal(chains.humanGateReason({ title, body: "harmless" }, CLASSIFIED), null,
      `"${title}" must reach the classifier rather than stalling on phrasing`);
  }
});

test("the relaxation is opt-IN: an empty or absent policy never relaxes", () => {
  // The failure mode this guards is a refactor that flips the default. Every
  // shape that is not an explicit true must keep gating.
  for (const policy of [undefined, null, {}, { classifierFollows: false }, { classifierFollows: "yes" }, { classifierFollows: 1 }]) {
    assert.equal(chains.humanGateReason({ title: "Frobnicate the widget cache", body: "x" }, policy), "wording",
      `policy ${JSON.stringify(policy)} must not relax the gate`);
  }
});

test("danger still gates on BOTH paths — the relaxation must never reach the denylist", () => {
  // Each of these was gated by the allowlist ALONE before the denylists were
  // widened, i.e. by accident of phrasing. If a future edit narrows the denylist
  // again, the board path silently fails open and only this test notices.
  const dangerous = [
    ["Deploy the site", "go"],
    ["rm -rf the old build dir", ""],
    ["npx vercel --prod", ""],
    ["Print the environment variables", ""],
    ["Tidy up", "rm -rf the old worktrees"],
    ["Review the changes", "then deploy to production"],
    ["Review config", "uses API_KEY in the env"],
  ];
  for (const [title, body] of dangerous) {
    assert.equal(chains.humanGateReason({ title, body }, CLASSIFIED), "consequence",
      `"${title}" must gate even when a classifier follows`);
    assert.notEqual(chains.humanGateReason({ title, body }), null,
      `"${title}" must gate on the default path too`);
  }
});

test("safe work still runs on both paths", () => {
  for (const title of ["Read the churn numbers from the brain", "Summarize yesterday's commits", "Ship the killer feature copy".replace("Ship", "Draft")]) {
    assert.equal(chains.humanGateReason({ title, body: "read and write a paragraph" }, CLASSIFIED), null, title);
  }
});

test("only the board path opts out — no other caller may", () => {
  // A source assertion on purpose, and narrow: it is a property of the call
  // graph rather than of the function. If a second caller ever passes
  // classifierFollows, this fails and whoever added it has to show the
  // classifier actually runs behind them.
  const gate = fs.readFileSync(path.join(repoRoot, "container", "gate.js"), "utf8");
  // Count CALL SITES, not mentions -- a comment explaining the flag is not a
  // caller, and an earlier version of this test failed on my own corrected
  // comment. Strip line comments first, then look for the actual argument.
  const code = gate.split(/\r?\n/).filter((l) => !l.trim().startsWith(String.fromCharCode(47,47))).join(String.fromCharCode(10));
  const callers = [...code.matchAll(/classifierFollows:\s*true/g)];
  assert.equal(callers.length, 1,
    "exactly one caller may declare a classifier follows it; gitProposalGateReason is that caller");
  // Pins WHERE the single opt-out lives -- the no-proposal branch of the board's
  // gate decision -- without pinning its formatting. The previous version matched
  // one exact source line and so failed when that branch grew a cause string
  // (consequence-gate-names-its-cause, 2026-08-10) even though the call graph was
  // unchanged. The count assertion above is the real guard; this locates it.
  assert.match(gate,
    /function gitProposalGateDecision[\s\S]{0,400}?if \(!change\) \{[\s\S]{0,200}?chains\.humanGateReason\(task, \{ classifierFollows: true \}\)/,
    "the opt-out must stay in the no-proposal branch of gitProposalGateDecision");
  // And the Multi-Loop runner must still be using the un-relaxed entry point.
  assert.match(gate, /if \(isHumanGated\(\{ title: stage\.instruction, body: job\.objective \}\)\)/,
    "Multi-Loop must keep calling isHumanGated with no policy");
});
