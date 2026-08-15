// Cross-runner invariants (slice 6 QA).
//
// Every engine defect found this session was THE SAME SHAPE repeated in a new
// runner, each caught only by a hand review of that one runner:
//   - Kimi's cancel path skipped the transcript marker, so a cancelled turn left
//     Steve's question orphaned and looking open forever.
//   - Gemini's team streamer emitted UNLABELED sse frames, so real replies
//     rendered — and were saved — as "(no reply)".
//   - Cursor spawned unauthenticated, burning the box's single agent slot.
//
// Reviewing each new runner by hand does not scale and already missed twice.
// These tests assert the SHAPE every chat runner must have, so the next engine
// added to the box fails here instead of failing on Steve's phone.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const gate = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");

// Body of a top-level function declaration, up to the next top-level one.
function fnBody(name) {
  const start = gate.indexOf("function " + name + "(");
  assert.notStrictEqual(start, -1, "runner not found: " + name);
  const rest = gate.slice(start + 1);
  const next = rest.search(/\n(?:function |const [A-Z_]+ =|\/\/ ---- )/);
  return next === -1 ? rest : rest.slice(0, next);
}

// The 1:1 chat runners that own a durable response + the agent slot.
const DIRECT_RUNNERS = ["runChat", "runKimiChat", "runGeminiChat"];

