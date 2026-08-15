// Phase 3 git ladder security tests. These exercise the exact helpers used by
// dispatch, a linked-worktree hook-hostility test, and a Linux integration test
// for the real autonomous writable bind.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import chains from "../container/chains-lib.js";
import {
  gitRungGranted,
  engineWorktreePath,
  gitActionGate,
  gitCredentialEnv,
  gitHardenedConfigArgs,
  buildHardenedGitCommand,
  buildCredentialedGitCommand,
  buildJailedGitCommand,
  gitCommandResult,
  isExpectedCommitWorktree,
  commitAgentWorktree,
  createGitReviewApproval,
  gitReviewApprovalMatches,
  gitReviewApprovalIsFresh,
  gitReviewVerdict,
  gitReviewProtectionMatches,
  gitReviewResponseWithinCap,
  gitReviewEvidenceRequest,
  dashboardReviewStatus,
  dashboardReviewRun,
  dashboardReviewNewestRun,
  gitCompareIsFullyReviewable,
  gitCompareAllowsGeneratedFallback,
  gitDiffIsFullyReviewable,
  gitMergeResponseNeedsReconciliation,
  configuredGitRepo,
  gitTaskBranch,
  gitTaskWorktreeName,
  engineTaskWorktreePath,
  createGitChange,
  gitChangeMatchesTask,
  gitTaskWorktreeForChange,
  gitTaskWorkspacePlan,
  gitPushPlan,
  gitRemoteBranchSha,
  gitPullRequestMatches,
  gitProposalHasNewCommit,
  prepareGitProposal,
  codexAutonomousArgs,
  codexSavedLoginAvailable,
  codexAuthLauncherAvailable,
  codexAutonomousEnv,
  grantedAutonomousWorktree,
  pinAutonomousWorktree,
  gateChildEnv,
  hermesKanbanEnv,
  hardenGateProcess,
} from "../container/gate.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const credentialHelper = path.join(repoRoot, "container", "git-credential-agenthost");
const codexAuthOnce = process.env.CODEX_AUTH_ONCE || "/usr/local/bin/codex-auth-once";
const codexNativeBin = process.env.CODEX_NATIVE_BIN || "/usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex";

function settings(autonomyLevel = 0, reviewStrictness = 3) {
  return { v: 3, git: { autonomyLevel, reviewStrictness, autoCommit: false } };
}

