import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// CONT-09 Dead Man's Switch contract fixtures (hardened 2026-07-22 after a two-agent
// red-team; see docs/continuity/CONT-09-10-REDTEAM-LOG.md).
// Contract: docs/continuity/DEADMAN-CONTRACT.md (CONT-09, v1).
//
// The load-bearing correction: liveness is the FRESHNESS of a running record's last
// update, never the mere presence of the record (a wedged process holds presence
// forever). Dedup is keyed per (agent, reason) so agent_missing and handoff_stalled
// coexist without flapping. The escalation ladder is a delivery timer separate from
// the 6h detection cooldown.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_FILE = path.join(HERE, "fixtures", "deadman-contract-v1.json");
const fixture = JSON.parse(fs.readFileSync(FIXTURE_FILE, "utf8"));

const ARRAYS = [
  "livenessCases", "thresholdCases", "dedupCases", "escalationCases", "quietHoursCases",
  "recoveryCases", "handoffSeamCases", "restartCases", "shapeCases", "secretInputCases",
  "channelCases", "envelopeCases",
];
const allCases = () => ARRAYS.flatMap((k) => fixture[k]);
const byId = (arr) => new Map(fixture[arr].map((k) => [k.id, k]));

test("deadman fixture has one versioned, collision-free catalog", () => {
  assert.equal(fixture.$schema, "agenthost-continuity-deadman-fixtures-v1");
  assert.equal(fixture.contractId, "CONT-09");
  assert.equal(fixture.contractVersion, 1);
  const ids = allCases().map((k) => k.id);
  assert.equal(new Set(ids).size, ids.length, "case IDs must be globally unique");
  assert.ok(ids.length >= 40, "the hardened corpus needs a meaningful surface");
});

test("liveness sources exclude presence, narration, and failure transitions", () => {
  assert.deepEqual(fixture.monitoredAgents, ["claude", "codex", "gemini", "hermes", "kimi"]);
  assert.deepEqual(fixture.livenessSources, [
    "running_ledger_record_last_update", "activity_tracker_observation",
    "produced_result", "forward_progress_handoff_transition",
  ]);
  // The three things a naive implementation would wrongly count as liveness.
  for (const x of ["narration_cadence", "running_record_mere_presence", "failure_handoff_transition"])
    assert.ok(fixture.excludedLivenessSources.includes(x), `${x} must be excluded`);
});

test("BLOCKER B1: a present-but-stale running record is missing; freshness wins", () => {
  const lc = byId("livenessCases");
  const stale = lc.get("running-record-present-but-stale-is-missing");
  assert.equal(stale.runningRecordNamesAgent, true);
  assert.ok(stale.runningRecordLastUpdateMsAgo > stale.thresholdMs);
  assert.equal(stale.expected.missing, true, "presence must not mask a wedged process");
  const fresh = lc.get("running-record-fresh-update-alive");
  assert.ok(fresh.runningRecordLastUpdateMsAgo < fresh.thresholdMs);
  assert.equal(fresh.expected.missing, false);
  // Newest-of across sources, and box-clock (not provider-clock) freshness.
  assert.equal(lc.get("newest-of-multiple-sources-alive").expected.missing, false);
  const skew = lc.get("provider-clock-skew-not-false-missing");
  assert.ok(skew.producedResultProviderClockMsAgo > skew.thresholdMs);
  assert.ok(skew.producedResultBoxClockMsAgo < skew.thresholdMs);
  assert.equal(skew.expected.missing, false);
});

test("only forward-progress handoff transitions are liveness; failures are the opposite", () => {
  const lc = byId("livenessCases");
  assert.equal(lc.get("forward-progress-handoff-refreshes-liveness").expected.missing, false);
  const fail = lc.get("failure-handoff-transition-not-liveness");
  assert.equal(fail.handoffTransition, "accepted->blocked");
  assert.equal(fail.expected.missing, true, "a lease breach must not refresh the agent's pulse");
  assert.equal(fixture.excludedLivenessSources.includes("failure_handoff_transition"), true);
});

