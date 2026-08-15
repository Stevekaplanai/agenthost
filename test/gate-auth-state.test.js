import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stopChild } from "./child-process-helper.js";

const GATE = path.join(import.meta.dirname, "..", "container", "gate.js");
const KEY = "protected-auth-state-test-key";

async function startGate(home, authDir) {
  const child = spawn(process.execPath, [GATE], {
    env: {
      ...process.env,
      HOME: home,
      AGENTHOST_AUTH_STATE_DIR: authDir,
      TTYD_PASSWORD: KEY,
      AGENT_CHAT_BIN: process.platform === "win32" ? process.execPath : "/bin/true",
      GATE_PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`gate did not report a port: ${output}`)), 7000);
    const read = (chunk) => {
      output += chunk.toString();
      const match = output.match(/listening on (\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`gate exited ${code} before listening: ${output}`));
    });
  });
  return { child, base: `http://127.0.0.1:${port}` };
}

async function login(base, key = KEY, extra = {}) {
  const response = await fetch(`${base}/session`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: base,
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify({ key, ...extra }),
    redirect: "manual",
  });
  return {
    status: response.status,
    cookie: String(response.headers.get("set-cookie") || "").split(";", 1)[0],
  };
}

function cookieFromKnownState(secret, generation, key) {
  return crypto.createHmac("sha256", secret)
    .update("auth-session\0")
    .update(generation)
    .update("\0")
    .update(key)
    .digest("base64url");
}

test("the real gate persists auth state only in the protected directory and ignores agent-home signing bytes", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-protected-auth-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const authDir = path.join(root, "protected", "auth");
  fs.mkdirSync(path.join(home, "work"), { recursive: true });
  fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });

  let running = null;
  let firstLogin;
  let protectedSecret;
  let protectedGeneration;
  try {
    running = await startGate(home, authDir);
    firstLogin = await login(running.base);
    assert.equal(firstLogin.status, 204);
    assert.match(firstLogin.cookie, /^agenthost_auth=/);
    protectedSecret = fs.readFileSync(path.join(authDir, "gate.secret"), "utf8").trim();
    protectedGeneration = fs.readFileSync(path.join(authDir, "auth.session-generation"), "utf8").trim();
    assert.match(protectedSecret, /^[a-f0-9]{64}$/);
    assert.match(protectedGeneration, /^[a-f0-9]{64}$/);
    assert.equal(fs.existsSync(path.join(home, ".claude", "agenthost", "gate.secret")), false);
  } finally {
    await stopChild(running && running.child);
    running = null;
  }

  const legacyDir = path.join(home, ".claude", "agenthost");
  fs.mkdirSync(legacyDir, { recursive: true });
  const plantedSecret = "1".repeat(64);
  const plantedGeneration = "2".repeat(64);
  fs.writeFileSync(path.join(legacyDir, "gate.secret"), `${plantedSecret}\n`);
  fs.writeFileSync(path.join(legacyDir, "auth.session-generation"), `${plantedGeneration}\n`);

  try {
    running = await startGate(home, authDir);
    assert.equal(fs.readFileSync(path.join(authDir, "gate.secret"), "utf8").trim(), protectedSecret);
    assert.equal(fs.readFileSync(path.join(authDir, "auth.session-generation"), "utf8").trim(), protectedGeneration);

    const realCookieResponse = await fetch(`${running.base}/autonomy`, {
      headers: { cookie: firstLogin.cookie },
      redirect: "manual",
    });
    assert.equal(realCookieResponse.status, 200, "stable protected state preserves an existing operator session");

    const forged = cookieFromKnownState(plantedSecret, plantedGeneration, KEY);
    const forgedResponse = await fetch(`${running.base}/autonomy`, {
      headers: { cookie: `agenthost_auth=${forged}` },
      redirect: "manual",
    });
    assert.equal(forgedResponse.status, 401, "agent-controlled legacy bytes cannot mint a cookie after reboot");
  } finally {
    await stopChild(running && running.child);
  }
});

