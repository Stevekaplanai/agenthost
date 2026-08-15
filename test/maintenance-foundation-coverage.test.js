// Phase 1f Step 4a — coverage hardening for the composition root. The capstone
// test proves the headline flow; this drives the handlers that were wired but
// not yet exercised end-to-end (claim.transition/release, run.transition,
// recovery.request/inspect, work.output.read, run.list pagination, audit
// filtering) through service.handle() to catch wiring bugs before Hermes.

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

const { createWorkService } = workServiceMod;
const { createFoundationService } = fsvcMod;

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
    handles, spawn: ({ workerRef }) => ({ childRef: "chld_" + workerRef.slice(4) }), worstCaseFor: () => ({ tokenUnits: 100, costMicros: 2_000_000 }), now: () => CLOCK,
  });
  const operatorAuthority = createOperatorAuthority({ stopStore: t.stopStore, budgetStore: t.budgetStore, cancelWorker: workService.cancelWorker, now: () => CLOCK });
  const svc = createFoundationService({
    stores: t, operatorAuthority, workService, outputSpool: createOutputSpool(), runEvents: createRunEventLedger({ now: () => CLOCK }),
    recoveryRequest: createRecoveryRequestHandler({ claimsStore: t.claimsStore, recoveryDriver: { recover: (target) => ({ recovery: t.recoveryStore.request({ claimRef: target.claimRef }), quarantined: false }) } }),
    handles, contract: MAINTENANCE_CONTRACT, protocol, structuralLimits: LIMITS,
    profileBindings: new Set([protocol.profileBindingKey("profile_x", "claude", "board_task", REPO)]),
    connectionId: CONN, operatorSessionDigest: SESS, now: () => CLOCK,
  });
  return { svc, t };
}

let n = 0;
const rid = () => "req_" + String(n++).padStart(32, "0");
const frame = (method, params, gw, deadlineMs = 5_000) => ({ v: 1, gatewayEpoch: gw ?? null, requestId: rid(), deadlineMs, method, params });
function ok(out, m) { assert.equal(out.action, "reply", `${m}: ${JSON.stringify(out)}`); assert.equal(out.response.ok, true, `${m}: ${JSON.stringify(out.response)}`); return out.response; }
async function ready(svc) {
  const gw = ok(await svc.handle(frame("session.open", { protocolVersion: 1, contractDigest: CONTRACT_DIGEST }, null, 2_000)), "open").data.gatewayEpoch;
  ok(await svc.handle(frame("session.ready", { contractDigest: CONTRACT_DIGEST }, gw)), "ready");
  return gw;
}
const RUN = { id: "run_1", kind: "board_task", taskId: "task_1", chainId: "chain_1", profileId: "profile_x", repoId: REPO, workMode: "new", engines: ["claude"], summary: "", nextActions: [], artifacts: [] };
const START = { mode: "new", taskId: "task_1", runId: "run_1", chainId: "chain_1", engine: "claude", profileId: "profile_x", repoId: REPO, objective: "do it", claimHandle: null };

test("run.transition (gate matrix) round-trips and records a gate run event", async () => {
  const { svc } = setup();
  const gw = await ready(svc);
  ok(await svc.handle(frame("run.accept", { run: { ...RUN, kind: "board_task" } }, gw)), "run.accept");
  // gate parks queued -> waiting (a legal pre-launch worker-authority park)
  const t = ok(await svc.handle(frame("run.transition", { runId: "run_1", expectedVersion: 1, to: "waiting", summary: "parked", nextActions: [], artifacts: [] }, gw)), "run.transition");
  assert.equal(t.data.run.status, "waiting");
  const ev = ok(await svc.handle(frame("run.events", { afterSeq: 0, limit: 200 }, gw, 2_000)), "run.events");
  assert.deepEqual(ev.data.events.map((e) => e.eventCode), ["accepted", "gate_waiting"]);
});

test("claim lifecycle: work.start creates an active claim; claim.transition advances it by handle", async () => {
  const { svc } = setup();
  const gw = await ready(svc);
  ok(await svc.handle(frame("stop.resume", { expectedStopVersion: 1, operatorProof: await mintResume(svc, gw, 1) }, gw)), "resume");
  ok(await svc.handle(frame("run.accept", { run: RUN }, gw)), "run.accept");
  const started = ok(await svc.handle(frame("work.start", START, gw, 10_000)), "work.start");
  assert.equal(started.data.claim.state, "active");
  const tr = ok(await svc.handle(frame("claim.transition", { claimHandle: started.data.claimHandle, expectedVersion: started.data.claim.version, to: "awaiting_review", outcomeCode: "work_ready", resultDigest: "sha256:" + "a".repeat(64) }, gw)), "claim.transition");
  assert.equal(tr.data.claim.state, "awaiting_review");
});

