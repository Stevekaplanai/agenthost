// Phase 1f Step 4d: the activation entry's pure helpers. The run loop itself is
// exercised only on the box (scripts/maintenance-boot-verify.sh); here we cover
// the deterministic pieces: the REPOS→repoId mapping and the §8→worker-runtime
// profile adaptation.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import entryMod from "../container/maintenance-boot-entry.js";

const {
  repoIds,
  toRuntimeProfiles,
  agentStackSpawnArgs,
  gateSpawnArgs,
  waitForStackReady,
  createMemoryPressureShutdown,
  createPlatformSignalShutdown,
  installPlatformSignalHandlers,
} = entryMod;

test("repoIds maps REPOS to deterministic compiled repo ids", () => {
  const prev = process.env.REPOS;
  try {
    process.env.REPOS = "steve/agenthost, steve/agenthost-internal";
    const ids = repoIds();
    assert.equal(ids.length, 2);
    for (const id of ids) assert.match(id, /^repo_[0-9a-f]{32}$/);
    // deterministic
    const expected = "repo_" + crypto.createHash("sha256").update("steve/agenthost").digest("hex").slice(0, 32);
    assert.equal(ids[0], expected);
    // stable across calls
    assert.deepEqual(repoIds(), ids);
  } finally { if (prev === undefined) delete process.env.REPOS; else process.env.REPOS = prev; }
});

test("repoIds ignores blanks / whitespace", () => {
  const prev = process.env.REPOS;
  try {
    process.env.REPOS = " a/b ,, c/d ,";
    assert.equal(repoIds().length, 2);
  } finally { if (prev === undefined) delete process.env.REPOS; else process.env.REPOS = prev; }
});

test("toRuntimeProfiles adapts §8 compiled profiles to the worker-runtime shape", () => {
  const catalog = [{
    id: "board_claude", engine: "claude", argvTemplate: ["claude", "-p", "{objective}"],
    uid: 10001, gid: 10001, workspace: "workspaces/board",
  }];
  const rt = toRuntimeProfiles(catalog);
  assert.deepEqual(Object.keys(rt), ["board_claude"]);
  assert.deepEqual(rt.board_claude.argv, ["claude", "-p", "{objective}"]);
  assert.equal(rt.board_claude.uid, 10001);
  assert.equal(rt.board_claude.gid, 10001);
  assert.equal(typeof rt.board_claude.worktreeBase, "string");
  assert.ok(rt.board_claude.worktreeSizeMb > 0);
});

// --- the identity split (activation topology): the setpriv flags ARE the
// security property, so pin them exactly. ---

test("the agent stack spawns as agent with no_new_privs, running start.sh", () => {
  const args = agentStackSpawnArgs();
  assert.deepEqual(args.slice(0, 4), ["--reuid=agent", "--regid=agent", "--init-groups", "--no-new-privs"]);
  assert.equal(args[4], "/bin/bash");
  assert.equal(args[5], "-p");
  assert.match(args[6].replaceAll("\\", "/"), /\/start\.sh$/);
});

test("the gate child disables SIGUSR1 inspector activation before running as the gate uid", () => {
  const args = gateSpawnArgs();
  assert.deepEqual(args.slice(0, 4), ["--reuid=gate", "--regid=gate", "--init-groups", "--no-new-privs"]);
  assert.equal(args[4], "/usr/local/bin/node");
  assert.equal(args[5], "--disable-sigusr1");
  assert.match(args[6].replaceAll("\\", "/"), /\/gate\.js$/);
  const start = fs.readFileSync(new URL("../container/start.sh", import.meta.url), "utf8");
  assert.match(start, /unset NODE_OPTIONS NODE_PATH NODE_INSPECT_RESUME_ON_START LD_PRELOAD LD_LIBRARY_PATH/,
    "the direct gate launch strips inspector and loader hooks");
  assert.match(start, /node --disable-sigusr1 \/opt\/agenthost\/gate\.js/,
    "the tokenless non-Foundation path disables the inspector too (runs inside a restart loop, not exec)");
});

