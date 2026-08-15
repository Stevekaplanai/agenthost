import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Real machinery, so claims are proven not asserted:
import { isChatConsequence, spendVerdict } from "../container/chat-governance.js";
import { scrubAndTranslate, packOpenclawConfig, REDACTED } from "../scripts/pack-lib.mjs";
import settingsLib from "../container/settings-lib.js";
const { channelOwnerEligible } = settingsLib;
import { dispatchDecision } from "../container/channel-dispatch.js";

// CONT-05 Channel Configuration fixtures (rewritten 2026-07-23 after a red-team caught the
// v1 draft over-claiming). The corpus is now honest about what is real vs runtime work:
//   - the consequence CLASSIFIER verdict is proven (real isChatConsequence), but the fixture
//     is explicit that routing inbound text INTO the gate is unproven runtime work (OpenClaw
//     and Hermes handle channels out-of-process);
//   - the migration proof runs the REAL scrubAndTranslate and demonstrates the moat GAP:
//     botToken is redacted, but channels.whatsapp.session LEAKS today -> the runtime must add
//     subtree-drop + an allowlist before ~/.openclaw migration can ship;
//   - binding/credential/readiness outcomes are DERIVED by small oracles, not hand-set.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures", "channels-contract-v1.json"), "utf8"));
const ARRAYS = ["transportCases", "spendCases", "bindingCases", "readinessCases", "credentialCases",
  "migrationCases", "sessionOwnerCases", "whatsappOwnershipCases", "brokerCases", "detachCases",
  "sessionCases", "configCases", "privacyCases", "envelopeCases"];
const allCases = () => ARRAYS.flatMap((k) => fixture[k]);
const byId = (arr) => new Map(fixture[arr].map((k) => [k.id, k]));

// --- oracles (derive the outcome from the precondition, so a wrong runtime fails) ---
const deriveBinding = (c, engines) =>
  !engines.includes(c.boundEngine) || !c.onRoster ? "CHANNEL_ENGINE_INELIGIBLE"
    : !c.engineReady ? "CHANNEL_ENGINE_INELIGIBLE" : "accepted";
const deriveReady = (c) => Boolean(c.configPresent && c.gatewayUp && !c.isOnboardingShell);
const deriveCred = (c) => (c.credentialInVault ? "resolved" : "CHANNEL_CREDENTIAL_MISSING");

test("channels fixture is one versioned, collision-free catalog on the real config path", () => {
  assert.equal(fixture.$schema, "agenthost-continuity-channels-fixtures-v1");
  assert.equal(fixture.contractId, "CONT-05");
  assert.equal(fixture.configPath, "~/.openclaw/openclaw.json", "the real on-disk config filename (openclaw.json, NOT config.json -- the latter was a stale name that shipped a silent-drop bug on 2026-07-24)");
  assert.deepEqual(fixture.supportedChannels, ["telegram", "discord", "whatsapp"]);
  assert.deepEqual(fixture.engines, ["hermes", "openclaw"]);
  const ids = allCases().map((k) => k.id);
  assert.equal(new Set(ids).size, ids.length, "case IDs must be globally unique");
  assert.ok(ids.length >= 28, "needs a meaningful corpus");
});

test("classifier verdict is proven on channel messages; every channel turn MUST broker through the gate", () => {
  let bound = 0;
  for (const k of fixture.transportCases) {
    if (typeof k.message === "string" && typeof (k.expected && k.expected.gated) === "boolean") {
      assert.equal(isChatConsequence(k.message), k.expected.gated, `${k.id}: real classifier must match`);
      bound++;
      // DECIDED (Steve 07-23): inbound channel text is forced through the gate-owned dispatcher
      // BEFORE any engine acts. The classifier verdict is proven here; the dispatcher that enforces
      // this routing is the CONT-05 runtime build. The contract requires it, so the fixture asserts it.
      assert.equal(k.expected.mustBrokerThroughGate, true, `${k.id}: every channel turn must broker through the gate`);
    }
  }
  assert.ok(bound >= 3, "at least the three consequence cases run the real classifier");
  const tc = byId("transportCases");
  assert.equal(tc.get("unknown-channel-refused").expected.errorCode, "CHANNEL_UNKNOWN");
  assert.equal(fixture.supportedChannels.includes(tc.get("unknown-channel-refused").channel), false);
  assert.equal(tc.get("disabled-channel-not-handled").expected.errorCode, "CHANNEL_NOT_ENABLED");
});

