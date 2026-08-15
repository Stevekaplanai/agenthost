"use strict";
// Visual QA agent: capture the box's own pages, notice when they change, and say
// what changed -- with evidence, on a surface a human already reads.
//
// TWO DEPARTURES FROM THE ORIGINAL BRIEF, both because its premises are false on
// this box, and I checked before building rather than after:
//
// 1. NO PLAYWRIGHT. The brief says "Playwright (already on the box)" and "headless
//    Chromium already installed for the phone-ui test suite". Neither is true: the
//    phone-ui suite runs in GitHub Actions, not here, and `playwright` resolves to
//    nothing. Chromium was baked into the image on 2026-08-09 and drives fine from
//    the CLI -- verified rendering real text at 390x844. Adding Playwright would
//    download a SECOND browser onto a box with 1.7-2.5 GB of headroom to do what
//    the binary already does.
//
// 2. HASH BEFORE VISION. The brief sends every pair to Gemini. Identical bytes are
//    identical, and an LLM is a slow, costly, non-deterministic way to learn that.
//    A sha256 pre-filter makes an unchanged run free and instant, and vision only
//    runs where the pixels actually moved. It also makes "nothing changed" a fact
//    rather than a model's opinion.
//
// RAM IS THE REAL CONSTRAINT, not disk. Measured on the live box: 3916 MB total,
// 1.7-2.5 GB available depending on load. A headless Chromium is 500 MB-1 GB
// resident. So this must never run beside an engine -- the caller takes the agent
// lane first (the authenticated POST /qa/run route owns that reservation). Adding the binary was safe; running it
// unscheduled is what OOMs the box, and an OOM takes the gate, the board and every
// agent with it.
const fs = require("fs");
const os = require("os");
const path = require("path");
const fsConstants = fs.constants;
const crypto = require("crypto");

const CHROMIUM_ARGS = [
  "--headless",
  // Both required in this container, and neither is a security relaxation chosen
  // lightly: bwrap already isolates this process and Chromium's own sandbox cannot
  // nest inside it. --disable-dev-shm-usage because /dev/shm is small here and
  // Chromium dies without it in a way that looks like a capture failure.
  "--no-sandbox",
  "--disable-gpu",
  "--disable-dev-shm-usage",
];

// LET THE PAGE PAINT BEFORE PHOTOGRAPHING IT.
//
// `--screenshot` fires when the DOCUMENT is ready. The workspace is an SPA whose
// content arrives afterwards through asynchronous dashboard fetches. So the capture
// was beating its own data, and every authenticated screenshot recorded the
// pre-paint state: "Box is degraded", "Board snapshot unavailable", "Loading the
// live team thread", Settings "MODE UNKNOWN", every agent "No current task".
//
// THAT LOOKED EXACTLY LIKE A BROKEN BOX, and it was not. Measured 2026-08-12 with
// an operator session against the live gate: `/board` returns HTTP 200 with 22177
// bytes of real lanes and cards. The backend was healthy the whole time; the
// camera was early.
//
// Two wrong diagnoses were reached by looking at the screenshots and reasoning
// about them -- first "live clocks", then "the page never finishes loading". Both
// plausible, both wrong. Querying the endpoints settled it in one command. A
// picture of a surface is evidence about the CAMERA as much as the subject.
//
// --virtual-time-budget is Chromium's own answer: it advances virtual time and
// takes the shot when the budget is spent, giving the dashboard fetches and React
// updates time to land. The budget bounds the wait without relying on network idle.
// Kimi's review of #393 caught the first cut of this line being the very defect
// the file argues against: `Math.max(0, Number(x) || 8000)` turned QA_SETTLE_MS=-5
// into 0, which omits the flag and SILENTLY RESTORES the early-screenshot bug --
// a knob that quietly disables the fix it configures. It also made QA_SETTLE_MS=0
// mean 8000, so the one person trying to switch it off got the default instead.
//
// So: a bad value is NAMED and the safe default is kept (Rule 16 -- never fail
// into the broken state without saying so), and 0 is honoured as a deliberate
// opt-out, which is what the tests use to assert the flag is absent.
const QA_SETTLE_DEFAULT_MS = 8000;
function settleBudgetMs(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return QA_SETTLE_DEFAULT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.error("[qa] QA_SETTLE_MS=" + raw + " is not a non-negative number; using " +
      QA_SETTLE_DEFAULT_MS + "ms so the capture still waits for the page to paint");
    return QA_SETTLE_DEFAULT_MS;
  }
  return parsed;
}
const SETTLE_MS = settleBudgetMs(process.env.QA_SETTLE_MS);

