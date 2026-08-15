// Phase 1f increment 5.2b: the §6 method-dispatch composition root, exercised
// against the REAL protocol validator (validateRequest -> auth gate ->
// operator-proof consumption -> validateResponse). We do not fake the contract
// edge; handlers are fakes, the routing/gating/idempotency layer is real.

import { test } from "node:test";
import assert from "node:assert/strict";
import protocol from "../container/maintenance-protocol.js";
import dispatchMod from "../container/maintenance-method-dispatch.js";
import operatorGatewayMod from "../container/maintenance-operator-gateway.js";
import stopStoreMod from "../container/maintenance-stop-store.js";

const { METHOD_TABLE, authClassForRequest, createSessionAuthorizer, createMethodDispatcher } = dispatchMod;
const { createOperatorProofRegistry, createOperatorGateway } = operatorGatewayMod;
const { createStopStore } = stopStoreMod;

const EPOCH = "gw_" + "a".repeat(32);
const REQ = (h) => "req_" + String(h).repeat(32).slice(0, 32);
const SESS = "sha256:" + "c".repeat(64);
const CONTRACT = "sha256:" + "0".repeat(64);
const CONN = "conn-1";

const pass = () => {};
function mem(records = []) { return { records, append: (r) => records.push(JSON.parse(JSON.stringify(r))), readAll: () => records.slice() }; }

const STOP_VIEW = Object.freeze({ engaged: false, version: 4, reasonCode: null, summary: null, changedAtMs: 1_000 });

// A handler set covering exactly the §6 table: every method defaults to an
// unreachable throw, overridden per test.
function makeHandlers(overrides = {}) {
  const handlers = {};
  for (const method of Object.keys(METHOD_TABLE)) {
    handlers[method] = overrides[method] || (() => { throw new Error(`unexpected dispatch to ${method}`); });
  }
  return handlers;
}

function setup({ state = "ready", storesHealthy = true, globalQuarantine = false, handlers = {}, registry } = {}) {
  const s = {
    clockMs: 1_000_000,
    state,
    storesHealthy,
    globalQuarantine,
    idempotency: new Map(), // `${epoch}\n${requestId}` -> { digest, response }
    recorded: [],
    registry: registry || createOperatorProofRegistry(),
    handlerCalls: [],
  };
  s.dispatcher = createMethodDispatcher({
    handlers: makeHandlers(handlers),
    session: {
      state: () => s.state,
      storesHealthy: () => s.storesHealthy,
      globalQuarantine: () => s.globalQuarantine,
    },
    recordIdempotency: (epoch, requestId, record) => {
      if (s.failIdempotencyWrite) throw new Error("disk full");
      s.recorded.push({ epoch, requestId });
      s.idempotency.set(`${epoch}\n${requestId}`, record);
    },
    now: () => s.clockMs,
  });
  s.context = () => ({
    gatewayEpoch: EPOCH,
    expectedContractDigest: CONTRACT,
    lookupIdempotency: (epoch, requestId) => s.idempotency.get(`${epoch}\n${requestId}`) || null,
    operatorProofRegistry: s.registry,
    connectionId: CONN,
    operatorSessionDigest: SESS,
    nowMs: s.clockMs,
  });
  return s;
}

const req = (method, params, { requestId = REQ("b"), gatewayEpoch = EPOCH, deadlineMs = 2_000 } = {}) =>
  ({ v: 1, gatewayEpoch, requestId, deadlineMs, method, params });

// ---- table exactness ---------------------------------------------------------

test("METHOD_TABLE covers exactly the protocol's method set with valid §5/§6 rows", async () => {
  assert.deepEqual(Object.keys(METHOD_TABLE).sort(), Object.keys(protocol.METHOD_DEADLINES).sort());
  for (const row of Object.values(METHOD_TABLE)) {
    assert.ok(["P", "C", "R", "O"].includes(row.auth));
    assert.ok(["M", "Q"].includes(row.retry));
  }
  assert.ok(Object.isFrozen(METHOD_TABLE));
});

