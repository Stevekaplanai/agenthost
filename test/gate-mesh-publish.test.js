import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { stopChild } from "./child-process-helper.js";
import { mintOperatorSession } from "./operator-session-helper.js";

const GATE = path.join(import.meta.dirname, "..", "container", "gate.js");
const KEY = "mesh-publish-test-key";
const boxes = [];

async function bootGate(peers, { fault = "", seedLegacyThread = false } = {}) {
  const home = fs.mkdtempSync(path.join(import.meta.dirname, ".gate-mesh-publish-"));
  const agenthostDir = path.join(home, ".claude", "agenthost");
  if (seedLegacyThread) {
    fs.mkdirSync(agenthostDir, { recursive: true });
    fs.writeFileSync(
      path.join(agenthostDir, "team-thread.jsonl"),
      `${JSON.stringify({ at: 1, who: "steve", text: "legacy unsequenced message" })}\n`,
    );
  }
  let nodeOptions = process.env.NODE_OPTIONS || "";
  if (fault) {
    const preload = path.join(home, "mesh-storage-fault.cjs");
    fs.writeFileSync(preload, `
const fs = require("node:fs");
const fault = process.env.MESH_PUBLISH_STORAGE_FAULT;
const appendFileSync = fs.appendFileSync;
fs.appendFileSync = function(file, ...args) {
  if (fault === "append" && String(file).endsWith("team-thread.jsonl")) {
    const error = new Error("simulated volume append denied (EACCES)");
    error.code = "EACCES";
    throw error;
  }
  return appendFileSync.call(this, file, ...args);
};
const renameSync = fs.renameSync;
fs.renameSync = function(from, to) {
  if (fault === "migration" && String(to).endsWith("team-thread.jsonl")) {
    const error = new Error("simulated sequence migration rename denied (EACCES)");
    error.code = "EACCES";
    throw error;
  }
  return renameSync.call(this, from, to);
};
`);
    nodeOptions = [nodeOptions, `--require=${preload}`].filter(Boolean).join(" ");
  }
  const child = spawn(process.execPath, [GATE], {
    env: {
      ...process.env,
      HOME: home,
      TTYD_PASSWORD: KEY,
      GATE_PORT: "0",
      CHANNEL_DISPATCH_PORT: "0",
      KANBAN_BRIDGE_PORT: "0",
      BOARD_AUTONOMY: "off",
      AGENTHOST_MESH_PEERS: JSON.stringify(peers),
      MESH_PUBLISH_STORAGE_FAULT: fault,
      ...(nodeOptions ? { NODE_OPTIONS: nodeOptions } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const base = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`gate did not listen; stdout=${stdout}; stderr=${stderr}`)), 15_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const match = stdout.match(/listening on (\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`gate exited ${code}; stdout=${stdout}; stderr=${stderr}`));
    });
  });
  const { cookie } = await mintOperatorSession(base, KEY);
  const box = { home, child, base, cookie };
  boxes.push(box);
  return box;
}

function publish(box, body, withCookie = true) {
  return fetch(`${box.base}/cc/mesh/message`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: box.base,
      "sec-fetch-site": "same-origin",
      ...(withCookie ? { cookie: box.cookie } : {}),
    },
    body: JSON.stringify(body),
    redirect: "manual",
  });
}

function authed(box, pathname, init = {}) {
  return fetch(box.base + pathname, {
    ...init,
    headers: { cookie: box.cookie, origin: box.base, "sec-fetch-site": "same-origin", ...(init.headers || {}) },
    redirect: "manual",
  });
}

function beginSlowPublish(box, messageId) {
  const target = new URL(box.base);
  let request;
  const response = new Promise((resolve, reject) => {
    request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: "/cc/mesh/message",
      method: "POST",
      headers: { cookie: box.cookie, origin: box.base, "sec-fetch-site": "same-origin", "content-type": "application/json" },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      }));
    });
    request.on("error", reject);
    request.write(`{"messageId":${JSON.stringify(messageId)},`);
  });
  return {
    response,
    finish(text) { request.end(`"text":${JSON.stringify(text)}}`); },
  };
}

let paired;
let unpaired;

before(async () => {
  paired = await bootGate({ laptop: "secret-one", studio: "secret-two" });
  unpaired = await bootGate({});
});

after(async () => {
  for (const box of boxes) {
    await stopChild(box.child);
    fs.rmSync(box.home, { recursive: true, force: true });
  }
});

