import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  bindSupervisorLifecycleAdapter,
  bindActiveRoomQuarantine,
  canonicalRoomHostStateDirectory,
  clearActiveRoomQuarantine,
  createActiveRoomQuarantine,
  createRoomUnitLedger,
  loadOrCreateSupervisorContext,
  prepareCanonicalRoomHostStateDirectory,
  readActiveRoomQuarantine,
  readExistingRoomSupervisor,
  readRoomUnitLedger,
  recordRoomUnit,
} from "../scripts/local-room/supervisor.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-supervisor-"));
  const repoRoot = path.join(root, "repo");
  const stateRoot = path.join(root, "private-state");
  fs.mkdirSync(repoRoot);
  return { root, repoRoot, stateRoot };
}

function claimRequest() {
  return {
    objectiveDigest: "a".repeat(64),
    agents: ["claude", "codex", "hermes", "kimi"].map((engineId) => ({
      engineId,
      branch: `agenthost-room/test/${engineId}`,
    })),
    startedAt: 1_000,
  };
}

test("host identity is stable while each room receives a unique high-entropy token", () => {
  const item = fixture();
  const first = loadOrCreateSupervisorContext({
    repoRoot: item.repoRoot,
    stateRoot: item.stateRoot,
    stateDir: path.join(item.stateRoot, "agenthost-room-one"),
    roomId: "room-one",
  });
  const second = loadOrCreateSupervisorContext({
    repoRoot: item.repoRoot,
    stateRoot: item.stateRoot,
    stateDir: path.join(item.stateRoot, "agenthost-room-two"),
    roomId: "room-two",
  });

  assert.equal(first.supervisorId, second.supervisorId);
  assert.match(first.supervisorId, /^desktop-[0-9a-f]{32}$/);
  assert.notEqual(first.supervisorToken, second.supervisorToken);
  assert.match(first.supervisorToken, /^[A-Za-z0-9_-]{64}$/);
  assert.match(second.supervisorToken, /^[A-Za-z0-9_-]{64}$/);
  assert.equal(path.relative(item.repoRoot, first.roomFile).startsWith(".."), true);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(item.stateRoot).mode & 0o077, 0);
    assert.equal(fs.statSync(first.hostFile).mode & 0o077, 0);
    assert.equal(fs.statSync(first.roomFile).mode & 0o077, 0);
  }
});

test("room restart reuses the original room id and supervisor token", () => {
  const item = fixture();
  const stateDir = path.join(item.stateRoot, "agenthost-room-restart");
  const initial = loadOrCreateSupervisorContext({
    repoRoot: item.repoRoot,
    stateRoot: item.stateRoot,
    stateDir,
    roomId: "room-restart",
  });
  const discovered = readExistingRoomSupervisor({ stateDir });
  const restarted = loadOrCreateSupervisorContext({
    repoRoot: item.repoRoot,
    stateRoot: item.stateRoot,
    stateDir,
    roomId: discovered.roomId,
    resumeExisting: true,
  });
  assert.equal(restarted.roomId, initial.roomId);
  assert.equal(restarted.supervisorId, initial.supervisorId);
  assert.equal(restarted.supervisorToken, initial.supervisorToken);
});

test("supervisor state fails closed inside the source repository", () => {
  const item = fixture();
  const stateRoot = path.join(item.repoRoot, ".room-state");
  assert.throws(
    () => loadOrCreateSupervisorContext({
      repoRoot: item.repoRoot,
      stateRoot,
      stateDir: path.join(stateRoot, "agenthost-room-unsafe"),
      roomId: "room-unsafe",
    }),
    /outside the source repository/i,
  );
});

test("restart cannot mint replacement credentials for an existing room", () => {
  const item = fixture();
  assert.throws(
    () => loadOrCreateSupervisorContext({
      repoRoot: item.repoRoot,
      stateRoot: item.stateRoot,
      stateDir: path.join(item.stateRoot, "agenthost-room-missing"),
      roomId: "room-missing",
      resumeExisting: true,
    }),
    /cannot reattach without its supervisor record/i,
  );
});

