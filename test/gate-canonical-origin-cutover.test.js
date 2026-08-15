import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { stopChild } from "./child-process-helper.js";

const ROOT = path.join(import.meta.dirname, "..");
const GATE = path.join(ROOT, "container", "gate.js");
const KEY = "canonical-origin-cutover-test-key";
const CANONICAL_HOST = "app.agenthost.space";
const RETIRED_HOST = "agenthost-steve.fly.dev";

let child;
let home;
let port;
let cookie;

function bootGate() {
  home = fs.mkdtempSync(path.join(import.meta.dirname, ".gate-canonical-origin-"));
  child = spawn(process.execPath, [GATE], {
    env: {
      ...process.env,
      HOME: home,
      TTYD_PASSWORD: KEY,
      GATE_PORT: "0",
      CHANNEL_DISPATCH_PORT: "0",
      KANBAN_BRIDGE_PORT: "0",
      BOARD_AUTONOMY: "off",
      AGENTHOST_CANONICAL_HOST: CANONICAL_HOST,
      AGENTHOST_MESH_PEERS: JSON.stringify({ "box-peer": "peer-secret" }),
      MAIL_WEBHOOK_SECRET: "aaaaaaaa",
      CHECKOUT_WEBHOOK_SECRET: "bbbbbbbb",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(
      () => reject(new Error(`gate did not listen; stdout=${stdout}; stderr=${stderr}`)),
      15_000,
    );
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const match = stdout.match(/listening on (\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(Number(match[1]));
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`gate exited ${code}; stdout=${stdout}; stderr=${stderr}`));
    });
  });
}

function request({ host, pathname, method = "GET", headers = {}, body = "" }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: pathname,
      method,
      headers: {
        host,
        "x-forwarded-proto": "https",
        "content-length": Buffer.byteLength(body),
        ...headers,
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

function upgrade(host, pathname) {
  return new Promise((resolve, reject) => {
    let response = "";
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(
        `GET ${pathname} HTTP/1.1\r\n` +
        `Host: ${host}\r\n` +
        "Connection: Upgrade\r\n" +
        "Upgrade: websocket\r\n" +
        "Sec-WebSocket-Version: 13\r\n" +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
        "Sec-WebSocket-Protocol: tty\r\n\r\n",
      );
    });
    socket.setTimeout(3_000, () => socket.destroy(new Error("upgrade response timed out")));
    socket.on("data", (chunk) => { response += chunk.toString(); });
    socket.on("end", () => resolve(response));
    socket.on("close", (hadError) => { if (!hadError) resolve(response); });
    socket.on("error", reject);
  });
}

function assertRetired(response, label) {
  assert.equal(response.status, 421, `${label} must be refused as a retired origin`);
  assert.equal(response.headers.location, undefined, `${label} must never redirect`);
  assert.equal(response.headers["set-cookie"], undefined, `${label} must never mint or refresh a cookie`);
  assert.equal(response.headers["cache-control"], "no-store", `${label} must never be cached`);
  assert.match(String(response.headers["clear-site-data"] || ""), /cookies.*storage/i,
    `${label} must tell a reachable browser to clear the retired origin`);
  assert.match(
    response.body,
    /(?:retired|clean-origin|canonical).*(?:security|operator|hostname)|(?:security|operator|hostname).*(?:retired|clean-origin|canonical)/i,
    `${label} must name the clean-origin security cause`,
  );
}

before(async () => {
  port = await bootGate();
  const body = JSON.stringify({ key: KEY });
  const login = await request({
    host: CANONICAL_HOST,
    pathname: "/session",
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: `https://${CANONICAL_HOST}`,
      "sec-fetch-site": "same-origin",
    },
    body,
  });
  assert.equal(login.status, 204);
  cookie = String(login.headers["set-cookie"]?.[0] || "").split(";", 1)[0];
  assert.match(cookie, /^agenthost_auth=/, "canonical login grants the operator cookie");
});

