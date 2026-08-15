// Every shell script in the repo must at least PARSE.
//
// Why this exists (2026-08-08): PR #263 added a stale-tree guard to
// scripts/deploy-box.sh that referenced $FORCE_DEPLOY. The script runs under
// `set -euo pipefail`, so an unset variable is fatal — and FORCE_DEPLOY is
// unset on every ordinary deploy, because the override is the exception, not
// the rule. The guard aborted before reaching its own logic:
//
//   scripts/deploy-box.sh: line 43: FORCE_DEPLOY: unbound variable
//
// A change written to stop one bad deploy stopped ALL of them. It shipped with
// CI green, because nothing in this suite executed shell — `node --test` covers
// JavaScript, and the regressions gate runs that same suite. "CI green" said
// nothing whatsoever about the deploy path.
//
// WHAT THIS CATCHES, AND WHAT IT DOES NOT.
// `bash -n` is a parse check. It would NOT have caught the #263 bug on its own,
// because `$FORCE_DEPLOY` is syntactically valid — the failure is a runtime
// `set -u` violation. So this test also runs shellcheck when it is available,
// which flags exactly that class (SC2154: referenced but not assigned), and
// separately asserts that scripts using `set -u` do not read bare `$VAR` for
// the small set of known-optional environment overrides.
//
// Stated plainly so nobody mistakes a green run here for "the deploy works":
// this is a cheap net under the shell surface, not a substitute for running it.
// The only thing that proves deploy-box.sh works is deploying.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");

function shellScripts() {
  const out = [];
  for (const dir of ["scripts", "container"]) {
    const abs = path.join(repoRoot, dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs)) {
      if (name.endsWith(".sh")) out.push(path.join(dir, name));
    }
  }
  return out.sort();
}

const scripts = shellScripts();

test("the repo actually has shell scripts to check", () => {
  assert.ok(scripts.length > 0, "no .sh files found — this test would be silently vacuous");
});

test("every shell script parses (bash -n)", () => {
  const broken = [];
  for (const rel of scripts) {
    const r = spawnSync("bash", ["-n", path.join(repoRoot, rel)], { encoding: "utf8" });
    if (r.error) {
      // No bash on this host. Skipping silently would make a green run a lie.
      assert.fail("bash is unavailable, so shell syntax is UNCHECKED on this host: " + r.error.message);
    }
    if (r.status !== 0) broken.push(rel + ": " + String(r.stderr || "").trim().split("\n")[0]);
  }
  assert.deepEqual(broken, [], "shell scripts failed to parse:\n" + broken.join("\n"));
});

test("a script running under `set -u` never reads a bare optional env override", () => {
  // The #263 bug, generalized. Under `set -u` a bare $VAR for a variable that is
  // legitimately unset most of the time is a fatal error, not a falsy read.
  // These are the overrides that are unset in the NORMAL case, so a bare read is
  // a live landmine rather than a style nit.
  const OPTIONAL = ["FORCE_DEPLOY", "SKIP_BUILD", "DRY_RUN", "VERBOSE", "DEBUG"];
  const offenders = [];
  for (const rel of scripts) {
    const src = fs.readFileSync(path.join(repoRoot, rel), "utf8");
    if (!/^\s*set\s+-[a-z]*u/m.test(src)) continue; // no set -u: a bare read is merely empty
    for (const name of OPTIONAL) {
      // A script that ASSIGNS the variable itself (e.g. `DRY_RUN=0` before flag
      // parsing) is safe under set -u no matter how it reads it afterwards.
      // That is the precise difference from the #263 bug: FORCE_DEPLOY was never
      // assigned anywhere in deploy-box.sh — it came only from the environment,
      // so on an ordinary run the name had never been bound at all.
      if (new RegExp("^\\s*" + name + "=", "m").test(src)) continue;
      // "$VAR" or $VAR, but NOT ${VAR:-...} / ${VAR-...} / ${VAR:=...}
      const bare = new RegExp("\\$" + name + "\\b", "g");
      const guarded = new RegExp("\\$\\{" + name + "\\s*:?[-=+?]", "g");
      const bareCount = (src.match(bare) || []).length;
      const guardedCount = (src.match(guarded) || []).length;
      if (bareCount > guardedCount) {
        offenders.push(rel + ": $" + name + " is never assigned in this script and is read without a ${" + name + ":-} default under set -u");
      }
    }
  }
  assert.deepEqual(offenders, [], "unbound-variable landmines under set -u:\n" + offenders.join("\n"));
});

test("shellcheck, when present, finds no error-level problems", (t) => {
  // Advisory: shellcheck is not installed in CI today. When it IS available it
  // catches SC2154 (referenced but not assigned), which is the #263 class.
  // Skipping is announced, never silent — a skip that looks like a pass is the
  // exact failure this file exists to stop.
  let available = true;
  try { execFileSync("shellcheck", ["--version"], { stdio: "ignore" }); } catch { available = false; }
  if (!available) return t.skip("shellcheck not installed — error-level shell linting is NOT running here");

  const offenders = [];
  for (const rel of scripts) {
    const r = spawnSync("shellcheck", ["--severity=error", "--format=gcc", path.join(repoRoot, rel)], { encoding: "utf8" });
    if (r.status !== 0 && String(r.stdout || "").trim()) offenders.push(String(r.stdout).trim());
  }
  assert.deepEqual(offenders, [], "shellcheck error-level findings:\n" + offenders.join("\n"));
});
