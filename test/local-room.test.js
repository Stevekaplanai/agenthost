import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  AGENT_IDS,
  assertLifecycleAdapter,
  buildEngineRunArgs,
  callLifecycle,
  cleanupOwnedRoomOnMainFailure,
  createAgentGlassTurnTelemetry,
  createEmergencyStopControl,
  createLeaseKeeper,
  engineEnvironment,
  engineSpecs,
  isSafeRoomStatePath,
  parseArgs,
  parseCodexResult,
  parseKimiResult,
  prepareRoomControlDirectory,
  probeEngineCapabilities,
  readControllerInputFromStdin,
  redactSecrets,
  roomEnvironment,
  roomPrompt,
  stopAll,
  systemdControlEnvironment,
} from "../scripts/local-room.mjs";

test("the room has exactly four fixed agents", () => {
  assert.deepEqual(AGENT_IDS, ["claude", "codex", "hermes", "kimi"]);
  assert.throws(
    () => parseArgs(["--objective", "x", "--agents", "claude"]),
    /unknown option/i,
  );
});

test("the exclusive controller lock is acquired before adapters or worktrees", () => {
  const source = fs.readFileSync(
    path.resolve(import.meta.dirname, "../scripts/local-room.mjs"),
    "utf8",
  );
  const canonicalHost = source.indexOf(
    "const hostStateDir = prepareCanonicalRoomHostStateDirectory({ repoRoot })",
  );
  const hostLock = source.indexOf('lockFileName: "active-room.lock"');
  const roomLock = source.indexOf("await acquireRoomControllerLock({ stateDir })", hostLock);
  const guardedPreflight = source.indexOf("capabilities = roomStartupPreflight", roomLock);
  const quarantineBinding = source.indexOf(
    "activeQuarantine = bindActiveRoomQuarantine",
    guardedPreflight,
  );
  const providerProbe = source.indexOf(
    "capabilities = probeEngineCapabilities",
    quarantineBinding,
  );
  assert.ok(canonicalHost > 0);
  assert.ok(hostLock > 0);
  assert.ok(canonicalHost < hostLock);
  assert.match(
    source.slice(
      source.lastIndexOf("await acquireRoomControllerLock", hostLock),
      hostLock,
    ),
    /stateDir: hostStateDir/,
  );
  assert.ok(roomLock > hostLock);
  assert.ok(guardedPreflight > roomLock);
  assert.ok(roomLock < source.indexOf("await loadLifecycleAdapter", roomLock));
  assert.ok(roomLock < source.indexOf("reattachAgentWorktrees", roomLock));
  assert.ok(guardedPreflight < source.indexOf("await loadLifecycleAdapter", roomLock));
  assert.match(source.slice(guardedPreflight, quarantineBinding), /probeProviders: false/);
  assert.ok(quarantineBinding > source.indexOf("onClaimRequest", guardedPreflight));
  assert.ok(providerProbe > quarantineBinding);
  const lossGuard = source.indexOf(
    "if (hostControllerLock.signal.aborted || controllerLock.signal.aborted)",
    roomLock,
  );
  assert.ok(lossGuard > roomLock);
  assert.ok(lossGuard < source.indexOf("await loadLifecycleAdapter", roomLock));
  assert.ok(source.indexOf("assertControllerLocksHeld();", lossGuard) > lossGuard);
  assert.match(
    source.slice(roomLock, guardedPreflight),
    /hostControllerLock\.signal\.addEventListener[\s\S]*?controllerLock\.signal\.addEventListener[\s\S]*?assertControllerLocksHeld\(\);/,
  );
  const outerFailureCleanup = source.indexOf(
    "outerSurvivors = await stopAll(roomId)",
    guardedPreflight,
  );
  assert.ok(outerFailureCleanup > guardedPreflight);
  assert.ok(outerFailureCleanup < source.indexOf("await controllerLock.release()", roomLock));
  assert.ok(source.indexOf("await controllerLock.release()", roomLock) > roomLock);
  assert.ok(source.indexOf("await hostControllerLock.release()", roomLock) > roomLock);
});

test("a rejected duplicate controller cannot stop the room it failed to own", async () => {
  let stopCalls = 0;
  const stop = async () => {
    stopCalls += 1;
    return [1234];
  };
  assert.deepEqual(await cleanupOwnedRoomOnMainFailure({
    ownsRoom: false,
    roomId: "room-owned-by-another-controller",
    stop,
  }), []);
  assert.equal(stopCalls, 0);
  assert.deepEqual(await cleanupOwnedRoomOnMainFailure({
    ownsRoom: true,
    roomId: "room-owned-by-this-controller",
    stop,
  }), [1234]);
  assert.equal(stopCalls, 1);
});

