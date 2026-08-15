import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const startSource = fs.readFileSync(new URL("../container/start.sh", import.meta.url), "utf8");
const posixOnly = process.platform === "win32" ? "POSIX signal behavior is proven on Linux" : false;

function extractedSupervisor() {
  const begin = startSource.indexOf("# BEGIN FLAG-OFF GATE SUPERVISOR");
  const end = startSource.indexOf("# END FLAG-OFF GATE SUPERVISOR");
  assert.ok(begin >= 0 && end > begin, "the flag-off supervisor is extractable for behavioral proof");
  return startSource.slice(begin, end);
}

function waitForExit(child, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("flag-off supervisor did not exit after signal")), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function waitForText(read, pattern, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!pattern.test(read()) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.match(read(), pattern);
}

test("the flag-off PID 1 forwards Fly shutdown signals to gate and never restarts it", () => {
  assert.match(startSource, /trap 'forward_gate_signal TERM' TERM/);
  assert.match(startSource, /trap 'forward_gate_signal INT' INT/);
  assert.match(startSource, /node --disable-sigusr1 \/opt\/agenthost\/gate\.js\s*&/);
  assert.match(startSource, /if \[ "\$gate_shutdown_requested" -eq 1 \]; then[\s\S]*?exit "\$EXIT_CODE"/);
});

test("a real TERM reaches the flag-off gate child and the wrapper exits without restart", {
  skip: posixOnly,
}, async () => {
  const supervisor = extractedSupervisor();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-start-signal-"));
  const log = path.join(dir, "signals.log");
  const script = `
set -uo pipefail
node() {
  trap 'printf "TERM\\n" >> "$SIGNAL_LOG"; exit 0' TERM
  trap 'printf "INT\\n" >> "$SIGNAL_LOG"; exit 0' INT
  printf "start\\n" >> "$SIGNAL_LOG"
  while true; do sleep 0.05; done
}
${supervisor}
`;
  const child = spawn("/bin/bash", ["-c", script], {
    env: { ...process.env, SIGNAL_LOG: log },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitForText(() => fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "", /start/);
    child.kill("SIGTERM");
    const exit = await waitForExit(child);
    assert.deepEqual(exit, { code: 0, signal: null });
    assert.equal(fs.readFileSync(log, "utf8"), "start\nTERM\n", "the child receives TERM exactly once and is not restarted");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("TERM during restart backoff suppresses the replacement gate", { skip: posixOnly }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-start-backoff-"));
  const log = path.join(dir, "signals.log");
  const script = `
set -uo pipefail
node() { printf "start\\n" >> "$SIGNAL_LOG"; return 75; }
${extractedSupervisor()}
`;
  const child = spawn("/bin/bash", ["-c", script], {
    env: { ...process.env, SIGNAL_LOG: log },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  try {
    await waitForText(() => stdout, /restarting in 2s/);
    child.kill("SIGTERM");
    assert.deepEqual(await waitForExit(child), { code: 0, signal: null });
    assert.equal(fs.readFileSync(log, "utf8"), "start\n", "shutdown during backoff never starts a replacement");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("repeated TERM waits for the real child exit and preserves exit 127", { skip: posixOnly }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-start-repeat-"));
  const log = path.join(dir, "signals.log");
  const script = `
set -uo pipefail
node() {
  exec "$REAL_NODE" -e '
    const fs = require("node:fs");
    const log = process.env.SIGNAL_LOG;
    fs.appendFileSync(log, "start\\n");
    process.once("SIGTERM", () => {
      fs.appendFileSync(log, "TERM\\n");
      setTimeout(() => {
        fs.appendFileSync(log, "done\\n");
        process.exit(127);
      }, 250);
    });
    setInterval(() => {}, 50);
  '
}
${extractedSupervisor()}
`;
  const child = spawn("/bin/bash", ["-c", script], {
    env: { ...process.env, REAL_NODE: process.execPath, SIGNAL_LOG: log },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitForText(() => fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "", /start/);
    child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 50));
    child.kill("SIGTERM");
    assert.deepEqual(await waitForExit(child), { code: 127, signal: null });
    assert.match(fs.readFileSync(log, "utf8"), /done/, "the wrapper stays alive until the gate's terminal proof");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
