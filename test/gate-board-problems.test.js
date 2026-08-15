import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { annotateBoardProblems } = require("../container/gate.js");

test("board problem markers come from the shared stuck detector only", () => {
  const now = Date.parse("2026-07-21T18:00:00Z");
  const tasks = [
    { id: "old", status: "ready", created_at: (now - 5 * 60 * 60 * 1000) / 1000 },
    { id: "fresh", status: "ready", created_at: (now - 10 * 60 * 1000) / 1000 },
    { id: "waiting", status: "ready", created_at: (now - 5 * 60 * 60 * 1000) / 1000 },
    { id: "frozen", status: "blocked", created_at: (now - 5 * 60 * 60 * 1000) / 1000 },
  ];
  const marked = annotateBoardProblems(tasks, {
    humanReview: { waiting: { note: "Steve is deciding" } },
    frozen: { frozen: { reason: "intentional stop" } },
  }, now);

  assert.deepEqual(marked.find((t) => t.id === "old").problem, { reason: "age_stale", label: "ready too long" });
  assert.equal(marked.find((t) => t.id === "fresh").problem, undefined, "healthy card has no recovery menu marker");
  assert.equal(marked.find((t) => t.id === "waiting").problem, undefined, "human review is not mislabeled as a problem");
  assert.equal(marked.find((t) => t.id === "frozen").problem, undefined, "intentional freeze is not mislabeled as a problem");
});

test("a fresh live note keeps a running card out of the problem state", () => {
  const now = Date.parse("2026-07-21T18:00:00Z");
  const tasks = [
    { id: "alive", status: "running", started_at: (now - 2 * 60 * 60 * 1000) / 1000, liveNoteAt: (now - 5 * 60 * 1000) / 1000 },
    { id: "silent", status: "running", started_at: (now - 2 * 60 * 60 * 1000) / 1000, liveNoteAt: (now - 90 * 60 * 1000) / 1000 },
  ];
  const marked = annotateBoardProblems(tasks, {}, now);

  assert.equal(marked.find((t) => t.id === "alive").problem, undefined);
  assert.deepEqual(marked.find((t) => t.id === "silent").problem, { reason: "heartbeat_stale", label: "no heartbeat" });
});