test("narration never rescues a stale agent", () => {
  const narr = byId("livenessCases").get("narration-cadence-is-not-liveness");
  assert.ok(narr.lastNarrationMsAgo < narr.thresholdMs && narr.lastDurableObservationMsAgo > narr.thresholdMs);
  assert.equal(narr.expected.missing, true);
});

test("correctly-waiting is excluded only while the wait is live and bounded", () => {
  const lc = byId("livenessCases");
  for (const id of ["disabled-agent-never-flagged", "parked-for-review-never-flagged",
    "idle-no-assigned-work-never-flagged", "gated-on-live-bounded-blocker-never-flagged"])
    assert.equal(lc.get(id).expected.missing, false, `${id} must not be flagged`);
  const deadGate = lc.get("gated-on-terminal-blocker-is-missing");
  assert.equal(deadGate.blockerLiveAndBounded, false);
  assert.equal(deadGate.expected.missing, true, "gated on a terminal blocker is death, not waiting");
});

test("hasAssignedWork fails safe and detection never remediates", () => {
  const lc = byId("livenessCases");
  const indet = lc.get("assignment-indeterminate-fails-safe-monitored");
  assert.equal(indet.hasAssignedWork, "indeterminate");
  assert.equal(indet.expected.monitored, true, "unknown assignment must default to monitored");
  const hit = lc.get("expected-live-crosses-threshold-missing");
  assert.equal(hit.expected.restartsAgent, false);
  assert.equal(hit.expected.cancelsAgent, false);
  assert.equal(hit.expected.autoFixes, false);
  // The roster (CONT-00 KNOWN_AGENTS) is static; a known agent whose CONT-06
  // `installed` rung fails has lost runtime presence -- that's agent_missing, not
  // an off-roster id (the roster itself never changes).
  const vanish = byId("channelCases").get("known-agent-runtime-presence-vanishes-is-missing-not-unsupported");
  assert.equal(vanish.cont06InstalledRungFails, true);
  assert.equal(vanish.expected.reason, "agent_missing");
  assert.equal(vanish.expected.notErrorCode, "MONITOR_UNSUPPORTED");
});

test("boot grace suppresses the restart-induced observation gap", () => {
  const bg = byId("livenessCases").get("boot-grace-suppresses-restart-gap");
  assert.ok(bg.sinceGatewayBootMs < bg.bootGraceMs);
  assert.ok(bg.lastDurableObservationMsAgo > bg.thresholdMs);
  assert.equal(bg.expected.missing, false);
  assert.equal(fixture.bootGraceMs, 120000);
});

test("per-agent thresholds decide identical silence; boundaries and range are pinned", () => {
  const tc = byId("thresholdCases");
  const claude = tc.get("per-agent-claude-tighter");
  const codex = tc.get("per-agent-codex-looser-same-silence-alive");
  assert.equal(claude.silenceMs, codex.silenceMs);
  assert.ok(claude.thresholdMs < codex.thresholdMs);
  assert.equal(claude.expected.missing, true);
  assert.equal(codex.expected.missing, false);
  // Boundary: == is alive, +1ms is missing.
  assert.equal(tc.get("silence-exactly-at-threshold").expected.missing, false);
  assert.equal(tc.get("silence-one-ms-over-threshold").expected.missing, true);
  assert.equal(tc.get("default-fallback-threshold").thresholdMs, fixture.defaults.thresholdMs);
  assert.equal(tc.get("threshold-below-min-rejected").expected.errorCode, "THRESHOLD_INVALID");
  assert.equal(tc.get("threshold-above-max-rejected").expected.errorCode, "THRESHOLD_INVALID");
  assert.ok(tc.get("threshold-below-min-rejected").thresholdMs < fixture.thresholdRangeMs.min);
  assert.ok(tc.get("threshold-above-max-rejected").thresholdMs > fixture.thresholdRangeMs.max);
  // The valid range is INCLUSIVE at both ends -- pin exactly-min and exactly-max accepted.
  const atMin = tc.get("threshold-at-min-accepted-boundary");
  assert.equal(atMin.thresholdMs, fixture.thresholdRangeMs.min);
  assert.equal(atMin.expected.accepted, true, "exactly min is valid (>= min)");
  const atMax = tc.get("threshold-at-max-accepted-boundary");
  assert.equal(atMax.thresholdMs, fixture.thresholdRangeMs.max);
  assert.equal(atMax.expected.accepted, true, "exactly max is valid (<= max)");
});

