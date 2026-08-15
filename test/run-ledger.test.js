import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  ACTIVE_RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
  createRunLedger,
  runResponse,
} = require("../container/run-ledger.js");

function fixture(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-run-ledger-"));
  let nowMs = Date.parse("2026-07-21T12:00:00.000Z");
  const ledger = createRunLedger({ dir, now: () => nowMs, ...options });
  return {
    dir,
    file: path.join(dir, "runs.jsonl"),
    ledger,
    setNow(value) { nowMs = typeof value === "number" ? value : Date.parse(value); },
  };
}

function lineCount(file) {
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length;
}

test("create persists the run before returning and reload reconstructs it", () => {
  const f = fixture();
  const created = f.ledger.create({
    id: "run-persisted",
    kind: "chat",
    engines: ["claude"],
    summary: "Answering Steve",
    prompt: "this field must never be stored",
  });

  assert.equal(created.status, "queued");
  assert.equal(lineCount(f.file), 1, "the durable event exists when create returns");
  assert.equal(f.ledger.eventsSince(0, 10).events[0].type, "accepted");
  assert.equal(f.ledger.eventsSince(0, 10).events[0].at, Date.parse("2026-07-21T12:00:00.000Z"));
  assert.doesNotMatch(fs.readFileSync(f.file, "utf8"), /this field must never be stored/);

  const restored = createRunLedger({ dir: f.dir }).get("run-persisted");
  assert.deepEqual(restored, created);
});

test("run lifecycle records exact status timestamps", () => {
  const f = fixture();
  const queued = f.ledger.create({ id: "run-life", kind: "loop", engines: ["claude"], summary: "Nightly brief" });
  assert.equal(queued.createdAt, Date.parse("2026-07-21T12:00:00.000Z"));
  assert.equal(queued.startedAt, null);
  assert.equal(queued.finishedAt, null);

  f.setNow("2026-07-21T12:00:01.000Z");
  const running = f.ledger.start("run-life", { summary: "Drafting brief" });
  assert.equal(running.status, "running");
  assert.equal(running.startedAt, Date.parse("2026-07-21T12:00:01.000Z"));
  assert.equal(f.ledger.eventsSince(0, 10).events.at(-1).type, "started");

  f.setNow("2026-07-21T12:00:02.000Z");
  const waiting = f.ledger.transition("run-life", { status: "waiting", summary: "Waiting for reviewer" });
  assert.equal(waiting.status, "waiting");
  assert.equal(waiting.startedAt, running.startedAt);

  f.ledger.transition("run-life", { status: "waiting", engines: ["claude", "codex"], summary: "Codex is reviewing" });
  assert.deepEqual(f.ledger.get("run-life").engines, ["claude", "codex"]);

  f.setNow("2026-07-21T12:00:03.000Z");
  f.ledger.start("run-life", { summary: "Review received" });
  f.setNow("2026-07-21T12:00:04.000Z");
  const done = f.ledger.finish("run-life", "completed", {
    summary: "Brief reviewed",
    next_actions: [{ id: "open", label: "Open the brief" }],
    artifacts: [{ type: "file", label: "Brief", ref: "/work/brief.md" }],
  });
  assert.equal(done.status, "completed");
  assert.equal(done.finishedAt, Date.parse("2026-07-21T12:00:04.000Z"));
  assert.deepEqual(done.next_actions, [{ id: "open", label: "Open the brief" }]);
  assert.deepEqual(done.artifacts, [{ type: "file", label: "Brief", ref: "/work/brief.md" }]);
  assert.equal(lineCount(f.file), 6);
});

test("duplicate run IDs are exact-once and conflicting identities fail", () => {
  const f = fixture();
  const first = f.ledger.create({ id: "same-run", kind: "chat", engines: ["codex"], summary: "First" });
  const duplicate = f.ledger.create({ id: "same-run", kind: "chat", engines: ["codex"], summary: "Retry" });
  assert.deepEqual(duplicate, first);
  assert.equal(lineCount(f.file), 1, "an HTTP retry cannot create a second execution record");
  assert.throws(
    () => f.ledger.create({ id: "same-run", kind: "loop", engines: ["codex"] }),
    /already belongs to kind chat/,
  );
  assert.throws(
    () => f.ledger.create({ id: "same-run", kind: "chat", engines: ["claude"] }),
    /already belongs to engines codex/,
  );
});

