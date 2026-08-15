// End-to-end guards for credential/session migration invariants.
// These tests drive scripts/pack.mjs in a throwaway home directory so they
// cover the staging tree, manifest/report, archive gate, and raw CLI flags.
// Run: node --test test/pack-security-invariants.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { packFailureMessage, packHarness } from "../src/pack.js";
import { REDACTED } from "../scripts/pack-lib.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACK_MJS = path.join(REPO_ROOT, "scripts", "pack.mjs");

function writeTree(root, tree) {
  for (const [rel, content] of Object.entries(tree)) {
    const target = path.join(root, ...rel.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

function makeHome(t, tree = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-pack-security-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  writeTree(home, {
    ".claude/settings.json": "{}\n",
    ...tree,
  });
  return home;
}

function runPack(t, home, args = []) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-pack-security-out-"));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const res = spawnSync(
    process.execPath,
    [PACK_MJS, "--out", out, "--no-discovery", ...args],
    {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        HERMES_HOME: path.join(home, ".hermes"),
        CODEX_HOME: path.join(home, ".codex"),
        OPENCLAW_HOME: path.join(home, ".openclaw"),
      },
      encoding: "utf8",
    },
  );
  return { out, res };
}

function assertSucceeded(res) {
  assert.equal(
    res.status,
    0,
    `pack.mjs exited ${res.status}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
  );
}

function archiveEntries(out) {
  return execFileSync("tar", ["-tzf", "harness.tar.gz"], {
    cwd: out,
    encoding: "utf8",
  })
    .split(/\r?\n/)
    .map((entry) => entry.trim().replaceAll("\\", "/"))
    .filter(Boolean);
}

test("report-only MCP discovery never copies raw transport values into outputs", (t) => {
  const sentinel = "LEAKCANARY_DISCOVERY_COMMAND";
  const typeSentinel = "LEAKCANARY_DISCOVERY_TYPE";
  const urlSentinel = "LEAKCANARY_DISCOVERY_URL";
  const home = makeHome(t, {
    ".claude.json": JSON.stringify({
      mcpServers: {
        commandFixture: {
          command: `node --token ${sentinel}`,
          args: ["--header", `Authorization: Bearer ${sentinel}`],
          env: { PRIVATE: sentinel },
        },
        typeFixture: { type: typeSentinel },
        urlFixture: { type: "http", url: `https://example.test/mcp?token=${urlSentinel}` },
      },
    }),
  });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-pack-discovery-out-"));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const res = spawnSync(
    process.execPath,
    [PACK_MJS, "--out", out, "--dry-run"],
    {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        HERMES_HOME: path.join(home, ".hermes"),
        CODEX_HOME: path.join(home, ".codex"),
        OPENCLAW_HOME: path.join(home, ".openclaw"),
      },
      encoding: "utf8",
    },
  );
  assertSucceeded(res);

  const manifestText = fs.readFileSync(path.join(out, "manifest.json"), "utf8");
  const reportText = fs.readFileSync(path.join(out, "compat-report.md"), "utf8");
  for (const output of [manifestText, reportText]) {
    assert.ok(!output.includes(sentinel), "raw MCP command/args/env reached a discovery output");
    assert.ok(!output.includes(typeSentinel), "raw MCP type reached a discovery output");
    assert.ok(!output.includes(urlSentinel), "raw MCP URL reached a discovery output");
  }
  const manifest = JSON.parse(manifestText);
  const discovered = new Map(
    manifest.discovered.mcpServers.map((entry) => [entry.name, entry.transport]),
  );
  assert.equal(discovered.get("commandFixture"), "stdio");
  assert.equal(discovered.get("typeFixture"), "unknown");
  assert.equal(discovered.get("urlFixture"), "http");
});

test("pack failure keeps actionable finding paths after temporary reports are cleaned up", (t) => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-pack-failure-message-"));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(out, "manifest.json"),
    JSON.stringify({
      possibleSecrets: [
        ".claude/skills/leaky/SKILL.md (private-key)",
        ".claude/skills/leaky/SKILL.md (private-key)",
      ],
    }),
  );
  const message = packFailureMessage(out, { message: "fixture pack failure" });
  fs.rmSync(out, { recursive: true, force: true });
  assert.match(message, /fixture pack failure/);
  assert.match(message, /\.claude\/skills\/leaky\/SKILL\.md \(private-key\)/);
  assert.equal(
    message.match(/\.claude\/skills\/leaky\/SKILL\.md/g)?.length,
    1,
    "duplicate findings are collapsed before the temporary report disappears",
  );
});

