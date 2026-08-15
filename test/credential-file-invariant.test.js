import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const CLI = path.join(ROOT, "bin", "cli.js");
const unsupportedFlag = "--migrate-auth";
const legacySecret = "CLAUDE_CREDENTIALS";

function fixtureHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-auth-invariant-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "CLAUDE.md"), "# fixture harness\n");
  return home;
}

function runCli(args, home = undefined, envOverrides = {}) {
  const isolatedHome = home || os.tmpdir();
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      CODEX_HOME: path.join(isolatedHome, ".missing-codex"),
      HERMES_HOME: path.join(isolatedHome, ".missing-hermes"),
      OPENCLAW_HOME: path.join(isolatedHome, ".missing-openclaw"),
      ...envOverrides,
    },
  });
}

function packTempDirs() {
  return fs.readdirSync(os.tmpdir())
    .filter((name) => /^agenthost-pack-[A-Za-z0-9]{6}$/.test(name))
    .sort();
}

test("CLI help exposes only environment-backed explicit Claude auth values", () => {
  const result = runCli(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stdout.includes(unsupportedFlag), "credential-file migration must not appear in help");
  assert.ok(!result.stdout.includes("--with-whatsapp"), "Hermes session migration must not appear in help");
  assert.match(result.stdout, /--oauth-token-env/);
  assert.match(result.stdout, /--anthropic-key-env/);
  assert.match(result.stdout, /AGENTHOST_CLAUDE_CODE_OAUTH_TOKEN/);
  assert.match(result.stdout, /AGENTHOST_ANTHROPIC_API_KEY/);
  assert.match(result.stdout, /--no-hermes/);
  assert.match(result.stdout, /--no-codex/);
  assert.match(result.stdout, /--no-openclaw/);
  assert.match(result.stdout, /Credential and session files never migrate/);
});

test("every secret-value argv form is rejected before work and never echoed", () => {
  const sentinel = "argv-secret-sentinel-must-not-echo";
  const cases = [
    ["deploy", "--oauth-token", sentinel],
    ["deploy", `--oauth-token=${sentinel}`],
    ["deploy", "--anthropic-key", sentinel],
    ["deploy", "--github-token", sentinel],
    ["deploy", "--env", `owner/repo:PRIVATE=${sentinel}`],
    ["bridge", "27123", "--token", sentinel],
  ];

  for (const args of cases) {
    const result = runCli(args);
    assert.equal(result.status, 1, `${args[0]} accepted a secret-bearing argv form`);
    assert.match(result.stderr, /secret values? on (?:the )?command line.*not supported/i);
    assert.ok(!`${result.stdout}\n${result.stderr}`.includes(sentinel));
    assert.doesNotMatch(result.stdout, /Packing harness|Publishing 127\.0\.0\.1/);
  }
});

test("secret selector flags reject attached values without echoing them", () => {
  const sentinel = "selector-value-sentinel-must-not-echo";
  for (const flag of [
    "--oauth-token-env",
    "--anthropic-key-env",
    "--github-token-env",
    "--token-env",
  ]) {
    const result = runCli(["deploy", `${flag}=${sentinel}`]);
    assert.equal(result.status, 1, `${flag} unexpectedly accepted an attached value`);
    assert.match(result.stderr, /selector flags do not take command-line values/i);
    assert.ok(!`${result.stdout}\n${result.stderr}`.includes(sentinel));
    assert.doesNotMatch(result.stdout, /Packing harness|Publishing 127\.0\.0\.1/);
  }
});

test("secret selector flags reject separate values before any work and never echo them", () => {
  for (const sentinel of [
    "separate-selector-secret-must-not-echo",
    "--dash-prefixed-selector-secret-must-not-echo",
  ]) {
    const cases = [
      ["deploy", "--oauth-token-env", sentinel, "--dry-run"],
      ["deploy", "--anthropic-key-env", sentinel, "--dry-run"],
      ["deploy", "--github-token-env", sentinel, "--dry-run"],
      ["sync", "--github-token-env", sentinel, "--dry-run"],
      ["bridge", "--token-env", sentinel, "--app", "fixture-app"],
    ];

    for (const args of cases) {
      const result = runCli(args);
      assert.equal(result.status, 1, `${args[1]} unexpectedly accepted a separate value`);
      assert.match(result.stderr, /selector flags do not take command-line values|unknown option/i);
      assert.ok(!`${result.stdout}\n${result.stderr}`.includes(sentinel));
      assert.doesNotMatch(result.stdout, /Packing harness|Publishing 127\.0\.0\.1/);
    }
  }
});

