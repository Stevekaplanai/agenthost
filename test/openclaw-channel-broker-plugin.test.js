// Unit tests for container/openclaw-channel-broker/index.js's pure pieces, plus the
// plugin-definition wrapper (id/register) that's actually loaded on the box. extractRouting()
// and beforeAgentRun()'s decision logic are plain object/network-free code and can be
// proven correct independent of the SDK. Field shapes (event carries prompt/senderId; ctx
// carries channel/messageProvider/senderId) are copied from openclaw@2026.6.33's real
// PluginHookBeforeAgentRunEvent / PluginHookAgentContext .d.ts types, installed and read
// directly this pass -- not invented, not from prose docs alone.
import { test } from "node:test";
import assert from "node:assert/strict";

// Several unrelated gate-*.test.js files boot a real gate.js subprocess without overriding
// CHANNEL_DISPATCH_PORT, so port 8091 (the module's default) is shared, contended state
// across the suite -- gate.js's own `.on("error", ...)` handler makes losing binds silent,
// but a WINNING bind is a real listener a concurrent test file's client request can hit.
// Proven flaky by running the full suite repeatedly: one run got a live 403 from someone
// else's gate.js instead of the ECONNREFUSED this test needs. Set an explicit, unshared port
// BEFORE importing so the module reads it at load time (a static top-level import would be
// hoisted ahead of any assignment, so this must be a dynamic import after the env var is set).
process.env.CHANNEL_DISPATCH_PORT = "18091";
// The module does `module.exports = plugin` (a single object), so under Node's CJS->ESM
// interop the plugin object is the DEFAULT export, not a set of named exports -- bind off
// `.default`. (This is exactly the shape OpenClaw's loader consumes: a module whose export
// is one OpenClawPluginDefinition object.)
const plugin = (await import("../container/openclaw-channel-broker/index.js")).default;
const { extractRouting, beforeAgentRun, BROKERED_CHANNELS } = plugin;

test("BROKERED_CHANNELS is exactly telegram/discord (WhatsApp stays Hermes-owned, never OpenClaw)", () => {
  assert.deepEqual([...BROKERED_CHANNELS].sort(), ["discord", "telegram"]);
});

test("extractRouting reads channel/messageProvider off ctx (the SECOND handler arg), never off event", () => {
  // The real PluginHookBeforeAgentRunEvent type has no `channel`/`messageProvider` field at
  // all -- only PluginHookAgentContext (ctx) does. A prior version of this draft read
  // event.channel and would have silently gotten `undefined` for every real channel message.
  const r = extractRouting({ prompt: "hi there", senderId: "event-sender" }, { channel: "telegram" });
  assert.equal(r.channel, "telegram");
  assert.equal(r.text, "hi there");
});

test("extractRouting falls back to ctx.messageProvider when ctx.channel is absent", () => {
  const r = extractRouting({ prompt: "x" }, { messageProvider: "discord" });
  assert.equal(r.channel, "discord");
});

test("extractRouting carries chatId (the reply target) off ctx -- group id may differ from senderId", () => {
  const r = extractRouting(
    { prompt: "hi", senderId: "user-1" },
    { channel: "telegram", senderId: "user-1", chatId: "group-777" }
  );
  assert.equal(r.chatId, "group-777", "chatId is the conversation to reply into");
  assert.equal(r.senderId, "user-1");
  assert.equal(r.chatId === r.senderId, false, "a group reply must not go to the sender's DM");
});

test("extractRouting lowercases the channel so mixed-case never fails the brokered check (red-team fail-open fix)", () => {
  // If OpenClaw ever delivered "Telegram"/"Discord" casing, a raw BROKERED_CHANNELS.has()
  // would miss it and the untrusted message would reach OpenClaw's ungoverned agent.
  assert.equal(extractRouting({ prompt: "x" }, { channel: "Telegram" }).channel, "telegram");
  assert.equal(extractRouting({ prompt: "x" }, { messageProvider: "DISCORD" }).channel, "discord");
  assert.equal(BROKERED_CHANNELS.has(extractRouting({ prompt: "x" }, { channel: "Telegram" }).channel), true, "a mixed-case brokered channel is still recognized as brokered");
});

test("beforeAgentRun blocks a mixed-case brokered channel (does NOT fall through to OpenClaw's agent)", async () => {
  const r = await beforeAgentRun({ prompt: "hi" }, { channel: "Telegram", senderId: "tg-1" });
  assert.equal(r.outcome, "block", "mixed-case must still route through the gate, never fall open to the ungoverned agent");
});

