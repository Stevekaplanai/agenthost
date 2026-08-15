// providers-lib.js -- CONT-01 dormant shared provider registry.
//
// Contract: docs/continuity/CONTRACT.md (CONT-00, v1). This is the ONE
// server-owned place that knows which inference providers the box can use, what
// route each teammate is on, and what each teammate can do right now. It is an
// OBSERVATION layer, not a second permissions system -- roster, jail, autonomy,
// review, budget, and Git Ladder decisions stay where they already live.
//
// DORMANT by design (CONT-01): Moonshot defaults disabled, no Kimi engine
// exists yet, and nothing here spawns a process, opens a socket, or reads a
// credential VALUE. Pure logic + shape only -- gate.js supplies the live inputs
// (settings, box-secret presence) and mounts the routes. This mirrors
// settings-lib.js: no gate imports, no network, unit-testable in isolation.
//
// Security-sensitive fields (origin, credential name, adapter, allowed models,
// header/tool/url permissions) are CODE-OWNED here and are NOT writable through
// settings. An operator can flip an enable flag and pick an allowlisted model;
// they can never point an adapter at a new URL or map it to a different secret.

"use strict";

// ---- code-owned registry ----------------------------------------------------
// Order is the display order. Adding/altering an entry is a reviewed contract
// change, never a settings write. Unknown IDs fail closed everywhere below.
const PROVIDERS = [
  { id: "anthropic", label: "Anthropic", routeOwnership: "runtime-fixed", operatorSelectable: false, testable: false },
  { id: "openai",    label: "OpenAI",    routeOwnership: "runtime-fixed", operatorSelectable: false, testable: false },
  { id: "google",    label: "Google",    routeOwnership: "runtime-fixed", operatorSelectable: false, testable: false },
  {
    id: "ollama", label: "Ollama", routeOwnership: "service", operatorSelectable: false, testable: true,
    adapter: "ollama-loopback", endpointPolicy: "fixed-loopback", origin: "http://127.0.0.1:11434",
    allowsTools: false, allowsCustomHeaders: false, allowsCustomUrl: false,
  },
  {
    id: "moonshot", label: "Moonshot", routeOwnership: "agenthost-managed", operatorSelectable: true, testable: true,
    adapter: "moonshot-chat", endpointPolicy: "fixed-moonshot-api", origin: "https://api.moonshot.ai/v1",
    credentialRef: "KIMI_API_KEY", allowedModels: ["kimi-k3"],
    allowsTools: false, allowsCustomHeaders: false, allowsCustomUrl: false,
  },
  {
    id: "deepseek", label: "DeepSeek", routeOwnership: "agenthost-managed", operatorSelectable: false, testable: false,
    adapter: "deepseek-chat", endpointPolicy: "fixed-deepseek-api", origin: "https://api.deepseek.com/v1",
    credentialRef: "DEEPSEEK_API_KEY", allowedModels: ["deepseek-v4-flash"],
    allowsTools: false, allowsCustomHeaders: false, allowsCustomUrl: false,
  },
];

const PROVIDER_BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));

// Kimi retains its original unavailable baseline. DeepSeek's code-owned profile
// records only the fixed route, harness, workspace, and granted Git ceiling.
const KNOWN_AGENTS = ["claude", "codex", "gemini", "hermes", "kimi", "deepseek"];

// ---- deterministic envelopes -------------------------------------------------

function ok(summary, extra) {
  return {
    status: "success",
    summary: String(summary || ""),
    next_actions: (extra && extra.next_actions) || [],
    artifacts: (extra && extra.artifacts) || [],
  };
}

function warn(summary, extra) {
  return { ...ok(summary, extra), status: "warning" };
}

function fail(code, retry, stopCondition) {
  return {
    status: "error",
    summary: String(code || "error"),
    next_actions: [],
    artifacts: [],
    error: {
      code: String(code || "UNKNOWN"),
      retry: String(retry || ""),
      stopCondition: String(stopCondition || ""),
    },
  };
}

