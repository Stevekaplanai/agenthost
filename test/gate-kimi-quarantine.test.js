import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { stopChild } from "./child-process-helper.js";
import { mintOperatorSession } from "./operator-session-helper.js";

// Imported rather than re-declared: a hand-copied terminal-status set in a test
// is guaranteed to drift from the product's own definition, and the drift shows
// up as a test that quietly stops checking the thing it names. (Kimi, LOW.)
const { TERMINAL_RUN_STATUSES } = createRequire(import.meta.url)("../container/run-ledger.js");

const SOURCE_CONTAINER = path.join(import.meta.dirname, "..", "container");
const KEY = "gate-kimi-quarantine-key";

function sseEvents(text) {
  return text.split("\n\n").map((block) => {
    let event = "message";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) data += line.slice(6);
    }
    return { event, data };
  }).filter((entry) => entry.data);
}

function traceRows(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse);
  } catch {
    return [];
  }
}

function latestLedgerRuns(home) {
  const file = path.join(home, ".claude", "agenthost", "runs", "runs.jsonl");
  const latest = new Map();
  for (const row of traceRows(file)) {
    if (row && row.run && row.run.id) latest.set(row.run.id, row.run);
  }
  return [...latest.values()];
}

async function waitFor(fn, message, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

function replaceExactly(source, needle, replacement, expected = 1) {
  assert.equal(source.split(needle).length - 1, expected, `fixture found ${expected} copy/copies of ${needle}`);
  return source.replaceAll(needle, replacement);
}

function patchGate(gateFile) {
  let source = fs.readFileSync(gateFile, "utf8");
  source = replaceExactly(
    source,
    "    origin: KIMI_API_ORIGIN,",
    "    fetchFn: require(process.env.KIMI_FETCH_FIXTURE), origin: KIMI_API_ORIGIN,",
    2,
  );
  source = replaceExactly(
    source,
    "const AGENT_HARD_MAX_MS = 16 * 60 * 1000;",
    "const AGENT_HARD_MAX_MS = Number(process.env.KIMI_TEST_HARD_MAX_MS) || 16 * 60 * 1000;",
  );
  source = replaceExactly(
    source,
    "}, 30 * 1000).unref();",
    "}, Number(process.env.KIMI_TEST_WATCHDOG_MS) || 30 * 1000).unref();",
  );
  source = replaceExactly(
    source,
    "function recordUsage(engine, usage, tzOffsetMin) {",
    'function recordUsage(engine, usage, tzOffsetMin) {\n  try { if (engine === "kimi" && process.env.KIMI_EFFECT_TRACE) fs.appendFileSync(process.env.KIMI_EFFECT_TRACE, JSON.stringify({ effect: "usage" }) + "\\n"); } catch {}',
  );
  source = replaceExactly(
    source,
    "function writeArtifacts(blocks, by) {",
    'function writeArtifacts(blocks, by) {\n  try { if (by === "kimi" && process.env.KIMI_EFFECT_TRACE) fs.appendFileSync(process.env.KIMI_EFFECT_TRACE, JSON.stringify({ effect: "artifact" }) + "\\n"); } catch {}',
  );
  source = replaceExactly(
    source,
    "function runBoardIntents(intents, by, allowedIds) {",
    'function runBoardIntents(intents, by, allowedIds) {\n  try { if (by === "kimi" && process.env.KIMI_EFFECT_TRACE) fs.appendFileSync(process.env.KIMI_EFFECT_TRACE, JSON.stringify({ effect: "board" }) + "\\n"); } catch {}',
  );
  fs.writeFileSync(gateFile, source);
}

function writeFetchFixture(file) {
  fs.writeFileSync(file, [
    '"use strict";',
    'const fs = require("node:fs");',
    'let request = 0;',
    'function log(row) { fs.appendFileSync(process.env.KIMI_FETCH_TRACE, JSON.stringify(row) + "\\n"); }',
    'module.exports = function (_url, options) {',
    '  const sequence = String(process.env.KIMI_FETCH_SEQUENCE || "success").split(",");',
    '  const behavior = sequence[Math.min(request++, sequence.length - 1)];',
    '  log({ event: "fetch", behavior });',
    '  if (options && options.signal) options.signal.addEventListener("abort", () => log({ event: "abort", behavior }), { once: true });',
    '  if (behavior === "hang") return new Promise(() => {});',
    '  const delay = Number(process.env.KIMI_FETCH_DELAY_MS) || 20;',
    '  return new Promise((resolve, reject) => setTimeout(() => {',
    '    if (behavior === "error") { reject(new Error("late fixture error")); return; }',
    '    const text = "LATE_KIMI_REPLY\\nBOARD: done t_kimi stale\\nARTIFACT: stale-kimi.md\\nstale\\nARTIFACT-END";',
    '    const frames = [',
    '      "data: " + JSON.stringify({ choices: [{ delta: { content: text } }] }) + "\\n\\n",',
    '      "data: " + JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 7, completion_tokens: 9 } }) + "\\n\\n",',
    '      "data: [DONE]\\n\\n",',
    '    ];',
    '    resolve({',
    '      ok: true, status: 200,',
    '      body: { async *[Symbol.asyncIterator]() { for (const frame of frames) yield Buffer.from(frame); } },',
    '    });',
    '  }, delay));',
    '};',
    "",
  ].join("\n"));
}

function createFixture(tag, {
  sequence,
  fetchDelayMs = 20,
  quarantine = false,
  hardMaxMs = null,
  bootQuarantined = false,
  scheduledWork = false,
  wake = false,
  schedulerTickMs = null,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `agenthost-kimi-${tag}-`));
  const home = path.join(root, "home");
  const container = path.join(root, "container");
  const fetchTrace = path.join(root, "fetch.jsonl");
  const effectTrace = path.join(root, "effects.jsonl");
  const childTrace = path.join(root, "children.jsonl");
  const fetchFixture = path.join(root, "kimi-fetch.cjs");
  const childWrapper = path.join(root, "child-wrapper.mjs");
  fs.mkdirSync(path.join(home, "work"), { recursive: true });
  fs.mkdirSync(path.join(home, ".agenthost"), { recursive: true });
  fs.writeFileSync(path.join(home, ".agenthost", "settings.json"), JSON.stringify({
    llm: { roster: {
      claude: { active: false, inChat: false },
      hermes: { active: false, inChat: false },
      codex: { active: false, inChat: false },
      gemini: { active: false, inChat: false },
      kimi: { active: true, inChat: true },
      cursor: { active: false, inChat: false },
    } },
    providers: { moonshot: { enabled: true, modelId: "kimi-k3" } },
    cost: { limitsEnabled: false },
    board: { autoDispatch: false },
  }));
  fs.writeFileSync(path.join(home, ".agenthost", "secrets.env"), "KIMI_API_KEY=test-only\n");
  if (scheduledWork) {
    const cronDir = path.join(home, ".claude", "agenthost", "cron");
    fs.mkdirSync(cronDir, { recursive: true });
    fs.writeFileSync(path.join(cronDir, "jobs.json"), JSON.stringify([{
      id: "cronjob00001",
      name: "must not stick",
      cron: "* * * * *",
      prompt: "summarize this harmless test fixture",
      tzOffsetMin: 0,
    }]));
    fs.writeFileSync(path.join(cronDir, "multi-jobs.json"), JSON.stringify([{
      id: "multijob0001",
      name: "must not stick",
      cron: "* * * * *",
      objective: "must never start",
      tzOffsetMin: 0,
      stages: [
        { engine: "claude", instruction: "first" },
        { engine: "codex", instruction: "second" },
      ],
    }]));
  }
  fs.writeFileSync(fetchTrace, "");
  fs.writeFileSync(effectTrace, "");
  fs.writeFileSync(childTrace, "");
  fs.writeFileSync(childWrapper, [
    'import fs from "node:fs";',
    'fs.appendFileSync(process.env.KIMI_CHILD_TRACE, JSON.stringify({ event: "child", argv: process.argv.slice(2) }) + "\\n");',
    "",
  ].join("\n"));
  writeFetchFixture(fetchFixture);
  fs.cpSync(SOURCE_CONTAINER, container, { recursive: true });
  fs.writeFileSync(path.join(container, "team-charter.md"), "# Kimi quarantine test\n");
  const gateFile = path.join(container, "gate.js");
  patchGate(gateFile);
  return {
    root,
    home,
    gateFile,
    fetchTrace,
    effectTrace,
    childTrace,
    fetchFixture,
    childWrapper,
    sequence: sequence || "success",
    fetchDelayMs,
    quarantine,
    hardMaxMs,
    bootQuarantined,
    wake,
    schedulerTickMs,
  };
}

