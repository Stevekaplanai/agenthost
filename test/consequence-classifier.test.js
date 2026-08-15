// P0 Engine-based consequence classifier (Cardinal Rule 13, 2026-08-08).
// Tests verify the classifier fails closed, caches, uses a different engine,
// and that hard regex pre-filters gate before the engine is called.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

// Import the function from lib mode (require.main !== module path).
// We need to load gate.js in lib mode to get classifyCardConsequence.
import gateLib from "../container/gate.js";
import chainsLib from "../container/chains-lib.js";

test("classifyCardConsequence is exported", () => {
  assert.equal(typeof gateLib.classifyCardConsequence, "function");
});

test("classifyCardConsequence fails closed on timeout", async () => {
  // Mock runViaChatSocket that never emits exit — simulates a hang.
  function mockRun() {
    const fake = new EventEmitter();
    fake.stdout = new EventEmitter();
    fake.stderr = new EventEmitter();
    fake.kill = () => {};
    return fake;
  }
  // deps.timeoutMs makes the REAL timeout path testable in 50ms. Before it existed
  // this test could only check that "something came back" — its own comment said
  // "we can't override CLASSIFY_TIMEOUT_MS" — and deleting the entire timeout block
  // left it passing.
  //
  // It was also not measuring a timeout at all: CLASSIFY_TIMEOUT_MS is declared
  // ~5000 lines below gate.js's lib-mode early return, so in tests its assignment
  // never ran and it was `undefined`. setTimeout(fn, undefined) means
  // setTimeout(fn, 0), which is why this resolved in 2.7ms against a "10s" timeout.
  // The constant now lives above that return; with it fixed and no injection this
  // test genuinely waits the full ten seconds.
  const result = await gateLib.classifyCardConsequence(
    { title: "timeout-case-unique", body: "a child that never emits exit" },
    "claude",
    { runViaChatSocket: mockRun, audit: () => {}, roster: ["claude", "codex"], timeoutMs: 50 }
  );
  assert.equal(result.gate, true, "a timed-out classification must fail CLOSED");
  // Was an exact match on "classifier timed out". The timeout now routes through
  // settleFromDecoded and carries the duration -- "classifier timed out after
  // 50ms" -- so the park note a human reads says how long it waited, matching what
  // the audit already said. Loosened to a match rather than deleted: the assertion
  // that matters is that the reason NAMES the timeout, not its exact punctuation.
  assert.match(result.reason, /timed out/, "and must say that is why");
});

test("classifyCardConsequence fails closed on spawn error", async () => {
  // Mock runViaChatSocket that throws synchronously.
  function mockRun() { throw new Error("spawn failed"); }
  const result = await gateLib.classifyCardConsequence(
    { title: "spawn-error-case-unique", body: "runViaChatSocket throws synchronously" },
    "claude",
    { runViaChatSocket: mockRun, audit: () => {}, roster: ["claude", "codex"] }
  );
  assert.equal(result.gate, true, "spawn error should fail closed (GATE)");
  assert.ok(result.reason.includes("spawn failed") || result.reason.includes("classifier"), "reason should mention the failure");
});

test("classifyCardConsequence caches verdicts", async () => {
  let callCount = 0;
  function mockRun(label, prompt) {
    callCount++;
    const fake = new EventEmitter();
    fake.stdout = new EventEmitter();
    fake.stderr = new EventEmitter();
    fake.kill = () => {};
    // Emit a PASS response.
    process.nextTick(() => {
      fake.stdout.emit("data", "PASS — innocuous task\n");
      fake.emit("exit", 0);
    });
    return fake;
  }
  const task = { title: "cache test", body: "should only call once" };
  const deps = { runViaChatSocket: mockRun, audit: () => {}, roster: ["claude", "codex"] };
  
  const r1 = await gateLib.classifyCardConsequence(task, "claude", deps);
  const r2 = await gateLib.classifyCardConsequence(task, "claude", deps);
  
  assert.equal(callCount, 1, "runViaChatSocket should only be called once (cached on second call)");
  assert.deepEqual(r1, r2, "cached result should be identical");
  assert.equal(r1.gate, false, "first call should PASS");
});

test("classifyCardConsequence does not use the executing engine as classifier", async () => {
  let usedEngine = null;
  function mockRun(label, prompt) {
    usedEngine = label;
    const fake = new EventEmitter();
    fake.stdout = new EventEmitter();
    fake.stderr = new EventEmitter();
    fake.kill = () => {};
    process.nextTick(() => {
      fake.stdout.emit("data", "PASS — safe\n");
      fake.emit("exit", 0);
    });
    return fake;
  }
  await gateLib.classifyCardConsequence(
    { title: "test", body: "test" },
    "claude",
    { runViaChatSocket: mockRun, audit: () => {}, roster: ["claude", "codex", "gemini"] }
  );
  assert.notEqual(usedEngine, "claude", "classifier must not use the executing engine (claude)");
  assert.ok(usedEngine, "classifier should have used some engine");
});