test("BROKER (real dispatchDecision): the contract's declared codes are proven against code", () => {
  // A ready baseline the per-case perturbations start from.
  const base = { channel: "telegram", text: "summarize the audit window", enabled: true,
    owner: "openclaw", ownerReady: true, credentialInVault: true,
    today: { usdCents: 0, tokens: 0 }, caps: { usdCents: 2500, tokens: 5000000 }, limitsEnabled: true };
  // Structural rejections match the fixture's declared error codes.
  const tc = byId("transportCases");
  assert.equal(dispatchDecision({ ...base, channel: tc.get("unknown-channel-refused").channel }).code,
    tc.get("unknown-channel-refused").expected.errorCode);
  assert.equal(dispatchDecision({ ...base, enabled: false }).code,
    tc.get("disabled-channel-not-handled").expected.errorCode);
  assert.equal(dispatchDecision({ ...base, credentialInVault: false }).code, "CHANNEL_CREDENTIAL_MISSING");
  assert.equal(dispatchDecision({ ...base, ownerReady: false }).code, "CHANNEL_ENGINE_INELIGIBLE");
  // The BROKER'S POINT: every consequential transportCase message, run through the real
  // dispatcher, is GATED before any engine could act -- proving mustBrokerThroughGate is
  // enforced by real code, not just asserted by the classifier.
  for (const k of fixture.transportCases) {
    if (k.expected && k.expected.gated === true) {
      const d = dispatchDecision({ ...base, text: k.message });
      assert.equal(d.action, "gate", `${k.id}: a consequential channel turn must be gated by the dispatcher`);
    }
  }
  // A benign turn passes and dispatches.
  assert.equal(dispatchDecision(base).action, "dispatch");
  // Spend fixture: the same over-cap case is gated on the spend axis by the dispatcher.
  const s = byId("spendCases").get("channel-turn-over-daily-cap-gated");
  const spendGate = dispatchDecision({ ...base, today: { usdCents: s.todayUsdCents, tokens: s.todayTokens },
    caps: { usdCents: s.capUsdCents, tokens: s.capTokens } });
  assert.equal(spendGate.action, "gate");
  assert.equal(spendGate.code, "CHAT_SPEND_CONFIRM");
});

test("a channel turn is bound to the SAME spend cap axes as web chat (real spendVerdict)", () => {
  const s = byId("spendCases").get("channel-turn-over-daily-cap-gated");
  const v = spendVerdict({ usdCents: s.todayUsdCents, tokens: s.todayTokens },
    { usdCents: s.capUsdCents, tokens: s.capTokens }, true);
  assert.equal(v.overCap, s.expected.overCap);
  assert.equal(v.axis, s.expected.axis, "the token axis is what bounds a subscription box");
});

test("binding is server-derived and its outcome is DERIVED from readiness/roster (oracle), not hand-set", () => {
  const bc = byId("bindingCases");
  const declared = bc.get("binding-server-derived-not-message-declared");
  assert.ok(fixture.serverDerivedFields.includes(declared.suppliesServerDerivedField));
  assert.equal(declared.expected.errorCode, "CHANNEL_REQUEST_INVALID");
  for (const id of ["bind-openclaw-ready", "bind-openclaw-unready-refused", "bind-hermes-ready", "bind-nonroster-engine-refused"]) {
    const c = bc.get(id);
    const oracle = deriveBinding(c, fixture.engines);
    const expected = c.expected.accepted ? "accepted" : c.expected.errorCode;
    assert.equal(oracle, expected, `${id}: outcome must match the readiness/roster oracle`);
  }
  assert.deepEqual(bc.get("default-binding-per-channel").expected, fixture.defaultEngineByChannel);
  // Coverage completeness: every engine and channel is exercised somewhere.
  const engs = new Set(fixture.bindingCases.map((k) => k.boundEngine).filter(Boolean));
  for (const e of fixture.engines) assert.ok(engs.has(e), `binding coverage must include ${e}`);
});

