"use strict";
// growth-lib.js -- Brand DNA / Accounts, proxied to the brain (the memory
// service). The gate holds the brain's credential; the browser never sees it.
//
// Record contract (memory-service rows, requires the metadata column added by
// feat/memory-metadata on the service):
//   account:  scope shared, kind fact, tags ["growth","account"],
//             metadata { app:"growth", record_type:"account", account_id,
//                        name, industry, schemaVersion:1 }
//   dna:      scope shared, kind fact, tags ["growth","brand-dna"],
//             metadata { app:"growth", record_type:"brand-dna", account_id,
//                        asset, source:"client"|"generated", schemaVersion:1 },
//             content = the asset's text.
//   claim:    separate Graphify-derived `brand-dna-claim` rows, projected by
//             graphify-brand.js and included in the existing account export.
//
// HARD RULE (Steve): `source` is stamped at write time, in storage, never as a
// display flag -- a write without a valid source is refused, both here and by
// the dashboard. Export exists from day one: if Brand DNA is the moat, an
// agency will ask what happens when they leave.
//
// Unconfigured is a STATE, not an error to hide: without MEMORY_SERVICE_URL +
// MEMORY_GATE_KEY every route answers 503 { configured:false, error:<why> }
// and the dashboard keeps its sample-data badges. Copy matches code in both
// directions.

const SCHEMA_VERSION = 1;
const SOURCES = new Set(["client", "generated"]);
const PAGE = 200; // the service's hard list cap; export pages by it
const BRAND_DNA_URL_BODY_MAX_BYTES = 8 * 1024;
const BRAIN_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
const brandDnaSource = require("./brand-dna-source.js");
const graphifyBrand = require("./graphify-brand.js");
const BRAND_ASSETS = brandDnaSource.BRAND_ASSETS;
const dnaMutationLocks = new Set();

async function withDnaMutationLock(accountId, work) {
  if (dnaMutationLocks.has(accountId)) {
    return {
      code: 409,
      body: { error: `Brand DNA is already being changed for client account ${accountId}; wait for the current save or website build to finish` },
    };
  }
  dnaMutationLocks.add(accountId);
  try { return await work(); }
  finally { dnaMutationLocks.delete(accountId); }
}

function config(env = process.env) {
  const url = String(env.MEMORY_SERVICE_URL || "").replace(/\/+$/, "");
  const key = String(env.MEMORY_GATE_KEY || "").trim();
  if (!url && !key) return { ok: false, why: "the brain is not connected yet -- MEMORY_SERVICE_URL and MEMORY_GATE_KEY are unset on the box" };
  if (!url) return { ok: false, why: "the brain is not connected yet -- MEMORY_SERVICE_URL is unset on the box" };
  if (!key) return { ok: false, why: "the brain is not connected yet -- MEMORY_GATE_KEY is unset on the box" };
  return { ok: true, url, key };
}

