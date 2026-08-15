import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  ProtocolError,
  REQUEST_MAX_BYTES,
  canonicalize,
  profileBindingKey,
  requestDigest,
  operatorTargetDigest,
  parseStrictJson,
  validateRequest,
  validateResponse,
  responseContextForRequest,
  evaluateIdempotency,
  encodeFrame,
  RequestFrameDecoder,
  createHandleRegistry,
} = require("../container/maintenance-protocol.js");

const GW = "gw_0123456789abcdef0123456789abcdef";
const REQ = "req_0123456789abcdef0123456789abcdef";
const SHA = "sha256:" + "a".repeat(64);
const WORKER_REF = "wrk_" + "b".repeat(22);
const CLAIM_REF = "clm_" + "c".repeat(22);
const HANDLE = "hdl_0123456789abcdefghijkl";
const WORKER_HANDLE = "hdl_zyxwvutsrqponmlkjihgfedc";
const OPERATOR_SESSION = "sha256:" + "d".repeat(64);
const CONNECTION_ID = "gate-connection-1";

function request(method, params = {}, overrides = {}) {
  return {
    v: 1,
    gatewayEpoch: GW,
    requestId: REQ,
    deadlineMs: 2_000,
    method,
    params,
    ...overrides,
  };
}

function commonResponse(overrides = {}) {
  return {
    v: 1,
    gatewayEpoch: GW,
    requestId: REQ,
    ok: true,
    status: "success",
    code: "OK",
    summary: "Ready.",
    rootCause: null,
    retry: { safe: false, afterMs: null },
    stopCondition: null,
    nextActions: [],
    artifacts: [],
    data: {},
    serverTimeMs: 1_784_690_000_000,
    ...overrides,
  };
}

function requestContext(overrides = {}) {
  return {
    gatewayEpoch: GW,
    expectedContractDigest: SHA,
    lookupIdempotency: () => null,
    ...overrides,
  };
}

function responseContext(method, overrides = {}) {
  return {
    requestId: REQ,
    expectedContractDigest: SHA,
    ...(method === "session.open" ? {} : { gatewayEpoch: GW }),
    ...overrides,
  };
}

function authorize(value, overrides = {}) {
  return validateRequest(value, requestContext(overrides));
}

function workStartRequest(objective = "Review the candidate change.") {
  return request("work.start", {
    mode: "new",
    taskId: "t_123",
    runId: "run:123",
    chainId: "chain:123",
    engine: "codex",
    profileId: "board.codex",
    repoId: "repo_0123456789abcdef",
    objective,
    claimHandle: null,
  }, { deadlineMs: 10_000 });
}

function workAuthorityContext(value = workStartRequest(), overrides = {}) {
  const acceptedRun = {
    id: value.params.runId,
    kind: "board_task",
    authority: "worker",
    taskId: value.params.taskId,
    chainId: value.params.chainId,
    profileId: value.params.profileId,
    repoId: value.params.repoId,
    workMode: value.params.mode,
    engines: [value.params.engine],
  };
  return {
    acceptedRun,
    profileBindings: new Set([
      profileBindingKey(value.params.profileId, value.params.engine, acceptedRun.kind, value.params.repoId),
    ]),
    ...overrides,
  };
}

function issueOperatorProof(registry, { action, target, expiresAtMs, issuedAtMs = expiresAtMs - 1_000, sessionDigest = OPERATOR_SESSION }) {
  const targetDigest = operatorTargetDigest(target);
  const actionHandle = registry.issue({
    connectionId: CONNECTION_ID,
    epoch: GW,
    kind: "operator_proof",
    value: { action, targetDigest, operatorSessionDigest: sessionDigest, issuedAtMs, expiresAtMs },
  });
  return { actionHandle, action, targetDigest, expiresAtMs };
}

function decoder(options = {}) {
  return new RequestFrameDecoder({ onDeadline() {}, ...options });
}

test("JCS canonicalization is deterministic and rejects values outside contract v1", () => {
  assert.equal(canonicalize({ z: 1, a: [true, null, "é"] }), '{"a":[true,null,"é"],"z":1}');
  assert.equal(canonicalize({ b: 1, a: 2 }), canonicalize({ a: 2, b: 1 }));
  assert.throws(() => canonicalize({ n: -0 }), (error) => error instanceof ProtocolError && error.code === "INVALID_REQUEST");
  assert.throws(() => canonicalize({ n: Number.MAX_SAFE_INTEGER + 1 }), /safe number/i);
  assert.throws(() => canonicalize({ value: undefined }), /unsupported/i);
});

test("request and operator digests are domain-separated lowercase SHA-256", () => {
  const a = requestDigest(request("stop.get"));
  const b = requestDigest({ ...request("stop.get"), params: {} });
  const target = operatorTargetDigest({ expectedStopVersion: 2 });
  assert.match(a, /^sha256:[0-9a-f]{64}$/);
  assert.equal(a, b);
  assert.notEqual(a, target);
  assert.notEqual(operatorTargetDigest({ b: 1, a: 2 }), operatorTargetDigest({ a: 2, b: 2 }));
  assert.equal(operatorTargetDigest({ b: 1, a: 2 }), operatorTargetDigest({ a: 2, b: 1 }));
});

test("strict JSON rejects duplicate keys, unsafe numbers, negative zero, lone surrogates, and trailing bytes", () => {
  for (const raw of [
    '{"a":1,"a":2}',
    '{"n":9007199254740992}',
    '{"n":-0}',
    '"\\ud800"',
    '{"a":1} garbage',
  ]) {
    assert.throws(() => parseStrictJson(Buffer.from(raw)), ProtocolError, raw);
  }
});

test("strict JSON preserves hostile property names without polluting prototypes", () => {
  const parsed = parseStrictJson(Buffer.from('{"__proto__":{"polluted":true},"constructor":"data"}'));
  assert.equal(Object.hasOwn(parsed, "__proto__"), true);
  assert.equal(parsed.__proto__.polluted, true);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(parsed.constructor, "data");
});

test("request envelope is exact and session.open is the only null-epoch request", () => {
  const opened = authorize(request("session.open", {
    protocolVersion: 1,
    contractDigest: SHA,
  }, { gatewayEpoch: null, deadlineMs: 2_000 }));
  assert.equal(opened.request.method, "session.open");

  assert.throws(() => authorize(request("stop.get", {}, { gatewayEpoch: null })), /epoch/i);
  assert.throws(() => authorize({ ...request("stop.get"), surprise: true }), /unknown field/i);
  assert.throws(() => authorize(request("root.exec")), (error) => error.code === "UNKNOWN_METHOD");
  assert.throws(() => authorize(request("stop.get", {}, { deadlineMs: 2_001 })), (error) => error.code === "DEADLINE_EXCEEDED");
  assert.throws(() => authorize(request("stop.get"), { gatewayEpoch: undefined }), (error) => error.code === "STALE_EPOCH");
  assert.throws(() => authorize(request("session.open", {
    protocolVersion: 1,
    contractDigest: "sha256:" + "b".repeat(64),
  }, { gatewayEpoch: null })), (error) => error.code === "VERSION_MISMATCH");
});

