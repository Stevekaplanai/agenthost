"use strict";

// Root-only transition for the authentication state shared by legacy and
// Foundation B boots. Call this before either runtime uid starts. Raw access
// keys are never persisted; a bounded root-only fingerprint history prevents a
// later deploy from silently restoring a previously retired key.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const VERSION = 2;
const MARKER_NAME = "auth-transition.json";
const PENDING_NAME = "auth-transition.pending.json";
const ROTATION_NAME = "auth.rotation-required";
const ROTATION_CONTENT = "rotate-operator-access-key-v1\n";
const RECOVERY_NAME = "auth.recovery-required";
const RECOVERY_CONTENT = "confirm-key-only-recovery-v1\n";
const AUTH_VALUE_NAMES = Object.freeze(["gate.secret", "auth.session-generation", "2fa.secret"]);
const AUTH_NAMES = new Set([...AUTH_VALUE_NAMES, ROTATION_NAME, RECOVERY_NAME]);
const MAX_ROOT_FILE_BYTES = 16384;
const MAX_AUTH_FILE_BYTES = 256;
const MAX_RETIRED_KEYS = 64;
const IS_WINDOWS = process.platform === "win32";
const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const O_NONBLOCK = fs.constants.O_NONBLOCK || 0;
const O_DIRECTORY = fs.constants.O_DIRECTORY || 0;
const ORPHAN_PATTERN = /^\.auth-(?:stage|quarantine)\.[0-9]+\.[a-f0-9]{24}$/;

function fail(message) {
  throw new Error(`auth-state transition refused: ${message}`);
}

function fingerprintAccessKey(value) {
  if (typeof value !== "string" || value.length === 0) fail("TTYD_PASSWORD is missing");
  return crypto.createHash("sha256")
    .update("agenthost-auth-access-key-v1\0", "utf8")
    .update(value, "utf8")
    .digest("hex");
}

function modeBits(stat) {
  return stat.mode & 0o777;
}

