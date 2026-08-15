// Behavioral proof for claw-setup's fixed credential provisioner. The setup
// shell never writes secrets.env; a loopback-only gate endpoint generates the
// two exact names through the same atomic writer as authenticated POST /secret.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stopChild } from "./child-process-helper.js";
import { mintOperatorSession } from "./operator-session-helper.js";

const ROOT = path.join(import.meta.dirname, "..");
const GATE = path.join(ROOT, "container", "gate.js");
const CLAW_SETUP = path.join(ROOT, "container", "claw-setup.sh");
const SECRET_ENV = path.join(ROOT, "container", "secret-env.sh");
const bash = process.platform === "win32"
  ? "C:\\Program Files\\Git\\bin\\bash.exe"
  : "bash";

let home;
let secretsDir;
let secretsFile;
let gate;
let publicBase;
let internalBase;
let cookie;
let gateOutput = "";
const responseBodies = [];

function bashPath(value) {
  if (process.platform !== "win32") return value;
  const normalized = path.resolve(value).replaceAll("\\", "/");
  return "/" + normalized[0].toLowerCase() + normalized.slice(2);
}

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-secret-provision-"));
  fs.mkdirSync(path.join(home, "work"), { recursive: true });
  secretsDir = path.join(home, "box-secrets");
  secretsFile = path.join(secretsDir, "secrets.env");
  fs.mkdirSync(secretsDir);

  gate = spawn(process.execPath, [GATE], {
    env: {
      ...process.env,
      HOME: home,
      AGENTHOST_BOX_SECRETS_FILE: secretsFile,
      TTYD_PASSWORD: "openclaw-provision-test-key",
      AGENT_CHAT_BIN: process.execPath,
      GATE_PORT: "0",
      CHANNEL_DISPATCH_PORT: "0",
      KANBAN_BRIDGE_PORT: "0",
      CHANNEL_HEALTH_WATCH: "off",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const ports = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("gate did not report both ports: " + gateOutput)), 8000);
    const check = () => {
      const publicMatch = gateOutput.match(/listening on (\d+)/);
      const internalMatch = gateOutput.match(/channel-dispatch bound on 127\.0\.0\.1:(\d+)/);
      if (!publicMatch || !internalMatch) return;
      clearTimeout(timer);
      resolve({ publicPort: Number(publicMatch[1]), internalPort: Number(internalMatch[1]) });
    };
    gate.stdout.on("data", (chunk) => { gateOutput += chunk.toString(); check(); });
    gate.stderr.on("data", (chunk) => { gateOutput += chunk.toString(); check(); });
    gate.on("exit", () => {
      clearTimeout(timer);
      reject(new Error("gate exited before listening: " + gateOutput));
    });
  });

  publicBase = `http://127.0.0.1:${ports.publicPort}`;
  internalBase = `http://127.0.0.1:${ports.internalPort}`;
  cookie = (await mintOperatorSession(publicBase, "openclaw-provision-test-key")).cookie;
});

