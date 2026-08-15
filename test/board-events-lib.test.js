// Unit tests for container/board-events-lib.js -- the pure mapper from the
// kanban's task_events ledger to the audit-entry shape the Activities feed
// renders. Proving the mapping here proves the feed's board-content contract;
// gate.js's refresher only does I/O + calls boardEventEntries.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { boardEventEntry, boardEventEntries, KIND_EVENT } from "../container/board-events-lib.js";
import { levelFor, LABELS } from "../container/activity-lib.js";
const require = createRequire(import.meta.url);
const gate = require("../container/gate.js");

const T = 1785103867; // 2026-07-26T22:11:07Z

test("a created row maps to board_card_created with title, owner, and task id", () => {
  const e = boardEventEntry({
    task_id: "t_c758643c", kind: "created", created_at: T,
    payload: JSON.stringify({ assignee: "codex", status: "ready" }),
    title: "Draft baseline fixtures for the Gemini worktree", assignee: "codex",
  });
  assert.equal(e.event, "board_card_created");
  assert.equal(e.tid, "t_c758643c");
  assert.equal(e.eng, "codex", "the card's owner colors and scopes the row");
  assert.ok(e.detail.includes("Draft baseline fixtures"));
  assert.ok(e.detail.includes("→ codex"));
  assert.equal(e.t, new Date(T * 1000).toISOString());
});

test("a blocked row carries its reason and classifies AMBER downstream", () => {
  const e = boardEventEntry({
    task_id: "t_c758643c", kind: "blocked", created_at: T,
    payload: JSON.stringify({ reason: "autonomous run failed (Codex is unavailable for unattended work)" }),
    title: "Draft baseline fixtures", assignee: "codex",
  });
  assert.equal(e.event, "board_card_blocked");
  assert.ok(e.detail.includes("Codex is unavailable"));
  assert.equal(levelFor(e.event), "gate", "blocked cards show amber, not neutral");
});

test("done and claimed classify GREEN (work moving is good news)", () => {
  assert.equal(levelFor("board_card_done"), "pass");
  assert.equal(levelFor("board_card_claimed"), "pass");
});

test("every mapped event name has a human label in activity-lib", () => {
  for (const ev of Object.values(KIND_EVENT)) {
    assert.ok(LABELS[ev], ev + " must have a LABELS phrase — raw snake_case never reaches the feed");
  }
  assert.ok(LABELS.board_card_update, "the unknown-kind fallback is labeled too");
});

test("an unknown kanban verb still surfaces instead of disappearing", () => {
  const e = boardEventEntry({ task_id: "t_ab12cd34", kind: "some_future_verb", created_at: T, title: "X" });
  assert.equal(e.event, "board_card_update");
});

test("a comment authored by an engine is attributed to that engine", () => {
  const e = boardEventEntry({
    task_id: "t_ab12cd34", kind: "commented", created_at: T,
    payload: JSON.stringify({ author: "hermes", len: 153 }), title: "X", assignee: "codex",
  });
  assert.equal(e.eng, "hermes", "the actor beats the card owner for attribution");
});

test("Cursor-authored board events stay attributed to Cursor", () => {
  const e = boardEventEntry({
    task_id: "t_cursor", kind: "commented", created_at: T,
    payload: JSON.stringify({ author: "cursor", len: 42 }), title: "X", assignee: "codex",
  });
  assert.equal(e.eng, "cursor");
});

test("a human/default author falls back to the card owner, then to board", () => {
  const owned = boardEventEntry({ task_id: "t_ab12cd34", kind: "commented", created_at: T, payload: JSON.stringify({ author: "default" }), title: "X", assignee: "gemini" });
  assert.equal(owned.eng, "gemini");
  const orphan = boardEventEntry({ task_id: "t_ab12cd34", kind: "commented", created_at: T, payload: JSON.stringify({ author: "default" }), title: "X", assignee: null });
  assert.equal(orphan.eng, "board");
});

