// engine-adapters.js -- the pure stream-parsing halves of the Claude and Codex
// chat adapters, extracted from gate.js's ENGINES registry (router build slice 1,
// 2026-07-31) so they can be conformance-tested directly: each engine's CLI
// stdout is an unstable API, and a version bump that changes the event shapes
// must fail a golden-transcript test here, not silently break chat on the box.
//
// EXTRACTION CONTRACT: these functions are byte-for-byte the logic that lived
// inline in gate.js (ENGINES.claude + ENGINES.codex). gate.js requires this
// module and wires the fields back into ENGINES; no behavior change. Spawn argv,
// env, cwd, sandbox/jail profiles, and everything process-shaped stays in
// gate.js -- this module is parsing only, so tests never need a box.
//
// The runner's calling convention (gate.js runChat, line-buffered path):
//   state = makeState()                    -- one per run, survives a retry
//   for each complete stdout line: emit(lineTransform(line, state))
//   on exit: sessionFrom(stdout, stderr, state) -> id to resume next turn
//            usageFrom(state) -> {inputTokens, outputTokens, costUsd, plan}
//            sessionValid(stderr) / deadSession(stderr) -> cache hygiene

"use strict";

const { conservativeUsageCostUsd } = require("./deepseek-budget.js");

// ---- Claude: `claude -p --output-format stream-json --include-partial-messages`
// emits a JSONL event stream WITH incremental text_delta chunks (verified on the
// box), so the reply types out token-by-token; the final `result` event carries
// usage + total_cost_usd for the tracker.

function claudeMakeState() { return { usage: null, streamed: false }; }

// Each stdout line is a claude stream-json event. Stream the incremental
// text_delta chunks (content_block_delta) so the reply types out; SKIP the
// full `assistant` events (the deltas already carried that text -- emitting
// both would double it). Capture the `result` event's usage. If no delta
// ever streamed (partial messages absent for some reason), fall back to the
// final assistant text so a reply is never lost. signature_delta / other
// events and non-JSON lines are dropped.
function claudeLineTransform(line, state) {
  const s = line.trim();
  if (!s) return "";
  let e;
  try { e = JSON.parse(s); } catch { return ""; }
  if (e.type === "stream_event" && e.event && e.event.type === "content_block_delta") {
    const d = e.event.delta || {};
    if (d.type === "text_delta" && d.text) { if (state) state.streamed = true; return d.text; }
    return "";
  }
  if (e.type === "assistant" && e.message && Array.isArray(e.message.content)) {
    // Fallback only: deltas already streamed this text unless none arrived.
    if (state && state.streamed) return "";
    return e.message.content.filter((b) => b.type === "text").map((b) => b.text || "").join("");
  }
  if (e.type === "result" && state) {
    state.usage = { raw: e.usage || null, costUsd: e.total_cost_usd };
  }
  return "";
}

function claudeUsageFrom(state) {
  const u = state && state.usage;
  if (!u || !u.raw) return null;
  const r = u.raw;
  // Total input = fresh + cache (cache reads/creates still count against the
  // window); output is output_tokens. Cost is the real per-turn USD claude
  // reports (subscription-covered, shown as tokens-first per the UI).
  const inTok = (r.input_tokens || 0) + (r.cache_creation_input_tokens || 0) + (r.cache_read_input_tokens || 0);
  return { inputTokens: inTok, outputTokens: r.output_tokens || 0, costUsd: u.costUsd, plan: "sub" };
}

// ---- Codex: `codex exec --json` emits a JSONL event stream. Emit ONLY the
// assistant text (item.completed / agent_message); capture thread.started's id
// and turn.completed's usage; drop every other event (reasoning, tool calls). A
// non-JSON line (shouldn't happen with --json) is dropped, not streamed raw.

// Per-run state: thread id (from stdout) for sessionFrom, and the usage
// block (from turn.completed) for usageFrom.
function codexMakeState() { return { threadId: null, usage: null }; }