function sameEntry(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function existsLstat(file) {
  try { return fs.lstatSync(file); }
  catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

function assertOwnerMode(stat, uid, gid, mode, label) {
  if (IS_WINDOWS) return;
  if (stat.uid !== uid || stat.gid !== gid) fail(`${label} has unexpected ownership`);
  if (modeBits(stat) !== mode) {
    fail(`${label} has mode ${modeBits(stat).toString(8)}, expected ${mode.toString(8)}`);
  }
}

function applyOwnerMode(target, uid, gid, mode) {
  if (!IS_WINDOWS) fs.chownSync(target, uid, gid);
  fs.chmodSync(target, mode);
}

function fsyncDirectory(directory) {
  let fd;
  try {
    fd = fs.openSync(directory, fs.constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    if (!fs.fstatSync(fd).isDirectory()) fail("fsync target is not a directory");
    fs.fsyncSync(fd);
  } catch (error) {
    if (!IS_WINDOWS || !["EBADF", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"].includes(error && error.code)) throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function ensureRoot(rootDir, rootUid, rootGid) {
  let stat = existsLstat(rootDir);
  if (!stat) {
    fs.mkdirSync(rootDir, { mode: 0o711 });
    applyOwnerMode(rootDir, rootUid, rootGid, 0o711);
    fsyncDirectory(path.dirname(rootDir));
    stat = fs.lstatSync(rootDir);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail("gate-state root is not a regular directory");
  assertOwnerMode(stat, rootUid, rootGid, 0o711, "gate-state root");
}

function readBoundedRegularFile(file, { uid, gid, mode, label, maxBytes = MAX_ROOT_FILE_BYTES, allowedUids = null }) {
  const before = fs.lstatSync(file);
  if (before.isSymbolicLink() || !before.isFile()) fail(`${label} is not a regular file`);
  if (before.nlink !== 1) fail(`${label} has multiple hard links`);
  if (allowedUids) {
    if (!IS_WINDOWS && !allowedUids.includes(before.uid)) fail(`${label} has an unsafe owner`);
    if (!IS_WINDOWS && modeBits(before) !== mode) fail(`${label} is not private mode ${mode.toString(8)}`);
  } else {
    assertOwnerMode(before, uid, gid, mode, label);
  }
  if (before.size < 1 || before.size > maxBytes) fail(`${label} has an invalid size`);

  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || !sameEntry(before, opened)) fail(`${label} changed while opening`);
    const buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (count === 0) fail(`${label} ended unexpectedly`);
      offset += count;
    }
    return buffer.toString("utf8");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function validateMarkerObject(marker, label = "auth transition marker") {
  const keys = marker && typeof marker === "object" && !Array.isArray(marker)
    ? Object.keys(marker).sort()
    : [];
  const expected = ["keyFingerprint", "mode", "ownerGid", "ownerUid", "retiredKeyFingerprints", "rotationRequired", "version"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    fail(`${label} has an invalid schema`);
  }
  if (marker.version !== VERSION || !["foundation", "legacy"].includes(marker.mode)) {
    fail(`${label} has an unsupported version or mode`);
  }
  if (!/^[a-f0-9]{64}$/.test(marker.keyFingerprint) || typeof marker.rotationRequired !== "boolean") {
    fail(`${label} has an invalid fingerprint or rotation state`);
  }
  if (marker.mode === "legacy" && marker.rotationRequired) fail(`${label} cannot require Foundation rotation in legacy mode`);
  if (!Number.isInteger(marker.ownerUid) || marker.ownerUid < 0 || !Number.isInteger(marker.ownerGid) || marker.ownerGid < 0) {
    fail(`${label} has invalid owner ids`);
  }
  if (!Array.isArray(marker.retiredKeyFingerprints) || marker.retiredKeyFingerprints.length > MAX_RETIRED_KEYS ||
      marker.retiredKeyFingerprints.some((value) => typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) ||
      new Set(marker.retiredKeyFingerprints).size !== marker.retiredKeyFingerprints.length) {
    fail(`${label} has an invalid retired-key history`);
  }
  return marker;
}

function parseJsonFile(file, options, label) {
  let raw;
  try { raw = readBoundedRegularFile(file, { ...options, label }); }
  catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
  try { return JSON.parse(raw); }
  catch { fail(`${label} is corrupt JSON`); }
}

function parseMarker(markerPath, rootUid, rootGid) {
  const marker = parseJsonFile(markerPath, { uid: rootUid, gid: rootGid, mode: 0o600 }, "auth transition marker");
  return marker ? validateMarkerObject(marker) : null;
}

function writeAtomicFile(file, contents, uid, gid, mode) {
  const directory = path.dirname(file);
  const temp = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(12).toString("hex")}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW, mode);
    fs.writeFileSync(fd, contents, "utf8");
    if (!IS_WINDOWS) fs.fchownSync(fd, uid, gid);
    fs.fchmodSync(fd, mode);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
    fsyncDirectory(directory);
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
}

function writeJson(file, value, rootUid, rootGid) {
  writeAtomicFile(file, `${JSON.stringify(value)}\n`, rootUid, rootGid, 0o600);
}

function unlinkIfPresent(file) {
  try { fs.unlinkSync(file); }
  catch (error) { if (!error || error.code !== "ENOENT") throw error; }
}

function removeTreeNoFollow(target) {
  const stat = existsLstat(target);
  if (!stat) return;
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    for (const name of fs.readdirSync(target)) removeTreeNoFollow(path.join(target, name));
    fs.rmdirSync(target);
  } else {
    fs.unlinkSync(target);
  }
}

function cleanupHelperOrphans(rootDir, keep = new Set()) {
  for (const name of fs.readdirSync(rootDir)) {
    if (!keep.has(name) && (ORPHAN_PATTERN.test(name) || /^\.(?:auth-transition(?:\.pending)?\.json)\..+\.tmp$/.test(name))) {
      removeTreeNoFollow(path.join(rootDir, name));
    }
  }
  fsyncDirectory(rootDir);
}

function authValue(name, raw, label) {
  const expression = name === "2fa.secret" ? /^[A-Z2-7]{32}(?:\r?\n)?$/ : /^[a-f0-9]{64}(?:\r?\n)?$/;
  if (!expression.test(raw)) fail(`${label} has an invalid ${name} value`);
  return raw;
}

function readProtectedAuth(authDir, ownerUid, ownerGid) {
  const directory = fs.lstatSync(authDir);
  if (directory.isSymbolicLink() || !directory.isDirectory()) fail("authentication state is not a regular directory");
  assertOwnerMode(directory, ownerUid, ownerGid, 0o700, "authentication directory");
  const files = new Map();
  for (const name of fs.readdirSync(authDir)) {
    const file = path.join(authDir, name);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) fail("authentication state contains a symbolic link");
    if (!stat.isFile()) fail("authentication state contains a special file");
    if (!AUTH_NAMES.has(name)) fail(`authentication state contains unsupported entry ${name}`);
    const raw = readBoundedRegularFile(file, {
      uid: ownerUid,
      gid: ownerGid,
      mode: 0o600,
      maxBytes: MAX_AUTH_FILE_BYTES,
      label: `authentication state ${name}`,
    });
    if (name === ROTATION_NAME && raw !== ROTATION_CONTENT) fail("rotation-required marker is corrupt");
    else if (name === RECOVERY_NAME && raw !== RECOVERY_CONTENT) fail("recovery-required marker is corrupt");
    else if (AUTH_VALUE_NAMES.includes(name)) authValue(name, raw, "authentication state");
    files.set(name, raw);
  }
  return files;
}

function safeLegacyDirectory(legacyAuthDir, allowedUids) {
  const absolute = path.resolve(legacyAuthDir);
  if (!path.isAbsolute(legacyAuthDir)) fail("legacy authentication directory must be absolute");
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = existsLstat(current);
    if (!stat) return false;
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`legacy authentication ancestor is not a regular directory: ${current}`);
    if (!IS_WINDOWS && !allowedUids.includes(stat.uid)) fail(`legacy authentication ancestor has an unsafe owner: ${current}`);
    // Ownership, no-follow resolution, and the pre-agent call close the legacy
    // read. A sticky shared ancestor such as /tmp in Linux fixtures is safe;
    // the fixed descendants themselves must still be owned by an allowed uid.
  }
  return true;
}

