// Root-local QA control. The production boundary is filesystem ownership of a
// Foundation-B-only Unix socket; public /qa routes keep their cookie wall.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stopChild } from "./child-process-helper.js";

const ROOT = path.join(import.meta.dirname, "..");
const GATE = path.join(ROOT, "container", "gate.js");
const KEY = "gate-qa-control-test-key";

function writeFakeQaScript(home, marker = null) {
  const script = path.join(home, "fake-run-qa.sh");
  const markerLine = marker ? `printf spawned > "${marker}"\n` : "";
  fs.writeFileSync(script, "#!/usr/bin/env bash\n" + markerLine
    + "IFS= read -r token\n"
    + "test ${#token} -ge 32\n"
    + "echo '3 unchanged'\n"
    + "echo '  unchanged  workspace@phone'\n"
    + "exit 0\n");
  return script;
}

function bootGate(home, extraEnv = {}) {
  const child = spawn("node", [GATE], {
    env: {
      ...process.env,
      HOME: home,
      TTYD_PASSWORD: KEY,
      AGENT_CHAT_BIN: "/bin/true",
      GATE_PORT: "0",
      CHANNEL_DISPATCH_PORT: "0",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  const port = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("gate did not report its port; got: " + output)), 5000);
    const inspect = () => {
      const match = output.match(/listening on (\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    };
    child.stdout.on("data", inspect);
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error("gate exited " + code + "; got: " + output)); });
  });
  return { child, port, output: () => output };
}

function unixQaRequest(socketPath, method, requestPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path: requestPath, headers: { host: "localhost" } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        try { resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }); }
        catch (error) { reject(new Error("QA control returned invalid JSON: " + error.message + "; body=" + raw)); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function waitForSocket(socketPath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (fs.lstatSync(socketPath).isSocket()) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("QA control socket did not appear: " + socketPath);
}

test("the image wires one root-only QA client to the fixed private socket", () => {
  const entrypoint = fs.readFileSync(path.join(ROOT, "container", "entrypoint.sh"), "utf8");
  const dockerfile = fs.readFileSync(path.join(ROOT, "container", "Dockerfile"), "utf8");
  const client = fs.readFileSync(path.join(ROOT, "container", "qa-control.sh"), "utf8");
  const gate = fs.readFileSync(GATE, "utf8");
  const runtimeBlock = entrypoint.slice(entrypoint.indexOf("[ ! -L /run/agenthost-qa ]"),
    entrypoint.indexOf("[ ! -L /run/agenthost-dsh ]"));
  assert.match(runtimeBlock, /if \[ "\$\{AGENTHOST_FOUNDATION_B:-\}" = "1" \]; then/);
  assert.match(runtimeBlock, /install -d -o gate -g gate -m 0700 \/run\/agenthost-qa/);
  assert.doesNotMatch(runtimeBlock, /else/, "flag-off never creates a same-uid QA trigger");
  assert.match(gate, /FOUNDATION_B \? "\/run\/agenthost-qa\/control\.sock" : ""/);
  assert.match(dockerfile, /COPY qa-control\.sh \/usr\/local\/bin\/agenthost-qa/);
  assert.match(dockerfile, /COPY qa-control-linux\.test\.js \/opt\/agenthost\/qa-control-linux\.test\.js/);
  assert.match(dockerfile, /node --test \/opt\/agenthost\/qa-control-linux\.test\.js/,
    "the exact image proves the cross-uid filesystem boundary during its build");
  assert.match(dockerfile, /chmod 0555[^\n]*\/usr\/local\/bin\/agenthost-qa/);
  assert.match(client, /\[ "\$\(id -u\)" -eq 0 \]/, "the client refuses non-root callers");
  assert.match(client, /--unix-socket "\$SOCKET"/);
  assert.match(client, /SOCKET=\/run\/agenthost-qa\/control\.sock/);
  assert.match(client, /status=.*jq -er/);
  assert.match(client, /clean\) exit 0/);
  assert.match(client, /changed\) exit 1/);
  const executableClient = client.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
  assert.doesNotMatch(executableClient, /cookie|TTYD_PASSWORD|two.?fa/i,
    "the local trigger neither reads nor synthesizes an operator credential");
});

