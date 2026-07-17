// AgentHost gate: cookie/link auth in front of ttyd, zero dependencies.
// Why it exists: browser Basic-Auth prompts break on phones (WebKit drops the
// Authorization header on WebSocket upgrades; in-app browsers mangle the prompt).
// A ?key=... link sets a cookie once; cookies ride WS handshakes everywhere.
//
// Also serves the PWA shell (manifest, icons, touch key bar) so the terminal
// installs to a phone home screen and opens full-screen (G3). The manifest is
// for Android/Chrome; iOS Safari ignores it and reads apple-touch-icon +
// apple-mobile-web-app-* meta tags instead, which is why both are injected
// into the proxied "/" response below rather than relying on the manifest alone.
const http = require("http");
const net = require("net");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { parseCron, cronMatches, nextRun } = require("./cron-lib.js");

// ---- /brain query helpers (pure, no I/O) ------------------------------------
// Declared ahead of the lib-mode export below so unit tests can require() them
// without booting the server. Used by runBrain() further down.
//
// "/brain what is attribyte" used to grep the whole sentence as ONE literal
// pattern and come back empty unless the notes contained that exact phrase.
// Tokenize instead: lowercase, split on non-word runs, drop filler words, and
// keep up to 8 distinct content terms for rg to OR together. The ORIGINAL full
// question still goes to the summarizer prompt -- only the grep uses keywords.
const BRAIN_STOPWORDS = new Set(("a an the is are was were be been being am do does did doing done have has had " +
  "what when where which who whom why how i you we they he she it its this that these those there here " +
  "my me mine your yours our ours their them us his her of to in on for with and or but not no yes if so " +
  "about tell say says said show find search look up know knows anything something everything stuff thing things " +
  "can could would should will shall may might must please from at by as into onto over under again just really " +
  "get got make made want wanted need needed").split(" "));
function tokenizeBrainQuery(q) {
  const terms = [];
  const seen = new Set();
  for (const raw of String(q).toLowerCase().split(/[^a-z0-9._-]+/)) {
    // Trim edge punctuation but keep it inside a term (pack.mjs, 2fa-notes).
    const t = raw.replace(/^[._-]+|[._-]+$/g, "");
    if (t.length < 2 || BRAIN_STOPWORDS.has(t) || seen.has(t)) continue;
    seen.add(t);
    terms.push(t);
    if (terms.length >= 8) break;
  }
  // Dotted/hyphenated terms also match their base words: notes rarely spell
  // "claimflow.health" the way the question does -- they say "claimflow" or
  // "health check". Append split-on-separator variants AFTER the base terms
  // (compound-first keeps the strongest signal at the front; ranking scores a
  // line per matched term, so a literal compound hit still outranks a
  // part-only hit). Stopword/short parts are dropped ("up-to-date" only adds
  // "date"); 16 total keeps rg's -e list bounded.
  for (const t of terms.slice()) {
    if (terms.length >= 16) break;
    if (!/[._-]/.test(t)) continue;
    for (const part of t.split(/[._-]+/)) {
      if (part.length < 2 || BRAIN_STOPWORDS.has(part) || seen.has(part)) continue;
      seen.add(part);
      terms.push(part);
      if (terms.length >= 16) break;
    }
  }
  return terms;
}
// Rank rg's OR'd hits so lines matching MORE of the query's terms surface
// first -- the 32KB cap and the summarizer both read top-down, so the lines
// most likely to answer the question must not be buried under single-term
// noise. Stable: equal scores keep rg's original order.
function rankBrainHits(hitsText, terms) {
  const lines = String(hitsText).split("\n").filter((l) => l.trim() !== "");
  const lower = terms.map((t) => t.toLowerCase());
  return lines
    .map((line, i) => {
      const ll = line.toLowerCase();
      let score = 0;
      for (const t of lower) if (ll.includes(t)) score++;
      return { line, i, score };
    })
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((s) => s.line)
    .join("\n");
}

// ---- agent spawn args (pure) -------------------------------------------------
// One arg builder for EVERY gate-spawned `claude -p` run (chat, /brain
// summaries, cron jobs), so the hook policy below can't drift between call
// sites. Prompt rides argv, never a shell string.
//
// Hooks are OFF for these runs, and that is deliberate: the harness's
// Stop/SessionStart hooks exist for the user's INTERACTIVE terminal session
// (memory capture, notifications) -- but `claude -p` re-fires all of them on
// every one-shot, and the gate spawns a fresh -p per chat message. That was
// the #1 speed complaint: Steve's five operator-brain hooks added 2m08s to a
// single observed chat turn. Measured locally (claude 2.1.207, two 3s hooks):
// a -p turn takes 10.1s with hooks, 3.5s with this overlay.
//
// Mechanism: `--settings '{"disableAllHooks":true}'` -- disableAllHooks is the
// CLI's supported kill switch and the CLI-level settings layer outranks the
// user/project files. An overlay of `{"hooks":{}}` does NOT work (verified:
// hooks still ran) because hook arrays MERGE across settings sources rather
// than override. An old CLI that doesn't know the key just ignores the overlay
// and keeps today's slow-but-working behavior.
//
// Users who disagree (want memory hooks to see chat/cron turns too, accepting
// the latency) opt out with AGENT_CHAT_HOOKS=1 in the container env.
// `env` is injectable for unit tests only; production passes nothing.
function agentSpawnArgs(prompt, withContinue, env) {
  const args = ["-p", prompt, "--dangerously-skip-permissions"];
  if ((env || process.env).AGENT_CHAT_HOOKS !== "1") args.push("--settings", '{"disableAllHooks":true}');
  if (withContinue) args.push("-c");
  return args;
}

// ---- App switcher: THE single source of truth for the tab bar ---------------
// Every "app" reachable from the box is one entry here. /apps.json serves this
// list; agenthost-nav.js renders the tab bar from it on every page (terminal
// via appshell, plus chat.html/cron.html), so adding an app is a ONE-LINE edit
// -- no more editing the nav in three hardcoded places. `href` is the route;
// `match` (optional regex source) marks the tab active for related paths; `proxy`
// (optional) names a backend port the gate reverse-proxies for this app.
// Order differs by brand (legal is chat-first); the renderer marks the active
// tab by the current path.
// A "terminal app" (has `tmux`) opens a named tmux window in the web terminal:
// its href is /?window=<name>; appshell.js reads that and calls the gate's
// /switch route, which runs `tmux select-window` ON THE BOX (server-side, so it
// works even when the focused window is a full-screen TUI). A "web app" (has
// `proxy`) is reverse-proxied at its href. Plain pages (chat, loops) are served
// by the gate directly.
// `match` is tested against pathname+search. Terminal is active on "/" only when
// no ?window is selected; codex is active when ?window=codex is present.
// Declared ahead of the lib-mode guard below (it's pure data + a template
// string) so the UI test rig can require() the REAL nav renderer and measure
// the same tab bar production serves.
const HERMES_PORT = 9119; // Hermes web dashboard (hermes dashboard --port)
// nav: false keeps an entry ROUTABLE but out of the top tab bar. The 2026-07-17
// restructure (Steve): the dev nav is three tabs -- command center | chat |
// loops -- and the engines (terminal, hermes, codex, ollama) are reached
// THROUGH Command Center instead of each owning a pill. Their routes, proxies,
// and tmux windows are unchanged; only the pill is gone. Legal stays a
// three-tab brand too (chat | loops | terminal) -- a legal box is single-engine
// Claude, so Command Center never renders there (see handleCommandCenter).
const APPS = [
  { id: "cc",       label: "command center", href: "/cc",    match: "^/cc" },
  { id: "chat",     label: "chat",     href: "/chat",         match: "^/chat" },
  { id: "loops",    label: "loops",    href: "/cron",         match: "^/cron" },
  { id: "terminal", label: "terminal", href: "/",             match: "^/(\\?(?!.*\\bwindow=)|$)", nav: false },
  { id: "hermes",   label: "hermes",   href: "/hermes/",      match: "^/hermes",            proxy: HERMES_PORT, nav: false },
  { id: "codex",    label: "codex",    href: "/?window=codex", match: "[?&]window=codex",   tmux: "codex", nav: false },
  { id: "ollama",   label: "ollama",   href: "/?window=ollama", match: "[?&]window=ollama", tmux: "ollama", nav: false },
];
// Serialized for /apps.json and the nav script. `tmux` isn't needed client-side
// (the href already encodes ?window=), so only the render fields are exposed.
const APPS_JSON = JSON.stringify(APPS.map(({ id, label, href, match, nav }) => ({ id, label, href, match, nav })));

// Shared app-switcher nav renderer. Populates EVERY <nav data-slot="nav"> on the
// page from the APPS list (inlined, no fetch -> no race), marking the tab active
// by the current path. One source of truth: change APPS in gate.js and the tab
// bar updates on the terminal, chat, and loops pages at once. Legal brand is
// chat-first: the terminal tab moves to the end (mirrors the old hardcoded order).
const NAV_JS = `(function(){
  var APPS = ${APPS_JSON};
  var isLegal = document.body && document.body.getAttribute("data-brand") === "legal";
  // Dev nav: entries not marked nav:false (command center | chat | loops).
  // Legal nav: chat | loops | terminal -- a single-engine box has no Command
  // Center and no engine tabs; terminal stays reachable as before.
  var apps = APPS.filter(function(a){
    if (isLegal) return a.id === "chat" || a.id === "loops" || a.id === "terminal";
    return a.nav !== false;
  });
  if (isLegal) { // chat-first: move the terminal entry to the end
    apps.sort(function(a,b){ return (a.id==="terminal") - (b.id==="terminal"); });
  }
  var loc = (location.pathname || "/") + (location.search || "");
  function render(nav){
    nav.innerHTML = apps.map(function(app){
      var active = new RegExp(app.match).test(loc);
      // Legal home ("/") redirects to /chat, so the terminal tab keeps its
      // ?terminal=1 bypass flag there.
      var href = (isLegal && app.id === "terminal") ? "/?terminal=1" : app.href;
      return '<a href="'+href+'"'+(active?' class="on"':'')+'>'+app.label+'</a>';
    }).join("");
    // With enough apps the pill bar scrolls; make sure the current app's tab is
    // visible even if it sits past the fold on a narrow phone.
    var on = nav.querySelector('a.on');
    if (on && on.scrollIntoView) { try { on.scrollIntoView({ inline: "center", block: "nearest" }); } catch(e){} }
  }
  function apply(){
    var navs = document.querySelectorAll('[data-slot="nav"]');
    for (var i=0;i<navs.length;i++) render(navs[i]);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", apply);
  else apply();
  // Re-render if the appshell mounts its nav after us (terminal page builds the
  // header asynchronously). Cheap MutationObserver, disconnects after first hit.
  try {
    var mo = new MutationObserver(function(){ if (document.querySelector('[data-slot="nav"] a')) return; apply(); });
    mo.observe(document.documentElement, { childList:true, subtree:true });
    setTimeout(function(){ apply(); mo.disconnect(); }, 3000);
  } catch(e){}
})();`;

// Lib mode: require()ing this file (unit tests, the UI test rig) gets the pure
// helpers above and NO side effects. Only running the file directly --
// `node gate.js`, which is exactly how container/start.sh launches it -- boots
// the gate server below.
if (require.main !== module) { module.exports = { tokenizeBrainQuery, rankBrainHits, agentSpawnArgs, APPS, APPS_JSON, NAV_JS }; return; }

const KEY = process.env.TTYD_PASSWORD;
if (!KEY) { console.error("[gate] TTYD_PASSWORD is required"); process.exit(1); }

// ---- brand ------------------------------------------------------------------
// One box, two skins. A legal deploy (`deploy/sync --legal`) stages the
// LEGAL_MODE Fly secret (src/legal-mode.js); start.sh additionally exports
// AGENTHOST_BRAND=legal from it. Either marks the box as the lawyer-facing
// "Legal Skills HQ" brand; everything else is the default dev brand. Fixed at
// boot -- rebranding a box means redeploying it, never a runtime toggle.
// Surfaced two ways per the brand contract:
//   1. every gate-served HTML page gets <body data-brand="legal"> (string
//      replace at serve time), which theme.css keys its token relight off;
//   2. GET /brand.json -> {"brand":"legal"|"dev"} (no auth; non-sensitive).
const BRAND = process.env.AGENTHOST_BRAND === "legal" || Boolean(process.env.LEGAL_MODE) ? "legal" : "dev";
function brandHtml(html) {
  const s = html.toString();
  if (BRAND !== "legal") return s;
  // Stamp the REAL body tag, not the first "<body" substring: pages
  // legitimately mention the tag in inline <style>/<script> comments (the
  // chat/cron pages document this very mechanism), so skip any candidate
  // sitting inside an unclosed script/style block or an HTML comment.
  const re = /<body[\s>]/gi;
  let m;
  while ((m = re.exec(s)) !== null) {
    const before = s.slice(0, m.index);
    const inScript = (before.match(/<script\b/gi) || []).length > (before.match(/<\/script>/gi) || []).length;
    const inStyle = (before.match(/<style\b/gi) || []).length > (before.match(/<\/style>/gi) || []).length;
    const inComment = before.lastIndexOf("<!--") > before.lastIndexOf("-->");
    if (!inScript && !inStyle && !inComment) {
      return s.slice(0, m.index) + '<body data-brand="legal"' + s.slice(m.index + "<body".length);
    }
  }
  return s; // no body tag (shouldn't happen for our pages): serve unstamped
}

const TTYD_PORT = 7681;
const COOKIE = "agenthost_auth";
const ASSET_DIR = __dirname;

// State + secrets live under the agent's HOME so they ride the persistent volume.
const HOME_DIR = process.env.HOME || "/data/home/agent";
const AGENTHOST_DIR = path.join(HOME_DIR, ".claude", "agenthost");

// The auth cookie's value MUST NOT be derivable from KEY. KEY (== TTYD_PASSWORD)
// rides in the URL at login (`/?key=...`), so it leaks via screenshots, history,
// and proxy logs -- if the cookie value equaled KEY, anyone holding a leaked key
// could set the cookie directly and walk straight past 2FA. Instead the cookie
// is HMAC(gateSecret, KEY): gateSecret is a per-box random persisted on the
// volume and never leaves the box, so a leaked key can't be turned into a valid
// cookie without also clearing the TOTP gate that mints it.
function loadGateSecret() {
  const f = path.join(AGENTHOST_DIR, "gate.secret");
  try { const s = fs.readFileSync(f, "utf8").trim(); if (s) return s; } catch {}
  const s = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(AGENTHOST_DIR, { recursive: true, mode: 0o700 });
    const tmp = f + ".tmp";
    fs.writeFileSync(tmp, s + "\n", { mode: 0o600 });
    fs.renameSync(tmp, f);
  } catch (e) { console.error(`[gate] could not persist gate secret (${e.message}); cookies reset on restart`); }
  return s;
}
const COOKIE_VALUE = crypto.createHmac("sha256", loadGateSecret()).update(KEY).digest("base64url");

