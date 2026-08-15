import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createRoomLifecycleAdapter,
} from "../scripts/local-room/kanban-lifecycle-adapter.mjs";
import {
  finalizeRoomLifecycleAfterCleanup,
  loadLifecycleAdapter,
  runRoomSession,
} from "../scripts/local-room.mjs";

const TOKEN = "a".repeat(64);
const SUPERVISOR_TOKEN = `supervisor-${"b".repeat(56)}`;
const BASE_URL = "https://agenthost-box.tail4bf092.ts.net/kanban/tasks";
const ROOM_ID = "room-2026-07-28";
const AGENT_IDS = Object.freeze(["claude", "codex", "hermes", "kimi"]);

function control({ signal = new AbortController().signal, deadlineAt = Date.now() + 5_000 } = {}) {
  return { signal, deadlineAt };
}

function jsonResponse(value, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function adapter(fetcher) {
  return createRoomLifecycleAdapter({
    token: TOKEN,
    roomId: ROOM_ID,
    contractVersion: 1,
    agentIds: [...AGENT_IDS],
    baseUrl: BASE_URL,
    fetcher,
  });
}

test("the default adapter drives a complete four-agent room through the PR2 contract", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, init, body });
    const pathname = new URL(url).pathname;
    if (pathname === "/kanban/health") return jsonResponse({ ok: true });
    if (pathname === "/kanban/lifecycle/tasks") {
      return jsonResponse({
        task: { id: "t_room_default" },
        claimId: "claim_room_default",
        leaseExpiresAt: Date.now() + 120_000,
      }, { status: 201 });
    }
    if (pathname.endsWith("/heartbeat")) {
      return jsonResponse({ leaseExpiresAt: Date.now() + 120_000 });
    }
    if (pathname.endsWith("/complete")) return jsonResponse({ status: "done" });
    throw new Error(`unexpected integration route: ${pathname}`);
  };

  const transcriptRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-kanban-room-"));
  try {
    const lifecycle = await loadLifecycleAdapter({
      modulePath: "",
      baseUrl: BASE_URL,
      token: TOKEN,
      roomId: ROOM_ID,
      supervisor: {
        supervisorId: "desktop-0123456789abcdef0123456789abcdef",
        supervisorToken: SUPERVISOR_TOKEN,
      },
    });
    const readiness = [];
    const result = await runRoomSession({
      roomId: ROOM_ID,
      objective: "Prove the bundled lifecycle path",
      rounds: 1,
      specs: AGENT_IDS.map((id) => ({
        id,
        cwd: path.join(transcriptRoot, id),
        branch: `agenthost-room/${ROOM_ID}/${id}`,
      })),
      lifecycle,
      charter: "Use isolated worktrees.",
      transcriptFile: path.join(transcriptRoot, "transcript.jsonl"),
      onReadiness(update) { readiness.push(update); },
      async runTurn({ spec }) {
        return {
          ok: true,
          text: `${spec.id} finished\nROOM_STATUS: done`,
          durationMs: 1,
          code: 0,
          signal: null,
          timedOut: false,
          telemetry: {},
        };
      },
    });

    assert.equal(result.status, "done");
    await finalizeRoomLifecycleAfterCleanup({
      roomId: ROOM_ID,
      lifecycle,
      result,
      survivors: [],
    });
    assert.equal(
      calls.filter(({ url }) => new URL(url).pathname === "/kanban/health").length,
      4,
    );
    const heartbeats = calls.filter(({ url }) => new URL(url).pathname.endsWith("/heartbeat"));
    assert.equal(heartbeats.length, 4);
    assert.ok(heartbeats.every(({ body }) => body.phase === "build"));
    const completed = calls.find(({ url }) => new URL(url).pathname.endsWith("/complete"));
    assert.equal(completed.body.summary.outcome, "completed");
    assert.ok(readiness.every((item) => (
      item.authState === "unknown" && item.controllerState === "ready"
    )));
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(transcriptRoot, { recursive: true, force: true });
  }
});

