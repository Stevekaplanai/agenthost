// A command is not an error message.
//
// This logged `e.message` clipped to 100 characters. For a bwrap-jailed git the
// message BEGINS with the full command line, so the whole budget was spent on
// flags and the audit line read:
//
//   FAILED hardened commit agenthost-internal: Command failed:
//   /usr/bin/bwrap --unshare-net --die-with-parent --new-session --clearen
//
// Auto-commit was switched on 2026-08-10, this path ran for the first time,
// failed on every approved task, and left exactly that as the only artefact —
// a command with no cause. Third instance of this shape found today.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const src = fs.readFileSync(
  path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");
// NO POSITIONAL WINDOW. Two earlier versions of this test sliced a fixed
// number of characters around a phrase that appears in BOTH the explanatory
// comment and the code, so the window landed in a different place depending on
// what else was in the file -- green locally, red in CI, for a reason that had
// nothing to do with what it was checking. A source assertion has to be
// anchored on strings that occur exactly once.
const STDERR_READ = 'const errText = String((e && e.stderr) || "").trim();';
const AUDIT_CALL = 'audit("git_rung1_commit", engine + " FAILED hardened commit "';

test("the sandbox's stderr is read before the audit line is built", () => {
  assert.ok(src.includes(STDERR_READ),
    "the child's own words are the diagnosis; e.message here begins with the command that invoked it");
  assert.ok(src.indexOf(STDERR_READ) < src.indexOf(AUDIT_CALL),
    "stderr must be read BEFORE the line is assembled, or the line cannot carry it");
});

test("it falls back to the message rather than logging nothing", () => {
  assert.ok(src.includes('String((e && e.message) || e).slice(0, 200)'),
    "a failure with no stderr must still say something; silence is the defect being fixed");
});

test("the detail is bounded", () => {
  assert.ok(src.includes("said.slice(0, 200)"),
    "enough to name a cause, small enough that it cannot leak a token or flood the log");
});