// ---- per-engine token/cost tracker ------------------------------------------
// Each chat turn's usage (tokens, and $ where the engine reports it) accumulates
// per engine per LOCAL day in usage.json, so the cost strip can show "spent
// today" and the day resets at local midnight. Subscription engines (Claude
// sub, Codex ChatGPT plan, Hermes GLM-via-Ollama) mostly don't bill per turn --
// the real signal is TOKENS against quota -- so this leads with tokens; cost is
// tracked only where an engine reports it (Claude). Best-effort: a failed read/
// write never breaks a chat turn.
const USAGE_FILE = path.join(AGENTHOST_DIR, "usage.json");
// Local YYYY-MM-DD keyed off tzOffsetMin (minutes east of UTC; the client sends
// it so the box's own tz doesn't matter). Default UTC if not given.
function localDay(tzOffsetMin) {
  const off = Number.isFinite(tzOffsetMin) ? tzOffsetMin : 0;
  return new Date(Date.now() + off * 60 * 1000).toISOString().slice(0, 10);
}
function readUsage() {
  try { return JSON.parse(fs.readFileSync(USAGE_FILE, "utf8")); } catch { return {}; }
}
// usage = {inputTokens, outputTokens, costUsd|null}. Adds to today's per-engine
// row. Structure: { "<YYYY-MM-DD>": { "<engine>": {in, out, cost, turns} } }.
function recordUsage(engine, usage, tzOffsetMin) {
  if (!usage) return;
  try {
    const all = readUsage();
    const day = localDay(tzOffsetMin);
    const d = all[day] || (all[day] = {});
    const e = d[engine] || (d[engine] = { in: 0, out: 0, cost: 0, turns: 0 });
    e.in += usage.inputTokens || 0;
    e.out += usage.outputTokens || 0;
    if (Number.isFinite(usage.costUsd)) e.cost += usage.costUsd;
    e.turns += 1;
    e.at = Date.now(); // last-active stamp for the Command Center panels
    // Keep the file bounded: only the last 14 days.
    const days = Object.keys(all).sort();
    while (days.length > 14) delete all[days.shift()];
    fs.mkdirSync(AGENTHOST_DIR, { recursive: true, mode: 0o700 });
    const tmp = USAGE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 });
    fs.renameSync(tmp, USAGE_FILE);
  } catch (e) { console.error(`[gate] usage record failed (${e.message})`); }
}

// Read one Hermes session's token usage from its SQLite store. The gate is
// dependency-free, so this shells out to python3 (in the image) for a read-only
// query. Resolves to {inputTokens, outputTokens, costUsd|null} or null. Never
// throws -- a missing db / row / python just means "no usage this turn".
const HERMES_DB = path.join(HOME_DIR, ".hermes", "state.db");
const HERMES_BIN = path.join(HOME_DIR, ".local", "bin", "hermes");
// The Hermes dashboard's /api/* routes require its session token; start.sh
// spawns the dashboard with HERMES_DASHBOARD_SESSION_TOKEN set to this file's
// value, so the gate can inject "Authorization: Bearer <token>" when it proxies
// /hermes -- otherwise the SPA's API calls 401 and the UI shows "gateway failed
// to load". Read once at boot; absent -> no header (dashboard falls back to its
// own random token and the API stays 401, same as before this fix).
const HERMES_DASH_TOKEN = (() => {
  try { return fs.readFileSync(path.join(AGENTHOST_DIR, "hermes-dashboard.token"), "utf8").trim() || null; }
  catch { return null; }
})();
function hermesUsage(sessionId) {
  return new Promise((resolve) => {
    if (!sessionId) return resolve(null);
    const py = [
      "import sqlite3,sys,json",
      "sid=sys.argv[1]",
      "try:",
      " c=sqlite3.connect('file:%s?mode=ro'%sys.argv[2],uri=True)",
      " r=c.execute('select input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,estimated_cost_usd,cost_status from sessions where id=?',(sid,)).fetchone()",
      " print(json.dumps(None) if not r else json.dumps({'in':r[0]or 0,'out':r[1]or 0,'cr':r[2]or 0,'cw':r[3]or 0,'cost':r[4],'cs':r[5]}))",
      "except Exception:",
      " print('null')",
    ].join("\n");
    let out = "";
    try {
      const p = spawn("python3", ["-c", py, sessionId, HERMES_DB], { env: process.env });
      p.stdout.on("data", (c) => { out += c.toString(); });
      p.on("error", () => resolve(null));
      p.on("close", () => {
        try {
          const j = JSON.parse(out.trim() || "null");
          if (!j) return resolve(null);
          resolve({ inputTokens: (j.in || 0) + (j.cr || 0) + (j.cw || 0), outputTokens: j.out || 0, costUsd: (j.cs === "actual" || j.cs === "estimated") ? j.cost : null, plan: "plan" });
        } catch { resolve(null); }
      });
    } catch { resolve(null); }
  });
}

