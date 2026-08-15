// The classifier must decode the transport it actually runs on.
//
// P0-CLASSIFIER-CANNOT-PARSE-TRANSPORT: classifyCardConsequence runs the engine
// through runViaChatSocket, whose stdout is the chat protocol's JSON event
// stream. It parsed that as plain text and required the FIRST non-empty line to
// be the verdict. The first line is always {"type":"thread.started",...}, so the
// verdict regex could never match: every classification failed, every card gated,
// every card parked. Autonomous dispatch was non-functional from the moment #279
// deployed, and it was found by running a card on the live board.
//
// Nine tests passed throughout. They executed the real function with injected
// deps -- the good kind -- but their mock wrote plain "GATE|PASS" text to the
// fake stdout. A mock that cannot fail the way production fails is a fixture,
// not a test. So these emit the REAL event stream, using the REAL decoder from
// engine-adapters, and the pre-fix code fails every one of them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import gate from "../container/gate.js";
import adapters from "../container/engine-adapters.js";

// The transport, as the chat protocol actually emits it: a thread.started event,
// then the answer inside a text_delta, then a terminal event.
function chatProtocolStdout(answer) {
  return function mockRun() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    process.nextTick(() => {
      child.stdout.emit("data", JSON.stringify({ type: "thread.started", thread_id: "019fe57d-test" }) + "\n");
      child.stdout.emit("data", JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: answer } },
      }) + "\n");
      child.stdout.emit("data", JSON.stringify({ type: "result", usage: {} }) + "\n");
      child.emit("exit", 0);
    });
    return child;
  };
}

// resolveEngine sits below gate.js's lib-mode early return, so its lookup table
// is undefined under require() and calling it throws. deps.decodeLine exists so a
// test can supply the real decoder; without it the decode path is untestable,
// which is the gap that let this ship.
const withRealDecoder = (answer) => ({
  runViaChatSocket: chatProtocolStdout(answer),
  audit: () => {},
  roster: ["claude", "codex"],
  decodeLine: adapters.claudeLineTransform,
  makeDecodeState: adapters.claudeMakeState,
});

test("a PASS verdict survives the JSON event stream", async () => {
  const r = await gate.classifyCardConsequence(
    { title: "Reticulate the splines", body: "name the current UTC date" },
    "codex", withRealDecoder("PASS - internal only, reversible, no judgement call"));
  assert.equal(r.gate, false, "this is the exact card shape that parked in production");
  assert.equal(r.reason, "internal only, reversible, no judgement call");
});

test("a GATE verdict survives the JSON event stream", async () => {
  const r = await gate.classifyCardConsequence(
    { title: "Notify the customer list", body: "send the announcement" },
    "codex", withRealDecoder("GATE - reaches third parties"));
  assert.equal(r.gate, true);
  assert.equal(r.reason, "reaches third parties");
});

test("the LAST verdict wins, so reasoning cannot outrank the answer", async () => {
  // A model that thinks out loud may mention GATE before settling on PASS.
  // Taking the first match would invert the verdict.
  const r = await gate.classifyCardConsequence(
    { title: "Think it through", body: "x" },
    "codex", withRealDecoder("I weighed whether this should GATE on question 2.\nPASS - fully reversible"));
  assert.equal(r.gate, false, "the final line is the verdict, not the first mention");
  assert.equal(r.reason, "fully reversible");
});

test("undecodable output still fails CLOSED with a named cause", async () => {
  // The property that made this a stall rather than an unreviewed auto-run.
  const r = await gate.classifyCardConsequence(
    { title: "Garbled", body: "y" },
    "codex", withRealDecoder("the model rambled and never gave a verdict"));
  assert.equal(r.gate, true, "no verdict must gate, never pass");
  assert.match(r.reason, /unparseable|nothing to stdout/, "and must say why");
});

