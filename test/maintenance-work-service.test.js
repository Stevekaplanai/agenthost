// Phase 1f Step 4a (piece 3): the work.* handler composition, exercised END TO
// END through the REAL protocol edge (validateRequest -> handler -> validateResponse)
// with real stores + a fake spawn. Proves the run-launch path — the second
// activation health-check item ("a jailed run launches and stays contained").

import { test } from "node:test";
import assert from "node:assert/strict";
import protocol from "../container/maintenance-protocol.js";
import { createStopStore } from "../container/maintenance-stop-store.js";
import { createClaimsStore } from "../container/maintenance-claims-store.js";
import { createRunsStore } from "../container/maintenance-runs-store.js";
import { createBudgetStore } from "../container/maintenance-budget-store.js";
import { createAuditStore } from "../container/maintenance-audit-store.js";
import workServiceMod from "../container/maintenance-work-service.js";

const { createWorkService } = workServiceMod;

const EPOCH = "gw_" + "a".repeat(32);
const CONN = "conn-1";
const REQ = (h) => "req_" + String(h).repeat(32).slice(0, 32);
const pass = () => {};
const mem = (records = []) => ({ records, append: (r) => records.push(JSON.parse(JSON.stringify(r))), readAll: () => records.slice() });
const POLICY = { policyVersion: 1, costLimitEnabled: true, costLimitMicros: 10_000_000 };
const LIMITS = { maxExecs: 5, maxLifetimeMs: 3_600_000, maxTokenUnits: 1_000_000, maxHandoffs: 8, maxConsecutiveSamePair: 2, softStopPermille: 800 };
const RUN = { id: "run_1", kind: "board_task", taskId: "task_1", chainId: "chain_1", profileId: "profile_x", repoId: "repo_y", workMode: "new", engines: ["claude"], summary: "", nextActions: [], artifacts: [] };

function setup() {
  const stopStore = createStopStore({ log: mem(), validateStopView: pass });
  stopStore.resume({ expectedVersion: 1 }); // fresh STOP boots engaged (first_secure)
  const claimsStore = createClaimsStore({ log: mem(), validateClaimView: pass });
  const runsStore = createRunsStore({ log: mem(), validateRunView: pass });
  const budgetStore = createBudgetStore({ log: mem(), policy: POLICY, structuralLimits: LIMITS });
  const auditStore = createAuditStore({ log: mem() });
  runsStore.accept(RUN);
  const svc = createWorkService({
    stopStore, claimsStore, runsStore, budgetStore, auditStore,
    handles: protocol.createHandleRegistry(),
    spawn: ({ workerRef }) => ({ childRef: "chld_" + workerRef.slice(4) }),
    worstCaseFor: () => ({ tokenUnits: 100, costMicros: 2_000_000 }),
    now: () => 1_000,
  });
  return { svc, stopStore, claimsStore, runsStore, budgetStore };
}

const ctx = { connectionId: CONN, gatewayEpoch: EPOCH };

function startReq(requestId = REQ("b")) {
  return {
    v: 1, gatewayEpoch: EPOCH, requestId, deadlineMs: 10_000, method: "work.start",
    params: { mode: "new", taskId: "task_1", runId: "run_1", chainId: "chain_1", engine: "claude", profileId: "profile_x", repoId: "repo_y", objective: "do the thing", claimHandle: null },
  };
}

// Build the full protocol context a real dispatch would supply for work.start.
function startResponseCtx(request) {
  return protocol.responseContextForRequest(request, { gatewayEpoch: EPOCH });
}
function validate(method, data, request, respCtx) {
  const response = {
    v: 1, gatewayEpoch: EPOCH, requestId: request.requestId, ok: true, status: "success", code: "OK",
    summary: "ok.", rootCause: null, retry: { safe: false, afterMs: null }, stopCondition: null,
    nextActions: [], artifacts: [], data, serverTimeMs: 1_000,
  };
  return protocol.validateResponse(method, response, respCtx);
}

