import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { projectGraphifyBrainOverlay } = require("../container/graphify-brain.js");

const VAULT_ROOT = "C:\\Users\\Steve\\Obsidian Vault";

function manifest() {
  return {
    runId: "1".repeat(32),
    snapshot: { manifestSha256: "a".repeat(64) },
    graph: { sha256: "b".repeat(64) },
  };
}

function graph(nodes, links = []) {
  return { nodes, links };
}

function fileNode(id, sourceFile) {
  return {
    id,
    label: sourceFile.split("/").at(-1),
    source_file: sourceFile,
    source_location: "L1",
    agenthost_kind: "file",
  };
}

function memory(id, metadata = {}, content = `private content for ${id}`) {
  return { id, content, metadata };
}

function nodeId(overlay, memoryId) {
  return overlay.nodes.find((node) => node.memoryId === memoryId)?.id;
}

test("RED: exact metadata paths and src tags bridge Graphify files, preferring the unique chunk zero row", () => {
  const result = projectGraphifyBrainOverlay({
    manifest: manifest(),
    vaultRoot: VAULT_ROOT,
    graph: graph(
      [
        fileNode("raw-alpha", "Projects/Alpha.md"),
        fileNode("raw-beta", "Notes/Beta.md"),
        { id: "symbol-alpha", source_file: "Projects/Alpha.md", source_location: "L17", agenthost_kind: "symbol" },
      ],
      [{ source: "raw-alpha", target: "raw-beta", relation: "references", confidence: "EXTRACTED" }],
    ),
    memories: [
      memory("memory-alpha", { source: { path: `${VAULT_ROOT}\\Projects\\Alpha.md` } }),
      { ...memory("memory-beta", {}), tags: ["src:Notes/Beta.md", "chunk:0"] },
      { ...memory("memory-beta-later-chunk", {}), tags: ["src:Notes/Beta.md", "chunk:1"] },
      { ...memory("memory-beta-unchunked", {}), tags: ["src:Notes/Beta.md"] },
    ],
  });

  assert.equal(result.snapshot, "a".repeat(64));
  assert.deepEqual(result.nodes.map((node) => node.memoryId), ["memory-alpha", "memory-beta"]);
  assert.ok(nodeId(result, "memory-alpha"));
  assert.ok(nodeId(result, "memory-beta"));
  assert.deepEqual(result.edges, [{
    source: nodeId(result, "memory-alpha"),
    target: nodeId(result, "memory-beta"),
    relation: "references",
    confidence: "EXTRACTED",
  }]);
  assert.equal(JSON.stringify(result).includes("raw-alpha"), false, "private graph identifiers are projected to opaque IDs");
});

test("RED: ambiguous rows and basename-only guesses stay unmapped, while unique unchunked src tags remain eligible", () => {
  const result = projectGraphifyBrainOverlay({
    manifest: manifest(),
    vaultRoot: VAULT_ROOT,
    graph: graph([
      fileNode("one-shared", "One/Shared.md"),
      fileNode("two-shared", "Two/Shared.md"),
      fileNode("exact-node", "Exact/Only.md"),
      fileNode("title-node", "NoSource.md"),
      fileNode("duplicate-a", "Duplicate.md"),
      fileNode("fallback-node", "Fallback.md"),
      fileNode("malformed-source-node", "Malformed.md"),
      fileNode("malformed-chunk-node", "MalformedChunk.md"),
    ]),
    memories: [
      memory("basename-collision", { source: { filename: "Shared.md" } }),
      memory("exact-wins", { source: { filename: "Exact/Only.md" } }),
      memory("basename-loses", { source: { filename: "Only.md" } }),
      memory("title-is-not-source", { title: "NoSource.md" }, "NoSource.md"),
      { ...memory("duplicate-memory-a"), tags: ["src:Duplicate.md"] },
      { ...memory("duplicate-memory-b"), tags: ["src:Duplicate.md"] },
      { ...memory("fallback-unchunked"), tags: ["src:Fallback.md"] },
      { ...memory("fallback-later"), tags: ["src:Fallback.md", "chunk:3"] },
      { ...memory("malformed-source", { source: { path: "Malformed.md" } }), tags: ["src:../Malformed.md"] },
      { ...memory("malformed-chunk"), tags: ["src:MalformedChunk.md", "chunk:not-a-number"] },
    ],
  });

  assert.deepEqual(result.nodes.map((node) => node.memoryId), ["exact-wins", "fallback-unchunked"]);
  assert.equal(nodeId(result, "basename-collision"), undefined);
  assert.equal(nodeId(result, "basename-loses"), undefined);
  assert.equal(nodeId(result, "title-is-not-source"), undefined);
  assert.equal(nodeId(result, "duplicate-memory-a"), undefined);
  assert.equal(nodeId(result, "duplicate-memory-b"), undefined);
  assert.equal(nodeId(result, "malformed-source"), undefined);
  assert.equal(nodeId(result, "malformed-chunk"), undefined);
});

