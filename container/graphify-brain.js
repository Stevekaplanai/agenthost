"use strict";

// The browser receives only an identity overlay. Source paths are used here to
// join a private Graphify snapshot to live memory rows, then discarded.
const crypto = require("node:crypto");

const MAX_BRAIN_GRAPH_NODES = 500;
const MAX_BRAIN_GRAPH_EDGES = 2000;
const SAFE_MEMORY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/;
const SAFE_RELATION_RE = /^[A-Za-z][A-Za-z0-9 _:-]{0,47}$/;
const UNSAFE_RELATION_RE = /(?:secret|token|password|credential|api.?key|private.?key|bearer|sk-[A-Za-z0-9_-]{16,}|gh[op]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{10,})/i;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function safeMemoryId(value) {
  const id = typeof value === "string" ? value.trim() : "";
  return SAFE_MEMORY_ID_RE.test(id) ? id : null;
}

function internalGraphId(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 2048 || /[\0\r\n]/.test(value)) return null;
  return value;
}

function normalizedAbsolute(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 4096 || /[\0\r\n]/.test(value)) return null;
  const normalized = value.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/\/$/, "");
  return /^(?:[A-Za-z]:\/|\/)/.test(normalized) ? normalized : null;
}

function normalizedRelative(value, vaultRoot, { allowAbsolute = false } = {}) {
  if (typeof value !== "string" || value.length < 1 || value.length > 4096 || /[\0\r\n]/.test(value)) return null;
  let candidate = value.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (!candidate) return null;
  const absolute = normalizedAbsolute(candidate);
  if (absolute) {
    if (!allowAbsolute) return null;
    const root = normalizedAbsolute(vaultRoot);
    if (!root) return null;
    const rootKey = root.toLowerCase();
    const absoluteKey = absolute.toLowerCase();
    if (!absoluteKey.startsWith(`${rootKey}/`)) return null;
    candidate = absolute.slice(root.length + 1);
  }
  candidate = candidate.replace(/^\.\//, "").replace(/\/$/, "");
  if (!candidate || /^(?:[A-Za-z]:\/|\/)/.test(candidate)) return null;
  const segments = candidate.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  // Graphify's source_file is vault-relative. Case folding makes the join
  // stable for the Windows vault without returning either spelling.
  return segments.join("/").normalize("NFC").toLowerCase();
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function sourceIdentity(memory, vaultRoot) {
  const tags = stringArray(memory.tags);
  const rawTagSources = tags.filter((tag) => tag.startsWith("src:"));
  const tagSources = new Set();
  for (const tag of rawTagSources) {
    const source = normalizedRelative(tag.slice(4), vaultRoot);
    if (!source) return null;
    tagSources.add(source);
  }
  let source = null;
  if (rawTagSources.length > 0 && tagSources.size === 1) {
    source = [...tagSources][0];
  } else if (rawTagSources.length > 0) {
    return null;
  } else if (isRecord(memory.metadata) && isRecord(memory.metadata.source)) {
    const rawMetadataSources = [memory.metadata.source.path, memory.metadata.source.filename]
      .filter((value) => typeof value === "string" && value.trim());
    const metadataSources = new Set();
    for (const field of rawMetadataSources) {
      const normalized = normalizedRelative(field, vaultRoot, { allowAbsolute: true });
      if (!normalized) return null;
      metadataSources.add(normalized);
    }
    if (rawMetadataSources.length > 0 && metadataSources.size === 1) source = [...metadataSources][0];
  }
  if (!source) return null;
  const chunkTags = tags.filter((tag) => tag.startsWith("chunk:"));
  const chunk = chunkTags.length === 0
    ? "unchunked"
    : chunkTags.length === 1 && chunkTags[0] === "chunk:0" ? "zero" : "later";
  return { source, chunk };
}

function isFileNode(node) {
  return node.agenthost_kind === "file" || node.source_location === "L1";
}

function normalizeConfidence(value) {
  return value === "EXTRACTED" || value === "INFERRED" ? value : "AMBIGUOUS";
}

function confidenceRank(value) {
  return value === "EXTRACTED" ? 0 : value === "INFERRED" ? 1 : 2;
}

function safeRelation(value) {
  const relation = typeof value === "string" ? value.trim() : "";
  return SAFE_RELATION_RE.test(relation) && !UNSAFE_RELATION_RE.test(relation) ? relation : "related";
}

function pairKey(source, target) {
  return compareText(source, target) <= 0 ? `${source}\0${target}` : `${target}\0${source}`;
}

function edgeKey(edge) {
  return `${edge.source}\0${edge.target}\0${edge.relation}`;
}

function edgeCompare(left, right) {
  return compareText(left.source, right.source)
    || compareText(left.target, right.target)
    || compareText(left.relation, right.relation)
    || confidenceRank(left.confidence) - confidenceRank(right.confidence);
}

function snapshotId(manifest) {
  const candidates = [
    manifest?.snapshot?.manifestSha256,
    manifest?.manifestSha256,
    manifest?.graph?.sha256,
    manifest?.runId,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && /^(?:[a-f0-9]{32}|[a-f0-9]{64})$/.test(value)) return value;
  }
  return "";
}

function opaqueNodeId(memoryId) {
  return `brain_${crypto.createHash("sha256").update(`memory:${memoryId}`).digest("hex").slice(0, 32)}`;
}

function uniqueMemories(memories) {
  const counts = new Map();
  for (const memory of Array.isArray(memories) ? memories : []) {
    const id = safeMemoryId(memory?.id);
    if (id) counts.set(id, (counts.get(id) || 0) + 1);
  }
  return (Array.isArray(memories) ? memories : [])
    .filter((memory) => {
      const id = safeMemoryId(memory?.id);
      return id && counts.get(id) === 1 && isRecord(memory);
    })
    .map((memory) => ({ memory, id: safeMemoryId(memory.id) }))
    .sort((left, right) => compareText(left.id, right.id));
}

function graphFileNodes(graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const idCounts = new Map();
  for (const node of nodes) {
    const id = internalGraphId(node?.id);
    if (id) idCounts.set(id, (idCounts.get(id) || 0) + 1);
  }
  const bySource = new Map();
  for (const node of nodes) {
    const id = internalGraphId(node?.id);
    const source = normalizedRelative(node?.source_file, "");
    if (!id || idCounts.get(id) !== 1 || !source || !isFileNode(node)) continue;
    const current = bySource.get(source) || [];
    current.push(id);
    bySource.set(source, current);
  }
  return bySource;
}

function selectedMemoryBySource(memories, vaultRoot) {
  const candidates = new Map();
  for (const record of memories) {
    const identity = sourceIdentity(record.memory, vaultRoot);
    if (!identity) continue;
    const current = candidates.get(identity.source) || [];
    current.push({ ...record, chunk: identity.chunk });
    candidates.set(identity.source, current);
  }
  const selected = new Map();
  for (const [source, records] of candidates) {
    const zero = records.filter((record) => record.chunk === "zero");
    const unchunked = records.filter((record) => record.chunk === "unchunked");
    if (zero.length === 1) selected.set(source, zero[0].id);
    else if (unchunked.length === 1) selected.set(source, unchunked[0].id);
  }
  return selected;
}

function explicitMemoryEdges(memories, validMemoryIds) {
  const edges = new Map();
  for (const { memory, id: source } of memories) {
    const metadata = isRecord(memory.metadata) ? memory.metadata : {};
    for (const relation of ["links", "related", "backlinks"]) {
      for (const rawTarget of stringArray(metadata[relation])) {
        const target = safeMemoryId(rawTarget);
        if (!target || target === source || !validMemoryIds.has(target)) continue;
        const edge = { source, target, relation, confidence: "EXTRACTED" };
        edges.set(edgeKey(edge), edge);
      }
    }
  }
  return [...edges.values()].sort(edgeCompare);
}

function graphMemoryEdges(graph, graphNodeToMemory, exactPairs) {
  const links = [
    ...(Array.isArray(graph?.links) ? graph.links : []),
    ...(Array.isArray(graph?.edges) ? graph.edges : []),
  ];
  const edges = new Map();
  for (const link of links) {
    const graphSource = internalGraphId(link?.source);
    const graphTarget = internalGraphId(link?.target);
    const source = graphSource ? graphNodeToMemory.get(graphSource) : null;
    const target = graphTarget ? graphNodeToMemory.get(graphTarget) : null;
    if (!source || !target || source === target || exactPairs.has(pairKey(source, target))) continue;
    const edge = {
      source,
      target,
      relation: safeRelation(link?.relation),
      confidence: normalizeConfidence(link?.confidence),
    };
    const key = edgeKey(edge);
    const current = edges.get(key);
    if (!current || confidenceRank(edge.confidence) < confidenceRank(current.confidence)) edges.set(key, edge);
  }
  return [...edges.values()].sort(edgeCompare);
}

/** Project a private vault graph to the smallest browser-safe identity graph.
 * Source paths and memory content are deliberately absent from the result. */
function projectGraphifyBrainOverlay({ manifest, graph, memories, vaultRoot } = {}) {
  const memoryRecords = uniqueMemories(memories);
  const validMemoryIds = new Set(memoryRecords.map((record) => record.id));
  const graphBySource = graphFileNodes(graph);
  const memoryBySource = selectedMemoryBySource(memoryRecords, vaultRoot);
  const graphNodeToMemory = new Map();
  for (const [source, graphNodes] of graphBySource) {
    const memoryId = memoryBySource.get(source);
    if (!memoryId || graphNodes.length !== 1) continue;
    graphNodeToMemory.set(graphNodes[0], memoryId);
  }

  const exactEdges = explicitMemoryEdges(memoryRecords, validMemoryIds);
  const exactPairs = new Set(exactEdges.map((edge) => pairKey(edge.source, edge.target)));
  const derivedEdges = graphMemoryEdges(graph, graphNodeToMemory, exactPairs);
  const exactParticipants = new Set(exactEdges.flatMap((edge) => [edge.source, edge.target]));
  const mappedParticipants = new Set(graphNodeToMemory.values());
  const selectedMemoryIds = [
    ...[...exactParticipants].sort(compareText),
    ...[...mappedParticipants].filter((id) => !exactParticipants.has(id)).sort(compareText),
  ].slice(0, MAX_BRAIN_GRAPH_NODES);
  const aliases = new Map(selectedMemoryIds.map((id) => [id, opaqueNodeId(id)]));
  const selectedEdges = [...exactEdges, ...derivedEdges]
    .filter((edge) => aliases.has(edge.source) && aliases.has(edge.target))
    .slice(0, MAX_BRAIN_GRAPH_EDGES)
    .map((edge) => ({
      source: aliases.get(edge.source),
      target: aliases.get(edge.target),
      relation: edge.relation,
      confidence: edge.confidence,
    }))
    .sort(edgeCompare);

  return {
    snapshot: snapshotId(manifest),
    nodes: selectedMemoryIds.map((memoryId) => ({ id: aliases.get(memoryId), memoryId })),
    edges: selectedEdges,
  };
}

module.exports = {
  MAX_BRAIN_GRAPH_NODES,
  MAX_BRAIN_GRAPH_EDGES,
  projectGraphifyBrainOverlay,
};
