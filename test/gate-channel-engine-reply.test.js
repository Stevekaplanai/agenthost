// E2E proof that a channel message is actually ANSWERED end-to-end through the
// real gate.js: dispatch -> isolated per-conversation engine turn -> delivery.
// Companion to gate-channel-dispatch.test.js (which proves the gate/governance
// contract); this file proves the engine-reply wiring added 2026-07-23 and, in
// particular, that the isolated-session design (Steve's explicit call: a
// channel reply must NEVER share or continue the operator's own chat thread)
// actually composes correctly with runChat's existing "no prior session ->
// retry without -c" logic for a BRAND NEW per-conversation directory.
//
// The fake "claude" binary below simulates cwd-keyed session continuity
// exactly like the real CLI: a "-c" call succeeds only if a PRIOR successful
// run already left a sentinel file in that same cwd -- so the first message to
// a fresh isolated directory must fail its "-c" attempt and let runChat's
// built-in retry-without-continue rescue it, precisely the case the isolated
// design depends on.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { mintOperatorSession } from "./operator-session-helper.js";

const GATE = path.join(import.meta.dirname, "..", "container", "gate.js");
const KEY = "gate-chreply-test-key";
const TOKEN = "test-channel-reply-token-0123456789";

function hasTmux() {
  try { return spawnSync("tmux", ["-V"]).error == null; } catch { return false; }
}
const NO_TMUX = hasTmux() ? false
  : "tmux is not installed in this environment -- this fixture needs a real tmux session " +
    "to simulate OpenClaw's gateway window; functional coverage lives elsewhere. Run on Linux/WSL/CI.";

const box = {};

before(async () => {
  const home = fs.mkdtempSync(path.join(import.meta.dirname, ".gatechreply-"));
  fs.mkdirSync(path.join(home, "work"), { recursive: true });
  fs.mkdirSync(path.join(home, ".agenthost"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, ".agenthost", "secrets.env"), `CHANNEL_DISPATCH_TOKEN=${TOKEN}\n`, { mode: 0o600 });
  fs.mkdirSync(path.join(home, ".openclaw"), { recursive: true });
  fs.writeFileSync(path.join(home, ".openclaw", "openclaw.json"), JSON.stringify({
    channels: { telegram: { botToken: "fake-telegram-bot-token-for-a-test-1234567890" } },
  }));

  const tmuxTmp = fs.mkdtempSync(path.join(import.meta.dirname, ".gatechreply-tmux-"));
  const tmuxEnv = { ...process.env, TMUX_TMPDIR: tmuxTmp };
  spawnSync("tmux", ["new-session", "-d", "-s", "agent", "-n", "openclaw"], { env: tmuxEnv });
  box.tmuxTmp = tmuxTmp;

  // Fake engine: cwd-keyed sentinel simulates real Claude session continuity.
  const fakeEngine = path.join(home, "fake-claude.mjs");
  fs.writeFileSync(fakeEngine, [
    'import fs from "node:fs";',
    'const args = process.argv.slice(2);',
    'const hasContinue = args.includes("-c");',
    'const sentinel = ".fake-session-exists";',
    'if (hasContinue && !fs.existsSync(sentinel)) process.exit(1); // no prior session in THIS cwd -- runChat must retry without -c',
    'fs.writeFileSync(sentinel, "1");',
    'process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"content_block_delta",delta:{type:"text_delta",text:"ack cwd="+process.cwd()+" continued="+hasContinue}}})+"\\n");',
    'process.stdout.write(JSON.stringify({type:"result",total_cost_usd:0,usage:{input_tokens:1,output_tokens:1}})+"\\n");',
    "",
  ].join("\n"));

  // Fake `openclaw` on PATH: captures every "message send" delivery to a log
  // file instead of hitting a real gateway, so the outbound half is provable too.
  const binDir = path.join(home, "fakebin");
  fs.mkdirSync(binDir, { recursive: true });
  // The fake below is an EXTENSIONLESS `openclaw` (it must be found on PATH as the
  // bare command), so Node decides CommonJS-vs-ESM from the nearest package.json.
  // This fixture's home lives INSIDE the repo tree (import.meta.dirname), and the
  // repo package.json is "type":"module" -- which would make the extensionless
  // script ESM and its require() throw "require is not defined", the delivery
  // spawn would exit 1, and every test here would time out waiting for a reply
  // that never came. Pin this dir to CommonJS so the fake runs regardless of
  // where the fixture is created. (This exact interpretation trap is why the
  // suite was silently red before 2026-07-24.)
  fs.writeFileSync(path.join(binDir, "package.json"), JSON.stringify({ type: "commonjs" }));
  const deliveryLog = path.join(home, "deliveries.jsonl");
  const fakeOpenclaw = path.join(binDir, "openclaw");
  fs.writeFileSync(fakeOpenclaw, [
    "#!/usr/bin/env node",
    'const fs = require("node:fs");',
    `fs.appendFileSync(${JSON.stringify(deliveryLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
    "process.exit(0);",
    "",
  ].join("\n"));
  fs.chmodSync(fakeOpenclaw, 0o755);
  box.deliveryLog = deliveryLog;

  const child = spawn("node", [GATE], {
    env: {
      ...process.env,
      PATH: binDir + path.delimiter + process.env.PATH,
      HOME: home, TTYD_PASSWORD: KEY, AGENT_CHAT_BIN: "fake-claude",
      AGENTHOST_BOX_SECRETS_FILE: path.join(home, ".agenthost", "secrets.env"),
      AGENTHOST_DEV_WRAP: fakeEngine,
      GATE_PORT: "0", CHANNEL_DISPATCH_PORT: "0", CHANNEL_OWNER_READY_TTL_MS: "0",
      TMUX_TMPDIR: tmuxTmp,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const ports = new Promise((resolve, reject) => {
    let out = "";
    let main = null, internal = null;
    const to = setTimeout(() => reject(new Error("gate did not report its ports; got: " + out)), 5000);
    const maybeResolve = () => { if (main !== null && internal !== null) { clearTimeout(to); resolve({ main, internal }); } };
    child.stdout.on("data", (c) => {
      out += c.toString();
      const m1 = out.match(/listening on (\d+)/);
      if (m1) main = Number(m1[1]);
      const m2 = out.match(/channel-dispatch bound on 127\.0\.0\.1:(\d+)/);
      if (m2) internal = Number(m2[1]);
      maybeResolve();
    });
    child.on("exit", () => { clearTimeout(to); reject(new Error("gate exited before listening; got: " + out)); });
  });
  const { main, internal } = await ports;
  box.home = home;
  box.gate = child;
  box.base = `http://127.0.0.1:${main}`;
  box.internalBase = `http://127.0.0.1:${internal}`;
  const { cookie } = await mintOperatorSession(box.base, KEY);
  const set = await fetch(`${box.base}/api/settings`, {
    method: "PUT", headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ set: { channels: { telegram: { enabled: true, owner: "openclaw" } } } }),
    redirect: "manual",
  });
  assert.equal(set.status, 200, "test setup: could not enable the telegram channel via /api/settings");
});

