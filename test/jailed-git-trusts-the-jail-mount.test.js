// Git refuses to operate on a repository owned by another user, and inside the
// jail that is every repository: the engine's worktree is bind-mounted at
// /workspace and its owner does not match the uid running git.
//
// Live 2026-08-10 — this is why auto-commit failed on every approved task from
// the moment it was switched on. The audit line, once it could carry the
// sandbox's own words, said:
//
//   codex FAILED hardened commit agenthost-internal:
//     git config --global --add safe.directory /workspace
//
// which is git printing its own remedy as the last line of the error.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const gate = require("../container/gate.js");

test("the jailed git command trusts the jail's mount point", () => {
  const args = gate.gitHardenedConfigArgs();
  const i = args.indexOf("safe.directory=/workspace");
  assert.ok(i > 0, "without this git aborts on dubious ownership and never reaches the commit");
  assert.equal(args[i - 1], "-c", "it must be passed as a config flag, not a bare argument");
});

test("it trusts ONLY the jail mount, never everything", () => {
  const args = gate.gitHardenedConfigArgs();
  for (const a of args) {
    assert.notEqual(a, "safe.directory=*",
      "a wildcard would tell git to trust every repository it is ever pointed at, including one an untrusted mount could introduce");
  }
  assert.equal(args.filter((a) => String(a).startsWith("safe.directory=")).length, 1,
    "exactly one trusted path -- the one the jail actually mounts");
});

test("the existing hardening is still present", () => {
  // The new entry must not have displaced any of it: these are the settings
  // that stop a hostile repo executing code through git.
  const args = gate.gitHardenedConfigArgs().join(" ");
  for (const must of ["core.hooksPath=/dev/null", "credential.helper=", "core.sshCommand="]) {
    assert.ok(args.includes(must), "still hardened: " + must);
  }
});