// Bounded on purpose. Baselines live on /data, which was 61% used with ~3.7 GB free
// when this was written. Three viewports x N routes x forever is how a volume fills
// quietly, and a full volume takes the box down for reasons nobody connects back to
// screenshots. Keep the baseline plus a short tail for diffing.
const KEEP_PER_TARGET = 5;
const QA_MASK_SELECTOR = /^\[data-qa-dynamic=[a-z0-9][a-z0-9-]{0,63}\]$/;

// A mask is an explicit, route-owned promise that this ONE marked region contains
// live pixels. Restricting selectors to our data marker prevents a config typo
// such as `main` or `body` from making a healthy screenshot compare clean while
// hiding the surface it was meant to guard.
function routeMasks(route) {
  if (!route || route.mask === undefined) return [];
  const routeName = String(route.name || "unnamed route");
  if (!Array.isArray(route.mask)) throw new Error(routeName + " mask must be an array");
  if (route.mask.length > 12) throw new Error(routeName + " mask has more than 12 selectors");
  const seen = new Set();
  return route.mask.map((selector, index) => {
    if (typeof selector !== "string" || !QA_MASK_SELECTOR.test(selector)) {
      throw new Error(routeName + " mask[" + index + "] must be one exact [data-qa-dynamic=name] selector");
    }
    if (seen.has(selector)) throw new Error(routeName + " mask[" + index + "] duplicates " + selector);
    seen.add(selector);
    return selector;
  });
}

function maskStylesheet(masks, freezeMotion = false) {
  const motion = freezeMotion
    ? "*, *::before, *::after {\n  animation: none !important;\n  transition: none !important;\n  caret-color: transparent !important;\n}\n"
    : "";
  return motion + masks.map((selector) => selector + " { visibility: hidden !important; }").join("\n") + "\n";
}

const QA_RENDER_HEADER = "X-AgentHost-QA-Render";
function cleanQaChildEnv(source = process.env) {
  const env = { ...source };
  delete env.QA_RENDER_TOKEN;
  return env;
}