after(async () => {
  if (child) await stopChild(child);
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

test("the configured canonical hostname remains the only operator origin", async () => {
  const shell = await request({ host: CANONICAL_HOST, pathname: "/", headers: { cookie } });
  assert.equal(shell.status, 200);
  assert.equal(shell.headers.location, undefined);
  assert.match(shell.body, /<!doctype html>/i);

  const state = await request({ host: CANONICAL_HOST, pathname: "/autonomy", headers: { cookie } });
  assert.equal(state.status, 200);
  assert.equal(JSON.parse(state.body).on, false);

  const portQualified = await request({ host: `${CANONICAL_HOST}:443`, pathname: "/", headers: { cookie } });
  assert.equal(portQualified.status, 200, "an ordinary Host port does not create a second origin policy");
});

test("the retired hostname cannot log in, serve the shell, read operator state, or mutate it", async () => {
  assertRetired(await request({ host: RETIRED_HOST, pathname: "/" }), "anonymous shell");
  assertRetired(
    await request({ host: RETIRED_HOST, pathname: `/?key=${encodeURIComponent(KEY)}` }),
    "access-key login",
  );
  assertRetired(
    await request({
      host: RETIRED_HOST,
      pathname: "/session",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accessKey: KEY, totp: "000000" }),
    }),
    "AgentGlass session mint",
  );
  assertRetired(
    await request({ host: RETIRED_HOST, pathname: "/cc/state", headers: { cookie } }),
    "cookie-authenticated API read",
  );
  assertRetired(
    await request({
      host: RETIRED_HOST,
      pathname: "/autonomy",
      method: "POST",
      headers: {
        cookie,
        origin: `https://${RETIRED_HOST}`,
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
      body: JSON.stringify({ on: true }),
    }),
    "cookie-authenticated mutation",
  );

  const state = await request({ host: CANONICAL_HOST, pathname: "/autonomy", headers: { cookie } });
  assert.equal(state.status, 200);
  assert.equal(JSON.parse(state.body).on, false, "the refused old-origin POST had no side effect");
});

test("the retired hostname exposes neither active app assets nor the terminal transport", async () => {
  for (const pathname of ["/mode.json", "/sw.js", "/manifest.webmanifest", "/terminal/"]) {
    assertRetired(
      await request({
        host: RETIRED_HOST,
        pathname,
        headers: pathname === "/terminal/"
          ? { cookie, "sec-fetch-site": "same-origin", "sec-fetch-dest": "iframe" }
          : {},
      }),
      pathname,
    );
  }

  const retiredSocket = await upgrade(RETIRED_HOST, "/terminal/ws");
  assert.match(retiredSocket, /^HTTP\/1\.1 421 Misdirected Request/m);
  assert.doesNotMatch(retiredSocket, /^Location:/im, "retired WebSocket refuses instead of redirecting");
  assert.match(retiredSocket, /retired|clean-origin|canonical/i);

  const canonicalSocket = await upgrade(CANONICAL_HOST, "/terminal/ws");
  assert.match(canonicalSocket, /^HTTP\/1\.1 401 Unauthorized/m, "canonical WebSocket reaches terminal capability auth");
});

test("old-host compatibility is limited to Fly health and independently keyed machine routes", async () => {
  const health = await request({ host: RETIRED_HOST, pathname: "/brand.json" });
  assert.equal(health.status, 200, "the configured Fly health check remains reachable");
  assert.deepEqual(JSON.parse(health.body), { brand: "dev" });

  const internalHealth = await request({ host: "fly-internal-health.invalid", pathname: "/brand.json" });
  assert.equal(internalHealth.status, 200, "Fly may use an internal Host value for health checks");

  const meshIdentityFile = path.join(home, ".claude", "agenthost", "mesh", "identity.json");
  assert.equal(fs.existsSync(meshIdentityFile), false);
  const unknownMesh = await request({ host: RETIRED_HOST, pathname: "/mesh/anything" });
  assertRetired(unknownMesh, "unknown mesh route");
  const mesh = await request({ host: RETIRED_HOST, pathname: "/mesh/identity" });
  assert.equal(mesh.status, 401, "the exact HMAC mesh route reaches authentication");
  assert.equal(fs.existsSync(meshIdentityFile), false, "unauthenticated old-host mesh traffic creates no identity state");

  assertRetired(await request({
    host: RETIRED_HOST,
    pathname: "/review",
    method: "POST",
    headers: { "content-type": "application/json", "x-gate-key": KEY },
    body: "{}",
  }), "review publisher using the browser login key");

  const checkout = await request({
    host: RETIRED_HOST,
    pathname: "/checkout/complete",
    method: "POST",
    headers: { "content-type": "application/json", "x-checkout-secret": "wrong" },
    body: "{}",
  });
  assert.notEqual(checkout.status, 421, "the keyed checkout route reaches its own authentication/config boundary");

  for (const pathname of ["/mail/subscribe", "/mail/pending"]) {
    const mail = await request({
      host: RETIRED_HOST,
      pathname,
      method: "POST",
      headers: { "content-type": "application/json", "x-mail-secret": "wrong" },
      body: "{}",
    });
    assert.notEqual(mail.status, 421, `${pathname} reaches its independent X-Mail-Secret boundary`);
  }

  const unsubscribe = await request({
    host: RETIRED_HOST,
    pathname: "/mail/unsub?t=opaque-test-token",
    headers: { "x-mail-secret": "wrong" },
  });
  assert.equal(unsubscribe.status, 401, "the compliance-sensitive unsubscribe relay reaches X-Mail-Secret auth");
  assert.equal(unsubscribe.headers["set-cookie"], undefined);

  for (const [pathname, header, value] of [
    ["/mail/subscribe", "x-mail-secret", "éééééééé"],
    ["/checkout/complete", "x-checkout-secret", "éééééééé"],
  ]) {
    const malformed = await request({
      host: RETIRED_HOST,
      pathname,
      method: "POST",
      headers: { "content-type": "application/json", [header]: value },
      body: "{}",
    });
    assert.equal(malformed.status, 401, `${pathname} rejects a same-character/different-byte secret without crashing`);
    assert.equal(malformed.headers["set-cookie"], undefined);
  }

  const loginSmuggle = await request({
    host: RETIRED_HOST,
    pathname: `/mail/subscribe?key=${encodeURIComponent(KEY)}`,
    method: "POST",
    headers: { "content-type": "application/json", "x-mail-secret": "wrong" },
    body: "{}",
  });
  assert.equal(loginSmuggle.status, 400, "credentials in any URL are refused before a machine route can authenticate");
  assert.equal(loginSmuggle.headers.location, undefined);
  assert.equal(loginSmuggle.headers["set-cookie"], undefined);

  const stillAlive = await request({ host: CANONICAL_HOST, pathname: "/brand.json" });
  assert.equal(stillAlive.status, 200, "malformed machine credentials cannot crash the gateway");

  assertRetired(await request({ host: RETIRED_HOST, pathname: "/review" }), "non-POST review route");
  assertRetired(
    await request({ host: RETIRED_HOST, pathname: "/mail/stats", headers: { cookie } }),
    "cookie-authenticated mail statistics",
  );
});

test("AgentGlass defaults to the clean canonical box origin", () => {
  const proxySource = fs.readFileSync(
    path.join(ROOT, "control-plane", "overlay", "server", "src", "agenthost-box.ts"),
    "utf8",
  );
  const configSource = fs.readFileSync(
    path.join(ROOT, "control-plane", "Read-AgentHostKanbanConfig.ps1"),
    "utf8",
  );
  for (const [label, source] of [["proxy", proxySource], ["Windows config reader", configSource]]) {
    assert.match(source, /https:\/\/app\.agenthost\.space/, `${label} must use the clean canonical origin`);
    assert.doesNotMatch(source, /https:\/\/agenthost-steve\.fly\.dev/, `${label} must never default to the retired origin`);
  }
  const canonicalDefaultFiles = [
    ["box skill", path.join(ROOT, "container", "skills-preload", "agenthost-box", "SKILL.md")],
    ["subscribe relay", path.join(ROOT, "site", "api", "subscribe.js")],
    ["welcome relay", path.join(ROOT, "site", "api", "welcome-signup.js")],
    ["unsubscribe relay", path.join(ROOT, "site", "api", "unsubscribe.js")],
    ["checkout relay", path.join(ROOT, "site", "api", "checkout-webhook.js")],
  ];
  for (const [label, filename] of canonicalDefaultFiles) {
    const source = fs.readFileSync(filename, "utf8");
    assert.match(source, /https:\/\/app\.agenthost\.space/, `${label} must use the clean canonical origin`);
    assert.doesNotMatch(source, /https:\/\/agenthost-steve\.fly\.dev/, `${label} must not teach callers the retired origin`);
  }
});

test("the Foundation B launcher preserves the canonical-host release setting", () => {
  const launcher = fs.readFileSync(
    path.join(ROOT, "container", "entrypoint-launcher.c"),
    "utf8",
  );
  assert.match(
    launcher,
    /"AGENTHOST_CANONICAL_HOST"/,
    "the static release boundary must not strip the hostname before gate.js starts",
  );
});

test("production deploy and on-box QA use the canonical origin explicitly", () => {
  const workflow = fs.readFileSync(path.join(ROOT, ".github", "workflows", "auto-deploy.yml"), "utf8");
  const manualWorkflow = fs.readFileSync(path.join(ROOT, ".github", "workflows", "deploy-box.yml"), "utf8");
  const deployScript = fs.readFileSync(path.join(ROOT, "scripts", "deploy-box.sh"), "utf8");
  const redeployScript = fs.readFileSync(path.join(ROOT, "scripts", "redeploy-box.sh"), "utf8");
  const redeployPowerShell = fs.readFileSync(path.join(ROOT, "scripts", "redeploy-box.ps1"), "utf8");
  const spike = fs.readFileSync(path.join(ROOT, "scripts", "spike-deploy.ps1"), "utf8");
  const qaRoutes = JSON.parse(fs.readFileSync(path.join(ROOT, "container", "qa-routes.json"), "utf8"));
  assert.match(workflow, /--env AGENTHOST_CANONICAL_HOST=app\.agenthost\.space/);
  assert.match(manualWorkflow, /--canonical-host app\.agenthost\.space/);
  for (const [name, source] of Object.entries({ deployScript, redeployScript, redeployPowerShell, spike })) {
    assert.match(source, /app\.agenthost\.space[\s\S]*AGENTHOST_CANONICAL_HOST=/, `${name} pins Steve's exact canonical host`);
  }
  assert.equal(qaRoutes.baseUrl, "https://app.agenthost.space");
});

test("the Steve production app fails closed when its canonical hostname setting is absent", async () => {
  const failHome = fs.mkdtempSync(path.join(import.meta.dirname, ".gate-canonical-required-"));
  const failChild = spawn(process.execPath, [GATE], {
    env: {
      ...process.env,
      HOME: failHome,
      TTYD_PASSWORD: KEY,
      FLY_APP_NAME: "agenthost-steve",
      AGENTHOST_CANONICAL_HOST: "",
      GATE_PORT: "0",
      CHANNEL_DISPATCH_PORT: "0",
      KANBAN_BRIDGE_PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  failChild.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  failChild.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const code = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      failChild.kill("SIGKILL");
      reject(new Error(`production gate did not fail closed; stdout=${stdout}; stderr=${stderr}`));
    }, 10_000);
    failChild.on("exit", (exitCode) => { clearTimeout(timeout); resolve(exitCode); });
  });
  fs.rmSync(failHome, { recursive: true, force: true });
  assert.notEqual(code, 0);
  assert.match(stderr, /AGENTHOST_CANONICAL_HOST.*required.*agenthost-steve/i);
  assert.doesNotMatch(stdout, /listening on/);
});

