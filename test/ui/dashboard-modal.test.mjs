import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright-core"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const DASHBOARD = path.join(ROOT, "dashboard")
const DASHBOARD_OUT = path.join(DASHBOARD, "out")
const PINNED_CHROMIUM = "/opt/pw-browsers/chromium"
const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
const CONTENT_TYPE = {
  ".css": "text/css",
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
}

async function startDashboard() {
  assert.ok(
    fs.existsSync(path.join(DASHBOARD_OUT, "index.html")),
    "the dashboard production build exists (run npm --prefix dashboard run build)",
  )
  const server = http.createServer(async (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname)
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "")
    const candidate = path.resolve(DASHBOARD_OUT, relative)
    const safe = candidate === DASHBOARD_OUT || candidate.startsWith(`${DASHBOARD_OUT}${path.sep}`)
    const file = safe && fs.existsSync(candidate) && fs.statSync(candidate).isFile()
      ? candidate
      : path.join(DASHBOARD_OUT, "index.html")
    try {
      const body = await fs.promises.readFile(file)
      response.writeHead(200, { "Content-Type": CONTENT_TYPE[path.extname(file)] ?? "application/octet-stream" })
      response.end(body)
    } catch (error) {
      response.writeHead(500, { "Content-Type": "text/plain" })
      response.end(error instanceof Error ? error.message : String(error))
    }
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === "object", "dashboard test server has a TCP address")
  const url = `http://127.0.0.1:${address.port}`

  return {
    url,
    async close() {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

async function launchBrowser() {
  return fs.existsSync(PINNED_CHROMIUM)
    ? chromium.launch({ executablePath: PINNED_CHROMIUM })
    : chromium.launch({ channel: "chrome" })
}

async function closeBrowser(browser) {
  let timeout
  const closed = await Promise.race([
    browser.close().then(() => true),
    new Promise((resolve) => {
      timeout = setTimeout(() => resolve(false), 5000)
    }),
  ]).finally(() => clearTimeout(timeout))
  if (closed) return
  const process = typeof browser.process === "function" ? browser.process() : null
  if (process?.exitCode === null) process.kill()
  throw new Error("Chromium did not close within 5 seconds")
}

async function openHydratedModal(page, opener, dialog) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    await opener.focus()
    await page.keyboard.press("Control+k")
    if (await dialog.isVisible()) return
    await page.waitForTimeout(100)
  }
  throw new Error("the server-rendered Modal opener did not become interactive within 15 seconds")
}

async function waitForFocus(page, locator, description) {
  const element = await locator.elementHandle()
  assert.ok(element, description)
  await page.waitForFunction((target) => document.activeElement === target, element)
  return element
}

