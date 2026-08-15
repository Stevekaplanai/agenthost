"use strict";

// Dormant Foundation-A state core. It intentionally has no filesystem, network,
// process, or default-path access: a future root runtime must provide a reviewed
// trusted adapter whose operations are already bound to safe directory handles.

const { createHash } = require("node:crypto");
const { canonicalize, parseStrictJson } = require("./maintenance-protocol.js");

const STORE_VERSION = 1;
const MAX_JOURNAL_BYTES = 1024 * 1024;
const MAX_IDEMPOTENCY_RECORDS = 1_024;
const EPOCH_RE = /^gw_[0-9a-f]{32}$/;
const REQUEST_RE = /^req_[0-9a-f]{32}$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const MIGRATION_STATES = Object.freeze([
  "not_started",
  "secure_dirs",
  "agent_markers_moved",
  "stores_created",
  "legacy_labeled",
  "stopped_defaulted",
  "cutover_ready",
  "complete",
]);

class MaintenanceStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MaintenanceStoreError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new MaintenanceStoreError(code, message);
}

function exactObject(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("STORE_UNAVAILABLE", `${label} is invalid`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("STORE_UNAVAILABLE", `${label} has an invalid shape`);
  }
  return value;
}

function safeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail("STORE_UNAVAILABLE", `${label} is invalid`);
  return value;
}

function clone(value) {
  try {
    return JSON.parse(canonicalize(value));
  } catch {
    fail("INVALID_REQUEST", "Maintenance state must be JSON-safe");
  }
}

function recordDigest(value) {
  return "sha256:" + createHash("sha256").update(String(value), "utf8").digest("hex");
}

function requireSynchronousAdapterResult(value) {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return value;
  let then;
  try { then = value.then; } catch { fail("STORE_UNAVAILABLE", "Maintenance adapter result is invalid"); }
  if (typeof then === "function") {
    try { Promise.resolve(value).catch(() => {}); } catch { /* the unavailable result below is authoritative */ }
    fail("STORE_UNAVAILABLE", "Maintenance adapter operations must be synchronous");
  }
  return value;
}

function idempotencyKey(gatewayEpoch, requestId) {
  if (typeof gatewayEpoch !== "string" || !EPOCH_RE.test(gatewayEpoch)) fail("INVALID_REQUEST", "gatewayEpoch is invalid");
  if (typeof requestId !== "string" || !REQUEST_RE.test(requestId)) fail("INVALID_REQUEST", "requestId is invalid");
  return `${gatewayEpoch}\u0000${requestId}`;
}

function validateDigest(value) {
  if (typeof value !== "string" || !DIGEST_RE.test(value)) fail("INVALID_REQUEST", "request digest is invalid");
  return value;
}

