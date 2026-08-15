"use strict";

// Checklist harness (activation box-checklist item 4, the off-box half): the
// governed autonomous lane END TO END with REAL containment, on real Linux, as
// real root PID 1 in a private PID+mount+net namespace. This is
// maintenance-boot-authority.js upgraded from a fake spawn to the REAL worker
// runtime + the worker-event wiring boot-entry uses:
//
//   gate-uid child (production client + REAL lane module)
//     → run.accept → work.start
//     → PID 1 launches the stub engine in the REAL unshare jail (drop to uid
//       10001, tmpfs worktree, {objective} argv substitution)
//     → the engine's stdout streams through the runtime sinks into the spool
//     → work.output.read pages it back to the gate to eof
//     → the observed containment exit completes the worker (settle + terminal)
//     → the lane maps it to { ranClean: true, text }.
//
// Also probes the gate-uid 0600 sharp edge (checklist item 1). Driven only by
// scripts/maintenance-activation-checklist.sh. Wires nothing into any live boot.

import cp from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTAINER = path.resolve(HERE, "..", "container");
const MOCK_GATE = path.join(HERE, "maintenance-mock-gate-lane.cjs");
const ADDON = process.env.AGENTHOST_MAINTENANCE_NATIVE;

const out = (s) => process.stdout.write(s);
function skip(r) { out(`SKIP ${r}\n`); process.exit(0); }
if (!ADDON) skip("AGENTHOST_MAINTENANCE_NATIVE is not set");
if (process.getuid() !== 0) skip("harness requires root");
if (process.pid !== 1) skip("harness requires PID 1 (run under scripts/maintenance-activation-checklist.sh)");

const native = require(ADDON);
const protocol = require(path.join(CONTAINER, "maintenance-protocol.js"));
const { MAINTENANCE_CONTRACT } = require(path.join(CONTAINER, "maintenance-contract.js"));
const { createMaintenanceStore } = require(path.join(CONTAINER, "maintenance-store.js"));
const { createMaintenanceSupervisor } = require(path.join(CONTAINER, "maintenance-supervisor.js"));
const { createProfileCatalog } = require(path.join(CONTAINER, "maintenance-profile-catalog.js"));
const { createFoundationBoot } = require(path.join(CONTAINER, "maintenance-boot.js"));
const { createAuthorityRunner } = require(path.join(CONTAINER, "maintenance-boot-main.js"));
const { createWorkerRuntime } = require(path.join(CONTAINER, "maintenance-worker-runtime.js"));

const DATA = "/data", MAINT = "/data/maintenance";
const SOCKET = "/run/agenthost/maint.sock";
const OP_SESSION = "sha256:" + "c".repeat(64);
const REPO = "repo_" + "a".repeat(16);
const PROBE = "/data/probe-0600.secret";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(label, cond) { if (cond) out(`  ok   ${label}\n`); else { failures += 1; out(`  FAIL ${label}\n`); } }

// STUB ENGINE (in place of `claude -p <objective>`): echoes a marker + the
// delivered objective and exits 0 — enough to prove delivery, streaming, and
// clean completion through the REAL jail. §8 template shape is unchanged:
// {objective} is one argv element.
const PROFILE = {
  // Stub engine: echo the delivered objective, then live ~1s so PID 1's namespace-
  // init observation catches it (a real `claude -p` runs for seconds; a sub-25ms
  // process is the artifact, not the product). Exits 0 = clean completion.
  id: "profile_x", engine: "claude", argvTemplate: ["sh", "-c", 'echo "GOVERNED_OUT $1"; sleep 1', "sh", "{objective}"],
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
  fs.mkdirSync(path.join(MAINT, "work"), { recursive: true });
  // The agent-owned 0600 probe file (checklist item 1 sharp edge).
  const agentUid = Number(cp.execSync("id -u agent").toString().trim());
  fs.writeFileSync(PROBE, "secret\n", { mode: 0o600 });
  fs.chownSync(PROBE, agentUid, agentUid);
}

// REAL runtime + the exact worker-event dispatch boot-entry uses: the current
// connection's boot subscribes its spool + exit-completion as the live sinks.
const workerEvents = { current: null };
const runtime = createWorkerRuntime({
  profiles: { profile_x: { argv: [...PROFILE.argvTemplate], uid: PROFILE.uid, gid: PROFILE.gid, worktreeBase: path.join(MAINT, "work"), worktreeSizeMb: 16 } },
  observeTimeoutMs: 2000,
  onOutput: (workerRef, text) => { const s = workerEvents.current; if (s) s.onOutput(workerRef, text); },
  onExit: (workerRef, info) => { const s = workerEvents.current; if (s) s.onExit(workerRef, info); },
});

