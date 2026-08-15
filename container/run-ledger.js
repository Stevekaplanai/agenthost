// Box-owned lifecycle ledger for work that must outlive a phone connection.
//
// The ledger stores small, redacted observations -- never prompts or full agent
// output. Each state change is appended synchronously before the caller can
// launch or advance work, so an accepted run always has a durable identity.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const RUN_KINDS = new Set([
  "chat",
  "team_chat",
  "brain",
  "loop",
  "multi_loop",
  "board_task",
  "git_ladder",
  "board_runner",
  "wake_check",
  "mail_cycle",
  "system",
]);
const ACTIVE_RUN_STATUSES = new Set(["queued", "running", "waiting", "gated"]);
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted", "skipped"]);
const RUN_STATUSES = new Set([...ACTIVE_RUN_STATUSES, ...TERMINAL_RUN_STATUSES]);
const API_STATUSES = new Set(["success", "warning", "error"]);
const TRANSITIONS = {
  queued: new Set(["running", "waiting", "gated", "failed", "cancelled", "interrupted", "skipped"]),
  running: new Set(["running", "waiting", "gated", "completed", "failed", "cancelled", "interrupted"]),
  waiting: new Set(["running", "waiting", "gated", "completed", "failed", "cancelled", "interrupted"]),
  gated: new Set(["queued", "running", "waiting", "gated", "failed", "cancelled", "interrupted", "skipped"]),
};
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MINIMUM_TERMINAL_RUNS = 1000;
const MAX_SUMMARY = 500;
const MAX_ACTIONS = 20;
const MAX_ARTIFACTS = 20;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function same(valueA, valueB) {
  return JSON.stringify(valueA) === JSON.stringify(valueB);
}

function cleanId(value) {
  const id = String(value || "").trim();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(id)) throw new Error("Run id must use 1-128 letters, numbers, dots, colons, underscores, or dashes");
  return id;
}

function cleanKind(value) {
  const kind = String(value || "").trim().toLowerCase();
  if (!RUN_KINDS.has(kind)) throw new Error(`Unknown run kind: ${kind || "(empty)"}`);
  return kind;
}

function cleanStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  if (!RUN_STATUSES.has(status)) throw new Error(`Unknown run status: ${status || "(empty)"}`);
  return status;
}

function cleanEngines(values) {
  if (values == null) return [];
  if (!Array.isArray(values)) throw new Error("Run engines must be an array");
  return [...new Set(values.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean))].sort();
}

function clippedRedacted(value, redact, max = MAX_SUMMARY) {
  if (value == null) return "";
  return String(redact(String(value))).slice(0, max);
}

function cleanActions(values, redact) {
  if (values == null) return [];
  if (!Array.isArray(values)) throw new Error("Run next_actions must be an array");
  return values.slice(0, MAX_ACTIONS).map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Each run next action must be an object");
    const id = String(value.id || "").trim();
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id)) throw new Error("Each run next action needs a stable id");
    const label = clippedRedacted(value.label, redact, 120).trim();
    if (!label) throw new Error("Each run next action needs a label");
    return { id, label };
  });
}

function cleanArtifacts(values, redact) {
  if (values == null) return [];
  if (!Array.isArray(values)) throw new Error("Run artifacts must be an array");
  return values.slice(0, MAX_ARTIFACTS).map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Each run artifact must be an object");
    const type = String(value.type || "").trim().toLowerCase();
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(type)) throw new Error("Each run artifact needs a stable type");
    const artifact = { type };
    if (value.id != null) artifact.id = clippedRedacted(value.id, redact, 300);
    if (value.label != null) artifact.label = clippedRedacted(value.label, redact, 300);
    if (value.ref != null) artifact.ref = clippedRedacted(value.ref, redact, 1000);
    return artifact;
  });
}

function runResponse({ status = "success", summary = "", next_actions = [], artifacts = [], run } = {}) {
  if (!API_STATUSES.has(status)) throw new Error(`Unknown API response status: ${status}`);
  const response = { status, summary: String(summary), next_actions: clone(next_actions), artifacts: clone(artifacts) };
  if (run !== undefined) response.run = clone(run);
  return response;
}

