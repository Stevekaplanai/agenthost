"use strict";

// Real-Linux PID-1 harness for the dormant Phase-1b migration executor
// (container/maintenance-migration.js), driving the root-owned migration
// journal through the native trusted boundary + Foundation-A store. Runs as
// root PID 1 in a private PID + mount namespace. Driven only by
// scripts/maintenance-migration-verify.sh. Wires nothing into any boot path.

import assert from "node:assert/strict";
import cp from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTAINER = path.resolve(HERE, "..", "container");
const ADDON = process.env.AGENTHOST_MAINTENANCE_NATIVE;

function skip(reason) { process.stdout.write(`SKIP ${reason}\n`); process.exit(0); }
if (!ADDON) skip("AGENTHOST_MAINTENANCE_NATIVE is not set");
if (process.getuid() !== 0) skip("harness requires root");
if (process.pid !== 1) skip("harness requires PID 1 (run under scripts/maintenance-migration-verify.sh)");

const native = require(ADDON);
const { createMaintenanceStore, MIGRATION_STATES } = require(path.join(CONTAINER, "maintenance-store.js"));
const { createMigrationExecutor } = require(path.join(CONTAINER, "maintenance-migration.js"));
const { nativeStoreAdapter } = require(path.join(CONTAINER, "maintenance-supervisor.js"));

const DATA = "/data";
const MAINT = "/data/maintenance";

let failures = 0, passed = 0;
function check(label, fn) {
  try { fn(); passed += 1; process.stdout.write(`  ok   ${label}\n`); }
  catch (error) { failures += 1; process.stdout.write(`  FAIL ${label}: ${error && error.message}\n`); }
}
function throwsCode(fn, code, label) {
  check(label, () => {
    let thrown = null;
    try { fn(); } catch (e) { thrown = e; }
    assert.ok(thrown, `expected throw ${code}, got success`);
    assert.equal(thrown.code, code, `expected ${code}, got ${thrown.code} (${thrown.message})`);
  });
}

function mountIsolated() {
  cp.execSync(`mount -t tmpfs tmpfs ${DATA}`);
  cp.execSync(`chmod 0755 ${DATA}`);
  cp.execSync("mount -t tmpfs tmpfs /run");
  fs.mkdirSync(MAINT);
  fs.chmodSync(MAINT, 0o700);
}

const newStore = () => createMaintenanceStore({ adapter: nativeStoreAdapter(native), now: Date.now, redact: (s) => s });

// Step actions that record call counts and write a durable per-step marker
// (idempotent), so we can prove exactly-once vs re-run-after-crash.
function recordingActions(counts, opts = {}) {
  const actions = {};
  for (const stage of MIGRATION_STATES.slice(1)) {
    actions[stage] = ({ to }) => {
      counts[to] = (counts[to] || 0) + 1;
      if (opts.throwOnceAt === to && counts[to] === 1) {
        const err = new Error(`simulated crash at ${to}`);
        throw err;
      }
      fs.mkdirSync(`${MAINT}/steps`, { recursive: true });
      fs.writeFileSync(`${MAINT}/steps/${to}`, "done");
    };
  }
  return actions;
}

const cases = {
  // Fresh migration advances the whole sequence, each step once, STOP engaged.
  migration_sequence() {
    mountIsolated();
    const counts = {};
    const executor = createMigrationExecutor({ store: newStore(), stepActions: recordingActions(counts) });
    const snapshot = executor.run();
    check("migration reached complete", () => assert.equal(snapshot.migrationState, "complete"));
    check("every step action ran exactly once", () => {
      for (const stage of MIGRATION_STATES.slice(1)) assert.equal(counts[stage], 1, `${stage} ran ${counts[stage]} times`);
    });
    check("first secure migration stayed STOPPED", () => {
      assert.equal(snapshot.stop.engaged, true);
      assert.equal(snapshot.stop.reasonCode, "first_secure_migration");
    });
    check("all step markers are durable", () => {
      for (const stage of MIGRATION_STATES.slice(1)) assert.ok(fs.existsSync(`${MAINT}/steps/${stage}`), `${stage} marker missing`);
    });
  },

  // A crash mid-step leaves the recorded stage unadvanced; a fresh store
  // instance (simulating reboot) resumes from it, re-running the idempotent
  // action, and completes — no stage skipped.
  migration_resume() {
    mountIsolated();
    const counts = {};
    const store1 = newStore();
    const executor1 = createMigrationExecutor({ store: store1, stepActions: recordingActions(counts, { throwOnceAt: "stores_created" }) });
    let crashed = false;
    try { executor1.run(); } catch { crashed = true; }
    check("run failed closed at the simulated crash", () => assert.ok(crashed));
    check("recorded stage did not advance past the crash", () => {
      assert.equal(store1.snapshot().migrationState, "agent_markers_moved");
    });

    // Reboot: a fresh store re-opens the durable journal and resumes.
    const store2 = newStore();
    const executor2 = createMigrationExecutor({ store: store2, stepActions: recordingActions(counts, {}) });
    const snapshot = executor2.run();
    check("resumed run reaches complete", () => assert.equal(snapshot.migrationState, "complete"));
    check("the crashed step's action re-ran (idempotent), others advanced once", () => {
      assert.equal(counts.stores_created, 2, `stores_created ran ${counts.stores_created} times`);
      assert.equal(counts.secure_dirs, 1);
      assert.equal(counts.agent_markers_moved, 1);
      assert.equal(counts.complete, 1);
    });
  },

  // The store enforces the monotonic sequence: a skip is rejected, not silently
  // accepted.
  migration_monotonic() {
    mountIsolated();
    const store = newStore();
    store.open();
    check("fresh journal defaults to STOPPED/first_secure_migration at not_started", () => {
      const s = store.snapshot();
      assert.equal(s.migrationState, "not_started");
      assert.equal(s.stop.engaged, true);
      assert.equal(s.stop.reasonCode, "first_secure_migration");
    });
    throwsCode(() => store.advanceMigration("stores_created"), "INVALID_TRANSITION", "reject skipping stages");
    check("state is unchanged after a rejected skip", () => assert.equal(store.snapshot().migrationState, "not_started"));
    check("advancing one stage at a time is accepted", () => {
      store.advanceMigration("secure_dirs");
      assert.equal(store.snapshot().migrationState, "secure_dirs");
    });
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
