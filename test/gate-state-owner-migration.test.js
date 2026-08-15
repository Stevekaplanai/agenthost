import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const entrypoint = fs.readFileSync(path.join(ROOT, "container", "entrypoint.sh"), "utf8");
const FOUNDATION_OWNER = 42001;
const LEGACY_OWNER = 42002;
const LINUX_CI_PROOF = "GitHub Actions tests / regressions (ubuntu-latest)";

function gateStateBootBlock() {
  const source = entrypoint.match(
    /# Operator Creative reviews are gate-only state\.[\s\S]+?export AGENTHOST_ARTIFACT_REVIEW_DIR="\$ARTIFACT_REVIEW_DIR"/,
  )?.[0];
  assert.ok(source, "entrypoint contains one complete private gate-state boot block");
  return source;
}

function fixtureBootBlock() {
  const source = gateStateBootBlock();
  assert.equal(source.split("artifact_review_owner=gate").length - 1, 1);
  assert.equal(source.split("artifact_review_owner=agent").length - 1, 1);
  return source
    .replaceAll("/data/agenthost-gate-state", "${TEST_ROOT}/agenthost-gate-state")
    .replaceAll("/data/home/agent/.claude/agenthost", "${TEST_ROOT}/legacy-home/.claude/agenthost")
    .replaceAll("/usr/local/bin/node", process.execPath.replaceAll("\\", "/"))
    .replaceAll("/opt/agenthost/maintenance-auth-state.js", path.join(ROOT, "container", "maintenance-auth-state.js").replaceAll("\\", "/"))
    .replace("artifact_review_owner=gate", 'artifact_review_owner="$FOUNDATION_OWNER"')
    .replace("artifact_review_owner=agent", 'artifact_review_owner="$LEGACY_OWNER"')
    .replace('auth_owner_uid="$(id -u "$artifact_review_owner")"', 'auth_owner_uid="$artifact_review_owner"')
    .replace('auth_owner_gid="$(id -g "$artifact_review_owner")"', 'auth_owner_gid="$artifact_review_owner"')
    .replace('legacy_gate_uid="$(id -u gate)"', 'legacy_gate_uid="$FOUNDATION_OWNER"')
    .replace('legacy_agent_uid="$(id -u agent)"', 'legacy_agent_uid="$LEGACY_AGENT_OWNER"')
    .replaceAll("-o gate -g gate", '-o "$FOUNDATION_OWNER" -g "$FOUNDATION_OWNER"')
    .replaceAll("chown gate:gate --", 'chown "$FOUNDATION_OWNER:$FOUNDATION_OWNER" --');
}

function rootAvailable() {
  if (typeof process.getuid === "function" && process.getuid() === 0) return true;
  return spawnSync("sudo", ["-n", "true"], { stdio: "ignore" }).status === 0;
}

function requireRootProof(t, purpose) {
  if (rootAvailable()) return true;
  if (process.env.CI) assert.fail(`${LINUX_CI_PROOF} cannot run ${purpose} without root or passwordless sudo`);
  t.skip(`${purpose} needs root or passwordless sudo`);
  return false;
}

function runAsRoot(command, args, extraEnv = {}) {
  const options = { encoding: "utf8", env: { ...process.env, ...extraEnv } };
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    return spawnSync(command, args, options);
  }
  const assignments = Object.entries(extraEnv).map(([name, value]) => `${name}=${value}`);
  return spawnSync("sudo", ["-n", "env", ...assignments, command, ...args], {
    encoding: "utf8",
    env: process.env,
  });
}

function runMigration(
  root,
  foundation,
  accessKey = "gate-state-owner-migration-test-key",
  legacyAgentOwner = fs.statSync(root).uid,
) {
  return runAsRoot("bash", ["-c", "set -euo pipefail\n" + fixtureBootBlock()], {
    TEST_ROOT: root,
    AGENTHOST_FOUNDATION_B: foundation,
    FOUNDATION_OWNER: String(FOUNDATION_OWNER),
    LEGACY_OWNER: String(LEGACY_OWNER),
    LEGACY_AGENT_OWNER: String(legacyAgentOwner),
    TTYD_PASSWORD: accessKey,
  });
}

