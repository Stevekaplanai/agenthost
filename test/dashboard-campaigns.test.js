import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const root = process.cwd()
const dashboardRoot = path.join(root, "dashboard")
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8")
const dashboardRequire = createRequire(path.join(dashboardRoot, "package.json"))
const typescript = dashboardRequire("typescript")
const CONNECTION_ID = "mc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const SECOND_CONNECTION_ID = "mc_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

function loadCampaigns(api = {}) {
  const source = read("dashboard", "components", "agenthost", "campaigns.tsx")
  const javascript = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
      jsx: typescript.JsxEmit.ReactJSX,
    },
  }).outputText
  const hookState = []
  const effects = []
  let hookCursor = 0
  const node = (type, props = {}) => ({ type, props })
  const Fragment = Symbol("Fragment")
  const jsx = (type, props = {}) => {
    if (type === Fragment) return props.children ?? null
    if (typeof type === "function") return type(props)
    return node(type, props)
  }
  const ReactRuntime = {
    useCallback(callback) { return callback },
    useEffect(effect) { effects.push(effect) },
    useRef(initial) {
      const index = hookCursor++
      if (!(index in hookState)) hookState[index] = { current: initial }
      return hookState[index]
    },
    useState(initial) {
      const index = hookCursor++
      if (!(index in hookState)) hookState[index] = typeof initial === "function" ? initial() : initial
      return [hookState[index], (next) => {
        hookState[index] = typeof next === "function" ? next(hookState[index]) : next
      }]
    },
  }
  const passthrough = ({ children, ...props }) => node("span", { ...props, children })
  const button = ({ children, ...props }) => node("button", { ...props, children })
  const Panel = ({ title, actions, children }) => node("section", { children: [title, actions, children] })
  const Icon = () => node("svg")
  const loaded = { exports: {} }
  const runtime = {
    react: ReactRuntime,
    "react/jsx-runtime": { Fragment, jsx, jsxs: jsx },
    "lucide-react": new Proxy({}, { get: () => Icon }),
    "@/lib/api": {
      fetchGrowthAccounts: api.fetchGrowthAccounts ?? (async () => ({ configured: true, accounts: [] })),
      fetchMeasurementStatus: api.fetchMeasurementStatus ?? (async () => ({ connected: true, credentialHolder: "pipedream", disclosure: "" })),
      fetchMeasurementConnections: api.fetchMeasurementConnections ?? (async () => ({ connections: [] })),
      fetchMeasurementFacts: api.fetchMeasurementFacts ?? (async () => ({ facts: [] })),
    },
    "./primitives": { Btn: button, MonoLabel: passthrough, Panel },
  }
  new Function("module", "exports", "require", javascript)(
    loaded,
    loaded.exports,
    (id) => Object.hasOwn(runtime, id) ? runtime[id] : dashboardRequire(id),
  )
  return {
    aggregateCampaignFacts: loaded.exports.aggregateCampaignFacts,
    completedMeasurementRange: loaded.exports.completedMeasurementRange,
    selectCompletedCampaignFacts: loaded.exports.selectCompletedCampaignFacts,
    async mount(props) {
      hookCursor = 0
      loaded.exports.Campaigns(props)
      const effect = effects.shift()
      if (effect) effect()
      await new Promise((resolve) => setImmediate(resolve))
      hookCursor = 0
      return loaded.exports.Campaigns(props)
    },
  }
}

function textFrom(node) {
  if (node === null || node === undefined || typeof node === "boolean") return ""
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(textFrom).join(" ")
  return textFrom(node.props?.children)
}

function findNode(node, predicate) {
  if (node === null || node === undefined || typeof node !== "object") return null
  if (!Array.isArray(node) && predicate(node)) return node
  const children = Array.isArray(node) ? node : node.props?.children
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findNode(child, predicate)
    if (found) return found
  }
  return null
}

const fact = (overrides = {}) => ({
  id: "f1",
  accountId: "acme",
  provider: "meta_ads",
  sourceAccountId: "act_1",
  campaignId: "cmp_1",
  campaignName: "Launch",
  metric: "spend",
  value: 10,
  currency: "USD",
  sourceTimezone: "America/New_York",
  observedAt: "2026-08-10T00:00:00.000Z",
  capturedAt: "2026-08-11T01:00:00.000Z",
  ...overrides,
})

