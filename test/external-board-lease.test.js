import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import claimStore from "../container/claim-store.js";

const { ClaimStore } = claimStore;
const gateSource = fs.readFileSync(
  path.join(import.meta.dirname, "..", "container", "gate.js"),
  "utf8",
);

function database() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ah-external-lease-"));
  return path.join(directory, "claims.sqlite");
}

test("an external scheduler heartbeat renews only its private live holder", () => {
  const store = new ClaimStore(database());
  const acquired = store.tryAcquire({
    taskId: "t_room",
    engine: "codex",
    ttlMs: 60_000,
    schedulerGeneration: 1,
    nowMs: 1_000,
  });
  assert.equal(acquired.status, "success");
  assert.equal(store.transition(acquired.holder, {
    from: "active",
    to: "running",
    nowMs: 1_001,
  }).status, "success");

  const renewed = store.renew(acquired.holder, { ttlMs: 60_000, nowMs: 30_000 });
  assert.equal(renewed.status, "success");
  assert.equal(store.inspect("t_room").claim.expiresAt, 90_000);
  assert.equal(store.isCurrent(acquired.holder, {
    taskId: "t_room",
    state: "running",
    nowMs: 89_999,
  }), true);

  const forged = store.renew({ claimRef: acquired.artifacts[0].id }, {
    ttlMs: 60_000,
    nowMs: 30_001,
  });
  assert.equal(forged.rootCause, "stale_holder");
  assert.equal(store.inspect("t_room").claim.expiresAt, 90_000,
    "the display claim id cannot renew ownership");
  store.close();
});

test("completion releases a renewed lease so the card is no longer scheduler-owned", () => {
  const store = new ClaimStore(database());
  const acquired = store.tryAcquire({
    taskId: "t_room_done",
    engine: "hermes",
    ttlMs: 60_000,
    schedulerGeneration: 1,
    nowMs: 1_000,
  });
  store.transition(acquired.holder, { from: "active", to: "running", nowMs: 1_001 });
  store.renew(acquired.holder, { ttlMs: 60_000, nowMs: 30_000 });

  assert.equal(store.release(acquired.holder, { nowMs: 30_001 }).status, "success");
  assert.equal(store.inspect("t_room_done").rootCause, "claim_not_found");
  store.close();
});

