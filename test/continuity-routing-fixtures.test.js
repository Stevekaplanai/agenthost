import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// CONT-12 Intelligent Routing contract fixtures.
// Contract: docs/continuity/ROUTING-CONTRACT.md (CONT-12, v1).
//
// Contract fixtures, not a runtime. The spine: the router SELECTS, never GRANTS.
//   - The load-bearing inputs (eligible, capabilityFit, reviewEligible, consequential)
//     are SERVER-DERIVED from the live CONT-06 result / isHumanGated, never accepted
//     from the request. A request that supplies them is ROUTE_REQUEST_INVALID.
//   - Selection is deterministic: the same frozen inputs -> the same route, proven by
//     an independent oracle rebuilt here (not read from a fixture field), reproducible
//     under candidate re-ordering, with a total order (codepoint tiebreak) so a missing
//     or non-finite score can never leave the sort partial -- it fails closed instead.
//   - A CONT-06 capability_result is an observation, not an authorization: eligibility
//     is re-checked at run, and a route that lost a capability between selection and run
//     refuses rather than proceeding on the stale snapshot.
//   - Consequential work never silently downgrades and there is NO automatic reroute:
//     an unavailable route returns to the operator/owner to reissue via the CONT-08
//     handoff (matching CONT-08's server-minted, operator-only reissue rule).
//   - An agent is never routed to review its own work (author resolved from the ledger,
//     fail-closed when unresolvable), capacity is won through the atomic claim before
//     dispatch, and the selected agent inherits none of the router's authority.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_FILE = path.join(HERE, "fixtures", "routing-contract-v1.json");
const fixture = JSON.parse(fs.readFileSync(FIXTURE_FILE, "utf8"));

const ARRAYS = [
  "serverDerivationCases", "spineCases", "selectionCases", "determinismCases",
  "scoreValidityCases", "eligibilityCases", "selfReviewCases", "downgradeCases",
  "capacityBudgetCases", "secretInputCases", "envelopeCases",
];
const allCases = () => ARRAYS.flatMap((k) => fixture[k]);
const byId = (arr) => new Map(fixture[arr].map((k) => [k.id, k]));

const finiteNum = (n) => typeof n === "number" && Number.isFinite(n);

// Independent oracle: pick the best route deterministically, rebuilt here so the
// selection is PROVEN reproducible rather than read from an "expected" field.
// Ranking order == fixture.scoreInputs: capabilityFit desc, projectedCost asc,
// workloadDepth asc, reviewEligible (true first), then codepoint-lowest agent id.
// Fail-closed: only-eligible, non-author, finite-capabilityFit candidates survive;
// a candidate priced above a hard budget cap is excluded (not sorted as NaN).
// `active` is the ordered set of ranking inputs in play. It defaults to the full
// fixture order; passing a subset lets a test PROVE decisiveness — dropping one input
// and showing the winner changes is the only real proof a factor decided the route
// (a case whose winner is also the codepoint-lowest candidate is confounded and proves
// nothing). Codepoint tiebreak is always last.
const ALL_INPUTS = ["capabilityFit", "projectedCostUsdCents", "workloadDepth", "reviewEligible"];
function selectRoute(candidates, opts = {}, active = ALL_INPUTS) {
  const cap = opts.remainingHardCapUsdCents;
  const eligible = candidates.filter((c) => {
    if (!c.eligible) return false;                    // server-derived eligibility only
    if (c.author === true) return false;              // never route a self-review
    if (!finiteNum(c.capabilityFit)) return false;    // fail closed on a missing primary score
    if (c.hardInfeasible === true) return false;       // hard-infeasible budget exclusion
    if (cap != null && finiteNum(c.projectedCostUsdCents) && c.projectedCostUsdCents > cap) return false;
    return true;
  });
  if (eligible.length === 0) return null;
  const dflt = (x, d) => (finiteNum(x) ? x : d);
  const term = (inp, a, b) =>
    inp === "capabilityFit" ? (b.capabilityFit - a.capabilityFit) :
    inp === "projectedCostUsdCents" ? (dflt(a.projectedCostUsdCents, 0) - dflt(b.projectedCostUsdCents, 0)) :
    inp === "workloadDepth" ? (dflt(a.workloadDepth, 0) - dflt(b.workloadDepth, 0)) :
    inp === "reviewEligible" ? (Number(!!b.reviewEligible) - Number(!!a.reviewEligible)) : 0;
  const ranked = [...eligible].sort((a, b) => {
    for (const inp of active) { const d = term(inp, a, b); if (d) return d; }
    return a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : 0;   // codepoint tiebreak, always last
  });
  return ranked[0].agent;
}

