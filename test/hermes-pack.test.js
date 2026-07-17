// Tests for the Hermes migration (Manifest v2): the three pure config-surgery
// helpers in scripts/pack-lib.mjs plus an end-to-end pack.mjs run against a
// fixture home dir. No network; the e2e builds a throwaway HOME under tmpdir.
// Run: node --test test/hermes-pack.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACK_MJS = path.join(REPO_ROOT, "scripts", "pack.mjs");

// pack-lib.mjs's Hermes helpers may be landing concurrently with this suite;
// poll the import for up to 3 minutes before declaring them missing. The
// query-string cache-buster makes Node re-read the file on every attempt.
async function importPackLib() {
  const need = ["redactHermesConfigYaml", "disableWindowsMcpBlocks", "redactEnvFile", "REDACTED"];
  const deadline = Date.now() + 3 * 60 * 1000;
  let lastErr;
  for (;;) {
    try {
      const mod = await import(`../scripts/pack-lib.mjs?t=${Date.now()}`);
      const missing = need.filter((n) => mod[n] === undefined);
      if (missing.length === 0) return mod;
      lastErr = new Error(`pack-lib.mjs is missing exports: ${missing.join(", ")}`);
    } catch (e) {
      lastErr = e;
    }
    if (Date.now() > deadline) throw lastErr;
    await new Promise((r) => setTimeout(r, 5000));
  }
}
const { redactHermesConfigYaml, disableWindowsMcpBlocks, redactEnvFile, REDACTED } = await importPackLib();

function freshReport() {
  return { redactedSecrets: [], mcp: [], flags: [] };
}

// ---- redactHermesConfigYaml ---------------------------------------------------

const REDACT_YAML = [
  "agent:",
  "  model: claude-fable-5",
  "mcp_servers:",
  "  github:",
  "    command: npx",
  "    args: ['-y', '@modelcontextprotocol/server-github', 'GITHUB_PERSONAL_ACCESS_TOKEN=gh"+"p_UnitAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '--stdio']",
  "    enabled: true",
  "http:",
  "  headers:",
  "    Authorization: Bearer unit-gateway-secret-9911",
  "vision:",
  "  provider: openai",
  "  api_key: unit-vision-secret-key",
  "  model: gpt-4o-mini",
  "notes:",
  "  api_key: outside-vision-untouched",
  "  leftover: sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA",
].join("\n");

test("redactHermesConfigYaml redacts the GitHub PAT inside an args list through the quote boundary", () => {
  const report = freshReport();
  const out = redactHermesConfigYaml(REDACT_YAML, report);
  assert.ok(!out.includes("ghp_Unit"), "raw PAT must be gone");
  assert.ok(out.includes(`GITHUB_PERSONAL_ACCESS_TOKEN=${REDACTED}`), "key= prefix kept, value replaced");
  // The value is redacted only up to the closing quote: the rest of the args list survives.
  assert.ok(out.includes(`GITHUB_PERSONAL_ACCESS_TOKEN=${REDACTED}', '--stdio']`), "quote/bracket boundary preserved");
});

test("redactHermesConfigYaml redacts Authorization header values but keeps the key", () => {
  const report = freshReport();
  const out = redactHermesConfigYaml(REDACT_YAML, report);
  assert.ok(!out.includes("unit-gateway-secret-9911"), "raw header value must be gone");
  assert.ok(out.includes(`Authorization: ${REDACTED}`), "Authorization key survives with redacted value");
});

test("redactHermesConfigYaml redacts every api_key (safer than vision-only)", () => {
  const report = freshReport();
  const out = redactHermesConfigYaml(REDACT_YAML, report);
  assert.ok(!out.includes("unit-vision-secret-key"), "vision api_key value must be gone");
  assert.ok(out.includes(`api_key: ${REDACTED}`), "api_key redacted in place");
  // Hardened per the leak audit: an api_key ANYWHERE is a secret carrier, so
  // it is redacted regardless of block -- not left "untouched outside vision".
  assert.ok(!out.includes("outside-vision-untouched"), "api_key outside vision is now also redacted");
});

test("redactHermesConfigYaml catches leftover secret shapes anywhere via SECRET_SHAPES", () => {
  const report = freshReport();
  const out = redactHermesConfigYaml(REDACT_YAML, report);
  assert.ok(!out.includes("sk-ant-"), "sk-ant-style key must be redacted even outside the targeted rules");
});

