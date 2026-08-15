// The team room must paint replies in ROSTER order, not completion order.
//
// The gate has emitted a `roster` SSE event since 2026-08-02 precisely so the
// client can reserve one slot per engine before anything runs. Nothing in
// dashboard/ ever listened for it, and EventSource drops unhandled named events
// SILENTLY -- no error, no warning -- so the server-side half of that fix sat
// shipped and inert for hundreds of commits while the room kept reading
// "gemini, kimi, ..." because the API engines answer in seconds and every delta
// was appended to one shared bubble in arrival order.
//
// Steve, 2026-08-13: "still there from hundreds of commits ago the order they
// reply is wrong. Gemini goes then Kimi. That's not the right order."

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

// THE REGRESSION ITSELF. A listener that is not registered fails silently, so
// this asserts the registration rather than any downstream rendering.
test("the chat stream registers a roster listener, because EventSource drops unhandled events silently", () => {
  const api = read("dashboard/lib/api.ts")
  assert.match(api, /addEventListener\("roster"/,
    "the gate emits `roster` before any engine runs; without this listener the client can only paint in completion order")
  assert.match(api, /kind:\s*"roster"/,
    "the event kind must exist on ChatStreamEvent or the handler cannot narrow to it")

  // Every event the gate emits on this stream should have a listener. A new one
  // added server-side with no client listener is the exact defect above.
  for (const kind of ["status", "roster", "engine", "engine_delta", "engine_done", "done"]) {
    assert.match(api, new RegExp(`addEventListener\\("${kind}"`), `no listener for the ${kind} event`)
  }
})

test("the roster handler reserves one slot per engine in the order the gate sent", () => {
  const live = read("dashboard/lib/live.ts")
  const handler = live.slice(live.indexOf('ev.kind === "roster"'), live.indexOf('ev.kind === "engine_delta"'))
  assert.notEqual(handler.length, 0, "the roster branch is gone")
  // Slots are built by mapping the gate's array, so the order is the gate's.
  assert.match(handler, /engines\.map\(/, "slots must be derived from the roster array, preserving its order")
  assert.match(handler, /pending:\s*true/,
    "a reserved slot must render as PENDING -- an engine that has not started is otherwise absent, which is indistinguishable from one that is never coming")
  assert.match(handler, /agentId:/,
    "reserved bubbles must carry the engine id so they render with the same identity as persisted replies")
})

test("live reply ids are the exact ids the durable transcript will persist", () => {
  const { replyTurnId, engineTurnId, engineTurnTarget } = loadLiveModule()
  const run = "durable-run-1786612842"

  assert.equal(replyTurnId(run), `${run}-r`, "a directed reply dedupes against <runId>-r")
  assert.equal(engineTurnId(run, "claude"), `${run}-r-claude`,
    "a team reply dedupes against <runId>-r-<engine>")

  // The gate sends an engine ID on most paths and a display LABEL on one, so
  // routing is case-insensitive; otherwise "Gemini" would miss the "gemini" slot
  // and its text would fall back into the shared bubble, losing the ordering.
  assert.equal(engineTurnTarget("gemini", run), engineTurnId(run, "gemini"))
  assert.equal(engineTurnTarget("Gemini", run), engineTurnId(run, "gemini"))
  assert.equal(engineTurnTarget("  KIMI  ", run), engineTurnId(run, "kimi"))

  // Distinct engines never collide, or two engines would share one bubble and
  // the ordering fix would be undone by the routing.
  const ids = ["claude", "codex", "hermes", "gemini", "kimi", "cursor"].map((id) => engineTurnId(run, id))
  assert.equal(new Set(ids).size, ids.length)

  // Teardown matches on the durable reply prefix. Every reserved slot must be
  // swept when the run ends, or an unfinished slot animates its ellipsis forever.
  for (const id of ids) assert.ok(id.startsWith(`${replyTurnId(run)}-`), `${id} would survive teardown`)
  // ...and the sweep must not reach a DIFFERENT run's slots.
  assert.equal(engineTurnId("different-run", "claude").startsWith(`${replyTurnId(run)}-`), false)
})

test("a successful streamed reply stops pending while the durable poll catches up", () => {
  const { replyTurnId, engineTurnId, settleChatRunMessages } = loadLiveModule()
  const run = "durable-run-lifecycle"
  const directed = {
    id: replyTurnId(run), author: "Claude", at: 1, time: "", body: "Done.",
    source: "box", pending: true, eventKind: "agent", targets: [],
  }
  const team = {
    ...directed, id: engineTurnId(run, "codex"), author: "Codex", body: "Reviewed.",
  }
  const empty = { ...directed, id: engineTurnId(run, "kimi"), author: "Kimi", body: "" }
  const unrelated = { ...directed, id: replyTurnId("other-run"), body: "Still running." }

  const settled = settleChatRunMessages([directed, team, empty, unrelated], replyTurnId(run))
  assert.equal(settled.find((message) => message.id === directed.id)?.pending, false,
    "a nonblank directed reply must not keep animating after done")
  assert.equal(settled.find((message) => message.id === team.id)?.pending, false,
    "a nonblank team slot must not keep animating after done")
  assert.equal(settled.some((message) => message.id === empty.id), false,
    "an empty unused reservation is removed on successful completion")
  assert.equal(settled.find((message) => message.id === unrelated.id)?.pending, true,
    "settling one run cannot change another run")
})
