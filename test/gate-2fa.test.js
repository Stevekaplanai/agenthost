// End-to-end 2FA + audit tests against the REAL gate.js: boots it with a
// fixture HOME (AGENT_CHAT_BIN=/bin/true so no real agent runs) and drives the
// full lifecycle over HTTP -- enroll, confirm, login with/without code,
// brute-force lockout, audit trail, auth-gating.
//
// The gate binds 8080 (hardcoded); tests skip gracefully if it's taken.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const totp = require("../container/totp.js");

const GATE = path.join(import.meta.dirname, "..", "container", "gate.js");
const KEY = "gate-2fa-test-key";
const base = "http://127.0.0.1:8080";

let HOME;
let gate;
// Decided at load time via top-level await (below), not inside before() -- an
// earlier bug read portBusy before before() set it, so the skip never fired.
let authCookie = null; // the real cookie value (HMAC of KEY), captured at login

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, "127.0.0.1");
  });
}

const portBusy = !(await portFree(8080));

before(async () => {
  if (portBusy) return;
  HOME = fs.mkdtempSync(path.join(import.meta.dirname, ".gate2fa-"));
  fs.mkdirSync(path.join(HOME, "work"), { recursive: true });
  gate = spawn("node", [GATE], {
    env: { ...process.env, HOME, TTYD_PASSWORD: KEY, AGENT_CHAT_BIN: "/bin/true" },
    stdio: "ignore",
  });
  // wait until the gate answers
  let up = false;
  for (let i = 0; i < 40; i++) {
    try { await fetch(base + "/manifest.webmanifest"); up = true; break; }
    catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  if (!up) throw new Error("gate did not come up on 8080");
  // Capture the real auth cookie (no longer == KEY; it's HMAC(gateSecret, KEY)).
  const login = await fetch(base + `/?key=${KEY}`, { redirect: "manual" });
  const sc = String(login.headers.get("set-cookie") || "");
  authCookie = sc.split(";")[0]; // "agenthost_auth=<value>"
  assert.ok(authCookie.startsWith("agenthost_auth=") && !authCookie.endsWith(KEY), "cookie value is not the key");
});

after(() => {
  if (gate) gate.kill("SIGTERM");
  if (HOME) fs.rmSync(HOME, { recursive: true, force: true });
});

async function req(p, opts = {}, withCookie = true) {
  const headers = { ...(opts.headers || {}) };
  if (withCookie) headers.cookie = authCookie;
  const r = await fetch(base + p, { ...opts, headers, redirect: "manual" });
  return { status: r.status, text: await r.text(), headers: r.headers };
}

test("2FA lifecycle end-to-end", { skip: portBusy ? "port 8080 in use; skipping gate e2e" : false }, async (t) => {
  await t.test("2FA off: key alone grants the cookie; login page has no code field", async () => {
    let r = await req(`/?key=${KEY}`, {}, false);
    assert.equal(r.status, 302);
    assert.match(String(r.headers.get("set-cookie")), /agenthost_auth/);
    r = await req("/x", {}, false);
    assert.equal(r.status, 401);
    assert.ok(!r.text.includes("one-time-code"), "no code field yet");
  });

  await t.test("bad key is refused and audited", async () => {
    const r = await req(`/?key=NOPE`, {}, false);
    assert.equal(r.status, 302);
    assert.ok(!r.headers.get("set-cookie"));
  });

  await t.test("a cookie equal to the raw KEY does NOT authenticate (2FA-bypass regression)", async () => {
    // The old bug: cookie value == KEY, so a leaked ?key= URL could be replayed
    // as a cookie to skip 2FA. The cookie must be the HMAC, not the key.
    const r = await fetch(base + "/chat", { headers: { cookie: `agenthost_auth=${KEY}` }, redirect: "manual" });
    assert.equal(r.status, 401, "raw-key cookie is rejected");
    // and the real captured cookie still works
    const ok = await req("/chat");
    assert.equal(ok.status, 200);
  });

  let secret;
  await t.test("enroll -> wrong code refused (no secret written) -> valid code activates (0600)", async () => {
    let r = await req("/2fa/enroll", { method: "POST" });
    const enroll = JSON.parse(r.text);
    assert.ok(enroll.secret && enroll.otpauth.startsWith("otpauth://totp/"));
    secret = enroll.secret;

    r = await req("/2fa/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "000000" }) });
    assert.ok(JSON.parse(r.text).error, "wrong code refused");
    const file = path.join(HOME, ".claude", "agenthost", "2fa.secret");
    assert.ok(!fs.existsSync(file), "secret NOT written on failed confirm");

    r = await req("/2fa/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: totp.totp(secret) }) });
    assert.equal(JSON.parse(r.text).ok, true);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, "secret file is 0600");
  });

  await t.test("2FA on: key alone / key+wrong code refused; key+valid code grants; login page gains code field", async () => {
    let r = await req(`/?key=${KEY}`, {}, false);
    assert.ok(!r.headers.get("set-cookie"), "key alone no longer enough");
    r = await req(`/?key=${KEY}&code=123456`, {}, false);
    assert.ok(!r.headers.get("set-cookie"), "wrong code refused");
    r = await req(`/?key=${KEY}&code=${totp.totp(secret)}`, {}, false);
    assert.match(String(r.headers.get("set-cookie")), /agenthost_auth/, "key+code grants");
    r = await req("/x", {}, false);
    assert.ok(r.text.includes("one-time-code"), "login page shows the code field");
  });

  await t.test("5 bad codes lock out even a valid code, and disable is throttled too", async () => {
    for (let i = 0; i < 5; i++) await req(`/?key=${KEY}&code=111111`, {}, false);
    const r = await req(`/?key=${KEY}&code=${totp.totp(secret)}`, {}, false);
    assert.ok(!r.headers.get("set-cookie"), "valid code refused during lockout");
    const d = await req("/2fa/disable", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: totp.totp(secret) }) });
    assert.equal(d.status, 429, "disable throttled during lockout");
  });

  await t.test("a corrupt 2fa.secret fails closed without crashing the gate", async () => {
    // Tampered/garbage secret -> totp.verify would throw on bad base32; the
    // gate must catch it, refuse the login, and keep serving (it's the box's
    // main process). Write garbage directly, bypassing the confirm flow.
    fs.writeFileSync(path.join(HOME, ".claude", "agenthost", "2fa.secret"), "!!!not-valid-base32!!!\n");
    const r = await fetch(base + `/?key=${KEY}&code=123456`, { redirect: "manual" });
    assert.ok(!r.headers.get("set-cookie"), "corrupt secret -> login refused (fail closed)");
    // gate is still alive and serving
    const alive = await fetch(base + "/manifest.webmanifest");
    assert.equal(alive.status, 200, "gate still up after a verify error");
  });

  await t.test("audit trail records the lifecycle and is auth-gated", async () => {
    await req("/audit"); // a view logs audit_view AFTER rendering; view twice so it shows
    const r = await req("/audit");
    assert.equal(r.status, 200);
    for (const ev of ["login_ok", "login_fail", "login_2fa_fail", "2fa_lockout", "2fa_enrolled", "audit_view"]) {
      assert.ok(r.text.includes(ev), `audit shows ${ev}`);
    }
    const un = await req("/audit", {}, false);
    assert.equal(un.status, 401, "unauthenticated /audit gets the login page");
    const un2 = await req("/2fa", {}, false);
    assert.equal(un2.status, 401, "unauthenticated /2fa gets the login page");
  });
});