test("work.start accepts only the atomic fixed-profile shape", () => {
  const valid = workStartRequest();
  const authority = workAuthorityContext(valid);
  assert.equal(authorize(valid, authority).request.params.mode, "new");

  for (const forbidden of [
    { command: "sh" }, { argv: ["-c", "id"] }, { worktree: "/work" },
    { pid: 123 }, { signal: "SIGKILL" }, { env: { TOKEN: "x" } },
    { fromEngine: "claude" }, { amount: 1 }, { budget: { cost: 1 } },
  ]) {
    assert.throws(() => authorize({ ...valid, params: { ...valid.params, ...forbidden } }, authority), /unknown field/i);
  }

  assert.throws(() => authorize({ ...valid, params: { ...valid.params, mode: "review", claimHandle: null } }, authority), /claimHandle/i);
  assert.throws(() => authorize({ ...valid, params: { ...valid.params, mode: "new", claimHandle: "hdl_0123456789abcdefghijkl" } }, authority), /claimHandle/i);
});

test("work.start requires the accepted run and exact compiled tuple", () => {
  const valid = workStartRequest();
  assert.throws(() => authorize(valid), (error) => error.code === "RUN_NOT_ACCEPTED");
  assert.throws(() => authorize(valid, {
    ...workAuthorityContext(valid),
    profileBindings: new Set(),
  }), (error) => error.code === "PROFILE_UNAVAILABLE");
  assert.throws(() => authorize(valid, {
    ...workAuthorityContext(valid),
    acceptedRun: { ...workAuthorityContext(valid).acceptedRun, taskId: "task:different" },
  }), (error) => error.code === "RUN_CONFLICT");
  const controlled = workStartRequest("Review\u0085the change.");
  assert.throws(() => authorize(controlled, workAuthorityContext(controlled)), /control character/i);
});

test("audit.append cannot spoof root-authored authority events", () => {
  const callerEvent = request("audit.append", {
    eventCode: "client_disconnected",
    severity: "info",
    runId: null,
    taskId: null,
    engine: null,
    detail: { surface: "chat" },
  }, { deadlineMs: 5_000 });
  assert.equal(authorize(callerEvent).request.params.eventCode, "client_disconnected");

  assert.throws(() => authorize({
    ...callerEvent,
    params: { ...callerEvent.params, eventCode: "worker_reaped", detail: { workerRef: "wrk_x" } },
  }), (error) => error.code === "EVENT_CODE_RESERVED");
  assert.throws(() => authorize({
    ...callerEvent,
    params: { ...callerEvent.params, severity: "error" },
  }), /severity/i);
});

test("operator proof is target-bound, session-bound, one-use, and replay-safe", () => {
  const nowMs = 1_784_690_000_000;
  const target = { expectedStopVersion: 7 };
  const registry = createHandleRegistry();
  const proof = issueOperatorProof(registry, { action: "stop_resume", target, expiresAtMs: nowMs + 1_000 });
  const valid = request("stop.resume", { expectedStopVersion: 7, operatorProof: proof }, { deadlineMs: 5_000 });
  const authority = {
    nowMs,
    operatorProofRegistry: registry,
    connectionId: CONNECTION_ID,
    operatorSessionDigest: OPERATOR_SESSION,
  };
  assert.equal(authorize(valid, authority).request.params.expectedStopVersion, 7);
  assert.throws(() => authorize(valid, authority), (error) => error.code === "STALE_HANDLE");

  assert.throws(() => authorize({
    ...valid,
    params: { ...valid.params, expectedStopVersion: 8 },
  }, authority), (error) => error.code === "OPERATOR_TARGET_MISMATCH");

  const replayResponse = commonResponse({
    data: { stop: { engaged: false, version: 8, reasonCode: null, summary: null, changedAtMs: nowMs } },
  });
  const replay = authorize(valid, {
    lookupIdempotency: () => ({ digest: requestDigest(valid), response: replayResponse }),
  });
  assert.equal(replay.action, "replay");
  assert.equal(replay.response.data.stop.engaged, false);

  const futureRegistry = createHandleRegistry();
  const futureProof = issueOperatorProof(futureRegistry, {
    action: "stop_resume", target, expiresAtMs: nowMs + 30_001,
  });
  assert.throws(() => authorize(request("stop.resume", {
    expectedStopVersion: 7, operatorProof: futureProof,
  }, { deadlineMs: 5_000 }), {
    nowMs,
    operatorProofRegistry: futureRegistry,
    connectionId: CONNECTION_ID,
    operatorSessionDigest: OPERATOR_SESSION,
  }), (error) => error.code === "OPERATOR_AUTH_REQUIRED");

  const crossSessionRegistry = createHandleRegistry();
  const crossSessionProof = issueOperatorProof(crossSessionRegistry, {
    action: "stop_resume", target, expiresAtMs: nowMs + 1_000,
  });
  assert.throws(() => authorize(request("stop.resume", {
    expectedStopVersion: 7, operatorProof: crossSessionProof,
  }, { deadlineMs: 5_000 }), {
    nowMs,
    operatorProofRegistry: crossSessionRegistry,
    connectionId: CONNECTION_ID,
    operatorSessionDigest: "sha256:" + "e".repeat(64),
  }), (error) => error.code === "OPERATOR_AUTH_REQUIRED");
});

test("work.cancel proof is bound to the service-resolved worker reference", () => {
  const nowMs = 1_784_690_000_000;
  const target = { workerRef: WORKER_REF, expectedWorkerVersion: 2, reasonCode: "operator_cancel" };
  const registry = createHandleRegistry();
  const proof = issueOperatorProof(registry, { action: "worker_cancel", target, expiresAtMs: nowMs + 1_000 });
  const cancel = request("work.cancel", {
    workerHandle: HANDLE,
    expectedWorkerVersion: 2,
    reasonCode: "operator_cancel",
    operatorProof: proof,
  }, { deadlineMs: 5_000 });

  const authority = {
    nowMs,
    operatorProofRegistry: registry,
    connectionId: CONNECTION_ID,
    operatorSessionDigest: OPERATOR_SESSION,
  };
  assert.throws(() => authorize(cancel, authority), (error) => error.code === "STALE_HANDLE");
  assert.throws(() => authorize(cancel, {
    ...authority,
    workerRefForHandle: "wrk_" + "d".repeat(22),
  }), (error) => error.code === "OPERATOR_TARGET_MISMATCH");
  assert.equal(authorize(cancel, { ...authority, workerRefForHandle: WORKER_REF }).request.params.workerHandle, HANDLE);
  assert.throws(() => authorize(cancel, {
    ...authority,
    nowMs,
    workerRefForHandle: WORKER_REF,
  }), (error) => error.code === "STALE_HANDLE");
});

