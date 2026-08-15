import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// CONT-07 Cost Projection contract fixtures.
// Contract: docs/continuity/COST-CONTRACT.md (CONT-07, v1).
//
// Contract fixtures, not a runtime. They freeze: an estimate is a band (never a lone
// false-precise number, metered included); the BILLING MODE and band are server-derived
// from the LIVE CREDENTIAL and CONT-01 pricing, never the engine name and never caller-
// declared (a supplied billing/band/pricedAt is COST_REQUEST_INVALID); a missing estimate
// fails closed (never silent $0); the standing grant is advance approval (inside proceeds
// with a DERIVED remaining, the projected==grant boundary proceeds, strictly-over gates);
// reserve-before-execute + idempotent-by-(run/stage id) settle so parallel attempts cannot
// overspend the cap; the most-restrictive limit wins and the ==cap boundary is refused;
// the 80% soft-stop pinned at 0.80 vs 0.79; aux (voice) spend debits the SAME chain total
// so a combined overspend is refused; numeric variance on over- and under-runs; and a
// seeded credential injected into a projection input never reaches an output. Reuses
// chains-lib.js / settings-lib.js, and marks the tiers/hold it must ADD as new surface.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_FILE = path.join(HERE, "fixtures", "cost-contract-v1.json");
const fixture = JSON.parse(fs.readFileSync(FIXTURE_FILE, "utf8"));

const ARRAYS = ["projectionCases", "billingDerivationCases", "enforcementCases", "reservationCases", "secretInputCases", "envelopeCases"];
const allCases = () => ARRAYS.flatMap((k) => fixture[k]);
const byId = (arr) => new Map(fixture[arr].map((k) => [k.id, k]));

test("cost fixture has one versioned, collision-free catalog", () => {
  assert.equal(fixture.$schema, "agenthost-continuity-cost-fixtures-v1");
  assert.equal(fixture.contractId, "CONT-07");
  assert.equal(fixture.contractVersion, 1);
  const ids = allCases().map((k) => k.id);
  assert.equal(new Set(ids).size, ids.length, "case IDs must be globally unique");
  assert.ok(ids.length >= 28, "needs a meaningful corpus");
  assert.deepEqual(fixture.serverDerivedFields, ["billingMode", "band", "pricedAt"]);
});

test("an estimate is a band with a pricing timestamp, never a lone false-precise number (metered included)", () => {
  const pc = byId("projectionCases");
  const band = pc.get("estimate-is-a-band-with-priced-at");
  assert.ok(band.expected.low <= band.expected.expected && band.expected.expected <= band.expected.high, "low<=expected<=high");
  assert.equal(band.expected.hasPricedAt, true);
  assert.equal(band.expected.singleFalsePreciseNumber, false);
  // The metered case must ALSO carry a band -- a lone expectedUsdCents is the same defect.
  const metered = pc.get("metered-engine-real-dollars-carries-a-band");
  assert.ok(metered.expected.low <= metered.expected.expected && metered.expected.expected <= metered.expected.high, "metered band low<=expected<=high");
  assert.ok(metered.expected.high > metered.expected.low, "a real band, not a collapsed point");
  assert.equal(metered.expected.singleFalsePreciseNumber, false);
});