test("dedup is per (agent, reason), skew-safe, and holds two reasons for one agent", () => {
  const dc = byId("dedupCases");
  assert.deepEqual(dc.get("newly-missing-alerts").expected.toAlert, ["claude"]);
  assert.deepEqual(dc.get("still-missing-within-cooldown-silent").expected.toAlert, []);
  assert.deepEqual(dc.get("cooldown-elapsed-re-alerts").expected.toAlert, ["claude"]);
  assert.deepEqual(dc.get("cooldown-exactly-at-boundary").expected.toAlert, ["claude"]);
  assert.deepEqual(dc.get("duplicate-timer-tick-no-double-fire").expected.toAlert, []);
  // Backward clock skew must not read as cooldown-elapsed.
  assert.deepEqual(dc.get("clock-skew-backward-no-double-fire").expected.toAlert, []);
  // Per-agent keying: codex in cooldown must not suppress claude.
  assert.deepEqual(dc.get("mixed-sweep-per-agent-dedup").expected.toAlert, ["claude"]);
  // BLOCKER B2: two reasons for one agent are both held, neither flapping.
  const two = dc.get("two-reasons-one-agent-two-stable-items");
  assert.ok(Object.keys(two.prev).includes("claude|agent_missing"));
  assert.ok(Object.keys(two.prev).includes("claude|handoff_stalled"));
  assert.deepEqual(two.expected.toAlert, []);
  // Recovery debounce prevents flap.
  assert.equal(dc.get("recover-then-miss-within-debounce-no-flap").expected.retainedNotRearmed, true);
});

test("escalation ladder is delay-ordered, never skips, and is separate from the cooldown", () => {
  assert.deepEqual(fixture.escalationLadder, ["push", "email", "channel"]);
  assert.deepEqual(fixture.rungDelaysMs, { push: 0, email: 600000, channel: 1800000 });
  const ec = byId("escalationCases");
  // Each probed rung matches its configured delay boundary.
  assert.equal(ec.get("ladder-rung-1-push-immediate").elapsedMs, fixture.rungDelaysMs.push);
  assert.equal(ec.get("ladder-rung-2-email-at-delay").elapsedMs, fixture.rungDelaysMs.email);
  assert.equal(ec.get("ladder-rung-3-channel-at-delay").elapsedMs, fixture.rungDelaysMs.channel);
  // Real no-skip: just under email's delay, only push has fired.
  const noSkip = ec.get("ladder-just-under-email-still-push");
  assert.ok(noSkip.elapsedMs < fixture.rungDelaysMs.email);
  assert.equal(noSkip.expected.rung, "push");
  assert.deepEqual(noSkip.expected.deliveredRungsExclude, ["email", "channel"]);
  assert.equal(ec.get("acknowledged-stops-escalation").expected.rung, "none");
  // A cooldown re-alert at the top rung re-delivers the top rung only.
  const re = ec.get("cooldown-realert-at-top-rung-redelivers-top-only");
  assert.equal(re.expected.rung, "channel");
  assert.equal(re.expected.resetsToRung1, false);
  assert.equal(re.expected.clearsAck, false);
});

