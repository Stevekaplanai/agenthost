// The Visual QA trigger surface: POST /qa/run kicks off the browser-capture pass,
// GET /qa/result returns the latest outcome. These are the reachable surface the
// QA agent never had (Cardinal Rule 11). The tests boot the REAL gate and prove
// the three properties that matter:
//   1. Both routes sit behind the operator cookie wall (401 without it).
//   2. GET /qa/result before any run is a clean "none yet", not an error.
//   3. POST /qa/run when the shared agent lane is unavailable DECLINES with a
//      named 409 and spawns NOTHING -- a headless Chromium beside an engine OOMs
//      the box. The reachable, deterministic form of "lane unavailable" from a
//      black-box boot is the quarantine latch (AGENTHOST_AGENT_LANE_QUARANTINED);
//      acquireAgent() returns null identically for a busy lane and a quarantined
//      one, so this exercises the exact decline-before-spawn path either way.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { stopChild } from "./child-process-helper.js";
import { mintOperatorSession } from "./operator-session-helper.js";

const GATE = path.join(import.meta.dirname, "..", "container", "gate.js");
const KEY = "gate-qa-test-key";
const { qaRenderRouteAllowed } = createRequire(import.meta.url)(GATE);
const QA_HEADER = "x-agenthost-qa-render";

// Can bash run a trivial script here? The happy path spawns `bash <script>`; on a
// Windows-native runner with no bash that would fail for an environment reason,
// not a product one, so that ONE test self-skips. The required tests never spawn.
const BASH_OK = (() => {
  try { return spawnSync("bash", ["-c", "exit 0"], { timeout: 5000 }).status === 0; }
  catch { return false; }
})();

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

function qaResultFile(home) {
  return path.join(home, ".agenthost", "qa-state", "last-result.json");
}