async function boot(fixture) {
  const gate = spawn(process.execPath, [fixture.gateFile], {
    env: {
      ...process.env,
      AGENTHOST_FOUNDATION_B: "0",
      HOME: fixture.home,
      AGENTHOST_BOX_SECRETS_FILE: path.join(fixture.home, ".agenthost", "secrets.env"),
      TTYD_PASSWORD: KEY,
      WAKE_CHECKIN: fixture.wake ? "on" : "off",
      WAKE_CHECKIN_DELAY_MS: fixture.wake ? "20" : "",
      GATE_PORT: "0",
      CHANNEL_DISPATCH_PORT: "0",
      KIMI_FETCH_FIXTURE: fixture.fetchFixture,
      KIMI_FETCH_TRACE: fixture.fetchTrace,
      KIMI_EFFECT_TRACE: fixture.effectTrace,
      KIMI_FETCH_SEQUENCE: fixture.sequence,
      KIMI_FETCH_DELAY_MS: String(fixture.fetchDelayMs),
      KIMI_TEST_HARD_MAX_MS: fixture.hardMaxMs != null
        ? String(fixture.hardMaxMs)
        : fixture.quarantine ? "60" : "",
      KIMI_TEST_WATCHDOG_MS: fixture.quarantine ? "10" : "",
      AGENTHOST_SCHEDULER_TICK_MS: fixture.schedulerTickMs != null ? String(fixture.schedulerTickMs) : "",
      AGENTHOST_AGENT_LANE_QUARANTINED: fixture.bootQuarantined ? "1" : "",
      AGENT_CHAT_BIN: "fake-claude",
      AGENTHOST_DEV_WRAP: fixture.childWrapper,
      KIMI_CHILD_TRACE: fixture.childTrace,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  gate.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  gate.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const port = await waitFor(() => {
    const match = stdout.match(/listening on (\d+)/);
    return match && Number(match[1]);
  }, () => `gate did not bind\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  const base = `http://127.0.0.1:${port}`;
  const { cookie } = await mintOperatorSession(base, KEY);
  return { gate, base, cookie, stderr: () => stderr };
}

async function cleanup(fixture, gate) {
  await stopChild(gate, "SIGKILL");
  fs.rmSync(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

async function startChat(live, id, engine, message) {
  return fetch(
    `${live.base}/chat/stream?run=${id}&engine=${engine}&msg=${encodeURIComponent(message)}`,
    { headers: { cookie: live.cookie } },
  );
}

async function status(live, id) {
  const response = await fetch(`${live.base}/chat/runs/${id}`, { headers: { cookie: live.cookie } });
  assert.equal(response.status, 200);
  return response.json();
}

async function waitForStatus(live, id, wanted, timeoutMs = 1500) {
  return waitFor(async () => {
    const current = await status(live, id);
    return wanted.includes(current.status) ? current : null;
  }, `run ${id} did not reach ${wanted.join("|")}`, timeoutMs);
}

for (const outcome of ["success", "error"]) {
  test(`quarantine aborts Kimi and discards a late HTTP ${outcome}`, async () => {
    const fixture = createFixture(`late-${outcome}`, {
      sequence: outcome,
      fetchDelayMs: 220,
      quarantine: true,
    });
    let gate;
    try {
      const live = await boot(fixture);
      gate = live.gate;
      const id = `kimilate${outcome}`;
      const response = await startChat(live, id, "kimi", `hold for late ${outcome}`);
      const body = sseEvents(await response.text());
      const failed = await waitForStatus(live, id, ["failed"]);
      const done = body.filter((entry) => entry.event === "done");
      assert.equal(done.length, 1, JSON.stringify(body));
      assert.equal(JSON.parse(done[0].data).recovery, "restart_box");
      assert.equal(failed.status, "failed");
      const finishedAt = failed.finishedAt;

      await new Promise((resolve) => setTimeout(resolve, 300));
      const afterLateCallback = await status(live, id);
      assert.equal(afterLateCallback.status, "failed", "late Kimi completion cannot overwrite the durable failure");
      assert.equal(afterLateCallback.finishedAt, finishedAt, "late Kimi completion cannot rewrite terminal metadata");
      assert.deepEqual(traceRows(fixture.effectTrace), [],
        "late Kimi completion cannot run board intents, write artifacts, or record usage");
      assert.ok(traceRows(fixture.fetchTrace).some((row) => row.event === "abort"),
        "the quarantine handler aborts the live HTTP request");

      const blocked = await startChat(live, `blocked${outcome}`, "kimi", "must remain quarantined");
      const blockedDone = sseEvents(await blocked.text()).find((entry) => entry.event === "done");
      assert.equal(JSON.parse(blockedDone.data).recovery, "restart_box",
        "a late HTTP callback cannot release the quarantined lane");
      assert.equal(traceRows(fixture.fetchTrace).filter((row) => row.event === "fetch").length, 1,
        "no replacement Kimi request starts after quarantine");
    } finally {
      if (gate) await cleanup(fixture, gate);
      else fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}

test("a replacement gate inherits root quarantine and refuses Kimi before fetch or spawn", async () => {
  const fixture = createFixture("boot-quarantine", {
    sequence: "success",
    bootQuarantined: true,
    scheduledWork: true,
    wake: true,
    schedulerTickMs: 25,
  });
  let gate;
  try {
    const live = await boot(fixture);
    gate = live.gate;
    const response = await startChat(live, "kimibootblocked", "kimi", "must not leave the gate");
    const body = sseEvents(await response.text());
    const done = body.find((entry) => entry.event === "done");
    assert.ok(done, JSON.stringify(body));
    assert.equal(JSON.parse(done.data).recovery, "restart_box");
    assert.equal((await status(live, "kimibootblocked")).status, "failed");
    assert.deepEqual(traceRows(fixture.fetchTrace), [], "the replacement gate never starts a Kimi HTTP request");
    assert.deepEqual(traceRows(fixture.childTrace), [], "the replacement gate never falls through to a local child");
    assert.deepEqual(traceRows(fixture.effectTrace), [], "the refused run has no usage, board, or artifact side effects");
    await new Promise((resolve) => setTimeout(resolve, 150));
    const background = latestLedgerRuns(fixture.home)
      .filter((run) => ["wake_check", "loop", "multi_loop"].includes(run.kind));
    assert.deepEqual(background, [],
      "an inherited root quarantine refuses wake, Loop, and Multi-Loop work before durable acceptance");
  } finally {
    if (gate) await cleanup(fixture, gate);
    else fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a local quarantine fails and clears already-accepted Loop queues", async () => {
  // TIMINGS WIDENED 2026-08-09. This test raced itself: the first waitFor had a
  // 2200ms budget to observe both runs `queued`, and hardMaxMs fired at 2500ms and
  // terminalized them. ~300ms of slack, minus boot, minus the request, minus at
  // least one 1000ms scheduler tick. On a loaded CI runner it lost that race and
  // reported "NEW FAILURES SINCE BASELINE" against whatever commit happened to be
  // running -- it named PR #275 and PR #299 on changes that could not touch
  // quarantine or Loop queues, and on #299 it blocked a P0 that restored autonomous
  // dispatch. A gate that fails randomly makes "green CI" mean "re-run until green",
  // and the day a real regression appears it is indistinguishable from the flake.
  //
  // The ORDERING is what this test asserts and it is unchanged: scheduled work is
  // accepted while the fetch is in flight, observed `queued`, THEN the hard max
  // fires and terminalizes both. Only the wall-clock window is bigger, so a slow
  // runner still lands inside it. Costs ~5s of test time to stop losing P0 merges.
  const fixture = createFixture("queued-background", {
    sequence: "success",
    fetchDelayMs: 9000,
    quarantine: true,
    hardMaxMs: 6000,
    scheduledWork: true,
    schedulerTickMs: 1000,
  });
  let gate;
  try {
    const live = await boot(fixture);
    gate = live.gate;
    const response = startChat(live, "kimiholdsqueue", "kimi", "hold the lane while schedules queue");
    await waitFor(() => traceRows(fixture.fetchTrace).length === 1, "Kimi request did not start");
    await waitFor(() => {
      const runs = latestLedgerRuns(fixture.home);
      return runs.some((run) => run.kind === "loop" && run.status === "queued")
        && runs.some((run) => run.kind === "multi_loop" && run.status === "queued");
    }, "scheduled runs were not accepted behind the live Kimi request", 5000);

    const done = sseEvents(await (await response).text()).find((entry) => entry.event === "done");
    assert.equal(JSON.parse(done.data).recovery, "restart_box");
    await waitFor(() => {
      const runs = latestLedgerRuns(fixture.home);
      return runs.some((run) => run.kind === "loop" && run.status === "failed")
        && runs.some((run) => run.kind === "multi_loop" && run.status === "failed");
    }, "quarantine did not terminalize both scheduled queues");
    const background = latestLedgerRuns(fixture.home)
      .filter((run) => ["loop", "multi_loop"].includes(run.kind));
    // NO COUNT AND NO GROWTH CHECK. Both are untestable here, and I got this
    // wrong twice before landing on why.
    //
    // It first asserted background.length === 2. CI saw 4 -- exactly double --
    // because the fixture runs a REAL scheduler at 1000ms: one tick queues one
    // loop and one multi_loop, and a second tick before the quarantine lands
    // queues another pair. Nothing is wrong with the product when that happens.
    //
    // My next attempt snapshotted the run ids before the quarantine and asserted
    // none appeared after. That failed too, for the same reason relocated: the
    // boundary was when the TEST looked, not when the maps were cleared, so a
    // tick landing in between looked like a violation and was not.
    //
    // Tuning the timings cannot settle either version. The comment at the top of
    // this test records a 2026-08-09 fix that WIDENED them to cure a different
    // race here, and a wider window fits more ticks -- the two failure modes pull
    // in opposite directions.
    //
    // The property survives without any of it. Whatever the scheduler queued, the
    // loop below requires EVERY background run to be TERMINAL. A run created
    // after the maps were cleared would still be queued, so it fails there --
    // which is the original intent, tested by state rather than by clock.
    //
    // THIRD CORRECTION, 2026-08-11 (full history in the commit message).
    //
    // The loop asserted `status === "failed"`; CI produced `skipped`. That is
    // legitimate: recordCronSkip / recordMultiSkip write "skipped" when a tick
    // declines to double-queue while the previous run is still in flight. It is
    // terminal and it never starts a child. Which outcome a run gets depends
    // only on where the 1000ms tick boundary fell, so demanding "failed" is
    // demanding a clock -- the same mistake as the two attempts above.
    //
    // TERMINAL is the property that survives: this test exists to catch work
    // left HANGING after a quarantine. "failed" and "skipped" both mean it will
    // never run; "queued" does not, and still fails here.
    for (const run of background) {
      assert.ok(TERMINAL_RUN_STATUSES.has(run.status),
        `background run ${run.kind} was left non-terminal (${run.status}) -- quarantine must not strand scheduled work`);
      // Partition on "was this terminalized BY the quarantine", not on the
      // literal string "failed". Kimi's review caught that gating on "failed"
      // would let a run terminalized as cancelled/interrupted slip through with
      // no recovery action asserted at all. A pre-quarantine skip correctly
      // points at its own surface instead, so it is the only exemption.
      if (run.status === "skipped") {
        // Asserted, not exempted. A skip points at its own surface, and dropping
        // that action would strand the operator with a terminal record and no way
        // in. Exempting it wholesale let that regression pass silently. (Kimi, LOW.)
        assert.deepEqual(run.next_actions,
          run.kind === "multi_loop"
            ? [{ id: "open_multi_loop", label: "Open Multi-Loop" }]
            : [{ id: "open_loop", label: "Open Loop" }],
          `a pre-quarantine ${run.kind} skip must still offer its own surface`);
      } else {
        assert.deepEqual(run.next_actions, [{ id: "restart_box", label: "Restart box" }],
          `a run the quarantine terminalized (${run.status}) must carry the operator's recovery action`);
      }
    }

    // THE STABILITY GUARD: once the quarantine has settled, the ledger stops
    // growing. It draws no time boundary, which is why it survives where the two
    // attempts above died -- it asserts an absence over a window rather than
    // before/after a moment the test cannot observe.
    //
    // WHAT IT ACTUALLY CATCHES, corrected after review. It does NOT catch
    // "the maps were never cleared": cronTick and multiTick both return early on
    // agentLaneQuarantined, and quarantineAgentLane sets that latch synchronously
    // BEFORE clearing the maps -- so a maps-not-cleared regression records nothing
    // here either. An earlier version of this comment claimed otherwise and was
    // wrong. What it does catch is a post-quarantine QUEUEING regression: the
    // latch being removed, or a second accept path appearing that bypasses it.
    //
    // It cannot false-fail. In the passing direction a quarantined lane writes no
    // background record at all, so tick placement is irrelevant and a loaded CI
    // runner cannot flake it. In the failing direction at least two ticks land
    // inside 2600ms. Proven non-vacuous by mutation: emptying the snapshot set
    // makes it fire on the real records.
    const idsAfterQuarantine = new Set(background.map((run) => run.id));
    await new Promise((resolve) => setTimeout(resolve, 2600)); // > 2 scheduler ticks
    const appeared = latestLedgerRuns(fixture.home)
      .filter((run) => ["loop", "multi_loop"].includes(run.kind))
      .filter((run) => !idsAfterQuarantine.has(run.id));
    assert.deepEqual(appeared.map((run) => `${run.kind}:${run.status}`), [],
      "the ledger kept growing after the quarantine settled -- the maps were never cleared, "
      + "so the scheduler will skip forever and the Loop silently never runs again");

    // Whatever the scheduler queued or skipped, none of it ever started a child.
    assert.deepEqual(traceRows(fixture.childTrace), [], "queued background work never starts a local child");
  } finally {
    if (gate) await cleanup(fixture, gate);
    else fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("cancelling a 1:1 Kimi request settles promptly even when fetch ignores abort", async () => {
  const fixture = createFixture("cancel-one", { sequence: "hang,success" });
  let gate;
  try {
    const live = await boot(fixture);
    gate = live.gate;
    const firstId = "kimicancelone";
    const firstResponse = startChat(live, firstId, "kimi", "hang until cancelled");
    await waitFor(() => traceRows(fixture.fetchTrace).length === 1, "Kimi request did not start");

    const cancel = await fetch(`${live.base}/chat/runs/${firstId}/cancel`, {
      method: "POST",
      headers: { cookie: live.cookie, origin: live.base },
    });
    assert.equal(cancel.status, 200);
    await waitForStatus(live, firstId, ["cancelled"], 500);
    const first = await firstResponse;
    const firstDone = sseEvents(await first.text()).find((entry) => entry.event === "done");
    assert.match(JSON.parse(firstDone.data).error, /cancelled/i);

    const secondId = "kimiafterone";
    const second = await startChat(live, secondId, "kimi", "run after cancellation");
    await waitForStatus(live, secondId, ["completed"], 1000);
    assert.match(await second.text(), /LATE_KIMI_REPLY/);
    assert.equal(traceRows(fixture.fetchTrace).filter((row) => row.event === "fetch").length, 2,
      "prompt cancellation releases the shared lane for the next request");
  } finally {
    if (gate) await cleanup(fixture, gate);
    else fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("cancelling Team during Kimi settles promptly even when fetch ignores abort", async () => {
  const fixture = createFixture("cancel-team", { sequence: "hang,success" });
  let gate;
  try {
    const live = await boot(fixture);
    gate = live.gate;
    const firstId = "kimicancelteam";
    const firstResponse = startChat(live, firstId, "team", "hang Team until cancelled");
    await waitFor(() => traceRows(fixture.fetchTrace).length === 1, "Team Kimi request did not start");

    const cancel = await fetch(`${live.base}/chat/runs/${firstId}/cancel`, {
      method: "POST",
      headers: { cookie: live.cookie, origin: live.base },
    });
    assert.equal(cancel.status, 200);
    await waitForStatus(live, firstId, ["cancelled"], 500);
    const first = await firstResponse;
    const firstDone = sseEvents(await first.text()).find((entry) => entry.event === "done");
    assert.match(JSON.parse(firstDone.data).error, /cancelled/i);

    const secondId = "kimiafterteam";
    const second = await startChat(live, secondId, "kimi", "run after Team cancellation");
    await waitForStatus(live, secondId, ["completed"], 1000);
    assert.match(await second.text(), /LATE_KIMI_REPLY/);
    assert.equal(traceRows(fixture.fetchTrace).filter((row) => row.event === "fetch").length, 2,
      "Team cancellation releases the shared lane for the next request");
  } finally {
    if (gate) await cleanup(fixture, gate);
    else fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
