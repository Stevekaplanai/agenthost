"use strict";

// Real-Linux activation harness (Phase 1f Step 4d): PID 1 serves the FULL
// Foundation-B authority over the actual SO_PEERCRED socket, and a `gate`-uid
// child drives the whole governed lane through it. This composes the pieces the
// pure-node tests prove separately (native accept + full service + socket
// transport) into the exact activation topology, on real Linux, as real root
// PID 1 in a private PID+mount+net namespace.
//
// Driven only by scripts/maintenance-boot-verify.sh. Wires nothing into any live
// boot path. Skips cleanly if it is not the authority context.

import cp from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTAINER = path.resolve(HERE, "..", "container");
const MOCK_GATE = path.join(HERE, "maintenance-mock-gate-full.cjs");
const ADDON = process.env.AGENTHOST_MAINTENANCE_NATIVE;

const out = (s) => process.stdout.write(s);
function skip(r) { out(`SKIP ${r}\n`); process.exit(0); }
if (!ADDON) skip("AGENTHOST_MAINTENANCE_NATIVE is not set");
if (process.getuid() !== 0) skip("harness requires root");
if (process.pid !== 1) skip("harness requires PID 1 (run under scripts/maintenance-boot-verify.sh)");

const native = require(ADDON);
const protocol = require(path.join(CONTAINER, "maintenance-protocol.js"));
const { MAINTENANCE_CONTRACT } = require(path.join(CONTAINER, "maintenance-contract.js"));
const { createMaintenanceStore } = require(path.join(CONTAINER, "maintenance-store.js"));
const { createMaintenanceSupervisor } = require(path.join(CONTAINER, "maintenance-supervisor.js"));
const { createProfileCatalog } = require(path.join(CONTAINER, "maintenance-profile-catalog.js"));
const { createFoundationBoot } = require(path.join(CONTAINER, "maintenance-boot.js"));
const { createAuthorityRunner } = require(path.join(CONTAINER, "maintenance-boot-main.js"));

const DATA = "/data", MAINT = "/data/maintenance";
const SOCKET = "/run/agenthost/maint.sock";
const OP_SESSION = "sha256:" + "c".repeat(64);
const REPO = "repo_" + "a".repeat(16);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(label, cond) { if (cond) out(`  ok   ${label}\n`); else { failures += 1; out(`  FAIL ${label}\n`); } }

// The compiled activation profile + re-frozen contract (profileCatalog bearing).
const PROFILE = {
  id: "profile_x", engine: "claude", argvTemplate: ["claude", "-p", "{objective}"],
  runKinds: ["board_task"], repos: [REPO], uid: 10001, gid: 10001, caps: [], supplementaryGroups: [],
  noNewPrivs: true, envAllowlist: ["HOME", "PATH"], credential: "CLAUDE_CODE_OAUTH_TOKEN",
  workspace: "workspaces/board", readOnlyMounts: ["/opt/agenthost"], writableMounts: ["workspaces/board"],
  network: "inference_only", limits: { maxTokenUnits: 1_000_000, maxCostMicros: 5_000_000, maxLifetimeMs: 3_600_000, maxOutputBytes: 1_048_576 },
};
const CATALOG = createProfileCatalog({ profiles: [PROFILE], profileBindingKey: protocol.profileBindingKey }).catalog;
const CONTRACT = Object.freeze({ ...MAINTENANCE_CONTRACT, profileCatalog: CATALOG });
const CONTRACT_DIGEST = protocol.contractDigest(CONTRACT);

function mountIsolated() {
  cp.execSync(`mount -t tmpfs tmpfs ${DATA}`); cp.execSync(`chmod 0755 ${DATA}`);
  cp.execSync("mount -t tmpfs tmpfs /run");
  fs.mkdirSync(MAINT); fs.chmodSync(MAINT, 0o700);
}

const gate = { uid: Number(cp.execSync("id -u gate").toString().trim()), gid: Number(cp.execSync("id -g gate").toString().trim()) };
let gateChild = null;
const gateLines = [];
function spawnGate() {
  const child = cp.spawn(process.execPath, [MOCK_GATE], {
    uid: gate.uid, gid: gate.gid, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, AGENTHOST_MAINT_SOCK: SOCKET, AGENTHOST_CONTRACT_DIGEST: CONTRACT_DIGEST, AGENTHOST_OP_SESSION: OP_SESSION, AGENTHOST_REPO: REPO },
  });
  gateChild = child;
  child.stdout.on("data", (d) => { for (const l of d.toString().split("\n")) if (l) gateLines.push(l); });
  child.stderr.on("data", (d) => out(`    [gate stderr] ${d}`));
  return child;
}

// A fresh full-authority service per connection, over the ROOT-OWNED native journal.
function makeService({ connectionId, operatorSessionDigest }) {
  return createFoundationBoot({
    native, protocol, contract: CONTRACT, policy: { policyVersion: 1, costLimitEnabled: true, costLimitMicros: 10_000_000 },
    structuralLimits: { maxExecs: 5, maxLifetimeMs: 3_600_000, maxTokenUnits: 1_000_000, maxHandoffs: 8, maxConsecutiveSamePair: 2, softStopPermille: 800 },
    profiles: [PROFILE], spawn: ({ workerRef }) => ({ childRef: "chld_" + workerRef.slice(4) }),
    recoveryDriver: { recover: () => ({ recovery: null, quarantined: false }) }, now: Date.now,
  }).service;
}

async function waitLine(prefix, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (gateLines.some((l) => l.startsWith(prefix))) return true; await delay(25); }
  return false;
}

async function main() {
  out("== Foundation B activation (root PID 1, isolated namespace) ==\n");
  mountIsolated();
  const supervisor = createMaintenanceSupervisor({
    native, protocol, createStore: (o) => createMaintenanceStore(o), contract: CONTRACT,
    spawnGate, makeService, operatorSessionDigest: OP_SESSION,
    log: (m) => process.env.MAINT_DEBUG && out(`    [sup] ${m}\n`),
  });
  const runner = createAuthorityRunner({ supervisor, pollMs: 15 });
  const runPromise = runner.run();

  check("gate opened a session (epoch minted)", await waitLine("OPEN"));
  check("stop.get reports first-secure engaged", gateLines.some((l) => l === "STOP true"));
  check("operator resume cleared STOP", await waitLine("RESUME false") || gateLines.some((l) => l === "RESUME false"));
  check("run.accept succeeded", await waitLine("ACCEPT"));
  check("work.start launched a running worker over the native socket", await waitLine("START running"));
  check("gate reached DONE", await waitLine("DONE"));
  if (gateLines.some((l) => l.startsWith("ERR"))) { failures += 1; out(`  FAIL gate error: ${gateLines.find((l) => l.startsWith("ERR"))}\n`); }

  runner.stop();
  try { gateChild && gateChild.kill("SIGKILL"); } catch { /* gone */ }
  await Promise.race([runPromise, delay(200)]);

  out(failures === 0
    ? "\nRESULT: PASS — PID 1 served the full Foundation-B authority over the real SO_PEERCRED socket.\n"
    : `\nRESULT: FAIL — ${failures} check(s) failed.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { out(`\nRESULT: FAIL — harness fault: ${e && e.stack || e}\n`); process.exit(1); });