test("billing mode is DERIVED from the live credential, not the engine name, and never caller-declared", () => {
  const bc = byId("billingDerivationCases");
  const derive = (credential) => fixture.credentialBilling[credential];

  // Same engine ("claude"), two credentials -> two billing modes. The engine name decides nothing.
  const sub = bc.get("billing-derived-claude-oauth-is-subscription");
  assert.equal(sub.engine, "claude");
  assert.equal(derive(sub.credential), sub.expected.billing, "credential map derives subscription");
  assert.equal(sub.expected.billing, "subscription");
  assert.equal(sub.expected.expectedUsdCents, 0);
  assert.equal(sub.expected.tokensShown, true);

  const met = bc.get("billing-derived-claude-apikey-is-metered");
  assert.equal(met.engine, "claude");
  assert.equal(derive(met.credential), met.expected.billing, "credential map derives metered");
  assert.equal(met.expected.billing, "metered");
  assert.ok(met.expected.low <= met.expected.expected && met.expected.expected <= met.expected.high, "metered band");
  assert.ok(met.expected.expected > 0, "a claude-on-API-key box meters real dollars");

  // The lethal property: identical engine, divergent billing -> classification is NOT engine-keyed.
  assert.equal(sub.engine, met.engine);
  assert.notEqual(sub.expected.billing, met.expected.billing, "same engine name, different billing -> derived from credential");
  for (const c of [sub, met]) {
    assert.equal(c.expected.derivedFromCredential, true);
    assert.equal(c.expected.derivedFromEngineName, false);
  }

  // A caller cannot hand in a server-derived field.
  for (const id of ["caller-supplied-billing-rejected", "caller-supplied-band-rejected", "caller-supplied-pricedAt-rejected"]) {
    const c = bc.get(id);
    assert.ok(fixture.serverDerivedFields.includes(c.suppliesServerDerivedField), `${id}: names a server-derived field`);
    assert.equal(c.expected.errorCode, "COST_REQUEST_INVALID", `${id}: rejected`);
  }
});

test("a stale price NUMERICALLY widens the band; a fully missing estimate fails closed (never silent $0)", () => {
  const pc = byId("projectionCases");
  const stale = pc.get("stale-price-widens-band-not-zero");
  const freshSpan = stale.freshBand.high - stale.freshBand.low;
  const staleSpan = stale.staleBand.high - stale.staleBand.low;
  assert.ok(staleSpan > freshSpan, "the stale band span is strictly WIDER than the fresh one (not a boolean claim)");
  assert.ok(stale.staleBand.low > 0 || stale.staleBand.high > 0, "widening never collapses to $0");
  assert.equal(stale.expected.bandWidened, true);
  assert.equal(stale.expected.silentlyZero, false);
  const missing = pc.get("missing-estimate-fails-closed");
  assert.equal(missing.estimateFormable, false);
  assert.equal(missing.expected.errorCode, "COST_ESTIMATE_UNAVAILABLE");
  assert.equal(missing.expected.proceedsAsIfZero, false);
  assert.equal(missing.expected.gatesForConfirmation, true);
  // Chain projection sums its stages (derived).
  const chain = pc.get("chain-projection-sums-stages");
  assert.equal(chain.expected.chainTotalUsdCents, chain.stagesUsdCents.reduce((a, b) => a + b, 0));
});

test("the standing grant is advance approval: remaining is derived, ==grant proceeds, strictly-over gates", () => {
  const ec = byId("enforcementCases");
  const inside = ec.get("inside-grant-proceeds-with-remaining");
  assert.ok(inside.projectedUsdCents < inside.standingGrantUsdCents);
  assert.equal(inside.expected.proceeds, true);
  assert.equal(inside.expected.showsRemaining, true);
  // Remaining is DERIVED (grant - projected), not a free-typed number.
  assert.equal(inside.expected.remainingUsdCents, inside.standingGrantUsdCents - inside.projectedUsdCents);
  // Boundary: projected == grant is INSIDE (spending up to the grant is allowed) -> proceeds, remaining 0.
  const at = ec.get("at-grant-exactly-proceeds-boundary");
  assert.equal(at.projectedUsdCents, at.standingGrantUsdCents);
  assert.equal(at.expected.proceeds, true, "== grant proceeds; only strictly-over gates");
  assert.equal(at.expected.gated, false);
  assert.equal(at.expected.remainingUsdCents, at.standingGrantUsdCents - at.projectedUsdCents);
  const outside = ec.get("outside-grant-gates-for-confirmation");
  assert.ok(outside.projectedUsdCents > outside.standingGrantUsdCents);
  assert.equal(outside.expected.errorCode, "SPEND_CONFIRMATION_REQUIRED");
  assert.equal(outside.expected.projectionShownAtGate, true);
  const gate = ec.get("projection-present-in-approval-gate-context");
  assert.equal(gate.expected.inGateLoadedContext, true);
  assert.equal(gate.expected.settingsPanelOnly, false);
});

