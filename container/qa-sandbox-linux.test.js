"use strict";

// Exact-image behavioral proof for the Visual QA jail. The release-image
// verifier invokes this file through:
//
//   setpriv --reuid=gate --regid=gate --init-groups --no-new-privs -- node ...
//
// It uses the production buildBwrapReadJail implementation and runs a synthetic
// "browser" payload inside that exact filesystem/PID boundary. The payload
// proves the capabilities QA needs (profile, mask input, screenshot output) and
// the host visibility it must never have (gate-only stores and the parent gate
// process/environment). No network namespace is requested, so loopback remains
// available to the real Chromium pass.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const chains = require("./chains-lib.js");
const qaSandbox = require("./qa-sandbox.js");

const MINIMAL_CHILD_ENV = Object.freeze({
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: "/tmp",
  TMPDIR: "/tmp",
  USER: "gate",
  LOGNAME: "gate",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
});

function exactGateJailAvailable() {
  if (process.platform !== "linux" || typeof process.getuid !== "function") return false;
  let status = "";
  try { status = fs.readFileSync("/proc/self/status", "utf8"); } catch { return false; }
  const gateUid = Number(spawnSync("/usr/bin/id", ["-u", "gate"], { encoding: "utf8" }).stdout);
  const gateGid = Number(spawnSync("/usr/bin/id", ["-g", "gate"], { encoding: "utf8" }).stdout);
  return Number.isInteger(gateUid) && Number.isInteger(gateGid)
    && process.getuid() === gateUid && process.getgid() === gateGid
    && process.env.USER === "gate" && process.env.LOGNAME === "gate"
    && /^NoNewPrivs:\s+1$/m.test(status)
    && fs.existsSync("/usr/bin/bwrap")
    && fs.existsSync("/usr/bin/chromium")
    && process.env.AGENTHOST_QA_CANARY_PATH === "/data/agenthost-gate-state/qa-sandbox-canary"
    && fs.existsSync(process.env.AGENTHOST_QA_CANARY_PATH)
    && process.env.AGENTHOST_QA_EVIDENCE_ROOT === "/data/agenthost-gate-state/qa/evidence"
    && process.env.QA_HOST_SENTINEL === "synthetic-host-only-value"
    && process.env.GIT_PUSH_TOKEN === "synthetic-push-token";
}

function startFixtureServer() {
  const html = "<!doctype html><style>html,body{margin:0;background:#fff}</style>"
    + "<div data-qa-dynamic=clock style='width:390px;height:844px;background:#f00'></div>";
  const script = "const http=require('http');const body=" + JSON.stringify(html) + ";"
    + "const s=http.createServer((q,r)=>{r.writeHead(200,{'content-type':'text/html'});r.end(body)});"
    + "s.listen(0,'127.0.0.1',()=>console.log(s.address().port));";
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  const ready = new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => reject(new Error("QA fixture server did not bind: " + stderr)), 5000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const port = Number(stdout.trim());
      if (Number.isInteger(port) && port > 0) {
        clearTimeout(timer);
        resolve({ child, url: "http://127.0.0.1:" + port + "/" });
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error("QA fixture server exited " + code + ": " + stderr)); });
  });
  return ready;
}

