// A Loop killed by a gateway restart names its own outcome.
//
// #384 and #385 made both Loop paths audit a terminal event, but both did it
// from the child-exit `finish()` -- and a SIGTERM kills the gate before that
// runs. So the single failure mode a restart CAUSES was the one it still could
// not report.
//
// Measured on agenthost-steve 2026-08-12:
//
//   00:00:06  cron_run           Error Log Triage
//   00:17:07  gateway_shutdown   SIGTERM: active work checkpointed
//   (nothing, ever)
//
// A deploy killed a Loop seventeen minutes in, and the audit log -- the surface
// every agent reads and the one the watch instructions grep -- showed a Loop
// that started and never ended. Indistinguishable from still running, which is
// the exact state #384/#385 were written to abolish.
//
// This drives a REAL gate: a real jobs.json, a real scheduler tick, a real agent
// spawn that hangs, and a real SIGTERM. Asserting on the audit log the operator
// actually reads is the point -- a test that read gate.js for the string would
// have passed against the broken build too.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stopChild } from "./child-process-helper.js";
import { mintOperatorSession } from "./operator-session-helper.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATE = path.join(HERE, "..", "container", "gate.js");
const KEY = "loop-interrupt-test-key";
const JOB_ID = "ffeeddccbbaa";           // CRON_ID_RE: 12 lowercase alphanumerics
const JOB_NAME = "Error Log Triage";
const MULTI_JOB_ID = "aabbccddeeff";
const MULTI_JOB_NAME = "Build And Prove";

// Hangs until the gate that spawned it goes away. The Loop must still be
// RUNNING when the SIGTERM lands -- that is the whole scenario.
const HANGING_AGENT = `
for (let i = 0; i < 600; i++) {
  await new Promise((resolve) => setTimeout(resolve, 50));
  try { process.kill(process.ppid, 0); } catch { process.exit(0); }
}
`;

