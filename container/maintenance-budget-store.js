"use strict";

// Dormant Foundation-B candidate: the root-owned durable budget store
// (BUILD-PLAN Phase 1c; ROOT-SERVICE-STATE-MACHINES §8; IPC contract §4.1
// BudgetView). Budget is per chain: available = cap - reserved - settled.
//
// Invariants enforced here:
//   - the caller supplies no amount at the IPC edge; the fixed profile's
//     worst-case reservation is passed in by the service;
//   - one work identity (workerRef) owns exactly one reservation;
//   - reserved + settled never exceeds the cap on any enabled dimension;
//   - settlement is exactly once and cannot exceed the reservation; missing or
//     untrusted usage charges the FULL reservation (full_charge);
//   - a refund is allowed only for a still-reserved (pre-settle) identity and
//     only once — the "proven pre-child no-spawn" case;
//   - replay reconstructs state, so a crash after reserve never double-reserves
//     or grants an unearned refund.
//
// Semantics live over an injected append-only log adapter ({ append, readAll }),
// so the physical substrate is a separate reserved decision. DORMANT: not wired
// into any boot path; activation is the atomic, separately-gated Phase 1f event.

class BudgetStoreError extends Error {
  constructor(code, message) { super(message); this.name = "BudgetStoreError"; this.code = code; }
}
function fail(code, message) { throw new BudgetStoreError(code, message); }

function nonNegInt(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail("INVALID_REQUEST", `${label} must be a non-negative safe integer`);
  return value;
}