function importLegacyAuth(legacyAuthDir, allowedUids) {
  if (!legacyAuthDir) fail("first legacy boot requires the fixed legacy authentication directory");
  if (!safeLegacyDirectory(legacyAuthDir, allowedUids)) return new Map();
  const files = new Map();
  for (const name of AUTH_VALUE_NAMES) {
    const file = path.join(legacyAuthDir, name);
    if (!existsLstat(file)) continue;
    const raw = readBoundedRegularFile(file, {
      mode: 0o600,
      allowedUids,
      maxBytes: MAX_AUTH_FILE_BYTES,
      label: `legacy authentication ${name}`,
    });
    files.set(name, authValue(name, raw, "legacy authentication"));
  }
  return files;
}

// Delete the legacy copies once the protected directory owns the state.
//
// `importLegacyAuth` READ these files and never removed them, so a retired
// gate.secret stayed behind at `/data/home/agent/.claude/agenthost` -- a
// directory the boot sweep reclaims as `agent:agent`, which means the jailed
// engine could read a gate HMAC key. Found on the live box 2026-08-12: the
// stale `gate.secret` was `600 agent:agent` and `auth.session-generation` was
// `660 agent:boxstate`, group-readable by more than the agent. Neither could
// mint a cookie against the current gate -- the session generation had also
// rotated -- but #383's rule is that the agent holds NO gate secret, retired
// or active, because a rollback would make the retired one live again.
//
// The file IS the secret, so it is unlinked, never chmod'd.
//
// Deliberately not a disaster-recovery copy: if the root marker is ever lost
// the box re-initializes and demands a key rotation, which is the safe
// outcome. Keeping a readable retired key as a convenience is the exact thing
// #383 forbids.
function purgeLegacyAuth(legacyAuthDir, allowedUids) {
  if (!legacyAuthDir) return { removed: [] };
  const removed = [];
  try {
    if (!safeLegacyDirectory(legacyAuthDir, allowedUids)) return { removed };
    for (const name of AUTH_VALUE_NAMES) {
      const file = path.join(legacyAuthDir, name);
      const stat = existsLstat(file);
      if (!stat) continue;
      // lstat never follows the leaf. Every non-directory filesystem object is
      // safe to unlink by this fixed name: regular file, symlink, hardlink,
      // FIFO, or socket. A real directory cannot be unlinked and is fatal.
      if (stat.isDirectory()) fail(`fixed legacy authentication leaf ${name} is a directory`);
      fs.unlinkSync(file);
      removed.push(name);
    }
    if (removed.length) fsyncDirectory(legacyAuthDir);
    return { removed };
  } catch (error) {
    // Continuing would leave a fixed-name legacy secret beside the jailed
    // agent. Fail boot, name the actual filesystem cause, and leave the
    // authoritative protected copy untouched for the next retry.
    const cause = ((error && error.message) || String(error)).replace(/^auth-state transition refused: /, "");
    fail(`legacy authentication purge failed: ${cause}`);
  }
}