// Legal boxes install to the phone home screen under the lawyer-facing name
// and paper background; dev keeps the terminal-dark identity.
const MANIFEST = JSON.stringify({
  name: BRAND === "legal" ? "Legal Skills HQ" : "AgentHost",
  short_name: BRAND === "legal" ? "Legal HQ" : "AgentHost",
  start_url: "/",
  scope: "/",
  display: "fullscreen",
  background_color: BRAND === "legal" ? "#FBFAF7" : "#0B0D10",
  theme_color: BRAND === "legal" ? "#FBFAF7" : "#0B0D10",
  icons: [
    { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
  ],
});

// The appshell script is deliberately NOT deferred: it must run before ttyd's
// own bundle so its WebSocket wrapper is installed before ttyd connects.
const PWA_HEAD_TAGS = `
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/icons/icon-192.png">
<meta name="theme-color" content="#0B0D10">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="${BRAND === "legal" ? "Legal HQ" : "AgentHost"}">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<script src="/agenthost-appshell.js?v=4"></script>
<script defer src="/agenthost-nav.js?v=1"></script>
`;

// Static assets served directly by the gate, no auth required for the app
// shell itself (only the terminal content behind the cookie gate is private).
// Read once at startup; these files never change without a redeploy.
// A missing OPTIONAL asset (stylesheet) must degrade to an unstyled page, never
// crash the gate at boot -- an image built without theme.css took the whole box
// down (502) on 2026-07-11 because this readFileSync threw at module load.
function optionalAsset(name) {
  try { return fs.readFileSync(path.join(ASSET_DIR, name)); }
  catch { console.error(`[gate] ${name} not found; serving empty body`); return Buffer.alloc(0); }
}
const STATIC_ROUTES = {
  "/manifest.webmanifest": { type: "application/manifest+json", body: Buffer.from(MANIFEST) },
  "/theme.css": { type: "text/css", body: optionalAsset("theme.css") },
  "/agenthost-appshell.js": { type: "application/javascript", body: fs.readFileSync(path.join(ASSET_DIR, "appshell.js")) },
  "/agenthost-nav.js": { type: "application/javascript", body: Buffer.from(NAV_JS) },
  "/apps.json": { type: "application/json", body: Buffer.from(APPS_JSON) },
  "/icons/icon-192.png": { type: "image/png", body: fs.readFileSync(path.join(ASSET_DIR, "icons", "icon-192.png")) },
  "/icons/icon-512.png": { type: "image/png", body: fs.readFileSync(path.join(ASSET_DIR, "icons", "icon-512.png")) },
};

// Service worker gets its own route (not STATIC_ROUTES) so it can carry the
// Service-Worker-Allowed header that lets a script served from /sw.js control
// the whole "/" scope. Optional: 404s if the file wasn't shipped.
let SW_JS = null;
try { SW_JS = fs.readFileSync(path.join(ASSET_DIR, "sw.js")); }
catch { console.error("[gate] sw.js not found; GET /sw.js will 404"); }

// Login screen. When 2FA is enrolled (a 2fa.secret file exists on the volume)
// the form also asks for the 6-digit authenticator code -- revealing that 2FA
// is on is standard (every login page with a code field does), and the code
// input is what makes autocomplete=one-time-code work on phones.
// Login is the front door and the first impression: full theme.css treatment
// (served pre-auth via STATIC_ROUTES), entrance animation, error shake when
// the redirect carried ?e=1 (bad key/code), caret-blink wordmark. Semantics
// unchanged: same ?key= / &code= submit, same autocomplete hints.
function loginHtml(show2fa, failed) {
  const codeField = show2fa
    ? `<input id="c" class="ah-input" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="6-digit code" autocomplete="one-time-code" style="margin-top:10px">`
    : "";
  const submit = show2fa
    ? "location='/?key='+encodeURIComponent(k.value)+'&code='+encodeURIComponent(c.value);return false"
    : "location='/?key='+encodeURIComponent(k.value);return false";
  // Legal brand: the site-legal header wordmark ("LEGAL SKILLS HQ", bronze HQ,
  // sans/navy -- site-legal/index.html .brand) and a lawyer-facing tagline.
  // Dev keeps the caret wordmark. Semantics identical either way.
  const wordmark = BRAND === "legal"
    ? `<div class="mark hqmark">LEGAL SKILLS <span class="hq">HQ</span></div>`
    : `<div class="mark">agenthost<span class="caret">▮</span></div>`;
  const tagline = BRAND === "legal" ? "your private legal workspace" : "your agent never sleeps";
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${BRAND === "legal" ? "Legal Skills HQ" : "AgentHost"}</title>${PWA_HEAD_TAGS}<link rel="stylesheet" href="/theme.css">
<style>
  body { display: flex; align-items: center; justify-content: center; min-height: 100vh; min-height: 100svh; }
  .card { padding: 30px 28px; width: min(340px, 88vw); }
  .mark { display: flex; align-items: baseline; gap: 2px; color: var(--ink); font-size: 16px; font-weight: 600;
    margin-bottom: 4px; letter-spacing: .01em; }
  .mark .caret { color: var(--accent); animation: blink 1.15s steps(1) infinite; }
  .mark.hqmark { gap: 5px; font: 700 15px/1 var(--sans); letter-spacing: .06em; color: var(--accent); }
  .mark .hq { color: var(--bronze, #8C6A3F); }
  @keyframes blink { 50% { opacity: 0; } }
  .tag { color: var(--ink-3); font-size: 12.5px; margin: 0 0 18px; }
  .err-note { color: var(--err); font-size: 12.5px; margin: 10px 0 0; display: ${failed ? "block" : "none"}; }
  @media (prefers-reduced-motion: reduce) { .mark .caret { animation: none; } }
</style>
<body>
<form class="card ah-glass ah-rise${failed ? " ah-shake" : ""}" onsubmit="${submit}">
  ${wordmark}
  <p class="tag">${tagline}</p>
  <input id="k" class="ah-input" type="password" placeholder="access key" autocomplete="current-password">${codeField}
  <button class="ah-btn ah-btn-primary" style="width:100%;margin-top:12px">unlock</button>
  <p class="err-note">that didn't unlock — check the ${show2fa ? "key and code" : "key"} and try again</p>
</form></body>`;
}

function authed(req) {
  return (req.headers.cookie || "").split(/;\s*/).includes(`${COOKIE}=${COOKIE_VALUE}`);
}

// ---- chat: message-thread view over `claude -p` -----------------------------
// One message at a time (the -p runs share the box's CPU with the tmux agent);
// messages are passed as argv, never through a shell. AGENT_CHAT_BIN exists so
// tests can substitute a fake agent binary.
const CHAT_HTML = Buffer.from(brandHtml(fs.readFileSync(path.join(ASSET_DIR, "chat.html"), "utf8")));
const CHAT_BIN = process.env.AGENT_CHAT_BIN || "claude";
const CHAT_CWD = path.join(process.env.HOME || "/data/home/agent", "work");
const CHAT_RUN_TIMEOUT_MS = 12 * 60 * 1000; // a hung chat must free the slot, not wedge it

// ---- engine registry: the multiagent gateway --------------------------------
// The chat thread can run more than one AI. Each ENGINE knows how to spawn a
// one-shot turn for its CLI; everything else in runChat (streaming, the busy
// slot, the timeout/kill, cancel-on-disconnect) is engine-agnostic and reused
// untouched. Adding an engine is a new entry here, not a fork of runChat.
//
//   bin/args(prompt, sessionId): the spawn. sessionId is null on the first turn
//     of a thread and the engine's own id afterward (resume/continuity).
//   cwd: where to run it.
//   sessionFrom(stdout, stderr): pull the engine's session id out of a finished
//     run so the NEXT turn can resume it (null if the engine keys continuity
//     another way, e.g. Claude by cwd).
//   clean(chunk): strip engine noise from a stdout chunk before it streams to
//     the browser (Hermes prepends a toolset warning line).
//   sigterm: true for engines a plain SIGTERM stops; Claude's -p daemon needs
//     SIGKILL, so it stays false (matches the pre-gateway behavior exactly).
//
// Claude is the DEFAULT and its entry reproduces the old code path byte-for-
// byte (agentSpawnArgs + CHAT_CWD + cwd-keyed -c continuity), so an
// engine-less turn behaves exactly as before the gateway.
const ENGINES = {
  claude: {
    label: "claude",
    bin: CHAT_BIN,
    // Claude keys conversations by cwd and continues with -c; sessionId is
    // unused (continuity is the cwd store). withContinue passes through so the
    // first-message retry-without-continue logic still applies. --output-format
    // stream-json + --include-partial-messages makes claude emit a JSONL event
    // stream WITH incremental text_delta chunks (verified on the box), so the
    // reply still types out token-by-token; the final `result` event carries
    // usage + total_cost_usd for the tracker. stream-json requires --verbose.
    // Built ON TOP of agentSpawnArgs so the hooks-disabled speed fix is
    // preserved; cron keeps calling agentSpawnArgs directly for plain text.
    args: (prompt, _sid, withContinue) =>
      [...agentSpawnArgs(prompt, withContinue), "--output-format", "stream-json", "--include-partial-messages", "--verbose"],
    cwd: CHAT_CWD,
    sessionFrom: () => null,
    makeState: () => ({ usage: null, streamed: false }),
    // Each stdout line is a claude stream-json event. Stream the incremental
    // text_delta chunks (content_block_delta) so the reply types out; SKIP the
    // full `assistant` events (the deltas already carried that text -- emitting
    // both would double it). Capture the `result` event's usage. If no delta
    // ever streamed (partial messages absent for some reason), fall back to the
    // final assistant text so a reply is never lost. signature_delta / other
    // events and non-JSON lines are dropped.
    lineTransform: (line, state) => {
      const s = line.trim();
      if (!s) return "";
      let e;
      try { e = JSON.parse(s); } catch { return ""; }
      if (e.type === "stream_event" && e.event && e.event.type === "content_block_delta") {
        const d = e.event.delta || {};
        if (d.type === "text_delta" && d.text) { if (state) state.streamed = true; return d.text; }
        return "";
      }
      if (e.type === "assistant" && e.message && Array.isArray(e.message.content)) {
        // Fallback only: deltas already streamed this text unless none arrived.
        if (state && state.streamed) return "";
        return e.message.content.filter((b) => b.type === "text").map((b) => b.text || "").join("");
      }
      if (e.type === "result" && state) {
        state.usage = { raw: e.usage || null, costUsd: e.total_cost_usd };
      }
      return "";
    },
    usageFrom: (state) => {
      const u = state && state.usage;
      if (!u || !u.raw) return null;
      const r = u.raw;
      // Total input = fresh + cache (cache reads/creates still count against the
      // window); output is output_tokens. Cost is the real per-turn USD claude
      // reports (subscription-covered, shown as tokens-first per the UI).
      const inTok = (r.input_tokens || 0) + (r.cache_creation_input_tokens || 0) + (r.cache_read_input_tokens || 0);
      return { inputTokens: inTok, outputTokens: r.output_tokens || 0, costUsd: u.costUsd, plan: "sub" };
    },
    clean: (s) => s,
    sigterm: false,
    keyedByCwd: true, // continuity is cwd-based, not a session id we carry
    // First-message retry drops -c and re-runs -- meaningful ONLY for Claude,
    // whose argv actually changes without -c. See attempt()'s retry guard.
    canRetryContinue: true,
    lineBuffered: true,
  },
  hermes: {
    label: "hermes",
    bin: path.join(HOME_DIR, ".local/bin/hermes"),
    // `hermes chat -q <msg> -Q` = one quiet non-interactive turn; -r <id>
    // resumes the thread's session; --source tool hides gateway turns from
    // Steve's own `hermes sessions` list. Verified live on the box 2026-07-17.
    args: (prompt, sid) => {
      const a = ["chat", "-q", prompt, "-Q", "--source", "tool"];
      if (sid) a.push("-r", sid);
      return a;
    },
    cwd: HOME_DIR,
    // -Q prints "session_id: <YYYYMMDD_HHMMSS_hex>" to stderr (last match wins).
    sessionFrom: (_out, err) => {
      const m = /session_id:\s*([0-9]{8}_[0-9]{6}_[0-9a-f]+)/.exec(err || "");
      return m ? m[1] : null;
    },
    // Strip the known toolset warning Hermes prepends to stdout so it never
    // shows in a chat bubble. Applied to WHOLE lines only (the caller buffers
    // to line boundaries), so a warning split across stdout chunks can't leak.
    clean: (s) => s.replace(/^Warning: Unknown toolsets:.*\r?\n/gm, ""),
    sigterm: true,
    keyedByCwd: false,
    // Hermes's argv ignores withContinue, so the -c-drop retry would just re-run
    // the identical command -- pointless. No retry.
    canRetryContinue: false,
    // Buffer stdout to whole lines so the warning-line strip can't be defeated
    // by a chunk boundary landing mid-warning.
    lineBuffered: true,
    // Hermes prints no tokens per turn; they're recorded in its SQLite session
    // store (~/.hermes/state.db, `sessions` row) AFTER the turn. Read it by the
    // session id via a tiny python3 query (the gate keeps no sqlite dep; python3
    // ships in the image). Async; the exit handler awaits it best-effort.
    usageAsync: (sessionId) => hermesUsage(sessionId),
  },
  codex: {
    label: "codex",
    bin: "codex",
    // `codex exec --json` runs one non-interactive turn and emits a JSONL event
    // stream. --sandbox read-only = the model answers but can't edit files or
    // run write commands (guarantees a text-only chat turn). --skip-git-repo-
    // check + -C $HOME because turns run in $HOME, not a git repo. --color never
    // keeps ANSI bytes out of the JSONL. `--` ends flags so a prompt starting
    // with '-' isn't parsed as one. Resume passes the same flags + `resume
    // <thread_id>` (flags belong to `exec`, before the resume subcommand -- the
    // one ordering that worked live). Verified on the box 2026-07-17.
    args: (prompt, sid) => {
      const flags = ["exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check", "-C", HOME_DIR, "--color", "never"];
      if (sid) return [...flags, "resume", sid, "--", prompt];
      return [...flags, "--", prompt];
    },
    cwd: HOME_DIR,
    // codex hangs on a non-TTY stdin with no writer (issue #20919): it waits to
    // append stdin to the prompt. "ignore" gives the child no stdin at all --
    // the spawn equivalent of `< /dev/null` -- so it never blocks.
    stdin: "ignore",
    // Per-run state: thread id (from stdout) for sessionFrom, and the usage
    // block (from turn.completed) for usageFrom.
    makeState: () => ({ threadId: null, usage: null }),
    // Each stdout line is one JSON event. Emit ONLY the assistant text
    // (item.completed / agent_message); capture thread.started's id and
    // turn.completed's usage; drop every other event (reasoning, tool calls). A
    // non-JSON line (shouldn't happen with --json) is dropped, not streamed raw.
    lineTransform: (line, state) => {
      const s = line.trim();
      if (!s) return "";
      let e;
      try { e = JSON.parse(s); } catch { return ""; }
      if (e.type === "thread.started" && e.thread_id && state) state.threadId = e.thread_id;
      if (e.type === "turn.completed" && e.usage && state) state.usage = e.usage;
      if (e.type === "item.completed" && e.item && e.item.type === "agent_message") {
        return e.item.text || "";
      }
      return "";
    },
    // input = fresh + cached input; Codex is ChatGPT-plan (subscription), so cost
    // is tokens against quota -- no per-turn $ reported.
    usageFrom: (state) => {
      const u = state && state.usage;
      if (!u) return null;
      return { inputTokens: (u.input_tokens || 0) + (u.cached_input_tokens || 0), outputTokens: u.output_tokens || 0, costUsd: null, plan: "plan" };
    },
    sessionFrom: (_out, _err, state) => (state && state.threadId) || null,
    // Don't cache a thread id if Codex couldn't write its rollout (permission
    // or disk error): resuming it later would fail with "no rollout found".
    sessionValid: (err) => !/failed to record rollout/i.test(err || ""),
    // A resume against a session whose rollout is gone -> drop the cached id and
    // start fresh next turn (self-healing after a poisoned or pruned session).
    deadSession: (err) => /no rollout found for thread id/i.test(err || ""),
    clean: (s) => s,
    sigterm: true,
    keyedByCwd: false,
    canRetryContinue: false,
    lineBuffered: true,
  },
};
// hasOwnProperty, not `ENGINES[id] ||`: a plain object inherits Object.prototype,
// so ENGINES["constructor"]/["toString"] would return an inherited function --
// truthy but not a real engine -- and a crafted ?engine=constructor would then
// throw on .args/.bin and leak the busy slot. Own-keys only; unknown -> claude.
function resolveEngine(id) {
  return Object.prototype.hasOwnProperty.call(ENGINES, id) ? ENGINES[id] : ENGINES.claude;
}

// Per-thread session ids for engines that carry continuity by id (Hermes,
// later Codex). Keyed by engine id; the chat is a single thread per box, so a
// flat map is enough. Claude is cwd-keyed and never appears here.
const engineSessions = Object.create(null);

// Single busy flag shared by chat and cron: only one `claude -p` runs at a
// time (they share the box's CPU with the tmux agent). Tokens guard against a
// stale release -- e.g. a chat response's close event firing after its run
// already finished and a queued cron run has taken the slot.
let agentBusy = false;
let agentRunToken = 0;
let agentBusySince = 0;
let agentBusyKind = null; // "chat" | "cron" -- what holds the slot, for queue status lines

function acquireAgent(kind) { agentBusy = true; agentBusyKind = kind || "chat"; agentBusySince = Date.now(); return ++agentRunToken; }
function releaseAgent(token) {
  if (token !== agentRunToken) return; // a newer run owns the flag now
  agentBusy = false;
  agentBusyKind = null;
  setImmediate(dispatchAgentSlot);
}

// Chat streams waiting for the busy slot (busy visibility, chat speed part 1).
// A message that arrives mid-run used to be REJECTED with an error; now it
// waits its turn -- the client already got a "status" SSE line saying so.
// Chat wins over queued cron work when the slot frees (a human is watching the
// thread; a scheduled job only cares that it runs, not when to the second).
// The concurrency model is unchanged: still exactly one agent run at a time.
const chatWaiters = [];
function dispatchAgentSlot() {
  if (agentBusy) return;
  const w = chatWaiters.shift();
  if (w) return w.run();
  drainCronQueue();
}

// Watchdog: the busy slot must NEVER wedge permanently. If a child ignores
// SIGTERM (claude spawns a persistent daemon that can outlive a killed -p) or
// a release path is ever missed, the slot would stay busy forever and every
// chat message would come back "agent is busy" -- a blinking cursor that never
// answers. This is the airtight backstop: past the hard ceiling, force the slot
// open by bumping the token (so the wedged run's late release is ignored) and
// let queued cron work drain. Chat/cron runs finish far inside this window.
const AGENT_HARD_MAX_MS = 16 * 60 * 1000; // just above cron's 15m run timeout
setInterval(function () {
  if (agentBusy && Date.now() - agentBusySince > AGENT_HARD_MAX_MS) {
    console.error(`[gate] agent slot held ${Math.round((Date.now() - agentBusySince) / 1000)}s; force-releasing (watchdog)`);
    agentRunToken++;   // invalidate the wedged run's token so its later release is a no-op
    agentBusy = false;
    agentBusyKind = null;
    setImmediate(dispatchAgentSlot);
  }
}, 30 * 1000).unref();

function sse(res, event, data) {
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function runChat(msg, useContinue, res, allowRetry, token, engine, tzOffsetMin) {
  const eng = engine || ENGINES.claude;
  let active = null;      // the child running right now (reassigned on retry)
  let clientGone = false;
  // Per-run engine state (Codex accumulates its thread id from the JSON stream
  // here). One state for the whole run so it survives a retry.
  const state = eng.makeState ? eng.makeState() : null;

  function attempt(withContinue, retryAllowed) {
    // Each engine builds its own argv; Claude's path runs the one-shot with
    // hooks disabled (the chat-speed fix; see agentSpawnArgs). sessionId lets
    // id-keyed engines (Hermes/Codex) resume the thread across turns.
    const sid = eng.keyedByCwd ? null : engineSessions[eng.label];
    // stdin "ignore" for engines that hang on an open-but-writerless pipe
    // (Codex); default inherit otherwise (unchanged for claude/hermes).
    const stdio = eng.stdin === "ignore" ? ["ignore", "pipe", "pipe"] : undefined;
    const child = spawn(eng.bin, eng.args(msg, sid, withContinue), { cwd: eng.cwd, env: process.env, stdio });
    active = child;
    let sentAny = false;
    let stderrTail = "";
    let stderrAll = "";   // full stderr for session-id capture (tail is only 500b)
    // A chat run that hangs must not hold the slot forever (cron already has
    // this; chat did not -- a wedged `-c` resume was the "blinking cursor"). Kill
    // the child past the ceiling; its exit handler then frees the slot and tells
    // the phone what happened. The watchdog above is the last resort if even the
    // kill doesn't take.
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill("SIGKILL"); } catch {} }, CHAT_RUN_TIMEOUT_MS);
    timer.unref();
    // stdout piping. All three engines are now lineBuffered (each emits a JSON
    // event stream -- claude/codex JSONL, hermes a warning-prefixed line): buffer
    // to newline boundaries and run each complete line through the engine's
    // lineTransform (which streams the incremental reply text and captures usage/
    // session id), holding the partial trailing line until more arrives (flushed
    // on exit). A plain-text engine (none today) with no lineTransform would fall
    // back to streaming raw chunks via clean().
    let stdoutPartial = "";
    function emitStdout(text) { if (text) { sentAny = true; sse(res, null, text); } }
    // Per-line handler: engine.lineTransform(line, state) -> display text ("" to
    // drop). Codex defines it (JSON parse, stashes thread id in state); Hermes
    // falls back to clean() on the line.
    function transformLine(line) {
      if (eng.lineTransform) return eng.lineTransform(line, state);
      return eng.clean(line);
    }
    child.stdout.on("data", (chunk) => {
      const raw = chunk.toString();
      if (!eng.lineBuffered) { emitStdout(eng.clean(raw)); return; }
      stdoutPartial += raw;
      let nl;
      while ((nl = stdoutPartial.indexOf("\n")) !== -1) {
        const line = stdoutPartial.slice(0, nl + 1);   // includes the newline
        stdoutPartial = stdoutPartial.slice(nl + 1);
        emitStdout(transformLine(line));
      }
    });
    child.stderr.on("data", (chunk) => {
      const s = chunk.toString();
      stderrAll += s;
      stderrTail = (stderrTail + s).slice(-500);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      releaseAgent(token);
      if (clientGone) return;
      sse(res, "done", { error: `could not start agent (${e.code || e.message})` });
      res.end();
    });
    child.on("exit", (code, sig) => {
      clearTimeout(timer);
      // First-ever message: Claude's -c fails when there is no conversation to
      // continue. Retry once without it rather than surfacing a confusing
      // error. Gated to engines whose argv actually changes without continue
      // (canRetryContinue) -- Hermes ignores withContinue, so a retry would
      // re-run the identical command. Never retry a run the CLIENT killed
      // (sig/clientGone): resurrecting it would run outside the busy flag.
      if (eng.canRetryContinue && code !== 0 && !sig && !clientGone && !timedOut && withContinue && !sentAny && retryAllowed) {
        return attempt(false, false); // same token, same close handler (no leak)
      }
      // Flush the buffered final line (a lineBuffered engine's answer usually
      // ends without a trailing newline). Through transformLine, NOT clean() --
      // for Codex clean() is identity, so flushing a trailing partial JSON line
      // raw would dump JSON into the chat; transformLine parses it. After the
      // retry check so a retried run never emits attempt-1's leftover; before
      // "done" so it reaches the browser as content, not after the stream closes.
      if (eng.lineBuffered && stdoutPartial && !clientGone) {
        emitStdout(transformLine(stdoutPartial));
        stdoutPartial = "";
      }
      releaseAgent(token);
      if (timedOut && !clientGone) {
        sse(res, "done", { error: "agent took too long and was stopped -- try a shorter ask, or check the terminal tab" });
        res.end();
        return;
      }
      if (clientGone) {
        // The phone closed the tab mid-run; res is dead so we can't stream, but a
        // web-push tells that phone the run it kicked off actually finished.
        try { sendToAllSubs({ title: "AgentHost", body: "Your agent finished." }); } catch {}
        return;
      }
      if (code === 0) {
        // Remember the engine's session id so the NEXT turn resumes this thread
        // (id-keyed engines only; Claude keeps continuity by cwd). Hermes reads
        // it from stderr; Codex from the per-run state (stashed by lineTransform).
        // Only persist a session the engine could actually PERSIST -- Codex logs
        // "failed to record rollout items" to stderr when it can't write its
        // rollout, and caching that thread id would make every later turn try to
        // resume a session with no rollout (the poisoned-cache bug).
        let sessionId = null;
        if (!eng.keyedByCwd) {
          sessionId = eng.sessionFrom(null, stderrAll, state);
          const ok = !eng.sessionValid || eng.sessionValid(stderrAll);
          if (sessionId && ok) engineSessions[eng.label] = sessionId;
        }
        // Capture this turn's token usage and finish. Claude/Codex report it
        // synchronously (from the JSON stream, via usageFrom(state)); Hermes
        // records it to its SQLite store, read async by session id. Either way:
        // accumulate into today's per-engine total and put the per-turn tokens
        // on the "done" event so a bubble can show "· 4.1K tok". Best-effort --
        // usage capture never blocks or fails the reply.
        const finishDone = (usage) => {
          if (usage) recordUsage(eng.label, usage, tzOffsetMin);
          const done = { engine: eng.label };
          if (usage) done.usage = { in: usage.inputTokens || 0, out: usage.outputTokens || 0, cost: Number.isFinite(usage.costUsd) ? usage.costUsd : null };
          sse(res, "done", done);
          res.end();
        };
        if (eng.usageAsync) {
          eng.usageAsync(sessionId).then(finishDone).catch(() => finishDone(null));
        } else {
          finishDone(eng.usageFrom ? eng.usageFrom(state) : null);
        }
        return;
      } else {
        // A resume against a vanished session ("no rollout found") means the
        // cached id is dead -- drop it so the NEXT turn starts a fresh session
        // instead of resuming the dead one forever (self-healing).
        if (!eng.keyedByCwd && eng.deadSession && eng.deadSession(stderrAll)) {
          delete engineSessions[eng.label];
        }
        sse(res, "done", { error: `agent exited ${code}${stderrTail ? ": " + stderrTail.trim() : ""}` });
      }
      res.end();
    });
  }

  // ONE close handler for the whole run, always aimed at the CURRENT child via
  // `active`. Attaching it per-attempt (the old bug) left a retry with two
  // handlers: the first, seeing its exited child, freed the slot while the retry
  // child was still alive -- letting a queued cron run start concurrently. The
  // busy flag is released by the exit handler AFTER the child actually dies.
  res.on("close", () => {
    clientGone = true;
    if (active && active.exitCode === null) {
      // `claude -p` is backed by a persistent daemon and often IGNORES SIGTERM,
      // so a phone closing the tab mid-reply left the child alive and the slot
      // wedged "busy" forever (the blinking-cursor recurrence). SIGKILL can't be
      // ignored -> the child dies -> its exit handler frees the slot. Engines
      // that stop on a clean SIGTERM (Hermes) get one so they can shut down
      // their own turn tidily; Claude stays SIGKILL.
      active.kill(eng.sigterm ? "SIGTERM" : "SIGKILL");
    }
    // Belt-and-suspenders: free the slot within a few seconds no matter what.
    // If the exit handler already released, the token check makes this a no-op;
    // if the kill somehow produced no exit event, the slot still frees promptly
    // instead of waiting on the 16-minute watchdog.
    setTimeout(() => releaseAgent(token), 3000).unref();
  });

  attempt(useContinue, allowRetry);
}