test("a stream carrying ONLY protocol events, no answer, fails closed", async () => {
  const onlyEvents = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    process.nextTick(() => {
      child.stdout.emit("data", JSON.stringify({ type: "thread.started", thread_id: "x" }) + "\n");
      child.emit("exit", 0);
    });
    return child;
  };
  const r = await gate.classifyCardConsequence({ title: "Silent", body: "z" }, "codex", {
    runViaChatSocket: onlyEvents, audit: () => {}, roster: ["claude", "codex"],
    decodeLine: adapters.claudeLineTransform, makeDecodeState: adapters.claudeMakeState,
  });
  assert.equal(r.gate, true);
  // Pre-fix, this same input produced reason:
  //   'unparseable response: {"type":"thread.started",...}'
  // i.e. the protocol envelope leaking into an operator-facing message. Now the
  // envelope is decoded away and what remains is honestly empty.
  assert.doesNotMatch(r.reason, /thread\.started/, "protocol envelope must not leak into the reason a human reads");
});

test("a verdict settles the run even when the child NEVER exits", async () => {
  // Measured on the box: runViaChatSocket streams {"type":"item.completed"} with
  // the answer within seconds and then never exits -- no exit after 45s. Parsing
  // only in the exit handler meant the correct verdict sat in the decode buffer
  // while the run burned its full timeout and gated the card as a timeout. Three
  // live cards did exactly that. (P0-CLASSIFIER-WAITS-FOR-EXIT.)
  const neverExits = (answer) => () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    process.nextTick(() => {
      child.stdout.emit("data", JSON.stringify({ type: "thread.started", thread_id: "t" }) + "\n");
      child.stdout.emit("data", JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: answer } },
      }) + "\n");
      // deliberately no exit
    });
    return child;
  };
  const deps = (answer) => ({
    runViaChatSocket: neverExits(answer), audit: () => {}, roster: ["claude", "codex"],
    decodeLine: adapters.claudeLineTransform, makeDecodeState: adapters.claudeMakeState,
    timeoutMs: 4000,
  });
  const started = Date.now();
  const pass = await gate.classifyCardConsequence({ title: "never-exits-pass", body: "x" }, "codex", deps("PASS - internal only"));
  assert.equal(pass.gate, false);
  assert.equal(pass.reason, "internal only");
  const gated = await gate.classifyCardConsequence({ title: "never-exits-gate", body: "y" }, "codex", deps("GATE - reaches customers"));
  assert.equal(gated.gate, true);
  assert.equal(gated.reason, "reaches customers");
  // The timing IS the assertion. Against the pre-fix code both of these return
  // {"gate":true,"reason":"classifier timed out"} after the full timeout.
  assert.ok(Date.now() - started < 4000,
    "both verdicts must settle well inside the 4s timeout; waiting it out is the bug");
});

test("a reasoning line that STARTS with a verdict word must not settle the run", async () => {
  // Kimi HIGH on #298. The early settle originally fired on the FIRST verdict-shaped
  // line, which undid the last-line-wins rule: a model reasoning "PASS would be
  // wrong here..." on its own line, then answering GATE, was settled and SIGKILLed
  // on the reasoning. The debounce exists for exactly this, and this test is the
  // only thing standing between it and someone "simplifying" it back.
  const reasoningThenVerdict = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    const ev = (t) => JSON.stringify({
      type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: t } },
    }) + "\n";
    process.nextTick(() => {
      child.stdout.emit("data", JSON.stringify({ type: "thread.started" }) + "\n");
      child.stdout.emit("data", ev("PASS would be wrong here because it touches the public site.\n"));
    });
    setTimeout(() => child.stdout.emit("data", ev("GATE - reaches the public homepage\n")), 250);
    return child; // never exits
  };
  const r = await gate.classifyCardConsequence({ title: "reasoning-first", body: "x" }, "codex", {
    runViaChatSocket: reasoningThenVerdict, audit: () => {}, roster: ["claude", "codex"],
    decodeLine: adapters.claudeLineTransform, makeDecodeState: adapters.claudeMakeState,
    timeoutMs: 8000,
  });
  assert.equal(r.gate, true, "the REAL verdict is GATE; settling on the reasoning line would invert it");
  assert.equal(r.reason, "reaches the public homepage");
});

