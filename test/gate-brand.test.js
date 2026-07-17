// E2E brand-plumbing tests against the REAL gate.js: how the Legal Skills HQ
// skin reaches the browser. Boots TWO gates on ephemeral ports (GATE_PORT=0,
// port read from the log line, same pattern as gate-chat-busy.test.js):
//   - a LEGAL box (LEGAL_MODE=api, exactly what a `deploy --legal` stages)
//   - a DEV box (no LEGAL_MODE)
// and asserts the whole contract:
//   1. GET /brand.json -> {"brand":"legal"|"dev"}, no auth needed;
//   2. every gate-served HTML page carries <body data-brand="legal"> on the
//      legal box and does NOT on the dev box (login, chat, cron, 2fa, audit);
//   3. legal login page wears the LEGAL SKILLS HQ wordmark + legal tagline,
//      dev keeps the agenthost wordmark;
//   4. legal is chat-first: authed "/" 302s to /chat (fresh entry), while
//      ?terminal=1 or an in-app (same-origin Referer) navigation still reaches
//      the terminal proxy; dev "/" stays terminal-first. "Reaches the terminal
//      proxy" shows up as the gate's 502 backstop here because no ttyd runs in
//      the test -- a 502 proves the request went to the proxy, not /chat.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const GATE = path.join(import.meta.dirname, "..", "container", "gate.js");
const KEY = "gate-brand-test-key";

const boxes = { legal: {}, dev: {} };

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
  for (const [name, env] of [["legal", { LEGAL_MODE: "api" }], ["dev", {}]]) {
    const home = fs.mkdtempSync(path.join(import.meta.dirname, `.gatebrand-${name}-`));
    fs.mkdirSync(path.join(home, "work"), { recursive: true });
    const { child, port } = bootGate(home, env);
    boxes[name].home = home;
    boxes[name].gate = child;
    boxes[name].base = `http://127.0.0.1:${await port}`;
    const login = await fetch(`${boxes[name].base}/?key=${KEY}`, { redirect: "manual" });
    boxes[name].loginLocation = login.headers.get("location");
    boxes[name].cookie = String(login.headers.get("set-cookie") || "").split(";")[0];
    assert.ok(boxes[name].cookie.startsWith("agenthost_auth="), `${name}: login granted a cookie`);
  }
});

after(() => {
  for (const b of Object.values(boxes)) {
    if (b.gate) b.gate.kill("SIGTERM");
    if (b.home) fs.rmSync(b.home, { recursive: true, force: true });
  }
});

async function req(box, p, headers = {}) {
  const r = await fetch(box.base + p, { headers: { cookie: box.cookie, ...headers }, redirect: "manual" });
  return { status: r.status, text: await r.text(), headers: r.headers };
}

test("brand plumbing: legal box", async (t) => {
  const box = boxes.legal;

  await t.test("/brand.json says legal, without auth", async () => {
    const r = await fetch(box.base + "/brand.json"); // deliberately no cookie
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { brand: "legal" });
  });

  await t.test("login page: data-brand + LEGAL SKILLS HQ wordmark + legal tagline", async () => {
    const r = await fetch(box.base + "/x"); // unauthed -> login
    assert.equal(r.status, 401);
    const html = await r.text();
    assert.ok(html.includes('<body data-brand="legal"'), "body carries data-brand");
    assert.ok(html.includes("LEGAL SKILLS"), "wordmark");
    assert.ok(html.includes('<span class="hq">HQ</span>'), "bronze HQ span");
    assert.ok(html.includes("your private legal workspace"), "legal tagline");
    assert.ok(!html.includes("your agent never sleeps"), "dev tagline gone");
  });

  await t.test("login from '/' redirects straight to /chat (chat-first)", () => {
    assert.equal(box.loginLocation, "/chat");
  });

  await t.test("authed '/' (fresh entry, no referer) 302s to /chat", async () => {
    const r = await req(box, "/");
    assert.equal(r.status, 302);
    assert.equal(r.headers.get("location"), "/chat");
  });

  await t.test("'/?terminal=1' bypasses the redirect and reaches the terminal proxy", async () => {
    const r = await req(box, "/?terminal=1");
    assert.equal(r.status, 502, "proxied to (absent) ttyd, not redirected");
  });

  await t.test("in-app '/' navigation (same-origin referer, the chat tab) reaches the terminal proxy", async () => {
    const r = await req(box, "/", { referer: box.base + "/chat" });
    assert.equal(r.status, 502, "proxied to (absent) ttyd, not redirected");
  });

  await t.test("cross-origin referer does NOT bypass: still chat-first", async () => {
    const r = await req(box, "/", { referer: "https://example.com/" });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get("location"), "/chat");
  });

  await t.test("chat, cron, 2fa, audit pages all carry data-brand", async () => {
    for (const p of ["/chat", "/cron", "/2fa", "/audit"]) {
      const r = await req(box, p);
      assert.equal(r.status, 200, `${p} serves`);
      assert.ok(r.text.includes('<body data-brand="legal"'), `${p} body carries data-brand`);
    }
  });

  await t.test("manifest wears the legal identity", async () => {
    const r = await fetch(box.base + "/manifest.webmanifest");
    const m = await r.json();
    assert.equal(m.name, "Legal Skills HQ");
    assert.equal(m.background_color, "#FBFAF7");
  });
});

test("brand plumbing: dev box unchanged", async (t) => {
  const box = boxes.dev;

  await t.test("/brand.json says dev", async () => {
    const r = await fetch(box.base + "/brand.json");
    assert.deepEqual(await r.json(), { brand: "dev" });
  });

  await t.test("login page keeps the agenthost wordmark, no data-brand", async () => {
    const r = await fetch(box.base + "/x");
    assert.equal(r.status, 401);
    const html = await r.text();
    assert.ok(!html.includes("data-brand"), "no brand attribute in dev");
    assert.ok(html.includes("agenthost"), "dev wordmark");
    assert.ok(html.includes("your agent never sleeps"), "dev tagline");
  });

  await t.test("login from '/' redirects back to '/' (terminal-first)", () => {
    assert.equal(box.loginLocation, "/");
  });

  await t.test("authed '/' goes to the terminal proxy, never /chat", async () => {
    const r = await req(box, "/");
    assert.equal(r.status, 502, "proxied to (absent) ttyd -- no chat redirect in dev");
  });

  await t.test("chat page body carries no data-brand (the CSS fallback block may mention it)", async () => {
    const r = await req(box, "/chat");
    assert.equal(r.status, 200);
    assert.ok(!r.text.includes("<body data-brand"), "body tag unstamped in dev");
  });

  await t.test("manifest keeps the AgentHost identity", async () => {
    const r = await fetch(box.base + "/manifest.webmanifest");
    const m = await r.json();
    assert.equal(m.name, "AgentHost");
    assert.equal(m.background_color, "#0B0D10");
  });
});