test("client disconnect and service teardown reasons cannot call work.cancel", () => {
  for (const reasonCode of ["client_disconnect", "timeout", "stop_epoch", "shutdown"]) {
    assert.throws(() => authorize(request("work.cancel", {
      workerHandle: "hdl_0123456789abcdefghijkl",
      expectedWorkerVersion: 2,
      reasonCode,
      operatorProof: null,
    }, { deadlineMs: 5_000 })), /reasonCode|operator/i);
  }
});

test("idempotency evaluation executes, replays, or conflicts without ambiguity", () => {
  const digest = requestDigest(request("stop.get"));
  assert.deepEqual(evaluateIdempotency(null, digest), { action: "execute" });
  const response = commonResponse({
    data: { stop: { engaged: true, version: 1, reasonCode: "first_secure_boot", summary: "Stopped.", changedAtMs: 1 } },
  });
  const options = { method: "stop.get", responseContext: responseContext("stop.get") };
  const replay = evaluateIdempotency({ digest, response }, digest, options);
  assert.equal(replay.action, "replay");
  assert.equal(replay.response.data.stop.engaged, true);
  assert.deepEqual(evaluateIdempotency({ digest, response }, "sha256:" + "b".repeat(64), options), {
    action: "conflict",
  });
  for (const corrupt of [undefined, false, 0, "", { digest, response: undefined }, { digest, response: {} }]) {
    assert.throws(() => evaluateIdempotency(corrupt, digest, options), (error) => error.code === "STORE_UNAVAILABLE");
  }
});

test("a conflicting retry precedes stored-response correlation and operator proof consumption", () => {
  const nowMs = 1_784_690_000_000;
  const registry = createHandleRegistry();
  const original = request("stop.resume", {
    expectedStopVersion: 7,
    operatorProof: issueOperatorProof(registry, {
      action: "stop_resume",
      target: { expectedStopVersion: 7 },
      expiresAtMs: nowMs + 1_000,
    }),
  }, { deadlineMs: 5_000 });
  const replacement = {
    ...original,
    params: {
      expectedStopVersion: 8,
      operatorProof: issueOperatorProof(registry, {
        action: "stop_resume",
        target: { expectedStopVersion: 8 },
        expiresAtMs: nowMs + 1_000,
      }),
    },
  };
  const committedResponse = commonResponse({
    data: { stop: { engaged: false, version: 8, reasonCode: null, summary: null, changedAtMs: nowMs } },
  });
  const authority = {
    nowMs,
    operatorProofRegistry: registry,
    connectionId: CONNECTION_ID,
    operatorSessionDigest: OPERATOR_SESSION,
    lookupIdempotency: () => ({ digest: requestDigest(original), response: committedResponse }),
  };
  assert.throws(() => authorize(replacement, authority), (error) => error.code === "IDEMPOTENCY_CONFLICT");

  assert.equal(authorize(replacement, {
    ...authority,
    lookupIdempotency: () => null,
  }).action, "execute");
});

test("response envelope is exact and malformed success fails closed", () => {
  const valid = commonResponse({
    data: {
      state: "ready",
      stop: { engaged: true, version: 1, reasonCode: "first_secure_boot", summary: "Stopped.", changedAtMs: 1 },
    },
  });
  const context = responseContext("session.ready");
  assert.equal(validateResponse("session.ready", valid, context).ok, true);
  assert.throws(() => validateResponse("session.ready", valid), (error) => error.code === "INTERNAL_RESPONSE_INVALID");
  assert.throws(() => validateResponse("session.ready", { ...valid, extra: true }, context), /unknown field/i);
  assert.throws(() => validateResponse("session.ready", { ...valid, data: {} }, context), (error) => error.code === "INTERNAL_RESPONSE_INVALID");
  assert.throws(() => validateResponse("session.ready", { ...valid, status: "error", ok: true }, context), /ok|status/i);
});

test("error responses require a stable code and carry no success data", () => {
  const error = commonResponse({
    ok: false,
    status: "error",
    code: "STOP_ENGAGED",
    summary: "New work is stopped.",
    rootCause: "STOP_ENGAGED",
    retry: { safe: false, afterMs: null },
    stopCondition: "Do not launch work.",
    data: {},
  });
  const context = responseContext("work.start");
  assert.equal(validateResponse("work.start", error, context).ok, false);
  assert.throws(() => validateResponse("work.start", { ...error, data: { launched: true } }, context), /error data/i);
  assert.throws(() => validateResponse("work.start", { ...error, code: "MADE_UP_ERROR" }, context), /catalog/i);
});

test("response artifacts cannot expose host paths or URLs", () => {
  const ready = commonResponse({
    data: {
      state: "ready",
      stop: { engaged: true, version: 1, reasonCode: "first_secure_boot", summary: "Stopped.", changedAtMs: 1 },
    },
  });
  for (const ref of ["C:\\root\\secret", "/data/secret", "https://example.test/secret"]) {
    assert.throws(() => validateResponse("session.ready", {
      ...ready,
      artifacts: [{ type: "record", id: null, label: "Result", ref }],
    }, responseContext("session.ready")), /artifact\.ref|invalid format/i);
  }
});

test("each method enforces its smaller request and response byte budget", () => {
  const largeArtifacts = Array.from({ length: 20 }, (_, index) => ({
    type: "record",
    id: `${index}`.padEnd(300, "i"),
    label: "l".repeat(300),
    ref: "r".repeat(1_000),
  }));
  const accept = request("run.accept", {
    run: {
      id: "run:large",
      kind: "board_task",
      taskId: "task:large",
      chainId: "chain:large",
      profileId: "board.codex",
      repoId: "repo_0123456789abcdef",
      workMode: "new",
      engines: ["codex"],
      summary: "Large run.",
      nextActions: [],
      artifacts: largeArtifacts,
    },
  }, { deadlineMs: 5_000 });
  assert.throws(() => authorize(accept), (error) => error.code === "FRAME_TOO_LARGE");

  const ready = commonResponse({
    artifacts: largeArtifacts,
    data: {
      state: "ready",
      stop: { engaged: true, version: 1, reasonCode: "first_secure_boot", summary: "Stopped.", changedAtMs: 1 },
    },
  });
  assert.throws(() => validateResponse("session.ready", ready, responseContext("session.ready")), /contract limit/i);
});

test("response snapshots enforce the binding recursive key limit", () => {
  const runs = Array.from({ length: 60 }, (_, index) => ({
    id: `run:${index}`,
    kind: "board_task",
    status: "queued",
    authority: "worker",
    taskId: `task:${index}`,
    chainId: `chain:${index}`,
    profileId: "board.codex",
    repoId: "repo_0123456789abcdef",
    workMode: "new",
    engines: ["codex"],
    summary: "Queued.",
    createdAtMs: 1,
    startedAtMs: null,
    updatedAtMs: 1,
    finishedAtMs: null,
    nextActions: [],
    artifacts: [],
    version: 1,
  }));
  assert.throws(() => validateResponse("run.list", commonResponse({
    data: { runs, nextCursor: null, hasMore: true, truncated: true },
  }), responseContext("run.list")), /key limit/i);
});