test("invalid transitions and attempts to reopen terminal runs are rejected", () => {
  const f = fixture();
  f.ledger.create({ id: "terminal", kind: "brain", engines: ["hermes"] });
  f.ledger.start("terminal");
  const finished = f.ledger.finish("terminal", "failed", { summary: "Engine exited" });
  const duplicateFinish = f.ledger.finish("terminal", "failed", { summary: "HTTP retry" });
  assert.deepEqual(duplicateFinish, finished, "the same terminal outcome is idempotent");
  assert.throws(() => f.ledger.start("terminal"), /terminal run/);
  assert.throws(() => f.ledger.finish("terminal", "completed"), /already ended as failed/);
  assert.throws(() => f.ledger.transition("missing", { status: "running" }), /Unknown run/);
  assert.throws(() => f.ledger.transition("terminal", { status: "made-up" }), /Unknown run status/);
  assert.throws(
    () => f.ledger.create({ id: "bad-action", kind: "system", engines: [], next_actions: ["retry"] }),
    /next action must be an object/,
  );
  assert.throws(
    () => f.ledger.create({ id: "bad-artifact", kind: "system", engines: [], artifacts: ["raw path"] }),
    /artifact must be an object/,
  );
});

test("cursor history returns every event beyond the old 200-line and 30-row limits", () => {
  const f = fixture();
  for (let i = 0; i < 235; i++) {
    f.ledger.create({ id: `cursor-${i}`, kind: "system", engines: [], summary: `Event ${i}` });
  }

  let cursor = 0;
  const seqs = [];
  let pages = 0;
  do {
    const page = f.ledger.eventsSince(cursor, 31);
    pages++;
    seqs.push(...page.events.map((event) => event.seq));
    cursor = page.nextCursor;
    if (!page.hasMore) break;
  } while (pages < 20);

  assert.equal(seqs.length, 235);
  assert.deepEqual(seqs, Array.from({ length: 235 }, (_, i) => i + 1));
  assert.ok(pages > 1);
  const empty = f.ledger.eventsSince(cursor, 31);
  assert.deepEqual(empty.events, []);
  assert.equal(empty.nextCursor, cursor);
});

test("recentEvents bootstraps a new viewer at the newest history cursor", () => {
  const f = fixture();
  for (let i = 0; i < 40; i++) f.ledger.create({ id: `recent-${i}`, kind: "system", engines: [], summary: `Event ${i}` });
  const page = f.ledger.recentEvents(3);
  assert.deepEqual(page.events.map((event) => event.seq), [38, 39, 40]);
  assert.equal(page.nextCursor, 40);
  assert.equal(page.hasMore, true);
});

test("eventsForRun returns one complete retained timeline", () => {
  const f = fixture();
  f.ledger.create({ id: "detail-run", kind: "multi_loop", engines: ["claude", "codex"], summary: "Queued" });
  f.ledger.start("detail-run", { engines: ["claude"], summary: "Drafting" });
  f.ledger.transition("detail-run", { status: "running", engines: ["codex"], summary: "Reviewing" });
  f.ledger.finish("detail-run", "completed", { engines: ["claude", "codex"], summary: "Done" });
  f.ledger.create({ id: "other-run", kind: "system", engines: [], summary: "Other" });

  const timeline = f.ledger.eventsForRun("detail-run");
  assert.deepEqual(timeline.map((event) => event.type), ["accepted", "started", "progress", "completed"]);
  assert.ok(timeline.every((event) => event.runId === "detail-run"));
  assert.deepEqual(f.ledger.eventsForRun("missing"), []);
});

test("activeByEngine reports real work and excludes terminal runs", () => {
  const f = fixture();
  f.ledger.create({ id: "team", kind: "team_chat", engines: ["claude", "codex"], summary: "Team answer" });
  f.ledger.start("team");
  f.ledger.create({ id: "hermes-done", kind: "brain", engines: ["hermes"] });
  f.ledger.start("hermes-done");
  f.ledger.finish("hermes-done", "completed");

  const active = f.ledger.activeByEngine();
  assert.deepEqual(Object.keys(active).sort(), ["claude", "codex"]);
  assert.equal(active.claude[0].id, "team");
  assert.equal(active.codex[0].id, "team");
  assert.equal(active.hermes, undefined);
});

test("restart reconciliation interrupts every unfinished run honestly", () => {
  const f = fixture();
  for (const [id, status] of [["queued", "queued"], ["running", "running"], ["waiting", "waiting"], ["gated", "gated"]]) {
    f.ledger.create({ id, kind: "board_task", engines: ["codex"] });
    if (status === "running") f.ledger.start(id);
    if (status === "waiting") f.ledger.transition(id, { status: "waiting" });
    if (status === "gated") f.ledger.transition(id, { status: "gated" });
  }
  f.ledger.create({ id: "done", kind: "board_task", engines: ["codex"] });
  f.ledger.start("done");
  f.ledger.finish("done", "completed");

  const interrupted = f.ledger.interruptActive({ reason: "Gateway restarted before completion" });
  assert.deepEqual(interrupted.map((run) => run.id).sort(), ["gated", "queued", "running", "waiting"]);
  for (const id of ["queued", "running", "waiting", "gated"]) {
    const run = f.ledger.get(id);
    assert.equal(run.status, "interrupted");
    assert.equal(run.summary, "Gateway restarted before completion");
  }
  assert.equal(f.ledger.get("done").status, "completed");
});