function markerFor(mode, keyFingerprint, rotationRequired, uid, gid, retiredKeyFingerprints) {
  return {
    version: VERSION,
    mode,
    keyFingerprint,
    rotationRequired,
    ownerUid: uid,
    ownerGid: gid,
    retiredKeyFingerprints,
  };
}

function retire(history, fingerprint) {
  if (history.includes(fingerprint)) return [...history];
  if (history.length >= MAX_RETIRED_KEYS) fail("retired access-key history is full; refusing to forget an older key");
  return [...history, fingerprint];
}

function uniqueSiblingName(prefix) {
  return `.${prefix}.${process.pid}.${crypto.randomBytes(12).toString("hex")}`;
}

function crash(point) {
  const error = new Error(`injected auth-state crash at ${point}`);
  error.code = "AUTH_STATE_INJECTED_CRASH";
  throw error;
}

function hitFault(faultAt, point) {
  if (faultAt === point) crash(point);
  if (faultAt === `${point}-failure`) throw new Error(`injected auth-state failure at ${point}`);
}

function createStage(rootDir, stageName, files, uid, gid, faultAt) {
  const stage = path.join(rootDir, stageName);
  fs.mkdirSync(stage, { mode: 0o700 });
  applyOwnerMode(stage, uid, gid, 0o700);
  try {
    for (const [name, contents] of files) {
      writeAtomicFile(path.join(stage, name), contents, uid, gid, 0o600);
      hitFault(faultAt, "stage-owner");
    }
    fsyncDirectory(stage);
    hitFault(faultAt, "stage-built");
    return stage;
  } catch (error) {
    if (error.code !== "AUTH_STATE_INJECTED_CRASH") removeTreeNoFollow(stage);
    throw error;
  }
}

function validatePending(value) {
  const keys = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort() : [];
  const expected = ["authWasPresent", "desiredMarker", "quarantineName", "stageName", "version"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index]) || value.version !== VERSION ||
      typeof value.authWasPresent !== "boolean" || !ORPHAN_PATTERN.test(value.stageName) || !ORPHAN_PATTERN.test(value.quarantineName) ||
      value.stageName === value.quarantineName) {
    fail("auth transition journal has an invalid schema");
  }
  validateMarkerObject(value.desiredMarker, "auth transition journal marker");
  return value;
}