test("a timeout does not discard a verdict that was already decoded", async () => {
  // Kimi MEDIUM on #298. The timeout had its own parse-free path, so if a verdict
  // arrived but its debounce had not yet elapsed, the timeout threw it away and
  // reported a timeout -- the original bug in miniature, inside the fix for it.
  // Timeout here (200ms) deliberately beats the debounce (750ms).
  const verdictThenSilence = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    process.nextTick(() => {
      child.stdout.emit("data", JSON.stringify({ type: "thread.started" }) + "\n");
      child.stdout.emit("data", JSON.stringify({
        type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "PASS - internal only\n" } },
      }) + "\n");
    });
    return child; // never exits, nothing further
  };
  const r = await gate.classifyCardConsequence({ title: "race-verdict-vs-timeout", body: "x" }, "codex", {
    runViaChatSocket: verdictThenSilence, audit: () => {}, roster: ["claude", "codex"],
    decodeLine: adapters.claudeLineTransform, makeDecodeState: adapters.claudeMakeState,
    timeoutMs: 200,
  });
  assert.equal(r.gate, false, "the verdict was decoded before the timeout; it must be used");
  assert.equal(r.reason, "internal only");
});

test("a classifier that says nothing at all still times out and fails CLOSED", async () => {
  // The other side of routing the timeout through settleFromDecoded: with no
  // verdict to find, it must still gate AND still name the timeout as the cause.
  const silent = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    return child;
  };
  const r = await gate.classifyCardConsequence({ title: "wholly-silent", body: "y" }, "codex", {
    runViaChatSocket: silent, audit: () => {}, roster: ["claude", "codex"],
    decodeLine: adapters.claudeLineTransform, makeDecodeState: adapters.claudeMakeState,
    timeoutMs: 300,
  });
  assert.equal(r.gate, true);
  assert.match(r.reason, /timed out/, "a timeout must still name itself, not borrow the no-output message");
});

test("a timeout names WHAT IT SAW, so three different bugs are distinguishable", async () => {
  // "classifier timed out after 10000ms" cost three deploys on 2026-08-09: it
  // cannot tell "the engine said nothing" from "it said something undecodable"
  // from "it said the right thing into a decoder that dropped it". Each of those
  // is a different bug with a different fix, and the audit line was identical for
  // all three. (P0-CLASSIFIER-STILL-TIMES-OUT.)
  const mk = (emit) => () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    process.nextTick(() => emit(child));
    return child;
  };
  const deps = (run) => ({
    runViaChatSocket: run, audit: () => {}, roster: ["claude", "codex"],
    decodeLine: adapters.claudeLineTransform, makeDecodeState: adapters.claudeMakeState,
    timeoutMs: 300,
  });

  const silent = await gate.classifyCardConsequence({ title: "silent", body: "1" }, "claude", deps(mk(() => {})));
  assert.match(silent.reason, /raw=0B/, "nothing arrived at all");
  assert.match(silent.reason, /first-byte=never/, "which points at the transport or the chat slot, not the decoder");

  const garbage = await gate.classifyCardConsequence({ title: "undecodable", body: "2" }, "claude",
    deps(mk((c) => c.stdout.emit("data", "not json at all\n"))));
  assert.match(garbage.reason, /raw=1[0-9]B/, "bytes DID arrive");
  assert.match(garbage.reason, /decoded=0B/, "and none survived decoding — that is a decoder bug, a different one entirely");

  const stderrOnly = await gate.classifyCardConsequence({ title: "stderr-only", body: "3" }, "claude",
    deps(mk((c) => c.stderr.emit("data", "codex: usage limit reached\n"))));
  assert.match(stderrOnly.reason, /usage limit reached/, "when the engine says why, the timeout must carry it");
  // A NUMBER, not literally 0ms. The discriminator is "never" versus "a time";
  // pinning the exact millisecond made this fail at 1ms, which asserts scheduler
  // luck rather than behaviour.
  assert.match(stderrOnly.reason, /first-byte=\d+ms/,
    "stderr counts as a first byte: an engine that failed INSTANTLY must not be reported as never started");
  assert.match(silent.reason, /first-byte=never/,
    "and only a genuinely silent call reports never — that contrast IS the queueing discriminator");

  // Every one of these must still FAIL CLOSED. The instrumentation changed what the
  // reason SAYS; it must not have changed what the gate DOES. (Kimi K3, #300.)
  for (const r of [silent, garbage, stderrOnly]) assert.equal(r.gate, true, "a timeout must gate, never pass: " + r.reason);

  // The engine is named in all three: which engine timed out is not deducible
  // from the card, because the classifier is deliberately never the assignee.
  for (const r of [silent, garbage, stderrOnly]) assert.match(r.reason, /engine=codex/);
});

