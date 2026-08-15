// isCapabilityGap decides whether a review REJECT means "the assigned engine
// structurally cannot do this in its sandbox" (block for a human to REASSIGN)
// vs. "the work has a fixable quality problem" (bounded correction re-run).
// Getting this wrong is the live 2026-07-18 thrash: codex-in-jail "sandbox
// failed to open the repo files" was treated as a normal reject, so the
// orchestrator re-ran codex -> same failure -> reject -> forever (blocked-every-
// 30s in the audit log). This test locks the classifier.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isCapabilityGap } from "../container/gate.js";

test("capability-gap reject reasons block-and-reassign (not re-run)", () => {
  const gaps = [
    "Codex's sandbox failed to open the repo files entirely",
    "reassign to an engine with working repo read access",
    "could not read /data/home/agent/agenthost-internal/marketing/ANDROMEDA-CAMPAIGN.md",
    "the source files were absent from the read-jail",
    "permission denied opening the campaign file",
    "no network access to fetch the verification URL",
    "the autonomous read-jail failed before any source files could be opened",
    "repo files were not accessible from the sandbox",
  ];
  for (const t of gaps) assert.equal(isCapabilityGap(t), true, `should be a capability gap: ${JSON.stringify(t)}`);
});

test("normal quality rejects do NOT read as a capability gap (they get a correction re-run)", () => {
  const quality = [
    "The copy has a typo in paragraph 3, fix it",
    "This claim exceeds honest-claims.json -- tighten the guarantee wording",
    "Day 14's CTA is missing the link",
    "Only 27 of the 30 specs are present; three are stubs",
    "The tone is off-brand, rewrite the hook",
    "VERDICT: REJECT. The math in the table is wrong.",
    "",
    null,
  ];
  for (const t of quality) assert.equal(isCapabilityGap(t), false, `should NOT be a capability gap: ${JSON.stringify(t)}`);
});