function writeChatGptLogin(home, payload = null) {
  const authDir = path.join(home, ".codex");
  fs.mkdirSync(authDir, { recursive: true });
  const auth = payload || {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      access_token: "test-access-token-abcdefghijklmnopqrstuvwxyz",
      refresh_token: "test-refresh-token-abcdefghijklmnopqrstuvwxyz",
      id_token: "test-id-token-abcdefghijklmnopqrstuvwxyz",
      account_id: "test-account",
    },
  };
  const authFile = path.join(authDir, "auth.json");
  fs.writeFileSync(authFile, JSON.stringify(auth), { mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(authFile, 0o600);
  return authFile;
}

test("fail-closed defaults grant no git rung", () => {
  for (const value of [undefined, null, {}, { git: {} }, settings(0)]) {
    for (const rung of [1, 2, 3, 4]) assert.equal(gitRungGranted(rung, value), false);
  }
});

test("autonomy-to-rung mapping stays exact", () => {
  assert.equal(gitRungGranted(1, settings(2)), false);
  assert.equal(gitRungGranted(1, settings(3)), true);
  assert.equal(gitRungGranted(2, settings(3)), false);
  assert.equal(gitRungGranted(2, settings(4)), true);
  assert.equal(gitRungGranted(3, settings(4)), true);
  assert.equal(gitRungGranted(4, settings(5, 3)), true);
  assert.equal(gitRungGranted(4, settings(5, 2)), true);
  assert.equal(gitRungGranted(99, settings(5, 0)), false);
});

test("git gate accepts only an explicit structured action", () => {
  assert.deepEqual(gitActionGate(null, settings(5, 0)), { gated: true, reason: "missing git action" });
  assert.deepEqual(gitActionGate({}, settings(5, 0)), { gated: true, reason: "missing git action" });
  assert.deepEqual(gitActionGate({ action: "merge sort algorithm" }, settings(5, 0)), {
    gated: true,
    reason: "unknown git action",
  });
  assert.deepEqual(gitActionGate({ title: "push the branch" }, settings(5, 0)), {
    gated: true,
    reason: "missing git action",
  });
});

test("structured gate maps each exact action to its rung", () => {
  assert.deepEqual(gitActionGate({ action: "commitLocal" }, settings(3)), { gated: false, rung: 1 });
  assert.deepEqual(gitActionGate({ action: "pushBranch" }, settings(3)), {
    gated: true,
    reason: "git rung 2 not granted",
  });
  assert.deepEqual(gitActionGate({ action: "pushBranch" }, settings(4)), { gated: false, rung: 2 });
  assert.deepEqual(gitActionGate({ action: "openPR" }, settings(4)), { gated: false, rung: 3 });
});

test("merge capability ignores a caller-provided review boolean", () => {
  assert.deepEqual(gitActionGate({ action: "mergePR", reviewPassed: false }, settings(5, 2)), {
    gated: false,
    rung: 4,
  });
  assert.deepEqual(gitActionGate({ action: "mergePR", reviewPassed: true }, settings(5, 2)), {
    gated: false,
    rung: 4,
  });
});

test("a Git review approval is bound to the exact independent review, task branch, and diff", () => {
  const secret = "git-review-secret-for-test";
  const input = {
    taskId: "task_42",
    repo: "Stevekaplanai/agenthost-internal",
    branch: "codex/task-task_42",
    baseRef: "trunk",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    diffSha256: "d".repeat(64),
    author: "codex",
    reviewer: "claude",
    reviewStrictness: 5,
  };
  const approval = createGitReviewApproval(input, secret, 1700000000000);
  assert.ok(approval);
  assert.equal(approval.verdict, "APPROVE");
  assert.equal(gitReviewApprovalMatches(approval, input, secret), true);
  assert.equal(gitReviewApprovalMatches(approval, { ...input, headSha: "c".repeat(40) }, secret), false);
  assert.equal(gitReviewApprovalMatches(approval, { ...input, diffSha256: "e".repeat(64) }, secret), false);
  assert.equal(gitReviewApprovalMatches({ ...approval, diffSha256: "e".repeat(64) }, input, secret), false,
    "a changed immutable diff hash must invalidate the signed approval");
  assert.equal(gitReviewApprovalMatches(approval, { ...input, reviewer: "codex" }, secret), false);
  assert.equal(gitReviewApprovalIsFresh(approval, 1700000000000 + 1000), true);
  assert.equal(gitReviewApprovalIsFresh(approval, 1700000000000 + 24 * 60 * 60 * 1000 + 1), false);
  assert.equal(createGitReviewApproval({ ...input, reviewer: "codex" }, secret, 1700000000000), null,
    "the author cannot approve their own commit");
  assert.equal(createGitReviewApproval({ ...input, branch: "codex/work" }, secret, 1700000000000), null,
    "a review must not authorize the reusable engine branch");
  assert.equal(createGitReviewApproval({ ...input, diffSha256: "" }, secret, 1700000000000), null,
    "an approval without an immutable diff hash must fail closed");
});

test("DeepSeek is permanently capped at private local commits", () => {
  assert.deepEqual(gitActionGate({ action: "commitLocal", engine: "deepseek" }, settings(5)), {
    gated: false,
    rung: 1,
  });
  for (const action of ["pushBranch", "openPR", "mergePR"]) {
    assert.deepEqual(gitActionGate({ action, engine: "deepseek" }, settings(5)), {
      gated: true,
      reason: "deepseek is capped at git rung 1",
    });
  }
  assert.deepEqual(gitActionGate({ action: "mergePR", engine: "codex" }, settings(5)), {
    gated: false,
    rung: 4,
  });
});

test("a generated-dashboard review binds separate source and reproducibility evidence without changing v1 signatures", () => {
  const secret = "git-review-secret-for-test";
  const input = {
    taskId: "growth_070",
    repo: "Stevekaplanai/agenthost-internal",
    branch: "codex/task-growth_070",
    baseRef: "main",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    diffSha256: "c".repeat(64),
    author: "codex",
    reviewer: "kimi",
    reviewStrictness: 4,
  };
  const ordinary = createGitReviewApproval(input, secret, 1700000000000);
  const evidence = {
    evidenceType: "dashboard-generated-v1",
    evidenceSha256: "d".repeat(64),
  };
  const generated = createGitReviewApproval({ ...input, ...evidence }, secret, 1700000000000);

  assert.equal(ordinary.v, 1);
  assert.equal(ordinary.signature, "9whNSVGsDAkJtPDVYMu7CaU7Ko3fZB_7xr2MUPaeH4o",
    "existing version-1 approvals must retain their exact signature bytes");
  assert.equal(Object.hasOwn(ordinary, "evidenceType"), false);
  assert.equal(Object.hasOwn(ordinary, "evidenceSha256"), false);
  assert.equal(generated.v, 2);
  assert.equal(generated.evidenceType, evidence.evidenceType);
  assert.equal(generated.evidenceSha256, evidence.evidenceSha256);
  assert.equal(gitReviewApprovalMatches(generated, input, secret), true);
  assert.equal(gitReviewApprovalMatches(generated, { ...input, evidenceSha256: "e".repeat(64) }, secret), false);
  assert.equal(createGitReviewApproval({ ...input, evidenceType: evidence.evidenceType }, secret, 1700000000000), null);
  assert.equal(createGitReviewApproval({ ...input, evidenceSha256: evidence.evidenceSha256 }, secret, 1700000000000), null);
  assert.equal(createGitReviewApproval({ ...input, evidenceType: "other", evidenceSha256: evidence.evidenceSha256 }, secret, 1700000000000), null);
});

test("the GitHub review cap counts UTF-8 bytes, not JavaScript characters", () => {
  assert.equal(gitReviewResponseWithinCap("a".repeat(256 * 1024), NaN), true);
  assert.equal(gitReviewResponseWithinCap("é".repeat(128 * 1024), NaN), true);
  assert.equal(gitReviewResponseWithinCap("é".repeat(128 * 1024 + 1), NaN), false);
  assert.equal(gitReviewResponseWithinCap("", 256 * 1024 + 1), false);
});

test("generated fallback permits only omitted generated patches while every source patch stays complete", () => {
  const source = { filename: "dashboard/app/page.tsx", status: "modified", patch: "@@ -1 +1 @@\n-old\n+new" };
  const generated = { filename: "container/dashboard-ui/_next/static/app.js", status: "modified" };
  assert.equal(gitCompareAllowsGeneratedFallback({ files: [source, generated] }), true);
  assert.equal(gitCompareAllowsGeneratedFallback({ files: [{ ...source, patch: undefined }, generated] }), false);
  assert.equal(gitCompareAllowsGeneratedFallback({ files: [source] }), false);
  assert.equal(gitCompareAllowsGeneratedFallback({ files: [source, { ...generated, previous_filename: "dashboard/source.js" }] }), false);
  assert.equal(gitCompareAllowsGeneratedFallback({ truncated: true, files: [source, generated] }), false);
});

test("generated review evidence accepts only the exact bounded schema", () => {
  const valid = {
    type: "dashboard-generated-v1",
    sourceDiffSha256: "a".repeat(64),
    attestationSha256: "b".repeat(64),
  };
  assert.deepEqual(gitReviewEvidenceRequest(undefined), { ok: true, evidence: null });
  assert.deepEqual(gitReviewEvidenceRequest(valid), { ok: true, evidence: valid });
  assert.equal(Boolean(gitReviewEvidenceRequest({ ...valid, extra: true }).error), true);
  assert.equal(Boolean(gitReviewEvidenceRequest({ ...valid, type: "other" }).error), true);
  assert.equal(Boolean(gitReviewEvidenceRequest({ ...valid, sourceDiffSha256: "a" }).error), true);
  assert.equal(Boolean(gitReviewEvidenceRequest(null).error), true);
});

test("dashboard reproducibility status and workflow bind one exact pull request run", () => {
  const repo = "Stevekaplanai/agenthost-internal";
  const baseSha = "a".repeat(40);
  const headSha = "b".repeat(40);
  const digest = "c".repeat(64);
  const target = `https://github.com/${repo}/actions/runs/12345`;
  const trustedStatus = {
    id: 91,
    context: "agenthost/dashboard-reproducibility-v1",
    state: "success",
    description: `dashboard-review-v1:${digest}`,
    target_url: target,
    creator: { login: "github-actions[bot]", type: "Bot" },
  };
  const status = dashboardReviewStatus([trustedStatus], repo, digest);
  assert.deepEqual(status, { ok: true, runId: 12345, statusId: 91 });

  const run = {
    id: 12345,
    path: ".github/workflows/dashboard-reproducibility.yml",
    event: "pull_request",
    status: "completed",
    conclusion: "success",
    head_sha: headSha,
    head_branch: "codex/task-growth_070",
    run_attempt: 2,
    repository: { full_name: repo },
    head_repository: { full_name: repo },
    pull_requests: [{
      number: 406,
      head: { sha: headSha, ref: "codex/task-growth_070" },
      base: { sha: baseSha, ref: "main" },
    }],
  };
  const expected = {
    runId: 12345,
    repo,
    prNumber: 406,
    branch: "codex/task-growth_070",
    baseRef: "main",
    baseSha,
    headSha,
  };
  assert.deepEqual(dashboardReviewRun(run, expected), { ok: true, runId: 12345, runAttempt: 2 });
  assert.deepEqual(dashboardReviewRun({ ...run, path: ".github/workflows/dashboard-reproducibility.yml@main" }, expected), { ok: true, runId: 12345, runAttempt: 2 });
  assert.equal(Boolean(dashboardReviewRun({ ...run, event: "push" }, expected).error), true);
  assert.equal(Boolean(dashboardReviewRun({ ...run, conclusion: "neutral" }, expected).error), true);
  assert.equal(Boolean(dashboardReviewRun({ ...run, pull_requests: [] }, expected).error), true);
  assert.equal(Boolean(dashboardReviewRun(run, { ...expected, headSha: "d".repeat(40) }).error), true);

  assert.equal(Boolean(dashboardReviewStatus([{ ...trustedStatus, state: "failure", id: 92 }, trustedStatus], repo, digest).error), true,
    "a newer failure must supersede an older success on the same head");
  assert.equal(Boolean(dashboardReviewStatus([{ ...trustedStatus, context: "AgentHost/Dashboard-Reproducibility-V1", state: "failure", id: 1 }, trustedStatus], repo, digest).error), true,
    "a newer case-variant failure must supersede an older success regardless of numeric status id");
  assert.equal(Boolean(dashboardReviewStatus([{ ...trustedStatus, creator: { login: "mallory", type: "User" } }], repo, digest).error), true);
  assert.equal(Boolean(dashboardReviewStatus([{ ...trustedStatus, target_url: `${target}?x=1` }], repo, digest).error), true);
  assert.equal(Boolean(dashboardReviewStatus([{ ...trustedStatus, target_url: target.replace("github.com", "github.com:444") }], repo, digest).error), true);
  assert.equal(Boolean(dashboardReviewStatus([trustedStatus, { ...trustedStatus }], repo, digest).error), true);
  assert.equal(Boolean(dashboardReviewStatus(Array.from({ length: 100 }, () => trustedStatus), repo, digest).error), true);

  const historyRun = {
    id: 12345,
    path: ".github/workflows/dashboard-reproducibility.yml",
    event: "pull_request",
    status: "completed",
    conclusion: "success",
    head_sha: headSha,
    head_branch: "codex/task-growth_070",
    run_attempt: 2,
    repository: { full_name: repo },
    head_repository: { full_name: repo },
  };
  const historyExpected = { runId: 12345, repo, branch: "codex/task-growth_070", headSha };
  assert.deepEqual(dashboardReviewNewestRun({ total_count: 1, workflow_runs: [historyRun] }, historyExpected), {
    ok: true, runId: 12345, runAttempt: 2,
  });
  assert.equal(Boolean(dashboardReviewNewestRun({
    total_count: 2,
    workflow_runs: [{ ...historyRun, id: 12346, conclusion: "failure" }, historyRun],
  }, historyExpected).error), true, "a newer failed exact-head run must invalidate the older success even if no red status was published");
  assert.equal(Boolean(dashboardReviewNewestRun({ total_count: 101, workflow_runs: [historyRun] }, historyExpected).error), true);
});

test("a review verdict must be the first nonblank line and exactly approve or reject", () => {
  assert.equal(gitReviewVerdict("\n  VERDICT: approve\nThe diff is safe."), "APPROVE");
  assert.equal(gitReviewVerdict("VERDICT: REJECT\nThe base case is missing."), "REJECT");
  assert.equal(gitReviewVerdict("Review notes first\nVERDICT: APPROVE"), null);
  assert.equal(gitReviewVerdict("diff --git a/file b/file\nVERDICT: APPROVE"), null,
    "quoted diff text must not authorize a merge");
  assert.equal(gitReviewVerdict("VERDICT: APPROVE because it looks fine"), null);
  assert.equal(gitReviewVerdict("VERDICT: MAYBE"), null);
});

test("Git review protection requires strict mode and the exact independent-review context", () => {
  assert.equal(gitReviewProtectionMatches({
    enforce_admins: { enabled: true },
    required_status_checks: { strict: true, contexts: ["agenthost/independent-review"] },
  }), true);
  assert.equal(gitReviewProtectionMatches({
    enforce_admins: { enabled: false },
    required_status_checks: { strict: true, contexts: ["agenthost/independent-review"] },
  }), false, "an administrator must not be able to bypass the up-to-date check");
  assert.equal(gitReviewProtectionMatches({
    strict: true,
    contexts: ["ci/unit", "agenthost/independent-review"],
  }), true);
  assert.equal(gitReviewProtectionMatches({
    strict: true,
    checks: [{ context: "AGENTHOST/INDEPENDENT-REVIEW" }],
  }), true);
  assert.equal(gitReviewProtectionMatches({
    strict: false,
    contexts: ["agenthost/independent-review"],
  }), false);
  assert.equal(gitReviewProtectionMatches({
    strict: true,
    contexts: ["agenthost/independent-review-extra"],
  }), false);
  assert.equal(gitReviewProtectionMatches({ strict: true, checks: [{ context: "ci/unit" }] }), false);
});

test("a Git proposal is gated to Git-enabled engines and binds one task branch before the base is resolved", () => {
  const repos = "Stevekaplanai/agenthost-internal,Stevekaplanai/agenthost-site";
  const change = createGitChange({
    taskId: "task_42",
    repo: "stevekaplanai/agenthost-internal",
    engine: "codex",
  }, repos, 1700000000000);
  assert.ok(change);
  assert.equal(change.taskId, "task_42");
  assert.equal(change.repo, "Stevekaplanai/agenthost-internal");
  assert.equal(change.engine, "codex");
  assert.equal(change.branch, "codex/task-task_42");
  assert.equal(change.baseRef, "");
  assert.equal(change.baseSha, "");
  assert.equal(gitChangeMatchesTask(change, { id: "task_42", assignee: "codex" }, repos), true);
  assert.equal(gitChangeMatchesTask(change, { id: "task_42", assignee: "claude" }, repos), false);
  assert.equal(gitChangeMatchesTask({ ...change, branch: "codex/task-other" }, { id: "task_42", assignee: "codex" }, repos), false);
  assert.equal(gitTaskBranch("codex", "task_42"), "codex/task-task_42");
  assert.equal(gitTaskBranch("claude", "task_42"), "claude/task-task_42");
  assert.equal(gitTaskBranch("hermes", "task_42"), "hermes/task-task_42");
  assert.equal(gitTaskBranch("gemini", "task_42"), "gemini/task-task_42");
  assert.equal(gitTaskBranch("kimi", "task_42"), "kimi/task-task_42");
  assert.equal(gitTaskBranch("cursor", "task_42"), null);
  assert.equal(createGitChange({ taskId: "task_42", repo: "other/repo", engine: "codex" }, repos), null);
  assert.equal(createGitChange({ taskId: "task_42", repo: "Stevekaplanai/agenthost-internal", engine: "claude" }, repos).branch, "claude/task-task_42");
  assert.equal(createGitChange({ taskId: "task_42", repo: "Stevekaplanai/agenthost-internal", engine: "hermes" }, repos).branch, "hermes/task-task_42");
  assert.equal(createGitChange({ taskId: "task_42", repo: "Stevekaplanai/agenthost-internal", engine: "gemini" }, repos).branch, "gemini/task-task_42");
  assert.equal(createGitChange({ taskId: "task_42", repo: "Stevekaplanai/agenthost-internal", engine: "kimi" }, repos).branch, "kimi/task-task_42");
  assert.equal(createGitChange({ taskId: "task_42", repo: "Stevekaplanai/agenthost-internal", engine: "cursor" }, repos), null);
});

test("a resolved task proposal keeps a non-main base and one direct Codex task workspace", () => {
  const repos = "Stevekaplanai/agenthost-internal";
  const home = "/agent-home";
  const change = {
    ...createGitChange({ taskId: "task_42", repo: "Stevekaplanai/agenthost-internal", engine: "codex" }, repos),
    baseRef: "trunk",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
  };
  const expectedWorktree = path.join(home, "workspaces", "codex", "agenthost-internal--task-task_42");
  assert.equal(gitTaskWorktreeName("agenthost-internal", "task_42"), "agenthost-internal--task-task_42");
  assert.equal(engineTaskWorktreePath("codex", "agenthost-internal", "task_42", home), expectedWorktree);
  assert.equal(gitTaskWorktreeForChange(change, repos, home), expectedWorktree,
    "the task workspace must be one direct child of the Codex workspace root");
  assert.deepEqual(gitTaskWorkspacePlan(change, repos, home), {
    repo: "Stevekaplanai/agenthost-internal",
    repoName: "agenthost-internal",
    branch: "codex/task-task_42",
    baseRef: "trunk",
    baseSha: "a".repeat(40),
    worktreePath: expectedWorktree,
  });
  assert.equal(gitTaskWorkspacePlan({ ...change, baseRef: "" }, repos, home), null);
  assert.equal(gitTaskWorkspacePlan({ ...change, baseSha: "not-a-sha" }, repos, home), null);
  assert.deepEqual(gitPushPlan(change, repos), {
    repo: "Stevekaplanai/agenthost-internal",
    branch: "codex/task-task_42",
    headSha: "b".repeat(40),
    remoteUrl: "https://github.com/Stevekaplanai/agenthost-internal.git",
    localRef: "refs/heads/agenthost/source",
    remoteRef: "refs/heads/codex/task-task_42",
  });
  assert.equal(gitPushPlan({ ...change, branch: "trunk" }, repos), null,
    "no task push may target the resolved base branch");
  assert.equal(gitPushPlan({ ...change, baseRef: change.branch }, repos), null,
    "a repository default branch that collides with the task branch must fail closed");
  assert.equal(configuredGitRepo("Stevekaplanai/agenthost-internal", "a/repo,b/repo"), null,
    "a duplicate basename must fail closed");
});

test("a structured proposal refuses to climb from an unchanged base commit", () => {
  const base = "a".repeat(40);
  const next = "b".repeat(40);
  assert.equal(gitProposalHasNewCommit({ ok: true, headSha: next }, base), true);
  assert.equal(gitProposalHasNewCommit({ ok: true, unchanged: true, headSha: base }, base), false);
  assert.equal(gitProposalHasNewCommit({ ok: true, headSha: base }, base), false,
    "a supposedly changed commit at the recorded base cannot be pushed");
  assert.equal(gitProposalHasNewCommit({ ok: false, headSha: next }, base), false);
});

test("commit accepts only the exact Codex task workspace named by its task branch", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-task-commit-worktree-"));
  const repoName = "repo";
  const taskId = "task_42";
  const branch = "codex/task-" + taskId;
  const worktree = path.join(root, "workspaces", "codex", "repo--task-" + taskId);
  const ordinary = path.join(root, "workspaces", "codex", repoName);
  const otherTask = path.join(root, "workspaces", "codex", "repo--task-task_43");
  const hermesTask = path.join(root, "workspaces", "hermes", "repo--task-" + taskId);
  try {
    assert.equal(isExpectedCommitWorktree("codex", repoName, worktree, branch), true);
    assert.equal(isExpectedCommitWorktree("codex", repoName, ordinary, "codex/work"), true,
      "ordinary work stays available only for the ordinary branch");
    assert.equal(isExpectedCommitWorktree("codex", repoName, ordinary, branch), false,
      "a task branch cannot commit through the ordinary workspace");
    assert.equal(isExpectedCommitWorktree("codex", repoName, ordinary, "hermes/task-" + taskId), false,
      "a different engine's task branch cannot fall back to the ordinary workspace");
    assert.equal(
      isExpectedCommitWorktree("codex", repoName, otherTask, branch),
      false,
      "a task branch cannot commit through a sibling task workspace",
    );
    assert.equal(isExpectedCommitWorktree("hermes", repoName, hermesTask, "hermes/task-" + taskId), true,
      "Hermes has a writable structured task workspace (same as Codex)");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a persisted proposal base with no task directory resumes isolated workspace materialization", async () => {
  const previous = { HOME: process.env.HOME, REPOS: process.env.REPOS, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ah-git-proposal-retry-"));
  try {
    process.env.HOME = home;
    process.env.REPOS = "Stevekaplanai/agenthost-internal";
    delete process.env.GITHUB_TOKEN;
    const change = {
      ...createGitChange({ taskId: "task_retry", repo: "Stevekaplanai/agenthost-internal", engine: "codex" }, process.env.REPOS, 1700000000000),
      baseRef: "main",
      baseSha: "a".repeat(40),
      status: "prepared",
    };
    const plan = gitTaskWorkspacePlan(change, process.env.REPOS);
    assert.ok(plan && !fs.existsSync(plan.worktreePath), "the retry begins with no task workspace");
    const result = await prepareGitProposal(change);
    assert.ok(
      result && result.error && (
        result.error === "GitHub token is unavailable" ||
        result.error === "GitHub default branch changed while preparing this task" ||
        result.error === "could not fetch the repository default branch"
      ),
      `the persisted base reaches the isolated materializer instead of a false workspace mismatch; got ${result && result.error}`
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a timed-out Git operation kills its descendant group before settling", {
  skip: process.platform === "win32" ? "POSIX process-group containment" : false,
  timeout: 6000,
}, async () => {
  const descendantLifetimeMs = 10_000;
  const started = Date.now();
  const result = await gitCommandResult({
    bin: process.execPath,
    args: ["-e", [
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, " + descendantLifetimeMs + ")'], { stdio: ['ignore', 'inherit', 'inherit'] });",
      "child.unref();",
      "process.stdout.write('DESCENDANT_READY ' + child.pid + '\\n');",
      "setTimeout(() => {}, " + (descendantLifetimeMs * 2) + ");",
    ].join(" ")],
    cwd: os.tmpdir(),
    env: process.env,
  }, null, { timeoutMs: 1500 });
  assert.equal(result.ok, false);
  assert.equal(result.error, "git timed out");
  assert.match(result.stdout, /DESCENDANT_READY/,
    "the simulated descendant must be running before the timeout fires");
  const descendantPid = Number(result.stdout.match(/DESCENDANT_READY (\d+)/)?.[1]);
  assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 1, "captured the descendant pid");
  let descendantRunning = false;
  try {
    const stat = fs.readFileSync(`/proc/${descendantPid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
    descendantRunning = state !== "Z" && state !== "X";
  } catch {}
  try {
    assert.equal(descendantRunning, false,
      "the timeout must not settle while a Git descendant is still alive");
    assert.ok(Date.now() - started < descendantLifetimeMs - 500,
      "process-group termination must not wait for the descendant's natural timeout");
  } finally {
    if (descendantRunning) try { process.kill(descendantPid, "SIGKILL"); } catch {}
  }
});

test("a credentialed PID-namespace timeout kills a setsid fd3-only descendant", {
  skip: process.platform !== "linux"
    || !fs.existsSync("/usr/bin/bwrap")
    || !fs.existsSync("/usr/bin/setsid")
    ? "Linux Bubblewrap PID containment"
    : false,
  timeout: 6000,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-git-pidns-"));
  const marker = path.join(root, "fd3-survived");
  const ready = path.join(root, "descendant.ready");
  const release = path.join(root, "read-now");
  const tag = `ah-git-fd3-${process.pid}-${Date.now()}`;
  const taggedPids = () => {
    const matches = [];
    for (const name of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      try {
        if (fs.readFileSync(`/proc/${name}/cmdline`).toString().includes(tag)) matches.push(Number(name));
      } catch {}
    }
    return matches;
  };
  const jail = chains.buildBwrapReadJail("/bin/sh", ["-c", [
    `/usr/bin/setsid /bin/sh -c 'exec </dev/null >/dev/null 2>&1; [ -e /proc/self/fd/3 ] || exit 72; printf %s "$0" > /workspace/descendant.ready; while [ ! -e /workspace/read-now ]; do sleep 0.01; done; IFS= read -r token <&3; printf %s "$token" > /workspace/fd3-survived; sleep 30' ${tag} &`,
    "sleep 30",
  ].join("\n")], {
    env: gitCredentialEnv(process.env),
    requiredRwBindAt: [{ src: root, dest: "/workspace" }],
  });
  const command = {
    ...jail,
    cwd: os.tmpdir(),
    env: gitCredentialEnv(process.env),
    terminalContainment: "bwrap-pidns",
  };
  try {
    let timeoutCallback = null;
    const resultPromise = gitCommandResult(command, "synthetic-fd3-token", {
      timeoutMs: 100,
      scheduleTimeout(callback) {
        timeoutCallback = callback;
        return setTimeout(() => {}, 60_000);
      },
    });
    const readyDeadline = Date.now() + 2000;
    while (!fs.existsSync(ready) && Date.now() < readyDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(fs.readFileSync(ready, "utf8"), tag,
      "the setsid descendant must prove fd 3 is open before the timeout fires");
    assert.ok(taggedPids().length > 0, "the tagged descendant must be live before timeout");
    assert.equal(typeof timeoutCallback, "function");
    timeoutCallback();
    const result = await resultPromise;
    assert.equal(result.error, "git timed out");
    fs.writeFileSync(release, "read now");
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(fs.existsSync(marker), false,
      "the detached child must not read fd 3 after the timeout");
    assert.deepEqual(taggedPids(), [],
      "the PID namespace must leave no tagged descendant on the host");
  } finally {
    for (const pid of taggedPids()) try { process.kill(pid, "SIGKILL"); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a PR must still point at the recorded branch and exact repo", () => {
  const repos = "Stevekaplanai/agenthost-internal";
  const change = {
    ...createGitChange({ taskId: "task_42", repo: "Stevekaplanai/agenthost-internal", engine: "codex" }, repos),
    baseRef: "trunk",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
  };
  const pull = {
    number: 42,
    head: { ref: "codex/task-task_42", sha: "b".repeat(40), repo: { full_name: "Stevekaplanai/agenthost-internal" } },
    base: { ref: "trunk", sha: "a".repeat(40) },
  };
  assert.equal(gitPullRequestMatches(change, pull), true);
  assert.equal(gitPullRequestMatches(change, { ...pull, head: { ...pull.head, ref: "trunk" } }), false);
  assert.equal(gitPullRequestMatches(change, { ...pull, base: { ...pull.base, ref: "main" } }), false);
  assert.equal(gitPullRequestMatches(change, { ...pull, base: { ...pull.base, sha: "c".repeat(39) } }), false);
});

test("remote task-branch parsing accepts only the exact recorded task ref", () => {
  const trunkSha = "a".repeat(40);
  const taskSha = "b".repeat(40);
  const output = [
    trunkSha + "\trefs/heads/trunk",
    taskSha + "\trefs/heads/codex/task-task_42",
    "c".repeat(40) + "\trefs/heads/codex/task-task_42-old",
  ].join("\n");
  assert.equal(gitRemoteBranchSha(output, "codex/task-task_42"), taskSha);
  assert.equal(gitRemoteBranchSha(output, "trunk"), trunkSha);
  assert.equal(gitRemoteBranchSha(output, "codex/task-task_42-new"), null);
  assert.equal(gitRemoteBranchSha("not git ls-remote output", "codex/task-task_42"), null);
});

test("engine worktrees remain isolated by engine and repo", () => {
  const root = path.join(os.tmpdir(), "ah-worktrees");
  const claude = engineWorktreePath("claude", "repo", root);
  const codex = engineWorktreePath("codex", "repo", root);
  assert.equal(claude, path.join(root, "workspaces", "claude", "repo"));
  assert.equal(codex, path.join(root, "workspaces", "codex", "repo"));
  assert.notEqual(claude, codex);
});

test("Codex stays read-only unless Rung 1 grants the exact jail workspace", () => {
  for (const workspace of [undefined, null, "", "/repo", "/workspace/other"]) {
    const args = codexAutonomousArgs("inspect only", "", workspace);
    assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
    const locked = args.filter((arg, i) => args[i - 1] === "-c");
    assert.ok(locked.includes('default_permissions="agenthost_read_only"'));
    assert.ok(locked.includes('permissions.agenthost_read_only.extends=":read-only"'));
    assert.ok(locked.includes('permissions.agenthost_read_only.filesystem={ "/codex" = "deny" }'));
    assert.equal(locked.some((arg) => arg.includes('filesystem.":workspace_roots"')), false);
    assert.ok(locked.includes('shell_environment_policy.inherit="none"'));
    assert.equal(locked.some((arg) => arg.includes("chatgpt_base_url")), false, "autonomous Codex uses its normal ChatGPT backend");
    assert.equal(args[args.indexOf("-C") + 1], "/scratch");
    assert.ok(args.includes("--ignore-user-config"), "persisted Codex config is ignored");
    assert.ok(args.includes("--strict-config"), "unknown locked config fails closed");
  }
  const unauthenticated = codexAutonomousArgs("inspect only", "", "/workspace", false);
  const locked = unauthenticated.filter((arg, i) => unauthenticated[i - 1] === "-c");
  assert.equal(unauthenticated[unauthenticated.indexOf("--sandbox") + 1], "read-only");
  assert.equal(unauthenticated[unauthenticated.indexOf("-C") + 1], "/scratch");
  assert.ok(locked.includes('default_permissions="agenthost_read_only"'));
});

test("Codex Rung 1 uses workspace-write only inside its isolated /workspace", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ah-codex-grant-"));
  const engineRoot = path.join(home, "workspaces", "codex");
  const worktree = path.join(engineRoot, "repo");
  const outside = path.join(home, "outside");
  fs.mkdirSync(worktree, { recursive: true });
  execFileSync("git", ["init", "-q", worktree]);
  execFileSync("git", ["-C", worktree, "checkout", "-q", "-b", "codex/work"]);
  fs.mkdirSync(outside);
  // Unit coverage substitutes only the final jailed Git process. Production
  // uses Bubblewrap; this lets the branch-selection assertions run on Windows.
  const localBranchRunner = () => execFileSync("git", ["-C", worktree, "branch", "--show-current"], { encoding: "utf8" });
  try {
    assert.equal(grantedAutonomousWorktree(worktree, settings(2), "codex", home, undefined, localBranchRunner), null, "Autonomy 2 must stay read-only");
    assert.equal(grantedAutonomousWorktree(null, settings(3), "codex", home, undefined, localBranchRunner), null, "a missing worktree must stay read-only");
    assert.equal(grantedAutonomousWorktree(outside, settings(3), "codex", home, undefined, localBranchRunner), null, "an outside path must be refused");
    assert.equal(grantedAutonomousWorktree(worktree, settings(3), "claude", home, undefined, localBranchRunner), null, "another engine's path must be refused");
    assert.equal(grantedAutonomousWorktree(worktree, settings(3), "codex", home, undefined, localBranchRunner), fs.realpathSync(worktree), "Rung 1 grants only Codex's selected worktree");
    execFileSync("git", ["-C", worktree, "checkout", "-q", "-B", "other/work"]);
    assert.equal(grantedAutonomousWorktree(worktree, settings(3), "codex", home, undefined, localBranchRunner), null,
      "a workspace on the wrong branch must remain read-only");
    execFileSync("git", ["-C", worktree, "checkout", "-q", "-B", "codex/work"]);

    const linked = path.join(engineRoot, "linked");
    let madeLink = false;
    try { fs.symlinkSync(outside, linked, process.platform === "win32" ? "junction" : "dir"); madeLink = true; } catch {}
    if (madeLink) assert.equal(grantedAutonomousWorktree(linked, settings(3), "codex", home, undefined, localBranchRunner), null, "a symlinked worktree must be refused");

    const linkedGit = path.join(engineRoot, "linked-git");
    fs.mkdirSync(linkedGit);
    fs.writeFileSync(path.join(linkedGit, ".git"), "gitdir: /outside-the-jail/.git/worktrees/linked-git\n");
    assert.equal(grantedAutonomousWorktree(linkedGit, settings(3), "codex", home, undefined, localBranchRunner), null,
      "a linked-worktree .git pointer must be refused because it resolves outside /workspace");

    const args = codexAutonomousArgs("edit the isolated branch", "", "/workspace", true);
    assert.equal(args[args.indexOf("-C") + 1], "/workspace");
    assert.equal(args[args.indexOf("--sandbox") + 1], "workspace-write");
    const locked = args.filter((arg, i) => args[i - 1] === "-c");
    assert.ok(locked.includes('default_permissions="agenthost_workspace"'));
    assert.ok(locked.includes('permissions.agenthost_workspace.extends=":workspace"'));
    assert.ok(locked.includes('permissions.agenthost_workspace.filesystem={ "/codex" = "deny", ":workspace_roots" = { ".git" = "write" } }'));
    assert.ok(locked.includes('approval_policy="never"'));
    assert.ok(locked.includes('shell_environment_policy.inherit="none"'));
    assert.ok(locked.includes("permissions.agenthost_workspace.network.enabled=false"));
    assert.equal(locked.some((arg) => arg.startsWith("sandbox_workspace_write.")), false);
    const shellSet = locked.find((arg) => arg.startsWith("shell_environment_policy.set="));
    assert.match(shellSet, /GIT_CONFIG_NOSYSTEM = "1"/);
    assert.match(shellSet, /GIT_CONFIG_KEY_0 = "core\.hooksPath"/);
    assert.match(shellSet, /GIT_CONFIG_VALUE_0 = "\/dev\/null"/);
    assert.doesNotMatch(shellSet, /CODEX_ACCESS_TOKEN/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the autonomous runner uses one Rung 1 decision for Codex mode and the jail bind", () => {
  const src = fs.readFileSync(path.join(repoRoot, "container", "gate.js"), "utf8");
  const runner = src.slice(src.indexOf("function runAutonomousTask"), src.indexOf("function autonomousPrompt"));
  assert.match(runner, /const requireWritableWorktree = Boolean\(opts && opts\.requireWritableWorktree\)/);
  // The five security-relevant arguments, in order, still pinned exactly. The
  // trailing comma allows the optional gitRunner/onDeny params without letting
  // any of these five be substituted.
  assert.match(runner, /pinAutonomousWorktree\(writableWorktree, sset\(\), eng\.label, HOME_DIR, writableBranch,/);
  // A refused pin silently degrades the engine to read-only, so the reason must
  // be captured and audited at the one point where it is still known. Without
  // this the operator sees "no changes to commit" and blames the engine for
  // obeying a flag the gate set (Cardinal Rule 16).
  assert.match(runner, /let writeDenialReason = null/);
  assert.match(runner, /if \(needsWorkspacePin && !grantedWorktree\)/);
  assert.match(runner, /audit\("autonomy_write_denied"/);
  assert.match(runner, /const codexAuthReady = eng\.label === "codex" && Boolean\(codexAuthHome\)/);
  assert.match(runner, /const jailWorkspace = grantedWorktree \? JAIL_WORKTREE : null/);
  assert.match(runner, /if \(requireWritableWorktree && !grantedWorktree\) return privateWorkspaceDenied\(\)/);
  assert.match(runner, /if \(requireWritableWorktree && pinFailed\) return privateWorkspaceDenied\(\)/);
  assert.match(runner, /gitLadderError: "private workspace mount denied"/);
  assert.match(runner, /eng\.autoArgs\(prompt,.*jailWorkspace, codexAuthReady\)/s);
  assert.match(runner, /runArgs = \[CODEX_CLI, \.\.\.runArgs\]/);
  assert.match(runner, /\{ src: codexAuthHome, dest: "\/codex" \}/);
  assert.match(runner, /const rwSources = \[[\s\S]*codexAuthHome/);
  assert.match(runner, /inheritedBind\(\{ src: workspacePin\.path, dest: JAIL_WORKTREE \}, workspacePin\)/);
  assert.match(runner, /stdio: \["ignore", "pipe", "pipe", \.{3}jailPinFds\]/);
  assert.match(runner, /closeFds: jailPinFds\.map\(\(_, index\) => 3 \+ index\)/);
  assert.match(runner, /const jailBin = codexAuthReady \? CODEX_CLI : runBin/);
  assert.match(runner, /buildBwrapReadJail\(jailBin, jailArgs/);
  assert.match(runner, /runBin = pinFailed \? "\/usr\/bin\/false" : \(codexAuthReady \? CODEX_AUTH_ONCE : w\.bin\)/);
  assert.match(runner, /CODEX_AUTH_DIR: codexAuthHome/);
  assert.match(runner, /CODEX_AUTH_PERSIST: "1"/);
  assert.match(runner, /CODEX_KEEP_FDS:/);
  assert.doesNotMatch(runner, /rmSync\(codexAuthHome/);
  assert.match(src, /autoBwrapJail: true/);
  assert.doesNotMatch(src, /autoJailRwBinds: \(\) => \[\{ src: path\.join\(HOME_DIR, "\.codex"\)/);
});

test("Codex accepts only a valid private saved ChatGPT login", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ah-codex-saved-login-"));
  writeChatGptLogin(home);
  try {
    assert.equal(codexSavedLoginAvailable(home), true);
    assert.equal(codexAuthLauncherAvailable(home, path.join(os.tmpdir(), "does-not-exist")), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Codex rejects malformed, API-key, linked, and exposed saved logins", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ah-codex-invalid-login-"));
  const outside = path.join(home, "outside.json");
  try {
    const authFile = writeChatGptLogin(home, { auth_mode: "apikey", OPENAI_API_KEY: "must-not-use" });
    assert.equal(codexSavedLoginAvailable(home), false, "API-key auth must never enable this subscription path");
    writeChatGptLogin(home, {
      auth_mode: "chatgpt",
      OPENAI_API_KEY: "must-not-use-even-with-chatgpt-mode",
      tokens: {
        access_token: "test-access-token-abcdefghijklmnopqrstuvwxyz",
        refresh_token: "test-refresh-token-abcdefghijklmnopqrstuvwxyz",
      },
    });
    assert.equal(codexSavedLoginAvailable(home), false, "a non-empty API key must fail closed in ChatGPT mode");
    fs.writeFileSync(authFile, "not-json", { mode: 0o600 });
    assert.equal(codexSavedLoginAvailable(home), false);
    fs.writeFileSync(outside, JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: "outside-access-token-abcdefghijklmnopqrstuvwxyz",
        refresh_token: "outside-refresh-token-abcdefghijklmnopqrstuvwxyz",
      },
    }), { mode: 0o600 });
    fs.rmSync(authFile, { force: true });
    let linked = false;
    try { fs.symlinkSync(outside, authFile, "file"); linked = true; } catch {}
    if (linked) assert.equal(codexSavedLoginAvailable(home), false, "a symlink cannot become the credential source");
    if (process.platform !== "win32") {
      fs.rmSync(authFile, { force: true });
      writeChatGptLogin(home);
      fs.chmodSync(authFile, 0o644);
      assert.equal(codexSavedLoginAvailable(home), false, "group/world-readable credentials must fail closed");

      fs.rmSync(authFile, { force: true });
      writeChatGptLogin(home);
      const alias = path.join(path.dirname(authFile), "auth-copy");
      fs.linkSync(authFile, alias);
      assert.equal(codexSavedLoginAvailable(home), false, "a hard-linked credential must fail closed");
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Codex autonomous environment never contains an API key or access token", () => {
  const token = "real-codex-token-for-test-only";
  const base = {
    CODEX_ACCESS_TOKEN: token,
    OPENAI_API_KEY: "must-not-leak",
    PATH: "/usr/bin",
    HOME: "/host-home",
    LANG: "C.UTF-8",
  };
  const jailed = codexAutonomousEnv(base);
  assert.equal("CODEX_ACCESS_TOKEN" in jailed, false, "the model process never receives a direct token");
  assert.equal("LD_PRELOAD" in jailed, false, "no preload trick reaches the static native client");
  assert.equal(jailed.CODEX_HOME, "/codex");
  assert.equal("OPENAI_API_KEY" in jailed, false);
  const src = fs.readFileSync(path.join(repoRoot, "container", "gate.js"), "utf8");
  assert.doesNotMatch(src, /codex login.*--with-api-key/i);
  assert.doesNotMatch(src, /codex login.*--with-access-token/i);
});

function wslGccAvailable() {
  if (process.platform !== "win32") return false;
  try { return spawnSync("wsl", ["sh", "-lc", "command -v gcc >/dev/null"], { stdio: "ignore" }).status === 0; } catch { return false; }
}

test("REAL LINUX: auth-once removes Codex auth and reaps its child tree when Gate dies", {
  skip: wslGccAvailable() ? false : "requires a local Linux gcc (WSL on Windows)",
}, () => {
  const toWsl = (file) => {
    const normalized = path.resolve(file).replace(/\\/g, "/");
    const match = /^([A-Za-z]):\/(.*)$/.exec(normalized);
    if (!match) throw new Error("Windows path required for WSL test");
    return "/mnt/" + match[1].toLowerCase() + "/" + match[2];
  };
  const source = toWsl(path.join(repoRoot, "container", "codex-auth-once.c"));
  const authRoot = "/tmp/ah-codex-auth-once-" + process.pid + "-" + Date.now();
  const script = `
set -eu
mkdir -p '${authRoot}/auth'
printf authorized > '${authRoot}/auth/auth.json'
gcc -O2 -Wall -Wextra -Werror '-DCODEX_AUTH_DIR="${authRoot}/auth"' -o '${authRoot}/auth-once' '${source}'
'${authRoot}/auth-once' sh -c '
  exec 3< "${authRoot}/auth/auth.json"
  sleep 0.2
  test ! -e "${authRoot}/auth/auth.json"
  printf recreated > "${authRoot}/auth/auth.json"
  sleep 0.2
  test ! -e "${authRoot}/auth/auth.json"
  IFS= read -r value <&3
  test "$value" = authorized
'
printf retained > '${authRoot}/keep'
exec 8< '${authRoot}/keep'
exec 9< '${authRoot}/keep'
CODEX_KEEP_FDS=9 '${authRoot}/auth-once' sh -c '
  test ! -e /proc/self/fd/8
  test -e /proc/self/fd/9
'
printf persistent > '${authRoot}/auth/auth.json'
CODEX_AUTH_PERSIST=1 '${authRoot}/auth-once' sh -c '
  IFS= read -r value < "${authRoot}/auth/auth.json"
  test "$value" = persistent
'
  test -e '${authRoot}/auth/auth.json'
  status=0
  CODEX_BWRAP_SUPERVISE=1 '${authRoot}/auth-once' sh -c ':' || status=$?
  test "$status" = 64
  '${authRoot}/auth-once' sh -c 'trap "" TERM; sleep 10 & echo $! > "${authRoot}/ignored.pid"; wait' &
launcher=$!
for n in $(seq 1 50); do [ -e "${authRoot}/ignored.pid" ] && break; sleep 0.01; done
test -e "${authRoot}/ignored.pid"
child=$(cat "${authRoot}/ignored.pid")
kill -TERM "$launcher"
status=0
wait "$launcher" || status=$?
test "$status" = 143
sleep 0.1
! kill -0 "$child" 2>/dev/null
sh -c '
  set -eu
  auth_once="$1"
  root="$2"
  CODEX_AUTH_PERSIST=1 "$auth_once" sh -c '"'"'
    trap "" TERM
    sleep 30 &
    printf "%s\\n" "$!" > "$1/parent-death-child.pid"
    : > "$1/parent-death-ready"
    wait
  '"'"' sh "$root" &
  launcher=$!
  printf "%s\\n" "$launcher" > "$root/parent-death-launcher.pid"
  n=0
  while [ ! -e "$root/parent-death-ready" ] && [ "$n" -lt 100 ]; do
    n=$((n + 1))
    sleep 0.01
  done
  test -e "$root/parent-death-ready"
  kill -KILL "$$"
' sh '${authRoot}/auth-once' '${authRoot}' &
gate_parent=$!
status=0
wait "$gate_parent" || status=$?
test "$status" = 137
launcher=$(cat '${authRoot}/parent-death-launcher.pid')
child=$(cat '${authRoot}/parent-death-child.pid')
for n in $(seq 1 100); do
  ! kill -0 "$launcher" 2>/dev/null && ! kill -0 "$child" 2>/dev/null && break
  sleep 0.01
done
! kill -0 "$launcher" 2>/dev/null
! kill -0 "$child" 2>/dev/null
`;
  try {
    assert.doesNotThrow(() => execFileSync("wsl", ["--exec", "sh", "-lc", script], { stdio: "pipe" }));
  } finally {
    spawnSync("wsl", ["--exec", "rm", "-rf", authRoot], { stdio: "ignore" });
  }
});


test("a pinned autonomous worktree keeps the approved inode across a pathname swap", {
  skip: process.platform === "linux" ? false : "directory fd pins require Linux /proc",
}, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ah-codex-pin-"));
  const engineRoot = path.join(home, "workspaces", "codex");
  const worktree = path.join(engineRoot, "repo");
  const moved = path.join(engineRoot, "approved-moved");
  fs.mkdirSync(worktree, { recursive: true });
  execFileSync("git", ["init", "-q", worktree]);
  execFileSync("git", ["-C", worktree, "checkout", "-q", "-b", "codex/work"]);
  const localBranchRunner = () => execFileSync("git", ["-C", worktree, "branch", "--show-current"], { encoding: "utf8" });
  const pin = pinAutonomousWorktree(worktree, settings(3), "codex", home, undefined, localBranchRunner);
  assert.ok(pin, "valid Rung 1 worktree must pin");
  const approved = fs.fstatSync(pin.fd);
  try {
    fs.renameSync(worktree, moved);
    fs.mkdirSync(worktree);
    assert.equal(fs.fstatSync(pin.fd).ino, approved.ino, "the inherited fd must keep the approved inode");
    assert.equal(fs.realpathSync("/proc/self/fd/" + pin.fd), fs.realpathSync(moved));
  } finally {
    fs.closeSync(pin.fd);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Codex boots an independent clone so its .git directory remains inside the outer jail", () => {
  const start = fs.readFileSync(path.join(repoRoot, "container", "start.sh"), "utf8");
  assert.match(start, /make_independent_workspace\(\)/);
  assert.match(start, /git_isolation clone --no-local/);
  assert.match(start, /independent_workspace_is_safe "\$workspace_root" "\$tmp" ""/);
  assert.match(start, /independent_workspace_is_safe "\$workspace_root" "\$tmp" "\$branch"/);
});

test("git child environment is locked and contains no token or trace controls", () => {
  const token = "github_pat_NEVER_VISIBLE_IN_CHILD_ENV_123456";
  const env = gitCredentialEnv({
    PATH: process.env.PATH,
    GIT_PUSH_TOKEN: token,
    GITHUB_TOKEN: token,
    GH_TOKEN: token,
    GIT_TRACE: "1",
    GIT_TRACE_PACKET: "1",
    SECRET_THAT_MUST_NOT_PASS: token,
  });
  assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(env.GIT_CONFIG_SYSTEM, "/dev/null");
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(Object.values(env).includes(token), false);
  assert.equal("GIT_PUSH_TOKEN" in env, false);
  assert.equal("GH_TOKEN" in env, false);
  assert.equal("GITHUB_TOKEN" in env, false);
  assert.equal(Object.keys(env).some((key) => key.startsWith("GIT_TRACE")), false);

  const probe = spawnSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.env))"], {
    env,
    encoding: "utf8",
  });
  assert.equal(probe.status, 0);
  assert.equal(probe.stdout.includes(token), false);
});

test("credential helper receives the token on fd 3, never through env", {
  skip: process.platform === "win32" ? "POSIX credential helper runs in the container" : false,
}, async () => {
  const token = "github_pat_FD_ONLY_123456789";
  const credentialPath = "Stevekaplanai/agenthost-internal.git";
  const child = spawn("sh", ["-c", 'exec "$1" get', "sh", credentialHelper], {
    env: { ...gitCredentialEnv(process.env), AGENTHOST_GIT_CREDENTIAL_PATH: credentialPath },
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
  let out = "", err = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { err += chunk; });
  child.stdin.end("protocol=https\nhost=github.com\npath=" + credentialPath + "\n\n");
  child.stdio[3].end(token + "\n");
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  assert.equal(code, 0, err);
  assert.match(out, /username=x-access-token/);
  assert.match(out, new RegExp("password=" + token));
});

test("credential-pipe closure is handled before the fallback token write", () => {
  const source = fs.readFileSync(path.join(repoRoot, "container", "gate.js"), "utf8");
  assert.match(source, /child\.stdio\[3\]\.on\("error", \(\) => \{\}\);\s*child\.stdio\[3\]\.end\(fd3Token/,
    "a short-lived Git helper closing fd 3 must not restart the gate with EPIPE");
});

test("POSIX child cannot read the token through env, printenv, or proc", {
  skip: process.platform === "win32" ? "requires the container's /proc" : false,
}, () => {
  const token = "github_pat_NOT_IN_PROC_123456789";
  const probe = execFileSync("sh", ["-c", "env; printenv; tr '\\0' '\\n' </proc/self/environ"], {
    env: gitCredentialEnv({ ...process.env, GIT_PUSH_TOKEN: token, GH_TOKEN: token, GIT_TRACE: token }),
    encoding: "utf8",
  });
  assert.equal(probe.includes(token), false);
  assert.equal(probe.includes("GIT_PUSH_TOKEN="), false);
  assert.equal(probe.includes("GH_TOKEN="), false);
  assert.equal(probe.includes("GIT_TRACE="), false);
});

test("host git command pins the worktree and locks executable config", () => {
  const worktree = path.resolve(os.tmpdir(), "ah-hostile-worktree");
  const command = buildHardenedGitCommand(worktree, ["status", "--short"]);
  assert.equal(command.bin, "git");
  assert.ok(command.args.includes("core.hooksPath=/dev/null"));
  assert.ok(command.args.includes("core.fsmonitor="));
  assert.ok(command.args.includes("core.worktree=" + worktree));
  assert.ok(command.args.includes(worktree));
  assert.equal(command.env.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(Object.keys(command.env).some((key) => /TOKEN|SECRET|TRACE/.test(key)), false);
});

test("agent-owned Git metadata is always reached through a networkless Bubblewrap jail", () => {
  const worktree = "/tmp/ah-hostile-worktree";
  const command = buildJailedGitCommand(worktree, ["commit", "--no-verify", "-m", "safe"], undefined, {
    requiredRwBindAt: [{ src: "/tmp/ah-gate-output", dest: "/agenthost-transport" }],
  });
  assert.equal(command.bin, "/usr/bin/bwrap");
  assert.ok(command.args.includes("--unshare-net"));
  assert.ok(command.args.includes("--clearenv"));
  assert.ok(command.args.includes("--bind"));
  assert.ok(command.args.includes(worktree));
  assert.ok(command.args.includes("/workspace"));
  assert.ok(command.args.includes("/tmp/ah-gate-output"));
  assert.ok(command.args.includes("/agenthost-transport"));
  assert.ok(command.args.includes("core.hooksPath=/dev/null"));
  assert.ok(command.args.includes("core.fsmonitor="));
  assert.equal(command.env.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(Object.keys(command.env).some((key) => /TOKEN|SECRET|TRACE/.test(key)), false);
});

test("automatic review refuses opaque GitHub compare metadata and binary patches", () => {
  const textFile = { filename: "src/app.js", status: "modified", patch: "@@ -1 +1 @@\n-old\n+new\n" };
  assert.equal(gitCompareIsFullyReviewable({ files: [textFile] }), true);
  assert.equal(gitCompareIsFullyReviewable({ files: [{ ...textFile, patch: undefined }] }), false, "missing GitHub patch is opaque");
  assert.equal(gitCompareIsFullyReviewable({ files: [textFile], too_large: true }), false);
  assert.equal(gitCompareIsFullyReviewable({ files: Array.from({ length: 300 }, () => textFile) }), false, "GitHub may omit files at its compare cap");
  assert.equal(gitDiffIsFullyReviewable("diff --git a/src/app.js b/src/app.js\n--- a/src/app.js\n+++ b/src/app.js\n"), true);
  assert.equal(gitDiffIsFullyReviewable("diff --git a/src/app.js b/src/app.js\n--- a/src/app.js\n+++ b/src/app.js\n", 2), false, "raw review must cover every JSON comparison file");
  assert.equal(gitDiffIsFullyReviewable("diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n"), false);
  assert.equal(gitDiffIsFullyReviewable("diff --git a/blob b/blob\nGIT binary patch\nliteral 4\n"), false);
});

test("merge attempts keep uncertain GitHub responses pending for reconciliation", () => {
  for (const status of [undefined, 0, 401, 403, 404, 429, 500, 502, 503]) {
    assert.equal(gitMergeResponseNeedsReconciliation(status), true, "status " + status + " can follow a processed merge");
  }
  for (const status of [405, 409, 422]) {
    assert.equal(gitMergeResponseNeedsReconciliation(status), false, "documented GitHub refusal " + status + " may be reconciled immediately");
  }
});

function realJailAvailable() {
  if (process.platform !== "linux") return false;
  const probe = spawnSync("unshare", ["--user", "--map-root-user", "--mount", "sh", "-c",
    "J=$(mktemp -d); mkdir -p $J/usr; mount --bind /usr $J/usr"], { stdio: "ignore" });
  return probe.status === 0;
}

function realBwrapAvailable() {
  if (process.platform !== "linux") return false;
  try {
    const version = spawnSync("/usr/bin/bwrap", ["--version"], { stdio: "ignore" }).status === 0;
    if (!version) return false;
    // Probe that unprivileged user namespaces actually work for bwrap on this host.
    // A setuid bwrap is not required where user namespaces are available.
    const probe = spawnSync("/usr/bin/bwrap", [
      "--ro-bind", "/usr", "/usr",
      "--ro-bind", "/bin", "/bin",
      "--ro-bind", "/lib", "/lib",
      "--ro-bind", "/lib64", "/lib64",
      "--ro-bind", "/sbin", "/sbin",
      "--proc", "/proc",
      "--dev", "/dev",
      "--unshare-user-try",
      "--bind", "/tmp", "/tmp",
      "/bin/sh", "-c", "echo ok"
    ], { stdio: "ignore" });
    return probe.status === 0;
  } catch {
    return false;
  }
}

function realBwrapLifecycleFdsAvailable() {
  if (!realBwrapAvailable()) return false;
  const help = spawnSync("/usr/bin/bwrap", ["--help"], { encoding: "utf8" });
  return help.status === 0
    && /--info-fd FD/.test(String(help.stdout))
    && /--json-status-fd FD/.test(String(help.stdout));
}

test("Bubblewrap lifecycle descriptors are explicit, distinct, and closed before the engine", () => {
  const wrapper = chains.buildBwrapReadJail("/bin/true", [], { infoFd: 8, jsonStatusFd: 9, blockFd: 10 });
  assert.equal(wrapper.bin, "/usr/bin/bwrap");
  const infoAt = wrapper.args.indexOf("--info-fd");
  const statusAt = wrapper.args.indexOf("--json-status-fd");
  const blockAt = wrapper.args.indexOf("--block-fd");
  assert.deepEqual(wrapper.args.slice(infoAt, infoAt + 2), ["--info-fd", "8"]);
  assert.deepEqual(wrapper.args.slice(statusAt, statusAt + 2), ["--json-status-fd", "9"]);
  assert.deepEqual(wrapper.args.slice(blockAt, blockAt + 2), ["--block-fd", "10"]);
  const separator = wrapper.args.lastIndexOf("--");
  assert.match(wrapper.args[separator + 3], /exec 8<&-; exec 9<&-; exec 10<&-; exec "\$@"/,
    "lifecycle descriptors must close before the model command starts");

  for (const opts of [
    { infoFd: 2 },
    { infoFd: "8" },
    { jsonStatusFd: 1025 },
    { jsonStatusFd: 8.5 },
    { infoFd: 8, jsonStatusFd: 8 },
    { infoFd: 8, jsonStatusFd: 9 },
  ]) {
    assert.equal(chains.buildBwrapReadJail("/bin/true", [], opts).bin, "/usr/bin/false",
      "invalid lifecycle descriptor must fail closed");
  }
});

function hostDescendants(pid, seen = new Set()) {
  const id = Number(pid);
  if (!Number.isInteger(id) || id < 2 || seen.has(id)) return [];
  seen.add(id);
  let children = [];
  try {
    children = fs.readFileSync(`/proc/${id}/task/${id}/children`, "utf8")
      .trim().split(/\s+/).filter(Boolean).map(Number);
  } catch {}
  return children.flatMap((child) => [child, ...hostDescendants(child, seen)]);
}

function hostProcessIsGoneOrZombie(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(" ")[2] === "Z";
  } catch {
    return true;
  }
}

function realCodexIntegrationAvailable() {
  if (process.env.AGENTHOST_RUN_CODEX_INTEGRATION !== "1" || !realBwrapAvailable()) return false;
  const bin = process.env.CODEX_BIN || "/usr/local/bin/codex";
  return fs.existsSync(bin)
    && fs.existsSync(codexAuthOnce)
    && fs.existsSync(codexNativeBin)
    && codexSavedLoginAvailable(process.env.HOME);
}

test("production commit function does not execute a planted pre-commit hook", {
  skip: realBwrapAvailable() ? false : "requires Linux setuid Bubblewrap (the container runtime)",
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-hook-hostility-"));
  const parent = path.join(root, "parent");
  const branch = "codex/task-task_42";
  const repoName = "repo";
  const worktree = path.join(root, "workspaces", "codex", "repo--task-task_42");
  fs.mkdirSync(parent);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: parent });
  fs.writeFileSync(path.join(parent, "safe.txt"), "before\n");
  execFileSync("git", [...gitHardenedConfigArgs(), "-C", parent, "add", "safe.txt"]);
  execFileSync("git", [...gitHardenedConfigArgs(), "-C", parent, "commit", "--no-verify", "--no-gpg-sign", "-m", "base"]);
  const mainBefore = execFileSync("git", ["-C", parent, "rev-parse", "main"], { encoding: "utf8" }).trim();
  execFileSync("git", ["clone", "-q", parent, worktree]);
  execFileSync("git", ["-C", worktree, "checkout", "-q", "-b", branch]);

  const sentinel = path.join(worktree, "HOOK_EXECUTED");
  const hook = path.join(worktree, ".git", "hooks", "pre-commit");
  const hookBody = process.platform === "win32"
    ? "#!/bin/sh\ntouch HOOK_EXECUTED\n"
    : "#!/bin/sh\ntouch \"$PWD/HOOK_EXECUTED\"\n";
  fs.writeFileSync(hook, hookBody, { mode: 0o755 });
  fs.writeFileSync(path.join(worktree, "safe.txt"), "after\n");
  const result = commitAgentWorktree("codex", repoName, worktree, undefined, branch);
  assert.equal(result.ok, true, result.error);
  assert.match(result.headSha, /^[0-9a-f]{40}$/);
  assert.equal(fs.existsSync(sentinel), false, "hostile hook executed");
  assert.equal(execFileSync("git", ["-C", parent, "rev-parse", "main"], { encoding: "utf8" }).trim(), mainBefore, "shared main moved");
  assert.notEqual(execFileSync("git", ["-C", worktree, "rev-parse", branch], { encoding: "utf8" }).trim(), mainBefore, "task branch did not advance");
});

test("production commit cannot follow hostile .git reflog or commit-message symlinks onto the host", {
  skip: realBwrapAvailable() ? false : "requires Linux setuid Bubblewrap (the container runtime)",
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-git-metadata-symlink-"));
  const branch = "codex/task-task_42";
  const repoName = "repo";
  const worktree = path.join(root, "workspaces", "codex", "repo--task-task_42");
  const protectedState = path.join(root, "gate-state.json");
  try {
    fs.mkdirSync(worktree, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", branch, worktree]);
    fs.writeFileSync(path.join(worktree, "seed.txt"), "seed\n");
    execFileSync("git", [...gitHardenedConfigArgs(), "-C", worktree, "add", "seed.txt"]);
    execFileSync("git", [...gitHardenedConfigArgs(), "-C", worktree, "commit", "--no-verify", "--no-gpg-sign", "-m", "seed"]);
    fs.writeFileSync(protectedState, '{"must":"not change"}\n');
    for (const name of ["COMMIT_EDITMSG", path.join("logs", "HEAD")]) {
      const target = path.join(worktree, ".git", name);
      fs.rmSync(target, { force: true });
      fs.symlinkSync(protectedState, target);
    }
    fs.writeFileSync(path.join(worktree, "safe.txt"), "change\n");
    const result = commitAgentWorktree("codex", repoName, worktree, undefined, branch);
    assert.notEqual(result.ok, true, "hostile Git metadata must fail closed rather than commit through a host path");
    assert.equal(fs.readFileSync(protectedState, "utf8"), '{"must":"not change"}\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("production commit refuses main even when the path looks engine-owned", {
  skip: realBwrapAvailable() ? false : "requires Linux setuid Bubblewrap (the container runtime)",
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-main-refusal-"));
  const branch = "codex/task-task_42";
  const repoName = "repo";
  const worktree = path.join(root, "workspaces", "codex", "repo--task-task_42");
  fs.mkdirSync(worktree, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: worktree });
  fs.writeFileSync(path.join(worktree, "unsafe.txt"), "must not commit\n");
  const result = commitAgentWorktree("codex", repoName, worktree, undefined, branch);
  assert.equal(result.error, "refusing commit outside " + branch);
});

test("production commit refuses a symlinked engine workspace", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-worktree-symlink-"));
  const outside = path.join(root, "outside");
  const repoName = "repo";
  const claimed = path.join(root, "workspaces", "codex", "repo--task-task_42");
  fs.mkdirSync(outside, { recursive: true });
  fs.mkdirSync(path.dirname(claimed), { recursive: true });
  try {
    fs.symlinkSync(outside, claimed, process.platform === "win32" ? "junction" : "dir");
  } catch {
    t.skip("symlink creation is unavailable on this host");
    return;
  }
  const result = commitAgentWorktree("codex", repoName, claimed, undefined, "codex/task-task_42");
  assert.equal(result.error, "worktree is not an independent engine directory");
});

test("production commit refuses repository-configured external filters", {
  skip: realBwrapAvailable() ? false : "requires Linux setuid Bubblewrap (the container runtime)",
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-filter-refusal-"));
  const branch = "codex/task-task_42";
  const repoName = "repo";
  const worktree = path.join(root, "workspaces", "codex", "repo--task-task_42");
  fs.mkdirSync(worktree, { recursive: true });
  execFileSync("git", ["init", "-b", branch], { cwd: worktree });
  execFileSync("git", ["-C", worktree, "config", "filter.hostile.clean", "touch FILTER_EXECUTED"]);
  fs.writeFileSync(path.join(worktree, ".gitattributes"), "*.txt filter=hostile\n");
  fs.writeFileSync(path.join(worktree, "unsafe.txt"), "must not filter\n");
  const result = commitAgentWorktree("codex", repoName, worktree, undefined, branch);
  assert.equal(result.error, "refusing worktree with external-command git config");
  assert.equal(fs.existsSync(path.join(worktree, "FILTER_EXECUTED")), false);
});

test("clean transport pushes only the exact private commit and never runs a source hook", {
  skip: realBwrapAvailable() ? false : "requires Linux setuid Bubblewrap (the container runtime)",
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-clean-transport-"));
  const seed = path.join(root, "seed");
  const branch = "codex/task-task_42";
  const repoName = "repo";
  const source = path.join(root, "workspaces", "codex", "repo--task-task_42");
  const remote = path.join(root, "remote.git");
  const transport = path.join(root, "transport");
  const bundleRoot = path.join(root, "bundle-output");
  const bundle = path.join(bundleRoot, "source.bundle");
  const runJailed = (args, options) => {
    const fd = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    const command = buildJailedGitCommand(source, args, fd, options);
    try {
      return execFileSync(command.bin, command.args, {
        cwd: command.cwd, env: command.env, encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe", fd],
      });
    } finally {
      fs.closeSync(fd);
    }
  };
  const runTransport = (args) => execFileSync("git", [...gitHardenedConfigArgs(), "-C", transport, ...args], {
    env: gitCredentialEnv(process.env), encoding: "utf8",
  });
  try {
    fs.mkdirSync(seed);
    execFileSync("git", ["init", "-q", "-b", "main", seed]);
    fs.writeFileSync(path.join(seed, "safe.txt"), "base\n");
    execFileSync("git", [...gitHardenedConfigArgs(), "-C", seed, "add", "safe.txt"]);
    execFileSync("git", [...gitHardenedConfigArgs(), "-C", seed, "commit", "--no-verify", "--no-gpg-sign", "-m", "base"]);
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.mkdirSync(bundleRoot);
    execFileSync("git", ["clone", "-q", seed, source]);
    execFileSync("git", ["-C", source, "checkout", "-q", "-b", branch]);
    execFileSync("git", ["init", "--bare", "-q", remote]);
    const mainBefore = execFileSync("git", ["-C", seed, "rev-parse", "main"], { encoding: "utf8" }).trim();
    const sentinel = path.join(source, "PUSH_HOOK_EXECUTED");
    fs.writeFileSync(path.join(source, ".git", "hooks", "pre-push"), process.platform === "win32"
      ? "#!/bin/sh\ntouch PUSH_HOOK_EXECUTED\n"
      : "#!/bin/sh\ntouch \"$PWD/PUSH_HOOK_EXECUTED\"\n", { mode: 0o755 });
    fs.writeFileSync(path.join(source, "safe.txt"), "private change\n");
    const committed = commitAgentWorktree("codex", repoName, source, undefined, branch);
    assert.equal(committed.ok, true, committed.error);
    runJailed(["bundle", "create", "/agenthost-transport/source.bundle", branch], {
      requiredRwBindAt: [{ src: bundleRoot, dest: "/agenthost-transport" }],
    });
    assert.equal(fs.existsSync(bundle), true, "the jailed bundle must cross only through the gate-created transport bind");
    fs.mkdirSync(transport);
    runTransport(["init", "--quiet"]);
    runTransport(["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", bundle, "refs/heads/" + branch + ":refs/heads/agenthost/source"]);
    const copied = runTransport(["rev-parse", "refs/heads/agenthost/source"]).trim();
    assert.equal(copied, committed.headSha);
    runTransport(["push", "--porcelain", "--no-verify", remote, "refs/heads/agenthost/source:refs/heads/" + branch]);
    assert.equal(execFileSync("git", ["--git-dir", remote, "rev-parse", "refs/heads/" + branch], { encoding: "utf8" }).trim(), committed.headSha);
    assert.equal(execFileSync("git", ["-C", seed, "rev-parse", "main"], { encoding: "utf8" }).trim(), mainBefore);
    assert.equal(fs.existsSync(sentinel), false, "a source pre-push hook executed on the host");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("REAL JAIL: only the selected worktree is writable on the host", {
  skip: realJailAvailable() ? false : "requires Linux unprivileged user namespaces",
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-real-jail-"));
  const worktree = path.join(root, "selected-worktree");
  fs.mkdirSync(worktree);
  const wrapper = chains.buildReadJail("/bin/sh", ["-c", "touch /workspace/JAIL_WROTE; touch /tmp/EPHEMERAL"], {
    home: "/hm",
    requiredRwBindAt: [{ src: worktree, dest: "/workspace" }],
  });
  const run = spawnSync(wrapper.bin, wrapper.args, { env: gitCredentialEnv(process.env), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(fs.existsSync(path.join(worktree, "JAIL_WROTE")), true);
  assert.equal(fs.existsSync(path.join(root, "EPHEMERAL")), false);
});

test("REAL JAIL: a missing required worktree aborts before the engine starts", {
  skip: realJailAvailable() ? false : "requires Linux unprivileged user namespaces",
}, () => {
  const missing = path.join(os.tmpdir(), "ah-required-missing-" + process.pid);
  const wrapper = chains.buildReadJail("/bin/sh", ["-c", "exit 0"], {
    home: "/hm",
    requiredRwBindAt: [{ src: missing, dest: "/workspace" }],
  });
  const run = spawnSync(wrapper.bin, wrapper.args, { env: gitCredentialEnv(process.env), encoding: "utf8" });
  assert.notEqual(run.status, 0, "the engine must not start without its granted worktree mount");
});

test("REAL BWRAP JAIL: Codex keeps an inner user namespace, writes only its workspace, and ignores a hostile hook", {
  skip: realBwrapAvailable() ? false : "requires Linux setuid Bubblewrap (the container runtime)",
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-real-bwrap-"));
  const worktree = path.join(root, "worktree");
  fs.mkdirSync(worktree);
  let workspaceFd = null;
  try {
    execFileSync("git", ["init", "-q", worktree]);
    execFileSync("git", ["-C", worktree, "checkout", "-q", "-b", "codex/work"]);
    fs.writeFileSync(path.join(worktree, "safe.txt"), "before\n");
    const hook = path.join(worktree, ".git", "hooks", "pre-commit");
    fs.writeFileSync(hook, "#!/bin/sh\ntouch \"$PWD/HOOK_EXECUTED\"\n", { mode: 0o755 });
    workspaceFd = fs.openSync(worktree, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    const wrapper = chains.buildBwrapReadJail("/bin/sh", ["-c", [
      "test ! -e /home",
      "test -r /etc/resolv.conf",
      "unshare --user --map-root-user true",
      "printf changed > /workspace/safe.txt",
      "git -C /workspace add safe.txt",
      "git -C /workspace -c user.name=Smoke -c user.email=smoke@example.test commit -qm smoke",
    ].join(" && ")], {
      env: chains.sandboxedCodexEnv({ PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/hm", LANG: "C.UTF-8" }),
      requiredRwBindAt: [{ src: "/proc/self/fd/3", dest: "/workspace" }],
      closeFds: [3],
    });
    const run = spawnSync(wrapper.bin, wrapper.args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe", workspaceFd] });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(fs.existsSync(path.join(worktree, "HOOK_EXECUTED")), false, "hostile hook executed");
    assert.equal(fs.readFileSync(path.join(worktree, "safe.txt"), "utf8"), "changed");
  } finally {
    if (workspaceFd !== null) fs.closeSync(workspaceFd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("REAL BWRAP JAIL: an inherited directory fd defeats a bind-source pathname swap", {
  skip: realBwrapAvailable() ? false : "requires Linux setuid Bubblewrap (the container runtime)",
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-real-bwrap-pin-"));
  const original = path.join(root, "workspace");
  const moved = path.join(root, "approved-moved");
  const replacement = path.join(root, "replacement");
  fs.mkdirSync(original);
  fs.mkdirSync(replacement);
  let fd = null;
  try {
    const approvedInode = fs.statSync(original).ino;
    fd = fs.openSync(original, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    fs.renameSync(original, moved);
    fs.symlinkSync(replacement, original, "dir");
    const wrapper = chains.buildBwrapReadJail("/usr/bin/stat", ["-c", "%i", "/workspace"], {
      env: chains.sandboxedCodexEnv({ PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/hm", LANG: "C.UTF-8" }),
      requiredRwBindAt: [{ src: "/proc/self/fd/3", dest: "/workspace" }],
      closeFds: [3],
    });
    const run = spawnSync(wrapper.bin, wrapper.args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe", fd] });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(Number(String(run.stdout).trim()), approvedInode, "Bwrap must mount the pinned inode, not the replacement path");
  } finally {
    if (fd !== null) fs.closeSync(fd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("REAL BWRAP JAIL: bind-source descriptors close before the engine starts", {
  skip: realBwrapAvailable() && fs.existsSync(codexAuthOnce)
    ? false
    : "requires the deployed auth-once launcher and Linux setuid Bubblewrap",
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-real-bwrap-fd-close-"));
  const auth = path.join(root, "codex");
  fs.mkdirSync(auth);
  fs.writeFileSync(path.join(auth, "auth.json"), "AUTH_MUST_STAY_HIDDEN\n");
  let fd = null;
  try {
    fd = fs.openSync(auth, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    const wrapper = chains.buildBwrapReadJail("/bin/sh", ["-c", [
      "test ! -e /proc/self/fd/3",
      "test ! -r /proc/self/fd/3/auth.json",
      "test -r /codex/auth.json",
    ].join(" && ")], {
      env: chains.sandboxedCodexEnv({ PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/hm", LANG: "C.UTF-8" }),
      roBindsAt: [{ src: "/proc/self/fd/3", dest: "/codex" }],
      closeFds: [3],
    });
    const run = spawnSync(codexAuthOnce, [wrapper.bin, ...wrapper.args], {
      encoding: "utf8",
      env: { ...process.env, CODEX_AUTH_DIR: auth, CODEX_KEEP_FDS: "3" },
      stdio: ["ignore", "pipe", "pipe", fd],
    });
    assert.equal(run.status, 0, run.stderr);
  } finally {
    if (fd !== null) fs.closeSync(fd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("REAL BWRAP JAIL: the outer auth watcher deletes the credential and the jailed model cannot recreate it", {
  skip: realBwrapAvailable() && fs.existsSync(codexAuthOnce)
    ? false
    : "requires the deployed auth-once launcher and Linux setuid Bubblewrap",
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-real-bwrap-auth-once-"));
  const auth = path.join(root, "auth");
  fs.mkdirSync(auth);
  fs.writeFileSync(path.join(auth, "auth.json"), "AUTH_MUST_NOT_SURVIVE\n", { mode: 0o600 });
  let fd = null;
  try {
    fd = fs.openSync(auth, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    const wrapper = chains.buildBwrapReadJail("/bin/sh", ["-c", [
      "test -z \"$CODEX_AUTH_DIR\"",
      "test -z \"$CODEX_KEEP_FDS\"",
      "exec 9< /codex/auth.json",
      "sleep 0.2",
      "test ! -e /codex/auth.json",
      "! printf recreated > /codex/auth.json",
      "IFS= read -r auth_value <&9",
      "test \"$auth_value\" = AUTH_MUST_NOT_SURVIVE",
    ].join(" && ")], {
      env: chains.sandboxedCodexEnv({ PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/hm", LANG: "C.UTF-8" }),
      roBindsAt: [{ src: "/proc/self/fd/3", dest: "/codex" }],
      closeFds: [3],
    });
    const run = spawnSync(codexAuthOnce, [wrapper.bin, ...wrapper.args], {
      encoding: "utf8",
      env: { ...process.env, CODEX_AUTH_DIR: auth, CODEX_KEEP_FDS: "3" },
      stdio: ["ignore", "pipe", "pipe", fd],
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(fs.existsSync(path.join(auth, "auth.json")), false, "the host credential survived its first Codex open");
  } finally {
    if (fd !== null) fs.closeSync(fd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("REAL BWRAP JAIL: Codex has no access token and sees only its fresh PID namespace", {
  skip: realBwrapAvailable() ? false : "requires Linux setuid Bubblewrap (the container runtime)",
}, () => {
  const token = "real-codex-token-for-test-only";
  const env = codexAutonomousEnv({ PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/host-home", LANG: "C.UTF-8", CODEX_ACCESS_TOKEN: token });
  const hostProbe = spawn("/bin/sleep", ["5"]);
  try {
    const wrapper = chains.buildBwrapReadJail("/bin/sh", ["-xc", [
      "test -z \"$CODEX_ACCESS_TOKEN\"",
      "! printenv | grep -Fqx " + JSON.stringify("CODEX_ACCESS_TOKEN=" + token),
      "! tr '\\0' '\\n' < /proc/1/environ | grep -Fqx " + JSON.stringify("CODEX_ACCESS_TOKEN=" + token),
      "! test -e /codex/auth.json",
      "! test -e /proc/" + hostProbe.pid + "/environ",
      "test -d /proc/1/fd",
      "! (mkdir /tmp/reproc && unshare --user --map-root-user --mount sh -c 'mount -t proc proc /tmp/reproc')",
    ].join(" && ")], { env });
    const run = spawnSync(wrapper.bin, wrapper.args, { encoding: "utf8" });
    assert.equal(run.status, 0, run.stdout + run.stderr);
  } finally {
    hostProbe.kill("SIGKILL");
  }
});

test("REAL BWRAP JAIL: lifecycle FDs report the host child PID and never reach the model", {
  skip: realBwrapLifecycleFdsAvailable() ? false : "requires Linux setuid Bubblewrap with --info-fd and --json-status-fd",
  timeout: 10000,
}, async () => {
  const wrapper = chains.buildBwrapReadJail("/bin/sh", ["-c", [
    "test ! -e /proc/self/fd/3",
    "test ! -e /proc/self/fd/4",
    "test ! -e /proc/self/fd/5",
  ].join(" && ")], {
    env: chains.sandboxedCodexEnv({ PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/hm", LANG: "C.UTF-8" }),
    infoFd: 3,
    jsonStatusFd: 4,
    blockFd: 5,
  });
  const run = spawn(wrapper.bin, wrapper.args, {
    stdio: ["ignore", "pipe", "pipe", "pipe", "pipe", "pipe"],
  });
  const output = ["", "", "", "", ""];
  for (let fd = 1; fd <= 4; fd++) run.stdio[fd].on("data", (data) => { output[fd] += data; });
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { run.kill("SIGKILL"); } catch {}
      reject(new Error("Bubblewrap did not leave the lifecycle block gate"));
    }, 5000);
    run.once("error", (error) => { clearTimeout(timer); reject(error); });
    run.once("close", (code) => { clearTimeout(timer); resolve(code); });
  });
  run.stdio[5].end("1");
  const code = await result;
  assert.equal(code, 0, output[1] + output[2]);
  const info = JSON.parse(output[3]);
  assert.ok(Number.isInteger(info["child-pid"]) && info["child-pid"] > 1,
    "--info-fd must identify Bubblewrap's host-visible child process");
  const status = output[4].trim()
    .split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(status.some((event) => Number.isInteger(event["child-pid"]) && event["child-pid"] > 1),
    "--json-status-fd must report the host-visible child process at launch");
  assert.ok(status.some((event) => event["exit-code"] === 0),
    "--json-status-fd must report the final child exit status");
});

test("REAL BWRAP JAIL: terminating the outer run kills the auth-launcher child tree", {
  skip: realBwrapAvailable() && fs.existsSync(codexAuthOnce)
    ? false
    : "requires the deployed auth-once launcher and Linux setuid Bubblewrap",
  timeout: 10000,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-auth-once-stop-"));
  const auth = path.join(root, "auth");
  const scratch = path.join(root, "scratch");
  fs.mkdirSync(auth); fs.mkdirSync(scratch);
  try {
    const wrapper = chains.buildBwrapReadJail("/bin/sh", ["-c", "trap '' TERM; sleep 30 & echo $! > /scratch/child.pid; wait"], {
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/hm", CODEX_HOME: "/codex" },
      rwBindAt: [{ src: scratch, dest: "/scratch" }],
      roBindsAt: [{ src: auth, dest: "/codex" }],
    });
    const outer = spawn(codexAuthOnce, [wrapper.bin, ...wrapper.args], {
      stdio: "ignore",
      env: { ...process.env, CODEX_AUTH_DIR: auth },
    });
    const closed = new Promise((resolve) => outer.once("close", resolve));
    const pidFile = path.join(scratch, "child.pid");
    for (let i = 0; i < 50 && !fs.existsSync(pidFile); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(fs.existsSync(pidFile), "the auth-launcher child did not start");
    const hostPids = hostDescendants(outer.pid);
    assert.ok(hostPids.length > 0, "the outer Bwrap process has no host-visible child to verify");
    outer.kill("SIGTERM");
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (const pid of hostPids) {
      assert.ok(hostProcessIsGoneOrZombie(pid), `host child ${pid} survived an outer-run termination`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("REAL CODEX: two subscription runs hide persistent auth and commit hook-safely", {
  skip: realCodexIntegrationAvailable() ? false : "set AGENTHOST_RUN_CODEX_INTEGRATION=1 on a logged-in box with the auth-once launcher",
  timeout: 180000,
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-real-codex-config-"));
  const worktree = path.join(root, "workspace");
  const scratch = path.join(root, "scratch");
  const authHome = path.join(process.env.HOME, ".codex");
  const codexBinHost = process.env.CODEX_BIN || "/usr/local/bin/codex";
  const codexBin = "/opt/codex/bin/codex";
  const codexInstallDir = path.resolve(codexBinHost, "..", "..");
  fs.mkdirSync(worktree);
  fs.mkdirSync(scratch);
  const fds = [];
  try {
    assert.equal(codexSavedLoginAvailable(process.env.HOME), true, "the trusted ChatGPT device login must be ready");
    execFileSync("git", ["init", "-q", "-b", "codex/work", worktree]);
    execFileSync("git", ["-C", worktree, "config", "user.name", "AgentHost Integration"]);
    execFileSync("git", ["-C", worktree, "config", "user.email", "integration@agenthost.invalid"]);
    fs.writeFileSync(path.join(worktree, "seed.txt"), "seed\n");
    execFileSync("git", ["-C", worktree, "add", "seed.txt"]);
    execFileSync("git", ["-C", worktree, "commit", "-qm", "seed"]);
    fs.writeFileSync(path.join(worktree, ".git", "hooks", "pre-commit"),
      "#!/bin/sh\ntouch \"$PWD/HOOK_EXECUTED\"\n", { mode: 0o755 });

    for (const dir of [worktree, scratch, authHome]) {
      fds.push(fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW));
    }
    for (const attempt of [1, 2]) {
      const fileName = `integration-${attempt}.txt`;
      const subject = `integration-test-${attempt}`;
      const args = codexAutonomousArgs(
        [
          "First run all of these checks exactly: test -z \"${CODEX_ACCESS_TOKEN:-}\"; ! printenv | grep -q '^CODEX_ACCESS_TOKEN='; test \"$$\" -eq 1; for fd in /proc/1/fd/*; do readlink \"$fd\" 2>/dev/null | grep -q auth.json && { echo AUTH_FD_VISIBLE; exit 96; }; done; echo AUTH_FD_HIDDEN; test ! -r /codex/auth.json; ! cat /codex/auth.json; ! cat /proc/1/root/codex/auth.json; ! cat /proc/self/root/codex/auth.json; ! sh -c 'printf blocked > /codex/auth.json'.",
          `Then write ${fileName} containing the word verified. Commit that file locally with the exact subject ${subject}.`,
          `Finish with exact text CODEX_INTEGRATION_OK_${attempt}.`,
        ].join(" "),
        "",
        "/workspace",
        true,
      );
      const wrapper = chains.buildBwrapReadJail(codexBin, args, {
        env: codexAutonomousEnv({ PATH: "/opt/codex/bin:/usr/local/bin:/usr/bin:/bin", HOME: "/hm" }),
        roBindsAt: [{ src: codexInstallDir, dest: "/opt/codex" }],
        rwBindAt: [
          { src: "/proc/self/fd/4", dest: "/scratch" },
          { src: "/proc/self/fd/5", dest: "/codex" },
        ],
        requiredRwBindAt: [{ src: "/proc/self/fd/3", dest: "/workspace" }],
        closeFds: [3, 4, 5],
      });
      const run = spawnSync(codexAuthOnce, [wrapper.bin, ...wrapper.args], {
        encoding: "utf8",
        env: { ...process.env, CODEX_AUTH_DIR: authHome, CODEX_AUTH_PERSIST: "1", CODEX_KEEP_FDS: "3,4,5" },
        stdio: ["ignore", "pipe", "pipe", ...fds],
        timeout: 170000,
      });
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stdout, new RegExp(`CODEX_INTEGRATION_OK_${attempt}`));
      const commandOutput = run.stdout.split("\n").flatMap((line) => {
        try {
          const event = JSON.parse(line);
          return event.item && event.item.type === "command_execution" && event.item.aggregated_output
            ? [event.item.aggregated_output]
            : [];
        } catch { return []; }
      }).join("\n");
      assert.match(commandOutput, /AUTH_FD_HIDDEN/, "the model tool sandbox could not prove the Codex auth FD is hidden");
      assert.doesNotMatch(commandOutput, /AUTH_FD_VISIBLE/, "the model tool sandbox reached Codex's auth FD");
      assert.equal(fs.existsSync(path.join(authHome, "auth.json")), true, "the persistent ChatGPT login was removed");
      assert.equal(fs.readFileSync(path.join(worktree, fileName), "utf8").trim(), "verified");
      assert.equal(execFileSync("git", ["-C", worktree, "log", "-1", "--format=%s"], { encoding: "utf8" }).trim(), subject);
    }
    assert.equal(fs.existsSync(path.join(worktree, "HOOK_EXECUTED")), false, "model-run Git executed the planted hook");
  } finally {
    for (const fd of fds) { try { fs.closeSync(fd); } catch {} }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- A2 red-team fixes (2026-08-01) -------------------------------------------

// GIT_PROCESS_TIMEOUT_MS was READ and never DECLARED, so every async git call that
// did not pass an explicit timeout threw ReferenceError inside the Promise
// executor. pushGitChange's catch-all swallowed it as "could not prepare secure
// Git transport" -- rungs 2-3 could never succeed, and the Governed-Write Proof
// would have failed on it. Pin both the declaration order and the real default
// branch: a source-only reimplementation previously let this defect stay green.
test("the async git timeout default executes production code, so the push path is not dead code", async () => {
  const source = fs.readFileSync(path.join(repoRoot, "container", "gate.js"), "utf8");
  assert.match(source, /const GIT_PROCESS_TIMEOUT_MS = /,
    "GIT_PROCESS_TIMEOUT_MS must be declared, not merely referenced");
  // It must be declared BEFORE the lib-mode `require.main` early return, or it is
  // in the temporal dead zone for every unit test that require()s this file.
  const declaredAt = source.indexOf("const GIT_PROCESS_TIMEOUT_MS = ");
  const libModeReturnAt = source.indexOf("if (require.main !== module)");
  assert.ok(declaredAt > -1 && declaredAt < libModeReturnAt,
    "the constant must be declared above the lib-mode export return");
  const result = await gitCommandResult({
    bin: process.execPath,
    args: ["-e", "process.stdout.write('DEFAULT_TIMEOUT_OK')"],
    cwd: os.tmpdir(),
    env: process.env,
  });
  assert.equal(result.ok, true);
  assert.equal(result.stdout, "DEFAULT_TIMEOUT_OK");
});

test("credentialed Git uses a terminal PID namespace around the clean transport", () => {
  const syntheticToken = "synthetic-builder-token-must-not-escape";
  const previousToken = process.env.GIT_PUSH_TOKEN;
  process.env.GIT_PUSH_TOKEN = syntheticToken;
  try {
    const command = buildCredentialedGitCommand(
      "/tmp/agenthost-clean-transport",
      ["ls-remote", "https://github.com/Stevekaplanai/agenthost-internal.git"],
      "Stevekaplanai/agenthost-internal.git",
    );
    assert.equal(command.bin, "/usr/bin/bwrap");
    assert.equal(command.terminalContainment, "bwrap-pidns");
    assert.ok(command.args.includes("--unshare-pid"));
    assert.ok(command.args.includes("--die-with-parent"));
    assert.ok(command.args.includes("/tmp/agenthost-clean-transport"));
    assert.ok(command.args.includes("/workspace"));
    assert.ok(command.args.includes("credential.helper=/usr/local/bin/agenthost-git-credential"));
    assert.equal(command.args.includes("--unshare-net"), false,
      "credentialed Git needs GitHub network access inside its PID namespace");
    assert.equal(Object.values(command.env).includes(syntheticToken), false,
      "the credential must not enter the Bubblewrap environment");
    assert.equal(command.args.includes(syntheticToken), false,
      "the credential must not enter the Bubblewrap arguments");
  } finally {
    if (previousToken === undefined) delete process.env.GIT_PUSH_TOKEN;
    else process.env.GIT_PUSH_TOKEN = previousToken;
  }
});

test("production Bubblewrap passes fd 3 to the real credential helper", {
  skip: process.platform !== "linux"
    || !fs.existsSync("/usr/bin/bwrap")
    || !fs.existsSync("/usr/local/bin/agenthost-git-credential")
    ? "Linux image credential boundary"
    : false,
  timeout: 10000,
}, async (t) => {
  const transport = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-git-bwrap-fd3-"));
  const token = "synthetic-bwrap-fd3-token";
  const credentialPath = "agenthost/isolation-proof.git";
  const outputPath = path.join(transport, "credential.out");
  t.after(() => { try { fs.rmSync(transport, { recursive: true, force: true }); } catch {} });

  const alias = [
    "!printf 'protocol=https\\nhost=github.com\\npath=" + credentialPath + "\\n\\n'",
    "| /usr/local/bin/agenthost-git-credential get",
    "> /workspace/credential.out",
  ].join(" ");
  const command = buildCredentialedGitCommand(transport, [
    "-c", "alias.credential-probe=" + alias,
    "credential-probe",
  ], credentialPath);
  const result = await gitCommandResult(command, token, { timeoutMs: 3000 });

  assert.equal(result.ok, true, result.error);
  assert.equal(fs.readFileSync(outputPath, "utf8"),
    "username=x-access-token\npassword=" + token + "\n");
});

test("the fd-3 credential helper is installed as a root-owned executable", () => {
  const dockerfile = fs.readFileSync(path.join(repoRoot, "container", "Dockerfile"), "utf8");
  assert.match(dockerfile, /COPY --chown=root:root git-credential-agenthost \/usr\/local\/bin\/agenthost-git-credential/);
  assert.match(dockerfile, /chmod 0555[^\r\n]*\/usr\/local\/bin\/agenthost-git-credential/);
});

test("the production Git timeout uses the real two-minute default and kills a hung child", async () => {
  let scheduledFor = null;
  const result = await gitCommandResult({
    bin: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    cwd: os.tmpdir(),
    env: process.env,
  }, null, {
    scheduleTimeout(callback, timeoutMs) {
      scheduledFor = timeoutMs;
      return setTimeout(callback, 0);
    },
  });
  assert.equal(scheduledFor, 2 * 60 * 1000);
  assert.equal(result.ok, false);
  assert.equal(result.error, "git timed out");
});

test("an unproven credentialed containment kill invokes the fatal path and never settles", {
  skip: process.platform === "win32" ? "POSIX process-group containment" : false,
}, async () => {
  let fatalSignals = 0;
  let settled = false;
  const result = gitCommandResult({
    bin: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    cwd: os.tmpdir(),
    env: process.env,
    terminalContainment: "bwrap-pidns",
  }, "synthetic-fd3-token", {
    scheduleTimeout(callback) { return setTimeout(callback, 0); },
    killContainedChild() {
      const error = new Error("synthetic process-group denial");
      error.code = "EPERM";
      throw error;
    },
    onContainmentFailure() { fatalSignals += 1; },
  });
  result.then(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fatalSignals, 1, "the gate must trigger its fatal containment path");
  assert.equal(settled, false, "no caller may continue while a credential reader is unproven");
});

test("a missing Bubblewrap close triggers the fatal fuse after a bounded proof grace", {
  skip: process.platform === "win32" ? "POSIX containment proof timer" : false,
}, async () => {
  let fatalSignals = 0;
  let proofGraceMs = null;
  let child = null;
  let settled = false;
  const result = gitCommandResult({
    bin: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    cwd: os.tmpdir(),
    env: process.env,
    terminalContainment: "bwrap-pidns",
  }, "synthetic-fd3-token", {
    scheduleTimeout(callback) { return setTimeout(callback, 0); },
    killContainedChild(target) { child = target; return true; },
    scheduleProofTimeout(callback, timeoutMs) {
      proofGraceMs = timeoutMs;
      return setTimeout(callback, 0);
    },
    onContainmentFailure() {
      fatalSignals += 1;
      try { child.kill("SIGKILL"); } catch {}
    },
  });
  result.then(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(proofGraceMs, 2000);
  assert.equal(fatalSignals, 1);
  assert.equal(settled, false, "the restart fuse must fire before any Git caller resumes");
});

test("an unavailable root restart request makes the local gate exit fail-closed", () => {
  const source = fs.readFileSync(path.join(repoRoot, "container", "gate.js"), "utf8");
  const timeoutPath = source.slice(
    source.indexOf("function gitCommandResult"),
    source.indexOf("async function gitJailedCommandResult"),
  );
  assert.match(timeoutPath, /requestRootFatalContainment\(\)/);
  assert.match(timeoutPath, /process\.kill\(process\.pid, "SIGTERM"\)/,
    "a missing root broker must still kill the gate so Bubblewrap parent-death containment fires");
});

// The gate's push credential must come from GIT_PUSH_TOKEN and nowhere else.
// GITHUB_TOKEN is the AGENT's token by design (start.sh exports GH_TOKEN +
// GITHUB_PERSONAL_ACCESS_TOKEN and runs `gh auth setup-git`), and the 🔑 store is
// uid agent / mode 660 -- agent-readable AND agent-rewritable. Either as a source
// means the agent holds the credential the rung claims to withhold.
test("the gate's push credential is a gate-only secret, not the agent's token or the box store", () => {
  const source = fs.readFileSync(path.join(repoRoot, "container", "gate.js"), "utf8");
  const raw = source.slice(source.indexOf("function gitHubToken()"),
    source.indexOf("function gitCommandResult("));
  assert.ok(raw.length > 0 && raw.length < 4000, "located gitHubToken()");
  // Assert on CODE, not prose: the function's comment deliberately NAMES the
  // rejected sources (GITHUB_TOKEN, the 🔑 store, GH_TOKEN) to explain why they
  // must never come back, so a raw text match would flag its own documentation.
  const fn = raw.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  assert.match(fn, /process\.env\.GIT_PUSH_TOKEN/, "reads the gate-only secret");
  assert.doesNotMatch(fn, /process\.env\.GITHUB_TOKEN/,
    "must NOT read the agent's own GitHub token");
  assert.doesNotMatch(fn, /loadBoxSecrets\(\)/,
    "must NOT read the agent-writable box secret store (#174's fallback is removed)");
  assert.doesNotMatch(fn, /GH_TOKEN/, "must NOT accept the GH_TOKEN alias");
  // Printable-ASCII only: a NUL smuggled through a store survives gitHubToken's
  // old [\r\n]-only screen, and the fd-3 helper's `read -r` then drops it and
  // concatenates the halves into a credential nobody stored.
  assert.match(fn, /\[\\x21-\\x7e\]/, "the token must be validated as printable ASCII");

  // The credential must be withheld from engines on every env built here.
  const chat = source.slice(source.indexOf("function chatEnv()"),
    source.indexOf("const CURSOR_CHAT_ENV_ALLOWLIST"));
  assert.match(chat, /delete env\.GIT_PUSH_TOKEN/,
    "chatEnv must strip the push credential before it can reach an engine");
});

test("gate-side non-Git children use a token-free environment allowlist", () => {
  const env = gateChildEnv({
    HOME: "/data/home/agent",
    PATH: "/agent-writable/bin",
    GIT_PUSH_TOKEN: "push-secret",
    GITHUB_TOKEN: "agent-secret",
    GH_TOKEN: "agent-secret",
    GITHUB_PERSONAL_ACCESS_TOKEN: "agent-secret",
    OPENCLAW_GATEWAY_TOKEN: "channel-secret",
    NODE_OPTIONS: "--require evil",
    SAFE_SENTINEL: "must-drop",
  }, {
    HOME: "/override/home",
    HERMES_HOME: "/override/hermes",
    HERMES_KANBAN_HOME: "/override/kanban",
    PATH: "/agent-writable/override",
    PYTHONNOUSERSITE: "0",
    PYTHONSAFEPATH: "0",
    GIT_PUSH_TOKEN: "override-push-secret",
    NODE_OPTIONS: "--require override-evil",
    SAFE_SENTINEL: "override-must-drop",
  });
  assert.equal(env.GIT_PUSH_TOKEN, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.GITHUB_PERSONAL_ACCESS_TOKEN, undefined);
  assert.equal(env.OPENCLAW_GATEWAY_TOKEN, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.SAFE_SENTINEL, undefined);
  assert.equal(env.HOME, "/override/home");
  assert.equal(env.HERMES_HOME, "/override/hermes");
  assert.equal(env.HERMES_KANBAN_HOME, "/override/kanban");
  assert.equal(env.PYTHONNOUSERSITE, "1");
  assert.equal(env.PYTHONSAFEPATH, "1");
  if (process.platform !== "win32") assert.equal(env.PATH, "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
});

test("a Linux gate holding the push credential becomes non-dumpable before startup", () => {
  const calls = [];
  const guarded = hardenGateProcess("linux", (file) => {
    calls.push(file);
    return { setSelfNonDumpable: () => true };
  }, "push-secret");
  assert.equal(guarded, true);
  assert.deepEqual(calls, ["/opt/agenthost/maintenance-native.node"]);

  assert.equal(hardenGateProcess("win32", () => { throw new Error("must not load"); }, "push-secret"), false);
  assert.equal(hardenGateProcess("linux", () => { throw new Error("must not load"); }, ""), false);

  const failure = new Error("native guard unavailable");
  assert.throws(() => hardenGateProcess("linux", () => { throw failure; }, "push-secret"), failure);
  assert.throws(
    () => hardenGateProcess("linux", () => ({ setSelfNonDumpable: () => false }), "push-secret"),
    /could not make the gate non-dumpable/,
  );

  const source = fs.readFileSync(path.join(repoRoot, "container", "gate.js"), "utf8");
  const libModeReturnAt = source.indexOf("if (require.main !== module)");
  const hardenAt = source.indexOf("hardenGateProcess();", libModeReturnAt);
  const keyAt = source.indexOf("const KEY = process.env.TTYD_PASSWORD");
  assert.ok(libModeReturnAt > -1 && hardenAt > libModeReturnAt && hardenAt < keyAt,
    "the real gate must harden itself after library mode returns and before startup");
});

test("isolated gate-side Python cannot import an agent-owned shadow module", {
  skip: process.platform !== "linux" || spawnSync("python3", ["--version"], { stdio: "ignore" }).status !== 0,
}, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-python-shadow-"));
  const marker = path.join(home, "imported.txt");
  const module = [
    "from pathlib import Path",
    `Path(${JSON.stringify(marker)}).write_text("agent code ran", encoding="utf8")`,
  ].join("\n");
  const moduleName = "agenthost_shadow_probe";
  fs.writeFileSync(path.join(home, `${moduleName}.py`), module);
  fs.mkdirSync(path.join(home, ".local", "lib", "python3.11", "site-packages"), { recursive: true });
  fs.writeFileSync(path.join(home, ".local", "lib", "python3.11", "site-packages", `${moduleName}.py`), module);
  try {
    const run = spawnSync("python3", ["-I", "-c", `import ${moduleName}; print("UNSAFE")`], {
      cwd: home,
      env: gateChildEnv({ HOME: home, PYTHONPATH: home, PYTHONUSERBASE: home, GIT_PUSH_TOKEN: "synthetic" }),
      encoding: "utf8",
    });
    assert.notEqual(run.status, 0, "the agent-owned module must not import");
    assert.equal(fs.existsSync(marker), false, "agent-owned Python code must never execute");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the gate board CLI is installed root-side, never from the agent home", () => {
  const source = fs.readFileSync(path.join(repoRoot, "container", "gate.js"), "utf8");
  const dockerfile = fs.readFileSync(path.join(repoRoot, "container", "Dockerfile"), "utf8");
  const entrypoint = fs.readFileSync(path.join(repoRoot, "container", "entrypoint.sh"), "utf8");
  const wrapper = fs.readFileSync(path.join(repoRoot, "container", "hermes-gate-wrapper.sh"), "utf8");
  const start = fs.readFileSync(path.join(repoRoot, "container", "start.sh"), "utf8");
  assert.match(source, /const HERMES_BIN = process\.platform === "win32"[\s\S]*?"\/usr\/local\/bin\/hermes"/);
  assert.match(source, /env: hermesKanbanEnv\(\)/);
  assert.match(source, /spawn\("python3", \["-I", "-c", py/);
  assert.match(dockerfile, /hermes-agent==0\.19\.0/);
  assert.match(start, /uv" tool install --force hermes-agent==0\.19\.0/,
    "existing and fresh volumes must converge on the root-side Hermes version");
  assert.match(start, /\.hermes-tools-0\.19\.0/,
    "an existing volume must run the pinned-version upgrade once");
  assert.doesNotMatch(start, /\.hermes-tools(?!-0\.19\.0)/,
    "Hermes readiness must use the same pinned-version marker as installation");
  assert.match(dockerfile, /COPY hermes-gate-wrapper\.sh \/usr\/local\/bin\/hermes/);
  const env = hermesKanbanEnv({
    HOME: "/data/home/agent",
    GIT_PUSH_TOKEN: "must-not-reach-hermes",
    BWS_ACCESS_TOKEN: "must-not-reach-hermes",
  });
  assert.equal(env.HOME, "/run/agenthost-gate-hermes");
  assert.equal(env.HERMES_HOME, "/run/agenthost-gate-hermes");
  assert.equal(env.HERMES_KANBAN_HOME, "/data/home/agent/.hermes");
  assert.equal(env.GIT_PUSH_TOKEN, undefined);
  assert.equal(env.BWS_ACCESS_TOKEN, undefined);
  assert.match(entrypoint, /install -d -o gate -g gate -m 0700 \/run\/agenthost-gate-hermes/,
    "root boot must create the Foundation-B Hermes runtime home for gate only");
  const importAt = wrapper.indexOf("from hermes_cli.main import main");
  const firstForcedLocalAt = wrapper.indexOf('os.environ["HERMES_DEV"]="1"');
  const forcedLocalAt = wrapper.lastIndexOf('os.environ["HERMES_DEV"]="1"');
  const mainAt = wrapper.indexOf("raise SystemExit(main())");
  assert.ok(firstForcedLocalAt >= 0 && firstForcedLocalAt < importAt
    && importAt < forcedLocalAt && forcedLocalAt < mainAt,
  "the root shim must force local mode both before and after agent-owned dotenv loading");
  assert.match(wrapper, /python3 -I -c/,
    "the root shim must retain isolated Python startup");
});

// The isolation is only real when a different uid holds the token. Without the
// Foundation B split, gate.js is the tail exec of start.sh at the AGENT uid, so
// root drops the secret outright rather than let a rung claim an isolation the
// box does not have.
test("without the gate/agent uid split the push credential is dropped, not quietly shared", () => {
  const entrypoint = fs.readFileSync(path.join(repoRoot, "container", "entrypoint.sh"), "utf8");
  const unsetAt = entrypoint.indexOf("unset GIT_PUSH_TOKEN");
  const dropAt = entrypoint.indexOf("exec setpriv --reuid=agent");
  assert.ok(unsetAt > -1, "the non-split path must unset the push credential");
  assert.ok(unsetAt < dropAt,
    "it must be unset BEFORE dropping to the agent, or the agent inherits it");
  // GITHUB_TOKEN is deliberately untouched -- the agent needs it for gh/MCP/clone.
  assert.doesNotMatch(entrypoint, /unset GITHUB_TOKEN/);
});

test("rungs 2-4 have one server-owned proposal path, not a text or boolean bypass", () => {
  const source = fs.readFileSync(path.join(repoRoot, "container", "gate.js"), "utf8");
  assert.match(source, /async pushBranch\(task\)/);
  assert.match(source, /async openPR\(task\)/);
  assert.match(source, /async mergePR\(task\)/);
  assert.match(source, /function gitProposalGateReason\(task, settings\)/);
  assert.match(source, /const GIT_CREDENTIAL_HELPER = "\/usr\/local\/bin\/agenthost-git-credential"/);
  assert.match(source, /function createGitReviewApproval/);
  assert.match(source, /gitReviewApprovalMatches\(approval, expected, loadGateSecret\(\)\)/);
  assert.match(source, /\["push", "--porcelain", "--no-verify", plan\.remoteUrl/);
  assert.match(source, /"\/pulls\/" \+ change\.pr\.number \+ "\/merge"/);
  assert.match(source, /if \(!gitMergeResponseNeedsReconciliation\(response\.status\)\) \{[\s\S]*?reconcilePendingGitMerge\(change\)/);
  assert.match(source, /merge outcome is unknown; preserving reconciliation intent/);
  assert.doesNotMatch(source, /not yet wired/);
  assert.doesNotMatch(source.slice(source.indexOf("const gitLadder ="), source.indexOf("// Shared page chrome")), /reviewPassed/);
});

// --ignore-user-config means the operator's ~/.codex/config.toml never reaches
// an autonomous run, so the model has to be named in argv or the run silently
// falls back to the account default. Live 2026-08-14: the general weekly quota
// hit 0% while GPT-5.3-Codex-Spark sat at 96% and config.toml already said
// spark -- chat runs read that file and kept working while every board run died
// on an exhausted quota. That reads as "codex is broken", not "codex is on the
// wrong model", which is why this is pinned rather than left to config.
test("autonomous Codex names its model in argv, because it ignores user config", () => {
  const args = codexAutonomousArgs("build something", "", "/workspace", true);
  assert.ok(args.includes("--ignore-user-config"),
    "if this flag ever goes away, the model pin below is no longer load-bearing -- re-check before deleting it");
  const model = args[args.indexOf("--model") + 1];
  assert.equal(args.includes("--model"), true, "no --model in autonomous argv: the run inherits the account default");
  assert.ok(model && !model.startsWith("-"), `--model has no value: ${model}`);
});

test("the autonomous Codex model is env-overridable without a deploy", () => {
  // The general quota resets Aug 20; switching back must not need a code change.
  const previous = process.env.CODEX_MODEL;
  try {
    process.env.CODEX_MODEL = "gpt-5.3-codex";
    const overridden = codexAutonomousArgs("x", "", "/scratch", false);
    assert.equal(overridden[overridden.indexOf("--model") + 1], "gpt-5.3-codex");
    delete process.env.CODEX_MODEL;
    const fallback = codexAutonomousArgs("x", "", "/scratch", false);
    assert.equal(fallback[fallback.indexOf("--model") + 1], "gpt-5.3-codex-spark",
      "the default must be the model with quota left, not the exhausted one");
  } finally {
    if (previous === undefined) delete process.env.CODEX_MODEL;
    else process.env.CODEX_MODEL = previous;
  }
});