// CONT-06 derivation: eligibility comes from the readiness ladder, not a declared flag.
const deriveEligibleIdsFromCont06 = (rows) =>
  rows.filter((c) => c.capabilityResult && c.capabilityResult.state === "available").map((c) => c.agent);

test("routing fixture is one versioned, collision-free catalog with a coherent score model", () => {
  assert.equal(fixture.$schema, "agenthost-continuity-routing-fixtures-v1");
  assert.equal(fixture.contractId, "CONT-12");
  assert.equal(fixture.contractVersion, 1);
  const ids = allCases().map((k) => k.id);
  assert.equal(new Set(ids).size, ids.length, "case IDs must be globally unique");
  assert.ok(ids.length >= 40, "needs a meaningful corpus");
  // The oracle's ranking order and the derivation set are the contract's spine; pin them.
  assert.deepEqual(fixture.scoreInputs, ["capabilityFit", "projectedCostUsdCents", "workloadDepth", "reviewEligible"]);
  assert.deepEqual(fixture.serverDerivedFields, ["eligible", "capabilityFit", "reviewEligible", "consequential"]);
  for (const f of ["chosenRoute", "rationale", "code", "eligibleSetIds"]) {
    assert.ok(fixture.observations.includes(f), `observations must expose ${f}`);
  }
});

test("load-bearing inputs are server-derived, never caller-declared", () => {
  const sd = byId("serverDerivationCases");

  // Eligibility DERIVES from a live CONT-06 capability_result, it is not a declared field.
  const derive = sd.get("eligibility-derived-from-cont06-not-declared");
  assert.deepEqual(deriveEligibleIdsFromCont06(derive.candidatesCont06), derive.expected.eligibleIds);
  assert.equal(derive.expected.derivedNotDeclared, true);

  // A request that hands in a server-derived field is rejected -- this is the exact
  // "inventory presented as authority" hole CONT-06 closed, one layer up.
  for (const id of ["request-supplying-eligible-rejected", "request-supplying-consequential-rejected"]) {
    const c = sd.get(id);
    assert.ok(fixture.serverDerivedFields.includes(c.suppliesServerDerivedField), `${id}: names a server-derived field`);
    assert.equal(c.expected.errorCode, "ROUTE_REQUEST_INVALID", `${id}: caller cannot supply it`);
  }

  // "consequential" is the shared isHumanGated verdict, not a caller boolean or keyword scan.
  const cons = sd.get("consequential-derived-from-isHumanGated-not-caller");
  assert.equal(cons.expected.consequential, cons.isHumanGatedVerdict);
  assert.equal(cons.expected.fromClassifier, true);
  assert.equal(cons.expected.fromCallerBoolean, false);

  // reviewRequirement (hence the CONT-08 derived capability) comes from the canonical
  // task record; a prompt asking for autonomous execution cannot escalate it.
  const reframe = sd.get("prompt-cannot-reframe-reviewRequirement");
  assert.equal(reframe.expected.derivedFromCanonicalTask, true);
  assert.equal(reframe.expected.derivedCapability, "terminal");
  assert.equal(reframe.expected.escalatedToUnattended, false);
});