test("redactHermesConfigYaml pushes a config.yaml report entry per redaction", () => {
  const report = freshReport();
  redactHermesConfigYaml(REDACT_YAML, report);
  const rs = report.redactedSecrets;
  assert.ok(rs.length >= 4, `expected >=4 entries (PAT, Authorization, vision api_key, sk-ant shape), got ${rs.length}`);
  assert.ok(rs.every((e) => e.startsWith("config.yaml:")), `every entry is 'config.yaml: <what>' -- got ${JSON.stringify(rs)}`);
  assert.ok(rs.some((e) => e.includes("GITHUB_PERSONAL_ACCESS_TOKEN")));
  assert.ok(rs.some((e) => /authorization/i.test(e)));
  assert.ok(rs.some((e) => /vision|api_key/i.test(e)));
});

// ---- disableWindowsMcpBlocks ----------------------------------------------------

const MCP_YAML = [
  "log_level: info",
  "mcp_servers:",
  "  windows-mcp:",
  "    command: /mnt/c/Users/steve/tools/windows-mcp/run.sh",
  "    enabled: true",
  "  github:",
  "    command: npx",
  "    args: ['-y', '@modelcontextprotocol/server-github']",
  "    enabled: true",
  "gateway:",
  "  port: 3000",
].join("\n");

function blockOf(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  assert.ok(start >= 0, `marker ${startMarker.trim()} present`);
  const end = endMarker ? text.indexOf(endMarker) : text.length;
  assert.ok(end > start, `marker ${String(endMarker).trim()} follows ${startMarker.trim()}`);
  return text.slice(start, end);
}

test("disableWindowsMcpBlocks disables a /mnt/<drive> server and leaves the npx server enabled", () => {
  const report = freshReport();
  const out = disableWindowsMcpBlocks(MCP_YAML, report);
  const win = blockOf(out, "\n  windows-mcp:", "\n  github:");
  const github = blockOf(out, "\n  github:", "\ngateway:");
  assert.match(win, /enabled: false/, "windows-mcp block gets enabled: false");
  assert.ok(!/enabled: true/.test(win), "windows-mcp block keeps no enabled: true line");
  assert.match(github, /enabled: true/, "github (npx) block keeps enabled: true");
  // Non-mcp content is untouched (line surgery only):
  assert.ok(out.includes("log_level: info") && out.includes("  port: 3000"));
});

test("disableWindowsMcpBlocks also disables drive-letter command paths", () => {
  const report = freshReport();
  const yaml = [
    "mcp_servers:",
    "  win-native:",
    "    command: C:\\Tools\\mcp\\server.exe",
    "    enabled: true",
  ].join("\n");
  const out = disableWindowsMcpBlocks(yaml, report);
  assert.match(out, /enabled: false/);
  assert.ok(report.mcp.some((m) => m.name === "win-native" && m.verdict.startsWith("DISABLED")));
});

test("disableWindowsMcpBlocks records the spec verdicts", () => {
  const report = freshReport();
  disableWindowsMcpBlocks(MCP_YAML, report);
  const win = report.mcp.find((m) => m.name === "windows-mcp");
  assert.ok(win, "windows-mcp gets a report.mcp entry");
  assert.equal(win.source, "hermes config.yaml");
  assert.equal(win.verdict, "DISABLED: Windows path, unreachable from the cloud");
  const github = report.mcp.find((m) => m.name === "github");
  assert.ok(github, "github gets a report.mcp entry");
  assert.match(github.verdict, /^PORTABLE/);
});

// ---- redactEnvFile ---------------------------------------------------------------

const ENV_TEXT = [
  "# hermes credentials -- keep out of git",
  "TELEGRAM_BOT_TOKEN=7712345678:AA-unit-telegram-token",
  "",
  "OPENAI_API_KEY=sk-unit-openai",
  "BRAVE_SEARCH_KEY=BSA-unit-brave",
].join("\n");

test("redactEnvFile redacts every KEY=value, leaves comments and blank lines, returns keys", () => {
  const report = freshReport();
  const { text, keys } = redactEnvFile(ENV_TEXT, report);
  assert.deepEqual(keys, ["TELEGRAM_BOT_TOKEN", "OPENAI_API_KEY", "BRAVE_SEARCH_KEY"]);
  const lines = text.split("\n");
  assert.equal(lines[0], "# hermes credentials -- keep out of git", "comment untouched");
  assert.equal(lines[1], `TELEGRAM_BOT_TOKEN=${REDACTED}`);
  assert.equal(lines[2], "", "blank line untouched");
  assert.equal(lines[3], `OPENAI_API_KEY=${REDACTED}`);
  assert.equal(lines[4], `BRAVE_SEARCH_KEY=${REDACTED}`);
  assert.ok(!text.includes("AA-unit-telegram-token") && !text.includes("sk-unit-openai") && !text.includes("BSA-unit-brave"));
});

