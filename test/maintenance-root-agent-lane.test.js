import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import laneMod from "../container/maintenance-agent-lane.js";
import entryMod from "../container/maintenance-boot-entry.js";
import runnerMod from "../container/maintenance-chat-runner.js";
import containmentMod from "../container/maintenance-containment.js";

const { createAgentLaneArbiter } = laneMod;
const { createSharedAgentLaneSpawn } = entryMod;
const { createChatRunner } = runnerMod;
const { launchProcessTreeContained, teardown } = containmentMod;

test("the release image contains the root agent-lane arbiter", () => {
  const dockerfile = fs.readFileSync(new URL("../container/Dockerfile", import.meta.url), "utf8");
  assert.match(
    dockerfile,
    /^COPY --chown=root:root maintenance-agent-lane\.js \/opt\/agenthost\/maintenance-agent-lane\.js$/m,
  );
});

test("production boot gives Assist its own arbiter and server quarantine", () => {
  const entry = fs.readFileSync(new URL("../container/maintenance-boot-entry.js", import.meta.url), "utf8");
  assert.match(entry, /const assistLaneArbiter = createAgentLaneArbiter\(/);
  assert.match(entry, /createChatRunner\(\{[\s\S]*?agentLaneArbiter,[\s\S]*?assistLaneArbiter,[\s\S]*?\}\)/);
  assert.match(entry, /createChatServer\(\{[\s\S]*?agentLaneQuarantine:[\s\S]*?assistLaneQuarantine: assistLaneArbiter/);
});

function fakeChild(pid = 4100) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  return child;
}

const profiles = Object.freeze({
  claude: Object.freeze({
    bin: "claude",
    argvTemplate: Object.freeze(["-p", "{prompt}"]),
    cwd: "/data/home/agent/work",
    envAllowlist: Object.freeze(["HOME", "PATH"]),
    credentialNames: Object.freeze([]),
    stdin: "ignore",
  }),
});

test("one root arbiter excludes Foundation-B work and chat in both directions", () => {
  const arbiter = createAgentLaneArbiter();
  const autonomousStarts = [];
  const autonomousTerminals = [];
  const autonomous = createSharedAgentLaneSpawn({
    agentLaneArbiter: arbiter,
    spawn: (args) => {
      autonomousStarts.push(args.workerRef);
      return { childRef: `child_${args.workerRef}` };
    },
    proveTerminal: () => true,
    onTerminal: (workerRef, info) => autonomousTerminals.push([workerRef, info]),
  });
  const chatStarts = [];
  const exits = [];
  const chat = createChatRunner({
    profiles,
    secretsPath: "/missing",
    withCharter: (prompt) => prompt,
    rootEnv: { HOME: "/data/home/agent", PATH: "/usr/bin" },
    agentLaneArbiter: arbiter,
    launchContained: (options) => {
      const child = fakeChild(4200 + chatStarts.length);
      const handle = {
        child,
        handlePid: child.pid,
        namespaceIdentity: Object.freeze({ pid: child.pid + 1, startTime: 7, bootId: "boot" }),
      };
      chatStarts.push({ options, handle });
      return handle;
    },
    proveGone: () => true,
    onExit: (runId, info) => exits.push([runId, info]),
  });

  autonomous.spawn({ workerRef: "worker_1" });
  chat.run({ runId: "chat_blocked_by_work", engineId: "claude", prompt: "hello" });
  assert.equal(chatStarts.length, 0);
  assert.equal(exits.at(-1)[1].error, "agent_lane_busy");

  autonomous.completeAfterOuterClose("worker_1", { exitCode: 0, signalName: null });
  assert.deepEqual(autonomousTerminals, [["worker_1", { exitCode: 0, signalName: null }]]);
  chat.run({ runId: "chat_1", engineId: "claude", prompt: "hello" });
  assert.equal(chatStarts.length, 1);
  assert.throws(
    () => autonomous.spawn({ workerRef: "worker_blocked_by_chat" }),
    (error) => error && error.code === "LANE_BUSY" && error.conclusiveNoChild === true,
  );
  assert.deepEqual(autonomousStarts, ["worker_1"]);

  chatStarts[0].handle.child.emit("close", 0, null);
  autonomous.spawn({ workerRef: "worker_2" });
  assert.deepEqual(autonomousStarts, ["worker_1", "worker_2"]);
  autonomous.completeAfterOuterClose("worker_2", { exitCode: 0, signalName: null });

  arbiter.trip("terminal proof was lost");
  chat.run({ runId: "chat_after_quarantine", engineId: "claude", prompt: "no" });
  assert.throws(
    () => autonomous.spawn({ workerRef: "worker_after_quarantine" }),
    (error) => error && error.code === "GLOBAL_QUARANTINE" && error.conclusiveNoChild === true,
  );
  assert.equal(chatStarts.length, 1);
  assert.equal(arbiter.isQuarantined(), true);
});

test("Foundation-B outer close requires strict namespace absence proof before terminal event or lease release", () => {
  for (const proofMode of ["false", "throw"]) {
    const arbiter = createAgentLaneArbiter();
    const terminals = [];
    const starts = [];
    const autonomous = createSharedAgentLaneSpawn({
      agentLaneArbiter: arbiter,
      spawn: ({ workerRef }) => {
        starts.push(workerRef);
        return { childRef: `child_${workerRef}` };
      },
      proveTerminal: () => {
        if (proofMode === "throw") throw new Error("proc unreadable");
        return false;
      },
      onTerminal: (workerRef, info) => terminals.push([workerRef, info]),
    });

    autonomous.spawn({ workerRef: `worker_${proofMode}` });
    assert.equal(
      autonomous.completeAfterOuterClose(
        `worker_${proofMode}`,
        { exitCode: 0, signalName: null },
      ),
      false,
    );
    assert.deepEqual(terminals, [], `${proofMode}: no trustworthy root terminal event`);
    assert.equal(arbiter.isBusy(), true, `${proofMode}: the opaque lease remains held`);
    assert.equal(arbiter.isQuarantined(), true, `${proofMode}: the boot-scoped latch trips`);
    assert.throws(
      () => autonomous.spawn({ workerRef: `replacement_${proofMode}` }),
      (error) => error && error.code === "GLOBAL_QUARANTINE",
    );
    assert.deepEqual(starts, [`worker_${proofMode}`]);
  }
});

test("a positively proven Foundation-B terminal emits once and reopens root admission", () => {
  const arbiter = createAgentLaneArbiter();
  const terminals = [];
  const autonomous = createSharedAgentLaneSpawn({
    agentLaneArbiter: arbiter,
    spawn: ({ workerRef }) => ({ childRef: `child_${workerRef}` }),
    proveTerminal: () => true,
    onTerminal: (workerRef, info) => terminals.push([workerRef, info]),
  });

  autonomous.spawn({ workerRef: "worker_proven" });
  assert.equal(
    autonomous.completeAfterOuterClose(
      "worker_proven",
      { exitCode: 0, signalName: null },
    ),
    true,
  );
  assert.deepEqual(terminals, [["worker_proven", { exitCode: 0, signalName: null }]]);
  assert.equal(arbiter.isBusy(), false);
  assert.equal(arbiter.isQuarantined(), false);
  assert.doesNotThrow(() => autonomous.spawn({ workerRef: "replacement" }));
});

test("chat containment argv preserves the real workspace while creating a PID namespace", () => {
  const calls = [];
  const child = fakeChild(5100);
  const identity = Object.freeze({ pid: 5101, startTime: 55, bootId: "boot-a" });
  const env = Object.freeze({ HOME: "/data/home/agent", PATH: "/usr/bin", CLAUDE_CODE_OAUTH_TOKEN: "secret" });
  const result = launchProcessTreeContained({
    argv: ["claude", "-p", "hi"],
    uid: 1001,
    gid: 1001,
    cwd: "/data/home/agent/work",
    env,
    stdin: "ignore",
    spawn: (bin, args, opts) => {
      calls.push({ bin, args, opts });
      return child;
    },
    childrenOf: (pid) => {
      assert.equal(pid, 5100);
      return [5101];
    },
    observeChild: (pid) => {
      assert.equal(pid, 5101);
      return identity;
    },
    sleepSync: () => {
      throw new Error("the namespace init was immediately observable");
    },
  });

  assert.equal(result.child, child);
  assert.equal(result.namespaceIdentity, identity);
  assert.deepEqual(calls, [{
    bin: "unshare",
    args: [
      "--pid", "--mount", "--fork", "--mount-proc", "--kill-child", "--",
      "setpriv", "--reuid=1001", "--regid=1001", "--init-groups", "--no-new-privs", "--",
      "claude", "-p", "hi",
    ],
    opts: {
      cwd: "/data/home/agent/work",
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  }]);
});

test("a no-PID containment child absorbs its later async spawn error", () => {
  const child = new EventEmitter();
  assert.throws(
    () => launchProcessTreeContained({
      argv: ["claude", "-p", "hi"],
      uid: 1001,
      gid: 1001,
      cwd: "/data/home/agent/work",
      env: { HOME: "/data/home/agent", PATH: "/usr/bin" },
      spawn: () => child,
    }),
    (error) => error && error.conclusiveNoChild === true,
  );
  assert.doesNotThrow(() => child.emit("error", Object.assign(new Error("missing"), { code: "ENOENT" })));
});

test("teardown kills namespace init first and waits for the unshare parent to reap it", () => {
  const kills = [];
  let children = [7101];
  const result = teardown(
    { handlePid: 7100, child: fakeChild(7100) },
    {
      listChildren: () => children,
      kill: (pid, signal) => {
        kills.push([pid, signal]);
        if (pid === 7101) children = [];
      },
      sleepSync: () => {},
      reapWaitMs: 50,
    },
  );
  assert.equal(result, true);
  assert.deepEqual(kills, [[7101, "SIGKILL"]], "the parent stays alive long enough to reap namespace init");
});

test("chat releases root admission only after namespace-init absence is proven", () => {
  const arbiter = createAgentLaneArbiter();
  const children = [];
  const exits = [];
  let proof = true;
  const runner = createChatRunner({
    profiles,
    secretsPath: "/missing",
    withCharter: (prompt) => prompt,
    rootEnv: { HOME: "/data/home/agent", PATH: "/usr/bin" },
    agentLaneArbiter: arbiter,
    launchContained: () => {
      const child = fakeChild(6100 + children.length);
      children.push(child);
      return {
        child,
        handlePid: child.pid,
        namespaceIdentity: Object.freeze({ pid: child.pid + 1, startTime: 9, bootId: "boot-b" }),
      };
    },
    proveGone: () => proof,
    onExit: (runId, info) => exits.push([runId, info]),
  });

  runner.run({ runId: "proved", engineId: "claude", prompt: "one" });
  children[0].emit("close", 0, null);
  runner.run({ runId: "after_proof", engineId: "claude", prompt: "two" });
  assert.equal(children.length, 2, "a terminal namespace proof reopens admission");

  proof = false;
  children[1].emit("close", 0, null);
  runner.run({ runId: "after_uncertainty", engineId: "claude", prompt: "three" });
  assert.equal(children.length, 2, "uncertain namespace cleanup never admits a replacement");
  assert.equal(arbiter.isQuarantined(), true);
  assert.equal(exits.at(-1)[1].error, "agent_lane_busy");
});