test("session.open reports only the exact compiled limits", () => {
  const limits = {
    maxRequestBytes: 393_216,
    maxResponseBytes: 524_288,
    maxObjectiveBytes: 131_072,
    maxOutputReadBytes: 65_536,
    maxListItems: 200,
    maxInFlight: 1,
    heartbeatIntervalMs: 5_000,
    heartbeatTimeoutMs: 20_000,
    readDeadlineMs: 2_000,
    mutationDeadlineMs: 5_000,
    launchDeadlineMs: 10_000,
  };
  const opened = commonResponse({
    data: {
      serviceEpoch: "svc_" + "e".repeat(32),
      gatewayEpoch: GW,
      protocolVersion: 1,
      contractDigest: SHA,
      state: "connected_not_ready",
      limits,
    },
  });
  assert.equal(validateResponse("session.open", opened, responseContext("session.open")).data.limits.maxInFlight, 1);
  assert.throws(() => validateResponse("session.open", {
    ...opened,
    data: { ...opened.data, limits: { ...limits, maxInFlight: 2 } },
  }, responseContext("session.open")), /maxInFlight/i);
  assert.throws(() => validateResponse("session.open", {
    ...opened,
    data: { ...opened.data, contractDigest: "sha256:" + "b".repeat(64) },
  }, responseContext("session.open")), /contract digest/i);
  assert.throws(() => validateResponse("session.open", {
    ...opened,
    data: { ...opened.data, gatewayEpoch: "gw_" + "f".repeat(32) },
  }, responseContext("session.open")), /envelope and data gateway epochs/i);
});

test("operator proof responses match the initiating session, action, target, and issuance window", () => {
  const begin = request("operator.action.begin", {
    action: "stop_resume",
    operatorSessionDigest: OPERATOR_SESSION,
    targetDigest: SHA,
  }, { deadlineMs: 5_000 });
  const context = responseContextForRequest(begin, {
    expectedContractDigest: SHA,
    operatorSessionDigest: OPERATOR_SESSION,
  });
  const valid = commonResponse({
    data: {
      operatorProof: {
        actionHandle: HANDLE,
        action: "stop_resume",
        targetDigest: SHA,
        expiresAtMs: 1_784_690_001_000,
      },
    },
  });
  assert.equal(validateResponse("operator.action.begin", valid, context).data.operatorProof.action, "stop_resume");
  assert.throws(() => validateResponse("operator.action.begin", {
    ...valid,
    data: { operatorProof: { ...valid.data.operatorProof, action: "stop_engage" } },
  }, context), /initiating action and target/i);
  assert.throws(() => validateResponse("operator.action.begin", {
    ...valid,
    data: { operatorProof: { ...valid.data.operatorProof, targetDigest: "sha256:" + "b".repeat(64) } },
  }, context), /initiating action and target/i);
  assert.throws(() => validateResponse("operator.action.begin", {
    ...valid,
    data: { operatorProof: { ...valid.data.operatorProof, expiresAtMs: valid.serverTimeMs + 30_001 } },
  }, context), /30-second issuance window/i);
});

test("health reports the compiled contract digest", () => {
  const stores = Object.fromEntries(["claims", "runs", "stop", "budgets", "audit", "idempotency"].map((name) => [
    name, { state: "healthy", quarantinedRecords: 0, lastDurableSeq: 1 },
  ]));
  const health = commonResponse({
    data: {
      state: "ready",
      serviceVersion: "1.0.0",
      contractDigest: SHA,
      migrationState: "complete",
      reconciliationState: "clean",
      stop: { engaged: false, version: 1, reasonCode: null, summary: null, changedAtMs: 1 },
      stores,
      profiles: [],
    },
  });
  assert.equal(validateResponse("service.health", health, responseContext("service.health")).data.contractDigest, SHA);
  assert.throws(() => validateResponse("service.health", {
    ...health,
    data: { ...health.data, contractDigest: "sha256:" + "b".repeat(64) },
  }, responseContext("service.health")), /contract digest/i);
});

test("service audit and run events cannot cross their authority source boundary", () => {
  const auditContext = responseContextForRequest(request("audit.read", {
    afterSeq: 0,
    limit: 200,
    source: null,
    severity: null,
    runId: null,
    taskId: null,
  }), { expectedContractDigest: SHA });
  const audit = {
    seq: 1,
    eventCode: "spawn_attempted",
    source: "service",
    severity: "info",
    atMs: 1,
    runId: "run:1",
    taskId: "task:1",
    engine: "codex",
    detail: { claimRef: CLAIM_REF, workerRef: WORKER_REF },
  };
  const auditResponse = commonResponse({
    data: { events: [audit], nextCursor: null, hasMore: false, truncated: false },
  });
  assert.equal(validateResponse("audit.read", auditResponse, auditContext).data.events[0].source, "service");
  assert.throws(() => validateResponse("audit.read", {
    ...auditResponse,
    data: { ...auditResponse.data, events: [{ ...audit, detail: { workerRef: WORKER_REF } }] },
  }, auditContext), /claimRef/i);

  const event = {
    seq: 1,
    runId: "run:1",
    eventCode: "service_running",
    source: "gate",
    atMs: 1,
    status: "running",
    kind: "board_task",
    engine: "codex",
    engines: ["codex"],
    summary: "Running.",
    nextActions: [],
    artifacts: [],
    runVersion: 2,
  };
  const runEventsContext = responseContextForRequest(request("run.events", { afterSeq: 0, limit: 200 }), {
    expectedContractDigest: SHA,
  });
  assert.throws(() => validateResponse("run.events", commonResponse({
    data: { ledgerGeneration: 1, events: [event], nextCursor: null, hasMore: false, truncated: false },
  }), runEventsContext), /eventCode/i);

  assert.throws(() => validateResponse("run.events", commonResponse({
    data: {
      ledgerGeneration: 1,
      events: [{ ...event, source: "service", engine: "claude", engines: ["codex"] }],
      nextCursor: null,
      hasMore: false,
      truncated: false,
    },
  }), runEventsContext), /single engines entry/i);
});