test("unexpected positionals fail generically before deploy, sync, or bridge work", () => {
  const sentinel = "unexpected-positional-secret-must-not-echo";
  for (const args of [
    ["deploy", sentinel, "--dry-run"],
    ["sync", sentinel, "--dry-run"],
    ["bridge", sentinel, "--token-env"],
    ["bridge", "27123", sentinel, "--no-token"],
    ["bridge", "--status", sentinel],
  ]) {
    const result = runCli(args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unexpected positional argument|invalid bridge port/i);
    assert.ok(!`${result.stdout}\n${result.stderr}`.includes(sentinel));
    assert.doesNotMatch(result.stdout, /Packing harness|Publishing 127\.0\.0\.1/);
  }
});

test("command-position secret flags and unknown commands never echo raw argv", () => {
  const sentinel = "command-position-secret-must-not-echo";
  for (const args of [
    [`--oauth-token=${sentinel}`],
    ["--oauth-token", sentinel],
    [`--token-env=${sentinel}`],
  ]) {
    const result = runCli(args);
    assert.equal(result.status, 1);
    assert.ok(!`${result.stdout}\n${result.stderr}`.includes(sentinel));
  }

  const unknown = runCli([sentinel]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown command/i);
  assert.ok(!`${unknown.stdout}\n${unknown.stderr}`.includes(sentinel));
});

test("legacy spike deployment accepts no secret values in parameters or child argv", () => {
  const spike = fs.readFileSync(path.join(ROOT, "scripts", "spike-deploy.ps1"), "utf8");
  const activation = fs.readFileSync(
    path.join(ROOT, "docs", "claude-maintenance-mode", "ACTIVATION-NEXT-STEPS-2026-07-24.md"),
    "utf8",
  );
  const helper = fs.readFileSync(path.join(ROOT, "scripts", "stage-secrets-stdin.mjs"), "utf8");

  assert.doesNotMatch(spike, /\[string\]\$(?:OauthToken|AnthropicKey|GithubToken)\b/);
  assert.doesNotMatch(spike, /(?:CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|GITHUB_TOKEN)=\$/);
  assert.doesNotMatch(spike, /&\s*\$fly\s+secrets\s+set/i);
  assert.match(spike, /\[switch\]\$(?:UseOauthTokenEnv|UseAnthropicKeyEnv|UseGithubTokenEnv)\b/);
  assert.doesNotMatch(spike, /\[switch\]\$(?:OauthTokenEnv|AnthropicKeyEnv|GithubTokenEnv)\b/);
  assert.match(spike, /CmdletBinding\(PositionalBinding=\$false\)/);
  assert.match(spike, /ValueFromRemainingArguments=\$true/);
  assert.match(spike, /stage-secrets-stdin\.mjs/);
  assert.doesNotMatch(spike, /HarnessTarball|COPY harness\.tar\.gz|Copy-Item[^\r\n]*harness\.tar\.gz/i);
  assert.match(spike, /shell-only/i);
  assert.match(helper, /for await \(const chunk of process\.stdin\)/);
  assert.match(helper, /await stageSecrets\(/);
  assert.doesNotMatch(activation, /-OauthToken\s+["<]/);
  assert.match(activation, /-UseOauthTokenEnv/);
  assert.match(activation, /shell-only.*audited.*agenthost (?:deploy|sync)/is);

  const firstFlyChild = spike.indexOf("& $fly");
  const environmentScrub = spike.indexOf("Get-ChildItem Env:");
  assert.ok(environmentScrub >= 0 && environmentScrub < firstFlyChild);
  assert.match(spike, /FLY_API_TOKEN/);
  assert.match(spike, /AGENTHOST_CLAUDE_CODE_OAUTH_TOKEN/);
  assert.match(spike, /\$childEnvironmentNames -notcontains \$_\.Name/);
});

test("PowerShell rejects every legacy abbreviated secret switch without echo or child work", (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows PowerShell parameter binding regression");
    return;
  }
  const powershell = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const spike = path.join(ROOT, "scripts", "spike-deploy.ps1");
  const sentinel = "legacy-powershell-secret-must-not-echo";
  for (const flag of ["-OauthToken", "-AnthropicKey", "-GithubToken"]) {
    const result = spawnSync(
      powershell,
      ["-NoProfile", "-File", spike, "-App", "fixture-app", flag, sentinel],
      { cwd: ROOT, encoding: "utf8", timeout: 30_000 },
    );
    assert.notEqual(result.status, 0, `${flag} unexpectedly bound to a new switch`);
    assert.ok(!`${result.stdout}\n${result.stderr}`.includes(sentinel));
    assert.doesNotMatch(result.stdout, /== 1\/5|Terminal login/);
  }
});

test("PowerShell spike rejects the retired harness-tarball path before Fly child work", (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows PowerShell retired harness-path regression");
    return;
  }
  const powershell = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-spike-retired-harness-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const marker = path.join(fixture, "fly-child-ran");
  const flyPath = path.join(fixture, "flyctl.cmd");
  const tarball = path.join(fixture, "audited-then-swapped.tar.gz");
  fs.writeFileSync(flyPath, `@echo off\r\ntype nul > "${marker}"\r\nexit /b 0\r\n`);
  fs.writeFileSync(tarball, "post-audit replacement");

  const result = spawnSync(
    powershell,
    [
      "-NoProfile", "-File", path.join(ROOT, "scripts", "spike-deploy.ps1"),
      "-App", "fixture-app", "-HarnessTarball", tarball,
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, FLYCTL_PATH: flyPath },
    },
  );
  assert.notEqual(result.status, 0, "the retired harness-bearing spike path must fail closed");
  assert.ok(!fs.existsSync(marker), "Fly must not run after a retired harness argument");
  assert.doesNotMatch(result.stdout, /== 1\/5|Terminal login/);
});