test("classifyCardConsequence parses GATE response correctly", async () => {
  function mockRun(label, prompt) {
    const fake = new EventEmitter();
    fake.stdout = new EventEmitter();
    fake.stderr = new EventEmitter();
    fake.kill = () => {};
    process.nextTick(() => {
      fake.stdout.emit("data", "GATE — sends an email to a customer\n");
      fake.emit("exit", 0);
    });
    return fake;
  }
  const result = await gateLib.classifyCardConsequence(
    { title: "Email the customer", body: "Send a refund" },
    "claude",
    { runViaChatSocket: mockRun, audit: () => {}, roster: ["claude", "codex"] }
  );
  assert.equal(result.gate, true, "GATE response should produce gate=true");
  assert.ok(result.reason.length > 0, "GATE response should have a reason");
});

test("classifyCardConsequence fails closed when no other engine available", async () => {
  const result = await gateLib.classifyCardConsequence(
    { title: "single-engine-test-unique", body: "unique body for single engine test" },
    "claude",
    { runViaChatSocket: () => {}, audit: () => {}, roster: ["claude"] }
  );
  assert.equal(result.gate, true, "single-engine roster should fail closed");
  assert.ok(result.reason.includes("no other engine"), "reason should mention no other engine available");
});

test("hard regex pre-filters still gate before the engine is called", () => {
  // Verify via chains.humanGateReason that hard-gated keywords still fire.
  // The classifier only runs when humanGateReason returns null (no hard gate).
  // This test confirms the regex pre-filters are still in place.
  const gate = chainsLib.humanGateReason({ title: "Review the changes", body: "then deploy to production" });
  assert.equal(gate, "consequence", "deploy in body should still gate via HARD_GATED_RE");
  // A card with a secret name should gate.
  const secretGate = chainsLib.humanGateReason({ title: "Review config", body: "uses API_KEY in the env" });
  assert.ok(secretGate === "consequence", "API_KEY in body should gate via SECRET_NAME_RE");
});

test("classifyCardConsequence fails closed on unparseable response", async () => {
  function mockRun(label, prompt) {
    const fake = new EventEmitter();
    fake.stdout = new EventEmitter();
    fake.stderr = new EventEmitter();
    fake.kill = () => {};
    process.nextTick(() => {
      fake.stdout.emit("data", "I think this task is fine\n");
      fake.emit("exit", 0);
    });
    return fake;
  }
  const result = await gateLib.classifyCardConsequence(
    { title: "unparseable-test-unique", body: "unique body for unparseable test" },
    "claude",
    { runViaChatSocket: mockRun, audit: () => {}, roster: ["claude", "codex"] }
  );
  assert.equal(result.gate, true, "unparseable response should fail closed (GATE)");
  assert.ok(result.reason.includes("unparseable"), "reason should mention unparseable response");
});
import fsMod from "node:fs";
import pathMod from "node:path";
test("the classifier prompt carries Steve's rulings, not just the three questions", () => {
  // A live card proved the three questions alone are not enough. On 2026-08-09
  // the first real unit of autonomous work this box produced -- "Apply the
  // failed-test-name diff ... and open a PR" -- came back GATED with the reason
  // "opening a PR reaches beyond Steve (it affects an external review
  // target/repository)". That is a defensible reading of question 1 from first
  // principles, and the exact opposite of the operator's written ruling.
  //
  // The prompt is built inside classifyCardConsequence with no seam to read it,
  // so this asserts on the source text -- the same honest-but-weak shape as
  // test/review-reject-never-approves.js, and for the same reason: the
  // alternative was no test at all on the thing that decides what stops.
  const fs = fsMod; const path = pathMod;
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const src = fs.readFileSync(path.join(here, "..", "container", "gate.js"), "utf8");
  const start = src.indexOf("You are a consequence gate.");
  assert.ok(start > 0, "the classifier prompt must still exist");
  const prompt = src.slice(start, start + 8000);

  assert.match(prompt, /Opening a PR, committing, or pushing a branch is NOT a consequence/,
    "the ruling that unblocked the board must be in the prompt the model actually reads");
  // Deploys and spend are deliberately ABSENT (Kimi K3, MEDIUM x2 on #328).
  // Rule 13 does rule both are safe in the right circumstances, but the
  // classifier cannot verify WHICH box or WHOSE budget from card text, so those
  // rulings would let an ambiguous customer deploy or a real-money spend PASS on
  // an unchecked assumption. Absence here is the safety property; assert it.
  assert.doesNotMatch(prompt, /Deploying Steve's OWN box is NOT a consequence/,
    "deploy target cannot be verified from card text -- deploys must keep gating");
  assert.doesNotMatch(prompt, /Spending inside a budget he already set is NOT/,
    "budget membership cannot be verified from card text -- spend must keep gating");
  assert.match(prompt, /Emailing or messaging an external human IS, always/,
    "the relaxations must ship alongside the things that still hard-stop");

  // The conservative default must survive. Relaxing named cases must not become
  // a general permission to pass anything unlisted.
  assert.match(prompt, /When in doubt on anything NOT listed above, GATE/,
    "the when-in-doubt default must remain, scoped to the unlisted cases");
});
