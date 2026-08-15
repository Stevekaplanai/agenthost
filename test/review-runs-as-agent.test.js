// P0-CODEX-CANNOT-REVIEW: the reviewer must run as AGENT, not as the gate uid.
//
// Proven on the live box on 2026-08-09, thirty-four seconds apart, same binary,
// same box, same credentials:
//
//   18:21:48  gate_classify_pass          "PASS: ..."                     eng=codex
//   18:22:22  autonomy_jail_alias_denied  Permission denied (os error 13) eng=codex
//
// The classifier routes through runViaChatSocket, where the ROOT runner launches
// the engine as agent. The reviewer used runAutonomousTask, which spawns locally
// -- and under FOUNDATION_B the gate is uid 997 while ~/.codex/auth.json is 0600
// agent (1001), so codex cannot read its own login and dies before starting.
//
// Two changes tried to fix that with chown/chgrp. Neither could: a 0600 file
// does not care about its group. #320 proved it -- auth.json stayed correctly
// unreadable by gate and the error did not change. It was never a permission
// bug; it was a uid bug.
//
// These tests exercise the REAL decode path with the REAL engine adapter and an
// injected transport, the shape that test/classifier-transport.test.js
// established after a mock that could not fail the way production fails let the
// original transport bug ship.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import gate from "../container/gate.js";
import adapters from "../container/engine-adapters.js";
import chainsLib from "../container/chains-lib.js";

// A fake root chat runner emitting the real chat-protocol event stream.
function chatProtocol(answer, { exitCode = 0, stderr = "" } = {}) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    process.nextTick(() => {
      child.stdout.emit("data", JSON.stringify({ type: "thread.started", thread_id: "t_1" }) + "\n");
      child.stdout.emit("data", JSON.stringify({ type: "turn.started", turn_id: "u_1" }) + "\n");
      if (answer !== null) {
        child.stdout.emit("data", JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: answer },
        }) + "\n");
      }
      if (stderr) child.stderr.emit("data", stderr);
      child.emit("exit", exitCode);
    });
    return child;
  };
}

// The REAL redactor, injected. autonomyRedactValues() lives below gate.js's
// lib-mode early return, so under require() it is undefined and calling it
// throws -- which the catch inside done() swallows, leaving text unredacted
// while the test looks green. That is a control that silently does nothing,
// checked by a test that silently checks nothing, which is the pair this whole
// PR keeps finding. Injecting chains-lib's real redactSecrets means these
// assertions exercise the actual redaction code.
const realRedact = (t) => chainsLib.redactSecrets(t, []);

const withCodexDecoder = (answer, opts) => ({
  runViaChatSocket: chatProtocol(answer, opts),
  decodeLine: adapters.codexLineTransform,
  makeDecodeState: adapters.codexMakeState,
  redact: realRedact,
});

test("a review verdict survives the chat protocol's JSON event stream", async () => {
  const r = await gate.runReviewViaChatSocket(
    "codex", "judge this", 5000,
    withCodexDecoder("VERDICT: APPROVE\nThe result is correct and complete."));
  assert.equal(r.ranClean, true, "a decoded verdict is a clean run");
  assert.match(r.text, /VERDICT: APPROVE/,
    "the verdict must survive decoding -- parsing the event stream as plain text is what broke the classifier in #279");
});

test("a REJECT verdict survives too, unaltered", async () => {
  const r = await gate.runReviewViaChatSocket(
    "codex", "judge this", 5000,
    withCodexDecoder("VERDICT: REJECT\nThe base case is missing."));
  assert.equal(r.ranClean, true);
  assert.match(r.text, /VERDICT: REJECT/, "a rejection must reach the caller intact");
  assert.match(r.text, /base case is missing/, "and carry its reason, which becomes the correction");
});

test("an engine that writes nothing fails NOT-clean and says so", async () => {
  const r = await gate.runReviewViaChatSocket(
    "codex", "judge this", 5000, withCodexDecoder(null));
  assert.equal(r.ranClean, false, "no verdict is not a clean run -- the caller must not read it as one");
  assert.match(r.text, /wrote nothing/, "and must name what happened");
});

test("a stderr-only failure carries the engine's own words", () => {
  // The exact live failure this whole change exists to remove.
  return gate.runReviewViaChatSocket("codex", "judge this", 5000, withCodexDecoder(null, {
    exitCode: 1,
    stderr: "Error: failed to initialize in-process app-server client: Permission denied (os error 13)\n",
  })).then((r) => {
    assert.equal(r.ranClean, false);
    assert.match(r.text, /Permission denied \(os error 13\)/,
      "stderr must reach the operator -- discarding it is what cost six hours on 2026-08-01");
  });
});