test("the canonical login and public asset surface contain no retired app scripts", async () => {
  const login = await request({ host: CANONICAL_HOST, pathname: "/not-an-app-route" });
  assert.equal(login.status, 401);
  assert.doesNotMatch(login.body, /agenthost-appshell\.js|agenthost-nav\.js|apps\.json/i);
  assert.match(login.body, /manifest\.webmanifest/);
  assert.match(login.body, /theme\.css/);

  for (const pathname of ["/agenthost-appshell.js", "/agenthost-nav.js", "/apps.json"]) {
    const response = await request({ host: CANONICAL_HOST, pathname });
    assert.notEqual(response.status, 200, `${pathname} must no longer be a public application asset`);
    assert.doesNotMatch(response.body, /data-slot=["']nav|agenthost-frame|var APPS\s*=/i, pathname);
    const authenticated = await request({ host: CANONICAL_HOST, pathname, headers: { cookie } });
    assert.equal(authenticated.status, 404, `${pathname} must stay gone behind the cookie wall too`);
    assert.doesNotMatch(authenticated.body, /data-slot=["']nav|agenthost-frame|var APPS\s*=/i, pathname);
  }

  for (const pathname of ["/manifest.webmanifest", "/theme.css", "/icons/icon-192.png", "/sw.js"]) {
    const response = await request({ host: CANONICAL_HOST, pathname });
    assert.equal(response.status, 200, `${pathname} remains public because the login/PWA needs it`);
  }
});

test("the container source and image no longer wire the retired app shell", () => {
  const source = fs.readFileSync(GATE, "utf8");
  const dockerfile = fs.readFileSync(path.join(ROOT, "container", "Dockerfile"), "utf8");
  const layout = fs.readFileSync(path.join(ROOT, "dashboard", "app", "layout.tsx"), "utf8");
  assert.doesNotMatch(source, /<script[^>]+agenthost-appshell\.js/i);
  assert.doesNotMatch(source, /<script[^>]+agenthost-nav\.js/i);
  assert.doesNotMatch(source, /["']\/agenthost-appshell\.js["']\s*:/);
  assert.doesNotMatch(source, /["']\/agenthost-nav\.js["']\s*:/);
  assert.doesNotMatch(source, /["']\/apps\.json["']\s*:/);
  assert.doesNotMatch(dockerfile, /^COPY\s+appshell\.js\s+/m);
  assert.equal(fs.existsSync(path.join(ROOT, "container", "appshell.js")), false);
  assert.match(layout, /manifest:\s*["']\/manifest\.webmanifest["']/);
  assert.doesNotMatch(layout, /manifest:\s*["']\/manifest\.json["']/);
});
