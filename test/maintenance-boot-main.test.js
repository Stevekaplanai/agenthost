// Phase 1f Step 4d: the root authority runner. Drives the boot→accept→serve→
// respawn loop with a FAKE native whose acceptVerifiedGate() hands over server
// ends of real unix socketpairs, and a real gate client on the other end. Proves
// PID 1's production loop serves the full authority AND re-accepts a replacement
// gate after loss — the native SO_PEERCRED accept itself is proven separately by
// scripts/maintenance-supervisor-verify.sh.

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
import bootMod from "../container/maintenance-boot-main.js";
import entryMod from "../container/maintenance-boot-entry.js";

const { createWorkService } = workServiceMod;
const { createFoundationService } = fsvcMod;
const { createMaintenanceSupervisor } = supMod;
const { createAuthorityRunner } = bootMod;
const { createMemoryPressureShutdown } = entryMod;

const SESS = "sha256:" + "c".repeat(64);
const CLOCK = 1_000_000;
const REPO = "repo_" + "a".repeat(16);
const POLICY = { policyVersion: 1, costLimitEnabled: true, costLimitMicros: 10_000_000 };
const LIMITS = { maxExecs: 5, maxLifetimeMs: 3_600_000, maxTokenUnits: 1_000_000, maxHandoffs: 8, maxConsecutiveSamePair: 2, softStopPermille: 800 };
const CONTRACT_DIGEST = protocol.contractDigest(MAINTENANCE_CONTRACT);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeJournal() { const l = []; return { readFoundationJournal: () => (l.length ? Buffer.from(l.join("\n") + "\n", "utf8") : null), appendFoundationJournalLine: (b) => { const s = b.toString("utf8"); if (!s) throw new Error("bad"); l.push(s); } }; }
function makeService({ connectionId, operatorSessionDigest }) {
  const j = fakeJournal();
  const t = createTrustedStores({ native: j, policy: { ...POLICY }, structuralLimits: LIMITS });
  const handles = protocol.createHandleRegistry();
  const ws = createWorkService({ stopStore: t.stopStore, claimsStore: t.claimsStore, runsStore: t.runsStore, budgetStore: t.budgetStore, auditStore: t.auditStore, handles, spawn: ({ workerRef }) => ({ childRef: "chld_" + workerRef.slice(4) }), worstCaseFor: () => ({ tokenUnits: 100, costMicros: 2_000_000 }), now: () => CLOCK });
  const oa = createOperatorAuthority({ stopStore: t.stopStore, budgetStore: t.budgetStore, cancelWorker: ws.cancelWorker, now: () => CLOCK });
  return createFoundationService({ stores: t, operatorAuthority: oa, workService: ws, outputSpool: createOutputSpool(), runEvents: createRunEventLedger({ now: () => CLOCK }), recoveryRequest: createRecoveryRequestHandler({ claimsStore: t.claimsStore, recoveryDriver: { recover: (g) => ({ recovery: t.recoveryStore.request({ claimRef: g.claimRef }), quarantined: false }) } }), handles, contract: MAINTENANCE_CONTRACT, protocol, structuralLimits: LIMITS, profileBindings: new Set([protocol.profileBindingKey("profile_x", "claude", "board_task", REPO)]), connectionId, operatorSessionDigest, now: () => CLOCK });
}

// A fake native: acceptVerifiedGate() returns queued server-side sockets (from a
// listening unix server fed by client connects); everything else is a noop.
function makeFakeNative() {
  const queue = [];
  return {
    _enqueue: (socket) => queue.push(socket),
    openTrustedStores() {}, readFoundationJournal: () => null, appendFoundationJournalLine() {}, appendQuarantineJournalLine() {},
    createAuthorityListener() {}, recordDirectGateChild() {}, revokeActiveGate() {},
    acceptVerifiedGate() { return queue.length ? queue.shift() : null; },
  };
}

