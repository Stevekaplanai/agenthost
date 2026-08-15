// B6 (launch-eve handoff, 2026-07-26): the two bridge mechanisms disagreed.
// The WRITER is container/start.sh — `agenthost bridge` sets BRIDGE_URL (+
// optional BRIDGE_TOKEN) as Fly secrets, and start.sh renders ~/BRIDGE.md from
// those env vars every boot. The READER was gate.js's loadBridge(), which read
// ONLY ~/.bridge.env — a file nothing in the product ever writes — so the
// Files-panel bridge said "not configured" on a box whose bridge demonstrably
// worked. The fix: loadBridge() falls back per-key to the SAME env vars the
// writer reads. This is the source-marker lock (rule-manifest.test.js style):
// if either side stops keying off BRIDGE_URL/BRIDGE_TOKEN, this goes red.
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const gateSrc = fs.readFileSync(path.join(root, "container", "gate.js"), "utf8");
const startSrc = fs.readFileSync(path.join(root, "container", "start.sh"), "utf8");

test("bridge writer (start.sh) renders ~/BRIDGE.md from the BRIDGE_URL env secret", () => {
  assert.ok(startSrc.includes('if [ -n "${BRIDGE_URL:-}" ]; then'),
    "start.sh no longer keys ~/BRIDGE.md off the BRIDGE_URL env var");
  assert.ok(startSrc.includes('> "$HOME/BRIDGE.md"'),
    "start.sh no longer writes ~/BRIDGE.md");
});

test("bridge reader (gate.js loadBridge) falls back to the same BRIDGE_URL/BRIDGE_TOKEN env the writer reads", () => {
  // The legacy file path stays first (Steve's box), but the env fallback is
  // what makes a stock `agenthost bridge` box agree with its own BRIDGE.md.
  assert.ok(gateSrc.includes('const BRIDGE_ENV_FILE = path.join(HOME_DIR, ".bridge.env")'),
    "the legacy ~/.bridge.env read was removed — fine only if the manifest/test are updated together");
  assert.ok(gateSrc.includes('for (const k of ["BRIDGE_URL", "BRIDGE_TOKEN"]) {'),
    "loadBridge lost its env fallback keys — the reader and writer no longer share a config location (B6 regression)");
  assert.ok(gateSrc.includes("if (!out[k] && process.env[k]) out[k] = process.env[k];"),
    "loadBridge lost the process.env fallback — a box configured via `agenthost bridge` (env secrets only) reads as unconfigured (B6 regression)");
});
