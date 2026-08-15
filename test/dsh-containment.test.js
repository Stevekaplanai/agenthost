import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import chainsMod from "../container/chains-lib.js";
import containmentMod from "../container/maintenance-containment.js";
import runnerMod from "../container/maintenance-chat-runner.js";

const { buildBwrapReadJail } = chainsMod;
const { launchSetuidBwrapProcessTreeContained } = containmentMod;
const { createChatRunner } = runnerMod;
const linuxDirectoryFdOnly = process.platform === "linux"
  ? false
  : "the production bwrap directory-fd identity boundary is Linux-only";

function fakeChild(pid = 8100) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.written = "";
  child.stdin.write = (chunk) => { child.stdin.written += String(chunk); return true; };
  child.stdin.end = (chunk) => { if (chunk !== undefined) child.stdin.written += String(chunk); };
  child.kill = () => true;
  return child;
}

function arbiter() {
  return {
    acquire: () => Object.freeze({ id: "lease" }),
    release: () => true,
    trip: () => {},
  };
}

function deepseekWorkspace() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ah-dsh-"));
  const worktree = path.join(home, "workspaces", "deepseek", "repo");
  fs.mkdirSync(worktree, { recursive: true });
  execFileSync("git", ["init", "-q", worktree], { stdio: "ignore" });
  const git = (args) => execFileSync("git", ["-C", worktree, ...args], { stdio: "ignore" });
  git(["config", "user.email", "test@example.invalid"]);
  git(["config", "user.name", "test"]);
  fs.writeFileSync(path.join(worktree, "fixture.txt"), "fixture\n");
  git(["add", "fixture.txt"]);
  git(["commit", "-qm", "fixture"]);
  git(["checkout", "-qb", "deepseek/work"]);
  return {
    home: home.split(path.sep).join("/"),
    worktree: worktree.split(path.sep).join("/"),
  };
}

test("DeepSeek jail has a fresh network/PID/proc view and required file mounts", () => {
  const jail = buildBwrapReadJail("/usr/local/bin/node", ["/opt/agenthost/dsh-headless-runner.js"], {
    unshareNet: true,
    dshRootBridgeCapabilities: true,
    chdir: "/workspace",
    requiredRoBindAt: [
      { src: "/opt/deepseek-harness", dest: "/opt/deepseek-harness" },
      { src: "/run/agenthost-dsh/abc.sock", dest: "/run/agenthost-dsh/relay.sock" },
      { src: "/opt/agenthost/dsh-empty.env", dest: "/workspace/.env" },
    ],
    requiredRwBindFdAt: [{ fd: 3, dest: "/workspace" }],
  });

  assert.equal(jail.bin, "/usr/bin/bwrap");
  assert.ok(jail.args.includes("--unshare-net"), "the DSH process has loopback only");
  const capDrop = jail.args.indexOf("--cap-drop");
  assert.deepEqual(jail.args.slice(capDrop, capDrop + 10), [
    "--cap-drop", "ALL",
    "--cap-add", "CAP_SETUID",
    "--cap-add", "CAP_SETGID",
    "--cap-add", "CAP_DAC_OVERRIDE",
    "--cap-add", "CAP_KILL",
  ], "the root bridge retains only the capabilities required to connect, drop and stop DSH");
  assert.ok(jail.args.includes("--unshare-pid"), "the DSH process gets a fresh PID namespace");
  assert.ok(jail.args.includes("--proc"), "the DSH process sees only its fresh procfs");
  assert.ok(jail.args.includes("--clearenv"), "host environment inheritance is denied");
  assert.deepEqual(jail.args.filter((arg, index) => jail.args[index - 1] === "--chmod"), ["01777", "01777"]);
  assert.ok(jail.args.includes("/hm"), "the dropped DSH child receives an ephemeral writable HOME");
  for (const source of ["/opt/deepseek-harness", "/run/agenthost-dsh/abc.sock", "/opt/agenthost/dsh-empty.env"]) {
    const at = jail.args.indexOf(source);
    assert.equal(jail.args[at - 1], "--ro-bind", `${source} is required, not best effort`);
  }
  const chdir = jail.args.indexOf("--chdir");
  assert.equal(jail.args[chdir + 1], "/workspace");
  const worktreeBind = jail.args.indexOf("--bind-fd");
  assert.deepEqual(jail.args.slice(worktreeBind, worktreeBind + 3), ["--bind-fd", "3", "/workspace"],
    "Bubblewrap must mount the admitted inode by fd, not re-resolve /proc/self/fd/3 by pathname");
  assert.equal(jail.args.includes("/proc/self/fd/3"), false,
    "the CVE-2024-42472 magic-link race must not be reintroduced");
});