test("claim.release and work.cancel cannot report impossible success states", () => {
  const claim = {
    ref: CLAIM_REF,
    taskId: "task:1",
    runId: "run:1",
    chainId: "chain:1",
    authorEngine: "codex",
    state: "active",
    version: 2,
    workerRef: null,
    recoveryRef: null,
    updatedAtMs: 1,
  };
  assert.throws(() => validateResponse("claim.release", commonResponse({
    data: { claim },
  }), responseContext("claim.release")), /released tombstone/i);
  assert.throws(() => validateResponse("claim.release", commonResponse({
    data: { claim: { ...claim, state: "released", workerRef: WORKER_REF } },
  }), responseContext("claim.release")), /cannot retain a worker or recovery/i);

  const worker = {
    ref: WORKER_REF,
    claimRef: CLAIM_REF,
    state: "running",
    version: 2,
    exitCode: null,
    signalName: null,
    outputNextSeq: 0,
    outputEof: false,
    startedAtMs: 1,
    finishedAtMs: null,
  };
  assert.throws(() => validateResponse("work.cancel", commonResponse({
    data: { worker },
  }), responseContext("work.cancel", { expectedWorkerRef: WORKER_REF, expectedWorkerVersion: 2 })), /stopping-or-later/i);

  const cancel = request("work.cancel", {
    workerHandle: HANDLE,
    expectedWorkerVersion: 2,
    reasonCode: "operator_cancel",
    operatorProof: {
      actionHandle: HANDLE,
      action: "worker_cancel",
      targetDigest: operatorTargetDigest({ workerRef: WORKER_REF, expectedWorkerVersion: 2, reasonCode: "operator_cancel" }),
      expiresAtMs: 1_784_690_001_000,
    },
  }, { deadlineMs: 5_000 });
  const cancelContext = responseContextForRequest(cancel, {
    expectedContractDigest: SHA,
    workerRefForHandle: WORKER_REF,
  });
  const stopping = { ...worker, state: "stopping", version: 3 };
  assert.equal(validateResponse("work.cancel", commonResponse({ data: { worker: stopping } }), cancelContext).data.worker.state, "stopping");
  assert.throws(() => validateResponse("work.cancel", commonResponse({
    data: { worker: { ...stopping, ref: "wrk_" + "d".repeat(22) } },
  }), cancelContext), /requested worker and newer version/i);
  assert.throws(() => validateResponse("work.cancel", commonResponse({
    data: { worker: { ...stopping, version: 2 } },
  }), cancelContext), /requested worker and newer version/i);
  assert.throws(() => validateResponse("work.cancel", commonResponse({
    data: { worker: { ...stopping, state: "completed" } },
  }), cancelContext), /requires finishedAtMs and outputEof/i);
});

test("work responses cannot mix records from different tasks", () => {
  const start = workStartRequest();
  const context = responseContextForRequest(start, { expectedContractDigest: SHA });
  const claim = {
    ref: CLAIM_REF,
    taskId: start.params.taskId,
    runId: start.params.runId,
    chainId: start.params.chainId,
    authorEngine: "codex",
    state: "active",
    version: 1,
    workerRef: WORKER_REF,
    recoveryRef: null,
    updatedAtMs: 1,
  };
  const worker = {
    ref: WORKER_REF,
    claimRef: CLAIM_REF,
    state: "running",
    version: 2,
    exitCode: null,
    signalName: null,
    outputNextSeq: 0,
    outputEof: false,
    startedAtMs: 1,
    finishedAtMs: null,
  };
  const budget = {
    chainId: start.params.chainId,
    policyVersion: 1,
    execs: 1,
    tokenUnits: 0,
    costMicros: 0,
    reservedTokenUnits: 1,
    reservedCostMicros: 1,
    softStop: false,
    exhausted: false,
  };
  const response = commonResponse({
    data: { claimHandle: HANDLE, workerHandle: WORKER_HANDLE, claim, worker, budget },
  });
  assert.equal(validateResponse("work.start", response, context).data.worker.ref, WORKER_REF);
  assert.throws(() => validateResponse("work.start", {
    ...response,
    data: { ...response.data, workerHandle: HANDLE },
  }, context), /handles must be distinct/i);
  assert.throws(() => validateResponse("work.start", {
    ...response,
    data: { ...response.data, worker: { ...worker, state: "spawn_attempt" } },
  }, context), /before child observation/i);
  assert.throws(() => validateResponse("work.start", {
    ...response,
    data: { ...response.data, budget: { ...budget, chainId: "chain:other" } },
  }, context), /same work bundle/i);
  assert.throws(() => validateResponse("work.start", {
    ...response,
    data: { ...response.data, worker: { ...worker, claimRef: "clm_" + "d".repeat(22) } },
  }, context), /same work bundle/i);
  assert.throws(() => validateResponse("work.start", {
    ...response,
    data: { ...response.data, claim: { ...claim, workerRef: null } },
  }, context), /Claim worker reference/i);

  const inspect = request("work.inspect", { workerRef: WORKER_REF });
  const inspectContext = responseContextForRequest(inspect, { expectedContractDigest: SHA });
  assert.equal(validateResponse("work.inspect", commonResponse({ data: { worker, claim, budget } }), inspectContext).data.claim.ref, CLAIM_REF);
  assert.throws(() => validateResponse("work.inspect", commonResponse({
    data: { worker: { ...worker, ref: "wrk_" + "d".repeat(22) }, claim, budget },
  }), inspectContext), /Claim worker reference|different worker/i);
});

test("versioned mutation responses match the requested object and target", () => {
  const transitionedClaim = {
    ref: CLAIM_REF,
    taskId: "task:1",
    runId: "run:1",
    chainId: "chain:1",
    authorEngine: "codex",
    state: "awaiting_review",
    version: 3,
    workerRef: null,
    recoveryRef: null,
    updatedAtMs: 1,
  };
  const claimTransition = request("claim.transition", {
    claimHandle: HANDLE,
    expectedVersion: 2,
    to: "awaiting_review",
    outcomeCode: "work_ready",
    resultDigest: SHA,
  }, { deadlineMs: 5_000 });
  const claimContext = responseContextForRequest(claimTransition, {
    expectedContractDigest: SHA,
    claimRefForHandle: CLAIM_REF,
  });
  assert.equal(validateResponse("claim.transition", commonResponse({ data: { claim: transitionedClaim } }), claimContext).data.claim.version, 3);
  assert.throws(() => validateResponse("claim.transition", commonResponse({
    data: { claim: { ...transitionedClaim, version: 2 } },
  }), claimContext), /requested claim, version, and state/i);

  const runTransition = request("run.transition", {
    runId: "run:1",
    expectedVersion: 1,
    to: "waiting",
    summary: "Waiting for a dependency.",
    nextActions: [],
    artifacts: [],
  }, { deadlineMs: 5_000 });
  const run = {
    id: "run:1",
    kind: "board_task",
    status: "waiting",
    authority: "worker",
    taskId: "task:1",
    chainId: "chain:1",
    profileId: "board.codex",
    repoId: "repo_0123456789abcdef",
    workMode: "new",
    engines: ["codex"],
    summary: "Waiting for a dependency.",
    createdAtMs: 1,
    startedAtMs: null,
    updatedAtMs: 2,
    finishedAtMs: null,
    nextActions: [],
    artifacts: [],
    version: 2,
  };
  const runContext = responseContextForRequest(runTransition, {
    expectedContractDigest: SHA,
    currentRun: { ...run, status: "queued", summary: "Queued.", updatedAtMs: 1, version: 1 },
  });
  assert.equal(validateResponse("run.transition", commonResponse({ data: { run } }), runContext).data.run.status, "waiting");
  assert.throws(() => validateResponse("run.transition", commonResponse({
    data: { run: { ...run, id: "run:other" } },
  }), runContext), /requested run, version, and target/i);
  assert.throws(() => validateResponse("run.transition", commonResponse({
    data: { run: { ...run, version: 1 } },
  }), runContext), /requested run, version, and target/i);
  assert.throws(() => validateResponse("run.transition", commonResponse({
    data: { run: { ...run, authority: "gate" } },
  }), runContext), /requested run, version, and target/i);
});