function runAsUid(uid, command, args = []) {
  return runAsRoot("/usr/bin/setpriv", [
    `--reuid=${uid}`,
    `--regid=${uid}`,
    "--clear-groups",
    command,
    ...args,
  ]);
}

function statAsRoot(file) {
  const result = runAsRoot("stat", ["-c", "%u:%g:%a", file]);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function inodeAsRoot(file) {
  const result = runAsRoot("stat", ["-c", "%i", file]);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function readAsRoot(file) {
  const result = runAsRoot("cat", [file]);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function assertPrivateState(gateState, owner, files) {
  assert.equal(statAsRoot(gateState), "0:0:711", "the fixed root stays root-owned and non-writable");
  for (const relative of ["artifact-reviews", "artifact-archive", "auth", "qa", "qa/evidence", "qa/evidence/run-1"]) {
    assert.equal(statAsRoot(path.join(gateState, relative)), `${owner}:${owner}:700`);
  }
  for (const [relative, contents] of files) {
    const file = path.join(gateState, relative);
    assert.equal(statAsRoot(file), `${owner}:${owner}:600`);
    assert.equal(readAsRoot(file), contents);
  }
}

function cleanupFixture(root) {
  const temp = fs.realpathSync(os.tmpdir());
  assert.equal(path.dirname(root), temp, "cleanup stays inside the OS temporary directory");
  assert.match(path.basename(root), /^agenthost-gate-state-/);
  const result = runAsRoot("rm", ["-rf", "--", root]);
  assert.equal(result.status, 0, result.stderr);
}

test("private gate-state boot migration is closed over one root and rejects unsafe entries", () => {
  const block = gateStateBootBlock();
  const dataPaths = [...block.matchAll(/\/data\/[A-Za-z0-9._/-]+/g)].map((match) => match[0]);
  assert.deepEqual([...new Set(dataPaths)], [
    "/data/agenthost-gate-state",
    "/data/home/agent/.claude/agenthost",
  ]);
  assert.match(block, /find -P "\$ARTIFACT_REVIEW_ROOT" -xdev -type l -print -quit/);
  assert.match(block, /find -P "\$ARTIFACT_REVIEW_ROOT" -xdev ! -type d ! -type f -print -quit/);
  assert.match(block, /find -P "\$ARTIFACT_REVIEW_ROOT" -xdev -type f ! -links 1 -print -quit/);
  assert.match(block, /install -d -o root -g root -m 0711 "\$ARTIFACT_REVIEW_ROOT"/);
  assert.match(block, /AGENTHOST_ARTIFACT_ARCHIVE_DIR="\$ARTIFACT_REVIEW_ROOT\/artifact-archive"/);
  assert.match(block, /\[ ! -L "\$AGENTHOST_ARTIFACT_ARCHIVE_DIR" \]/);
  assert.match(block, /\[ ! -e "\$AGENTHOST_ARTIFACT_ARCHIVE_DIR" \] \|\| \[ -d "\$AGENTHOST_ARTIFACT_ARCHIVE_DIR" \]/);
  assert.match(block, /install -d -o "\$artifact_review_owner" -g "\$artifact_review_owner" -m 0700 "\$AGENTHOST_ARTIFACT_ARCHIVE_DIR"/);
  assert.match(block, /maintenance-auth-state\.js[\s\S]+?--mode "\$auth_transition_mode"/);
  assert.match(block, /legacy_agent_uid="\$\(id -u agent\)"[\s\S]+?--legacy-agent-uid "\$legacy_agent_uid"/);
  assert.match(block, /for private_tree in[\s\S]+?-type d -print0[\s\S]+?chown "\$artifact_review_owner:\$artifact_review_owner"[\s\S]+?chmod 0700/);
  assert.match(block, /-type f -links 1 -print0[\s\S]+?chown "\$artifact_review_owner:\$artifact_review_owner"[\s\S]+?chmod 0600/);
  assert.match(block, /for private_tree in[^\n]+"\$AGENTHOST_ARTIFACT_ARCHIVE_DIR"/);
  assert.match(block, /export AGENTHOST_ARTIFACT_ARCHIVE_DIR/);
  assert.doesNotMatch(block, /\b(?:chown|chmod) -R\b/);
});

test(`LINUX CI PROOF: Foundation purges agent-owned legacy auth when gate and agent uids differ (${LINUX_CI_PROOF})`, {
  skip: process.platform === "win32" ? `real uid ownership proof runs in ${LINUX_CI_PROOF}` : false,
}, (t) => {
  if (!requireRootProof(t, "the split legacy-auth owner proof")) return;
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "agenthost-gate-state-legacy-auth-owner-"));
  t.after(() => cleanupFixture(root));
  fs.chmodSync(root, 0o711);

  const legacyHome = path.join(root, "legacy-home");
  const legacyClaude = path.join(legacyHome, ".claude");
  const legacyAuth = path.join(legacyClaude, "agenthost");
  fs.mkdirSync(legacyAuth, { recursive: true, mode: 0o700 });
  const staleKey = path.join(legacyAuth, "gate.secret");
  fs.writeFileSync(staleKey, `${"a".repeat(64)}\n`, { mode: 0o600 });

  for (const [owner, targets] of [
    ["0:0", [root]],
    [`${LEGACY_OWNER}:${LEGACY_OWNER}`, [legacyHome, legacyClaude, legacyAuth, staleKey]],
  ]) {
    const prepared = runAsRoot("chown", [owner, ...targets]);
    assert.equal(prepared.status, 0, prepared.stderr);
  }

  const ran = runMigration(root, "1", "split-owner-access-key", LEGACY_OWNER);

  assert.equal(ran.status, 0, ran.stderr);
  const staleKeyGone = runAsRoot("sh", ["-c", '[ ! -e "$1" ] && [ ! -L "$1" ]', "sh", staleKey]);
  assert.equal(staleKeyGone.status, 0, "the retired agent-owned gate secret must be deleted");
  assert.equal(statAsRoot(path.join(root, "agenthost-gate-state", "auth")), `${FOUNDATION_OWNER}:${FOUNDATION_OWNER}:700`);
});

test(`LINUX CI PROOF: boot flips private Creative and QA state to gate, then rolls it back to agent (${LINUX_CI_PROOF})`, {
  skip: process.platform === "win32" ? `real uid ownership proof runs in ${LINUX_CI_PROOF}` : false,
}, (t) => {
  if (!requireRootProof(t, "the real uid ownership proof")) return;
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "agenthost-gate-state-owner-"));
  t.after(() => cleanupFixture(root));
  fs.chmodSync(root, 0o711);

  const files = [
    ["artifact-reviews/review.json", "creative-review\n"],
    ["artifact-reviews/review.operation.json", "creative-operation-receipt\n"],
    ["artifact-archive/graphify-report.html", "archived-graphify-report\n"],
    ["qa/last-result.json", "qa-result\n"],
    ["qa/evidence/run-1/proof.png", "qa-evidence\n"],
  ];
  const sources = files.map(([relative, contents], index) => {
    const source = path.join(root, `source-${index}`);
    fs.writeFileSync(source, contents);
    return [relative, contents, source];
  });

  let ran = runMigration(root, "0");
  assert.equal(ran.status, 0, ran.stderr);
  const gateState = path.join(root, "agenthost-gate-state");
  const nestedEvidence = path.join(gateState, "qa", "evidence", "run-1");
  ran = runAsRoot("install", ["-d", "-o", String(LEGACY_OWNER), "-g", String(LEGACY_OWNER), "-m", "0700", nestedEvidence]);
  assert.equal(ran.status, 0, ran.stderr);
  for (const [relative, , source] of sources) {
    ran = runAsRoot("install", ["-o", String(LEGACY_OWNER), "-g", String(LEGACY_OWNER), "-m", "0600", source, path.join(gateState, relative)]);
    assert.equal(ran.status, 0, ran.stderr);
  }
  assertPrivateState(gateState, LEGACY_OWNER, files);

  ran = runMigration(root, "1");
  assert.equal(ran.status, 0, ran.stderr);
  assertPrivateState(gateState, FOUNDATION_OWNER, files);
  const authLeaf = path.join(gateState, "auth", "auth.rotation-required");
  const authBefore = inodeAsRoot(authLeaf);
  const authContents = readAsRoot(authLeaf);
  for (const attempted of [
    runAsUid(LEGACY_OWNER, "cat", [authLeaf]),
    runAsUid(LEGACY_OWNER, "sh", ["-c", 'printf changed > "$1"', "sh", authLeaf]),
    runAsUid(LEGACY_OWNER, "rm", ["-f", "--", authLeaf]),
    runAsUid(LEGACY_OWNER, "mv", ["--", authLeaf, `${authLeaf}.agent-replaced`]),
  ]) {
    assert.notEqual(attempted.status, 0, "the agent uid unexpectedly changed protected authentication state");
  }
  const authAfter = inodeAsRoot(authLeaf);
  assert.equal(authAfter, authBefore);
  assert.equal(readAsRoot(authLeaf), authContents);

  const rotatedKey = "gate-state-owner-migration-rotated-key";
  ran = runMigration(root, "1", rotatedKey);
  assert.equal(ran.status, 0, ran.stderr);
  const recoveryMarker = path.join(gateState, "auth", "auth.recovery-required");
  assert.equal(statAsRoot(recoveryMarker), `${FOUNDATION_OWNER}:${FOUNDATION_OWNER}:600`);
  ran = runAsRoot("rm", ["-f", "--", recoveryMarker]);
  assert.equal(ran.status, 0, ran.stderr);

  ran = runMigration(root, "0", rotatedKey);
  assert.equal(ran.status, 0, ran.stderr);
  assertPrivateState(gateState, LEGACY_OWNER, files);
});

