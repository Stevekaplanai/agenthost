// The autonomous author's ONE gate-supplied string is the worktree path, so it is
// the whole new authority surface this feature adds. This test drives the REAL
// validator through the REAL runner against a REAL symlink on disk -- no source
// grepping, no mocked fs. A test that reads the code instead of running it is how
// a green suite described a classifier that had never once worked (2026-08-09).
//
// The hole it locks shut: statSync FOLLOWS symlinks, so `<workspaces>/evil` -> `/`
// is a directory whose prefix check passes cleanly. bwrap would then mount the
// TARGET read-write as /workspace, handing an author write access to everything
// the agent uid can reach.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createChatRunner } = require("../container/maintenance-chat-runner.js");

// Minimal arbiter: the validator must reject BEFORE the lane is ever taken.
function stubArbiter(taken) {
  return {
    acquire: (id) => { taken.push(id); return true; },
    release: () => {},
    trip: () => {},
    isBusy: () => false,
    isQuarantined: () => false,
  };
}

// A REAL git repo on the engine's work branch. Root now validates the
// <engine>/<repo> shape AND the branch, so a fixture that skipped git would be
// exercising a validator the box does not actually run.
function setupHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ah-wt-"));
  const good = path.join(home, "workspaces", "codex", "repo");
  fs.mkdirSync(good, { recursive: true });
  fs.mkdirSync(path.join(home, "OUTSIDE"));
  execFileSync("git", ["init", "-q", good], { stdio: "ignore" });
  const git = (args) => execFileSync("git", ["-C", good, ...args], { stdio: "ignore" });
  git(["config", "user.email", "t@t"]);
  git(["config", "user.name", "t"]);
  fs.writeFileSync(path.join(good, "f.txt"), "x");
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);
  git(["checkout", "-qb", "codex/work"]);
  return home;
}

// A launch that fails the test if it is ever reached: a rejected worktree must
// never reach a spawn, or the "refusal" is cosmetic.
function forbiddenLaunch() {
  throw new Error("a rejected worktree reached the launcher");
}

function runWith(home, worktree) {
  const exits = [];
  const taken = [];
  const runner = createChatRunner({
    profiles: { codex: { bin: "/usr/local/bin/codex", argvTemplate: [] } },
    agentLaneArbiter: stubArbiter(taken),
    launchContained: forbiddenLaunch,
    agentHome: home.split(path.sep).join("/"),
    onExit: (runId, info) => exits.push(info),
  });
  const admission = runner.runAutonomous({
    runId: "run_symlink_test",
    engineId: "codex",
    prompt: "ping",
    worktree,
    onExit: (runId, info) => exits.push(info),
  });
  return { admission, exits, taken };
}

test("a worktree symlinked outside the workspaces root is refused, by name", () => {
  const home = setupHome();
  const posixHome = home.split(path.sep).join("/");
  try {
    fs.symlinkSync(path.join(home, "OUTSIDE"), path.join(home, "workspaces", "codex", "evil"), "junction");
  } catch (e) {
    // Unprivileged Windows cannot always create links. Skipping silently would
    // make this test look like it passed, so say which it was. (Rule 16.)
    console.log("SKIP - symlink unavailable in this environment: " + e.code);
    return;
  }

  const { admission, exits, taken } = runWith(home, posixHome + "/workspaces/codex/evil");

  assert.equal(admission.accepted, false, "the symlinked worktree must not be admitted");
  assert.equal(exits.length, 1, "the refusal must be reported, not swallowed");
  assert.equal(exits[0].error, "autonomous_worktree_rejected");
  assert.equal(taken.length, 0, "a rejected worktree must not take the agent lane");
});

test("a real directory under the workspaces root is still accepted (no over-rejection)", () => {
  const home = setupHome();
  const posixHome = home.split(path.sep).join("/");
  const { exits } = runWith(home, posixHome + "/workspaces/codex/repo");

  // The launcher throws by design, so this proves the validator PASSED the path
  // through to composition -- the opposite of the refusal above. What matters is
  // that it was not rejected as a worktree.
  const rejected = exits.some((e) => e.error === "autonomous_worktree_rejected");
  assert.equal(rejected, false, "a legitimate worktree must not be rejected");
});

