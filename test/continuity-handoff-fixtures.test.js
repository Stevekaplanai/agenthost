import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// The REAL chain guard from the box -- so "a handoff is one chains-lib hop; ceilings
// block, they are not reinvented" is derived against the actual canRun(), not a
// hand-set errorCode that could contradict the machinery it claims to defer to.
import { newChain, canRun } from "../container/chains-lib.js";

// CONT-08 cross-engine handoff contract fixtures (hardened 2026-07-22 after a
// four-agent adversarial red-team; see docs/continuity/CONT-08-REDTEAM-LOG.md).
// Contract: docs/continuity/HANDOFF-CONTRACT.md (CONT-08, v1).
//
// These are contract fixtures, not a runtime. They freeze the behaviors the later
// handoff runtime must satisfy: a handoff is a typed, server-owned record that the
// AUTHENTICATED target accepts exactly once, under its own live-profile authority,
// with capability DERIVED from the work and re-checked at acceptance and effect,
// counting as one chains-lib.js hop, and carrying none of the sender's authority.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_FILE = path.join(HERE, "fixtures", "handoff-contract-v1.json");
const fixture = JSON.parse(fs.readFileSync(FIXTURE_FILE, "utf8"));

const ARRAYS = [
  "creationCases", "derivedCapabilityCases", "acceptanceCases", "artifactCases",
  "chainCases", "senderResultCases", "stateCases", "authorityCases",
  "secretInputCases", "envelopeCases",
];
function allCases() {
  return ARRAYS.flatMap((k) => fixture[k]);
}
function byId(arr) {
  return new Map(fixture[arr].map((k) => [k.id, k]));
}

test("handoff fixture has one versioned, collision-free case catalog", () => {
  assert.equal(fixture.$schema, "agenthost-continuity-handoff-fixtures-v1");
  assert.equal(fixture.contractId, "CONT-08");
  assert.equal(fixture.contractVersion, 1);
  const ids = allCases().map((k) => k.id);
  assert.equal(new Set(ids).size, ids.length, "case IDs must be globally unique");
  assert.ok(ids.length >= 40, "the hardened corpus needs a meaningful attack surface");
});

test("roster, enums, and terminal states match the contract exactly", () => {
  assert.deepEqual(fixture.knownAgents, ["claude", "codex", "gemini", "hermes", "kimi"]);
  assert.equal(fixture.knownAgents.includes("ollama"), false);
  assert.equal(fixture.knownAgents.includes("openclaw"), false);
  assert.deepEqual(fixture.expectedOutputEnum, ["unified-diff", "review-verdict", "report", "artifact-set", "chat-reply"]);
  assert.deepEqual(fixture.reviewRequirementEnum, ["none", "cross-engine", "security"]);
  // gitMaxRung carries a level form, not a bare boolean flag (red-team B3).
  assert.deepEqual(fixture.capabilityEnum, ["chat", "review", "terminal", "unattended", "gitMaxRung:<n>"]);
  assert.ok(fixture.capabilityEnum.includes("gitMaxRung:<n>"));
  assert.equal(fixture.capabilityEnum.includes("gitMaxRung"), false, "bare gitMaxRung would allow rung escalation");
  assert.deepEqual(fixture.terminalStates, ["completed", "rejected", "expired", "cancelled"]);
});

// Unconditional outputs (chat/review) derive from derivedCapabilityMap; unified-diff
// and artifact-set are conditional on `autonomous` (CONT-06 reconciliation: autonomous
// execution needs `unattended`, never merely `terminal`, or the authorized rung is
// bypassed for exactly the work it exists to gate).
function expectedDerivedCapability(expectedOutput, autonomous) {
  if (expectedOutput in fixture.derivedCapabilityMap) return fixture.derivedCapabilityMap[expectedOutput];
  return autonomous ? fixture.autonomousOutputDerivedCapabilityMap[expectedOutput]
    : fixture.reviewedOutputDerivedCapabilityMap[expectedOutput];
}

