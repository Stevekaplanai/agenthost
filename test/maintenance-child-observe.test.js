import { test as rawTest } from "node:test";
import assert from "node:assert/strict";
import cp from "node:child_process";
import { observeChild, verifyAlive, proveGone, bootId } from "../container/maintenance-child-observe.js";

// This suite is Linux-bound by nature: the module under test reads /proc for
// kernel-stable identity, and the harness spawns `sleep` + sends POSIX signals.
// On Windows/macOS these fail with environment noise (kill EINVAL), not product
// signal — so self-skip anywhere but Linux. CI and the box both run Linux,
// where every test still executes.
const NOT_LINUX = process.platform !== "linux" && `Linux-only (/proc identity + POSIX signals); skipped on ${process.platform}`;
const test = (name, fn) => rawTest(name, { skip: NOT_LINUX }, fn);

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function spawnSleeper() { return cp.spawn("sleep", ["30"], { stdio: "ignore" }); }

test("observeChild records a kernel-stable identity for a live child", () => {
  const child = spawnSleeper();
  try {
    const id = observeChild(child.pid);
    assert.equal(id.pid, child.pid);
    assert.ok(Number.isInteger(id.startTime) && id.startTime > 0);
    assert.equal(id.bootId, bootId());
  } finally { child.kill("SIGKILL"); }
});

test("verifyAlive is true for the same live process", () => {
  const child = spawnSleeper();
  try {
    assert.equal(verifyAlive(observeChild(child.pid)), true);
  } finally { child.kill("SIGKILL"); }
});

test("verifyAlive is false once the process has exited", async () => {
  const child = spawnSleeper();
  const id = observeChild(child.pid);
  child.kill("SIGKILL");
  await new Promise((r) => child.on("exit", r)); // node reaps it
  await delay(50);
  assert.equal(verifyAlive(id), false);
});

test("a reused pid is rejected: same pid, different start time", () => {
  const child = spawnSleeper();
  try {
    const id = observeChild(child.pid);
    // An impostor that reused the pid would present a different start time.
    const impostor = { ...id, startTime: id.startTime + 1 };
    assert.equal(verifyAlive(impostor), false);
  } finally { child.kill("SIGKILL"); }
});

test("a post-reboot identity is rejected: different boot id", () => {
  const child = spawnSleeper();
  try {
    const id = observeChild(child.pid);
    assert.equal(verifyAlive({ ...id, bootId: "00000000-0000-0000-0000-000000000000" }), false);
  } finally { child.kill("SIGKILL"); }
});

test("observeChild throws for a pid that is not observable", () => {
  // pid 2^31-1 is effectively never live.
  assert.throws(() => observeChild(2147483647));
});

rawTest("proveGone distinguishes absence from unreadable /proc state", () => {
  const identity = { pid: 44, startTime: 9, bootId: "boot-a" };
  assert.equal(proveGone(identity, {
    readBootId: () => "boot-a",
    readStartTime: () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); },
  }), true);
  assert.equal(proveGone(identity, {
    readBootId: () => "boot-a",
    readStartTime: () => 9,
  }), false);
  assert.throws(() => proveGone(identity, {
    readBootId: () => "boot-a",
    readStartTime: () => { throw Object.assign(new Error("unreadable"), { code: "EACCES" }); },
  }), /unreadable/);
});
