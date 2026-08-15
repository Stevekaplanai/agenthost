// Unit tests for container/mode-lib.js -- the Growth Mode registry (ARD Wave 0,
// T0.1). The registry decides ONE thing (which mode this box booted in) and its
// hard rule is that it can never throw: a missing, corrupt, or hostile
// /data/mode.json must yield "default", never a crash-loop.
// The container subtree is CommonJS while test/ inherits the root's ESM type,
// hence createRequire instead of a bare import.
// Run: node --test test/mode-lib.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const modeLib = require("../container/mode-lib.js");

const tmp = fs.mkdtempSync(path.join(import.meta.dirname, ".modelib-"));
const fixture = (name, contents) => {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, contents);
  return file;
};

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// ---- green paths -----------------------------------------------------------

test("readModeState accepts a well-formed growth state", () => {
  const file = fixture("growth.json", JSON.stringify({
    schema_version: 1, mode: "growth", set_at: "2026-07-31T12:00:00.000Z", set_by: "cli",
  }));
  assert.deepEqual(modeLib.readModeState(file), {
    mode: "growth", setAt: "2026-07-31T12:00:00.000Z", setBy: "cli", reason: null,
  });
});

test("readModeState accepts an explicit default state", () => {
  const file = fixture("default.json", JSON.stringify(modeLib.buildModeState("default")));
  assert.equal(modeLib.readModeState(file).mode, "default");
  assert.equal(modeLib.readModeState(file).reason, null);
});

test("buildModeState round-trips through readModeState (writer and reader agree)", () => {
  const state = modeLib.buildModeState("growth", "cli");
  assert.equal(state.schema_version, modeLib.SCHEMA_VERSION);
  assert.match(state.set_at, /^\d{4}-\d{2}-\d{2}T/);
  const back = modeLib.readModeState(fixture("roundtrip.json", JSON.stringify(state)));
  assert.equal(back.mode, "growth");
  assert.equal(back.setBy, "cli");
  assert.equal(back.setAt, state.set_at);
  assert.equal(back.reason, null);
});

// ---- red paths: every one of these must default, never throw ----------------

test("a missing mode file is the NORMAL default case -- no reason, no noise", () => {
  const state = modeLib.readModeState(path.join(tmp, "does-not-exist.json"));
  assert.equal(state.mode, "default");
  assert.equal(state.reason, null);
});

test("an unreadable path (a directory) defaults and names the problem", () => {
  const state = modeLib.readModeState(tmp);
  assert.equal(state.mode, "default");
  assert.match(state.reason, /unreadable/);
});

test("malformed JSON defaults and names the problem", () => {
  const state = modeLib.readModeState(fixture("bad.json", "{ mode: growth"));
  assert.equal(state.mode, "default");
  assert.match(state.reason, /not valid JSON/);
});

test("a JSON array (not an object) defaults", () => {
  const state = modeLib.readModeState(fixture("array.json", '["growth"]'));
  assert.equal(state.mode, "default");
  assert.match(state.reason, /object/);
});

test("an unknown mode name defaults and names both the value and the known modes", () => {
  const state = modeLib.readModeState(fixture("unknown.json", JSON.stringify({
    schema_version: 1, mode: "chaos",
  })));
  assert.equal(state.mode, "default");
  assert.match(state.reason, /chaos/);
  assert.match(state.reason, /growth/);
});

test("a missing mode key defaults", () => {
  const state = modeLib.readModeState(fixture("nomode.json", JSON.stringify({ schema_version: 1 })));
  assert.equal(state.mode, "default");
  assert.match(state.reason, /unknown mode/);
});

test("a future schema_version defaults and names both versions", () => {
  const state = modeLib.readModeState(fixture("v2.json", JSON.stringify({
    schema_version: 2, mode: "growth",
  })));
  assert.equal(state.mode, "default");
  assert.match(state.reason, /2/);
  assert.match(state.reason, /1/);
});

test("a missing schema_version defaults -- the writer always stamps one", () => {
  const state = modeLib.readModeState(fixture("nover.json", JSON.stringify({ mode: "growth" })));
  assert.equal(state.mode, "default");
  assert.match(state.reason, /schema_version/);
});

// ---- boot-fixed ------------------------------------------------------------

test("activeMode is a known mode and matches the file the module read", () => {
  assert.ok(modeLib.MODES.includes(modeLib.activeMode()));
  assert.equal(modeLib.activeMode(), modeLib.activeModeState().mode);
  // This machine has no /data, so the registry must be sitting on the default.
  assert.equal(modeLib.activeMode(), "default");
});

test("activeMode is fixed at module load -- rewriting the file mid-process changes nothing", () => {
  const file = fixture("boot-fixed.json", JSON.stringify(modeLib.buildModeState("growth")));
  // A child process proves it: it loads the registry with the file saying
  // growth, then rewrites the file to default and re-reads activeMode().
  const script = `
    const fs = require("fs");
    const lib = require(${JSON.stringify(path.resolve(import.meta.dirname, "../container/mode-lib.js"))});
    const booted = lib.activeMode();
    fs.writeFileSync(process.env.AGENTHOST_MODE_FILE, JSON.stringify(lib.buildModeState("default")));
    console.log(JSON.stringify({ booted, after: lib.activeMode(), fresh: lib.readModeState().mode }));
  `;
  const out = execFileSync(process.execPath, ["-e", script], {
    env: { ...process.env, AGENTHOST_MODE_FILE: file }, encoding: "utf8",
  });
  const res = JSON.parse(out.trim().split("\n").pop());
  assert.equal(res.booted, "growth");
  assert.equal(res.after, "growth", "activeMode() must stay boot-fixed");
  assert.equal(res.fresh, "default", "a fresh read does see the new file -- only activeMode() is frozen");
});
