import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import claimStore from "../container/claim-store.js";

const { ClaimStore } = claimStore;

function tempDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ah-claim-store-"));
  return path.join(directory, "claims.sqlite");
}

function request(taskId, nowMs, overrides = {}) {
  return {
    taskId,
    engine: "codex",
    ttlMs: 60_000,
    schedulerGeneration: 7,
    nowMs,
    ...overrides,
  };
}

test("acquiring a queued card returns a public non-bearer ref and a private holder", () => {
  const store = new ClaimStore(tempDatabase());
  const result = store.tryAcquire(request("t_123", 1_000));

  assert.equal(result.status, "success");
  assert.equal(result.launchPermitted, true);
  assert.equal(result.artifacts.length, 1);
  assert.match(result.artifacts[0].id, /^clm_[A-Za-z0-9_-]+$/);
  assert.deepEqual(Object.keys(result).sort(), ["artifacts", "launchPermitted", "nextActions", "status", "summary"]);
  assert.ok(result.holder, "the scheduler gets an in-process capability");
  assert.deepEqual(Object.keys(result.holder), ["claimRef"], "holder has no token field");
  assert.equal(JSON.stringify(result).includes("token"), false, "the public response cannot serialize a token");

  const inspected = store.inspect("t_123");
  assert.equal(inspected.status, "success");
  assert.equal(JSON.stringify(inspected).includes("digest"), false, "the durable digest is never public");
  store.close();
});

test("a live claim cannot be overwritten and a loser gets an explicit no-launch conflict", () => {
  const store = new ClaimStore(tempDatabase());
  const winner = store.tryAcquire(request("t_456", 1_000));
  const loser = store.tryAcquire(request("t_456", 1_001, { engine: "claude" }));

  assert.equal(winner.status, "success");
  assert.equal(loser.status, "error");
  assert.equal(loser.rootCause, "already_claimed");
  assert.equal(loser.launchPermitted, false);
  assert.match(loser.stopCondition, /Do not launch an engine/);
  assert.equal(store.inspect("t_456").artifacts[0].id, winner.artifacts[0].id, "the live row was not overwritten");
  store.close();
});

test("only the current private holder can CAS-transition and release a live claim", () => {
  const store = new ClaimStore(tempDatabase());
  const acquired = store.tryAcquire(request("t_789", 1_000));

  const moved = store.transition(acquired.holder, { from: "active", to: "running", nowMs: 1_001 });
  assert.equal(moved.status, "success");
  assert.equal(store.inspect("t_789").claim.state, "running");

  const forged = store.release({ claimRef: acquired.artifacts[0].id }, { nowMs: 1_002 });
  assert.equal(forged.rootCause, "stale_holder");
  assert.equal(store.inspect("t_789").claim.state, "running", "a display ref is not a bearer credential");

  const released = store.release(acquired.holder, { nowMs: 1_003 });
  assert.equal(released.status, "success");
  assert.equal(store.inspect("t_789").rootCause, "claim_not_found");
  store.close();
});