test("extractRouting prefers event.senderId, falls back to ctx.senderId", () => {
  assert.equal(extractRouting({ senderId: "from-event" }, { senderId: "from-ctx" }).senderId, "from-event");
  assert.equal(extractRouting({}, { senderId: "from-ctx" }).senderId, "from-ctx");
});

test("extractRouting tolerates missing/undefined event and ctx", () => {
  assert.deepEqual(extractRouting(undefined, undefined), { channel: undefined, senderId: undefined, chatId: undefined, text: undefined });
});

test("beforeAgentRun passes (returns undefined) for a channel this box does not broker", async () => {
  const r = await beforeAgentRun({ prompt: "hi" }, { channel: "whatsapp", senderId: "w-1" });
  assert.equal(r, undefined, "WhatsApp is Hermes-owned; OpenClaw's own agent must run unaffected");
});

test("beforeAgentRun blocks a brokered channel even when the dispatcher is unreachable (fail closed)", async () => {
  const r = await beforeAgentRun({ prompt: "hi" }, { channel: "telegram", senderId: "tg-1" });
  assert.equal(r.outcome, "block", "no dispatcher listening in this test -> connection refused -> fail closed, never let OpenClaw's own agent run");
  assert.equal("message" in r, false, "no safe reply text on a transport failure -- key must be OMITTED, not empty, per the real isHookDecision validator");
  assert.match(r.reason, /channel-dispatch unreachable/);
});

test("beforeAgentRun's block decision always has a non-empty reason (real isHookDecision requires it)", async () => {
  const r = await beforeAgentRun({ prompt: "hi" }, { channel: "discord", senderId: "d-1" });
  assert.equal(typeof r.reason, "string");
  assert.ok(r.reason.trim().length > 0);
});

test("the plugin definition matches OpenClawPluginDefinition: string id + a register(api) function", () => {
  assert.equal(plugin.id, "agenthost-channel-broker", "id is the stable plugin id claw-setup.sh enables in config.entries");
  assert.equal(typeof plugin.register, "function");
  assert.equal(typeof plugin.name, "string");
  assert.equal(typeof plugin.description, "string");
});

test("register(api) subscribes beforeAgentRun to the before_agent_run hook at high priority via api.on", () => {
  // Records exactly what register() does to the real OpenClawPluginApi surface. api.on
  // (NOT api.registerHook -- a different, unrelated internal event system) is the verified
  // conversation-hook seam; priority 1000 ensures this plugin gets a turn before another
  // plugin's higher-priority block could short-circuit the chain (see the file banner).
  const calls = [];
  plugin.register({ on: (hookName, handler, opts) => calls.push({ hookName, handler, opts }) });
  assert.equal(calls.length, 2, "registers exactly two hooks: the inbound choke point + the outbound notice suppressor");
  assert.equal(calls[0].hookName, "before_agent_run");
  assert.equal(calls[0].handler, beforeAgentRun, "wires the very function tested above, not a wrapper that could drift");
  assert.equal(calls[0].opts.priority, 1000);
  assert.equal(calls[1].hookName, "message_sending", "outbound: cancels this plugin's own block notice (2026-07-24)");
  assert.equal(calls[1].handler, plugin.messageSending, "same drift rule: the exported, unit-tested function itself");
  assert.equal(calls[1].opts.priority, 1000);
});

test("messageSending cancels ONLY this plugin's block notice; everything else passes untouched", () => {
  const cancel = plugin.messageSending(
    { content: "Your message could not be sent: blocked by agenthost-channel-broker", metadata: { channel: "discord" } },
    { channelId: "discord" });
  assert.equal(cancel && cancel.cancel, true);
  assert.match(String(cancel.cancelReason || ""), /out-of-band/);
  // A real engine reply (delivered via `openclaw message send`) must NEVER be cancelled.
  assert.equal(plugin.messageSending({ content: "Here is the board summary you asked for." }, { channelId: "telegram" }), undefined);
  // Another plugin's block must reach the user.
  assert.equal(plugin.messageSending(
    { content: "Your message could not be sent: blocked by someone-elses-plugin" }, { channelId: "telegram" }), undefined);
  // channel can also arrive via event.metadata when ctx lacks channelId.
  const viaMeta = plugin.messageSending(
    { content: "Your message could not be sent: x (blocked by agenthost-channel-broker)", metadata: { channel: "telegram" } }, {});
  assert.equal(viaMeta && viaMeta.cancel, true);
});
