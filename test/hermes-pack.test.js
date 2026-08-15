// Tests for the Hermes migration (Manifest v2). No network; the e2e builds a
// throwaway HOME under tmpdir.
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
    ".hermes/auth.json": JSON.stringify({ oauth: "opaque-hermes-credential-pool" }),
    ".hermes/skills/a/SKILL.md": "# skill a\n",
    ".hermes/memories/MEMORY.md": "# memory\n",
    ".hermes/whatsapp/session/creds.json": JSON.stringify({ session: "wa-fixture" }),
    ".hermes/pairing/user-pending.json": JSON.stringify({ code: "opaque-pairing-code" }),
    ".hermes/pairing/approved/device.json": JSON.stringify({ device: "opaque-device-state" }),
    ".hermes/kanban.db": "safe-fixture-kanban",
    // Junk that must never be staged:
    ".hermes/state.db": "sqlite-fixture-bytes",
    ".hermes/STATE.DB": "mixed-case-sqlite-fixture-bytes",
    ".hermes/gateway.pid": "12345\n",
    ".hermes/cache/x": "cached",
    ".hermes/Cache/x": "mixed-case-cached",
    ".hermes/config.yaml.bak-1": FIXTURE_CONFIG_YAML,
    ".hermes/hermes-agent/big.bin": "fake-venv-payload",
  });
  return home;
}

function runPackRaw(t, home, extraArgs = [], hermesHome = path.join(home, ".hermes")) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-hermes-out-"));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const res = spawnSync(
    process.execPath,
    [PACK_MJS, "--out", out, "--dry-run", "--agent", "hermes", ...extraArgs],
    // USERPROFILE so the fixture home also wins when this suite runs on Windows.
    {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        HERMES_HOME: hermesHome,
      },
      encoding: "utf8",
    },
  );
  return { out, res };
}

