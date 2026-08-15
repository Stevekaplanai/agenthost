"use strict";

const { StringDecoder } = require("node:string_decoder");
const {
  moonshotMakeState: openAiMakeState,
  moonshotLineTransform: openAiLineTransform,
} = require("./engine-adapters.js");

async function readOpenAiSse(body, onDelta, options = {}) {
  if (!body || typeof body[Symbol.asyncIterator] !== "function") {
    const error = new Error("provider stream is unavailable");
    error.kind = "stream";
    throw error;
  }
  const decoder = new StringDecoder("utf8");
  const makeState = typeof options.makeState === "function" ? options.makeState : openAiMakeState;
  const lineTransform = typeof options.lineTransform === "function" ? options.lineTransform : openAiLineTransform;
  const state = makeState();
  let buffered = "";
  const line = (raw) => {
    const text = lineTransform(raw, state);
    if (text) onDelta(text);
  };
  try {
    for await (const chunk of body) {
      buffered += decoder.write(Buffer.from(chunk));
      let newline;
      while ((newline = buffered.indexOf("\n")) !== -1) {
        line(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
      }
    }
    buffered += decoder.end();
    if (buffered.trim()) line(buffered);
    return state.usage;
  } catch (error) {
    if (!error.kind) error.kind = "stream";
    throw error;
  }
}

async function openAiCompatibleChat({
  origin,
  apiKey,
  model,
  messages,
  onDelta,
  signal,
  maxCompletionTokens = 4096,
  includeUsage = false,
  makeState,
  lineTransform,
  fetchFn = globalThis.fetch,
}) {
  const normalizedOrigin = String(origin).replace(/\/$/, "");
  const maxTokensField = normalizedOrigin === "https://api.deepseek.com/v1"
    ? "max_tokens"
    : "max_completion_tokens";
  const requestBody = {
    model,
    messages,
    stream: true,
    [maxTokensField]: maxCompletionTokens,
  };
  if (includeUsage) requestBody.stream_options = { include_usage: true };
  const response = await fetchFn(normalizedOrigin + "/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
    signal,
  });
  if (!response.ok) {
    const error = new Error("provider API error (HTTP " + response.status + ")");
    error.kind = "http";
    error.status = response.status;
    const retryAfter = response.headers && typeof response.headers.get === "function"
      ? response.headers.get("retry-after")
      : null;
    if (retryAfter) error.retryAfter = String(retryAfter).slice(0, 80);
    throw error;
  }
  return readOpenAiSse(response.body, onDelta, { makeState, lineTransform });
}

module.exports = { openAiCompatibleChat, readOpenAiSse };
