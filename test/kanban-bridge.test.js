import test from "node:test";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createKanbanBridgeHandler } = require("../container/kanban-bridge.js");

const LOGIN = "operator@agenthost.space";
const TOKENS = Object.freeze({
  read: "r".repeat(64),
  write: "w".repeat(64),
  lifecycle: "l".repeat(64),
});
const SUPERVISOR_ID = "agentglass-desktop";
const SUPERVISOR_TOKEN = "s".repeat(64);
const auth = (scope) => ({
  "Tailscale-User-Login": LOGIN,
  Authorization: `Bearer ${TOKENS[scope]}`,
});

function responseJson(value) {
  return JSON.stringify(value);
}

function requestTo(handler, {
  method = "GET",
  path = "/health",
  body,
  headers = {},
  remoteAddress = "127.0.0.1",
} = {}) {
  const req = Readable.from(body === undefined ? [] : [
    Buffer.from(typeof body === "string" ? body : responseJson(body)),
  ]);
  req.method = method;
  req.url = path;
  req.headers = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  if (body !== undefined && req.headers["content-type"] === undefined) {
    req.headers["content-type"] = "application/json";
  }
  req.socket = { remoteAddress };

  const chunks = [];
  const res = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(Buffer.from(chunk));
      done();
    },
  });
  res.statusCode = 200;
  res.headers = {};
  res.setHeader = (name, value) => { res.headers[name.toLowerCase()] = value; };
  res.writeHead = (status, headersOut) => {
    res.statusCode = status;
    for (const [name, value] of Object.entries(headersOut || {})) res.setHeader(name, value);
    return res;
  };

  return new Promise((resolve, reject) => {
    res.once("finish", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      resolve({
        status: res.statusCode,
        body: raw ? JSON.parse(raw) : null,
        headers: res.headers,
      });
    });
    res.once("error", reject);
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

function board(tasks, overlays = {}) {
  const canonical = require("../container/canonical-board.js");
  return canonical.projectCanonicalBoard(tasks, { available: true, ...overlays });
}

function handler(options = {}) {
  const heldMutations = new Set();
  const acquireTaskMutation = options.acquireTaskMutation || ((taskId) => {
    if (heldMutations.has(taskId)) return null;
    heldMutations.add(taskId);
    return () => heldMutations.delete(taskId);
  });
  return createKanbanBridgeHandler({
    tailscaleUserLogin: LOGIN,
    readToken: TOKENS.read,
    writeToken: TOKENS.write,
    lifecycleToken: TOKENS.lifecycle,
    runKanban: async () => null,
    loadBoard: async () => board([]),
    loadTaskDetails: async (id) => ({
      task: { id, title: "Task", status: "ready", assignee: "codex" },
      comments: [],
      events: [],
    }),
    canWriteTask: () => ({ ok: true }),
    acquireTaskMutation,
    clearAttention: async () => {},
    clearFrozen: async () => {},
    externalLifecycle: {
      claim: async () => ({ claimId: "clm_room", leaseExpiresAt: 60_000 }),
      heartbeat: async () => ({ leaseExpiresAt: 120_000 }),
      complete: async () => ({ status: "done" }),
      stop: async () => ({ status: "blocked" }),
      recover: async () => ({ recovered: true, status: "blocked" }),
    },
    ...options,
  });
}

test("read, write, and lifecycle tokens grant only their fixed route families", async () => {
  const calls = [];
  const bridge = handler({
    loadBoard: async () => {
      calls.push("read");
      return board([{ id: "t_1", title: "One", status: "ready" }]);
    },
  });

  assert.equal((await requestTo(bridge, { path: "/kanban/tasks", headers: auth("read") })).status, 200);
  assert.equal((await requestTo(bridge, { path: "/kanban/tasks", headers: auth("write") })).status, 403);
  assert.equal((await requestTo(bridge, {
    method: "POST",
    path: "/kanban/tasks",
    headers: { ...auth("read"), "Idempotency-Key": "board-1" },
    body: { title: "Nope", assignee: "codex" },
  })).status, 403);
  assert.equal((await requestTo(bridge, {
    method: "POST",
    path: "/kanban/tasks",
    headers: { ...auth("lifecycle"), "Idempotency-Key": "board-2" },
    body: { title: "Nope", assignee: "codex" },
  })).status, 403);
  assert.equal((await requestTo(bridge, {
    method: "POST",
    path: "/kanban/lifecycle/tasks/t_1/heartbeat",
    headers: auth("write"),
    body: {
      claimId: "clm_room",
      roomId: "room-1",
      supervisorId: SUPERVISOR_ID,
      supervisorToken: SUPERVISOR_TOKEN,
      engineId: "codex",
      round: 1,
      phase: "build",
      elapsedMs: 100,
    },
  })).status, 403);
  assert.equal(calls.length, 1);

  const publicSocket = await requestTo(bridge, {
    path: "/kanban/tasks",
    headers: auth("read"),
    remoteAddress: "100.64.0.2",
  });
  assert.equal(publicSocket.status, 403, "tokens cannot bypass the loopback + Tailscale identity boundary");
});

test("room creation rejects a missing supervisor capability before touching the board", async () => {
  let calls = 0;
  const bridge = handler({
    runKanban: async () => {
      calls += 1;
      return null;
    },
  });
  const response = await requestTo(bridge, {
    method: "POST",
    path: "/kanban/lifecycle/tasks",
    headers: { ...auth("lifecycle"), "Idempotency-Key": "room-no-capability" },
    body: {
      roomId: "room-no-capability",
      supervisorId: SUPERVISOR_ID,
      objectiveDigest: "d".repeat(64),
      title: "No capability",
      agents: [{ engineId: "codex", branch: "codex/no-capability" }],
      startedAt: 1_000,
    },
  });
  assert.equal(response.status, 400);
  assert.equal(calls, 0);
});

// Regression, 2026-08-02: every board submit failed with the operator-facing
// string "Canonical board is unavailable". The real cause was one argument --
// `--initial-status=ready` -- which the installed Hermes CLI rejects outright
// (`invalid choice: 'ready' (choose from 'blocked', 'running')`), so argparse
// exited non-zero before a task was ever created. Nothing in this suite caught
// it because no test asserted the argv against the CLI's actual contract.
// CREATE_STATUS_CHOICES is that contract, taken from `hermes kanban create -h`
// on the live box. A new task wants neither choice, so the flag is omitted and
// the CLI's default start status lands the card in Queued.
const CREATE_STATUS_CHOICES = new Set(["blocked", "running"]);

function assertCreateArgvIsAccepted(argv) {
  assert.equal(argv[0], "create");
  for (const [index, arg] of argv.entries()) {
    if (arg === "--") break; // everything after this is the title, not a flag
    const value = arg.startsWith("--initial-status=")
      ? arg.slice("--initial-status=".length)
      : arg === "--initial-status" ? argv[index + 1] : null;
    if (value === null) continue;
    assert.ok(CREATE_STATUS_CHOICES.has(value),
      `hermes kanban create rejects --initial-status=${value}; it accepts only ${[...CREATE_STATUS_CHOICES].join(", ")}`);
  }
}

test("create argv only uses flag values the installed board CLI accepts", async () => {
  const creates = [];
  const bridge = handler({
    runKanban: async (argv) => {
      if (argv[0] === "create") creates.push(argv);
      return responseJson({
        id: "t_created",
        title: "Created",
        status: "todo",
        assignee: "codex",
        created_by: "agenthost-agent-room",
        tenant: "agenthost-agent-room",
      });
    },
  });

  const created = await requestTo(bridge, {
    method: "POST",
    path: "/kanban/tasks",
    headers: { ...auth("write"), "Idempotency-Key": "create-contract-1" },
    body: { title: "Submit from the board", assignee: "codex" },
  });
  assert.equal(created.status, 201, "a board submit must reach the CLI and succeed");
  assert.equal(created.body.task.lane, "queued", "a new card belongs in Queued");

  const room = await requestTo(bridge, {
    method: "POST",
    path: "/kanban/lifecycle/tasks",
    headers: { ...auth("lifecycle"), "Idempotency-Key": "room-contract" },
    body: {
      roomId: "room-contract",
      supervisorId: SUPERVISOR_ID,
      supervisorToken: SUPERVISOR_TOKEN,
      objectiveDigest: "b".repeat(64),
      title: "Agent room contract",
      agents: [{ engineId: "codex", branch: "codex/room-contract" }],
      startedAt: 1_000,
    },
  });
  assert.equal(room.status, 201, "room-originated creates use the same CLI contract");

  assert.equal(creates.length, 2, "both create paths must have run for real");
  for (const argv of creates) assertCreateArgvIsAccepted(argv);
});

test("board reads are single-flight cached and mutations invalidate the cache", async () => {
  let loads = 0;
  const tasks = [{ id: "t_cache", title: "Cached", status: "ready", assignee: "codex" }];
  const bridge = handler({
    loadBoard: async () => {
      loads += 1;
      return board(tasks);
    },
    runKanban: async (argv) => {
      if (argv[0] === "create") return responseJson({
        id: "t_new",
        title: "New",
        status: "ready",
        assignee: "codex",
      });
      return responseJson({ ok: true });
    },
  });
  await Promise.all([
    requestTo(bridge, { path: "/tasks", headers: auth("read") }),
    requestTo(bridge, { path: "/tasks", headers: auth("read") }),
  ]);
  assert.equal(loads, 1);
  await requestTo(bridge, {
    method: "POST",
    path: "/tasks",
    headers: { ...auth("write"), "Idempotency-Key": "board-new" },
    body: { title: "New", assignee: "codex" },
  });
  await requestTo(bridge, { path: "/tasks", headers: auth("read") });
  assert.equal(loads, 2, "a successful write invalidates the short read cache");
});

test("details expose the real task and chat destinations without leaking unknown fields", async () => {
  const bridge = handler({
    loadTaskDetails: async () => ({
      task: {
        id: "t_detail",
        title: "Open task",
        status: "running",
        body: "GOAL: inspect",
        assignee: "hermes",
        token: "do-not-leak",
      },
      comments: [{ author: "steve", text: "Proceed", secret: "do-not-leak" }],
      events: [{ kind: "heartbeat", payload: { note: "Testing", token: "do-not-leak" } }],
    }),
  });
  const result = await requestTo(bridge, {
    path: "/kanban/tasks/t_detail",
    headers: auth("read"),
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.task.destinations.details, "/board/task/t_detail");
  assert.equal(result.body.task.destinations.chat, "/?task=t_detail");
  assert.equal(JSON.stringify(result.body).includes("do-not-leak"), false);
});

test("write actions use fixed commands, verify postconditions, and never accept arbitrary argv", async () => {
  const calls = [];
  let awaiting = true;
  let task = { id: "t_action", title: "Action", status: "blocked", assignee: "codex" };
  const bridge = handler({
    loadBoard: async () => board([task], {
      awaiting: awaiting ? { t_action: { note: "Needs you" } } : {},
    }),
    loadTaskDetails: async () => ({ task, comments: [], events: [] }),
    clearAttention: async () => { awaiting = false; },
    runKanban: async (argv) => {
      calls.push(argv);
      if (argv[0] === "unblock") task = { ...task, status: "ready" };
      if (argv[0] === "reassign") task = { ...task, assignee: argv[2] };
      if (argv[0] === "block") task = { ...task, status: "blocked" };
      return responseJson({ task });
    },
  });

  const approved = await requestTo(bridge, {
    method: "POST",
    path: "/tasks/t_action/review",
    headers: auth("write"),
    body: { action: "approve", note: "--help" },
  });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.task.lane, "queued");
  assert.deepEqual(calls, [
    ["comment", "t_action", "--author", "agenthost",
      "[AgentHost control plane] actor=operator action=approve"],
    ["unblock", "t_action"],
  ]);

  const assigned = await requestTo(bridge, {
    method: "POST",
    path: "/tasks/t_action/assign",
    headers: auth("write"),
    body: { assignee: "kimi", argv: ["archive", "everything"] },
  });
  assert.equal(assigned.status, 200);
  assert.deepEqual(calls.at(-1), ["reassign", "t_action", "kimi", "--reclaim"]);

  const assignedDeepSeek = await requestTo(bridge, {
    method: "POST",
    path: "/tasks/t_action/assign",
    headers: auth("write"),
    body: { assignee: "deepseek" },
  });
  assert.equal(assignedDeepSeek.status, 200,
    "a human operator may deliberately reassign a board card to DeepSeek");
  assert.deepEqual(calls.at(-1), ["reassign", "t_action", "deepseek", "--reclaim"]);

  const assignedCursor = await requestTo(bridge, {
    method: "POST",
    path: "/tasks/t_action/assign",
    headers: auth("write"),
    body: { assignee: "cursor" },
  });
  assert.equal(assignedCursor.status, 200);
  assert.deepEqual(calls.at(-1), ["reassign", "t_action", "cursor", "--reclaim"]);

  const callsBeforeUnknown = calls.length;
  const assignedUnknown = await requestTo(bridge, {
    method: "POST",
    path: "/tasks/t_action/assign",
    headers: auth("write"),
    body: { assignee: "gpt5" },
  });
  assert.equal(assignedUnknown.status, 400);
  assert.equal(calls.length, callsBeforeUnknown,
    "an unknown assignee is refused before any board command runs");

  const blocked = await requestTo(bridge, {
    method: "POST",
    path: "/tasks/t_action/move",
    headers: auth("write"),
    body: { lane: "blocked", reason: "--help" },
  });
  assert.equal(blocked.status, 200);
  assert.deepEqual(calls.at(-1), [
    "block",
    "t_action",
    "paused from AgentHost control plane",
    "--kind",
    "needs_input",
  ]);
});

test("a human board action holds the gate lock through ownership check, mutation, and read-back proof", async () => {
  const held = new Set();
  const acquireTaskMutation = (taskId) => {
    if (held.has(taskId)) return null;
    held.add(taskId);
    return () => held.delete(taskId);
  };
  let task = { id: "t_race", title: "Race", status: "ready", assignee: "codex" };
  let loads = 0;
  let releaseVerification;
  let verificationStarted;
  const verificationGate = new Promise((resolve) => { releaseVerification = resolve; });
  const verificationSeen = new Promise((resolve) => { verificationStarted = resolve; });
  const bridge = handler({
    acquireTaskMutation,
    canWriteTask: () => {
      assert.equal(held.has("t_race"), true, "ownership is checked under the gate lock");
      return { ok: true };
    },
    loadBoard: async () => {
      loads += 1;
      if (loads > 1) {
        assert.equal(held.has("t_race"), true, "verified read-back is still locked");
        verificationStarted();
        await verificationGate;
      }
      return board([task]);
    },
    runKanban: async (argv) => {
      assert.equal(held.has("t_race"), true, "the board mutation is locked");
      task = { ...task, assignee: argv[2] };
      return responseJson({ task });
    },
  });

  const humanAction = requestTo(bridge, {
    method: "POST",
    path: "/tasks/t_race/assign",
    headers: auth("write"),
    body: { assignee: "hermes" },
  });
  await verificationSeen;
  assert.equal(acquireTaskMutation("t_race"), null,
    "the scheduler must defer while the human action awaits its postcondition");
  releaseVerification();
  const response = await humanAction;
  assert.equal(response.status, 200);
  assert.equal(response.body.task.assignee, "hermes");
  const schedulerRelease = acquireTaskMutation("t_race");
  assert.equal(typeof schedulerRelease, "function", "the lock releases only after the proof finishes");
  schedulerRelease();
});

test("a human board action returns 409 without mutation when scheduler ownership already exists", async () => {
  let mutations = 0;
  let releases = 0;
  const bridge = handler({
    acquireTaskMutation: () => () => { releases += 1; },
    canWriteTask: () => ({ ok: false, reason: "task has active scheduler ownership" }),
    loadBoard: async () => board([
      { id: "t_owned", title: "Owned", status: "ready", assignee: "codex" },
    ]),
    runKanban: async () => {
      mutations += 1;
      return null;
    },
  });
  const response = await requestTo(bridge, {
    method: "POST",
    path: "/tasks/t_owned/assign",
    headers: auth("write"),
    body: { assignee: "hermes" },
  });
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "task_owned");
  assert.equal(mutations, 0);
  assert.equal(releases, 1, "a denied human action still releases the shared lock");
});

