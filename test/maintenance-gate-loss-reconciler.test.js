import { test } from "node:test";
import assert from "node:assert/strict";
import mod from "../container/maintenance-gate-loss-reconciler.js";

const { createGateLossReconciler } = mod;
const codeOf = (e) => e && e.code;
const EPOCH = "gw_" + "a".repeat(32);
const target = (workerRef) => ({ claimRef: "clm_" + workerRef, workerRef, runId: "r_" + workerRef, chainId: "c1", engine: "claude", taskId: "t1" });

test("construction requires the enumerator and the per-worker recover", () => {
  assert.throws(() => createGateLossReconciler({ recoverWorker: () => ({}) }), /enumerateEpochWorkers/);
  assert.throws(() => createGateLossReconciler({ enumerateEpochWorkers: () => [] }), /recoverWorker/);
});

test("idle lane: no epoch workers -> reconciled, nothing quarantined", async () => {
  const r = createGateLossReconciler({ enumerateEpochWorkers: () => [], recoverWorker: () => { throw new Error("must not be called"); } });
  const out = await r.reconcile({ epoch: EPOCH });
  assert.deepEqual({ reconciled: out.reconciled, workers: out.workers, anyQuarantined: out.anyQuarantined }, { reconciled: true, workers: [], anyQuarantined: false });
});

test("clean teardown: the recorded worker is recovered, not quarantined", async () => {
  const seen = [];
  const r = createGateLossReconciler({
    enumerateEpochWorkers: () => [target("wrk_1")],
    recoverWorker: (t) => { seen.push(t.workerRef); return { quarantined: false }; },
  });
  const out = await r.reconcile({ epoch: EPOCH });
  assert.deepEqual(seen, ["wrk_1"]);
  assert.equal(out.anyQuarantined, false);
  assert.deepEqual(out.workers, [{ workerRef: "wrk_1", quarantined: false }]);
});

test("cleanup unproven: the lane is quarantined (driver-reported), reconciliation still completes", async () => {
  const r = createGateLossReconciler({
    enumerateEpochWorkers: () => [target("wrk_1")],
    recoverWorker: () => ({ quarantined: true }),
  });
  const out = await r.reconcile({ epoch: EPOCH });
  assert.equal(out.reconciled, true);
  assert.equal(out.anyQuarantined, true);
  assert.equal(out.workers[0].quarantined, true);
});

test("fail-closed: a teardown that THROWS quarantines the lane, never reads as recovered", async () => {
  const r = createGateLossReconciler({
    enumerateEpochWorkers: () => [target("wrk_1")],
    recoverWorker: () => { throw new Error("teardown blew up"); },
  });
  const out = await r.reconcile({ epoch: EPOCH });
  assert.equal(out.workers[0].quarantined, true);
  assert.equal(out.anyQuarantined, true);
});

test("multiple recorded workers: every one is driven; mixed outcomes surface", async () => {
  const r = createGateLossReconciler({
    enumerateEpochWorkers: () => [target("wrk_1"), target("wrk_2"), target("wrk_3")],
    recoverWorker: (t) => ({ quarantined: t.workerRef === "wrk_2" }),
  });
  const out = await r.reconcile({ epoch: EPOCH });
  assert.equal(out.workers.length, 3);
  assert.deepEqual(out.workers.map((w) => w.quarantined), [false, true, false]);
  assert.equal(out.anyQuarantined, true);
});

test("PID-1 target selection: recoverWorker receives the ENUMERATED target verbatim", async () => {
  let received = null;
  const r = createGateLossReconciler({
    enumerateEpochWorkers: () => [target("wrk_1")],
    recoverWorker: (t) => { received = t; return { quarantined: false }; },
  });
  await r.reconcile({ epoch: EPOCH });
  assert.deepEqual(received, target("wrk_1"));
});

test("invalid epoch / bad enumerator output fail closed", async () => {
  const r1 = createGateLossReconciler({ enumerateEpochWorkers: () => [], recoverWorker: () => ({}) });
  await assert.rejects(() => r1.reconcile({ epoch: "" }), (e) => codeOf(e) === "INVALID_REQUEST");
  const r2 = createGateLossReconciler({ enumerateEpochWorkers: () => ({ not: "an array" }), recoverWorker: () => ({}) });
  await assert.rejects(() => r2.reconcile({ epoch: EPOCH }), (e) => codeOf(e) === "INTERNAL_RESPONSE_INVALID");
  const r3 = createGateLossReconciler({ enumerateEpochWorkers: () => [{ claimRef: "clm_x" }], recoverWorker: () => ({}) });
  await assert.rejects(() => r3.reconcile({ epoch: EPOCH }), (e) => codeOf(e) === "INTERNAL_RESPONSE_INVALID");
});
