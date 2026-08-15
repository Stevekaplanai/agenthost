import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (file) => fs.readFileSync(path.join(root, file), "utf8")
const dashboardRoot = path.join(root, "dashboard")
const dashboardRequire = createRequire(path.join(dashboardRoot, "package.json"))
const { publicConnection } = createRequire(import.meta.url)("../container/measurement-lib.js")

function deferred() {
  let resolve
  let reject
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

const canonicalBrandAssets = [
  { id: "guidelines", label: "Brand Guidelines", description: "Guidelines" },
  { id: "voice", label: "Brand Voice", description: "Voice" },
  { id: "intel", label: "Competitive Intelligence", description: "Intelligence" },
  { id: "performance", label: "Campaign Performance Stats", description: "Performance" },
  { id: "calls", label: "Call Recordings", description: "Calls" },
]

function loadAccountBootstrap(fetchGrowthDna = async () => ({ configured: true, records: [] })) {
  const source = read("dashboard/components/agenthost/accounts.tsx")
  const typescript = dashboardRequire("typescript")
  const javascript = typescript.transpileModule(`${source}\nexport { AccountBootstrap as __AccountBootstrap, AccountDrawer as __AccountDrawer, DnaAssetRow as __DnaAssetRow, BuildDnaFromUrlForm as __BuildDnaFromUrlForm, countRenderedDnaAssets as __countRenderedDnaAssets }`, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
      jsx: typescript.JsxEmit.ReactJSX,
    },
  }).outputText
  const hookState = []
  const callbacks = []
  let hookCursor = 0
  const node = (type, props = {}) => ({ type, props })
  const Fragment = Symbol("Fragment")
  const jsx = (type, props = {}) => {
    if (type === Fragment) return props.children ?? null
    if (typeof type === "function") return type(props)
    return node(type, props)
  }
  const ReactRuntime = {
    useCallback(callback) {
      callbacks.push(callback)
      return callback
    },
    useEffect() {},
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
  const Modal = ({ open, title, subtitle, children, footer, ...props }) => open
    ? node("dialog", { ...props, title, subtitle, children: [title, subtitle, children, footer] })
    : null
  const Icon = () => node("svg")
  const runtime = {
    react: ReactRuntime,
    "react/jsx-runtime": { Fragment, jsx, jsxs: jsx },
    "lucide-react": new Proxy({}, { get: () => Icon }),
    "@/lib/agenthost-growth": { BRAND_ASSETS: canonicalBrandAssets },
    "@/lib/api": {
      fetchGrowthDna,
      growthExportUrl: (id) => `/growth/accounts/${id}/export`,
    },
    "@/lib/utils": { cn: (...values) => values.filter(Boolean).join(" ") },
    "./primitives": { Btn: button, Modal, MonoLabel: passthrough },
    "./ai-assist": { AiAssist: passthrough },
    // The Brand DNA drawer mounts the shared Graphify panel so a client's
    // corpus can be graphed from the drawer that owns it. Stubbed here
    // because this suite is about the account and DNA journeys.
    "./graphify-panel": { GraphifyPanel: passthrough },
  }
  const loaded = { exports: {} }
  new Function("module", "exports", "require", javascript)(
    loaded,
    loaded.exports,
    (id) => Object.hasOwn(runtime, id) ? runtime[id] : dashboardRequire(id),
  )
  return {
    AccountBootstrap: loaded.exports.__AccountBootstrap,
    render(props) {
      hookCursor = 0
      return loaded.exports.__AccountBootstrap(props)
    },
    renderAccounts(props) {
      hookCursor = 0
      return loaded.exports.Accounts(props)
    },
    renderBuildDnaFromUrl(props) {
      hookCursor = 0
      return loaded.exports.__BuildDnaFromUrlForm(props)
    },
    renderAccountDrawer(props) {
      hookCursor = 0
      return loaded.exports.__AccountDrawer(props)
    },
    renderDnaAssetRow(props) {
      hookCursor = 0
      return loaded.exports.__DnaAssetRow(props)
    },
    countRenderedDnaAssets: loaded.exports.__countRenderedDnaAssets,
    takeCallbacks() {
      return callbacks.splice(0)
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

const buttonNamed = (tree, name) => findNode(tree, (candidate) => candidate.type === "button" && typeof candidate.props?.onClick === "function" && textFrom(candidate).trim() === name)
const fieldNamed = (tree, name) => findNode(tree, (candidate) => {
  const label = candidate.props?.["aria-label"]
  return ["input", "textarea", "select"].includes(candidate.type)
    && (label === name || (name === "Client account ID" && label === "Client account"))
})

test("Growth keeps Accounts, Campaigns, board-backed OKRs, Attribution, Creative and Autonomy live", () => {
  const source = read("dashboard/components/agenthost/growth-view.tsx")
  const objectives = read("dashboard/lib/board-objectives.ts")

  assert.match(source, /Brand DNA/)
  assert.match(source, /Goals & OKRs/)
  assert.match(source, /Autonomy/)
  assert.match(source, /buildLinkedObjectives/)
  assert.match(source, /onOpenTask\(task\)/)
  assert.match(source, /multiLoops\.jobs\?\.jobs/)
  assert.match(source, /job\.mode === "growth"/)
  assert.match(source, /Scheduled Growth workflows/)
  assert.doesNotMatch(source, /Independent work toward goals/,
    "saved workflows without an explicit goal link must not be claimed as goal autonomy")
  assert.match(source, /The whole team owns the result/)
  assert.doesNotMatch(source, /GROWTH_TASKS|OBJECTIVES|ACCOUNTS\b|Sample data/)
  // Attribution is now a real, service-backed tab (the Measurement pack), so it
  // is deliberately no longer in this "unbuilt surface" guard; the others stay
  // out because their services still do not exist.
  assert.doesNotMatch(source, /CreativeStudio|Calendar|IntelFeed/)
  // `CreativeStudio` above stays forbidden -- that was the UNBUILT placeholder.
  // The shipped tab is `Creative`, backed by a real route and a declared signal.
  // This guard bans surfaces with no service behind them, not words.
  assert.match(source, /tab === "creative"/)
  assert.match(source, /<Creative \/>/)
  assert.match(source, /tab === "campaigns"/)
  assert.match(source, /<Campaigns onOpenAttribution=/)
  assert.match(source, /Attribution/)
  assert.match(source, /tab === "attribution"/)
  assert.match(source, /<Measurement measurement=\{measurement\} \/>/,
    "Attribution receives the live measurement state without an onboarding-only account list")
  assert.doesNotMatch(source, /goalLabel|task\.title\.indexOf\("\:\"\)/,
    "an OKR must come from Hermes links, never a title prefix")
  assert.match(objectives, /parents/)
  assert.match(objectives, /children/)
  assert.match(source, /board\.relations/)
  assert.doesNotMatch(source, /fetchBoardTask/,
    "the OKR view must consume one bulk relation snapshot, not fetch every card separately")
})

test("linked board parents become objectives and their children become key results", async () => {
  const { pathToFileURL } = await import("node:url")
  const module = await import(pathToFileURL(path.join(root, "dashboard/lib/board-objectives.ts")).href)
  const task = (id, title, lane = "queued") => ({ id, title, lane })
  const board = {
    tasks: [
      task("o1", "Increase qualified pipeline"),
      task("kr1", "Ship landing page", "done"),
      task("kr2", "Launch paid test"),
      task("loose", "Unlinked operational card"),
    ],
  }
  const linked = module.buildLinkedObjectives(board.tasks, {
    o1: { parents: [], children: [{ id: "kr1" }, "kr2"] },
    kr1: { parents: ["o1"], children: [] },
    kr2: { parents: ["o1"], children: [] },
    loose: { parents: [], children: [] },
  })

  assert.equal(linked.length, 1)
  assert.equal(linked[0].objective.id, "o1")
  assert.deepEqual(linked[0].keyResults.map((item) => item.id), ["kr1", "kr2"])
})

test("Growth navigation exposes the live and board-derived destinations", () => {
  const source = read("dashboard/components/agenthost/navigation.ts")
  const growthBlock = source.match(/growth:\s*\[([\s\S]*?)\]\s*,\s*brain:/)?.[1] ?? ""

  assert.match(growthBlock, /label: "Accounts"[\s\S]*route: "growth\/brand-dna"/)
  assert.match(growthBlock, /Campaigns/)
  assert.match(growthBlock, /Goals & OKRs/)
  assert.match(growthBlock, /Autonomy/)
  // Attribution is a live, board-derived destination now (the Measurement pack).
  assert.match(growthBlock, /Attribution/)
  // Creative joined them 2026-08-12. It reads GET /artifacts and filters on the
  // `category` its AUTHOR declared (#387), so it is service-backed exactly like
  // Attribution. Asserted PRESENT, not merely un-forbidden: a guard that only
  // says "not absent" passes just as happily against a deleted tab.
  assert.match(growthBlock, /Creative/)
  assert.doesNotMatch(growthBlock, /Calendar|Intel\b/)
})

test("Growth Autonomy directly reuses the guarded Pause New and Resume action", () => {
  const growth = read("dashboard/components/agenthost/growth-view.tsx")
  const operator = read("dashboard/components/agenthost/operator.tsx")
  const command = read("dashboard/components/agenthost/command-center.tsx")
  const shared = operator.match(/export function (Autonomy[A-Za-z0-9_]*)\s*\(/)?.[1]

  assert.ok(shared, "export the existing guarded autonomy action once for Growth and Systems")
  assert.match(growth, new RegExp(`import\\s*\\{[^}]*\\b${shared}\\b[^}]*\\}\\s*from\\s*["']\\./operator["']`))
  assert.match(growth, new RegExp(`<${shared}\\b`),
    "Growth > Autonomy must show Pause New / Resume directly, not only link to Systems")
  assert.match(growth, /autonomyOn=\{autonomy\?\.on \?\? null\}/)
  assert.match(growth, /onAutonomyChanged=\{onAutonomyChanged\}/)
  assert.match(growth, /onAction=\{onAction\}/)

  const wiring = command.slice(command.indexOf("<GrowthView"), command.indexOf("<GrowthView") + 1800)
  assert.match(wiring, /onAutonomyChanged=\{refetchCc\}/)
  assert.match(wiring, /onAction=\{flash\}/)
  assert.match(operator, /label=\{autonomyOn === false \? "Resume" : "Pause New"\}/)
  assert.match(operator, /autonomyOn === false \? \(\) => setConfirmResume\(true\) : \(\) => changeAutonomy\(false\)/,
    "Resume remains consequence-gated while Pause New stays directly reversible")
})

test("the production Brand DNA view contains no sample portfolio or unreachable onboarding writer", () => {
  const source = read("dashboard/components/agenthost/accounts.tsx")
  const growth = read("dashboard/components/agenthost/growth-view.tsx")
  const command = read("dashboard/components/agenthost/command-center.tsx")

  assert.doesNotMatch(source, /Sample data|showSamples|allowOnboarding|AddBrandButton|BrandOnboarding|OnboardResult/)
  assert.doesNotMatch(growth, /onCreateBrand|allowOnboarding|showSamples|brand-onboarding/)
  assert.doesNotMatch(command, /createBrand|onCreateBrand|OnboardResult|BRAND_ASSETS|growthMember/)
  assert.equal(fs.existsSync(path.join(root, "dashboard/components/agenthost/brand-onboarding.tsx")), false)
})

test("zero accounts bootstrap a real account and Brand DNA journey only after consequence review", async () => {
  const source = read("dashboard/components/agenthost/accounts.tsx")
  const { render } = loadAccountBootstrap()
  const calls = []
  const created = []
  const closed = []
  let attempt = 0
  const props = {
    async createAccount(body) {
      calls.push(body)
      attempt += 1
      if (attempt === 1) return { account: null, error: "the brain rejected this exact account write" }
      return {
        account: { account_id: "acme", name: body.name, industry: body.industry || null, created_at: "2026-08-10T00:00:00Z" },
        error: null,
      }
    },
    onCreated(account) { created.push(account) },
    onClose() { closed.push(true) },
  }

  let tree = render(props)
  const name = fieldNamed(tree, "Client name")
  const industry = fieldNamed(tree, "Industry")
  assert.ok(name && industry, "the account bootstrap fields are not accessible by name")
  assert.match(name.props.className, /min-h-11/)
  assert.match(industry.props.className, /min-h-11/)
  name.props.onChange({ target: { value: "Acme" } })
  industry.props.onChange({ target: { value: "Technology" } })

  tree = render(props)
  buttonNamed(tree, "Review account").props.onClick()
  assert.deepEqual(calls, [], "reviewing the account sent the durable POST")
  tree = render(props)
  assert.match(textFrom(tree), /Before.*No client account named\s+Acme\s+exists in the Brain/i)
  assert.match(textFrom(tree), /After.*Acme\s+becomes a durable client account/i)
  assert.match(buttonNamed(tree, "Cancel").props.className, /min-h-11/)
  assert.match(buttonNamed(tree, "Confirm create").props.className, /min-h-11/)
  buttonNamed(tree, "Cancel").props.onClick()
  assert.deepEqual(calls, [], "Cancel sent the durable account POST")

  tree = render(props)
  buttonNamed(tree, "Review account").props.onClick()
  tree = render(props)
  buttonNamed(tree, "Confirm create").props.onClick()
  buttonNamed(tree, "Confirm create").props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(calls, [{ name: "Acme", industry: "Technology" }], "rapid Confirm must synchronously collapse to one POST")
  tree = render(props)
  assert.match(textFrom(tree), /the brain rejected this exact account write/)
  assert.match(textFrom(tree), /Before.*No client account named\s+Acme\s+exists in the Brain/i,
    "the exact server failure closed the consequence review")

  buttonNamed(tree, "Confirm create").props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.length, 2)
  assert.equal(created[0].account_id, "acme")
  assert.deepEqual(closed, [], "successful creation must hand off to Brand DNA instead of closing the journey")

  assert.match(source, /setOpenId\(account\.account_id\)/,
    "the created account must open its real Brand DNA drawer")
  assert.match(source, /createAccount=\{growth\.createAccount\}/)
  assert.doesNotMatch(source, /BrandOnboarding|brand-onboarding/)
})

test("dirty account bootstrap protects Close before any durable write", () => {
  const { render } = loadAccountBootstrap()
  const calls = []
  const closed = []
  const props = {
    async createAccount(body) { calls.push(body); return { account: null, error: null } },
    onCreated() {},
    onClose() { closed.push(true) },
  }

  let tree = render(props)
  fieldNamed(tree, "Client name").props.onChange({ target: { value: "Unsaved client" } })
  tree = render(props)
  const createDialog = findNode(tree, (candidate) => candidate.type === "dialog" && textFrom(candidate).includes("Create client account"))
  createDialog.props.onClose()
  tree = render(props)
  assert.match(textFrom(tree), /Discard this client account draft\?/)
  assert.deepEqual(closed, [])
  assert.deepEqual(calls, [])
  assert.match(buttonNamed(tree, "Keep editing").props.className, /min-h-11/)
  assert.match(buttonNamed(tree, "Discard draft").props.className, /min-h-11/)
})

test("the same guarded create journey remains reachable after the first account", () => {
  const { renderAccounts } = loadAccountBootstrap()
  const growth = {
    configured: true,
    accounts: [{ account_id: "first", name: "First client", industry: null, created_at: "2026-08-10T00:00:00Z" }],
    problem: null,
    refetch() {},
    async createAccount() { throw new Error("the review should stage before this call") },
    async putDna() { return null },
  }

  let tree = renderAccounts({ growth })
  const add = buttonNamed(tree, "Create client account")
  assert.ok(add, "account two has no reachable create control")
  assert.match(add.props.className, /min-h-11/)
  add.props.onClick()
  tree = renderAccounts({ growth })
  assert.ok(findNode(tree, (candidate) => candidate.type === "dialog" && textFrom(candidate).includes("Create client account")),
    "the non-empty header control did not open the guarded bootstrap")
})

test("Brand DNA keeps the post-save refresh when the initial account read settles later", async () => {
  const calls = []
  const fetchGrowthDna = () => {
    const call = deferred()
    calls.push(call)
    return call.promise
  }
  const harness = loadAccountBootstrap(fetchGrowthDna)
  const growth = {
    configured: true,
    accounts: [{ account_id: "acme", name: "Acme", industry: null, created_at: "2026-08-10T00:00:00Z" }],
    problem: null,
    refetch() {},
    async createAccount() { throw new Error("not used") },
    async putDna() { return null },
  }

  harness.renderAccounts({ growth })
  const loadDna = harness.takeCallbacks()[0]
  const initialRead = loadDna(["acme"])
  const postSaveRead = loadDna(["acme"])
  calls[1].resolve({ configured: true, records: [{ asset: "voice" }] })
  await postSaveRead
  let tree = harness.renderAccounts({ growth })
  assert.match(textFrom(tree), /DNA records\s+1\b/)

  calls[0].resolve({ configured: true, records: [{ asset: "guidelines" }, { asset: "intel" }] })
  await initialRead
  tree = harness.renderAccounts({ growth })
  assert.match(textFrom(tree), /DNA records\s+1\b/)

  const beforeIngestRead = loadDna(["acme"])
  const postIngestRead = loadDna(["acme"])
  calls[3].resolve({ configured: true, records: [{ asset: "guidelines" }, { asset: "voice" }, { asset: "intel" }] })
  await postIngestRead
  calls[2].reject(new Error("stale initial Brand DNA failure"))
  await beforeIngestRead
  tree = harness.renderAccounts({ growth })
  assert.match(textFrom(tree), /DNA records\s+3\b/)
  assert.doesNotMatch(textFrom(tree), /stale initial Brand DNA failure/)
})

test("Brand DNA keeps account B's current failure when account A's newer success settles afterward", async () => {
  const calls = []
  const fetchGrowthDna = (id) => {
    const call = { id, ...deferred() }
    calls.push(call)
    return call.promise
  }
  const harness = loadAccountBootstrap(fetchGrowthDna)
  const growth = {
    configured: true,
    accounts: [
      { account_id: "a", name: "Account A", industry: null, created_at: "2026-08-10T00:00:00Z" },
      { account_id: "b", name: "Account B", industry: null, created_at: "2026-08-10T00:00:00Z" },
    ],
    problem: null,
    refetch() {},
    async createAccount() { throw new Error("not used") },
    async putDna() { return null },
  }

  harness.renderAccounts({ growth })
  const loadDna = harness.takeCallbacks()[0]
  const initialBatch = loadDna(["a", "b"])
  const postSaveRead = loadDna(["a"])
  assert.deepEqual(calls.map((call) => call.id), ["a", "b", "a"])
  calls[0].resolve({ configured: true, records: [{ asset: "guidelines" }] })
  calls[1].reject(new Error("Account B database read timed out"))
  await initialBatch

  let tree = harness.renderAccounts({ growth })
  assert.match(textFrom(tree), /Brand DNA could not be read\s+—\s+Account B database read timed out/)

  calls[2].resolve({ configured: true, records: [{ asset: "voice" }] })
  await postSaveRead
  tree = harness.renderAccounts({ growth })
  assert.match(textFrom(tree), /DNA records\s+1\b/)
  assert.match(textFrom(tree), /Brand DNA could not be read\s+—\s+Account B database read timed out/)
})

test("Brand DNA uses the shared accessible modal and protects unsaved edits", () => {
  const source = read("dashboard/components/agenthost/accounts.tsx")
  assert.match(source, /<Modal[\s\S]*?title=\{`Brand DNA — \$\{account\.name\}`\}/)
  assert.match(source, /const \[dirtyAssets, setDirtyAssets\]/)
  assert.match(source, /function requestClose\(\)[\s\S]*?dirtyAssets\.size > 0[\s\S]*?setDiscardOpen\(true\)/)
  assert.match(source, /title="Discard Brand DNA edits\?"[\s\S]*?Keep editing[\s\S]*?Discard edits/)
  assert.match(source, /onDirtyChange\(assetId, editing && draft !== original\)/)
  assert.match(source, /function cancelEdit\(\)[\s\S]*?draft !== original[\s\S]*?setDiscardOpen\(true\)/)
  assert.match(source, /title=\{`Discard changes to \$\{label\}\?`\}[\s\S]*?Keep editing[\s\S]*?Discard changes/)
  assert.match(source, /const saveInFlight = useRef\(false\)[\s\S]*?if \(disabled \|\| saveInFlight\.current\) return/)
  assert.doesNotMatch(source, /role="dialog"/, "Brand DNA must not hand-roll a second modal implementation")
})

test("Brand DNA counts only the five canonical sections the drawer renders", () => {
  const source = read("dashboard/components/agenthost/accounts.tsx")
  const { countRenderedDnaAssets } = loadAccountBootstrap()
  assert.equal(countRenderedDnaAssets([
    { asset: "brand-voice" },
    { asset: "voice" },
    { asset: "voice" },
    { asset: "guidelines" },
    { asset: "retired-intel-v1" },
  ]), 2, "legacy, hidden, and duplicate Brain records must not inflate the visible-section count")
  assert.match(source, /assetsOnFile = Object\.values\(dna\)\.reduce\([\s\S]*?countRenderedDnaAssets\(records\)/)
  assert.match(source, /dnaCount=\{dna\[a\.account_id\] \? countRenderedDnaAssets\(dna\[a\.account_id\]\) : null\}/)
  assert.match(source, /existingCount=\{countRenderedDnaAssets\(records\)\}/)
})

test("Brand DNA from URL is reachable on the account card and drawer with guarded Enter submission", async () => {
  const source = read("dashboard/components/agenthost/accounts.tsx")
  const harness = loadAccountBootstrap()
  const account = { account_id: "acme", name: "Acme", industry: null, created_at: "2026-08-10T00:00:00Z" }
  const calls = []
  const generated = deferred()
  const opened = []
  const props = {
    account,
    existingCount: 3,
    buildDnaFromUrl(accountId, url) { calls.push([accountId, url]); return generated.promise },
    async onGenerated() { opened.push(true) },
  }

  let tree = harness.renderBuildDnaFromUrl(props)
  const url = fieldNamed(tree, "Website URL for Acme")
  assert.ok(url, "the website URL field is not accessible by the client name")
  assert.match(url.props.className, /min-h-11/)
  assert.equal(findNode(tree, (candidate) => candidate.type === "form").props.noValidate, true,
    "native URL validation must not hide the product's exact validation reason")
  assert.match(textFrom(tree), /replace saved content.*3 records/i)
  url.props.onChange({ target: { value: "ftp://example.com" } })
  tree = harness.renderBuildDnaFromUrl(props)
  const invalidForm = findNode(tree, (candidate) => candidate.type === "form")
  invalidForm.props.onSubmit({ preventDefault() {} })
  tree = harness.renderBuildDnaFromUrl(props)
  assert.match(textFrom(tree), /must use http or https/i)
  assert.deepEqual(calls, [], "an invalid scheme reached the box")

  fieldNamed(tree, "Website URL for Acme").props.onChange({ target: { value: "https://example.com/?access_token=fixture-secret" } })
  tree = harness.renderBuildDnaFromUrl(props)
  findNode(tree, (candidate) => candidate.type === "form").props.onSubmit({ preventDefault() {} })
  tree = harness.renderBuildDnaFromUrl(props)
  assert.match(textFrom(tree), /query strings are not accepted/i)
  assert.doesNotMatch(textFrom(tree), /fixture-secret/)
  assert.deepEqual(calls, [], "a query-bearing URL reached the box")

  fieldNamed(tree, "Website URL for Acme").props.onChange({ target: { value: "https://example.com" } })
  tree = harness.renderBuildDnaFromUrl(props)
  const form = findNode(tree, (candidate) => candidate.type === "form")
  const first = form.props.onSubmit({ preventDefault() {} })
  const duplicate = form.props.onSubmit({ preventDefault() {} })
  assert.deepEqual(calls, [["acme", "https://example.com"]], "rapid Enter submitted the generation request twice")
  generated.resolve({
    result: {
      ok: true,
      written: 5,
      records: [],
      provenance: { source_url: "https://example.com/", source_urls: ["https://example.com/"], generated_at: "2026-08-12T12:00:00.000Z" },
    },
    error: null,
  })
  await Promise.all([first, duplicate])
  assert.deepEqual(opened, [true], "a confirmed build did not refresh/open the real Brand DNA drawer")
  tree = harness.renderBuildDnaFromUrl(props)
  assert.match(textFrom(tree), /Five Brand DNA sections were built from https:\/\/example\.com\//)
  const buildButton = findNode(tree, (candidate) => candidate.type === "button" && textFrom(candidate).trim() === "Build Brand DNA from this site")
  assert.match(buildButton.props.className, /min-h-11/)
  assert.equal((source.match(/<BuildDnaFromUrlForm/g) || []).length, 2, "the form must exist on both the account card and DNA drawer")
})

test("Brand DNA from URL prints the gate's exact failure cause", async () => {
  const harness = loadAccountBootstrap()
  let refreshes = 0
  const props = {
    account: { account_id: "acme", name: "Acme", industry: null, created_at: "2026-08-10T00:00:00Z" },
    existingCount: 0,
    async buildDnaFromUrl() { return { result: null, error: "Brand DNA stored 2 of 5 assets; intel failed (the brain refused disk full)" } },
    onAttemptComplete() { refreshes++ },
    onGenerated() { throw new Error("must not open on failure") },
  }
  let tree = harness.renderBuildDnaFromUrl(props)
  fieldNamed(tree, "Website URL for Acme").props.onChange({ target: { value: "https://example.com" } })
  tree = harness.renderBuildDnaFromUrl(props)
  await findNode(tree, (candidate) => candidate.type === "form").props.onSubmit({ preventDefault() {} })
  tree = harness.renderBuildDnaFromUrl(props)
  assert.match(textFrom(tree), /stored 2 of 5 assets; intel failed \(the brain refused disk full\)/)
  assert.equal(refreshes, 1, "a partial durable write did not trigger a DNA refresh")
})

test("account-scoped generation busy disables both forms, drawer close, and row mutations without hiding a draft", () => {
  const source = read("dashboard/components/agenthost/accounts.tsx")
  assert.match(source, /generationBusy=\{Boolean\(dnaBuilding\[a\.account_id\]\)\}/)
  assert.match(source, /generationBusy=\{Boolean\(dnaBuilding\[openAccount\.account_id\]\)\}/)
  const harness = loadAccountBootstrap()
  const account = { account_id: "acme", name: "Acme", industry: null, created_at: "2026-08-10T00:00:00Z" }
  const baseForm = {
    account,
    existingCount: 2,
    busy: true,
    async buildDnaFromUrl() { throw new Error("disabled form submitted") },
    onGenerated() { throw new Error("disabled form completed") },
  }
  const formTree = harness.renderBuildDnaFromUrl(baseForm)
  assert.equal(fieldNamed(formTree, "Website URL for Acme").props.disabled, true)
  assert.equal(findNode(formTree, (candidate) => candidate.type === "button" && /Building Brand DNA/.test(textFrom(candidate))).props.disabled, true)

  let closed = 0
  const drawerHarness = loadAccountBootstrap()
  const drawer = drawerHarness.renderAccountDrawer({
    account,
    records: [],
    putDna: async () => null,
    buildDnaFromUrl: baseForm.buildDnaFromUrl,
    generationBusy: true,
    onSaved() {},
    onClose() { closed++ },
  })
  // This previously asserted the opposite -- that a running build held the
  // drawer shut. Independent review called that a defect and it is: Accounts
  // owns the request and the refetch, so closing cancels nothing, and trapping
  // the operator for the length of a crawl plus a model run only made the
  // drawer look hung. The MUTATION controls stay disabled (asserted above);
  // the exits do not.
  findNode(drawer, (candidate) => candidate.type === "dialog" && textFrom(candidate).includes("Brand DNA")).props.onClose()
  assert.equal(closed, 1, "the drawer must still close while an account build is in flight")

  const rowProps = {
    assetId: "voice",
    label: "Voice",
    description: "Voice notes",
    record: { id: "v1", asset: "voice", source: "client", content: "saved copy", version: 1, updated_at: "2026-08-12T00:00:00Z", schemaVersion: 1 },
    async onSave() { throw new Error("disabled row saved") },
    onSaved() {},
    onDirtyChange() {},
    disabled: false,
  }
  const rowHarness = loadAccountBootstrap()
  let row = rowHarness.renderDnaAssetRow(rowProps)
  buttonNamed(row, "Edit").props.onClick()
  row = rowHarness.renderDnaAssetRow(rowProps)
  const draft = findNode(row, (candidate) => candidate.type === "textarea")
  draft.props.onChange({ target: { value: "operator draft stays visible" } })
  row = rowHarness.renderDnaAssetRow({ ...rowProps, disabled: true })
  const pausedDraft = findNode(row, (candidate) => candidate.type === "textarea")
  assert.equal(pausedDraft.props.value, "operator draft stays visible")
  assert.equal(pausedDraft.props.disabled, true)
  assert.equal(buttonNamed(row, "Save to the Brain").props.disabled, true)
  assert.equal(buttonNamed(row, "Cancel").props.disabled, true)
  assert.match(textFrom(row), /draft is unchanged/i)
})

/* ---- Measurement / Attribution (the Growth Attribution tab) ---- */

function loadMeasurement(api = {}) {
  const source = read("dashboard/components/agenthost/measurement.tsx")
  const typescript = dashboardRequire("typescript")
  const javascript = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
      jsx: typescript.JsxEmit.ReactJSX,
    },
  }).outputText
  const hookState = []
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
    useEffect() {},
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
  const Modal = ({ open, title, subtitle, children, footer }) => open
    ? node("dialog", { children: [title, subtitle, children, footer] })
    : null
  const Icon = () => node("svg")
  class MeasurementRequestError extends Error {
    constructor(status, message) { super(message); this.name = "MeasurementRequestError"; this.status = status }
  }
  const runtime = {
    react: ReactRuntime,
    "react/jsx-runtime": { Fragment, jsx, jsxs: jsx },
    "lucide-react": new Proxy({}, { get: () => Icon }),
    "@/lib/api": {
      MeasurementRequestError,
      disconnectMeasurementConnection: api.disconnectMeasurementConnection ?? (async () => ({ ok: true, connection: {}, inFlightCancelled: false, disclosure: "This does not revoke OAuth access." })),
      previewMeasurementFactsForConnection: api.previewMeasurementFactsForConnection ?? (async (connectionId) => ({ connectionId, count: 0, enabled: false })),
      deleteMeasurementFactsForConnection: api.deleteMeasurementFactsForConnection ?? (async (connectionId) => ({ ok: true, connectionId, deleted: 0 })),
    },
    "@/lib/live": {},
    "@/lib/utils": { cn: (...values) => values.filter(Boolean).join(" ") },
    "./primitives": { Btn: button, Modal, MonoLabel: passthrough, Panel },
  }
  const loaded = { exports: {} }
  new Function("module", "exports", "require", javascript)(
    loaded,
    loaded.exports,
    (id) => Object.hasOwn(runtime, id) ? runtime[id] : dashboardRequire(id),
  )
  return {
    MeasurementRequestError,
    render(props) {
      hookCursor = 0
      return loaded.exports.Measurement({
        accounts: [{ account_id: "client-acme", name: "Acme", industry: null, created_at: "2026-08-12T00:00:00Z" }],
        onOpenAccounts() {},
        ...props,
      })
    },
  }
}

function preorder(node, out = []) {
  if (node === null || node === undefined || typeof node === "boolean") return out
  if (Array.isArray(node)) { for (const child of node) preorder(child, out); return out }
  if (typeof node === "object") { out.push(node); preorder(node.props?.children, out) }
  return out
}

const DISCLOSURE = "Ad-platform credentials are held by Pipedream Connect and are not stored on this box. Measurement data is stored here, in your own cloud."

function connectedMeasurement() {
  return {
    status: { connected: true, credentialHolder: "pipedream", providers: ["meta_ads"], disclosure: DISCLOSURE },
    statusProblem: null,
    connections: [],
    connectionsProblem: null,
    refetch() {},
  }
}

test("Attribution is health-only: onboarding is absent and existing Pipedream connections stay truthfully labeled", () => {
  const measurementSource = read("dashboard/components/agenthost/measurement.tsx")
  assert.doesNotMatch(measurementSource, /PipedreamCredentialsForm|Connect an ad account|PIPEDREAM_CLIENT_SECRET/)

  const configured = connectedMeasurement()
  configured.connections = [publicConnection({
    accountId: "client-acme", provider: "meta_ads", sourceAccountId: "act_123",
    enabled: true, lastSyncedAt: null, lastError: null,
  })]
  const { render } = loadMeasurement()
  let tree = render({ measurement: configured })
  assert.match(textFrom(tree), /credentials are held by Pipedream Connect/i,
    "an existing Pipedream-backed connection must never be relabeled as direct API access")
  assert.equal(buttonNamed(tree, "Connect an ad account"), null)
  assert.ok(buttonNamed(tree, "Disconnect"), "existing connection health and disconnect controls stay reachable")

  const cause = "measurement is not configured on this box: PIPEDREAM_CLIENT_SECRET is not set"
  tree = render({ measurement: {
    status: { connected: false, credentialHolder: "pipedream", providers: ["meta_ads"], disclosure: DISCLOSURE, why: cause },
    statusProblem: null,
    connections: [],
    connectionsProblem: null,
    refetch() {},
  } })
  assert.match(textFrom(tree), new RegExp(cause.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "the box's exact configuration cause remains visible")
  assert.equal(preorder(tree).filter((node) => node.type === "input" && node.props?.type === "password").length, 0)
  assert.equal(buttonNamed(tree, "Store on this box"), null)
})

test("Attribution health list surfaces a failing connection and keeps credential identifiers redacted", () => {
  const measurementSource = read("dashboard/components/agenthost/measurement.tsx")
  // Health comes from GET /measurement/connections, never from /status.
  assert.match(measurementSource, /Last sync failed —/)
  assert.match(measurementSource, /lastError/)

  const failing = connectedMeasurement()
  failing.connections = [publicConnection({
    accountId: "client-acme", provider: "meta_ads", sourceAccountId: "act_123", enabled: true,
    pipedreamAccountId: "apn_new_private_2", lastSyncedAt: null,
    lastError: "the recorded meta_ads credential 'apn_old_private_1' is not among the 2 connected accounts; upstream reflected account_id apn_new_private_2; Meta token was revoked (OAuthException 190)",
  })]
  const { render } = loadMeasurement()
  const tree = render({ measurement: failing })
  const text = textFrom(tree)
  assert.match(text, /Meta token was revoked \(OAuthException 190\)/, "a connection's lastError must be shown verbatim")
  assert.match(text, /is not among the 2 connected accounts/, "redaction must preserve the actionable upstream cause")
  assert.doesNotMatch(text, /apn_old_private_1|apn_new_private_2/,
    "the UI must render neither the old snapshot nor the current credential identifier after rotation")
})

test("Attribution disconnects, previews the exact fact count, and deletes only after confirmation", async () => {
  const connectionId = "mc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  const disconnects = []
  const previews = []
  const deletes = []
  let refreshes = 0
  const { render } = loadMeasurement({
    disconnectMeasurementConnection: async (id) => {
      disconnects.push(id)
      return {
        ok: true,
        connection: { id, accountId: "client-acme", provider: "meta_ads", sourceAccountId: "act_123", enabled: false, lastSyncedAt: null, lastError: null },
        inFlightCancelled: true,
        disclosure: "Future reads stopped. This does not revoke OAuth access.",
      }
    },
    previewMeasurementFactsForConnection: async (id) => {
      previews.push(id)
      return { connectionId: id, count: 2, enabled: false }
    },
    deleteMeasurementFactsForConnection: async (id) => {
      deletes.push(id)
      if (deletes.length === 1) throw new Error("the connection was re-enabled in another tab; disconnect it again before deleting facts")
      return { ok: true, connectionId: id, deleted: 2 }
    },
  })
  const state = connectedMeasurement()
  state.refetch = () => { refreshes += 1 }
  state.connections = [{
    id: connectionId,
    accountId: "client-acme", provider: "meta_ads", sourceAccountId: "act_123",
    enabled: true, lastSyncedAt: null, lastError: null,
  }]

  let tree = render({ measurement: state })
  const disconnect = buttonNamed(tree, "Disconnect")
  assert.ok(disconnect.props.className.includes("min-h-11"), "phone consequence controls must be at least 44px tall")
  disconnect.props.onClick()
  disconnect.props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(disconnects, [connectionId], "a double tap must start one disconnect request")
  assert.equal(refreshes, 1)

  tree = render({ measurement: state })
  assert.match(textFrom(tree), /does not revoke OAuth access/i,
    "the confirmation must not claim that disconnect revoked provider access")
  const preview = buttonNamed(tree, "Delete stored facts")
  assert.ok(preview.props.className.includes("min-h-11"))
  preview.props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(previews, [connectionId])

  tree = render({ measurement: state })
  const dialog = findNode(tree, (candidate) => candidate.type === "dialog")
  assert.match(textFrom(dialog), /2\s+stored measurement fact\s*s/i,
    "the exact irreversible count must be visible before confirmation")
  buttonNamed(dialog, "Delete 2 stored facts").props.onClick()
  buttonNamed(dialog, "Delete 2 stored facts").props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(deletes, [connectionId], "rapid delete confirmation must start one request")

  tree = render({ measurement: state })
  const retryDialog = findNode(tree, (candidate) => candidate.type === "dialog")
  assert.ok(retryDialog, "a rejected delete must keep its confirmation retryable")
  const deleteCause = findNode(retryDialog, (candidate) => candidate.props?.role === "alert")
  assert.match(textFrom(deleteCause), /re-enabled in another tab.*disconnect it again/i,
    "the exact gate cause must be visible and announced inside the open modal")
  assert.equal(buttonNamed(retryDialog, "Delete 2 stored facts").props.disabled, false)
  buttonNamed(retryDialog, "Delete 2 stored facts").props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(deletes, [connectionId, connectionId])

  tree = render({ measurement: state })
  assert.match(textFrom(tree), /Deleted 2 stored measurement facts/)
})

test("Attribution follows a refreshed same-id reconnect back to enabled", async () => {
  const id = "mc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  const { render } = loadMeasurement({
    disconnectMeasurementConnection: async () => ({
      ok: true,
      connection: { id, accountId: "client-acme", provider: "meta_ads", sourceAccountId: "act_123", enabled: false, lastSyncedAt: null, lastError: null },
      inFlightCancelled: false,
      disclosure: "Future reads stopped. This does not revoke OAuth access.",
    }),
  })
  const measurement = connectedMeasurement()
  measurement.connections = [{
    id, accountId: "client-acme", provider: "meta_ads", sourceAccountId: "act_123",
    enabled: true, lastSyncedAt: null, lastError: null,
  }]

  let tree = render({ measurement })
  buttonNamed(tree, "Disconnect").props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  measurement.connections = [{ ...measurement.connections[0], enabled: false }]
  tree = render({ measurement })
  assert.ok(buttonNamed(tree, "Delete stored facts"), "the refreshed disabled row exposes deletion")

  measurement.connections = [{ ...measurement.connections[0], enabled: true }]
  tree = render({ measurement })
  assert.ok(buttonNamed(tree, "Disconnect"), "the same stable id follows the refreshed enabled server state")
  assert.equal(buttonNamed(tree, "Delete stored facts"), null)
})

test("Attribution shows the Pipedream disclosure and never invents a facts table", () => {
  const measurementSource = read("dashboard/components/agenthost/measurement.tsx")
  // Facts ledger is out of scope: a placeholder, never a facts table (Rule 6/18).
  assert.doesNotMatch(measurementSource, /factsFor|<table|facts\.map/, "the facts ledger table is a fast-follow, not this build")
  assert.match(measurementSource, /measurement facts appear here/i)

  const { render } = loadMeasurement()
  const tree = render({ measurement: connectedMeasurement() })
  assert.match(textFrom(tree), /Ad-platform credentials are held by Pipedream Connect/)
})

test("hidden Growth, Measurement, and Brain panels do not fetch gate-credential data", () => {
  const commandCenter = read("dashboard/components/agenthost/command-center.tsx")
  const live = read("dashboard/lib/live.ts")
  assert.match(commandCenter, /useGrowthAccounts\(activeRoom === "growth" \|\| activeRoom === "work"\)/)
  assert.match(commandCenter, /useMeasurement\(activeRoom === "growth"\)/)
  assert.match(commandCenter, /useMemories\(nav === "brain"\)/)
  assert.match(live, /useGrowthAccounts\(enabled = true\)[\s\S]*usePolled\(fetchGrowthAccounts, 30000, enabled\)/)
  assert.match(live, /useMeasurement\(enabled = true\)[\s\S]*fetchMeasurementStatus, 30000, enabled/)
  assert.match(live, /useMemories\(enabled = true\)[\s\S]*if \(!enabled\)/)
})

// A client's corpus is graphed from the drawer that owns it, not from Artifacts.
// The provenance rhyme is the point: Graphify tags every relationship EXTRACTED,
// INFERRED or AMBIGUOUS, and putDna already validates source as client |
// generated at write time. EXTRACTED is the client's own claim; INFERRED and
// AMBIGUOUS are ours. Promoting a generated claim to client-authored is the one
// failure that whole design exists to prevent.
test("Brand DNA can graph the client's corpus from its own drawer", () => {
  const source = read("dashboard/components/agenthost/accounts.tsx")
  assert.match(source, /import \{ GraphifyPanel \} from "\.\/graphify-panel"/,
    "the Brand DNA drawer cannot reach the shared Graphify panel")
  assert.match(source, /<GraphifyPanel[^>]*onGenerated=\{onSaved\}/,
    "a generated graph must refresh the drawer, or the new records stay invisible until reopen")
  // putDna is the gate on provenance and stays that way: the panel produces a
  // graph, it never writes a DNA record directly.
  assert.doesNotMatch(source, /GraphifyPanel[^>]*putDna/,
    "the Graphify panel must not be handed the DNA writer")
  // A drawer that belongs to ONE client must not offer another client's corpus.
  // Unrestricted, this panel lists every account the box knows, so ClaimFlow's
  // drawer offered to graph Acme -- and, for a client with no brand corpus yet,
  // offered someone else's while never offering its own.
  assert.match(source, /<GraphifyPanel[^>]*restrictToTargetId=\{`brand:\$\{account\.account_id\}`\}/,
    "the Brand DNA drawer must scope the graph builder to the client whose drawer it is")
  const panel = read("dashboard/components/agenthost/graphify-panel.tsx")
  assert.match(panel, /restrictToTargetId\s*\?\s*result\.targets\.filter\(\(target\) => target\.id === restrictToTargetId\)/,
    "the restriction must filter the server's own list, never invent a target")
  assert.match(panel, /setGraphifyChoicesProblem\(restrictToTargetId && !firstTarget/,
    "a restricted target the server does not declare must say so by name, not silently fall back to another subject")
})