test("the root bridge creates the fixed Bubblewrap jail before dropping only DSH", () => {
  const calls = [];
  const child = fakeChild(8200);
  const result = launchSetuidBwrapProcessTreeContained({
    bwrapArgs: ["--unshare-net", "--", "/bin/true"],
    sourceFds: [],
    uid: 1001,
    gid: 1001,
    cwd: "/",
    env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
    spawn: (bin, args, options) => { calls.push({ bin, args, options }); return child; },
    childrenOf: () => [8201],
    observeChild: () => Object.freeze({ pid: 8201, startTime: 1, bootId: "boot" }),
    sleepSync: () => {},
  });

  assert.equal(result.child, child);
  assert.equal(calls[0].bin, "unshare");
  const args = calls[0].args;
  const bwrapAt = args.indexOf("/usr/bin/bwrap");
  assert.ok(bwrapAt > 0, "the executable is fixed to system Bubblewrap");
  assert.equal(args.includes("--no-new-privs"), false,
    "setpriv must not suppress Bubblewrap's setuid bit before the jail exists");
  assert.equal(args.includes("setpriv"), false,
    "the bearer-consuming bridge stays root; its child performs the fixed identity drop");
  assert.deepEqual(args.slice(bwrapAt), ["/usr/bin/bwrap", "--unshare-net", "--", "/bin/true"]);
  assert.throws(
    () => launchSetuidBwrapProcessTreeContained({ argv: ["/bin/sh"], uid: 1001, gid: 1001, cwd: "/", env: {} }),
    /bwrapArgs/,
    "the special launcher has no arbitrary argv mode",
  );
});

test("an unobserved Bubblewrap child retains bounded, sanitized launcher stderr", () => {
  const child = fakeChild(8250);
  let emitted = false;
  let failure;
  try {
    launchSetuidBwrapProcessTreeContained({
      bwrapArgs: ["--unshare-net", "--", "/bin/true"],
      uid: 1001,
      gid: 1001,
      cwd: "/",
      env: { PATH: "/usr/bin:/bin" },
      spawn: () => child,
      childrenOf: () => [],
      sleepSync: () => {
        if (emitted) return;
        emitted = true;
        child.stderr.emit("data", "bwrap: cannot mount /data/home/agent/workspaces/deepseek/private/.env\n");
      },
      observeTimeoutMs: 25,
    });
  } catch (error) { failure = error; }

  assert.equal(failure.message, "dsh_namespace_init_not_observed");
  assert.equal(failure.terminationUnproven, true);
  assert.equal(failure.launcherFailureCause(), "bwrap: cannot mount [private worktree]");
});

