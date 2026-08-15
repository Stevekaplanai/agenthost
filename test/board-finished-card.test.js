import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { boardCardIsFinished, boardTaskFromShow, promotePostcondition, BOARD_TERMINAL_STATES } = require("../container/gate.js");

// `hermes kanban show --json` returns an ENVELOPE. The pre-check that guards
// the review path read .status straight off the parse, which made status always
// "" -- the guard existed but could never fire. These tests pin the envelope
// shape so that regression cannot come back silently.
const envelope = (task) => JSON.stringify({ ok: true, task });
const bare = (task) => JSON.stringify(task);

test("terminal states are exactly the states promotePostcondition can never accept", () => {
  for (const status of BOARD_TERMINAL_STATES) {
    assert.equal(promotePostcondition({ status }), false, `${status} must not read as runnable`);
  }
  assert.deepEqual(BOARD_TERMINAL_STATES, ["done", "completed", "archived"]);
});

test("finished check reads through the show envelope, not off it", () => {
  for (const status of BOARD_TERMINAL_STATES) {
    assert.equal(boardCardIsFinished(envelope({ id: "t_a7d65836", status }), "t_a7d65836"), true, `envelope/${status}`);
  }
  // The regression itself: pre-fix this returned false for every finished card.
  assert.equal(boardTaskFromShow(envelope({ id: "t_a7d65836", status: "done" })).status, "done");
});

test("finished check still accepts a bare task object", () => {
  assert.equal(boardCardIsFinished(bare({ id: "t_a7d65836", status: "done" }), "t_a7d65836"), true);
});

test("a runnable card is not finished, so the normal transition still runs", () => {
  for (const status of ["triage", "todo", "scheduled", "ready", "running", "review", "blocked"]) {
    assert.equal(boardCardIsFinished(envelope({ id: "t_1", status }), "t_1"), false, status);
  }
});

test("an unreadable board never reads as finished", () => {
  // null = the CLI call failed; garbage = a non-JSON reply. Both must fall
  // through to the unchanged path, never silently "clear" a live card.
  for (const out of [null, undefined, "", "not json", "[]", "null", '{"ok":false}']) {
    assert.equal(boardCardIsFinished(out, "t_1"), false, JSON.stringify(out));
  }
});

test("a mismatched id never reads as finished", () => {
  // Guards against clearing the wrong card if the board answers about another.
  assert.equal(boardCardIsFinished(envelope({ id: "t_other", status: "done" }), "t_1"), false);
  assert.equal(boardCardIsFinished(envelope({ status: "done" }), "t_1"), false);
});

test("a missing or non-string status never reads as finished", () => {
  assert.equal(boardCardIsFinished(envelope({ id: "t_1" }), "t_1"), false);
  assert.equal(boardCardIsFinished(envelope({ id: "t_1", status: null }), "t_1"), false);
  assert.equal(boardCardIsFinished(envelope({ id: "t_1", status: 0 }), "t_1"), false);
});

test("numeric ids compare by value, not by reference type", () => {
  assert.equal(boardCardIsFinished(envelope({ id: 42, status: "done" }), 42), true);
  assert.equal(boardCardIsFinished(envelope({ id: 42, status: "done" }), "42"), true);
});