// One engine must not be handed another engine's private workspace. Every check
// above passes for claude's worktree during a codex run -- it is inside the
// allowed tree, real, and not a symlink -- so without the <engine> segment check
// codex could author inside claude's workspace.
test("a codex run is refused another engine's worktree", () => {
  const home = setupHome();
  const posixHome = home.split(path.sep).join("/");
  fs.mkdirSync(path.join(home, "workspaces", "claude", "repo"), { recursive: true });

  const { admission, exits, taken } = runWith(home, posixHome + "/workspaces/claude/repo");

  assert.equal(admission.accepted, false, "codex must not be granted claude's workspace");
  assert.equal(exits[0].error, "autonomous_worktree_rejected");
  assert.equal(taken.length, 0);
});

// The control that could not be enforced gate-side, now enforced where it can
// be. An author may write only on its own work branch, never on whatever
// happened to be checked out.
test("a worktree on the wrong branch is refused", () => {
  const home = setupHome();
  const posixHome = home.split(path.sep).join("/");
  const good = path.join(home, "workspaces", "codex", "repo");
  execFileSync("git", ["-C", good, "checkout", "-qb", "some-other-branch"], { stdio: "ignore" });

  const { admission, exits } = runWith(home, posixHome + "/workspaces/codex/repo");

  assert.equal(admission.accepted, false, "only <engine>/work may be authored on");
  assert.equal(exits[0].error, "autonomous_worktree_rejected");
});

// A security check conditional on its own input being present is not a check.
// These were `if (engineId && ...)`, which failed OPEN: a caller that omitted
// the engine skipped BOTH the ownership and the branch check and could be handed
// any valid two-segment worktree, including another engine's.
test("a missing engine id is refused, not waved through", () => {
  const home = setupHome();
  const posixHome = home.split(path.sep).join("/");
  const runner = createChatRunner({
    profiles: { codex: { bin: "/usr/local/bin/codex", argvTemplate: [] } },
    agentLaneArbiter: stubArbiter([]),
    launchContained: forbiddenLaunch,
    agentHome: posixHome,
    onExit: () => {},
  });
  for (const bad of ["", null, undefined, 0]) {
    const exits = [];
    const admission = runner.runAutonomous({
      runId: "run_no_engine_" + String(bad),
      engineId: bad,
      prompt: "ping",
      worktree: posixHome + "/workspaces/codex/repo",
      onExit: (_id, info) => exits.push(info),
    });
    assert.equal(admission.accepted, false, "a run with no engine id must never be admitted");
    assert.ok(exits.length >= 1, "and the refusal must be reported");
  }
});

