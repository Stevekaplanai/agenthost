import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const ROOT = path.join(process.cwd(), "dashboard");
const dashboardRequire = createRequire(path.join(ROOT, "package.json"));
const { projectGraphifyBrainOverlay } = createRequire(import.meta.url)("../container/graphify-brain.js");
const read = (...parts) => {
  const file = path.join(ROOT, ...parts);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
};

function loadApi(fetchImpl) {
  const typescript = dashboardRequire("typescript");
  const javascript = typescript.transpileModule(read("lib", "api.ts"), {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
    },
  }).outputText;
  const loaded = { exports: {} };
  new Function("module", "exports", "require", "fetch", javascript)(
    loaded,
    loaded.exports,
    dashboardRequire,
    fetchImpl,
  );
  return loaded.exports;
}

function jsonResponse(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async text() { return JSON.stringify(payload); },
  };
}

const brain = read("components", "agenthost", "brain.tsx");
const map = read("components", "agenthost", "brain-map.tsx");
const memory = read("components", "agenthost", "brain-memory.tsx");
const commandCenter = read("components", "agenthost", "command-center.tsx");
const primitives = read("components", "agenthost", "primitives.tsx");
const live = read("lib", "live.ts");

test("the recovered Brain consumes only the live useMemories payload while its room is active", () => {
  assert.match(commandCenter, /const brain = useMemories\(nav === "brain"\)/);
  assert.match(commandCenter, /memories=\{brain\.items\}/);
  assert.match(brain, /<BrainMemoryView[\s\S]*memories=\{memories \?\? \[\]\}/);
  assert.match(memory, /memories:\s*readonly Memory\[\]/);
  assert.doesNotMatch(memory, /\bfetch\s*\(/);
  assert.doesNotMatch(memory, /DEMO_MEMOR|fixture memor|prototype records/i);
});

test("Brain Graphify is a separate room-scoped stream and refreshes without replacing memory state", () => {
  assert.match(commandCenter, /useBrainGraph,/);
  assert.match(commandCenter, /const brainGraph = useBrainGraph\(nav === "brain"\)/);
  assert.match(commandCenter, /const refreshBrain = useCallback\(\(\) => \{[\s\S]*refreshBrainMemories\(\)[\s\S]*refreshBrainGraph\(\)/);
  assert.match(commandCenter, /<BrainPanel[\s\S]*graph=\{brainGraph\.graph\}[\s\S]*onRefresh=\{refreshBrain\}/);
  assert.match(commandCenter, /<BrainPanel[\s\S]*graphProblem=\{brainGraph\.problem\}/);
  assert.match(brain, /graphProblem:\s*string \| null/);
  assert.match(brain, /<BrainMemoryView[\s\S]*graphProblem=\{graphProblem\}/);
  assert.match(memory, /graphProblem:\s*string \| null/);
  assert.match(live, /export function useBrainGraph\(enabled = true\)/);
  assert.match(live, /usePolled\(fetchBrainGraph,\s*120000,\s*enabled\)/);
  assert.match(live, /return \{ graph: data\?\.graph \?\? null, problem: error, refetch \}/);
  assert.doesNotMatch(commandCenter, /problem=\{brainGraph\.problem\}/,
    "a graph projection failure must not replace the ordinary memory error state");
});

test("the Brain graph client accepts only the path-free projection", async () => {
  const calls = [];
  const payload = {
    graph: {
      snapshot: "a".repeat(64),
      nodes: [
        { id: "node-a", memoryId: "memory-a" },
        { id: "node-b", memoryId: "memory-b" },
      ],
      edges: [{ source: "node-a", target: "node-b", relation: "references", confidence: "EXTRACTED" }],
    },
  };
  const api = loadApi(async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return jsonResponse(payload);
  });

  assert.deepEqual(await api.fetchBrainGraph(), payload);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/brain/api/graph");
  assert.equal(calls[0].init.credentials, "include");

  const emptyApi = loadApi(async () => jsonResponse({ graph: null }));
  assert.deepEqual(await emptyApi.fetchBrainGraph(), { graph: null });
});

test("the server relation contract round-trips a safe colon through the browser client", async () => {
  const graph = projectGraphifyBrainOverlay({
    manifest: { snapshot: { manifestSha256: "a".repeat(64) } },
    vaultRoot: "C:\\Users\\Steve\\Obsidian Vault",
    graph: {
      nodes: [
        { id: "private-a", source_file: "Notes/A.md", source_location: "L1", agenthost_kind: "file" },
        { id: "private-b", source_file: "Notes/B.md", source_location: "L1", agenthost_kind: "file" },
      ],
      links: [{ source: "private-a", target: "private-b", relation: "supports:topic", confidence: "INFERRED" }],
    },
    memories: [
      { id: "memory-a", content: "private A", metadata: {}, tags: ["src:Notes/A.md", "chunk:0"] },
      { id: "memory-b", content: "private B", metadata: {}, tags: ["src:Notes/B.md", "chunk:0"] },
    ],
  });
  const payload = { graph };
  const api = loadApi(async () => jsonResponse(payload));

  assert.equal(graph.edges[0].relation, "supports:topic");
  assert.deepEqual(await api.fetchBrainGraph(), payload);
});

test("the Brain graph client fails closed on unknown, path-bearing, or internally inconsistent data", async () => {
  const snapshot = "a".repeat(64);
  const safeNode = { id: "node-a", memoryId: "memory-a" };
  const safePeer = { id: "node-b", memoryId: "memory-b" };
  const cases = [
    { graph: null, content: "private memory content" },
    { graph: { snapshot, nodes: [safeNode], edges: [], privatePath: "/data/private/graph.json" } },
    { graph: { snapshot, nodes: [{ ...safeNode, source_file: "Secret/Note.md" }], edges: [] } },
    { graph: { snapshot, nodes: [{ id: "node-a" }], edges: [] } },
    { graph: { snapshot, nodes: [{ id: "C:\\private\\node", memoryId: "memory-a" }], edges: [] } },
    { graph: { snapshot, nodes: [safeNode, safeNode], edges: [] } },
    { graph: { snapshot, nodes: [safeNode], edges: [{ source: "node-a", target: "node-missing", relation: "references", confidence: "EXTRACTED" }] } },
    { graph: { snapshot, nodes: [safeNode, safePeer], edges: [{ source: "node-a", target: "node-b", relation: "/private/path", confidence: "INFERRED" }] } },
    { graph: { snapshot, nodes: [safeNode, safePeer], edges: [{ source: "node-a", target: "node-b", relation: "references.with.dot", confidence: "INFERRED" }] } },
    { graph: { snapshot, nodes: [safeNode, safePeer], edges: [{ source: "node-a", target: "node-b", relation: "r".repeat(49), confidence: "INFERRED" }] } },
    { graph: { snapshot, nodes: [safeNode, safePeer], edges: [{ source: "node-a", target: "node-b", relation: "api:key", confidence: "INFERRED" }] } },
    { graph: { snapshot, nodes: [safeNode, safePeer], edges: [{ source: "node-a", target: "node-b", relation: "references", confidence: "guessed" }] } },
  ];

  for (const payload of cases) {
    const serialized = JSON.stringify(payload);
    const api = loadApi(async () => jsonResponse(payload));
    await assert.rejects(
      api.fetchBrainGraph(),
      (error) => error?.name === "BrainGraphContractError"
        && error?.code === "brain_graph_invalid_response"
        && /safe projection/.test(error.message)
        && !error.message.includes(serialized),
    );
  }
});

test("Brain graph transport failures name a bounded cause without forwarding server details", async () => {
  const privateCause = "failed reading C:\\private\\vault\\graph.json with secret content";
  const api = loadApi(async () => jsonResponse(
    { error: privateCause, content: "private memory text" },
    { ok: false, status: 502 },
  ));

  await assert.rejects(
    api.fetchBrainGraph(),
    (error) => error?.name === "BrainGraphUnavailableError"
      && error?.code === "brain_graph_unavailable"
      && /HTTP 502/.test(error.message)
      && !error.message.includes(privateCause)
      && !error.message.includes("private memory text"),
  );
});

test("the approved galaxy map keeps exact lane and memory hit targets", () => {
  assert.match(map, /<canvas/);
  assert.match(map, /function seeded\(/);
  assert.match(map, /const stars:/);
  assert.match(map, /const lobeNodes/);
  assert.match(map, /const memoryNodes/);
  assert.match(map, /onSelectMemory\(hit\.id\)/);
  assert.match(map, /onSelectLane\(hit\.id\)/);
  assert.match(map, /width < 640 \? 20 : 12/);
  assert.match(map, /width < 640 \? 30 : 24/);
  assert.doesNotMatch(map, /WebGL|three\.js/i);
});

test("the 390px touch fixes preserve page scrolling and reject drag-as-tap", () => {
  assert.match(map, /touch-pan-y/);
  assert.match(map, /pointerdown/);
  assert.match(map, /pointermove/);
  assert.match(map, /pointerup/);
  assert.match(map, /pointercancel/);
  assert.match(map, /dragDistance >= 7/);
  assert.match(brain, /overflow-y-auto/);
  assert.match(memory, /phone-scroll[\s\S]*overflow-x-auto/);
  assert.doesNotMatch(memory, /min-h-7/, "Brain lane shortcuts cannot shrink below the phone target");
  assert.match(memory, /Memory map lane shortcuts[\s\S]*min-h-11/);
  assert.match(memory, /\["all", "shared", "individual"\][\s\S]*min-h-11/);
  assert.match(memory, /aria-label="Close memory detail"[\s\S]*size-11/);
});

test("lobes scroll to their exact lane and nodes open their exact record", () => {
  assert.match(memory, /getElementById\(`memory-lane-\$\{laneId\}`\)/);
  assert.match(memory, /find\(\(memory\) => memory\.id === selectedMemoryId\)/);
  assert.match(memory, /<MemoryDetail/);
  assert.match(memory, /writeMemoryLocation\(memoryId\)/);
  assert.match(memory, />Memory lanes</);
  assert.match(memory, /id=\{`memory-card-\$\{memory\.id\}`\}/);
});

test("the live Brain keeps create and ingest writes while the map stays read-only", () => {
  assert.match(brain, /createMemory/);
  assert.match(brain, /ingestFile/);
  assert.match(brain, /New memory/);
  assert.doesNotMatch(map, /createMemory|ingestFile|deleteMemory/);
  assert.doesNotMatch(memory, /createMemory|ingestFile|deleteMemory/);
});

test("New memory uses the shared accessible modal contract", () => {
  assert.match(brain, /import \{ useRef, useState \} from "react"/);
  assert.match(brain, /import \{ Btn, Modal, MonoLabel \} from "\.\/primitives"/);
  assert.match(brain, /<Modal[\s\S]*open[\s\S]*title="New memory"/);
  for (const control of ["new-memory-content", "new-memory-tags", "new-memory-file"]) {
    assert.match(brain, new RegExp(`htmlFor="${control}"`), `${control} needs a programmatic label`);
    assert.match(brain, new RegExp(`id="${control}"`), `${control} label needs a matching control id`);
  }
  assert.match(brain, /file:min-h-11/, "the file chooser must keep a 44px phone target");
  assert.match(brain, /const writeInFlight = useRef\(false\)/);
  assert.match(brain, /if \(writeInFlight\.current\) return/);
  assert.match(brain, /onClose=\{close\}/);
  assert.match(brain, /function close\(\) \{[\s\S]*if \(writeInFlight\.current\) return[\s\S]*onClose\(\)/);
  assert.match(primitives, /role="dialog"/);
  assert.match(primitives, /aria-modal="true"/);
  assert.match(primitives, /event\.key === "Escape"/);
  assert.match(primitives, /returnFocus/);
  assert.doesNotMatch(brain, /fixed inset-0 z-50 grid place-items-center/);
});
