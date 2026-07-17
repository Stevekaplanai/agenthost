// E2E tests against the REAL gate.js for:
//   1. busy-slot visibility: a chat message that arrives while the agent slot
//      is held gets an IMMEDIATE "status" SSE event ("queued"), then its
//      answer once the slot frees (it is no longer rejected with an error).
//   2. /brain tokenization (task #34): "/brain what is attribyte" greps the
//      keyword, not the full sentence literal, so notes that never contain the
//      exact phrase still hit.
//
// Boots the gate on an ephemeral port (GATE_PORT=0, actual port read from its
// log line) so this file can run in parallel with gate-2fa.test.js (which owns
// 8080). AGENT_CHAT_BIN is a fake that echoes its prompt; a prompt containing
// SLOW sleeps first, which is how the tests hold the busy slot.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const GATE = path.join(import.meta.dirname, "..", "container", "gate.js");
const KEY = "gate-busy-test-key";

let HOME;
let gate;
let base;
let cookie;

// Parse a full SSE body into [{event, data}], ignoring comment heartbeats.
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

// Concatenate the streamed chunks (default "message" events carry JSON strings).
function streamedText(events) {
  return events.filter((e) => e.event === "message").map((e) => JSON.parse(e.data)).join("");
}

before(async () => {
  HOME = fs.mkdtempSync(path.join(import.meta.dirname, ".gatebusy-"));
  fs.mkdirSync(path.join(HOME, "work"), { recursive: true });
  // A "brain": a non-dot top-level dir under HOME (how --include'd brains land).
  // Deliberately does NOT contain the phrase "what is attribyte" anywhere --
  // the old full-sentence grep returns nothing for it.
  fs.mkdirSync(path.join(HOME, "notes"), { recursive: true });
  fs.writeFileSync(path.join(HOME, "notes", "attribyte.md"),
    "Attribyte is my attribution engine side project.\nAttribution models: last-touch vs multi-touch.\n");
  const fakeBin = path.join(HOME, "fake-claude.sh");
  // Fake claude: the chat engine now runs claude with --output-format
  // stream-json --include-partial-messages, so the gate parses a JSONL event
  // stream. Emit the echo text as a content_block_delta/text_delta (what the
  // gate streams to the browser) plus a result event (usage). $2 is the prompt
  // (-p <prompt>). node does the JSON-encoding so any prompt (quotes, etc.) is
  // safely embedded -- node is already a hard dependency of this test. A prompt
  // containing SLOW holds the busy slot for 2s.
  fs.writeFileSync(fakeBin, [
    "#!/bin/sh",
    'case "$2" in *SLOW*) sleep 2 ;; esac',
    "node -e 'const t=process.argv[1];" +
      'process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"content_block_delta",delta:{type:"text_delta",text:"echo:"+t}}})+"\\n");' +
      'process.stdout.write(JSON.stringify({type:"result",total_cost_usd:0,usage:{input_tokens:1,output_tokens:1}})+"\\n");' +
      "' \"$2\"",
    "",
  ].join("\n"), { mode: 0o755 });

  gate = spawn("node", [GATE], {
    env: { ...process.env, HOME, TTYD_PASSWORD: KEY, AGENT_CHAT_BIN: fakeBin, GATE_PORT: "0" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  // The gate logs "[gate] listening on <port>, ..." -- read the ephemeral port.
  const port = await new Promise((resolve, reject) => {
    let out = "";
    const to = setTimeout(() => reject(new Error("gate did not report its port; got: " + out)), 5000);
    gate.stdout.on("data", (c) => {
      out += c.toString();
      const m = out.match(/listening on (\d+)/);
      if (m) { clearTimeout(to); resolve(Number(m[1])); }
    });
    gate.on("exit", () => { clearTimeout(to); reject(new Error("gate exited before listening; got: " + out)); });
  });
  base = `http://127.0.0.1:${port}`;
  const login = await fetch(`${base}/?key=${KEY}`, { redirect: "manual" });
  cookie = String(login.headers.get("set-cookie") || "").split(";")[0];
  assert.ok(cookie.startsWith("agenthost_auth="), "login granted a cookie");
});

after(() => {
  if (gate) gate.kill("SIGKILL");
  if (HOME) fs.rmSync(HOME, { recursive: true, force: true });
});

function stream(msg) {
  return fetch(`${base}/chat/stream?msg=${encodeURIComponent(msg)}`, { headers: { cookie } });
}

test("busy slot: second message gets an immediate queued status, then its answer when the slot frees", async () => {
  // Hold the slot with a slow run (fake bin sleeps 2s on SLOW). Do NOT await
  // the fetch: the gate only flushes SSE headers with the first body write,
  // which for this run happens after the sleep -- awaiting here would
  // serialize the test and the slot would already be free for the second
  // message. The request hits the gate the moment it is sent.
  const p1 = stream("SLOW hold the slot").then((r) => r.text());
  await new Promise((r) => setTimeout(r, 250)); // let the first run take the slot

  const t0 = Date.now();
  const r2 = await stream("second message");
  const reader = r2.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let statusAt = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    if (!statusAt && buf.includes("event: status")) statusAt = Date.now();
  }

  // The status event must arrive WHILE the slot is still held (the fake first
  // run sleeps 2s) -- i.e. immediately, not after the wait.
  assert.ok(statusAt > 0, "a status event was emitted");
  assert.ok(statusAt - t0 < 1500, `status arrived immediately (${statusAt - t0}ms), not after the slot freed`);

  const events = sseEvents(buf);
  const status = events.find((e) => e.event === "status");
  const meta = JSON.parse(status.data);
  assert.match(meta.text, /busy/, "status says the agent is busy");
  assert.match(meta.text, /queued/, "status says the message is queued");
  assert.match(meta.text, /another chat message/, "status names what holds the slot (chat, not a scheduled job)");
  assert.equal(meta.holder, "chat");

  // ...and the queued message still ran to completion once the slot freed.
  assert.equal(streamedText(events), "echo:second message", "queued message answered after the wait");
  const done2 = events.find((e) => e.event === "done");
  // done now carries {engine, usage?}; success means simply no error key.
  assert.equal(JSON.parse(done2.data).error, undefined, "no error: queueing replaced the old busy rejection");

  // The first run was untouched by the queueing.
  const text1 = await p1;
  const ev1 = sseEvents(text1);
  assert.equal(streamedText(ev1), "echo:SLOW hold the slot");
  assert.ok(!ev1.some((e) => e.event === "status"), "the run that HELD the slot never saw a status line");
});

test("free slot: no status event is emitted", async () => {
  const r = await stream("fast question");
  const events = sseEvents(await r.text());
  assert.ok(!events.some((e) => e.event === "status"), "no queued status when the slot is free");
  assert.equal(streamedText(events), "echo:fast question");
});

test("brain: a full question greps keywords, not the sentence literal (task #34)", async () => {
  // The notes never contain the phrase "what is attribyte"; under the old
  // full-sentence grep this returned zero hits. Tokenized, "attribyte" hits.
  const r = await stream("/brain what is attribyte");
  const events = sseEvents(await r.text());
  const prompt = streamedText(events); // fake bin echoes the summarizer prompt
  assert.match(prompt, /attribyte\.md/, "grep hit carries the file name");
  assert.match(prompt, /Attribyte is my attribution engine/, "the keyword hit line made it into the prompt");
  assert.match(prompt, /'what is attribyte'/, "the ORIGINAL full question (not the keyword list) goes to the summarizer");
  const done = events.find((e) => e.event === "done");
  assert.equal(JSON.parse(done.data).error, undefined, "brain summary succeeded (no error on done)");
});

test("brain: empty query fails fast with usage, even shaped like the old error path", async () => {
  const r = await stream("/brain   ");
  const events = sseEvents(await r.text());
  const done = events.find((e) => e.event === "done");
  assert.match(JSON.parse(done.data).error, /usage: \/brain/);
});