test("an external terminal receipt makes an interrupted board release exactly retryable", () => {
  const file = database();
  const supervisorToken = "terminal-receipt-secret-".repeat(3);
  const first = new ClaimStore(file);
  const acquired = first.tryAcquireExternal({
    taskId: "t_room_terminal_retry",
    engine: "codex",
    ttlMs: 60_000,
    schedulerGeneration: 1,
    nowMs: 1_000,
    supervisorId: "desktop-control-plane",
    supervisorToken,
    roomId: "room-terminal-retry",
    objectiveDigest: "c".repeat(64),
  });
  assert.equal(acquired.status, "success");
  assert.equal(first.transition(acquired.holder, {
    from: "active",
    to: "running",
    nowMs: 1_001,
  }).status, "success");
  assert.equal(first.releaseExternalTerminal(acquired.holder, {
    nowMs: 1_002,
    status: "done",
  }).status, "success");
  assert.equal(first.inspect("t_room_terminal_retry").rootCause, "claim_not_found");
  first.close();

  const restarted = new ClaimStore(file);
  const exact = restarted.inspectExternalReceipt({
    taskId: "t_room_terminal_retry",
    claimId: acquired.artifacts[0].id,
    supervisorId: "desktop-control-plane",
    supervisorToken,
    roomId: "room-terminal-retry",
    nowMs: 2_000,
  });
  assert.equal(exact.status, "success");
  assert.equal(exact.receipt.status, "done");
  assert.equal(exact.receipt.claimId, acquired.artifacts[0].id);
  assert.equal(restarted.inspectExternalReceiptForRoom({
    taskId: "t_room_terminal_retry",
    supervisorId: "desktop-control-plane",
    supervisorToken,
    roomId: "room-terminal-retry",
    nowMs: 2_000,
  }).receipt.claimId, acquired.artifacts[0].id);
  const wrongRoomCapability = restarted.inspectExternalReceiptForRoom({
    taskId: "t_room_terminal_retry",
    supervisorId: "desktop-control-plane",
    supervisorToken: "foreign-terminal-secret-".repeat(3),
    roomId: "room-terminal-retry",
    nowMs: 2_000,
  });
  assert.equal(wrongRoomCapability.rootCause, "external_supervisor_mismatch");
  for (const changed of [
    { supervisorId: "other-control-plane" },
    { roomId: "other-room" },
  ]) {
    const mismatchedRoom = restarted.inspectExternalReceiptForRoom({
      taskId: "t_room_terminal_retry",
      supervisorId: "desktop-control-plane",
      supervisorToken,
      roomId: "room-terminal-retry",
      nowMs: 2_000,
      ...changed,
    });
    assert.equal(mismatchedRoom.rootCause, "external_supervisor_mismatch");
  }
  assert.equal(restarted.inspect("t_room_terminal_retry").rootCause, "claim_not_found",
    "a mismatched receipt lookup cannot mint replacement ownership");

  for (const changed of [
    { supervisorToken: "foreign-terminal-secret-".repeat(3) },
    { supervisorId: "other-control-plane" },
    { roomId: "other-room" },
    { claimId: "clm_" + "x".repeat(18) },
  ]) {
    const rejected = restarted.inspectExternalReceipt({
      taskId: "t_room_terminal_retry",
      claimId: acquired.artifacts[0].id,
      supervisorId: "desktop-control-plane",
      supervisorToken,
      roomId: "room-terminal-retry",
      nowMs: 2_001,
      ...changed,
    });
    assert.notEqual(rejected.status, "success");
  }
  restarted.close();
});

test("an expired room lease can be cleared only through its private, fully proven recovery", () => {
  const store = new ClaimStore(database());
  const acquired = store.tryAcquire({
    taskId: "t_room_expired",
    engine: "codex",
    ttlMs: 1_000,
    schedulerGeneration: 1,
    nowMs: 1_000,
  });
  store.transition(acquired.holder, { from: "active", to: "running", nowMs: 1_001 });
  const started = store.beginRecovery(acquired.holder, { nowMs: 2_000 });
  assert.equal(started.status, "warning");

  const incomplete = store.releaseRecovered(started.recovery, { nowMs: 2_001 });
  assert.equal(incomplete.rootCause, "recovery_incomplete");
  const forged = store.releaseRecovered({ claimRef: acquired.artifacts[0].id }, { nowMs: 2_001 });
  assert.equal(forged.rootCause, "stale_holder");

  assert.equal(store.recordRecovery(started.recovery, {
    nowMs: 2_002,
    workerKilled: true,
    workerReaped: true,
    writableBindRevoked: true,
  }).status, "success");
  assert.equal(store.releaseRecovered(started.recovery, { nowMs: 2_003 }).status, "success");
  assert.equal(store.inspect("t_room_expired").rootCause, "claim_not_found");
  store.close();
});

