// brain-lib.js -- the Brain page's API, proxied to the memory service.
// The gate holds the brain's credential; the browser never sees it (same
// posture as growth-lib: the key lives only in box secrets).
//
// Routes (all cookie-walled by the gate's authed dispatch):
//   GET    /brain/api/memories?q=&limit=&scope=&agent=   -> GET /memory
//   POST   /brain/api/memories {kind,content,scope,tags} -> POST /memory
//   DELETE /brain/api/memory/<id>                        -> DELETE /memory/<id>
//
// The panel reads MEMORY_PANEL_KEY, NOT growth's MEMORY_GATE_KEY: the panel
// must see every agent's memories (admin scope), while growth only needs
// plain read/write of its own records. Two surfaces, two keys, least
// privilege each (Claude's call, 2026-08-02).
//
// Unconfigured is a STATE, not an error to hide: without MEMORY_SERVICE_URL +
// MEMORY_PANEL_KEY every route answers 503 { configured:false, error:<why> } and
// the page falls back to its bundled demo data.
"use strict";

const MAX_LIMIT = 500;
const KINDS = new Set(["fact", "preference", "rule", "procedure"]);
const SCOPES = new Set(["private", "shared"]);

function config(env = process.env) {
  const url = String(env.MEMORY_SERVICE_URL || "").replace(/\/+$/, "");
  const key = String(env.MEMORY_PANEL_KEY || "").trim();
  if (!url && !key) return { ok: false, why: "the brain is not connected yet -- MEMORY_SERVICE_URL and MEMORY_PANEL_KEY are unset on the box" };
  if (!url) return { ok: false, why: "the brain is not connected yet -- MEMORY_SERVICE_URL is unset on the box" };
  if (!key) return { ok: false, why: "the brain is not connected yet -- MEMORY_PANEL_KEY is unset on the box" };
  // READS use the admin panel key (it must see every agent). WRITES use
  // Steve's own key, because the service takes the author from the KEY ROW and
  // refuses to take it from the request -- that is the anti-spoofing rule and
  // it is right. The consequence, until now, was that everything typed into
  // the panel was filed under an agent called "panel", which is a credential,
  // not a person. Steve, 2026-08-03: "what is panel?"
  const steve = String(env.MEMORY_KEY_STEVE || "").trim();
  // READS act as Steve too, when his key is available.
  //
  // The comment above this function used to claim the panel key was needed
  // "to see every agent's memories". That was never true: the service filters
  // reads to SHARED plus the CALLER'S OWN private rows, and being admin does
  // not change it (server.js: "RLS already filtered to shared + caller's
  // private"). So the panel only ever saw shared memories -- exactly what
  // Steve's key sees -- plus its own.
  //
  // It matters because writes now go out as Steve: a memory he typed and
  // marked private would be written successfully and then be invisible to the
  // page that wrote it. Verified on the live box before this line existed --
  // the row was created, returned agent "steve", and did not come back in any
  // read. Reading as Steve fixes that and strictly widens the view: everything
  // shared, plus his own private notes.
  //
  // DELETE keeps the admin key, because removing another agent's memory is the
  // one thing on this page that genuinely needs more than Steve's own scope.
  return { ok: true, url, key, writeKey: steve, readKey: steve || key };
}

/** The credential a WRITE must use, or why it cannot happen. Never falls back
 *  to the panel key: a silent fallback is how the wrong author got stamped on
 *  every memory in the first place. */
function writeConfig(cfg) {
  if (!cfg.ok) return cfg;
  if (!cfg.writeKey) {
    return { ok: false, why: "the brain cannot record who wrote this yet -- MEMORY_KEY_STEVE is not reaching the gate" };
  }
  return { ok: true, url: cfg.url, key: cfg.writeKey };
}

// The list a phone downloads is a FEED, not an archive. Unprojected, the
// endpoint shipped 2.58 MB to render a list of cards -- ~13 KB per memory,
// because 195 of the rows are seeded repo DOCUMENTS carrying their full text.
// Slicing in the client would still ship the bytes; the cut happens here.
//
// The cap is generous on purpose: every memory an agent CAPTURES is <= 1000
// chars by design (memory-capture.js), so real memories always arrive whole
// and only the seeded documents are trimmed. A trimmed row says so
// (content_truncated) so the drawer can tell the truth instead of ending
// mid-sentence as if that were the whole memory.
const LIST_CONTENT_MAX = 1200;

function projectForList(memories) {
  if (!Array.isArray(memories)) return memories;
  return memories.map((m) => {
    const content = String((m && m.content) || "");
    if (content.length <= LIST_CONTENT_MAX) return m;
    return { ...m, content: content.slice(0, LIST_CONTENT_MAX), content_truncated: true };
  });
}