test("redactEnvFile points each key at its HERMESENV_ Fly secret in the report", () => {
  const report = freshReport();
  redactEnvFile(ENV_TEXT, report);
  for (const k of ["TELEGRAM_BOT_TOKEN", "OPENAI_API_KEY", "BRAVE_SEARCH_KEY"]) {
    assert.ok(
      report.redactedSecrets.includes(`hermes .env: ${k} (re-provide as Fly secret HERMESENV_${k})`),
      `report entry for ${k} -- got ${JSON.stringify(report.redactedSecrets)}`,
    );
  }
});

// ---- end-to-end: pack.mjs --agent hermes on a fixture home ------------------------

const FIXTURE_CONFIG_YAML = [
  "agent:",
  "  name: hermes-fixture",
  "mcp_servers:",
  "  github:",
  "    command: npx",
  "    args: ['-y', '@modelcontextprotocol/server-github', 'GITHUB_PERSONAL_ACCESS_TOKEN=gh"+"p_FIXTUREaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']",
  "    enabled: true",
  "  windows-mcp:",
  "    command: /mnt/c/Users/steve/tools/windows-mcp/run.sh",
  "    enabled: true",
  "gateway:",
  "  headers:",
  "    Authorization: Bearer fixture-gateway-secret-1234",
  "vision:",
  "  provider: openai",
  "  api_key: fixture-vision-secret-5678",
  "  model: gpt-4o-mini",
  "",
].join("\n");

const FIXTURE_ENV = [
  "# fixture hermes env -- 3 keys, 1 comment",
  "TELEGRAM_BOT_TOKEN=7712345678:AA-fixture-telegram-token",
  "OPENAI_API_KEY=sk-fixture-openai",
  "GEMINI_API_KEY=AIzaSyFixtureGemini",
  "",
].join("\n");

function writeTree(root, tree) {
  for (const [rel, content] of Object.entries(tree)) {
    const p = path.join(root, ...rel.split("/"));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
}

function makeFixtureHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-hermes-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  writeTree(home, {
    ".claude/settings.json": JSON.stringify({ model: "claude-fable-5" }, null, 2) + "\n",
    ".hermes/config.yaml": FIXTURE_CONFIG_YAML,
    ".hermes/.env": FIXTURE_ENV,
    ".hermes/SOUL.md": "# Soul\nBe useful.\n",
    ".hermes/skills/a/SKILL.md": "# skill a\n",
    ".hermes/memories/MEMORY.md": "# memory\n",
    ".hermes/whatsapp/session/creds.json": JSON.stringify({ session: "wa-fixture" }),
    // Junk that must never be staged:
    ".hermes/state.db": "sqlite-fixture-bytes",
    ".hermes/gateway.pid": "12345\n",
    ".hermes/cache/x": "cached",
    ".hermes/config.yaml.bak-1": FIXTURE_CONFIG_YAML,
    ".hermes/hermes-agent/big.bin": "fake-venv-payload",
  });
  return home;
}

