import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import runtimeMod from "../container/maintenance-worker-runtime.js";

const { createWorkerRuntime } = runtimeMod;

const profiles = Object.freeze({
  governed: Object.freeze({
    argv: Object.freeze(["claude", "-p", "{objective}"]),
    uid: 10001,
    gid: 10001,
    worktreeBase: "/data/maintenance/work",
    worktreeSizeMb: 16,
    envAllowlist: Object.freeze(["PATH"]),
  }),
});

function fakeChild(pid = 8000) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

test("worker runtime proves the observed namespace init gone before forgetting it", () => {
  const child = fakeChild();
  const identity = Object.freeze({ pid: 8001, startTime: 44, bootId: "boot-a" });
  const seen = [];
  let proof = false;
  const runtime = createWorkerRuntime({
    profiles,
    launchContained: () => ({ handlePid: 8000, child }),
    listChildren: () => [8001],
    observeChild: () => identity,
    proveGone: (candidate) => {
      seen.push(candidate);
      return proof;
    },
    teardownContained: () => true,
    sleepSync: () => {},
    onExit: () => {},
  });

  runtime.spawn({ workerRef: "worker_1", profileId: "governed", objective: "fix it" });
  assert.equal(runtime.proveTerminal("worker_1"), false);
  assert.equal(runtime.count(), 1, "false proof retains the observed identity");
  proof = true;
  assert.equal(runtime.proveTerminal("worker_1"), true);
  assert.equal(runtime.count(), 0, "positive proof forgets the dead identity");
  assert.equal(runtime.proveTerminal("worker_1"), true, "recovery and close may consume the same proof in either order");
  assert.deepEqual(seen, [identity, identity]);
});

test("post-spawn observation failures are termination-unproven, never conclusive no-child", () => {
  for (const mode of ["no-child-visible", "identity-read-failed"]) {
    const child = fakeChild(mode === "no-child-visible" ? 8100 : 8200);
    let teardownCalls = 0;
    const runtime = createWorkerRuntime({
      profiles,
      launchContained: () => ({ handlePid: child.pid, child }),
      listChildren: () => mode === "no-child-visible" ? [] : [child.pid + 1],
      observeChild: () => {
        throw Object.assign(new Error("proc unreadable"), { code: "EACCES" });
      },
      proveGone: () => false,
      teardownContained: () => {
        teardownCalls += 1;
        return false;
      },
      sleepSync: () => {},
      observeTimeoutMs: 0,
    });

    assert.throws(
      () => runtime.spawn({ workerRef: `worker_${mode}`, profileId: "governed", objective: "fix it" }),
      (error) => error &&
        error.terminationUnproven === true &&
        error.conclusiveNoChild !== true &&
        error.containmentHandle &&
        error.containmentHandle.child === child,
      mode,
    );
    assert.equal(teardownCalls, 1);
    assert.equal(runtime.count(), 0);
  }
});
