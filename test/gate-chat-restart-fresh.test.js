// Regression proof for a gateway restart between two independent chat runs.
//
// The production charter is intentionally large. Passing it through the
// Windows dev-wrapper seam can exceed Windows' command-line limit, so this test
// boots an exact copy of the container with only the charter shortened.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stopChild } from "./child-process-helper.js";
import { mintOperatorSession } from "./operator-session-helper.js";

const SOURCE_CONTAINER = path.join(import.meta.dirname, "..", "container");
const KEY = "gate-restart-fresh-test-key";
const RUN_A = "restartold001";
const RUN_B = "restartfresh01";
const MARKER_A = "INTERRUPTED_RUN_A";
const MARKER_B = "CLEAN_RUN_B";

const MOCK_AGENT = `
import fs from "node:fs";
const args = process.argv.slice(3);
const promptAt = args.indexOf("-p");
const prompt = promptAt === -1 ? args.join(" ") : String(args[promptAt + 1] || "");
fs.appendFileSync(process.env.RESTART_FRESH_STARTS_FILE, JSON.stringify({ pid: process.pid, prompt }) + "\\n");
const emit = (text) => process.stdout.write(JSON.stringify({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "text_delta", text } },
}) + "\\n");
emit("started:" + (prompt.includes("${MARKER_A}") ? "${MARKER_A}" : "${MARKER_B}"));
if (prompt.includes("${MARKER_A}")) {
  const gatePid = process.ppid;
  for (let i = 0; i < 100; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    try { process.kill(gatePid, 0); } catch { process.exit(0); }
  }
} else {
  await new Promise((resolve) => setTimeout(resolve, 75));
}
emit("|completed");
process.stdout.write(JSON.stringify({
  type: "result",
  total_cost_usd: 0,
  usage: { input_tokens: 1, output_tokens: 1 },
}) + "\\n");
`;

function parseSse(text) {
  return text.split("\n\n").map((block) => {
    let event = "message";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) data += line.slice(6);
    }
    return { event, data };
  }).filter((entry) => entry.data !== "");
}

function readStarts(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function countStarts(file, marker) {
  return readStarts(file).filter((entry) => entry.prompt.includes(marker)).length;
}

async function bootGate(gateFile, home, startsFile) {
  const child = spawn(process.execPath, [gateFile], {
    env: {
      ...process.env,
      HOME: home,
      TTYD_PASSWORD: KEY,
      AGENT_CHAT_BIN: "fake-claude",
      AGENTHOST_DEV_WRAP: path.join(home, "restart-fresh-agent.mjs"),
      RESTART_FRESH_STARTS_FILE: startsFile,
      WAKE_CHECKIN: "off",
      GATE_PORT: "0",
      CHANNEL_DISPATCH_PORT: "0",
    },
    stdio: ["ignore", "pipe", "inherit"],
  });

  const port = await new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("gate did not report its port; got: " + output));
    }, 5000);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      const match = output.match(/listening on (\d+)/);
      if (!settled && match) {
        settled = true;
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.once("exit", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error("gate exited before listening; got: " + output));
    });
  });

  const base = `http://127.0.0.1:${port}`;
  const { cookie } = await mintOperatorSession(base, KEY);
  return { child, base, cookie };
}