test("capability is derived from the work, and terminal is never an autonomous-execution licence", () => {
  assert.deepEqual(fixture.derivedCapabilityMap, { "chat-reply": "chat", "report": "chat", "review-verdict": "review" });
  assert.deepEqual(fixture.reviewedOutputDerivedCapabilityMap, { "unified-diff": "terminal", "artifact-set": "terminal" });
  assert.deepEqual(fixture.autonomousOutputDerivedCapabilityMap, { "unified-diff": "unattended", "artifact-set": "unattended" });
  // Every expectedOutput enum value derives a capability in at least one mode.
  for (const out of fixture.expectedOutputEnum)
    assert.ok(
      fixture.derivedCapabilityMap[out] || fixture.reviewedOutputDerivedCapabilityMap[out],
      `${out} must derive a capability`,
    );
  // The derive cases agree with the (possibly autonomous-conditional) mapping.
  for (const k of fixture.derivedCapabilityCases)
    assert.equal(k.expectedCapability, expectedDerivedCapability(k.expectedOutput, k.autonomous), `${k.id} derives wrongly`);
  // Valid creations store the DERIVED capability, never a caller label, and diff/
  // artifact-set outputs specifically flip terminal->unattended when autonomous:true.
  for (const k of fixture.creationCases.filter((c) => c.accepted))
    assert.equal(
      k.expected.derivedCapability,
      expectedDerivedCapability(k.request.expectedOutput, k.request.autonomous),
      `${k.id}`,
    );
  // Directly pin the reconciliation: same expectedOutput, autonomous flips terminal<->unattended.
  const cc = new Map(fixture.creationCases.map((c) => [c.id, c]));
  assert.equal(cc.get("create-valid-diff-handoff-human-reviewed").expected.derivedCapability, "terminal");
  assert.equal(cc.get("create-valid-diff-handoff-autonomous-needs-unattended").expected.derivedCapability, "unattended");
});

test("all eleven server-minted fields are unforgeable, checked unconditionally", () => {
  const expanded = ["id", "runId", "chainId", "parentHandoffId", "reissuedFrom",
    "createdAt", "expiresAt", "acceptedBy", "acceptedAt", "acceptanceToken", "effectKey"];
  assert.deepEqual(fixture.serverMintedFields, expanded);
  // Every rejection case that supplies a server-minted field must fail the same way.
  for (const k of fixture.creationCases) {
    if (k.accepted) continue;
    for (const field of fixture.serverMintedFields) {
      if (Object.prototype.hasOwnProperty.call(k.request, field)) {
        assert.equal(k.errorCode, "HANDOFF_REQUEST_INVALID", `${k.id} supplies ${field}`);
        assert.match(k.errorContains, /server-minted/);
      }
    }
  }
  // The critical ids/token/timestamp each have an explicit probe.
  const cc = byId("creationCases");
  for (const req of ["reject-server-minted-id-supplied", "reject-server-minted-runid-supplied",
    "reject-server-minted-chainid-supplied", "reject-server-minted-token-supplied",
    "reject-server-minted-createdat-supplied"])
    assert.ok(cc.has(req), `missing server-minted probe ${req}`);
});

test("each creation rejection carries its specific stable error code (not just any code)", () => {
  const expect = {
    "reject-server-minted-id-supplied": "HANDOFF_REQUEST_INVALID",
    "reject-unknown-source-agent": "UNKNOWN_AGENT",
    "reject-unknown-target-agent": "UNKNOWN_AGENT",
    "reject-unknown-expected-output": "HANDOFF_REQUEST_INVALID",
    "reject-freetext-taskid": "HANDOFF_REQUEST_INVALID",
    "reject-missing-required-field": "HANDOFF_REQUEST_INVALID",
    "reject-capability-hint-weaker-than-derived": "HANDOFF_REQUEST_INVALID",
    "reject-out-of-enum-capability-hint": "HANDOFF_REQUEST_INVALID",
    "reject-out-of-enum-review-requirement": "HANDOFF_REQUEST_INVALID",
    "reject-context-too-large": "CONTEXT_TOO_LARGE",
    "reject-too-many-artifacts": "HANDOFF_REQUEST_INVALID",
    "reject-nonpositive-expiry-window": "HANDOFF_REQUEST_INVALID",
    "reject-expiry-window-too-long": "HANDOFF_REQUEST_INVALID",
    "reject-self-review-same-agent-crossengine": "SELF_REVIEW_FORBIDDEN",
    "reject-self-review-same-agent-none": "SELF_REVIEW_FORBIDDEN",
    "reject-self-review-security": "SELF_REVIEW_FORBIDDEN",
    "reject-self-review-resolved-authorship": "SELF_REVIEW_FORBIDDEN",
    "reject-budget-reservation-over-standing": "BUDGET_RESERVATION_INVALID",
    "reject-budget-reservation-over-effective-cap": "BUDGET_RESERVATION_INVALID",
    "reject-budget-reservation-over-held-total": "BUDGET_RESERVATION_INVALID",
    "reject-budget-reservation-over-token-cap": "BUDGET_RESERVATION_INVALID",
    "reject-artifact-path-traversal": "HANDOFF_REQUEST_INVALID",
    "reject-artifact-absolute-path": "HANDOFF_REQUEST_INVALID",
    "reject-artifact-symlink-escape": "HANDOFF_REQUEST_INVALID",
  };
  const cc = byId("creationCases");
  for (const [id, code] of Object.entries(expect)) {
    assert.ok(cc.has(id), `missing creation case ${id}`);
    assert.equal(cc.get(id).errorCode, code, `${id} must return ${code}`);
    assert.ok(cc.get(id).errorContains, `${id} needs a deterministic error substring`);
  }
});

