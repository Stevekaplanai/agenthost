// The ONE shared transcript (router build slice 1).
//
// Before this slice, only Team (All) turns landed in the box-side thread;
// a directed message to Claude or Codex lived exclusively in one browser's
// localStorage -- other devices, other engines, and a box restart all lost it.
// These tests pin the slice's contract:
//
//  1. teamPrompt renders directed turns with their recipient ("STEVE (to
//     CODEX): ...") so a group turn reads the 1:1 exchanges correctly.
//  2. gate.js appends directed turns (message at dispatch, reply on clean
//     completion) with durable ids derived from the chat run id, and the
//     append is idempotent (at-least-once delivery must never double-post).
//  3. GET /chat/thread serves the transcript with ids, and the generated shell merges
//     it by id so every device renders the same conversation.
//
// teamPrompt is pure and exported, so its tests are real unit tests. The
// gate wiring and client merge are pinned as source contracts (same pattern
// as chat-conversation.test.js) because those paths need a live box to run.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { teamPrompt } from "../container/gate.js";

const gate = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");
const chatApi = fs.readFileSync(path.join(import.meta.dirname, "..", "dashboard", "lib", "api.ts"), "utf8");
const chatLive = fs.readFileSync(path.join(import.meta.dirname, "..", "dashboard", "lib", "live.ts"), "utf8");
const threadMessage = fs.readFileSync(path.join(import.meta.dirname, "..", "dashboard", "components", "agenthost", "thread-message.tsx"), "utf8");

// ---- 1. teamPrompt shows who a directed turn was aimed at -------------------

test("teamPrompt: a directed entry renders with its recipient", () => {
  const history = [
    { who: "steve", to: "codex", text: "please fix the failing test" },
    { who: "codex", text: "done, it was a stale fixture" },
  ];
  const p = teamPrompt("what's left?", "claude", [], history);
  assert.ok(p.includes("STEVE (to CODEX): please fix the failing test"),
    "directed message must carry its recipient in the thread");
  assert.ok(p.includes("CODEX: done, it was a stale fixture"),
    "the reply renders under the engine's own name");
});

test("teamPrompt: entries without `to` render exactly as before", () => {
  const history = [{ who: "steve", text: "hello team" }];
  const p = teamPrompt("q", "claude", [], history);
  assert.ok(p.includes("STEVE: hello team"), "undirected entries keep the old shape");
  assert.ok(!p.includes("(to "), "no recipient marker is invented");
});

// ---- 2. gate.js: directed turns join the transcript, idempotently -----------

test("gate: appendTeamThread dedups by id against the whole file (at-least-once safe)", () => {
  // The dedup must scan everything on disk, NOT loadTeamThread()'s
  // display-capped last-120 slice -- an id past the display window would
  // otherwise double-post (red-team finding, 2026-07-31).
  const migration = gate.slice(gate.indexOf("function ensureTeamThreadSequences"), gate.indexOf("// Entries one compatibility"));
  const fn = gate.slice(gate.indexOf("function appendTeamThread"), gate.indexOf("// Team chat always answers"));
  assert.ok(migration.includes('fs.readFileSync(file, "utf8")'),
    "the sequence migration reads the raw thread file");
  assert.ok(fn.includes("const current = ensureTeamThreadSequences(file)"),
    "dedup uses the whole migrated file rather than the display slice");
  assert.ok(fn.includes("teamThreadIdDecision(current.entries, o.id, o.meshReceipt || null)"),
    "dedup compares every retained on-disk entry's id and binds mesh receipts");
  assert.ok(fn.includes("entry.meshReceipt = meshReceipt"),
    "a mesh transcript row preserves its original fingerprint and receipt hash");
  assert.ok(!fn.slice(0, fn.indexOf("mkdirSync")).includes("loadTeamThread()."),
    "dedup never calls the display-capped loadTeamThread slice");
});

test("gate: a conversation turn that ends without an answer records the truth", () => {
  // Red-team finding: a failed/timed-out/cancelled/quarantined/interrupted
  // directed turn used to leave Steve's question orphaned in the shared
  // transcript, looking forever open (and feeding later team prompts as an
  // open question). Every terminal path now lands "(no reply — reason)" under
  // the same "-r" id a real reply would take, so exactly one outcome wins.
  assert.match(gate, /function noteNoReply\(reason\)/, "runChat has the no-reply recorder");
  for (const reason of ["could not start", "timed out", "cancelled", "run error"]) {
    assert.ok(gate.includes('noteNoReply("' + reason + '")'), "terminal path covered: " + reason);
  }
  assert.ok(gate.includes('"(no reply — chat lane quarantined)"'),
    "quarantine path records the no-reply truth");
  assert.ok(gate.includes('"(no reply — the box restarted mid-answer)"'),
    "a gateway restart marks interrupted directed turns in the transcript");
});

