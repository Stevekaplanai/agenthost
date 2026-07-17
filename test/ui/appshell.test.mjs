// UI tests for the mobile app shell + chat, driven through Playwright against
// the rig (real appshell.js/chat.html). Run: node test/ui/appshell.test.mjs
// Skips gracefully if playwright-core / the pinned chromium isn't present.
import assert from "node:assert/strict";
import fs from "node:fs";
import { startRig, APPS } from "./rig.mjs";

const EXEC = "/opt/pw-browsers/chromium";
let chromium;
try { ({ chromium } = await import("playwright-core")); }
catch { console.log("SKIP ui: playwright-core not installed"); process.exit(0); }

const IPHONE = { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 };
const IPHONE_SE = { width: 375, height: 667, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const ANDROID_360 = { width: 360, height: 780, isMobile: true, hasTouch: true, deviceScaleFactor: 3 };
const PIXEL = { width: 412, height: 915, isMobile: true, hasTouch: true, deviceScaleFactor: 2.6 };
const DESKTOP = { width: 1280, height: 800 };

const { server, port } = await startRig();
const base = `http://127.0.0.1:${port}`;
// Sandbox pins its own chromium; on a dev machine (e.g. Steve's Windows box)
// fall back to the installed Chrome via playwright-core's channel resolution.
const browser = fs.existsSync(EXEC)
  ? await chromium.launch({ executablePath: EXEC })
  : await chromium.launch({ channel: "chrome" });
let passed = 0;
async function check(name, fn, vp) {
  const v = vp || IPHONE;
  const ctx = await browser.newContext({ viewport: v, ...v });
  const page = await ctx.newPage();
  try { await fn(page); console.log("ok   " + name); passed++; }
  catch (e) { console.log("FAIL " + name + "\n     " + e.message); process.exitCode = 1; }
  finally { await ctx.close(); }
}

// Header-fit measurement shared by the terminal, chat, and loops pages: the tab
// BAR (primary navigation) must sit fully inside the viewport and the page must
// never scroll horizontally. The pills come from the gate's real APPS list --
// with 5+ apps they may outgrow a phone-width bar, in which case the bar itself
// must scroll sideways so every pill stays reachable (never clipped dead).
async function measureHeaderFit(page, tabsSel) {
  return page.evaluate((sel) => {
    const tabs = document.querySelector(sel);
    const r = tabs.getBoundingClientRect();
    return {
      right: r.right,
      left: r.left,
      vw: window.innerWidth,
      scrollW: document.documentElement.scrollWidth,
      tabsScrollW: tabs.scrollWidth,
      tabsClientW: tabs.clientWidth,
      tabsOverflowX: getComputedStyle(tabs).overflowX,
      pills: [...tabs.querySelectorAll("a")].map((a) => {
        const b = a.getBoundingClientRect();
        return { text: a.textContent, left: b.left, right: b.right, w: b.width, h: b.height };
      }),
    };
  }, tabsSel);
}
// The invariant: the tab BAR sits fully inside the viewport and the page never
// scrolls horizontally. Individual pills may extend past the viewport when the
// bar is a scroll region (barScrollW > barClientW) -- that's how 6+ apps stay
// reachable on a phone. Every pill must still be a real tap target.
function assertHeaderFits(fit, label) {
  assert.ok(fit.right <= fit.vw + 0.5, `${label}: tabs right edge ${fit.right} must be <= viewport ${fit.vw}`);
  assert.ok(fit.left >= -0.5, `${label}: tabs not pushed off the left (${fit.left})`);
  assert.ok(fit.scrollW <= fit.vw, `${label}: no horizontal page scroll (scrollWidth ${fit.scrollW} vs ${fit.vw})`);
  // One pill per NAV entry, not per APPS route: nav:false entries (terminal,
  // hermes, codex, ollama) are routable but pill-less -- reached through
  // Command Center. Both brands render 3 pills (dev: command center|chat|
  // loops; legal: chat|loops|terminal).
  assert.equal(fit.pills.length, APPS.filter((a) => a.nav !== false).length,
    `${label}: one pill per gate.js nav app (${fit.pills.map((p) => p.text).join("|")})`);
  if (fit.tabsScrollW > fit.tabsClientW + 0.5) {
    // Pills outgrow the bar: the bar must scroll so the off-screen ones are
    // a thumb-swipe away, not amputated by overflow:hidden.
    assert.ok(fit.tabsOverflowX === "auto" || fit.tabsOverflowX === "scroll",
      `${label}: overflowing tab bar must scroll (overflow-x: ${fit.tabsOverflowX})`);
  } else {
    for (const p of fit.pills) {
      assert.ok(p.right <= fit.vw + 0.5 && p.left >= -0.5, `${label}: tab "${p.text}" fully on-screen`);
    }
  }
  for (const p of fit.pills) {
    assert.ok(p.w >= 30 && p.h >= 18, `${label}: tab "${p.text}" still tappable (${p.w}x${p.h})`);
  }
}

await check("header, tabs, key bar all render on the terminal page", async (page) => {
  await page.goto(base + "/");
  await page.waitForSelector("#ah-header");
  // The tab pills arrive via the deferred /agenthost-nav.js renderer. The
  // terminal is a DEEP surface now (reached through Command Center), so no
  // pill is active here -- the nav is command center | chat | loops.
  await page.waitForSelector("#ah-tabs a", { timeout: 4000 });
  assert.equal(await page.$("#ah-tabs a.on"), null, "no active pill on the terminal deep surface");
  assert.ok(await page.$("#ah-keybar"), "key bar present at touch viewport");
  assert.equal((await page.$$("#ah-keybar .ah-key")).length, 16, "8 keys row 1 (incl. shift) + 8 keys row 2 (incl. abc)");
});

await check("terminal is inset below header and above key bar (chrome never overlaps)", async (page) => {
  await page.goto(base + "/");
  // #terminal-container is mounted by the fake ttyd a tick after load (like real
  // ttyd); the appshell must wait for it, then inset it below the header.
  await page.waitForSelector("#terminal-container");
  await page.waitForSelector("#ah-header");
  const term = await page.$eval("#terminal-container", (el) => el.getBoundingClientRect().top);
  const header = await page.$eval("#ah-header", (el) => el.getBoundingClientRect().bottom);
  assert.ok(term >= header - 1, `terminal top ${term} should be at/below header bottom ${header}`);
});

await check("connection dot goes green once the fake ws opens", async (page) => {
  await page.goto(base + "/");
  await page.waitForFunction(() => document.querySelector("#ah-dot")?.classList.contains("connected"), { timeout: 4000 });
});

await check("sticky Ctrl + c sends a real ctrl-c byte through xterm's data pipe", async (page) => {
  await page.goto(base + "/");
  await page.waitForSelector("#ah-ctrl");
  await page.tap("#ah-ctrl");
  assert.ok(await page.$eval("#ah-ctrl", (b) => b.classList.contains("armed")), "ctrl armed after tap");
  // Row 2 order is [paste, c, d, /, |, ~, enter] after row 1's 8 keys -> 'c' is index 9.
  const keys = await page.$$("#ah-keybar .ah-key");
  await keys[9].tap();
  const sent = await page.evaluate(() => window.__data);
  assert.ok(sent.some((s) => s === "\x03"), "ctrl-c (0x03) delivered via triggerDataEvent, not a raw socket frame");
  assert.ok(!(await page.$eval("#ah-ctrl", (b) => b.classList.contains("armed"))), "ctrl disarms after use");
});

await check("sticky Shift + tab sends back-tab (CSI Z) -- the Claude Code permission-mode chord", async (page) => {
  await page.goto(base + "/");
  await page.waitForSelector("#ah-shift");
  await page.tap("#ah-shift");
  assert.ok(await page.$eval("#ah-shift", (b) => b.classList.contains("armed")), "shift armed after tap");
  // Row 1 order is [ctrl, shift, esc, tab, up, down, left, right] -> tab is index 3.
  const keys = await page.$$("#ah-keybar .ah-key");
  await keys[3].tap();
  const sent = await page.evaluate(() => window.__data);
  assert.ok(sent.some((s) => s === "\x1b[Z"), "back-tab (ESC [ Z) delivered");
  assert.ok(!(await page.$eval("#ah-shift", (b) => b.classList.contains("armed"))), "shift disarms after use");
  // Plain tab still works when shift is not armed.
  await keys[3].tap();
  const sent2 = await page.evaluate(() => window.__data);
  assert.ok(sent2.some((s) => s === "\t"), "plain tab unchanged");
});

await check("abc key summons the phone keyboard by focusing xterm's textarea; second tap dismisses", async (page) => {
  await page.goto(base + "/");
  await page.waitForSelector("#ah-abc");
  await page.tap("#ah-abc");
  const focused = await page.evaluate(
    () => document.activeElement && document.activeElement.classList.contains("xterm-helper-textarea")
  );
  assert.ok(focused, "xterm textarea focused -> OS keyboard would appear");
  assert.ok(await page.$eval("#ah-abc", (b) => b.classList.contains("armed")), "abc reads armed while summoned");
  await page.tap("#ah-abc");
  const stillFocused = await page.evaluate(
    () => document.activeElement && document.activeElement.classList.contains("xterm-helper-textarea")
  );
  assert.ok(!stillFocused, "second tap blurs -> keyboard dismissed");
});

await check("key-bar taps reach the pty via xterm's data pipe WITHOUT focusing the textarea (no keyboard pop)", async (page) => {
  await page.goto(base + "/");
  await page.waitForSelector("#ah-keybar .ah-key");
  const keys = await page.$$("#ah-keybar .ah-key");
  await keys[2].tap(); // esc (row 1, index 2 -- after ctrl, shift)
  const sent = await page.evaluate(() => window.__data);
  assert.ok(sent.some((s) => s === "\x1b"), "Escape (ESC) delivered through xterm's onData path");
  // The whole point: input arrived without focusing the hidden textarea, so the
  // phone keyboard is never summoned by a key-bar tap.
  const focused = await page.evaluate(
    () => !!document.activeElement && document.activeElement.classList.contains("xterm-helper-textarea")
  );
  assert.ok(!focused, "terminal textarea NOT focused -> soft keyboard not summoned");
});

await check("touch drag over the terminal bridges to wheel events (tmux scrollback reachable by finger)", async (page) => {
  await page.goto(base + "/");
  await page.waitForSelector("#terminal-container .xterm-screen", { state: "attached" });
  await page.waitForSelector("#ah-header");
  // Real touch input via CDP -- the same dispatch the phone hardware produces
  // (and the pattern proven against real ttyd+tmux while diagnosing task #31).
  const cdp = await page.context().newCDPSession(page);
  const drag = async (fromY, toY, steps = 10) => {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 195, y: fromY }] });
    for (let i = 1; i <= steps; i++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove", touchPoints: [{ x: 195, y: fromY + ((toY - fromY) * i) / steps }],
      });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  await drag(250, 520); // finger moves DOWN = scroll UP into history
  let wheels = await page.evaluate(() => window.__wheels);
  assert.ok(wheels.length >= 5, "a 270px drag synthesizes a stream of wheel events (got " + wheels.length + ")");
  assert.ok(wheels.every((w) => w.deltaY < 0), "downward drag = wheel-up (negative deltaY) = into scrollback");
  assert.ok(wheels.every((w) => w.deltaMode === 0), "pixel deltaMode, so xterm's wheel math applies unchanged");
  const total = wheels.reduce((s, w) => s + Math.abs(w.deltaY), 0);
  assert.ok(total >= 200 && total <= 300, "~1:1 finger travel to scroll distance (got " + total + "px)");
  await page.evaluate(() => { window.__wheels = []; });
  await drag(520, 300); // reverse: finger UP = back toward the live bottom
  wheels = await page.evaluate(() => window.__wheels);
  assert.ok(wheels.length >= 3 && wheels.every((w) => w.deltaY > 0), "upward drag = wheel-down (positive deltaY)");
});