test("the 80% soft-stop is boundary-pinned (0.80 vs 0.79) and observe-only still audits the bypass", () => {
  const ec = byId("enforcementCases");
  assert.equal(fixture.softStopFraction, 0.8);
  const stop = ec.get("soft-stop-at-80-percent-no-new-children");
  assert.equal(stop.spentFraction, fixture.softStopFraction, "fires AT exactly 0.8 (>= semantics)");
  assert.equal(stop.expected.spawnsNewChildren, false);
  assert.equal(stop.expected.movesToSynthesize, true);
  const under = ec.get("just-under-soft-stop-still-spawns");
  assert.ok(under.spentFraction < fixture.softStopFraction, "just under does NOT fire");
  assert.equal(under.expected.spawnsNewChildren, true);
  const obs = ec.get("observe-only-mode-audits-bypass");
  assert.equal(obs.expected.bypassAudited, true, "budget_bypassed audit is backed today");
  assert.equal(obs.expected.silentlyIgnored, false);
  assert.equal(obs.expected.displayWaitsOnCont04A, true, "the display half honestly waits on the BLOCKED inbox");
});

test("reservation is atomic + idempotent-by-id, the ==cap and most-restrictive boundaries are pinned, and parallel attempts cannot overspend", () => {
  const rc = byId("reservationCases");
  const basic = rc.get("reserve-before-execute-then-settle-once");
  assert.equal(basic.expected.reservedBeforeStage, true);
  assert.equal(basic.expected.doubleCharged, false);
  // Idempotent settle is keyed by run/stage id (not merely "true").
  const idem = rc.get("idempotent-settle-across-restart");
  assert.equal(typeof idem.settleDedupKey, "string");
  assert.ok(idem.settleDedupKey.length > 0, "there is an explicit dedup key");
  assert.equal(idem.expected.keyedByRunStageId, true);
  assert.equal(idem.expected.doubleCharged, false);
  assert.equal(idem.expected.doubleReleased, false);
  // Concurrency: each reservation <= cap, but held together they exceed it (integer cents).
  const conc = rc.get("concurrent-reservations-cannot-overspend-chain-cap");
  for (const r of conc.reservationsUsdCents) assert.ok(r <= conc.capUsdCents, "each reservation alone fits the cap");
  assert.ok(conc.reservationsUsdCents.reduce((a, b) => a + b, 0) > conc.capUsdCents, "together they exceed it");
  assert.equal(conc.expected.errorCode, "BUDGET_RESERVATION_INVALID");
  assert.equal(conc.expected.collectivelyExceededCap, false);
  // Boundary: a reservation EQUAL to the cap is refused (matches breaches() >= semantics).
  const eq = rc.get("reservation-equals-cap-refused-boundary");
  assert.equal(eq.reservationUsdCents, eq.capUsdCents, "the boundary is exactly ==cap");
  assert.equal(eq.expected.errorCode, "BUDGET_RESERVATION_INVALID");
  assert.equal(eq.expected.refusedAtEqualsCap, true);
  // Most-restrictive limit refused before the stage runs (integer cents).
  const restrict = rc.get("reservation-over-most-restrictive-limit-refused-before-stage");
  assert.ok(restrict.reservationUsdCents <= restrict.standingGrantUsdCents, "within the looser standing grant");
  assert.ok(restrict.reservationUsdCents > restrict.perTaskCapUsdCents, "but over the tighter per-task cap");
  assert.equal(restrict.expected.errorCode, "BUDGET_RESERVATION_INVALID");
  assert.equal(restrict.expected.refusedBeforeStageRuns, true);
});

test("aux (voice) spend debits the SAME chain total, so a combined overspend is refused even under a local sub-cap", () => {
  const aux = byId("reservationCases").get("aux-voice-spend-debits-same-total-combined-overspend-refused");
  assert.ok(aux.auxUsdCents <= aux.localVoiceCapUsdCents, "aux cost is under its own local limit");
  assert.ok(aux.auxUsdCents + aux.inferenceHeldUsdCents > aux.capUsdCents, "but aux + inference exceed the shared cap");
  assert.equal(aux.expected.debitedAgainstSharedTotal, true);
  assert.equal(aux.expected.keptSideBucket, false, "no side-bucket that passes a sub-cap while the combined total blows the cap");
  assert.equal(aux.expected.errorCode, "BUDGET_RESERVATION_INVALID");
  assert.equal(aux.expected.combinedExceededCap, false);
});

