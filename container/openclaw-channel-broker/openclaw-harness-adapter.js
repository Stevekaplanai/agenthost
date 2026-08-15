// openclaw-harness-adapter.js -- CONT-05 broker: the PURE translation layer between
// OpenClaw's `before_agent_run` conversation hook and the gate-owned dispatcher endpoint
// (POST /internal/channel-dispatch, container/gate.js handleChannelDispatch).
//
// Kept separate from the OpenClaw-facing shell: this file only shapes REQUEST
// bodies and interprets RESPONSE JSON against the endpoint's
// real, already-tested contract (container/channel-dispatch.js, test/gate-channel-
// dispatch.test.js) -- it is fully unit-testable WITHOUT a real OpenClaw install, no HTTP,
// no SDK types. The live shell uses the verified `before_agent_run` hook in
// `openclaw-channel-broker/index.js`; keep translation logic in this file so it
// stays covered by focused tests.

// The exact body shape handleChannelDispatch reads (gate.js: `body.channel`,
// `body.senderId`, `body.chatId`, `body.text`). Centralizing this means the SDK shell
// never needs to know the endpoint's field names directly -- if the endpoint's contract
// changes, this is the one place that has to change with it. chatId is the DELIVERY
// target for the engine's out-of-band reply (a group chat's id differs from the sender's
// id; for DMs they usually coincide) -- without it the gate can only reply to senderId.
function buildDispatchRequest({ channel, senderId, chatId, text }) {
  return { channel, senderId, chatId, text };
}

// Interpret ONE HTTP response from POST /internal/channel-dispatch into what the harness
// should do next. Never throws: an unexpected shape degrades to a safe "held" outcome
// rather than crashing OpenClaw's message loop or (worse) treating garbage as a green light.
//
// Returns { outcome, replyText, terminal, logDetail }:
//   outcome   -- "dispatched" | "gated" | "rejected" | "transport_error" (for OpenClaw-side
//                audit/logging; never shown to the channel user)
//   replyText -- the text to send back on the channel, or null when there is nothing safe
//                or meaningful to relay yet
//   terminal  -- true if this response is the end of the turn (always true today; no
//                streaming exists yet, so every outcome is terminal)
//   logDetail -- a short, code-shaped string for the harness's own logs (never the raw
//                envelope, which may carry operator-facing next_actions unsuited to a
//                random channel user)
function interpretDispatchResponse(status, body) {
  if (status === 403) {
    // Auth failure (missing/wrong CHANNEL_DISPATCH_TOKEN, or somehow not loopback). This
    // should never happen from a correctly configured plugin; fail closed, no user text.
    return { outcome: "transport_error", replyText: null, terminal: true, logDetail: "auth_failed:403" };
  }
  if (!body || typeof body !== "object" || typeof body.status !== "string") {
    return { outcome: "transport_error", replyText: null, terminal: true, logDetail: "malformed_response:" + status };
  }
  if (body.status === "error") {
    // A structural reject (CHANNEL_NOT_ENABLED, CHANNEL_CREDENTIAL_MISSING, etc.).
    // SILENT here since 2026-07-24: gate.js delivers the reject summary to the sender
    // out-of-band (deliverChannelReply), because OpenClaw has NO silent block -- any
    // replyText we return would arrive wrapped in "Your message could not be sent: ...",
    // proven live to read as an error even for a normal verdict. One delivery authority:
    // the gate. `next_actions` are OPERATOR instructions and never go to a sender.
    const code = body.error && body.error.code;
    return { outcome: "rejected", replyText: null, terminal: true, logDetail: "rejected:" + (code || "unknown") };
  }
  if (body.status === "warning") {
    // The consequence gate or the daily spend cap held this turn. SILENT here for the
    // same reason as rejects: gate.js delivers the gate prompt (summary + how to
    // confirm) out-of-band as a clean bot message instead of OpenClaw's error framing.
    return { outcome: "gated", replyText: null, terminal: true, logDetail: "gated:" + (body.error && body.error.code || "consequence_or_spend") };
  }
  if (body.status === "success") {
    // The gate passed and gate.js answers OUT-OF-BAND: it runs the chat engine
    // asynchronously and delivers the reply itself via `openclaw message send`
    // (deliverChannelReply). The broker must therefore stay SILENT here -- returning
    // reply text would double-message the user (once from us, once from the gate's
    // delivery), and the block `message` path arrives wrapped in OpenClaw's own
    // "could not be sent" framing, which is the wrong clothes for a real answer.
    // Never leak the internal acknowledgement summary to a channel user either.
    return { outcome: "dispatched", replyText: null, terminal: true, logDetail: "dispatched_reply_out_of_band" };
  }
  return { outcome: "transport_error", replyText: null, terminal: true, logDetail: "unknown_status:" + String(body.status) };
}

// Should THIS outgoing message be cancelled at OpenClaw's message_sending hook?
// OpenClaw has no silent block: every before_agent_run block emits "Your message
// could not be sent: ... (blocked by agenthost-channel-broker)" (its
// resolveBlockMessage, verified in source for 2026.6.33 AND 2026.7.1-2 -- omitting
// the decision `message` only shortens it). Since the gate delivers ALL user-facing
// text out-of-band, that notice is pure noise -- so the plugin cancels exactly its
// OWN notice at the outbound hook. BOTH markers must match (the fixed OpenClaw
// prefix AND this plugin's credit) so no other plugin's block, no engine reply that
// merely quotes the phrase, and no real delivery error is ever suppressed. Scoped
// to the brokered channels only.
const SUPPRESS_CHANNELS = new Set(["telegram", "discord"]);
function shouldSuppressOutbound(content, channel) {
  if (!SUPPRESS_CHANNELS.has(String(channel == null ? "" : channel).toLowerCase())) return false;
  const t = String(content == null ? "" : content);
  return t.startsWith("Your message could not be sent") && t.includes("blocked by agenthost-channel-broker");
}

module.exports = { buildDispatchRequest, interpretDispatchResponse, shouldSuppressOutbound };
