// Focused Phase 4 integration proof. This boots the real gate with an isolated
// HOME and real SQLite claim rows; it deliberately needs no Hermes process.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { mintOperatorSession } from "./operator-session-helper.js";

const require = createRequire(import.meta.url);
const { ClaimStore } = require("../container/claim-store.js");
const GATE = path.join(import.meta.dirname, "..", "container", "gate.js");
const KEY = "phase4-claim-scheduler-test";

function bootGate(home) {
  const child = spawn(process.execPath, [GATE], {
    env: {
      ...process.env,
      HOME: home,
      TTYD_PASSWORD: KEY,
      AGENT_CHAT_BIN: process.execPath,
      GATE_PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const port = new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("gate did not report its port: " + output)), 5_000);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      const match = output.match(/listening on (\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error("gate exited before listening (" + code + "): " + output));
    });
  });
  return { child, port };
}

async function stopGate(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function post(base, cookie, route, body) {
  return fetch(base + route, {
    method: "POST",
    headers: {
      cookie,
      "Content-Type": "application/json",
      origin: base,
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify(body),
    redirect: "manual",
  });
}

test("Phase 4 protects live and recovering durable claims before review or freeze reaches Hermes", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-phase4-claims-"));
  const agenthost = path.join(home, ".claude", "agenthost");
  fs.mkdirSync(path.join(home, "work"), { recursive: true });
  fs.mkdirSync(agenthost, { recursive: true });
  const store = new ClaimStore(path.join(agenthost, "board-claims.sqlite"));
  const now = Date.now();
  const live = store.tryAcquire({
    taskId: "t_live", engine: "codex", ttlMs: 60_000,
    schedulerGeneration: 1, nowMs: now,
  });
  assert.equal(live.status, "success");
  const old = store.tryAcquire({
    taskId: "t_recovering", engine: "codex", ttlMs: 1_000,
    schedulerGeneration: 1, nowMs: 1_000,
  });
  assert.equal(old.status, "success");
  const recovery = store.beginRecovery(old.holder, { nowMs: 2_000 });
  assert.equal(recovery.status, "warning");
  assert.equal(store.inspect("t_recovering").claim.state, "recovering");
  store.close();

  let gate;
  try {
    gate = bootGate(home);
    const base = `http://127.0.0.1:${await gate.port}`;
    const { cookie } = await mintOperatorSession(base, KEY);

    for (const taskId of ["t_live", "t_recovering"]) {
      const review = await post(base, cookie, "/board/task/" + taskId + "/review", { action: "approve" });
      assert.equal(review.status, 409, taskId + ": review is denied before any Hermes command");
      const reviewBody = await review.json();
      assert.equal(reviewBody.error.code, "claim_recovery_required");
      assert.match(reviewBody.summary, /protected scheduler ownership/i);

      // This immediately follows the denied review. A second 409 proves the
      // first route released its mutation lock instead of leaving the card stuck.
      const freeze = await post(base, cookie, "/board/task/" + taskId + "/freeze", {});
      assert.equal(freeze.status, 409, taskId + ": freeze is denied before any Hermes command");
      const freezeBody = await freeze.json();
      assert.equal(freezeBody.error.code, "claim_recovery_required");
      assert.match(freezeBody.error.root_cause, /cannot prove the prior worker stopped/i);
    }
  } finally {
    if (gate) await stopGate(gate.child);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Phase 4 fails closed when the durable claim store cannot be read", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-phase4-unreadable-"));
  const agenthost = path.join(home, ".claude", "agenthost");
  fs.mkdirSync(path.join(home, "work"), { recursive: true });
  fs.mkdirSync(agenthost, { recursive: true });
  // A directory where SQLite's claim file belongs makes only the ClaimStore
  // unreadable; session and 2FA state in the parent directory remain healthy.
  fs.mkdirSync(path.join(agenthost, "board-claims.sqlite"));

  let gate;
  try {
    gate = bootGate(home);
    const base = `http://127.0.0.1:${await gate.port}`;
    const { cookie } = await mintOperatorSession(base, KEY);

    for (const route of ["/board/task/t_unknown/review", "/board/task/t_unknown/freeze"]) {
      const body = route.endsWith("/review") ? { action: "approve" } : {};
      const response = await post(base, cookie, route, body);
      assert.equal(response.status, 503, route + ": the unknown claim state is never treated as unclaimed");
      const json = await response.json();
      assert.equal(json.error.code, "claim_store_unavailable");
      assert.match(json.error.root_cause, /cannot prove that no worker still owns the task/i);
    }
  } finally {
    if (gate) await stopGate(gate.child);
    fs.rmSync(home, { recursive: true, force: true });
  }
});