await check("paste key is present in the key bar", async (page) => {
  await page.goto(base + "/");
  await page.waitForSelector("#ah-keybar .ah-key");
  const labels = await page.$$eval("#ah-keybar .ah-key", (els) => els.map((e) => e.textContent));
  assert.ok(labels.includes("paste"), "a 'paste' key exists for dropping the clipboard into the terminal");
});

await check("link grabber reconstructs a URL wrapped across terminal rows", async (page) => {
  await page.goto(base + "/");
  await page.waitForSelector("#ah-link");
  // A realistic OAuth URL split across 3 wrapped rows (isWrapped on rows 2-3),
  // plus noise above it. extractUrls() must rejoin them into one URL.
  await page.evaluate(() => window.__setRows([
    { text: "Visit this URL to authenticate the Notion MCP server:" },
    { text: "https://api.notion.com/v1/oauth/authorize?client_id=abc123" },
    { text: "&response_type=code&owner=user&redirect_uri=https%3A%2F%2Floc", wrapped: true },
    { text: "alhost%3A8123%2Fcallback&state=xyz789", wrapped: true },
    { text: "Waiting for authorization..." },
  ]));
  await page.tap("#ah-link");
  await page.waitForSelector("#ah-links.show .u");
  const url = await page.$eval("#ah-links .u", (el) => el.textContent);
  assert.ok(url.startsWith("https://api.notion.com/v1/oauth/authorize?client_id=abc123"), "starts right");
  assert.ok(url.includes("callback&state=xyz789"), "the wrapped tail is rejoined: " + url);
  assert.ok(!/\s/.test(url), "no stray whitespace stitched in");
  // the Open link points at the full URL
  const href = await page.$eval("#ah-links a.open", (a) => a.getAttribute("href"));
  assert.ok(href.includes("state=xyz789"), "open link carries the full URL");
});

