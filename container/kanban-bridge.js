"use strict";

// Tailnet-only, scope-separated access to the canonical AgentHost board.
// It is intentionally a fixed API: no shell, no arbitrary Hermes argv, and no
// generic comment route that could turn model output into a second transcript.

const crypto = require("node:crypto");
const canonical = require("./canonical-board.js");

const ROOM_OWNER = "agenthost-agent-room";
const CONTROL_PLANE_OWNER = "agenthost-control-plane";
const TASK_ID_RE = /^(?!-)[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const IDEMPOTENCY_RE = /^[A-Za-z0-9._:-]{1,120}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const BRANCH_RE = /^(?![-/.])(?!.*(?:\.\.|\/\/))[A-Za-z0-9._/-]{1,160}$/;
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const BOARD_ENGINES = new Set(["claude", "codex", "deepseek", "hermes", "gemini", "kimi", "cursor", "openclaw"]);
const ROOM_LIFECYCLE_ENGINES = new Set(["claude", "codex", "deepseek", "hermes", "gemini", "kimi", "openclaw"]);
const ROOM_PHASES = new Set(["starting", "plan", "build", "verify", "review", "waiting", "stopping"]);
const STOP_KINDS = new Set(["needs_input", "transient", "cancelled"]);
const OUTCOMES = new Set(["completed", "partial", "blocked", "cancelled"]);
const BODY_LIMIT = 16 * 1024;

function validToken(value) {
  return typeof value === "string" && value.length >= 32 && value.length <= 512
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function tokenMatches(actual, expected) {
  if (!validToken(actual) || !validToken(expected)) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function allTokensDistinct(tokens) {
  return tokens.every(validToken) && new Set(tokens).size === tokens.length;
}

function bearerToken(req) {
  const header = req.headers && req.headers.authorization;
  return typeof header === "string" && header.startsWith("Bearer ")
    ? header.slice("Bearer ".length)
    : "";
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-length", Buffer.byteLength(body));
  res.end(body);
}

function normalizedPath(rawUrl) {
  const url = new URL(rawUrl || "/", "http://kanban-bridge");
  if (url.pathname === "/kanban") return "/";
  return url.pathname.startsWith("/kanban/")
    ? url.pathname.slice("/kanban".length)
    : url.pathname;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > BODY_LIMIT) {
        tooLarge = true;
        chunks.length = 0;
      } else if (!tooLarge) {
        chunks.push(chunk);
      }
    });
    req.on("end", () => {
      if (tooLarge) return reject(httpError(413, "payload too large"));
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        const parsed = raw ? JSON.parse(raw) : {};
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return reject(httpError(400, "JSON object required"));
        }
        resolve(parsed);
      } catch {
        reject(httpError(400, "invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function httpError(status, message, code) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

function textField(body, name, max, options = {}) {
  const value = typeof body[name] === "string" ? body[name].trim() : "";
  if (!value && options.optional !== true) throw httpError(400, `${name} is required`);
  if (value.length > max) throw httpError(400, `${name} is too long`);
  return value;
}

function integerField(body, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = Number(body[name]);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw httpError(400, `${name} is invalid`);
  }
  return value;
}

function parsedOutput(output) {
  if (typeof output !== "string" || Buffer.byteLength(output) > 2 * 1024 * 1024) return null;
  try {
    const parsed = JSON.parse(output);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function taskFromOutput(output) {
  const parsed = parsedOutput(output);
  if (!parsed) return null;
  return parsed.task && typeof parsed.task === "object" && !Array.isArray(parsed.task)
    ? parsed.task
    : parsed;
}

function roomOwnsTask(task) {
  return Boolean(task
    && task.created_by === ROOM_OWNER
    && task.tenant === ROOM_OWNER
    && ROOM_LIFECYCLE_ENGINES.has(String(task.assignee || "").toLowerCase()));
}

function metadataComment(action) {
  return `[AgentHost control plane] actor=operator action=${action}`;
}

function safeError(error) {
  const status = Number(error && error.status) || 503;
  if (status === 400 || status === 404 || status === 409) {
    return { status, message: String(error.message || "request failed") };
  }
  // Rule 16: the reason rides along, bounded -- never replaced with a blank
  // label. On 2026-08-03 the CLI said `invalid choice: 'ready'` in plain
  // English on every failed submit, and THREE layers (this one first) each
  // collapsed it to "canonical board unavailable"; finding the real message
  // took an audit-log dig. Same bound as the gate's stderr fix: one line,
  // 200 chars -- enough to name the cause, too small to leak.
  const reason = String((error && error.message) || "").replace(/\s+/g, " ").trim().slice(0, 200);
  return {
    status,
    message: reason && reason !== "canonical board unavailable"
      ? `canonical board unavailable (${reason})`
      : "canonical board unavailable",
  };
}

function createKanbanBridgeHandler({
  runKanban,
  loadBoard,
  loadTaskDetails,
  invalidateBoard = () => {},
  canWriteTask = () => ({ ok: true }),
  acquireTaskMutation,
  clearAttention = async () => {},
  clearFrozen = async () => {},
  externalLifecycle,
  tailscaleUserLogin,
  readToken,
  writeToken,
  lifecycleToken,
  isShuttingDown = () => false,
  cacheTtlMs = 1_500,
} = {}) {
  const configuredLogin = typeof tailscaleUserLogin === "string" ? tailscaleUserLogin.trim() : "";
  const tokens = {
    read: typeof readToken === "string" ? readToken : "",
    write: typeof writeToken === "string" ? writeToken : "",
    lifecycle: typeof lifecycleToken === "string" ? lifecycleToken : "",
  };
  const configured = Boolean(
    configuredLogin
    && allTokensDistinct(Object.values(tokens))
    && typeof runKanban === "function"
    && typeof loadBoard === "function"
    && typeof loadTaskDetails === "function"
    && typeof acquireTaskMutation === "function"
    && externalLifecycle
    && ["claim", "heartbeat", "complete", "stop", "recover"].every(
      (name) => typeof externalLifecycle[name] === "function",
    )
  );
  const boardCache = canonical.createSingleFlightCache({ ttlMs: cacheTtlMs });

  const cachedBoard = () => boardCache.get(async () => {
    const snapshot = await loadBoard();
    if (!snapshot || snapshot.available !== true || !Array.isArray(snapshot.tasks)
      || !snapshot.columns || typeof snapshot.columns !== "object") {
      throw httpError(503, "canonical board unavailable");
    }
    return snapshot;
  });

  async function projectedTask(taskId) {
    const snapshot = await cachedBoard();
    const task = snapshot.tasks.find((item) => String(item.id) === taskId);
    if (!task) throw httpError(404, "task not found");
    return task;
  }

  async function details(taskId) {
    const raw = await loadTaskDetails(taskId);
    if (!raw) throw httpError(404, "task not found");
    const projected = canonical.projectCanonicalDetails(raw);
    if (String(projected.task.id) !== taskId) throw httpError(404, "task not found");
    return projected;
  }

  async function assertWritable(taskId, task) {
    if (task.frozen) {
      throw httpError(409, "frozen tasks require the explicit resume action", "task_frozen");
    }
    const verdict = await canWriteTask(taskId);
    if (!verdict || verdict.ok !== true) {
      throw httpError(verdict && verdict.unavailable ? 503 : 409,
        verdict && verdict.reason || "task has active scheduler ownership",
        "task_owned");
    }
  }

  async function runFixed(argv) {
    const output = await runKanban(argv);
    if (output === null) throw httpError(503, "canonical board mutation failed");
    invalidateBoard();
    boardCache.invalidate();
    return output;
  }

  async function verifiedProjected(taskId, predicate, message) {
    boardCache.invalidate();
    const task = await projectedTask(taskId);
    if (!predicate(task)) throw httpError(409, message || "canonical board did not confirm the change");
    return task;
  }

  async function createBoardTask(body, idempotencyKey) {
    const title = textField(body, "title", 160);
    const assignee = textField(body, "assignee", 40, { optional: true }).toLowerCase() || "codex";
    if (!BOARD_ENGINES.has(assignee)) throw httpError(400, "assignee is not a known AgentHost engine");
    const description = textField(body, "body", 8_000, { optional: true })
      || `GOAL: ${title}\nDONE: operator verifies completion\nNEEDS: none\nFILES: supplied in task details\nVERIFY: supplied in task details`;
    const output = await runFixed([
      "create",
      `--assignee=${assignee}`,
      // No --initial-status: the CLI only accepts {blocked,running} there, and
      // passing "ready" made argparse reject EVERY board submit (the operator
      // just saw "Canonical board is unavailable"). The default start status
      // lands in the Queued lane, which is what a new task wants.
      //
      // No --tenant either, and that one is not cosmetic. Stamping the card
      // with the control-plane tenant put it in a namespace the board never
      // reads: `hermes kanban list` (which IS the board projection) returned
      // 20 cards, all tenant null, and the card created here was not among
      // them -- it came back from `show` as tenant "agenthost-control-plane",
      // status archived. So a submit succeeded, the operator saw nothing
      // appear, and every action on it 404'd "task not found" because
      // projectedTask only sees what the projection lists. Verified on the
      // live box 2026-08-02. The gate's own quick-add has always created
      // without a tenant, which is exactly why that path worked.
      // --created-by is kept: it is provenance, not a namespace, and the room
      // ownership check below reads it.
      `--created-by=${CONTROL_PLANE_OWNER}`,
      `--body=${description}`,
      `--idempotency-key=control-plane:${idempotencyKey}`,
      "--json",
      "--",
      title,
    ]);
    const raw = taskFromOutput(output);
    if (!raw || !raw.id || String(raw.assignee || "").toLowerCase() !== assignee) {
      throw httpError(409, "canonical board rejected the task contract");
    }
    return canonical.projectCanonicalTask(raw);
  }

  async function createRoomTask(body, idempotencyKey) {
    const roomId = textField(body, "roomId", 120);
    if (!IDEMPOTENCY_RE.test(roomId) || roomId !== idempotencyKey) {
      throw httpError(400, "roomId must match the Idempotency-Key header");
    }
    const supervisorId = textField(body, "supervisorId", 128);
    const supervisorToken = textField(body, "supervisorToken", 512);
    if (!TASK_ID_RE.test(supervisorId) || !validToken(supervisorToken)) {
      throw httpError(400, "supervisor identity and private capability are invalid");
    }
    const objectiveDigest = textField(body, "objectiveDigest", 64).toLowerCase();
    if (!DIGEST_RE.test(objectiveDigest)) throw httpError(400, "objectiveDigest is invalid");
    const title = textField(body, "title", 160, { optional: true }) || `Agent room ${roomId}`;
    const startedAt = integerField(body, "startedAt");
    if (!Array.isArray(body.agents) || body.agents.length < 1 || body.agents.length > 8) {
      throw httpError(400, "agents must contain one to eight isolated agents");
    }
    const agents = body.agents.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw httpError(400, "agent metadata is invalid");
      }
      const engineId = textField(value, "engineId", 40).toLowerCase();
      const branch = textField(value, "branch", 160);
      if (!ROOM_LIFECYCLE_ENGINES.has(engineId) || !BRANCH_RE.test(branch)) {
        throw httpError(400, "agent metadata is invalid");
      }
      return { engineId, branch };
    });
    if (new Set(agents.map(({ engineId }) => engineId)).size !== agents.length) {
      throw httpError(400, "agents must be unique");
    }
    const assignee = agents[0].engineId;
    const metadataBody = [
      "ORIGIN: AgentHost agent room",
      `ROOM: ${roomId}`,
      `OBJECTIVE_DIGEST: ${objectiveDigest}`,
      `AGENTS: ${agents.map(({ engineId }) => engineId).join(",")}`,
    ].join("\n");
    const output = await runFixed([
      "create",
      `--assignee=${assignee}`,
      // Same CLI contract as createBoardTask above -- "ready" is not an
      // accepted --initial-status, so room-originated creates failed too.
      `--created-by=${ROOM_OWNER}`,
      `--tenant=${ROOM_OWNER}`,
      `--body=${metadataBody}`,
      `--idempotency-key=agent-room:${roomId}`,
      "--json",
      "--",
      title,
    ]);
    const raw = taskFromOutput(output);
    if (!raw || !raw.id || raw.created_by !== ROOM_OWNER || raw.tenant !== ROOM_OWNER) {
      throw httpError(409, "canonical board rejected the room ownership contract");
    }
    const lease = await externalLifecycle.claim({
      taskId: String(raw.id),
      roomId,
      supervisorId,
      supervisorToken,
      objectiveDigest,
      agents,
      startedAt,
      engineId: assignee,
    });
    if (!lease || typeof lease.claimId !== "string" || !Number.isFinite(Number(lease.leaseExpiresAt))) {
      try {
        await runFixed([
          "block",
          String(raw.id),
          "agent room lease could not be established",
          "--kind",
          "transient",
        ]);
      } catch {}
      throw httpError(503, "agent room lease could not be established");
    }
    let task = canonical.projectCanonicalTask({ ...raw, status: "running" }, {
      runningIds: new Set([String(raw.id)]),
    });
    try {
      boardCache.invalidate();
      task = await projectedTask(String(raw.id));
    } catch { /* the lease is authoritative while the board read catches up */ }
    return {
      task,
      claimId: lease.claimId,
      leaseExpiresAt: Number(lease.leaseExpiresAt),
      ...(lease.recoveryRequired === true ? { recoveryRequired: true } : {}),
      ...(typeof lease.terminalStatus === "string"
        ? { terminalStatus: lease.terminalStatus }
        : {}),
    };
  }

  async function handleWrite(taskId, action, body) {
    const current = await projectedTask(taskId);
    if (action !== "move" || body.lane !== "queued" || !current.frozen) {
      await assertWritable(taskId, current);
    } else {
      const verdict = await canWriteTask(taskId);
      if (!verdict || verdict.ok !== true) {
        throw httpError(verdict && verdict.unavailable ? 503 : 409,
          verdict && verdict.reason || "task has active scheduler ownership");
      }
    }

    if (action === "assign") {
      if (!current.actions.includes("assign")) throw httpError(409, "task cannot be reassigned in its current lane");
      const assignee = textField(body, "assignee", 40).toLowerCase();
      if (!BOARD_ENGINES.has(assignee)) throw httpError(400, "assignee is not a known AgentHost engine");
      await runFixed(["reassign", taskId, assignee, "--reclaim"]);
      return verifiedProjected(taskId,
        (task) => String(task.assignee || "").toLowerCase() === assignee,
        "canonical board did not confirm the assignee");
    }

    if (action === "move") {
      const lane = textField(body, "lane", 32).toLowerCase();
      if (!canonical.CANONICAL_BOARD_LANES.some(({ id }) => id === lane)
        || !current.transitions.includes(lane)) {
        throw httpError(409, "that lane transition is not available for this task");
      }
      if (lane === "queued") {
        await runFixed(["unblock", taskId]);
        if (current.frozen) await clearFrozen(taskId);
        if (current.lane === "awaiting") await clearAttention(taskId);
      } else if (lane === "blocked") {
        await runFixed([
          "block",
          taskId,
          "paused from AgentHost control plane",
          "--kind",
          "needs_input",
        ]);
      } else if (lane === "done") {
        await runFixed(["complete", taskId, "--result", "Closed from AgentHost control plane"]);
        await clearAttention(taskId);
      }
      return verifiedProjected(taskId, (task) => task.lane === lane);
    }

    const decision = textField(body, "action", 32).toLowerCase();
    if (!["approve", "send_back", "archive"].includes(decision)
      || !current.actions.includes(decision)) {
      throw httpError(409, "that review action is not available for this task");
    }
    await runFixed(["comment", taskId, "--author", "agenthost", metadataComment(decision)]);
    if (decision === "archive") {
      await runFixed(["archive", taskId]);
      await clearAttention(taskId);
      return { ...current, status: "archived", lane: "done", actions: ["open", "chat"] };
    }
    if (decision === "approve" && current.lane === "review") {
      await runFixed(["complete", taskId, "--result", "Approved from AgentHost control plane"]);
      await clearAttention(taskId);
      return verifiedProjected(taskId, (task) => task.lane === "done");
    }
    await runFixed(["unblock", taskId]);
    await clearAttention(taskId);
    return verifiedProjected(taskId, (task) => task.lane === "queued");
  }

  return async function handleKanbanBridge(req, res) {
    if (!configured) {
      sendJson(res, 503, { error: "Kanban bridge is not configured" });
      return;
    }
    let pathname;
    try { pathname = normalizedPath(req.url); }
    catch {
      sendJson(res, 400, { error: "invalid request target" });
      return;
    }
    const caller = req.headers && req.headers["tailscale-user-login"];
    if (!LOOPBACK.has(String(req.socket && req.socket.remoteAddress || ""))
      || caller !== configuredLogin) {
      sendJson(res, 403, { error: "forbidden" });
      return;
    }

    const isHealth = req.method === "GET" && pathname === "/health";
    const isRead = req.method === "GET"
      && (pathname === "/tasks" || /^\/tasks\/(?!-)[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(pathname));
    const isWrite = req.method === "POST"
      && (pathname === "/tasks"
        || /^\/tasks\/(?!-)[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\/(move|assign|review)$/.test(pathname));
    const isLifecycle = req.method === "POST"
      && (pathname === "/lifecycle/tasks"
        || /^\/lifecycle\/tasks\/(?!-)[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\/(heartbeat|complete|stop|recover)$/.test(pathname));
    const supplied = bearerToken(req);
    const authorized = isHealth
      ? Object.values(tokens).some((token) => tokenMatches(supplied, token))
      : isRead ? tokenMatches(supplied, tokens.read)
        : isWrite ? tokenMatches(supplied, tokens.write)
          : isLifecycle ? tokenMatches(supplied, tokens.lifecycle)
            : false;
    if (!authorized) {
      sendJson(res, (isRead || isWrite || isLifecycle || isHealth) ? 403 : 404,
        { error: (isRead || isWrite || isLifecycle || isHealth) ? "forbidden" : "not found" });
      return;
    }
    if (isShuttingDown()) {
      sendJson(res, 503, { error: "Kanban bridge is shutting down" });
      return;
    }
    if (req.method === "POST") {
      const origin = req.headers && req.headers.origin;
      const fetchSite = req.headers && req.headers["sec-fetch-site"];
      if (typeof origin === "string" || fetchSite === "cross-site") {
        sendJson(res, 403, { error: "forbidden" });
        return;
      }
      if (!/^application\/json(?:\s*;|$)/i.test(
        String(req.headers && req.headers["content-type"] || ""),
      )) {
        sendJson(res, 415, { error: "application/json required" });
        return;
      }
    }

    if (isHealth) {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (isRead && pathname === "/tasks") {
      try { sendJson(res, 200, await cachedBoard()); }
      catch { sendJson(res, 503, { error: "canonical board unavailable" }); }
      return;
    }
    if (isRead) {
      const taskId = pathname.slice("/tasks/".length);
      try { sendJson(res, 200, await details(taskId)); }
      catch (error) {
        const safe = safeError(error);
        sendJson(res, safe.status, { error: safe.message });
      }
      return;
    }

    let body;
    try { body = await readJson(req); }
    catch (error) {
      const safe = safeError(error);
      sendJson(res, safe.status, { error: safe.message });
      return;
    }
    const idempotencyKey = typeof req.headers["idempotency-key"] === "string"
      ? req.headers["idempotency-key"].trim()
      : "";

    if (isWrite && pathname === "/tasks") {
      if (!IDEMPOTENCY_RE.test(idempotencyKey)) {
        sendJson(res, 400, { error: "a valid Idempotency-Key header is required" });
        return;
      }
      try {
        const task = await createBoardTask(body, idempotencyKey);
        sendJson(res, 201, { task });
      } catch (error) {
        const safe = safeError(error);
        sendJson(res, safe.status, { error: safe.message });
      }
      return;
    }
    if (isLifecycle && pathname === "/lifecycle/tasks") {
      if (!IDEMPOTENCY_RE.test(idempotencyKey)) {
        sendJson(res, 400, { error: "a valid Idempotency-Key header is required" });
        return;
      }
      try { sendJson(res, 201, await createRoomTask(body, idempotencyKey)); }
      catch (error) {
        const safe = safeError(error);
        sendJson(res, safe.status, { error: safe.message });
      }
      return;
    }

    const match = pathname.match(/^\/tasks\/([^/]+)\/(move|assign|review)$/);
    if (isWrite && match) {
      const taskId = match[1];
      if (!TASK_ID_RE.test(taskId)) {
        sendJson(res, 400, { error: "invalid task id" });
        return;
      }
      let releaseMutation = null;
      try { releaseMutation = acquireTaskMutation(taskId); } catch {}
      if (typeof releaseMutation !== "function") {
        sendJson(res, 409, { error: "another board action is changing this task" });
        return;
      }
      try {
        const task = await handleWrite(taskId, match[2], body);
        boardCache.invalidate();
        sendJson(res, 200, { task });
      } catch (error) {
        const safe = safeError(error);
        sendJson(res, safe.status, { error: safe.message, code: error && error.code });
      } finally {
        try { releaseMutation(); } catch {}
      }
      return;
    }

    const lifecycleMatch = pathname.match(
      /^\/lifecycle\/tasks\/([^/]+)\/(heartbeat|complete|stop|recover)$/,
    );
    if (isLifecycle && lifecycleMatch) {
      const taskId = lifecycleMatch[1];
      if (!TASK_ID_RE.test(taskId)) {
        sendJson(res, 400, { error: "invalid task id" });
        return;
      }
      try {
        const shown = await loadTaskDetails(taskId);
        const rawTask = shown && shown.task && typeof shown.task === "object" ? shown.task : shown;
        if (!rawTask || String(rawTask.id) !== taskId || !roomOwnsTask(rawTask)) {
          throw httpError(404, "task not found");
        }
        const claimId = textField(body, "claimId", 160);
        const roomId = textField(body, "roomId", 120);
        const supervisorId = textField(body, "supervisorId", 128);
        const supervisorToken = textField(body, "supervisorToken", 512);
        if (!TASK_ID_RE.test(supervisorId) || !validToken(supervisorToken)) {
          throw httpError(400, "supervisor identity and private capability are invalid");
        }
        let result;
        if (lifecycleMatch[2] === "heartbeat") {
          const engineId = textField(body, "engineId", 40).toLowerCase();
          const phase = textField(body, "phase", 32).toLowerCase();
          if (!ROOM_LIFECYCLE_ENGINES.has(engineId) || !ROOM_PHASES.has(phase)) {
            throw httpError(400, "heartbeat metadata is invalid");
          }
          result = await externalLifecycle.heartbeat({
            taskId, claimId, roomId, supervisorId, supervisorToken, engineId, phase,
            round: integerField(body, "round", { min: 0, max: 1_000_000 }),
            elapsedMs: integerField(body, "elapsedMs"),
          });
        } else if (lifecycleMatch[2] === "complete") {
          const source = body.summary;
          if (!source || typeof source !== "object" || Array.isArray(source)) {
            throw httpError(400, "summary metadata is required");
          }
          const outcome = textField(source, "outcome", 32).toLowerCase();
          if (!OUTCOMES.has(outcome) || !Array.isArray(source.agents)
            || source.agents.some((engine) => !ROOM_LIFECYCLE_ENGINES.has(String(engine).toLowerCase()))) {
            throw httpError(400, "completion metadata is invalid");
          }
          result = await externalLifecycle.complete({
            taskId, claimId, roomId, supervisorId, supervisorToken,
            summary: {
              outcome,
              rounds: integerField(source, "rounds", { min: 0, max: 1_000_000 }),
              agents: source.agents.map((engine) => String(engine).toLowerCase()),
              durationMs: integerField(source, "durationMs"),
            },
          });
        } else if (lifecycleMatch[2] === "stop") {
          const kind = textField(body, "kind", 32).toLowerCase();
          const reasonCode = textField(body, "reasonCode", 80).toLowerCase();
          if (!STOP_KINDS.has(kind) || !/^[a-z][a-z0-9_]{0,79}$/.test(reasonCode)) {
            throw httpError(400, "stop metadata is invalid");
          }
          result = await externalLifecycle.stop({
            taskId, claimId, roomId, supervisorId, supervisorToken, kind, reasonCode,
          });
        } else {
          const reasonCode = textField(body, "reasonCode", 80).toLowerCase();
          if (!/^[a-z][a-z0-9_]{0,79}$/.test(reasonCode)
            || body.workerKilled !== true
            || body.workerReaped !== true
            || body.writableBindRevoked !== true) {
            throw httpError(400,
              "recovery requires a reason code and verified kill, reap, and writable-bind revocation");
          }
          result = await externalLifecycle.recover({
            taskId,
            claimId,
            roomId,
            supervisorId,
            supervisorToken,
            reasonCode,
            workerKilled: true,
            workerReaped: true,
            writableBindRevoked: true,
          });
        }
        boardCache.invalidate();
        sendJson(res, 200, result || { ok: true });
      } catch (error) {
        const safe = safeError(error);
        sendJson(res, safe.status, { error: safe.message });
      }
      return;
    }

    sendJson(res, 404, { error: "not found" });
  };
}

module.exports = {
  CONTROL_PLANE_OWNER,
  ROOM_OWNER,
  createKanbanBridgeHandler,
  metadataComment,
  roomOwnsTask,
  safeError,
};
