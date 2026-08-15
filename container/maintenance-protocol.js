"use strict";

const crypto = require("node:crypto");

const PROTOCOL_VERSION = 1;
const REQUEST_MAX_BYTES = 384 * 1024;
const RESPONSE_MAX_BYTES = 512 * 1024;
const FRAME_DEADLINE_MS = 2_000;
const READ_DEADLINE_MS = 2_000;
const MUTATION_DEADLINE_MS = 5_000;
const LAUNCH_DEADLINE_MS = 10_000;
const LIMITS_VIEW = Object.freeze({
  maxRequestBytes: REQUEST_MAX_BYTES,
  maxResponseBytes: RESPONSE_MAX_BYTES,
  maxObjectiveBytes: 131_072,
  maxOutputReadBytes: 65_536,
  maxListItems: 200,
  maxInFlight: 1,
  heartbeatIntervalMs: 5_000,
  heartbeatTimeoutMs: 20_000,
  readDeadlineMs: READ_DEADLINE_MS,
  mutationDeadlineMs: MUTATION_DEADLINE_MS,
  launchDeadlineMs: LAUNCH_DEADLINE_MS,
});

const EPOCH_RE = /^gw_[0-9a-f]{32}$/;
const REQUEST_ID_RE = /^req_[0-9a-f]{32}$/;
const SHA_RE = /^sha256:[0-9a-f]{64}$/;
const STABLE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const OPAQUE_RE = /^[a-z]+_[A-Za-z0-9_-]{22,86}$/;
const PROFILE_RE = /^[a-z][a-z0-9_.-]{1,63}$/;
const REPO_RE = /^repo_[0-9a-f]{16,64}$/;
const ACTION_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const ENGINE_VALUES = new Set(["claude", "codex", "gemini", "hermes"]);
const RUN_KINDS = new Set([
  "chat", "team_chat", "brain", "loop", "multi_loop", "board_task",
  "git_ladder", "board_runner", "wake_check", "mail_cycle", "system",
]);
const RUN_STATUSES = new Set([
  "queued", "running", "waiting", "gated", "completed", "failed",
  "cancelled", "interrupted", "skipped",
]);
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted", "skipped"]);
const GATE_RUN_TRANSITIONS = Object.freeze({
  queued: new Set(["running", "waiting", "gated", "failed", "cancelled", "interrupted", "skipped"]),
  running: new Set(["running", "waiting", "gated", "completed", "failed", "cancelled", "interrupted"]),
  waiting: new Set(["running", "waiting", "gated", "completed", "failed", "cancelled", "interrupted"]),
  gated: new Set(["queued", "running", "waiting", "gated", "failed", "cancelled", "interrupted", "skipped"]),
});
const CLAIM_STATES = new Set([
  "active", "awaiting_review", "reviewing", "correction_required", "completed",
  "failed", "cancelled", "interrupted", "released", "quarantined",
]);
const WORKER_STATES = new Set([
  "intent", "spawn_attempt", "starting", "running", "stopping", "cleaning",
  "completed", "failed", "cancelled", "interrupted", "quarantined",
]);
const RECOVERY_STATES = new Set(["requested", "stopping", "cleaning", "complete", "quarantined"]);
const ERROR_CODES = new Set([
  "INVALID_REQUEST", "UNAUTHORIZED_PEER", "VERSION_MISMATCH", "PROTOCOL_ERROR",
  "FRAME_TOO_LARGE", "TRUNCATED_FRAME", "INFLIGHT_VIOLATION",
  "DEADLINE_EXCEEDED", "STALE_EPOCH", "IDEMPOTENCY_CONFLICT", "UNKNOWN_METHOD",
  "NOT_RECONCILED", "STORE_UNAVAILABLE", "OPERATOR_AUTH_REQUIRED",
  "ACTION_NOT_ALLOWED", "OPERATOR_TARGET_MISMATCH", "STALE_HANDLE",
  "INVALID_TRANSITION", "WORKER_ACTIVE", "BUDGET_UNSETTLED",
  "CLAIM_NOT_TERMINAL", "RECOVERY_IN_PROGRESS", "RECOVERY_NOT_ELIGIBLE",
  "RECOVERY_QUARANTINED", "STOP_ENGAGED", "LANE_BUSY", "CLAIM_CONFLICT",
  "BUDGET_EXHAUSTED", "PROFILE_UNAVAILABLE", "REPOSITORY_UNAVAILABLE",
  "RUN_NOT_ACCEPTED", "RUN_CONFLICT", "LAUNCH_AMBIGUOUS", "SPAWN_FAILED",
  "OUTPUT_CURSOR_INVALID", "OUTPUT_UNAVAILABLE", "STALE_VERSION",
  "GLOBAL_QUARANTINE", "INVALID_POLICY", "EVENT_CODE_RESERVED",
  "INTERNAL_RESPONSE_INVALID", "ALREADY_DRAINING",
]);
const GATE_RUN_EVENT_CODES = new Set([
  "accepted", "gate_queued", "gate_running", "gate_waiting", "gate_gated",
  "gate_completed", "gate_failed", "gate_cancelled", "gate_interrupted", "gate_skipped",
]);
const SERVICE_RUN_EVENT_CODES = new Set([
  "service_launch_intent", "service_spawn_attempt", "service_child_observed",
  "service_running", "service_completed", "service_failed", "service_cancelled",
  "service_interrupted", "service_quarantined", "service_retention",
]);
const RUN_EVENT_STATUSES = Object.freeze({
  accepted: new Set(["queued"]),
  gate_queued: new Set(["queued"]),
  gate_running: new Set(["running"]),
  gate_waiting: new Set(["waiting"]),
  gate_gated: new Set(["gated"]),
  gate_completed: new Set(["completed"]),
  gate_failed: new Set(["failed"]),
  gate_cancelled: new Set(["cancelled"]),
  gate_interrupted: new Set(["interrupted"]),
  gate_skipped: new Set(["skipped"]),
  service_launch_intent: new Set(["queued"]),
  service_spawn_attempt: new Set(["queued"]),
  service_child_observed: new Set(["running"]),
  service_running: new Set(["running"]),
  service_completed: new Set(["completed"]),
  service_failed: new Set(["failed"]),
  service_cancelled: new Set(["cancelled"]),
  service_interrupted: new Set(["interrupted"]),
  service_quarantined: new Set(["failed", "interrupted"]),
  service_retention: new Set(["completed", "failed", "cancelled", "interrupted", "skipped"]),
});

class ProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProtocolError(code, message);
}

function utf8Bytes(value) {
  return Buffer.byteLength(value, "utf8");
}

function hasLoneSurrogate(value) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function parseStrictJson(input, limits = {}) {
  let text;
  try {
    text = typeof input === "string"
      ? input
      : new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    fail("PROTOCOL_ERROR", "JSON frame is not valid UTF-8");
  }

  const maxDepth = limits.maxDepth || 12;
  const maxKeys = limits.maxKeys || 1_024;
  const maxMembers = limits.maxMembers || 2_048;
  let index = 0;
  let keys = 0;
  let members = 0;

  function whitespace() {
    while (index < text.length && /[\x20\x09\x0a\x0d]/.test(text[index])) index++;
  }

  function string() {
    const start = index;
    if (text[index++] !== '"') fail("PROTOCOL_ERROR", "Expected a JSON string");
    let escaped = false;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      const char = text[index++];
      if (!escaped && char === '"') {
        let value;
        try { value = JSON.parse(text.slice(start, index)); }
        catch { fail("PROTOCOL_ERROR", "Invalid JSON string escape"); }
        if (hasLoneSurrogate(value)) fail("PROTOCOL_ERROR", "JSON string contains a lone surrogate");
        return value;
      }
      if (!escaped && code < 0x20) fail("PROTOCOL_ERROR", "JSON string contains a raw control byte");
      if (!escaped && char === "\\") escaped = true;
      else escaped = false;
    }
    fail("TRUNCATED_FRAME", "JSON string is truncated");
  }

  function number() {
    const match = text.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!match) fail("PROTOCOL_ERROR", "Invalid JSON number");
    index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) fail("INVALID_REQUEST", "JSON number must be finite");
    if (Object.is(value, -0)) fail("INVALID_REQUEST", "JSON negative zero is forbidden");
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      fail("INVALID_REQUEST", "JSON integer must be a safe number");
    }
    return value;
  }

  function value(depth) {
    if (depth > maxDepth) fail("INVALID_REQUEST", "JSON nesting exceeds the protocol limit");
    whitespace();
    const char = text[index];
    if (char === '"') return string();
    if (char === "{") {
      index++;
      const out = {};
      const seen = new Set();
      whitespace();
      if (text[index] === "}") { index++; return out; }
      while (index < text.length) {
        whitespace();
        if (text[index] !== '"') fail("PROTOCOL_ERROR", "JSON object key must be a string");
        const key = string();
        if (seen.has(key)) fail("PROTOCOL_ERROR", `Duplicate JSON key: ${key}`);
        seen.add(key);
        if (++keys > maxKeys) fail("INVALID_REQUEST", "JSON object key limit exceeded");
        whitespace();
        if (text[index++] !== ":") fail("PROTOCOL_ERROR", "Expected colon after JSON object key");
        Object.defineProperty(out, key, {
          value: value(depth + 1), enumerable: true, configurable: true, writable: true,
        });
        whitespace();
        const delimiter = text[index++];
        if (delimiter === "}") return out;
        if (delimiter !== ",") fail("PROTOCOL_ERROR", "Expected comma or object close");
      }
      fail("TRUNCATED_FRAME", "JSON object is truncated");
    }
    if (char === "[") {
      index++;
      const out = [];
      whitespace();
      if (text[index] === "]") { index++; return out; }
      while (index < text.length) {
        if (++members > maxMembers) fail("INVALID_REQUEST", "JSON array member limit exceeded");
        out.push(value(depth + 1));
        whitespace();
        const delimiter = text[index++];
        if (delimiter === "]") return out;
        if (delimiter !== ",") fail("PROTOCOL_ERROR", "Expected comma or array close");
      }
      fail("TRUNCATED_FRAME", "JSON array is truncated");
    }
    if (text.startsWith("true", index)) { index += 4; return true; }
    if (text.startsWith("false", index)) { index += 5; return false; }
    if (text.startsWith("null", index)) { index += 4; return null; }
    return number();
  }

  const result = value(0);
  whitespace();
  if (index !== text.length) fail("PROTOCOL_ERROR", "JSON has trailing bytes");
  return result;
}

