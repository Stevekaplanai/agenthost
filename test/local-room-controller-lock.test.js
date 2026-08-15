import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { acquireRoomControllerLock } from "../scripts/local-room/supervisor.mjs";

test("one live controller owns a room and a dead holder can restart without losing work", {
  skip: process.platform !== "linux",
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-controller-lock-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateDir = path.join(root, "agenthost-room-lock-test");
  const dirtyFile = path.join(stateDir, "worktrees", "codex", "in-progress.txt");

  const first = await acquireRoomControllerLock({ stateDir });
  assert.equal(first.record.pid, process.pid);
  assert.equal(first.signal.aborted, false);
  await assert.rejects(
    acquireRoomControllerLock({ stateDir }),
    /already running|cannot be safely reclaimed/i,
  );

  fs.mkdirSync(path.dirname(dirtyFile), { recursive: true });
  fs.writeFileSync(dirtyFile, "preserve this work\n");
  await first.release();

  const restarted = await acquireRoomControllerLock({ stateDir });
  try {
    assert.equal(fs.readFileSync(dirtyFile, "utf8"), "preserve this work\n");
    assert.notEqual(restarted.record.ownerNonce, first.record.ownerNonce);
  } finally {
    await restarted.release();
  }
});

test("one host can expose only one active room while room restart keeps its own lock", {
  skip: process.platform !== "linux",
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-host-lock-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const firstRoom = path.join(root, "agenthost-room-first");
  const secondRoom = path.join(root, "agenthost-room-second");

  const host = await acquireRoomControllerLock({
    stateDir: root,
    lockFileName: "active-room.lock",
  });
  const room = await acquireRoomControllerLock({ stateDir: firstRoom });
  await assert.rejects(
    acquireRoomControllerLock({
      stateDir: root,
      lockFileName: "active-room.lock",
    }),
    /already running|cannot be safely reclaimed/i,
  );
  assert.equal(fs.existsSync(path.join(secondRoom, "controller.lock")), false);
  await room.release();
  await host.release();

  const restartedHost = await acquireRoomControllerLock({
    stateDir: root,
    lockFileName: "active-room.lock",
  });
  const restartedRoom = await acquireRoomControllerLock({ stateDir: firstRoom });
  try {
    assert.notEqual(restartedHost.record.ownerNonce, host.record.ownerNonce);
    assert.notEqual(restartedRoom.record.ownerNonce, room.record.ownerNonce);
  } finally {
    await restartedRoom.release();
    await restartedHost.release();
  }
});

test("a lock-helper spawn failure rejects promptly instead of hanging", {
  skip: process.platform !== "linux",
  timeout: 5_000,
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-controller-spawn-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const flockPath = path.join(root, "not-executable");
  fs.writeFileSync(flockPath, "#!/bin/sh\n", { mode: 0o600 });

  const startedAt = Date.now();
  await assert.rejects(
    acquireRoomControllerLock({
      stateDir: path.join(root, "agenthost-room-spawn-test"),
      flockPath,
      timeoutMs: 1_000,
    }),
    /EACCES|permission denied|spawn/i,
  );
  assert.ok(Date.now() - startedAt < 2_000);
});

test("a hard-linked lock path is rejected without truncating the linked file", {
  skip: process.platform !== "linux",
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-controller-hardlink-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateDir = path.join(root, "agenthost-room-hardlink");
  fs.mkdirSync(stateDir, { mode: 0o700 });
  const protectedFile = path.join(stateDir, "protected.txt");
  const lockFile = path.join(stateDir, "controller.lock");
  fs.writeFileSync(protectedFile, "must remain intact\n", { mode: 0o600 });
  fs.linkSync(protectedFile, lockFile);

  await assert.rejects(
    acquireRoomControllerLock({ stateDir }),
    /lock path is not trusted/i,
  );
  assert.equal(fs.readFileSync(protectedFile, "utf8"), "must remain intact\n");
});

test("the live controller detects replacement of its visible lock inode", {
  skip: process.platform !== "linux",
  timeout: 5_000,
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-controller-swap-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateDir = path.join(root, "agenthost-room-swap");
  const held = await acquireRoomControllerLock({ stateDir });
  const displaced = path.join(stateDir, "controller.displaced");
  fs.renameSync(held.file, displaced);
  fs.writeFileSync(held.file, "replacement\n", { mode: 0o600 });

  await Promise.race([
    new Promise((resolve) => held.signal.addEventListener("abort", resolve, { once: true })),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error("lock replacement was not detected")),
      2_000,
    )),
  ]);
  assert.equal(held.signal.aborted, true);
  await held.release();
});