test("a transport that refuses to start fails closed with its reason", async () => {
  const r = await gate.runReviewViaChatSocket("codex", "judge this", 5000, {
    runViaChatSocket: () => { throw new Error("socket refused"); },
    redact: realRedact,
  });
  assert.equal(r.ranClean, false, "a reviewer that never started did not approve anything");
  assert.match(r.text, /socket refused/, "and must name the cause, not just fail");
});

test("a hung reviewer times out and names what it saw", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  const r = await gate.runReviewViaChatSocket("codex", "judge this", 200, {
    runViaChatSocket: () => child,  // never exits
    decodeLine: adapters.codexLineTransform,
    makeDecodeState: adapters.codexMakeState,
    redact: realRedact,
  });
  assert.equal(r.ranClean, false, "a timed-out review must never read as clean");
  assert.match(r.text, /timed out/, "and must say that is why");
  assert.match(r.text, /raw=\d+B/, "carrying the counters that tell transport from decoder apart");
});

// A timeout that arrives AFTER some output must still say it timed out.
//
// The first version returned `full || cause`, so a reviewer that emitted text
// and then hung came back carrying only that text -- a failure that does not
// name its cause, in the function whose own comment cites the rule against it.
// (Kimi K3, LOW, reviewing #321.)
//
// CORRECTION: this comment used to end "the caller gates on ranClean, so a
// truncated verdict was never going to be read as a verdict." That was FALSE.
// The caller ignored ranClean entirely and parsed `text` directly, so a hung
// reviewer's partial "VERDICT: APPROVE" WAS an approval. Kimi found it on the
// next pass (HIGH) and the gate is now real — see the ranClean test at the end
// of this file. Leaving the wrong claim here would have been a comment asserting
// a safety property the code did not have, which is the defect this branch
// exists to remove.
test("a timeout keeps its cause even when the engine had already said something", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  const r = await gate.runReviewViaChatSocket("codex", "judge this", 250, {
    runViaChatSocket: () => {
      process.nextTick(() => {
        child.stdout.emit("data", JSON.stringify({ type: "thread.started", thread_id: "t_1" }) + "\n");
        child.stdout.emit("data", JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "VERDICT: APPROVE" },
        }) + "\n");
        // then hangs: never exits
      });
      return child;
    },
    decodeLine: adapters.codexLineTransform,
    makeDecodeState: adapters.codexMakeState,
    redact: realRedact,
  });
  assert.equal(r.ranClean, false, "a hung review is not clean no matter what it managed to emit");
  assert.match(r.text, /timed out/,
    "the cause must survive -- partial output must not overwrite the reason it failed");
  assert.match(r.text, /partial output before the timeout/,
    "and the partial text must be LABELLED as partial, not presented as the answer");
  assert.match(r.text, /VERDICT: APPROVE/,
    "while still carrying what the engine actually said, which is evidence either way");
});