test("run transitions require root-resolved authority and protect worker lifecycle states", () => {
  const current = {
    id: "run:authority",
    kind: "board_task",
    status: "queued",
    authority: "worker",
    taskId: "task:authority",
    chainId: "chain:authority",
    profileId: "board.codex",
    repoId: "repo_0123456789abcdef",
    workMode: "new",
    engines: ["codex"],
    summary: "Queued.",
    createdAtMs: 1,
    startedAtMs: null,
    updatedAtMs: 1,
    finishedAtMs: null,
    nextActions: [],
    artifacts: [],
    version: 1,
  };
  const transition = (to) => request("run.transition", {
    runId: current.id,
    expectedVersion: 1,
    to,
    summary: "Transitioned.",
    nextActions: [],
    artifacts: [],
  }, { deadlineMs: 5_000 });
  assert.throws(() => authorize(transition("waiting")), (error) => error.code === "RUN_CONFLICT");
  assert.equal(authorize(transition("waiting"), { currentRun: current }).action, "execute");
  assert.equal(authorize(transition("queued"), {
    currentRun: { ...current, status: "waiting" },
  }).action, "execute");
  assert.throws(() => authorize(transition("completed"), { currentRun: current }), (error) => error.code === "INVALID_TRANSITION");
  assert.throws(() => authorize(transition("completed"), {
    currentRun: { ...current, status: "running", startedAtMs: 1 },
  }), (error) => error.code === "INVALID_TRANSITION");
  assert.throws(() => authorize(transition("waiting"), {
    currentRun: { ...current, startedAtMs: 1 },
  }), (error) => error.code === "INVALID_TRANSITION");
  assert.throws(() => authorize(transition("queued"), {
    currentRun: { ...current, status: "waiting", startedAtMs: 1 },
  }), (error) => error.code === "INVALID_TRANSITION");
  assert.throws(() => authorize(transition("cancelled"), {
    currentRun: { ...current, startedAtMs: 1 },
  }), (error) => error.code === "INVALID_TRANSITION");

  const gateCurrent = { ...current, authority: "gate" };
  assert.equal(authorize(transition("running"), { currentRun: gateCurrent }).action, "execute");
  assert.throws(() => authorize(transition("completed"), { currentRun: gateCurrent }), (error) => error.code === "INVALID_TRANSITION");
  assert.equal(authorize(transition("completed"), {
    currentRun: { ...gateCurrent, status: "running" },
  }).action, "execute");
  assert.equal(authorize(transition("completed"), {
    currentRun: { ...gateCurrent, status: "completed", finishedAtMs: 2 },
  }).action, "execute");
});

test("idempotent run-transition replay precedes stale current-run checks", () => {
  const transition = request("run.transition", {
    runId: "run:replay",
    expectedVersion: 1,
    to: "waiting",
    summary: "Waiting.",
    nextActions: [],
    artifacts: [],
  }, { deadlineMs: 5_000 });
  const committedRun = {
    id: "run:replay",
    kind: "board_task",
    status: "waiting",
    authority: "worker",
    taskId: "task:replay",
    chainId: "chain:replay",
    profileId: "board.codex",
    repoId: "repo_0123456789abcdef",
    workMode: "new",
    engines: ["codex"],
    summary: "Waiting.",
    createdAtMs: 1,
    startedAtMs: null,
    updatedAtMs: 2,
    finishedAtMs: null,
    nextActions: [],
    artifacts: [],
    version: 2,
  };
  const response = commonResponse({ data: { run: committedRun } });
  let lookups = 0;
  const replay = authorize(transition, {
    currentRun: committedRun,
    lookupIdempotency() {
      lookups++;
      return { digest: requestDigest(transition), response };
    },
  });
  assert.equal(lookups, 1);
  assert.equal(replay.action, "replay");
  assert.equal(replay.response.data.run.version, 2);
});

test("run, STOP, and budget mutation responses echo the authorized change", () => {
  const accepted = {
    id: "run:accept",
    kind: "board_task",
    taskId: "task:accept",
    chainId: "chain:accept",
    profileId: "board.codex",
    repoId: "repo_0123456789abcdef",
    workMode: "new",
    engines: ["codex"],
    summary: "Accepted.",
    nextActions: [],
    artifacts: [],
  };
  const acceptRequest = request("run.accept", { run: accepted }, { deadlineMs: 5_000 });
  const acceptContext = responseContextForRequest(acceptRequest, {
    expectedContractDigest: SHA,
    runAuthorityForRequest: "worker",
  });
  const acceptedView = {
    ...accepted,
    status: "queued",
    authority: "worker",
    createdAtMs: 1,
    startedAtMs: null,
    updatedAtMs: 1,
    finishedAtMs: null,
    version: 1,
  };
  assert.equal(validateResponse("run.accept", commonResponse({ data: { run: acceptedView } }), acceptContext).data.run.id, accepted.id);
  assert.throws(() => validateResponse("run.accept", commonResponse({
    data: { run: { ...acceptedView, authority: "gate" } },
  }), acceptContext), /accepted run binding/i);

  const engage = request("stop.engage", {
    expectedStopVersion: 2,
    reasonCode: "integrity_failure",
    summary: "Integrity check failed.",
    operatorProof: null,
  }, { deadlineMs: 5_000 });
  const engageContext = responseContextForRequest(engage, { expectedContractDigest: SHA });
  const stop = { engaged: true, version: 3, reasonCode: "integrity_failure", summary: "Integrity check failed.", changedAtMs: 1 };
  assert.equal(validateResponse("stop.engage", commonResponse({ data: { stop, inFlightWorkers: [] } }), engageContext).data.stop.version, 3);
  assert.throws(() => validateResponse("stop.engage", commonResponse({
    data: { stop: { ...stop, version: 2 }, inFlightWorkers: [] },
  }), engageContext), /requested STOP change/i);

  const policySet = request("budget.policy.set", {
    expectedVersion: 4,
    costLimitEnabled: true,
    costLimitMicros: 2_000_000,
    operatorProof: {
      actionHandle: HANDLE,
      action: "budget_policy_change",
      targetDigest: operatorTargetDigest({ expectedVersion: 4, costLimitEnabled: true, costLimitMicros: 2_000_000 }),
      expiresAtMs: 1_784_690_001_000,
    },
  }, { deadlineMs: 5_000 });
  const policy = {
    version: 5,
    costLimitEnabled: true,
    costLimitMicros: 2_000_000,
    structuralLimits: {
      maxExecs: 1,
      maxLifetimeMs: 1,
      maxTokenUnits: 1,
      maxHandoffs: 1,
      maxConsecutiveSamePair: 1,
      softStopPermille: 900,
    },
  };
  const policyContext = responseContextForRequest(policySet, {
    expectedContractDigest: SHA,
    structuralLimits: policy.structuralLimits,
  });
  assert.equal(validateResponse("budget.policy.set", commonResponse({ data: policy }), policyContext).data.version, 5);
  assert.throws(() => validateResponse("budget.policy.set", commonResponse({
    data: { ...policy, costLimitMicros: 3_000_000 },
  }), policyContext), /requested policy change/i);
  assert.throws(() => validateResponse("budget.policy.set", commonResponse({
    data: { ...policy, structuralLimits: { ...policy.structuralLimits, maxExecs: 2 } },
  }), policyContext), /requested policy change/i);
});