function recoverPending(rootDir, authDir, rootUid, rootGid) {
  const pendingPath = path.join(rootDir, PENDING_NAME);
  const pendingValue = parseJsonFile(pendingPath, { uid: rootUid, gid: rootGid, mode: 0o600 }, "auth transition journal");
  if (!pendingValue) {
    cleanupHelperOrphans(rootDir);
    return;
  }
  const pending = validatePending(pendingValue);
  const stage = path.join(rootDir, pending.stageName);
  const quarantine = path.join(rootDir, pending.quarantineName);
  const keep = new Set([pending.stageName, pending.quarantineName]);
  cleanupHelperOrphans(rootDir, keep);
  const authStat = existsLstat(authDir);
  const stageStat = existsLstat(stage);
  const quarantineStat = existsLstat(quarantine);

  if (!authStat && quarantineStat) {
    fs.renameSync(quarantine, authDir);
    if (stageStat) removeTreeNoFollow(stage);
    unlinkIfPresent(pendingPath);
    fsyncDirectory(rootDir);
    cleanupHelperOrphans(rootDir);
    return;
  }

  if (authStat && quarantineStat) {
    readProtectedAuth(authDir, pending.desiredMarker.ownerUid, pending.desiredMarker.ownerGid);
    writeJson(path.join(rootDir, MARKER_NAME), pending.desiredMarker, rootUid, rootGid);
    removeTreeNoFollow(quarantine);
    if (stageStat) removeTreeNoFollow(stage);
    unlinkIfPresent(pendingPath);
    fsyncDirectory(rootDir);
    cleanupHelperOrphans(rootDir);
    return;
  }

  if (authStat && !quarantineStat && !stageStat) {
    readProtectedAuth(authDir, pending.desiredMarker.ownerUid, pending.desiredMarker.ownerGid);
    writeJson(path.join(rootDir, MARKER_NAME), pending.desiredMarker, rootUid, rootGid);
    unlinkIfPresent(pendingPath);
    fsyncDirectory(rootDir);
    cleanupHelperOrphans(rootDir);
    return;
  }

  if (authStat && stageStat && !quarantineStat) {
    // The live auth directory was never moved. Abort without changing it.
    removeTreeNoFollow(stage);
    unlinkIfPresent(pendingPath);
    fsyncDirectory(rootDir);
    cleanupHelperOrphans(rootDir);
    return;
  }

  if (!authStat && !quarantineStat && stageStat && !pending.authWasPresent) {
    // No old directory existed and the swap never began. Abort and retry from
    // the caller's current mode/key rather than completing stale boot intent.
    removeTreeNoFollow(stage);
    unlinkIfPresent(pendingPath);
    fsyncDirectory(rootDir);
    cleanupHelperOrphans(rootDir);
    return;
  }
  fail("auth transition journal does not match a recoverable filesystem state");
}

function replaceAuth({ rootDir, authDir, files, uid, gid, desiredMarker, rootUid, rootGid, faultAt }) {
  const stageName = uniqueSiblingName("auth-stage");
  const quarantineName = uniqueSiblingName("auth-quarantine");
  const stage = createStage(rootDir, stageName, files, uid, gid, faultAt);
  const quarantine = path.join(rootDir, quarantineName);
  const authWasPresent = Boolean(existsLstat(authDir));
  const pendingPath = path.join(rootDir, PENDING_NAME);
  const pending = { version: VERSION, stageName, quarantineName, authWasPresent, desiredMarker };
  writeJson(pendingPath, pending, rootUid, rootGid);
  hitFault(faultAt, "journal-written");

  try {
    if (authWasPresent) {
      fs.renameSync(authDir, quarantine);
      fsyncDirectory(rootDir);
    }
    hitFault(faultAt, "auth-quarantined");
    hitFault(faultAt, "auth-swap");
    fs.renameSync(stage, authDir);
    fsyncDirectory(rootDir);
    hitFault(faultAt, "auth-swapped");
    writeJson(path.join(rootDir, MARKER_NAME), desiredMarker, rootUid, rootGid);
    hitFault(faultAt, "marker-written");
    if (authWasPresent) removeTreeNoFollow(quarantine);
    unlinkIfPresent(pendingPath);
    fsyncDirectory(rootDir);
    cleanupHelperOrphans(rootDir);
  } catch (error) {
    if (error.code !== "AUTH_STATE_INJECTED_CRASH") {
      try { recoverPending(rootDir, authDir, rootUid, rootGid); } catch {}
    }
    throw error;
  }
}

