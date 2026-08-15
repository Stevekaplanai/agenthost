"use strict";

// Real-Linux PID-1 harness for the dormant Foundation-B supervisor core
// (container/maintenance-supervisor.js). Runs as root PID 1 inside a private
// PID + mount + net namespace, boots the supervisor against the proven native
// boundary, and drives a real `gate`-uid mock client through the version-locked
// handshake and a gate-loss + replacement-epoch cycle.
//
// Driven only by scripts/maintenance-supervisor-verify.sh. Wires nothing into
// any boot path. Skips cleanly if it is not the authority context.

import assert from "node:assert/strict";
import cp from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTAINER = path.resolve(HERE, "..", "container");
const MOCK_GATE = path.join(HERE, "maintenance-mock-gate.cjs");
const ADDON = process.env.AGENTHOST_MAINTENANCE_NATIVE;

function skip(reason) {
  process.stdout.write(`SKIP ${reason}\n`);
  process.exit(0);
}
if (!ADDON) skip("AGENTHOST_MAINTENANCE_NATIVE is not set");
if (process.getuid() !== 0) skip("harness requires root");
if (process.pid !== 1) skip("harness requires PID 1 (run under scripts/maintenance-supervisor-verify.sh)");

const native = require(ADDON);
const protocol = require(path.join(CONTAINER, "maintenance-protocol.js"));
const { createMaintenanceStore } = require(path.join(CONTAINER, "maintenance-store.js"));
const { createMaintenanceSupervisor } = require(path.join(CONTAINER, "maintenance-supervisor.js"));
const { MAINTENANCE_CONTRACT } = require(path.join(CONTAINER, "maintenance-contract.js"));

const DATA = "/data";
const MAINT = "/data/maintenance";
const SOCKET = "/run/agenthost/maint.sock";

