// The autonomous author needs a writable worktree, and the code that finds one
// took the FIRST directory in ~/work and gave up if this engine had no worktree
// for that particular repo -- even when a perfectly good worktree existed for
// another one.
//
// Measured on the live box, 2026-08-10, which is why this test exists with these
// exact names:
//
//   repos[0]                                    = agent-monitor-pwa
//   workspaces/codex/agent-monitor-pwa          = does NOT exist
//   workspaces/codex/agenthost-internal         = exists
//   workspaces/codex/agenthost-ladder-proof     = exists
//
// So every ordinary codex card degraded to read-only in silence, and the
// author path wired the day before could never be reached. An unreachable
// feature for a second, entirely different reason than the first time.
import test from "node:test";
import assert from "node:assert/strict";
import gate from "../container/gate.js";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const { firstRepoWithWorktree } = gate;

// The live box, exactly as measured.
const REPOS = ["agent-monitor-pwa", "agenthost-internal", "agenthost-ladder-proof"];
const CODEX_HAS = new Set(["agenthost-internal", "agenthost-ladder-proof"]);

test("skips a first repo the engine has no worktree for, and finds one it does", () => {
  assert.equal(
    firstRepoWithWorktree(REPOS, (r) => CODEX_HAS.has(r)),
    "agenthost-internal",
    "the old code returned null here and the run silently went read-only");
});

test("returns null when the engine owns no worktree at all", () => {
  // Still the correct answer -- but it must be reached because nothing was
  // found, not because the first candidate happened to miss.
  assert.equal(firstRepoWithWorktree(REPOS, () => false), null);
});

test("the choice is deterministic and order-preserving", () => {
  // A selection that moved between ticks would make "which repo did it write
  // to" unanswerable after the fact.
  const pick = () => firstRepoWithWorktree(REPOS, (r) => CODEX_HAS.has(r));
  assert.equal(pick(), pick());
  assert.equal(
    firstRepoWithWorktree([...REPOS].reverse(), (r) => CODEX_HAS.has(r)),
    "agenthost-ladder-proof",
    "it follows the order it is given rather than imposing one");
});

test("a probe that throws counts as no, and never takes the board tick down", () => {
  // existsSync on a broken mount can throw. Losing the whole tick to that would
  // stop every task, not just this one.
  assert.equal(firstRepoWithWorktree(REPOS, () => { throw new Error("EIO"); }), null);
  let calls = 0;
  const flaky = (r) => { calls += 1; if (r === "agent-monitor-pwa") throw new Error("EIO"); return CODEX_HAS.has(r); };
  assert.equal(firstRepoWithWorktree(REPOS, flaky), "agenthost-internal",
    "one unreadable repo must not hide the good worktree behind it");
  assert.equal(calls, 2);
});

test("empty and missing inputs are answered, not thrown", () => {
  assert.equal(firstRepoWithWorktree([], () => true), null);
  assert.equal(firstRepoWithWorktree(undefined, () => true), null);
});

test("a truthy-but-not-true probe result does not count as a worktree", () => {
  // Strict === true, because a probe returning a path string or a stat object
  // would otherwise select a repo nobody confirmed exists.
  assert.equal(firstRepoWithWorktree(REPOS, () => "/some/path"), null);
  assert.equal(firstRepoWithWorktree(REPOS, () => 1), null);
});

// The determinism I claimed was not actually there, and Codex caught it on
// review: the helper preserves the order it is GIVEN, but the caller was giving
// it readdirSync order, which Node promises nothing about. On ext4 that is hash
// order -- it differs between boxes and shifts as the directory changes.
//
// So with an engine owning two worktrees, the repo it wrote to could change
// between ticks with nothing in the code appearing to change. The caller now
// sorts before selecting.
test("the caller sorts, so the same set of repos always yields the same pick", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(
    path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");

  const block = src.slice(src.indexOf("PICK A REPO THIS ENGINE ACTUALLY HAS A WORKTREE FOR") - 1400);
  assert.match(block.slice(0, 1400), /\.map\(\(d\) => d\.name\)\.sort\(\)/,
    "readdirSync order is not guaranteed; without an explicit sort the chosen repo can change between ticks and the write becomes untraceable");

  // And the property itself, exercised rather than grepped: whatever order the
  // filesystem hands back, sorting first collapses it to one answer.
  const owned = new Set(["agenthost-internal", "agenthost-ladder-proof"]);
  const shuffles = [
    ["agenthost-ladder-proof", "agent-monitor-pwa", "agenthost-internal"],
    ["agenthost-internal", "agenthost-ladder-proof", "agent-monitor-pwa"],
    ["agent-monitor-pwa", "agenthost-internal", "agenthost-ladder-proof"],
  ];
  const picks = shuffles.map((order) =>
    firstRepoWithWorktree([...order].sort(), (r) => owned.has(r)));
  assert.deepEqual(picks, ["agenthost-internal", "agenthost-internal", "agenthost-internal"],
    "every filesystem ordering must collapse to the same choice once sorted");
});
