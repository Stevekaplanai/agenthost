// gemini-adapter.js -- Gemini as an API engine (router slice 4, 2026-07-31).
//
// WHY THIS REPLACED THE CLI (measured live on the box, not assumed): the same
// six-word prompt cost 11,305 input tokens through `gemini -p` (its own system
// prompt, tool definitions, and a two-model router: flash-lite + flash) versus
// 8 through the API. ~1400x, on a METERED key, every chat turn. The CLI's
// value is agentic file/tool work, which Gemini's chat path never used -- so
// chat moves to the API and Gemini becomes a cheap, fast workhorse instead of
// an engine too expensive to lean on (Steve, 2026-07-31: "Gemini should be a
// workhorse not sidelined").
//
// Everything here is PURE (no I/O, no clock): request-body construction and
// stream parsing, so the golden fixtures below are the real shapes captured
// from the live API and the tests need no network.

"use strict";

// Verified available on Steve's key 2026-07-31. flash is the workhorse tier:
// fast, cheap, and the same family the CLI was routing to anyway.
const GEMINI_MODEL = "gemini-3.5-flash";
const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/" +
  GEMINI_MODEL + ":streamGenerateContent?alt=sse";

// The request body. `system` rides systemInstruction (a real system slot, so
// the team charter never pollutes the visible conversation -- the same
// treatment Claude gets via --append-system-prompt, and better than the
// prepend-to-prompt hack the CLI path forced).
// `history` is prior turns as [{ role: "user"|"model", text }], oldest first:
// the API is stateless, so continuity is the caller replaying the thread.
function geminiRequestBody(opts) {
  const o = opts || {};
  const contents = [];
  for (const turn of Array.isArray(o.history) ? o.history : []) {
    const text = String((turn && turn.text) || "").trim();
    if (!text) continue;
    contents.push({ role: turn.role === "model" ? "model" : "user", parts: [{ text }] });
  }
  contents.push({ role: "user", parts: [{ text: String(o.prompt || "") }] });
  const body = { contents };
  if (o.system) body.systemInstruction = { parts: [{ text: String(o.system) }] };
  return body;
}

function geminiMakeState() { return { usage: null }; }

// One SSE line in -> the text to stream ("" for anything that isn't reply
// text). Captures usageMetadata onto state. Chunks routinely carry a part with
// an empty `text` plus a thoughtSignature -- those contribute nothing and must
// not be streamed. Non-data lines and unparseable payloads are dropped, never
// streamed raw.
function geminiLineTransform(line, state) {
  const s = String(line || "").trim();
  if (!s || !s.startsWith("data:")) return "";
  const payload = s.slice(5).trim();
  if (!payload || payload === "[DONE]") return "";
  let e;
  try { e = JSON.parse(payload); } catch { return ""; }
  if (e.usageMetadata && state) state.usage = e.usageMetadata;
  const cand = e.candidates && e.candidates[0];
  const parts = cand && cand.content && cand.content.parts;
  if (!Array.isArray(parts)) return "";
  return parts.map((p) => (p && typeof p.text === "string" ? p.text : "")).join("");
}

// usageMetadata -> the tracker's shape. thoughtsTokenCount is BILLABLE output
// (reasoning tokens) and is charged like candidates, so it must be counted --
// omitting it under-reports spend on a metered key. Gemini is API-key billed,
// so no per-turn USD is reported (plan: "key").
function geminiUsageFrom(usage) {
  if (!usage) return null;
  const num = (v) => (typeof v === "number" && isFinite(v) ? v : 0);
  return {
    inputTokens: num(usage.promptTokenCount),
    outputTokens: num(usage.candidatesTokenCount) + num(usage.thoughtsTokenCount),
    costUsd: null,
    plan: "key",
  };
}

// A blocked/empty answer explains itself rather than rendering as silence.
// finishReason SAFETY/RECITATION/MAX_TOKENS are the real ones seen in the wild.
function geminiFinishNote(reason) {
  if (!reason || reason === "STOP") return null;
  if (reason === "MAX_TOKENS") return "response hit the length limit";
  if (reason === "SAFETY") return "response blocked by Gemini's safety filter";
  if (reason === "RECITATION") return "response blocked as recitation";
  return "response ended early (" + String(reason).slice(0, 40) + ")";
}

// One tool-less review turn (the C1 fallback reviewer). `fetchImpl` is
// INJECTED so tests drive the real streaming/parse path with a fake stream —
// the PR-#127 lesson: a mock of the path proves nothing; the path itself must
// run. Resolves { text, usage } ONLY when the reply carried non-empty text;
// every other outcome — HTTP error, network failure, abort/timeout, a
// SAFETY-blocked or empty completion — resolves null so the caller's
// no-verdict handling parks the task for a human (fail closed, never fail
// approved).
async function geminiReviewOnce(fetchImpl, apiKey, prompt, opts) {
  const o = opts || {};
  const timeoutMs = o.timeoutMs || 5 * 60 * 1000;
  const body = geminiRequestBody({ system: o.system, prompt });
  const state = geminiMakeState();
  const abortController = new AbortController();
  const timer = setTimeout(() => { try { abortController.abort(); } catch {} }, timeoutMs);
  if (timer.unref) timer.unref();
  let text = "";
  try {
    const res = await fetchImpl(GEMINI_ENDPOINT, {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: abortController.signal,
    });
    if (!res || !res.ok) return null;
    let buf = "";
    for await (const chunk of res.body) {
      buf += Buffer.from(chunk).toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        text += geminiLineTransform(buf.slice(0, nl), state);
        buf = buf.slice(nl + 1);
      }
    }
    // Flush the remainder: a final data line without a trailing newline must
    // not silently drop the verdict. (The chat call sites share this gap;
    // fixing them rides a separate change.)
    if (buf) text += geminiLineTransform(buf, state);
    text = text.trim();
    if (!text) return null;
    return { text, usage: geminiUsageFrom(state.usage) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  GEMINI_MODEL,
  GEMINI_ENDPOINT,
  geminiRequestBody,
  geminiMakeState,
  geminiLineTransform,
  geminiUsageFrom,
  geminiFinishNote,
  geminiReviewOnce,
};