test("the selected agent inherits none of the router's authority (the spine)", () => {
  const load = ["credentials", "worktreeLease", "claimToken", "autonomyLevel", "gitMaxRung"];
  const seen = new Set();
  for (const k of fixture.spineCases) {
    assert.equal(k.expected.inherited, false, `${k.id}: ${k.field} must not be inherited`);
    seen.add(k.field);
  }
  for (const f of load) assert.ok(seen.has(f), `spine must prove ${f} is not inherited`);
});

test("selection is deterministic and reproducible, proven by an independent oracle", () => {
  for (const k of fixture.selectionCases) {
    const opts = { remainingHardCapUsdCents: k.remainingHardCapUsdCents };
    const chosen = selectRoute(k.candidates, opts);
    assert.equal(chosen, k.expected.chosen, `${k.id}: fixture choice must match the deterministic oracle`);
    // Same inputs in reverse order -> same route (a total order, no partial sort).
    assert.equal(selectRoute([...k.candidates].reverse(), opts), chosen, `${k.id}: order-independent`);
    assert.equal(k.expected.hasRationale, true, `${k.id}: carries a rationale`);
  }

  // Each score input is INDIVIDUALLY decisive — PROVEN computationally, not by a label.
  // With the full input set the oracle picks the expected winner; drop the one input the
  // case is meant to isolate and the winner MUST change. If dropping the term leaves the
  // winner unchanged, the case is confounded with the codepoint tiebreak (the winner was
  // codepoint-lowest anyway) and proves nothing — this assertion fails in that case.
  const sc = byId("selectionCases");
  const decisive = {
    "capabilityfit-decides": "capabilityFit",
    "cost-decides-when-fit-ties": "projectedCostUsdCents",
    "workload-decides-when-fit-and-cost-tie": "workloadDepth",
    "review-eligibility-decides-for-review-task": "reviewEligible",
  };
  for (const [id, input] of Object.entries(decisive)) {
    const k = sc.get(id);
    assert.ok(fixture.scoreInputs.includes(input), `${id}: decides on a declared score input`);
    assert.equal(k.expected.rationaleReferences, input, `${id}: rationale names the deciding factor`);
    const opts = { remainingHardCapUsdCents: k.remainingHardCapUsdCents };
    assert.equal(selectRoute(k.candidates, opts), k.expected.chosen, `${id}: full oracle picks the winner`);
    const without = ALL_INPUTS.filter((i) => i !== input);
    assert.notEqual(
      selectRoute(k.candidates, opts, without), k.expected.chosen,
      `${id}: dropping ${input} MUST flip the winner — else the case is confounded with the codepoint tiebreak and does not prove ${input} decisive`);
  }

  // Genuine ties are broken ONLY by codepoint -- assert the tie is real, not incidental.
  for (const id of ["tie-break-2way-codepoint", "tie-break-3way-codepoint"]) {
    const k = sc.get(id);
    const first = k.candidates[0];
    for (const c of k.candidates) {
      assert.equal(c.capabilityFit, first.capabilityFit, `${id}: fit ties`);
      assert.equal(c.projectedCostUsdCents, first.projectedCostUsdCents, `${id}: cost ties`);
      assert.equal(c.workloadDepth, first.workloadDepth, `${id}: workload ties`);
      assert.equal(!!c.reviewEligible, !!first.reviewEligible, `${id}: review-eligibility ties`);
    }
    assert.equal(k.expected.tieBrokenByCodepoint, true);
    assert.equal(k.expected.chosen, [...k.candidates].map((c) => c.agent).sort()[0], `${id}: codepoint-lowest wins`);
  }

  // Budget can force the SECOND-best: the top-fit candidate is hard-infeasible.
  const budget = sc.get("budget-forces-second-best");
  const infeasible = budget.candidates.find((c) => c.hardInfeasible);
  const winner = budget.candidates.find((c) => c.agent === budget.expected.chosen);
  assert.ok(infeasible.capabilityFit > winner.capabilityFit, "the excluded route was the higher-fit one");
  assert.equal(budget.expected.rationaleReferences, "budget");
});