test("room cleanup returns survivor proof after TERM and KILL attempts", async () => {
  const calls = [];
  const survivors = await stopAll("room-survivor-proof", {
    signalProcessGroups(signal) { calls.push(["groups", signal]); },
    signalUnits(signal) { calls.push(["units", signal]); },
    signalMarked(roomId, signal) { calls.push(["marked", roomId, signal]); },
    listMarked(roomId) {
      calls.push(["survivors", roomId]);
      return [4321];
    },
    snapshotProcessGroups() {
      calls.push(["snapshot-groups"]);
      return [111];
    },
    snapshotUnits() {
      calls.push(["snapshot-units"]);
      return [["agenthost-room.scope", { PATH: "/usr/bin" }]];
    },
    processGroupIsAlive(pid) {
      calls.push(["group-alive", pid]);
      return true;
    },
    unitIsActive(unitName) {
      calls.push(["unit-active", unitName]);
      return true;
    },
    clearTracked(proof) {
      calls.push([
        "clear",
        proof.survivingProcessGroups.length,
        proof.survivingUnits.length,
      ]);
    },
    async wait(timeoutMs) { calls.push(["wait", timeoutMs]); },
  });
  assert.deepEqual(survivors, [
    { kind: "process_group", id: 111 },
    { kind: "systemd_unit", id: "agenthost-room.scope" },
    { kind: "marked_pid", id: 4321 },
  ]);
  assert.deepEqual(calls, [
    ["snapshot-groups"],
    ["snapshot-units"],
    ["groups", "SIGTERM"],
    ["units", "SIGTERM"],
    ["marked", "room-survivor-proof", "SIGTERM"],
    ["wait", 800],
    ["groups", "SIGKILL"],
    ["units", "SIGKILL"],
    ["marked", "room-survivor-proof", "SIGKILL"],
    ["wait", 100],
    ["group-alive", 111],
    ["unit-active", "agenthost-room.scope"],
    ["survivors", "room-survivor-proof"],
    ["clear", 1, 1],
  ]);
});

test("a turn keeps failed cgroup cleanup tracked for the final stop proof", () => {
  const source = fs.readFileSync(
    path.resolve(import.meta.dirname, "../scripts/local-room.mjs"),
    "utf8",
  );
  assert.match(source, /if \(unitClean\) activeUnits\.delete\(unitName\)/);
  assert.match(source, /if \(groupClean && child\.pid\) processGroups\.delete\(child\.pid\)/);
});

test("room state is a dashboard-discoverable direct child of its state root", () => {
  const stateRoot = path.resolve(os.tmpdir(), "agenthost-room-path-contract");
  assert.equal(
    isSafeRoomStatePath(path.join(stateRoot, "agenthost-room-valid_1.2"), stateRoot),
    true,
  );
  for (const candidate of [
    stateRoot,
    path.join(stateRoot, "nested", "agenthost-room-valid"),
    path.join(stateRoot, "AgentHost-room-uppercase"),
    path.join(stateRoot, "agenthost room spaced"),
    path.resolve(stateRoot, "..", "agenthost-room-outside"),
  ]) {
    assert.equal(isSafeRoomStatePath(candidate, stateRoot), false, candidate);
  }
});

test("dashboard control state resolves outside the repository", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-control-root-"));
  const repoRoot = path.join(root, "repo");
  const controlRoot = path.join(root, "control");
  fs.mkdirSync(repoRoot);
  const trusted = prepareRoomControlDirectory({
    repoRoot,
    controlRoot,
    roomId: "room-safe-control",
  });
  assert.equal(trusted.controlRoot, fs.realpathSync(controlRoot));
  assert.equal(
    trusted.controlDir,
    fs.realpathSync(path.join(controlRoot, "agenthost-room-room-safe-control")),
  );
});

test("dashboard control state rejects a symlink into the repository", {
  skip: process.platform === "win32",
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-control-link-"));
  const repoRoot = path.join(root, "repo");
  const controlRoot = path.join(root, "control-link");
  fs.mkdirSync(repoRoot);
  fs.symlinkSync(repoRoot, controlRoot, "dir");
  assert.throws(
    () => prepareRoomControlDirectory({
      repoRoot,
      controlRoot,
      roomId: "room-unsafe-control",
    }),
    /not trusted|separate from the source repository/i,
  );
});

