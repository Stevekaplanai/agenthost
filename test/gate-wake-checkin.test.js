// E2E tests against the REAL gate.js for the boot wake-up check-in (Steve
// 2026-07-19): after a gateway reboot, each chat engine runs one turn and posts
// a short "waking up — <engine>" check-in into the persisted team thread, so
// opening chat shows who woke, when, and what it thinks it missed.
//
// Boots gates on ephemeral ports (GATE_PORT=0, port read from the log line,
// same pattern as gate-chat-busy.test.js). Engines are mocked through the
// existing AGENTHOST_DEV_WRAP seam (the dev-local wrapper: every engine spawn
// becomes `node <wrapper> <bin> <...args>`), which works on Windows too --
// the wrapper detects which engine it stands in for and emits that engine's
// exact stdout shape, replying "waking up — <eng>" as instructed.
// WAKE_CHECKIN_DELAY_MS shrinks the 60s warmup to milliseconds (test seam,
// same family as GATE_PORT).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { stopChild } from "./child-process-helper.js";
import { mintOperatorSession } from "./operator-session-helper.js";

const SOURCE_CONTAINER = path.join(import.meta.dirname, "..", "container");
let GATE = path.join(SOURCE_CONTAINER, "gate.js");
let gateFixtureRoot;
const KEY = "gate-wake-test-key";
const ORDER = ["claude", "codex", "hermes"];

const boxes = { on: {}, off: {}, legal: {} };

// The wake mock: impersonates whichever engine the gate meant to spawn and
// answers the wake prompt in that engine's stdout shape. Also logs the prompt
// it received to wake-mock.log so the test can assert the prompt's contract.
const MOCK = `
import fs from "node:fs";
import path from "node:path";
const all = process.argv.slice(2);
const bin = path.basename(String(all[0] || "")).toLowerCase();
const argv = all.slice(1);
let eng = "claude";
if (bin.includes("codex")) eng = "codex";
else if (bin.includes("gemini")) eng = "gemini";
else if (bin.includes("hermes")) eng = "hermes";
else if (bin.includes("cursor-agent")) eng = "cursor";
const prompt = argv.find((a) => a.includes("WAKE-UP CHECK-IN")) || argv.join(" ");
const isWake = prompt.includes("WAKE-UP CHECK-IN");
const kind = isWake ? "wake" : "chat";
const traceFile = path.join(process.env.HOME, "wake-trace.log");
try {
  fs.appendFileSync(path.join(process.env.HOME, "wake-mock.log"), JSON.stringify({ eng, prompt }) + "\\n");
  fs.appendFileSync(traceFile, JSON.stringify({ phase: "start", kind, eng, prompt }) + "\\n");
} catch {}
if (isWake && eng === "claude" && process.env.WAKE_MOCK_FIRST_DELAY_MS) {
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.WAKE_MOCK_FIRST_DELAY_MS)));
}
const reply = isWake
  ? "waking up — " + eng + "\\nnothing missed."
  : "human complete: " + (prompt.includes("HUMAN_PRIORITY_PROBE") ? "HUMAN_PRIORITY_PROBE" : eng);
if (eng === "claude") {
  process.stdout.write(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: reply } } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", total_cost_usd: 0, usage: { input_tokens: 5, output_tokens: 5 } }) + "\\n");
} else if (eng === "codex") {
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "wake-thread" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: reply } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 5, output_tokens: 5 } }) + "\\n");
} else if (eng === "gemini") {
  process.stdout.write(JSON.stringify({ response: reply, stats: {} }) + "\\n");
} else {
  process.stdout.write(reply + "\\n");
}
try { fs.appendFileSync(traceFile, JSON.stringify({ phase: "finish", kind, eng, prompt }) + "\\n"); } catch {}
process.exit(0);
`;

