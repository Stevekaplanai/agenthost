"use strict";

// Dormant Foundation-B candidate: the root-owned durable runs store (BUILD-PLAN
// Phase 1c; IPC contract §4.1 RunView, §6 run.accept/run.transition). A run is
// accepted queued; the service derives its `authority` (gate vs worker) from
// compiled kind/profile policy. Two transition surfaces enforce the contract's
// authority split:
//   - gateTransition(): the caller (source=gate). For gate-authority runs it
//     follows the compiled run-lifecycle matrix (terminal states only repeat).
//     For worker-authority runs it may ONLY park queued->waiting|gated, restore
//     waiting|gated->queued, or mark a never-launched run cancelled|skipped, and
//     only before launch. It can never write worker running or terminal states.
//   - serviceTransition(): PID 1 alone records worker `running` and terminal
//     outcomes.
//
// Semantics over an injected append-only log adapter; substrate deferred.
// DORMANT: not wired into any boot path; activation gated at Phase 1f. Every
// returned view is validated against the compiled RunView.

const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted", "skipped"]);
const GATE_RUN_TRANSITIONS = Object.freeze({
  queued: new Set(["running", "waiting", "gated", "failed", "cancelled", "interrupted", "skipped"]),
  running: new Set(["running", "waiting", "gated", "completed", "failed", "cancelled", "interrupted"]),
  waiting: new Set(["running", "waiting", "gated", "completed", "failed", "cancelled", "interrupted"]),
  gated: new Set(["queued", "running", "waiting", "gated", "failed", "cancelled", "interrupted", "skipped"]),
});
const BINDING_KEYS = ["id", "kind", "authority", "taskId", "chainId", "profileId", "repoId", "workMode", "engines"];

class RunsStoreError extends Error {
  constructor(code, message) { super(message); this.name = "RunsStoreError"; this.code = code; }
}
function fail(code, message) { throw new RunsStoreError(code, message); }

// Default authority policy: system runs are gate-owned; every worker kind is
// worker-authority. Overridable so the compiled policy can bind it at 1f.
function defaultAuthorityFor({ kind }) { return kind === "system" ? "gate" : "worker"; }

