"use strict";

// Dormant Foundation-B candidate: the §6 method-dispatch composition root
// (BUILD-PLAN Phase 1f, increment 5.2b — the routing layer between the framed
// socket and the handlers). Three pieces:
//
//   1. METHOD_TABLE — the exact callable method table from
//      ROOT-SERVICE-IPC-CONTRACT.md §6 as a frozen declarative map:
//      method -> { auth: P|C|R|O, retry: M|Q }. Cross-checked at module load
//      against the protocol's METHOD_DEADLINES key set, so any drift between
//      the contract validator and this router is a build failure, never a
//      runtime surprise. `stop.engage` is C-class with a conditional escalation
//      to O when reasonCode is `operator_stop` (exactly the §6 row).
//
//   2. createSessionAuthorizer — the §5 auth-class gate over an injected live
//      session view. Handed to the protocol as `context.authorizeMethod`, which
//      validateRequest runs AFTER the idempotent-replay decision (a committed
//      reply still returns, per the §3 retry law) and BEFORE operator-proof
//      consumption — a denied request never burns a one-use proof.
//
//   3. createMethodDispatcher — validateRequest -> auth gate -> fixed handler
//      -> exact response envelope -> validateResponse -> (M-class) durable
//      idempotency record BEFORE the reply. Fail-closed: an off-contract
//      handler result never claims success; a failed idempotency write returns
//      STORE_UNAVAILABLE; peer/protocol-level violations close the connection
//      (§2). The dispatcher never mutates session state — handlers own their
//      transitions; this layer only routes, gates, and validates.
//
// DORMANT: not wired into entrypoint.sh/start.sh/gate.js; the real socket
// transport and the compiled handler set are injected at the gated 1f cutover.

const {
  METHOD_DEADLINES,
  ProtocolError,
  validateRequest,
  validateResponse,
  responseContextForRequest,
} = require("./maintenance-protocol.js");

// ---- §6 exact callable method table -----------------------------------------

const METHOD_TABLE = Object.freeze({
  "session.open": Object.freeze({ auth: "P", retry: "M" }),
  "session.ready": Object.freeze({ auth: "C", retry: "M" }),
  "session.heartbeat": Object.freeze({ auth: "C", retry: "Q" }),
  "session.drain": Object.freeze({ auth: "C", retry: "M" }),
  "service.health": Object.freeze({ auth: "C", retry: "Q" }),
  "operator.action.begin": Object.freeze({ auth: "C", retry: "M" }),
  "claim.inspect": Object.freeze({ auth: "C", retry: "Q" }),
  "claim.transition": Object.freeze({ auth: "R", retry: "M" }),
  "claim.release": Object.freeze({ auth: "R", retry: "M" }),
  "recovery.request": Object.freeze({ auth: "C", retry: "M" }),
  "recovery.inspect": Object.freeze({ auth: "C", retry: "Q" }),
  "work.start": Object.freeze({ auth: "R", retry: "M" }),
  "work.inspect": Object.freeze({ auth: "C", retry: "Q" }),
  "work.output.read": Object.freeze({ auth: "C", retry: "Q" }),
  "work.cancel": Object.freeze({ auth: "O", retry: "M" }),
  "run.accept": Object.freeze({ auth: "R", retry: "M" }),
  "run.transition": Object.freeze({ auth: "R", retry: "M" }),
  "run.get": Object.freeze({ auth: "C", retry: "Q" }),
  "run.list": Object.freeze({ auth: "C", retry: "Q" }),
  "run.events": Object.freeze({ auth: "C", retry: "Q" }),
  "stop.get": Object.freeze({ auth: "C", retry: "Q" }),
  "stop.engage": Object.freeze({ auth: "C", retry: "M" }), // O when reasonCode is operator_stop (§6)
  "stop.resume": Object.freeze({ auth: "O", retry: "M" }),
  "budget.policy.get": Object.freeze({ auth: "C", retry: "Q" }),
  "budget.policy.set": Object.freeze({ auth: "O", retry: "M" }),
  "budget.inspect": Object.freeze({ auth: "C", retry: "Q" }),
  "audit.append": Object.freeze({ auth: "R", retry: "M" }),
  "audit.read": Object.freeze({ auth: "C", retry: "Q" }),
});

// Build-time drift check: this table and the protocol validator must agree on
// the EXACT method set. A method known to one and not the other is a build
// failure, never a runtime fallback.
{
  const table = Object.keys(METHOD_TABLE).sort();
  const protocolMethods = Object.keys(METHOD_DEADLINES).sort();
  if (table.length !== protocolMethods.length || table.some((m, i) => m !== protocolMethods[i])) {
    throw new Error("maintenance-method-dispatch: METHOD_TABLE has drifted from the protocol method set");
  }
  for (const [method, row] of Object.entries(METHOD_TABLE)) {
    if (!["P", "C", "R", "O"].includes(row.auth) || !["M", "Q"].includes(row.retry)) {
      throw new Error(`maintenance-method-dispatch: invalid table row for ${method}`);
    }
  }
}