test("gate: a directed message is appended at dispatch with its recipient", () => {
  assert.match(gate, /appendTeamThread\("steve", msg, \{ id: res && res\.runId, to: eng\.label \}\);/,
    "startChatRun must record Steve's directed message with run-id + recipient");
});

test("gate: the engine's reply is appended only on clean completion of a conversation turn", () => {
  assert.match(gate, /if \(replyAll\.trim\(\) && res && res\.runId && res\.sharedTranscript\) \{\s*\n\s*try \{ appendTeamThread\(eng\.label, replyAll, \{ id: res\.runId \+ "-r" \}\); \} catch \{\}/,
    "runChat must append the completed reply under <runId>-r, gated on the conversation marker");
  const appendAt = gate.indexOf('appendTeamThread(eng.label, replyAll, { id: res.runId + "-r" })');
  const codeZeroAt = gate.indexOf("if (code === 0) {");
  assert.ok(codeZeroAt !== -1 && appendAt > codeZeroAt,
    "the reply append lives inside the code === 0 branch so an error can't pose as an answer");
});

test("gate: Kimi turns join the shared transcript on the same terms (slice 3)", () => {
  // Kimi has no CLI (it's an HTTP adapter), so it bypasses runChat -- before
  // slice 3 that meant its turns existed only in one browser's localStorage.
  const dispatch = gate.slice(gate.indexOf("function startChatRun"), gate.indexOf("// ---- Box: the operator lane"));
  assert.match(dispatch, /appendTeamThread\("steve", msg, \{ id: res && res\.runId, to: "kimi" \}\);/,
    "Steve's Kimi message lands with its recipient at dispatch");
  const kimi = gate.slice(gate.indexOf("function runKimiChat"), gate.indexOf("function streamKimiTeam"));
  assert.ok(kimi.includes('appendTeamThread("kimi", text, { id: res.runId + "-r" })'),
    "a completed Kimi reply lands under the standard reply id");
  assert.ok(kimi.includes('"(no reply — " + reason + ")"'),
    "a Kimi turn that ends without an answer records the truth");
  for (const reason of ["timed out", "stream error", "empty response", "cancelled"]) {
    assert.ok(kimi.includes('noteNoReply("' + reason + '")'), "terminal path covered: " + reason);
  }
  // The cancel path specifically: the close handler wins the settled-mutex race
  // on a real cancel, so it MUST write before confirming — otherwise a
  // cancelled Kimi turn leaves Steve's question orphaned (red-team 2026-07-31).
  const closeHandler = kimi.slice(kimi.indexOf('res.on("close"'), kimi.indexOf('res.on("close"') + 600);
  const noteAt = closeHandler.indexOf('noteNoReply("cancelled")');
  const confirmAt = closeHandler.indexOf("confirmChatCancellation(res)");
  assert.ok(noteAt !== -1 && confirmAt !== -1 && noteAt < confirmAt,
    "the cancel handler records the truth BEFORE confirming cancellation");
});

test("gate: Gemini runs on the API, never the CLI, in 1:1 AND team turns (slice 4)", () => {
  // Measured: the CLI spent 11,305 input tokens on a six-word prompt vs 8 via
  // the API. Both chat paths must use the adapter or a single "All" message
  // still burns CLI tokens on Gemini's segment.
  const dispatch = gate.slice(gate.indexOf("function startChatRun"), gate.indexOf("// ---- Box: the operator lane"));
  assert.match(dispatch, /appendTeamThread\("steve", msg, \{ id: res && res\.runId, to: "gemini" \}\);/,
    "a directed Gemini message joins the shared transcript");
  assert.ok(dispatch.includes("runGeminiChat(msg, res, acquireAgent(\"chat\"), tzOffsetMin)"),
    "1:1 Gemini turns route to the API runner");
  const seq = gate.slice(gate.indexOf("function runTeamSequential"), gate.indexOf("function runOneTeamTurn"));
  assert.ok(seq.includes("streamGeminiTeam("), "team segments use the API streamer too");
  assert.ok(gate.includes('chatAdapter: "gemini-api"'), "the engine entry declares the API adapter");
  // the CLI spawn must be unreachable for chat: dispatch never falls through to
  // runChat for gemini (the branch returns).
  const geminiBranch = dispatch.slice(dispatch.indexOf('engineId === "gemini"'));
  assert.ok(geminiBranch.indexOf("return;") < geminiBranch.indexOf("runChat("),
    "the gemini branch returns before any runChat/CLI path");
});

test("gate: Gemini team text uses the named engine_delta event (or the bubble reads '(no reply)')", () => {
  // The phone routes team-turn text into the per-engine bubble by the EVENT
  // NAME. An unlabeled frame lands in the single-engine accumulator, so the
  // bubble stays empty and renders "(no reply)" even on a perfect answer —
  // the reply would survive only server-side, invisible to Steve (red-team).
  const fn = gate.slice(gate.indexOf("function streamGeminiTeam"), gate.indexOf("function runKimiChat"));
  assert.ok(fn.includes('sse(res, "engine_delta", { eng: "gemini", t: text })'),
    "gemini team segments emit the named engine_delta event");
  assert.ok(!/sse\(res, null, text\)/.test(fn), "no unlabeled team frame remains");
  // and it defends the lease like its sibling streamer
  assert.ok(fn.includes("agentLeaseIsLive(token)"), "the team streamer validates the agent lease");
});

test("gate: boot wake skips provider-backed engines with the exact spend cause", () => {
  // A provider-backed wake turn is a paid inference call. None of these engines
  // may spend just because the box restarted; the audit must say that plainly.
  const round = gate.slice(gate.indexOf("function runWakeRound"), gate.indexOf("function runWakeRound") + 3000);
  const skipAt = round.indexOf('if (engId === "kimi" || engId === "cursor" || engId === "gemini" || engId === "deepseek")');
  const skipContinueAt = round.indexOf("continue;", skipAt);
  assert.ok(skipAt !== -1 && skipContinueAt > skipAt, "the bounded provider skip branch exists");
  const skipBranch = round.slice(skipAt, skipContinueAt + "continue;".length);
  for (const id of ["deepseek", "kimi", "gemini"]) {
    assert.ok(skipBranch.includes(`engId === "${id}"`), `${id} reaches the same unattended-boot skip branch`);
  }
  assert.ok(skipBranch.includes('engId + ": provider wake inference disabled to avoid unattended spend; use its governed chat adapter"'),
    "every provider skip names avoided unattended spend as its cause");
  assert.ok(skipBranch.includes('"cursor: unattended wake check disabled; use human-triggered chat"'),
    "Cursor's separate human-only cause remains explicit");
  assert.match(skipBranch, /audit\("wake_skip", reason, null, engId\);\s*continue;/,
    "the exact named cause is audited before the skipped engine exits the loop");
});

test("gate: an unsigned-in Cursor fails closed with an actionable message (slice 5)", () => {
  // Verified on the live box: cursor-agent is installed but "Not logged in",
  // and no CURSOR_API_KEY exists in the secret store — so a Cursor turn used to
  // spawn a doomed CLI, take the box's single agent slot, and return a raw
  // "Not logged in". The Command Center reported this honestly; chat did not.
  const dispatch = gate.slice(gate.indexOf("function startChatRun"), gate.indexOf("// ---- Box: the operator lane"));
  const preAt = dispatch.indexOf('eng.label === "cursor" && !cursorChatEnv().CURSOR_API_KEY');
  assert.ok(preAt !== -1, "the credential pre-flight exists");
  const acquireAt = dispatch.indexOf("runChat(msg, true, res, true, acquireAgent");
  assert.ok(acquireAt !== -1 && preAt < acquireAt,
    "it runs BEFORE the agent slot is acquired — an unusable engine must never wedge the single lane");
  const branch = dispatch.slice(preAt, preAt + 1200);
  assert.ok(/CURSOR_API_KEY to the box secrets/.test(branch), "the error tells Steve how to fix it");
  assert.ok(branch.includes('appendTeamThread("cursor", "(no reply — Cursor is not signed in on this box)"'),
    "and the transcript records the outcome, so the question never sits there looking open");
  assert.ok(branch.includes('audit("chat_run_unconfigured"'), "the refusal is audited");
});

test("gate: Gemini continuity is replayed from the shared transcript, bounded", () => {
  const fn = gate.slice(gate.indexOf("function geminiHistoryFromThread"), gate.indexOf("function runGeminiChat"));
  assert.ok(fn.includes('e.who === "steve" && e.to === "gemini"'), "Steve's gemini-directed turns are history");
  assert.ok(fn.includes('e.who === "gemini"'), "gemini's own replies are history");
  assert.ok(fn.includes("slice(-GEMINI_HISTORY_TURNS)"), "history is bounded so a long thread can't blow the prompt");
  assert.ok(fn.includes("e.wake"), "boot check-ins are excluded from conversation history");
});

test("gate: brain lookups and channel runs never join the conversation transcript", () => {
  // Four human-directed conversation sites live in startChatRun: DeepSeek,
  // Kimi, Gemini, and the process-backed fallback. A fifth marker belongs only
  // to the bounded API-to-API @mention relay. Brain and channel-persona runs
  // reuse runners without either marker, so their answers cannot become orphan
  // conversation replies.
  const sets = gate.match(/res\.sharedTranscript = true/g) || [];
  assert.strictEqual(sets.length, 4, "only the four human-directed turn sites may mark a response");
  const dispatch = gate.slice(gate.indexOf("function startChatRun"), gate.indexOf("// ---- Box: the operator lane"));
  const inDispatch = (dispatch.match(/res\.sharedTranscript = true/g) || []).length;
  assert.strictEqual(inDispatch, 4, "all four human-directed markers live in startChatRun");
  const relay = gate.slice(gate.indexOf("function relayEngineMention"), gate.indexOf("function startChatRun"));
  assert.strictEqual((relay.match(/sink\.sharedTranscript = true/g) || []).length, 1,
    "the only non-human marker is the bounded fixed-adapter API relay");
  const capAt = relay.indexOf("if (convoRelayTurns >= CONVO_MAX_TURNS)");
  const adapterAt = relay.indexOf('if (to === "deepseek" || to === "kimi" || to === "gemini")');
  const adapterReturnAt = relay.indexOf("return;", adapterAt);
  assert.ok(capAt !== -1 && adapterAt > capAt && adapterReturnAt > adapterAt,
    "the governed-adapter branch runs only after the bounded turn-cap check");
  const adapterBranch = relay.slice(adapterAt, adapterReturnAt + "return;".length);
  assert.match(adapterBranch, /to === "deepseek" \|\| to === "kimi" \|\| to === "gemini"/,
    "the relay marker stays limited to the three governed API adapters");
  assert.match(adapterBranch, /sink\.runId = nextRunId\("convorelay"\);\s*sink\.sharedTranscript = true;/,
    "the API relay receives a durable transcript id immediately before its conversation marker");
  const brain = gate.slice(gate.indexOf("function runBrain"), gate.indexOf("function runBrain") + 2000);
  assert.ok(!brain.includes("sharedTranscript"), "runBrain never marks a run as a conversation turn");
});

test("gate: the durable run id doubles as the transcript message id", () => {
  assert.match(gate, /runId: meta\.id,/,
    "run.res must expose the durable run id to the runners");
  assert.match(gate, /appendTeamThread\("steve", msg, \{ id: res && res\.runId \}\);/,
    "team turns carry the same idempotent id scheme");
  assert.match(gate, /appendTeamThread\(engId, outcome\.reply, \{\s*id: res && res\.runId \? res\.runId \+ "-r-" \+ engId : null,/,
    "team replies are id'd per engine");
});

// ---- 3. the transcript is served and merged by id ---------------------------

test("gate: GET /chat/thread serves the shared transcript with ids", () => {
  assert.match(gate, /url\.pathname === "\/chat\/thread" && req\.method === "GET"/,
    "the endpoint must exist");
  const route = gate.slice(gate.indexOf('url.pathname === "/chat/thread"'));
  assert.ok(route.slice(0, 700).includes("if (e.id) out.id = e.id;"),
    "entries must carry their durable id");
  assert.ok(route.slice(0, 700).includes("if (e.to) out.to = e.to;"),
    "directed entries must carry their recipient");
});

test("the generated client merges the server transcript by durable id", () => {
  assert.match(chatApi, /getJson\("\/chat\/thread"\)/, "the client must pull the shared transcript");
  assert.match(chatLive, /const persistedIds = new Set\(persisted\.map\(\(m\) => m\.id\)\)/,
    "durable ids form the deduplication boundary");
  assert.match(chatLive, /liveTurns\.filter\(\(m\) => !persistedIds\.has\(m\.id\)\)/,
    "an optimistic row disappears when its durable copy arrives");
  assert.match(chatLive, /id: handle\.runId,/,
    "this device's optimistic turn uses the same id the gate persists");
  assert.match(threadMessage, /message\.to && <TargetRecipient/,
    "another device's directed message renders its explicit recipient");
});
