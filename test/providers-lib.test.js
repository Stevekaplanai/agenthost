// providers-lib.test.js -- CONT-01 dormant provider registry.
// Contract: docs/continuity/CONTRACT.md (CONT-00, v1). These tests freeze the
// shapes the contract promises BEFORE the module exists, then the module makes
// them pass. Pure logic only: no network, no gate, no live credential.

import { test } from "node:test";
import assert from "node:assert/strict";
import providers from "../container/providers-lib.js";

const {
  PROVIDERS,
  buildProviderObservation,
  buildAgentProfiles,
  planConnectionTest,
  ok,
  fail,
} = providers;

// ---- registry is finite and code-owned --------------------------------------

test("registry contains exactly the six contract provider IDs in order", () => {
  assert.deepEqual(
    PROVIDERS.map((p) => p.id),
    ["anthropic", "openai", "google", "ollama", "moonshot", "deepseek"],
  );
});

test("Moonshot's dangerous fields are code-owned and locked down", () => {
  const m = PROVIDERS.find((p) => p.id === "moonshot");
  assert.equal(m.adapter, "moonshot-chat");
  assert.equal(m.origin, "https://api.moonshot.ai/v1");
  assert.equal(m.credentialRef, "KIMI_API_KEY");
  assert.deepEqual(m.allowedModels, ["kimi-k3"]);
  assert.equal(m.allowsTools, false);
  assert.equal(m.allowsCustomHeaders, false);
  assert.equal(m.allowsCustomUrl, false);
});

test("DeepSeek is fixed to its official API and V4 Flash model without exposing a credential", () => {
  const d = PROVIDERS.find((p) => p.id === "deepseek");
  assert.ok(d, "DeepSeek provider must exist");
  assert.equal(d.routeOwnership, "agenthost-managed");
  assert.equal(d.operatorSelectable, false);
  assert.equal(d.testable, false);
  assert.equal(d.adapter, "deepseek-chat");
  assert.equal(d.endpointPolicy, "fixed-deepseek-api");
  assert.equal(d.origin, "https://api.deepseek.com/v1");
  assert.equal(d.credentialRef, "DEEPSEEK_API_KEY");
  assert.deepEqual(d.allowedModels, ["deepseek-v4-flash"]);
  assert.equal(d.allowsTools, false);
  assert.equal(d.allowsCustomHeaders, false);
  assert.equal(d.allowsCustomUrl, false);
  assert.equal("credential" in d, false);
  assert.equal("apiKey" in d, false);
});

test("runtime-fixed providers are not operator-selectable", () => {
  for (const id of ["anthropic", "openai", "google"]) {
    const p = PROVIDERS.find((x) => x.id === id);
    assert.equal(p.operatorSelectable, false, `${id} must not be selectable`);
    assert.equal(p.routeOwnership, "runtime-fixed");
  }
});

// ---- provider observation: never collapses unknown into ready ---------------

test("disabled Moonshot with no credential reports disabled, not ready", () => {
  const obs = buildProviderObservation("moonshot", {
    enabled: false,
    modelId: "kimi-k3",
    credentialPresent: false,
  });
  assert.equal(obs.type, "provider_observation");
  assert.equal(obs.id, "moonshot");
  assert.equal(obs.data.enabled, false);
  assert.equal(obs.data.configured, true);
  assert.equal(obs.data.credentialReady, false);
  assert.equal(obs.data.reachable, null); // never measured => null, not false
  assert.equal(obs.data.modelReady, null);
  assert.equal(obs.data.state, "disabled");
  assert.equal(obs.data.reasonCode, "PROVIDER_DISABLED");
  assert.equal(obs.data.stale, true);
});

test("enabled Moonshot missing its credential reports missing_credential", () => {
  const obs = buildProviderObservation("moonshot", {
    enabled: true,
    modelId: "kimi-k3",
    credentialPresent: false,
  });
  assert.equal(obs.data.credentialReady, false);
  assert.equal(obs.data.state, "missing_credential");
  assert.equal(obs.data.reasonCode, "PROVIDER_CREDENTIAL_MISSING");
});

test("enabled Moonshot with credential but no probe is unchecked, not ready", () => {
  const obs = buildProviderObservation("moonshot", {
    enabled: true,
    modelId: "kimi-k3",
    credentialPresent: true,
  });
  assert.equal(obs.data.credentialReady, true);
  assert.equal(obs.data.reachable, null);
  assert.equal(obs.data.state, "unchecked");
  assert.equal(obs.data.reasonCode, "PROVIDER_UNCHECKED");
});

test("observation never leaks the credential value -- only a boolean presence", () => {
  const obs = buildProviderObservation("moonshot", {
    enabled: true,
    modelId: "kimi-k3",
    credentialPresent: true,
    credentialValue: "sk-should-never-appear",
  });
  assert.equal(JSON.stringify(obs).includes("sk-should-never-appear"), false);
  assert.equal("credentialValue" in obs.data, false);
});

test("unknown provider id fails closed", () => {
  const obs = buildProviderObservation("totally-made-up", { enabled: true });
  assert.equal(obs.data.state, "unknown");
  assert.equal(obs.data.reasonCode, "ACTION_UNSUPPORTED");
});

// ---- agent profiles: Kimi grants nothing ------------------------------------

