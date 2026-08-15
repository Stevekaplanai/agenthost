"use strict";

// Dormant Foundation-B candidate: the root boot assembly (BUILD-PLAN Phase 1f,
// Step 4d — the composition PID 1 runs at activation). It is the ONE function the
// boot edit calls: from the injected root-owned native boundary + the compiled
// §8 profiles + the deployment's repos, it constructs the whole Foundation-B
// authority (trusted stores over the shared journal, the operator authority, the
// work service, the output spool, the run-event ledger, the recovery-request
// handler, the composition root) and exposes `serve(socket)` — hand it an
// accepted SO_PEERCRED connection and it runs the framed request/response loop.
//
// Keeping the entire assembly here means the boot-file edit (entrypoint.sh) is a
// single guarded line — "when Foundation B is active, run this" — instead of a
// sprawling change to the shell. The physical spawn/containment, the recovery
// driver's teardown, and the native journal are injected and proven on real Linux
// separately; this module only wires them.
//
// DORMANT: not imported by entrypoint.sh/start.sh/gate.js. Activation (the 4d
// boot edit + Steve's deploy) is separately gated.

const { createTrustedStores } = require("./maintenance-trusted-stores.js");
const { createOperatorAuthority } = require("./maintenance-operator-authority.js");
const { createWorkService } = require("./maintenance-work-service.js");
const { createOutputSpool } = require("./maintenance-output-spool.js");
const { createRunEventLedger } = require("./maintenance-run-events.js");
const { createRecoveryRequestHandler } = require("./maintenance-recovery-request.js");
const { createRecoveryDriver } = require("./maintenance-recovery-driver.js");
const { createProfileCatalog } = require("./maintenance-profile-catalog.js");
const { createFoundationService } = require("./maintenance-foundation-service.js");
const { serveConnection } = require("./maintenance-authority-transport.js");