test("PowerShell spike children inherit Fly auth but no caller or provider secrets", (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows PowerShell child-environment regression");
    return;
  }
  const powershell = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-spike-env-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const logPath = path.join(fixture, "child-env.json");
  const probePath = path.join(fixture, "probe.cjs");
  const flyPath = path.join(fixture, "flyctl.cmd");
  const names = [
    "FLY_API_TOKEN",
    "AGENTHOST_CLAUDE_CODE_OAUTH_TOKEN",
    "AGENTHOST_BRIDGE_TOKEN",
    "AGENTHOST_SECRET_REPO_PRIVATE",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "CALLER_SECRET",
    "FLYCTL_PATH",
  ];
  fs.writeFileSync(
    probePath,
    `const fs=require("fs");const names=${JSON.stringify(names)};` +
      `fs.writeFileSync(${JSON.stringify(logPath)},JSON.stringify(Object.fromEntries(` +
      `names.map((name)=>[name,process.env[name]??null]))));process.exit(42);\n`,
  );
  fs.writeFileSync(
    flyPath,
    `@echo off\r\n"${process.execPath}" "${probePath}" %*\r\nexit /b %ERRORLEVEL%\r\n`,
  );

  const selected = "selected-oauth-must-not-reach-child";
  const unrelated = "unrelated-secret-must-not-reach-child";
  const result = spawnSync(
    powershell,
    [
      "-NoProfile", "-File", path.join(ROOT, "scripts", "spike-deploy.ps1"),
      "-App", "fixture-app", "-UseOauthTokenEnv",
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        FLYCTL_PATH: flyPath,
        FLY_API_TOKEN: "fly-auth-preserved",
        AGENTHOST_CLAUDE_CODE_OAUTH_TOKEN: selected,
        AGENTHOST_BRIDGE_TOKEN: unrelated,
        AGENTHOST_SECRET_REPO_PRIVATE: unrelated,
        ANTHROPIC_API_KEY: unrelated,
        OPENAI_API_KEY: unrelated,
        CALLER_SECRET: unrelated,
      },
    },
  );
  assert.notEqual(result.status, 0, "probe flyctl intentionally stops the script");
  assert.ok(fs.existsSync(logPath), result.stderr);
  const child = JSON.parse(fs.readFileSync(logPath, "utf8"));
  assert.equal(child.FLY_API_TOKEN, "fly-auth-preserved");
  for (const name of names.slice(1)) assert.equal(child[name], null, `${name} leaked to a child`);
  assert.ok(!`${result.stdout}\n${result.stderr}`.includes(selected));
  assert.ok(!`${result.stdout}\n${result.stderr}`.includes(unrelated));
});

