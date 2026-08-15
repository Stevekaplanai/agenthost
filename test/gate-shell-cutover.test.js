import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import vm from "node:vm";
import { spawn } from "node:child_process";
import { stopChild } from "./child-process-helper.js";
import { mintOperatorSession } from "./operator-session-helper.js";

const ROOT = path.join(import.meta.dirname, "..");
const GATE = path.join(ROOT, "container", "gate.js");
const SHELL = fs.readFileSync(path.join(ROOT, "container", "dashboard-ui", "index.html"));
const KEY = "shell-cutover-test-key";
const REPLACEABLE_TTYD_HTML = `<!doctype html><html><head><title>replaceable ttyd</title></head><body><script>
Promise.resolve().then(async function () {
  try {
    const response = await fetch("/terminal/token");
    const body = await response.json();
    document.body.dataset.tokenStatus = String(response.status);
    document.body.dataset.token = String(body.token || "");
  } catch (error) { document.body.dataset.tokenError = String(error && error.message || error); }
  try {
    const socket = new WebSocket("/terminal/ws", "tty");
    socket.onopen = function () { document.body.dataset.ws = "open"; };
    socket.onerror = function () { document.body.dataset.ws = "error"; };
  } catch (error) { document.body.dataset.ws = "exception:" + String(error && error.message || error); }
  try {
    const response = await fetch("/autonomy", { credentials: "include" });
    document.body.dataset.operatorStatus = String(response.status);
    document.body.dataset.operatorCause = (await response.text()).slice(0, 160);
  } catch (error) { document.body.dataset.operatorError = String(error && error.message || error); }
  try {
    const response = await fetch("/autonomy", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ on: true }),
    });
    document.body.dataset.mutationStatus = String(response.status);
    document.body.dataset.mutationCause = (await response.text()).slice(0, 160);
  } catch (error) { document.body.dataset.mutationError = String(error && error.message || error); }
});
</script></body></html>`;

let child;
let home;
let base;
let cookie;

