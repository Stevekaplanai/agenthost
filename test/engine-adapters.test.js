// Conformance tests for the Claude and Codex chat adapters (engine-adapters.js).
// Golden transcripts in -> expected streamed text, session identity, and usage
// out. These fixtures are the recorded event shapes the live CLIs emit (the
// same shapes documented and verified on the box in gate.js); if a CLI version
// bump changes its stream format, THESE tests fail first -- before the box
// silently streams nothing. Router build slice 1 (Rule 14 sweep, flag #1).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as adapters from "../container/engine-adapters.js";

// Mirror gate.js runChat's line-buffered loop: feed each fixture line through
// lineTransform with one state for the whole run, collect what would stream.
function runTranscript(makeState, lineTransform, lines) {
  const state = makeState();
  let out = "";
  for (const line of lines) out += lineTransform(line + "\n", state);
  return { out, state };
}

// ---- Claude golden transcript: stream-json + --include-partial-messages -----

const CLAUDE_GOLDEN = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "sess-1" }),
  JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } } }),
  JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo box" } } }),
  // signature deltas and other event kinds must be dropped, not streamed
  JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "signature_delta", signature: "sig" } } }),
  // the full assistant event repeats the delta text -- must NOT double it
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Hello box" }] } }),
  JSON.stringify({ type: "result", usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 42 }, total_cost_usd: 0.0123 }),
];

test("claude: golden transcript streams delta text exactly once", () => {
  const { out } = runTranscript(adapters.claudeMakeState, adapters.claudeLineTransform, CLAUDE_GOLDEN);
  assert.strictEqual(out, "Hello box");
});

test("claude: usage totals fresh + cache input, carries per-turn cost", () => {
  const { state } = runTranscript(adapters.claudeMakeState, adapters.claudeLineTransform, CLAUDE_GOLDEN);
  assert.deepStrictEqual(adapters.claudeUsageFrom(state), {
    inputTokens: 115, outputTokens: 42, costUsd: 0.0123, plan: "sub",
  });
});

test("claude: assistant fallback fires only when no delta ever streamed", () => {
  const noDeltas = [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Fallback reply" }, { type: "tool_use", name: "x" }] } }),
  ];
  const { out } = runTranscript(adapters.claudeMakeState, adapters.claudeLineTransform, noDeltas);
  assert.strictEqual(out, "Fallback reply");
});

test("claude: non-JSON and blank lines are dropped, never streamed raw", () => {
  const { out } = runTranscript(adapters.claudeMakeState, adapters.claudeLineTransform, [
    "", "   ", "not json at all", "{truncated",
  ]);
  assert.strictEqual(out, "");
});

test("claude: no result event -> no usage (never a throw)", () => {
  const { state } = runTranscript(adapters.claudeMakeState, adapters.claudeLineTransform, []);
  assert.strictEqual(adapters.claudeUsageFrom(state), null);
});

// ---- Codex golden transcript: `codex exec --json` ---------------------------

const CODEX_GOLDEN = [
  JSON.stringify({ type: "thread.started", thread_id: "0198c3f2-example-thread" }),
  JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "thinking..." } }),
  JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "ls" } }),
  JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Hi from codex" } }),
  JSON.stringify({ type: "turn.completed", usage: { input_tokens: 50, cached_input_tokens: 10, output_tokens: 7 } }),
];

test("codex: golden transcript emits only the agent message", () => {
  const { out } = runTranscript(adapters.codexMakeState, adapters.codexLineTransform, CODEX_GOLDEN);
  assert.strictEqual(out, "Hi from codex");
});

test("codex: thread id is captured as the session identity for resume", () => {
  const { state } = runTranscript(adapters.codexMakeState, adapters.codexLineTransform, CODEX_GOLDEN);
  assert.strictEqual(adapters.codexSessionFrom(null, "", state), "0198c3f2-example-thread");
});

test("codex: usage totals fresh + cached input, plan-billed (no per-turn $)", () => {
  const { state } = runTranscript(adapters.codexMakeState, adapters.codexLineTransform, CODEX_GOLDEN);
  assert.deepStrictEqual(adapters.codexUsageFrom(state), {
    inputTokens: 60, outputTokens: 7, costUsd: null, plan: "plan",
  });
});

test("codex: a rollout write failure blocks caching the thread id", () => {
  assert.strictEqual(adapters.codexSessionValid("2026-07-31 ERROR failed to record rollout items: disk full"), false);
  assert.strictEqual(adapters.codexSessionValid("all fine"), true);
  assert.strictEqual(adapters.codexSessionValid(""), true);
});