test("garbage never throws: bad payload, missing fields, junk rows drop or degrade", () => {
  assert.equal(boardEventEntry(null), null);
  assert.equal(boardEventEntry({ kind: "created" }), null, "no task id -> dropped");
  assert.equal(boardEventEntry({ task_id: "t_x", created_at: T }), null, "no kind -> dropped");
  const e = boardEventEntry({ task_id: "t_x", kind: "created", created_at: T, payload: "{not json", title: null });
  assert.equal(e.event, "board_card_created");
  assert.ok(e.detail.includes("(untitled card)"));
});

test("entries come back oldest-first regardless of input order (the feed builder expects ascending)", () => {
  const rows = [
    { task_id: "t_b", kind: "done", created_at: T + 60, title: "B" },
    { task_id: "t_a", kind: "created", created_at: T, title: "A" },
  ];
  const out = boardEventEntries(rows);
  assert.equal(out.length, 2);
  assert.equal(out[0].tid, "t_a");
  assert.equal(out[1].tid, "t_b");
});

// ---- Integration: through the REAL feed builder --------------------------
// Adversarial review 2026-07-27 caught the original gap this pins: the mapper,
// labels, cache, and merge were all correct and the feature was STILL a no-op,
// because ccFeedFromLines had no branch for board_card_* and silently dropped
// every row. A green mapping test must never again imply a visible feed row.

test("INTEGRATION: every board_card_* event survives the real ccFeedFromLines into a rendered row", () => {
  const T0 = "2026-07-26T22:11:07.000Z";
  const entries = Object.values(KIND_EVENT).map((ev, i) => ({
    t: new Date(Date.parse(T0) + i * 1000).toISOString(),
    event: ev, detail: "“Card ” → codex", eng: "codex", tid: "t_c758643c",
  }));
  entries.push({ t: new Date(Date.parse(T0) + 99000).toISOString(), event: "board_card_update", detail: "x", eng: "board", tid: "t_c758643c" });
  const feed = gate.ccFeedFromLines(entries);
  assert.equal(feed.length, entries.length, "every board event entry produces a feed row — none silently dropped");
  for (const row of feed) {
    assert.ok(row.what && !/board_card/.test(row.what), "rows carry human phrasing, never raw event names");
  }
});

test("INTEGRATION: a blocked board card renders as a bad/amber row with its task id; done renders done", () => {
  const feed = gate.ccFeedFromLines([
    { t: "2026-07-26T22:11:07.000Z", event: "board_card_blocked", detail: "“X” Codex is unavailable", eng: "codex", tid: "t_c758643c" },
    { t: "2026-07-26T22:12:07.000Z", event: "board_card_done", detail: "“X”", eng: "hermes", tid: "t_c758643c" },
  ]);
  const blocked = feed.find((r) => r.kind === "blocked");
  assert.ok(blocked, "blocked board card reaches the feed");
  assert.equal(blocked.bad, true);
  assert.equal(blocked.taskId, "t_c758643c");
  assert.ok(feed.some((r) => r.done === true), "done board card reaches the feed as done");
});

test("INTEGRATION: board rows merge with audit rows and keep engine attribution for the scope filter", () => {
  const feed = gate.ccFeedFromLines([
    { t: "2026-07-26T22:11:00.000Z", event: "chat_run", eng: "claude" },
    { t: "2026-07-26T22:11:07.000Z", event: "board_card_claimed", detail: "“X”", eng: "hermes", tid: "t_ab12cd34" },
  ]);
  assert.equal(feed.length, 2);
  const board = feed.find((r) => r.taskId === "t_ab12cd34");
  assert.equal(board.eng, "hermes", "the acting engine survives so the generated workspace's per-engine scoping shows the row");
});

test("long titles and reasons are clipped so a card can't flood the feed", () => {
  const e = boardEventEntry({ task_id: "t_x", kind: "blocked", created_at: T, title: "T".repeat(200), payload: JSON.stringify({ reason: "r".repeat(400) }) });
  assert.ok(e.detail.length < 200);
});
