import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  MARKER_NAME,
  PENDING_NAME,
  RECOVERY_CONTENT,
  RECOVERY_NAME,
  ROTATION_CONTENT,
  ROTATION_NAME,
  fingerprintAccessKey,
  reconcileAuthState,
} = require("../container/maintenance-auth-state.js");

const CURRENT_UID = typeof process.getuid === "function" ? process.getuid() : 0;
const CURRENT_GID = typeof process.getgid === "function" ? process.getgid() : 0;
const ROOT_OWNERSHIP_CLI_AVAILABLE = process.platform === "win32" || CURRENT_UID === 0;
const GATE_SECRET = "a".repeat(64);
const SESSION_GENERATION = "b".repeat(64);
const TWO_FA_SECRET = "ABCDEFGHIJKLMNOP234567ABCDEFGHIJKLMNOP".slice(0, 32);

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-auth-transition-"));
  fs.chmodSync(base, 0o711);
  const rootDir = path.join(base, "gate-state");
  const authDir = path.join(rootDir, "auth");
  const legacyAuthDir = path.join(base, "legacy-home", ".claude", "agenthost");
  return { base, rootDir, authDir, legacyAuthDir };
}

function run(paths, mode, password, extra = {}) {
  return reconcileAuthState({
    rootDir: paths.rootDir,
    authDir: paths.authDir,
    legacyAuthDir: paths.legacyAuthDir,
    legacyGateUid: CURRENT_UID,
    mode,
    uid: CURRENT_UID,
    gid: CURRENT_GID,
    ttydPassword: password,
    rootUid: CURRENT_UID,
    rootGid: CURRENT_GID,
    ...extra,
  });
}

function marker(paths) {
  return JSON.parse(fs.readFileSync(path.join(paths.rootDir, MARKER_NAME), "utf8"));
}

function authNames(paths) {
  return fs.readdirSync(paths.authDir).sort();
}

function assertMode(file, mode) {
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, mode);
}