test("dedicated Hermes roots check sensitive files inside the root, not parent-directory names", async (t) => {
  const home = makeFixtureHome(t);
  const cases = [
    {
      name: "external Hermes home (WSL/UNC shape)",
      root: fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-external-hermes-")),
    },
    {
      name: "Hermes under Windows LocalAppData",
      root: path.join(home, "AppData", "Local", "hermes"),
    },
  ];
  t.after(() => fs.rmSync(cases[0].root, { recursive: true, force: true }));

  for (const fixture of cases) {
    await t.test(fixture.name, () => {
      writeTree(fixture.root, {
        "config.yaml": "agent:\n  name: fixture\n",
        "SOUL.md": "# safe Hermes identity\n",
        "plugins/fixture/index.js": "export const fixture = true;\n",
        "plugins/fixture/.env": "SERVICE_TOKEN=opaque-nested-env\n",
        "plugins/fixture/development.env": "SERVICE_TOKEN=opaque-extension-env\n",
        "plugins/fixture/client.pem": "opaque-private-key-file\n",
        "plugins/fixture/.ssh/id_ed25519": "opaque-ssh-key\n",
      });
      const { out, res } = runPackRaw(t, home, [], fixture.root);
      assert.equal(
        res.status,
        0,
        `pack.mjs exited ${res.status}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
      );
      const staged = path.join(out, "staging", ".hermes");
      assert.ok(fs.existsSync(path.join(staged, "SOUL.md")), "safe root file migrates");
      assert.ok(
        fs.existsSync(path.join(staged, "plugins", "fixture", "index.js")),
        "safe nested source migrates",
      );
      for (const rel of [
        "plugins/fixture/.env",
        "plugins/fixture/development.env",
        "plugins/fixture/client.pem",
        "plugins/fixture/.ssh",
      ]) {
        assert.ok(
          !fs.existsSync(path.join(staged, ...rel.split("/"))),
          `${rel} remains local`,
        );
      }
    });
  }
});

function runPack(t, home, extraArgs = []) {
  const { out, res } = runPackRaw(t, home, extraArgs);
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
      ["SOUL.md", "memories", "skills"].sort(),
      "exactly the include-list entries present in the fixture, nothing else",
    );
    assert.ok(fs.existsSync(path.join(staged, "skills", "a", "SKILL.md")));
    assert.ok(fs.existsSync(path.join(staged, "memories", "MEMORY.md")));
  });

  await t.test("junk excluded and whatsapp absent by default", () => {
    for (const junk of [
      "auth.json",
      ".env",
      "state.db",
      "STATE.DB",
      "gateway.pid",
      "cache",
      "Cache",
      "config.yaml",
      "config.yaml.bak-1",
      "hermes-agent",
      "whatsapp",
      "pairing",
      "kanban.db",
    ]) {
      assert.ok(!fs.existsSync(path.join(staged, junk)), `${junk} must not be staged`);
    }
  });

  await t.test("config.yaml is omitted fail-closed and the raw fixture remains untouched", () => {
    assert.ok(!fs.existsSync(path.join(staged, "config.yaml")), "config.yaml is never staged without a real YAML parser");
    const raw = fs.readFileSync(path.join(home, ".hermes", "config.yaml"), "utf8");
    assert.equal(raw, FIXTURE_CONFIG_YAML, "source config.yaml remains byte-identical");
  });

  await t.test("Hermes .env is never staged or rewritten", () => {
    assert.ok(!fs.existsSync(path.join(staged, ".env")), "credential file stays out of staging");
    assert.equal(fs.readFileSync(path.join(home, ".hermes", ".env"), "utf8"), FIXTURE_ENV, "source .env untouched");
  });

  await t.test("manifest.json records .env and config.yaml as excluded without reading secret values", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
    assert.ok(
      manifest.excluded.some((entry) => entry.replaceAll("\\", "/").endsWith(".hermes/.env")),
      `Hermes .env appears in the excluded list: ${JSON.stringify(manifest.excluded)}`,
    );
    assert.ok(!JSON.stringify(manifest).includes("AA-fixture-telegram-token"), "manifest never contains a local env value");
    assert.ok(
      manifest.excluded.some((entry) => entry.replaceAll("\\", "/").endsWith(".hermes/config.yaml")),
      `config.yaml appears in the excluded list: ${JSON.stringify(manifest.excluded)}`,
    );
    assert.ok(
      manifest.flags.some((flag) => /Hermes config\.yaml.*not migrated.*full parser/i.test(flag)),
      `config omission is explained: ${JSON.stringify(manifest.flags)}`,
    );
    assert.ok(
      manifest.flags.some((flag) => /Hermes \.env not migrated.*does not read credential files/i.test(flag)),
      `env omission is explained: ${JSON.stringify(manifest.flags)}`,
    );
  });

  await t.test("compat report has the Hermes section with the spec-mandated notes", () => {
    const rpt = fs.readFileSync(path.join(out, "compat-report.md"), "utf8");
    assert.ok(rpt.includes("## Hermes"), "report has a ## Hermes section");
    assert.match(rpt, /WhatsApp session not migrated/i, "whatsapp-off note (fresh QR from the cloud box)");
    assert.match(rpt, /Hermes auth.*not migrated|sign in.*Hermes/i, "Hermes auth omission and re-auth note");
    assert.match(rpt, /Hermes \.env not migrated/i, "Hermes local credential file stays local");
    assert.match(rpt, /pairing.*not migrated|pair.*again/i, "channel pairing must be repeated on the box");
    assert.match(rpt, /config\.yaml.*not migrated|recreate.*config/i, "Hermes config must be recreated on the box");
    assert.match(rpt, /kanban/i, "kanban-off note (fresh kanban.db on the box)");
    assert.match(rpt, /computer_use/, "computer_use headless warning");
    assert.match(rpt, /hermes gateway status/, "post-boot verification pointer");
  });
});

test("raw credential-migration flags are rejected before any staging work begins", async (t) => {
  const home = makeFixtureHome(t);
  for (const flag of [
    "--with-whatsapp",
    "--with-whatsapp=true",
    "--migrate-auth",
    "--migrate-auth=true",
    "--hermes-secrets-from-local",
    "--hermes-secrets-from-local=true",
  ]) {
    await t.test(flag, () => {
      const { out, res } = runPackRaw(t, home, [flag]);
      assert.notEqual(
        res.status,
        0,
        `${flag} must be rejected because WhatsApp session files never migrate`,
      );
      assert.ok(
        !fs.existsSync(path.join(out, "staging")),
        `${flag} must be rejected before the packer creates staging`,
      );
      assert.match(
        `${res.stdout}\n${res.stderr}`,
        /retired.*credential files never migrate|credential files never migrate.*authenticate again/i,
        "the error explains that credential-file migration is unavailable",
      );
    });
  }
});

test("end-to-end: --with-kanban keeps the safe kanban payload without auth or WhatsApp sessions", (t) => {
  const home = makeFixtureHome(t);
  const out = runPack(t, home, ["--with-kanban"]);
  const staged = path.join(out, "staging", ".hermes");
  assert.equal(
    fs.readFileSync(path.join(staged, "kanban.db"), "utf8"),
    "safe-fixture-kanban",
    "the explicitly requested kanban database remains supported",
  );
  assert.ok(!fs.existsSync(path.join(staged, "auth.json")), "Hermes auth.json never stages");
  assert.ok(!fs.existsSync(path.join(staged, "whatsapp")), "WhatsApp session state never stages");
  assert.ok(!fs.existsSync(path.join(staged, "pairing")), "Hermes pairing state never stages");
});