test("the real gate names and refuses the pre-rotation login state", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-auth-rotation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const authDir = path.join(root, "auth");
  fs.mkdirSync(path.join(home, "work"), { recursive: true });
  fs.mkdirSync(authDir, { mode: 0o700 });
  fs.writeFileSync(path.join(authDir, "auth.rotation-required"), "rotate-operator-access-key-v1\n", { mode: 0o600 });

  let running = null;
  try {
    running = await startGate(home, authDir);
    const response = await login(running.base);
    assert.equal(response.status, 503);
    const body = await fetch(`${running.base}/session`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: running.base, "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ key: KEY }),
    }).then((result) => result.json());
    assert.deepEqual(body, {
      code: "AUTH_ROTATION_REQUIRED",
      error: "This box cannot create an operator session until its access key is rotated after the authentication-state upgrade.",
    });
    const review = await fetch(`${running.base}/review`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-gate-key": KEY },
      body: JSON.stringify({ repo: "owner/repo", prNumber: 1 }),
    });
    assert.equal(review.status, 503, "the historically exposed key cannot reach the off-box consequence route");
    assert.match(await review.text(), /unavailable until the operator access key is rotated/);
    assert.equal(fs.existsSync(path.join(home, ".claude", "agenthost", "git-ladder.json")), false,
      "the refused pre-rotation request creates no review state");
  } finally {
    await stopChild(running && running.child);
  }
});

test("post-rotation recovery requires an explicit key-only choice and then records it", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-auth-recovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const authDir = path.join(root, "auth");
  fs.mkdirSync(path.join(home, "work"), { recursive: true });
  fs.mkdirSync(authDir, { mode: 0o700 });
  const marker = path.join(authDir, "auth.recovery-required");
  fs.writeFileSync(marker, "confirm-key-only-recovery-v1\n", { mode: 0o600 });

  let running = null;
  try {
    running = await startGate(home, authDir);
    const loginPage = await fetch(`${running.base}/`).then((response) => response.text());
    assert.match(loginPage, /Continue with the new access key without the old 2FA seed/);
    assert.equal((await login(running.base)).status, 409, "the new key alone cannot silently disable the old 2FA policy");
    const review = await fetch(`${running.base}/review`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-gate-key": KEY },
      body: JSON.stringify({ repo: "owner/repo", prNumber: 1 }),
    });
    assert.equal(review.status, 503, "key-only off-box review stays closed until recovery is explicitly accepted");
    assert.match(await review.text(), /until the operator confirms authentication recovery/);
    assert.equal(fs.existsSync(path.join(home, ".claude", "agenthost", "git-ladder.json")), false,
      "the refused recovery-window request creates no review state");
    const accepted = await login(running.base, KEY, { recoverWithout2fa: true });
    assert.equal(accepted.status, 204);
    assert.match(accepted.cookie, /^agenthost_auth=/);
    assert.equal(fs.existsSync(marker), false, "the explicit recovery choice is recorded durably");
    assert.equal((await login(running.base)).status, 204, "later logins use the newly accepted key-only policy");
  } finally {
    await stopChild(running && running.child);
  }
});

test("the real gate refuses a hard-linked protected signing file without modifying its target", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-auth-hardlink-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const authDir = path.join(root, "auth");
  fs.mkdirSync(path.join(home, "work"), { recursive: true });
  fs.mkdirSync(authDir, { mode: 0o700 });
  const victim = path.join(root, "victim");
  const original = `${"a".repeat(64)}\n`;
  fs.writeFileSync(victim, original, { mode: 0o600 });
  fs.linkSync(victim, path.join(authDir, "gate.secret"));

  const child = spawn(process.execPath, [GATE], {
    env: {
      ...process.env,
      HOME: home,
      AGENTHOST_AUTH_STATE_DIR: authDir,
      TTYD_PASSWORD: KEY,
      AGENT_CHAT_BIN: process.platform === "win32" ? process.execPath : "/bin/true",
      GATE_PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const exit = await new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  assert.notEqual(exit, 0, "unsafe auth state fails the gate closed");
  assert.match(stderr, /single-link regular file/);
  assert.equal(fs.readFileSync(victim, "utf8"), original);
});