// ---- brain search: /brain <q> greps the user's knowledge base, then hands the
// hits to `claude -p` for a cited summary. Reuses runChat's SSE shape and the
// shared busy flag, so a brain query is just another one-at-a-time agent run.
const BRAIN_RG_CAP = 32 * 1024;
// OneDrive is skipped as a WHOLESALE root (it holds gigabytes of non-knowledge
// files); the Obsidian vault nested inside it IS a first-class knowledge root
// (added to `fixed` below), so the shared brain -- 2000+ notes synced from the
// operator's desktop -- is searchable by every engine.
const BRAIN_SKIP = new Set([".claude", ".hermes", "work", "OneDrive"]);
function brainIsNodeish(name) {
  return name === "node_modules" || name === ".npm" || name === ".nvm" ||
         name === ".node-gyp" || name === ".cache" || name === ".yarn" || name === ".pnpm-store";
}
// Roots: the known harness knowledge locations that actually exist, plus every
// top-level dir under HOME that isn't a harness/work/node dir -- that's where
// --include'd "brains" land (HOME/<name>).
function brainRoots() {
  const HOME = process.env.HOME || "/data/home/agent";
  const out = [];
  const fixed = [
    path.join(HOME, ".claude", "skills"),
    path.join(HOME, ".claude", "memories"),
    path.join(HOME, ".claude", "CLAUDE.md"),
    path.join(HOME, ".hermes", "memories"),
    path.join(HOME, ".hermes", "SOUL.md"),
    // The shared Obsidian vault, synced onto the box via OneDrive. This is the
    // communal brain: the same notes the operator's desktop reads/writes, now
    // searchable by every engine in the chat.
    path.join(HOME, "OneDrive", "Documents", "Obsidian Vault"),
  ];
  for (const p of fixed) { try { fs.accessSync(p); out.push(p); } catch {} }
  try {
    for (const ent of fs.readdirSync(HOME, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      // Never auto-grep hidden dirs: ~/.ssh, ~/.aws, ~/.gnupg, ~/.config etc.
      // hold credentials, and brain search streams hits to the model + client.
      // The real knowledge dot-dirs (.claude/skills, .hermes/memories) are added
      // explicitly in `fixed` above; brains land at HOME/<name> with no dot.
      if (ent.name.startsWith(".")) continue;
      if (BRAIN_SKIP.has(ent.name) || brainIsNodeish(ent.name)) continue;
      out.push(path.join(HOME, ent.name));
    }
  } catch {}
  return out;
}

function brainPrompt(query, hits) {
  return "Here are grep hits from my knowledge base for '" + query + "':\n" +
    hits + "\n\n" +
    "Summarize what my notes say about this in <=200 words; cite the file names. " +
    "If the hits are empty, say so plainly.";
}

function runBrain(query, res, token, eng, tzOffsetMin) {
  const roots = brainRoots();
  // No roots to search: skip rg, ask the agent to summarize an empty hit set.
  if (roots.length === 0) return runChat(brainPrompt(query, ""), false, res, false, token, eng, tzOffsetMin);
  // Grep KEYWORDS, not the sentence (task #34): tokenize the question, OR the
  // content terms (-e per term), match case-insensitively and literally (-F --
  // the query is untrusted input, never a regex). An all-stopword query falls
  // back to the raw text so "/brain todo" -like one-worders still work.
  const terms = tokenizeBrainQuery(query);
  const patterns = terms.length ? terms : [query];
  const rgArgs = ["-i", "-F", "--no-heading", "--line-number", "-m", "5"];
  for (const p of patterns) rgArgs.push("-e", p);
  rgArgs.push("--", ...roots);
  let rg;
  // argv only, never a shell string -- the query is untrusted user input.
  try { rg = spawn("rg", rgArgs, { env: process.env }); }
  catch { return runChat(brainPrompt(query, ""), false, res, false, token, eng, tzOffsetMin); }
  let hits = "";
  let capped = false;
  let handed = false;
  const hand = (text) => {
    if (handed) return;
    handed = true;
    // Rank multi-term lines to the top, but hand the ORIGINAL question to the
    // summarizer -- it needs the user's intent, not the keyword list. The
    // summary runs on the engine the user picked (unified brain: any engine can
    // answer from the same shared knowledge).
    runChat(brainPrompt(query, rankBrainHits(text, terms)), false, res, false, token, eng, tzOffsetMin);
  };
  rg.stdout.on("data", (c) => {
    if (capped) return;
    hits += c.toString();
    if (hits.length > BRAIN_RG_CAP) { hits = hits.slice(0, BRAIN_RG_CAP); capped = true; try { rg.kill("SIGTERM"); } catch {} }
  });
  rg.stderr.on("data", () => {}); // rg warns on unreadable paths; ignore, hits still stream
  rg.on("error", () => hand(""));  // rg missing / failed to spawn -> summarize nothing
  rg.on("exit", () => hand(hits)); // exit 1 means "no matches" -> empty hits, which is fine
  // Phone bailed during the grep phase (before runChat owns the close handler):
  // stop rg and free the slot so a queued cron run isn't blocked.
  res.on("close", () => {
    if (handed) return;
    handed = true;
    try { rg.kill("SIGTERM"); } catch {}
    releaseAgent(token);
  });
}

// Kick off the agent run for one chat message. Called either straight from
// the stream handler (slot free) or later by dispatchAgentSlot (slot was busy
// and this message waited). Validation already happened before queueing.
function startChatRun(msg, req, res, engineId, tzOffsetMin) {
  const eng = resolveEngine(engineId);
  if (msg.startsWith("/brain ")) {
    const query = msg.slice(7).trim();
    // Engine rides audit()'s own `eng` field, not a string prefix on detail:
    // a prefix baked into detail could be forged by typing e.g. "/brain
    // hermes: gateway config" on Claude, which the Command Center feed would
    // then misread as a Hermes run (detail is untrusted user text; a
    // structured field can't collide with it).
    audit("brain_run", query.slice(0, 80), req, eng.label);
    // Unified brain: the grep is engine-agnostic; the cited summary runs on the
    // engine the user picked, so any engine answers from the same knowledge.
    runBrain(query, res, acquireAgent("chat"), eng, tzOffsetMin);
    return;
  }
  audit("chat_run", null, req, eng.label);
  runChat(msg, true, res, true, acquireAgent("chat"), eng, tzOffsetMin);
}

// The slot is busy: tell the phone IMMEDIATELY (a silent wait reads as broken),
// then hold the open SSE stream in line until the slot frees. The status line
// names what holds the slot -- waiting on your own previous message feels very
// different from waiting on a scheduled job.
function queueChatRun(msg, req, res, engineId, tzOffsetMin) {
  const holder = agentBusyKind === "cron" ? "a scheduled job is running" : "another chat message is finishing";
  sse(res, "status", { text: `agent is busy — ${holder}; your message is queued`, holder: agentBusyKind || "chat" });
  // SSE comment heartbeat: the wait can span minutes (a cron run may hold the
  // slot up to 15m) and idle proxies kill quiet connections. Comments are
  // invisible to EventSource.
  const hb = setInterval(() => { try { res.write(":hb\n\n"); } catch {} }, 15 * 1000);
  hb.unref();
  const waiter = {
    run() { cleanup(); startChatRun(msg, req, res, engineId, tzOffsetMin); },
  };
  function cleanup() {
    clearInterval(hb);
    const at = chatWaiters.indexOf(waiter);
    if (at !== -1) chatWaiters.splice(at, 1);
  }
  chatWaiters.push(waiter);
  // Phone bailed while waiting: leave the line, never start the run. (Once the
  // run starts, runChat/runBrain install their own close handling; this extra
  // cleanup() is then a no-op.)
  res.on("close", cleanup);
}

function handleChat(req, res, url) {
  if (url.pathname === "/chat") {
    // no-cache: a phone that cached an old chat.html would keep a broken client
    // even after a redeploy. Revalidate every load so fixes land immediately.
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(CHAT_HTML);
    return true;
  }
  if (url.pathname === "/chat/stream") {
    const msg = (url.searchParams.get("msg") || "").slice(0, 8000);
    // Which engine answers this turn. Unknown/absent -> claude (the default),
    // so an old client that sends no engine behaves exactly as before.
    const engineId = url.searchParams.get("engine") || "claude";
    // Client's UTC offset in minutes east (from getTimezoneOffset() negated), so
    // "today" in the usage tracker resets at the user's local midnight. Absent ->
    // UTC. Clamped to a sane range.
    const tzRaw = Number(url.searchParams.get("tz"));
    const tzOffsetMin = Number.isFinite(tzRaw) && Math.abs(tzRaw) <= 900 ? tzRaw : 0;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    if (!msg.trim()) { sse(res, "done", { error: "empty message" }); return res.end(), true; }
    // Usage errors fail fast even when busy -- never queue a message that
    // could not run anyway.
    if (msg.startsWith("/brain ") && !msg.slice(7).trim()) {
      sse(res, "done", { error: "usage: /brain <what to search your notes for>" });
      return res.end(), true;
    }
    if (agentBusy) { queueChatRun(msg, req, res, engineId, tzOffsetMin); return true; }
    startChatRun(msg, req, res, engineId, tzOffsetMin);
    return true;
  }
  // Today's per-engine usage for the cost strip. ?tz=<offsetMin> picks the
  // client's local day (same convention as /chat/stream). Returns {day, engines:
  // {claude:{in,out,cost,turns}, ...}}. Empty object if nothing recorded yet.
  if (url.pathname === "/usage" && req.method === "GET") {
    const tzRaw = Number(url.searchParams.get("tz"));
    const tz = Number.isFinite(tzRaw) && Math.abs(tzRaw) <= 900 ? tzRaw : 0;
    const day = localDay(tz);
    const engines = (readUsage()[day]) || {};
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ day, engines }));
    return true;
  }
  return false;
}

// ---- cron: scheduled agent runs over `claude -p` ----------------------------
// Job cron expressions are UTC; the UI converts local times using tzOffsetMin
// (stored so the UI can re-render the job in the timezone it was created in).
// The scheduler evaluates pure UTC. Storage lives under the agent's HOME so it
// rides the persistent volume with the rest of the harness state.
const CRON_DIR = path.join(process.env.HOME || "/data/home/agent", ".claude", "agenthost", "cron");
const CRON_JOBS_FILE = path.join(CRON_DIR, "jobs.json");
const CRON_RUNS_DIR = path.join(CRON_DIR, "runs");
const CRON_ID_RE = /^[a-z0-9]{12}$/;
const CRON_OUTPUT_CAP = 64 * 1024;
const CRON_RUNS_KEPT = 20;
const CRON_MAX_JOBS = 200;
const CRON_RUN_TIMEOUT_MS = 15 * 60 * 1000; // a hung run must never brick the box
// Cron runs get a FRESH session in HOME, not CHAT_CWD: Claude Code keys
// conversations by cwd, and a cron run in ~/work would become the "latest"
// conversation there -- the next chat message's -c would then resume the
// cron session instead of the user's thread.
const CRON_CWD = process.env.HOME || "/data/home/agent";

let CRON_HTML = null;
try { CRON_HTML = Buffer.from(brandHtml(fs.readFileSync(path.join(ASSET_DIR, "cron.html"), "utf8"))); }
catch { console.error("[gate] cron.html not found; GET /cron will 404"); }

let cronJobs = [];
try {
  const parsed = JSON.parse(fs.readFileSync(CRON_JOBS_FILE, "utf8"));
  if (Array.isArray(parsed)) cronJobs = parsed.filter((j) => j && CRON_ID_RE.test(j.id));
} catch (e) {
  // Distinguish "first boot" from "jobs file corrupted" -- silent loss of
  // every schedule after a crash must at least leave a trace in the logs.
  if (e.code !== "ENOENT") console.error(`[gate] cron: could not load ${CRON_JOBS_FILE} (${e.message}); starting with no jobs`);
}