test("Kimi's opening profile is unavailable across every capability", () => {
  const profiles = buildAgentProfiles({});
  const kimi = profiles.find((p) => p.id === "kimi");
  assert.ok(kimi, "kimi profile must exist");
  assert.equal(kimi.data.runtime.state, "unavailable");
  assert.equal(kimi.data.workspace.isolation, "unproven");
  assert.equal(kimi.data.capabilities.chat.state, "unavailable");
  assert.equal(kimi.data.capabilities.terminal.state, "unavailable");
  assert.equal(kimi.data.capabilities.unattended.state, "unavailable");
  assert.equal(kimi.data.capabilities.review.state, "unavailable");
  assert.equal(kimi.data.capabilities.gitMaxRung.value, 0);
  assert.equal(kimi.data.providerRoute.fallback, null);
  assert.equal(kimi.data.voiceId, null);
});

test("all six known agents get a profile, fixed-provider agents are not selectable", () => {
  const profiles = buildAgentProfiles({});
  assert.deepEqual(
    profiles.map((p) => p.id),
    ["claude", "codex", "gemini", "hermes", "kimi", "deepseek"],
  );
  const claude = profiles.find((p) => p.id === "claude");
  assert.equal(claude.data.providerRoute.source, "runtime-fixed");
});

test("DeepSeek profile names its real harness, fixed route, private workspace, and Git ceiling", () => {
  const deepseek = buildAgentProfiles({}).find((p) => p.id === "deepseek");
  assert.ok(deepseek, "DeepSeek profile must exist");
  assert.equal(deepseek.data.displayName, "DeepSeek");
  assert.equal(deepseek.data.runtime.id, "dsh");
  assert.equal(deepseek.data.runtime.state, "unknown");
  assert.equal(deepseek.data.providerRoute.source, "agenthost-configured");
  assert.deepEqual(deepseek.data.providerRoute.primary, {
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
  });
  assert.equal(deepseek.data.providerRoute.fallback, null);
  assert.equal(deepseek.data.providerRoute.fallbackProvider, null);
  assert.equal(deepseek.data.workspace.path, "~/workspaces/deepseek");
  assert.equal(deepseek.data.workspace.state, "unknown");
  assert.deepEqual(deepseek.data.capabilities.gitMaxRung, { state: "available", value: 1 });
  assert.equal(deepseek.data.status, "unknown");
});

// ---- connection-test planning: narrow, spend-gated, rejects fail closed -----

test("Moonshot test without confirmSpend is rejected before any network call", () => {
  const plan = planConnectionTest("moonshot", { confirmSpend: false });
  assert.equal(plan.accepted, false);
  assert.equal(plan.networkCalls, 0);
  assert.equal(plan.errorCode, "SPEND_CONFIRMATION_REQUIRED");
});

test("Moonshot test with confirmSpend is bounded to fixed origin/model/no-tools", () => {
  const plan = planConnectionTest("moonshot", { confirmSpend: true });
  assert.equal(plan.accepted, true);
  assert.equal(plan.networkCalls, 1);
  assert.equal(plan.origin, "https://api.moonshot.ai/v1");
  assert.equal(plan.model, "kimi-k3");
  assert.equal(plan.toolsSent, false);
});

test("connection test rejects any caller-supplied url/header/model/tool", () => {
  const plan = planConnectionTest("moonshot", {
    confirmSpend: true,
    url: "https://evil.example",
    headers: { Authorization: "Bearer leak" },
    model: "gpt-4",
    tools: [{ name: "shell" }],
  });
  assert.equal(plan.accepted, false);
  assert.equal(plan.networkCalls, 0);
  assert.equal(plan.errorCode, "REQUEST_INVALID");
});

test("connection test on a non-testable runtime-fixed provider is unsupported", () => {
  const plan = planConnectionTest("anthropic", { confirmSpend: true });
  assert.equal(plan.accepted, false);
  assert.equal(plan.networkCalls, 0);
  assert.equal(plan.errorCode, "ACTION_UNSUPPORTED");
});

test("DeepSeek cannot be probed through the generic connection-test route", () => {
  const plan = planConnectionTest("deepseek", { confirmSpend: true });
  assert.equal(plan.accepted, false);
  assert.equal(plan.networkCalls, 0);
  assert.equal(plan.errorCode, "ACTION_UNSUPPORTED");
});

// ---- deterministic envelope helpers -----------------------------------------

test("ok() builds a success envelope with stable arrays", () => {
  const env = ok("One provider is ready.", { artifacts: [{ type: "x" }] });
  assert.equal(env.status, "success");
  assert.equal(env.summary, "One provider is ready.");
  assert.ok(Array.isArray(env.next_actions));
  assert.ok(Array.isArray(env.artifacts));
});

test("fail() builds an error envelope carrying code, retry, and stopCondition", () => {
  const env = fail("PROVIDER_CREDENTIAL_MISSING", "Add the KIMI_API_KEY box secret, then test Moonshot again.", "Do not retry until the secret-presence check is true.");
  assert.equal(env.status, "error");
  assert.equal(env.error.code, "PROVIDER_CREDENTIAL_MISSING");
  assert.equal(typeof env.error.retry, "string");
  assert.equal(typeof env.error.stopCondition, "string");
});
