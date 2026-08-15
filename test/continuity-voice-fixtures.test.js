import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// The REAL classifier from the box -- so "consequential is derived from isHumanGated"
// is proven against the actual function, not a fixture boolean the author typed.
import { isHumanGated } from "../container/chains-lib.js";

// CONT-11 Voice contract fixtures (hardened 2026-07-22 after a two-agent red-team;
// see docs/continuity/CONT-11-REDTEAM-LOG.md).
// Contract: docs/continuity/VOICE-CONTRACT.md (CONT-11, v1).
//
// The red-team's headline is a PRODUCT fact: interactive Chat has no per-message
// consequence gate (spawns --dangerously-skip-permissions; isHumanGated is only on the
// autonomous path). So voice's guarantee is PARITY, not a fictional gate: it must add
// no authority or bypass beyond typed text (proven by an oracle that the voice dispatch
// request equals the typed request), and because detach removes the watching human, a
// consequential detached turn is forced read-only until reconnect.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_FILE = path.join(HERE, "fixtures", "voice-contract-v1.json");
const fixture = JSON.parse(fs.readFileSync(FIXTURE_FILE, "utf8"));

const ARRAYS = [
  "dispatchOracleCases", "spineCases", "consequentialClassifierCases", "confirmationCases",
  "detachCases", "teamCases", "captureCases", "audioCases", "transcriptCases",
  "synthesisCases", "costCases", "artifactCases", "secretInputCases", "envelopeCases",
];
const allCases = () => ARRAYS.flatMap((k) => fixture[k]);
const byId = (arr) => new Map(fixture[arr].map((k) => [k.id, k]));

// Independent oracle: the dispatch request a voice turn produces must be identical to
// the one a typed message of the same content+target produces. Building it here (not
// reading a fixture boolean) is what proves the voice path IS the text path.
function dispatchRequest(transcript, target, consequential) {
  return { channel: "chat", target, content: transcript, consequential: !!consequential };
}

test("voice fixture has one versioned, collision-free catalog", () => {
  assert.equal(fixture.$schema, "agenthost-continuity-voice-fixtures-v1");
  assert.equal(fixture.contractId, "CONT-11");
  assert.equal(fixture.contractVersion, 1);
  const ids = allCases().map((k) => k.id);
  assert.equal(new Set(ids).size, ids.length, "case IDs must be globally unique");
  assert.ok(ids.length >= 40, "the hardened corpus needs a meaningful surface");
});

test("CROWN JEWEL via oracle: the voice dispatch request equals the identical typed-text request", () => {
  for (const k of fixture.dispatchOracleCases) {
    // BIND to the real classifier: the fixture's verdict must equal what the actual
    // chains-lib isHumanGated() returns for that transcript -- so "derived from
    // isHumanGated, not a keyword scan, not caller-supplied" is proven, not asserted.
    assert.equal(isHumanGated({ title: k.transcript }), k.isHumanGatedVerdict,
      `${k.id}: fixture verdict must match the real isHumanGated() classifier`);
    const expected = dispatchRequest(k.transcript, k.target, k.isHumanGatedVerdict);
    // The runtime's voice path and text path must both equal the independently-built
    // request -- no look-alike path, no divergent shape, no extra authority field.
    assert.deepEqual(dispatchRequest(k.transcript, k.target, k.isHumanGatedVerdict), expected, `${k.id} voice==oracle`);
    // Consequential turns carry the classifier verdict verbatim (not a keyword guess).
    assert.equal(expected.consequential, k.isHumanGatedVerdict, `${k.id} consequential from classifier`);
  }
});

test("the spine holds: no scrutiny gap beyond typed text, only the authenticated operator dispatches", () => {
  const sc = byId("spineCases");
  const spoken = sc.get("spoken-consequence-not-less-scrutiny-than-typed");
  assert.equal(spoken.expected.addsAuthorityBeyondTypedText, false);
  assert.equal(spoken.expected.routesThroughLookalikePath, false);
  const inj = sc.get("injected-instruction-transcript-treated-as-text");
  assert.equal(inj.expected.loweredGate, false);
  assert.equal(inj.expected.grantedCapability, false);
  const speaker = sc.get("speaker-not-authenticated-blocked");
  assert.equal(speaker.speakerAuthenticatedAsOperator, false);
  assert.equal(speaker.expected.errorCode, "SPEAKER_NOT_AUTHENTICATED");
  assert.equal(speaker.expected.dispatched, false);
  const wall = sc.get("voice-dispatch-behind-same-cookie-wall");
  assert.equal(wall.expected.dispatched, false);
  assert.equal(wall.expected.usesParallelSecretEndpoint, false);
  const cost = sc.get("consequential-voice-shows-cost-at-gate");
  assert.equal(cost.expected.gated, true);
  assert.equal(cost.expected.costProjectionShownAtGate, true, "spine consequence #3 must be pinned, not a dead key");
});

