// Discovery scanner (scripts/discover-harness.mjs): proves it FINDS harness
// artifacts sprawled across many tools/locations AND -- the security invariant --
// never prints a secret VALUE (it reads configs to list names, not to reveal keys).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRIPT = path.join(import.meta.dirname, "..", "scripts", "discover-harness.mjs");
const DISABLED_CREDENTIAL_PLUGIN_ID = `ghp_${"D".repeat(36)}`;

function buildSprawl() {
  const R = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-discover-"));
  const w = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
  const d = (p) => fs.mkdirSync(p, { recursive: true });
  d(path.join(R, ".claude/skills/pdf-tools")); d(path.join(R, ".claude/skills/writer"));
  d(path.join(R, ".claude/skills/token-budget-advisor"));
  d(path.join(R, `.claude/skills/${"ghp_" + "S".repeat(36)}`));
  d(path.join(R, ".claude/commands/deploy")); d(path.join(R, ".claude/agents/reviewer"));
  d(path.join(R, ".claude/plugins/obsidian"));
  w(path.join(R, ".claude/mcp.json"), JSON.stringify({ mcpServers: { filesystem: { command: "npx" } } }));
  w(path.join(R, ".claude/settings.json"), JSON.stringify({
    enabledPlugins: {
      "brand-kit@mp": true,
      "off@mp": false,
      [DISABLED_CREDENTIAL_PLUGIN_ID]: false,
    },
    permissions: { allow: ["Read", "Bearer abcdefghijklmnopqrstuvwxyz123456", "mcp__019ff47c-eb10-7d21-abb1-a610d171b303__vault_read"] },
  }));
  w(path.join(R, ".claude.json"), JSON.stringify({
    mcpServers: {
      github: {
        command: "npx --token LEAKCANARY_COMMAND",
        args: ["--header", "Authorization: Bearer LEAKCANARY_ARGS"],
        env: { GITHUB_TOKEN: "ghp_LEAKCANARY_A" },
      },
      linear: {
        type: "http",
        url: "https://mcp.linear.app?token=LEAKCANARY_URL",
        headers: { Authorization: "Bearer LEAKCANARY_B" },
      },
      mystery: { type: "LEAKCANARY_TYPE" },
      ["AIza" + "Z".repeat(35)]: { command: "must-not-be-inventory" },
    },
    projects: { "/home/x/p1": { mcpServers: { sentry: { url: "https://mcp.sentry.dev" } } } } }));
  w(path.join(R, ".codex/AGENTS.md"), "x"); d(path.join(R, ".codex/prompts/review"));
  w(path.join(R, ".codex/config.toml"), [
    "[mcp_servers.playwright]",
    "command=\"npx\"",
    "[mcp_servers.playwright.env]",
    "KEY=\"LEAKCANARY_C\"",
    "[mcp_servers.phantom.http_headers]",
    "Authorization=\"LEAKCANARY_NESTED\"",
    "[mcp_servers.\"remote.with.dot\"]",
    "url=\"https://example.invalid\"",
  ].join("\n"));
  w(path.join(R, ".cursor/mcp.json"), JSON.stringify({ mcpServers: { figma: { url: "https://f", headers: { "X-Api-Key": "LEAKCANARY_D" } } } }));
  w(path.join(R, ".config/Claude/claude_desktop_config.json"), JSON.stringify({ mcpServers: { slack: { command: "npx", env: { SLACK_TOKEN: "xoxb-LEAKCANARY_E" } } } }));
  d(path.join(R, "projects/repoA/.claude/skills/localskill"));
  w(path.join(R, "projects/repoA/CLAUDE.md"), "x");
  w(path.join(R, "projects/repoA/.mcp.json"), JSON.stringify({ mcpServers: { postgres: { command: "npx", env: { PG: "LEAKCANARY_F" } } } }));
  w(path.join(R, "projects/repoA/test/.gatecc-stale/.mcp.json"), JSON.stringify({
    mcpServers: { "stale-test-home": { command: "must-not-be-inventory" } },
  }));
  return R;
}

function run(R, extra = []) {
  const res = spawnSync("node", [SCRIPT, ...extra], {
    env: {
      ...process.env,
      HOME: R,
      USERPROFILE: R,
      APPDATA: path.join(R, ".config"),
      XDG_CONFIG_HOME: path.join(R, ".config"),
    },
    cwd: R, encoding: "utf8",
  });
  return res.stdout || "";
}

test("discovery finds MCPs/skills/plugins across every tool + location", () => {
  const R = buildSprawl();
  try {
    const out = run(R, ["--scan", path.join(R, "projects")]);
    for (const mcp of ["filesystem", "github", "linear", "mystery", "sentry", "playwright", "figma", "slack", "postgres"]) {
      assert.ok(out.includes(mcp), `MCP '${mcp}' must be discovered`);
    }
    for (const skill of ["pdf-tools", "writer", "token-budget-advisor", "localskill"]) assert.ok(out.includes(skill), `skill '${skill}'`);
    assert.ok(out.includes("brand-kit@mp"), "enabled plugin discovered");
    assert.ok(!out.includes("off@mp"), "disabled plugin not listed as enabled");
    assert.ok(out.includes("Claude Desktop") && out.includes("Cursor") && out.includes("Codex"), "tools detected");
  } finally { fs.rmSync(R, { recursive: true, force: true }); }
});

