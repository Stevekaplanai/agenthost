// D1 fix — the gate-state migration that lets gate.js (as `gate`) reach the box
// state `agent` owns, via the shared `boxstate` group. The group-parse + fail-
// closed paths run everywhere; the real chgrp/setgid/g+rw assertions need Linux +
// root (chgrp to an arbitrary group is privileged), so they self-skip off-box and
// the box/CI runs them. This is the RED-on-regress proof (Rule Constitution R0).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { migrateGateState, gidForGroup, GATE_STATE_ROOTS, NEVER_SHARE } = require("../container/maintenance-gate-state-migration.js");

const isLinux = process.platform === "linux";
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const moduleFile = path.join(import.meta.dirname, "..", "container", "maintenance-gate-state-migration.js");

function rootRunnerAvailable() {
  return isLinux && (isRoot || spawnSync("sudo", ["-n", "true"], { stdio: "ignore" }).status === 0);
}

function requireRootRunner(t) {
  if (rootRunnerAvailable()) return true;
  if (process.env.CI && isLinux) assert.fail("Linux CI must provide uid 0 or passwordless sudo for the real ownership proof");
  t.skip("real ownership proof needs Linux uid 0 or passwordless sudo");
  return false;
}

function runMigrationAsRoot(home, gid, roots) {
  const source = "const {migrateGateState}=require(process.argv[1]);migrateGateState({home:process.argv[2],gid:Number(process.argv[3]),roots:JSON.parse(process.argv[4])});";
  const args = [process.execPath, "-e", source, moduleFile, home, String(gid), JSON.stringify(roots)];
  return isRoot
    ? spawnSync(args[0], args.slice(1), { encoding: "utf8" })
    : spawnSync("sudo", ["-n", ...args], { encoding: "utf8" });
}

test("gidForGroup resolves the shared group from an /etc/group file; null when absent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gid-"));
  try {
    const gf = path.join(dir, "group");
    fs.writeFileSync(gf, "root:x:0:\nagent:x:1000:\nboxstate:x:1007:agent,gate\ngate:x:998:\n");
    assert.equal(gidForGroup("boxstate", gf), 1007);
    assert.equal(gidForGroup("gate", gf), 998);
    assert.equal(gidForGroup("nope", gf), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("migrateGateState fails closed when the shared group is absent (never runs a gate that can't reach its state)", () => {
  assert.throws(
    () => migrateGateState({ home: os.tmpdir(), groupName: "definitely-not-a-real-group-xyzzy" }),
    /not found/,
  );
});

test("migrateGateState is a no-op on absent roots (gate creates them; setgid parent shares them later)", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "home-empty-"));
  try {
    // Inject a gid so it doesn't depend on a real group; no roots exist under this home.
    const res = migrateGateState({ home, gid: process.getgid ? process.getgid() : 0, roots: [".claude/agenthost", ".agenthost"] });
    assert.deepEqual(res.shared, []); // nothing existed to share — no throw, no error
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("migrateGateState requires a normalized absolute HOME", () => {
  assert.throws(() => migrateGateState({ home: ".", gid: 0, roots: [] }), /normalized absolute home/i);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "home-normalized-"));
  try {
    assert.throws(
      () => migrateGateState({ home: `${home}${path.sep}.`, gid: 0, roots: [] }),
      /normalized absolute home/i,
    );
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("selected-root and intermediate symlinks are refused without touching the victim", () => {
  for (const kind of ["root", "intermediate"]) {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), `migration-${kind}-link-`));
    try {
      const home = path.join(fixture, "home");
      const victim = path.join(fixture, "victim");
      fs.mkdirSync(home);
      fs.mkdirSync(victim);
      const victimFile = path.join(victim, "preserve.txt");
      fs.writeFileSync(victimFile, "unchanged\n", { mode: 0o640 });
      const victimBefore = fs.statSync(victim);
      const before = fs.statSync(victimFile);
      if (kind === "root") {
        fs.symlinkSync(victim, path.join(home, ".agenthost"), "junction");
      } else {
        fs.symlinkSync(victim, path.join(home, ".claude"), "junction");
      }

      assert.throws(
        () => migrateGateState({ home, gid: before.gid, roots: [kind === "root" ? ".agenthost" : ".claude/agenthost"] }),
        kind === "root" ? /symbolic-link selected root/ : /symbolic-link selected-root ancestor/,
      );
      const victimAfter = fs.statSync(victim);
      const after = fs.statSync(victimFile);
      assert.equal(fs.readFileSync(victimFile, "utf8"), "unchanged\n");
      assert.equal(victimAfter.uid, victimBefore.uid);
      assert.equal(victimAfter.gid, victimBefore.gid);
      assert.equal(victimAfter.mode & 0o7777, victimBefore.mode & 0o7777);
      assert.equal(after.uid, before.uid);
      assert.equal(after.gid, before.gid);
      assert.equal(after.mode & 0o777, before.mode & 0o777);
    } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
  }
});