test("a frozen card stays visible in Blocked and only the explicit safe resume path may change it", async () => {
  const calls = [];
  let cleared = 0;
  let isFrozen = true;
  let frozen = { id: "t_frozen", title: "Frozen", status: "blocked", assignee: "codex" };
  const bridge = handler({
    loadBoard: async () => board([frozen], {
      frozenIds: isFrozen ? new Set(["t_frozen"]) : new Set(),
    }),
    loadTaskDetails: async () => ({ task: frozen, comments: [], events: [] }),
    clearFrozen: async () => { cleared += 1; isFrozen = false; },
    runKanban: async (argv) => {
      calls.push(argv);
      if (argv[0] === "unblock") frozen = { ...frozen, status: "ready" };
      return responseJson({ task: { ...frozen, status: "ready" } });
    },
  });

  const assign = await requestTo(bridge, {
    method: "POST",
    path: "/tasks/t_frozen/assign",
    headers: auth("write"),
    body: { assignee: "hermes" },
  });
  assert.equal(assign.status, 409);
  assert.deepEqual(calls, []);

  const resume = await requestTo(bridge, {
    method: "POST",
    path: "/tasks/t_frozen/move",
    headers: auth("write"),
    body: { lane: "queued" },
  });
  assert.equal(resume.status, 200);
  assert.deepEqual(calls, [["unblock", "t_frozen"]]);
  assert.equal(cleared, 1);
});

