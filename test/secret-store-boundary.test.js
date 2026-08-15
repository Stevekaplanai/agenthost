import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const CONTAINER = path.join(ROOT, "container");
const entrypoint = fs.readFileSync(path.join(CONTAINER, "entrypoint.sh"), "utf8");

function bootSecretBlock() {
  const source = entrypoint.match(
    /# Box secret store:[\s\S]+?export AGENTHOST_BOX_SECRETS_FILE="\$BOX_SECRETS_FILE"/,
  )?.[0];
  assert.ok(source, "entrypoint contains one complete protected-secret boot block");
  return source
    .replaceAll("/data/agenthost-secrets", "${TEST_ROOT}/agenthost-secrets")
    .replaceAll("/data/home/agent/.agenthost", "${TEST_ROOT}/home/agent/.agenthost")
    .replace("box_secrets_owner=gate", 'box_secrets_owner="$(id -u)"')
    .replace("box_secrets_group=boxstate", 'box_secrets_group="$(id -g)"')
    .replace("box_secrets_owner=agent", 'box_secrets_owner="$(id -u)"')
    .replace("box_secrets_group=agent", 'box_secrets_group="$(id -g)"');
}

function runBootSecretBlock(root, foundation = "1") {
  return spawnSync("bash", ["-c", "set -euo pipefail\n" + bootSecretBlock()], {
    env: { ...process.env, TEST_ROOT: root, AGENTHOST_FOUNDATION_B: foundation },
    encoding: "utf8",
  });
}

test("production consumers share one protected store path and boot owns its parent", () => {
  assert.match(entrypoint, /BOX_SECRETS_DIR=\/data\/agenthost-secrets/);
  assert.match(entrypoint, /box_secrets_owner=gate[\s\S]+?box_secrets_group=boxstate[\s\S]+?box_secrets_dir_mode=0750[\s\S]+?box_secrets_file_mode=0660/);
  assert.match(entrypoint, /export AGENTHOST_BOX_SECRETS_FILE="\$BOX_SECRETS_FILE"/);

  for (const name of [
    "gate.js", "measurement-credentials.js", "start.sh", "claw-setup.sh",
    "cursor-terminal.sh", "maintenance-boot-entry.js",
  ]) {
    const source = fs.readFileSync(path.join(CONTAINER, name), "utf8");
    assert.match(source, /AGENTHOST_BOX_SECRETS_FILE/,
      `${name} must consume the configured store instead of rebuilding a HOME path`);
  }
});

test("a successful Linux secret replacement flushes its protected parent before acknowledgement", () => {
  const gate = fs.readFileSync(path.join(CONTAINER, "gate.js"), "utf8");
  const writer = gate.match(/function writeBoxSecretsAtomic\(secrets\) \{[\s\S]+?\n\}/)?.[0];
  assert.ok(writer, "the atomic box-secret writer is present");
  assert.match(writer,
    /renameSync\(temp, BOX_SECRETS_FILE\)[\s\S]+?O_DIRECTORY[\s\S]+?O_NOFOLLOW[\s\S]+?fstatSync\(parentDescriptor\)[\s\S]+?fsyncSync\(parentDescriptor\)/,
    "the published directory entry is flushed through a no-follow directory descriptor");
});

test("Linux boot migrates only a regular legacy file and applies Foundation B modes", (t) => {
  if (process.platform === "win32") return t.skip("the production ownership/mode proof runs on Linux CI");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-secret-boot-"));
  const legacy = path.join(root, "home", "agent", ".agenthost", "secrets.env");
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, "PIPEDREAM_PROJECT_ID=p_migrated\n");

  const ran = runBootSecretBlock(root);
  assert.equal(ran.status, 0, ran.stderr);
  const currentDir = path.join(root, "agenthost-secrets");
  const current = path.join(currentDir, "secrets.env");
  assert.equal(fs.readFileSync(current, "utf8"), "PIPEDREAM_PROJECT_ID=p_migrated\n");
  assert.equal(fs.existsSync(legacy), false, "the stale agent-home copy is removed after a successful move");
  assert.equal(fs.statSync(currentDir).mode & 0o777, 0o750);
  assert.equal(fs.statSync(current).mode & 0o777, 0o660);
});

test("Linux boot refuses a legacy secret symlink without reading or removing its target", (t) => {
  if (process.platform === "win32") return t.skip("symlink behavior is proved on Linux CI");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-secret-link-"));
  const legacy = path.join(root, "home", "agent", ".agenthost", "secrets.env");
  const victim = path.join(root, "victim.env");
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(victim, "VICTIM=unchanged\n");
  fs.symlinkSync(victim, legacy);

  const ran = runBootSecretBlock(root);
  assert.notEqual(ran.status, 0);
  assert.match(ran.stderr, /legacy box secret file is not a regular non-symlink file/);
  assert.equal(fs.readFileSync(victim, "utf8"), "VICTIM=unchanged\n");
});

test("root does not follow an agent-planted artifacts symlink", () => {
  assert.doesNotMatch(entrypoint, /mkdir -p[^\n]*\/data\/home\/agent\/artifacts/,
    "the agent-owned artifact root is no longer created by root");
  assert.doesNotMatch(entrypoint, /(?:chown|chmod)[^\n]*\/data\/home\/agent\/artifacts/,
    "root never directly changes ownership or mode through the agent-controlled path");
  assert.match(entrypoint, /find \/data\/home\/agent \\! -user agent -exec chown -h/,
    "the generic ownership sweep changes symlink entries themselves rather than their targets");
});