test("an explicit room state path is restart-only before controller acquisition", () => {
  const source = fs.readFileSync(
    path.resolve(import.meta.dirname, "../scripts/local-room.mjs"),
    "utf8",
  );
  const restartGuard = source.indexOf("if (resumeExisting && !existingSupervisor");
  const lock = source.indexOf("await acquireRoomControllerLock");
  const worktrees = source.indexOf("createAgentWorktrees", lock);
  assert.ok(restartGuard > 0);
  assert.ok(restartGuard < lock);
  assert.ok(restartGuard < worktrees);
  assert.match(
    source.slice(restartGuard, lock),
    /explicit room state cannot reattach without its trusted supervisor record/,
  );
});

test("parseArgs carries the source repository and lifecycle bridge configuration", () => {
  const parsed = parseArgs([
    "--objective", "Build the room",
    "--rounds", "3",
    "--cwd", "/work/repo",
    "--state-root", "/tmp/rooms",
    "--lifecycle-adapter", "/work/adapter.mjs",
    "--lifecycle-url", "https://box.tailnet.ts.net/kanban",
  ]);
  assert.equal(parsed.objective, "Build the room");
  assert.equal(parsed.rounds, 3);
  assert.equal(parsed.cwd, "/work/repo");
  assert.equal(parsed.stateRoot, "/tmp/rooms");
  assert.equal(parsed.lifecycleAdapter, "/work/adapter.mjs");
  assert.equal(parsed.lifecycleUrl, "https://box.tailnet.ts.net/kanban");
});

test("quarantine recovery is explicit and requires an existing room state", () => {
  const parsed = parseArgs([
    "--objective", "Recover the room",
    "--state-dir", "/home/operator/rooms/agenthost-room-existing",
    "--recover-quarantine",
  ]);
  assert.equal(parsed.recoverQuarantine, true);
  assert.throws(
    () => parseArgs(["--objective", "Recover", "--recover-quarantine"]),
    /requires --state-dir/i,
  );
  assert.throws(
    () => parseArgs([
      "--objective", "Recover",
      "--state-dir", "/home/operator/rooms/agenthost-room-existing",
      "--recover-quarantine",
      "--dry-run",
    ]),
    /non-dry room/i,
  );
});

test("parseArgs accepts one through three rounds only", () => {
  for (const rounds of ["0", "4", "1.5", "nan"]) {
    assert.throws(
      () => parseArgs(["--objective", "x", "--rounds", rounds]),
      /whole number from 1 to 3/i,
    );
  }
});

test("lifecycle and provider credentials use one bounded private stdin envelope", async () => {
  const payload = {
    version: 1,
    lifecycleToken: "x".repeat(40),
    providerEnvironment: {
      CLAUDE_CODE_OAUTH_TOKEN: "claude-private",
    },
  };
  const stream = new PassThrough();
  stream.end(`${Buffer.from(JSON.stringify(payload)).toString("base64")}\n`);
  assert.deepEqual(await readControllerInputFromStdin(stream), {
    lifecycleToken: "x".repeat(40),
    providerEnvironment: payload.providerEnvironment,
  });

  const invalid = new PassThrough();
  invalid.end(`${Buffer.from(JSON.stringify({
    ...payload,
    providerEnvironment: { LD_PRELOAD: "/tmp/attack.so" },
  })).toString("base64")}\n`);
  await assert.rejects(readControllerInputFromStdin(invalid), /provider environment/i);

  const ignoredKimiEnvironment = new PassThrough();
  ignoredKimiEnvironment.end(`${Buffer.from(JSON.stringify({
    ...payload,
    providerEnvironment: { KIMI_API_KEY: "not-a-real-kimi-channel" },
  })).toString("base64")}\n`);
  await assert.rejects(
    readControllerInputFromStdin(ignoredKimiEnvironment),
    /provider environment/i,
  );
});