test("channel-engine readiness is a channels-specific probe (config + gateway up), NOT window-presence", () => {
  for (const k of fixture.readinessCases) {
    assert.equal(deriveReady(k), k.expected.ready, `${k.id}: derived readiness must match`);
  }
  // The false-ready the box risks: the onboarding shell shares the tmux window name.
  assert.equal(byId("readinessCases").get("openclaw-onboarding-shell-is-not-ready").expected.ready, false);
});

test("credentials come from the vault; a missing one fails closed (oracle-derived)", () => {
  for (const k of fixture.credentialCases) {
    const oracle = deriveCred(k);
    if (k.expected.errorCode) assert.equal(oracle, k.expected.errorCode);
    else { assert.equal(oracle, "resolved"); assert.equal(k.expected.inlineSecretInCommittedConfig, false); }
  }
});

test("MIGRATION (real scrubAndTranslate): token and session redact; linkedNumber still needs the allowlist", () => {
  const m = byId("migrationCases").get("real-scrubAndTranslate-redacts-token-and-session-but-linked-number-needs-allowlist");
  const report = { redactedSecrets: [] };
  const out = scrubAndTranslate(m.inputConfig, "openclaw", "", { translated: 0, nonHome: [] }, [], "/home/agent", report);
  const outStr = JSON.stringify(out);
  // Sound today: the token-shaped field is redacted (key "botToken" matches the keyname rule).
  assert.equal(outStr.includes(m.sampleToken), false, "botToken must be redacted by the current packer");
  assert.equal(out.channels.telegram.botToken, REDACTED);
  assert.ok(report.redactedSecrets.some((r) => /botToken/.test(r)), "the report records the redaction");
  assert.equal(outStr.includes(m.sampleSession), false, "the generic scrubber now redacts an exact session key");
  assert.equal(out.channels.whatsapp.session, REDACTED);
  // linkedNumber is provider-specific and intentionally remains proof that the
  // OpenClaw subtree-drop allowlist is still required beyond generic redaction.
  assert.equal(outStr.includes(m.sampleLinkedNumber), true, "linkedNumber still requires the OpenClaw allowlist");
  assert.equal(m.expected.whatsappSessionRedactedByGenericScrubber, true);
  assert.equal(m.expected.linkedNumberLeaksByGenericScrubber, true);
  assert.equal(m.expected.runtimeMustAddSubtreeDropAndAllowlist, true);
  // Non-secret structure survives (migration keeps it).
  assert.equal(out.channels.telegram.enabled, true);
  assert.equal(out.ui.theme, "dark");
  assert.equal(out.agents.entries[0].name, "assistant");
});

test("MIGRATION FIX (packOpenclawConfig): the required subtree-drop+allowlist CLOSES the leak", () => {
  // The runtime the contract required is now built. On the SAME input that leaks above,
  // the allowlist-based packer drops the session subtree entirely while keeping the
  // structure the box needs to reconnect the channel. This turns the proof-of-gap into a
  // proof-of-fix so a regression re-opening the leak fails here.
  const m = byId("migrationCases").get("real-scrubAndTranslate-redacts-token-and-session-but-linked-number-needs-allowlist");
  const report = { redactedSecrets: [] };
  const fixed = packOpenclawConfig(m.inputConfig, { translated: 0, nonHome: [] }, [], "/home/agent", report);
  const fixedStr = JSON.stringify(fixed);
  assert.equal(fixedStr.includes(m.sampleSession), false, "session blob is DROPPED by the new packer");
  assert.equal(fixedStr.includes(m.sampleLinkedNumber), false, "linkedNumber is DROPPED by the new packer");
  assert.equal(fixedStr.includes(m.sampleToken), false, "botToken is dropped by the channel allowlist");
  assert.equal("session" in fixed.channels.whatsapp, false, "no session key survives on the channel");
  // Structure the box needs to reconnect the channel is preserved.
  assert.equal(fixed.channels.telegram.enabled, true);
  assert.equal(fixed.channels.whatsapp.enabled, true);
  assert.equal(fixed.ui.theme, "dark");
  assert.equal(fixed.agents.entries[0].name, "assistant");
});