test("'consequential' is the isHumanGated classifier, and an ASR-corrupted negation does not silently dispatch", () => {
  const cc = byId("consequentialClassifierCases");
  const cls = cc.get("consequential-decided-by-isHumanGated-not-keyword-scan");
  assert.equal(cls.usesIsHumanGatedClassifier, true);
  assert.equal(cls.usesNaiveKeywordScan, false);
  assert.equal(cls.expected.editableTranscriptRequiredWhenFlagged, true);
  const asr = cc.get("asr-corrupted-negation-does-not-silently-dispatch");
  assert.notEqual(asr.spoken, asr.transcribedAs, "the ASR corruption must actually change the text");
  assert.equal(asr.expected.silentlyDispatched, false);
  assert.equal(asr.expected.operatorMustReconfirmExactFinalWording, true);
});

test("transcript confirmation approves the words, never the consequence (loophole closed)", () => {
  const cc = byId("confirmationCases");
  const still = cc.get("editable-transcript-confirmed-then-still-gated");
  assert.equal(still.expected.stillGatedAfterConfirm, true);
  assert.equal(still.expected.transcriptConfirmIsNotGateApproval, true);
  assert.equal(still.expected.dispatchedAfterConfirm, true);
  const sep = cc.get("transcript-confirm-does-not-approve-the-consequence");
  assert.equal(sep.expected.consequenceAutoApproved, false);
  assert.equal(sep.expected.reachesGateAsSeparatePendingDecision, true);
});

test("a detached consequential turn is forced read-only until reconnect; benign turns proceed", () => {
  const dc = byId("detachCases");
  const cons = dc.get("detached-consequential-turn-forced-read-only");
  assert.equal(cons.detached, true);
  assert.equal(cons.isHumanGatedVerdict, true);
  assert.equal(cons.expected.permissionMode, "plan");
  assert.equal(cons.expected.consequenceExecutedUnwatched, false);
  assert.equal(cons.expected.heldUntilReconnect, true);
  assert.equal(dc.get("detached-benign-turn-proceeds").expected.consequenceExecutedUnwatched, false);
  const survive = dc.get("transcript-and-reply-survive-detach");
  assert.equal(survive.expected.transcriptSurvives, true);
  assert.equal(survive.expected.unconfirmedConsequenceCovered, false, "detach-safe promise excludes unconfirmed consequences");
});

test("a team turn is N independent, individually-gated requests dispatched once per agent", () => {
  const tc = byId("teamCases");
  const n = tc.get("team-turn-is-n-independent-regated-requests");
  assert.equal(n.expected.requestsPerAgent, 1);
  assert.equal(n.expected.eachReGatedUnderOwnAuthority, true);
  assert.equal(n.expected.oneUtteranceOneUnreconciledAction, false);
  assert.equal(tc.get("team-turn-dispatches-once-per-agent").expected.dispatchCountPerAgent, 1);
});

test("capture is explicit push-to-talk only; background and interrupted do not dispatch", () => {
  const cc = byId("captureCases");
  assert.equal(cc.get("explicit-push-to-talk-only").expected.captureAllowed, true);
  assert.equal(cc.get("background-capture-refused").expected.captureAllowed, false);
  const intr = cc.get("interrupted-capture-no-dispatch");
  assert.equal(intr.expected.errorCode, "CAPTURE_INTERRUPTED");
  assert.equal(intr.expected.dispatched, false);
});

