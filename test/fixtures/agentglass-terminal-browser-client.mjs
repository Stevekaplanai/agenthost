import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const base = process.argv[2];
const crossPortOrigin = process.argv[3];
const dependencyRoot = String(process.env.AGENTHOST_PLAYWRIGHT_ROOT || "").trim();
const chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

if (!base) throw new Error("AgentGlass base URL argument is required");
if (!crossPortOrigin) throw new Error("cross-port proof origin argument is required");
if (!dependencyRoot) throw new Error("AGENTHOST_PLAYWRIGHT_ROOT is required");
if (!fs.existsSync(chrome)) throw new Error(`Chrome is missing at ${chrome}`);

const { chromium } = require(path.join(dependencyRoot, "node_modules", "playwright-core"));
let browser;
try {
  process.stderr.write("stage=launch\n");
  browser = await chromium.launch({ executablePath: chrome, headless: true, timeout: 30_000 });
  process.stderr.write("stage=browser-open\n");
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const preflights = [];
  const controlAttempts = [];
  const terminalControlAttempts = [];
  const crossPortRequests = [];
  const crossPortResponses = [];
  const browserProblems = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserProblems.push(`console:${message.text()}`);
  });
  page.on("pageerror", (error) => browserProblems.push(`page:${error.message}`));
  page.on("requestfailed", (request) => {
    browserProblems.push(`request:${new URL(request.url()).pathname}:${request.failure()?.errorText || "failed"}`);
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/agenthost/room" && url.searchParams.has("ah_box")) {
      controlAttempts.push({ url: request.url(), status: 0 });
    }
    if (url.pathname === "/box/settings" && url.searchParams.has("cross_port_proof")) {
      crossPortRequests.push({ method: request.method(), url: request.url() });
    }
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.pathname === "/agenthost/room" && url.searchParams.has("ah_box")) {
      const attempt = controlAttempts.find(({ url: attempted, status }) => (
        attempted === response.url() && status === 0
      ));
      if (attempt) attempt.status = response.status();
      else controlAttempts.push({ url: response.url(), status: response.status() });
    }
    if (url.pathname !== "/box/terminal/" && url.searchParams.has("ah_terminal_frame")) {
      terminalControlAttempts.push({ path: url.pathname, status: response.status() });
    }
    if (url.pathname === "/box/settings" && url.searchParams.has("cross_port_proof")) {
      crossPortResponses.push({ status: response.status(), url: response.url() });
    }
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  cdp.on("Network.requestWillBeSent", ({ request }) => {
    if (request.method === "OPTIONS") {
      preflights.push({ method: request.method, url: request.url });
    }
  });

  // Workspace is a desktop Command Center surface. Recover 2FA through the
  // real visible form first; the terminal leg below then proves the phone-width
  // opaque socket without opening another page.
  await page.setViewportSize({ width: 1440, height: 900 });
  const navigation = await page.goto(`${base}/?token=fake-agentglass-token`, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  const workspaceButton = page.getByRole("button", { name: /^Workspace/ });
  await workspaceButton.waitFor({ state: "visible", timeout: 30_000 });
  const workspaceHit = await workspaceButton.evaluate((button) => {
    const rect = button.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return {
      rect: [rect.left, rect.top, rect.width, rect.height],
      hit: hit?.getAttribute("aria-label") || hit?.className || hit?.tagName || "none",
      containsHit: Boolean(hit && button.contains(hit)),
    };
  });
  await page.evaluate(() => {
    localStorage.setItem("agentglass_boundary_sentinel", "parent-secret");
    window.__boxBoundaryProof = new Promise((resolve) => {
      addEventListener("message", (event) => {
        if (event.data?.type === "agenthost-box-boundary-proof") resolve(event.data);
      });
    });
  });
  try {
    if (!workspaceHit.containsHit) throw new Error("Workspace button is covered at its center");
    await workspaceButton.click({ force: true, timeout: 5_000 });
  } catch (error) {
    const body = (await page.locator("body").innerText({ timeout: 1_000 }).catch(() => "")).slice(0, 500);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; navigation=${navigation?.status() ?? "none"}; `
      + `content-type=${navigation?.headers()["content-type"] || "none"}; url=${page.url()}; `
      + `hit=${JSON.stringify(workspaceHit)}; body=${body || "(empty)"}; `
      + `browser=${browserProblems.slice(0, 8).join(" | ") || "none"}`,
    );
  }

  const codeField = page.locator("#box-two-factor-code");
  await codeField.waitFor({ state: "visible", timeout: 30_000 });
  const recoveryCause = await page.locator("#box-two-factor-cause").innerText();
  await codeField.fill("123456");
  await codeField.press("Enter");
  const recoveredFrame = page.locator('iframe[title="Box dashboard"]');
  await recoveredFrame.waitFor({ state: "visible", timeout: 30_000 });
  await page.frameLocator('iframe[title="Box dashboard"]').locator("#box-asset")
    .filter({ hasText: "external asset executed" }).waitFor({ state: "visible", timeout: 30_000 });
  await page.frameLocator('iframe[title="Box dashboard"]').locator("#box-module")
    .filter({ hasText: "external module executed" }).waitFor({ state: "visible", timeout: 30_000 });
  const boundary = await Promise.race([
    page.evaluate(() => window.__boxBoundaryProof),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error("opaque Box boundary proof did not finish within 30 seconds")),
      30_000,
    )),
  ]);
  const recovery = {
    cause: recoveryCause,
    frameSrc: await recoveredFrame.getAttribute("src"),
    frameText: await page.frameLocator('iframe[title="Box dashboard"]').locator("#box-task").innerText(),
    assetText: await page.frameLocator('iframe[title="Box dashboard"]').locator("#box-asset").innerText(),
    moduleText: await page.frameLocator('iframe[title="Box dashboard"]').locator("#box-module").innerText(),
  };
  process.stderr.write("stage=ui-2fa-boundary-complete\n");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    window.__terminalProof = new Promise((resolve) => {
      addEventListener("message", (event) => {
        if (event.data?.type === "agenthost-terminal-proof") resolve(event.data);
      });
    });
  });
  const boxFrame = page.frameLocator('iframe[title="Box dashboard"]');
  await boxFrame.locator("#box-open-terminal").click({ force: true });
  const nestedTerminal = boxFrame.locator('iframe[title="AgentHost terminal"]');
  await nestedTerminal.waitFor({ state: "attached", timeout: 30_000 });
  const terminalSource = await nestedTerminal.getAttribute("src");
  if (!terminalSource) throw new Error("Box terminal iframe did not receive a scoped source");
  const terminalUrl = new URL(terminalSource, base);
  const terminalFrame = {
    path: terminalUrl.pathname,
    terminalScoped: terminalUrl.searchParams.has("ah_terminal_frame"),
    broadScoped: terminalUrl.searchParams.has("ah_box"),
    hasToken: terminalUrl.searchParams.has("token"),
  };
  process.stderr.write("stage=frame-started\n");
  const result = await Promise.race([
    page.evaluate(() => window.__terminalProof),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error("opaque terminal frame did not finish within 30 seconds")),
      30_000,
    )),
  ]);
  process.stderr.write("stage=frame-complete\n");

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("tab", { name: "Board", exact: true }).click({ force: true });
  await page.getByText("Encoded board task", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByRole("button", { name: "Go to chat →", exact: true }).click({ force: true });
  await page.waitForFunction(() =>
    document.querySelector('[role="tab"][data-view="box"]')?.getAttribute("aria-selected") === "true"
  );
  const frame = page.locator('iframe[title="Box dashboard"]');
  await frame.waitFor({ state: "visible", timeout: 30_000 });
  await page.frameLocator('iframe[title="Box dashboard"]').locator("#box-task")
    .filter({ hasText: "task=t:one" }).waitFor({ state: "visible", timeout: 30_000 });
  const board = {
    pageUrl: page.url(),
    pageCount: context.pages().length,
    selectedView: await page.locator('[role="tab"][aria-selected="true"]').getAttribute("data-view"),
    frameSrc: await frame.getAttribute("src"),
    frameText: await page.frameLocator('iframe[title="Box dashboard"]').locator("#box-task").innerText(),
  };
  process.stderr.write("stage=board-box-complete\n");

  const heldBoxCookie = (await context.cookies(`${base}/box/settings`))
    .find(({ name }) => name === "agenthost_box_session");
  if (!heldBoxCookie) throw new Error("the recovered Box view did not hold its HttpOnly session cookie");
  await page.goto(`${crossPortOrigin}/cross-port-proof`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForFunction(
    () => document.body.dataset.crossPortProof === "done",
    undefined,
    { timeout: 30_000 },
  );
  const crossPort = {
    cookie: {
      httpOnly: heldBoxCookie.httpOnly,
      sameSite: heldBoxCookie.sameSite,
      path: heldBoxCookie.path,
    },
    requests: crossPortRequests,
    responses: crossPortResponses,
  };
  process.stderr.write("stage=cross-port-cookie-boundary-complete\n");
  process.stdout.write(`${JSON.stringify({ result, preflights, controlAttempts, terminalControlAttempts, crossPort, recovery, boundary, terminalFrame, board })}\n`);
} catch (error) {
  process.stderr.write(`agentglass-terminal-browser: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await Promise.race([
    browser?.close().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
}
