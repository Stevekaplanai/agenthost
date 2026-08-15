// End-to-end 2FA + audit tests against the REAL gate.js: boots it with a
// fixture HOME (AGENT_CHAT_BIN=/bin/true so no real agent runs) and drives the
// full lifecycle over HTTP -- enroll, confirm, login with/without code,
// brute-force lockout, audit trail, auth-gating.
//
// The gate binds an OS-selected port so parallel gateway suites cannot race
// over a fixed address between a "port free" check and the actual listen.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { stopChild } from "./child-process-helper.js";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const totp = require("../container/totp.js");

const GATE = path.join(import.meta.dirname, "..", "container", "gate.js");
const KEY = "gate-2fa-test-key";
let base;

let HOME;
let AUTH_DIR;
let gate;
let authCookie = null; // the real cookie value (HMAC of KEY), captured at login

before(async () => {
  HOME = fs.mkdtempSync(path.join(import.meta.dirname, ".gate2fa-"));
  AUTH_DIR = path.join(HOME, "protected-auth-state");
  fs.mkdirSync(AUTH_DIR, { mode: 0o700 });
  fs.mkdirSync(path.join(HOME, "work"), { recursive: true });
  gate = spawn("node", [GATE], {
    env: {
      ...process.env,
      HOME,
      AGENTHOST_AUTH_STATE_DIR: AUTH_DIR,
      TTYD_PASSWORD: KEY,
      AGENT_CHAT_BIN: "/bin/true",
      AGENTHOST_2FA_PENDING_TTL_MS: "2000",
      GATE_PORT: "0",
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const port = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("gate did not report a port: " + output)), 5000);
    gate.stdout.on("data", (chunk) => {
      output += chunk.toString();
      const match = output.match(/listening on (\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
    gate.on("exit", () => { clearTimeout(timer); reject(new Error("gate exited before listening: " + output)); });
  });
  base = `http://127.0.0.1:${port}`;
  // Capture the real auth cookie (no longer == KEY; it's HMAC(gateSecret, KEY)).
  const login = await postSession({ key: KEY });
  const sc = String(login.headers.get("set-cookie") || "");
  authCookie = sc.split(";")[0]; // "agenthost_auth=<value>"
  assert.ok(authCookie.startsWith("agenthost_auth=") && !authCookie.endsWith(KEY), "cookie value is not the key");
});

after(async () => {
  await stopChild(gate);
  if (HOME) fs.rmSync(HOME, { recursive: true, force: true });
});

async function req(p, opts = {}, withCookie = true) {
  const headers = { ...(opts.headers || {}) };
  if (withCookie) headers.cookie = authCookie;
  const method = String(opts.method || "GET").toUpperCase();
  if (withCookie && method !== "GET" && method !== "HEAD") {
    headers.origin = base;
    headers["sec-fetch-site"] = "same-origin";
  }
  const r = await fetch(base + p, { ...opts, headers, redirect: "manual" });
  return { status: r.status, text: await r.text(), headers: r.headers };
}

function responseCookie(response) {
  const value = String(response.headers.get("set-cookie") || "").split(";", 1)[0];
  return value.startsWith("agenthost_auth=") ? value : "";
}

async function postSession(body) {
  const r = await fetch(base + "/session", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: base,
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify(body),
    redirect: "manual",
  });
  return { status: r.status, text: await r.text(), headers: r.headers };
}

test("2FA lifecycle end-to-end", async (t) => {
  await t.test("2FA off: the credential-free form POST grants the cookie and secrets never enter a URL", async () => {
    let r = await postSession({ key: KEY });
    assert.equal(r.status, 204);
    assert.match(String(r.headers.get("set-cookie")), /agenthost_auth/);
    r = await req("/x", {}, false);
    assert.equal(r.status, 401);
    assert.ok(!r.text.includes("one-time-code"), "no code field yet");
    assert.match(r.text, /fetch\("\/session"/);
    assert.doesNotMatch(r.text, /searchParams\.set\(['"](?:key|code)|\?key=/);
    const legacy = await req(`/?key=${KEY}`, {}, false);
    assert.equal(legacy.status, 400);
    assert.equal(legacy.headers.get("location"), null);
    assert.match(legacy.text, /credentials are never accepted in a URL/i);
  });

  await t.test("bad key is refused and audited", async () => {
    const r = await postSession({ key: "NOPE" });
    assert.equal(r.status, 401);
    assert.ok(!r.headers.get("set-cookie"));
  });

  await t.test("a cookie equal to the raw KEY does NOT authenticate (2FA-bypass regression)", async () => {
    // A raw-key cookie must never stand in for the HMAC session cookie.
    const r = await fetch(base + "/autonomy", { headers: { cookie: `agenthost_auth=${KEY}` }, redirect: "manual" });
    assert.equal(r.status, 401, "raw-key cookie is rejected");
    // and the real captured cookie still works
    const ok = await req("/autonomy");
    assert.equal(ok.status, 200);
  });

  let secret;
  await t.test("enrollment reauthenticates the access key and expires an abandoned pending secret", async () => {
    const file = path.join(AUTH_DIR, "2fa.secret");
    let r = await req("/2fa/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 401, "the cookie alone cannot start enrollment");
    r = await req("/2fa/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "wrong" }),
    });
    assert.equal(r.status, 401, "a wrong access key cannot start enrollment");

    r = await req("/2fa/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: KEY }),
    });
    const enroll = JSON.parse(r.text);
    assert.ok(enroll.secret && enroll.otpauth.startsWith("otpauth://totp/"));
    await new Promise((resolve) => setTimeout(resolve, 2150));
    r = await req("/2fa/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: totp.totp(enroll.secret) }),
    });
    assert.equal(r.status, 400);
    assert.match(JSON.parse(r.text).error, /expired/i, "the cause names the expired setup");
    assert.ok(!fs.existsSync(file), "an expired pending secret is never activated");
  });

  await t.test("valid setup activates 2FA, throttles confirmation failures, and revokes the old cookie", async () => {
    let r = await req("/2fa/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: KEY }),
    });
    const enroll = JSON.parse(r.text);
    secret = enroll.secret;

    r = await req("/2fa/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "000000" }) });
    assert.ok(JSON.parse(r.text).error, "wrong code refused");
    const file = path.join(AUTH_DIR, "2fa.secret");
    assert.ok(!fs.existsSync(file), "secret NOT written on failed confirm");

    const oldCookie = authCookie;
    r = await req("/2fa/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: totp.totp(secret) }) });
    assert.equal(JSON.parse(r.text).ok, true);
    assert.match(String(r.headers.get("set-cookie")), /Max-Age=0/, "the activating browser is explicitly signed out");
    const old = await fetch(base + "/autonomy", { headers: { cookie: oldCookie }, redirect: "manual" });
    assert.equal(old.status, 401, "every cookie minted before enrollment is revoked");
    const generationFile = path.join(AUTH_DIR, "auth.session-generation");
    assert.match(fs.readFileSync(generationFile, "utf8").trim(), /^[a-f0-9]{64}$/, "session generation is persisted");
    // Windows reports synthetic POSIX bits; the deployed Linux path proves 0600.
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600, "secret file is 0600");
      assert.equal(fs.statSync(generationFile).mode & 0o777, 0o600, "session-generation file is 0600");
    }

    r = await postSession({ key: KEY });
    assert.equal(r.status, 401);
    assert.equal(JSON.parse(r.text).code, "TWO_FA_REQUIRED", "server login names the missing second factor");
    r = await postSession({ key: KEY, code: "123456" });
    assert.equal(r.status, 401);
    assert.equal(JSON.parse(r.text).code, "BAD_CODE");
    r = await postSession({ key: KEY, code: totp.totp(secret) });
    assert.equal(r.status, 204);
    const freshCookie = responseCookie(r);
    assert.ok(freshCookie && freshCookie !== oldCookie, "fresh key+code login receives a distinct cookie");
    authCookie = freshCookie;
  });

  await t.test("2FA on: key alone / key+wrong code refused; key+valid code grants; login page gains code field", async () => {
    let r = await postSession({ key: KEY });
    assert.ok(!r.headers.get("set-cookie"), "key alone no longer enough");
    r = await postSession({ key: KEY, code: "123456" });
    assert.ok(!r.headers.get("set-cookie"), "wrong code refused");
    r = await postSession({ key: KEY, code: totp.totp(secret) });
    assert.match(String(r.headers.get("set-cookie")), /agenthost_auth/, "key+code grants");
    r = await req("/x", {}, false);
    assert.ok(r.text.includes("one-time-code"), "login page shows the code field");
  });

  await t.test("disabling 2FA revokes the current cookie before removing the factor", async () => {
    const oldCookie = authCookie;
    const r = await req("/2fa/disable", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: totp.totp(secret) }),
    });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.text).ok, true);
    assert.match(String(r.headers.get("set-cookie")), /Max-Age=0/);
    const old = await fetch(base + "/autonomy", { headers: { cookie: oldCookie }, redirect: "manual" });
    assert.equal(old.status, 401, "the pre-disable cookie is revoked");
    const login = await postSession({ key: KEY });
    assert.equal(login.status, 204, "key-only login works after 2FA is disabled");
    authCookie = responseCookie(login);
    assert.ok(authCookie && authCookie !== oldCookie);

    const reenroll = await req("/2fa/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: KEY }),
    });
    secret = JSON.parse(reenroll.text).secret;
    const confirm = await req("/2fa/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: totp.totp(secret) }),
    });
    assert.equal(confirm.status, 200, "fixture re-enrolls for lockout and corruption checks");
    const fresh = await postSession({ key: KEY, code: totp.totp(secret) });
    assert.equal(fresh.status, 204);
    authCookie = responseCookie(fresh);
  });

  await t.test("5 bad codes lock out even a valid code, and disable is throttled too", async () => {
    for (let i = 0; i < 5; i++) await postSession({ key: KEY, code: "111111" });
    const r = await postSession({ key: KEY, code: totp.totp(secret) });
    assert.ok(!r.headers.get("set-cookie"), "valid code refused during lockout");
    const d = await req("/2fa/disable", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: totp.totp(secret) }) });
    assert.equal(d.status, 429, "disable throttled during lockout");
  });

  await t.test("a corrupt 2fa.secret fails closed without crashing the gate", async () => {
    // Tampered/garbage secret -> totp.verify would throw on bad base32; the
    // gate must catch it, refuse the login, and keep serving (it's the box's
    // main process). Write garbage directly, bypassing the confirm flow.
    fs.writeFileSync(path.join(AUTH_DIR, "2fa.secret"), "!!!not-valid-base32!!!\n");
    const r = await postSession({ key: KEY, code: "123456" });
    assert.equal(r.status, 503, "corrupt state is unavailable, not a bad operator code");
    assert.equal(JSON.parse(r.text).code, "BOX_UNAVAILABLE");
    assert.match(JSON.parse(r.text).error, /invalid format/i);
    assert.ok(!r.headers.get("set-cookie"), "corrupt secret -> login refused (fail closed)");
    const status = await req("/2fa/status");
    assert.equal(status.status, 200);
    assert.equal(JSON.parse(status.text).enrolled, true);
    assert.equal(JSON.parse(status.text).available, false);
    assert.match(JSON.parse(status.text).problem, /invalid format/i);
    // gate is still alive and serving
    const alive = await fetch(base + "/manifest.webmanifest");
    assert.equal(alive.status, 200, "gate still up after a verify error");
  });

  await t.test("an unreadable 2fa.secret never becomes key-only login or re-enrollment", async () => {
    const file = path.join(AUTH_DIR, "2fa.secret");
    fs.rmSync(file, { force: true });
    fs.mkdirSync(file);
    const login = await postSession({ key: KEY });
    assert.equal(login.status, 503, "an existing secret read failure must fail closed");
    assert.equal(JSON.parse(login.text).code, "BOX_UNAVAILABLE");
    assert.match(JSON.parse(login.text).error, /could not be read/i);

    const status = await req("/2fa/status");
    assert.equal(status.status, 200);
    assert.deepEqual(
      { available: JSON.parse(status.text).available, enrolled: JSON.parse(status.text).enrolled },
      { available: false, enrolled: true },
      "status must not relabel an unreadable enrolled factor as off",
    );
    assert.match(JSON.parse(status.text).problem, /could not be read/i);

    const enroll = await req("/2fa/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: KEY }),
    });
    assert.equal(enroll.status, 503, "an unreadable factor cannot be overwritten through enrollment");
    assert.match(JSON.parse(enroll.text).error, /could not be read/i);
  });

  await t.test("audit trail records the lifecycle and is auth-gated", async () => {
    const auditFile = path.join(HOME, ".claude", "agenthost", "audit.log");
    const beforeReads = fs.readFileSync(auditFile, "utf8");
    await req("/audit/data");
    const r = await req("/audit/data");
    assert.equal(r.status, 200);
    assert.equal(fs.readFileSync(auditFile, "utf8"), beforeReads,
      "Activity polling reads the audit log without appending audit_view noise");
    const events = JSON.parse(r.text).events.map((event) => event.event);
    for (const ev of ["login_ok", "login_fail", "login_2fa_fail", "2fa_lockout", "2fa_enrolled"]) {
      assert.ok(events.includes(ev), `audit shows ${ev}`);
    }
    assert.equal(events.includes("audit_view"), false, "audit reads do not bury real operator events");

    const savedAudit = auditFile + ".saved";
    fs.renameSync(auditFile, savedAudit);
    fs.mkdirSync(auditFile);
    try {
      const failedRead = await req("/audit/data");
      assert.equal(failedRead.status, 503, "a real audit read failure is not presented as an empty success");
      assert.match(JSON.parse(failedRead.text).error, /could not be read/i,
        "the Activity error names the failed read instead of looking like no records");
    } finally {
      fs.rmSync(auditFile, { recursive: true, force: true });
      fs.renameSync(savedAudit, auditFile);
    }
    const un = await req("/audit", {}, false);
    assert.equal(un.status, 401, "unauthenticated /audit gets the login page");
    const un2 = await req("/2fa", {}, false);
    assert.equal(un2.status, 401, "unauthenticated /2fa gets the login page");
  });
});