// ---- provider observation ----------------------------------------------------
// input: { enabled, modelId, credentialPresent, reachable?, modelReady?,
//          observedAt? } -- all live values are supplied by gate.js. This
// function NEVER receives or returns a credential value; `credentialPresent` is
// a boolean the caller derives from the box secret store by NAME only.
function buildProviderObservation(providerId, input) {
  const def = PROVIDER_BY_ID.get(providerId);
  if (!def) {
    return {
      type: "provider_observation",
      id: String(providerId || ""),
      data: { state: "unknown", reasonCode: "ACTION_UNSUPPORTED", stale: true },
    };
  }

  const enabled = !!(input && input.enabled);
  const credentialReady = !!(input && input.credentialPresent);
  const reachable = input && "reachable" in input ? input.reachable : null;
  const modelReady = input && "modelReady" in input ? input.modelReady : null;
  const observedAt = (input && input.observedAt) || null;
  const modelIds = def.allowedModels || [];
  const selectedModelId = (input && input.modelId) || modelIds[0] || null;

  const { state, reasonCode } = deriveProviderState({ enabled, credentialReady, reachable, modelReady });

  return {
    type: "provider_observation",
    id: def.id,
    data: {
      label: def.label,
      routeOwnership: def.routeOwnership,
      enabled,
      configured: true,          // stored fields pass the contract; not "reachable"
      credentialReady,           // fixed secret NAME exists -- reveals nothing else
      reachable,                 // true | false | null(not measured)
      modelReady,
      modelIds,
      selectedModelId,
      observedAt,
      stale: observedAt == null, // no live probe yet => stale
      state,
      reasonCode,
    },
  };
}

// The state machine, kept honest: unknown is never optimistically "ready".
function deriveProviderState({ enabled, credentialReady, reachable, modelReady }) {
  if (!enabled) return { state: "disabled", reasonCode: "PROVIDER_DISABLED" };
  if (!credentialReady) return { state: "missing_credential", reasonCode: "PROVIDER_CREDENTIAL_MISSING" };
  if (reachable === false) return { state: "unreachable", reasonCode: "PROVIDER_UNREACHABLE" };
  if (modelReady === false) return { state: "model_unavailable", reasonCode: "MODEL_UNAVAILABLE" };
  if (reachable === true && modelReady === true) return { state: "ready", reasonCode: null };
  return { state: "unchecked", reasonCode: "PROVIDER_UNCHECKED" };
}

// ---- agent profiles ----------------------------------------------------------
// Aggregates the truthful per-agent view. In CONT-01 this returns the dormant
// baseline; existing agents' live runtime/authority get joined in CONT-03. Kimi
// is intentionally all-unavailable here (its capabilities land package by
// package). `live` lets gate.js pass real observations later without changing
// this shape.
function buildAgentProfiles(live) {
  const l = live || {};
  return KNOWN_AGENTS.map((id) => buildOneProfile(id, l[id]));
}

function buildOneProfile(id, obs) {
  const isKimi = id === "kimi";
  const isDeepSeek = id === "deepseek";
  const runtimeFixed = ["claude", "codex", "gemini"].includes(id);
  const cap = (state, reasonCode, extra) => ({ state, reasonCode, ...(extra || {}) });

  return {
    type: "agent_profile",
    id,
    data: {
      displayName: isDeepSeek ? "DeepSeek" : id.charAt(0).toUpperCase() + id.slice(1),
      role: null,
      runtime: {
        id: isKimi ? "kimi-code" : isDeepSeek ? "dsh" : id,
        version: (obs && obs.runtimeVersion) || null,
        state: isKimi ? "unavailable" : (obs && obs.runtimeState) || "unknown",
      },
      providerRoute: {
        source: runtimeFixed ? "runtime-fixed" : (isKimi || isDeepSeek) ? "agenthost-configured" : "runtime-owned",
        primary: isKimi
          ? { providerId: "moonshot", modelId: "kimi-k3" }
          : isDeepSeek
            ? { providerId: "deepseek", modelId: "deepseek-v4-flash" }
            : (obs && obs.primary) || null,
        fallback: null,
        // CONT-02A: observation-only field noting Moonshot as a potential
        // fallback for non-Kimi agents. NOT wired -- just surfaced so the
        // operator/UI can see the routing option exists.
        fallbackProvider: (isKimi || isDeepSeek) ? null : "moonshot",
      },
      workspace: {
        path: isDeepSeek ? "~/workspaces/deepseek" : null,
        state: isKimi ? "unavailable" : (obs && obs.workspaceState) || "unknown",
        isolation: isKimi ? "unproven" : (obs && obs.isolation) || "unknown",
      },
      capabilities: {
        chat: cap("unavailable", isKimi ? "NOT_WIRED" : "NOT_WIRED"),
        terminal: cap("unavailable", isKimi ? "CLI_UNPROVEN" : "NOT_WIRED"),
        unattended: cap("unavailable", isKimi ? "CLI_UNPROVEN" : "NOT_APPROVED"),
        review: cap("unavailable", "NOT_APPROVED"),
        gitMaxRung: isDeepSeek
          ? { state: "available", value: 1 }
          : cap("unavailable", "NOT_APPROVED", { value: 0 }),
      },
      status: isDeepSeek ? (obs && obs.status) || "unknown" : "unavailable",
      activeRunId: null,
      channelIds: [],
      voiceId: null,
      limits: null,
      observedAt: null,
    },
  };
}