test("explicit --include cannot bypass credential, token, auth, or session exclusions", (t) => {
  const home = makeHome(t, {
    ".claude.json": '{"oauth":"opaque-claude-session"}\n',
    ".codex/auth.json": '{"oauth":"opaque-codex-session"}\n',
    ".codex/sessions/thread.jsonl": '{"role":"user","content":"private history"}\n',
    "private/service-token.txt": "opaque service token\n",
    "private/client_credentials.json": '{"client":"opaque"}\n',
  });
  const unsafe = [
    path.join(home, ".claude.json"),
    path.join(home, ".codex", "auth.json"),
    path.join(home, ".codex", "sessions"),
    path.join(home, "private", "service-token.txt"),
    path.join(home, "private", "client_credentials.json"),
  ];
  const includeArgs = unsafe.flatMap((target) => ["--include", target]);
  const { out, res } = runPack(t, home, [
    "--no-hermes",
    "--no-openclaw",
    ...includeArgs,
  ]);
  assertSucceeded(res);

  const forbiddenStaged = [
    ".claude.json",
    ".codex/auth.json",
    ".codex/sessions/thread.jsonl",
    "private/service-token.txt",
    "private/client_credentials.json",
  ];
  for (const rel of forbiddenStaged) {
    assert.ok(
      !fs.existsSync(path.join(out, "staging", ...rel.split("/"))),
      `${rel} must not enter staging even through an explicit --include`,
    );
  }

  const entries = archiveEntries(out);
  for (const rel of forbiddenStaged) {
    assert.ok(
      !entries.some((entry) => entry.endsWith(rel)),
      `${rel} must not enter harness.tar.gz`,
    );
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
  assert.ok(
    manifest.excluded.some((entry) => entry.includes(".claude.json")),
    "manifest records the excluded user-scope Claude session file",
  );
  assert.ok(
    manifest.excluded.some((entry) => entry.replaceAll("\\", "/").includes(".codex/auth.json")),
    "manifest records the excluded Codex auth file",
  );
});

test("hard-linked aliases of credential files cannot enter dedicated or generic staging", (t) => {
  const home = makeHome(t, {
    ".claude/.credentials.json": '{"session":"opaque-short-value"}\n',
  });
  const credentialPath = path.join(home, ".claude", ".credentials.json");
  const genericAlias = path.join(home, "project", "safe-notes.md");
  const dedicatedAlias = path.join(home, ".claude", "skills", "leaky", "SKILL.md");
  fs.mkdirSync(path.dirname(genericAlias), { recursive: true });
  fs.mkdirSync(path.dirname(dedicatedAlias), { recursive: true });
  try {
    fs.linkSync(credentialPath, genericAlias);
    fs.linkSync(credentialPath, dedicatedAlias);
  } catch (error) {
    t.skip(`hard links are unavailable on this filesystem (${error.code || error.message})`);
    return;
  }
  assert.ok(fs.statSync(credentialPath).nlink >= 3, "fixture must share one inode across all three names");

  const { out, res } = runPack(t, home, [
    "--yes",
    "--no-hermes",
    "--no-codex",
    "--no-openclaw",
    "--include",
    path.join(home, "project"),
  ]);
  assertSucceeded(res);

  for (const rel of ["project/safe-notes.md", ".claude/skills/leaky/SKILL.md"]) {
    assert.ok(
      !fs.existsSync(path.join(out, "staging", ...rel.split("/"))),
      `${rel} must be rejected before its hard-linked credential content is copied`,
    );
    assert.ok(
      !archiveEntries(out).some((entry) => entry.endsWith(rel)),
      `${rel} must not enter harness.tar.gz`,
    );
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
  assert.match(manifest.archiveSha256, /^[a-f0-9]{64}$/, "clean archive is bound to its audited SHA-256");
  assert.ok(
    manifest.flags.some((flag) => /hard.?link/i.test(flag)),
    `manifest explains the hard-link rejection: ${JSON.stringify(manifest.flags)}`,
  );
  assert.ok(
    manifest.securityOmissions.some((entry) => /safe-notes\.md|SKILL\.md/.test(entry.path)),
    `hard-link omissions stay visible after the temporary pack directory is removed: ${JSON.stringify(manifest.securityOmissions)}`,
  );
});

test("a safe-looking symlink cannot launder a credential carrier inside the packed root", (t) => {
  const home = makeHome(t, {
    "project/auth.json": '{"auth":"opaque-short-value"}\n',
  });
  const alias = path.join(home, "project", "safe.js");
  try {
    fs.symlinkSync("auth.json", alias, "file");
  } catch (error) {
    t.skip(`file symlinks are unavailable on this filesystem (${error.code || error.message})`);
    return;
  }
  const { out, res } = runPack(t, home, [
    "--yes",
    "--no-hermes",
    "--no-codex",
    "--no-openclaw",
    "--include",
    path.join(home, "project"),
  ]);
  assertSucceeded(res);
  assert.ok(
    !fs.existsSync(path.join(out, "staging", "project", "safe.js")),
    "the symlink alias does not enter staging",
  );
  assert.ok(
    !archiveEntries(out).some((entry) => entry.endsWith("project/safe.js")),
    "the symlink alias does not enter the archive",
  );
});

test("explicit --include cannot copy Hermes WhatsApp or an entire OpenClaw harness", (t) => {
  const home = makeHome(t, {
    ".hermes/config.yaml": "agent:\n  name: fixture\n",
    ".hermes/whatsapp/session/device.bin": "opaque-whatsapp-device-session",
    ".openclaw/openclaw.json": '{"version":1,"ui":{"theme":"dark"}}\n',
    ".openclaw/device-cache/opaque.bin": "opaque-linked-device-state",
    ".openclaw/sessions/thread.jsonl": '{"private":"conversation"}\n',
  });
  const { out, res } = runPack(t, home, [
    "--dry-run",
    "--no-codex",
    "--include",
    path.join(home, ".hermes", "whatsapp"),
    "--include",
    path.join(home, ".openclaw"),
  ]);
  assertSucceeded(res);

  assert.ok(
    !fs.existsSync(path.join(out, "staging", ".hermes", "whatsapp")),
    "Hermes WhatsApp state cannot bypass its dedicated migration policy",
  );
  assert.ok(
    !fs.existsSync(path.join(out, "staging", ".openclaw", "device-cache")),
    "whole OpenClaw include cannot copy opaque device state",
  );
  assert.ok(
    !fs.existsSync(path.join(out, "staging", ".openclaw", "sessions")),
    "whole OpenClaw include cannot copy sessions",
  );
  assert.ok(
    fs.existsSync(path.join(out, "staging", ".openclaw", "openclaw.json")),
    "OpenClaw's dedicated allowlist still migrates its safe config",
  );

  const manifest = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
  assert.ok(
    manifest.flags.some((flag) => /--include.*agent harness.*dedicated/i.test(flag)),
    `manifest explains the dedicated allowlist boundary: ${JSON.stringify(manifest.flags)}`,
  );
});

test("generic --include prunes credential carriers but keeps ordinary source and docs", (t) => {
  const zipPayload = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from(".credentials.json basicAuth=opaque-zip"),
  ]);
  const tarPayload = Buffer.alloc(512);
  tarPayload.write("ustar", 257, "ascii");
  tarPayload.write(".credentials.json SecretString=opaque-tar", 0, "ascii");
  const gzipPayload = Buffer.concat([
    Buffer.from([0x1f, 0x8b, 0x08, 0x00]),
    Buffer.from("SecretString=opaque-gzip"),
  ]);
  const v7TarPayload = Buffer.alloc(512);
  v7TarPayload.write(".credentials.json", 0, "ascii");
  v7TarPayload.fill(0x20, 148, 156);
  let v7Checksum = 0;
  for (const byte of v7TarPayload) v7Checksum += byte;
  v7TarPayload.write(`${v7Checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  const cpioPayload = Buffer.from("070701.credentials.json SecretString=opaque-cpio");
  const arPayload = Buffer.from("!<arch>\n.credentials.json SecretString=opaque-ar");
  const cabPayload = Buffer.from("MSCFcredentials.json SecretString=opaque-cab");
  const home = makeHome(t, {
    "private/auth/device.bin": "opaque-auth-state",
    "private/auth-cache/device.bin": "opaque-auth-cache-state",
    "private/oauth-state/device.bin": "opaque-oauth-state",
    "private/sessions/device.sqlite": "opaque-session-state",
    "private/session-data/device.sqlite": "opaque-session-data",
    "private/session-state/device.sqlite": "opaque-session-state-suffix",
    "private/token-store/device.bin": "opaque-token-store",
    "private/credentials-prod.json": '{"Authorization":"opaque-short-value"}\n',
    "private/whatsapp/creds.bin": "opaque-whatsapp-state",
    "private/pairing/device.bin": "opaque-pairing-state",
    "private/.claude.json.bak": "opaque-claude-backup",
    "private/.codex-backup/config.toml": "opaque-codex-backup",
    "private/.claude-backup/config.json": "opaque-claude-backup-dir",
    "private/.hermes-backup/config.yaml": "opaque-hermes-backup-dir",
    "private/.openclaw-backup/config.json": "opaque-openclaw-backup-dir",
    "private/.gemini-backup/settings.json": "opaque-gemini-backup-dir",
    "private/.kimi-backup/settings.json": "opaque-kimi-backup-dir",
    "private/authCache.json": '{"Authorization":"opaque-auth-cache"}\n',
    "private/oauthState.yaml": "Authorization: opaque-oauth-state\n",
    "private/tokenStore.json": '{"Authorization":"opaque-token-store"}\n',
    "private/sessionData.sqlite": "opaque-session-data",
    "private/credentialsProd.json": '{"Authorization":"opaque-credentials-prod"}\n',
    "private/pairingState.dat": "opaque-pairing-state",
    "private/authentication/device.bin": "opaque-authentication-state",
    "private/authentication.json": '{"Authorization":"opaque-authentication"}\n',
    "private/oauthTokens.json": '{"Authorization":"opaque-oauth-token-set"}\n',
    "private/sessionStorage.sqlite": "opaque-session-storage",
    "private/credentialStore.json": '{"Authorization":"opaque-credential-store"}\n',
    "private/passwords.json": '{"password":"opaque-password"}\n',
    "private/apiKeys.json": '{"service":"opaque-api-key"}\n',
    "private/secrets.db": "opaque-secrets",
    "private/keyring.sqlite": "opaque-keyring",
    "private/cookieStore.db": "opaque-cookie-store",
    "private/authorization.json": '{"value":"opaque-authorization"}\n',
    "private/authorization-store.db": "opaque-authorization-store",
    "private/extensionless/auth-cache": "opaque-extensionless-auth-cache",
    "private/extensionless/oauth-state": "opaque-extensionless-oauth-state",
    "private/extensionless/token-store": "opaque-extensionless-token-store",
    "private/extensionless/session-data": "opaque-extensionless-session-data",
    "private/extensionless/credentials-prod": "opaque-extensionless-credentials-prod",
    "private/extensionless/pairing-state": "opaque-extensionless-pairing-state",
    "private/auth-cache.db3": "opaque-db3-auth-cache",
    "private/oauth-state.cbor": "opaque-cbor-oauth-state",
    "private/token-store.ldb": "opaque-ldb-token-store",
    "private/session-data.msgpack": "opaque-msgpack-session-data",
    "private/credentials-prod.txt": "opaque-text-credentials-prod",
    "private/pairing-state.enc": "opaque-encrypted-pairing-state",
    "private/.credentials.json~": "opaque-editor-credentials-backup",
    "private/auth.json~": "opaque-editor-auth-backup",
    "private/token.txt~": "opaque-editor-token-backup",
    "private/session.db~": "opaque-editor-session-backup",
    "private/#credentials.json#": "opaque-editor-wrapped-credentials-backup",
    "private/settings.json.bak": '{"headers":{"X-Private":"opaque-settings-backup"}}\n',
    "private/settings.json.bak-": '{"headers":{"X-Private":"opaque-settings-backup"}}\n',
    "private/settings.json.orig": '{"headers":{"X-Private":"opaque-settings-backup"}}\n',
    "private/settings.json.save": '{"headers":{"X-Private":"opaque-settings-backup"}}\n',
    "private/settings.json.swp": '{"headers":{"X-Private":"opaque-settings-backup"}}\n',
    "private/settings.json.swo": '{"headers":{"X-Private":"opaque-settings-backup"}}\n',
    "private/settings.json.swn": '{"headers":{"X-Private":"opaque-settings-backup"}}\n',
    "private/settings.json.un~": '{"headers":{"X-Private":"opaque-settings-backup"}}\n',
    "private/settings.json.rej": '{"headers":{"X-Private":"opaque-settings-backup"}}\n',
    "private/settings.json.bak1": '{"headers":{"X-Private":"opaque-settings-backup"}}\n',
    "private/settings.json.old1": '{"headers":{"X-Private":"opaque-settings-backup"}}\n',
    "private/settings.json.tmp": '{"headers":{"X-Private":"opaque-settings-backup"}}\n',
    "private/settings.json.copy": '{"headers":{"X-Private":"opaque-settings-backup"}}\n',
    "private/.gemini~/settings.json": "opaque-editor-gemini-backup",
    "private/.kimi~/settings.json": "opaque-editor-kimi-backup",
    "private/geminiBackup/settings.json": "opaque-gemini-camel-backup",
    "private/.geminiBackup/settings.json": "opaque-dotted-gemini-camel-backup",
    "private/kimiBackup/settings.json": "opaque-kimi-camel-backup",
    "private/.kimiBackup/settings.json": "opaque-dotted-kimi-camel-backup",
    "private/claudeBackup/settings.json": "opaque-claude-camel-backup",
    "private/.claudeBackup/settings.json": "opaque-dotted-claude-camel-backup",
    "private/codexBackup/config.toml": "opaque-codex-camel-backup",
    "private/.codexBackup/config.toml": "opaque-dotted-codex-camel-backup",
    "private/hermesBackup/config.yaml": "opaque-hermes-camel-backup",
    "private/.hermesBackup/config.yaml": "opaque-dotted-hermes-camel-backup",
    "private/openclawBackup/config.json": "opaque-openclaw-camel-backup",
    "private/.openclawBackup/config.json": "opaque-dotted-openclaw-camel-backup",
    "private/agent-backups/hermes/auth.db": "opaque-agent-backup",
    "private/token.bin": "opaque-token",
    "private/history.jsonl": "private conversation history",
    "private/.env": "SERVICE_KEY=opaque-unshaped-value\n",
    "private/.env.local": "SERVICE_KEY=opaque-local-value\n",
    "private/.env-prod": "SERVICE_KEY=opaque-production-value\n",
    "private/service.env": "SERVICE_KEY=opaque-service-value\n",
    "private/.npmrc": "//registry.example/:_authToken=opaque\n",
    "private/.netrc": "machine example login fixture password opaque\n",
    "private/.pypirc": "[distutils]\n",
    "private/id_ed25519": "opaque-private-key-carrier",
    "private/cert.pem": "opaque-pem-carrier",
    "private/signing.key": "opaque-key-carrier",
    "private/client.p12": "opaque-p12-carrier",
    "private/client.pfx": "opaque-pfx-carrier",
    "private/client.jks": "opaque-jks-carrier",
    "private/client.keystore": "opaque-keystore-carrier",
    "private/vault.kdbx": "opaque-kdbx-carrier",
    "private/keychain.gpg": "opaque-gpg-carrier",
    "private/keychain.pgp": "opaque-pgp-carrier",
    "private/auth cache/device.bin": "opaque-auth-cache",
    "private/OAuth Tokens.json": '{"tokens":"opaque-oauth"}\n',
    "private/session data.sqlite": "opaque-session-data",
    "private/cookie store.db": "opaque-cookie-store",
    "private/Login Data": "opaque-browser-login-store",
    "private/config.sqlite": "opaque-config-state",
    "private/settings.db": "opaque-settings-state",
    "private/state.db": "opaque-state",
    "private/project.zip": "opaque-nested-archive",
    "private/backup.tar.gz": "opaque-nested-archive",
    "private/kubeconfig": "users:\n- user:\n    client-key-data: opaque-kube\n",
    "private/.kubeconfig": "users:\n- user:\n    client-key-data: opaque-kube\n",
    "private/prod.kubeconfig": "users:\n- user:\n    client-key-data: opaque-kube\n",
    "private/terraform.tfstate": '{"resources":[{"db_password":"opaque-terraform"}]}\n',
    "private/prod.hcl": 'password = "opaque-hcl"\n',
    "private/.terraformrc": 'credentials "app.terraform.io" { token = "opaque-terraform" }\n',
    "private/.gitconfig": "[url \"https://user:opaque-git@example.test/\"]\n",
    "private/.wgetrc": ["http_", "pass", "word", " = TEST_FIXTURE_VALUE\n"].join(""),
    "private/.yarnrc": "//registry.example/:_authToken opaque-yarn\n",
    "private/NuGet.Config": "<configuration><password>opaque-nuget</password></configuration>\n",
    "private/app.config": "<configuration><password>opaque-app</password></configuration>\n",
    "private/.my.cnf": "[client]\npassword=opaque-mysql\n",
    "private/prod.cnf": "[client]\npassword=opaque-mysql\n",
    "private/prod.tfvars": 'db_password = "opaque-terraform"\n',
    "private/.pgpass": "host:5432:db:user:opaque-postgres\n",
    "private/.curlrc": "user = user:opaque-curl\n",
    "private/data.sqlite": "opaque-sqlite-credentials",
    "private/plugin.db": "opaque-plugin-credentials",
    "private/data.db3": "opaque-db3-credentials",
    "private/data.s3db": "opaque-s3db-credentials",
    "private/data.sl3": "opaque-sl3-credentials",
    "private/cache.ldb": "opaque-leveldb-credentials",
    "private/data.duckdb": "opaque-duckdb-credentials",
    "private/data.realm": "opaque-realm-credentials",
    "private/data.db-journal": "opaque-db-journal-credentials",
    "private/data.sqlite-journal": "opaque-sqlite-journal-credentials",
    "private/data.sqlite3-journal": "opaque-sqlite3-journal-credentials",
    "private/payload.jar": zipPayload,
    "private/renamed.opaque": zipPayload,
    "private/renamed-tar.data": tarPayload,
    "private/renamed-gzip.blob": gzipPayload,
    "private/hidden-v7.data": v7TarPayload,
    "private/hidden-cpio.data": cpioPayload,
    "private/hidden-ar.data": arPayload,
    "private/hidden-cab.data": cabPayload,
    "private/kanban.db": "opaque credential database renamed to kanban.db",
    "private/node_modules/fixture/index.js": "export default 'dependency noise';\n",
    "private/__pycache__/fixture.pyc": "python cache noise",
    "private/.DS_Store": "finder metadata noise",
    "private/session-manager.js": "export const sessionManager = true;\n",
    "private/oauth-guide.md": "# OAuth guide\n",
    "private/credential-helper.md": "# Credential helper source\n",
    "private/tokenizer.js": "export const tokenizer = true;\n",
    "private/src/auth/index.ts": "export function authenticate() { return true; }\n",
    "private/references/authentication.md": "# Authentication reference\n",
    "private/hooks/session-start.mjs": "export default function sessionStart() {}\n",
    "private/continuous-learning/evaluate-session.sh": "#!/bin/sh\nexit 0\n",
    "private/faceless-explainer/scripts/lib/tokens.mjs": "export const tokens = {};\n",
    "private/learned/design-token-migration-sweep.md": "# Design token migration\n",
    "private/learned/supabase-postgrest-auth-users-join.md": "# Auth users join\n",
  });
  const { out, res } = runPack(t, home, [
    "--no-hermes",
    "--no-codex",
    "--no-openclaw",
    "--include",
    path.join(home, "private"),
  ]);
  assertSucceeded(res);

  for (const rel of [
    "auth",
    "auth-cache",
    "oauth-state",
    "sessions",
    "session-data",
    "session-state",
    "token-store",
    "credentials-prod.json",
    "whatsapp",
    "pairing",
    ".claude.json.bak",
    ".codex-backup",
    ".claude-backup",
    ".hermes-backup",
    ".openclaw-backup",
    ".gemini-backup",
    ".kimi-backup",
    "authCache.json",
    "oauthState.yaml",
    "tokenStore.json",
    "sessionData.sqlite",
    "credentialsProd.json",
    "pairingState.dat",
    "authentication",
    "authentication.json",
    "oauthTokens.json",
    "sessionStorage.sqlite",
    "credentialStore.json",
    "passwords.json",
    "apiKeys.json",
    "secrets.db",
    "keyring.sqlite",
    "cookieStore.db",
    "authorization.json",
    "authorization-store.db",
    "extensionless/auth-cache",
    "extensionless/oauth-state",
    "extensionless/token-store",
    "extensionless/session-data",
    "extensionless/credentials-prod",
    "extensionless/pairing-state",
    "auth-cache.db3",
    "oauth-state.cbor",
    "token-store.ldb",
    "session-data.msgpack",
    "credentials-prod.txt",
    "pairing-state.enc",
    ".credentials.json~",
    "auth.json~",
    "token.txt~",
    "session.db~",
    "#credentials.json#",
    "settings.json.bak",
    "settings.json.bak-",
    "settings.json.orig",
    "settings.json.save",
    "settings.json.swp",
    "settings.json.swo",
    "settings.json.swn",
    "settings.json.un~",
    "settings.json.rej",
    "settings.json.bak1",
    "settings.json.old1",
    "settings.json.tmp",
    "settings.json.copy",
    ".gemini~",
    ".kimi~",
    "geminiBackup",
    ".geminiBackup",
    "kimiBackup",
    ".kimiBackup",
    "claudeBackup",
    ".claudeBackup",
    "codexBackup",
    ".codexBackup",
    "hermesBackup",
    ".hermesBackup",
    "openclawBackup",
    ".openclawBackup",
    "agent-backups",
    "token.bin",
    "history.jsonl",
    ".env",
    ".env.local",
    ".env-prod",
    "service.env",
    ".npmrc",
    ".netrc",
    ".pypirc",
    "id_ed25519",
    "cert.pem",
    "signing.key",
    "client.p12",
    "client.pfx",
    "client.jks",
    "client.keystore",
    "vault.kdbx",
    "keychain.gpg",
    "keychain.pgp",
    "auth cache",
    "OAuth Tokens.json",
    "session data.sqlite",
    "cookie store.db",
    "Login Data",
    "config.sqlite",
    "settings.db",
    "state.db",
    "project.zip",
    "backup.tar.gz",
    "kubeconfig",
    ".kubeconfig",
    "prod.kubeconfig",
    "terraform.tfstate",
    "prod.hcl",
    ".terraformrc",
    ".gitconfig",
    ".wgetrc",
    ".yarnrc",
    "NuGet.Config",
    "app.config",
    ".my.cnf",
    "prod.cnf",
    "prod.tfvars",
    ".pgpass",
    ".curlrc",
    "data.sqlite",
    "plugin.db",
    "data.db3",
    "data.s3db",
    "data.sl3",
    "cache.ldb",
    "data.duckdb",
    "data.realm",
    "data.db-journal",
    "data.sqlite-journal",
    "data.sqlite3-journal",
    "payload.jar",
    "renamed.opaque",
    "renamed-tar.data",
    "renamed-gzip.blob",
    "hidden-v7.data",
    "hidden-cpio.data",
    "hidden-ar.data",
    "hidden-cab.data",
    "kanban.db",
    "node_modules",
    "__pycache__",
    ".DS_Store",
  ]) {
    assert.ok(
      !fs.existsSync(path.join(out, "staging", "private", ...rel.split("/"))),
      `${rel} is a credential/session carrier and must be pruned`,
    );
  }
  for (const rel of [
    "session-manager.js",
    "oauth-guide.md",
    "credential-helper.md",
    "tokenizer.js",
    "src/auth/index.ts",
    "references/authentication.md",
    "hooks/session-start.mjs",
    "continuous-learning/evaluate-session.sh",
    "faceless-explainer/scripts/lib/tokens.mjs",
    "learned/design-token-migration-sweep.md",
    "learned/supabase-postgrest-auth-users-join.md",
  ]) {
    assert.ok(
      fs.existsSync(path.join(out, "staging", "private", ...rel.split("/"))),
      `${rel} is ordinary source/documentation and must remain migratable`,
    );
  }
  const entries = archiveEntries(out);
  for (const rel of [
    "private/kubeconfig",
    "private/.kubeconfig",
    "private/prod.kubeconfig",
    "private/terraform.tfstate",
    "private/prod.hcl",
    "private/.terraformrc",
    "private/.gitconfig",
    "private/.wgetrc",
    "private/.yarnrc",
    "private/NuGet.Config",
    "private/app.config",
    "private/.my.cnf",
    "private/prod.cnf",
    "private/prod.tfvars",
    "private/.pgpass",
    "private/.curlrc",
    "private/data.sqlite",
    "private/plugin.db",
    "private/data.db3",
    "private/data.s3db",
    "private/data.sl3",
    "private/cache.ldb",
    "private/data.duckdb",
    "private/data.realm",
    "private/data.db-journal",
    "private/data.sqlite-journal",
    "private/data.sqlite3-journal",
    "private/payload.jar",
    "private/renamed.opaque",
    "private/renamed-tar.data",
    "private/renamed-gzip.blob",
    "private/hidden-v7.data",
    "private/hidden-cpio.data",
    "private/hidden-ar.data",
    "private/hidden-cab.data",
    "private/kanban.db",
    "private/node_modules/fixture/index.js",
    "private/__pycache__/fixture.pyc",
    "private/.DS_Store",
  ]) {
    assert.ok(
      !entries.some((entry) => entry.endsWith(rel)),
      `${rel} must not enter the final harness.tar.gz`,
    );
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
  for (const leaf of [
    "kubeconfig", ".kubeconfig", "prod.kubeconfig", "terraform.tfstate", "prod.hcl",
    ".terraformrc", ".gitconfig", ".wgetrc", ".yarnrc", "NuGet.Config",
    "app.config", ".my.cnf", "prod.cnf", "prod.tfvars", ".pgpass", ".curlrc",
    "data.sqlite", "plugin.db", "data.db3", "data.s3db", "data.sl3", "cache.ldb",
    "data.duckdb", "data.realm", "data.db-journal", "data.sqlite-journal",
    "data.sqlite3-journal", "payload.jar", "renamed.opaque",
    "renamed-tar.data", "renamed-gzip.blob", "hidden-v7.data", "hidden-cpio.data",
    "hidden-ar.data", "hidden-cab.data", "kanban.db",
  ]) {
    assert.ok(
      manifest.securityOmissions.some((entry) => entry.path.endsWith(`private/${leaf}`)),
      `${leaf} must be visible in the machine-readable security omissions`,
    );
  }
});

test("self-extracting archive signatures hidden behind executable stubs are omitted", (t) => {
  // Real 7z archive generated from session.txt containing
  // "opaque-sfx-session-material", then prefixed with a 512-byte MZ stub.
  const sevenZip = Buffer.from(
    "N3q8ryccAARc0AgdJAAAAAAAAABiAAAAAAAAAOOMTn8BAB/vu79vcGFxdWUtc2Z4LXNlc3Npb24tbWF0ZXJpYWwNCgABBAYAAQkkAAcLAQABISEBGgwgAAgKAaBb7yoAAAUBGQwAAAAAAAAAAAAAAAARGwA9AHMAZQBzAHMAaQBvAG4ALgB0AHgAdAAAABkAFAoBAFbIiKPSHt0BFQYBAAAAAAAAAA==",
    "base64",
  );
  const executableStub = Buffer.alloc(512);
  executableStub.write("MZ", 0, "ascii");
  const disguisedArchives = {
    ".claude/skills/fixture/bundle-7z.bin": Buffer.concat([executableStub, sevenZip]),
    ".claude/skills/fixture/bundle-rar.bin": Buffer.concat([
      executableStub,
      Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]),
      Buffer.from("opaque-rar-session-material"),
    ]),
    ".claude/skills/fixture/bundle-cab.bin": Buffer.concat([
      executableStub,
      Buffer.from([0x4d, 0x53, 0x43, 0x46, 0x00, 0x00, 0x00, 0x00]),
      Buffer.from("opaque-cab-session-material"),
    ]),
  };
  const home = makeHome(t, disguisedArchives);
  const { out, res } = runPack(t, home, [
    "--no-hermes",
    "--no-codex",
    "--no-openclaw",
  ]);
  assertSucceeded(res);

  const entries = archiveEntries(out);
  const manifest = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
  for (const packedRel of Object.keys(disguisedArchives)) {
    assert.ok(
      !fs.existsSync(path.join(out, "staging", ...packedRel.split("/"))),
      `${packedRel} must not enter staging`,
    );
    assert.ok(
      !entries.some((entry) => entry.endsWith(packedRel)),
      `${packedRel} must not enter harness.tar.gz`,
    );
    assert.ok(
      manifest.securityOmissions.some(({ path: omittedPath, reason }) =>
        omittedPath.replaceAll("\\", "/").endsWith(packedRel)
        && /nested archive contents cannot be audited/i.test(reason)
      ),
      `${packedRel} must have a visible nested-archive omission`,
    );
  }
  const report = fs.readFileSync(path.join(out, "compat-report.md"), "utf8");
  for (const packedRel of Object.keys(disguisedArchives)) {
    assert.ok(report.includes(path.basename(packedRel)), `${packedRel} must be named in the report`);
  }
});

test("opaque database formats and sidecars are omitted from staging and the final archive", (t) => {
  const opaqueFiles = {
    "state.mdb": "opaque-db-state-mdb",
    "data.rdb": "opaque-db-state-rdb",
    "cache.dbm": "opaque-db-state-dbm",
    "index.gdbm": "opaque-db-state-gdbm",
    "data.ndb": "opaque-db-state-ndb",
    "store.bdb": "opaque-db-state-bdb",
    "vault.kdb": "opaque-db-state-kdb",
    "appendonly.aof": "opaque-db-state-aof",
    "state.mdb.log": "opaque-db-state-mdb-log",
    "data.rdb.log": "opaque-db-state-rdb-log",
    "cache.leveldb/CURRENT": "opaque-db-state-leveldb",
    "cache.rocksdb/MANIFEST-000001": "opaque-db-state-rocksdb",
  };
  const home = makeHome(t, Object.fromEntries(
    Object.entries(opaqueFiles).map(([rel, value]) => [
      `.claude/skills/fixture/${rel}`,
      value,
    ]),
  ));
  const { out, res } = runPack(t, home, [
    "--no-hermes",
    "--no-codex",
    "--no-openclaw",
  ]);
  assertSucceeded(res);

  const entries = archiveEntries(out);
  for (const rel of Object.keys(opaqueFiles)) {
    const packedRel = `.claude/skills/fixture/${rel}`;
    assert.ok(
      !fs.existsSync(path.join(out, "staging", ...packedRel.split("/"))),
      `${packedRel} must not enter staging`,
    );
    assert.ok(
      !entries.some((entry) => entry.endsWith(packedRel)),
      `${packedRel} must not enter harness.tar.gz`,
    );
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
  for (const omitted of [
    "state.mdb", "data.rdb", "cache.dbm", "index.gdbm", "data.ndb",
    "store.bdb", "vault.kdb", "appendonly.aof", "state.mdb.log", "data.rdb.log",
    "cache.leveldb", "cache.rocksdb",
  ]) {
    assert.ok(
      manifest.securityOmissions.some(({ path: omittedPath, reason }) =>
        omittedPath.replaceAll("\\", "/").endsWith(`.claude/skills/fixture/${omitted}`)
        && /opaque config\/state database cannot be audited/i.test(reason)
      ),
      `${omitted} must have a visible opaque-database omission`,
    );
  }
  const report = fs.readFileSync(path.join(out, "compat-report.md"), "utf8");
  assert.ok(report.includes("state.mdb"), "the report must name the omitted MDB");
  assert.ok(report.includes("data.rdb"), "the report must name the omitted RDB");
});

test("kanban.db is allowed only from the explicitly selected Hermes source", (t) => {
  const home = makeHome(t, {
    ".hermes/kanban.db": "safe governed board payload",
  });
  const withoutKanban = runPack(t, home, [
    "--no-codex",
    "--no-openclaw",
  ]);
  assertSucceeded(withoutKanban.res);
  assert.ok(
    !fs.existsSync(path.join(withoutKanban.out, "staging", ".hermes", "kanban.db")),
    "the governed Hermes board stays local unless --with-kanban is explicit",
  );
  assert.ok(
    !archiveEntries(withoutKanban.out).some((entry) => entry.endsWith(".hermes/kanban.db")),
    "the governed Hermes board stays out of the archive unless --with-kanban is explicit",
  );

  const { out, res } = runPack(t, home, [
    "--with-kanban",
    "--no-codex",
    "--no-openclaw",
  ]);
  assertSucceeded(res);

  const governedPath = path.join(out, "staging", ".hermes", "kanban.db");
  assert.equal(
    fs.readFileSync(governedPath, "utf8"),
    "safe governed board payload",
    "the dedicated Hermes path is copied only when --with-kanban is explicit",
  );
  assert.ok(
    archiveEntries(out).some((entry) => entry.endsWith(".hermes/kanban.db")),
    "the governed Hermes board reaches the exact audited tarball",
  );
});

test("a directory named kanban.db cannot use the governed-file exception", (t) => {
  const home = makeHome(t, {
    ".hermes/kanban.db/notes.md": "opaque directory payload",
  });
  const { out, res } = runPack(t, home, [
    "--with-kanban",
    "--no-codex",
    "--no-openclaw",
  ]);
  assertSucceeded(res);

  const governedPath = path.join(out, "staging", ".hermes", "kanban.db");
  assert.ok(!fs.existsSync(governedPath), "a kanban.db directory must not enter staging");
  assert.ok(
    !archiveEntries(out).some((entry) => entry.includes(".hermes/kanban.db")),
    "a kanban.db directory and its children must not enter harness.tar.gz",
  );

  const manifest = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
  assert.ok(
    manifest.securityOmissions.some(({ path: omittedPath, reason }) =>
      omittedPath.replaceAll("\\", "/").endsWith(".hermes/kanban.db")
      && /opaque config\/state database cannot be audited/i.test(reason)
    ),
    "the rejected kanban.db directory must have a visible security omission",
  );
  assert.ok(
    fs.readFileSync(path.join(out, "compat-report.md"), "utf8").includes("kanban.db"),
    "the report must name the rejected kanban.db directory",
  );
});

test("Gemini and Kimi harness roots cannot bypass their future dedicated migration gates", (t) => {
  const home = makeHome(t, {
    ".gemini/settings.json": '{"Authorization":"opaque-gemini-value"}\n',
    ".kimi/settings.json": '{"Authorization":"opaque-kimi-value"}\n',
  });
  const { out, res } = runPack(t, home, [
    "--dry-run",
    "--no-hermes",
    "--no-codex",
    "--no-openclaw",
    "--include",
    path.join(home, ".gemini"),
    "--include",
    path.join(home, ".kimi"),
  ]);
  assertSucceeded(res);

  for (const root of [".gemini", ".kimi"]) {
    assert.ok(
      !fs.existsSync(path.join(out, "staging", root)),
      `${root} must wait for a dedicated safe migration allowlist`,
    );
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.possibleSecrets, [], "opaque auth values are not shape-detectable");
  assert.ok(
    manifest.flags.filter((flag) => /agent harness.*dedicated/i.test(flag)).length >= 2,
    `both protected roots are explained: ${JSON.stringify(manifest.flags)}`,
  );
});

test("explicit includes cannot hide credential state beneath safe-looking leaves", (t) => {
  const home = makeHome(t, {
    "private/sessions/notes.md": "session state behind a safe leaf",
    "private/whatsapp/creds.bin": "opaque-whatsapp-state",
    "private/pairing/device.bin": "opaque-pairing-state",
    "private/.claude.json.bak": "opaque-claude-backup",
    "private/.codex-backup/config.toml": "opaque-codex-backup",
  });
  const targets = [
    "private/sessions/notes.md",
    "private/whatsapp/creds.bin",
    "private/pairing/device.bin",
    "private/.claude.json.bak",
    "private/.codex-backup/config.toml",
  ];
  const { out, res } = runPack(t, home, [
    "--dry-run",
    "--no-hermes",
    "--no-codex",
    "--no-openclaw",
    ...targets.flatMap((rel) => ["--include", path.join(home, ...rel.split("/"))]),
  ]);
  assertSucceeded(res);

  for (const rel of targets) {
    assert.ok(
      !fs.existsSync(path.join(out, "staging", ...rel.split("/"))),
      `${rel} must be rejected based on every ancestor, not just its leaf name`,
    );
  }
});

test("dedicated Claude and Hermes directories cannot junction into a credential store", (t) => {
  const home = makeHome(t, {
    "AppData/credential-store/secret.txt": "opaque-external-credential-state",
    ".hermes/config.yaml": "agent:\n  name: fixture\n",
  });
  const external = path.join(home, "AppData", "credential-store");
  const links = [
    path.join(home, ".claude", "skills"),
    path.join(home, ".hermes", "skills"),
  ];
  fs.mkdirSync(path.dirname(links[1]), { recursive: true });
  try {
    for (const link of links) fs.symlinkSync(external, link, "junction");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
      t.skip(`directory junctions are unavailable on this machine (${error.code})`);
      return;
    }
    throw error;
  }

  const { out, res } = runPack(t, home, [
    "--dry-run",
    "--agent",
    "hermes",
    "--no-codex",
    "--no-openclaw",
  ]);
  assertSucceeded(res);
  assert.ok(
    !fs.existsSync(path.join(out, "staging", ".claude", "skills", "secret.txt")),
    "Claude's dedicated allowlist must stay inside ~/.claude",
  );
  assert.ok(
    !fs.existsSync(path.join(out, "staging", ".hermes", "skills", "secret.txt")),
    "Hermes's dedicated allowlist must stay inside ~/.hermes",
  );
});

test("generic --include rejects HOME, AppData, and standard credential stores", async (t) => {
  const home = makeHome(t);
  const cases = [
    ["HOME", home],
    ["AppData", path.join(home, "AppData")],
    [".ssh", path.join(home, ".ssh")],
    [".aws", path.join(home, ".aws")],
    [".gnupg", path.join(home, ".gnupg")],
    [".kube", path.join(home, ".kube")],
    [".docker", path.join(home, ".docker")],
    [".azure", path.join(home, ".azure")],
    [".fly", path.join(home, ".fly")],
    [".config/gh", path.join(home, ".config", "gh")],
    [".config/gcloud", path.join(home, ".config", "gcloud")],
    [".config/fly", path.join(home, ".config", "fly")],
    [".local/share/keyrings", path.join(home, ".local", "share", "keyrings")],
  ];
  for (const [label, target] of cases) {
    await t.test(label, () => {
      if (target !== home) writeTree(target, { "fixture.txt": "opaque credential-store state\n" });
      const { out, res } = runPack(t, home, [
        "--no-hermes",
        "--no-codex",
        "--no-openclaw",
        "--include",
        target,
      ]);
      assert.notEqual(res.status, 0, `${label} must be rejected as too broad or credential-bearing`);
      assert.match(`${res.stdout}\n${res.stderr}`, /include.*(?:too broad|credential|sensitive|narrower)/i);
      assert.ok(!fs.existsSync(path.join(out, "harness.tar.gz")), `${label} rejection writes no archive`);
    });
  }
});

test("private-key content outside a known credential store is omitted from the archive", (t) => {
  const home = makeHome(t, {
    "project/recovery.txt": [
      "fixture only",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "b3BhcXVlLWZpeHR1cmU=",
      "-----END OPENSSH PRIVATE KEY-----",
      "",
    ].join("\n"),
  });
  const { out, res } = runPack(t, home, [
    "--yes",
    "--no-hermes",
    "--no-codex",
    "--no-openclaw",
    "--include",
    path.join(home, "project"),
  ]);

  assertSucceeded(res);
  assert.ok(fs.existsSync(path.join(out, "harness.tar.gz")), "the remaining safe harness still archives");
  assert.ok(!fs.existsSync(path.join(out, "staging", "project", "recovery.txt")));
  assert.ok(!archiveEntries(out).some((entry) => entry.endsWith("project/recovery.txt")));
  const manifest = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
  assert.ok(
    manifest.securityOmissions.some((entry) =>
      /project\/recovery\.txt/i.test(entry.path) && /private-key/i.test(entry.reason)
    ),
    `manifest identifies the omitted private-key carrier: ${JSON.stringify(manifest.securityOmissions)}`,
  );
});

test("a private-key header beyond 512 KiB is still omitted before archive", (t) => {
  const home = makeHome(t, {
    "project/large-recovery.txt":
      "x".repeat(600 * 1024) +
      "\n-----BEGIN OPENSSH PRIVATE KEY-----\nopaque\n",
  });
  const { out, res } = runPack(t, home, [
    "--yes",
    "--no-hermes",
    "--no-codex",
    "--no-openclaw",
    "--include",
    path.join(home, "project"),
  ]);

  assertSucceeded(res);
  assert.ok(fs.existsSync(path.join(out, "harness.tar.gz")), "the remaining safe harness still archives");
  assert.ok(!fs.existsSync(path.join(out, "staging", "project", "large-recovery.txt")));
  assert.ok(!archiveEntries(out).some((entry) => entry.endsWith("project/large-recovery.txt")));
  const manifest = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
  assert.ok(
    manifest.securityOmissions.some((entry) =>
      /large-recovery\.txt/i.test(entry.path) && /private-key/i.test(entry.reason)
    ),
    `manifest identifies the omitted large private-key carrier: ${JSON.stringify(manifest.securityOmissions)}`,
  );
});

test("camelCase carriers and auth/session keys are redacted before Claude MCP config is staged", (t) => {
  const home = makeHome(t, {
    ".claude/mcp.json": JSON.stringify({
      mcpServers: {
        fixture: {
          httpHeaders: [{ XPrivate: "opaque-short-value" }],
          auth: "opaque-auth",
          oauth: { value: "opaque-oauth" },
          session: ["opaque-session"],
          cookie: { nested: "opaque-cookie" },
          pairing: "opaque-pairing",
          sessionBlob: "opaque-session-blob",
          sessionPayload: "opaque-session-payload",
          sessionMaterial: "opaque-session-material",
          authState: "opaque-auth-state",
          oauthState: "opaque-oauth-state",
          oauthVerifier: "opaque-oauth-verifier",
          pkceVerifier: "opaque-pkce-verifier",
          credentialsData: "opaque-credentials-data",
          cookieStoreV2: "opaque-cookie-store-v2",
          passwordHash: "opaque-password-hash",
          accessTokenCiphertext: "opaque-access-token-ciphertext",
          clientSecretEncrypted: "opaque-client-secret-encrypted",
          apiKeyEncrypted: "opaque-api-key-encrypted",
          privateKeyPem: "opaque-private-key-pem",
          privateKeyBlob: "opaque-private-key-blob",
          credentialEnvelope: "opaque-credential-envelope",
          sessionEnvelope: "opaque-session-envelope",
          authCode: "opaque-auth-code",
          oauthCode: "opaque-oauth-code",
          authorizationCode: "opaque-authorization-code",
          sessionTicket: "opaque-session-ticket",
          sessionAssertion: "opaque-session-assertion",
          tokenJwe: "opaque-token-jwe",
          tokenJwt: "opaque-token-jwt",
          authProof: "opaque-auth-proof",
          args: [
            "--token",
            "tiny-positional-secret",
            "--api-key=tiny-inline-secret",
            "--header",
            "X-Private: tiny-header-secret",
          ],
          url: "https://example.test/mcp?session=tiny-url-session&safe=kept",
          nestedAuthUrl: "https://example.test/callback?auth%5Btoken%5D=opaque-nested-token",
          doubleNestedAuthUrl: "https://example.test/callback?auth%255Btoken%255D=opaque-double-nested-token",
          awsSignedUrl: "https://bucket.s3.amazonaws.com/object?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=fixture&X-Amz-Signature=opaque-amz-signature",
          gcsSignedUrl: "https://storage.googleapis.com/bucket/object?GoogleAccessId=fixture%40example.iam.gserviceaccount.com&Expires=9999999999&Signature=opaque-gcs-signature",
          doubleAwsSignedUrl: "https://bucket.s3.amazonaws.com/object?X%252DAmz%252DAlgorithm=AWS4-HMAC-SHA256&X%252DAmz%252DCredential=opaque-amz-access&X%252DAmz%252DSignature=opaque-double-amz-signature",
          nestedGcsSignedUrl: `https://outer.example/callback?next=${encodeURIComponent(encodeURIComponent(
            "https://storage.googleapis.com/bucket/object?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Credential=opaque-gcs-access&X-Goog-Signature=opaque-nested-gcs-signature",
          ))}`,
          clientId: "public-client-id",
          tokenBudget: 4096,
          tokenCount: 12,
          tokenType: "bearer",
          signatureAlgorithm: "SHA256",
          signingKeyId: "public-key-id",
        },
      },
    }),
  });
  const { out, res } = runPack(t, home, [
    "--no-hermes",
    "--no-codex",
    "--no-openclaw",
  ]);
  assertSucceeded(res);

  const stagedPath = path.join(out, "staging", ".claude", "mcp.json");
  const staged = JSON.parse(fs.readFileSync(stagedPath, "utf8"));
  assert.equal(staged.mcpServers.fixture.httpHeaders[0].XPrivate, REDACTED);
  assert.equal(staged.mcpServers.fixture.auth, REDACTED);
  assert.equal(staged.mcpServers.fixture.oauth.value, REDACTED);
  assert.equal(staged.mcpServers.fixture.session[0], REDACTED);
  assert.equal(staged.mcpServers.fixture.cookie.nested, REDACTED);
  assert.equal(staged.mcpServers.fixture.pairing, REDACTED);
  for (const key of [
    "sessionBlob", "sessionPayload", "sessionMaterial", "authState", "oauthState",
    "oauthVerifier", "pkceVerifier", "credentialsData", "cookieStoreV2",
    "passwordHash", "accessTokenCiphertext", "clientSecretEncrypted",
    "apiKeyEncrypted", "privateKeyPem", "privateKeyBlob", "credentialEnvelope",
    "sessionEnvelope", "authCode", "oauthCode", "authorizationCode",
    "sessionTicket", "sessionAssertion", "tokenJwe", "tokenJwt", "authProof",
  ]) {
    assert.equal(staged.mcpServers.fixture[key], REDACTED, `${key} must redact in staging`);
  }
  assert.equal(staged.mcpServers.fixture.args[0], "--token");
  assert.equal(staged.mcpServers.fixture.args[1], REDACTED);
  assert.ok(!staged.mcpServers.fixture.args[2].includes("tiny-inline-secret"));
  assert.equal(staged.mcpServers.fixture.args[3], "--header");
  assert.equal(staged.mcpServers.fixture.args[4], REDACTED);
  assert.ok(!staged.mcpServers.fixture.url.includes("tiny-url-session"));
  assert.ok(staged.mcpServers.fixture.url.includes("safe=kept"));
  assert.ok(!staged.mcpServers.fixture.nestedAuthUrl.includes("opaque-"));
  assert.ok(!staged.mcpServers.fixture.doubleNestedAuthUrl.includes("opaque-"));
  assert.ok(!staged.mcpServers.fixture.awsSignedUrl.includes("opaque-"));
  assert.ok(!staged.mcpServers.fixture.gcsSignedUrl.includes("opaque-"));
  assert.ok(!staged.mcpServers.fixture.doubleAwsSignedUrl.includes("opaque-"));
  let decodedNestedGcs = staged.mcpServers.fixture.nestedGcsSignedUrl;
  for (let depth = 0; depth < 3; depth++) decodedNestedGcs = decodeURIComponent(decodedNestedGcs);
  assert.ok(!decodedNestedGcs.includes("opaque-"));
  assert.equal(staged.mcpServers.fixture.clientId, "public-client-id");
  assert.equal(staged.mcpServers.fixture.tokenBudget, 4096);
  assert.equal(staged.mcpServers.fixture.tokenCount, 12);
  assert.equal(staged.mcpServers.fixture.tokenType, "bearer");
  assert.equal(staged.mcpServers.fixture.signatureAlgorithm, "SHA256");
  assert.equal(staged.mcpServers.fixture.signingKeyId, "public-key-id");
  assert.ok(
    !fs.readFileSync(stagedPath, "utf8").includes("opaque-short-value"),
    "the camelCase carrier value must not survive staging",
  );

  const manifestText = fs.readFileSync(path.join(out, "manifest.json"), "utf8");
  const reportText = fs.readFileSync(path.join(out, "compat-report.md"), "utf8");
  assert.ok(!manifestText.includes("opaque-"), "secret values must not reach manifest.json");
  assert.ok(!reportText.includes("opaque-"), "secret values must not reach compat-report.md");
  assert.ok(fs.existsSync(path.join(out, "harness.tar.gz")), "clean redacted staging must archive");
  // Extract the packer's own way: cwd at the output dir, relative -f and -C.
  // An absolute Windows path here dies twice over -- GNU tar reads the leading
  // "C:" as an SCP host, and C-escapes ""/"	" inside the rest of the path.
  const extracted = fs.mkdtempSync(path.join(out, "archive-check-"));
  t.after(() => fs.rmSync(extracted, { recursive: true, force: true }));
  execFileSync("tar", ["-xzf", "harness.tar.gz", "-C", path.basename(extracted)], { cwd: out });
  const archivedConfig = fs.readFileSync(
    path.join(extracted, ".claude", "mcp.json"),
    "utf8",
  );
  assert.ok(!archivedConfig.includes("opaque-"), "secret values must not reach the tarball");
  assert.ok(archivedConfig.includes(REDACTED), "the tarball carries redacted placeholders");
});

test("opaque state aliases are redacted from Claude settings, reports, and the final archive", (t) => {
  const secretValues = {
    secretPayload: "opaque-alias-secret-payload",
    sessionSnapshot: "opaque-alias-session-snapshot",
    accessTokenDigest: "opaque-alias-access-token-digest",
    credentialBackup: "opaque-alias-credential-backup",
    authSnapshot: "opaque-alias-auth-snapshot",
    oauthBackup: "opaque-alias-oauth-backup",
    tokenDigest: "opaque-alias-token-digest",
    cookieSnapshot: "opaque-alias-cookie-snapshot",
    passwordBackup: "opaque-alias-password-backup",
    keyDigest: "opaque-alias-key-digest",
    secretMaterial: "opaque-alias-secret-material",
    sessionSnapshots: "opaque-alias-session-snapshots",
    secretPayloads: "opaque-alias-secret-payloads",
    accessTokenDigests: "opaque-alias-access-token-digests",
    credentialBackups: "opaque-alias-credential-backups",
    authSnapshots: "opaque-alias-auth-snapshots",
    oauthBackups: "opaque-alias-oauth-backups",
    tokenDigests: "opaque-alias-token-digests",
    cookieSnapshots: "opaque-alias-cookie-snapshots",
    passwordBackups: "opaque-alias-password-backups",
    keyDigests: "opaque-alias-key-digests",
    secretMaterials: "opaque-alias-secret-materials",
  };
  const safeMetadata = {
    sessionSnapshotIntervalMs: 60_000,
    secretPayloadSchema: "v1",
    keyDigestAlgorithm: "SHA256",
    backupKeyId: "public-backup-key-id",
    keyCode: "Enter",
    keyRecord: "navigation",
  };
  const home = makeHome(t, {
    ".claude/settings.json": JSON.stringify({ ...secretValues, ...safeMetadata }),
  });
  const { out, res } = runPack(t, home, [
    "--no-hermes",
    "--no-codex",
    "--no-openclaw",
  ]);
  assertSucceeded(res);

  const stagedPath = path.join(out, "staging", ".claude", "settings.json");
  const staged = JSON.parse(fs.readFileSync(stagedPath, "utf8"));
  for (const key of Object.keys(secretValues)) {
    assert.equal(staged[key], REDACTED, `${key} must redact in staging`);
  }
  for (const [key, value] of Object.entries(safeMetadata)) {
    assert.equal(staged[key], value, `${key} must remain safe metadata`);
  }

  const manifestText = fs.readFileSync(path.join(out, "manifest.json"), "utf8");
  const reportText = fs.readFileSync(path.join(out, "compat-report.md"), "utf8");
  assert.ok(!manifestText.includes("opaque-alias-"), "secret aliases must not reach manifest.json");
  assert.ok(!reportText.includes("opaque-alias-"), "secret aliases must not reach compat-report.md");

  // Same relative-cwd form as above (see the note there).
  const extracted = fs.mkdtempSync(path.join(out, "alias-archive-check-"));
  t.after(() => fs.rmSync(extracted, { recursive: true, force: true }));
  execFileSync("tar", ["-xzf", "harness.tar.gz", "-C", path.basename(extracted)], { cwd: out });
  const archivedText = fs.readFileSync(
    path.join(extracted, ".claude", "settings.json"),
    "utf8",
  );
  assert.ok(!archivedText.includes("opaque-alias-"), "secret aliases must not reach the tarball");
  assert.ok(archivedText.includes(REDACTED), "the tarball carries redacted placeholders");
});

test("auth/session keys are redacted from the allowlisted Hermes channel directory", (t) => {
  const home = makeHome(t, {
    ".hermes/config.yaml": "agent:\n  name: fixture\n",
    ".hermes/channel_directory.json": JSON.stringify({
      channels: {
        fixture: {
          auth: "opaque-auth",
          session: { id: "opaque-session" },
          cookie: ["opaque-cookie"],
          pairing: "opaque-pairing",
        },
      },
    }),
  });
  const { out, res } = runPack(t, home, [
    "--dry-run",
    "--agent",
    "hermes",
    "--no-codex",
    "--no-openclaw",
  ]);
  assertSucceeded(res);

  const stagedPath = path.join(out, "staging", ".hermes", "channel_directory.json");
  const staged = JSON.parse(fs.readFileSync(stagedPath, "utf8"));
  assert.equal(staged.channels.fixture.auth, REDACTED);
  assert.equal(staged.channels.fixture.session.id, REDACTED);
  assert.equal(staged.channels.fixture.cookie[0], REDACTED);
  assert.equal(staged.channels.fixture.pairing, REDACTED);
});

test("broad Claude and Hermes trees fail closed on parserless configs and preserve clean JSON", (t) => {
  const unsafeStructuredFiles = {
    ".claude/plugins/fixture/config.yaml": "headers:\n  XPrivate: opaque-yaml\n",
    ".claude/skills/fixture/settings.toml": 'auth = "opaque-toml"\n',
    ".claude/plugins/fixture/settings.conf": "session=opaque-conf\n",
    ".claude/plugins/fixture/settings.ini": "cookie=opaque-ini\n",
    ".claude/plugins/fixture/settings.cfg": "token=opaque-cfg\n",
    ".hermes/plugins/fixture/settings.yml": "headers:\n  XPrivate: opaque-yml\n",
    ".hermes/skills/fixture/settings.properties": "auth=opaque-properties\n",
    ".hermes/plugins/fixture/settings.xml": "<auth>opaque-xml</auth>\n",
    ".hermes/plugins/fixture/settings.plist": "<plist><string>opaque-plist</string></plist>\n",
    ".hermes/plugins/fixture/settings.jsonc": '{"token":"opaque-jsonc"}\n',
    ".hermes/plugins/fixture/settings.json5": "{token:'opaque-json5'}\n",
    ".claude/plugins/fixture/providers.yaml": "api_key: opaque-provider-key\n",
    ".claude/plugins/fixture/providers.json": '{"apiKey":"opaque-provider-key"}\n',
    ".claude/plugins/fixture/opaque-state.json": JSON.stringify({
      sessionPayload: "opaque-generic-session-payload",
      oauthVerifier: "opaque-generic-oauth-verifier",
      cookieStoreV2: "opaque-generic-cookie-store",
      privateKeyBlob: "opaque-generic-private-key",
      credentialEnvelope: "opaque-generic-credential-envelope",
      authCode: "opaque-generic-auth-code",
      sessionTicket: "opaque-generic-session-ticket",
      tokenJwe: "opaque-generic-token-jwe",
      endpoint: "https://example.test/mcp?auth%5Btoken%5D=opaque-generic-query",
    }) + "\n",
    ".claude/plugins/fixture/nested-signed-url.json": JSON.stringify({
      endpoint: `https://outer.example/callback?next=${encodeURIComponent(encodeURIComponent(
        "https://storage.googleapis.com/bucket/object?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Credential=opaque-generic-gcs-access&X-Goog-Signature=opaque-generic-gcs-signature",
      ))}`,
    }) + "\n",
    ".claude/plugins/fixture/fully-encoded-signed-url.json": JSON.stringify({
      endpoint: encodeURIComponent(encodeURIComponent(
        "https://fixture.blob.core.windows.net/container/object?sv=2099-01-01&se=2099-01-01T00%3A00%3A00Z&sr=b&sp=r&sig=opaque-generic-azure-signature",
      )),
    }) + "\n",
    ".claude/plugins/fixture/mcp-client.json": '{"args":["--github-token","opaque-github-token"]}\n',
    ".hermes/plugins/fixture/command.json": '{"command":"curl -H X-API-Key:opaque-command https://example.test"}\n',
    ".hermes/plugins/fixture/userinfo.json": '{"endpoint":"https://opaque-userinfo@example.test/mcp"}\n',
    ".hermes/plugins/fixture/profile.ini": "token=opaque-profile-token\n",
    ".hermes/plugins/fixture/providers-headers.yaml": "requestHeaders:\n  X-Private: opaque-header\n",
    ".claude/agents/openai.yaml": "name: openai\napi_key_env: OPENAI_API_KEY\n",
    ".claude/plugins/fixture/overlay.yaml": "name: overlay\n",
    ".claude/plugins/fixture/plugin.yaml": "name: fixture\nversion: 1\n",
    ".claude/skills/fixture/pyproject.toml": "[project]\nname = \"fixture\"\n",
    ".hermes/plugins/fixture/docker-compose.yml": "services:\n  fixture:\n    environment:\n      OLLAMA_API_KEY: ${OLLAMA_API_KEY}\n",
  };
  const safeJsonFiles = {
    ".claude/plugins/fixture/marketplace.json": '{"authentication":{"type":"oauth2","scopes":["read"]}}\n',
    ".claude/plugins/fixture/package.json": '{"dependencies":{"@better-auth/api-key":"1.0.0","js-tokens":"9.0.0"}}\n',
    ".claude/plugins/fixture/benchmark.json": '{"mode":"multi-session","maxTokens":8192,"tokenizer":"cl100k_base","authorizationEndpoint":"https://example.test/oauth","oauthScopes":["read"]}\n',
    ".claude/plugins/fixture/openclaw.plugin.json": '{"token_budget":2048,"name":"fixture"}\n',
    ".claude/plugins/fixture/config-clean.json": '{"name":"fixture","enabled":true}\n',
  };
  const home = makeHome(t, {
    ".claude/plugins/fixture/config.json": JSON.stringify({
      token: "opaque-json-token",
      headers: { XPrivate: "opaque-json-header" },
      session: "opaque-json-session",
    }),
    ".claude/plugins/fixture/index.js": "export const fixture = true;\n",
    ".claude/skills/fixture/SKILL.md": "# Claude fixture\n",
    ".hermes/config.yaml": "agent:\n  name: fixture\n",
    ".hermes/plugins/fixture/config.json": JSON.stringify({
      auth: "opaque-hermes-auth",
      cookie: "opaque-hermes-cookie",
    }),
    ".hermes/plugins/fixture/index.js": "export const fixture = true;\n",
    ".hermes/skills/fixture/SKILL.md": "# Hermes fixture\n",
    ...unsafeStructuredFiles,
    ...safeJsonFiles,
  });
  const { out, res } = runPack(t, home, [
    "--yes",
    "--agent",
    "hermes",
    "--no-codex",
    "--no-openclaw",
  ]);
  assertSucceeded(res);

  for (const rel of [
    ".claude/plugins/fixture/config.json",
    ".hermes/plugins/fixture/config.json",
    ...Object.keys(unsafeStructuredFiles),
  ]) {
    assert.ok(
      !fs.existsSync(path.join(out, "staging", ...rel.split("/"))),
      `${rel} must be omitted rather than rewritten or shipped with credentials`,
    );
    assert.ok(
      !archiveEntries(out).some((entry) => entry.endsWith(rel)),
      `${rel} must not enter harness.tar.gz`,
    );
  }
  for (const [rel, expected] of Object.entries(safeJsonFiles)) {
    assert.equal(
      fs.readFileSync(path.join(out, "staging", ...rel.split("/")), "utf8"),
      expected,
      `${rel} is ordinary plugin/project data and must remain byte-identical`,
    );
  }
  for (const rel of [
    ".claude/plugins/fixture/index.js",
    ".claude/skills/fixture/SKILL.md",
    ".hermes/plugins/fixture/index.js",
    ".hermes/skills/fixture/SKILL.md",
  ]) {
    assert.ok(fs.existsSync(path.join(out, "staging", ...rel.split("/"))), `${rel} remains migratable`);
  }
  const manifestText = fs.readFileSync(path.join(out, "manifest.json"), "utf8");
  const reportText = fs.readFileSync(path.join(out, "compat-report.md"), "utf8");
  for (const output of [manifestText, reportText]) {
    assert.ok(
      !output.includes("opaque-generic-"),
      "generic plugin credential-state values must not reach operator outputs",
    );
  }
  const manifest = JSON.parse(manifestText);
  assert.ok(
    manifest.flags.some((flag) =>
      /structured config.*skipped|structured credential value.*no safe parser/i.test(flag)
    ),
    `manifest explains the structured-config omissions: ${JSON.stringify(manifest.flags)}`,
  );
  assert.ok(
    manifest.securityOmissions.some((entry) => /openai\.yaml$/.test(entry.path)),
    `normal output has a machine-readable list of every safety omission: ${JSON.stringify(manifest.securityOmissions)}`,
  );
  assert.ok(
    manifest.securityOmissions.some((entry) => /opaque-state\.json$/.test(entry.path)),
    `generic plugin credential state has an explicit safety omission: ${JSON.stringify(manifest.securityOmissions)}`,
  );
});

test("malformed Claude, Hermes, and MCP JSON is omitted rather than packed unchanged", (t) => {
  const home = makeHome(t, {
    ".claude/settings.json": '{"hooks": ',
    ".claude/mcp.json": '{"mcpServers": ',
    ".claude/mcp-configs/broken.json": '{"env": ',
    ".claude/mcp-configs/nested/deeper/broken.json": '{"headers": ',
    ".hermes/config.yaml": "agent:\n  name: fixture\n",
    ".hermes/channel_directory.json": '{"channels": ',
  });
  const { out, res } = runPack(t, home, [
    "--dry-run",
    "--agent",
    "hermes",
    "--no-codex",
    "--no-openclaw",
  ]);
  assertSucceeded(res);

  const omitted = [
    ".claude/settings.json",
    ".claude/mcp.json",
    ".claude/mcp-configs/broken.json",
    ".claude/mcp-configs/nested/deeper/broken.json",
    ".hermes/channel_directory.json",
  ];
  for (const rel of omitted) {
    assert.ok(
      !fs.existsSync(path.join(out, "staging", ...rel.split("/"))),
      `${rel} must be removed from staging after JSON parsing fails`,
    );
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
  const flags = manifest.flags.join("\n");
  for (const label of [
    "settings.json",
    "mcp.json",
    "mcp-configs/broken.json",
    "mcp-configs/nested/deeper/broken.json",
    ".hermes/channel_directory.json",
  ]) {
    assert.ok(flags.includes(label), `manifest explains why ${label} was omitted`);
  }
  assert.match(
    flags,
    /could not parse|invalid json/i,
    "manifest identifies malformed JSON as the reason for omission",
  );
});

test("Hermes config and local dotenv are omitted without reading credential values", (t) => {
  const home = makeHome(t, {
    ".hermes/config.yaml": 'mcp_servers:\n  fixture:\n    headers: { X-Private: "unterminated }\n',
    ".hermes/.env": 'SAFE_NAME="unterminated\nopaque-unparsed-line\n',
  });
  const { out, res } = runPack(t, home, [
    "--dry-run",
    "--agent",
    "hermes",
    "--no-codex",
    "--no-openclaw",
  ]);
  assertSucceeded(res);

  for (const rel of [".hermes/config.yaml", ".hermes/.env"]) {
    assert.ok(
      !fs.existsSync(path.join(out, "staging", ...rel.split("/"))),
      `${rel} must stay local`,
    );
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
  const flags = manifest.flags.join("\n");
  assert.match(flags, /Hermes config\.yaml.*not migrated.*full parser/i);
  assert.match(flags, /Hermes \.env not migrated.*does not read credential files/i);
  assert.ok(!JSON.stringify(manifest).includes("opaque-unparsed-line"));
});

test("Hermes config.yaml is fail-closed for every unsupported YAML shape", async (t) => {
  const cases = {
    "quoted carrier key": '"headers":\n  X-Private: opaque-quoted-value\n',
    "alias carrying headers": "shared: &private\n  X-Private: opaque-alias-value\nheaders: *private\n",
    "array carrier": "headers:\n  - X-Private: opaque-array-value\n",
    "flow map": "headers: { X-Private: opaque-flow-value }\n",
    "malformed indentation": "headers:\n X-Private: opaque-indent-value\n  nested: broken\n",
    "missing separator": "headers:\n  X-Private opaque-missing-separator-value\n",
  };

  for (const [label, config] of Object.entries(cases)) {
    await t.test(label, () => {
      const home = makeHome(t, {
        ".hermes/config.yaml": config,
        ".hermes/.env": "SAFE_NAME=opaque-env-value\n",
      });
      const { out, res } = runPack(t, home, [
        "--dry-run",
        "--agent",
        "hermes",
        "--no-codex",
        "--no-openclaw",
      ]);
      assertSucceeded(res);
      assert.ok(
        !fs.existsSync(path.join(out, "staging", ".hermes", "config.yaml")),
        `${label}: config.yaml must not migrate without a real YAML parser`,
      );
      const stagedText = fs.existsSync(path.join(out, "staging"))
        ? fs.readdirSync(path.join(out, "staging"), { recursive: true })
          .map((entry) => path.join(out, "staging", String(entry)))
          .filter((entry) => fs.existsSync(entry) && fs.statSync(entry).isFile())
          .map((entry) => fs.readFileSync(entry, "utf8"))
          .join("\n")
        : "";
      assert.ok(!stagedText.includes("opaque-"), `${label}: no fixture secret reaches staging`);
      const manifest = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
      assert.ok(
        manifest.flags.some((flag) => /Hermes config\.yaml.*not migrated|config\.yaml.*recreate/i.test(flag)),
        `${label}: manifest explains the fail-closed omission`,
      );
    });
  }
});

test("a possible secret is omitted while the safe remainder still archives", (t) => {
  const shapedSecret = "sk-ant-" + "A".repeat(32);
  const home = makeHome(t, {
    ".claude/skills/leaky/SKILL.md": `# fixture\nexample=${shapedSecret}\n`,
    ".claude/skills/leaky/demo.mp4": Buffer.alloc((8 * 1024 * 1024) + 1),
  });
  const { out, res } = runPack(t, home, [
    "--yes",
    "--no-hermes",
    "--no-codex",
    "--no-openclaw",
  ]);

  assertSucceeded(res);
  assert.ok(fs.existsSync(path.join(out, "manifest.json")), "manifest remains available for local review");
  assert.ok(fs.existsSync(path.join(out, "compat-report.md")), "compatibility report remains available for local review");
  assert.ok(fs.existsSync(path.join(out, "harness.tar.gz")), "the safe remainder writes a tarball");
  assert.ok(!fs.existsSync(path.join(out, "staging", ".claude", "skills", "leaky", "SKILL.md")));
  assert.ok(!fs.existsSync(path.join(out, "staging", ".claude", "skills", "leaky", "demo.mp4")));
  assert.ok(!archiveEntries(out).some((entry) => entry.endsWith(".claude/skills/leaky/SKILL.md")));
  assert.ok(!archiveEntries(out).some((entry) => entry.endsWith(".claude/skills/leaky/demo.mp4")));

  const manifest = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
  assert.match(manifest.archiveSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(manifest.possibleSecrets, []);
  assert.ok(
    manifest.securityOmissions.some((entry) =>
      entry.path.replaceAll("\\", "/").includes(".claude/skills/leaky/SKILL.md")
      && /anthropic-key/i.test(entry.reason)
    ),
    "manifest points to the file omitted by the gate",
  );
  assert.ok(
    manifest.securityOmissions.some((entry) =>
      entry.path.replaceAll("\\", "/").includes(".claude/skills/leaky/demo.mp4")
      && /exceeds.*audit limit/i.test(entry.reason)
    ),
    "manifest names an unscannable large file that was omitted",
  );
  const report = fs.readFileSync(path.join(out, "compat-report.md"), "utf8");
  assert.ok(report.includes("leaky/SKILL.md"), "report points to the file that triggered the gate");
});

