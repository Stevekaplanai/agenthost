// TERMINATION PROOF is what permits an autonomous run to mutate git and the
// board. Reviews ignore the field; an author does not. So it must mean "somebody
// observed this child stop", never "the exit handler ran".
//
// Why this test exists at all: #342 shipped the autonomous verb with no caller.
// Wiring the caller without this field would have produced the worst shape we
// have -- codex authors real code, exits clean, and the ladder silently refuses
// to commit it, with the cause three functions away from the symptom. The
// opposite error is worse: fabricate the proof and a run that may still be
// writing is authorised to commit.
//
// Injected transport, real decoder, same shape as test/review-runs-as-agent.js.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import gate from "../container/gate.js";
import adapters from "../container/engine-adapters.js";
import chainsLib from "../container/chains-lib.js";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

// exitArgs is spread into child.emit("exit", ...) so a test can produce the
// three endings that matter: a real code, a signal, and the socket-error case
// where the client synthesises an exit nobody observed.
function chatProtocol(answer, exitArgs, stderr = "") {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    process.nextTick(() => {
      if (answer !== null) {
        child.stdout.emit("data", JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: answer },
        }) + "\n");
      }
      if (stderr) child.stderr.emit("data", stderr);
      child.emit("exit", ...exitArgs);
    });
    return child;
  };
}

const deps = (answer, exitArgs, stderr) => ({
  runViaChatSocket: chatProtocol(answer, exitArgs, stderr),
  decodeLine: adapters.codexLineTransform,
  makeDecodeState: adapters.codexMakeState,
  redact: (t) => chainsLib.redactSecrets(t, []),
});

test("a clean exit reported by root IS termination proof", async () => {
  const r = await gate.runReviewViaChatSocket("codex", "author it", 5000, deps("done", [0]));
  assert.equal(r.ranClean, true);
  assert.equal(r.terminationProven, true,
    "root emits its exit frame only after the child is gone -- a real exit code is an observation, and without it an authored commit can never land");
});

test("a non-zero exit is still termination proof, even though the run failed", async () => {
  const r = await gate.runReviewViaChatSocket("codex", "author it", 5000, deps("partial", [1]));
  assert.equal(r.ranClean, false, "a failed run is not clean");
  assert.equal(r.terminationProven, true,
    "'it failed' and 'it is still running' are different facts and must not be collapsed");
});

test("a kill by signal is termination proof", async () => {
  const r = await gate.runReviewViaChatSocket("codex", "author it", 5000, deps("partial", [null, "SIGKILL"]));
  assert.equal(r.terminationProven, true, "a signal is how the child stopped, which is an observation of it stopping");
});

test("a socket error must NOT claim termination proof", async () => {
  // The client synthesises exit(null, null) so the run cannot hang. At that
  // moment nobody has seen the child stop. Root does SIGKILL its activeRuns on a
  // dropped connection, but that is an expectation, not an observation -- and
  // this field authorises a commit.
  const r = await gate.runReviewViaChatSocket("codex", "author it", 5000, deps("some output", [null, null]));
  assert.equal(r.ranClean, false, "an unobserved ending is not a clean run");
  assert.equal(r.terminationProven, false,
    "fabricating proof here lets a run that may still be writing authorise a commit");
});

test("a run that wrote nothing still reports how it ended", async () => {
  const r = await gate.runReviewViaChatSocket("codex", "author it", 5000,
    deps(null, [1], "Error: could not create PATH aliases\n"));
  assert.equal(r.ranClean, false);
  assert.equal(r.terminationProven, true);
  assert.match(r.text, /could not create PATH aliases/,
    "the engine's own words are the diagnosis -- discarding them is the six-hour incident of 2026-08-01");
});

test("the existing review callers see no behaviour change", async () => {
  // Reviews never read terminationProven. Adding it must not alter ranClean or
  // text for the paths that were already green, or this lands as a silent
  // regression in the review layer it borrowed.
  const r = await gate.runReviewViaChatSocket("codex", "judge this", 5000,
    deps("VERDICT: APPROVE\nLooks right.", [0]));
  assert.equal(r.ranClean, true);
  assert.match(r.text, /VERDICT: APPROVE/);
});

