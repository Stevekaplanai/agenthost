// Durable chat runs are owned by the box, not by an SSE connection. These tests
// boot the real gate with a portable fake agent and prove the three boundaries
// that matter on a phone:
//   1. disconnecting mid-reply does not cancel or duplicate the run;
//   2. explicit Cancel does stop the run;
//   3. a gateway restart reports an interrupted run honestly on reconnect.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { mintOperatorSession } from "./operator-session-helper.js";

const GATE = path.join(import.meta.dirname, "..", "container", "gate.js");
const CHAT_LIVE = path.join(import.meta.dirname, "..", "dashboard", "lib", "live.ts");
const THREAD_RAIL = path.join(import.meta.dirname, "..", "dashboard", "components", "agenthost", "thread-rail.tsx");
const WORKSPACE_CHAT = path.join(import.meta.dirname, "..", "dashboard", "components", "agenthost", "workspace-chat.tsx");
const KEY = "gate-durable-test-key";

let HOME;
let gate;
let base;
let cookie;

test("Cancel shows the stopping state and preserves the gate's exact outcome", () => {
  const live = fs.readFileSync(CHAT_LIVE, "utf8");
  const rail = fs.readFileSync(THREAD_RAIL, "utf8");
  const workspace = fs.readFileSync(WORKSPACE_CHAT, "utf8");
  assert.match(rail, /onClick=\{\(\) => setCancelReviewOpen\(true\)\}/,
    "the generated thread opens the stop review before cancelling work");
  assert.match(workspace, /\{busy \? "Stopping[^"]*" : "Confirm stop"\}/,
    "the confirmation distinguishes an in-flight stop request");
  assert.match(live, /localFinish\(result\.summary\)/,
    "the durable gate's exact cancellation outcome reaches the local run");
  assert.match(live, /error: result\.summary, body: message\.body \|\| result\.summary/,
    "a reloaded device also renders the gate's named outcome instead of guessing");
});
let startsFile;

function sseEvents(text) {
  return text.split("\n\n").map((block) => {
    let event = "message";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) data += line.slice(6);
    }
    return { event, data };
  }).filter((e) => e.data !== "");
}

function streamedText(events) {
  return events.filter((e) => e.event === "message").map((e) => JSON.parse(e.data)).join("");
}

function teamStreamedText(events) {
  return events
    .filter((e) => e.event === "engine_delta" || e.event === "message")
    .map((e) => {
      const parsed = JSON.parse(e.data);
      return e.event === "engine_delta" ? parsed.t : parsed;
    })
    .join("");
}

function countStarts(needle) {
  return fs.readFileSync(startsFile, "utf8").split("\n").filter(Boolean)
    .map((line) => JSON.parse(line).prompt)
    .filter((prompt) => prompt.includes(needle)).length;
}

async function renameFixture(from, to) {
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(from, to); return; }
    catch (error) {
      const retryable = process.platform === "win32" && (error.code === "EPERM" || error.code === "EACCES") && attempt < 5;
      if (!retryable) throw error;
      await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
    }
  }
}