test("stdin secret staging helper rejects malformed input without echoing it", () => {
  const sentinel = "stdin-secret-must-not-echo";
  const result = spawnSync(
    process.execPath,
    [path.join(ROOT, "scripts", "stage-secrets-stdin.mjs")],
    { input: `{\"broken\":\"${sentinel}\"`, encoding: "utf8", cwd: ROOT },
  );
  assert.equal(result.status, 1);
  assert.ok(!`${result.stdout}\n${result.stderr}`.includes(sentinel));
  assert.match(result.stderr, /invalid secret staging input/i);
});

test("every legacy credential-file option form fails before deploy or sync can do work", () => {
  for (const command of ["deploy", "sync"]) {
    for (const retired of [unsupportedFlag, `${unsupportedFlag}=true`, `${unsupportedFlag}=fixture`]) {
      const result = runCli([command, retired, "--dry-run"]);
      assert.equal(result.status, 1, `${command} unexpectedly accepted ${retired}`);
      assert.match(result.stderr, /Credential-file migration is not supported/);
      assert.doesNotMatch(result.stdout, /Packing harness/);
      assert.doesNotMatch(result.stdout, /would create|would redeploy/);
    }
  }
});

function referenceFiles(needle) {
  const textExtensions = new Set([".cjs", ".html", ".js", ".json", ".md", ".mjs", ".ps1", ".sh", ".toml", ".txt", ".yaml", ".yml"]);
  const hits = [];

  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(file);
      } else if (textExtensions.has(path.extname(entry.name).toLowerCase())) {
        const text = fs.readFileSync(file, "utf8");
        if (text.includes(needle)) hits.push(path.relative(ROOT, file).replaceAll("\\", "/"));
      }
    }
  }

  visit(ROOT);
  return hits.sort();
}

test("retired credential markers remain only in the rejection, cleanup, and regression guards", () => {
  assert.deepEqual(referenceFiles(unsupportedFlag), [
    "bin/cli.js",
    "scripts/pack.mjs",
    "test/credential-file-invariant.test.js",
    "test/hermes-pack.test.js",
  ]);
  assert.deepEqual(referenceFiles(legacySecret), [
    "container/entrypoint.sh",
    "src/commands/deploy.js",
    "src/commands/sync.js",
    "src/fly.js",
    "test/credential-file-invariant.test.js",
    "test/fly-secrets.test.js",
  ]);

  const start = fs.readFileSync(path.join(ROOT, "container", "start.sh"), "utf8");
  const entrypoint = fs.readFileSync(path.join(ROOT, "container", "entrypoint.sh"), "utf8");
  assert.doesNotMatch(
    start,
    /base64\s+-d[\s\S]{0,240}\.credentials\.json/,
    "container boot must never restore a credentials file from an encoded secret",
  );
  assert.doesNotMatch(
    start,
    /AGENTHOST_PURGE_LEGACY_CLAUDE_CREDENTIALS/,
    "the agent-side process must not control the root cleanup",
  );
  assert.match(
    entrypoint,
    /AGENTHOST_PURGE_LEGACY_CLAUDE_CREDENTIALS/,
    "the root entrypoint owns the non-value purge control",
  );
  assert.match(
    entrypoint,
    /rm -f -- "\$LEGACY_CLAUDE_CREDENTIAL_FILE"/,
    "the root-owned purge removes only the legacy restored file",
  );
  assert.match(
    entrypoint,
    /LEGACY_CLAUDE_PURGE_MARKER/,
    "the purge writes a durable root-owned completion marker on the persistent volume",
  );
  assert.match(
    entrypoint,
    /install -o root -g root -m 0600 \/dev\/null "\$LEGACY_CLAUDE_PURGE_MARKER"/,
    "the durable marker is inaccessible to the agent user",
  );
});