test(`LINUX CI PROOF: boot refuses unsafe entries and a replaced artifact archive before touching their targets (${LINUX_CI_PROOF})`, {
  skip: process.platform === "win32" ? `unsafe filesystem entries are exercised in ${LINUX_CI_PROOF}` : false,
}, (t) => {
  if (!requireRootProof(t, "the unsafe filesystem proof")) return;

  for (const kind of ["symlink", "hardlink", "fifo", "archive-symlink", "archive-file"]) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `agenthost-gate-state-${kind}-`));
    t.after(() => cleanupFixture(root));
    fs.chmodSync(root, 0o711);
    const reviews = path.join(root, "agenthost-gate-state", "artifact-reviews");
    const unsafe = kind.startsWith("archive-")
      ? path.join(root, "agenthost-gate-state", "artifact-archive")
      : path.join(reviews, "unsafe-entry");
    const victim = path.join(root, "victim");
    fs.mkdirSync(reviews, { recursive: true });
    const gateState = path.join(root, "agenthost-gate-state");
    fs.chmodSync(gateState, 0o711);
    const prepared = runAsRoot("chown", ["0:0", gateState]);
    assert.equal(prepared.status, 0, prepared.stderr);
    fs.writeFileSync(victim, "unchanged\n", { mode: 0o640 });
    const before = fs.statSync(victim);

    if (kind === "symlink") fs.symlinkSync(victim, unsafe);
    if (kind === "archive-symlink") {
      const planted = runAsRoot("ln", ["-s", "--", victim, unsafe]);
      assert.equal(planted.status, 0, planted.stderr);
    }
    if (kind === "hardlink") fs.linkSync(victim, unsafe);
    if (kind === "fifo") {
      const made = spawnSync("mkfifo", [unsafe], { encoding: "utf8" });
      assert.equal(made.status, 0, made.stderr);
    }
    if (kind === "archive-file") {
      const planted = runAsRoot("install", ["-m", "0600", "/dev/null", unsafe]);
      assert.equal(planted.status, 0, planted.stderr);
    }

    const ran = runMigration(root, "1");
    assert.notEqual(ran.status, 0, `${kind} was accepted`);
    assert.match(ran.stderr, kind === "symlink" || kind === "archive-symlink"
      ? /refusing symlinked gate-state entry/
      : kind === "hardlink"
        ? /gate-state file has multiple hard links/
        : kind === "archive-file"
          ? /artifact archive path is not a directory/
          : /gate-state entry is neither a directory nor a regular file/);
    const after = fs.statSync(victim);
    assert.equal(fs.readFileSync(victim, "utf8"), "unchanged\n");
    assert.equal(after.uid, before.uid);
    assert.equal(after.gid, before.gid);
    assert.equal(after.mode & 0o777, before.mode & 0o777);
  }
});
