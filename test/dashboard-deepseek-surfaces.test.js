import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const dashboardRequire = createRequire(path.join(root, "dashboard", "package.json"))
const typescript = dashboardRequire("typescript")
const read = (file) => fs.readFileSync(path.join(root, file), "utf8")
const ENGINE_ORDER = ["claude", "codex", "deepseek", "kimi", "gemini", "hermes", "cursor"]

function loadTypeScript(file) {
  const javascript = typescript.transpileModule(read(file), {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
      jsx: typescript.JsxEmit.ReactJSX,
    },
  }).outputText
  const loaded = { exports: {} }
  new Function("module", "exports", "require", javascript)(loaded, loaded.exports, dashboardRequire)
  return loaded.exports
}

function loadApi(fetchImpl) {
  const javascript = typescript.transpileModule(read("dashboard/lib/api.ts"), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 },
  }).outputText
  const loaded = { exports: {} }
  new Function("module", "exports", "require", "process", "fetch", javascript)(
    loaded,
    loaded.exports,
    dashboardRequire,
    process,
    fetchImpl,
  )
  return loaded.exports
}

test("one client roster defines the exact seven-engine product order", () => {
  const data = loadTypeScript("dashboard/lib/agenthost-data.ts")
  assert.deepEqual(data.ENGINE_ORDER, ENGINE_ORDER)
  assert.deepEqual(data.ROSTER.map(({ id }) => id), ENGINE_ORDER)
  assert.equal(data.ROSTER.find(({ id }) => id === "deepseek")?.name, "DeepSeek")
  assert.match(data.AGENT_COLORS.deepseek, /deepseek/)
})

test("DeepSeek and Kimi are first-class Settings and Agents engines while Cursor stays human-directed", () => {
  const api = read("dashboard/lib/api.ts")
  const settings = read("dashboard/components/agenthost/settings.tsx")
  const agents = read("dashboard/components/agenthost/agents-view.tsx")
  const multi = read("dashboard/components/agenthost/multi-loops.tsx")

  assert.match(api, /SettingsEngineId\s*=\s*"claude"\s*\|\s*"codex"\s*\|\s*"deepseek"\s*\|\s*"kimi"\s*\|\s*"gemini"\s*\|\s*"hermes"\s*\|\s*"cursor"/)
  assert.match(api, /deepseek:\s*\{[\s\S]*?limits:\s*\{\s*perRunUsd:\s*number;\s*perDayUsd:\s*number/)

  assert.match(settings, /ENGINE_ORDER\.map\(/, "Settings must render the shared order rather than a second hand-written roster")
  assert.match(settings, /agents\.deepseek\.limits\.perRunUsd/)
  assert.match(settings, /agents\.deepseek\.limits\.perDayUsd/)
  assert.match(settings, /llm\.roster\.kimi\.active/)
  assert.match(settings, /chat-only and human-directed/i)
  assert.match(settings, /id\s*===\s*"cursor"/)

  assert.match(agents, /deepseek:\s*\{/)
  assert.match(agents, /ENGINE_ORDER\.includes\(id\)/)
  assert.match(agents, /chat-only and human-directed/i)
  assert.match(agents, /never receives unattended/i)

  assert.match(multi, /Object\.entries\(data\?\.engines\s*\?\?\s*\{\}\)/,
    "Multi must render the server-provided engine map without dropping Kimi")
  assert.doesNotMatch(read("dashboard/lib/agenthost-data.ts"), /DeepSeek[\s\S]{0,240}Engineering \+ review/)
  assert.doesNotMatch(agents, /deepseek[\s\S]{0,400}second review/i)
})

test("DeepSeek appears in terminal and Brain through the shared roster", () => {
  const work = read("dashboard/components/agenthost/work-view.tsx")
  const css = read("dashboard/app/globals.css")
  const data = loadTypeScript("dashboard/lib/agenthost-data.ts")
  const brain = loadTypeScript("dashboard/lib/brain-model.ts")

  assert.match(work, /ROSTER\.map\(/, "terminal choices must follow the shared product order")
  assert.match(css, /--color-deepseek:\s*var\(--deepseek\)/)
  assert.match(css, /--deepseek:\s*#[0-9a-f]{6}/i)

  const lanes = brain.buildBrainLanes([], data.ROSTER)
  assert.deepEqual(lanes.slice(1).map(({ agent }) => agent), ENGINE_ORDER,
    "Brain must preserve the exact seven-engine product order")
  assert.ok(lanes.some(({ agent, label }) => agent === "deepseek" && label === "DeepSeek"))
  assert.match(lanes.find(({ agent }) => agent === "deepseek").color, /^#[0-9a-f]{6}$/i)
})

test("DELETE /secret sends only the name and requires an exact deletion receipt", async () => {
  const requests = []
  const api = loadApi(async (url, options) => {
    requests.push({ url, options })
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, name: "DEEPSEEK_API_KEY", deleted: true }),
    }
  })

  assert.deepEqual(await api.deleteBoxSecret(" deepseek_api_key "), {
    ok: true,
    name: "DEEPSEEK_API_KEY",
    deleted: true,
  })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, "/secret")
  assert.equal(requests[0].options.method, "DELETE")
  assert.deepEqual(JSON.parse(requests[0].options.body), { name: "DEEPSEEK_API_KEY" })
  assert.equal(JSON.parse(requests[0].options.body).value, undefined)

  await assert.rejects(
    loadApi(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, name: "OTHER_KEY", deleted: true }),
    })).deleteBoxSecret("DEEPSEEK_API_KEY"),
    /did not confirm removing DEEPSEEK_API_KEY/,
  )
  await assert.rejects(api.deleteBoxSecret("GIT_PUSH_TOKEN"), /gate-only/)
  assert.equal(requests.length, 1, "a protected secret name must be rejected before any request")
})
