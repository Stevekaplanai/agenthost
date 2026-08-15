import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const root = process.cwd()
const dashboardRequire = createRequire(path.join(root, "dashboard", "package.json"))
const typescript = dashboardRequire("typescript")
const source = fs.readFileSync(path.join(root, "dashboard", "lib", "api.ts"), "utf8")
const javascript = typescript.transpileModule(source, {
  compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 },
}).outputText
const CONTENT_VERSION = "a".repeat(64)

function loadApi(payload) {
  const loaded = { exports: {} }
  new Function("module", "exports", "require", "process", "fetch", javascript)(
    loaded,
    loaded.exports,
    dashboardRequire,
    process,
    async () => ({ ok: true, status: 200, text: async () => JSON.stringify(payload) }),
  )
  return loaded.exports
}

test("measurement facts reject a malformed HTTP 200 instead of crashing Campaigns later", async () => {
  await assert.rejects(
    loadApi({}).fetchMeasurementFacts("client"),
    /invalid facts list/,
  )
  await assert.rejects(
    loadApi({ facts: [{ id: "partial" }] }).fetchMeasurementFacts("client"),
    /invalid facts list/,
  )
})

test("measurement facts reject malformed identities and timestamps before Campaigns can under-report them", async () => {
  const fact = {
    id: "fact-1",
    accountId: "acme",
    provider: "meta_ads",
    sourceAccountId: "act_1",
    campaignId: "cmp_1",
    campaignName: "Launch",
    metric: "spend",
    value: 25,
    currency: "USD",
    sourceTimezone: "America/New_York",
    observedAt: "2026-08-11T00:00:00.000Z",
    capturedAt: "2026-08-12T01:00:00.000Z",
  }
  const malformed = [
    { ...fact, id: "" },
    { ...fact, accountId: "   " },
    { ...fact, provider: "" },
    { ...fact, sourceAccountId: "" },
    { ...fact, campaignId: "" },
    { ...fact, campaignName: "" },
    { ...fact, campaignName: null },
    { ...fact, currency: "" },
    { ...fact, sourceTimezone: "" },
    { ...fact, observedAt: "2026-02-30T00:00:00.000Z" },
    { ...fact, observedAt: "2026-08-11T01:00:00.000Z" },
    { ...fact, observedAt: "2026-08-11T00:00:00Z" },
    { ...fact, capturedAt: "2026-02-30T01:00:00.000Z" },
    { ...fact, capturedAt: "2026-08-12T01:00:00Z" },
  ]

  for (const row of malformed) {
    await assert.rejects(
      loadApi({ facts: [row] }).fetchMeasurementFacts("acme"),
      /invalid facts list/,
      `the malformed row must be rejected: ${JSON.stringify(row)}`,
    )
  }
})

test("legacy facts may omit campaign identity only as a complete null pair", async () => {
  const legacy = {
    id: "legacy-1",
    accountId: "acme",
    provider: "meta_ads",
    sourceAccountId: null,
    campaignId: null,
    campaignName: null,
    metric: "spend",
    value: 25,
    currency: null,
    sourceTimezone: null,
    observedAt: "2026-08-11T00:00:00.000Z",
    capturedAt: "2026-08-12T01:00:00.000Z",
  }
  assert.deepEqual(await loadApi({ facts: [legacy] }).fetchMeasurementFacts("acme"), { facts: [legacy] })
})

test("measurement facts refuse a well-shaped row belonging to a different client", async () => {
  const fact = {
    id: "fact-1",
    accountId: "other-client",
    provider: "meta_ads",
    sourceAccountId: "act_1",
    campaignId: "cmp_1",
    campaignName: "Launch",
    metric: "spend",
    value: 25,
    currency: "USD",
    sourceTimezone: "America/New_York",
    observedAt: "2026-08-11T00:00:00.000Z",
    capturedAt: "2026-08-12T01:00:00.000Z",
  }
  await assert.rejects(
    loadApi({ facts: [fact] }).fetchMeasurementFacts("acme"),
    /fact for a different account/,
    "a malformed 200 must not mix another client's metrics into the requested Campaign view",
  )
})

