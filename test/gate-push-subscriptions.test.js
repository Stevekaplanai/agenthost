import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stopChild } from "./child-process-helper.js";
import { mintOperatorSession } from "./operator-session-helper.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATE = path.join(HERE, "..", "container", "gate.js");
const PUSH_LIB = createRequire(import.meta.url)(path.join(HERE, "..", "container", "push-lib.js"));
const KEY = "push-subscription-transaction-test-key";
const EXISTING = {
  endpoint: "https://push.example/existing-device",
  expirationTime: null,
  keys: { p256dh: "existing-public-key", auth: "existing-auth-key" },
};
const NEW = {
  endpoint: "https://push.example/new-device",
  expirationTime: null,
  keys: { p256dh: "new-public-key", auth: "new-auth-key" },
};

let fixtureHome;
let gate;
let base;
let cookie;
let subscriptionsFile;

before(async () => {
  fixtureHome = fs.mkdtempSync(path.join(HERE, ".gate-push-"));
  subscriptionsFile = path.join(fixtureHome, ".claude", "agenthost", "push-subs.json");
  fs.mkdirSync(path.dirname(subscriptionsFile), { recursive: true });
  fs.writeFileSync(
    path.join(path.dirname(subscriptionsFile), "vapid.json"),
    JSON.stringify(PUSH_LIB.generateVapidKeys()),
    { mode: 0o600 },
  );
  fs.writeFileSync(subscriptionsFile, JSON.stringify([EXISTING]), { mode: 0o600 });
  gate = spawn(process.execPath, [GATE], {
    env: {
      ...process.env,
      HOME: fixtureHome,
      TTYD_PASSWORD: KEY,
      AGENT_CHAT_BIN: process.execPath,
      GATE_PORT: "0",
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const port = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`gate did not report a port: ${output}`)), 5000);
    gate.stdout.on("data", (chunk) => {
      output += chunk.toString();
      const match = output.match(/listening on (\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    gate.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`gate exited before listening (${code}): ${output}`));
    });
  });
  base = `http://127.0.0.1:${port}`;
  ({ cookie } = await mintOperatorSession(base, KEY));
});

after(async () => {
  await stopChild(gate);
  if (fixtureHome) fs.rmSync(fixtureHome, { recursive: true, force: true });
});

async function post(route, body) {
  const response = await fetch(base + route, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      origin: base,
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

test("push subscription writes commit memory only after durable persistence succeeds", async () => {
  assert.equal((await post("/push/status", { endpoint: EXISTING.endpoint })).body.subscribed, true,
    "a legacy subscription with its original signing key was not preserved during store migration");
  let response = await post("/push/subscribe", EXISTING);
  assert.equal(response.status, 200);
  const firstStore = JSON.parse(fs.readFileSync(subscriptionsFile, "utf8"));
  assert.equal(firstStore.version, 3);
  assert.equal(firstStore.originHost, null);
  assert.equal(firstStore.originReset, false);
  assert.equal(firstStore.signingKeyReset, false);
  assert.match(firstStore.vapidPublicKey, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(firstStore.subscriptions, [EXISTING]);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(subscriptionsFile).mode & 0o777, 0o600);
  }

  fs.rmSync(subscriptionsFile);
  fs.mkdirSync(subscriptionsFile);

  response = await post("/push/unsubscribe", { endpoint: EXISTING.endpoint });
  assert.equal(response.status, 500);
  assert.match(response.body.error, /could not remove subscription/i);
  assert.equal((await post("/push/status", { endpoint: EXISTING.endpoint })).body.subscribed, true,
    "a failed durable removal changed the live subscription list");

  response = await post("/push/subscribe", NEW);
  assert.equal(response.status, 500);
  assert.match(response.body.error, /could not save subscription/i);
  assert.equal((await post("/push/status", { endpoint: NEW.endpoint })).body.subscribed, false,
    "a failed durable add changed the live subscription list");
  assert.equal(fs.existsSync(`${subscriptionsFile}.tmp`), false, "a failed write left a subscription temp file");

  fs.rmSync(subscriptionsFile, { recursive: true });
  response = await post("/push/unsubscribe", { endpoint: EXISTING.endpoint });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true, removed: 1, subs: 0 });
  assert.deepEqual(JSON.parse(fs.readFileSync(subscriptionsFile, "utf8")), {
    ...firstStore,
    subscriptions: [],
  });
});

