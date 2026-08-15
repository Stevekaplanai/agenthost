import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (file) => fs.readFileSync(path.join(root, file), "utf8")

function loadLiveModule() {
  const source = read("dashboard/lib/live.ts")
  const dashboardRequire = createRequire(path.join(root, "dashboard", "package.json"))
  const typescript = dashboardRequire("typescript")
  const javascript = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
      jsx: typescript.JsxEmit.ReactJSX,
    },
  }).outputText
  const loaded = { exports: {} }
  const localRequire = (id) => {
    if (id === "react") return dashboardRequire("react")
    if (id === "./api" || id === "./agenthost-data") return new Proxy({}, { get: () => undefined })
    return dashboardRequire(id)
  }
  new Function("module", "exports", "require", javascript)(loaded, loaded.exports, localRequire)
  return loaded.exports
}

test("durable Stop selects running work before cancelling and the oldest queued run", () => {
  const { selectActiveChatRunId } = loadLiveModule()
  const run = (id, status, createdAt, startedAt = null) => ({ id, status, createdAt, startedAt })

  assert.equal(selectActiveChatRunId([
    run("queued-new", "queued", 40),
    run("running", "running", 10, 20),
    run("queued-old", "queued", 5),
  ]), "running")
  assert.equal(selectActiveChatRunId([
    run("queued", "queued", 5),
    run("cancelling", "cancelling", 10, 20),
  ]), "cancelling")
  assert.equal(selectActiveChatRunId([
    run("queued-new", "queued", 40),
    run("queued-old", "queued", 5),
  ]), "queued-old")
})

test("the live chat hook cancels the active durable run through the gate", () => {
  const api = read("dashboard/lib/api.ts")
  const live = read("dashboard/lib/live.ts")

  assert.match(api, /export function cancelChatRun/)
  assert.match(api, /export function fetchChatRuns/)
  assert.match(api, /getJson\("\/chat\/runs"\)/)
  assert.match(api, /\/chat\/runs\/\$\{encodeURIComponent\(runId\)\}\/cancel/)
  assert.match(live, /activeRunId: string \| null/)
  assert.match(live, /cancel: \(\) => Promise<string \| null>/)
  assert.match(live, /await cancelChatRun\(effectiveActiveRunId\)/)
  assert.match(live, /usePolled\(fetchChatRuns/)
  assert.match(live, /selectActiveChatRunId\(runData\?\.runs \?\? \[\]\)/)
  assert.match(live, /handle\?\.close\(\)/)
  assert.match(live, /activeFinish\.current = finish/)
  assert.match(live, /localFinish\(result\.summary\)/)
})

test("one shared synchronous send lock prevents duplicate metered chat starts", () => {
  const live = read("dashboard/lib/live.ts")
  const workspace = read("dashboard/components/agenthost/workspace-chat.tsx")
  const rail = read("dashboard/components/agenthost/thread-rail.tsx")

  assert.match(live, /send: \(text: string, engine\?: string\) => boolean/)
  assert.match(live, /const sendInFlight = useRef\(false\)/)
  assert.match(live, /if \(sendInFlight\.current\) return false[\s\S]*sendInFlight\.current = true/)
  assert.match(live, /const finish = [\s\S]*sendInFlight\.current = false/)
  assert.match(live, /catch \(failure: unknown\) \{[\s\S]*sendInFlight\.current = false[\s\S]*return false/)
  for (const composer of [workspace, rail]) {
    assert.match(composer, /onSend: \(text: string, engine\?: string\) => boolean/)
    assert.match(composer, /if \(!onSend\(trimmed, routeFromText\(trimmed, engine\)\)\) return[\s\S]*setValue\(""\)/)
  }
})

test("both reachable chat composers stage one locked Stop consequence", () => {
  const workspace = read("dashboard/components/agenthost/workspace-chat.tsx")
  const rail = read("dashboard/components/agenthost/thread-rail.tsx")
  const command = read("dashboard/components/agenthost/command-center.tsx")

  for (const source of [workspace, rail]) {
    assert.match(source, /aria-label="Stop active run"/)
    assert.match(source, /min-h-11/)
    assert.match(source, /onCancel/)
    assert.match(source, /setCancelReviewOpen\(true\)/)
  }
  assert.match(workspace, /title="Stop this agent run\?"/)
  assert.match(workspace, /Nothing stops until you confirm/)
  assert.match(workspace, /const inFlight = useRef\(false\)/)
  assert.match(workspace, /if \(inFlight\.current\) return/)
  assert.match(workspace, /Keep running[\s\S]*Confirm stop/)
  assert.match(workspace, /role="alert"[\s\S]*The run was not stopped/)
  assert.match(command, /onCancel=\{chat\.cancel\}/)
  assert.match(command, /activeRunEngine=\{chat\.activeRunEngine\}/)
})