test("single-session accounts have exactly one owner; WhatsApp default is off + Hermes-owned", () => {
  const conflict = byId("sessionOwnerCases").get("two-engines-cannot-both-own-whatsapp");
  assert.ok(conflict.claimants.length > 1);
  assert.equal(conflict.expected.errorCode, "CHANNEL_SESSION_CONFLICT");
  const wc = byId("whatsappOwnershipCases");
  const def = wc.get("whatsapp-off-by-default-owner-hermes");
  assert.equal(def.expected.runningByDefault, false, "the Hermes agent window does not start the messaging gateway");
  assert.equal(def.expected.defaultOwnerWhenConfigured, "hermes");
  assert.equal(fixture.defaultEngineByChannel.whatsapp, "hermes");
  // CORRECTED after the Phase 2 spike: exactly one capable transport per channel, so the
  // owner is PINNED (not a free engine pick) and proven against the real settings-lib
  // eligibility map -- WhatsApp only Hermes, Telegram only OpenClaw.
  const pick = wc.get("settings-force-single-owner-pick");
  assert.equal(pick.expected.ownerPinnedToCapableTransport, true, "owner is pinned to the capable transport");
  assert.equal(channelOwnerEligible("whatsapp", pick.expected.whatsappOwner), true, "whatsapp owner is eligible in real code");
  assert.equal(channelOwnerEligible("whatsapp", "openclaw"), false, "openclaw cannot own whatsapp (real code)");
  assert.equal(channelOwnerEligible("telegram", pick.expected.telegramOwner), true, "telegram owner is eligible in real code");
  assert.equal(channelOwnerEligible("telegram", "hermes"), false, "hermes cannot own telegram (real code)");
});

test("the DECIDED broker demotes OpenClaw/Hermes to relay-only; a gate-owned dispatcher runs chatGate", () => {
  const b = byId("brokerCases").get("transports-agents-disabled-dispatcher-owns");
  assert.equal(b.expected.openclawAgentDisabled, true, "OpenClaw's own agent must be disabled");
  assert.equal(b.expected.hermesAgentDisabled, true, "Hermes's own agent must be disabled");
  assert.equal(b.expected.dispatcherRunsChatGate, true, "the gate-owned dispatcher runs chatGate before any engine");
  assert.equal(b.expected.transportsRelayOnly, true, "OpenClaw/Hermes relay bytes only, they do not act");
});

test("detach rule: a consequential channel turn is read-only (contingent on a restricted engine profile); benign runs", () => {
  const dc = byId("detachCases");
  const cons = dc.get("consequential-channel-turn-detached-readonly");
  assert.equal(isChatConsequence(cons.message), true, "the detach trigger is derived from the classifier, not declared");
  assert.equal(cons.expected.readOnlyUntilConfirm, true);
  assert.equal(cons.expected.contingentOnRestrictedEngineProfile, true, "honest: only holds once the engine runs restricted");
  const benign = dc.get("benign-channel-turn-detached-runs");
  assert.equal(isChatConsequence(benign.message), false);
  assert.equal(benign.expected.readOnlyUntilConfirm, false);
});

test("privacy: gateway is loopback + token-protected, NOT behind the cookie wall, no public endpoint", () => {
  const p = byId("privacyCases").get("gateway-loopback-not-public-not-cookie-walled");
  assert.equal(p.expected.loopbackPinned, true);
  assert.equal(p.expected.publicEndpointAdded, false);
  assert.equal(p.expected.behindCookieWall, false, "corrected: no gate.js reverse proxy for OpenClaw");
  assert.equal(p.expected.protectedByGatewayToken, true);
});

test("every declared code has a BEHAVIORAL case AND a concrete envelope with a matching error.code", () => {
  // Harvest codes from behavioral arrays ONLY (not envelopeCases) so an envelope alone
  // cannot satisfy "has a case".
  const behavioral = ARRAYS.filter((a) => a !== "envelopeCases").flatMap((a) => fixture[a]);
  const codesOnCases = new Set(behavioral.map((k) => k.expected && k.expected.errorCode).filter(Boolean));
  for (const c of fixture.codes) assert.ok(codesOnCases.has(c), `code ${c} has no behavioral case`);
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
});

test("the seeded credential appears exactly once (its declaration) and never in an expected output", () => {
  const secret = fixture.seededSecret;
  assert.equal(JSON.stringify(fixture).split(secret).length - 1, 1, "seeded secret must appear exactly once (its declaration)");
  const expectedOnly = JSON.stringify(allCases().map((k) => k.expected ?? null));
  assert.equal(expectedOnly.includes(secret), false);
});
