"use strict";

// The one task-to-lane projection for every AgentHost board surface.
//
// Hermes remains the database of record. This module only turns its raw task
// vocabulary plus AgentHost's server-owned overlays into the six lanes the
// operator and every agent see. The box UI, desktop control plane, spoken board
// summary, and bridge all consume this result instead of maintaining competing
// status maps.

const CANONICAL_BOARD_LANES = Object.freeze([
  Object.freeze({ id: "queued", title: "Queued" }),
  Object.freeze({ id: "running", title: "Running" }),
  Object.freeze({ id: "awaiting", title: "Awaiting You" }),
  Object.freeze({ id: "review", title: "Review" }),
  Object.freeze({ id: "done", title: "Done" }),
  Object.freeze({ id: "blocked", title: "Blocked" }),
]);

const RAW_STATUS_LANE = Object.freeze({
  triage: "queued",
  todo: "queued",
  scheduled: "queued",
  ready: "queued",
  queued: "queued",
  running: "running",
  in_progress: "running",
  working: "running",
  awaiting: "awaiting",
  awaiting_input: "awaiting",
  needs_input: "awaiting",
  review: "review",
  awaiting_review: "review",
  pending_review: "review",
  complete: "done",
  completed: "done",
  done: "done",
  archived: "done",
  blocked: "blocked",
  failed: "blocked",
  cancelled: "blocked",
  canceled: "blocked",
  frozen: "blocked",
});