async function readBoundedBrainBody(res) {
  const declared = res && res.headers && typeof res.headers.get === "function"
    ? res.headers.get("content-length")
    : null;
  if (declared !== null && declared !== undefined) {
    const text = String(declared).trim();
    if (!/^\d+$/.test(text)) throw new Error("the brain returned an invalid Content-Length header");
    if (BigInt(text) > BigInt(BRAIN_RESPONSE_MAX_BYTES)) {
      throw new Error(`the brain declared response length ${text} bytes, which exceeds the ${BRAIN_RESPONSE_MAX_BYTES}-byte limit`);
    }
  }

  const stream = res && res.body;
  if (!stream || typeof stream.getReader !== "function") {
    // Existing unit transports expose json() directly. Real fetch responses
    // always take the byte-counted stream path.
    if (!res || typeof res.json !== "function") throw new Error("the brain response did not expose a readable body");
    let value;
    try { value = await res.json(); } catch { return Buffer.alloc(0); }
    const serialized = JSON.stringify(value);
    const bytes = Buffer.from(serialized === undefined ? "" : serialized, "utf8");
    if (bytes.length > BRAIN_RESPONSE_MAX_BYTES) {
      throw new Error(`the brain response body exceeded the ${BRAIN_RESPONSE_MAX_BYTES}-byte limit`);
    }
    return bytes;
  }

  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error("response stream returned a non-byte chunk");
      total += value.byteLength;
      if (total > BRAIN_RESPONSE_MAX_BYTES) {
        try { Promise.resolve(reader.cancel("response body limit exceeded")).catch(() => {}); } catch {}
        throw new Error(`the brain response body exceeded the ${BRAIN_RESPONSE_MAX_BYTES}-byte limit`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  return Buffer.concat(chunks, total);
}

// One brain call. Failures carry the brain's own words (Rule 16), bounded.
async function brain(cfg, method, path, body, fetchFn = fetch) {
  let res;
  try {
    res = await fetchFn(cfg.url + path, {
      method,
      headers: {
        authorization: `Bearer ${cfg.key}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    throw new Error(`the brain did not answer (${String((e && e.message) || e).slice(0, 120)})`);
  }
  let data = null;
  const responseBytes = await readBoundedBrainBody(res);
  try { data = JSON.parse(responseBytes.toString("utf8")); } catch {}
  if (!res.ok) {
    const why = data && data.error ? String(data.error).slice(0, 200) : `HTTP ${res.status}`;
    throw new Error(`the brain refused (${why})`);
  }
  return data;
}

function metaQuery(meta) {
  return `/memory?meta=${encodeURIComponent(JSON.stringify(meta))}&limit=${PAGE}`;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const ASSET_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function slugify(name) {
  const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "account";
  return `${base}-${Math.random().toString(36).slice(2, 8)}`;
}

function projectAccount(row) {
  const m = row.metadata || {};
  return {
    account_id: m.account_id,
    name: m.name || m.account_id,
    industry: m.industry || null,
    created_at: row.created_at,
  };
}

function projectDna(row) {
  const m = row.metadata || {};
  return {
    id: row.id,
    account_id: m.account_id,
    asset: m.asset,
    source: m.source,
    content: row.content,
    version: row.version,
    updated_at: row.updated_at ?? row.created_at,
    schemaVersion: m.schemaVersion,
    ...(m.provenance && typeof m.provenance === "object" ? { provenance: m.provenance } : {}),
  };
}

function projectDnaClaim(row) {
  const m = row.metadata || {};
  return {
    id: row.id,
    record_type: "brand-dna-claim",
    account_id: m.account_id,
    asset: m.asset,
    source: m.source,
    content: row.content,
    confidence: m.confidence,
    run_id: m.run_id,
    snapshot: m.snapshot,
    evidence: m.evidence,
    claim_key: m.claim_key,
    version: row.version,
    updated_at: row.updated_at ?? row.created_at,
    schemaVersion: m.schemaVersion,
    ...(m.provenance && typeof m.provenance === "object" ? { provenance: m.provenance } : {}),
  };
}

function normalizeProvenance(value) {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "generated provenance must be an object" };
  let sourceUrl;
  try { sourceUrl = brandDnaSource.validateSourceUrl(value.source_url).href; }
  catch (e) { return { ok: false, error: `generated provenance source URL is invalid (${String(e.message || e).slice(0, 160)})` }; }
  if (!Array.isArray(value.source_urls) || value.source_urls.length > 5) {
    return { ok: false, error: "generated provenance source URLs must be an array of at most 5 URLs" };
  }
  const sourceUrls = [];
  try {
    for (const url of value.source_urls) sourceUrls.push(brandDnaSource.validateSourceUrl(url).href);
  } catch (e) {
    return { ok: false, error: `generated provenance contains an invalid source URL (${String(e.message || e).slice(0, 160)})` };
  }
  const generated = new Date(String(value.generated_at || ""));
  if (!Number.isFinite(generated.getTime())) return { ok: false, error: "generated provenance requires a valid generated_at timestamp" };
  return { ok: true, value: { source_url: sourceUrl, source_urls: sourceUrls, generated_at: generated.toISOString() } };
}

async function listAccounts(cfg, fetchFn) {
  const data = await brain(cfg, "GET", metaQuery({ app: "growth", record_type: "account" }), null, fetchFn);
  return (data.memories || []).map(projectAccount).filter((a) => a.account_id);
}

async function createAccount(cfg, { name, industry }, fetchFn) {
  const clean = String(name || "").trim().slice(0, 120);
  if (!clean) return { code: 400, body: { error: "name is required" } };
  const account_id = slugify(clean);
  const row = await brain(cfg, "POST", "/memory", {
    scope: "shared",
    kind: "fact",
    content: `Client account: ${clean}${industry ? ` (${String(industry).slice(0, 60)})` : ""}`,
    tags: ["growth", "account"],
    metadata: {
      app: "growth", record_type: "account", account_id,
      name: clean, industry: industry ? String(industry).slice(0, 60) : null,
      schemaVersion: SCHEMA_VERSION,
    },
  }, fetchFn);
  return { code: 201, body: { account: projectAccount(row) } };
}

async function listDna(cfg, accountId, fetchFn) {
  const data = await brain(cfg, "GET", metaQuery({ app: "growth", record_type: "brand-dna", account_id: accountId }), null, fetchFn);
  return (data.memories || []).map(projectDna).filter((r) => r.asset);
}

// Upsert one DNA asset. `source` is validated HERE, at write time -- a caller
// that cannot say whether the client provided this or an agent generated it
// does not get to store it. One optimistic-lock retry: re-read, re-patch.
async function writeDna(cfg, accountId, asset, input, fetchFn) {
  const { content, source, provenance } = input || {};
  if (!SOURCES.has(source)) {
    return { code: 400, body: { error: 'source is required and must be "client" or "generated" -- it is stamped in storage at write time, never a display flag' } };
  }
  const text = String(content || "").trim();
  if (!text) return { code: 400, body: { error: "content is required" } };
  const normalized = normalizeProvenance(provenance);
  if (!normalized.ok) return { code: 400, body: { error: normalized.error } };
  const meta = {
    app: "growth", record_type: "brand-dna", account_id: accountId, asset, source, schemaVersion: SCHEMA_VERSION,
    ...(source === "generated" && normalized.value ? { provenance: normalized.value } : {}),
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = (await listDna(cfg, accountId, fetchFn)).find((r) => r.asset === asset);
    if (!existing) {
      const row = await brain(cfg, "POST", "/memory", {
        scope: "shared", kind: "fact", content: text,
        tags: ["growth", "brand-dna"], metadata: meta,
      }, fetchFn);
      return { code: 201, body: { record: projectDna(row) } };
    }
    try {
      const updated = await brain(cfg, "PATCH", `/memory/${existing.id}`, {
        content: text, metadata: meta, version: existing.version,
      }, fetchFn);
      return { code: 200, body: { record: { ...projectDna({ ...existing, metadata: meta, content: text }), version: updated.version, updated_at: updated.updated_at } } };
    } catch (e) {
      // A version conflict means someone else wrote between our read and
      // patch; re-read once. Any other refusal propagates with its reason.
      if (attempt === 0 && /version conflict/i.test(String(e.message))) continue;
      throw e;
    }
  }
  throw new Error("the brain kept reporting version conflicts -- try again");
}

async function putDna(cfg, accountId, asset, input, fetchFn) {
  return withDnaMutationLock(accountId, () => writeDna(cfg, accountId, asset, input, fetchFn));
}

async function generateDnaFromUrl(cfg, accountId, input, fetchFn, deps = {}) {
  let sourceUrl;
  try { sourceUrl = brandDnaSource.validateSourceUrl(input && input.url).href; }
  catch (e) { return { code: 400, body: { error: String(e.message || e).slice(0, 240) } }; }
  return withDnaMutationLock(accountId, async () => {
    const account = (await listAccounts(cfg, fetchFn)).find((candidate) => candidate.account_id === accountId);
    if (!account) return { code: 404, body: { error: `client account ${accountId} was not found` } };
    const build = deps.buildBrandDna || brandDnaSource.buildBrandDna;
    const generated = await build(sourceUrl, { runModel: deps.runModel });
    const assets = generated && generated.assets;
    const keys = assets && typeof assets === "object" && !Array.isArray(assets) ? Object.keys(assets) : [];
    if (keys.length !== BRAND_ASSETS.length || keys.some((key) => !BRAND_ASSETS.includes(key))
        || BRAND_ASSETS.some((asset) => typeof assets[asset] !== "string" || !assets[asset].trim())) {
      throw new Error("the generation engine did not return exactly five complete Brand DNA assets");
    }
    for (const asset of BRAND_ASSETS) {
      if (assets[asset].trim().length > 12_000) {
        throw new Error(`the generation engine returned ${asset} longer than 12000 characters`);
      }
    }
    const normalized = normalizeProvenance(generated.provenance);
    if (!normalized.ok || !normalized.value) throw new Error(normalized.error || "the generation engine omitted source provenance");
    const records = [];
    for (const asset of BRAND_ASSETS) {
      try {
        const written = await writeDna(cfg, accountId, asset, {
          content: assets[asset], source: "generated", provenance: normalized.value,
        }, fetchFn);
        if (written.code < 200 || written.code >= 300) throw new Error(written.body && written.body.error || `write returned HTTP ${written.code}`);
        records.push(written.body.record);
      } catch (e) {
        return {
          code: 502,
          body: {
            error: `Brand DNA stored ${records.length} of 5 assets; ${asset} failed (${String(e.message || e).slice(0, 200)})`,
            written: records.length,
            failed_asset: asset,
          },
        };
      }
    }
    return { code: 200, body: { ok: true, written: records.length, records, provenance: normalized.value } };
  });
}

// Full extraction for one account: pages until a short page. This is the
// day-one exit door, and its shape round-trips through putDna.
async function exportAccount(cfg, accountId, fetchFn) {
  const records = [];
  for (let offset = 0; ; offset += PAGE) {
    const data = await brain(cfg, "GET", metaQuery({ app: "growth", account_id: accountId }) + `&offset=${offset}`, null, fetchFn);
    const rows = data.memories || [];
    records.push(...rows);
    if (rows.length < PAGE) break;
  }
  return {
    format: "agenthost-brand-dna",
    schemaVersion: SCHEMA_VERSION,
    account_id: accountId,
    exported_at: new Date().toISOString(),
    accounts: records.filter((r) => (r.metadata || {}).record_type === "account").map(projectAccount),
    records: records.filter((r) => (r.metadata || {}).record_type === "brand-dna").map(projectDna),
    claims: records.filter((r) => (r.metadata || {}).record_type === "brand-dna-claim").map(projectDnaClaim),
  };
}

// ---- the HTTP surface (called from gate.js's post-wall dispatch) -----------
// Returns true when the path was handled. All responses are written here.
function handleGrowth(url, req, res, sendJson, fetchFn = fetch, env = process.env, deps = {}) {
  const m = url.pathname.match(/^\/growth\/accounts(?:\/([a-z0-9][a-z0-9-]{1,63})(?:\/(dna|export)(?:\/([a-z0-9][a-z0-9._-]{0,63}))?)?)?$/);
  if (!m) return false;
  const [, accountId, sub, asset] = m;
  const cfg = config(env);

  const fail = (e) => sendJson(res, 502, { error: String((e && e.message) || e).slice(0, 300) });
  const unconfigured = () => sendJson(res, 503, { configured: false, error: cfg.why });

  if (!accountId && req.method === "GET") {
    if (!cfg.ok) return unconfigured(), true;
    listAccounts(cfg, fetchFn).then((accounts) => sendJson(res, 200, { configured: true, accounts })).catch(fail);
    return true;
  }
  if (!accountId && req.method === "POST") {
    if (!cfg.ok) return unconfigured(), true;
    readBody(req).then((body) => createAccount(cfg, body || {}, fetchFn))
      .then((r) => sendJson(res, r.code, r.body)).catch(fail);
    return true;
  }
  if (accountId && sub === "dna" && !asset && req.method === "GET") {
    if (!cfg.ok) return unconfigured(), true;
    listDna(cfg, accountId, fetchFn).then((records) => sendJson(res, 200, { configured: true, records })).catch(fail);
    return true;
  }
  if (accountId && sub === "dna" && asset === "from-url" && req.method === "POST") {
    if (!cfg.ok) return unconfigured(), true;
    readBrandDnaUrlBody(req).then((parsed) => {
      if (!parsed.ok) {
        sendJson(res, parsed.code, { error: parsed.error });
        return null;
      }
      return generateDnaFromUrl(cfg, accountId, parsed.body, fetchFn, deps);
    }).then((r) => { if (r) sendJson(res, r.code, r.body); }).catch(fail);
    return true;
  }
  if (accountId && sub === "dna" && asset && asset !== "from-url" && req.method === "PUT") {
    if (!cfg.ok) return unconfigured(), true;
    readBody(req).then((body) => putDna(cfg, accountId, asset, body || {}, fetchFn))
      .then((r) => sendJson(res, r.code, r.body)).catch(fail);
    return true;
  }
  if (accountId && sub === "export" && req.method === "GET") {
    if (!cfg.ok) return unconfigured(), true;
    exportAccount(cfg, accountId, fetchFn).then((dump) => {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="brand-dna-${accountId}.json"`,
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(dump, null, 2));
    }).catch(fail);
    return true;
  }
  sendJson(res, 405, { error: "unsupported method for this growth route" });
  return true;
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 256 * 1024) { req.destroy(); resolve(null); } });
    req.on("end", () => { try { resolve(JSON.parse(raw || "{}")); } catch { resolve(null); } });
    req.on("error", () => resolve(null));
  });
}