// Authenticated screenshots must be stable without turning the QA credential
// into read access to the operator's transcript, board, settings or audit log.
// These sanitized values are injected in the page's MAIN world at document_start,
// before the dashboard bundle can issue its first fetch. They exercise the real
// UI data paths while every answer remains deterministic and contains no box
// state. Unknown same-origin fetches fail locally instead of reaching the gate.
const QA_FIXTURE_TIME = "2026-08-12T12:00:00.000Z";
function qaFixturePayloads() {
  const lanes = ["queued", "running", "awaiting", "review", "done", "blocked"];
  const task = {
    id: "qa-fixture-task", title: "Verify the release evidence", status: "running", lane: "running",
    actions: ["open", "chat"], transitions: [],
    destinations: { details: "/?view=work%2Fboard&task=qa-fixture-task", chat: "/?view=room%2Fchat" },
    assignee: "codex", priority: "high", created_at: QA_FIXTURE_TIME, updated_at: QA_FIXTURE_TIME,
  };
  const engine = (state, taskName) => ({
    state, status: state, summary: state === "running" ? "Working from a governed lane" : "Ready",
    currentTask: taskName || null, observedAt: Date.parse(QA_FIXTURE_TIME),
    lastActiveAt: Date.parse(QA_FIXTURE_TIME), capability: { available: true, summary: "Available", artifacts: [] },
  });
  const settings = {
    v: 1,
    llm: { roster: Object.fromEntries(["claude", "codex", "gemini", "hermes", "cursor"].map((id) => [id, { active: true, inChat: true }])) },
    services: { ollama: { enabled: false }, openclaw: { enabled: false } },
    providers: { moonshot: { enabled: false, modelId: "kimi-k3" } },
    channels: Object.fromEntries(["telegram", "discord", "whatsapp"].map((id) => [id, {
      enabled: false, owner: id === "whatsapp" ? "hermes" : "openclaw", confirmGate: true, boardContext: true,
    }])),
    cost: { limitsEnabled: true, perChainUsd: 5, chatDailyUsd: 25, chatDailyTokens: 500000 },
    schedule: { sleep: { enabled: false, start: "23:00", end: "07:00" } },
    board: { autoDispatch: true, stuckAlerts: true },
    agents: { heartbeat: "milestone", kimi: { role: "review", limits: { perRunUsd: 1, perDayUsd: 5 } } },
    git: { autonomyLevel: 1, reviewStrictness: 2, autoCommit: true },
  };
  const profile = (id) => ({
    id, label: id[0].toUpperCase() + id.slice(1), installed: true, routed: true, color: null,
    bin: id, chatAdapter: id, autoJail: true, role: "QA fixture", provider: null, fallback: null,
    capabilities: { chat: { state: "available" }, unattended: { state: "available" }, review: { state: "available" } },
    runtimeState: "ready", workspace: "/workspace", isolationStatus: "jailed", autonomyLevel: 1,
    todaySpend: { tokens: 1200, cost: 0.02 }, limits: null,
  });
  return {
    "/chat/thread": { entries: [{ at: Date.parse(QA_FIXTURE_TIME), who: "codex", text: "QA fixture: release evidence is ready for review.", id: "qa-fixture-thread" }] },
    "/chat/runs": { runs: [] },
    "/board": {
      available: true,
      lanes: lanes.map((id) => ({ id, title: id === "awaiting" ? "Awaiting You" : id[0].toUpperCase() + id.slice(1) })),
      columns: Object.fromEntries(lanes.map((id) => [id, id === "running" ? [task] : []])),
      tasks: [task], relations: { available: true, byTask: { [task.id]: { parents: [], children: [] } } },
    },
    "/cc/state": {
      day: "2026-08-12", usage: { codex: { in: 900, out: 300, cost: 0.02, turns: 1, at: Date.parse(QA_FIXTURE_TIME) } },
      windows: {},
      engines: {
        claude: engine("idle"), codex: engine("running", task.title), hermes: engine("online"),
        gemini: engine("online"), kimi: engine("online"), cursor: engine("online"),
      },
      ollama: { up: false, loaded: [], pulled: null }, channels: {}, feed: [],
      autonomy: { on: true, busy: true, busyKind: "qa", lastTick: { at: QA_FIXTURE_TIME, cause: "QA fixture" } },
    },
    "/cc/inventory": { skills: { items: [] }, plugins: [], mcps: [], toolDetails: [] },
    "/cron/jobs": { jobs: [], serverNow: QA_FIXTURE_TIME },
    "/cron/runs": { runs: [] },
    "/cron/multi/jobs": { jobs: [], serverNow: QA_FIXTURE_TIME, engines: {} },
    "/cron/multi/runs": { runs: [] },
    "/api/mode": { mode: "default" },
    "/cc/mesh": { boxId: "qa-fixture-box", state: "ready", epoch: 1, peers: [], peersConfigured: 0, recent: [], taskAssociation: "none" },
    "/api/settings": { settings, defaults: settings, overrides: {}, serviceStatus: { ollama: { up: false, loaded: [] }, openclaw: { up: false } } },
    "/profiles/data": { ok: true, agents: ["claude", "codex", "hermes", "gemini", "kimi", "cursor"].map(profile) },
    "/audit/data": { observedAt: Date.parse(QA_FIXTURE_TIME), events: [{
      t: QA_FIXTURE_TIME, event: "qa_fixture_ready", detail: "Sanitized visual fixture loaded", eng: "gate", tid: "qa-fixture", ip: "local",
    }] },
    // Current source disables these readers on the two captured views, but the
    // committed export may briefly lag source during a coordinated rebuild. These
    // fixtures keep either bundle generation deterministic and gate-data-free.
    "/growth/accounts": { configured: true, accounts: [] },
    "/measurement/status": {
      connected: true, credentialHolder: "pipedream", providers: ["meta_ads"],
      disclosure: "QA fixture: sanitized provider metadata; no credential or client data is present.",
    },
    "/measurement/connections": { connections: [] },
    "/brain/api/memories": { memories: [] },
  };
}

