// Behavior tests for the C1 fallback reviewer's real path — fetch is
// injected, so these drive the actual streaming/parse/settlement logic, not a
// regex of its source. This is the red team's demand and the PR-#127 lesson:
// a fail-open path once survived eight passing tests because nothing
// exercised the real code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const adapter = require("../container/gemini-adapter.js");

function sseBody(chunks) {
  // An async-iterable body like undici's — yields Buffers.
  return (async function* () {
    for (const c of chunks) yield Buffer.from(c, "utf8");
  })();
}

function sseData(obj) {
  return "data: " + JSON.stringify(obj) + "\n";
}

const verdictEvent = (text) => ({ candidates: [{ content: { parts: [{ text }] } }] });
const usageEvent = {
  candidates: [{ content: { parts: [{ text: "" }] } }],
  usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 40, thoughtsTokenCount: 10 },
};

test("a streamed reply resolves { text, usage } — including a final line WITHOUT a trailing newline", async () => {
  const fakeFetch = async () => ({
    ok: true,
    body: sseBody([
      sseData(verdictEvent("VERDICT: REJ")),
      // A frame split across two TCP chunks reassembles...
      "data: " + JSON.stringify(usageEvent).slice(0, 20),
      JSON.stringify(usageEvent).slice(20) + "\n",
      // ...and the FINAL frame arrives WITHOUT a trailing newline: the flush
      // must still deliver it or the verdict is silently dropped.
      sseData(verdictEvent("ECT\nreason: incomplete work")).trimEnd(),
    ]),
  });
  const result = await adapter.geminiReviewOnce(fakeFetch, "k", "review this", {});
  assert.ok(result, "a real reply resolves an object");
  assert.match(result.text, /VERDICT: REJECT/, "text split across frames and the unterminated tail reassembles");
  assert.equal(result.usage.inputTokens, 120);
  assert.equal(result.usage.outputTokens, 50, "candidates + thoughts tokens both count (billable)");
});

test("an empty or SAFETY-blocked completion resolves null, never a truthy empty", async () => {
  const fakeFetch = async () => ({
    ok: true,
    body: sseBody([sseData({ candidates: [{ finishReason: "SAFETY", content: { parts: [] } }] })]),
  });
  assert.equal(await adapter.geminiReviewOnce(fakeFetch, "k", "p", {}), null);
});

test("a non-2xx response resolves null", async () => {
  const fakeFetch = async () => ({ ok: false, status: 429 });
  assert.equal(await adapter.geminiReviewOnce(fakeFetch, "k", "p", {}), null);
});

test("a network failure resolves null (never rejects past the caller)", async () => {
  const fakeFetch = async () => { throw new Error("ECONNRESET"); };
  assert.equal(await adapter.geminiReviewOnce(fakeFetch, "k", "p", {}), null);
});

test("a stream that dies mid-body resolves null", async () => {
  const fakeFetch = async () => ({
    ok: true,
    body: (async function* () {
      yield Buffer.from(sseData(verdictEvent("partial")), "utf8");
      throw new Error("stream reset");
    })(),
  });
  assert.equal(await adapter.geminiReviewOnce(fakeFetch, "k", "p", {}), null);
});

test("the timeout aborts a stalled request and settles null", async () => {
  const fakeFetch = (url, opts) =>
    new Promise((_, reject) => {
      opts.signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
  const result = await adapter.geminiReviewOnce(fakeFetch, "k", "p", { timeoutMs: 50 });
  assert.equal(result, null, "a hung fetch cannot hold the review slot past the timeout");
});

test("the request carries the key as a header and no tools field", async () => {
  let seen = null;
  const fakeFetch = async (url, opts) => {
    seen = { url, opts };
    return { ok: true, body: sseBody([sseData(verdictEvent("VERDICT: REJECT\nx"))]) };
  };
  await adapter.geminiReviewOnce(fakeFetch, "secret-key", "prompt", { system: "charter" });
  assert.equal(seen.opts.headers["x-goog-api-key"], "secret-key", "key rides a header, never argv");
  const body = JSON.parse(seen.opts.body);
  assert.equal(body.tools, undefined, "the reviewer request never grants tools — injection-inert by construction");
  assert.equal(body.systemInstruction.parts[0].text, "charter");
});