test("engineSpecs assigns a distinct worktree and real CLI adapter to every agent", () => {
  const workspaces = {
    claude: { path: "/rooms/claude", branch: "agenthost-room/r1/claude" },
    codex: { path: "/rooms/codex", branch: "agenthost-room/r1/codex" },
    hermes: { path: "/rooms/hermes", branch: "agenthost-room/r1/hermes" },
    kimi: { path: "/rooms/kimi", branch: "agenthost-room/r1/kimi" },
  };
  const specs = engineSpecs({ workspaces });
  assert.deepEqual(specs.map((spec) => spec.id), AGENT_IDS);
  assert.equal(new Set(specs.map((spec) => spec.cwd)).size, 4);
  assert.deepEqual(specs.map((spec) => spec.cwd), Object.values(workspaces).map((item) => item.path));

  const prompt = "Make one change";
  const byId = Object.fromEntries(specs.map((spec) => [spec.id, spec]));
  assert.ok(byId.claude.args(prompt).includes("--dangerously-skip-permissions"));
  assert.ok(byId.codex.args(prompt).includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.deepEqual(
    byId.codex.args(prompt).slice(byId.codex.args(prompt).indexOf("-C") + 1, byId.codex.args(prompt).indexOf("-C") + 2),
    ["/rooms/codex"],
  );
  assert.ok(byId.hermes.args(prompt).includes("--yolo"));
  assert.deepEqual(byId.kimi.args(prompt), [
    "--prompt", prompt,
    "--output-format", "text",
  ]);
});

test("Kimi adapter returns assistant stdout and no invented usage", () => {
  assert.deepEqual(parseKimiResult("Kimi result\n"), {
    text: "Kimi result",
    telemetry: {
      nativeSessionId: "",
      costUsd: 0,
      costStatus: "unavailable",
      costSource: "unavailable",
      usage: {},
    },
    terminalError: false,
  });
});

test("version probes report availability while authentication remains unknown", () => {
  const workspaces = Object.fromEntries(AGENT_IDS.map((id) => [
    id,
    { path: `/rooms/${id}`, branch: `agenthost-room/r1/${id}` },
  ]));
  const report = probeEngineCapabilities(
    engineSpecs({ workspaces }),
    { PATH: "/bin" },
    (command) => ({ status: 0, stdout: `${command} 1.2.3\n`, stderr: "" }),
  );
  assert.deepEqual(report.map((item) => item.engineId), AGENT_IDS);
  assert.ok(report.every((item) => item.available === true));
  assert.ok(report.every((item) => item.authState === "unknown"));
  assert.ok(report.every((item) => !("readiness" in item)));
  assert.ok(report.every((item) => !("authenticated" in item)));
});

test("AgentGlass receives Kimi lifecycle telemetry without room content", async () => {
  const events = [];
  const telemetry = createAgentGlassTurnTelemetry({
    curlPath: "/mnt/c/Windows/System32/curl.exe",
    roomId: "room-kimi",
    engine: "kimi",
    round: 1,
    kanbanTaskId: "t_room",
    windowsProjectPath: "C:\\repo",
    windowsCwd: "C:\\room\\kimi",
    heartbeatMs: 5,
    post: async (event) => { events.push(event); },
  });
  await telemetry.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await telemetry.end({ exitCode: 0, isError: false });
  assert.equal(events[0].hook_event_type, "SessionStart");
  assert.ok(events.some((event) => event.hook_event_type === "Heartbeat"));
  assert.equal(events.at(-1).hook_event_type, "SessionEnd");
  assert.ok(events.every((event) => /^[0-9a-f-]{36}$/i.test(event.event_id)));
  assert.equal(new Set(events.map((event) => event.event_id)).size, events.length);
  assert.ok(events.every((event) => !("reported_cost_usd" in event)),
    "unknown cost is omitted instead of being falsely reported as zero");
  assert.ok(events.every((event) => !("agenthost_event_id" in event.payload)));
  assert.ok(events.every((event) => !("agenthost_reported_cost_usd" in event.payload)));
  const serialized = JSON.stringify(events).toLowerCase();
  for (const forbidden of ["objective", "prompt", "response", "stdout", "stderr", "secret"]) {
    assert.doesNotMatch(serialized, new RegExp(forbidden));
  }
});

test("AgentGlass receives an authoritative top-level cost when the engine reports one", async () => {
  const events = [];
  const telemetry = createAgentGlassTurnTelemetry({
    curlPath: "/mnt/c/Windows/System32/curl.exe",
    roomId: "room-cost",
    engine: "codex",
    round: 2,
    kanbanTaskId: "t_cost",
    windowsProjectPath: "C:\\repo",
    windowsCwd: "C:\\room\\codex",
    heartbeatMs: 60_000,
    post: async (event) => { events.push(event); },
  });
  await telemetry.start();
  await telemetry.end({
    exitCode: 0,
    isError: false,
    costUsd: 0.012345,
    costStatus: "actual",
    costSource: "codex.reported",
  });
  const ended = events.at(-1);
  assert.equal(ended.hook_event_type, "SessionEnd");
  assert.equal(ended.reported_cost_usd, 0.012345);
  assert.equal(ended.payload.agenthost_cost_status, "actual");
  assert.equal(ended.payload.agenthost_cost_source, "codex.reported");
});

test("AgentGlass retries a final cost with the same opaque event id", async () => {
  const attempts = [];
  let endAttempts = 0;
  const telemetry = createAgentGlassTurnTelemetry({
    curlPath: "/mnt/c/Windows/System32/curl.exe",
    roomId: "room-retry",
    engine: "claude",
    round: 1,
    kanbanTaskId: "t_retry",
    windowsProjectPath: "C:\\repo",
    windowsCwd: "C:\\room\\claude",
    heartbeatMs: 60_000,
    post: async (event) => {
      attempts.push(structuredClone(event));
      if (event.hook_event_type === "SessionEnd" && endAttempts++ === 0) {
        throw new Error("simulated lost acknowledgement");
      }
    },
  });
  await telemetry.start();
  assert.equal(await telemetry.end({
    exitCode: 0,
    isError: false,
    costUsd: 0.25,
    costStatus: "actual",
    costSource: "claude.reported",
  }), true);
  const endings = attempts.filter((event) => event.hook_event_type === "SessionEnd");
  assert.equal(endings.length, 2);
  assert.equal(endings[0].event_id, endings[1].event_id);
  assert.equal(endings[0].reported_cost_usd, endings[1].reported_cost_usd);
});

test("Codex parser keeps only completed agent messages", () => {
  const result = parseCodexResult([
    JSON.stringify({ type: "thread.started", thread_id: "019f915c-528f-7ef2-9ade-fcb633ce3b4e" }),
    JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "private" } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "answer" } }),
  ].join("\n"));
  assert.equal(result.text, "answer");
  assert.equal(result.telemetry.nativeSessionId, "019f915c-528f-7ef2-9ade-fcb633ce3b4e");
});