test("Campaigns empty state opens Attribution when no ad account is connected", async () => {
  let opened = 0
  const { mount } = loadCampaigns({
    fetchGrowthAccounts: async () => ({ configured: true, accounts: [{ account_id: "acme", name: "Acme", industry: null, created_at: "" }] }),
    fetchMeasurementStatus: async () => ({ connected: true, credentialHolder: "pipedream", disclosure: "" }),
    fetchMeasurementConnections: async () => ({ connections: [] }),
  })
  const tree = await mount({ onOpenAttribution: () => { opened += 1 } })
  const text = textFrom(tree)
  assert.match(text, /Campaigns need a connected ad account/)
  assert.match(text, /Attribution shows connection health and the facts stored on this box/)
  const button = findNode(tree, (candidate) => candidate.type === "button" && textFrom(candidate).trim() === "Open Attribution")
  assert.ok(button, "the dependency explanation must have a working Attribution control")
  button.props.onClick()
  assert.equal(opened, 1)
})

test("campaign facts group by client, provider, source account and campaign id", () => {
  const { aggregateCampaignFacts } = loadCampaigns()
  const rows = aggregateCampaignFacts([
    fact(),
    fact({ id: "f2", observedAt: "2026-08-09T00:00:00.000Z", value: 15 }),
    fact({ id: "f3", metric: "revenue", value: 100 }),
    fact({ id: "f4", metric: "revenue", observedAt: "2026-08-09T00:00:00.000Z", value: 50 }),
    fact({ id: "f5", campaignId: "cmp_2", campaignName: "Retargeting", value: 4 }),
    fact({ id: "legacy", campaignId: null, campaignName: null, value: 999 }),
  ], [{ account_id: "acme", name: "Acme", industry: null, created_at: "" }])

  assert.equal(rows.length, 2, "legacy account-level facts must not become an invented campaign row")
  const launch = rows.find((row) => row.campaignId === "cmp_1")
  assert.deepEqual({
    accountName: launch.accountName,
    spend: launch.spend,
    revenue: launch.revenue,
    roas: launch.roas,
  }, { accountName: "Acme", spend: 25, revenue: 150, roas: 6 })
})

test("a provider rename restates one campaign row instead of inventing a second campaign", () => {
  const { aggregateCampaignFacts } = loadCampaigns()
  const rows = aggregateCampaignFacts([
    fact({ campaignName: "Launch v1", observedAt: "2026-08-09T00:00:00.000Z" }),
    fact({ id: "f2", campaignName: "Launch final", observedAt: "2026-08-10T00:00:00.000Z", value: 15 }),
  ])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].campaignName, "Launch final")
  assert.equal(rows[0].spend, 25)
})

test("missing revenue stays not measured and never becomes zero ROAS", () => {
  const { aggregateCampaignFacts } = loadCampaigns()
  const [row] = aggregateCampaignFacts([fact({ value: 20 })])
  assert.equal(row.revenue, null)
  assert.equal(row.revenueCurrencyProblem, false)
  assert.equal(row.roas, null)
})

test("missing spend stays not measured and never becomes an invented zero", () => {
  const { aggregateCampaignFacts } = loadCampaigns()
  const [row] = aggregateCampaignFacts([fact({ metric: "revenue", value: 80 })])
  assert.equal(row.spend, null)
  assert.equal(row.spendCurrencyProblem, false)
  assert.equal(row.revenue, 80)
  assert.equal(row.roas, null)
})

test("ROAS is withheld when currencies do not match or spend is zero", () => {
  const { aggregateCampaignFacts } = loadCampaigns()
  const [mixed] = aggregateCampaignFacts([
    fact({ value: 20, currency: "USD" }),
    fact({ id: "r1", metric: "revenue", value: 50, currency: "EUR" }),
  ])
  const [zero] = aggregateCampaignFacts([
    fact({ campaignId: "cmp_2", campaignName: "Zero spend", value: 0 }),
    fact({ id: "r2", campaignId: "cmp_2", campaignName: "Zero spend", metric: "revenue", value: 50 }),
  ])
  assert.equal(mixed.roas, null)
  assert.equal(zero.roas, null)
})