test("stop views cannot contradict whether STOP is engaged", () => {
  assert.throws(() => validateResponse("stop.get", commonResponse({
    data: { stop: { engaged: false, version: 2, reasonCode: "operator_stop", summary: null, changedAtMs: 1 } },
  }), responseContext("stop.get")), /engaged and reasonCode disagree/i);
  assert.throws(() => validateResponse("stop.get", commonResponse({
    data: { stop: { engaged: false, version: 2, reasonCode: null, summary: "Still stopped.", changedAtMs: 1 } },
  }), responseContext("stop.get")), /cannot retain a stop summary/i);
  assert.throws(() => validateResponse("stop.get", commonResponse({
    data: { stop: { engaged: true, version: 2, reasonCode: null, summary: null, changedAtMs: 1 } },
  }), responseContext("stop.get")), /engaged and reasonCode disagree/i);
});

test("output pages are ordered and obey the caller's byte limit", () => {
  const output = commonResponse({
    data: {
      chunks: [{ seq: 1, text: "abc" }, { seq: 2, text: "de" }],
      nextSeq: 2,
      eof: false,
      truncated: false,
    },
  });
  assert.equal(validateResponse("work.output.read", output, responseContext("work.output.read", { afterSeq: 0, limitBytes: 5 })).data.nextSeq, 2);
  assert.throws(() => validateResponse("work.output.read", output, responseContext("work.output.read", { afterSeq: 0, limitBytes: 4 })), /byte limit/i);
  assert.throws(() => validateResponse("work.output.read", {
    ...output,
    data: { ...output.data, chunks: [{ seq: 2, text: "a" }, { seq: 2, text: "b" }] },
  }, responseContext("work.output.read", { afterSeq: 0, limitBytes: 5 })), /strictly increase/i);
  assert.throws(() => validateResponse("work.output.read", {
    ...output,
    data: { ...output.data, chunks: [], nextSeq: 0 },
  }, responseContext("work.output.read", { afterSeq: 100, limitBytes: 5 })), /requested or final chunk cursor/i);
  assert.throws(() => validateResponse("work.output.read", {
    ...output,
    data: { ...output.data, chunks: [], nextSeq: 101 },
  }, responseContext("work.output.read", { afterSeq: 100, limitBytes: 5 })), /requested or final chunk cursor/i);
  assert.throws(() => validateResponse("work.output.read", {
    ...output,
    data: { ...output.data, chunks: [{ seq: 101, text: "x" }], nextSeq: 1_000 },
  }, responseContext("work.output.read", { afterSeq: 100, limitBytes: 5 })), /requested or final chunk cursor/i);
  assert.throws(() => validateResponse("work.output.read", output, responseContext("work.output.read")), /original cursor and byte limit context/i);
});

test("every legal gate run target has an honest gate event", () => {
  const context = responseContextForRequest(request("run.events", { afterSeq: 0, limit: 200 }), {
    expectedContractDigest: SHA,
  });
  const gateTargets = {
    gate_queued: "queued",
    gate_running: "running",
    gate_waiting: "waiting",
    gate_gated: "gated",
    gate_completed: "completed",
    gate_failed: "failed",
    gate_cancelled: "cancelled",
    gate_interrupted: "interrupted",
    gate_skipped: "skipped",
  };
  let seq = 1;
  for (const [eventCode, status] of Object.entries(gateTargets)) {
    const event = {
      seq: seq++,
      runId: "run:gate",
      eventCode,
      source: "gate",
      atMs: 1,
      status,
      kind: "board_task",
      engine: "codex",
      engines: ["codex"],
      summary: "Transitioned.",
      nextActions: [],
      artifacts: [],
      runVersion: 1,
    };
    assert.equal(validateResponse("run.events", commonResponse({
      data: { ledgerGeneration: 1, events: [event], nextCursor: null, hasMore: false, truncated: false },
    }), context).data.events[0].status, status);
  }
});

test("run and audit pages obey the requested cursor, limit, view, and filters", () => {
  const listRequest = request("run.list", { view: "active", limit: 1, cursor: null });
  const listContext = responseContextForRequest(listRequest, { expectedContractDigest: SHA });
  const run = {
    id: "run:page",
    kind: "board_task",
    status: "queued",
    authority: "worker",
    taskId: "task:page",
    chainId: "chain:page",
    profileId: "board.codex",
    repoId: "repo_0123456789abcdef",
    workMode: "new",
    engines: ["codex"],
    summary: "Queued.",
    createdAtMs: 1,
    startedAtMs: null,
    updatedAtMs: 1,
    finishedAtMs: null,
    nextActions: [],
    artifacts: [],
    version: 1,
  };
  const runPage = commonResponse({ data: { runs: [run], nextCursor: null, hasMore: false, truncated: false } });
  assert.equal(validateResponse("run.list", runPage, listContext).data.runs.length, 1);
  assert.throws(() => validateResponse("run.list", {
    ...runPage,
    data: { ...runPage.data, runs: [run, { ...run, id: "run:second" }] },
  }, listContext), /page limit/i);
  assert.throws(() => validateResponse("run.list", {
    ...runPage,
    data: { ...runPage.data, runs: [{ ...run, status: "completed", finishedAtMs: 2 }] },
  }, listContext), /active view/i);
  assert.throws(() => validateResponse("run.list", {
    ...runPage,
    data: { ...runPage.data, hasMore: true },
  }, listContext), /hasMore and nextCursor disagree/i);

  const continuedListContext = responseContextForRequest(request("run.list", {
    view: "active", limit: 1, cursor: HANDLE,
  }), { expectedContractDigest: SHA });
  assert.throws(() => validateResponse("run.list", {
    ...runPage,
    data: { ...runPage.data, nextCursor: HANDLE, hasMore: true },
  }, continuedListContext), /cursor did not advance/i);

  const eventsRequest = request("run.events", { afterSeq: 100, limit: 1 });
  const eventsContext = responseContextForRequest(eventsRequest, { expectedContractDigest: SHA });
  const runEvent = {
    seq: 101,
    runId: "run:page",
    eventCode: "service_running",
    source: "service",
    atMs: 1,
    status: "running",
    kind: "board_task",
    engine: "codex",
    engines: ["codex"],
    summary: "Running.",
    nextActions: [],
    artifacts: [],
    runVersion: 2,
  };
  const eventPage = commonResponse({
    data: { ledgerGeneration: 1, events: [runEvent], nextCursor: null, hasMore: false, truncated: false },
  });
  assert.equal(validateResponse("run.events", eventPage, eventsContext).data.events[0].seq, 101);
  assert.throws(() => validateResponse("run.events", {
    ...eventPage,
    data: { ...eventPage.data, events: [runEvent, { ...runEvent, seq: 102 }] },
  }, eventsContext), /page limit/i);
  assert.throws(() => validateResponse("run.events", {
    ...eventPage,
    data: { ...eventPage.data, events: [{ ...runEvent, seq: 100 }] },
  }, eventsContext), /increase beyond afterSeq/i);
  assert.throws(() => validateResponse("run.events", {
    ...eventPage,
    data: { ...eventPage.data, events: [{ ...runEvent, eventCode: "service_completed" }] },
  }, eventsContext), /eventCode and status disagree/i);

  const auditRequest = request("audit.read", {
    afterSeq: 100,
    limit: 1,
    source: "service",
    severity: "error",
    runId: null,
    taskId: null,
  });
  const auditContext = responseContextForRequest(auditRequest, { expectedContractDigest: SHA });
  const auditEvent = {
    seq: 101,
    eventCode: "store_degraded",
    source: "service",
    severity: "error",
    atMs: 1,
    runId: null,
    taskId: null,
    engine: null,
    detail: { store: "claims", reasonCode: "corrupt" },
  };
  const auditPage = commonResponse({ data: { events: [auditEvent], nextCursor: null, hasMore: false, truncated: false } });
  assert.equal(validateResponse("audit.read", auditPage, auditContext).data.events[0].source, "service");
  assert.throws(() => validateResponse("audit.read", {
    ...auditPage,
    data: { ...auditPage.data, events: [auditEvent, { ...auditEvent, seq: 102 }] },
  }, auditContext), /page limit/i);
  assert.throws(() => validateResponse("audit.read", {
    ...auditPage,
    data: {
      ...auditPage.data,
      events: [{
        ...auditEvent,
        eventCode: "client_disconnected",
        source: "gate",
        severity: "info",
        detail: { surface: "chat" },
      }],
    },
  }, auditContext), /source filter/i);
});