test("the protected QA result is bounded on its already-open descriptor", () => {
  const source = fs.readFileSync(GATE, "utf8");
  const block = source.slice(source.indexOf("function readQaResult()"), source.indexOf("function handleQa("));
  assert.match(block, /openSync\(QA_RESULT_FILE,[\s\S]*O_NOFOLLOW/,
    "the result pathname is opened once without following a final symlink");
  assert.match(block, /Buffer\.alloc\(QA_RESULT_MAX_BYTES \+ 1\)/,
    "the reader reserves one byte beyond the limit so same-inode growth is observable");
  assert.match(block, /fs\.readSync\(fd, bytes, used, bytes\.length - used, null\)/,
    "the bounded loop reads the already-open descriptor, never the pathname again");
  assert.doesNotMatch(block, /readFileSync\(fd/,
    "an fstat followed by an unbounded descriptor read would preserve the growth race");
});

test("the gate sends the render token only over the explicitly marked stdin pipe", () => {
  const source = fs.readFileSync(GATE, "utf8");
  const start = source.indexOf('child = spawn("bash", [QA_RUN_SCRIPT');
  const end = source.indexOf("child.on(\"close\"", start);
  const launch = source.slice(start, end);
  assert.ok(start >= 0 && end > start, "the production QA child launch is present");
  assert.match(launch, /\[QA_RUN_SCRIPT, "--force", "--gate-authoritative", "--token-stdin"\]/);
  assert.match(launch, /stdio: \["pipe", "pipe", "pipe"\]/);
  assert.match(launch, /child\.stdin\.end\(renderToken \+ "\\n"\)/);
  assert.doesNotMatch(launch, /QA_RENDER_TOKEN\s*:/,
    "the render token must not enter the gate child environment or bwrap argv");
});

// A fake run-qa.sh so the happy path needs no chromium. Records its argv (so a
// test can prove the gate passes --force + --token-stdin -- without --force the real run-qa.sh would
// see the gate-held lane, self-decline with exit 0, and the gate would persist a
// FALSE "clean" pass). It also consumes stdin and records only the LENGTH: this
// proves the gate uses a pipe without writing the secret into a fixture file.
function writeFakeQaScript(home) {
  const p = path.join(home, "fake-run-qa.sh");
  const argvFile = path.join(home, "fake-argv");
  const tokenLengthFile = path.join(home, "fake-token-length");
  fs.writeFileSync(p, '#!/usr/bin/env bash\nprintf "%s" "$*" > "' + argvFile + '"\nIFS= read -r token\nprintf "%s" "${#token}" > "' + tokenLengthFile + '"\necho "3 unchanged"\necho "  unchanged  brand@phone"\nexit 0\n');
  return p;
}

const normal = {};
const busy = {};

before(async () => {
  // Box 1: a normal, healthy lane.
  normal.home = fs.mkdtempSync(path.join(os.tmpdir(), "gateqa-ok-"));
  fs.mkdirSync(path.join(normal.home, "work"), { recursive: true });
  normal.script = writeFakeQaScript(normal.home);
  {
    const { child, port } = bootGate(normal.home, { QA_RUN_SCRIPT: normal.script });
    normal.gate = child;
    normal.base = `http://127.0.0.1:${await port}`;
    normal.cookie = (await mintOperatorSession(normal.base, KEY)).cookie;
  }

  // Box 2: the shared agent lane is latched unavailable at boot. The QA script
  // here writes a MARKER; if the gate ever spawns it, the marker appears. The
  // decline path must never let that happen.
  busy.home = fs.mkdtempSync(path.join(os.tmpdir(), "gateqa-busy-"));
  fs.mkdirSync(path.join(busy.home, "work"), { recursive: true });
  busy.marker = path.join(busy.home, "SPAWNED");
  busy.script = path.join(busy.home, "marker-run-qa.sh");
  fs.writeFileSync(busy.script, '#!/usr/bin/env bash\ntouch "' + busy.marker + '"\nexit 0\n');
  {
    const { child, port } = bootGate(busy.home, {
      QA_RUN_SCRIPT: busy.script,
      AGENTHOST_AGENT_LANE_QUARANTINED: "1",
    });
    busy.gate = child;
    busy.base = `http://127.0.0.1:${await port}`;
    busy.cookie = (await mintOperatorSession(busy.base, KEY)).cookie;
  }
});

after(async () => {
  await stopChild(normal.gate);
  await stopChild(busy.gate);
  if (normal.home) fs.rmSync(normal.home, { recursive: true, force: true });
  if (busy.home) fs.rmSync(busy.home, { recursive: true, force: true });
});

// POST with the operator cookie AND the same-origin browser headers the central
// boundary requires for a state-changing request (mirrors mintOperatorSession).
function postRun(box) {
  return fetch(box.base + "/qa/run", {
    method: "POST",
    headers: { cookie: box.cookie, origin: box.base, "sec-fetch-site": "same-origin" },
    redirect: "manual",
  });
}
function getResult(box) {
  return fetch(box.base + "/qa/result", { headers: { cookie: box.cookie }, redirect: "manual" });
}

test("both routes require the operator cookie (401 without it)", async () => {
  const runNoAuth = await fetch(normal.base + "/qa/run", {
    method: "POST",
    headers: { origin: normal.base, "sec-fetch-site": "same-origin" },
    redirect: "manual",
  });
  assert.equal(runNoAuth.status, 401, "POST /qa/run without the cookie is 401");
  const resultNoAuth = await fetch(normal.base + "/qa/result", { redirect: "manual" });
  assert.equal(resultNoAuth.status, 401, "GET /qa/result without the cookie is 401");
});

test("GET /qa/result before any run returns a clean 'none yet', not an error", async () => {
  const r = await getResult(normal);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.status, "none");
  assert.match(body.message, /no qa pass has run yet/i);
  assert.match(body.message, /qa\/run/i, "the message names the trigger");
});

test("POST /qa/run declines (409) with a named cause when the lane is unavailable, and spawns nothing", async () => {
  const r = await postRun(busy);
  assert.equal(r.status, 409, "an unavailable lane is a 409, never a queued run");
  const body = await r.json();
  assert.equal(body.status, "declined");
  assert.ok(body.error && body.error.length > 0, "the refusal carries its cause (Rule 16)");
  assert.match(body.error, /lane/i, "the cause names the agent lane");
  // The decisive proof it never spawned a browser: the marker script never ran,
  // and the box still reports no pass has ever run.
  assert.equal(fs.existsSync(busy.marker), false, "no QA process was spawned");
  const after = await getResult(busy);
  const afterBody = await after.json();
  assert.equal(afterBody.status, "none", "a declined run leaves no result behind");
});

test("POST /qa/run reserves the lane, runs, persists a result, and releases the lane", { skip: BASH_OK ? false : "bash unavailable on this runner" }, async () => {
  const r = await postRun(normal);
  assert.equal(r.status, 200, "a healthy lane accepts the run");
  const body = await r.json();
  assert.equal(body.status, "clean", "the fake pass exits 0 -> clean");
  assert.equal(body.exitCode, 0);
  assert.match(body.summary, /unchanged/, "the runner's summary line is captured");

  // GET now returns the persisted result (was 'none' before).
  const got = await getResult(normal);
  const gotBody = await got.json();
  assert.equal(gotBody.status, "clean");
  assert.equal(gotBody.summary, body.summary, "GET /qa/result serves the persisted pass");

  // The lane was released on completion: a second run is accepted, not 409'd.
  const again = await postRun(normal);
  assert.equal(again.status, 200, "the lane was freed after the first pass");

  // The gate MUST pass --force. Without it the real run-qa.sh sees the gate-held
  // lane, self-declines with exit 0, and the gate persists a false "clean" pass.
  const argv = fs.readFileSync(path.join(normal.home, "fake-argv"), "utf8");
  assert.equal(argv.trim(), "--force --gate-authoritative --token-stdin",
    "the gate invokes the jailed runner with protected evidence and the explicit token-pipe marker");
  assert.ok(Number(fs.readFileSync(path.join(normal.home, "fake-token-length"), "utf8")) >= 32,
    "the short-lived render token crossed stdin without being persisted by this test");
  assert.equal(fs.readFileSync(normal.script, "utf8").includes("QA_RENDER_TOKEN"), false,
    "the fake runner does not rely on a token environment variable");

  const stored = qaResultFile(normal.home);
  assert.ok(fs.existsSync(stored), "the latest result is stored in the protected QA-state tree");
  assert.equal(stored.includes("qa-screenshots"), false, "result state is outside the agent-shared screenshot tree");
});

test("POST /qa/run keeps the lane held after timeout until delayed close proves the browser tree reaped", { skip: BASH_OK ? false : "bash unavailable on this runner" }, async () => {
  // A run-qa.sh that never exits would, without the kill-timer, hold the agent
  // lane (and its ~1GB Chromium) forever -- the same permanent-lane deadlock the
  // readiness work fixed. Boot a gate whose runner hangs and whose QA timeout is
  // tiny, then prove the run resolves to timed_out AND the lane is freed.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gateqa-hang-"));
  fs.mkdirSync(path.join(home, "work"), { recursive: true });
  const script = path.join(home, "hang-run-qa.sh");
  // Killing the shell leaves this short child holding stdout/stderr. Node emits
  // `close` only after those inherited descriptors close, reproducing bwrap's
  // asynchronous descendant teardown without launching Chromium in this test.
  fs.writeFileSync(script, '#!/usr/bin/env bash\n(sleep 2) &\nwait\n');
  const gate = bootGate(home, { QA_RUN_SCRIPT: script, QA_RUN_TIMEOUT_MS: "500", QA_REAP_TIMEOUT_MS: "5000" });
  const port = await gate.port;
  const { cookie } = await mintOperatorSession(`http://127.0.0.1:${port}`, KEY);
  const hdr = { cookie, "content-type": "application/json", origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin" };
  try {
    const running = fetch(`http://127.0.0.1:${port}/qa/run`, { method: "POST", headers: hdr, signal: AbortSignal.timeout(15_000) });
    await new Promise((resolve) => setTimeout(resolve, 900));
    const whileReaping = await fetch(`http://127.0.0.1:${port}/qa/run`, { method: "POST", headers: hdr });
    assert.equal(whileReaping.status, 409,
      "a replacement pass is declined after SIGKILL while close is still pending");
    const r = await running;
    const body = await r.json();
    assert.equal(body.status, "timed_out", "a hung pass resolves as timed_out, not a wedge");
    assert.match(String(body.error), /close confirmed.*reaped.*freed/i,
      "the response names the terminal proof that made release safe");
    // The decisive proof the lane was actually released: a NEW run is accepted.
    const again = await fetch(`http://127.0.0.1:${port}/qa/run`, { method: "POST", headers: hdr, signal: AbortSignal.timeout(15_000) });
    assert.notEqual(again.status, 409, "the lane was freed, so a new pass is not declined");
  } finally {
    await stopChild(gate.child);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a QA child closed by a signal is a named non-200 failure and releases only after close", {
  skip: BASH_OK && process.platform !== "win32" ? false : "requires POSIX bash signal semantics",
}, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gateqa-signal-"));
  fs.mkdirSync(path.join(home, "work"), { recursive: true });
  const script = path.join(home, "signal-run-qa.sh");
  // A separate delayed process kills the exact shell the gate spawned. That makes
  // ChildProcess.close carry a real signal instead of translating a self-kill into
  // an ordinary numeric exit, and avoids platform-specific parent-pid discovery.
  fs.writeFileSync(script, '#!/usr/bin/env bash\nIFS= read -r token\n(sleep 0.3; kill -KILL $$) &\nwait\n');
  const gate = bootGate(home, { QA_RUN_SCRIPT: script, QA_RUN_TIMEOUT_MS: "5000" });
  const port = await gate.port;
  const base = `http://127.0.0.1:${port}`;
  const { cookie } = await mintOperatorSession(base, KEY);
  try {
    const response = await postRun({ base, cookie });
    assert.equal(response.status, 500, "a signaled child is never reported as an HTTP 200 pass");
    const body = await response.json();
    assert.equal(body.status, "runner_signaled");
    assert.equal(body.signal, "SIGKILL");
    assert.equal(body.exitCode, null);
    assert.match(body.error, /terminated by signal SIGKILL/i, "the child close signal names its own cause");
    const again = await postRun({ base, cookie });
    assert.notEqual(again.status, 409, "the terminal close event reaped the child before the lane was released");
  } finally {
    await stopChild(gate.child);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a protected result write failure is visible and preserves the previous GET result", { skip: BASH_OK ? false : "bash unavailable on this runner" }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gateqa-persist-"));
  fs.mkdirSync(path.join(home, "work"), { recursive: true });
  const script = writeFakeQaScript(home);
  let first = bootGate(home, { QA_RUN_SCRIPT: script });
  try {
    const firstPort = await first.port;
    const firstBase = `http://127.0.0.1:${firstPort}`;
    const firstCookie = (await mintOperatorSession(firstBase, KEY)).cookie;
    const saved = await postRun({ base: firstBase, cookie: firstCookie });
    assert.equal(saved.status, 200);
    const prior = await (await getResult({ base: firstBase, cookie: firstCookie })).json();
    await stopChild(first.child);

    first = bootGate(home, {
      QA_RUN_SCRIPT: script,
      AGENTHOST_TEST_QA_RESULT_PERSIST_FAIL: "1",
    });
    const secondPort = await first.port;
    const secondBase = `http://127.0.0.1:${secondPort}`;
    const secondCookie = (await mintOperatorSession(secondBase, KEY)).cookie;
    const failed = await postRun({ base: secondBase, cookie: secondCookie });
    assert.equal(failed.status, 500);
    const failedBody = await failed.json();
    assert.equal(failedBody.status, "result_persist_failed");
    assert.match(failedBody.error, /protected result could not be saved.*injected/i);
    const after = await (await getResult({ base: secondBase, cookie: secondCookie })).json();
    assert.deepEqual(after, prior, "the failed atomic replacement leaves the previous durable result intact");
    const audit = fs.readFileSync(path.join(home, ".claude", "agenthost", "audit.log"), "utf8");
    assert.match(audit, /qa_run_persist_failed/,
      "the operator-visible persistence failure is also recorded in the audit trail");
  } finally {
    await stopChild(first.child);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---- The QA render token: a second, WEAKER auth path -----------------------
//
// Item 2 of the 2.0 release. QA could only ever photograph unauthenticated
// routes, so every surface an operator actually looks at was invisible to it.
// The naive fix -- hand the headless browser the operator cookie -- recreates
// the exact vulnerability PR #383 closed, because there is ONE box-wide cookie
// value and the less-trusted `agent` user shares this box.
//
// These tests prove the properties that make the shipped credential a different
// object from the operator's, against the REAL gate over HTTP:
//
//   1. it authenticates only the exact GET routes the capture pages load
//   2. it is REFUSED for every other method and route -- /chat/stream is a
//      legacy consequence-bearing GET, so method alone is not a boundary
//   3. it cannot mint an operator session (it is not a login)
//   4. it dies with the pass that minted it
//
// The fake runner parks for a few seconds so the token can be exercised WHILE
// it is live; POST /qa/run does not answer until the child closes.
function writeTokenCapturingQaScript(home) {
  const script = path.join(home, "token-run-qa.sh");
  const tokenFile = path.join(home, "render-token");
  fs.writeFileSync(script,
    '#!/usr/bin/env bash\n' +
    'IFS= read -r token\n' +
    'printf "%s" "$token" > "' + tokenFile + '"\n' +
    'sleep 4\n' +
    'echo "0 unchanged"\n' +
    'exit 0\n');
  return { script, tokenFile };
}

test("the QA render allowlist contains only the two shells and immutable static assets", () => {
  const required = ["/", "/audit", "/_next/static/chunks/app/page-a1b2c3.js", "/_next/static/media/font-a1.woff2"];
  for (const pathname of required) {
    assert.equal(qaRenderRouteAllowed("GET", pathname), true, `GET ${pathname} stays renderable`);
  }
  for (const method of ["HEAD", "POST", "PUT", "DELETE"]) {
    assert.equal(qaRenderRouteAllowed(method, "/"), false, `${method} is never a QA-render authority`);
  }
  assert.equal(qaRenderRouteAllowed("GET", "/", "?private=1"), false,
    "even a shell URL must be exact and query-free");
  assert.equal(qaRenderRouteAllowed("GET", "/_next/static/chunks/app.js", "?v=1"), false,
    "an immutable asset URL cannot carry query data");
  for (const pathname of [
    "/chat/thread", "/chat/runs", "/board", "/cc/state", "/cc/inventory",
    "/cron/jobs", "/cron/runs", "/cron/multi/jobs", "/cron/multi/runs",
    "/api/mode", "/cc/mesh", "/api/settings", "/profiles/data", "/audit/data",
    "/chat/stream", "/runs", "/qa/result", "/commands", "/push/status", "/activity/stream",
    "/api/capabilities", "/files", "/artifacts", "/secret/status", "/growth/accounts",
    "/measurement/status", "/measurement/connections", "/measurement/available-connections",
    "/brain/api/memories", "/terminal/token", "/_next/data/private.json", "/_next/static/",
    "/_next/static/../gate.js", "/_next/static/%2e%2e/gate.js", "/_next/static/chunks/app?.js",
  ]) {
    assert.equal(qaRenderRouteAllowed("GET", pathname), false, `GET ${pathname} fails closed`);
  }
});

async function readWhenNonEmpty(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const text = fs.readFileSync(file, "utf8").trim();
      if (text) return text;
    } catch { /* not written yet */ }
    if (Date.now() > deadline) throw new Error("the runner never received a QA render token: " + file);
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("the header-only QA token renders shells/assets, sees no gate data, and dies with the pass", { skip: BASH_OK ? false : "bash unavailable on this runner" }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gateqa-token-"));
  fs.mkdirSync(path.join(home, "work"), { recursive: true });
  const { script, tokenFile } = writeTokenCapturingQaScript(home);
  const gate = bootGate(home, { QA_RUN_SCRIPT: script });
  const port = await gate.port;
  const base = `http://127.0.0.1:${port}`;
  const { cookie } = await mintOperatorSession(base, KEY);
  try {
    // Fire the pass but do NOT await it: the token is only alive while it runs.
    const running = fetch(base + "/qa/run", {
      method: "POST",
      headers: { cookie, origin: base, "sec-fetch-site": "same-origin" },
      signal: AbortSignal.timeout(30_000),
    });

    const token = await readWhenNonEmpty(tokenFile, 10_000);
    assert.ok(token.length >= 32, "the gate hands the runner a real token through the stdin pipe");
    assert.ok(!cookie.includes(token), "the QA token is NOT the operator cookie value");

    // 1. It authenticates a GET. Without the token the same request is the login wall.
    const anon = await fetch(base + "/", { redirect: "manual" });
    assert.equal(anon.status, 401, "control: no credential means the login wall");
    const rendered = await fetch(base + "/", { headers: { [QA_HEADER]: token }, redirect: "manual" });
    assert.equal(rendered.status, 200, "the render token opens the authenticated workspace");
    assert.equal(rendered.headers.get("set-cookie"), null, "the render token is never copied into a cookie");

    const viaQuery = await fetch(base + "/?__qa=" + encodeURIComponent(token), { redirect: "manual" });
    assert.equal(viaQuery.status, 401, "the same live token in a URL authenticates nothing");
    const viaCookie = await fetch(base + "/", { headers: { cookie: "ah_qa=" + token }, redirect: "manual" });
    assert.equal(viaCookie.status, 401, "the same live token in the retired cookie shape authenticates nothing");

    // A SECOND navigation, so the audit assertion below is proving quietness
    // rather than describing a single-request run.
    const rendered2 = await fetch(base + "/audit", { headers: { [QA_HEADER]: token }, redirect: "manual" });
    assert.equal(rendered2.status, 200, "a second authenticated route also renders");
    const queriedShell = await fetch(base + "/?view=room%2Fchat", {
      headers: { [QA_HEADER]: token }, redirect: "manual",
    });
    assert.equal(queriedShell.status, 403,
      "the render token cannot authorize query-bearing shell URLs outside its exact route list");

    const staticRoot = path.join(import.meta.dirname, "..", "container", "dashboard-ui", "_next", "static");
    const staticFile = (() => {
      const pending = [staticRoot];
      while (pending.length) {
        const dir = pending.pop();
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const candidate = path.join(dir, entry.name);
          if (entry.isDirectory()) pending.push(candidate);
          else return candidate;
        }
      }
      throw new Error("the dashboard export contains no immutable static asset");
    })();
    const staticPath = "/_next/static/" + path.relative(staticRoot, staticFile).split(path.sep).join("/");
    const asset = await fetch(base + staticPath, { headers: { [QA_HEADER]: token }, redirect: "manual" });
    assert.equal(asset.status, 200, "the private extension can load an exact exported immutable asset");
    const queriedAsset = await fetch(base + staticPath + "?private=1", {
      headers: { [QA_HEADER]: token }, redirect: "manual",
    });
    assert.equal(queriedAsset.status, 403,
      "the render token cannot authorize a static path carrying query data");

    // Every dashboard data route is intentionally OUTSIDE the token's authority.
    // The browser extension answers these from sanitized in-page fixtures.
    for (const pathname of [
      "/chat/thread", "/chat/runs", "/board", "/cc/state", "/cc/inventory", "/cron/jobs",
      "/cron/runs", "/cron/multi/jobs", "/cron/multi/runs", "/api/mode", "/cc/mesh",
      "/api/settings", "/profiles/data", "/audit/data", "/brain/api/memories?scope=private&limit=500",
      "/growth/accounts", "/measurement/status", "/measurement/connections",
    ]) {
      const privateRead = await fetch(base + pathname, {
        headers: { [QA_HEADER]: token },
        redirect: "manual",
      });
      assert.equal(privateRead.status, 403, `QA cannot read gate-backed data from ${pathname}`);
      assert.match(await privateRead.text(), /outside the read-only render allowlist/i);
    }

    // 2. THE PROPERTY THAT MATTERS: neither a POST nor a consequence-bearing
    //    legacy GET can use the screenshot credential. /chat/stream?msg starts
    //    durable agent work for an operator, so both GET and HEAD fail at the
    //    auth wall before handleChat can create a run.
    const forbiddenRunIds = ["qarenderget", "qarenderhead"];
    const forbiddenGet = await fetch(base + "/chat/stream?run=" + forbiddenRunIds[0] + "&engine=claude&msg=QA_RENDER_MUST_NOT_START", {
      headers: { [QA_HEADER]: token },
      redirect: "manual",
    });
    assert.equal(forbiddenGet.status, 403, "a consequence-bearing GET is refused");
    assert.match(await forbiddenGet.text(), /outside the read-only render allowlist/i,
      "the GET refusal names the exact boundary");
    const forbiddenHead = await fetch(base + "/chat/stream?run=" + forbiddenRunIds[1] + "&engine=claude&msg=QA_RENDER_MUST_NOT_START", {
      method: "HEAD",
      headers: { [QA_HEADER]: token },
      redirect: "manual",
    });
    assert.equal(forbiddenHead.status, 403, "HEAD cannot smuggle the same consequence through");
    const runsAfterRefusal = await fetch(base + "/chat/runs", {
      headers: { cookie },
      redirect: "manual",
    });
    assert.equal(runsAfterRefusal.status, 200);
    const refusedRuns = (await runsAfterRefusal.json()).runs ?? [];
    assert.equal(refusedRuns.some((run) => forbiddenRunIds.includes(run.id)), false,
      "refused QA requests create no durable chat run or engine work");

    // /secret is a real mutating POST; with the operator cookie it would be reachable.
    const write = await fetch(base + "/secret", {
      method: "POST",
      headers: { [QA_HEADER]: token, "content-type": "application/json", origin: base, "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ name: "QA_SHOULD_NEVER_LAND", value: "x" }),
      redirect: "manual",
    });
    assert.equal(write.status, 403, "a write with the render token is refused");
    assert.match(await write.text(), /renders pages and nothing else/i, "and the refusal names its cause (Rule 16)");

    // 3. It is not a login: it cannot be traded for an operator session.
    const mint = await fetch(base + "/session", {
      method: "POST",
      headers: { [QA_HEADER]: token, "content-type": "application/json", origin: base, "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ key: "wrong-key" }),
      redirect: "manual",
    });
    assert.notEqual(mint.status, 200, "the render token cannot mint an operator session");
    assert.equal(String(mint.headers.get("set-cookie") || "").includes("agenthost_auth="), false,
      "and no operator cookie is ever issued to it");

    // 4. It dies with the pass.
    const done = await running;
    assert.equal(done.status, 200, "the pass itself completed");
    const afterPass = await fetch(base + "/", { headers: { [QA_HEADER]: token }, redirect: "manual" });
    assert.equal(afterPass.status, 401, "the token is revoked the moment the pass finishes");

    // 5. IT DOES NOT DROWN THE AUDIT TAIL. A real pass navigates once per route x
    //    viewport, so a line per navigation wrote 12 lines for one QA run and
    //    buried the last 60 events that the watch pass and every agent read. An
    //    audit surface that drowns its own signal fails a reader the same way a
    //    silent one does. First use is named, the rest are counted.
    const auditLines = fs.readFileSync(path.join(home, ".claude", "agenthost", "audit.log"), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const spent = auditLines.filter((l) => l.event === "qa_render_spent");
    assert.equal(spent.length, 1, "two navigations, ONE spend line -- got " + spent.length);
    assert.match(spent[0].detail, /first use ->/, "and it says it is the first use");
    const revoked = auditLines.filter((l) => l.event === "qa_render_revoked");
    assert.equal(revoked.length, 1, "revocation is audited exactly once");
    assert.match(revoked[0].detail, /^3 spend\(s\)/, "and it carries the TOTAL, so nothing is lost by not logging each asset");
    assert.equal(auditLines.filter((l) => l.event === "qa_render_minted").length, 1, "minting is audited once");
  } finally {
    await stopChild(gate.child);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a forged or stale render token is just the login wall", async () => {
  const forged = "A".repeat(43);
  const r = await fetch(normal.base + "/", { headers: { [QA_HEADER]: forged }, redirect: "manual" });
  assert.equal(r.status, 401, "a made-up token authenticates nothing");
  const viaQuery = await fetch(normal.base + "/?__qa=" + forged, { redirect: "manual" });
  assert.equal(viaQuery.status, 401, "and neither does the retired query transport");
});
