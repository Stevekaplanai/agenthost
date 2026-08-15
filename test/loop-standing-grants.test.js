// Loop standing grants (Steve, 2026-08-11).
//
// Both daily Loops gated as a CONSEQUENCE every day since they were created and
// therefore never ran once. The trigger was the word "text" -- "write a
// plain-text brief" -- read as the verb "to text someone". Neither Loop reaches
// anyone, neither is irreversible, neither needs a business judgment, so by Rule
// 13's three questions neither should gate at all.
//
// Rule 13's own remedy is a standing grant: the operator approves the SCHEDULE
// once instead of every run. The danger in that is obvious and is what these
// tests are really about -- a grant recorded against a job ID alone would
// silently keep covering the Loop after its prompt was rewritten, which is a
// blanket bypass wearing a grant's clothing. The grant is therefore bound to a
// fingerprint of the job's definition, and editing the Loop revokes it.
//
// These drive the REAL routes against a REAL booted gate. Every fetch carries an
// explicit timeout: on 2026-08-11 a test in this repo fetched a spawned gate with
// no timeout, the gate never answered, and the whole suite wedged silently for
// twenty minutes with no output naming anything.
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
const KEY = "loop-grants-test-key";
const JOB_ID = "abcdef123456";           // CRON_ID_RE: 12 lowercase alphanumerics
// "text" is the exact token that gates both of Steve's real Loops.
const GATING_PROMPT = "Write a plain-text brief of yesterday and save it.";