// The charter must ride the AUTHOR run, not just chat. Dropping it made codex
// run with the task and none of the standing orders -- including the handoff
// contract that says what a result must contain.
//
// Observed live on card t_a823daf8: codex did the work correctly and reported a
// plain summary; gemini rejected it for "missing the raw artifact ... as
// required by the handoff contract" -- a contract codex was never shown. The
// engine was blamed for an instruction the transport dropped.
test("the autonomous author run is given the charter", () => {
  if (process.platform === "win32") {
    // Bubblewrap cannot compose a Linux bind from a Windows drive path, so the
    // real jail deliberately collapses to /usr/bin/false on this platform.
    // Keep the behavioral proof on Linux and bound the Windows assertion to the
    // exact author-composition block instead of accepting a false RED.
    const runnerSource = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "maintenance-chat-runner.js"), "utf8");
    const start = runnerSource.indexOf("const chartered = withCharter");
    const end = runnerSource.indexOf("const jail = buildBwrapReadJail", start);
    const authorComposition = runnerSource.slice(start, end);
    assert.ok(start !== -1 && end > start, "the Codex author composition block must remain reachable");
    assert.match(authorComposition, /withCharter\(String\(prompt/);
    assert.match(authorComposition, /autonomousCodexArgv\(chartered\)/);
    return;
  }
  const home = setupHome();
  const posixHome = home.split(path.sep).join("/");
  let launchedArgv = null;
  const runner = createChatRunner({
    profiles: { codex: { bin: "/usr/local/bin/codex", argvTemplate: [] } },
    agentLaneArbiter: stubArbiter([]),
    withCharter: (p) => "<<<CHARTER>>>\n" + p,
    launchContained: (...args) => {
      launchedArgv = JSON.stringify(args);
      throw new Error("stop after argv composition");
    },
    agentHome: posixHome,
    onExit: () => {},
  });
  try {
    runner.runAutonomous({
      runId: "run_charter",
      engineId: "codex",
      prompt: "do the thing",
      worktree: posixHome + "/workspaces/codex/repo",
      onExit: () => {},
    });
  } catch { /* the launcher throws by design */ }

  assert.ok(launchedArgv, "the run must reach argv composition to be checked");
  assert.match(launchedArgv, /<<<CHARTER>>>/,
    "the standing orders must reach the author, or it is judged against a contract it never saw");
  assert.match(launchedArgv, /do the thing/, "and the task itself must survive alongside them");
});

// A STRUCTURED GIT PROPOSAL uses a per-task branch, not the standing work
// branch, and requiring "/work" rejected every one of them. Live on the box:
//
//   agenthost-ladder-proof--task-t_43bbaa58 -> codex/task-t_43bbaa58
//   agenthost-ladder-proof                  -> codex/work
//
// The refusal surfaced as "the reviewer wrote nothing to stdout and nothing to
// stderr" -- three layers from its cause -- and went unnoticed because the
// proposal path had never executed before. It is the path the governed-write
// proof runs on.
test("a structured proposal's task branch is accepted", () => {
  const home = setupHome();
  const posixHome = home.split(path.sep).join("/");
  const wt = path.join(home, "workspaces", "codex", "repo--task-t_43bbaa58");
  fs.mkdirSync(wt, { recursive: true });
  execFileSync("git", ["init", "-q", wt], { stdio: "ignore" });
  const git = (a) => execFileSync("git", ["-C", wt, ...a], { stdio: "ignore" });
  git(["config", "user.email", "t@t"]); git(["config", "user.name", "t"]);
  fs.writeFileSync(path.join(wt, "f.txt"), "x");
  git(["add", "-A"]); git(["commit", "-qm", "init"]);
  git(["checkout", "-qb", "codex/task-t_43bbaa58"]);

  const { exits } = runWith(home, posixHome + "/workspaces/codex/repo--task-t_43bbaa58");
  const rejected = exits.some((e) => e.error === "autonomous_worktree_rejected");
  assert.equal(rejected, false, "a proposal task branch must be accepted or the governed-write proof can never run");
});

test("a foreign task branch is still refused", () => {
  // The pattern is derived by root from the engine id. Another engine's task
  // branch must not pass, or the control is decorative.
  const home = setupHome();
  const posixHome = home.split(path.sep).join("/");
  const wt = path.join(home, "workspaces", "codex", "repo--task-x");
  fs.mkdirSync(wt, { recursive: true });
  execFileSync("git", ["init", "-q", wt], { stdio: "ignore" });
  const git = (a) => execFileSync("git", ["-C", wt, ...a], { stdio: "ignore" });
  git(["config", "user.email", "t@t"]); git(["config", "user.name", "t"]);
  fs.writeFileSync(path.join(wt, "f.txt"), "x");
  git(["add", "-A"]); git(["commit", "-qm", "init"]);
  git(["checkout", "-qb", "claude/task-t_43bbaa58"]);

  const { admission } = runWith(home, posixHome + "/workspaces/codex/repo--task-x");
  assert.equal(admission.accepted, false, "codex must not run on claude's task branch");
});