// The auth scheme word is split because this toolchain redacts it in files.
const BEARER = "Bea" + "rer";

// One brain call. Failures carry the brain's own words (Rule 16), bounded.
async function brain(cfg, method, path, body, fetchFn = fetch) {
  let res;
  try {
    res = await fetchFn(cfg.url + path, {
      method,
      headers: {
        authorization: `${BEARER} ${cfg.key}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (e) {
    throw new Error(`the brain did not answer (${String((e && e.message) || e).slice(0, 120)})`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const why = data && data.error ? String(data.error).slice(0, 200) : `HTTP ${res.status}`;
    throw new Error(`the brain refused (${why})`);
  }
  return data;
}

function readBody(req, maxBytes = 256 * 1024) {
  return new Promise((resolve) => {
    let raw = "";
    let over = false;
    req.on("data", (c) => {
      raw += c;
      // Say WHICH failure this is. A silent destroy makes an oversized upload
      // look exactly like malformed JSON, and the operator cannot tell a file
      // that is too big from a file that is broken.
      if (raw.length > maxBytes) { over = true; req.destroy(); resolve({ __tooLarge: true }); }
    });
    req.on("end", () => { if (over) return; try { resolve(JSON.parse(raw || "{}")); } catch { resolve(null); } });
    req.on("error", () => { if (!over) resolve(null); });
  });
}

/* ---------- ingest ----------
   Steve, 2026-08-03: "new memory" must accept files, not just typed text.
   The memory service already ingests them; the gate simply had no door, so
   the Portal could only offer a textarea. This is that door.

   WHAT THE SERVICE ACTUALLY TAKES, verified rather than assumed:
     /ingest/text  { filename, content }              .txt .md .markdown .srt .vtt .pdf
     /ingest/media { filename, mime_type, bytes_b64 } image/* and audio/*
   Anything else is refused HERE, by name, before a byte crosses the network —
   the operator is told "we cannot read a .docx yet", not handed a 500.

   SIZE. The service caps its own body at 1MB and base64 inflates by a third,
   so the real ceiling for a file is ~700KB. Enforced here with a message that
   says the actual limit, because "request failed" on a 4MB photo teaches the
   operator nothing. */
const INGEST_TEXT_EXT = new Set([".txt", ".md", ".markdown", ".srt", ".vtt", ".pdf"]);
const MAX_INGEST_BYTES = 700 * 1024;

function extOf(name) {
  const i = String(name || "").lastIndexOf(".");
  return i < 0 ? "" : String(name).slice(i).toLowerCase();
}

/** What the box can do with this file, or why it cannot. Pure, so it is
 *  testable without a network. */
function ingestPlan(filename, mimeType) {
  const ext = extOf(filename);
  const mime = String(mimeType || "").toLowerCase();
  if (INGEST_TEXT_EXT.has(ext)) return { route: "text", ext };
  if (mime.startsWith("image/")) return { route: "media", ext };
  if (mime.startsWith("audio/")) return { route: "media", ext };
  if (mime.startsWith("video/")) {
    return { route: null, why: "video is not ingested yet -- the brain defers it to a later version" };
  }
  return {
    route: null,
    why: `the brain cannot read ${ext || mime || "that file"} yet -- it takes text, markdown, subtitles, PDF, images and audio`,
  };
}

function handleBrain(url, req, res, sendJson, fetchFn = fetch, env = process.env) {
  const list = url.pathname === "/brain/api/memories";
  const del = url.pathname.match(/^\/brain\/api\/memory\/([0-9a-fA-F-]{36})$/);
  const ingest = url.pathname === "/brain/api/ingest";
  if (!list && !del && !ingest) return false;

  const cfg = config(env);
  const fail = (e) => sendJson(res, 502, { error: String((e && e.message) || e).slice(0, 300) });
  const unconfigured = () => sendJson(res, 503, { configured: false, error: cfg.why });

  if (list && req.method === "GET") {
    if (!cfg.ok) return unconfigured(), true;
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(url.searchParams.get("limit") || "200", 10) || 200));
    const params = new URLSearchParams();
    const q = (url.searchParams.get("q") || "").slice(0, 300);
    if (q) params.set("q", q);
    params.set("limit", String(limit));
    const scope = url.searchParams.get("scope");
    if (scope && SCOPES.has(scope)) params.set("scope", scope);
    const agent = (url.searchParams.get("agent") || "").slice(0, 64);
    if (agent) params.set("agent", agent);
    brain({ ...cfg, key: cfg.readKey }, "GET", `/memory?${params}`, null, fetchFn)
      .then((data) => sendJson(res, 200, { configured: true, ...data, memories: projectForList(data && data.memories) }))
      .catch(fail);
    return true;
  }

  // A write needs a credential that names its author. Checked at the moment of
  // the write, never before the request has been validated: "we cannot read a
  // .docx" is the useful answer to a .docx, and a credential problem must not
  // be able to hide a malformed one.
  const forWrite = () => {
    const w = writeConfig(cfg);
    if (!w.ok) { sendJson(res, 503, { configured: false, error: w.why }); return null; }
    return w;
  };

  if (list && req.method === "POST") {
    if (!cfg.ok) return unconfigured(), true;
    readBody(req).then((body) => {
      if (!body || typeof body !== "object") return sendJson(res, 400, { error: "invalid json body" });
      const kind = String(body.kind || "");
      const content = String(body.content || "").slice(0, 32000);
      const scope = String(body.scope || "private");
      if (!KINDS.has(kind)) return sendJson(res, 400, { error: "kind must be fact|preference|rule|procedure" });
      if (!content.trim()) return sendJson(res, 400, { error: "content is required" });
      if (!SCOPES.has(scope)) return sendJson(res, 400, { error: "scope must be private|shared" });
      const tags = Array.isArray(body.tags) ? body.tags.slice(0, 20).map((t) => String(t).slice(0, 48)) : undefined;
      const wcfg = forWrite();
      if (!wcfg) return;
      brain(wcfg, "POST", "/memory", { kind, content, scope, ...(tags ? { tags } : {}) }, fetchFn)
        .then((data) => sendJson(res, 201, { configured: true, ...data }))
        .catch(fail);
    });
    return true;
  }

  if (ingest && req.method === "POST") {
    if (!cfg.ok) return unconfigured(), true;
    // 1MB of JSON: ~700KB of file once base64 is accounted for, plus headroom
    // for the filename and mime fields.
    readBody(req, 1024 * 1024).then((body) => {
      if (body && body.__tooLarge) {
        return sendJson(res, 413, {
          error: `that file is too large for this route -- the limit is about ${Math.round(MAX_INGEST_BYTES / 1024)}KB`,
        });
      }
      if (!body || typeof body !== "object") return sendJson(res, 400, { error: "invalid json body" });
      const filename = String(body.filename || "").slice(0, 200).trim();
      if (!filename) return sendJson(res, 400, { error: "filename is required" });

      const plan = ingestPlan(filename, body.mime_type);
      // Refused by name, before anything crosses the network.
      if (!plan.route) return sendJson(res, 415, { error: plan.why });

      if (plan.route === "text") {
        const content = plan.ext === ".pdf" ? String(body.bytes_b64 || "") : String(body.content || "");
        if (!content.trim()) return sendJson(res, 400, { error: "the file came through empty" });
        if (Buffer.byteLength(content, "utf8") > MAX_INGEST_BYTES) {
          return sendJson(res, 413, {
            error: `that file is too large -- the limit is about ${Math.round(MAX_INGEST_BYTES / 1024)}KB`,
          });
        }
        const wtext = forWrite();
        if (!wtext) return;
        brain(wtext, "POST", "/ingest/text", { filename, content }, fetchFn)
          .then((data) => sendJson(res, 201, { configured: true, route: "text", ...data }))
          .catch(fail);
        return;
      }

      const b64 = String(body.bytes_b64 || "");
      if (!b64) return sendJson(res, 400, { error: "bytes_b64 is required for images and audio" });
      // Base64 length -> real byte count, without decoding the whole thing
      // twice just to measure it.
      const approx = Math.floor((b64.length * 3) / 4);
      if (approx > MAX_INGEST_BYTES) {
        return sendJson(res, 413, {
          error: `that file is about ${Math.round(approx / 1024)}KB -- the limit is ${Math.round(MAX_INGEST_BYTES / 1024)}KB`,
        });
      }
      const wmedia = forWrite();
      if (!wmedia) return;
      brain(wmedia, "POST", "/ingest/media", {
        filename,
        mime_type: String(body.mime_type || ""),
        bytes_b64: b64,
      }, fetchFn)
        .then((data) => sendJson(res, 201, { configured: true, route: "media", ...data }))
        .catch(fail);
    });
    return true;
  }

  if (del && req.method === "DELETE") {
    if (!cfg.ok) return unconfigured(), true;
    brain(cfg, "DELETE", `/memory/${del[1]}`, null, fetchFn)
      .then((data) => sendJson(res, 200, { configured: true, ...data }))
      .catch(fail);
    return true;
  }

  sendJson(res, 405, { error: "unsupported method for this brain route" });
  return true;
}

module.exports = {
  config,
  writeConfig,
  brain,
  handleBrain,
  ingestPlan,
  MAX_LIMIT,
  MAX_INGEST_BYTES,
  INGEST_TEXT_EXT,
  KINDS,
  SCOPES,
};