async function bootGate() {
  const proc = spawn("node", [GATE], {
    env: {
      ...process.env,
      HOME,
      TTYD_PASSWORD: KEY,
      AGENT_CHAT_BIN: "fake-claude",
      // The real 37KB charter rides argv and blows Windows' ~32K command-line
      // limit, killing every spawn with ENAMETOOLONG before the engine runs.
      // These tests are about run durability, not charter content.
      AGENT_CHARTER_FILE: path.join(HOME, "charter.md"),
      AGENTHOST_DEV_WRAP: path.join(HOME, "durable-agent.mjs"),
      DURABLE_STARTS_FILE: startsFile,
      WAKE_CHECKIN: "off",
      GATE_PORT: "0",
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const port = await new Promise((resolve, reject) => {
    let out = "";
    const to = setTimeout(() => reject(new Error("gate did not report its port; got: " + out)), 5000);
    proc.stdout.on("data", (c) => {
      out += c.toString();
      const m = out.match(/listening on (\d+)/);
      if (m) { clearTimeout(to); resolve(Number(m[1])); }
    });
    proc.on("exit", () => { clearTimeout(to); reject(new Error("gate exited before listening; got: " + out)); });
  });
  const nextBase = `http://127.0.0.1:${port}`;
  const { cookie: nextCookie } = await mintOperatorSession(nextBase, KEY);
  gate = proc;
  base = nextBase;
  cookie = nextCookie;
}

async function stopGate() {
  if (!gate || gate.exitCode !== null) return;
  const exited = new Promise((resolve) => gate.once("exit", resolve));
  gate.kill("SIGKILL");
  await exited;
}

async function gracefulStopGate(signal = "SIGTERM") {
  if (!gate || gate.exitCode !== null) return;
  const proc = gate;
  const exited = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`gate did not exit after ${signal}`)), 5000);
    proc.once("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  proc.kill(signal);
  return exited;
}

async function startAndDisconnect(id, msg, { engine = "claude", waitFor = "first:" } = {}) {
  const controller = new AbortController();
  const response = await fetch(`${base}/chat/stream?run=${id}&engine=${engine}&msg=${encodeURIComponent(msg)}`, {
    headers: { cookie }, signal: controller.signal,
  });
  const reader = response.body.getReader();
  const dec = new TextDecoder();
  let text = "";
  while (!text.includes(waitFor)) {
    const { value, done } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
  }
  assert.ok(text.includes(waitFor), `the stream reached ${waitFor} before the phone disconnected`);
  controller.abort();
  try { await reader.cancel(); } catch {}
}

async function startAndDisconnectAtHeaders(id, msg) {
  const controller = new AbortController();
  const response = await fetch(`${base}/chat/stream?run=${id}&msg=${encodeURIComponent(msg)}`, {
    headers: { cookie }, signal: controller.signal,
  });
  assert.equal(response.status, 200);
  controller.abort();
  try { await response.body.cancel(); } catch {}
}

async function waitForStatus(id, wanted, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const response = await fetch(`${base}/chat/runs/${id}`, { headers: { cookie } });
    if (response.ok) {
      const body = await response.json();
      if (wanted.includes(body.status)) return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`run ${id} did not reach ${wanted.join("|")}`);
}

async function ledgerRun(id) {
  const response = await fetch(`${base}/runs/${encodeURIComponent(id)}`, { headers: { cookie } });
  assert.equal(response.status, 200);
  return response.json();
}

async function replay(id) {
  const response = await fetch(`${base}/chat/stream?run=${id}`, { headers: { cookie } });
  assert.equal(response.status, 200);
  return sseEvents(await response.text());
}

before(async () => {
  HOME = fs.mkdtempSync(path.join(import.meta.dirname, ".gatedurable-"));
  fs.mkdirSync(path.join(HOME, "work"), { recursive: true });
  fs.mkdirSync(path.join(HOME, "knowledge"), { recursive: true });
  fs.writeFileSync(path.join(HOME, "knowledge", "always-on.md"), "durablephoenix means the phone is only a viewer\n");
  fs.mkdirSync(path.join(HOME, ".agenthost"), { recursive: true });
  fs.writeFileSync(path.join(HOME, ".agenthost", "settings.json"), JSON.stringify({
    llm: { roster: {
      claude: { active: true, inChat: true },
      hermes: { active: false, inChat: false },
      codex: { active: false, inChat: false },
      gemini: { active: false, inChat: false },
    } },
  }));
  fs.writeFileSync(path.join(HOME, "charter.md"), "# Team charter (durability tests)\nBe excellent.\n");
  startsFile = path.join(HOME, "starts.log");
  fs.writeFileSync(startsFile, "");
  fs.writeFileSync(path.join(HOME, "durable-agent.mjs"), [
    'import fs from "node:fs";',
    'const args = process.argv.slice(3);',
    'const at = args.indexOf("-p");',
    'const prompt = at === -1 ? "" : args[at + 1];',
    'fs.appendFileSync(process.env.DURABLE_STARTS_FILE, JSON.stringify({prompt}) + "\\n");',
    'const emit = (text) => process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"content_block_delta",delta:{type:"text_delta",text}}})+"\\n");',
    'emit("first:" + prompt);',
    'await new Promise((resolve) => setTimeout(resolve, prompt.includes("SLOWRUN") ? 2500 : prompt.includes("LONG") ? 700 : 450));',
    'emit("|last");',
    'process.stdout.write(JSON.stringify({type:"result",total_cost_usd:0,usage:{input_tokens:1,output_tokens:1}})+"\\n");',
    "",
  ].join("\n"));
  await bootGate();
});

after(async () => {
  await stopGate();
  if (HOME) fs.rmSync(HOME, { recursive: true, force: true });
});

test("phone disconnect detaches while the box finishes exactly one run", async () => {
  const id = "detachrun001";
  await startAndDisconnect(id, "finish after disconnect");
  const state = await waitForStatus(id, ["completed"]);
  assert.equal(state.summary, "Chat run completed.");
  assert.deepEqual(state.next_actions, []);

  const events = await replay(id);
  assert.equal(streamedText(events), "first:finish after disconnect|last", "reconnect replays the complete answer");
  const done = events.find((e) => e.event === "done");
  assert.equal(JSON.parse(done.data).error, undefined, "detached run completed cleanly");
  assert.equal(countStarts("finish after disconnect"), 1,
    "reconnecting did not start the prompt a second time");

  const usageResponse = await fetch(`${base}/usage?tz=0`, { headers: { cookie } });
  assert.equal(usageResponse.status, 200);
  const usage = await usageResponse.json();
  assert.equal(usage.engines.claude.turns, 1, "usage finalizes even with no phone attached");
  assert.equal(usage.engines.claude.in, 1);
  assert.equal(usage.engines.claude.out, 1);

  const ledger = await ledgerRun(id);
  assert.equal(ledger.status, "success", "API health is separate from the nested run state");
  assert.equal(ledger.run.kind, "chat");
  assert.equal(ledger.run.status, "completed");
  assert.deepEqual(ledger.run.engines, ["claude"]);
  assert.equal(typeof ledger.run.createdAt, "number");
  assert.equal(typeof ledger.run.finishedAt, "number");
  assert.doesNotMatch(fs.readFileSync(path.join(HOME, ".claude", "agenthost", "runs", "runs.jsonl"), "utf8"), /finish after disconnect/,
    "the run ledger stores a redacted observation, never the raw prompt");
});

test("a queued message survives disconnect and executes exactly once", async () => {
  const blockerId = "queueblock001";
  const queuedId = "queuedrun001";
  await startAndDisconnect(blockerId, "LONG hold the slot");
  await startAndDisconnect(queuedId, "queued after phone left", { waitFor: "queued" });

  const queued = await waitForStatus(queuedId, ["queued"]);
  assert.equal(queued.startedAt, null, "the second run is durably waiting for the slot");
  const queuedLedger = await ledgerRun(queuedId);
  assert.equal(queuedLedger.run.status, "queued");
  await waitForStatus(blockerId, ["completed"]);
  await waitForStatus(queuedId, ["completed"]);

  const events = await replay(queuedId);
  assert.equal(streamedText(events), "first:queued after phone left|last");
  assert.equal(countStarts("queued after phone left"), 1, "detaching while queued did not drop or duplicate the request");
});

test("Team Chat keeps every active engine running after the phone disconnects", async () => {
  const id = "teamdetach001";
  const marker = "TEAMDETACH durable round";
  await startAndDisconnect(id, marker, { engine: "team" });
  await waitForStatus(id, ["completed"]);

  const events = await replay(id);
  assert.match(teamStreamedText(events), /TEAMDETACH durable round/);
  assert.ok(events.some((e) => e.event === "engine_done" && JSON.parse(e.data).eng === "claude"));
  assert.ok(events.some((e) => e.event === "done"));
  assert.equal(countStarts(marker), 1, "the detached team segment ran once");

  const threadFile = path.join(HOME, ".claude", "agenthost", "team-thread.jsonl");
  const thread = fs.readFileSync(threadFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(thread.some((entry) => entry.who === "steve" && entry.text === marker));
  assert.ok(thread.some((entry) => entry.who === "claude" && entry.text.includes(marker)),
    "the box finalized team history without a subscriber");
  const ledger = await ledgerRun(id);
  assert.equal(ledger.run.kind, "team_chat");
  assert.equal(ledger.run.status, "completed");
});

test("Brain search survives a disconnect before its answer starts", async () => {
  const id = "braindetach01";
  const marker = "durablephoenix";
  await startAndDisconnectAtHeaders(id, `/brain ${marker}`);
  await waitForStatus(id, ["completed"]);

  const events = await replay(id);
  assert.match(streamedText(events), /phone is only a viewer/);
  assert.equal(countStarts(marker), 1, "the detached brain answer ran once");
  const ledger = await ledgerRun(id);
  assert.equal(ledger.run.kind, "brain");
  assert.equal(ledger.run.status, "completed");
});

test("explicit Cancel stops a detached run and returns a recoverable result", async () => {
  const id = "cancelrun001";
  // SLOWRUN (2500ms), not LONG (700ms): the assertion is that Cancel kills the
  // child BEFORE its natural finish, so the window must be wider than the
  // cancel round-trip. On Windows the kill lands in ~1s (process spin-up +
  // fetch + taskkill), which LOST the 700ms race every run -- the child
  // finished naturally and the test read that as "Cancel failed to kill".
  await startAndDisconnect(id, "SLOWRUN cancel me");
  const response = await fetch(`${base}/chat/runs/${id}/cancel`, { method: "POST", headers: { cookie, origin: base } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "warning",
    summary: "Cancellation requested; AgentHost is waiting for the agent to confirm it stopped.",
    next_actions: [],
    artifacts: [{ type: "chat_run", id }],
  });
  await waitForStatus(id, ["cancelled"]);
  // Wait past the fake agent's natural finish time. If Cancel only changed the
  // label but failed to kill the child, its final chunk would now be persisted.
  await new Promise((resolve) => setTimeout(resolve, 2650));

  const events = await replay(id);
  assert.equal(streamedText(events), "first:SLOWRUN cancel me", "the killed process never emitted its final chunk");
  const done = events.find((e) => e.event === "done");
  assert.match(JSON.parse(done.data).error, /cancelled/i);
  assert.equal((await ledgerRun(id)).run.status, "cancelled");
});

test("gateway restart marks a detached in-flight run interrupted instead of pretending success", async () => {
  const id = "restartrun001";
  await startAndDisconnect(id, "SLOWRUN during this run");
  await stopGate();
  await bootGate();

  const state = await waitForStatus(id, ["interrupted"]);
  assert.match(state.summary, /restarted/i);
  assert.deepEqual(state.next_actions, [{ id: "retry", label: "Run again" }]);
  const events = await replay(id);
  const done = events.find((e) => e.event === "done");
  const meta = JSON.parse(done.data);
  assert.match(meta.error, /restarted/i);
  assert.equal(meta.recovery, "retry");
  const ledger = await ledgerRun(id);
  assert.equal(ledger.status, "warning");
  assert.equal(ledger.run.status, "interrupted");
});

test("SIGTERM checkpoints an active run before the gateway exits", { skip: process.platform === "win32" }, async () => {
  const id = "sigtermrun01";
  await startAndDisconnect(id, "SLOWRUN checkpoint on signal");
  const result = await gracefulStopGate();
  assert.deepEqual(result, { code: 0, signal: null }, "ordinary shutdown remains a clean exit");

  const meta = JSON.parse(fs.readFileSync(path.join(HOME, ".claude", "agenthost", "chat-runs", id + ".json"), "utf8"));
  assert.equal(meta.status, "interrupted", "the chat store is terminal before the next process starts");
  const ledgerRows = fs.readFileSync(path.join(HOME, ".claude", "agenthost", "runs", "runs.jsonl"), "utf8")
    .split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((event) => event.runId === id);
  assert.equal(ledgerRows.at(-1).run.status, "interrupted", "the universal ledger is terminal before reboot recovery");

  await bootGate();
  assert.equal((await ledgerRun(id)).run.status, "interrupted");
});

test("SIGUSR2 checkpoints an active run and exits 1 so the platform restarts the box", { skip: process.platform === "win32" }, async () => {
  const id = "memoryrun001";
  await startAndDisconnect(id, "SLOWRUN checkpoint on memory pressure");
  const result = await gracefulStopGate("SIGUSR2");
  assert.deepEqual(result, { code: 1, signal: null }, "memory pressure requests a platform restart");

  const meta = JSON.parse(fs.readFileSync(path.join(HOME, ".claude", "agenthost", "chat-runs", id + ".json"), "utf8"));
  assert.equal(meta.status, "interrupted", "the chat store checkpoints before the non-zero exit");
  const ledgerRows = fs.readFileSync(path.join(HOME, ".claude", "agenthost", "runs", "runs.jsonl"), "utf8")
    .split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((event) => event.runId === id);
  assert.equal(ledgerRows.at(-1).run.status, "interrupted", "the universal ledger checkpoints before restart");

  await bootGate();
  assert.equal((await ledgerRun(id)).run.status, "interrupted");
});

test("a gated consequential chat turn terminalizes the run-ledger instead of stranding it at queued", async () => {
  const id = "gatedledger01";
  const res = await fetch(`${base}/chat/stream?run=${id}&engine=claude&msg=${encodeURIComponent("delete the production bucket now")}`, { headers: { cookie } });
  const body = await res.text(); // gate streams the warning + done, then closes -- no agent runs
  assert.match(body, /consequential action/i, "the gate warning streams to the viewport");
  assert.match(body, /"gated":true/, "the done frame marks the turn gated");
  const chat = await waitForStatus(id, ["completed"]);
  assert.equal(chat.status, "completed", "chat store terminalizes");
  const led = await ledgerRun(id);
  assert.notEqual(led.run.status, "queued", "a gated turn must not strand the ledger at queued");
  assert.ok(["completed", "skipped"].includes(led.run.status), `ledger must terminalize, got ${led.run.status}`);
});

test("a run is refused when its durable record cannot be created", async () => {
  const id = "persistfail01";
  const marker = "MUST NOT START without persistence";
  const runsDir = path.join(HOME, ".claude", "agenthost", "chat-runs");
  const savedDir = runsDir + ".saved";
  await renameFixture(runsDir, savedDir);
  fs.writeFileSync(runsDir, "this file deliberately blocks mkdir");
  try {
    const response = await fetch(`${base}/chat/stream?run=${id}&msg=${encodeURIComponent(marker)}`, { headers: { cookie } });
    const events = sseEvents(await response.text());
    const done = events.find((e) => e.event === "done");
    assert.ok(done, "the client receives a terminal persistence error");
    assert.match(JSON.parse(done.data).error, /persist/i);
    assert.equal(countStarts(marker), 0, "the agent never starts without a durable run record");
    const status = await fetch(`${base}/chat/runs/${id}`, { headers: { cookie } });
    assert.equal(status.status, 404, "an unpersisted request is not advertised as a run");
    const ledger = await ledgerRun(id);
    assert.equal(ledger.status, "warning");
    assert.equal(ledger.run.status, "failed", "the universal history explains why no work began");
  } finally {
    fs.unlinkSync(runsDir);
    await renameFixture(savedDir, runsDir);
  }
});
