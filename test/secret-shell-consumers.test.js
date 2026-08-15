import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const CONTAINER = path.join(ROOT, "container");
const loader = path.join(CONTAINER, "secret-env.sh");
const start = fs.readFileSync(path.join(CONTAINER, "start.sh"), "utf8");
const clawSetup = fs.readFileSync(path.join(CONTAINER, "claw-setup.sh"), "utf8");
const dockerfile = fs.readFileSync(path.join(CONTAINER, "Dockerfile"), "utf8");
const bash = process.platform === "win32"
  ? "C:\\Program Files\\Git\\bin\\bash.exe"
  : "bash";

function bashPath(value) {
  if (process.platform !== "win32") return value;
  const normalized = path.resolve(value).replaceAll("\\", "/");
  return "/" + normalized[0].toLowerCase() + normalized.slice(2);
}

function runBash(script, args) {
  const env = { ...process.env };
  delete env.BASH_ENV;
  delete env.ENV;
  return spawnSync(bash, ["-c", script, "secret-loader-test", ...args], {
    encoding: "utf8",
    env,
  });
}

test("every all-secret terminal consumer uses the shipped data loader", () => {
  assert.match(dockerfile, /COPY secret-env\.sh \/opt\/agenthost\/secret-env\.sh/);
  assert.equal(
    (start.match(/\. \/opt\/agenthost\/secret-env\.sh; agenthost_load_secrets_env/g) || []).length,
    3,
    "Gemini, Kimi, and OpenClaw use the same strict loader",
  );
  assert.match(start, /agenthost_load_secrets_env [^;]+ GEMINI_API_KEY \|\| \{[^}]+Gemini was not started[^}]+exec bash;/);
  assert.match(start, /agenthost_load_secrets_env [^;]+ MOONSHOT_API_KEY \|\| \{[^}]+Kimi was not started[^}]+exec bash;/);
  assert.match(start, /agenthost_load_secrets_env [^;]+ OPENCLAW_GATEWAY_TOKEN CHANNEL_DISPATCH_TOKEN [^;]+ \|\| \{[^}]+OpenClaw was not started[^}]+exec bash;/);
  assert.match(start, /agenthost_load_secrets_env "\$AGENTHOST_BOX_SECRETS_FILE" GITHUB_TOKEN/,
    "startup GitHub setup must read the dashboard-managed token through the strict loader");
  assert.doesNotMatch(start, /set -a/);
  assert.doesNotMatch(start, /\.\s+[^;\n]{0,30}AGENTHOST_BOX_SECRETS_FILE/,
    "start.sh never sources the operator-controlled secret file");

  const source = fs.readFileSync(loader, "utf8");
  assert.match(source, /while IFS= read -r line/);
  assert.ok(source.includes('export "${names[$index]}=${values[$index]}"'),
    "validated names and values enter the environment through one quoted builtin assignment");
  assert.doesNotMatch(source, /(?:^|\s)(?:eval|source)\s|(?:^|[;&])\s*\.\s+"\$secrets_file"/m);
});