after(async () => {
  if (box.gate) {
    const exited = new Promise((resolve) => box.gate.once("exit", resolve));
    box.gate.kill("SIGTERM");
    await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
  }
  if (box.tmuxTmp) spawnSync("tmux", ["kill-server"], { env: { ...process.env, TMUX_TMPDIR: box.tmuxTmp } });
  if (box.home) fs.rmSync(box.home, { recursive: true, force: true });
  if (box.tmuxTmp) fs.rmSync(box.tmuxTmp, { recursive: true, force: true });
});

function readDeliveries() {
  try {
    return fs.readFileSync(box.deliveryLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

async function waitForDelivery(sinceCount, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const d = readDeliveries();
    if (d.length > sinceCount) return d;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("timed out waiting for a delivered reply");
}

test("a benign channel message is answered: engine runs, reply is delivered via openclaw message send", { skip: NO_TMUX }, async () => {
  const before = readDeliveries().length;
  const r = await fetch(box.internalBase + "/internal/channel-dispatch", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-agenthost-channel-token": TOKEN },
    body: JSON.stringify({ channel: "telegram", text: "hi there", senderId: "user-A", chatId: "chat-A" }),
  });
  assert.equal(r.status, 200);
  const deliveries = await waitForDelivery(before);
  const args = deliveries[deliveries.length - 1];
  assert.ok(args.includes("--channel"), "delivered via the real send argv shape");
  assert.equal(args[args.indexOf("--channel") + 1], "telegram");
  assert.ok(args.some((a) => a === "--target=chat-A"), "delivered to the conversation (chatId), not just the sender");
  const msgArg = args.find((a) => a.startsWith("--message="));
  assert.ok(msgArg, "a --message= arg is present");
  assert.match(msgArg, /continued=false/, "first message in a FRESH isolated cwd: -c had no session, runChat's retry-without-continue rescued it");
});

test("a second message in the SAME channel conversation continues its own isolated session (not a fresh one, not the operator's)", { skip: NO_TMUX }, async () => {
  const before = readDeliveries().length;
  const r = await fetch(box.internalBase + "/internal/channel-dispatch", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-agenthost-channel-token": TOKEN },
    body: JSON.stringify({ channel: "telegram", text: "follow-up", senderId: "user-A", chatId: "chat-A" }),
  });
  assert.equal(r.status, 200);
  const deliveries = await waitForDelivery(before);
  const msgArg = deliveries[deliveries.length - 1].find((a) => a.startsWith("--message="));
  assert.match(msgArg, /continued=true/, "the SAME conversation's session sentinel already existed -- real continuity within one channel thread");
});

test("a DIFFERENT channel conversation gets its OWN fresh isolated session, never chat-A's", { skip: NO_TMUX }, async () => {
  const before = readDeliveries().length;
  const r = await fetch(box.internalBase + "/internal/channel-dispatch", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-agenthost-channel-token": TOKEN },
    body: JSON.stringify({ channel: "telegram", text: "hello", senderId: "user-B", chatId: "chat-B" }),
  });
  assert.equal(r.status, 200);
  const deliveries = await waitForDelivery(before);
  const args = deliveries[deliveries.length - 1];
  assert.ok(args.some((a) => a === "--target=chat-B"));
  const msgArg = args.find((a) => a.startsWith("--message="));
  assert.match(msgArg, /continued=false/, "a genuinely NEW conversation has no prior session -- isolated from chat-A's, not accidentally sharing it");
});