function bootGate() {
  home = fs.mkdtempSync(path.join(import.meta.dirname, ".gate-shell-cutover-"));
  child = spawn(process.execPath, [GATE], {
    env: {
      ...process.env,
      HOME: home,
      TTYD_PASSWORD: KEY,
      GATE_PORT: "0",
      CHANNEL_DISPATCH_PORT: "0",
      KANBAN_BRIDGE_PORT: "0",
      BOARD_AUTONOMY: "off",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
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
}

async function authed(pathname, headers = {}) {
  return fetch(base + pathname, {
    headers: { cookie, ...headers },
    redirect: "manual",
  });
}

function rawUpgradeTo(targetBase, targetCookie, pathname, extraHeaders = {}) {
  const target = new URL(targetBase);
  return new Promise((resolve, reject) => {
    let response = "";
    const socket = net.connect(Number(target.port), target.hostname, () => {
      const additions = Object.entries(extraHeaders)
        .map(([name, value]) => `${name}: ${value}\r\n`)
        .join("");
      const cookieHeader = targetCookie ? `Cookie: ${targetCookie}\r\n` : "";
      socket.write(
        `GET ${pathname} HTTP/1.1\r\n` +
        `Host: ${target.host}\r\n` +
        cookieHeader +
        "Connection: Upgrade\r\n" +
        "Upgrade: websocket\r\n" +
        "Sec-WebSocket-Version: 13\r\n" +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
        additions +
        "\r\n",
      );
    });
    socket.setTimeout(3_000, () => socket.destroy(new Error("upgrade response timed out")));
    socket.on("data", (chunk) => { response += chunk.toString(); });
    socket.on("end", () => resolve(response));
    socket.on("close", (hadError) => { if (!hadError) resolve(response); });
    socket.on("error", reject);
  });
}

function rawHttpTo(targetBase, targetCookie, requestTarget, extraHeaders = {}) {
  const target = new URL(targetBase);
  return new Promise((resolve, reject) => {
    let response = "";
    const socket = net.connect(Number(target.port), target.hostname, () => {
      const additions = Object.entries(extraHeaders)
        .map(([name, value]) => `${name}: ${value}\r\n`)
        .join("");
      const cookieHeader = targetCookie ? `Cookie: ${targetCookie}\r\n` : "";
      socket.write(
        `GET ${requestTarget} HTTP/1.1\r\n` +
        `Host: ${target.host}\r\n` +
        cookieHeader +
        additions +
        "Connection: close\r\n\r\n",
      );
    });
    socket.setTimeout(3_000, () => socket.destroy(new Error("HTTP response timed out")));
    socket.on("data", (chunk) => { response += chunk.toString(); });
    socket.on("end", () => resolve(response));
    socket.on("close", (hadError) => { if (!hadError) resolve(response); });
    socket.on("error", reject);
  });
}

function rawUpgrade(pathname) {
  return rawUpgradeTo(base, cookie, pathname);
}

function operatorPostWithHeaders(pathname, headers, body) {
  const target = new URL(base);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: pathname,
      method: "POST",
      headers: { cookie, "content-length": Buffer.byteLength(body), ...headers },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

async function bootGateWithCapturedTerminal(t, options = {}) {
  const gateHome = fs.mkdtempSync(path.join(import.meta.dirname, ".gate-terminal-capture-"));
  const capture = path.join(gateHome, "terminal-capture.jsonl");
  const preload = path.join(gateHome, "capture-terminal-backend.cjs");
  fs.writeFileSync(preload, `
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const crypto = require("node:crypto");
const { Duplex, PassThrough } = require("node:stream");
const capture = process.env.TERMINAL_BACKEND_CAPTURE;
const record = (value) => fs.appendFileSync(capture, JSON.stringify(value) + "\\n");
const originalRequest = http.request;
http.request = function(options, callback) {
  if (!options || !String(options.socketPath || "").endsWith("ttyd.sock")) {
    return originalRequest.apply(this, arguments);
  }
  record({ kind: "http", path: options.path, headers: options.headers });
  const request = new PassThrough();
  if (String(options.path || "").split("?", 1)[0] === "/terminal/token" && process.env.TERMINAL_BACKEND_TOKEN_MODE === "fail") {
    process.nextTick(() => request.emit("error", new Error("fake ttyd token socket refused")));
    return request;
  }
  process.nextTick(() => {
    const response = new PassThrough();
    response.statusCode = 200;
    response.statusMessage = "OK";
    const isIndex = String(options.path || "").split("?", 1)[0] === "/terminal/";
    response.headers = isIndex
      ? { "content-type": "text/html; charset=utf-8", "set-cookie": ["ttyd_session=must-not-escape; Path=/"] }
      : { "content-type": "application/json", "set-cookie": ["ttyd_token=must-not-escape; Path=/"] };
    callback(response);
    const tokenBody = process.env.TERMINAL_BACKEND_TOKEN_MODE === "malformed-shape" ? '{"token":123}' : '{"token":"ttyd-token"}';
    response.end(isIndex ? ${JSON.stringify(REPLACEABLE_TTYD_HTML)} : tokenBody);
  });
  return request;
};
const originalConnect = net.connect;
net.connect = function(...args) {
  if (typeof args[0] !== "string" || !args[0].endsWith("ttyd.sock")) {
    return originalConnect.apply(this, args);
  }
  const callback = args.findLast((arg) => typeof arg === "function");
  let request = "";
  let answered = false;
  const socket = new Duplex({
    read() {},
    write(chunk, encoding, done) {
      request += Buffer.from(chunk).toString("latin1");
      if (!answered && request.includes("\\r\\n\\r\\n")) {
        answered = true;
        record({ kind: "ws", request });
        const key = /^Sec-WebSocket-Key:\\s*(.+)$/im.exec(request)?.[1].trim() || "";
        const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
        this.push("HTTP/1.1 101 Switching Protocols\\r\\nConnection: Upgrade\\r\\nUpgrade: websocket\\r\\nSec-WebSocket-Accept: " + accept + "\\r\\nSec-WebSocket-Protocol: tty\\r\\nSet-Cookie: ttyd_ws=must-not-escape; Path=/\\r\\nClear-Site-Data: \\\"cookies\\\"\\r\\nLocation: /agent-owned-redirect\\r\\n\\r\\n");
        setImmediate(() => this.push(null));
      }
      done();
    },
  });
  process.nextTick(() => callback.call(socket));
  return socket;
};
`);
  const nodeOptions = [process.env.NODE_OPTIONS || "", `--require=${preload}`].filter(Boolean).join(" ");
  const gateChild = spawn(process.execPath, [GATE], {
    env: {
      ...process.env,
      HOME: gateHome,
      TTYD_PASSWORD: KEY,
      GATE_PORT: "0",
      CHANNEL_DISPATCH_PORT: "0",
      KANBAN_BRIDGE_PORT: "0",
      BOARD_AUTONOMY: "off",
      TERMINAL_BACKEND_CAPTURE: capture,
      TERMINAL_BACKEND_TOKEN_MODE: String(options.tokenMode || ""),
      NODE_OPTIONS: nodeOptions,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const gateBase = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`capture gate did not listen; stdout=${stdout}; stderr=${stderr}`)), 15_000);
    gateChild.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const match = stdout.match(/listening on (\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    });
    gateChild.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    gateChild.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`capture gate exited ${code}; stdout=${stdout}; stderr=${stderr}`));
    });
  });
  const { cookie: gateCookie } = await mintOperatorSession(gateBase, KEY);
  t.after(async () => {
    await stopChild(gateChild);
    fs.rmSync(gateHome, { recursive: true, force: true });
  });
  return { base: gateBase, cookie: gateCookie, capture };
}