function seedLegacy(paths) {
  fs.mkdirSync(paths.legacyAuthDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(paths.legacyAuthDir, 0o700);
  fs.writeFileSync(path.join(paths.legacyAuthDir, "gate.secret"), `${GATE_SECRET}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(paths.legacyAuthDir, "auth.session-generation"), SESSION_GENERATION, { mode: 0o600 });
  fs.writeFileSync(path.join(paths.legacyAuthDir, "2fa.secret"), `${TWO_FA_SECRET}\n`, { mode: 0o600 });
}

function completeFoundationRecovery(paths) {
  run(paths, "foundation", "old-access-key");
  run(paths, "foundation", "new-access-key");
  fs.unlinkSync(path.join(paths.authDir, RECOVERY_NAME));
}

function assertNoTransactionDebris(paths) {
  assert.equal(fs.existsSync(path.join(paths.rootDir, PENDING_NAME)), false);
  assert.deepEqual(fs.readdirSync(paths.rootDir).filter((name) => /^\.auth-(?:stage|quarantine)\./.test(name)), []);
}

function runCli(paths, mode, password, extraArgs = []) {
  return spawnSync(process.execPath, [
    path.join(import.meta.dirname, "..", "container", "maintenance-auth-state.js"),
    "--mode", mode,
    "--uid", String(CURRENT_UID),
    "--gid", String(CURRENT_GID),
    "--root", paths.rootDir,
    "--auth", paths.authDir,
    "--legacy-auth", paths.legacyAuthDir,
    "--legacy-gate-uid", String(CURRENT_UID),
    "--legacy-agent-uid", String(CURRENT_UID),
    ...extraArgs,
  ], { encoding: "utf8", env: { ...process.env, TTYD_PASSWORD: password } });
}

async function makeSocketLeaf(file) {
  const child = spawn(process.execPath, [
    "-e",
    "const net=require('node:net');const server=net.createServer();server.listen(process.argv[1],()=>process.stdout.write('ready\\n'));setInterval(()=>{},1000)",
    file,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  await Promise.race([
    once(child.stdout, "data"),
    once(child, "exit").then(([code]) => { throw new Error(`socket helper exited ${code}: ${stderr}`); }),
  ]);
  child.kill("SIGKILL");
  await once(child, "exit");
  assert.equal(fs.lstatSync(file).isSocket(), true, "fixture must leave a Unix socket leaf behind");
}

test("first legacy boot imports only valid session and 2FA leaves into protected state", (t) => {
  const paths = fixture();
  t.after(() => fs.rmSync(paths.base, { recursive: true, force: true }));
  seedLegacy(paths);

  const result = run(paths, "legacy", "legacy-access-key");

  // legacyAuthRemoved joined this shape when the import learned to delete what
  // it had just copied -- the legacy files are gone by the time this returns.
  assert.deepEqual(result, {
    mode: "legacy",
    rotationRequired: false,
    action: "legacy-imported",
    legacyAuthRemoved: ["gate.secret", "auth.session-generation", "2fa.secret"],
  });
  assert.deepEqual(authNames(paths), ["2fa.secret", "auth.session-generation", "gate.secret"]);
  assert.equal(fs.readFileSync(path.join(paths.authDir, "gate.secret"), "utf8"), `${GATE_SECRET}\n`);
  assert.equal(fs.readFileSync(path.join(paths.authDir, "auth.session-generation"), "utf8"), SESSION_GENERATION);
  assert.equal(fs.readFileSync(path.join(paths.authDir, "2fa.secret"), "utf8"), `${TWO_FA_SECRET}\n`);
  assert.deepEqual(marker(paths), {
    version: 2,
    mode: "legacy",
    keyFingerprint: fingerprintAccessKey("legacy-access-key"),
    rotationRequired: false,
    ownerUid: CURRENT_UID,
    ownerGid: CURRENT_GID,
    retiredKeyFingerprints: [],
  });
  assertMode(paths.rootDir, 0o711);
  assertMode(paths.authDir, 0o700);
  for (const name of authNames(paths)) assertMode(path.join(paths.authDir, name), 0o600);
  assertNoTransactionDebris(paths);
});

test("unsafe first-legacy leaves fail closed without reading or changing their victim", {
  skip: process.platform === "win32" ? "symlink, hardlink, and FIFO proof runs on Linux" : false,
}, (t) => {
  for (const kind of ["symlink", "hardlink", "fifo"]) {
    const paths = fixture();
    t.after(() => fs.rmSync(paths.base, { recursive: true, force: true }));
    fs.mkdirSync(paths.legacyAuthDir, { recursive: true, mode: 0o700 });
    const victim = path.join(paths.base, `${kind}-victim`);
    fs.writeFileSync(victim, `${GATE_SECRET}\n`, { mode: 0o600 });
    const leaf = path.join(paths.legacyAuthDir, "gate.secret");
    if (kind === "symlink") fs.symlinkSync(victim, leaf);
    if (kind === "hardlink") fs.linkSync(victim, leaf);
    if (kind === "fifo") {
      const made = spawnSync("mkfifo", [leaf], { encoding: "utf8" });
      assert.equal(made.status, 0, made.stderr);
    }
    assert.throws(() => run(paths, "legacy", "legacy-access-key"),
      kind === "hardlink" ? /multiple hard links/ : /not a regular file/);
    assert.equal(fs.readFileSync(victim, "utf8"), `${GATE_SECRET}\n`);
    assert.equal(fs.existsSync(paths.authDir), false);
  }
});

test("a symlinked legacy ancestor is refused and its target is untouched", {
  skip: process.platform === "win32" ? "symlink ancestor proof runs on Linux" : false,
}, (t) => {
  const paths = fixture();
  t.after(() => fs.rmSync(paths.base, { recursive: true, force: true }));
  const victim = path.join(paths.base, "legacy-victim");
  fs.mkdirSync(victim);
  fs.writeFileSync(path.join(victim, "gate.secret"), `${GATE_SECRET}\n`, { mode: 0o600 });
  fs.mkdirSync(path.dirname(paths.legacyAuthDir), { recursive: true });
  fs.symlinkSync(victim, paths.legacyAuthDir, process.platform === "win32" ? "junction" : "dir");

  assert.throws(() => run(paths, "legacy", "legacy-access-key"), /ancestor is not a regular directory/);
  assert.equal(fs.readFileSync(path.join(victim, "gate.secret"), "utf8"), `${GATE_SECRET}\n`);
  assert.equal(fs.existsSync(paths.authDir), false);
});

test("first Foundation activation discards all untrusted auth and retires the bootstrap key", (t) => {
  const paths = fixture();
  t.after(() => fs.rmSync(paths.base, { recursive: true, force: true }));
  fs.mkdirSync(paths.authDir, { recursive: true });
  fs.chmodSync(paths.rootDir, 0o711);
  fs.writeFileSync(path.join(paths.authDir, "gate.secret"), "agent-known-key\n");
  fs.writeFileSync(path.join(paths.authDir, "2fa.secret"), "agent-known-2fa\n");

  const result = run(paths, "foundation", "old-access-key");

  assert.deepEqual(result, { mode: "foundation", rotationRequired: true, action: "foundation-activated" });
  assert.deepEqual(authNames(paths), [ROTATION_NAME]);
  assert.equal(fs.readFileSync(path.join(paths.authDir, ROTATION_NAME), "utf8"), ROTATION_CONTENT);
  assert.deepEqual(marker(paths), {
    version: 2,
    mode: "foundation",
    keyFingerprint: fingerprintAccessKey("old-access-key"),
    rotationRequired: true,
    ownerUid: CURRENT_UID,
    ownerGid: CURRENT_GID,
    retiredKeyFingerprints: [fingerprintAccessKey("old-access-key")],
  });
  assert.doesNotMatch(fs.readFileSync(path.join(paths.rootDir, MARKER_NAME), "utf8"), /old-access-key/);
  assertNoTransactionDebris(paths);
});

test("unchanged key stays blocked; an unseen key rebuilds state and requires recovery acknowledgement", (t) => {
  const paths = fixture();
  t.after(() => fs.rmSync(paths.base, { recursive: true, force: true }));
  run(paths, "foundation", "old-access-key");
  const blockedInode = fs.statSync(paths.authDir).ino;

  assert.equal(run(paths, "foundation", "old-access-key").rotationRequired, true);
  assert.equal(fs.statSync(paths.authDir).ino, blockedInode);

  const result = run(paths, "foundation", "new-access-key");
  assert.deepEqual(result, { mode: "foundation", rotationRequired: false, action: "rotation-accepted" });
  assert.notEqual(fs.statSync(paths.authDir).ino, blockedInode);
  assert.deepEqual(authNames(paths), [RECOVERY_NAME]);
  assert.equal(fs.readFileSync(path.join(paths.authDir, RECOVERY_NAME), "utf8"), RECOVERY_CONTENT);
  assert.equal(marker(paths).keyFingerprint, fingerprintAccessKey("new-access-key"));
});

test("stable accepted Foundation boots preserve signing state and a pending recovery acknowledgement", (t) => {
  const paths = fixture();
  t.after(() => fs.rmSync(paths.base, { recursive: true, force: true }));
  run(paths, "foundation", "old-access-key");
  run(paths, "foundation", "new-access-key");
  const signing = path.join(paths.authDir, "gate.secret");
  fs.writeFileSync(signing, GATE_SECRET, { mode: 0o600 });
  const authInode = fs.statSync(paths.authDir).ino;
  const signingInode = fs.statSync(signing).ino;

  const result = run(paths, "foundation", "new-access-key");

  assert.deepEqual(result, { mode: "foundation", rotationRequired: false, action: "foundation-preserved" });
  assert.equal(fs.statSync(paths.authDir).ino, authInode);
  assert.equal(fs.statSync(signing).ino, signingInode);
  assert.equal(fs.readFileSync(signing, "utf8"), GATE_SECRET);
  assert.equal(fs.readFileSync(path.join(paths.authDir, RECOVERY_NAME), "utf8"), RECOVERY_CONTENT);
});

test("legacy rollback refuses both pending rotation and pending recovery", (t) => {
  for (const pending of [ROTATION_NAME, RECOVERY_NAME]) {
    const paths = fixture();
    t.after(() => fs.rmSync(paths.base, { recursive: true, force: true }));
    run(paths, "foundation", "old-access-key");
    let key = "old-access-key";
    if (pending === RECOVERY_NAME) {
      run(paths, "foundation", "new-access-key");
      key = "new-access-key";
    }
    assert.throws(() => run(paths, "legacy", key), pending === ROTATION_NAME ? /rollback is blocked.*rotated/ : /rollback is blocked.*recovery/i);
    assert.equal(marker(paths).mode, "foundation");
    assert.equal(fs.existsSync(path.join(paths.authDir, pending)), true);
  }
});

test("completed Foundation state rolls back by atomic clone and reactivation requires a new key", (t) => {
  const paths = fixture();
  t.after(() => fs.rmSync(paths.base, { recursive: true, force: true }));
  completeFoundationRecovery(paths);
  fs.writeFileSync(path.join(paths.authDir, "gate.secret"), GATE_SECRET, { mode: 0o600 });

  let result = run(paths, "legacy", "new-access-key");
  assert.equal(result.action, "legacy-activated");
  assert.equal(marker(paths).mode, "legacy");
  assert.equal(fs.readFileSync(path.join(paths.authDir, "gate.secret"), "utf8"), GATE_SECRET);

  result = run(paths, "foundation", "new-access-key");
  assert.deepEqual(result, { mode: "foundation", rotationRequired: true, action: "foundation-reactivated" });
  assert.deepEqual(authNames(paths), [ROTATION_NAME]);
});

test("restoring any retired access key never becomes a normal accepted change", (t) => {
  const paths = fixture();
  t.after(() => fs.rmSync(paths.base, { recursive: true, force: true }));
  run(paths, "foundation", "key-0");
  run(paths, "foundation", "key-1");
  fs.unlinkSync(path.join(paths.authDir, RECOVERY_NAME));
  run(paths, "foundation", "key-2");
  fs.unlinkSync(path.join(paths.authDir, RECOVERY_NAME));

  let result = run(paths, "foundation", "key-0");
  assert.deepEqual(result, { mode: "foundation", rotationRequired: true, action: "retired-key-rejected" });
  assert.deepEqual(authNames(paths), [ROTATION_NAME]);
  assert.ok(marker(paths).retiredKeyFingerprints.includes(fingerprintAccessKey("key-0")));
  assert.ok(marker(paths).retiredKeyFingerprints.includes(fingerprintAccessKey("key-1")));
  assert.ok(marker(paths).retiredKeyFingerprints.includes(fingerprintAccessKey("key-2")));

  result = run(paths, "foundation", "key-1");
  assert.equal(result.rotationRequired, true, "a second retired key also stays blocked");
  result = run(paths, "foundation", "key-3");
  assert.deepEqual(result, { mode: "foundation", rotationRequired: false, action: "rotation-accepted" });
});

test("trusted state refuses symlinks and hardlinks without changing victims", (t) => {
  for (const kind of ["symlink", "hardlink"]) {
    const paths = fixture();
    t.after(() => fs.rmSync(paths.base, { recursive: true, force: true }));
    completeFoundationRecovery(paths);
    const victim = path.join(paths.base, `${kind}-victim`);
    fs.writeFileSync(victim, `${GATE_SECRET}\n`, { mode: 0o600 });
    const leaf = path.join(paths.authDir, "gate.secret");
    if (kind === "symlink" && process.platform === "win32") {
      continue;
    }
    if (kind === "symlink") fs.symlinkSync(victim, leaf);
    else fs.linkSync(victim, leaf);

    assert.throws(() => run(paths, "foundation", "new-access-key"), kind === "symlink" ? /symbolic link/ : /multiple hard links/);
    assert.equal(fs.readFileSync(victim, "utf8"), `${GATE_SECRET}\n`);
  }
});

test("Foundation reactivation discards a hostile legacy tree without following or importing it", {
  skip: process.platform === "win32" ? "FIFO proof runs on Linux" : false,
}, (t) => {
  const paths = fixture();
  t.after(() => fs.rmSync(paths.base, { recursive: true, force: true }));
  completeFoundationRecovery(paths);
  run(paths, "legacy", "new-access-key");
  const fileVictim = path.join(paths.base, "file-victim");
  const dirVictim = path.join(paths.base, "dir-victim");
  fs.writeFileSync(fileVictim, "unchanged\n", { mode: 0o640 });
  fs.mkdirSync(dirVictim);
  fs.writeFileSync(path.join(dirVictim, "inside"), "unchanged-inside\n");
  fs.linkSync(fileVictim, path.join(paths.authDir, "hardlink"));
  fs.symlinkSync(dirVictim, path.join(paths.authDir, "symlink"), "dir");
  assert.equal(spawnSync("mkfifo", [path.join(paths.authDir, "fifo")]).status, 0);
  fs.writeFileSync(path.join(paths.authDir, "2fa.secret"), "legacy-seed-must-not-survive\n");

  const result = run(paths, "foundation", "new-access-key");

  assert.deepEqual(result, { mode: "foundation", rotationRequired: true, action: "foundation-reactivated" });
  assert.deepEqual(authNames(paths), [ROTATION_NAME]);
  assert.equal(fs.readFileSync(fileVictim, "utf8"), "unchanged\n");
  assert.equal(fs.readFileSync(path.join(dirVictim, "inside"), "utf8"), "unchanged-inside\n");
  assertNoTransactionDebris(paths);
});

test("a failed auth swap restores the original live directory immediately", (t) => {
  const paths = fixture();
  t.after(() => fs.rmSync(paths.base, { recursive: true, force: true }));
  completeFoundationRecovery(paths);
  fs.writeFileSync(path.join(paths.authDir, "gate.secret"), GATE_SECRET, { mode: 0o600 });
  const beforeInode = fs.statSync(paths.authDir).ino;

  assert.throws(() => run(paths, "legacy", "new-access-key", { faultAt: "auth-swap-failure" }), /injected.*failure/);

  assert.equal(fs.statSync(paths.authDir).ino, beforeInode);
  assert.equal(marker(paths).mode, "foundation");
  assert.equal(fs.readFileSync(path.join(paths.authDir, "gate.secret"), "utf8"), GATE_SECRET);
  assertNoTransactionDebris(paths);
});

test("restart recovers crashes at each transaction boundary without mixed ownership or debris", (t) => {
  for (const point of ["stage-owner", "auth-quarantined", "auth-swapped", "marker-written"]) {
    const paths = fixture();
    t.after(() => fs.rmSync(paths.base, { recursive: true, force: true }));
    completeFoundationRecovery(paths);
    fs.writeFileSync(path.join(paths.authDir, "gate.secret"), GATE_SECRET, { mode: 0o600 });
    assert.throws(() => run(paths, "legacy", "new-access-key", { faultAt: point }), /injected auth-state crash/);

    const result = run(paths, "legacy", "new-access-key");

    assert.ok(["legacy-activated", "legacy-preserved"].includes(result.action), `${point} recovered`);
    assert.equal(marker(paths).mode, "legacy");
    assert.equal(fs.readFileSync(path.join(paths.authDir, "gate.secret"), "utf8"), GATE_SECRET);
    assertNoTransactionDebris(paths);
  }
});

test("a crash with hostile legacy quarantine is recovered before any whole-root traversal", {
  skip: process.platform === "win32" ? "hostile FIFO crash recovery runs on Linux" : false,
}, (t) => {
  const paths = fixture();
  t.after(() => fs.rmSync(paths.base, { recursive: true, force: true }));
  completeFoundationRecovery(paths);
  run(paths, "legacy", "new-access-key");
  const victim = path.join(paths.base, "victim");
  fs.writeFileSync(victim, "unchanged\n");
  fs.symlinkSync(victim, path.join(paths.authDir, "symlink"));
  assert.equal(spawnSync("mkfifo", [path.join(paths.authDir, "fifo")]).status, 0);

  assert.throws(() => run(paths, "foundation", "new-access-key", { faultAt: "auth-quarantined" }), /injected auth-state crash/);
  const result = run(paths, "foundation", "new-access-key");

  assert.equal(result.rotationRequired, true);
  assert.deepEqual(authNames(paths), [ROTATION_NAME]);
  assert.equal(fs.readFileSync(victim, "utf8"), "unchanged\n");
  assertNoTransactionDebris(paths);
});

test("corrupt or linkable root marker fails closed", (t) => {
  const paths = fixture();
  t.after(() => fs.rmSync(paths.base, { recursive: true, force: true }));
  run(paths, "foundation", "old-access-key");
  const markerPath = path.join(paths.rootDir, MARKER_NAME);
  fs.writeFileSync(markerPath, "not-json\n");
  assert.throws(() => run(paths, "foundation", "old-access-key"), /corrupt JSON/);

  fs.unlinkSync(markerPath);
  const victim = path.join(paths.base, "marker-victim");
  fs.writeFileSync(victim, "unchanged\n");
  fs.linkSync(victim, markerPath);
  assert.throws(() => run(paths, "foundation", "old-access-key"), /multiple hard links/);
  assert.equal(fs.readFileSync(victim, "utf8"), "unchanged\n");
});

// HI's red-team finding, 2026-08-12: importLegacyAuth READ the legacy files and
// left them behind, so a retired gate.secret stayed readable by the jailed
// agent at /data/home/agent/.claude/agenthost. Confirmed on the live box --
// gate.secret 600 agent:agent and auth.session-generation 660 agent:boxstate.
test("legacy authentication files are deleted once the protected directory owns them", (t) => {
  const paths = fixture();
  t.after(() => fs.rmSync(paths.base, { recursive: true, force: true }));
  seedLegacy(paths);

  const result = run(paths, "legacy", "access-key");

  assert.equal(result.action, "legacy-imported");
  assert.deepEqual(result.legacyAuthRemoved.sort(), ["2fa.secret", "auth.session-generation", "gate.secret"]);
  for (const name of ["gate.secret", "auth.session-generation", "2fa.secret"]) {
    assert.equal(fs.existsSync(path.join(paths.legacyAuthDir, name)), false, `${name} must not survive the import`);
    // The protected copy is the one that keeps the value.
    assert.equal(fs.existsSync(path.join(paths.authDir, name)), true, `${name} must exist in the protected directory`);
  }
});

// The box that produced the finding imported months before the purge existed,
// so a fix that only ran on a fresh import would never reach it.
test("a box that already migrated still has its stale legacy files removed", (t) => {
  const paths = fixture();
  t.after(() => fs.rmSync(paths.base, { recursive: true, force: true }));
  seedLegacy(paths);
  run(paths, "legacy", "access-key");

  // Recreate the exact stale state found on the live box: the migration is long
  // done, and the legacy copies reappear on disk owned by the agent.
  fs.writeFileSync(path.join(paths.legacyAuthDir, "gate.secret"), `${GATE_SECRET}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(paths.legacyAuthDir, "auth.session-generation"), SESSION_GENERATION, { mode: 0o600 });

  const result = run(paths, "legacy", "access-key");

  assert.equal(result.action, "legacy-preserved");
  assert.deepEqual(result.legacyAuthRemoved.sort(), ["auth.session-generation", "gate.secret"]);
  assert.equal(fs.existsSync(path.join(paths.legacyAuthDir, "gate.secret")), false);
  assert.equal(fs.existsSync(path.join(paths.authDir, "gate.secret")), true);
});

