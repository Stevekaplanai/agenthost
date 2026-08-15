import { test } from "node:test";
import assert from "node:assert/strict";
import { createBudgetStore } from "../container/maintenance-budget-store.js";

function memoryLog(records = []) {
  return { records, append: (r) => records.push(JSON.parse(JSON.stringify(r))), readAll: () => records.slice() };
}
const POLICY = { policyVersion: 1, costLimitEnabled: true, costLimitMicros: 10_000_000 };
const LIMITS = { maxExecs: 3, maxLifetimeMs: 3_600_000, maxTokenUnits: 1_000_000, maxHandoffs: 8, maxConsecutiveSamePair: 2, softStopPermille: 800 };
const make = (log = memoryLog()) => createBudgetStore({ log, policy: POLICY, structuralLimits: LIMITS });

// Mirror of BudgetView invariants (contract §4.1) to guard against schema drift.
function assertBudgetView(v) {
  assert.deepEqual(Object.keys(v).sort(), ["chainId", "costMicros", "execs", "exhausted", "policyVersion", "reservedCostMicros", "reservedTokenUnits", "softStop", "tokenUnits"]);
  for (const k of ["policyVersion", "execs", "tokenUnits", "costMicros", "reservedTokenUnits", "reservedCostMicros"]) assert.ok(Number.isSafeInteger(v[k]) && v[k] >= 0, `${k} invalid`);
  assert.equal(typeof v.softStop, "boolean");
  assert.equal(typeof v.exhausted, "boolean");
}

test("reserve records a worst-case reservation and returns a valid view", () => {
  const b = make();
  const v = b.reserve({ chainId: "chain_1", workerRef: "wrk_1", tokenUnits: 100, costMicros: 2_000_000 });
  assertBudgetView(v);
  assert.equal(v.reservedCostMicros, 2_000_000);
  assert.equal(v.reservedTokenUnits, 100);
  assert.equal(v.execs, 1);
  assert.equal(v.costMicros, 0);
});

test("a work identity cannot hold two reservations", () => {
  const b = make();
  b.reserve({ chainId: "c", workerRef: "w", tokenUnits: 1, costMicros: 1 });
  assert.throws(() => b.reserve({ chainId: "c", workerRef: "w", tokenUnits: 1, costMicros: 1 }), (e) => e.code === "RESERVATION_EXISTS");
});

test("reserve fails closed when a cap would be exceeded", () => {
  const b = make();
  b.reserve({ chainId: "c", workerRef: "w1", tokenUnits: 10, costMicros: 6_000_000 });
  assert.throws(() => b.reserve({ chainId: "c", workerRef: "w2", tokenUnits: 10, costMicros: 5_000_000 }), (e) => e.code === "BUDGET_EXHAUSTED");
  // token cap
  assert.throws(() => b.reserve({ chainId: "c", workerRef: "w3", tokenUnits: 2_000_000, costMicros: 1 }), (e) => e.code === "BUDGET_EXHAUSTED");
});

test("exec cap denies the reservation past maxExecs", () => {
  const b = make();
  b.reserve({ chainId: "c", workerRef: "w1", tokenUnits: 1, costMicros: 1 });
  b.reserve({ chainId: "c", workerRef: "w2", tokenUnits: 1, costMicros: 1 });
  b.reserve({ chainId: "c", workerRef: "w3", tokenUnits: 1, costMicros: 1 });
  assert.throws(() => b.reserve({ chainId: "c", workerRef: "w4", tokenUnits: 1, costMicros: 1 }), (e) => e.code === "BUDGET_EXHAUSTED");
});

test("trusted settle charges min(observed, reserved) and releases the reservation", () => {
  const b = make();
  b.reserve({ chainId: "c", workerRef: "w", tokenUnits: 100, costMicros: 2_000_000 });
  const { view, mode } = b.settle({ workerRef: "w", trusted: true, observedTokenUnits: 40, observedCostMicros: 1_000_000 });
  assert.equal(mode, "observed");
  assert.equal(view.costMicros, 1_000_000);
  assert.equal(view.tokenUnits, 40);
  assert.equal(view.reservedCostMicros, 0);
});