before(async () => {
  base = await bootGate();
  cookie = (await mintOperatorSession(base, KEY)).cookie;
});

after(async () => {
  if (child) await stopChild(child);
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

test("the canonical root is the sole general workspace entry", async () => {
  const response = await authed("/?task=t_probe&view=work%2Fboard");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("location"), null, "the canonical root must not redirect");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), SHELL, "the root returns the committed shell bytes");
});

test("retired page roots never authenticate, redirect, or serve compatibility UI", async () => {
  for (const entry of [
    "/cc", "/cc/", "/desk", "/desk/", "/chat", "/chat/", "/cron", "/cron/",
    "/kanban", "/kanban/", "/brain", "/brain/", "/profiles", "/profiles/",
    "/settings", "/settings/", "/cc/legacy", "/cc/legacy/", "/hermes", "/hermes/", "/hermes-old",
  ]) {
    for (const headers of [{}, { cookie }]) {
      const response = await fetch(base + entry + "?key=" + encodeURIComponent(KEY), { headers, redirect: "manual" });
      assert.equal(response.status, 410, entry);
      assert.equal(response.headers.get("location"), null, `${entry} must not redirect`);
      assert.equal(response.headers.get("set-cookie"), null, `${entry} must not mint a login session`);
      const body = Buffer.from(await response.arrayBuffer());
      assert.notDeepEqual(body, SHELL, `${entry} must not serve the generated shell as a compatibility alias`);
      assert.match(body.toString(), /standalone application route was retired.*no redirect or compatibility UI/i, entry);
    }
  }
});

test("audit and two-factor settings keep their function inside the generated shell", async () => {
  for (const pathname of ["/audit", "/2fa"]) {
    const entry = await authed(pathname);
    assert.equal(entry.status, 200, pathname);
    assert.equal(await entry.text(), SHELL.toString(), `${pathname} must not resurrect a handwritten page`);
  }

  const twoFactor = await authed("/2fa/status");
  assert.equal(twoFactor.status, 200);
  assert.deepEqual(await twoFactor.json(), { available: true, enrolled: false });

  const auditDir = path.join(home, ".claude", "agenthost");
  fs.mkdirSync(auditDir, { recursive: true });
  const auditFile = path.join(auditDir, "audit.log");
  fs.appendFileSync(auditFile, [
    JSON.stringify({ t: "2026-08-10T10:00:00.000Z", event: "older", detail: "older detail", eng: "codex", tid: "t_old", ip: "10.0.0.x" }),
    "not-json",
    JSON.stringify({ t: "2026-08-10T10:02:00.000Z", event: "newest", detail: "newest detail", eng: "hermes", tid: "t_new", ip: "10.0.1.x" }),
  ].join("\n") + "\n");
  const audit = await authed("/audit/data?limit=2");
  assert.equal(audit.status, 200);
  const observed = await audit.json();
  assert.equal(typeof observed.observedAt, "number");
  assert.deepEqual(observed.events.map((event) => event.event), ["newest", "unparseable"]);
  assert.deepEqual(observed.events[0], {
    t: "2026-08-10T10:02:00.000Z",
    event: "newest",
    detail: "newest detail",
    eng: "hermes",
    tid: "t_new",
    ip: "10.0.1.x",
  });
});

test("old page namespaces keep their API subpaths instead of swallowing them into the shell", async () => {
  for (const pathname of [
    "/chat/thread",
    "/cron/jobs",
    "/board",
    "/profiles/data",
    "/brain/api/memories",
    "/api/settings",
    "/cc/state",
  ]) {
    const response = await authed(pathname);
    const body = Buffer.from(await response.arrayBuffer());
    assert.notDeepEqual(body, SHELL, `${pathname} returned the page shell instead of its API response`);
    assert.match(response.headers.get("content-type") || "", /json/i, `${pathname} must remain a JSON API`);
  }
});

test("the handwritten recovery path is retired with no redirect or UI", async () => {
  const response = await authed("/cc/legacy");
  assert.ok(response.status === 404 || response.status === 410, `expected 404/410, got ${response.status}`);
  assert.equal(response.headers.get("location"), null);
  assert.match(await response.text(), /standalone application route was retired.*no redirect or compatibility UI/i);
});

