// A commit must be recorded against the repo it was actually written in.
//
// The post-run commit passed repos[0] as the repo NAME beside writableWorktree
// as the PATH. Those agreed only by accident: the worktree selection also used
// to take repos[0]. Once that selection learned to skip a repo the engine has no
// worktree for, the two could name different repositories.
//
// On the live box layout that is not hypothetical:
//
//   repos sorted   -> ["agent-monitor-pwa", "agenthost-internal", "agenthost-ladder-proof"]
//   repos[0]       -> agent-monitor-pwa          (codex has NO worktree here)
//   worktree used  -> .../workspaces/codex/agenthost-internal
//
// so the commit would have been recorded against a repo the engine never
// touched. Nothing had committed yet when this was found, which is luck rather
// than design -- the write path had been blocked by a separate defect.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";

const WORKTREE = "/data/home/agent/workspaces/codex/agenthost-internal";
const REPOS_SORTED = ["agent-monitor-pwa", "agenthost-internal", "agenthost-ladder-proof"];

test("the old repos[0] source disagrees with the worktree on the real box layout", () => {
  assert.notEqual(REPOS_SORTED[0], path.basename(WORKTREE),
    "if these ever agree the regression becomes invisible -- this test is the record that they do not");
});

test("the repo name derived from the worktree is the repo actually written in", () => {
  assert.equal(path.basename(WORKTREE), "agenthost-internal");
});

test("a worktree path always yields its repo name, for every engine", () => {
  // <home>/workspaces/<engine>/<repo> is the shape engineWorktreePath builds, so
  // the basename IS the repo name by construction -- which is what makes the two
  // arguments incapable of disagreeing.
  for (const engine of ["codex", "claude", "gemini", "kimi", "hermes"]) {
    for (const repo of REPOS_SORTED) {
      const wt = ["/data/home/agent", "workspaces", engine, repo].join("/");
      assert.equal(path.basename(wt), repo);
    }
  }
});

test("the commit call derives its repo name from the worktree, not from a listing", () => {
  // A presence detector, and labelled as one: it catches a revert to the
  // mismatched form, which is a thing a grep can honestly detect. It does not
  // claim to prove the commit works.
  const src = fs.readFileSync(
    path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");

  assert.doesNotMatch(src, /commitLocal\(assignee,\s*repos\[0\]/,
    "the repo name must never come from a directory listing again; it disagreed with the worktree on the live box");
  assert.match(src, /const repoName = path\.basename\(String\(writableWorktree \|\| ""\)\)/,
    "derive the name from the worktree that was actually written in");
  assert.match(src, /commitLocal\(assignee,\s*repoName,\s*writableWorktree\)/,
    "and pass that derived name, so the two arguments cannot name different repositories");
});
