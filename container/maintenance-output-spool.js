"use strict";

// Dormant Foundation-B candidate: the worker output spool (BUILD-PLAN Phase 1f,
// Step 4a — piece 4) backing IPC work.output.read. Contract §6: "PID 1 redacts
// and durably appends each root-owned output chunk before advancing the exposed
// cursor. No volatile-only success and no spool path." Each governed worker's
// stdout/stderr arrives as ordered chunks; this spool assigns each a strictly
// increasing seq, and read() returns a byte-bounded forward page exactly matching
// the work.output.read success shape { chunks:[{seq,text}], nextSeq, eof, truncated }.
//
// The durable append is injected (the root-owned journal at activation); tests
// use an in-memory sink. DORMANT: no boot wiring.

const CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
// Every spool chunk must be smaller than the max work.output.read page
// (limitBytes ≤ 65536) or read() can never emit it ("limitBytes smaller than the
// next chunk") and the stream deadlocks. A single worker stdout write can far
// exceed that (a real `claude -p` easily emits >64 KiB at once), so append splits
// on code-point boundaries into ≤16 KiB sub-chunks — small enough that even a
// modest limitBytes pages several per read.
const MAX_CHUNK_BYTES = 16 * 1024;

// Split `text` into pieces each ≤ maxBytes of UTF-8, never cutting a code point
// (iterating a string yields whole code points; the largest is 4 bytes, so no
// single piece can exceed maxBytes as long as maxBytes ≥ 4).
function splitByBytes(text, maxBytes) {
  const parts = [];
  let cur = "", curBytes = 0;
  for (const ch of text) {
    const b = Buffer.byteLength(ch, "utf8");
    if (curBytes + b > maxBytes && cur.length) { parts.push(cur); cur = ""; curBytes = 0; }
    cur += ch; curBytes += b;
  }
  if (cur.length) parts.push(cur);
  return parts;
}

class OutputSpoolError extends Error {
  constructor(code, message) { super(message); this.name = "OutputSpoolError"; this.code = code; }
}
function fail(code, message) { throw new OutputSpoolError(code, message); }

function utf8Bytes(s) { return Buffer.byteLength(s, "utf8"); }

// createOutputSpool({ persist?, redact? })
//   persist(workerRef, {seq,text}) : durable append, called BEFORE the chunk is
//     readable (fail-closed: a throw means the chunk is not exposed).
//   redact(text) -> text           : redaction pass (default strips control chars).
function createOutputSpool({ persist = null, redact = null } = {}) {
  const chunksByWorker = new Map(); // workerRef -> [{seq,text}]
  const eofByWorker = new Map();    // workerRef -> bool
  const scrub = typeof redact === "function" ? redact : (t) => t.replace(CONTROL_RE, "");

  function append(workerRef, text) {
    if (typeof workerRef !== "string" || workerRef.length === 0) fail("INVALID_REQUEST", "workerRef required");
    if (typeof text !== "string") fail("INVALID_REQUEST", "output text must be a string");
    if (eofByWorker.get(workerRef)) fail("OUTPUT_UNAVAILABLE", "worker output is already at eof");
    const list = chunksByWorker.get(workerRef) || [];
    const clean = scrub(text);
    if (clean.length === 0) return list.length; // nothing to expose; cursor unchanged
    // One write may exceed a single readable page; split so every chunk is
    // pageable. Each sub-chunk is durable BEFORE it is exposed (persist then push);
    // a persist throw fails closed with the earlier sub-chunks already durable.
    for (const part of splitByBytes(clean, MAX_CHUNK_BYTES)) {
      const seq = list.length + 1; // 1-based, strictly increasing per worker
      const chunk = { seq, text: part };
      if (persist) persist(workerRef, chunk);
      list.push(chunk);
    }
    chunksByWorker.set(workerRef, list);
    return list.length; // highest seq now readable
  }

  function markEof(workerRef) { eofByWorker.set(workerRef, true); }

  // read({ workerRef, afterSeq, limitBytes }) -> { chunks, nextSeq, eof, truncated }
  function read({ workerRef, afterSeq, limitBytes } = {}) {
    if (typeof workerRef !== "string" || workerRef.length === 0) fail("INVALID_REQUEST", "workerRef required");
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) fail("OUTPUT_CURSOR_INVALID", "afterSeq must be a non-negative safe integer");
    if (!Number.isSafeInteger(limitBytes) || limitBytes < 1 || limitBytes > 65_536) fail("INVALID_REQUEST", "limitBytes must be 1..65536");
    const list = chunksByWorker.get(workerRef) || [];
    if (afterSeq > list.length) fail("OUTPUT_CURSOR_INVALID", "afterSeq is beyond the spool");
    const out = [];
    let bytes = 0;
    let i = afterSeq; // list is 0-indexed; chunk at index k has seq k+1
    let truncated = false;
    for (; i < list.length; i++) {
      const c = list[i];
      const b = utf8Bytes(c.text);
      if (bytes + b > limitBytes) {
        if (out.length === 0) fail("INVALID_REQUEST", "limitBytes is smaller than the next chunk");
        truncated = true;
        break;
      }
      out.push({ seq: c.seq, text: c.text });
      bytes += b;
    }
    const consumedAll = i >= list.length;
    const nextSeq = out.length ? out[out.length - 1].seq : afterSeq;
    const eof = consumedAll && eofByWorker.get(workerRef) === true;
    return { chunks: out, nextSeq, eof, truncated };
  }

  return Object.freeze({ append, markEof, read });
}

module.exports = { createOutputSpool, OutputSpoolError };