test("external room lifecycle persists only structured metadata and renews/releases its durable lease", async () => {
  const calls = [];
  const lifecycleCalls = [];
  const owned = {
    id: "t_room",
    title: "Agent room",
    status: "running",
    created_by: "agenthost-agent-room",
    tenant: "agenthost-agent-room",
    assignee: "codex",
  };
  const bridge = handler({
    runKanban: async (argv) => {
      calls.push(argv);
      return responseJson(argv[0] === "create"
        ? { ...owned, status: "ready" }
        : { task: owned });
    },
    loadTaskDetails: async () => ({ task: owned, comments: [], events: [] }),
    externalLifecycle: {
      claim: async (value) => {
        lifecycleCalls.push(["claim", value]);
        return { claimId: "clm_room", leaseExpiresAt: 60_000 };
      },
      heartbeat: async (value) => {
        lifecycleCalls.push(["heartbeat", value]);
        return { leaseExpiresAt: 120_000 };
      },
      complete: async (value) => {
        lifecycleCalls.push(["complete", value]);
        return { status: "done" };
      },
      stop: async (value) => {
        lifecycleCalls.push(["stop", value]);
        return { status: "blocked" };
      },
      recover: async (value) => {
        lifecycleCalls.push(["recover", value]);
        return { recovered: true, status: "blocked" };
      },
    },
  });

  const cursorClaim = await requestTo(bridge, {
    method: "POST",
    path: "/kanban/lifecycle/tasks",
    headers: { ...auth("lifecycle"), "Idempotency-Key": "room-cursor-rejected" },
    body: {
      roomId: "room-cursor",
      supervisorId: SUPERVISOR_ID,
      supervisorToken: SUPERVISOR_TOKEN,
      objectiveDigest: "c".repeat(64),
      title: "Cursor must stay outside Agent Room",
      agents: [{ engineId: "cursor", branch: "cursor/room-cursor" }],
      startedAt: 900,
    },
  });
  assert.equal(cursorClaim.status, 400);
  assert.equal(lifecycleCalls.length, 0,
    "Cursor remains a human board target but cannot claim external Agent Room work");

  const unknownClaim = await requestTo(bridge, {
    method: "POST",
    path: "/kanban/lifecycle/tasks",
    headers: { ...auth("lifecycle"), "Idempotency-Key": "room-unknown-rejected" },
    body: {
      roomId: "room-unknown-rejected",
      supervisorId: SUPERVISOR_ID,
      supervisorToken: SUPERVISOR_TOKEN,
      objectiveDigest: "e".repeat(64),
      title: "Unknown engine must stay outside Agent Room",
      agents: [{ engineId: "gpt5", branch: "gpt5/room-unknown" }],
      startedAt: 950,
    },
  });
  assert.equal(unknownClaim.status, 400);
  assert.equal(lifecycleCalls.length, 0,
    "an unknown engine cannot claim unattended Agent Room work");

  const claimed = await requestTo(bridge, {
    method: "POST",
    path: "/kanban/lifecycle/tasks",
    headers: { ...auth("lifecycle"), "Idempotency-Key": "room-1" },
    body: {
      roomId: "room-1",
      supervisorId: SUPERVISOR_ID,
      supervisorToken: SUPERVISOR_TOKEN,
      objectiveDigest: "a".repeat(64),
      title: "Agent room",
      agents: [
        { engineId: "codex", branch: "codex/room-1" },
        { engineId: "hermes", branch: "hermes/room-1" },
      ],
      startedAt: 1_000,
    },
  });
  assert.equal(claimed.status, 201);
  assert.equal(claimed.body.claimId, "clm_room");
  assert.equal(lifecycleCalls[0][1].supervisorId, SUPERVISOR_ID);
  assert.equal(lifecycleCalls[0][1].supervisorToken, SUPERVISOR_TOKEN);
  assert.equal(JSON.stringify(calls).includes("model reply"), false);

  const cursorPulse = await requestTo(bridge, {
    method: "POST",
    path: "/kanban/lifecycle/tasks/t_room/heartbeat",
    headers: auth("lifecycle"),
    body: {
      claimId: "clm_room",
      roomId: "room-1",
      supervisorId: SUPERVISOR_ID,
      supervisorToken: SUPERVISOR_TOKEN,
      engineId: "cursor",
      round: 2,
      phase: "verify",
      elapsedMs: 3_000,
    },
  });
  assert.equal(cursorPulse.status, 400);
  assert.equal(lifecycleCalls.length, 1,
    "Cursor cannot renew an external Agent Room lease");

  const pulse = await requestTo(bridge, {
    method: "POST",
    path: "/kanban/lifecycle/tasks/t_room/heartbeat",
    headers: auth("lifecycle"),
    body: {
      claimId: "clm_room",
      roomId: "room-1",
      supervisorId: SUPERVISOR_ID,
      supervisorToken: SUPERVISOR_TOKEN,
      engineId: "hermes",
      round: 2,
      phase: "verify",
      elapsedMs: 4_000,
      output: "never persist this model reply",
    },
  });
  assert.equal(pulse.status, 200);
  assert.equal(pulse.body.leaseExpiresAt, 120_000);
  assert.equal(JSON.stringify(lifecycleCalls).includes("model reply"), false,
    "unknown output fields never cross the lifecycle boundary");

  const cursorCompletion = await requestTo(bridge, {
    method: "POST",
    path: "/kanban/lifecycle/tasks/t_room/complete",
    headers: auth("lifecycle"),
    body: {
      claimId: "clm_room",
      roomId: "room-1",
      supervisorId: SUPERVISOR_ID,
      supervisorToken: SUPERVISOR_TOKEN,
      summary: {
        outcome: "completed",
        rounds: 2,
        agents: ["codex", "cursor"],
        durationMs: 4_500,
      },
    },
  });
  assert.equal(cursorCompletion.status, 400);
  assert.equal(lifecycleCalls.length, 2,
    "Cursor cannot complete external Agent Room work");

  const completed = await requestTo(bridge, {
    method: "POST",
    path: "/kanban/lifecycle/tasks/t_room/complete",
    headers: auth("lifecycle"),
    body: {
      claimId: "clm_room",
      roomId: "room-1",
      supervisorId: SUPERVISOR_ID,
      supervisorToken: SUPERVISOR_TOKEN,
      summary: {
        outcome: "completed",
        rounds: 2,
        agents: ["codex", "hermes"],
        durationMs: 5_000,
      },
      transcript: "never persist this model reply",
    },
  });
  assert.equal(completed.status, 200);
  assert.equal(JSON.stringify(lifecycleCalls).includes("model reply"), false);

  const recovered = await requestTo(bridge, {
    method: "POST",
    path: "/kanban/lifecycle/tasks/t_room/recover",
    headers: auth("lifecycle"),
    body: {
      claimId: "clm_room",
      roomId: "room-1",
      supervisorId: SUPERVISOR_ID,
      supervisorToken: SUPERVISOR_TOKEN,
      reasonCode: "heartbeat_expired",
      workerKilled: true,
      workerReaped: true,
      writableBindRevoked: true,
      output: "never persist this model reply",
    },
  });
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.recovered, true);
  assert.deepEqual(lifecycleCalls.at(-1), ["recover", {
    taskId: "t_room",
    claimId: "clm_room",
    roomId: "room-1",
    supervisorId: SUPERVISOR_ID,
    supervisorToken: SUPERVISOR_TOKEN,
    reasonCode: "heartbeat_expired",
    workerKilled: true,
    workerReaped: true,
    writableBindRevoked: true,
  }]);
  assert.equal(JSON.stringify(lifecycleCalls).includes("model reply"), false);

  const unprovenRecovery = await requestTo(bridge, {
    method: "POST",
    path: "/kanban/lifecycle/tasks/t_room/recover",
    headers: auth("lifecycle"),
    body: {
      claimId: "clm_room",
      roomId: "room-1",
      supervisorId: SUPERVISOR_ID,
      supervisorToken: SUPERVISOR_TOKEN,
      reasonCode: "heartbeat_expired",
      workerKilled: true,
      workerReaped: false,
      writableBindRevoked: true,
    },
  });
  assert.equal(unprovenRecovery.status, 400,
    "a lifecycle token cannot clear an expired lease without all three cleanup facts");

  const arbitraryComment = await requestTo(bridge, {
    method: "POST",
    path: "/kanban/lifecycle/tasks/t_room/comments",
    headers: auth("lifecycle"),
    body: { text: "agent output excerpt" },
  });
  assert.equal(arbitraryComment.status, 404,
    "there is deliberately no generic room-comment endpoint");
});

