// Phase 1f Step 4d: the supervisor↔foundation reconciliation. When the supervisor
// is given a `makeService` factory, PID 1 delegates the framed request loop for an
// accepted gate connection to a FRESH full-authority foundation service. This
// drives the gate client through the whole activation flow over a REAL socketpair
// handed to supervisor.attachConnection() — proving PID 1 serves the full
// 28-method authority, not just the Phase-1a session core. (native boot/accept is
// exercised separately by scripts/maintenance-supervisor-verify.sh.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import protocol from "../container/maintenance-protocol.js";
import { MAINTENANCE_CONTRACT } from "../container/maintenance-contract.js";
import { createTrustedStores } from "../container/maintenance-trusted-stores.js";
import { createOperatorAuthority } from "../container/maintenance-operator-authority.js";
import workServiceMod from "../container/maintenance-work-service.js";
import { createOutputSpool } from "../container/maintenance-output-spool.js";
import { createRunEventLedger } from "../container/maintenance-run-events.js";
import { createRecoveryRequestHandler } from "../container/maintenance-recovery-request.js";
import fsvcMod from "../container/maintenance-foundation-service.js";
import { createAuthorityClient } from "../container/maintenance-authority-client.js";
import { createSocketTransport } from "../container/maintenance-authority-transport.js";
import supMod from "../container/maintenance-supervisor.js";

const { createWorkService } = workServiceMod;
const { createFoundationService } = fsvcMod;
const { createMaintenanceSupervisor, createAgentLaneQuarantine } = supMod;

const SESS = "sha256:" + "c".repeat(64);
const CLOCK = 1_000_000;
const REPO = "repo_" + "a".repeat(16);
const POLICY = { policyVersion: 1, costLimitEnabled: true, costLimitMicros: 10_000_000 };
const LIMITS = { maxExecs: 5, maxLifetimeMs: 3_600_000, maxTokenUnits: 1_000_000, maxHandoffs: 8, maxConsecutiveSamePair: 2, softStopPermille: 800 };
const CONTRACT_DIGEST = protocol.contractDigest(MAINTENANCE_CONTRACT);

function fakeNative() {
  const lines = [];
  return { readFoundationJournal: () => (lines.length ? Buffer.from(lines.join("\n") + "\n", "utf8") : null), appendFoundationJournalLine: (b) => { const s = b.toString("utf8"); if (!s) throw new Error("bad"); lines.push(s); } };
}
// A fresh full-authority service per connection (each gate gets its own handshake).
function makeService({ connectionId, operatorSessionDigest }) {
  const t = createTrustedStores({ native: fakeNative(), policy: { ...POLICY }, structuralLimits: LIMITS });
  const handles = protocol.createHandleRegistry();
  const workService = createWorkService({ stopStore: t.stopStore, claimsStore: t.claimsStore, runsStore: t.runsStore, budgetStore: t.budgetStore, auditStore: t.auditStore, handles, spawn: ({ workerRef }) => ({ childRef: "chld_" + workerRef.slice(4) }), worstCaseFor: () => ({ tokenUnits: 100, costMicros: 2_000_000 }), now: () => CLOCK });
  const operatorAuthority = createOperatorAuthority({ stopStore: t.stopStore, budgetStore: t.budgetStore, cancelWorker: workService.cancelWorker, now: () => CLOCK });
  return createFoundationService({
    stores: t, operatorAuthority, workService, outputSpool: createOutputSpool(), runEvents: createRunEventLedger({ now: () => CLOCK }),
    recoveryRequest: createRecoveryRequestHandler({ claimsStore: t.claimsStore, recoveryDriver: { recover: (tg) => ({ recovery: t.recoveryStore.request({ claimRef: tg.claimRef }), quarantined: false }) } }),
    handles, contract: MAINTENANCE_CONTRACT, protocol, structuralLimits: LIMITS,
    profileBindings: new Set([protocol.profileBindingKey("profile_x", "claude", "board_task", REPO)]),
    connectionId, operatorSessionDigest, now: () => CLOCK,
  });
}

// Stub native for construction only (attachConnection never touches native).
const stubNative = { openTrustedStores() {}, readFoundationJournal: () => null, appendFoundationJournalLine() {}, appendQuarantineJournalLine() {}, createAuthorityListener() {}, recordDirectGateChild() {}, acceptVerifiedGate() { return null; }, revokeActiveGate() {} };

