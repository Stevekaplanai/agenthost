// Guards for the room's two safety-critical promises. Both of these were
// FALSE when the pre-merge review checked them (2026-07-31), so they are
// pinned here rather than trusted to a comment.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { roomTeamPrompt } = require("../desktop/room/room-lib.js");
const ENGINES_SRC = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "desktop", "room", "room-engines.js"),
  "utf8"
);

// A source-level guard, deliberately narrow. It exists only to stop the
// ALLOW-list being swapped back for a deny-list; the actual read-only
// behaviour is proven by running the real CLI (see the handoff record), not
// here. A regex cannot verify behaviour — that lesson cost this build two
// undetected text-loss defects, and those paths are now covered by real
// execution in test/room-stream.test.js.
//
// Why an allow-list is the requirement: a deny-list must enumerate every
// current AND future tool. The first attempt denied Bash and a reviewer
// immediately ran `claude mcp list` through the room via the separate Windows
// PowerShell tool, which the list did not name.
test("the Claude spawn runs in plan mode and denies the dangerous tools", () => {
  assert.ok(/"--permission-mode", "plan"/.test(ENGINES_SRC),
    "plan mode is the structural control — it refuses actions whatever the allow-lists say");
  assert.ok(/"--disallowedTools"/.test(ENGINES_SRC),
    "the deny-list backstop must stay");
  for (const tool of ["Bash", "PowerShell", "Write", "Edit", "MultiEdit", "Task"]) {
    assert.ok(new RegExp('"' + tool + '"').test(ENGINES_SRC), tool + " must be denied");
  }
  assert.ok(!/"--allowedTools"/.test(ENGINES_SRC),
    "--allowedTools is ADDITIVE (it pre-approves) — using it removed the deny that was working");
  // The quoted form is what an argv push looks like; the flag is also named in
  // prose in the comment above it, which must not trip this guard.
  assert.ok(!/"--dangerously-skip-permissions"/.test(ENGINES_SRC),
    "the room must never PASS --dangerously-skip-permissions");
});

// A single long reply used to push a team prompt past Windows' 32,767-char
// command-line limit, so the NEXT engine failed to spawn (ENAMETOOLONG)
// instead of answering.
test("team prompts clip each reply so a long answer cannot break the next engine", () => {
  const huge = "x".repeat(50000);
  const prompt = roomTeamPrompt("go", "codex", [{ eng: "claude", text: huge }], []);
  assert.ok(prompt.length < 32000,
    "a team prompt must stay under the Windows command-line limit, got " + prompt.length);
  assert.ok(prompt.includes("CLAUDE replied"), "the reply is still present, just clipped");
});