test("roomPrompt accepts Kimi and names only the controller-owned task", () => {
  const prompt = roomPrompt({
    objective: "Finish the feature",
    round: 1,
    agentId: "kimi",
    transcript: [],
    charter: "Use isolated worktrees.",
    taskId: "t_room",
  });
  assert.match(prompt, /You are the kimi participant/);
  assert.match(prompt, /CONTROLLER-OWNED TASK\s+t_room/);
  assert.doesNotMatch(prompt, /create a second/i);
});

test("child environment contains no lifecycle or board credential", () => {
  const clean = roomEnvironment("room-1", {
    PATH: "/bin",
    HOME: "/home/agent",
    AGENTHOST_KANBAN_LIFECYCLE_TOKEN: "secret",
    AGENTHOST_ROOM_LIFECYCLE_TOKEN: "secret",
    KIMI_API_KEY: "secret",
  });
  assert.equal(clean.PATH, "/bin");
  assert.equal(clean.HOME, "/home/agent");
  assert.equal(clean.AGENTHOST_ROOM_ID, "room-1");
  assert.equal(clean.AGENTHOST_KANBAN_LIFECYCLE_TOKEN, undefined);
  assert.equal(clean.AGENTHOST_ROOM_LIFECYCLE_TOKEN, undefined);
  assert.equal(clean.KIMI_API_KEY, undefined);
});

