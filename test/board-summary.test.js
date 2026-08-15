// Board summary (slice 6 hardening).
//
// This block goes into every Kimi/Gemini system prompt. It used to be built by
// a SYNCHRONOUS execSync("hermes kanban list --json", {timeout: 5000}) on the
// chat hot path — freezing gate.js's single event loop, and with it every other
// live SSE stream, the health check, and cron, for up to five seconds per turn.
// It is now pure formatting over a background-refreshed cache. Because the
// formatting is pure, it is finally testable at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { formatBoardSummary } from "../container/gate.js";

const gate = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");

test("board: an empty board says empty, not unavailable", () => {
  assert.strictEqual(formatBoardSummary([]), "(board is empty)");
  assert.strictEqual(formatBoardSummary(null), "(board is empty)");
});

test("board: cards are grouped into lanes with ids, titles, and assignees", () => {
  const s = formatBoardSummary([
    { id: "t_1", title: "Ship the router", status: "running", assignee: "claude" },
    { id: "t_2", title: "Write the docs", status: "todo" },
    { id: "t_3", title: "Blocked thing", status: "blocked" },
    { id: "t_4", title: "Old thing", status: "done" },
    { id: "t_5", title: "Needs review", status: "review" },
  ]);
  assert.match(s, /RUNNING \(1\)/);
  assert.match(s, /QUEUED \(1\)/, "an unknown/todo status falls into queued");
  assert.match(s, /BLOCKED \(1\)/);
  assert.match(s, /DONE \(1\)/);
  assert.match(s, /REVIEW \(1\)/);
  assert.match(s, /t_1: Ship the router \[claude\]/, "assignee is shown when present");
  assert.match(s, /t_2: Write the docs\n/, "no empty bracket when unassigned");
});

test("board: a missing title never renders as blank", () => {
  assert.match(formatBoardSummary([{ id: "t_9", status: "todo" }]), /t_9: \(no title\)/);
});

test("board: the action contract is included so engines suggest instead of overriding", () => {
  const s = formatBoardSummary([{ id: "t_1", title: "x", status: "todo" }]);
  assert.match(s, /BOARD: done <id> <result>/);
  assert.match(s, /Suggest, do not override the PM/);
});

// ---- the hot-path contract -------------------------------------------------

test("gate: the board is NEVER fetched synchronously on a chat turn", () => {
  // Strip comment lines first: the fix's own explanation names execSync.
  const code = gate.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  assert.ok(!/execSync\(/.test(code),
    "no execSync in gate CODE — it blocks the single event loop that serves every live connection");
  const fn = gate.slice(gate.indexOf("function boardSummaryForContext"), gate.indexOf("function formatBoardSummary"));
  assert.ok(fn.includes("boardSummaryCache.text"), "the turn reads a cache");
  assert.ok(fn.includes("refreshBoardSummary()") && fn.includes("fire-and-forget"),
    "an aged cache refreshes in the background rather than making the turn wait");
});

test("gate: a broken board reports unavailable, never a false 'empty'", () => {
  const fn = gate.slice(gate.indexOf("function refreshBoardSummary"), gate.indexOf("function boardSummaryForContext"));
  assert.ok(fn.includes('"(board unavailable)"'),
    "a failed fetch must not be indistinguishable from a genuinely empty board");
  // hermesKanban resolves null on failure, so `tasks` stays null -> unavailable
  assert.ok(fn.includes("tasks ? formatBoardSummary(tasks) : \"(board unavailable)\""));
});

test("gate: the cache is primed at boot so the first turn isn't cold", () => {
  // The intent is unchanged: primed once at boot, kept warm on an interval. The
  // TRIGGER changed, and it had to.
  //
  // This used to pin the literal `setTimeout(..., 15 * 1000)`. Measured on the
  // box, that priming call never actually succeeded: the CLI cannot answer for
  // roughly the first 20 seconds after the gate starts, so the 15s call was
  // SIGKILLed at its 15s budget every boot. refreshBoardSummary then wrote
  // "(board unavailable)" into the very cache this test says is primed -- so the
  // assertion passed while the product did the opposite of what it promised.
  // That is precisely the "writing down a promise the product is not keeping"
  // this suite's regression gate warns about.
  //
  // Priming now waits on the shared boot readiness probe, so it runs when the
  // CLI can actually answer. See test/kanban-boot-readiness.test.js.
  assert.match(gate, /if \(probe && probe\.ready\) refreshBoardSummary\(\);/,
    "primed immediately ONLY when the CLI actually answered -- measured 2026-08-11, priming after a "
    + "not-ready probe fired a list into the same unready CLI and was SIGKILLed 15s later");
  // The properties the name actually promises, pinned independently of trigger:
  assert.match(gate, /setInterval\(refreshBoardSummary, BOARD_SUMMARY_TTL_MS\);/,
    "kept warm on an interval -- and this must stay UNCONDITIONAL, so a board that "
    + "comes up late still self-heals without a restart");
  assert.doesNotMatch(gate, /setTimeout\(\(\) => \{ refreshBoardSummary\(\)/,
    "and never re-scheduled on a wall clock that races the CLI's readiness window");
});