test("an external claim survives a gate restart and only its exact supervisor can reattach it", () => {
  const file = database();
  const supervisorToken = "supervisor-secret-".repeat(4);
  const first = new ClaimStore(file);
  const acquired = first.tryAcquireExternal({
    taskId: "t_room_restart",
    engine: "codex",
    ttlMs: 60_000,
    schedulerGeneration: 1,
    nowMs: 1_000,
    supervisorId: "desktop-control-plane",
    supervisorToken,
    roomId: "room-restart",
    objectiveDigest: "a".repeat(64),
  });
  assert.equal(acquired.status, "success");
  assert.equal(first.transition(acquired.holder, {
    from: "active",
    to: "running",
    nowMs: 1_001,
  }).status, "success");

  const restarted = new ClaimStore(file);
  const foreign = restarted.reattachExternal({
    taskId: "t_room_restart",
    claimId: acquired.artifacts[0].id,
    supervisorId: "other-desktop",
    supervisorToken,
    roomId: "room-restart",
    nowMs: 30_000,
  });
  assert.equal(foreign.rootCause, "external_supervisor_mismatch");

  const reattached = restarted.reattachExternal({
    taskId: "t_room_restart",
    claimId: acquired.artifacts[0].id,
    supervisorId: "desktop-control-plane",
    supervisorToken,
    roomId: "room-restart",
    nowMs: 30_000,
  });
  assert.equal(reattached.status, "success");
  assert.equal(reattached.launchPermitted, false, "reattach never grants a second launch");
  assert.equal(first.isCurrent(acquired.holder, {
    taskId: "t_room_restart",
    state: "running",
    nowMs: 30_001,
  }), false, "the atomic reattach invalidates the pre-restart holder");
  assert.equal(restarted.isExternalCurrent(reattached.holder, {
    taskId: "t_room_restart",
    state: "running",
    supervisorId: "desktop-control-plane",
    supervisorToken,
    roomId: "room-restart",
    nowMs: 30_001,
  }), true);
  assert.equal(restarted.isExternalCurrent(reattached.holder, {
    taskId: "t_room_restart",
    state: "running",
    supervisorId: "desktop-control-plane",
    supervisorToken: "wrong-secret-".repeat(4),
    roomId: "room-restart",
    nowMs: 30_001,
  }), false);

  const inspected = restarted.inspect("t_room_restart");
  assert.equal(inspected.claim.claimType, "external");
  assert.equal(inspected.claim.supervisorId, "desktop-control-plane");
  assert.equal(inspected.claim.roomId, "room-restart");
  assert.equal(inspected.claim.objectiveDigest, "a".repeat(64));
  assert.equal(inspected.claim.expiresAt, 61_000,
    "reattach proves the same supervisor but does not revive or extend its lease");
  first.close();
  restarted.close();
});

test("a restarted exact pending external claim can resume its active-to-running transition", () => {
  const file = database();
  const supervisorToken = "pending-transition-secret-".repeat(3);
  const first = new ClaimStore(file);
  const acquired = first.tryAcquireExternal({
    taskId: "t_room_pending_transition",
    engine: "claude",
    ttlMs: 60_000,
    schedulerGeneration: 1,
    nowMs: 1_000,
    supervisorId: "desktop-control-plane",
    supervisorToken,
    roomId: "room-pending-transition",
    objectiveDigest: "d".repeat(64),
  });
  assert.equal(acquired.status, "success");
  first.close();

  const restarted = new ClaimStore(file);
  const attached = restarted.reattachExternal({
    taskId: "t_room_pending_transition",
    claimId: acquired.artifacts[0].id,
    supervisorId: "desktop-control-plane",
    supervisorToken,
    roomId: "room-pending-transition",
    nowMs: 1_100,
  });
  assert.equal(attached.claim.state, "active");
  assert.equal(restarted.transition(attached.holder, {
    from: "active",
    to: "running",
    nowMs: 1_101,
  }).status, "success");
  assert.equal(restarted.inspect("t_room_pending_transition").claim.state, "running");
  restarted.close();
});