test("provider credentials are scoped to their matching engine only", () => {
  const source = {
    CLAUDE_CODE_OAUTH_TOKEN: "claude-secret",
    KIMI_API_KEY: "ignored-kimi-secret",
    MOONSHOT_API_KEY: "legacy-must-not-pass",
    AGENTHOST_ROOM_LIFECYCLE_TOKEN: "never",
  };
  const base = roomEnvironment("room-1", {
    PATH: "/bin",
    HOME: "/home/agent",
    KIMI_CODE_HOME: "/home/agent/.kimi-code",
    ...source,
  });
  const kimi = engineEnvironment("kimi", base, source);
  const claude = engineEnvironment("claude", base, source);
  const codex = engineEnvironment("codex", base, source);
  assert.equal(kimi.KIMI_CODE_HOME, "/home/agent/.kimi-code");
  assert.equal(kimi.KIMI_API_KEY, undefined);
  assert.equal(kimi.MOONSHOT_API_KEY, undefined);
  assert.equal(kimi.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(claude.CLAUDE_CODE_OAUTH_TOKEN, "claude-secret");
  assert.equal(claude.KIMI_API_KEY, undefined);
  assert.equal(codex.KIMI_API_KEY, undefined);
  assert.ok([kimi, claude, codex].every((env) => env.AGENTHOST_ROOM_LIFECYCLE_TOKEN === undefined));
});

test("engine credentials are inherited by a scope, never serialized into argv", () => {
  const workspaces = Object.fromEntries(AGENT_IDS.map((id) => [
    id,
    { path: `/rooms/${id}`, branch: `agenthost-room/r1/${id}` },
  ]));
  const kimi = engineSpecs({ workspaces }).find((spec) => spec.id === "kimi");
  const args = buildEngineRunArgs(
    kimi,
    "safe prompt",
    "agenthost-room-kimi-abc123.scope",
  );
  assert.ok(args.includes("--scope"));
  assert.ok(args.includes("kimi"));
  assert.ok(!args.includes("/usr/bin/env"));
  assert.doesNotMatch(JSON.stringify(args), /KIMI_API_KEY|MOONSHOT_API_KEY|claude-secret/);
});

test("systemctl helpers receive minimal control metadata, never provider credentials", () => {
  const control = systemdControlEnvironment({
    HOME: "/home/agent",
    USER: "agent",
    LOGNAME: "agent",
    XDG_RUNTIME_DIR: "/run/user/1000",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    PATH: "/private/bin",
    CLAUDE_CODE_OAUTH_TOKEN: "claude-secret",
    ANTHROPIC_API_KEY: "anthropic-secret",
  });
  assert.deepEqual(control, {
    HOME: "/home/agent",
    USER: "agent",
    LOGNAME: "agent",
    XDG_RUNTIME_DIR: "/run/user/1000",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
  });
  const source = fs.readFileSync(new URL("../scripts/local-room.mjs", import.meta.url), "utf8");
  assert.match(source, /activeUnits\.set\(unitName, controlEnv\)/);
  assert.doesNotMatch(source, /activeUnits\.set\(unitName, env\)/);
});

test("secret redaction covers provider credentials and private keys", () => {
  const clean = redactSecrets([
    "Authorization: Bearer abc123",
    "KIMI_API_KEY=sk-this-is-secret",
    "token: \"abcdef123456\"",
    "-----BEGIN PRIVATE KEY-----",
    "secret",
    "-----END PRIVATE KEY-----",
  ].join("\n"));
  assert.doesNotMatch(clean, /abc123|sk-this|abcdef123456|BEGIN PRIVATE KEY/);
});

test("lifecycle adapter requires the renewable ownership methods", () => {
  const valid = Object.fromEntries(
    ["ready", "claim", "heartbeat", "complete", "stop", "recover"]
      .map((name) => [name, async () => ({})]),
  );
  assert.equal(assertLifecycleAdapter(valid), valid);
  for (const missing of Object.keys(valid)) {
    const candidate = { ...valid };
    delete candidate[missing];
    assert.throws(() => assertLifecycleAdapter(candidate), new RegExp(missing, "i"));
  }
});

test("lifecycle calls have deterministic deadlines and react to cancellation", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
  let releaseReady;
  const hanging = {
    ready() {
      return new Promise((resolve) => { releaseReady = resolve; });
    },
  };
  const timed = callLifecycle({
    adapter: hanging,
    method: "ready",
    event: { roomId: "r1", engineId: "claude" },
    timeoutMs: 500,
  });
  await Promise.resolve();
  t.mock.timers.tick(500);
  await assert.rejects(timed, /timed out/i);
  releaseReady(true);

  const controller = new AbortController();
  const cancelled = callLifecycle({
    adapter: { ready: () => new Promise(() => {}) },
    method: "ready",
    event: { roomId: "r1", engineId: "codex" },
    signal: controller.signal,
    timeoutMs: 500,
  });
  controller.abort();
  await assert.rejects(cancelled, /cancelled/i);
});

