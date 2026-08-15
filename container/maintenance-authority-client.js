"use strict";

// Dormant Foundation-B candidate: the gate-side authority client (BUILD-PLAN
// Phase 1f, Step 4b). This is the object gate.js uses to reach root PID 1: it
// runs the version-locked handshake, mints request ids, holds the gateway epoch,
// enforces one request in flight, and exposes the high-level operations the
// governed autonomous lane needs (accept a run, start/inspect/read/cancel a
// jailed worker, engage/resume STOP, set budget policy). Operator actions run the
// begin -> proof -> consume dance in one call, since the gate is the trusted
// operator-auth boundary.
//
// It speaks through an injected `transport` (the real one frames JSON over the
// SO_PEERCRED unix socket to PID 1; tests inject an in-memory transport that
// calls the foundation service's handle() directly). It performs NO authority
// itself — every decision is PID 1's; the client only builds valid envelopes and
// surfaces the validated replies or fail-closed errors.
//
// DORMANT: not imported by gate.js/start.sh/entrypoint.sh; the 4d boot edit wires
// gate.js's runAutonomousTask launch path through this client.

const crypto = require("node:crypto");

class AuthorityClientError extends Error {
  constructor(code, message) { super(message); this.name = "AuthorityClientError"; this.code = code; }
}

function createAuthorityClient({ transport, protocol, contractDigest, operatorSessionDigest = null, now = Date.now, randomBytes = crypto.randomBytes } = {}) {
  if (!transport || typeof transport.send !== "function") throw new Error("authority client requires a transport { send }");
  if (!protocol || typeof protocol.operatorTargetDigest !== "function") throw new Error("authority client requires the protocol module");
  if (typeof contractDigest !== "string") throw new Error("authority client requires the compiled contract digest");

  let gatewayEpoch = null;
  let inFlight = false;
  const requestId = () => "req_" + randomBytes(16).toString("hex");
  const deadlineFor = (method) => protocol.METHOD_DEADLINES[method];

  // Send one framed request and return its validated data, or throw fail-closed.
  async function call(method, params, { epoch = gatewayEpoch } = {}) {
    if (inFlight) throw new AuthorityClientError("INFLIGHT_VIOLATION", "one request in flight per connection");
    if (!Object.hasOwn(protocol.METHOD_DEADLINES, method)) throw new AuthorityClientError("UNKNOWN_METHOD", `unknown method ${method}`);
    const request = { v: 1, gatewayEpoch: method === "session.open" ? null : epoch, requestId: requestId(), deadlineMs: deadlineFor(method), method, params };
    inFlight = true;
    let out;
    try { out = await transport.send(request); }
    finally { inFlight = false; }
    if (!out || typeof out !== "object") throw new AuthorityClientError("PROTOCOL_ERROR", "transport returned no result");
    if (out.action === "close") throw new AuthorityClientError(out.code || "PROTOCOL_ERROR", `connection closed: ${out.code || "protocol"}`);
    const response = out.response;
    if (!response || typeof response !== "object") throw new AuthorityClientError("PROTOCOL_ERROR", "transport returned no response");
    if (response.ok !== true) throw new AuthorityClientError(response.code, response.summary || response.rootCause || "request failed");
    return response.data;
  }

  // Version-locked handshake (§2.1): open (epoch:null) then ready.
  async function open() {
    const data = await call("session.open", { protocolVersion: protocol.PROTOCOL_VERSION, contractDigest });
    if (data.contractDigest !== contractDigest) throw new AuthorityClientError("VERSION_MISMATCH", "service contract digest does not match");
    gatewayEpoch = data.gatewayEpoch;
    return data;
  }
  async function ready() { return call("session.ready", { contractDigest }); }
  async function connect() { await open(); return ready(); }
  async function heartbeat(lastServiceSeq = 0) { return call("session.heartbeat", { lastServiceSeq }); }
  async function drain(reasonCode) { return call("session.drain", { reasonCode }); }
  async function health() { return call("service.health", {}); }

  // Governed run + worker lane.
  async function acceptRun(run) { return (await call("run.accept", { run })).run; }
  async function startWork(params) { return call("work.start", { claimHandle: null, ...params }); }
  async function inspectWork(workerRef) { return call("work.inspect", { workerRef }); }
  async function readOutput(workerRef, afterSeq, limitBytes) { return call("work.output.read", { workerRef, afterSeq, limitBytes }); }
  async function getStop() { return (await call("stop.get", {})).stop; }
  async function getBudgetPolicy() { return call("budget.policy.get", {}); }
  async function inspectBudget(chainId) { return (await call("budget.inspect", { chainId })).budget; }
  async function listRuns(view, limit, cursor = null) { return call("run.list", { view, limit, cursor }); }
  async function readEvents(afterSeq, limit) { return call("run.events", { afterSeq, limit }); }
  async function appendAudit(params) { return (await call("audit.append", params)).event; }

  // Operator actions: the gate has already authenticated the human gesture; here
  // we request the one-use proof for the exact target, then consume it in the
  // same call. PID 1 rebinds and one-use-consumes the proof.
  async function beginProof(action, target) {
    if (typeof operatorSessionDigest !== "string") throw new AuthorityClientError("OPERATOR_AUTH_REQUIRED", "no authenticated operator session");
    const data = await call("operator.action.begin", { action, operatorSessionDigest, targetDigest: protocol.operatorTargetDigest(target) });
    return data.operatorProof;
  }
  async function engageStop({ expectedStopVersion, reasonCode, summary }) {
    if (reasonCode === "operator_stop") {
      const operatorProof = await beginProof("stop_engage", { expectedStopVersion, reasonCode, summary });
      return call("stop.engage", { expectedStopVersion, reasonCode, summary, operatorProof });
    }
    return call("stop.engage", { expectedStopVersion, reasonCode, summary, operatorProof: null });
  }
  async function resumeStop(expectedStopVersion) {
    const operatorProof = await beginProof("stop_resume", { expectedStopVersion });
    return (await call("stop.resume", { expectedStopVersion, operatorProof })).stop;
  }
  async function setBudgetPolicy({ expectedVersion, costLimitEnabled, costLimitMicros }) {
    const operatorProof = await beginProof("budget_policy_change", { expectedVersion, costLimitEnabled, costLimitMicros });
    return call("budget.policy.set", { expectedVersion, costLimitEnabled, costLimitMicros, operatorProof });
  }
  async function cancelWorker({ workerHandle, workerRef, expectedWorkerVersion }) {
    const operatorProof = await beginProof("worker_cancel", { workerRef, expectedWorkerVersion, reasonCode: "operator_cancel" });
    return (await call("work.cancel", { workerHandle, expectedWorkerVersion, reasonCode: "operator_cancel", operatorProof })).worker;
  }

  return Object.freeze({
    connect, open, ready, heartbeat, drain, health,
    acceptRun, startWork, inspectWork, readOutput, getStop, getBudgetPolicy, inspectBudget, listRuns, readEvents, appendAudit,
    engageStop, resumeStop, setBudgetPolicy, cancelWorker,
    currentEpoch: () => gatewayEpoch,
  });
}

module.exports = { createAuthorityClient, AuthorityClientError };