test("stop.engage is C-class except operator_stop, which escalates to O", async () => {
  assert.equal(authClassForRequest({ method: "stop.engage", params: { reasonCode: "shutdown" } }), "C");
  assert.equal(authClassForRequest({ method: "stop.engage", params: { reasonCode: "operator_stop" } }), "O");
  assert.equal(authClassForRequest({ method: "work.cancel", params: {} }), "O");
  assert.equal(authClassForRequest({ method: "stop.get", params: {} }), "C");
});

// ---- construction fail-closed --------------------------------------------------

test("construction requires exactly one handler per method, a session view, a recorder, and a clock", async () => {
  const session = { state: () => "ready", storesHealthy: () => true, globalQuarantine: () => false };
  const full = makeHandlers();
  const missing = makeHandlers(); delete missing["stop.get"];
  const extra = makeHandlers(); extra["exec.shell"] = () => {};
  assert.throws(() => createMethodDispatcher({ handlers: missing, session, recordIdempotency: pass, now: () => 1 }), /one handler function per/);
  assert.throws(() => createMethodDispatcher({ handlers: extra, session, recordIdempotency: pass, now: () => 1 }), /one handler function per/);
  assert.throws(() => createMethodDispatcher({ handlers: full, session: {}, recordIdempotency: pass, now: () => 1 }), /session/);
  assert.throws(() => createMethodDispatcher({ handlers: full, session, now: () => 1 }), /recordIdempotency/);
  assert.throws(() => createMethodDispatcher({ handlers: full, session, recordIdempotency: pass }), /now/);
});

// ---- §2.1 connection sequence ---------------------------------------------------

test("first-request law: a C-class call in pre_session closes the connection", async () => {
  const s = setup({ state: "pre_session" });
  const out = await s.dispatcher.dispatch(req("stop.get", {}), s.context());
  assert.equal(out.action, "close");
  assert.equal(out.code, "PROTOCOL_ERROR");
});

test("session.open is refused once the session is established (close, not reply)", async () => {
  const s = setup({ state: "connected" });
  const out = await s.dispatcher.dispatch(
    { v: 1, gatewayEpoch: null, requestId: REQ("b"), deadlineMs: 2_000, method: "session.open", params: { protocolVersion: 1, contractDigest: CONTRACT } },
    s.context(),
  );
  assert.equal(out.action, "close");
  assert.equal(out.code, "PROTOCOL_ERROR");
});

test("an unknown method closes the connection", async () => {
  const s = setup();
  const out = await s.dispatcher.dispatch(req("exec.shell", {}), s.context());
  assert.equal(out.action, "close");
  assert.equal(out.code, "UNKNOWN_METHOD");
});

// ---- §5 R-class gating -----------------------------------------------------------

test("R-class before READY is NOT_RECONCILED; the handler is never invoked", async () => {
  const s = setup({ state: "connected" });
  const out = await s.dispatcher.dispatch(
    req("audit.append", { eventCode: "client_disconnected", severity: "info", runId: null, taskId: null, engine: null, detail: { surface: "chat" } }, { deadlineMs: 5_000 }),
    s.context(),
  );
  assert.equal(out.action, "reply");
  assert.equal(out.response.ok, false);
  assert.equal(out.response.code, "NOT_RECONCILED");
});

test("R-class while draining / stores unhealthy / quarantined maps to the exact deny code", async () => {
  const cases = [
    [{ state: "draining" }, "ALREADY_DRAINING"],
    [{ storesHealthy: false }, "STORE_UNAVAILABLE"],
    [{ globalQuarantine: true }, "GLOBAL_QUARANTINE"],
  ];
  for (const [overrides, code] of cases) {
    const s = setup(overrides);
    const out = await s.dispatcher.dispatch(
      req("audit.append", { eventCode: "client_disconnected", severity: "info", runId: null, taskId: null, engine: null, detail: { surface: "chat" } }, { deadlineMs: 5_000 }),
      s.context(),
    );
    assert.equal(out.action, "reply", code);
    assert.equal(out.response.code, code);
  }
});