const LANE_IDS = new Set(CANONICAL_BOARD_LANES.map(({ id }) => id));
const TASK_ID_RE = /^(?!-)[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_TASKS = 5_000;

function cleanText(value, max) {
  if (typeof value !== "string") return undefined;
  const clean = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();
  return clean ? clean.slice(0, max) : undefined;
}

function cleanScalar(value, max = 100) {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  return cleanText(value, max);
}

function cleanId(value) {
  const id = cleanText(value, 128);
  return id && TASK_ID_RE.test(id) ? id : undefined;
}

function normalizedStatus(value) {
  const status = cleanText(value, 64);
  return status ? status.toLowerCase().replace(/[\s-]+/g, "_") : "";
}

function rawLane(status) {
  return RAW_STATUS_LANE[normalizedStatus(status)] || "queued";
}

function setFrom(value) {
  if (value instanceof Set) return value;
  return new Set(Array.isArray(value) ? value.map(String) : []);
}

function awaitingRecord(awaiting, id) {
  if (!awaiting || typeof awaiting !== "object") return null;
  const record = awaiting[id];
  return record && typeof record === "object" ? record : null;
}

function taskLane(task, overlays = {}) {
  const id = String(task && task.id || "");
  if (awaitingRecord(overlays.awaiting, id)) return "awaiting";
  if (setFrom(overlays.frozenIds).has(id)) return "blocked";
  const base = rawLane(task && task.status);
  // A durable scheduler claim may move a queued card visually to Running
  // before Hermes's visible status catches up. It may never pull a terminal,
  // review, awaiting, or blocked card into Running.
  if (base === "queued" && setFrom(overlays.runningIds).has(id)) return "running";
  return base;
}

// A GATE THE OPERATOR CANNOT CLEAR IS WORSE THAN NO GATE.
//
// A consequence- or wording-gated card sits in `queued`, and `queued` advertised
// only assign + block. So the board could HOLD a card and offered nothing that
// released it: Steve saw "reassign / block / discuss" and no way forward. The
// release has existed server-side the whole time --
// `POST /board/task/<id>/override` -- and its own refusal text even reads
// "Open the card and choose Approve once", naming a control that was never built
// (Rule 11, and a copy-vs-code gap in an error message).
//
// The two gates take DIFFERENT keys and granting the wrong one does nothing at
// all, silently, so the action is derived from the card's actual gate rather
// than offered as one generic "approve". `gateIssue` comes from the projection
// overlay; a card with no gate is unchanged.
const GATE_ISSUE_ACTION = Object.freeze({
  consequence_gate: "approve_once",
  wording_gate: "run_once",
  loop_detector: "run_once",
});

function actionsForLane(lane, destinations, gateIssue) {
  const actions = ["open"];
  if (destinations.chat) actions.push("chat");
  if (lane === "queued") {
    // Release first: it is the only action that moves a held card forward, so it
    // reads before the sideways ones rather than after them.
    if (GATE_ISSUE_ACTION[gateIssue]) actions.push(GATE_ISSUE_ACTION[gateIssue]);
    actions.push("assign", "block");
  }
  else if (lane === "awaiting") actions.push("approve", "send_back", "assign", "archive");
  else if (lane === "review") actions.push("approve", "send_back", "assign");
  else if (lane === "blocked") actions.push("resume", "assign", "archive");
  else if (lane === "done") actions.push("archive");
  return actions;
}

function transitionsForLane(lane) {
  if (lane === "queued") return ["blocked"];
  if (lane === "awaiting" || lane === "review") return ["queued", "done"];
  if (lane === "blocked") return ["queued"];
  return [];
}

function projectCanonicalTask(task, overlays = {}) {
  if (!task || typeof task !== "object" || Array.isArray(task)) {
    throw new Error("invalid canonical board task");
  }
  const id = cleanId(task.id);
  const title = cleanText(task.title || task.name, 500);
  const status = normalizedStatus(task.status);
  if (!id || !title || !status) throw new Error("invalid canonical board task");

  const lane = taskLane(task, overlays);
  const destinations = {
    details: "/board/task/" + encodeURIComponent(id),
    chat: "/?task=" + encodeURIComponent(id),
  };
  // Which gate, if any, is holding this card. Supplied by the caller because the
  // classifier needs live settings this pure projection has no access to. It is
  // surfaced on the card as well as driving the action, so the UI can SAY what
  // is holding it rather than only offering a button (Rule 16 -- a held card
  // must name its own cause).
  const gateIssue = cleanText(overlays.gated && overlays.gated[id], 40);
  const projected = {
    id,
    title,
    status,
    lane,
    destinations,
    actions: actionsForLane(lane, destinations, gateIssue),
    transitions: transitionsForLane(lane),
  };
  if (gateIssue) projected.gateIssue = gateIssue;

  for (const [key, max] of [
    ["assignee", 160],
    ["priority", 100],
    ["blocked_reason", 1_000],
    ["liveNote", 1_000],
    ["problem", 1_000],
  ]) {
    const value = key === "priority" ? cleanScalar(task[key], max) : cleanText(task[key], max);
    if (value !== undefined) projected[key] = value;
  }
  for (const key of ["created_at", "updated_at", "started_at", "completed_at", "liveNoteAt"]) {
    const value = cleanScalar(task[key]);
    if (value !== undefined) projected[key] = value;
  }

  const review = awaitingRecord(overlays.awaiting, id);
  const reviewNote = cleanText(review && review.note, 1_000);
  if (reviewNote) projected.reviewNote = reviewNote;
  if (setFrom(overlays.frozenIds).has(id)) {
    projected.frozen = true;
    projected.actions = ["open", "chat", "resume"];
    projected.transitions = ["queued"];
  }
  if (setFrom(overlays.runningIds).has(id) && lane === "running" && rawLane(status) === "queued") {
    projected.claimRunning = true;
  }
  return projected;
}

function projectCanonicalBoard(tasks, overlays = {}) {
  if (!Array.isArray(tasks) || tasks.length > MAX_TASKS) {
    throw new Error("invalid canonical board task list");
  }
  const projected = tasks.map((task) => projectCanonicalTask(task, overlays));
  const ids = new Set();
  for (const task of projected) {
    if (ids.has(task.id)) throw new Error("duplicate canonical board task");
    ids.add(task.id);
  }
  const columns = Object.fromEntries(CANONICAL_BOARD_LANES.map(({ id }) => [id, []]));
  for (const task of projected) columns[task.lane].push(task);
  return {
    available: overlays.available !== false,
    lanes: CANONICAL_BOARD_LANES.map((lane) => ({ ...lane })),
    columns,
    tasks: projected,
  };
}

function sanitizeComment(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const text = cleanText(value.text || value.body || value.comment, 5_000);
  if (!text) return null;
  const comment = { text };
  const id = cleanScalar(value.id, 160);
  const author = cleanText(value.author || value.created_by, 160);
  const createdAt = cleanScalar(value.created_at || value.at);
  if (id !== undefined) comment.id = id;
  if (author) comment.author = author;
  if (createdAt !== undefined) comment.created_at = createdAt;
  return comment;
}

function sanitizeEvent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const kind = cleanText(value.kind, 64);
  if (kind !== "heartbeat") return null;
  const note = cleanText(value.payload && value.payload.note, 1_000);
  if (!note) return null;
  const event = { kind, payload: { note } };
  const createdAt = cleanScalar(value.created_at || value.at);
  if (createdAt !== undefined) event.created_at = createdAt;
  return event;
}