test("descendant symlinks are skipped without touching their target while ordinary siblings are migrated", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "migration-descendant-link-"));
  try {
    const home = path.join(fixture, "home");
    const root = path.join(home, ".openclaw");
    const pluginSkills = path.join(root, "plugin-skills");
    const target = path.join(fixture, "browser-automation-target");
    const link = path.join(pluginSkills, "browser-automation");
    const ordinary = path.join(pluginSkills, "manifest.json");
    const targetFile = path.join(target, "preserve.txt");
    fs.mkdirSync(pluginSkills, { recursive: true });
    fs.mkdirSync(target);
    fs.writeFileSync(ordinary, "{}\n");
    fs.writeFileSync(targetFile, "unchanged\n", { mode: 0o640 });
    fs.symlinkSync(target, link, "junction");

    const targetBefore = fs.statSync(target);
    const targetFileBefore = fs.statSync(targetFile);
    const inspected = [];
    const listed = [];
    const opened = [];
    const migrated = [];
    const fdPaths = new Map();
    const fsMod = Object.create(fs);
    fsMod.lstatSync = (fullPath) => {
      inspected.push(fullPath);
      return fs.lstatSync(fullPath);
    };
    fsMod.readdirSync = (fullPath) => {
      listed.push(fullPath);
      return fs.readdirSync(fullPath);
    };
    fsMod.openSync = (fullPath, flags, mode) => {
      const fd = fs.openSync(fullPath, flags, mode);
      opened.push(fullPath);
      fdPaths.set(fd, fullPath);
      return fd;
    };
    fsMod.fchownSync = (fd) => { migrated.push(fdPaths.get(fd)); };
    fsMod.fchmodSync = () => {};
    fsMod.closeSync = (fd) => {
      fdPaths.delete(fd);
      fs.closeSync(fd);
    };

    const result = migrateGateState({ home, gid: 1234, roots: [".openclaw"], fsMod });

    assert.deepEqual(result.shared, [".openclaw"]);
    assert.ok(inspected.includes(link), "the descendant link is identified with lstat");
    assert.ok(migrated.includes(ordinary), "the ordinary sibling still reaches the migration path");
    assert.ok(!listed.includes(link), "the descendant link is never traversed as a directory");
    assert.ok(!opened.includes(link), "the descendant link is never opened for metadata mutation");
    assert.ok(!opened.some((fullPath) => fullPath === target || fullPath.startsWith(target + path.sep)),
      "the symlink target is never opened through its external path");

    const targetAfter = fs.statSync(target);
    const targetFileAfter = fs.statSync(targetFile);
    assert.equal(fs.readFileSync(targetFile, "utf8"), "unchanged\n");
    assert.equal(targetAfter.uid, targetBefore.uid);
    assert.equal(targetAfter.gid, targetBefore.gid);
    assert.equal(targetAfter.mode & 0o7777, targetBefore.mode & 0o7777);
    assert.equal(targetFileAfter.uid, targetFileBefore.uid);
    assert.equal(targetFileAfter.gid, targetFileBefore.gid);
    assert.equal(targetFileAfter.mode & 0o777, targetFileBefore.mode & 0o777);
    assert.ok(fs.lstatSync(link).isSymbolicLink(), "the descendant link itself remains intact");
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});

