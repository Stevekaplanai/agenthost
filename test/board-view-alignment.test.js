// The operator and the agents must describe the board the SAME way.
//
// Steve, 2026-07-25: the visual board called ready cards "queued" while an
// agent received the raw word "ready." Both surfaces now call the same imported
// canonical projector; this test prevents a second embedded map from returning.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { boardContextSummary } from "../container/gate.js";
import canonicalBoard from "../container/canonical-board.js";

const gate = fs.readFileSync(
  path.join(import.meta.dirname, "..", "container", "gate.js"),
  "utf8",
);
const boardView = fs.readFileSync(
  path.join(import.meta.dirname, "..", "dashboard", "components", "agenthost", "full-board.tsx"),
  "utf8",
);
const taskDialog = fs.readFileSync(
  path.join(import.meta.dirname, "..", "dashboard", "components", "agenthost", "dialogs.tsx"),
  "utf8",
);
const api = fs.readFileSync(
  path.join(import.meta.dirname, "..", "dashboard", "lib", "api.ts"),
  "utf8",
);

test("the UI's lane map and the agents' lane map are identical", () => {
  assert.match(gate, /const BOARD_COLUMN = canonicalBoard\.RAW_STATUS_LANE/,
    "gate board policy must import the canonical status map");
  assert.match(gate, /const laneOf = \(t\) => canonicalBoard\.rawLane/,
    "agent summaries must call the same canonical projector");
  assert.doesNotMatch(gate, /const LANE_OF\s*=/,
    "a second embedded status map can drift from the visual board");
  assert.equal(canonicalBoard.RAW_STATUS_LANE.ready, "queued");
  assert.equal(canonicalBoard.RAW_STATUS_LANE.needs_input, "awaiting");
});

test("a queued-ish status is reported to engines as the lane Steve sees", () => {
  for (const status of ["ready", "triage", "todo", "scheduled"]) {
    const out = boardContextSummary([
      { id: "t_1", status, assignee: "codex", title: "A card" },
    ]);
    assert.match(out, /1 queued/, status + " counts toward the queued lane");
    assert.match(out, new RegExp("\\[queued \\(" + status + "\\)\\]"),
      status + " shows the lane first, raw status in parentheses");
  }
});

test("a status that IS its own lane is not redundantly parenthesised", () => {
  const out = boardContextSummary([
    { id: "t_1", status: "running", assignee: "codex", title: "A card" },
  ]);
  assert.match(out, /\[running\]/, "no '[running (running)]' noise");
  assert.ok(!/running \(running\)/.test(out));
});

test("the summary tells the engine which vocabulary it is reading", () => {
  const out = boardContextSummary([
    { id: "t_1", status: "ready", assignee: "codex", title: "A card" },
  ]);
  assert.match(out, /lanes Steve sees/);
  assert.match(out, /board verbs take the raw status/);
});

test("lane counts follow the canonical left-to-right order", () => {
  const out = boardContextSummary([
    { id: "a", status: "blocked", title: "x" },
    { id: "b", status: "done", title: "x" },
    { id: "c", status: "ready", title: "x" },
    { id: "d", status: "review", title: "x" },
    { id: "e", status: "running", title: "x" },
  ]);
  const head = out.split("\n")[0];
  const ordered = canonicalBoard.CANONICAL_BOARD_LANES
    .map(({ id }) => id)
    .filter((lane) => head.includes(lane));
  assert.deepEqual(ordered, ["queued", "running", "review", "done", "blocked"]);
  for (let index = 1; index < ordered.length; index += 1) {
    assert.ok(head.indexOf(ordered[index - 1]) < head.indexOf(ordered[index]));
  }
});

test("an unknown status degrades to queued rather than vanishing", () => {
  const out = boardContextSummary([
    { id: "t_1", status: "some-new-status", title: "A card" },
  ]);
  assert.match(out, /1 queued/);
});

test("empty and malformed input never throws", () => {
  assert.equal(boardContextSummary([]), "Board: no cards.");
  assert.equal(boardContextSummary(null), "Board: no cards.");
  assert.match(boardContextSummary([{}, null]), /Board: 2 cards/);
});

test("the generated board opens full details from the canonical task envelope", () => {
  assert.match(boardView, /onClick=\{\(\) => onOpenTask\(t\)\}/,
    "every generated-shell card opens the shared task dialog");
  assert.match(taskDialog, /fetchBoardTask\(taskId\)\.then\(/,
    "the dialog reads the canonical task endpoint");
  assert.match(api, /return getJson\(`\/board\/task\/\$\{encodeURIComponent\(id\)\}`\)/,
    "the endpoint path keeps the task id encoded");
});
