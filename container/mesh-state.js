// mesh-state.js -- the server-authoritative surface state (Box Mesh phase 3:
// LOCKED / RECONNECT / LIVE). The server is the sole authority; the client
// never decides its own state. Two rules from the build plan drive everything
// here:
//   - LOCKED beats LIVE and RECONNECT, and is never a mergeable value.
//   - A stale client cannot move the server backwards from LOCKED.
//
// The mechanism is a monotonic EPOCH. Every real transition bumps it, so a
// client presenting an epoch behind the server has been acting on stale
// authority and must RECONNECT (re-auth + fresh snapshot) before it may render
// live data again. RECONNECT is therefore a CLIENT state -- the server is only
// ever LOCKED or LIVE; the client is in RECONNECT until it holds the current
// epoch.
//
// This is the ONE source of truth for "is the box locked": mesh-store's lock
// delegates here, and the box-to-box message delivery reads locked from here,
// so a LOCKED box refuses mesh messages AND shows LOCKED on every surface from
// a single authority. Pure of the clock (callers pass `now`) and free of any
// module-level path, so every rule is unit-testable.

"use strict";

const fs = require("fs");
const path = require("path");

const STATE_FILE = "state.json";

// { locked: bool, epoch: int (monotonic), at: iso|null }. Two failure modes,
// deliberately different (red-team 2026-07-31): a MISSING file is a fresh box
// -> unlocked ground state; a PRESENT-but-corrupt/unreadable file means the
// safety state was damaged -> FAIL CLOSED (locked), never fail-open to LIVE. A
// partial write, an operator edit, or a recovery artifact must not silently
// clear the lock. The box shows LOCKED until a valid state is written (an
// operator unlock writes a fresh valid state at the next epoch).
function readState(dir) {
  let raw;
  try { raw = fs.readFileSync(path.join(dir, STATE_FILE), "utf8"); }
  catch (e) {
    if (e && e.code === "ENOENT") return { locked: false, epoch: 0, at: null };
    return { locked: true, epoch: 0, at: null, corrupt: true };
  }
  try {
    const s = JSON.parse(raw);
    if (s && typeof s.locked === "boolean" && Number.isInteger(s.epoch) && s.epoch >= 0) {
      return { locked: s.locked, epoch: s.epoch, at: typeof s.at === "string" ? s.at : null };
    }
  } catch {}
  return { locked: true, epoch: 0, at: null, corrupt: true };
}

function writeState(dir, state) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const body = JSON.stringify(state);
  const file = path.join(dir, STATE_FILE);
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  try { fs.renameSync(tmp, file); }
  catch (e) {
    if (process.platform !== "win32" || (e.code !== "EPERM" && e.code !== "EEXIST")) throw e;
    fs.writeFileSync(file, body, { mode: 0o600 });
    try { fs.unlinkSync(tmp); } catch {}
  }
  return state;
}

// Apply an operator action ("lock" | "unlock"). A real change bumps the epoch;
// a no-op (locking an already-locked box) does NOT bump it, so idempotent
// re-locks don't churn every subscriber. Returns { state, changed }.
function transition(dir, action, now) {
  if (action !== "lock" && action !== "unlock") return { state: readState(dir), changed: false };
  const cur = readState(dir);
  const wantLocked = action === "lock";
  if (cur.locked === wantLocked) return { state: cur, changed: false };
  const next = { locked: wantLocked, epoch: cur.epoch + 1, at: new Date(Number.isFinite(now) ? now : Date.now()).toISOString() };
  writeState(dir, next);
  return { state: next, changed: true };
}

function isLocked(dir) { return readState(dir).locked === true; }

function serverStateName(state) { return state && state.locked ? "LOCKED" : "LIVE"; }

// The client-facing verdict for a client that presents `clientEpoch`:
//   - LOCKED beats everything: a locked server always answers "locked", so a
//     stale client can neither render live data nor act.
//   - Behind the server epoch (or no epoch) -> "reconnect": the client has lost
//     authority and must re-snapshot before rendering live.
//   - Current -> "live".
function gate(serverState, clientEpoch) {
  if (serverState && serverState.locked) return { verdict: "locked", epoch: serverState.epoch };
  const epoch = serverState ? serverState.epoch : 0;
  if (!Number.isInteger(clientEpoch) || clientEpoch < epoch) return { verdict: "reconnect", epoch };
  return { verdict: "live", epoch };
}

// May a client-submitted action proceed? Only when the server is unlocked AND
// the client holds the current epoch (has seen every transition). This is what
// stops a stale client from moving the server backward from LOCKED: a client
// that never saw the LOCK carries an old epoch, so its "unlock" is refused ->
// it must reconnect, see LOCKED, and only a current-epoch operator action can
// lift it.
function canAct(serverState, clientEpoch) {
  return gate(serverState, clientEpoch).verdict === "live";
}

// May a client UNLOCK the box? Unlock is the ONE sanctioned action that must
// work WHILE locked (that is its entire purpose) -- so it is deliberately NOT
// canAct (which refuses everything while locked). The only requirement is that
// the client holds the CURRENT epoch: it has actually seen the lock. A stale
// client (never saw the lock) carries an old epoch and is refused -- that is
// the "a stale client cannot move the server backwards from LOCKED" rule.
// (Bug caught 2026-07-31: the unlock route used canAct and could never unlock.)
function canUnlock(serverState, clientEpoch) {
  const epoch = serverState ? serverState.epoch : 0;
  return Number.isInteger(clientEpoch) && clientEpoch >= epoch;
}

module.exports = { readState, writeState, transition, isLocked, serverStateName, gate, canAct, canUnlock };
