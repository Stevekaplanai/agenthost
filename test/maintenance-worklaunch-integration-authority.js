"use strict";

// Real-Linux PID-1 integration harness (BUILD-PLAN Phase 1d): the atomic
// work.start transaction driving the REAL worker runtime (service-created PID +
// mount namespace containment + kernel-stable child observation). Proves a full
// launch -> observed running child -> teardown -> lane freed cycle with an
// actual contained `agent` worker, plus the conclusive-no-child refund path.
// Driven only by scripts/maintenance-worklaunch-integration-verify.sh. Wires
// nothing into any boot path.

import assert from "node:assert/strict";
import cp from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTAINER = path.resolve(HERE, "..", "container");

function skip(reason) { process.stdout.write(`SKIP ${reason}\n`); process.exit(0); }
if (process.getuid() !== 0) skip("harness requires root");
if (process.pid !== 1) skip("harness requires PID 1 (run under scripts/maintenance-worklaunch-integration-verify.sh)");

const { createStopStore } = require(path.join(CONTAINER, "maintenance-stop-store.js"));
const { createClaimsStore } = require(path.join(CONTAINER, "maintenance-claims-store.js"));
const { createRunsStore } = require(path.join(CONTAINER, "maintenance-runs-store.js"));
const { createBudgetStore } = require(path.join(CONTAINER, "maintenance-budget-store.js"));
const { createAuditStore } = require(path.join(CONTAINER, "maintenance-audit-store.js"));
const { createWorkLauncher } = require(path.join(CONTAINER, "maintenance-work-launch.js"));
const { createWorkerRuntime } = require(path.join(CONTAINER, "maintenance-worker-runtime.js"));
const { createRecoveryStore } = require(path.join(CONTAINER, "maintenance-recovery-store.js"));
const { createRecoveryDriver } = require(path.join(CONTAINER, "maintenance-recovery-driver.js"));

let failures = 0, passed = 0;
function check(label, fn) {
  try { fn(); passed += 1; process.stdout.write(`  ok   ${label}\n`); }
  catch (error) { failures += 1; process.stdout.write(`  FAIL ${label}: ${error && error.message}\n`); }
}
const pass = () => {};
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const ids = (name) => ({ uid: Number(cp.execSync(`id -u ${name}`).toString().trim()), gid: Number(cp.execSync(`id -g ${name}`).toString().trim()) });
async function waitFor(fn, ms = 3000) { for (let i = 0; i < ms / 25; i += 1) { if (fn()) return true; await delay(25); } return fn(); }

const POLICY = { policyVersion: 1, costLimitEnabled: true, costLimitMicros: 10_000_000 };
const LIMITS = { maxExecs: 5, maxLifetimeMs: 3_600_000, maxTokenUnits: 1_000_000, maxHandoffs: 8, maxConsecutiveSamePair: 2, softStopPermille: 800 };

function setup({ profileId = "profile_x" } = {}) {
  const agent = ids("agent");
  const stopStore = createStopStore({ log: mem(), validateStopView: pass });
  stopStore.resume({ expectedVersion: 1 });
  const claimsStore = createClaimsStore({ log: mem(), validateClaimView: pass });
  const runsStore = createRunsStore({ log: mem(), validateRunView: pass });
  const budgetStore = createBudgetStore({ log: mem(), policy: POLICY, structuralLimits: LIMITS });
  const auditStore = createAuditStore({ log: mem() });
  const runtime = createWorkerRuntime({ profiles: { profile_x: { argv: ["sh", "-c", "sleep 300"], worktreeBase: "/wtint", uid: agent.uid, gid: agent.gid } } });
  const launcher = createWorkLauncher({
    stopStore, claimsStore, runsStore, budgetStore, auditStore,
    spawn: runtime.spawn, worstCaseFor: () => ({ tokenUnits: 100, costMicros: 2_000_000 }),
  });
  const recoveryStore = createRecoveryStore({ log: mem(), validateRecoveryView: pass });
  runsStore.accept({ id: "run_1", kind: "board_task", taskId: "task_1", chainId: "chain_1", profileId, repoId: "repo_y", workMode: "new", engines: ["claude"], summary: "" });
  return { agent, stopStore, claimsStore, runsStore, budgetStore, auditStore, runtime, launcher, recoveryStore };
}
function mem(records = []) { return { records, append: (r) => records.push(JSON.parse(JSON.stringify(r))), readAll: () => records.slice() }; }
const START = { mode: "new", taskId: "task_1", runId: "run_1", chainId: "chain_1", engine: "claude", profileId: "profile_x", repoId: "repo_y" };