test("C-class reads still work while draining", async () => {
  const s = setup({ state: "draining", handlers: { "stop.get": () => ({ data: { stop: STOP_VIEW } }) } });
  const out = await s.dispatcher.dispatch(req("stop.get", {}), s.context());
  assert.equal(out.action, "reply");
  assert.equal(out.response.ok, true);
  assert.equal(out.response.data.stop.version, 4);
});

test("an unknown session state fails closed (close)", async () => {
  const s = setup({ state: "rebooting?" });
  const out = await s.dispatcher.dispatch(req("stop.get", {}), s.context());
  assert.equal(out.action, "close");
  assert.equal(out.code, "PROTOCOL_ERROR");
});

// ---- MONEY TEST: auth gate runs before proof consumption --------------------------

test("an O-class request denied by the session gate does NOT burn its one-use proof", async () => {
  const registry = createOperatorProofRegistry();
  const gateway = createOperatorGateway({ registry, now: () => 1_000_000 });
  const stopStore = createStopStore({ log: mem(), validateStopView: pass });
  const engaged = stopStore.engage({ expectedVersion: stopStore.get().version, reasonCode: "operator_stop", summary: "op" });

  const targetDigest = protocol.operatorTargetDigest({ expectedStopVersion: engaged.version });
  const { operatorProof } = gateway.beginOperatorAction({
    connectionId: CONN, gatewayEpoch: EPOCH, action: "stop_resume", operatorSessionDigest: SESS, targetDigest,
  });
  assert.equal(registry.size(), 1);

  const s = setup({
    state: "connected", // not READY yet
    registry,
    handlers: { "stop.resume": (request) => ({ data: { stop: stopStore.resume({ expectedVersion: request.params.expectedStopVersion }) } }) },
  });
  const resume = async () => await s.dispatcher.dispatch(
    req("stop.resume", { expectedStopVersion: engaged.version, operatorProof }, { deadlineMs: 5_000 }),
    s.context(),
  );

  const denied = await resume();
  assert.equal(denied.action, "reply");
  assert.equal(denied.response.code, "NOT_RECONCILED");
  assert.equal(registry.size(), 1, "the denial consumed NO proof");
  assert.equal(stopStore.get().engaged, true, "the denial performed NO mutation");

  // The session becomes READY: the SAME proof now authorizes the resume.
  s.state = "ready";
  const ok = await resume();
  assert.equal(ok.action, "reply");
  assert.equal(ok.response.ok, true, JSON.stringify(ok.response));
  assert.equal(ok.response.data.stop.engaged, false);
  assert.equal(registry.size(), 0, "the successful resume consumed the proof");
});

test("stop.engage operator_stop is O-gated; a service-reason engage stays C-class", async () => {
  const stopStore = createStopStore({ log: mem(), validateStopView: pass });
  const s = setup({
    state: "connected", // not READY: O denied, C allowed
    handlers: {
      "stop.engage": (request) => {
        const view = stopStore.engage({ expectedVersion: request.params.expectedStopVersion, reasonCode: request.params.reasonCode, summary: request.params.summary });
        return { data: { stop: view, inFlightWorkers: [] } };
      },
    },
  });
  const engage = async (reasonCode, requestId, operatorProof = null) => await s.dispatcher.dispatch(
    req("stop.engage", { expectedStopVersion: stopStore.get().version, reasonCode, summary: "x", operatorProof }, { deadlineMs: 5_000, requestId }),
    s.context(),
  );
  // A syntactically valid proof (operator_stop requires one at the schema edge);
  // the gate must deny BEFORE any consumption is attempted.
  const proof = {
    actionHandle: "op_" + "a".repeat(32),
    action: "stop_engage",
    targetDigest: protocol.operatorTargetDigest({ expectedStopVersion: stopStore.get().version, reasonCode: "operator_stop", summary: "x" }),
    expiresAtMs: 1_020_000,
  };
  const denied = await engage("operator_stop", REQ("1"), proof);
  assert.equal(denied.response.code, "NOT_RECONCILED", "operator stop needs READY (O-class)");
  const allowed = await engage("shutdown", REQ("2"));
  assert.equal(allowed.response.ok, true, "service shutdown stop is C-class and allowed degraded");
  assert.equal(stopStore.get().engaged, true);
});

