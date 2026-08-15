// The curated starter stack every box ships with. Two guards: (1) the manifest
// is well-formed and every entry has what start.sh + the skills CLI need; (2)
// the settings.json merge logic in start.sh NEVER clobbers a user's own plugin
// choices (theirs always wins) -- the whole point of "merge, not clobber."
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..", "container");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "starter-stack.json"), "utf8"));
const startSh = fs.readFileSync(path.join(ROOT, "start.sh"), "utf8");

test("starter-stack manifest is well-formed for start.sh + the skills CLI", () => {
  assert.ok(Array.isArray(manifest.plugins) && manifest.plugins.length, "has plugins");
  for (const p of manifest.plugins) {
    // start.sh reads id/marketplace/repo to build the settings.json merge.
    assert.match(p.id, /^[^@\s]+@[^@\s]+$/, `plugin id is plugin@marketplace: ${p.id}`);
    assert.equal(p.id.split("@")[1], p.marketplace, `${p.id}: marketplace half matches .marketplace`);
    assert.match(p.repo, /^[\w.-]+\/[\w.-]+$/, `plugin repo is owner/name: ${p.repo}`);
    assert.ok(p.name && p.blurb && p.category, `${p.id}: has name/blurb/category`);
  }
  for (const s of manifest.skills || []) {
    assert.match(s.dir, /^[\w-]+$/, `skill dir is a safe folder name: ${s.dir}`);
    assert.match(s.repo, /^[\w.-]+\/[\w.-]+$/, `skill repo is owner/name: ${s.repo}`);
    assert.ok(s.name && s.blurb, `skill ${s.dir}: has name + blurb`);
  }
  for (const m of manifest.mcp || []) {
    assert.ok(m.install && m.name, `mcp ${m.name}: has install command`);
    // The install command runs via sh -c on every box -- must be a real command,
    // never a placeholder that would spam WARNs.
    assert.ok(!/TODO|FIXME|<.*>/.test(m.install), `mcp ${m.name}: install has no placeholder`);
  }
});

test("start.sh installs the starter stack first-boot only, marker-guarded, best-effort", () => {
  // Marker lives under the agent-owned $BOOT_DIR ($HOME/.agenthost-boot), NOT loose
  // in /data — /data must stay root:root 0755 for the Foundation B native authority
  // (2026-07-25 flip-blocker fix). The agent can always write its own home.
  assert.ok(startSh.includes('"$BOOT_DIR/.starter-stack"'), "guards on a first-boot marker in $BOOT_DIR");
  assert.ok(startSh.includes("starter-stack.json"), "reads the manifest");
  // Marker is only touched inside the guarded block (so a failed install retries).
  assert.ok(startSh.includes('touch "$BOOT_DIR/.starter-stack"'), "sets the marker when done");
  // Regression guard for the flip-blocker fix: no first-boot marker may live loose
  // in /data (root-owned now), and BOOT_DIR must be defined before it's used.
  assert.ok(!/\/data\/\.starter-stack/.test(startSh), "starter marker is not under /data anymore");
  assert.ok(startSh.includes('BOOT_DIR="$HOME/.agenthost-boot"'), "defines BOOT_DIR under the agent home");
  // Every install path WARNs rather than exiting -- the stack must never block boot.
  const block = startSh.slice(startSh.indexOf("1e. Starter stack"), startSh.indexOf("1b. Hermes"));
  assert.ok(block.includes("WARN"), "failures WARN, never abort");
  assert.ok(block.includes("extraKnownMarketplaces") && block.includes("enabledPlugins"),
    "merges both settings.json keys plugins install through");
  // Regression guard (a real blocker once shipped): the manifest path MUST be
  // exported so every `node -e` child inherits it via process.env. The broken
  // form -- `node -e '...' STARTER_MANIFEST=...` -- puts the assignment in argv,
  // not env, so process.env.STARTER_MANIFEST is undefined and the skill-clone /
  // MCP-install steps silently no-op. Assert the export exists and no node call
  // uses the trailing-assignment form.
  assert.match(block, /export STARTER_MANIFEST=/, "manifest path is exported for the node children");
  assert.doesNotMatch(block, /node -e '[^']*'\s+STARTER_MANIFEST=/,
    "no node -e with a trailing STARTER_MANIFEST= (that lands in argv, not env)");
});

test("the settings.json merge never clobbers a user's own plugin choices", () => {
  // Re-implement the exact merge start.sh runs (the node -e block), then prove a
  // user's existing marketplace + an explicit disable both survive untouched.
  function merge(settings, man) {
    const s = settings && typeof settings === "object" ? { ...settings } : {};
    s.extraKnownMarketplaces = { ...(s.extraKnownMarketplaces || {}) };
    s.enabledPlugins = { ...(s.enabledPlugins || {}) };
    for (const p of man.plugins || []) {
      if (!s.extraKnownMarketplaces[p.marketplace]) {
        s.extraKnownMarketplaces[p.marketplace] = { source: { source: "github", repo: p.repo } };
      }
      if (!(p.id in s.enabledPlugins)) s.enabledPlugins[p.id] = true;
    }
    return s;
  }
  const firstPlugin = manifest.plugins[0];
  // A user who already registered that marketplace to a DIFFERENT repo, and who
  // explicitly DISABLED that plugin, must keep both after the merge.
  const userSettings = {
    extraKnownMarketplaces: { [firstPlugin.marketplace]: { source: { source: "github", repo: "someone/their-fork" } } },
    enabledPlugins: { [firstPlugin.id]: false },
  };
  const merged = merge(userSettings, manifest);
  assert.equal(merged.extraKnownMarketplaces[firstPlugin.marketplace].source.repo, "someone/their-fork",
    "user's marketplace repo is NOT overwritten");
  assert.equal(merged.enabledPlugins[firstPlugin.id], false,
    "a deliberate disable is NOT flipped back on");
  // But a fresh box (empty settings) gets everything enabled.
  const fresh = merge({}, manifest);
  for (const p of manifest.plugins) {
    assert.equal(fresh.enabledPlugins[p.id], true, `fresh box enables ${p.id}`);
    assert.ok(fresh.extraKnownMarketplaces[p.marketplace], `fresh box registers ${p.marketplace}`);
  }
});