test("the bundled adapter uses only the exact PR2 routes and metadata contract", async () => {
  const now = Date.now();
  const claimExpiry = now + 120_000;
  const heartbeatExpiry = now + 180_000;
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
    const pathname = new URL(url).pathname;
    if (pathname === "/kanban/health") return jsonResponse({ ok: true });
    if (pathname === "/kanban/lifecycle/tasks") {
      return jsonResponse({
        task: { id: "t:room.1", title: "Agent room" },
        claimId: "clm_room_1",
        leaseExpiresAt: claimExpiry,
        ignored: TOKEN,
      }, { status: 201 });
    }
    if (pathname.endsWith("/heartbeat")) {
      return jsonResponse({ leaseExpiresAt: heartbeatExpiry, ignored: TOKEN });
    }
    if (pathname.endsWith("/complete")) {
      return jsonResponse({ status: "done", ignored: TOKEN });
    }
    if (pathname.endsWith("/stop")) {
      return jsonResponse({ status: "blocked", ignored: TOKEN });
    }
    if (pathname.endsWith("/recover")) {
      return jsonResponse({ recovered: true, status: "blocked", ignored: TOKEN });
    }
    throw new Error("unexpected fake route");
  };
  const lifecycle = adapter(fetcher);
  const shared = {
    roomId: ROOM_ID,
    supervisorId: "agenthost-desktop",
    supervisorToken: SUPERVISOR_TOKEN,
  };

  assert.equal(await lifecycle.ready(
    { roomId: ROOM_ID, engineId: "codex" },
    control(),
  ), true);
  assert.deepEqual(await lifecycle.claim({
    ...shared,
    objectiveDigest: "c".repeat(64),
    agents: AGENT_IDS.map((engineId) => ({
      engineId,
      branch: `agenthost-room/${ROOM_ID}/${engineId}`,
    })),
    startedAt: now,
  }, control()), {
    taskId: "t:room.1",
    claimId: "clm_room_1",
    leaseExpiresAt: new Date(claimExpiry).toISOString(),
  });
  assert.deepEqual(await lifecycle.heartbeat({
    ...shared,
    taskId: "t:room.1",
    claimId: "clm_room_1",
    engineId: "hermes",
    round: 2,
    phase: "verify",
    elapsedMs: 4_000,
  }, control()), {
    leaseExpiresAt: new Date(heartbeatExpiry).toISOString(),
  });
  assert.deepEqual(await lifecycle.complete({
    ...shared,
    taskId: "t:room.1",
    claimId: "clm_room_1",
    summary: {
      outcome: "completed",
      rounds: 2,
      agents: [...AGENT_IDS],
      durationMs: 5_000,
    },
  }, control()), { status: "done" });
  assert.deepEqual(await lifecycle.stop({
    ...shared,
    taskId: "t:room.1",
    claimId: "clm_room_1",
    kind: "needs_input",
    reasonCode: "agent_reported_blocked",
  }, control()), { status: "blocked" });
  assert.deepEqual(await lifecycle.recover({
    ...shared,
    taskId: "t:room.1",
    claimId: "clm_room_1",
    reasonCode: "heartbeat_expired",
    workerKilled: true,
    workerReaped: true,
    writableBindRevoked: true,
  }, control()), { recovered: true, status: "blocked" });

  assert.deepEqual(calls.map(({ url, init }) => [
    init.method,
    new URL(url).pathname,
  ]), [
    ["GET", "/kanban/health"],
    ["POST", "/kanban/lifecycle/tasks"],
    ["POST", "/kanban/lifecycle/tasks/t:room.1/heartbeat"],
    ["POST", "/kanban/lifecycle/tasks/t:room.1/complete"],
    ["POST", "/kanban/lifecycle/tasks/t:room.1/stop"],
    ["POST", "/kanban/lifecycle/tasks/t:room.1/recover"],
  ]);
  assert.equal(calls[1].init.headers["Idempotency-Key"], ROOM_ID);
  for (const { url, init, body } of calls) {
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(String(url).includes(TOKEN), false);
    assert.equal(JSON.stringify(body || {}).includes(TOKEN), false);
    for (const [name, value] of Object.entries(init.headers)) {
      if (name !== "Authorization") assert.equal(String(value).includes(TOKEN), false);
    }
  }
  assert.deepEqual(calls[1].body, {
    roomId: ROOM_ID,
    supervisorId: "agenthost-desktop",
    supervisorToken: SUPERVISOR_TOKEN,
    objectiveDigest: "c".repeat(64),
    agents: AGENT_IDS.map((engineId) => ({
      engineId,
      branch: `agenthost-room/${ROOM_ID}/${engineId}`,
    })),
    startedAt: now,
  });
  assert.deepEqual(calls[2].body, {
    taskId: "t:room.1",
    claimId: "clm_room_1",
    roomId: ROOM_ID,
    supervisorId: "agenthost-desktop",
    supervisorToken: SUPERVISOR_TOKEN,
    engineId: "hermes",
    round: 2,
    phase: "verify",
    elapsedMs: 4_000,
  });
  assert.equal(JSON.stringify(await lifecycle.recover({
    ...shared,
    taskId: "t_room_1",
    claimId: "clm_room_1",
    reasonCode: "heartbeat_expired",
    workerKilled: true,
    workerReaped: true,
    writableBindRevoked: true,
  }, control())).includes(TOKEN), false);
});