// A retired key must not survive as a disaster-recovery convenience -- that is
// the exposure #383 closed, and Foundation activation is exactly when the old
// key stops being the live one.
test("foundation activation removes the retired legacy key it no longer uses", (t) => {
  const paths = fixture();
  t.after(() => fs.rmSync(paths.base, { recursive: true, force: true }));
  seedLegacy(paths);

  const result = run(paths, "foundation", "access-key");

  assert.equal(result.action, "foundation-activated");
  assert.equal(result.rotationRequired, true);
  assert.equal(fs.existsSync(path.join(paths.legacyAuthDir, "gate.secret")), false);
});

// The protected copy is already authoritative at this point, but allowing boot
// to continue would put the jailed agent back beside a fixed-name secret leaf.
test("an unpurgeable legacy leaf exits the boot CLI nonzero with its cause and preserves protected auth", {
  skip: ROOT_OWNERSHIP_CLI_AVAILABLE ? false : "root-owned gate-state CLI proof runs in the root Linux container",
}, (t) => {
  const paths = fixture();
  t.after(() => fs.rmSync(paths.base, { recursive: true, force: true }));
  seedLegacy(paths);
  run(paths, "legacy", "access-key");
  const protectedSecret = fs.readFileSync(path.join(paths.authDir, "gate.secret"), "utf8");
  const protectedMarker = fs.readFileSync(path.join(paths.rootDir, MARKER_NAME), "utf8");

  // unlink(2) cannot remove a directory. This is deterministic even when the
  // Linux root-only fixture runs as uid 0, unlike a chmod-only failure.
  fs.mkdirSync(path.join(paths.legacyAuthDir, "gate.secret"));

  const failed = runCli(paths, "legacy", "access-key");

  assert.equal(failed.status, 1);
  assert.match(
    failed.stderr,
    /FATAL: auth-state transition refused: legacy authentication purge failed: fixed legacy authentication leaf gate\.secret is a directory/,
  );
  assert.equal(fs.readFileSync(path.join(paths.authDir, "gate.secret"), "utf8"), protectedSecret);
  assert.equal(fs.readFileSync(path.join(paths.rootDir, MARKER_NAME), "utf8"), protectedMarker);
});

