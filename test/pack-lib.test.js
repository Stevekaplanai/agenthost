// Unit tests for the pure pack functions (scripts/pack-lib.mjs). No filesystem,
// no network -- these are the fast tests G2 asked for on the pack/transform module.
// Run: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EXCLUDE_NAME_RE,
  scrubAndTranslate, translateValue, classifyMcpServer, scanMcpConfig, REDACTED,
} from "../scripts/pack-lib.mjs";

function freshReport() {
  return { redactedSecrets: [], mcp: [] };
}

test("translateValue rewrites a home-relative path to the cloud home", () => {
  const stats = { translated: 0, nonHome: [] };
  const out = translateValue("C:\\Users\\Steve\\.claude\\skills", ["C:\\Users\\Steve"], "/data/home/agent", stats);
  assert.equal(out, "/data/home/agent/.claude/skills");
  assert.equal(stats.translated, 1);
});

test("translateValue flags an absolute Windows path outside home, unchanged", () => {
  const stats = { translated: 0, nonHome: [] };
  const out = translateValue("D:\\other\\project", ["C:\\Users\\Steve"], "/data/home/agent", stats);
  assert.equal(out, "D:\\other\\project");
  assert.equal(stats.translated, 0);
  assert.equal(stats.nonHome.length, 1);
});

test("translateValue leaves URLs alone (scheme guard, not a drive letter)", () => {
  const stats = { translated: 0, nonHome: [] };
  const out = translateValue("https://example.com/foo", ["C:\\Users\\Steve"], "/data/home/agent", stats);
  assert.equal(out, "https://example.com/foo");
  assert.equal(stats.nonHome.length, 0);
});

test("scrubAndTranslate redacts every leaf of an env block", () => {
  const report = freshReport();
  const stats = { translated: 0, nonHome: [] };
  const input = { mcpServers: { x: { env: { FIRECRAWL_API_KEY: "fc-realvalue1234567890" } } } };
  const out = scrubAndTranslate(input, "test", "", stats, [], "/data/home/agent", report);
  assert.equal(out.mcpServers.x.env.FIRECRAWL_API_KEY, REDACTED);
  assert.equal(report.redactedSecrets.length, 1);
});

test("scrubAndTranslate redacts headers blocks the same as env blocks", () => {
  const report = freshReport();
  const stats = { translated: 0, nonHome: [] };
  const input = { headers: { Authorization: "Bearer sometoken" } };
  const out = scrubAndTranslate(input, "test", "", stats, [], "/data/home/agent", report);
  assert.equal(out.headers.Authorization, REDACTED);
});

test("scrubAndTranslate redacts key-shaped fields with substantial values", () => {
  const report = freshReport();
  const stats = { translated: 0, nonHome: [] };
  const input = { apiKey: "sk-ant-api03-abcdefghijklmnopqrstuvwx" };
  const out = scrubAndTranslate(input, "test", "", stats, [], "/data/home/agent", report);
  assert.equal(out.apiKey, REDACTED);
});

test("scrubAndTranslate leaves short key-shaped values alone (below the 12-char floor)", () => {
  const report = freshReport();
  const stats = { translated: 0, nonHome: [] };
  const input = { token: "short" };
  const out = scrubAndTranslate(input, "test", "", stats, [], "/data/home/agent", report);
  assert.equal(out.token, "short");
  assert.equal(report.redactedSecrets.length, 0);
});

test("scrubAndTranslate redacts a high-confidence secret shape even under a plain key name", () => {
  const report = freshReport();
  const stats = { translated: 0, nonHome: [] };
  const input = { note: "sk-ant-api03-abcdefghijklmnopqrstuvwx" };
  const out = scrubAndTranslate(input, "test", "", stats, [], "/data/home/agent", report);
  assert.equal(out.note, REDACTED);
});

test("scrubAndTranslate never mutates non-config values that merely look path-like", () => {
  const report = freshReport();
  const stats = { translated: 0, nonHome: [] };
  const input = { pattern: "^[A-Za-z]:\\\\foo$" }; // a regex string, not a real path
  const out = scrubAndTranslate(input, "test", "", stats, ["C:\\Users\\Steve"], "/data/home/agent", report);
  assert.equal(out.pattern, input.pattern);
});

test("classifyMcpServer disables localhost servers", () => {
  assert.match(classifyMcpServer({ url: "http://127.0.0.1:27124" }), /^DISABLED/);
  assert.match(classifyMcpServer({ url: "http://localhost:3000" }), /^DISABLED/);
});