test("recovery quarantines an expired claim until kill, reap, and writable-bind revocation are all proven", () => {
  const store = new ClaimStore(tempDatabase());
  const first = store.tryAcquire(request("t_recover", 1_000, { ttlMs: 1_000 }));
  const tooEarly = store.beginRecovery(first.holder, { nowMs: 1_999 });
  assert.equal(tooEarly.rootCause, "claim_not_expired");
  assert.equal(store.inspect("t_recover").claim.state, "active");

  const recovery = store.beginRecovery(first.holder, { nowMs: 2_000 });
  assert.equal(recovery.status, "warning");
  assert.ok(recovery.recovery, "recovery is an in-process capability");
  assert.equal(store.inspect("t_recover").claim.state, "recovering",
    "the durable row remains visible and protected while recovery proof is collected");

  const incomplete = store.reclaim(recovery.recovery, request("t_recover", 2_001));
  assert.equal(incomplete.rootCause, "recovery_incomplete");
  assert.equal(incomplete.launchPermitted, false);

  const resumed = store.beginRecovery(first.holder, { nowMs: 2_001 });
  assert.equal(resumed.rootCause, "stale_holder");
  assert.equal(store.inspect("t_recover").claim.state, "recovering",
    "a durable recovery row cannot mint a new recovery capability");

  const recorded = store.recordRecovery(recovery.recovery, {
    workerKilled: true,
    workerReaped: true,
    writableBindRevoked: true,
    nowMs: 2_002,
  });
  assert.equal(recorded.status, "success");
  const replacement = store.reclaim(recovery.recovery, request("t_recover", 2_003, { engine: "claude" }));
  assert.equal(replacement.status, "success");
  assert.notEqual(replacement.artifacts[0].id, first.artifacts[0].id);
  assert.equal(store.isCurrent(first.holder, { taskId: "t_recover", nowMs: 2_004 }), false,
    "the old private holder is invalid immediately after a replacement row becomes live");
  assert.equal(store.isCurrent(replacement.holder, { taskId: "t_recover", nowMs: 2_004 }), true,
    "only the replacement's private holder matches the live durable row");

  const stale = store.transition(first.holder, { from: "active", to: "running", nowMs: 2_004 });
  assert.equal(stale.rootCause, "stale_holder", "an expired worker cannot affect the newer claim");
  const staleRelease = store.release(first.holder, { nowMs: 2_005 });
  assert.equal(staleRelease.rootCause, "stale_holder", "an expired worker cannot release the newer claim");
  assert.equal(store.inspect("t_recover").claim.engine, "claude");
  assert.equal(store.inspect("t_recover").claim.state, "active");
  store.close();
});

test("recovery cannot be adopted after a ClaimStore restart", () => {
  const expiredDatabase = tempDatabase();
  const firstProcess = new ClaimStore(expiredDatabase);
  const expired = firstProcess.tryAcquire(request("t_restart_expired", 1_000, { ttlMs: 1_000 }));
  firstProcess.close();

  const restartedProcess = new ClaimStore(expiredDatabase);
  const adoptedByOldHolder = restartedProcess.beginRecovery(expired.holder, { nowMs: 2_000 });
  assert.equal(adoptedByOldHolder.rootCause, "stale_holder",
    "a holder from the former scheduler process is not a capability in the restarted process");
  const adoptedByTaskId = restartedProcess.beginRecovery({ taskId: "t_restart_expired" }, { nowMs: 2_000 });
  assert.equal(adoptedByTaskId.rootCause, "stale_holder",
    "a task id and durable row can never mint recovery authority");
  assert.equal(restartedProcess.inspect("t_restart_expired").claim.state, "active",
    "the expired claim stays protected instead of becoming recoverable by a fresh process");
  restartedProcess.close();

  const recoveringDatabase = tempDatabase();
  const recoveryOwner = new ClaimStore(recoveringDatabase);
  const acquired = recoveryOwner.tryAcquire(request("t_restart_recovering", 1_000, { ttlMs: 1_000 }));
  const recovery = recoveryOwner.beginRecovery(acquired.holder, { nowMs: 2_000 });
  assert.equal(recovery.status, "warning");
  recoveryOwner.close();

  const restartDuringRecovery = new ClaimStore(recoveringDatabase);
  const recorded = restartDuringRecovery.recordRecovery(recovery.recovery, {
    workerKilled: true,
    workerReaped: true,
    writableBindRevoked: true,
    nowMs: 2_001,
  });
  assert.equal(recorded.rootCause, "stale_holder",
    "a recovery handle is private to the scheduler process that initiated it");
  const reclaimed = restartDuringRecovery.reclaim(recovery.recovery,
    request("t_restart_recovering", 2_002, { engine: "claude" }));
  assert.equal(reclaimed.rootCause, "stale_holder",
    "a restarted process cannot replace a quarantined claim");
  assert.equal(restartDuringRecovery.inspect("t_restart_recovering").claim.state, "recovering");
  restartDuringRecovery.close();
});

