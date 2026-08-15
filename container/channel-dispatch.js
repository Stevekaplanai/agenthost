// channel-dispatch.js -- CONT-05 broker dispatcher DECISION core.
//
// The decided architecture (Steve, 2026-07-23, option (a)): OpenClaw/Hermes are demoted to
// dumb transports and every inbound channel message is handed as raw text to a gate-owned
// dispatcher that runs the SAME consequence gate + daily spend cap as a typed web turn
// BEFORE any chat engine acts. This module is that dispatcher's decision core.
//
// PURE by design (same discipline as chat-governance.js): no I/O, no network, no engine
// invocation, no gate.js imports. It takes plain values in and returns a deterministic
// decision + a CONT-00 envelope. gate.js wires the loopback endpoint (transports POST
// inbound text here) and the agent runner (on a "dispatch" decision) AROUND this core --
// that integration is deploy-gated and not provable in the sandbox; THIS is what the
// CONT-05 contract fixtures prove.
//
// The gate itself is best-effort text classification (see chat-governance.js's own caveat):
// it raises the floor on a channel turn, it is not a substitute for action-level tool
// permissions on the handling engine. The contract says so; this module inherits it.

"use strict";

const chatGov = require("./chat-governance.js");
// One source of truth for "which transport can carry this channel" -- shared with the
// settings layer so the dispatcher and the picker can never disagree.
const { channelOwnerEligible } = require("./settings-lib.js");

const SUPPORTED = ["telegram", "discord", "whatsapp"];

// The confirm FLOOR is what makes a "confirmed" re-send safe: the operator must have
// re-sent the SAME (channel,text) AFTER a real delay, so an instant double-send, a flaky
// phone, a script, or a prompt-injected upstream cannot auto-confirm a consequential turn.
// On the channel path this matters MORE than on the web path (bots re-send in ms), so the
// core DERIVES `confirmed` from timing itself (never trusts a bare boolean) and ships these
// defaults so a caller cannot omit the floor. Mirror of gate.js CHAT_CONFIRM_FLOOR_MS/WINDOW.
const CHAT_CONFIRM_FLOOR_MS = 1500;
const CHAT_CONFIRM_WINDOW_MS = 120000; // 2 min

// CONT-00 envelope helpers.
function ok(summary, artifacts, next_actions) {
  return { status: "success", summary, next_actions: next_actions || [], artifacts: artifacts || [] };
}
function warn(summary, next_actions) {
  return { status: "warning", summary, next_actions: next_actions || [], artifacts: [] };
}
function err(code, summary, retry, stopCondition, next_actions) {
  return { status: "error", summary, next_actions: next_actions || [], artifacts: [], error: { code, retry, stopCondition } };
}