test("root composes DeepSeek autonomous argv, env and mounts without a real credential", () => {
  const fixture = deepseekWorkspace();
  const launches = [];
  const regularLaunch = () => { throw new Error("DeepSeek used the NNP-before-bwrap launcher"); };
  const setuidLaunch = (options) => {
    const child = fakeChild(8300);
    const handle = {
      child,
      handlePid: child.pid,
      namespaceIdentity: Object.freeze({ pid: 8301, startTime: 1, bootId: "boot" }),
    };
    launches.push({ ...options, handle });
    return handle;
  };
  const exits = [];
  const runner = createChatRunner({
    profiles: {},
    agentLaneArbiter: arbiter(),
    launchContained: regularLaunch,
    launchSetuidBwrapContained: setuidLaunch,
    proveGone: () => true,
    teardownContained: () => true,
    agentHome: fixture.home,
    withCharter: (prompt) => `CHARTER\n${prompt}`,
    relaySocketStat: () => ({ isSocket: () => true }),
    relayCapability: () => ({
      socketPath: "/run/agenthost-dsh/test-capability.sock",
      relayToken: "b".repeat(64),
    }),
    rootEnv: { AGENTHOST_FOUNDATION_B: "1" },
    onExit: (_id, info) => exits.push(info),
  });

  const accepted = runner.runAutonomous({
    runId: "run_dsh_secure_01",
    engineId: "deepseek",
    prompt: "make the change",
    worktree: fixture.worktree,
  });

  assert.equal(accepted.accepted, true);
  assert.equal(launches.length, 1);
  const launch = launches[0];
  assert.deepEqual(Object.keys(launch.env).sort(), [
    "DEEPSEEK_API_KEY", "DSH_HOME", "DSH_PERMISSION_MODE", "DSH_TELEMETRY_DISABLED",
    "DSH_RUN_AS_GID", "DSH_RUN_AS_UID", "DSH_TOOLS_MODE", "HOME", "LANG", "LC_ALL", "LOGNAME",
    "NO_COLOR", "PATH", "SHELL", "TERM", "USER",
  ].sort());
  assert.equal(launch.env.DEEPSEEK_API_KEY, "agenthost-relay-not-a-real-key");
  assert.equal(JSON.stringify(launch).includes("sk-"), false, "no raw provider credential reaches the launch");
  assert.ok(launch.bwrapArgs.includes("--unshare-net"));
  assert.ok(launch.bwrapArgs.includes("--cap-drop"));
  const jailCommand = launch.bwrapArgs.indexOf("--");
  assert.deepEqual(launch.bwrapArgs.slice(jailCommand + 1, jailCommand + 6), [
    "/bin/sh", "-c", 'exec 3<&-; exec "$@"', "agenthost-fd-close", "/usr/bin/setpriv",
  ]);
  assert.ok(launch.bwrapArgs.slice(jailCommand + 1).includes("--no-new-privs"),
    "the root bridge cannot regain capabilities through a later exec");
  assert.ok(launch.bwrapArgs.includes("/run/agenthost-dsh/relay.sock"));
  assert.ok(launch.bwrapArgs.includes("/workspace/.env"));
  assert.ok(launch.bwrapArgs.includes("/opt/deepseek-harness"));
  const worktreeBind = launch.bwrapArgs.indexOf("--bind-fd");
  assert.deepEqual(launch.bwrapArgs.slice(worktreeBind, worktreeBind + 3), ["--bind-fd", "3", "/workspace"],
    "the writable worktree is pinned by inherited fd");
  assert.equal(launch.bwrapArgs.includes("/proc/self/fd/3"), false);
  assert.equal(launch.sourceFds.length, 1);
  assert.equal(launch.handle.child.stdin.written, `${"b".repeat(64)}\nCHARTER\nmake the change`,
    "the prompt enters the isolated runner over stdin, not the outer process argv");
  assert.equal(JSON.stringify(launch.bwrapArgs).includes("b".repeat(64)), false,
    "the relay bearer never enters the outer argv");
  assert.equal(JSON.stringify(launch.env).includes("b".repeat(64)), false,
    "the relay bearer never enters the DSH environment");
  assert.equal(exits.length, 0);
});

test("root refuses a worktree whose inode changes between branch validation and fd pin", {
  skip: linuxDirectoryFdOnly,
}, () => {
  const fixture = deepseekWorkspace();
  let statCalls = 0;
  const exits = [];
  const runner = createChatRunner({
    profiles: {},
    agentLaneArbiter: arbiter(),
    launchContained: () => { throw new Error("must not launch"); },
    launchSetuidBwrapContained: () => { throw new Error("must not launch swapped inode"); },
    agentHome: fixture.home,
    relaySocketStat: () => ({ isSocket: () => true }),
    relayCapability: () => ({
      socketPath: "/run/agenthost-dsh/test-capability.sock",
      relayToken: "c".repeat(64),
    }),
    rootEnv: { AGENTHOST_FOUNDATION_B: "1" },
    statSource: (fd) => {
      const actual = fs.fstatSync(fd);
      statCalls += 1;
      return {
        isDirectory: () => true,
        dev: actual.dev,
        ino: statCalls >= 3 ? actual.ino + 1 : actual.ino,
      };
    },
    onExit: (_id, info) => exits.push(info),
  });

  const result = runner.runAutonomous({
    runId: "run_dsh_inode_swap",
    engineId: "deepseek",
    prompt: "make the change",
    worktree: fixture.worktree,
  });

  assert.equal(result.accepted, false);
  assert.match(exits[0].error, /dsh_worktree_pin_identity_changed/);
});

