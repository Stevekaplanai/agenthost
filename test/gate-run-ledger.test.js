import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { mintOperatorSession } from "./operator-session-helper.js";

const GATE = path.join(import.meta.dirname, "..", "container", "gate.js");
const KEY = "gate-ledger-test-key";
let HOME;
let gate;
let base;
let cookie;
let startsFile;
let longChatSequence = 0;

async function bootGate() {
  gate = spawn("node", [GATE], {
    env: {
      ...process.env,
      HOME,
      PATH: path.join(HOME, "bin") + path.delimiter + process.env.PATH,
      TTYD_PASSWORD: KEY,
      AGENT_CHAT_BIN: "fake-claude",
      AGENTHOST_DEV_WRAP: path.join(HOME, "ledger-agent.mjs"),
      AGENT_CHARTER_FILE: path.join(HOME, "test-charter.md"),
      LEDGER_STARTS_FILE: startsFile,
      AGENTHOST_SCHEDULER_TICK_MS: "50",
      AGENTHOST_TEST_FLIGHT_RECORDER_MS: "50",
      AGENTHOST_TEST_LOOP_APPROVAL_MS: "300",
      AGENTHOST_TEST_BOX_BOOT_ID: "boot-test",
      FLY_IMAGE_REF: "registry.fly.io/agenthost-steve:deployment-FLIGHT123",
      FLY_MACHINE_ID: "machine-flight-test",
      FLY_REGION: "iad",
      NODE_ENV: "test",
      WAKE_CHECKIN: "off",
      GATE_PORT: "0",
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const port = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("gate did not report a port: " + output)), 5000);
    gate.stdout.on("data", (chunk) => {
      output += chunk.toString();
      const match = output.match(/listening on (\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
    gate.on("exit", () => { clearTimeout(timer); reject(new Error("gate exited before listening: " + output)); });
  });
  base = `http://127.0.0.1:${port}`;
  cookie = (await mintOperatorSession(base, KEY)).cookie;
}

async function stopGate() {
  if (!gate || gate.exitCode !== null) return;
  const exited = new Promise((resolve) => gate.once("exit", resolve));
  gate.kill("SIGKILL");
  await exited;
}

function operatorHeaders(extra = {}) {
  return { cookie, origin: base, "sec-fetch-site": "same-origin", ...extra };
}

async function waitUntil(check, timeoutMs = 12000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("condition did not become true");
}

function startCount(marker) {
  return fs.readFileSync(startsFile, "utf8").split("\n").filter(Boolean)
    .map((line) => JSON.parse(line).prompt)
    .filter((prompt) => prompt.includes(marker)).length;
}

async function startLongChat() {
  const end = Date.now() + 12000;
  const runId = `ledgerblock${String(++longChatSequence).padStart(2, "0")}`;
  while (Date.now() < end) {
    const controller = new AbortController();
    const response = await fetch(`${base}/chat/stream?run=${runId}&msg=${encodeURIComponent("LONG hold scheduler")}`, {
      headers: { cookie }, signal: controller.signal,
    });
    if (response.status !== 200) {
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 40));
      continue;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    while (!seen.includes("first:")) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += decoder.decode(value, { stream: true });
    }
    controller.abort();
    try { await reader.cancel(); } catch {}
    if (seen.includes("first:")) return;
  }
  throw new Error("a LONG chat never acquired the shared agent lane");
}

async function loopRunFor(jobId, wantedStatus) {
  let last = null;
  try {
    return await waitUntil(async () => {
      const response = await fetch(`${base}/runs?after=0&limit=1000`, { headers: { cookie } });
      assert.equal(response.status, 200);
      const body = await response.json();
      const events = body.events.filter((event) => event.kind === "loop"
        && event.artifacts.some((artifact) => artifact.type === "loop_job" && artifact.id === jobId));
      last = events.at(-1)?.run || last;
      return last && last.status === wantedStatus ? last : null;
    });
  } catch (error) {
    let history = null;
    try { history = await (await fetch(`${base}/cron/runs?job=${encodeURIComponent(jobId)}`, { headers: { cookie } })).json(); } catch {}
    error.message += `; last Loop state was ${JSON.stringify(last)}; run projection was ${JSON.stringify(history)}`;
    throw error;
  }
}

async function multiRunFor(jobId, wantedStatus) {
  return waitUntil(async () => {
    const response = await fetch(`${base}/runs?after=0&limit=1000`, { headers: { cookie } });
    assert.equal(response.status, 200);
    const body = await response.json();
    const events = body.events.filter((event) => event.kind === "multi_loop"
      && event.artifacts.some((artifact) => artifact.type === "multi_loop_job" && artifact.id === jobId));
    const last = events.at(-1);
    return last && last.run.status === wantedStatus ? { run: last.run, events } : null;
  });
}

async function flightRecorderEvents(runId) {
  const response = await fetch(`${base}/runs?after=0&limit=1000`, { headers: { cookie } });
  assert.equal(response.status, 200);
  const body = await response.json();
  return body.events.filter((event) => event.kind === "system"
    && (!runId || event.runId === runId)
    && event.artifacts.some((artifact) => artifact.type === "flight_recorder"));
}

before(async () => {
  HOME = fs.mkdtempSync(path.join(import.meta.dirname, ".gateledger-"));
  fs.mkdirSync(path.join(HOME, "work"), { recursive: true });
  fs.mkdirSync(path.join(HOME, ".agenthost"), { recursive: true });
  fs.mkdirSync(path.join(HOME, "bin"), { recursive: true });
  fs.writeFileSync(path.join(HOME, "bin", "claude"), "");
  fs.writeFileSync(path.join(HOME, ".agenthost", "settings.json"), JSON.stringify({
    llm: { roster: { claude: { active: true, inChat: true } } },
  }));
  startsFile = path.join(HOME, "starts.log");
  fs.writeFileSync(startsFile, "");
  fs.writeFileSync(path.join(HOME, "test-charter.md"), "Test team charter.");
  fs.writeFileSync(path.join(HOME, "ledger-agent.mjs"), [
    'import fs from "node:fs";',
    'const args = process.argv.slice(3);',
    'const at = args.indexOf("-p");',
    'const prompt = at === -1 ? "" : args[at + 1];',
    'fs.appendFileSync(process.env.LEDGER_STARTS_FILE, JSON.stringify({prompt}) + "\\n");',
    'const emit = (text) => process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"content_block_delta",delta:{type:"text_delta",text}}})+"\\n");',
    'emit("first:" + prompt);',
    'await new Promise((resolve) => setTimeout(resolve, prompt.includes("LONG") ? 8000 : 60));',
    'emit("|last");',
    'process.stdout.write(JSON.stringify({type:"result",usage:{input_tokens:1,output_tokens:1}})+"\\n");',
    "",
  ].join("\n"));
  // Avoid creating the fixture in the last seconds of a minute: the restart
  // assertion below deliberately proves same-minute de-duplication.
  if (new Date().getUTCSeconds() > 45) {
    await new Promise((resolve) => setTimeout(resolve, (61 - new Date().getUTCSeconds()) * 1000));
  }
  await bootGate();
});

after(async () => {
  await stopGate();
  if (HOME) fs.rmSync(HOME, { recursive: true, force: true });
});

test("flight recorder proves box continuity and identifies the deployed gateway", async () => {
  const firstEvents = await waitUntil(async () => {
    const events = await flightRecorderEvents();
    return events.some((event) => event.type === "progress") ? events : null;
  });
  const firstRunId = firstEvents[0].runId;
  assert.deepEqual(firstEvents.slice(0, 3).map((event) => event.type), ["accepted", "started", "progress"]);
  const artifacts = firstEvents.at(-1).artifacts;
  assert.equal(artifacts.find((artifact) => artifact.type === "box_boot").id, "boot-test");
  assert.equal(artifacts.find((artifact) => artifact.type === "deployment").id, "deployment-FLIGHT123");
  assert.equal(artifacts.find((artifact) => artifact.type === "region").id, "iad");
  assert.match(artifacts.find((artifact) => artifact.type === "machine").id, /^[a-f0-9]{12}$/,
    "machine identity is stable but not exposed raw");
  const ledgerText = fs.readFileSync(path.join(HOME, ".claude", "agenthost", "runs", "runs.jsonl"), "utf8");
  assert.doesNotMatch(ledgerText, /machine-flight-test/, "raw Fly machine identity never enters the ledger");
  assert.doesNotMatch(ledgerText, /registry\.fly\.io/, "raw image reference never enters the ledger");

  await stopGate(); // abrupt loss: the recorder cannot write its own terminal event
  await bootGate();
  const reconciled = await waitUntil(async () => {
    const oldEvents = await flightRecorderEvents(firstRunId);
    const allEvents = await flightRecorderEvents();
    const replacement = allEvents.find((event) => event.runId !== firstRunId && event.type === "progress");
    return oldEvents.at(-1)?.status === "interrupted" && replacement ? { oldEvents, replacement } : null;
  });
  assert.equal(reconciled.oldEvents.at(-1).summary,
    "Gateway restarted before this run recorded a trustworthy outcome.");
  assert.equal(reconciled.replacement.artifacts.find((artifact) => artifact.type === "box_boot").id, "boot-test",
    "same boot id proves the box stayed up while only the gateway restarted");
});

test("Loops and Multi-Loops persist queue, terminal, gated, and same-minute restart truth", async () => {
  const unauthenticated = await fetch(`${base}/runs`, { redirect: "manual" });
  assert.notEqual(unauthenticated.status, 200, "run history stays behind the box login");

  await startLongChat();
  const liveState = await (await fetch(`${base}/cc/state`, { headers: { cookie } })).json();
  assert.equal(liveState.engines.claude.state, "working", "the dashboard light follows a detached run still executing on the box");
  const marker = "Summarize quarterly reliability";
  const create = await fetch(`${base}/cron/jobs`, {
    method: "POST",
    headers: operatorHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ name: "Reliability brief", cron: "* * * * *", prompt: marker, tzOffsetMin: 0 }),
  });
  assert.equal(create.status, 200);
  const job = (await create.json()).job;

  const queued = await loopRunFor(job.id, "queued");
  assert.equal(queued.startedAt, null);
  assert.equal(startCount(marker), 0, "the Loop is recorded before the busy slot starts it");

  const completed = await loopRunFor(job.id, "completed");
  assert.equal(startCount(marker), 1);
  assert.equal(typeof completed.startedAt, "number");
  assert.equal(typeof completed.finishedAt, "number");
  assert.ok(completed.artifacts.some((artifact) => artifact.type === "loop_run"));
  const detailResponse = await fetch(`${base}/runs/${encodeURIComponent(completed.id)}`, { headers: { cookie } });
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();
  assert.equal(detail.run.id, completed.id);
  assert.deepEqual(detail.events.map((event) => event.type), ["accepted", "started", "completed"], "run detail includes its complete retained timeline");

  const legacy = await fetch(`${base}/cron/runs?job=${encodeURIComponent(job.id)}`, { headers: { cookie } });
  const history = await legacy.json();
  assert.ok(history.runs.some((run) => run.runId === completed.id),
    "the detailed Loop output points back to the universal run even if another minute became due");
  assert.doesNotMatch(fs.readFileSync(path.join(HOME, ".claude", "agenthost", "runs", "runs.jsonl"), "utf8"), new RegExp(marker),
    "the ledger never stores the Loop prompt");

  await stopGate();
  await bootGate();
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(startCount(marker), 1, "the same scheduled minute attaches to its existing run id instead of executing twice");
  assert.equal((await loopRunFor(job.id, "completed")).id, completed.id);

  // A Multi-Loop that reaches a consequence gate records the exact stage,
  // ends without launching an agent, and remains actionable in history.
  await stopGate();
  const multiJob = {
    id: "multigate001",
    name: "Release handoff",
    cron: "* * * * *",
    tzOffsetMin: 0,
    objective: "Prepare a release handoff",
    stages: [
      { engine: "claude", instruction: "Deploy the app now" },
      { engine: "codex", instruction: "Review the deployment" },
    ],
    createdAt: new Date().toISOString(),
  };
  const cronDir = path.join(HOME, ".claude", "agenthost", "cron");
  fs.mkdirSync(cronDir, { recursive: true });
  fs.writeFileSync(path.join(cronDir, "multi-jobs.json"), JSON.stringify([multiJob]));
  await bootGate();

  const multi = await multiRunFor(multiJob.id, "failed");
  assert.ok(multi.events.some((event) => event.type === "gated" && event.status === "gated"),
    "the timeline preserves the gated stage before the terminal outcome");
  assert.equal(multi.run.summary, "Multi-Loop stopped for operator review: Release handoff");
  assert.deepEqual(multi.run.next_actions, [{ id: "open_multi_loop", label: "Open Multi-Loop" }]);
  assert.equal(startCount("Deploy the app now"), 0, "a gated stage never reaches an engine");

  const multiHistoryResponse = await fetch(`${base}/cron/multi/runs?job=${multiJob.id}`, { headers: { cookie } });
  const multiHistory = await multiHistoryResponse.json();
  assert.equal(multiHistory.runs[0].runId, multi.run.id);
  assert.equal(multiHistory.runs[0].status, "gated");
  assert.equal(multiHistory.runs[0].stages[0].status, "gated");

  const recentResponse = await fetch(`${base}/runs?view=recent&limit=3`, { headers: { cookie } });
  assert.equal(recentResponse.status, 200);
  const recent = await recentResponse.json();
  assert.ok(recent.events.length <= 3 && recent.events.length > 0);
  assert.ok(Number.isSafeInteger(recent.nextCursor) && recent.nextCursor > 0, "a new Command Center viewer receives the latest durable cursor");
});