test("lifecycle timeout aborts the adapter before its simulated remote side effect", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 50_000 });
  let sideEffect = false;
  let abortSeen = false;
  const call = callLifecycle({
    adapter: {
      ready(_event, { signal, deadlineAt }) {
        assert.equal(deadlineAt, 50_100);
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            sideEffect = true;
            resolve(true);
          }, 1_000);
          signal.addEventListener("abort", () => {
            abortSeen = true;
            clearTimeout(timer);
            reject(new Error("adapter request aborted"));
          }, { once: true });
        });
      },
    },
    method: "ready",
    event: { roomId: "r1", engineId: "claude" },
    timeoutMs: 100,
  });
  await Promise.resolve();
  t.mock.timers.tick(100);
  await assert.rejects(call, /timed out/i);
  assert.equal(abortSeen, true);
  t.mock.timers.tick(1_000);
  assert.equal(sideEffect, false);
});

test("lease keeper renews metadata-only ownership and stops on failure", async () => {
  const calls = [];
  const adapter = {
    async heartbeat(event) {
      calls.push(event);
      return { leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() };
    },
  };
  const keeper = createLeaseKeeper({
    adapter,
    claim: { taskId: "t1", claimId: "c1", leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() },
    context: { roomId: "r1", engineId: "kimi", round: 2, phase: "running" },
    intervalMs: 10,
  });
  await keeper.start();
  await new Promise((resolve) => setTimeout(resolve, 25));
  await keeper.stop();
  assert.ok(calls.length >= 2);
  assert.deepEqual(Object.keys(calls[0]).sort(), [
    "claimId", "elapsedMs", "engineId", "phase", "roomId", "round", "taskId",
  ]);

  let stopped = false;
  const failing = createLeaseKeeper({
    adapter: { async heartbeat() { throw new Error("down"); } },
    claim: { taskId: "t1", claimId: "c1", leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() },
    context: { roomId: "r1", engineId: "claude", round: 1, phase: "running" },
    intervalMs: 10,
    onFailure() { stopped = true; },
  });
  await assert.rejects(failing.start(), /heartbeat/i);
  assert.equal(stopped, true);
});

test("lease keeper stop aborts an in-flight heartbeat before remote renewal", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 150_000 });
  let renewed = false;
  let abortSeen = false;
  const keeper = createLeaseKeeper({
    adapter: {
      heartbeat(_event, { signal }) {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            renewed = true;
            resolve({ leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() });
          }, 1_000);
          signal.addEventListener("abort", () => {
            abortSeen = true;
            clearTimeout(timer);
            reject(new Error("heartbeat request aborted"));
          }, { once: true });
        });
      },
    },
    claim: {
      taskId: "t1",
      claimId: "c1",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    context: { roomId: "r1", engineId: "kimi", round: 1, phase: "running" },
    intervalMs: 10_000,
  });
  const starting = keeper.start();
  await Promise.resolve();
  const stopping = keeper.stop();
  await starting;
  assert.equal(await stopping, null);
  assert.equal(abortSeen, true);
  t.mock.timers.tick(1_000);
  assert.equal(renewed, false);
});

test("lease keeper schedules from each returned expiry instead of a fixed interval", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100_000 });
  let calls = 0;
  const keeper = createLeaseKeeper({
    adapter: {
      async heartbeat() {
        calls += 1;
        return { leaseExpiresAt: new Date(Date.now() + 170).toISOString() };
      },
    },
    claim: {
      taskId: "t1",
      claimId: "c1",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    context: { roomId: "r1", engineId: "codex", round: 1, phase: "running" },
    intervalMs: 250,
  });
  await keeper.start();
  t.mock.timers.tick(21);
  await Promise.resolve();
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await keeper.stop();
  assert.equal(calls, 2);
});

test("lease keeper rejects a renewal that leaves no safety margin", async () => {
  let stopped = false;
  const keeper = createLeaseKeeper({
    adapter: {
      async heartbeat() {
        return { leaseExpiresAt: new Date(Date.now() + 100).toISOString() };
      },
    },
    claim: {
      taskId: "t1",
      claimId: "c1",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    context: { roomId: "r1", engineId: "hermes", round: 1, phase: "running" },
    intervalMs: 250,
    onFailure() { stopped = true; },
  });
  await assert.rejects(keeper.start(), /too short to renew safely/i);
  assert.equal(stopped, true);
});

test("a late heartbeat cannot resurrect an expired prior lease", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 200_000 });
  let releaseHeartbeat;
  const initialExpiry = new Date(201_000).toISOString();
  const keeper = createLeaseKeeper({
    adapter: {
      heartbeat() {
        return new Promise((resolve) => { releaseHeartbeat = resolve; });
      },
    },
    claim: {
      taskId: "t1",
      claimId: "c1",
      leaseExpiresAt: initialExpiry,
    },
    context: { roomId: "r1", engineId: "kimi", round: 1, phase: "running" },
    intervalMs: 1_000,
  });
  const starting = keeper.start().catch((error) => error);
  await Promise.resolve();
  t.mock.timers.tick(1_001);
  releaseHeartbeat({ leaseExpiresAt: new Date(211_001).toISOString() });
  const startError = await starting;
  const stopError = await keeper.stop();
  assert.match(startError.message, /timed out|deadline/i);
  assert.match(stopError.message, /timed out|deadline/i);
  assert.equal(keeper.lease.leaseExpiresAt, initialExpiry);
});

