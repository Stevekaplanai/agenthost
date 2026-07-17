// Headless screenshots of the phone-fit work: terminal header + chat with a
// queued message, at 375 / 390 (touch) and 1280 (desktop) widths, against the
// same rig the UI tests drive (real appshell.js / chat.html, fake ttyd+claude).
//
// Run: PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node test/ui/screenshots.mjs [outdir]
// Writes <outdir>/fit-<width>-terminal.png and fit-<width>-chat-queued.png
// (outdir defaults to /tmp).
import { startRig } from "./rig.mjs";

const EXEC = "/opt/pw-browsers/chromium";
let chromium;
try { ({ chromium } = await import("playwright-core")); }
catch { console.log("SKIP screenshots: playwright-core not installed"); process.exit(0); }

const OUT = process.argv[2] || "/tmp";
const VIEWPORTS = [
  { w: 375, vp: { width: 375, height: 667, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
  { w: 390, vp: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 } },
  { w: 1280, vp: { width: 1280, height: 800 } },
];

const { server, port } = await startRig();
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({ executablePath: EXEC });

for (const { w, vp } of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: vp, ...vp });

  // Terminal page: chrome + tabs (the header Steve saw clipped).
  const term = await ctx.newPage();
  await term.goto(base + "/");
  await term.waitForSelector("#ah-tabs");
  await term.waitForTimeout(400); // let the fake ttyd mount + inset settle
  await term.screenshot({ path: `${OUT}/fit-${w}-terminal.png` });
  console.log(`wrote ${OUT}/fit-${w}-terminal.png`);

  // Chat with a queued message: first send holds the rig's agent slot for 3s,
  // the second queues behind it and carries the "queued" chip.
  const chat = await ctx.newPage();
  await chat.goto(base + "/chat");
  await chat.evaluate(() => localStorage.clear()); // no history bleed between widths
  await chat.reload();
  await chat.fill("#input", "slow 3000 summarize the overnight run");
  await chat.click("#send");
  await chat.fill("#input", "also check the deploy logs");
  await chat.click("#send");
  await chat.waitForSelector(".msg.me .qchip");
  await chat.waitForSelector("#thread .sys"); // the server's busy status line
  await chat.screenshot({ path: `${OUT}/fit-${w}-chat-queued.png` });
  console.log(`wrote ${OUT}/fit-${w}-chat-queued.png`);

  await ctx.close();
}

await browser.close();
server.close();
