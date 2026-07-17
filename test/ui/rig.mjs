// UI rig: serves the REAL container HTML (gate-injected terminal page + chat.html
// + appshell.js) backed by a fake ttyd (real xterm.js 5 from CDN-pinned local
// copy is loaded by ttyd's own bundle -- here we stand up a minimal xterm page
// that matches ttyd's DOM: #terminal, .xterm-helper-textarea, window.term) and a
// fake claude for /chat/stream. Drives it with Playwright at phone viewports.
//
// Not a unit test (no assertions here) -- returns a running server + helpers the
// appshell.test.mjs harness drives. Zero network: xterm is vendored inline.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTAINER = path.join(__dirname, "..", "..", "container");

const appshell = fs.readFileSync(path.join(CONTAINER, "appshell.js"), "utf8");
const chatHtml = fs.readFileSync(path.join(CONTAINER, "chat.html"), "utf8");
const cronHtml = fs.readFileSync(path.join(CONTAINER, "cron.html"), "utf8");
const ccHtml = fs.readFileSync(path.join(CONTAINER, "cc.html"), "utf8");
// The gate's REAL nav renderer + app list, via gate.js's lib mode (require()ing
// it skips the server boot). Serving NAV_JS at /agenthost-nav.js means the rig's
// pages render the exact tab bar production serves -- the header-fit tests
// measure real pills, not an empty <nav>. APPS is re-exported so the test file
// derives its expected pill set from the same single source of truth.
const require = createRequire(import.meta.url);
const { APPS, NAV_JS } = require(path.join(CONTAINER, "gate.js"));
export { APPS };

// A stand-in terminal page shaped like ttyd's: it exposes window.term with an
// options.fontSize, a #terminal div, and an .xterm-helper-textarea that records
// dispatched key events so tests can assert what the key bar sent. A real
// WebSocket is opened so the appshell's WS-status wrapper has something to hook.
const TERMINAL_PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>ttyd</title>
<script>${appshell}</script>
<script defer src="/agenthost-nav.js?v=1"></script>
</head><body>
<script>
  // Minimal xterm double. buffer.active mimics xterm's wrapped-line model: a
  // long URL is split across rows, and continuation rows carry isWrapped=true.
  // __setRows(rows) lets tests load screen content; getLine/translateToString/
  // isWrapped match the real xterm API the appshell's extractUrls() calls.
  window.__rows = [];
  // Records everything the app shell sends through xterm's data pipe (the path
  // ttyd wires to its socket). The key bar / paste use term._core.coreService
  // .triggerDataEvent, so this is where "esc" (\x1b), ctrl-c (\x03) etc. land.
  window.__data = [];
  window.term = {
    options: { fontSize: 15 },
    _core: { coreService: { triggerDataEvent: function (data) { window.__data.push(data); } } },
    buffer: { active: {
      get length() { return window.__rows.length; },
      getLine: function (i) {
        var r = window.__rows[i];
        if (!r) return null;
        return { isWrapped: !!r.wrapped, translateToString: function () { return r.text; } };
      },
    } },
  };
  window.__setRows = function (rows) { window.__rows = rows; };
  window.__keys = [];
  // Mimic ttyd 1.7.x exactly: the terminal container (#terminal-container in
  // this build) is created by the bundle at RUNTIME, NOT present in the initial
  // HTML. Mount it a tick after load so the appshell watcher has to wait for it
  // -- the real-world timing that used to leave the phone with no chrome.
  setTimeout(function () {
    var tc = document.createElement("div");
    tc.id = "terminal-container";
    var ta = document.createElement("textarea");
    ta.className = "xterm-helper-textarea";
    tc.appendChild(ta);
    // Match real xterm's DOM one level deeper: .xterm > .xterm-screen. The
    // appshell's touch->wheel bridge dispatches synthetic wheel events on
    // .xterm-screen and REAL xterm listens for them on .xterm (bubbling) --
    // record what arrives there so tests assert the exact path real ttyd uses.
    window.__wheels = [];
    var xt = document.createElement("div");
    xt.className = "xterm";
    var screen = document.createElement("div");
    screen.className = "xterm-screen";
    xt.appendChild(screen);
    tc.appendChild(xt);
    xt.addEventListener("wheel", function (e) {
      window.__wheels.push({ deltaY: e.deltaY, deltaMode: e.deltaMode });
    });
    document.body.appendChild(tc);
    ["keydown","keypress","keyup"].forEach(function(type){
      ta.addEventListener(type, function(e){
        window.__keys.push({type:type, key:e.key, keyCode:e.keyCode, charCode:e.charCode, ctrl:e.ctrlKey});
      });
    });
  }, 120);
  // Open the socket the appshell's WrappedWS is waiting to observe (WS-status dot).
  window.__ws = new WebSocket((location.protocol==="https:"?"wss":"ws")+"://"+location.host+"/ws");
