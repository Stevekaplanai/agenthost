// Box Mesh state stream (mesh-state.js) — phase 3 acceptance:
//   - the server is authoritative; a monotonic epoch bumps on every transition
//   - LOCKED beats LIVE and RECONNECT
//   - a stale client (old epoch) must RECONNECT and cannot act
//   - a stale client cannot move the server backwards from LOCKED
//   - state is durable across a restart, and there is ONE lock authority
//     (mesh-store's lock delegates here)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as state from "../container/mesh-state.js";
import * as store from "../container/mesh-store.js";

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "mesh-state-")); }
const T = Date.parse("2026-07-31T12:00:00Z");

test("state: ground state is unlocked at epoch 0", () => {
  assert.deepEqual(state.readState(tmpDir()), { locked: false, epoch: 0, at: null });
});

test("state: a real transition bumps the epoch; an idempotent re-lock does not", () => {
  const dir = tmpDir();
  const a = state.transition(dir, "lock", T);
  assert.equal(a.changed, true);
  assert.equal(a.state.locked, true);
  assert.equal(a.state.epoch, 1);
  const b = state.transition(dir, "lock", T + 1000); // already locked
  assert.equal(b.changed, false);
  assert.equal(b.state.epoch, 1, "no churn on a no-op re-lock");
  const c = state.transition(dir, "unlock", T + 2000);
  assert.equal(c.changed, true);
  assert.equal(c.state.epoch, 2, "unlock is a real transition");
});

test("state: LOCKED beats everything, even a client on the current epoch", () => {
  const dir = tmpDir();
  const locked = state.transition(dir, "lock", T).state;
  assert.equal(state.gate(locked, locked.epoch).verdict, "locked", "current-epoch client still sees LOCKED");
  assert.equal(state.gate(locked, locked.epoch - 5).verdict, "locked");
  assert.equal(state.canAct(locked, locked.epoch), false, "no action while locked");
});

test("state: a stale client must RECONNECT; a current client is LIVE", () => {
  const dir = tmpDir();
  state.transition(dir, "lock", T);
  const live = state.transition(dir, "unlock", T + 1000).state; // epoch 2, unlocked
  assert.equal(state.gate(live, 1).verdict, "reconnect", "behind the epoch -> reconnect");
  assert.equal(state.gate(live, undefined).verdict, "reconnect", "no epoch -> reconnect");
  assert.equal(state.gate(live, 2).verdict, "live", "current epoch -> live");
  assert.equal(state.canAct(live, 2), true);
  assert.equal(state.canAct(live, 1), false);
});

test("state: a stale client cannot move the server backwards from LOCKED", () => {
  const dir = tmpDir();
  // client last saw epoch 0 (unlocked). Server then LOCKS -> epoch 1.
  const locked = state.transition(dir, "lock", T).state;
  // the stale client (epoch 0) attempts to act/unlock: refused.
  assert.equal(state.canAct(locked, 0), false, "a client that never saw the lock cannot act");
  // even carrying the current epoch, a LOCKED server refuses live action --
  // only an explicit operator unlock transition (not a client 'live' action)
  // lifts it.
  assert.equal(state.canAct(locked, locked.epoch), false);
});

test("state: a CURRENT-epoch operator can unlock a locked box; a stale one cannot", () => {
  const dir = tmpDir();
  const locked = state.transition(dir, "lock", T).state; // epoch 1, locked
  // the bug this replaces: canAct is false while locked, so wiring unlock to it
  // made the box impossible to unlock. canUnlock is the correct gate.
  assert.equal(state.canAct(locked, locked.epoch), false, "canAct still refuses live actions while locked");
  assert.equal(state.canUnlock(locked, locked.epoch), true, "but a current-epoch client CAN unlock");
  assert.equal(state.canUnlock(locked, locked.epoch - 1), false, "a stale client cannot unlock");
  assert.equal(state.canUnlock(locked, undefined), false, "no epoch cannot unlock");
});

test("state: a corrupt state file fails CLOSED (locked), a missing one is fresh/unlocked", () => {
  const dir = tmpDir();
  // missing -> fresh box, unlocked
  assert.equal(state.readState(dir).locked, false);
  // present but corrupt -> fail closed, never fail-open to LIVE
  fs.writeFileSync(path.join(dir, "state.json"), "not-json{");
  assert.equal(state.readState(dir).locked, true, "corrupt state must not read as LIVE");
  assert.equal(state.isLocked(dir), true);
  // a wrong-shape (but valid JSON) file also fails closed
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ locked: "yes", epoch: -1 }));
  assert.equal(state.readState(dir).locked, true);
});

test("state: durable across a restart", () => {
  const dir = tmpDir();
  state.transition(dir, "lock", T);
  // "restart": fresh read from disk, nothing in memory
  const after = state.readState(dir);
  assert.equal(after.locked, true);
  assert.equal(after.epoch, 1);
});

test("state: mesh-store lock delegates to the one authority (no split brain)", () => {
  const dir = tmpDir();
  assert.equal(store.isLocked(dir), false);
  store.setLocked(dir, true);
  assert.equal(store.isLocked(dir), true, "store reflects the state authority");
  assert.equal(state.isLocked(dir), true, "and it IS the state authority");
  assert.equal(state.readState(dir).epoch, 1, "the store lock bumped the shared epoch");
  store.setLocked(dir, false);
  assert.equal(state.readState(dir).epoch, 2);
});

test("state: serverStateName is LOCKED or LIVE only (RECONNECT is a client state)", () => {
  assert.equal(state.serverStateName({ locked: true, epoch: 1 }), "LOCKED");
  assert.equal(state.serverStateName({ locked: false, epoch: 1 }), "LIVE");
});