test("a consequential single Loop needs one durable exact-run approval before any agent starts", async () => {
  const marker = "Deploy the exact scheduled release to production";
  const create = await fetch(`${base}/cron/jobs`, {
    method: "POST",
    headers: operatorHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ name: "Production release", cron: "* * * * *", prompt: marker, tzOffsetMin: 0 }),
  });
  assert.equal(create.status, 200);
  const job = (await create.json()).job;

  const gated = await loopRunFor(job.id, "gated");
  assert.equal(startCount(marker), 0, "a consequence-gated Loop never reaches an engine before approval");
  assert.match(gated.summary, /approval/i, "the durable run names why it stopped");
  assert.deepEqual(gated.next_actions, [{ id: "approve_loop_run", label: "Approve this run once" }]);
  const consequence = gated.artifacts.find((artifact) => artifact.type === "loop_consequence");
  assert.match(consequence?.id || "", /^[a-f0-9]{64}$/, "the ledger binds approval to a non-reversible exact-run fingerprint");
  assert.ok(gated.artifacts.some((artifact) => artifact.type === "loop_job" && artifact.id === job.id));
  assert.doesNotMatch(fs.readFileSync(path.join(HOME, ".claude", "agenthost", "runs", "runs.jsonl"), "utf8"), new RegExp(marker),
    "the exact approval fingerprint must not leak the consequential prompt into the ledger");

  const historyResponse = await fetch(`${base}/cron/runs?job=${encodeURIComponent(job.id)}`, { headers: { cookie } });
  assert.equal(historyResponse.status, 200);
  const history = await historyResponse.json();
  assert.equal(history.runs[0].runId, gated.id);
  assert.equal(history.runs[0].status, "gated", "the Loops screen can see the gate without querying a second store");
  assert.equal(history.runs[0].approvalFingerprint, consequence.id);
  assert.equal(history.runs[0].approvalPending, false);
  assert.match(history.runs[0].error, /approval/i, "the visible run record carries the actual stop cause");

  const approvePath = `${base}/cron/runs/${encodeURIComponent(gated.id)}/approve`;
  const unauthenticatedApproval = await fetch(approvePath, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision: "approve_once", fingerprint: consequence.id }),
  });
  assert.notEqual(unauthenticatedApproval.status, 200, "exact-run approvals stay behind the operator login");
  const standing = await fetch(approvePath, {
    method: "POST",
    headers: operatorHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ decision: "allow_forever", fingerprint: consequence.id }),
  });
  assert.equal(standing.status, 400, "a recurring schedule can never become a standing consequence approval");
  assert.match((await standing.json()).summary, /one|exact|standing/i);
  const mismatched = await fetch(approvePath, {
    method: "POST",
    headers: operatorHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ decision: "approve_once", fingerprint: "0".repeat(64) }),
  });
  assert.equal(mismatched.status, 409);
  assert.match((await mismatched.json()).summary, /does not match|changed/i);
  assert.equal(startCount(marker), 0, "a mismatched approval launches nothing");

  await stopGate();
  const jobsFile = path.join(HOME, ".claude", "agenthost", "cron", "jobs.json");
  const changedJobs = JSON.parse(fs.readFileSync(jobsFile, "utf8"));
  const changedJob = changedJobs.find((candidate) => candidate.id === job.id);
  changedJob.prompt = marker + " after its saved instruction changed";
  changedJob.cron = "0 0 1 1 *";
  fs.writeFileSync(jobsFile, JSON.stringify(changedJobs, null, 2));
  await bootGate();
  const afterRestart = await loopRunFor(job.id, "gated");
  assert.equal(afterRestart.id, gated.id, "an unapproved gate survives a gateway restart as the same run");
  assert.equal(startCount(marker), 0);

  const changedApproval = await fetch(`${base}/cron/runs/${encodeURIComponent(gated.id)}/approve`, {
    method: "POST",
    headers: operatorHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ decision: "approve_once", fingerprint: consequence.id }),
  });
  assert.equal(changedApproval.status, 409, "an old fingerprint cannot approve a changed current job");
  const changedBody = await changedApproval.json();
  assert.match(changedBody.summary, /changed|does not match/i);
  assert.equal(startCount(marker), 0, "recomputing against a changed prompt and schedule launches nothing");
  const refreshedFingerprint = changedBody.run.artifacts
    .find((artifact) => artifact.type === "loop_consequence")?.id;
  assert.match(refreshedFingerprint || "", /^[a-f0-9]{64}$/);
  assert.notEqual(refreshedFingerprint, consequence.id,
    "the durable gate rotates to the current job bytes so the refreshed UI is not a dead end");

  const approve = await fetch(`${base}/cron/runs/${encodeURIComponent(gated.id)}/approve`, {
    method: "POST",
    headers: operatorHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ decision: "approve_once", fingerprint: refreshedFingerprint }),
  });
  assert.equal(approve.status, 200);
  assert.match((await approve.json()).summary, /approved.*once/i);
  const completed = await loopRunFor(job.id, "completed");
  assert.equal(completed.id, gated.id, "approval resumes the same scheduled run instead of manufacturing a replacement");
  assert.equal(startCount(marker), 1, "one exact approval launches one agent exactly once");

  const duplicate = await fetch(`${base}/cron/runs/${encodeURIComponent(gated.id)}/approve`, {
    method: "POST",
    headers: operatorHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ decision: "approve_once", fingerprint: refreshedFingerprint }),
  });
  assert.equal(duplicate.status, 409, "a consumed approval cannot be submitted a second time");
  assert.match((await duplicate.json()).summary, /already|ended|consumed/i);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(startCount(marker), 1, "a duplicate approval cannot launch a second child");
});

