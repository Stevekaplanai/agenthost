// ============================================================================
// WIRED 2026-07-23. VERIFIED against a real openclaw@2026.6.33 install + this exact
// committed plugin directory by scripts/verify-openclaw-seam.mjs (green; re-run it after
// any change here). What that harness proves, by driving OpenClaw's OWN hook runner the
// way the inbound dispatch pipeline does (see the seam trace two paragraphs down):
//   1. this committed DIRECTORY loads into a real Gateway
//      (`http server listening (8 plugins: agenthost-channel-broker, ...)`) AND registers
//      a `before_agent_run` hook (`hookRunner.hasHooks("before_agent_run") === true`);
//   2. calling the real `runBeforeAgentRun(event, ctx)` with a TELEGRAM ctx invokes THIS
//      handler, which POSTs to `/internal/channel-dispatch` (correct x-agenthost-channel-
//      token + `{channel,senderId,text}` body) and returns `{outcome:"block"}` credited to
//      `agenthost-channel-broker` -- i.e. OpenClaw's own agent is suppressed on a brokered
//      channel, which is the whole point of this plugin;
//   3. a NON-brokered channel (whatsapp -- Hermes-owned) returns `undefined` (pass) and
//      never POSTs -- the Hermes boundary holds.
//
// MODEL-KEY PRECONDITION (proven live 2026-07-23, the one operational gotcha): OpenClaw's
// embedded runner resolves the agent MODEL before it runs this hook. With NO provider key
// at all, the turn dies on `ProviderAuthError` at model-selection BEFORE before_agent_run
// ever fires -- the broker never runs and the channel is dead, not governed. With ANY key
// present (even `agenthost-relay-placeholder-never-used` -- literally that string,
// verified), the hook fires and blocks BEFORE the key is ever used: block reply in ~2s,
// zero provider attempts, OpenClaw's own framing `"Your message could not be sent:
// <message> (blocked by agenthost-channel-broker)"`. start.sh's openclaw window therefore
// exports that placeholder when no real key exists; claw-setup.sh's `--auth-choice skip`
// relay-only mode depends on it. (This gotcha is also why an earlier session wrongly
// "corrected" this banner to say the hook never fires under `openclaw agent` -- that test
// env simply had no model key, so it died before the hook; with a key configured the
// original claim reproduces exactly. And the still-earlier counter-finding that the hook
// "didn't fire" for the committed plugin predates PR #103 -- the plugin wasn't LOADING at
// all then, which was the packaging bug, not the seam. Every historical observation is
// now explained; scripts/verify-openclaw-seam.mjs is the re-runnable arbiter.)
//
// STILL GENUINELY OPEN (needs the box + real bot credentials, unprovable in a sandbox):
// a live Telegram/Discord message arriving over a real bot connection and traversing
// dispatch-*.js end-to-end. Everything DOWNSTREAM of "a message reaches runBeforeAgentRun"
// is proven above; the one remaining link ("a real inbound message reaches
// runBeforeAgentRun") is established by static reading of the shipped dispatch code
// (dispatch-*.js: ensureRuntimePluginsLoaded -> selectAgentHarness ->
// createOpenClawAgentHarness().runAttempt === runEmbeddedAttempt -> the `if
// hasHooks("before_agent_run")` call site) plus the live `openclaw agent` firings above,
// not yet by a live bot message. Flip this to fully closed once a real inbound message is
// observed hitting /internal/channel-dispatch on the box.
//
// This pass (same night, follow-up) did a SECOND fresh `npm install openclaw` and read the
// real shipped `dist/plugin-sdk/*` and `dist/types-*.d.ts` again specifically to verify the
// exact registration call this file makes below (`definePluginEntry`/`api.on`) against
// real source, not the plan sketch that used to live at the bottom of this file:
//   - `definePluginEntry` (real impl, `dist/plugin-entry-*.js`) is PURE OBJECT-SHAPING SUGAR
//     with no side effects -- it just returns `{id, name, description, ..., configSchema,
//     register}`. Since `OpenClawPluginModule = OpenClawPluginDefinition | ((api) => void)`,
//     a plain object built by hand satisfies the real type exactly. Building it by hand
//     (below) instead of `require("openclaw/plugin-sdk/core")` avoids a real, non-obvious
//     risk: this file's actual on-disk location once installed (wherever `claw-setup.sh`
//     points `plugins.load.paths` at, `/opt/agenthost/` in this repo) has no guaranteed
//     `node_modules/openclaw` ancestor for a bare `require("openclaw/...")` to resolve
//     against, since it isn't installed via `npm install` alongside the plugin the way
//     the spike's scratch directory was.
//   - `OpenClawPluginApi` (the real object passed to `register(api)`, `dist/types-*.d.ts`)
//     really does expose `on: <K extends PluginHookName>(hookName: K, handler:
//     PluginHookHandlerMap[K], opts?: {priority?, timeoutMs?}) => void` -- confirmed real,
//     not the DIFFERENT generic `registerHook(events, handler, opts)` method on the same
//     object (that one takes an `InternalHookHandler = (event) => void` for a wholly
//     separate command/session/agent/gateway/message event system, NOT the conversation
//     hooks this plugin needs -- a genuine dead end this pass ruled out by reading both
//     handler signatures side by side, not by assuming the first match was the right one).
//   - `{priority: 1000}` is a real, typed option on `.on(...)` (not invented).
// This replaces the removed historical Agent Harness prototype. That prototype
// used OpenClaw's Agent Harness plugin SDK
// (`api.registerAgentHarness`), which -- confirmed by reading its real `.d.ts` types --
// selects an execution BACKEND by provider/model route (`supports(ctx)` receives only
// `ctx.modelProvider`/`ctx.provider`, nothing about channels) and never owns channel
// delivery. It cannot intercept a channel message or suppress OpenClaw's own agent.
// ============================================================================
//
// The real seam is the `before_agent_run` plugin hook. What follows is CONFIRMED by
// reading `node_modules/openclaw/dist/plugin-sdk/hook-types-*.d.ts` (the real published
// types) and `node_modules/openclaw/dist/hook-runner-global-*.js` (the real compiled
// dispatcher, not minified beyond variable names), not by reading prose docs:
//
// 1. HANDLER SIGNATURE IS TWO ARGUMENTS, NOT ONE -- this was a real bug in the previous
//    version of this draft, caught by reading the actual type:
//      before_agent_run: (event: PluginHookBeforeAgentRunEvent, ctx: PluginHookAgentContext) => ...
//    `event` carries ONLY: `{ prompt: string, messages: unknown[], systemPrompt?, accountId?,
//    channelId?, senderId?, senderIsOwner? }` -- notably NO `channel` or `messageProvider`
//    field. The platform name ("telegram"/"discord") lives on the SECOND argument, `ctx`
//    (`PluginHookAgentContext`): `{ ..., messageProvider?: string, channel?: string,
//    chatId?: string, senderId?: string, channelId?: string, ..., channelContext?: {...} }`.
//    The previous draft read `event.channel || event.messageProvider` -- both undefined on
//    the real event shape, since those fields only exist on ctx. Fixed below.
// 2. `event.senderId` IS real and directly on the event (also mirrored on `ctx.senderId`) --
//    a genuine per-user channel-scoped id, not a role/ownership flag. This is what the
//    broker's sender-bound confirm-floor needs and gets right.
// 3. RETURN CONTRACT, confirmed from the real `isHookDecision`/`runModifyingHook` source,
//    not just the type:
//    - Returning nothing / `undefined` is skipped by the runner's OWN outer guard
//      (`if (handlerResult !== void 0 ...)`) before it ever reaches decision-merging --
//      i.e. a true no-op "pass", exactly as documented. CONFIRMED, not inferred.
//    - Returning `{ outcome: "block", reason, message?, category?, metadata? }` is
//      validated by a real `isHookDecision()` function: `reason` MUST be a non-empty
//      trimmed string; if `message` (or `category`) is PRESENT it must ALSO be a
//      non-empty trimmed string -- an empty string is NOT the same as omitting the key,
//      and gets rejected as an "invalid decision", losing the real reason/message and
//      replacing it with a generic internal one. This draft already omits the `message`
//      key entirely (not `message: null`/`""`) for the no-safe-reply case, which is
//      confirmed to be the ONLY correct way to do a silent block.
//    - A `{ outcome: "pass" }` decision is valid ONLY with EXACTLY one key -- confirmed
//      from `isHookDecision`: `if (v.outcome === "pass") return keys.length === 1;`. This
//      draft avoids the risk entirely by returning `undefined` instead (see above), never
//      constructing a pass object.
// 4. MULTI-HANDLER SEMANTICS, confirmed from the real merge logic in
//    `runBeforeAgentRun`/`runModifyingHook`: decisions merge as "most restrictive wins" --
//    ANY handler returning `block` beats every other handler's `pass`, REGARDLESS OF
//    PRIORITY ORDER (`normalized.outcome === "block" && _acc.outcome !== "block" ?
//    normalized : _acc`). This resolves what the previous draft flagged as an open
//    uncertainty (needing high priority to "beat" a pass) -- that was never actually a
//    real risk; block always wins. Priority still matters for a DIFFERENT reason: the
//    runner short-circuits (`shouldStop: result?.outcome === "block"`) on the FIRST block
//    it hits in priority order, so if some OTHER plugin's higher-priority handler blocks
//    this turn first (for an unrelated reason), THIS plugin's handler never runs at all --
//    meaning our broker logic (the dispatcher call) gets skipped entirely for that
//    message. High priority is for making sure we get a turn, not for winning a decision
//    fight we'd have won anyway.
// 5. FAIL-CLOSED BY DEFAULT, confirmed from real source: `before_agent_run` is the ONE
//    hook the runner defaults to `failurePolicyByHook: { before_agent_run: "fail-closed" }`
//    (every other hook defaults to fail-OPEN). If this handler throws or times out
//    (15s default, confirmed from `DEFAULT_MODIFYING_HOOK_TIMEOUT_MS_BY_HOOK`), OpenClaw's
//    own runtime already fails the turn closed rather than letting the agent run --
//    reinforcing, not just matching, this broker's own fail-closed design.
//
// Genuinely still open after this pass (a real gateway run is the only way to close
// these; everything else above is now source-confirmed, not guessed):
//   1. `event.prompt` vs `event.content`: `inbound_claim` uses `content`, not `prompt`;
//      `before_agent_run`'s type confirms `prompt` is correct for THIS hook, but an actual
//      channel message's exact text shape (formatting, mentions stripped or not) is only
//      provable against a live message.
//   2. RESOLVED, no longer a fork: `before_agent_run` stays the committed seam over
//      `inbound_claim`, but on corrected grounds (the earlier claim that before_agent_run
//      "fired every time" under `openclaw agent` does not reproduce -- see the HONEST
//      CORRECTION in the top banner; `openclaw agent` fires NEITHER hook). What actually
//      decides it: `before_agent_run` sits at the one choke point every inbound-driven
//      agent turn must pass (runEmbeddedAttempt, the embedded harness's runAttempt --
//      proven callable with this plugin loaded by scripts/verify-openclaw-seam.mjs),
//      while `inbound_claim` is a message-receipt-pipeline hook this sandbox cannot
//      drive at all without a live bot connection. `before_agent_run` is also the one
//      hook OpenClaw fail-closes by default (point 5 above) and is directly provable
//      here; `ReplyPayload` turned out to be a non-issue (every field is optional, so
//      `{text: "..."}` is valid). Sticking with it.
//   3. RESOLVED: `hooks.allowConversationAccess: true` plus a normal plugin install/enable
//      (`plugins.load.paths` + `plugins.entries.<id>.enabled: true`) is sufficient -- no
//      additional manifest capability needed. This is now proven with the EXACT writer that
//      ships on the box: scripts/verify-openclaw-seam.mjs (and the gateway run behind it)
//      loads this plugin from config keys written by container/openclaw-plugin-config.js's
//      enableChannelBrokerPlugin() -- the same code claw-setup.sh runs -- and the gateway
//      lists it (`8 plugins: agenthost-channel-broker, ...`). Only real bot credentials and
//      live inbound traffic remain (Steve's box).
// ============================================================================