function redactJson(value, redact) {
  const normalized = clone(value);
  function redactString(value) {
    let safe;
    try { safe = redact(value); } catch { fail("INVALID_REQUEST", "Maintenance redaction failed"); }
    if (typeof safe !== "string") fail("INVALID_REQUEST", "Maintenance redaction must return a string");
    return safe;
  }
  function visit(item) {
    if (typeof item === "string") return redactString(item);
    if (item === null || typeof item !== "object") return item;
    if (Array.isArray(item)) return item.map(visit);
    const safe = Object.create(null);
    for (const key of Object.keys(item)) {
      const safeKey = redactString(key);
      if (Object.prototype.hasOwnProperty.call(safe, safeKey)) {
        fail("INVALID_REQUEST", "Maintenance redaction collapses object keys");
      }
      Object.defineProperty(safe, safeKey, {
        value: visit(item[key]),
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    return safe;
  }
  return clone(visit(normalized));
}

function defaultFoundation(nowMs) {
  return {
    v: STORE_VERSION,
    type: "foundation",
    migrationState: "not_started",
    stop: {
      engaged: true,
      version: 1,
      reasonCode: "first_secure_migration",
      summary: "Maintenance foundation remains stopped until activation.",
      changedAtMs: nowMs,
    },
    atMs: nowMs,
  };
}

function validateStop(value) {
  exactObject(value, ["engaged", "version", "reasonCode", "summary", "changedAtMs"], "foundation stop");
  if (value.engaged !== true || value.version !== 1 || value.reasonCode !== "first_secure_migration" ||
      typeof value.summary !== "string" || value.summary.length > 500) {
    fail("STORE_UNAVAILABLE", "foundation stop is invalid");
  }
  safeInteger(value.changedAtMs, "foundation stop time");
  return value;
}

function validateFoundation(value) {
  exactObject(value, ["v", "type", "migrationState", "stop", "atMs"], "foundation record");
  if (value.v !== STORE_VERSION || value.type !== "foundation" || value.migrationState !== "not_started") {
    fail("STORE_UNAVAILABLE", "foundation record is invalid");
  }
  validateStop(value.stop);
  safeInteger(value.atMs, "foundation record time");
  return value;
}

function validateMigration(value) {
  exactObject(value, ["v", "type", "from", "to", "atMs"], "migration record");
  if (value.v !== STORE_VERSION || value.type !== "migration" ||
      !MIGRATION_STATES.includes(value.from) || !MIGRATION_STATES.includes(value.to)) {
    fail("STORE_UNAVAILABLE", "migration record is invalid");
  }
  safeInteger(value.atMs, "migration record time");
  return value;
}

function validateIdempotency(value) {
  exactObject(value, ["v", "type", "gatewayEpoch", "requestId", "digest", "response", "atMs"], "idempotency record");
  if (value.v !== STORE_VERSION || value.type !== "idempotency") fail("STORE_UNAVAILABLE", "idempotency record is invalid");
  idempotencyKey(value.gatewayEpoch, value.requestId);
  if (typeof value.digest !== "string" || !DIGEST_RE.test(value.digest)) fail("STORE_UNAVAILABLE", "idempotency digest is invalid");
  safeInteger(value.atMs, "idempotency record time");
  try { canonicalize(value.response); } catch { fail("STORE_UNAVAILABLE", "idempotency response is invalid"); }
  if (Buffer.byteLength(canonicalize(value.response), "utf8") > 524_288) {
    fail("STORE_UNAVAILABLE", "idempotency response is too large");
  }
  return value;
}

function expectedNext(state) {
  const index = MIGRATION_STATES.indexOf(state);
  return index === -1 || index === MIGRATION_STATES.length - 1 ? null : MIGRATION_STATES[index + 1];
}

function createMaintenanceStore({ adapter, now = Date.now, redact } = {}) {
  if (!adapter || typeof adapter.assertTrusted !== "function" || typeof adapter.readJournal !== "function" ||
      typeof adapter.appendJournal !== "function" || typeof adapter.quarantine !== "function") {
    throw new Error("Maintenance store requires a trusted adapter");
  }
  if (typeof now !== "function") throw new Error("Maintenance store requires a clock");
  if (typeof redact !== "function") throw new Error("Maintenance store requires a redactor");

  let current = null;
  let opened = false;
  let unavailable = false;

  function nowMs() {
    const value = Number(now());
    if (!Number.isSafeInteger(value) || value < 0) fail("STORE_UNAVAILABLE", "Maintenance clock is invalid");
    return value;
  }

  function snapshot() {
    if (!opened || unavailable || !current) return null;
    return clone({
      state: "ready",
      migrationState: current.migrationState,
      stop: current.stop,
      idempotencyRecords: current.idempotency.size,
    });
  }

  function health() {
    const view = snapshot();
    return view || Object.freeze({ state: "unavailable" });
  }

  function quarantine(raw) {
    try {
      const record = {
        v: STORE_VERSION,
        store: "foundation",
        reasonCode: "corrupt",
        recordDigest: recordDigest(raw),
      };
      requireSynchronousAdapterResult(adapter.quarantine(record));
    } catch { /* preserve the primary fail-closed result */ }
  }

  function markUnavailable(raw) {
    unavailable = true;
    opened = false;
    current = null;
    if (raw !== undefined) quarantine(raw);
    fail("STORE_UNAVAILABLE", "Maintenance store is unavailable");
  }

  function append(record) {
    let line;
    try { line = canonicalize(record); } catch { markUnavailable(); }
    try { requireSynchronousAdapterResult(adapter.appendJournal(line)); } catch { markUnavailable(); }
  }

  function parseJournal(raw) {
    if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > MAX_JOURNAL_BYTES) markUnavailable(raw);
    const lines = raw.split(/\r?\n/).filter((line) => line.length > 0);
    if (lines.length === 0) markUnavailable(raw);
    const state = { migrationState: "not_started", stop: null, idempotency: new Map() };
    let sawFoundation = false;
    try {
      for (const line of lines) {
        const record = parseStrictJson(Buffer.from(line, "utf8"));
        if (!record || typeof record !== "object" || Array.isArray(record)) fail("STORE_UNAVAILABLE", "Journal record is invalid");
        if (record.type === "foundation") {
          if (sawFoundation) fail("STORE_UNAVAILABLE", "Journal has multiple foundation records");
          validateFoundation(record);
          sawFoundation = true;
          state.stop = clone(record.stop);
          continue;
        }
        if (!sawFoundation) fail("STORE_UNAVAILABLE", "Journal foundation record is missing");
        if (record.type === "migration") {
          validateMigration(record);
          if (record.from !== state.migrationState || record.to !== expectedNext(record.from)) {
            fail("STORE_UNAVAILABLE", "Journal migration sequence is invalid");
          }
          state.migrationState = record.to;
          continue;
        }
        if (record.type === "idempotency") {
          validateIdempotency(record);
          const key = idempotencyKey(record.gatewayEpoch, record.requestId);
          const existing = state.idempotency.get(key);
          if (existing && (existing.digest !== record.digest || canonicalize(existing.response) !== canonicalize(record.response))) {
            fail("STORE_UNAVAILABLE", "Journal has conflicting idempotency records");
          }
          if (!existing && state.idempotency.size >= MAX_IDEMPOTENCY_RECORDS) {
            fail("STORE_UNAVAILABLE", "Journal idempotency limit is exceeded");
          }
          state.idempotency.set(key, { digest: record.digest, response: clone(record.response) });
          continue;
        }
        fail("STORE_UNAVAILABLE", "Journal record type is invalid");
      }
    } catch {
      markUnavailable(raw);
    }
    if (!sawFoundation) markUnavailable(raw);
    return state;
  }

  function open() {
    if (opened && !unavailable) return snapshot();
    if (unavailable) fail("STORE_UNAVAILABLE", "Maintenance store is unavailable");
    try { requireSynchronousAdapterResult(adapter.assertTrusted()); } catch { markUnavailable(); }
    let raw;
    try { raw = requireSynchronousAdapterResult(adapter.readJournal()); } catch { markUnavailable(); }
    if (raw === null) {
      const foundation = defaultFoundation(nowMs());
      append(foundation);
      current = { migrationState: foundation.migrationState, stop: clone(foundation.stop), idempotency: new Map() };
    } else {
      current = parseJournal(raw);
    }
    opened = true;
    return snapshot();
  }

  function requireOpen() {
    if (!opened) open();
    if (unavailable || !current) fail("STORE_UNAVAILABLE", "Maintenance store is unavailable");
  }

  function advanceMigration(to) {
    requireOpen();
    if (!MIGRATION_STATES.includes(to)) fail("INVALID_REQUEST", "Unknown migration state");
    if (to === current.migrationState) return snapshot();
    if (to !== expectedNext(current.migrationState)) fail("INVALID_TRANSITION", "Migration must advance one recorded step");
    append({ v: STORE_VERSION, type: "migration", from: current.migrationState, to, atMs: nowMs() });
    current.migrationState = to;
    return snapshot();
  }

  function lookupIdempotency({ gatewayEpoch, requestId, digest } = {}) {
    requireOpen();
    const key = idempotencyKey(gatewayEpoch, requestId);
    validateDigest(digest);
    const existing = current.idempotency.get(key);
    if (!existing) return Object.freeze({ action: "execute" });
    if (existing.digest !== digest) return Object.freeze({ action: "conflict" });
    return Object.freeze({ action: "replay", response: clone(existing.response) });
  }

  function commitIdempotency({ gatewayEpoch, requestId, digest, response } = {}) {
    requireOpen();
    const decision = lookupIdempotency({ gatewayEpoch, requestId, digest });
    if (decision.action !== "execute") return decision;
    if (current.idempotency.size >= MAX_IDEMPOTENCY_RECORDS) fail("STORE_UNAVAILABLE", "Maintenance idempotency capacity is unavailable");
    const key = idempotencyKey(gatewayEpoch, requestId);
    const safeResponse = redactJson(response, redact);
    if (Buffer.byteLength(canonicalize(safeResponse), "utf8") > 524_288) fail("INVALID_REQUEST", "Response exceeds the maintenance record limit");
    const record = { v: STORE_VERSION, type: "idempotency", gatewayEpoch, requestId, digest, response: safeResponse, atMs: nowMs() };
    append(record);
    current.idempotency.set(key, { digest, response: clone(safeResponse) });
    return Object.freeze({ action: "committed", response: clone(safeResponse) });
  }

  return Object.freeze({ open, health, snapshot, advanceMigration, lookupIdempotency, commitIdempotency });
}

module.exports = {
  STORE_VERSION,
  MIGRATION_STATES,
  MaintenanceStoreError,
  createMaintenanceStore,
};