test("a selected-root or intermediate identity swap after preflight cannot mutate the victim", () => {
  for (const kind of ["root", "intermediate"]) {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), `migration-${kind}-swap-`));
    try {
      const home = path.join(fixture, "home");
      const root = kind === "root"
        ? path.join(home, ".agenthost")
        : path.join(home, ".claude", "agenthost");
      const swappedComponent = kind === "root" ? root : path.join(home, ".claude");
      const victim = path.join(fixture, "victim");
      const victimRoot = kind === "root" ? victim : path.join(victim, "agenthost");
      fs.mkdirSync(root, { recursive: true });
      fs.mkdirSync(victimRoot, { recursive: true });
      fs.writeFileSync(path.join(root, "state.json"), "{}\n");
      const victimFile = path.join(victimRoot, "preserve.txt");
      fs.writeFileSync(victimFile, "unchanged\n", { mode: 0o640 });
      const victimRootBefore = fs.statSync(victimRoot);
      const before = fs.statSync(victimFile);
      let swapped = false;
      const fsMod = Object.create(fs);
      fsMod.openSync = (fullPath, flags, mode) => {
        if (!swapped && fullPath === root) {
          fs.renameSync(swappedComponent, swappedComponent + ".parked");
          fs.symlinkSync(victim, swappedComponent, "junction");
          swapped = true;
        }
        return fs.openSync(fullPath, flags, mode);
      };
      assert.throws(
        () => migrateGateState({
          home,
          gid: before.gid,
          roots: [kind === "root" ? ".agenthost" : ".claude/agenthost"],
          fsMod,
        }),
        /symbolic-link|identity changed|does not match preflight identity|ELOOP|ENOTDIR/,
      );
      const victimRootAfter = fs.statSync(victimRoot);
      const after = fs.statSync(victimFile);
      assert.equal(fs.readFileSync(victimFile, "utf8"), "unchanged\n");
      assert.equal(victimRootAfter.uid, victimRootBefore.uid);
      assert.equal(victimRootAfter.gid, victimRootBefore.gid);
      assert.equal(victimRootAfter.mode & 0o7777, victimRootBefore.mode & 0o7777);
      assert.equal(after.uid, before.uid);
      assert.equal(after.gid, before.gid);
      assert.equal(after.mode & 0o777, before.mode & 0o777);
    } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
  }
});