test("published security claims do not advertise any credential-file opt-in", () => {
  const claimFiles = [
    "marketing/whitepaper/AGENTHOST-BLAST-RADIUS.md",
    "marketing/webinar/WEBINAR-QA.md",
    "marketing/webinar/build-webinar-deck.mjs",
    "marketing/research/honest-claims.json",
    "marketing/webinar/research/honesty-audit.md",
    "marketing/build/body.html",
    "marketing/artifacts/whitepaper.html",
    "marketing/build/whitepaper.html",
    "marketing/investor-deck/build-investor-deck-v5.mjs",
  ];
  const retiredClaims = [
    /unless (?:you|the user) explicitly opt(?:s)? in/i,
    /explicit auth[- ]migration (?:option|opt-in)/i,
    /credential files? (?:are )?excluded by default/i,
  ];

  for (const rel of claimFiles) {
    const text = fs.readFileSync(path.join(ROOT, ...rel.split("/")), "utf8");
    for (const claim of retiredClaims) {
      assert.doesNotMatch(text, claim, `${rel} still promises a retired credential-file opt-in`);
    }
  }
});

test("the generated webinar deck contains the current no-credential-migration claim", (t) => {
  const deck = path.join(
    ROOT,
    "marketing",
    "webinar",
    "outputs",
    "AgentHost-Blast-Radius-Webinar-v1.pptx",
  );
  const extracted = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-webinar-pptx-"));
  t.after(() => fs.rmSync(extracted, { recursive: true, force: true }));
  execFileSync("tar", ["-xf", deck, "-C", extracted]);
  const xmlFiles = [];
  function collectXml(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) collectXml(file);
      else if (entry.name.toLowerCase().endsWith(".xml")) xmlFiles.push(file);
    }
  }
  collectXml(extracted);
  const officeXml = xmlFiles.map((file) => fs.readFileSync(file, "utf8")).join("\n");

  assert.doesNotMatch(officeXml, /unless (?:you|the user) explicitly opt(?:s)? in/i);
  assert.doesNotMatch(officeXml, /explicit auth[- ]migration (?:option|opt-in)/i);
  assert.match(officeXml, /Credential and session files never migrate/i);
});

test("legacy on-volume cleanup records completion only after credential removal succeeds", () => {
  const entrypoint = fs.readFileSync(path.join(ROOT, "container", "entrypoint.sh"), "utf8");
  const block = entrypoint.match(
    /# Legacy Claude credential purge begin[\s\S]+?# Legacy Claude credential purge end/,
  )?.[0] || "";
  assert.match(
    block,
    /rm -f -- "\$LEGACY_CLAUDE_CREDENTIAL_FILE"[\s\S]+?install -o root -g root -m 0600 \/dev\/null "\$LEGACY_CLAUDE_PURGE_MARKER"/,
    "the durable marker must be downstream of a successful deletion branch",
  );
  assert.match(
    block,
    /legacy_claude_purge_fatal[\s\S]+?exit 1/,
    "a failed deletion or marker write must stop boot before the agent can create new credentials",
  );
});