test("canonical startup retires legacy-origin subscriptions and preserves only canonical re-enrollment", async () => {
  const canonicalHost = "app.agenthost.space";
  const canonicalOrigin = `https://${canonicalHost}`;
  const home = fs.mkdtempSync(path.join(HERE, ".gate-push-origin-"));
  const store = path.join(home, ".claude", "agenthost", "push-subs.json");
  const vapidFile = path.join(home, ".claude", "agenthost", "vapid.json");
  fs.mkdirSync(path.dirname(store), { recursive: true });
  const initialVapid = PUSH_LIB.generateVapidKeys();
  fs.writeFileSync(vapidFile, JSON.stringify(initialVapid), { mode: 0o600 });
  fs.writeFileSync(store, JSON.stringify([EXISTING]), { mode: 0o600 });

  let child = null;
  let port = 0;
  let operatorCookie = "";

  async function boot() {
    child = spawn(process.execPath, [GATE], {
      env: {
        ...process.env,
        HOME: home,
        TTYD_PASSWORD: KEY,
        AGENT_CHAT_BIN: process.execPath,
        GATE_PORT: "0",
        CHANNEL_DISPATCH_PORT: "0",
        KANBAN_BRIDGE_PORT: "0",
        BOARD_AUTONOMY: "off",
        AGENTHOST_CANONICAL_HOST: canonicalHost,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    port = await new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(
        () => reject(new Error(`canonical push fixture did not listen; stdout=${stdout}; stderr=${stderr}`)),
        10_000,
      );
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
        const match = stdout.match(/listening on (\d+)/);
        if (match) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`canonical push fixture exited ${code}; stdout=${stdout}; stderr=${stderr}`));
      });
    });
    const loginBody = JSON.stringify({ key: KEY });
    const login = await request("/session", loginBody, "");
    assert.equal(login.status, 204, login.body);
    operatorCookie = String(login.headers["set-cookie"]?.[0] || "").split(";", 1)[0];
    assert.match(operatorCookie, /^agenthost_auth=/);
  }

  function request(route, body, cookieValue = operatorCookie) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: "127.0.0.1",
        port,
        path: route,
        method: "POST",
        headers: {
          host: canonicalHost,
          "x-forwarded-proto": "https",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          origin: canonicalOrigin,
          "sec-fetch-site": "same-origin",
          ...(cookieValue ? { cookie: cookieValue } : {}),
        },
      }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      });
      req.on("error", reject);
      req.end(body);
    });
  }

  async function postCanonical(route, payload) {
    const response = await request(route, JSON.stringify(payload));
    return {
      status: response.status,
      body: response.body ? JSON.parse(response.body) : null,
    };
  }

  try {
    await boot();
    let status = await postCanonical("/push/status", { endpoint: EXISTING.endpoint });
    assert.equal(status.status, 200);
    assert.deepEqual(status.body, {
      subscribed: false,
      total: 0,
      originReset: true,
      signingKeyReset: false,
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(store, "utf8")), {
      version: 3,
      originHost: canonicalHost,
      originReset: true,
      signingKeyReset: false,
      vapidPublicKey: initialVapid.publicKey,
      subscriptions: [],
    });

    const enrolled = await postCanonical("/push/subscribe", NEW);
    assert.equal(enrolled.status, 200);
    assert.deepEqual(JSON.parse(fs.readFileSync(store, "utf8")), {
      version: 3,
      originHost: canonicalHost,
      originReset: true,
      signingKeyReset: false,
      vapidPublicKey: initialVapid.publicKey,
      subscriptions: [NEW],
    });

    await stopChild(child);
    child = null;
    await boot();
    status = await postCanonical("/push/status", { endpoint: NEW.endpoint });
    assert.deepEqual(status.body, {
      subscribed: true,
      total: 1,
      originReset: true,
      signingKeyReset: false,
    },
      "canonical re-enrollment did not survive a gate restart");
    assert.equal((await postCanonical("/push/status", { endpoint: EXISTING.endpoint })).body.subscribed, false,
      "the retired-origin endpoint returned after restart");

    await stopChild(child);
    child = null;
    fs.rmSync(vapidFile);
    await boot();
    status = await postCanonical("/push/status", { endpoint: NEW.endpoint });
    assert.deepEqual(status.body, {
      subscribed: false,
      total: 0,
      originReset: true,
      signingKeyReset: true,
    }, "a subscription bound to the lost signing key still looked live");
    const rotatedStore = JSON.parse(fs.readFileSync(store, "utf8"));
    assert.equal(rotatedStore.version, 3);
    assert.equal(rotatedStore.originHost, canonicalHost);
    assert.equal(rotatedStore.originReset, true);
    assert.equal(rotatedStore.signingKeyReset, true);
    assert.notEqual(rotatedStore.vapidPublicKey, initialVapid.publicKey);
    assert.deepEqual(rotatedStore.subscriptions, []);
  } finally {
    if (child) await stopChild(child);
    fs.rmSync(home, { recursive: true, force: true });
  }
});
