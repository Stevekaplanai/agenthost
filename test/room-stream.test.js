// REAL execution tests for the room's HTTP streaming path (runHttpSse in
// desktop/room/room-engines.js), which is how Kimi and Gemini answer.
//
// These replace regex-over-source "guards" that asserted the code was spelled
// a certain way and never ran it. Two text-loss defects lived inside the exact
// block those regexes claimed to cover (pre-merge review, 2026-07-31), so
// every case below drives the real function with a scripted stream.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { runHttpSse } = require("../desktop/room/room-engines.js");
const adapters = require("../container/engine-adapters.js");

// A fake fetch whose body yields the given chunks, optionally throwing after
// them. `abortAt` aborts the stream (the shape of Stop / timeout) after N
// chunks; `failAfter` throws a non-abort error (a dropped connection).
function scriptedFetch(chunks, opts = {}) {
  return async (_url, init) => ({
    ok: true,
    status: 200,
    body: (async function* () {
      let i = 0;
      for (const c of chunks) {
        yield Buffer.isBuffer(c) ? c : Buffer.from(c, "utf8");
        i++;
        if (opts.abortAt === i) {
          const err = new Error("aborted");
          err.name = "AbortError";
          throw err;
        }
        if (opts.failAfter === i) throw new TypeError("terminated");
      }
      if (opts.failAtEnd) throw new TypeError("terminated");
    })(),
    headers: { get: () => null },
  });
}

const sse = (text) => 'data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n';

function runKimiStream(chunks, opts) {
  const state = adapters.moonshotMakeState();
  const seen = [];
  return runHttpSse("http://test", {}, "{}", adapters.moonshotLineTransform, state,
    (t) => seen.push(t), { cancel: null }, scriptedFetch(chunks, opts)).then((r) => ({ ...r, seen }));
}

test("a complete stream returns its whole text and is not marked truncated", async () => {
  const out = await runKimiStream([sse("Hello "), sse("world")]);
  assert.equal(out.text, "Hello world");
  assert.equal(out.truncated, false);
});

test("an abort keeps the text that already arrived", async () => {
  const out = await runKimiStream([sse("Half an answ"), sse("er")], { abortAt: 1 });
  assert.equal(out.text, "Half an answ");
  // A room-initiated stop is disclosed by the caller, not here.
  assert.equal(out.truncated, false);
});

test("an abort ALSO keeps a final line whose newline never arrived", async () => {
  // The regression that shipped in the first attempt at this fix: the catch
  // block skipped the remainder flush, so a whole final data line -- or an
  // entire short reply arriving as one frame -- vanished and was reported as
  // "no reply".
  const noNewline = 'data: ' + JSON.stringify({ choices: [{ delta: { content: "Yes — ship it." } }] });
  const out = await runKimiStream([noNewline], { abortAt: 1 });
  assert.equal(out.text, "Yes — ship it.", "the buffered final line must survive the abort");
});

test("a dropped connection returns the fragment MARKED truncated", async () => {
  // Not an abort: the room did not stop this. Returning the fragment silently
  // would let half a sentence be posted as a finished answer and reasoned
  // from by the other engines in a team turn.
  const out = await runKimiStream([sse("Half an answ")], { failAfter: 1 });
  assert.equal(out.text, "Half an answ");
  assert.equal(out.truncated, true);
});

test("a failure with nothing to keep still throws", async () => {
  await assert.rejects(() => runKimiStream([], { failAtEnd: true }), /terminated/);
});

test("a multi-byte character split across chunks is not corrupted", async () => {
  // Proven live to corrupt before the fix: decoding each chunk on its own
  // destroys any character whose UTF-8 bytes straddle the boundary, and the
  // mangled text is then fsynced into the durable thread forever. Kimi is a
  // Chinese-capable model and every engine emits emoji.
  const line = Buffer.from(sse("你好 🎉 done"), "utf8");
  const cut = 20; // lands mid-character
  const out = await runKimiStream([line.subarray(0, cut), line.subarray(cut)]);
  assert.equal(out.text, "你好 🎉 done");
  assert.ok(!out.text.includes("�"), "no replacement characters may appear");
});

test("deltas reach the operator as they arrive, not only at the end", async () => {
  const out = await runKimiStream([sse("one "), sse("two")]);
  assert.deepEqual(out.seen, ["one ", "two"]);
});