test("root-owned legacy cleanup is symlink-safe and one-time", (t) => {
  const entrypoint = fs.readFileSync(path.join(ROOT, "container", "entrypoint.sh"), "utf8");
  const originalBlock = entrypoint.match(
    /# Legacy Claude credential purge begin[\s\S]+?# Legacy Claude credential purge end/,
  )?.[0] || "";
  assert.ok(originalBlock, "root purge block is present");
  const block = originalBlock
    .replace("LEGACY_AGENT_HOME=/data/home/agent", 'LEGACY_AGENT_HOME="$TEST_DATA_ROOT/home/agent"')
    .replace(
      "LEGACY_CLAUDE_PURGE_MARKER=/data/.agenthost-legacy-claude-credentials-purged-v1",
      'LEGACY_CLAUDE_PURGE_MARKER="$TEST_DATA_ROOT/.agenthost-legacy-claude-credentials-purged-v1"',
    );
  const shellScript = `
set -eu
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT
export AGENTHOST_PURGE_LEGACY_CLAUDE_CREDENTIALS=1
export TEST_DATA_ROOT="$test_root/data"
mkdir -p "$TEST_DATA_ROOT/home/agent/.claude"
printf 'legacy' > "$TEST_DATA_ROOT/home/agent/.claude/.credentials.json"

${block}
test ! -e "$TEST_DATA_ROOT/home/agent/.claude/.credentials.json"
test -f "$LEGACY_CLAUDE_PURGE_MARKER"
test ! -L "$LEGACY_CLAUDE_PURGE_MARKER"
test "$(stat -c %u "$LEGACY_CLAUDE_PURGE_MARKER")" = "0"
test "$(stat -c %a "$LEGACY_CLAUDE_PURGE_MARKER")" = "600"
printf 'cloud-native' > "$TEST_DATA_ROOT/home/agent/.claude/.credentials.json"
export AGENTHOST_PURGE_LEGACY_CLAUDE_CREDENTIALS=1
${block}
test -f "$TEST_DATA_ROOT/home/agent/.claude/.credentials.json"

rm -f "$LEGACY_CLAUDE_PURGE_MARKER" "$TEST_DATA_ROOT/home/agent/.claude/.credentials.json"
outside="$test_root/outside"
mkdir -p "$outside"
printf 'must-survive' > "$outside/.credentials.json"
rm -rf "$TEST_DATA_ROOT/home/agent/.claude"
ln -s "$outside" "$TEST_DATA_ROOT/home/agent/.claude"
export AGENTHOST_PURGE_LEGACY_CLAUDE_CREDENTIALS=1
if (
${block}
); then exit 70; fi
test -f "$outside/.credentials.json"
test ! -e "$LEGACY_CLAUDE_PURGE_MARKER"
`;
  const command = process.platform === "win32"
    ? ["wsl.exe", ["-d", "Ubuntu", "-u", "root", "--exec", "bash", "-s"]]
    : ["bash", ["-s"]];
  const availability = process.platform === "win32"
    ? spawnSync("wsl.exe", ["-d", "Ubuntu", "-u", "root", "--exec", "true"], { encoding: "utf8" })
    : process.getuid?.() === 0
      ? spawnSync("bash", ["-c", "true"], { encoding: "utf8" })
      : { status: 1 };
  if (availability.error || availability.status !== 0) {
    t.skip("a bash runtime is unavailable for the boot-script behavior check");
    return;
  }
  const result = spawnSync(command[0], command[1], {
    input: shellScript,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(
    result.status,
    0,
    `purge behavior failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
});

test("deploy dry-run still stages each supported environment-backed auth value by name", (t) => {
  const home = fixtureHome(t);
  const cases = [
    [
      "--oauth-token-env",
      "AGENTHOST_CLAUDE_CODE_OAUTH_TOKEN",
      "oauth-fixture-value",
      "CLAUDE_CODE_OAUTH_TOKEN",
    ],
    [
      "--anthropic-key-env",
      "AGENTHOST_ANTHROPIC_API_KEY",
      "anthropic-fixture-value",
      "ANTHROPIC_API_KEY",
    ],
  ];

  for (const [flag, inputName, value, secretName] of cases) {
    const result = runCli([
      "deploy", "--org", "fixture-org", "--app", `fixture-${secretName.toLowerCase()}`,
      "--dry-run", "--yes", flag,
    ], home, { [inputName]: value });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`would stage secrets:.*${secretName}`));
    assert.match(result.stdout, /would inspect Fly[\s\S]*remove the retired credential-file secret/i);
    assert.ok(!result.stdout.includes(value), `${secretName} value must never be printed`);
  }
});

test("GitHub and per-repo secrets stage by name through consumed environment inputs", (t) => {
  const home = fixtureHome(t);
  const githubValue = "github-value-must-not-print";
  const repoValue = "repo-value-must-not-print";
  const result = runCli([
    "deploy", "--org", "fixture-org", "--app", "fixture-env-backed-secrets",
    "--dry-run", "--yes", "--repos", "owner/repo",
    "--github-token-env",
    "--env-from", "owner/repo:PRIVATE=AGENTHOST_SECRET_REPO_PRIVATE",
  ], home, {
    AGENTHOST_GITHUB_TOKEN: githubValue,
    AGENTHOST_SECRET_REPO_PRIVATE: repoValue,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /would stage secrets:.*GITHUB_TOKEN/);
  assert.match(result.stdout, /would stage secrets:.*ENVF_0__PRIVATE/);
  assert.ok(!`${result.stdout}\n${result.stderr}`.includes(githubValue));
  assert.ok(!`${result.stdout}\n${result.stderr}`.includes(repoValue));
});

test("ordinary sync dry-run succeeds without reading a local credentials file", (t) => {
  const home = fixtureHome(t);
  const sentinel = "credential-file-sentinel-must-stay-local";
  fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), JSON.stringify({ sentinel }));

  const result = runCli(["sync", "--app", "fixture-sync", "--dry-run"], home);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[dry-run\] would redeploy 'fixture-sync'/);
  assert.match(result.stdout, /would inspect Fly[\s\S]*remove the retired credential-file secret/i);
  assert.ok(!result.stdout.includes(sentinel));
});

test("deploy and sync remove their temporary pack directories on success and failure", (t) => {
  const home = fixtureHome(t);
  const cases = [
    ["deploy", "--org", "fixture-org", "--app", "fixture-cleanup-deploy", "--dry-run", "--yes"],
    ["sync", "--app", "fixture-cleanup-sync", "--dry-run", "--yes"],
    [
      "sync", "--app", "fixture-cleanup-failure", "--dry-run", "--yes",
      "--include", path.join(home, "missing-include"),
    ],
  ];
  for (const args of cases) {
    const before = packTempDirs();
    const result = runCli(args, home);
    if (args.some((arg) => String(arg).includes("missing-include"))) assert.notEqual(result.status, 0);
    else assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      packTempDirs(),
      before,
      `${args[0]} left a temporary agenthost-pack directory behind`,
    );
  }
});

test("--hermes-secrets-from-local is retired before it can read a credential file", (t) => {
  const home = fixtureHome(t);
  fs.mkdirSync(path.join(home, ".hermes"), { recursive: true });
  const value = "opaque-hermes-secret-that-must-not-print";
  fs.writeFileSync(
    path.join(home, ".hermes", ".env"),
    [
      `OPENAI_API_KEY=${value}`,
      "WHATSAPP_SESSION=opaque-session",
      "PAIRING_CODE=123456",
      "OAUTH_REFRESH_TOKEN=opaque-refresh-token",
      "",
    ].join("\n"),
  );

  const result = runCli([
    "deploy", "--org", "fixture-org", "--app", "fixture-hermes-env",
    "--dry-run", "--yes", "--hermes-secrets-from-local",
  ], home);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Hermes credential-file migration is not supported|explicit.*Fly secret/i);
  assert.ok(!result.stdout.includes("HERMESENV_"));
  assert.ok(!result.stdout.includes(value), "Hermes secret values must never be printed");
});

test("normal Hermes deploy names every local omission and gives box-local setup commands", (t) => {
  const home = fixtureHome(t);
  const value = "opaque-hermes-secret-that-must-not-print";
  fs.mkdirSync(path.join(home, ".hermes"), { recursive: true });
  fs.writeFileSync(path.join(home, ".hermes", "SOUL.md"), "# fixture\n");
  fs.writeFileSync(path.join(home, ".hermes", "config.yaml"), "agent:\n  name: fixture\n");
  fs.writeFileSync(path.join(home, ".hermes", ".env"), `OLLAMA_API_KEY=${value}\n`);

  const app = "fixture-hermes-setup";
  const result = runCli([
    "deploy", "--org", "fixture-org", "--app", app, "--dry-run", "--yes",
  ], home, { HERMES_HOME: path.join(home, ".hermes") });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\.hermes\/config\.yaml: Hermes config may contain credentials/i);
  assert.match(result.stdout, /\.hermes\/\.env: Hermes local secret environment file/i);
  assert.match(result.stdout, new RegExp(`Fly dashboard for '${app}'.*Secrets`));
  assert.match(result.stdout, new RegExp(`agenthost restart --app ${app}`));
  assert.ok(!result.stdout.includes(value), "Hermes secret values must never be printed");
});

test("real deploy and sync paths stage a one-time purge only when the retired Fly secret existed", () => {
  for (const rel of ["src/commands/deploy.js", "src/commands/sync.js"]) {
    const source = fs.readFileSync(path.join(ROOT, ...rel.split("/")), "utf8");
    assert.match(
      source,
      /const legacyCredentialCleanup = fly\.retiredCredentialSecretExists\(app\)/,
      `${rel} must inventory existing apps during an upgrade`,
    );
    assert.match(
      source,
      /legacyCredentialCleanup[\s\S]{0,180}AGENTHOST_PURGE_LEGACY_CLAUDE_CREDENTIALS/,
      `${rel} must stage the volume purge control only with provenance`,
    );
    const stageAt = source.indexOf("fly.stageSecrets(app");
    const unsetAt = source.indexOf("fly.removeRetiredCredentialSecret(app)");
    assert.ok(stageAt >= 0 && unsetAt > stageAt, `${rel} must stage the purge marker before unsetting`);
  }
});
