"use strict";

// D1 fix (red-team NO-GO defect 1): give gate.js — which runs as the `gate` uid
// under Foundation B — access to its on-disk state, which is owned by `agent`.
// The interactive stack (start.sh, as `agent`) ALSO needs that state, so the fix
// is SHARED ACCESS, never ownership transfer: a `boxstate` group that both `agent`
// and `gate` belong to, applied to gate's state trees so BOTH can read/write.
//
// This runs as ROOT once per boot, before either runtime uid starts. Every
// selected tree is preflighted before the first metadata change; each ancestor
// and leaf is then identity-checked again before an fd-based chown/chmod. That
// ordering is safe at its intended call site because the untrusted agent is not
// alive yet; selected-root/ancestor symlinks, hard links, special files, mount
// crossings, and identity changes fail the boot closed with their cause. A
// descendant symlink is an opaque leaf: preflight identifies and skips it.
//
// RESIDUAL (box-verify): a shared-state file the AGENT rewrites at runtime after
// this pass (for example secrets.env at mode 0600) can remain gate-unreadable
// until the next boot. Runtime writers must preserve the shared group mode.
//
// BOX-VERIFY REQUIRED (Rule 10): chown/chgrp/setgid + the populated-volume
// behavior are Linux, unverifiable off the box. The acceptance test in
// test/maintenance-gate-state-migration.test.js runs the real ownership assertions
// under Linux/CI, and the pre-flip staging run must confirm: as `gate`, gate.js
// reads the board DB and shared secrets.env without EACCES, while the `agent`
// stack still works. Auth/consequence-signing state is handled separately under
// the protected /data/agenthost-gate-state/auth tree.

const fs = require("node:fs");
const path = require("node:path");

// Gate.js's shared on-disk state, relative to HOME. Existing ordinary files get
// explicit group read/write; directories get group traversal/write plus setgid.
// This pass now runs before either runtime uid, so persisted contents are handled
// here and fresh runtime writers remain responsible for their file modes.
// AUDITED against every `path.join(HOME_DIR, …)` gate.js reads/writes as the
// `gate` uid (grep of gate.js, 2026-07-24). Each entry is agent-created; gate
// needs it via the boxstate group-share. NOTE — deliberately EXCLUDED:
//   • `.claude` (parent) is NOT shared: it holds `.claude/.credentials.json`,
//     which security-invariant #2 keeps off any shared surface. Only the
//     `.claude/agenthost` SUBTREE is shared. gate shells `claude` via OAuth in
//     env (the proven gate-exec pattern), so it never needs `.credentials.json`.
//   • `.codex/auth.json` CANNOT be shared by this mechanism: gate.js's own
//     readCodexChatGptAuth (gate.js:742) rejects any file where owner!=self OR
//     (mode & 0o077)!=0 — so g+rw is *rejected by design*. Codex-as-chat-engine
//     under the flag needs a different mechanism (gate owning its own codex auth)
//     or is out of scope for first activation. Named here so it isn't a silent
//     break discovered at flip. (Red-team D1 finding, 2026-07-24.)
//   • `~/work`, `.claude/settings.json|mcp.json|.claude.json|skills`, and the
//     marketing-graphics repo paths gate serves are read-and-degrade-gracefully;
//     BOX-VERIFY confirms none is a hard gate dependency on the live layout.
//   • `.tmux-seam` MUST NOT be added here. This migration applies g+rw(x)+setgid
//     recursively, which would make the seam dir group-WRITABLE — and a group-
//     writable seam dir lets the gate uid create/unlink/symlink inside it
//     (plant a symlink over windows.state, squat the fifo), re-opening exactly
//     the escalation the seam is built to close. The seam sets its OWN modes in
//     start.sh (dir 2750, state 0640, fifo 0620 — gate can read/write the leaves
//     but NOT mutate the directory). Leave it out on purpose. (2026-07-25.)
const GATE_STATE_ROOTS = Object.freeze([
  ".claude/agenthost",   // legacy/shared residue: git-ladder.json, board-claims.sqlite, usage.json, audit.log, hermes-dashboard.token, chat-runs/, runs/, uploads/, mail/, artifacts/
  ".agenthost",          // secrets.env + the 🔑 key panel state + uploads/, mail/store.json
  ".hermes",             // kanban.db / state.db (the board) — gate reads it
  ".openclaw",           // openclaw.json (bot tokens) — gate reads it for channelOwnerReady/credentialPresent; MISSING it silently bricks Telegram/Discord (CHANNEL_ENGINE_INELIGIBLE) + blinds the health watcher. The hard D1 blocker.
  ".bridge.env",         // desktop-bridge env (a FILE, 0600) — gate reads it; unshared = bridge silently fails closed
  "inbox",               // gate WRITES here (phone file-upload → the team); created 0755 agent by start.sh, so gate needs the dir group-writable
  "outbox",              // gate reads/serves; created agent by start.sh
  "artifacts",           // gate reads/serves the Artifacts panel; created agent by start.sh
]);

