import { test } from "node:test";
import assert from "node:assert/strict";
import operatorGateway from "../container/maintenance-operator-gateway.js";
import operatorHandlers from "../container/maintenance-operator-handlers.js";
import budgetStoreMod from "../container/maintenance-budget-store.js";
import stopStoreMod from "../container/maintenance-stop-store.js";

const { createOperatorProofRegistry, createOperatorGateway } = operatorGateway;
const { createOperatorHandlers } = operatorHandlers;
const { createBudgetStore } = budgetStoreMod;
const { createStopStore } = stopStoreMod;

const pass = () => {};
function mem(records = []) { return { records, append: (r) => records.push(JSON.parse(JSON.stringify(r))), readAll: () => records.slice() }; }
const POLICY = { policyVersion: 1, costLimitEnabled: true, costLimitMicros: 10_000_000 };
const LIMITS = { maxExecs: 5, maxLifetimeMs: 3_600_000, maxTokenUnits: 1_000_000, maxHandoffs: 8, maxConsecutiveSamePair: 2, softStopPermille: 800 };

function makeHandlers({ effects, audit } = {}) {
  const registry = createOperatorProofRegistry();
  const gateway = createOperatorGateway({ registry, now: () => 1_000_000 });
  return createOperatorHandlers({ gateway, effects, audit });
}
const nullEffects = () => ({ stop_resume: () => null, stop_engage: () => null, worker_cancel: () => null, budget_policy_change: () => null });

test("construction requires the gateway and a fixed effect for every O-class action", () => {
  assert.throws(() => createOperatorHandlers({ effects: nullEffects() }), /gateway/);
  const registry = createOperatorProofRegistry();
  const gateway = createOperatorGateway({ registry, now: () => 1 });
  const missing = nullEffects(); delete missing.worker_cancel;
  assert.throws(() => createOperatorHandlers({ gateway, effects: missing }), /worker_cancel/);
});

test("each handler forwards ONLY the canonical target to its fixed effect", () => {
  const seen = {};
  const effects = {
    stop_resume: (t) => { seen.stop_resume = t; return { ok: "resume" }; },
    stop_engage: (t) => { seen.stop_engage = t; return { ok: "engage" }; },
    worker_cancel: (t) => { seen.worker_cancel = t; return { ok: "cancel" }; },
    budget_policy_change: (t) => { seen.budget_policy_change = t; return { ok: "policy" }; },
  };
  const h = makeHandlers({ effects });
  assert.deepEqual(h.stopResume({ expectedStopVersion: 2 }), { ok: "resume" });
  assert.deepEqual(seen.stop_resume, { expectedStopVersion: 2 });
  assert.deepEqual(h.workerCancel({ workerRef: "wrk_x", expectedWorkerVersion: 3, reasonCode: "operator_cancel" }), { ok: "cancel" });
  assert.deepEqual(seen.worker_cancel, { workerRef: "wrk_x", expectedWorkerVersion: 3, reasonCode: "operator_cancel" });
});

test("beginOperatorAction records the source=gate caller audit after a successful issue", () => {
  const audits = [];
  const h = makeHandlers({ effects: nullEffects(), audit: (code, detail) => audits.push({ code, detail }) });
  const targetDigest = "sha256:" + "a".repeat(64);
  const out = h.beginOperatorAction({ connectionId: "c1", gatewayEpoch: "gw_" + "a".repeat(32), action: "stop_resume", operatorSessionDigest: "sha256:" + "b".repeat(64), targetDigest });
  assert.equal(out.operatorProof.action, "stop_resume");
  assert.deepEqual(audits, [{ code: "operator_action_requested", detail: { action: "stop_resume", targetDigest } }]);
});

test("a rejected begin (bad action) mints no proof and records no audit", () => {
  const audits = [];
  const h = makeHandlers({ effects: nullEffects(), audit: (code, detail) => audits.push({ code, detail }) });
  assert.throws(() => h.beginOperatorAction({ connectionId: "c1", gatewayEpoch: "gw_" + "a".repeat(32), action: "nope", operatorSessionDigest: "sha256:" + "b".repeat(64), targetDigest: "sha256:" + "a".repeat(64) }));
  assert.equal(audits.length, 0);
});