test("LINUX CI PROOF: migrateGateState shares ordinary state but keeps gate-only state closed", {
  skip: !isLinux ? "real uid and mode proof runs on Linux" : false,
}, (t) => {
  if (!requireRootRunner(t)) return;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "home-seed-"));
  try {
    // Seed a populated-volume shape: owner-only agent-ish files the gate can't read.
    const stateDir = path.join(home, ".claude", "agenthost");
    fs.mkdirSync(stateDir, { recursive: true });
    const secret = path.join(stateDir, "gate.secret");
    fs.writeFileSync(secret, "cookie-secret", { mode: 0o600 });
    const ordinary = path.join(stateDir, "git-ladder.json");
    fs.writeFileSync(ordinary, "{}\n", { mode: 0o600 });
    const runs = path.join(stateDir, "runs");
    fs.mkdirSync(runs, { mode: 0o700 });

    const targetGid = process.getgid() === 0 ? 65534 : 0;
    assert.notEqual(fs.statSync(ordinary).gid, targetGid, "fixture begins outside the target group");
    const ran = runMigrationAsRoot(home, targetGid, [".claude/agenthost"]);
    assert.equal(ran.status, 0, ran.stderr);

    const secretSt = fs.statSync(secret);
    assert.equal(secretSt.mode & 0o777, 0o600, "gate.secret is never group-shared");

    const ordinarySt = fs.statSync(ordinary);
    assert.equal(ordinarySt.gid, targetGid, "ordinary file group -> shared group");
    assert.equal(ordinarySt.mode & 0o060, 0o060, "ordinary file is group rw");

    const dirSt = fs.statSync(runs);
    assert.equal(dirSt.gid, targetGid, "dir group -> shared group");
    assert.equal(dirSt.mode & 0o2000, 0o2000, "dir has setgid (new children inherit the group)");
    assert.equal(dirSt.mode & 0o070, 0o070, "dir is group rwx (traversable)");
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("GATE_STATE_ROOTS covers gate.js's known state locations", () => {
  assert.ok(GATE_STATE_ROOTS.includes(".claude/agenthost"), "the gate's primary state dir");
  assert.ok(GATE_STATE_ROOTS.includes(".agenthost"), "secrets.env / key panel");
  assert.ok(GATE_STATE_ROOTS.includes(".hermes"), "the board DB");
  // Red-team D1 finding: gate WRITES ~/inbox (phone file-upload) and reads/serves
  // ~/outbox and ~/artifacts — all created agent-owned by start.sh, so they must
  // be shared or the file panel and reverse-pipe upload die with EACCES.
  assert.ok(GATE_STATE_ROOTS.includes("inbox"), "gate writes the reverse-pipe inbox");
  assert.ok(GATE_STATE_ROOTS.includes("outbox"), "gate serves the outbox");
  assert.ok(GATE_STATE_ROOTS.includes("artifacts"), "gate serves the Artifacts panel");
  // Second red-team pass: ~/.openclaw (channel bot tokens) MISSING silently
  // bricks every Telegram/Discord message (CHANNEL_ENGINE_INELIGIBLE) — the exact
  // 2026-07-24 prod incident — and blinds the health watcher. Hard blocker.
  assert.ok(GATE_STATE_ROOTS.includes(".openclaw"), "gate reads channel config → without it, channels silently die");
  // ~/.bridge.env (0600 file) — gate reads it; unshared, the desktop bridge fails closed.
  assert.ok(GATE_STATE_ROOTS.includes(".bridge.env"), "gate reads the desktop-bridge env");
  // Deliberately NOT shared (security invariant #2 / structural): the .claude
  // PARENT (holds .credentials.json) and .codex (gate's reader rejects group bits).
  assert.ok(!GATE_STATE_ROOTS.includes(".claude"), "never share the .claude parent — it holds .credentials.json");
  assert.ok(!GATE_STATE_ROOTS.includes(".codex"), "group-share cannot satisfy gate's codex-auth reader guard");
});

test("the gate's own auth secrets are never widened by the share, however shared the tree is", {
  skip: !isLinux ? "real uid and mode proof runs on Linux" : false,
}, (t) => {
  // MEASURED ON THE LIVE BOX 2026-08-11, which is why this test exists at all:
  //   gate.secret  gate:boxstate 0660  -> agent (uid 1001, in boxstate) READ IT
  // 65 bytes, confirmed by hand as the agent user. That file is one half of the
  // session-cookie HMAC, so any jailed engine holding it can mint operator
  // cookies -- and every consequence gate on this box rests on that cookie.
  //
  // gate.js was not the defect: loadGateSecret() already writes mode 0o600.
  // shareEntry was, by ORing g+rw onto every file under `.claude/agenthost` --
  // a tree whose own comment names gate.secret out loud -- on every boot.
  assert.ok(NEVER_SHARE.has("gate.secret"),
    "gate.secret must never be group-shared: it is the session-cookie HMAC key");
  assert.ok(NEVER_SHARE.has("2fa.secret"),
    "a second factor the agent group can read is not a second factor");
  assert.ok(NEVER_SHARE.has("vapid.json") && NEVER_SHARE.has("push-subs.json"),
    "push signing keys and operator endpoints are gate-only");

  // The behaviour, not just the list -- on a platform where modes are real.
  if (!requireRootRunner(t)) return;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nevershare-"));
  const dir = path.join(home, ".claude", "agenthost");
  fs.mkdirSync(dir, { recursive: true });
  const secret = path.join(dir, "gate.secret");
  const ordinary = path.join(dir, "git-ladder.json");
  fs.writeFileSync(secret, "s\n", { mode: 0o600 });
  fs.writeFileSync(ordinary, "{}\n", { mode: 0o600 });

  const ran = runMigrationAsRoot(home, process.getgid(), GATE_STATE_ROOTS);
  assert.equal(ran.status, 0, ran.stderr);

  assert.equal(fs.statSync(secret).mode & 0o777, 0o600,
    "the secret keeps the mode the gate wrote; sharing must not touch it");
  assert.notEqual(fs.statSync(ordinary).mode & 0o060, 0,
    "an ordinary state file IS still shared -- the exclusion must be surgical, not a blanket opt-out");
  fs.rmSync(home, { recursive: true, force: true });
});
