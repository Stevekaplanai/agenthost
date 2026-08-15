// A failing `hermes kanban` call must say WHY (Cardinal Rule 16).
//
// Measured on the live box 2026-08-10: `kanban_cli_error` has fired **495 times
// since 2026-07-23**, and the ones that matter carry no cause at all:
//
//   {"event":"kanban_cli_error","detail":"list: "}
//   {"event":"kanban_cli_error","detail":"-h: "}
//   [gate] hermes kanban list failed (exit null):
//
// `exit null` is the tell. In Node, `code === null` on close means the child was
// killed by a SIGNAL, and the gate's own 15s timer is what sends it:
//
//   const timer = setTimeout(() => { p.kill("SIGKILL"); finish(null); }, 15000);
//
// A SIGKILLed process never gets to write stderr, so `err` is empty BY
// CONSTRUCTION on exactly the failures that most need explaining. The audit
// detail was built as `verb + ": " + errTail`, which for an empty tail is the
// bare string "list: ".
//
// This is the same defect the classifier had on 2026-08-09, where a 10s timeout
// was manufacturing the failure it then reported. The fix order there is the fix
// order here: make the timeout SPEAK first, and only then argue about the number.
// This commit deliberately does not retune 15s — that decision now has evidence
// to be made on, and did not before.
//
// These tests RUN the real decision. `kanbanFailureCause` was extracted above
// gate.js's lib-mode export precisely so the part that carried the bug is
// executable rather than only source-readable.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const repoRoot = path.resolve(import.meta.dirname, "..");
const require_ = createRequire(import.meta.url);
const { kanbanFailureCause } = require_(path.join(repoRoot, "container", "gate.js"));
const gate = fs.readFileSync(path.join(repoRoot, "container", "gate.js"), "utf8");

// ---- RUNNING tests ----

test("the exact production failure now names its cause", () => {
  // What the box actually produced: SIGKILL from our own timer, empty stderr.
  const cause = kanbanFailureCause({
    errTail: "", timedOut: true, signal: "SIGKILL", code: null, timeoutMs: 15000,
  });
  assert.match(cause, /15s timeout/, "the operator must learn the gate killed it, not that it merely 'failed'");
  assert.notEqual(cause.trim(), "", 'the old value here was "" -- which rendered as the bare detail "list: "');
});

test("a timeout with partial stderr reports BOTH, losing neither", () => {
  // A CLI can write a line and then hang. Reporting only its last words would
  // hide that the gate killed it — the more actionable half. Reporting only the
  // timeout would discard the CLI's own words, which is the discarded-stderr
  // mistake that cost six hours on 2026-08-01. Kimi's review argued the first
  // half; this keeps both.
  const cause = kanbanFailureCause({
    errTail: "cannot open board: db is locked", timedOut: true, signal: "SIGKILL", code: null, timeoutMs: 15000,
  });
  assert.match(cause, /15s timeout/, "the gate's own kill must never be hidden behind CLI output");
  assert.match(cause, /db is locked/, "and the CLI's own words must never be discarded");
});

test("without a timeout, real stderr is the whole answer", () => {
  assert.equal(
    kanbanFailureCause({ errTail: "cannot open board: db is locked", timedOut: false, signal: null, code: 1 }),
    "cannot open board: db is locked",
    "no inference is needed or wanted when the CLI explained itself",
  );
});

test("a missing timeoutMs degrades to a word, never to a wrong number", () => {
  // Guards the "0s timeout" render Kimi flagged: a caller that forgets timeoutMs
  // must not produce a confident, false figure in the audit log.
  const cause = kanbanFailureCause({ errTail: "", timedOut: true, signal: "SIGKILL", code: null });
  assert.match(cause, /configured timeout/);
  assert.doesNotMatch(cause, /\b0s\b/, "a fabricated 0s is worse than saying 'configured'");
});

test("our timeout is distinguished from the CLI dying on its own", () => {
  const ours = kanbanFailureCause({ errTail: "", timedOut: true, signal: "SIGKILL", code: null, timeoutMs: 15000 });
  const theirs = kanbanFailureCause({ errTail: "", timedOut: false, signal: "SIGKILL", code: null, timeoutMs: 15000 });
  assert.notEqual(ours, theirs,
    "these are different bugs with opposite fixes; code === null alone cannot tell them apart");
  assert.match(theirs, /signal SIGKILL/);
});

test("a silent non-zero exit admits that nothing is known", () => {
  const cause = kanbanFailureCause({ errTail: "", timedOut: false, signal: null, code: 3 });
  assert.match(cause, /no cause the gate can see/,
    "an honest 'I do not know' is required -- silence is what produced 495 unreadable rows");
  assert.match(cause, /exited 3/, "and the exit code is still carried, because it is the only fact available");
});

test("whitespace-only stderr counts as absent, not as a cause", () => {
  // A tail of "\n  \n" is what a CLI that opened a stream and wrote nothing
  // leaves behind. Treating it as a real message would print a blank reason and
  // reintroduce the original bug wearing different bytes.
  const cause = kanbanFailureCause({ errTail: "\n   \n", timedOut: true, signal: "SIGKILL", code: null, timeoutMs: 15000 });
  assert.match(cause, /15s timeout/);
});

// ---- SOURCE-READING test, labelled as such ----
// The spawn wrapper sits far below gate.js's lib-mode export and returns before
// it is defined, so it cannot be required or executed from a test. Same limit
// gated-backlog-reminder.test.js records. This shows the wiring says the right
// thing, not that it does it — stated plainly rather than dressed up.
test("all three failure surfaces read from the one decision", () => {
  assert.match(gate, /const causeOf = \(tail\) => kanbanFailureCause\(\{/,
    "the wrapper must bind one cause per close event");
  // Three CALL SITES: the console line, the audit detail, and lastKanbanError
  // (which is what a downstream autonomy_claim_failed reads). The definition is
  // an arrow assignment and so contains no `causeOf(` of its own — counting it
  // was my own off-by-one, corrected here rather than by loosening the check.
  const uses = [...gate.matchAll(/causeOf\(/g)];
  assert.ok(uses.length >= 3,
    "console line, audit detail, and lastKanbanError must all read the one decision — "
    + "three hand-rolled copies is how two of them later disagree about the same failure");
  assert.match(gate, /let timedOut = false;/,
    "the wrapper must record that OUR timer fired; without it the close handler cannot tell whose kill it was");
  // `\s*\n` would be a bug here: \s* is greedy and consumes the newline the \n
  // then demands. Match the ordering directly instead.
  assert.match(gate, /timedOut = true;\s+try \{ p\.kill\("SIGKILL"\); \} catch \{\}/,
    "the flag must be set BEFORE the kill, or the close handler can race it");
});