test("determinism holds under re-ordering and a last-declared winner", () => {
  const dc = byId("determinismCases");
  assert.equal(dc.get("same-result-under-candidate-reordering").expected.orderIndependent, true);
  // Demonstrate order-independence on a real tie case.
  const tie = byId("selectionCases").get("tie-break-3way-codepoint").candidates;
  assert.equal(selectRoute(tie), selectRoute([...tie].reverse()));

  // The codepoint-lowest agent wins even when it is declared LAST in the array.
  const last = dc.get("codepoint-lowest-winner-declared-last");
  const cands = last.candidateOrder.map((agent) => ({
    agent, eligible: true, capabilityFit: 3, projectedCostUsdCents: 20, workloadDepth: 0, reviewEligible: true,
  }));
  assert.equal(cands[cands.length - 1].agent, last.expected.chosen, "winner really is last in the array");
  assert.equal(selectRoute(cands), last.expected.chosen);
});

test("a missing or non-finite score fails closed, never sorts as NaN", () => {
  const sv = byId("scoreValidityCases");
  const missing = sv.get("candidate-missing-score-excluded-fail-closed");
  assert.equal(missing.expected.excluded, true);
  assert.equal(missing.expected.sortsAsNaN, false);
  // The only candidate has no finite capabilityFit -> excluded -> nothing selected.
  assert.equal(selectRoute([missing.candidate]), null, "excluded, not ranked");

  const bad = sv.get("candidate-nonfinite-score-rejected");
  assert.equal(finiteNum(bad.candidate.projectedCostUsdCents), false, "the score is not a finite number");
  assert.equal(bad.expected.errorCode, "ROUTE_REQUEST_INVALID");
});

test("eligibility: empty/all-ineligible refuse with reasons; stale eligibility is re-checked at run", () => {
  const ec = byId("eligibilityCases");

  const empty = ec.get("empty-candidate-list");
  assert.equal(selectRoute(empty.candidates), null);
  assert.equal(empty.expected.errorCode, "NO_ELIGIBLE_AGENT");
  assert.equal(empty.expected.eligibleSetEmpty, true);

  const none = ec.get("all-ineligible-refuses-with-reasons");
  assert.equal(selectRoute(none.candidates), null, "oracle agrees nothing is eligible");
  assert.equal(none.expected.errorCode, "NO_ELIGIBLE_AGENT");
  assert.equal(none.expected.fallsBackToIneligible, false);
  assert.ok(none.candidates.every((c) => typeof c.exclusionReason === "string" && c.exclusionReason.length > 0),
    "every excluded candidate carries a concrete reason");
  assert.equal(none.expected.perCandidateReasonsNonEmpty, true);

  // A capability observed at selection is not an authorization at run.
  for (const id of ["route-lost-capability-before-run", "route-lost-budget-before-run"]) {
    const r = ec.get(id);
    assert.equal(r.eligibleAtSelection, true);
    assert.equal(r.eligibleAtRun, false);
    assert.equal(r.expected.errorCode, "ROUTE_INELIGIBLE_AT_RUN", `${id}: refuses on the stale snapshot`);
  }
  assert.equal(ec.get("route-lost-capability-before-run").expected.silentlyProceeded, false);

  // A prompt cannot name a real-but-ineligible engine into the route.
  const named = ec.get("prompt-named-ineligible-engine-refused");
  assert.equal(fixture.knownAgents.includes(named.promptNamedEngine), true, "it names a real agent");
  assert.equal(named.eligibleSet.includes(named.promptNamedEngine), false, "but one outside the eligible set");
  assert.equal(named.expected.errorCode, "PROMPT_NAMED_INELIGIBLE_ENGINE");
  assert.equal(named.expected.honored, false);

  // A prompt scoring hint cannot move the deterministic winner.
  const hint = ec.get("prompt-scoring-hint-ignored");
  assert.equal(hint.expected.chosen, hint.oracleWinnerWithoutHint);
  assert.equal(hint.expected.hintMovedSelection, false);

  // A candidate whose execution would exceed the task's authority ceiling is excluded.
  const ceiling = ec.get("candidate-over-task-authority-ceiling-excluded");
  assert.equal(ceiling.expected.excludedFromEligibleSet, true);
  assert.equal(ceiling.expected.exclusionReason, "EXCEEDS_TASK_AUTHORITY");
  assert.equal(ceiling.expected.chosenExceedsCeiling, false);

  // Autonomous work is scored against the SAME CONT-08 derived capability the dispatch needs.
  const auto = ec.get("autonomous-work-requires-unattended-eligible-set");
  assert.equal(auto.derivedCapability, "unattended");
  assert.equal(auto.expected.eligibleAgainstCapability, "unattended");
  assert.equal(auto.expected.notTerminal, true);
});

