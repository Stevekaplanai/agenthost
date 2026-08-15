// Phase 1f Step 4a (piece 1): the operator-authority composition, proven END TO
// END through the REAL protocol edge and REAL trusted stores. For each of the
// four O-class methods we drive the full activation shape:
//   begin -> mint one-use target-bound proof
//   -> protocol.validateRequest CONSUMES the proof (as PID 1 will)
//   -> the composed handler runs its fixed effect against the real store
//   -> protocol.validateResponse accepts the resulting view.
// This is the security heart of the cutover and one of the three activation
// health-check items ("an operator action round-trips through the gateway;
// STOP engages/resumes").

import { test } from "node:test";
import assert from "node:assert/strict";
import protocol from "../container/maintenance-protocol.js";
import authorityMod from "../container/maintenance-operator-authority.js";
import stopStoreMod from "../container/maintenance-stop-store.js";
import budgetStoreMod from "../container/maintenance-budget-store.js";

const { createOperatorAuthority } = authorityMod;
const { createStopStore } = stopStoreMod;
const { createBudgetStore } = budgetStoreMod;

const EPOCH = "gw_" + "a".repeat(32);
const SESS = "sha256:" + "c".repeat(64);
const CONN = "conn-1";
const CLOCK = 1_000_000;
const REQ = (h) => "req_" + String(h).repeat(32).slice(0, 32);
const WREF = "wrk_" + "a".repeat(24);
const WHANDLE = "wch_" + "b".repeat(24);
const CREF = "clm_" + "c".repeat(24);

const pass = () => {};
const mem = (records = []) => ({ records, append: (r) => records.push(JSON.parse(JSON.stringify(r))), readAll: () => records.slice() });
const POLICY = { policyVersion: 1, costLimitEnabled: true, costLimitMicros: 10_000_000 };
const LIMITS = { maxExecs: 5, maxLifetimeMs: 3_600_000, maxTokenUnits: 1_000_000, maxHandoffs: 8, maxConsecutiveSamePair: 2, softStopPermille: 800 };

// A fake worker teardown for worker_cancel: returns a stopping-or-later WorkerView.
function fakeCancelWorker(target) {
  return {
    ref: target.workerRef, claimRef: CREF, state: "stopping", version: target.expectedWorkerVersion + 1,
    exitCode: null, signalName: null, outputNextSeq: 0, outputEof: false, startedAtMs: CLOCK, finishedAtMs: null,
  };
}

function setup() {
  const audits = [];
  const stopStore = createStopStore({ log: mem(), validateStopView: pass });
  const budgetStore = createBudgetStore({ log: mem(), policy: { ...POLICY }, structuralLimits: LIMITS });
  const authority = createOperatorAuthority({
    stopStore, budgetStore, cancelWorker: fakeCancelWorker, now: () => CLOCK,
    audit: (eventCode, detail) => audits.push({ eventCode, detail }),
  });
  return { audits, stopStore, budgetStore, authority };
}

const baseCtx = (authority, extra = {}) => ({
  gatewayEpoch: EPOCH,
  lookupIdempotency: () => null,
  nowMs: CLOCK,
  operatorProofRegistry: authority.registry,
  connectionId: CONN,
  operatorSessionDigest: SESS,
  ...extra,
});

// Mint a proof for `action`/`target`, then run the consuming request through the
// REAL protocol validator (which consumes the proof). Returns the decision + ctx.
function mintAndValidate(authority, { action, target, method, params, ctxExtra = {}, requestId = REQ("b") }) {
  const { operatorProof } = authority.beginOperatorAction({
    connectionId: CONN, gatewayEpoch: EPOCH, action, operatorSessionDigest: SESS,
    targetDigest: protocol.operatorTargetDigest(target),
  });
  const request = { v: 1, gatewayEpoch: EPOCH, requestId, deadlineMs: 5_000, method, params: { ...params, operatorProof } };
  const ctx = baseCtx(authority, ctxExtra);
  const decision = protocol.validateRequest(request, ctx);
  return { operatorProof, request, ctx, decision };
}

function assertResponseValid(method, data, request, ctx) {
  const response = {
    v: 1, gatewayEpoch: EPOCH, requestId: request.requestId, ok: true, status: "success", code: "OK",
    summary: "ok.", rootCause: null, retry: { safe: false, afterMs: null }, stopCondition: null,
    nextActions: [], artifacts: [], data, serverTimeMs: CLOCK,
  };
  return protocol.validateResponse(method, response, protocol.responseContextForRequest(request, ctx));
}

test("construction fails closed without each dependency", () => {
  const stopStore = createStopStore({ log: mem(), validateStopView: pass });
  const budgetStore = createBudgetStore({ log: mem(), policy: { ...POLICY }, structuralLimits: LIMITS });
  assert.throws(() => createOperatorAuthority({ budgetStore, cancelWorker: pass, now: () => 1 }), /stop store/);
  assert.throws(() => createOperatorAuthority({ stopStore, cancelWorker: pass, now: () => 1 }), /budget store/);
  assert.throws(() => createOperatorAuthority({ stopStore, budgetStore, now: () => 1 }), /cancelWorker/);
  assert.throws(() => createOperatorAuthority({ stopStore, budgetStore, cancelWorker: pass }), /now/);
});