function jobsFile(home) {
  return path.join(home, ".claude", "agenthost", "cron", "jobs.json");
}
function writeJobs(home, jobs) {
  const file = jobsFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(jobs));
}
async function get(base, cookie, url, opts = {}) {
  const res = await fetch(base + url, {
    ...opts,
    // origin + sec-fetch-site are required for any non-GET: the gate refuses
    // cross-origin writes to operator routes with a 403 before the handler runs.
    headers: {
      cookie,
      "content-type": "application/json",
      origin: base,
      "sec-fetch-site": "same-origin",
      ...(opts.headers || {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

async function boot(t, { cron = "0 11 * * *", tickMs = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "loop-grants-"));
  writeJobs(home, [{
    id: JOB_ID,
    name: "Morning Briefing",
    cron,
    prompt: GATING_PROMPT,
    tzOffsetMin: 0,
    mode: "default",
    createdAt: "2026-08-01T00:00:00.000Z",
  }]);
  const gate = spawn(process.execPath, [GATE], {
    env: {
      ...process.env,
      HOME: home,
      TTYD_PASSWORD: KEY,
      GATE_PORT: "0",
      CHANNEL_DISPATCH_PORT: "0",
      KANBAN_BRIDGE_PORT: "0",
      BOARD_AUTONOMY: "off",
      // Scrubbed, not inherited: on any machine where these are set -- the box
      // itself, for one -- the spawned gate enforces its canonical host and every
      // request to 127.0.0.1 comes back 421, failing all six tests with a
      // misleading error that has nothing to do with grants. Found by the
      // reviewer running this suite somewhere other than my laptop.
      AGENTHOST_CANONICAL_HOST: "",
      FLY_APP_NAME: "",
      // Slow the scheduler just enough to record a grant before the first fire.
      // `* * * * *` is due in the CURRENT minute, so no minute boundary is waited on.
      ...(tickMs ? { AGENTHOST_SCHEDULER_TICK_MS: String(tickMs) } : {}),
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
  return { base, cookie, home };
}

test("a Loop with no standing approval has none, and the store starts empty", async (t) => {
  const { base, cookie } = await boot(t);
  const { status, body } = await get(base, cookie, "/cron/grants");
  assert.equal(status, 200);
  assert.deepEqual(body.grants, [], "nothing is approved until the operator says so");
});

test("the operator grants a Loop once and it applies to the CURRENT definition", async (t) => {
  const { base, cookie } = await boot(t);
  const post = await get(base, cookie, "/cron/grants", {
    method: "POST", body: JSON.stringify({ jobId: JOB_ID }),
  });
  assert.equal(post.status, 200);
  assert.equal(post.body.name, "Morning Briefing", "the reply names what was approved, not just an id");

  const list = await get(base, cookie, "/cron/grants");
  assert.equal(list.body.grants.length, 1);
  assert.equal(list.body.grants[0].applies, true);
  assert.equal(list.body.grants[0].why, null);
});

// THE test. Everything else is plumbing; this is the safety property.
//
// An earlier version of this test wrote jobs.json and asserted `applies: false`,
// and it PASSED -- while being wrong. cronTick never re-reads jobs.json, so the
// scheduler kept running under the grant; only the listing (which then read
// disk) claimed otherwise. The reviewer caught it: the test proved revocation at
// the listing layer while the box behaved the opposite way. That is precisely the
// misstatement this feature exists to prevent, embedded in its own test.
//
// The grant now binds the IN-MEMORY definition, so a disk edit is not a
// revocation at all -- it is a DIVERGENCE, and it is reported as its own state.
test("a jobs.json edit underneath the running gate is reported as divergence, not silently obeyed", async (t) => {
  const { base, cookie, home } = await boot(t);
  await get(base, cookie, "/cron/grants", { method: "POST", body: JSON.stringify({ jobId: JOB_ID }) });
  assert.equal((await get(base, cookie, "/cron/grants")).body.grants[0].applies, true);

  // Someone rewrites the saved Loop into an outbound send. The gate is still
  // running the approved one.
  writeJobs(home, [{
    id: JOB_ID,
    name: "Morning Briefing",
    cron: "0 11 * * *",
    prompt: "Text every customer about the outage.",
    tzOffsetMin: 0,
    mode: "default",
    createdAt: "2026-08-01T00:00:00.000Z",
  }]);

  const after = await get(base, cookie, "/cron/grants");
  assert.equal(after.body.grants[0].diverged, true, "the divergence is surfaced, not hidden");
  assert.match(String(after.body.grants[0].why), /until the gate restarts/i,
    "and the operator is told which definition the grant actually covers right now");
  assert.equal(after.body.grants[0].applies, true,
    "the grant still covers the RUNNING definition -- claiming otherwise while the scheduler used it was the bug");
});

test("approving a Loop whose saved copy has diverged is REFUSED, not silently bound to one side", async (t) => {
  const { base, cookie, home } = await boot(t);
  writeJobs(home, [{
    id: JOB_ID,
    name: "Morning Briefing",
    cron: "0 11 * * *",
    prompt: "Text every customer about the outage.",
    tzOffsetMin: 0,
    mode: "default",
    createdAt: "2026-08-01T00:00:00.000Z",
  }]);

  const post = await get(base, cookie, "/cron/grants", {
    method: "POST", body: JSON.stringify({ jobId: JOB_ID }),
  });
  assert.equal(post.status, 409,
    "approving here would bind a prompt the operator was never shown -- on either side of the divergence");
  assert.match(String(post.body.error), /restart the gate/i, "and the refusal says how to resolve it");
  assert.deepEqual((await get(base, cookie, "/cron/grants")).body.grants, [],
    "a refused approval leaves no grant behind");
});

test("a revoked grant is gone, and revoking one that does not exist says so", async (t) => {
  const { base, cookie } = await boot(t);
  await get(base, cookie, "/cron/grants", { method: "POST", body: JSON.stringify({ jobId: JOB_ID }) });

  const del = await get(base, cookie, "/cron/grants?job=" + JOB_ID, { method: "DELETE" });
  assert.equal(del.status, 200);
  assert.deepEqual((await get(base, cookie, "/cron/grants")).body.grants, []);

  const again = await get(base, cookie, "/cron/grants?job=" + JOB_ID, { method: "DELETE" });
  assert.equal(again.status, 404);
  assert.match(String(again.body.error), /no standing approval/i, "the refusal names the actual state");
});

test("a malformed or unknown job id is refused by name, never granted", async (t) => {
  const { base, cookie } = await boot(t);

  const bad = await get(base, cookie, "/cron/grants", {
    method: "POST", body: JSON.stringify({ jobId: "../../etc/passwd" }),
  });
  assert.equal(bad.status, 400, "a path-shaped id is not a job id");

  const missing = await get(base, cookie, "/cron/grants", {
    method: "POST", body: JSON.stringify({ jobId: "zzzzzzzzzzzz" }),
  });
  assert.equal(missing.status, 404, "a grant must bind a Loop that actually exists on disk");
  assert.ok(missing.body.error && missing.body.error.length > 0, "and it must say why");

  assert.deepEqual((await get(base, cookie, "/cron/grants")).body.grants, [],
    "neither refusal may leave a grant behind");
});

test("the grant routes are behind the operator cookie wall", async (t) => {
  const { base } = await boot(t);
  const res = await fetch(base + "/cron/grants", { signal: AbortSignal.timeout(10_000) });
  assert.equal(res.status, 401, "an unauthenticated caller cannot read or set standing approvals");
});

// ---- the control flow this whole change exists for --------------------------
//
// Every test above proves the GRANT BOOKKEEPING is right. None of them proved
// the thing that actually matters: that a granted Loop RUNS and an ungranted one
// still STOPS. The independent reviewer (Kimi/Moonshot) named this as the gap
// most worth closing -- "a refactor that flips either branch breaks no test."
//
// It is testable without waiting on a minute boundary: `* * * * *` is due in the
// current minute immediately, and AGENTHOST_SCHEDULER_TICK_MS is overridable, so
// the tick is slowed just enough to record the grant before the first fire.
function auditLines(home) {
  const file = path.join(home, ".claude", "agenthost", "audit.log");
  try {
    return fs.readFileSync(file, "utf8").trim().split("\n")
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}
async function waitForEvent(home, event, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const hit = auditLines(home).find((l) => l.event === event);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

test("an UNGRANTED Loop that is due still stops at the gate", async (t) => {
  const { base, cookie, home } = await boot(t, { cron: "* * * * *", tickMs: "2000" });
  const gated = await waitForEvent(home, "cron_approval_required");
  assert.ok(gated, "a due Loop with no standing approval must still be held for the operator");
  assert.equal(await waitForEvent(home, "cron_standing_grant_used", 1000), null,
    "and it must NOT run under a grant it does not have");
});

test("a GRANTED Loop that is due actually runs, naming what it would have gated on", async (t) => {
  const { base, cookie, home } = await boot(t, { cron: "* * * * *", tickMs: "4000" });
  const post = await get(base, cookie, "/cron/grants", {
    method: "POST", body: JSON.stringify({ jobId: JOB_ID }),
  });
  assert.equal(post.status, 200, "the grant must land before the first tick");

  const used = await waitForEvent(home, "cron_standing_grant_used");
  assert.ok(used, "the grant is recognised");
  assert.match(String(used.detail), /would otherwise have gated/i,
    "and the record must name the cause that was waived, not merely that something was");

  // The audit line alone proves NOTHING about the control flow: it is written
  // BEFORE the fall-through, so a `continue` inserted after it still logs and an
  // audit-only assertion still passes. That mutation was run and it did not fail
  // this test until this assertion existed. Observe an actual RUN instead.
  let ran = null;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !ran) {
    const runs = await get(base, cookie, "/cron/runs?job=" + JOB_ID);
    if (runs.body && Array.isArray(runs.body.runs) && runs.body.runs.length > 0) ran = runs.body.runs;
    else await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(ran, "a granted Loop must actually DISPATCH -- falling through is the entire point of the change");
  assert.equal(await waitForEvent(home, "cron_approval_required", 500), null,
    "a granted Loop must not ALSO be held for approval");
});
