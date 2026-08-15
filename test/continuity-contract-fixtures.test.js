import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_FILE = path.join(HERE, "fixtures", "continuity-contract-v1.json");
const fixture = JSON.parse(fs.readFileSync(FIXTURE_FILE, "utf8"));

function allCases() {
  return [
    ...fixture.settings.migrationCases,
    ...fixture.settings.writeCases,
    ...fixture.providerObservationCases,
    ...fixture.profileCases,
    ...fixture.connectionTestCases,
    ...fixture.envelopeCases,
  ];
}

test("Continuity contract fixture has one versioned, collision-free case catalog", () => {
  assert.equal(fixture.$schema, "agenthost-continuity-contract-fixtures-v1");
  assert.equal(fixture.contractVersion, 1);
  assert.equal(fixture.settingsSchemaVersion, 4);

  const ids = allCases().map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length, "case IDs must be globally unique");
  assert.ok(ids.length >= 30, "the opening contract needs a meaningful attack corpus");
});

test("provider registry is finite and Moonshot's dangerous fields are code-owned", () => {
  const providerIds = fixture.providerDefinitions.map((provider) => provider.id);
  assert.deepEqual(providerIds, ["anthropic", "openai", "google", "ollama", "moonshot"]);

  const moonshot = fixture.providerDefinitions.find((provider) => provider.id === "moonshot");
  assert.equal(moonshot.origin, "https://api.moonshot.ai/v1");
  assert.equal(moonshot.credentialRef, "KIMI_API_KEY");
  assert.deepEqual(moonshot.allowedModels, ["kimi-k3"]);
  assert.equal(moonshot.allowsTools, false);
  assert.equal(moonshot.allowsCustomHeaders, false);
  assert.equal(moonshot.allowsCustomUrl, false);

  assert.deepEqual(fixture.settings.writablePaths, [
    "providers.moonshot.enabled",
    "providers.moonshot.modelId",
  ]);
  for (const forbidden of ["origin", "url", "endpoint", "credentialRef", "apiKey", "headers", "tools"])
    assert.equal(fixture.settings.writablePaths.some((item) => item.includes(forbidden)), false);
});

test("migration corpus covers every accepted settings generation and fail-open input", () => {
  const ids = new Set(fixture.settings.migrationCases.map((item) => item.id));
  for (const required of [
    "missing-file",
    "stored-v1",
    "stored-v2",
    "stored-v3",
    "stored-v4-partial",
    "stored-v4-complete",
    "corrupt-json",
    "non-object-json",
    "forward-unknown-stored-key",
  ]) assert.ok(ids.has(required), `missing migration case ${required}`);

  for (const item of fixture.settings.migrationCases) {
    assert.deepEqual(item.expectedProviderSettings.moonshot, {
      enabled: item.id.startsWith("stored-v4") ? true : false,
      modelId: "kimi-k3",
    });
  }
});

test("settings writes reject secret, endpoint, provider, model, header, and tool injection", () => {
  const rejected = fixture.settings.writeCases.filter((item) => !item.accepted);
  const rejectedIds = new Set(rejected.map((item) => item.id));
  for (const required of [
    "reject-non-boolean-enabled",
    "reject-unapproved-model",
    "reject-custom-url",
    "reject-custom-header",
    "reject-arbitrary-credential-ref",
    "reject-tool-schema",
    "reject-unknown-provider",
    "reject-secret-value",
  ]) assert.ok(rejectedIds.has(required), `missing write attack ${required}`);

  for (const item of rejected) assert.ok(item.errorContains, `${item.id} needs a deterministic error`);
});

test("provider observations cover every truthful state without collapsing unknown into ready", () => {
  const states = new Set(fixture.providerObservationCases.map((item) => item.expected.state));
  assert.deepEqual(states, new Set([
    "disabled",
    "missing_credential",
    "unchecked",
    "ready",
    "unreachable",
    "model_unavailable",
    "unknown",
  ]));

  for (const item of fixture.providerObservationCases) {
    if (item.expected.state !== "ready") assert.ok(item.expected.reasonCode);
  }
});

test("Kimi's opening profile grants nothing and fixed-provider agents get no selector", () => {
  const kimi = fixture.profileCases.find((item) => item.id === "kimi-default-unavailable").expected;
  assert.equal(kimi.runtimeState, "unavailable");
  assert.equal(kimi.workspaceIsolation, "unproven");
  assert.equal(kimi.chatState, "unavailable");
  assert.equal(kimi.terminalState, "unavailable");
  assert.equal(kimi.unattendedState, "unavailable");
  assert.equal(kimi.reviewState, "unavailable");
  assert.equal(kimi.gitMaxRung, 0);
  assert.equal(kimi.fallback, null);

  const claude = fixture.profileCases.find((item) => item.id === "claude-provider-fixed");
  assert.equal(claude.expected.providerSelectable, false);
});

test("connection-test action is narrow and every rejected request makes zero network calls", () => {
  const rejected = fixture.connectionTestCases.filter((item) => !item.expected.accepted);
  for (const item of rejected) {
    assert.ok(item.expected.errorCode, `${item.id} needs a stable error code`);
    assert.equal(item.expected.networkCalls, 0, `${item.id} must stop before network`);
  }

  const moonshot = fixture.connectionTestCases.find((item) => item.id === "accept-bounded-moonshot-test");
  assert.deepEqual(moonshot.request, { confirmSpend: true });
  assert.equal(moonshot.expected.networkCalls, 1);
  assert.equal(moonshot.expected.fixedOrigin, "https://api.moonshot.ai/v1");
  assert.equal(moonshot.expected.fixedModel, "kimi-k3");
  assert.equal(moonshot.expected.fixedInput, true);
  assert.equal(moonshot.expected.toolsSent, false);
});

test("every response envelope is deterministic and errors explain retry plus stop", () => {
  for (const item of fixture.envelopeCases) {
    const envelope = item.expected;
    assert.ok(["success", "warning", "error"].includes(envelope.status));
    assert.equal(typeof envelope.summary, "string");
    assert.ok(Array.isArray(envelope.next_actions));
    assert.ok(Array.isArray(envelope.artifacts));
    if (envelope.status === "error") {
      assert.equal(typeof envelope.error.code, "string");
      assert.equal(typeof envelope.error.retry, "string");
      assert.equal(typeof envelope.error.stopCondition, "string");
    }
  }
});

test("seeded credential never appears in expected output, errors, or artifacts", () => {
  const secret = fixture.seededSecret;
  const expectedOnly = {
    migrations: fixture.settings.migrationCases.map((item) => ({
      expectedProviderSettings: item.expectedProviderSettings,
      expectedPreserved: item.expectedPreserved,
    })),
    writes: fixture.settings.writeCases.map((item) => ({
      accepted: item.accepted,
      paths: item.paths,
      errorContains: item.errorContains,
    })),
    providerObservations: fixture.providerObservationCases.map((item) => item.expected),
    profiles: fixture.profileCases.map((item) => item.expected),
    connectionTests: fixture.connectionTestCases.map((item) => item.expected),
    envelopes: fixture.envelopeCases.map((item) => item.expected),
  };
  assert.equal(JSON.stringify(expectedOnly).includes(secret), false);
});