test("codex: a vanished rollout marks the cached session dead (self-healing)", () => {
  assert.strictEqual(adapters.codexDeadSession("Error: no rollout found for thread id 0198c3f2"), true);
  assert.strictEqual(adapters.codexDeadSession("some other error"), false);
});

test("codex: non-JSON lines are dropped, never streamed raw", () => {
  const { out } = runTranscript(adapters.codexMakeState, adapters.codexLineTransform, [
    "warning: plain text on stdout", "{bad json",
  ]);
  assert.strictEqual(out, "");
});

// ---- Hermes golden fixtures: `hermes chat -q <msg> -Q` ----------------------

test("hermes: the session id is captured from stderr (last match wins)", () => {
  const err = "some noise\nsession_id: 20260731_130145_a1b2c3\nmore noise\n";
  assert.strictEqual(adapters.hermesSessionFrom(null, err), "20260731_130145_a1b2c3");
  // a resumed turn prints again; the newest id is the one to carry forward
  const twice = "session_id: 20260731_130145_aaa\nsession_id: 20260731_140200_bbb\n";
  assert.strictEqual(adapters.hermesSessionFrom(null, twice), "20260731_140200_bbb");
});

test("hermes: no session line -> null (never a throw, never a bogus id)", () => {
  assert.strictEqual(adapters.hermesSessionFrom(null, "no id here"), null);
  assert.strictEqual(adapters.hermesSessionFrom(null, ""), null);
  assert.strictEqual(adapters.hermesSessionFrom(null, null), null);
  // a malformed id must NOT match -- resuming a garbage id poisons the thread
  assert.strictEqual(adapters.hermesSessionFrom(null, "session_id: not-a-real-id"), null);
});

test("hermes: the toolset warning is stripped from whole lines only", () => {
  assert.strictEqual(adapters.hermesClean("Warning: Unknown toolsets: foo\nreal reply\n"), "real reply\n");
  // the warning mid-sentence is real reply text and must survive
  assert.strictEqual(adapters.hermesClean("I saw Warning: Unknown toolsets: x inline\n"), "I saw Warning: Unknown toolsets: x inline\n");
  assert.strictEqual(adapters.hermesClean("clean reply"), "clean reply");
});

// ---- Cursor golden fixtures: ONE JSON object, possibly across many lines ----

test("cursor: a multi-line JSON object emits its result exactly once", () => {
  const lines = ['{\n', '  "type": "result",\n', '  "result": "Cursor says hello"\n', '}\n'];
  const state = adapters.cursorMakeState();
  const emitted = lines.map((l) => adapters.cursorLineTransform(l, state)).filter(Boolean);
  assert.deepStrictEqual(emitted, ["Cursor says hello"], "emitted once, only when the object completed");
  // a trailing flush must not re-emit (the emitted guard)
  assert.strictEqual(adapters.cursorLineTransform("", state), "");
});

test("cursor: an error object surfaces the reason instead of silence", () => {
  const s1 = adapters.cursorMakeState();
  assert.strictEqual(adapters.cursorLineTransform('{"is_error":true,"result":"rate limited"}', s1), "Cursor error: rate limited");
  const s2 = adapters.cursorMakeState();
  assert.strictEqual(adapters.cursorLineTransform('{"subtype":"error","error":{"message":"bad auth"}}', s2), "Cursor error: bad auth");
  const s3 = adapters.cursorMakeState();
  assert.strictEqual(adapters.cursorLineTransform('{"is_error":true}', s3), "Cursor error: unknown error");
});

test("cursor: a well-formed object with no result field says so, never blank", () => {
  const s = adapters.cursorMakeState();
  assert.strictEqual(adapters.cursorLineTransform('{"type":"result"}', s), "(cursor returned no result field)");
});

test("cursor: session id and usage are captured from the same object", () => {
  // Real shape captured off the box 2026-07-31. Both were being discarded:
  // every turn started amnesiac and ~26K input tokens/turn never reached the
  // cost strip.
  const s = adapters.cursorMakeState();
  const real = JSON.stringify({
    type: "result", subtype: "success", is_error: false, result: "pong",
    session_id: "c5c22da3-a26e-4311-aa27-25497934b1be",
    usage: { inputTokens: 26348, outputTokens: 29, cacheReadTokens: 5248, cacheWriteTokens: 0 },
  });
  assert.strictEqual(adapters.cursorLineTransform(real, s), "pong");
  assert.strictEqual(adapters.cursorSessionFrom(null, "", s), "c5c22da3-a26e-4311-aa27-25497934b1be");
  // cacheReadTokens is deliberately NOT added to input: with no contract saying
  // the fields are disjoint, summing could double-count and OVERSTATE spend.
  assert.deepStrictEqual(adapters.cursorUsageFrom(s), {
    inputTokens: 26348, outputTokens: 29, costUsd: null, plan: "key",
  });
});