function qaFixtureScript(origin) {
  const fixtures = JSON.stringify(qaFixturePayloads()).replace(/</g, "\\u003c");
  return `(() => {
    "use strict";
    const QA_ORIGIN = ${JSON.stringify(origin)};
    const FIXTURES = ${fixtures};
    const observations = [];
    const note = (kind, url, method) => {
      observations.push({ kind, path: url.pathname + url.search, method });
      const root = document.documentElement;
      if (root) {
        root.setAttribute("data-agenthost-qa-fixture", "ready");
        root.setAttribute("data-agenthost-qa-requests", String(observations.length));
      }
    };
    Object.defineProperty(window, "__AGENTHOST_QA_FIXTURE__", {
      value: Object.freeze({ observedAt: ${JSON.stringify(QA_FIXTURE_TIME)}, observations }),
      configurable: false, enumerable: false, writable: false,
    });
    window.fetch = function(input, init) {
      const request = typeof Request !== "undefined" && input instanceof Request ? input : null;
      const url = new URL(request ? request.url : String(input), location.href);
      const method = String((init && init.method) || (request && request.method) || "GET").toUpperCase();
      if (url.origin === QA_ORIGIN) {
        const payload = FIXTURES[url.pathname];
        if (method === "GET" && payload !== undefined) {
          note("fixture", url, method);
          return Promise.resolve(new Response(JSON.stringify(payload), {
            status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-AgentHost-QA-Fixture": "sanitized" },
          }));
        }
        note("blocked", url, method);
        return Promise.resolve(new Response(JSON.stringify({ error: "QA fixture blocked a non-render request" }), {
          status: 418, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-AgentHost-QA-Fixture": "blocked" },
        }));
      }
      note("blocked-cross-origin", url, method);
      return Promise.reject(new Error("QA fixture blocked a cross-origin request"));
    };
    const NativeEventSource = window.EventSource;
    if (NativeEventSource) {
      class QaFixtureEventSource extends EventTarget {
        constructor(raw) {
          super();
          const url = new URL(String(raw), location.href);
          if (url.origin !== QA_ORIGIN) throw new Error("QA fixture blocked a cross-origin event stream");
          this.url = url.href; this.withCredentials = false; this.readyState = 1;
          note("blocked-stream", url, "GET");
          queueMicrotask(() => { if (typeof this.onopen === "function") this.onopen(new Event("open")); this.dispatchEvent(new Event("open")); });
        }
        close() { this.readyState = 2; }
      }
      QaFixtureEventSource.CONNECTING = 0; QaFixtureEventSource.OPEN = 1; QaFixtureEventSource.CLOSED = 2;
      window.EventSource = QaFixtureEventSource;
    }
    note("installed", new URL(location.href), "DOCUMENT");
  })();\n`;
}

function createRouteExtension(masks, renderToken, routeUrl, io) {
  const dir = io.mkdtempSync(path.join(os.tmpdir(), "qa-route-"));
  try {
    const manifest = {
      manifest_version: 3,
      name: "AgentHost route-scoped QA capture",
      version: "1.0.0",
    };
    const contentScript = { matches: ["<all_urls>"], run_at: "document_start" };
    if (masks.length || renderToken) {
      contentScript.css = ["mask.css"];
      io.writeFileSync(path.join(dir, "mask.css"), maskStylesheet(masks, Boolean(renderToken)), { mode: 0o600 });
    }
    if (renderToken) {
      const parsedRoute = new URL(routeUrl);
      const origin = parsedRoute.origin;
      contentScript.js = ["fixture.js"];
      contentScript.world = "MAIN";
      io.writeFileSync(path.join(dir, "fixture.js"), qaFixtureScript(origin), { mode: 0o600 });
      manifest.permissions = ["declarativeNetRequest"];
      // Chrome match patterns do not carry a port. The DNR regex below still
      // pins the exact origin (including the test server's random port).
      manifest.host_permissions = [parsedRoute.protocol + "//" + parsedRoute.hostname + "/*"];
      manifest.declarative_net_request = {
        rule_resources: [{ id: "qa_auth", enabled: true, path: "rules.json" }],
      };
      const escapedOrigin = origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const headerAction = {
        type: "modifyHeaders",
        requestHeaders: [{ header: QA_RENDER_HEADER, operation: "set", value: renderToken }],
      };
      io.writeFileSync(path.join(dir, "rules.json"), JSON.stringify([
        {
          id: 1, priority: 1, action: headerAction,
          condition: { regexFilter: "^" + escapedOrigin + "/(?:audit)?$", resourceTypes: ["main_frame"] },
        },
        {
          id: 2, priority: 1, action: headerAction,
          condition: {
            regexFilter: "^" + escapedOrigin + "/_next/static/[A-Za-z0-9._~-]+(?:/[A-Za-z0-9._~-]+)*$",
            resourceTypes: ["script", "stylesheet", "font", "image", "other"],
          },
        },
      ]), { mode: 0o600 });
    }
    if (masks.length || renderToken) manifest.content_scripts = [contentScript];
    io.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
    return dir;
  } catch (error) {
    try { io.rmSync(dir, { recursive: true, force: true }); } catch { /* the caller reports the real write cause */ }
    throw error;
  }
}

