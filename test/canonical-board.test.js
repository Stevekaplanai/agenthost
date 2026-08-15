import test from "node:test";
import assert from "node:assert/strict";
import canonicalBoard from "../container/canonical-board.js";

const {
  CANONICAL_BOARD_LANES,
  createSingleFlightCache,
  orphanProtection,
  projectCanonicalBoard,
  projectCanonicalDetails,
} = canonicalBoard;

const rawTasks = [
  { id: "t_triage", title: "Triage", status: "triage", assignee: "claude" },
  { id: "t_ready", title: "Ready", status: "ready", assignee: "codex" },
  { id: "t_running", title: "Running", status: "running", assignee: "hermes" },
  { id: "t_awaiting", title: "Needs Steve", status: "blocked", assignee: "kimi" },
  { id: "t_review", title: "Review", status: "review", assignee: "gemini" },
  { id: "t_done", title: "Done", status: "completed", assignee: "codex" },
  { id: "t_blocked", title: "Blocked", status: "blocked", assignee: "claude" },
  { id: "t_frozen", title: "Frozen", status: "blocked", assignee: "hermes" },
  { id: "t_claimed", title: "Claimed before Hermes moved", status: "ready", assignee: "kimi" },
];

test("the canonical projection exposes exactly the six shared operating lanes", () => {
  assert.deepEqual(
    CANONICAL_BOARD_LANES.map(({ id, title }) => [id, title]),
    [
      ["queued", "Queued"],
      ["running", "Running"],
      ["awaiting", "Awaiting You"],
      ["review", "Review"],
      ["done", "Done"],
      ["blocked", "Blocked"],
    ],
  );

  const board = projectCanonicalBoard(rawTasks, {
    awaiting: {
      t_awaiting: { note: "Choose whether this may continue." },
    },
    frozenIds: new Set(["t_frozen"]),
    runningIds: new Set(["t_claimed"]),
    available: true,
  });

  assert.deepEqual(
    Object.fromEntries(Object.entries(board.columns).map(([lane, tasks]) => [
      lane,
      tasks.map(({ id }) => id),
    ])),
    {
      queued: ["t_triage", "t_ready"],
      running: ["t_running", "t_claimed"],
      awaiting: ["t_awaiting"],
      review: ["t_review"],
      done: ["t_done"],
      blocked: ["t_blocked", "t_frozen"],
    },
  );
  assert.equal(board.tasks.find(({ id }) => id === "t_awaiting").reviewNote,
    "Choose whether this may continue.");
  const frozen = board.tasks.find(({ id }) => id === "t_frozen");
  assert.equal(frozen.frozen, true);
  assert.deepEqual(frozen.actions, ["open", "chat", "resume"],
    "a frozen card stays visible without exposing unsafe mutations");
  assert.deepEqual(frozen.transitions, ["queued"]);
});

test("the task projection is an allowlist and never reflects unknown secret-shaped fields", () => {
  const privateValue = ["not", "projected", "value"].join(":");
  const board = projectCanonicalBoard([{
    id: "t_safe",
    title: "Safe card",
    status: "ready",
    assignee: "codex",
    token: privateValue,
    api_key: privateValue,
    credentials: { password: privateValue },
    liveNote: "Building the test contract",
  }]);

  assert.equal(JSON.stringify(board).includes(privateValue), false);
  assert.deepEqual(board.tasks[0].destinations, {
    details: "/board/task/t_safe",
    chat: "/?task=t_safe",
  });
});

test("task details preserve reviewable facts while sanitizing comments and events", () => {
  const details = projectCanonicalDetails({
    task: {
      id: "t_detail",
      title: "Open me",
      body: "GOAL: verify the task",
      result: "Tests passed",
      status: "done",
      assignee: "codex",
      token: "do-not-leak",
    },
    comments: [
      { author: "steve", text: "Approved", created_at: 123, secret: "do-not-leak" },
      { author: { token: "do-not-leak" }, text: { token: "do-not-leak" } },
    ],
    events: [
      { kind: "heartbeat", created_at: 122, payload: { note: "Running tests", token: "do-not-leak" } },
      { kind: "unknown", payload: { output: "do-not-leak" } },
    ],
  });

  assert.equal(details.task.lane, "done");
  assert.equal(details.task.body, "GOAL: verify the task");
  assert.equal(details.task.result, "Tests passed");
  assert.deepEqual(details.comments, [{ author: "steve", text: "Approved", created_at: 123 }]);
  assert.deepEqual(details.events, [{
    kind: "heartbeat",
    created_at: 122,
    payload: { note: "Running tests" },
  }]);
  assert.equal(JSON.stringify(details).includes("do-not-leak"), false);
});