function reconcileAuthStateCore({
  mode,
  uid,
  gid,
  ttydPassword,
  rootDir = "/data/agenthost-gate-state",
  authDir = path.join(rootDir, "auth"),
  legacyAuthDir = null,
  legacyGateUid = null,
  legacyAgentUid = null,
  rootUid = 0,
  rootGid = 0,
  faultAt = null,
} = {}) {
  if (!["foundation", "legacy"].includes(mode)) fail("mode must be foundation or legacy");
  if (!Number.isInteger(uid) || uid < 0 || !Number.isInteger(gid) || gid < 0) fail("selected uid/gid are invalid");
  if (!Number.isInteger(rootUid) || rootUid < 0 || !Number.isInteger(rootGid) || rootGid < 0) fail("root uid/gid are invalid");
  const resolvedRoot = path.resolve(rootDir);
  const resolvedAuth = path.resolve(authDir);
  if (!path.isAbsolute(rootDir) || resolvedAuth !== path.join(resolvedRoot, "auth")) {
    fail("authentication directory must be the fixed auth child of an absolute gate-state root");
  }
  if (legacyAuthDir && path.resolve(legacyAuthDir) === resolvedAuth) fail("legacy and protected authentication directories must differ");

  ensureRoot(resolvedRoot, rootUid, rootGid);
  recoverPending(resolvedRoot, resolvedAuth, rootUid, rootGid);
  const markerPath = path.join(resolvedRoot, MARKER_NAME);
  const marker = parseMarker(markerPath, rootUid, rootGid);
  const keyFingerprint = fingerprintAccessKey(ttydPassword);

  if (!marker && mode === "legacy") {
    const allowedUids = [...new Set([
      0,
      rootUid,
      uid,
      Number.isInteger(legacyGateUid) ? legacyGateUid : null,
      Number.isInteger(legacyAgentUid) ? legacyAgentUid : null,
    ].filter(Number.isInteger))];
    const files = importLegacyAuth(legacyAuthDir, allowedUids);
    const desired = markerFor("legacy", keyFingerprint, false, uid, gid, []);
    replaceAuth({ rootDir: resolvedRoot, authDir: resolvedAuth, files, uid, gid, desiredMarker: desired, rootUid, rootGid, faultAt });
    return { mode, rotationRequired: false, action: files.size ? "legacy-imported" : "legacy-initialized" };
  }

  if (!marker || (mode === "foundation" && marker.mode === "legacy")) {
    let retired = marker ? [...marker.retiredKeyFingerprints] : [];
    retired = retire(retired, keyFingerprint); // first Foundation key is never an accepted replacement
    if (marker && marker.keyFingerprint !== keyFingerprint) retired = retire(retired, marker.keyFingerprint);
    const desired = markerFor("foundation", keyFingerprint, true, uid, gid, retired);
    const files = new Map([[ROTATION_NAME, ROTATION_CONTENT]]);
    replaceAuth({ rootDir: resolvedRoot, authDir: resolvedAuth, files, uid, gid, desiredMarker: desired, rootUid, rootGid, faultAt });
    return { mode, rotationRequired: true, action: marker ? "foundation-reactivated" : "foundation-activated" };
  }

  const files = readProtectedAuth(resolvedAuth, marker.ownerUid, marker.ownerGid);
  if (mode === "legacy") {
    if (files.has(ROTATION_NAME) || marker.rotationRequired) fail("legacy rollback is blocked until the operator access key is rotated");
    if (files.has(RECOVERY_NAME)) fail("legacy rollback is blocked until key-only recovery is explicitly acknowledged");
    if (marker.retiredKeyFingerprints.includes(keyFingerprint) && keyFingerprint !== marker.keyFingerprint) {
      fail("a retired operator access key cannot be restored in legacy mode");
    }
    let retired = [...marker.retiredKeyFingerprints];
    if (keyFingerprint !== marker.keyFingerprint) retired = retire(retired, marker.keyFingerprint);
    const desired = markerFor("legacy", keyFingerprint, false, uid, gid, retired);
    if (marker.mode !== "legacy" || marker.ownerUid !== uid || marker.ownerGid !== gid) {
      const values = new Map([...files].filter(([name]) => AUTH_VALUE_NAMES.includes(name)));
      replaceAuth({ rootDir: resolvedRoot, authDir: resolvedAuth, files: values, uid, gid, desiredMarker: desired, rootUid, rootGid, faultAt });
      return { mode, rotationRequired: false, action: marker.mode === "foundation" ? "legacy-activated" : "legacy-owner-updated" };
    }
    if (keyFingerprint !== marker.keyFingerprint) writeJson(markerPath, desired, rootUid, rootGid);
    return { mode, rotationRequired: false, action: "legacy-preserved" };
  }

  if (marker.mode !== "foundation") fail("persisted transition mode is inconsistent");
  if (keyFingerprint !== marker.keyFingerprint) {
    let retired = retire(marker.retiredKeyFingerprints, marker.keyFingerprint);
    const keyWasRetired = retired.includes(keyFingerprint);
    const rotationRequired = keyWasRetired;
    if (keyWasRetired) retired = retire(retired, keyFingerprint);
    const nextFiles = new Map([[rotationRequired ? ROTATION_NAME : RECOVERY_NAME, rotationRequired ? ROTATION_CONTENT : RECOVERY_CONTENT]]);
    const desired = markerFor("foundation", keyFingerprint, rotationRequired, uid, gid, retired);
    replaceAuth({ rootDir: resolvedRoot, authDir: resolvedAuth, files: nextFiles, uid, gid, desiredMarker: desired, rootUid, rootGid, faultAt });
    return {
      mode,
      rotationRequired,
      action: rotationRequired ? "retired-key-rejected" : marker.rotationRequired ? "rotation-accepted" : "access-key-changed",
    };
  }

  if (marker.rotationRequired !== files.has(ROTATION_NAME)) fail("rotation-required marker does not match the root trust record");
  if (marker.rotationRequired && files.has(RECOVERY_NAME)) fail("rotation and recovery cannot be pending together");
  if (marker.ownerUid !== uid || marker.ownerGid !== gid) {
    const desired = markerFor("foundation", keyFingerprint, marker.rotationRequired, uid, gid, marker.retiredKeyFingerprints);
    replaceAuth({ rootDir: resolvedRoot, authDir: resolvedAuth, files, uid, gid, desiredMarker: desired, rootUid, rootGid, faultAt });
  }
  return { mode, rotationRequired: marker.rotationRequired, action: "foundation-preserved" };
}