test("a staging mutation after the first scan is caught by the exact-archive audit", async (t) => {
  const home = makeHome(t, {
    "project/000-target.txt": "safe-before-scan\n",
  });
  const project = path.join(home, "project");
  for (let i = 0; i < 2000; i++) {
    fs.writeFileSync(path.join(project, `middle-${String(i).padStart(5, "0")}.txt`), "safe\n");
  }
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-pack-race-out-"));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const stagedTarget = path.join(out, "staging", "project", "000-target.txt");
  const tarball = path.join(out, "harness.tar.gz");
  const shapedSecret = "sk-ant-" + "R".repeat(32);
  const watcher = spawn(
    process.execPath,
    [
      "-e",
      [
        "const fs=require('fs');",
        "const [archive,target,secret]=process.argv.slice(1);",
        "const timer=setInterval(()=>{if(fs.existsSync(archive)){clearInterval(timer);fs.writeFileSync(target,secret+'\\n');process.exit(0);}},1);",
        "setTimeout(()=>{clearInterval(timer);process.exit(2);},120000);",
      ].join(""),
      tarball,
      stagedTarget,
      shapedSecret,
    ],
    { stdio: "ignore" },
  );
  t.after(() => { if (!watcher.killed) watcher.kill(); });
  const watcherExit = new Promise((resolve) => watcher.once("exit", resolve));

  const res = spawnSync(
    process.execPath,
    [
      PACK_MJS,
      "--out",
      out,
      "--no-discovery",
      "--yes",
      "--no-hermes",
      "--no-codex",
      "--no-openclaw",
      "--include",
      project,
    ],
    {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: "utf8",
      timeout: 120000,
    },
  );
  await watcherExit;

  assert.notEqual(res.status, 0, `raced archive must fail closed\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.ok(!fs.existsSync(path.join(out, "harness.tar.gz")), "the raced tarball is removed");
  const manifest = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
  assert.equal(manifest.tarball, null);
  assert.ok(
    manifest.possibleSecrets.some((entry) => /staging-mutated|archive:.*anthropic-key/i.test(entry)),
    `manifest identifies the exact-archive race: ${JSON.stringify(manifest.possibleSecrets)}`,
  );
});

test("a possible secret added by a curated pack is omitted from the archive", (t) => {
  const fakeRepo = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-pack-curated-fixture-"));
  t.after(() => fs.rmSync(fakeRepo, { recursive: true, force: true }));
  fs.mkdirSync(path.join(fakeRepo, "scripts"), { recursive: true });
  fs.copyFileSync(PACK_MJS, path.join(fakeRepo, "scripts", "pack.mjs"));
  fs.copyFileSync(
    path.join(REPO_ROOT, "scripts", "pack-lib.mjs"),
    path.join(fakeRepo, "scripts", "pack-lib.mjs"),
  );
  fs.mkdirSync(path.join(fakeRepo, "src"), { recursive: true });
  fs.copyFileSync(
    path.join(REPO_ROOT, "src", "child-env.js"),
    path.join(fakeRepo, "src", "child-env.js"),
  );
  writeTree(fakeRepo, {
    "packs/leaky/skills/fixture/SKILL.md": [
      "# fixture",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "opaque",
      "",
    ].join("\n"),
  });

  const home = makeHome(t);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-pack-curated-out-"));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const res = spawnSync(
    process.execPath,
    [
      path.join(fakeRepo, "scripts", "pack.mjs"),
      "--out",
      out,
      "--no-discovery",
      "--yes",
      "--no-hermes",
      "--no-codex",
      "--no-openclaw",
      "--pack",
      "leaky",
    ],
    {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: "utf8",
    },
  );

  assertSucceeded(res);
  assert.ok(fs.existsSync(path.join(out, "harness.tar.gz")), "the safe remainder still archives");
  assert.ok(!fs.existsSync(path.join(out, "staging", ".claude", "skills", "fixture", "SKILL.md")));
  assert.ok(!archiveEntries(out).some((entry) => entry.endsWith(".claude/skills/fixture/SKILL.md")));
  const manifest = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
  assert.ok(
    manifest.securityOmissions.some((entry) =>
      /fixture\/SKILL\.md/i.test(entry.path) && /private-key/i.test(entry.reason)
    ),
    `manifest identifies the curated-pack omission: ${JSON.stringify(manifest.securityOmissions)}`,
  );
});

test("hard-linked aliases in curated packs are rejected before the final archive", (t) => {
  const fakeRepo = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-pack-hardlink-fixture-"));
  t.after(() => fs.rmSync(fakeRepo, { recursive: true, force: true }));
  fs.mkdirSync(path.join(fakeRepo, "scripts"), { recursive: true });
  fs.copyFileSync(PACK_MJS, path.join(fakeRepo, "scripts", "pack.mjs"));
  fs.copyFileSync(
    path.join(REPO_ROOT, "scripts", "pack-lib.mjs"),
    path.join(fakeRepo, "scripts", "pack-lib.mjs"),
  );
  fs.mkdirSync(path.join(fakeRepo, "src"), { recursive: true });
  fs.copyFileSync(
    path.join(REPO_ROOT, "src", "child-env.js"),
    path.join(fakeRepo, "src", "child-env.js"),
  );
  writeTree(fakeRepo, {
    "packs/leaky/.credentials.json": '{"session":"opaque-short-value"}\n',
    "packs/leaky/skills/fixture/auth.json": '{"auth":"opaque-short-value"}\n',
  });
  const protectedPath = path.join(fakeRepo, "packs", "leaky", ".credentials.json");
  const aliasPath = path.join(fakeRepo, "packs", "leaky", "skills", "fixture", "SKILL.md");
  fs.mkdirSync(path.dirname(aliasPath), { recursive: true });
  try {
    fs.linkSync(protectedPath, aliasPath);
  } catch (error) {
    t.skip(`hard links are unavailable on this filesystem (${error.code || error.message})`);
    return;
  }

  const home = makeHome(t);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-pack-curated-hardlink-out-"));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const res = spawnSync(
    process.execPath,
    [
      path.join(fakeRepo, "scripts", "pack.mjs"),
      "--out",
      out,
      "--no-discovery",
      "--yes",
      "--no-hermes",
      "--no-codex",
      "--no-openclaw",
      "--pack",
      "leaky",
    ],
    {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: "utf8",
    },
  );
  assertSucceeded(res);
  assert.ok(
    !fs.existsSync(path.join(out, "staging", ".claude", "skills", "fixture", "SKILL.md")),
    "curated-pack hard-link alias must not enter staging",
  );
  assert.ok(
    !fs.existsSync(path.join(out, "staging", ".claude", "skills", "fixture", "auth.json")),
    "curated-pack credential carrier must pass through the same filename gate",
  );
  assert.ok(
    !archiveEntries(out).some((entry) => entry.endsWith("skills/fixture/SKILL.md")),
    "curated-pack hard-link alias must not enter harness.tar.gz",
  );
  const manifest = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
  assert.ok(
    manifest.flags.some((flag) => /hard.?link/i.test(flag)),
    `manifest explains the curated hard-link rejection: ${JSON.stringify(manifest.flags)}`,
  );
});

test("Codex config.toml never migrates, including via --include, while instructions and prompts do", (t) => {
  const home = makeHome(t, {
    ".codex/AGENTS.md": "# Agent instructions\n",
    ".codex/prompts/review.md": "# Review prompt\n",
    ".codex/config.toml": [
      '["model_providers"."gateway"."http_headers"]',
      '"Authorization" = "opaque-header-value-that-must-not-migrate"',
      "[mcp_servers.fixture.env]",
      'values = ["opaque-one", "opaque-two"]',
      "",
    ].join("\n"),
  });
  const configPath = path.join(home, ".codex", "config.toml");
  const { out, res } = runPack(t, home, [
    "--dry-run",
    "--no-hermes",
    "--no-openclaw",
    "--include",
    configPath,
  ]);
  assertSucceeded(res);

  const codexStaging = path.join(out, "staging", ".codex");
  assert.ok(!fs.existsSync(path.join(codexStaging, "config.toml")), "Codex config.toml is never staged");
  assert.equal(fs.readFileSync(path.join(codexStaging, "AGENTS.md"), "utf8"), "# Agent instructions\n");
  assert.equal(fs.readFileSync(path.join(codexStaging, "prompts", "review.md"), "utf8"), "# Review prompt\n");
  const manifest = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
  assert.ok(!manifest.codex.included.some((entry) => entry.includes("config.toml")));
  assert.ok(manifest.codex.included.includes("AGENTS.md"));
  assert.ok(manifest.codex.included.includes("prompts/"));
});

test("packHarness forwards every agent opt-out to the raw packer", (t) => {
  const home = makeHome(t, {
    ".hermes/config.yaml": "agent:\n  name: fixture\n",
    ".codex/AGENTS.md": "# Codex fixture\n",
    ".openclaw/openclaw.json": '{"version":1}\n',
  });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-pack-wrapper-out-"));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));

  const prior = Object.fromEntries(
    ["HOME", "USERPROFILE", "HERMES_HOME", "CODEX_HOME", "OPENCLAW_HOME"].map((key) => [key, process.env[key]])
  );
  Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    HERMES_HOME: path.join(home, ".hermes"),
    CODEX_HOME: path.join(home, ".codex"),
    OPENCLAW_HOME: path.join(home, ".openclaw"),
  });
  t.after(() => {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const { manifest } = packHarness({
    outDir: out,
    dryRun: true,
    noHermes: true,
    noCodex: true,
    noOpenclaw: true,
  });
  assert.deepEqual(manifest.codex.included, []);
  assert.deepEqual(manifest.openclaw.included, []);
  assert.ok(!fs.existsSync(path.join(out, "staging", ".hermes")));
  assert.ok(!fs.existsSync(path.join(out, "staging", ".codex")));
  assert.ok(!fs.existsSync(path.join(out, "staging", ".openclaw")));
});

test("OpenClaw config symlinked outside its harness is omitted", (t) => {
  const home = makeHome(t);
  const openclawDir = path.join(home, ".openclaw");
  fs.mkdirSync(openclawDir, { recursive: true });
  const externalConfig = path.join(home, "outside-openclaw.json");
  fs.writeFileSync(externalConfig, JSON.stringify({
    version: "fixture",
    agents: { entries: [{ name: "external", model: "fixture", workspace: "/tmp" }] },
  }));
  const configLink = path.join(openclawDir, "openclaw.json");
  try {
    fs.symlinkSync(externalConfig, configLink, "file");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
      t.skip(`file symlinks are unavailable on this machine (${error.code})`);
      return;
    }
    throw error;
  }

  const { out, res } = runPack(t, home, [
    "--dry-run",
    "--no-hermes",
    "--no-codex",
  ]);
  assertSucceeded(res);
  assert.ok(
    !fs.existsSync(path.join(out, "staging", ".openclaw", "openclaw.json")),
    "OpenClaw must not dereference a config symlink outside OPENCLAW_HOME",
  );
  const manifest = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
  assert.ok(
    manifest.flags.some((flag) => /openclaw.*external symlink|external symlink.*openclaw/i.test(flag)),
    `manifest records the skipped external symlink: ${JSON.stringify(manifest.flags)}`,
  );
});
