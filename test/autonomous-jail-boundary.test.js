import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const gatePath = path.join(import.meta.dirname, "..", "container", "gate.js");
const source = fs.readFileSync(gatePath, "utf8");
const { autonomousProfileIsJailed } = require("../container/gate.js");

test("unattended model profiles must have locked args, scrubbed env, and a private jail", () => {
  const locked = { autoArgs() {}, autoEnv() {}, autoJail: true };
  const bwrap = { autoArgs() {}, autoEnv() {}, autoBwrapJail: true };
  assert.equal(autonomousProfileIsJailed(locked), true);
  assert.equal(autonomousProfileIsJailed(bwrap), true);
  assert.equal(autonomousProfileIsJailed({ ...locked, autoArgs: null }), false);
  assert.equal(autonomousProfileIsJailed({ ...locked, autoEnv: null }), false);
  assert.equal(autonomousProfileIsJailed({ autoArgs() {}, autoEnv() {} }), false);
  assert.equal(autonomousProfileIsJailed(null), false);
});

test("the central autonomous runner refuses an unjailed profile before spawning", () => {
  const runner = source.match(/function runAutonomousTask[\s\S]*?\r?\n}\r?\n\r?\n\/\/ The autonomous prompt/)?.[0] || "";
  assert.match(runner, /if \(!autonomousProfileIsJailed\(eng\)\)[\s\S]*?AUTONOMOUS_PROFILE_UNSAFE/);
  assert.ok(runner.indexOf("autonomousProfileIsJailed(eng)") < runner.indexOf("return new Promise((resolve)"),
    "the jail decision must happen before any local engine process can start");
});

test("Foundation B does not route models into the unfinished host-visible root worker", () => {
  assert.doesNotMatch(source, /runGovernedViaAuthority|bindGovernedRun/,
    "gate.js must keep model work in the proven read-jails until the root worker preserves their boundary");
});
