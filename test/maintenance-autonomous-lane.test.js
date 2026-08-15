// Phase 1f: the governed autonomous-run driver logic. Unit-tested against a
// scripted authority client (the real client↔service↔engine path is box-verified
// separately) — this locks the orchestration: accept → start → stream-to-eof →
// terminal-state mapping, and the fail-closed branches.

import { test } from "node:test";
import assert from "node:assert/strict";
import laneMod from "../container/maintenance-autonomous-lane.js";

const { runGovernedAutonomousTask, DEFAULTS } = laneMod;
const RUN = { id: "run_1", taskId: "task_1", chainId: "chain_1", profileId: "board_claude", repoId: "repo_" + "a".repeat(16), engine: "claude", summary: "" };
const noWait = () => Promise.resolve();

// A scripted client: outputs `pages` in order (each a work.output.read reply),
// then reports the given terminal worker state.
function scriptClient({ pages, terminalState = "completed", accepted = [] } = {}) {
  let i = 0;
  return {
    acceptRun: async (r) => { accepted.push(r); return r; },
    startWork: async () => ({ worker: { ref: "wrk_" + "a".repeat(24), version: 1, state: "running" }, workerHandle: "hdl_" + "b".repeat(24) }),
    readOutput: async () => pages[Math.min(i++, pages.length - 1)],
    inspectWork: async () => ({ worker: { ref: "wrk_" + "a".repeat(24), state: terminalState } }),
  };
}

test("happy path: accepts, starts, streams to eof, maps completed -> ranClean", async () => {
  const accepted = [];
  const client = scriptClient({
    accepted,
    pages: [
      { chunks: [{ seq: 1, text: "hello " }], nextSeq: 1, eof: false, truncated: false },
      { chunks: [{ seq: 2, text: "world" }], nextSeq: 2, eof: true, truncated: false },
    ],
    terminalState: "completed",
  });
  const res = await runGovernedAutonomousTask({ client, run: RUN, objective: "do it", delay: noWait });
  assert.equal(res.ranClean, true);
  assert.equal(res.text, "hello world");
  assert.equal(res.workerState, "completed");
  assert.equal(res.terminationProven, true);
  assert.equal(accepted.length, 1);
  assert.deepEqual(accepted[0].engines, ["claude"]);
});

test("a failed terminal state is not ranClean but still returns the captured text", async () => {
  const client = scriptClient({ pages: [{ chunks: [{ seq: 1, text: "partial" }], nextSeq: 1, eof: true, truncated: false }], terminalState: "failed" });
  const res = await runGovernedAutonomousTask({ client, run: RUN, objective: "x", delay: noWait });
  assert.equal(res.ranClean, false);
  assert.equal(res.text, "partial");
  assert.equal(res.workerState, "failed");
  assert.equal(res.terminationProven, true);
});

test("start failures report termination only when root authoritatively proved no child", async (t) => {
  const cases = [
    ["STOP_ENGAGED", true],
    ["RUN_NOT_ACCEPTED", true],
    ["RUN_CONFLICT", true],
    ["BUDGET_EXHAUSTED", true],
    ["SPAWN_FAILED", true],
    ["LANE_BUSY", false],
    ["LAUNCH_AMBIGUOUS", false],
    ["INVALID_TRANSITION", false],
    ["INVALID_REQUEST", false],
    ["INTERNAL_RESPONSE_INVALID", false],
    ["PROTOCOL_ERROR", false],
    ["ECONNRESET", false],
    [null, false],
  ];
  for (const [code, terminationProven] of cases) {
    await t.test(code || "uncoded transport failure", async () => {
      const client = scriptClient({ pages: [] });
      client.startWork = async () => {
        const error = new Error("start failed");
        if (code) error.code = code;
        throw error;
      };
      const res = await runGovernedAutonomousTask({ client, run: RUN, objective: "x", delay: noWait });
      assert.equal(res.ranClean, false);
      assert.equal(res.error, code || "START_FAILED");
      assert.equal(res.terminationProven, terminationProven);
    });
  }
});