function canonicalize(value, depth = 0) {
  if (depth > 12) fail("INVALID_REQUEST", "Canonical JSON nesting exceeds the protocol limit");
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) fail("INVALID_REQUEST", "Canonical JSON requires a finite non-negative-zero number");
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) fail("INVALID_REQUEST", "Canonical JSON integer must be a safe number");
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    if (hasLoneSurrogate(value)) fail("INVALID_REQUEST", "Canonical JSON string contains a lone surrogate");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (!Object.hasOwn(value, i)) fail("INVALID_REQUEST", "Canonical JSON arrays cannot be sparse");
    }
    return `[${value.map((item) => canonicalize(item, depth + 1)).join(",")}]`;
  }
  if (typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => {
      if (hasLoneSurrogate(key)) fail("INVALID_REQUEST", "Canonical JSON key contains a lone surrogate");
      if (value[key] === undefined || typeof value[key] === "function" || typeof value[key] === "symbol" || typeof value[key] === "bigint") {
        fail("INVALID_REQUEST", `Canonical JSON contains unsupported value at ${key}`);
      }
      return `${JSON.stringify(key)}:${canonicalize(value[key], depth + 1)}`;
    }).join(",")}}`;
  }
  fail("INVALID_REQUEST", "Canonical JSON contains an unsupported value");
}

function validationSnapshot(value, maxBytes, sizeCode, sizeMessage, limits) {
  const canonical = canonicalize(value);
  if (utf8Bytes(canonical) > maxBytes) fail(sizeCode, sizeMessage);
  return parseStrictJson(Buffer.from(canonical, "utf8"), limits);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function digest(domain, value) {
  return "sha256:" + crypto.createHash("sha256")
    .update(domain, "utf8")
    .update(Buffer.from([0]))
    .update(canonicalize(value), "utf8")
    .digest("hex");
}

function requestDigest(requestValue) {
  return digest("agenthost-ipc-request-v1", {
    v: requestValue.v,
    gatewayEpoch: requestValue.gatewayEpoch,
    deadlineMs: requestValue.deadlineMs,
    method: requestValue.method,
    params: requestValue.params,
  });
}

function operatorTargetDigest(target) {
  return digest("agenthost-operator-target-v1", target);
}

function contractDigest(contract) {
  return digest("agenthost-contract-v1", contract);
}

function exactObject(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_REQUEST", `${label} must be an object`);
  const allowed = new Set(fields);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("INVALID_REQUEST", `${label} has unknown field: ${key}`);
  }
  for (const key of fields) {
    if (!Object.hasOwn(value, key)) fail("INVALID_REQUEST", `${label} is missing field: ${key}`);
  }
  return value;
}

function oneOf(value, allowed, label) {
  if (!allowed.has(value)) fail("INVALID_REQUEST", `${label} is invalid`);
  return value;
}

function integer(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail("INVALID_REQUEST", `${label} must be an integer from ${min} through ${max}`);
  return value;
}

function string(value, label, { min = 0, maxChars = Infinity, maxBytes = Infinity, pattern } = {}) {
  if (typeof value !== "string" || value.length < min || value.length > maxChars || utf8Bytes(value) > maxBytes || hasLoneSurrogate(value)) {
    fail("INVALID_REQUEST", `${label} is invalid`);
  }
  if (pattern && !pattern.test(value)) fail("INVALID_REQUEST", `${label} has an invalid format`);
  return value;
}

function nullable(value, validate) {
  return value === null ? null : validate(value);
}

function stableId(value, label) { return string(value, label, { pattern: STABLE_ID_RE }); }
function opaqueRef(value, label) { return string(value, label, { pattern: OPAQUE_RE }); }
function handle(value, label) { return opaqueRef(value, label); }
function sha(value, label) { return string(value, label, { pattern: SHA_RE }); }
function engine(value, label) { return oneOf(value, ENGINE_VALUES, label); }
function summary(value, label) { return string(value, label, { maxChars: 500, maxBytes: 2_000 }); }

function objective(value) {
  string(value, "objective", { min: 1, maxBytes: 131_072 });
  for (const char of value) {
    const code = char.codePointAt(0);
    if ((code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) || (code >= 0x7f && code <= 0x9f)) {
      fail("INVALID_REQUEST", "objective contains a forbidden control character");
    }
  }
  return value;
}

function action(value) {
  exactObject(value, ["id", "label"], "action");
  string(value.id, "action.id", { pattern: ACTION_ID_RE });
  string(value.label, "action.label", { min: 1, maxChars: 120, maxBytes: 480 });
  return value;
}

function artifact(value) {
  exactObject(value, ["type", "id", "label", "ref"], "artifact");
  string(value.type, "artifact.type", { pattern: ACTION_ID_RE });
  nullable(value.id, (item) => string(item, "artifact.id", { maxChars: 300, maxBytes: 1_200 }));
  nullable(value.label, (item) => string(item, "artifact.label", { maxChars: 300, maxBytes: 1_200 }));
  nullable(value.ref, (item) => string(item, "artifact.ref", {
    maxChars: 1_000, maxBytes: 4_000, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,999}$/,
  }));
  return value;
}

function boundedArray(value, validator, max, label) {
  if (!Array.isArray(value) || value.length > max) fail("INVALID_REQUEST", `${label} must be an array of at most ${max} items`);
  value.forEach(validator);
  return value;
}

function uniqueArray(value, label) {
  if (new Set(value).size !== value.length) fail("INVALID_REQUEST", `${label} cannot contain duplicates`);
  return value;
}

function profileBindingKey(profileId, engineValue, runKind, repoId) {
  return canonicalize({ engine: engineValue, profileId, repoId, runKind });
}

function requireProfileBinding(context, profileId, engineValue, runKind, repoId) {
  if (!(context.profileBindings instanceof Set)) fail("INVALID_POLICY", "Compiled profile binding catalog is required");
  if (!context.profileBindings.has(profileBindingKey(profileId, engineValue, runKind, repoId))) {
    fail("PROFILE_UNAVAILABLE", "The profile, engine, run kind, and repository tuple is not compiled into the service");
  }
}

function requireContractDigest(context, supplied) {
  if (!context || typeof context.expectedContractDigest !== "string" || !SHA_RE.test(context.expectedContractDigest)) {
    fail("INVALID_POLICY", "The compiled contract digest is required");
  }
  if (supplied !== context.expectedContractDigest) fail("VERSION_MISMATCH", "The supplied contract digest does not match the service contract");
}

function requireGatewayEpoch(context, supplied) {
  if (!context || typeof context.gatewayEpoch !== "string" || !EPOCH_RE.test(context.gatewayEpoch)) {
    fail("STALE_EPOCH", "The current service gateway epoch is required");
  }
  if (supplied !== context.gatewayEpoch) fail("STALE_EPOCH", "Gateway epoch is stale");
}

function validateAcceptedRunBinding(value) {
  exactObject(value, ["id", "kind", "authority", "taskId", "chainId", "profileId", "repoId", "workMode", "engines"], "acceptedRun");
  stableId(value.id, "acceptedRun.id");
  oneOf(value.kind, RUN_KINDS, "acceptedRun.kind");
  if (value.kind === "system" || value.authority !== "worker") fail("RUN_CONFLICT", "Accepted run is not worker-authority work");
  stableId(value.taskId, "acceptedRun.taskId");
  stableId(value.chainId, "acceptedRun.chainId");
  string(value.profileId, "acceptedRun.profileId", { pattern: PROFILE_RE });
  string(value.repoId, "acceptedRun.repoId", { pattern: REPO_RE });
  oneOf(value.workMode, new Set(["new", "review", "correction"]), "acceptedRun.workMode");
  uniqueArray(boundedArray(value.engines, (item) => engine(item, "acceptedRun.engines[]"), 20, "acceptedRun.engines"), "acceptedRun.engines");
  if (value.engines.length === 0) fail("RUN_CONFLICT", "Accepted worker run must name at least one engine");
  return value;
}

function validateRunTransitionAuthority(params, context) {
  let current;
  try {
    current = validateRunView(context.currentRun);
  } catch {
    fail("RUN_CONFLICT", "A root-resolved current run is required for transition validation");
  }
  if (current.id !== params.runId) fail("RUN_CONFLICT", "Current run identity does not match the transition request");
  if (current.version !== params.expectedVersion) fail("STALE_VERSION", "Current run version does not match the transition request");

  if (current.authority === "worker") {
    if (current.startedAtMs !== null) {
      fail("INVALID_TRANSITION", "The gate can only transition a worker run before launch");
    }
    const prelaunch = new Set(["queued", "waiting", "gated"]);
    const restoring = (current.status === "waiting" || current.status === "gated") && params.to === "queued";
    const parking = current.status === "queued" && (params.to === "waiting" || params.to === "gated");
    const neverLaunchedTerminal = prelaunch.has(current.status) &&
      (params.to === "cancelled" || params.to === "skipped");
    if (!(restoring || parking || neverLaunchedTerminal)) {
      fail("INVALID_TRANSITION", "The gate cannot write worker running or terminal lifecycle states");
    }
    return current;
  }

  if (TERMINAL_RUN_STATUSES.has(current.status)) {
    if (params.to !== current.status) fail("INVALID_TRANSITION", "Terminal gate runs can only repeat their current state");
    return current;
  }
  if (!GATE_RUN_TRANSITIONS[current.status]?.has(params.to)) {
    fail("INVALID_TRANSITION", "Gate transition is not allowed by the run lifecycle matrix");
  }
  return current;
}

function validateWorkStartAuthority(params, context) {
  if (!context.acceptedRun) fail("RUN_NOT_ACCEPTED", "Root-owned accepted run binding is required");
  validateAcceptedRunBinding(context.acceptedRun);
  for (const [paramKey, runKey] of [["runId", "id"], ["taskId", "taskId"], ["chainId", "chainId"], ["profileId", "profileId"], ["repoId", "repoId"], ["mode", "workMode"]]) {
    if (params[paramKey] !== context.acceptedRun[runKey]) fail("RUN_CONFLICT", `work.start ${paramKey} does not match the accepted run`);
  }
  if (!context.acceptedRun.engines.includes(params.engine)) fail("RUN_CONFLICT", "work.start engine does not match the accepted run");
  requireProfileBinding(context, params.profileId, params.engine, context.acceptedRun.kind, params.repoId);
}

function validatePostReplayAuthority(request, context) {
  if (request.method === "work.start") validateWorkStartAuthority(request.params, context);
  if (request.method === "run.transition") validateRunTransitionAuthority(request.params, context);
}

function operatorProofSyntax(value) {
  exactObject(value, ["actionHandle", "action", "targetDigest", "expiresAtMs"], "operatorProof");
  handle(value.actionHandle, "operatorProof.actionHandle");
  oneOf(value.action, new Set(["stop_resume", "stop_engage", "worker_cancel", "budget_policy_change"]), "operatorProof.action");
  sha(value.targetDigest, "operatorProof.targetDigest");
  integer(value.expiresAtMs, 0, Number.MAX_SAFE_INTEGER, "operatorProof.expiresAtMs");
  return value;
}

function operatorProof(value, actionValue, target, context, mode = "syntax") {
  operatorProofSyntax(value);
  if (value.action !== actionValue) fail("OPERATOR_AUTH_REQUIRED", "Operator proof is for a different action");
  if (value.targetDigest !== operatorTargetDigest(target)) fail("OPERATOR_TARGET_MISMATCH", "Operator proof target does not match request parameters");

  if (mode === "syntax") return value;
  if (mode !== "consume") fail("INVALID_POLICY", "Unknown operator proof validation mode");
  if (!Number.isSafeInteger(context.nowMs)) fail("OPERATOR_AUTH_REQUIRED", "Operator proof validation requires the service clock");
  if (value.expiresAtMs <= context.nowMs || value.expiresAtMs > context.nowMs + 30_000) fail("OPERATOR_AUTH_REQUIRED", "Operator proof is expired or exceeds its 30-second lifetime");

  const registry = context.operatorProofRegistry;
  if (!registry || typeof registry.consume !== "function") fail("OPERATOR_AUTH_REQUIRED", "Operator proof registry is required");
  if (typeof context.connectionId !== "string" || context.connectionId.length === 0 || context.connectionId.length > 128) {
    fail("OPERATOR_AUTH_REQUIRED", "Operator proof connection identity is required");
  }
  requireGatewayEpoch(context, context.gatewayEpoch);
  if (typeof context.operatorSessionDigest !== "string" || !SHA_RE.test(context.operatorSessionDigest)) {
    fail("OPERATOR_AUTH_REQUIRED", "Current operator session digest is required");
  }
  const record = registry.consume(value.actionHandle, {
    connectionId: context.connectionId,
    epoch: context.gatewayEpoch,
    kind: "operator_proof",
  });
  if (!record || typeof record !== "object" || Array.isArray(record)) fail("OPERATOR_AUTH_REQUIRED", "Operator proof record is invalid");
  const fields = ["action", "targetDigest", "operatorSessionDigest", "issuedAtMs", "expiresAtMs"];
  if (Object.keys(record).length !== fields.length || fields.some((field) => !Object.hasOwn(record, field))) {
    fail("OPERATOR_AUTH_REQUIRED", "Operator proof record is invalid");
  }
  if (record.action !== value.action || record.targetDigest !== value.targetDigest ||
      record.operatorSessionDigest !== context.operatorSessionDigest || record.expiresAtMs !== value.expiresAtMs) {
    fail("OPERATOR_AUTH_REQUIRED", "Operator proof record does not match the request and current session");
  }
  if (!Number.isSafeInteger(record.issuedAtMs) || record.issuedAtMs > context.nowMs ||
      record.expiresAtMs - record.issuedAtMs < 1 || record.expiresAtMs - record.issuedAtMs > 30_000) {
    fail("OPERATOR_AUTH_REQUIRED", "Operator proof record does not have a valid 30-second issuance window");
  }
  return value;
}

const CALLER_AUDIT = {
  client_disconnected: {
    severities: new Set(["info"]),
    detail(value) {
      exactObject(value, ["surface"], "audit.detail");
      oneOf(value.surface, new Set(["chat", "team_chat", "board", "terminal"]), "audit.detail.surface");
    },
  },
  operator_action_requested: {
    severities: new Set(["info"]),
    detail(value) {
      exactObject(value, ["action", "targetDigest"], "audit.detail");
      oneOf(value.action, new Set(["stop_resume", "stop_engage", "worker_cancel", "budget_policy_change"]), "audit.detail.action");
      sha(value.targetDigest, "audit.detail.targetDigest");
    },
  },
  gateway_degraded: {
    severities: new Set(["warning", "error"]),
    detail(value) {
      exactObject(value, ["reasonCode"], "audit.detail");
      oneOf(value.reasonCode, new Set(["service_timeout", "service_unavailable", "response_invalid", "contract_mismatch"]), "audit.detail.reasonCode");
    },
  },
  scheduler_denied: {
    severities: new Set(["info", "warning"]),
    detail(value) {
      exactObject(value, ["reasonCode"], "audit.detail");
      oneOf(value.reasonCode, new Set([
        "stopped", "lane_busy", "claim_conflict", "budget_exhausted",
        "profile_unavailable", "run_not_accepted", "repository_unavailable",
      ]), "audit.detail.reasonCode");
    },
  },
  scheduler_parked: {
    severities: new Set(["info", "warning"]),
    detail(value) {
      exactObject(value, ["reasonCode"], "audit.detail");
      oneOf(value.reasonCode, new Set(["awaiting_review", "correction_required", "human_gate", "global_quarantine"]), "audit.detail.reasonCode");
    },
  },
  ui_action: {
    severities: new Set(["info"]),
    detail(value) {
      exactObject(value, ["action"], "audit.detail");
      oneOf(value.action, new Set(["view_opened", "run_inspected", "history_paged", "stop_status_viewed"]), "audit.detail.action");
    },
  },
};

const SERVICE_AUDIT_CODES = new Set([
  "unexpected_peer", "gateway_connected", "gateway_lost", "launch_authorized",
  "spawn_attempted", "child_observed", "worker_signal_sent", "worker_reaped",
  "containment_revoked", "recovery_completed", "recovery_quarantined",
  "budget_reserved", "budget_settled", "stop_changed", "migration_step",
  "store_degraded", "record_quarantined",
]);

function validateServiceAuditDetail(eventCode, severity, detail) {
  const expectedSeverity = {
    unexpected_peer: "warning", gateway_connected: "info", gateway_lost: "warning",
    launch_authorized: "info", spawn_attempted: "info", child_observed: "info",
    worker_signal_sent: "warning", worker_reaped: "info", containment_revoked: "info",
    recovery_completed: "warning", recovery_quarantined: "error",
    budget_reserved: "info", budget_settled: "info", stop_changed: "warning",
    migration_step: "info", store_degraded: "error", record_quarantined: "warning",
  }[eventCode];
  if (severity !== expectedSeverity) fail("INTERNAL_RESPONSE_INVALID", "Service audit severity does not match its event code");

  switch (eventCode) {
    case "unexpected_peer":
      exactObject(detail, ["reasonCode"], "AuditView.detail");
      oneOf(detail.reasonCode, new Set(["wrong_uid", "wrong_gid", "wrong_pid", "second_connection"]), "AuditView.detail.reasonCode");
      break;
    case "gateway_connected":
      exactObject(detail, ["epochDigest"], "AuditView.detail");
      sha(detail.epochDigest, "AuditView.detail.epochDigest");
      break;
    case "gateway_lost":
      exactObject(detail, ["reasonCode"], "AuditView.detail");
      oneOf(detail.reasonCode, new Set(["eof", "protocol", "heartbeat_timeout", "process_exit", "drain"]), "AuditView.detail.reasonCode");
      break;
    case "launch_authorized":
      exactObject(detail, ["claimRef", "workerRef", "profileId"], "AuditView.detail");
      opaqueRef(detail.claimRef, "AuditView.detail.claimRef");
      opaqueRef(detail.workerRef, "AuditView.detail.workerRef");
      string(detail.profileId, "AuditView.detail.profileId", { pattern: PROFILE_RE });
      break;
    case "spawn_attempted":
    case "child_observed":
      exactObject(detail, ["claimRef", "workerRef"], "AuditView.detail");
      opaqueRef(detail.claimRef, "AuditView.detail.claimRef");
      opaqueRef(detail.workerRef, "AuditView.detail.workerRef");
      break;
    case "worker_signal_sent":
      exactObject(detail, ["workerRef", "signalCode"], "AuditView.detail");
      opaqueRef(detail.workerRef, "AuditView.detail.workerRef");
      oneOf(detail.signalCode, new Set(["term", "kill"]), "AuditView.detail.signalCode");
      break;
    case "worker_reaped":
      exactObject(detail, ["workerRef", "exitCode", "signalName"], "AuditView.detail");
      opaqueRef(detail.workerRef, "AuditView.detail.workerRef");
      nullable(detail.exitCode, (item) => integer(item, 0, 255, "AuditView.detail.exitCode"));
      nullable(detail.signalName, (item) => string(item, "AuditView.detail.signalName", { pattern: /^[A-Z][A-Z0-9]{1,31}$/ }));
      break;
    case "containment_revoked":
      exactObject(detail, ["workerRef"], "AuditView.detail");
      opaqueRef(detail.workerRef, "AuditView.detail.workerRef");
      break;
    case "recovery_completed":
      exactObject(detail, ["claimRef", "recoveryRef"], "AuditView.detail");
      opaqueRef(detail.claimRef, "AuditView.detail.claimRef");
      opaqueRef(detail.recoveryRef, "AuditView.detail.recoveryRef");
      break;
    case "recovery_quarantined":
      exactObject(detail, ["claimRef", "recoveryRef", "reasonCode"], "AuditView.detail");
      opaqueRef(detail.claimRef, "AuditView.detail.claimRef");
      opaqueRef(detail.recoveryRef, "AuditView.detail.recoveryRef");
      oneOf(detail.reasonCode, new Set(["child_unknown", "descendant_alive", "reap_unproven", "mount_present", "store_unavailable"]), "AuditView.detail.reasonCode");
      break;
    case "budget_reserved":
      exactObject(detail, ["chainId", "workerRef", "tokenUnits", "costMicros"], "AuditView.detail");
      stableId(detail.chainId, "AuditView.detail.chainId");
      opaqueRef(detail.workerRef, "AuditView.detail.workerRef");
      integer(detail.tokenUnits, 0, Number.MAX_SAFE_INTEGER, "AuditView.detail.tokenUnits");
      integer(detail.costMicros, 0, Number.MAX_SAFE_INTEGER, "AuditView.detail.costMicros");
      break;
    case "budget_settled":
      exactObject(detail, ["chainId", "workerRef", "tokenUnits", "costMicros", "mode"], "AuditView.detail");
      stableId(detail.chainId, "AuditView.detail.chainId");
      opaqueRef(detail.workerRef, "AuditView.detail.workerRef");
      integer(detail.tokenUnits, 0, Number.MAX_SAFE_INTEGER, "AuditView.detail.tokenUnits");
      integer(detail.costMicros, 0, Number.MAX_SAFE_INTEGER, "AuditView.detail.costMicros");
      oneOf(detail.mode, new Set(["observed", "full_charge", "proven_no_spawn_refund"]), "AuditView.detail.mode");
      break;
    case "stop_changed":
      exactObject(detail, ["engaged", "version", "reasonCode"], "AuditView.detail");
      if (typeof detail.engaged !== "boolean") fail("INTERNAL_RESPONSE_INVALID", "AuditView.detail.engaged must be boolean");
      integer(detail.version, 0, Number.MAX_SAFE_INTEGER, "AuditView.detail.version");
      string(detail.reasonCode, "AuditView.detail.reasonCode", { pattern: ACTION_ID_RE });
      break;
    case "migration_step":
      exactObject(detail, ["step"], "AuditView.detail");
      oneOf(detail.step, new Set(["not_started", "secure_dirs", "agent_markers_moved", "stores_created", "legacy_labeled", "stopped_defaulted", "cutover_ready", "complete"]), "AuditView.detail.step");
      break;
    case "store_degraded":
      exactObject(detail, ["store", "reasonCode"], "AuditView.detail");
      oneOf(detail.store, new Set(["claims", "runs", "stop", "budgets", "audit", "idempotency"]), "AuditView.detail.store");
      oneOf(detail.reasonCode, new Set(["open_failed", "owner_mismatch", "mode_mismatch", "wrong_type", "symlink", "corrupt", "disk_full", "sync_failed"]), "AuditView.detail.reasonCode");
      break;
    case "record_quarantined":
      exactObject(detail, ["store", "reasonCode"], "AuditView.detail");
      oneOf(detail.store, new Set(["claims", "runs", "stop", "budgets", "audit", "idempotency"]), "AuditView.detail.store");
      oneOf(detail.reasonCode, new Set(["schema_invalid", "torn_write", "redaction_failed"]), "AuditView.detail.reasonCode");
      break;
    default:
      fail("INTERNAL_RESPONSE_INVALID", "Unknown service audit event code");
  }
}

function validateParams(method, params, context) {
  switch (method) {
    case "session.open":
      exactObject(params, ["protocolVersion", "contractDigest"], "params");
      if (params.protocolVersion !== 1) fail("VERSION_MISMATCH", "protocolVersion must be 1");
      sha(params.contractDigest, "contractDigest");
      break;
    case "session.ready":
      exactObject(params, ["contractDigest"], "params");
      sha(params.contractDigest, "contractDigest");
      break;
    case "session.heartbeat":
      exactObject(params, ["lastServiceSeq"], "params");
      integer(params.lastServiceSeq, 0, Number.MAX_SAFE_INTEGER, "lastServiceSeq");
      break;
    case "session.drain":
      exactObject(params, ["reasonCode"], "params");
      oneOf(params.reasonCode, new Set(["restart", "shutdown", "upgrade"]), "reasonCode");
      break;
    case "service.health":
    case "stop.get":
    case "budget.policy.get":
      exactObject(params, [], "params");
      break;
    case "operator.action.begin":
      exactObject(params, ["action", "operatorSessionDigest", "targetDigest"], "params");
      oneOf(params.action, new Set(["stop_resume", "stop_engage", "worker_cancel", "budget_policy_change"]), "action");
      sha(params.operatorSessionDigest, "operatorSessionDigest");
      sha(params.targetDigest, "targetDigest");
      break;
    case "claim.inspect":
      exactObject(params, ["taskId"], "params");
      stableId(params.taskId, "taskId");
      break;
    case "claim.transition": {
      exactObject(params, ["claimHandle", "expectedVersion", "to", "outcomeCode", "resultDigest"], "params");
      handle(params.claimHandle, "claimHandle");
      integer(params.expectedVersion, 1, Number.MAX_SAFE_INTEGER, "expectedVersion");
      const pair = `${params.to}/${params.outcomeCode}`;
      oneOf(pair, new Set([
        "awaiting_review/work_ready", "completed/review_passed",
        "correction_required/review_failed",
      ]), "claim transition");
      sha(params.resultDigest, "resultDigest");
      break;
    }
    case "claim.release":
      exactObject(params, ["claimHandle", "expectedVersion", "reasonCode"], "params");
      handle(params.claimHandle, "claimHandle");
      integer(params.expectedVersion, 1, Number.MAX_SAFE_INTEGER, "expectedVersion");
      oneOf(params.reasonCode, new Set(["completed", "failed", "cancelled", "interrupted"]), "reasonCode");
      break;
    case "recovery.request":
      exactObject(params, ["claimRef", "expectedVersion"], "params");
      opaqueRef(params.claimRef, "claimRef");
      integer(params.expectedVersion, 1, Number.MAX_SAFE_INTEGER, "expectedVersion");
      break;
    case "recovery.inspect":
      exactObject(params, ["recoveryRef"], "params");
      opaqueRef(params.recoveryRef, "recoveryRef");
      break;
    case "work.start":
      exactObject(params, ["mode", "taskId", "runId", "chainId", "engine", "profileId", "repoId", "objective", "claimHandle"], "params");
      oneOf(params.mode, new Set(["new", "review", "correction"]), "mode");
      stableId(params.taskId, "taskId");
      stableId(params.runId, "runId");
      stableId(params.chainId, "chainId");
      engine(params.engine, "engine");
      string(params.profileId, "profileId", { pattern: PROFILE_RE });
      string(params.repoId, "repoId", { pattern: REPO_RE });
      objective(params.objective);
      if (params.mode === "new" && params.claimHandle !== null) fail("INVALID_REQUEST", "claimHandle must be null for new work");
      if (params.mode !== "new") handle(params.claimHandle, "claimHandle");
      break;
    case "work.inspect":
      exactObject(params, ["workerRef"], "params");
      opaqueRef(params.workerRef, "workerRef");
      break;
    case "work.output.read":
      exactObject(params, ["workerRef", "afterSeq", "limitBytes"], "params");
      opaqueRef(params.workerRef, "workerRef");
      integer(params.afterSeq, 0, Number.MAX_SAFE_INTEGER, "afterSeq");
      integer(params.limitBytes, 1, 65_536, "limitBytes");
      break;
    case "work.cancel": {
      exactObject(params, ["workerHandle", "expectedWorkerVersion", "reasonCode", "operatorProof"], "params");
      handle(params.workerHandle, "workerHandle");
      integer(params.expectedWorkerVersion, 1, Number.MAX_SAFE_INTEGER, "expectedWorkerVersion");
      if (params.reasonCode !== "operator_cancel") fail("INVALID_REQUEST", "reasonCode must be operator_cancel");
      operatorProofSyntax(params.operatorProof);
      break;
    }
    case "run.accept": {
      exactObject(params, ["run"], "params");
      const run = exactObject(params.run, [
        "id", "kind", "taskId", "chainId", "profileId", "repoId", "workMode",
        "engines", "summary", "nextActions", "artifacts",
      ], "run");
      stableId(run.id, "run.id");
      oneOf(run.kind, RUN_KINDS, "run.kind");
      if (run.kind === "system") {
        for (const key of ["taskId", "chainId", "profileId", "repoId", "workMode"]) {
          if (run[key] !== null) fail("INVALID_REQUEST", `run.${key} must be null for system runs`);
        }
      } else {
        stableId(run.taskId, "run.taskId");
        stableId(run.chainId, "run.chainId");
        string(run.profileId, "run.profileId", { pattern: PROFILE_RE });
        string(run.repoId, "run.repoId", { pattern: REPO_RE });
        oneOf(run.workMode, new Set(["new", "review", "correction"]), "run.workMode");
      }
      uniqueArray(boundedArray(run.engines, (item) => engine(item, "run.engines[]"), 20, "run.engines"), "run.engines");
      if (run.kind !== "system" && run.engines.length === 0) fail("INVALID_REQUEST", "Worker run must name at least one engine");
      summary(run.summary, "run.summary");
      boundedArray(run.nextActions, action, 20, "run.nextActions");
      boundedArray(run.artifacts, artifact, 20, "run.artifacts");
      break;
    }
    case "run.transition":
      exactObject(params, ["runId", "expectedVersion", "to", "summary", "nextActions", "artifacts"], "params");
      stableId(params.runId, "runId");
      integer(params.expectedVersion, 1, Number.MAX_SAFE_INTEGER, "expectedVersion");
      oneOf(params.to, RUN_STATUSES, "to");
      summary(params.summary, "summary");
      boundedArray(params.nextActions, action, 20, "nextActions");
      boundedArray(params.artifacts, artifact, 20, "artifacts");
      break;
    case "run.get":
      exactObject(params, ["runId"], "params");
      stableId(params.runId, "runId");
      break;
    case "run.list":
      exactObject(params, ["view", "limit", "cursor"], "params");
      oneOf(params.view, new Set(["active", "recent"]), "view");
      integer(params.limit, 1, 200, "limit");
      nullable(params.cursor, (item) => opaqueRef(item, "cursor"));
      break;
    case "run.events":
      exactObject(params, ["afterSeq", "limit"], "params");
      integer(params.afterSeq, 0, Number.MAX_SAFE_INTEGER, "afterSeq");
      integer(params.limit, 1, 200, "limit");
      break;
    case "stop.engage": {
      exactObject(params, ["expectedStopVersion", "reasonCode", "summary", "operatorProof"], "params");
      integer(params.expectedStopVersion, 0, Number.MAX_SAFE_INTEGER, "expectedStopVersion");
      oneOf(params.reasonCode, new Set(["operator_stop", "integrity_failure", "budget_emergency", "shutdown"]), "reasonCode");
      nullable(params.summary, (item) => summary(item, "summary"));
      if (params.reasonCode === "operator_stop") operatorProofSyntax(params.operatorProof);
      else if (params.operatorProof !== null) fail("INVALID_REQUEST", "operatorProof must be null for service safety STOP reasons");
      break;
    }
    case "stop.resume": {
      exactObject(params, ["expectedStopVersion", "operatorProof"], "params");
      integer(params.expectedStopVersion, 1, Number.MAX_SAFE_INTEGER, "expectedStopVersion");
      operatorProofSyntax(params.operatorProof);
      break;
    }
    case "budget.policy.set": {
      exactObject(params, ["expectedVersion", "costLimitEnabled", "costLimitMicros", "operatorProof"], "params");
      integer(params.expectedVersion, 1, Number.MAX_SAFE_INTEGER, "expectedVersion");
      if (typeof params.costLimitEnabled !== "boolean") fail("INVALID_REQUEST", "costLimitEnabled must be boolean");
      integer(params.costLimitMicros, 1_000_000, 100_000_000, "costLimitMicros");
      operatorProofSyntax(params.operatorProof);
      break;
    }
    case "budget.inspect":
      exactObject(params, ["chainId"], "params");
      stableId(params.chainId, "chainId");
      break;
    case "audit.append": {
      exactObject(params, ["eventCode", "severity", "runId", "taskId", "engine", "detail"], "params");
      if (SERVICE_AUDIT_CODES.has(params.eventCode)) fail("EVENT_CODE_RESERVED", "Service-authored audit event code is reserved");
      const spec = CALLER_AUDIT[params.eventCode];
      if (!spec) fail("INVALID_REQUEST", "Unknown caller audit eventCode");
      oneOf(params.severity, spec.severities, "severity");
      nullable(params.runId, (item) => stableId(item, "runId"));
      nullable(params.taskId, (item) => stableId(item, "taskId"));
      nullable(params.engine, (item) => engine(item, "engine"));
      spec.detail(params.detail);
      if (utf8Bytes(canonicalize(params.detail)) > 32_768) fail("INVALID_REQUEST", "audit detail exceeds 32 KiB");
      break;
    }
    case "audit.read":
      exactObject(params, ["afterSeq", "limit", "source", "severity", "runId", "taskId"], "params");
      integer(params.afterSeq, 0, Number.MAX_SAFE_INTEGER, "afterSeq");
      integer(params.limit, 1, 200, "limit");
      nullable(params.source, (item) => oneOf(item, new Set(["gate", "service"]), "source"));
      nullable(params.severity, (item) => oneOf(item, new Set(["info", "warning", "error"]), "severity"));
      nullable(params.runId, (item) => stableId(item, "runId"));
      nullable(params.taskId, (item) => stableId(item, "taskId"));
      break;
    default:
      fail("UNKNOWN_METHOD", `Unknown method: ${method}`);
  }
  return params;
}

const METHOD_DEADLINES = Object.freeze({
  "session.open": READ_DEADLINE_MS,
  "session.ready": MUTATION_DEADLINE_MS,
  "session.heartbeat": READ_DEADLINE_MS,
  "session.drain": MUTATION_DEADLINE_MS,
  "service.health": READ_DEADLINE_MS,
  "operator.action.begin": MUTATION_DEADLINE_MS,
  "claim.inspect": READ_DEADLINE_MS,
  "claim.transition": MUTATION_DEADLINE_MS,
  "claim.release": MUTATION_DEADLINE_MS,
  "recovery.request": MUTATION_DEADLINE_MS,
  "recovery.inspect": READ_DEADLINE_MS,
  "work.start": LAUNCH_DEADLINE_MS,
  "work.inspect": READ_DEADLINE_MS,
  "work.output.read": READ_DEADLINE_MS,
  "work.cancel": MUTATION_DEADLINE_MS,
  "run.accept": MUTATION_DEADLINE_MS,
  "run.transition": MUTATION_DEADLINE_MS,
  "run.get": READ_DEADLINE_MS,
  "run.list": READ_DEADLINE_MS,
  "run.events": READ_DEADLINE_MS,
  "stop.get": READ_DEADLINE_MS,
  "stop.engage": MUTATION_DEADLINE_MS,
  "stop.resume": MUTATION_DEADLINE_MS,
  "budget.policy.get": READ_DEADLINE_MS,
  "budget.policy.set": MUTATION_DEADLINE_MS,
  "budget.inspect": READ_DEADLINE_MS,
  "audit.append": MUTATION_DEADLINE_MS,
  "audit.read": READ_DEADLINE_MS,
});

const METHOD_PARAM_MAX_BYTES = Object.freeze({
  "session.open": 4_096,
  "session.ready": 4_096,
  "session.heartbeat": 4_096,
  "session.drain": 4_096,
  "service.health": 4_096,
  "operator.action.begin": 4_096,
  "claim.inspect": 4_096,
  "claim.transition": 8_192,
  "claim.release": 4_096,
  "recovery.request": 4_096,
  "recovery.inspect": 4_096,
  "work.start": 147_456,
  "work.inspect": 4_096,
  "work.output.read": 4_096,
  "work.cancel": 8_192,
  "run.accept": 32_768,
  "run.transition": 32_768,
  "run.get": 4_096,
  "run.list": 4_096,
  "run.events": 4_096,
  "stop.get": 4_096,
  "stop.engage": 8_192,
  "stop.resume": 4_096,
  "budget.policy.get": 4_096,
  "budget.policy.set": 8_192,
  "budget.inspect": 4_096,
  "audit.append": 32_768,
  "audit.read": 8_192,
});

const METHOD_RESPONSE_MAX_BYTES = Object.freeze({
  "session.open": 8_192,
  "session.ready": 8_192,
  "session.heartbeat": 4_096,
  "session.drain": 4_096,
  "service.health": 16_384,
  "operator.action.begin": 4_096,
  "claim.inspect": 8_192,
  "claim.transition": 8_192,
  "claim.release": 8_192,
  "recovery.request": 8_192,
  "recovery.inspect": 8_192,
  "work.start": 32_768,
  "work.inspect": 16_384,
  "work.output.read": 131_072,
  "work.cancel": 8_192,
  "run.accept": 32_768,
  "run.transition": 32_768,
  "run.get": 32_768,
  "run.list": 524_288,
  "run.events": 524_288,
  "stop.get": 8_192,
  "stop.engage": 65_536,
  "stop.resume": 8_192,
  "budget.policy.get": 8_192,
  "budget.policy.set": 8_192,
  "budget.inspect": 8_192,
  "audit.append": 16_384,
  "audit.read": 524_288,
});

function validateRequestShape(value, context = {}) {
  value = validationSnapshot(
    value,
    REQUEST_MAX_BYTES,
    "FRAME_TOO_LARGE",
    "Request exceeds 384 KiB",
    { maxDepth: 12, maxKeys: 1_024, maxMembers: 2_048 },
  );
  exactObject(value, ["v", "gatewayEpoch", "requestId", "deadlineMs", "method", "params"], "request");
  if (value.v !== PROTOCOL_VERSION) fail("VERSION_MISMATCH", "Protocol version must be 1");
  string(value.requestId, "requestId", { pattern: REQUEST_ID_RE });
  if (typeof value.method !== "string" || !Object.hasOwn(METHOD_DEADLINES, value.method)) fail("UNKNOWN_METHOD", `Unknown method: ${value.method}`);
  if (value.method === "session.open") {
    if (value.gatewayEpoch !== null) fail("STALE_EPOCH", "session.open gateway epoch must be null");
  } else {
    string(value.gatewayEpoch, "gatewayEpoch", { pattern: EPOCH_RE });
    requireGatewayEpoch(context, value.gatewayEpoch);
  }
  if (utf8Bytes(canonicalize(value.params)) > METHOD_PARAM_MAX_BYTES[value.method]) {
    fail("FRAME_TOO_LARGE", `${value.method} params exceed the contract limit`);
  }
  validateParams(value.method, value.params, context);
  return deepFreeze(value);
}

function timestamp(value, label) {
  return integer(value, 0, Number.MAX_SAFE_INTEGER, label);
}

function validateStopView(value) {
  exactObject(value, ["engaged", "version", "reasonCode", "summary", "changedAtMs"], "StopView");
  if (typeof value.engaged !== "boolean") fail("INTERNAL_RESPONSE_INVALID", "StopView.engaged must be boolean");
  integer(value.version, 0, Number.MAX_SAFE_INTEGER, "StopView.version");
  nullable(value.reasonCode, (item) => string(item, "StopView.reasonCode", { pattern: ACTION_ID_RE }));
  nullable(value.summary, (item) => summary(item, "StopView.summary"));
  if (value.engaged !== (value.reasonCode !== null)) fail("INTERNAL_RESPONSE_INVALID", "StopView engaged and reasonCode disagree");
  if (!value.engaged && value.summary !== null) fail("INTERNAL_RESPONSE_INVALID", "A resumed StopView cannot retain a stop summary");
  timestamp(value.changedAtMs, "StopView.changedAtMs");
  return value;
}

function validateClaimView(value) {
  exactObject(value, ["ref", "taskId", "runId", "chainId", "authorEngine", "state", "version", "workerRef", "recoveryRef", "updatedAtMs"], "ClaimView");
  opaqueRef(value.ref, "ClaimView.ref");
  stableId(value.taskId, "ClaimView.taskId");
  stableId(value.runId, "ClaimView.runId");
  stableId(value.chainId, "ClaimView.chainId");
  engine(value.authorEngine, "ClaimView.authorEngine");
  oneOf(value.state, CLAIM_STATES, "ClaimView.state");
  integer(value.version, 1, Number.MAX_SAFE_INTEGER, "ClaimView.version");
  nullable(value.workerRef, (item) => opaqueRef(item, "ClaimView.workerRef"));
  nullable(value.recoveryRef, (item) => opaqueRef(item, "ClaimView.recoveryRef"));
  if (value.state === "released" && (value.workerRef !== null || value.recoveryRef !== null)) {
    fail("INTERNAL_RESPONSE_INVALID", "A released ClaimView cannot retain a worker or recovery reference");
  }
  timestamp(value.updatedAtMs, "ClaimView.updatedAtMs");
  return value;
}

function validateWorkerView(value) {
  exactObject(value, ["ref", "claimRef", "state", "version", "exitCode", "signalName", "outputNextSeq", "outputEof", "startedAtMs", "finishedAtMs"], "WorkerView");
  opaqueRef(value.ref, "WorkerView.ref");
  opaqueRef(value.claimRef, "WorkerView.claimRef");
  oneOf(value.state, WORKER_STATES, "WorkerView.state");
  integer(value.version, 1, Number.MAX_SAFE_INTEGER, "WorkerView.version");
  nullable(value.exitCode, (item) => integer(item, 0, 255, "WorkerView.exitCode"));
  nullable(value.signalName, (item) => string(item, "WorkerView.signalName", { pattern: /^[A-Z][A-Z0-9]{1,31}$/ }));
  integer(value.outputNextSeq, 0, Number.MAX_SAFE_INTEGER, "WorkerView.outputNextSeq");
  if (typeof value.outputEof !== "boolean") fail("INTERNAL_RESPONSE_INVALID", "WorkerView.outputEof must be boolean");
  nullable(value.startedAtMs, (item) => timestamp(item, "WorkerView.startedAtMs"));
  nullable(value.finishedAtMs, (item) => timestamp(item, "WorkerView.finishedAtMs"));
  if (new Set(["completed", "failed", "cancelled", "interrupted"]).has(value.state)) {
    if (value.finishedAtMs === null || !value.outputEof) fail("INTERNAL_RESPONSE_INVALID", "Terminal WorkerView requires finishedAtMs and outputEof");
  } else if (value.state !== "quarantined" && value.finishedAtMs !== null) {
    fail("INTERNAL_RESPONSE_INVALID", "Non-terminal WorkerView cannot have finishedAtMs");
  }
  return value;
}

function validateRecoveryView(value) {
  exactObject(value, ["ref", "claimRef", "state", "startedAtMs", "finishedAtMs", "quarantineReason"], "RecoveryView");
  opaqueRef(value.ref, "RecoveryView.ref");
  opaqueRef(value.claimRef, "RecoveryView.claimRef");
  oneOf(value.state, RECOVERY_STATES, "RecoveryView.state");
  timestamp(value.startedAtMs, "RecoveryView.startedAtMs");
  nullable(value.finishedAtMs, (item) => timestamp(item, "RecoveryView.finishedAtMs"));
  nullable(value.quarantineReason, (item) => string(item, "RecoveryView.quarantineReason", { pattern: ACTION_ID_RE }));
  return value;
}

function validateBudgetView(value) {
  exactObject(value, ["chainId", "policyVersion", "execs", "tokenUnits", "costMicros", "reservedTokenUnits", "reservedCostMicros", "softStop", "exhausted"], "BudgetView");
  stableId(value.chainId, "BudgetView.chainId");
  for (const key of ["policyVersion", "execs", "tokenUnits", "costMicros", "reservedTokenUnits", "reservedCostMicros"]) {
    integer(value[key], 0, Number.MAX_SAFE_INTEGER, `BudgetView.${key}`);
  }
  if (typeof value.softStop !== "boolean" || typeof value.exhausted !== "boolean") fail("INTERNAL_RESPONSE_INVALID", "BudgetView flags must be boolean");
  return value;
}

function validateWorkBundle(claim, worker, budget, { requireActiveWorkerLink = false } = {}) {
  if (worker.claimRef !== claim.ref || budget.chainId !== claim.chainId) {
    fail("INTERNAL_RESPONSE_INVALID", "Worker, claim, and budget do not belong to the same work bundle");
  }
  if ((requireActiveWorkerLink && claim.workerRef !== worker.ref) ||
      (!requireActiveWorkerLink && claim.workerRef !== null && claim.workerRef !== worker.ref)) {
    fail("INTERNAL_RESPONSE_INVALID", "Claim worker reference does not match the returned worker");
  }
}

function validateRunView(value) {
  exactObject(value, [
    "id", "kind", "status", "authority", "taskId", "chainId", "profileId",
    "repoId", "workMode", "engines", "summary", "createdAtMs", "startedAtMs",
    "updatedAtMs", "finishedAtMs", "nextActions", "artifacts", "version",
  ], "RunView");
  stableId(value.id, "RunView.id");
  oneOf(value.kind, RUN_KINDS, "RunView.kind");
  oneOf(value.status, RUN_STATUSES, "RunView.status");
  oneOf(value.authority, new Set(["gate", "worker"]), "RunView.authority");
  nullable(value.taskId, (item) => stableId(item, "RunView.taskId"));
  nullable(value.chainId, (item) => stableId(item, "RunView.chainId"));
  nullable(value.profileId, (item) => string(item, "RunView.profileId", { pattern: PROFILE_RE }));
  nullable(value.repoId, (item) => string(item, "RunView.repoId", { pattern: REPO_RE }));
  nullable(value.workMode, (item) => oneOf(item, new Set(["new", "review", "correction"]), "RunView.workMode"));
  if (value.kind === "system") {
    if (value.authority !== "gate") fail("INTERNAL_RESPONSE_INVALID", "System RunView authority must be gate");
    for (const key of ["taskId", "chainId", "profileId", "repoId", "workMode"]) {
      if (value[key] !== null) fail("INTERNAL_RESPONSE_INVALID", `System RunView.${key} must be null`);
    }
  } else {
    for (const key of ["taskId", "chainId", "profileId", "repoId", "workMode"]) {
      if (value[key] === null) fail("INTERNAL_RESPONSE_INVALID", `Worker RunView.${key} cannot be null`);
    }
  }
  uniqueArray(boundedArray(value.engines, (item) => engine(item, "RunView.engines[]"), 20, "RunView.engines"), "RunView.engines");
  summary(value.summary, "RunView.summary");
  timestamp(value.createdAtMs, "RunView.createdAtMs");
  nullable(value.startedAtMs, (item) => timestamp(item, "RunView.startedAtMs"));
  timestamp(value.updatedAtMs, "RunView.updatedAtMs");
  nullable(value.finishedAtMs, (item) => timestamp(item, "RunView.finishedAtMs"));
  boundedArray(value.nextActions, action, 20, "RunView.nextActions");
  boundedArray(value.artifacts, artifact, 20, "RunView.artifacts");
  integer(value.version, 1, Number.MAX_SAFE_INTEGER, "RunView.version");
  return value;
}

function validateRunEventView(value) {
  exactObject(value, ["seq", "runId", "eventCode", "source", "atMs", "status", "kind", "engine", "engines", "summary", "nextActions", "artifacts", "runVersion"], "RunEventView");
  integer(value.seq, 1, Number.MAX_SAFE_INTEGER, "RunEventView.seq");
  stableId(value.runId, "RunEventView.runId");
  oneOf(value.source, new Set(["gate", "service"]), "RunEventView.source");
  oneOf(
    value.eventCode,
    value.source === "gate" ? GATE_RUN_EVENT_CODES : SERVICE_RUN_EVENT_CODES,
    "RunEventView.eventCode",
  );
  timestamp(value.atMs, "RunEventView.atMs");
  oneOf(value.status, RUN_STATUSES, "RunEventView.status");
  if (!RUN_EVENT_STATUSES[value.eventCode].has(value.status)) {
    fail("INTERNAL_RESPONSE_INVALID", "RunEventView eventCode and status disagree");
  }
  oneOf(value.kind, RUN_KINDS, "RunEventView.kind");
  nullable(value.engine, (item) => engine(item, "RunEventView.engine"));
  uniqueArray(boundedArray(value.engines, (item) => engine(item, "RunEventView.engines[]"), 20, "RunEventView.engines"), "RunEventView.engines");
  if (value.engines.length === 1) {
    if (value.engine !== value.engines[0]) fail("INTERNAL_RESPONSE_INVALID", "RunEventView.engine must equal its single engines entry");
  } else if (value.engine !== null) {
    fail("INTERNAL_RESPONSE_INVALID", "RunEventView.engine must be null unless exactly one engine applies");
  }
  summary(value.summary, "RunEventView.summary");
  boundedArray(value.nextActions, action, 20, "RunEventView.nextActions");
  boundedArray(value.artifacts, artifact, 20, "RunEventView.artifacts");
  integer(value.runVersion, 1, Number.MAX_SAFE_INTEGER, "RunEventView.runVersion");
  return value;
}

function validateAuditView(value) {
  exactObject(value, ["seq", "eventCode", "source", "severity", "atMs", "runId", "taskId", "engine", "detail"], "AuditView");
  integer(value.seq, 1, Number.MAX_SAFE_INTEGER, "AuditView.seq");
  string(value.eventCode, "AuditView.eventCode", { pattern: ACTION_ID_RE });
  oneOf(value.source, new Set(["gate", "service"]), "AuditView.source");
  oneOf(value.severity, new Set(["info", "warning", "error"]), "AuditView.severity");
  timestamp(value.atMs, "AuditView.atMs");
  nullable(value.runId, (item) => stableId(item, "AuditView.runId"));
  nullable(value.taskId, (item) => stableId(item, "AuditView.taskId"));
  nullable(value.engine, (item) => engine(item, "AuditView.engine"));
  if (value.source === "gate") {
    const spec = CALLER_AUDIT[value.eventCode];
    if (!spec || !spec.severities.has(value.severity)) fail("INTERNAL_RESPONSE_INVALID", "AuditView gate event is invalid");
    spec.detail(value.detail);
  } else {
    if (!SERVICE_AUDIT_CODES.has(value.eventCode)) fail("INTERNAL_RESPONSE_INVALID", "AuditView service event code is invalid");
    validateServiceAuditDetail(value.eventCode, value.severity, value.detail);
  }
  return value;
}

function validateStructuralLimits(value, label = "StructuralLimits") {
  const limits = exactObject(value, ["maxExecs", "maxLifetimeMs", "maxTokenUnits", "maxHandoffs", "maxConsecutiveSamePair", "softStopPermille"], label);
  for (const key of ["maxExecs", "maxLifetimeMs", "maxTokenUnits", "maxHandoffs", "maxConsecutiveSamePair"]) integer(limits[key], 1, Number.MAX_SAFE_INTEGER, `StructuralLimits.${key}`);
  integer(limits.softStopPermille, 1, 999, "StructuralLimits.softStopPermille");
  return limits;
}

function validatePolicy(value) {
  exactObject(value, ["version", "costLimitEnabled", "costLimitMicros", "structuralLimits"], "BudgetPolicy");
  integer(value.version, 1, Number.MAX_SAFE_INTEGER, "BudgetPolicy.version");
  if (typeof value.costLimitEnabled !== "boolean") fail("INTERNAL_RESPONSE_INVALID", "BudgetPolicy.costLimitEnabled must be boolean");
  integer(value.costLimitMicros, 1_000_000, 100_000_000, "BudgetPolicy.costLimitMicros");
  validateStructuralLimits(value.structuralLimits);
  return value;
}

function validatePageCursor(data, context, label) {
  if (data.hasMore !== (data.nextCursor !== null)) {
    fail("INTERNAL_RESPONSE_INVALID", `${label} hasMore and nextCursor disagree`);
  }
  if (data.nextCursor !== null && data.nextCursor === context.requestCursor) {
    fail("INTERNAL_RESPONSE_INVALID", `${label} continuation cursor did not advance`);
  }
}

function validateSuccessData(method, data, context = {}) {
  switch (method) {
    case "session.open":
      exactObject(data, ["serviceEpoch", "gatewayEpoch", "protocolVersion", "contractDigest", "state", "limits"], "response.data");
      string(data.serviceEpoch, "serviceEpoch", { pattern: /^svc_[0-9a-f]{32}$/ });
      string(data.gatewayEpoch, "gatewayEpoch", { pattern: EPOCH_RE });
      if (data.gatewayEpoch !== context.responseGatewayEpoch) fail("INTERNAL_RESPONSE_INVALID", "session.open envelope and data gateway epochs must match");
      if (data.protocolVersion !== 1) fail("INTERNAL_RESPONSE_INVALID", "response protocol version is invalid");
      sha(data.contractDigest, "contractDigest");
      requireContractDigest(context, data.contractDigest);
      oneOf(data.state, new Set(["connected_not_ready"]), "state");
      exactObject(data.limits, ["maxRequestBytes", "maxResponseBytes", "maxObjectiveBytes", "maxOutputReadBytes", "maxListItems", "maxInFlight", "heartbeatIntervalMs", "heartbeatTimeoutMs", "readDeadlineMs", "mutationDeadlineMs", "launchDeadlineMs"], "LimitsView");
      for (const [key, expected] of Object.entries(LIMITS_VIEW)) {
        if (data.limits[key] !== expected) fail("INTERNAL_RESPONSE_INVALID", `LimitsView.${key} must equal ${expected}`);
      }
      break;
    case "session.ready":
      exactObject(data, ["state", "stop"], "response.data");
      if (data.state !== "ready") fail("INTERNAL_RESPONSE_INVALID", "session.ready state must be ready");
      validateStopView(data.stop);
      break;
    case "session.heartbeat":
      exactObject(data, ["state", "serviceSeq", "stopVersion"], "response.data");
      oneOf(data.state, new Set(["ready", "degraded_read_only", "draining", "reconciling"]), "state");
      integer(data.serviceSeq, 0, Number.MAX_SAFE_INTEGER, "serviceSeq");
      integer(data.stopVersion, 0, Number.MAX_SAFE_INTEGER, "stopVersion");
      if (!Number.isSafeInteger(context.lastServiceSeq) || data.serviceSeq < context.lastServiceSeq) {
        fail("INTERNAL_RESPONSE_INVALID", "session.heartbeat service sequence cannot move backward");
      }
      break;
    case "session.drain":
      exactObject(data, ["state"], "response.data");
      if (data.state !== "draining") fail("INTERNAL_RESPONSE_INVALID", "session.drain state must be draining");
      break;
    case "operator.action.begin":
      exactObject(data, ["operatorProof"], "response.data");
      exactObject(data.operatorProof, ["actionHandle", "action", "targetDigest", "expiresAtMs"], "OperatorProof");
      handle(data.operatorProof.actionHandle, "OperatorProof.actionHandle");
      oneOf(data.operatorProof.action, new Set(["stop_resume", "stop_engage", "worker_cancel", "budget_policy_change"]), "OperatorProof.action");
      sha(data.operatorProof.targetDigest, "OperatorProof.targetDigest");
      timestamp(data.operatorProof.expiresAtMs, "OperatorProof.expiresAtMs");
      if (data.operatorProof.action !== context.operatorAction || data.operatorProof.targetDigest !== context.operatorTargetDigest) {
        fail("INTERNAL_RESPONSE_INVALID", "OperatorProof response does not match the initiating action and target");
      }
      if (typeof context.operatorSessionDigest !== "string" || !SHA_RE.test(context.operatorSessionDigest)) {
        fail("INTERNAL_RESPONSE_INVALID", "OperatorProof response lacks the initiating operator session context");
      }
      if (!Number.isSafeInteger(context.responseServerTimeMs) || data.operatorProof.expiresAtMs <= context.responseServerTimeMs ||
          data.operatorProof.expiresAtMs > context.responseServerTimeMs + 30_000) {
        fail("INTERNAL_RESPONSE_INVALID", "OperatorProof response exceeds its 30-second issuance window");
      }
      break;
    case "claim.inspect":
      exactObject(data, ["claim"], "response.data");
      nullable(data.claim, validateClaimView);
      if (data.claim !== null && data.claim.taskId !== context.expectedTaskId) {
        fail("INTERNAL_RESPONSE_INVALID", "claim.inspect returned a different task claim");
      }
      break;
    case "claim.transition":
      exactObject(data, ["claim"], "response.data");
      validateClaimView(data.claim);
      if (data.claim.ref !== context.expectedClaimRef || data.claim.version <= context.expectedClaimVersion ||
          data.claim.state !== context.expectedClaimState) {
        fail("INTERNAL_RESPONSE_INVALID", "claim.transition response does not match the requested claim, version, and state");
      }
      break;
    case "claim.release":
      exactObject(data, ["claim"], "response.data");
      validateClaimView(data.claim);
      if (data.claim.state !== "released") fail("INTERNAL_RESPONSE_INVALID", "claim.release must return a released tombstone");
      if (data.claim.ref !== context.expectedClaimRef || data.claim.version <= context.expectedClaimVersion) {
        fail("INTERNAL_RESPONSE_INVALID", "claim.release response does not match the requested claim and newer version");
      }
      break;
    case "recovery.request":
      exactObject(data, ["recovery"], "response.data");
      validateRecoveryView(data.recovery);
      if (data.recovery.claimRef !== context.expectedClaimRef) {
        fail("INTERNAL_RESPONSE_INVALID", "recovery.request returned a recovery for a different claim");
      }
      break;
    case "recovery.inspect":
      exactObject(data, ["recovery"], "response.data");
      nullable(data.recovery, validateRecoveryView);
      if (data.recovery !== null && data.recovery.ref !== context.expectedRecoveryRef) {
        fail("INTERNAL_RESPONSE_INVALID", "recovery.inspect returned a different recovery");
      }
      break;
    case "work.start":
      exactObject(data, ["claimHandle", "workerHandle", "claim", "worker", "budget"], "response.data");
      handle(data.claimHandle, "claimHandle");
      handle(data.workerHandle, "workerHandle");
      if (data.claimHandle === data.workerHandle) fail("INTERNAL_RESPONSE_INVALID", "Claim and worker handles must be distinct");
      validateClaimView(data.claim);
      validateWorkerView(data.worker);
      validateBudgetView(data.budget);
      validateWorkBundle(data.claim, data.worker, data.budget, { requireActiveWorkerLink: true });
      if (data.claim.taskId !== context.expectedTaskId || data.claim.runId !== context.expectedRunId ||
          data.claim.chainId !== context.expectedChainId || data.budget.chainId !== context.expectedChainId ||
          data.claim.state !== context.expectedClaimState ||
          (context.expectedAuthorEngine !== null && data.claim.authorEngine !== context.expectedAuthorEngine)) {
        fail("INTERNAL_RESPONSE_INVALID", "work.start response does not match the accepted task, run, and chain");
      }
      if (context.expectedClaimRef !== null && data.claim.ref !== context.expectedClaimRef) {
        fail("INTERNAL_RESPONSE_INVALID", "work.start response does not match the requested claim");
      }
      if (new Set(["intent", "spawn_attempt"]).has(data.worker.state)) {
        fail("INTERNAL_RESPONSE_INVALID", "work.start cannot report success before child observation");
      }
      break;
    case "work.inspect":
      exactObject(data, ["worker", "claim", "budget"], "response.data");
      validateWorkerView(data.worker);
      validateClaimView(data.claim);
      validateBudgetView(data.budget);
      validateWorkBundle(data.claim, data.worker, data.budget);
      if (data.worker.ref !== context.expectedWorkerRef) {
        fail("INTERNAL_RESPONSE_INVALID", "work.inspect returned a different worker");
      }
      break;
    case "work.output.read":
      exactObject(data, ["chunks", "nextSeq", "eof", "truncated"], "response.data");
      {
        let totalBytes = 0;
        let previousSeq = context.afterSeq;
        if (!Number.isSafeInteger(previousSeq) || previousSeq < 0 ||
            !Number.isSafeInteger(context.limitBytes) || context.limitBytes < 1 || context.limitBytes > 65_536) {
          fail("INTERNAL_RESPONSE_INVALID", "work.output.read requires the original cursor and byte limit context");
        }
        boundedArray(data.chunks, (chunk) => {
          exactObject(chunk, ["seq", "text"], "output chunk");
          integer(chunk.seq, 0, Number.MAX_SAFE_INTEGER, "output chunk seq");
          string(chunk.text, "output chunk text", { maxBytes: 65_536 });
          if (Number.isSafeInteger(previousSeq) && chunk.seq <= previousSeq) fail("INTERNAL_RESPONSE_INVALID", "Output chunk sequences must strictly increase");
          previousSeq = chunk.seq;
          totalBytes += utf8Bytes(chunk.text);
        }, 2_048, "chunks");
        integer(data.nextSeq, 0, Number.MAX_SAFE_INTEGER, "nextSeq");
        if (Number.isSafeInteger(previousSeq) && data.nextSeq !== previousSeq) fail("INTERNAL_RESPONSE_INVALID", "Output nextSeq must equal the requested or final chunk cursor");
        if (totalBytes > context.limitBytes) fail("INTERNAL_RESPONSE_INVALID", "Output chunks exceed the requested byte limit");
      }
      if (typeof data.eof !== "boolean" || typeof data.truncated !== "boolean") fail("INTERNAL_RESPONSE_INVALID", "output flags must be boolean");
      break;
    case "work.cancel":
      exactObject(data, ["worker"], "response.data");
      validateWorkerView(data.worker);
      if (!new Set(["stopping", "cleaning", "completed", "failed", "cancelled", "interrupted", "quarantined"]).has(data.worker.state)) {
        fail("INTERNAL_RESPONSE_INVALID", "work.cancel must return a stopping-or-later worker");
      }
      if (data.worker.ref !== context.expectedWorkerRef || !Number.isSafeInteger(context.expectedWorkerVersion) ||
          data.worker.version <= context.expectedWorkerVersion) {
        fail("INTERNAL_RESPONSE_INVALID", "work.cancel response does not match the requested worker and newer version");
      }
      break;
    case "run.accept":
      exactObject(data, ["run"], "response.data");
      validateRunView(data.run);
      if (canonicalize({
        id: data.run.id,
        kind: data.run.kind,
        taskId: data.run.taskId,
        chainId: data.run.chainId,
        profileId: data.run.profileId,
        repoId: data.run.repoId,
        workMode: data.run.workMode,
        engines: data.run.engines,
        summary: data.run.summary,
        nextActions: data.run.nextActions,
        artifacts: data.run.artifacts,
      }) !== context.expectedRunCanonical || data.run.authority !== context.expectedRunAuthority || data.run.status !== "queued") {
        fail("INTERNAL_RESPONSE_INVALID", "run.accept response does not match the accepted run binding");
      }
      break;
    case "run.transition":
      exactObject(data, ["run"], "response.data");
      validateRunView(data.run);
      if (data.run.id !== context.expectedRunId || data.run.version <= context.expectedRunVersion ||
          data.run.authority !== context.expectedRunAuthority ||
          canonicalize({
            status: data.run.status,
            summary: data.run.summary,
            nextActions: data.run.nextActions,
            artifacts: data.run.artifacts,
          }) !== context.expectedRunTransitionCanonical) {
        fail("INTERNAL_RESPONSE_INVALID", "run.transition response does not match the requested run, version, and target");
      }
      break;
    case "run.get":
      exactObject(data, ["run"], "response.data");
      nullable(data.run, validateRunView);
      if (data.run !== null && data.run.id !== context.expectedRunId) {
        fail("INTERNAL_RESPONSE_INVALID", "run.get returned a different run");
      }
      break;
    case "run.list":
      exactObject(data, ["runs", "nextCursor", "hasMore", "truncated"], "response.data");
      boundedArray(data.runs, validateRunView, 200, "runs");
      nullable(data.nextCursor, (item) => opaqueRef(item, "nextCursor"));
      if (typeof data.hasMore !== "boolean" || typeof data.truncated !== "boolean") fail("INTERNAL_RESPONSE_INVALID", "run page flags must be boolean");
      validatePageCursor(data, context, "run.list");
      if (!Number.isSafeInteger(context.pageLimit) || data.runs.length > context.pageLimit) {
        fail("INTERNAL_RESPONSE_INVALID", "run.list response exceeds the requested page limit");
      }
      if (context.runView === "active" && data.runs.some((run) => !new Set(["queued", "running", "waiting", "gated"]).has(run.status))) {
        fail("INTERNAL_RESPONSE_INVALID", "run.list active view contains a terminal run");
      }
      break;
    case "run.events":
      exactObject(data, ["ledgerGeneration", "events", "nextCursor", "hasMore", "truncated"], "response.data");
      integer(data.ledgerGeneration, 0, Number.MAX_SAFE_INTEGER, "ledgerGeneration");
      boundedArray(data.events, validateRunEventView, 200, "events");
      nullable(data.nextCursor, (item) => opaqueRef(item, "nextCursor"));
      if (typeof data.hasMore !== "boolean" || typeof data.truncated !== "boolean") fail("INTERNAL_RESPONSE_INVALID", "event page flags must be boolean");
      validatePageCursor(data, context, "run.events");
      {
        let previousSeq = context.afterSeq;
        if (!Number.isSafeInteger(context.pageLimit) || !Number.isSafeInteger(previousSeq) || data.events.length > context.pageLimit) {
          fail("INTERNAL_RESPONSE_INVALID", "run.events response exceeds the requested cursor or page limit");
        }
        for (const event of data.events) {
          if (event.seq <= previousSeq) fail("INTERNAL_RESPONSE_INVALID", "run.events sequences must increase beyond afterSeq");
          previousSeq = event.seq;
        }
      }
      break;
    case "stop.get":
      exactObject(data, ["stop"], "response.data");
      validateStopView(data.stop);
      break;
    case "stop.resume":
      exactObject(data, ["stop"], "response.data");
      validateStopView(data.stop);
      if (data.stop.engaged) fail("INTERNAL_RESPONSE_INVALID", "stop.resume must return a resumed StopView");
      if (data.stop.version <= context.expectedStopVersion) {
        fail("INTERNAL_RESPONSE_INVALID", "stop.resume response must have a newer STOP version");
      }
      break;
    case "stop.engage":
      exactObject(data, ["stop", "inFlightWorkers"], "response.data");
      validateStopView(data.stop);
      if (!data.stop.engaged) fail("INTERNAL_RESPONSE_INVALID", "stop.engage must return an engaged StopView");
      if (data.stop.version <= context.expectedStopVersion || data.stop.reasonCode !== context.expectedStopReason ||
          data.stop.summary !== context.expectedStopSummary) {
        fail("INTERNAL_RESPONSE_INVALID", "stop.engage response does not match the requested STOP change");
      }
      boundedArray(data.inFlightWorkers, validateWorkerView, 64, "inFlightWorkers");
      break;
    case "budget.policy.get":
      validatePolicy(data);
      if (canonicalize(data.structuralLimits) !== context.expectedStructuralLimitsCanonical) {
        fail("INTERNAL_RESPONSE_INVALID", "Budget policy structural limits do not match the compiled policy");
      }
      break;
    case "budget.policy.set":
      validatePolicy(data);
      if (data.version <= context.expectedPolicyVersion || data.costLimitEnabled !== context.expectedCostLimitEnabled ||
          data.costLimitMicros !== context.expectedCostLimitMicros ||
          canonicalize(data.structuralLimits) !== context.expectedStructuralLimitsCanonical) {
        fail("INTERNAL_RESPONSE_INVALID", "budget.policy.set response does not match the requested policy change");
      }
      break;
    case "budget.inspect":
      exactObject(data, ["budget"], "response.data");
      validateBudgetView(data.budget);
      if (data.budget.chainId !== context.expectedChainId) {
        fail("INTERNAL_RESPONSE_INVALID", "budget.inspect returned a different chain budget");
      }
      break;
    case "audit.append":
      exactObject(data, ["event"], "response.data");
      validateAuditView(data.event);
      if (data.event.source !== "gate" || canonicalize({
        eventCode: data.event.eventCode,
        severity: data.event.severity,
        runId: data.event.runId,
        taskId: data.event.taskId,
        engine: data.event.engine,
        detail: data.event.detail,
      }) !== context.expectedAuditCanonical) {
        fail("INTERNAL_RESPONSE_INVALID", "audit.append response does not match the requested gate event");
      }
      break;
    case "audit.read":
      exactObject(data, ["events", "nextCursor", "hasMore", "truncated"], "response.data");
      boundedArray(data.events, validateAuditView, 200, "events");
      nullable(data.nextCursor, (item) => opaqueRef(item, "nextCursor"));
      if (typeof data.hasMore !== "boolean" || typeof data.truncated !== "boolean") fail("INTERNAL_RESPONSE_INVALID", "audit page flags must be boolean");
      validatePageCursor(data, context, "audit.read");
      {
        let previousSeq = context.afterSeq;
        if (!Number.isSafeInteger(context.pageLimit) || !Number.isSafeInteger(previousSeq) ||
            !context.auditFilters || typeof context.auditFilters !== "object" ||
            data.events.length > context.pageLimit) {
          fail("INTERNAL_RESPONSE_INVALID", "audit.read response exceeds the requested cursor or page limit");
        }
        for (const event of data.events) {
          if (event.seq <= previousSeq) fail("INTERNAL_RESPONSE_INVALID", "audit.read sequences must increase beyond afterSeq");
          previousSeq = event.seq;
          for (const [field, expected] of Object.entries(context.auditFilters)) {
            if (expected !== null && event[field] !== expected) {
              fail("INTERNAL_RESPONSE_INVALID", `audit.read event does not match the requested ${field} filter`);
            }
          }
        }
      }
      break;
    case "service.health":
      validateHealthData(data, context);
      break;
    default:
      fail("INTERNAL_RESPONSE_INVALID", `Unknown response method: ${method}`);
  }
  return data;
}

function validateHealthData(data, context) {
  exactObject(data, ["state", "serviceVersion", "contractDigest", "migrationState", "reconciliationState", "stop", "stores", "profiles"], "response.data");
  oneOf(data.state, new Set(["ready", "degraded_read_only", "draining", "reconciling"]), "health.state");
  string(data.serviceVersion, "health.serviceVersion", { pattern: /^\d+\.\d+\.\d+$/ });
  sha(data.contractDigest, "health.contractDigest");
  requireContractDigest(context, data.contractDigest);
  oneOf(data.migrationState, new Set([
    "not_started", "secure_dirs", "agent_markers_moved", "stores_created",
    "legacy_labeled", "stopped_defaulted", "cutover_ready", "complete",
  ]), "health.migrationState");
  oneOf(data.reconciliationState, new Set(["clean", "running", "quarantined", "failed"]), "health.reconciliationState");
  validateStopView(data.stop);
  exactObject(data.stores, ["claims", "runs", "stop", "budgets", "audit", "idempotency"], "health.stores");
  for (const [name, store] of Object.entries(data.stores)) {
    exactObject(store, ["state", "quarantinedRecords", "lastDurableSeq"], `health.stores.${name}`);
    oneOf(store.state, new Set(["healthy", "degraded", "unavailable"]), `health.stores.${name}.state`);
    integer(store.quarantinedRecords, 0, Number.MAX_SAFE_INTEGER, `health.stores.${name}.quarantinedRecords`);
    integer(store.lastDurableSeq, 0, Number.MAX_SAFE_INTEGER, `health.stores.${name}.lastDurableSeq`);
  }
  let previousProfileId = null;
  boundedArray(data.profiles, (profile) => {
    exactObject(profile, ["id", "available", "reasonCode"], "ProfileHealthView");
    string(profile.id, "ProfileHealthView.id", { pattern: PROFILE_RE });
    if (typeof profile.available !== "boolean") fail("INTERNAL_RESPONSE_INVALID", "ProfileHealthView.available must be boolean");
    nullable(profile.reasonCode, (item) => oneOf(item, new Set([
      "binary_missing", "credential_missing", "repo_missing", "jail_unavailable", "version_mismatch",
    ]), "ProfileHealthView.reasonCode"));
    if (profile.available !== (profile.reasonCode === null)) fail("INTERNAL_RESPONSE_INVALID", "ProfileHealthView availability and reasonCode disagree");
    if (previousProfileId !== null && profile.id <= previousProfileId) fail("INTERNAL_RESPONSE_INVALID", "ProfileHealthView entries must be uniquely sorted by id");
    previousProfileId = profile.id;
  }, 64, "health.profiles");
  return data;
}

function validateResponse(method, value, context = {}) {
  try {
    value = validationSnapshot(
      value,
      RESPONSE_MAX_BYTES,
      "INTERNAL_RESPONSE_INVALID",
      "Response exceeds 512 KiB",
      { maxDepth: 12, maxKeys: 1_024, maxMembers: 2_048 },
    );
    if (!Object.hasOwn(METHOD_DEADLINES, method)) fail("INTERNAL_RESPONSE_INVALID", `Unknown response method: ${method}`);
    exactObject(value, [
      "v", "gatewayEpoch", "requestId", "ok", "status", "code", "summary",
      "rootCause", "retry", "stopCondition", "nextActions", "artifacts", "data",
      "serverTimeMs",
    ], "response");
    if (value.v !== PROTOCOL_VERSION) fail("INTERNAL_RESPONSE_INVALID", "Response protocol version must be 1");
    string(value.gatewayEpoch, "response.gatewayEpoch", { pattern: EPOCH_RE });
    string(value.requestId, "response.requestId", { pattern: REQUEST_ID_RE });
    if (typeof context.requestId !== "string" || !REQUEST_ID_RE.test(context.requestId) || value.requestId !== context.requestId) {
      fail("INTERNAL_RESPONSE_INVALID", "Current response requestId is required and must match");
    }
    if (method !== "session.open") {
      if (typeof context.gatewayEpoch !== "string" || !EPOCH_RE.test(context.gatewayEpoch) || value.gatewayEpoch !== context.gatewayEpoch) {
        fail("INTERNAL_RESPONSE_INVALID", "Current response gateway epoch is required and must match");
      }
    }
    if (typeof value.ok !== "boolean") fail("INTERNAL_RESPONSE_INVALID", "Response ok must be boolean");
    oneOf(value.status, new Set(["success", "warning", "error"]), "response.status");
    string(value.code, "response.code", { pattern: /^[A-Z][A-Z0-9_]{1,63}$/ });
    summary(value.summary, "response.summary");
    exactObject(value.retry, ["safe", "afterMs"], "response.retry");
    if (typeof value.retry.safe !== "boolean") fail("INTERNAL_RESPONSE_INVALID", "response.retry.safe must be boolean");
    nullable(value.retry.afterMs, (item) => integer(item, 0, 86_400_000, "response.retry.afterMs"));
    boundedArray(value.nextActions, action, 20, "response.nextActions");
    boundedArray(value.artifacts, artifact, 20, "response.artifacts");
    timestamp(value.serverTimeMs, "response.serverTimeMs");

    if (value.status === "error") {
      if (value.ok !== false) fail("INTERNAL_RESPONSE_INVALID", "Error response ok must be false");
      if (!ERROR_CODES.has(value.code)) fail("INTERNAL_RESPONSE_INVALID", "Error response code is not in the contract catalog");
      string(value.rootCause, "response.rootCause", { min: 1, maxChars: 500, maxBytes: 2_000 });
      string(value.stopCondition, "response.stopCondition", { min: 1, maxChars: 500, maxBytes: 2_000 });
      if (!value.data || typeof value.data !== "object" || Array.isArray(value.data) || Object.keys(value.data).length !== 0) {
        fail("INTERNAL_RESPONSE_INVALID", "Error data must be an empty object");
      }
    } else {
      if (value.ok !== true) fail("INTERNAL_RESPONSE_INVALID", "Success or warning response ok must be true");
      if (value.code !== "OK") fail("INTERNAL_RESPONSE_INVALID", "Success or warning response code must be OK");
      if (value.rootCause !== null || value.stopCondition !== null) fail("INTERNAL_RESPONSE_INVALID", "Successful response rootCause and stopCondition must be null");
      validateSuccessData(method, value.data, {
        ...context,
        responseGatewayEpoch: value.gatewayEpoch,
        responseServerTimeMs: value.serverTimeMs,
      });
    }
    if (utf8Bytes(canonicalize(value)) > METHOD_RESPONSE_MAX_BYTES[method]) {
      fail("INTERNAL_RESPONSE_INVALID", `${method} response exceeds the contract limit`);
    }
    return deepFreeze(value);
  } catch (error) {
    if (error instanceof ProtocolError && error.code !== "INTERNAL_RESPONSE_INVALID") {
      throw new ProtocolError("INTERNAL_RESPONSE_INVALID", error.message);
    }
    throw error;
  }
}

function evaluateIdempotency(previous, currentDigest, { method, responseContext } = {}) {
  sha(currentDigest, "request digest");
  if (previous === null) return Object.freeze({ action: "execute" });

  try {
    const record = validationSnapshot(
      previous,
      RESPONSE_MAX_BYTES + 256,
      "STORE_UNAVAILABLE",
      "Stored idempotency record is oversized",
      { maxDepth: 12, maxKeys: 1_024, maxMembers: 2_048 },
    );
    exactObject(record, ["digest", "response"], "stored idempotency record");
    sha(record.digest, "stored request digest");
    if (record.digest !== currentDigest) return Object.freeze({ action: "conflict" });
    const resolvedResponseContext = typeof responseContext === "function" ? responseContext() : responseContext;
    const response = validateResponse(method, record.response, resolvedResponseContext);
    return deepFreeze({ action: "replay", response });
  } catch (error) {
    if (error instanceof ProtocolError && error.code === "STORE_UNAVAILABLE") throw error;
    fail("STORE_UNAVAILABLE", "Stored idempotency record or response is invalid");
  }
}

function consumeOperatorProofForRequest(request, context) {
  const params = request.params;
  switch (request.method) {
    case "work.cancel":
      if (context.workerRefForHandle === undefined) fail("STALE_HANDLE", "workerHandle must resolve before operator proof validation");
      opaqueRef(context.workerRefForHandle, "resolved workerRef");
      operatorProof(params.operatorProof, "worker_cancel", {
        workerRef: context.workerRefForHandle,
        expectedWorkerVersion: params.expectedWorkerVersion,
        reasonCode: params.reasonCode,
      }, context, "consume");
      break;
    case "stop.engage":
      if (params.reasonCode === "operator_stop") {
        operatorProof(params.operatorProof, "stop_engage", {
          expectedStopVersion: params.expectedStopVersion,
          reasonCode: params.reasonCode,
          summary: params.summary,
        }, context, "consume");
      }
      break;
    case "stop.resume":
      operatorProof(params.operatorProof, "stop_resume", {
        expectedStopVersion: params.expectedStopVersion,
      }, context, "consume");
      break;
    case "budget.policy.set":
      operatorProof(params.operatorProof, "budget_policy_change", {
        expectedVersion: params.expectedVersion,
        costLimitEnabled: params.costLimitEnabled,
        costLimitMicros: params.costLimitMicros,
      }, context, "consume");
      break;
  }
}

function validatePostReplayRequest(request, context) {
  // §5 auth-class gate, injected by the dispatch layer. Runs after the replay
  // decision (a committed reply still returns, per the §3 retry law) but before
  // deadline/authority checks and operator-proof consumption, so a denied
  // request never consumes a one-use proof or any other authority.
  if (typeof context.authorizeMethod === "function") context.authorizeMethod(request);
  if (!Number.isSafeInteger(request.deadlineMs) || request.deadlineMs < 1 || request.deadlineMs > METHOD_DEADLINES[request.method]) {
    fail("DEADLINE_EXCEEDED", `deadlineMs must be an integer from 1 through ${METHOD_DEADLINES[request.method]}`);
  }
  switch (request.method) {
    case "session.open":
    case "session.ready":
      requireContractDigest(context, request.params.contractDigest);
      break;
    case "operator.action.begin":
      if (typeof context.operatorSessionDigest !== "string" || request.params.operatorSessionDigest !== context.operatorSessionDigest) {
        fail("OPERATOR_AUTH_REQUIRED", "Operator session does not match the authenticated handler");
      }
      break;
    case "run.accept":
      if (request.params.run.kind !== "system") {
        for (const engineValue of request.params.run.engines) {
          requireProfileBinding(context, request.params.run.profileId, engineValue, request.params.run.kind, request.params.run.repoId);
        }
      }
      break;
  }
  validatePostReplayAuthority(request, context);
  consumeOperatorProofForRequest(request, context);
}

function responseContextForRequest(request, context = {}) {
  const responseContext = {
    requestId: request.requestId,
    expectedContractDigest: context.expectedContractDigest,
    ...(request.method === "session.open" ? {} : { gatewayEpoch: request.gatewayEpoch }),
  };
  if (request.method === "work.output.read") {
    responseContext.afterSeq = request.params.afterSeq;
    responseContext.limitBytes = request.params.limitBytes;
  }
  if (request.method === "session.heartbeat") responseContext.lastServiceSeq = request.params.lastServiceSeq;
  if (request.method === "operator.action.begin") {
    responseContext.operatorAction = request.params.action;
    responseContext.operatorTargetDigest = request.params.targetDigest;
    responseContext.operatorSessionDigest = context.operatorSessionDigest;
  }
  if (request.method === "work.cancel") {
    responseContext.expectedWorkerRef = context.workerRefForHandle;
    responseContext.expectedWorkerVersion = request.params.expectedWorkerVersion;
  }
  if (request.method === "claim.inspect") responseContext.expectedTaskId = request.params.taskId;
  if (request.method === "claim.transition") {
    responseContext.expectedClaimRef = context.claimRefForHandle;
    responseContext.expectedClaimVersion = request.params.expectedVersion;
    responseContext.expectedClaimState = request.params.to;
  }
  if (request.method === "claim.release") {
    responseContext.expectedClaimRef = context.claimRefForHandle;
    responseContext.expectedClaimVersion = request.params.expectedVersion;
  }
  if (request.method === "recovery.request") responseContext.expectedClaimRef = request.params.claimRef;
  if (request.method === "recovery.inspect") responseContext.expectedRecoveryRef = request.params.recoveryRef;
  if (request.method === "work.start") {
    responseContext.expectedTaskId = request.params.taskId;
    responseContext.expectedRunId = request.params.runId;
    responseContext.expectedChainId = request.params.chainId;
    responseContext.expectedClaimRef = request.params.mode === "new" ? null : context.claimRefForHandle;
    responseContext.expectedClaimState = request.params.mode === "review" ? "reviewing" : "active";
    responseContext.expectedAuthorEngine = request.params.mode === "review" ? null : request.params.engine;
  }
  if (request.method === "work.inspect") responseContext.expectedWorkerRef = request.params.workerRef;
  if (request.method === "run.accept") {
    responseContext.expectedRunCanonical = canonicalize(request.params.run);
    responseContext.expectedRunAuthority = context.runAuthorityForRequest;
  }
  if (request.method === "run.transition") {
    responseContext.expectedRunId = request.params.runId;
    responseContext.expectedRunVersion = request.params.expectedVersion;
    responseContext.expectedRunAuthority = context.currentRun?.authority;
    responseContext.expectedRunTransitionCanonical = canonicalize({
      status: request.params.to,
      summary: request.params.summary,
      nextActions: request.params.nextActions,
      artifacts: request.params.artifacts,
    });
  }
  if (request.method === "run.get") responseContext.expectedRunId = request.params.runId;
  if (request.method === "run.list") {
    responseContext.runView = request.params.view;
    responseContext.pageLimit = request.params.limit;
    responseContext.requestCursor = request.params.cursor;
  }
  if (request.method === "run.events") {
    responseContext.afterSeq = request.params.afterSeq;
    responseContext.pageLimit = request.params.limit;
  }
  if (request.method === "stop.engage") {
    responseContext.expectedStopVersion = request.params.expectedStopVersion;
    responseContext.expectedStopReason = request.params.reasonCode;
    responseContext.expectedStopSummary = request.params.summary;
  }
  if (request.method === "stop.resume") responseContext.expectedStopVersion = request.params.expectedStopVersion;
  if (request.method === "budget.policy.set") {
    responseContext.expectedPolicyVersion = request.params.expectedVersion;
    responseContext.expectedCostLimitEnabled = request.params.costLimitEnabled;
    responseContext.expectedCostLimitMicros = request.params.costLimitMicros;
  }
  if (request.method === "budget.policy.get" || request.method === "budget.policy.set") {
    try {
      validateStructuralLimits(context.structuralLimits, "compiled StructuralLimits");
      responseContext.expectedStructuralLimitsCanonical = canonicalize(context.structuralLimits);
    } catch {
      fail("INVALID_POLICY", "Compiled structural budget limits are required");
    }
  }
  if (request.method === "budget.inspect") responseContext.expectedChainId = request.params.chainId;
  if (request.method === "audit.append") responseContext.expectedAuditCanonical = canonicalize(request.params);
  if (request.method === "audit.read") {
    responseContext.afterSeq = request.params.afterSeq;
    responseContext.pageLimit = request.params.limit;
    responseContext.auditFilters = Object.freeze({
      source: request.params.source,
      severity: request.params.severity,
      runId: request.params.runId,
      taskId: request.params.taskId,
    });
  }
  return Object.freeze(responseContext);
}

function validateRequest(value, context = {}) {
  const request = validateRequestShape(value, context);
  if (typeof context.lookupIdempotency !== "function") fail("STORE_UNAVAILABLE", "Root-owned idempotency lookup is required");
  const digestValue = requestDigest(request);
  let previous;
  try {
    previous = context.lookupIdempotency(request.gatewayEpoch, request.requestId);
  } catch {
    fail("STORE_UNAVAILABLE", "Root-owned idempotency lookup failed");
  }
  const decision = evaluateIdempotency(previous, digestValue, {
    method: request.method,
    responseContext: () => responseContextForRequest(request, context),
  });
  if (decision.action === "conflict") fail("IDEMPOTENCY_CONFLICT", "requestId was already used for a different canonical request");
  if (decision.action === "replay") return deepFreeze({ action: "replay", request, digest: digestValue, response: decision.response });
  validatePostReplayRequest(request, context);
  return deepFreeze({ action: "execute", request, digest: digestValue });
}

function encodeFrame(value, options = {}) {
  const maxBytes = options.maxBytes || REQUEST_MAX_BYTES;
  const payload = Buffer.from(canonicalize(value), "utf8");
  if (payload.length > maxBytes) fail("FRAME_TOO_LARGE", `Frame exceeds ${maxBytes} bytes`);
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

class RequestFrameDecoder {
  constructor({
    maxBytes = REQUEST_MAX_BYTES,
    deadlineMs = FRAME_DEADLINE_MS,
    now = Date.now,
    onDeadline,
    schedule = setTimeout,
    cancelSchedule = clearTimeout,
  } = {}) {
    if (typeof onDeadline !== "function") fail("INVALID_POLICY", "Frame decoder requires an onDeadline connection-close callback");
    if (typeof schedule !== "function" || typeof cancelSchedule !== "function") fail("INVALID_POLICY", "Frame decoder timer functions are invalid");
    integer(maxBytes, 1, REQUEST_MAX_BYTES, "Frame decoder maxBytes");
    integer(deadlineMs, 1, FRAME_DEADLINE_MS, "Frame decoder deadlineMs");
    this.maxBytes = maxBytes;
    this.deadlineMs = deadlineMs;
    this.now = now;
    this.onDeadline = onDeadline;
    this.schedule = schedule;
    this.cancelSchedule = cancelSchedule;
    this.buffer = Buffer.alloc(0);
    this.expectedBytes = null;
    this.startedAtMs = this.now();
    this.awaitingResponse = false;
    this.failed = false;
    this.deadlineTimer = null;
    this.armDeadline();
  }

  push(chunk) {
    if (this.failed) fail("PROTOCOL_ERROR", "Frame decoder is closed after an error");
    if (this.awaitingResponse) return this.abort("INFLIGHT_VIOLATION", "A second request arrived before the response was written");
    if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) return this.abort("PROTOCOL_ERROR", "Frame chunk must be bytes");
    if (this.startedAtMs === null) {
      this.startedAtMs = this.now();
      this.armDeadline();
    }
    this.checkDeadline();
    if (chunk.length === 0) return null;
    const incomingLength = this.buffer.length + chunk.length;
    if (incomingLength > this.maxBytes + 4) {
      return this.abort("FRAME_TOO_LARGE", `Frame exceeds ${this.maxBytes} bytes`);
    }
    if (this.expectedBytes !== null && incomingLength > this.expectedBytes + 4) {
      return this.abort("INFLIGHT_VIOLATION", "More than one request frame is buffered");
    }
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    if (this.expectedBytes === null && this.buffer.length >= 4) {
      this.expectedBytes = this.buffer.readUInt32BE(0);
      if (this.expectedBytes === 0) return this.abort("PROTOCOL_ERROR", "Empty JSON frame is forbidden");
      if (this.expectedBytes > this.maxBytes) return this.abort("FRAME_TOO_LARGE", `Frame exceeds ${this.maxBytes} bytes`);
    }
    if (this.expectedBytes === null || this.buffer.length < this.expectedBytes + 4) return null;
    if (this.buffer.length > this.expectedBytes + 4) return this.abort("INFLIGHT_VIOLATION", "More than one request frame is buffered");
    let parsed;
    try { parsed = parseStrictJson(this.buffer.subarray(4)); }
    catch (error) {
      this.failed = true;
      this.clearDeadline();
      throw error;
    }
    this.buffer = Buffer.alloc(0);
    this.expectedBytes = null;
    this.startedAtMs = null;
    this.clearDeadline();
    this.awaitingResponse = true;
    return parsed;
  }

  checkDeadline() {
    if (this.startedAtMs !== null && this.now() - this.startedAtMs >= this.deadlineMs) {
      return this.abort("DEADLINE_EXCEEDED", "Incomplete frame deadline exceeded");
    }
    return false;
  }

  responseWritten() {
    if (!this.awaitingResponse) fail("PROTOCOL_ERROR", "No response is pending");
    this.awaitingResponse = false;
  }

  end() {
    this.clearDeadline();
    if (this.buffer.length || this.expectedBytes !== null) return this.abort("TRUNCATED_FRAME", "Connection ended during a frame");
    return null;
  }

  armDeadline() {
    this.clearDeadline();
    this.deadlineTimer = this.schedule(() => {
      if (this.failed || this.awaitingResponse || this.startedAtMs === null) return;
      this.failed = true;
      this.deadlineTimer = null;
      this.onDeadline(new ProtocolError("DEADLINE_EXCEEDED", "Incomplete frame deadline exceeded"));
    }, this.deadlineMs);
    if (this.deadlineTimer && typeof this.deadlineTimer.unref === "function") this.deadlineTimer.unref();
  }

  clearDeadline() {
    if (this.deadlineTimer !== null) {
      this.cancelSchedule(this.deadlineTimer);
      this.deadlineTimer = null;
    }
  }

  abort(code, message) {
    this.failed = true;
    this.clearDeadline();
    fail(code, message);
  }
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function createHandleRegistry({ randomBytes = crypto.randomBytes } = {}) {
  const records = new Map();

  return Object.freeze({
    issue({ connectionId, epoch, kind, value }) {
      string(connectionId, "connectionId", { min: 1, maxChars: 128, maxBytes: 512 });
      string(epoch, "epoch", { pattern: EPOCH_RE });
      string(kind, "kind", { pattern: ACTION_ID_RE });
      let issued;
      for (let attempt = 0; attempt < 8; attempt++) {
        const bytes = randomBytes(24);
        if (!Buffer.isBuffer(bytes) || bytes.length !== 24) fail("INTERNAL_RESPONSE_INVALID", "Handle random source must return 24 bytes");
        issued = "hdl_" + bytes.toString("base64url");
        if (!records.has(issued)) break;
        issued = null;
      }
      if (!issued) fail("STORE_UNAVAILABLE", "Could not allocate a unique handle");
      records.set(issued, { connectionId, epoch, kind, value: clone(value) });
      return issued;
    },

    resolve(issued, { connectionId, epoch, kind }) {
      const record = records.get(issued);
      if (!record || record.connectionId !== connectionId || record.epoch !== epoch || record.kind !== kind) {
        fail("STALE_HANDLE", "Handle is missing or belongs to another connection, epoch, or kind");
      }
      return clone(record.value);
    },

    consume(issued, { connectionId, epoch, kind }) {
      const record = records.get(issued);
      if (!record || record.connectionId !== connectionId || record.epoch !== epoch || record.kind !== kind) {
        fail("STALE_HANDLE", "Handle is missing or belongs to another connection, epoch, or kind");
      }
      records.delete(issued);
      return clone(record.value);
    },

    revokeConnection(connectionId) {
      let revoked = 0;
      for (const [issued, record] of records) {
        if (record.connectionId === connectionId) {
          records.delete(issued);
          revoked++;
        }
      }
      return revoked;
    },
  });
}

module.exports = {
  PROTOCOL_VERSION,
  REQUEST_MAX_BYTES,
  RESPONSE_MAX_BYTES,
  FRAME_DEADLINE_MS,
  LIMITS_VIEW,
  ERROR_CODES,
  METHOD_DEADLINES,
  METHOD_PARAM_MAX_BYTES,
  METHOD_RESPONSE_MAX_BYTES,
  ProtocolError,
  canonicalize,
  profileBindingKey,
  requestDigest,
  operatorTargetDigest,
  contractDigest,
  parseStrictJson,
  validateRequest,
  validateResponse,
  responseContextForRequest,
  evaluateIdempotency,
  encodeFrame,
  RequestFrameDecoder,
  createHandleRegistry,
};
