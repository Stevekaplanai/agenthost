import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { stopChild } from "../child-process-helper.js"
import { mintOperatorSession } from "../operator-session-helper.js"

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const GATE = path.join(ROOT, "container", "gate.js")
const KEY = "step9-route-proof-key"
const PINNED_CHROMIUM = "/opt/pw-browsers/chromium"
const ARTIFACT_DIR = String(process.env.AGENTHOST_E2E_ARTIFACT_DIR || "").trim()

const task = {
  id: "t_probe",
  title: "Route proof task",
  status: "queued",
  lane: "queued",
  actions: ["open"],
  transitions: ["running"],
  destinations: { details: "/board/task/t_probe", chat: "/?task=t_probe" },
  assignee: "codex",
}

const board = {
  available: true,
  lanes: [
    { id: "queued", title: "Queued" },
    { id: "running", title: "Running" },
    { id: "awaiting", title: "Awaiting You" },
    { id: "review", title: "Review" },
    { id: "done", title: "Done" },
    { id: "blocked", title: "Blocked" },
  ],
  columns: { queued: [task], running: [], awaiting: [], review: [], done: [], blocked: [] },
  tasks: [task],
}

function startGate(home) {
  const child = spawn(process.execPath, [GATE], {
    env: {
      ...process.env,
      HOME: home,
      TTYD_PASSWORD: KEY,
      AGENT_CHAT_BIN: "/bin/true",
      AGENTHOST_MODE_FILE: path.join(home, "absent-mode.json"),
      GATE_PORT: "0",
      CHANNEL_DISPATCH_PORT: "0",
      KANBAN_BRIDGE_PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  const ready = new Promise((resolve, reject) => {
    let stdout = ""
    let stderr = ""
    const timeout = setTimeout(
      () => reject(new Error(`gate did not report its port; stdout=${stdout}; stderr=${stderr}`)),
      15_000,
    )
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString()
      const match = stdout.match(/listening on (\d+)/)
      if (match) {
        clearTimeout(timeout)
        resolve(Number(match[1]))
      }
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    child.once("exit", (code) => {
      clearTimeout(timeout)
      reject(new Error(`gate exited before listening (${code}); stdout=${stdout}; stderr=${stderr}`))
    })
  })
  return { child, ready }
}

async function launchBrowser() {
  let playwright
  try {
    playwright = require("playwright-core")
  } catch (error) {
    const dependencyRoot = String(process.env.AGENTHOST_PLAYWRIGHT_ROOT || "").trim()
    if (!dependencyRoot) throw error
    playwright = require(path.join(dependencyRoot, "node_modules", "playwright-core"))
  }
  const { chromium } = playwright
  return fs.existsSync(PINNED_CHROMIUM)
    ? chromium.launch({ executablePath: PINNED_CHROMIUM, timeout: 15_000 })
    : chromium.launch({ channel: "chrome", timeout: 15_000 })
}

async function closeBrowser(browser) {
  if (!browser) return
  const closed = await Promise.race([
    browser.close().then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
  ])
  if (closed) return
  const process = typeof browser.process === "function" ? browser.process() : null
  if (process?.exitCode === null) process.kill()
  throw new Error("Chromium did not close within 5 seconds")
}

async function closeGate(child) {
  const closed = await Promise.race([
    stopChild(child).then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
  ])
  if (!closed) throw new Error("the local gate did not stop within 5 seconds")
}

async function authenticatedCookie(baseUrl) {
  const { cookie: pair } = await mintOperatorSession(baseUrl, KEY)
  const separator = pair.indexOf("=")
  assert.ok(separator > 0, "the real gate returned an authentication cookie")
  return { name: pair.slice(0, separator), value: pair.slice(separator + 1), url: baseUrl }
}

async function screenshot(page, name) {
  if (!ARTIFACT_DIR) return
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true })
  await page.screenshot({ path: path.join(ARTIFACT_DIR, name), fullPage: true })
}

async function openHydratedSettings(page, opener, dialog) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    await opener.click()
    try {
      await dialog.waitFor({ state: "visible", timeout: 500 })
      return
    } catch {
      // The server-rendered launcher can be visible just before React attaches
      // its handler. The dialog, not the button, is the hydration witness.
    }
  }
  throw new Error("the server-rendered Settings launcher did not become interactive within 15 seconds")
}

test("the real gate serves, deep-links, and recovers the generated dashboard", { timeout: 60_000 }, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-step9-routes-"))
  const gate = startGate(home)
  let browser = null
  t.after(async () => {
    const results = await Promise.allSettled([closeBrowser(browser), closeGate(gate.child)])
    fs.rmSync(home, { recursive: true, force: true })
    const failed = results.find((result) => result.status === "rejected")
    if (failed?.status === "rejected") throw failed.reason
  })

  const port = await gate.ready
  const baseUrl = `http://127.0.0.1:${port}`
  browser = await launchBrowser()

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await context.addCookies([await authenticatedCookie(baseUrl)])
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)

  const hydrationProblems = []
  const pageErrors = []
  page.on("console", (message) => {
    if (/hydrated|hydration/i.test(message.text())) hydrationProblems.push(message.text())
  })
  page.on("pageerror", (error) => pageErrors.push(error.message))

  await page.route("**/board", (route) => {
    if (route.request().method() !== "GET") return route.continue()
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(board) })
  })
  await page.route("**/board/task/t_probe", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ task, comments: [], events: [] }),
    }),
  )

  const rootResponse = await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" })
  assert.equal(rootResponse?.status(), 200)
  assert.equal(rootResponse?.headers()["content-security-policy"], "frame-ancestors 'self'")
  await page.waitForFunction(() => document.title === "AgentHost Workspace | Your governed agent team")
  const settings = page.getByRole("button", { name: "Open settings", exact: true })
  const settingsDialog = page.getByRole("dialog", { name: "Settings" })
  await openHydratedSettings(page, settings, settingsDialog)
  await page.keyboard.press("Escape")
  await screenshot(page, "desktop-root.png")

  await page.setViewportSize({ width: 390, height: 844 })
  const taskResponse = await page.goto(`${baseUrl}/?task=t_probe`, { waitUntil: "domcontentloaded" })
  assert.equal(taskResponse?.status(), 200)
  assert.equal(new URL(taskResponse?.url() || "").searchParams.get("task"), "t_probe")
  await page.getByRole("dialog", { name: "Route proof task" }).waitFor({ state: "visible" })
  assert.equal(new URL(page.url()).searchParams.has("task"), false, "the UI consumed the task deep link")
  assert.equal(new URL(page.url()).searchParams.get("view"), "work/board")
  await screenshot(page, "phone-root-task.png")

  const recoveryResponse = await page.goto(`${baseUrl}/cc/legacy`, { waitUntil: "domcontentloaded" })
  assert.equal(recoveryResponse?.status(), 410)
  await page.getByText(/standalone application route was retired/i).waitFor({ state: "visible" })
  await screenshot(page, "phone-retired-recovery.png")

  assert.deepEqual(hydrationProblems, [], "clean Chromium reported no hydration mismatch")
  assert.deepEqual(pageErrors, [], "the reachable cutover journey raised no page errors")
  await context.close()
})
