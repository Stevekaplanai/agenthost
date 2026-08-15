import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AGENT_IDS,
  authorizeRoomLaunch,
  clearRoomUnitTracking,
  finalizeRoomLifecycleAfterCleanup,
  initializeRoomUnitTracking,
  recoverAndClearQuarantinedRoom,
  recoverQuarantinedRoom,
  roomUnitActive,
  roomStartupPreflight,
  runEngine,
  runRoomSession,
  stopAll,
} from "../scripts/local-room.mjs";
import {
  createActiveRoomQuarantine,
  createRoomUnitLedger,
  readActiveRoomQuarantine,
  readRoomUnitLedger,
  recordRoomUnit,
} from "../scripts/local-room/supervisor.mjs";

function specs() {
  return AGENT_IDS.map((id) => ({
    id,
    cwd: `/rooms/${id}`,
    branch: `agenthost-room/test/${id}`,
  }));
}

function claimRequest() {
  return {
    objectiveDigest: "a".repeat(64),
    agents: specs().map(({ id, branch }) => ({ engineId: id, branch })),
    startedAt: 1_000,
  };
}

function lifecycle({
  ready = true,
  failHeartbeatAt = 0,
  claimResponse = {},
  taskId = "t_room",
  claimId = "claim_room",
} = {}) {
  const calls = [];
  let heartbeats = 0;
  return {
    calls,
    adapter: {
      async ready(event) {
        calls.push({ method: "ready", event });
        return ready;
      },
      async claim(event) {
        calls.push({ method: "claim", event });
        return {
          taskId,
          claimId,
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          ...claimResponse,
        };
      },
      async heartbeat(event) {
        calls.push({ method: "heartbeat", event });
        heartbeats += 1;
        if (failHeartbeatAt && heartbeats >= failHeartbeatAt) {
          throw new Error("lease backend unavailable");
        }
        return { leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() };
      },
      async complete(event) {
        calls.push({ method: "complete", event });
        return { ok: true };
      },
      async stop(event) {
        calls.push({ method: "stop", event });
        return { status: "blocked" };
      },
      async recover(event) {
        calls.push({ method: "recover", event });
        return { recovered: true, status: "blocked" };
      },
    },
  };
}

function tempTranscript() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-room-loop-"));
  return path.join(root, "transcript.jsonl");
}

test("four agents run in separate worktrees and complete through renewable ownership", async () => {
  const remote = lifecycle();
  const observed = [];
  const readiness = [];
  let claimed = null;
  const transcriptFile = tempTranscript();
  const result = await runRoomSession({
    roomId: "room-1",
    objective: "Build a safe room",
    rounds: 1,
    specs: specs(),
    lifecycle: remote.adapter,
    charter: "Use isolated worktrees.",
    transcriptFile,
    heartbeatMs: 10,
    onReadiness(update) { readiness.push(update); },
    onClaim(claim) { claimed = claim; },
    async runTurn({ spec, prompt }) {
      assert.ok(claimed, "durable ownership is reported before any agent starts");
      observed.push({ id: spec.id, cwd: spec.cwd, prompt });
      await new Promise((resolve) => setTimeout(resolve, 15));
      return {
        ok: true,
        text: `${spec.id} completed the turn\nROOM_STATUS: done`,
        durationMs: 15,
        code: 0,
        signal: null,
        timedOut: false,
        telemetry: {},
      };
    },
  });

  assert.equal(result.status, "done");
  assert.equal(claimed.taskId, "t_room");
  assert.equal(remote.calls.filter((call) => call.method === "complete").length, 0);
  await finalizeRoomLifecycleAfterCleanup({
    roomId: "room-1",
    lifecycle: remote.adapter,
    result,
    survivors: [],
  });
  assert.deepEqual(observed.map((item) => item.id), AGENT_IDS);
  assert.equal(new Set(observed.map((item) => item.cwd)).size, 4);
  assert.ok(observed.every((item) => item.prompt.includes("CONTROLLER-OWNED TASK\nt_room")));
  assert.equal(remote.calls.filter((call) => call.method === "ready").length, 4);
  assert.deepEqual(readiness, AGENT_IDS.map((engineId) => ({
    engineId,
    available: true,
    authState: "unknown",
    controllerState: "ready",
  })));
  const heartbeats = remote.calls.filter((call) => call.method === "heartbeat");
  assert.ok(heartbeats.length >= 4);
  assert.ok(heartbeats.every((call) => call.event.phase === "build"));
  assert.equal(remote.calls.filter((call) => call.method === "complete").length, 1);
  assert.equal(remote.calls.filter((call) => call.method === "stop").length, 0);
  assert.equal(
    Number.isSafeInteger(remote.calls.find((call) => call.method === "claim").event.startedAt),
    true,
  );

  const complete = remote.calls.find((call) => call.method === "complete").event;
  assert.deepEqual(Object.keys(complete.summary).sort(), [
    "agents", "durationMs", "outcome", "rounds",
  ]);
  assert.equal(complete.summary.outcome, "completed");
  assert.doesNotMatch(JSON.stringify(remote.calls), /completed the turn|Build a safe room/);
  assert.equal(fs.readFileSync(transcriptFile, "utf8").trim().split(/\r?\n/).length, 5);
});