test("RED: explicit memory links are EXTRACTED and suppress Graphify-derived edges for the same pair", () => {
  const result = projectGraphifyBrainOverlay({
    manifest: manifest(),
    vaultRoot: VAULT_ROOT,
    graph: graph(
      [
        fileNode("node-a", "A.md"),
        fileNode("node-b", "B.md"),
        fileNode("node-c", "C.md"),
        fileNode("node-d", "D.md"),
      ],
      [
        { source: "node-a", target: "node-b", relation: "supports", confidence: "INFERRED" },
        { source: "node-b", target: "node-a", relation: "suggests", confidence: "model-guessed" },
        { source: "node-b", target: "node-c", relation: "supports", confidence: "model-guessed" },
      ],
    ),
    memories: [
      memory("memory-a", { source: { path: "A.md" }, links: ["memory-b"], related: ["memory-c"], backlinks: ["memory-d"] }),
      memory("memory-b", { source: { path: "B.md" } }),
      memory("memory-c", { source: { path: "C.md" } }),
      memory("memory-d", { source: { path: "D.md" } }),
    ],
  });

  const a = nodeId(result, "memory-a");
  const b = nodeId(result, "memory-b");
  const c = nodeId(result, "memory-c");
  const d = nodeId(result, "memory-d");
  assert.ok(a && b && c && d);
  assert.ok(result.edges.some((edge) => edge.source === a && edge.target === b && edge.relation === "links" && edge.confidence === "EXTRACTED"));
  assert.ok(result.edges.some((edge) => edge.source === a && edge.target === c && edge.relation === "related" && edge.confidence === "EXTRACTED"));
  assert.ok(result.edges.some((edge) => edge.source === a && edge.target === d && edge.relation === "backlinks" && edge.confidence === "EXTRACTED"));
  assert.equal(result.edges.some((edge) => edge.source === b && edge.target === a), false, "explicit evidence wins in either direction");
  assert.ok(result.edges.some((edge) => edge.source === b && edge.target === c && edge.relation === "supports" && edge.confidence === "AMBIGUOUS"));
});

test("RED: the relation contract keeps safe colons and replaces punctuation or credential shapes", () => {
  const result = projectGraphifyBrainOverlay({
    manifest: manifest(),
    vaultRoot: VAULT_ROOT,
    graph: graph(
      [
        fileNode("node-a", "A.md"),
        fileNode("node-b", "B.md"),
        fileNode("node-c", "C.md"),
        fileNode("node-d", "D.md"),
      ],
      [
        { source: "node-a", target: "node-b", relation: "supports:topic", confidence: "INFERRED" },
        { source: "node-a", target: "node-c", relation: "supports.topic", confidence: "INFERRED" },
        { source: "node-a", target: "node-d", relation: "sk-abcdefghijklmnop", confidence: "INFERRED" },
      ],
    ),
    memories: [
      memory("memory-a", { source: { path: "A.md" } }),
      memory("memory-b", { source: { path: "B.md" } }),
      memory("memory-c", { source: { path: "C.md" } }),
      memory("memory-d", { source: { path: "D.md" } }),
    ],
  });
  const byTarget = new Map(result.edges.map((edge) => [edge.target, edge.relation]));

  assert.equal(byTarget.get(nodeId(result, "memory-b")), "supports:topic");
  assert.equal(byTarget.get(nodeId(result, "memory-c")), "related");
  assert.equal(byTarget.get(nodeId(result, "memory-d")), "related");
});

test("RED: output is deterministic, capped, and contains no source paths, content, or unsafe relation text", () => {
  const memories = [];
  const nodes = [];
  const links = [];
  for (let index = 0; index < 520; index += 1) {
    const id = `memory-${String(index).padStart(3, "0")}`;
    const source = `Private/Note-${String(index).padStart(3, "0")}.md`;
    memories.push({ ...memory(id, {}, `SECRET-CONTENT-${index}`), tags: [`src:${source}`, "chunk:0"] });
    nodes.push(fileNode(`C:\\private\\RAW-TOKEN-${index}`, source));
  }
  for (let index = 0; index < 2500; index += 1) {
    links.push({
      source: `C:\\private\\RAW-TOKEN-${index % 520}`,
      target: `C:\\private\\RAW-TOKEN-${(index * 17 + 1) % 520}`,
      relation: index === 0 ? "C:\\private\\SECRET-TOKEN" : `reference-${index % 11}`,
      confidence: index % 3 === 0 ? "EXTRACTED" : index % 3 === 1 ? "INFERRED" : "not-a-confidence",
    });
  }

  const input = { manifest: manifest(), vaultRoot: VAULT_ROOT, graph: graph(nodes, links), memories };
  const first = projectGraphifyBrainOverlay(input);
  const reordered = projectGraphifyBrainOverlay({
    ...input,
    graph: graph([...nodes].reverse(), [...links].reverse()),
    memories: [...memories].reverse(),
  });

  assert.deepEqual(first, reordered);
  assert.equal(first.nodes.length, 500);
  assert.ok(first.edges.length <= 2000);
  assert.ok(first.edges.every((edge) => first.nodes.some((node) => node.id === edge.source)
    && first.nodes.some((node) => node.id === edge.target)));
  const serialized = JSON.stringify(first);
  for (const privateValue of ["Obsidian Vault", "C:\\\\private", "Private/Note", "SECRET-CONTENT", "RAW-TOKEN", "SECRET-TOKEN"]) {
    assert.equal(serialized.includes(privateValue), false, `output leaked ${privateValue}`);
  }
  assert.ok(first.edges.some((edge) => edge.confidence === "AMBIGUOUS"));
  assert.ok(first.edges.some((edge) => edge.relation === "related"), "unsafe relation text is replaced");
});