await check("link grabber rejoins a HARD-wrapped URL (claude's OAuth panel; no isWrapped)", async (page) => {
  await page.goto(base + "/");
  await page.waitForSelector("#ah-link");
  // Exactly how `claude` prints its OAuth URL: hard-wrapped inside a panel at a
  // width NARROWER than the terminal, with real newlines -- so NONE of these
  // rows carry isWrapped, and each fragment is shorter than the terminal. The
  // fragments are pure URL-safe chars; a blank line then a prose line end it.
  // This is the case Steve hit where only "...authorize?code=true" got copied.
  // The fragments carry a 2-space panel indent (claude's /mcp OAuth prompt does
  // this), so continuation rows are NOT flush-left -- the exact case that made
  // the grabber stop at "&code_challenge=...". The indent must be tolerated.
  await page.evaluate(() => window.__setRows([
    { text: "  If your browser doesn't open, copy this URL manually (c to copy)" },
    { text: "  https://claude.com/cai/oauth/authorize?code=t" },
    { text: "  rue&client_id=9d1c250a-e61b-44d9-88ed-5944d19" },
    { text: "  62f5e&response_type=code&redirect_uri=https%3" },
    { text: "  A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fc" },
    { text: "  allback&scope=user%3Ainference&code_challeng" },
    { text: "  e=1L768oc2iH1EFQmQC26JmlcQzklGY61v7H4t5s118&s" },
    { text: "  tate=noqXuQG5jOVWkiQqmcZMuFjhAouER4Lcxfl8Usm" },
    { text: "" },
    { text: "  Paste code here if prompted >" },
  ]));
  await page.tap("#ah-link");
  await page.waitForSelector("#ah-links.show .u");
  const url = await page.$eval("#ah-links .u", (el) => el.textContent);
  assert.ok(url.startsWith("https://claude.com/cai/oauth/authorize?code=true"), "scheme + first param rejoined: " + url);
  assert.ok(url.includes("client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e"), "client_id spans the row break");
  assert.ok(url.includes("code_challenge=1L768"), "code_challenge spans the row break");
  assert.ok(url.includes("state=noqXuQG5jOVWkiQqmcZMuFjhAouER4Lcxfl8Usm"), "state (the last param) is included");
  assert.ok(!/\s/.test(url), "no whitespace stitched in (prose line not appended)");
});

await check("link grabber shows an empty state when there are no URLs", async (page) => {
  await page.goto(base + "/");
  await page.waitForSelector("#ah-link");
  await page.evaluate(() => window.__setRows([{ text: "just some output, no links here" }]));
  await page.tap("#ah-link");
  await page.waitForSelector("#ah-links.show .empty");
});

await check("fleet switcher survives junk in localStorage (shell still fully builds)", async (page) => {
  // A non-array value or junk elements must not throw inside build() -- that
  // would half-build the shell (no keybar/reconnect overlay) on every load.
  await page.addInitScript(() => {
    localStorage.setItem("agenthost_fleet", JSON.stringify({ evil: "not-an-array" }));
  });
  await page.goto(base + "/");
  await page.waitForSelector("#ah-keybar"); // built AFTER the fleet block: proves no throw
  // Phone width: the host label is dropped from the header, so the fleet
  // menu is reached through the compact Aa control's "boxes" entry.
  await page.tap("#ah-fsize");
  await page.tap("#ah-pboxes");
  await page.waitForSelector("#ah-fleet .ah-fleet-row"); // self-registered despite junk
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("agenthost_fleet")));
  assert.deepEqual(stored, ["127.0.0.1"], "junk replaced with a clean self-registered list");
});

await check("fleet switcher: host label lists visited boxes and links to them", async (page) => {
  // Seed a second box this "phone" has visited before loading the page.
  await page.addInitScript(() => {
    localStorage.setItem("agenthost_fleet", JSON.stringify(["other-box.fly.dev"]));
  });
  await page.goto(base + "/");
  await page.waitForSelector("#ah-fsize");
  await page.tap("#ah-fsize"); // phone width: fleet lives under Aa > boxes
  await page.tap("#ah-pboxes");
  await page.waitForSelector("#ah-fleet .ah-fleet-row");
  const rows = await page.$$eval("#ah-fleet .ah-fleet-row", (as) => as.map((a) => ({ href: a.getAttribute("href"), text: a.textContent })));
  assert.equal(rows.length, 2, "the seeded box + this box");
  assert.ok(rows.some((r) => r.href === "https://other-box.fly.dev/"), "other box links out");
  assert.ok(rows.some((r) => r.text.includes("here")), "current box marked");
  // current host was self-registered into the fleet list
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("agenthost_fleet")));
  assert.equal(stored.length, 2, "self added alongside the seeded box");
  assert.ok(stored.includes("127.0.0.1"), "this box's hostname stored");
  await page.click("#ah-fleet-close");
  await page.waitForFunction(() => document.getElementById("ah-fleet").style.display === "none");
});

await check("A+ raises xterm font size and persists (via the compact Aa popover at phone width)", async (page) => {
  await page.goto(base + "/");
  await page.waitForSelector("#ah-fsize");
  // At phone width the A-/A+ pair is behind the compact Aa control.
  assert.equal(await page.$eval("#ah-fplus", (b) => getComputedStyle(b).display), "none",
    "inline A+ hidden at phone width");
  await page.tap("#ah-fsize");
  await page.waitForSelector("#ah-fpop.show");
  await page.tap("#ah-pplus");
  assert.equal(await page.evaluate(() => window.term.options.fontSize), 16);
  assert.equal(await page.evaluate(() => localStorage.getItem("agenthost_font_" + location.hostname)), "16");
  // Tapping outside closes the popover (it must never linger over content).
  await page.tap("#terminal-container");
  await page.waitForFunction(() => !document.getElementById("ah-fpop").classList.contains("show"));
});

await check("chat: send a message, streamed reply renders, persists across reload", async (page) => {
  await page.goto(base + "/chat");
  await page.fill("#input", "hello agent");
  await page.click("#send");
  await page.waitForFunction(() => {
    const a = [...document.querySelectorAll(".msg.agent")].pop();
    return a && a.textContent.includes("you said: hello agent");
  }, { timeout: 4000 });
  assert.ok(await page.$(".msg.me"), "user bubble present");
  await page.reload();
  assert.ok(await page.$eval(".msg.me", (m) => m.textContent.includes("hello agent")), "history restored from localStorage");
});