test("a process restart after durable claim persistence cannot permit a second launch", () => {
  const database = tempDatabase();
  const firstProcess = new ClaimStore(database);
  const first = firstProcess.tryAcquire(request("t_restart", 1_000));
  assert.equal(first.status, "success");
  firstProcess.close();

  const restartedProcess = new ClaimStore(database);
  const second = restartedProcess.tryAcquire(request("t_restart", 1_001, { engine: "claude" }));
  assert.equal(second.rootCause, "already_claimed");
  assert.equal(second.launchPermitted, false);
  restartedProcess.close();
});

test("an unreadable claim store fails closed", () => {
  const missingDirectory = path.join(os.tmpdir(), "ah-claim-store-missing-" + Date.now(), "claims.sqlite");
  const store = new ClaimStore(missingDirectory);
  const health = store.health();
  const acquire = store.tryAcquire(request("t_fail_closed", 1_000));
  const inspected = store.inspect("t_fail_closed");

  assert.equal(health.status, "error");
  assert.equal(health.rootCause, "claim_store_unavailable");
  assert.equal(acquire.status, "error");
  assert.equal(acquire.launchPermitted, false);
  assert.match(acquire.stopCondition, /Do not launch an engine/);
  assert.equal(inspected.status, "error", "an unavailable store is never reported as a missing claim");
});

function workerAttempt(modulePath, database, taskId) {
  const source = `
    const { parentPort, workerData } = require("node:worker_threads");
    const { ClaimStore } = require(workerData.modulePath);
    const store = new ClaimStore(workerData.database, {
      initialize: false,
      busyTimeoutMs: 10000,
      maxBusyRetries: 100,
    });
    parentPort.postMessage({ ready: true });
    parentPort.once("message", () => {
      const result = store.tryAcquire({
        taskId: workerData.taskId,
        engine: "codex",
        ttlMs: 60000,
        schedulerGeneration: 1,
        nowMs: 1000,
      });
      parentPort.postMessage({
        status: result.status,
        rootCause: result.rootCause || null,
        launchPermitted: result.launchPermitted,
        serialized: JSON.stringify(result),
      });
      store.close();
    });
  `;
  return new Worker(source, { eval: true, workerData: { modulePath, database, taskId } });
}

test("64 simultaneous SQLite attempts produce exactly one durable claim and one launch permit", async () => {
  const database = tempDatabase();
  const initializer = new ClaimStore(database);
  assert.equal(initializer.health().status, "success");
  initializer.close();

  const modulePath = path.resolve("container/claim-store.js");
  const workers = Array.from({ length: 64 }, () => workerAttempt(modulePath, database, "t_contention"));
  const runs = workers.map((worker) => {
    const exited = new Promise((resolve) => worker.once("exit", resolve));
    let resolveReady;
    let rejectReady;
    let resolveAttempt;
    let rejectAttempt;
    const ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const attempt = new Promise((resolve, reject) => {
      resolveAttempt = resolve;
      rejectAttempt = reject;
    });
    worker.once("error", (error) => {
      rejectReady(error);
      rejectAttempt(error);
    });
    worker.on("message", (message) => {
      if (message.ready) {
        resolveReady();
        return;
      }
      resolveAttempt(message);
    });
    return { worker, ready, attempt, exited };
  });
  await Promise.all(runs.map((run) => run.ready));
  for (const run of runs) run.worker.postMessage("go");
  const attempts = await Promise.all(runs.map((run) => run.attempt));
  await Promise.all(runs.map((run) => run.exited));

  const winners = attempts.filter((attempt) => attempt.status === "success");
  const losers = attempts.filter((attempt) => attempt.status === "error");
  assert.equal(winners.length, 1, "exactly one claim succeeds under real SQLite contention");
  assert.equal(winners.filter((attempt) => attempt.launchPermitted).length, 1, "exactly one engine launch is permitted");
  assert.equal(losers.length, 63, "every other caller loses the same race");
  for (const loser of losers) {
    assert.equal(loser.rootCause, "already_claimed");
    assert.equal(loser.launchPermitted, false);
    assert.equal(loser.serialized.includes("token"), false, "no worker response leaks a token");
  }

  const verifier = new ClaimStore(database, { initialize: false });
  const final = verifier.inspect("t_contention");
  assert.equal(final.status, "success");
  assert.equal(final.claim.state, "active");
  verifier.close();
});