// Resolve a group name to its gid from /etc/group (Linux). Returns null if absent.
function gidForGroup(groupName, groupFile = "/etc/group") {
  let text;
  try { text = fs.readFileSync(groupFile, "utf8"); } catch { return null; }
  for (const line of text.split("\n")) {
    const [name, , gid] = line.split(":");
    if (name === groupName) { const n = Number(gid); return Number.isInteger(n) ? n : null; }
  }
  return null;
}

// THE FILES THAT MUST NEVER BE SHARED, however shared the tree around them is.
//
// Current auth state lives outside HOME in the protected auth tree. These names
// remain denylisted by basename so any legacy residue under a shared tree is
// never widened. Unexpected reserved directories fail preflight; regular leaves
// are left unchanged.
const NEVER_SHARE = new Set([
  "gate.secret",      // session-cookie HMAC key — operator impersonation
  "2fa.secret",       // second factor; sharing it defeats the point of a second factor
  "vapid.json",       // web-push signing keys
  "push-subs.json",   // operator's push endpoints
]);

function migrationError(message, fullPath) {
  return new Error(`migrateGateState: ${message}: ${fullPath}`);
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino
    && left.nlink === right.nlink
    && left.isDirectory() === right.isDirectory()
    && left.isFile() === right.isFile();
}

function requiredLstat(fullPath, fsMod) {
  try { return fsMod.lstatSync(fullPath); }
  catch (error) {
    throw migrationError(`could not inspect path (${(error && error.code) || error})`, fullPath);
  }
}

// Capture every directory from the filesystem root through HOME. A symlink in
// an intermediate component is as dangerous as a symlink at the selected leaf:
// a later path-based open would otherwise traverse it before O_NOFOLLOW can see
// the final component.
function snapshotDirectoryChain(fullPath, fsMod) {
  const parsed = path.parse(fullPath);
  const chain = [];
  let cursor = parsed.root;
  for (const piece of path.relative(parsed.root, fullPath).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, piece);
    const st = requiredLstat(cursor, fsMod);
    if (st.isSymbolicLink()) throw migrationError("refusing symbolic-link path component", cursor);
    if (!st.isDirectory()) throw migrationError("path component is not a directory", cursor);
    chain.push({ fullPath: cursor, st });
  }
  return chain;
}

function selectedRootPath(home, rel) {
  if (typeof rel !== "string" || !rel || path.isAbsolute(rel)) {
    throw new Error("migrateGateState: selected roots must be non-empty relative paths");
  }
  const pieces = rel.replaceAll("\\", "/").split("/");
  if (pieces.some((piece) => !piece || piece === "." || piece === "..")) {
    throw new Error(`migrateGateState: unsafe selected root '${rel}'`);
  }
  const fullPath = path.resolve(home, ...pieces);
  if (fullPath !== home && !fullPath.startsWith(home + path.sep)) {
    throw new Error(`migrateGateState: selected root escapes HOME: '${rel}'`);
  }
  return fullPath;
}

function snapshotTree(fullPath, fsMod, expectedFile, homeDev, ancestors, out) {
  const st = requiredLstat(fullPath, fsMod);
  if (st.isSymbolicLink()) throw migrationError("refusing symbolic-link gate-state entry", fullPath);
  if (st.dev !== homeDev) throw migrationError("refusing cross-device gate-state entry", fullPath);
  if (expectedFile ? !st.isFile() : !st.isDirectory()) {
    throw migrationError(expectedFile ? "selected root is not a regular file" : "selected root is not a directory", fullPath);
  }
  const reserved = NEVER_SHARE.has(path.basename(fullPath));
  if (reserved && !st.isFile()) throw migrationError("reserved gate-only state is not a regular file", fullPath);
  if (st.isFile() && st.nlink !== 1) throw migrationError("refusing multiply-linked gate-state file", fullPath);

  const snapshot = { fullPath, st, ancestors: [...ancestors] };
  out.push(snapshot);
  if (reserved || !st.isDirectory()) return;

  let names;
  try { names = fsMod.readdirSync(fullPath); }
  catch (error) { throw migrationError(`could not list directory (${(error && error.code) || error})`, fullPath); }
  for (const name of names) {
    const child = path.join(fullPath, name);
    const childSt = requiredLstat(child, fsMod);
    if (childSt.isSymbolicLink()) continue;
    if (!childSt.isDirectory() && !childSt.isFile()) throw migrationError("refusing special gate-state entry", child);
    snapshotTree(child, fsMod, childSt.isFile(), homeDev, [...ancestors, snapshot], out);
  }
}

function verifySnapshot(snapshot, fsMod) {
  const current = requiredLstat(snapshot.fullPath, fsMod);
  if (current.isSymbolicLink() || !sameIdentity(current, snapshot.st)) {
    throw migrationError("path identity changed after preflight", snapshot.fullPath);
  }
  return current;
}