await check("chat: busy status renders as a muted system line, then clears when streaming starts", async (page) => {
  await page.goto(base + "/chat");
  await page.fill("#input", "busy test");
  await page.click("#send");
  // The status event lands immediately and renders as a .sys line (NOT a bubble).
  await page.waitForSelector("#thread .sys", { timeout: 4000 });
  const txt = await page.$eval("#thread .sys", (el) => el.textContent);
  assert.ok(txt.includes("queued"), "status says the message is queued: " + txt);
  assert.ok(txt.includes("scheduled job"), "status names what holds the slot");
  assert.ok(!(await page.$eval("#thread .sys", (el) => el.classList.contains("msg"))), "status line is not a chat bubble");
  // Once streaming starts, the status line is removed and the reply renders.
  await page.waitForFunction(() => {
    const a = [...document.querySelectorAll(".msg.agent")].pop();
    return a && a.textContent.includes("queued reply: busy test");
  }, { timeout: 5000 });
  assert.equal(await page.$("#thread .sys"), null, "status line removed once streaming starts");
  // ...and it never lands in the persisted history.
  await page.reload();
  assert.ok(!(await page.$("#thread .sys")), "status line not persisted across reload");
});

await check("chat: no empty reply bubble while queued behind a scheduled job", async (page) => {
  await page.goto(base + "/chat");
  await page.fill("#input", "busy test");
  await page.click("#send");
  await page.waitForSelector("#thread .sys", { timeout: 4000 });
  // While queued: user bubble + chip + status line, but NO eager empty reply
  // bubble shimmering as if the run had started.
  assert.equal(await page.$("#thread .msg.agent"), null, "no eager reply bubble while queued");
  assert.ok(await page.$(".msg.me .qchip"), "user bubble carries the queued chip");
  // When the turn starts the reply bubble appears and streams normally.
  await page.waitForSelector("#thread .msg.agent", { timeout: 5000 });
  await page.waitForFunction(() => !document.querySelector("#thread .msg.streaming"), null, { timeout: 5000 });
  const txt = await page.$eval("#thread .msg.agent", (el) => el.textContent);
  assert.ok(txt.includes("queued reply"), "reply streamed after the queue cleared: " + txt);
});

await check("chat: reload keeps a queued send interleaved with the replies", async (page) => {
  await page.goto(base + "/chat");
  await page.fill("#input", "slow 900");
  await page.click("#send");
  // Small gap so the second send's timestamp is strictly later than the
  // first reply's turn-start stamp (same-millisecond ties are untestable).
  await page.waitForTimeout(60);
  await page.fill("#input", "second");
  await page.click("#send");
  await page.waitForFunction(() =>
    document.querySelectorAll("#thread .msg.agent").length === 2 &&
    !document.querySelector("#thread .msg.streaming"), null, { timeout: 8000 });
  await page.reload();
  await page.waitForSelector("#thread .msg.agent", { timeout: 4000 });
  const msgs = await page.$$eval("#thread .msg", (els) =>
    els.map((e) => (e.className.indexOf("me") !== -1 ? "me:" : "agent:") + e.textContent));
  // Save order is me/me/agent/agent (replies save when they finish); the
  // reload must restore the interleaved order the live view had.
  assert.deepEqual(msgs.map((s) => s.split(":")[0]), ["me", "agent", "me", "agent"],
    "interleaved on reload: " + JSON.stringify(msgs));
  assert.ok(msgs[1].includes("slow 900"), "first reply sits under the first message");
  assert.ok(msgs[3].includes("second"), "second reply sits under the second message");
});

await check("chat active tab is 'chat' and links back to terminal", async (page) => {
  await page.goto(base + "/chat");
  await page.waitForSelector("#tabs a.on", { timeout: 4000 });
  assert.equal(await page.$eval("#tabs a.on", (a) => a.textContent), "chat");
  assert.equal(await page.$eval('#tabs a:not(.on)', (a) => a.getAttribute("href")), "/");
});

await check("loops page renders chrome with the loops tab active and the job card", async (page) => {
  await page.goto(base + "/cron");
  await page.waitForSelector("#hdr");
  await page.waitForSelector("#tabs a.on", { timeout: 4000 });
  assert.equal(await page.$eval("#tabs a.on", (a) => a.textContent), "loops");
  await page.waitForSelector("#jobs .card", { timeout: 4000 });
  assert.equal((await page.$$("#jobs .card")).length, 1, "one job card");
  assert.ok(
    await page.$eval("#jobs .card .jname", (el) => el.textContent.includes("Morning briefing")),
    "job name shown on the card"
  );
});

await check("tapping a job expands its runs; the failed run carries .err", async (page) => {
  await page.goto(base + "/cron");
  await page.waitForSelector("#jobs .card");
  await page.tap("#jobs .card .jmeta"); // tap the meta line, clear of the delete button
  await page.waitForSelector("#jobs .card .runs .run", { timeout: 4000 });
  assert.equal((await page.$$("#jobs .card .runs .run")).length, 2, "both runs render");
  assert.ok(await page.$("#jobs .card .runs .run.err"), "failed run has the .err class");
  assert.ok(
    await page.$eval("#jobs .card .runs .run pre", (p) => p.textContent.includes("briefing text")),
    "run output rendered"
  );
});

await check("add-job form POSTs and a second job card appears", async (page) => {
  await page.goto(base + "/cron");
  await page.waitForSelector("#jobs .card");
  await page.fill("#fname", "Nightly sweep");
  await page.fill("#fcron", "30 2 * * *");
  await page.fill("#fprompt", "tidy up the work dir");
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/cron/jobs") && r.request().method() === "POST"),
    page.click("#add"),
  ]);
  assert.equal(resp.status(), 200);
  const posted = resp.request().postDataJSON();
  assert.equal(posted.name, "Nightly sweep");
  assert.equal(posted.cron, "30 2 * * *");
  assert.equal(typeof posted.tzOffsetMin, "number", "phone tz offset sent");
  await page.waitForFunction(
    () => document.querySelectorAll("#jobs .card").length === 2, { timeout: 4000 });
  assert.ok(
    await page.$$eval("#jobs .card .jname", (els) =>
      els.some((el) => el.textContent.includes("Nightly sweep"))),
    "new job card shows its name"
  );
});

await check("dev terminal nav: pills mirror the gate's APPS list (nav entries only)", async (page) => {
  await page.goto(base + "/");
  await page.waitForSelector("#ah-tabs a", { timeout: 4000 });
  const tabs = await page.$$eval("#ah-tabs a", (as) => as.map((a) => ({ href: a.getAttribute("href"), text: a.textContent })));
  // The dev nav is APPS minus nav:false entries (command center | chat |
  // loops); terminal/hermes/codex/ollama stay routable but pill-less --
  // they're reached through Command Center.
  const navApps = APPS.filter((a) => a.nav !== false);
  assert.deepEqual(tabs.map((t) => t.href), navApps.map((a) => a.href), "hrefs come straight from gate.js APPS nav entries");
  assert.deepEqual(tabs.map((t) => t.text), navApps.map((a) => a.label), "labels too (cron is customer-named 'loops')");
  assert.equal(await page.$("#ah-tabs a.on"), null, "terminal page is a deep surface: no active pill");
});