test("cursor: a run with no session/usage degrades to null, never a throw", () => {
  const s = adapters.cursorMakeState();
  adapters.cursorLineTransform('{"result":"hi"}', s);
  assert.strictEqual(adapters.cursorSessionFrom(null, "", s), null);
  assert.strictEqual(adapters.cursorUsageFrom(s), null);
  assert.strictEqual(adapters.cursorUsageFrom(null), null);
});

test("cursor: partial/non-JSON output streams nothing raw", () => {
  const s = adapters.cursorMakeState();
  assert.strictEqual(adapters.cursorLineTransform('{"result": "half', s), "", "incomplete JSON is held, not streamed");
  assert.strictEqual(adapters.cursorLineTransform('Not logged in\n', adapters.cursorMakeState()), "",
    "a bare CLI error line is never streamed as an answer");
});

// ---- Kimi golden fixtures: Moonshot OpenAI-style SSE ------------------------

const MOONSHOT_GOLDEN = [
  'data: {"choices":[{"delta":{"role":"assistant"}}]}',
  'data: {"choices":[{"delta":{"content":"Hi "}}]}',
  'data: {"choices":[{"delta":{"content":"from kimi"}}]}',
  ': a comment line the server may send',
  'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":30,"completion_tokens":9}}',
  'data: [DONE]',
];

test("kimi: golden SSE streams only the delta text", () => {
  const { out } = runTranscript(adapters.moonshotMakeState, adapters.moonshotLineTransform, MOONSHOT_GOLDEN);
  assert.strictEqual(out, "Hi from kimi");
});

test("kimi: usage is captured from the stream and shaped for the tracker", () => {
  const { state } = runTranscript(adapters.moonshotMakeState, adapters.moonshotLineTransform, MOONSHOT_GOLDEN);
  assert.deepStrictEqual(adapters.kimiUsageFrom(state.usage), {
    inputTokens: 30, outputTokens: 9, costUsd: null, plan: "key",
  });
  assert.strictEqual(adapters.kimiUsageFrom(null), null, "no usage block -> null, never a throw");
});

test("kimi: [DONE], comments, and unparseable payloads never stream raw", () => {
  const { out } = runTranscript(adapters.moonshotMakeState, adapters.moonshotLineTransform, [
    "data: [DONE]", ": keep-alive", "", "data: {truncated", "event: ping",
  ]);
  assert.strictEqual(out, "");
});

// ---- DeepSeek golden fixture: OpenAI-compatible SSE with reasoning ----------

const DEEPSEEK_GOLDEN = [
  'data: {"choices":[{"delta":{"role":"assistant"}}]}',
  'data: {"choices":[{"delta":{"reasoning_content":"private chain of thought"}}]}',
  'data: {"choices":[{"delta":{"content":"Deep"}}]}',
  'data: {"choices":[{"delta":{"content":"Seek"}}]}',
  'data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":200,"prompt_tokens_details":{"cached_tokens":500}}}',
  'data: [DONE]',
];

test("deepseek: golden SSE streams answer text but never reasoning text", () => {
  const { out } = runTranscript(adapters.deepseekMakeState, adapters.deepseekLineTransform, DEEPSEEK_GOLDEN);
  assert.strictEqual(out, "DeepSeek");
  assert.doesNotMatch(out, /private chain of thought/);
});

test("deepseek: usage is shaped with the conservative peak-price cost", () => {
  const { state } = runTranscript(adapters.deepseekMakeState, adapters.deepseekLineTransform, DEEPSEEK_GOLDEN);
  assert.deepStrictEqual(adapters.deepseekUsageFrom(state.usage), {
    inputTokens: 1000,
    outputTokens: 200,
    costUsd: 0.000704,
    plan: "key",
  });
  assert.strictEqual(adapters.deepseekUsageFrom(null), null);
});

test("deepseek: an explicit final null usage invalidates an earlier usage object", () => {
  const { state } = runTranscript(adapters.deepseekMakeState, adapters.deepseekLineTransform, [
    'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}',
    'data: {"choices":[],"usage":null}',
    "data: [DONE]",
  ]);
  assert.strictEqual(state.usage, null,
    "central settlement must see null and full-charge instead of trusting the earlier counters");
});
