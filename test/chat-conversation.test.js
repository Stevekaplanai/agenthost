// Chat as a CONVERSATION, not a one-shot broadcast.
//
// The gate always records why an engine produced nothing. The generated thread
// must classify that durable explanation as a visible cause, and every engine
// must remain addressable through the one shared roster.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { teamPrompt } from "../container/gate.js";

const threadData = fs.readFileSync(path.join(import.meta.dirname, "..", "dashboard", "lib", "agenthost-data.ts"), "utf8");
const threadMessage = fs.readFileSync(path.join(import.meta.dirname, "..", "dashboard", "components", "agenthost", "thread-message.tsx"), "utf8");
const workspaceChat = fs.readFileSync(path.join(import.meta.dirname, "..", "dashboard", "components", "agenthost", "workspace-chat.tsx"), "utf8");
const gate = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");

test("the generated thread renders the gate's skip reason as a cause", () => {
  assert.match(threadData, /conversation paused\|no reply\|stream interrupted\|the box restarted\|agent took too long/,
    "durable failure text is classified instead of discarded");
  assert.match(threadData, /eventKind:\s*isYou \? "human" : isCause \? "cause"/,
    "cause classification reaches the rendered message model");
  assert.match(threadMessage, /kind === "cause" \? "bg-destructive\/12 text-destructive"/,
    "the visible badge names the message as a cause");
  assert.match(threadMessage, />\s*Cause\s*<\/button>/,
    "the explanation is a reachable cause target, not a blank bubble");
});
test("a skipped bubble is visually distinct from a real answer", () => {
  assert.match(threadMessage, /border-destructive\/35 bg-destructive\/10/,
    "cause UI carries a distinct destructive treatment");
  assert.match(threadMessage, /TriangleAlert/,
    "an icon makes the state visible without relying on color alone");
});

test("the gate really does send a reason on every skip path", () => {
  for (const reason of ["engine unavailable", "run error", "no response \\(timed out\\)"]) {
    assert.match(gate, new RegExp(reason), "gate reports '" + reason + "' as a skip reason");
  }
  assert.match(gate, /sse\(res, "engine_done", \{ eng: engId, usage: usage \|\| null, skipped: skipped \|\| null \}\)/,
    "engine_done carries the reason to the client");
});

test("every team prompt tells the engine the conversation continues", () => {
  const first = teamPrompt("help me fix the board", "claude", [], []);
  const later = teamPrompt("help me fix the board", "codex", [{ eng: "claude", text: "here is my read" }], []);
  for (const [label, prompt] of [["first engine", first], ["a later engine", later]]) {
    assert.match(prompt, /ongoing conversation/, label + " is told the exchange is ongoing");
    assert.match(prompt, /ASK HIM DIRECTLY/, label + " is told to ask rather than guess");
    assert.match(prompt, /Don't write a closing summary/, label + " is told not to sign off");
  }
});

test("the ongoing-conversation note comes last, after the task framing", () => {
  const prompt = teamPrompt("fix the board", "claude", [], []);
  assert.ok(prompt.lastIndexOf("ongoing conversation") > prompt.indexOf("Steve said:"),
    "the note follows the actual message, so it reads as guidance not preamble");
});

test("the shared thread still reaches every engine (multi-turn memory)", () => {
  const history = [
    { who: "steve", text: "the board is wrong" },
    { who: "claude", text: "which lane looks off?" },
  ];
  const prompt = teamPrompt("the queued lane", "codex", [], history);
  assert.match(prompt, /THE TEAM THREAD SO FAR/, "prior turns are carried forward");
  assert.match(prompt, /which lane looks off\?/, "including a teammate's earlier question");
  assert.match(prompt, /the board is wrong/, "and Steve's earlier message");
});

test("Kimi and Cursor stay addressable like every other teammate", () => {
  for (const engine of ["claude", "hermes", "codex", "gemini", "kimi", "cursor"]) {
    assert.match(threadData, new RegExp(`id: "${engine}"`), engine + " remains in the shared roster");
  }
  assert.match(workspaceChat, /\{chips\.map\(\(e\) => \(/,
    "the generated workspace renders every routable engine from one list");
  assert.match(workspaceChat, /leading @name routes the turn to that engine/,
    "typed mentions remain an explicit supported route");
});