// The wiring itself. Source-text, and the same caveat as its neighbours: the
// review call site sits behind a durable claim, the kanban CLI and a lease, with
// no seam to call it through. It is here because the ABSENCE of this assertion
// is exactly how the reviewer stayed on the local-spawn path through the whole
// Foundation B migration while every other call site moved.
test("the review call site routes through the chat socket under FOUNDATION_B", () => {
  // Normalise CRLF first: gate.js is checked out with \r\n on Windows, so an
  // anchor written with \n silently matches nothing and the test fails for a
  // reason that has nothing to do with the code it guards.
  const src = fs.readFileSync(path.join(process.cwd(), "container", "gate.js"), "utf8").replace(/\r\n/g, "\n");
  // Anchor on the ternary's own opening, not on "(spawnReviewer" -- that first
  // matches inside resolveEngine(spawnReviewer) hundreds of lines earlier, and
  // "runGeminiReviewOnce(prompt)" appears earlier still, so the naive slice ran
  // backwards and silently produced an empty string. An assertion against an
  // empty slice fails for the wrong reason, which is its own small version of
  // the bug this file is about.
  const start = src.indexOf("(spawnReviewer\n");
  assert.ok(start > 0, "the review ternary must still be findable");
  const site = src.slice(start, start + 700);
  assert.match(site, /FOUNDATION_B/,
    "the reviewer must pick its transport by the flag, like every other migrated call site");
  assert.match(site, /runReviewViaChatSocket\(spawnReviewer, prompt/,
    "flag ON must use the root runner, which launches the engine as agent");
  assert.match(site, /runAutonomousTask\(eng, prompt/,
    "flag OFF must keep the old local spawn verbatim -- there the gate IS agent");
});

// A VERDICT IS ONLY A VERDICT IF THE RUN WAS CLEAN.
//
// (Kimi K3, HIGH, reviewing #321. I had asserted the opposite twice -- in the PR
// body and in a comment -- without checking. It was never true.)
//
// ranClean was computed and then ignored: the consumption site read
//
//     const text = result ? result.text : "";
//     const m = REVIEW_VERDICT_RE.exec(text);
//
// so a reviewer that TIMED OUT after emitting "VERDICT: APPROVE" was parsed as
// an approval and the task completed. A hung engine could approve work — the
// review layer inverting itself, the same class as the REJECT fall-through in
// #316, one layer up.
//
// Source-text, with the standing caveat: the consumption site sits behind a
// durable claim, the kanban CLI and a lease. The ABSENCE of this assertion is
// how a computed-then-discarded safety field survived.
test("a verdict is only parsed when the run was clean", () => {
  const src = fs.readFileSync(path.join(process.cwd(), "container", "gate.js"), "utf8").replace(/\r\n/g, "\n");

  const spawned = src.slice(src.indexOf('const text = result ? result.text : ""'));
  assert.match(spawned.slice(0, 1200), /const m = \(result && result\.ranClean === true\) \? REVIEW_VERDICT_RE\.exec\(text\) : null;/,
    "the spawned reviewer's verdict must be gated on ranClean, not parsed straight out of text");

  const api = src.slice(src.indexOf('const apiText = apiResult ? apiResult.text : ""'));
  assert.match(api.slice(0, 800), /const apiM = \(apiResult && apiResult\.ranClean === true\) \? REVIEW_VERDICT_RE\.exec\(apiText\) : null;/,
    "the API fallback's verdict must be gated identically -- one rule, both transports");

  // And the API path must actually SET the field, or the gate above rejects
  // every fallback verdict and the board silently stops using its only working
  // reviewer.
  assert.match(src, /return result \? \{ \.\.\.result, ranClean: true \} : result;/,
    "runGeminiReviewOnce must stamp ranClean, or gating on it turns every fallback into a no-verdict");
});

// HOW THE RUN ENDED IS PART OF WHETHER IT WAS CLEAN. (Kimi K3, HIGH, #321.)
//
// The exit handler returned ranClean:true whenever any text decoded, ignoring
// code and signal. A reviewer that emitted "VERDICT: APPROVE" and then crashed
// -- or was OOM-killed mid-sentence -- came back as a clean approval: "non-empty
// text means success", the exact anti-pattern the ranClean gate exists to stop,
// reintroduced inside the function that feeds it.
test("a reviewer that crashes after emitting a verdict is NOT clean", async () => {
  const r = await gate.runReviewViaChatSocket(
    "codex", "judge this", 5000,
    withCodexDecoder("VERDICT: APPROVE\nLooks fine to me.", { exitCode: 1 }));
  assert.equal(r.ranClean, false,
    "a crash after the verdict is not a verdict -- the run did not finish");
  assert.match(r.text, /exited 1/, "and the audit must name how it ended");
  assert.match(r.text, /VERDICT: APPROVE/,
    "while keeping what it managed to say, labelled as output-before-it-ended");
});

test("a reviewer killed by a signal after emitting a verdict is NOT clean", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  const r = await gate.runReviewViaChatSocket("codex", "judge this", 5000, {
    runViaChatSocket: () => {
      process.nextTick(() => {
        child.stdout.emit("data", JSON.stringify({ type: "thread.started", thread_id: "t_1" }) + "\n");
        child.stdout.emit("data", JSON.stringify({
          type: "item.completed", item: { type: "agent_message", text: "VERDICT: APPROVE" },
        }) + "\n");
        child.emit("exit", null, "SIGKILL");   // OOM-killed mid-run
      });
      return child;
    },
    decodeLine: adapters.codexLineTransform,
    makeDecodeState: adapters.codexMakeState,
    redact: realRedact,
  });
  assert.equal(r.ranClean, false, "an OOM-killed reviewer did not approve anything");
  assert.match(r.text, /killed by SIGKILL/, "and must name the signal, not just fail");
});

test("a clean exit with a verdict is still clean", () => {
  // The guard must not refuse everything. A guard that fires on the happy path
  // is how #319's first version would have made --update permanently unusable.
  return gate.runReviewViaChatSocket(
    "codex", "judge this", 5000,
    withCodexDecoder("VERDICT: APPROVE\nAll good.", { exitCode: 0 })
  ).then((r) => {
    assert.equal(r.ranClean, true, "exit 0 with decoded text is the happy path and must stay clean");
    assert.match(r.text, /VERDICT: APPROVE/);
  });
});

// TRIPWIRE for the containment tradeoff. (Kimi K3, LOW, #321.)
//
// This branch trades the bwrap read-jail for a review turn to fix the uid, and
// says so in a comment. Kimi is right that a comment is not enforcement: without
// one, a stated-temporary compromise quietly becomes an unstated invariant.
//
// The trigger is NOT "the worker runtime stops being dormant" -- my first
// version tested that and it fired immediately, which is how I found that the
// module's own "DORMANT: not wired into any boot path" header is stale.
// maintenance-boot-entry.js requires it at 353 and calls createWorkerRuntime()
// at 377. It is live.
//
// What actually blocks reviews from using it is that it launches only compiled
// profiles selected by profileId, with a (profileId, engine, runKind, repoId)
// binding the protocol enforces -- and no review profile or binding exists. So
// THAT is the trigger: the moment a review binding is declared, the
// jail-preserving path is available and the reviewer must stop using the chat
// socket.
test("once a review profile binding exists, the reviewer must migrate to it", () => {
  const dir = path.join(process.cwd(), "container");
  const declaring = fs.readdirSync(dir)
    .filter((f) => f.endsWith(".js") && f !== "gate.js")
    // Strip comments first. (Kimi K3, LOW, #321.) The raw regex matched any
    // MENTION of a review run-kind, including the sentence in a comment
    // explaining why one does not exist yet -- so a future note about this
    // tripwire could trip the tripwire. Same defect as my first version, which
    // fired on a stale header. A guard that fires on prose is not a guard.
    .filter((f) => {
      const code = fs.readFileSync(path.join(dir, f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .split(String.fromCharCode(10))
        .map((line) => line.replace(/\/\/.*$/, ""))
        .join(String.fromCharCode(10));
      return /runKind:\s*["'`]review/.test(code);
    });

  if (declaring.length === 0) return;   // no review binding yet: the tradeoff stands as documented

  // String.fromCharCode instead of escapes: this file is written through a
  // Git Bash + heredoc path that ate the backslashes twice and produced a
  // literal newline inside a regex, so the source no longer parsed. Same
  // workaround, same reason, as elsewhere in this repo.
  const CR = String.fromCharCode(13), LF = String.fromCharCode(10);
  const gateSrc = fs.readFileSync(path.join(dir, "gate.js"), "utf8").split(CR + LF).join(LF);
  const start = gateSrc.indexOf("(spawnReviewer" + LF);
  const site = start > 0 ? gateSrc.slice(start, start + 700) : "";
  assert.ok(!/runReviewViaChatSocket\(spawnReviewer, prompt/.test(site),
    "a review profile binding is now declared in " + declaring.join(", ") +
    " -- the jail-preserving worker-runtime path is available, so the reviewer must " +
    "move to it instead of the chat socket. See the tradeoff comment on runReviewViaChatSocket.");
});

// REDACTION. (Kimi K3, HIGH, #321.)
//
// runAutonomousTask ends with
//   finish({ text: chains.redactSecrets(full, autonomyRedactValues()), ... })
// and the first version of runReviewViaChatSocket returned raw engine output.
// That text lands on board comments and in the audit log -- both permanent,
// both read by other agents -- and engine stderr is exactly where a key
// surfaces: an auth failure echoing a header, a 401 body. Swapping the
// transport must not quietly drop a control the old path had.
test("engine output is redacted before it can reach a board comment or the audit", async () => {
  const leaked = "ghp_" + "A".repeat(28);
  const r = await gate.runReviewViaChatSocket(
    "codex", "judge this", 5000,
    withCodexDecoder("VERDICT: APPROVE\nI used the token " + leaked + " to check."));
  assert.equal(r.ranClean, true);
  assert.ok(!r.text.includes(leaked),
    "a token-shaped string in engine output must never survive into the returned text");
  assert.match(r.text, /\[REDACTED\]/, "and must be visibly redacted, not silently stripped");
  assert.match(r.text, /VERDICT: APPROVE/, "while the verdict itself is untouched");
});

test("redaction covers the failure paths too, not just the clean one", async () => {
  const leaked = "sk-" + "B".repeat(24);
  const r = await gate.runReviewViaChatSocket("codex", "judge this", 5000, withCodexDecoder(null, {
    exitCode: 1,
    stderr: "Error: auth rejected for " + leaked + "\n",
  }));
  assert.equal(r.ranClean, false);
  assert.ok(!r.text.includes(leaked),
    "stderr is the MOST likely place a key appears -- the failure path must be redacted, not only the success path");
  assert.match(r.text, /\[REDACTED\]/);
});

// USAGE. (Kimi K3, LOW, #321.) runAutonomousTask returned usage and the callers
// charge it to the task's chain, so dropping it made the review half of every
// task free in the cost rail.
test("the resolved result carries a usage field for the cost rail", async () => {
  const r = await gate.runReviewViaChatSocket(
    "codex", "judge this", 5000, withCodexDecoder("VERDICT: APPROVE\nfine"));
  assert.ok("usage" in r,
    "callers do `if (result && result.usage)` -- the field must exist, even when the adapter reports none");
});

// The SECOND review path. (Kimi K3, HIGH, #321.) I fixed the board review and
// missed the pull-request review entirely, which would have left it failing with
// the identical os error 13 while this PR claimed the bug was closed.
test("the pull-request review routes through the chat socket under FOUNDATION_B too", () => {
  const LF = String.fromCharCode(10);
  const src = fs.readFileSync(path.join(process.cwd(), "container", "gate.js"), "utf8")
    .split(String.fromCharCode(13) + LF).join(LF);
  const start = src.indexOf("Reviewing PR #");
  assert.ok(start > 0, "the Git review call site must still be findable");
  const site = src.slice(Math.max(0, start - 900), start + 200);
  assert.match(site, /FOUNDATION_B/,
    "the PR reviewer must pick its transport by the flag, like the board reviewer");
  assert.match(site, /runReviewViaChatSocket\(reviewer, prompt/,
    "flag ON must run the PR review as agent -- it is the same uid bug");
});

// FAIL CLOSED WHEN REDACTION ITSELF FAILS. (Kimi K3, HIGH, #321.)
// The catch used to fall through with the raw value, so the one moment
// redaction breaks was the moment unredacted engine output reached the board --
// and a clean verdict could still be parsed from it.
test("a redaction failure withholds the output and refuses the verdict", async () => {
  const r = await gate.runReviewViaChatSocket("codex", "judge this", 5000, {
    runViaChatSocket: chatProtocol("VERDICT: APPROVE\nsecret-bearing text here"),
    decodeLine: adapters.codexLineTransform,
    makeDecodeState: adapters.codexMakeState,
    redact: () => { throw new Error("redactor exploded"); },
  });
  assert.equal(r.ranClean, false,
    "if we cannot prove the output is safe to show, we cannot accept its verdict either");
  assert.ok(!r.text.includes("secret-bearing text here"),
    "the unredacted text must NOT be resolved when redaction failed");
  assert.match(r.text, /withheld/, "and must say the output was withheld, not fail silently");
});

// LANE REGISTRATION. (Kimi K3, HIGH, #321.) runAutonomousTask sets
// activeAgentChild so a lane quarantine can SIGKILL the running engine. Without
// it a quarantine cannot reach the review child, and a verdict can be accepted
// from a review the lane already disowned.
test("the review child is registered so a lane quarantine can kill it", () => {
  const LF = String.fromCharCode(10);
  const src = fs.readFileSync(path.join(process.cwd(), "container", "gate.js"), "utf8")
    .split(String.fromCharCode(13) + LF).join(LF);
  const fn = src.slice(src.indexOf("function runReviewViaChatSocket"));
  const body = fn.slice(0, fn.indexOf("function runAutonomousTask"));
  assert.match(body, /activeAgentChild = child/,
    "the review child must be registered with the agent lane, as runAutonomousTask's is");
});

// usage on EVERY path. (Kimi K3, LOW, #321.)
test("a failed review still reports a usage field", async () => {
  const r = await gate.runReviewViaChatSocket(
    "codex", "judge this", 5000, withCodexDecoder(null, { exitCode: 1 }));
  assert.equal(r.ranClean, false);
  assert.ok("usage" in r,
    "a review that burned tokens and then failed must not be invisible to the cost rail");
});