test("discovery NEVER prints a secret value (reads names, not keys)", () => {
  const R = buildSprawl();
  try {
    for (const flags of [[], ["--json"], ["--scan", path.join(R, "projects")]]) {
      const out = run(R, flags);
      assert.doesNotMatch(out, /LEAKCANARY_(?:[A-F]|ARGS|COMMAND|TYPE|URL)|ghp_LEAKCANARY|xoxb-LEAKCANARY|Bearer LEAKCANARY/,
        `no secret value may appear (flags: ${flags.join(" ") || "none"})`);
      assert.doesNotMatch(out, /ghp_S{36}|AIzaZ{35}|Bearer abcdefghijklmnopqrstuvwxyz123456/,
        `credential-shaped names and permission entries are omitted (flags: ${flags.join(" ") || "none"})`);
    }
  } finally { fs.rmSync(R, { recursive: true, force: true }); }
});

test("--json emits a machine-readable inventory the packer can consume", () => {
  const R = buildSprawl();
  try {
    const out = run(R, ["--json", "--scan", path.join(R, "projects")]);
    const inv = JSON.parse(out);
    assert.ok(Array.isArray(inv.mcpServers) && inv.mcpServers.length >= 9, "mcpServers array present");
    assert.ok(inv.mcpServers.every((m) => m.name && m.source && !JSON.stringify(m).match(/LEAKCANARY/)), "entries carry name+source, no values");
    assert.ok(inv.mcpServers.some((m) => m.name === "remote.with.dot"), "a quoted direct MCP table is discovered");
    assert.ok(!inv.mcpServers.some((m) => m.name.includes("phantom") || m.name.includes("http_headers")),
      "nested TOML tables do not invent MCP servers");
    assert.ok(!inv.mcpServers.some((m) => m.name === "stale-test-home"),
      "hidden runtime/test homes do not become laptop inventory");
    assert.ok(inv.mcpServers.every((m) => m.configured === true && m.runtimeConnected === null),
      "configuration discovery never claims a live runtime connection");
    assert.ok(Array.isArray(inv.skills) && Array.isArray(inv.instructions), "skills + instructions arrays present");
    assert.ok(Array.isArray(inv.items) && inv.items.some((item) => item.key === "mcp:playwright"),
      "the scanner and reporter expose one normalized inventory contract");
    assert.ok(inv.items.some((item) => item.key === "tool:read"), "configured action tools enter the normalized inventory");
    assert.ok(!JSON.stringify(inv.actionTools).includes("019ff47c-eb10-7d21-abb1-a610d171b303"),
      "unresolved UUID connector heads stay out of the laptop proposal");
    assert.ok(inv.proposal && Array.isArray(inv.proposal.rows), "a deterministic consolidation proposal is included");
    assert.ok(inv.proposal.rows.every((row) => row.operatorDecision === ""), "operator decisions start blank");
    assert.ok(!JSON.stringify(inv).includes(DISABLED_CREDENTIAL_PLUGIN_ID),
      "credential-shaped disabled plugin IDs stay out of normalized inventory and proposals");
  } finally { fs.rmSync(R, { recursive: true, force: true }); }
});

test("--proposal-dir writes deterministic JSON and Markdown without applying decisions", () => {
  const R = buildSprawl();
  const outDir = path.join(R, "proposal");
  try {
    run(R, ["--scan", path.join(R, "projects"), "--proposal-dir", outDir]);
    const jsonPath = path.join(outDir, "inventory-consolidation-proposal.json");
    const mdPath = path.join(outDir, "inventory-consolidation-proposal.md");
    const firstJson = fs.readFileSync(jsonPath, "utf8");
    const firstMarkdown = fs.readFileSync(mdPath, "utf8");
    assert.ok(!firstJson.includes(DISABLED_CREDENTIAL_PLUGIN_ID) && !firstMarkdown.includes(DISABLED_CREDENTIAL_PLUGIN_ID),
      "credential-shaped disabled plugin IDs stay out of both proposal files");
    run(R, ["--scan", path.join(R, "projects"), "--proposal-dir", outDir]);
    assert.equal(fs.readFileSync(jsonPath, "utf8"), firstJson, "JSON is byte-stable on a repeated scan");
    assert.equal(fs.readFileSync(mdPath, "utf8"), firstMarkdown, "Markdown is byte-stable on a repeated scan");
    const proposal = JSON.parse(firstJson);
    assert.ok(proposal.rows.length > 0);
    assert.ok(proposal.rows.every((row) => row.operatorDecision === ""));
    assert.match(firstMarkdown, /Nothing on the laptop was deleted, moved, disabled, or rewritten/);
  } finally { fs.rmSync(R, { recursive: true, force: true }); }
});
