// The board CLI must not be called before it can answer.
//
// MEASURED from the gate's own logs, two boots, 2026-08-10/11:
//
//   23:57:37  [gate] listening on 8080
//   23:58:07  [gate] hermes kanban list failed (exit null)   <- +30s
//   23:58:12  [gate] hermes kanban -h failed (exit null)     <- +35s
//
// With a 15s kill budget those calls STARTED at +15s and +20s, which were
// exactly two hardcoded boot timers:
//
//   setTimeout(() => { refreshBoardSummary(); ... }, 15 * 1000)   -> the `list`
//   setTimeout(() => { hermesKanban(["-h"]) ... }, 20 * 1000)     -> the `-h`
//
// Both raced a window in which the CLI simply does not respond, and both were
// SIGKILLed on every boot. Before PR #365 taught the wrapper to name its cause,
// they produced the bare rows "list: " and "-h: " -- most of the 497
// `kanban_cli_error` entries on the box since 2026-07-23.
//
// boardTick is deliberately NOT part of this fix. `setInterval` does not fire
// immediately, so its first `list` lands at 15+30 = 45s, outside the bad window,
// and it has always succeeded. An earlier analysis blamed boardTick for the 15s
// `list`; the timestamps above show the owner is refreshBoardSummary.
//
// And this is NOT a timeout change. `hermes kanban list` costs ~500ms warm, so
// the 15s budget is ~30x the real cost. Raising it would hide a readiness
// problem behind a bigger number -- the move the classifier's 10s incident on
// 2026-08-09 exists to warn against.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const gate = fs.readFileSync(path.join(repoRoot, "container", "gate.js"), "utf8");

// SOURCE-READING, and labelled as such. The probe lives thousands of lines below
// gate.js's lib-mode export, which `return`s before reaching it, so it cannot be
// required or executed from a test -- the same limit gated-backlog-reminder.test.js
// records for the same file. These show the wiring says the right thing, not that
// it does it. Stated plainly rather than dressed up as behavioural coverage.