test("variance (estimated vs actual) is recorded NUMERICALLY on both over- and under-runs", () => {
  const rc = byId("reservationCases");
  const over = rc.get("underestimate-trips-budget-exhausted-and-soft-stops");
  assert.ok(over.actualUsdCents > over.reservedUsdCents);
  assert.equal(over.expected.errorCode, "BUDGET_EXHAUSTED");
  assert.equal(over.expected.softStops, true);
  assert.equal(over.expected.varianceRecorded, true);
  assert.equal(over.expected.varianceUsdCents, over.actualUsdCents - over.reservedUsdCents, "variance = actual - reserved (positive)");
  const under = rc.get("normal-settle-records-variance-under-reservation");
  assert.ok(under.actualUsdCents < under.reservedUsdCents);
  assert.equal(under.expected.varianceRecorded, true);
  assert.equal(under.expected.varianceUsdCents, under.actualUsdCents - under.reservedUsdCents, "variance = actual - reserved (negative)");
  assert.equal(under.expected.doubleCharged, false);
});

test("every declared code is exercised, has a concrete envelope, and the envelope's error.code matches the case code", () => {
  const codesOnCases = new Set([
    ...allCases().map((k) => k.code).filter(Boolean),
    ...allCases().map((k) => k.expected && k.expected.errorCode).filter(Boolean),
  ]);
  for (const c of fixture.codes) assert.ok(codesOnCases.has(c), `code ${c} is never exercised`);
  for (const c of codesOnCases) assert.ok(fixture.codes.includes(c), `undeclared code ${c}`);
  // Every declared code needs its own concrete envelope (no code without a user-facing shape).
  const envByCode = new Map(fixture.envelopeCases.filter((k) => k.code).map((k) => [k.code, k]));
  for (const c of fixture.codes) assert.ok(envByCode.has(c), `code ${c} needs a concrete envelope`);
  for (const k of fixture.envelopeCases) {
    const env = k.expected;
    assert.ok(["success", "warning", "error"].includes(env.status));
    assert.ok(typeof env.summary === "string" && env.summary.length > 0 && env.summary.length <= 200, `${k.id}`);
    assert.ok(Array.isArray(env.next_actions) && Array.isArray(env.artifacts));
    if (env.status === "error") {
      assert.equal(env.error.code, k.code, `${k.id}: error.code must match the case code`);
      assert.ok(env.error.retry.length > 0 && env.error.stopCondition.length > 0, `${k.id} triplet`);
    }
  }
  // The success projection's remaining is derived (chain cap - chain total), not free-typed.
  const ok = byId("envelopeCases").get("envelope-success-projection");
  const art = ok.expected.artifacts.find((a) => a.type === "cost_projection");
  assert.equal(art.remainingUsdCents, fixture.chainCapUsdCents - art.chainTotalUsdCents, "remaining = chain cap - chain total");
});

test("a seeded credential injected into a projection input never reaches any output", () => {
  const secret = fixture.seededSecret;
  // Contract-level: no expected output ANYWHERE carries the secret (scan every field, not just `expected`).
  const wholeCases = JSON.stringify(allCases());
  // The secret may appear only inside an input-injection case as a marker flag, never as a literal value.
  assert.equal(wholeCases.includes(secret), false, "seeded secret must not be a literal in any case (inputs or outputs)");
  const scrub = byId("secretInputCases").get("secret-injected-into-projection-input-scrubbed");
  assert.equal(scrub.injectValueIsSeededSecret, true);
  assert.equal(scrub.expected.summaryContainsSecret, false);
  assert.equal(scrub.expected.artifactContainsSecret, false);
  assert.equal(scrub.expected.errorContainsSecret, false);
});