test("the runner boots, serves the full authority, and re-accepts a replacement gate", async () => {
  const native = makeFakeNative();
  const sockPath = path.join(os.tmpdir(), `maint-runner-${process.pid}.sock`);
  // A listening server whose accepted server-sockets are fed to the fake native.
  const server = net.createServer((socket) => native._enqueue(socket));
  await new Promise((res) => server.listen(sockPath, res));

  const supervisor = createMaintenanceSupervisor({
    native, protocol, createStore: () => ({ open() {}, snapshot: () => ({}) }),
    contract: MAINTENANCE_CONTRACT, spawnGate: () => ({ pid: 4242, once() {}, kill() {} }),
    makeService, operatorSessionDigest: SESS,
  });
  const runner = createAuthorityRunner({ supervisor, pollMs: 5 });
  const runPromise = runner.run();

  async function oneGateSession() {
    const cs = net.connect(sockPath);
    await new Promise((res, rej) => { cs.once("connect", res); cs.once("error", rej); });
    const client = createAuthorityClient({ transport: createSocketTransport({ socket: cs, protocol }), protocol, contractDigest: CONTRACT_DIGEST, operatorSessionDigest: SESS });
    await client.connect();
    const epoch = client.currentEpoch();
    assert.match(epoch, /^gw_[0-9a-f]{32}$/);
    assert.equal((await client.getStop()).engaged, true);
    assert.equal((await client.resumeStop(1)).engaged, false);
    cs.destroy();
    await delay(30); // let the runner observe gate loss + respawn
    return epoch;
  }

  const e1 = await oneGateSession(); // first gate
  const e2 = await oneGateSession(); // replacement gate after loss
  assert.notEqual(e1, e2, "the replacement gate served a fresh epoch");

  runner.stop();
  await Promise.race([runPromise, delay(100)]);
  server.close();
});

test("construction fails closed without a usable supervisor", () => {
  assert.throws(() => createAuthorityRunner({ supervisor: {} }), /supervisor/);
});

test("a gate that exits before connecting is replaced promptly through the quarantined path", async () => {
  let replacementNeeded = false;
  let starts = 0;
  let releasePoll;
  const supervisor = {
    boot() { replacementNeeded = true; },
    acceptGate() { return null; },
    attachConnection() { throw new Error("must not attach"); },
    getConnection() { return null; },
    needsGateReplacement() { return replacementNeeded; },
    startGate() {
      starts += 1;
      replacementNeeded = false;
    },
  };
  const runner = createAuthorityRunner({
    supervisor,
    delay: () => new Promise((resolve) => { releasePoll = resolve; }),
  });
  const runPromise = runner.run();
  await Promise.resolve();
  assert.equal(starts, 1, "the runner does not wait forever for a dead gate to connect");
  runner.stop();
  if (releasePoll) releasePoll();
  await runPromise;
});

test("memory-pressure shutdown stops the real authority runner before gate loss can spawn a replacement", async () => {
  const events = [];
  let connection = null;
  let accepted = false;
  let releasePoll;
  let replacementStarts = 0;
  const supervisor = {
    boot() { events.push("boot"); },
    acceptGate() {
      if (accepted) return null;
      accepted = true;
      return { id: "gate-connection" };
    },
    attachConnection(next) {
      connection = next;
      events.push("attached");
    },
    getConnection() { return connection; },
    startGate() {
      replacementStarts += 1;
      events.push("replacement");
    },
  };
  const runner = createAuthorityRunner({
    supervisor,
    delay: () => new Promise((resolve) => { releasePoll = resolve; }),
  });
  const realStop = runner.stop;
  runner.stop = () => {
    events.push("runner.stop");
    realStop();
  };
  const runPromise = runner.run();
  await Promise.resolve();
  assert.equal(typeof releasePoll, "function", "the real runner reached its gate-loss wait");

  const gate = new EventEmitter();
  gate.exitCode = null;
  gate.signalCode = null;
  gate.kill = (signal) => {
    events.push(`gate.${signal}`);
    connection = null;
    gate.exitCode = 1;
    gate.emit("exit", 1, null);
    return true;
  };
  const exits = [];
  const shutdown = createMemoryPressureShutdown({
    runner,
    getGateChild: () => gate,
    exit: (code) => exits.push(code),
    setTimer: () => ({ unref() {} }),
    clearTimer: () => {},
  });

  shutdown();
  releasePoll();
  await Promise.race([
    runPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("authority runner did not stop")), 250)),
  ]);

  assert.ok(events.indexOf("runner.stop") < events.indexOf("gate.SIGUSR2"),
    "the runner is quiesced before the active gate is signalled");
  assert.equal(replacementStarts, 0, "gate loss after quiesce cannot enter the replacement branch");
  assert.deepEqual(exits, [1]);
});
