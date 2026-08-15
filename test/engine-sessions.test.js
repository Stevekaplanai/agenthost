// Durable per-engine session identity (engine-sessions.js): a gate restart
// must resume the same Codex/Hermes conversations instead of silently starting
// fresh. Round-trips the store through a real temp file and pins the
// corruption / hostile-content behavior (fresh start, never a throw, never a
// prototype-polluting key). Router build slice 1 (Rule 14 sweep, flag #2).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEngineSessions, saveEngineSessions } from "../container/engine-sessions.js";

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-sessions-"));
  return path.join(dir, "engine-sessions.json");
}

test("sessions: save/load round-trips the map across a simulated restart", () => {
  const file = tmpFile();
  const sessions = Object.create(null);
  sessions.codex = "0198c3f2-example-thread";
  sessions.hermes = "20260731_101500_abcdef";
  assert.strictEqual(saveEngineSessions(file, sessions), true);
  const restored = loadEngineSessions(file);
  assert.strictEqual(restored.codex, "0198c3f2-example-thread");
  assert.strictEqual(restored.hermes, "20260731_101500_abcdef");
  assert.strictEqual(Object.keys(restored).length, 2);
});

test("sessions: a dropped (dead) session stays dropped after restart", () => {
  const file = tmpFile();
  const sessions = Object.create(null);
  sessions.codex = "dead-thread";
  saveEngineSessions(file, sessions);
  delete sessions.codex; // gate.js deadSession path, then persist
  saveEngineSessions(file, sessions);
  assert.deepStrictEqual({ ...loadEngineSessions(file) }, {});
});

test("sessions: missing file is a fresh start, never a throw", () => {
  const restored = loadEngineSessions(path.join(os.tmpdir(), "does-not-exist", "x.json"));
  assert.deepStrictEqual({ ...restored }, {});
});

test("sessions: corrupt or non-object file content is discarded safely", () => {
  const file = tmpFile();
  for (const junk of ["{torn json", "[1,2,3]", "\"a string\"", "null"]) {
    fs.writeFileSync(file, junk);
    assert.deepStrictEqual({ ...loadEngineSessions(file) }, {});
  }
});

test("sessions: hostile entries are dropped and the map stays null-prototype", () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({
    codex: "good-id",
    bad1: 42,
    bad2: null,
    bad3: { nested: true },
    bad4: "x".repeat(500), // over the 200-char id ceiling
    "": "empty-label",
  }));
  const restored = loadEngineSessions(file);
  assert.strictEqual(restored.codex, "good-id");
  assert.strictEqual(Object.keys(restored).length, 1);
  assert.strictEqual(Object.getPrototypeOf(restored), null);
  // an inherited-looking key can never resolve through the prototype chain
  assert.strictEqual(restored.toString, undefined);
});

test("sessions: save creates the parent directory when missing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-sessions-"));
  const file = path.join(dir, "deeper", "still", "engine-sessions.json");
  const sessions = Object.create(null);
  sessions.codex = "abc";
  assert.strictEqual(saveEngineSessions(file, sessions), true);
  assert.strictEqual(loadEngineSessions(file).codex, "abc");
});