// The effective §5 auth class of a validated request. Exactly one method is
// conditional: stop.engage escalates C -> O for operator_stop (§6 row).
function authClassForRequest(request) {
  const row = METHOD_TABLE[request.method];
  if (request.method === "stop.engage" && request.params.reasonCode === "operator_stop") return "O";
  return row.auth;
}

// ---- §5 auth-class session gate ----------------------------------------------

const SESSION_STATES = new Set(["pre_session", "connected", "ready", "draining"]);

function fail(code, message) { throw new ProtocolError(code, message); }

// createSessionAuthorizer({ session }) -> authorizeMethod(request)
//   session is a LIVE view owned by the composition root:
//     { state(): "pre_session"|"connected"|"ready"|"draining",
//       storesHealthy(): boolean, globalQuarantine(): boolean }
// The returned function is handed to the protocol as context.authorizeMethod.
// It throws ProtocolError to deny; it never mutates the session.
function createSessionAuthorizer({ session } = {}) {
  if (!session || typeof session.state !== "function" ||
      typeof session.storesHealthy !== "function" || typeof session.globalQuarantine !== "function") {
    throw new Error("session authorizer requires session { state, storesHealthy, globalQuarantine }");
  }
  return function authorizeMethod(request) {
    const state = session.state();
    if (!SESSION_STATES.has(state)) fail("PROTOCOL_ERROR", "Session state is unknown; failing closed");
    const auth = authClassForRequest(request);
    if (auth === "P") {
      // §2.1: session.open is the first request, exactly once per connection.
      if (state !== "pre_session") fail("PROTOCOL_ERROR", "session.open is allowed exactly once, before the session is established");
      return;
    }
    if (state === "pre_session") fail("PROTOCOL_ERROR", "The first request on a connection must be session.open");
    if (auth === "C") return;
    // R (and O = R + proof): session READY, trusted stores healthy, no global
    // quarantine. Checked most-specific first so the deny code names the cause.
    if (state === "draining") fail("ALREADY_DRAINING", "The session is draining; new authority work is blocked");
    if (state !== "ready") fail("NOT_RECONCILED", "The session is not READY; no authority mutation before session.ready succeeds");
    if (!session.storesHealthy()) fail("STORE_UNAVAILABLE", "Trusted stores are not healthy; authority work is blocked");
    if (session.globalQuarantine()) fail("GLOBAL_QUARANTINE", "A global quarantine is in effect; authority work is blocked");
  };
}

// ---- dispatcher ----------------------------------------------------------------

// §2: peer, framing, and protocol violations close the connection and revoke
// the epoch instead of returning an addressed error response.
const CLOSE_CODES = new Set([
  "UNAUTHORIZED_PEER", "VERSION_MISMATCH", "PROTOCOL_ERROR", "FRAME_TOO_LARGE",
  "TRUNCATED_FRAME", "INFLIGHT_VIOLATION", "UNKNOWN_METHOD", "STALE_EPOCH",
]);

const EPOCH_RE = /^gw_[0-9a-f]{32}$/;
const REQUEST_ID_RE = /^req_[0-9a-f]{32}$/;

function clampText(value, fallback) {
  if (typeof value !== "string" || value.length === 0) return fallback;
  return value.length > 500 ? value.slice(0, 500) : value;
}