test("self-review is forbidden by the nature of the work, independent of reviewRequirement", () => {
  const cc = byId("creationCases");
  // Same-agent review is blocked for none / cross-engine / security alike.
  for (const rr of ["none", "cross-engine", "security"]) {
    const hit = fixture.creationCases.find(
      (k) => !k.accepted && k.request.source === k.request.target &&
        k.request.expectedOutput === "review-verdict" && k.request.reviewRequirement === rr);
    assert.ok(hit, `need a same-agent review-verdict rejection for reviewRequirement:${rr}`);
    assert.equal(hit.errorCode, "SELF_REVIEW_FORBIDDEN");
  }
  // Authorship is resolved server-side, not from caller input.
  const authored = cc.get("reject-self-review-resolved-authorship");
  assert.equal(authored.ledgerAuthorOfArtifact, "codex");
  assert.equal(authored.request.target, "codex");
  assert.equal(authored.request.artifacts.some((a) => "authoredBy" in a), false,
    "authorship must not be a caller-supplied artifact field");
  // Unresolvable authorship (ledger BLOCKED) FAILS CLOSED -- never accepts on unknown.
  const unresolvable = cc.get("reject-self-review-unresolvable-authorship-failsclosed");
  assert.equal(unresolvable.authorshipResolvable, false);
  assert.equal(unresolvable.ledgerAuthorOfArtifact, null);
  assert.equal(unresolvable.errorCode, "SELF_REVIEW_FORBIDDEN", "unknown authorship must fail closed, not accept");
});

test("caller-supplied capability hint may not be weaker than the derived capability", () => {
  const k = byId("creationCases").get("reject-capability-hint-weaker-than-derived");
  assert.equal(k.request.expectedOutput, "review-verdict");
  assert.equal(k.request.capabilityHint, "chat");
  assert.equal(k.errorCode, "HANDOFF_REQUEST_INVALID");
});

test("limits are pinned exactly, including the boundary and off-by-one guards", () => {
  const L = fixture.limits;
  assert.equal(L.contextSummaryMaxChars, 4000);
  assert.equal(L.artifactsMax, 32);
  assert.equal(L.expiryWindowMaxSeconds, 86400);
  assert.equal(L.reissueMaxPerChain, 3);
  const cc = byId("creationCases");
  assert.equal(cc.get("reject-context-too-large").request.contextSummaryLength, L.contextSummaryMaxChars + 1);
  assert.equal(cc.get("reject-too-many-artifacts").request.artifactCount, L.artifactsMax + 1);
  assert.equal(cc.get("reject-expiry-window-too-long").request.expiryWindowSeconds, L.expiryWindowMaxSeconds + 1);
  // Inclusive boundary: exactly-at-max is accepted.
  assert.equal(cc.get("create-valid-report-handoff-atmax-expiry").request.expiryWindowSeconds, L.expiryWindowMaxSeconds);
  for (const k of fixture.creationCases.filter((c) => c.accepted)) {
    const w = k.request.expiryWindowSeconds;
    assert.ok(w > 0 && w <= L.expiryWindowMaxSeconds, `${k.id} expiry window in range`);
  }
});

