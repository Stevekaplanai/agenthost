import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const DASHBOARD = path.join(ROOT, "dashboard")
const dashboardRequire = createRequire(path.join(DASHBOARD, "package.json"))
const typescript = dashboardRequire("typescript")

function read(...parts) {
  return fs.readFileSync(path.join(ROOT, ...parts), "utf8")
}

function loadBrainModel() {
  const javascript = typescript.transpileModule(read("dashboard", "lib", "brain-model.ts"), {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
    },
  }).outputText
  const loaded = { exports: {} }
  new Function("module", "exports", "require", javascript)(loaded, loaded.exports, dashboardRequire)
  return loaded.exports
}

function loadBrainMemoryView() {
  const react = dashboardRequire("react")
  const javascript = typescript.transpileModule(read("dashboard", "components", "agenthost", "brain-memory.tsx"), {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
      jsx: typescript.JsxEmit.ReactJSX,
    },
  }).outputText
  const loaded = { exports: {} }
  const icon = (props) => react.createElement("span", props)
  const runtime = {
    react,
    "react/jsx-runtime": dashboardRequire("react/jsx-runtime"),
    "react-dom": dashboardRequire("react-dom"),
    "lucide-react": new Proxy({}, { get: () => icon }),
    "@/lib/brain-model": loadBrainModel(),
    "@/lib/utils": { cn: (...values) => values.filter(Boolean).join(" ") },
    "./brain-map": { BrainMap: () => react.createElement("canvas") },
    "./primitives": {
      Btn: ({ children }) => react.createElement("button", null, children),
      MonoLabel: ({ children }) => react.createElement("span", null, children),
      Panel: ({ title, actions, children }) => react.createElement("section", null, title, actions, children),
    },
  }
  const localRequire = (id) => Object.hasOwn(runtime, id) ? runtime[id] : dashboardRequire(id)
  new Function("module", "exports", "require", javascript)(loaded, loaded.exports, localRequire)
  return loaded.exports.BrainMemoryView
}

function loadBrainMap(reactModule = dashboardRequire("react")) {
  const javascript = typescript.transpileModule(read("dashboard", "components", "agenthost", "brain-map.tsx"), {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
      jsx: typescript.JsxEmit.ReactJSX,
    },
  }).outputText
  const loaded = { exports: {} }
  const runtime = {
    react: reactModule,
    "react/jsx-runtime": dashboardRequire("react/jsx-runtime"),
    "@/lib/brain-model": loadBrainModel(),
  }
  const localRequire = (id) => Object.hasOwn(runtime, id) ? runtime[id] : dashboardRequire(id)
  new Function("module", "exports", "require", javascript)(loaded, loaded.exports, localRequire)
  return loaded.exports.BrainMap
}

function createHookReact() {
  const react = dashboardRequire("react")
  const slots = []
  let cursor = 0
  const hookIndex = () => cursor++
  return {
    react: {
      ...react,
      useEffect() {
        hookIndex()
      },
      useMemo(factory) {
        hookIndex()
        return factory()
      },
      useRef(initialValue) {
        const index = hookIndex()
        if (!Object.hasOwn(slots, index)) slots[index] = { current: initialValue }
        return slots[index]
      },
      useState(initialValue) {
        const index = hookIndex()
        if (!Object.hasOwn(slots, index)) {
          slots[index] = typeof initialValue === "function" ? initialValue() : initialValue
        }
        const setValue = (nextValue) => {
          slots[index] = typeof nextValue === "function" ? nextValue(slots[index]) : nextValue
        }
        return [slots[index], setValue]
      },
    },
    beginRender() {
      cursor = 0
    },
  }
}

function findElement(node, predicate) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findElement(child, predicate)
      if (match) return match
    }
    return null
  }
  if (!node || typeof node !== "object") return null
  if (predicate(node)) return node
  return findElement(node.props?.children, predicate)
}

const memories = [
  { id: "alpha", ownerId: "codex", scope: "individual" },
  { id: "bravo", ownerId: "claude", scope: "individual" },
  { id: "charlie", ownerId: "codex", scope: "individual" },
]
const anchors = {
  codex: { x: -145, y: 12, z: 56 },
  claude: { x: 142, y: -8, z: -52 },
}

