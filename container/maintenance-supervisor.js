"use strict";

// Dormant Foundation-B candidate: the root PID-1 authority supervisor's
// connection + version-locked handshake core. It composes the already-proven
// native boundary (SO_PEERCRED-verified socket, trusted journal) with the
// protocol validator (framing, request/response validation, digests) and the
// Foundation-A store (migration/idempotency journal), and drives the boot ->
// handshake -> READY lifecycle plus epoch issuance and gate-loss revocation.
//
// It is DORMANT: nothing here is wired into entrypoint.sh, start.sh, gate.js,
// or the runtime image. It is exercised only by the real-Linux harness
// (test/maintenance-supervisor-authority.js) under scripts/, as a reviewed
// candidate. Foundation B activation remains separately gated (BUILD-PLAN 1f).
//
// Scope of THIS increment (Phase 1a core): boot to READY, the exact-peer
// connection, the session.open / session.ready / session.heartbeat handshake
// with service/gateway epoch issuance, and gate-loss revoke + replacement.
// Deliberately deferred to later phases (marked DEFERRED below): durable
// cross-restart idempotency preload and the full boot reconciliation of prior
// intents (Phase 1b/1c), and every non-session method (Phase 1c/1d).

const net = require("node:net");
const crypto = require("node:crypto");
const { serveConnection } = require("./maintenance-authority-transport.js");
const { createAgentLaneArbiter } = require("./maintenance-agent-lane.js");

// Authority-service lifecycle (ROOT-SERVICE-STATE-MACHINES §1), reduced to the
// states this Phase-1a core implements. Later phases fill BOOT_MIGRATING /
// BOOT_RECONCILING / DRAINING / RECONCILING_GATE_LOSS / BACKOFF with real work.
const STATES = Object.freeze({
  BOOT_VALIDATING: "boot_validating",
  SOCKET_LISTENING: "socket_listening",
  GATE_STARTING: "gate_starting",
  CONNECTED_NOT_READY: "connected_not_ready",
  READY: "ready",
  RECONCILING_GATE_LOSS: "reconciling_gate_loss",
  FATAL_EXIT: "fatal_exit",
});

const createAgentLaneQuarantine = createAgentLaneArbiter;

function hexEpoch(prefix, randomBytes) {
  const bytes = randomBytes(16);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 16) {
    throw new Error("epoch random source must return 16 bytes");
  }
  return `${prefix}_${bytes.toString("hex")}`;
}

// Build the store's trusted adapter from the root-owned native boundary. This
// is the seam that keeps the store filesystem-free: every durable operation
// goes through the PID-1-gated, no-follow native calls.
function nativeStoreAdapter(native) {
  return {
    assertTrusted: () => native.openTrustedStores(),
    readJournal: () => {
      const buffer = native.readFoundationJournal();
      return buffer === null ? null : buffer.toString("utf8");
    },
    appendJournal: (line) => native.appendFoundationJournalLine(Buffer.from(line, "utf8")),
    quarantine: (record) => native.appendQuarantineJournalLine(Buffer.from(JSON.stringify(record), "utf8")),
  };
}