function createBudgetStore({ log, policy, structuralLimits } = {}) {
  if (!log || typeof log.append !== "function" || typeof log.readAll !== "function") {
    throw new Error("budget store requires an append-only log adapter { append, readAll }");
  }
  if (!policy || typeof policy.policyVersion !== "number") throw new Error("budget store requires a policy");
  if (!structuralLimits) throw new Error("budget store requires structural limits");

  // Cost policy is a REPLAYABLE, versioned value (operator budget.policy.set can
  // change costLimitEnabled/costLimitMicros with a monotonic version bump). The
  // structural token/exec ceilings are immutable (compiled into the image). When
  // no policy change is ever appended, behavior is identical to the construction
  // policy — the pre-existing accounting is preserved exactly.
  const OPERATOR_COST_MIN = 1_000_000;   // IPC contract §6 budget.policy.set range
  const OPERATOR_COST_MAX = 100_000_000;
  const policyState = {
    policyVersion: policy.policyVersion,
    costLimitEnabled: policy.costLimitEnabled === true,
    costLimitMicros: policy.costLimitEnabled === true ? nonNegInt(policy.costLimitMicros, "costLimitMicros") : (Number.isSafeInteger(policy.costLimitMicros) ? policy.costLimitMicros : 0),
  };
  const currentCostCap = () => (policyState.costLimitEnabled ? policyState.costLimitMicros : Infinity);
  const tokenCap = nonNegInt(structuralLimits.maxTokenUnits, "maxTokenUnits");
  const execCap = nonNegInt(structuralLimits.maxExecs, "maxExecs");
  const softStopPermille = structuralLimits.softStopPermille;

  // workerRef -> { chainId, tokenUnits, costMicros, state, settledTokens, settledCost }
  const reservations = new Map();

  function apply(record) {
    if (!record || typeof record !== "object" || record.type !== "budget") return;
    const { op, workerRef } = record;
    if (op === "reserve") {
      reservations.set(workerRef, { chainId: record.chainId, tokenUnits: record.tokenUnits, costMicros: record.costMicros, state: "reserved", settledTokens: 0, settledCost: 0 });
    } else if (op === "settle") {
      const r = reservations.get(workerRef);
      if (r) { r.state = "settled"; r.settledTokens = record.tokenUnits; r.settledCost = record.costMicros; }
    } else if (op === "refund") {
      const r = reservations.get(workerRef);
      if (r) r.state = "refunded";
    } else if (op === "policy") {
      policyState.policyVersion = record.policyVersion;
      policyState.costLimitEnabled = record.costLimitEnabled === true;
      policyState.costLimitMicros = record.costLimitMicros;
    }
  }

  function replay() {
    let records;
    try { records = log.readAll(); } catch { fail("STORE_UNAVAILABLE", "budget log is unreadable"); }
    for (const record of records || []) apply(record);
  }
  replay();

  function totals(chainId) {
    let settledCost = 0, settledTokens = 0, reservedCost = 0, reservedTokens = 0, execs = 0;
    for (const r of reservations.values()) {
      if (r.chainId !== chainId) continue;
      if (r.state !== "refunded") execs += 1; // a refunded reservation proved no spawn: not an exec
      if (r.state === "reserved") { reservedCost += r.costMicros; reservedTokens += r.tokenUnits; }
      else if (r.state === "settled") { settledCost += r.settledCost; settledTokens += r.settledTokens; }
    }
    return { settledCost, settledTokens, reservedCost, reservedTokens, execs };
  }

  function flags(t) {
    const costCap = currentCostCap();
    const committedCost = t.settledCost + t.reservedCost;
    const committedTokens = t.settledTokens + t.reservedTokens;
    const exhausted = committedCost >= costCap || committedTokens >= tokenCap || t.execs >= execCap;
    const soft = (policyState.costLimitEnabled && committedCost * 1000 >= softStopPermille * costCap) ||
      (committedTokens * 1000 >= softStopPermille * tokenCap) ||
      (t.execs * 1000 >= softStopPermille * execCap);
    return { softStop: soft, exhausted };
  }

  function view(chainId) {
    const t = totals(chainId);
    const f = flags(t);
    return Object.freeze({
      chainId,
      policyVersion: policyState.policyVersion,
      execs: t.execs,
      tokenUnits: t.settledTokens,
      costMicros: t.settledCost,
      reservedTokenUnits: t.reservedTokens,
      reservedCostMicros: t.reservedCost,
      softStop: f.softStop,
      exhausted: f.exhausted,
    });
  }

  // Reserve the fixed-profile worst-case for a new work identity. Fails closed
  // if the reservation would exceed any enabled cap; never partially reserves.
  function reserve({ chainId, workerRef, tokenUnits, costMicros } = {}) {
    if (typeof chainId !== "string" || typeof workerRef !== "string") fail("INVALID_REQUEST", "chainId and workerRef are required");
    nonNegInt(tokenUnits, "tokenUnits");
    nonNegInt(costMicros, "costMicros");
    if (reservations.has(workerRef)) fail("RESERVATION_EXISTS", "this work identity already owns a reservation");
    const t = totals(chainId);
    if (t.settledCost + t.reservedCost + costMicros > currentCostCap()) fail("BUDGET_EXHAUSTED", "cost cap would be exceeded");
    if (t.settledTokens + t.reservedTokens + tokenUnits > tokenCap) fail("BUDGET_EXHAUSTED", "token cap would be exceeded");
    if (t.execs + 1 > execCap) fail("BUDGET_EXHAUSTED", "execution cap would be exceeded");
    const record = { type: "budget", op: "reserve", chainId, workerRef, tokenUnits, costMicros };
    try { log.append(record); } catch { fail("STORE_UNAVAILABLE", "reservation could not be persisted"); }
    apply(record);
    return view(chainId);
  }

  // Settle exactly once. Trusted observed usage charges min(observed,reserved);
  // missing/untrusted usage charges the full reservation.
  function settle({ workerRef, trusted, observedTokenUnits = null, observedCostMicros = null } = {}) {
    const r = reservations.get(workerRef);
    if (!r) fail("NOT_RESERVED", "no reservation for this work identity");
    if (r.state !== "reserved") fail("ALREADY_FINALIZED", `reservation is already ${r.state}`);
    let tokens, cost, mode;
    if (trusted === true) {
      nonNegInt(observedTokenUnits, "observedTokenUnits");
      nonNegInt(observedCostMicros, "observedCostMicros");
      tokens = Math.min(observedTokenUnits, r.tokenUnits);
      cost = Math.min(observedCostMicros, r.costMicros);
      mode = "observed";
    } else {
      tokens = r.tokenUnits;
      cost = r.costMicros;
      mode = "full_charge";
    }
    const record = { type: "budget", op: "settle", chainId: r.chainId, workerRef, tokenUnits: tokens, costMicros: cost, mode };
    try { log.append(record); } catch { fail("STORE_UNAVAILABLE", "settlement could not be persisted"); }
    apply(record);
    return { view: view(r.chainId), mode };
  }

  // Refund a still-reserved identity exactly once — the proven pre-child
  // no-spawn case only. A settled reservation can never be refunded.
  function refund({ workerRef } = {}) {
    const r = reservations.get(workerRef);
    if (!r) fail("NOT_RESERVED", "no reservation for this work identity");
    if (r.state !== "reserved") fail("ALREADY_FINALIZED", `reservation is already ${r.state}`);
    const record = { type: "budget", op: "refund", chainId: r.chainId, workerRef };
    try { log.append(record); } catch { fail("STORE_UNAVAILABLE", "refund could not be persisted"); }
    apply(record);
    return view(r.chainId);
  }

  // Current cost policy view (IPC contract §6 budget.policy.get shape). Structural
  // ceilings are immutable and echoed for the operator surface.
  function policyView() {
    return Object.freeze({
      version: policyState.policyVersion,
      costLimitEnabled: policyState.costLimitEnabled,
      costLimitMicros: policyState.costLimitMicros,
      structuralLimits: Object.freeze({ ...structuralLimits }),
    });
  }

  // Operator budget.policy.set (O-class; proof verified upstream by the protocol).
  // CAS on the current version, range-check the cost ceiling, append a monotonic
  // policy record, and return the new policy. Restart-safe via replay. Structural
  // ceilings are never mutated here.
  function setPolicy({ expectedVersion, costLimitEnabled, costLimitMicros } = {}) {
    if (!Number.isSafeInteger(expectedVersion)) fail("INVALID_REQUEST", "expectedVersion must be a safe integer");
    if (expectedVersion !== policyState.policyVersion) fail("STALE_VERSION", "budget policy version is stale");
    if (typeof costLimitEnabled !== "boolean") fail("INVALID_POLICY", "costLimitEnabled must be boolean");
    if (!Number.isSafeInteger(costLimitMicros) || costLimitMicros < OPERATOR_COST_MIN || costLimitMicros > OPERATOR_COST_MAX) {
      fail("INVALID_POLICY", `costLimitMicros must be an integer from ${OPERATOR_COST_MIN} through ${OPERATOR_COST_MAX}`);
    }
    const record = { type: "budget", op: "policy", policyVersion: policyState.policyVersion + 1, costLimitEnabled, costLimitMicros };
    try { log.append(record); } catch { fail("STORE_UNAVAILABLE", "budget policy change could not be persisted"); }
    apply(record);
    return policyView();
  }

  return Object.freeze({ reserve, settle, refund, view, setPolicy, policy: policyView });
}

module.exports = { createBudgetStore, BudgetStoreError };