// ---- legal brand: chat-first tab order on the terminal page ------------------
// The gate stamps <body data-brand="legal"> on the proxied ttyd page (the rig
// mirrors it via ?brand=legal); the appshell must re-order its nav to
// chat | loops | terminal, keep the terminal reachable through the ?terminal
// bypass href, and wear the legal wordmark. Everything else (key bar, dot,
// header fit) is brand-independent.

await check("legal terminal nav: chat-first order (terminal last); terminal href carries the redirect bypass", async (page) => {
  await page.goto(base + "/?brand=legal");
  await page.waitForSelector("#ah-tabs a", { timeout: 4000 });
  assert.equal(await page.$eval("body", (b) => b.getAttribute("data-brand")), "legal", "rig stamped the body");
  const tabs = await page.$$eval("#ah-tabs a", (as) => as.map((a) => ({ href: a.getAttribute("href"), text: a.textContent })));
  // Legal is chat | loops | terminal: no Command Center (single-engine box),
  // terminal moved to the end (this mirrors NAV_JS's filter + sort exactly).
  const legalApps = APPS.filter((a) => a.id === "chat" || a.id === "loops" || a.id === "terminal")
    .sort((a, b) => (a.id === "terminal") - (b.id === "terminal"));
  assert.deepEqual(tabs.map((t) => t.text), legalApps.map((a) => a.label), "chat-first order, terminal last");
  assert.deepEqual(tabs.map((t) => t.href),
    legalApps.map((a) => (a.id === "terminal" ? "/?terminal=1" : a.href)),
    "routes unchanged; terminal bypasses the legal '/'->'/chat' redirect");
  assert.equal(await page.$eval("#ah-tabs a.on", (a) => a.textContent), "terminal", "on the terminal page the terminal tab is active");
  assert.ok((await page.$eval("#ah-brand", (el) => el.textContent)).includes("Legal HQ"), "legal wordmark");
  assert.ok(await page.$("#ah-keybar"), "key bar unaffected by brand");
});

// ---- Command Center (the combined 2+3 design) --------------------------------
// One screen: five-segment engine switcher with live panels on top, the
// cross-engine activity feed below. The rig serves the real cc.html and a
// /cc/state fixture shaped exactly like gate.js's aggregate route.

await check("command center: state populates the panels; seg switching swaps them in place", async (page) => {
  await page.goto(base + "/cc");
  // /cc/state landed when the ollama sub-label resolves from "—".
  await page.waitForFunction(() => document.querySelector('[data-sub="ollama"]').textContent === "serving", null, { timeout: 4000 });
  assert.ok(await page.$eval('.panel[data-panel="claude"]', (p) => p.classList.contains("show")), "claude panel is the default");
  assert.match(await page.$eval('[data-v="claude-today"]', (el) => el.textContent), /\$2\.13/, "claude usage line carries today's cost");
  assert.match(await page.$eval('[data-v="claude-last"]', (el) => el.textContent), /12 min ago/, "last-active from the usage stamp");
  await page.click('#ccseg button[data-eng="hermes"]');
  assert.ok(await page.$eval('.panel[data-panel="hermes"]', (p) => p.classList.contains("show")), "hermes panel swapped in");
  assert.ok(!(await page.$eval('.panel[data-panel="claude"]', (p) => p.classList.contains("show"))), "claude panel swapped out");
  assert.match(await page.$eval('[data-v="hermes-dash"]', (el) => el.textContent), /up · v0\.18\.2/, "hermes dashboard status rendered");
  await page.click('#ccseg button[data-eng="term"]');
  const wins = await page.$$eval("#termwins .twin", (els) => els.map((e) => ({ name: e.textContent, active: e.classList.contains("active") })));
  assert.deepEqual(wins.map((w) => w.name), ["bash", "codex", "ollama", "hermes"], "real tmux windows listed");
  assert.equal(wins.find((w) => w.active).name, "codex", "active window highlighted");
});

await check("command center: feed renders every engine color-coded; tapping an engine row jumps its panel", async (page) => {
  await page.goto(base + "/cc");
  await page.waitForFunction(() => document.querySelectorAll("#feed .item").length === 4, null, { timeout: 4000 });
  const rows = await page.$$eval("#feed .item", (els) => els.map((e) => ({
    who: e.querySelector(".who").textContent,
    tag: e.tagName,
  })));
  assert.deepEqual(rows.map((r) => r.who), ["Hermes", "Claude", "Board", "Loops"], "feed order = fixture order (newest first)");
  assert.equal(rows[0].tag, "BUTTON", "engine rows are tappable");
  assert.equal(rows[2].tag, "DIV", "board rows have no panel to jump to");
  await page.click("#feed .item"); // the Hermes row
  assert.ok(await page.$eval('.panel[data-panel="hermes"]', (p) => p.classList.contains("show")), "tapping a feed row jumps to that engine's panel");
});

await check("command center: actions carry the real routes (chat, lazy claude window, engine surfaces)", async (page) => {
  await page.goto(base + "/cc");
  await page.waitForSelector(".panel.show", { timeout: 4000 });
  const claudeActions = await page.$$eval('.panel[data-panel="claude"] .pbtn', (as) => as.map((a) => a.getAttribute("href")));
  assert.deepEqual(claudeActions, ["/?window=claude", "/chat"], "claude: terminal session (lazy window) + open chat");
  assert.equal(await page.$eval('.panel[data-panel="hermes"] .pbtn', (a) => a.getAttribute("href")), "/hermes/");
  assert.equal(await page.$eval('.panel[data-panel="codex"] .pbtn', (a) => a.getAttribute("href")), "/?window=codex");
  assert.equal(await page.$eval('.panel[data-panel="ollama"] .pbtn', (a) => a.getAttribute("href")), "/?window=ollama");
  assert.equal(await page.$eval('.panel[data-panel="term"] .pbtn', (a) => a.getAttribute("href")), "/");
});

await check("command center nav: the command center pill is active on /cc", async (page) => {
  await page.goto(base + "/cc");
  await page.waitForSelector("#tabs a.on", { timeout: 4000 });
  assert.equal(await page.$eval("#tabs a.on", (a) => a.textContent), "command center");
});

await check("legal terminal header still fits at 390px (tabs fully visible, no h-scroll)", async (page) => {
  await page.goto(base + "/?brand=legal");
  await page.waitForSelector("#ah-tabs a", { timeout: 4000 });
  assertHeaderFits(await measureHeaderFit(page, "#ah-tabs"), "390 legal terminal");
}, IPHONE);

