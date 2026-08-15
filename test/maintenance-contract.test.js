// Phase 1f increment 5.3: the frozen contract (Steve's D3 decision — freeze
// EXACTLY the implemented §6 method table). The GOLDEN DIGEST test below IS the
// freeze: any change to a method row, deadline, size cap, error catalog, or
// profile catalog turns it red, and a red golden test = a contract-v2 review,
// never a silent drift.

import { test } from "node:test";
import assert from "node:assert/strict";
import protocol from "../container/maintenance-protocol.js";
import contractMod from "../container/maintenance-contract.js";
import dispatchMod from "../container/maintenance-method-dispatch.js";

const { MAINTENANCE_CONTRACT, MAINTENANCE_CONTRACT_DIGEST } = contractMod;
const { METHOD_TABLE } = dispatchMod;

// ---- THE FREEZE ------------------------------------------------------------------
// Confirmed by Steve (D3, 2026-07-23). Changing the contract object in ANY way
// must change this value and therefore this test. That is the review gate.
// Re-frozen 2026-07-24: added SPAWN_FAILED to the error catalog so the launcher's
// proven-no-child path returns a clean fail-closed work.start error instead of
// tearing the authority connection (found running the activation checklist).
const GOLDEN_DIGEST = "sha256:d7e043487e2c5deed890836531cc6b1e95d095a4cb497994171357c96f88280a";

test("GOLDEN DIGEST: the compiled contract digest matches the frozen, reviewed value", () => {
  assert.equal(MAINTENANCE_CONTRACT_DIGEST, GOLDEN_DIGEST);
  assert.equal(protocol.contractDigest(MAINTENANCE_CONTRACT), GOLDEN_DIGEST, "recomputation is deterministic");
});

test("the contract carries exactly the five §3.1 digest-input fields", () => {
  assert.deepEqual(
    Object.keys(MAINTENANCE_CONTRACT).sort(),
    ["errorCatalog", "methodSchemas", "profileCatalog", "protocolVersion", "responseSchemas"],
  );
  assert.equal(MAINTENANCE_CONTRACT.protocolVersion, 1);
});

test("methodSchemas/responseSchemas cover exactly the implemented §6 method set", () => {
  const methods = Object.keys(protocol.METHOD_DEADLINES).sort();
  assert.deepEqual(Object.keys(MAINTENANCE_CONTRACT.methodSchemas).sort(), methods);
  assert.deepEqual(Object.keys(MAINTENANCE_CONTRACT.responseSchemas).sort(), methods);
  assert.equal(methods.length, 28);
});

test("every schema row is derived from (never drifts from) the enforcing tables", () => {
  for (const method of Object.keys(MAINTENANCE_CONTRACT.methodSchemas)) {
    const row = MAINTENANCE_CONTRACT.methodSchemas[method];
    assert.deepEqual(Object.keys(row).sort(), ["auth", "deadlineMs", "maxParamBytes", "retry"]);
    assert.equal(row.auth, METHOD_TABLE[method].auth, `${method} auth`);
    assert.equal(row.retry, METHOD_TABLE[method].retry, `${method} retry`);
    assert.equal(row.deadlineMs, protocol.METHOD_DEADLINES[method], `${method} deadline`);
    assert.equal(row.maxParamBytes, protocol.METHOD_PARAM_MAX_BYTES[method], `${method} param cap`);
    assert.deepEqual(MAINTENANCE_CONTRACT.responseSchemas[method], { maxResponseBytes: protocol.METHOD_RESPONSE_MAX_BYTES[method] }, `${method} response cap`);
  }
});

test("errorCatalog is the exact sorted implemented catalog", () => {
  assert.deepEqual(MAINTENANCE_CONTRACT.errorCatalog, [...protocol.ERROR_CODES].sort());
  assert.equal(MAINTENANCE_CONTRACT.errorCatalog.length, 42);
  // spot-pin the §6 fail-closed codes the dispatch layer depends on
  for (const code of ["NOT_RECONCILED", "OPERATOR_AUTH_REQUIRED", "OPERATOR_TARGET_MISMATCH", "GLOBAL_QUARANTINE", "IDEMPOTENCY_CONFLICT", "STORE_UNAVAILABLE"]) {
    assert.ok(MAINTENANCE_CONTRACT.errorCatalog.includes(code), code);
  }
});

test("profileCatalog is frozen EMPTY until activation compiles the §8 profiles", () => {
  assert.deepEqual(MAINTENANCE_CONTRACT.profileCatalog, []);
});

test("the contract object is deeply frozen", () => {
  assert.ok(Object.isFrozen(MAINTENANCE_CONTRACT));
  assert.ok(Object.isFrozen(MAINTENANCE_CONTRACT.methodSchemas));
  assert.ok(Object.isFrozen(MAINTENANCE_CONTRACT.methodSchemas["work.start"]));
  assert.ok(Object.isFrozen(MAINTENANCE_CONTRACT.errorCatalog));
  assert.ok(Object.isFrozen(MAINTENANCE_CONTRACT.profileCatalog));
  assert.throws(() => { MAINTENANCE_CONTRACT.methodSchemas["exec.shell"] = {}; }, TypeError);
});

// ---- handshake version-lock through the REAL protocol edge --------------------------

test("session.open accepts exactly the frozen digest and rejects any other", () => {
  const open = (contractDigest) => protocol.validateRequest(
    { v: 1, gatewayEpoch: null, requestId: "req_" + "b".repeat(32), deadlineMs: 2_000, method: "session.open", params: { protocolVersion: 1, contractDigest } },
    { expectedContractDigest: MAINTENANCE_CONTRACT_DIGEST, lookupIdempotency: () => null },
  );
  assert.equal(open(MAINTENANCE_CONTRACT_DIGEST).action, "execute");
  assert.throws(
    () => open("sha256:" + "f".repeat(64)),
    (e) => e.code === "VERSION_MISMATCH",
    "a peer holding any other contract is rejected at the handshake",
  );
});

test("a single-field mutation of the contract changes the digest (version-lock is total)", () => {
  const mutants = [
    (c) => { c.methodSchemas["stop.resume"].auth = "C"; },            // weaken an O-class row
    (c) => { c.methodSchemas["work.start"].maxParamBytes += 1; },     // nudge a size cap
    (c) => { c.errorCatalog.pop(); },                                 // drop an error code
    (c) => { c.profileCatalog.push({ profileId: "p" }); },            // add a profile
    (c) => { delete c.methodSchemas["audit.append"]; },               // remove a method
  ];
  for (const mutate of mutants) {
    const clone = JSON.parse(JSON.stringify(MAINTENANCE_CONTRACT));
    mutate(clone);
    assert.notEqual(protocol.contractDigest(clone), GOLDEN_DIGEST);
  }
});