test("trusted settle is capped at the reservation (cannot exceed it)", () => {
  const b = make();
  b.reserve({ chainId: "c", workerRef: "w", tokenUnits: 100, costMicros: 2_000_000 });
  const { view } = b.settle({ workerRef: "w", trusted: true, observedTokenUnits: 999_999, observedCostMicros: 9_999_999 });
  assert.equal(view.costMicros, 2_000_000);
  assert.equal(view.tokenUnits, 100);
});

test("missing/untrusted usage charges the full reservation (full_charge)", () => {
  const b = make();
  b.reserve({ chainId: "c", workerRef: "w", tokenUnits: 100, costMicros: 2_000_000 });
  const { view, mode } = b.settle({ workerRef: "w", trusted: false });
  assert.equal(mode, "full_charge");
  assert.equal(view.costMicros, 2_000_000);
  assert.equal(view.tokenUnits, 100);
});

test("settlement is exactly once", () => {
  const b = make();
  b.reserve({ chainId: "c", workerRef: "w", tokenUnits: 1, costMicros: 1 });
  b.settle({ workerRef: "w", trusted: false });
  assert.throws(() => b.settle({ workerRef: "w", trusted: false }), (e) => e.code === "ALREADY_FINALIZED");
});

test("refund releases a still-reserved identity exactly once; a settled one cannot be refunded", () => {
  const b = make();
  b.reserve({ chainId: "c", workerRef: "w", tokenUnits: 100, costMicros: 2_000_000 });
  const v = b.refund({ workerRef: "w" });
  assert.equal(v.reservedCostMicros, 0);
  assert.equal(v.costMicros, 0);
  assert.equal(v.execs, 0, "a refunded (no-spawn) reservation is not an exec");
  assert.throws(() => b.refund({ workerRef: "w" }), (e) => e.code === "ALREADY_FINALIZED");

  const b2 = make();
  b2.reserve({ chainId: "c", workerRef: "w2", tokenUnits: 1, costMicros: 1 });
  b2.settle({ workerRef: "w2", trusted: false });
  assert.throws(() => b2.refund({ workerRef: "w2" }), (e) => e.code === "ALREADY_FINALIZED");
});

test("reserved + settled never exceeds the cap across mixed operations", () => {
  const b = make();
  b.reserve({ chainId: "c", workerRef: "w1", tokenUnits: 10, costMicros: 4_000_000 });
  b.settle({ workerRef: "w1", trusted: true, observedTokenUnits: 5, observedCostMicros: 4_000_000 });
  b.reserve({ chainId: "c", workerRef: "w2", tokenUnits: 10, costMicros: 4_000_000 });
  const v = b.view("c");
  assert.ok(v.costMicros + v.reservedCostMicros <= POLICY.costLimitMicros);
  // a third reservation that would push over the cap is denied
  assert.throws(() => b.reserve({ chainId: "c", workerRef: "w3", tokenUnits: 1, costMicros: 4_000_000 }), (e) => e.code === "BUDGET_EXHAUSTED");
});

test("state survives a restart via durable replay (no double-reserve, no unearned refund)", () => {
  const log = memoryLog();
  const b1 = make(log);
  b1.reserve({ chainId: "c", workerRef: "w", tokenUnits: 100, costMicros: 2_000_000 });
  b1.settle({ workerRef: "w", trusted: false });
  const b2 = make(log);
  assert.throws(() => b2.reserve({ chainId: "c", workerRef: "w", tokenUnits: 1, costMicros: 1 }), (e) => e.code === "RESERVATION_EXISTS");
  assert.throws(() => b2.refund({ workerRef: "w" }), (e) => e.code === "ALREADY_FINALIZED");
  assert.equal(b2.view("c").costMicros, 2_000_000);
});

test("softStop and exhausted flags trip at their thresholds", () => {
  const b = make();
  // 80% permille of 10_000_000 = 8_000_000 committed -> softStop
  b.reserve({ chainId: "c", workerRef: "w1", tokenUnits: 1, costMicros: 8_000_000 });
  assert.equal(b.view("c").softStop, true);
  assert.equal(b.view("c").exhausted, false);
  b.reserve({ chainId: "c", workerRef: "w2", tokenUnits: 1, costMicros: 2_000_000 });
  assert.equal(b.view("c").exhausted, true);
});