test("a not-ready engine fails before claim and inference", async () => {
  const remote = lifecycle({ ready: false });
  let turns = 0;
  const readiness = [];
  await assert.rejects(
    runRoomSession({
      roomId: "room-2",
      objective: "x",
      rounds: 1,
      specs: specs(),
      lifecycle: remote.adapter,
      charter: "x",
      transcriptFile: tempTranscript(),
      onReadiness(update) { readiness.push(update); },
      async runTurn() { turns += 1; },
    }),
    /not ready/i,
  );
  assert.equal(turns, 0);
  assert.deepEqual(readiness, []);
  assert.equal(remote.calls.filter((call) => call.method === "claim").length, 0);
});

test("agent blocker stops the room with a code, never raw model text", async () => {
  const remote = lifecycle();
  let turns = 0;
  const secret = "sk-secret-from-model-output";
  const result = await runRoomSession({
    roomId: "room-3",
    objective: "x",
    rounds: 2,
    specs: specs(),
    lifecycle: remote.adapter,
    charter: "x",
    transcriptFile: tempTranscript(),
    async runTurn({ spec }) {
      turns += 1;
      return {
        ok: true,
        text: `${secret}\nROOM_STATUS: blocked - operator decision required`,
        durationMs: 1,
        code: 0,
        signal: null,
        timedOut: false,
        telemetry: {},
      };
    },
  });
  assert.equal(result.status, "blocked");
  assert.equal(turns, 1);
  await finalizeRoomLifecycleAfterCleanup({
    roomId: "room-3",
    lifecycle: remote.adapter,
    result,
    survivors: [],
  });
  const stopped = remote.calls.find((call) => call.method === "stop").event;
  assert.equal(stopped.kind, "needs_input");
  assert.equal(stopped.reasonCode, "agent_reported_blocked");
  assert.doesNotMatch(JSON.stringify(remote.calls), /operator decision|sk-secret/);
});