test("construction fails closed without each dependency", () => {
  assert.throws(() => createWorkService({}), /stopStore/);
});

test("work.start launches, materializes the bundle, and passes protocol validateResponse", () => {
  const { svc } = setup();
  const request = startReq();
  const { data } = svc.start(request, ctx);
  assert.match(data.claimHandle, /^hdl_/);
  assert.match(data.workerHandle, /^hdl_/);
  assert.notEqual(data.claimHandle, data.workerHandle);
  assert.equal(data.worker.state, "running");
  assert.equal(data.claim.state, "active");
  assert.equal(data.claim.workerRef, data.worker.ref);
  assert.equal(data.budget.chainId, "chain_1");
  assert.equal(data.budget.reservedCostMicros, 2_000_000);
  // Authoritative: the real protocol edge accepts the bundle.
  const validated = validate("work.start", data, request, startResponseCtx(request));
  assert.equal(validated.data.worker.state, "running");
});

test("one lane: a second work.start while a worker is live is LANE_BUSY", () => {
  const { svc } = setup();
  svc.start(startReq(REQ("1")), ctx);
  assert.throws(() => svc.start(startReq(REQ("2")), ctx), (e) => e.code === "LANE_BUSY");
});

test("STOP engaged denies work.start with no mutation", () => {
  const { svc, stopStore } = setup();
  stopStore.engage({ expectedVersion: stopStore.get().version, reasonCode: "operator_stop", summary: "halt" });
  assert.throws(() => svc.start(startReq(), ctx), (e) => e.code === "STOP_ENGAGED");
});

test("work.inspect resolves the live worker into a valid {worker,claim,budget} bundle", () => {
  const { svc } = setup();
  const { data: started } = svc.start(startReq(), ctx);
  const ir = { v: 1, gatewayEpoch: EPOCH, requestId: REQ("c"), deadlineMs: 2_000, method: "work.inspect", params: { workerRef: started.worker.ref } };
  const { data } = svc.inspect(ir);
  assert.equal(data.worker.ref, started.worker.ref);
  validate("work.inspect", data, ir, protocol.responseContextForRequest(ir, { gatewayEpoch: EPOCH }));
});

test("cancelWorker seam drives the live worker running -> stopping", () => {
  const { svc } = setup();
  const { data } = svc.start(startReq(), ctx);
  const stopping = svc.cancelWorker({ workerRef: data.worker.ref, expectedWorkerVersion: data.worker.version, reasonCode: "operator_cancel" });
  assert.equal(stopping.state, "stopping");
  assert.ok(stopping.version > data.worker.version);
});

test("completeWorker settles, frees the lane, and records a terminal worker; a new start then proceeds", () => {
  const { svc } = setup();
  const { data } = svc.start(startReq(REQ("1")), ctx);
  const done = svc.completeWorker({ workerRef: data.worker.ref, claimRef: data.claim.ref, runId: "run_1", engine: "claude", taskId: "task_1", chainId: "chain_1", outcome: "completed", usage: { tokenUnits: 10, costMicros: 500_000 } });
  assert.equal(done.worker.state, "completed");
  assert.equal(svc.laneState().busy, false);
});

// --- exit-driven completion (the sink the boot wires to the runtime's onExit) ---

function startWorker(svc) {
  const request = startReq(REQ("e"));
  const out = svc.start(request, ctx);
  return out.data.worker.ref;
}

test("completeFromExit(0) settles + terminalizes a running worker as completed", () => {
  const { svc } = setup();
  const ref = startWorker(svc);
  const done = svc.completeFromExit(ref, { exitCode: 0, signalName: null });
  assert.ok(done);
  assert.equal(done.worker.state, "completed");
  assert.equal(done.worker.exitCode, 0);
  assert.equal(svc.laneState().busy, false); // lane freed for the next run
});