test("measurement facts accept the complete names-and-values contract", async () => {
  const fact = {
    id: "fact-1",
    accountId: "acme",
    provider: "meta_ads",
    sourceAccountId: "act_1",
    campaignId: "cmp_1",
    campaignName: "Launch",
    metric: "spend",
    value: 25,
    currency: "USD",
    sourceTimezone: "America/New_York",
    observedAt: "2026-08-11T00:00:00.000Z",
    capturedAt: "2026-08-12T01:00:00.000Z",
  }
  assert.deepEqual(await loadApi({ facts: [{ ...fact, unexpected: "drop" }] }).fetchMeasurementFacts("acme"), { facts: [fact] })
})

test("measurement status requires a Boolean state, registered providers, and a cause when disconnected", async () => {
  await assert.rejects(loadApi({ connected: "yes", credentialHolder: "pipedream", providers: ["meta_ads"], disclosure: "" }).fetchMeasurementStatus(), /invalid status contract/)
  await assert.rejects(loadApi({ connected: false, credentialHolder: "pipedream", providers: [], disclosure: "" }).fetchMeasurementStatus(), /invalid status contract/)
  await assert.rejects(loadApi({ connected: true, credentialHolder: "pipedream", providers: ["meta_ads", "meta_ads"], disclosure: "" }).fetchMeasurementStatus(), /invalid status contract/)
  assert.deepEqual(
    await loadApi({ connected: false, credentialHolder: "pipedream", providers: ["meta_ads"], disclosure: "safe", why: "credentials missing", extra: "drop" }).fetchMeasurementStatus(),
    { connected: false, credentialHolder: "pipedream", providers: ["meta_ads"], disclosure: "safe", why: "credentials missing" },
  )
})

test("secret status rejects malformed HTTP 200 bodies before they reach render state", async () => {
  await assert.rejects(loadApi({}).fetchBoxSecretStatus(), /invalid names-only contract/)
  await assert.rejects(
    loadApi({ ok: true, secrets: [{ name: "PIPEDREAM_CLIENT_SECRET", present: "yes" }] }).fetchBoxSecretStatus(),
    /invalid names-only contract/,
  )
})

test("secret status accepts names and Boolean presence without any values", async () => {
  const body = { ok: true, secrets: [{ name: "PIPEDREAM_CLIENT_SECRET", present: true, value: "must-not-enter-state" }] }
  assert.deepEqual(await loadApi(body).fetchBoxSecretStatus(), {
    ok: true,
    secrets: [{ name: "PIPEDREAM_CLIENT_SECRET", present: true }],
  })
})

test("secret storage requires the gate to echo the exact name and updated Boolean", async () => {
  await assert.rejects(
    loadApi({ ok: true, name: "A_DIFFERENT_TOKEN", updated: false }).storeBoxSecret("EXPECTED_TOKEN", "value"),
    /did not confirm storing EXPECTED_TOKEN/,
  )
  await assert.rejects(
    loadApi({ ok: true, name: "EXPECTED_TOKEN", updated: "false" }).storeBoxSecret("EXPECTED_TOKEN", "value"),
    /did not confirm storing EXPECTED_TOKEN/,
  )
})

test("secret storage refuses the gate-only push token and stored control bytes before fetch", async () => {
  await assert.rejects(loadApi({}).storeBoxSecret("GIT_PUSH_TOKEN", "value"), /gate-only/)
  await assert.rejects(loadApi({}).storeBoxSecret("SAFE_TOKEN", "value\u0000tail"), /control character/)
})

