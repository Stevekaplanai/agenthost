// t_0830d3f3: a jailed run that cannot produce output must fail LEGIBLY, not
// "(no output)". Five human approvals were burned retrying a defect the result
// message never named.
//
// UPDATED 2026-08-08. The original pins asserted one exact sentence: that the
// message blamed "the jail denies that write (box defect t_0830d3f3)". That
// attribution was measured and DISPROVEN -- the jail binds /codex read-write
// already; the write fails on the host because ~/.codex is agent:agent 0755 and
// the gate runs as uid 999. So the pins were holding a confident wrong cause in
// place. They now pin the PROPERTIES that actually matter and are deliberately
// silent about wording, so a future correction to the sentence is not a test
// failure while a regression of the behaviour still is.
//
// These remain source-reading tests, which is a weak form of proof: they show
// the code SAYS the right thing, not that it DOES it. `runAutonomousTask` is not
// exported and has no injection seam, so a behavioural test would require
// exporting it. Recorded as a known limit rather than dressed up.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const gate = fs.readFileSync(path.join(repoRoot, "container", "gate.js"), "utf8");

// The block that handles a run which produced nothing.
const silentBlock = (() => {
  const start = gate.indexOf("if (!hadRealOutput) {");
  assert.ok(start >= 0, "the no-output branch must exist");
  return gate.slice(start, gate.indexOf("const full = text", start));
})();

test("the autonomous runner detects the PATH-alias warning across chunk splits", () => {
  assert.match(
    gate,
    /if \(!pathAliasDenied && \(stderrTail \+ s\)\.includes\("could not create PATH aliases"\)\) pathAliasDenied = true;/,
    "detection joins the tail and the new chunk so a split warning still matches",
  );
});

test("a no-output run is always audited, whatever it said", () => {
  // The property: the audit fires on ANY silent run, not only one that happened
  // to match a known warning string. Previously a silent run without the alias
  // warning was recorded as nothing at all.
  assert.match(silentBlock, /audit\(/, "a silent run is auditable");
  assert.match(
    silentBlock,
    /autonomy_jail_alias_denied[\s\S]*autonomy_run_silent|autonomy_run_silent[\s\S]*autonomy_jail_alias_denied/,
    "both the alias case and the general silent case have an audit class -- neither is dropped",
  );
});

test("the audit carries the process's own last words, bounded", () => {
  assert.match(silentBlock, /stderrTail/, "the message is derived from what the process actually said");
  assert.match(silentBlock, /slice\(-400\)/, "bounded to a 400-byte tail");
  assert.match(silentBlock, /slice\(0, 200\)/, "capped at 200 chars");
  assert.match(silentBlock, /filter\(\(l\) => l\.trim\(\)\)\.pop\(\)/, "reduced to the last NON-EMPTY line");
  assert.match(silentBlock, /exit/, "the exit code is reported alongside the message");
});

test("the audit REDACTS before it caps", () => {
  // The security property (found by independent review, 2026-08-08). audit()
  // does not scrub -- its contract is cap + de-newline -- and the audit log is
  // permanent, agent-readable, and pasted into handoffs. Engine stderr is
  // exactly where a credential surfaces.
  assert.match(
    silentBlock,
    /chains\.redactSecrets\([\s\S]*autonomyRedactValues\(\)\)\.slice\(0, 200\)/,
    "redaction is applied BEFORE the cap -- capping first can slice a token into a fragment the redactor no longer matches but a reader still can",
  );
});

test("the message does not assert the disproven jail-denial cause", () => {
  // A negative pin. The jail binds /codex read-write; claiming it denies the
  // write sent readers to the wrong place on every silent Codex run. If someone
  // reintroduces that sentence, this fails.
  assert.ok(
    !/the jail denies that write/.test(gate),
    "the disproven 'the jail denies that write' attribution must not return",
  );
});

test("a run with real output is never failed by the alias warning alone", () => {
  // Unchanged safety property, now enforced by a BROADER guard: the audit fires
  // only when the run produced no output at all, so a degraded-but-working run
  // is untouched regardless of what its stderr said.
  // Index ordering, not a fixed-size lookback window: the guard must exist and
  // must come before the message is built. A character-count window silently
  // breaks when comments are added, which makes the test about formatting
  // rather than about the property.
  const guard = gate.indexOf("if (!hadRealOutput) {");
  const message = gate.indexOf("const full = text");
  assert.ok(guard >= 0, "the no-output guard exists");
  assert.ok(message > guard, "the guard precedes the message construction");
  assert.ok(
    !/if \(!hadRealOutput && pathAliasDenied\)/.test(gate),
    "the audit is no longer narrowed to the alias case -- a silent run with any other cause is still recorded",
  );
});
