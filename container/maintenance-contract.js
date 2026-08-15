"use strict";

// The compiled, frozen Foundation-B contract object (BUILD-PLAN Phase 1f,
// increment 5.3 — Steve's D3 decision, 2026-07-23: freeze EXACTLY the
// implemented §6 method table; no aspirational rows).
//
// Its RFC-8785 (JCS) digest version-locks the session handshake: the supervisor
// returns this digest from session.open, and both session.open and
// session.ready reject any peer that does not present the exact same value.
// Changing ANYTHING here — a method row, a deadline, a size cap, an error code,
// a profile — changes the digest and therefore forces a coordinated
// gate+service redeploy. That is the design, not a hazard.
//
// The catalogs are DERIVED at require time from the implemented tables
// (maintenance-protocol.js + maintenance-method-dispatch.js), never duplicated
// as literals, so the contract object cannot drift from the code that enforces
// it. The freeze itself is pinned by the GOLDEN DIGEST test in
// test/maintenance-contract.test.js — any table change turns that test red,
// which is the review gate for a contract-v2.
//
// profileCatalog is frozen EMPTY: no §8 governed profile is implemented yet.
// Compiling the real profile catalog is an activation-time decision (engine
// binaries, uids, mounts, credentials — Steve's gate); adding the first profile
// produces a new digest, exactly the coordinated-redeploy the §8 rules demand.
//
// DORMANT: nothing in any boot path requires this module; the supervisor
// receives the contract by injection at the gated 1f cutover.

const {
  PROTOCOL_VERSION,
  ERROR_CODES,
  METHOD_DEADLINES,
  METHOD_PARAM_MAX_BYTES,
  METHOD_RESPONSE_MAX_BYTES,
  contractDigest,
} = require("./maintenance-protocol.js");
const { METHOD_TABLE } = require("./maintenance-method-dispatch.js");

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

// One schema row per implemented §6 method: auth class, retry class, deadline,
// and the exact byte caps the validator enforces. Methods sorted for a stable,
// human-diffable object (the digest is JCS and order-independent anyway).
const methodSchemas = {};
const responseSchemas = {};
for (const method of Object.keys(METHOD_TABLE).sort()) {
  methodSchemas[method] = {
    auth: METHOD_TABLE[method].auth,
    retry: METHOD_TABLE[method].retry,
    deadlineMs: METHOD_DEADLINES[method],
    maxParamBytes: METHOD_PARAM_MAX_BYTES[method],
  };
  responseSchemas[method] = {
    maxResponseBytes: METHOD_RESPONSE_MAX_BYTES[method],
  };
}

const MAINTENANCE_CONTRACT = deepFreeze({
  protocolVersion: PROTOCOL_VERSION,
  methodSchemas,
  responseSchemas,
  errorCatalog: [...ERROR_CODES].sort(),
  profileCatalog: [],
});

// The value session.open/session.ready pin. Computed once from the frozen
// object; the golden test asserts it against the reviewed literal.
const MAINTENANCE_CONTRACT_DIGEST = contractDigest(MAINTENANCE_CONTRACT);

module.exports = { MAINTENANCE_CONTRACT, MAINTENANCE_CONTRACT_DIGEST };
