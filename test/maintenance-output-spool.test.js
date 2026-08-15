// Phase 1f Step 4a (piece 4): the worker output spool backing work.output.read.
// Pages are validated against the REAL protocol edge via
// protocol.validateResponse("work.output.read", ...) so the spool cannot drift
// from the contract (ordered seqs > afterSeq, total text <= limitBytes,
// nextSeq == last chunk cursor, durable-before-exposed).

import { test } from "node:test";
import assert from "node:assert/strict";
import protocol from "../container/maintenance-protocol.js";
import spoolMod from "../container/maintenance-output-spool.js";

const { createOutputSpool } = spoolMod;
const EPOCH = "gw_" + "a".repeat(32);
const REQ = "req_" + "b".repeat(32);
const W = "wrk_" + "a".repeat(24);

function validatePage(page, afterSeq, limitBytes) {
  const response = {
    v: 1, gatewayEpoch: EPOCH, requestId: REQ, ok: true, status: "success", code: "OK",
    summary: "ok.", rootCause: null, retry: { safe: false, afterMs: null }, stopCondition: null,
    nextActions: [], artifacts: [], data: page, serverTimeMs: 1,
  };
  return protocol.validateResponse("work.output.read", response, { requestId: REQ, gatewayEpoch: EPOCH, afterSeq, limitBytes });
}

test("append assigns strictly increasing seqs; read pages from the cursor", () => {
  const s = createOutputSpool();
  assert.equal(s.append(W, "hello "), 1);
  assert.equal(s.append(W, "world"), 2);
  const page = s.read({ workerRef: W, afterSeq: 0, limitBytes: 65_536 });
  assert.deepEqual(page.chunks.map((c) => c.seq), [1, 2]);
  assert.equal(page.nextSeq, 2);
  assert.equal(page.truncated, false);
  assert.equal(page.eof, false);
  validatePage(page, 0, 65_536);
});

test("byte limit truncates the page and reports truncated; the next cursor continues", () => {
  const s = createOutputSpool();
  s.append(W, "aaaa"); // 4 bytes, seq 1
  s.append(W, "bbbb"); // 4 bytes, seq 2
  const first = s.read({ workerRef: W, afterSeq: 0, limitBytes: 4 });
  assert.deepEqual(first.chunks.map((c) => c.seq), [1]);
  assert.equal(first.truncated, true);
  assert.equal(first.nextSeq, 1);
  validatePage(first, 0, 4);
  const second = s.read({ workerRef: W, afterSeq: 1, limitBytes: 4 });
  assert.deepEqual(second.chunks.map((c) => c.seq), [2]);
  validatePage(second, 1, 4);
});

test("eof is reported only once the reader has drained every chunk", () => {
  const s = createOutputSpool();
  s.append(W, "x");
  s.markEof(W);
  const mid = s.read({ workerRef: W, afterSeq: 0, limitBytes: 65_536 });
  assert.equal(mid.eof, true);
  const drained = s.read({ workerRef: W, afterSeq: 1, limitBytes: 65_536 });
  assert.deepEqual(drained.chunks, []);
  assert.equal(drained.eof, true);
  assert.equal(drained.nextSeq, 1);
  validatePage(drained, 1, 65_536);
});

test("durable-before-exposed: a persist throw fails closed and does not expose the chunk", () => {
  const s = createOutputSpool({ persist: () => { throw new Error("disk full"); } });
  assert.throws(() => s.append(W, "data"), /disk full/);
  const page = s.read({ workerRef: W, afterSeq: 0, limitBytes: 65_536 });
  assert.deepEqual(page.chunks, []);
});

test("redaction strips control characters before the chunk is exposed", () => {
  const s = createOutputSpool();
  s.append(W, "safe" + String.fromCharCode(7) + "bell" + String.fromCharCode(0)); // BEL + NUL stripped
  const page = s.read({ workerRef: W, afterSeq: 0, limitBytes: 65_536 });
  assert.equal(page.chunks[0].text, "safebell");
});

test("cursor validation fails closed on a bad afterSeq / limit", () => {
  const s = createOutputSpool();
  s.append(W, "x");
  assert.throws(() => s.read({ workerRef: W, afterSeq: 5, limitBytes: 100 }), (e) => e.code === "OUTPUT_CURSOR_INVALID");
  assert.throws(() => s.read({ workerRef: W, afterSeq: -1, limitBytes: 100 }), (e) => e.code === "OUTPUT_CURSOR_INVALID");
  assert.throws(() => s.read({ workerRef: W, afterSeq: 0, limitBytes: 0 }), (e) => e.code === "INVALID_REQUEST");
});

// --- large single write must not deadlock the stream (found hardening the
// activation lane): one worker stdout write can exceed a readable page, so append
// splits into pageable sub-chunks that read() can always emit. ---

test("a >64KiB single append splits into readable chunks; the stream fully drains", () => {
  const s = createOutputSpool();
  const big = "x".repeat(200_000); // ~200 KiB in one write — larger than any limitBytes
  s.append(W, big);
  s.markEof(W);
  // Drain with the MAX page size, exactly as the lane does.
  let afterSeq = 0, total = "", eof = false, pages = 0;
  while (!eof) {
    const page = s.read({ workerRef: W, afterSeq, limitBytes: 65_536 });
    validatePage(page, afterSeq, 65_536);
    assert.ok(page.chunks.length > 0, "every read must make progress (no unreadable chunk)");
    for (const c of page.chunks) total += c.text;
    afterSeq = page.nextSeq; eof = page.eof;
    if (pages++ > 100) throw new Error("stream did not drain");
  }
  assert.equal(total, big);
  assert.equal(total.length, 200_000);
});

test("no single spool chunk exceeds the readable page bound (invariant)", () => {
  const s = createOutputSpool();
  s.append(W, "y".repeat(100_000));
  const page = s.read({ workerRef: W, afterSeq: 0, limitBytes: 65_536 });
  for (const c of page.chunks) assert.ok(Buffer.byteLength(c.text, "utf8") <= 16 * 1024);
});

test("splitting never cuts a multi-byte code point", () => {
  const s = createOutputSpool();
  const emoji = "🙂"; // 4 UTF-8 bytes
  s.append(W, emoji.repeat(20_000)); // 80 KB, forces a split mid-run
  let afterSeq = 0, total = "", eof = false;
  s.markEof(W);
  while (!eof) { const p = s.read({ workerRef: W, afterSeq, limitBytes: 65_536 }); for (const c of p.chunks) total += c.text; afterSeq = p.nextSeq; eof = p.eof; }
  assert.equal(total, emoji.repeat(20_000)); // reassembles exactly — no replacement chars
});