const cronQueued = new Set();    // job ids waiting for the agent to free up
const cronLastFired = new Map(); // job id -> "YYYY-MM-DDTHH:MM" UTC minute it last fired

function newCronId() {
  let id = "";
  while (id.length < 12) id += Math.random().toString(36).slice(2);
  return id.slice(0, 12);
}

function saveCronJobs() {
  fs.mkdirSync(CRON_DIR, { recursive: true });
  const tmp = CRON_JOBS_FILE + ".tmp";
  // fsync before the atomic rename: without it a host power-loss can journal
  // the rename but not the data blocks, leaving a truncated jobs.json.
  const fd = fs.openSync(tmp, "w");
  fs.writeSync(fd, JSON.stringify(cronJobs, null, 2));
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmp, CRON_JOBS_FILE);
}

function writeCronRun(jobId, startedAtMs, record) {
  if (!CRON_ID_RE.test(jobId)) return; // never build fs paths from an unvalidated id
  const dir = path.join(CRON_RUNS_DIR, jobId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${startedAtMs}.json`);
  fs.writeFileSync(file + ".tmp", JSON.stringify(record));
  fs.renameSync(file + ".tmp", file);
  // Prune by mtime, not filename: run files are named by START time, so a
  // long run's record can be "oldest" by name the moment it's written (its
  // skips accumulated newer names meanwhile) and filename-pruning would
  // delete the very record we just wrote.
  const stale = fs.readdirSync(dir)
    .filter((f) => /^\d+\.json$/.test(f))
    .map((f) => {
      try { return { f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }; }
      catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(CRON_RUNS_KEPT);
  for (const s of stale) { try { fs.unlinkSync(path.join(dir, s.f)); } catch {} }
}

function startCronRun(job) {
  const token = acquireAgent("cron");
  const startedAtMs = Date.now();
  let output = "";
  let truncated = false;
  let stderrTail = "";
  let done = false;
  const finish = (exit, error) => {
    if (done) return; // 'error' and 'exit' can both fire for one child
    done = true;
    const record = {
      startedAt: new Date(startedAtMs).toISOString(),
      ms: Date.now() - startedAtMs,
      exit,
      output: truncated ? output + "\n[output truncated at 64KB]" : output,
    };
    if (error) record.error = error;
    try { writeCronRun(job.id, startedAtMs, record); }
    catch (e) { console.error(`[gate] cron ${job.id}: could not write run record: ${e.message}`); }
    // Nudge the phone that a scheduled run landed. Never let a push break cron.
    try { sendToAllSubs({ title: "AgentHost", body: `${job.name} finished: ${exit === 0 && !error ? "ok" : "failed"}` }); } catch {}
    releaseAgent(token);
  };
  // Same spawn shape as runChat (agentSpawnArgs = hooks disabled, see the
  // builder's comment). CRON_CWD (not CHAT_CWD) and no -c: see the
  // session-pollution note above.
  audit("cron_run", job.name);
  const child = spawn(CHAT_BIN, agentSpawnArgs(job.prompt, false), { cwd: CRON_CWD, env: process.env });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { child.kill("SIGTERM"); } catch {}
  }, CRON_RUN_TIMEOUT_MS);
  timer.unref();
  child.stdout.on("data", (chunk) => {
    if (truncated) return;
    output += chunk.toString();
    if (output.length > CRON_OUTPUT_CAP) { output = output.slice(0, CRON_OUTPUT_CAP); truncated = true; }
  });
  child.stderr.on("data", (chunk) => { stderrTail = (stderrTail + chunk.toString()).slice(-500); });
  child.on("error", (e) => { clearTimeout(timer); finish(null, `could not start agent (${e.code || e.message})`); });
  child.on("exit", (code) => {
    clearTimeout(timer);
    if (timedOut) return finish(code, "timeout after 15m -- run killed so scheduled jobs and chat stay available");
    finish(code, code === 0 ? undefined : `agent exited ${code}${stderrTail ? ": " + stderrTail.trim() : ""}`);
  });
}

function drainCronQueue() {
  if (agentBusy) return;
  const id = cronQueued.values().next().value;
  if (id === undefined) return;
  cronQueued.delete(id);
  const job = cronJobs.find((j) => j.id === id);
  if (!job) return drainCronQueue(); // job was deleted while it waited
  startCronRun(job);
}

function cronTick() {
  dispatchAgentSlot(); // safety net: pick up waiting chat/cron work even if a release path was missed
  const now = new Date();
  const minute = now.toISOString().slice(0, 16); // UTC "YYYY-MM-DDTHH:MM"
  for (const job of cronJobs) {
    let due = false;
    try { due = cronMatches(job.cron, now); } catch { continue; } // bad expr: skip, never crash the gate
    if (!due || cronLastFired.get(job.id) === minute) continue;
    cronLastFired.set(job.id, minute);
    if (!agentBusy) { startCronRun(job); continue; }
    if (!cronQueued.has(job.id)) { cronQueued.add(job.id); continue; }
    // Already queued from an earlier miss: record the skip instead of stacking runs.
    try {
      writeCronRun(job.id, Date.now(), {
        startedAt: new Date().toISOString(), ms: 0, exit: null, output: "",
        error: "busy", skipped: true,
      });
    } catch (e) { console.error(`[gate] cron ${job.id}: could not write skip record: ${e.message}`); }
  }
}
setInterval(cronTick, 30 * 1000);

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function readJsonBody(req, res, cb) {
  const chunks = [];
  let size = 0;
  let over = false;
  req.on("data", (c) => {
    if (over) return;
    size += c.length;
    if (size > 64 * 1024) { over = true; sendJson(res, 400, { error: "body too large (64KB max)" }); req.destroy(); return; }
    chunks.push(c);
  });
  req.on("end", () => {
    if (over) return;
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { return sendJson(res, 400, { error: "body is not valid JSON" }); }
    if (typeof body !== "object" || body === null || Array.isArray(body)) return sendJson(res, 400, { error: "expected a JSON object" });
    cb(body);
  });
  req.on("error", () => {});
}

function validateCronJob(b) {
  if (typeof b.name !== "string" || !b.name.trim()) return "name is required";
  if (b.name.trim().length > 60) return "name must be 60 characters or fewer";
  if (typeof b.cron !== "string" || !b.cron.trim()) return "cron expression is required";
  try { parseCron(b.cron.trim()); } catch (e) { return e.message; }
  if (typeof b.prompt !== "string" || b.prompt.length < 1) return "prompt is required";
  if (b.prompt.length > 8000) return "prompt must be 8000 characters or fewer";
  if (!Number.isInteger(b.tzOffsetMin) || b.tzOffsetMin < -840 || b.tzOffsetMin > 840) return "tzOffsetMin must be an integer between -840 and 840";
  // Parseable-but-impossible expressions ("0 0 31 2 *") would show as jobs
  // that never fire; reject them here where the user can still fix the typo.
  try { if (!nextRun(b.cron.trim(), new Date())) return "this expression never matches a real date (checked 4 years ahead)"; } catch (e) { return e.message; }
  return null;
}

function cronJobWithNext(job, now) {
  let nextRunAt = null;
  try { const n = nextRun(job.cron, now); if (n) nextRunAt = n.toISOString(); } catch {}
  return { ...job, nextRunAt };
}

function handleCron(req, res, url) {
  if (url.pathname === "/cron" && req.method === "GET") {
    if (!CRON_HTML) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); res.end("cron ui not installed"); return true; }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(CRON_HTML);
    return true;
  }
  if (url.pathname === "/cron/jobs" && req.method === "GET") {
    const now = new Date();
    sendJson(res, 200, { jobs: cronJobs.map((j) => cronJobWithNext(j, now)), serverNow: now.toISOString() });
    return true;
  }
  if (url.pathname === "/cron/jobs" && req.method === "POST") {
    readJsonBody(req, res, (body) => {
      if (cronJobs.length >= CRON_MAX_JOBS) return sendJson(res, 400, { error: `job limit reached (${CRON_MAX_JOBS})` });
      const invalid = validateCronJob(body);
      if (invalid) return sendJson(res, 400, { error: invalid });
      const job = {
        id: newCronId(),
        name: body.name.trim(),
        cron: body.cron.trim(),
        prompt: body.prompt,
        tzOffsetMin: body.tzOffsetMin,
        createdAt: new Date().toISOString(),
      };
      cronJobs.push(job);
      try { saveCronJobs(); }
      catch (e) { cronJobs.pop(); return sendJson(res, 500, { error: `could not save job: ${e.message}` }); }
      sendJson(res, 200, { job: cronJobWithNext(job, new Date()) });
    });
    return true;
  }
  const idMatch = url.pathname.match(/^\/cron\/jobs\/([^/]+)$/);
  if (idMatch && req.method === "DELETE") {
    const id = idMatch[1];
    if (!CRON_ID_RE.test(id)) { sendJson(res, 400, { error: "invalid job id" }); return true; }
    const at = cronJobs.findIndex((j) => j.id === id);
    if (at === -1) { sendJson(res, 404, { error: "no such job" }); return true; }
    const removed = cronJobs.splice(at, 1)[0];
    try { saveCronJobs(); }
    catch (e) { cronJobs.splice(at, 0, removed); sendJson(res, 500, { error: `could not save: ${e.message}` }); return true; }
    cronQueued.delete(id);
    cronLastFired.delete(id);
    try { fs.rmSync(path.join(CRON_RUNS_DIR, id), { recursive: true, force: true }); } catch {}
    sendJson(res, 200, { ok: true });
    return true;
  }
  if (url.pathname === "/cron/runs" && req.method === "GET") {
    const id = url.searchParams.get("job") || "";
    if (!CRON_ID_RE.test(id)) { sendJson(res, 400, { error: "invalid job id" }); return true; }
    const runs = [];
    try {
      const files = fs.readdirSync(path.join(CRON_RUNS_DIR, id))
        .filter((f) => /^\d+\.json$/.test(f))
        .sort((a, b) => parseInt(b, 10) - parseInt(a, 10)) // newest first
        .slice(0, CRON_RUNS_KEPT);
      for (const f of files) {
        try { runs.push(JSON.parse(fs.readFileSync(path.join(CRON_RUNS_DIR, id, f), "utf8"))); } catch {}
      }
    } catch {} // no runs recorded yet
    sendJson(res, 200, { runs });
    return true;
  }
  if (url.pathname === "/cron" || url.pathname.startsWith("/cron/")) {
    sendJson(res, 404, { error: "not found" });
    return true;
  }
  return false;
}

// ---- web push: VAPID keys + subscriptions ----------------------------------
// Keys and subscriptions live under the agent's HOME so they ride the persistent
// volume like the rest of the harness state. push-lib.js is a zero-dep Node
// crypto implementation of RFC 8291 (aes128gcm) + RFC 8292 (VAPID); it may be
// delivered by a sibling change, so a missing module just disables push.
// (AGENTHOST_DIR is declared once near the top, next to the gate secret.)
const VAPID_FILE = path.join(AGENTHOST_DIR, "vapid.json");
const PUSH_SUBS_FILE = path.join(AGENTHOST_DIR, "push-subs.json");
const PUSH_SUBS_CAP = 20;

let pushLib = null;
try { pushLib = require("./push-lib.js"); }
catch (e) { console.error(`[gate] push-lib.js unavailable; web push disabled (${e.message})`); }

// Load VAPID keys once, or generate + persist them (chmod 600 -- the private key
// is a signing secret). Generated once, then stable for every future boot.
let vapidKeys = null;
if (pushLib) {
  try {
    const parsed = JSON.parse(fs.readFileSync(VAPID_FILE, "utf8"));
    if (parsed && parsed.publicKey && parsed.privateKey) vapidKeys = parsed;
    else throw Object.assign(new Error("vapid.json missing keys"), { code: "EBADVAPID" });
  } catch (e) {
    if (e.code && e.code !== "ENOENT" && e.code !== "EBADVAPID") {
      console.error(`[gate] push: could not read ${VAPID_FILE} (${e.message}); regenerating`);
    }
    try {
      vapidKeys = pushLib.generateVapidKeys();
      fs.mkdirSync(AGENTHOST_DIR, { recursive: true, mode: 0o700 });
      const tmp = VAPID_FILE + ".tmp";
      // mode on open + chmod after: the private key is a signing secret, so
      // never leave even a brief default-umask (0644) window on the temp file.
      fs.writeFileSync(tmp, JSON.stringify(vapidKeys), { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, VAPID_FILE);
    } catch (e2) { console.error(`[gate] push: could not create VAPID keys (${e2.message}); push disabled`); vapidKeys = null; }
  }
}

let pushSubs = [];
try {
  const parsed = JSON.parse(fs.readFileSync(PUSH_SUBS_FILE, "utf8"));
  if (Array.isArray(parsed)) pushSubs = parsed.filter((s) => s && typeof s.endpoint === "string" && s.keys && typeof s.keys.p256dh === "string" && typeof s.keys.auth === "string");
} catch (e) {
  if (e.code !== "ENOENT") console.error(`[gate] push: could not load ${PUSH_SUBS_FILE} (${e.message}); starting with no subscriptions`);
}

function savePushSubs() {
  fs.mkdirSync(AGENTHOST_DIR, { recursive: true });
  const tmp = PUSH_SUBS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(pushSubs));
  fs.renameSync(tmp, PUSH_SUBS_FILE);
}

function dropSub(endpoint) {
  const at = pushSubs.findIndex((s) => s.endpoint === endpoint);
  if (at === -1) return;
  pushSubs.splice(at, 1);
  try { savePushSubs(); } catch (e) { console.error(`[gate] push: could not persist sub prune (${e.message})`); }
}

// Best-effort fan-out. A push must NEVER break a chat/cron run, so every failure
// is swallowed to the log; a 404/410 (expired/unsubscribed endpoint) prunes it.
function sendToAllSubs(payloadObj) {
  try {
    if (!pushLib || !vapidKeys || pushSubs.length === 0) return;
    const payload = JSON.stringify(payloadObj);
    for (const sub of pushSubs.slice()) {
      try {
        Promise.resolve(pushLib.sendPush(sub, payload, vapidKeys, {}))
          .then((r) => { if (r && (r.status === 404 || r.status === 410)) dropSub(sub.endpoint); })
          .catch((e) => console.error(`[gate] push: send failed (${e.message})`));
      } catch (e) { console.error(`[gate] push: send threw (${e.message})`); }
    }
  } catch (e) { console.error(`[gate] push: fan-out failed (${e.message})`); }
}

function handlePush(req, res, url) {
  if (url.pathname === "/push/key" && req.method === "GET") {
    if (!vapidKeys) { sendJson(res, 503, { error: "push not configured" }); return true; }
    sendJson(res, 200, { key: vapidKeys.publicKey });
    return true;
  }
  if (url.pathname === "/push/subscribe" && req.method === "POST") {
    readJsonBody(req, res, (body) => {
      if (typeof body.endpoint !== "string" || !body.endpoint) return sendJson(res, 400, { error: "invalid subscription (no endpoint)" });
      // Require the crypto keys sendPush needs; without them a sub can never be
      // delivered to and never returns a 404/410, so it would sit forever in the
      // cap-limited store logging an error on every fan-out.
      if (!body.keys || typeof body.keys.p256dh !== "string" || typeof body.keys.auth !== "string") {
        return sendJson(res, 400, { error: "invalid subscription (missing keys)" });
      }
      const at = pushSubs.findIndex((s) => s.endpoint === body.endpoint);
      if (at !== -1) pushSubs.splice(at, 1); // dedupe by endpoint
      pushSubs.push(body);
      if (pushSubs.length > PUSH_SUBS_CAP) pushSubs = pushSubs.slice(-PUSH_SUBS_CAP);
      try { savePushSubs(); }
      catch (e) { return sendJson(res, 500, { error: `could not save subscription: ${e.message}` }); }
      sendJson(res, 200, { ok: true });
    });
    return true;
  }
  if (url.pathname === "/push/test" && req.method === "POST") {
    sendToAllSubs({ title: "AgentHost", body: "Test notification -- push is working." });
    sendJson(res, 200, { ok: true, subs: pushSubs.length });
    return true;
  }
  if (url.pathname === "/push" || url.pathname.startsWith("/push/")) {
    sendJson(res, 404, { error: "not found" });
    return true;
  }
  return false;
}

// ---- audit log ---------------------------------------------------------------
// Append-only JSON lines under the agent's HOME (rides the volume). Logging is
// strictly best-effort: an audit failure must never break auth, chat, or cron.
const AUDIT_FILE = path.join(AGENTHOST_DIR, "audit.log");
const AUDIT_MAX_BYTES = 1024 * 1024; // rotate at 1MB, keep one predecessor
const AUDIT_VIEW_LINES = 200;

// First X-Forwarded-For entry (Fly puts the client there), truncated to /24
// (or the first 4 groups for IPv6): enough to spot an intruder's network in
// the log without keeping full addresses around.
function auditIp(req) {
  const xff = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  if (!xff) return "";
  if (xff.includes(":")) return xff.split(":").slice(0, 4).join(":") + ":x";
  const parts = xff.split(".");
  return parts.length === 4 ? parts.slice(0, 3).join(".") + ".x" : xff;
}

// `eng` is a SEPARATE field from `detail`, never a string prefix baked into
// it: the Command Center feed (ccFeed) used to recover the engine by parsing
// a "hermes: " / "codex: " prefix off detail, which a user's own /brain query
// could forge (typing "/brain hermes: gateway config" on Claude wrote a
// detail string ccFeed then misread as a Hermes run). A structured field
// can't collide with untrusted text.
function audit(event, detail, req, eng) {
  try {
    fs.mkdirSync(AGENTHOST_DIR, { recursive: true, mode: 0o700 });
    try {
      if (fs.statSync(AUDIT_FILE).size > AUDIT_MAX_BYTES) fs.renameSync(AUDIT_FILE, AUDIT_FILE + ".1");
    } catch {} // no file yet
    const entry = { t: new Date().toISOString(), event };
    // Cap + de-newline detail: user-controlled strings (job names, queries)
    // must not be able to forge extra audit lines or bloat the log.
    if (detail) entry.detail = String(detail).replace(/[\r\n]+/g, " ").slice(0, 200);
    if (eng) entry.eng = eng;
    const ip = req ? auditIp(req) : "";
    if (ip) entry.ip = ip;
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + "\n");
  } catch (e) {
    console.error(`[gate] audit: ${e.message}`); // never throw past here
  }
}

// Shared page chrome for the gate's utility screens (/2fa, /audit): the login
// page's look -- theme.css glow background + tokens, a glass card, and the
// caret wordmark heading. Page-specific styles are appended per screen.
const PAGE_STYLE = `
  body { padding: 26px 18px calc(28px + env(safe-area-inset-bottom)); margin: 0 auto; }
  .head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin: 4px 2px 6px; }
  .head h1 { font-size: 16px; font-weight: 600; margin: 0; letter-spacing: .01em; }
  .head .caret { color: var(--accent); }
  .sub { color: var(--ink-3); font-size: 12px; }
  .card { margin: 14px 0; }
  .ah-chip.mut { color: var(--ink-3); background: rgba(255,255,255,.06); }
  .foot { color: var(--ink-3); font-size: 12.5px; margin-top: 18px; padding: 0 2px; }
  .foot a { color: var(--accent); text-decoration: none; }
  .foot a:hover { text-decoration: underline; }
  /* Legal relight patches: the white-alpha fills above vanish on paper. */
  [data-brand="legal"] .ah-chip.mut { background: var(--surface-2); }
  [data-brand="legal"] .head h1 { font-family: var(--display); }
`;

// Event -> chip tone for the audit stream. Anything unknown renders muted
// rather than unstyled, so a future event name degrades gracefully.
const AUDIT_CHIP = {
  login_ok: "ok",
  login_fail: "err", login_2fa_fail: "err", "2fa_lockout": "err",
  "2fa_enrolled": "accent", "2fa_disabled": "accent",
  chat_run: "warn", brain_run: "warn", cron_run: "warn",
  audit_view: "mut",
};

const AUDIT_PAGE_STYLE = `${PAGE_STYLE}
  body { max-width: 760px; }
  .card { padding: 6px 18px; }
  .row { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline;
    padding: 10px 2px; border-bottom: 1px solid rgba(255,255,255,.06); }
  .row:last-child { border-bottom: 0; }
  .tm { color: var(--ink-3); font-size: 12px; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .dt { color: var(--ink-2); font-size: 12.5px; min-width: 0; word-break: break-word; flex: 1 1 auto; }
  .dt:empty { display: none; }
  .ip { color: var(--ink-3); font-size: 11.5px; white-space: nowrap; margin-left: auto; }
  .empty { color: var(--ink-3); text-align: center; padding: 22px 0; }
  [data-brand="legal"] .row { border-bottom-color: var(--glass-border-soft); }
  @media (max-width: 560px) { .dt { flex-basis: 100%; order: 5; } }
`;

function handleAudit(req, res, url) {
  if (url.pathname !== "/audit" || req.method !== "GET") return false;
  let lines = [];
  try {
    lines = fs.readFileSync(AUDIT_FILE, "utf8").split("\n").filter(Boolean).slice(-AUDIT_VIEW_LINES).reverse();
  } catch {} // no log yet
  audit("audit_view", null, req);
  // Everything user-influenced (detail carries job names/queries, t/ip come
  // from the log file) is escaped server-side; nothing lands in the page raw.
  const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  const rows = lines.map((l) => {
    let e = {};
    // JSON.parse("null")/"123"/"true" don't throw but yield non-objects, and a
    // later e.event deref would be an UNCAUGHT TypeError that kills the gate
    // (its main process). A corrupted/hand-edited audit.log must never brick the
    // box just by being viewed.
    try { e = JSON.parse(l); } catch { e = { event: "unparseable" }; }
    if (!e || typeof e !== "object") e = { event: "unparseable" };
    return `<div class="row"><span class="tm">${esc(e.t).replace("T", " ").slice(0, 19)}</span>` +
      `<span class="ah-chip ${AUDIT_CHIP[e.event] || "mut"}">${esc(e.event)}</span>` +
      `<span class="dt">${esc(e.detail)}</span>` +
      `<span class="ip">${esc(e.ip)}</span></div>`;
  }).join("");
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(brandHtml(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AgentHost audit</title><link rel="stylesheet" href="/theme.css"><style>${AUDIT_PAGE_STYLE}</style>
<body>
<div class="head ah-rise"><h1>audit log<span class="caret">▮</span></h1>
<span class="sub">last ${AUDIT_VIEW_LINES} events · newest first</span></div>
<div class="card ah-glass ah-rise">${rows || '<div class="empty">no events yet</div>'}</div>
<div class="foot"><a href="/?terminal=1">terminal</a> · <a href="/2fa">2fa</a></div>
</body>`));
  return true;
}