test("an agent is never routed to review its own work", () => {
  const sr = byId("selfReviewCases");

  // The author is the top-scored candidate and is STILL filtered out.
  const top = sr.get("author-top-scored-still-filtered");
  const author = top.candidates.find((c) => c.author);
  const other = top.candidates.find((c) => !c.author);
  assert.ok(author.capabilityFit > other.capabilityFit, "the author really was the higher-scored option");
  assert.equal(selectRoute(top.candidates), top.expected.chosen, "oracle filters the author before selecting");
  assert.equal(top.expected.chosen, other.agent);
  assert.equal(top.expected.authorFilteredDespiteTopScore, true);

  // The author is the only candidate -> refuse rather than self-review.
  const only = sr.get("author-only-candidate-refused");
  assert.equal(selectRoute(only.candidates), null, "nothing eligible once the author is filtered");
  assert.equal(only.expected.errorCode, "SELF_REVIEW_FORBIDDEN");
  assert.equal(only.expected.chosen, null);

  // Authorship unresolvable (CONT-04A ledger blocked) -> fail closed.
  const unres = sr.get("unresolvable-authorship-fails-closed");
  assert.equal(unres.authorshipResolvable, false);
  assert.equal(unres.expected.errorCode, "SELF_REVIEW_FORBIDDEN");
  assert.equal(unres.expected.failedClosed, true);
});

test("consequential work never silently downgrades; there is no automatic reroute", () => {
  const dc = byId("downgradeCases");
  const wait = dc.get("unavailable-route-awaits-choice-no-auto-reroute");
  assert.equal(wait.strongerAlternativeAvailable, true, "even a STRONGER route is available");
  assert.equal(wait.expected.errorCode, "ROUTE_UNAVAILABLE_AWAIT_CHOICE");
  assert.equal(wait.expected.autoRerouted, false, "no automatic reroute, even upward");
  assert.equal(wait.expected.reissuedByOperatorOrOwner, true, "only the operator/owner reissues via CONT-08");

  const restart = dc.get("restart-does-not-silently-reroute-queued-task");
  assert.equal(restart.expected.silentlyRerouted, false);
  assert.equal(restart.expected.returnsToExplicitSelection, true);
});

