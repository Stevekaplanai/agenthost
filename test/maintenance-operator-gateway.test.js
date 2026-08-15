"use strict";

// Proof #9 (dormant): the operator-auth issuer + one-use OperatorProof registry,
// exercised against the REAL compiled protocol verifier
// (maintenance-protocol.js validateRequest -> consumeOperatorProofForRequest ->
// operatorProof). We do not reimplement verification; we prove that a proof this
// module mints is accepted once by the protocol and correctly rejected on replay,
// expiry, target substitution, moved-action, and connection/epoch/session
// mismatch. stop.resume is the simplest O-class method (canonical target is just
// {expectedStopVersion}); the same registry serves all four.

import { test } from "node:test";
import assert from "node:assert/strict";
import protocol from "../container/maintenance-protocol.js";
import operatorGateway from "../container/maintenance-operator-gateway.js";

const { createOperatorProofRegistry, createOperatorGateway, OperatorGatewayError } = operatorGateway;

const EPOCH = "gw_" + "a".repeat(32);
const EPOCH2 = "gw_" + "e".repeat(32);
const REQ = (h) => "req_" + String(h).repeat(32).slice(0, 32);
const SESS = "sha256:" + "c".repeat(64);
const SESS2 = "sha256:" + "d".repeat(64);
const CONN = "conn-1";

function setup() {
  let clockMs = 1_000_000;
  const registry = createOperatorProofRegistry();
  const gateway = createOperatorGateway({ registry, now: () => clockMs });
  return {
    registry,
    gateway,
    advance: (ms) => { clockMs += ms; },
    nowMs: () => clockMs,
  };
}

// Run a stop.resume request through the real protocol validator.
function runStopResume(s, { expectedStopVersion, operatorProof, connectionId = CONN, gatewayEpoch = EPOCH, operatorSessionDigest = SESS, requestId = REQ("b") }) {
  const envelope = {
    v: 1,
    gatewayEpoch,
    requestId,
    deadlineMs: 5_000,
    method: "stop.resume",
    params: { expectedStopVersion, operatorProof },
  };
  const context = {
    gatewayEpoch,
    lookupIdempotency: () => null,
    nowMs: s.nowMs(),
    operatorProofRegistry: s.registry,
    connectionId,
    operatorSessionDigest,
  };
  return protocol.validateRequest(envelope, context);
}

function mintStopResume(s, { expectedStopVersion = 3, connectionId = CONN, gatewayEpoch = EPOCH, operatorSessionDigest = SESS } = {}) {
  const targetDigest = protocol.operatorTargetDigest({ expectedStopVersion });
  const { operatorProof } = s.gateway.beginOperatorAction({
    connectionId, gatewayEpoch, action: "stop_resume", operatorSessionDigest, targetDigest,
  });
  return operatorProof;
}

const codeOf = (err) => err && err.code;

test("happy path: a minted proof is accepted once, then consumed", () => {
  const s = setup();
  const proof = mintStopResume(s, { expectedStopVersion: 3 });
  assert.equal(s.registry.size(), 1);
  const result = runStopResume(s, { expectedStopVersion: 3, operatorProof: proof });
  assert.equal(result.action, "execute");
  assert.equal(s.registry.size(), 0, "proof is consumed on success (one-use)");
});

test("replay: reusing a consumed proof fails closed", () => {
  const s = setup();
  const proof = mintStopResume(s, { expectedStopVersion: 3 });
  runStopResume(s, { expectedStopVersion: 3, operatorProof: proof });
  assert.throws(
    () => runStopResume(s, { expectedStopVersion: 3, operatorProof: proof, requestId: REQ("f") }),
    (e) => codeOf(e) === "OPERATOR_AUTH_REQUIRED",
  );
});

test("target substitution: proof for v3 cannot authorize a v4 resume", () => {
  const s = setup();
  const proof = mintStopResume(s, { expectedStopVersion: 3 });
  assert.throws(
    () => runStopResume(s, { expectedStopVersion: 4, operatorProof: proof }),
    (e) => codeOf(e) === "OPERATOR_TARGET_MISMATCH",
  );
  assert.equal(s.registry.size(), 1, "a target mismatch is rejected before consumption");
});

test("expiry: a proof older than 30s fails closed", () => {
  const s = setup();
  const proof = mintStopResume(s, { expectedStopVersion: 3 });
  s.advance(30_001);
  assert.throws(
    () => runStopResume(s, { expectedStopVersion: 3, operatorProof: proof }),
    (e) => codeOf(e) === "OPERATOR_AUTH_REQUIRED",
  );
});

test("moved action: a stop_resume proof presented as budget_policy_change is rejected", () => {
  const s = setup();
  const proof = mintStopResume(s, { expectedStopVersion: 3 });
  const tampered = { ...proof, action: "budget_policy_change" };
  assert.throws(
    () => runStopResume(s, { expectedStopVersion: 3, operatorProof: tampered }),
    (e) => codeOf(e) === "OPERATOR_AUTH_REQUIRED",
  );
});