test("root boot uses the absolute trusted setpriv binary for both uid drops", () => {
  const source = fs.readFileSync(new URL("../container/maintenance-boot-entry.js", import.meta.url), "utf8");
  const launches = source.match(/cp\.spawn\("\/usr\/bin\/setpriv"/g) || [];
  assert.equal(launches.length, 2,
    "a hostile inherited PATH must not replace setpriv before the gate receives its token");
});

test("waitForStackReady resolves once the marker appears", async () => {
  let checks = 0;
  const fsMod = { existsSync: () => (checks += 1) >= 3 };
  const ok = await waitForStackReady({ markerPath: "/x/ready", fsMod, delay: () => Promise.resolve(), pollMs: 1 });
  assert.equal(ok, true);
  assert.equal(checks, 3);
});

test("waitForStackReady fails closed on timeout (never boots the gate against a half-prepared stack)", async () => {
  let t = 0;
  const fsMod = { existsSync: () => false };
  await assert.rejects(
    () => waitForStackReady({ markerPath: "/x/ready", fsMod, delay: () => Promise.resolve(), now: () => (t += 400_000), timeoutMs: 600_000 }),
    /never became ready/,
  );
});

// --- gate env prep across the identity split (checklist item 2) ---

test("gateEnv sets HOME to the agent data home and derives AGENTHOST_BRAND from LEGAL_MODE", () => {
  const prevLegal = process.env.LEGAL_MODE, prevBrand = process.env.AGENTHOST_BRAND;
  try {
    delete process.env.AGENTHOST_BRAND;
    process.env.LEGAL_MODE = "attorney-review";
    const env = entryMod.gateEnv();
    assert.match(env.HOME, /\/data\/home\/agent$/);
    assert.equal(env.USER, "gate", "setpriv does not rewrite env: the gate must announce its own identity, not root's");
    assert.equal(env.LOGNAME, "gate");
    assert.equal(env.HERMES_HOME, "/data/home/agent/.hermes",
      "pinned to the data volume so no inherited value can send hermes to /root/.hermes");
    assert.equal(env.AGENTHOST_BRAND, "legal"); // mirrors start.sh's brand keying
    delete process.env.LEGAL_MODE;
    assert.equal(entryMod.gateEnv().AGENTHOST_BRAND, undefined); // no LEGAL_MODE -> no brand
  } finally {
    if (prevLegal === undefined) delete process.env.LEGAL_MODE; else process.env.LEGAL_MODE = prevLegal;
    if (prevBrand === undefined) delete process.env.AGENTHOST_BRAND; else process.env.AGENTHOST_BRAND = prevBrand;
  }
});

test("Foundation gateEnv pins authentication state to the protected root-owned tree", () => {
  const previous = process.env.AGENTHOST_AUTH_STATE_DIR;
  try {
    process.env.AGENTHOST_AUTH_STATE_DIR = "/data/home/agent/.claude/agenthost";
    assert.equal(
      entryMod.gateEnv().AGENTHOST_AUTH_STATE_DIR,
      "/data/agenthost-gate-state/auth",
      "the gate must not fall back to or inherit the legacy agent-owned auth directory",
    );
  } finally {
    if (previous === undefined) delete process.env.AGENTHOST_AUTH_STATE_DIR;
    else process.env.AGENTHOST_AUTH_STATE_DIR = previous;
  }
});

// The Git ladder's whole claim ("level 3 commits, it cannot push") rests on this
// one asymmetry: the push-capable credential reaches the gate child and NOT the
// agent stack. Every interactive lane -- tmux, chat, cron, channel replies -- runs
// inside that stack at the agent uid, so a token present here is a token they can
// read. The agent KEEPS GITHUB_TOKEN on purpose (gh / GitHub MCP / clone).
// setpriv changes the uid but does not rewrite the environment, so the agent
// stack inherits root's USER/LOGNAME unless they are overridden here. When it
// does, every tool that resolves a config dir from USER -- or getpwnam($USER) --
// resolves to /root (drwx------ root root) and dies. On 2026-08-01 that took out
// codex (/root/.codex/config.toml, exit 1), claude's Bash tool
// (/root/.claude/session-env/), cursor and hermes -- while HOME was already
// correct the whole time. Identity is three variables, not one.
test("the agent stack announces itself as agent, not root", () => {
  const prevUser = process.env.USER, prevLog = process.env.LOGNAME, prevKey = process.env.TTYD_PASSWORD;
  try {
    process.env.USER = "root";
    process.env.LOGNAME = "root";
    process.env.TTYD_PASSWORD = "operator-login-secret-must-not-reach-agent";
    const agent = entryMod.agentStackEnv();
    assert.equal(agent.HOME, "/data/home/agent", "HOME must be the agent data home");
    assert.equal(agent.USER, "agent",
      "USER must be corrected: tools resolve config dirs from it, not only HOME");
    assert.equal(agent.LOGNAME, "agent",
      "LOGNAME must be corrected for the same reason as USER");
    assert.equal(agent.TTYD_PASSWORD, undefined,
      "the interactive agent stack must not inherit the operator login credential");
    assert.equal(entryMod.gateEnv().TTYD_PASSWORD, "operator-login-secret-must-not-reach-agent",
      "the separate gate process still needs the operator credential to verify login requests");
  } finally {
    if (prevUser === undefined) delete process.env.USER; else process.env.USER = prevUser;
    if (prevLog === undefined) delete process.env.LOGNAME; else process.env.LOGNAME = prevLog;
    if (prevKey === undefined) delete process.env.TTYD_PASSWORD; else process.env.TTYD_PASSWORD = prevKey;
  }
});

test("root finishes its shared-state migration before the agent starts and never opens the agent audit path", () => {
  const source = fs.readFileSync(new URL("../container/maintenance-boot-entry.js", import.meta.url), "utf8");
  const migrateAt = source.indexOf("migrateGateState({ home: DATA_HOME");
  const spawnAt = source.indexOf("const stack = spawnAgentStack()");
  assert.ok(migrateAt > 0 && spawnAt > migrateAt,
    "the root migration must finish before an agent process can race its path walk");
  assert.doesNotMatch(source, /openSync\([^\n]*audit\.log|appendFileSync\([^\n]*audit\.log/,
    "root records lane events to stderr, never through an agent-replaceable path");

  const start = fs.readFileSync(new URL("../container/start.sh", import.meta.url), "utf8");
  const agentMigrateAt = start.indexOf("migrateGateState({ home: process.env.HOME");
  const readyAt = start.indexOf(': > "$HOME/.agenthost/stack-ready"');
  assert.ok(agentMigrateAt > 0 && readyAt > agentMigrateAt,
    "boot readiness is not published until the unprivileged post-write migration succeeds");
});

// Regressing this silently turns a governed write rung back into a decoration.
// See gate.js gitHubToken() and docs/git-ladder/A2-FD3-REDTEAM-FAIL-2026-08-01.md.
test("the push credential reaches the gate but never the agent stack", () => {
  const prevPush = process.env.GIT_PUSH_TOKEN, prevHub = process.env.GITHUB_TOKEN;
  const prevAliasPresent = process.env.gate_push_token_present;
  const prevAliasValue = process.env.gate_push_token_value;
  try {
    process.env.GIT_PUSH_TOKEN = "FAKE-PUSH-TOKEN-DO-NOT-USE";
    process.env.GITHUB_TOKEN = "FAKE-AGENT-TOKEN-DO-NOT-USE";
    process.env.gate_push_token_present = "1";
    process.env.gate_push_token_value = "FAKE-PUSH-TOKEN-DO-NOT-USE";

    const agent = entryMod.agentStackEnv();
    assert.equal(agent.GIT_PUSH_TOKEN, undefined,
      "the agent stack must never carry the gate's push credential");
    assert.equal(agent.GITHUB_TOKEN, "FAKE-AGENT-TOKEN-DO-NOT-USE",
      "the agent still needs its own GitHub token for gh, the MCP, and cloning");
    assert.equal(agent.AGENTHOST_SKIP_GATE, "1");

    const gate = entryMod.gateEnv({ pushToken: "FAKE-PUSH-TOKEN-DO-NOT-USE" });
    assert.equal(gate.GIT_PUSH_TOKEN, "FAKE-PUSH-TOKEN-DO-NOT-USE",
      "the gate is the one process that may hold the push credential");

    // No value-level leak either: the push token must not appear under any other
    // name in the agent env (an alias would defeat the delete just as completely).
    assert.equal(
      Object.entries(agent).filter(([, v]) => v === "FAKE-PUSH-TOKEN-DO-NOT-USE").length, 0,
      "the push token must not survive in the agent env under any key",
    );
  } finally {
    if (prevPush === undefined) delete process.env.GIT_PUSH_TOKEN; else process.env.GIT_PUSH_TOKEN = prevPush;
    if (prevHub === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = prevHub;
    if (prevAliasPresent === undefined) delete process.env.gate_push_token_present;
    else process.env.gate_push_token_present = prevAliasPresent;
    if (prevAliasValue === undefined) delete process.env.gate_push_token_value;
    else process.env.gate_push_token_value = prevAliasValue;
  }
});

test("root boot captures and removes the push credential before any child can inherit it", () => {
  const env = {
    GIT_PUSH_TOKEN: "FAKE-PUSH-TOKEN-DO-NOT-USE",
    SAFE_BOOT_VALUE: "kept",
  };
  const captured = entryMod.captureGatePushToken(env);
  assert.equal(captured, "FAKE-PUSH-TOKEN-DO-NOT-USE");
  assert.equal(env.GIT_PUSH_TOKEN, undefined);
  assert.equal(env.SAFE_BOOT_VALUE, "kept");
});

test("gateEnv inherits the root latch only for quarantined replacement gates", () => {
  const prev = process.env.AGENTHOST_AGENT_LANE_QUARANTINED;
  try {
    process.env.AGENTHOST_AGENT_LANE_QUARANTINED = "stale";
    assert.equal(entryMod.gateEnv().AGENTHOST_AGENT_LANE_QUARANTINED, undefined,
      "a full boot starts with a clear in-memory latch even if the parent env is stale");
    assert.equal(entryMod.gateEnv({ agentLaneQuarantined: true }).AGENTHOST_AGENT_LANE_QUARANTINED, "1");
  } finally {
    if (prev === undefined) delete process.env.AGENTHOST_AGENT_LANE_QUARANTINED;
    else process.env.AGENTHOST_AGENT_LANE_QUARANTINED = prev;
  }
});

test("gateEnv strips inspector and loader hooks before Node starts", () => {
  const names = [
    "NODE_OPTIONS", "NODE_PATH", "NODE_INSPECT_RESUME_ON_START", "NODE_DEBUG", "NODE_DEBUG_NATIVE",
    "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT", "LD_ARBITRARY_FUTURE_CONTROL",
    "GLIBC_TUNABLES", "GCONV_PATH", "LOCPATH", "OPENSSL_CONF", "OPENSSL_MODULES", "OPENSSL_CONF_INCLUDE",
    "BASH_ENV", "ENV", "PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP", "PYTHONINSPECT",
  ];
  const before = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) process.env[name] = "attacker-controlled";
    process.env.GIT_PUSH_TOKEN = "fake-required-write-token";
    const env = entryMod.gateEnv({ pushToken: "fake-required-write-token" });
    for (const name of names) assert.equal(env[name], undefined, `${name} must not reach gate Node`);
    assert.equal(env.GIT_PUSH_TOKEN, "fake-required-write-token");
  } finally {
    for (const name of names) {
      if (before[name] === undefined) delete process.env[name];
      else process.env[name] = before[name];
    }
    delete process.env.GIT_PUSH_TOKEN;
  }
});

test("memory pressure stops replacement before forwarding SIGUSR2 and exits 1 after the gate exits", () => {
  const events = [];
  const exits = [];
  const timers = [];
  const gate = new EventEmitter();
  gate.exitCode = null;
  gate.signalCode = null;
  gate.kill = (signal) => { events.push(["gate.kill", signal]); return true; };
  const shutdown = createMemoryPressureShutdown({
    runner: { stop: () => events.push(["runner.stop"]) },
    getGateChild: () => gate,
    exit: (code) => exits.push(code),
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { timer.cleared = true; },
  });

  shutdown();
  assert.deepEqual(events, [["runner.stop"], ["gate.kill", "SIGUSR2"]],
    "replacement is disabled before the checkpoint signal reaches the active gate");
  assert.equal(timers[0].ms, 3000);
  assert.deepEqual(exits, [], "the root wrapper waits for the gate checkpoint");

  gate.exitCode = 1;
  gate.emit("exit", 1, null);
  assert.deepEqual(exits, [1]);
  assert.equal(timers[0].cleared, true);

  shutdown();
  assert.deepEqual(exits, [1], "duplicate memory-pressure signals are idempotent");
});

test("memory pressure exits 1 after the three-second fallback if the gate does not exit", () => {
  const exits = [];
  const timers = [];
  const gate = new EventEmitter();
  gate.exitCode = null;
  gate.signalCode = null;
  gate.kill = () => true;
  const shutdown = createMemoryPressureShutdown({
    runner: { stop: () => {} },
    getGateChild: () => gate,
    exit: (code) => exits.push(code),
    setTimer: (fn, ms) => {
      const timer = { fn, ms };
      timers.push(timer);
      return timer;
    },
    clearTimer: () => {},
  });

  shutdown();
  assert.equal(timers[0].ms, 3000);
  assert.deepEqual(exits, []);
  timers[0].fn();
  assert.deepEqual(exits, [1]);
});

test("platform shutdown stops replacement before forwarding Fly's signal and waits for gate terminal proof", () => {
  const events = [];
  const exits = [];
  const failures = [];
  const timers = [];
  const gate = new EventEmitter();
  gate.exitCode = null;
  gate.signalCode = null;
  gate.kill = (signal) => { events.push(["gate.kill", signal]); return true; };
  const shutdown = createPlatformSignalShutdown({
    runner: { stop: () => events.push(["runner.stop"]) },
    getGateChild: () => gate,
    exit: (code) => exits.push(code),
    writeFailure: (message) => failures.push(message),
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { timer.cleared = true; },
  });

  shutdown("SIGTERM");
  assert.deepEqual(events, [["runner.stop"], ["gate.kill", "SIGTERM"]],
    "root admission/replacement stops before the exact platform signal reaches gate");
  assert.equal(timers[0].ms, 25_000);
  assert.deepEqual(exits, [], "root waits for gate child-exit proof");
  assert.deepEqual(failures, []);

  gate.exitCode = 0;
  gate.emit("exit", 0, null);
  assert.deepEqual(exits, [0]);
  assert.equal(timers[0].cleared, true);

  shutdown("SIGINT");
  assert.deepEqual(events, [["runner.stop"], ["gate.kill", "SIGTERM"]],
    "a second platform signal cannot start a second drain");
  assert.deepEqual(exits, [0]);
});

test("platform shutdown names a bounded terminal-proof timeout and exits nonzero", () => {
  const exits = [];
  const failures = [];
  const timers = [];
  const gate = new EventEmitter();
  gate.exitCode = null;
  gate.signalCode = null;
  gate.kill = () => true;
  const shutdown = createPlatformSignalShutdown({
    runner: { stop: () => {} },
    getGateChild: () => gate,
    exit: (code) => exits.push(code),
    writeFailure: (message) => failures.push(message),
    setTimer: (fn, ms) => {
      const timer = { fn, ms, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer: () => {},
  });

  shutdown("SIGINT");
  timers[0].fn();

  assert.deepEqual(exits, [1]);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /^\[maint\] FATAL platform SIGINT shutdown failed: gate terminal proof timed out after 25000ms\n$/);
  assert.ok(failures[0].length < 160, "the supervisor error stays bounded");
});

test("platform shutdown reports a gate that terminates before its graceful checkpoint", () => {
  const exits = [];
  const failures = [];
  const gate = new EventEmitter();
  gate.exitCode = null;
  gate.signalCode = null;
  gate.kill = () => true;
  const shutdown = createPlatformSignalShutdown({
    runner: { stop() {} },
    getGateChild: () => gate,
    exit: (code) => exits.push(code),
    writeFailure: (message) => failures.push(message),
    setTimer: () => ({ unref() {} }),
    clearTimer() {},
  });

  shutdown("SIGTERM");
  gate.signalCode = "SIGKILL";
  gate.emit("exit", null, "SIGKILL");

  assert.deepEqual(exits, [1]);
  assert.match(failures[0], /gate exited from SIGKILL before graceful checkpoint proof/);
});

test("platform shutdown preserves a nonzero gate exit observed during signal forwarding", () => {
  const exits = [];
  const failures = [];
  const gate = new EventEmitter();
  gate.exitCode = null;
  gate.signalCode = null;
  gate.kill = () => { gate.exitCode = 73; return false; };
  createPlatformSignalShutdown({
    runner: { stop() {} },
    getGateChild: () => gate,
    exit: (code) => exits.push(code),
    writeFailure: (message) => failures.push(message),
    setTimer: () => ({ unref() {} }),
    clearTimer() {},
  })("SIGTERM");

  assert.deepEqual(exits, [1]);
  assert.match(failures[0], /gate exited with status 73 before graceful checkpoint proof/);
});

test("platform signal listeners stay installed and share one drain across repeated signals", () => {
  const target = new EventEmitter();
  const signals = [];
  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    signals.push(signal);
  };
  installPlatformSignalHandlers(target, shutdown);

  target.emit("SIGTERM");
  target.emit("SIGTERM");
  target.emit("SIGINT");
  assert.deepEqual(signals, ["SIGTERM"], "later same or alternate signals join the first bounded drain");
  assert.equal(target.listenerCount("SIGTERM"), 1);
  assert.equal(target.listenerCount("SIGINT"), 1);
});

test("platform shutdown and Fly config wire a 30-second SIGTERM drain window", () => {
  const source = fs.readFileSync(new URL("../container/maintenance-boot-entry.js", import.meta.url), "utf8");
  assert.match(source, /installPlatformSignalHandlers\(process, platformSignalShutdown\)/);
  assert.match(source, /target\.on\("SIGTERM", onSigterm\)/);
  assert.match(source, /target\.on\("SIGINT", onSigint\)/);
  assert.doesNotMatch(source, /removeListener\("SIGTERM"|removeListener\("SIGINT"/,
    "a second platform signal remains intercepted while runner.run has already resolved");

  const fly = fs.readFileSync(new URL("../container/fly.toml", import.meta.url), "utf8");
  assert.match(fly, /^kill_signal = "SIGTERM"$/m);
  assert.match(fly, /^kill_timeout = 30$/m);
  const firstTable = fly.search(/^\[/m);
  assert.ok(fly.indexOf('kill_signal = "SIGTERM"') < firstTable, "kill_signal must be top-level Fly config");
  assert.ok(fly.indexOf("kill_timeout = 30") < firstTable, "kill_timeout must be top-level Fly config");
});

test("root chat injects the existing controlled-shutdown path for fatal Git containment", () => {
  const source = fs.readFileSync(new URL("../container/maintenance-boot-entry.js", import.meta.url), "utf8");
  assert.match(source, /fatalContainment:\s*memoryPressureShutdown/,
    "the fixed gate frame must checkpoint the gate and make Fly restart the machine");
});
