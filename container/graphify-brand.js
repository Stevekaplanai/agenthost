"use strict";

// Projects claim-level Graphify evidence into separate Brand DNA claim rows.
// It never patches canonical Brand DNA: explicit client records remain the
// authority, while mixed-confidence derived claims keep their own provenance.
const crypto = require("node:crypto");
const { validateSourceUrl } = require("./brand-dna-source.js");
const {
  isSecretKey,
  redactCredentialShapes,
  redactSecretAssignments,
} = require("./graphify-secrets.js");

const PAGE = 200;
const SCHEMA_VERSION = 1;
const MAX_CLAIMS = 5000;
const MAX_METADATA_BYTES = 32 * 1024;
const MEMORY_TIMEOUT_MS = 8000;
const MEMORY_GET_PAGE_MAX_BYTES = 20 * 1024 * 1024;
const MEMORY_POST_ROW_MAX_BYTES = 128 * 1024;
const MAX_MEMORY_ID_BYTES = 512;
const MAX_MEMORY_TIMESTAMP_BYTES = 128;
const BRAND_ASSETS = new Set(["guidelines", "voice", "intel", "performance", "calls"]);
const CLAIM_TAGS = Object.freeze(["growth", "brand-dna", "brand-dna-claim"]);
const ACCOUNT_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const PRIVATE_PATH_RE = /(^|[\s("'`])(?:[A-Za-z]:[\\/]|\/(?:data|home|opt|root|scratch|source|tmp|workspace)(?:\/|\b))[^\s,"'`]*/gi;
const projectionQueues = new Map();

function boundedText(value, max = 1000) {
  return redactSecretAssignments(redactCredentialShapes(String(value ?? ""), "[redacted]"), "[redacted]")
    .replace(PRIVATE_PATH_RE, (_match, prefix) => `${prefix}[private path]`)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function sanitizeValue(value, depth = 0) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return boundedText(value);
  if (depth >= 3) return "[bounded]";
  if (Array.isArray(value)) return value.slice(0, 32).map((entry) => sanitizeValue(entry, depth + 1));
  if (!value || typeof value !== "object") return null;
  const clean = {};
  for (const key of Object.keys(value).sort().slice(0, 32)) {
    if (!["__proto__", "constructor", "prototype"].includes(key)
        && !isSecretKey(key)
        && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key)) {
      clean[key] = sanitizeValue(value[key], depth + 1);
    }
  }
  return clean;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeSnapshot(value) {
  if (value === undefined || value === null) throw new Error("Graphify Brand projection requires a snapshot receipt");
  const snapshot = sanitizeValue(value);
  const encoded = JSON.stringify(snapshot);
  if (!encoded || encoded === "{}" || encoded.length > 8192) {
    throw new Error("Graphify Brand snapshot receipt is empty or exceeds 8192 bytes");
  }
  return snapshot;
}

function normalizeConfidence(value) {
  const confidence = String(value || "").trim();
  if (confidence === "EXTRACTED" || confidence === "INFERRED" || confidence === "AMBIGUOUS") return confidence;
  return "AMBIGUOUS";
}

function normalizeProvenance(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  let sourceUrl;
  try { sourceUrl = validateSourceUrl(value.source_url).href; }
  catch { return null; }
  if (!Array.isArray(value.source_urls) || value.source_urls.length > 5) return null;
  const sourceUrls = [];
  try {
    for (const url of value.source_urls) sourceUrls.push(validateSourceUrl(url).href);
  } catch { return null; }
  const generated = new Date(String(value.generated_at || ""));
  if (!Number.isFinite(generated.getTime())) return null;
  return { source_url: sourceUrl, source_urls: sourceUrls, generated_at: generated.toISOString() };
}

function provenanceFor(asset, claim, node, snapshot, records) {
  const candidates = [
    claim && claim.provenance,
    node && node.provenance,
    snapshot && snapshot.provenance,
    snapshot && snapshot.assets && snapshot.assets[asset] && snapshot.assets[asset].provenance,
    snapshot && snapshot[asset] && snapshot[asset].provenance,
    ...(Array.isArray(records) ? records
      .filter((record) => record && record.asset === asset && record.source === "generated")
      .map((record) => record.provenance) : []),
  ];
  for (const candidate of candidates) {
    const normalized = normalizeProvenance(candidate);
    if (normalized) return normalized;
  }
  return null;
}

function endpointId(value) {
  if (value && typeof value === "object") return String(value.id ?? "");
  return String(value ?? "");
}

function nodeEvidence(node, fallbackId, asset) {
  const evidence = { id: boundedText(node.id, 160) || fallbackId, asset };
  for (const [target, keys] of [
    ["label", ["label"]],
    ["source_file", ["source_file", "sourceFile"]],
    ["kind", ["kind", "type"]],
  ]) {
    const key = keys.find((candidate) => typeof node[candidate] === "string");
    const value = key ? boundedText(node[key], 320) : "";
    if (value) evidence[target] = value;
  }
  return evidence;
}

function edgeEvidence(edge) {
  const evidence = {
    source: boundedText(endpointId(edge.source), 160),
    target: boundedText(endpointId(edge.target), 160),
  };
  for (const key of ["id", "relation", "label", "type", "source_file"]) {
    const value = boundedText(edge[key], 240);
    if (value) evidence[key] = value;
  }
  return evidence;
}

function claimPlans({ accountId, runId, snapshot, graph, records }) {
  if (!ACCOUNT_ID_RE.test(String(accountId || ""))) throw new Error("Graphify Brand projection requires a valid accountId");
  if (!RUN_ID_RE.test(String(runId || ""))) throw new Error("Graphify Brand projection requires a valid runId");
  if (!graph || typeof graph !== "object" || !Array.isArray(graph.nodes) || !Array.isArray(graph.links)) {
    throw new Error("Graphify Brand projection requires graph nodes and links");
  }
  const safeSnapshot = normalizeSnapshot(snapshot);
  const claimNodeIds = new Set();
  for (let nodeIndex = 0; nodeIndex < graph.nodes.length; nodeIndex += 1) {
    const node = graph.nodes[nodeIndex];
    if (node && typeof node === "object" && Array.isArray(node.claims) && node.claims.length > 0) {
      claimNodeIds.add(endpointId(node.id) || `node-${nodeIndex}`);
    }
  }
  const incidentEdges = new Map();
  for (const edge of graph.links) {
    if (!edge || typeof edge !== "object") continue;
    const endpointIds = new Set([endpointId(edge.source), endpointId(edge.target)]);
    let safeEdge = null;
    for (const endpoint of endpointIds) {
      if (!claimNodeIds.has(endpoint)) continue;
      const edges = incidentEdges.get(endpoint) || [];
      if (edges.length >= 64) continue;
      if (!safeEdge) safeEdge = edgeEvidence(edge);
      edges.push(safeEdge);
      incidentEdges.set(endpoint, edges);
    }
  }
  const plans = [];
  for (let nodeIndex = 0; nodeIndex < graph.nodes.length; nodeIndex += 1) {
    const node = graph.nodes[nodeIndex];
    if (!node || typeof node !== "object" || !Array.isArray(node.claims) || node.claims.length === 0) continue;
    const asset = String(node.asset || "").trim().toLowerCase();
    if (!BRAND_ASSETS.has(asset)) throw new Error(`Graphify Brand claim node has an invalid asset: ${asset || "missing"}`);
    const rawNodeId = endpointId(node.id) || `node-${nodeIndex}`;
    const safeNode = nodeEvidence(node, `node-${nodeIndex}`, asset);
    const edges = incidentEdges.get(rawNodeId) || [];
    for (const rawClaim of node.claims) {
      if (!rawClaim || typeof rawClaim !== "object" || typeof rawClaim.claim !== "string") {
        throw new Error(`Graphify Brand ${asset} claim must contain claim text`);
      }
      const rawContent = String(rawClaim.claim).trim();
      if (!rawContent || rawContent.length > 12_000) throw new Error(`Graphify Brand ${asset} claim is empty or exceeds 12000 characters`);
      const content = boundedText(rawContent, 12_000);
      const confidence = normalizeConfidence(rawClaim.confidence);
      const source = confidence === "EXTRACTED" ? "client" : "generated";
      const provenance = source === "generated"
        ? provenanceFor(asset, rawClaim, node, snapshot, records)
        : null;
      if (source === "generated" && !provenance) {
        throw new Error(`Graphify Brand generated claim for ${asset} requires valid provenance`);
      }
      const evidence = {
        node: safeNode,
        edges,
        ...(rawClaim.evidence === undefined ? {} : { claim: sanitizeValue(rawClaim.evidence) }),
      };
      const claimKey = crypto.createHash("sha256").update(stableJson({
        accountId, runId, asset, content, confidence, evidence,
      })).digest("hex");
      plans.push({ asset, content, confidence, source, provenance, evidence, snapshot: safeSnapshot, claimKey });
      if (plans.length > MAX_CLAIMS) throw new Error(`Graphify Brand projection exceeds ${MAX_CLAIMS} claims`);
    }
  }
  const unique = new Map();
  for (const plan of plans) if (!unique.has(plan.claimKey)) unique.set(plan.claimKey, plan);
  return [...unique.values()];
}

function memoryConfig(cfg) {
  const url = String(cfg && cfg.url || "").replace(/\/+$/, "");
  const key = String(cfg && cfg.key || "").trim();
  if (!url || !key || (cfg && cfg.ok === false)) throw new Error("Graphify Brand projection requires the connected memory service");
  const requestedTimeout = Number(cfg && cfg.timeoutMs);
  const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
    ? Math.min(Math.trunc(requestedTimeout), MEMORY_TIMEOUT_MS)
    : MEMORY_TIMEOUT_MS;
  return { url, key, timeoutMs };
}

function memoryResponseLimit(method) {
  return method === "GET"
    ? { maxBytes: MEMORY_GET_PAGE_MAX_BYTES, label: "GET page" }
    : { maxBytes: MEMORY_POST_ROW_MAX_BYTES, label: "POST row" };
}

async function readBoundedMemoryBody(response, limit, allowFixtureJson) {
  let declared = null;
  try {
    if (response && response.headers && typeof response.headers.get === "function") {
      declared = response.headers.get("content-length");
    }
  } catch (error) {
    throw new Error(`the brain response headers could not be read (${String(error && error.message || error).slice(0, 120)})`);
  }
  if (declared !== null && declared !== undefined) {
    const text = String(declared).trim();
    if (!/^\d+$/.test(text)) throw new Error("the brain returned an invalid Content-Length header");
    if (BigInt(text) > BigInt(limit.maxBytes)) {
      throw new Error(`the brain declared response length ${text} bytes, which exceeds the ${limit.maxBytes}-byte ${limit.label} limit`);
    }
  }

  let stream;
  try { stream = response && response.body; }
  catch (error) {
    throw new Error(`the brain response body could not be opened (${String(error && error.message || error).slice(0, 120)})`);
  }
  if (!stream || typeof stream.getReader !== "function") {
    // Local fixture transports predate streamed Response mocks. Actual fetch
    // responses always take the bounded stream path above.
    if (!allowFixtureJson || !response || typeof response.json !== "function") {
      throw new Error("the brain response did not expose a readable body");
    }
    const fixture = await response.json();
    const text = JSON.stringify(fixture);
    const bytes = Buffer.from(text === undefined ? "" : text, "utf8");
    if (bytes.length > limit.maxBytes) {
      throw new Error(`the brain response body exceeded the ${limit.maxBytes}-byte ${limit.label} limit`);
    }
    return bytes;
  }

  const chunks = [];
  let total = 0;
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error("response stream returned a non-byte chunk");
      total += value.byteLength;
      if (total > limit.maxBytes) {
        try { Promise.resolve(reader.cancel("response body limit exceeded")).catch(() => {}); } catch {}
        const error = new Error(`the brain response body exceeded the ${limit.maxBytes}-byte ${limit.label} limit`);
        error.code = "GRAPHIFY_MEMORY_RESPONSE_LIMIT";
        throw error;
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error && error.code === "GRAPHIFY_MEMORY_RESPONSE_LIMIT") throw error;
    const cause = String(error && error.message || error || "unknown body read failure")
      .replace(/[\r\n]+/g, " ").slice(0, 160);
    throw new Error(`the brain response body could not be read (${cause})`);
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  return Buffer.concat(chunks, total);
}

async function memoryJson(cfg, method, pathname, body, fetchFn) {
  const fetcher = fetchFn || globalThis.fetch;
  if (typeof fetcher !== "function") throw new Error("Graphify Brand projection has no memory transport");
  let response;
  try {
    response = await fetcher(cfg.url + pathname, {
      method,
      headers: {
        authorization: `Bearer ${cfg.key}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (error) {
    const cause = error && error.name === "TimeoutError"
      ? `timed out after ${cfg.timeoutMs}ms`
      : String(error && error.message || error).slice(0, 120);
    throw new Error(`the brain did not answer (${cause})`);
  }
  const bytes = await readBoundedMemoryBody(
    response,
    memoryResponseLimit(method),
    Boolean(fetchFn && fetchFn !== globalThis.fetch),
  );
  let data = null;
  try { data = JSON.parse(bytes.toString("utf8")); }
  catch (error) {
    if (response.ok) {
      const cause = String(error && error.message || error || "unknown JSON parse failure")
        .replace(/[\r\n]+/g, " ").slice(0, 160);
      throw new Error(`the brain returned invalid JSON (${cause})`);
    }
  }
  if (!response.ok) {
    const cause = data && data.error ? String(data.error).slice(0, 200) : `HTTP ${response.status}`;
    throw new Error(`the brain refused (${cause})`);
  }
  return data;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function retainedClaimRow(row, expected) {
  const updatedAt = row.updated_at || row.created_at;
  return {
    id: row.id,
    scope: "shared",
    kind: "fact",
    content: expected.plan.content,
    tags: CLAIM_TAGS,
    ...(Number.isSafeInteger(row.version) ? { version: row.version } : {}),
    ...(typeof updatedAt === "string"
      && Buffer.byteLength(updatedAt, "utf8") <= MAX_MEMORY_TIMESTAMP_BYTES
      ? { updated_at: updatedAt }
      : {}),
    metadata: expected.metadata,
  };
}

async function existingRunClaims(cfg, accountId, runId, expectedByKey, fetchFn) {
  const rows = [];
  const seenClaimKeys = new Set();
  const meta = encodeURIComponent(JSON.stringify({
    app: "growth", record_type: "brand-dna-claim", account_id: accountId, run_id: runId,
  }));
  let finalAllowedPageWasFull = false;
  for (let offset = 0; offset < MAX_CLAIMS; offset += PAGE) {
    const data = await memoryJson(cfg, "GET", `/memory?meta=${meta}&limit=${PAGE}&offset=${offset}`, null, fetchFn);
    if (!isRecord(data) || !Array.isArray(data.memories) || data.memories.some((row) => !isRecord(row))) {
      throw new Error("the brain returned an invalid memory list (memories must be an array of claim rows)");
    }
    if (data.memories.length > PAGE) {
      throw new Error(`the brain returned an invalid memory list (one page contained more than ${PAGE} rows)`);
    }
    const page = data.memories;
    for (const row of page) {
      requireDurableClaimRow(row, accountId, runId, null, "stored");
      const claimKey = row.metadata.claim_key;
      if (seenClaimKeys.has(claimKey)) {
        throw new Error(`Graphify Brand stored returned duplicate durable claim key ${claimKey}`);
      }
      seenClaimKeys.add(claimKey);
      const expected = expectedByKey.get(claimKey);
      if (!expected) {
        throw new Error("Graphify Brand stored returned claim row has metadata outside the current plan");
      }
      if (stableJson(row.metadata.snapshot) !== stableJson(expected.metadata.snapshot)) {
        throw new Error(`Graphify Brand run ${runId} is already bound to a different snapshot`);
      }
      requireExactClaimRow(row, expected.plan.content, expected.metadata, "stored");
      rows.push(retainedClaimRow(row, expected));
    }
    finalAllowedPageWasFull = page.length === PAGE;
    if (!finalAllowedPageWasFull) break;
  }
  if (finalAllowedPageWasFull && rows.length === MAX_CLAIMS) {
    const sentinel = await memoryJson(cfg, "GET", `/memory?meta=${meta}&limit=1&offset=${MAX_CLAIMS}`, null, fetchFn);
    if (!isRecord(sentinel) || !Array.isArray(sentinel.memories)
        || sentinel.memories.some((row) => !isRecord(row))) {
      throw new Error("the brain returned an invalid memory list (memories must be an array of claim rows)");
    }
    if (sentinel.memories.length > 1) {
      throw new Error("the brain returned an invalid memory list (the sentinel page contained more than 1 row)");
    }
    if (sentinel.memories.length > 0) {
      throw new Error(`Graphify Brand stored returned more than ${MAX_CLAIMS} durable claim rows for this run`);
    }
  }
  return rows;
}

function projectClaim(row) {
  const metadata = row && row.metadata && typeof row.metadata === "object" ? row.metadata : row || {};
  return {
    id: row && row.id,
    record_type: "brand-dna-claim",
    account_id: metadata.account_id,
    asset: metadata.asset,
    source: metadata.source,
    content: row && row.content,
    confidence: metadata.confidence,
    run_id: metadata.run_id,
    snapshot: metadata.snapshot,
    evidence: metadata.evidence,
    claim_key: metadata.claim_key,
    ...(metadata.provenance ? { provenance: metadata.provenance } : {}),
    version: row && row.version,
    updated_at: row && (row.updated_at || row.created_at),
    schemaVersion: metadata.schemaVersion,
  };
}

function claimMetadata(accountId, runId, plan) {
  return {
    app: "growth",
    record_type: "brand-dna-claim",
    account_id: accountId,
    asset: plan.asset,
    source: plan.source,
    confidence: plan.confidence,
    run_id: runId,
    snapshot: plan.snapshot,
    evidence: plan.evidence,
    claim_key: plan.claimKey,
    schemaVersion: SCHEMA_VERSION,
    ...(plan.source === "generated" ? { provenance: plan.provenance } : {}),
  };
}

function requireClaimAccount(row, accountId, origin) {
  const rowAccountId = row?.account_id ?? row?.metadata?.account_id;
  if (rowAccountId !== accountId) {
    throw new Error(`Graphify Brand ${origin} claim row has a missing or different account id`);
  }
}

function requireDurableClaimRow(row, accountId, runId, claimKey, origin) {
  if (!isRecord(row) || typeof row.id !== "string" || !row.id.trim() || !isRecord(row.metadata)) {
    throw new Error(`Graphify Brand ${origin} returned claim row is malformed`);
  }
  if (Buffer.byteLength(row.id, "utf8") > MAX_MEMORY_ID_BYTES) {
    throw new Error(`Graphify Brand ${origin} returned claim row has an oversized id`);
  }
  const metadata = row.metadata;
  if (metadata.record_type !== "brand-dna-claim") {
    throw new Error(`Graphify Brand ${origin} returned claim row has a missing or different record type`);
  }
  if (metadata.account_id !== accountId) {
    throw new Error(`Graphify Brand ${origin} returned claim row has a missing or different account id`);
  }
  if (metadata.run_id !== runId) {
    throw new Error(`Graphify Brand ${origin} returned claim row has a missing or different run id`);
  }
  if (typeof metadata.claim_key !== "string" || !/^[a-f0-9]{64}$/.test(metadata.claim_key)) {
    throw new Error(`Graphify Brand ${origin} returned claim row has an invalid claim key`);
  }
  if (claimKey !== null && metadata.claim_key !== claimKey) {
    throw new Error(`Graphify Brand ${origin} returned claim row has a different claim key`);
  }
}

function requireExactClaimRow(row, content, metadata, origin) {
  if (row.scope !== "shared") {
    throw new Error(`Graphify Brand ${origin} returned claim row has a different scope`);
  }
  if (row.kind !== "fact") {
    throw new Error(`Graphify Brand ${origin} returned claim row has a different kind`);
  }
  if (stableJson(row.tags) !== stableJson(CLAIM_TAGS)) {
    throw new Error(`Graphify Brand ${origin} returned claim row has different tags`);
  }
  if (row.content !== content) {
    throw new Error(`Graphify Brand ${origin} returned claim row has different content`);
  }
  if (stableJson(row.metadata) !== stableJson(metadata)) {
    throw new Error(`Graphify Brand ${origin} returned claim row has different metadata`);
  }
}

function serializeProjection(key, work) {
  const prior = projectionQueues.get(key) || Promise.resolve();
  const current = prior.catch(() => {}).then(work);
  projectionQueues.set(key, current);
  return current.finally(() => {
    if (projectionQueues.get(key) === current) projectionQueues.delete(key);
  });
}

async function projectGraphifyBrandClaims(input = {}) {
  const { accountId, runId, snapshot, graph, records = [], fetchFn } = input;
  const cfg = memoryConfig(input.cfg);
  const plans = claimPlans({ accountId, runId, snapshot, graph, records });
  if (plans.length === 0) {
    throw new Error("Graphify Brand projection contains no explicit graph.nodes[].claims[] entries");
  }
  const expectedSnapshot = stableJson(normalizeSnapshot(snapshot));
  const prepared = plans.map((plan) => {
    const metadata = claimMetadata(accountId, runId, plan);
    const bytes = Buffer.byteLength(JSON.stringify(metadata), "utf8");
    if (bytes > MAX_METADATA_BYTES) {
      throw new Error(`Graphify Brand ${plan.asset} claim metadata is ${bytes} bytes; the limit is ${MAX_METADATA_BYTES} bytes`);
    }
    return { plan, metadata };
  });
  const preparedByKey = new Map(prepared.map((entry) => [entry.plan.claimKey, entry]));
  // Corpus records can supply generated-claim provenance while plans are built,
  // but they are caller input, not proof that a claim exists in the Brain.
  // The scoped GET below is the only durability authority for an existing row.
  for (const record of Array.isArray(records) ? records : []) {
    const recordType = record?.record_type ?? record?.metadata?.record_type;
    const recordRunId = record?.run_id ?? record?.metadata?.run_id;
    if (recordType !== "brand-dna-claim" || recordRunId !== runId) continue;
    requireClaimAccount(record, accountId, "supplied");
  }
  return serializeProjection(`${accountId}:${runId}`, async () => {
    const durable = await existingRunClaims(cfg, accountId, runId, preparedByKey, fetchFn);
    for (const row of durable) requireClaimAccount(row, accountId, "stored");
    for (const row of durable) {
      const storedSnapshot = row?.snapshot ?? row?.metadata?.snapshot;
      if (stableJson(storedSnapshot) !== expectedSnapshot) {
        throw new Error(`Graphify Brand run ${runId} is already bound to a different snapshot`);
      }
    }
    const existingByKey = new Map();
    for (const row of durable) {
      const key = row.claim_key || row.metadata?.claim_key;
      if (typeof key === "string" && key) existingByKey.set(key, row);
    }
    const claims = [];
    let written = 0;
    let existing = 0;
    for (const { plan, metadata } of prepared) {
      const prior = existingByKey.get(plan.claimKey);
      if (prior) {
        existing += 1;
        claims.push(projectClaim(prior));
        continue;
      }
      let row;
      try {
        row = await memoryJson(cfg, "POST", "/memory", {
          scope: "shared",
          kind: "fact",
          content: plan.content,
          tags: CLAIM_TAGS,
          metadata,
        }, fetchFn);
        requireDurableClaimRow(row, accountId, runId, plan.claimKey, "claim save");
        requireExactClaimRow(row, plan.content, metadata, "claim save");
        row = retainedClaimRow(row, { plan, metadata });
      } catch (error) {
        const cause = String(error && error.message || error || "unknown Brain write failure")
          .replace(/[\r\n]+/g, " ").slice(0, 200);
        const partial = new Error(`Graphify Brand claim save failed after ${written} new claim${written === 1 ? " was" : "s were"} saved (${written + existing} of ${prepared.length} total claims confirmed): ${cause}`);
        partial.landedCount = written;
        partial.existingCount = existing;
        partial.totalClaims = prepared.length;
        throw partial;
      }
      existingByKey.set(plan.claimKey, row);
      claims.push(projectClaim(row));
      written += 1;
    }
    return { ok: true, written, existing, claims };
  });
}

module.exports = {
  normalizeConfidence,
  normalizeProvenance,
  claimPlans,
  claimMetadata,
  existingRunClaims,
  projectClaim,
  projectGraphifyBrandClaims,
  retainedClaimRow,
};