test("engine cancellation keeps the AbortSignal and has a forced settlement path", () => {
  const source = fs.readFileSync(new URL("../scripts/local-room.mjs", import.meta.url), "utf8");
  assert.match(source, /function runEngine\([^)]*abortSignal\)/);
  assert.match(source, /const finish = async \(code, error, exitSignal = null\)/);
  assert.match(source, /abortSignal\.removeEventListener\("abort", abortHandler\)/);
  assert.match(
    source,
    /abortFinishTimer = setTimeout\(\(\) => \{\s*void finish\(null, "cancelled", "SIGKILL"\)/s,
  );
  assert.doesNotMatch(source, /const finish = async \(code, error, signal/);
});

test("lifecycle contract identifies the adapter as trusted code, not a sandbox", () => {
  const contract = fs.readFileSync(
    new URL("../docs/local-agent-room-contract.md", import.meta.url),
    "utf8",
  );
  assert.match(contract, /trusted AgentHost\s+extension code, not a sandbox/i);
  assert.match(contract, /remote\/API implementation must send only the metadata fields/i);
  assert.match(contract, /control.*trusted in-process cancellation context/is);
  assert.match(contract, /never serialize it or include it in an API payload/i);
});

test("emergency stop is nonce-confirmed, idempotent, and room-scoped", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-room-stop-"));
  let stopCalls = 0;
  const control = await createEmergencyStopControl({
    roomId: "room-stop",
    stateDir,
    getAgents: () => [
      { engineId: "claude", status: "working" },
      { engineId: "codex", status: "ready" },
    ],
    async onStop(...args) {
      assert.equal(args.length, 0, "endpoint cannot select a PID, signal, command, or machine");
      stopCalls += 1;
    },
  });
  try {
    const status = await fetch(`${control.url}/status`).then((response) => response.json());
    assert.deepEqual(status, {
      ok: true,
      roomId: "room-stop",
      state: "running",
      agents: [
        { engineId: "claude", status: "working" },
        { engineId: "codex", status: "ready" },
      ],
    });

    const manifest = JSON.parse(fs.readFileSync(path.join(stateDir, "control.json"), "utf8"));
    assert.equal(manifest.url, control.url);
    assert.match(manifest.stopNonce, /^[0-9a-f]{64}$/);

    const rejected = await fetch(`${control.url}/stop`, {
      method: "POST",
      headers: { "x-agenthost-stop-nonce": "wrong" },
    });
    assert.equal(rejected.status, 403);
    assert.equal(stopCalls, 0);

    const first = await fetch(`${control.url}/stop`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agenthost-stop-nonce": manifest.stopNonce,
      },
      body: JSON.stringify({ pid: 1, signal: "SIGKILL", command: "shutdown" }),
    });
    assert.equal(first.status, 202);
    const second = await fetch(`${control.url}/stop`, {
      method: "POST",
      headers: { "x-agenthost-stop-nonce": manifest.stopNonce },
    });
    assert.equal(second.status, 202);
    assert.equal(stopCalls, 1);

    control.setStatus("stopped");
    const ended = await fetch(`${control.url}/status`).then((response) => response.json());
    assert.equal(ended.state, "stopped");
  } finally {
    await control.close();
  }
});

test("emergency control refuses a hard-linked manifest without truncating its target", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-stop-hardlink-"));
  const protectedFile = path.join(stateDir, "protected.txt");
  const manifest = path.join(stateDir, "control.json");
  fs.writeFileSync(protectedFile, "preserve this file\n");
  fs.linkSync(protectedFile, manifest);

  await assert.rejects(
    createEmergencyStopControl({
      roomId: "room-hardlink",
      stateDir,
      async onStop() {},
    }),
    /manifest is not trusted/i,
  );
  assert.equal(fs.readFileSync(protectedFile, "utf8"), "preserve this file\n");
});