function createRunsStore({ log, now = Date.now, authorityFor = defaultAuthorityFor, validateRunView } = {}) {
  if (!log || typeof log.append !== "function" || typeof log.readAll !== "function") {
    throw new Error("runs store requires an append-only log adapter { append, readAll }");
  }
  if (typeof validateRunView !== "function") throw new Error("runs store requires the compiled validateRunView");

  const runs = new Map(); // id -> record

  function nowMs() {
    const v = Number(now());
    if (!Number.isSafeInteger(v) || v <= 0) fail("STORE_UNAVAILABLE", "runs clock is invalid");
    return v;
  }
  function viewOf(record) {
    const view = { ...record };
    delete view.type;
    validateRunView(view);
    return Object.freeze(view);
  }
  function bindingOf(view) {
    return JSON.stringify(BINDING_KEYS.map((k) => [k, view[k]]));
  }
  function replay() {
    let records;
    try { records = log.readAll(); } catch { fail("STORE_UNAVAILABLE", "runs log is unreadable"); }
    for (const r of records || []) {
      if (!r || r.type !== "run") continue;
      const record = { ...r };
      runs.set(record.id, record);
      viewOf(record);
    }
  }
  replay();

  function persist(record) {
    viewOf(record);
    try { log.append({ ...record, type: "run" }); } catch { fail("STORE_UNAVAILABLE", "run change could not be persisted"); }
    runs.set(record.id, { ...record, type: "run" });
  }

  function get(id) {
    const record = runs.get(id);
    return record ? viewOf(record) : null;
  }

  // All current run views (used by run.list and boot reconciliation).
  function list() {
    return [...runs.values()].map(viewOf);
  }

  // run.accept: create a queued run. `authority` is derived, never caller-chosen.
  // A duplicate id is idempotent only if the entire derived binding matches
  // byte-for-byte; any difference is RUN_CONFLICT.
  function accept(run) {
    if (!run || typeof run !== "object") fail("INVALID_REQUEST", "run is required");
    const kind = run.kind;
    const authority = authorityFor({ kind, profileId: run.profileId });
    const isSystem = kind === "system";
    const record = {
      id: run.id,
      kind,
      status: "queued",
      authority: isSystem ? "gate" : authority,
      taskId: isSystem ? null : run.taskId,
      chainId: isSystem ? null : run.chainId,
      profileId: isSystem ? null : run.profileId,
      repoId: isSystem ? null : run.repoId,
      workMode: isSystem ? null : run.workMode,
      engines: Array.isArray(run.engines) ? run.engines.slice() : run.engines,
      summary: run.summary ?? "",
      createdAtMs: nowMs(),
      startedAtMs: null,
      updatedAtMs: nowMs(),
      finishedAtMs: null,
      nextActions: run.nextActions ?? [],
      artifacts: run.artifacts ?? [],
      version: 1,
    };
    const view = viewOf(record); // validate the shape/binding
    const existing = runs.get(run.id);
    if (existing) {
      if (bindingOf(viewOf(existing)) !== bindingOf(view)) fail("RUN_CONFLICT", "an accepted run with this id has a different binding");
      return viewOf(existing);
    }
    persist(record);
    return view;
  }

  function applyTransition(record, to, patch) {
    const next = {
      ...record,
      status: to,
      version: record.version + 1,
      updatedAtMs: nowMs(),
      summary: patch.summary ?? record.summary,
      nextActions: patch.nextActions ?? record.nextActions,
      artifacts: patch.artifacts ?? record.artifacts,
    };
    if (to === "running" && next.startedAtMs === null) next.startedAtMs = nowMs();
    if (TERMINAL.has(to) && next.finishedAtMs === null) next.finishedAtMs = nowMs();
    delete next.type;
    persist(next);
    return viewOf(next);
  }

  // Caller (gate) transition — the authority split is enforced here.
  function gateTransition(id, { expectedVersion, to, summary, nextActions, artifacts } = {}) {
    const record = runs.get(id);
    if (!record) fail("STORE_UNAVAILABLE", "run not found");
    if (record.version !== expectedVersion) fail("STALE_VERSION", "expectedVersion does not match the run");

    if (record.authority === "worker") {
      if (record.startedAtMs !== null) fail("INVALID_TRANSITION", "the gate can only transition a worker run before launch");
      const prelaunch = new Set(["queued", "waiting", "gated"]);
      const restoring = (record.status === "waiting" || record.status === "gated") && to === "queued";
      const parking = record.status === "queued" && (to === "waiting" || to === "gated");
      const neverLaunchedTerminal = prelaunch.has(record.status) && (to === "cancelled" || to === "skipped");
      if (!(restoring || parking || neverLaunchedTerminal)) {
        fail("INVALID_TRANSITION", "the gate cannot write worker running or terminal lifecycle states");
      }
      return applyTransition(record, to, { summary, nextActions, artifacts });
    }

    // gate authority
    if (TERMINAL.has(record.status)) {
      if (to !== record.status) fail("INVALID_TRANSITION", "terminal gate runs can only repeat their current state");
      return applyTransition(record, to, { summary, nextActions, artifacts });
    }
    if (!GATE_RUN_TRANSITIONS[record.status]?.has(to)) fail("INVALID_TRANSITION", "gate transition is not allowed by the run lifecycle matrix");
    return applyTransition(record, to, { summary, nextActions, artifacts });
  }

  // Service (PID 1) transition — records worker running + terminal outcomes.
  function serviceTransition(id, { expectedVersion, to, summary, nextActions, artifacts } = {}) {
    const record = runs.get(id);
    if (!record) fail("STORE_UNAVAILABLE", "run not found");
    if (record.version !== expectedVersion) fail("STALE_VERSION", "expectedVersion does not match the run");
    if (record.authority !== "worker") fail("INVALID_TRANSITION", "service transitions apply to worker-authority runs");
    if (TERMINAL.has(record.status)) fail("INVALID_TRANSITION", "a terminal run has no service transition");
    const canRun = to === "running" && (record.status === "queued" || record.status === "waiting" || record.status === "gated" || record.status === "running");
    const canFinish = TERMINAL.has(to) && (record.status === "running" || record.status === "queued" || record.status === "waiting" || record.status === "gated");
    if (!(canRun || canFinish)) fail("INVALID_TRANSITION", "service can only record running or a terminal outcome");
    return applyTransition(record, to, { summary, nextActions, artifacts });
  }

  return Object.freeze({ accept, get, list, gateTransition, serviceTransition, GATE_RUN_TRANSITIONS });
}

module.exports = { createRunsStore, RunsStoreError, GATE_RUN_TRANSITIONS };
