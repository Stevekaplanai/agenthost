// E2E tests against the REAL gate.js for the Command Center aggregate route.
// Closes the gap the adversarial review flagged: the UI test rig's /cc/state
// fixture is a HAND-COPIED mirror of handleCommandCenter's response shape --
// nothing exercised the real route, so a field rename there (e.g. gate.js
// reverting to Hermes's native gateway_running instead of the camelCased
// gatewayRunning) would pass every test while the Command Center panels
// silently broke in production. This file hits the real /cc and /cc/state.
//
// No tmux/Hermes/Ollama process exists in this sandbox -- that's the point:
// it proves the "a dead backend renders as down, never a broken page"
// contract holds when EVERY backend is down, not just the tested happy path.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const GATE = path.join(import.meta.dirname, "..", "container", "gate.js");
const KEY = "gate-cc-test-key";

const boxes = { dev: {}, legal: {} };

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
  for (const [name, env] of [["dev", {}], ["legal", { LEGAL_MODE: "api" }]]) {
    const home = fs.mkdtempSync(path.join(import.meta.dirname, `.gatecc-${name}-`));
    fs.mkdirSync(path.join(home, "work"), { recursive: true });
    const { child, port } = bootGate(home, env);
    boxes[name].home = home;
    boxes[name].gate = child;
    boxes[name].base = `http://127.0.0.1:${await port}`;
    const login = await fetch(`${boxes[name].base}/?key=${KEY}`, { redirect: "manual" });
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

function get(box, p) {
  return fetch(box.base + p, { headers: { cookie: box.cookie }, redirect: "manual" });
}

test("dev: GET /cc serves the real page", async () => {
  const r = await get(boxes.dev, "/cc");
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.ok(html.includes('id="ccseg"'), "engine switcher present");
  assert.ok(html.includes('data-panel="claude"'), "claude panel present");
});

test("dev: GET /cc/state returns the real aggregate shape with every backend down", async () => {
  const r = await get(boxes.dev, "/cc/state?tz=-240");
  assert.equal(r.status, 200);
  const st = await r.json();
  // day + usage: no chat turns recorded in this fresh sandbox.
  assert.match(st.day, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(st.usage, {}, "no usage yet on a fresh box");
  // windows: no tmux session in this sandbox -> null, not a thrown error.
  assert.equal(st.windows, null, "tmuxWindows() degrades to null when tmux/session is absent");
  // hermes/ollama: this test only controls whether OUR sandbox's gate can
  // reach a backend on 127.0.0.1:9119/11434 -- it does NOT control whether
  // something else on the machine running this suite happens to be bound to
  // those loopback ports (true on a dev box with its own Hermes/Ollama
  // running). The real assertion is the shape/type contract -- never a
  // thrown error or an unexpected type, in either state -- not "must be
  // down", which the localJson fix (settle on backend death) doesn't change.
  if (st.hermes !== null) {
    assert.equal(typeof st.hermes.gatewayRunning, "boolean");
    assert.equal(typeof st.hermes.activeSessions, "number");
  }
  assert.equal(typeof st.ollama.up, "boolean");
  assert.ok(Array.isArray(st.ollama.loaded));
  assert.ok(st.ollama.pulled === null || typeof st.ollama.pulled === "number");
  // feed: empty audit log -> empty array, not an error.
  assert.deepEqual(st.feed, [], "no audit events yet");
});

test("dev: /cc/state completes promptly even though every backend is unreachable (no hang)", async () => {
  const t0 = Date.now();
  const r = await get(boxes.dev, "/cc/state");
  assert.equal(r.status, 200);
  await r.text();
  // Well under the 2.5s localJson timeout -- ECONNREFUSED (no listener) is
  // immediate, unlike the mid-response-death case the localJson fix targets.
  assert.ok(Date.now() - t0 < 2000, "connection-refused backends resolve fast, not via the timeout path");
});

test("dev: chat_run and brain_run audit lines carry a structured eng field, not a text prefix", async () => {
  // A message on the default engine (claude): starting with text that LOOKS
  // like an engine prefix must not be misread by the feed -- this is the
  // exact collision the adversarial review found (a prefix baked into
  // `detail` could be forged by the user's own query text).
  await get(boxes.dev, "/chat/stream?msg=" + encodeURIComponent("/brain hermes: gateway config"));
  const r = await get(boxes.dev, "/cc/state");
  const st = await r.json();
  const brainEvents = st.feed.filter((e) => e.what.includes("searched the brain"));
  assert.equal(brainEvents.length, 1);
  assert.equal(brainEvents[0].eng, "claude", "engine comes from audit()'s structured field, not parsed from the query text");
  assert.ok(brainEvents[0].what.includes("hermes: gateway config"), "the query text is preserved verbatim, not eaten as a false prefix");
});

test("legal: /cc redirects to /chat (no Command Center on a single-engine box)", async () => {
  const r = await get(boxes.legal, "/cc");
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), "/chat");
});

test("legal: /cc/state 404s (mirrors /cc's brand gate -- no live endpoint for a surface that doesn't exist)", async () => {
  const r = await get(boxes.legal, "/cc/state");
  assert.equal(r.status, 404);
});