test("claim replay preserves recovery and terminal outcomes without combining them", async () => {
  const now = Date.now();
  const claimEvent = {
    roomId: ROOM_ID,
    supervisorId: "agenthost-desktop",
    supervisorToken: SUPERVISOR_TOKEN,
    objectiveDigest: "d".repeat(64),
    agents: AGENT_IDS.map((engineId) => ({
      engineId,
      branch: `agenthost-room/${ROOM_ID}/${engineId}`,
    })),
    startedAt: now,
  };
  const response = (extra) => adapter(async () => jsonResponse({
    task: { id: "t_room_replay" },
    claimId: "clm_room_replay",
    leaseExpiresAt: now + 120_000,
    ...extra,
  }, { status: 201 }));

  assert.deepEqual(await response({ recoveryRequired: true }).claim(
    claimEvent,
    control(),
  ), {
    taskId: "t_room_replay",
    claimId: "clm_room_replay",
    leaseExpiresAt: new Date(now + 120_000).toISOString(),
    recoveryRequired: true,
  });
  assert.deepEqual(await response({ terminalStatus: "done" }).claim(
    claimEvent,
    control(),
  ), {
    taskId: "t_room_replay",
    claimId: "clm_room_replay",
    leaseExpiresAt: new Date(now + 120_000).toISOString(),
    terminalStatus: "done",
  });
  await assert.rejects(
    response({ recoveryRequired: true, terminalStatus: "blocked" }).claim(
      claimEvent,
      control(),
    ),
    /lifecycle metadata is invalid/,
  );
});

test("the adapter rejects every URL outside the exact HTTPS tailnet mount", () => {
  const invalid = [
    "http://agenthost-box.tail4bf092.ts.net/kanban",
    "https://example.com/kanban",
    "https://tail4bf092.ts.net/kanban",
    "https://user:pass@agenthost-box.tail4bf092.ts.net/kanban",
    "https://agenthost-box.tail4bf092.ts.net:4443/kanban",
    "https://agenthost-box.tail4bf092.ts.net/",
    "https://agenthost-box.tail4bf092.ts.net/kanban/other",
    "https://agenthost-box.tail4bf092.ts.net/kanban?token=x",
    "https://agenthost-box.tail4bf092.ts.net/kanban#fragment",
  ];
  for (const baseUrl of invalid) {
    assert.throws(() => createRoomLifecycleAdapter({
      token: TOKEN,
      roomId: ROOM_ID,
      contractVersion: 1,
      agentIds: [...AGENT_IDS],
      baseUrl,
      fetcher: async () => jsonResponse({ ok: true }),
    }), /Kanban bridge URL is invalid/);
  }
});

