// Tests for the Agent Room's pure helpers (desktop/room/room-lib.js): the
// ported team-prompt shapes (waterfall fix, budget clipping), the stateless-
// engine history mapping, and the loopback request guard that keeps a random
// browser tab from posting into the room.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ROOM_ORDER,
  roomRoster,
  roomSystem,
  withSystem,
  threadBlock,
  roomTeamPrompt,
  historyFor,
  requestAllowed,
} from "../desktop/room/room-lib.js";

test("roster is the plan's five, hermes last", () => {
  assert.deepEqual([...ROOM_ORDER], ["claude", "codex", "kimi", "gemini", "hermes"]);
});

test("ROOM_ENGINES leaves out the engines that can touch the machine", () => {
  // The README offers this as the way to get a room where nothing can act.
  assert.deepEqual(roomRoster("claude,kimi,gemini"), ["claude", "kimi", "gemini"]);
  assert.deepEqual(roomRoster("CLAUDE  KIMI"), ["claude", "kimi"], "case and spaces tolerated");
  assert.deepEqual(roomRoster(""), [...ROOM_ORDER], "unset means everyone");
  assert.deepEqual(roomRoster("nonsense"), [...ROOM_ORDER], "never produce an empty room");
  // Order always follows ROOM_ORDER, never the order typed.
  assert.deepEqual(roomRoster("hermes,claude"), ["claude", "hermes"]);
});

test("withSystem prepends the delimited block; empty system is a no-op", () => {
  const p = withSystem("standing orders", "the message");
  assert.ok(p.startsWith("<<< ROOM CONTEXT"));
  assert.ok(p.endsWith("the message"));
  assert.ok(p.includes("standing orders"));
  assert.equal(withSystem("", "just this"), "just this");
});

test("threadBlock keeps the NEWEST entries when over budget", () => {
  const history = [];
  for (let i = 0; i < 60; i++) history.push({ who: "steve", text: ("entry " + i + " ").repeat(40) });
  const block = threadBlock(history);
  assert.ok(block.length < 8000, "block stays near the 6K budget, got " + block.length);
  assert.ok(block.includes("entry 59"), "newest entry survives");
  assert.ok(!block.includes("entry 0 "), "oldest entry is dropped");
});

test("threadBlock labels directed turns but not team turns", () => {
  const block = threadBlock([
    { who: "steve", to: "codex", text: "just you" },
    { who: "steve", to: "everyone", text: "all of you" },
  ]);
  assert.ok(block.includes("STEVE (to CODEX): just you"));
  assert.ok(block.includes("STEVE: all of you"));
  assert.ok(!block.includes("(to EVERYONE)"));
});

test("team prompt: first engine gets the first-slot brief, later ones see this turn's replies", () => {
  const history = [{ who: "steve", text: "earlier" }];
  const first = roomTeamPrompt("what's the plan?", "claude", [], history);
  assert.ok(first.includes("answering FIRST this turn"));
  assert.ok(first.includes("THE ROOM THREAD SO FAR"));
  assert.ok(first.includes("what's the plan?"));

  const later = roomTeamPrompt("what's the plan?", "kimi", [{ eng: "claude", text: "ship it" }], history);
  assert.ok(later.includes("--- CLAUDE replied ---\nship it"));
  assert.ok(later.includes("do NOT restate"));
  assert.ok(!later.includes("answering FIRST"));
});

test("historyFor maps the engine's own turns to model, labels everyone else, merges runs", () => {
  const entries = [
    { who: "steve", to: "gemini", text: "hi gemini" },
    { who: "gemini", text: "hi Steve" },
    { who: "steve", text: "and the team said..." },
    { who: "codex", text: "codex thought" },
  ];
  const h = historyFor("gemini", entries, 40);
  assert.deepEqual(h.map((x) => x.role), ["user", "model", "user"]);
  assert.ok(h[0].text.startsWith("STEVE (to GEMINI): hi gemini"));
  assert.equal(h[1].text, "hi Steve");
  // the two trailing non-gemini entries merged into one user block, labeled
  assert.ok(h[2].text.includes("STEVE: and the team said..."));
  assert.ok(h[2].text.includes("CODEX: codex thought"));
});

test("roomSystem names the engine and forbids answering as a teammate", () => {
  const s = roomSystem("kimi");
  assert.ok(s.includes("You are kimi"));
  assert.ok(s.includes("never as a teammate"));
});

test("requestAllowed: loopback hosts pass, everything else is refused", () => {
  assert.ok(requestAllowed({ host: "127.0.0.1:7343" }));
  assert.ok(requestAllowed({ host: "localhost:7343" }));
  assert.ok(!requestAllowed({ host: "evil.example.com" })); // DNS rebinding
  assert.ok(!requestAllowed({})); // no Host at all
  assert.ok(requestAllowed({ host: "127.0.0.1:7343", origin: "http://127.0.0.1:7343" }));
  assert.ok(!requestAllowed({ host: "127.0.0.1:7343", origin: "https://evil.example.com" })); // cross-site POST
  assert.ok(!requestAllowed({ host: "127.0.0.1:7343", origin: "not a url" }));
});
