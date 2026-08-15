// E2E tests against the REAL gate.js for the Continuity provider routes
// (CONT-01, docs/continuity/CONTRACT.md). Like gate-command-center, this boots
// the actual gate as a subprocess and hits the real routes -- so a field rename
// or a broken wire-up fails here, not silently in production. No Kimi, no
// network, no credential: CONT-01 is dormant, and these tests prove it stays
// that way while the routes are genuinely reachable behind the cookie wall.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { mintOperatorSession } from "./operator-session-helper.js";
import { stopChild } from "./child-process-helper.js";

const GATE = path.join(import.meta.dirname, "..", "container", "gate.js");
const KEY = "gate-cont-test-key";
const box = {};

function bootGate(home, extraEnv) {
  const child = spawn("node", [GATE], {
    env: { ...process.env, HOME: home, TTYD_PASSWORD: KEY, AGENT_CHAT_BIN: "/bin/true", GATE_PORT: "0", ...extraEnv },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const port = new Promise((resolve, reject) => {
    let out = "";
    const to = setTimeout(() => reject(new Error("gate did not report its port; got: " + out)), 5000);
    child.stdout.on("data", (c) => {
      out += c.toString();
      const m = out.match(/listening on (\d+)/);
      if (m) { clearTimeout(to); resolve(Number(m[1])); }
    });
    child.on("exit", () => { clearTimeout(to); reject(new Error("gate exited before listening; got: " + out)); });
  });
  return { child, port };
}

before(async () => {
  const home = fs.mkdtempSync(path.join(import.meta.dirname, ".gatecont-"));
  fs.mkdirSync(path.join(home, "work"), { recursive: true });
  const { child, port } = bootGate(home, {});
  box.home = home;
  box.gate = child;
  box.base = `http://127.0.0.1:${await port}`;
  box.cookie = (await mintOperatorSession(box.base, KEY)).cookie;
});

after(async () => {
  if (box.gate) await stopChild(box.gate, "SIGKILL");
  if (box.home) fs.rmSync(box.home, { recursive: true, force: true });
});

const get = (p) => fetch(box.base + p, { headers: { cookie: box.cookie }, redirect: "manual" });
const post = (p, body) => fetch(box.base + p, { method: "POST", headers: { cookie: box.cookie, origin: box.base, "Content-Type": "application/json" }, body: JSON.stringify(body), redirect: "manual" });

test("provider + profile routes require login", async () => {
  for (const p of ["/api/continuity/providers", "/api/continuity/profiles"]) {
    const r = await fetch(box.base + p, { redirect: "manual" });
    assert.equal(r.status, 401, `${p} requires login`);
  }
});

test("GET /api/continuity/providers returns the dormant registry, no secret", async () => {
  const r = await get("/api/continuity/providers");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  const body = await r.json();
  assert.equal(body.status, "success");
  assert.ok(Array.isArray(body.artifacts));
  const ids = body.artifacts.map((a) => a.id);
  assert.deepEqual(ids, ["anthropic", "openai", "google", "ollama", "moonshot", "deepseek"]);

  const moonshot = body.artifacts.find((a) => a.id === "moonshot");
  assert.equal(moonshot.data.enabled, false);       // dormant default
  assert.equal(moonshot.data.credentialReady, false); // no KIMI_API_KEY seeded
  assert.equal(moonshot.data.state, "disabled");
  assert.equal(moonshot.data.reachable, null);        // never measured

  // No credential value or writable transport field ever appears.
  const raw = JSON.stringify(body);
  for (const leak of ["credentialValue", "apiKey", "Authorization", "Bearer"]) {
    assert.equal(raw.includes(leak), false, `response must not contain ${leak}`);
  }
});

test("GET /api/continuity/profiles shows Kimi granting nothing", async () => {
  const r = await get("/api/continuity/profiles");
  assert.equal(r.status, 200);
  const body = await r.json();
  const kimi = body.artifacts.find((a) => a.id === "kimi");
  assert.equal(kimi.data.capabilities.chat.state, "unavailable");
  assert.equal(kimi.data.capabilities.terminal.state, "unavailable");
  assert.equal(kimi.data.capabilities.gitMaxRung.value, 0);
});

test("connection test is spend-gated and fails closed before any network", async () => {
  // Missing confirmSpend -> spend gate, no network.
  const noConfirm = await post("/api/continuity/providers/moonshot/test", {});
  assert.equal(noConfirm.status, 400);
  const b1 = await noConfirm.json();
  assert.equal(b1.error.code, "SPEND_CONFIRMATION_REQUIRED");

  // Caller-supplied transport fields -> hard reject.
  const injected = await post("/api/continuity/providers/moonshot/test", { confirmSpend: true, url: "https://evil.example", headers: { Authorization: "Bearer x" } });
  assert.equal(injected.status, 400);
  assert.equal((await injected.json()).error.code, "REQUEST_INVALID");

  // Runtime-fixed provider -> unsupported.
  const fixed = await post("/api/continuity/providers/anthropic/test", { confirmSpend: true });
  assert.equal(fixed.status, 400);
  assert.equal((await fixed.json()).error.code, "ACTION_UNSUPPORTED");

  // Confirmed but disabled + dormant -> disabled (never a live call in CONT-01).
  const disabled = await post("/api/continuity/providers/moonshot/test", { confirmSpend: true });
  assert.equal(disabled.status, 400);
  assert.equal((await disabled.json()).error.code, "PROVIDER_DISABLED");
});

test("existing /api/settings still works (no regression), now carrying v6", async () => {
  const r = await get("/api/settings");
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.settings.v, 6);
  assert.equal(body.settings.providers.moonshot.enabled, false);
  // Channels still flow through the v6 API, all off by default.
  assert.equal(body.settings.channels.telegram.enabled, false);
  assert.equal(body.settings.channels.whatsapp.owner, "hermes");
  // Pre-v4 behavior intact.
  assert.equal(body.settings.cost.perChainUsd, 15);
  assert.equal(body.settings.services.ollama.enabled, true);
});