function sha256File(file, deps) {
  const io = (deps && deps.fs) || fs;
  return crypto.createHash("sha256").update(io.readFileSync(file)).digest("hex");
}

// A capture is a route x viewport pair. Named so paths are predictable and a human
// can find the artifact from the audit line without a lookup table.
function targetKey(route, viewport) {
  return String(route.name) + "@" + String(viewport.name);
}

function capturePaths(rootDir, route, viewport, stamp) {
  const dir = path.join(rootDir, String(route.name), String(viewport.name));
  return {
    dir,
    baseline: path.join(dir, "baseline.png"),
    current: path.join(dir, "current-" + stamp + ".png"),
  };
}

function defaultRun(bin, args, options = {}) {
  const { spawnSync } = require("child_process");
  return spawnSync(bin, args, {
    encoding: "utf8",
    timeout: 60000,
    ...options,
    env: options.env || cleanQaChildEnv(),
  });
}

// The pass token never enters a URL. A private disposable extension injects it
// as a request header inside the Bubblewrap tmpfs, so /proc/<pid>/cmdline and a
// copied screenshot URL expose no credential.
function captureUrl(baseUrl, route) {
  return String(baseUrl) + String(route.path);
}

// THE POISONED BASELINE, which is the failure this whole guard exists to stop,
// and it is silent in the worst way.
//
// Chromium screenshots a 401 login wall exactly as happily as it screenshots a
// dashboard: it renders the HTML, writes the PNG and exits 0. Nothing about the
// capture says anything went wrong. The FIRST such capture is then adopted as the
// baseline (runQaPass below), and from that moment every later run compares two
// pictures of the login wall, matches, and reports "unchanged" -- forever. The
// pass stays green while watching nothing at all.
//
// That is the exact receipt-versus-reality failure this box keeps paying for, so
// an authenticated route is asked what the server actually SAYS before a picture
// of it is trusted. curl, because runQaPass is synchronous and curl is already a
// dependency of the synchronous pre-capture route check.
function defaultProbe(url, renderToken, deps = {}) {
  const io = deps.fs || fs;
  const run = deps.run || defaultRun;
  let configDir = null;
  let res = null;
  try {
    configDir = io.mkdtempSync(path.join(os.tmpdir(), "qa-probe-"));
    const config = path.join(configDir, "curl.conf");
    io.writeFileSync(config, `header = "${QA_RENDER_HEADER}: ${String(renderToken || "")}"\n`, { mode: 0o600 });
    // No -f: a 401 is the answer being looked for here, not an error to suppress.
    res = run("curl", ["--config", config, "-sS", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "15", url], {
      env: cleanQaChildEnv(),
    });
  } catch (e) {
    return { ok: false, error: "curl could not be started: " + String((e && e.message) || e).slice(0, 160) };
  } finally {
    if (configDir) { try { io.rmSync(configDir, { recursive: true, force: true }); } catch {} }
  }
  if (!res || res.status !== 0) {
    const tail = res && String(res.stderr || "").trim().split("\n").filter(Boolean).pop();
    return { ok: false, error: "curl exited " + (res ? res.status : "?") + (tail ? ": " + String(tail).slice(0, 120) : "") };
  }
  const code = parseInt(String(res.stdout || "").trim(), 10);
  if (!Number.isFinite(code) || code <= 0) {
    return { ok: false, error: "curl returned no HTTP status for the route" };
  }
  return { ok: true, code };
}