test("an exact Loop approval expires closed while the agent lane is busy", async () => {
  const marker = "Send the exact scheduled customer email";
  const create = await fetch(`${base}/cron/jobs`, {
    method: "POST",
    headers: operatorHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ name: "Customer delivery", cron: "* * * * *", prompt: marker, tzOffsetMin: 0 }),
  });
  assert.equal(create.status, 200);
  const job = (await create.json()).job;
  const gated = await loopRunFor(job.id, "gated");
  const fingerprint = gated.artifacts.find((artifact) => artifact.type === "loop_consequence")?.id;
  assert.match(fingerprint || "", /^[a-f0-9]{64}$/);

  await startLongChat();
  const approve = await fetch(`${base}/cron/runs/${encodeURIComponent(gated.id)}/approve`, {
    method: "POST",
    headers: operatorHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ decision: "approve_once", fingerprint }),
  });
  assert.equal(approve.status, 200);
  const pendingHistory = await waitUntil(async () => {
    const response = await fetch(`${base}/cron/runs?job=${encodeURIComponent(job.id)}`, { headers: { cookie } });
    const body = await response.json();
    return body.runs[0]?.approvalPending === true ? body.runs[0] : null;
  });
  assert.equal(pendingHistory.runId, gated.id, "the durable run record exposes its unconsumed grant to the Loops UI");
  const expired = await waitUntil(async () => {
    const response = await fetch(`${base}/runs/${encodeURIComponent(gated.id)}`, { headers: { cookie } });
    if (response.status !== 200) return null;
    const body = await response.json();
    return body.run?.status === "gated" && /expired/i.test(body.run.summary || "") ? body.run : null;
  });
  assert.equal(expired.id, gated.id);
  assert.match(expired.summary, /expired/i, "the durable run names the real reason it remains gated");
  assert.equal(startCount(marker), 0, "an expired grant never reaches the agent");
  assert.equal(expired.artifacts.some((artifact) => artifact.type === "loop_approval"), false,
    "the expired grant is removed from current state so it cannot be replayed");
  await waitUntil(async () => {
    const state = await (await fetch(`${base}/cc/state`, { headers: { cookie } })).json();
    return state.engines.claude.state !== "working";
  });
});