test("a live or renewed durable claim protects an external running card on every sweep", () => {
  const task = { id: "t_room", status: "running" };
  const tracked = new Set();
  const firstClaim = {
    readable: true,
    kind: "live-or-recovering",
    claim: { state: "running", expiresAt: 61_000 },
  };
  const renewedClaim = {
    readable: true,
    kind: "live-or-recovering",
    claim: { state: "running", expiresAt: 121_000 },
  };

  assert.equal(orphanProtection(task, tracked, firstClaim, 30_000), "durable");
  assert.equal(orphanProtection(task, tracked, renewedClaim, 90_000), "durable",
    "the second sweep still recognizes the renewed external scheduler owner");
  assert.equal(orphanProtection(task, tracked, {
    readable: true,
    kind: "none",
  }, 90_000), "orphan");
  assert.equal(orphanProtection(task, tracked, {
    readable: false,
    kind: "unreadable",
  }, 90_000), "unknown");
});

test("the short cache coalesces concurrent CLI reads and expires deterministically", async () => {
  let now = 1_000;
  let loads = 0;
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const cache = createSingleFlightCache({ ttlMs: 1_500, now: () => now });
  const load = async () => {
    loads += 1;
    await held;
    return { generation: loads };
  };

  const first = cache.get(load);
  const second = cache.get(load);
  assert.equal(loads, 1, "one CLI read serves concurrent callers");
  release();
  assert.deepEqual(await first, { generation: 1 });
  assert.deepEqual(await second, { generation: 1 });
  assert.deepEqual(await cache.get(load), { generation: 1 }, "fresh data is reused");

  now += 1_501;
  assert.deepEqual(await cache.get(async () => ({ generation: ++loads })), { generation: 2 });
  cache.invalidate();
  assert.deepEqual(await cache.get(async () => ({ generation: ++loads })), { generation: 3 });
});

// ---- A gate the operator cannot clear is worse than no gate -----------------
//
// 2026-08-12: card t_ccb561da was consequence-gated and sat `ready` forever.
// Steve: "There is no approve button on the card only reassign and block and
// discuss in chat." He was right — a gated card lands in `queued`, and `queued`
// advertised only assign + block. The release route existed the whole time and
// its own refusal text said "choose Approve once", naming a control nobody built.
test("a gated queued card advertises the release action that matches its gate", () => {
  const base = { id: "t_gated1", title: "Write the loop run-result fix", status: "ready" };

  const consequence = canonicalBoard.projectCanonicalTask(base, { gated: { t_gated1: "consequence_gate" } });
  assert.ok(consequence.actions.includes("approve_once"), "a consequence gate offers Approve once");
  assert.equal(consequence.gateIssue, "consequence_gate", "and the card names which gate holds it");

  const wording = canonicalBoard.projectCanonicalTask({ ...base, id: "t_gated2" }, { gated: { t_gated2: "wording_gate" } });
  assert.ok(wording.actions.includes("run_once"), "a wording gate offers Allow this run");
  assert.ok(!wording.actions.includes("approve_once"),
    "and NOT the consequence key — the two gates take different keys and the wrong one is accepted silently while doing nothing");

  // The regression that started this: no gate, no release button.
  const plain = canonicalBoard.projectCanonicalTask({ ...base, id: "t_plain" }, {});
  assert.ok(!plain.actions.includes("approve_once") && !plain.actions.includes("run_once"),
    "an ungated card offers no release");
  assert.equal(plain.gateIssue, undefined);
  // The sideways actions are still there; the release is added, not substituted.
  assert.ok(plain.actions.includes("assign") && plain.actions.includes("block"));
});

test("the release is offered ONLY where the server would accept it", () => {
  // The override route refuses anything not queued with `task_not_runnable`, so
  // advertising it elsewhere would be a button that always fails.
  for (const status of ["done", "review", "running", "awaiting"]) {
    const card = canonicalBoard.projectCanonicalTask(
      { id: "t_x", title: "T", status },
      { gated: { t_x: "consequence_gate" } },
    );
    assert.ok(!card.actions.includes("approve_once"), status + " must not offer a release");
  }
});