// End-to-end operator-authority path against the REAL stop store.
test("stop_resume / stop_engage bound to the real stop store", () => {
  const stopStore = createStopStore({ log: mem(), validateStopView: pass });
  const effects = {
    stop_resume: (t) => stopStore.resume({ expectedVersion: t.expectedStopVersion }),
    stop_engage: (t) => stopStore.engage({ expectedVersion: t.expectedStopVersion, reasonCode: t.reasonCode, summary: t.summary }),
    worker_cancel: () => null,
    budget_policy_change: () => null,
  };
  const h = makeHandlers({ effects });
  const s0 = stopStore.get();
  const engaged = h.stopEngage({ expectedStopVersion: s0.version, reasonCode: "operator_stop", summary: "op" });
  assert.equal(engaged.engaged, true);
  const resumed = h.stopResume({ expectedStopVersion: engaged.version });
  assert.equal(resumed.engaged, false);
});

// End-to-end operator-authority path against the REAL budget store setPolicy.
test("budget_policy_change bound to the real budget store setPolicy", () => {
  const budgetStore = createBudgetStore({ log: mem(), policy: { ...POLICY }, structuralLimits: LIMITS });
  const effects = { stop_resume: () => null, stop_engage: () => null, worker_cancel: () => null, budget_policy_change: (t) => budgetStore.setPolicy(t) };
  const h = makeHandlers({ effects });
  const out = h.budgetPolicySet({ expectedVersion: 1, costLimitEnabled: true, costLimitMicros: 25_000_000 });
  assert.equal(out.version, 2);
  assert.equal(out.costLimitMicros, 25_000_000);
  assert.equal(budgetStore.view("chain_x").policyVersion, 2);
});

// ---- budget store setPolicy unit behavior (the new operator-authority method) ----

test("setPolicy: monotonic version + CAS on expectedVersion", () => {
  const budgetStore = createBudgetStore({ log: mem(), policy: { ...POLICY }, structuralLimits: LIMITS });
  assert.equal(budgetStore.policy().version, 1);
  const p2 = budgetStore.setPolicy({ expectedVersion: 1, costLimitEnabled: true, costLimitMicros: 5_000_000 });
  assert.equal(p2.version, 2);
  assert.throws(() => budgetStore.setPolicy({ expectedVersion: 1, costLimitEnabled: true, costLimitMicros: 6_000_000 }), (e) => e.code === "STALE_VERSION");
});

test("setPolicy: range + type checks fail closed", () => {
  const budgetStore = createBudgetStore({ log: mem(), policy: { ...POLICY }, structuralLimits: LIMITS });
  assert.throws(() => budgetStore.setPolicy({ expectedVersion: 1, costLimitEnabled: true, costLimitMicros: 999_999 }), (e) => e.code === "INVALID_POLICY");
  assert.throws(() => budgetStore.setPolicy({ expectedVersion: 1, costLimitEnabled: true, costLimitMicros: 100_000_001 }), (e) => e.code === "INVALID_POLICY");
  assert.throws(() => budgetStore.setPolicy({ expectedVersion: 1, costLimitEnabled: "yes", costLimitMicros: 5_000_000 }), (e) => e.code === "INVALID_POLICY");
});

test("setPolicy: the new cap governs exhaustion, and is restart-safe via replay", () => {
  const log = mem();
  const budgetStore = createBudgetStore({ log, policy: { ...POLICY }, structuralLimits: LIMITS });
  // Lower the cap to 2,000,000; a 3,000,000 reservation must now be refused.
  budgetStore.setPolicy({ expectedVersion: 1, costLimitEnabled: true, costLimitMicros: 2_000_000 });
  assert.throws(() => budgetStore.reserve({ chainId: "c", workerRef: "wrk_1", tokenUnits: 10, costMicros: 3_000_000 }), (e) => e.code === "BUDGET_EXHAUSTED");
  // A fresh store replaying the same log recovers the lowered policy.
  const replayed = createBudgetStore({ log: mem(log.records.slice()), policy: { ...POLICY }, structuralLimits: LIMITS });
  assert.equal(replayed.policy().version, 2);
  assert.equal(replayed.policy().costLimitMicros, 2_000_000);
  assert.throws(() => replayed.reserve({ chainId: "c", workerRef: "wrk_2", tokenUnits: 10, costMicros: 3_000_000 }), (e) => e.code === "BUDGET_EXHAUSTED");
});