// ---- Hermes dashboard app (proxied at /hermes) --------------------------------
// The Hermes web dashboard (hermes dashboard --port 9119) is a Vite React SPA
// with absolute /assets paths -- BUT it reads window.__HERMES_BASE_PATH__ to
// serve under a subpath (which Jinn's dashboard couldn't). So we serve it at
// /hermes/ and, on the index HTML only, rewrite the base-path var to "/hermes"
// and /assets/ -> /hermes/assets/. Everything else under /hermes/* (assets, its
// /api, ws) is proxied to :9119 with the /hermes prefix stripped. If Hermes
// isn't running, /hermes shows a friendly "starting" note instead of a raw 502.
// Terminal-app switch. ttyd attaches one shared tmux session ("agent"); the
// switcher's terminal apps (codex, ollama) each own a named window. Switching
// windows MUST happen server-side -- `tmux select-window` on the box -- not by
// typing keystrokes into the terminal, because the focused window may be a
// full-screen TUI (codex login, an editor) that captures input, and the raw
// ":select-window ..." text then leaks visibly into that app (the bug this
// replaces). A server-side select changes what every attached client sees.
// ---- shared task board (Hermes kanban) --------------------------------------
// The gateway's coordination bus: a task board every engine (and the user) can
// see. Backed by Hermes's SQLite kanban (~/.hermes/kanban.db), reached through
// the `hermes kanban` CLI so the gate needs no new dependency or DB coupling.
//   GET  /board            -> { columns: { queued, running, done, blocked },
//                               tasks: [...] } for the Direction-A board peek.
//   POST /board/task       -> create a task {title, body?, assignee?} (the
//                             human-approved handoff; explicit-routing v1 -- no
//                             autonomous dispatch). Returns the created task.
// Runs the CLI as the gate's own (agent) identity. If Hermes isn't installed
// the board is simply empty / creation 503s -- never an error that wedges chat.
// Hermes's full status vocabulary (kanban_db.py VALID_STATUSES): triage, todo,
// scheduled, ready, running, blocked, review, done, archived (list --json never
// returns archived). "review" keeps its own column -- a swarm task awaiting
// verification is neither queued nor done; the peek shows the column only when
// it has tasks. Unknown/future statuses still land in queued.
const BOARD_COLUMN = { triage: "queued", todo: "queued", scheduled: "queued", ready: "queued", running: "running", review: "review", completed: "done", done: "done", blocked: "blocked" };
function boardColumns(tasks) {
  const cols = { queued: [], running: [], review: [], done: [], blocked: [] };
  for (const t of tasks) (cols[BOARD_COLUMN[t.status] || "queued"]).push(t);
  return cols;
}
// Run `hermes kanban <args>` and resolve its stdout (or null on failure). 15s
// cap so a hung CLI can't hold the request open.
function hermesKanban(args) {
  return new Promise((resolve) => {
    let out = "", err = "";
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const p = spawn(HERMES_BIN, ["kanban", ...args], {
        cwd: HOME_DIR,
        env: { ...process.env, HOME: HOME_DIR, HERMES_HOME: path.join(HOME_DIR, ".hermes") },
      });
      const timer = setTimeout(() => { try { p.kill("SIGKILL"); } catch {} finish(null); }, 15000);
      timer.unref();
      p.stdout.on("data", (c) => { out += c.toString(); });
      p.stderr.on("data", (c) => { err += c.toString(); });
      p.on("error", () => { clearTimeout(timer); finish(null); });
      p.on("close", (code) => { clearTimeout(timer); finish(code === 0 ? out : null); });
    } catch { finish(null); }
  });
}
function handleBoard(req, res, url) {
  if (url.pathname === "/board" && req.method === "GET") {
    hermesKanban(["list", "--json"]).then((out) => {
      let tasks = [];
      if (out) { try { const j = JSON.parse(out); if (Array.isArray(j)) tasks = j; } catch {} }
      // available: whether the Hermes CLI actually answered. A box without
      // Hermes would otherwise be indistinguishable from an empty board, and
      // the chat page would render a board that can never hold a task.
      sendJson(res, 200, { columns: boardColumns(tasks), tasks, available: out !== null });
    });
    return true;
  }
  if (url.pathname === "/board/task" && req.method === "POST") {
    readJsonBody(req, res, (body) => {
      const title = typeof body.title === "string" ? body.title.trim() : "";
      if (!title) return sendJson(res, 400, { error: "title is required" });
      if (title.length > 200) return sendJson(res, 400, { error: "title must be 200 characters or fewer" });
      // The title is a POSITIONAL arg to `hermes kanban create`; a title starting
      // with "-" would be parsed as one of the CLI's own flags (argv injection --
      // verified: title="--max-runtime" hits the usage screen, not a task). A
      // real task title never starts with a dash, so reject it. (spawn already
      // uses an argv array, never a shell, so this is the remaining vector.)
      if (title.startsWith("-")) return sendJson(res, 400, { error: "title cannot start with a dash" });
      const args = ["create", title, "--json"];
      if (typeof body.body === "string" && body.body.trim()) args.push("--body", body.body.slice(0, 8000));
      // assignee must be a plain profile name -- never let arbitrary text become
      // a CLI flag (args are argv, not a shell, so this is defense in depth).
      if (typeof body.assignee === "string" && /^[a-z0-9_-]{1,40}$/i.test(body.assignee)) args.push("--assignee", body.assignee);
      hermesKanban(args).then((out) => {
        if (!out) return sendJson(res, 503, { error: "could not create the task (is Hermes installed on this box?)" });
        // Only report success when the CLI actually returned the created task
        // object. An exit-0 run whose stdout isn't a bare JSON task (a warning
        // banner, a reworded confirmation from a future CLI) must NOT 200 -- a
        // client reading task.id would null-deref, and the audit log would
        // assert a create the gate couldn't confirm.
        let task = null; try { task = JSON.parse(out); } catch {}
        if (!task || typeof task !== "object" || !task.id) {
          return sendJson(res, 502, { error: "task command ran but its result could not be read" });
        }
        audit("board_create", title.slice(0, 60), req);
        sendJson(res, 200, { task });
      });
    });
    return true;
  }
  return false;
}

// ---- Command Center ----------------------------------------------------------
// The "everything else" hub (Steve's combined 2+3 design, 2026-07-17): one
// screen with a five-segment engine switcher (claude/hermes/codex/ollama/
// terminal) whose panels read live status, and a cross-engine activity feed
// underneath built from the gate's own audit log. Chat stays the daily driver
// with its own cost strip + board peek; this screen is where the engines are
// managed and "what happened while I was away" gets answered.
//   GET /cc        -> the page (dev brand only; legal redirects to /chat --
//                     a single-engine box has nothing to command)
//   GET /cc/state  -> one aggregate fetch for everything the page shows:
//                     today's per-engine usage (+ last-active stamps), tmux
//                     windows, Hermes dashboard status, Ollama models, feed.
const OLLAMA_PORT = 11434;
let CC_HTML = null;
try { CC_HTML = Buffer.from(brandHtml(fs.readFileSync(path.join(ASSET_DIR, "cc.html"), "utf8"))); }
catch { console.error("[gate] cc.html not found; GET /cc will 404"); }

