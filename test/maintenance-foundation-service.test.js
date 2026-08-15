// Phase 1f Step 4a capstone: the composition root. Drives RAW framed requests
// through service.handle() — the exact path PID 1 will use behind the socket —
// exercising the full handshake and a realistic operator + work lifecycle across
// the assembled stores, dispatcher, operator authority, work service, spool, and
// run-event ledger. Every reply is a contract-valid envelope (the dispatcher runs
// the real validateResponse); a failing shape would surface as ok:false here.

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
const POLICY = { policyVersion: 1, costLimitEnabled: true, costLimitMicros: 10_000_000 };
const LIMITS = { maxExecs: 5, maxLifetimeMs: 3_600_000, maxTokenUnits: 1_000_000, maxHandoffs: 8, maxConsecutiveSamePair: 2, softStopPermille: 800 };
const CONTRACT_DIGEST = protocol.contractDigest(MAINTENANCE_CONTRACT);

function fakeNative() {
  const lines = [];
  return {
    readFoundationJournal: () => (lines.length ? Buffer.from(lines.join("\n") + "\n", "utf8") : null),
    appendFoundationJournalLine: (buf) => { const s = buf.toString("utf8"); if (!s || s.indexOf(String.fromCharCode(10)) !== -1 || s.indexOf(String.fromCharCode(0)) !== -1) throw new Error("bad line"); lines.push(s); },
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
  const recoveryDriver = { recover: (target) => ({ recovery: t.recoveryStore.request({ claimRef: target.claimRef }), quarantined: false }) };
  const REPO = "repo_" + "a".repeat(16);
  const profileBindings = new Set([protocol.profileBindingKey("profile_x", "claude", "board_task", REPO)]);
  const svc = createFoundationService({
    stores: t, operatorAuthority, workService, outputSpool: createOutputSpool(), runEvents: createRunEventLedger({ now: () => CLOCK }),
    recoveryRequest: createRecoveryRequestHandler({ claimsStore: t.claimsStore, recoveryDriver }),
    handles, contract: MAINTENANCE_CONTRACT, protocol, structuralLimits: LIMITS, profileBindings,
    connectionId: CONN, operatorSessionDigest: SESS, now: () => CLOCK,
  });
  return { svc, t };
}

let reqCounter = 0;
const rid = () => "req_" + String(reqCounter++).padStart(32, "0").replace(/[^0-9a-f]/g, "0");
function frame(method, params, { gatewayEpoch, deadlineMs = 5_000 } = {}) {
  return { v: 1, gatewayEpoch: gatewayEpoch ?? null, requestId: rid(), deadlineMs, method, params };
}
function ok(out, method) {
  assert.equal(out.action, "reply", `${method} should reply: ${JSON.stringify(out)}`);
  assert.equal(out.response.ok, true, `${method} should succeed: ${JSON.stringify(out.response)}`);
  return out.response;
}

test("full handshake + operator + work lifecycle round-trips through the composition root", async () => {
  const { svc } = setup();

  // 1. handshake
  const open = ok(await svc.handle(frame("session.open", { protocolVersion: 1, contractDigest: CONTRACT_DIGEST }, { deadlineMs: 2_000 })), "session.open");
  const gw = open.data.gatewayEpoch;
  assert.match(gw, /^gw_[0-9a-f]{32}$/);
  ok(await svc.handle(frame("session.ready", { contractDigest: CONTRACT_DIGEST }, { gatewayEpoch: gw })), "session.ready");
  const hb = ok(await svc.handle(frame("session.heartbeat", { lastServiceSeq: 0 }, { gatewayEpoch: gw, deadlineMs: 2_000 })), "session.heartbeat");
  assert.equal(hb.data.state, "ready");

  // 2. STOP boots engaged (first_secure) — operator-resume it via the proof path
  assert.equal(ok(await svc.handle(frame("stop.get", {}, { gatewayEpoch: gw, deadlineMs: 2_000 })), "stop.get").data.stop.engaged, true);
  const stopV = svc.handlers ? undefined : 0; // (state read below)
  const resumeTarget = { expectedStopVersion: 1 };
  const beginResume = ok(await svc.handle(frame("operator.action.begin", { action: "stop_resume", operatorSessionDigest: SESS, targetDigest: protocol.operatorTargetDigest(resumeTarget) }, { gatewayEpoch: gw })), "operator.action.begin");
  const resumed = ok(await svc.handle(frame("stop.resume", { expectedStopVersion: 1, operatorProof: beginResume.data.operatorProof }, { gatewayEpoch: gw })), "stop.resume");
  assert.equal(resumed.data.stop.engaged, false);

  // 3. accept a worker run, then launch a jailed worker
  const RUN = { id: "run_1", kind: "board_task", taskId: "task_1", chainId: "chain_1", profileId: "profile_x", repoId: "repo_aaaaaaaaaaaaaaaa", workMode: "new", engines: ["claude"], summary: "", nextActions: [], artifacts: [] };
  ok(await svc.handle(frame("run.accept", { run: RUN }, { gatewayEpoch: gw })), "run.accept");
  const started = ok(await svc.handle(frame("work.start", { mode: "new", taskId: "task_1", runId: "run_1", chainId: "chain_1", engine: "claude", profileId: "profile_x", repoId: "repo_aaaaaaaaaaaaaaaa", objective: "do it", claimHandle: null }, { gatewayEpoch: gw, deadlineMs: 10_000 })), "work.start");
  assert.equal(started.data.worker.state, "running");
  const workerRef = started.data.worker.ref;

  // 4. observe it (inspect), then operator-cancel it via a fresh proof
  const inspected = ok(await svc.handle(frame("work.inspect", { workerRef }, { gatewayEpoch: gw, deadlineMs: 2_000 })), "work.inspect");
  assert.equal(inspected.data.worker.ref, workerRef);
  const cancelTarget = { workerRef, expectedWorkerVersion: started.data.worker.version, reasonCode: "operator_cancel" };
  const beginCancel = ok(await svc.handle(frame("operator.action.begin", { action: "worker_cancel", operatorSessionDigest: SESS, targetDigest: protocol.operatorTargetDigest(cancelTarget) }, { gatewayEpoch: gw })), "operator.action.begin");
  const cancelled = ok(await svc.handle(frame("work.cancel", { workerHandle: started.data.workerHandle, expectedWorkerVersion: started.data.worker.version, reasonCode: "operator_cancel", operatorProof: beginCancel.data.operatorProof }, { gatewayEpoch: gw })), "work.cancel");
  assert.equal(cancelled.data.worker.state, "stopping");
});

test("reads round-trip: run.get / run.list / run.events / budget.* / audit / service.health", async () => {
  const { svc } = setup();
  const open = ok(await svc.handle(frame("session.open", { protocolVersion: 1, contractDigest: CONTRACT_DIGEST }, { deadlineMs: 2_000 })), "session.open");
  const gw = open.data.gatewayEpoch;
  ok(await svc.handle(frame("session.ready", { contractDigest: CONTRACT_DIGEST }, { gatewayEpoch: gw })), "session.ready");

  const RUN = { id: "run_1", kind: "board_task", taskId: "task_1", chainId: "chain_1", profileId: "profile_x", repoId: "repo_aaaaaaaaaaaaaaaa", workMode: "new", engines: ["claude"], summary: "", nextActions: [], artifacts: [] };
  ok(await svc.handle(frame("run.accept", { run: RUN }, { gatewayEpoch: gw })), "run.accept");

  assert.equal(ok(await svc.handle(frame("run.get", { runId: "run_1" }, { gatewayEpoch: gw, deadlineMs: 2_000 })), "run.get").data.run.id, "run_1");
  const list = ok(await svc.handle(frame("run.list", { view: "active", limit: 50, cursor: null }, { gatewayEpoch: gw, deadlineMs: 2_000 })), "run.list");
  assert.equal(list.data.runs.length, 1);
  const events = ok(await svc.handle(frame("run.events", { afterSeq: 0, limit: 200 }, { gatewayEpoch: gw, deadlineMs: 2_000 })), "run.events");
  assert.equal(events.data.events[0].eventCode, "accepted");

  const pol = ok(await svc.handle(frame("budget.policy.get", {}, { gatewayEpoch: gw, deadlineMs: 2_000 })), "budget.policy.get");
  assert.equal(pol.data.version, 1);
  const beginPol = ok(await svc.handle(frame("operator.action.begin", { action: "budget_policy_change", operatorSessionDigest: SESS, targetDigest: protocol.operatorTargetDigest({ expectedVersion: 1, costLimitEnabled: true, costLimitMicros: 25_000_000 }) }, { gatewayEpoch: gw })), "operator.action.begin");
  const setPol = ok(await svc.handle(frame("budget.policy.set", { expectedVersion: 1, costLimitEnabled: true, costLimitMicros: 25_000_000, operatorProof: beginPol.data.operatorProof }, { gatewayEpoch: gw })), "budget.policy.set");
  assert.equal(setPol.data.costLimitMicros, 25_000_000);
  ok(await svc.handle(frame("budget.inspect", { chainId: "chain_1" }, { gatewayEpoch: gw, deadlineMs: 2_000 })), "budget.inspect");

  ok(await svc.handle(frame("audit.append", { eventCode: "client_disconnected", severity: "info", runId: null, taskId: null, engine: null, detail: { surface: "chat" } }, { gatewayEpoch: gw })), "audit.append");
  const ar = ok(await svc.handle(frame("audit.read", { afterSeq: 0, limit: 200, source: null, severity: null, runId: null, taskId: null }, { gatewayEpoch: gw, deadlineMs: 2_000 })), "audit.read");
  assert.ok(ar.data.events.length >= 1);

  const health = ok(await svc.handle(frame("service.health", {}, { gatewayEpoch: gw, deadlineMs: 2_000 })), "service.health");
  assert.equal(health.data.contractDigest, CONTRACT_DIGEST);
});

test("the §5 gate holds: an R-class method before session.ready is NOT_RECONCILED", async () => {
  const { svc } = setup();
  const open = ok(await svc.handle(frame("session.open", { protocolVersion: 1, contractDigest: CONTRACT_DIGEST }, { deadlineMs: 2_000 })), "session.open");
  const gw = open.data.gatewayEpoch;
  const out = await svc.handle(frame("audit.append", { eventCode: "client_disconnected", severity: "info", runId: null, taskId: null, engine: null, detail: { surface: "chat" } }, { gatewayEpoch: gw }));
  assert.equal(out.action, "reply");
  assert.equal(out.response.code, "NOT_RECONCILED");
});

test("the first request must be session.open (a C-class call in pre_session closes)", async () => {
  const { svc } = setup();
  const out = await svc.handle(frame("stop.get", {}, { gatewayEpoch: "gw_" + "a".repeat(32), deadlineMs: 2_000 }));
  assert.equal(out.action, "close");
});
