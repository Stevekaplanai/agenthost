// E2E smoke test for the chat-speed fix: gate-spawned `claude -p` one-shots
// (chat and, via the same shared builder, /brain and cron) must carry the
// hook-suppression overlay in their SPAWN ARGS, and AGENT_CHAT_HOOKS=1 must
// remove it. This is deliberately an args-shape assertion, not a wall-clock
// test -- timing was proven manually (two 3s hooks: 10.1s -> 3.5s per turn)
// and a sleep-based test would be flaky on loaded CI boxes.
//
// Two REAL gate.js processes are booted on ephemeral ports (GATE_PORT=0), one
// per hook mode, with a fake chat bin that echoes back every argv it received.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const GATE = path.join(import.meta.dirname, "..", "container", "gate.js");
const KEY = "gate-hooks-test-key";

let HOME;
const gates = []; // [{proc, base, cookie}] -- index 0 = default, 1 = AGENT_CHAT_HOOKS=1

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

async function bootGate(extraEnv) {
  const proc = spawn("node", [GATE], {
    env: { ...process.env, HOME, TTYD_PASSWORD: KEY, AGENT_CHAT_BIN: path.join(HOME, "argv-echo.sh"), GATE_PORT: "0", ...extraEnv },
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
  const base = `http://127.0.0.1:${port}`;
  const login = await fetch(`${base}/?key=${KEY}`, { redirect: "manual" });
  const cookie = String(login.headers.get("set-cookie") || "").split(";")[0];
  assert.ok(cookie.startsWith("agenthost_auth="), "login granted a cookie");
  return { proc, base, cookie };
}

before(async () => {
  HOME = fs.mkdtempSync(path.join(import.meta.dirname, ".gatehooks-"));
  fs.mkdirSync(path.join(HOME, "work"), { recursive: true });
  // Fake chat bin: prints every argv it received, pipe-separated, so the SSE
  // stream carries the exact spawn args for assertion.
  fs.writeFileSync(path.join(HOME, "argv-echo.sh"), [
    "#!/bin/sh",
    "printf 'argv'",
    'for a in "$@"; do printf \'|%s\' "$a"; done',
    "",
  ].join("\n"), { mode: 0o755 });
  gates.push(await bootGate({}));
  gates.push(await bootGate({ AGENT_CHAT_HOOKS: "1" }));
});

after(() => {
  for (const g of gates) g.proc.kill("SIGKILL");
  if (HOME) fs.rmSync(HOME, { recursive: true, force: true });
});

async function chatArgv(gate, msg) {
  const r = await fetch(`${gate.base}/chat/stream?msg=${encodeURIComponent(msg)}`, { headers: { cookie: gate.cookie } });
  const events = sseEvents(await r.text());
  const done = events.find((e) => e.event === "done");
  assert.deepEqual(JSON.parse(done.data), {}, "run completed cleanly");
  const text = streamedText(events);
  assert.ok(text.startsWith("argv|"), "fake bin echoed its argv");
  return text.split("|").slice(1);
}

test("chat runs spawn with the hook-suppression overlay by default", async () => {
  const argv = await chatArgv(gates[0], "hello speed");
  const at = argv.indexOf("--settings");
  assert.notEqual(at, -1, `--settings present in spawn args (got: ${argv.join(" ")})`);
  assert.equal(JSON.parse(argv[at + 1]).disableAllHooks, true, "overlay is the supported disableAllHooks kill switch");
  assert.deepEqual(argv.slice(0, 2), ["-p", "hello speed"], "prompt still rides as argv[2]");
  assert.equal(argv[argv.length - 1], "-c", "warm-session continue is preserved");
});

test("/brain runs carry the same suppression (shared arg builder)", async () => {
  const argv = await chatArgv(gates[0], "/brain claimflow.health status");
  const at = argv.indexOf("--settings");
  assert.notEqual(at, -1, "--settings present on the brain summarizer run");
  assert.equal(JSON.parse(argv[at + 1]).disableAllHooks, true);
  // Brain summaries are one-shots with the hits inline: no -c.
  assert.ok(!argv.includes("-c"), "brain runs never continue a session");
});

test("AGENT_CHAT_HOOKS=1 keeps the user's hooks (no overlay in spawn args)", async () => {
  const argv = await chatArgv(gates[1], "hello hooks");
  assert.ok(!argv.includes("--settings"), `no settings overlay when opted out (got: ${argv.join(" ")})`);
  assert.deepEqual(argv.slice(0, 2), ["-p", "hello hooks"]);
});