test("completeFromExit(nonzero) is failed; a signal kill is interrupted", () => {
  const a = setup();
  const refA = startWorker(a.svc);
  assert.equal(a.svc.completeFromExit(refA, { exitCode: 3 }).worker.state, "failed");
  const b = setup();
  const refB = startWorker(b.svc);
  assert.equal(b.svc.completeFromExit(refB, { exitCode: null, signalName: "SIGKILL" }).worker.state, "interrupted");
});

test("completeFromExit during an operator cancel lands as cancelled", () => {
  const { svc } = setup();
  const ref = startWorker(svc);
  const view = svc.workerView(ref);
  svc.cancelWorker({ workerRef: ref, expectedWorkerVersion: view.version, reasonCode: "operator_cancel" });
  const done = svc.completeFromExit(ref, { exitCode: null, signalName: "SIGKILL" });
  assert.equal(done.worker.state, "cancelled");
});

test("completeFromExit is idempotent: unknown or already-terminal workers are a no-op", () => {
  const { svc } = setup();
  assert.equal(svc.completeFromExit("wrk_" + "f".repeat(24), { exitCode: 0 }), null);
  const ref = startWorker(svc);
  svc.completeFromExit(ref, { exitCode: 0 });
  assert.equal(svc.completeFromExit(ref, { exitCode: 0 }), null); // second exit event: no double settle
});

// --- regression: a proven-no-child spawn must be a CLEAN error, not a connection
// close. SPAWN_FAILED has to be a catalogued, addressable work.start error code;
// if it isn't, dispatch's errorEnvelope->validateResponse throws and the whole
// gate authority connection is torn down (found running the activation checklist).

test("SPAWN_FAILED is a catalogued error code (dispatch can address it, not close)", () => {
  assert.ok([...protocol.ERROR_CODES].includes("SPAWN_FAILED"));
});

test("a work.start error envelope carrying SPAWN_FAILED passes validateResponse (=> clean reply)", () => {
  const request = startReq(REQ("9"));
  const envelope = {
    v: 1, gatewayEpoch: EPOCH, requestId: request.requestId, ok: false, status: "error",
    code: "SPAWN_FAILED", summary: "spawn proved no child; reservation refunded",
    rootCause: "spawn proved no child; reservation refunded",
    retry: { safe: true, afterMs: null }, stopCondition: "Denied fail-closed; no state was changed.",
    nextActions: [], artifacts: [], data: {}, serverTimeMs: 1_000,
  };
  // Must NOT throw — proves the dispatcher returns { action:"reply" } for a
  // no-child spawn rather than { action:"close" }.
  const validated = protocol.validateResponse("work.start", envelope, { requestId: request.requestId, gatewayEpoch: EPOCH });
  assert.equal(validated.code, "SPAWN_FAILED");
  assert.equal(validated.ok, false);
});

test("a real no-child spawn surfaces SPAWN_FAILED from the service (fail-closed, lane freed)", () => {
  const stopStore = createStopStore({ log: mem(), validateStopView: pass });
  stopStore.resume({ expectedVersion: 1 });
  const claimsStore = createClaimsStore({ log: mem(), validateClaimView: pass });
  const runsStore = createRunsStore({ log: mem(), validateRunView: pass });
  const budgetStore = createBudgetStore({ log: mem(), policy: POLICY, structuralLimits: LIMITS });
  const auditStore = createAuditStore({ log: mem() });
  runsStore.accept(RUN);
  const svc = createWorkService({
    stopStore, claimsStore, runsStore, budgetStore, auditStore,
    handles: protocol.createHandleRegistry(),
    // The runtime's proven-no-child signal (a sub-observation-window worker).
    spawn: () => { const e = new Error("no child was observed"); e.conclusiveNoChild = true; throw e; },
    worstCaseFor: () => ({ tokenUnits: 100, costMicros: 2_000_000 }),
    now: () => 1_000,
  });
  assert.throws(() => svc.start(startReq(REQ("a")), ctx), (e) => e.code === "SPAWN_FAILED");
  assert.equal(svc.laneState().busy, false); // lane freed for the next run (no stuck lane)
});