test("connection binding: a proof minted on one connection cannot be consumed on another", () => {
  const s = setup();
  const proof = mintStopResume(s, { expectedStopVersion: 3, connectionId: CONN });
  assert.throws(
    () => runStopResume(s, { expectedStopVersion: 3, operatorProof: proof, connectionId: "conn-2" }),
    (e) => codeOf(e) === "OPERATOR_AUTH_REQUIRED",
  );
});

test("epoch binding: a proof from a prior epoch cannot be consumed in a new epoch", () => {
  const s = setup();
  const proof = mintStopResume(s, { expectedStopVersion: 3, gatewayEpoch: EPOCH });
  assert.throws(
    () => runStopResume(s, { expectedStopVersion: 3, operatorProof: proof, gatewayEpoch: EPOCH2 }),
    (e) => codeOf(e) === "OPERATOR_AUTH_REQUIRED",
  );
});

test("operator session binding: a proof for one operator session is rejected under another", () => {
  const s = setup();
  const proof = mintStopResume(s, { expectedStopVersion: 3, operatorSessionDigest: SESS });
  assert.throws(
    () => runStopResume(s, { expectedStopVersion: 3, operatorProof: proof, operatorSessionDigest: SESS2 }),
    (e) => codeOf(e) === "OPERATOR_AUTH_REQUIRED",
  );
});

test("beginOperatorAction rejects an unknown action", () => {
  const s = setup();
  assert.throws(
    () => s.gateway.beginOperatorAction({ connectionId: CONN, gatewayEpoch: EPOCH, action: "delete_everything", operatorSessionDigest: SESS, targetDigest: protocol.operatorTargetDigest({ x: 1 }) }),
    (e) => e instanceof OperatorGatewayError && e.code === "ACTION_NOT_ALLOWED",
  );
  assert.equal(s.registry.size(), 0, "no proof is minted for a disallowed action");
});

test("beginOperatorAction rejects malformed digests / identity", () => {
  const s = setup();
  const good = protocol.operatorTargetDigest({ expectedStopVersion: 1 });
  assert.throws(() => s.gateway.beginOperatorAction({ connectionId: "", gatewayEpoch: EPOCH, action: "stop_resume", operatorSessionDigest: SESS, targetDigest: good }), (e) => e.code === "OPERATOR_AUTH_REQUIRED");
  assert.throws(() => s.gateway.beginOperatorAction({ connectionId: CONN, gatewayEpoch: EPOCH, action: "stop_resume", operatorSessionDigest: "not-a-digest", targetDigest: good }), (e) => e.code === "OPERATOR_AUTH_REQUIRED");
  assert.throws(() => s.gateway.beginOperatorAction({ connectionId: CONN, gatewayEpoch: EPOCH, action: "stop_resume", operatorSessionDigest: SESS, targetDigest: "nope" }), (e) => e.code === "OPERATOR_AUTH_REQUIRED");
});

test("registry: consume is one-use and null on unknown / mismatch", () => {
  const registry = createOperatorProofRegistry();
  const { actionHandle } = registry.issue({ connectionId: CONN, epoch: EPOCH, action: "stop_resume", targetDigest: protocol.operatorTargetDigest({ expectedStopVersion: 1 }), operatorSessionDigest: SESS, issuedAtMs: 1000 });
  assert.equal(registry.consume("op_missinghandlemissinghandle", { connectionId: CONN, epoch: EPOCH, kind: "operator_proof" }), null);
  const rec = registry.consume(actionHandle, { connectionId: CONN, epoch: EPOCH, kind: "operator_proof" });
  assert.ok(rec && Object.keys(rec).length === 5, "returns exactly the five-field record");
  assert.deepEqual(Object.keys(rec).sort(), ["action", "expiresAtMs", "issuedAtMs", "operatorSessionDigest", "targetDigest"]);
  assert.equal(registry.consume(actionHandle, { connectionId: CONN, epoch: EPOCH, kind: "operator_proof" }), null, "one-use: second consume is null");
});

test("registry: revokeConnection drops all of a connection's proofs", () => {
  const registry = createOperatorProofRegistry();
  registry.issue({ connectionId: CONN, epoch: EPOCH, action: "stop_resume", targetDigest: protocol.operatorTargetDigest({ a: 1 }), operatorSessionDigest: SESS, issuedAtMs: 1 });
  registry.issue({ connectionId: CONN, epoch: EPOCH, action: "stop_engage", targetDigest: protocol.operatorTargetDigest({ b: 2 }), operatorSessionDigest: SESS, issuedAtMs: 1 });
  registry.issue({ connectionId: "other", epoch: EPOCH, action: "stop_resume", targetDigest: protocol.operatorTargetDigest({ c: 3 }), operatorSessionDigest: SESS, issuedAtMs: 1 });
  assert.equal(registry.size(), 3);
  assert.equal(registry.revokeConnection(CONN), 2);
  assert.equal(registry.size(), 1);
});