test("recovery.request drives the injected driver and returns a recovery for the claim", async () => {
  const { svc, t } = setup();
  const gw = await ready(svc);
  ok(await svc.handle(frame("stop.resume", { expectedStopVersion: 1, operatorProof: await mintResume(svc, gw, 1) }, gw)), "resume");
  ok(await svc.handle(frame("run.accept", { run: RUN }, gw)), "run.accept");
  const started = ok(await svc.handle(frame("work.start", START, gw, 10_000)), "work.start");
  const claimRef = started.data.claim.ref;
  const rr = ok(await svc.handle(frame("recovery.request", { claimRef, expectedVersion: started.data.claim.version }, gw)), "recovery.request");
  assert.equal(rr.data.recovery.claimRef, claimRef);
  const ins = ok(await svc.handle(frame("recovery.inspect", { recoveryRef: rr.data.recovery.ref }, gw, 2_000)), "recovery.inspect");
  assert.equal(ins.data.recovery.ref, rr.data.recovery.ref);
});

test("work.output.read returns an empty, contract-valid page for a live worker with no output yet", async () => {
  const { svc } = setup();
  const gw = await ready(svc);
  ok(await svc.handle(frame("stop.resume", { expectedStopVersion: 1, operatorProof: await mintResume(svc, gw, 1) }, gw)), "resume");
  ok(await svc.handle(frame("run.accept", { run: RUN }, gw)), "run.accept");
  const started = ok(await svc.handle(frame("work.start", START, gw, 10_000)), "work.start");
  const page = ok(await svc.handle(frame("work.output.read", { workerRef: started.data.worker.ref, afterSeq: 0, limitBytes: 4096 }, gw, 2_000)), "work.output.read");
  assert.deepEqual(page.data.chunks, []);
  assert.equal(page.data.eof, false);
});

test("run.list paginates with a continuation cursor across two accepted runs", async () => {
  const { svc } = setup();
  const gw = await ready(svc);
  ok(await svc.handle(frame("run.accept", { run: RUN }, gw)), "run.accept");
  ok(await svc.handle(frame("run.accept", { run: { ...RUN, id: "run_2", taskId: "task_2", chainId: "chain_2" } }, gw)), "run.accept2");
  const p1 = ok(await svc.handle(frame("run.list", { view: "active", limit: 1, cursor: null }, gw, 2_000)), "run.list p1");
  assert.equal(p1.data.runs.length, 1);
  assert.equal(p1.data.hasMore, true);
  assert.match(p1.data.nextCursor, /^cur_/);
  const p2 = ok(await svc.handle(frame("run.list", { view: "active", limit: 1, cursor: p1.data.nextCursor }, gw, 2_000)), "run.list p2");
  assert.equal(p2.data.runs.length, 1);
  assert.equal(p2.data.hasMore, false);
  assert.notEqual(p1.data.runs[0].id, p2.data.runs[0].id);
});

test("audit.read filters by source and severity", async () => {
  const { svc } = setup();
  const gw = await ready(svc);
  ok(await svc.handle(frame("audit.append", { eventCode: "client_disconnected", severity: "info", runId: null, taskId: null, engine: null, detail: { surface: "chat" } }, gw)), "audit.append");
  const page = ok(await svc.handle(frame("audit.read", { afterSeq: 0, limit: 200, source: "gate", severity: "info", runId: null, taskId: null }, gw, 2_000)), "audit.read");
  assert.ok(page.data.events.every((e) => e.source === "gate" && e.severity === "info"));
});

// Mint a stop_resume proof through operator.action.begin (helper).
async function mintResume(svc, gw, expectedStopVersion) {
  const begin = ok(await svc.handle(frame("operator.action.begin", { action: "stop_resume", operatorSessionDigest: SESS, targetDigest: protocol.operatorTargetDigest({ expectedStopVersion }) }, gw)), "begin");
  return begin.data.operatorProof;
}