function withSupervisorConn(run) {
  return new Promise((resolve, reject) => {
    const sockPath = path.join(os.tmpdir(), `maint-sup-act-${process.pid}.sock`);
    const sup = createMaintenanceSupervisor({
      native: stubNative, protocol, createStore: () => ({ open() {}, snapshot: () => ({}) }),
      contract: MAINTENANCE_CONTRACT, spawnGate: () => ({ pid: 4242, once() {}, kill() {} }),
      makeService, operatorSessionDigest: SESS,
    });
    const server = net.createServer((socket) => { sup.attachConnection(socket); }); // PID 1 hands the verified socket to attach
    server.on("error", reject);
    server.listen(sockPath, () => {
      const cs = net.connect(sockPath);
      cs.on("connect", async () => {
        const client = createAuthorityClient({ transport: createSocketTransport({ socket: cs, protocol }), protocol, contractDigest: CONTRACT_DIGEST, operatorSessionDigest: SESS });
        try { await run(client, sup); resolve(); } catch (e) { reject(e); } finally { cs.destroy(); server.close(); }
      });
      cs.on("error", reject);
    });
  });
}

test("PID 1 delegates to a fresh foundation service and serves the full authority over the socket", async () => {
  await withSupervisorConn(async (client, sup) => {
    await client.connect();
    assert.match(client.currentEpoch(), /^gw_[0-9a-f]{32}$/);
    assert.equal(sup.getState(), "connected_not_ready", "supervisor tracks the delegated connection");
    // full governed flow served by PID 1's delegated service
    assert.equal((await client.getStop()).engaged, true);
    assert.equal((await client.resumeStop(1)).engaged, false);
    await client.acceptRun({ id: "run_1", kind: "board_task", taskId: "task_1", chainId: "chain_1", profileId: "profile_x", repoId: REPO, workMode: "new", engines: ["claude"], summary: "", nextActions: [], artifacts: [] });
    const started = await client.startWork({ mode: "new", taskId: "task_1", runId: "run_1", chainId: "chain_1", engine: "claude", profileId: "profile_x", repoId: REPO, objective: "go" });
    assert.equal(started.worker.state, "running");
  });
});

test("each connection gets a FRESH session: a replacement gate re-handshakes from pre_session", async () => {
  // Two sequential connections against the same supervisor must each open cleanly
  // (fresh epoch), proving makeService is per-connection (no stale session state).
  const epochs = [];
  for (let i = 0; i < 2; i += 1) {
    await withSupervisorConn(async (client) => { await client.connect(); epochs.push(client.currentEpoch()); });
  }
  assert.notEqual(epochs[0], epochs[1], "each gate connection mints its own epoch");
});

test("the root agent-lane latch is bounded, holds every reason separately, and exposes no unconditional clear", () => {
  const latch = createAgentLaneQuarantine({ maxReasonBytes: 24 });
  assert.equal(latch.isQuarantined(), false);
  assert.equal(latch.clear, undefined, "there is no verb that opens the lane without a proof");
  const first = latch.trip("first reason " + "x".repeat(100));
  const second = latch.trip("second reason");
  assert.equal(latch.isQuarantined(), true);
  assert.notEqual(second, first, "a second reason to stay closed is not swallowed by the first");
  assert.ok(Buffer.byteLength(first.reason, "utf8") <= 24);
  assert.deepEqual(latch.view(), first, "the oldest reason is the one reported");

  // Each latch releases only itself, and only for whoever holds it.
  assert.equal(latch.clearOnProof(first), true);
  assert.equal(latch.isQuarantined(), true, "the second reason still holds the lane shut");
  assert.deepEqual(latch.view(), second);
  assert.equal(latch.clearOnProof(first), false, "clearing is idempotent, never a second release");
  assert.equal(latch.clearOnProof(second), true);
  assert.equal(latch.isQuarantined(), false, "the lane reopens only when nothing is holding it");
});

test("gate exit before authority connection trips root and requests a quarantined replacement", () => {
  const latch = createAgentLaneQuarantine();
  const children = [];
  const spawnOptions = [];
  const sup = createMaintenanceSupervisor({
    native: stubNative, protocol, createStore: () => ({ open() {}, snapshot: () => ({}) }),
    contract: MAINTENANCE_CONTRACT,
    spawnGate: (options) => {
      spawnOptions.push(options);
      const child = new EventEmitter();
      child.pid = 5000 + children.length;
      child.kill = () => true;
      children.push(child);
      return child;
    },
    makeService, operatorSessionDigest: SESS, agentLaneQuarantine: latch,
  });
  sup.boot();
  children[0].emit("exit", 1, null);
  assert.equal(latch.isQuarantined(), true);
  assert.equal(sup.needsGateReplacement(), true);
  sup.startGate();
  assert.deepEqual(spawnOptions, [
    { agentLaneQuarantined: false },
    { agentLaneQuarantined: true },
  ]);
});