test("expired external ownership can only enter recovery through its persisted supervisor capability", () => {
  const file = database();
  const supervisorToken = "restart-recovery-secret-".repeat(3);
  const first = new ClaimStore(file);
  const acquired = first.tryAcquireExternal({
    taskId: "t_room_restart_recovery",
    engine: "hermes",
    ttlMs: 1_000,
    schedulerGeneration: 1,
    nowMs: 1_000,
    supervisorId: "desktop-supervisor",
    supervisorToken,
    roomId: "room-recovery",
    objectiveDigest: "b".repeat(64),
  });
  first.transition(acquired.holder, { from: "active", to: "running", nowMs: 1_001 });

  const restarted = new ClaimStore(file);
  const expiredReattach = restarted.reattachExternal({
    taskId: "t_room_restart_recovery",
    claimId: acquired.artifacts[0].id,
    supervisorId: "desktop-supervisor",
    supervisorToken,
    roomId: "room-recovery",
    nowMs: 2_001,
  });
  assert.equal(expiredReattach.rootCause, "external_claim_expired",
    "an expired external worker cannot be revived by reattach");
  const forged = restarted.beginExternalRecovery({
    taskId: "t_room_restart_recovery",
    claimId: acquired.artifacts[0].id,
    supervisorId: "desktop-supervisor",
    supervisorToken: "forged-recovery-secret-".repeat(3),
    roomId: "room-recovery",
    nowMs: 2_001,
  });
  assert.equal(forged.rootCause, "external_supervisor_mismatch");

  const started = restarted.beginExternalRecovery({
    taskId: "t_room_restart_recovery",
    claimId: acquired.artifacts[0].id,
    supervisorId: "desktop-supervisor",
    supervisorToken,
    roomId: "room-recovery",
    nowMs: 2_001,
  });
  assert.equal(started.status, "warning");
  const secondRestart = new ClaimStore(file);
  const resumed = secondRestart.beginExternalRecovery({
    taskId: "t_room_restart_recovery",
    claimId: acquired.artifacts[0].id,
    supervisorId: "desktop-supervisor",
    supervisorToken,
    roomId: "room-recovery",
    nowMs: 2_002,
  });
  assert.equal(resumed.status, "warning", "the exact supervisor can resume persisted recovery");
  assert.equal(restarted.recordRecovery(started.recovery, {
    nowMs: 2_002,
    workerKilled: true,
  }).rootCause, "stale_holder", "the newer recovery capability invalidates the old process");
  assert.equal(secondRestart.recordRecovery(resumed.recovery, {
    nowMs: 2_003,
    workerKilled: true,
    workerReaped: true,
    writableBindRevoked: true,
  }).status, "success");
  assert.equal(secondRestart.releaseExternalRecovered(resumed.recovery, {
    nowMs: 2_004,
    status: "blocked",
  }).status, "success");
  assert.equal(secondRestart.inspect("t_room_restart_recovery").rootCause, "claim_not_found");
  assert.equal(secondRestart.inspectExternalReceipt({
    taskId: "t_room_restart_recovery",
    claimId: acquired.artifacts[0].id,
    supervisorId: "desktop-supervisor",
    supervisorToken,
    roomId: "room-recovery",
    nowMs: 2_005,
  }).receipt.status, "blocked");
  first.close();
  restarted.close();
  secondRestart.close();
});

test("the gate never returns an expired room lease and wires the verified cleanup path", () => {
  assert.match(gateSource,
    /reattachExternal[\s\S]*?agent room lease expired/);
  assert.match(gateSource,
    /function recoverExpiredExternalBoardTask[\s\S]*?inspectExternalReceipt[\s\S]*?beginExternalRecovery[\s\S]*?recordRecovery[\s\S]*?releaseExternalRecovered/);
  assert.match(gateSource,
    /completeExternalBoardTask[\s\S]*?releaseExternalTerminal[\s\S]*?status: "done"/);
  assert.match(gateSource,
    /stopExternalBoardTask[\s\S]*?releaseExternalTerminal[\s\S]*?status: "blocked"/);
  assert.match(gateSource,
    /reattachExternal[\s\S]*?attached\.claim\.state === "active"[\s\S]*?from: "active"[\s\S]*?to: "running"/);
  assert.match(gateSource,
    /inspectExternalReceiptForRoom[\s\S]*?terminal\.rootCause !== "external_receipt_not_found"[\s\S]*?external_supervisor_mismatch[\s\S]*?tryAcquireExternal/,
    "only a proven missing terminal receipt may reach replacement acquisition");
  assert.match(gateSource,
    /workerKilled: input\.workerKilled === true[\s\S]*?workerReaped: input\.workerReaped === true[\s\S]*?writableBindRevoked: input\.writableBindRevoked === true/);
});
