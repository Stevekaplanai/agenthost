"use strict";

// Dormant Foundation-B candidate: the trusted-store assembly (BUILD-PLAN Phase 1f,
// increment 5.2a — the data layer of the composition root). Instantiates all six
// durable stores over the ONE shared append-only journal (D1) via
// maintenance-journal-adapter, each with a view of its own record type, and wires
// boot reconciliation. This is the single place the composition root gets its
// authority state from.
//
// View validators are injected (defaulting to a no-op): store-level validation is
// defense-in-depth; the AUTHORITATIVE view validation is the protocol's
// validateResponse at the IPC edge (wired in the dispatch increment 5.2b). The
// native journal (root+PID-1) is injected so this stays free of any boot path.
//
// DORMANT: not wired into entrypoint.sh/start.sh/gate.js; activation is the
// separate, gated Phase 1f cutover.

const { createFoundationJournalAdapter } = require("./maintenance-journal-adapter.js");
const { createStopStore } = require("./maintenance-stop-store.js");
const { createClaimsStore } = require("./maintenance-claims-store.js");
const { createRunsStore } = require("./maintenance-runs-store.js");
const { createBudgetStore } = require("./maintenance-budget-store.js");
const { createAuditStore } = require("./maintenance-audit-store.js");
const { createRecoveryStore } = require("./maintenance-recovery-store.js");
const { createBootReconciler } = require("./maintenance-boot-reconciler.js");

const NOOP = () => {};

// createTrustedStores({ native, policy, structuralLimits, validators?, now?, log? })
//   native: { readFoundationJournal, appendFoundationJournalLine } (root+PID-1)
//   policy / structuralLimits: budget policy + compiled ceilings
//   validators: { stop, claim, run, recovery } view validators (default no-op)
function createTrustedStores({ native, policy, structuralLimits, validators = {}, now, log = NOOP } = {}) {
  if (!native || typeof native.readFoundationJournal !== "function" || typeof native.appendFoundationJournalLine !== "function") {
    throw new Error("trusted stores require native { readFoundationJournal, appendFoundationJournalLine }");
  }
  if (!policy) throw new Error("trusted stores require a budget policy");
  if (!structuralLimits) throw new Error("trusted stores require structural limits");

  const journal = (type) => createFoundationJournalAdapter({ native, type });
  const withNow = (extra) => (now ? { now, ...extra } : extra);

  // Each store replays its own type off the one shared journal on construction.
  const stopStore = createStopStore(withNow({ log: journal("stop"), validateStopView: validators.stop || NOOP }));
  const claimsStore = createClaimsStore(withNow({ log: journal("claim"), validateClaimView: validators.claim || NOOP }));
  const runsStore = createRunsStore(withNow({ log: journal("run"), validateRunView: validators.run || NOOP }));
  const budgetStore = createBudgetStore({ log: journal("budget"), policy, structuralLimits });
  const auditStore = createAuditStore(withNow({ log: journal("audit") }));
  const recoveryStore = createRecoveryStore(withNow({ log: journal("recovery"), validateRecoveryView: validators.recovery || NOOP }));

  // Boot reconciliation (STATE-MACHINES boot path): interrupt in-flight worker
  // claims conservatively, preserve parked claims. Idempotent — safe to re-run.
  function bootReconcile() {
    return createBootReconciler({ claimsStore, runsStore, budgetStore, log }).reconcile();
  }

  return Object.freeze({ stopStore, claimsStore, runsStore, budgetStore, auditStore, recoveryStore, bootReconcile });
}

module.exports = { createTrustedStores };