function makeService({ connectionId, operatorSessionDigest }) {
  return createFoundationBoot({
    native, protocol, contract: CONTRACT, policy: { policyVersion: 1, costLimitEnabled: true, costLimitMicros: 10_000_000 },
    structuralLimits: { maxExecs: 5, maxLifetimeMs: 3_600_000, maxTokenUnits: 1_000_000, maxHandoffs: 8, maxConsecutiveSamePair: 2, softStopPermille: 800 },
    profiles: [PROFILE], spawn: (args) => runtime.spawn(args),
    teardownWorker: (workerRef) => runtime.teardown(workerRef),
    verifyGone: (workerRef) => !runtime.alive(workerRef),
    subscribeWorkerEvents: (sinks) => { workerEvents.current = sinks; },
    now: Date.now,
  }).service;
}

const gate = { uid: Number(cp.execSync("id -u gate").toString().trim()), gid: Number(cp.execSync("id -g gate").toString().trim()) };
let gateChild = null;
const gateLines = [];
function spawnGate() {
  const child = cp.spawn(process.execPath, [MOCK_GATE], {
    uid: gate.uid, gid: gate.gid, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, AGENTHOST_MAINT_SOCK: SOCKET, AGENTHOST_CONTRACT_DIGEST: CONTRACT_DIGEST, AGENTHOST_OP_SESSION: OP_SESSION, AGENTHOST_REPO: REPO, AGENTHOST_PROBE_0600: PROBE },
  });
  gateChild = child;
  child.stdout.on("data", (d) => { for (const l of d.toString().split("\n")) if (l) gateLines.push(l); });
  child.stderr.on("data", (d) => out(`    [gate stderr] ${d}`));
  return child;
}

async function waitLine(prefix, ms = 20_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (gateLines.some((l) => l.startsWith(prefix))) return true; await delay(25); }
  return false;
}

async function main() {
  out("== governed lane END TO END: real containment + streaming + exit completion ==\n");
  mountIsolated();
  const supervisor = createMaintenanceSupervisor({
    native, protocol, createStore: (o) => createMaintenanceStore(o), contract: CONTRACT,
    spawnGate, makeService, operatorSessionDigest: OP_SESSION,
    log: (m) => process.env.MAINT_DEBUG && out(`    [sup] ${m}\n`),
  });
  const runner = createAuthorityRunner({ supervisor, pollMs: 15 });
  const runPromise = runner.run();

  check("gate opened a session (epoch minted)", await waitLine("OPEN"));
  check("operator resume cleared first-secure STOP", await waitLine("RESUME false"));
  check("the lane completed: ranClean=true, worker completed", await waitLine("LANE ranClean=true state=completed"));
  await waitLine("TEXT");
  const text = gateLines.find((l) => l.startsWith("TEXT")) || "";
  check("the jailed stub engine's output streamed back with the delivered objective",
    text.includes("GOVERNED_OUT") && text.includes("checklist objective"));
  check("gate-uid read of an agent-owned 0600 file is DENIED (identity split holds)", await waitLine("PROBE0600 denied EACCES"));
  check("gate reached DONE", await waitLine("DONE"));
  if (gateLines.some((l) => l.startsWith("ERR"))) { failures += 1; out(`  FAIL gate error: ${gateLines.find((l) => l.startsWith("ERR"))}\n`); }
  // Echo the lane's own report lines (diagnostics).
  for (const l of gateLines) if (/^(LANE|TEXT|PROBE0600)/.test(l)) out(`    [gate] ${l}\n`);

  runner.stop();
  try { gateChild && gateChild.kill("SIGKILL"); } catch { /* gone */ }
  await Promise.race([runPromise, delay(200)]);

  out(failures === 0
    ? "\nRESULT: PASS — governed run streamed real jailed output and completed through the exit-driven settle.\n"
    : `\nRESULT: FAIL — ${failures} check(s) failed.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { out(`\nRESULT: FAIL — harness fault: ${e && e.stack || e}\n`); process.exit(1); });
