// N2 v1 — engines answering each other in the shared thread.
//
// The routing decision (`mentionedEngine`) is a pure function and is EXPORTED,
// so these run it rather than reading its source. That is the part worth
// proving: it decides whether one engine's reply hands the floor to another,
// and every way it can be wrong is a way the box either goes silent or loops.
//
// The relay itself (lane acquisition, spend check, dispatch) lives inside
// runChat's completion path and is not exported; those properties are pinned by
// source assertions below and labelled as such rather than dressed up.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
// Only `mentionedEngine` is exported for behaviour. CONVO_MAX_TURNS is a const
// declared far below gate.js's module.exports line, so exporting it throws a TDZ
// ReferenceError at import — the exports object is built early and can only
// carry hoisted function declarations and constants defined above it. The cap's
// value is therefore pinned from source, below.
import { mentionedEngine, TEAM_ORDER } from "../container/gate.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const gate = fs.readFileSync(path.join(repoRoot, "container", "gate.js"), "utf8");

test("a reply that addresses another engine hands it the floor", () => {
  assert.equal(mentionedEngine("@hermes can you QA this diff before I push?", "claude"), "hermes");
  assert.equal(mentionedEngine("I think we need a second opinion — @gemini?", "claude"), "gemini");
  assert.equal(mentionedEngine("(@codex this is yours)", "hermes"), "codex",
    "a mention in parentheses still counts — engines write prose, not commands");
});

test("self-mention is never a relay", () => {
  // "I'll ask @claude to look" written BY claude must not hand the floor back to
  // claude. That is the shape of an infinite loop, and the turn cap should not
  // be the only thing standing between the box and one.
  assert.equal(mentionedEngine("I'll ask @claude to look at it", "claude"), null);
  assert.equal(mentionedEngine("@claude @hermes", "claude"), "hermes",
    "self-mention is skipped, not fatal — the next real engine still gets the floor");
});

test("only real engines are addressable", () => {
  assert.equal(mentionedEngine("@nobody take this", "claude"), null);
  assert.equal(mentionedEngine("email me @ steve@example.com", "claude"), null,
    "an email address is not an engine handle");
  assert.equal(mentionedEngine("costs @ 3am", "claude"), null);
  for (const e of TEAM_ORDER) {
    if (e === "claude") continue;
    assert.equal(mentionedEngine("hey @" + e + " look", "claude"), e, e + " is addressable");
  }
});

test("no mention means no relay — conversations are opt-in (Rule 1)", () => {
  assert.equal(mentionedEngine("Fixed it, tests pass, ready to merge.", "claude"), null,
    "an ordinary reply must not start a conversation nobody asked for");
  assert.equal(mentionedEngine("", "claude"), null);
  assert.equal(mentionedEngine(null, "claude"), null, "a null reply is not a crash");
});

test("the turn cap is four (Rule 2)", () => {
  assert.match(gate, /const CONVO_MAX_TURNS = 4;/,
    "four engine exchanges, then the floor returns to the operator");
});

// ---- source-pinned properties (the relay is not exported) -------------------

test("a human message resets the cap", () => {
  assert.match(gate, /function startChatRun\([^)]*\) \{\s*(?:\/\/[^\n]*\n\s*)*convoRelayTurns = 0;/,
    "the cap exists to return the floor to the operator, so the operator speaking is the reset — not a timer");
});

test("Stop halts the chain, not just the visible run (Rule 6)", () => {
  assert.match(gate, /audit\("chat_run_cancel_requested"[\s\S]{0,600}?stopConversation\("you stopped it"\)/,
    "cancelling a run also stops the relay chain — a relayed turn has no durable run id, so cancelling what the operator can see would otherwise leave the conversation running behind it");
});

test("every stop says why it stopped (Rule 9)", () => {
  // The defect this whole phase is about is work going quiet. A conversation
  // that ends must name its reason in the thread itself, not only the audit log.
  assert.match(gate, /function convoStop\(reason\) \{[\s\S]{0,300}appendTeamThread\("box", "\(conversation paused — " \+ reason/,
    "the reason lands in the shared transcript where the conversation is");
  for (const reason of [
    /engine turns without you/,        // turn cap
    /turned off in chat settings/,     // engine unavailable
    /chat spend cap is reached/,       // spend
    /agent lane is quarantined/,       // lane
    /agent lane is busy/,              // lane
    /had no reply/,                    // empty answer
  ]) {
    assert.match(gate, reason, "stop reason is named: " + reason);
  }
});

test("the relay reuses the existing spend governance, not a second budget", () => {
  assert.match(gate, /function relayEngineMention[\s\S]{0,1200}chatGov\.spendVerdict\(chatTodaySpend/,
    "a relay cannot spend past a cap an operator-typed turn would have respected");
  assert.match(gate, /function relayEngineMention[\s\S]{0,1400}acquireAgent\("chat"\)/,
    "a relay takes the same single agent lane as any other chat turn — it is not a way around the mutex");
});

test("API-backed engines relay through their fixed adapters and can continue the chain", () => {
  const start = gate.indexOf("function relayEngineMention(");
  const end = gate.indexOf("// Kick off the agent run", start);
  const relay = gate.slice(start, end);
  assert.ok(start >= 0 && end > start, "relay implementation is present");
  assert.match(relay, /to === "deepseek" \|\| to === "kimi" \|\| to === "gemini"/,
    "the API-backed roster is routed separately from process-backed engines");
  assert.match(relay, /runDeepSeekChat\(prompt, sink, token/);
  assert.match(relay, /runKimiChat\(prompt, sink, token/);
  assert.match(relay, /runGeminiChat\(prompt, sink, token/);
  assert.match(relay, /runChat\(prompt, true, sink, true, token/,
    "process-backed engines retain the existing contained chat path");

  for (const engine of ["deepseek", "kimi", "gemini"]) {
    assert.match(gate, new RegExp(`releaseAgent\\(token\\);[\\s\\S]{0,220}relayEngineMention\\(replyAll, "${engine}"`),
      `${engine} releases the shared lane before carrying its next @mention`);
  }
});