const cases = {
  // Full cycle: work.start launches a real contained agent worker, PID 1
  // observes it running, teardown reaps it, completeWorker frees the lane.
  async full_cycle() {
    const s = setup();
    const r = s.launcher.start(START);
    const workerRef = r.worker.workerRef;
    check("work.start returned a running, worker-attached claim", () => {
      assert.equal(r.claim.state, "active");
      assert.equal(r.claim.workerRef, workerRef);
      assert.equal(s.runsStore.get("run_1").status, "running");
    });
    check("the real contained worker is alive (kernel-stable identity)", () => assert.ok(s.runtime.alive(workerRef)));
    check("child observed audit was recorded", () => {
      const codes = s.auditStore.read({ afterSeq: 0 }).events.map((e) => e.eventCode);
      assert.ok(codes.includes("child_observed"));
    });

    // Teardown the real worker (models observed exit / cancel), then settle.
    s.runtime.teardown(workerRef);
    const gone = await waitFor(() => !s.runtime.alive(workerRef), 4000);
    check("teardown reaps the contained worker", () => assert.ok(gone));
    s.launcher.completeWorker({ workerRef, claimRef: r.claim.ref, runId: "run_1", engine: "claude", taskId: "task_1", chainId: "chain_1", outcome: "completed", usage: { tokenUnits: 10, costMicros: 100_000 } });
    check("lane freed and budget settled after completion", () => {
      assert.equal(s.launcher.laneState().busy, false);
      assert.equal(s.budgetStore.view("chain_1").reservedCostMicros, 0);
      assert.equal(s.runsStore.get("run_1").status, "completed");
    });

    // A fresh accepted run can now launch on the freed lane.
    s.runsStore.accept({ id: "run_2", kind: "board_task", taskId: "task_2", chainId: "chain_2", profileId: "profile_x", repoId: "repo_y", workMode: "new", engines: ["claude"], summary: "" });
    const r2 = s.launcher.start({ ...START, runId: "run_2", taskId: "task_2", chainId: "chain_2" });
    check("a second launch succeeds on the freed lane", () => assert.equal(r2.run.status, "running"));
    s.runtime.teardown(r2.worker.workerRef);
    await waitFor(() => !s.runtime.alive(r2.worker.workerRef), 3000);
  },

  // A profile the runtime cannot launch yields a conclusive no-child result, so
  // work.start refunds exactly once and frees the lane.
  async no_child_refund() {
    const s = setup({ profileId: "profile_missing" });
    let code = null;
    try { s.launcher.start({ ...START, profileId: "profile_missing" }); } catch (e) { code = e.code; }
    check("work.start fails closed when no child can be launched", () => assert.equal(code, "SPAWN_FAILED"));
    check("the reservation was refunded and the lane freed", () => {
      const b = s.budgetStore.view("chain_1");
      assert.equal(b.costMicros, 0);
      assert.equal(b.reservedCostMicros, 0);
      assert.equal(s.launcher.laneState().busy, false);
    });
  },

  // Recovery of a live worker: tear down the real contained worker, prove it is
  // gone, settle conservatively, mark claim + run interrupted, complete recovery.
  async recover_running_worker() {
    const s = setup();
    const r = s.launcher.start(START);
    const workerRef = r.worker.workerRef;
    const driver = createRecoveryDriver({
      recoveryStore: s.recoveryStore, claimsStore: s.claimsStore, runsStore: s.runsStore,
      budgetStore: s.budgetStore, auditStore: s.auditStore,
      teardownWorker: (w) => s.runtime.teardown(w), verifyGone: (w) => !s.runtime.alive(w),
      releaseLane: (w) => s.launcher.releaseLane(w),
    });
    const out = await driver.recover({ claimRef: r.claim.ref, workerRef, runId: "run_1", chainId: "chain_1", engine: "claude", taskId: "task_1" });
    check("recovery completed and the real worker was reaped", () => {
      assert.equal(out.quarantined, false);
      assert.equal(out.recovery.state, "complete");
      assert.ok(!s.runtime.alive(workerRef));
    });
    check("claim + run interrupted, budget conservatively full-charged, lane freed", () => {
      assert.equal(s.claimsStore.get(r.claim.ref).state, "interrupted");
      assert.equal(s.runsStore.get("run_1").status, "interrupted");
      assert.equal(s.budgetStore.view("chain_1").costMicros, 2_000_000);
      assert.equal(s.launcher.laneState().busy, false);
    });
    check("a recovery_completed service-audit fact was recorded", () => {
      assert.ok(s.auditStore.read({ afterSeq: 0, source: "service" }).events.some((e) => e.eventCode === "recovery_completed"));
    });
  },

  // When cleanup cannot be proven, recovery quarantines the recovery and the
  // claim (not releasable) instead of claiming success.
  async recover_quarantine_when_cleanup_unproven() {
    const s = setup();
    const r = s.launcher.start(START);
    const workerRef = r.worker.workerRef;
    // teardown really reaps the worker (no leak), but the proof reports "not gone".
    const driver = createRecoveryDriver({
      recoveryStore: s.recoveryStore, claimsStore: s.claimsStore, runsStore: s.runsStore,
      budgetStore: s.budgetStore, auditStore: s.auditStore,
      teardownWorker: (w) => s.runtime.teardown(w), verifyGone: () => false,
      releaseLane: (w) => s.launcher.releaseLane(w),
    });
    const out = await driver.recover({ claimRef: r.claim.ref, workerRef, runId: "run_1", chainId: "chain_1", engine: "claude", taskId: "task_1", graceMs: 200 });
    check("recovery is quarantined with a fixed reason", () => {
      assert.equal(out.quarantined, true);
      assert.equal(out.recovery.state, "quarantined");
      assert.equal(out.recovery.quarantineReason, "descendant_alive");
    });
    check("the claim is quarantined (not releasable) and the lane is freed", () => {
      assert.equal(s.claimsStore.get(r.claim.ref).state, "quarantined");
      assert.equal(s.launcher.laneState().busy, false);
    });
    await waitFor(() => !s.runtime.alive(workerRef), 3000); // the worker was actually reaped
  },
};

async function main() {
  const name = process.argv[2] || process.env.MAINT_CASE;
  if (!name || !cases[name]) { process.stdout.write(`unknown case: ${name}\navailable: ${Object.keys(cases).join(", ")}\n`); process.exit(2); }
  process.stdout.write(`CASE ${name}\n`);
  await cases[name]();
  process.stdout.write(`CASE ${name}: ${failures === 0 ? "PASS" : "FAIL"} (${passed} ok, ${failures} failed)\n`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((error) => { process.stdout.write(`HARNESS ERROR: ${error && error.stack}\n`); process.exit(3); });
