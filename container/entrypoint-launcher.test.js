"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HERE = __dirname;
const DOCKERFILE = path.join(HERE, "Dockerfile");
const ENTRYPOINT = path.join(HERE, "entrypoint.sh");
const LAUNCHER_SOURCE = path.join(HERE, "entrypoint-launcher.c");
const CAN_BUILD = process.platform === "linux"
  && typeof process.getuid === "function" && process.getuid() === 0
  && cp.spawnSync("gcc", ["--version"], { stdio: "ignore" }).status === 0;

function ensureTrustedDirectories() {
  fs.mkdirSync("/opt/agenthost", { recursive: true, mode: 0o755 });
  fs.chownSync("/opt/agenthost", 0, 0);
  fs.chmodSync("/opt/agenthost", 0o755);
}

function writeExecutable(file, source) {
  fs.writeFileSync(file, source, { mode: 0o700 });
  fs.chmodSync(file, 0o700);
}

function cString(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function compileLauncher(output, entrypoint) {
  const built = cp.spawnSync("gcc", [
    "-O2", "-Wall", "-Wextra", "-Werror", "-std=c17", "-fPIE", "-static-pie",
    "-DAGENTHOST_LAUNCHER_TESTING=1",
    `-DAGENTHOST_ENTRYPOINT_SCRIPT=${cString(entrypoint)}`,
    "-o", output, LAUNCHER_SOURCE,
  ], { encoding: "utf8" });
  assert.equal(built.status, 0, built.stderr);
}

function compileLoaderProbe(dir, marker) {
  const source = path.join(dir, "hostile-loader.c");
  const library = path.join(dir, "hostile-loader.so");
  fs.writeFileSync(source, `#define _GNU_SOURCE
#include <fcntl.h>
#include <link.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
static void record_token(void) {
  const char *token = getenv("GIT_PUSH_TOKEN");
  int fd = open(${cString(marker)}, O_WRONLY | O_CREAT | O_APPEND, 0600);
  if (fd >= 0) {
    if (token) (void)write(fd, token, strlen(token));
    (void)write(fd, "\\n", 1);
    (void)close(fd);
  }
}
__attribute__((constructor)) static void preload_entry(void) { record_token(); }
unsigned int la_version(unsigned int version) { record_token(); return version; }
`);
  const built = cp.spawnSync("gcc", ["-shared", "-fPIC", "-o", library, source], { encoding: "utf8" });
  assert.equal(built.status, 0, built.stderr);
  return library;
}

function readNulEnvironment(buffer) {
  return Object.fromEntries(buffer.toString("utf8").split("\0").filter(Boolean)
    .map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]));
}

test("the configured pre-entrypoint boundary blocks loader and Bash hooks before token capture", {
  skip: !CAN_BUILD,
}, (t) => {
  ensureTrustedDirectories();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-entry-loader-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const marker = path.join(dir, "loader-ran");
  const bashMarker = path.join(dir, "bash-hook-ran");
  const loader = compileLoaderProbe(dir, marker);
  const bashHook = path.join(dir, "bash-env.sh");
  fs.writeFileSync(bashHook, `printf '%s' "$GIT_PUSH_TOKEN" > ${cString(bashMarker)}\n`);

  const dockerfile = fs.readFileSync(DOCKERFILE, "utf8");
  const configured = /^ENTRYPOINT (\[[^\r\n]+\])$/m.exec(dockerfile);
  assert.ok(configured, "Dockerfile must declare one JSON-array ENTRYPOINT");
  assert.deepEqual(JSON.parse(configured[1]), ["/opt/agenthost/entrypoint-launcher"]);

  let executable;
  let args;
  if (process.env.AGENTHOST_ENTRYPOINT_LAUNCHER) {
    executable = process.env.AGENTHOST_ENTRYPOINT_LAUNCHER;
    args = [];
  } else {
    executable = path.join(dir, "entrypoint-launcher");
    compileLauncher(executable, ENTRYPOINT);
    args = [];
  }

  const probe = cp.spawnSync(executable, args, {
    env: {
      GIT_PUSH_TOKEN: "FAKE-PUSH-TOKEN-DO-NOT-USE",
      LD_PRELOAD: loader,
      LD_AUDIT: loader,
      BASH_ENV: bashHook,
      SHELLOPTS: "xtrace",
    },
    encoding: "utf8",
  });
  assert.notEqual(probe.error?.code, "ENOENT", probe.error?.message);
  assert.equal(fs.existsSync(marker), false, "LD_PRELOAD/LD_AUDIT must not run before the token is removed");
  assert.equal(fs.existsSync(bashMarker), false, "BASH_ENV must not run before the token is removed");
  assert.doesNotMatch(`${probe.stdout}\n${probe.stderr}`, /FAKE-PUSH-TOKEN-DO-NOT-USE/);
  if (process.env.AGENTHOST_ENTRYPOINT_LAUNCHER) {
    assert.equal(probe.status, 1, "the production launcher must reach entrypoint.sh's missing-volume guard");
    assert.match(`${probe.stdout}\n${probe.stderr}`, /FATAL: \/data volume is not mounted/);
  }
});