test("restart reconciliation can preserve durable waiting and gated work", () => {
  const f = fixture();
  for (const id of ["queued", "running", "waiting", "gated"]) {
    f.ledger.create({ id, kind: "board_task", engines: ["codex"] });
  }
  f.ledger.start("running");
  f.ledger.transition("waiting", { status: "waiting" });
  f.ledger.transition("gated", { status: "gated" });

  const interrupted = f.ledger.interruptActive({ statuses: ["queued", "running"], reason: "process lost" });
  assert.deepEqual(interrupted.map((run) => run.id).sort(), ["queued", "running"]);
  assert.equal(f.ledger.get("waiting").status, "waiting");
  assert.equal(f.ledger.get("gated").status, "gated");
});

test("a malformed trailing JSONL record cannot erase valid history", () => {
  const f = fixture();
  f.ledger.create({ id: "survivor", kind: "mail_cycle", engines: ["hermes"] });
  fs.appendFileSync(f.file, "{half-written");

  const restored = createRunLedger({ dir: f.dir });
  assert.equal(restored.get("survivor").status, "queued");
  const next = restored.create({ id: "after-corruption", kind: "system", engines: [] });
  assert.equal(restored.eventsSince(0, 20).events.at(-1).seq, 2);
  assert.equal(next.id, "after-corruption");
});

test("redaction covers persisted summaries, actions, and artifact references", () => {
  const f = fixture({ redact: (value) => String(value).replaceAll("SECRET", "[REDACTED]") });
  f.ledger.create({
    id: "redacted",
    kind: "git_ladder",
    engines: ["codex"],
    summary: "Token SECRET",
    next_actions: [{ id: "retry", label: "Use SECRET later" }],
    artifacts: [{ type: "branch", label: "SECRET branch", ref: "owner/SECRET" }],
    prompt: "raw SECRET prompt must be discarded",
  });

  const disk = fs.readFileSync(f.file, "utf8");
  assert.doesNotMatch(disk, /SECRET/);
  assert.match(disk, /\[REDACTED\]/);
  assert.doesNotMatch(disk, /raw .* prompt/);
});

test("pruning retains all active runs plus terminal runs inside either retention promise", () => {
  const now = Date.parse("2026-07-21T12:00:00.000Z");
  const f = fixture({ retentionMs: 30 * 24 * 60 * 60 * 1000, minimumTerminalRuns: 3 });
  const day = 24 * 60 * 60 * 1000;

  f.setNow(now - 110 * day);
  f.ledger.create({ id: "old-active", kind: "loop", engines: ["claude"] });
  f.ledger.start("old-active");

  for (const [id, age] of [["oldest", 100], ["older", 90], ["third-newest", 80], ["recent", 20], ["newest", 10]]) {
    f.setNow(now - age * day);
    f.ledger.create({ id, kind: "loop", engines: ["claude"] });
    f.ledger.start(id);
    f.ledger.finish(id, "completed");
  }

  f.setNow(now);
  const result = f.ledger.prune();
  assert.equal(result.removedRuns, 2);
  assert.deepEqual(
    f.ledger.list({ limit: 20, kinds: ["loop"] }).map((run) => run.id).sort(),
    ["newest", "old-active", "recent", "third-newest"],
  );

  const restored = createRunLedger({ dir: f.dir });
  assert.equal(restored.get("old-active").status, "running");
  assert.equal(restored.get("oldest"), null);
  assert.equal(restored.get("older"), null);
  const pruning = restored.list({ limit: 20, kinds: ["system"] });
  assert.equal(pruning.length, 1);
  assert.equal(pruning[0].status, "completed");
  assert.match(pruning[0].summary, /compacted 2 terminal runs/);
});

test("a run cannot start when its initial durable record cannot be written", () => {
  const f = fixture();
  fs.mkdirSync(f.file);
  assert.throws(
    () => f.ledger.create({ id: "must-not-run", kind: "chat", engines: ["claude"] }),
    /Could not persist run must-not-run/,
  );
  assert.equal(f.ledger.get("must-not-run"), null);
});

test("response envelopes stay stable and separate API health from run state", () => {
  const response = runResponse({
    status: "warning",
    summary: "Run needs attention.",
    next_actions: ["Open the task"],
    artifacts: [{ type: "task", label: "Task 42", ref: "42" }],
    run: { id: "42", status: "gated" },
  });
  assert.deepEqual(response, {
    status: "warning",
    summary: "Run needs attention.",
    next_actions: ["Open the task"],
    artifacts: [{ type: "task", label: "Task 42", ref: "42" }],
    run: { id: "42", status: "gated" },
  });
  assert.ok(ACTIVE_RUN_STATUSES.has("gated"));
  assert.ok(TERMINAL_RUN_STATUSES.has("interrupted"));
});