test("startup GitHub setup and a fresh clone receive the protected token", (t) => {
  if (process.platform === "win32" && !fs.existsSync(bash)) {
    return t.skip("Git Bash is unavailable on this Windows host");
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-github-startup-"));
  try {
    const secretsFile = path.join(root, "secrets.env");
    fs.writeFileSync(secretsFile, "GITHUB_TOKEN=protected-github-fixture\n");
    const match = /# 2\. GitHub access\.\r?\n([\s\S]*?)\r?\n# 3\. Clone selected repos/.exec(start);
    assert.ok(match, "the exercised startup GitHub block must remain reachable before cloning");
    const githubBlock = match[1].replace(
      ". /opt/agenthost/secret-env.sh",
      '. "$1"',
    );
    const result = runBash([
      "set -euo pipefail",
      "AGENTHOST_BOX_SECRETS_FILE=\"$2\"",
      "GITHUB_TOKEN=stale-process-value",
      "GH_TOKEN=stale-gh-alias",
      "GITHUB_PERSONAL_ACCESS_TOKEN=stale-mcp-alias",
      "gh() { printf 'gh:%s:%s\\n' \"$GH_TOKEN\" \"$GITHUB_PERSONAL_ACCESS_TOKEN\"; }",
      "git() { printf 'git:%s:%s:%s\\n' \"$1\" \"$GITHUB_TOKEN\" \"$GH_TOKEN\"; }",
      githubBlock,
      "git clone https://github.com/example/repo /tmp/repo",
    ].join("\n"), [bashPath(loader), bashPath(secretsFile)]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /gh:protected-github-fixture:protected-github-fixture/,
      "gh setup and the official GitHub MCP alias use the protected token");
    assert.match(result.stdout, /git:clone:protected-github-fixture:protected-github-fixture/,
      "the later clone inherits the protected token and GH alias");
    assert.doesNotMatch(result.stdout + result.stderr, /stale-process-value|stale-gh-alias|stale-mcp-alias/,
      "the protected store replaces stale canonical and alias values on both consumers");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("claw-setup chooses a model credential saved in the protected store", (t) => {
  if (process.platform === "win32" && !fs.existsSync(bash)) {
    return t.skip("Git Bash is unavailable on this Windows host");
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-openclaw-model-secret-"));
  try {
    const secretsFile = path.join(root, "secrets.env");
    const modelSecret = "gemini-protected-fixture-never-print";
    fs.writeFileSync(secretsFile, `GEMINI_API_KEY=${modelSecret}\n`);
    const match = /# --- Step 1: model auth[^\n]*\r?\n([\s\S]*?)\r?\necho "Model for OpenClaw agents: \$\{OK\}\$\{AUTH_LABEL\}\$\{R\}"/.exec(clawSetup);
    assert.ok(match, "the exercised model-auth block must remain reachable in claw-setup");
    const modelAuthBlock = match[1].replace(
      ". /opt/agenthost/secret-env.sh",
      '. "$1"',
    );
    const result = runBash([
      "set -uo pipefail",
      "unset GEMINI_API_KEY OPENROUTER_API_KEY OLLAMA_API_KEY CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY",
      "AGENTHOST_BOX_SECRETS_FILE=\"$2\"",
      "HOME_DIR=\"$3\"",
      "MUT=; R=; OK=",
      modelAuthBlock,
      "[ \"$GEMINI_API_KEY\" = \"$4\" ]",
      "printf 'choice=%s\\n' \"$AUTH_CHOICE\"",
    ].join("\n"), [
      bashPath(loader),
      bashPath(secretsFile),
      bashPath(root),
      modelSecret,
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "choice=gemini-api-key\n");
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(modelSecret),
      "the protected model credential value never enters setup output");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("secret values remain literal data, including command substitution and backticks", (t) => {
  if (process.platform === "win32" && !fs.existsSync(bash)) {
    return t.skip("Git Bash is unavailable on this Windows host");
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-secret-shell-"));
  try {
    const secretsFile = path.join(root, "secrets.env");
    const substitutionMarker = path.join(root, "substitution-executed");
    const backtickMarker = path.join(root, "backtick-executed");
    const substitutionValue = "$(touch " + bashPath(substitutionMarker) + ")";
    const backtickValue = "`touch " + bashPath(backtickMarker) + "`";
    const complexValue = "left = right; \"$HOME\" 'quoted' # glob* ? [x] \\ tail";
    const equalsValue = "=alpha=beta=gamma";

    fs.writeFileSync(secretsFile, [
      "DOLLAR_TOKEN=" + substitutionValue,
      "BACKTICK_TOKEN=" + backtickValue,
      "COMPLEX_TOKEN=" + complexValue,
      "EQUALS_TOKEN=" + equalsValue,
      "",
    ].join("\n"));

    const loaded = runBash([
      "set -euo pipefail",
      ". \"$1\"",
      "agenthost_load_secrets_env \"$2\" DOLLAR_TOKEN BACKTICK_TOKEN COMPLEX_TOKEN EQUALS_TOKEN",
      "[ \"$DOLLAR_TOKEN\" = \"$3\" ]",
      "[ \"$BACKTICK_TOKEN\" = \"$4\" ]",
      "[ \"$COMPLEX_TOKEN\" = \"$5\" ]",
      "[ \"$EQUALS_TOKEN\" = \"$6\" ]",
      "printf 'loaded-as-data\\n'",
    ].join("\n"), [
      bashPath(loader),
      bashPath(secretsFile),
      substitutionValue,
      backtickValue,
      complexValue,
      equalsValue,
    ]);

    assert.equal(loaded.status, 0, loaded.stderr);
    assert.equal(loaded.stdout, "loaded-as-data\n");
    assert.equal(fs.existsSync(substitutionMarker), false,
      "dollar-parenthesis content was not executed");
    assert.equal(fs.existsSync(backtickMarker), false,
      "backtick content was not executed");

    fs.writeFileSync(secretsFile, "FIRST_TOKEN=must-not-load\nbad-name=corrupt\n");
    const rejected = runBash([
      "set -uo pipefail",
      ". \"$1\"",
      "if agenthost_load_secrets_env \"$2\" FIRST_TOKEN; then exit 31; fi",
      "[ -z \"${FIRST_TOKEN+x}\" ] || exit 32",
    ].join("\n"), [bashPath(loader), bashPath(secretsFile)]);
    assert.equal(rejected.status, 0, rejected.stderr);
    assert.match(rejected.stderr, /invalid name at line 2; no box secrets were loaded/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("environment-control names cannot execute hooks or create a partial load", (t) => {
  if (process.platform === "win32" && !fs.existsSync(bash)) {
    return t.skip("Git Bash is unavailable on this Windows host");
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-secret-env-control-"));
  try {
    const secretsFile = path.join(root, "secrets.env");
    const hook = path.join(root, "bash-env-hook.sh");
    const marker = path.join(root, "bash-env-executed");
    fs.writeFileSync(hook, "touch '" + bashPath(marker) + "'\n");
    fs.writeFileSync(secretsFile, [
      "SAFE_TOKEN=literal-safe-value",
      "BASH_ENV=" + bashPath(hook),
      "NODE_OPTIONS=--require /agent-controlled/hook.js",
      "LD_PRELOAD=/agent-controlled/hook.so",
      "",
    ].join("\n"));

    const safe = runBash([
      "set -euo pipefail",
      ". \"$1\"",
      "agenthost_load_secrets_env \"$2\" SAFE_TOKEN",
      "[ \"$SAFE_TOKEN\" = literal-safe-value ]",
      "[ -z \"${BASH_ENV+x}\" ]",
      "[ -z \"${NODE_OPTIONS+x}\" ]",
      "[ -z \"${LD_PRELOAD+x}\" ]",
      "\"$BASH\" -c ':'",
    ].join("\n"), [bashPath(loader), bashPath(secretsFile)]);
    assert.equal(safe.status, 0, safe.stderr);
    assert.equal(fs.existsSync(marker), false,
      "an unselected BASH_ENV entry cannot execute in a later Bash child");

    const refused = runBash([
      "set -uo pipefail",
      ". \"$1\"",
      "if agenthost_load_secrets_env \"$2\" SAFE_TOKEN BASHOPTS; then exit 41; fi",
      "[ -z \"${SAFE_TOKEN+x}\" ] || exit 42",
    ].join("\n"), [bashPath(loader), bashPath(secretsFile)]);
    assert.equal(refused.status, 0, refused.stderr);
    assert.match(refused.stderr, /BASHOPTS is not a credential selector; no box secrets were loaded/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