function codexLineTransform(line, state) {
  const s = line.trim();
  if (!s) return "";
  let e;
  try { e = JSON.parse(s); } catch { return ""; }
  if (e.type === "thread.started" && e.thread_id && state) state.threadId = e.thread_id;
  if (e.type === "turn.completed" && e.usage && state) state.usage = e.usage;
  if (e.type === "item.completed" && e.item && e.item.type === "agent_message") {
    return e.item.text || "";
  }
  return "";
}

// input = fresh + cached input; Codex is ChatGPT-plan (subscription), so cost
// is tokens against quota -- no per-turn $ reported.
function codexUsageFrom(state) {
  const u = state && state.usage;
  if (!u) return null;
  return { inputTokens: (u.input_tokens || 0) + (u.cached_input_tokens || 0), outputTokens: u.output_tokens || 0, costUsd: null, plan: "plan" };
}

function codexSessionFrom(_out, _err, state) { return (state && state.threadId) || null; }

// Don't cache a thread id if Codex couldn't write its rollout (permission
// or disk error): resuming it later would fail with "no rollout found".
function codexSessionValid(err) { return !/failed to record rollout/i.test(err || ""); }

// A resume against a session whose rollout is gone -> drop the cached id and
// start fresh next turn (self-healing after a poisoned or pruned session).
function codexDeadSession(err) { return /no rollout found for thread id/i.test(err || ""); }

// ---- Hermes: `hermes chat -q <msg> -Q` prints its reply as plain text lines
// and its session id to STDERR. Continuity is by that id (-r <id> resumes), so
// the id capture is what makes a Hermes conversation survive across turns --
// and, since slice 1, across a gate restart (engine-sessions.js persists it).

// -Q prints "session_id: <YYYYMMDD_HHMMSS_hex>" to stderr. LAST match wins:
// if stderr carries more than one, the newest is the live session and an older
// one is stale -- resuming a stale id would silently fork the conversation.
// (The pre-extraction code documented "last match wins" but used a non-global
// .exec(), which returns the FIRST match -- a latent bug the golden
// conformance test caught during slice 3. Now it does what it says.)
function hermesSessionFrom(_out, err) {
  const all = String(err || "").match(/session_id:\s*[0-9]{8}_[0-9]{6}_[0-9a-f]+/g);
  if (!all || !all.length) return null;
  const m = /session_id:\s*([0-9]{8}_[0-9]{6}_[0-9a-f]+)/.exec(all[all.length - 1]);
  return m ? m[1] : null;
}

// Strip the known toolset warning Hermes prepends to stdout so it never shows
// in a chat bubble. Applied to WHOLE lines only (the caller buffers to line
// boundaries), so a warning split across stdout chunks can't leak.
function hermesClean(s) {
  return String(s)
    .replace(/^Warning: Unknown toolsets:.*[\r\n]+/gm, "")
    .replace(/^  ⚠ tirith security scanner enabled but not available.*[\r\n]+/gm, "");
}

// ---- Kimi (Moonshot): no CLI -- chat turns are HTTP against the Moonshot API,
// which streams OpenAI-style SSE: `data: {json}` lines, incremental text at
// choices[0].delta.content, a usage block on (usually) the final chunk, and a
// literal `data: [DONE]` terminator. Same state+lineTransform contract as the
// CLI engines so the conformance tests read identically.

function moonshotMakeState() { return { usage: null }; }

// One SSE line in -> the text to stream ("" for anything that isn't reply
// text). Captures usage onto state. Non-data lines, [DONE], and unparseable
// payloads are dropped, never streamed raw.
function moonshotLineTransform(line, state, captureExplicitUsage = false) {
  const s = String(line || "").trim();
  if (!s || !s.startsWith("data:")) return "";
  const payload = s.slice(5).trim();
  if (payload === "[DONE]") return "";
  let parsed;
  try { parsed = JSON.parse(payload); } catch { return ""; }
  if (state && (captureExplicitUsage
    ? parsed !== null && typeof parsed === "object" && Object.hasOwn(parsed, "usage")
    : parsed.usage)) state.usage = parsed.usage;
  const text = parsed.choices && parsed.choices[0] && parsed.choices[0].delta && parsed.choices[0].delta.content;
  return text || "";
}