function runPack(t, home, extraArgs = []) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-hermes-out-"));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const res = spawnSync(
    process.execPath,
    [PACK_MJS, "--out", out, "--dry-run", "--agent", "hermes", ...extraArgs],
    // USERPROFILE so the fixture home also wins when this suite runs on Windows.
    { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: "utf8" },
  );
  assert.equal(res.status, 0, `pack.mjs exited ${res.status}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  return out;
}

test("end-to-end: pack.mjs --agent hermes with default flags", async (t) => {
  const home = makeFixtureHome(t);
  const out = runPack(t, home);
  const staged = path.join(out, "staging", ".hermes");

  await t.test("staged tree contains exactly the manifest includes", () => {
    assert.ok(fs.existsSync(staged), `staged .hermes exists at ${staged}`);
    assert.deepEqual(
      fs.readdirSync(staged).sort(),
      [".env", "SOUL.md", "config.yaml", "memories", "skills"].sort(),
      "exactly the include-list entries present in the fixture, nothing else",
    );
    assert.ok(fs.existsSync(path.join(staged, "skills", "a", "SKILL.md")));
    assert.ok(fs.existsSync(path.join(staged, "memories", "MEMORY.md")));
  });

  await t.test("junk excluded and whatsapp absent by default", () => {
    for (const junk of ["state.db", "gateway.pid", "cache", "config.yaml.bak-1", "hermes-agent", "whatsapp"]) {
      assert.ok(!fs.existsSync(path.join(staged, junk)), `${junk} must not be staged`);
    }
  });

  await t.test("staged config.yaml redacted + windows MCP disabled; raw fixture untouched", () => {
    const cfg = fs.readFileSync(path.join(staged, "config.yaml"), "utf8");
    assert.ok(!cfg.includes("ghp_FIXTURE"), "GitHub PAT redacted");
    assert.ok(!cfg.includes("fixture-gateway-secret-1234"), "Authorization value redacted");
    assert.ok(!cfg.includes("fixture-vision-secret-5678"), "vision api_key redacted");
    assert.ok(cfg.includes(REDACTED), "REDACTED sentinel present");
    const win = blockOf(cfg, "\n  windows-mcp:", "\ngateway:");
    assert.match(win, /enabled: false/, "windows-mcp disabled in the staged copy");
    const github = blockOf(cfg, "\n  github:", "\n  windows-mcp:");
    assert.match(github, /enabled: true/, "portable github server stays enabled");
    const raw = fs.readFileSync(path.join(home, ".hermes", "config.yaml"), "utf8");
    assert.equal(raw, FIXTURE_CONFIG_YAML, "source config.yaml byte-identical (staged copy only is mutated)");
  });

  await t.test("staged .env fully redacted; raw fixture untouched", () => {
    const env = fs.readFileSync(path.join(staged, ".env"), "utf8");
    assert.ok(env.includes("# fixture hermes env"), "comment survives");
    for (const k of ["TELEGRAM_BOT_TOKEN", "OPENAI_API_KEY", "GEMINI_API_KEY"]) {
      assert.ok(env.includes(`${k}=${REDACTED}`), `${k} value redacted`);
    }
    assert.ok(!env.includes("AA-fixture-telegram-token") && !env.includes("sk-fixture-openai") && !env.includes("AIzaSyFixtureGemini"));
    assert.equal(fs.readFileSync(path.join(home, ".hermes", ".env"), "utf8"), FIXTURE_ENV, "source .env untouched");
  });

  await t.test("manifest.json names the .env keys and config.yaml secret carriers", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
    const rs = manifest.redactedSecrets;
    for (const k of ["TELEGRAM_BOT_TOKEN", "OPENAI_API_KEY", "GEMINI_API_KEY"]) {
      assert.ok(rs.some((e) => e.includes(`HERMESENV_${k}`)), `redactedSecrets points ${k} at HERMESENV_${k}`);
    }
    assert.ok(rs.some((e) => e.includes("config.yaml") && e.includes("GITHUB_PERSONAL_ACCESS_TOKEN")));
    assert.ok(rs.some((e) => e.includes("config.yaml") && /authorization/i.test(e)));
    assert.ok(rs.some((e) => e.includes("config.yaml") && /vision|api_key/i.test(e)));
    assert.ok(
      manifest.mcp.some((m) => m.source === "hermes config.yaml" && m.name === "windows-mcp"
        && m.verdict === "DISABLED: Windows path, unreachable from the cloud"),
      `windows-mcp DISABLED verdict in manifest.mcp -- got ${JSON.stringify(manifest.mcp)}`,
    );
  });

  await t.test("compat report has the Hermes section with the spec-mandated notes", () => {
    const rpt = fs.readFileSync(path.join(out, "compat-report.md"), "utf8");
    assert.ok(rpt.includes("## Hermes"), "report has a ## Hermes section");
    assert.match(rpt, /WhatsApp session not migrated/i, "whatsapp-off note (fresh QR from the cloud box)");
    assert.match(rpt, /kanban/i, "kanban-off note (fresh kanban.db on the box)");
    assert.match(rpt, /computer_use/, "computer_use headless warning");
    assert.match(rpt, /hermes gateway status/, "post-boot verification pointer");
  });
});

test("end-to-end: --with-whatsapp stages the whatsapp directory", (t) => {
  const home = makeFixtureHome(t);
  const out = runPack(t, home, ["--with-whatsapp"]);
  const staged = path.join(out, "staging", ".hermes");
  assert.ok(fs.existsSync(path.join(staged, "whatsapp", "session", "creds.json")),
    "whatsapp session staged when --with-whatsapp is passed");
  // Junk stays excluded even with the optional payload on:
  assert.ok(!fs.existsSync(path.join(staged, "state.db")));
});