test("a restart cannot strand an approved gated Loop without an in-memory queue owner", async () => {
  const marker = "Delete the exact scheduled temporary export";
  const create = await fetch(`${base}/cron/jobs`, {
    method: "POST",
    headers: operatorHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ name: "Temporary export cleanup", cron: "* * * * *", prompt: marker, tzOffsetMin: 0 }),
  });
  assert.equal(create.status, 200);
  const job = (await create.json()).job;
  const gated = await loopRunFor(job.id, "gated");
  const fingerprint = gated.artifacts.find((artifact) => artifact.type === "loop_consequence")?.id;

  await startLongChat();
  const approve = await fetch(`${base}/cron/runs/${encodeURIComponent(gated.id)}/approve`, {
    method: "POST",
    headers: operatorHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ decision: "approve_once", fingerprint }),
  });
  assert.equal(approve.status, 200);
  await waitUntil(async () => {
    const response = await fetch(`${base}/cron/runs?job=${encodeURIComponent(job.id)}`, { headers: { cookie } });
    const body = await response.json();
    return body.runs[0]?.approvalPending === true;
  });

  const auditFile = path.join(HOME, ".claude", "agenthost", "audit.log");
  const auditLinesBeforeRestart = fs.readFileSync(auditFile, "utf8").split("\n").filter(Boolean).length;
  await stopGate();
  await bootGate();
  let lastReconciled = null;
  let reconciled;
  try {
    reconciled = await waitUntil(async () => {
      const response = await fetch(`${base}/runs/${encodeURIComponent(gated.id)}`, { headers: { cookie } });
      if (response.status !== 200) return null;
      const body = await response.json();
      lastReconciled = body.run;
      if (body.run?.status === "completed") return body.run;
      if (body.run?.status === "gated"
        && /expired|restart/i.test(body.run.summary || "")
        && !body.run.artifacts.some((artifact) => artifact.type === "loop_approval")) return body.run;
      return null;
    });
  } catch (error) {
    const history = await (await fetch(`${base}/cron/runs?job=${encodeURIComponent(job.id)}`, { headers: { cookie } })).json();
    error.message += `; last reconciled state was ${JSON.stringify(lastReconciled)}; run projection was ${JSON.stringify(history)}`;
    throw error;
  }
  assert.equal(reconciled.id, gated.id, "restart reconciliation keeps the exact scheduled run identity");
  const restartAudit = fs.readFileSync(auditFile, "utf8").split("\n").filter(Boolean)
    .slice(auditLinesBeforeRestart).map((line) => JSON.parse(line));
  assert.ok(restartAudit.some((entry) => entry.event === "cron_approval_rejected" || entry.event === "cron_approval_consumed"),
    "startup reconciliation records whether the durable grant was cleared or consumed after audit initialization");
  assert.ok(startCount(marker) <= 1, "restart reconciliation can never launch the same approved run twice");
  if (reconciled.status === "completed") {
    assert.equal(startCount(marker), 1, "a still-fresh durable grant is reconstructed and consumed once");
  } else {
    assert.equal(startCount(marker), 0, "an expired or restart-cleared grant launches nothing");
    const history = await (await fetch(`${base}/cron/runs?job=${encodeURIComponent(job.id)}`, { headers: { cookie } })).json();
    assert.equal(history.runs[0].approvalPending, false, "the UI never shows an orphaned pending grant after restart");
  }
});