// A SOURCE assertion, and deliberately so. Everything above runs the real code;
// this one cannot, because runAutonomousTask is not exported and exporting it to
// satisfy a test would widen the module's surface for no other reason.
//
// It is not a behaviour test pretending to be one. It detects exactly one
// regression -- the one that actually happened in #342 -- where the autonomous
// verb exists, is correct, is reviewed, and NOTHING CALLS IT. A grep is a
// legitimate detector for "the caller is missing"; it would be an illegitimate
// one for "the caller works", which is not what it claims.
test("the autonomous verb has a caller, and it passes a worktree", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(
    path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");

  const call = src.match(
    /runReviewViaChatSocket\(\s*eng\.label,\s*prompt,\s*BOARD_RUN_TIMEOUT_MS,\s*\{\s*worktree:\s*grantedWorktree\s*\}\s*\)/);
  assert.ok(call,
    "runAutonomousTask must dispatch codex through the root runner with a worktree -- without this the verb added in #342 is unreachable and codex fails exactly as it did before, which reads as a wrong diagnosis rather than a missing call");

  const guard = src.match(/if \(FOUNDATION_B && eng\.label === "codex" && grantedWorktree\)/);
  assert.ok(guard,
    "the dispatch must be gated on Foundation B, codex, and an actual granted worktree, so the local path stays the fallback");

  // ANCHORED TO THE DISPATCH BLOCK, and that is the whole point of this
  // assertion's shape. The first version matched `closeJailPins();` followed by
  // `if (scratch)` anywhere in the file -- which is the body of
  // privateWorkspaceDenied(), unrelated code several hundred lines away. It
  // passed while asserting nothing about the branch it named. A source
  // assertion that matches the wrong region is worse than no assertion,
  // because it reports a control that is not there.
  const block = src.slice(
    src.indexOf('if (FOUNDATION_B && eng.label === "codex" && grantedWorktree)'));
  assert.ok(block, "the dispatch branch must exist to be checked");
  // Wide enough to cover the whole branch including its comments. Sized to the
  // block, not guessed: a window that clips the branch fails for a reason that
  // has nothing to do with the control it is checking.
  const body = block.slice(0, 4000);

  assert.match(body, /workspacePin && typeof workspacePin\.fd === "number"/,
    "workspacePin.fd is pushed to jailPinFds by inheritedBind(), which this branch skips -- without closing it explicitly the gate leaks one descriptor per dispatched task and eventually cannot open anything, far from the cause");

  assert.match(body, /quarantineAgentLane\(/,
    "an ending nobody observed must quarantine the lane exactly as the local path does; dispatching through root does not make a possibly-live child safe");
});

// The path Codex caught on re-review, and the reason the caller is now
// fail-closed. A timeout SIGKILLs the child and never confirms it died -- so it
// is the single most likely way a real run ends badly, and it was returning no
// field at all. A caller checking `=== false` treated that as fine.
test("a timeout must NOT claim termination proof", async () => {
  const hangs = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};           // deliberately never emits "exit"
    return child;
  };
  const r = await gate.runReviewViaChatSocket("codex", "author it", 120, {
    runViaChatSocket: hangs,
    decodeLine: adapters.codexLineTransform,
    makeDecodeState: adapters.codexMakeState,
    redact: (t) => chainsLib.redactSecrets(t, []),
  });
  assert.equal(r.ranClean, false);
  assert.equal(r.terminationProven, false,
    "the kill is best-effort and nothing confirmed the child stopped; a caller must be able to tell this apart from a clean ending");
  assert.match(r.text, /timed out/, "and it must still name the cause");
});

test("a refusal that never started a child IS termination proof", async () => {
  // Nothing was spawned, so nothing is running. Reporting this as unproven
  // would quarantine the shared lane over a malformed input, which is a false
  // positive that stalls every later task.
  const r = await gate.runReviewViaChatSocket("codex", "author it", 5000, {
    worktree: "/not/under/workspaces/../../etc",
    runViaChatSocket: () => { throw new Error("must not be called"); },
    // The real redactor must be injected even on a path that produces no engine
    // output: autonomyRedactValues lives below gate.js's lib-mode return, so
    // without this done() takes its redaction-failure branch and rewrites the
    // text -- and the assertion below would be checking that branch instead of
    // the refusal it names.
    redact: (t) => chainsLib.redactSecrets(t, []),
  });
  assert.equal(r.ranClean, false);
  assert.equal(r.terminationProven, true,
    "no child was created, so termination is trivially true -- quarantining here would stall the lane on bad input");
  assert.match(r.text, /malformed worktree/);
});

// The client knows things this handler cannot. A connect that throws, or a drop
// before the run request was ever written, both surface as exit(null, null) --
// byte-identical to a drop AFTER the request, which is genuinely unproven. Only
// the client can tell them apart, and it already does.
//
// Deriving proof from (code, signal) collapsed the two and would have
// quarantined the shared lane over a connection that failed before starting
// anything, stalling every later task. (Codex, third review.)
test("the child's own termination flag wins over the derived one", async () => {
  const nothingEverStarted = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    // Exactly what maintenance-chat-client does when connect() throws: no child
    // was ever started, so termination is proven, and the exit args are empty.
    child.terminationProven = true;
    process.nextTick(() => child.emit("exit", null, null));
    return child;
  };
  const r = await gate.runReviewViaChatSocket("codex", "author it", 5000, {
    runViaChatSocket: nothingEverStarted,
    decodeLine: adapters.codexLineTransform,
    makeDecodeState: adapters.codexMakeState,
    redact: (t) => chainsLib.redactSecrets(t, []),
  });
  assert.equal(r.terminationProven, true,
    "a connection that failed before starting anything must not read as an unproven ending, or a harmless failure quarantines the lane");
});

test("a child that reports an UNPROVEN ending is believed too", async () => {
  const droppedAfterSend = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    child.terminationProven = false;   // request was sent, then the socket died
    process.nextTick(() => {
      child.stdout.emit("data", JSON.stringify({
        type: "item.completed", item: { type: "agent_message", text: "half a result" },
      }) + "\n");
      // A plain exit(0) that would otherwise derive to PROVEN -- the flag must
      // still win, or a dropped socket can launder itself into a clean ending.
      child.emit("exit", 0);
    });
    return child;
  };
  const r = await gate.runReviewViaChatSocket("codex", "author it", 5000, {
    runViaChatSocket: droppedAfterSend,
    decodeLine: adapters.codexLineTransform,
    makeDecodeState: adapters.codexMakeState,
    redact: (t) => chainsLib.redactSecrets(t, []),
  });
  assert.equal(r.terminationProven, false,
    "the flag must win in BOTH directions; otherwise a clean-looking exit code launders an unobserved ending into an authorised one");
});