test("empty pages back off then finish when eof arrives", async () => {
  let calls = 0;
  const client = {
    acceptRun: async () => {},
    startWork: async () => ({ worker: { ref: "wrk_" + "a".repeat(24), version: 1 }, workerHandle: "hdl_" + "b".repeat(24) }),
    readOutput: async () => { calls += 1; return calls < 3 ? { chunks: [], nextSeq: 0, eof: false, truncated: false } : { chunks: [{ seq: 1, text: "done" }], nextSeq: 1, eof: true, truncated: false }; },
    inspectWork: async () => ({ worker: { ref: "wrk_" + "a".repeat(24), state: "completed" } }),
  };
  const res = await runGovernedAutonomousTask({ client, run: RUN, objective: "x", delay: noWait });
  assert.equal(res.ranClean, true);
  assert.equal(res.text, "done");
  assert.ok(calls >= 3);
});

test("deadline guard returns not-clean without hanging", async () => {
  let t = 0;
  const client = {
    acceptRun: async () => {}, startWork: async () => ({ worker: { ref: "wrk_" + "a".repeat(24), version: 1 }, workerHandle: "h" }),
    readOutput: async () => ({ chunks: [], nextSeq: 0, eof: false, truncated: false }),
    inspectWork: async () => ({ worker: { ref: "wrk_" + "a".repeat(24), state: "running" } }),
  };
  const res = await runGovernedAutonomousTask({ client, run: RUN, objective: "x", delay: noWait, now: () => (t += 1_000_000), opts: { maxWaitMs: 100 } });
  assert.equal(res.ranClean, false);
  assert.equal(res.error, "DEADLINE");
  assert.equal(res.terminationProven, false);
});

test("governed wait is capped at 15 minutes below the gate watchdog", async () => {
  let elapsed = 0;
  let reads = 0;
  const fifteenMinutes = 15 * 60 * 1000;
  const client = {
    acceptRun: async () => {},
    startWork: async () => ({ worker: { ref: "wrk_" + "a".repeat(24), version: 1 }, workerHandle: "h" }),
    readOutput: async () => {
      reads += 1;
      return { chunks: [], nextSeq: 0, eof: false, truncated: false };
    },
    inspectWork: async () => ({ worker: { ref: "wrk_" + "a".repeat(24), state: "running" } }),
  };
  const res = await runGovernedAutonomousTask({
    client,
    run: RUN,
    objective: "x",
    opts: { maxWaitMs: 60 * 60 * 1000 },
    now: () => elapsed,
    delay: async () => { elapsed += fifteenMinutes + 1; },
  });
  assert.deepEqual(
    { defaultMaxWaitMs: DEFAULTS.maxWaitMs, error: res.error, terminationProven: res.terminationProven, reads },
    { defaultMaxWaitMs: fifteenMinutes, error: "DEADLINE", terminationProven: false, reads: 2 },
  );
});

test("output or inspection loss after start never claims the worker stopped", async () => {
  const outputLost = scriptClient({
    pages: [{ chunks: [], nextSeq: 0, eof: true, truncated: false }],
  });
  outputLost.readOutput = async () => { throw Object.assign(new Error("lost"), { code: "OUTPUT_LOST" }); };
  const outputResult = await runGovernedAutonomousTask({ client: outputLost, run: RUN, objective: "x", delay: noWait });
  assert.equal(outputResult.terminationProven, false);
  assert.equal(outputResult.error, "OUTPUT_LOST");

  const inspectLost = scriptClient({
    pages: [{ chunks: [], nextSeq: 0, eof: true, truncated: false }],
  });
  inspectLost.inspectWork = async () => { throw Object.assign(new Error("lost"), { code: "INSPECT_LOST" }); };
  const inspectResult = await runGovernedAutonomousTask({ client: inspectLost, run: RUN, objective: "x", delay: noWait });
  assert.equal(inspectResult.terminationProven, false);
  assert.equal(inspectResult.error, "INSPECT_LOST");
});

test("construction fails closed without a client", async () => {
  await assert.rejects(() => runGovernedAutonomousTask({ run: RUN, objective: "x" }), /authority client/);
});