// GET http://127.0.0.1:<port><path> -> parsed JSON, or null on any failure
// (down, non-200, bad JSON, timeout). Everything the Command Center reads is
// best-effort: a dead backend renders as "down", never as a broken page.
function localJson(port, pathname, headers, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const r = http.get({ host: "127.0.0.1", port, path: pathname, headers }, (up) => {
      if (up.statusCode !== 200) { up.resume(); return finish(null); }
      const chunks = [];
      up.on("data", (c) => chunks.push(c));
      up.on("end", () => {
        try { finish(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { finish(null); }
      });
      // A backend that dies mid-response (Hermes gateway restart, Ollama
      // reload) emits an error on the RESPONSE stream, not the request --
      // Node silently swallows an unlistened IncomingMessage error, which
      // left this promise (and the /cc/state request awaiting it) hung
      // forever. finish() is idempotent so this can't race the 'end' path.
      up.on("error", () => finish(null));
    });
    r.on("error", () => finish(null));
    r.setTimeout(timeoutMs, () => { r.destroy(); finish(null); });
  });
}

// The agent tmux session's windows, for the Terminal panel ([{name, active}]).
function tmuxWindows() {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const p = spawn("tmux", ["list-windows", "-t", "agent", "-F", "#{window_name}\t#{window_active}"], { env: process.env });
      const t = setTimeout(() => { try { p.kill("SIGKILL"); } catch {} finish(null); }, 3000);
      t.unref();
      p.stdout.on("data", (c) => { out += c.toString(); });
      p.on("error", () => { clearTimeout(t); finish(null); });
      p.on("close", (code) => {
        clearTimeout(t);
        if (code !== 0) return finish(null);
        finish(out.trim().split("\n").filter(Boolean).map((l) => {
          const [name, act] = l.split("\t");
          return { name, active: act === "1" };
        }));
      });
    } catch { finish(null); }
  });
}

// The activity feed: the audit log's engine-relevant events, newest first.
// Only event types with a human story make the feed (logins, 2fa, and audit
// views are security telemetry -- they stay on /audit). eng values the client
// colors: claude | hermes | codex | board | loops.
const CC_FEED_MAX = 30;
function ccFeed() {
  let lines = [];
  try { lines = fs.readFileSync(AUDIT_FILE, "utf8").split("\n").filter(Boolean).slice(-200); } catch {}
  const feed = [];
  for (let i = lines.length - 1; i >= 0 && feed.length < CC_FEED_MAX; i--) {
    let e = null;
    try { e = JSON.parse(lines[i]); } catch { continue; }
    const at = Date.parse(e.t) || 0;
    if (e.event === "chat_run") {
      // eng rides its own structured field (audit()'s 4th arg) -- never
      // parsed out of detail, which is untrusted user text and could forge a
      // fake prefix (see the brain_run fix below for the concrete case).
      feed.push({ eng: e.eng === "hermes" || e.eng === "codex" ? e.eng : "claude", what: "answered a chat message", at });
    } else if (e.event === "brain_run") {
      feed.push({ eng: e.eng === "hermes" || e.eng === "codex" ? e.eng : "claude", what: "searched the brain: “" + (e.detail || "") + "”", at });
    } else if (e.event === "board_create") {
      feed.push({ eng: "board", what: "task added to the board: “" + (e.detail || "") + "”", at });
    } else if (e.event === "cron_run") {
      feed.push({ eng: "loops", what: "scheduled run: “" + (e.detail || "") + "”", at });
    }
  }
  return feed;
}

function handleCommandCenter(req, res, url) {
  if (url.pathname === "/cc" && req.method === "GET") {
    // Legal is single-engine Claude: no engines to command, no dead surface.
    if (BRAND === "legal") { res.writeHead(302, { "Location": "/chat" }); res.end(); return true; }
    if (!CC_HTML) { res.writeHead(404); res.end(); return true; }
    // no-cache: same rule as /chat -- a phone that cached an old page keeps a
    // broken client wired to changed routes.
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(CC_HTML);
    return true;
  }
  if (url.pathname === "/cc/state" && req.method === "GET") {
    // Mirror /cc's legal gate: a single-engine box has no Command Center
    // surface to feed, so its aggregate state (tmux windows, Hermes/Ollama
    // status, the audit feed) shouldn't be a live endpoint either.
    if (BRAND === "legal") { res.writeHead(404); res.end(); return true; }
    const tzRaw = Number(url.searchParams.get("tz"));
    const tz = Number.isFinite(tzRaw) && Math.abs(tzRaw) <= 900 ? tzRaw : 0;
    const day = localDay(tz);
    const usage = readUsage()[day] || {};
    Promise.all([
      tmuxWindows(),
      // Hermes's /api/status can take >2.5s on its FIRST hit after an idle
      // stretch (the dashboard warms lazily -- verified on the box: a cold
      // call times out, a warm one answers in ms), so the panel was reporting
      // "down" for a dashboard that was actually up. 6s survives the cold hit;
      // still bounded so a genuinely dead dashboard doesn't stall the route.
      localJson(HERMES_PORT, "/api/status", HERMES_DASH_TOKEN ? { authorization: `Bearer ${HERMES_DASH_TOKEN}` } : {}, 6000),
      localJson(OLLAMA_PORT, "/api/ps", {}, 2000),
      localJson(OLLAMA_PORT, "/api/tags", {}, 2000),
    ]).then(([windows, dash, ps, tags]) => {
      sendJson(res, 200, {
        day,
        usage, // { engine: {in, out, cost, turns, at} } -- today only
        windows,
        hermes: dash ? {
          version: typeof dash.version === "string" ? dash.version : null,
          gatewayState: typeof dash.gateway_state === "string" ? dash.gateway_state : null,
          gatewayRunning: Boolean(dash.gateway_running),
          activeSessions: Number(dash.active_sessions) || 0,
        } : null,
        ollama: {
          up: ps !== null,
          loaded: Array.isArray(ps && ps.models) ? ps.models.map((m) => String(m.name || "")).filter(Boolean).slice(0, 4) : [],
          pulled: Array.isArray(tags && tags.models) ? tags.models.length : null,
        },
        feed: ccFeed(),
      });
    });
    return true;
  }
  return false;
}

// appshell.js fetches this on the terminal page (fire-and-forget); it returns
// 204 and never redirects, so the page stays put and the terminal just repaints
// on the newly-selected window.
// True while a claude-window create is in flight, so two near-simultaneous
// /?window=claude opens (two tabs, phone+desktop) can't both see the select
// fail and both spawn "new-window" -- tmux doesn't enforce unique window
// names, so an unguarded race leaves two "claude" windows each running their
// own interactive CLI. The second request waits for the first's create to
// finish, then re-selects (which now succeeds).
let claudeWindowCreating = null;
function handleSwitch(req, res, url) {
  if (url.pathname !== "/switch") return false;
  // Window name from the query; the bare terminal maps to window 0. Only
  // [a-z0-9-] so the name can never inject tmux args or shell.
  var raw = url.searchParams.get("window") || "";
  var win = /^[a-z0-9-]+$/.test(raw) ? raw : "0";
  var done = false;
  var finish = () => { if (done) return; done = true; res.writeHead(204, { "Cache-Control": "no-store" }); res.end(); };
  function select() {
    var child = spawn("tmux", ["select-window", "-t", "agent:" + win], { env: process.env });
    child.on("error", finish);   // tmux missing / not running: still answer cleanly
    child.on("close", (code) => {
      // The claude window is created LAZILY on first open (Command Center's
      // "terminal session"): an interactive `claude` in HOME -- deliberately NOT
      // CHAT_CWD, so this scratch session can never become the "latest"
      // conversation that chat's -c continues (Steve, 2026-07-17: the chat
      // thread's continuity is sacred; resume it from inside claude's picker
      // when wanted). `exec bash` keeps the window alive after claude exits.
      // Other windows (codex/ollama/hermes) are boot-created by start.sh, so a
      // failed select for anything else just answers 204 as before.
      if (code !== 0 && win === "claude") {
        if (claudeWindowCreating) { claudeWindowCreating.then(select); return; }
        claudeWindowCreating = new Promise((resolveCreate) => {
          var doneCreate = () => { claudeWindowCreating = null; resolveCreate(); finish(); };
          // Second guard layer: the in-memory lock above only spans one gate.js
          // process, and it resets to null on every restart/deploy -- so a request
          // landing just after a restart could race one from just before it and
          // both create a "claude" window (tmux doesn't enforce unique names). Ask
          // tmux itself -- the real, cross-restart source of truth -- whether a
          // "claude" window already exists before creating one. If it does, skip
          // the create and just re-select it.
          var out = "";
          var ls = spawn("tmux", ["list-windows", "-t", "agent", "-F", "#{window_name}"], { env: process.env });
          ls.stdout.on("data", (d) => { out += d; });
          ls.on("error", doneCreate);   // can't list -> fall through to a normal 204
          ls.on("close", () => {
            if (out.split("\n").indexOf("claude") !== -1) { claudeWindowCreating = null; resolveCreate(); select(); return; }
            var mk = spawn("tmux", ["new-window", "-t", "agent", "-n", "claude", "-c", HOME_DIR, "claude; exec bash"], { env: process.env });
            mk.on("error", doneCreate);
            mk.on("close", doneCreate);
          });
        });
        return;
      }
      finish();
    });
  }
  select();
  return true;
}