test("validated messages are immutable snapshots", () => {
  const original = request("stop.get");
  const validated = authorize(original).request;
  original.params.surprise = true;
  assert.deepEqual(validated.params, {});
  assert.equal(Object.isFrozen(validated), true);
  assert.equal(Object.isFrozen(validated.params), true);
  assert.throws(() => { validated.params.surprise = true; }, TypeError);
});

test("frame encoder uses a four-byte big-endian length and strict payload", () => {
  const frame = encodeFrame(request("stop.get"));
  assert.equal(frame.readUInt32BE(0), frame.length - 4);
  assert.deepEqual(parseStrictJson(frame.subarray(4)), request("stop.get"));
});

test("frame decoder accepts chunks but rejects slow, truncated, oversized, and in-flight extra frames", () => {
  let nowMs = 1_000;
  const framed = decoder({ now: () => nowMs });
  const frame = encodeFrame(request("stop.get"));
  assert.equal(framed.push(frame.subarray(0, 3)), null);
  assert.equal(framed.push(frame.subarray(3, 8)), null);
  assert.deepEqual(framed.push(frame.subarray(8)), request("stop.get"));
  framed.responseWritten();
  assert.deepEqual(framed.push(frame), request("stop.get"));
  assert.throws(() => framed.push(frame), (error) => error.code === "INFLIGHT_VIOLATION");

  const slow = decoder({ now: () => nowMs });
  slow.push(frame.subarray(0, 2));
  nowMs += 2_001;
  assert.throws(() => slow.checkDeadline(), (error) => error.code === "DEADLINE_EXCEEDED");

  const truncated = decoder();
  truncated.push(frame.subarray(0, 7));
  assert.throws(() => truncated.end(), (error) => error.code === "TRUNCATED_FRAME");

  const tooLarge = Buffer.alloc(4);
  tooLarge.writeUInt32BE(REQUEST_MAX_BYTES + 1);
  assert.throws(() => decoder().push(tooLarge), (error) => error.code === "FRAME_TOO_LARGE");

  const jumbo = decoder();
  assert.throws(() => jumbo.push(Buffer.alloc(REQUEST_MAX_BYTES + 5)), (error) => error.code === "FRAME_TOO_LARGE");
  assert.equal(jumbo.buffer.length, 0);

  const oversizedTail = decoder();
  const shortHeader = Buffer.alloc(4);
  shortHeader.writeUInt32BE(8);
  assert.equal(oversizedTail.push(shortHeader), null);
  assert.throws(() => oversizedTail.push(Buffer.alloc(REQUEST_MAX_BYTES + 1)), (error) => error.code === "FRAME_TOO_LARGE");
  assert.equal(oversizedTail.buffer.length, 4);

  const extra = decoder();
  assert.throws(() => extra.push(Buffer.concat([frame, frame])), (error) => error.code === "INFLIGHT_VIOLATION");

  let closeError = null;
  let scheduled = null;
  const silent = decoder({
    onDeadline(error) { closeError = error; },
    schedule(callback) { scheduled = callback; return 1; },
    cancelSchedule() {},
  });
  assert.equal(typeof scheduled, "function");
  scheduled();
  assert.equal(closeError.code, "DEADLINE_EXCEEDED");
  assert.throws(() => silent.push(frame), (error) => error.code === "PROTOCOL_ERROR");

  let lateNow = 5_000;
  const late = decoder({ now: () => lateNow });
  lateNow += 2_000;
  assert.throws(() => late.push(frame), (error) => error.code === "DEADLINE_EXCEEDED");
});

test("connection-bound handles cannot be stolen, adopted, or used after revoke", () => {
  const registry = createHandleRegistry({ randomBytes: () => Buffer.alloc(24, 7) });
  const handle = registry.issue({ connectionId: "conn-a", epoch: GW, kind: "claim", value: { ref: "clm_1" } });
  assert.deepEqual(registry.resolve(handle, { connectionId: "conn-a", epoch: GW, kind: "claim" }), { ref: "clm_1" });
  assert.throws(() => registry.resolve(handle, { connectionId: "conn-b", epoch: GW, kind: "claim" }), (error) => error.code === "STALE_HANDLE");
  assert.throws(() => registry.resolve(handle, { connectionId: "conn-a", epoch: "gw_" + "f".repeat(32), kind: "claim" }), (error) => error.code === "STALE_HANDLE");
  assert.deepEqual(registry.consume(handle, { connectionId: "conn-a", epoch: GW, kind: "claim" }), { ref: "clm_1" });
  assert.throws(() => registry.consume(handle, { connectionId: "conn-a", epoch: GW, kind: "claim" }), (error) => error.code === "STALE_HANDLE");
  const second = registry.issue({ connectionId: "conn-a", epoch: GW, kind: "claim", value: { ref: "clm_2" } });
  registry.revokeConnection("conn-a");
  assert.throws(() => registry.resolve(second, { connectionId: "conn-a", epoch: GW, kind: "claim" }), (error) => error.code === "STALE_HANDLE");
});