function legacySeededPoint(memory) {
  let hash = 2166136261
  for (let index = 0; index < memory.id.length; index += 1) {
    hash ^= memory.id.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  let value = hash >>> 0
  const random = () => {
    value = (value * 1664525 + 1013904223) >>> 0
    return value / 4294967296
  }
  if (memory.scope === "shared") {
    const longitude = random() * Math.PI * 2
    const latitude = Math.acos(2 * random() - 1)
    const radius = 28 + random() * 48
    return {
      x: radius * Math.sin(latitude) * Math.cos(longitude),
      y: radius * Math.cos(latitude) * 0.78,
      z: radius * Math.sin(latitude) * Math.sin(longitude),
    }
  }
  const anchor = anchors[memory.ownerId]
  const angle = random() * Math.PI * 2
  const radius = 17 + random() * 29
  return {
    x: anchor.x + Math.cos(angle) * radius,
    y: anchor.y + (random() - 0.5) * 42,
    z: anchor.z + Math.sin(angle) * radius,
  }
}

test("relationship layout is deterministic even when Graphify edge order changes", () => {
  const { layoutBrainGraph } = loadBrainModel()
  const edges = [
    { source: "alpha", target: "bravo", relation: "references", confidence: "EXTRACTED" },
    { source: "bravo", target: "charlie", relation: "supports", confidence: "INFERRED" },
  ]
  const first = layoutBrainGraph(memories, edges, anchors, null)
  const second = layoutBrainGraph(memories, [...edges].reverse(), anchors, null)
  assert.deepEqual(first, second)
})

test("a real edge changes its endpoints while an isolated memory keeps its seeded fallback", () => {
  const { layoutBrainGraph } = loadBrainModel()
  const fallback = layoutBrainGraph(memories, [], anchors, null)
  const connected = layoutBrainGraph(memories, [
    { source: "alpha", target: "bravo", relation: "references", confidence: "EXTRACTED" },
  ], anchors, null)
  const byId = (layout, id) => layout.nodes.find((node) => node.memoryId === id)
  const position = (layout, id) => {
    const node = byId(layout, id)
    return { x: node.x, y: node.y, z: node.z }
  }
  const edgeDistance = (layout) => {
    const alpha = byId(layout, "alpha")
    const bravo = byId(layout, "bravo")
    return Math.hypot(alpha.x - bravo.x, alpha.y - bravo.y, alpha.z - bravo.z)
  }

  assert.notDeepEqual(position(connected, "alpha"), position(fallback, "alpha"))
  assert.notDeepEqual(position(connected, "bravo"), position(fallback, "bravo"))
  assert.ok(edgeDistance(connected) < edgeDistance(fallback))
  assert.deepEqual(byId(connected, "charlie"), byId(fallback, "charlie"))
})

test("isolated individual and shared memories retain the exact former hash coordinates", () => {
  const { layoutBrainGraph } = loadBrainModel()
  const isolated = [...memories, { id: "shared-memory", ownerId: "codex", scope: "shared" }]
  const result = layoutBrainGraph(isolated, [], anchors, null)

  for (const memory of isolated) {
    const node = result.nodes.find((candidate) => candidate.memoryId === memory.id)
    assert.deepEqual({ x: node.x, y: node.y, z: node.z }, legacySeededPoint(memory))
  }
})

test("path-free Graphify node IDs resolve to live memory IDs without leaking source paths", () => {
  const { brainGraphMemoryEdges } = loadBrainModel()
  const resolved = brainGraphMemoryEdges({
    snapshot: "vault@manifest-123",
    nodes: [
      { id: "node-a", memoryId: "alpha" },
      { id: "node-b", memoryId: "bravo" },
    ],
    edges: [
      { source: "node-a", target: "node-b", relation: "references", confidence: "unexpected" },
      { source: "node-a", target: "missing-node", relation: "references", confidence: "EXTRACTED" },
    ],
  }, memories)

  assert.deepEqual(resolved, [{
    source: "alpha",
    target: "bravo",
    relation: "references",
    confidence: "AMBIGUOUS",
  }])
})

test("the bounded renderer keeps a selected memory and its connected neighbors", () => {
  const { layoutBrainGraph } = loadBrainModel()
  const many = Array.from({ length: 110 }, (_, index) => ({
    id: `memory-${index}`,
    ownerId: index % 2 ? "codex" : "claude",
    scope: "individual",
  }))
  const denseEdges = [{ source: "memory-109", target: "memory-108", relation: "selected-neighbor", confidence: "EXTRACTED" }]
  for (let source = 0; source < 40; source += 1) {
    for (let target = source + 1; target < 40; target += 1) {
      denseEdges.push({ source: `memory-${source}`, target: `memory-${target}`, relation: "related", confidence: "INFERRED" })
    }
  }
  const result = layoutBrainGraph(many, denseEdges, anchors, "memory-109")
  const rendered = new Set(result.nodes.map((node) => node.memoryId))

  assert.equal(result.nodes.length, 96)
  assert.equal(result.edges.length, 384)
  assert.equal(rendered.has("memory-109"), true)
  assert.equal(rendered.has("memory-108"), true)
})

test("parallel relations collapse to one strongest-confidence spring and stroke", () => {
  const { layoutBrainGraph } = loadBrainModel()
  const parallel = Array.from({ length: 420 }, (_, index) => ({
    source: "alpha",
    target: "bravo",
    relation: `reference-${index}`,
    confidence: index === 419 ? "EXTRACTED" : index % 2 ? "INFERRED" : "AMBIGUOUS",
  }))
  const dense = layoutBrainGraph(memories, parallel, anchors, "alpha")
  const strongest = layoutBrainGraph(memories, [parallel[419]], anchors, "alpha")

  assert.equal(dense.edges.length, 1)
  assert.equal(dense.edges[0].confidence, "EXTRACTED")
  assert.deepEqual(dense.nodes, strongest.nodes)
})

test("confidence fails closed and maps to visibly distinct canvas dash styles", () => {
  const { brainGraphEdgeStyle, normalizeBrainGraphConfidence } = loadBrainModel()
  const extracted = brainGraphEdgeStyle("EXTRACTED")
  const inferred = brainGraphEdgeStyle("INFERRED")
  const ambiguous = brainGraphEdgeStyle("AMBIGUOUS")

  assert.deepEqual(extracted.dash, [])
  assert.ok(inferred.dash.length > 0)
  assert.ok(ambiguous.dash.length > 0)
  assert.notDeepEqual(inferred.dash, ambiguous.dash)
  assert.ok(extracted.alpha > inferred.alpha)
  assert.ok(inferred.alpha > ambiguous.alpha)
  assert.equal(normalizeBrainGraphConfidence("unrecognized"), "AMBIGUOUS")

  const background = [19, 23, 33]
  const linear = (channel) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  const luminance = (color) => 0.2126 * linear(color[0]) + 0.7152 * linear(color[1]) + 0.0722 * linear(color[2])
  const contrast = (style) => {
    const foreground = style.color.split(",").map((channel) => Number(channel.trim()))
    const rendered = foreground.map((channel, index) => channel * style.alpha + background[index] * (1 - style.alpha))
    return (luminance(rendered) + 0.05) / (luminance(background) + 0.05)
  }
  assert.ok(contrast(inferred) >= 3, `inferred edge contrast was ${contrast(inferred)}`)
  assert.ok(contrast(ambiguous) >= 3, `ambiguous edge contrast was ${contrast(ambiguous)}`)
})

test("the canvas exposes the same relationships semantically", () => {
  const react = dashboardRequire("react")
  const { renderToStaticMarkup } = dashboardRequire("react-dom/server")
  const BrainMap = loadBrainMap()
  const markup = renderToStaticMarkup(react.createElement(BrainMap, {
    agents: [
      { id: "codex", label: "Codex", color: "#ff6a3d", memoryCount: 1 },
      { id: "claude", label: "Claude", color: "#f0b35d", memoryCount: 1 },
    ],
    memories: [
      { id: "alpha", title: "Alpha memory", ownerId: "codex", scope: "individual" },
      { id: "bravo", title: "Bravo memory", ownerId: "claude", scope: "individual" },
    ],
    sharedCount: 0,
    selectedLaneId: null,
    selectedMemoryId: null,
    graph: {
      snapshot: "a".repeat(64),
      nodes: [
        { id: "node-a", memoryId: "alpha" },
        { id: "node-b", memoryId: "bravo" },
      ],
      edges: [{ source: "node-a", target: "node-b", relation: "supports:topic", confidence: "INFERRED" }],
    },
    onSelectLane: () => {},
    onSelectMemory: () => {},
  }))
  const mapSource = read("dashboard", "components", "agenthost", "brain-map.tsx")

  assert.match(markup, /<canvas[^>]+tabindex="0"[^>]+aria-describedby="brain-map-keyboard-help"/)
  assert.match(markup, /<ul[^>]+aria-label="Memory relationships"/)
  assert.match(markup, /Alpha memory[\s\S]*supports:topic[\s\S]*Bravo memory[\s\S]*INFERRED/)
  assert.match(markup, /aria-live="polite"/)
  assert.match(mapSource, /onKeyDown=\{handleCanvasKeyDown\}/)
  assert.match(mapSource, /event\.key === "ArrowRight"[\s\S]*event\.key === "ArrowLeft"/)
  assert.match(mapSource, /event\.key === "Enter" \|\| event\.key === " "/)
  assert.match(mapSource, /onSelectMemory\(target\.id\)/)
  assert.match(mapSource, /onSelectLane\(target\.id\)/)
})

test("the canvas keyboard handler moves focus and selects the exact lane or memory", () => {
  const hooks = createHookReact()
  const BrainMap = loadBrainMap(hooks.react)
  const selected = []
  const props = {
    agents: [
      { id: "codex", label: "Codex", color: "#ff6a3d", memoryCount: 1 },
      { id: "claude", label: "Claude", color: "#f0b35d", memoryCount: 1 },
    ],
    memories: [
      { id: "alpha", title: "Alpha memory", ownerId: "codex", scope: "individual" },
      { id: "bravo", title: "Bravo memory", ownerId: "claude", scope: "individual" },
    ],
    sharedCount: 0,
    selectedLaneId: null,
    selectedMemoryId: null,
    graph: null,
    onSelectLane: (id) => selected.push(["lane", id]),
    onSelectMemory: (id) => selected.push(["memory", id]),
  }
  const renderCanvas = () => {
    hooks.beginRender()
    return findElement(BrainMap(props), (node) => node.type === "canvas")
  }
  const press = (canvas, key) => {
    let prevented = false
    canvas.props.onKeyDown({ key, preventDefault: () => { prevented = true } })
    assert.equal(prevented, true, `${key} should prevent the browser's default canvas action`)
  }

  let canvas = renderCanvas()
  press(canvas, "ArrowRight")
  canvas = renderCanvas()
  press(canvas, "Enter")

  canvas = renderCanvas()
  press(canvas, "End")
  canvas = renderCanvas()
  press(canvas, " ")

  canvas = renderCanvas()
  press(canvas, "Home")
  canvas = renderCanvas()
  press(canvas, "Enter")

  assert.deepEqual(selected, [
    ["lane", "codex"],
    ["memory", "bravo"],
    ["lane", "shared"],
  ])
})

test("Brain draws relationship edges before nodes and exposes a visible legend and snapshot", () => {
  const mapSource = read("dashboard", "components", "agenthost", "brain-map.tsx")
  const panelSource = read("dashboard", "components", "agenthost", "brain.tsx")
  const react = dashboardRequire("react")
  const { renderToStaticMarkup } = dashboardRequire("react-dom/server")
  const BrainMemoryView = loadBrainMemoryView()
  const markup = renderToStaticMarkup(react.createElement(BrainMemoryView, {
    memories: [],
    loading: false,
    problem: null,
    unconfigured: false,
    agents: [],
    graph: {
      snapshot: "vault@manifest-123",
      nodes: [],
      edges: [],
    },
    graphProblem: "graph projection unavailable",
    onAction: () => {},
  }))

  assert.match(mapSource, /setLineDash\(style\.dash\)/)
  assert.ok(mapSource.indexOf("graphEdges.forEach(paintGraphEdge)") < mapSource.indexOf(".forEach(paintMemoryNode)"))
  assert.match(markup, /aria-label="Memory relationship legend"/)
  assert.match(markup, /EXTRACTED/)
  assert.match(markup, /INFERRED/)
  assert.match(markup, /AMBIGUOUS/)
  assert.match(markup, /Snapshot vault@manifest-123/)
  assert.match(markup, /role="status"/)
  assert.match(markup, /relationship map could not refresh/i)
  assert.match(markup, /showing the last verified graph/i)
  assert.match(markup, /graph projection unavailable/)
  assert.match(markup, /Live memory service/)
  assert.doesNotMatch(markup, /Memory service error/)
  assert.match(panelSource, /graph\?: BrainGraphOverlay/)
})