test("Creative artifacts reject malformed HTTP 200 rows before render", async () => {
  await assert.rejects(loadApi({ files: [null] }).fetchCreativeArtifacts(), /invalid artifact row/)
  await assert.rejects(
    loadApi({ files: [{ name: "x.html", title: "X", kind: "html", category: "creative", review: null, reviewStale: false, reviewError: null, contentVersion: CONTENT_VERSION, size: "3", mtime: 1 }] }).fetchCreativeArtifacts(),
    /invalid artifact row/,
  )
  await assert.rejects(
    loadApi({ files: [{ name: "x.html", title: "X", kind: "html", category: "creative", review: null, reviewStale: false, reviewError: null, contentVersion: CONTENT_VERSION, size: 3, mtime: Number.MAX_VALUE }] }).fetchCreativeArtifacts(),
    /invalid artifact row/,
  )
  await assert.rejects(
    loadApi({ files: [{ name: "x.html", title: "X", kind: "html", category: "creative", review: null, reviewStale: false, reviewError: null, contentVersion: "A".repeat(64), size: 3, mtime: 1 }] }).fetchCreativeArtifacts(),
    /invalid artifact row/,
  )
  await assert.rejects(
    loadApi({ files: [{ name: "x.html", title: "X", kind: "html", category: "creative", review: null, reviewStale: false, reviewError: null, contentVersion: null, size: 3, mtime: 1 }] }).fetchCreativeArtifacts(),
    /invalid artifact row/,
  )
})

test("Creative keeps an unsafe-name row visible when the gate supplies its refusal cause", async () => {
  const unsafe = {
    name: "unsafe name.html", title: "Unsafe name", kind: "html", category: "creative",
    review: null, reviewStale: false, reviewError: "artifact name must be a safe ASCII .html or .md basename",
    contentVersion: null, size: 3, mtime: 1,
  }
  assert.deepEqual(await loadApi({ files: [unsafe] }).fetchCreativeArtifacts(), { files: [unsafe] })
  await assert.rejects(
    loadApi({ files: [{ ...unsafe, reviewError: null }] }).fetchCreativeArtifacts(),
    /invalid artifact row/,
  )
})

test("Creative artifact responses are rebuilt from the display-only contract", async () => {
  const result = await loadApi({ files: [{
    name: "x.html", title: "X", kind: "html", category: "creative", review: "approved", reviewStale: false, reviewError: null, contentVersion: CONTENT_VERSION, size: 3, mtime: 1,
    unexpected: "not retained",
  }] }).fetchCreativeArtifacts()
  assert.deepEqual(result, { files: [{
    name: "x.html", title: "X", kind: "html", category: "creative", review: "approved", reviewStale: false, reviewError: null, contentVersion: CONTENT_VERSION, size: 3, mtime: 1,
  }] })
})

test("Campaign dependencies reject malformed HTTP 200 lists before state is set", async () => {
  await assert.rejects(loadApi({ configured: true, accounts: null }).fetchGrowthAccounts(), /invalid accounts list/)
  await assert.rejects(loadApi({ configured: false }).fetchGrowthAccounts(), /invalid unconfigured cause/)
  await assert.rejects(loadApi({ connections: [null] }).fetchMeasurementConnections(), /invalid connections list/)
})

test("Campaign dependency responses are rebuilt from their display contracts", async () => {
  assert.deepEqual(
    await loadApi({
      configured: true,
      accounts: [{ account_id: "acme", name: "Acme", industry: null, created_at: "now", extra: "drop" }],
    }).fetchGrowthAccounts(),
    { configured: true, accounts: [{ account_id: "acme", name: "Acme", industry: null, created_at: "now" }] },
  )
  assert.deepEqual(
    await loadApi({
      connections: [{
        id: "mc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1",
        enabled: true, lastSyncedAt: null, lastError: null, extra: "drop",
      }],
    }).fetchMeasurementConnections(),
    { connections: [{
      id: "mc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1",
      enabled: true, lastSyncedAt: null, lastError: null,
    }] },
  )
})

test("the dashboard keeps measurement health clients but exports no Pipedream onboarding clients or types", () => {
  const api = loadApi({})
  assert.equal(api.createMeasurementConnectToken, undefined)
  assert.equal(api.fetchMeasurementAvailableConnections, undefined)
  assert.equal(api.putMeasurementConnection, undefined)
  assert.equal(typeof api.fetchMeasurementStatus, "function")
  assert.equal(typeof api.fetchMeasurementConnections, "function")
  assert.equal(typeof api.disconnectMeasurementConnection, "function")
  assert.equal(typeof api.previewMeasurementFactsForConnection, "function")
  assert.equal(typeof api.deleteMeasurementFactsForConnection, "function")
  assert.doesNotMatch(source, /MeasurementAvailableConnection|MeasurementConnectToken/)
})