test("mixed same-metric currencies never become a meaningless numeric total", () => {
  const { aggregateCampaignFacts } = loadCampaigns()
  const [row] = aggregateCampaignFacts([
    fact({ value: 10, currency: "USD" }),
    fact({ id: "f2", value: 20, currency: "EUR" }),
  ])
  assert.equal(row.spend, null)
  assert.equal(row.spendCurrency, null)
  assert.equal(row.spendCurrencyProblem, true)
  assert.equal(row.roas, null)
})

test("Campaigns does not blame an absent metric on currency", async () => {
  const completedUtcDay = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const { mount } = loadCampaigns({
    fetchGrowthAccounts: async () => ({ configured: true, accounts: [{ account_id: "acme", name: "Acme", industry: null, created_at: "" }] }),
    fetchMeasurementStatus: async () => ({ connected: true, credentialHolder: "pipedream", disclosure: "" }),
    fetchMeasurementConnections: async () => ({
      connections: [{ id: CONNECTION_ID, accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1", enabled: true, lastSyncedAt: null, lastError: null }],
    }),
    fetchMeasurementFacts: async () => ({
      facts: [fact({ sourceTimezone: "UTC", observedAt: `${completedUtcDay}T00:00:00.000Z` })],
    }),
  })

  const text = textFrom(await mount({ onOpenAttribution() {} }))
  assert.match(text, /Revenue Not measured/)
  assert.doesNotMatch(text, /currency missing or mixed/)
})

test("Campaigns names the failing read and renders its cause", async () => {
  const { mount } = loadCampaigns({
    fetchGrowthAccounts: async () => ({ configured: true, accounts: [] }),
    fetchMeasurementStatus: async () => { throw new Error("measurement store is locked") },
    fetchMeasurementConnections: async () => ({ connections: [] }),
  })
  const tree = await mount({ onOpenAttribution() {} })
  const text = textFrom(tree)
  assert.match(text, /Campaigns could not be read/)
  assert.match(text, /Measurement status could not be read: measurement store is locked/)
  assert.match(text, /Try again/)
})

test("Campaigns keeps measured facts visible when the optional client-name read fails", async () => {
  const completedUtcDay = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const { mount } = loadCampaigns({
    fetchGrowthAccounts: async () => { throw new Error("the Brain did not answer") },
    fetchMeasurementStatus: async () => ({ connected: true, credentialHolder: "pipedream", disclosure: "" }),
    fetchMeasurementConnections: async () => ({
      connections: [{ id: CONNECTION_ID, accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1", enabled: true, lastSyncedAt: null, lastError: null }],
    }),
    fetchMeasurementFacts: async () => ({
      facts: [fact({ sourceTimezone: "UTC", observedAt: `${completedUtcDay}T00:00:00.000Z` })],
    }),
  })

  const tree = await mount({ onOpenAttribution() {} })
  const text = textFrom(tree)
  assert.doesNotMatch(text, /Campaigns could not be read/)
  assert.match(text, /Launch/)
  assert.match(text, /acme/)
  assert.match(text, /Client names could not be read, so account IDs are shown instead/)
  assert.match(text, /Cause:\s+the Brain did not answer/)
  assert.ok(findNode(tree, (candidate) => candidate.props?.role === "alert"
    && /Client names could not be read/.test(textFrom(candidate))), "the fallback cause is announced to assistive technology")
})

test("Campaigns renders facts only for exact enabled account, provider, and source connections", async () => {
  const completedUtcDay = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const { mount } = loadCampaigns({
    fetchGrowthAccounts: async () => ({ configured: true, accounts: [{ account_id: "acme", name: "Acme", industry: null, created_at: "" }] }),
    fetchMeasurementStatus: async () => ({ connected: true, credentialHolder: "pipedream", disclosure: "" }),
    fetchMeasurementConnections: async () => ({ connections: [
      { id: CONNECTION_ID, accountId: "acme", provider: "meta_ads", sourceAccountId: "act_enabled", enabled: true, lastSyncedAt: null, lastError: null },
      { id: SECOND_CONNECTION_ID, accountId: "acme", provider: "meta_ads", sourceAccountId: "act_disabled", enabled: false, lastSyncedAt: null, lastError: null },
    ] }),
    fetchMeasurementFacts: async () => ({ facts: [
      fact({ id: "enabled", sourceAccountId: "act_enabled", campaignId: "cmp_enabled", campaignName: "Enabled campaign", sourceTimezone: "UTC", observedAt: `${completedUtcDay}T00:00:00.000Z` }),
      fact({ id: "disabled", sourceAccountId: "act_disabled", campaignId: "cmp_disabled", campaignName: "Disabled campaign", sourceTimezone: "UTC", observedAt: `${completedUtcDay}T00:00:00.000Z` }),
      fact({ id: "wrong-provider", provider: "google_ads", sourceAccountId: "act_enabled", campaignId: "cmp_wrong", campaignName: "Wrong provider", sourceTimezone: "UTC", observedAt: `${completedUtcDay}T00:00:00.000Z` }),
    ] }),
  })

  const text = textFrom(await mount({ onOpenAttribution() {} }))
  assert.match(text, /Enabled campaign/)
  assert.doesNotMatch(text, /Disabled campaign/)
  assert.doesNotMatch(text, /Wrong provider/)
})

test("Campaigns keeps retained facts visible and names an incomplete provider refresh", async () => {
  const completedUtcDay = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const incomplete = "sync incomplete: 2 provider rows skipped: 1 row had an invalid date_start; 1 row had a missing or invalid campaign_id"
  const { mount } = loadCampaigns({
    fetchGrowthAccounts: async () => ({ configured: true, accounts: [{ account_id: "acme", name: "Acme", industry: null, created_at: "" }] }),
    fetchMeasurementStatus: async () => ({ connected: true, credentialHolder: "pipedream", disclosure: "" }),
    fetchMeasurementConnections: async () => ({
      connections: [{ id: CONNECTION_ID, accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1", enabled: true, lastSyncedAt: null, lastError: incomplete }],
    }),
    fetchMeasurementFacts: async () => ({
      facts: [fact({ campaignName: "Retained campaign", sourceTimezone: "UTC", observedAt: `${completedUtcDay}T00:00:00.000Z` })],
    }),
  })

  const tree = await mount({ onOpenAttribution() {} })
  const text = textFrom(tree)
  assert.match(text, /Retained campaign/, "a partial refresh must not hide the last known good campaign")
  assert.match(text, /latest sync needs attention/)
  assert.match(text, /sync incomplete: 2 provider rows skipped/)
  assert.match(text, /invalid date_start/)
  assert.ok(findNode(tree, (candidate) => candidate.props?.role === "alert"
    && /sync incomplete/.test(textFrom(candidate))), "the degraded cause must be announced to assistive technology")
})

test("the broad fact request covers every timezone's possible seven completed local days", () => {
  const { completedMeasurementRange } = loadCampaigns()
  assert.deepEqual(
    completedMeasurementRange(Date.parse("2026-08-12T02:00:00.000Z")),
    { since: "2026-08-04", until: "2026-08-12" },
    "the read must include the extra boundary dates before per-fact timezone filtering",
  )
})

test("02:00 UTC still excludes New York's current local day and keeps its previous seven", () => {
  const { selectCompletedCampaignFacts } = loadCampaigns()
  const now = Date.parse("2026-08-12T02:00:00.000Z")
  const days = ["03", "04", "05", "06", "07", "08", "09", "10", "11", "12"]
  const selection = selectCompletedCampaignFacts(days.map((day) => fact({
    id: `f-${day}`,
    observedAt: `2026-08-${day}T00:00:00.000Z`,
  })), now)

  assert.deepEqual(
    selection.facts.map((item) => item.observedAt.slice(0, 10)),
    ["2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07", "2026-08-08", "2026-08-09", "2026-08-10"],
  )
  assert.deepEqual(selection.timezoneProblems, [])
})

test("completed-day filtering uses each fact's source timezone", () => {
  const { selectCompletedCampaignFacts } = loadCampaigns()
  const now = Date.parse("2026-08-12T02:00:00.000Z")
  const selection = selectCompletedCampaignFacts([
    fact({ id: "ny-oldest", observedAt: "2026-08-04T00:00:00.000Z" }),
    fact({ id: "ny-current", observedAt: "2026-08-11T00:00:00.000Z" }),
    fact({ id: "kiribati-oldest", sourceAccountId: "act_2", sourceTimezone: "Pacific/Kiritimati", observedAt: "2026-08-05T00:00:00.000Z" }),
    fact({ id: "kiribati-yesterday", sourceAccountId: "act_2", sourceTimezone: "Pacific/Kiritimati", observedAt: "2026-08-11T00:00:00.000Z" }),
  ], now)

  assert.deepEqual(selection.facts.map((item) => item.id), ["ny-oldest", "kiribati-oldest", "kiribati-yesterday"])
})

test("missing and invalid source timezones are excluded with a named cause", () => {
  const { selectCompletedCampaignFacts } = loadCampaigns()
  const selection = selectCompletedCampaignFacts([
    fact({ id: "missing", sourceAccountId: "act_missing", sourceTimezone: null }),
    fact({ id: "invalid", sourceAccountId: "act_invalid", sourceTimezone: "Mars/Olympus_Mons" }),
  ], Date.parse("2026-08-12T02:00:00.000Z"))

  assert.deepEqual(selection.facts, [])
  assert.deepEqual(selection.timezoneProblems, [
    "acme / meta ads / act_missing did not report a source timezone",
    'acme / meta ads / act_invalid reported an invalid source timezone "Mars/Olympus_Mons"',
  ])
})

test("Campaigns explains why returned facts with unusable timezones are not shown", async () => {
  const { mount } = loadCampaigns({
    fetchGrowthAccounts: async () => ({ configured: true, accounts: [{ account_id: "acme", name: "Acme", industry: null, created_at: "" }] }),
    fetchMeasurementStatus: async () => ({ connected: true, credentialHolder: "pipedream", disclosure: "" }),
    fetchMeasurementConnections: async () => ({ connections: [{ id: CONNECTION_ID, accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1", enabled: true, lastSyncedAt: null, lastError: null }] }),
    fetchMeasurementFacts: async () => ({ facts: [fact({ sourceTimezone: null })] }),
  })
  const tree = await mount({ onOpenAttribution() {} })
  const text = textFrom(tree)
  assert.match(text, /could not be placed inside the last 7 completed local days/)
  assert.match(text, /Cause: acme \/ meta ads \/ act_1 did not report a source timezone/)
})

test("fact requests use the broad timezone-safe range", async () => {
  const ranges = []
  const { mount, completedMeasurementRange } = loadCampaigns({
    fetchGrowthAccounts: async () => ({ configured: true, accounts: [{ account_id: "acme", name: "Acme", industry: null, created_at: "" }] }),
    fetchMeasurementStatus: async () => ({ connected: true, credentialHolder: "pipedream", disclosure: "" }),
    fetchMeasurementConnections: async () => ({ connections: [{ id: CONNECTION_ID, accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1", enabled: true, lastSyncedAt: null, lastError: null }] }),
    fetchMeasurementFacts: async (_accountId, range) => { ranges.push(range); return { facts: [] } },
  })
  await mount({ onOpenAttribution() {} })
  assert.deepEqual(ranges, [completedMeasurementRange()])
})

test("the typed measurement client calls the encoded account facts route", async () => {
  const apiSource = read("dashboard", "lib", "api.ts")
  const javascript = typescript.transpileModule(apiSource, {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 },
  }).outputText
  const loaded = { exports: {} }
  const calls = []
  new Function("module", "exports", "require", "process", "fetch", javascript)(
    loaded,
    loaded.exports,
    dashboardRequire,
    process,
    async (url, init = {}) => {
      calls.push({ url, init })
      return { ok: true, status: 200, text: async () => JSON.stringify({ facts: [] }) }
    },
  )
  await loaded.exports.fetchMeasurementFacts("client / one", { since: "2026-08-04", until: "2026-08-10" })
  assert.equal(calls[0].url, "/measurement/accounts/client%20%2F%20one/facts?since=2026-08-04&until=2026-08-10")
  assert.equal(calls[0].init.credentials, "include")
})