test("heartbeat failure aborts the active turn and stops scheduling", async () => {
  const remote = lifecycle({ failHeartbeatAt: 2 });
  let turns = 0;
  let abortSeen = false;
  const result = await runRoomSession({
    roomId: "room-4",
    objective: "x",
    rounds: 2,
    specs: specs(),
    lifecycle: remote.adapter,
    charter: "x",
    transcriptFile: tempTranscript(),
    heartbeatMs: 10,
    async runTurn({ signal }) {
      turns += 1;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 100);
        signal.addEventListener("abort", () => {
          abortSeen = true;
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
      return {
        ok: false,
        text: "",
        error: "aborted",
        durationMs: 10,
        code: null,
        signal: "SIGTERM",
        timedOut: false,
        telemetry: {},
      };
    },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.reasonCode, "lease_heartbeat_failed");
  assert.equal(turns, 1);
  assert.equal(abortSeen, true);
  await finalizeRoomLifecycleAfterCleanup({
    roomId: "room-4",
    lifecycle: remote.adapter,
    result,
    survivors: [],
  });
  const stopped = remote.calls.find((call) => call.method === "stop").event;
  assert.equal(stopped.kind, "transient");
  assert.equal(stopped.reasonCode, "lease_heartbeat_failed");
});

test("external stop releases ownership as cancelled only after cleanup proof", async () => {
  const remote = lifecycle();
  const controller = new AbortController();
  const running = runRoomSession({
    roomId: "room-5",
    objective: "x",
    rounds: 2,
    specs: specs(),
    lifecycle: remote.adapter,
    charter: "x",
    transcriptFile: tempTranscript(),
    signal: controller.signal,
    async runTurn({ signal }) {
      controller.abort();
      assert.equal(signal.aborted, true);
      return {
        ok: false,
        text: "",
        error: "cancelled",
        durationMs: 1,
        code: null,
        signal: "SIGINT",
        timedOut: false,
        telemetry: {},
      };
    },
  });
  const result = await running;
  assert.equal(result.status, "cancelled");
  await finalizeRoomLifecycleAfterCleanup({
    roomId: "room-5",
    lifecycle: remote.adapter,
    result,
    survivors: [],
  });
  const stopped = remote.calls.find((call) => call.method === "stop").event;
  assert.equal(stopped.kind, "cancelled");
  assert.equal(stopped.reasonCode, "operator_cancelled");
});

test("a surviving managed process keeps durable Kanban ownership quarantined", async () => {
  const remote = lifecycle();
  const hostStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-host-quarantine-"));
  const stateDir = path.join(
    os.tmpdir(),
    "agenthost-state-root-a",
    "agenthost-room-room-survivor",
  );
  const quarantine = createActiveRoomQuarantine({
    hostStateDir,
    roomId: "room-survivor",
    stateDir,
    taskId: "t_room",
    claimId: "claim_room",
    claimRequest: claimRequest(),
  });
  const survivors = await stopAll("room-survivor", {
    signalProcessGroups() {},
    signalUnits() {},
    signalMarked() {},
    listMarked() { return [4321]; },
    snapshotProcessGroups() { return []; },
    snapshotUnits() { return []; },
    processGroupIsAlive() { return false; },
    unitIsActive() { return false; },
    clearTracked() {},
    async wait() {},
  });
  await assert.rejects(
    finalizeRoomLifecycleAfterCleanup({
      roomId: "room-survivor",
      lifecycle: remote.adapter,
      result: {
        status: "cancelled",
        reasonCode: "operator_cancelled",
        taskId: "t_room",
        claimId: "claim_room",
        rounds: 1,
        durationMs: 1,
      },
      survivors,
    }),
    /ownership retained/i,
  );
  assert.equal(remote.calls.filter(({ method }) => (
    method === "stop" || method === "complete"
  )).length, 0);
  assert.deepEqual(readActiveRoomQuarantine({ hostStateDir }), quarantine);
  assert.throws(
    () => authorizeRoomLaunch({
      quarantine,
      requestedStateDir: path.join(
        os.tmpdir(),
        "agenthost-state-root-b",
        "agenthost-room-room-new",
      ),
      recoverQuarantine: false,
    }),
    /is quarantined/i,
  );
  assert.throws(
    () => authorizeRoomLaunch({
      quarantine,
      requestedStateDir: path.join(
        os.tmpdir(),
        "agenthost-state-root-b",
        "agenthost-room-room-survivor",
      ),
      recoverQuarantine: true,
    }),
    /exact room state/i,
  );
});

test("explicit quarantine recovery proves cleanup before asking the board to release", async () => {
  const remote = lifecycle({ claimResponse: { recoveryRequired: true } });
  const order = [];
  const quarantine = {
    roomId: "room-recover",
    taskId: "t_room",
    claimId: "claim_room",
    claimRequest: claimRequest(),
  };
  const recovered = await recoverQuarantinedRoom({
    roomId: "room-recover",
    lifecycle: remote.adapter,
    quarantine,
    async stop(roomId) {
      order.push(`cleanup:${roomId}`);
      return [];
    },
  });
  order.push("recovered");
  assert.equal(recovered.recovered, true);
  assert.deepEqual(order, ["cleanup:room-recover", "recovered"]);
  const call = remote.calls.find(({ method }) => method === "recover");
  assert.deepEqual({
    taskId: call.event.taskId,
    claimId: call.event.claimId,
    reasonCode: call.event.reasonCode,
    workerKilled: call.event.workerKilled,
    workerReaped: call.event.workerReaped,
    writableBindRevoked: call.event.writableBindRevoked,
  }, {
    taskId: "t_room",
    claimId: "claim_room",
    reasonCode: "cleanup_survivor",
    workerKilled: true,
    workerReaped: true,
    writableBindRevoked: true,
  });
});

test("quarantine recovery bypasses every provider and AgentGlass probe", () => {
  let cleanupChecks = 0;
  let providerChecks = 0;
  let dashboardChecks = 0;
  const capabilities = roomStartupPreflight({
    recoverQuarantine: true,
    specs: specs(),
    env: {},
    agentglassCurl: "/missing/curl.exe",
    cleanupPreflight() { cleanupChecks += 1; },
    providerPreflight() {
      providerChecks += 1;
      throw new Error("every provider is unavailable");
    },
    agentglassPreflight() {
      dashboardChecks += 1;
      throw new Error("dashboard is unavailable");
    },
  });
  assert.deepEqual(capabilities, []);
  assert.equal(cleanupChecks, 1);
  assert.equal(providerChecks, 0);
  assert.equal(dashboardChecks, 0);
});

test("normal infrastructure preflight defers agent executables until ownership is bound", () => {
  let cleanupChecks = 0;
  let providerChecks = 0;
  let dashboardChecks = 0;
  const capabilities = roomStartupPreflight({
    recoverQuarantine: false,
    specs: specs(),
    env: {},
    agentglassCurl: "/trusted/curl.exe",
    probeProviders: false,
    cleanupPreflight() { cleanupChecks += 1; },
    providerPreflight() { providerChecks += 1; return []; },
    agentglassPreflight() { dashboardChecks += 1; },
  });
  assert.deepEqual(capabilities, []);
  assert.equal(cleanupChecks, 1);
  assert.equal(providerChecks, 0);
  assert.equal(dashboardChecks, 1);
});

test("an interrupted marker clear retries the exact terminal recovery and then clears", async () => {
  const hostStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-retry-clear-"));
  const stateDir = path.join(
    os.tmpdir(),
    "agenthost-retry-state",
    "agenthost-room-room-retry-clear",
  );
  const quarantine = createActiveRoomQuarantine({
    hostStateDir,
    roomId: "room-retry-clear",
    stateDir,
    taskId: "t_room_retry",
    claimId: "claim_room_retry",
    claimRequest: claimRequest(),
  });
  const remote = lifecycle({
    claimResponse: { recoveryRequired: true },
    taskId: "t_room_retry",
    claimId: "claim_room_retry",
  });
  await assert.rejects(
    recoverAndClearQuarantinedRoom({
      hostStateDir,
      roomId: "room-retry-clear",
      lifecycle: remote.adapter,
      quarantine,
      async stop() { return []; },
      clear() { throw new Error("simulated local unlink interruption"); },
    }),
    /unlink interruption/i,
  );
  assert.deepEqual(readActiveRoomQuarantine({ hostStateDir }), quarantine);

  const retried = await recoverAndClearQuarantinedRoom({
    hostStateDir,
    roomId: "room-retry-clear",
    lifecycle: remote.adapter,
    quarantine,
    async stop() { return []; },
  });
  assert.equal(retried.recovered, true);
  assert.equal(remote.calls.filter(({ method }) => method === "recover").length, 2);
  assert.equal(readActiveRoomQuarantine({ hostStateDir }), null);
});

test("pending-claim recovery replays the idempotent claim, binds it, stops it, and clears", async () => {
  const hostStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-pending-recovery-"));
  const stateDir = path.join(
    os.tmpdir(),
    "agenthost-pending-state",
    "agenthost-room-room-pending-recovery",
  );
  const intent = createActiveRoomQuarantine({
    hostStateDir,
    roomId: "room-pending-recovery",
    stateDir,
    claimRequest: claimRequest(),
  });
  const remote = lifecycle();
  const recovered = await recoverAndClearQuarantinedRoom({
    hostStateDir,
    roomId: "room-pending-recovery",
    lifecycle: remote.adapter,
    quarantine: intent,
    async stop() { return []; },
  });
  assert.deepEqual(recovered, { recovered: true, status: "blocked" });
  assert.deepEqual(
    remote.calls.filter(({ method }) => ["claim", "stop", "recover"].includes(method))
      .map(({ method }) => method),
    ["claim", "stop"],
  );
  assert.equal(readActiveRoomQuarantine({ hostStateDir }), null);
});

test("terminal claim replay clears quarantine without reviving or re-stopping the task", async () => {
  const hostStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-terminal-replay-"));
  const stateDir = path.join(
    os.tmpdir(),
    "agenthost-terminal-state",
    "agenthost-room-room-terminal-replay",
  );
  const intent = createActiveRoomQuarantine({
    hostStateDir,
    roomId: "room-terminal-replay",
    stateDir,
    claimRequest: claimRequest(),
  });
  const remote = lifecycle({ claimResponse: { terminalStatus: "done" } });
  const recovered = await recoverAndClearQuarantinedRoom({
    hostStateDir,
    roomId: "room-terminal-replay",
    lifecycle: remote.adapter,
    quarantine: intent,
    async stop() { return []; },
  });
  assert.deepEqual(recovered, { recovered: true, status: "done" });
  assert.equal(remote.calls.filter(({ method }) => method === "stop").length, 0);
  assert.equal(remote.calls.filter(({ method }) => method === "recover").length, 0);
  assert.equal(readActiveRoomQuarantine({ hostStateDir }), null);
});

test("restart cleanup signals every persisted and discovered room scope without trusting env markers", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-persisted-units-"));
  const stateDir = path.join(root, "agenthost-room-room-persisted");
  createRoomUnitLedger({ stateDir, roomId: "room-persisted" });
  const persistedUnit = "agenthost-room-room-persisted-codex-0123456789.scope";
  recordRoomUnit({
    stateDir,
    roomId: "room-persisted",
    unitName: persistedUnit,
  });
  initializeRoomUnitTracking({
    stateDir,
    roomId: "room-persisted",
    env: {},
    resumeExisting: true,
  });
  const signals = [];
  const survivors = await stopAll("room-persisted", {
    signalProcessGroups() {},
    signalUnits(signal, units) {
      signals.push({ signal, units: units.map(([unitName]) => unitName) });
    },
    signalMarked() {},
    listMarked() { return []; },
    snapshotProcessGroups() { return []; },
    snapshotUnits() { return []; },
    discoverUnits() {
      return { units: [persistedUnit], queryFailed: false };
    },
    processGroupIsAlive() { return false; },
    unitIsActive() { return false; },
    clearTracked() {},
    async wait() {},
  });
  assert.deepEqual(survivors, []);
  assert.deepEqual(signals, [
    { signal: "SIGTERM", units: [persistedUnit] },
    { signal: "SIGKILL", units: [persistedUnit] },
  ]);
  clearRoomUnitTracking();
});

test("systemd query/control failures remain visible as cleanup survivors", () => {
  const probe = (result) => roomUnitActive(
    "agenthost-room-room-proof-codex-0123456789.scope",
    {},
    () => result,
  );
  assert.equal(probe({ status: 1, stdout: "", stderr: "bus unavailable" }), true);
  assert.equal(probe({
    status: 0,
    stdout: "LoadState=loaded\nActiveState=deactivating\n",
  }), true);
  assert.equal(probe({
    status: 0,
    stdout: "LoadState=loaded\nActiveState=inactive\n",
  }), false);
  assert.equal(probe({
    status: 4,
    stdout: "LoadState=not-found\nActiveState=inactive\n",
  }), false);
});

test("the real WSL engine path records its systemd scope before launch", {
  skip: process.platform !== "linux",
  timeout: 30_000,
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-real-engine-ledger-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const roomId = "room-real-engine";
  const stateDir = path.join(root, `agenthost-room-${roomId}`);
  const env = { ...process.env, AGENTHOST_ROOM_ID: roomId };
  initializeRoomUnitTracking({ stateDir, roomId, env });
  const result = await runEngine({
    id: "codex",
    cwd: root,
    branch: "codex/test",
    command: "/usr/bin/printf",
    args: () => ["agent reply\nROOM_STATUS: done\n"],
    parse: (stdout) => ({
      text: stdout.trim(),
      telemetry: {},
      terminalError: false,
    }),
  }, "unused", env, 10_000);
  assert.equal(result.ok, true);
  assert.match(result.unitName, /^agenthost-room-room-real-engine-codex-[0-9a-f]{10}\.scope$/);
  assert.deepEqual(readRoomUnitLedger({ stateDir, roomId }).units, [result.unitName]);
  assert.deepEqual(await stopAll(roomId), []);
  clearRoomUnitTracking();
});