await check("legal terminal header still fits at 375px", async (page) => {
  await page.goto(base + "/?brand=legal");
  await page.waitForSelector("#ah-tabs a", { timeout: 4000 });
  assertHeaderFits(await measureHeaderFit(page, "#ah-tabs"), "375 legal terminal");
}, IPHONE_SE);

await check("voice: mic button shows when SpeechRecognition exists, hidden when it doesn't", async (page) => {
  // Stub the API present BEFORE the page script runs -> mic visible in #bar.
  await page.addInitScript(() => {
    window.webkitSpeechRecognition = function () {
      this.start = function () {}; this.stop = function () {};
    };
  });
  await page.goto(base + "/chat");
  await page.waitForSelector("#mic");
  assert.equal(await page.$eval("#bar #mic", (b) => getComputedStyle(b).display !== "none"), true,
    "mic visible in #bar when speech recognition is available");

  // Fresh context with the API removed -> mic hidden at load (feature-detect).
  const ctx2 = await browser.newContext({ viewport: IPHONE, ...IPHONE });
  const p2 = await ctx2.newPage();
  await p2.addInitScript(() => {
    try { delete window.webkitSpeechRecognition; } catch (e) { window.webkitSpeechRecognition = undefined; }
    try { delete window.SpeechRecognition; } catch (e) { window.SpeechRecognition = undefined; }
  });
  await p2.goto(base + "/chat");
  await p2.waitForSelector("#mic", { state: "attached" });
  assert.equal(await p2.$eval("#mic", (b) => getComputedStyle(b).display), "none",
    "mic hidden when speech recognition is absent");
  await ctx2.close();
});

await check("brain: a /brain query streams a summary bubble", async (page) => {
  await page.goto(base + "/chat");
  await page.fill("#input", "/brain deployment notes");
  await page.click("#send");
  await page.waitForFunction(() => {
    const a = [...document.querySelectorAll(".msg.agent")].pop();
    return a && a.textContent.includes("brain summary:");
  }, { timeout: 4000 });
  assert.ok(
    await page.$eval(".msg.agent:last-of-type", (a) => a.textContent.includes("your notes on deployment notes")),
    "summary bubble carries the query"
  );
});

await check("push: enabling notifications POSTs the subscription to /push/subscribe", async (page) => {
  await page.addInitScript(() => {
    // Notification: permission already granted; requestPermission resolves granted.
    window.Notification = function () {};
    window.Notification.permission = "granted";
    window.Notification.requestPermission = () => Promise.resolve("granted");
    // PushManager present so the feature gate passes.
    window.PushManager = function () {};
    // Stub the service worker registration + push subscribe end-to-end.
    const reg = {
      pushManager: {
        subscribe: () => Promise.resolve({
          endpoint: "https://push.example/abc",
          toJSON() { return { endpoint: "https://push.example/abc", keys: { p256dh: "x", auth: "y" } }; },
        }),
      },
    };
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { register: () => Promise.resolve(reg), ready: Promise.resolve(reg), addEventListener() {} },
    });
  });
  await page.goto(base + "/chat");
  await page.waitForSelector("#bell");
  assert.equal(await page.$eval("#bell", (b) => getComputedStyle(b).display !== "none"), true,
    "bell visible when SW + PushManager + Notification are present");
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/push/subscribe") && r.request().method() === "POST", { timeout: 4000 }),
    page.click("#bell"),
  ]);
  assert.equal(resp.status(), 200);
  const posted = resp.request().postDataJSON();
  assert.equal(posted.endpoint, "https://push.example/abc", "subscription endpoint POSTed");
});

// ---- header fit at phone widths (Steve: "top of the menu is cut off on the
// right side where the chat bubble is" -- tabs truncated at 390pt iPhone). ----

await check("terminal header fits at 390px: tabs fully visible, host label dropped, bell+link kept", async (page) => {
  await page.goto(base + "/");
  await page.waitForSelector("#ah-tabs a", { timeout: 4000 });
  assertHeaderFits(await measureHeaderFit(page, "#ah-tabs"), "390 terminal");
  assert.equal(await page.$eval("#ah-host", (el) => getComputedStyle(el).display), "none",
    "host label dropped at phone width");
  // Functional controls must survive the squeeze.
  assert.ok(await page.$eval("#ah-bell", (el) => el.offsetWidth > 0), "bell still visible");
  assert.ok(await page.$eval("#ah-link", (el) => el.offsetWidth > 0), "link grabber still visible");
  assert.ok(await page.$eval("#ah-fsize", (el) => el.offsetWidth > 0), "compact Aa control visible");
}, IPHONE);

await check("terminal header fits at 375px (iPhone SE/mini): tabs fully visible, no page h-scroll", async (page) => {
  await page.goto(base + "/");
  await page.waitForSelector("#ah-tabs a", { timeout: 4000 });
  assertHeaderFits(await measureHeaderFit(page, "#ah-tabs"), "375 terminal");
}, IPHONE_SE);

await check("terminal header fits at 360px (small Android): bar scrolls, no page h-scroll", async (page) => {
  await page.goto(base + "/");
  await page.waitForSelector("#ah-tabs a", { timeout: 4000 });
  assertHeaderFits(await measureHeaderFit(page, "#ah-tabs"), "360 terminal");
}, ANDROID_360);

await check("chat header fits at 360px: bar scrolls, no page h-scroll", async (page) => {
  await page.goto(base + "/chat");
  await page.waitForSelector("#tabs a", { timeout: 4000 });
  assertHeaderFits(await measureHeaderFit(page, "#tabs"), "360 chat");
}, ANDROID_360);

await check("loops header fits at 360px: bar scrolls, no page h-scroll", async (page) => {
  await page.goto(base + "/cron");
  await page.waitForSelector("#tabs a", { timeout: 4000 });
  assertHeaderFits(await measureHeaderFit(page, "#tabs"), "360 loops");
}, ANDROID_360);

await check("chat header fits at 375px: tabs fully visible, no page h-scroll", async (page) => {
  await page.goto(base + "/chat");
  await page.waitForSelector("#tabs a", { timeout: 4000 });
  assertHeaderFits(await measureHeaderFit(page, "#tabs"), "375 chat");
  assert.equal(await page.$eval("#host", (el) => getComputedStyle(el).display), "none",
    "host label dropped at phone width");
}, IPHONE_SE);

await check("chat header fits at 390px: tabs fully visible, no page h-scroll", async (page) => {
  await page.goto(base + "/chat");
  await page.waitForSelector("#tabs a", { timeout: 4000 });
  assertHeaderFits(await measureHeaderFit(page, "#tabs"), "390 chat");
}, IPHONE);