function bootGate(home, extraEnv) {
  const child = spawn("node", [GATE], {
    env: {
      ...process.env,
      HOME: home,
      TTYD_PASSWORD: KEY,
      GATE_PORT: "0",
      AGENTHOST_DEV_WRAP: path.join(home, "wake-mock.mjs"),
      WAKE_CHECKIN_DELAY_MS: "150",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const port = new Promise((resolve, reject) => {
    let out = "";
    const to = setTimeout(() => reject(new Error("gate did not report its port; got: " + out)), 5000);
    child.stdout.on("data", (c) => {
      out += c.toString();
      const m = out.match(/listening on (\d+)/);
      if (m) { clearTimeout(to); resolve(Number(m[1])); }
    });
    child.on("exit", () => { clearTimeout(to); reject(new Error("gate exited before listening; got: " + out)); });
  });
  return { child, port };
}

function makeHome(tag) {
  const home = fs.mkdtempSync(path.join(import.meta.dirname, ".gatewake-" + tag + "-"));
  fs.mkdirSync(path.join(home, "work"), { recursive: true });
  fs.writeFileSync(path.join(home, "wake-mock.mjs"), MOCK);
  return home;
}

function threadFile(home) { return path.join(home, ".claude", "agenthost", "team-thread.jsonl"); }
function auditFile(home) { return path.join(home, ".claude", "agenthost", "audit.log"); }
function readJsonl(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
async function waitFor(fn, ms, what) {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error("timed out waiting for " + what);
    await new Promise((r) => setTimeout(r, 200));
  }
}

function sseEvents(text) {
  return text.split("\n\n").map((block) => {
    let event = "message";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) data += line.slice(6);
    }
    return { event, data };
  }).filter((event) => event.data !== "");
}

before(async () => {
  // The production charter is intentionally large. Passing it as argv through
  // the Windows-only dev wrapper can exceed Windows' command-line ceiling, so
  // run the exact gate code from a copied fixture with a short test charter.
  gateFixtureRoot = fs.mkdtempSync(path.join(import.meta.dirname, ".gatewake-fixture-"));
  const fixtureContainer = path.join(gateFixtureRoot, "container");
  fs.cpSync(SOURCE_CONTAINER, fixtureContainer, { recursive: true });
  fs.writeFileSync(path.join(fixtureContainer, "team-charter.md"), "# Wake test charter\n");
  GATE = path.join(fixtureContainer, "gate.js");
  for (const [tag, extra] of [
    ["on", {}],
    ["off", { WAKE_CHECKIN: "off" }],
    ["legal", { LEGAL_MODE: "api" }],
  ]) {
    const home = makeHome(tag);
    const { child, port } = bootGate(home, extra);
    boxes[tag] = { home, gate: child, base: `http://127.0.0.1:${await port}` };
  }
  boxes.on.cookie = (await mintOperatorSession(boxes.on.base, KEY)).cookie;
});

after(async () => {
  for (const b of Object.values(boxes)) {
    await stopChild(b.gate, "SIGKILL");
    if (b.home) fs.rmSync(b.home, { recursive: true, force: true });
  }
  if (gateFixtureRoot) fs.rmSync(gateFixtureRoot, { recursive: true, force: true });
});

test("a delayed wake engine yields to one human chat before the next wake engine", { timeout: 30000 }, async () => {
  const home = makeHome("priority");
  const traceFile = path.join(home, "wake-trace.log");
  const marker = "HUMAN_PRIORITY_PROBE";
  const { child, port } = bootGate(home, {
    WAKE_CHECKIN_DELAY_MS: "50",
    WAKE_MOCK_FIRST_DELAY_MS: "2500",
  });

  try {
    const base = `http://127.0.0.1:${await port}`;
    const { cookie } = await mintOperatorSession(base, KEY);

    await waitFor(() => readJsonl(traceFile).some((entry) =>
      entry.phase === "start" && entry.kind === "wake" && entry.eng === "claude"), 5000,
    "the delayed first wake engine to start");

    const response = await fetch(
      `${base}/chat/stream?run=wakepriority001&engine=claude&msg=${encodeURIComponent(marker)}`,
      { headers: { cookie } },
    );
    const events = sseEvents(await response.text());
    const status = events.find((event) => event.event === "status");
    assert.ok(status, "the human sees an immediate queued status");
    assert.deepEqual(JSON.parse(status.data), {
      text: "agent is busy — the team is waking up; your message is queued",
      holder: "wake",
    }, "the status truthfully identifies the wake round as the holder");
    assert.equal(events.filter((event) => event.event === "message")
      .map((event) => JSON.parse(event.data)).join(""), `human complete: ${marker}`);
    assert.equal(events.filter((event) => event.event === "done").length, 1,
      "the human run emits exactly one completion");

    await waitFor(() => {
      const rows = readJsonl(path.join(home, ".claude", "agenthost", "runs", "runs.jsonl"))
        .filter((entry) => entry.run && entry.run.kind === "wake_check");
      return rows.at(-1)?.run?.status === "completed" ? rows : null;
    }, 20000, "the wake round to complete after yielding");

    const trace = readJsonl(traceFile);
    const wakeClaudeFinish = trace.findIndex((entry) =>
      entry.phase === "finish" && entry.kind === "wake" && entry.eng === "claude");
    const humanStarts = trace.map((entry, index) => ({ entry, index })).filter(({ entry }) =>
      entry.phase === "start" && entry.kind === "chat" && entry.prompt.includes(marker));
    const humanFinishes = trace.map((entry, index) => ({ entry, index })).filter(({ entry }) =>
      entry.phase === "finish" && entry.kind === "chat" && entry.prompt.includes(marker));
    const wakeNextStart = trace.findIndex((entry) =>
      entry.phase === "start" && entry.kind === "wake" && entry.eng === "codex");

    assert.notEqual(wakeClaudeFinish, -1, "the delayed first wake engine finishes");
    assert.equal(humanStarts.length, 1, "the queued human prompt starts exactly once");
    assert.equal(humanFinishes.length, 1, "the queued human prompt finishes exactly once");
    assert.notEqual(wakeNextStart, -1, "the next wake engine still starts");
    assert.ok(wakeClaudeFinish < humanStarts[0].index,
      "the human starts after the first wake engine releases its slot");
    assert.ok(humanFinishes[0].index < wakeNextStart,
      "the human finishes before the next wake engine starts");
    assert.deepEqual(readJsonl(threadFile(home)).filter((entry) => entry.wake === true)
      .map((entry) => entry.who), ORDER, "the yielded wake round still completes every eligible engine");
  } finally {
    await stopChild(child, "SIGKILL");
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("every wake-eligible engine posts a check-in serially in TEAM_ORDER", async () => {
  const entries = await waitFor(() => {
    const got = readJsonl(threadFile(boxes.on.home)).filter((e) => e.wake === true);
    return got.length >= ORDER.length ? got : null;
  }, 20000, "3 wake entries in team-thread.jsonl");

  assert.deepEqual(entries.map((e) => e.who), ORDER, "one check-in per engine, in TEAM_ORDER");
  for (const e of entries) {
    assert.equal(e.text.split("\n")[0], "waking up — " + e.who, "first line is the exact check-in format");
    assert.ok(Number.isFinite(e.at) && e.at > 0, "entry is timestamped");
  }
});

test("the unattended wake round skips provider inference and Cursor", async () => {
  const audit = await waitFor(() => {
    const got = readJsonl(auditFile(boxes.on.home));
    return got.filter((entry) => entry.event === "wake_skip").length >= 4 ? got : null;
  }, 20000, "provider and Cursor wake_skip audit events");
  const skips = audit.filter((entry) => entry.event === "wake_skip");
  assert.deepEqual(skips.map((entry) => entry.eng), ["deepseek", "kimi", "gemini", "cursor"]);
  for (const entry of skips.filter((entry) => entry.eng !== "cursor")) {
    assert.match(entry.detail, /provider wake inference disabled to avoid unattended spend/,
      `${entry.eng} names why no paid wake inference was started`);
  }
  const invoked = readJsonl(path.join(boxes.on.home, "wake-mock.log")).map((entry) => entry.eng);
  assert.equal(invoked.includes("cursor"), false, "boot never invokes cursor-agent");
});

test("the wake prompt embeds the check-in contract (chat scan, board check, exact first line)", async () => {
  const prompts = await waitFor(() => {
    const got = readJsonl(path.join(boxes.on.home, "wake-mock.log"));
    return got.length >= ORDER.length ? got : null;
  }, 20000, "3 wake prompts logged by the mock");
  for (const p of prompts) {
    assert.match(p.prompt, /WAKE-UP CHECK-IN/, "prompt names the situation");
    assert.match(p.prompt, /RECENT TEAM CHAT/, "prompt embeds the recent chat");
    assert.match(p.prompt, /check the shared board/, "prompt asks for the board check");
    assert.ok(p.prompt.includes('"waking up — ' + p.eng + '"'), "prompt pins the exact first line for " + p.eng);
  }
});

test("boot_wake + per-engine wake_checkin land in the audit log", async () => {
  const audit = await waitFor(() => {
    const got = readJsonl(auditFile(boxes.on.home));
    return got.filter((e) => e.event === "wake_checkin").length >= ORDER.length ? got : null;
  }, 20000, "wake audit events");
  assert.equal(audit.filter((e) => e.event === "boot_wake").length, 1, "exactly one boot event per boot");
  const checkins = audit.filter((e) => e.event === "wake_checkin");
  assert.deepEqual(checkins.map((e) => e.eng), ORDER, "one wake_checkin per engine, attributed via the eng field");
  for (const e of checkins) assert.match(e.detail, /^waking up — /, "audit detail carries the check-in first line");
});

test("GET /chat/wake serves the check-ins to the chat client (cookie-gated)", async () => {
  // Entries exist by now (first test waited for them).
  const r = await fetch(`${boxes.on.base}/chat/wake`, { headers: { cookie: boxes.on.cookie } });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.deepEqual(d.entries.map((e) => e.who), ORDER);
  for (const e of d.entries) {
    assert.match(e.text, /^waking up — /);
    assert.ok(e.at > 0, "client gets the timestamp");
  }
  // No cookie -> no wake data (the thread is private).
  const anon = await fetch(`${boxes.on.base}/chat/wake`, { redirect: "manual" });
  assert.notEqual(anon.status, 200, "unauthenticated request does not get the thread");
});

test("WAKE_CHECKIN=off and the legal brand never run check-ins", async () => {
  // The "on" box has long since finished its round (asserted above); these two
  // boots share its timeline, so by now a scheduled round would have fired.
  await new Promise((r) => setTimeout(r, 500));
  for (const tag of ["off", "legal"]) {
    const wakes = readJsonl(threadFile(boxes[tag].home)).filter((e) => e.wake === true);
    assert.equal(wakes.length, 0, tag + " box posted no wake entries");
    const audit = readJsonl(auditFile(boxes[tag].home));
    assert.ok(!audit.some((e) => e.event === "boot_wake"), tag + " box audited no boot_wake");
  }
});