</script>
</body></html>`;

export function startRig() {
  // In-memory fake cron store: one seed job; POST remembers, DELETE removes.
  // Fresh per rig instance so test runs don't leak state into each other.
  let cronJobs = [{
    id: "abcdefgh1234", name: "Morning briefing", cron: "0 11 * * *",
    prompt: "brief me", tzOffsetMin: -240, createdAt: 0,
  }];
  // Fake push store: remembers subscriptions POSTed by the enable-notifications
  // control so tests can assert the round-trip. A real 65-byte P-256 public key
  // in base64url so the client's urlBase64ToUint8Array()/atob() decodes cleanly.
  const VAPID_PUBLIC = "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8";
  let pushSubs = [];
  // Fake agent slot, mirroring gate.js exactly: one run at a time; a stream
  // arriving while a run holds the slot gets an IMMEDIATE "status" event and
  // waits in FIFO order (gate.js chatWaiters). Messages starting with "slow"
  // hold the slot before replying (700ms, or "slow <ms>") so tests and
  // screenshots can catch the queued state; everything else replies at once.
  let slotBusy = false;
  const slotWaiters = [];
  const withNextRun = (job) =>
    ({ ...job, nextRunAt: new Date(Date.now() + 3600e3).toISOString() });
  const json = (res, obj) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  // Brand injection, exactly the gate's serve-time mechanism: on a legal
  // deploy every gate-served page's <body becomes <body data-brand="legal".
  // The rig keys it off ?brand=legal so one server can drive both brands.
  const brandize = (html, url) =>
    url.searchParams.get("brand") === "legal"
      ? html.replace("<body", '<body data-brand="legal"')
      : html;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/") {
      // The real gate stamps the proxied ttyd page too (the appshell reads
      // document.body's data-brand to order its tabs).
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(brandize(TERMINAL_PAGE, url));
    }
    if (url.pathname === "/brand.json") {
      // gate.js exposes the box's brand pre-auth; the rig mirrors the shape.
      return json(res, { brand: url.searchParams.get("brand") === "legal" ? "legal" : "dev" });
    }
    if (url.pathname === "/agenthost-nav.js") {
      // The gate's real shared nav renderer (terminal page gets it via the
      // injected head tag above; chat.html/cron.html reference it themselves).
      res.writeHead(200, { "Content-Type": "application/javascript" });
      return res.end(NAV_JS);
    }
    if (url.pathname === "/chat") {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(brandize(chatHtml, url));
    }
    if (url.pathname === "/chat/stream") {
      const msg = url.searchParams.get("msg") || "";
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      // Brain search (feature 1): a "/brain <q>" message streams a summary over
      // the SAME SSE channel as normal chat. Fake the claude-summarized answer.
      if (msg.startsWith("/brain ")) {
        const q = msg.slice(7);
        res.write(`data: ${JSON.stringify("brain summary: ")}\n\n`);
        res.write(`data: ${JSON.stringify("your notes on " + q)}\n\n`);
        res.write(`event: done\ndata: {}\n\n`);
        return res.end();
      }
      // Busy-slot visibility: a message sent while another run holds the agent
      // slot gets an IMMEDIATE "status" event (rendered as a muted system line,
      // not a bubble), then streams normally once the slot frees. The 700ms gap
      // fakes the wait; real gate.js shapes the event exactly like this.
      if (msg === "busy test") {
        res.write(`event: status\ndata: ${JSON.stringify({ text: "agent is busy — a scheduled job is running; your message is queued", holder: "cron" })}\n\n`);
        setTimeout(() => {
          res.write(`data: ${JSON.stringify("queued reply: ")}\n\n`);
          res.write(`data: ${JSON.stringify(msg)}\n\n`);
          res.write(`event: done\ndata: {}\n\n`);
          res.end();
        }, 700);
        return;
      }
      // Fake claude behind the fake slot: echo the message back in two
      // chunks, then done, then hand the slot to the next queued stream.
      const run = () => {
        slotBusy = true;
        const m = /^slow(?:\s+(\d+))?/.exec(msg);
        const hold = m ? parseInt(m[1] || "700", 10) : 0;
        setTimeout(() => {
          res.write(`data: ${JSON.stringify("you said: ")}\n\n`);
          res.write(`data: ${JSON.stringify(msg)}\n\n`);
          res.write(`event: done\ndata: {}\n\n`);
          res.end();
          slotBusy = false;
          const w = slotWaiters.shift();
          if (w) w();
        }, hold);
      };
      if (slotBusy) {
        res.write(`event: status\ndata: ${JSON.stringify({ text: "agent is busy — another chat message is finishing; your message is queued", holder: "chat" })}\n\n`);
        slotWaiters.push(run);
      } else run();
      return;
    }
    // ---- Web Push (feature 3) fakes -------------------------------------
    if (url.pathname === "/push/key" && req.method === "GET") {
      return json(res, { key: VAPID_PUBLIC });
    }
    if (url.pathname === "/push/subscribe" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        try { pushSubs.push(JSON.parse(body || "{}")); } catch { /* ignore */ }
        json(res, { ok: true });
      });
      return;
    }
    if (url.pathname === "/sw.js") {
      res.writeHead(200, {
        "Content-Type": "text/javascript",
        "Service-Worker-Allowed": "/",
      });
      return res.end(
        "self.addEventListener('push', function(e){});\n" +
        "self.addEventListener('notificationclick', function(e){});\n"
      );
    }
    if (url.pathname === "/cron") {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(brandize(cronHtml, url));
    }
    // ---- Command Center fakes -------------------------------------------
    // Shapes mirror gate.js handleCommandCenter exactly; the data is a rich
    // fixture so the tests can assert real rendering (panels, feed, windows).
    if (url.pathname === "/cc") {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(brandize(ccHtml, url));
    }
    if (url.pathname === "/cc/state") {
      return json(res, {
        day: "2026-07-17",
        usage: {
          claude: { in: 132000, out: 800, cost: 2.13, turns: 2, at: Date.now() - 12 * 60000 },
          hermes: { in: 76000, out: 360, cost: 0, turns: 2, at: Date.now() - 6 * 60000 },
        },
        windows: [
          { name: "bash", active: false },
          { name: "codex", active: true },
          { name: "ollama", active: false },
          { name: "hermes", active: false },
        ],
        hermes: { version: "0.18.2", gatewayState: null, gatewayRunning: false, activeSessions: 1 },
        ollama: { up: true, loaded: ["glm-5.2:cloud"], pulled: 3 },
        feed: [
          { eng: "hermes", what: "answered a chat message", at: Date.now() - 6 * 60000 },
          { eng: "claude", what: "searched the brain: “deployment notes”", at: Date.now() - 60 * 60000 },
          { eng: "board", what: "task added to the board: “Wire CCPA export route”", at: Date.now() - 2 * 3600e3 },
          { eng: "loops", what: "scheduled run: “Morning briefing”", at: Date.now() - 5 * 3600e3 },
        ],
      });
    }
    if (url.pathname === "/switch") {
      res.writeHead(204); return res.end();
    }
    if (url.pathname === "/cron/jobs" && req.method === "GET") {
      return json(res, {
        jobs: cronJobs.map(withNextRun),
        serverNow: new Date().toISOString(),
      });
    }
    if (url.pathname === "/cron/jobs" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        let parsed = {};
        try { parsed = JSON.parse(body || "{}"); } catch { /* keep {} */ }
        const job = withNextRun({ ...parsed, id: "zzzzzzzzzzzz", createdAt: Date.now() });
        cronJobs.push(job);
        json(res, { job });
      });
      return;
    }
    const del = url.pathname.match(/^\/cron\/jobs\/([a-z0-9]+)$/);
    if (del && req.method === "DELETE") {
      cronJobs = cronJobs.filter((j) => j.id !== del[1]);
      return json(res, { ok: true });
    }
    if (url.pathname === "/cron/runs") {
      return json(res, {
        runs: [
          { startedAt: Date.now() - 60000, ms: 1200, exit: 0, output: "briefing text" },
          { startedAt: Date.now() - 120000, ms: 900, exit: 1, output: "", error: "agent exited 1" },
        ],
      });
    }
    res.writeHead(404); res.end();
  });
  // Accept the fake terminal WebSocket so 'open' fires (connected dot).
  server.on("upgrade", (req, socket) => {
    // Minimal RFC6455 accept using the sec-websocket-key.
    const key = req.headers["sec-websocket-key"];
    import("node:crypto").then(({ createHash }) => {
      const accept = createHash("sha1")
        .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
      );
      // leave it open; tests that need a drop close it explicitly
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}