test("only the authenticated target accepts, exactly once, minting one durable token", () => {
  const ac = byId("acceptanceCases");
  const once = ac.get("accept-once-success");
  assert.equal(once.callerIdentity, once.handoff.target);
  assert.equal(once.expected.accepted, true);
  assert.equal(once.expected.mintsToken, true);
  assert.equal(once.expected.recordsEffectKeyBeforeEffect, true);

  const deputy = ac.get("accept-by-non-target-blocked");
  assert.notEqual(deputy.callerIdentity, deputy.handoff.target);
  assert.equal(deputy.expected.errorCode, "ACCEPTOR_NOT_TARGET");

  const dup = ac.get("accept-duplicate-blocked");
  assert.equal(dup.expected.errorCode, "DUPLICATE_ACCEPTANCE");
  assert.equal(dup.expected.mintsToken, false);

  const replay = ac.get("accept-restart-idempotent-replay");
  assert.equal(replay.expected.mintsToken, false);
  assert.equal(replay.expected.returnsSameToken, replay.handoff.acceptanceToken);
});

test("the effect is idempotent across a crash between effect and completion", () => {
  const k = byId("acceptanceCases").get("effect-idempotent-after-crash");
  assert.equal(k.crashBetweenEffectAndCompletion, true);
  assert.equal(k.expected.reEmitsEffect, false);
  assert.equal(k.expected.returnsRecordedResult, true);
  assert.equal(k.expected.usesEffectKey, k.handoff.effectKey);
});

test("capability is re-checked at acceptance AND at effect time, against the live profile", () => {
  const ac = byId("acceptanceCases");
  const lost = ac.get("accept-capability-lost-after-creation-blocked");
  assert.equal(lost.handoff.capabilityAtCreation, "available");
  assert.equal(lost.targetCapabilityAvailable, false);
  assert.equal(lost.expected.errorCode, "CAPABILITY_UNAVAILABLE");

  const revoked = ac.get("capability-revoked-at-effect-blocked");
  assert.equal(revoked.capabilityAtAcceptance, true);
  assert.equal(revoked.capabilityAtEffect, false);
  assert.equal(revoked.expected.effectEmitted, false);
  assert.equal(revoked.expected.state, "blocked");

  const expired = ac.get("accept-after-expiry-blocked");
  assert.equal(expired.expected.errorCode, "HANDOFF_EXPIRED");
  assert.equal(expired.expected.state, "expired");
  assert.equal(ac.get("accept-target-unavailable-blocked").expected.errorCode, "TARGET_UNAVAILABLE");
});

test("gitMaxRung requires a level comparison, not a boolean", () => {
  const ac = byId("acceptanceCases");
  const ok = ac.get("accept-gitrung-level-sufficient");
  assert.equal(ok.handoff.derivedCapability, "gitMaxRung:2");
  assert.ok(ok.targetProfileGitRung.value >= 2 && ok.targetProfileGitRung.state === "available");
  assert.equal(ok.expected.accepted, true);

  const no = ac.get("accept-gitrung-level-insufficient-blocked");
  assert.equal(no.handoff.derivedCapability, "gitMaxRung:5");
  assert.ok(no.targetProfileGitRung.value < 5);
  assert.equal(no.expected.errorCode, "CAPABILITY_UNAVAILABLE");
});

test("kimi's unavailability derives from its live profile, never from prose", () => {
  const ac = byId("acceptanceCases");
  const review = ac.get("accept-kimi-review-unavailable-from-profile");
  assert.equal(review.handoff.target, "kimi");
  assert.equal(review.targetProfileCapabilities.review, "unavailable");
  assert.equal(review.expected.errorCode, "CAPABILITY_UNAVAILABLE");
  // Current baseline: even chat is NOT_WIRED, so a chat handoff to kimi also fails.
  const chat = ac.get("accept-kimi-chat-unavailable-baseline");
  assert.equal(chat.targetProfileCapabilities.chat, "unavailable");
  assert.equal(chat.expected.errorCode, "CAPABILITY_UNAVAILABLE");
});