// Returns null when the route is safe to capture, or a NAMED cause when it is not.
// Every branch says which of the three distinct things went wrong, because "QA
// failed" with no cause is the defect this agent was written to avoid.
function authRouteBlocker(url, renderToken, probe) {
  if (!renderToken) {
    return "this route sits behind the login wall and no QA render token was supplied, " +
      "so the capture would photograph the login page and adopt it as the baseline. " +
      "Run the pass through POST /qa/run, which mints one.";
  }
  const seen = probe(url, renderToken);
  if (!seen.ok) return "the route could not be checked before capture (" + seen.error + ")";
  if (seen.code === 401 || seen.code === 403) {
    return "the QA render token did not authenticate (HTTP " + seen.code + "). The token is " +
      "pass-scoped and expires with the pass; capturing anyway would have made a picture of " +
      "the login wall this route's baseline.";
  }
  // ONLY 2xx IS SAFE TO BASELINE, and a redirect is the case worth spelling out.
  // Kimi's review of PR #390 caught this: the first cut refused >= 400, so a 302
  // sailed through. Chromium FOLLOWS redirects, so a route that bounces to a
  // login page or an error page would be probed as "fine" and then photographed
  // at its destination -- the poisoned baseline arriving by the one door the
  // guard left open. The gate answers 401 rather than 302 today, so this is
  // latent, not live; a guard against a silent failure is worth closing before
  // it is reachable rather than after.
  if (seen.code < 200 || seen.code >= 300) {
    return "the route answered HTTP " + seen.code + " before capture" +
      (seen.code >= 300 && seen.code < 400
        ? ", and chromium would follow that redirect and baseline wherever it lands. " +
          "List the destination as its own route if that is the page under test."
        : ", so the screenshot would record an error page rather than the surface under test.");
  }
  return null;
}

// Runs chromium once. Returns { ok, file, error } and NEVER throws: a failed capture
// is one missing screenshot, not a failed run, and its reason has to survive into the
// report or the operator gets "QA failed" with nothing to act on.
function captureOne(url, viewport, outFile, deps) {
  const run = (deps && deps.run) || defaultRun;
  const io = (deps && deps.fs) || fs;

  // A DISPOSABLE PROFILE, because the caller's $HOME is not ours to depend on.
  //
  // Left to itself, headless Chromium derives a user-data directory from $HOME.
  // The gate spawns this pass as user `gate` (uid 997) with HOME pointed at the
  // AGENT's home -- which is agent-owned 0755 and NOT writable by gate. So
  // Chromium died before it ever loaded a page:
  //
  //   ERROR:chrome/app/chrome_main.cc:207] Failed to create a unique user data
  //   directory for headless.                                  (exit 1)
  //
  // Reproduced on the live box 2026-08-11 as uid 997 with the gate's exact child
  // env; the identical command as `agent` succeeded, which is why every by-hand
  // check said "chromium is fine". It was fine -- for whoever ran it by hand.
  //
  // A fresh temp profile is the fix AND the smaller dependency: the only thing a
  // screenshot pass needs from a profile is that it be writable and empty. Under
  // TMPDIR, every user on the box has both. It is removed after the capture so a
  // pass does not leave ~50 MB of profile behind per route x viewport.
  let profileDir = null;
  try {
    profileDir = io.mkdtempSync(path.join(os.tmpdir(), "qa-chromium-"));
  } catch (e) {
    return {
      ok: false,
      file: outFile,
      error: "could not create a chromium profile directory under " + os.tmpdir() + ": " +
        String((e && e.message) || e).slice(0, 160),
    };
  }
  let extensionDir = null;
  try {
    const masks = (deps && deps.masks) || [];
    const renderToken = String((deps && deps.renderToken) || "");
    if (masks.length || renderToken) {
      try { extensionDir = createRouteExtension(masks, renderToken, url, io); } catch (e) {
        return {
          ok: false,
          file: outFile,
          error: "could not prepare the route's private QA extension: " + String((e && e.message) || e).slice(0, 160),
        };
      }
    }
    return captureWithProfile(url, viewport, outFile, profileDir, extensionDir, run, io);
  } finally {
    // Best-effort: a leftover temp profile is litter, never a failed capture, so
    // it must not be able to turn a good screenshot into an error.
    try { if (extensionDir) io.rmSync(extensionDir, { recursive: true, force: true }); } catch { /* litter, not a failure */ }
    try { io.rmSync(profileDir, { recursive: true, force: true }); } catch { /* litter, not a failure */ }
  }
}