test("neither boot call fires on a hardcoded clock any more", () => {
  assert.doesNotMatch(
    gate,
    /setTimeout\(\(\) => \{ refreshBoardSummary\(\); setInterval\(refreshBoardSummary/,
    "the first board summary must not be scheduled by wall clock -- that delay is what put it inside the dead window",
  );
  assert.doesNotMatch(
    gate,
    /hermesKanban\(\["-h"\]\)[\s\S]{0,400}?\}, 20 \* 1000\)/,
    "the verb contract check must not fire on a fixed 20s timer either",
  );
});

test("both now wait on the one readiness probe", () => {
  assert.match(gate, /const kanbanBootReady = \(async \(\) => \{/,
    "a single shared probe, so the two callers cannot drift onto different readiness rules");
  assert.match(gate, /if \(probe && probe\.ready\) refreshBoardSummary\(\);/,
    "the board summary waits for the probe AND respects its answer");
  assert.match(gate, /kanbanBootReady\.then\(\(probe\) => \{/,
    "the contract check waits for the same probe");
});

test("the probe is bounded and spaced, so a dead CLI cannot hang boot forever", () => {
  assert.match(gate, /const KANBAN_BOOT_ATTEMPTS = \d+;/);
  assert.match(gate, /const KANBAN_BOOT_GAP_MS = \d+;/);
  const attempts = Number(gate.match(/const KANBAN_BOOT_ATTEMPTS = (\d+);/)?.[1]);
  const gapMs = Number(gate.match(/const KANBAN_BOOT_GAP_MS = (\d+);/)?.[1]);
  // KANBAN_BOOT_PROBE_MS now aliases the shared cold budget, so resolve through it.
  const probeMs = Number(gate.match(/const HERMES_KANBAN_COLD_TIMEOUT_MS = (\d+);/)?.[1]);
  const windowMs = attempts * probeMs + (attempts - 1) * gapMs;
  // MEASURED 2026-08-11, no timeout, external to the gate: the first
  // `hermes kanban -h` after boot answered on attempt ONE, in ~21 seconds. The
  // CLI is not unready; its first invocation is just slow. So the property that
  // matters is not "outlast a readiness ceiling" -- it is that a SINGLE attempt
  // can outlast the cold call, because retries were never what made it work.
  // A MARGIN factor, not the bare measurement. Kimi (LOW): pinning `> 21000`
  // hardcodes an n=1 figure as a floor, so the test would keep passing while the
  // box grew past the budget it was derived from. 1.4x is the margin the current
  // 30s actually carries; if someone shrinks the budget toward the measurement,
  // this fails and makes them argue for it.
  const COLD_CALL_MEASURED_MS = 21000;
  assert.ok(probeMs >= COLD_CALL_MEASURED_MS * 1.4,
    `one attempt gets ${probeMs}ms against a measured ~${COLD_CALL_MEASURED_MS}ms cold call; keep at least 40% margin or a slower box kills the call again`);
  assert.ok(windowMs > 45000,
    `total window is ${windowMs}ms; it must still leave room for one retry after a full-length first attempt`);
  assert.ok(windowMs < 180000,
    `the probe window is ${windowMs}ms; it must still be bounded so a genuinely dead board is reported, not waited on forever`);
  assert.match(gate, /for \(let attempt = 1; attempt <= KANBAN_BOOT_ATTEMPTS; attempt\+\+\)/);
});

test("a box with no Hermes short-circuits instead of burning three timeouts", () => {
  // The legal brand ships without a board. Probing it would cost three full
  // kills and then audit a readiness failure for a capability nobody asked for.
  assert.match(gate, /if \(!fs\.existsSync\(HERMES_BIN\)\) return \{ ready: false, absent: true/,
    "absence is checked before the first probe attempt, not discovered by timing out");
  assert.match(gate, /if \(probe\.absent\) return;/,
    "and an absent board must not be reported as a readiness failure");
});

test("a board that never comes up says so, instead of looking empty", () => {
  // Cardinal Rule 16. Before this, a board that failed to start at boot was
  // indistinguishable from a board with nothing on it.
  assert.match(gate, /audit\("kanban_not_ready_at_boot"/,
    "a probe that never succeeds must name itself");
  assert.match(gate, /audit\("kanban_ready_at_boot"/,
    "and a board that needed retries must say so -- that is the signal the window moved");
});

test("the contract check reuses the probe's output instead of firing a second -h", () => {
  assert.match(gate, /KANBAN_REQUIRED_VERBS\.filter\(\(v\) => !probe\.help\.includes\(v\)\)/,
    "the old code paid for two separate -h calls to learn the same thing");
});

test("boardTick's schedule is untouched", () => {
  // Its first list lands at 45s, outside the dead window, and has always worked.
  // Changing it would be scope creep against a call that is not broken -- and it
  // is staggered off cronTick on purpose so the two do not contend for the lane.
  assert.match(gate, /setTimeout\(\(\) => setInterval\(boardTick, 30 \* 1000\), 15 \* 1000\);/,
    "boardTick must keep its 15s stagger and 30s period exactly as they were");
});

test("the 15s call budget is unchanged", () => {
  assert.match(gate, /const HERMES_KANBAN_TIMEOUT_MS = 15000;/,
    "this fix must not become a timeout bump -- 15s is already ~30x the measured warm cost");
});

test("the probe budget is LONGER than the work budget, on purpose", () => {
  // This inverts the first version of this test, which asserted the probe must be
  // WELL UNDER the work budget. That was reasoning from "asking if you can answer
  // should be cheap" -- true in principle, false here. Measured: the cold first
  // call takes ~21s, so a short budget does not observe readiness, it PREVENTS it,
  // killing the warm-up it is waiting for. The ordinary 15s work budget is fine
  // precisely because by then the first call has already paid the cold cost.
  // KANBAN_BOOT_PROBE_MS now aliases the shared cold budget, so resolve through it.
  const probeMs = Number(gate.match(/const HERMES_KANBAN_COLD_TIMEOUT_MS = (\d+);/)?.[1]);
  const workMs = Number(gate.match(/const HERMES_KANBAN_TIMEOUT_MS = (\d+);/)?.[1]);
  assert.ok(probeMs > workMs,
    `the probe budget (${probeMs}ms) must exceed the work budget (${workMs}ms): only the FIRST call pays the ~21s cold cost`);
  assert.match(gate, /hermesKanban\(\["-h"\], \{ timeoutMs: KANBAN_BOOT_PROBE_MS, quiet: true \}\)/,
    "and the probe must actually pass it");
});

test("the cold budget covers the FAILURE branch too, not just a passing probe", () => {
  // Kimi, HIGH. Binding the long budget to "the probe passed" leaves the branch
  // where it did NOT pass still issuing 15s work calls into a cold CLI -- the
  // original 18-day bug, recurring exactly when the box is slowest. Keying on
  // "has any call ever succeeded since boot" covers both branches with one rule.
  assert.match(gate, /let kanbanEverSucceeded = false;/,
    "there must be a boot-scoped warmed flag");
  assert.match(gate, /\(kanbanEverSucceeded \? HERMES_KANBAN_TIMEOUT_MS : HERMES_KANBAN_COLD_TIMEOUT_MS\)/,
    "and the default budget must key on it, so boardTick and the self-heal interval inherit it too");
  assert.match(gate, /if \(code === 0\) kanbanEverSucceeded = true;/,
    "one success flips it -- the cold cost is paid once per boot by whichever call is first");
  const coldMs = Number(gate.match(/const HERMES_KANBAN_COLD_TIMEOUT_MS = (\d+);/)?.[1]);
  const workMs = Number(gate.match(/const HERMES_KANBAN_TIMEOUT_MS = (\d+);/)?.[1]);
  assert.ok(coldMs > workMs, `the cold budget (${coldMs}ms) must exceed the work budget (${workMs}ms)`);
});

test("retries are few, because retrying was never what made it work", () => {
  // The 10-attempt version succeeded by accident: each killed attempt warmed the
  // page cache until one run finished inside 3s. Attempts exist now only to
  // distinguish a slow board from a dead one.
  const attempts = Number(gate.match(/const KANBAN_BOOT_ATTEMPTS = (\d+);/)?.[1]);
  assert.ok(attempts >= 2 && attempts <= 3,
    `${attempts} attempts: one to let the cold call finish, at most one more to tell dead from slow -- more than that is the cache-warming race again`);
});

test("a probe failure does not file a board defect, but is still printed", () => {
  // quiet suppresses the AUDIT only. An expected not-ready probe must not look
  // like a broken board in the operator's log -- the probe reports itself via
  // kanban_ready_at_boot / kanban_not_ready_at_boot. But it must never go fully
  // dark, so the console line stays unconditional.
  assert.match(gate, /if \(!quiet && now - last > HERMES_KANBAN_REAUDIT_MS\)/,
    "the audit is gated on quiet");
  const consoleLine = gate.match(/console\.error\("\[gate\] hermes kanban " \+ verb[\s\S]{0,220}?\);/);
  assert.ok(consoleLine && !/quiet/.test(consoleLine[0]),
    "the console line must NOT be gated on quiet -- silence and success must never look alike");
});

test("quiet and timeoutMs default to today's behaviour for every other caller", () => {
  assert.match(gate, /Number\(opts && opts\.timeoutMs\) > 0[\s\S]{0,40}?\? Number\(opts\.timeoutMs\)/,
    "an explicit timeoutMs still wins, and an absent or zero one must never mean 0");
  assert.match(gate, /: \(kanbanEverSucceeded \? HERMES_KANBAN_TIMEOUT_MS : HERMES_KANBAN_COLD_TIMEOUT_MS\)/,
    "and the fallback is the work budget once warm, the cold budget before that");
  assert.match(gate, /const quiet = Boolean\(opts && opts\.quiet\);/,
    "and an absent opts must mean 'audit as before' -- ~40 existing call sites pass nothing");
});