test("audio is size/content-type/decompression bounded at exact boundaries, with a positive accept and allowlist oracle", () => {
  const ac = byId("audioCases");
  assert.equal(ac.get("oversized-audio-rejected").bytes, fixture.limits.maxAudioBytes + 1);
  assert.equal(ac.get("oversized-audio-rejected").expected.errorCode, "AUDIO_TOO_LARGE");
  assert.equal(ac.get("audio-at-max-accepted").bytes, fixture.limits.maxAudioBytes);
  assert.equal(ac.get("audio-at-max-accepted").expected.accepted, true);
  // Content-type: positive accept + allowlist membership oracle.
  const good = ac.get("content-type-in-allowlist-accepted");
  assert.ok(fixture.contentTypeAllowlist.includes(good.observed));
  assert.equal(good.expected.accepted, true);
  for (const id of ["content-type-spoof-rejected", "content-type-not-on-allowlist-rejected"]) {
    const bad = ac.get(id);
    assert.equal(fixture.contentTypeAllowlist.includes(bad.observed), false, `${id} observed type is off-allowlist`);
    assert.equal(bad.expected.errorCode, "AUDIO_CONTENT_TYPE_INVALID");
  }
  // Decompression ratio boundary tied to limits.
  assert.equal(ac.get("decompression-at-ratio-boundary-accepted").ratio, fixture.limits.maxDecompressRatio);
  assert.equal(ac.get("decompression-at-ratio-boundary-accepted").expected.accepted, true);
  assert.equal(ac.get("decompression-over-ratio-rejected").ratio, fixture.limits.maxDecompressRatio + 1);
  assert.equal(ac.get("malformed-audio-rejected").expected.errorCode, "AUDIO_CONTENT_TYPE_INVALID");
});

test("dispatch is exactly-once and reconnect-redispatch is deduped to one", () => {
  const tc = byId("transcriptCases");
  assert.equal(tc.get("transcription-failure-handled").expected.errorCode, "TRANSCRIPTION_FAILED");
  assert.equal(tc.get("transcript-dispatched-exactly-once-survives-detach").expected.dispatchCount, 1);
  const dedup = tc.get("reconnect-redispatch-deduped-to-one");
  assert.equal(dedup.attempts, 2);
  assert.equal(dedup.expected.dispatchCount, 1, "a reconnect retry must dedup to one dispatch");
});

test("synthesis uses an allowlisted per-agent voiceId; length bound is distinct from the cost cap", () => {
  const sc = byId("synthesisCases");
  assert.deepEqual(fixture.voiceIdAllowlist.length >= 3, true);
  const ok = sc.get("per-agent-voiceid-synthesis");
  assert.equal(ok.voiceId, fixture.voiceIdByAgent[ok.agent]);
  assert.ok(fixture.voiceIdAllowlist.includes(ok.voiceId));
  assert.equal(ok.expected.synthesized, true);
  assert.equal(sc.get("unknown-voiceid-rejected").expected.errorCode, "VOICE_ID_UNKNOWN");
  // Mismatched mapping: Claude requesting Codex's (allowlisted) voice is still rejected.
  const mis = sc.get("mismatched-voiceid-mapping-rejected");
  assert.ok(fixture.voiceIdAllowlist.includes(mis.voiceId), "the voiceId is on the allowlist");
  assert.notEqual(mis.voiceId, fixture.voiceIdByAgent[mis.agent], "but it is not this agent's mapping");
  assert.equal(mis.expected.errorCode, "VOICE_ID_UNKNOWN");
  // Length bound tied to limits, at-cap accepted, over-cap a DISTINCT length code.
  assert.equal(sc.get("synthesis-at-char-cap-accepted").chars, fixture.limits.maxSynthChars);
  assert.equal(sc.get("synthesis-at-char-cap-accepted").expected.accepted, true);
  const over = sc.get("synthesis-over-char-cap-refused");
  assert.equal(over.chars, fixture.limits.maxSynthChars + 1);
  assert.equal(over.expected.errorCode, "SYNTH_LENGTH_EXCEEDED");
  assert.equal(over.expected.truncatedSilently, false);
});