test("the rendered shared Modal traps focus and restores the page exactly", { timeout: 30_000 }, async (t) => {
  assert.ok(
    fs.existsSync(path.join(DASHBOARD, "node_modules", "next")),
    "dashboard dependencies are installed (run npm --prefix dashboard ci)",
  )

  const dashboard = await startDashboard()
  console.log("modal-ui: static dashboard ready")
  const browser = await launchBrowser()
  console.log("modal-ui: browser ready")
  t.after(async () => {
    const results = await Promise.allSettled([closeBrowser(browser), dashboard.close()])
    const failed = results.find((result) => result.status === "rejected")
    if (failed?.status === "rejected") throw failed.reason
  })

  // This keyboard-focus test needs the persistent desktop New task launcher;
  // the phone action lives in a menu that intentionally unmounts when clicked.
  const context = await browser.newContext({ viewport: { width: 768, height: 844 } })
  const page = await context.newPage()
  page.setDefaultTimeout(5000)
  let releaseCreateResponse
  const createResponseAllowed = new Promise((resolve) => {
    releaseCreateResponse = resolve
  })
  let markCreateRequestStarted
  const createRequestStarted = new Promise((resolve) => {
    markCreateRequestStarted = resolve
  })
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    if (url.origin === dashboard.url && url.pathname === "/api/mode" && route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ mode: "default" }),
      })
    }
    if (url.origin === dashboard.url && url.pathname === "/board/task" && route.request().method() === "POST") {
      markCreateRequestStarted()
      await createResponseAllowed
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: "t_modal_lock_test" }),
      })
    }
    if (url.origin === dashboard.url && url.pathname !== "/" && !url.pathname.startsWith("/_next/")) {
      return route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: "not configured in the Modal behavior test" }),
      })
    }
    return route.continue()
  })
  await page.goto(dashboard.url, { waitUntil: "domcontentloaded" })
  console.log("modal-ui: page loaded")

  const opener = page.getByRole("button", { name: "Open settings", exact: true })
  await opener.waitFor({ state: "visible" })
  console.log("modal-ui: opener visible")
  const dialog = page.getByRole("dialog", { name: "Search AgentHost" })
  // A visible server-rendered button can precede React hydration. Open and
  // close once so every assertion below starts from a proven interactive UI.
  await openHydratedModal(page, opener, dialog)
  console.log("modal-ui: search opened")
  await page.keyboard.press("Escape")
  await dialog.waitFor({ state: "detached" })
  await waitForFocus(page, opener, "the Open settings button exists after hydration")

  await page.evaluate(() => {
    const preserved = document.querySelector(".gunmetal-ambient")
    const clean = document.querySelector(".gunmetal-grid")
    if (!(preserved instanceof HTMLElement) || !(clean instanceof HTMLElement)) {
      throw new Error("dashboard shell siblings are missing")
    }
    preserved.setAttribute("inert", "")
    preserved.setAttribute("aria-hidden", "false")
    clean.removeAttribute("inert")
    clean.removeAttribute("aria-hidden")
  })

  await opener.focus()
  await page.keyboard.press("Control+k")
  await dialog.waitFor({ state: "visible" })
  await page.waitForFunction(() => document.activeElement?.getAttribute("placeholder") === "Board, artifacts, memory, mesh...")

  const openState = await page.evaluate((focusable) => {
    const dialogElement = document.querySelector('[role="dialog"]')
    const overlay = dialogElement?.parentElement
    const preserved = document.querySelector(".gunmetal-ambient")
    const clean = document.querySelector(".gunmetal-grid")
    if (!(dialogElement instanceof HTMLElement) || !(overlay instanceof HTMLElement)) {
      throw new Error("rendered modal is missing")
    }
    const items = Array.from(dialogElement.querySelectorAll(focusable)).filter(
      (element) => element instanceof HTMLElement && element.getClientRects().length > 0,
    )
    const protectedSiblings = Array.from(overlay.parentElement?.children ?? []).filter(
      (element) => element !== overlay && element instanceof HTMLElement,
    )
    return {
      activeIndex: items.indexOf(document.activeElement),
      activePlaceholder: document.activeElement?.getAttribute("placeholder"),
      focusableCount: items.length,
      labelledByText: document.getElementById(dialogElement.getAttribute("aria-labelledby") ?? "")?.textContent,
      describedByText: document.getElementById(dialogElement.getAttribute("aria-describedby") ?? "")?.textContent,
      everySiblingProtected: protectedSiblings.every(
        (element) => element.hasAttribute("inert") && element.getAttribute("aria-hidden") === "true",
      ),
      preserved: {
        inert: preserved?.hasAttribute("inert"),
        ariaHidden: preserved?.getAttribute("aria-hidden"),
      },
      clean: {
        inert: clean?.hasAttribute("inert"),
        ariaHidden: clean?.getAttribute("aria-hidden"),
      },
    }
  }, FOCUSABLE)

  assert.equal(openState.activePlaceholder, "Board, artifacts, memory, mesh...", "Search preserves its intentional input focus")
  assert.ok(openState.focusableCount > 1, "the rendered dialog has both ends needed for a focus trap")
  assert.equal(openState.labelledByText, "Search AgentHost")
  assert.equal(openState.describedByText, "Find a room or a working tool")
  assert.equal(openState.everySiblingProtected, true, "every page sibling is inert and hidden while open")
  assert.deepEqual(openState.preserved, { inert: true, ariaHidden: "true" })
  assert.deepEqual(openState.clean, { inert: true, ariaHidden: "true" })

  const searchInput = page.getByPlaceholder("Board, artifacts, memory, mesh...")
  await page.keyboard.type("brain")
  assert.equal(await searchInput.inputValue(), "brain", "typing starts in Search without another tap")
  assert.equal(await dialog.getByRole("button", { name: /Memory/ }).isVisible(), true, "typing immediately filters destinations")
  await searchInput.fill("")
  await dialog.getByRole("button", { name: "Close" }).focus()

  await page.keyboard.press("Shift+Tab")
  assert.deepEqual(
    await page.evaluate((focusable) => {
      const dialogElement = document.querySelector('[role="dialog"]')
      const items = Array.from(dialogElement?.querySelectorAll(focusable) ?? []).filter(
        (element) => element instanceof HTMLElement && element.getClientRects().length > 0,
      )
      return { activeIndex: items.indexOf(document.activeElement), lastIndex: items.length - 1 }
    }, FOCUSABLE),
    { activeIndex: openState.focusableCount - 1, lastIndex: openState.focusableCount - 1 },
    "Shift+Tab wraps from the first control to the last",
  )

  await page.keyboard.press("Tab")
  assert.equal(
    await page.evaluate((focusable) => {
      const dialogElement = document.querySelector('[role="dialog"]')
      const items = Array.from(dialogElement?.querySelectorAll(focusable) ?? []).filter(
        (element) => element instanceof HTMLElement && element.getClientRects().length > 0,
      )
      return items.indexOf(document.activeElement)
    }, FOCUSABLE),
    0,
    "Tab wraps from the last control to the first",
  )

  await page.keyboard.press("Escape")
  await dialog.waitFor({ state: "detached" })
  const focusedOpener = await waitForFocus(page, opener, "Search keeps its Open settings launcher")

  assert.deepEqual(
    await page.evaluate((target) => {
      const preserved = document.querySelector(".gunmetal-ambient")
      const clean = document.querySelector(".gunmetal-grid")
      return {
        preserved: {
          inert: preserved?.hasAttribute("inert"),
          ariaHidden: preserved?.getAttribute("aria-hidden"),
        },
        clean: {
          inert: clean?.hasAttribute("inert"),
          ariaHidden: clean?.getAttribute("aria-hidden"),
        },
        openerFocused: document.activeElement === target,
      }
    }, focusedOpener),
    {
      preserved: { inert: true, ariaHidden: "false" },
      clean: { inert: false, ariaHidden: null },
      openerFocused: true,
    },
    "Escape closes, restores each sibling's prior state, and returns focus to the opener",
  )

  const settingsOpener = opener
  await settingsOpener.click()
  const settingsDialog = page.locator('[role="dialog"]').filter({
    has: page.locator("h2", { hasText: "Settings" }),
  })
  await settingsDialog.waitFor({ state: "visible" })
  await page.waitForFunction(() => {
    const settings = Array.from(document.querySelectorAll('[role="dialog"]')).find(
      (element) => element.querySelector("h2")?.textContent === "Settings",
    )
    return settings?.querySelector('button[aria-label="Close"]') === document.activeElement
  })

  await page.keyboard.press("Control+k")
  await dialog.waitFor({ state: "visible" })
  assert.equal(await page.locator('[role="dialog"]').count(), 2, "Search stacks above Settings")
  assert.deepEqual(
    await page.evaluate(() => Object.fromEntries(
      Array.from(document.querySelectorAll('[role="dialog"]')).map((element) => [
        element.querySelector("h2")?.textContent,
        Number(getComputedStyle(element.parentElement).zIndex),
      ]),
    )),
    { "Search AgentHost": 51, Settings: 50 },
    "the keyboard-active Search overlay paints above the inert Settings overlay",
  )

  await page.keyboard.press("Escape")
  await dialog.waitFor({ state: "detached" })
  await page.waitForFunction(() => {
    const settings = Array.from(document.querySelectorAll('[role="dialog"]')).find(
      (element) => element.querySelector("h2")?.textContent === "Settings",
    )
    return settings?.querySelector('button[aria-label="Close"]') === document.activeElement
  })
  assert.equal(await settingsDialog.count(), 1, "only the top Search modal handles the first Escape")
  assert.equal(
    await page.evaluate(() => {
      const settings = Array.from(document.querySelectorAll('[role="dialog"]')).find(
        (element) => element.querySelector("h2")?.textContent === "Settings",
      )
      const overlay = settings?.parentElement
      const siblings = Array.from(overlay?.parentElement?.children ?? []).filter(
        (element) => element !== overlay && element instanceof HTMLElement,
      )
      return !overlay?.hasAttribute("inert") && siblings.every(
        (element) => element.hasAttribute("inert") && element.getAttribute("aria-hidden") === "true",
      )
    }),
    true,
    "closing the top modal reactivates Settings while the page stays protected",
  )

  await page.keyboard.press("Escape")
  await settingsDialog.waitFor({ state: "detached" })
  await waitForFocus(page, settingsOpener, "the nested Settings text click returns focus to its button")

  const createOpener = page.getByRole("button", { name: "New task" })
  await createOpener.click()
  const createDialog = page.getByRole("dialog", { name: "Create task" })
  await createDialog.waitFor({ state: "visible" })
  await createDialog.getByPlaceholder(/Fix the mobile nav overlap/).fill("Prove modal page locking")
  await createDialog.getByRole("button", { name: "Create task" }).click()
  await createRequestStarted

  await page.keyboard.press("Control+k")
  await dialog.waitFor({ state: "visible" })
  releaseCreateResponse()
  await page.waitForFunction(() => !Array.from(document.querySelectorAll('[role="dialog"]')).some(
    (element) => element.querySelector("h2")?.textContent === "Create task",
  ))
  assert.equal(await dialog.isVisible(), true, "Search remains open after the lower async dialog closes")
  assert.equal(
    await page.evaluate(() => {
      const search = Array.from(document.querySelectorAll('[role="dialog"]')).find(
        (element) => element.querySelector("h2")?.textContent === "Search AgentHost",
      )
      const overlay = search?.parentElement
      const siblings = Array.from(overlay?.parentElement?.children ?? []).filter(
        (element) => element !== overlay && element instanceof HTMLElement,
      )
      return siblings.every(
        (element) => element.hasAttribute("inert") && element.getAttribute("aria-hidden") === "true",
      )
    }),
    true,
    "a lower async close cannot release the page while the top modal remains",
  )

  await page.keyboard.press("Escape")
  await dialog.waitFor({ state: "detached" })
  const focusedCreateOpener = await waitForFocus(page, createOpener, "the async modal stack keeps the New task launcher")
  assert.deepEqual(
    await page.evaluate((target) => {
      const preserved = document.querySelector(".gunmetal-ambient")
      const clean = document.querySelector(".gunmetal-grid")
      return {
        preserved: {
          inert: preserved?.hasAttribute("inert"),
          ariaHidden: preserved?.getAttribute("aria-hidden"),
        },
        clean: {
          inert: clean?.hasAttribute("inert"),
          ariaHidden: clean?.getAttribute("aria-hidden"),
        },
        openerFocused: document.activeElement === target,
      }
    }, focusedCreateOpener),
    {
      preserved: { inert: true, ariaHidden: "false" },
      clean: { inert: false, ariaHidden: null },
      openerFocused: true,
    },
    "closing the last modal restores the shared page baseline and original launcher after an out-of-order close",
  )
})