// Decide what to do with ONE inbound channel turn. Returns:
//   { action: "reject", code, envelope }              -- a config/precondition failure
//   { action: "gate",   code, verdict, envelope }     -- held for confirmation (gate or cap)
//   { action: "dispatch", handlingEngine, envelope }  -- passed; gate.js runs the engine
// Order matters: cheap structural checks fail closed before the text ever reaches the gate,
// and the gate runs before any dispatch so an ungated consequential turn is impossible.
//
// TRUST BOUNDARY (the integrator MUST honor this): `text` is the ONLY untrusted field --
// it is the raw inbound message. EVERY other field is a server-derived precondition that
// gate.js computes and MUST NOT map from the transport POST body:
//   - enabled / owner / ownerReady / credentialInVault : from settings + the readiness probe
//   - today / caps / limitsEnabled                      : from the spend ledger + settings
//   - confirmGate                                       : from settings (channels.<ch>.confirmGate)
//   - pendingAt / nowMs                                 : from gate.js's pending-confirm map
//     (keyed by chatGov.confirmKey(text, "channel:"+channel)) and the box clock.
// `confirmed` is NOT an input: the core derives it from (pendingAt, nowMs, floor, window) so
// the confirm floor is enforced HERE and cannot be dropped or forged by the wiring.
//
// confirmGate === false (operator opt-out for a PRIVATE, transport-locked channel --
// settings comment has the safety contract) skips ONLY the consequence classifier;
// the daily spend cap still applies exactly as before. Absent/true keeps today's
// behavior -- fail-safe for any caller that never passes it.
function dispatchDecision(input) {
  const i = input || {};
  const channel = i.channel;
  const enabled = i.enabled === true;
  const owner = i.owner;
  const ownerReady = i.ownerReady === true;
  const credentialInVault = i.credentialInVault === true;

  if (!SUPPORTED.includes(channel)) {
    return { action: "reject", code: "CHANNEL_UNKNOWN",
      envelope: err("CHANNEL_UNKNOWN", "That channel is not supported.",
        "Use telegram, discord, or whatsapp.", "Never handle an unsupported channel.") };
  }
  if (!enabled) {
    return { action: "reject", code: "CHANNEL_NOT_ENABLED",
      envelope: err("CHANNEL_NOT_ENABLED", "That channel is turned off.",
        "Enable the channel, then retry.", "Do not handle inbound for a disabled channel.",
        ["Enable it in Settings, then reconnect."]) };
  }
  // Owner must be the channel's one capable transport AND pass its readiness probe.
  if (!channelOwnerEligible(channel, owner) || !ownerReady) {
    return { action: "reject", code: "CHANNEL_ENGINE_INELIGIBLE",
      envelope: err("CHANNEL_ENGINE_INELIGIBLE", "The channel's handler transport is not ready.",
        "Configure/enable the transport, or bind to a ready one.",
        "Never bind a channel to a transport that fails its readiness probe.") };
  }
  if (!credentialInVault) {
    return { action: "reject", code: "CHANNEL_CREDENTIAL_MISSING",
      envelope: err("CHANNEL_CREDENTIAL_MISSING", "This channel has no credential in the vault.",
        "Add the credential, then retry.", "Never run a channel half-configured.",
        ["Add the token in Settings (stored in the vault)."]) };
  }

  // Derive `confirmed` from timing -- an instant re-send (dt < floor) or no prior gate at
  // all is NOT a confirmation, so a consequential turn stays gated. Fail-closed: missing or
  // non-finite timing yields false (isConfirmingResend returns false), which gates.
  const floorMs = Number.isFinite(i.confirmFloorMs) ? i.confirmFloorMs : CHAT_CONFIRM_FLOOR_MS;
  const windowMs = Number.isFinite(i.confirmWindowMs) ? i.confirmWindowMs : CHAT_CONFIRM_WINDOW_MS;
  const confirmed = chatGov.isConfirmingResend(i.pendingAt, i.nowMs, floorMs, windowMs);

  // THE BROKER'S CORE: the identical consequence gate + daily spend cap as startChatRun,
  // wrapped fail-CLOSED (gate.js:3300-3304) -- if governance itself throws, gate the turn
  // rather than let an unclassified message dispatch. The module never throws by design.
  let verdict, gateErr = null;
  try {
    // confirmGate off: run the same chatGate with an EMPTY message -- "" is never
    // consequential, so only the spend-cap branch can gate. One code path, no
    // parallel spend logic to drift. The real `text` still flows to the engine.
    verdict = chatGov.chatGate({
      msg: i.confirmGate === false ? "" : i.text,
      today: i.today, caps: i.caps, limitsEnabled: i.limitsEnabled, confirmed,
    });
  } catch (e) {
    gateErr = e;
    verdict = { action: "gate", code: "CHAT_CONSEQUENCE_CONFIRM", reason: "gate_error",
      message: "This turn could not be safety-checked, so it was NOT run." };
  }
  if (verdict.action === "gate") {
    const summary = gateErr ? "Channel turn could not be safety-checked; not run."
      : verdict.code === "CHAT_SPEND_CONFIRM" ? "Daily chat governance cap reached; this turn was not run."
      : "Consequential channel turn held for confirmation; not run.";
    return { action: "gate", code: verdict.code, verdict,
      envelope: warn(summary, ["Re-send the same message to confirm."]) };
  }

  // Passed the gate: the CALLER (gate.js) decides what happens next -- this core does not
  // itself run an engine, and its own envelope must never imply one answered (2026-07-23
  // red-team: an earlier wording here said "dispatching to the chat engine", which a
  // future caller that forwarded this envelope verbatim would have shipped as a false
  // claim). handlingEngine records the transport that carried it (for audit); the
  // answering engine is the operator's chat engine, per the broker, once that is wired.
  return { action: "dispatch", handlingEngine: owner,
    envelope: ok("Channel turn passed the gate.",
      [{ type: "channel_dispatch", channel, owner, gated: false }]) };
}

module.exports = { SUPPORTED, dispatchDecision };
