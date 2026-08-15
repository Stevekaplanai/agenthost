import { test } from "node:test";
import assert from "node:assert/strict";
import claimsMod from "../container/maintenance-claims-store.js";
import runsMod from "../container/maintenance-runs-store.js";
import budgetMod from "../container/maintenance-budget-store.js";
import auditMod from "../container/maintenance-audit-store.js";
import recoveryStoreMod from "../container/maintenance-recovery-store.js";
import driverMod from "../container/maintenance-recovery-driver.js";
import handlerMod from "../container/maintenance-recovery-request.js";

const { createClaimsStore } = claimsMod;
const { createRunsStore } = runsMod;
const { createBudgetStore } = budgetMod;
const { createAuditStore } = auditMod;
const { createRecoveryStore } = recoveryStoreMod;
const { createRecoveryDriver } = driverMod;
const { createRecoveryRequestHandler } = handlerMod;

const pass = () => {};
function mem(records = []) { return { records, append: (r) => records.push(JSON.parse(JSON.stringify(r))), readAll: () => records.slice() }; }
const POLICY = { policyVersion: 1, costLimitEnabled: true, costLimitMicros: 10_000_000 };
const LIMITS = { maxExecs: 5, maxLifetimeMs: 3_600_000, maxTokenUnits: 1_000_000, maxHandoffs: 8, maxConsecutiveSamePair: 2, softStopPermille: 800 };
const codeOf = (e) => e && e.code;

// A claim with a recorded (attached) worker + an accepted run, plus a recovery
// driver whose teardown is faked (the real teardown is proven on Linux in 1d).
function setup({ verifyGone = () => true, attachWorker = true, state = null, storesHealthy, emergencyContain } = {}) {
  const claimsStore = createClaimsStore({ log: mem(), validateClaimView: pass });
  const runsStore = createRunsStore({ log: mem(), validateRunView: pass });
  const budgetStore = createBudgetStore({ log: mem(), policy: { ...POLICY }, structuralLimits: LIMITS });
  const auditStore = createAuditStore({ log: mem() });
  const recoveryStore = createRecoveryStore({ log: mem(), validateRecoveryView: pass });
  const driver = createRecoveryDriver({
    recoveryStore, claimsStore, runsStore, budgetStore, auditStore,
    teardownWorker: () => {}, verifyGone, releaseLane: () => {}, delay: () => Promise.resolve(),
  });
  runsStore.accept({ id: "r1", kind: "board_task", taskId: "t1", chainId: "c1", profileId: "p", repoId: "repo", workMode: "new", engines: ["claude"], summary: "" });
  let claim = claimsStore.create({ taskId: "t1", runId: "r1", chainId: "c1", authorEngine: "claude" });
  if (attachWorker) claim = claimsStore.attachWorker(claim.ref, { expectedVersion: claim.version, workerRef: "wrk_1" });
  if (state) claim = claimsStore.transition(claim.ref, { expectedVersion: claim.version, to: state });
  const handler = createRecoveryRequestHandler({ claimsStore, recoveryDriver: driver, storesHealthy, emergencyContain });
  return { claimsStore, recoveryStore, handler, claim };
}

test("healthy recover: PID 1 tears down the recorded worker and completes", async () => {
  const s = setup({ verifyGone: () => true });
  const out = await s.handler.request({ claimRef: s.claim.ref, expectedVersion: s.claim.version });
  assert.equal(out.quarantined, false);
  assert.equal(out.recovery.state, "complete");
  assert.equal(s.claimsStore.get(s.claim.ref).state, "interrupted");
});

test("cleanup unproven: quarantines instead of claiming success", async () => {
  const s = setup({ verifyGone: () => false });
  const out = await s.handler.request({ claimRef: s.claim.ref, expectedVersion: s.claim.version });
  assert.equal(out.quarantined, true);
  assert.equal(out.recovery.state, "quarantined");
  assert.equal(s.claimsStore.get(s.claim.ref).state, "quarantined");
});

test("caller supplies no pid/signal — only claimRef + expectedVersion are used", async () => {
  const s = setup();
  // Extra caller-supplied fields are ignored; the handler selects the recorded worker.
  const out = await s.handler.request({ claimRef: s.claim.ref, expectedVersion: s.claim.version, workerRef: "wrk_ATTACKER", signal: "KILL" });
  assert.equal(out.recovery.state, "complete");
});

test("no such claim / stale version -> RECOVERY_NOT_ELIGIBLE", async () => {
  const s = setup();
  await assert.rejects(() => s.handler.request({ claimRef: "clm_none", expectedVersion: 1 }), (e) => codeOf(e) === "RECOVERY_NOT_ELIGIBLE");
  await assert.rejects(() => s.handler.request({ claimRef: s.claim.ref, expectedVersion: s.claim.version + 5 }), (e) => codeOf(e) === "RECOVERY_NOT_ELIGIBLE");
});

test("claim with no recorded worker -> RECOVERY_NOT_ELIGIBLE", async () => {
  const s = setup({ attachWorker: false });
  await assert.rejects(() => s.handler.request({ claimRef: s.claim.ref, expectedVersion: s.claim.version }), (e) => codeOf(e) === "RECOVERY_NOT_ELIGIBLE");
});

test("quarantined claim -> RECOVERY_QUARANTINED", async () => {
  const s = setup({ state: "quarantined" });
  await assert.rejects(() => s.handler.request({ claimRef: s.claim.ref, expectedVersion: s.claim.version }), (e) => codeOf(e) === "RECOVERY_QUARANTINED");
});

test("degraded persistence: fails closed with STORE_UNAVAILABLE + fatalRestart, attempts emergency containment, never drives the durable driver", async () => {
  let contained = null;
  const s = setup({
    storesHealthy: () => false,
    emergencyContain: (t) => { contained = t.workerRef; },
    verifyGone: () => { throw new Error("driver.recover must NOT run in degraded mode"); },
  });
  await assert.rejects(
    () => s.handler.request({ claimRef: s.claim.ref, expectedVersion: s.claim.version }),
    (e) => codeOf(e) === "STORE_UNAVAILABLE" && e.fatalRestart === true,
  );
  assert.equal(contained, "wrk_1", "emergency containment was attempted on the recorded worker");
});