test("the static launcher constructs the boot environment from the release allowlist", {
  skip: !CAN_BUILD,
}, (t) => {
  ensureTrustedDirectories();
  assert.equal(fs.existsSync(LAUNCHER_SOURCE), true, "the static launcher source must ship with the image");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-entry-env-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, "print-env.sh");
  const launcher = path.join(dir, "entrypoint-launcher");
  writeExecutable(script, "#!/bin/bash\n/usr/bin/env -0\n");
  compileLauncher(launcher, script);

  const elf = cp.spawnSync("readelf", ["-l", launcher], { encoding: "utf8" });
  assert.equal(elf.status, 0, elf.stderr);
  assert.doesNotMatch(elf.stdout, /\bINTERP\b/, "the first process must not invoke a dynamic loader");

  const required = {
      PATH: "/tmp/agent-controlled-bin",
      GIT_PUSH_TOKEN: "fake-push-token",
      CLAUDE_CODE_OAUTH_TOKEN: "fake-oauth-token",
      TTYD_PASSWORD: "fake-terminal-password",
      GITHUB_TOKEN: "fake-read-token",
      POSTHOG_PERSONAL_API_KEY: "fake-posthog-key",
      BRIDGE_TOKEN: "fake-bridge-token",
      BRIDGE_URL: "https://bridge.invalid",
      REPOS: "owner/repo",
      ENVF_0__PRIVATE: "repo-secret",
      ENVF_0__apiKey: "mixed-case-repo-secret",
      HERMESENV_FAL_KEY: "hermes-secret",
      MAIL_WEBHOOK_SECRET: "fake-mail-secret",
      RESEND_API_KEY: "fake-resend-key",
      CHECKOUT_WEBHOOK_SECRET: "fake-checkout-secret",
      BOARD_RUNNER: "off",
      DISCORD_BOT_TOKEN: "fake-discord-token",
      TELEGRAM_BOT_TOKEN: "fake-telegram-token",
      GEMINI_API_KEY: "fake-gemini-key",
      KIMI_API_KEY: "fake-kimi-key",
      AGENT_CHAT_HOOKS: "1",
      AGENTHOST_CANONICAL_HOST: "app.agenthost.space",
      AGENTHOST_FOUNDATION_B: "1",
      AGENTHOST_MESH_PEERS: "{}",
      KANBAN_BRIDGE_LIFECYCLE_TOKEN: "fake-lifecycle-token",
      KANBAN_BRIDGE_PORT: "38471",
      KANBAN_BRIDGE_READ_TOKEN: "fake-read-bridge-token",
      KANBAN_BRIDGE_USER: "agent",
      KANBAN_BRIDGE_WRITE_TOKEN: "fake-write-bridge-token",
      CURSOR_API_KEY: "fake-cursor-key",
      LEGAL_MODE: "api",
      FLY_REGION: "mia",
      TZ: "America/New_York",
  };
  const hostile = {
      LD_PRELOAD: "/tmp/evil.so",
      LD_AUDIT: "/tmp/evil-audit.so",
      OPENSSL_CONF: "/tmp/evil-openssl.cnf",
      OPENSSL_MODULES: "/tmp/evil-modules",
      BASH_ENV: "/tmp/evil-bash-env",
      NODE_OPTIONS: "--require=/tmp/evil.cjs",
      NODE_DEBUG: "child_process",
      PYTHONPATH: "/tmp/evil-python",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "/tmp/evil-helper",
      UNEXPECTED_SECRET: "must-not-survive",
  };
  const probe = cp.spawnSync(launcher, [], {
    env: { ...required, ...hostile },
    encoding: "buffer",
  });
  assert.equal(probe.status, 0, probe.stderr.toString("utf8"));
  const env = readNulEnvironment(probe.stdout);
  assert.equal(env.PATH, "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
  assert.equal(env.HOME, "/root");
  for (const [name, value] of Object.entries(required)) {
    if (name === "PATH") continue;
    assert.equal(env[name], value, `${name} must survive the release allowlist byte-for-byte`);
  }
  for (const name of Object.keys(hostile)) {
    assert.equal(env[name], undefined, `${name} must be absent before privileged Bash starts`);
  }

  const nonFoundation = cp.spawnSync(launcher, [], {
    env: { GIT_PUSH_TOKEN: "fake-push-token", TTYD_PASSWORD: "fake-terminal-password" },
    encoding: "buffer",
  });
  assert.equal(nonFoundation.status, 0, nonFoundation.stderr.toString("utf8"));
  assert.equal(readNulEnvironment(nonFoundation.stdout).GIT_PUSH_TOKEN, undefined,
    "a box without the uid split must lose the push credential before Bash starts");

  const oversized = cp.spawnSync(launcher, [], {
    env: { AGENTHOST_FOUNDATION_B: "1", GIT_PUSH_TOKEN: "x".repeat(4097) },
    encoding: "buffer",
  });
  assert.equal(oversized.status, 0, oversized.stderr.toString("utf8"));
  assert.equal(readNulEnvironment(oversized.stdout).GIT_PUSH_TOKEN, undefined,
    "an invalid push credential must fail closed instead of reaching privileged Bash");

  const invalidMode = cp.spawnSync(launcher, ["/tmp/attacker-command"], { encoding: "utf8" });
  assert.equal(invalidMode.status, 64, "the launcher must not accept an executable or arbitrary mode");

  fs.chmodSync(script, 0o722);
  const writableTarget = cp.spawnSync(launcher, [], { encoding: "utf8" });
  assert.equal(writableTarget.status, 70, "a group/world-writable boot script must fail closed");
});