test("Brand DNA from URL accepts only five confirmed stored assets with provenance", async () => {
  const provenance = {
    source_url: "https://example.com/",
    source_urls: ["https://example.com/", "https://example.com/about"],
    generated_at: "2026-08-12T12:00:00.000Z",
  }
  const assets = ["guidelines", "voice", "intel", "performance", "calls"]
  const records = assets.map((asset, index) => ({
    id: `dna-${index}`,
    asset,
    source: "generated",
    content: `${asset} evidence`,
    version: 1,
    updated_at: "2026-08-12T12:00:01.000Z",
    schemaVersion: 1,
    provenance,
  }))
  assert.deepEqual(
    await loadApi({ ok: true, written: 5, records, provenance, extra: "drop" }).buildGrowthDnaFromUrl("acme", "https://example.com"),
    { ok: true, written: 5, records, provenance },
  )
  await assert.rejects(
    loadApi({ ok: true, written: 4, records: records.slice(0, 4), provenance }).buildGrowthDnaFromUrl("acme", "https://example.com"),
    /did not confirm five stored assets/i,
  )
  await assert.rejects(
    loadApi({ ok: true, written: 5, records: records.map((row) => ({ ...row, asset: "voice" })), provenance }).buildGrowthDnaFromUrl("acme", "https://example.com"),
    /did not confirm five stored assets/i,
  )
  await assert.rejects(
    loadApi({ ok: true, written: 5, records, provenance: { ...provenance, generated_at: "not-a-date" } }).buildGrowthDnaFromUrl("acme", "https://example.com"),
    /source provenance/i,
  )
  await assert.rejects(
    loadApi({ ok: true, written: 5, records: records.map((row, index) => index === 0 ? { ...row, source: "client" } : row), provenance }).buildGrowthDnaFromUrl("acme", "https://example.com"),
    /five stored assets/i,
  )
  await assert.rejects(
    loadApi({ ok: true, written: 5, records, provenance: { ...provenance, source_url: "https://user:pass@example.com/" } }).buildGrowthDnaFromUrl("acme", "https://example.com"),
    /source provenance/i,
  )
})

test("measurement disconnect and fact deletion validate their exact confirmations", async () => {
  const id = "mc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  assert.deepEqual(
    await loadApi({
      ok: true,
      connection: {
        id, accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1",
        enabled: false, lastSyncedAt: null, lastError: null,
      },
      inFlightCancelled: true,
      disclosure: "This does not revoke OAuth access.",
    }).disconnectMeasurementConnection(id),
    {
      ok: true,
      connection: {
        id, accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1",
        enabled: false, lastSyncedAt: null, lastError: null,
      },
      inFlightCancelled: true,
      disclosure: "This does not revoke OAuth access.",
    },
  )
  assert.deepEqual(
    await loadApi({ connectionId: id, count: 7, enabled: false }).previewMeasurementFactsForConnection(id),
    { connectionId: id, count: 7, enabled: false },
  )
  assert.deepEqual(
    await loadApi({ ok: true, connectionId: id, deleted: 7 }).deleteMeasurementFactsForConnection(id),
    { ok: true, connectionId: id, deleted: 7 },
  )

  await assert.rejects(loadApi({ connectionId: id, count: -1, enabled: false }).previewMeasurementFactsForConnection(id), /invalid facts preview/)
  await assert.rejects(loadApi({ ok: true, connectionId: "other", deleted: 7 }).deleteMeasurementFactsForConnection(id), /different connection/)
  await assert.rejects(loadApi({ ok: true, connection: { id }, inFlightCancelled: false, disclosure: "" }).disconnectMeasurementConnection(id), /invalid disconnect confirmation/)
})