test("artifact paths are contained and revisions are read-bound, re-checked at completion", () => {
  const ar = byId("artifactCases");
  assert.equal(ar.get("artifact-resolves-ok").readFromImmutableObject, true);
  assert.equal(ar.get("artifact-missing-blocked").expected.errorCode, "ARTIFACT_MISSING");
  assert.equal(ar.get("artifact-revision-changed-at-acceptance").expected.errorCode, "ARTIFACT_REVISION_CHANGED");
  const late = ar.get("artifact-revision-changed-at-completion");
  assert.equal(late.revisionMatchesAtAcceptance, true);
  assert.equal(late.revisionMatchesAtCompletion, false);
  assert.equal(late.expected.errorCode, "ARTIFACT_REVISION_CHANGED");
  // Path containment probes live in creationCases (rejected before a record exists).
  const cc = byId("creationCases");
  for (const id of ["reject-artifact-path-traversal", "reject-artifact-absolute-path", "reject-artifact-symlink-escape"])
    assert.equal(cc.get(id).errorCode, "HANDOFF_REQUEST_INVALID");
});

test("a handoff is one chains-lib hop; chain ceilings block, they are not reinvented", () => {
  const ch = byId("chainCases");
  assert.equal(ch.get("chain-propagation-inherits-chainid").expected.chainId, "chain_1");
  assert.equal(ch.get("chain-propagation-inherits-chainid").expected.parentHandoffId, "ho_parent");
  assert.equal(ch.get("chain-fresh-originating-mints-new-chainid").expected.parentHandoffId, null);
  for (const id of ["chain-hop-limit-blocked", "chain-same-pair-third-hop-blocked",
    "chain-loop-objective-repeat-blocked", "chain-cost-cap-blocked"])
    assert.equal(ch.get(id).expected.errorCode, "HANDOFF_CHAIN_LIMIT", `${id}`);

  // DERIVE the same-pair cases against the REAL chains-lib canRun() so the fixture data
  // cannot silently contradict the guard it defers to. Build the chain's trailing hops in
  // chains-lib's own "from>to" format, then ask canRun about the new hop.
  const T = 1_000_000;
  const runHop = (recentPairs, newHop) => {
    const chain = newChain(T);
    chain.hops = recentPairs.map((p) => p.split("->").join(">"));
    const [fromEngine, assignee] = newHop.split("->");
    return canRun(chain, { assignee, objective: "advance-the-unique-task", fromEngine }, T);
  };
  const blocked = ch.get("chain-same-pair-third-hop-blocked");
  const bv = runHop(blocked.chainState.recentPairs, blocked.newHop);
  assert.equal(bv.ok, false, "a genuine 3rd consecutive same-pair hop is blocked by the real guard");
  assert.match(bv.reason, /pingpong/, "blocked as handoff_pingpong, matching HANDOFF_CHAIN_LIMIT");
  const allowed = ch.get("chain-alternating-pair-allowed");
  const av = runHop(allowed.chainState.recentPairs, allowed.newHop);
  assert.equal(av.ok, true, "A->B->A->B is allowed by the real guard (locks the contract's :200 claim)");
  assert.equal(allowed.expected.accepted, true);
});

test("a changed sender result blocks acceptance rather than acting on stale work", () => {
  const stale = byId("senderResultCases").get("stale-sender-result-blocked");
  assert.notEqual(stale.handoff.senderResultRevisionAtCreation, stale.senderResultRevisionNow);
  assert.equal(stale.expected.errorCode, "STALE_SENDER_RESULT");
});