await check("desktop keeps the inline A-/A+ pair and the host label (compact control hidden)", async (page) => {
  await page.goto(base + "/");
  await page.waitForSelector("#ah-tabs a", { timeout: 4000 });
  assertHeaderFits(await measureHeaderFit(page, "#ah-tabs"), "1280 terminal");
  assert.notEqual(await page.$eval("#ah-fplus", (b) => getComputedStyle(b).display), "none", "A+ inline on desktop");
  assert.equal(await page.$eval("#ah-fsize", (b) => getComputedStyle(b).display), "none", "compact Aa hidden on desktop");
  assert.notEqual(await page.$eval("#ah-host", (el) => getComputedStyle(el).display), "none", "host label shown on desktop");
  await page.click("#ah-fplus"); // the desktop pair still works
  assert.equal(await page.evaluate(() => window.term.options.fontSize), 16);
}, DESKTOP);

// ---- send-while-busy (Steve: "can't send two fast messages") ----------------

await check("chat: send stays enabled mid-run; queued sends get a chip and dispatch in order", async (page) => {
  await page.goto(base + "/chat");
  await page.fill("#input", "slow 1500 first");
  await page.click("#send");
  // The send button must NOT disable while the first run streams.
  assert.equal(await page.$eval("#send", (b) => b.disabled), false, "send enabled during a run");
  await page.fill("#input", "second message");
  await page.click("#send");
  await page.fill("#input", "third message");
  await page.click("#send");
  // Queued messages render as NORMAL user bubbles with a subtle "queued" chip.
  await page.waitForFunction(() => document.querySelectorAll(".msg.me .qchip").length === 2, { timeout: 4000 });
  assert.equal(await page.$eval(".msg.me .qchip", (el) => el.textContent), "queued");
  // No empty reply bubble for a queued message while it waits its turn:
  // exactly one agent bubble (the streaming first reply) exists right now.
  assert.equal((await page.$$(".msg.agent")).length, 1, "queued replies not pre-rendered");
  // First reply lands, then the queued ones dispatch in send order.
  await page.waitForFunction(() => {
    const t = [...document.querySelectorAll(".msg.agent")].map((a) => a.textContent);
    return t.some((x) => x.includes("you said: slow 1500 first"));
  }, { timeout: 6000 });
  await page.waitForFunction(() => {
    const t = [...document.querySelectorAll(".msg.agent")].map((a) => a.textContent);
    return t.some((x) => x.includes("you said: third message"));
  }, { timeout: 6000 });
  const replies = await page.$$eval(".msg.agent", (els) => els.map((e) => e.textContent));
  assert.ok(replies[0].includes("slow 1500 first") && replies[1].includes("second message")
    && replies[2].includes("third message"), "replies in send order: " + JSON.stringify(replies));
  // Every chip cleared once its turn ran.
  assert.equal(await page.$(".qchip"), null, "chips cleared after dispatch");
  assert.equal(await page.$("#thread .sys"), null, "busy status line cleared");
  await page.waitForFunction(() => document.getElementById("dot").className === "",
    { timeout: 4000 }); // dot back to idle once the last run's done lands
});

// ---- Loops recipes (both brands) --------------------------------------------

await check("loops: page heading, subhead, and loops copy replace cron-speak", async (page) => {
  await page.goto(base + "/cron");
  await page.waitForSelector("h1");
  assert.equal(await page.$eval("h1", (h) => h.textContent), "Loops");
  assert.ok((await page.$eval("#pgsub", (p) => p.textContent))
    .includes("agents that run on schedule"), "subhead present");
  assert.equal(await page.$eval("#add", (b) => b.textContent), "add loop");
}, IPHONE);

await check("loops: dev recipes render with cron chips; tapping one fills the form", async (page) => {
  await page.goto(base + "/cron");
  await page.waitForSelector("#recipes .recipe");
  const cards = await page.$$eval("#recipes .recipe", (els) => els.map((el) => ({
    name: el.querySelector(".rname").textContent,
    desc: el.querySelector(".rdesc").textContent,
    cron: el.querySelector(".rcron").textContent,
  })));
  assert.deepEqual(cards.map((c) => c.name),
    ["Morning briefing", "PR babysitter", "Repo digest", "Dependency check"],
    "the four dev recipes in order");
  for (const c of cards) {
    assert.ok(c.desc.length > 10, `recipe "${c.name}" has a what-it-does line`);
    assert.match(c.cron, /^\S+ \S+ \* \* \S+$/, `recipe "${c.name}" chip is a cron expression: ${c.cron}`);
  }
  assert.equal(cards[1].cron, "0 */2 * * *", "PR babysitter runs every 2h");
  // Tap-to-fill: the second recipe lands in the add-a-loop form.
  await page.tap("#recipes .recipe:nth-child(2)");
  assert.equal(await page.$eval("#fname", (i) => i.value), "PR babysitter");
  assert.equal(await page.$eval("#fcron", (i) => i.value), "0 */2 * * *");
  assert.ok((await page.$eval("#fprompt", (t) => t.value)).includes("PR"), "prompt filled");
  // The recipe row scrolls inside itself: the page never scrolls horizontally.
  const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
  const vw = await page.evaluate(() => window.innerWidth);
  assert.ok(scrollW <= vw, `no horizontal page scroll (${scrollW} vs ${vw})`);
}, IPHONE);

await check("loops: legal brand swaps in the legal recipe set and relights the board", async (page) => {
  await page.goto(base + "/cron?brand=legal");
  await page.waitForSelector("#recipes .recipe");
  assert.equal(await page.$eval("body", (b) => b.getAttribute("data-brand")), "legal",
    "gate-injected body attribute present");
  const names = await page.$$eval("#recipes .recipe .rname", (els) => els.map((e) => e.textContent));
  assert.deepEqual(names,
    ["Overnight compliance scan", "Deadline second-check", "Daily filing digest"],
    "legal recipes replace the dev four");
  assert.ok(!names.includes("PR babysitter"), "dev recipes not shown under legal");
  // Tap-to-fill works for the legal set too.
  await page.tap("#recipes .recipe:nth-child(1)");
  assert.equal(await page.$eval("#fname", (i) => i.value), "Overnight compliance scan");
  assert.match(await page.$eval("#fcron", (i) => i.value), /^\d+ \d+ \* \* \*$/, "2am local converted to a UTC cron");
  // Legal skin: bronze recipe chips, navy primary, serif wordmark.
  assert.equal(await page.$eval("#recipes .rcron", (el) => getComputedStyle(el).color),
    "rgb(140, 106, 63)", "recipe chip is bronze");
  assert.equal(await page.$eval("#add", (el) => getComputedStyle(el).backgroundColor),
    "rgb(22, 50, 79)", "primary action is navy");
  assert.ok((await page.$eval("#brand", (el) => getComputedStyle(el).fontFamily)).includes("Georgia"),
    "serif wordmark");
  assert.equal(await page.$eval("#brand", (el) => el.textContent), "Your private workspace");
}, IPHONE);