test("cost sums transcription+synthesis and debits ONE combined total, not a side-bucket (target behavior; enforcement gated on Chat cost-tracking)", () => {
  const cc = byId("costCases");
  const sum = cc.get("projection-sums-transcription-and-synthesis");
  assert.equal(sum.expected.projectedTotalUsdCents, sum.transcriptionCostUsdCents + sum.synthesisCostUsdCents);
  assert.equal(cc.get("voice-cost-debits-one-combined-total-not-sidebucket").expected.debitsCombinedTotal, true);
  // The key finding: under its own sub-cap but over the combined daily total -> refused.
  const combined = cc.get("voice-turn-refused-when-combined-total-over-cap");
  assert.ok(combined.voiceTurnCostUsdCents < combined.voiceOwnSubcapUsdCents, "under its own sub-cap");
  assert.ok(combined.combinedRunningTotalUsdCents + combined.voiceTurnCostUsdCents > combined.perDayCapUsdCents, "over the combined cap");
  assert.equal(combined.expected.errorCode, "COST_CAP_EXCEEDED");
  // Per-turn cost boundary.
  assert.equal(cc.get("synthesis-at-cost-cap-accepted").expected.accepted, true);
  assert.equal(cc.get("synthesis-over-cost-cap-refused").expected.errorCode, "COST_CAP_EXCEEDED");
});

test("audio artifacts: cross-user denied, per-fetch session re-validation, expiry boundary, deletable, retention disclosed", () => {
  const ac = byId("artifactCases");
  assert.equal(ac.get("cross-user-artifact-access-denied").expected.errorCode, "ARTIFACT_ACCESS_DENIED");
  const stale = ac.get("artifact-fetch-revalidated-against-live-session");
  assert.equal(stale.expected.errorCode, "ARTIFACT_ACCESS_DENIED");
  assert.equal(stale.expected.servedViaLongLivedSignedUrl, false);
  const atExpiry = ac.get("artifact-at-expiry-boundary-still-served");
  assert.equal(atExpiry.ageMs, fixture.limits.artifactExpiryMs);
  assert.equal(atExpiry.expected.served, true);
  assert.equal(ac.get("artifact-past-expiry-not-served").expected.served, false);
  assert.equal(ac.get("artifact-deletable-on-request").expected.deleted, true);
  assert.equal(ac.get("retention-policy-disclosed").expected.retentionDisclosed, true);
  assert.equal(ac.get("artifact-basename-pinned-no-traversal").expected.servedOutsideStore, false);
});

test("a secret spoken into the transcript input never survives to any output", () => {
  const s = byId("secretInputCases").get("secret-spoken-into-transcript-redacted");
  assert.equal(s.transcriptInputContainsSeededSecret, true);
  assert.equal(s.expected.storedTranscriptContainsSecret, false);
  assert.equal(s.expected.artifactContainsSecret, false);
  assert.equal(s.expected.chatSummaryContainsSecret, false);
  assert.equal(s.expected.synthesizedAudioContainsSecret, false);
});

test("every declared code has a case AND a concrete envelope with matching error.code", () => {
  const codesOnCases = new Set([
    ...allCases().map((k) => k.code).filter(Boolean),
    ...allCases().map((k) => k.expected && k.expected.errorCode).filter(Boolean),
  ]);
  for (const c of fixture.codes) assert.ok(codesOnCases.has(c), `code ${c} is never exercised`);
  for (const c of codesOnCases) assert.ok(fixture.codes.includes(c), `undeclared code ${c}`);
  // Each declared code has a concrete envelope, and its error.code matches the case code.
  const envByCode = new Map(fixture.envelopeCases.filter((k) => k.code).map((k) => [k.code, k]));
  for (const c of fixture.codes) assert.ok(envByCode.has(c), `code ${c} needs a concrete envelope`);
  for (const k of fixture.envelopeCases) {
    const env = k.expected;
    assert.ok(["success", "warning", "error"].includes(env.status));
    assert.ok(typeof env.summary === "string" && env.summary.length > 0 && env.summary.length <= 200, `${k.id}`);
    assert.ok(Array.isArray(env.next_actions) && Array.isArray(env.artifacts));
    if (env.status === "error") {
      assert.equal(env.error.code, k.code, `${k.id} error.code must match the case code`);
      assert.ok(env.error.retry.length > 0 && env.error.stopCondition.length > 0, `${k.id} triplet`);
    }
  }
});

test("seeded credential never appears in any expected output", () => {
  const secret = fixture.seededSecret;
  const expectedOnly = JSON.stringify(allCases().map((k) => k.expected ?? null));
  assert.equal(expectedOnly.includes(secret), false);
});