test("the state machine covers every terminal state, the lease exit, cancel, and reissue", () => {
  const st = byId("stateCases");
  // All four terminal states are represented and marked terminal.
  const terminalById = {
    "state-completed-terminal": "completed",
    "state-rejected-terminal": "rejected",
    "state-expired-terminal": "expired",
    "state-cancel-cascade-to-cancelled": "cancelled",
  };
  const seen = new Set();
  for (const [id, s] of Object.entries(terminalById)) {
    assert.equal(st.get(id).expected.state, s);
    assert.equal(st.get(id).expected.terminal, true, `${id} must be terminal`);
    seen.add(s);
  }
  assert.deepEqual([...seen].sort(), [...fixture.terminalStates].sort());

  // No second terminal completion.
  assert.equal(st.get("state-second-terminal-completion-refused").expected.refused, true);

  // Orphaned accepted has an exit: lease breach / target fault -> blocked, releasing the reservation.
  for (const id of ["state-lease-breach-to-blocked", "state-target-fault-to-blocked"]) {
    assert.equal(st.get(id).expected.state, "blocked");
    assert.equal(st.get(id).expected.reservationReleased, true);
    assert.equal(st.get(id).expected.returnsControlToRun, true);
  }
  assert.equal(st.get("state-lease-breach-to-blocked").expected.emitsInboxAttentionItem, true);

  // Cancel signals through the STOP gate, never by inheriting authority over the target.
  const cancel = st.get("state-cancel-cascade-to-cancelled");
  assert.equal(cancel.expected.signalsTargetViaStopGate, true);
  assert.equal(cancel.expected.inheritsAuthorityOverTarget, false);

  // Reissue mints a NEW id under the SAME chain, re-pins revision; re-accepting the blocked id is forbidden.
  const re = st.get("state-blocked-reissue-new-id-same-chain");
  assert.equal(re.expected.newId, true);
  assert.equal(re.expected.sameChainId, true);
  assert.equal(re.expected.rePinsRevision, true);
  assert.equal(st.get("state-reaccept-blocked-id-forbidden").expected.refused, true);
  assert.equal(st.get("state-reissue-limit-blocked").expected.errorCode, "HANDOFF_REISSUE_LIMIT");
});

test("no sender authority is present on the accepted record (tied, not a hand-written boolean)", () => {
  const required = ["credential", "worktreeLease", "claimToken", "autonomyLevel", "reviewExemption", "gitMaxRung"];
  const byField = new Map(fixture.authorityCases.map((k) => [k.field, k]));
  for (const f of required) {
    assert.ok(byField.has(f), `missing authority case for ${f}`);
    assert.equal(byField.get(f).sourceHas, true, `${f}: model a source that holds it`);
    assert.equal(byField.get(f).presentOnAcceptedRecord, false, `${f} must be absent from the accepted record`);
  }
});

test("a secret planted in contextSummary never surfaces in the record or chain", () => {
  const k = byId("secretInputCases").get("secret-in-context-summary-scrubbed");
  assert.equal(k.injectField, "contextSummary");
  assert.equal(k.expected.recordStoresRawSecret, false);
  assert.equal(k.expected.inboxItemStoresRawSecret, false);
  assert.equal(k.expected.influencesAuthority, false);
});

test("every response envelope is deterministic and errors explain retry plus stop", () => {
  const codesCovered = new Set();
  for (const k of fixture.envelopeCases) {
    const env = k.expected;
    assert.ok(["success", "warning", "error"].includes(env.status));
    assert.ok(typeof env.summary === "string" && env.summary.length > 0 && env.summary.length <= 200,
      `${k.id} summary is one bounded sentence`);
    assert.ok(Array.isArray(env.next_actions) && Array.isArray(env.artifacts));
    if (env.status === "error") {
      assert.equal(typeof env.error.code, "string");
      assert.ok(env.error.retry.length > 0 && env.error.stopCondition.length > 0, `${k.id} triplet`);
      codesCovered.add(env.error.code);
    }
  }
  // The security-critical codes each get a concrete, reviewable envelope.
  for (const c of ["DUPLICATE_ACCEPTANCE", "CAPABILITY_UNAVAILABLE", "ACCEPTOR_NOT_TARGET",
    "HANDOFF_CHAIN_LIMIT", "SELF_REVIEW_FORBIDDEN", "BUDGET_RESERVATION_INVALID"])
    assert.ok(codesCovered.has(c), `need a concrete envelope for ${c}`);
});

test("seeded credential never appears in any expected output, error, or artifact", () => {
  const secret = fixture.seededSecret;
  // Scan expected outputs only (a red-team probe may legitimately place the secret in
  // an input field; the guarantee is that it never reaches an expected output/record).
  const expectedOnly = JSON.stringify(allCases().map((k) => k.expected ?? null));
  assert.equal(expectedOnly.includes(secret), false);
});
