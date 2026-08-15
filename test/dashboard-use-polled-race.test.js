import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import vm from "node:vm"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const ts = require(path.join(root, "dashboard", "node_modules", "typescript"))

function deferred() {
  let resolve
  let reject
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

function sameDeps(left, right) {
  return left?.length === right?.length && left.every((value, index) => Object.is(value, right[index]))
}

function createHookHarness(api = {}) {
  const slots = []
  let cursor = 0
  let pendingEffects = []
  let stateWrites = 0
  let nextIntervalId = 1
  const intervals = new Map()

  const react = {
    useState(initial) {
      const index = cursor++
      if (!slots[index]) {
        const slot = { value: typeof initial === "function" ? initial() : initial }
        slot.set = (next) => {
          stateWrites += 1
          slot.value = typeof next === "function" ? next(slot.value) : next
        }
        slots[index] = slot
      }
      return [slots[index].value, slots[index].set]
    },
    useRef(initial) {
      const index = cursor++
      if (!slots[index]) slots[index] = { current: initial }
      return slots[index]
    },
    useCallback(callback, deps) {
      const index = cursor++
      if (!slots[index] || !sameDeps(slots[index].deps, deps)) slots[index] = { callback, deps }
      return slots[index].callback
    },
    useEffect(effect, deps) {
      const index = cursor++
      pendingEffects.push({ index, effect, deps })
    },
  }

  const listeners = new Map()
  const document = {
    visibilityState: "visible",
    addEventListener(name, handler) {
      listeners.set(name, handler)
    },
    removeEventListener(name, handler) {
      if (listeners.get(name) === handler) listeners.delete(name)
    },
  }

  const source = fs.readFileSync(path.join(root, "dashboard", "lib", "live.ts"), "utf8")
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require(id) {
      if (id === "react") return react
      if (id === "./agenthost-data") return { ROSTER: [] }
      if (id === "./api") return api
      throw new Error(`Unexpected module in usePolled test: ${id}`)
    },
    document,
    setInterval(callback) {
      const id = nextIntervalId++
      intervals.set(id, callback)
      return id
    },
    clearInterval(id) { intervals.delete(id) },
    setTimeout,
    clearTimeout,
    Date,
    Error,
  })
  const usePolled = module.exports.usePolled
  const useMemories = module.exports.useMemories
  const useBrainGraph = module.exports.useBrainGraph
  const useMesh = module.exports.useMesh
  const useMultiLoops = module.exports.useMultiLoops

  function render(load, enabled) {
    cursor = 0
    pendingEffects = []
    const result = usePolled(load, 10_000, enabled)
    for (const next of pendingEffects) {
      const previous = slots[next.index]
      if (previous && sameDeps(previous.deps, next.deps)) continue
      previous?.cleanup?.()
      slots[next.index] = { deps: next.deps, cleanup: next.effect() }
    }
    return result
  }

  function renderMemories() {
    cursor = 0
    pendingEffects = []
    const result = useMemories()
    for (const next of pendingEffects) {
      const previous = slots[next.index]
      if (previous && sameDeps(previous.deps, next.deps)) continue
      previous?.cleanup?.()
      slots[next.index] = { deps: next.deps, cleanup: next.effect() }
    }
    return result
  }

  function renderBrain() {
    cursor = 0
    pendingEffects = []
    const memories = useMemories()
    const graph = useBrainGraph()
    for (const next of pendingEffects) {
      const previous = slots[next.index]
      if (previous && sameDeps(previous.deps, next.deps)) continue
      previous?.cleanup?.()
      slots[next.index] = { deps: next.deps, cleanup: next.effect() }
    }
    return { memories, graph }
  }

  function renderMesh() {
    cursor = 0
    pendingEffects = []
    const result = useMesh()
    for (const next of pendingEffects) {
      const previous = slots[next.index]
      if (previous && sameDeps(previous.deps, next.deps)) continue
      previous?.cleanup?.()
      slots[next.index] = { deps: next.deps, cleanup: next.effect() }
    }
    return result
  }

  function renderMultiLoops() {
    cursor = 0
    pendingEffects = []
    const result = useMultiLoops()
    for (const next of pendingEffects) {
      const previous = slots[next.index]
      if (previous && sameDeps(previous.deps, next.deps)) continue
      previous?.cleanup?.()
      slots[next.index] = { deps: next.deps, cleanup: next.effect() }
    }
    return result
  }

  return {
    render,
    renderMemories,
    renderBrain,
    renderMesh,
    renderMultiLoops,
    unmount() {
      for (const slot of slots) slot?.cleanup?.()
    },
    stateWriteCount() {
      return stateWrites
    },
    tickIntervals() {
      for (const callback of [...intervals.values()]) callback()
    },
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

test("usePolled lets only the latest request update success or error and invalidates pending work when disabled", async () => {
  const calls = []
  const load = () => {
    const call = deferred()
    calls.push(call)
    return call.promise
  }
  const hook = createHookHarness()

  let state = hook.render(load, true)
  state.refetch()
  calls[1].resolve("new success")
  await flush()
  state = hook.render(load, true)
  assert.equal(state.data, "new success")
  assert.equal(state.error, null)

  calls[0].reject(new Error("stale error"))
  await flush()
  state = hook.render(load, true)
  assert.equal(state.data, "new success")
  assert.equal(state.error, null)

  state.refetch()
  state.refetch()
  calls[3].reject(new Error("new error"))
  await flush()
  state = hook.render(load, true)
  assert.equal(state.data, "new success")
  assert.equal(state.error, "new error")

  calls[2].resolve("stale success")
  await flush()
  state = hook.render(load, true)
  assert.equal(state.data, "new success")
  assert.equal(state.error, "new error")

  state.refetch()
  hook.render(load, false)
  state = hook.render(load, true)
  calls[5].resolve("reenabled success")
  await flush()
  calls[4].resolve("disabled stale success")
  await flush()
  state = hook.render(load, true)
  assert.equal(state.data, "reenabled success")
  assert.equal(state.error, null)

  state.refetch()
  state.setData("saved mutation")
  calls[6].resolve("stale poll before mutation")
  await flush()
  state = hook.render(load, true)
  assert.equal(state.data, "saved mutation", "a pending poll overwrote a completed server mutation")
  assert.equal(state.error, null)
})

test("usePolled coalesces interval work so a response slower than its cadence still commits", async () => {
  const calls = []
  const load = () => {
    const call = deferred()
    calls.push(call)
    return call.promise
  }
  const hook = createHookHarness()

  let state = hook.render(load, true)
  await flush()
  assert.equal(calls.length, 1)
  hook.tickIntervals()
  hook.tickIntervals()
  assert.equal(calls.length, 1, "intervals started newer requests while the slow poll was still running")

  calls[0].resolve("slow but current")
  await flush()
  state = hook.render(load, true)
  assert.equal(state.data, "slow but current")
  assert.equal(state.error, null)

  hook.tickIntervals()
  await flush()
  assert.equal(calls.length, 2, "the next interval did not resume after the slow poll settled")
  hook.tickIntervals()
  assert.equal(calls.length, 2)
  calls[1].resolve("second slow success")
  await flush()
  state = hook.render(load, true)
  assert.equal(state.data, "second slow success")
})

test("useMemories keeps the newest save or ingest refresh when an older response settles later", async () => {
  class BrainNotConfigured extends Error {}
  const calls = []
  const fetchMemories = () => {
    const call = deferred()
    calls.push(call)
    return call.promise
  }
  const hook = createHookHarness({ BrainNotConfigured, fetchMemories })

  let state = hook.renderMemories()
  state.refetch() // the refresh issued after a successful save
  calls[1].resolve([{ id: "fresh-after-save" }])
  await flush()
  state = hook.renderMemories()
  assert.deepEqual(state.items, [{ id: "fresh-after-save" }])
  assert.equal(state.problem, null)

  calls[0].resolve([{ id: "stale-before-save" }])
  await flush()
  state = hook.renderMemories()
  assert.deepEqual(state.items, [{ id: "fresh-after-save" }])
  assert.equal(state.problem, null)

  state.refetch()
  state.refetch() // the refresh issued after a successful ingest
  calls[3].resolve([{ id: "fresh-after-ingest" }])
  await flush()
  state = hook.renderMemories()
  assert.deepEqual(state.items, [{ id: "fresh-after-ingest" }])
  assert.equal(state.problem, null)
  assert.equal(state.unconfigured, false)

  calls[2].reject(new BrainNotConfigured("stale brain configuration error"))
  await flush()
  state = hook.renderMemories()
  assert.deepEqual(state.items, [{ id: "fresh-after-ingest" }])
  assert.equal(state.problem, null)
  assert.equal(state.unconfigured, false)

  state.refetch()
  const writesBeforeUnmount = hook.stateWriteCount()
  hook.unmount()
  calls[4].resolve([{ id: "settled-after-unmount" }])
  await flush()
  assert.equal(hook.stateWriteCount(), writesBeforeUnmount)
})

test("useBrainGraph failures and refreshes cannot clobber the independent memory stream", async () => {
  class BrainNotConfigured extends Error {}
  const memoryCalls = []
  const graphCalls = []
  const hook = createHookHarness({
    BrainNotConfigured,
    fetchMemories() {
      const call = deferred()
      memoryCalls.push(call)
      return call.promise
    },
    fetchBrainGraph() {
      const call = deferred()
      graphCalls.push(call)
      return call.promise
    },
  })

  let state = hook.renderBrain()
  graphCalls[0].reject(new Error("graph projection unavailable"))
  memoryCalls[0].resolve([{ id: "memory-first" }])
  await flush()
  state = hook.renderBrain()
  assert.deepEqual(state.memories.items, [{ id: "memory-first" }])
  assert.equal(state.memories.problem, null)
  assert.equal(state.graph.graph, null)
  assert.equal(state.graph.problem, "graph projection unavailable")

  state.memories.refetch()
  state.graph.refetch()
  memoryCalls[1].reject(new Error("memory refresh failed"))
  graphCalls[1].resolve({ graph: { snapshot: "a".repeat(64), nodes: [], edges: [] } })
  await flush()
  state = hook.renderBrain()
  assert.deepEqual(state.memories.items, [{ id: "memory-first" }], "graph success replaced the last proven memories")
  assert.equal(state.memories.problem, "memory refresh failed")
  assert.equal(state.graph.graph.snapshot, "a".repeat(64))
  assert.equal(state.graph.problem, null)

  state.memories.refetch()
  state.graph.refetch()
  graphCalls[2].reject(new Error("new graph failure"))
  memoryCalls[2].resolve([{ id: "memory-newest" }])
  await flush()
  state = hook.renderBrain()
  assert.deepEqual(state.memories.items, [{ id: "memory-newest" }], "graph failure blocked the memory refresh")
  assert.equal(state.memories.problem, null)
  assert.equal(state.graph.graph.snapshot, "a".repeat(64), "graph failure erased the last proven overlay")
  assert.equal(state.graph.problem, "new graph failure")
})

test("useMesh commits only its newest observation and invalidates pending work on unmount", async () => {
  const calls = []
  const fetchMesh = () => {
    const call = deferred()
    calls.push(call)
    return call.promise
  }
  const hook = createHookHarness({ fetchMesh })

  let state = hook.renderMesh()
  state.refetch()
  calls[1].resolve({ status: "LIVE", peers: [] })
  await flush()
  state = hook.renderMesh()
  assert.equal(state.mesh.status, "LIVE")
  assert.equal(state.problem, null)

  calls[0].reject(new Error("stale LOCKED observation"))
  await flush()
  state = hook.renderMesh()
  assert.equal(state.mesh.status, "LIVE")
  assert.equal(state.problem, null)

  state.refetch()
  state.refetch()
  calls[3].reject(new Error("current mesh cause"))
  await flush()
  calls[2].resolve({ status: "LOCKED", peers: [] })
  await flush()
  state = hook.renderMesh()
  assert.equal(state.mesh.status, "LIVE", "an older Mesh success replaced the latest observed data")
  assert.equal(state.problem, "current mesh cause")

  state.refetch()
  const writesBeforeUnmount = hook.stateWriteCount()
  hook.unmount()
  calls[4].resolve({ status: "LIVE", peers: [{ id: "late" }] })
  await flush()
  assert.equal(hook.stateWriteCount(), writesBeforeUnmount)
})

test("Multi-Loop manual history wins per job without clearing a different job's current cause", async () => {
  const jobsCalls = []
  const runCalls = []
  const fetchMultiLoopJobs = () => {
    const call = deferred()
    jobsCalls.push(call)
    return call.promise
  }
  const fetchMultiLoopRuns = (id) => {
    const call = { id, ...deferred() }
    runCalls.push(call)
    return call.promise
  }
  const hook = createHookHarness({ fetchMultiLoopJobs, fetchMultiLoopRuns })

  let state = hook.renderMultiLoops()
  jobsCalls[0].resolve({ jobs: [{ id: "A" }, { id: "B" }] })
  await flush()
  state = hook.renderMultiLoops()
  assert.deepEqual(runCalls.map(({ id }) => id), ["A", "B"])

  const manualA = state.loadRuns("A")
  assert.deepEqual(runCalls.map(({ id }) => id), ["A", "B", "A"])
  runCalls[0].resolve({ runs: [{ id: "stale-A1" }] })
  runCalls[1].reject(new Error("B history is unavailable"))
  await flush()
  await flush()
  state = hook.renderMultiLoops()
  assert.equal(state.problem, "B history is unavailable")
  assert.equal(state.runsByJob.A, undefined, "the stale batch result overwrote a newer A request")

  runCalls[2].resolve({ runs: [{ id: "fresh-A2" }] })
  assert.equal(await manualA, null)
  await flush()
  state = hook.renderMultiLoops()
  assert.deepEqual(state.runsByJob.A, [{ id: "fresh-A2" }])
  assert.equal(state.problem, "B history is unavailable", "A success cleared B's current failure")

  state.refetch()
  jobsCalls[1].resolve({ jobs: [{ id: "A" }, { id: "B" }] })
  await flush()
  state = hook.renderMultiLoops()
  const manualRetryA = state.loadRuns("A")
  const secondBatchA = runCalls[3]
  const secondBatchB = runCalls[4]
  const secondManualA = runCalls[5]
  secondManualA.resolve({ runs: [{ id: "fresh-A4" }] })
  assert.equal(await manualRetryA, null)
  secondBatchA.resolve({ runs: [{ id: "stale-A3" }] })
  secondBatchB.resolve({ runs: [{ id: "fresh-B2" }] })
  await flush()
  await flush()
  state = hook.renderMultiLoops()
  assert.deepEqual(state.runsByJob.A, [{ id: "fresh-A4" }], "the older batch replaced manual A history")
  assert.deepEqual(state.runsByJob.B, [{ id: "fresh-B2" }])
  assert.equal(state.problem, null)
})