test("operator mesh publishing is authenticated, bounded, durable, and idempotent", async () => {
  assert.equal((await publish(paired, { messageId: "m-auth", text: "hello" }, false)).status, 401);

  for (const [body, cause] of [
    [{ messageId: "m-empty", text: "   " }, /text.*empty|message.*empty/i],
    [{ messageId: "bad id", text: "hello" }, /messageId.*invalid/i],
    [{ messageId: "m-long", text: "x".repeat(4001) }, /text.*4000|too long/i],
  ]) {
    const response = await publish(paired, body);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, cause);
  }

  const message = { messageId: "m-once", text: "Please pick this up from the shared thread." };
  const first = await publish(paired, message);
  assert.equal(first.status, 200);
  const receipt = await first.json();
  assert.equal(receipt.status, "published");
  assert.equal(receipt.messageId, message.messageId);
  assert.deepEqual(receipt.peers, ["laptop", "studio"]);
  assert.match(receipt.summary, /durable shared thread/i);
  assert.match(receipt.summary, /next authenticated mesh pull/i);
  assert.doesNotMatch(JSON.stringify(receipt), /secret-one|secret-two|delivered immediately|private/i);

  const retry = await publish(paired, message);
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).status, "published");

  const thread = await (await authed(paired, "/chat/thread")).json();
  const recorded = thread.entries.filter((entry) => entry.id === "mesh-operator:m-once");
  assert.equal(recorded.length, 1, "an idempotent retry appends exactly once");
  assert.deepEqual(
    { who: recorded[0].who, text: recorded[0].text, to: recorded[0].to },
    { who: "steve", text: message.text, to: "mesh" },
  );

  const conflict = await publish(paired, { messageId: message.messageId, text: "different text" });
  assert.equal(conflict.status, 409);
  assert.match((await conflict.json()).error, /messageId.*different text|already.*different/i);

  const unicode = { messageId: "m-unicode", text: "\u754c".repeat(4000) };
  const unicodeResponse = await publish(paired, unicode);
  assert.equal(unicodeResponse.status, 200, "4000 Unicode characters fit the documented character limit");
  assert.equal((await unicodeResponse.json()).status, "published");

  const auditFile = path.join(paired.home, ".claude", "agenthost", "audit.log");
  const audits = fs.readFileSync(auditFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(
    audits.filter((entry) => entry.event === "mesh_operator_published" && entry.detail.startsWith("m-once:")).length,
    1,
  );
});

test("operator mesh publishing refuses no-peers and LOCKED states by cause", async () => {
  const noPeers = await publish(unpaired, { messageId: "m-none", text: "hello" });
  assert.equal(noPeers.status, 409);
  assert.match((await noPeers.json()).error, /no configured mesh peers/i);

  const lock = await authed(paired, "/cc/mesh-state/lock", { method: "POST" });
  assert.equal(lock.status, 200);
  const locked = await publish(paired, { messageId: "m-locked", text: "hello" });
  assert.equal(locked.status, 423);
  assert.match((await locked.json()).error, /locked/i);
});

test("operator mesh publishing reports durable-thread storage causes as JSON", async () => {
  const migrationFault = await bootGate(
    { laptop: "secret-one" },
    { fault: "migration", seedLegacyThread: true },
  );
  const migration = await publish(migrationFault, { messageId: "m-migration", text: "hello" });
  assert.equal(migration.status, 503);
  assert.match((await migration.json()).error, /sequence migration/i);

  const appendFault = await bootGate({ laptop: "secret-one" }, { fault: "append" });
  const append = await publish(appendFault, { messageId: "m-append", text: "hello" });
  assert.equal(append.status, 503);
  const appendCause = (await append.json()).error;
  assert.match(appendCause, /simulated volume append denied.*EACCES/i);
  assert.doesNotMatch(appendCause, /secret-one|\.gate-mesh-publish-/i);
});

test("LOCKED wins when the box locks while a publish body is still arriving", async () => {
  const box = await bootGate({ laptop: "secret-one" });
  const slow = beginSlowPublish(box, "m-lock-race");
  await new Promise((resolve) => setTimeout(resolve, 75));

  const lock = await authed(box, "/cc/mesh-state/lock", { method: "POST" });
  assert.equal(lock.status, 200);
  assert.equal((await lock.json()).locked, true);

  slow.finish("must not land after LOCKED");
  const refused = await slow.response;
  assert.equal(refused.status, 423);
  assert.match(refused.body.error, /locked/i);

  const thread = await (await authed(box, "/chat/thread")).json();
  assert.equal(
    thread.entries.some((entry) => entry.id === "mesh-operator:m-lock-race"),
    false,
    "a publish that loses the LOCK race must not reach the durable thread",
  );
});