test("a decoder that throws must name itself, and hand back what the engine said", async () => {
  // The failure this closes: for five deploys the classifier reported
  //   "classifier timed out after 10000ms [engine=codex raw=379B decoded=0B ...]"
  // and every one of those rounds was a guess, because the code MEASURED the
  // payload and then dropped it -- `catch { /* undecodable line, skip it */ }`.
  // Codex was healthy the whole time (proven on the box: 4s, full JSONL, through
  // the real containment wrapper). The bytes that would have said so were being
  // thrown on the floor, which is Rule 16's founding defect exactly.
  const throwingDecode = () => { throw new Error("decoder exploded"); };
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  const r = await gate.classifyCardConsequence({ title: "Undecodable", body: "b" }, "codex", {
    runViaChatSocket: () => {
      process.nextTick(() => {
        child.stdout.emit("data", "GATE - the engine answered perfectly well\n");
        // never exits -- the live shape
      });
      return child;
    },
    audit: () => {}, roster: ["claude", "codex"],
    decodeLine: throwingDecode, makeDecodeState: adapters.claudeMakeState,
    timeoutMs: 300,
  });
  assert.equal(r.gate, true, "a decoder that throws must still fail CLOSED");
  assert.match(r.reason, /decode-error/, "the swallowed error must reach the operator");
  assert.match(r.reason, /decoder exploded/, "and must carry the decoder's own words, not a generic label");
  assert.match(r.reason, /raw-tail/, "the payload must survive when nothing decoded");
  assert.match(r.reason, /the engine answered perfectly well/,
    "the raw tail must show what the engine ACTUALLY said -- the one fact five deploys never had");
});

// The other half of the same defect, and the half that costs deploys. A child
// that dies mid-turn EXITS -- it does not time out -- so it settles through the
// exit path, which had none of the fields above. It reported "classifier wrote
// nothing to stdout and nothing to stderr" while the protocol preamble sat in
// rawTail: an instrument built to stop a failure from lying, lying on the path
// it was built for, and sending the reader to the transport when the answer was
// at the decoder. Reproduced with the real codex decoder before the fix.
//
// Note the split, which the test two above forces: the PARK NOTE a human reads
// gets the plain sentence and no protocol envelope, and the AUDIT LINE gets the
// payload. Two surfaces, two jobs.
test("a child that dies mid-turn says what it wrote, not that it wrote nothing", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  const audited = [];
  const r = await gate.classifyCardConsequence({ title: "Mid-turn death", body: "b" }, "claude", {
    runViaChatSocket: () => {
      process.nextTick(() => {
        // Real preamble, then death before any agent_message: decodes to nothing.
        child.stdout.emit("data", JSON.stringify({ type: "thread.started", thread_id: "t_1" }) + "\n");
        child.stdout.emit("data", JSON.stringify({ type: "turn.started", turn_id: "u_1" }) + "\n");
        child.emit("exit", 1);
      });
      return child;
    },
    audit: (kind, msg) => audited.push(String(kind) + " " + String(msg)),
    roster: ["claude", "codex"],
    decodeLine: adapters.codexLineTransform, makeDecodeState: adapters.codexMakeState,
  });
  assert.equal(r.gate, true, "a dead classifier must still fail CLOSED");

  assert.doesNotMatch(r.reason, /wrote nothing to stdout/,
    "it wrote plenty to stdout -- saying otherwise sends the reader to the wrong layer");
  assert.match(r.reason, /decoded to nothing/, "so name what actually happened");
  assert.doesNotMatch(r.reason, /thread\.started/,
    "and still no protocol envelope in the note, same contract as the test above");

  const line = audited.join("\n");
  assert.match(line, /raw=\d+B/, "the byte count that discriminates transport from decoder");
  assert.match(line, /decoded=0B/, "and the decoded count that says which side lost it");
  assert.match(line, /raw-tail/, "the payload must survive on this path too, not only on timeout");
  assert.match(line, /thread\.started/, "and must show what the engine actually sent");
});