for (const name of DIRECT_RUNNERS) {
  test(`invariant: ${name} releases the agent slot on failure paths`, () => {
    const body = fnBody(name);
    // The box has ONE agent slot; a path that fails without releasing wedges
    // ALL chat until the box restarts.
    assert.ok((body.match(/releaseAgent\(/g) || []).length >= 2,
      "must release the slot on more than just the happy path");
  });

  test(`invariant: ${name} bounds the run with a timeout`, () => {
    const body = fnBody(name);
    assert.match(body, /CHAT_RUN_TIMEOUT_MS/,
      "an unbounded run holds the single agent slot forever");
  });

  test(`invariant: ${name} handles client cancellation`, () => {
    const body = fnBody(name);
    assert.match(body, /res\.on\("close"/, "must react to the client going away");
  });
}

// The two API runners additionally own their transcript markers directly
// (runChat's live in its shared noteNoReply helper).
for (const name of ["runKimiChat", "runGeminiChat"]) {
  test(`invariant: ${name} records a transcript outcome on EVERY terminal path`, () => {
    const body = fnBody(name);
    assert.match(body, /noteReply\(/, "a successful reply is recorded");
    // cancel, timeout, and the request/stream failure paths must each mark it
    for (const reason of ["cancelled", "timed out"]) {
      assert.ok(body.includes('noteNoReply("' + reason + '")'),
        "terminal path must record its outcome: " + reason);
    }
    // and the cancel marker must precede the confirmation, or the durable run
    // terminalises first and the marker lands on a closed run
    const noteAt = body.indexOf('noteNoReply("cancelled")');
    const confirmAt = body.indexOf("confirmChatCancellation(res)");
    assert.ok(noteAt !== -1 && confirmAt !== -1 && noteAt < confirmAt,
      "the cancel marker must be written BEFORE cancellation is confirmed");
  });
}

test("invariant: runChat records an outcome on every terminal path too", () => {
  const body = fnBody("runChat");
  assert.match(body, /function noteNoReply\(reason\)/, "has the no-reply recorder");
  for (const reason of ["could not start", "timed out", "cancelled", "run error"]) {
    assert.ok(body.includes('noteNoReply("' + reason + '")'), "terminal path covered: " + reason);
  }
});

// Team streamers: the client routes team text into per-engine bubbles by EVENT
// NAME. An unlabeled frame silently lands in the single-engine accumulator and
// the bubble renders "(no reply)" — a perfect answer, invisible.
for (const name of ["streamKimiTeam", "streamGeminiTeam"]) {
  test(`invariant: ${name} streams via the NAMED engine_delta event`, () => {
    const body = fnBody(name);
    assert.match(body, /sse\(res, "engine_delta"/,
      "team text must be labeled or it never reaches the engine's bubble");
    assert.ok(!/sse\(res, null,/.test(body), "no unlabeled team frame");
  });

  test(`invariant: ${name} settles exactly once and validates the lease`, () => {
    const body = fnBody(name);
    assert.match(body, /stopLocally\(\)/, "a one-shot guard prevents double-settle");
    assert.match(body, /agentLeaseIsLive\(token\)/,
      "a stale streamer must not record results after a newer run owns the slot");
  });
}

test("invariant: every engine reachable in chat has a credential pre-flight or needs none", () => {
  // Cursor spawned unauthenticated and burned the slot before slice 5. Any
  // engine whose credential can be absent must fail closed BEFORE acquiring.
  const dispatch = gate.slice(gate.indexOf("function startChatRun"), gate.indexOf("// ---- Box: the operator lane"));
  assert.ok(dispatch.includes('eng.label === "cursor" && !cursorChatEnv().CURSOR_API_KEY'),
    "cursor pre-flights its key");
  const preAt = dispatch.indexOf("cursorChatEnv().CURSOR_API_KEY");
  const runAt = dispatch.indexOf("runChat(msg, true, res, true, acquireAgent");
  assert.ok(preAt < runAt, "and it refuses before the agent slot is taken");
  // Kimi and Gemini pre-flight inside their own runners (they own the key read)
  assert.match(fnBody("runKimiChat"), /Kimi API key not configured/);
  assert.match(fnBody("runGeminiChat"), /Gemini API key not configured/);
});

test("invariant: the Box operator lane never takes the agent slot", () => {
  // Its whole purpose is answering WHILE an engine is busy. If it ever
  // acquired, asking "what's running?" would queue behind the thing you're
  // asking about.
  const body = fnBody("runBoxChat");
  assert.ok(!/acquireAgent\(/.test(body), "the box lane must not acquire");
  assert.ok(!/releaseAgent\(/.test(body), "and therefore must not release");
  assert.match(gate, /if \(agentBusy && engineId !== "box"\)/, "and it bypasses the busy queue");
});

// ---- slice 7: hybrid fan-out (API concurrent first, CLI sequential after) ---

test("fanout: API engines run concurrently and are excluded from the sequential loop", () => {
  const body = fnBody("runTeamSequential");
  assert.match(body, /const apiOrder = rosterOrder\.filter\(isApiEngine\)/,
    "API engines are split out");
  assert.match(body, /const order = rosterOrder\.filter\(\(id\) => !isApiEngine\(id\)\)/,
    "the sequential loop owns ONLY process-spawning engines — the memory rule");
  assert.match(body, /function runApiPhase\(done\)/, "there is a concurrent phase");
});

test("fanout: the CLI phase starts only after every API engine has settled", () => {
  const body = fnBody("runTeamSequential");
  // Otherwise `replies` would be incomplete and the sequential engines' prompts
  // would miss the API answers — losing the waterfall this ordering preserves.
  assert.match(body, /if \(--outstanding === 0\) \{\s*for \(const id of apiOrder\) appendOutcomeToContext\(id\);\s*done\(\);\s*\}/,
    "counts down every API engine, builds ordered waterfall context, then starts the CLI phase");
  assert.match(body, /runApiPhase\(\(\) => \{ if \(!clientGone && agentLeaseIsLive\(token\)\) next\(\); \}\)/,
    "next() (the CLI loop) is the phase-1 completion callback, gated on a live lane");
});

test("fanout: each API engine records exactly once, even if its streamer fires twice", () => {
  const body = fnBody("runTeamSequential");
  assert.match(body, /const settledApi = new Set\(\)/, "one-shot guard per engine");
  assert.match(body, /if \(settledApi\.has\(engId\)\) return;/, "a repeat settle is dropped");
  assert.match(body, /renewAgentLease\(token\)/, "a stale phase cannot record after a newer run owns the slot");
});

test("fanout: API replies reach the transcript and the per-engine bubble", () => {
  const body = fnBody("runTeamSequential");
  assert.match(body, /id: res && res\.runId \? res\.runId \+ "-r-" \+ engId : null/,
    "every durable outcome uses the same idempotent per-engine transcript id");
  assert.match(body, /sse\(res, "engine_done", \{ eng: engId/, "the bubble is closed out");
});

test("fanout: API completion timing cannot reorder durable or downstream replies", () => {
  const body = fnBody("runTeamSequential");
  assert.match(body, /const teamOutcomes = new Map\(\)/,
    "parallel and sequential outcomes share one roster-keyed buffer");
  const durableAt = body.indexOf("const flushDurableOutcomes =");
  const prefixAt = body.indexOf("const flushDurablePrefix =");
  const flush = body.slice(durableAt, prefixAt);
  assert.match(flush, /for \(const engId of rosterOrder\)/,
    "final and partial durable flushes iterate permanent TEAM_ORDER");
  assert.match(flush, /appendTeamThread\(engId, outcome\.reply/,
    "the roster-ordered flush writes the durable transcript");
  const prefix = body.slice(prefixAt, body.indexOf("if (!setAgentQuarantineHandler", prefixAt));
  assert.match(prefix, /if \(!outcome\) break;/,
    "crash-durable writes stop at the first missing roster slot rather than reordering");
  const finishAt = body.indexOf("const finishOne =");
  const launchAt = body.indexOf("for (const engId of apiOrder)", finishAt);
  const finish = body.slice(finishAt, launchAt);
  assert.doesNotMatch(finish, /replies\.push\(|appendTeamThread\(|flushDurableOutcomes\(\)(?!;\s*if \(renewAgentLease)/,
    "an individual API completion cannot publish ahead of an earlier roster slot");
});

test("fanout: CANCEL during phase 1 releases the lane and confirms — no box-wide wedge", () => {
  // The bug this pins: finishOne originally skipped its whole body when
  // clientGone, so a Cancel tap mid-fan-out never released the SHARED agent
  // lane and never terminalized the durable run. agentBusy stayed true for the
  // entire box (chat, cron, wake, autonomy) until the 16-minute hard watchdog
  // quarantined the lane — which requires a box restart to clear.
  const body = fnBody("runTeamSequential");
  const finishAt = body.indexOf("const finishOne =");
  const fin = body.slice(finishAt, body.indexOf("for (const engId of apiOrder)", finishAt));
  assert.match(fin, /if \(clientGone\) \{/, "cancellation is handled explicitly");
  assert.match(fin, /flushDurableOutcomes\(\)/,
    "answers completed before Stop are durably preserved in roster order");
  assert.match(fin, /if \(renewAgentLease\(token\)\) releaseAgent\(token\);/,
    "the shared lane is released on cancel");
  assert.match(fin, /finishChatCancellation\(res, cancellationFailure\)/,
    "the durable run terminalizes and preserves a protected-accounting failure cause");
  // released/confirmed once, when the LAST aborted stream reports in
  const cancelAt = fin.indexOf("if (clientGone) {");
  const guardAt = fin.indexOf("if (--outstanding === 0)", cancelAt);
  assert.ok(guardAt !== -1 && guardAt < fin.indexOf("finishChatCancellation"),
    "guarded so it fires exactly once, not per engine");
});

test("fanout: quarantine aborts in-flight streams and blocks the CLI phase", () => {
  const body = fnBody("runTeamSequential");
  assert.match(body, /setAgentQuarantineHandler\(token, \(reason\) => \{/,
    "phase 1 registers a quarantine handler like the sequential path does");
  assert.match(body, /quarantineTeamStreams\(liveStreams, reason\)/,
    "the reviewed helper aborts every in-flight API stream on quarantine");
  assert.match(body, /const terminalCause = quarantineTeamStreams\(liveStreams, reason\);[\s\S]*flushDurableOutcomes\(\)[\s\S]*failChatForQuarantine\(res, terminalCause\)/,
    "completed outcomes are persisted before the quarantined run terminates");
  assert.match(body, /runApiPhase\(\(\) => \{ if \(!clientGone && agentLeaseIsLive\(token\)\) next\(\); \}\)/,
    "a lost/quarantined lane must NOT be followed by spawning a CLI process");
});

test("fanout: Stop aborts and synchronously settles API streams without treating detach as cancel", () => {
  const body = fnBody("runTeamSequential");
  const cancelAt = body.indexOf('res.on("cancel"');
  assert.ok(cancelAt !== -1, "the durable Stop event has an explicit handler");
  const cancel = body.slice(cancelAt, cancelAt + 400);
  assert.match(cancel, /flushDurableOutcomes\(\)/, "Stop preserves completed answers first");
  assert.match(cancel, /s\.kill\(\)/, "Stop kills every unfinished API request");
  const gemini = fnBody("streamGeminiTeam");
  const killAt = gemini.indexOf("kill: () =>");
  const kill = gemini.slice(killAt, killAt + 500);
  assert.match(kill, /controller\.abort\(\)/, "Gemini Stop aborts its HTTP signal");
  assert.match(kill, /done\("Gemini cancelled"\)/,
    "Gemini Stop settles synchronously even if fetch ignores abort");
});