function createRunLedger({
  dir,
  now = Date.now,
  redact = (value) => value,
  retentionMs = DEFAULT_RETENTION_MS,
  minimumTerminalRuns = DEFAULT_MINIMUM_TERMINAL_RUNS,
} = {}) {
  if (!dir) throw new Error("Run ledger dir is required");
  if (typeof now !== "function") throw new Error("Run ledger now must be a function");
  if (typeof redact !== "function") throw new Error("Run ledger redact must be a function");
  if (!Number.isFinite(retentionMs) || retentionMs < 0) throw new Error("Run ledger retentionMs must be a non-negative number");
  if (!Number.isInteger(minimumTerminalRuns) || minimumTerminalRuns < 0) throw new Error("Run ledger minimumTerminalRuns must be a non-negative integer");

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "runs.jsonl");
  let events = [];
  let runs = new Map();
  let nextSeq = 1;
  let needsLeadingNewline = false;

  function nowValue() {
    const value = now();
    const ms = value instanceof Date ? value.getTime() : Number(value);
    if (!Number.isFinite(ms)) throw new Error("Run ledger clock returned an invalid time");
    return ms;
  }

  function load() {
    let raw = "";
    try { raw = fs.readFileSync(file, "utf8"); }
    catch (error) {
      if (error && error.code === "ENOENT") return;
      throw error;
    }
    needsLeadingNewline = raw.length > 0 && !raw.endsWith("\n");
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (!event || !Number.isSafeInteger(event.seq) || event.seq < 1 || !event.run || typeof event.run.id !== "string") continue;
      events.push(event);
      runs.set(event.run.id, event.run);
      nextSeq = Math.max(nextSeq, event.seq + 1);
    }
    events.sort((a, b) => a.seq - b.seq);
  }

  function appendEvent(type, run) {
    const event = {
      version: 1,
      seq: nextSeq,
      runId: run.id,
      type,
      at: run.updatedAt,
      status: run.status,
      kind: run.kind,
      engine: run.engines.length === 1 ? run.engines[0] : null,
      engines: run.engines,
      summary: run.summary,
      next_actions: run.next_actions,
      artifacts: run.artifacts,
      run,
    };
    const prefix = needsLeadingNewline ? "\n" : "";
    try {
      fs.appendFileSync(file, prefix + JSON.stringify(event) + "\n", { mode: 0o600 });
    } catch (error) {
      throw new Error(`Could not persist run ${run.id}: ${error.message}`);
    }
    needsLeadingNewline = false;
    nextSeq++;
    events.push(event);
    runs.set(run.id, run);
    return event;
  }

  function create(input = {}) {
    const id = cleanId(input.id || crypto.randomUUID());
    const kind = cleanKind(input.kind);
    const engines = cleanEngines(input.engines);
    const existing = runs.get(id);
    if (existing) {
      if (existing.kind !== kind) throw new Error(`Run ${id} already belongs to kind ${existing.kind}`);
      if (!same(existing.engines, engines)) throw new Error(`Run ${id} already belongs to engines ${existing.engines.join(",") || "(none)"}`);
      return clone(existing);
    }
    const at = nowValue();
    const run = {
      id,
      kind,
      status: "queued",
      engines,
      summary: clippedRedacted(input.summary, redact),
      createdAt: at,
      startedAt: null,
      updatedAt: at,
      finishedAt: null,
      next_actions: cleanActions(input.next_actions, redact),
      artifacts: cleanArtifacts(input.artifacts, redact),
    };
    appendEvent("accepted", run);
    return clone(run);
  }

  function transition(idValue, change = {}) {
    const id = cleanId(idValue);
    const current = runs.get(id);
    if (!current) throw new Error(`Unknown run: ${id}`);
    const status = cleanStatus(change.status);
    if (TERMINAL_RUN_STATUSES.has(current.status)) {
      if (status === current.status) return clone(current);
      throw new Error(`Cannot transition terminal run ${id}; it already ended as ${current.status}`);
    }
    const allowed = TRANSITIONS[current.status];
    if (!allowed || !allowed.has(status)) throw new Error(`Cannot transition run ${id} from ${current.status} to ${status}`);

    const at = nowValue();
    const run = {
      ...current,
      status,
      engines: Object.hasOwn(change, "engines") ? cleanEngines(change.engines) : current.engines,
      summary: Object.hasOwn(change, "summary") ? clippedRedacted(change.summary, redact) : current.summary,
      updatedAt: at,
      next_actions: Object.hasOwn(change, "next_actions") ? cleanActions(change.next_actions, redact) : current.next_actions,
      artifacts: Object.hasOwn(change, "artifacts") ? cleanArtifacts(change.artifacts, redact) : current.artifacts,
    };
    if (status === "running" && run.startedAt === null) run.startedAt = at;
    if (TERMINAL_RUN_STATUSES.has(status)) run.finishedAt = at;
    const eventType = status === "running"
      ? (current.startedAt === null ? "started" : "progress")
      : status;
    appendEvent(eventType, run);
    return clone(run);
  }

  function start(id, change = {}) {
    return transition(id, { ...change, status: "running" });
  }

  function finish(id, status, change = {}) {
    const clean = cleanStatus(status);
    if (!TERMINAL_RUN_STATUSES.has(clean)) throw new Error(`Run finish requires a terminal status, got ${clean}`);
    return transition(id, { ...change, status: clean });
  }

  function get(idValue) {
    let id;
    try { id = cleanId(idValue); } catch { return null; }
    const run = runs.get(id);
    return run ? clone(run) : null;
  }

  function list({ limit = 100, statuses, kinds } = {}) {
    const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 100));
    const statusSet = statuses ? new Set(statuses.map(cleanStatus)) : null;
    const kindSet = kinds ? new Set(kinds.map(cleanKind)) : null;
    return [...runs.values()]
      .filter((run) => (!statusSet || statusSet.has(run.status)) && (!kindSet || kindSet.has(run.kind)))
      .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || b.id.localeCompare(a.id))
      .slice(0, safeLimit)
      .map(clone);
  }

  function eventsSince(cursorValue = 0, limitValue = 100) {
    const cursor = Math.max(0, Number.isSafeInteger(Number(cursorValue)) ? Number(cursorValue) : 0);
    const limit = Math.max(1, Math.min(1000, Number(limitValue) || 100));
    const earliestSeq = events.length ? events[0].seq : nextSeq;
    const available = events.filter((event) => event.seq > cursor);
    const selected = available.slice(0, limit);
    return {
      events: selected.map(clone),
      nextCursor: selected.length ? selected[selected.length - 1].seq : cursor,
      hasMore: available.length > selected.length,
      truncated: cursor > 0 && cursor < earliestSeq - 1,
    };
  }

  function recentEvents(limitValue = 30) {
    const limit = Math.max(1, Math.min(1000, Number(limitValue) || 30));
    const selected = events.slice(-limit);
    return {
      events: selected.map(clone),
      nextCursor: events.length ? events[events.length - 1].seq : 0,
      hasMore: events.length > selected.length,
      truncated: false,
    };
  }

  function eventsForRun(idValue) {
    let id;
    try { id = cleanId(idValue); } catch { return []; }
    if (!runs.has(id)) return [];
    return events.filter((event) => event.runId === id).map(clone);
  }

  function activeByEngine() {
    const active = {};
    for (const run of runs.values()) {
      if (!ACTIVE_RUN_STATUSES.has(run.status)) continue;
      for (const engine of run.engines) {
        if (!active[engine]) active[engine] = [];
        active[engine].push(clone(run));
      }
    }
    for (const values of Object.values(active)) {
      values.sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id));
    }
    return active;
  }

  function interruptActive({ reason = "Gateway restarted before completion", statuses } = {}) {
    const selected = statuses == null ? ACTIVE_RUN_STATUSES : new Set(statuses.map(cleanStatus));
    const activeIds = [...runs.values()].filter((run) => ACTIVE_RUN_STATUSES.has(run.status) && selected.has(run.status)).map((run) => run.id);
    return activeIds.map((id) => finish(id, "interrupted", { summary: reason }));
  }

  function atomicRewrite(lines) {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, lines, { mode: 0o600 });
    try {
      fs.renameSync(tmp, file);
    } catch (error) {
      if (!error || !["EEXIST", "EPERM"].includes(error.code)) {
        try { fs.unlinkSync(tmp); } catch {}
        throw error;
      }
      fs.unlinkSync(file);
      fs.renameSync(tmp, file);
    }
  }

  function prune() {
    const ms = nowValue();
    const cutoff = ms - retentionMs;
    const originalRunCount = runs.size;
    const terminal = [...runs.values()]
      .filter((run) => TERMINAL_RUN_STATUSES.has(run.status))
      .sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id));
    const keep = new Set([...runs.values()].filter((run) => ACTIVE_RUN_STATUSES.has(run.status)).map((run) => run.id));
    terminal.forEach((run, index) => {
      if (index < minimumTerminalRuns || Number(run.finishedAt || run.updatedAt) >= cutoff) keep.add(run.id);
    });
    const removedRuns = originalRunCount - keep.size;
    if (removedRuns === 0) return { removedRuns: 0, retainedRuns: runs.size };

    // The compaction itself remains visible. Persist this before rewriting: if
    // the atomic rewrite fails, no old evidence disappeared; if it succeeds,
    // the retained history still explains exactly what was removed.
    const pruneId = `prune:${ms}:${crypto.randomBytes(4).toString("hex")}`;
    create({
      id: pruneId,
      kind: "system",
      engines: [],
      summary: `Retention compacted ${removedRuns} terminal run${removedRuns === 1 ? "" : "s"}.`,
      artifacts: [{ type: "retention", id: pruneId }],
    });
    start(pruneId);
    finish(pruneId, "completed");
    keep.add(pruneId);
    events = events.filter((event) => keep.has(event.runId));
    runs = new Map([...runs.entries()].filter(([id]) => keep.has(id)));
    atomicRewrite(events.map((event) => JSON.stringify(event)).join("\n") + (events.length ? "\n" : ""));
    needsLeadingNewline = false;
    return { removedRuns, retainedRuns: runs.size };
  }

  load();
  return { create, transition, start, finish, get, list, eventsSince, recentEvents, eventsForRun, activeByEngine, interruptActive, prune, file };
}

module.exports = {
  RUN_KINDS,
  RUN_STATUSES,
  ACTIVE_RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
  createRunLedger,
  runResponse,
};
