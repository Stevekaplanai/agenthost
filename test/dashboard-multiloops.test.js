import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(process.cwd(), "dashboard");
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");
const optionalRead = (...parts) => {
  const file = path.join(ROOT, ...parts);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
};

const api = read("lib", "api.ts");
const live = read("lib", "live.ts");
const loops = read("components", "agenthost", "loops.tsx");
const systemsView = read("components", "agenthost", "systems-view.tsx");
const multi = optionalRead("components", "agenthost", "multi-loops.tsx");
const commandCenter = read("components", "agenthost", "command-center.tsx");

test("Multi-Loops uses the gate's real typed contract", () => {
  for (const name of ["MultiLoopJob", "MultiLoopRun", "MultiLoopStage", "MultiLoopEngineState"]) {
    assert.match(api, new RegExp(`interface ${name}`), `${name} is missing from the typed client`);
  }
  assert.match(api, /fetchMultiLoopJobs\(\)[\s\S]{0,160}\/cron\/multi\/jobs/);
  assert.match(api, /createMultiLoopJob[\s\S]{0,160}\/cron\/multi\/jobs/);
  assert.match(api, /deleteMultiLoopJob[\s\S]{0,160}\/cron\/multi\/jobs/);
  assert.match(api, /fetchMultiLoopRuns[\s\S]{0,180}\/cron\/multi\/runs\?job=/);
});

test("the live layer refreshes Multi-Loops and returns the gate's own failure reason", () => {
  assert.match(live, /export function useMultiLoops\(\)/);
  assert.match(live, /fetchMultiLoopJobs/);
  assert.match(live, /fetchMultiLoopRuns/);
  assert.match(live, /createMultiLoopJob/);
  assert.match(live, /deleteMultiLoopJob/);
  assert.match(live, /e instanceof Error \? e\.message : String\(e\)/,
    "the UI must never replace a gate error with a generic failure");
});

test("the real builder enforces the 2-4-stage handoff contract before scheduling", () => {
  assert.match(multi, /export function MultiLoops/);
  assert.match(multi, /2–4|2-4/);
  assert.match(multi, /stages\.length < 2/);
  assert.match(multi, /stages\.length > 4/);
  assert.match(multi, /new Set\(stages\.map\(\(stage\) => stage\.engine\)\)/,
    "the builder must require two distinct engines before POSTing");
  assert.match(multi, /available/);
  assert.match(multi, /reason/,
    "observed engine unavailability needs its supplied cause on screen");
  assert.match(multi, /<HorizontalRail/,
    "starter pipelines must remain reachable by touch and keyboard on phones");
});

test("the Multi-Loop starter rail preserves native two-axis phone gestures", () => {
  assert.match(
    multi,
    /<HorizontalRail label="Multi-Loop starters" className="[^"]*snap-none![^"]*">/,
    "the nested starter rail must not force a snap that defeats horizontal touch while keeping native vertical page panning",
  );
});

test("Multi-Loop creation controls keep 44px phone targets", () => {
  for (const label of ["Add agent", "Remove", "Schedule multi-loop"]) {
    assert.match(
      multi,
      new RegExp(`className=["'][^"']*min-h-11[^"']*["'][\\s\\S]{0,180}${label}|${label}[\\s\\S]{0,180}className=["'][^"']*min-h-11`),
      `${label} needs a 44px touch target`,
    );
  }
  assert.match(multi, /<select[\s\S]{0,260}aria-label="Cadence"[\s\S]{0,260}min-h-11|<select[\s\S]{0,260}min-h-11[\s\S]{0,260}aria-label="Cadence"/,
    "the cadence selector needs a name and 44px touch target");
  assert.match(multi, /type="time"[\s\S]{0,260}aria-label="Local time"[\s\S]{0,260}min-h-11|type="time"[\s\S]{0,260}min-h-11[\s\S]{0,260}aria-label="Local time"/,
    "the local-time field needs a 44px touch target");
});

test("Multi-Loop deletion uses a synchronous one-request lock", () => {
  assert.match(multi, /deleteRequestInFlight\.current/,
    "rapid confirmation must not send two DELETE requests");
  assert.match(multi, /async function remove[\s\S]*?try \{[\s\S]*?await onDelete[\s\S]*?finally \{[\s\S]*?deleteRequestInFlight\.current = null/);
  assert.match(multi, /deletes the schedule, any queued run, and its run-history directory/i);
});

test("the Systems Loops tab keeps single loops and layers in real Multi-Loops", () => {
  assert.match(loops, /MultiLoops/);
  assert.match(commandCenter, /useMultiLoops\(\)/);
  assert.match(commandCenter, /activeRoom === "systems"[\s\S]*<SystemsView[\s\S]*multiLoops=\{multiLoops\}/);
  assert.match(systemsView, /multiJobs=\{multiLoops\.jobs\}/);
  assert.match(systemsView, /onCreateMulti=\{multiLoops\.create\}/);
  assert.match(systemsView, /onDeleteMulti=\{multiLoops\.remove\}/);
  assert.match(systemsView, /onLoadMultiRuns=\{multiLoops\.loadRuns\}/);
});

test("a saved Multi-Loop exposes its mode, stages, and per-stage run result", () => {
  for (const marker of ["mode", "stages.map", "run.stages", "status", "error", "History"]) {
    assert.ok(multi.includes(marker), `Multi-Loops omits ${marker}`);
  }
});
