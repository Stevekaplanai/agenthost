import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.join(process.cwd(), "dashboard")
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), "utf8")
const dashboardRequire = createRequire(path.join(ROOT, "package.json"))

function loadBrandContract() {
  const typescript = dashboardRequire("typescript")
  const javascript = typescript.transpileModule(read("lib", "brand.ts"), {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
    },
  }).outputText
  const loaded = { exports: {} }
  new Function("module", "exports", javascript)(loaded, loaded.exports)
  return loaded.exports
}

function withDocument(documentValue, callback) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document")
  if (documentValue === undefined) delete globalThis.document
  else Object.defineProperty(globalThis, "document", { configurable: true, value: documentValue })
  try {
    return callback()
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous)
    else delete globalThis.document
  }
}

test("the buyer brand is fixed synchronously from the server-stamped body", () => {
  const source = read("lib", "brand.ts")
  const { DEFAULT_BUYER_BRAND, getBuyerBrand } = loadBrandContract()

  assert.equal(DEFAULT_BUYER_BRAND.name, "AgentHost")
  assert.equal(withDocument(undefined, () => getBuyerBrand().name), "AgentHost")
  assert.equal(
    withDocument({ body: { dataset: { brand: "legal" } } }, () => getBuyerBrand().name),
    "Legal Skills HQ",
  )
  assert.equal(
    withDocument({ body: { dataset: { brand: "dev" } } }, () => getBuyerBrand().name),
    "AgentHost",
  )

  assert.match(source, /document\.body\.dataset\.brand === ["']legal["']/)
  assert.doesNotMatch(source, /fetch\(|useEffect|useState|localStorage|sessionStorage/,
    "the first client render must not wait for a request, effect, or cached browser choice")
})

test("layout metadata comes from the same buyer-brand contract", () => {
  const layout = read("app", "layout.tsx")
  assert.match(layout, /import \{ DEFAULT_BUYER_BRAND \} from ["']@\/lib\/brand["']/)
  assert.match(layout, /title: `\$\{DEFAULT_BUYER_BRAND\.workspaceName\} \| Your governed agent team`/)
  assert.match(layout, /title: DEFAULT_BUYER_BRAND\.name/)
  assert.doesNotMatch(layout, /title: ["']AgentHost|title: ["']Legal Skills HQ/)
})

test("buyer-facing dashboard labels resolve through the boot brand instead of hard-coded AgentHost copy", () => {
  const files = [
    ["components", "agenthost", "sidebar.tsx"],
    ["components", "agenthost", "top-bar.tsx"],
    ["components", "agenthost", "shell-dialogs.tsx"],
    ["components", "agenthost", "settings.tsx"],
    ["components", "agenthost", "push-notification-settings.tsx"],
    ["components", "agenthost", "room-view.tsx"],
    ["components", "agenthost", "work-view.tsx"],
    ["components", "agenthost", "agents-view.tsx"],
  ]
  const forbiddenPrimaryCopy = /(?:>AgentHost<|Search AgentHost|AgentHost Workspace|AgentHost terminal|AgentHost has no working route|want AgentHost to|another AgentHost box|AgentHost task and agent alerts|outside AgentHost|AgentHost will ask|while AgentHost is closed|receiving AgentHost alerts|Make AgentHost the place)/

  for (const parts of files) {
    const source = read(...parts)
    const label = parts.at(-1)
    assert.match(source, /getBuyerBrand/, `${label} does not read the boot-fixed buyer brand`)
    assert.doesNotMatch(source, forbiddenPrimaryCopy, `${label} still hard-codes AgentHost as the buyer brand`)
    assert.doesNotMatch(source, /Legal Skills HQ/, `${label} duplicated the legal brand instead of using the contract`)
  }
})