function projectCanonicalDetails(show, overlays = {}) {
  if (!show || typeof show !== "object" || Array.isArray(show)) {
    throw new Error("invalid canonical task details");
  }
  const rawTask = show.task && typeof show.task === "object" && !Array.isArray(show.task)
    ? show.task
    : show;
  const task = projectCanonicalTask(rawTask, overlays);
  const body = cleanText(rawTask.body, 20_000);
  const result = cleanText(rawTask.result, 20_000);
  if (body) task.body = body;
  if (result) task.result = result;
  const comments = (Array.isArray(show.comments) ? show.comments : rawTask.comments || [])
    .slice(0, 500).map(sanitizeComment).filter(Boolean);
  const events = (Array.isArray(show.events) ? show.events : rawTask.events || [])
    .slice(-500).map(sanitizeEvent).filter(Boolean);
  return { task, comments, events };
}

// The orphan sweep calls this for each visible running card. A durable external
// room lease is scheduler ownership just like an in-box scheduler claim, so it
// remains protected on every tick, not only the tick that created the card.
function orphanProtection(task, trackedIds, durable, nowMs) {
  if (!task || normalizedStatus(task.status) !== "running") return "not-running";
  if (setFrom(trackedIds).has(String(task.id))) return "tracked";
  if (!durable || durable.readable !== true) return "unknown";
  if (durable.kind === "live-or-recovering") {
    const claim = durable.claim;
    if (!claim || claim.state === "recovering") return "durable";
    const expiresAt = Number(claim.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt > Number(nowMs || 0)) return "durable";
    // An expired live row still requires verified recovery. It is not an orphan
    // that may be rewritten or relaunched.
    return "durable";
  }
  return "orphan";
}

function createSingleFlightCache({ ttlMs = 1_500, now = Date.now } = {}) {
  let value;
  let expiresAt = 0;
  let hasValue = false;
  let inFlight = null;
  return {
    get(load) {
      const current = Number(now());
      if (hasValue && current < expiresAt) return Promise.resolve(value);
      if (inFlight) return inFlight;
      try {
        inFlight = Promise.resolve(load());
      } catch (error) {
        return Promise.reject(error);
      }
      inFlight = inFlight.then((next) => {
        value = next;
        hasValue = true;
        expiresAt = Number(now()) + ttlMs;
        inFlight = null;
        return next;
      }, (error) => {
        inFlight = null;
        throw error;
      });
      return inFlight;
    },
    invalidate() {
      hasValue = false;
      expiresAt = 0;
    },
  };
}

module.exports = {
  CANONICAL_BOARD_LANES,
  RAW_STATUS_LANE,
  createSingleFlightCache,
  orphanProtection,
  projectCanonicalBoard,
  projectCanonicalDetails,
  projectCanonicalTask,
  rawLane,
  taskLane,
};
