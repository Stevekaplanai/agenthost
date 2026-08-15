import assert from "node:assert/strict";
import { test } from "node:test";

import { openAiCompatibleChat } from "../container/openai-compatible-chat.js";
import adapters from "../container/engine-adapters.js";

function stream(lines) {
  return (async function* () {
    for (const line of lines) yield Buffer.from(line, "utf8");
  })();
}

test("OpenAI-compatible chat preserves Kimi's max_completion_tokens request field", async () => {
  let request = null;
  const deltas = [];
  const usage = await openAiCompatibleChat({
    origin: "https://api.moonshot.ai/v1",
    apiKey: "test-only-key",
    model: "example-model",
    messages: [{ role: "user", content: "hello" }],
    includeUsage: true,
    onDelta: (text) => deltas.push(text),
    fetchFn: async (url, init) => {
      request = { url, init };
      return {
        ok: true,
        body: stream([
          'data: {"choices":[{"delta":{"content":"hel"}}]}\n',
          'data: {"choices":[{"delta":{"content":"lo"}}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n',
          "data: [DONE]\n",
        ]),
      };
    },
  });

  assert.equal(request.url, "https://api.moonshot.ai/v1/chat/completions");
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.headers.Authorization, "Bearer test-only-key");
  assert.deepEqual(JSON.parse(request.init.body), {
    model: "example-model",
    messages: [{ role: "user", content: "hello" }],
    stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: 4096,
  });
  assert.deepEqual(deltas, ["hel", "lo"]);
  assert.deepEqual(usage, { prompt_tokens: 3, completion_tokens: 2 });
});

test("OpenAI-compatible chat preserves the provider HTTP status without leaking the key", async () => {
  await assert.rejects(
    openAiCompatibleChat({
      origin: "https://api.example.test/v1/",
      apiKey: "never-print-this-key",
      model: "example-model",
      messages: [],
      onDelta: () => {},
      fetchFn: async () => ({
        ok: false,
        status: 429,
        headers: { get: (name) => name.toLowerCase() === "retry-after" ? "7" : null },
        body: null,
      }),
    }),
    (error) => {
      assert.equal(error.status, 429);
      assert.equal(error.kind, "http");
      assert.equal(error.retryAfter, "7");
      assert.doesNotMatch(error.message, /never-print-this-key/);
      return true;
    },
  );
});

test("OpenAI-compatible chat sends DeepSeek's official max_tokens field and omits max_completion_tokens", async () => {
  let requestBody = null;
  let parserCalls = 0;
  const deltas = [];
  const usage = await openAiCompatibleChat({
    origin: "https://api.deepseek.com/v1",
    apiKey: "test-key",
    model: "deepseek-v4-flash",
    messages: [{ role: "user", content: "hello" }],
    maxCompletionTokens: 123,
    includeUsage: true,
    makeState: adapters.deepseekMakeState,
    lineTransform: (line, state) => {
      parserCalls += 1;
      return adapters.deepseekLineTransform(line, state);
    },
    onDelta: (text) => deltas.push(text),
    fetchFn: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return {
        ok: true,
        body: stream([
          'data: {"choices":[{"delta":{"reasoning_content":"hidden"}}]}\n',
          'data: {"choices":[{"delta":{"content":"visible"}}]}\n',
          'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n',
          "data: [DONE]\n",
        ]),
      };
    },
  });
  assert.equal(requestBody.max_tokens, 123);
  assert.equal(Object.hasOwn(requestBody, "max_completion_tokens"), false);
  assert.ok(parserCalls >= 3, "the provider-specific parser handles the DeepSeek frames");
  assert.deepEqual(deltas, ["visible"]);
  assert.deepEqual(usage, { prompt_tokens: 5, completion_tokens: 2 });
});

test("OpenAI-compatible chat names a provider stream transport failure", async () => {
  const brokenStream = (async function* () {
    throw new Error("socket reset by provider");
  })();
  await assert.rejects(
    openAiCompatibleChat({
      origin: "https://api.example.test/v1",
      apiKey: "test-only-key",
      model: "example-model",
      messages: [],
      onDelta: () => {},
      fetchFn: async () => ({ ok: true, body: brokenStream }),
    }),
    (error) => error && error.kind === "stream" && /socket reset by provider/.test(error.message),
  );
});