// createMethodDispatcher({ handlers, session, recordIdempotency, now })
//   handlers: EXACTLY one function per §6 method (missing or extra fails
//     construction — there is no METHOD_UNAVAILABLE runtime fallback).
//     handler(request, context) -> { data, summary? }.
//   session: live view for the §5 gate (see createSessionAuthorizer).
//   recordIdempotency(gatewayEpoch, requestId, { digest, response }): durable
//     root-owned write, called for M-class successes BEFORE the reply (§3).
//   now(): ms clock for serverTimeMs.
// dispatch(value, context) -> { action: "reply", response } (validated contract
// envelope, success or error) or { action: "close", code, message } (the
// transport must close the connection and revoke the epoch).
function createMethodDispatcher({ handlers, session, recordIdempotency, now } = {}) {
  if (!handlers || typeof handlers !== "object") throw new Error("method dispatcher requires handlers");
  const expected = Object.keys(METHOD_TABLE).sort();
  const supplied = Object.keys(handlers).sort();
  if (expected.length !== supplied.length || expected.some((m, i) => m !== supplied[i]) ||
      expected.some((m) => typeof handlers[m] !== "function")) {
    throw new Error("method dispatcher requires exactly one handler function per §6 method");
  }
  const authorizeMethod = createSessionAuthorizer({ session });
  if (typeof recordIdempotency !== "function") throw new Error("method dispatcher requires recordIdempotency");
  if (typeof now !== "function") throw new Error("method dispatcher requires a now() clock");

  // A response can only be addressed if the request carried a well-formed
  // requestId and epoch; session.open failures always close (§6 row).
  function addressable(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    if (typeof value.method !== "string" || value.method === "session.open") return false;
    if (typeof value.requestId !== "string" || !REQUEST_ID_RE.test(value.requestId)) return false;
    if (typeof value.gatewayEpoch !== "string" || !EPOCH_RE.test(value.gatewayEpoch)) return false;
    return true;
  }

  function errorEnvelope(value, code, message) {
    const envelope = {
      v: 1,
      gatewayEpoch: value.gatewayEpoch,
      requestId: value.requestId,
      ok: false,
      status: "error",
      code,
      summary: clampText(message, "The request was denied."),
      rootCause: clampText(message, "The request was denied."),
      retry: { safe: code !== "IDEMPOTENCY_CONFLICT", afterMs: null },
      stopCondition: "Denied fail-closed; no state was changed.",
      nextActions: [],
      artifacts: [],
      data: {},
      serverTimeMs: now(),
    };
    // Responses are validated before being sent — including error responses;
    // validateResponse also enforces catalog membership of the code.
    return validateResponse(value.method, envelope, { requestId: value.requestId, gatewayEpoch: value.gatewayEpoch });
  }

  // Any failure becomes a fail-closed decision, never an unhandled PID-1 throw:
  // coded errors (ProtocolError or a store/handler error carrying a code) keep
  // their code and redaction-safe static message; an uncoded fault is masked as
  // INTERNAL_RESPONSE_INVALID with fixed text so nothing internal leaks.
  function deny(value, error) {
    const coded = error && typeof error.code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code);
    const code = coded ? error.code : "INTERNAL_RESPONSE_INVALID";
    const message = coded ? error.message : "An internal fault occurred; the request was denied";
    if (CLOSE_CODES.has(code) || !addressable(value)) {
      return Object.freeze({ action: "close", code, message });
    }
    try {
      return Object.freeze({ action: "reply", response: errorEnvelope(value, code, message) });
    } catch {
      return Object.freeze({ action: "close", code: "INTERNAL_RESPONSE_INVALID", message: "Failed to build a valid error response" });
    }
  }

  // Async: one handler (recovery.request) awaits the recovery driver; every
  // caller (the socket transport, the in-memory transport) already awaits the
  // dispatch result, so dispatch is uniformly a Promise.
  async function dispatch(value, context = {}) {
    // nowMs feeds operator-proof expiry checks inside validateRequest; tests
    // and the composition root may override it through context.
    const ctx = { nowMs: now(), ...context, authorizeMethod };
    let decision;
    try {
      decision = validateRequest(value, ctx);
    } catch (error) {
      return deny(value, error);
    }
    // §3 retry law: a committed same-ID same-digest request returns its stored
    // (already validated) response — even past the original deadline.
    if (decision.action === "replay") return Object.freeze({ action: "reply", response: decision.response });

    const request = decision.request;
    try {
      const result = await handlers[request.method](request, context);
      if (!result || typeof result !== "object" || Array.isArray(result) ||
          !result.data || typeof result.data !== "object" || Array.isArray(result.data)) {
        fail("INTERNAL_RESPONSE_INVALID", "Handler result must be { data, summary? }");
      }
      // session.open replies under the fresh epoch its handler minted; every
      // other method replies under the request's epoch (validateResponse then
      // enforces envelope/data epoch agreement).
      const gatewayEpoch = request.method === "session.open" ? result.data.gatewayEpoch : request.gatewayEpoch;
      const envelope = {
        v: 1,
        gatewayEpoch,
        requestId: request.requestId,
        ok: true,
        status: "success",
        code: "OK",
        summary: clampText(result.summary, "OK."),
        rootCause: null,
        retry: { safe: METHOD_TABLE[request.method].retry === "Q", afterMs: null },
        stopCondition: null,
        nextActions: [],
        artifacts: [],
        data: result.data,
        serverTimeMs: now(),
      };
      const response = validateResponse(request.method, envelope, responseContextForRequest(request, ctx));
      // §3: for every mutating request the canonical digest and exact response
      // are persisted under (gatewayEpoch, requestId) BEFORE replying. A failed
      // write must not claim success. Error responses are never recorded — they
      // performed no mutation, so a later identical retry may legitimately run.
      if (METHOD_TABLE[request.method].retry === "M") {
        try {
          recordIdempotency(request.gatewayEpoch, request.requestId, { digest: decision.digest, response });
        } catch {
          fail("STORE_UNAVAILABLE", "The idempotency record could not be committed; success is not claimed");
        }
      }
      return Object.freeze({ action: "reply", response });
    } catch (error) {
      return deny(value, error);
    }
  }

  return Object.freeze({ dispatch });
}

module.exports = { METHOD_TABLE, authClassForRequest, createSessionAuthorizer, createMethodDispatcher };