function captureWithProfile(url, viewport, outFile, profileDir, extensionDir, run, io) {
  const args = CHROMIUM_ARGS.concat([
    "--user-data-dir=" + profileDir,
    ...(extensionDir ? ["--disable-extensions-except=" + extensionDir, "--load-extension=" + extensionDir] : []),
    ...(SETTLE_MS > 0 ? ["--virtual-time-budget=" + SETTLE_MS] : []),
    "--screenshot=" + outFile,
    "--window-size=" + viewport.width + "," + viewport.height,
    url,
  ]);
  let res = null;
  try { res = run("chromium", args, { env: cleanQaChildEnv() }); } catch (e) {
    return { ok: false, file: outFile, error: "chromium could not be started: " + String((e && e.message) || e).slice(0, 160) };
  }
  if (!res || res.status !== 0) {
    // Chromium writes dbus/gcm ERROR lines to stderr on EVERY successful run in a
    // container. Reporting those as the cause would send someone chasing dbus, so
    // the exit status decides and stderr only ever supplies detail.
    const tail = res && String(res.stderr || "").trim().split("\n").filter(Boolean).pop();
    return { ok: false, file: outFile, error: "chromium exited " + (res ? res.status : "?") + ": " + String(tail || "no output").slice(0, 200) };
  }
  if (!io.existsSync(outFile)) {
    // Exit 0 with no file is its own distinct failure and must not read as success.
    //
    // But "chromium exited 0 but wrote no file" is a SYMPTOM, and on 2026-08-10 it
    // named the wrong culprit for every capture on the box. The real cause was that
    // the output ROOT (/data/qa-screenshots) could not exist: /data is root-owned,
    // the agent's mkdir got "Permission denied", and chromium handed an unwritable
    // path writes nothing and still exits 0. Six identical lines blamed chromium;
    // chromium was fine -- the same command against /tmp wrote 5588 bytes.
    //
    // So say which of the two it is. The directory check is the one that
    // distinguishes "the browser failed" from "we asked it to write somewhere that
    // does not exist", and those have completely different fixes.
    const dir = path.dirname(outFile);
    let why = "";
    try {
      if (!io.existsSync(dir)) why = "its output directory does not exist and could not be created: " + dir;
      else { io.accessSync(dir, fsConstants.W_OK); }
    } catch { why = "its output directory is not writable by this user: " + dir; }
    return {
      ok: false,
      file: outFile,
      error: why
        ? "chromium exited 0 and wrote nothing because " + why
        : "chromium exited 0 but wrote no file (output directory exists and is writable -- this one really is the browser)",
    };
  }
  return { ok: true, file: outFile };
}

// Prune oldest current-*.png beyond KEEP_PER_TARGET. baseline.png is never pruned.
function pruneTarget(dir, deps) {
  const io = (deps && deps.fs) || fs;
  let names = [];
  try { names = io.readdirSync(dir); } catch { return 0; }
  const shots = names.filter((n) => n.startsWith("current-") && n.endsWith(".png")).sort();
  const excess = shots.length - KEEP_PER_TARGET;
  if (excess <= 0) return 0;
  let removed = 0;
  for (const n of shots.slice(0, excess)) {
    try { io.unlinkSync(path.join(dir, n)); removed += 1; } catch { /* already gone */ }
  }
  return removed;
}

function summarize(results) {
  const n = (s) => results.filter((r) => r.status === s).length;
  const parts = [];
  if (n("changed")) parts.push(n("changed") + " changed");
  if (n("baseline_created")) parts.push(n("baseline_created") + " baseline" + (n("baseline_created") === 1 ? "" : "s") + " created");
  if (n("unchanged")) parts.push(n("unchanged") + " unchanged");
  const failures = results.filter((r) => String(r.status).endsWith("_failed"));
  if (failures.length) {
    // Name the first cause inline. "2 failed" tells an operator to go digging;
    // "2 failed (chromium exited 1: ...)" tells them what actually happened.
    parts.push(failures.length + " failed (" + String(failures[0].detail || "no detail").slice(0, 90) + ")");
  }
  return parts.length ? parts.join(", ") : "no targets configured";
}