// ---- live Moonshot probe (CONT-02A) -------------------------------------------
// Bounded network probe: ONE POST to the fixed Moonshot endpoint with a
// minimal ping (max_completion_tokens: 1, no tools, no caller-supplied URL /
// headers / model). The apiKey is used ONLY inside the Authorization header of
// this fetch call -- it is NEVER placed in the return value, a log, or an
// audit event. Returns { reachable, modelReady } booleans only.
//
// This is an ASYNC function (uses fetch, Node 18+). gate.js calls it from its
// async route handlers; providers-lib.js itself has no other network code and
// remains unit-testable with a mock fetch injection (see tests).
async function probeMoonshot(apiKey, fetchImpl) {
  if (!apiKey) return { reachable: false, modelReady: false };
  const f = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
  if (!f) return { reachable: false, modelReady: false };
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await f("https://api.moonshot.ai/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer " + apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "kimi-k3", messages: [{ role: "user", content: "ping" }], max_completion_tokens: 1 }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    // 200 = reachable + model served the (truncated) reply.
    // 401/403 = reachable (the API answered) but key invalid -> modelReady false.
    // Other non-200 = reachable but model not usable right now.
    return { reachable: true, modelReady: res.status === 200 };
  } catch (e) {
    // Abort (timeout) or network error = not reachable.
    return { reachable: false, modelReady: false };
  }
}

// ---- connection-test planning ------------------------------------------------
// PURE planning only: decides whether a test is allowed and, if so, the exact
// bounded shape gate.js must send. It performs NO network itself -- it returns
// networkCalls: 1 to mean "gate.js may make exactly one bounded call". Any
// caller-supplied url/header/model/tool is a hard reject (the browser cannot
// widen the action into a proxy).
function planConnectionTest(providerId, body) {
  const def = PROVIDER_BY_ID.get(providerId);
  const deny = (errorCode) => ({ accepted: false, networkCalls: 0, errorCode });

  if (!def || !def.testable) return deny("ACTION_UNSUPPORTED");

  const b = body || {};
  // No caller-controlled transport fields, ever.
  if ("url" in b || "headers" in b || "tools" in b ||
      ("model" in b && b.model !== undefined)) {
    return deny("REQUEST_INVALID");
  }

  if (def.id === "ollama") {
    // Fixed loopback probe; no spend, no credential.
    return { accepted: true, networkCalls: 1, origin: def.origin, model: null, toolsSent: false, fixedInput: true };
  }

  // Moonshot: a minimal inference probe may cost money -> explicit spend gate.
  if (!b.confirmSpend) return deny("SPEND_CONFIRMATION_REQUIRED");
  return {
    accepted: true,
    networkCalls: 1,
    origin: def.origin,
    model: def.allowedModels[0],
    toolsSent: false,
    fixedInput: true,
  };
}

module.exports = {
  PROVIDERS,
  KNOWN_AGENTS,
  buildProviderObservation,
  buildAgentProfiles,
  planConnectionTest,
  probeMoonshot,
  ok,
  warn,
  fail,
};
