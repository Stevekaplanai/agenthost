// Phase 1f Step 4d infrastructure: the framed socket transport, over a REAL unix
// stream socket. The gate-side authority client drives the full governed flow
// through createSocketTransport -> [socket] -> serveConnection -> the composition
// root and back — proving the wire (length-prefixed strict-JSON framing,
// one-in-flight, close-on-violation) end to end, not just the in-memory path.

import { test } from "node:test";
import assert from "node:assert/strict";
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
import clientMod from "../container/maintenance-authority-client.js";
import transportMod from "../container/maintenance-authority-transport.js";

const { createWorkService } = workServiceMod;
const { createFoundationService } = fsvcMod;
const { createAuthorityClient } = clientMod;
const { serveConnection, createSocketTransport } = transportMod;

const CONN = "conn-1";
const SESS = "sha256:" + "c".repeat(64);
const CLOCK = 1_000_000;
const REPO = "repo_" + "a".repeat(16);
const POLICY = { policyVersion: 1, costLimitEnabled: true, costLimitMicros: 10_000_000 };
const LIMITS = { maxExecs: 5, maxLifetimeMs: 3_600_000, maxTokenUnits: 1_000_000, maxHandoffs: 8, maxConsecutiveSamePair: 2, softStopPermille: 800 };
const CONTRACT_DIGEST = protocol.contractDigest(MAINTENANCE_CONTRACT);

function fakeNative() {
  const lines = [];
  return {
    readFoundationJournal: () => (lines.length ? Buffer.from(lines.join("\n") + "\n", "utf8") : null),
    appendFoundationJournalLine: (buf) => { const s = buf.toString("utf8"); if (!s) throw new Error("bad line"); lines.push(s); },
  };
}
function buildService() {
  const t = createTrustedStores({ native: fakeNative(), policy: { ...POLICY }, structuralLimits: LIMITS });
  const handles = protocol.createHandleRegistry();
  const workService = createWorkService({
    stopStore: t.stopStore, claimsStore: t.claimsStore, runsStore: t.runsStore, budgetStore: t.budgetStore, auditStore: t.auditStore,
    handles, spawn: ({ workerRef }) => ({ childRef: "chld_" + workerRef.slice(4) }), worstCaseFor: () => ({ tokenUnits: 100, costMicros: 2_000_000 }), now: () => CLOCK,
  });
  const operatorAuthority = createOperatorAuthority({ stopStore: t.stopStore, budgetStore: t.budgetStore, cancelWorker: workService.cancelWorker, now: () => CLOCK });
  return createFoundationService({
    stores: t, operatorAuthority, workService, outputSpool: createOutputSpool(), runEvents: createRunEventLedger({ now: () => CLOCK }),
    recoveryRequest: createRecoveryRequestHandler({ claimsStore: t.claimsStore, recoveryDriver: { recover: (target) => ({ recovery: t.recoveryStore.request({ claimRef: target.claimRef }), quarantined: false }) } }),
    handles, contract: MAINTENANCE_CONTRACT, protocol, structuralLimits: LIMITS,
    profileBindings: new Set([protocol.profileBindingKey("profile_x", "claude", "board_task", REPO)]),
    connectionId: CONN, operatorSessionDigest: SESS, now: () => CLOCK,
  });
}

// Bring up a listening unix socket that serves a fresh service per connection.
function withServer(run) {
  return new Promise((resolve, reject) => {
    const sockPath = path.join(os.tmpdir(), `maint-authtest-${process.pid}-${run.name || "t"}.sock`);
    const service = buildService();
    const server = net.createServer((socket) => serveConnection({ socket, service, protocol }));
    server.on("error", reject);
    server.listen(sockPath, () => {
      const clientSocket = net.connect(sockPath);
      clientSocket.on("connect", async () => {
        const transport = createSocketTransport({ socket: clientSocket, protocol });
        const client = createAuthorityClient({ transport, protocol, contractDigest: CONTRACT_DIGEST, operatorSessionDigest: SESS });
        try { await run(client); resolve(); }
        catch (e) { reject(e); }
        finally { clientSocket.destroy(); server.close(); }
      });
      clientSocket.on("error", reject);
    });
  });
}

const RUN = { id: "run_1", kind: "board_task", taskId: "task_1", chainId: "chain_1", profileId: "profile_x", repoId: REPO, workMode: "new", engines: ["claude"], summary: "", nextActions: [], artifacts: [] };
const START = { mode: "new", taskId: "task_1", runId: "run_1", chainId: "chain_1", engine: "claude", profileId: "profile_x", repoId: REPO, objective: "do it" };

test("handshake + governed lane round-trips over a REAL unix socket", async () => {
  await withServer(async (client) => {
    await client.connect();
    assert.match(client.currentEpoch(), /^gw_[0-9a-f]{32}$/);
    assert.equal((await client.getStop()).engaged, true);
    const resumed = await client.resumeStop(1);
    assert.equal(resumed.engaged, false);
    await client.acceptRun(RUN);
    const started = await client.startWork(START);
    assert.equal(started.worker.state, "running");
    const insp = await client.inspectWork(started.worker.ref);
    assert.equal(insp.worker.ref, started.worker.ref);
    const health = await client.health();
    assert.equal(health.contractDigest, CONTRACT_DIGEST);
  });
});

test("operator budget policy change round-trips over the socket", async () => {
  await withServer(async (client) => {
    await client.connect();
    const set = await client.setBudgetPolicy({ expectedVersion: 1, costLimitEnabled: true, costLimitMicros: 42_000_000 });
    assert.equal(set.costLimitMicros, 42_000_000);
  });
});
