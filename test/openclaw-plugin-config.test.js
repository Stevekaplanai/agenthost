// Unit tests for container/openclaw-plugin-config.js's enableChannelBrokerPlugin() -- the
// pure merge claw-setup.sh runs to wire the channel broker plugin into an OpenClaw
// config.json. Proves it enables the three required keys AND leaves everything else
// (channels, auth, other plugins) untouched, and is idempotent under re-run (claw-setup is
// documented safe to re-run).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
const require = createRequire(import.meta.url);
const { enableChannelBrokerPlugin } = require("../container/openclaw-plugin-config.js");

// The plugin ships as a DIRECTORY (openclaw.plugin.json manifest + package.json + index.js),
// and plugins.load.paths must point at that directory -- a bare .js path is silently ignored
// by OpenClaw ("plugin manifest not found"). Verified against openclaw@2026.7.1-2.
const PLUGIN_PATH = "/opt/agenthost/openclaw-channel-broker";
const CLI = path.join(import.meta.dirname, "..", "container", "openclaw-plugin-config.js");

test("enables the plugin on an empty/fresh config: load path + entry + conversation access", () => {
  const out = enableChannelBrokerPlugin({}, PLUGIN_PATH);
  assert.deepEqual(out.plugins.load.paths, [PLUGIN_PATH]);
  const entry = out.plugins.entries["agenthost-channel-broker"];
  assert.equal(entry.enabled, true);
  assert.equal(entry.hooks.allowConversationAccess, true, "before_agent_run needs raw conversation access; non-bundled plugins must opt in explicitly");
});

test("preserves an operator's existing channels, auth, and other plugins", () => {
  const original = {
    channels: { telegram: { botToken: "keep-me" }, discord: { token: "also-keep" } },
    auth: { choice: "gemini-api-key" },
    plugins: {
      load: { paths: ["/opt/agenthost/some-other-plugin.js"] },
      entries: { "some-other-plugin": { enabled: true, hooks: { allowPromptInjection: true } } },
    },
  };
  const out = enableChannelBrokerPlugin(original, PLUGIN_PATH);
  assert.deepEqual(out.channels, original.channels, "channels are never touched");
  assert.deepEqual(out.auth, original.auth, "auth is never touched");
  assert.ok(out.plugins.load.paths.includes("/opt/agenthost/some-other-plugin.js"), "other load paths survive");
  assert.ok(out.plugins.load.paths.includes(PLUGIN_PATH), "our path is added");
  assert.deepEqual(out.plugins.entries["some-other-plugin"], original.plugins.entries["some-other-plugin"], "another plugin's entry is left exactly as-is");
});

test("is idempotent: re-running does not duplicate the load path or the entry", () => {
  const once = enableChannelBrokerPlugin({}, PLUGIN_PATH);
  const twice = enableChannelBrokerPlugin(once, PLUGIN_PATH);
  assert.deepEqual(twice.plugins.load.paths, [PLUGIN_PATH], "load path appears exactly once after two runs");
  assert.deepEqual(twice, once, "second run is a no-op on an already-wired config");
});

test("does not mutate the caller's input object", () => {
  const input = { plugins: { entries: {} } };
  const before = JSON.stringify(input);
  enableChannelBrokerPlugin(input, PLUGIN_PATH);
  assert.equal(JSON.stringify(input), before, "input is cloned, not edited in place");
});

test("if the plugin entry already exists with extra keys, enable/hooks are forced but other keys survive", () => {
  const cfg = {
    plugins: {
      entries: {
        "agenthost-channel-broker": { enabled: false, timeoutMs: 5000, hooks: { timeoutMs: 3000 } },
      },
    },
  };
  const out = enableChannelBrokerPlugin(cfg, PLUGIN_PATH);
  const entry = out.plugins.entries["agenthost-channel-broker"];
  assert.equal(entry.enabled, true, "a stale enabled:false is corrected to true");
  assert.equal(entry.timeoutMs, 5000, "unrelated entry keys are preserved");
  assert.equal(entry.hooks.allowConversationAccess, true, "conversation access is added");
  assert.equal(entry.hooks.timeoutMs, 3000, "unrelated hook keys are preserved");
});

// ---- CLI path (main): atomic write + safe failure on malformed config ----
// These exercise the actual `node openclaw-plugin-config.js <config> <plugin>` entry point
// claw-setup.sh invokes, on a real temp file -- not just the pure merge function.
function tmpConfig(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cfg-"));
  const p = path.join(dir, "config.json");
  fs.writeFileSync(p, contents);
  return p;
}

test("CLI writes a valid, enabled config and leaves no .tmp behind (atomic rename)", () => {
  const p = tmpConfig(JSON.stringify({ channels: { telegram: { botToken: "keep" } } }));
  execFileSync("node", [CLI, p, PLUGIN_PATH]);
  const out = JSON.parse(fs.readFileSync(p, "utf8"));
  assert.equal(out.channels.telegram.botToken, "keep", "existing config preserved");
  assert.equal(out.plugins.entries["agenthost-channel-broker"].enabled, true);
  assert.equal(fs.existsSync(p + ".tmp"), false, "the temp file is renamed away, never left behind");
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test("CLI fails non-zero on malformed JSON WITHOUT corrupting or truncating the original file", () => {
  const bad = "{ this is not valid json ";
  const p = tmpConfig(bad);
  let threw = false;
  try { execFileSync("node", [CLI, p, PLUGIN_PATH], { stdio: "pipe" }); }
  catch { threw = true; }
  assert.equal(threw, true, "a malformed config makes the CLI exit non-zero");
  assert.equal(fs.readFileSync(p, "utf8"), bad, "the original (bad) file is left byte-for-byte untouched -- parse fails before any write, so a working config is never half-overwritten");
  assert.equal(fs.existsSync(p + ".tmp"), false, "no stray temp file on the failure path");
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});
