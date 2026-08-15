// Real-gate regression proof for the 4 GB box's Team Chat execution contract.
// The fixture copies the production container, replaces only its charter and
// watchdog durations, and routes every local engine through AGENTHOST_DEV_WRAP.
// This proves the production dispatcher itself -- not a recreated scheduler.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { stopChild } from "./child-process-helper.js";
import { mintOperatorSession } from "./operator-session-helper.js";

const CONTAINER = path.join(import.meta.dirname, "..", "container");
const KEY = "team-serialization-test-key";
const EXPECTED_ENGINES = ["claude", "codex", "deepseek", "kimi", "gemini", "hermes", "cursor"];
const EXPECTED_LOCAL_ENGINES = ["claude", "codex", "hermes", "cursor"];
const CHARTER_MARKER = "TEAM_SERIALIZATION_SHORT_CHARTER";

function sseEvents(text) {
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

function eventEngines(events, name) {
  return events.filter((entry) => entry.event === name)
    .map((entry) => JSON.parse(entry.data).eng);
}

function engineDeltas(events) {
  return events.filter((entry) => entry.event === "engine_delta")
    .map((entry) => JSON.parse(entry.data));
}

async function waitForPort(gate) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    const timer = setTimeout(
      () => reject(new Error("gate did not report its port; got: " + stdout)),
      8000,
    );
    gate.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const match = stdout.match(/listening on (\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    gate.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`gate exited before listening (${code}/${signal}); got: ${stdout}`));
    });
  });
}

async function readUntilEngineDone(response, engine) {
  assert.ok(response.body, "chat stream has a response body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`${engine} never completed before the stream closed: ${text}`);
    text += decoder.decode(value, { stream: true });
    if (eventEngines(sseEvents(text), "engine_done").includes(engine)) return { reader, text, decoder };
  }
}

async function drainStream({ reader, text, decoder }) {
  let body = text;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return body + decoder.decode();
    body += decoder.decode(value, { stream: true });
  }
}

