// A failing board call must name WHO asked, not just what failed.
//
// #365 made `kanban_cli_error` name its cause. #367/#368 removed two boot-time
// callers that were being SIGKILLed inside the CLI's ~20-45s dead window. A
// THIRD one survives, measured on two consecutive boots 2026-08-11:
//
//   02:53:26  kanban_cli_error: list: killed by the gate's own 15s timeout
//   02:53:47  kanban_ready_at_boot: answered on attempt 7
//   03:02:57  kanban_cli_error: list: killed by the gate's own 15s timeout
//   03:03:24  kanban_ready_at_boot: answered on attempt 8
//
// Working backwards from the 15s budget, the killed `list` starts at the same
// instant the readiness probe starts -- i.e. at process start, not on a timer.
// It is provably not refreshBoardSummary (now gated on the probe) and not the
// contract check (that IS the probe, and it is quiet).
//
// Which of nine `list` call sites is it? The audit line could not say, because
// it names the verb and the cause but never the CALLER. Identifying it by
// elimination is exactly the detective work this field removes -- and the
// elimination has already been wrong once today (I inferred the rung-1 branch
// for a gated card and the measurement said otherwise).
//
// So: label the callers, take one boot, and read the answer instead of deducing
// it. Same order as every other fix in this series -- make it speak first.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const repoRoot = path.resolve(import.meta.dirname, "..");
const gate = fs.readFileSync(path.join(repoRoot, "container", "gate.js"), "utf8");
const { kanbanFailureCause } = createRequire(import.meta.url)(path.join(repoRoot, "container", "gate.js"));

// ---- RUNNING test: the cause decision is unchanged by this commit ----
test("the cause decision still behaves exactly as before", () => {
  assert.match(
    kanbanFailureCause({ errTail: "", timedOut: true, signal: "SIGKILL", code: null, timeoutMs: 15000 }),
    /15s timeout/,
    "adding a caller label must not disturb the cause it sits beside",
  );
  assert.equal(
    kanbanFailureCause({ errTail: "db is locked", timedOut: false, signal: null, code: 1 }),
    "db is locked",
  );
});

// ---- SOURCE-READING, labelled as such ----
// hermesKanban sits far below gate.js's lib-mode export, which returns before
// reaching it, so it cannot be required or executed. Same limit
// gated-backlog-reminder.test.js records for this file.

test("the caller is sanitised at capture, bounded, and optional", () => {
  assert.match(gate, /opts\.caller\.replace\(\/\[\^A-Za-z0-9_-\]\/g, ""\)\s*\n?\s*\.slice\(0, 32\)/,
    "stripped to a safe charset AND bounded, at the single point of capture");
  assert.match(gate, /typeof \(opts && opts\.caller\) === "string"/,
    "and absent opts must default to empty, so ~40 unlabelled callers are byte-identical");
});

test("the console sink cannot be forged by a label", () => {
  // audit() de-newlines and JSON-escapes its detail; console.error does neither.
  // That asymmetry is why the label is sanitised at capture rather than trusted
  // because "all callers are literals today". (Kimi, LOW.)
  const consoleLine = gate.match(/console\.error\("\[gate\] hermes kanban " \+ verb[\s\S]{0,220}?\);/);
  assert.ok(consoleLine, "the console line must still exist");
  assert.ok(/caller/.test(consoleLine[0]),
    "and it must carry the caller -- that is the whole point of the field");
});

test("all three failure surfaces carry the caller", () => {
  const surfaces = [...gate.matchAll(/\(caller \? " \[" \+ caller \+ "\]" : ""\)/g)];
  assert.ok(surfaces.length >= 3,
    `console line, audit detail, and the soft-failure audit must all carry it; found ${surfaces.length}`);
});

test("every list call site names itself, so the next offender cannot hide", () => {
  // This is the assertion that actually does the work. If someone adds a tenth
  // `list` call and leaves it unlabelled, the next unexplained boot failure is
  // undiagnosable again and this test fails loudly instead.
  const unlabelled = [...gate.matchAll(/hermesKanban\(\["list", "--json"\]\)/g)];
  assert.deepEqual(unlabelled.map(() => "unlabelled list call"), [],
    "every hermesKanban list call must pass a caller label");
  const labelled = [...gate.matchAll(/hermesKanban\(\["list", "--json"\], \{ caller: "([a-zA-Z]+)" \}\)/g)];
  assert.ok(labelled.length >= 9,
    `expected every known list call site to be labelled, found ${labelled.length}`);
  const names = labelled.map((m) => m[1]);
  assert.equal(new Set(names).size, names.length,
    `labels must be unique or the audit line cannot tell two callers apart: ${names.join(", ")}`);
});

test("the boot-reachable callers are among the labelled", () => {
  // These are the ones that can fire inside the CLI's dead window. The third
  // offender is one of them, and one boot after this ships will say which.
  for (const name of ["boardSummary", "boardTick", "channelBoardContext", "boxBoardText"]) {
    assert.match(gate, new RegExp(`caller: "${name}"`),
      `${name} can run at or near boot and must be identifiable in the log`);
  }
});