// ---- dispatch + response validation ------------------------------------------------

test("a Q-class success round-trips a validated envelope and records no idempotency", async () => {
  const s = setup({ handlers: { "stop.get": () => ({ data: { stop: STOP_VIEW }, summary: "Stop state read." }) } });
  const out = await s.dispatcher.dispatch(req("stop.get", {}), s.context());
  assert.equal(out.action, "reply");
  assert.equal(out.response.status, "success");
  assert.equal(out.response.code, "OK");
  assert.equal(out.response.summary, "Stop state read.");
  assert.equal(out.response.retry.safe, true);
  assert.equal(out.response.serverTimeMs, 1_000_000);
  assert.equal(s.recorded.length, 0, "reads are never idempotency-recorded");
});

test("an off-contract handler result never claims success", async () => {
  const s = setup({ handlers: { "stop.get": () => ({ data: { stop: { bogus: true } } }) } });
  const out = await s.dispatcher.dispatch(req("stop.get", {}), s.context());
  assert.equal(out.action, "reply");
  assert.equal(out.response.ok, false);
  assert.equal(out.response.code, "INTERNAL_RESPONSE_INVALID");
});

test("an uncoded handler fault is masked with fixed text (no internals leak)", async () => {
  const s = setup({ handlers: { "stop.get": () => { throw new Error("ENOENT /data/secret/path leaked"); } } });
  const out = await s.dispatcher.dispatch(req("stop.get", {}), s.context());
  assert.equal(out.response.code, "INTERNAL_RESPONSE_INVALID");
  assert.ok(!JSON.stringify(out.response).includes("/data/secret"), "internal fault text never reaches the wire");
});

test("a coded store error keeps its code as an addressed error reply", async () => {
  const stopStore = createStopStore({ log: mem(), validateStopView: pass });
  const s = setup({
    handlers: { "stop.engage": (request) => ({ data: { stop: stopStore.engage({ expectedVersion: 99, reasonCode: request.params.reasonCode, summary: "x" }), inFlightWorkers: [] } }) },
  });
  const out = await s.dispatcher.dispatch(
    req("stop.engage", { expectedStopVersion: 99, reasonCode: "shutdown", summary: "x", operatorProof: null }, { deadlineMs: 5_000 }),
    s.context(),
  );
  assert.equal(out.action, "reply");
  assert.equal(out.response.ok, false);
  assert.equal(out.response.code, "STALE_VERSION");
});

// ---- §3 retry law through the dispatcher ---------------------------------------------

test("M-class success is recorded BEFORE the reply and replays byte-identically", async () => {
  let calls = 0;
  const s = setup({
    handlers: { "session.drain": () => { calls += 1; return { data: { state: "draining" } }; } },
  });
  const drain = async () => await s.dispatcher.dispatch(req("session.drain", { reasonCode: "restart" }, { deadlineMs: 5_000 }), s.context());
  const first = await drain();
  assert.equal(first.response.ok, true);
  assert.deepEqual(s.recorded, [{ epoch: EPOCH, requestId: REQ("b") }]);
  const second = await drain();
  assert.equal(second.action, "reply");
  assert.deepEqual(second.response, first.response, "same ID + same body replays the committed response");
  assert.equal(calls, 1, "the handler ran exactly once");
});

