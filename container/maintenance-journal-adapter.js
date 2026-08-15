"use strict";

// Dormant Foundation-B candidate: the D1 storage substrate — a SINGLE shared
// append-only journal that every durable store commits to (BUILD-PLAN Phase 1f;
// Steve's D1 decision, 2026-07-23: one append-only journal, not per-store files).
//
// One physical NDJSON file (`foundation.ndjson`, root-owned, via the native
// boundary `readFoundationJournal` / `appendFoundationJournalLine`) holds every
// store's records in a single total order — which is exactly what the §9 atomic
// multi-store commit needs. Records are type-tagged (`stop`/`budget`/`claim`/
// `run`/`audit`/`recovery`); this adapter hands each store a view filtered to its
// OWN type, so stores never cross-apply each other's records — independent of
// whether a given store's own `apply()` filters. It presents the exact
// `{ append, readAll }` shape the stores already consume.
//
// Fail-closed: a malformed line or an unreadable journal THROWS `STORE_UNAVAILABLE`,
// so a store's replay surfaces a hard failure rather than a silently truncated or
// gapped view. An append whose record does not carry the adapter's type is refused
// (a store can only write its own kind). DORMANT: not wired into any boot path; the
// composition root injects the real root-owned native at the atomic 1f cutover.

const KNOWN_TYPES = new Set(["stop", "budget", "claim", "run", "audit", "recovery"]);

class JournalAdapterError extends Error {
  constructor(code, message) { super(message); this.name = "JournalAdapterError"; this.code = code; }
}
function fail(code, message) { throw new JournalAdapterError(code, message); }

// createFoundationJournalAdapter({ native, type }) -> { append, readAll } scoped to
// `type` over the one shared journal. native = { readFoundationJournal():
// Buffer|null (throws STORE_UNAVAILABLE on error), appendFoundationJournalLine(Buffer) }.
function createFoundationJournalAdapter({ native, type } = {}) {
  if (!native || typeof native.readFoundationJournal !== "function" || typeof native.appendFoundationJournalLine !== "function") {
    throw new Error("journal adapter requires native { readFoundationJournal, appendFoundationJournalLine }");
  }
  if (!KNOWN_TYPES.has(type)) throw new Error(`journal adapter requires a known store type, got: ${String(type)}`);

  function append(record) {
    if (!record || typeof record !== "object" || Array.isArray(record)) fail("INVALID_REQUEST", "record must be an object");
    if (record.type !== type) fail("INVALID_REQUEST", `this journal view only writes type=${type}, got ${String(record.type)}`);
    let line;
    try { line = JSON.stringify(record); } catch { fail("INVALID_REQUEST", "record is not JSON-serializable"); }
    if (typeof line !== "string" || line.length === 0) fail("INVALID_REQUEST", "record serialized empty");
    // Defense in depth — JSON.stringify already escapes these, and the native
    // valid_line check rejects them, but never let a control char reach the fd.
    if (/[\n\r\0]/.test(line)) fail("INVALID_REQUEST", "serialized record contains a control character");
    native.appendFoundationJournalLine(Buffer.from(line, "utf8"));
  }

  function readAll() {
    const raw = native.readFoundationJournal(); // Buffer | null; throws STORE_UNAVAILABLE on read error
    if (raw === null || raw === undefined) return [];
    const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
    if (text.length === 0) return [];
    const out = [];
    for (const line of text.split("\n")) {
      if (line.length === 0) continue; // trailing newline / blank
      let record;
      try { record = JSON.parse(line); } catch { fail("STORE_UNAVAILABLE", "foundation journal contains a malformed line"); }
      if (record && record.type === type) out.push(record); // this store's records only
    }
    return out;
  }

  return Object.freeze({ append, readAll });
}

module.exports = { createFoundationJournalAdapter, JournalAdapterError, KNOWN_TYPES };