after(async () => {
  await stopChild(gate);
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

async function provision({ method = "POST", header = true, body } = {}) {
  const headers = {};
  if (header) headers["x-agenthost-openclaw-setup"] = "1";
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(internalBase + "/internal/openclaw-secrets/ensure", {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  responseBodies.push(text);
  return { status: response.status, json: text ? JSON.parse(text) : null, text };
}

async function store(name, value) {
  const response = await fetch(publicBase + "/secret", {
    method: "POST",
    headers: {
      cookie,
      origin: publicBase,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
    body: JSON.stringify({ name, value }),
  });
  const text = await response.text();
  responseBodies.push(text);
  return { status: response.status, json: JSON.parse(text), text };
}

function entriesOnDisk() {
  return fs.readFileSync(secretsFile, "utf8").trim().split("\n").map((line) => {
    const split = line.indexOf("=");
    return [line.slice(0, split), line.slice(split + 1)];
  });
}

test("the fixed endpoint refuses the wrong verb, missing intent header, and request data", async () => {
  assert.equal((await provision({ method: "GET" })).status, 405);
  assert.equal((await provision({ header: false })).status, 403);
  const withBody = await provision({ body: { name: "ATTACKER_TOKEN", value: "caller-controlled" } });
  assert.equal(withBody.status, 400);
  assert.match(withBody.json.error, /accepts no request body/);
  assert.equal(fs.existsSync(secretsFile), false, "rejected requests do not create the store");
});

test("concurrent setup calls and POST /secret serialize without duplicates or lost values", async () => {
  const unrelatedValue = "dashboard-write-survives-concurrency";
  const results = await Promise.all([
    ...Array.from({ length: 24 }, () => provision()),
    store("UNRELATED_TOKEN", unrelatedValue),
  ]);
  for (const result of results) assert.equal(result.status, 200, result.text);

  const provisionResults = results.slice(0, 24).map((result) => result.json);
  assert.equal(provisionResults.flatMap((result) => result.created).length, 2,
    "exactly one serialized call creates the two missing names");
  for (const result of provisionResults) {
    assert.deepEqual(result.secrets, [
      { name: "OPENCLAW_GATEWAY_TOKEN", present: true },
      { name: "CHANNEL_DISPATCH_TOKEN", present: true },
    ]);
    assert.equal(Object.hasOwn(result, "value"), false);
  }

  const entries = entriesOnDisk();
  const names = entries.map(([name]) => name);
  assert.equal(new Set(names).size, names.length, "the persisted store contains no duplicate name");
  assert.deepEqual(new Set(names), new Set([
    "OPENCLAW_GATEWAY_TOKEN", "CHANNEL_DISPATCH_TOKEN", "UNRELATED_TOKEN",
  ]));
  const stored = Object.fromEntries(entries);
  assert.equal(stored.UNRELATED_TOKEN, unrelatedValue, "the concurrent dashboard write is not lost");
  assert.match(stored.OPENCLAW_GATEWAY_TOKEN, /^[0-9a-f]{64}$/);
  assert.match(stored.CHANNEL_DISPATCH_TOKEN, /^[0-9a-f]{64}$/);
  assert.notEqual(stored.OPENCLAW_GATEWAY_TOKEN, stored.CHANNEL_DISPATCH_TOKEN);

  const before = fs.readFileSync(secretsFile, "utf8");
  const repeated = await provision();
  assert.deepEqual(repeated.json.created, [], "a rerun reuses both existing values");
  assert.equal(fs.readFileSync(secretsFile, "utf8"), before, "an idempotent rerun does not rewrite the file");

  const audit = fs.readFileSync(path.join(home, ".claude", "agenthost", "audit.log"), "utf8");
  const publicOutput = responseBodies.join("\n") + "\n" + audit + "\n" + gateOutput;
  for (const value of [stored.OPENCLAW_GATEWAY_TOKEN, stored.CHANNEL_DISPATCH_TOKEN, unrelatedValue]) {
    assert.equal(publicOutput.includes(value), false, "credential values never enter responses, audits, or logs");
  }
});

test("unsafe or corrupt stores fail closed without changing their targets", async (t) => {
  fs.unlinkSync(secretsFile);
  const victim = path.join(home, "victim.env");
  fs.writeFileSync(victim, "VICTIM_TOKEN=unchanged\n");

  let linked = false;
  try {
    fs.symlinkSync(victim, secretsFile, "file");
    linked = true;
  } catch (error) {
    t.diagnostic("symlink proof skipped on this host: " + error.message);
  }
  if (linked) {
    const refused = await provision();
    assert.equal(refused.status, 409);
    assert.match(refused.json.error, /symbolic link/);
    assert.equal(fs.readFileSync(victim, "utf8"), "VICTIM_TOKEN=unchanged\n");
    fs.unlinkSync(secretsFile);
  }

  fs.writeFileSync(secretsFile, "A=" + "x".repeat(256 * 1024));
  const oversized = await provision();
  assert.equal(oversized.status, 409);
  assert.match(oversized.json.error, /256 KiB/);

  fs.writeFileSync(secretsFile, "not-an-entry\n");
  const malformed = await provision();
  assert.equal(malformed.status, 409);
  assert.match(malformed.json.error, /malformed entry at line 1/);
  assert.equal(malformed.text.includes("not-an-entry"), false,
    "a corrupt line's contents do not enter the error response");

  fs.unlinkSync(secretsFile);
  fs.rmdirSync(secretsDir);
  const missingParent = await provision();
  assert.equal(missingParent.status, 500);
  assert.match(missingParent.json.error, /directory is missing/);
  assert.equal(fs.existsSync(secretsFile), false, "the gate never invents an unowned parent directory");
});

test("claw-setup stops on provision failure without claiming credentials are ready", (t) => {
  if (!fs.existsSync(bash) && process.platform === "win32") {
    return t.skip("Git Bash is unavailable on this Windows host");
  }
  const source = fs.readFileSync(CLAW_SETUP, "utf8");
  assert.doesNotMatch(source, />>\s*"\$SECRETS_ENV"|grep[^\n]*SECRETS_ENV|touch[^\n]*SECRETS_ENV/,
    "claw-setup has no direct protected-store writer or parser");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claw-setup-failure-"));
  try {
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    const fakeOpenClaw = path.join(bin, "openclaw");
    fs.writeFileSync(fakeOpenClaw, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(fakeOpenClaw, 0o755);
    const env = { ...process.env };
    delete env.BASH_ENV;
    delete env.ENV;
    env.HOME = bashPath(root);
    env.PATH = bashPath(bin) + ":" + String(process.env.PATH || "");
    fs.rmSync(secretsDir, { recursive: true, force: true });
    env.CHANNEL_DISPATCH_PORT = new URL(internalBase).port;
    env.AGENTHOST_BOX_SECRETS_FILE = bashPath(secretsFile);
    const localClawSetup = path.join(root, "claw-setup.sh");
    fs.writeFileSync(localClawSetup, source.replace(
      ". /opt/agenthost/secret-env.sh",
      `. "${bashPath(SECRET_ENV)}"`,
    ));
    const ran = spawnSync(bash, [bashPath(localClawSetup)], { env, encoding: "utf8", timeout: 10000 });
    assert.notEqual(ran.status, 0);
    assert.match(ran.stderr, /governance gate refused OpenClaw credential provisioning/);
    assert.match(ran.stderr, /directory is missing/,
      "the setup shell discarded the gate's safe structural cause");
    assert.doesNotMatch(ran.stdout, /authentication are ready|Minted .* saved/,
      "a failed gate call never prints a success statement");
    assert.equal(fs.existsSync(secretsFile), false,
      "the setup shell does not fall back to creating an unowned secret store");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
