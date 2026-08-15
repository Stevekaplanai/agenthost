// Off-box review recording endpoint (/review): PATH B per Steve's 2026-08-08
// decision. Off-box agents record reviews through the box's git-ladder so
// agenthost/independent-review appears on GitHub. Tests pin structural
// invariants without booting the server.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const gatePath = path.join(repoRoot, "container", "gate.js");
const gate = fs.readFileSync(gatePath, "utf8");

test("handleReview is defined and handles /review", () => {
  assert.match(gate, /function handleReview\(req, res, url\)/);
  assert.match(gate, /url\.pathname !== "\/review"/);
  assert.match(gate, /req\.method !== "POST"/);
});

test("handleReview is wired before the cookie wall", () => {
  const reviewCall = gate.indexOf("if (handleReview(req, res, url)) return;");
  const serverStart = gate.indexOf("const server = http.createServer");
  assert.ok(serverStart >= 0, "server handler exists");
  const authedWall = gate.indexOf("if (!terminalCapabilityRequest && !authed(req))", serverStart);
  assert.ok(authedWall >= 0, "cookie auth wall exists after server start");
  assert.ok(reviewCall >= 0, "handleReview is called in the server handler");
  assert.ok(reviewCall > serverStart, "handleReview is in the server handler");
  assert.ok(reviewCall < authedWall, "handleReview sits BEFORE the cookie auth wall");
});

test("gateKeyOk uses timing-safe comparison and checks the X-Gate-Key header", () => {
  assert.match(gate, /function gateKeyOk\(req\)/);
  assert.match(gate, /req\.headers\["x-gate-key"\]/);
  assert.match(gate, /crypto\.timingSafeEqual/);
  assert.match(gate, /const want = String\(KEY \|\| ""\)/);
});

test("engineFromBranch is defined and extracts engine from task branches", () => {
  assert.match(gate, /function engineFromBranch\(branch\)/);
  assert.match(gate, /GIT_CHANGE_ENGINES\.has\(engine\)/);
});

test("the identity check rejects self-review (author === reviewer)", () => {
  assert.match(gate, /if \(author === reviewer\)/);
  assert.match(gate, /review_self_rejected/);
  assert.match(gate, /the reviewing engine cannot be the same as the authoring engine/);
});

test("the review handler validates all required inputs", () => {
  assert.match(gate, /GIT_REPO_RE\.test\(repo\)/);
  assert.match(gate, /Number\.isInteger\(prNumber\)/);
  assert.match(gate, /GIT_ENGINE_RE\.test\(reviewer\)/);
  assert.match(gate, /GIT_CHANGE_ENGINES\.has\(reviewer\)/);
  assert.match(gate, /verdict !== "APPROVE" && verdict !== "REJECT"/);
  assert.match(gate, /reviewStrictness must be an integer 0-5/);
});

test("the review handler calls publishGitReviewStatus on APPROVE", () => {
  // The REJECT branch returns early; everything after it is the APPROVE path.
  const rejectIdx = gate.indexOf('if (verdict === "REJECT")');
  assert.ok(rejectIdx >= 0, "REJECT branch exists");
  const publishIdx = gate.indexOf("publishGitReviewStatus(change, approval)", rejectIdx);
  assert.ok(publishIdx >= 0, "publishGitReviewStatus is called after the REJECT guard (i.e. on the APPROVE path)");
});

test("the review handler creates a signed approval via createGitReviewApproval", () => {
  assert.match(gate, /const approval = createGitReviewApproval\(/);
  assert.match(gate, /loadGateSecret\(\)/);
});

test("the review handler can create a git change record for off-box PRs", () => {
  assert.match(gate, /createGitChange\(/);
  assert.match(gate, /could not create a git change record/);
});

test("generated review fallback is explicit, source-complete, and bound to trusted CI evidence", () => {
  assert.match(gate, /gitReviewEvidenceRequest\(body\.reviewEvidence\)/);
  assert.match(gate, /diffResult\.oversized === true \|\| diffResult\.generatedReviewPossible === true/);
  assert.match(gate, /fetchGitPullRequestFiles\(change, changedFileCount\)/);
  assert.match(gate, /canonicalPullRequestReview\(enriched\.files\)/);
  assert.match(gate, /generated dashboard review cannot change its own trust anchors/);
  assert.match(gate, /\/commits\/" \+ headSha \+ "\/statuses\?per_page=100/);
  assert.match(gate, /dashboardReviewStatus\(statuses\.json/);
  assert.match(gate, /dashboardReviewNewestRun\(workflowRuns\.json/);
  assert.match(gate, /dashboardReviewRun\(runResponse\.json/);
  assert.match(gate, /listedBlobSha !== expectedListedBlobSha/);
  assert.match(gate, /fetchDashboardGitTree\(change\.repo, baseSha\)/);
  assert.match(gate, /dashboardAttestationSha256\(record\)/);
  assert.match(gate, /evidenceSha256: reviewBinding\.evidenceSha256/);
});

test("ordinary reviews still prefer and sign the exact immutable raw diff", () => {
  const approve = gate.slice(gate.indexOf("// --- APPROVE path"), gate.indexOf("function handleBoard"));
  const rawFetch = approve.indexOf("fetchGitPullRequestDiff(change)");
  const evidenceFetch = approve.indexOf("fetchGitPullRequestAttestation(");
  assert.ok(rawFetch >= 0 && evidenceFetch > rawFetch);
  assert.match(approve, /crypto\.createHash\("sha256"\)\.update\(diffResult\.text, "utf8"\)/);
});

test("a generated-dashboard approval is revalidated immediately before merge", () => {
  const merge = gate.slice(gate.indexOf("async mergePR(task)"), gate.indexOf("async function reconcilePendingGitMerges"));
  const livePull = merge.indexOf("const live = await fetchGitPullRequest(change)");
  const evidence = merge.indexOf("fetchGitPullRequestAttestation(");
  const publish = merge.indexOf("publishGitReviewStatus(change, approval)");
  assert.ok(livePull >= 0, "merge refreshes the exact pull request");
  assert.ok(evidence > livePull, "generated evidence is revalidated after the live pull refresh");
  assert.ok(publish > evidence, "independent-review is not republished before evidence revalidation");
});