function createMaintenanceSupervisor(deps) {
  const {
    native,
    protocol,
    createStore,
    contract, // frozen compiled contract object; its digest version-locks the handshake
    spawnGate, // () => ChildProcess: spawns exactly one direct `gate` child
    now = Date.now,
    randomBytes = crypto.randomBytes,
    log = () => {},
    // ACTIVATION seam (Phase 1f 4d). When provided, PID 1 delegates the framed
    // request loop for each accepted gate connection to a FRESH foundation
    // service (the full 28-method authority) via serveConnection, instead of the
    // Phase-1a inline session-only dispatch below. A fresh service per connection
    // gives each replacement gate its own pre_session→READY handshake + epoch.
    // Absent → unchanged Phase-1a behavior (the proven supervisor harness).
    makeService = null, // ({ connectionId, operatorSessionDigest }) => foundationService
    operatorSessionDigest = null, // the gate's authenticated operator session (set by PID 1)
    agentLaneQuarantine = createAgentLaneQuarantine(),
  } = deps;

  for (const [name, value] of Object.entries({ native, protocol, createStore, contract, spawnGate })) {
    if (!value) throw new Error(`maintenance supervisor requires ${name}`);
  }
  if (!agentLaneQuarantine || typeof agentLaneQuarantine.trip !== "function" || typeof agentLaneQuarantine.isQuarantined !== "function") {
    throw new Error("maintenance supervisor requires an agent-lane quarantine latch");
  }

  const contractDigest = protocol.contractDigest(contract);

  let state = STATES.BOOT_VALIDATING;
  let store = null;
  let gateChild = null;
  let connection = null; // { socket, decoder, connectionId, serviceEpoch, gatewayEpoch, ready, serviceSeq, idempotency }
  let serviceSeq = 0;
  let gateReplacementRequired = false;

  function setState(next) {
    state = next;
    log(`state -> ${next}`);
  }

  // --- idempotency adapter (protocol <-> supervisor) ----------------------
  // The protocol validator expects lookupIdempotency(epoch, requestId) to
  // return the stored { digest, response } record (or undefined). For the
  // Phase-1a handshake we key it in memory per live epoch; DEFERRED: preload
  // durable records from the store on boot and persist mutations through
  // store.commitIdempotency (Phase 1c, when mutating methods exist).
  // Idempotency key: (epoch, requestId) joined by a byte that cannot appear
  // in either token, matching the durable store's convention.
  const idempotencyKey = (epoch, requestId) => `${epoch}\u0000${requestId}`;

  function requestContext(conn) {
    const ctx = {
      expectedContractDigest: contractDigest,
      lookupIdempotency: (epoch, requestId) => {
        // The protocol treats a miss as strictly null (not undefined).
        if (epoch === null) return null; // session.open precedes any epoch
        return conn.idempotency.get(idempotencyKey(epoch, requestId)) ?? null;
      },
    };
    if (conn.gatewayEpoch) ctx.gatewayEpoch = conn.gatewayEpoch;
    return ctx;
  }

  function rememberIdempotency(conn, request, digest, response) {
    if (request.gatewayEpoch === null) return; // session.open is connection-scoped
    conn.idempotency.set(idempotencyKey(request.gatewayEpoch, request.requestId), { digest, response });
  }

  // --- boot ---------------------------------------------------------------
  function boot() {
    // BOOT_VALIDATING: trusted stores open and validate (native enforces root
    // PID 1 + no-follow owner/type/mode). DEFERRED: BOOT_MIGRATING and
    // BOOT_RECONCILING (Phase 1b) run here before the socket is created.
    setState(STATES.BOOT_VALIDATING);
    // The Phase-1a Foundation-A store validates the trusted boundary and serves
    // the inline session core. In the ACTIVATION path (makeService present) the
    // per-connection foundation service owns the trusted stores over the same
    // native journal, so opening a second store layer here would double-own it —
    // skip it and let the service be the sole store owner.
    if (!makeService) {
      store = createStore({ adapter: nativeStoreAdapter(native), now, redact: (s) => s });
      store.open();
    } else if (typeof native.openTrustedStores === "function") {
      // Still validate the root-owned trusted boundary (no-follow owner/type/mode)
      // — the foundation service then owns the journal it exposes.
      native.openTrustedStores();
    }

    // SOCKET_LISTENING: create the pathname socket with no permissive window.
    native.createAuthorityListener();
    setState(STATES.SOCKET_LISTENING);

    startGate();
  }

  function startGate() {
    // GATE_STARTING: spawn exactly one direct gate child and record its PID so
    // the native accept can bind the connection to this exact child.
    setState(STATES.GATE_STARTING);
    const child = spawnGate({ agentLaneQuarantined: agentLaneQuarantine.isQuarantined() });
    gateChild = child;
    gateReplacementRequired = false;
    native.recordDirectGateChild(child.pid);
    // Capture THIS child: a late exit from a superseded gate must test its own
    // pid, not whatever gateChild points at after a replacement is spawned.
    child.once("exit", () => {
      if (gateChild !== child) return;
      if (connection && connection.gatePid !== child.pid) return;
      reconcileGateLoss("process_exit");
    });
  }

  // Poll the non-blocking accept until the exact verified peer arrives. Returns
  // the accepted fd, or throws the native rejection.
  function acceptGate() {
    return native.acceptVerifiedGate();
  }

  // Attach the accepted descriptor and run the framed request loop. Production
  // passes the fd from native.acceptVerifiedGate(); tests may pass a ready socket.
  function attachConnection(fd) {
    const socket = typeof fd === "number" ? new net.Socket({ fd, readable: true, writable: true }) : fd;

    // ACTIVATION path: delegate the framed loop to a fresh foundation service
    // (the full authority). The service owns validate→gate→handlers→response +
    // its own session/epoch; PID 1 owns only the verified socket + gate
    // lifecycle. A socket close reconciles gate loss exactly as before.
    if (makeService) {
      const connectionId = `conn_${randomBytes(8).toString("hex")}`;
      const service = makeService({ connectionId, operatorSessionDigest });
      if (typeof service.attach === "function") service.attach({ connectionId, operatorSessionDigest });
      const conn = { socket, connectionId, gatePid: gateChild ? gateChild.pid : null, service };
      connection = conn;
      setState(STATES.CONNECTED_NOT_READY);
      serveConnection({ socket, service, protocol, now, onClose: () => { if (connection === conn) reconcileGateLoss("eof"); } });
      return conn;
    }

    const conn = {
      socket,
      connectionId: `conn_${randomBytes(8).toString("hex")}`,
      gatePid: gateChild ? gateChild.pid : null,
      serviceEpoch: null,
      gatewayEpoch: null,
      ready: false,
      lastServiceSeq: 0,
      idempotency: new Map(),
      decoder: null,
    };
    conn.decoder = new protocol.RequestFrameDecoder({
      onDeadline: () => closeConnection(conn, "handshake_deadline"),
      now,
    });
    connection = conn;
    setState(STATES.CONNECTED_NOT_READY);

    socket.on("data", (chunk) => {
      let request;
      try {
        request = conn.decoder.push(chunk);
      } catch (error) {
        return closeConnection(conn, `protocol:${error.code || "error"}`);
      }
      if (request) dispatch(conn, request);
    });
    socket.on("error", () => closeConnection(conn, "socket_error"));
    socket.on("close", () => {
      if (connection === conn) reconcileGateLoss("eof");
    });
    return conn;
  }

  // --- dispatch -----------------------------------------------------------
  function writeResponse(conn, response) {
    const frame = protocol.encodeFrame(response, { maxBytes: protocol.RESPONSE_MAX_BYTES });
    conn.socket.write(frame);
    conn.decoder.responseWritten();
  }

  function baseResponse(request, epoch, data, extra = {}) {
    return {
      v: 1,
      gatewayEpoch: epoch,
      requestId: request.requestId,
      ok: true,
      status: "success",
      code: "OK",
      summary: extra.summary || "",
      rootCause: null,
      retry: { safe: false, afterMs: null },
      stopCondition: null,
      nextActions: [],
      artifacts: [],
      data,
      serverTimeMs: now(),
    };
  }

  function errorResponse(request, epoch, code, summary) {
    return {
      v: 1,
      gatewayEpoch: epoch,
      requestId: request && request.requestId ? request.requestId : "req_" + "0".repeat(32),
      ok: false,
      status: "error",
      code,
      summary,
      rootCause: null,
      retry: { safe: false, afterMs: null },
      stopCondition: null,
      nextActions: [],
      artifacts: [],
      data: {},
      serverTimeMs: now(),
    };
  }

  function stopView() {
    // DEFERRED (Phase 1c): read the durable STOP store. Foundation-A defaults
    // to engaged/first_secure_migration until activation.
    const snapshot = store.snapshot();
    const stop = (snapshot && snapshot.stop) || { engaged: true, version: 1, reasonCode: "first_secure_migration", summary: "", changedAtMs: now() };
    return { engaged: stop.engaged, version: stop.version, reasonCode: stop.reasonCode, summary: stop.summary, changedAtMs: stop.changedAtMs };
  }

  function dispatch(conn, request) {
    try {
      // Validate the wire request (framing already enforced one-in-flight).
      const decision = protocol.validateRequest(request, requestContext(conn));
      const req = decision.request;

      if (decision.action === "replay") {
        writeResponse(conn, decision.response);
        return;
      }

      // Handshake ordering: session.open must be first, then session.ready,
      // before any other method runs.
      if (!conn.gatewayEpoch) {
        if (req.method !== "session.open") return fatalProtocol(conn, "handshake_order");
        return handleSessionOpen(conn, req);
      }
      if (req.gatewayEpoch !== conn.gatewayEpoch) return fatalProtocol(conn, "stale_epoch");
      if (!conn.ready) {
        if (req.method === "session.ready") return handleSessionReady(conn, req);
        if (req.method === "session.heartbeat") return handleHeartbeat(conn, req);
        return fatalProtocol(conn, "not_ready");
      }
      switch (req.method) {
        case "session.heartbeat":
          return handleHeartbeat(conn, req);
        case "session.ready":
          return handleSessionReady(conn, req); // idempotent re-ready is a protocol error path; kept minimal here
        default:
          // DEFERRED (Phase 1c/1d): all non-session methods.
          return respondError(conn, req, "INVALID_REQUEST", "method not available in the Phase-1a supervisor core");
      }
    } catch (error) {
      const code = (error && error.code) || "INTERNAL_RESPONSE_INVALID";
      log(`dispatch error ${code}: ${error && error.message}`);
      return closeConnection(conn, `dispatch:${code}`);
    }
  }

  function handleSessionOpen(conn, req) {
    // Version-locked handshake: reject on protocol/contract-digest mismatch.
    if (req.params.protocolVersion !== protocol.PROTOCOL_VERSION) return fatalProtocol(conn, "version_mismatch");
    if (req.params.contractDigest !== contractDigest) return fatalProtocol(conn, "contract_mismatch");

    conn.serviceEpoch = hexEpoch("svc", randomBytes);
    conn.gatewayEpoch = hexEpoch("gw", randomBytes);
    const data = {
      serviceEpoch: conn.serviceEpoch,
      gatewayEpoch: conn.gatewayEpoch,
      protocolVersion: protocol.PROTOCOL_VERSION,
      contractDigest,
      state: "connected_not_ready",
      limits: protocol.LIMITS_VIEW,
    };
    const response = baseResponse(req, conn.gatewayEpoch, data, { summary: "The maintenance session was opened." });
    validateAndSend(conn, req, response);
  }

  function handleSessionReady(conn, req) {
    if (req.params.contractDigest !== contractDigest) return fatalProtocol(conn, "contract_mismatch");
    conn.ready = true;
    setState(STATES.READY);
    const response = baseResponse(req, conn.gatewayEpoch, { state: "ready", stop: stopView() }, { summary: "The maintenance session is ready." });
    validateAndSend(conn, req, response);
  }

  function handleHeartbeat(conn, req) {
    serviceSeq += 1;
    const data = { state: state === STATES.READY ? "ready" : "reconciling", serviceSeq, stopVersion: stopView().version };
    const response = baseResponse(req, conn.gatewayEpoch, data, { summary: "" });
    validateAndSend(conn, req, response);
    conn.lastServiceSeq = serviceSeq;
  }

  // Validate the response against the contract before it leaves PID 1; an
  // invalid internal response never claims success.
  function validateAndSend(conn, req, response) {
    const respCtx = { requestId: req.requestId, expectedContractDigest: contractDigest };
    if (req.method !== "session.open") respCtx.gatewayEpoch = conn.gatewayEpoch;
    if (req.method === "session.heartbeat") respCtx.lastServiceSeq = conn.lastServiceSeq;
    try {
      protocol.validateResponse(req.method, response, respCtx);
    } catch (error) {
      const invalid = errorResponse(req, conn.gatewayEpoch, "INTERNAL_RESPONSE_INVALID", "internal response failed validation");
      try { writeResponse(conn, invalid); } catch { /* fall through to close */ }
      return closeConnection(conn, `internal_response:${(error && error.code) || "error"}`);
    }
    rememberIdempotency(conn, req, protocol.requestDigest(req), response);
    writeResponse(conn, response);
  }

  function respondError(conn, req, code, summary) {
    const response = errorResponse(req, conn.gatewayEpoch, code, summary);
    try { writeResponse(conn, response); } catch { closeConnection(conn, "write_failed"); }
  }

  function fatalProtocol(conn, reason) {
    // A peer/framing/protocol violation closes the connection and revokes the
    // epoch (STATE-MACHINES §2).
    closeConnection(conn, `protocol:${reason}`);
  }

  // --- teardown / gate-loss ----------------------------------------------
  function closeConnection(conn, reason) {
    if (conn && conn.socket && !conn.socket.destroyed) {
      try { conn.socket.destroy(); } catch { /* already gone */ }
    }
    reconcileGateLoss(reason);
  }

  let reconciling = false;
  function reconcileGateLoss(reason) {
    if (reconciling || gateReplacementRequired) return;
    reconciling = true;
    // This is the root trust boundary. Once the gate disappears, root cannot
    // prove whether an agent child survived it, so quarantine BEFORE reaping or
    // allowing a replacement gate to start.
    agentLaneQuarantine.trip(`authority_gate_loss:${reason || "unknown"}`);
    gateReplacementRequired = true;
    setState(STATES.RECONCILING_GATE_LOSS);
    log(`gate loss: ${reason}`);
    // Fixed reconciliation order (STATE-MACHINES §2), Phase-1a subset:
    // 1) block further work (state is no longer READY);
    // 2) revoke the epoch + all connection handles;
    // 3) reap the old gate and revoke the native active-gate latch so a
    //    replacement (new PID/epoch) can be accepted.
    // DEFERRED (Phase 1d): steps 4-8 (stop/reap governed workers, prove
    // descendant/containment/mount cleanup, settle, quarantine) are no-op hooks
    // here because no worker launcher exists yet.
    const old = connection;
    connection = null;
    try { native.revokeActiveGate(); } catch (error) { log(`revoke failed: ${(error && error.code) || error}`); }
    if (gateChild) {
      try { gateChild.kill("SIGKILL"); } catch { /* already gone */ }
    }
    reconciling = false;
    return old;
  }

  // Test/lifecycle surface. In production PID 1 owns the accept loop; the
  // harness drives accept explicitly to keep the sequence deterministic.
  return Object.freeze({
    STATES,
    contractDigest,
    boot,
    startGate,
    acceptGate,
    attachConnection,
    reconcileGateLoss,
    getState: () => state,
    getConnection: () => connection,
    needsGateReplacement: () => gateReplacementRequired,
    getAgentLaneQuarantine: () => agentLaneQuarantine,
    getAgentLaneArbiter: () => agentLaneQuarantine,
  });
}

module.exports = {
  createMaintenanceSupervisor,
  createAgentLaneArbiter,
  createAgentLaneQuarantine,
  nativeStoreAdapter,
  STATES,
};
