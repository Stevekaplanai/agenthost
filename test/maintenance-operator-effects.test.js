import { test } from "node:test";
import assert from "node:assert/strict";
import effectsMod from "../container/maintenance-operator-effects.js";
import gatewayMod from "../container/maintenance-operator-gateway.js";
import handlersMod from "../container/maintenance-operator-handlers.js";
import budgetMod from "../container/maintenance-budget-store.js";
import stopMod from "../container/maintenance-stop-store.js";

const { createOperatorEffects } = effectsMod;
const { createOperatorProofRegistry, createOperatorGateway } = gatewayMod;
const { createOperatorHandlers } = handlersMod;
const { createBudgetStore } = budgetMod;
const { createStopStore } = stopMod;

const pass = () => {};
const mem = (r = []) => ({ records: r, append: (x) => r.push(JSON.parse(JSON.stringify(x))), readAll: () => r.slice() });
const POLICY = { policyVersion: 1, costLimitEnabled: true, costLimitMicros: 10_000_000 };
const LIMITS = { maxExecs: 5, maxLifetimeMs: 3_600_000, maxTokenUnits: 1_000_000, maxHandoffs: 8, maxConsecutiveSamePair: 2, softStopPermille: 800 };

test("construction requires stop store, budget store, and cancelWorker", () => {
  assert.throws(() => createOperatorEffects({ budgetStore: { setPolicy() {} }, cancelWorker() {} }), /stop store/);
  assert.throws(() => createOperatorEffects({ stopStore: { resume() {}, engage() {} }, cancelWorker() {} }), /budget store/);
  assert.throws(() => createOperatorEffects({ stopStore: { resume() {}, engage() {} }, budgetStore: { setPolicy() {} } }), /cancelWorker/);
});

// The load-bearing property: each effect remaps the canonical target to EXACTLY
// the store's argument names — never passes the target through verbatim.
test("effects remap target fields to the store's arg names, verbatim values", () => {
  const calls = [];
  const stopStore = { resume: (a) => { calls.push(["resume", a]); return { engaged: false, version: 5 }; }, engage: (a) => { calls.push(["engage", a]); return { engaged: true, version: 6 }; } };
  const budgetStore = { setPolicy: (a) => { calls.push(["setPolicy", a]); return { version: 3 }; } };
  const cancelWorker = (a) => { calls.push(["cancel", a]); return { ref: a.workerRef, state: "stopping" }; };
  const fx = createOperatorEffects({ stopStore, budgetStore, cancelWorker });

  fx.stop_resume({ expectedStopVersion: 5 });
  assert.deepEqual(calls.at(-1), ["resume", { expectedVersion: 5 }]);

  fx.stop_engage({ expectedStopVersion: 5, reasonCode: "operator_stop", summary: "s" });
  assert.deepEqual(calls.at(-1), ["engage", { expectedVersion: 5, reasonCode: "operator_stop", summary: "s" }]);

  fx.budget_policy_change({ expectedVersion: 2, costLimitEnabled: true, costLimitMicros: 5_000_000 });
  assert.deepEqual(calls.at(-1), ["setPolicy", { expectedVersion: 2, costLimitEnabled: true, costLimitMicros: 5_000_000 }]);

  fx.worker_cancel({ workerRef: "wrk_1", expectedWorkerVersion: 4, reasonCode: "operator_cancel" });
  assert.deepEqual(calls.at(-1), ["cancel", { workerRef: "wrk_1", expectedWorkerVersion: 4, reasonCode: "operator_cancel" }]);
});

test("each effect fails closed on a malformed target", () => {
  const fx = createOperatorEffects({ stopStore: { resume() {}, engage() {} }, budgetStore: { setPolicy() {} }, cancelWorker() {} });
  assert.throws(() => fx.stop_resume({}), (e) => e.code === "INVALID_REQUEST");
  assert.throws(() => fx.stop_engage({ expectedStopVersion: 1 }), (e) => e.code === "INVALID_REQUEST");
  assert.throws(() => fx.budget_policy_change({ expectedVersion: 1 }), (e) => e.code === "INVALID_REQUEST");
  assert.throws(() => fx.worker_cancel({ workerRef: "w" }), (e) => e.code === "INVALID_REQUEST");
});

// End-to-end: real stores + effect map + handlers = the operator-authority path.
test("wired into the handlers with real stop + budget stores, the operator path round-trips", () => {
  const stopStore = createStopStore({ log: mem(), validateStopView: pass });
  const budgetStore = createBudgetStore({ log: mem(), policy: { ...POLICY }, structuralLimits: LIMITS });
  let cancelled = null;
  const effects = createOperatorEffects({ stopStore, budgetStore, cancelWorker: (t) => { cancelled = t; return { ref: t.workerRef, state: "stopping" }; } });
  const gateway = createOperatorGateway({ registry: createOperatorProofRegistry(), now: () => 1_000_000 });
  const h = createOperatorHandlers({ gateway, effects });

  const s0 = stopStore.get();
  const engaged = h.stopEngage({ expectedStopVersion: s0.version, reasonCode: "operator_stop", summary: "op" });
  assert.equal(engaged.engaged, true);
  const resumed = h.stopResume({ expectedStopVersion: engaged.version });
  assert.equal(resumed.engaged, false);

  const pol = h.budgetPolicySet({ expectedVersion: 1, costLimitEnabled: true, costLimitMicros: 3_000_000 });
  assert.equal(pol.version, 2);

  const w = h.workerCancel({ workerRef: "wrk_9", expectedWorkerVersion: 1, reasonCode: "operator_cancel" });
  assert.equal(w.state, "stopping");
  assert.deepEqual(cancelled, { workerRef: "wrk_9", expectedWorkerVersion: 1, reasonCode: "operator_cancel" });
});