test("input validation blocks route injection and bridge-incompatible metadata", async () => {
  let calls = 0;
  const lifecycle = adapter(async () => {
    calls += 1;
    return jsonResponse({ ok: true });
  });
  const shared = {
    roomId: ROOM_ID,
    supervisorId: "agenthost-desktop",
    supervisorToken: SUPERVISOR_TOKEN,
  };
  await assert.rejects(
    lifecycle.heartbeat({
      ...shared,
      taskId: "../escape",
      claimId: "clm_room_1",
      engineId: "codex",
      round: 1,
      phase: "build",
      elapsedMs: 1,
    }, control()),
    /lifecycle metadata is invalid/,
  );
  await assert.rejects(
    lifecycle.complete({
      ...shared,
      taskId: "t_room_1",
      claimId: "clm_room_1",
      summary: {
        outcome: "done",
        rounds: 1,
        agents: [...AGENT_IDS],
        durationMs: 1,
      },
    }, control()),
    /lifecycle metadata is invalid/,
  );
  assert.equal(calls, 0);
});

test("an in-flight control cancellation aborts fetch without leaking its reason or token", async () => {
  const controller = new AbortController();
  let requestSignal;
  const lifecycle = adapter((_url, init) => new Promise((_resolve, reject) => {
    requestSignal = init.signal;
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  }));
  const pending = lifecycle.ready(
    { roomId: ROOM_ID, engineId: "claude" },
    control({ signal: controller.signal, deadlineAt: Date.now() + 5_000 }),
  );
  controller.abort(new Error(`private ${TOKEN}`));
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, "AGENTHOST_KANBAN_ABORTED");
    assert.equal(error.message.includes(TOKEN), false);
    return true;
  });
  assert.equal(requestSignal.aborted, true);
});

test("the control deadline aborts a stalled request", async () => {
  let requestSignal;
  const lifecycle = adapter((_url, init) => new Promise((_resolve, reject) => {
    requestSignal = init.signal;
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  }));
  await assert.rejects(
    lifecycle.ready(
      { roomId: ROOM_ID, engineId: "kimi" },
      control({ deadlineAt: Date.now() + 20 }),
    ),
    (error) => {
      assert.equal(error.code, "AGENTHOST_KANBAN_TIMEOUT");
      assert.equal(error.message.includes(TOKEN), false);
      return true;
    },
  );
  assert.equal(requestSignal.aborted, true);
});

test("responses are bounded and remote error bodies cannot escape", async () => {
  const oversized = adapter(async () => jsonResponse({ padding: "x".repeat(70 * 1024) }));
  await assert.rejects(
    oversized.ready({ roomId: ROOM_ID, engineId: "codex" }, control()),
    (error) => {
      assert.equal(error.code, "AGENTHOST_KANBAN_RESPONSE_TOO_LARGE");
      assert.equal(error.message.includes(TOKEN), false);
      return true;
    },
  );

  const hostile = adapter(async () => jsonResponse(
    { error: `remote echoed ${TOKEN}` },
    { status: 503 },
  ));
  await assert.rejects(
    hostile.ready({ roomId: ROOM_ID, engineId: "codex" }, control()),
    (error) => {
      assert.equal(error.message.includes(TOKEN), false);
      assert.equal(error.message.includes("remote echoed"), false);
      return true;
    },
  );

  const credentialEcho = adapter(async () => jsonResponse({ status: TOKEN }));
  await assert.rejects(
    credentialEcho.stop({
      roomId: ROOM_ID,
      supervisorId: "agenthost-desktop",
      supervisorToken: SUPERVISOR_TOKEN,
      taskId: "t_room_1",
      claimId: "clm_room_1",
      kind: "cancelled",
      reasonCode: "operator_cancelled",
    }, control()),
    (error) => {
      assert.equal(error.message.includes(TOKEN), false);
      return true;
    },
  );
});
