// openclaw-plugin-config.js -- enables the AgentHost channel broker plugin
// (openclaw-channel-broker/index.js) in an OpenClaw openclaw.json.
//
// enableChannelBrokerPlugin() is a pure merge: it only ever touches
// plugins.load.paths (adds our plugin's path if absent) and
// plugins.entries["agenthost-channel-broker"] (forces enabled + the
// hooks.allowConversationAccess opt-in real conversation hooks require,
// per OpenClaw's own PluginEntryConfig type -- non-bundled plugins must ask
// explicitly). Everything else already in the config -- channels, auth,
// other plugins' entries -- passes through untouched. Safe to re-run: the
// merge is idempotent (test/openclaw-plugin-config.test.js proves this).
//
// container/claw-setup.sh calls this file directly as a CLI:
//   node openclaw-plugin-config.js <openclaw.json path> <plugin directory>
const fs = require("fs");

function enableChannelBrokerPlugin(config, pluginPath) {
  const cfg = { ...(config || {}) };
  const plugins = { ...(cfg.plugins || {}) };

  const load = { ...(plugins.load || {}) };
  const paths = Array.isArray(load.paths) ? load.paths.slice() : [];
  if (!paths.includes(pluginPath)) paths.push(pluginPath);
  load.paths = paths;
  plugins.load = load;

  const entries = { ...(plugins.entries || {}) };
  const existing = entries["agenthost-channel-broker"] || {};
  entries["agenthost-channel-broker"] = {
    ...existing,
    enabled: true,
    hooks: { ...(existing.hooks || {}), allowConversationAccess: true },
  };
  plugins.entries = entries;

  cfg.plugins = plugins;
  return cfg;
}

function main() {
  const [configPath, pluginPath] = process.argv.slice(2);
  if (!configPath || !pluginPath) {
    console.error("usage: node openclaw-plugin-config.js <config.json path> <plugin.js path>");
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const updated = enableChannelBrokerPlugin(config, pluginPath);
  // Atomic write (red-team fix, 2026-07-23): write a temp file then rename, so a crash /
  // OOM / SIGKILL mid-write can never leave the operator's working config.json truncated.
  // rename(2) is atomic on the same filesystem. Same pattern gate.js uses for secrets.env
  // and ~/.claude.json.
  const tmp = configPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(updated, null, 2) + "\n");
  fs.renameSync(tmp, configPath);
}

if (require.main === module) main();

module.exports = { enableChannelBrokerPlugin };