function handleHermes(req, res, url) {
  if (url.pathname !== "/hermes" && !url.pathname.startsWith("/hermes/")) return false;
  if (url.pathname === "/hermes") { res.writeHead(302, { "Location": "/hermes/" }); res.end(); return true; }
  const hpath = req.url.slice("/hermes".length) || "/";
  const isIndex = hpath === "/" || hpath.startsWith("/?");
  // Rewrite Host to what Hermes bound to. Hermes's June-2026 hardening rejects
  // any request whose Host header != its bind (127.0.0.1:9119) -- forwarding the
  // browser's Host (agenthost-steve.fly.dev) got "Invalid Host header". Drop
  // accept-encoding too so we can rewrite the index HTML (see below) uncompressed.
  // Inject the dashboard session token so its /api/* routes authorize (the
  // browser is already past the gate's own auth; the gate is the trusted front
  // door). Without this the SPA's API calls 401 -> "gateway failed to load".
  const proxyHeaders = (({ "accept-encoding": _, ...h }) => ({ ...h, host: `127.0.0.1:${HERMES_PORT}` }))(req.headers);
  if (HERMES_DASH_TOKEN) proxyHeaders["authorization"] = `Bearer ${HERMES_DASH_TOKEN}`;
  const hup = http.request(
    { host: "127.0.0.1", port: HERMES_PORT, path: hpath, method: req.method, headers: proxyHeaders },
    (hr) => {
      if (!isIndex) { res.writeHead(hr.statusCode, hr.headers); return hr.pipe(res); }
      const chunks = [];
      hr.on("data", (c) => chunks.push(c));
      hr.on("end", () => {
        let body = Buffer.concat(chunks).toString("utf8");
        body = body.replace(/__HERMES_BASE_PATH__="[^"]*"/, '__HERMES_BASE_PATH__="/hermes"');
        body = body.replace(/(src|href)="\/assets\//g, '$1="/hermes/assets/');
        body = body.replace(/href="\/favicon/g, 'href="/hermes/favicon');
        // iPhone status-bar clearance: the dashboard opts into viewport-fit=
        // cover and pads for the BOTTOM safe area but never the top, so in the
        // installed app its top bar (hamburger) hides behind the clock. Its
        // shells are Tailwind h-dvh + fixed top-0 (probed from the bundle);
        // push both below the inset. env() is 0 outside notched-phone
        // portrait, so this is a no-op on desktop -- and it rides the index
        // rewrite, surviving Hermes dashboard updates.
        body = body.replace("</head>", "<style>@supports (top: env(safe-area-inset-top)) {" +
          " .h-dvh { height: calc(100dvh - env(safe-area-inset-top, 0px)); margin-top: env(safe-area-inset-top, 0px); }" +
          " .fixed.top-0 { top: env(safe-area-inset-top, 0px); }" +
          " html { background: #101014; }" +
          " }</style></head>");
        const headers = { ...hr.headers, "content-length": Buffer.byteLength(body), "cache-control": "no-cache" };
        delete headers["content-encoding"];
        res.writeHead(hr.statusCode, headers);
        res.end(body);
      });
    }
  );
  hup.on("error", () => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(brandHtml(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui;background:#0B0D10;color:#E8ECF0;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><p>Hermes is starting up…</p><p style="opacity:.6;font-size:14px">give it a few seconds and reload</p></div></body>`));
  });
  req.pipe(hup);
  return true;
}

// ---- 2FA (opt-in TOTP) --------------------------------------------------------
// A 2fa.secret file on the volume turns it on; absent = today's key-only login.
// totp.js is zero-dep (Node crypto); a missing module just leaves 2FA off.
const TWOFA_FILE = path.join(AGENTHOST_DIR, "2fa.secret");
let totpLib = null;
try { totpLib = require("./totp.js"); }
catch (e) { console.error(`[gate] totp.js unavailable; 2FA disabled (${e.message})`); }

// "Is 2FA enrolled?" is deliberately INDEPENDENT of totpLib: a secret on the
// volume means the user opted in, whether or not the verifier loaded. The login
// path uses this to fail closed when enrolled-but-unverifiable (see above).
function twoFaEnrolled() {
  try { return fs.readFileSync(TWOFA_FILE, "utf8").trim().length > 0; }
  catch { return false; }
}

// Read fresh on every use: enroll/disable must take effect immediately, and a
// login attempt must never trust a cached "off" after the file appeared.
function twoFaSecret() {
  if (!totpLib) return null;
  try {
    const s = fs.readFileSync(TWOFA_FILE, "utf8").trim();
    return s || null;
  } catch { return null; }
}

// Never let a tampered/corrupt secret (invalid base32 -> totp throws) crash the
// gate, which is the box's main process. A verify error fails CLOSED.
function verifyCode(code, secret) {
  try { return Boolean(totpLib && totpLib.verify(code, secret)); }
  catch (e) { console.error(`[gate] 2fa verify error: ${e.message}`); return false; }
}

// Brute-force guard: a 6-digit code is only 10^6 possibilities, so failed code
// attempts are throttled -- >=5 failures inside 60s locks code checks for 60s.
// In-memory is fine: an attacker can't reset it without restarting the machine,
// and a restart costs them far more time than the lockout does.
const twoFaFailures = [];
let twoFaLockedUntil = 0;
function twoFaThrottled() {
  return Date.now() < twoFaLockedUntil;
}
function twoFaRecordFailure(req) {
  const now = Date.now();
  twoFaFailures.push(now);
  while (twoFaFailures.length && twoFaFailures[0] < now - 60 * 1000) twoFaFailures.shift();
  if (twoFaFailures.length >= 5) {
    twoFaLockedUntil = now + 60 * 1000;
    twoFaFailures.length = 0;
    audit("2fa_lockout", "too many bad codes; code checks paused 60s", req);
  }
}

let twoFaPending = null; // enroll secret awaiting confirmation (in-memory only)

function writeTwoFaSecret(secret) {
  fs.mkdirSync(AGENTHOST_DIR, { recursive: true, mode: 0o700 });
  const tmp = TWOFA_FILE + ".tmp";
  fs.writeFileSync(tmp, secret + "\n", { mode: 0o600 });
  fs.renameSync(tmp, TWOFA_FILE);
}

const TWOFA_PAGE_STYLE = `${PAGE_STYLE}
  body { max-width: 560px; }
  .card { padding: 20px; }
  .card p { margin: 0 0 14px; color: var(--ink-2); font-size: 13.5px; line-height: 1.55; }
  .card p b { color: var(--ink); }
  .stp { margin: 18px 0 6px; color: var(--ink-3); font-size: 11px; font-weight: 700;
    letter-spacing: .06em; text-transform: uppercase; }
  .mono { font: 12px/1.6 var(--mono); word-break: break-all; background: var(--base);
    border: 1px solid var(--glass-border-soft); border-radius: var(--r-sm);
    padding: 10px 12px; margin: 0; cursor: copy; user-select: all; -webkit-user-select: all; }
  .ah-input { margin: 12px 0; }
  .danger { color: var(--err); border-color: rgba(255,90,90,.35); }
  .danger:hover { border-color: rgba(255,90,90,.6); }
`;

function handleTwoFa(req, res, url) {
  if (url.pathname === "/2fa" && req.method === "GET") {
    if (!totpLib) { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end("2FA unavailable (totp.js not shipped)"); return true; }
    const on = Boolean(twoFaSecret());
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    // Styling only: the enroll/confirm/disable contracts (endpoints, field
    // names, alert-on-error + reload-on-ok handling) are unchanged.
    res.end(brandHtml(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AgentHost 2FA</title><link rel="stylesheet" href="/theme.css"><style>${TWOFA_PAGE_STYLE}</style>
<body>
<div class="head ah-rise"><h1>two-factor auth<span class="caret">▮</span></h1>
<span class="ah-chip ${on ? "ok" : "mut"}">${on ? "on" : "off"}</span></div>
${on
  ? `<div class="card ah-glass ah-rise">
     <p>2FA is <b>on</b>: logins need your access key plus a 6-digit authenticator code.</p>
     <input id="dc" class="ah-input" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="current 6-digit code" autocomplete="one-time-code">
     <button class="ah-btn ah-btn-ghost danger" onclick="post('/2fa/disable',dc.value)">turn off 2FA</button></div>`
  : `<div class="card ah-glass ah-rise">
     <p>Add a second factor: your access key alone stops being enough to open the terminal.</p>
     <button class="ah-btn ah-btn-primary" onclick="enroll()">start enrollment</button>
     <div id="out" style="display:none">
     <p class="stp">1 · add this secret to your authenticator app · tap to copy</p>
     <div class="mono" id="secret" onclick="copyEl(this)" title="tap to copy"></div>
     <p class="stp">or the otpauth url</p>
     <div class="mono" id="url" onclick="copyEl(this)" title="tap to copy"></div>
     <p class="stp">2 · confirm with the app's current code</p>
     <input id="cc" class="ah-input" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="6-digit code" autocomplete="one-time-code">
     <button class="ah-btn ah-btn-primary" onclick="post('/2fa/confirm',cc.value)">activate</button></div></div>`}
<div class="foot"><a href="/?terminal=1">terminal</a> · <a href="/audit">audit log</a></div>
<script>
function enroll(){fetch('/2fa/enroll',{method:'POST'}).then(r=>r.json()).then(d=>{
  if(d.error){alert(d.error);return}
  document.getElementById('out').style.display='block';
  document.getElementById('secret').textContent=d.secret;
  document.getElementById('url').textContent=d.otpauth;});}
function post(p,code){fetch(p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:code})})
  .then(r=>r.json()).then(d=>{if(d.error){alert(d.error);return} location.reload();});}
function copyEl(el){if(navigator.clipboard&&navigator.clipboard.writeText){
  navigator.clipboard.writeText(el.textContent).then(function(){toast('copied')},function(){})}}
var __t=null,__tt=null;
function toast(m){if(!__t){__t=document.createElement('div');__t.className='ah-toast';document.body.appendChild(__t)}
  __t.textContent=m;__t.style.display='none';void __t.offsetWidth;__t.style.display='';
  clearTimeout(__tt);__tt=setTimeout(function(){__t.style.display='none'},1600)}
</script></body>`));
    return true;
  }
  if (url.pathname === "/2fa/enroll" && req.method === "POST") {
    if (!totpLib) { sendJson(res, 503, { error: "2FA unavailable" }); return true; }
    if (twoFaSecret()) { sendJson(res, 400, { error: "2FA is already on -- turn it off first to re-enroll" }); return true; }
    twoFaPending = totpLib.generateSecret();
    sendJson(res, 200, {
      secret: twoFaPending,
      otpauth: totpLib.otpauthUrl(twoFaPending, `agent@${req.headers.host || "agenthost"}`, "AgentHost"),
    });
    return true;
  }
  if (url.pathname === "/2fa/confirm" && req.method === "POST") {
    readJsonBody(req, res, (body) => {
      if (!totpLib || !twoFaPending) return sendJson(res, 400, { error: "no enrollment in progress -- start again" });
      // The confirm step is what prevents lockout-by-typo: the secret only
      // becomes active once the authenticator provably produces valid codes.
      if (!verifyCode(body.code, twoFaPending)) return sendJson(res, 400, { error: "code didn't match -- check the app and try again" });
      try { writeTwoFaSecret(twoFaPending); }
      catch (e) { return sendJson(res, 500, { error: `could not save: ${e.message}` }); }
      twoFaPending = null;
      audit("2fa_enrolled", null, req);
      sendJson(res, 200, { ok: true });
    });
    return true;
  }
  if (url.pathname === "/2fa/disable" && req.method === "POST") {
    readJsonBody(req, res, (body) => {
      const secret = twoFaSecret();
      if (!secret) return sendJson(res, 400, { error: "2FA is not on" });
      // Disabling requires a current code too: a stolen cookie alone must not
      // be enough to strip the second factor.
      if (twoFaThrottled()) return sendJson(res, 429, { error: "too many attempts -- wait a minute" });
      if (!verifyCode(body.code, secret)) { twoFaRecordFailure(req); return sendJson(res, 400, { error: "code didn't match" }); }
      try { fs.unlinkSync(TWOFA_FILE); }
      catch (e) { return sendJson(res, 500, { error: `could not remove: ${e.message}` }); }
      audit("2fa_disabled", null, req);
      sendJson(res, 200, { ok: true });
    });
    return true;
  }
  if (url.pathname === "/2fa" || url.pathname.startsWith("/2fa/")) {
    sendJson(res, 404, { error: "not found" });
    return true;
  }
  return false;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  // Which skin is this box wearing? No auth: the brand is not a secret (the
  // login page itself is branded) and clients may need it pre-login.
  if (url.pathname === "/brand.json") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache" });
    return res.end(JSON.stringify({ brand: BRAND }));
  }
  if (url.pathname === "/sw.js") {
    if (!SW_JS) { res.writeHead(404); return res.end(); }
    res.writeHead(200, {
      "Content-Type": "text/javascript",
      "Service-Worker-Allowed": "/",
      "Cache-Control": "no-cache",
    });
    return res.end(SW_JS);
  }
  const asset = STATIC_ROUTES[url.pathname];
  if (asset) {
    // no-cache (revalidate), not max-age: the app shell + manifest change with
    // every deploy, and a stale cached appshell.js silently keeps the old mobile
    // UI on the phone for an hour. These assets are tiny; revalidation is cheap.
    res.writeHead(200, { "Content-Type": asset.type, "Cache-Control": "no-cache" });
    return res.end(asset.body);
  }
  const key = url.searchParams.get("key");
  if (key !== null) {
    const enrolled = twoFaEnrolled();
    const secret = twoFaSecret();
    let grant = false;
    if (key !== KEY) {
      audit("login_fail", "bad key", req);
    } else if (!enrolled) {
      grant = true; // 2FA off: key alone is today's behavior
    } else if (!totpLib || !secret) {
      // Enrolled but unverifiable (totp.js missing or secret unreadable): fail
      // CLOSED. The user opted into a second factor; a broken verifier must
      // never silently downgrade to key-only. Owner can `flyctl ssh` in to fix.
      audit("login_2fa_fail", "enrolled but verifier unavailable", req);
    } else if (twoFaThrottled()) {
      audit("login_2fa_fail", "throttled", req);
    } else if (verifyCode(url.searchParams.get("code"), secret)) {
      grant = true;
    } else {
      twoFaRecordFailure(req);
      audit("login_2fa_fail", url.searchParams.get("code") ? "bad code" : "missing code", req);
    }
    if (grant) {
      if (enrolled) twoFaFailures.length = 0; // a good login clears the failure window
      audit("login_ok", enrolled ? "key+2fa" : "key", req);
      res.writeHead(302, {
        "Set-Cookie": `${COOKIE}=${COOKIE_VALUE}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
        // Legal is chat-first: a login that would land on "/" goes straight to
        // the message thread (explicit here because the browser re-sends the
        // login page's same-origin Referer on the redirect hop, which the "/"
        // handler below reads as in-app navigation to the terminal).
        "Location": BRAND === "legal" && url.pathname === "/" ? "/chat" : url.pathname,
      });
    } else {
      res.writeHead(302, { "Location": "/?e=1" });
    }
    return res.end();
  }
  if (!authed(req)) {
    res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(brandHtml(loginHtml(Boolean(twoFaSecret()), url.searchParams.get("e") === "1")));
  }
  // Legal is chat-first: entering the box at "/" (home-screen PWA launch, typed
  // URL) lands on /chat, not the raw terminal. The terminal STAYS reachable two
  // ways -- any explicit ?terminal flag (how the legal appshell/foot links point
  // at it), or in-app navigation (a same-origin Referer: the chat/cron tab bars
  // link the terminal as plain "/"). Dev brand keeps terminal-first "/".
  if (BRAND === "legal" && url.pathname === "/" && !url.searchParams.has("terminal")) {
    const ref = String(req.headers.referer || "");
    const sameOrigin = req.headers.host && ref.includes(`//${req.headers.host}`);
    if (!sameOrigin) {
      res.writeHead(302, { "Location": "/chat" });
      return res.end();
    }
  }
  if (handleChat(req, res, url)) return;
  if (handleCron(req, res, url)) return;
  if (handlePush(req, res, url)) return;
  if (handleTwoFa(req, res, url)) return;
  if (handleAudit(req, res, url)) return;
  if (handleBoard(req, res, url)) return;
  if (handleCommandCenter(req, res, url)) return;
  if (handleSwitch(req, res, url)) return;
  if (handleHermes(req, res, url)) return;
  const upstream = http.request(
    { host: "127.0.0.1", port: TTYD_PORT, path: req.url, method: req.method,
      // identity encoding: the "/" injection below rewrites the body, which
      // corrupts gzip responses (Chrome: ERR_CONTENT_DECODING_FAILED)
      headers: (({ "accept-encoding": _, ...h }) => h)(req.headers) },
    (ur) => {
      const isRootHtml = url.pathname === "/" && (ur.headers["content-type"] || "").includes("text/html");
      if (!isRootHtml) {
        res.writeHead(ur.statusCode, ur.headers);
        return ur.pipe(res);
      }
      // Inject the PWA head tags into ttyd's own index page so "Add to Home
      // Screen" picks up the manifest/icon; every other path/asset/WS is untouched.
      const chunks = [];
      ur.on("data", (c) => chunks.push(c));
      ur.on("end", () => {
        let body = Buffer.concat(chunks).toString("utf8");
        body = body.includes("</head>") ? body.replace("</head>", `${PWA_HEAD_TAGS}</head>`) : PWA_HEAD_TAGS + body;
        // Brand rides the proxied terminal page too, so the appshell can order
        // its tabs without a round-trip to /brand.json.
        body = brandHtml(body);
        // no-cache the root HTML: it carries the versioned appshell <script> tag,
        // and if a phone caches this page it keeps loading the OLD appshell (old
        // ?v=) forever -- redeploys silently never reach the client. Revalidating
        // the tiny index every load is cheap and makes shell fixes actually land.
        const headers = { ...ur.headers, "content-length": Buffer.byteLength(body), "cache-control": "no-cache" };
        res.writeHead(ur.statusCode, headers);
        res.end(body);
      });
    }
  );
  upstream.on("error", () => { res.writeHead(502); res.end("agent backend starting, retry in a few seconds"); });
  req.pipe(upstream);
});

server.on("upgrade", (req, socket, head) => {
  if (!authed(req)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    return socket.destroy();
  }
  // /hermes/* WebSockets go to the Hermes dashboard (:9119, prefix stripped);
  // every other upgrade is ttyd's terminal socket.
  const isHermes = req.url === "/hermes" || req.url.startsWith("/hermes/") || req.url.startsWith("/hermes?");
  const port = isHermes ? HERMES_PORT : TTYD_PORT;
  const fwdUrl = isHermes ? (req.url.slice("/hermes".length) || "/") : req.url;
  const up = net.connect(port, "127.0.0.1", () => {
    let raw = `${req.method} ${fwdUrl} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i];
      const lower = name.toLowerCase();
      // Hermes rejects a WS whose Host != its bind (same hardening as its HTTP
      // side); rewrite Host to :9119 when routing there. ttyd doesn't care, so
      // only touch it for Hermes.
      if (lower === "host" && isHermes) { raw += `Host: 127.0.0.1:${HERMES_PORT}\r\n`; continue; }
      // Drop any client Authorization on the Hermes WS -- we inject our own
      // dashboard token below so the WS endpoint authorizes.
      if (lower === "authorization" && isHermes && HERMES_DASH_TOKEN) continue;
      raw += `${name}: ${req.rawHeaders[i + 1]}\r\n`;
    }
    // Inject the dashboard session token on the Hermes WS (the SPA's live socket
    // needs it, same as the /api HTTP routes).
    if (isHermes && HERMES_DASH_TOKEN) raw += `Authorization: Bearer ${HERMES_DASH_TOKEN}\r\n`;
    up.write(raw + "\r\n");
    if (head && head.length) up.write(head);
    socket.pipe(up);
    up.pipe(socket);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
});

// GATE_PORT exists for tests only (parallel suites can't share one hardcoded
// port; 0 = ephemeral, the actual port is in the log line). Production is 8080.
const PORT = Number(process.env.GATE_PORT || 8080);
server.listen(PORT, "0.0.0.0", () => console.log(`[gate] listening on ${server.address().port}, proxying ttyd on ${TTYD_PORT}`));