test("capacity is won through the atomic claim before dispatch; budget projects, never double-reserves", () => {
  const cb = byId("capacityBudgetCases");

  const race = cb.get("two-concurrent-routes-one-wins-claim");
  assert.equal(race.expected.winners, 1);
  assert.equal(race.expected.doubleLaunched, false);

  const toctou = cb.get("claim-lost-before-dispatch-toctou");
  assert.equal(toctou.wonClaimAtSelection, true);
  assert.equal(toctou.claimHeldByOtherAtDispatch, true);
  assert.equal(toctou.expected.errorCode, "CLAIM_UNAVAILABLE");
  assert.equal(toctou.expected.launched, false);

  const released = cb.get("claim-released-on-failed-dispatch");
  assert.equal(released.expected.claimReleased, true);
  assert.equal(released.expected.orphanedUntilTtl, false);

  const match = cb.get("claim-engine-matches-handoff-target");
  assert.equal(match.chosen, match.claimEngine);
  assert.equal(match.claimEngine, match.handoffTarget);
  assert.equal(match.expected.targetMatchesClaim, true);

  // Hard-infeasible (over the hard cap) is a silent exclusion WITH the projection shown.
  const hard = cb.get("budget-hard-infeasible-route-excluded");
  assert.ok(hard.projectedCostUsdCents > hard.remainingHardCapUsdCents, "genuinely over the hard cap");
  assert.equal(hard.expected.eligible, false);
  assert.equal(hard.expected.projectionShown, true);

  // Over a STANDING GRANT (but under the hard cap) is operator-confirmable, not excluded.
  const over = cb.get("budget-over-standing-grant-surfaces-confirmation");
  assert.ok(over.projectedCostUsdCents > over.standingGrantUsdCents, "over the standing grant");
  assert.ok(over.projectedCostUsdCents <= over.remainingHardCapUsdCents, "but within the hard cap");
  assert.equal(over.expected.errorCode, "SPEND_CONFIRMATION_REQUIRED");
  assert.equal(over.expected.silentlyExcluded, false);

  // Routing only PROJECTS; the single CONT-07 hold is CONT-08's reservation (one hold).
  const once = cb.get("routing-projects-cont08-reserves-once");
  assert.equal(once.expected.routingPlacesSecondHold, false);
  assert.equal(once.expected.singleReservationIsCont08, true);

  // Dispatch goes through the structured CONT-08 handoff, never free text.
  const dispatch = cb.get("dispatch-through-structured-handoff-not-freetext");
  assert.equal(dispatch.expected.dispatchVia, "CONT-08-handoff");
  assert.equal(dispatch.expected.freeText, false);
});

test("every declared code has a case AND a concrete envelope with a matching error.code", () => {
  const codesOnCases = new Set([
    ...allCases().map((k) => k.code).filter(Boolean),
    ...allCases().map((k) => k.expected && k.expected.errorCode).filter(Boolean),
  ]);
  for (const c of fixture.codes) assert.ok(codesOnCases.has(c), `code ${c} is never exercised by a case`);
  for (const c of codesOnCases) assert.ok(fixture.codes.includes(c), `undeclared code ${c} appears in a case`);

  const envByCode = new Map(fixture.envelopeCases.filter((k) => k.code).map((k) => [k.code, k]));
  for (const c of fixture.codes) assert.ok(envByCode.has(c), `code ${c} needs a concrete envelope`);

  for (const k of fixture.envelopeCases) {
    const env = k.expected;
    assert.ok(["success", "warning", "error"].includes(env.status), `${k.id}: valid status`);
    assert.ok(typeof env.summary === "string" && env.summary.length > 0 && env.summary.length <= 200, `${k.id}: summary`);
    assert.ok(Array.isArray(env.next_actions) && Array.isArray(env.artifacts), `${k.id}: envelope arrays`);
    if (env.status === "error") {
      assert.equal(env.error.code, k.code, `${k.id}: error.code must match the case code`);
      assert.ok(env.error.retry.length > 0 && env.error.stopCondition.length > 0, `${k.id}: full error triplet`);
    }
  }
});

test("a seeded credential injected into an input never reaches any output", () => {
  const secret = fixture.seededSecret;
  // The contract-level guarantee: no expected output anywhere carries the secret.
  const expectedOnly = JSON.stringify(allCases().map((k) => k.expected ?? null));
  assert.equal(expectedOnly.includes(secret), false, "seeded secret must be absent from every expected output");

  // The scrub case models the secret injected into a candidate/rationale field.
  const scrub = byId("secretInputCases").get("secret-injected-into-candidate-field-scrubbed");
  assert.equal(scrub.injectValueIsSeededSecret, true);
  assert.equal(scrub.expected.rationaleContainsSecret, false);
  assert.equal(scrub.expected.artifactContainsSecret, false);
  assert.equal(scrub.expected.perCandidateReasonContainsSecret, false);
});
