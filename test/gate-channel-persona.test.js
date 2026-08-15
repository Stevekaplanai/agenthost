// Unit tests for the channel persona + secret-reporter pieces (container/gate.js,
// 2026-07-24): channelPersonaPrompt (fixes the live persona-leak defect -- Gemini
// answered a Telegram message as a TEAMMATE coordinating work), boardContextSummary
// (the reporter's compact snapshot), and channelAllowFromLocked (the CODE-ENFORCED
// precondition: board state only flows to a transport-locked channel). All three are
// hoisted, outer-const-free functions exported through gate.js's lib-mode block, so a
// direct import exercises the REAL code.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import gate from "../container/gate.js";
const { channelPersonaPrompt, boardContextSummary, channelAllowFromLocked } = gate;

test("channelPersonaPrompt carries the anti-committee rules + the user text, no board section by default", () => {
  const p = channelPersonaPrompt("telegram", "Restart the demo");
  assert.match(p, /answering the operator over telegram/);
  assert.match(p, /Do NOT delegate to, address, or @-mention/);
  assert.match(p, /Do NOT describe your sandbox/);
  assert.ok(p.endsWith("Restart the demo"), "the user's message is the LAST thing in the prompt");
  assert.equal(p.includes("board snapshot"), false, "no reporter section unless a summary is passed");
});

test("channelPersonaPrompt appends the board snapshot as READ-ONLY reporter context when provided", () => {
  const p = channelPersonaPrompt("telegram", "what's on the board?", "Board: 3 cards (2 todo, 1 running)");
  assert.match(p, /Private board snapshot/);
  assert.match(p, /Read-only/);
  assert.match(p, /Board: 3 cards/);
  assert.ok(p.indexOf("Board: 3 cards") < p.indexOf("what's on the board?"),
    "snapshot is context BEFORE the question, not after");
});

test("boardContextSummary: counts by status, capped card list, hard char ceiling", () => {
  const s = boardContextSummary([
    { id: "T1", status: "todo", title: "Ship the thing", assignee: "codex" },
    { id: "T2", status: "running", title: "Fix the other thing" },
    { id: "T3", status: "todo", title: "x" },
  ]);
  assert.match(s, /Board: 3 cards \(2 queued, 1 running\)/);
  assert.match(s, /- T1 \[queued \(todo\)\] Ship the thing @codex/);
  const many = boardContextSummary(Array.from({ length: 40 }, (_, i) => ({
    id: "T" + i, status: "todo", title: "t".repeat(80) })));
  assert.match(many, /and 28 more/);
  assert.ok(many.length <= 1650, "hard cap holds against a huge board");
  assert.equal(boardContextSummary([]), "Board: no cards.");
  assert.equal(boardContextSummary(null), "Board: no cards.");
});

// channelAllowFromLocked reads $HOME/.openclaw/openclaw.json -- point HOME at a fixture.
function withOpenclawConfig(cfg, fn) {
  const home = fs.mkdtempSync(path.join(import.meta.dirname, ".persona-"));
  const prev = process.env.HOME;
  try {
    fs.mkdirSync(path.join(home, ".openclaw"), { recursive: true });
    if (cfg !== undefined) fs.writeFileSync(path.join(home, ".openclaw", "openclaw.json"), JSON.stringify(cfg));
    process.env.HOME = home;
    return fn();
  } finally {
    process.env.HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("channelAllowFromLocked: locked accounts.default shape passes; missing/empty/blank allowFrom fails closed", () => {
  const locked = { channels: { telegram: { accounts: { default: { botToken: "x", allowFrom: ["447445626"] } } } } };
  assert.equal(withOpenclawConfig(locked, () => channelAllowFromLocked("telegram")), true);
  const noList = { channels: { telegram: { accounts: { default: { botToken: "x" } } } } };
  assert.equal(withOpenclawConfig(noList, () => channelAllowFromLocked("telegram")), false, "no allowFrom at all = open = not locked");
  const emptyList = { channels: { telegram: { accounts: { default: { allowFrom: [] } } } } };
  assert.equal(withOpenclawConfig(emptyList, () => channelAllowFromLocked("telegram")), false, "empty allowFrom = not locked");
  const blank = { channels: { telegram: { accounts: { default: { allowFrom: ["  "] } } } } };
  assert.equal(withOpenclawConfig(blank, () => channelAllowFromLocked("telegram")), false, "blank id = not locked");
});

test("channelAllowFromLocked: flat shape accepted; ONE unlocked account fails the whole channel; unreadable config fails closed", () => {
  const flat = { channels: { discord: { allowFrom: ["1515118344271954014"] } } };
  assert.equal(withOpenclawConfig(flat, () => channelAllowFromLocked("discord")), true);
  const mixed = { channels: { discord: {
    accounts: { default: { allowFrom: ["1"] }, second: { allowFrom: [] } } } } };
  assert.equal(withOpenclawConfig(mixed, () => channelAllowFromLocked("discord")), false,
    "one open account is an open door -- the whole channel counts as unlocked");
  assert.equal(withOpenclawConfig(undefined, () => channelAllowFromLocked("discord")), false, "no config file = not locked");
});