let failures = 0;
let passed = 0;
function check(label, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ok   ${label}\n`);
  } catch (error) {
    failures += 1;
    process.stdout.write(`  FAIL ${label}: ${error && error.message}\n`);
  }
}

const sh = (c) => cp.execSync(c, { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const ids = (name) => ({ uid: Number(sh(`id -u ${name}`)), gid: Number(sh(`id -g ${name}`)) });

function mountIsolated() {
  cp.execSync(`mount -t tmpfs tmpfs ${DATA}`);
  cp.execSync(`chmod 0755 ${DATA}`);
  cp.execSync("mount -t tmpfs tmpfs /run");
  fs.mkdirSync(MAINT);
  fs.chmodSync(MAINT, 0o700);
}

// --- gate child plumbing --------------------------------------------------
const gate = ids("gate");
let currentGate = null;
let gateLines = [];
let gateWaiters = [];

function attachGateStdout(child) {
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      gateLines.push(line);
      for (const w of gateWaiters.slice()) {
        if (w.pred(line)) {
          gateWaiters.splice(gateWaiters.indexOf(w), 1);
          w.resolve(line);
        }
      }
    }
  });
}

function spawnGate() {
  gateLines = [];
  gateWaiters = [];
  const child = cp.spawn(process.execPath, [MOCK_GATE], {
    uid: gate.uid,
    gid: gate.gid,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, AGENTHOST_MAINT_SOCK: SOCKET },
  });
  currentGate = child;
  attachGateStdout(child);
  child.stderr.on("data", (d) => process.stdout.write(`    [gate stderr] ${d}`));
  return child;
}

function waitGateLine(pred, ms = 5000) {
  const existing = gateLines.find(pred);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("gate line timeout")), ms);
    gateWaiters.push({ pred, resolve: (l) => { clearTimeout(timer); resolve(l); } });
  });
}

function buildSupervisor() {
  return createMaintenanceSupervisor({
    native,
    protocol,
    createStore: (opts) => createMaintenanceStore(opts),
    contract: MAINTENANCE_CONTRACT,
    spawnGate,
    now: Date.now,
    log: (m) => process.env.MAINT_DEBUG && process.stdout.write(`    [sup] ${m}\n`),
  });
}

async function acceptWithRetry(supervisor) {
  for (let i = 0; i < 200; i += 1) {
    let fd;
    try {
      fd = supervisor.acceptGate();
    } catch (error) {
      return { err: error.code || "throw" };
    }
    if (typeof fd === "number") return { fd };
    await delay(20);
  }
  return { err: "NO_ACCEPT" };
}

// --- cases ----------------------------------------------------------------
const cases = {
  // Boot -> exact-peer handshake -> READY, with epoch issuance and heartbeat.
  async handshake() {
    mountIsolated();
    const supervisor = buildSupervisor();
    supervisor.boot();
    const acc = await acceptWithRetry(supervisor);
    check("gate connection accepted", () => assert.equal(typeof acc.fd, "number", `accept failed: ${acc.err}`));
    if (typeof acc.fd !== "number") return;
    supervisor.attachConnection(acc.fd);

    const openLine = await waitGateLine((l) => l.startsWith("OPEN") || l.startsWith("ERR"));
    check("session.open issues a gw_ epoch and connected_not_ready", () => {
      const [tag, epoch, st] = openLine.split(" ");
      assert.equal(tag, "OPEN", `open failed: ${openLine}`);
      assert.match(epoch, /^gw_[0-9a-f]{32}$/);
      assert.equal(st, "connected_not_ready");
    });
    const readyLine = await waitGateLine((l) => l.startsWith("READY") || l.startsWith("ERR"));
    check("session.ready reaches ready", () => assert.equal(readyLine.split(" ")[1], "ready", `ready failed: ${readyLine}`));
    const hbLine = await waitGateLine((l) => l.startsWith("HB") || l.startsWith("ERR"));
    check("heartbeat returns a monotonic serviceSeq", () => {
      const [tag, seq] = hbLine.split(" ");
      assert.equal(tag, "HB", `heartbeat failed: ${hbLine}`);
      assert.ok(Number.isInteger(Number(seq)) && Number(seq) >= 1);
    });
    await waitGateLine((l) => l === "DONE" || l.startsWith("ERR"));
    check("supervisor reached READY", () => assert.equal(supervisor.getState(), supervisor.STATES.READY));
    if (currentGate) currentGate.kill("SIGKILL");
  },

  // Gate loss revokes the epoch and a replacement gate (new epoch) is accepted
  // without restarting the process — the fix for the gate-fd latch defect.
  async gate_replacement() {
    mountIsolated();
    const supervisor = buildSupervisor();
    supervisor.boot();
    let acc = await acceptWithRetry(supervisor);
    if (typeof acc.fd !== "number") { check("first accept", () => assert.fail(`accept failed: ${acc.err}`)); return; }
    supervisor.attachConnection(acc.fd);
    await waitGateLine((l) => l === "DONE" || l.startsWith("ERR"));
    const firstEpoch = (gateLines.find((l) => l.startsWith("OPEN")) || "").split(" ")[1];
    check("first handshake reached READY", () => assert.equal(supervisor.getState(), supervisor.STATES.READY));

    // Gate loss.
    currentGate.kill("SIGKILL");
    await delay(200);
    check("gate loss clears the active connection", () => assert.equal(supervisor.getConnection(), null));

    // Replacement gate, new epoch, accepted without a process restart.
    supervisor.startGate();
    acc = await acceptWithRetry(supervisor);
    check("replacement gate accepted after revoke", () => assert.equal(typeof acc.fd, "number", `accept failed: ${acc.err}`));
    if (typeof acc.fd !== "number") return;
    supervisor.attachConnection(acc.fd);
    await waitGateLine((l) => l === "DONE" || l.startsWith("ERR"));
    const secondEpoch = (gateLines.find((l) => l.startsWith("OPEN")) || "").split(" ")[1];
    check("replacement handshake issued a fresh epoch", () => {
      assert.match(secondEpoch || "", /^gw_[0-9a-f]{32}$/);
      assert.notEqual(secondEpoch, firstEpoch);
    });
    check("supervisor is READY again after replacement", () => assert.equal(supervisor.getState(), supervisor.STATES.READY));
    if (currentGate) currentGate.kill("SIGKILL");
  },
};

async function main() {
  const name = process.argv[2] || process.env.MAINT_CASE;
  if (!name || !cases[name]) {
    process.stdout.write(`unknown case: ${name}\navailable: ${Object.keys(cases).join(", ")}\n`);
    process.exit(2);
  }
  process.stdout.write(`CASE ${name}\n`);
  await cases[name]();
  process.stdout.write(`CASE ${name}: ${failures === 0 ? "PASS" : "FAIL"} (${passed} ok, ${failures} failed)\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  process.stdout.write(`HARNESS ERROR: ${error && error.stack}\n`);
  process.exit(3);
});
