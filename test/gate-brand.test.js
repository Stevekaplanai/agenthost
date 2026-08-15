// E2E brand-plumbing tests against the REAL gate.js: how the Legal Skills HQ
// skin reaches the browser. Boots TWO gates on ephemeral ports (GATE_PORT=0,
// port read from the log line, same pattern as gate-chat-busy.test.js):
//   - a LEGAL box (LEGAL_MODE=api, exactly what a `deploy --legal` stages)
//   - a DEV box (no LEGAL_MODE)
// and asserts the brand remains observable while every page entry lands on the
// same generated shell. The terminal now has its own /terminal/ iframe route;
// root is no longer overloaded as a ttyd proxy.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { stopChild } from "./child-process-helper.js";
import { mintOperatorSession } from "./operator-session-helper.js";

const GATE = path.join(import.meta.dirname, "..", "container", "gate.js");
const SHELL = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "dashboard-ui", "index.html"), "utf8");
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
    const session = await mintOperatorSession(boxes[name].base, KEY);
    boxes[name].loginLocation = session.response.headers.get("location");
    boxes[name].cookie = session.cookie;
  }
});

after(async () => {
  for (const b of Object.values(boxes)) {
    await stopChild(b.gate);
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

  await t.test("session mint is credential-free and does not redirect", () => {
    assert.equal(box.loginLocation, null);
  });

  await t.test("the legal root and native deep links serve one generated shell without aliases", async () => {
    let legalShell = null;
    for (const p of ["/", "/2fa", "/audit"]) {
      const r = await req(box, p);
      assert.equal(r.status, 200, `${p} serves`);
      assert.equal(r.headers.get("location"), null, `${p} does not redirect`);
      assert.ok(r.text.includes('<body data-brand="legal"'), `${p} carries the legal brand stamp`);
      legalShell ??= r.text;
      assert.equal(r.text, legalShell, `${p} is the same branded generated shell`);
    }
    assert.match(legalShell, /<title>Legal Skills HQ Workspace \| Your governed agent team<\/title>/);
    assert.match(legalShell, /apple-mobile-web-app-title[^>]+content="Legal Skills HQ"/);
    assert.match(legalShell, />Legal Skills HQ<\/span>/, "the visible workspace masthead uses the buyer brand");
    assert.match(legalShell, /Search Legal Skills HQ/, "search is named for the buyer brand");
    assert.doesNotMatch(legalShell, /\bAgentHost\b/, "the legal shell never makes the engine the buyer-facing brand");
    for (const p of ["/cc", "/desk", "/chat", "/cron", "/kanban", "/brain", "/profiles", "/settings"]) {
      const r = await req(box, p);
      assert.equal(r.status, 410, `${p} is retired`);
      assert.equal(r.headers.get("location"), null, `${p} does not redirect`);
      assert.match(r.text, /no redirect or compatibility UI/i, p);
    }
  });

  await t.test("manifest wears the legal identity", async () => {
    const r = await fetch(box.base + "/manifest.webmanifest");
    const m = await r.json();
    assert.equal(m.name, "Legal Skills HQ");
    assert.equal(m.background_color, "#FBFAF7");
  });

  await t.test("service-worker fallback notifications wear the legal identity", async () => {
    const r = await fetch(box.base + "/sw.js");
    assert.equal(r.status, 200);
    const worker = await r.text();
    assert.match(worker, /data\.title \|\| "Legal Skills HQ"/);
    assert.doesNotMatch(worker, /data\.title \|\| "AgentHost"/);
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

  await t.test("session mint is credential-free and does not redirect", () => {
    assert.equal(box.loginLocation, null);
  });

  await t.test("authed '/' serves the generated shell, never the terminal proxy", async () => {
    const r = await req(box, "/");
    assert.equal(r.status, 200);
    assert.equal(r.text, SHELL);
  });

  await t.test("the old chat root is retired without redirect or compatibility UI", async () => {
    const r = await req(box, "/chat");
    assert.equal(r.status, 410);
    assert.equal(r.headers.get("location"), null);
    assert.match(r.text, /no redirect or compatibility UI/i);
  });

  await t.test("the old board root is retired instead of aliasing the generated shell", async () => {
    const r = await req(box, "/kanban");
    assert.equal(r.status, 410);
    assert.equal(r.headers.get("location"), null);
    assert.notEqual(r.text, SHELL);
  });

  await t.test("the default favicon URL serves the shipped app icon", async () => {
    const r = await fetch(box.base + "/favicon.ico");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "image/png");
  });

  await t.test("manifest keeps the AgentHost identity", async () => {
    const r = await fetch(box.base + "/manifest.webmanifest");
    const m = await r.json();
    assert.equal(m.name, "AgentHost");
    assert.equal(m.background_color, "#0B0D10");
  });

  await t.test("service-worker fallback notifications keep the dev identity", async () => {
    const r = await fetch(box.base + "/sw.js");
    assert.equal(r.status, 200);
    assert.match(await r.text(), /data\.title \|\| "AgentHost"/);
  });
});
