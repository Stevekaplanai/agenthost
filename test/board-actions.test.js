"use strict";
// Behavioural tests for board card actions.
//
// The point of these is that the argv we build is argv the CLI will actually
// accept. Every signature asserted here was read from `hermes kanban <verb> --help`
// on the live box, because a flag that does not exist produces a usage screen --
// a failure that reads a lot like success from the caller's side.
import { test } from "node:test";
import assert from "node:assert";

import actions from "../container/board-actions.js";
const { boardActionArgs, actionNames, BLOCK_KINDS, REASON_MAX } = actions;

test("only the verbs the CLI actually has are offered", () => {
  assert.deepEqual(actionNames().sort(), ["archive", "block", "complete", "promote", "unblock"]);
});

test("promote takes its reason POSITIONALLY, as the CLI declares", () => {
  const r = boardActionArgs("t_abc123", "promote", { reason: "ready for review" });
  assert.deepEqual(r.args, ["promote", "t_abc123", "ready for review"]);
});

test("unblock takes --reason as a FLAG, not a positional", () => {
  const r = boardActionArgs("t_abc123", "unblock", { reason: "dependency landed" });
  assert.deepEqual(r.args, ["unblock", "t_abc123", "--reason", "dependency landed"]);
});

test("complete puts its text behind --result", () => {
  const r = boardActionArgs("t_abc123", "complete", { reason: "shipped in #305" });
  assert.deepEqual(r.args, ["complete", "t_abc123", "--result", "shipped in #305"]);
});

test("block accepts a kind from the closed set and rejects anything else by name", () => {
  const ok = boardActionArgs("t_abc123", "block", { reason: "waiting", kind: "needs_input" });
  assert.deepEqual(ok.args, ["block", "t_abc123", "--kind", "needs_input", "waiting"]);
  const bad = boardActionArgs("t_abc123", "block", { kind: "because-i-said-so" });
  assert.ok(bad.error, "an invalid kind is rejected");
  assert.match(bad.error, /kind must be one of/);
  for (const k of BLOCK_KINDS) {
    assert.ok(boardActionArgs("t_x", "block", { kind: k }).args, k + " is accepted");
  }
});

test("archive takes no reason, and says so rather than silently dropping it", () => {
  assert.deepEqual(boardActionArgs("t_abc123", "archive", {}).args, ["archive", "t_abc123"]);
  const r = boardActionArgs("t_abc123", "archive", { reason: "done with it" });
  assert.ok(r.error, "a reason on archive is refused");
  assert.match(r.error, /does not take a reason/);
});

test("an unknown action is refused and the message lists what IS allowed", () => {
  const r = boardActionArgs("t_abc123", "yeet", {});
  assert.ok(r.error);
  assert.match(r.error, /promote/);
  assert.match(r.error, /archive/);
});

test("a column name is NOT an action -- the board has verbs, not columns", () => {
  // The N4 brief specified drag-and-drop between columns. There is no CLI operation
  // that sets a column, so accepting one would invent a transition the board cannot
  // perform. This asserts we refuse rather than pretend.
  for (const column of ["queued", "running", "review", "done", "blocked", "backlog"]) {
    const r = boardActionArgs("t_abc123", column, {});
    assert.ok(r.error, column + " is a column, not an action, and must be refused");
  }
});

test("argv injection through the reason is refused", () => {
  // Same vector the create route already closes on titles: a leading dash would be
  // parsed as one of the CLI's own flags. spawn uses an argv array and never a
  // shell, so this is the remaining way in.
  const r = boardActionArgs("t_abc123", "promote", { reason: "--force" });
  assert.ok(r.error);
  assert.match(r.error, /cannot start with a dash/);
});

test("a malformed task id never reaches the CLI", () => {
  for (const bad of ["", "../etc/passwd", "t abc", "t;rm -rf /", "-x", "a".repeat(65)]) {
    const r = boardActionArgs(bad, "promote", {});
    assert.ok(r.error, JSON.stringify(bad) + " is refused");
  }
  assert.ok(boardActionArgs("a".repeat(64), "promote", {}).args, "64 chars is the documented ceiling and is allowed");
});

test("an over-long reason is refused with the limit named", () => {
  const r = boardActionArgs("t_abc123", "promote", { reason: "x".repeat(REASON_MAX + 1) });
  assert.ok(r.error);
  assert.match(r.error, new RegExp(String(REASON_MAX)));
});

test("no action ever returns both args and error", () => {
  const cases = [
    ["t_abc", "promote", {}], ["t_abc", "block", { kind: "transient" }],
    ["bad id", "promote", {}], ["t_abc", "nope", {}], ["t_abc", "archive", { reason: "x" }],
  ];
  for (const [id, act, opts] of cases) {
    const r = boardActionArgs(id, act, opts);
    assert.ok(Boolean(r.args) !== Boolean(r.error), "exactly one of args/error for " + act);
  }
});