// ---- Rule 16: the failure reason survives this layer (task #19) -------------
// On 2026-08-03 the CLI said `invalid choice: 'ready'` in plain English on
// every failed submit, and three layers each collapsed it into a generic
// label; finding the real message took an audit-log dig. This layer was the
// first eraser. The reason now rides along, bounded, without widening which
// statuses are treated as client errors.
const { safeError } = require("../container/kanban-bridge.js");

test("safeError carries the upstream reason instead of blanking it", () => {
  const e = Object.assign(new Error("kanban: error: argument status: invalid choice: 'ready'"), { status: 500 });
  const safe = safeError(e);
  assert.equal(safe.status, 500, "the status mapping is unchanged -- only the message gained the reason");
  assert.match(safe.message, /invalid choice: 'ready'/, "the operator must see the CLI's own words, not a blank label");
  assert.match(safe.message, /canonical board unavailable/, "the generic frame stays, so existing clients still recognize it");
});

test("safeError bounds the reason and never doubles the generic label", () => {
  const long = safeError(Object.assign(new Error("x".repeat(5000)), { status: 502 }));
  assert.ok(long.message.length < 260, "one line, capped -- enough to name the cause, too small to leak");
  const generic = safeError(Object.assign(new Error("canonical board unavailable"), { status: 503 }));
  assert.equal(generic.message, "canonical board unavailable", "a reason that IS the label must not nest itself");
  const bare = safeError({ status: 503 });
  assert.equal(bare.message, "canonical board unavailable");
});

test("safeError still passes 400/404/409 messages straight through", () => {
  assert.equal(safeError(Object.assign(new Error("task not found"), { status: 404 })).message, "task not found");
});