test("root refuses a worktree whose branch changes between validation and fd pin", () => {
  const fixture = deepseekWorkspace();
  let openCalls = 0;
  let launches = 0;
  let releases = 0;
  let trips = 0;
  const exits = [];
  const runner = createChatRunner({
    profiles: {},
    agentLaneArbiter: {
      acquire: () => Object.freeze({ id: "lease" }),
      release: () => { releases += 1; return true; },
      trip: () => { trips += 1; },
    },
    launchContained: () => { throw new Error("must not launch"); },
    launchSetuidBwrapContained: () => { launches += 1; throw new Error("must not launch changed branch"); },
    agentHome: fixture.home,
    relaySocketStat: () => ({ isSocket: () => true }),
    relayCapability: () => ({
      socketPath: "/run/agenthost-dsh/test-capability.sock",
      relayToken: "e".repeat(64),
    }),
    rootEnv: { AGENTHOST_FOUNDATION_B: "1" },
    openSource: (source, flags) => {
      openCalls += 1;
      if (openCalls === 2) {
        execFileSync("git", ["-C", fixture.worktree, "checkout", "-qb", "main"], { stdio: "ignore" });
      }
      return fs.openSync(source, flags);
    },
    onExit: (_id, info) => exits.push(info),
  });

  const result = runner.runAutonomous({
    runId: "run_dsh_branch_swap",
    engineId: "deepseek",
    prompt: "make the change",
    worktree: fixture.worktree,
  });

  assert.equal(result.accepted, false);
  assert.equal(launches, 0);
  assert.equal(releases, 1);
  assert.equal(trips, 0);
  assert.match(exits[0].error, /dsh_worktree_pin_branch_changed/);
});

test("pre-spawn worktree pin failures release the lane with their exact cause", async (t) => {
  for (const stage of ["open", "stat"]) {
    await t.test(stage, () => {
      const fixture = deepseekWorkspace();
      let openCalls = 0;
      let statCalls = 0;
      let releases = 0;
      let trips = 0;
      let launches = 0;
      const exits = [];
      const lane = {
        acquire: () => Object.freeze({ id: "lease" }),
        release: () => { releases += 1; return true; },
        trip: () => { trips += 1; },
      };
      const runner = createChatRunner({
        profiles: {},
        agentLaneArbiter: lane,
        launchContained: () => { throw new Error("must not launch"); },
        launchSetuidBwrapContained: () => { launches += 1; throw new Error("must not launch"); },
        agentHome: fixture.home,
        relaySocketStat: () => ({ isSocket: () => true }),
        relayCapability: () => ({
          socketPath: "/run/agenthost-dsh/test-capability.sock",
          relayToken: "d".repeat(64),
        }),
        rootEnv: { AGENTHOST_FOUNDATION_B: "1" },
        openSource: (source, flags) => {
          openCalls += 1;
          if (stage === "open" && openCalls === 2) throw Object.assign(new Error("denied"), { code: "EACCES" });
          return fs.openSync(source, flags);
        },
        statSource: (fd) => {
          statCalls += 1;
          if (stage === "stat" && statCalls === 3) throw Object.assign(new Error("bad fd"), { code: "EBADF" });
          return fs.fstatSync(fd);
        },
        onExit: (_id, info) => exits.push(info),
      });

      const result = runner.runAutonomous({
        runId: `run_dsh_pin_${stage}`,
        engineId: "deepseek",
        prompt: "make the change",
        worktree: fixture.worktree,
      });
      assert.equal(result.accepted, false);
      assert.equal(launches, 0);
      assert.equal(releases, 1);
      assert.equal(trips, 0);
      assert.match(exits[0].error, new RegExp(`dsh_worktree_pin_${stage}_failed`));
    });
  }
});

test("an unproven jail emits the real launcher cause but no terminal frame", async () => {
  const fixture = deepseekWorkspace();
  const outputs = [];
  const exits = [];
  let trips = 0;
  const failure = new Error("dsh_namespace_init_not_observed");
  failure.terminationUnproven = true;
  failure.containmentHandle = { child: fakeChild(8400) };
  failure.launcherFailureCause = () => "bwrap: creating namespace failed: operation not permitted";
  const runner = createChatRunner({
    profiles: {},
    agentLaneArbiter: {
      acquire: () => Object.freeze({ id: "lease" }),
      release: () => true,
      trip: () => { trips += 1; },
    },
    launchContained: () => { throw new Error("must not launch"); },
    launchSetuidBwrapContained: () => { throw failure; },
    agentHome: fixture.home,
    relaySocketStat: () => ({ isSocket: () => true }),
    relayCapability: () => ({
      socketPath: "/run/agenthost-dsh/test-capability.sock",
      relayToken: "e".repeat(64),
    }),
    rootEnv: { AGENTHOST_FOUNDATION_B: "1" },
    onOutput: (_id, stream, text) => outputs.push({ stream, text }),
    onExit: (_id, info) => exits.push(info),
  });

  const result = runner.runAutonomous({
    runId: "run_dsh_bwrap_failed",
    engineId: "deepseek",
    prompt: "make the change",
    worktree: fixture.worktree,
  });
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(result.accepted, false);
  assert.equal(trips, 1);
  assert.equal(exits.length, 0, "an unproven namespace must not forge a terminal exit");
  assert.match(outputs[0].text, /dsh_namespace_init_not_observed: bwrap: creating namespace failed/);
});
