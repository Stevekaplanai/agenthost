// End-to-end: pack.mjs (default Claude agent) migrates ~/.claude/plugins but
// drops the regeneratable cache/. Builds a throwaway HOME, runs the packer with
// --dry-run (staging is still written; only the tarball is skipped).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACK_MJS = path.join(REPO_ROOT, "scripts", "pack.mjs");

function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
}

test("pack.mjs migrates plugins/ but not plugins/cache", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-plugins-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  writeTree(home, {
    ".claude/settings.json": JSON.stringify({ model: "claude-fable-5" }) + "\n",
    ".claude/CLAUDE.md": "# root\n",
    ".claude/plugins/installed_plugins.json": JSON.stringify({ plugins: ["a", "b"] }),
    ".claude/plugins/known_marketplaces.json": JSON.stringify({ market: "x" }),
    ".claude/plugins/marketplaces/x/plugin.json": JSON.stringify({ name: "x" }),
    ".claude/plugins/data/a/state.json": JSON.stringify({ enabled: true }),
    // regeneratable -- must be dropped:
    ".claude/plugins/cache/blob.bin": "cached-download-payload",
    ".claude/plugins/marketplaces/x/cache/y.bin": "nested-cache",
  });

  const out = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-plugins-out-"));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const res = spawnSync(process.execPath, [PACK_MJS, "--out", out, "--dry-run"], {
    env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: "utf8",
  });
  assert.equal(res.status, 0, `pack.mjs exited ${res.status}\n${res.stderr}`);

  const plugins = path.join(out, "staging", ".claude", "plugins");
  assert.ok(fs.existsSync(path.join(plugins, "installed_plugins.json")), "installed_plugins.json staged");
  assert.ok(fs.existsSync(path.join(plugins, "known_marketplaces.json")), "known_marketplaces.json staged");
  assert.ok(fs.existsSync(path.join(plugins, "marketplaces", "x", "plugin.json")), "marketplace manifest staged");
  assert.ok(fs.existsSync(path.join(plugins, "data", "a", "state.json")), "plugin data staged");
  assert.ok(!fs.existsSync(path.join(plugins, "cache")), "top-level plugins/cache dropped");
  assert.ok(!fs.existsSync(path.join(plugins, "marketplaces", "x", "cache")), "nested cache dropped");
});