test("login preserves the canonical root query without ever accepting credentials in a URL", async () => {
  const pending = await fetch(`${base}/?task=t_probe&view=work%2Fboard`, { redirect: "manual" });
  assert.equal(pending.status, 401);
  assert.match(await pending.text(), /location\.replace\(location\.pathname\+location\.search\)/,
    "a successful JSON session mint reloads the same credential-free root query");

  const legacy = await fetch(
    `${base}/?task=t_probe&view=work%2Fboard&key=${encodeURIComponent(KEY)}&code=123456&e=1`,
    { redirect: "manual" },
  );
  assert.equal(legacy.status, 400);
  assert.equal(legacy.headers.get("location"), null);
  assert.equal(legacy.headers.get("set-cookie"), null);
  assert.match(await legacy.text(), /credentials are never accepted in a URL/i);

  const failed = await fetch(`${base}/session`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base, "sec-fetch-site": "same-origin" },
    body: JSON.stringify({ key: "wrong" }),
    redirect: "manual",
  });
  assert.equal(failed.status, 401);
  assert.equal(failed.headers.get("location"), null);
  assert.equal(failed.headers.get("set-cookie"), null);
});

test("the terminal is isolated to its index and token HTTP routes", async () => {
  const direct = await authed("/terminal/", { "sec-fetch-dest": "document", "sec-fetch-site": "same-origin" });
  assert.equal(direct.status, 403);
  assert.match(await direct.text(), /terminal.*inside.*workspace|iframe/i);

  const index = await authed("/terminal/", { "sec-fetch-dest": "iframe", "sec-fetch-site": "same-origin" });
  assert.equal(index.status, 502);
  assert.match(await index.text(), /terminal.*unavailable.*ttyd/i, "the terminal failure must name ttyd as the cause");

  const cookieOnlyToken = await authed("/terminal/token", { "sec-fetch-site": "same-origin" });
  assert.equal(cookieOnlyToken.status, 401, "the operator cookie is not terminal capability auth");
  assert.match(await cookieOnlyToken.text(), /terminal.*capability|capability.*required/i);

  for (const pathname of ["/terminal", "/terminal/nope", "/terminal/ws", "/not-a-real-route"]) {
    const response = await authed(pathname);
    assert.equal(response.status, 404, pathname);
    assert.match(await response.text(), /route.*not found|not a supported.*route/i, `${pathname} must explain the miss`);
  }
});