async function waitForRunStatus(base, cookie, id, expected) {
  const deadline = Date.now() + 5000;
  let latest = null;
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/chat/runs/${id}`, { headers: { cookie } });
    assert.equal(response.status, 200);
    latest = await response.json();
    if (latest.status === expected) return latest;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`run ${id} stayed ${latest?.status || "unknown"}; expected ${expected}`);
}

function shortenWatchdog(fixtureGate) {
  const source = fs.readFileSync(fixtureGate, "utf8");
  const lifetime = "const AGENT_HARD_MAX_MS = 16 * 60 * 1000;";
  const interval = "}, 30 * 1000).unref();";
  assert.equal(source.split(lifetime).length - 1, 1, "fixture found the production lease lifetime");
  assert.equal(source.split(interval).length - 1, 1, "fixture found the production watchdog interval");
  fs.writeFileSync(
    fixtureGate,
    source.replace(lifetime, "const AGENT_HARD_MAX_MS = 4000;")
      .replace(interval, "}, 25).unref();"),
  );
}

function peakConcurrency(records) {
  let active = 0;
  let peak = 0;
  for (const record of records) {
    active += record.phase === "start" ? 1 : -1;
    assert.ok(active >= 0, `engine ${record.engine} ended before it started`);
    peak = Math.max(peak, active);
  }
  assert.equal(active, 0, "every wrapped engine exited");
  return peak;
}

test("API-first Team Chat persists every reply in full roster order", async () => {
  const root = fs.mkdtempSync(path.join(import.meta.dirname, ".gate-team-serial-"));
  const home = path.join(root, "home");
  const fixtureContainer = path.join(root, "container");
  const eventLog = path.join(root, "engine-events.jsonl");
  const wrapper = path.join(root, "team-engine.mjs");
  const fetchMock = path.join(root, "team-api-fetch.cjs");
  const apiEventLog = path.join(root, "api-events.jsonl");
  const secretsFile = path.join(root, "secrets.env");
  let gate;

  try {
    fs.mkdirSync(path.join(home, "work"), { recursive: true });
    fs.mkdirSync(path.join(home, ".agenthost"), { recursive: true });
    fs.writeFileSync(path.join(home, ".agenthost", "settings.json"), JSON.stringify({
      llm: {
        roster: {
          claude: { active: true, inChat: true },
          deepseek: { active: true, inChat: true },
          hermes: { active: true, inChat: true },
          codex: { active: true, inChat: true },
          gemini: { active: true, inChat: true },
          kimi: { active: true, inChat: true },
          cursor: { active: true, inChat: true },
        },
      },
      providers: { moonshot: { enabled: true } },
    }));
    fs.writeFileSync(eventLog, "");
    fs.writeFileSync(apiEventLog, "");
    fs.writeFileSync(secretsFile, "GEMINI_API_KEY=fake-gemini\nKIMI_API_KEY=fake-kimi\nDEEPSEEK_API_KEY=fake-deepseek\n");
    fs.writeFileSync(fetchMock, [
      'const fs = require("node:fs");',
      'const realFetch = globalThis.fetch;',
      `const logFile = ${JSON.stringify(apiEventLog)};`,
      'const record = (engine, phase) => fs.appendFileSync(logFile, JSON.stringify({ engine, phase, at: Date.now() }) + "\\n");',
      'const delay = (ms, signal, engine) => new Promise((resolve, reject) => {',
      '  const onAbort = () => { clearTimeout(timer); record(engine, "abort"); const error = new Error("aborted"); error.name = "AbortError"; reject(error); };',
      '  const timer = setTimeout(() => { if (signal) signal.removeEventListener("abort", onAbort); record(engine, "finish"); resolve(); }, ms);',
      '  record(engine, "start");',
      '  if (signal?.aborted) onAbort(); else signal?.addEventListener("abort", onAbort, { once: true });',
      '});',
      'globalThis.fetch = async (input, init) => {',
      '  const url = String(input);',
      '  if (url.includes("generativelanguage.googleapis.com")) {',
      '    await delay(500, init?.signal, "gemini");',
      '    return new Response(`data: {"candidates":[{"content":{"parts":[{"text":"reply:gemini"}]}}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1}}\\n`);',
      '  }',
      '  if (url === "https://api.moonshot.ai/v1/chat/completions") {',
      '    await delay(10, init?.signal, "kimi");',
      '    return new Response(`data: {"choices":[{"delta":{"content":"reply:kimi"}}]}\\n\\ndata: [DONE]\\n\\n`);',
      '  }',
      '  if (url === "https://api.deepseek.com/v1/chat/completions") {',
      '    await delay(200, init?.signal, "deepseek");',
      '    return new Response(`data: {"choices":[{"delta":{"content":"reply:deepseek"}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\\n\\ndata: [DONE]\\n\\n`);',
      '  }',
      '  return realFetch(input, init);',
      '};',
      "",
    ].join("\n"));
    fs.cpSync(CONTAINER, fixtureContainer, { recursive: true });
    fs.writeFileSync(
      path.join(fixtureContainer, "team-charter.md"),
      `# Test charter\n\n${CHARTER_MARKER}\n`,
    );
    const fixtureGate = path.join(fixtureContainer, "gate.js");
    shortenWatchdog(fixtureGate);

    fs.writeFileSync(wrapper, [
      'import fs from "node:fs";',
      'const bin = String(process.argv[2] || "");',
      'const argv = process.argv.slice(3);',
      'const leaf = bin.replace(/\\\\/g, "/").split("/").at(-1).toLowerCase();',
      'const engine = leaf.includes("cursor-agent") ? "cursor"',
      '  : leaf.includes("fake-claude") ? "claude"',
      '  : ["hermes", "codex", "gemini"].find((name) => leaf === name);',
      'if (!engine) throw new Error("unknown wrapped engine: " + bin);',
      `const logFile = ${JSON.stringify(eventLog)};`,
      'const record = (phase) => fs.appendFileSync(logFile, JSON.stringify({',
      '  phase, engine, pid: process.pid, at: Date.now(),',
      `  charter: argv.some((arg) => String(arg).includes("${CHARTER_MARKER}")),`,
      '}) + "\\n");',
      'record("start");',
      'await new Promise((resolve) => setTimeout(resolve, 900));',
      'if (engine === "claude") {',
      '  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"content_block_delta",delta:{type:"text_delta",text:"reply:claude"}}}) + "\\n");',
      '  process.stdout.write(JSON.stringify({type:"result",total_cost_usd:0,usage:{input_tokens:1,output_tokens:1}}) + "\\n");',
      '} else if (engine === "hermes") {',
      '  process.stdout.write("reply:hermes\\n");',
      '} else if (engine === "codex") {',
      '  process.stdout.write(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"reply:codex"}}) + "\\n");',
      '} else if (engine === "gemini") {',
      '  process.stdout.write(JSON.stringify({response:"reply:gemini",stats:{models:{}}}) + "\\n");',
      '} else {',
      '  process.stdout.write(JSON.stringify({type:"result",subtype:"success",is_error:false,result:"reply:cursor"}) + "\\n");',
      '}',
      'record("end");',
      "",
    ].join("\n"));

    gate = spawn(process.execPath, ["--require", fetchMock, fixtureGate], {
      env: {
        ...process.env,
        HOME: home,
        TTYD_PASSWORD: KEY,
        AGENT_CHAT_BIN: "fake-claude",
        AGENTHOST_DEV_WRAP: wrapper,
        AGENTHOST_BOX_SECRETS_FILE: secretsFile,
        WAKE_CHECKIN: "off",
        GATE_PORT: "0",
        CHANNEL_DISPATCH_PORT: "0",
      },
      stdio: ["ignore", "pipe", "inherit"],
    });
    const port = await waitForPort(gate);
    const base = `http://127.0.0.1:${port}`;
    const { cookie } = await mintOperatorSession(base, KEY);

    const runId = "teamserial01";
    const response = await fetch(
      `${base}/chat/stream?run=${runId}&engine=team&msg=${encodeURIComponent("fresh serialization proof")}`,
      { headers: { cookie } },
    );
    assert.equal(response.status, 200);
    const events = sseEvents(await response.text());

    const roster = events.find((entry) => entry.event === "roster");
    assert.deepEqual(JSON.parse(roster.data).engines, EXPECTED_ENGINES,
      "the browser reserves every visible slot in permanent roster order");
    assert.deepEqual(eventEngines(events, "engine"), ["deepseek", "kimi", "gemini", ...EXPECTED_LOCAL_ENGINES],
      "API engines still start first, then local engines start serially");
    assert.deepEqual(eventEngines(events, "engine_done"), ["deepseek", "kimi", "gemini", ...EXPECTED_LOCAL_ENGINES],
      "the protected-budget denial closes before the two permitted API replies");
    for (const entry of events.filter((event) => event.event === "engine_done")) {
      const outcome = JSON.parse(entry.data);
      if (outcome.eng === "deepseek") {
        assert.match(outcome.skipped, /DeepSeek protected spending controls require Foundation B\./,
          "Team names the exact flag-off spending-control cause");
      } else {
        assert.equal(outcome.skipped, null, `${outcome.eng} produced a real reply`);
      }
    }
    assert.equal(events.filter((entry) => entry.event === "done").length, 1,
      "the team turn records one terminal done event");
    assert.equal(events.at(-1).event, "done", "done follows every engine segment");
    assert.equal(events.some((entry) => entry.event === "error"), false, "the renewed lease never expires mid-round");

    const deltas = engineDeltas(events);
    assert.deepEqual([...new Set(deltas.map((entry) => entry.eng))], ["kimi", "gemini", ...EXPECTED_LOCAL_ENGINES],
      "every permitted engine labels its streamed Team Chat chunks for the browser");
    for (const engine of EXPECTED_ENGINES.filter((id) => id !== "deepseek")) {
      const streamed = deltas.filter((entry) => entry.eng === engine)
        .map((entry) => entry.t).join("");
      assert.match(streamed, new RegExp(`reply:${engine}`), `${engine}'s reply reached its visible Team Chat bubble`);
    }
    assert.equal(events.some((entry) => entry.event === "message"), false,
      "Team Chat never sends an unlabelled chunk that the per-engine renderer discards");

    const records = fs.readFileSync(eventLog, "utf8").split("\n").filter(Boolean).map(JSON.parse);
    assert.deepEqual(records.filter((record) => record.phase === "start").map((record) => record.engine),
      EXPECTED_LOCAL_ENGINES, "the actual wrapped processes started in roster order");
    assert.deepEqual(records.filter((record) => record.phase === "end").map((record) => record.engine),
      EXPECTED_LOCAL_ENGINES, "the actual wrapped processes finished in roster order");
    assert.equal(peakConcurrency(records), 1, "local engine process concurrency is exactly one");
    assert.ok(records.every((record) => record.charter), "every local engine received the short charter");

    const transcriptFile = path.join(home, ".claude", "agenthost", "team-thread.jsonl");
    const transcript = fs.readFileSync(transcriptFile, "utf8").split("\n").filter(Boolean).map(JSON.parse)
      .filter((entry) => entry.id === runId || String(entry.id || "").startsWith(`${runId}-r-`));
    assert.deepEqual(transcript.map((entry) => entry.id), [
      runId,
      ...EXPECTED_ENGINES.map((engine) => `${runId}-r-${engine}`),
    ], "the durable transcript keeps the same permanent roster order as the visible slots");

    const status = await fetch(`${base}/chat/runs/${runId}`, { headers: { cookie } });
    assert.equal(status.status, 200);
    assert.equal((await status.json()).status, "completed", "the durable fresh-chat run completed");

    fs.writeFileSync(apiEventLog, "");
    const cancelRunId = "teamcancel01";
    const cancelResponse = await fetch(
      `${base}/chat/stream?run=${cancelRunId}&engine=team&msg=${encodeURIComponent("cancel persistence proof")}`,
      { headers: { cookie } },
    );
    assert.equal(cancelResponse.status, 200);
    const partial = await readUntilEngineDone(cancelResponse, "kimi");
    const cancel = await fetch(`${base}/chat/runs/${cancelRunId}/cancel`, {
      method: "POST",
      headers: { cookie, origin: base },
    });
    assert.equal(cancel.status, 200);
    const cancelledEvents = sseEvents(await drainStream(partial));
    await waitForRunStatus(base, cookie, cancelRunId, "cancelled");
    assert.match(JSON.parse(cancelledEvents.find((entry) => entry.event === "done").data).error, /cancelled/i,
      "the stopped team run reports its real terminal cause");

    const cancelledTranscript = fs.readFileSync(transcriptFile, "utf8").split("\n").filter(Boolean).map(JSON.parse)
      .filter((entry) => entry.id === cancelRunId || String(entry.id || "").startsWith(`${cancelRunId}-r-`));
    assert.deepEqual(cancelledTranscript.map((entry) => entry.id), [
      cancelRunId,
      `${cancelRunId}-r-deepseek`,
      `${cancelRunId}-r-kimi`,
    ], "Stop preserves the completed denial and API answer without publishing a killed partial");
    const apiEvents = fs.readFileSync(apiEventLog, "utf8").split("\n").filter(Boolean).map(JSON.parse);
    assert.ok(apiEvents.some((entry) => entry.engine === "gemini" && entry.phase === "abort"),
      "Stop aborts the unfinished Gemini HTTP request");
    assert.equal(apiEvents.some((entry) => entry.engine === "deepseek"), false,
      "Team issues zero DeepSeek fetches while protected spending controls are unavailable");
    assert.equal(apiEvents.some((entry) => entry.engine === "gemini" && entry.phase === "finish"), false,
      "the unfinished Gemini request never reaches a normal finish");

    const afterCancelId = "aftercancel01";
    const afterCancel = await fetch(
      `${base}/chat/stream?run=${afterCancelId}&engine=claude&msg=${encodeURIComponent("lane release proof")}`,
      { headers: { cookie } },
    );
    assert.equal(afterCancel.status, 200);
    const afterCancelEvents = sseEvents(await afterCancel.text());
    assert.equal(afterCancelEvents.at(-1).event, "done",
      "a fresh chat run completes after Stop, proving the shared lane was released");
  } finally {
    await stopChild(gate, "SIGKILL");
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
