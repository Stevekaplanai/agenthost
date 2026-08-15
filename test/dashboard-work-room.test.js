import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8")
const dashboardRequire = createRequire(path.join(ROOT, "dashboard", "package.json"))
const GRAPHIFY_OPERATION_ID = "a".repeat(32)

function loadDashboardApi(fetchImpl) {
  const typescript = dashboardRequire("typescript")
  const javascript = typescript.transpileModule(read("dashboard/lib/api.ts"), {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
    },
  }).outputText
  const loaded = { exports: {} }
  new Function("module", "exports", "require", "fetch", javascript)(loaded, loaded.exports, dashboardRequire, fetchImpl)
  return loaded.exports
}

function loadTerminalView() {
  const source = `${read("dashboard/components/agenthost/work-view.tsx")}\nexport { TerminalView as __TerminalView }`
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
  let pendingEffects = []
  const sameDeps = (left, right) => Boolean(left && right && left.length === right.length && left.every((item, index) => Object.is(item, right[index])))
  const node = (type, props = {}) => ({ type, props })
  const Fragment = Symbol("Fragment")
  const jsx = (type, props = {}) => {
    if (type === Fragment) return props.children ?? null
    if (typeof type === "function") return type(props)
    return node(type, props)
  }
  const ReactRuntime = {
    useCallback(callback, deps) {
      const index = hookCursor++
      const previous = hookState[index]
      if (!previous || !sameDeps(previous.deps, deps)) hookState[index] = { value: callback, deps }
      return hookState[index].value
    },
    useEffect(effect, deps) {
      const index = hookCursor++
      const previous = hookState[index]
      if (previous && sameDeps(previous.deps, deps)) return
      hookState[index] = { deps, cleanup: previous?.cleanup }
      pendingEffects.push(() => {
        previous?.cleanup?.()
        hookState[index].cleanup = effect()
      })
    },
    useMemo(factory, deps) {
      const index = hookCursor++
      const previous = hookState[index]
      if (!previous || !sameDeps(previous.deps, deps)) hookState[index] = { value: factory(), deps }
      return hookState[index].value
    },
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
  const passthrough = ({ children, title, actions, ...props }) => node("section", { ...props, children: [title, actions, children] })
  const Icon = () => node("svg")
  const runtime = {
    react: ReactRuntime,
    "react/jsx-runtime": { Fragment, jsx, jsxs: jsx },
    "lucide-react": new Proxy({}, { get: () => Icon }),
    "@/lib/agenthost-data": {
      ROSTER: [
        ["claude", "Claude"], ["codex", "Codex"], ["deepseek", "DeepSeek"],
        ["kimi", "Kimi"], ["gemini", "Gemini"], ["hermes", "Hermes"], ["cursor", "Cursor"],
      ].map(([id, name]) => ({ id, name })),
    },
    "@/lib/brand": { getBuyerBrand: () => ({ name: "AgentHost" }) },
    "@/lib/framed": { useIsFramed: () => false },
    "@/lib/utils": { cn: (...values) => values.filter(Boolean).join(" ") },
    "./full-board": { FullBoard: passthrough },
    "./primitives": { Btn: passthrough, HorizontalRail: passthrough, MonoLabel: passthrough, Panel: passthrough, fmtSize: (bytes) => `${bytes} B` },
    "./workbench": { Workbench: passthrough },
  }
  const loaded = { exports: {} }
  new Function("module", "exports", "require", javascript)(
    loaded,
    loaded.exports,
    (id) => Object.hasOwn(runtime, id) ? runtime[id] : dashboardRequire(id),
  )
  return {
    render(props) {
      hookCursor = 0
      pendingEffects = []
      return loaded.exports.__TerminalView(props)
    },
    flushEffects() {
      const effects = pendingEffects
      pendingEffects = []
      for (const effect of effects) effect()
    },
  }
}

// Renamed in spirit, not in name: this loader is used ONLY by the Graphify
// tests below, and the control it renders moved from workbench.tsx to
// graphify-panel.tsx so the same builder can be mounted on Inventory, Brain,
// Brand DNA and Systems. The assertions are unchanged -- they describe the same
// behaviour at its new address.
function loadWorkbench(fetchImpl, apiImpl, browser = {}) {
  const typescript = dashboardRequire("typescript")
  const javascript = typescript.transpileModule(read("dashboard/components/agenthost/graphify-panel.tsx"), {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
      jsx: typescript.JsxEmit.ReactJSX,
    },
  }).outputText
  const hookState = []
  let hookCursor = 0
  let pendingEffects = []
  const sameDeps = (left, right) => Boolean(left && right && left.length === right.length && left.every((item, index) => Object.is(item, right[index])))
  const node = (type, props = {}) => ({ type, props })
  const Fragment = Symbol("Fragment")
  const jsx = (type, props = {}) => {
    if (type === Fragment) return props.children ?? null
    if (typeof type === "function") return type(props)
    return node(type, props)
  }
  const ReactRuntime = {
    useCallback(callback, deps) {
      const index = hookCursor++
      const previous = hookState[index]
      if (!previous || !sameDeps(previous.deps, deps)) hookState[index] = { value: callback, deps }
      return hookState[index].value
    },
    useEffect(effect, deps) {
      const index = hookCursor++
      const previous = hookState[index]
      if (previous && sameDeps(previous.deps, deps)) return
      hookState[index] = { deps, cleanup: previous?.cleanup }
      pendingEffects.push(() => {
        previous?.cleanup?.()
        hookState[index].cleanup = effect()
      })
    },
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
  const passthrough = (type) => ({ children, title, ...props }) => node(type, { ...props, children: [title, children] })
  const Icon = () => node("svg")
  const runtime = {
    react: ReactRuntime,
    "react/jsx-runtime": { Fragment, jsx, jsxs: jsx },
    "lucide-react": new Proxy({}, { get: () => Icon }),
    "@/lib/api": apiImpl,
    "./primitives": {
      // fmtSize moved into primitives when the Graphify panel was extracted.
      // A stub missing a real export renders as "is not a function", which
      // names the stub instead of the bug.
      fmtSize: (bytes) => `${bytes} B`,
      Btn: passthrough("button"),
      MonoLabel: passthrough("span"),
      Panel: passthrough("section"),
    },
  }
  const loaded = { exports: {} }
  const cryptoImpl = browser.crypto || { getRandomValues: (bytes) => bytes.fill(1) }
  const opaqueWindow = {}
  for (const name of ["localStorage", "sessionStorage"]) {
    Object.defineProperty(opaqueWindow, name, {
      get() { throw new Error(`${name} is unavailable in an opaque iframe`) },
    })
  }
  new Function("module", "exports", "require", "fetch", "process", "window", "crypto", javascript)(
    loaded,
    loaded.exports,
    (id) => Object.hasOwn(runtime, id) ? runtime[id] : dashboardRequire(id),
    fetchImpl,
    { env: {} },
    opaqueWindow,
    cryptoImpl,
  )
  return {
    render() {
      hookCursor = 0
      pendingEffects = []
      return loaded.exports.GraphifyPanel({})
    },
    flushEffects() {
      const effects = pendingEffects
      pendingEffects = []
      for (const effect of effects) effect()
    },
  }
}

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

const settleAsync = () => new Promise((resolve) => setImmediate(resolve))

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

test("Work is one in-shell room backed by the real board, files, artifacts, terminal, and reviews", () => {
  const source = read("dashboard/components/agenthost/work-view.tsx")

  for (const tab of ["Board", "Files", "Artifacts", "Terminal", "Reviews"]) {
    assert.match(source, new RegExp(`label:\\s*[\"']${tab}[\"']`), `${tab} remains reachable inside Work`)
  }

  assert.match(source, /<FullBoard\b/, "Board reuses the canonical live board")
  assert.match(source, /fetch\([^)]*\/files["'`]/s, "Files reads the curated live file API")
  assert.match(source, /<Workbench\b/, "Artifacts reuse the live artifact surface")
  assert.match(source, /src=\{terminalSrc\}/, "Terminal stays in an iframe inside the shell")
  assert.match(source, /\/terminal\//, "Terminal uses the scoped ttyd mount")
  assert.match(source, /sandbox=["']allow-scripts["']/, "Terminal runs in an opaque script-only sandbox")
  assert.match(source, /allow=["']clipboard-write["']/, "Terminal may copy output only")
  assert.doesNotMatch(source, /clipboard-read/, "Agent-owned terminal content cannot read the operator clipboard")
  assert.doesNotMatch(source, /sandbox=["'][^"']*allow-same-origin/, "Terminal cannot inherit operator origin authority")
  assert.doesNotMatch(source, /sandbox=["'][^"']*allow-(?:forms|popups|downloads)/,
    "Terminal cannot submit forms, open escape windows, or trigger downloads")
  assert.match(source, /framed \? "\/box\/switch" : `\$\{BASE\}\/switch`/,
    "the framed terminal switches the box session through the authenticated AgentGlass proxy")
  assert.match(source, /method:\s*["']POST["']/, "terminal session switching is a consequence-bearing POST")
  assert.match(source, /switchRequestId\.current/, "stale terminal switch responses cannot replace the newest selection")
  assert.match(source, /disabled=\{switching\}/, "the session picker names its in-flight state and cannot double-submit")
  assert.match(source, /<select[\s\S]*className="min-h-11/, "the phone terminal session picker needs a 44px target")
  assert.match(source, /loaded \? ["']loaded["'] : ["']loading["']/, "iframe load is described truthfully without claiming terminal health")
  assert.doesNotMatch(source, /\{ready \? ["']live["']/, "an iframe load cannot be advertised as a live terminal")
  assert.match(source, /columns\?\.review/, "Reviews are projected from the durable board")

  for (const fake of ["TERMINAL_LINES", "DIFF_LINES", "const FILES =", "const ARTIFACTS =", "synced 8s ago", "PR #255"]) {
    assert.doesNotMatch(source, new RegExp(fake.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${fake} prototype fiction is removed`)
  }
  assert.doesNotMatch(source, /window\.location\.(?:assign|href)|externalHref/, "Work never unloads the shell")
})

test("Work file and terminal failures name the real cause", () => {
  const source = read("dashboard/components/agenthost/work-view.tsx")
  assert.match(source, /Files could not be read[^\n]*\{problem\}/)
  assert.match(source, /Terminal could not switch[^\n]*\{terminalProblem\}/)
  assert.match(source, /response body|returned no JSON|malformed JSON/)
})

test("Work stages a file upload before one locked write to the team inbox", () => {
  const source = read("dashboard/components/agenthost/work-view.tsx")
  assert.match(source, /const \[pendingUpload, setPendingUpload\] = useState<File \| null>\(null\)/)
  assert.match(source, /const uploadInFlight = useRef\(false\)/)
  assert.match(source, /if \(!file \|\| uploadInFlight\.current\) return/)
  assert.match(source, /setPendingUpload\(file\)/)
  assert.match(source, /Nothing is uploaded until you confirm/)
  assert.match(source, /onClick=\{clearPendingUpload\}>Cancel<\/Btn>/)
  assert.match(source, /onClick=\{confirmUpload\}/)
  assert.match(source, /role="alert"[\s\S]*File was not uploaded/)
  assert.match(source, /className="min-h-11 min-w-11" onClick=\{load\} aria-label="Refresh files"/)
  assert.match(source, /className="min-h-11" disabled=\{uploading \|\| pendingUpload !== null\}/)
})

test("artifact actions keep exact accessible names when phone text is visually hidden", () => {
  const source = read("dashboard/components/agenthost/workbench.tsx")
  assert.match(source, /aria-label=\{`Open \$\{f\.title\}`\}/)
  assert.match(source, /aria-label=\{`Download \$\{f\.title\}`\}/)
  assert.match(source, /target="_blank"[\s\S]*rel="noopener noreferrer"/)
})

test("Workbench exposes one bounded Graphify control with reachable generated artifacts", () => {
  const source = read("dashboard/components/agenthost/graphify-panel.tsx")
  const api = read("dashboard/lib/api.ts")

  assert.match(api, /export async function fetchGraphifyTargets\(\)/)
  assert.match(api, /graphifyJson<unknown>\("\/api\/graphify", "GET"\)/)
  assert.match(api, /export async function reserveGraphifyOperation\(targetId: string, folderId: string\)/)
  assert.match(api, /export async function acknowledgeGraphifyOperation\([\s\S]*targetId: string,[\s\S]*folderId: string,[\s\S]*operationId: string,[\s\S]*\): Promise<void>/)
  assert.match(api, /export async function generateGraphify\(targetId: string, folderId: string, operationId: string\)/)
  assert.match(api, /GRAPHIFY_OPERATION_ID_RE\.test\(operationId\)/,
    "the browser API must reject anything except one 32-character lowercase-hex operation id")
  assert.match(api, /graphifyJson<unknown>\("\/api\/graphify", "POST", \{ targetId, folderId, operationId \}\)/,
    "the browser may submit only the selected server-owned ids and retry identity")
  assert.match(api, /graphifyJson<unknown>\("\/api\/graphify\/operation", "POST", \{ targetId, folderId \}\)/)
  assert.match(api, /graphifyJson<unknown>\("\/api\/graphify\/operation", "DELETE", \{ targetId, folderId, operationId \}\)/)

  assert.match(source, /<MonoLabel[^>]*>Map what is inside<\/MonoLabel>/)
  assert.match(source, /aria-label="Graphify target"/)
  assert.match(source, /aria-label="Folder to graph"/)
  assert.match(source, /defaultFolderId/,
    "changing targets must select that target's server-declared default folder")
  assert.match(source, /className="min-h-11"[\s\S]*onClick=\{generate\}/,
    "Generate graph needs a 44px phone target")
  assert.match(source, /Graphify choices could not be read[^\n]*\{graphifyChoicesProblem\}/)
  assert.match(source, /graphifyWarnings\.map\(\(warning\)/,
    "non-fatal target discovery warnings must remain visible while safe targets stay usable")
  assert.match(source, /graphifyResult\.warnings\?\.retention/)
  assert.match(source, /Graph saved, but old snapshot cleanup was deferred/,
    "a committed graph must not hide its bounded retention warning")
  assert.match(source, /selectedTarget\?\.kind === "brand"/)
  assert.match(source, /Client-authored Brand DNA is never overwritten\./,
    "the Brand control must state the source-wins contract before generation")
  assert.match(source, /Graph could not be generated[^\n]*\{graphifyProblem\}/)
  assert.match(source, /selectedTarget\.kind === "brand"[\s\S]*reserveGraphifyOperation/,
    "Brand retries must use the gate's durable operation lease")
  assert.match(source, /crypto\.getRandomValues\(bytes\)/,
    "a non-Brand run may use one ephemeral browser-generated operation id")
  assert.match(source, /await acknowledgeGraphifyOperation/,
    "a completed Brand graph must acknowledge its exact server lease")
  assert.doesNotMatch(source, /localStorage|sessionStorage/,
    "Graphify must run inside the Command Center's opaque iframe")
  assert.match(source, /Graph saved, but retry confirmation is pending/,
    "an acknowledgement outage must be visible without hiding the completed graph")
  const graphifyPanel = source.slice(source.indexOf('<MonoLabel className="text-dim">Map what is inside</MonoLabel>'))
  assert.match(source, /<a(?:(?!<\/a>)[\s\S])*?className="[^\"]*min-h-11[^\"]*"(?:(?!<\/a>)[\s\S])*?>(?:(?!<\/a>)[\s\S])*?Open interactive graph(?:(?!<\/a>)[\s\S])*?<\/a>/,
    "Open interactive graph needs a 44px phone target")
  assert.match(source, /<a(?:(?!<\/a>)[\s\S])*?className="[^\"]*min-h-11[^\"]*"(?:(?!<\/a>)[\s\S])*?>(?:(?!<\/a>)[\s\S])*?Open report(?:(?!<\/a>)[\s\S])*?<\/a>/,
    "Open report needs a 44px phone target")
  assert.doesNotMatch(graphifyPanel, /target="_blank"/,
    "Graphify results must navigate inside the Command Center's popup-free opaque iframe")
  assert.match(source, /graphifyResult\.snapshot\.kind/)
  assert.match(source, /graphifyResult\.snapshot\.value/)
  assert.match(source, /graphifyResult\.snapshot\.manifestSha256/)
  assert.match(source, /graphifyResult\.snapshot\.builtAt/)
  assert.match(source, /graphifyResult\.snapshot\.derived/)
  for (const count of ["files", "inputBytes", "nodes", "links"]) {
    assert.match(source, new RegExp(`graphifyResult\\.counts\\.${count}`), `${count} is missing from the receipt`)
  }
  assert.doesNotMatch(graphifyPanel, /dangerouslySetInnerHTML|\.json\b|resultPath|graphPath|privatePath/,
    "the Workbench must not render Graphify output or expose JSON and gate-owned paths")
  assert.doesNotMatch(source, /Code Map|fetchCodeMapRepositories|generateCodeMap/,
    "the repo-only Code Map control is replaced instead of duplicated")
})

test("the framed desktop Workspace keeps a compact route into Work and Artifacts", () => {
  const command = read("dashboard/components/agenthost/command-center.tsx")
  const sidebar = read("dashboard/components/agenthost/sidebar.tsx")

  assert.match(command, /<MobileNav[\s\S]*framed=\{framed\}/,
    "the framed shell tells the compact navigation to remain reachable")
  assert.match(command, /framed \? "lg:pb-\[calc\(4\.5rem\+env\(safe-area-inset-bottom\)\)\]" : "lg:pb-3"/,
    "framed desktop content leaves room for the compact navigation")
  assert.match(sidebar, /framed\?: boolean/)
  assert.match(sidebar, /!framed && "lg:hidden"/,
    "the compact navigation hides on ordinary desktop but stays visible in the framed Workspace")
})

test("a failed Graphify retry keeps the last proven result visible and success refreshes artifacts", () => {
  const source = read("dashboard/components/agenthost/graphify-panel.tsx")
  const generateBlock = source.match(/const generate = useCallback\(([\s\S]*?)\n\s*\}, \[onGenerated, selectedFolderId, selectedTarget, selectedTargetId\]\)/)
  assert.ok(generateBlock, "the Graphify action is missing")
  const catchBlock = generateBlock[1].match(/catch \(e: unknown\) \{([\s\S]*?)\n\s*\} finally/)
  assert.ok(catchBlock, "the Graphify action has no named catch block")
  assert.match(catchBlock[1], /setGraphifyProblem\(/)
  assert.doesNotMatch(generateBlock[1], /setGraphifyResult\(null\)/,
    "a retry failure erased the last successful graph")
  const successBlock = generateBlock[1].match(/const result = await generateGraphify\([\s\S]*?\n\s*\} catch/)
  assert.ok(successBlock, "the Graphify success path is missing")
  assert.match(successBlock[0], /setGraphifyResult\(result\)[\s\S]*onGenerated\?\.\(\)/,
    "a successful graph must report upward without blocking its completed receipt")
  // The seam: the panel reports success, Workbench turns that into a reload.
  // Asserted across BOTH files so the refresh cannot be silently lost.
  const workbench = read("dashboard/components/agenthost/workbench.tsx")
  assert.match(workbench, /<GraphifyPanel[^>]*onGenerated=\{load\}/,
    "Workbench stopped refreshing its artifact list when a graph completes")
  assert.match(workbench, /const artifactLoadRequest = useRef\(0\)/)
  assert.match(workbench, /const request = \+\+artifactLoadRequest\.current[\s\S]*request !== artifactLoadRequest\.current/,
    "only the newest artifact refresh may update the list")
  assert.match(source, /role="status"[\s\S]*aria-live="polite"[\s\S]*Last successful graph/,
    "assistive technology must announce a completed graph")
})

test("a completed graph releases Generate while artifact refresh stays pending and ignores an older list", async () => {
  const initialArtifacts = deferred()
  const currentArtifacts = deferred()
  const artifactReads = [initialArtifacts, currentArtifacts]
  const receipt = {
    runId: "graphify-run-1",
    target: { id: "repo:owner/repo", label: "AgentHost" },
    folder: { id: "dashboard", label: "Dashboard" },
    snapshot: {
      kind: "git",
      value: "174ef8c98003",
      manifestSha256: "a".repeat(64),
      builtAt: "2026-08-14T12:00:00.000Z",
      derived: true,
    },
    artifacts: {
      html: { name: "graph.html", viewUrl: "/artifacts/view?p=graph.html", downloadUrl: "/artifacts/dl?p=graph.html" },
      markdown: { name: "report.md", viewUrl: "/artifacts/view?p=report.md", downloadUrl: "/artifacts/dl?p=report.md" },
    },
    counts: { files: 1, inputBytes: 100, nodes: 2, links: 1 },
    warnings: { retention: "old snapshot cleanup will retry on the next run" },
  }
  const harness = loadWorkbench(
    () => artifactReads.shift().promise,
    {
      artifactViewUrl: (name) => `/artifacts/view?p=${name}`,
      fetchGraphifyTargets: async () => ({
        warnings: [],
        targets: [{
          id: "repo:owner/repo",
          label: "AgentHost",
          kind: "git",
          folders: [{ id: "dashboard", label: "Dashboard" }],
          defaultFolderId: "dashboard",
        }],
      }),
      generateGraphify: async () => receipt,
    },
  )

  harness.render()
  harness.flushEffects()
  await settleAsync()
  let tree = harness.render()
  const generate = findNode(tree, (candidate) => candidate.type === "button" && /Generate graph/.test(textFrom(candidate)))
  assert.ok(generate, "the ready Generate action is missing")
  await generate.props.onClick()

  tree = harness.render()
  const released = findNode(tree, (candidate) => candidate.type === "button" && /Generate graph/.test(textFrom(candidate)))
  assert.equal(released?.props.disabled, false, "a nonessential pending artifact refresh kept Generate disabled")
  assert.match(textFrom(tree), /Last successful graph.*AgentHost.*Dashboard/s)
  assert.match(textFrom(tree), /Graph saved, but old snapshot cleanup was deferred.*old snapshot cleanup will retry/s)

  // The artifact-list half of this scenario moved with the extraction: the panel
  // does not own the list, so it cannot render "Current graph" or race two
  // responses. Those are Workbench's and are asserted against its source here --
  // the panel's own claim is the one above, that a pending refresh it does not
  // own can never keep Generate disabled.
  const workbench = read("dashboard/components/agenthost/workbench.tsx")
  assert.match(workbench, /<GraphifyPanel[^>]*onGenerated=\{load\}/,
    "a completed graph no longer refreshes the artifact list")
  assert.match(workbench, /const request = \+\+artifactLoadRequest\.current[\s\S]*request !== artifactLoadRequest\.current/,
    "the stale-response guard that ignores an older artifact list is gone")
})

test("Brand Graphify reserves on the server, omits ACK after a lost response, resumes after reload, then ACKs before a fresh operation", async () => {
  const operationIds = ["a".repeat(32), "b".repeat(32)]
  let activeOperationId = operationIds[0]
  const calls = []
  const submitted = []
  const receipt = {
    runId: "graphify-run-recovered",
    target: { id: "brand:acme", label: "Acme" },
    folder: { id: "brand_all", label: "Brand DNA" },
    snapshot: {
      kind: "git",
      value: "174ef8c98003",
      manifestSha256: "a".repeat(64),
      builtAt: "2026-08-14T12:00:00.000Z",
      derived: true,
    },
    artifacts: {
      html: { name: "graph.html", viewUrl: "/artifacts/view?p=graph.html", downloadUrl: "/artifacts/dl?p=graph.html" },
      markdown: { name: "report.md", viewUrl: "/artifacts/view?p=report.md", downloadUrl: "/artifacts/dl?p=report.md" },
    },
    counts: { files: 1, inputBytes: 100, nodes: 2, links: 1 },
  }
  const apiImpl = {
    artifactViewUrl: (name) => `/artifacts/view?p=${name}`,
    fetchGraphifyTargets: async () => ({
      warnings: [],
      targets: [{
        id: "brand:acme",
        label: "Acme",
        kind: "brand",
        folders: [{ id: "brand_all", label: "Brand DNA" }],
        defaultFolderId: "brand_all",
      }],
    }),
    reserveGraphifyOperation: async (targetId, folderId) => {
      calls.push(`reserve:${targetId}:${folderId}:${activeOperationId}`)
      return activeOperationId
    },
    generateGraphify: async (targetId, folderId, operationId) => {
      calls.push(`generate:${operationId}`)
      submitted.push({ targetId, folderId, operationId })
      if (submitted.length === 1) throw new Error("the connection was lost after Graphify was submitted")
      return receipt
    },
    acknowledgeGraphifyOperation: async (targetId, folderId, operationId) => {
      calls.push(`ack:${operationId}`)
      assert.equal(targetId, "brand:acme")
      assert.equal(folderId, "brand_all")
      assert.equal(operationId, activeOperationId)
      activeOperationId = operationIds[1]
    },
  }
  const fetchArtifacts = async () => ({ ok: true, status: 200, async json() { return { files: [] } } })

  const firstPage = loadWorkbench(fetchArtifacts, apiImpl)
  firstPage.render()
  firstPage.flushEffects()
  await settleAsync()
  let tree = firstPage.render()
  let generate = findNode(tree, (candidate) => candidate.type === "button" && /Generate graph/.test(textFrom(candidate)))
  await generate.props.onClick()
  assert.deepEqual(calls, [
    `reserve:brand:acme:brand_all:${operationIds[0]}`,
    `generate:${operationIds[0]}`,
  ], "a failed generation must not acknowledge or replace its server lease")

  const reloadedPage = loadWorkbench(fetchArtifacts, apiImpl)
  reloadedPage.render()
  reloadedPage.flushEffects()
  await settleAsync()
  tree = reloadedPage.render()
  generate = findNode(tree, (candidate) => candidate.type === "button" && /Generate graph/.test(textFrom(candidate)))
  await generate.props.onClick()
  assert.deepEqual(submitted.slice(0, 2).map((request) => request.operationId), [operationIds[0], operationIds[0]],
    "a new tab created a second operation instead of recovering the submitted run")
  assert.equal(calls.at(-1), `ack:${operationIds[0]}`)

  tree = reloadedPage.render()
  generate = findNode(tree, (candidate) => candidate.type === "button" && /Generate graph/.test(textFrom(candidate)))
  await generate.props.onClick()
  assert.equal(submitted[2].operationId, operationIds[1], "a later intentional Generate reused the completed operation")
  assert.notEqual(submitted[2].operationId, submitted[1].operationId)
  assert.equal(calls.at(-1), `ack:${operationIds[1]}`)
})

test("a failed Brand ACK keeps the graph visible and the next Generate retries that ACK before reserving new work", async () => {
  const firstOperationId = "c".repeat(32)
  const secondOperationId = "d".repeat(32)
  const calls = []
  let acknowledgements = 0
  let reservations = 0
  const receipt = {
    runId: "graphify-run-ack-retry",
    target: { id: "brand:acme", label: "Acme" },
    folder: { id: "brand_all", label: "Brand DNA" },
    snapshot: {
      kind: "folder", value: "snapshot-a", manifestSha256: "a".repeat(64),
      builtAt: "2026-08-14T12:00:00.000Z", derived: true,
    },
    artifacts: {
      html: { name: "graph.html", viewUrl: "/artifacts/view?p=graph.html", downloadUrl: "/artifacts/dl?p=graph.html" },
      markdown: { name: "report.md", viewUrl: "/artifacts/view?p=report.md", downloadUrl: "/artifacts/dl?p=report.md" },
    },
    counts: { files: 1, inputBytes: 100, nodes: 2, links: 1 },
  }
  const harness = loadWorkbench(
    async () => ({ ok: true, status: 200, async json() { return { files: [] } } }),
    {
      artifactViewUrl: (name) => `/artifacts/view?p=${name}`,
      fetchGraphifyTargets: async () => ({
        warnings: [],
        targets: [{
          id: "brand:acme", label: "Acme", kind: "brand",
          folders: [{ id: "brand_all", label: "Brand DNA" }], defaultFolderId: "brand_all",
        }],
      }),
      reserveGraphifyOperation: async () => {
        const operationId = reservations++ === 0 ? firstOperationId : secondOperationId
        calls.push(`reserve:${operationId}`)
        return operationId
      },
      generateGraphify: async (_targetId, _folderId, operationId) => {
        calls.push(`generate:${operationId}`)
        return { ...receipt, runId: `run-${operationId[0]}` }
      },
      acknowledgeGraphifyOperation: async (_targetId, _folderId, operationId) => {
        calls.push(`ack:${operationId}`)
        acknowledgements += 1
        if (acknowledgements === 1) throw new Error("the ACK response was lost")
      },
    },
  )

  harness.render()
  harness.flushEffects()
  await settleAsync()
  let tree = harness.render()
  let generate = findNode(tree, (candidate) => candidate.type === "button" && /Generate graph/.test(textFrom(candidate)))
  await generate.props.onClick()

  tree = harness.render()
  assert.match(textFrom(tree), /Last successful graph.*Acme.*Brand DNA/s,
    "an ACK transport failure erased the valid graph receipt")
  assert.match(textFrom(tree), /Graph saved, but retry confirmation is pending.*ACK response was lost/s)
  assert.deepEqual(calls, [`reserve:${firstOperationId}`, `generate:${firstOperationId}`, `ack:${firstOperationId}`])

  generate = findNode(tree, (candidate) => candidate.type === "button" && /Generate graph/.test(textFrom(candidate)))
  await generate.props.onClick()
  assert.deepEqual(calls, [
    `reserve:${firstOperationId}`, `generate:${firstOperationId}`, `ack:${firstOperationId}`,
    `ack:${firstOperationId}`, `reserve:${secondOperationId}`, `generate:${secondOperationId}`, `ack:${secondOperationId}`,
  ], "new Brand work started before the old completion ACK recovered")
  tree = harness.render()
  assert.doesNotMatch(textFrom(tree), /retry confirmation is pending/)
  assert.match(textFrom(tree), /Last successful graph.*Acme.*Brand DNA/s)
})

test("the Graphify API sends the exact target-folder body and projects the frozen receipt", async () => {
  const calls = []
  const manifestSha256 = "a".repeat(64)
  const responses = [
    {
      warnings: [{
        code: "GRAPHIFY_BRAND_TARGETS_UNAVAILABLE",
        error: "Brand targets are unavailable until Growth account data can be read",
      }],
      targets: [{
        id: "repo:owner/repo",
        label: "AgentHost",
        kind: "git",
        folders: [{ id: "dashboard", label: "Dashboard" }],
        defaultFolderId: "dashboard",
        privatePath: "/data/private/repo",
      }],
    },
    { operationId: GRAPHIFY_OPERATION_ID },
    {
      runId: "graphify-run-1",
      target: { id: "repo:owner/repo", label: "AgentHost" },
      folder: { id: "dashboard", label: "Dashboard" },
      snapshot: {
        kind: "git",
        value: "174ef8c98003",
        manifestSha256,
        builtAt: "2026-08-14T12:00:00.000Z",
        derived: true,
      },
      artifacts: {
        html: {
          name: "agenthost-dashboard-graph.html",
          viewUrl: "/artifacts/view?p=agenthost-dashboard-graph.html",
          downloadUrl: "/artifacts/dl?p=agenthost-dashboard-graph.html",
        },
        markdown: {
          name: "agenthost-dashboard-report.md",
          viewUrl: "/artifacts/view?p=agenthost-dashboard-report.md",
          downloadUrl: "/artifacts/dl?p=agenthost-dashboard-report.md",
        },
      },
      counts: { files: 3, inputBytes: 2048, nodes: 7, links: 9 },
      warnings: { retention: "old snapshot cleanup will retry on the next run" },
      graphPath: "/data/private/graph.json",
    },
    {
      ok: true,
      targetId: "repo:owner/repo",
      folderId: "dashboard",
      operationId: GRAPHIFY_OPERATION_ID,
    },
  ]
  const api = loadDashboardApi(async (url, init = {}) => {
    calls.push({ url: String(url), init })
    const body = responses.shift()
    return { ok: true, status: 200, async text() { return JSON.stringify(body) } }
  })

  assert.deepEqual(await api.fetchGraphifyTargets(), {
    warnings: [{
      code: "GRAPHIFY_BRAND_TARGETS_UNAVAILABLE",
      error: "Brand targets are unavailable until Growth account data can be read",
    }],
    targets: [{
      id: "repo:owner/repo",
      label: "AgentHost",
      kind: "git",
      folders: [{ id: "dashboard", label: "Dashboard" }],
      defaultFolderId: "dashboard",
    }],
  })
  assert.equal(await api.reserveGraphifyOperation("repo:owner/repo", "dashboard"), GRAPHIFY_OPERATION_ID)
  assert.deepEqual(await api.generateGraphify("repo:owner/repo", "dashboard", GRAPHIFY_OPERATION_ID), {
    runId: "graphify-run-1",
    target: { id: "repo:owner/repo", label: "AgentHost" },
    folder: { id: "dashboard", label: "Dashboard" },
    snapshot: {
      kind: "git",
      value: "174ef8c98003",
      manifestSha256,
      builtAt: "2026-08-14T12:00:00.000Z",
      derived: true,
    },
    artifacts: {
      html: {
        name: "agenthost-dashboard-graph.html",
        viewUrl: "/artifacts/view?p=agenthost-dashboard-graph.html",
        downloadUrl: "/artifacts/dl?p=agenthost-dashboard-graph.html",
      },
      markdown: {
        name: "agenthost-dashboard-report.md",
        viewUrl: "/artifacts/view?p=agenthost-dashboard-report.md",
        downloadUrl: "/artifacts/dl?p=agenthost-dashboard-report.md",
      },
    },
    counts: { files: 3, inputBytes: 2048, nodes: 7, links: 9 },
    warnings: { retention: "old snapshot cleanup will retry on the next run" },
  })
  assert.equal(await api.acknowledgeGraphifyOperation("repo:owner/repo", "dashboard", GRAPHIFY_OPERATION_ID), undefined)
  assert.equal(calls[0].url, "/api/graphify")
  assert.equal(calls[1].url, "/api/graphify/operation")
  assert.equal(calls[1].init.method, "POST")
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    targetId: "repo:owner/repo",
    folderId: "dashboard",
  })
  assert.equal(calls[2].url, "/api/graphify")
  assert.equal(calls[2].init.method, "POST")
  assert.deepEqual(JSON.parse(calls[2].init.body), {
    targetId: "repo:owner/repo",
    folderId: "dashboard",
    operationId: GRAPHIFY_OPERATION_ID,
  })
  assert.equal(calls[3].url, "/api/graphify/operation")
  assert.equal(calls[3].init.method, "DELETE")
  assert.deepEqual(JSON.parse(calls[3].init.body), {
    targetId: "repo:owner/repo",
    folderId: "dashboard",
    operationId: GRAPHIFY_OPERATION_ID,
  })
})

test("Graphify rejects a malformed operation id before contacting the gate", async () => {
  let calls = 0
  const api = loadDashboardApi(async () => {
    calls += 1
    throw new Error("fetch must not run")
  })

  for (const operationId of ["", "a".repeat(31), "A".repeat(32), "a".repeat(33), "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]) {
    await assert.rejects(
      api.generateGraphify("repo:owner/repo", "dashboard", operationId),
      /32-character lowercase-hex Graphify operation id/,
    )
  }
  assert.equal(calls, 0)
})

test("Graphify rejects malformed reserve and ACK receipts instead of changing retry state", async () => {
  for (const body of [
    null,
    {},
    { operationId: "a".repeat(31) },
    { operationId: "A".repeat(32) },
    { operationId: GRAPHIFY_OPERATION_ID, extra: true },
  ]) {
    const api = loadDashboardApi(async () => ({
      ok: true,
      status: 200,
      async text() { return JSON.stringify(body) },
    }))
    await assert.rejects(
      api.reserveGraphifyOperation("brand:acme", "brand_all"),
      /malformed Graphify data|invalid Graphify operation reservation/,
    )
  }

  for (const body of [
    null,
    { ok: false, targetId: "brand:acme", folderId: "brand_all", operationId: GRAPHIFY_OPERATION_ID },
    { ok: true, targetId: "brand:other", folderId: "brand_all", operationId: GRAPHIFY_OPERATION_ID },
    { ok: true, targetId: "brand:acme", folderId: "other", operationId: GRAPHIFY_OPERATION_ID },
    { ok: true, targetId: "brand:acme", folderId: "brand_all", operationId: "b".repeat(32) },
    { ok: true, targetId: "brand:acme", folderId: "brand_all", operationId: GRAPHIFY_OPERATION_ID, extra: true },
  ]) {
    const api = loadDashboardApi(async () => ({
      ok: true,
      status: 200,
      async text() { return JSON.stringify(body) },
    }))
    await assert.rejects(
      api.acknowledgeGraphifyOperation("brand:acme", "brand_all", GRAPHIFY_OPERATION_ID),
      /malformed Graphify data|invalid Graphify operation acknowledgement/,
    )
  }
})

test("Graphify target warnings are bounded and cannot carry paths or secret-shaped values", async () => {
  for (const warning of [
    { code: "GRAPHIFY_BRAND_TARGETS_UNAVAILABLE", error: "/data/private/brand could not be read" },
    { code: "GRAPHIFY_BRAND_TARGETS_UNAVAILABLE", error: `provider sk-${"a".repeat(24)} failed` },
    { code: "GRAPHIFY_BRAND_TARGETS_UNAVAILABLE", error: "password=hunter2" },
    { code: "GRAPHIFY_BRAND_TARGETS_UNAVAILABLE", error: "authorization: Bearer ordinary-secret-value" },
    { code: "GRAPHIFY_BRAND_TARGETS_UNAVAILABLE", error: "cookie=sessionid=plain-cookie-secret" },
    { code: "GRAPHIFY_BRAND_TARGETS_UNAVAILABLE", error: "session: plain-session-secret" },
    { code: "GRAPHIFY_BRAND_TARGETS_UNAVAILABLE", error: "passphrase=hunter2" },
    { code: "GRAPHIFY_BRAND_TARGETS_UNAVAILABLE", error: "access_key=plain-secret" },
    { code: "GRAPHIFY_BRAND_TARGETS_UNAVAILABLE", error: "secret_key=plain-secret" },
    { code: "GRAPHIFY_BRAND_TARGETS_UNAVAILABLE", error: '"password": "hunter2"' },
    { code: "GRAPHIFY_BRAND_TARGETS_UNAVAILABLE", error: 'config["password"]="hunter2"' },
    { code: "GRAPHIFY_BRAND_TARGETS_UNAVAILABLE", error: 'password="[REDACTED]" actual=hunter2' },
    { code: "GRAPHIFY_BRAND_TARGETS_UNAVAILABLE", error: 'password="[REDACTED]" trailing' },
    { code: "bad code", error: "Brand targets are unavailable" },
  ]) {
    const api = loadDashboardApi(async () => ({
      ok: true,
      status: 200,
      async text() { return JSON.stringify({ targets: [], warnings: [warning] }) },
    }))
    await assert.rejects(api.fetchGraphifyTargets(), /invalid target warning/)
  }

  const redactedApi = loadDashboardApi(async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        targets: [],
        warnings: [{ code: "GRAPHIFY_BRAND_TARGETS_UNAVAILABLE", error: "password=[REDACTED]" }],
      })
    },
  }))
  assert.deepEqual(await redactedApi.fetchGraphifyTargets(), {
    targets: [],
    warnings: [{ code: "GRAPHIFY_BRAND_TARGETS_UNAVAILABLE", error: "password=[REDACTED]" }],
  })
})

test("Graphify retention warnings are optional, exact, bounded, and safe to render", async () => {
  const receipt = {
    runId: "graphify-run-warning",
    target: { id: "repo:owner/repo", label: "AgentHost" },
    folder: { id: "dashboard", label: "Dashboard" },
    snapshot: {
      kind: "git", value: "174ef8c98003", manifestSha256: "a".repeat(64),
      builtAt: "2026-08-14T12:00:00.000Z", derived: true,
    },
    artifacts: {
      html: { name: "graph.html", viewUrl: "/artifacts/view?p=graph.html", downloadUrl: "/artifacts/dl?p=graph.html" },
      markdown: { name: "report.md", viewUrl: "/artifacts/view?p=report.md", downloadUrl: "/artifacts/dl?p=report.md" },
    },
    counts: { files: 1, inputBytes: 1, nodes: 1, links: 0 },
  }
  for (const warnings of [
    { retention: "/data/private/stale run could not be removed" },
    { retention: "password=hunter2" },
    { retention: "cleanup deferred", extra: "not in the contract" },
    { retention: "x".repeat(241) },
    ["cleanup deferred"],
  ]) {
    const api = loadDashboardApi(async () => ({
      ok: true,
      status: 200,
      async text() { return JSON.stringify({ ...receipt, warnings }) },
    }))
    await assert.rejects(api.generateGraphify("repo:owner/repo", "dashboard", GRAPHIFY_OPERATION_ID), /invalid graph receipt/)
  }
})

test("Graphify failures name a safe cause without forwarding a private server path", async () => {
  for (const privatePath of [
    "/data/private/code-maps",
    "/var/lib/graphify",
    "C:\\private\\graphify",
    "\\\\server\\share\\graphify",
    "password=hunter2",
    "authorization: Bearer ordinary-secret-value",
    "session: plain-session-secret",
    "service_passphrase=correct horse battery staple",
    'config["accessToken"]="plain-secret"',
  ]) {
    const api = loadDashboardApi(async () => ({
      ok: false,
      status: 500,
      async text() {
        return JSON.stringify({ code: "GRAPHIFY_FAILED", error: `failed under ${privatePath}` })
      },
    }))

    await assert.rejects(
      api.generateGraphify("repo:owner/repo", "dashboard", GRAPHIFY_OPERATION_ID),
      (error) => error instanceof Error
        && /HTTP 500, GRAPHIFY_FAILED/.test(error.message)
        && !error.message.includes(privatePath),
    )
  }

  const busyApi = loadDashboardApi(async () => ({
    ok: false,
    status: 409,
    async text() {
      return JSON.stringify({
        code: "AGENT_LANE_BUSY",
        error: "the shared agent lane is busy running chat for 12s",
      })
    },
  }))
  await assert.rejects(
    busyApi.generateGraphify("repo:owner/repo", "dashboard", GRAPHIFY_OPERATION_ID),
    /HTTP 409, AGENT_LANE_BUSY.*shared agent lane is busy running chat for 12s/,
    "a bounded path-free gate cause remains visible to the operator",
  )
})

test("Graphify rejects malformed artifact links instead of turning server data into navigation", async () => {
  const api = loadDashboardApi(async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        runId: "graphify-run-unsafe",
        target: { id: "repo:owner/repo", label: "AgentHost" },
        folder: { id: "dashboard", label: "Dashboard" },
        snapshot: {
          kind: "git",
          value: "174ef8c98003",
          manifestSha256: "a".repeat(64),
          builtAt: "2026-08-14T12:00:00.000Z",
          derived: true,
        },
        artifacts: {
          html: { name: "graph.html", viewUrl: "/artifacts/view?p=graph.html&v=first&v=second", downloadUrl: "/artifacts/dl?p=graph.html" },
          markdown: { name: "report.md", viewUrl: "/artifacts/view?p=report.md", downloadUrl: "/artifacts/dl?p=report.md" },
        },
        counts: { files: 1, inputBytes: 1, nodes: 1, links: 0 },
      })
    },
  }))

  await assert.rejects(
    api.generateGraphify("repo:owner/repo", "dashboard", GRAPHIFY_OPERATION_ID),
    /invalid graph receipt/,
  )
})

test("an Agent action selects that exact terminal before claiming it is open", () => {
  const work = read("dashboard/components/agenthost/work-view.tsx")
  const command = read("dashboard/components/agenthost/command-center.tsx")
  assert.match(command, /const \[terminalTarget, setTerminalTarget\] = useState<AgentId \| null>\(null\)/)
  assert.match(command, /function openAgentTerminal\(id: AgentId\) \{[\s\S]*setTerminalTarget\(id\)[\s\S]*navigate\("terminal"\)/)
  assert.match(command, /terminalTarget=\{terminalTarget\}/)
  assert.match(command, /onTerminalTargetConsumed=\{\(target\) =>[\s\S]*setTerminalTarget\(\(current\) => current === target \? null : current\)/)
  assert.match(command, /const toastTimer = useRef<ReturnType<typeof setTimeout> \| null>\(null\)/)
  assert.match(command, /const clearToastTimer = useCallback\(\(\) => \{[\s\S]*clearTimeout\(toastTimer\.current\)[\s\S]*toastTimer\.current = null/)
  assert.match(command, /const flash = useCallback\(\(msg: string\) => \{[\s\S]*clearToastTimer\(\)[\s\S]*toastTimer\.current = setTimeout/,
    "a newer terminal result must cancel the older toast expiry before it can clear the current result")
  assert.match(command, /const holdToast = useCallback\(\(msg: string \| null\) => \{[\s\S]*clearToastTimer\(\)[\s\S]*setToast\(msg\)/,
    "a persistent status must cancel any older transient expiry")
  assert.match(command, /useEffect\(\(\) => \(\) => clearToastTimer\(\), \[clearToastTimer\]\)/,
    "unmount must cancel the remaining toast expiry")
  assert.match(work, /terminalTarget\?: AgentId \| null/)
  assert.match(work, /onTerminalTargetConsumed\?: \(target: AgentId\) => void/)
  assert.match(work, /<TerminalView[\s\S]*requestedWindow=\{terminalTarget\}/)
  assert.match(work, /const target = requestedWindow \?\? "shell"/)
  assert.match(work, /if \(target === lastRequestedWindow\.current\) return/)
  assert.match(work, /TERMINAL_WINDOWS\.some\(\(item\) => item\.id === target\)/)
  assert.match(work, /window\.setTimeout\(\(\) => \{[\s\S]*switchTerminal\(\s*target/)
  assert.match(work, /next === requestedWindow[\s\S]*onRequestedWindowConsumed/,
    "a successful manual retry of the exact pending target must consume it too")
  assert.match(work, /\{ id: "shell", label: "Shell" \}/)
})

test("a requested Agent terminal is consumed only after its exact switch, then a later normal Terminal defaults to Shell", async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  const calls = []
  const consumed = []
  try {
    globalThis.window = { setTimeout, clearTimeout }
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init })
      return { ok: true, async text() { return "" } }
    }

    const requested = loadTerminalView()
    requested.render({
      onAction() {},
      requestedWindow: "codex",
      onRequestedWindowConsumed(target) { consumed.push(target) },
    })
    requested.flushEffects()
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(calls.length, 1)
    assert.match(calls[0].url, /\/switch\?window=codex$/)
    assert.equal(calls[0].init.method, "POST")
    assert.deepEqual(consumed, ["codex"], "the exact successful requested switch was not consumed once")

    requested.render({
      onAction() {},
      requestedWindow: null,
      onRequestedWindowConsumed(target) { consumed.push(target) },
    })
    requested.flushEffects()
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(calls.length, 1, "clearing the consumed request immediately switched the open terminal back to Shell")

    const normal = loadTerminalView()
    normal.render({ onAction() {}, requestedWindow: null, onRequestedWindowConsumed() {} })
    normal.flushEffects()
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(calls.length, 2)
    assert.match(calls[1].url, /\/switch\?window=shell$/, "a later normal Terminal inherited the old Agent target")
  } finally {
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
  }
})

test("a failed auto switch stays pending, then a successful exact manual retry consumes it and later Terminal defaults Shell", async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  const consumed = []
  const calls = []
  let attempt = 0
  try {
    globalThis.window = { setTimeout, clearTimeout }
    globalThis.fetch = async (url) => {
      calls.push(String(url))
      attempt += 1
      if (attempt === 1) return { ok: false, status: 503, async text() { return "tmux could not select Codex" } }
      return { ok: true, status: 204, async text() { return "" } }
    }
    const harness = loadTerminalView()
    harness.render({
      onAction() {},
      requestedWindow: "codex",
      onRequestedWindowConsumed(target) { consumed.push(target) },
    })
    harness.flushEffects()
    await new Promise((resolve) => setTimeout(resolve, 10))
    const failed = harness.render({
      onAction() {},
      requestedWindow: "codex",
      onRequestedWindowConsumed(target) { consumed.push(target) },
    })
    assert.deepEqual(consumed, [], "a failed target was incorrectly consumed")
    assert.match(textFrom(failed), /Terminal could not switch.*tmux could not select Codex/i)

    const selector = findNode(failed, (candidate) => candidate.type === "select")
    assert.ok(selector, "the failed terminal has no manual retry selector")
    selector.props.onChange({ target: { value: "codex" } })
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.deepEqual(consumed, ["codex"], "the successful exact manual retry left its request pending")
    assert.equal(calls.length, 2)

    harness.render({ onAction() {}, requestedWindow: null, onRequestedWindowConsumed() {} })
    harness.flushEffects()
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(calls.length, 2, "consuming the manual retry snapped the open terminal back to Shell")

    const normal = loadTerminalView()
    normal.render({ onAction() {}, requestedWindow: null, onRequestedWindowConsumed() {} })
    normal.flushEffects()
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.match(calls[2], /\/switch\?window=shell$/, "a later normal Terminal repeated the stale Agent request")
  } finally {
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
  }
})
