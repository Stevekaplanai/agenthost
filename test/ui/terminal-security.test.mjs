import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { stopChild } from "../child-process-helper.js"
import { mintOperatorSession } from "../operator-session-helper.js"

const require = createRequire(import.meta.url)
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(MODULE_DIR, "..", "..")
const GATE = path.join(ROOT, "container", "gate.js")
const KEY = "terminal-browser-security-key"
const PINNED_CHROMIUM = "/opt/pw-browsers/chromium"
const WINDOWS_CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
const FAKE_TTYD_HTML = `<!doctype html><html><body><script>
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
    const response = await fetch("/autonomy", { method: "POST", credentials: "include", headers: { "content-type": "text/plain" }, body: JSON.stringify({ on: true }) });
    document.body.dataset.mutationStatus = String(response.status);
    document.body.dataset.mutationCause = (await response.text()).slice(0, 160);
  } catch (error) { document.body.dataset.mutationError = String(error && error.message || error); }
});
</script></body></html>`

async function launchBrowser() {
  let playwright
  try {
    playwright = require("playwright-core")
  } catch (error) {
    const dependencyRoot = String(process.env.AGENTHOST_PLAYWRIGHT_ROOT || "").trim()
    if (!dependencyRoot) throw error
    playwright = require(path.join(dependencyRoot, "node_modules", "playwright-core"))
  }
  if (fs.existsSync(PINNED_CHROMIUM)) return playwright.chromium.launch({ executablePath: PINNED_CHROMIUM, timeout: 15_000 })
  if (fs.existsSync(WINDOWS_CHROME)) return playwright.chromium.launch({ executablePath: WINDOWS_CHROME, timeout: 15_000 })
  return playwright.chromium.launch({ channel: "chrome", timeout: 15_000 })
}

async function bootGate(t) {
  const home = fs.mkdtempSync(path.join(MODULE_DIR, ".terminal-browser-security-"))
  const capture = path.join(home, "terminal-capture.jsonl")
  const preload = path.join(home, "terminal-backend.cjs")
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
  if (!options || !String(options.socketPath || "").endsWith("ttyd.sock")) return originalRequest.apply(this, arguments);
  record({ kind: "http", path: options.path, headers: options.headers });
  const request = new PassThrough();
  process.nextTick(() => {
    const response = new PassThrough();
    response.statusCode = 200;
    response.statusMessage = "OK";
    const isIndex = String(options.path || "") === "/terminal/";
    response.headers = { "content-type": isIndex ? "text/html; charset=utf-8" : "application/json", "set-cookie": ["agent_owned=blocked; Path=/"] };
    callback(response);
    response.end(isIndex ? ${JSON.stringify(FAKE_TTYD_HTML)} : '{"token":"ttyd-token"}');
  });
  return request;
};
const originalConnect = net.connect;
net.connect = function(...args) {
  if (typeof args[0] !== "string" || !args[0].endsWith("ttyd.sock")) return originalConnect.apply(this, args);
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
        this.push("HTTP/1.1 101 Switching Protocols\\r\\nConnection: Upgrade\\r\\nUpgrade: websocket\\r\\nSec-WebSocket-Accept: " + accept + "\\r\\nSec-WebSocket-Protocol: tty\\r\\nSet-Cookie: agent_owned_ws=blocked; Path=/\\r\\n\\r\\n");
      }
      done();
    },
  });
  process.nextTick(() => callback.call(socket));
  return socket;
};
`)
  const nodeOptions = [process.env.NODE_OPTIONS || "", `--require=${preload}`].filter(Boolean).join(" ")
  const child = spawn(process.execPath, [GATE], {
    env: {
      ...process.env,
      HOME: home,
      TTYD_PASSWORD: KEY,
      GATE_PORT: "0",
      CHANNEL_DISPATCH_PORT: "0",
      KANBAN_BRIDGE_PORT: "0",
      BOARD_AUTONOMY: "off",
      TERMINAL_BACKEND_CAPTURE: capture,
      NODE_OPTIONS: nodeOptions,
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  const base = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`gate did not listen; stdout=${stdout}; stderr=${stderr}`)), 15_000)
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString()
      const match = stdout.match(/listening on (\d+)/)
      if (match) {
        clearTimeout(timeout)
        resolve(`http://127.0.0.1:${match[1]}`)
      }
    })
    child.stderr.on("data", (chunk) => { stderr += chunk.toString() })
    child.once("exit", (code) => {
      clearTimeout(timeout)
      reject(new Error(`gate exited ${code}; stdout=${stdout}; stderr=${stderr}`))
    })
  })
  const { cookie } = await mintOperatorSession(base, KEY)
  t.after(async () => {
    await stopChild(child)
    fs.rmSync(home, { recursive: true, force: true })
  })
  return { base, cookie, capture }
}

test("390px opaque terminal can connect while replaced ttyd content cannot use operator authority", async (t) => {
  const gate = await bootGate(t)
  const browser = await launchBrowser()
  t.after(() => browser.close())
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const [name, value] = gate.cookie.split("=", 2)
  await context.addCookies([{ name, value, url: gate.base, httpOnly: true, sameSite: "Strict" }])
  const page = await context.newPage()
  await page.goto(gate.base, { waitUntil: "domcontentloaded" })
  const frameAttached = page.waitForEvent("frameattached")
  await page.evaluate(() => {
    const iframe = document.createElement("iframe")
    iframe.id = "terminal-security-proof"
    iframe.src = "/terminal/"
    document.body.appendChild(iframe)
  })
  const frame = await frameAttached
  await frame.waitForURL(/\/terminal\/$/)
  await frame.waitForFunction(() => document.body.dataset.tokenStatus || document.body.dataset.tokenError, null, { timeout: 10_000 })
  await frame.waitForFunction(() => document.body.dataset.ws, null, { timeout: 10_000 })
  await frame.waitForFunction(() => document.body.dataset.operatorError || document.body.dataset.operatorStatus, null, { timeout: 10_000 })
  await frame.waitForFunction(() => document.body.dataset.mutationError || document.body.dataset.mutationStatus, null, { timeout: 10_000 })
  const state = await frame.evaluate(() => ({ ...document.body.dataset }))
  assert.equal(state.tokenStatus, "200", state.tokenError)
  assert.equal(state.token, "ttyd-token")
  assert.equal(state.ws, "open")
  assert.ok(state.operatorError, `operator GET must stay unreadable; observed ${JSON.stringify(state)}`)
  assert.ok(state.mutationError, `operator POST must stay unreadable; observed ${JSON.stringify(state)}`)

  const autonomy = await fetch(`${gate.base}/autonomy`, { headers: { cookie: gate.cookie } })
  assert.equal(autonomy.status, 200)
  assert.equal((await autonomy.json()).on, false, "the hostile terminal frame must not mutate operator state")

  const entries = fs.readFileSync(gate.capture, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
  const tokenHop = entries.find((entry) => entry.kind === "http" && entry.path === "/terminal/token")
  const wsHop = entries.find((entry) => entry.kind === "ws")
  assert.ok(tokenHop)
  assert.equal(tokenHop.headers.cookie, undefined)
  assert.equal(tokenHop.headers["x-agenthost-terminal-capability"], undefined)
  assert.ok(wsHop)
  assert.doesNotMatch(wsHop.request, /ahterm\.|agenthost_auth|^Cookie:/im)
  assert.match(wsHop.request, /^Sec-WebSocket-Protocol: tty$/im)
})