async function waitForStatus(box, id, wanted, timeoutMs = 7000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${box.base}/chat/runs/${id}`, {
      headers: { cookie: box.cookie },
    });
    if (response.ok) {
      const body = await response.json();
      if (wanted.includes(body.status)) return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`run ${id} did not reach ${wanted.join("|")}`);
}

async function ledgerRun(box, id) {
  const response = await fetch(`${box.base}/runs/${id}`, {
    headers: { cookie: box.cookie },
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function replay(box, id) {
  const response = await fetch(`${box.base}/chat/stream?run=${id}`, {
    headers: { cookie: box.cookie },
  });
  assert.equal(response.status, 200);
  return parseSse(await response.text());
}

async function startUntil(box, id, marker) {
  const response = await fetch(
    `${box.base}/chat/stream?run=${id}&engine=claude&msg=${encodeURIComponent(marker)}`,
    { headers: { cookie: box.cookie } },
  );
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = "";
  while (!received.includes("started:" + marker)) {
    const { value, done } = await reader.read();
    if (done) break;
    received += decoder.decode(value, { stream: true });
  }
  assert.match(received, new RegExp("started:" + marker), "run reached the live agent before shutdown");
  return reader;
}

test("a fresh run after gateway restart is independent from the interrupted run", { timeout: 30000 }, async () => {
  assert.notEqual(RUN_A, RUN_B, "the two attempts use different durable identities");
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-restart-fresh-"));
  const fixtureContainer = path.join(fixtureRoot, "container");
  const home = path.join(fixtureRoot, "home");
  const startsFile = path.join(home, "starts.jsonl");
  let box = null;
  let firstReader = null;

  try {
    fs.cpSync(SOURCE_CONTAINER, fixtureContainer, { recursive: true });
    fs.writeFileSync(path.join(fixtureContainer, "team-charter.md"), "# Restart regression test charter\n");
    fs.mkdirSync(path.join(home, "work"), { recursive: true });
    fs.mkdirSync(path.join(home, ".agenthost"), { recursive: true });
    fs.writeFileSync(path.join(home, ".agenthost", "settings.json"), JSON.stringify({
      llm: { roster: {
        claude: { active: true, inChat: true },
        hermes: { active: false, inChat: false },
        codex: { active: false, inChat: false },
        gemini: { active: false, inChat: false },
        kimi: { active: false, inChat: false },
        cursor: { active: false, inChat: false },
      } },
    }));
    fs.writeFileSync(startsFile, "");
    fs.writeFileSync(path.join(home, "restart-fresh-agent.mjs"), MOCK_AGENT);
    const gateFile = path.join(fixtureContainer, "gate.js");

    box = await bootGate(gateFile, home, startsFile);
    firstReader = await startUntil(box, RUN_A, MARKER_A);
    assert.equal(countStarts(startsFile, MARKER_A), 1, "run A started exactly once before shutdown");
    assert.equal((await waitForStatus(box, RUN_A, ["running"])).next_actions.length, 0,
      "the live chat observation is running before the controlled shutdown");

    await stopChild(box.child, "SIGTERM");
    try { await firstReader.cancel(); } catch {}
    firstReader = null;

    box = await bootGate(gateFile, home, startsFile);
    const interruptedA = await waitForStatus(box, RUN_A, ["interrupted"]);
    assert.match(interruptedA.summary, /restarted/i);
    assert.deepEqual(interruptedA.next_actions, [{ id: "retry", label: "Run again" }]);

    const freshResponse = await fetch(
      `${box.base}/chat/stream?run=${RUN_B}&engine=claude&msg=${encodeURIComponent(MARKER_B)}`,
      { headers: { cookie: box.cookie } },
    );
    assert.equal(freshResponse.status, 200);
    const freshRaw = await freshResponse.text();
    const freshEvents = parseSse(freshRaw);
    const freshDone = freshEvents.filter((entry) => entry.event === "done");
    assert.equal(freshDone.length, 1, "fresh run B has exactly one terminal event");
    const freshDoneData = JSON.parse(freshDone[0].data);
    assert.equal(freshDoneData.error, undefined, "fresh run B has no inherited restart error");
    assert.equal(freshDoneData.recovery, undefined, "fresh run B has no inherited retry instruction");
    assert.doesNotMatch(freshRaw, /restarted|retry/i, "fresh run B's stream contains no restart warning");
    assert.equal(countStarts(startsFile, MARKER_B), 1, "fresh run B starts exactly once");

    const completedB = await waitForStatus(box, RUN_B, ["completed"]);
    assert.equal(completedB.summary, "Chat run completed.");
    assert.deepEqual(completedB.next_actions, []);
    assert.equal((await ledgerRun(box, RUN_B)).run.status, "completed");

    const stillInterruptedA = await waitForStatus(box, RUN_A, ["interrupted"]);
    assert.equal(stillInterruptedA.status, "interrupted", "run A remains interrupted after run B completes");
    assert.deepEqual(stillInterruptedA.next_actions, [{ id: "retry", label: "Run again" }]);
    const replayedA = await replay(box, RUN_A);
    const interruptedDone = replayedA.find((entry) => entry.event === "done");
    assert.ok(interruptedDone, "run A retains its interrupted terminal event");
    assert.match(JSON.parse(interruptedDone.data).error, /restarted/i);
    assert.equal((await ledgerRun(box, RUN_A)).run.status, "interrupted");
    assert.equal(countStarts(startsFile, MARKER_A), 1, "replay and fresh work never restart run A");
  } finally {
    if (firstReader) { try { await firstReader.cancel(); } catch {} }
    if (box) await stopChild(box.child, "SIGKILL");
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