// Serves the release image's real static dashboard while recording exactly what
// escaped the document-start fixture. The render token arrives only as a request
// header; the server never receives it in argv or env. While curl/Chromium wait
// for each response, the server scans their live /proc argv+environ as the
// behavioral proof that the credential stayed in private config files.
function startBundledDashboardServer(logFile) {
  const observer = "<script>(()=>{" +
    "const route=location.pathname==='\/audit'?'audit':'workspace';" +
    "const expected=route==='audit'?'Sanitized visual fixture loaded':'QA fixture: release evidence is ready for review.';" +
    "const deadline=Date.now()+12000;" +
    "const check=()=>{" +
      "const ready=document.documentElement.getAttribute('data-agenthost-qa-fixture')==='ready'" +
        "&&String(document.body&&document.body.textContent||'').includes(expected);" +
      "if(ready){const image=new Image();image.src='/qa-proof/'+route+'?state=ready';return;}" +
      "if(Date.now()>=deadline){const image=new Image();image.src='/qa-proof/'+route+'?state=failed';return;}" +
      "setTimeout(check,50);" +
    "};" +
    "addEventListener('DOMContentLoaded',check,{once:true});" +
  "})();<\/script>";
  const script = String.raw`
    "use strict";
    const http = require("http");
    const fs = require("fs");
    const path = require("path");
    const root = process.argv[process.argv.length - 2];
    const logFile = process.argv[process.argv.length - 1];
    const headerName = "x-agenthost-qa-render";
    const publicFiles = new Set([
      "/manifest.webmanifest", "/sw.js", "/favicon.ico", "/icon.svg",
      "/icon-dark-32x32.png", "/icon-light-32x32.png", "/apple-icon.png",
    ]);
    let renderToken = "";
    const append = (entry) => fs.appendFileSync(logFile, JSON.stringify(entry) + "\n");
    const scanProcesses = (needle) => {
      const result = { leaks: [], sawCurl: false, sawChromium: false };
      if (!needle) return result;
      const bytes = Buffer.from(needle);
      for (const pid of fs.readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
        for (const area of ["cmdline", "environ"]) {
          let value;
          try { value = fs.readFileSync("/proc/" + pid + "/" + area); } catch { continue; }
          const printable = area === "cmdline" ? value.toString("utf8") : "";
          if (printable.includes("curl")) result.sawCurl = true;
          if (printable.includes("chromium")) result.sawChromium = true;
          if (value.includes(bytes)) result.leaks.push({ pid: Number(pid), area });
        }
      }
      return result;
    };
    const mime = (file) => file.endsWith(".js") ? "text/javascript"
      : file.endsWith(".css") ? "text/css"
        : file.endsWith(".woff2") ? "font/woff2"
          : file.endsWith(".svg") ? "image/svg+xml"
            : file.endsWith(".png") ? "image/png"
              : file.endsWith(".webmanifest") ? "application/manifest+json"
                : "application/octet-stream";
    const sendFile = (res, file, type) => {
      try {
        const bytes = fs.readFileSync(file);
        res.writeHead(200, { "content-type": type || mime(file), "cache-control": "no-store" });
        res.end(bytes);
      } catch {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
      }
    };
    const observer = ${JSON.stringify(observer)};
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      const pathname = url.pathname;
      const header = String(req.headers[headerName] || "");
      if (header && !renderToken) renderToken = header;
      const shell = url.search === "" && (pathname === "/" || pathname === "/audit");
      const immutable = url.search === ""
        && /^\/_next\/static\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(pathname);
      const scan = scanProcesses(header);
      append({
        path: pathname + url.search,
        header: Boolean(header),
        headerOnAllowedPath: !header || shell || immutable,
        headerMatchesPass: !header || header === renderToken,
        urlContainsToken: Boolean(renderToken && req.url.includes(renderToken)),
        processLeaks: scan.leaks,
        sawCurl: scan.sawCurl,
        sawChromium: scan.sawChromium,
      });
      if (shell) {
        if (!header) { res.writeHead(401); res.end("missing QA header"); return; }
        let html = fs.readFileSync(path.join(root, "index.html"), "utf8");
        html = html.includes("</body>") ? html.replace("</body>", observer + "</body>") : html + observer;
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(html);
        return;
      }
      if (immutable) {
        if (!header) { res.writeHead(401); res.end("missing QA header"); return; }
        const file = path.resolve(root, "." + pathname);
        if (!file.startsWith(path.resolve(root) + path.sep)) { res.writeHead(403); res.end(); return; }
        sendFile(res, file);
        return;
      }
      if (pathname.startsWith("/qa-proof/")) { res.writeHead(204); res.end(); return; }
      if (publicFiles.has(pathname)) {
        if (pathname === "/sw.js") {
          res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
          res.end("");
          return;
        }
        sendFile(res, path.join(root, pathname.slice(1)));
        return;
      }
      res.writeHead(418, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "a dashboard request escaped the QA fixture", path: pathname }));
    });
    server.listen(0, "127.0.0.1", () => console.log(server.address().port));
  `;
  const child = spawn(process.execPath, ["-e", script, "/opt/agenthost/dashboard-ui", logFile], {
    env: { ...MINIMAL_CHILD_ENV },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => reject(new Error("bundled dashboard server did not bind: " + stderr)), 5000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const port = Number(stdout.trim());
      if (Number.isInteger(port) && port > 0) {
        clearTimeout(timer);
        resolve({ child, origin: "http://127.0.0.1:" + port });
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error("bundled dashboard server exited " + code + ": " + stderr));
    });
  });
}