// The purge runs after EVERY successful reconcile, not only after the first
// legacy import. Boxes that imported before this existed -- Steve's included --
// still hold the stale files, and a fix that only guards fresh imports would
// never reach them.
function reconcileAuthState(options = {}) {
  const result = reconcileAuthStateCore(options);
  const { uid, legacyAuthDir = null, legacyGateUid = null, legacyAgentUid = null, rootUid = 0 } = options;
  const allowedUids = [...new Set([0, rootUid, uid, legacyGateUid, legacyAgentUid].filter(Number.isInteger))];
  const purge = purgeLegacyAuth(legacyAuthDir, allowedUids);
  if (purge.removed.length) result.legacyAuthRemoved = purge.removed;
  return result;
}

function parseCli(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key || !key.startsWith("--") || value === undefined) fail("CLI arguments must be --name value pairs");
    values[key.slice(2)] = value;
  }
  return values;
}

if (require.main === module) {
  try {
    const args = parseCli(process.argv.slice(2));
    const result = reconcileAuthState({
      mode: args.mode,
      uid: Number(args.uid),
      gid: Number(args.gid),
      ttydPassword: process.env.TTYD_PASSWORD,
      rootDir: args.root || "/data/agenthost-gate-state",
      authDir: args.auth,
      legacyAuthDir: args["legacy-auth"],
      legacyGateUid: args["legacy-gate-uid"] === undefined ? null : Number(args["legacy-gate-uid"]),
      legacyAgentUid: args["legacy-agent-uid"] === undefined ? null : Number(args["legacy-agent-uid"]),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`[agenthost] FATAL: ${(error && error.message) || error}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  MARKER_NAME,
  PENDING_NAME,
  RECOVERY_CONTENT,
  RECOVERY_NAME,
  ROTATION_CONTENT,
  ROTATION_NAME,
  fingerprintAccessKey,
  reconcileAuthState,
};
