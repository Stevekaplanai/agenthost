// Phase 1f Step 4b: the gate-side authority client, driven against the REAL
// composition root (maintenance-foundation-service) over an in-memory transport
// that calls its handle() directly. This proves the client builds valid
// envelopes, runs the handshake, holds the epoch, and drives the operator
// begin->proof->consume dance — exactly what gate.js's launch path will call.

import { test } from "node:test";
import assert from "node:assert/strict";
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

const { createWorkService } = workServiceMod;
const { createFoundationService } = fsvcMod;
const { createAuthorityClient, AuthorityClientError } = clientMod;

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

function setup() {
  const t = createTrustedStores({ native: fakeNative(), policy: { ...POLICY }, structuralLimits: LIMITS });
  const handles = protocol.createHandleRegistry();
  const workService = createWorkService({
    stopStore: t.stopStore, claimsStore: t.claimsStore, runsStore: t.runsStore, budgetStore: t.budgetStore, auditStore: t.auditStore,
    handles, spawn: ({ workerRef }) => ({ childRef: "chld_" + workerRef.slice(4) }),
    worstCaseFor: () => ({ tokenUnits: 100, costMicros: 2_000_000 }), now: () => CLOCK,
  });
  const operatorAuthority = createOperatorAuthority({ stopStore: t.stopStore, budgetStore: t.budgetStore, cancelWorker: workService.cancelWorker, now: () => CLOCK });
  const svc = createFoundationService({
    stores: t, operatorAuthority, workService, outputSpool: createOutputSpool(), runEvents: createRunEventLedger({ now: () => CLOCK }),
    recoveryRequest: createRecoveryRequestHandler({ claimsStore: t.claimsStore, recoveryDriver: { recover: (target) => ({ recovery: t.recoveryStore.request({ claimRef: target.claimRef }), quarantined: false }) } }),
    handles, contract: MAINTENANCE_CONTRACT, protocol, structuralLimits: LIMITS,
    profileBindings: new Set([protocol.profileBindingKey("profile_x", "claude", "board_task", REPO)]),
    connectionId: CONN, operatorSessionDigest: SESS, now: () => CLOCK,
  });
  const transport = { send: (request) => svc.handle(request) };
  const client = createAuthorityClient({ transport, protocol, contractDigest: CONTRACT_DIGEST, operatorSessionDigest: SESS, now: () => CLOCK });
  return { svc, client };
}

const RUN = { id: "run_1", kind: "board_task", taskId: "task_1", chainId: "chain_1", profileId: "profile_x", repoId: REPO, workMode: "new", engines: ["claude"], summary: "", nextActions: [], artifacts: [] };
const START = { mode: "new", taskId: "task_1", runId: "run_1", chainId: "chain_1", engine: "claude", profileId: "profile_x", repoId: REPO, objective: "do it" };

test("construction fails closed without transport / protocol / digest", () => {
  assert.throws(() => createAuthorityClient({ protocol, contractDigest: "x" }), /transport/);
  assert.throws(() => createAuthorityClient({ transport: { send() {} }, contractDigest: "x" }), /protocol/);
  assert.throws(() => createAuthorityClient({ transport: { send() {} }, protocol }), /contract digest/);
});

test("connect runs the version-locked handshake and holds the epoch", async () => {
  const { client } = setup();
  await client.connect();
  assert.match(client.currentEpoch(), /^gw_[0-9a-f]{32}$/);
  const hb = await client.heartbeat(0);
  assert.equal(hb.state, "ready");
});

test("full governed lane through the client: resume STOP, accept, start, inspect, cancel", async () => {
  const { client } = setup();
  await client.connect();
  assert.equal((await client.getStop()).engaged, true);
  const resumed = await client.resumeStop(1);
  assert.equal(resumed.engaged, false);
  await client.acceptRun(RUN);
  const started = await client.startWork(START);
  assert.equal(started.worker.state, "running");
  const insp = await client.inspectWork(started.worker.ref);
  assert.equal(insp.worker.ref, started.worker.ref);
  const cancelled = await client.cancelWorker({ workerHandle: started.workerHandle, workerRef: started.worker.ref, expectedWorkerVersion: started.worker.version });
  assert.equal(cancelled.state, "stopping");
});

test("operator budget policy change round-trips through begin->proof->consume", async () => {
  const { client } = setup();
  await client.connect();
  const set = await client.setBudgetPolicy({ expectedVersion: 1, costLimitEnabled: true, costLimitMicros: 30_000_000 });
  assert.equal(set.costLimitMicros, 30_000_000);
  assert.equal((await client.getBudgetPolicy()).version, 2);
});

test("a service-side denial surfaces as a coded client error (no proof for a bad target)", async () => {
  const { client } = setup();
  await client.connect();
  // resume with the wrong expected version -> STALE_VERSION from the store, or
  // proof/target mismatch fail-closed. Either way a coded AuthorityClientError.
  await assert.rejects(() => client.resumeStop(99), (e) => e instanceof AuthorityClientError);
});

test("a pre-open C-class call closes the connection (surfaced as an error)", async () => {
  const { client } = setup();
  await assert.rejects(() => client.getStop(), (e) => e instanceof AuthorityClientError);
});