test("classifyMcpServer flags an absolute Windows command path", () => {
  assert.match(classifyMcpServer({ command: "C:\\tools\\server.exe" }), /^FLAGGED/);
});

test("classifyMcpServer accepts remote URLs and package-managed commands as portable", () => {
  assert.match(classifyMcpServer({ url: "https://mcp.example.com" }), /^PORTABLE/);
  assert.match(classifyMcpServer({ command: "npx" }), /^PORTABLE/);
  assert.match(classifyMcpServer({ command: "uvx" }), /^PORTABLE/);
});

test("classifyMcpServer sends unknown commands to REVIEW rather than silently trusting them", () => {
  assert.match(classifyMcpServer({ command: "/usr/local/bin/custom-server" }), /^REVIEW/);
});

test("scanMcpConfig walks an mcpServers map and appends one verdict per server", () => {
  const report = { mcp: [] };
  scanMcpConfig("settings.json", { mcpServers: { a: { url: "http://localhost:1" }, b: { command: "npx" } } }, report);
  assert.equal(report.mcp.length, 2);
  assert.equal(report.mcp[0].name, "a");
  assert.match(report.mcp[0].verdict, /^DISABLED/);
});

test("STALE_PATH_RE catches WSL /mnt/<drive>/ paths as well as drive letters", async () => {
  const { STALE_PATH_RE, WSLPATH_RE } = await import("../scripts/pack-lib.mjs");
  assert.ok(WSLPATH_RE.test("/mnt/c/Users/User/Projects/claimflow"));
  assert.ok(STALE_PATH_RE.test("/mnt/c/Users/User/Projects/claimflow"));
  assert.ok(STALE_PATH_RE.test("C:\\Users\\User\\other"));
  assert.ok(!STALE_PATH_RE.test("https://example.com/mnt-agent"));
  assert.ok(!STALE_PATH_RE.test("/data/home/agent/work"));
});

test("translateValue flags WSL mount paths into nonHome instead of silently passing them", () => {
  const stats = { translated: 0, nonHome: [] };
  const out = translateValue("/mnt/c/Users/User/Projects/x", ["/home/sk777"], "/data/home/agent", stats);
  assert.equal(out, "/mnt/c/Users/User/Projects/x");
  assert.equal(stats.nonHome.length, 1);
});

test("translateValue still translates a WSL home dir when the packer runs inside WSL", () => {
  const stats = { translated: 0, nonHome: [] };
  const out = translateValue("/home/sk777/.claude/skills", ["/home/sk777"], "/data/home/agent", stats);
  assert.equal(out, "/data/home/agent/.claude/skills");
  assert.equal(stats.translated, 1);
});

test("extractCloudHomePaths finds every cloud path in hook commands, deduped", async () => {
  const { extractCloudHomePaths } = await import("../scripts/pack-lib.mjs");
  const hooks = {
    Stop: [{ matcher: "*", hooks: [
      { type: "command", command: "python /data/home/agent/Projects/operator-brain/capture.py --from-hook" },
      { type: "command", command: "python /data/home/agent/Projects/operator-brain/capture.py --again" },
      { type: "command", command: "bash /data/home/agent/.claude/skills/x/hook.sh" },
    ]}],
  };
  const out = extractCloudHomePaths(hooks, "/data/home/agent");
  assert.deepEqual(out.sort(), [
    "/data/home/agent/.claude/skills/x/hook.sh",
    "/data/home/agent/Projects/operator-brain/capture.py",
  ]);
});

test("extractCloudHomePaths tolerates missing/empty hooks", async () => {
  const { extractCloudHomePaths } = await import("../scripts/pack-lib.mjs");
  assert.deepEqual(extractCloudHomePaths(undefined, "/data/home/agent"), []);
  assert.deepEqual(extractCloudHomePaths({}, "/data/home/agent"), []);
});

test("EXCLUDE_NAME_RE catches credential-shaped filenames the exact-name set misses", () => {
  assert.ok(EXCLUDE_NAME_RE.test(".credentials.json.bak-supabase"));
  assert.ok(EXCLUDE_NAME_RE.test("credentials.json.old"));
  assert.ok(EXCLUDE_NAME_RE.test("my-credentials-backup.txt"));
  assert.ok(EXCLUDE_NAME_RE.test(".CREDENTIALS.json"));
  assert.ok(!EXCLUDE_NAME_RE.test("settings.json"));
  assert.ok(!EXCLUDE_NAME_RE.test("CLAUDE.md"));
});