test("REAL QA JAIL: exact gate+NNP pass writes profile/mask/output but sees no gate state or host proc", {
  skip: exactGateJailAvailable() ? false : "requires release image gate uid under setpriv --no-new-privs",
  timeout: 30000,
}, async (t) => {
  assert.equal(fs.readFileSync(process.env.AGENTHOST_QA_CANARY_PATH, "utf8"), "gate-only-canary\n",
    "control: the exact gate identity can read the gate-only canary before entering Bubblewrap");
  for (const releasePath of [
    "/opt/agenthost/chains-lib.js",
    "/opt/agenthost/qa-sandbox.js",
    "/opt/agenthost/qa-runner.sh",
    "/opt/agenthost/qa-agent.js",
    "/opt/agenthost/qa-routes.json",
  ]) {
    const stat = fs.lstatSync(releasePath);
    assert.equal(stat.isFile() && stat.uid === 0 && (stat.mode & 0o022) === 0, true,
      releasePath + " must be the root-owned release-image input the gate stages");
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-qa-jail-"));
  const output = process.env.AGENTHOST_QA_EVIDENCE_ROOT;
  const inputs = path.join(scratch, "inputs");
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  fs.chmodSync(output, 0o700);
  const extension = path.join(inputs, "extension");
  fs.mkdirSync(extension, { recursive: true });
  fs.writeFileSync(path.join(extension, "manifest.json"), JSON.stringify({
    manifest_version: 3,
    name: "AgentHost QA jail proof mask",
    version: "1.0.0",
    content_scripts: [{ matches: ["http://127.0.0.1/*"], css: ["mask.css"], run_at: "document_start" }],
  }));
  fs.writeFileSync(path.join(extension, "mask.css"), "[data-qa-dynamic=clock]{visibility:hidden !important}\n");
  const fixture = await startFixtureServer();
  t.after(() => { try { fixture.child.kill("SIGKILL"); } catch {} });
  let outputFd = null;
  try {
    outputFd = fs.openSync(output, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    const hostPid = process.pid;
    const payload = [
      "set -eu",
      "grep -q '^NoNewPrivs:[[:space:]]*1$' /proc/self/status",
      "grep -q '^CapEff:[[:space:]]*0000000000000000$' /proc/self/status",
      "grep -q '^CapBnd:[[:space:]]*0000000000000000$' /proc/self/status",
      "test \"$(id -u)\" -eq " + process.getuid(),
      "test -r /opt/qa/extension/manifest.json",
      "grep -q visibility:hidden /opt/qa/extension/mask.css",
      "mkdir -p /tmp/profile-proof",
      "printf profile-ok > /tmp/profile-proof/marker",
      "test \"$(cat /tmp/profile-proof/marker)\" = profile-ok",
      "printf output-ok > /qa-output/output-marker",
      "test ! -e /data/agenthost-secrets",
      "test ! -e /data/agenthost-gate-state",
      "test ! -e /data/home/agent",
      "test ! -e /home",
      "test ! -e /run",
      "test ! -e /proc/" + hostPid + "/environ",
      "test \"${GIT_PUSH_TOKEN+x}\" != x",
      "test \"${QA_HOST_SENTINEL+x}\" != x",
      "test \"${AGENTHOST_QA_EVIDENCE_ROOT+x}\" != x",
      "test ! -e /proc/self/fd/3",
      "test \"$(stat -c %d:%i /qa-output)\" = \"" + fs.fstatSync(outputFd).dev + ":" + fs.fstatSync(outputFd).ino + "\"",
      "/usr/bin/chromium --headless --no-sandbox --disable-gpu --disable-dev-shm-usage"
        + " --user-data-dir=/tmp/profile-unmasked --virtual-time-budget=1000"
        + " --window-size=390,844 --screenshot=/qa-output/unmasked.png " + fixture.url,
      "/usr/bin/chromium --headless --no-sandbox --disable-gpu --disable-dev-shm-usage"
        + " --user-data-dir=/tmp/profile-masked --disable-extensions-except=/opt/qa/extension"
        + " --load-extension=/opt/qa/extension --virtual-time-budget=1000"
        + " --window-size=390,844 --screenshot=/qa-output/masked.png " + fixture.url,
    ].join(" && ");
    const jail = chains.buildBwrapReadJail("/bin/sh", ["-c", payload], {
      env: {
        PATH: "/usr/bin:/bin", HOME: "/hm", TMPDIR: "/tmp",
        USER: "gate", LOGNAME: "gate", LANG: "C.UTF-8", LC_ALL: "C.UTF-8",
      },
      roBindsAt: [
        { src: inputs, dest: "/opt/qa" },
        { src: "/etc/fonts", dest: "/etc/fonts" },
        { src: "/etc/chromium.d", dest: "/etc/chromium.d" },
      ],
      requiredRwBindAt: [{ src: "/proc/self/fd/3", dest: "/qa-output" }],
      closeFds: [3],
    });
    assert.equal(jail.bin, "/usr/bin/bwrap");
    assert.equal(jail.args.includes("--unshare-net"), false,
      "QA keeps network so Chromium can reach the loopback gate");
    const run = spawnSync(jail.bin, jail.args, {
      encoding: "utf8",
      env: { QA_HOST_SENTINEL: "must-not-cross", GIT_PUSH_TOKEN: "must-not-cross" },
      stdio: ["ignore", "pipe", "pipe", outputFd],
    });
    assert.equal(run.status, 0, run.stderr);
    const unmasked = fs.readFileSync(path.join(output, "unmasked.png"));
    const masked = fs.readFileSync(path.join(output, "masked.png"));
    assert.equal(fs.readFileSync(path.join(output, "output-marker"), "utf8"), "output-ok",
      "the jailed child can write only through the pinned output grant");
    assert.deepEqual([...unmasked.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10],
      "Chromium wrote a real PNG through the descriptor-pinned output mount");
    assert.notEqual(crypto.createHash("sha256").update(masked).digest("hex"),
      crypto.createHash("sha256").update(unmasked).digest("hex"),
      "the route mask extension changed the rendered pixels without removing layout");
    fs.copyFileSync(path.join(output, "masked.png"), path.join(output, "baseline-proof.png"));
    fs.copyFileSync(path.join(output, "unmasked.png"), path.join(output, "current-proof.png"));
  } finally {
    if (outputFd !== null) fs.closeSync(outputFd);
    fs.rmSync(scratch, { recursive: true, force: true });
    if (process.env.QA_KEEP_EVIDENCE !== "1") fs.rmSync(output, { recursive: true, force: true });
  }
});

test("REAL QA AUTH: the bundled workspace and audit hydrate from fixtures without private gate reads or token leakage", {
  skip: exactGateJailAvailable() ? false : "requires release image gate uid under setpriv --no-new-privs",
  timeout: 120000,
}, async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-qa-auth-"));
  const logFile = path.join(scratch, "requests.jsonl");
  const configFile = path.join(scratch, "qa-routes.json");
  const output = process.env.AGENTHOST_QA_EVIDENCE_ROOT;
  const renderToken = crypto.randomBytes(32).toString("hex");
  const server = await startBundledDashboardServer(logFile);
  let outputFd = null;
  let stage = null;
  t.after(() => { try { server.child.kill("SIGKILL"); } catch {} });
  try {
    fs.writeFileSync(configFile, JSON.stringify({
      baseUrl: server.origin,
      viewports: [{ name: "desktop", width: 1280, height: 900 }],
      routes: [
        {
          path: "/", name: "fixture-workspace", auth: true,
          mask: [
            "[data-qa-dynamic=workspace-observed]",
            "[data-qa-dynamic=workspace-transcript-observed]",
          ],
        },
        { path: "/audit", name: "fixture-audit", auth: true },
      ],
    }), { mode: 0o600 });
    stage = qaSandbox.stageInputs([
      { source: "/opt/agenthost/qa-agent.js", name: "qa-agent.js", maxBytes: 1024 * 1024 },
      { source: configFile, name: "qa-routes.json", maxBytes: 128 * 1024 },
      { source: "/opt/agenthost/qa-runner.sh", name: "qa-runner.sh", maxBytes: 128 * 1024, mode: 0o500 },
    ], { tmpDir: scratch, requireRootOwner: false });
    outputFd = fs.openSync(output, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    const jail = qaSandbox.buildQaSandboxCommand(stage,
      ["--force", "--gate-authoritative", "--token-stdin"],
      { env: { ...process.env, QA_SETTLE_MS: "8000" } });
    assert.equal(jail.bin, "/usr/bin/bwrap");
    assert.equal(jail.args.join("\0").includes(renderToken), false,
      "the render token is absent from Bubblewrap and runner argv");
    assert.equal(JSON.stringify(qaSandbox.qaSandboxEnv(process.env)).includes(renderToken), false,
      "the render token is absent from the jailed runner environment");
    const run = spawnSync(jail.bin, jail.args, {
      encoding: "utf8",
      input: renderToken + "\n",
      env: {},
      stdio: ["pipe", "pipe", "pipe", outputFd],
      timeout: 100000,
      maxBuffer: 8 * 1024 * 1024,
    });
    assert.equal(run.status, 0, String(run.stderr || ""));
    assert.equal(String(run.stdout || "").includes(renderToken), false,
      "the pass never echoes its credential to stdout");
    assert.equal(String(run.stderr || "").includes(renderToken), false,
      "the pass never echoes its credential to stderr");

    for (const target of ["fixture-workspace", "fixture-audit"]) {
      const png = fs.readFileSync(path.join(output, target, "desktop", "baseline.png"));
      assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10],
        target + " produced a real Chromium screenshot from the bundled dashboard");
    }

    const requests = fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    assert.ok(requests.some((entry) => entry.path === "/" && entry.header),
      "the real workspace document received the private extension header");
    assert.ok(requests.some((entry) => entry.path === "/audit" && entry.header),
      "the real audit document received the private extension header");
    assert.ok(requests.some((entry) => entry.path.startsWith("/_next/static/") && entry.header),
      "the bundled immutable assets received the same pass-scoped header");
    assert.ok(requests.some((entry) => entry.path === "/qa-proof/workspace?state=ready"),
      "the hydrated workspace rendered its sanitized transcript fixture");
    assert.ok(requests.some((entry) => entry.path === "/qa-proof/audit?state=ready"),
      "the hydrated audit rendered its sanitized event fixture");
    assert.equal(requests.some((entry) => entry.path.includes("state=failed")), false,
      "neither route remained in a loading/degraded pre-fixture state");
    assert.equal(requests.every((entry) => entry.headerOnAllowedPath && entry.headerMatchesPass), true,
      "the private header appeared only on exact shell and immutable-static requests");
    assert.equal(requests.some((entry) => entry.urlContainsToken), false,
      "no browser or curl URL carried the render token");
    assert.equal(requests.some((entry) => entry.processLeaks.length > 0), false,
      "live /proc scans found the render token in no curl/Chromium argv or environment");
    assert.equal(requests.some((entry) => entry.sawCurl), true,
      "the negative process scan observed curl while its authenticated probe was live");
    assert.equal(requests.some((entry) => entry.sawChromium), true,
      "the negative process scan observed Chromium while its authenticated request was live");

    const privatePaths = new Set([
      "/chat/thread", "/chat/runs", "/board", "/cc/state", "/cc/inventory",
      "/cron/jobs", "/cron/runs", "/cron/multi/jobs", "/cron/multi/runs",
      "/api/mode", "/cc/mesh", "/api/settings", "/profiles/data", "/audit/data",
      "/growth/accounts", "/measurement/status", "/measurement/connections",
      "/brain/api/memories", "/chat/stream", "/activity/stream",
    ]);
    const escapedPrivateReads = requests.filter((entry) => {
      const pathname = new URL(entry.path, server.origin).pathname;
      return privatePaths.has(pathname);
    });
    assert.deepEqual(escapedPrivateReads, [],
      "all dashboard state reads and consequence routes were answered or blocked inside the page fixture");
  } finally {
    try { server.child.kill("SIGKILL"); } catch {}
    if (outputFd !== null) fs.closeSync(outputFd);
    if (stage) fs.rmSync(stage, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("REAL QA JAIL: missing or non-directory output grants fail before the payload starts", {
  skip: exactGateJailAvailable() ? false : "requires release image gate uid under setpriv --no-new-privs",
  timeout: 10000,
}, () => {
  const markerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qa-jail-marker-"));
  const marker = path.join(markerRoot, "started");
  const missingOutput = path.join(os.tmpdir(), "qa-jail-missing-output-" + process.pid);
  const regular = path.join(os.tmpdir(), "qa-jail-regular-fd3-" + process.pid);
  fs.rmSync(marker, { force: true });
  fs.accessSync(markerRoot, fs.constants.W_OK);
  fs.rmSync(missingOutput, { recursive: true, force: true });
  fs.writeFileSync(regular, "not a directory");
  let regularFd = null;
  try {
    let spawned = 0;
    assert.throws(() => qaSandbox.runQaSandbox({ outputRoot: missingOutput }, {
      spawnSync: () => { spawned += 1; return { status: 0 }; },
    }), /no such file|ENOENT/i,
    "the production launcher refuses a missing output root before Bubblewrap");
    assert.equal(spawned, 0, "a missing required output root starts no jailed or unjailed payload");

    regularFd = fs.openSync(regular, fs.constants.O_RDONLY);
    const jail = chains.buildBwrapReadJail("/bin/sh", ["-c", "touch /marker/started; exit 23"], {
      env: { PATH: "/usr/bin:/bin", HOME: "/hm", TMPDIR: "/tmp", USER: "gate", LOGNAME: "gate" },
      requiredRwBindAt: [
        { src: "/proc/self/fd/3", dest: "/qa-output" },
        { src: markerRoot, dest: "/marker" },
      ],
      closeFds: [3],
    });
    const run = spawnSync(jail.bin, jail.args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe", regularFd],
    });
    assert.notEqual(run.status, 0, "Bubblewrap must refuse a required output bind that is not a directory");
    assert.notEqual(run.status, 23, "the observed failure came from Bubblewrap setup, not the payload");
    assert.match(String(run.stderr || ""), /^bwrap:.*(?:bind|mount|directory|create file)/im,
      "the negative result is Bubblewrap's bind/setup refusal, not a payload exit");
    assert.equal(fs.existsSync(marker), false, "the payload did not start outside the jail as a fallback");
  } finally {
    if (regularFd !== null) fs.closeSync(regularFd);
    fs.rmSync(markerRoot, { recursive: true, force: true });
    fs.rmSync(regular, { force: true });
  }
});
