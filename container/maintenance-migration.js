"use strict";

// Dormant Foundation-B candidate: the secure /data migration executor
// (BUILD-PLAN Phase 1b). It drives the root-owned migration journal through its
// monotonic sequence, running one idempotent, crash-resumable action per step,
// while the first secure migration stays STOPPED. It composes the Foundation-A
// store (which owns the durable journal + monotonic-advance + STOPPED-first
// default) with per-step actions supplied by the caller.
//
// DORMANT: nothing here is wired into entrypoint.sh, start.sh, gate.js, or the
// runtime image. Activation of the real ownership/relocation changes is the
// atomic, separately-gated Phase 1f event. The concrete filesystem actions
// (marker relocation, ownership, legacy labeling) are INJECTED so they can be
// built and proven behind narrow root-owned primitives in a follow-on increment
// without changing this orchestrator.
//
// Crash semantics (ROOT-SERVICE-STATE-MACHINES §11): every step validates and
// advances one recorded stage at a time; a crash resumes the recorded step; a
// step action must be idempotent because it re-runs if the crash landed between
// the action and the journal advance. A mismatch or action failure fails closed
// and never skips a stage.

const { MIGRATION_STATES } = require("./maintenance-store.js");

// The ordered stages the executor advances INTO (everything after not_started).
const MIGRATION_STEPS = Object.freeze(MIGRATION_STATES.slice(1));

function nextStage(current) {
  const index = MIGRATION_STATES.indexOf(current);
  if (index === -1 || index === MIGRATION_STATES.length - 1) return null;
  return MIGRATION_STATES[index + 1];
}

function createMigrationExecutor({ store, stepActions = {}, log = () => {} } = {}) {
  if (!store || typeof store.open !== "function" || typeof store.advanceMigration !== "function" || typeof store.snapshot !== "function") {
    throw new Error("migration executor requires a maintenance store");
  }
  for (const [name, action] of Object.entries(stepActions)) {
    if (!MIGRATION_STEPS.includes(name)) throw new Error(`unknown migration step action: ${name}`);
    if (typeof action !== "function") throw new Error(`migration step action ${name} must be a function`);
  }

  function currentStage() {
    const snapshot = store.snapshot();
    if (!snapshot) throw new Error("migration store is not open");
    return snapshot.migrationState;
  }

  // Advance exactly one stage: run its idempotent action (if any), then commit
  // the journal advance. Fail closed on any error without skipping a stage.
  function step() {
    const from = currentStage();
    const to = nextStage(from);
    if (to === null) return { done: true, stage: from };
    const action = stepActions[to];
    if (action) {
      // The action runs BEFORE the advance, so a crash between them re-runs it
      // on resume — hence the idempotency requirement.
      action({ from, to });
    }
    store.advanceMigration(to);
    log(`migration ${from} -> ${to}`);
    return { done: to === "complete", stage: to };
  }

  // Run to completion (or resume from the recorded stage). The first secure
  // migration remains STOPPED throughout; the executor never resumes STOP.
  function run() {
    store.open();
    const stop = store.snapshot().stop;
    if (!stop || stop.engaged !== true) {
      // STOPPED-first invariant: the executor must not run a migration whose
      // first-secure record is not STOPPED.
      throw new Error("first secure migration must start STOPPED");
    }
    let guard = 0;
    for (;;) {
      if (++guard > MIGRATION_STATES.length + 1) throw new Error("migration exceeded its bounded stage count");
      const result = step();
      if (result.done) return store.snapshot();
    }
  }

  return Object.freeze({ MIGRATION_STEPS, currentStage, step, run });
}

module.exports = { createMigrationExecutor, MIGRATION_STEPS, nextStage };
