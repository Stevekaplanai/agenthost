// Unit tests for container/openclaw-channel-broker/openclaw-harness-adapter.js -- the pure translation layer
// between OpenClaw's harness SDK and the real /internal/channel-dispatch endpoint. Every
// response shape here is copied from the endpoint's REAL behavior (container/gate.js
// handleChannelDispatch, container/channel-dispatch.js dispatchDecision), not invented, so
// a change to the endpoint's envelope shape breaks this test, not just the plugin silently.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDispatchRequest, interpretDispatchResponse, shouldSuppressOutbound } from "../container/openclaw-channel-broker/openclaw-harness-adapter.js";

test("buildDispatchRequest emits exactly the fields handleChannelDispatch reads, nothing extra", () => {
  const req = buildDispatchRequest({ channel: "telegram", senderId: "tg-42", chatId: "grp-9", text: "hi" });
  assert.deepEqual(req, { channel: "telegram", senderId: "tg-42", chatId: "grp-9", text: "hi" });
  assert.deepEqual(Object.keys(req).sort(), ["channel", "chatId", "senderId", "text"]);
});

test("403 (auth failure) -> transport_error, no user-facing text", () => {
  const r = interpretDispatchResponse(403, { error: "forbidden" });
  assert.equal(r.outcome, "transport_error");
  assert.equal(r.replyText, null);
  assert.equal(r.terminal, true);
});

test("a reject envelope (real CHANNEL_NOT_ENABLED shape) is SILENT -- gate.js delivers the summary out-of-band (2026-07-24: OpenClaw has no silent block; any replyText here arrives error-framed)", () => {
  const body = {
    status: "error", summary: "That channel is turned off.",
    next_actions: ["Enable it in Settings, then reconnect."], artifacts: [],
    error: { code: "CHANNEL_NOT_ENABLED", retry: "Enable the channel, then retry.", stopCondition: "Do not handle inbound for a disabled channel." },
  };
  const r = interpretDispatchResponse(400, body);
  assert.equal(r.outcome, "rejected");
  assert.equal(r.replyText, null, "silent: the gate delivers the reject summary itself, unwrapped");
  assert.match(r.logDetail, /CHANNEL_NOT_ENABLED/);
});

test("a reject envelope (real CHANNEL_CREDENTIAL_MISSING shape) is silent too, logDetail keeps the code", () => {
  const body = {
    status: "error", summary: "This channel has no credential in the vault.",
    next_actions: ["Add the token in Settings (stored in the vault)."], artifacts: [],
    error: { code: "CHANNEL_CREDENTIAL_MISSING", retry: "Add the credential, then retry.", stopCondition: "Never run a channel half-configured." },
  };
  const r = interpretDispatchResponse(400, body);
  assert.equal(r.outcome, "rejected");
  assert.equal(r.replyText, null, "silent: gate.js owns all user-facing delivery");
  assert.match(r.logDetail, /CHANNEL_CREDENTIAL_MISSING/);
});

test("a gate envelope (consequence) is silent -- gate.js delivers summary + confirm instruction out-of-band", () => {
  // Matches channel-dispatch.js's real warn() text for CHAT_CONSEQUENCE_CONFIRM.
  const body = {
    status: "warning", summary: "Consequential channel turn held for confirmation; not run.",
    next_actions: ["Re-send the same message to confirm."], artifacts: [],
  };
  const r = interpretDispatchResponse(200, body);
  assert.equal(r.outcome, "gated");
  assert.equal(r.replyText, null, "silent: the sender still SEES the gate -- via the gate's own delivery, unwrapped");
  assert.match(r.logDetail, /gated/);
});

test("a gate envelope (spend cap) is silent for the same reason", () => {
  const body = { status: "warning", summary: "Daily chat governance cap reached; this turn was not run.", next_actions: [], artifacts: [] };
  const r = interpretDispatchResponse(200, body);
  assert.equal(r.outcome, "gated");
  assert.equal(r.replyText, null);
});

test("a dispatch acknowledgement (gate passed) stays SILENT -- the gate answers out-of-band, so the broker must not also reply", () => {
  const body = {
    status: "success", summary: "Channel turn passed the gate; the chat engine is answering (reply delivered to the channel).",
    next_actions: [], artifacts: [{ type: "channel_dispatch", channel: "telegram", owner: "openclaw", gated: false }],
  };
  const r = interpretDispatchResponse(200, body);
  assert.equal(r.outcome, "dispatched");
  assert.equal(r.replyText, null, "the gate delivers the engine's reply itself; a broker reply here would double-message the user");
  assert.match(r.logDetail, /out_of_band/);
});

test("malformed / unexpected bodies fail closed to transport_error, never throw", () => {
  for (const bad of [null, undefined, {}, { status: 123 }, "a string", [], { status: "something-new" }]) {
    let r;
    assert.doesNotThrow(() => { r = interpretDispatchResponse(200, bad); });
    assert.ok(["transport_error"].includes(r.outcome) || r.outcome === "transport_error");
    assert.equal(r.replyText, null);
    assert.equal(r.terminal, true);
  }
});

test("every outcome is terminal today (no streaming exists yet)", () => {
  const cases = [
    [403, {}],
    [400, { status: "error", summary: "x", error: { code: "CHANNEL_UNKNOWN" } }],
    [200, { status: "warning", summary: "x" }],
    [200, { status: "success", summary: "x", artifacts: [] }],
  ];
  for (const [status, body] of cases) assert.equal(interpretDispatchResponse(status, body).terminal, true);
});

// ---- message_sending suppression (2026-07-24): cancel exactly our own block notice ----

test("shouldSuppressOutbound cancels OpenClaw's block notice credited to THIS plugin, on brokered channels", () => {
  const bare = 'Your message could not be sent: blocked by agenthost-channel-broker';
  const withMsg = 'Your message could not be sent: some detail (blocked by agenthost-channel-broker)';
  assert.equal(shouldSuppressOutbound(bare, "telegram"), true);
  assert.equal(shouldSuppressOutbound(withMsg, "discord"), true);
});

test("shouldSuppressOutbound NEVER cancels other plugins' blocks, real errors, or replies that merely quote the phrase", () => {
  assert.equal(shouldSuppressOutbound('Your message could not be sent: blocked by some-other-plugin', "telegram"), false,
    "another plugin's block must reach the user");
  assert.equal(shouldSuppressOutbound('Your message could not be sent: network unreachable', "telegram"), false,
    "a real delivery error must reach the user");
  assert.equal(shouldSuppressOutbound('FYI the old bug showed "blocked by agenthost-channel-broker" to users', "telegram"), false,
    "an engine reply QUOTING the marker mid-text lacks the fixed prefix -- never suppressed");
  assert.equal(shouldSuppressOutbound('Your message could not be sent: blocked by agenthost-channel-broker', "whatsapp"), false,
    "non-brokered channel: not ours to touch");
  assert.equal(shouldSuppressOutbound(null, "telegram"), false);
  assert.equal(shouldSuppressOutbound('Your message could not be sent: blocked by agenthost-channel-broker', null), false);
});