test("the gate-private socket runs QA with 2FA enrolled while the public route remains locked", {
  skip: process.platform === "win32" ? "Unix-domain QA control is Linux-only" : false,
}, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gateqa-control-"));
  const socketDir = path.join(home, "qa-control");
  const socketPath = path.join(socketDir, "control.sock");
  const authDir = path.join(home, "auth");
  fs.mkdirSync(path.join(home, "work"), { recursive: true });
  fs.mkdirSync(socketDir, { mode: 0o700 });
  fs.chmodSync(socketDir, 0o700);
  fs.mkdirSync(authDir, { mode: 0o700 });
  fs.writeFileSync(path.join(authDir, "2fa.secret"), "JBSWY3DPEHPK3PXP\n", { mode: 0o600 });
  const script = writeFakeQaScript(home);
  const gate = bootGate(home, {
    QA_RUN_SCRIPT: script,
    AGENTHOST_TEST_QA_CONTROL_SOCKET: socketPath,
    AGENTHOST_AUTH_STATE_DIR: authDir,
  });
  try {
    const base = `http://127.0.0.1:${await gate.port}`;
    await waitForSocket(socketPath);
    assert.equal(fs.lstatSync(socketPath).mode & 0o777, 0o600, "the gate-private socket is mode 0600");

    const localRun = await unixQaRequest(socketPath, "POST", "/qa/run");
    assert.equal(localRun.status, 200);
    assert.equal(localRun.body.status, "clean");
    assert.match(localRun.body.output, /workspace@phone/, "the pass includes the 390px workspace target");

    const localResult = await unixQaRequest(socketPath, "GET", "/qa/result");
    assert.equal(localResult.status, 200);
    assert.equal(localResult.body.summary, localRun.body.summary);
    const unknown = await unixQaRequest(socketPath, "POST", "/not-supported");
    assert.equal(unknown.status, 404, "the root-local surface has an exact two-route allowlist");
    const query = await unixQaRequest(socketPath, "GET", "/qa/result?extra=1");
    assert.equal(query.status, 404, "queries cannot expand the root-local surface");

    const bodyRequest = await new Promise((resolve, reject) => {
      const req = http.request({ socketPath, method: "POST", path: "/qa/run", headers: { "content-length": "2" } }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      });
      req.on("error", reject);
      req.end("{}");
    });
    assert.equal(bodyRequest, 404, "the root-local trigger accepts no caller-controlled body");

    const publicRun = await fetch(base + "/qa/run", {
      method: "POST",
      headers: { origin: base, "sec-fetch-site": "same-origin" },
      redirect: "manual",
    });
    assert.equal(publicRun.status, 401, "the public route still requires the operator cookie");
    const auditLog = fs.readFileSync(path.join(home, ".claude", "agenthost", "audit.log"), "utf8");
    assert.match(auditLog, /"event":"qa_control_requested"/, "the audit distinguishes a root-local trigger");
  } finally {
    await stopChild(gate.child);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a quarantined lane declines the root-local request before spawning the runner", {
  skip: process.platform === "win32" ? "Unix-domain QA control is Linux-only" : false,
}, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gateqa-control-busy-"));
  const socketDir = path.join(home, "qa-control");
  const socketPath = path.join(socketDir, "control.sock");
  const marker = path.join(home, "SPAWNED");
  fs.mkdirSync(path.join(home, "work"), { recursive: true });
  fs.mkdirSync(socketDir, { mode: 0o700 });
  fs.chmodSync(socketDir, 0o700);
  const gate = bootGate(home, {
    QA_RUN_SCRIPT: writeFakeQaScript(home, marker),
    AGENTHOST_TEST_QA_CONTROL_SOCKET: socketPath,
    AGENTHOST_AGENT_LANE_QUARANTINED: "1",
  });
  try {
    await gate.port;
    await waitForSocket(socketPath);
    const declined = await unixQaRequest(socketPath, "POST", "/qa/run");
    assert.equal(declined.status, 409);
    assert.equal(declined.body.status, "declined");
    assert.match(declined.body.error, /lane/i);
    assert.equal(fs.existsSync(marker), false, "the declined control call spawned nothing");
  } finally {
    await stopChild(gate.child);
    fs.rmSync(home, { recursive: true, force: true });
  }
});