test("a committed reply still returns when the session has since degraded (replay precedes the gate)", async () => {
  let calls = 0;
  const s = setup({
    handlers: {
      "audit.append": () => {
        calls += 1;
        return { data: { event: { seq: 7, source: "gate", eventCode: "client_disconnected", severity: "info", runId: null, taskId: null, engine: null, detail: { surface: "chat" }, atMs: 999 } } };
      },
    },
  });
  const append = async () => await s.dispatcher.dispatch(
    req("audit.append", { eventCode: "client_disconnected", severity: "info", runId: null, taskId: null, engine: null, detail: { surface: "chat" } }, { deadlineMs: 5_000 }),
    s.context(),
  );
  assert.equal((await append()).response.ok, true);
  s.storesHealthy = false; // session degrades AFTER the commit
  const replayed = await append();
  assert.equal(replayed.response.ok, true, "reply-lost recovery returns the committed result");
  assert.equal(calls, 1, "no re-execution under a degraded session");
});

test("same requestId with a different body is IDEMPOTENCY_CONFLICT; the handler never runs", async () => {
  let calls = 0;
  const s = setup({ handlers: { "session.drain": () => { calls += 1; return { data: { state: "draining" } }; } } });
  await s.dispatcher.dispatch(req("session.drain", { reasonCode: "restart" }, { deadlineMs: 5_000 }), s.context());
  const out = await s.dispatcher.dispatch(req("session.drain", { reasonCode: "shutdown" }, { deadlineMs: 5_000 }), s.context());
  assert.equal(out.action, "reply");
  assert.equal(out.response.code, "IDEMPOTENCY_CONFLICT");
  assert.equal(out.response.retry.safe, false);
  assert.equal(calls, 1);
});

test("a failed idempotency write returns STORE_UNAVAILABLE — success is never claimed", async () => {
  const s = setup({ handlers: { "session.drain": () => ({ data: { state: "draining" } }) } });
  s.failIdempotencyWrite = true;
  const out = await s.dispatcher.dispatch(req("session.drain", { reasonCode: "restart" }, { deadlineMs: 5_000 }), s.context());
  assert.equal(out.action, "reply");
  assert.equal(out.response.ok, false);
  assert.equal(out.response.code, "STORE_UNAVAILABLE");
});

// ---- session.open through the dispatcher ----------------------------------------------

test("session.open dispatches in pre_session and replies under the fresh epoch", async () => {
  const s = setup({
    state: "pre_session",
    handlers: {
      "session.open": () => ({
        data: {
          serviceEpoch: "svc_" + "9".repeat(32),
          gatewayEpoch: EPOCH,
          protocolVersion: 1,
          contractDigest: CONTRACT,
          state: "connected_not_ready",
          limits: { ...protocol.LIMITS_VIEW },
        },
      }),
    },
  });
  const out = await s.dispatcher.dispatch(
    { v: 1, gatewayEpoch: null, requestId: REQ("b"), deadlineMs: 2_000, method: "session.open", params: { protocolVersion: 1, contractDigest: CONTRACT } },
    s.context(),
  );
  assert.equal(out.action, "reply", JSON.stringify(out));
  assert.equal(out.response.ok, true);
  assert.equal(out.response.gatewayEpoch, EPOCH, "the envelope carries the fresh epoch the handler minted");
  assert.equal(s.recorded.length, 1, "session.open is M-class and recorded");
});

test("a session.open failure closes the connection instead of replying", async () => {
  const s = setup({ state: "pre_session", handlers: { "session.open": () => ({ data: { wrong: true } }) } });
  const out = await s.dispatcher.dispatch(
    { v: 1, gatewayEpoch: null, requestId: REQ("b"), deadlineMs: 2_000, method: "session.open", params: { protocolVersion: 1, contractDigest: CONTRACT } },
    s.context(),
  );
  assert.equal(out.action, "close");
  assert.equal(out.code, "INTERNAL_RESPONSE_INVALID");
});

// ---- authorizer standalone fail-closed construction --------------------------------------

test("createSessionAuthorizer requires the full live session view", async () => {
  assert.throws(() => createSessionAuthorizer({}), /session/);
  assert.throws(() => createSessionAuthorizer({ session: { state: () => "ready" } }), /session/);
});