// Moonshot reports OpenAI-shaped usage. Kimi is API-key billed, so per-turn
// cost is not reported by the API (plan: "key").
function kimiUsageFrom(obj) {
  if (!obj) return null;
  return { inputTokens: obj.prompt_tokens || 0, outputTokens: obj.completion_tokens || 0, costUsd: null, plan: "key" };
}

// ---- DeepSeek: the same SSE envelope, with a distinct conformance contract.
// DeepSeek can emit `reasoning_content`; moonshotLineTransform deliberately
// returns only `delta.content`, so private reasoning never enters a chat bubble,
// transcript, board artifact, or memory. Keeping the named adapter makes a
// provider shape change fail DeepSeek's own golden fixture rather than silently
// inheriting a Moonshot assumption.

function deepseekMakeState() { return moonshotMakeState(); }
function deepseekLineTransform(line, state) { return moonshotLineTransform(line, state, true); }

function deepseekUsageFrom(obj) {
  if (!obj) return null;
  return {
    inputTokens: obj.prompt_tokens || 0,
    outputTokens: obj.completion_tokens || 0,
    costUsd: conservativeUsageCostUsd(obj),
    plan: "key",
  };
}

// ---- Cursor: `cursor-agent -p --output-format json --mode ask` prints ONE
// JSON object (not JSONL) that may span many lines, so there is nothing to
// stream incrementally: buffer every line until the whole thing parses, then
// emit `result` exactly once. `emitted` guards the double-emit that would
// otherwise happen when both a mid-stream parse and the end-of-stream flush
// see a complete object.

function cursorMakeState() { return { buf: "", emitted: false, usage: null, sessionId: null }; }

function cursorLineTransform(line, state) {
  if (!state) return "";
  state.buf += line;
  if (state.emitted) return "";
  const trimmed = state.buf.trim();
  if (!trimmed) return "";
  let j = null;
  try { j = JSON.parse(trimmed); } catch { return ""; } // not complete yet
  state.emitted = true;
  // Capture continuity + spend from the same object (verified live 2026-07-31:
  // cursor-agent returns session_id and a usage block, and --resume <session_id>
  // genuinely resumes). Both were being thrown away: every Cursor turn started
  // amnesiac, and its ~26K input tokens per turn never reached the cost strip.
  if (typeof j.session_id === "string" && j.session_id) state.sessionId = j.session_id;
  if (j.usage && typeof j.usage === "object") state.usage = j.usage;
  if (j && (j.is_error === true || j.subtype === "error")) {
    const detail = typeof j.result === "string" ? j.result : (j.error && j.error.message) || "unknown error";
    return "Cursor error: " + detail;
  }
  return (j && typeof j.result === "string") ? j.result : "(cursor returned no result field)";
}

function cursorSessionFrom(_out, _err, state) { return (state && state.sessionId) || null; }

// cursor-agent reports {inputTokens, outputTokens, cacheReadTokens,
// cacheWriteTokens}. inputTokens reads as the total input for the turn, so we
// do NOT also add cacheReadTokens -- with no published contract saying they are
// disjoint, summing could DOUBLE-COUNT and overstate spend. Under-stating is
// the safer error here, and the cache figures stay available on state if a
// future doc settles it. Cursor is API-key billed, so no per-turn USD.
function cursorUsageFrom(state) {
  const u = state && state.usage;
  if (!u) return null;
  const num = (v) => (typeof v === "number" && isFinite(v) ? v : 0);
  return { inputTokens: num(u.inputTokens), outputTokens: num(u.outputTokens), costUsd: null, plan: "key" };
}

module.exports = {
  cursorMakeState,
  cursorLineTransform,
  cursorSessionFrom,
  cursorUsageFrom,
  claudeMakeState,
  claudeLineTransform,
  claudeUsageFrom,
  codexMakeState,
  codexLineTransform,
  codexUsageFrom,
  codexSessionFrom,
  codexSessionValid,
  codexDeadSession,
  hermesSessionFrom,
  hermesClean,
  moonshotMakeState,
  moonshotLineTransform,
  kimiUsageFrom,
  deepseekMakeState,
  deepseekLineTransform,
  deepseekUsageFrom,
};
