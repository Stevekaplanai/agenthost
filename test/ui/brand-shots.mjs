// Brand screenshots at phone width (390px): legal chat with a redline card,
// and the Loops board in both brands -- driven against the same rig as the UI
// tests (real chat.html / cron.html; ?brand=legal makes the rig inject
// data-brand="legal" on <body> exactly like the gate does on a legal deploy).
//
// Run: PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node test/ui/brand-shots.mjs [outdir]
// Writes <outdir>/legal-chat.png, legal-loops.png, dev-loops.png (outdir
// defaults to /tmp). Pass a second arg "375" to shoot at 375px instead.
import { startRig } from "./rig.mjs";

const EXEC = "/opt/pw-browsers/chromium";
let chromium;
try { ({ chromium } = await import("playwright-core")); }
catch { console.log("SKIP brand-shots: playwright-core not installed"); process.exit(0); }

const OUT = process.argv[2] || "/tmp";
const W = process.argv[3] === "375" ? 375 : 390;
const VP = { width: W, height: W === 375 ? 667 : 844, isMobile: true, hasTouch: true, deviceScaleFactor: W === 375 ? 2 : 3 };

const REDLINE_MSG = "Here is the tracked-changes pass on the indemnification clause:\n" +
  "```redline\n§4.2 Indemnification — tracked changes\n" +
  "The Vendor shall [-not-] indemnify {+and hold harmless+} the Client against " +
  "all third-party claims [-arising under this Agreement-]{+arising out of or " +
  "relating to this Agreement, except to the extent caused by the Client's " +
  "gross negligence+}.\n```";

const { server, port } = await startRig();
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({ executablePath: EXEC });
const ctx = await browser.newContext({ viewport: VP, ...VP });

// Legal chat with the redline card in view.
const chat = await ctx.newPage();
await chat.goto(base + "/chat?brand=legal");
await chat.evaluate(() => localStorage.clear());
await chat.reload();
await chat.fill("#input", REDLINE_MSG);
await chat.click("#send");
await chat.waitForSelector(".msg.agent .redline .rl-ins");
await chat.waitForTimeout(400); // let the rise animation settle
await chat.screenshot({ path: `${OUT}/legal-chat.png` });
console.log(`wrote ${OUT}/legal-chat.png`);

// Loops board, both brands.
for (const [brand, q] of [["legal", "?brand=legal"], ["dev", ""]]) {
  const loops = await ctx.newPage();
  await loops.goto(base + "/cron" + q);
  await loops.waitForSelector("#recipes .recipe");
  await loops.waitForSelector("#jobs .card");
  await loops.waitForTimeout(400);
  await loops.screenshot({ path: `${OUT}/${brand}-loops.png` });
  console.log(`wrote ${OUT}/${brand}-loops.png`);
  await loops.close();
}

await ctx.close();
await browser.close();
server.close();