test("the host guard path is canonical while quarantine is durable and nonce-bound", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-quarantine-"));
  const hostStateDir = canonicalRoomHostStateDirectory(root);
  assert.equal(
    hostStateDir,
    path.join(root, ".local", "state", "agenthost"),
  );
  const quarantine = createActiveRoomQuarantine({
    hostStateDir,
    roomId: "room-quarantined",
    stateDir: path.join(root, "rooms-a", "agenthost-room-room-quarantined"),
    taskId: "t_room",
    claimId: "claim_room",
    claimRequest: claimRequest(),
  });
  assert.deepEqual(readActiveRoomQuarantine({ hostStateDir }), quarantine);
  const quarantineFile = path.join(hostStateDir, "active-room.quarantine.json");
  const interruptedTemporary = path.join(
    hostStateDir,
    ".active-room.quarantine.json.999." + "a".repeat(16) + ".tmp",
  );
  fs.linkSync(quarantineFile, interruptedTemporary);
  assert.equal(fs.statSync(quarantineFile).nlink, 2);
  assert.deepEqual(readActiveRoomQuarantine({ hostStateDir }), quarantine);
  assert.equal(fs.existsSync(interruptedTemporary), false);
  assert.equal(fs.statSync(quarantineFile).nlink, 1);
  assert.throws(
    () => clearActiveRoomQuarantine({
      hostStateDir,
      quarantine: { ...quarantine, quarantineNonce: "f".repeat(32) },
    }),
    /changed before verified recovery/i,
  );
  clearActiveRoomQuarantine({ hostStateDir, quarantine });
  assert.equal(readActiveRoomQuarantine({ hostStateDir }), null);
});

test("the canonical host guard rejects a symlinked ancestor into the repository", {
  skip: process.platform === "win32",
}, () => {
  const item = fixture();
  const home = path.join(item.root, "home");
  fs.mkdirSync(home);
  fs.symlinkSync(item.repoRoot, path.join(home, ".local"));
  assert.throws(
    () => prepareCanonicalRoomHostStateDirectory({
      repoRoot: item.repoRoot,
      homeDirectory: home,
    }),
    /untrusted component|separate from the source repository/i,
  );
});

test("a durable pending-claim intent blocks a fresh room before the claim response arrives", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-claim-intent-"));
  const hostStateDir = canonicalRoomHostStateDirectory(root);
  const intent = createActiveRoomQuarantine({
    hostStateDir,
    roomId: "room-pending",
    stateDir: path.join(root, "rooms", "agenthost-room-room-pending"),
    claimRequest: claimRequest(),
  });
  assert.equal(intent.taskId, null);
  assert.equal(intent.claimId, null);
  assert.deepEqual(readActiveRoomQuarantine({ hostStateDir }), intent);
  const bound = bindActiveRoomQuarantine({
    hostStateDir,
    quarantine: intent,
    taskId: "t_room_pending",
    claimId: "claim_room_pending",
  });
  assert.equal(bound.taskId, "t_room_pending");
  assert.equal(bound.quarantineNonce, intent.quarantineNonce);
  clearActiveRoomQuarantine({ hostStateDir, quarantine: bound });
});

test("the append-only room unit ledger survives restart and accepts only exact room scopes", () => {
  const item = fixture();
  const stateDir = path.join(item.stateRoot, "agenthost-room-ledger");
  const created = createRoomUnitLedger({
    stateDir,
    roomId: "room-ledger",
  });
  assert.deepEqual(created.units, []);
  const unitName = "agenthost-room-room-ledger-codex-0123456789.scope";
  const recorded = recordRoomUnit({
    stateDir,
    roomId: "room-ledger",
    unitName,
  });
  assert.deepEqual(recorded.units, [unitName]);
  assert.deepEqual(
    readRoomUnitLedger({ stateDir, roomId: "room-ledger" }).units,
    [unitName],
  );
  assert.throws(
    () => recordRoomUnit({
      stateDir,
      roomId: "room-ledger",
      unitName: "unrelated.scope",
    }),
    /unit name is invalid/i,
  );
});