// The whole pass. Returns a structured result; the caller decides where to put it.
// Deps are injectable so the tests exercise THIS logic without a browser -- the
// lesson from 2026-08-09, when nine passing tests described a classifier that had
// never once worked, because every mock was more cooperative than the real thing.
function runQaPass(config, deps) {
  const io = (deps && deps.fs) || fs;
  const capture = (deps && deps.captureOne) || captureOne;
  const hash = (deps && deps.sha256File) || sha256File;
  const stamp = (deps && deps.stamp) || String(Date.now());
  // The production runner supplies /qa-output, the descriptor-pinned directory
  // mounted into the Bubblewrap jail. Keeping the default inside that neutral
  // root prevents a future caller from accidentally restoring a host pathname.
  const rootDir = (deps && deps.rootDir) || "/qa-output";
  const probe = (deps && deps.probe) || defaultProbe;
  // Supplied by the gate through the jailed runner when the pass came from
  // POST /qa/run. Missing tokens still fail closed before a protected capture.
  const renderToken = (deps && deps.renderToken) || "";

  const results = [];
  for (const route of (config && config.routes) || []) {
    let masks;
    try { masks = routeMasks(route); } catch (error) {
      for (const viewport of (config && config.viewports) || []) {
        results.push({
          target: targetKey(route, viewport),
          status: "capture_failed",
          detail: String((error && error.message) || error).slice(0, 200),
        });
      }
      continue;
    }
    for (const viewport of (config && config.viewports) || []) {
      const key = targetKey(route, viewport);
      const p = capturePaths(rootDir, route, viewport, stamp);
      try { io.mkdirSync(p.dir, { recursive: true }); } catch { /* exists */ }

      const url = captureUrl(config.baseUrl, route, renderToken);
      if (route && route.auth) {
        const blocker = authRouteBlocker(url, renderToken, probe);
        if (blocker) {
          results.push({ target: key, status: "capture_failed", detail: blocker });
          continue;
        }
      }

      const shot = capture(url, viewport, p.current, {
        ...(deps || {}),
        masks,
        renderToken: route && route.auth ? renderToken : "",
      });
      if (!shot.ok) {
        results.push({ target: key, status: "capture_failed", detail: shot.error });
        continue;
      }
      // FIRST RUN ADOPTS A BASELINE, and that decision has teeth: whatever the page
      // looks like right now becomes "correct". If the page is broken today, the
      // break is enshrined and every later run reports clean. Recorded as its own
      // status so a human can see a baseline was BORN rather than compared.
      if (!io.existsSync(p.baseline)) {
        try { io.copyFileSync(p.current, p.baseline); } catch (e) {
          results.push({ target: key, status: "baseline_failed", detail: String((e && e.message) || e).slice(0, 160) });
          continue;
        }
        results.push({ target: key, status: "baseline_created" });
        pruneTarget(p.dir, deps);
        continue;
      }
      let same = false;
      try { same = hash(p.baseline, deps) === hash(p.current, deps); } catch (e) {
        results.push({ target: key, status: "compare_failed", detail: String((e && e.message) || e).slice(0, 160) });
        continue;
      }
      results.push(same
        ? { target: key, status: "unchanged" }
        : { target: key, status: "changed", baseline: p.baseline, current: p.current });
      pruneTarget(p.dir, deps);
    }
  }

  const changed = results.filter((r) => r.status === "changed");
  const failed = results.filter((r) => String(r.status).endsWith("_failed"));
  return {
    stamp,
    results,
    changedCount: changed.length,
    failedCount: failed.length,
    // The one-line summary the feed shows. It names counts and the first cause,
    // never a bare "QA done": a status without a cause is the defect this project
    // has spent two days removing.
    summary: summarize(results),
  };
}

module.exports = {
  runQaPass, captureOne, sha256File, targetKey, capturePaths, pruneTarget, summarize,
  captureUrl, authRouteBlocker, defaultProbe, settleBudgetMs, routeMasks, maskStylesheet,
  cleanQaChildEnv, createRouteExtension, qaFixturePayloads, qaFixtureScript,
  QA_RENDER_HEADER, CHROMIUM_ARGS, KEEP_PER_TARGET,
};