test("stop.resume round-trips: proof minted, consumed once, real STOP store resumed", () => {
  const { authority, stopStore } = setup();
  assert.equal(stopStore.get().engaged, true, "boots STOPPED (first_secure)");
  const v0 = stopStore.get().version;

  const { request, ctx, decision } = mintAndValidate(authority, {
    action: "stop_resume", target: { expectedStopVersion: v0 },
    method: "stop.resume", params: { expectedStopVersion: v0 },
  });
  assert.equal(decision.action, "execute");
  assert.equal(authority.registry.size(), 0, "the one-use proof was consumed by validateRequest");

  const stop = authority.stopResume({ expectedStopVersion: v0 });
  assert.equal(stop.engaged, false);
  assert.ok(stop.version > v0);
  const validated = assertResponseValid("stop.resume", { stop }, request, ctx);
  assert.equal(validated.data.stop.engaged, false);
});

test("replaying a consumed stop.resume proof fails closed", () => {
  const { authority, stopStore } = setup();
  const v0 = stopStore.get().version;
  const { operatorProof } = mintAndValidate(authority, {
    action: "stop_resume", target: { expectedStopVersion: v0 },
    method: "stop.resume", params: { expectedStopVersion: v0 },
  });
  const replay = { v: 1, gatewayEpoch: EPOCH, requestId: REQ("f"), deadlineMs: 5_000, method: "stop.resume", params: { expectedStopVersion: v0, operatorProof } };
  assert.throws(() => protocol.validateRequest(replay, baseCtx(authority)), (e) => e.code === "OPERATOR_AUTH_REQUIRED");
});

test("stop.engage (operator_stop) round-trips against the real STOP store", () => {
  const { authority, stopStore } = setup();
  // resume first so we can operator-engage from a resumed state
  authority.stopResume({ expectedStopVersion: stopStore.get().version });
  const v = stopStore.get().version;
  const target = { expectedStopVersion: v, reasonCode: "operator_stop", summary: "operator halt" };

  const { request, ctx, decision } = mintAndValidate(authority, {
    action: "stop_engage", target, method: "stop.engage",
    params: { expectedStopVersion: v, reasonCode: "operator_stop", summary: "operator halt" },
  });
  assert.equal(decision.action, "execute");

  const stop = authority.stopEngage(target);
  assert.equal(stop.engaged, true);
  assert.equal(stop.reasonCode, "operator_stop");
  const validated = assertResponseValid("stop.engage", { stop, inFlightWorkers: [] }, request, ctx);
  assert.equal(validated.data.stop.reasonCode, "operator_stop");
});

test("budget.policy.set round-trips against the real budget store", () => {
  const { authority, budgetStore } = setup();
  const v = budgetStore.policy().version;
  const target = { expectedVersion: v, costLimitEnabled: true, costLimitMicros: 25_000_000 };

  const { request, ctx, decision } = mintAndValidate(authority, {
    action: "budget_policy_change", target, method: "budget.policy.set",
    params: { ...target }, ctxExtra: { structuralLimits: LIMITS },
  });
  assert.equal(decision.action, "execute");

  const policy = authority.budgetPolicySet(target);
  assert.ok(policy.version > v);
  assert.equal(policy.costLimitMicros, 25_000_000);
  const validated = assertResponseValid("budget.policy.set", policy, request, ctx);
  assert.equal(validated.data.costLimitMicros, 25_000_000);
});

test("work.cancel round-trips: proof bound to the resolved workerRef, routes to cancelWorker", () => {
  const { authority } = setup();
  const target = { workerRef: WREF, expectedWorkerVersion: 3, reasonCode: "operator_cancel" };

  const { request, ctx, decision } = mintAndValidate(authority, {
    action: "worker_cancel", target, method: "work.cancel",
    params: { workerHandle: WHANDLE, expectedWorkerVersion: 3, reasonCode: "operator_cancel" },
    ctxExtra: { workerRefForHandle: WREF },
  });
  assert.equal(decision.action, "execute");

  const worker = authority.workerCancel(target);
  assert.equal(worker.ref, WREF);
  assert.equal(worker.state, "stopping");
  const validated = assertResponseValid("work.cancel", { worker }, request, ctx);
  assert.ok(validated.data.worker.version > 3);
});

test("operator.action.begin records the source=gate caller audit exactly once per issue", () => {
  const { authority, audits, stopStore } = setup();
  const v0 = stopStore.get().version;
  mintAndValidate(authority, {
    action: "stop_resume", target: { expectedStopVersion: v0 },
    method: "stop.resume", params: { expectedStopVersion: v0 },
  });
  assert.equal(audits.length, 1);
  assert.equal(audits[0].eventCode, "operator_action_requested");
  assert.equal(audits[0].detail.action, "stop_resume");
});