test("every fixed-name non-directory legacy leaf is unlinked without following it", {
  skip: process.platform === "win32" ? "symlink, FIFO, and Unix socket proof runs on Linux" : false,
}, async (t) => {
  for (const kind of ["regular", "symlink", "hardlink", "fifo", "socket"]) {
    await t.test(kind, async (t) => {
      const paths = fixture();
      t.after(() => fs.rmSync(paths.base, { recursive: true, force: true }));
      seedLegacy(paths);
      run(paths, "legacy", "access-key");
      const protectedSecret = fs.readFileSync(path.join(paths.authDir, "gate.secret"), "utf8");
      const leaf = path.join(paths.legacyAuthDir, "gate.secret");
      const victim = path.join(paths.base, `${kind}-victim`);

      if (kind === "regular") fs.writeFileSync(leaf, "retired\n", { mode: 0o600 });
      if (kind === "symlink") {
        fs.writeFileSync(victim, "unchanged\n", { mode: 0o600 });
        fs.symlinkSync(victim, leaf);
      }
      if (kind === "hardlink") {
        fs.writeFileSync(victim, "unchanged\n", { mode: 0o600 });
        fs.linkSync(victim, leaf);
      }
      if (kind === "fifo") assert.equal(spawnSync("mkfifo", [leaf]).status, 0);
      if (kind === "socket") await makeSocketLeaf(leaf);

      const result = run(paths, "legacy", "access-key");

      assert.deepEqual(result.legacyAuthRemoved, ["gate.secret"]);
      assert.equal(fs.existsSync(leaf), false, `${kind} leaf must be unlinked`);
      assert.equal(fs.readFileSync(path.join(paths.authDir, "gate.secret"), "utf8"), protectedSecret);
      if (kind === "symlink" || kind === "hardlink") {
        assert.equal(fs.readFileSync(victim, "utf8"), "unchanged\n", `${kind} victim must not change`);
      }
    });
  }
});