// createFoundationBoot({ native, protocol, contract, policy, structuralLimits,
//   profiles, spawn, recoveryDriver, storesHealthy?, globalQuarantine?, now?,
//   ledgerGeneration? })
//   native        : root-owned boundary { readFoundationJournal, appendFoundationJournalLine, ... }
//   protocol      : the protocol module
//   contract      : the frozen compiled contract object (its digest must already
//                   include the profileCatalog these profiles compile to — 4c)
//   profiles      : the §8 profile definitions (Steve's compiled operational values)
//   spawn         : the fixed-profile launcher spawn (real containment, Phase 1d)
//   recoveryDriver: the recovery/gate-loss teardown driver (Phase 1d/1f)
function createFoundationBoot({
  native, protocol, contract, policy, structuralLimits, profiles = [], spawn,
  // Recovery teardown: pass a pre-built `recoveryDriver`, OR the raw hooks
  // (teardownWorker + verifyGone [+ releaseLane, delay]) and the driver is built
  // here over the trusted stores — because the driver needs those very stores,
  // which are constructed inside this boot, it cannot always be injected pre-built.
  recoveryDriver = null, teardownWorker = null, verifyGone = null, releaseLane = null, delay = null,
  // Worker-event subscription seam: when provided, this boot registers ITS spool
  // + exit-completion as the current sinks for the (shared, boot-entry-owned)
  // worker runtime — closing the "output-chunk spooling is a following brick"
  // gap. Called once at construction with { onOutput, onExit }.
  subscribeWorkerEvents = null,
  storesHealthy = () => true, globalQuarantine = () => false, now = Date.now, ledgerGeneration = 0,
} = {}) {
  for (const [n, v] of Object.entries({ native, protocol, contract, policy, structuralLimits, spawn })) {
    if (!v) throw new Error(`foundation boot requires ${n}`);
  }
  if (!recoveryDriver && !(typeof teardownWorker === "function" && typeof verifyGone === "function")) {
    throw new Error("foundation boot requires a recoveryDriver, or teardownWorker + verifyGone to build one");
  }

  // 1. trusted stores over the ONE shared root-owned journal + boot reconcile.
  const stores = createTrustedStores({ native, policy, structuralLimits });
  stores.bootReconcile();

  // 2. compiled §8 profiles -> bindings + worst-case ceilings + health.
  const catalog = createProfileCatalog({ profiles, profileBindingKey: protocol.profileBindingKey });

  // 3. shared handle registry, spool, ledger.
  const handles = protocol.createHandleRegistry();
  const outputSpool = createOutputSpool();
  const runEvents = createRunEventLedger({ now, ledgerGeneration });

  // 4. the work service (launcher + worker registry) over the stores.
  const workService = createWorkService({
    stopStore: stores.stopStore, claimsStore: stores.claimsStore, runsStore: stores.runsStore,
    budgetStore: stores.budgetStore, auditStore: stores.auditStore,
    handles, spawn, worstCaseFor: catalog.worstCaseFor, now,
  });

  // 5. operator authority (cancelWorker seam -> the work service).
  const operatorAuthority = createOperatorAuthority({
    stopStore: stores.stopStore, budgetStore: stores.budgetStore, cancelWorker: workService.cancelWorker, now,
  });

  // 6. the live recovery.request handler. Build the driver over these stores if
  // one wasn't supplied pre-built.
  const driver = recoveryDriver || createRecoveryDriver({
    recoveryStore: stores.recoveryStore, claimsStore: stores.claimsStore, runsStore: stores.runsStore,
    budgetStore: stores.budgetStore, auditStore: stores.auditStore,
    teardownWorker, verifyGone, releaseLane: releaseLane || (() => {}), delay: delay || ((ms) => new Promise((r) => setTimeout(r, ms))),
  });
  const recoveryRequest = createRecoveryRequestHandler({ claimsStore: stores.claimsStore, recoveryDriver: driver, storesHealthy });

  // 7. the composition root.
  const service = createFoundationService({
    stores, operatorAuthority, workService, outputSpool, runEvents, recoveryRequest, handles,
    contract, protocol, structuralLimits, profileBindings: catalog.bindings,
    profileHealth: () => catalog.profileHealth(), storesHealthy, globalQuarantine, now,
  });

  // 7b. worker-event wiring: the runtime's captured output feeds THIS boot's
  // spool (redacted + cursor-ordered for work.output.read), and the observed
  // containment exit drives the settle + terminal worker view + output eof —
  // WITHOUT this, a governed run's output is discarded and the worker never
  // reaches a terminal state (the lane would poll to its deadline). Sinks are
  // fail-safe: a spool/settle fault is audited, never thrown into the runtime.
  if (typeof subscribeWorkerEvents === "function") {
    subscribeWorkerEvents({
      onOutput: (workerRef, text) => {
        try { outputSpool.append(workerRef, text); }
        catch { /* output after eof / invalid ref — drop, never crash the runtime */ }
      },
      onExit: (workerRef, { exitCode = null, signalName = null } = {}) => {
        try { outputSpool.markEof(workerRef); } catch { /* unknown ref */ }
        // A settle fault here leaves the worker view non-terminal; that is the
        // recovery driver's territory (orphaned-claim reap on the next boot /
        // recovery.request), so swallow rather than crash the runtime callback.
        try { workService.completeFromExit(workerRef, { exitCode, signalName }); } catch { /* recovery reaps */ }
      },
    });
  }

  // 8. serve one accepted (SO_PEERCRED-verified) gate connection. PID 1 sets the
  // connection identity + operator session before the framed loop begins.
  function serve(socket, { connectionId, operatorSessionDigest }) {
    service.attach({ connectionId, operatorSessionDigest });
    return serveConnection({ socket, service, protocol, now });
  }

  return Object.freeze({ service, serve, contractDigest: service.contractDigest, catalog });
}

module.exports = { createFoundationBoot };