function shareSnapshot(snapshot, gid, fsMod) {
  if (NEVER_SHARE.has(path.basename(snapshot.fullPath))) return false;
  for (const ancestor of snapshot.ancestors) verifySnapshot(ancestor, fsMod);
  verifySnapshot(snapshot, fsMod);

  const constants = fsMod.constants || fs.constants;
  const flags = constants.O_RDONLY
    | (constants.O_NOFOLLOW || 0)
    | (constants.O_NONBLOCK || 0)
    | (snapshot.st.isDirectory() ? (constants.O_DIRECTORY || 0) : 0);
  let fd;
  try {
    fd = fsMod.openSync(snapshot.fullPath, flags);
    const opened = fsMod.fstatSync(fd);
    if (!sameIdentity(opened, snapshot.st)) {
      throw migrationError("opened path does not match preflight identity", snapshot.fullPath);
    }
    fsMod.fchownSync(fd, opened.uid, gid);
    const afterOwner = fsMod.fstatSync(fd);
    if (!sameIdentity(afterOwner, snapshot.st)) {
      throw migrationError("path identity changed during ownership update", snapshot.fullPath);
    }
    const base = afterOwner.mode & 0o777;
    const next = afterOwner.isDirectory()
      ? (base | 0o070) | 0o2000
      : (base | 0o060);
    if ((afterOwner.mode & 0o7777) !== (next & 0o7777)) fsMod.fchmodSync(fd, next);
    const afterMode = fsMod.fstatSync(fd);
    if (!sameIdentity(afterMode, snapshot.st)) {
      throw migrationError("path identity changed during permission update", snapshot.fullPath);
    }
    return true;
  } finally {
    if (fd !== undefined) fsMod.closeSync(fd);
  }
}

// migrateGateState({ home, groupName?, roots?, log? })
// Idempotent; safe to run every boot. Missing roots are skipped (gate.js creates
// them at runtime; the parent dir's setgid gives the new file the shared group).
// Returns { gid, shared:[roots that existed] } or throws only on a truly bad env
// (no /etc/group group) so the fail-closed boot can refuse rather than run a gate
// that can't reach its state.
function migrateGateState({ home, groupName = "boxstate", gid = null, roots = GATE_STATE_ROOTS, log = () => {}, fsMod = fs } = {}) {
  if (typeof home !== "string" || !home || !path.isAbsolute(home) || path.resolve(home) !== home) {
    throw new Error("migrateGateState requires a normalized absolute home");
  }
  if (gid === null) gid = gidForGroup(groupName); // production: resolve from /etc/group; tests may inject gid
  if (gid === null) throw new Error(`migrateGateState: group '${groupName}' not found (create it + add agent,gate in the image)`);
  const homeChain = snapshotDirectoryChain(home, fsMod);
  const homeSnapshot = homeChain.at(-1);
  if (!homeSnapshot) throw new Error("migrateGateState: HOME cannot be the filesystem root");

  // Preflight every selected root before the first privileged change. That makes
  // a hostile later root fail without partially widening an earlier one.
  const plans = [];
  const shared = [];
  for (const rel of roots) {
    const root = selectedRootPath(home, rel);
    const pieces = path.relative(home, root).split(path.sep).filter(Boolean);
    let cursor = home;
    const rootAncestors = [...homeChain];
    let absent = false;
    for (let index = 0; index < pieces.length - 1; index += 1) {
      cursor = path.join(cursor, pieces[index]);
      let st;
      try { st = fsMod.lstatSync(cursor); }
      catch (error) {
        if (error && error.code === "ENOENT") { absent = true; break; }
        throw migrationError(`could not inspect selected-root ancestor (${(error && error.code) || error})`, cursor);
      }
      if (st.isSymbolicLink()) throw migrationError("refusing symbolic-link selected-root ancestor", cursor);
      if (!st.isDirectory()) throw migrationError("selected-root ancestor is not a directory", cursor);
      rootAncestors.push({ fullPath: cursor, st });
    }
    if (absent) { log(`gate-state root absent (ok, gate creates it): ${root}`); continue; }
    let rootSt;
    try { rootSt = fsMod.lstatSync(root); }
    catch (error) {
      if (error && error.code === "ENOENT") { log(`gate-state root absent (ok, gate creates it): ${root}`); continue; }
      throw migrationError(`could not inspect selected root (${(error && error.code) || error})`, root);
    }
    if (rootSt.isSymbolicLink()) throw migrationError("refusing symbolic-link selected root", root);
    const entries = [];
    snapshotTree(root, fsMod, rel === ".bridge.env", homeSnapshot.st.dev, rootAncestors, entries);
    plans.push({ rel, entries });
  }
  for (const plan of plans) {
    for (const snapshot of plan.entries) shareSnapshot(snapshot, gid, fsMod);
    shared.push(plan.rel);
  }
  return { gid, shared };
}

module.exports = { migrateGateState, gidForGroup, GATE_STATE_ROOTS, NEVER_SHARE };