test("no legacy directory means nothing to purge and nothing to report", (t) => {
  const paths = fixture();
  t.after(() => fs.rmSync(paths.base, { recursive: true, force: true }));

  const result = run(paths, "legacy", "access-key");

  assert.equal(result.action, "legacy-initialized");
  assert.equal(result.legacyAuthRemoved, undefined);
  assert.equal(result.legacyAuthPurgeProblem, undefined);
});

// Kimi's review of PR #404 flagged the `safeLegacyDirectory` false branch as a
// silent skip. It is not: false means an ancestor is ABSENT, so there is
// genuinely nothing to purge, while an ancestor that exists and is unsafe
// THROWS and blocks boot with its cause. This proves the distinction rather than
// asserting it, because the reviewer could not tell them apart from the diff.
test("an unsafe legacy ancestor exits the boot CLI nonzero with its cause instead of skipping quietly", {
  skip: ROOT_OWNERSHIP_CLI_AVAILABLE ? false : "root-owned gate-state CLI proof runs in the root Linux container",
}, (t) => {
  const paths = fixture();
  t.after(() => fs.rmSync(paths.base, { recursive: true, force: true }));
  seedLegacy(paths);
  run(paths, "legacy", "access-key");

  // Replace the legacy directory with a regular file: the ancestor now exists
  // and is not a directory, which is the unsafe case, not the absent one.
  fs.rmSync(paths.legacyAuthDir, { recursive: true, force: true });
  fs.writeFileSync(paths.legacyAuthDir, "not a directory\n", { mode: 0o600 });

  const failed = runCli(paths, "legacy", "access-key");

  assert.equal(failed.status, 1);
  assert.match(
    failed.stderr,
    /legacy authentication purge failed: legacy authentication ancestor is not a regular directory/,
  );
  assert.equal(fs.existsSync(path.join(paths.authDir, "gate.secret")), true);
});
