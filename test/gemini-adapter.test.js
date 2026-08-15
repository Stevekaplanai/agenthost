// Gemini API adapter (gemini-adapter.js) — router slice 4.
//
// The fixtures below are REAL shapes captured from the live Gemini API using
// Steve's key on the box (2026-07-31), not invented: the streaming `data:`
// lines, the thoughtSignature part that carries empty text, and the
// usageMetadata block with its separate billable thoughtsTokenCount.
//
// Why this adapter exists at all is itself a measured fact: the same six-word
// prompt cost 11,305 input tokens through the `gemini -p` CLI versus 8 through
// the API — so chat moved to the API and Gemini became affordable to lean on.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as gem from "../container/gemini-adapter.js";

function runStream(lines) {
  const state = gem.geminiMakeState();
  let out = "";
  for (const l of lines) out += gem.geminiLineTransform(l, state);
  return { out, state };
}

// Real capture: text arrives in candidates[0].content.parts[].text, and a
// later chunk carries a part with text:"" plus a thoughtSignature.
const GOLDEN = [
  'data: {"candidates":[{"content":{"parts":[{"text":"Hello "}],"role":"model"},"index":0}]}',
  'data: {"candidates":[{"content":{"parts":[{"text":"from Gemini"}],"role":"model"},"index":0}]}',
  'data: {"candidates":[{"content":{"parts":[{"text":"","thoughtSignature":"EsAFCr0FARFNMg"}],"role":"model"},"index":0}]}',
  'data: {"candidates":[{"content":{"parts":[{"text":"!"}],"role":"model"},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":8,"candidatesTokenCount":1,"totalTokenCount":119,"thoughtsTokenCount":110}}',
];

test("gemini: golden stream yields exactly the reply text", () => {
  assert.strictEqual(runStream(GOLDEN).out, "Hello from Gemini!");
});

test("gemini: thoughtSignature parts contribute nothing (never streamed raw)", () => {
  const { out } = runStream(['data: {"candidates":[{"content":{"parts":[{"text":"","thoughtSignature":"EsAF"}],"role":"model"}}]}']);
  assert.strictEqual(out, "");
});

test("gemini: usage counts reasoning tokens as billable output", () => {
  const { state } = runStream(GOLDEN);
  // promptTokenCount=8 in; candidates(1) + thoughts(110) = 111 out. Dropping
  // thoughtsTokenCount would under-report spend on a metered key by ~100x here.
  assert.deepStrictEqual(gem.geminiUsageFrom(state.usage), {
    inputTokens: 8, outputTokens: 111, costUsd: null, plan: "key",
  });
  assert.strictEqual(gem.geminiUsageFrom(null), null, "no usage -> null, never a throw");
});

test("gemini: non-data lines, [DONE], and unparseable payloads are dropped", () => {
  assert.strictEqual(runStream([": keep-alive", "", "event: ping", "data: [DONE]", "data: {truncated"]).out, "");
});

test("gemini: the request body puts the charter in the real system slot", () => {
  const body = gem.geminiRequestBody({ system: "CHARTER TEXT", prompt: "hello" });
  assert.deepStrictEqual(body.systemInstruction, { parts: [{ text: "CHARTER TEXT" }] });
  assert.strictEqual(body.contents.length, 1);
  assert.deepStrictEqual(body.contents[0], { role: "user", parts: [{ text: "hello" }] });
  // no system supplied -> no systemInstruction key at all (not an empty one)
  assert.ok(!("systemInstruction" in gem.geminiRequestBody({ prompt: "x" })));
});

test("gemini: history is replayed oldest-first with the new prompt last", () => {
  const body = gem.geminiRequestBody({
    prompt: "and now?",
    history: [
      { role: "user", text: "first question" },
      { role: "model", text: "first answer" },
      { role: "user", text: "   " },        // blank turns are dropped
      { role: "weird", text: "coerced" },   // unknown role coerces to user
    ],
  });
  assert.deepStrictEqual(body.contents.map((c) => c.role), ["user", "model", "user", "user"]);
  assert.strictEqual(body.contents[0].parts[0].text, "first question");
  assert.strictEqual(body.contents[body.contents.length - 1].parts[0].text, "and now?");
});

test("gemini: an early finish explains itself instead of rendering as silence", () => {
  assert.strictEqual(gem.geminiFinishNote("STOP"), null);
  assert.strictEqual(gem.geminiFinishNote(null), null);
  assert.match(gem.geminiFinishNote("SAFETY"), /safety/i);
  assert.match(gem.geminiFinishNote("MAX_TOKENS"), /length/i);
  assert.match(gem.geminiFinishNote("WEIRD_NEW_REASON"), /ended early/i);
});

test("gemini: the workhorse model is a verified-available flash tier", () => {
  assert.strictEqual(gem.GEMINI_MODEL, "gemini-3.5-flash");
  assert.ok(gem.GEMINI_ENDPOINT.includes("streamGenerateContent?alt=sse"),
    "streaming endpoint so replies type out");
  assert.ok(gem.GEMINI_ENDPOINT.startsWith("https://"), "never plaintext");
});