// This endpoint accepts one short URL, so it gets a strict boundary rather
// than the older routes' null-on-error compatibility parser. A bad request is
// never allowed to masquerade as a missing URL or a generation failure.
function readBrandDnaUrlBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    req.on("data", (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > BRAND_DNA_URL_BODY_MAX_BYTES) {
        finish({ ok: false, code: 413, error: `Brand DNA URL request body exceeded ${BRAND_DNA_URL_BODY_MAX_BYTES} bytes` });
        try { if (typeof req.resume === "function") req.resume(); } catch {}
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => {
      if (settled) return;
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
      catch (e) {
        finish({ ok: false, code: 400, error: `Brand DNA URL request body contained invalid JSON (${String(e.message || e).slice(0, 160)})` });
        return;
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        finish({ ok: false, code: 400, error: "Brand DNA URL request body must be a JSON object" });
        return;
      }
      finish({ ok: true, body });
    });
    req.on("error", (e) => finish({
      ok: false,
      code: 400,
      error: `Brand DNA URL request body could not be read (${String(e.message || e).slice(0, 160)})`,
    }));
  });
}

module.exports = {
  SCHEMA_VERSION, SOURCES, ID_RE, ASSET_RE, BRAND_ASSETS, BRAND_DNA_URL_BODY_MAX_BYTES,
  config, slugify, projectAccount, projectDna, projectDnaClaim,
  listAccounts, createAccount, listDna, putDna, generateDnaFromUrl, exportAccount,
  projectGraphifyBrandClaims: graphifyBrand.projectGraphifyBrandClaims,
  handleGrowth, readBrandDnaUrlBody,
};