const http = require("http");
const { buildDispatchRequest, interpretDispatchResponse, shouldSuppressOutbound } = require("./openclaw-harness-adapter.js");

const DISPATCH_HOST = "127.0.0.1";
const DISPATCH_PORT = Number(process.env.CHANNEL_DISPATCH_PORT || 8091);
const DISPATCH_TOKEN = process.env.CHANNEL_DISPATCH_TOKEN; // same box secret gate.js reads

// The channels this broker owns via OpenClaw (WhatsApp is Hermes-owned; see
// CONT-05-RUNTIME-PLAN.md's broker decision). A message on any other channel returns
// undefined (pass) -- confirmed safe: the runner's own outer guard skips a handler that
// returns undefined before decision-merging even sees it, so OpenClaw behaves normally.
const BROKERED_CHANNELS = new Set(["telegram", "discord"]);

function postDispatch(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: DISPATCH_HOST, port: DISPATCH_PORT, path: "/internal/channel-dispatch", method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "x-agenthost-channel-token": DISPATCH_TOKEN || "",
      },
      timeout: 15000,
    }, (res) => {
      let raw = "";
      res.on("data", (c) => { raw += c; });
      res.on("end", () => {
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch { /* interpretDispatchResponse handles malformed bodies */ }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on("timeout", () => { req.destroy(new Error("channel-dispatch request timed out")); });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// Pure: extract {channel, senderId, text} from a before_agent_run (event, ctx) pair.
// Field sourcing confirmed against openclaw@2026.6.33's real PluginHookBeforeAgentRunEvent /
// PluginHookAgentContext types: `channel` only ever exists on ctx (never on event); `prompt`
// and `senderId` exist on event directly. No SDK/network dependency, unit tested without a
// real OpenClaw install (test/openclaw-channel-broker-plugin.test.js).
//
// The channel is LOWERCASED here (red-team fix, 2026-07-23). BROKERED_CHANNELS is
// lowercase, and if any OpenClaw version delivered "Telegram"/"Discord" casing, a raw
// `BROKERED_CHANNELS.has(channel)` would be false -> the handler would return undefined
// (pass) -> the untrusted channel message would reach OpenClaw's OWN ungoverned agent.
// That is a true fail-open against the one invariant this broker exists to hold ("a
// brokered channel NEVER falls through to OpenClaw's agent"), so normalize before the
// membership check. The lowercased value is also what we send to the dispatch endpoint,
// whose config lookups (settings-lib / ~/.openclaw) key on canonical lowercase channel
// ids. senderId and text are passed through untouched (never case-fold user content).
function extractRouting(event, ctx) {
  const rawChannel = ctx && (ctx.channel || ctx.messageProvider);
  const channel = typeof rawChannel === "string" ? rawChannel.toLowerCase() : rawChannel;
  const senderId = (event && event.senderId) || (ctx && ctx.senderId);
  // chatId is the conversation the reply must go back to (group id != sender id;
  // for DMs they usually coincide). Lives only on ctx, like channel. The gate
  // uses it as the delivery target for the engine's out-of-band answer and
  // falls back to senderId when absent.
  const chatId = ctx && ctx.chatId;
  const text = event && event.prompt;
  return { channel, senderId, chatId, text };
}

// The before_agent_run handler. High priority so this plugin reliably gets a turn before
// some other plugin's higher-priority block short-circuits the hook chain first (block
// always beats pass regardless of order, per the confirmed merge semantics above -- the
// priority is about not being skipped entirely, not about winning a decision fight).
async function beforeAgentRun(event, ctx) {
  const { channel, senderId, chatId, text } = extractRouting(event, ctx);
  if (!BROKERED_CHANNELS.has(channel)) return; // not ours: pass (confirmed no-op return)

  let response;
  try {
    response = await postDispatch(buildDispatchRequest({ channel, senderId, chatId, text }));
  } catch (e) {
    // Dispatcher unreachable: fail closed. Block rather than let OpenClaw's own agent run
    // ungoverned on a channel this plugin claimed -- per the broker decision, this channel
    // NEVER falls back to OpenClaw's built-in agent, even when our own endpoint is down.
    return { outcome: "block", reason: "channel-dispatch unreachable: " + e.message };
  }

  const decision = interpretDispatchResponse(response.status, response.body);
  // Every outcome blocks OpenClaw's own agent (per the broker decision, this channel's
  // agent is always suppressed); replyText (when present) becomes the user-facing message.
  // "dispatched" (gate passed, no engine wired yet) and "transport_error" carry no safe
  // reply text -- the `message` key is OMITTED entirely (not set to null/""), which is
  // confirmed by the real isHookDecision() validator to be the only way to produce a
  // genuinely silent block; an empty-string message would be rejected as an invalid
  // decision and replaced with a generic one, losing this reason text.
  return decision.replyText
    ? { outcome: "block", reason: decision.logDetail, message: decision.replyText }
    : { outcome: "block", reason: decision.logDetail };
}

// message_sending: cancel exactly this plugin's OWN block notice on its way out.
// OpenClaw has no silent block -- every before_agent_run block above becomes a
// user-visible "Your message could not be sent: ... (blocked by
// agenthost-channel-broker)" (resolveBlockMessage, verified in source), which on a
// live box meant EVERY answered message showed an error first, then the real reply
// arrived out-of-band. message_sending is OpenClaw's documented modify-or-cancel
// hook for outgoing messages ({cancel:true} -> the delivery loop drops it,
// verified in both the generic deliver path and telegram's own delivery). The
// predicate (openclaw-harness-adapter.js shouldSuppressOutbound) requires BOTH the
// fixed OpenClaw prefix and this plugin's credit, on brokered channels only, so
// gate-delivered replies, other plugins' blocks, and real errors always pass.
// Returning undefined = no opinion (runner skips it before decision-merging).
function messageSending(event, ctx) {
  const channel = (ctx && ctx.channelId) || (event && event.metadata && event.metadata.channel);
  if (shouldSuppressOutbound(event && event.content, channel)) {
    return { cancel: true, cancelReason: "agenthost-channel-broker block notice suppressed (the gate delivers all user-facing text out-of-band)" };
  }
  return undefined;
}

// The plugin definition OpenClaw's loader actually loads (`plugins.load.paths`, wired by
// container/claw-setup.sh via container/openclaw-plugin-config.js). This is a PLAIN OBJECT
// matching `OpenClawPluginDefinition`/`OpenClawPluginModule`, built by hand rather than via
// `definePluginEntry` from the "openclaw" package -- see the file banner for why (that
// helper is pure object-shaping sugar with no side effects; a hand-built object is
// identical and needs no "openclaw" package to be resolvable from this file's on-disk
// location). `register(api)` uses the real, verified `api.on(hookName, handler, opts)`
// method (NOT the different `api.registerHook(...)` method, which is for a separate,
// unrelated internal event system -- see the banner).
//
// `inbound_claim` was compared and ruled out (open item #2 above) -- before_agent_run is
// the committed seam.
const plugin = {
  id: "agenthost-channel-broker",
  name: "AgentHost Channel Broker",
  description: "Routes Telegram/Discord messages through AgentHost's channel-dispatch " +
    "governance gate (consequence confirm-floor + daily spend cap) before OpenClaw's own " +
    "agent runs. WhatsApp stays Hermes-owned and is never touched by this plugin.",
  register(api) {
    api.on("before_agent_run", beforeAgentRun, { priority: 1000 });
    // Outbound: cancel this plugin's own block notice (see messageSending above).
    api.on("message_sending", messageSending, { priority: 1000 });
  },
  // Exported alongside the plugin definition for direct unit testing --
  // test/openclaw-channel-broker-plugin.test.js exercises these without a real OpenClaw
  // install (no SDK/network dependency; see each function's own comment above).
  beforeAgentRun,
  messageSending,
  extractRouting,
  postDispatch,
  BROKERED_CHANNELS,
};

module.exports = plugin;
