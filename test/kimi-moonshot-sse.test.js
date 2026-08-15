// Kimi / Moonshot SSE reader. Both Kimi call sites now use the shared
// OpenAI-compatible transport; this file keeps the original regression coverage
// that the reader exists, streams split frames, and returns usage.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { readOpenAiSse } from "../container/openai-compatible-chat.js";

const src = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");
const frame = (obj) => Buffer.from("data: " + JSON.stringify(obj) + "\n\n");
const delta = (content) => frame({ choices: [{ delta: { content } }] });

test("both Kimi chat paths use the shared OpenAI-compatible transport", () => {
  const oneToOne = src.slice(src.indexOf("function runKimiChat"), src.indexOf("function streamKimiTeam"));
  const team = src.slice(src.indexOf("function streamKimiTeam"), src.indexOf("// ---- N2:"));
  assert.equal((oneToOne.match(/openAiCompatibleChat\(\{/g) || []).length, 1, "1:1 calls the shared transport once");
  assert.equal((team.match(/openAiCompatibleChat\(\{/g) || []).length, 1, "Team calls the shared transport once");
  assert.equal((src.match(/fetch\("https:\/\/api\.moonshot\.ai\/v1\/chat\/completions"/g) || []).length, 0,
    "gate.js does not retain a private Moonshot transport");
});

test("reassembles content deltas into the full reply", async () => {
  let out = "";
  await readOpenAiSse(Readable.from([delta("Hel"), delta("lo, "), delta("Steve")]), (t) => { out += t; });
  assert.equal(out, "Hello, Steve");
});

test("captures the usage object from the final chunk", async () => {
  const usage = await readOpenAiSse(
    Readable.from([delta("hi"), frame({ choices: [{ delta: {} }], usage: { prompt_tokens: 11, completion_tokens: 2 } })]),
    () => {},
  );
  assert.deepEqual(usage, { prompt_tokens: 11, completion_tokens: 2 });
});

test("ignores [DONE], blank lines, and non-data lines", async () => {
  let out = "";
  await readOpenAiSse(
    Readable.from([Buffer.from(": keep-alive\n\n"), delta("a"), Buffer.from("\n"), Buffer.from("data: [DONE]\n\n")]),
    (t) => { out += t; },
  );
  assert.equal(out, "a", "only real content deltas are emitted");
});

test("survives a frame split across TCP chunk boundaries", async () => {
  // The network does not respect message boundaries -- a single SSE frame can
  // arrive in pieces. The reader buffers until it sees a newline.
  const whole = delta("split").toString("utf8");
  let out = "";
  await readOpenAiSse(
    Readable.from([Buffer.from(whole.slice(0, 12)), Buffer.from(whole.slice(12))]),
    (t) => { out += t; },
  );
  assert.equal(out, "split");
});

test("malformed JSON does not reject the stream (one bad frame is skipped)", async () => {
  let out = "";
  await readOpenAiSse(
    Readable.from([delta("good"), Buffer.from("data: {not json}\n\n"), delta("-still-here")]),
    (t) => { out += t; },
  );
  assert.equal(out, "good-still-here", "a corrupt frame must not kill the whole reply");
});