await check("loops header fits at 375px: tabs fully visible, host label dropped", async (page) => {
  await page.goto(base + "/cron");
  await page.waitForSelector("#tabs a", { timeout: 4000 });
  assertHeaderFits(await measureHeaderFit(page, "#tabs"), "375 loops");
  assert.equal(await page.$eval("#host", (el) => getComputedStyle(el).display), "none",
    "host label dropped at phone width");
}, IPHONE_SE);

await check("loops header fits at 390px under the longer legal wordmark", async (page) => {
  await page.goto(base + "/cron?brand=legal");
  await page.waitForSelector("#tabs a", { timeout: 4000 });
  assertHeaderFits(await measureHeaderFit(page, "#tabs"), "390 legal loops");
}, IPHONE);

// ---- chat: legal skin + tracked-changes redline card ------------------------

await check("chat: legal brand relights bubbles and the header label", async (page) => {
  await page.goto(base + "/chat?brand=legal");
  assert.equal(await page.$eval("#brand", (el) => el.textContent), "Your private workspace");
  assert.ok((await page.$eval("#brand", (el) => getComputedStyle(el).fontFamily)).includes("Georgia"),
    "serif wordmark");
  await page.fill("#input", "hello counsel");
  await page.click("#send");
  await page.waitForFunction(() => {
    const a = [...document.querySelectorAll(".msg.agent")].pop();
    return a && a.textContent.includes("you said: hello counsel");
  }, { timeout: 4000 });
  assert.equal(await page.$eval(".msg.me", (el) => getComputedStyle(el).backgroundColor),
    "rgb(22, 50, 79)", "user bubble is navy");
  assert.equal(await page.$eval(".msg.me", (el) => getComputedStyle(el).color),
    "rgb(255, 255, 255)", "user bubble text is white");
  assert.equal(await page.$eval(".msg.agent", (el) => getComputedStyle(el).backgroundColor),
    "rgb(243, 241, 234)", "agent bubble is paper-sink");
  assert.equal(await page.$eval(".msg.agent", (el) => getComputedStyle(el).color),
    "rgb(28, 39, 51)", "agent bubble text is ink");
}, IPHONE);

const REDLINE_MSG = "```redline\n§4.2 Indemnification — tracked changes\n" +
  "The Vendor shall [-not-] indemnify {+and hold harmless+} the Client " +
  "<img src=x onerror=window.__xss=1>.\n```";

await check("chat: a ```redline fence renders a tracked-changes card, textContent-only", async (page) => {
  await page.goto(base + "/chat");
  await page.fill("#input", REDLINE_MSG);
  await page.click("#send");
  await page.waitForSelector(".msg.agent .redline", { timeout: 4000 });
  assert.equal(await page.$eval(".msg.agent .redline .redline-h", (el) => el.textContent),
    "§4.2 Indemnification — tracked changes", "first line of the block is the header tag line");
  assert.equal(await page.$eval(".msg.agent .redline .rl-del", (el) => el.textContent), "not");
  assert.ok((await page.$eval(".msg.agent .redline .rl-del", (el) => getComputedStyle(el).textDecorationLine))
    .includes("line-through"), "deletion is struck through");
  assert.equal(await page.$eval(".msg.agent .redline .rl-ins", (el) => el.textContent), "and hold harmless");
  const bodyTxt = await page.$eval(".msg.agent .redline .redline-b", (el) => el.textContent);
  assert.ok(bodyTxt.includes("The Vendor shall") && bodyTxt.includes("the Client"), "plain text preserved");
  // The injection attempt stays TEXT: no element materialized, no handler ran.
  assert.equal(await page.$(".msg.agent .redline img"), null, "markup in model output never becomes DOM");
  assert.equal(await page.evaluate(() => window.__xss), undefined, "no script executed");
  assert.ok(bodyTxt.includes("<img"), "the markup is rendered as literal text");
}, IPHONE);

await check("chat: a redline block with no markers falls back to a plain mono card", async (page) => {
  await page.goto(base + "/chat");
  await page.fill("#input", "```redline\njust a clause with no edits at all\n```");
  await page.click("#send");
  await page.waitForSelector(".msg.agent .redline", { timeout: 4000 });
  assert.equal(await page.$(".msg.agent .redline .redline-h"), null, "no header split without markers");
  assert.equal(await page.$(".msg.agent .redline .rl-del"), null);
  assert.equal(await page.$(".msg.agent .redline .rl-ins"), null);
  assert.ok((await page.$eval(".msg.agent .redline .redline-b", (el) => el.textContent))
    .includes("just a clause with no edits at all"), "text intact in the mono card");
}, IPHONE);

await check("chat: redline marker parser unit cases (exact [-..-] / {+..+} markers only)", async (page) => {
  await page.goto(base + "/chat");
  const t = (s) => page.evaluate((x) => window.__parseRedline(x), s);
  assert.deepEqual(await t("a [-b-] c {+d+}"), [
    { t: "txt", s: "a " }, { t: "del", s: "b" }, { t: "txt", s: " c " }, { t: "ins", s: "d" },
  ], "basic del + ins with surrounding text");
  assert.deepEqual(await t("[-x-]{+y+}[-z-]"), [
    { t: "del", s: "x" }, { t: "ins", s: "y" }, { t: "del", s: "z" },
  ], "adjacent markers, no gaps");
  assert.deepEqual(await t("no markers here"), [{ t: "txt", s: "no markers here" }],
    "marker-free text is one txt token");
  assert.deepEqual(await t("dangling [-open"), [{ t: "txt", s: "dangling [-open" }],
    "an unclosed marker stays literal text");
  assert.deepEqual(await t("[+not a marker+] (-nor this-)"),
    [{ t: "txt", s: "[+not a marker+] (-nor this-)" }],
    "lookalike brackets are not markers");
  assert.deepEqual(await t("spans[-a\nb-]lines"), [
    { t: "txt", s: "spans" }, { t: "del", s: "a\nb" }, { t: "txt", s: "lines" },
  ], "a marker may span a newline");
}, IPHONE);

// Android viewport smoke: chrome + key bar still present.
await (async () => {
  const ctx = await browser.newContext({ viewport: PIXEL, ...PIXEL });
  const page = await ctx.newPage();
  try {
    await page.goto(base + "/");
    await page.waitForSelector("#ah-keybar");
    assert.equal((await page.$$("#ah-keybar .ah-key")).length, 16);
    console.log("ok   android (Pixel) viewport renders chrome + key bar"); passed++;
  } catch (e) { console.log("FAIL android viewport\n     " + e.message); process.exitCode = 1; }
  finally { await ctx.close(); }
})();

await browser.close();
server.close();
console.log(`\nui: ${passed} passed`);
