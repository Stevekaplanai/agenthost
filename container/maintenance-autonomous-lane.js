"use strict";

// Foundation B: the governed autonomous-run driver (Phase 1f — the gate.js
// routing, extracted so its LOGIC is unit-tested off the box). When Foundation B
// is active, gate.js's runAutonomousTask delegates one unattended run to root
// PID 1 through the gate-side authority client instead of spawning the engine
// itself: accept the run, start a jailed worker, stream its output via the
// durable cursor to end-of-output, and map the terminal worker state back to
// gate.js's { ranClean, text } contract.
//
// Pure orchestration over the injected client — NO engine spawn, NO jail
// building here (root owns all of that). System cancellation (timeout, STOP,
// shutdown) is PID 1's internal job, NOT an operator work.cancel, so this driver
// never calls the O-class cancel; on its own deadline it returns not-clean and
// lets PID 1 reap. Unit-tested against a scripted client; the live
// client↔service↔real-engine path is box-verified.

const MAX_WAIT_MS = 15 * 60 * 1000; // finish before gate.js's 16-minute hard watchdog
const DEFAULTS = Object.freeze({ pollMs: 250, readLimitBytes: 65_536, maxWaitMs: MAX_WAIT_MS });
const NO_CHILD_START_ERRORS = new Set([
  "STOP_ENGAGED",
  "RUN_NOT_ACCEPTED",
  "RUN_CONFLICT",
  "BUDGET_EXHAUSTED",
  "SPAWN_FAILED",
]);

// runGovernedAutonomousTask({ client, run, objective, opts?, delay?, now? })
//   run: { id, kind?, taskId, chainId, profileId, repoId, engine, summary? } — an
//        already-bound board run (gate.js maps its engine → profileId/repoId).
//   -> { ranClean, text, workerState, terminationProven, error? }
async function runGovernedAutonomousTask({ client, run, objective, opts = {}, delay, now = Date.now } = {}) {
  if (!client || typeof client.startWork !== "function") throw new Error("governed autonomous run requires an authority client");
  if (!run || typeof run !== "object") throw new Error("governed autonomous run requires a bound run");
  const wait = delay || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const cfg = {
    ...DEFAULTS,
    ...opts,
    maxWaitMs: Math.min(opts.maxWaitMs ?? DEFAULTS.maxWaitMs, MAX_WAIT_MS),
  };
  const { id, kind = "board_task", taskId, chainId, profileId, repoId, engine, summary = "" } = run;

  // 1. accept the bound run (idempotent) then start a jailed worker.
  try {
    await client.acceptRun({ id, kind, taskId, chainId, profileId, repoId, workMode: "new", engines: [engine], summary, nextActions: [], artifacts: [] });
  } catch (e) {
    return { ranClean: false, text: "", workerState: null, terminationProven: true, error: (e && e.code) || "ACCEPT_FAILED" };
  }
  let started;
  try {
    started = await client.startWork({ mode: "new", taskId, runId: id, chainId, engine, profileId, repoId, objective });
  } catch (e) {
    const error = (e && e.code) || "START_FAILED";
    // Only root's exact pre/no-child decisions prove this attempt did not
    // launch. Busy/ambiguous/response-validation errors and transport loss
    // stay uncertain.
    return { ranClean: false, text: "", workerState: null, terminationProven: NO_CHILD_START_ERRORS.has(error), error };
  }
  const workerRef = started.worker.ref;

  // 2. stream the worker's output via the durable cursor until end-of-output.
  let afterSeq = 0, text = "", eof = false;
  const t0 = now();
  while (!eof) {
    let page;
    try { page = await client.readOutput(workerRef, afterSeq, cfg.readLimitBytes); }
    catch (e) { return { ranClean: false, text, workerState: "unknown", terminationProven: false, error: (e && e.code) || "OUTPUT_FAILED" }; }
    for (const chunk of page.chunks) text += chunk.text;
    afterSeq = page.nextSeq;
    eof = page.eof;
    if (eof) break;
    if (now() - t0 > cfg.maxWaitMs) return { ranClean: false, text, workerState: "timeout", terminationProven: false, error: "DEADLINE" };
    if (page.chunks.length === 0) await wait(cfg.pollMs); // nothing new yet — back off
  }

  // 3. map the terminal worker state to the autonomous contract.
  let workerState;
  try { workerState = (await client.inspectWork(workerRef)).worker.state; }
  catch (e) { return { ranClean: false, text, workerState: "unknown", terminationProven: false, error: (e && e.code) || "INSPECT_FAILED" }; }
  const terminationProven = new Set(["completed", "failed", "cancelled", "interrupted"]).has(workerState);
  return { ranClean: workerState === "completed", text, workerState, terminationProven };
}

module.exports = { runGovernedAutonomousTask, DEFAULTS };
