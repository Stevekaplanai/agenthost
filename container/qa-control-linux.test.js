"use strict";

// Exact-image proof for the QA control boundary. The gate uid owns a 0700
// parent and 0600 Unix socket; root can call it, while the untrusted agent uid
// must receive EACCES before any HTTP request reaches the listener.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

if (process.argv[2] === "--serve") {
  const socketPath = process.argv[3];
  const responseMode = process.argv[4] || "probe";
  let requestCount = 0;
  const server = http.createServer((_req, res) => {
    if (responseMode === "client-sequence") {
      const replies = [
        { code: 200, body: { status: "clean", summary: "unchanged" } },
        { code: 200, body: { status: "changed", summary: "visual change" } },
        { code: 409, body: { status: "declined", error: "the shared agent lane is busy" } },
        { code: 503, body: { status: "failed", error: "the QA runner is unavailable" } },
      ];
      const reply = replies[Math.min(requestCount++, replies.length - 1)];
      res.writeHead(reply.code, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(reply.body));
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
  });
  server.listen(socketPath, () => {
    fs.chmodSync(socketPath, 0o600);
    process.stdout.write("ready\n");
  });
  const close = () => server.close(() => process.exit(0));
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
} else {
  function numericId(flag, name) {
    const result = spawnSync("id", [flag, name], { encoding: "utf8" });
    if (result.status !== 0) throw new Error("could not resolve " + name + ": " + result.stderr);
    return Number(result.stdout.trim());
  }

  function waitForReady(child, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("socket owner did not become ready: " + output)), timeoutMs);
      child.stdout.on("data", (chunk) => {
        output += chunk.toString();
        if (output.includes("ready\n")) { clearTimeout(timer); resolve(); }
      });
      child.stderr.on("data", (chunk) => { output += chunk.toString(); });
      child.once("exit", (code) => { clearTimeout(timer); reject(new Error("socket owner exited " + code + ": " + output)); });
    });
  }

  function stop(child) {
    return new Promise((resolve) => {
      if (!child || child.exitCode !== null) return resolve();
      const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      child.kill("SIGTERM");
    });
  }

  test("root reaches the gate-owned QA socket and agent is denied by kernel DAC", {
    skip: process.platform !== "linux" || typeof process.getuid !== "function" || process.getuid() !== 0
      ? "requires the root exact-image Linux build"
      : false,
  }, async () => {
    const gateUid = numericId("-u", "gate");
    const gateGid = numericId("-g", "gate");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-qa-control-"));
    const socketPath = path.join(root, "control.sock");
    fs.chownSync(root, gateUid, gateGid);
    fs.chmodSync(root, 0o700);
    const owner = spawn("setpriv", [
      "--reuid=gate", "--regid=gate", "--init-groups",
      process.execPath, __filename, "--serve", socketPath,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    try {
      await waitForReady(owner);
      const parent = fs.lstatSync(root);
      const socket = fs.lstatSync(socketPath);
      assert.equal(parent.uid, gateUid);
      assert.equal(parent.gid, gateGid);
      assert.equal(parent.mode & 0o777, 0o700);
      assert.ok(socket.isSocket());
      assert.equal(socket.uid, gateUid);
      assert.equal(socket.gid, gateGid);
      assert.equal(socket.mode & 0o777, 0o600);

      const rootCall = spawnSync("curl", ["--silent", "--show-error", "--unix-socket", socketPath, "http://localhost/probe"], {
        encoding: "utf8",
      });
      assert.equal(rootCall.status, 0, rootCall.stderr);
      assert.equal(rootCall.stdout, '{"ok":true}');

      const probe = "const net=require('net');const s=net.createConnection(process.argv[1]);"
        + "s.on('connect',()=>process.exit(0));s.on('error',(e)=>{console.error(e.code);process.exit(e.code==='EACCES'?42:43)});";
      const agentCall = spawnSync("setpriv", [
        "--reuid=agent", "--regid=agent", "--init-groups",
        process.execPath, "-e", probe, socketPath,
      ], { encoding: "utf8" });
      assert.equal(agentCall.status, 42, "agent unexpectedly reached the QA socket: " + agentCall.stderr);
      assert.match(agentCall.stderr, /EACCES/);
    } finally {
      await stop(owner);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("the installed root client keeps stable clean, changed, and failure exit codes", {
    skip: process.platform !== "linux" || typeof process.getuid !== "function" || process.getuid() !== 0
      || fs.existsSync("/run/agenthost-qa")
      ? "requires a root exact-image build with no live QA control directory"
      : false,
  }, async () => {
    const gateUid = numericId("-u", "gate");
    const gateGid = numericId("-g", "gate");
    const runtimeDir = "/run/agenthost-qa";
    const socketPath = path.join(runtimeDir, "control.sock");
    fs.mkdirSync(runtimeDir, { mode: 0o700 });
    fs.chownSync(runtimeDir, gateUid, gateGid);
    fs.chmodSync(runtimeDir, 0o700);
    const owner = spawn("setpriv", [
      "--reuid=gate", "--regid=gate", "--init-groups",
      process.execPath, __filename, "--serve", socketPath, "client-sequence",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    try {
      await waitForReady(owner);
      const client = "/usr/local/bin/agenthost-qa";
      const clean = spawnSync(client, ["run"], { encoding: "utf8" });
      assert.equal(clean.status, 0, clean.stderr);
      assert.match(clean.stdout, /"status":"clean"/);
      const changed = spawnSync(client, ["run"], { encoding: "utf8" });
      assert.equal(changed.status, 1, changed.stderr);
      assert.match(changed.stdout, /"status":"changed"/);
      const declined = spawnSync(client, ["run"], { encoding: "utf8" });
      assert.equal(declined.status, 2, "busy lane must be a stable QA failure, not curl status " + declined.status);
      assert.match(declined.stdout, /shared agent lane is busy/);
      const failed = spawnSync(client, ["run"], { encoding: "utf8" });
      assert.equal(failed.status, 2, "server failure must be a stable QA failure, not curl status " + failed.status);
      assert.match(failed.stdout, /QA runner is unavailable/);
    } finally {
      await stop(owner);
      try { fs.unlinkSync(socketPath); } catch (error) { if (!error || error.code !== "ENOENT") throw error; }
      fs.rmdirSync(runtimeDir);
    }
  });
}