test("lifecycle binding sends supervisor credentials only on ownership mutations", async () => {
  const calls = [];
  const adapter = Object.fromEntries(
    ["ready", "claim", "heartbeat", "complete", "stop", "recover"].map((method) => [
      method,
      async (event) => {
        calls.push({ method, event });
        return method === "claim"
          ? {
            taskId: "t_room",
            claimId: "claim_room",
            leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          }
          : { ok: true };
      },
    ]),
  );
  const supervisor = {
    supervisorId: "desktop-0123456789abcdef0123456789abcdef",
    supervisorToken: "a".repeat(64),
  };
  const bound = bindSupervisorLifecycleAdapter(adapter, supervisor);
  await bound.ready({ roomId: "room-one", engineId: "claude" });
  for (const method of ["claim", "heartbeat", "complete", "stop", "recover"]) {
    await bound[method]({ roomId: "room-one" });
  }

  assert.equal("supervisorId" in calls[0].event, false);
  assert.equal("supervisorToken" in calls[0].event, false);
  for (const call of calls.slice(1)) {
    assert.equal(call.event.supervisorId, supervisor.supervisorId);
    assert.equal(call.event.supervisorToken, supervisor.supervisorToken);
  }
  assert.doesNotMatch(process.argv.join("\0"), new RegExp(supervisor.supervisorToken));
});

test("lifecycle binding rejects credential echo and redacts credential-bearing errors", async () => {
  const supervisor = {
    supervisorId: "desktop-0123456789abcdef0123456789abcdef",
    supervisorToken: "b".repeat(64),
  };
  const methods = ["ready", "claim", "heartbeat", "complete", "stop", "recover"];
  const echoing = Object.fromEntries(methods.map((method) => [
    method,
    async () => method === "heartbeat"
      ? { supervisorToken: supervisor.supervisorToken }
      : { ok: true },
  ]));
  const boundEcho = bindSupervisorLifecycleAdapter(echoing, supervisor);
  await assert.rejects(
    boundEcho.heartbeat({ roomId: "room-one" }),
    (error) => {
      assert.match(error.message, /returned private supervisor credentials/i);
      assert.doesNotMatch(error.message, new RegExp(supervisor.supervisorToken));
      return true;
    },
  );

  let deeplyNestedEcho = { supervisorToken: supervisor.supervisorToken };
  for (let depth = 0; depth < 10; depth += 1) {
    deeplyNestedEcho = { nested: deeplyNestedEcho };
  }
  const deepEchoing = Object.fromEntries(methods.map((method) => [
    method,
    async () => method === "complete" ? deeplyNestedEcho : { ok: true },
  ]));
  await assert.rejects(
    bindSupervisorLifecycleAdapter(deepEchoing, supervisor).complete({ roomId: "room-one" }),
    /returned private supervisor credentials/i,
  );

  const throwing = Object.fromEntries(methods.map((method) => [
    method,
    async () => {
      const error = new Error(`remote accidentally included ${supervisor.supervisorToken}`);
      error.code = `REMOTE_${supervisor.supervisorToken}`;
      throw error;
    },
  ]));
  const boundThrow = bindSupervisorLifecycleAdapter(throwing, supervisor);
  await assert.rejects(
    boundThrow.stop({ roomId: "room-one" }),
    (error) => {
      assert.match(error.message, /\[REDACTED\]/);
      assert.doesNotMatch(error.message, new RegExp(supervisor.supervisorToken));
      assert.equal(error.code, undefined);
      assert.doesNotMatch(
        JSON.stringify({ message: error.message, code: error.code }),
        new RegExp(supervisor.supervisorToken),
      );
      return true;
    },
  );
});
