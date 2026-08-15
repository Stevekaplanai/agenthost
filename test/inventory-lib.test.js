import test from "node:test";
import assert from "node:assert/strict";
import inventoryLib from "../container/inventory-lib.js";

const {
  parseCodexMcpNamesText,
  parseCodexEnabledToolNamesText,
  parseInventoryTool,
  normalizeInventory,
  buildConsolidationProposal,
  renderConsolidationMarkdown,
} = inventoryLib;

test("Codex MCP discovery accepts only direct server tables, including quoted names", () => {
  const names = parseCodexMcpNamesText([
    "[mcp_servers.codegraph]",
    "command = 'npx'",
    "[mcp_servers.codegraph.env]",
    "TOKEN = 'never-read'",
    "[mcp_servers.phantom.http_headers]",
    "Authorization = 'never-read'",
    "[mcp_servers.\"remote.with.dot\"]",
    "url = 'https://example.invalid'",
    "[mcp_servers.\"remote.with.dot\".http_headers]",
    "Authorization = 'never-read'",
  ].join("\n"));

  assert.deepEqual(names, ["codegraph", "remote.with.dot"]);
});

test("Codex tool discovery stays inside the direct tools table", () => {
  assert.deepEqual(parseCodexEnabledToolNamesText([
    "[tools]",
    "web_search = true",
    "disabled = false",
    "[mcp_servers.web_search]",
    "enabled = true",
  ].join("\n")), ["web_search"]);
});

test("Codex tool discovery accepts a legal inline comment on the tools table", () => {
  assert.deepEqual(parseCodexEnabledToolNamesText([
    "[tools] # enabled Codex tools",
    "web_search = true",
  ].join("\n")), ["web_search"]);
});

test("Codex discovery ignores table-shaped lines inside valid multiline strings", () => {
  const config = [
    "basic = \"\"\"",
    "[mcp_servers.fake_basic]",
    "[tools]",
    "fake_basic = true",
    "\"\"\"",
    "literal = '''",
    "[mcp_servers.fake_literal]",
    "[tools]",
    "fake_literal = true",
    "'''",
    "[mcp_servers.real]",
    "command = 'real-command'",
    "[tools]",
    "web_search = true",
  ].join("\n");

  assert.deepEqual(parseCodexMcpNamesText(config), ["real"]);
  assert.deepEqual(parseCodexEnabledToolNamesText(config), ["web_search"]);
});

test("unresolved UUID connector tool heads are omitted, but an explicit alias can resolve one", () => {
  const uuid = "019ff47c-eb10-7d21-abb1-a610d171b303";
  assert.equal(parseInventoryTool(`mcp__${uuid}__vault_read`), null);
  assert.deepEqual(
    parseInventoryTool(`mcp__${uuid}__vault_read`, { [uuid]: "obsidian" }),
    {
      name: "mcp__obsidian__vault_read",
      label: "obsidian / vault_read",
      connector: "obsidian",
      tool: "vault_read",
    },
  );
  assert.deepEqual(parseInventoryTool("Bash(git status)"), {
    name: "Bash",
    label: "Bash",
    connector: null,
    tool: null,
  });
  assert.equal(parseInventoryTool("Bearer abcdefghijklmnopqrstuvwxyz123456"), null,
    "a credential-shaped permission entry cannot become a tool name");
});

test("normalization is deterministic and preserves separately observed truth", () => {
  const input = [
    {
      kind: "mcp", name: "Obsidian", source: "Claude MCP configuration",
      configured: true, available: null, runtimeConnected: null,
    },
    {
      kind: "mcp", name: "obsidian", source: "Codex MCP configuration",
      configured: true, available: true, runtimeConnected: null,
    },
    {
      kind: "skill", name: "Research", source: "Claude skill directory",
      configured: null, available: true, runtimeConnected: null,
    },
  ];

  const first = normalizeInventory(input);
  const second = normalizeInventory(input.slice().reverse());
  assert.deepEqual(first, second, "input traversal order cannot change the report");
  assert.deepEqual(first.map((row) => row.key), ["mcp:obsidian", "skill:research"]);
  assert.deepEqual(first[0].sources, ["Claude MCP configuration", "Codex MCP configuration"]);
  assert.equal(first[0].configured, true);
  assert.equal(first[0].available, true);
  assert.equal(first[0].runtimeConnected, null, "configuration is not a runtime probe");
});

test("proposal rows are deterministic, reversible decisions with a blank operator column", () => {
  const records = [
    { kind: "plugin", name: "off@market", source: "settings", configured: true, available: null, runtimeConnected: null, enabled: false },
    { kind: "plugin", name: "off@market", source: "registry", configured: null, available: true, runtimeConnected: null, enabled: null },
    { kind: "skill", name: "research", source: "Claude", configured: null, available: true, runtimeConnected: null },
    { kind: "skill", name: "research", source: "Shared", configured: null, available: true, runtimeConnected: null },
    { kind: "skill", name: "research-alias", source: "Legacy", configured: null, available: true, runtimeConnected: null, duplicateOf: "skill:research" },
    { kind: "mcp", name: "codegraph", source: "Codex", configured: true, available: null, runtimeConnected: null },
  ];
  const proposal = buildConsolidationProposal(records, { curatedKeys: ["mcp:codegraph"] });
  assert.equal(proposal.schemaVersion, 1);
  assert.deepEqual(proposal.rows.map((row) => row.key), ["mcp:codegraph", "plugin:off@market", "skill:research", "skill:research-alias"]);
  assert.deepEqual(proposal.rows.map((row) => row.recommendation), ["keep", "archive", "review", "merge"]);
  assert.equal(proposal.rows.find((row) => row.key === "skill:research").duplicateOf, null);
  assert.equal(proposal.rows.find((row) => row.key === "skill:research-alias").duplicateOf, "skill:research");
  assert.ok(proposal.rows.every((row) => row.operatorDecision === ""));
  assert.match(proposal.rows.find((row) => row.key === "plugin:off@market").reason, /Operator-review recommendation only/);
  assert.match(proposal.rows.find((row) => row.key === "skill:research").reason, /may be intentional/);
  assert.doesNotMatch(JSON.stringify(proposal), /generatedAt|timestamp/i, "the same inventory must produce byte-stable output");

  const markdown = renderConsolidationMarkdown(proposal);
  assert.match(markdown, /\| Key \| Sources \| Configured \| Available \| Runtime connected \| Duplicate of \| Recommendation \| Reason \| Operator decision \|/);
  assert.match(markdown, /\| mcp:codegraph .*\| keep \|/);
  assert.match(markdown, /\| plugin:off@market .*\| archive \|/);
});