// Shut down through a REAL operator mode switch rather than child.kill().
// Windows terminates a child unconditionally on kill("SIGTERM") -- the handler
// never runs, so a kill()-based test would report this fix broken on Steve's
// machine and working in CI. POST /api/mode is the production restart path: it
// self-signals SIGTERM and runs the identical gracefulShutdown a deploy does.
// Both tests go through THIS function so neither can drift onto a softer path.
async function shutdown(gate, base, cookie) {
  const exited = new Promise((resolve) => gate.once("exit", resolve));
  const switched = await fetch(base + "/api/mode", {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/json",
      origin: base,
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify({ mode: "growth" }),
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(switched.status, 200, "the mode switch is what triggers the shutdown");
  await exited;
}

function auditFile(home) {
  return path.join(home, ".claude", "agenthost", "audit.log");
}

function auditLines(home) {
  try {
    return fs.readFileSync(auditFile(home), "utf8").split("\n").filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// 60s, not 20s. A 5-second scheduler tick plus a cold gate boot is comfortably
// under 20s on a laptop and not obviously so on a loaded CI runner, and the
// failure mode of guessing low here is a flaky test that gets ignored -- which
// is the disease this whole file was written to treat. Kimi raised the timing on
// the #386 re-read; the reasoning holds even though the specific boundary case
// it worried about cannot happen (`* * * * *` matches the CURRENT minute, so the
// first tick fires it and there is no minute-boundary wait).
async function waitForEvent(home, event, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (auditLines(home).some((line) => line.event === event)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`audit log never recorded ${event}; saw: `
    + JSON.stringify(auditLines(home).map((l) => l.event)));
}

// There is no audit event for "a Multi-Loop is waiting for the slot" -- queuing
// is a ledger state, not an announcement -- so this reads the ledger's own
// active-runs view rather than inventing a signal to wait on.
async function waitForQueuedMulti(base, cookie, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let seen = [];
  while (Date.now() < deadline) {
    const res = await fetch(base + "/runs?view=active", {
      headers: { cookie },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const body = await res.json();
      seen = (body.runs || []).map((r) => `${r.kind}:${r.status}`);
      if ((body.runs || []).some((r) => r.kind === "multi_loop" && r.status === "queued")) return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("no Multi-Loop ever reached `queued`; active runs were: " + JSON.stringify(seen));
}

// Loops and Multi-Loops share ONE agent slot, so a box seeded with both would
// run whichever won the tick and leave the other queued -- and a queued run is a
// different scenario from a running one. Each test seeds only its own kind.
// tickMs is a real determinism control, not a knob. A Loop gates unless a
// standing grant is already on disk, the grant is minted over HTTP after boot,
// and `cronLastFired` blocks a second attempt in the same minute -- so a tick
// fast enough to beat the grant makes the run gate ONCE and never retry, and the
// test hangs until timeout. Seen exactly that at 100ms. The Multi-Loop path has
// no grant to lose and keeps the fast tick.
async function boot(t, { multi = false, tickMs = 5000 } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "loop-interrupt-"));
  const cronDir = path.join(home, ".claude", "agenthost", "cron");
  fs.mkdirSync(cronDir, { recursive: true });
  // The cron Loop is seeded in BOTH shapes. In the multi case it is not the
  // subject -- it is the thing that OCCUPIES the single shared agent slot, so
  // the Multi-Loop is forced into `queued` and stays there. That is the state
  // this fix is actually needed for: a queued run has no child process, so
  // nothing self-reports for it, and before this change it vanished in silence.
  fs.writeFileSync(path.join(cronDir, "jobs.json"), JSON.stringify([{
    id: JOB_ID,
    name: JOB_NAME,
    cron: "* * * * *",                   // due in the CURRENT minute, no boundary wait
    prompt: "Reticulate the splines and name the current UTC minute.",
    tzOffsetMin: 0,
    mode: "default",
    createdAt: "2026-08-01T00:00:00.000Z",
  }]));
  if (multi) {
    fs.writeFileSync(path.join(cronDir, "multi-jobs.json"), JSON.stringify([{
      id: MULTI_JOB_ID,
      name: MULTI_JOB_NAME,
      cron: "* * * * *",
      objective: "Check the current UTC minute, then stop.",
      // `instruction`, NOT `prompt`. A Multi-Loop stage is gated by
      // isHumanGated({ title: stage.instruction, body: job.objective }), so a
      // stage carrying `prompt` hands the classifier an undefined title, gates,
      // and FINISHES as `multi_gated` -- terminal, therefore never active at
      // shutdown, therefore nothing to interrupt. The test failed for that
      // reason first and it looked exactly like the fix not working.
      //
      // The verb matters too: multiTick passes no `classifierFollows`, so
      // chains-lib's wording allowlist applies and unknown phrasing FAILS
      // CLOSED. "Report ..." is not in SAFE_VERBS and gates; "Check ..." is.
      stages: [{ engine: "claude", instruction: "Check the current UTC minute, then stop." }],
      tzOffsetMin: 0,
      mode: "default",
      createdAt: "2026-08-01T00:00:00.000Z",
    }]));
  }

  const wrap = path.join(home, "hanging-agent.mjs");
  fs.writeFileSync(wrap, HANGING_AGENT);

  // The real charter is 37KB and rides argv. Windows caps a command line at
  // ~32K, so under the production charter every spawn here dies ENAMETOOLONG
  // BEFORE the agent starts -- which produces a `cron_failed` for the wrong
  // reason and would have made this test pass against the broken build. Same
  // seam, and same reason, as gate-chat-restart-fresh.
  const charter = path.join(home, "tiny-charter.md");
  fs.writeFileSync(charter, "You are a test agent.");

  const gate = spawn(process.execPath, [GATE], {
    env: {
      ...process.env,
      HOME: home,
      TTYD_PASSWORD: KEY,
      AGENT_CHAT_BIN: "fake-claude",
      AGENTHOST_DEV_WRAP: wrap,
      AGENT_CHARTER_FILE: charter,
      AGENTHOST_MODE_FILE: path.join(home, "mode.json"),
      GATE_PORT: "0",
      CHANNEL_DISPATCH_PORT: "0",
      KANBAN_BRIDGE_PORT: "0",
      BOARD_AUTONOMY: "off",
      WAKE_CHECKIN: "off",
      // Scrubbed for the same reason loop-standing-grants scrubs them: on the box
      // itself these are set, the spawned gate enforces its canonical host, and
      // every 127.0.0.1 request comes back 421.
      AGENTHOST_CANONICAL_HOST: "",
      FLY_APP_NAME: "",
      AGENTHOST_SCHEDULER_TICK_MS: String(tickMs),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`gate did not listen; stdout=${stdout}; stderr=${stderr}`)), 20_000);
    gate.stdout.on("data", (c) => {
      stdout += c.toString();
      const m = stdout.match(/listening on (\d+)/);
      if (m) { clearTimeout(timer); resolve(`http://127.0.0.1:${m[1]}`); }
    });
    gate.stderr.on("data", (c) => { stderr += c.toString(); });
    gate.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`gate exited ${code}; stdout=${stdout}; stderr=${stderr}`));
    });
  });

  const { cookie } = await mintOperatorSession(base, KEY);
  t.after(async () => {
    await stopChild(gate);
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { gate, base, cookie, home };
}

// Windows has no POSIX signal delivery: kill("SIGTERM") -- and even a
// self-directed process.kill(process.pid, "SIGTERM") -- terminates the process
// unconditionally, so `gracefulShutdown` never executes and NOTHING here can be
// observed. Measured, not assumed: on Windows this run reaches `mode_changed`
// and then dies without a `gateway_shutdown` line. Skipping is honest; asserting
// on a path the OS cannot reach would be a test that always agrees with itself.
// The box is Linux and CI runs an ubuntu job, so this executes where it matters.
const SIGNALS_WORK = process.platform !== "win32";

test("a Loop still running when the gateway shuts down is audited as failed, naming the shutdown", {
  skip: SIGNALS_WORK ? false : "Windows cannot deliver SIGTERM to a handler; gracefulShutdown never runs",
}, async (t) => {
  const { gate, base, cookie, home } = await boot(t);

  // Approve the schedule once so the run reaches the agent instead of parking on
  // the consequence gate. This mirrors the real box, where both daily Loops run
  // under a standing grant.
  const granted = await fetch(base + "/cron/grants", {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/json",
      origin: base,
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify({ jobId: JOB_ID }),
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(granted.status, 200, "the standing grant must be recorded before the first fire");

  await waitForEvent(home, "cron_run");

  // The Loop is now running and its agent is hanging -- the production shape.
  assert.equal(
    auditLines(home).some((l) => l.event === "cron_finished" || l.event === "cron_failed"),
    false,
    "precondition: no terminal event yet, the run is genuinely still in flight. Saw: "
      + JSON.stringify(auditLines(home).map((l) => l.event + "|" + String(l.detail).slice(0, 120))),
  );

  await shutdown(gate, base, cookie);

  const lines = auditLines(home);
  const terminal = lines.filter((l) => l.event === "cron_failed");
  assert.equal(terminal.length, 1, "the interrupted Loop records exactly one terminal event, not zero and not one per tick. Saw: "
    + JSON.stringify(lines.map((l) => l.event + "|" + String(l.detail).slice(0, 100))));
  assert.match(terminal[0].detail, new RegExp(JOB_NAME),
    "the line names WHICH Loop died -- an opaque run id makes the operator go digging");
  assert.match(terminal[0].detail, /gateway shut down \(SIGTERM\)/,
    "and names the cause, per Rule 16: a failure must name its own cause");

  // Ordering matters for anyone reading the log top-to-bottom: the run's own
  // outcome is recorded before the gateway announces it has finished shutting
  // down, so the Loop's death is attributable to this shutdown and not the next.
  const failedAt = lines.findIndex((l) => l.event === "cron_failed");
  const shutdownAt = lines.findIndex((l) => l.event === "gateway_shutdown");
  assert.ok(failedAt !== -1 && shutdownAt !== -1 && failedAt < shutdownAt,
    "the interrupted run is audited before gateway_shutdown");
});

// The Multi-Loop half of the same fix. Kimi flagged on #386 that the emission
// branches on `kind` and only one branch had a test -- which is precisely the
// gap #384/#385 shipped with ("verified by code, not by behaviour") and the one
// this file exists to stop repeating. `Build & Prove`, the real Multi-Loop that
// died at 22:00 on 2026-08-11, is the case this stands in for.
test("a Multi-Loop QUEUED when the gateway shuts down is audited as failed too", {
  skip: SIGNALS_WORK ? false : "Windows cannot deliver SIGTERM to a handler; gracefulShutdown never runs",
}, async (t) => {
  const { gate, base, cookie, home } = await boot(t, { multi: true });

  const granted = await fetch(base + "/cron/grants", {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/json",
      origin: base,
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify({ jobId: JOB_ID }),
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(granted.status, 200);

  // The Loop takes the one agent slot and hangs onto it, so the Multi-Loop that
  // comes due in the same tick can only QUEUE. That is deliberately not the case
  // the first test covers: a RUNNING Multi-Loop has a child, and killing that
  // child makes its own `finish()` report "stage 1 (claude) failed" before the
  // shutdown interrupt is even reached -- measured, and the reason this test
  // targets the queued state instead. A queued run has no child, so nothing
  // reports it and it disappeared completely before this fix.
  await waitForEvent(home, "cron_run");
  await waitForQueuedMulti(base, cookie);

  assert.equal(
    auditLines(home).some((l) => l.event === "multi_finished" || l.event === "multi_failed"),
    false,
    "precondition: the Multi-Loop is queued, not finished. Saw: "
      + JSON.stringify(auditLines(home).map((l) => l.event + "|" + String(l.detail).slice(0, 120))),
  );

  await shutdown(gate, base, cookie);

  const lines = auditLines(home);
  const terminal = lines.filter((l) => l.event === "multi_failed");
  assert.equal(terminal.length, 1, "the interrupted Multi-Loop records exactly one terminal event. Saw: "
    + JSON.stringify(lines.map((l) => l.event + "|" + String(l.detail).slice(0, 100))));
  assert.match(terminal[0].detail, new RegExp(MULTI_JOB_NAME),
    "the line names WHICH Multi-Loop died");
  assert.match(terminal[0].detail, /gateway shut down \(SIGTERM\)/,
    "and names the cause, per Rule 16. Got: " + terminal[0].detail);
});
