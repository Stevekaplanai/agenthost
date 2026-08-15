import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mintOperatorSession } from "./operator-session-helper.js";

const SOURCE_CONTAINER = path.join(import.meta.dirname, "..", "container");
const TOKEN = "channel-delivery-integration-token-0123456789";

function readEvents(file) {
  try {
    return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function waitFor(predicate, message, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

test("real gate serializes deliveries, yields to queued chat, and continues after a failed child", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-delivery-"));
  const fixtureContainer = path.join(home, "container");
  const binDir = path.join(home, "bin");
  const eventFile = path.join(home, "openclaw-events.jsonl");
  const lockFile = path.join(home, "openclaw-active.lock");
  fs.cpSync(SOURCE_CONTAINER, fixtureContainer, { recursive: true });
  fs.writeFileSync(path.join(fixtureContainer, "team-charter.md"), "# Delivery integration test charter\n");
  const gateFile = path.join(fixtureContainer, "gate.js");
  fs.mkdirSync(path.join(home, "work"), { recursive: true });
  fs.mkdirSync(path.join(home, ".agenthost"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(home, ".agenthost", "secrets.env"), `CHANNEL_DISPATCH_TOKEN=${TOKEN}\n`, { mode: 0o600 });

  const worker = path.join(binDir, "fake-openclaw.cjs");
  fs.writeFileSync(worker, [
    '"use strict";',
    'const fs = require("node:fs");',
    `const eventFile = ${JSON.stringify(eventFile)};`,
    `const lockFile = ${JSON.stringify(lockFile)};`,
    'const args = process.argv.slice(2);',
    'const targetArg = args.find((arg) => arg.startsWith("--target=")) || "--target=unknown";',
    'const target = targetArg.slice("--target=".length);',
    'let lock = null;',
    'let overlap = false;',
    'try { lock = fs.openSync(lockFile, "wx"); } catch (error) { if (error.code === "EEXIST") overlap = true; else throw error; }',
    'const record = (event) => fs.appendFileSync(eventFile, JSON.stringify({ event, target, pid: process.pid, overlap, at: Date.now() }) + "\\n");',
    'record("start");',
    'setTimeout(() => {',
    '  record("end");',
    '  if (lock !== null) { fs.closeSync(lock); try { fs.unlinkSync(lockFile); } catch {} }',
    '  process.exitCode = target === "fail-child" ? 1 : 0;',
    '}, target === "priority-first" ? 600 : 175);',
    "",
  ].join("\n"));
  const fakeAgent = path.join(home, "fake-agent.mjs");
  fs.writeFileSync(fakeAgent, [
    'import fs from "node:fs";',
    `const eventFile = ${JSON.stringify(eventFile)};`,
    'const args = process.argv.slice(2);',
    'const promptAt = args.indexOf("-p");',
    'const prompt = promptAt === -1 ? "" : args[promptAt + 1];',
    'const record = (event) => fs.appendFileSync(eventFile, JSON.stringify({ event, target: "human-chat", at: Date.now() }) + "\\n");',
    'record("chat-start");',
    'process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"content_block_delta",delta:{type:"text_delta",text:"human answered"}}})+"\\n");',
    'process.stdout.write(JSON.stringify({type:"result",total_cost_usd:0,usage:{input_tokens:1,output_tokens:1}})+"\\n");',
    'record("chat-end");',
    "",
  ].join("\n"));

  if (process.platform === "win32") {
    // child_process.spawn("openclaw") does not execute a .cmd shim unless the
    // caller opts into a shell (production deliberately does not). Give PATH a
    // real .exe instead: the Node executable consumes its first gate-supplied
    // argument ("message") as this fixture's CommonJS script in `home`.
    const fakeExe = path.join(binDir, "openclaw.exe");
    try { fs.linkSync(process.execPath, fakeExe); }
    catch { fs.copyFileSync(process.execPath, fakeExe); }
    fs.copyFileSync(worker, path.join(home, "message"));
  } else {
    const launcher = path.join(binDir, "openclaw");
    fs.writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${worker}" "$@"\n`);
    fs.chmodSync(launcher, 0o755);
  }

  const gate = spawn(process.execPath, [gateFile], {
    cwd: home,
    env: {
      ...process.env,
      PATH: binDir + path.delimiter + process.env.PATH,
      HOME: home,
      AGENTHOST_BOX_SECRETS_FILE: path.join(home, ".agenthost", "secrets.env"),
      TTYD_PASSWORD: "delivery-integration-key",
      AGENT_CHAT_BIN: "fake-claude",
      AGENTHOST_DEV_WRAP: fakeAgent,
      AGENTHOST_FOUNDATION_B: "0",
      GATE_PORT: "0",
      CHANNEL_DISPATCH_PORT: "0",
      WAKE_CHECKIN: "off",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  gate.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  gate.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  t.after(async () => {
    if (gate.exitCode === null) {
      const exited = new Promise((resolve) => gate.once("exit", resolve));
      gate.kill("SIGTERM");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  const internalPort = await waitFor(() => {
    const match = stdout.match(/channel-dispatch bound on 127\.0\.0\.1:(\d+)/);
    return match && Number(match[1]);
  }, `gate did not bind its internal listener\nstdout:\n${stdout}\nstderr:\n${stderr}`, 5000);
  const publicPort = await waitFor(() => {
    const match = stdout.match(/\[gate\] listening on (\d+)/);
    return match && Number(match[1]);
  }, `gate did not bind its public listener\nstdout:\n${stdout}\nstderr:\n${stderr}`, 5000);
  const base = `http://127.0.0.1:${publicPort}`;
  const { cookie } = await mintOperatorSession(base, "delivery-integration-key");
  const dispatch = (target) => fetch(`http://127.0.0.1:${internalPort}/internal/channel-dispatch`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-agenthost-channel-token": TOKEN },
    body: JSON.stringify({ channel: "telegram", text: "status", senderId: target, chatId: target }),
  });

  const failedResponse = await dispatch("fail-child");
  assert.equal(failedResponse.status, 400, "disabled-channel rejection still schedules its outbound verdict");
  await waitFor(() => readEvents(eventFile).some((event) => event.event === "start" && event.target === "fail-child"),
    "the deliberately failing OpenClaw child never started");

  const laterTargets = ["later-1", "later-2", "later-3", "later-4", "later-5"];
  const laterResponses = await Promise.all(laterTargets.map(dispatch));
  assert.ok(laterResponses.every((response) => response.status === 400), "all concurrent dispatches reached the real reject path");

  const events = await waitFor(() => {
    const current = readEvents(eventFile);
    return current.filter((event) => event.event === "end").length === laterTargets.length + 1 && current;
  }, `not every queued delivery finished\nstdout:\n${stdout}\nstderr:\n${stderr}`);

  let active = 0;
  let peak = 0;
  for (const event of events) {
    if (event.event === "start") {
      active++;
      peak = Math.max(peak, active);
    } else if (event.event === "end") {
      active--;
    }
  }
  assert.equal(peak, 1, "the real gateway never runs more than one OpenClaw CLI delivery process");
  assert.ok(events.every((event) => event.overlap === false), "the cross-process lock never observed overlapping deliveries");
  const failedEnd = events.findIndex((event) => event.event === "end" && event.target === "fail-child");
  assert.ok(failedEnd >= 0, "the failing child reached a terminal process event");
  assert.ok(events.slice(failedEnd + 1).some((event) => event.event === "start" && laterTargets.includes(event.target)),
    "a failed child releases the delivery lane so later queued jobs still run");
  assert.deepEqual(
    new Set(events.filter((event) => event.event === "end").map((event) => event.target)),
    new Set(["fail-child", ...laterTargets]),
    "every queued verdict was attempted exactly to completion",
  );

  await dispatch("priority-first");
  await waitFor(() => readEvents(eventFile).some((event) =>
    event.event === "start" && event.target === "priority-first"),
  "the delivery holding the shared lane never started");
  await dispatch("priority-second");
  const chatResponse = await fetch(
    `${base}/chat/stream?run=deliverypriority01&engine=claude&msg=human+priority`,
    { headers: { cookie } },
  );
  const chatBody = chatResponse.text();

  const priorityEvents = await waitFor(() => {
    const current = readEvents(eventFile);
    return current.some((event) => event.event === "end" && event.target === "priority-second")
      && current.some((event) => event.event === "chat-end")
      && current;
  }, `priority jobs did not finish\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  await chatBody;

  const firstEnd = priorityEvents.findIndex((event) =>
    event.event === "end" && event.target === "priority-first");
  const chatStart = priorityEvents.findIndex((event) => event.event === "chat-start");
  const chatEnd = priorityEvents.findIndex((event) => event.event === "chat-end");
  const secondStart = priorityEvents.findIndex((event) =>
    event.event === "start" && event.target === "priority-second");
  assert.ok(firstEnd < chatStart, "the human waits for the active delivery to finish");
  assert.ok(chatStart < chatEnd, "the human chat reaches a terminal event");
  assert.ok(chatEnd < secondStart,
    "a queued human chat runs before the delivery limiter can reacquire the shared lane");
});