test("the terminal backend never receives the operator's gate credentials", async (t) => {
  const captured = await bootGateWithCapturedTerminal(t);
  const terminalDocument = await fetch(captured.base + "/terminal/", {
    headers: { cookie: captured.cookie, "sec-fetch-dest": "iframe", "sec-fetch-site": "same-origin" },
  });
  const terminalHtml = await terminalDocument.text();
  const capability = /const capability=(?:"|')([A-Za-z0-9_-]{43})(?:"|')/.exec(terminalHtml)?.[1];
  assert.ok(capability);

  const cookieOnlyToken = await fetch(captured.base + "/terminal/token", {
    headers: { cookie: captured.cookie, "sec-fetch-site": "same-origin" },
  });
  assert.equal(cookieOnlyToken.status, 401);
  const token = await fetch(captured.base + "/terminal/token", {
    headers: {
      cookie: captured.cookie,
      authorization: "Bearer operator-secret",
      "proxy-authorization": "Basic proxy-secret",
      "x-agenthost-terminal-capability": capability,
      "sec-fetch-site": "cross-site",
      origin: "null",
    },
  });
  assert.equal(token.status, 200);

  const cookieOnlyUpgrade = await rawUpgradeTo(captured.base, captured.cookie, "/terminal/ws", {
    Origin: captured.base,
    "Sec-Fetch-Site": "same-origin",
    "Sec-WebSocket-Protocol": "tty",
  });
  assert.match(cookieOnlyUpgrade, /^HTTP\/1\.1 401 Unauthorized/m);

  const upgrade = await rawUpgradeTo(captured.base, captured.cookie, "/terminal/ws", {
    Authorization: "Bearer operator-secret",
    "Proxy-Authorization": "Basic proxy-secret",
    Origin: "null",
    "Sec-Fetch-Site": "cross-site",
    "Sec-WebSocket-Protocol": `tty, ahterm.${capability}`,
  });
  assert.match(upgrade, /^HTTP\/1\.1 101 Switching Protocols/m);
  assert.doesNotMatch(upgrade, /^(?:Set-Cookie|Clear-Site-Data|Location):/im, "agent-owned WS response headers must not affect the gate origin");

  const entries = fs.readFileSync(captured.capture, "utf8")
    .split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const httpHop = entries.find((entry) => entry.kind === "http" && entry.path === "/terminal/token");
  const wsHop = entries.find((entry) => entry.kind === "ws");
  assert.ok(httpHop, "the fake ttyd backend must observe the HTTP hop");
  assert.equal(httpHop.path, "/terminal/token");
  assert.equal(httpHop.headers.cookie, undefined);
  assert.equal(httpHop.headers.authorization, undefined);
  assert.equal(httpHop.headers["proxy-authorization"], undefined);
  assert.ok(wsHop, "the fake ttyd backend must observe the WebSocket hop");
  assert.doesNotMatch(wsHop.request, /^(?:Cookie|Authorization|Proxy-Authorization):/im);
  assert.doesNotMatch(wsHop.request, /operator-secret|proxy-secret|agenthost_auth=/i);
  assert.match(wsHop.request, /^Sec-WebSocket-Protocol: tty$/im, "ttyd's protocol negotiation must survive");
});

test("the replaceable ttyd document gets only a terminal-scoped capability", async (t) => {
  const captured = await bootGateWithCapturedTerminal(t);
  const document = await fetch(captured.base + "/terminal/", {
    headers: { cookie: captured.cookie, "sec-fetch-dest": "iframe", "sec-fetch-site": "same-origin" },
  });
  assert.equal(document.status, 200);
  const csp = document.headers.get("content-security-policy") || "";
  assert.match(csp, /(?:^|;)\s*sandbox\s+allow-scripts\s*(?:;|$)/i);
  assert.doesNotMatch(csp, /allow-same-origin/i);
  assert.equal(document.headers.get("set-cookie"), null, "agent-owned ttyd cookies must not escape the proxy");
  const html = await document.text();
  const capability = /const capability=(?:"|')([A-Za-z0-9_-]{43})(?:"|')/.exec(html)?.[1];
  assert.ok(capability, "the gate must inject a per-bootstrap terminal capability bridge before ttyd runs");
  const bridgeSource = /<script data-agenthost-terminal-bridge>([\s\S]*?)<\/script>/i.exec(html)?.[1];
  assert.ok(bridgeSource, "the gate-owned terminal bridge must be the first executable shim");
  const visibleCalls = [];
  function BrowserWebSocket(url, protocols) {
    visibleCalls.push({ kind: "ws", url: String(url), protocols });
  }
  BrowserWebSocket.prototype = {};
  let bridgeRemoved = false;
  const browserWindow = {
    fetch(input, init) {
      visibleCalls.push({ kind: "http", url: String(input), init });
      return Promise.resolve({});
    },
    WebSocket: BrowserWebSocket,
    Headers,
    Request,
    URL,
    Array,
    Object,
    String,
    Symbol,
    Reflect,
    location: { href: "https://desktop.test/box/terminal/", pathname: "/box/terminal/" },
    document: { currentScript: { remove() { bridgeRemoved = true; } } },
  };
  vm.runInNewContext(bridgeSource, {
    window: browserWindow,
  });
  assert.equal(bridgeRemoved, true, "the capability-bearing prelude removes itself before agent HTML runs");
  await browserWindow.fetch("/box/terminal/token");
  new browserWindow.WebSocket("wss://desktop.test/box/terminal/ws", "tty");
  const visibleToken = new URL(visibleCalls[0].url, "https://desktop.test/box/terminal/");
  const visibleSocket = new URL(visibleCalls[1].url, "https://desktop.test/box/terminal/");
  assert.equal(visibleToken.pathname, "/box/terminal/token", "the bridge must retain AgentGlass's visible /box prefix");
  assert.equal(visibleToken.search, "", "terminal auth must never enter the URL");
  assert.equal(visibleCalls[0].init.headers.get("x-agenthost-terminal-capability"), capability);
  assert.equal(visibleSocket.pathname, "/box/terminal/ws", "the socket must retain AgentGlass's visible /box prefix");
  assert.equal(visibleSocket.search, "", "socket auth must never enter the URL");
  assert.deepEqual(Array.from(visibleCalls[1].protocols), ["tty", `ahterm.${capability}`]);

  const missingTicket = await fetch(captured.base + "/terminal/token", {
    headers: { origin: "null", "sec-fetch-site": "cross-site" },
  });
  assert.equal(missingTicket.status, 401);

  const misplacedCapability = await fetch(captured.base + "/terminal/token", {
    headers: {
      origin: captured.base,
      "sec-fetch-site": "same-origin",
      "x-agenthost-terminal-capability": capability,
    },
  });
  assert.equal(misplacedCapability.status, 403, "terminal capabilities work only from the opaque terminal frame");

  const token = await fetch(captured.base + "/terminal/token", {
    headers: {
      origin: "null",
      "sec-fetch-site": "cross-site",
      "x-agenthost-terminal-capability": capability,
    },
  });
  assert.equal(token.status, 200);
  assert.equal(token.headers.get("access-control-allow-origin"), "null");
  assert.deepEqual(await token.json(), { token: "ttyd-token" });

  const misplacedWs = await rawUpgradeTo(
    captured.base,
    null,
    "/terminal/ws",
    { Origin: captured.base, "Sec-Fetch-Site": "same-origin", "Sec-WebSocket-Protocol": `tty, ahterm.${capability}` },
  );
  assert.match(misplacedWs, /^HTTP\/1\.1 403 Forbidden/m);

  const missingOriginWs = await rawUpgradeTo(
    captured.base,
    null,
    "/terminal/ws",
    { "Sec-Fetch-Site": "same-origin", "Sec-WebSocket-Protocol": `tty, ahterm.${capability}` },
  );
  assert.match(missingOriginWs, /^HTTP\/1\.1 403 Forbidden/m, "terminal capabilities require the opaque frame Origin");

  const ws = await rawUpgradeTo(
    captured.base,
    null,
    "/terminal/ws",
    { Origin: "null", "Sec-Fetch-Site": "cross-site", "Sec-WebSocket-Protocol": `tty, ahterm.${capability}` },
  );
  assert.match(ws, /^HTTP\/1\.1 101 Switching Protocols/m);
  assert.doesNotMatch(ws, /^(?:Set-Cookie|Clear-Site-Data|Location):/im);

  const hostileRead = await fetch(captured.base + "/autonomy", {
    headers: { cookie: captured.cookie, origin: "null", "sec-fetch-site": "cross-site" },
  });
  assert.equal(hostileRead.status, 403);
  assert.match(await hostileRead.text(), /opaque|cross-site.*operator|operator.*(?:opaque|cross-site)/i);

  const hostileMutation = await fetch(captured.base + "/autonomy", {
    method: "POST",
    headers: {
      cookie: captured.cookie,
      origin: "null",
      "sec-fetch-site": "cross-site",
      "content-type": "application/json",
    },
    body: JSON.stringify({ on: true }),
  });
  assert.equal(hostileMutation.status, 403);
  assert.match(await hostileMutation.text(), /opaque|cross-site.*operator|operator.*(?:opaque|cross-site)/i);
  const autonomy = await fetch(captured.base + "/autonomy", { headers: { cookie: captured.cookie } });
  assert.equal(autonomy.status, 200);
  assert.equal((await autonomy.json()).on, false, "the hostile terminal document must not mutate operator state");

  const entries = fs.readFileSync(captured.capture, "utf8")
    .split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const tokenHop = entries.find((entry) => entry.kind === "http" && entry.path.startsWith("/terminal/token"));
  const wsHop = entries.find((entry) => entry.kind === "ws" && /GET \/terminal\/ws/.test(entry.request));
  assert.ok(tokenHop);
  assert.equal(tokenHop.path, "/terminal/token", "the terminal capability must stop at the gate");
  assert.equal(tokenHop.headers.cookie, undefined);
  assert.equal(tokenHop.headers.authorization, undefined);
  assert.equal(tokenHop.headers["x-agenthost-terminal-capability"], undefined);
  assert.ok(wsHop);
  assert.doesNotMatch(wsHop.request, /ahterm\.|terminal.capability|^(?:Cookie|Authorization|Proxy-Authorization):/im);
  assert.match(wsHop.request, /^Sec-WebSocket-Protocol: tty$/im);
});

test("unsafe operator requests require the exact browser origin", async () => {
  const missingOrigin = await fetch(base + "/autonomy", {
    method: "POST",
    headers: { cookie, "sec-fetch-site": "same-origin", "content-type": "application/json" },
    body: JSON.stringify({ on: true }),
  });
  assert.equal(missingOrigin.status, 403);
  assert.match(await missingOrigin.text(), /missing-origin|origin.*required/i);

  const wrongScheme = await fetch(base + "/autonomy", {
    method: "POST",
    headers: { cookie, origin: base.replace("http:", "https:"), "sec-fetch-site": "same-origin", "content-type": "application/json" },
    body: JSON.stringify({ on: true }),
  });
  assert.equal(wrongScheme.status, 403);
  assert.match(await wrongScheme.text(), /foreign.*operator|operator.*foreign/i);

  const flyTlsRequest = await operatorPostWithHeaders("/autonomy", {
    host: "box.fly.dev",
    origin: "https://box.fly.dev",
    "x-forwarded-proto": "https",
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
  }, JSON.stringify({ on: false }));
  assert.equal(flyTlsRequest.status, 200, `Fly's documented X-Forwarded-Proto must preserve real HTTPS operator actions: ${flyTlsRequest.body}`);

  const readWithoutOrigin = await fetch(base + "/autonomy", { headers: { cookie } });
  assert.equal(readWithoutOrigin.status, 200, "safe same-origin reads remain compatible with navigation and non-browser probes");
  assert.equal((await readWithoutOrigin.json()).on, false);
});

test("non-canonical raw HTTP and WebSocket targets never reach ttyd", async (t) => {
  const captured = await bootGateWithCapturedTerminal(t);
  const before = fs.existsSync(captured.capture) ? fs.readFileSync(captured.capture, "utf8") : "";
  for (const requestTarget of [
    "/terminal/a/../token",
    "/terminal/%2e%2e/token",
    "/terminal\\a\\..\\token",
    `http://${new URL(captured.base).host}/terminal/token`,
    "//outside.invalid/terminal/token",
  ]) {
    const response = await rawHttpTo(captured.base, captured.cookie, requestTarget);
    assert.match(response, /^HTTP\/1\.1 (?:400 Bad Request|404 Not Found)/m, requestTarget);
    assert.match(response, /canonical|route.*not found|malformed|unsupported/i, requestTarget);
  }
  for (const requestTarget of [
    "/terminal/a/../ws",
    "/terminal/%2e%2e/ws",
    "/terminal\\a\\..\\ws",
    `http://${new URL(captured.base).host}/terminal/ws`,
    "//outside.invalid/terminal/ws",
  ]) {
    const response = await rawUpgradeTo(captured.base, captured.cookie, requestTarget);
    assert.match(response, /^HTTP\/1\.1 (?:400 Bad Request|404 Not Found)/m, requestTarget);
    assert.match(response, /canonical|websocket.*not found|malformed|unsupported/i, requestTarget);
  }
  const after = fs.existsSync(captured.capture) ? fs.readFileSync(captured.capture, "utf8") : "";
  assert.equal(after, before, "raw route aliases must be refused before any ttyd connection");
});

test("opaque token failures stay CORS-readable and name the ttyd cause", async (t) => {
  for (const tokenMode of ["fail", "malformed-shape"]) {
    const captured = await bootGateWithCapturedTerminal(t, { tokenMode });
    const document = await fetch(captured.base + "/terminal/", {
      headers: { cookie: captured.cookie, "sec-fetch-dest": "iframe", "sec-fetch-site": "same-origin" },
    });
    const capability = /const capability=(?:"|')([A-Za-z0-9_-]{43})(?:"|')/.exec(await document.text())?.[1];
    assert.ok(capability);
    const response = await fetch(captured.base + "/terminal/token", {
      headers: {
        origin: "null",
        "sec-fetch-site": "cross-site",
        "x-agenthost-terminal-capability": capability,
      },
    });
    assert.equal(response.status, 502, tokenMode);
    assert.equal(response.headers.get("access-control-allow-origin"), "null", tokenMode);
    const cause = await response.text();
    if (tokenMode === "fail") assert.match(cause, /fake ttyd token socket refused/i);
    else assert.match(cause, /malformed.*token|token.*malformed/i);
  }
});

test("unknown WebSocket upgrades cannot fall through to ttyd", async () => {
  const response = await rawUpgrade("/not-a-terminal-socket");
  assert.match(response, /^HTTP\/1\.1 404 Not Found/m);
  assert.match(response, /websocket.*not found|only.*terminal\/ws/i);
});

test("the agent-owned standalone Hermes dashboard is retired from the operator origin", async () => {
  for (const pathname of ["/hermes", "/hermes/", "/hermes/api/status"]) {
    const response = await authed(pathname, { "sec-fetch-site": "same-origin" });
    assert.ok(response.status === 404 || response.status === 410, pathname);
    assert.equal(response.headers.get("location"), null, pathname);
    assert.match(await response.text(), /Hermes.*(?:retired|removed)|standalone.*(?:retired|removed)/i, pathname);
  }
  const upgrade = await rawUpgrade("/hermes/ws");
  assert.match(upgrade, /^HTTP\/1\.1 (?:404 Not Found|410 Gone)/m);
  assert.match(upgrade, /Hermes.*(?:retired|removed)|standalone.*(?:retired|removed)/i);
});

test("terminal window switching is POST-only and names an unavailable tmux seam", async () => {
  const legacyGet = await authed("/switch?window=claude", { "sec-fetch-site": "same-origin" });
  assert.equal(legacyGet.status, 405);
  assert.match(await legacyGet.text(), /POST.*required|method.*not allowed/i);

  const response = await fetch(base + "/switch?window=claude", {
    method: "POST",
    headers: { cookie, "sec-fetch-site": "same-origin", origin: base },
  });
  assert.equal(response.status, 503, "the fixture has no tmux seam drainer, so it must not claim a switch");
  assert.match(await response.text(), /tmux seam is unavailable or full.*not changed/i);

  const seamDir = path.join(home, ".tmux-seam");
  const seamState = path.join(seamDir, "windows.state");
  const seamFifo = path.join(seamDir, "cmd.fifo");
  fs.mkdirSync(seamDir, { recursive: true });
  fs.writeFileSync(seamState, `${Math.floor(Date.now() / 1000)}\nshell|1\ncodex|0\n`);
  fs.writeFileSync(seamFifo, "");

  const absent = await fetch(base + "/switch?window=cursor", {
    method: "POST",
    headers: { cookie, "sec-fetch-site": "same-origin", origin: base },
  });
  assert.equal(absent.status, 503);
  assert.match(await absent.text(), /tmux window cursor is not running.*not changed/i);
  assert.equal(fs.readFileSync(seamFifo, "utf8"), "", "an absent window is rejected before a command reaches the seam");

  const unacknowledged = await fetch(base + "/switch?window=codex", {
    method: "POST",
    headers: { cookie, "sec-fetch-site": "same-origin", origin: base },
  });
  assert.equal(unacknowledged.status, 503, "FIFO enqueue alone is not a successful switch");
  assert.match(await unacknowledged.text(), /did not confirm codex as active.*could not be verified/i);
  assert.equal(fs.readFileSync(seamFifo, "utf8"), "select codex\n");

  fs.writeFileSync(seamState, `${Math.floor(Date.now() / 1000)}\nshell|1\ncodex|0\n`);
  const publish = setTimeout(() => {
    fs.writeFileSync(seamState, `${Math.floor(Date.now() / 1000) + 1}\nshell|0\ncodex|1\n`);
  }, 75);
  const present = await fetch(base + "/switch?window=codex", {
    method: "POST",
    headers: { cookie, "sec-fetch-site": "same-origin", origin: base },
  });
  clearTimeout(publish);
  assert.equal(present.status, 204, "a newer agent publication confirms the selected window is active");
});

test("the runtime gives ttyd its scoped base and removes handwritten page assets from the image", () => {
  const start = fs.readFileSync(path.join(ROOT, "container", "start.sh"), "utf8");
  const dockerfile = fs.readFileSync(path.join(ROOT, "container", "Dockerfile"), "utf8");
  const retiredSwitcherMemory = path.join(
    ROOT,
    "container",
    "home-seed",
    ".claude",
    "memory-imported",
    "hermes-box-migration.md",
  );
  assert.match(start, /ttyd[\s\S]{0,220}--base-path \/terminal/);
  assert.equal(
    fs.existsSync(retiredSwitcherMemory),
    false,
    "new boxes must not be seeded with retired apps.json, nav-script, or appshell instructions",
  );
  for (const page of ["cc.html", "chat.html", "cron.html", "kanban.html", "brain.html", "settings.html"]) {
    assert.equal(fs.existsSync(path.join(ROOT, "container", page)), false, `${page} must not remain as dead source`);
    assert.doesNotMatch(dockerfile, new RegExp(`^COPY\\s+${page.replace(".", "\\.")}\\s`, "m"), `${page} must not ship after the shell cutover`);
  }
  for (const retiredTool of [
    ["test", "ui", "appshell.test.mjs"],
    ["test", "ui", "rig.mjs"],
    ["test", "ui", "brand-shots.mjs"],
    ["test", "ui", "screenshots.mjs"],
    ["scripts", "preview-cc.mjs"],
  ]) {
    assert.equal(fs.existsSync(path.join(ROOT, ...retiredTool)), false, `${retiredTool.join("/")} must not remain as a legacy door`);
  }
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.match(packageJson.scripts["test:ui"], /dashboard-complete-journeys\.test\.mjs/);
  assert.doesNotMatch(packageJson.scripts["test:ui"], /appshell\.test|rig\.mjs/);
});

test("a local terminal failure cannot resurrect the handwritten mirror page", () => {
  const source = fs.readFileSync(GATE, "utf8");
  assert.doesNotMatch(source, /Local mirror — no terminal/);
  for (const href of ["/cc", "/chat", "/cron"]) {
    assert.doesNotMatch(source, new RegExp(`href=["']${href.replace("/", "\\/")}["']`), `${href} must not return as a terminal-error escape link`);
  }
});