test("quiet hours never suppress the first push or detection, and resume from the rung reached", () => {
  const qc = byId("quietHoursCases");
  const q = qc.get("quiet-hours-suppress-rungs-2plus-not-push");
  assert.equal(q.expected.pushDelivered, true, "first-rung push is never suppressed");
  assert.equal(q.expected.higherRungsDelivered, false);
  assert.equal(q.expected.attentionItemRecorded, true);
  const end = qc.get("quiet-hours-end-resumes-from-rung-reached");
  assert.equal(end.expected.resumesFromRung, "email");
  assert.equal(end.expected.recomputesFromElapsed, false);
  assert.equal(qc.get("outside-quiet-hours-escalates").expected.higherRungsDelivered, true);
  assert.equal(qc.get("malformed-quiet-hours-rejected").expected.errorCode, "QUIET_HOURS_INVALID");
  assert.equal(qc.get("effectively-24x7-window-rejected").expected.errorCode, "QUIET_HOURS_INVALID");
});

test("recovery is debounced and resolves both agent_missing and handoff_stalled", () => {
  const rc = byId("recoveryCases");
  const r = rc.get("recovery-raises-visible-resolution");
  assert.ok(r.freshObservationSustainedMs >= r.recoveryDebounceMs);
  assert.equal(r.expected.event, "AGENT_RECOVERED");
  assert.equal(r.expected.resolvesAttentionItem, true);
  assert.equal(rc.get("handoff-stall-recovery-resolves").expected.event, "AGENT_RECOVERED");
});

test("the CONT-08 seam is one item, not two, and a missing agent subsumes its stall", () => {
  const hc = byId("handoffSeamCases");
  const single = hc.get("handoff-stall-single-item-not-duplicated");
  assert.equal(single.expected.reason, "handoff_stalled");
  assert.equal(single.expected.duplicatesCont08Item, false);
  const subsume = hc.get("missing-agent-subsumes-its-handoff-breach");
  assert.equal(subsume.agentAlsoMissing, true);
  assert.equal(subsume.expected.reason, "agent_missing");
  assert.equal(subsume.expected.handoffStalledSubsumed, true);
  assert.equal(hc.get("agent-alive-and-handoffs-progressing-no-stall").expected.raises, false);
  assert.deepEqual(fixture.reasons, ["agent_missing", "handoff_stalled"]);
});

test("a restart preserves the item, its ack, and its rung without re-arming or re-firing", () => {
  const rc = byId("restartCases");
  const item = rc.get("gateway-restart-preserves-unresolved-item");
  assert.equal(item.expected.unresolvedAfterRestart, true);
  assert.equal(item.expected.reAlertsAfterRestart, false);
  const ack = rc.get("gateway-restart-preserves-ack-no-rearm");
  assert.equal(ack.expected.ackdAfterRestart, true);
  assert.equal(ack.expected.rearmsLadder, false);
  assert.equal(ack.expected.rungAfterRestart, ack.rungBeforeRestart);
});

test("the attention item carries only bounded fields and never a secret", () => {
  const shape = byId("shapeCases").get("attention-item-carries-only-bounded-fields");
  assert.deepEqual(shape.expected.keys, fixture.attentionItemFields);
  for (const forbidden of shape.expected.forbiddenKeys)
    assert.equal(fixture.attentionItemFields.includes(forbidden), false, `${forbidden} must not be a field`);
  // The seeded secret is genuinely planted in an input, then asserted absent from outputs.
  const inj = byId("secretInputCases").get("secret-in-observation-not-leaked");
  assert.equal(inj.injectValueIsSeededSecret, true);
  assert.equal(inj.expected.attentionItemStoresRawSecret, false);
  assert.equal(inj.expected.influencesEscalation, false);
});

test("every error/event code is exercised, and every envelope is deterministic", () => {
  // Coverage loop: each contract code appears on at least one case.
  const codesOnCases = new Set(allCases().map((k) => k.code).filter(Boolean));
  for (const c of fixture.codes) assert.ok(codesOnCases.has(c), `code ${c} is never exercised`);
  // No case carries a code the contract doesn't declare.
  for (const c of codesOnCases) assert.ok(fixture.codes.includes(c), `undeclared code ${c}`);
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
});

test("seeded credential never appears in any expected output", () => {
  const secret = fixture.seededSecret;
  const expectedOnly = JSON.stringify(allCases().map((k) => k.expected ?? null));
  assert.equal(expectedOnly.includes(secret), false);
});
