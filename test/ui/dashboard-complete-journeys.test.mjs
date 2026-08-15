import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { stopChild } from "../child-process-helper.js"
import { mintOperatorSession } from "../operator-session-helper.js"

/**
 * Browser-complete proof for the prototype application.
 *
 * This suite deliberately mocks the box APIs while running the REAL Next
 * source for broad journeys and the exact generated gate artifact for the
 * boot-fixed Legal brand journey. It proves the shell, navigation, controls,
 * modal gates, and phone scrolling. It does NOT claim the final box's ttyd
 * authentication/WebSocket path or the AgentGlass reverse proxy work; those
 * require a separately authenticated test against the real box and proxy.
 */

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const DASHBOARD = path.join(ROOT, "dashboard")
const NEXT_RUNNER = path.join(DASHBOARD, "scripts", "run-next.mjs")
const NEXT_SHUTDOWN_MESSAGE = "agenthost-dashboard-shutdown"
const GATE = path.join(ROOT, "container", "gate.js")
const GENERATED_DASHBOARD_INDEX = path.join(ROOT, "container", "dashboard-ui", "index.html")
const GENERATED_DASHBOARD_ROOT = path.dirname(GENERATED_DASHBOARD_INDEX)
const LEGAL_GATE_KEY = "complete-journeys-legal-gate-key"
const PINNED_CHROMIUM = "/opt/pw-browsers/chromium"
const WINDOWS_EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
const ARTIFACT_DIR = String(process.env.AGENTHOST_E2E_ARTIFACT_DIR || path.join(ROOT, ".e2e-artifacts", "complete-journeys")).trim()
const MEASUREMENT_CONNECTION_ID = "mc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const SOURCE_HASH_ROOTS = [
  path.join(ROOT, "dashboard", "app"),
  path.join(ROOT, "dashboard", "components"),
  path.join(ROOT, "dashboard", "lib"),
  path.join(ROOT, "dashboard", "public"),
]
const SOURCE_HASH_FILES = [
  path.join(ROOT, "dashboard", "next.config.ts"),
  path.join(ROOT, "dashboard", "package.json"),
  path.join(ROOT, "dashboard", "tsconfig.json"),
  path.join(ROOT, "container", "gate.js"),
  path.join(ROOT, "container", "sw.js"),
]
const ENGINE_ORDER = ["claude", "codex", "deepseek", "kimi", "gemini", "hermes", "cursor"]
const ENGINE_LABELS = {
  claude: "Claude",
  codex: "Codex",
  deepseek: "DeepSeek",
  kimi: "Kimi",
  gemini: "Gemini",
  hermes: "Hermes",
  cursor: "Cursor",
}

function sourceFilesUnder(directory) {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const absolute = path.join(directory, entry.name)
      return entry.isDirectory() ? sourceFilesUnder(absolute) : [absolute]
    })
}

function sourceSnapshot() {
  const files = [...SOURCE_HASH_ROOTS.flatMap(sourceFilesUnder), ...SOURCE_HASH_FILES]
    .filter((file) => fs.existsSync(file))
    .sort((left, right) => left.localeCompare(right))
  const hash = createHash("sha256")
  for (const file of files) {
    const relative = path.relative(ROOT, file).replaceAll("\\", "/")
    hash.update(`${relative}\0`)
    hash.update(fs.readFileSync(file))
    hash.update("\0")
  }
  return { algorithm: "sha256", digest: hash.digest("hex"), files: files.length }
}

function generatedDashboardContentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8"
  if (file.endsWith(".css")) return "text/css; charset=utf-8"
  if (file.endsWith(".js")) return "application/javascript; charset=utf-8"
  if (file.endsWith(".json")) return "application/json; charset=utf-8"
  if (file.endsWith(".txt")) return "text/plain; charset=utf-8"
  if (file.endsWith(".woff2")) return "font/woff2"
  return "application/octet-stream"
}

async function startGeneratedDashboardServer() {
  const root = path.resolve(GENERATED_DASHBOARD_ROOT)
  const prefix = `${root}${path.sep}`
  const server = createServer((req, res) => {
    let pathname
    try { pathname = decodeURIComponent(new URL(req.url || "/", "http://generated.local").pathname) }
    catch {
      res.writeHead(400).end("invalid generated-dashboard path")
      return
    }
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "")
    const target = path.resolve(root, relative)
    if (target !== root && !target.startsWith(prefix)) {
      res.writeHead(400).end("generated-dashboard path escaped its root")
      return
    }
    fs.readFile(target, (error, body) => {
      if (error) {
        res.writeHead(error.code === "ENOENT" ? 404 : 500).end(error.code || "generated-dashboard read failed")
        return
      }
      res.writeHead(200, {
        "content-type": generatedDashboardContentType(target),
        "cache-control": "no-store",
        "access-control-allow-origin": "null",
        "access-control-allow-credentials": "true",
        vary: "Origin",
      })
      res.end(body)
    })
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === "object", "the generated Box Console server has a TCP address")
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  }
}

const SETTINGS_CONTROL_INVENTORY = [
  "Claude active", "Claude in chat", "Codex active", "Codex in chat", "DeepSeek active", "DeepSeek in chat", "Kimi active", "Kimi in chat", "Gemini active", "Gemini in chat", "Hermes active", "Hermes in chat", "Cursor active", "Cursor in chat",
  "DeepSeek Role", "DeepSeek Per-run limit", "DeepSeek Daily limit",
  "Kimi Role", "Kimi Per-run limit", "Kimi Daily limit",
  "Ollama", "OpenClaw", "Moonshot (Kimi)",
  "Telegram Enabled", "Telegram Ask before consequential actions", "Telegram Board reporter",
  "Discord Enabled", "Discord Ask before consequential actions", "Discord Board reporter",
  "Cost limits", "Budget per chain", "Chat daily dollars", "Chat daily tokens",
  "Sleep schedule", "Starts", "Ends",
  "Auto-dispatch", "Stuck card alerts",
  "Autonomy level", "Review strictness", "Auto-commit",
  "Heartbeat frequency", "About AgentGlass link",
  "2FA access key", "Start 2FA enrollment", "2FA activation code", "Review 2FA activation", "2FA disable code", "Turn off 2FA",
  "Enable browser notifications", "Turn off browser notifications",
]

/** Source-derived inventory. Keep this explicit: omissions should be reviewable. */
const LIVE_SURFACE_INVENTORY = {
  viewports: {
    desktop: { width: 1440, height: 900 },
    phone: { width: 390, height: 844, touch: true },
  },
  rooms: {
    dev: ["Overview", "Work", "Agents", "Brain", "Systems"],
  },
  growthPhonePrimary: [
    { label: "Home", view: "overview" },
    { label: "Chat", view: "overview/thread" },
    { label: "Board", view: "work/board" },
    { label: "Loops", view: "systems/loops" },
  ],
  destinations: {
    Overview: ["Overview", "Full thread"],
    WorkDev: ["Board", "Files", "Artifacts", "Terminal", "Reviews"],
    WorkGrowth: ["Board", "Artifacts"],
    Agents: ["Onboard & Control"],
    Growth: {
      "Command Center": [
        { label: "Home", view: "overview" },
        { label: "Workspace", view: "overview/thread" },
        { label: "Board", view: "work/board" },
        { label: "Growth Loops", view: "systems/loops" },
      ],
      "Client work": [
        { label: "Accounts", view: "growth/brand-dna" },
        { label: "Campaigns", view: "growth/campaigns" },
        { label: "Creative", view: "growth/creative" },
        { label: "Attribution", view: "growth/attribution" },
      ],
      "The box": [
        { label: "Brain", view: "brain/memory" },
        { label: "Crew", view: "systems/agents" },
        { label: "Inventory", view: "systems/inventory" },
        { label: "Secrets", view: "systems/secrets" },
      ],
    },
    Brain: ["Memory"],
    Systems: ["Mesh", "Loops", "Operations", "Activity", "Inventory"],
  },
  globalControls: [
    "primary navigation",
    "switch box",
    "switch box destination",
    "Dev/Growth mode",
    "system health",
    "system health close",
    "search",
    "search query and result",
    "search close",
    "team thread",
    "new task",
    "task draft Assist and Undo",
    "settings",
    "phone more-actions sheet",
  ],
  roomControls: {
    Overview: ["open full thread", "open Brain", "open Work", "agent cards", "task cards"],
    Board: ["sort", "Status", "Lanes", "client filter", "task cards", "agent lane cards", "open assignee", "approve consequence", "send back consequence", "reassign consequence", "block consequence", "discuss task"],
    Files: ["refresh", "upload", "locations", "file selection", "open", "download"],
    Artifacts: ["refresh", "open", "download"],
    Terminal: ["session selector", "nested terminal iframe"],
    Reviews: ["review cards", "receipt cards"],
    Agents: ["refresh", "roster", "availability", "chat participation", "open thread", "open terminal"],
    Growth: ["accounts", "create account", "Brand DNA", "Brand DNA from URL", "Brand DNA Assist and Undo", "Attribution disconnect and delete", "objective links", "key-result links", "autonomy pause/resume", "autonomy controls", "Loops link"],
    Brain: ["refresh", "new memory", "memory Assist and Undo", "file ingest consequence", "map lobes", "Shared Core lobe", "Claude lobe", "Codex lobe", "DeepSeek lobe", "Kimi lobe", "Gemini lobe", "Hermes lobe", "Cursor lobe", "Shared Core shortcut", "Claude shortcut", "Codex shortcut", "DeepSeek shortcut", "Kimi shortcut", "Gemini shortcut", "Hermes shortcut", "Cursor shortcut", "scope", "lane cards", "detail", "copy link", "show in lane", "linked memories"],
    Mesh: ["refresh", "draft", "review publish"],
    Operations: ["refresh", "pause", "resume"],
    Activity: ["refresh", "observed event detail", "vertical history"],
    Inventory: ["search", "kind filters", "copy", "close"],
    Loops: ["starters", "saved jobs", "delete", "history", "cadence", "prompt", "prompt Assist and Undo", "schedule", "single-run approval"],
    MultiLoops: ["starters", "engine readiness", "team form", "stages", "history", "delete", "schedule"],
    Settings: ["eleven sections", "Security / 2FA", ...SETTINGS_CONTROL_INVENTORY, "use defaults", "Moonshot test", "save", "mode cards"],
    Thread: ["filters", "route selector", "full-thread route chips", "attached Assist and Undo", "full-thread Assist and Undo", "send", "stop attached run", "stop full-thread run", "expand", "close"],
  },
  dialogsAndConsequenceGates: [
    "Search AgentHost",
    "Switch box",
    "System Health",
    "Create task",
    "Discard this task draft?",
    "Task details / Archive this task?",
    "Agent details",
    "Settings",
    "Discard unsaved settings changes?",
    "Review consequential settings changes",
    "Use defaults for section?",
    "Run a paid Moonshot connection test?",
    "Activate two-factor authentication?",
    "Turn off two-factor authentication?",
    "Enable notifications on this device?",
    "Turn off notifications on this device?",
    "Switch mode?",
    "Enable agent for work?",
    "Add agent to team chat?",
    "Remove agent from team chat?",
    "Enable the Moonshot route for Kimi?",
    "Resume this task?",
    "Approve this task?",
    "Send this task back?",
    "Reassign this task?",
    "Block this task?",
    "Approve this Loop run once?",
    "Publish to the mesh team?",
    "Resume autonomy?",
    "Schedule this Loop?",
    "Schedule this Multi-Loop?",
    "New memory",
    "Discard this memory draft?",
    "Memory detail",
    "Discard Brand DNA edits?",
    "Create client account",
    "Create this client account?",
    "Discard this client account draft?",
    "Delete stored measurement facts?",
    "Stop this agent run?",
  ],
  horizontalRails: [
    "Work sections",
    "Growth sections",
    "Systems sections",
    "Settings sections",
    "Board status lanes",
    "Board agent swimlanes",
    "File locations",
    "Agent roster. Scroll horizontally or use the arrow keys.",
    "Memory map lane shortcuts",
    "Browse Shared Core memories",
    "Browse Claude's lobe memories",
    "Browse Codex's lobe memories",
    "Browse DeepSeek's lobe memories",
    "Browse Kimi's lobe memories",
    "Browse Gemini's lobe memories",
    "Browse Hermes's lobe memories",
    "Browse Cursor's lobe memories",
    "Multi-Loop starters",
    "Development loop recipes",
    "Growth loop recipes",
  ],
  verticalScrollSurfaces: [
    "room content",
    "team thread",
    "board lane cards",
    "file list and preview",
    "artifacts",
    "review lists",
    "agent profile",
    "goals and autonomy",
    "Brain content and memory detail",
    "Mesh",
    "Operations",
    "Inventory results",
    "Loops and Multi-Loops",
    "Settings content",
    "modal bodies",
  ],
  routeOwnership: {
    nativeShellDeepLinks: ["/audit", "/2fa"],
    retiredWithCause: ["/hermes", "/hermes/"],
    separateShellProofRequired: ["PWA manifest", "service worker", "push entry ownership"],
  },
}

const taskObjective = {
  id: "t_objective",
  title: "Objective: Make the complete Workspace reachable",
  status: "running",
  lane: "running",
  actions: ["open", "assign", "archive", "block", "chat"],
  transitions: ["review", "blocked"],
  destinations: { details: "/board/task/t_objective", chat: "/chat?task=t_objective" },
  assignee: "codex",
  priority: 5,
  liveNote: "Every surface is being exercised.",
}

const taskReview = {
  id: "t_review",
  title: "Verify phone touch and scroll",
  status: "review",
  lane: "review",
  actions: ["open", "approve", "send_back", "assign", "archive", "chat"],
  transitions: ["done", "running"],
  destinations: { details: "/board/task/t_review", chat: "/chat?task=t_review" },
  assignee: "claude",
  priority: 4,
  reviewNote: "Independent browser evidence attached.",
}

const taskDone = {
  id: "t_done",
  title: "Keep the whole team attached to the result",
  status: "done",
  lane: "done",
  actions: ["open", "resume", "archive", "chat"],
  transitions: [],
  destinations: { details: "/board/task/t_done", chat: "/chat?task=t_done" },
  assignee: "hermes",
  priority: 3,
  reviewNote: "PASS — shared ownership stayed visible.",
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
  columns: {
    queued: [],
    running: [taskObjective],
    awaiting: [],
    review: [taskReview],
    done: [taskDone],
    blocked: [],
  },
  tasks: [taskObjective, taskReview, taskDone],
  relations: {
    available: true,
    byTask: {
      t_objective: { parents: [], children: ["t_review", "t_done"] },
      t_review: { parents: ["t_objective"], children: [] },
      t_done: { parents: ["t_objective"], children: [] },
    },
  },
}

const defaultSettings = {
  v: 6,
  llm: {
    roster: {
      claude: { active: true, inChat: true },
      codex: { active: true, inChat: true },
      deepseek: { active: true, inChat: true },
      kimi: { active: true, inChat: true },
      gemini: { active: true, inChat: true },
      hermes: { active: true, inChat: true },
      cursor: { active: true, inChat: true },
    },
  },
  services: { ollama: { enabled: true }, openclaw: { enabled: true } },
  providers: { moonshot: { enabled: false, modelId: "kimi-k3" } },
  channels: {
    telegram: { enabled: true, owner: "openclaw", confirmGate: true, boardContext: true },
    discord: { enabled: false, owner: "openclaw", confirmGate: true, boardContext: true },
    whatsapp: { enabled: false, owner: "hermes", confirmGate: true, boardContext: false },
  },
  cost: { limitsEnabled: false, perChainUsd: 20, chatDailyUsd: 100, chatDailyTokens: 2_000_000 },
  schedule: { sleep: { enabled: false, start: "23:00", end: "07:00" } },
  board: { autoDispatch: false, stuckAlerts: true },
  agents: {
    heartbeat: "milestone",
    deepseek: { role: "Engineering", limits: { perRunUsd: 1, perDayUsd: 5 } },
    kimi: { role: "research", limits: { perRunUsd: 2, perDayUsd: 10 } },
  },
  git: { autonomyLevel: 4, reviewStrictness: 4, autoCommit: true },
}

const memories = [
  { id: "m_shared_1", agent: "claude", scope: "shared", kind: "rule", content: "The whole team owns the result.", tags: ["team", "rule"], metadata: { related: ["m_shared_2"] }, created_at: "2026-08-09T12:00:00Z" },
  { id: "m_shared_2", agent: "codex", scope: "shared", kind: "procedure", content: "Measure twice, cut once, then verify every journey.", tags: ["qa"], created_at: "2026-08-09T13:00:00Z" },
  { id: "m_claude", agent: "claude", scope: "private", kind: "fact", content: "Claude reviewed the shell contract.", tags: ["review"], created_at: "2026-08-09T14:00:00Z" },
  { id: "m_codex", agent: "codex", scope: "private", kind: "fact", content: "Codex owns the browser journey evidence.", tags: ["browser"], created_at: "2026-08-09T15:00:00Z" },
  { id: "m_deepseek", agent: "deepseek", scope: "private", kind: "fact", content: "DeepSeek stays inside its protected spending and workspace boundaries.", tags: ["budget", "containment"], created_at: "2026-08-09T16:00:00Z" },
  { id: "m_kimi", agent: "kimi", scope: "private", kind: "fact", content: "Kimi reports its real readiness.", tags: ["readiness"], created_at: "2026-08-09T17:00:00Z" },
  { id: "m_gemini", agent: "gemini", scope: "private", kind: "fact", content: "Gemini maps systems evidence.", tags: ["systems"], created_at: "2026-08-09T18:00:00Z" },
  { id: "m_hermes", agent: "hermes", scope: "private", kind: "preference", content: "Hermes independently reviews current commits.", tags: ["review"], created_at: "2026-08-09T19:00:00Z" },
  { id: "m_cursor", agent: "cursor", scope: "private", kind: "fact", content: "Cursor stays human-directed for chat and terminal work.", tags: ["agent"], created_at: "2026-08-09T20:00:00Z" },
]

const initialGrowthAccounts = [
  { account_id: "claimflow", name: "ClaimFlow", industry: "Legal technology", created_at: "2026-08-09T00:00:00Z" },
]

const initialGrowthDna = {
  claimflow: [{ id: "dna_1", asset: "brand-voice", source: "client", content: "Clear, direct, evidence-backed.", version: 1, updated_at: "2026-08-09T00:00:00Z", schemaVersion: 1 }],
}

const settingsPayload = () => {
  const settings = structuredClone(defaultSettings)
  settings.cost.limitsEnabled = true
  return {
    settings,
    defaults: structuredClone(defaultSettings),
    overrides: { cost: { limitsEnabled: true }, git: { autonomyLevel: 4 } },
    serviceStatus: { ollama: { up: true, loaded: ["qwen3"] }, openclaw: { up: true } },
  }
}

function createMockState() {
  const now = Date.now()
  return {
    mode: "default",
    autonomyOn: true,
    settings: settingsPayload(),
    failNextSettingsSave: false,
    failNextTwoFactorDisable: false,
    failNextTerminalSwitch: false,
    failNextMemoryIngest: false,
    failNextFileUpload: false,
    failNextChatCancel: false,
    failNextAssist: false,
    failNextPushUnsubscribe: false,
    memoryIngestDelayMs: 0,
    fileUploadDelayMs: 0,
    chatCancelDelayMs: 0,
    holdNextAssist: false,
    assistHeld: false,
    releaseAssist: null,
    pushUnsubscribeDelayMs: 0,
    growthCreateDelayMs: 0,
    growthDnaBuildDelayMs: 0,
    twoFactorConfirmDelayMs: 0,
    twoFactor: { available: true, enrolled: false },
    pushSubscribed: false,
    pushOriginReset: false,
    pushSigningKeyReset: false,
    memories: structuredClone(memories),
    growthAccounts: structuredClone(initialGrowthAccounts),
    growthDna: structuredClone(initialGrowthDna),
    growthAccountBodies: [],
    growthDnaBuildBodies: [],
    measurementConnected: false,
    measurementConnections: [{
      id: MEASUREMENT_CONNECTION_ID, accountId: "claimflow", provider: "meta_ads", sourceAccountId: "act_1001",
      enabled: true, lastSyncedAt: "2026-08-11T12:00:00Z", lastError: null,
    }],
    measurementFacts: [
      { id: "campaign-spend", accountId: "claimflow", provider: "meta_ads", sourceAccountId: "act_1001", campaignId: "cmp_launch", campaignName: "Agency launch", metric: "spend", value: 25, currency: "USD", sourceTimezone: "America/New_York", observedAt: "2026-08-10T00:00:00.000Z", capturedAt: "2026-08-11T12:00:00.000Z" },
      { id: "campaign-revenue", accountId: "claimflow", provider: "meta_ads", sourceAccountId: "act_1001", campaignId: "cmp_launch", campaignName: "Agency launch", metric: "revenue", value: 100, currency: "USD", sourceTimezone: "America/New_York", observedAt: "2026-08-10T00:00:00.000Z", capturedAt: "2026-08-11T12:00:00.000Z" },
    ],
    boxSecrets: {},
    secretBodies: [],
    artifactReviews: {},
    artifactReviewBodies: [],
    lastTwoFactorEnrollBody: null,
    lastTwoFactorConfirmBody: null,
    lastTwoFactorDisableBody: null,
    pushSubscriptionBodies: [],
    pushUnsubscriptionBodies: [],
    pushStatusBodies: [],
    lastLoopApprovalBody: null,
    lastFileUpload: null,
    assistBodies: [],
    graphifyBodies: [],
    graphifyOperationBodies: [],
    graphifyAckBodies: [],
    graphifyOperationLeases: new Map(),
    graphifyAcknowledgedOperations: new Set(),
    graphifyReceipts: new Map(),
    graphifyOperationSerial: 0,
    boardReviewBodies: [],
    boardFreezeBodies: [],
    holdChatStream: false,
    deleteDelayMs: new Map(),
    counts: new Map(),
    requests: [],
    cc: {
      day: "2026-08-10",
      usage: {
        claude: { in: 1000, out: 500, cost: 1.1, turns: 4 },
        codex: { in: 1200, out: 600, cost: 1.3, turns: 5 },
      },
      windows: {},
      engines: Object.fromEntries(ENGINE_ORDER.map((id, index) => [id, {
        state: index === 1 ? "running" : "idle",
        status: index === 1 ? "Building browser proof" : "Ready",
        installed: true,
        currentTask: index === 1 ? taskObjective.title : undefined,
        observedAt: now,
        capability: { available: true, summary: "Observed ready", artifacts: [{ repo: "agenthost-internal", branch: "codex/frontend-prototype-app" }] },
      }])),
      hermes: { state: "ready" },
      ollama: { up: true, loaded: ["qwen3"], pulled: now },
      channels: {
        telegram: { enabled: true, owner: "openclaw", ready: true, credentialPresent: true },
        discord: { enabled: false, owner: "openclaw", ready: false, credentialPresent: false },
      },
      feed: [],
      autonomy: { on: true, busy: false, busyKind: null, lastTick: "2026-08-10T01:00:00Z" },
    },
  }
}

function profiles() {
  return {
    ok: true,
    agents: ENGINE_ORDER.map((id, index) => ({
      id,
      label: ENGINE_LABELS[id],
      installed: true,
      routed: true,
      color: ["#ff6a3d", "#22d3ee", "#4d6bfe", "#f472b6", "#a78bfa", "#4ade80", "#38bdf8"][index],
      bin: id,
      chatAdapter: id,
      autoJail: false,
      role: "team member",
      provider: id,
      fallback: null,
      capabilities: {
        chat: { state: "available" },
        terminal: { state: "available" },
        unattended: id === "cursor" ? { state: "unavailable", reasonCode: "NOT_APPROVED" } : { state: "available" },
        review: ["deepseek", "cursor"].includes(id) ? { state: "unavailable", reasonCode: "NOT_APPROVED" } : { state: "available" },
      },
      runtimeState: "ready",
      workspace: `/worktrees/${id}`,
      isolationStatus: "isolated",
      autonomyLevel: 4,
      todaySpend: { tokens: 1000 + index * 100, cost: 0.5 + index / 10 },
      limits: id === "deepseek" ? { perRunUsd: 1, perDayUsd: 5 } : { perRunUsd: 5, perDayUsd: 20 },
    })),
  }
}

const LOOP_APPROVAL_FINGERPRINT = "a".repeat(64)
const CREATIVE_CONTENT_VERSION = "c".repeat(64)
const JOURNEY_ARTIFACTS = [
  { name: "complete-journey.html", title: "Complete Journey Proof", category: null },
  { name: "approve-journey.html", title: "Approve Journey Proof", category: "creative" },
  { name: "approve-journey-2.html", title: "Second Approve Journey Proof", category: "creative" },
  { name: "reject-journey.html", title: "Reject Journey Proof", category: "creative" },
  { name: "adjust-journey.html", title: "Adjust Journey Proof", category: "creative" },
]
const GRAPHIFY_TARGETS = [
  {
    id: "harness",
    label: "Agent harness",
    kind: "harness",
    folders: [{ id: "h_all", label: "All approved harness files" }],
    defaultFolderId: "h_all",
  },
  {
    id: "vault:operator-brain",
    label: "Operator Brain vault",
    kind: "vault",
    folders: [{ id: "vault_all", label: "Entire registered vault" }],
    defaultFolderId: "vault_all",
  },
  {
    id: "repo:owner/repo",
    label: "owner/repo",
    kind: "repo",
    folders: [{ id: "repo_dashboard", label: "Dashboard" }],
    defaultFolderId: "repo_dashboard",
  },
  {
    id: "brand:acme",
    label: "Acme (acme)",
    kind: "brand",
    folders: [{ id: "brand_all", label: "Brand DNA" }],
    defaultFolderId: "brand_all",
  },
  {
    id: "brand:claimflow",
    label: "ClaimFlow (claimflow)",
    kind: "brand",
    folders: [{ id: "brand_all", label: "Brand DNA" }],
    defaultFolderId: "brand_all",
  },
]
const LOOP_APPROVAL_RUN_ID = "loop:loop_daily:2026-08-10T11:00:00.000Z"
const PUSH_PUBLIC_KEY = Buffer.from([4, ...Array(64).fill(1)]).toString("base64url")
const STALE_PUSH_PUBLIC_KEY_BYTES = [4, ...Array(64).fill(2)]
const PUSH_ENDPOINT = "https://push.browser-proof.example/subscriptions/device-390"
const PUSH_SUBSCRIPTION_JSON = {
  endpoint: PUSH_ENDPOINT,
  expirationTime: null,
  keys: { p256dh: "browser-proof-p256dh", auth: "browser-proof-auth" },
}

function loopFixtures() {
  return {
    jobs: [{
      id: "loop_daily",
      name: "Morning Box Brief",
      mode: "default",
      cron: "0 11 * * *",
      prompt: "Read the board and name every failure cause.",
      tzOffsetMin: 240,
      createdAt: "2026-08-09T10:00:00Z",
      nextRunAt: "2026-08-10T11:00:00Z",
    }],
  }
}

function multiLoopFixtures() {
  return {
    jobs: [{
      id: "multi_release",
      name: "Release team",
      mode: "default",
      cron: "0 12 * * 1-5",
      tzOffsetMin: 240,
      objective: "Build, independently review, and verify the release.",
      stages: [
        { engine: "codex", instruction: "Build the change." },
        { engine: "hermes", instruction: "Review the current commit." },
      ],
      createdAt: "2026-08-09T10:00:00Z",
      nextRunAt: "2026-08-10T12:00:00Z",
    }],
    serverNow: "2026-08-10T01:00:00Z",
    engines: Object.fromEntries(ENGINE_ORDER.map((id) => [id, id === "cursor"
      ? { available: false, reason: "Cursor is chat-only and human-directed; it never receives unattended work." }
      : { available: true }])),
  }
}

function auditFixture() {
  return {
    observedAt: "2026-08-10T07:25:00.000Z",
    events: Array.from({ length: 24 }, (_, index) => ({
      t: new Date(Date.parse("2026-08-10T07:25:00.000Z") - index * 60_000).toISOString(),
      event: index === 0 ? "frontend_journey_verified" : `audit_event_${String(index + 1).padStart(2, "0")}`,
      detail: index === 0 ? "Every event names its observed cause and stays attached to the durable record." : `Observed audit detail ${index + 1}.`,
      eng: index % 2 === 0 ? "codex" : "hermes",
      tid: index === 0 ? "t_objective" : `t_audit_${index + 1}`,
      ip: "100.64.0.10",
    })),
  }
}

function count(state, key) {
  state.counts.set(key, (state.counts.get(key) || 0) + 1)
}

function response(route, body, status = 200, contentType = "application/json") {
  return route.fulfill({
    status,
    contentType,
    headers: {
      "access-control-allow-origin": "null",
      "access-control-allow-credentials": "true",
      vary: "Origin",
    },
    body: contentType === "application/json" ? JSON.stringify(body) : String(body),
  })
}

async function installMockPushEnvironment(context, { staleSubscription = false } = {}) {
  await context.addInitScript(({ endpoint, subscriptionJson, startsStale, staleApplicationServerKey }) => {
    if (window.top !== window.self) return

    const proof = {
      permission: startsStale ? "granted" : "default",
      permissionRequests: 0,
      getSubscriptionCalls: 0,
      browserSubscribeCalls: 0,
      browserUnsubscribeCalls: 0,
      serviceWorkerRegistrations: 0,
      trustedWorkerLookups: 0,
      active: startsStale,
      initialApplicationServerKey: startsStale ? [...staleApplicationServerKey] : null,
      lastSubscribeOptions: null,
    }
    let activeSubscription = null
    const subscription = {
      endpoint,
      expirationTime: null,
      options: {
        applicationServerKey: startsStale
          ? Uint8Array.from(staleApplicationServerKey).buffer
          : null,
      },
      toJSON: () => ({ ...subscriptionJson, keys: { ...subscriptionJson.keys } }),
      unsubscribe: async () => {
        proof.browserUnsubscribeCalls += 1
        activeSubscription = null
        proof.active = false
        return true
      },
    }
    if (startsStale) activeSubscription = subscription
    const pushManager = {
      getSubscription: async () => {
        proof.getSubscriptionCalls += 1
        return activeSubscription
      },
      subscribe: async (options) => {
        proof.browserSubscribeCalls += 1
        proof.lastSubscribeOptions = {
          userVisibleOnly: options.userVisibleOnly,
          applicationServerKey: Array.from(options.applicationServerKey || []),
        }
        subscription.options = {
          applicationServerKey: Uint8Array.from(options.applicationServerKey || []).buffer,
        }
        activeSubscription = subscription
        proof.active = true
        return subscription
      },
    }
    // The generated production shell owns /sw.js. Next dev deliberately does
    // not install it, so the fixture supplies an already activated trusted
    // worker while still starting with no PushSubscription in the clean case.
    const registration = {
      active: { scriptURL: new URL("/sw.js", window.location.href).href, state: "activated" },
      waiting: null,
      installing: null,
      pushManager,
    }
    const workerContainer = {
      ready: Promise.resolve(registration),
      getRegistrations: async () => {
        proof.trustedWorkerLookups += 1
        return [registration]
      },
      register: async () => {
        proof.serviceWorkerRegistrations += 1
        return registration
      },
    }
    const notification = {
      get permission() { return proof.permission },
      requestPermission: async () => {
        proof.permissionRequests += 1
        proof.permission = "granted"
        return "granted"
      },
    }

    Object.defineProperty(window, "Notification", { configurable: true, value: notification })
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: workerContainer })
    Object.defineProperty(window, "__agenthostPushProof", { configurable: true, value: proof })
  }, {
    endpoint: PUSH_ENDPOINT,
    subscriptionJson: PUSH_SUBSCRIPTION_JSON,
    startsStale: staleSubscription,
    staleApplicationServerKey: STALE_PUSH_PUBLIC_KEY_BYTES,
  })
}

async function installMockApi(page, baseUrl, state) {
  await page.route("**/*", async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.origin !== baseUrl) return route.fallback()
    const method = request.method()
    const pathname = url.pathname

    // The real Command Center proxy gives its opaque Box iframe this exact
    // CORS shape after validating the scoped frame capability. This fixture
    // supplies the already-authorized half so the browser can exercise the
    // unchanged sandbox instead of silently falling back to a top-level page.
    if (method === "OPTIONS" && request.headers().origin === "null") {
      const requestedMethod = String(request.headers()["access-control-request-method"] || "").toUpperCase()
      const requestedHeaders = String(request.headers()["access-control-request-headers"] || "").trim()
      if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(requestedMethod)) {
        return response(route, { error: "unsupported opaque-frame method" }, 405)
      }
      return route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-origin": "null",
          "access-control-allow-credentials": "true",
          "access-control-allow-methods": requestedMethod,
          ...(requestedHeaders ? { "access-control-allow-headers": requestedHeaders } : {}),
          vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
        },
        body: "",
      })
    }

    // Documents and ordinary shell assets always come from the real server at
    // baseUrl. Only the box API routes below are fixtures.
    if (pathname === "/" || ["/audit", "/2fa", "/hermes", "/hermes/"].includes(pathname) || pathname.startsWith("/_next/") || pathname.startsWith("/__nextjs_") || pathname === "/favicon.ico" || pathname === "/manifest.webmanifest" || pathname === "/theme.css" || pathname === "/sw.js" || pathname.startsWith("/icons/")) {
      return route.continue()
    }

    const key = `${method} ${pathname}`
    count(state, key)
    state.requests.push({ method, pathname, search: url.search })

    if (pathname === "/activity/stream") {
      return response(route, "event: ready\ndata: {}\n\n", 200, "text/event-stream")
    }
    if (pathname === "/chat/thread" && method === "GET") {
      return response(route, { entries: Array.from({ length: 30 }, (_, index) => ({
        id: `msg_${index + 1}`,
        at: Date.now() - (30 - index) * 30_000,
        who: index % 2 ? "codex" : "claude",
        text: index === 0 ? "The team is attached to one thread." : `Durable browser proof message ${index + 1}.`,
        to: "team",
      })) })
    }
    if (pathname === "/chat/runs" && method === "GET") return response(route, { runs: [] })
    if (pathname === "/chat/stream" && method === "GET") {
      const body = state.holdChatStream
        ? 'event: engine_delta\ndata: {"t":"Mock team reply still running."}\n\n'
        : 'event: engine_delta\ndata: {"t":"Mock team reply."}\n\nevent: done\ndata: {}\n\n'
      return response(route, body, 200, "text/event-stream")
    }
    if (/^\/chat\/runs\/[^/]+\/cancel$/.test(pathname) && method === "POST") {
      if (state.chatCancelDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.chatCancelDelayMs))
      if (state.failNextChatCancel) {
        state.failNextChatCancel = false
        return response(route, { error: "the box rejected cancellation for the selected agent run" }, 503)
      }
      return response(route, { status: "cancelled", summary: "The active browser-fixture run stopped." })
    }
    if (pathname === "/api/assist" && method === "POST") {
      const body = request.postDataJSON()
      state.assistBodies.push(body)
      if (state.failNextAssist) {
        state.failNextAssist = false
        return response(route, { error: "another Assist request is already running -- try again in a moment" }, 409)
      }
      if (state.holdNextAssist) {
        state.holdNextAssist = false
        state.assistHeld = true
        await new Promise((resolve) => { state.releaseAssist = resolve })
        state.assistHeld = false
        state.releaseAssist = null
      }
      const sharpened = `Sharpened: ${body.text}`
      return response(route, [
        JSON.stringify({ type: "delta", text: "Sharpened: " }),
        JSON.stringify({ type: "delta", text: body.text }),
        JSON.stringify({ type: "done", text: sharpened }),
        "",
      ].join("\n"), 200, "application/x-ndjson")
    }
    if (pathname === "/board" && method === "GET") return response(route, board)
    if (/^\/board\/task\/[^/]+$/.test(pathname) && method === "GET") {
      const id = pathname.split("/").at(-1)
      const task = board.tasks.find((item) => item.id === id) || taskObjective
      return response(route, { task: { ...task, body: "Behavior must be reachable from the running product.", result: task.lane === "done" ? "Verified in browser." : "" }, comments: [{ id: 1, author: "Hermes", text: "Review the current commit, not an older one." }], events: [] })
    }
    if (pathname === "/board/task" && method === "POST") return response(route, { id: "t_created" })
    if (/^\/board\/task\/[^/]+\/review$/.test(pathname) && method === "POST") {
      state.boardReviewBodies.push({ pathname, body: request.postDataJSON() })
      return response(route, { ok: true, task: taskObjective })
    }
    if (/^\/board\/task\/[^/]+\/(?:freeze|unfreeze)$/.test(pathname) && method === "POST") {
      state.boardFreezeBodies.push({ pathname, body: request.postDataJSON() })
      return response(route, { ok: true, task: taskObjective })
    }
    if (pathname.startsWith("/board/task/") && method === "POST") return response(route, { ok: true, task: taskObjective })

    if (pathname === "/cc/state" && method === "GET") {
      state.cc.autonomy.on = state.autonomyOn
      return response(route, state.cc)
    }
    if (pathname === "/audit/data" && method === "GET") return response(route, auditFixture())
    if (pathname === "/cc/inventory" && method === "GET") return response(route, {
      skills: { items: [{ name: "browser-proof", description: "Exercises the reachable Workspace.", source: "test fixture" }] },
      plugins: [{ id: "git-ladder", name: "Git Ladder", description: "Independent review controls.", status: "ready" }],
      mcps: [{ name: "obsidian", description: "Shared brain connector.", status: "ready", tools: ["vault_read", "vault_write"] }],
      toolDetails: [{ name: "playwright", label: "Browser runner", description: "Touch and click proof.", status: "ready" }],
    })
    if (pathname === "/profiles/data" && method === "GET") return response(route, profiles())
    if (pathname === "/usage" && method === "GET") return response(route, { day: state.cc.day, engines: state.cc.usage })

    if (pathname === "/cron/jobs" && method === "GET") return response(route, loopFixtures())
    if (pathname === "/cron/jobs" && method === "POST") return response(route, { job: loopFixtures().jobs[0] })
    if (/^\/cron\/jobs\/[^/]+$/.test(pathname) && method === "DELETE") {
      const delayMs = state.deleteDelayMs.get(pathname) || 0
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
      return response(route, { ok: true })
    }
    if (pathname === "/cron/runs" && method === "GET") return response(route, { runs: [{
      runId: LOOP_APPROVAL_RUN_ID,
      jobId: "loop_daily",
      jobName: "Morning Box Brief",
      startedAt: "2026-08-10T11:00:00Z",
      ms: 0,
      exit: null,
      output: "",
      status: "gated",
      error: "This scheduled run can deploy and needs one exact approval.",
      approvalFingerprint: LOOP_APPROVAL_FINGERPRINT,
      approvalPending: false,
    }] })
    if (/^\/cron\/runs\/[^/]+\/approve$/.test(pathname) && method === "POST") {
      state.lastLoopApprovalBody = request.postDataJSON()
      return response(route, {
        status: "success",
        summary: "This exact Loop run was approved once; the gateway is rechecking it before launch.",
        fingerprint: LOOP_APPROVAL_FINGERPRINT,
      })
    }
    if (pathname === "/cron/multi/jobs" && method === "GET") return response(route, multiLoopFixtures())
    if (pathname === "/cron/multi/jobs" && method === "POST") return response(route, { job: multiLoopFixtures().jobs[0] })
    if (/^\/cron\/multi\/jobs\/[^/]+$/.test(pathname) && method === "DELETE") {
      const delayMs = state.deleteDelayMs.get(pathname) || 0
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
      return response(route, { ok: true })
    }
    if (pathname === "/cron/multi/runs" && method === "GET") return response(route, { runs: [{ runId: "multi_run_1", startedAt: "2026-08-10T00:00:00Z", ms: 2400, status: "completed", stages: [{ engine: "codex", status: "completed", ms: 1200, output: "built" }, { engine: "hermes", status: "completed", ms: 1200, output: "reviewed" }] }] })

    if (pathname === "/growth/accounts" && method === "GET") return response(route, { configured: true, accounts: state.growthAccounts })
    if (pathname === "/growth/accounts" && method === "POST") {
      if (state.growthCreateDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.growthCreateDelayMs))
      const submitted = request.postDataJSON()
      state.growthAccountBodies.push(submitted)
      const account = {
        account_id: `client-${state.growthAccounts.length + 1}`,
        name: submitted.name,
        industry: submitted.industry || null,
        created_at: "2026-08-10T00:00:00Z",
      }
      state.growthAccounts.push(account)
      state.growthDna[account.account_id] = []
      return response(route, { account })
    }
    if (/^\/growth\/accounts\/[^/]+\/dna$/.test(pathname) && method === "GET") {
      const accountId = pathname.split("/")[3]
      return response(route, { configured: true, records: state.growthDna[accountId] || [] })
    }
    if (/^\/growth\/accounts\/[^/]+\/dna\/from-url$/.test(pathname) && method === "POST") {
      if (state.growthDnaBuildDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.growthDnaBuildDelayMs))
      const accountId = pathname.split("/")[3]
      const submitted = request.postDataJSON()
      state.growthDnaBuildBodies.push({ accountId, ...submitted })
      const provenance = {
        source_url: new URL(submitted.url).href,
        source_urls: [new URL(submitted.url).href],
        generated_at: "2026-08-12T12:00:00.000Z",
      }
      const assets = ["guidelines", "voice", "intel", "performance", "calls"]
      const records = assets.map((asset) => ({
        id: `dna-${accountId}-${asset}`,
        asset,
        source: "generated",
        content: asset === "performance"
          ? "No campaign performance evidence was present on the reviewed pages."
          : asset === "calls"
            ? "No call-recording evidence was present on the reviewed pages."
            : `${asset} from the reviewed website evidence.`,
        version: 1,
        updated_at: "2026-08-12T12:00:01.000Z",
        schemaVersion: 1,
        provenance,
      }))
      state.growthDna[accountId] = [
        ...(state.growthDna[accountId] || []).filter((record) => !assets.includes(record.asset)),
        ...records,
      ]
      return response(route, { ok: true, written: 5, records, provenance })
    }
    if (/^\/growth\/accounts\/[^/]+\/dna\/[^/]+$/.test(pathname) && method === "PUT") {
      const [, , , accountId, , asset] = pathname.split("/")
      const submitted = request.postDataJSON()
      const prior = (state.growthDna[accountId] || []).find((record) => record.asset === asset)
      const record = {
        id: prior?.id || `dna-${accountId}-${asset}`,
        asset,
        source: submitted.source,
        content: submitted.content,
        version: (prior?.version || 0) + 1,
        updated_at: "2026-08-10T00:00:00Z",
        schemaVersion: 1,
      }
      state.growthDna[accountId] = [...(state.growthDna[accountId] || []).filter((item) => item.asset !== asset), record]
      return response(route, { record })
    }

    // Measurement Pack (Attribution + Campaigns). Tests start disconnected to
    // prove the dependency CTA, then flip this fixture to a real connection and
    // prove campaign rows from measured facts rather than a sample card.
    if (pathname === "/measurement/status" && method === "GET") return response(route, {
      connected: state.measurementConnected,
      credentialHolder: "pipedream",
      providers: ["meta_ads"],
      disclosure: "Ad-platform credentials are held by Pipedream Connect and are not stored on this box. Measurement data is stored here, in your own cloud.",
      ...(state.measurementConnected ? {} : { why: "measurement is not configured on this box" }),
    })
    if (pathname === "/measurement/connections" && method === "GET") return response(route, {
      connections: state.measurementConnected ? state.measurementConnections : [],
    })
    const measurementConnectionMatch = pathname.match(/^\/measurement\/connections\/([^/]+)$/)
    if (measurementConnectionMatch && method === "DELETE") {
      const connectionId = decodeURIComponent(measurementConnectionMatch[1])
      const connection = state.measurementConnections.find((item) => item.id === connectionId)
      if (!connection) return response(route, { error: "measurement connection not found" }, 404)
      connection.enabled = false
      return response(route, {
        ok: true,
        connection,
        inFlightCancelled: true,
        disclosure: "Future reads from this ad account are stopped on this box. This does not revoke OAuth access at the ad platform or credential provider.",
      })
    }
    const measurementFactsMatch = pathname.match(/^\/measurement\/connections\/([^/]+)\/facts$/)
    if (measurementFactsMatch) {
      const connectionId = decodeURIComponent(measurementFactsMatch[1])
      const connection = state.measurementConnections.find((item) => item.id === connectionId)
      if (!connection) return response(route, { error: "measurement connection not found" }, 404)
      const matchesConnection = (fact) => fact.accountId === connection.accountId
        && fact.provider === connection.provider
        && fact.sourceAccountId === connection.sourceAccountId
      const countForConnection = () => state.measurementFacts.filter(matchesConnection).length
      if (method === "GET") return response(route, { connectionId, count: countForConnection(), enabled: connection.enabled })
      if (method === "DELETE") {
        if (connection.enabled) return response(route, { error: "disconnect this measurement connection before deleting its stored facts" }, 409)
        const deleted = countForConnection()
        state.measurementFacts = state.measurementFacts.filter((fact) => !matchesConnection(fact))
        return response(route, { ok: true, connectionId, deleted })
      }
    }
    if (/^\/measurement\/accounts\/[^/]+\/facts$/.test(pathname) && method === "GET") return response(route, {
      facts: state.measurementConnected ? state.measurementFacts : [],
    })

    if (pathname === "/secret/status" && method === "GET") return response(route, {
      ok: true,
      secrets: Object.keys(state.boxSecrets).sort().map((name) => ({ name, present: true })),
    })
    if (pathname === "/secret" && method === "POST") {
      const submitted = request.postDataJSON()
      state.secretBodies.push(submitted)
      const name = String(submitted.name || "").trim().toUpperCase()
      const updated = Object.hasOwn(state.boxSecrets, name)
      state.boxSecrets[name] = true
      return response(route, { ok: true, name, updated })
    }

    if (pathname === "/api/mode" && method === "GET") return response(route, { mode: state.mode })
    if (pathname === "/api/mode" && method === "POST") {
      const body = request.postDataJSON()
      state.mode = body.mode
      return response(route, { mode: state.mode, status: "restarting" })
    }
    if (pathname === "/api/settings" && method === "GET") return response(route, state.settings)
    if (pathname === "/api/settings" && method === "PUT") {
      const body = request.postDataJSON()
      if (state.failNextSettingsSave) {
        state.failNextSettingsSave = false
        return response(route, { error: "the box rejected this settings change in the browser fixture" }, 503)
      }
      const patch = body?.set || {}
      if (patch.cost && Object.hasOwn(patch.cost, "limitsEnabled")) state.settings.settings.cost.limitsEnabled = Boolean(patch.cost.limitsEnabled)
      for (const [engine, row] of Object.entries(patch.llm?.roster || {})) {
        state.settings.settings.llm.roster[engine] = { ...state.settings.settings.llm.roster[engine], ...row }
      }
      if (patch.providers?.moonshot) {
        state.settings.settings.providers.moonshot = { ...state.settings.settings.providers.moonshot, ...patch.providers.moonshot }
      }
      return response(route, state.settings)
    }
    if (pathname === "/api/settings/reset" && method === "POST") return response(route, state.settings)
    if (pathname === "/api/continuity/providers/moonshot/test" && method === "POST") return response(route, { ok: true, model: "kimi-k3" })
    if (pathname === "/api/capabilities" && method === "GET") return response(route, { ok: true })
    if (pathname === "/api/graphify" && method === "GET") return response(route, { targets: GRAPHIFY_TARGETS, warnings: [] })
    if (pathname === "/api/graphify/operation" && method === "POST") {
      const submitted = request.postDataJSON()
      if (!submitted || JSON.stringify(Object.keys(submitted).sort()) !== JSON.stringify(["folderId", "targetId"])) {
        return response(route, { code: "GRAPHIFY_OPERATION_REQUEST_INVALID", error: "the reservation must contain exactly one Brand target and folder" }, 400)
      }
      const target = GRAPHIFY_TARGETS.find((item) => item.id === submitted.targetId)
      const folder = target?.folders.find((item) => item.id === submitted.folderId)
      if (target?.kind !== "brand" || !folder) {
        return response(route, { code: "GRAPHIFY_SELECTION_INVALID", error: "the selected Brand Graphify target or folder is unavailable" }, 409)
      }
      state.graphifyOperationBodies.push(submitted)
      const selectionKey = JSON.stringify([submitted.targetId, submitted.folderId])
      let operationId = state.graphifyOperationLeases.get(selectionKey)
      if (!operationId) {
        state.graphifyOperationSerial += 1
        operationId = createHash("sha256")
          .update(`graphify-browser-operation:${selectionKey}:${state.graphifyOperationSerial}`)
          .digest("hex")
          .slice(0, 32)
        state.graphifyOperationLeases.set(selectionKey, operationId)
      }
      return response(route, { operationId })
    }
    if (pathname === "/api/graphify/operation" && method === "DELETE") {
      const submitted = request.postDataJSON()
      if (!submitted || JSON.stringify(Object.keys(submitted).sort()) !== JSON.stringify(["folderId", "operationId", "targetId"])
        || !/^[a-f0-9]{32}$/.test(submitted.operationId)) {
        return response(route, { code: "GRAPHIFY_OPERATION_REQUEST_INVALID", error: "the acknowledgement must contain exactly one Brand target, folder, and operation id" }, 400)
      }
      const target = GRAPHIFY_TARGETS.find((item) => item.id === submitted.targetId)
      const folder = target?.folders.find((item) => item.id === submitted.folderId)
      if (target?.kind !== "brand" || !folder) {
        return response(route, { code: "GRAPHIFY_SELECTION_INVALID", error: "the selected Brand Graphify target or folder is unavailable" }, 409)
      }
      const selectionKey = JSON.stringify([submitted.targetId, submitted.folderId])
      const acknowledgementKey = JSON.stringify([submitted.targetId, submitted.folderId, submitted.operationId])
      const activeOperationId = state.graphifyOperationLeases.get(selectionKey)
      const alreadyAcknowledged = state.graphifyAcknowledgedOperations.has(acknowledgementKey)
      if (!alreadyAcknowledged
        && (activeOperationId !== submitted.operationId || !state.graphifyReceipts.has(acknowledgementKey))) {
        return response(route, { code: "GRAPHIFY_OPERATION_ACKNOWLEDGEMENT_DECLINED", error: "the Brand Graphify operation does not match the active retry reservation" }, 409)
      }
      state.graphifyAckBodies.push(submitted)
      if (activeOperationId === submitted.operationId) state.graphifyOperationLeases.delete(selectionKey)
      state.graphifyAcknowledgedOperations.add(acknowledgementKey)
      return response(route, { ok: true, targetId: submitted.targetId, folderId: submitted.folderId, operationId: submitted.operationId })
    }
    if (pathname === "/api/graphify" && method === "POST") {
      const submitted = request.postDataJSON()
      if (!submitted || JSON.stringify(Object.keys(submitted).sort()) !== JSON.stringify(["folderId", "operationId", "targetId"])
        || !/^[a-f0-9]{32}$/.test(submitted.operationId)) {
        return response(route, { code: "GRAPHIFY_REQUEST_INVALID", error: "Graphify requires an exact target, folder, and operation id" }, 400)
      }
      const target = GRAPHIFY_TARGETS.find((item) => item.id === submitted.targetId)
      const folder = target?.folders.find((item) => item.id === submitted.folderId)
      if (!target || !folder) return response(route, { code: "GRAPHIFY_SELECTION_INVALID", error: "the selected Graphify target or folder is unavailable" }, 409)
      const selectionKey = JSON.stringify([submitted.targetId, submitted.folderId])
      if (target.kind === "brand" && state.graphifyOperationLeases.get(selectionKey) !== submitted.operationId) {
        return response(route, { code: "GRAPHIFY_OPERATION_REQUIRED", error: "the Brand graph must use its active retry reservation" }, 409)
      }
      state.graphifyBodies.push(submitted)
      const receiptKey = JSON.stringify([submitted.targetId, submitted.folderId, submitted.operationId])
      const existingReceipt = state.graphifyReceipts.get(receiptKey)
      if (existingReceipt) return response(route, existingReceipt)
      const receiptNumber = state.graphifyReceipts.size + 1
      const runId = `graphify-browser-${receiptNumber}`
      const slug = `${target.kind}-${receiptNumber}`
      const htmlName = `graphify-${slug}-0123456789abcdef0123456789abcdef.html`
      const reportName = `graphify-${slug}-0123456789abcdef0123456789abcdef.md`
      const receipt = {
        runId,
        target: { id: target.id, label: target.label },
        folder: { id: folder.id, label: folder.label },
        snapshot: {
          kind: target.kind === "repo" ? "git" : "folder",
          value: target.kind === "repo" ? "174ef8c98003206a" : "2026-08-14T12:00:00.000Z",
          manifestSha256: "a".repeat(64),
          builtAt: "2026-08-14T12:00:00.000Z",
          derived: true,
        },
        artifacts: {
          html: { name: htmlName, viewUrl: `/artifacts/view?p=${htmlName}`, downloadUrl: `/artifacts/dl?p=${htmlName}` },
          markdown: { name: reportName, viewUrl: `/artifacts/view?p=${reportName}`, downloadUrl: `/artifacts/dl?p=${reportName}` },
        },
        counts: { files: 15, inputBytes: 1572864, nodes: 1005, links: 2591 },
      }
      state.graphifyReceipts.set(receiptKey, receipt)
      return response(route, receipt)
    }

    if (pathname === "/2fa/status" && method === "GET") return response(route, state.twoFactor)
    if (pathname === "/2fa/enroll" && method === "POST") {
      state.lastTwoFactorEnrollBody = request.postDataJSON()
      return response(route, {
        secret: "JBSWY3DPEHPK3PXP",
        otpauth: "otpauth://totp/AgentHost:browser-proof?secret=JBSWY3DPEHPK3PXP&issuer=AgentHost",
      })
    }
    if (pathname === "/2fa/confirm" && method === "POST") {
      state.lastTwoFactorConfirmBody = request.postDataJSON()
      if (state.twoFactorConfirmDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.twoFactorConfirmDelayMs))
      state.twoFactor = { available: true, enrolled: true }
      return response(route, { ok: true, reauthenticate: false })
    }
    if (pathname === "/2fa/disable" && method === "POST") {
      state.lastTwoFactorDisableBody = request.postDataJSON()
      if (state.failNextTwoFactorDisable) {
        state.failNextTwoFactorDisable = false
        return response(route, { error: "the current authenticator code was rejected by the browser fixture" }, 400)
      }
      state.twoFactor = { available: true, enrolled: false }
      return response(route, { ok: true, reauthenticate: false })
    }

    if (pathname === "/push/key" && method === "GET") return response(route, { key: PUSH_PUBLIC_KEY })
    if (pathname === "/push/status" && method === "POST") {
      const body = request.postDataJSON()
      assert.ok(body.endpoint === "" || body.endpoint === PUSH_ENDPOINT, "push status checks only this browser's endpoint or the empty clean-profile sentinel")
      state.pushStatusBodies.push(body)
      return response(route, {
        subscribed: state.pushSubscribed,
        originReset: state.pushOriginReset,
        signingKeyReset: state.pushSigningKeyReset,
      })
    }
    if (pathname === "/push/subscribe" && method === "POST") {
      const body = request.postDataJSON()
      state.pushSubscriptionBodies.push(body)
      state.pushSubscribed = true
      return response(route, { ok: true })
    }
    if (pathname === "/push/unsubscribe" && method === "POST") {
      const body = request.postDataJSON()
      state.pushUnsubscriptionBodies.push(body)
      if (state.pushUnsubscribeDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.pushUnsubscribeDelayMs))
      if (state.failNextPushUnsubscribe) {
        state.failNextPushUnsubscribe = false
        return response(route, { error: "the box could not remove this browser notification subscription" }, 503)
      }
      state.pushSubscribed = false
      return response(route, { ok: true })
    }

    if (pathname === "/brain/api/graph" && method === "GET") return response(route, {
      graph: {
        snapshot: "b".repeat(64),
        nodes: [
          { id: "vault:team", memoryId: "m_shared_1" },
          { id: "vault:qa", memoryId: "m_shared_2" },
        ],
        edges: [{ source: "vault:team", target: "vault:qa", relation: "references", confidence: "EXTRACTED" }],
      },
    })
    if (pathname === "/brain/api/memories" && method === "GET") return response(route, { memories: state.memories })
    if (pathname === "/brain/api/memories" && method === "POST") {
      const body = request.postDataJSON()
      const memory = { id: "m_created", agent: "codex", scope: body.scope || "shared", kind: body.kind || "fact", content: body.content, tags: body.tags || [], created_at: "2026-08-10T08:00:00Z" }
      state.memories.push(memory)
      return response(route, { memory })
    }
    if (pathname === "/brain/api/ingest" && method === "POST") {
      if (state.memoryIngestDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.memoryIngestDelayMs))
      if (state.failNextMemoryIngest) {
        state.failNextMemoryIngest = false
        return response(route, { error: "the selected memory file could not be read by the browser fixture" }, 503)
      }
      return response(route, { route: "text" })
    }
    if (pathname === "/cc/mesh" && method === "GET") return response(route, {
      boxId: "box-steve",
      state: "LIVE",
      epoch: 3,
      peers: [{ boxId: "laptop-steve", lastContactAt: "2026-08-10T01:00:00Z", lastEvent: { event: "delivered", dir: "in", kind: "team-message", reason: null }, lastCausalHash: "abc123", delivered: 8, rejected: 0, refusedLocked: 0 }],
      peersConfigured: 1,
      recent: [{ t: "2026-08-10T01:00:00Z", peer: "laptop-steve", event: "delivered", dir: "in", kind: "team-message", reason: null }],
      taskAssociation: "Messages attach to the durable team thread.",
    })
    if (pathname === "/cc/mesh/message" && method === "POST") return response(route, { status: "published", messageId: "mesh_test", peers: ["laptop-steve"], summary: "Published to 1 peer." })
    if (pathname === "/autonomy" && method === "POST") {
      state.autonomyOn = Boolean(request.postDataJSON()?.on)
      return response(route, { ok: true, on: state.autonomyOn })
    }

    if (pathname === "/files" && method === "GET") return response(route, { roots: [
      { key: "team", label: "Team inbox", files: [{ name: "handoff.md", rel: "team/handoff.md", size: 4096, mtime: Date.now() }, { name: "evidence.txt", rel: "team/evidence.txt", size: 1024, mtime: Date.now() }] },
      { key: "proof", label: "Proof files", files: [{ name: "journey.json", rel: "proof/journey.json", size: 2048, mtime: Date.now() }] },
    ] })
    if (pathname === "/files/upload" && method === "POST") {
      if (state.fileUploadDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.fileUploadDelayMs))
      state.lastFileUpload = { filename: request.headers()["x-filename"] || null, bytes: request.postDataBuffer()?.byteLength || 0 }
      if (state.failNextFileUpload) {
        state.failNextFileUpload = false
        return response(route, { error: "the box team inbox rejected the selected browser-proof file" }, 503)
      }
      return response(route, { name: request.headers()["x-filename"] || "uploaded.txt" })
    }
    if (pathname === "/artifacts" && method === "GET") return response(route, { files: JOURNEY_ARTIFACTS.map((artifact) => ({
      ...artifact, kind: "html", review: state.artifactReviews[artifact.name] || null,
      reviewStale: false, reviewError: null, contentVersion: CREATIVE_CONTENT_VERSION, size: 8192, mtime: Date.now(),
    })) })
    if (pathname === "/artifacts/review" && method === "POST") {
      const submitted = request.postDataJSON()
      state.artifactReviewBodies.push(submitted)
      const review = submitted.action === "approve"
        ? "approved"
        : submitted.action === "reject" ? "rejected" : "changes-requested"
      state.artifactReviews[submitted.name] = review
      return response(route, {
        ok: true,
        name: submitted.name,
        review,
        contentVersion: submitted.contentVersion,
        ...(submitted.action === "request-adjustments" ? {
          operationId: submitted.operationId,
          task: { id: "creative_revision_1", title: "Revise creative artifact", assignee: "codex" },
        } : {}),
      })
    }
    if (pathname === "/switch" && method === "POST") {
      if (state.failNextTerminalSwitch) {
        state.failNextTerminalSwitch = false
        return response(route, "tmux could not select the requested Agent window", 503, "text/plain")
      }
      return response(route, { ok: true, window: url.searchParams.get("window") })
    }
    if (pathname === "/terminal/") return response(route, "<!doctype html><title>Mock terminal frame</title><main>Mock terminal frame — browser suite only; real ttyd proof is separate.</main>", 200, "text/html")
    if (pathname.startsWith("/artifacts/dl")) {
      return route.fulfill({ status: 200, contentType: "text/html", headers: { "content-disposition": 'attachment; filename="complete-journey.html"' }, body: "fixture" })
    }
    if (pathname.startsWith("/artifacts/view")) {
      return response(route, "<!doctype html><title>Interactive relationship graph</title><main>Interactive relationship graph fixture</main>", 200, "text/html")
    }
    if (pathname.startsWith("/files/dl") || pathname.startsWith("/growth/accounts/") && pathname.endsWith("/export")) {
      return response(route, "fixture", 200, "text/plain")
    }

    return response(route, { error: `browser fixture has no route for ${method} ${pathname}` }, 404)
  })
}

function startLegalGate(home) {
  assert.ok(fs.existsSync(GATE), "the real AgentHost gate exists")
  assert.ok(fs.existsSync(GENERATED_DASHBOARD_INDEX), "the generated dashboard artifact exists")
  const child = spawn(process.execPath, [GATE], {
    env: {
      ...process.env,
      HOME: home,
      TTYD_PASSWORD: LEGAL_GATE_KEY,
      AGENTHOST_BRAND: "legal",
      AGENT_CHAT_BIN: process.platform === "win32" ? process.execPath : "/bin/true",
      AGENTHOST_MODE_FILE: path.join(home, "absent-mode.json"),
      WAKE_CHECKIN: "off",
      GATE_PORT: "0",
      CHANNEL_DISPATCH_PORT: "0",
      KANBAN_BRIDGE_PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => { stdout += chunk.toString() })
  child.stderr.on("data", (chunk) => { stderr += chunk.toString() })
  return {
    child,
    output: () => ({ stdout, stderr }),
  }
}

async function waitForLegalGateOrigin(processState) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (processState.child.exitCode !== null) {
      const output = processState.output()
      throw new Error(`Legal gate exited before publishing its actual port (${processState.child.exitCode}); stdout=${output.stdout}; stderr=${output.stderr}`)
    }
    const output = processState.output()
    const match = `${output.stdout}\n${output.stderr}`.match(/\[gate\] listening on (\d+)/)
    if (match) return `http://127.0.0.1:${match[1]}`
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  const output = processState.output()
  throw new Error(`Legal gate did not publish its actual ephemeral port within 30 seconds; stdout=${output.stdout}; stderr=${output.stderr}`)
}

async function authenticatedCookie(baseUrl) {
  const { cookie: pair } = await mintOperatorSession(baseUrl, LEGAL_GATE_KEY)
  const separator = pair.indexOf("=")
  assert.ok(separator > 0, "the real Legal gate returned an authentication cookie")
  return { name: pair.slice(0, separator), value: pair.slice(separator + 1), url: baseUrl }
}

function startNext(port) {
  assert.ok(fs.existsSync(NEXT_RUNNER), "the dashboard Next wrapper is installed")
  const child = spawn(process.execPath, [NEXT_RUNNER, "dev", "--webpack", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: DASHBOARD,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => { stdout += chunk.toString() })
  child.stderr.on("data", (chunk) => { stderr += chunk.toString() })
  return {
    child,
    output: () => ({ stdout, stderr }),
  }
}

async function waitForNextOrigin(processState) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (processState.child.exitCode !== null) {
      const output = processState.output()
      throw new Error(`Next exited before publishing its actual port (${processState.child.exitCode}); stdout=${output.stdout}; stderr=${output.stderr}`)
    }
    const output = processState.output()
    const plain = `${output.stdout}\n${output.stderr}`.replace(/\x1b\[[0-9;]*m/g, "")
    const match = plain.match(/Local:\s+(https?:\/\/127\.0\.0\.1:\d+)/i)
    if (match) return match[1]
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  const output = processState.output()
  throw new Error(`Next did not publish its actual ephemeral port within 30 seconds; stdout=${output.stdout}; stderr=${output.stderr}`)
}

async function waitForNext(baseUrl, processState) {
  const deadline = Date.now() + 90_000
  let last = "no response"
  while (Date.now() < deadline) {
    if (processState.child.exitCode !== null) {
      const output = processState.output()
      throw new Error(`Next exited before it was ready (${processState.child.exitCode}); stdout=${output.stdout}; stderr=${output.stderr}`)
    }
    try {
      const result = await fetch(baseUrl)
      if (result.ok) return
      last = `HTTP ${result.status}`
    } catch (error) {
      last = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  const output = processState.output()
  throw new Error(`Next was not ready within 90 seconds (${last}); stdout=${output.stdout}; stderr=${output.stderr}`)
}

async function startEphemeralNext() {
  // Let the OS choose the port in the child itself. Reserving and releasing a
  // port in the parent leaves a TOCTOU window where another process can bind.
  const processState = startNext(0)
  try {
    const baseUrl = await waitForNextOrigin(processState)
    await waitForNext(baseUrl, processState)
    return { baseUrl, processState, portSource: "child-listen(0)" }
  } catch (error) {
    try {
      await closeNext(processState.child)
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Next startup failed and its child process did not cleanly exit")
    }
    throw error
  }
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
  const options = fs.existsSync(PINNED_CHROMIUM)
    ? { executablePath: PINNED_CHROMIUM, timeout: 20_000 }
    : fs.existsSync(WINDOWS_EDGE)
      ? { executablePath: WINDOWS_EDGE, timeout: 20_000 }
      : { channel: "chrome", timeout: 20_000 }
  const server = await playwright.chromium.launchServer(options)
  try {
    return { browser: await playwright.chromium.connect(server.wsEndpoint()), server }
  } catch (error) {
    const process = server.process()
    try {
      await Promise.race([
        server.kill(),
        new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error("Chromium launch cleanup timed out after 5 seconds")), 5000)
          timer.unref?.()
        }),
      ])
      if (!await waitForChildExit(process, 5000)) {
        throw new Error(`Chromium process ${process.pid || "unknown"} remained alive after launch cleanup`)
      }
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Chromium launched but its Playwright connection and cleanup both failed")
    }
    throw error
  }
}

function childExited(child) {
  return !child || child.exitCode !== null || child.signalCode !== null
}

function waitForChildExit(child, milliseconds) {
  if (childExited(child)) return Promise.resolve(true)
  return new Promise((resolve) => {
    let settled = false
    let timer
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.removeListener("exit", onExit)
      resolve(value)
    }
    const onExit = () => finish(true)
    child.once("exit", onExit)
    timer = setTimeout(() => finish(childExited(child)), milliseconds)
    timer.unref?.()
    if (childExited(child)) finish(true)
  })
}

async function closeBrowser(handle) {
  if (!handle) return
  const process = handle.server.process()
  let gracefulError = null
  const closed = await Promise.race([
    handle.server.close().then(() => true).catch((error) => {
      gracefulError = error
      return false
    }),
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 15_000)
      timer.unref?.()
    }),
  ])
  if (closed && await waitForChildExit(process, 1000)) return

  const causes = [gracefulError || new Error("Chromium did not close within 15 seconds")]
  try {
    await Promise.race([
      handle.server.kill(),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error("forced Chromium termination timed out after 5 seconds")), 5000)
        timer.unref?.()
      }),
    ])
  } catch (error) {
    causes.push(error)
  }
  if (!await waitForChildExit(process, 5000)) {
    causes.push(new Error(`Chromium process ${process.pid || "unknown"} remained alive after forced termination`))
  }
  throw new AggregateError(causes, "Chromium required forced termination during E2E cleanup")
}

async function closeContext(context) {
  if (!context) return
  let timeout
  try {
    await Promise.race([
      context.close(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("the browser context did not close within 5 seconds")), 5000)
        timeout.unref?.()
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

async function closeNext(child) {
  if (child.connected && typeof child.send === "function") {
    const delivered = await new Promise((resolve) => {
      try { child.send(NEXT_SHUTDOWN_MESSAGE, (error) => resolve(!error)) } catch { resolve(false) }
    })
    if (delivered && await waitForChildExit(child, 5000)) return
  }
  const closed = await Promise.race([
    stopChild(child).then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
  ])
  if ((closed || childExited(child)) && childExited(child)) return
  try { child.kill("SIGKILL") } catch {}
  if (!await waitForChildExit(child, 5000)) {
    throw new Error(`the local Next process ${child.pid || "unknown"} did not stop after SIGTERM and SIGKILL`)
  }
}

async function closeLegalGate(child) {
  try {
    await closeNext(child)
  } catch (error) {
    throw new Error("the disposable Legal gate did not stop cleanly", { cause: error })
  }
}

function startDiagnostics(page, label) {
  const diagnostics = { label, consoleErrors: [], resourceConsoleErrors: [], sandboxBlocks: [], hydrationMessages: [], pageErrors: [], expectedHttpFailures: [], unexpectedHttpFailures: [], expectedDownloadAborts: [], failedRequests: [] }
  page.on("console", (message) => {
    const text = message.text()
    if (/hydrated|hydration/i.test(text)) diagnostics.hydrationMessages.push(text)
    if (message.type() === "error") {
      const record = { text, location: message.location() }
      if (/Failed to load resource:/i.test(text)) diagnostics.resourceConsoleErrors.push(record)
      else if (/Blocked script execution .* sandboxed and the ['\"]allow-scripts['\"] permission is not set/i.test(text)) diagnostics.sandboxBlocks.push(record)
      else diagnostics.consoleErrors.push(record)
    }
  })
  page.on("pageerror", (error) => diagnostics.pageErrors.push({ message: error.message, stack: error.stack || null }))
  page.on("response", (browserResponse) => {
    if (browserResponse.status() < 400) return
    const url = new URL(browserResponse.url())
    const record = { method: browserResponse.request().method(), pathname: url.pathname, status: browserResponse.status() }
    if ((record.method === "PUT" && record.pathname === "/api/settings" && record.status === 503)
      || (record.method === "POST" && record.pathname === "/2fa/disable" && record.status === 400)
      || (record.method === "POST" && record.pathname === "/brain/api/ingest" && record.status === 503)
      || (record.method === "POST" && record.pathname === "/files/upload" && record.status === 503)
      || (record.method === "POST" && record.pathname === "/api/assist" && record.status === 409)
      || (record.method === "POST" && record.pathname === "/push/unsubscribe" && record.status === 503)
      || (record.method === "POST" && record.pathname === "/switch" && record.status === 503)
      || (record.method === "POST" && /^\/chat\/runs\/[^/]+\/cancel$/.test(record.pathname) && record.status === 503)) {
      diagnostics.expectedHttpFailures.push(record)
    } else {
      diagnostics.unexpectedHttpFailures.push(record)
    }
  })
  page.on("requestfailed", (request) => {
    const cause = request.failure()?.errorText || "unknown cause"
    const url = new URL(request.url())
    if (request.method() === "GET" && ["/files/dl", "/artifacts/dl"].includes(url.pathname) && /ERR_ABORTED/i.test(cause)) {
      diagnostics.expectedDownloadAborts.push(`${request.method()} ${url.pathname} — ${cause}`)
      return
    }
    diagnostics.failedRequests.push(`${request.method()} ${request.url()} — ${cause}`)
  })
  return diagnostics
}

async function assertNoErrorOverlay(page, diagnostics) {
  const overlayText = await page.locator("nextjs-portal").allTextContents()
  const errorOverlay = overlayText.filter((text) => /Console Error|Runtime Error|Unhandled Runtime Error|hydrated but/i.test(text))
  assert.deepEqual(errorOverlay, [], `${diagnostics.label} displayed no Next error overlay`)
  assert.deepEqual(diagnostics.hydrationMessages, [], `${diagnostics.label} reported no hydration mismatch despite extension-style body attributes`)
  assert.deepEqual(diagnostics.pageErrors, [], `${diagnostics.label} raised no genuine component page errors`)
  assert.deepEqual(diagnostics.consoleErrors, [], `${diagnostics.label} wrote no genuine console errors`)
  const unexpectedResourceErrors = diagnostics.resourceConsoleErrors.filter((record) => {
    const pathname = record.location?.url ? new URL(record.location.url).pathname : null
    return !diagnostics.expectedHttpFailures.some((failure) => failure.pathname === pathname)
  })
  assert.deepEqual(unexpectedResourceErrors, [], `${diagnostics.label} wrote no unexpected resource console errors`)
  assert.deepEqual(diagnostics.unexpectedHttpFailures, [], `${diagnostics.label} received no unexpected failing HTTP responses`)
  assert.deepEqual(diagnostics.failedRequests, [], `${diagnostics.label} had no failed browser requests`)
}

async function devOverlayText(page) {
  return page.locator('nextjs-portal [data-nextjs-dialog][aria-labelledby="nextjs__container_errors_label"]').allTextContents()
}

async function neutralizeDevToolbar(page) {
  // Next's development toolbar is not part of AgentHost. On a touch viewport
  // its portal host can cover the bottom navigation even when no error exists.
  // Keep genuine errors observable through console/pageerror and the dialog
  // selector above, while making the dev-only toolbar pointer-transparent.
  await page.addStyleTag({ content: "nextjs-portal { pointer-events: none !important; }" })
}

async function screenshot(page, name) {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true })
  await page.screenshot({ path: path.join(ARTIFACT_DIR, name), fullPage: true, animations: "disabled", timeout: 60_000 })
}

function primaryNav(page) {
  return page.locator('nav[aria-label="Primary navigation"]:visible')
}

async function tapRoom(page, name, touch = false) {
  const button = primaryNav(page).getByRole("button", { name: new RegExp(`^${name}(?:\\s|$)`, "i") })
  await button.waitFor({ state: "visible" })
  if (touch) await button.tap()
  else await button.click()
}

async function clickSection(page, railName, sectionName, touch = false) {
  const rail = page.getByRole("region", { name: railName })
  await rail.waitFor({ state: "visible" })
  const button = rail.getByRole("button", { name: new RegExp(`^${sectionName}(?:\\s|$)`, "i") })
  if (touch) await button.tap()
  else await button.click()
}

async function keyboardScrollRail(page, name) {
  const rail = page.getByRole("region", { name })
  await rail.waitFor({ state: "visible" })
  const metrics = await rail.evaluate((element) => ({ left: element.scrollLeft, max: element.scrollWidth - element.clientWidth }))
  assert.ok(metrics.max > 0, `${name} has real horizontal overflow`)
  await rail.focus()
  await page.keyboard.press("End")
  await page.waitForFunction((element) => element.scrollLeft > 0, await rail.elementHandle())
  const end = await rail.evaluate((element) => element.scrollLeft)
  assert.ok(end > metrics.left, `${name} responds to keyboard horizontal scrolling`)
}

async function touchSwipe(page, locator, { x = -220, y = 0, observe = null } = {}) {
  const element = typeof locator.elementHandle === "function" ? await locator.elementHandle() : locator
  assert.ok(element, "touch-scroll target exists")
  const observed = observe
    ? (typeof observe.elementHandle === "function" ? await observe.elementHandle() : observe)
    : element
  assert.ok(observed, "touch-scroll observation target exists")
  const box = await element.boundingBox()
  assert.ok(box && box.width > 20 && box.height > 20, "touch-scroll target is visible")
  const targetPolicy = await element.evaluate((node) => {
    const style = getComputedStyle(node)
    return {
      touchAction: style.touchAction,
      scrollSnapType: style.scrollSnapType,
      overflowX: style.overflowX,
      overflowY: style.overflowY,
    }
  })
  const before = await observed.evaluate((node) => ({
    left: node.scrollLeft,
    top: node.scrollTop,
    maxLeft: node.scrollWidth - node.clientWidth,
    maxTop: node.scrollHeight - node.clientHeight,
  }))
  const session = await page.context().newCDPSession(page)
  const viewport = page.viewportSize()
  const viewportWidth = viewport?.width || box.x + box.width
  const viewportHeight = viewport?.height || box.y + box.height
  const start = await element.evaluate((node, { viewportWidth, viewportHeight }) => {
    const rect = node.getBoundingClientRect()
    const left = Math.max(1, rect.left)
    const right = Math.min(viewportWidth - 1, rect.right)
    const top = Math.max(1, rect.top)
    const bottom = Math.min(viewportHeight - 1, rect.bottom)
    if (right - left <= 20 || bottom - top <= 20) return null
    for (const yRatio of [0.25, 0.5, 0.75]) {
      for (const xRatio of [0.75, 0.5, 0.25]) {
        const candidate = { x: left + (right - left) * xRatio, y: top + (bottom - top) * yRatio }
        const hit = document.elementFromPoint(candidate.x, candidate.y)
        if (hit && node.contains(hit)) {
          return {
            point: candidate,
            hit: {
              tag: hit.tagName.toLowerCase(),
              ariaLabel: hit.getAttribute("aria-label"),
              role: hit.getAttribute("role"),
              className: typeof hit.className === "string" ? hit.className : "",
              text: (hit.textContent || "").trim().slice(0, 120),
            },
          }
        }
      }
    }
    return null
  }, { viewportWidth, viewportHeight })
  if (!start) {
    await session.detach()
    return { before, after: before, moved: false, blocked: true, cause: "touch-scroll target has no unobscured point inside the phone viewport", targetPolicy, start: null }
  }
  const { x: startX, y: startY } = start.point
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: startX, y: startY }] })
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())))
  for (let step = 1; step <= 8; step += 1) {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: startX + x * step / 8, y: startY + y * step / 8 }],
    })
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())))
  }
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
  await session.detach()
  const horizontal = Math.abs(x) >= Math.abs(y)
  const expectedDirection = horizontal ? -Math.sign(x) : -Math.sign(y)
  const moved = await page.waitForFunction(
    ({ node, before, horizontal, expectedDirection }) => {
      const delta = horizontal ? node.scrollLeft - before.left : node.scrollTop - before.top
      return delta * expectedDirection > 0
    },
    { node: observed, before, horizontal, expectedDirection },
    { timeout: 2500 },
  ).then(() => true, () => false)
  if (moved) await waitForScrollSettled(observed)
  const after = await observed.evaluate((node) => ({ left: node.scrollLeft, top: node.scrollTop }))
  return { before, after, moved, targetPolicy, start }
}

async function touchTap(page, locator) {
  const element = typeof locator.elementHandle === "function" ? await locator.elementHandle() : locator
  assert.ok(element, "touch target exists")
  const observation = await touchTargetObservation(element)
  if (!observation.point) return { observation, blocked: true, durationMs: 0 }
  const activationToken = `${Date.now()}-${Math.random()}`
  await element.evaluate((node, token) => {
    const prior = node.__agenthostTouchProof
    if (prior?.handler) node.removeEventListener("click", prior.handler, true)
    const proof = { token, armedAt: performance.now(), clickedAt: null, clicked: false, trusted: false, target: null, handler: null }
    proof.handler = (event) => {
      if (!event.isTrusted) return
      proof.clicked = true
      proof.trusted = true
      proof.clickedAt = performance.now()
      proof.target = event.target instanceof Element
        ? { tag: event.target.tagName.toLowerCase(), ariaLabel: event.target.getAttribute("aria-label"), role: event.target.getAttribute("role") }
        : null
      node.removeEventListener("click", proof.handler, true)
    }
    node.addEventListener("click", proof.handler, true)
    node.__agenthostTouchProof = proof
  }, activationToken)
  const startedAt = await page.evaluate(() => performance.now())
  try {
    await element.tap({
      position: {
        x: observation.point.x - observation.rect.x,
        y: observation.point.y - observation.rect.y,
      },
    })
    await page.waitForFunction(
      ({ node, token }) => node.__agenthostTouchProof?.token === token && node.__agenthostTouchProof.clicked && node.__agenthostTouchProof.trusted,
      { node: element, token: activationToken },
      { timeout: 750 },
    ).catch(() => null)
    const activation = await element.evaluate((node, token) => {
      const proof = node.__agenthostTouchProof
      return {
        clicked: proof?.token === token && proof.clicked === true,
        trusted: proof?.token === token && proof.trusted === true,
        target: proof?.token === token ? proof.target : null,
        latencyMs: proof?.token === token && proof.clickedAt != null ? proof.clickedAt - proof.armedAt : null,
      }
    }, activationToken).catch(() => ({ clicked: false, trusted: false, target: null, latencyMs: null }))
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    const endedAt = await page.evaluate(() => performance.now())
    return { observation, blocked: false, activation, durationMs: endedAt - startedAt }
  } finally {
    await element.evaluate((node, token) => {
      const proof = node.__agenthostTouchProof
      if (proof?.token !== token) return
      if (proof.handler) node.removeEventListener("click", proof.handler, true)
      delete node.__agenthostTouchProof
    }, activationToken).catch(() => {})
  }
}

async function touchTapPosition(page, locator, position) {
  await locator.waitFor({ state: "visible" })
  await locator.evaluate((node) => node.scrollIntoView({ block: "center", inline: "nearest" }))
  const box = await locator.boundingBox()
  assert.ok(box, "positioned touch target is visible")
  assert.ok(position.x >= 0 && position.x <= box.width && position.y >= 0 && position.y <= box.height, `positioned touch stays inside target: ${JSON.stringify({ box, position })}`)
  const point = { x: box.x + position.x, y: box.y + position.y }
  const hit = await page.evaluate(({ x, y }) => {
    const node = document.elementFromPoint(x, y)
    return node ? { tag: node.tagName.toLowerCase(), ariaLabel: node.getAttribute("aria-label"), className: typeof node.className === "string" ? node.className : "" } : null
  }, point)
  const session = await page.context().newCDPSession(page)
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] })
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())))
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
  await session.detach()
  return { box, position, point, hit }
}

function projectedBrainLobePoint(width, height, index, total) {
  if (index === null) return { x: width / 2, y: height / 2 }
  const sceneScale = width < 640 ? Math.max(0.52, Math.min(1, width / 600)) : 1
  const angle = (index / total) * Math.PI * 2 - Math.PI / 2
  const point = {
    x: Math.cos(angle) * 162 * sceneScale,
    y: Math.sin(angle) * 78 * sceneScale,
    z: Math.sin(angle * 1.7) * 92 * sceneScale,
  }
  const yaw = 0.58
  const pitch = -0.2
  const distance = 480
  const x = point.x * Math.cos(yaw) + point.z * Math.sin(yaw)
  const z = -point.x * Math.sin(yaw) + point.z * Math.cos(yaw)
  const y = point.y * Math.cos(pitch) - z * Math.sin(pitch)
  const depth = point.y * Math.sin(pitch) + z * Math.cos(pitch)
  const scale = distance / (distance + depth)
  return { x: width / 2 + x * scale, y: height / 2 + y * scale }
}

async function touchTapAndWait(page, locator, readyLocator, label, maxAttempts = 3) {
  assert.equal(await readyLocator.isVisible(), false, `${label} outcome starts closed`)
  const receipts = []
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await locator.scrollIntoViewIfNeeded()
    const scrollerHandle = await locator.evaluateHandle((node) => {
      let current = node.parentElement
      while (current) {
        const style = getComputedStyle(current)
        if (/(auto|scroll)/.test(style.overflowY) && current.scrollHeight > current.clientHeight + 8) return current
        current = current.parentElement
      }
      const pageScroller = document.scrollingElement
      return pageScroller && pageScroller.scrollHeight > pageScroller.clientHeight + 8 ? pageScroller : null
    })
    const scroller = scrollerHandle.asElement()
    let receipt
    let scroll = null
    try {
      if (scroller) {
        await waitForScrollSettled(scroller)
        scroll = { before: await scroller.evaluate((node) => ({ left: node.scrollLeft, top: node.scrollTop })) }
      }
      receipt = await touchTap(page, locator)
      if (scroller) scroll.after = await scroller.evaluate((node) => ({ left: node.scrollLeft, top: node.scrollTop }))
    } finally {
      await scrollerHandle.dispose()
    }
    receipts.push({ attempt, scroll, ...receipt })
    const ready = await readyLocator.waitFor({ state: "visible", timeout: 1800 }).then(() => true, () => false)
    if (receipt.activation?.clicked && receipt.activation.trusted && ready) return receipts
  }
  assert.fail(`${label} did not open after ${maxAttempts} real touch attempts: ${JSON.stringify(receipts)}`)
}

function createPhoneCoverageLedger() {
  const required = []
  for (const item of LIVE_SURFACE_INVENTORY.globalControls) required.push(`global:${item}`)
  for (const [room, items] of Object.entries(LIVE_SURFACE_INVENTORY.roomControls)) {
    for (const item of items) required.push(`room:${room}:${item}`)
  }
  for (const item of LIVE_SURFACE_INVENTORY.dialogsAndConsequenceGates) required.push(`dialog:${item}`)
  for (const item of LIVE_SURFACE_INVENTORY.horizontalRails) required.push(`rail:${item}`)
  for (const item of LIVE_SURFACE_INVENTORY.verticalScrollSurfaces) required.push(`vertical:${item}`)
  return { required, visits: new Map() }
}

function coverPhone(ledger, key, evidence, status = "exercised") {
  assert.ok(ledger.required.includes(key), `phone coverage key is inventoried: ${key}`)
  const prior = ledger.visits.get(key) || []
  ledger.visits.set(key, [...prior, { status, evidence }])
}

async function touchDoubleTap(page, locator) {
  await locator.scrollIntoViewIfNeeded()
  const observation = await touchTargetObservation(locator)
  assert.ok(observation.point, `double-touch target has an unobscured point: ${JSON.stringify(observation)}`)
  const session = await page.context().newCDPSession(page)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [observation.point] })
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())))
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())))
  }
  await session.detach()
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  return observation
}

function phoneCoverageReceipt(ledger) {
  const visits = Object.fromEntries(ledger.required.map((key) => [key, ledger.visits.get(key) || []]))
  const missing = ledger.required.filter((key) => !ledger.visits.has(key))
  return { required: ledger.required, visits, missing }
}

async function waitForScrollSettled(locator, stableFrames = 4) {
  await locator.evaluate((node, requiredFrames) => new Promise((resolve) => {
    let priorLeft = node.scrollLeft
    let priorTop = node.scrollTop
    let stable = 0
    let frames = 0
    const observe = () => {
      frames += 1
      const nextLeft = node.scrollLeft
      const nextTop = node.scrollTop
      if (Math.abs(nextLeft - priorLeft) < 0.5 && Math.abs(nextTop - priorTop) < 0.5) stable += 1
      else stable = 0
      priorLeft = nextLeft
      priorTop = nextTop
      if (stable >= requiredFrames || frames >= 90) resolve()
      else requestAnimationFrame(observe)
    }
    requestAnimationFrame(observe)
  }), stableFrames)
}

async function touchSwipeWithRetry(page, locator, options = {}, maxAttempts = 2) {
  const attempts = []
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await waitForScrollSettled(locator)
    const receipt = await touchSwipe(page, locator, options)
    attempts.push({ attempt, ...receipt })
    if (receipt.moved) return { ...receipt, attempts }
  }
  return { ...attempts.at(-1), attempts }
}

async function touchHorizontalRail(page, rail, { start = rail, maxAttempts = 3 } = {}) {
  await waitForScrollSettled(rail)
  const position = await rail.evaluate((node) => ({ left: node.scrollLeft, maxLeft: node.scrollWidth - node.clientWidth }))
  const x = position.left >= position.maxLeft - 1 ? 220 : -220
  return touchSwipeWithRetry(page, start, { x, observe: rail }, maxAttempts)
}

async function touchTargetObservation(locator) {
  return locator.evaluate((node) => {
    const rect = node.getBoundingClientRect()
    const clipped = {
      left: Math.max(1, rect.left),
      right: Math.min(window.innerWidth - 1, rect.right),
      top: Math.max(1, rect.top),
      bottom: Math.min(window.innerHeight - 1, rect.bottom),
    }
    const candidates = []
    if (clipped.right - clipped.left > 20 && clipped.bottom - clipped.top > 20) {
      for (const yRatio of [0.25, 0.5, 0.75]) {
        for (const xRatio of [0.75, 0.5, 0.25]) {
          const point = {
            x: clipped.left + (clipped.right - clipped.left) * xRatio,
            y: clipped.top + (clipped.bottom - clipped.top) * yRatio,
          }
          const hit = document.elementFromPoint(point.x, point.y)
          candidates.push({
            point,
            contained: Boolean(hit && node.contains(hit)),
            hit: hit ? { tag: hit.tagName.toLowerCase(), ariaLabel: hit.getAttribute("aria-label"), role: hit.getAttribute("role"), className: typeof hit.className === "string" ? hit.className : "" } : null,
          })
        }
      }
    }
    return {
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      clipped,
      point: candidates.find((candidate) => candidate.contained)?.point ?? null,
      candidates,
    }
  })
}

async function touchSwipeUntilVisible(page, rail, target, maxSwipes = 8) {
  for (let attempt = 0; attempt <= maxSwipes; attempt += 1) {
    const observation = await touchTargetObservation(target)
    if (observation.point) return true
    if (attempt === maxSwipes) break
    const swipe = await touchSwipe(page, rail, { x: observation.rect.x < 1 ? 220 : -220 })
    if (!swipe.moved) break
  }
  return false
}

async function findVerticalScroller(page, containingText) {
  const handle = await page.evaluateHandle((text) => {
    const candidates = Array.from(document.querySelectorAll("*"))
      .filter((element) => {
        const style = getComputedStyle(element)
        return element.textContent?.includes(text) && /(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 8
      })
      .sort((a, b) => (a.clientWidth * a.clientHeight) - (b.clientWidth * b.clientHeight))
    if (candidates[0]) return candidates[0]
    const pageScroller = document.scrollingElement
    return pageScroller && pageScroller.scrollHeight > pageScroller.clientHeight + 8 ? pageScroller : null
  }, containingText)
  const element = handle.asElement()
  return element
}

async function exerciseVerticalSurface(page, anchor, label) {
  await anchor.waitFor({ state: "visible" })
  // Positioning the already-visible anchor is setup only. Playwright's action
  // stability wait can hang on continuously animated canvases; the proof below
  // still uses a real CDP touch swipe and observes the native scroller.
  await anchor.evaluate((node) => node.scrollIntoView({ block: "center", inline: "nearest" }))
  const handle = await anchor.evaluateHandle((node) => {
    const candidates = []
    let current = node
    while (current) {
      const style = getComputedStyle(current)
      if (/(auto|scroll)/.test(style.overflowY)) candidates.push(current)
      current = current.parentElement
    }
    const pageScroller = document.scrollingElement
    if (pageScroller && !candidates.includes(pageScroller)) candidates.push(pageScroller)
    return candidates.find((element) => element.scrollHeight > element.clientHeight + 8) || candidates[0] || node
  })
  const scroller = handle.asElement()
  assert.ok(scroller, `${label} has an observable vertical surface`)
  const before = await scroller.evaluate((node) => ({
    top: node.scrollTop,
    maxTop: node.scrollHeight - node.clientHeight,
    clientHeight: node.clientHeight,
    scrollHeight: node.scrollHeight,
    overflowY: getComputedStyle(node).overflowY,
  }))
  if (before.maxTop <= 8) return { outcome: "verified-no-overflow", before, after: before }
  await scroller.evaluate((node) => { node.scrollTop = 0 })
  const receipt = await touchSwipe(page, scroller, { x: 0, y: -260 })
  assert.equal(receipt.moved, true, `${label} moves under a real vertical touch swipe`)
  await waitForScrollSettled(scroller)
  return { outcome: "touch-scrolled", ...receipt }
}

async function touchToggleAndRestore(locator, label) {
  await locator.scrollIntoViewIfNeeded()
  const box = await locator.boundingBox()
  assert.ok(box && box.width >= 44 && box.height >= 44, `${label} has a 44x44 phone touch target; got ${JSON.stringify(box)}`)
  const before = await locator.getAttribute("aria-checked")
  assert.ok(before === "true" || before === "false", `${label} exposes its checked state`)
  await locator.tap()
  await locator.page().waitForFunction(({ node, before }) => node.getAttribute("aria-checked") !== before, { node: await locator.elementHandle(), before })
  const changed = await locator.getAttribute("aria-checked")
  await locator.tap()
  await locator.page().waitForFunction(({ node, before }) => node.getAttribute("aria-checked") === before, { node: await locator.elementHandle(), before })
  return { before, changed, restored: await locator.getAttribute("aria-checked") }
}

async function touchFieldAndRestore(locator, nextValue, label) {
  await locator.scrollIntoViewIfNeeded()
  const box = await locator.boundingBox()
  assert.ok(box && box.width >= 44 && box.height >= 44, `${label} has a 44x44 phone touch target; got ${JSON.stringify(box)}`)
  const before = await locator.inputValue()
  await locator.tap()
  await locator.fill(String(nextValue))
  assert.equal(await locator.inputValue(), String(nextValue), `${label} accepted a touched edit`)
  await locator.fill(before)
  assert.equal(await locator.inputValue(), before, `${label} restored its original value`)
  return { before, changed: String(nextValue), restored: before }
}

async function touchSelectAndRestore(locator, nextValue, label) {
  await locator.scrollIntoViewIfNeeded()
  const box = await locator.boundingBox()
  assert.ok(box && box.width >= 44 && box.height >= 44, `${label} has a 44x44 phone touch target; got ${JSON.stringify(box)}`)
  const before = await locator.inputValue()
  await locator.tap()
  await locator.selectOption(String(nextValue))
  assert.equal(await locator.inputValue(), String(nextValue), `${label} accepted a touched selection`)
  await locator.tap()
  await locator.selectOption(before)
  assert.equal(await locator.inputValue(), before, `${label} restored its original selection`)
  return { before, changed: String(nextValue), restored: before }
}

async function closeDialog(page, title) {
  const dialog = page.getByRole("dialog", { name: title })
  await dialog.getByRole("button", { name: "Close", exact: true }).last().click()
  await dialog.waitFor({ state: "detached" })
}

test("the prototype is one complete clickable and touch-scrollable application", { timeout: 900_000 }, async (t) => {
  const sourceBefore = sourceSnapshot()
  assert.equal(defaultSettings.v, 6, "the complete journey uses the current settings contract")
  assert.deepEqual(Object.keys(defaultSettings.llm.roster), ENGINE_ORDER, "Settings fixture preserves the exact permanent roster order")
  assert.deepEqual(defaultSettings.llm.roster.deepseek, { active: true, inChat: true }, "DeepSeek starts active and in normal team chat")
  assert.deepEqual(defaultSettings.agents.deepseek.limits, { perRunUsd: 1, perDayUsd: 5 }, "DeepSeek has nonzero protected per-run and daily limits")
  assert.deepEqual(Object.keys(createMockState().cc.engines), ENGINE_ORDER, "Command Center fixture preserves the exact permanent roster order")
  assert.deepEqual(profiles().agents.map(({ id }) => id), ENGINE_ORDER, "profile fixture preserves the exact permanent roster order")
  assert.deepEqual(Object.keys(multiLoopFixtures().engines), ENGINE_ORDER, "Multi-Loop fixture preserves the exact permanent roster order")
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true })
  fs.writeFileSync(path.join(ARTIFACT_DIR, "live-surface-inventory.json"), `${JSON.stringify(LIVE_SURFACE_INVENTORY, null, 2)}\n`)

  const selectedViewport = String(process.env.AGENTHOST_E2E_VIEWPORT || "").trim().toLowerCase()
  const suppliedBaseUrl = String(process.env.AGENTHOST_E2E_BASE_URL || "").trim().replace(/\/+$/, "")
  const generatedDashboard = await startGeneratedDashboardServer()
  const localNext = suppliedBaseUrl || selectedViewport === "sandbox" ? null : await startEphemeralNext()
  const baseUrl = suppliedBaseUrl || localNext?.baseUrl || generatedDashboard.baseUrl
  const sandboxBaseUrl = generatedDashboard.baseUrl
  const next = localNext?.processState || null
  let browserHandle = null
  let browser = null
  const phoneCoverage = createPhoneCoverageLedger()
  const proof = {
    baseUrl,
    sourceRoot: ROOT,
    terminalScope: "mocked iframe only; final ttyd authentication, token/WebSocket, and AgentGlass proxy require a separate live-box suite",
    separateRequiredSuites: ["live ttyd token/WebSocket and AgentGlass proxy", "shell-owned PWA manifest, service worker, and push entry", "gate-owned /audit, /2fa, and retired /hermes route contracts after final dashboard export"],
    desktop: null,
    phone: null,
    phoneActionPhases: null,
    brandDnaFromUrl: null,
    phoneInteractionCoverage: null,
    brainMissingMemoryDeepLink: null,
    pushEnrollment: null,
    stalePushKeyReplacement: null,
    buyerBrand: { dev: null, legal: null },
    sourceIntegrity: { before: sourceBefore, after: null, unchanged: null },
    localNextStartup: localNext
      ? { portSource: localNext.portSource, baseUrl: localNext.baseUrl }
      : suppliedBaseUrl
        ? { suppliedBaseUrl: true }
        : { generatedDashboardBaseUrl: generatedDashboard.baseUrl },
  }
  const assistOnly = process.env.AGENTHOST_E2E_ASSIST_ONLY === "1"
  const routeOwnerBaseUrl = String(process.env.AGENTHOST_E2E_GATE_BASE_URL || "").trim().replace(/\/$/, "")

  t.after(async () => {
    const results = await Promise.allSettled([
      closeBrowser(browserHandle),
      next ? closeNext(next.child) : Promise.resolve(),
      generatedDashboard.close(),
    ])
    const sourceAfter = sourceSnapshot()
    proof.sourceIntegrity.after = sourceAfter
    proof.sourceIntegrity.unchanged = sourceBefore.digest === sourceAfter.digest
    fs.writeFileSync(path.join(ARTIFACT_DIR, "proof-summary.json"), `${JSON.stringify(proof, null, 2)}\n`)
    const cleanupFailures = results.filter((result) => result.status === "rejected").map((result) => result.reason)
    if (cleanupFailures.length) throw new AggregateError(cleanupFailures, "the E2E browser or dashboard process did not cleanly exit")
    assert.deepEqual(sourceAfter, sourceBefore, "production source hash is byte-identical before and after the browser/server journey")
  })

  if (!next) {
    const response = await fetch(baseUrl)
    assert.ok(response.ok, `the supplied prototype URL responds (${response.status})`)
  }
  browserHandle = await launchBrowser()
  browser = browserHandle.browser

  await t.test("desktop 1440x900 reaches every room, working destination, and consequence gate", { timeout: 180_000, skip: selectedViewport.startsWith("phone") || selectedViewport === "sandbox" }, async () => {
    const state = createMockState()
    state.settings.settings.llm.roster.deepseek.active = false
    const phases = ["desktop context starting"]
    proof.desktop = { viewport: LIVE_SURFACE_INVENTORY.viewports.desktop, phases }
    const context = await browser.newContext({ viewport: LIVE_SURFACE_INVENTORY.viewports.desktop, reducedMotion: "reduce" })
    await context.route(`${baseUrl}/artifacts/view?*`, (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Interactive relationship graph</title><main>Interactive relationship graph fixture</main>" }))
    // Simulate the two attributes Grammarly injected in the reported mismatch.
    await context.addInitScript(() => {
      const inject = () => {
        if (!document.body) return
        document.body.setAttribute("data-new-gr-c-s-check-loaded", "14.1318.0")
        document.body.setAttribute("data-gr-ext-installed", "")
      }
      new MutationObserver(inject).observe(document, { childList: true, subtree: true })
      inject()
    })
    const page = await context.newPage()
    page.setDefaultTimeout(10_000)
    await installMockApi(page, baseUrl, state)
    const diagnostics = startDiagnostics(page, "desktop")
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true })

    const routeFindings = []
    phases.push("root navigation starting")
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" })
    await neutralizeDevToolbar(page)
    await primaryNav(page).waitFor({ state: "visible", timeout: 60_000 })
    await page.getByText(taskObjective.title).first().waitFor({ state: "visible", timeout: 30_000 })
    assert.equal(await page.locator("body").getAttribute("data-brand"), null, "the Dev shell does not carry a buyer-brand override")
    assert.match(await page.title(), /^AgentHost Workspace \| Your governed agent team$/)
    await page.getByText("AgentHost", { exact: true }).first().waitFor({ state: "visible" })
    proof.buyerBrand.dev = {
      bodyBrand: null,
      title: await page.title(),
      visibleBrand: "AgentHost",
      searchLabel: "Search AgentHost",
    }
    phases.push("root shell and objective visible")
    for (const room of LIVE_SURFACE_INVENTORY.rooms.dev) {
      assert.equal(await primaryNav(page).getByRole("button", { name: new RegExp(`^${room}(?:\\s|$)`, "i") }).count(), 1, `Dev primary navigation exposes ${room}`)
    }
    assert.equal(await primaryNav(page).getByRole("button", { name: /^Growth(?:\s|$)/i }).count(), 0, "Dev primary navigation hides Growth")
    await screenshot(page, "desktop-01-overview.png")

    // Global controls and non-destructive shell dialogs.
    await page.keyboard.press("Control+k")
    const search = page.getByRole("dialog", { name: "Search AgentHost" })
    await search.waitFor({ state: "visible" })
    await search.getByPlaceholder("Board, artifacts, memory, mesh...").fill("brain")
    await search.getByRole("button", { name: /Brain/i }).first().click()
    await page.getByRole("heading", { name: "Brain" }).waitFor({ state: "visible" })
    assert.deepEqual(await devOverlayText(page), [], "desktop has no Next error overlay after first hydrated navigation")

    await page.getByRole("button", { name: /Switch box\. Current box:/i }).click()
    await page.getByRole("dialog", { name: "Switch box" }).waitFor({ state: "visible" })
    await page.keyboard.press("Escape")
    await page.getByRole("button", { name: /View system health|system health/i }).first().click()
    await page.getByRole("dialog", { name: "System Health" }).waitFor({ state: "visible" })
    await page.keyboard.press("Escape")

    await page.getByRole("button", { name: "New task" }).click()
    const createTask = page.getByRole("dialog", { name: "Create task" })
    await createTask.getByPlaceholder(/Fix the mobile nav overlap/i).fill("Proof every live journey")
    await createTask.getByRole("button", { name: "Cancel" }).click()
    const discardDraft = page.getByRole("dialog", { name: "Discard this task draft?" })
    await discardDraft.getByRole("button", { name: "Keep editing" }).click()
    await createTask.getByRole("button", { name: "Cancel" }).click()
    await discardDraft.getByRole("button", { name: "Discard draft" }).click()

    // Work: all five Dev destinations and the real board/task controls.
    await tapRoom(page, "Work")
    const workRail = page.getByRole("region", { name: "Work sections" })
    for (const label of LIVE_SURFACE_INVENTORY.destinations.WorkDev) {
      assert.equal(await workRail.getByRole("button", { name: new RegExp(`^${label}(?:\\s|$)`, "i") }).count(), 1, `Dev Work exposes ${label}`)
    }
    await keyboardScrollRail(page, "Board status lanes")
    await page.getByRole("button", { name: /Objective: Make the complete Workspace reachable/i }).click()
    const taskDialog = page.getByRole("dialog", { name: taskObjective.title })
    await taskDialog.getByRole("button", { name: "Archive" }).click()
    assert.equal(state.counts.get("POST /board/task/t_objective/review") || 0, 0, "opening Archive does not mutate the board")
    await taskDialog.getByText("Archive this task?").waitFor({ state: "visible" })
    await taskDialog.getByRole("button", { name: "Cancel" }).click()
    assert.equal(state.counts.get("POST /board/task/t_objective/review") || 0, 0, "cancelling task archive sends no board mutation")
    await taskDialog.getByRole("button", { name: "Archive" }).click()
    await taskDialog.getByRole("button", { name: "Archive task" }).click()
    assert.equal(state.counts.get("POST /board/task/t_objective/review"), 1, "confirming task archive sends exactly one board mutation")

    await page.getByRole("button", { name: /Objective: Make the complete Workspace reachable/i }).click()
    const blockableTask = page.getByRole("dialog", { name: taskObjective.title })
    await blockableTask.getByRole("button", { name: "Block", exact: true }).click()
    await blockableTask.getByText("Block this task?", { exact: true }).waitFor({ state: "visible" })
    await blockableTask.getByRole("button", { name: "Cancel", exact: true }).click()
    assert.equal(state.counts.get("POST /board/task/t_objective/freeze") || 0, 0, "cancelling task block sends no board mutation")
    await blockableTask.getByRole("button", { name: "Block", exact: true }).click()
    await blockableTask.getByRole("button", { name: "Confirm block" }).click()
    assert.equal(state.counts.get("POST /board/task/t_objective/freeze"), 1, "confirming task block sends exactly one board mutation")
    assert.deepEqual(state.boardFreezeBodies.at(-1), { pathname: "/board/task/t_objective/freeze", body: {} })

    await page.getByRole("button", { name: /Keep the whole team attached to the result/i }).click()
    const resumableTask = page.getByRole("dialog", { name: taskDone.title })
    await resumableTask.getByRole("button", { name: "Resume" }).click()
    await resumableTask.getByText("Resume this task?").waitFor({ state: "visible" })
    await resumableTask.getByRole("button", { name: "Cancel" }).click()
    assert.equal(state.counts.get("POST /board/task/t_done/unfreeze") || 0, 0, "cancelling task resume sends no board mutation")
    await resumableTask.getByRole("button", { name: "Resume" }).click()
    await resumableTask.getByRole("button", { name: "Confirm resume" }).click()
    assert.equal(state.counts.get("POST /board/task/t_done/unfreeze"), 1, "confirming task resume sends exactly one board mutation")

    const openDesktopReviewTask = async () => {
      await page.getByRole("button", { name: /Verify phone touch and scroll/i }).click()
      const dialog = page.getByRole("dialog", { name: taskReview.title })
      await dialog.waitFor({ state: "visible" })
      return dialog
    }
    let desktopReviewTask = await openDesktopReviewTask()
    let desktopReviewWrites = state.counts.get("POST /board/task/t_review/review") || 0
    await desktopReviewTask.getByRole("button", { name: "Approve", exact: true }).click()
    assert.match(await desktopReviewTask.innerText(), /dispatch.*spend.*review/is)
    await desktopReviewTask.getByRole("button", { name: "Cancel", exact: true }).click()
    assert.equal(state.counts.get("POST /board/task/t_review/review") || 0, desktopReviewWrites)
    await desktopReviewTask.getByRole("button", { name: "Approve", exact: true }).click()
    await desktopReviewTask.getByRole("button", { name: "Confirm approval" }).click()
    assert.equal(state.counts.get("POST /board/task/t_review/review"), desktopReviewWrites + 1)
    assert.deepEqual(state.boardReviewBodies.at(-1), { pathname: "/board/task/t_review/review", body: { action: "approve" } })

    desktopReviewTask = await openDesktopReviewTask()
    desktopReviewWrites = state.counts.get("POST /board/task/t_review/review") || 0
    await desktopReviewTask.getByRole("button", { name: "Send back", exact: true }).click()
    await desktopReviewTask.getByPlaceholder("Why is this going back?").fill("Desktop review found a concrete regression.")
    await desktopReviewTask.getByRole("button", { name: "Cancel", exact: true }).click()
    assert.equal(state.counts.get("POST /board/task/t_review/review"), desktopReviewWrites)
    await desktopReviewTask.getByRole("button", { name: "Send back", exact: true }).click()
    await desktopReviewTask.getByPlaceholder("Why is this going back?").fill("Desktop review found a concrete regression.")
    await desktopReviewTask.getByRole("button", { name: "Confirm send back" }).click()
    assert.equal(state.counts.get("POST /board/task/t_review/review"), desktopReviewWrites + 1)
    assert.deepEqual(state.boardReviewBodies.at(-1), { pathname: "/board/task/t_review/review", body: { action: "reject", note: "Desktop review found a concrete regression." } })

    desktopReviewTask = await openDesktopReviewTask()
    desktopReviewWrites = state.counts.get("POST /board/task/t_review/review") || 0
    await desktopReviewTask.getByRole("button", { name: "Reassign", exact: true }).click()
    await desktopReviewTask.getByRole("button", { name: "Codex", exact: true }).click()
    await desktopReviewTask.getByRole("button", { name: "Cancel", exact: true }).click()
    assert.equal(state.counts.get("POST /board/task/t_review/review"), desktopReviewWrites)
    await desktopReviewTask.getByRole("button", { name: "Codex", exact: true }).click()
    await desktopReviewTask.getByRole("button", { name: "Confirm reassign" }).click()
    assert.equal(state.counts.get("POST /board/task/t_review/review"), desktopReviewWrites + 1)
    assert.deepEqual(state.boardReviewBodies.at(-1), { pathname: "/board/task/t_review/review", body: { action: "reassign", engine: "codex" } })

    await page.getByRole("button", { name: "Lanes" }).click()
    const desktopAgentLanes = page.getByRole("region", { name: "Board agent swimlanes" })
    await desktopAgentLanes.waitFor({ state: "visible" })
    if (await desktopAgentLanes.evaluate((node) => node.scrollWidth > node.clientWidth + 1)) {
      await keyboardScrollRail(page, "Board agent swimlanes")
    }
    await page.getByRole("button", { name: "Status" }).click()

    await clickSection(page, "Work sections", "Files")
    await page.getByText("handoff.md").click()
    assert.equal(await page.getByRole("link", { name: "Open" }).getAttribute("href"), "/files/dl?p=team%2Fhandoff.md")
    assert.equal(await page.getByRole("link", { name: "Download" }).getAttribute("href"), "/files/dl?p=team%2Fhandoff.md")
    await page.getByRole("button", { name: "Refresh files" }).click()
    const selectDesktopUpload = async () => {
      const [fileChooser] = await Promise.all([
        page.waitForEvent("filechooser"),
        page.getByRole("button", { name: "Upload" }).click(),
      ])
      await fileChooser.setFiles({ name: "browser-proof.txt", mimeType: "text/plain", buffer: Buffer.from("complete journey proof") })
      await page.getByText("Upload browser-proof.txt to the team inbox?", { exact: true }).waitFor({ state: "visible" })
    }
    await selectDesktopUpload()
    assert.equal(state.counts.get("POST /files/upload") || 0, 0, "desktop file selection only stages the write")
    await page.getByRole("button", { name: "Cancel", exact: true }).click()
    assert.equal(state.counts.get("POST /files/upload") || 0, 0, "desktop upload Cancel sends no request")
    await selectDesktopUpload()
    await Promise.all([
      page.waitForResponse((browserResponse) => new URL(browserResponse.url()).pathname === "/files/upload"),
      page.getByRole("button", { name: "Confirm upload" }).click(),
    ])
    assert.equal(state.counts.get("POST /files/upload"), 1, "desktop reviewed Upload sends exactly one selected file to the team inbox")
    assert.deepEqual(state.lastFileUpload, { filename: "browser-proof.txt", bytes: Buffer.byteLength("complete journey proof") })

    await clickSection(page, "Work sections", "Artifacts")
    await page.getByText("Complete Journey Proof").waitFor({ state: "visible" })
    assert.match(await page.getByRole("link", { name: "Open Complete Journey Proof" }).getAttribute("href"), /^\/artifacts\/view\?p=/)
    assert.match(await page.getByRole("link", { name: "Download Complete Journey Proof" }).getAttribute("href"), /^\/artifacts\/dl\?p=/)
    await page.locator('[data-work-tab="artifacts"]').getByRole("button", { name: "Refresh" }).click()
    await page.getByLabel("Graphify target").selectOption("repo:owner/repo")
    assert.equal(await page.getByLabel("Folder to graph").inputValue(), "repo_dashboard")
    await Promise.all([
      page.waitForResponse((browserResponse) => browserResponse.request().method() === "POST"
        && new URL(browserResponse.url()).pathname === "/api/graphify"
        && browserResponse.status() === 200),
      page.getByRole("button", { name: "Generate graph", exact: true }).click(),
    ])
    assert.equal(state.graphifyBodies.length, 1)
    assert.deepEqual(
      { targetId: state.graphifyBodies[0].targetId, folderId: state.graphifyBodies[0].folderId },
      { targetId: "repo:owner/repo", folderId: "repo_dashboard" },
    )
    assert.match(state.graphifyBodies[0].operationId, /^[a-f0-9]{32}$/)
    await page.getByText(/Last successful graph.*owner\/repo.*Dashboard/s).waitFor({ state: "visible" })
    const desktopGraph = page.getByRole("link", { name: "Open interactive graph", exact: true })
    assert.match(await desktopGraph.getAttribute("href"), /^\/artifacts\/view\?p=graphify-repo-/)
    assert.equal(await desktopGraph.getAttribute("target"), null, "Graphify opens inside the current Workspace instead of a popup")
    assert.match(await page.getByRole("link", { name: "Open report", exact: true }).getAttribute("href"), /^\/artifacts\/view\?p=graphify-repo-/)

    const brandRequestStart = state.requests.length
    await page.getByLabel("Graphify target").selectOption("brand:acme")
    assert.equal(await page.getByLabel("Folder to graph").inputValue(), "brand_all")
    await Promise.all([
      page.waitForResponse((browserResponse) => browserResponse.request().method() === "DELETE"
        && new URL(browserResponse.url()).pathname === "/api/graphify/operation"
        && browserResponse.status() === 200),
      page.getByRole("button", { name: "Generate graph", exact: true }).click(),
    ])
    assert.deepEqual(
      state.requests.slice(brandRequestStart)
        .filter(({ pathname }) => pathname.startsWith("/api/graphify"))
        .map(({ method, pathname }) => `${method} ${pathname}`),
      ["POST /api/graphify/operation", "POST /api/graphify", "DELETE /api/graphify/operation"],
      "Brand Graphify reserves, generates, then acknowledges in that exact order",
    )
    assert.deepEqual(state.graphifyOperationBodies, [{ targetId: "brand:acme", folderId: "brand_all" }])
    assert.deepEqual(state.graphifyAckBodies, [{
      targetId: "brand:acme",
      folderId: "brand_all",
      operationId: state.graphifyBodies[1].operationId,
    }])
    assert.match(state.graphifyBodies[1].operationId, /^[a-f0-9]{32}$/)
    assert.equal(state.graphifyOperationLeases.size, 0, "a confirmed Brand graph clears its server lease")
    await page.getByText(/Last successful graph.*Acme \(acme\).*Brand DNA/s).waitFor({ state: "visible" })

    await clickSection(page, "Work sections", "Terminal")
    const terminal = page.getByTitle("AgentHost terminal")
    await terminal.waitFor({ state: "visible" })
    assert.equal(await terminal.getAttribute("src"), "/terminal/", "Terminal stays nested inside the Workspace")
    const desktopTerminalSwitchesBefore = state.counts.get("POST /switch") || 0
    const desktopDeepSeekSwitch = page.waitForResponse((response) => response.request().method() === "POST"
      && new URL(response.url()).pathname === "/switch"
      && new URL(response.url()).searchParams.get("window") === "deepseek"
      && response.status() === 200)
    await page.getByLabel("Terminal session").selectOption("deepseek")
    await desktopDeepSeekSwitch
    assert.equal(state.counts.get("POST /switch"), desktopTerminalSwitchesBefore + 1, "explicit DeepSeek selection called the same-origin switch route exactly once")
    assert.equal(state.requests.at(-1)?.search, "?window=deepseek", "desktop terminal switch identifies the exact DeepSeek window")

    await clickSection(page, "Work sections", "Reviews")
    await page.getByRole("button", { name: /Verify phone touch and scroll/i }).click()
    await page.getByRole("dialog", { name: taskReview.title }).getByRole("button", { name: "Close", exact: true }).last().click()
    await screenshot(page, "desktop-02-work.png")
    phases.push("Work complete")

    // Dev Agents: selection and the availability consequence gate.
    await tapRoom(page, "Agents")
    await page.getByText("Development agents", { exact: true }).first().waitFor({ state: "visible" })
    const desktopAgentOrder = await page.locator('aside').filter({ hasText: "Configured roster" }).getByRole("button").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")?.split(",")[0]).filter(Boolean))
    assert.deepEqual(desktopAgentOrder, ENGINE_ORDER.map((id) => ENGINE_LABELS[id]), "the observed Command Center and profile data render in the exact permanent roster order")
    await page.locator('button[aria-label^="DeepSeek,"]:visible').click()
    const deepseekActive = page.getByRole("switch", { name: "Available for work" })
    await deepseekActive.click()
    const enableDeepSeek = page.getByRole("dialog", { name: "Enable DeepSeek for work?" })
    assert.match(await enableDeepSeek.innerText(), /eligible queued work.*model spend may resume/is)
    await enableDeepSeek.getByRole("button", { name: "Cancel" }).click()
    assert.equal(state.counts.get("PUT /api/settings") || 0, 0, "cancelling DeepSeek enable sends no settings write")
    await deepseekActive.click()
    await enableDeepSeek.getByRole("button", { name: /Confirm availability/i }).click()
    assert.equal(state.counts.get("PUT /api/settings"), 1, "confirming DeepSeek availability sends one settings write")

    await page.locator('button[aria-label^="Cursor,"]:visible').click()
    await page.getByText("Cursor is chat-only and human-directed. It never receives unattended board work.", { exact: true }).waitFor({ state: "visible" })
    assert.equal(await page.getByRole("switch", { name: "Available for work" }).count(), 0, "Cursor exposes no unattended availability toggle")
    assert.equal(await page.getByRole("dialog", { name: "Enable Cursor for work?" }).count(), 0, "Cursor exposes no unattended availability dialog")

    const cursorChat = page.getByRole("switch", { name: "In team chat" })
    await cursorChat.click()
    const removeCursorChat = page.getByRole("dialog", { name: "Remove Cursor from team chat?" })
    await removeCursorChat.getByRole("button", { name: "Cancel" }).click()
    assert.equal(state.counts.get("PUT /api/settings"), 1, "cancelling team-chat removal sends no settings write")
    await cursorChat.click()
    await removeCursorChat.getByRole("button", { name: "Confirm remove from chat" }).click()
    assert.equal(state.counts.get("PUT /api/settings"), 2, "confirming team-chat removal sends exactly one settings write")
    await cursorChat.click()
    const enableCursorChat = page.getByRole("dialog", { name: "Add Cursor to team chat?" })
    await enableCursorChat.getByRole("button", { name: "Cancel" }).click()
    assert.equal(state.counts.get("PUT /api/settings"), 2, "cancelling team-chat enable sends no settings write")
    await cursorChat.click()
    await enableCursorChat.getByRole("button", { name: "Confirm team chat" }).click()
    assert.equal(state.counts.get("PUT /api/settings"), 3, "confirming team-chat enable restores Cursor with exactly one settings write")

    await page.locator('button[aria-label^="Kimi,"]:visible').click()
    const kimiMoonshot = page.getByRole("switch", { name: "Moonshot route enabled" })
    await kimiMoonshot.click()
    const enableMoonshot = page.getByRole("dialog", { name: "Enable the Moonshot route for Kimi?" })
    await enableMoonshot.getByRole("button", { name: "Cancel" }).click()
    assert.equal(state.counts.get("PUT /api/settings"), 3, "cancelling Moonshot enable sends no settings write and incurs no provider cost")
    await kimiMoonshot.click()
    await enableMoonshot.getByRole("button", { name: "Confirm Moonshot" }).click()
    assert.equal(state.counts.get("PUT /api/settings"), 4, "confirming Moonshot enable sends exactly one settings write")

    // Brain: map, lobe/lane/card detail, and new-memory modal.
    await tapRoom(page, "Brain")
    const desktopMap = page.getByLabel(/Interactive memory map/i)
    await desktopMap.waitFor({ state: "visible" })
    await page.getByLabel("Memory relationship legend").waitFor({ state: "visible" })
    assert.match(await page.getByRole("list", { name: "Memory relationships" }).innerText(), /references.*EXTRACTED confidence/i,
      "desktop Brain exposes the live Graphify relationship in an accessible surface")

    // Steve, 2026-08-14: "the brain is not visual the way that graphify is
    // visual." The legend above proves the canvas can PAINT the relationships;
    // this proves the operator can REGENERATE them from the same room and see
    // the result -- the two halves of that complaint. The brain-graph read
    // must increase (a stale canvas after a rebuild is the exact failure) and
    // the Artifacts read must not (Brain owns this corpus, it should not have
    // to leave to map it).
    const brainArtifactReads = state.counts.get("GET /artifacts") || 0
    const brainGraphReads = state.counts.get("GET /brain/api/graph") || 0
    await page.getByLabel("Graphify target").selectOption("vault:operator-brain")
    assert.equal(await page.getByLabel("Folder to graph").inputValue(), "vault_all")
    await Promise.all([
      page.waitForResponse((browserResponse) => browserResponse.request().method() === "GET"
        && new URL(browserResponse.url()).pathname === "/brain/api/graph"),
      page.getByRole("button", { name: "Generate graph", exact: true }).click(),
    ])
    assert.ok((state.counts.get("GET /brain/api/graph") || 0) > brainGraphReads,
      "generating from Brain repaints the canvas instead of leaving the operator on a stale graph")
    await page.getByText(/Last successful graph.*Operator Brain vault.*Entire registered vault/s).waitFor({ state: "visible" })
    assert.equal(state.counts.get("GET /artifacts") || 0, brainArtifactReads,
      "mapping the vault from Brain must not require the Artifacts room to load")
    const desktopMapBox = await desktopMap.boundingBox()
    assert.ok(desktopMapBox, "desktop memory map has a clickable box")
    await desktopMap.click({ position: { x: desktopMapBox.width / 2, y: desktopMapBox.height / 2 } })
    await page.waitForURL((url) => url.searchParams.get("view") === "brain/memory" && url.searchParams.get("lane") === "core")
    const laneShortcuts = page.locator('[aria-label="Memory map lane shortcuts"]')
    assert.deepEqual((await laneShortcuts.getByRole("button").allTextContents()).map((label) => label.trim()), ["Shared", ...ENGINE_ORDER.map((id) => ENGINE_LABELS[id])], "desktop Brain shortcuts preserve the exact seven-engine order")
    await laneShortcuts.getByRole("button", { name: "DeepSeek", exact: true }).click()
    await page.getByRole("region", { name: "Browse DeepSeek's lobe memories" }).waitFor({ state: "visible" })
    await laneShortcuts.getByRole("button", { name: "Shared", exact: true }).click()
    await page.getByRole("region", { name: "Browse Shared Core memories" }).getByRole("button").first().click()
    const memoryDialog = page.getByRole("dialog")
    await memoryDialog.getByRole("button", { name: "Close memory detail" }).click()
    await page.getByRole("button", { name: "New memory" }).click()
    const desktopNewMemory = page.getByRole("dialog", { name: "New memory" })
    await desktopNewMemory.waitFor({ state: "visible" })
    const chooseDesktopMemoryFile = async () => {
      const [chooser] = await Promise.all([
        page.waitForEvent("filechooser"),
        desktopNewMemory.getByLabel("or add a file", { exact: true }).click(),
      ])
      await chooser.setFiles({ name: "desktop-memory.md", mimeType: "text/markdown", buffer: Buffer.from("# Desktop memory proof") })
      await desktopNewMemory.getByRole("heading", { name: "Review file memory" }).waitFor({ state: "visible" })
    }
    await chooseDesktopMemoryFile()
    assert.equal(state.counts.get("POST /brain/api/ingest") || 0, 0, "desktop file selection stages without ingesting")
    await desktopNewMemory.getByRole("button", { name: "Cancel", exact: true }).click()
    assert.equal(state.counts.get("POST /brain/api/ingest") || 0, 0, "desktop file-ingest Cancel sends no request")
    await chooseDesktopMemoryFile()
    await Promise.all([
      page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/brain/api/ingest"),
      desktopNewMemory.getByRole("button", { name: "Confirm file" }).click(),
    ])
    assert.equal(state.counts.get("POST /brain/api/ingest"), 1, "desktop reviewed file-ingest Confirm sends exactly one request")
    await desktopNewMemory.waitFor({ state: "detached" })
    await screenshot(page, "desktop-03-brain.png")
    phases.push("Brain complete")

    // Systems: all four destinations and each consequence boundary.
    await tapRoom(page, "Systems")
    const systemsRail = page.getByRole("region", { name: "Systems sections" })
    for (const label of LIVE_SURFACE_INVENTORY.destinations.Systems) {
      assert.equal(await systemsRail.getByRole("button", { name: new RegExp(`^${label}(?:\\s|$)`, "i") }).count(), 1, `Systems exposes ${label}`)
    }
    const meshDraft = page.getByPlaceholder("What should the connected team know?")
    await meshDraft.fill("The complete journey has browser proof.")
    await page.getByRole("button", { name: /Review publish/i }).click()
    const meshGate = page.getByRole("dialog", { name: "Publish to the mesh team?" })
    await meshGate.getByRole("button", { name: "Cancel" }).click()
    assert.equal(state.counts.get("POST /cc/mesh/message") || 0, 0, "cancelling mesh publish sends no outward message")
    await page.getByRole("button", { name: /Review publish/i }).click()
    await meshGate.getByRole("button", { name: /Publish to mesh/i }).click()
    assert.equal(state.counts.get("POST /cc/mesh/message"), 1, "confirming mesh publish sends exactly one outward message")

    await clickSection(page, "Systems sections", "Operations")
    await page.getByRole("button", { name: /Pause New/i }).click()
    assert.equal(state.counts.get("POST /autonomy"), 1, "pausing autonomy is an explicit one-request control")
    await page.getByRole("button", { name: /Refresh/i }).click()
    await page.getByRole("button", { name: /Resume/i }).click()
    const resumeGate = page.getByRole("alertdialog", { name: "Resume autonomy?" })
    await resumeGate.getByRole("button", { name: "Cancel" }).click()
    assert.equal(state.counts.get("POST /autonomy"), 1, "cancelling resume does not add a request")
    await page.getByRole("button", { name: /Resume/i }).click()
    await resumeGate.getByRole("button", { name: /Confirm resume/i }).click()
    assert.equal(state.counts.get("POST /autonomy"), 2, "confirming resume sends exactly one additional request")

    await clickSection(page, "Systems sections", "Activity")
    await page.getByText("frontend_journey_verified", { exact: true }).waitFor({ state: "visible" })
    await page.getByText("Every event names its observed cause and stays attached to the durable record.", { exact: true }).waitFor({ state: "visible" })
    const auditReadsBeforeRefresh = state.counts.get("GET /audit/data") || 0
    await Promise.all([
      page.waitForResponse((browserResponse) => new URL(browserResponse.url()).pathname === "/audit/data"),
      page.getByRole("button", { name: "Refresh activity" }).click(),
    ])
    assert.equal(state.counts.get("GET /audit/data"), auditReadsBeforeRefresh + 1, "Activity refresh performs one new bounded audit read")

    await clickSection(page, "Systems sections", "Inventory")
    await page.getByPlaceholder(/Search skills, plugins, MCPs, and tools/i).fill("browser")
    await page.getByText("browser-proof").waitFor({ state: "visible" })
    await page.getByRole("button", { name: /Copy/i }).first().click()

    // Steve, 2026-08-14: "it's just a small spot in the artifacts. Doesn't
    // really belong there." The room that OWNS a corpus must be able to map it
    // without a trip to Artifacts, so the claim being proven here is a
    // NEGATIVE one: driving the builder from Inventory costs zero /artifacts
    // reads. A snapshot-and-compare is the only way to see that -- an assertion
    // that the panel merely renders would pass even if the operator still had
    // to leave the room to use it.
    const inventoryArtifactReads = state.counts.get("GET /artifacts") || 0
    const inventoryGraphsBefore = state.graphifyBodies.length
    await page.getByLabel("Graphify target").selectOption("harness")
    assert.equal(await page.getByLabel("Folder to graph").inputValue(), "h_all")
    await Promise.all([
      page.waitForResponse((browserResponse) => browserResponse.request().method() === "POST"
        && new URL(browserResponse.url()).pathname === "/api/graphify"
        && browserResponse.status() === 200),
      page.getByRole("button", { name: "Generate graph", exact: true }).click(),
    ])
    assert.equal(state.graphifyBodies.length, inventoryGraphsBefore + 1, "Inventory's own builder submits exactly one graph")
    assert.deepEqual(
      { targetId: state.graphifyBodies.at(-1).targetId, folderId: state.graphifyBodies.at(-1).folderId },
      { targetId: "harness", folderId: "h_all" },
      "Inventory graphs the harness corpus it actually owns",
    )
    await page.getByText(/Last successful graph.*Agent harness.*All approved harness files/s).waitFor({ state: "visible" })
    assert.match(
      await page.getByRole("link", { name: "Open interactive graph", exact: true }).getAttribute("href"),
      /^\/artifacts\/view\?p=graphify-/,
      "the finished map is reachable from Inventory itself",
    )
    assert.equal(state.counts.get("GET /artifacts") || 0, inventoryArtifactReads,
      "mapping the harness from Inventory must not require the Artifacts room to load")

    await clickSection(page, "Systems sections", "Loops")
    await page.getByRole("region", { name: "Multi-Loop starters" }).waitFor({ state: "visible" })
    const desktopMultiReadiness = page.getByLabel("Multi-Loop engine readiness")
    const desktopMultiOrder = (await desktopMultiReadiness.locator(":scope > span").allTextContents()).map((label) => label.split("·")[0].trim())
    assert.deepEqual(desktopMultiOrder.map((label) => label.toLowerCase()), ENGINE_ORDER, "Multi-Loop readiness preserves the exact permanent roster order")
    assert.match(await desktopMultiReadiness.innerText(), /Cursor.*chat-only and human-directed.*never receives unattended work/is, "Multi-Loop names why Cursor is unavailable")
    const loopDeleteButton = page.getByRole("button", { name: "Delete loop Morning Box Brief" })
    const loopDeleteRow = loopDeleteButton.locator("..")
    await loopDeleteButton.click()
    const loopDeleteWarning = loopDeleteRow.getByText(/schedule, any queued run, and its run history/i)
    await loopDeleteWarning.waitFor({ state: "visible" })
    assert.match(await loopDeleteRow.innerText(), /schedule, any queued run, and its run history/i, "the Loop delete control names the schedule, queued run, and run-history consequence")
    await loopDeleteRow.getByRole("button", { name: "Keep", exact: true }).click()
    assert.equal(state.counts.get("DELETE /cron/jobs/loop_daily") || 0, 0, "keeping a Loop after its delete warning sends no delete")
    await loopDeleteButton.click()
    await loopDeleteWarning.waitFor({ state: "visible" })
    state.deleteDelayMs.set("/cron/jobs/loop_daily", 7500)
    const loopDeleteRequest = page.waitForRequest((request) => request.method() === "DELETE" && new URL(request.url()).pathname === "/cron/jobs/loop_daily")
    const loopDeleteResponse = page.waitForResponse((browserResponse) => browserResponse.request().method() === "DELETE" && new URL(browserResponse.url()).pathname === "/cron/jobs/loop_daily")
    const loopConfirmDelete = loopDeleteRow.getByRole("button", { name: "Delete", exact: true })
    await loopConfirmDelete.evaluate((button) => { button.click(); button.click() })
    await loopDeleteRequest
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())))
    assert.equal(state.counts.get("DELETE /cron/jobs/loop_daily"), 1, "a rapid double-confirm sends exactly one Loop delete")
    const loopDeleting = loopDeleteRow.getByRole("button", { name: /Deleting/i })
    await loopDeleting.waitFor({ state: "visible" })
    assert.equal(await loopDeleting.isDisabled(), true, "the pending Loop confirm is disabled")
    const loopKeepPending = loopDeleteRow.getByRole("button", { name: "Keep", exact: true })
    assert.equal(await loopKeepPending.isDisabled(), true, "the pending Loop warning cannot be dismissed")
    assert.equal(await loopDeleteButton.isDisabled(), true, "the outer Loop delete control is locked while deletion is pending")
    await loopKeepPending.evaluate((button) => button.click())
    assert.equal(await loopDeleteWarning.isVisible(), true, "a programmatic pending dismiss cannot hide the Loop consequence")
    await loopDeleteResponse
    state.deleteDelayMs.delete("/cron/jobs/loop_daily")
    await loopDeleteWarning.waitFor({ state: "detached" })
    assert.equal(state.counts.get("DELETE /cron/jobs/loop_daily"), 1, "the completed Loop delete remains exactly one request")

    await page.getByRole("button", { name: /Morning Box Brief/i }).last().click()
    const prompt = page.getByPlaceholder("what should the agent do?")
    await prompt.waitFor({ state: "visible" })
    await page.getByRole("button", { name: "add loop" }).click()
    const loopGate = page.getByRole("dialog", { name: "Schedule this Loop?" })
    await loopGate.getByRole("button", { name: "Cancel" }).click()
    assert.equal(state.counts.get("POST /cron/jobs") || 0, 0, "cancelling Loop schedule creates no recurring job")
    await page.getByRole("button", { name: "add loop" }).click()
    await loopGate.getByRole("button", { name: "Confirm schedule" }).click()
    assert.equal(state.counts.get("POST /cron/jobs"), 1, "confirming Loop schedule creates one recurring job")

    const loopApprovalKey = `POST /cron/runs/${encodeURIComponent(LOOP_APPROVAL_RUN_ID)}/approve`
    await page.getByRole("button", { name: "Approve once" }).first().click()
    const loopApprovalGate = page.getByRole("dialog", { name: "Approve this Loop run once?" })
    await loopApprovalGate.getByRole("button", { name: "Cancel" }).click()
    assert.equal(state.counts.get(loopApprovalKey) || 0, 0, "cancelling one-Loop approval sends no approval grant")
    await page.getByRole("button", { name: "Approve once" }).first().click()
    await loopApprovalGate.getByRole("button", { name: "Approve once" }).click()
    assert.equal(state.counts.get(loopApprovalKey), 1, "confirming one-Loop approval sends exactly one approval grant")
    assert.deepEqual(state.lastLoopApprovalBody, { decision: "approve_once", fingerprint: LOOP_APPROVAL_FINGERPRINT }, "one-Loop approval is bound to the exact gate fingerprint")
    await page.getByText(/Approval recorded.*waiting for the gateway/i).waitFor({ state: "visible" })

    const multiStarter = page.getByRole("region", { name: "Multi-Loop starters" }).getByRole("button").first()
    const multiJobCard = page.locator("article").filter({ has: page.getByRole("heading", { name: "Release team", exact: true }) })
    const multiDelete = multiJobCard.getByRole("button", { name: "Delete", exact: true })
    await multiDelete.click()
    const multiDeleteWarning = multiJobCard.getByRole("alert")
    await multiDeleteWarning.waitFor({ state: "visible" })
    assert.match(await multiDeleteWarning.innerText(), /schedule, any queued run, and its run-history directory/i, "the Multi-Loop warning names the schedule, queued run, and run-history consequence")
    await multiJobCard.getByRole("button", { name: "Keep it" }).click()
    assert.equal(state.counts.get("DELETE /cron/multi/jobs/multi_release") || 0, 0, "keeping a Multi-Loop after its delete warning sends no delete")
    await multiDelete.click()
    await multiDeleteWarning.waitFor({ state: "visible" })
    state.deleteDelayMs.set("/cron/multi/jobs/multi_release", 7500)
    const multiDeleteRequest = page.waitForRequest((request) => request.method() === "DELETE" && new URL(request.url()).pathname === "/cron/multi/jobs/multi_release")
    const multiDeleteResponse = page.waitForResponse((browserResponse) => browserResponse.request().method() === "DELETE" && new URL(browserResponse.url()).pathname === "/cron/multi/jobs/multi_release")
    const multiConfirmDelete = multiJobCard.getByRole("button", { name: "Confirm delete" })
    await multiConfirmDelete.evaluate((button) => { button.click(); button.click() })
    await multiDeleteRequest
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())))
    assert.equal(state.counts.get("DELETE /cron/multi/jobs/multi_release"), 1, "a rapid double-confirm sends exactly one Multi-Loop delete")
    const multiDeleting = multiJobCard.getByRole("button", { name: /Deleting/i })
    await multiDeleting.waitFor({ state: "visible" })
    assert.equal(await multiDeleting.isDisabled(), true, "the pending Multi-Loop confirm is disabled")
    const multiKeepPending = multiJobCard.getByRole("button", { name: "Keep it" })
    assert.equal(await multiKeepPending.isDisabled(), true, "the pending Multi-Loop warning cannot be dismissed")
    await multiKeepPending.evaluate((button) => button.click())
    assert.equal(await multiDeleteWarning.isVisible(), true, "a programmatic pending dismiss cannot hide the Multi-Loop consequence")
    await multiDeleteResponse
    state.deleteDelayMs.delete("/cron/multi/jobs/multi_release")
    await multiDeleteWarning.waitFor({ state: "detached" })
    assert.equal(state.counts.get("DELETE /cron/multi/jobs/multi_release"), 1, "the completed Multi-Loop delete remains exactly one request")

    await multiStarter.click()
    await page.getByRole("button", { name: "Schedule multi-loop" }).click()
    const multiGate = page.getByRole("dialog", { name: "Schedule this Multi-Loop?" })
    await multiGate.getByRole("button", { name: "Cancel" }).click()
    assert.equal(state.counts.get("POST /cron/multi/jobs") || 0, 0, "cancelling Multi-Loop schedule creates no recurring team")
    await page.getByRole("button", { name: "Schedule multi-loop" }).click()
    await multiGate.getByRole("button", { name: "Confirm schedule" }).click()
    assert.equal(state.counts.get("POST /cron/multi/jobs"), 1, "confirming Multi-Loop schedule creates one recurring team")
    await screenshot(page, "desktop-04-systems-loops.png")
    phases.push("Systems complete")

    // Settings: all legacy + new sections, paid test gate, and consequence save.
    await page.getByRole("button", { name: "Open settings and mode" }).click()
    const settingsDialog = page.getByRole("dialog", { name: "Settings" })
    const settingsRail = settingsDialog.getByRole("region", { name: "Settings sections" })
    for (const section of ["Mode", "LLM Roster", "Box Services", "Channels", "Cost & Budget", "Schedule", "Board", "Git Ladder", "Security", "Agent Reporting", "About"]) {
      const sectionButton = settingsRail.getByRole("button", { name: new RegExp(`^${section}(?:\\s|$)`, "i") })
      assert.equal(await sectionButton.count(), 1, `Settings exposes ${section}`)
      await sectionButton.click()
      await settingsDialog.getByRole("heading", { name: section, exact: true }).waitFor({ state: "visible" })
    }

    await settingsRail.getByRole("button", { name: /^LLM Roster/i }).click()
    const desktopSettingsOrder = await settingsDialog.getByRole("switch").evaluateAll((switches, engineLabels) => {
      const allowed = new Set(engineLabels)
      return [...new Set(switches.map((control) => String(control.getAttribute("aria-label") || "").replace(/ (?:active|in chat)$/i, "")).filter((label) => allowed.has(label)))]
    }, ENGINE_ORDER.map((id) => ENGINE_LABELS[id]))
    assert.deepEqual(desktopSettingsOrder, ENGINE_ORDER.map((id) => ENGINE_LABELS[id]), "Settings renders the exact permanent roster order")
    assert.equal(await settingsDialog.getByRole("switch", { name: "Cursor active", exact: true }).count(), 0, "Settings exposes no Cursor unattended-work toggle")
    await settingsDialog.getByLabel("Cursor unattended work unavailable").waitFor({ state: "visible" })
    const deepseekSettings = settingsDialog.locator("section").filter({ hasText: "DeepSeek profile" }).first()
    assert.equal(await deepseekSettings.getByLabel(/^Per-run limit\s*\$$/).inputValue(), "1")
    assert.equal(await deepseekSettings.getByLabel(/^Daily limit\s*\$$/).inputValue(), "5")
    assert.equal(await deepseekSettings.getByLabel(/^Per-run limit\s*\$$/).getAttribute("min"), "0.01", "DeepSeek's per-run cap cannot be removed through the UI")
    assert.equal(await deepseekSettings.getByLabel(/^Daily limit\s*\$$/).getAttribute("min"), "0.01", "DeepSeek's daily cap cannot be removed through the UI")
    await settingsDialog.getByText("Kimi profile", { exact: true }).waitFor({ state: "visible" })

    await settingsRail.getByRole("button", { name: /^Cost & Budget/i }).click()
    await settingsDialog.getByRole("switch", { name: "Cost limits" }).click()
    await settingsDialog.getByRole("button", { name: "Close", exact: true }).last().click()
    const discardSettings = page.getByRole("dialog", { name: "Discard unsaved settings changes?" })
    await discardSettings.getByRole("button", { name: "Keep editing" }).click()
    assert.equal(await settingsDialog.isVisible(), true, "keeping an unsaved settings draft leaves Settings open")
    await settingsDialog.getByRole("button", { name: "Close", exact: true }).last().click()
    await discardSettings.getByRole("button", { name: "Discard changes" }).click()
    await settingsDialog.waitFor({ state: "detached" })
    await page.getByRole("button", { name: "Open settings and mode" }).click()

    await settingsRail.getByRole("button", { name: /^Cost & Budget/i }).click()
    await settingsDialog.getByRole("button", { name: "Use defaults" }).click()
    const defaultsGate = page.getByRole("dialog", { name: "Use defaults for Cost & Budget?" })
    await defaultsGate.getByRole("button", { name: "Cancel" }).click()
    assert.equal(state.counts.get("POST /api/settings/reset") || 0, 0, "cancelling use-defaults sends no reset")
    await settingsDialog.getByRole("button", { name: "Use defaults" }).click()
    await defaultsGate.getByRole("button", { name: "Confirm defaults" }).click()
    assert.equal(state.counts.get("POST /api/settings/reset"), 1, "confirming use-defaults sends exactly one reset")

    await settingsRail.getByRole("button", { name: /^Security/i }).click()
    await settingsDialog.getByRole("heading", { name: "Two-factor authentication" }).waitFor({ state: "visible" })
    assert.ok((state.counts.get("GET /2fa/status") || 0) >= 1, "Security reads live 2FA state from the native panel")
    await settingsDialog.getByLabel("Confirm box access key").fill("box-access-proof")
    await settingsDialog.getByRole("button", { name: "Start 2FA enrollment" }).click()
    assert.equal(state.counts.get("POST /2fa/enroll"), 1, "starting enrollment is one explicit request")
    assert.deepEqual(state.lastTwoFactorEnrollBody, { key: "box-access-proof" }, "2FA enrollment re-enters the exact box access key")
    assert.equal(await settingsDialog.getByLabel("Authenticator secret").innerText(), "JBSWY3DPEHPK3PXP", "enrollment exposes the authenticator secret")
    assert.match(await settingsDialog.getByLabel("Authenticator otpauth URL").innerText(), /^otpauth:\/\/totp\/AgentHost:/, "enrollment exposes the otpauth URL")
    const activationCode = settingsDialog.getByLabel("Current 6-digit code")
    await activationCode.fill("123456")
    await activationCode.press("Enter")
    const activationGate = page.getByRole("dialog", { name: "Activate two-factor authentication?" })
    await activationGate.waitFor({ state: "visible" })
    assert.match(await activationGate.innerText(), /revokes every current box session.*Future logins require the box access key and a current authenticator code/is)
    await activationGate.getByRole("button", { name: "Cancel" }).click()
    assert.equal(state.counts.get("POST /2fa/confirm") || 0, 0, "cancelling 2FA activation revokes no sessions")
    await activationCode.press("Enter")
    await activationGate.getByRole("button", { name: "Confirm and activate" }).click()
    assert.equal(state.counts.get("POST /2fa/confirm"), 1, "confirming the reviewed activation sends exactly one request")
    assert.deepEqual(state.lastTwoFactorConfirmBody, { code: "123456" }, "2FA activation submits only the typed six-digit code")
    await settingsDialog.getByText("second factor on", { exact: true }).waitFor({ state: "visible" })

    const disableCode = settingsDialog.getByLabel("Current 6-digit code")
    await disableCode.fill("654321")
    await disableCode.press("Enter")
    const disableTwoFactorGate = page.getByRole("dialog", { name: "Turn off two-factor authentication?" })
    await disableTwoFactorGate.getByRole("button", { name: "Cancel" }).click()
    assert.equal(state.counts.get("POST /2fa/disable") || 0, 0, "cancelling 2FA disable sends no mutation")
    await disableCode.press("Enter")
    state.failNextTwoFactorDisable = true
    await disableTwoFactorGate.getByRole("button", { name: "Confirm and turn off" }).click()
    assert.equal(state.counts.get("POST /2fa/disable"), 1, "failed 2FA disable sends exactly one mutation request")
    assert.deepEqual(state.lastTwoFactorDisableBody, { code: "654321" }, "2FA disable is bound to the typed current code")
    await disableTwoFactorGate.getByRole("alert").waitFor({ state: "visible" })
    assert.match(await disableTwoFactorGate.getByRole("alert").innerText(), /was not turned off.*current authenticator code was rejected/i, "failed 2FA disable names the exact cause")
    assert.equal(await disableTwoFactorGate.isVisible(), true, "failed 2FA disable keeps its consequence dialog open")
    await disableTwoFactorGate.getByRole("button", { name: "Confirm and turn off" }).click()
    assert.equal(state.counts.get("POST /2fa/disable"), 2, "retrying confirmed 2FA disable sends exactly one successful request")
    await settingsDialog.getByText("second factor off", { exact: true }).waitFor({ state: "visible" })

    await settingsRail.getByRole("button", { name: /^Box Services/i }).click()
    await settingsDialog.getByRole("button", { name: "Test connection" }).click()
    const paidTest = page.getByRole("dialog", { name: "Run a paid Moonshot connection test?" })
    await paidTest.getByRole("button", { name: "Cancel" }).click()
    assert.equal(state.counts.get("POST /api/continuity/providers/moonshot/test") || 0, 0, "cancelling the paid provider test incurs no request")
    await settingsDialog.getByRole("button", { name: "Test connection" }).click()
    await paidTest.getByRole("button", { name: "Confirm and run test" }).click()
    assert.equal(state.counts.get("POST /api/continuity/providers/moonshot/test"), 1, "confirming the paid provider test sends exactly one request")
    await settingsRail.getByRole("button", { name: /^Cost & Budget/i }).click()
    await settingsDialog.getByRole("switch", { name: "Cost limits" }).click()
    const settingsWritesBeforeSave = state.counts.get("PUT /api/settings") || 0
    await settingsDialog.getByRole("button", { name: "Save settings" }).click()
    const settingsGate = page.getByRole("dialog", { name: "Review consequential settings changes" })
    await settingsGate.getByRole("button", { name: "Cancel" }).click()
    assert.equal(state.counts.get("PUT /api/settings"), settingsWritesBeforeSave, "cancelling consequence save adds no settings write beyond agent controls")
    await settingsDialog.getByRole("button", { name: "Save settings" }).click()
    state.failNextSettingsSave = true
    await settingsGate.getByRole("button", { name: "Confirm and save" }).click()
    assert.equal(state.counts.get("PUT /api/settings"), settingsWritesBeforeSave + 1, "a rejected consequence save makes exactly one settings request")
    await settingsGate.getByRole("alert").waitFor({ state: "visible" })
    assert.match(await settingsGate.getByRole("alert").innerText(), /Settings were not saved.*box rejected this settings change/i, "the open consequence dialog names the failed save cause")
    assert.equal(await settingsGate.isVisible(), true, "the settings consequence dialog stays open after a failed save")
    await settingsGate.getByRole("button", { name: "Confirm and save" }).click()
    assert.equal(state.counts.get("PUT /api/settings"), settingsWritesBeforeSave + 2, "retrying the confirmed consequence save adds exactly one successful settings write")
    await settingsDialog.getByText("All settings saved").waitFor({ state: "visible" })
    await closeDialog(page, "Settings")

    // Mode consequence: Cancel preserves Dev, confirm makes Growth the actual IA.
    await page.getByRole("button", { name: "Growth", exact: true }).click()
    const modeGate = page.getByRole("dialog", { name: "Switch to Growth Mode?" })
    await modeGate.getByRole("button", { name: "Cancel" }).click()
    assert.equal(state.counts.get("POST /api/mode") || 0, 0, "cancelling mode switch sends no restart request")
    await page.getByRole("button", { name: "Growth", exact: true }).click()
    await modeGate.getByRole("button", { name: "Confirm and restart" }).click()
    assert.equal(state.counts.get("POST /api/mode"), 1, "confirming mode switch sends one restart request")
    assert.equal(state.mode, "growth", "the mode endpoint recorded Growth as the requested box mode")
    await primaryNav(page).getByRole("button", { name: /^Accounts(?:\s|$)/i }).waitFor({ state: "visible", timeout: 100_000 })
    await page.getByRole("button", { name: /Explore Growth Mode/i }).click()

    for (const [groupLabel, destinations] of Object.entries(LIVE_SURFACE_INVENTORY.destinations.Growth)) {
      const group = primaryNav(page).locator(`[aria-label="${groupLabel}"]`)
      await group.waitFor({ state: "visible" })
      for (const { label } of destinations) {
        assert.equal(await group.getByRole("button", { name: new RegExp(`^${label}(?:\\s|$)`, "i") }).count(), 1, `Growth ${groupLabel} navigation exposes ${label}`)
      }
    }
    assert.equal(await primaryNav(page).getByRole("button", { name: /^Agents(?:\s|$)/i }).count(), 0, "Growth presents Crew instead of reparenting the Agents room")

    // Client work is actionable, not just reachable. Campaigns explains its
    // missing dependency, then renders the exact measured row after a connection
    // exists. Creative decisions wait for the real endpoint, including a Codex
    // revision task. Secrets submits by keyboard and returns names only.
    await primaryNav(page).getByRole("button", { name: /^Campaigns(?:\s|$)/i }).click()
    await page.getByText("Campaigns need a connected ad account.", { exact: true }).waitFor({ state: "visible" })
    await page.getByRole("button", { name: "Open Attribution" }).click()
    await page.waitForFunction(() => new URL(window.location.href).searchParams.get("view") === "growth/attribution")
    await page.getByText("measurement is not configured on this box", { exact: true }).waitFor({ state: "visible" })
    await page.getByText("Measurement setup is not available in this dashboard. Existing recorded connections remain visible below so their health and stored facts can still be managed.", { exact: true }).waitFor({ state: "visible" })
    assert.equal(await page.locator('input[type="password"]').count(), 0, "desktop Attribution exposes no Pipedream credential field")
    assert.equal(await page.getByRole("button", { name: "Connect an ad account", exact: true }).count(), 0, "desktop Attribution exposes no connect wizard")
    state.measurementConnected = true
    await primaryNav(page).getByRole("button", { name: /^Campaigns(?:\s|$)/i }).click()
    await page.getByText("Agency launch", { exact: true }).waitFor({ state: "visible" })
    await page.getByText("$25.00", { exact: true }).waitFor({ state: "visible" })
    await page.getByText("4.00x", { exact: true }).waitFor({ state: "visible" })

    await primaryNav(page).getByRole("button", { name: /^Attribution(?:\s|$)/i }).click()
    await page.getByRole("button", { name: "Refresh", exact: true }).last().click()
    await page.getByText("Review Pipedream-backed connection health and manage the measurement facts stored on this box.", { exact: true }).waitFor({ state: "visible" })
    await page.getByText("Ad-platform credentials are held by Pipedream Connect and are not stored on this box. Measurement data is stored here, in your own cloud.", { exact: true }).waitFor({ state: "visible" })
    await page.getByText("act_1001", { exact: true }).waitFor({ state: "visible" })
    const desktopDisconnect = page.getByRole("button", { name: "Disconnect", exact: true })
    const desktopDisconnectBox = await desktopDisconnect.boundingBox()
    assert.ok(desktopDisconnectBox && desktopDisconnectBox.height >= 44, `desktop Disconnect is at least 44px tall; got ${JSON.stringify(desktopDisconnectBox)}`)
    await desktopDisconnect.click()
    await page.getByText(/does not revoke OAuth access/i).waitFor({ state: "visible" })
    assert.equal(state.counts.get(`DELETE /measurement/connections/${MEASUREMENT_CONNECTION_ID}`), 1, "desktop disconnect sends one exact-connection request")
    assert.equal(state.measurementConnections[0].enabled, false, "the exact connection is disabled before the response returns")

    const desktopDeleteStoredFacts = page.getByRole("button", { name: "Delete stored facts", exact: true })
    const desktopDeleteBox = await desktopDeleteStoredFacts.boundingBox()
    assert.ok(desktopDeleteBox && desktopDeleteBox.height >= 44, `desktop stored-facts control is at least 44px tall; got ${JSON.stringify(desktopDeleteBox)}`)
    await desktopDeleteStoredFacts.click()
    const desktopDeleteGate = page.getByRole("dialog", { name: "Delete stored measurement facts?", exact: true })
    await desktopDeleteGate.getByText(/2 stored measurement facts.*permanently deleted/i).waitFor({ state: "visible" })
    assert.equal(state.counts.get(`GET /measurement/connections/${MEASUREMENT_CONNECTION_ID}/facts`), 1, "desktop previews the exact stored-fact count once")
    await desktopDeleteGate.getByRole("button", { name: "Delete 2 stored facts", exact: true }).click()
    await page.getByText("Deleted 2 stored measurement facts.", { exact: true }).waitFor({ state: "visible" })
    assert.equal(state.counts.get(`DELETE /measurement/connections/${MEASUREMENT_CONNECTION_ID}/facts`), 1, "desktop confirms one exact-connection fact deletion")
    assert.equal(state.measurementFacts.length, 0, "the confirmed desktop action removes the two exact facts")
    await screenshot(page, "desktop-measurement-delete.png")

    await primaryNav(page).getByRole("button", { name: /^Creative(?:\s|$)/i }).click()
    const approveCard = page.locator("article").filter({ has: page.getByText("Approve Journey Proof", { exact: true }) })
    const secondApproveCard = page.locator("article").filter({ has: page.getByText("Second Approve Journey Proof", { exact: true }) })
    const rejectCard = page.locator("article").filter({ has: page.getByText("Reject Journey Proof", { exact: true }) })
    const adjustCard = page.locator("article").filter({ has: page.getByText("Adjust Journey Proof", { exact: true }) })
    await approveCard.waitFor({ state: "visible" })
    await approveCard.getByRole("button", { name: "Approve", exact: true }).click()
    await approveCard.waitFor({ state: "detached" })
    const filingStatus = page.getByRole("status")
    await filingStatus.filter({ hasText: "Approved and filed. Approve Journey Proof (approve-journey.html)" }).waitFor({ state: "visible" })
    assert.equal(await filingStatus.evaluate((node) => node === document.activeElement), true)
    await secondApproveCard.getByRole("button", { name: "Approve", exact: true }).click()
    await secondApproveCard.waitFor({ state: "detached" })
    await filingStatus.filter({ hasText: "Approved and filed. Second Approve Journey Proof (approve-journey-2.html)" }).waitFor({ state: "visible" })
    assert.equal(await filingStatus.evaluate((node) => node === document.activeElement), true)
    await rejectCard.getByRole("button", { name: "Reject", exact: true }).click()
    await rejectCard.waitFor({ state: "detached" })
    await page.getByRole("status").filter({ hasText: "Rejected and filed." }).waitFor({ state: "visible" })
    await adjustCard.getByRole("button", { name: "Request adjustments", exact: true }).click()
    const feedback = page.getByLabel("Adjustments requested for Adjust Journey Proof")
    await feedback.fill("Make the proof point specific to agency owners.")
    await feedback.press("Control+Enter")
    await adjustCard.waitFor({ state: "detached" })
    await page.getByRole("status").filter({ hasText: /Adjustments requested and filed.*creative_revision_1.*assigned to Codex/ }).waitFor({ state: "visible" })
    assert.deepEqual(state.artifactReviewBodies.map(({ action }) => action), ["approve", "approve", "reject", "request-adjustments"])
    assert.equal(state.artifactReviewBodies[3].feedback, "Make the proof point specific to agency owners.")
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText("All creative work is filed.", { exact: true }).waitFor({ state: "visible" })
    await page.getByText("Reviewed work remains in Work → Artifacts.", { exact: true }).waitFor({ state: "visible" })

    await primaryNav(page).getByRole("button", { name: /^Secrets(?:\s|$)/i }).click()
    await page.getByLabel("Secret variable name").fill("browser_proof_token")
    await page.getByLabel("Secret value").fill("never-render-this-canary")
    await page.getByLabel("Secret value").press("Enter")
    await page.getByText(/BROWSER_PROOF_TOKEN is set.*value was cleared/i).waitFor({ state: "visible" })
    assert.deepEqual(state.secretBodies, [{ name: "BROWSER_PROOF_TOKEN", value: "never-render-this-canary" }])
    assert.equal(await page.getByText("never-render-this-canary", { exact: true }).count(), 0, "stored values never render")

    await page.getByRole("button", { name: "Search AgentHost" }).click()
    const growthSearch = page.getByRole("dialog", { name: "Search AgentHost" })
    await growthSearch.getByPlaceholder("Board, artifacts, memory, mesh...").fill("Goals & OKRs")
    await growthSearch.getByRole("button", { name: /^Goals & OKRs(?:\s|$)/i }).click()
    await page.getByRole("button", { name: "Open objective board card t_objective" }).click()
    await page.getByRole("dialog", { name: taskObjective.title }).getByRole("button", { name: "Close", exact: true }).last().click()
    await page.getByRole("button", { name: "Open linked board card t_review" }).click()
    await page.getByRole("dialog", { name: taskReview.title }).getByRole("button", { name: "Close", exact: true }).last().click()
    await page.goto(`${baseUrl}/?view=growth/autonomy`, { waitUntil: "domcontentloaded", timeout: 60_000 })
    await neutralizeDevToolbar(page)
    await page.locator('[data-growth-tab="autonomy"]').waitFor({ state: "visible" })
    const growthAutonomyWritesBefore = state.counts.get("POST /autonomy") || 0
    const growthPauseResponse = page.waitForResponse((response) => response.request().method() === "POST"
      && new URL(response.url()).pathname === "/autonomy"
      && response.status() === 200)
    await page.getByRole("button", { name: "Pause New", exact: true }).click()
    await growthPauseResponse
    assert.equal(state.counts.get("POST /autonomy"), growthAutonomyWritesBefore + 1, "Growth Pause New sends exactly one autonomy request")
    const growthResume = page.getByRole("button", { name: "Resume", exact: true })
    await growthResume.waitFor({ state: "visible" })
    await growthResume.click()
    const growthResumeGate = page.getByRole("alertdialog", { name: "Resume autonomy?" })
    await growthResumeGate.getByRole("button", { name: "Cancel", exact: true }).click()
    assert.equal(state.counts.get("POST /autonomy"), growthAutonomyWritesBefore + 1, "cancelling Growth Resume sends no request")
    await growthResume.click()
    const growthResumeResponse = page.waitForResponse((response) => response.request().method() === "POST"
      && new URL(response.url()).pathname === "/autonomy"
      && response.status() === 200)
    await growthResumeGate.getByRole("button", { name: "Confirm resume", exact: true }).click()
    await growthResumeResponse
    assert.equal(state.counts.get("POST /autonomy"), growthAutonomyWritesBefore + 2, "confirming Growth Resume sends exactly one additional request")
    await page.getByRole("button", { name: "Pause New", exact: true }).waitFor({ state: "visible" })
    await page.getByRole("button", { name: "Open Loops and Multi-Loops" }).click()
    await page.getByRole("heading", { name: "Growth Loops" }).waitFor({ state: "visible" })
    await screenshot(page, "desktop-05-growth.png")
    phases.push("Settings and Growth complete")

    // Route ownership runs after the room journey so an invalid legacy door
    // cannot hide failures in the canonical shell itself.
    if (routeOwnerBaseUrl) {
    const retiredResponses = await Promise.all(LIVE_SURFACE_INVENTORY.routeOwnership.retiredWithCause.map(async (route) => ({
      route,
      direct: await context.request.get(`${routeOwnerBaseUrl}${route}`, { maxRedirects: 0 }),
    })))
    for (const { route, direct } of retiredResponses) {
      const body = await direct.text()
      phases.push(`${route} direct ${direct.status()}`)
      if (direct.status() !== 410) routeFindings.push({ route, cause: `retired route returned ${direct.status()} instead of 410` })
      if (direct.headers().location) routeFindings.push({ route, cause: `retired route redirects to ${direct.headers().location}` })
      if (!/hermes|retired|gone|no longer/i.test(body)) routeFindings.push({ route, cause: "retired route does not name why it is gone" })
    }

    for (const deepLink of LIVE_SURFACE_INVENTORY.routeOwnership.nativeShellDeepLinks) {
      const direct = await context.request.get(`${routeOwnerBaseUrl}${deepLink}`, { maxRedirects: 0 })
      phases.push(`${deepLink} direct ${direct.status()}`)
      if (direct.status() !== 200) {
        routeFindings.push({ route: deepLink, cause: `native shell deep link returned ${direct.status()} instead of 200` })
        continue
      }
      if (direct.headers().location) routeFindings.push({ route: deepLink, cause: `native shell deep link redirects to ${direct.headers().location}` })
      const routePage = await context.newPage()
      routePage.setDefaultTimeout(10_000)
      await installMockApi(routePage, routeOwnerBaseUrl, state)
      const routeDiagnostics = startDiagnostics(routePage, `desktop ${deepLink}`)
      await routePage.goto(`${routeOwnerBaseUrl}${deepLink}`, { waitUntil: "domcontentloaded" })
      await neutralizeDevToolbar(routePage)
      await primaryNav(routePage).waitFor({ state: "visible", timeout: 60_000 })
      if (deepLink === "/audit") {
        await routePage.getByRole("heading", { name: "Activity" }).waitFor({ state: "visible" })
        assert.equal(await routePage.getByRole("region", { name: "Systems sections" }).getByRole("button", { name: /^Activity/i }).getAttribute("aria-current"), "page", "/audit selects Systems > Activity in the same shell")
      } else {
        await routePage.getByRole("dialog", { name: "Settings" }).waitFor({ state: "visible" })
        await routePage.getByRole("heading", { name: "Two-factor authentication" }).waitFor({ state: "visible" })
      }
      await assertNoErrorOverlay(routePage, routeDiagnostics)
      await routePage.close()
      phases.push(`${deepLink} shell verified`)
    }
    } else {
      phases.push("gate-owned /audit, /2fa, and /hermes route proof deferred until the final dashboard export is rebuilt")
    }

    assert.equal(state.counts.get("GET /sw.js") || 0, 0, "the Next development journey never requests the production-owned worker")
    proof.desktop = { viewport: LIVE_SURFACE_INVENTORY.viewports.desktop, requests: Object.fromEntries(state.counts), diagnostics, routeFindings, phases }
    await context.tracing.stop({ path: path.join(ARTIFACT_DIR, "desktop-trace.zip") })
    await assertNoErrorOverlay(page, diagnostics)
    await context.close()
    if (routeOwnerBaseUrl) assert.deepEqual(routeFindings, [], "all gate-owned native and retired route contracts are reachable without redirects")
  })

  await t.test("Graphify opens inside the real popup-free opaque Command Center sandbox", { timeout: 90_000, skip: selectedViewport.startsWith("phone") }, async (sandboxJourney) => {
    const state = createMockState()
    const context = await browser.newContext({ viewport: LIVE_SURFACE_INVENTORY.viewports.desktop, reducedMotion: "reduce" })
    sandboxJourney.after(() => closeContext(context))
    const page = await context.newPage()
    page.setDefaultTimeout(20_000)
    await installMockApi(page, sandboxBaseUrl, state)
    const sandboxBlocks = []
    const sandboxConsole = []
    const sandboxPageErrors = []
    const sandboxRequestFailures = []
    const sandboxRequests = []
    const sandboxResponses = []
    page.on("console", (message) => {
      if (/Blocked opening .*allow-popups/i.test(message.text())) sandboxBlocks.push(message.text())
      if (message.type() === "error") sandboxConsole.push(message.text())
    })
    page.on("pageerror", (error) => sandboxPageErrors.push(error.message))
    page.on("request", (request) => sandboxRequests.push({ method: request.method(), url: request.url() }))
    page.on("response", (response) => sandboxResponses.push({ status: response.status(), url: response.url() }))
    page.on("requestfailed", (request) => sandboxRequestFailures.push({
      method: request.method(),
      url: request.url(),
      error: request.failure()?.errorText || "unknown request failure",
    }))
    await page.setContent(`<!doctype html><title>Command Center sandbox proof</title><iframe title="Box Console Workspace" sandbox="allow-scripts allow-forms allow-downloads" src="${sandboxBaseUrl}/" width="1200" height="800" style="width:1200px;height:800px;border:0"></iframe>`)
    const frameHandle = await page.locator('iframe[title="Box Console Workspace"]').elementHandle()
    assert.ok(frameHandle, "the Command Center sandbox iframe exists")
    const frame = await frameHandle.contentFrame()
    assert.ok(frame, "the Box Console loaded inside the Command Center sandbox")
    try {
      await primaryNav(frame).waitFor({ state: "visible", timeout: 10_000 })
      await tapRoom(frame, "Work")
      await clickSection(frame, "Work sections", "Artifacts")
      await frame.getByLabel("Graphify target").waitFor({ state: "visible", timeout: 10_000 })
    } catch (error) {
      const body = await frame.locator("body").innerText().catch(() => "<body unreadable>")
      const runtime = await frame.evaluate(() => ({
        readyState: document.readyState,
        visibilityState: document.visibilityState,
        scripts: Array.from(document.scripts).map((script) => ({ src: script.src, type: script.type })),
      })).catch(() => null)
      throw new Error(`the sandboxed Box Console did not reach Work > Artifacts; url=${frame.url()}; body=${body.slice(0, 500)}; runtime=${JSON.stringify(runtime)}; mockedRequests=${JSON.stringify(state.requests.slice(-20))}; browserRequests=${JSON.stringify(sandboxRequests.slice(-40))}; browserResponses=${JSON.stringify(sandboxResponses.slice(-40))}; console=${JSON.stringify(sandboxConsole.slice(-20))}; pageErrors=${JSON.stringify(sandboxPageErrors.slice(-20))}; requestFailures=${JSON.stringify(sandboxRequestFailures.slice(-20))}`, { cause: error })
    }
    assert.equal(await frame.evaluate(() => {
      try { return void window.localStorage.length }
      catch (error) { return error instanceof DOMException ? error.name : String(error) }
    }), "SecurityError", "the browser journey preserves the Command Center's opaque-origin sandbox")
    await frame.getByLabel("Graphify target").selectOption("repo:owner/repo")
    await Promise.all([
      page.waitForResponse((browserResponse) => browserResponse.request().method() === "POST"
        && new URL(browserResponse.url()).pathname === "/api/graphify"
        && browserResponse.status() === 200),
      frame.getByRole("button", { name: "Generate graph", exact: true }).click(),
    ])
    await frame.getByText(/Last successful graph.*owner\/repo.*Dashboard/s).waitFor({ state: "visible" })
    const graphLink = frame.getByRole("link", { name: "Open interactive graph", exact: true })
    assert.equal(await graphLink.getAttribute("target"), null)
    const pagesBefore = context.pages().length
    await graphLink.click()
    await frame.getByText("Interactive relationship graph fixture", { exact: true }).waitFor({ state: "visible" })
    assert.equal(new URL(frame.url()).pathname, "/artifacts/view")
    assert.equal(context.pages().length, pagesBefore, "Graphify stayed inside the existing Workspace frame")
    assert.deepEqual(sandboxBlocks, [], "the browser reported no popup-sandbox block")
  })

  if (selectedViewport === "sandbox") return

  await t.test("the Legal buyer shell and the Dev shell hydrate from one boot-fixed brand contract", { timeout: 90_000, skip: selectedViewport.startsWith("phone") }, async (brandJourney) => {
    const state = createMockState()
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-complete-legal-"))
    const gate = startLegalGate(home)
    let context = null
    brandJourney.after(async () => {
      const results = await Promise.allSettled([closeContext(context), closeLegalGate(gate.child)])
      fs.rmSync(home, { recursive: true, force: true })
      const failures = results.filter((result) => result.status === "rejected").map((result) => result.reason)
      if (failures.length) throw new AggregateError(failures, "the Legal browser context or disposable gate did not cleanly exit")
    })

    const legalBaseUrl = await waitForLegalGateOrigin(gate)
    context = await browser.newContext({ viewport: LIVE_SURFACE_INVENTORY.viewports.desktop, reducedMotion: "reduce" })
    await context.addCookies([await authenticatedCookie(legalBaseUrl)])
    const page = await context.newPage()
    page.setDefaultTimeout(30_000)
    await installMockApi(page, legalBaseUrl, state)
    const diagnostics = startDiagnostics(page, "real-gate Legal buyer-brand hydration")
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true })
    const observedMode = page.waitForResponse((response) => response.request().method() === "GET"
      && new URL(response.url()).pathname === "/api/mode"
      && response.status() === 200)
    const legalDocument = await page.goto(legalBaseUrl, { waitUntil: "domcontentloaded", timeout: 60_000 })
    assert.equal(legalDocument?.status(), 200, "the authenticated real gate serves the generated dashboard at the canonical root")
    const observedModeResponse = await observedMode
    await primaryNav(page).waitFor({ state: "visible", timeout: 60_000 })

    assert.equal(await page.locator("body").getAttribute("data-brand"), "legal", "the Legal response stamps the buyer brand before hydration")
    assert.equal(await page.title(), "Legal Skills HQ Workspace | Your governed agent team")
    await page.getByText("Legal Skills HQ", { exact: true }).first().waitFor({ state: "visible" })
    await page.getByRole("button", { name: "Dev", exact: true }).waitFor({ state: "visible" })
    assert.ok((state.counts.get("GET /api/mode") || 0) >= 1, "the generated client hydrated and observed the mocked box mode")

    proof.buyerBrand.legal = {
      baseUrl: legalBaseUrl,
      bodyBrand: "legal",
      title: await page.title(),
      visibleBrand: "Legal Skills HQ",
      visibleModeControl: "Dev",
      modeResponseStatus: observedModeResponse.status(),
      modeReads: state.counts.get("GET /api/mode"),
      authentication: "canonical POST /session returned the operator cookie",
      generatedArtifact: {
        path: GENERATED_DASHBOARD_INDEX,
        sha256: createHash("sha256").update(fs.readFileSync(GENERATED_DASHBOARD_INDEX)).digest("hex"),
      },
      diagnostics,
    }
    await screenshot(page, "desktop-legal-buyer-brand.png")
    await context.tracing.stop({ path: path.join(ARTIFACT_DIR, "desktop-legal-brand-trace.zip") })
    await assertNoErrorOverlay(page, diagnostics)
    await context.close()
  })

  await t.test("phone 390x844 uses touch for every room and both horizontal and vertical browsing", { timeout: 180_000, skip: selectedViewport === "desktop" || selectedViewport === "phone-action" || selectedViewport === "phone-brand-dna" }, async (phoneJourney) => {
    const state = createMockState()
    const productFindings = []
    const touchMetrics = {}
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, reducedMotion: "reduce" })
    phoneJourney.after(async () => { await closeContext(context) })
    await context.route(`${baseUrl}/artifacts/view?*`, (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Interactive relationship graph</title><main>Interactive relationship graph fixture</main>" }))
    await context.addInitScript(() => {
      const inject = () => {
        if (!document.body) return
        document.body.setAttribute("data-new-gr-c-s-check-loaded", "14.1318.0")
        document.body.setAttribute("data-gr-ext-installed", "")
      }
      new MutationObserver(inject).observe(document, { childList: true, subtree: true })
      inject()
    })
    const page = await context.newPage()
    page.setDefaultTimeout(30_000)
    await installMockApi(page, baseUrl, state)
    const diagnostics = startDiagnostics(page, "phone")
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true })
    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 60_000 })
    await neutralizeDevToolbar(page)
    await primaryNav(page).waitFor({ state: "visible", timeout: 60_000 })
    await page.getByText(taskObjective.title).first().waitFor({ state: "visible", timeout: 30_000 })

    const phoneRooms = await primaryNav(page).getByRole("button").allTextContents().then((items) => items.map((item) => item.trim()))
    assert.deepEqual(phoneRooms, LIVE_SURFACE_INVENTORY.rooms.dev)
    coverPhone(phoneCoverage, "global:primary navigation", { rooms: phoneRooms })
    await screenshot(page, "phone-01-overview.png")

    // The compact toolbar exposes its hidden actions through one touch sheet.
    await page.getByRole("button", { name: "More actions" }).tap()
    coverPhone(phoneCoverage, "global:phone more-actions sheet", "opened with touch")
    const moreActions = page.locator('section[aria-label="More actions"]')
    await moreActions.waitFor({ state: "visible" })
    await moreActions.getByRole("button", { name: "View system health" }).tap()
    const health = page.getByRole("dialog", { name: "System Health" })
    await health.waitFor({ state: "visible" })
    coverPhone(phoneCoverage, "global:system health", "opened with touch")
    coverPhone(phoneCoverage, "dialog:System Health", "opened with touch")
    await health.getByRole("button", { name: "Close", exact: true }).last().tap()
    await health.waitFor({ state: "detached" })
    coverPhone(phoneCoverage, "global:system health close", "44px Close touched and System Health detached")
    await page.getByRole("button", { name: "More actions" }).tap()
    await moreActions.waitFor({ state: "visible" })
    await moreActions.getByRole("button", { name: "Search AgentHost" }).tap()
    const search = page.getByRole("dialog", { name: "Search AgentHost" })
    await search.waitFor({ state: "visible" })
    coverPhone(phoneCoverage, "global:search", "opened with touch")
    coverPhone(phoneCoverage, "dialog:Search AgentHost", "opened with touch")
    const searchQuery = search.getByPlaceholder("Board, artifacts, memory, mesh...")
    await searchQuery.tap()
    await searchQuery.fill("brain")
    await search.getByRole("button", { name: /Memory.*Brain/i }).tap()
    await page.getByRole("heading", { name: "Brain" }).waitFor({ state: "visible" })
    coverPhone(phoneCoverage, "global:search query and result", "query touched and filled; Memory result touched; Brain opened in the same shell")
    await page.getByRole("button", { name: "More actions" }).tap()
    await moreActions.getByRole("button", { name: "Search AgentHost" }).tap()
    await search.waitFor({ state: "visible" })
    await search.getByRole("button", { name: "Close", exact: true }).last().tap()
    await search.waitFor({ state: "detached" })
    coverPhone(phoneCoverage, "global:search close", "44px Close touched and Search detached")
    await tapRoom(page, "Overview", true)
    const earlyOverlay = await devOverlayText(page)
    if (earlyOverlay.length) console.error(`phone Next overlay before room navigation: ${earlyOverlay.join(" | ")}`)
    assert.deepEqual(earlyOverlay, [], "phone has no Next error overlay after first hydrated interaction")

    // Touch every room. Work proves a swipeable top rail and real nested terminal.
    await tapRoom(page, "Work", true)
    const workRail = page.getByRole("region", { name: "Work sections" })
    const workSwipe = await touchSwipe(page, workRail)
    assert.ok(workSwipe.after.left > workSwipe.before.left, "phone Work sections move under a real touch swipe")
    coverPhone(phoneCoverage, "rail:Work sections", workSwipe)
    await workRail.evaluate((node) => { node.scrollLeft = 0 })
    for (const { label, tab } of [
      { label: "Board", tab: "board" },
      { label: "Files", tab: "files" },
      { label: "Artifacts", tab: "artifacts" },
      { label: "Reviews", tab: "reviews" },
    ]) {
      const target = workRail.getByRole("button", { name: new RegExp(`^${label}(?:\\s|$)`, "i") })
      if (!await touchSwipeUntilVisible(page, workRail, target)) {
        productFindings.push({ surface: `Work / ${label}`, cause: `Real horizontal touch swipes could not bring ${label} into the 390x844 viewport.` })
        continue
      }
      await target.tap()
      await page.locator(`[data-work-tab="${tab}"]`).waitFor({ state: "visible" })
      if (tab === "board") {
        const phoneBoardRail = page.getByRole("region", { name: "Board status lanes" })
        const boardRailSwipe = await touchHorizontalRail(page, phoneBoardRail)
        touchMetrics.boardStatusLanes = boardRailSwipe
        if (!boardRailSwipe.moved) productFindings.push({ surface: "Work / Board lanes", cause: "Board status lanes did not move under a real phone touch swipe.", observed: boardRailSwipe })
        else coverPhone(phoneCoverage, "rail:Board status lanes", boardRailSwipe)
        coverPhone(phoneCoverage, "room:Board:Status", "selected on phone")
        assert.equal(await page.getByRole("button", { name: "Lanes" }).count(), 0, "phone deliberately hides the desktop-only board lane switch")
        coverPhone(phoneCoverage, "room:Board:Lanes", "not exposed at 390px; desktop-only lane control", "not-exposed-on-phone")
        coverPhone(phoneCoverage, "rail:Board agent swimlanes", "not exposed at 390px with the desktop-only Lanes view", "not-exposed-on-phone")
        coverPhone(phoneCoverage, "room:Board:agent lane cards", "not exposed at 390px with the desktop-only Lanes view", "not-exposed-on-phone")
      }
      if (tab === "files") {
        const fileLocations = page.getByRole("region", { name: "File locations" })
        const fileMetrics = await fileLocations.evaluate((node) => ({ maxLeft: node.scrollWidth - node.clientWidth }))
        const fileLocationButtons = await fileLocations.getByRole("button").count()
        assert.ok(fileLocationButtons > 0, "phone Files exposes at least one real location control")
        if (fileMetrics.maxLeft > 0) {
          const fileLocationSwipe = await touchSwipe(page, fileLocations)
          touchMetrics.fileLocations = fileLocationSwipe
          if (!fileLocationSwipe.moved) productFindings.push({ surface: "Work / File locations", cause: "Overflowing File locations did not move under a real phone touch swipe.", observed: fileLocationSwipe })
          else coverPhone(phoneCoverage, "rail:File locations", fileLocationSwipe)
        } else coverPhone(phoneCoverage, "rail:File locations", { ...fileMetrics, controls: fileLocationButtons }, "verified-no-overflow")
      }
      if (tab === "artifacts") {
        await page.getByLabel("Graphify target").tap()
        await page.getByLabel("Graphify target").selectOption("repo:owner/repo")
        assert.equal(await page.getByLabel("Folder to graph").inputValue(), "repo_dashboard")
        const phoneGenerateGraph = page.getByRole("button", { name: "Generate graph", exact: true })
        const generateBox = await phoneGenerateGraph.boundingBox()
        assert.ok(generateBox && generateBox.height >= 44, `phone Generate graph keeps a 44px touch target; got ${JSON.stringify(generateBox)}`)
        await Promise.all([
          page.waitForResponse((browserResponse) => browserResponse.request().method() === "POST"
            && new URL(browserResponse.url()).pathname === "/api/graphify"
            && browserResponse.status() === 200),
          phoneGenerateGraph.tap(),
        ])
        assert.equal(state.graphifyBodies.length, 1)
        assert.match(state.graphifyBodies[0].operationId, /^[a-f0-9]{32}$/)
        await page.getByText(/Last successful graph.*owner\/repo.*Dashboard/s).waitFor({ state: "visible" })
        const phoneGraph = page.getByRole("link", { name: "Open interactive graph", exact: true })
        assert.ok((await phoneGraph.boundingBox())?.height >= 44, "phone Open interactive graph keeps a 44px touch target")
        assert.equal(await phoneGraph.getAttribute("target"), null, "phone Graphify opens in the current Workspace instead of a popup")
        assert.match(await page.getByRole("link", { name: "Open report", exact: true }).getAttribute("href"), /^\/artifacts\/view\?p=graphify-repo-/)
      }
    }
    const terminalTarget = workRail.getByRole("button", { name: /^Terminal(?:\s|$)/i })
    if (!await touchSwipeUntilVisible(page, workRail, terminalTarget)) {
      productFindings.push({ surface: "Work / Terminal", cause: "Real horizontal touch swipes could not bring Terminal into the 390x844 viewport." })
    } else {
      await terminalTarget.tap()
    }
    await page.locator('[data-work-tab="terminal"]').waitFor({ state: "visible" })
    const phoneTerminal = page.getByTitle("AgentHost terminal")
    await phoneTerminal.waitFor({ state: "attached" })
    if (!await phoneTerminal.isVisible()) {
      const box = await phoneTerminal.boundingBox().catch(() => null)
      productFindings.push({ surface: "Work / Terminal", cause: "The phone route changes to terminal, but the nested terminal iframe has no visible box at 390x844.", observed: box })
      await screenshot(page, "phone-finding-terminal-not-visible.png")
    }
    const phoneNavigationSwitchesBefore = state.counts.get("POST /switch") || 0
    const phoneNavigationDeepSeekSwitch = page.waitForResponse((response) => response.request().method() === "POST"
      && new URL(response.url()).pathname === "/switch"
      && new URL(response.url()).searchParams.get("window") === "deepseek"
      && response.status() === 200)
    await page.getByLabel("Terminal session").tap()
    await page.getByLabel("Terminal session").selectOption("deepseek")
    await phoneNavigationDeepSeekSwitch
    assert.equal(state.counts.get("POST /switch"), phoneNavigationSwitchesBefore + 1, "390px DeepSeek selection sends exactly one terminal switch request")
    assert.equal(state.requests.filter((request) => request.method === "POST" && request.pathname === "/switch").at(-1)?.search, "?window=deepseek")
    await screenshot(page, "phone-02-work-terminal.png")

    await tapRoom(page, "Agents", true)
    const agentRail = page.getByRole("region", { name: "Agent roster. Scroll horizontally or use the arrow keys." })
    const agentSwipe = await touchSwipe(page, agentRail)
    assert.ok(agentSwipe.after.left > agentSwipe.before.left, "phone agent roster moves under touch")
    coverPhone(phoneCoverage, "rail:Agent roster. Scroll horizontally or use the arrow keys.", agentSwipe)
    const phoneAgentOrder = await agentRail.getByRole("button").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")?.split(",")[0]).filter(Boolean))
    assert.deepEqual(phoneAgentOrder, ENGINE_ORDER.map((id) => ENGINE_LABELS[id]), "390px Command Center and profiles render in the exact permanent roster order")

    await tapRoom(page, "Brain", true)
    await page.getByLabel(/Interactive memory map/i).waitFor({ state: "visible" })
    await page.getByLabel("Memory relationship legend").waitFor({ state: "visible" })
    assert.match(await page.getByRole("list", { name: "Memory relationships" }).innerText(), /references.*EXTRACTED confidence/i,
      "390px Brain exposes the Graphify relationship without requiring the canvas alone")
    const mapLaneShortcuts = page.locator('[aria-label="Memory map lane shortcuts"]')
    const mapShortcutMetrics = await mapLaneShortcuts.evaluate((node) => ({ maxLeft: node.scrollWidth - node.clientWidth }))
    if (mapShortcutMetrics.maxLeft > 0) {
      const mapShortcutSwipe = await touchSwipe(page, mapLaneShortcuts)
      touchMetrics.memoryMapLaneShortcuts = mapShortcutSwipe
      if (!mapShortcutSwipe.moved) productFindings.push({ surface: "Brain / lobe shortcuts", cause: "Overflowing memory-map lane shortcuts did not move under a real phone touch swipe.", observed: mapShortcutSwipe })
      else coverPhone(phoneCoverage, "rail:Memory map lane shortcuts", mapShortcutSwipe)
    }
    const sharedLane = page.getByRole("region", { name: "Browse Shared Core memories" })
    const brainScroller = await findVerticalScroller(page, "Shared core")
    if (brainScroller) {
      const attempts = []
      let laneObservation = null
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await waitForScrollSettled(brainScroller)
        laneObservation = await touchTargetObservation(sharedLane)
        if (laneObservation.point) break
        const scrollerBox = await brainScroller.boundingBox()
        assert.ok(scrollerBox, "the Brain scroller remains visible while Shared Core is touch-positioned")
        const targetMiddle = laneObservation.rect.y + laneObservation.rect.height / 2
        const scrollerMiddle = scrollerBox.y + scrollerBox.height / 2
        const y = targetMiddle < scrollerMiddle ? 80 : -80
        const brainScroll = await touchSwipe(page, brainScroller, { x: 0, y })
        await waitForScrollSettled(brainScroller)
        const nextObservation = await touchTargetObservation(sharedLane)
        attempts.push({ observation: laneObservation, directionY: y, scroll: brainScroll, nextObservation })
        laneObservation = nextObservation
        if (laneObservation.point || !brainScroll.moved) break
      }
      touchMetrics.brainSharedLane = { attempts, finalObservation: laneObservation }
      if (!laneObservation.point) {
        productFindings.push({ surface: "Brain / Memory", cause: "Real vertical touch swipes could not bring Shared Core to an unobscured point at 390x844.", observed: touchMetrics.brainSharedLane })
        await screenshot(page, "phone-finding-brain-no-touch-point.png")
      } else {
        const firstSharedCard = sharedLane.getByRole("button").first()
        await firstSharedCard.scrollIntoViewIfNeeded()
        const memorySwipe = await touchHorizontalRail(page, sharedLane, { start: firstSharedCard })
        touchMetrics.brainSharedLane.horizontal = memorySwipe
        if (!memorySwipe.moved || memorySwipe.after.left === memorySwipe.before.left) {
          productFindings.push({ surface: "Brain / Memory cards", cause: "The unobscured Shared Core rail did not move under a real horizontal touch swipe at 390x844.", observed: memorySwipe })
        }
        else coverPhone(phoneCoverage, "rail:Browse Shared Core memories", memorySwipe)
      }
    } else {
      productFindings.push({ surface: "Brain / Memory", cause: "No vertically scrollable ancestor exists at 390x844, so lower Brain panels cannot be reached by touch." })
      await screenshot(page, "phone-finding-brain-no-vertical-scroll.png")
    }
    for (const lane of ENGINE_ORDER.map((id) => ENGINE_LABELS[id])) {
      const label = `Browse ${lane}'s lobe memories`
      const laneRail = page.getByRole("region", { name: label })
      await laneRail.scrollIntoViewIfNeeded()
      const metrics = await laneRail.evaluate((node) => ({ maxLeft: node.scrollWidth - node.clientWidth }))
      if (metrics.maxLeft > 0) {
        const receipt = await touchHorizontalRail(page, laneRail)
        touchMetrics[`brain${lane}Lane`] = receipt
        if (!receipt.moved) productFindings.push({ surface: `Brain / ${lane} memories`, cause: "The overflowing memory rail did not move under real touch.", observed: receipt })
        else coverPhone(phoneCoverage, `rail:${label}`, receipt)
      } else {
        coverPhone(phoneCoverage, `rail:${label}`, { maxLeft: 0, cards: await laneRail.getByRole("button").count() }, "verified-no-overflow")
      }
    }
    coverPhone(phoneCoverage, "vertical:Brain content and memory detail", touchMetrics.brainSharedLane)
    await screenshot(page, "phone-03-brain-bottom.png")

    await tapRoom(page, "Systems", true)
    const systemsRail = page.getByRole("region", { name: "Systems sections" })
    const systemsSwipe = await touchHorizontalRail(page, systemsRail)
    assert.ok(systemsSwipe.after.left > systemsSwipe.before.left, "phone Systems sections move under touch")
    coverPhone(phoneCoverage, "rail:Systems sections", systemsSwipe)
    await systemsRail.evaluate((node) => { node.scrollLeft = 0 })
    await waitForScrollSettled(systemsRail)
    const touchSystemTab = async (label, tab) => {
      const target = systemsRail.getByRole("button", { name: new RegExp(`^${label}(?:\\s|$)`, "i") })
      if (!await touchSwipeUntilVisible(page, systemsRail, target)) {
        productFindings.push({ surface: `Systems / ${label}`, cause: `Real horizontal touch swipes could not bring ${label} into the 390x844 viewport.` })
      }
      await waitForScrollSettled(systemsRail)
      const attempts = []
      let selected = false
      const attemptCount = 2
      for (let attempt = 1; attempt <= attemptCount; attempt += 1) {
        await waitForScrollSettled(systemsRail)
        const before = {
          railLeft: await systemsRail.evaluate((node) => node.scrollLeft),
          ariaCurrent: await target.getAttribute("aria-current"),
          selectedTab: await systemsRail.locator('[aria-current="page"]').textContent(),
        }
        const tap = await touchTap(page, target)
        selected = await page.locator(`[data-system-tab="${tab}"]`).waitFor({ state: "visible", timeout: 1500 }).then(() => true, () => false)
        const after = {
          railLeft: await systemsRail.evaluate((node) => node.scrollLeft),
          ariaCurrent: await target.getAttribute("aria-current"),
          selectedTab: await systemsRail.locator('[aria-current="page"]').textContent(),
          dataSystemTabVisible: selected,
        }
        attempts.push({ attempt, before, tap, after })
        if (selected) break
      }
      touchMetrics.systemTabs ??= {}
      touchMetrics.systemTabs[tab] = attempts
      if (!selected) {
        productFindings.push({ surface: `Systems / ${label}`, cause: `A real touch on the visible ${label} tab did not select it.`, observed: attempts })
      }
    }
    await touchSystemTab("Operations", "operations")
    await touchSystemTab("Mesh", "mesh")
    await touchSystemTab("Activity", "activity")
    await page.getByText("frontend_journey_verified", { exact: true }).waitFor({ state: "visible" })
    await page.getByText("Every event names its observed cause and stays attached to the durable record.", { exact: true }).waitFor({ state: "visible" })
    const phoneAuditReadsBeforeRefresh = state.counts.get("GET /audit/data") || 0
    await Promise.all([
      page.waitForResponse((browserResponse) => new URL(browserResponse.url()).pathname === "/audit/data"),
      page.getByRole("button", { name: "Refresh activity" }).tap(),
    ])
    assert.equal(state.counts.get("GET /audit/data"), phoneAuditReadsBeforeRefresh + 1, "phone Activity refresh performs one bounded audit read")
    const activityScroller = await findVerticalScroller(page, "frontend_journey_verified")
    if (activityScroller) {
      const activityScroll = await touchSwipe(page, activityScroller, { x: 0, y: -360 })
      if (!activityScroll.moved || activityScroll.after.top <= activityScroll.before.top) {
        productFindings.push({ surface: "Systems / Activity", cause: "The audit record overflows at 390x844, but a real vertical touch swipe did not move its history." })
      }
    } else {
      productFindings.push({ surface: "Systems / Activity", cause: "No vertically scrollable audit history exists at 390x844." })
    }
    await touchSystemTab("Inventory", "inventory")
    await touchSystemTab("Loops", "loops")
    const starters = page.getByRole("region", { name: "Multi-Loop starters" })
    const phoneMultiReadiness = page.getByLabel("Multi-Loop engine readiness")
    const phoneMultiOrder = (await phoneMultiReadiness.locator(":scope > span").allTextContents()).map((label) => label.split("·")[0].trim())
    assert.deepEqual(phoneMultiOrder.map((label) => label.toLowerCase()), ENGINE_ORDER, "390px Multi-Loop readiness preserves the exact permanent roster order")
    assert.match(await phoneMultiReadiness.innerText(), /Cursor.*chat-only and human-directed.*never receives unattended work/is)
    const loopsScroller = await findVerticalScroller(page, "add a loop")
    if (loopsScroller) {
      const nestedVertical = await touchSwipeWithRetry(page, starters.getByRole("button").first(), { x: 0, y: -360, observe: loopsScroller })
      touchMetrics.multiLoopStarterVertical = nestedVertical
      if (!nestedVertical.moved || nestedVertical.after.top <= nestedVertical.before.top) {
        productFindings.push({ surface: "Systems / Loops starters", cause: "A vertical touch beginning on a Multi-Loop starter card does not move the Loops page.", observed: nestedVertical })
      }
      else coverPhone(phoneCoverage, "vertical:Loops and Multi-Loops", nestedVertical)
      await loopsScroller.evaluate((node) => { node.scrollTop = 0 })
      let starterSwipe = await touchHorizontalRail(page, starters)
      if (!starterSwipe.moved && starterSwipe.before.left > 0) starterSwipe = await touchSwipe(page, starters, { x: 220 })
      touchMetrics.multiLoopStarterHorizontal = starterSwipe
      if (!starterSwipe.moved) {
        productFindings.push({ surface: "Systems / Loops starters", cause: "The Multi-Loop starter rail did not move under a real horizontal touch swipe at 390x844.", observed: starterSwipe })
      }
      else coverPhone(phoneCoverage, "rail:Multi-Loop starters", starterSwipe)
      const developmentRecipes = page.getByRole("region", { name: "Development loop recipes" })
      await developmentRecipes.scrollIntoViewIfNeeded()
      const recipeSwipe = await touchHorizontalRail(page, developmentRecipes)
      touchMetrics.developmentLoopRecipes = recipeSwipe
      if (!recipeSwipe.moved) productFindings.push({ surface: "Systems / Development loop recipes", cause: "The development recipe rail did not move under real touch.", observed: recipeSwipe })
      else coverPhone(phoneCoverage, "rail:Development loop recipes", recipeSwipe)
      const loopScroll = await touchSwipe(page, loopsScroller, { x: 0, y: -420 })
      if (!loopScroll.moved || loopScroll.after.top <= loopScroll.before.top) {
        productFindings.push({ surface: "Systems / Loops", cause: "A vertically overflowing Loops container exists at 390x844, but a real touch swipe did not move it." })
        await screenshot(page, "phone-finding-loops-touch-did-not-scroll.png")
      }
    } else {
      productFindings.push({ surface: "Systems / Loops", cause: "No vertically scrollable ancestor exists at 390x844, so lower Loop and Multi-Loop controls cannot be reached by touch." })
      await screenshot(page, "phone-finding-loops-no-vertical-scroll.png")
    }
    await screenshot(page, "phone-04-loops-bottom.png")

    // Settings itself is a horizontal rail plus a vertically scrollable pane.
    const openPhoneSettings = page.getByRole("button", { name: "Open settings" })
    const settings = page.getByRole("dialog", { name: "Settings" })
    touchMetrics.openSettings = await touchTapAndWait(page, openPhoneSettings, settings, "phone Settings")
    coverPhone(phoneCoverage, "global:settings", touchMetrics.openSettings)
    coverPhone(phoneCoverage, "dialog:Settings", touchMetrics.openSettings)
    const settingsRail = settings.getByRole("region", { name: "Settings sections" })
    const settingsSwipe = await touchSwipe(page, settingsRail)
    assert.ok(settingsSwipe.after.left > settingsSwipe.before.left, "phone Settings sections move under touch")
    coverPhone(phoneCoverage, "rail:Settings sections", settingsSwipe)
    await settingsRail.getByRole("button", { name: /^LLM Roster/i }).tap()
    await settings.getByRole("heading", { name: "LLM Roster", exact: true }).waitFor({ state: "visible" })
    const phoneSettingsOrder = await settings.getByRole("switch").evaluateAll((switches, engineLabels) => {
      const allowed = new Set(engineLabels)
      return [...new Set(switches.map((control) => String(control.getAttribute("aria-label") || "").replace(/ (?:active|in chat)$/i, "")).filter((label) => allowed.has(label)))]
    }, ENGINE_ORDER.map((id) => ENGINE_LABELS[id]))
    assert.deepEqual(phoneSettingsOrder, ENGINE_ORDER.map((id) => ENGINE_LABELS[id]), "390px Settings preserves the exact permanent roster order")
    assert.equal(await settings.getByRole("switch", { name: "Cursor active", exact: true }).count(), 0, "390px Settings exposes no Cursor unattended-work toggle")
    await settings.getByLabel("Cursor unattended work unavailable").waitFor({ state: "visible" })
    const phoneDeepSeekSettings = settings.locator("section").filter({ hasText: "DeepSeek profile" }).first()
    assert.equal(await phoneDeepSeekSettings.getByLabel(/^Per-run limit\s*\$$/).inputValue(), "1")
    assert.equal(await phoneDeepSeekSettings.getByLabel(/^Daily limit\s*\$$/).inputValue(), "5")
    await settings.getByText("Kimi profile", { exact: true }).waitFor({ state: "visible" })
    const settingsScroller = await findVerticalScroller(page, "Kimi profile")
    if (settingsScroller) {
      const settingsScroll = await touchSwipe(page, settingsScroller, { x: 0, y: -320 })
      if (!settingsScroll.moved || settingsScroll.after.top <= settingsScroll.before.top) {
        productFindings.push({ surface: "Settings / LLM Roster", cause: "A vertically overflowing Settings container exists at 390x844, but a real touch swipe did not move it." })
        await screenshot(page, "phone-finding-settings-touch-did-not-scroll.png")
      }
      else coverPhone(phoneCoverage, "vertical:Settings content", settingsScroll)
    } else {
      productFindings.push({ surface: "Settings / LLM Roster", cause: "No vertically scrollable settings content exists at 390x844, so lower agent settings cannot be reached by touch." })
      await screenshot(page, "phone-finding-settings-no-vertical-scroll.png")
    }
    const phoneSecurityButton = settingsRail.getByRole("button", { name: /^Security/i })
    if (!await touchSwipeUntilVisible(page, settingsRail, phoneSecurityButton)) {
      productFindings.push({ surface: "Settings / Security", cause: "Real horizontal touch swipes could not bring the Security / 2FA section into the 390x844 viewport." })
    } else {
      await phoneSecurityButton.tap()
      await settings.getByRole("heading", { name: "Two-factor authentication" }).waitFor({ state: "visible" })
      assert.ok((state.counts.get("GET /2fa/status") || 0) >= 1, "phone Security reads live 2FA state without a standalone /2fa page")
    }
    await screenshot(page, "phone-05-settings.png")
    await page.keyboard.press("Escape")

    // Mobile thread travels with the work and can be closed without leaving.
    await page.getByRole("button", { name: "Open team thread" }).tap()
    const thread = page.locator('aside[aria-label="Shared team thread"]:visible')
    await thread.waitFor({ state: "visible" })
    coverPhone(phoneCoverage, "global:team thread", "opened with touch")
    await thread.getByRole("button", { name: "Close team thread" }).tap()

    assert.equal(state.counts.get("GET /sw.js") || 0, 0, "the phone Next development journey never requests the production-owned worker")
    proof.phone = { viewport: LIVE_SURFACE_INVENTORY.viewports.phone, requests: Object.fromEntries(state.counts), diagnostics, productFindings, touchMetrics }
    await context.tracing.stop({ path: path.join(ARTIFACT_DIR, "phone-trace.zip") })
    await assertNoErrorOverlay(page, diagnostics)
    await context.close()
    assert.deepEqual(productFindings, [], "phone journey has no product findings")
  })

  await t.test("phone 390x844 builds Brand DNA from a URL once and opens the stored drawer", { timeout: 120_000, skip: selectedViewport !== "phone-brand-dna" }, async (brandDnaJourney) => {
    const state = createMockState()
    state.mode = "growth"
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, reducedMotion: "reduce" })
    brandDnaJourney.after(() => closeContext(context))
    const page = await context.newPage()
    page.setDefaultTimeout(30_000)
    await installMockApi(page, baseUrl, state)
    const diagnostics = startDiagnostics(page, "phone Brand DNA from URL")
    await page.goto(`${baseUrl}/?view=growth/brand-dna`, { waitUntil: "domcontentloaded", timeout: 60_000 })
    await neutralizeDevToolbar(page)

    const websiteUrl = page.getByLabel("Website URL for ClaimFlow", { exact: true })
    await websiteUrl.waitFor({ state: "visible", timeout: 60_000 })
    const buildButton = page.getByRole("button", { name: "Build Brand DNA from this site", exact: true }).first()
    const buildButtonBox = await buildButton.boundingBox()
    assert.ok(buildButtonBox && buildButtonBox.width >= 44 && buildButtonBox.height >= 44, `Build Brand DNA is at least 44x44 at 390px; got ${JSON.stringify(buildButtonBox)}`)
    assert.deepEqual(state.growthDna.claimflow.map((record) => record.asset), ["brand-voice"], "the fixture starts with one legacy hidden Brain record")
    const dnaRecordTile = page.getByText("DNA records", { exact: true }).locator("..")
    await dnaRecordTile.getByText("0", { exact: true }).waitFor({ state: "visible" })
    assert.match(await buildButton.locator("xpath=ancestor::form[1]").innerText(), /No Brand DNA is on file yet/i)

    await websiteUrl.fill("ftp://claimflow.health")
    await websiteUrl.press("Enter")
    assert.equal(state.counts.get("POST /growth/accounts/claimflow/dna/from-url") || 0, 0, "an invalid URL scheme never reaches the box")
    await page.getByRole("alert").filter({ hasText: "must use http or https" }).waitFor({ state: "visible" })

    await websiteUrl.fill("https://claimflow.health")
    state.growthDnaBuildDelayMs = 1_500
    const buildResponse = page.waitForResponse((response) => response.request().method() === "POST"
      && new URL(response.url()).pathname === "/growth/accounts/claimflow/dna/from-url"
      && response.status() === 200)
    await websiteUrl.press("Enter")
    await websiteUrl.press("Enter")
    await page.getByRole("button", { name: "Building Brand DNA…", exact: true }).waitFor({ state: "visible" })
    assert.equal(state.counts.get("POST /growth/accounts/claimflow/dna/from-url"), 1, "rapid Enter sends exactly one Brand DNA generation request")
    await buildResponse
    state.growthDnaBuildDelayMs = 0

    const drawer = page.getByRole("dialog", { name: /Brand DNA.*ClaimFlow/i })
    await drawer.waitFor({ state: "visible" })
    assert.deepEqual(state.growthDnaBuildBodies, [{ accountId: "claimflow", url: "https://claimflow.health" }])
    const stored = state.growthDna.claimflow.filter((record) => record.source === "generated")
    assert.equal(stored.length, 5)
    assert.equal(state.growthDna.claimflow.length, 6, "the legacy record remains stored but must stay hidden from the five-section UI")
    assert.ok(stored.every((record) => record.provenance?.source_url === "https://claimflow.health/"))
    await dnaRecordTile.getByText("5", { exact: true }).waitFor({ state: "visible" })
    // Scoped to the named region, not to every <section> in the dialog. The
    // old form asserted "five canonical sections" but MEASURED "no other panel
    // exists anywhere in this drawer" -- a stricter claim than intended, and
    // the wrong one: it failed for a panel that added no Brand DNA section at
    // all. Scoping tightens it, since a sixth DnaAssetRow now fails here AND a
    // stray section inside the region fails, while an unrelated sibling panel
    // is correctly none of this assertion's business.
    assert.equal(await drawer.getByRole("region", { name: "Brand DNA sections" }).locator("section").count(), 5,
      "the drawer renders exactly the five canonical Brand DNA sections")
    for (const label of ["Brand Guidelines", "Brand Voice", "Competitive Intelligence", "Campaign Performance Stats", "Call Recordings"]) {
      assert.equal(await drawer.getByText(label, { exact: true }).count(), 1, `${label} is rendered once`)
    }
    assert.equal(await drawer.getByLabel("Website URL for ClaimFlow", { exact: true }).count(), 1, "the stored Brand DNA drawer keeps the URL entry point")

    // The client's corpus is mappable from the drawer that owns it, at 390px,
    // by touch. Two things are being protected here beyond reachability:
    // the map builder must NEVER be able to write Brand DNA (putDna stays the
    // one provenance-checked write path -- a generated graph is a derived
    // artifact, not a client-authored claim), and the operator must not have
    // to leave the drawer for Artifacts to do it.
    const brandArtifactReads = state.counts.get("GET /artifacts") || 0
    const brandGraphsBefore = state.graphifyBodies.length
    const brandDnaWritesBefore = state.growthDna.claimflow.length
    // The drawer belongs to ONE client, so its picker must offer that client and
    // nobody else. Unrestricted, this listed every account the box knows -- so
    // ClaimFlow's drawer offered to graph Acme. Asserting the option LIST, not
    // just the selection, is the point: selecting the right value proves
    // nothing if the wrong values are still one tap away.
    const brandTargetOptions = await drawer.getByLabel("Graphify target").locator("option").evaluateAll(
      (options) => options.map((option) => option.value),
    )
    assert.deepEqual(brandTargetOptions, ["brand:claimflow"],
      "the Brand DNA drawer offers exactly its own client's corpus and no other account's")
    assert.equal(await drawer.getByLabel("Folder to graph").inputValue(), "brand_all")
    const brandGenerateGraph = drawer.getByRole("button", { name: "Generate graph", exact: true })
    const brandGenerateBox = await brandGenerateGraph.boundingBox()
    assert.ok(brandGenerateBox && brandGenerateBox.width >= 44 && brandGenerateBox.height >= 44,
      `Generate graph is at least 44x44 inside the 390px Brand DNA drawer; got ${JSON.stringify(brandGenerateBox)}`)
    // Waiting on one response gives a bare "Timeout 30000ms exceeded" that
    // names nothing when the sequence stalls at a DIFFERENT step -- a brand
    // graph is reserve, generate, acknowledge, and only the middle one is
    // /api/graphify. Poll the mock's own request log instead, and put that log
    // in the failure message, so a stall says which of the three never fired.
    const brandRequestStart = state.requests.length
    await brandGenerateGraph.tap()
    const brandGraphSeen = async () => state.graphifyBodies.length > brandGraphsBefore
    const brandDeadline = Date.now() + 20_000
    while (!(await brandGraphSeen()) && Date.now() < brandDeadline) await page.waitForTimeout(250)
    const brandGraphifyCalls = state.requests.slice(brandRequestStart)
      .filter(({ pathname }) => pathname.startsWith("/api/graphify"))
      .map(({ method, pathname }) => `${method} ${pathname}`)
    assert.equal(state.graphifyBodies.length, brandGraphsBefore + 1,
      `the drawer submits exactly one graph; graphify calls actually seen after the tap: ${JSON.stringify(brandGraphifyCalls)}`)
    assert.equal(state.graphifyBodies.at(-1).targetId, "brand:claimflow", "the drawer graphs the client whose drawer it is")
    await drawer.getByText(/Last successful graph.*ClaimFlow \(claimflow\).*Brand DNA/s).waitFor({ state: "visible" })
    assert.equal(state.growthDna.claimflow.length, brandDnaWritesBefore,
      "generating a graph must never write Brand DNA -- putDna stays the only provenance-checked write path")
    assert.equal(state.counts.get("GET /artifacts") || 0, brandArtifactReads,
      "mapping a client from its own drawer must not require the Artifacts room to load")
    await screenshot(page, "phone-growth-brand-dna-from-url.png")
    await assertNoErrorOverlay(page, diagnostics)
    proof.brandDnaFromUrl = {
      viewport: { width: 390, height: 844 },
      requests: state.counts.get("POST /growth/accounts/claimflow/dna/from-url"),
      writes: stored.length,
      sourceUrl: stored[0].provenance.source_url,
      drawerOpened: true,
      touchTarget: buildButtonBox,
      diagnostics,
    }
  })

  await t.test("phone 390x844 executes every exposed control and consequence gate with touch", { timeout: 600_000, skip: selectedViewport === "desktop" || selectedViewport === "phone-navigation" || selectedViewport === "phone-brand-dna" }, async (phoneControlsJourney) => {
    const state = createMockState()
    state.settings.settings.llm.roster.deepseek.active = false
    const productFindings = []
    const actionPhases = ["phone action context starting"]
    proof.phoneActionPhases = actionPhases
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, reducedMotion: "reduce" })
    const phoneControlsTracePath = path.join(ARTIFACT_DIR, "phone-controls-trace.zip")
    let phoneControlsTracePending = false
    phoneControlsJourney.after(async () => {
      const cleanupFailures = []
      if (phoneControlsTracePending) {
        try { await context.tracing.stop({ path: phoneControlsTracePath }) }
        catch (error) { cleanupFailures.push(error) }
      }
      try { await closeContext(context) }
      catch (error) { cleanupFailures.push(error) }
      if (cleanupFailures.length) throw new AggregateError(cleanupFailures, "Phone control journey cleanup failed")
    })
    await context.addInitScript(() => {
      try {
        window.localStorage.setItem("agenthost_fleet", JSON.stringify(["peer-box.example"]))
      } catch {
        // The script also runs in opaque child frames; only the top box origin owns this registry.
      }
      const inject = () => {
        if (!document.body) return
        document.body.setAttribute("data-new-gr-c-s-check-loaded", "14.1318.0")
        document.body.setAttribute("data-gr-ext-installed", "")
      }
      new MutationObserver(inject).observe(document, { childList: true, subtree: true })
      inject()
    })
    const page = await context.newPage()
    page.setDefaultTimeout(30_000)
    await installMockApi(page, baseUrl, state)
    // Open links target a new browsing context, so give that popup the same
    // deterministic box responses as the primary page route.
    await context.route(`${baseUrl}/files/dl?*`, (route) => route.fulfill({ status: 200, contentType: "text/plain", body: "fixture" }))
    await context.route(`${baseUrl}/artifacts/view?*`, (route) => route.fulfill({ status: 200, contentType: "text/plain", body: "fixture" }))
    await context.route("https://peer-box.example/*", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Peer box</title><main>Peer box canonical root</main>" }))
    await context.route("https://github.com/SirAllap/agentglass", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>AgentGlass</title><main>AgentGlass source</main>" }))
    const diagnostics = startDiagnostics(page, "phone controls")
    proof.phoneControls = { diagnostics, productFindings, phases: actionPhases }
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true })
    phoneControlsTracePending = true
    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 60_000 })
    await neutralizeDevToolbar(page)
    await primaryNav(page).waitFor({ state: "visible", timeout: 60_000 })
    await page.getByText(taskObjective.title).first().waitFor({ state: "visible", timeout: 30_000 })
    actionPhases.push("phone action shell ready")

    const phoneTopBar = page.locator("header").first()
    const topBarTouchBoxes = {}
    for (const label of ["Dev", "Growth", "Open team thread", "Open settings", "More actions"]) {
      const control = phoneTopBar.getByRole("button", { name: label, exact: true })
      const box = await control.boundingBox()
      assert.ok(box && box.width >= 44 && box.height >= 44, `top-bar ${label} is at least 44x44 at 390px; got ${JSON.stringify(box)}`)
      topBarTouchBoxes[label] = box
    }
    proof.phoneControls.topBarTouchBoxes = topBarTouchBoxes

    const exerciseAssist = async (scope, input, coverageKey, label, surface, { harden = false } = {}) => {
      const original = await input.inputValue()
      assert.ok(original.trim().length >= 12, `${label} fixture enables enrich-only Assist`)
      const assist = scope.getByRole("button", { name: "Sharpen what you wrote with AI", exact: true })
      await assist.scrollIntoViewIfNeeded()
      const assistBox = await assist.boundingBox()
      assert.ok(assistBox && assistBox.width >= 44 && assistBox.height >= 44, `${label} Assist is at least 44x44; got ${JSON.stringify(assistBox)}`)
      const requireTrustedAssistTouch = (receipt, phase) => {
        assert.equal(receipt.blocked, false, `${label} ${phase} Assist touch is unblocked: ${JSON.stringify(receipt)}`)
        assert.equal(receipt.activation?.clicked, true, `${label} ${phase} Assist touch activates the button: ${JSON.stringify(receipt)}`)
        assert.equal(receipt.activation?.trusted, true, `${label} ${phase} Assist touch is browser-trusted: ${JSON.stringify(receipt)}`)
        return receipt
      }
      const before = state.counts.get("POST /api/assist") || 0
      let assistTouches
      let successfulBefore = before
      if (harden) {
        state.failNextAssist = true
        const failed = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/assist" && response.status() === 409)
        const failureTouch = requireTrustedAssistTouch(await touchTap(page, assist), "named failure")
        await failed
        assert.equal(state.counts.get("POST /api/assist"), before + 1, `${label} named Assist failure sends exactly one request`)
        assert.deepEqual(state.assistBodies.at(-1), { text: original, surface }, `${label} failed Assist sends only the live draft and real surface`)
        assert.equal(await input.inputValue(), original, `${label} failed Assist leaves the draft unchanged`)
        const unchanged = scope.getByText(/Draft unchanged .* another Assist request is already running -- try again in a moment/).last()
        await unchanged.waitFor({ state: "visible" })
        assert.match(await unchanged.innerText(), /another Assist request is already running -- try again in a moment/, `${label} failed Assist names the box's exact cause`)
        successfulBefore = before + 1
        assistTouches = { failureTouch }
      }

      const assisted = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/assist" && response.status() === 200)
      if (harden) {
        state.holdNextAssist = true
        try {
          assistTouches.rapidDouble = await touchDoubleTap(page, assist)
          const deadline = Date.now() + 5000
          while (!state.assistHeld && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))
          assert.equal(state.assistHeld, true, `${label} delayed Assist request reached the fixture`)
          assert.equal(state.counts.get("POST /api/assist"), successfulBefore + 1, `${label} rapid double tap starts exactly one request`)
          assert.equal(await assist.isDisabled(), true, `${label} pending Assist is locked`)
          assert.match(await assist.innerText(), /Assisting/, `${label} pending control names its work`)
          assert.equal(await input.inputValue(), original, `${label} streaming work does not replace the live draft early`)
          await scope.getByText(/^\d+\.\d+s$/).waitFor({ state: "visible" })
        } finally {
          state.releaseAssist?.()
        }
      } else {
        assistTouches = requireTrustedAssistTouch(await touchTap(page, assist), "one-tap")
      }
      await assisted
      assert.equal(state.counts.get("POST /api/assist"), successfulBefore + 1, `${label} one-tap Assist sends exactly one request`)
      assert.deepEqual(state.assistBodies.at(-1), { text: original, surface }, `${label} Assist sends only the live draft and real surface`)
      await page.waitForFunction(({ node, original }) => node.value === `Sharpened: ${original}`, { node: await input.elementHandle(), original })
      const stopwatch = scope.getByText(/first words$/)
      await stopwatch.waitFor({ state: "visible" })
      const stopwatchText = (await stopwatch.innerText()).trim()
      const undo = scope.getByRole("button", { name: "Undo AI Assist", exact: true })
      const undoBox = await undo.boundingBox()
      assert.ok(undoBox && undoBox.width >= 44 && undoBox.height >= 44, `${label} Undo is at least 44x44; got ${JSON.stringify(undoBox)}`)
      await touchTap(page, undo)
      assert.equal(await input.inputValue(), original, `${label} Undo restores the operator's exact draft`)
      coverPhone(phoneCoverage, coverageKey, {
        assistTouches,
        oneTap: harden ? "named 409 preserved draft; rapid double touch POST=1; pending control locked" : "real touch; POST=1",
        stopwatch: stopwatchText,
        undo: "44px real touch restored the exact original",
      })
      return { stopwatch: stopwatchText, requests: (state.counts.get("POST /api/assist") || 0) - before }
    }

    if (assistOnly) {
      await page.getByRole("button", { name: "More actions" }).tap()
      const moreActions = page.locator('section[aria-label="More actions"]')
      await moreActions.getByRole("button", { name: "New task" }).tap()
      const createTask = page.getByRole("dialog", { name: "Create task" })
      await createTask.getByPlaceholder(/Fix the mobile nav overlap/i).fill("Assist stopwatch proof")
      const taskDetails = createTask.locator("textarea")
      await taskDetails.fill("Keep this real operator draft unchanged until the complete streamed answer arrives.")
      proof.phoneControls.assistFast = await exerciseAssist(
        createTask,
        taskDetails,
        "global:task draft Assist and Undo",
        "task details",
        "card",
        { harden: true },
      )
      assert.deepEqual(
        diagnostics.expectedHttpFailures.filter((failure) => failure.method === "POST" && failure.pathname === "/api/assist"),
        [{ method: "POST", pathname: "/api/assist", status: 409 }],
      )
      await context.tracing.stop({ path: phoneControlsTracePath })
      phoneControlsTracePending = false
      await assertNoErrorOverlay(page, diagnostics)
      await context.close()
      proof.phoneControls = { ...proof.phoneControls, requests: Object.fromEntries(state.counts) }
      return
    }

    // Overview cards and destinations are touched, not merely rendered.
    const roomVertical = await exerciseVerticalSurface(page, page.getByText(taskObjective.title).first(), "Overview room content")
    coverPhone(phoneCoverage, "vertical:room content", roomVertical, roomVertical.outcome)
    const overviewAgent = page.getByRole("dialog", { name: /Claude/i })
    proof.phoneControls.overviewAgentTouch = await touchTapAndWait(
      page,
      page.getByRole("button", { name: "Open Claude", exact: true }),
      overviewAgent,
      "Overview Claude detail",
      1,
    )
    coverPhone(phoneCoverage, "room:Overview:agent cards", "Open Claude touched")
    coverPhone(phoneCoverage, "dialog:Agent details", "Claude detail opened by touch")
    await overviewAgent.getByRole("button", { name: "Close", exact: true }).last().tap()
    await page.getByRole("button", { name: "Open t_objective" }).tap()
    const overviewTask = page.getByRole("dialog", { name: taskObjective.title })
    await overviewTask.waitFor({ state: "visible" })
    coverPhone(phoneCoverage, "room:Overview:task cards", "Open t_objective touched")
    coverPhone(phoneCoverage, "dialog:Task details / Archive this task?", "task detail opened from Overview")
    await overviewTask.getByRole("button", { name: "Close", exact: true }).last().tap()
    await page.getByRole("button", { name: "Open Brain" }).tap()
    await page.getByRole("heading", { name: "Brain" }).waitFor({ state: "visible" })
    coverPhone(phoneCoverage, "room:Overview:open Brain", "touched")
    await tapRoom(page, "Overview", true)
    await page.getByRole("button", { name: "Open Work" }).tap()
    await page.locator('[data-work-tab="board"]').waitFor({ state: "visible" })
    coverPhone(phoneCoverage, "room:Overview:open Work", "touched")

    // Board task gates: Cancel=0 and Confirm=1 for archive and resume.
    const sort = page.getByLabel("Sort cards within each lane")
    await sort.tap()
    await sort.selectOption("priority")
    coverPhone(phoneCoverage, "room:Board:sort", "touched and changed to priority")
    coverPhone(phoneCoverage, "room:Board:client filter", "not exposed in Dev Mode at 390px", "not-exposed-in-dev")
    await page.getByRole("button", { name: /Objective: Make the complete Workspace reachable/i }).tap()
    const taskDialog = page.getByRole("dialog", { name: taskObjective.title })
    await taskDialog.getByRole("button", { name: "Archive" }).tap()
    await taskDialog.getByText("Archive this task?").waitFor({ state: "visible" })
    await taskDialog.getByRole("button", { name: "Cancel" }).tap()
    assert.equal(state.counts.get("POST /board/task/t_objective/review") || 0, 0)
    await taskDialog.getByRole("button", { name: "Archive" }).tap()
    await taskDialog.getByRole("button", { name: "Archive task" }).tap()
    assert.equal(state.counts.get("POST /board/task/t_objective/review"), 1)
    coverPhone(phoneCoverage, "room:Board:task cards", "archive Cancel=0 Confirm=1")

    await page.getByRole("button", { name: /Objective: Make the complete Workspace reachable/i }).tap()
    const blockableTask = page.getByRole("dialog", { name: taskObjective.title })
    const freezesBeforeBlock = state.counts.get("POST /board/task/t_objective/freeze") || 0
    await blockableTask.getByRole("button", { name: "Block", exact: true }).tap()
    await blockableTask.getByText("Block this task?", { exact: true }).waitFor({ state: "visible" })
    await blockableTask.getByRole("button", { name: "Cancel", exact: true }).tap()
    assert.equal(state.counts.get("POST /board/task/t_objective/freeze") || 0, freezesBeforeBlock)
    await blockableTask.getByRole("button", { name: "Block", exact: true }).tap()
    const blockResponse = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/board/task/t_objective/freeze")
    await touchDoubleTap(page, blockableTask.getByRole("button", { name: "Confirm block" }))
    await blockResponse
    assert.equal(state.counts.get("POST /board/task/t_objective/freeze"), freezesBeforeBlock + 1)
    assert.deepEqual(state.boardFreezeBodies.at(-1), { pathname: "/board/task/t_objective/freeze", body: {} })
    coverPhone(phoneCoverage, "room:Board:block consequence", "Cancel=0; rapid double Confirm=exactly one freeze request with exact empty reason body")
    coverPhone(phoneCoverage, "dialog:Block this task?", "copy names scheduler stop and freeze; Cancel=0 Confirm=1")
    const boardVertical = await exerciseVerticalSurface(page, page.getByRole("button", { name: /Keep the whole team attached to the result/i }), "Board lane cards")
    coverPhone(phoneCoverage, "vertical:board lane cards", boardVertical, boardVertical.outcome)
    await page.getByRole("button", { name: /Keep the whole team attached to the result/i }).tap()
    const resumedTask = page.getByRole("dialog", { name: taskDone.title })
    await resumedTask.getByRole("button", { name: "Resume" }).tap()
    await resumedTask.getByRole("button", { name: "Cancel" }).tap()
    assert.equal(state.counts.get("POST /board/task/t_done/unfreeze") || 0, 0)
    await resumedTask.getByRole("button", { name: "Resume" }).tap()
    await resumedTask.getByRole("button", { name: "Confirm resume" }).tap()
    assert.equal(state.counts.get("POST /board/task/t_done/unfreeze"), 1)
    coverPhone(phoneCoverage, "dialog:Resume this task?", "Cancel=0 Confirm=1")

    const openReviewTask = async () => {
      await page.getByRole("button", { name: /Verify phone touch and scroll/i }).tap()
      const dialog = page.getByRole("dialog", { name: taskReview.title })
      await dialog.waitFor({ state: "visible" })
      return dialog
    }
    let reviewTask = await openReviewTask()
    await reviewTask.getByRole("button", { name: /Claude/i }).first().tap()
    const reviewAssignee = page.getByRole("dialog", { name: /Claude/i }).last()
    await reviewAssignee.waitFor({ state: "visible" })
    await reviewAssignee.getByRole("button", { name: "Close", exact: true }).last().tap()
    coverPhone(phoneCoverage, "room:Board:open assignee", "task assignee touched and canonical Agent detail opened")

    reviewTask = await openReviewTask()
    const reviewsBeforeApprove = state.counts.get("POST /board/task/t_review/review") || 0
    await reviewTask.getByRole("button", { name: "Approve", exact: true }).tap()
    await reviewTask.getByText("Approve this task?", { exact: true }).waitFor({ state: "visible" })
    await reviewTask.getByRole("button", { name: "Cancel", exact: true }).tap()
    assert.equal(state.counts.get("POST /board/task/t_review/review") || 0, reviewsBeforeApprove)
    await reviewTask.getByRole("button", { name: "Approve", exact: true }).tap()
    const approveResponse = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/board/task/t_review/review")
    await touchDoubleTap(page, reviewTask.getByRole("button", { name: "Confirm approval" }))
    await approveResponse
    assert.equal(state.counts.get("POST /board/task/t_review/review"), reviewsBeforeApprove + 1)
    assert.deepEqual(state.boardReviewBodies.at(-1), { pathname: "/board/task/t_review/review", body: { action: "approve" } })
    coverPhone(phoneCoverage, "room:Board:approve consequence", "Cancel=0; rapid double Confirm=exactly one approve request with exact body")
    coverPhone(phoneCoverage, "dialog:Approve this task?", "dispatch/spend/review consequence shown; Cancel=0 Confirm=1")

    reviewTask = await openReviewTask()
    const reviewsBeforeSendBack = state.counts.get("POST /board/task/t_review/review") || 0
    await reviewTask.getByRole("button", { name: "Send back", exact: true }).tap()
    const sendBackReason = reviewTask.getByPlaceholder("Why is this going back?")
    await sendBackReason.tap()
    await sendBackReason.fill("Phone review found a concrete regression.")
    await reviewTask.getByRole("button", { name: "Cancel", exact: true }).tap()
    assert.equal(state.counts.get("POST /board/task/t_review/review"), reviewsBeforeSendBack)
    await reviewTask.getByRole("button", { name: "Send back", exact: true }).tap()
    await reviewTask.getByPlaceholder("Why is this going back?").fill("Phone review found a concrete regression.")
    const sendBackResponse = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/board/task/t_review/review")
    await touchDoubleTap(page, reviewTask.getByRole("button", { name: "Confirm send back" }))
    await sendBackResponse
    assert.equal(state.counts.get("POST /board/task/t_review/review"), reviewsBeforeSendBack + 1)
    assert.deepEqual(state.boardReviewBodies.at(-1), { pathname: "/board/task/t_review/review", body: { action: "reject", note: "Phone review found a concrete regression." } })
    coverPhone(phoneCoverage, "room:Board:send back consequence", "reason touched and filled; Cancel=0; rapid double Confirm=exactly one reject request")
    coverPhone(phoneCoverage, "dialog:Send this task back?", "dispatch/spend consequence shown; Cancel=0 Confirm=1")

    reviewTask = await openReviewTask()
    const reviewsBeforeReassign = state.counts.get("POST /board/task/t_review/review") || 0
    await reviewTask.getByRole("button", { name: "Reassign", exact: true }).tap()
    await reviewTask.getByRole("button", { name: "Codex", exact: true }).tap()
    await reviewTask.getByText("Reassign this task to Codex?", { exact: true }).waitFor({ state: "visible" })
    await reviewTask.getByRole("button", { name: "Cancel", exact: true }).tap()
    assert.equal(state.counts.get("POST /board/task/t_review/review"), reviewsBeforeReassign)
    await reviewTask.getByRole("button", { name: "Codex", exact: true }).tap()
    const reassignResponse = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/board/task/t_review/review")
    await touchDoubleTap(page, reviewTask.getByRole("button", { name: "Confirm reassign" }))
    await reassignResponse
    assert.equal(state.counts.get("POST /board/task/t_review/review"), reviewsBeforeReassign + 1)
    assert.deepEqual(state.boardReviewBodies.at(-1), { pathname: "/board/task/t_review/review", body: { action: "reassign", engine: "codex" } })
    coverPhone(phoneCoverage, "room:Board:reassign consequence", "target touched; Cancel=0; rapid double Confirm=exactly one reassign request")
    coverPhone(phoneCoverage, "dialog:Reassign this task?", "dispatch/spend consequence shown; Cancel=0 Confirm=1")

    reviewTask = await openReviewTask()
    await reviewTask.getByRole("button", { name: "Discuss in chat", exact: true }).tap()
    const taskThread = page.locator('aside[aria-label="Shared team thread"]:visible')
    await taskThread.waitFor({ state: "visible" })
    await taskThread.getByRole("button", { name: "Close team thread" }).tap()
    coverPhone(phoneCoverage, "room:Board:discuss task", "Discuss in chat touched; attached team thread opened and its Close was touched")

    // Files, Artifacts, Terminal, and Reviews all stay in the Work shell.
    await clickSection(page, "Work sections", "Files", true)
    const refreshFiles = page.getByRole("button", { name: "Refresh files", exact: true })
    const refreshFilesBox = await refreshFiles.boundingBox()
    assert.ok(refreshFilesBox && refreshFilesBox.width >= 44 && refreshFilesBox.height >= 44, `Refresh files has a 44x44 phone touch target; got ${JSON.stringify(refreshFilesBox)}`)
    const uploadFile = page.getByRole("button", { name: "Upload", exact: true })
    const uploadFileBox = await uploadFile.boundingBox()
    assert.ok(uploadFileBox && uploadFileBox.width >= 44 && uploadFileBox.height >= 44, `Upload has a 44x44 phone touch target; got ${JSON.stringify(uploadFileBox)}`)
    await refreshFiles.tap()
    await page.getByRole("region", { name: "File locations" }).getByRole("button", { name: /Team inbox/i }).tap()
    await page.getByText("handoff.md").tap()
    const openFile = page.getByRole("link", { name: "Open" })
    const downloadFile = page.getByRole("link", { name: "Download" })
    assert.equal(await openFile.getAttribute("href"), "/files/dl?p=team%2Fhandoff.md")
    assert.equal(await downloadFile.getAttribute("href"), "/files/dl?p=team%2Fhandoff.md")
    const [filePopup] = await Promise.all([context.waitForEvent("page"), openFile.tap()])
    await filePopup.waitForURL((url) => url.pathname === "/files/dl")
    await filePopup.waitForLoadState("domcontentloaded")
    assert.equal(new URL(filePopup.url()).pathname, "/files/dl")
    assert.equal(await filePopup.locator("body").innerText(), "fixture")
    await filePopup.close()
    coverPhone(phoneCoverage, "room:Files:open", "touch navigated to canonical file response")
    const [fileDownload] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Download" }).tap()])
    assert.match(fileDownload.suggestedFilename(), /handoff\.md/i)
    coverPhone(phoneCoverage, "room:Files:download", "touch produced a browser download")
    const selectPhoneUpload = async () => {
      const [fileChooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Upload" }).tap()])
      await fileChooser.setFiles({ name: "phone-proof.txt", mimeType: "text/plain", buffer: Buffer.from("phone touch proof") })
      const title = page.getByText("Upload phone-proof.txt to the team inbox?", { exact: true })
      await title.waitFor({ state: "visible" })
      return title.locator("..")
    }
    let uploadReview = await selectPhoneUpload()
    assert.equal(state.counts.get("POST /files/upload") || 0, 0, "phone file selection only stages the team-inbox write")
    assert.match(await uploadReview.innerText(), /Nothing is uploaded until you confirm/i)
    await uploadReview.getByRole("button", { name: "Cancel", exact: true }).tap()
    assert.equal(state.counts.get("POST /files/upload") || 0, 0, "phone upload Cancel sends no request")

    uploadReview = await selectPhoneUpload()
    state.failNextFileUpload = true
    const failedUpload = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/files/upload" && response.status() === 503)
    await uploadReview.getByRole("button", { name: "Confirm upload" }).tap()
    await failedUpload
    assert.equal(state.counts.get("POST /files/upload"), 1)
    await uploadReview.getByRole("alert").waitFor({ state: "visible" })
    assert.match(await uploadReview.getByRole("alert").innerText(), /box team inbox rejected the selected browser-proof file/i)
    assert.equal(await uploadReview.isVisible(), true, "a failed file upload stays staged with its named cause")
    await uploadReview.getByRole("button", { name: "Cancel", exact: true }).tap()

    uploadReview = await selectPhoneUpload()
    state.fileUploadDelayMs = 10_000
    const uploadRequest = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/files/upload")
    const uploadResponse = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/files/upload" && response.status() === 200)
    await touchDoubleTap(page, uploadReview.getByRole("button", { name: "Confirm upload" }))
    await uploadRequest
    const pendingUpload = uploadReview.getByRole("button", { name: "Uploading…" })
    await pendingUpload.waitFor({ state: "visible" })
    assert.equal(state.counts.get("POST /files/upload"), 2, "rapid double upload Confirm sends exactly one additional request")
    assert.equal(await pendingUpload.isDisabled(), true)
    assert.equal(await uploadReview.getByRole("button", { name: "Cancel", exact: true }).isDisabled(), true)
    assert.equal(await page.getByRole("button", { name: "Uploading…" }).first().isDisabled(), true)
    await uploadResponse
    state.fileUploadDelayMs = 0
    await uploadReview.waitFor({ state: "detached" })
    await page.getByText("phone-proof.txt uploaded to the team inbox.", { exact: true }).waitFor({ state: "visible" })
    assert.deepEqual(state.lastFileUpload, { filename: "phone-proof.txt", bytes: Buffer.byteLength("phone touch proof") })
    coverPhone(phoneCoverage, "room:Files:refresh", "refresh button touched")
    coverPhone(phoneCoverage, "room:Files:upload", "selection=POST0; Cancel=0; named failure stayed staged; delayed rapid double Confirm=exactly one; pending controls locked; success visible")
    coverPhone(phoneCoverage, "room:Files:locations", "Team inbox location touched")
    coverPhone(phoneCoverage, "room:Files:file selection", "handoff.md touched")
    const filesVertical = await exerciseVerticalSurface(page, page.locator('[data-work-tab="files"]'), "Files list and preview")
    coverPhone(phoneCoverage, "vertical:file list and preview", filesVertical, filesVertical.outcome)
    await clickSection(page, "Work sections", "Artifacts", true)
    await page.getByText("Complete Journey Proof").waitFor({ state: "visible" })
    await page.locator('[data-work-tab="artifacts"]').getByRole("button", { name: "Refresh" }).tap()
    coverPhone(phoneCoverage, "room:Artifacts:refresh", "refresh touched after live card")
    const artifactOpen = page.getByRole("link", { name: "Open Complete Journey Proof" })
    assert.ok((await artifactOpen.boundingBox())?.height >= 44, "phone Artifact Open keeps a 44px touch target")
    const [artifactPopup] = await Promise.all([context.waitForEvent("page"), artifactOpen.tap()])
    await artifactPopup.waitForURL((url) => url.pathname === "/artifacts/view")
    await artifactPopup.waitForLoadState("domcontentloaded")
    assert.equal(new URL(artifactPopup.url()).pathname, "/artifacts/view")
    assert.equal(await artifactPopup.locator("body").innerText(), "fixture")
    await artifactPopup.close()
    coverPhone(phoneCoverage, "room:Artifacts:open", "touch navigated to canonical artifact response")
    const artifactDownloadLink = page.getByRole("link", { name: "Download Complete Journey Proof" })
    assert.ok((await artifactDownloadLink.boundingBox())?.height >= 44, "phone Artifact Download keeps a 44px touch target")
    const [artifactDownload] = await Promise.all([page.waitForEvent("download"), artifactDownloadLink.tap()])
    assert.match(artifactDownload.suggestedFilename(), /complete-journey/i)
    coverPhone(phoneCoverage, "room:Artifacts:download", "touch produced a browser download")
    const artifactsVertical = await exerciseVerticalSurface(page, page.getByText("Complete Journey Proof"), "Artifacts")
    coverPhone(phoneCoverage, "vertical:artifacts", artifactsVertical, artifactsVertical.outcome)
    await clickSection(page, "Work sections", "Terminal", true)
    await page.getByTitle("AgentHost terminal").waitFor({ state: "visible" })
    await page.getByLabel("Terminal session").tap()
    const terminalSwitchesBefore = state.counts.get("POST /switch") || 0
    const deepseekTerminalSwitch = page.waitForResponse((response) => {
      const request = response.request()
      const url = new URL(request.url())
      return request.method() === "POST" && url.pathname === "/switch" && url.searchParams.get("window") === "deepseek" && response.status() === 200
    })
    await page.getByLabel("Terminal session").selectOption("deepseek")
    await deepseekTerminalSwitch
    assert.equal(state.counts.get("POST /switch"), terminalSwitchesBefore + 1)
    assert.equal(state.requests.filter((request) => request.method === "POST" && request.pathname === "/switch").at(-1)?.search, "?window=deepseek")
    coverPhone(phoneCoverage, "room:Terminal:session selector", "selector touched, DeepSeek selected, exact successful POST /switch?window=deepseek")
    coverPhone(phoneCoverage, "room:Terminal:nested terminal iframe", "visible same-shell iframe observed")
    await clickSection(page, "Work sections", "Reviews", true)
    await page.getByRole("button", { name: /Verify phone touch and scroll/i }).tap()
    await page.getByRole("dialog", { name: taskReview.title }).getByRole("button", { name: "Close", exact: true }).last().tap()
    coverPhone(phoneCoverage, "room:Reviews:review cards", "waiting-review card touched and detail opened")
    await page.getByRole("button", { name: /Keep the whole team attached to the result/i }).tap()
    await page.getByRole("dialog", { name: taskDone.title }).getByRole("button", { name: "Close", exact: true }).last().tap()
    coverPhone(phoneCoverage, "room:Reviews:receipt cards", "completed review receipt touched and detail opened")
    const reviewsVertical = await exerciseVerticalSurface(page, page.locator('[data-work-tab="reviews"]'), "Review lists")
    coverPhone(phoneCoverage, "vertical:review lists", reviewsVertical, reviewsVertical.outcome)

    // Agent controls and capability boundaries are real touch journeys.
    await tapRoom(page, "Agents", true)
    await page.locator('button[aria-label^="DeepSeek,"]:visible').tap()
    const deepseekActive = page.getByRole("switch", { name: "Available for work" })
    await deepseekActive.tap()
    const enableDeepSeek = page.getByRole("dialog", { name: "Enable DeepSeek for work?" })
    assert.match(await enableDeepSeek.innerText(), /eligible queued work.*model spend may resume/is)
    await enableDeepSeek.getByRole("button", { name: "Cancel" }).tap()
    assert.equal(state.counts.get("PUT /api/settings") || 0, 0)
    await deepseekActive.tap()
    await enableDeepSeek.getByRole("button", { name: /Confirm availability/i }).tap()
    assert.equal(state.counts.get("PUT /api/settings"), 1)
    coverPhone(phoneCoverage, "dialog:Enable agent for work?", "DeepSeek Cancel=0 Confirm=1; copy names queued-work eligibility and resumed model spend")
    coverPhone(phoneCoverage, "room:Agents:availability", "DeepSeek availability Cancel=0 Confirm=1")

    await page.locator('button[aria-label^="Cursor,"]:visible').tap()
    coverPhone(phoneCoverage, "room:Agents:roster", "DeepSeek, Cursor, Kimi, and Codex roster cards touched")
    await page.getByRole("button", { name: "Refresh live data", exact: true }).tap()
    coverPhone(phoneCoverage, "room:Agents:refresh", "Refresh live data touched and profiles refetched")
    await page.getByText("Cursor is chat-only and human-directed. It never receives unattended board work.", { exact: true }).waitFor({ state: "visible" })
    assert.equal(await page.getByRole("switch", { name: "Available for work" }).count(), 0, "Cursor exposes no unattended availability toggle at 390px")
    assert.equal(await page.getByRole("dialog", { name: "Enable Cursor for work?" }).count(), 0, "Cursor exposes no unattended availability dialog at 390px")
    const cursorNotApproved = page.locator("article").filter({ hasText: /^(?:Independent board work|Independent review).*NOT_APPROVED\s*Cause:\s*This engine is not approved for this kind of work\.$/s })
    assert.equal(await cursorNotApproved.count(), 2, "Cursor's unavailable unattended and review states each name their cause")
    await cursorNotApproved.first().waitFor({ state: "visible" })
    const cursorChat = page.getByRole("switch", { name: "In team chat" })
    await cursorChat.tap()
    const removeCursorChat = page.getByRole("dialog", { name: "Remove Cursor from team chat?" })
    await removeCursorChat.getByRole("button", { name: "Cancel" }).tap()
    assert.equal(state.counts.get("PUT /api/settings"), 1)
    await cursorChat.tap()
    await removeCursorChat.getByRole("button", { name: "Confirm remove from chat" }).tap()
    assert.equal(state.counts.get("PUT /api/settings"), 2)
    coverPhone(phoneCoverage, "dialog:Remove agent from team chat?", "Cursor Cancel=0 Confirm=1")
    await cursorChat.tap()
    const cursorChatGate = page.getByRole("dialog", { name: "Add Cursor to team chat?" })
    await cursorChatGate.getByRole("button", { name: "Cancel" }).tap()
    assert.equal(state.counts.get("PUT /api/settings"), 2)
    await cursorChat.tap()
    await cursorChatGate.getByRole("button", { name: "Confirm team chat" }).tap()
    assert.equal(state.counts.get("PUT /api/settings"), 3)
    coverPhone(phoneCoverage, "dialog:Add agent to team chat?", "Cursor Cancel=0 Confirm=1")
    coverPhone(phoneCoverage, "room:Agents:chat participation", "Cursor removal Cancel=0 Confirm=1, then add-back Cancel=0 Confirm=1")
    const cursorHeader = page.locator("section").filter({ has: page.getByRole("heading", { name: "Cursor", exact: true }) }).first()
    assert.equal(await cursorHeader.getByRole("button", { name: "Open team thread" }).isEnabled(), true, "Cursor keeps its human-triggered chat action")
    assert.equal(await cursorHeader.getByRole("button", { name: "Open Work terminal" }).isEnabled(), true, "Cursor keeps its human-triggered terminal action")

    await page.locator('button[aria-label^="Kimi,"]:visible').tap()
    const kimiMoonshot = page.getByRole("switch", { name: "Moonshot route enabled" })
    await kimiMoonshot.tap()
    const kimiGate = page.getByRole("dialog", { name: "Enable the Moonshot route for Kimi?" })
    await kimiGate.getByRole("button", { name: "Cancel" }).tap()
    assert.equal(state.counts.get("PUT /api/settings"), 3)
    await kimiMoonshot.tap()
    await kimiGate.getByRole("button", { name: "Confirm Moonshot" }).tap()
    assert.equal(state.counts.get("PUT /api/settings"), 4)
    coverPhone(phoneCoverage, "dialog:Enable the Moonshot route for Kimi?", "Cancel=0 Confirm=1")
    await page.locator('button[aria-label^="Codex,"]:visible').tap()
    const codexHeader = page.locator("section").filter({ has: page.getByRole("heading", { name: "Codex", exact: true }) }).first()
    await codexHeader.getByRole("button", { name: "Open team thread" }).tap()
    const agentThread = page.locator('aside[aria-label="Shared team thread"]:visible')
    await agentThread.waitFor({ state: "visible" })
    coverPhone(phoneCoverage, "room:Agents:open thread", "available Codex action opened attached thread")
    await agentThread.getByRole("button", { name: "Close team thread" }).tap()
    await page.locator('button[aria-label^="DeepSeek,"]:visible').tap()
    const deepseekHeader = page.locator("section").filter({ has: page.getByRole("heading", { name: "DeepSeek", exact: true }) }).first()
    const switchBeforeAgentOpen = state.counts.get("POST /switch") || 0
    const deepseekSwitch = page.waitForResponse((response) => response.request().method() === "POST"
      && new URL(response.url()).pathname === "/switch"
      && new URL(response.url()).searchParams.get("window") === "deepseek"
      && response.status() === 200)
    await deepseekHeader.getByRole("button", { name: "Open Work terminal" }).tap()
    await deepseekSwitch
    await page.locator('[data-work-tab="terminal"]').waitFor({ state: "visible" })
    assert.equal(await page.getByLabel("Terminal session").inputValue(), "deepseek")
    await page.getByText("Terminal is showing DeepSeek.", { exact: true }).waitFor({ state: "visible" })
    assert.equal(state.counts.get("POST /switch"), switchBeforeAgentOpen + 1)
    assert.equal(state.requests.filter((request) => request.method === "POST" && request.pathname === "/switch").at(-1)?.search, "?window=deepseek")

    await tapRoom(page, "Agents", true)
    await page.locator('button[aria-label^="Claude,"]:visible').tap()
    const claudeHeader = page.locator("section").filter({ has: page.getByRole("heading", { name: "Claude", exact: true }) }).first()
    state.failNextTerminalSwitch = true
    const failedSwitchBefore = state.counts.get("POST /switch") || 0
    const failedClaudeSwitch = page.waitForResponse((response) => response.request().method() === "POST"
      && new URL(response.url()).pathname === "/switch"
      && new URL(response.url()).searchParams.get("window") === "claude"
      && response.status() === 503)
    await claudeHeader.getByRole("button", { name: "Open Work terminal" }).tap()
    await failedClaudeSwitch
    await page.getByText("Terminal could not switch — tmux could not select the requested Agent window", { exact: true }).waitFor({ state: "visible" })
    assert.equal(state.counts.get("POST /switch"), failedSwitchBefore + 1)
    assert.notEqual(await page.getByLabel("Terminal session").inputValue(), "claude", "a failed Agent terminal switch does not claim Claude was selected")
    assert.equal(await page.getByText("Terminal is showing Claude.", { exact: true }).count(), 0, "a failed Agent terminal switch exposes no false success toast")

    const manualClaudeToast = page.getByText("Terminal is showing Claude.", { exact: true }).waitFor({ state: "visible" })
    const manualClaudeRetry = page.waitForResponse((response) => response.request().method() === "POST"
      && new URL(response.url()).pathname === "/switch"
      && new URL(response.url()).searchParams.get("window") === "claude"
      && response.status() === 200)
    await page.getByLabel("Terminal session").selectOption("claude")
    const [manualClaudeRetryResponse] = await Promise.all([manualClaudeRetry, manualClaudeToast])
    assert.equal(manualClaudeRetryResponse.status(), 200, "the visible Claude success toast belongs to the exact successful retry response")
    assert.equal(state.counts.get("POST /switch"), failedSwitchBefore + 2, "the failed automatic target and one explicit manual retry are the only Claude switch attempts")
    assert.equal(await page.getByLabel("Terminal session").inputValue(), "claude", "the exact successful manual retry consumes and selects the Claude target")
    assert.equal(state.requests.filter((request) => request.method === "POST" && request.pathname === "/switch").at(-1)?.search, "?window=claude")
    coverPhone(phoneCoverage, "room:Agents:open terminal", "DeepSeek touch posted exact successful ?window=deepseek and selected DeepSeek; named 503 for Claude kept the prior selection; one exact manual ?window=claude retry then succeeded and consumed the target")
    await tapRoom(page, "Agents", true)
    const agentVertical = await exerciseVerticalSurface(page, page.locator('button[aria-label^="Codex,"]:visible'), "Agent profile")
    coverPhone(phoneCoverage, "vertical:agent profile", agentVertical, agentVertical.outcome)

    // Brain cards behave like navigable memory notes on the phone.
    await tapRoom(page, "Brain", true)
    actionPhases.push("Brain opened")
    const map = page.getByLabel(/Interactive memory map/i)
    const laneShortcuts = page.getByLabel("Memory map lane shortcuts")
    const agentLabels = (await laneShortcuts.getByRole("button").allTextContents()).map((label) => label.trim()).filter((label) => label && label !== "Shared")
    assert.deepEqual(agentLabels, ENGINE_ORDER.map((id) => ENGINE_LABELS[id]), "the map exposes the exact permanent roster order")
    const brainLanes = [
      { label: "Shared Core", query: "core", rail: "Browse Shared core memories", key: "Shared Core lobe", index: null },
      ...agentLabels.map((label, index) => ({ label, query: label.toLowerCase(), rail: `Browse ${label}'s lobe memories`, key: `${label} lobe`, index })),
    ]
    const canvasReceipts = []
    for (const lane of brainLanes) {
      await map.waitFor({ state: "visible" })
      await map.evaluate((node) => node.scrollIntoView({ block: "center", inline: "nearest" }))
      const mapBox = await map.boundingBox()
      assert.ok(mapBox)
      const position = projectedBrainLobePoint(mapBox.width, mapBox.height, lane.index, agentLabels.length)
      const receipt = await touchTapPosition(page, map, position)
      assert.match(receipt.hit?.ariaLabel || "", /Interactive memory map/i, `${lane.label} canvas point lands on the actual memory map`)
      await page.waitForURL((url) => url.searchParams.get("lane") === lane.query)
      const laneRail = page.getByRole("region", { name: lane.rail })
      await laneRail.waitFor({ state: "visible" })
      coverPhone(phoneCoverage, `room:Brain:${lane.key}`, { query: lane.query, rail: lane.rail, receipt })
      canvasReceipts.push({ lane: lane.label, query: lane.query, position, hit: receipt.hit })
    }
    coverPhone(phoneCoverage, "room:Brain:map lobes", canvasReceipts)
    actionPhases.push("Brain actual map lobes complete")
    for (const lane of [
      { button: "Shared", query: "core", rail: "Browse Shared core memories", key: "Shared Core shortcut" },
      { button: "Claude", query: "claude", rail: "Browse Claude's lobe memories", key: "Claude shortcut" },
      { button: "Codex", query: "codex", rail: "Browse Codex's lobe memories", key: "Codex shortcut" },
      { button: "DeepSeek", query: "deepseek", rail: "Browse DeepSeek's lobe memories", key: "DeepSeek shortcut" },
      { button: "Kimi", query: "kimi", rail: "Browse Kimi's lobe memories", key: "Kimi shortcut" },
      { button: "Gemini", query: "gemini", rail: "Browse Gemini's lobe memories", key: "Gemini shortcut" },
      { button: "Hermes", query: "hermes", rail: "Browse Hermes's lobe memories", key: "Hermes shortcut" },
      { button: "Cursor", query: "cursor", rail: "Browse Cursor's lobe memories", key: "Cursor shortcut" },
    ]) {
      await laneShortcuts.scrollIntoViewIfNeeded()
      const laneButton = laneShortcuts.getByRole("button", { name: lane.button, exact: true })
      assert.equal(await touchSwipeUntilVisible(page, laneShortcuts, laneButton), true, `${lane.button} Brain lobe shortcut is touch-reachable`)
      const laneBox = await laneButton.boundingBox()
      assert.ok(laneBox && laneBox.width >= 44 && laneBox.height >= 44, `${lane.button} Brain lobe shortcut is at least 44x44; got ${JSON.stringify(laneBox)}`)
      await laneButton.tap()
      await page.waitForURL((url) => url.searchParams.get("lane") === lane.query)
      const laneRail = page.getByRole("region", { name: lane.rail })
      await laneRail.waitFor({ state: "visible" })
      await page.waitForFunction((element) => {
        const rect = element.getBoundingClientRect()
        return rect.bottom > 0 && rect.top < window.innerHeight
      }, await laneRail.elementHandle())
      coverPhone(phoneCoverage, `room:Brain:${lane.key}`, { query: lane.query, rail: lane.rail, touchTarget: laneBox })
    }
    actionPhases.push("Brain lane shortcuts complete")
    await page.getByRole("button", { name: "individual", exact: true }).tap()
    await page.getByRole("button", { name: "all", exact: true }).tap()
    coverPhone(phoneCoverage, "room:Brain:scope", "Individual then All scope controls touched")
    const sharedMemories = page.getByRole("region", { name: "Browse Shared Core memories" })
    await sharedMemories.getByRole("button").first().tap()
    coverPhone(phoneCoverage, "room:Brain:lane cards", "Shared Core memory card touched")
    const memoryDetail = page.getByRole("dialog")
    await memoryDetail.waitFor({ state: "visible" })
    coverPhone(phoneCoverage, "room:Brain:detail", "memory detail opened")
    coverPhone(phoneCoverage, "dialog:Memory detail", "opened from card by touch")
    const related = memoryDetail.locator("section").filter({ hasText: "Connected memories" }).getByRole("button")
    assert.ok(await related.count(), "the required fixture supplies at least one connected memory")
    await related.first().tap()
    coverPhone(phoneCoverage, "room:Brain:linked memories", "connected memory button touched and detail changed")
    await memoryDetail.getByRole("button", { name: "Copy link" }).tap()
    coverPhone(phoneCoverage, "room:Brain:copy link", "Copy link touched")
    await memoryDetail.getByRole("button", { name: "Show in lane" }).tap()
    coverPhone(phoneCoverage, "room:Brain:show in lane", "Show in lane touched and detail closed")
    await sharedMemories.waitFor({ state: "visible" })
    await page.getByRole("button", { name: "Refresh" }).first().tap()
    coverPhone(phoneCoverage, "room:Brain:refresh", "Refresh touched")
    actionPhases.push("Brain detail links and refresh complete")
    await page.getByRole("button", { name: "New memory" }).tap()
    const newMemory = page.getByRole("dialog", { name: "New memory" })
    await newMemory.waitFor({ state: "visible" })
    actionPhases.push("Brain New memory opened")
    const memoryContent = newMemory.getByLabel("memory", { exact: true })
    const memoryContentBox = await memoryContent.boundingBox()
    assert.ok(memoryContentBox && memoryContentBox.width >= 44 && memoryContentBox.height >= 44)
    await memoryContent.fill("Phone-created memory remains attached to the shared team.")
    await exerciseAssist(newMemory, memoryContent, "room:Brain:memory Assist and Undo", "New memory", "memory", { harden: true })
    const memoryTags = newMemory.getByLabel("tags, comma separated", { exact: true })
    const memoryKind = newMemory.getByRole("combobox", { name: "kind", exact: true })
    const memoryScope = newMemory.getByRole("combobox", { name: "scope", exact: true })
    for (const [label, control] of [["tags", memoryTags], ["kind", memoryKind], ["scope", memoryScope]]) {
      const box = await control.boundingBox()
      assert.ok(box && box.width >= 44 && box.height >= 44, `New memory ${label} has a 44x44 phone touch target; got ${JSON.stringify(box)}`)
    }
    await memoryTags.tap()
    await memoryTags.fill("phone, proof")
    await memoryKind.tap()
    await memoryKind.selectOption("procedure")
    await memoryScope.tap()
    await memoryScope.selectOption("shared")
    const modalVertical = await exerciseVerticalSurface(page, memoryContent, "New memory modal body")
    coverPhone(phoneCoverage, "vertical:modal bodies", modalVertical, modalVertical.outcome)
    const saveMemory = newMemory.getByRole("button", { name: "Save memory" })
    assert.ok((await saveMemory.boundingBox())?.height >= 44)
    await saveMemory.tap()
    assert.equal(state.counts.get("POST /brain/api/memories"), 1)
    await newMemory.waitFor({ state: "detached" })
    await sharedMemories.getByRole("button").filter({ hasText: "Phone-created memory remains attached to the shared team." }).waitFor({ state: "visible" })
    actionPhases.push("Brain text memory saved and rendered")

    await page.getByRole("button", { name: "New memory" }).tap()
    const dirtyMemory = page.getByRole("dialog", { name: "New memory" })
    const dirtyMemoryContent = dirtyMemory.getByLabel("memory", { exact: true })
    await dirtyMemoryContent.fill("This draft must never disappear through an accidental close.")
    await dirtyMemory.getByRole("button", { name: "Close", exact: true }).tap()
    const discardMemoryDraft = page.getByRole("dialog", { name: "Discard this memory draft?" })
    await discardMemoryDraft.getByRole("button", { name: "Keep editing" }).tap()
    assert.equal(await dirtyMemory.isVisible(), true, "keeping a dirty memory draft leaves New memory open")
    assert.equal(await dirtyMemoryContent.inputValue(), "This draft must never disappear through an accidental close.")
    await dirtyMemory.getByRole("button", { name: "Close", exact: true }).tap()
    await discardMemoryDraft.getByRole("button", { name: "Discard draft" }).tap()
    await dirtyMemory.waitFor({ state: "detached" })
    coverPhone(phoneCoverage, "dialog:Discard this memory draft?", "dirty Close opened review; Keep editing preserved the draft; second Close + Discard removed only the unsaved draft")

    await page.getByRole("button", { name: "New memory" }).tap()
    const uploadMemory = page.getByRole("dialog", { name: "New memory" })
    const memoryFile = uploadMemory.getByLabel("or add a file", { exact: true })
    const memoryFileBox = await memoryFile.boundingBox()
    assert.ok(memoryFileBox && memoryFileBox.width >= 44 && memoryFileBox.height >= 44, `New memory file chooser has a 44x44 phone touch target; got ${JSON.stringify(memoryFileBox)}`)
    const fileReviewTitle = uploadMemory.getByRole("heading", { name: "Review file memory" })
    const fileReview = fileReviewTitle.locator("..")
    const chooseMemoryFile = async () => {
      const [memoryFileChooser] = await Promise.all([
        page.waitForEvent("filechooser"),
        memoryFile.tap(),
      ])
      await memoryFileChooser.setFiles({ name: "phone-memory.md", mimeType: "text/markdown", buffer: Buffer.from("# Phone memory proof") })
      await fileReviewTitle.waitFor({ state: "visible" })
    }

    await chooseMemoryFile()
    actionPhases.push("Brain file staged for first consequence review")
    assert.equal(state.counts.get("POST /brain/api/ingest") || 0, 0, "choosing a memory file only stages it for consequence review")
    assert.match(await fileReview.innerText(), /Nothing is processed or stored until you confirm.*Cancel sends no request/is)
    await fileReview.getByRole("button", { name: "Cancel", exact: true }).tap()
    assert.equal(state.counts.get("POST /brain/api/ingest") || 0, 0, "cancelling file ingest sends no request")
    await fileReviewTitle.waitFor({ state: "detached" })
    actionPhases.push("Brain file review Cancel=0 complete")

    await chooseMemoryFile()
    state.failNextMemoryIngest = true
    const failedIngestResponse = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/brain/api/ingest" && response.status() === 503)
    await fileReview.getByRole("button", { name: "Confirm file" }).tap()
    await failedIngestResponse
    assert.equal(state.counts.get("POST /brain/api/ingest"), 1)
    const ingestFailure = uploadMemory.getByRole("alert")
    await ingestFailure.waitFor({ state: "visible" })
    assert.match(await ingestFailure.innerText(), /selected memory file could not be read/i, "failed file ingest names its actual cause")
    assert.equal(await uploadMemory.isVisible(), true, "failed file ingest keeps New memory open")
    assert.equal(await fileReviewTitle.isVisible(), true, "failed file ingest remains staged for an explicit retry or cancel")
    await fileReview.getByRole("button", { name: "Cancel", exact: true }).tap()
    actionPhases.push("Brain file failure stayed open with cause")

    await chooseMemoryFile()
    state.memoryIngestDelayMs = 10_000
    const successfulIngestRequest = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/brain/api/ingest")
    const successfulIngestResponse = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/brain/api/ingest")
    await touchDoubleTap(page, fileReview.getByRole("button", { name: "Confirm file" }))
    await successfulIngestRequest
    const processingFile = fileReview.getByRole("button", { name: "Processing..." })
    await processingFile.waitFor({ state: "visible" })
    assert.equal(state.counts.get("POST /brain/api/ingest"), 2, "rapid double Confirm sends exactly one additional ingest request")
    assert.equal(await processingFile.isDisabled(), true)
    assert.equal(await fileReview.getByRole("button", { name: "Cancel", exact: true }).isDisabled(), true)
    assert.equal(await memoryFile.isDisabled(), true)
    assert.equal(await uploadMemory.getByRole("button", { name: "Saving..." }).isDisabled(), true)
    await uploadMemory.getByRole("button", { name: "Close", exact: true }).tap()
    assert.equal(await uploadMemory.isVisible(), true, "New memory cannot dismiss while file ingest is pending")
    const ingestResponse = await successfulIngestResponse
    state.memoryIngestDelayMs = 0
    assert.equal(ingestResponse.status(), 200, "the held file ingest resolves successfully after the consequence lock is released")
    await uploadMemory.waitFor({ state: "detached" })
    await page.getByText("Memory saved.", { exact: true }).waitFor({ state: "visible" })
    actionPhases.push("Brain file ingest exact-one success complete")
    coverPhone(phoneCoverage, "room:Brain:file ingest consequence", "selection=POST0; Cancel=0; named failure stayed open; delayed rapid double Confirm=exactly one; pending controls and Close locked; success visible")
    coverPhone(phoneCoverage, "room:Brain:new memory", "labeled content/tags/kind/scope touched; text Save POST=1 rendered; labeled file chooser reviewed before ingest")
    coverPhone(phoneCoverage, "dialog:New memory", "all labeled form controls; text save; staged file Cancel, failure, pending lock, and exact-one success exercised by touch")
    actionPhases.push("Brain complete")

    // Systems controls include outward messages, autonomy, observed activity,
    // inventory, and every Loop consequence boundary.
    await tapRoom(page, "Systems", true)
    actionPhases.push("Systems opened")
    const systemsRail = page.getByRole("region", { name: "Systems sections" })
    const touchSystemsSection = async (label, tab) => {
      const target = systemsRail.getByRole("button", { name: new RegExp(`^${label}(?:\\s|$)`, "i") })
      assert.equal(await touchSwipeUntilVisible(page, systemsRail, target), true, `${label} is touch-reachable`)
      await touchTapAndWait(
        page,
        target,
        page.locator(`[data-system-tab="${tab}"]`),
        `Systems ${label}`,
      )
    }
    const meshRefresh = page.getByRole("button", { name: "Refresh", exact: true })
    const meshReadsBeforeRefresh = state.counts.get("GET /cc/mesh") || 0
    await Promise.all([
      page.waitForResponse((response) => response.request().method() === "GET" && new URL(response.url()).pathname === "/cc/mesh"),
      meshRefresh.tap(),
    ])
    assert.equal(state.counts.get("GET /cc/mesh"), meshReadsBeforeRefresh + 1)
    coverPhone(phoneCoverage, "room:Mesh:refresh", "Mesh refresh touched and exactly one new GET /cc/mesh observed")
    const meshDraft = page.getByPlaceholder("What should the connected team know?")
    await meshDraft.fill("Phone consequence proof stays attached to the team.")
    coverPhone(phoneCoverage, "room:Mesh:draft", "mesh draft field filled")
    await page.getByRole("button", { name: /Review publish/i }).tap()
    const meshGate = page.getByRole("dialog", { name: "Publish to the mesh team?" })
    await meshGate.getByRole("button", { name: "Cancel" }).tap()
    assert.equal(state.counts.get("POST /cc/mesh/message") || 0, 0)
    await page.getByRole("button", { name: /Review publish/i }).tap()
    await meshGate.getByRole("button", { name: /Publish to mesh/i }).tap()
    assert.equal(state.counts.get("POST /cc/mesh/message"), 1)
    coverPhone(phoneCoverage, "room:Mesh:review publish", "Review publish touched twice; Cancel=0 Confirm=1")
    coverPhone(phoneCoverage, "dialog:Publish to the mesh team?", "Cancel=0 Confirm=1")
    const meshVertical = await exerciseVerticalSurface(page, page.locator('[data-system-tab="mesh"]'), "Mesh")
    coverPhone(phoneCoverage, "vertical:Mesh", meshVertical, meshVertical.outcome)

    await touchSystemsSection("Operations", "operations")
    await page.getByRole("button", { name: /Pause New/i }).tap()
    assert.equal(state.counts.get("POST /autonomy"), 1)
    coverPhone(phoneCoverage, "room:Operations:pause", "Pause New touched; POST /autonomy=1")
    await page.getByRole("button", { name: /Refresh/i }).tap()
    coverPhone(phoneCoverage, "room:Operations:refresh", "Operations refresh touched")
    await page.getByRole("button", { name: /Resume/i }).tap()
    const resumeAutonomy = page.getByRole("alertdialog", { name: "Resume autonomy?" })
    await resumeAutonomy.getByRole("button", { name: "Cancel" }).tap()
    assert.equal(state.counts.get("POST /autonomy"), 1)
    await page.getByRole("button", { name: /Resume/i }).tap()
    await resumeAutonomy.getByRole("button", { name: /Confirm resume/i }).tap()
    assert.equal(state.counts.get("POST /autonomy"), 2)
    coverPhone(phoneCoverage, "room:Operations:resume", "Resume touched twice; Cancel=0 Confirm=1")
    coverPhone(phoneCoverage, "dialog:Resume autonomy?", "Cancel=0 Confirm=1")
    const operationsVertical = await exerciseVerticalSurface(page, page.locator('[data-system-tab="operations"]'), "Operations")
    coverPhone(phoneCoverage, "vertical:Operations", operationsVertical, operationsVertical.outcome)
    actionPhases.push("Systems Mesh and Operations complete")

    await touchSystemsSection("Activity", "activity")
    await page.getByText("frontend_journey_verified", { exact: true }).tap()
    coverPhone(phoneCoverage, "room:Activity:observed event detail", "observed event row touched")
    const auditBefore = state.counts.get("GET /audit/data") || 0
    await Promise.all([
      page.waitForResponse((response) => new URL(response.url()).pathname === "/audit/data"),
      page.getByRole("button", { name: "Refresh activity" }).tap(),
    ])
    assert.equal(state.counts.get("GET /audit/data"), auditBefore + 1)
    coverPhone(phoneCoverage, "room:Activity:refresh", "Refresh activity touched and exactly one new GET observed")
    const activityScroller = await findVerticalScroller(page, "frontend_journey_verified")
    assert.ok(activityScroller)
    const activitySwipe = await touchSwipe(page, activityScroller, { x: 0, y: -360 })
    assert.equal(activitySwipe.moved, true)
    coverPhone(phoneCoverage, "room:Activity:vertical history", activitySwipe)
    actionPhases.push("Systems Activity complete")

    await touchSystemsSection("Inventory", "inventory")
    const inventorySearch = page.getByPlaceholder(/Search skills, plugins, MCPs, and tools/i)
    await inventorySearch.fill("browser")
    await page.getByText("browser-proof").waitFor({ state: "visible" })
    coverPhone(phoneCoverage, "room:Inventory:search", "query filtered to browser-proof")
    for (const filter of ["all", "skills", "plugins", "MCPs", "tools"]) {
      const filterButton = page.getByRole("button", { name: filter, exact: true })
      await filterButton.tap()
      await page.waitForFunction((node) => node.className.includes("bg-accent"), await filterButton.elementHandle())
    }
    coverPhone(phoneCoverage, "room:Inventory:kind filters", "All, Skills, Plugins, MCPs, and Tools each touched")
    await page.getByRole("button", { name: "all", exact: true }).tap()
    await page.getByText("browser-proof").waitFor({ state: "visible" })
    await page.getByRole("button", { name: /Copy/i }).first().tap()
    coverPhone(phoneCoverage, "room:Inventory:copy", "visible result Copy touched")
    await inventorySearch.fill("")
    await page.getByRole("button", { name: "all", exact: true }).tap()
    await page.getByText("browser-proof").waitFor({ state: "visible" })
    const inventoryVertical = await exerciseVerticalSurface(page, page.getByText("browser-proof"), "Inventory results")
    await page.getByRole("button", { name: "Close inventory" }).tap()
    coverPhone(phoneCoverage, "room:Inventory:close", "Close inventory touched and surface closed")
    coverPhone(phoneCoverage, "vertical:Inventory results", inventoryVertical, inventoryVertical.outcome)
    actionPhases.push("Systems Inventory complete")
    await tapRoom(page, "Systems", true)
    await touchSystemsSection("Loops", "loops")

    const loopDeleteButton = page.getByRole("button", { name: "Delete loop Morning Box Brief" })
    const loopDeleteRow = loopDeleteButton.locator("..")
    coverPhone(phoneCoverage, "room:Loops:saved jobs", "live Morning Box Brief schedule rendered")
    await loopDeleteButton.tap()
    const loopWarning = loopDeleteRow.getByText(/schedule, any queued run, and its run history/i)
    await loopWarning.waitFor({ state: "visible" })
    await loopDeleteRow.getByRole("button", { name: "Keep", exact: true }).tap()
    assert.equal(state.counts.get("DELETE /cron/jobs/loop_daily") || 0, 0)
    await loopDeleteButton.tap()
    await loopWarning.waitFor({ state: "visible" })
    state.deleteDelayMs.set("/cron/jobs/loop_daily", 7500)
    const loopDeleteResponse = page.waitForResponse((response) => response.request().method() === "DELETE" && new URL(response.url()).pathname === "/cron/jobs/loop_daily")
    await touchDoubleTap(page, loopDeleteRow.getByRole("button", { name: "Delete", exact: true }))
    await loopDeleteRow.getByRole("button", { name: /Deleting/i }).waitFor({ state: "visible" })
    assert.equal(state.counts.get("DELETE /cron/jobs/loop_daily"), 1)
    assert.equal(await loopDeleteRow.getByRole("button", { name: /Deleting/i }).isDisabled(), true)
    assert.equal(await loopDeleteRow.getByRole("button", { name: "Keep", exact: true }).isDisabled(), true)
    assert.equal(await loopDeleteButton.isDisabled(), true)
    await loopDeleteResponse
    state.deleteDelayMs.delete("/cron/jobs/loop_daily")
    assert.equal(state.counts.get("DELETE /cron/jobs/loop_daily"), 1)
    const loopDeletedToast = page.locator("div.fixed").filter({ hasText: /^"Morning Box Brief" deleted — it will not run again\.$/ })
    await loopDeletedToast.waitFor({ state: "visible" })
    await loopDeletedToast.waitFor({ state: "detached", timeout: 5000 })
    coverPhone(phoneCoverage, "room:Loops:delete", "Keep=0; rapid double real-touch Confirm=exactly one; pending controls locked")

    await page.getByRole("button", { name: /Morning Box Brief/i }).last().tap()
    coverPhone(phoneCoverage, "room:Loops:starters", "Development recipe touched and form filled")
    await page.getByRole("button", { name: "Weekdays", exact: true }).tap()
    coverPhone(phoneCoverage, "room:Loops:cadence", "Weekdays cadence touched")
    const loopPrompt = page.getByLabel("Loop prompt")
    await loopPrompt.tap()
    await loopPrompt.fill("Phone loop prompt proof")
    coverPhone(phoneCoverage, "room:Loops:prompt", "Loop prompt touched and edited")
    const loopForm = page.getByRole("button", { name: "add loop" }).locator("..")
    await exerciseAssist(loopForm, loopPrompt, "room:Loops:prompt Assist and Undo", "Loop prompt", "card")
    await page.getByRole("button", { name: "add loop" }).tap()
    const loopSchedule = page.getByRole("dialog", { name: "Schedule this Loop?" })
    await loopSchedule.getByRole("button", { name: "Cancel" }).tap()
    assert.equal(state.counts.get("POST /cron/jobs") || 0, 0)
    await page.getByRole("button", { name: "add loop" }).tap()
    await loopSchedule.getByRole("button", { name: "Confirm schedule" }).tap()
    assert.equal(state.counts.get("POST /cron/jobs"), 1)
    coverPhone(phoneCoverage, "room:Loops:schedule", "Cancel=0 Confirm=1")
    const approvalKey = `POST /cron/runs/${encodeURIComponent(LOOP_APPROVAL_RUN_ID)}/approve`
    await page.getByRole("button", { name: "Approve once" }).first().tap()
    const approvalGate = page.getByRole("dialog", { name: "Approve this Loop run once?" })
    await approvalGate.getByRole("button", { name: "Cancel" }).tap()
    assert.equal(state.counts.get(approvalKey) || 0, 0)
    await page.getByRole("button", { name: "Approve once" }).first().tap()
    await approvalGate.getByRole("button", { name: "Approve once" }).tap()
    assert.equal(state.counts.get(approvalKey), 1)
    assert.deepEqual(state.lastLoopApprovalBody, { decision: "approve_once", fingerprint: LOOP_APPROVAL_FINGERPRINT })
    coverPhone(phoneCoverage, "room:Loops:single-run approval", "Cancel=0 Confirm=1 with exact fingerprint")
    coverPhone(phoneCoverage, "room:Loops:history", "gated history row reached and exact approval action touched")
    coverPhone(phoneCoverage, "dialog:Schedule this Loop?", "Cancel=0 Confirm=1")
    coverPhone(phoneCoverage, "dialog:Approve this Loop run once?", "Cancel=0 Confirm=1 exact fingerprint")
    actionPhases.push("Systems single Loops complete")

    const multiJob = page.locator("article").filter({ has: page.getByRole("heading", { name: "Release team", exact: true }) })
    const multiDelete = multiJob.getByRole("button", { name: "Delete", exact: true })
    await multiDelete.tap()
    const multiWarning = multiJob.getByRole("alert")
    await multiWarning.waitFor({ state: "visible" })
    assert.match(await multiWarning.innerText(), /schedule, any queued run, and its run-history directory/i)
    await multiJob.getByRole("button", { name: "Keep it" }).tap()
    assert.equal(state.counts.get("DELETE /cron/multi/jobs/multi_release") || 0, 0)
    await multiDelete.tap()
    await multiWarning.waitFor({ state: "visible" })
    state.deleteDelayMs.set("/cron/multi/jobs/multi_release", 7500)
    const multiDeleteResponse = page.waitForResponse((response) => response.request().method() === "DELETE" && new URL(response.url()).pathname === "/cron/multi/jobs/multi_release")
    await touchDoubleTap(page, multiJob.getByRole("button", { name: "Confirm delete" }))
    await multiJob.getByRole("button", { name: /Deleting/i }).waitFor({ state: "visible" })
    assert.equal(state.counts.get("DELETE /cron/multi/jobs/multi_release"), 1)
    assert.equal(await multiJob.getByRole("button", { name: /Deleting/i }).isDisabled(), true)
    assert.equal(await multiJob.getByRole("button", { name: "Keep it" }).isDisabled(), true)
    await multiDeleteResponse
    state.deleteDelayMs.delete("/cron/multi/jobs/multi_release")
    assert.equal(state.counts.get("DELETE /cron/multi/jobs/multi_release"), 1)
    coverPhone(phoneCoverage, "room:MultiLoops:delete", "Keep=0; rapid double real-touch Confirm=exactly one; pending controls locked")
    const multiStarter = page.getByRole("region", { name: "Multi-Loop starters" }).getByRole("button").first()
    await multiStarter.tap()
    coverPhone(phoneCoverage, "room:MultiLoops:starters", "starter card touched")
    const readiness = page.getByLabel("Multi-Loop engine readiness")
    assert.match(await readiness.innerText(), /Claude.*Codex.*Hermes/s)
    coverPhone(phoneCoverage, "room:MultiLoops:engine readiness", "live readiness region observed before scheduling", "observed-noninteractive")
    await page.getByLabel("Cadence").tap()
    await page.getByLabel("Cadence").selectOption("weekdays")
    await page.getByLabel("Stage 1 engine").tap()
    await page.getByLabel("Stage 1 engine").selectOption("hermes")
    await page.getByLabel("Stage 1 handoff instruction").tap()
    await page.getByLabel("Stage 1 handoff instruction").fill("Build from the phone-owned objective.")
    coverPhone(phoneCoverage, "room:MultiLoops:team form", "cadence, stage engine, and instruction touched and edited")
    coverPhone(phoneCoverage, "room:MultiLoops:stages", "Stage 1 engine and handoff touched")
    await page.getByRole("button", { name: "Schedule multi-loop" }).tap()
    const multiSchedule = page.getByRole("dialog", { name: "Schedule this Multi-Loop?" })
    await multiSchedule.getByRole("button", { name: "Cancel" }).tap()
    assert.equal(state.counts.get("POST /cron/multi/jobs") || 0, 0)
    await page.getByRole("button", { name: "Schedule multi-loop" }).tap()
    await multiSchedule.getByRole("button", { name: "Confirm schedule" }).tap()
    assert.equal(state.counts.get("POST /cron/multi/jobs"), 1)
    coverPhone(phoneCoverage, "room:MultiLoops:schedule", "Cancel=0 Confirm=1")
    await multiJob.getByRole("button", { name: "History", exact: true }).tap()
    await multiJob.getByText("completed", { exact: true }).first().waitFor({ state: "visible" })
    coverPhone(phoneCoverage, "room:MultiLoops:history", "History touched and completed stages rendered")
    coverPhone(phoneCoverage, "dialog:Schedule this Multi-Loop?", "Cancel=0 Confirm=1")
    actionPhases.push("Systems Multi-Loops complete")

    // All eleven Settings sections are touch-reachable. Consequential writes
    // prove Cancel=0, one failed Confirm that stays open, then one retry.
    const settings = page.getByRole("dialog", { name: "Settings" })
    await touchTapAndWait(page, page.getByRole("button", { name: "Open settings" }), settings, "phone Settings controls")
    actionPhases.push("Settings opened")
    const settingsRail = settings.getByRole("region", { name: "Settings sections" })
    for (const section of ["Mode", "LLM Roster", "Box Services", "Channels", "Cost & Budget", "Schedule", "Board", "Git Ladder", "Security", "Agent Reporting", "About"]) {
      const button = settingsRail.getByRole("button", { name: new RegExp(`^${section}(?:\\s|$)`, "i") })
      assert.equal(await touchSwipeUntilVisible(page, settingsRail, button), true, `${section} Settings tab is touch-reachable`)
      const sectionBox = await button.boundingBox()
      assert.ok(sectionBox && sectionBox.width >= 44 && sectionBox.height >= 44, `${section} Settings tab is at least 44x44; got ${JSON.stringify(sectionBox)}`)
      await button.tap()
      await settings.getByRole("heading", { name: section, exact: true }).waitFor({ state: "visible" })
    }
    coverPhone(phoneCoverage, "room:Settings:eleven sections", "all eleven named section buttons touched and each heading observed")
    actionPhases.push("Settings section rail complete")

    const coverSetting = (name, evidence) => coverPhone(phoneCoverage, `room:Settings:${name}`, evidence)
    const toggleSetting = async (name, locator) => coverSetting(name, await touchToggleAndRestore(locator, name))
    const fieldSetting = async (name, locator, nextValue) => coverSetting(name, await touchFieldAndRestore(locator, nextValue, name))
    const selectSetting = async (name, locator, nextValue) => coverSetting(name, await touchSelectAndRestore(locator, nextValue, name))

    await settingsRail.getByRole("button", { name: /^LLM Roster/i }).tap()
    for (const engine of ["Claude", "Codex", "DeepSeek", "Kimi", "Gemini", "Hermes"]) {
      await toggleSetting(`${engine} active`, settings.getByRole("switch", { name: `${engine} active`, exact: true }))
      await toggleSetting(`${engine} in chat`, settings.getByRole("switch", { name: `${engine} in chat`, exact: true }))
    }
    assert.equal(await settings.getByRole("switch", { name: "Cursor active", exact: true }).count(), 0, "Cursor remains chat-only at 390px")
    coverSetting("Cursor active", "not exposed: Cursor is chat-only and human-directed")
    await toggleSetting("Cursor in chat", settings.getByRole("switch", { name: "Cursor in chat", exact: true }))
    const deepseekSettings = settings.locator("section").filter({ hasText: "DeepSeek profile" }).first()
    await fieldSetting("DeepSeek Role", deepseekSettings.getByLabel("Role", { exact: true }), "browser-proof")
    await fieldSetting("DeepSeek Per-run limit", deepseekSettings.getByLabel(/^Per-run limit\s*\$$/), "3")
    await fieldSetting("DeepSeek Daily limit", deepseekSettings.getByLabel(/^Daily limit\s*\$$/), "11")
    const kimiSettings = settings.locator("section").filter({ hasText: "Kimi profile" }).first()
    await fieldSetting("Kimi Role", kimiSettings.getByLabel("Role", { exact: true }), "browser-proof")
    await fieldSetting("Kimi Per-run limit", kimiSettings.getByLabel(/^Per-run limit\s*\$$/), "3")
    await fieldSetting("Kimi Daily limit", kimiSettings.getByLabel(/^Daily limit\s*\$$/), "11")

    await settingsRail.getByRole("button", { name: /^Box Services/i }).tap()
    await toggleSetting("Ollama", settings.getByRole("switch", { name: "Ollama", exact: true }))
    await toggleSetting("OpenClaw", settings.getByRole("switch", { name: "OpenClaw", exact: true }))
    await toggleSetting("Moonshot (Kimi)", settings.getByRole("switch", { name: "Moonshot (Kimi)", exact: true }))

    await settingsRail.getByRole("button", { name: /^Channels/i }).tap()
    for (const channel of ["Telegram", "Discord"]) {
      const card = settings.getByRole("heading", { name: channel, exact: true }).locator("..")
      for (const control of ["Enabled", "Ask before consequential actions", "Board reporter"]) {
        await toggleSetting(`${channel} ${control}`, card.getByRole("switch", { name: control, exact: true }))
      }
    }

    await settingsRail.getByRole("button", { name: /^Cost & Budget/i }).tap()
    await toggleSetting("Cost limits", settings.getByRole("switch", { name: "Cost limits", exact: true }))
    await fieldSetting("Budget per chain", settings.getByLabel(/^Budget per chain\s*\$$/), "21")
    await fieldSetting("Chat daily dollars", settings.getByLabel(/^Chat daily dollars\s*\$$/), "101")
    await fieldSetting("Chat daily tokens", settings.getByLabel("Chat daily tokens", { exact: true }), "2100000")

    await settingsRail.getByRole("button", { name: /^Schedule/i }).tap()
    const sleepSchedule = settings.getByRole("switch", { name: "Sleep schedule", exact: true })
    const sleepBefore = await sleepSchedule.getAttribute("aria-checked")
    assert.equal(sleepBefore, "false")
    await sleepSchedule.tap()
    await settings.getByLabel("Starts", { exact: true }).waitFor({ state: "visible" })
    assert.equal(await settings.getByLabel("Starts", { exact: true }).isEnabled(), true)
    await fieldSetting("Starts", settings.getByLabel("Starts", { exact: true }), "22:30")
    await fieldSetting("Ends", settings.getByLabel("Ends", { exact: true }), "07:30")
    await sleepSchedule.tap()
    assert.equal(await sleepSchedule.getAttribute("aria-checked"), "false")
    coverSetting("Sleep schedule", { before: sleepBefore, changed: "true", restored: "false" })

    await settingsRail.getByRole("button", { name: /^Board/i }).tap()
    await toggleSetting("Auto-dispatch", settings.getByRole("switch", { name: "Auto-dispatch", exact: true }))
    await toggleSetting("Stuck card alerts", settings.getByRole("switch", { name: "Stuck card alerts", exact: true }))

    await settingsRail.getByRole("button", { name: /^Git Ladder/i }).tap()
    await selectSetting("Autonomy level", settings.getByText("Autonomy level", { exact: true }).locator("..").getByRole("combobox"), "3")
    await selectSetting("Review strictness", settings.getByText("Review strictness", { exact: true }).locator("..").getByRole("combobox"), "5")
    await toggleSetting("Auto-commit", settings.getByRole("switch", { name: "Auto-commit", exact: true }))

    await settingsRail.getByRole("button", { name: /^Agent Reporting/i }).tap()
    await selectSetting("Heartbeat frequency", settings.getByText("Heartbeat frequency", { exact: true }).locator("..").getByRole("combobox"), "step")

    await settingsRail.getByRole("button", { name: /^About/i }).tap()
    const agentGlassLink = settings.getByRole("link", { name: /AgentGlass by David Pallares/i })
    const agentGlassBox = await agentGlassLink.boundingBox()
    assert.ok(agentGlassBox && agentGlassBox.width >= 44 && agentGlassBox.height >= 44, `About AgentGlass link has a 44x44 phone touch target; got ${JSON.stringify(agentGlassBox)}`)
    const [agentGlassPopup] = await Promise.all([context.waitForEvent("page"), agentGlassLink.tap()])
    await agentGlassPopup.waitForURL("https://github.com/SirAllap/agentglass")
    await agentGlassPopup.waitForLoadState("domcontentloaded")
    assert.equal(agentGlassPopup.url(), "https://github.com/SirAllap/agentglass")
    assert.equal(await agentGlassPopup.getByText("AgentGlass source").innerText(), "AgentGlass source")
    await agentGlassPopup.close()
    coverSetting("About AgentGlass link", "external source link touched; popup URL and body observed")

    await settingsRail.getByRole("button", { name: /^Mode/i }).tap()
    const modeWritesBeforeCards = state.counts.get("POST /api/mode") || 0
    await settings.getByRole("button", { name: "DEV MODE" }).tap()
    assert.equal(state.counts.get("POST /api/mode") || 0, modeWritesBeforeCards, "touching the already-selected Dev card does not restart the box")
    await settings.getByRole("button", { name: "GROWTH MODE" }).tap()
    const settingsModeGate = page.getByRole("dialog", { name: "Switch to Growth Mode?" })
    await settingsModeGate.getByText("Nothing changes until you confirm. Cancel keeps Settings open and preserves every unsaved edit. Confirming closes Settings and discards those unsaved edits before the restart begins.", { exact: true }).waitFor({ state: "visible" })
    await settingsModeGate.getByRole("button", { name: "Cancel" }).tap()
    assert.equal(await settings.isVisible(), true, "canceling a Settings mode review returns to the exact mounted Settings draft")
    assert.equal(state.counts.get("POST /api/mode") || 0, 0)
    coverPhone(phoneCoverage, "room:Settings:mode cards", "DEV MODE touched with no restart; GROWTH MODE touched; Cancel=0")
    await settingsRail.getByRole("button", { name: /^Cost & Budget/i }).tap()
    await settings.getByRole("switch", { name: "Cost limits" }).tap()
    await settings.getByRole("button", { name: "Close", exact: true }).last().tap()
    const discardSettings = page.getByRole("dialog", { name: "Discard unsaved settings changes?" })
    await discardSettings.getByRole("button", { name: "Keep editing" }).tap()
    assert.equal(await settings.isVisible(), true)
    await settings.getByRole("button", { name: "Close", exact: true }).last().tap()
    await discardSettings.getByRole("button", { name: "Discard changes" }).tap()
    await touchTapAndWait(page, page.getByRole("button", { name: "Open settings" }), settings, "reopen phone Settings")
    coverPhone(phoneCoverage, "dialog:Discard unsaved settings changes?", "Keep editing and Discard touched")

    await settingsRail.getByRole("button", { name: /^Cost & Budget/i }).tap()
    await settings.getByRole("button", { name: "Use defaults" }).tap()
    const defaultsGate = page.getByRole("dialog", { name: "Use defaults for Cost & Budget?" })
    await defaultsGate.getByRole("button", { name: "Cancel" }).tap()
    assert.equal(state.counts.get("POST /api/settings/reset") || 0, 0)
    await settings.getByRole("button", { name: "Use defaults" }).tap()
    await defaultsGate.getByRole("button", { name: "Confirm defaults" }).tap()
    assert.equal(state.counts.get("POST /api/settings/reset"), 1)
    coverPhone(phoneCoverage, "room:Settings:use defaults", "Use defaults touched twice; Cancel=0 Confirm=1")
    coverPhone(phoneCoverage, "dialog:Use defaults for section?", "Cost & Budget Cancel=0 Confirm=1")
    actionPhases.push("Settings fields, toggles, mode cards, and defaults complete")

    await settingsRail.getByRole("button", { name: /^Security/i }).tap()
    const twoFactorAccessKey = settings.getByLabel("Confirm box access key")
    const accessKeyBox = await twoFactorAccessKey.boundingBox()
    assert.ok(accessKeyBox && accessKeyBox.width >= 44 && accessKeyBox.height >= 44, `2FA access-key field is at least 44x44; got ${JSON.stringify(accessKeyBox)}`)
    await twoFactorAccessKey.tap()
    await twoFactorAccessKey.fill("box-access-proof")
    coverSetting("2FA access key", { touchTarget: accessKeyBox, valueLength: "box-access-proof".length })
    const startEnrollment = settings.getByRole("button", { name: "Start 2FA enrollment" })
    const startEnrollmentBox = await startEnrollment.boundingBox()
    assert.ok(startEnrollmentBox && startEnrollmentBox.width >= 44 && startEnrollmentBox.height >= 44)
    await startEnrollment.tap()
    coverSetting("Start 2FA enrollment", { touchTarget: startEnrollmentBox })
    assert.equal(state.counts.get("POST /2fa/enroll"), 1)
    assert.deepEqual(state.lastTwoFactorEnrollBody, { key: "box-access-proof" })
    assert.equal(await settings.getByLabel("Authenticator secret").innerText(), "JBSWY3DPEHPK3PXP")
    assert.match(await settings.getByLabel("Authenticator otpauth URL").innerText(), /^otpauth:/)
    const activationCode = settings.getByLabel("Current 6-digit code")
    const activationCodeBox = await activationCode.boundingBox()
    assert.ok(activationCodeBox && activationCodeBox.width >= 44 && activationCodeBox.height >= 44)
    await activationCode.tap()
    await activationCode.fill("123456")
    coverSetting("2FA activation code", { touchTarget: activationCodeBox, digits: 6 })
    const activateTwoFactor = settings.getByRole("button", { name: "Review activation" })
    const activateBox = await activateTwoFactor.boundingBox()
    assert.ok(activateBox && activateBox.width >= 44 && activateBox.height >= 44)
    await activateTwoFactor.tap()
    const activationGate = page.getByRole("dialog", { name: "Activate two-factor authentication?" })
    await activationGate.waitFor({ state: "visible" })
    assert.match(await activationGate.innerText(), /revokes every current box session.*Future logins require the box access key and a current authenticator code/is)
    await activationGate.getByRole("button", { name: "Cancel" }).tap()
    assert.equal(state.counts.get("POST /2fa/confirm") || 0, 0)
    await activateTwoFactor.tap()
    state.twoFactorConfirmDelayMs = 10_000
    const activationRequest = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/2fa/confirm")
    const activationResponse = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/2fa/confirm")
    const confirmActivation = activationGate.getByRole("button", { name: "Confirm and activate" })
    await touchDoubleTap(page, confirmActivation)
    await activationRequest
    await page.waitForFunction((node) => node.disabled, await confirmActivation.elementHandle())
    assert.equal(state.counts.get("POST /2fa/confirm"), 1, "rapid double activation Confirm sends exactly one request")
    assert.equal(await activationGate.getByRole("button", { name: "Cancel" }).isDisabled(), true)
    await activationGate.getByRole("button", { name: "Close", exact: true }).tap()
    assert.equal(await activationGate.isVisible(), true, "2FA activation cannot dismiss while session revocation is pending")
    await activationResponse
    state.twoFactorConfirmDelayMs = 0
    coverSetting("Review 2FA activation", { touchTarget: activateBox, consequence: "Cancel=0; delayed rapid double Confirm=1; pending dismiss locked" })
    coverPhone(phoneCoverage, "dialog:Activate two-factor authentication?", "copy names current-session revocation and future key+code login; Cancel=0; rapid double Confirm=1; pending dismiss locked")
    await settings.getByText("second factor on", { exact: true }).waitFor({ state: "visible" })
    const disableCode = settings.getByLabel("Current 6-digit code")
    const disableCodeBox = await disableCode.boundingBox()
    assert.ok(disableCodeBox && disableCodeBox.width >= 44 && disableCodeBox.height >= 44)
    await disableCode.tap()
    await disableCode.fill("654321")
    coverSetting("2FA disable code", { touchTarget: disableCodeBox, digits: 6 })
    const turnOffTwoFactor = settings.getByRole("button", { name: "Turn off 2FA" })
    const turnOffBox = await turnOffTwoFactor.boundingBox()
    assert.ok(turnOffBox && turnOffBox.width >= 44 && turnOffBox.height >= 44)
    await turnOffTwoFactor.tap()
    coverSetting("Turn off 2FA", { touchTarget: turnOffBox })
    const disableGate = page.getByRole("dialog", { name: "Turn off two-factor authentication?" })
    await disableGate.getByRole("button", { name: "Cancel" }).tap()
    assert.equal(state.counts.get("POST /2fa/disable") || 0, 0)
    await turnOffTwoFactor.tap()
    state.failNextTwoFactorDisable = true
    await disableGate.getByRole("button", { name: "Confirm and turn off" }).tap()
    assert.equal(state.counts.get("POST /2fa/disable"), 1)
    await disableGate.getByRole("alert").waitFor({ state: "visible" })
    assert.equal(await disableGate.isVisible(), true)
    await disableGate.getByRole("button", { name: "Confirm and turn off" }).tap()
    assert.equal(state.counts.get("POST /2fa/disable"), 2)
    await settings.getByText("second factor off", { exact: true }).waitFor({ state: "visible" })
    coverPhone(phoneCoverage, "room:Settings:Security / 2FA", { accessKeyTouchTarget: accessKeyBox, enrollBody: state.lastTwoFactorEnrollBody, activationBody: state.lastTwoFactorConfirmBody, disableBody: state.lastTwoFactorDisableBody, result: "enroll; activation consequence Cancel=0 and rapid double Confirm=1; disable Cancel=0, failure stays open, retry=1" })
    coverPhone(phoneCoverage, "dialog:Turn off two-factor authentication?", "typed code, Cancel=0, failure stays open, retry=1")
    actionPhases.push("Settings 2FA complete")

    await settingsRail.getByRole("button", { name: /^Box Services/i }).tap()
    await settings.getByRole("button", { name: "Test connection" }).tap()
    const paidTest = page.getByRole("dialog", { name: "Run a paid Moonshot connection test?" })
    await paidTest.getByRole("button", { name: "Cancel" }).tap()
    assert.equal(state.counts.get("POST /api/continuity/providers/moonshot/test") || 0, 0)
    await settings.getByRole("button", { name: "Test connection" }).tap()
    await paidTest.getByRole("button", { name: "Confirm and run test" }).tap()
    assert.equal(state.counts.get("POST /api/continuity/providers/moonshot/test"), 1)
    coverPhone(phoneCoverage, "room:Settings:Moonshot test", "paid test Cancel=0 Confirm=1")
    coverPhone(phoneCoverage, "dialog:Run a paid Moonshot connection test?", "Cancel=0 Confirm=1")

    await settingsRail.getByRole("button", { name: /^Cost & Budget/i }).tap()
    await settings.getByRole("switch", { name: "Cost limits" }).tap()
    const writesBeforeSave = state.counts.get("PUT /api/settings") || 0
    await settings.getByRole("button", { name: "Save settings" }).tap()
    const saveGate = page.getByRole("dialog", { name: "Review consequential settings changes" })
    await saveGate.getByRole("button", { name: "Cancel" }).tap()
    assert.equal(state.counts.get("PUT /api/settings"), writesBeforeSave)
    await settings.getByRole("button", { name: "Save settings" }).tap()
    state.failNextSettingsSave = true
    await saveGate.getByRole("button", { name: "Confirm and save" }).tap()
    assert.equal(state.counts.get("PUT /api/settings"), writesBeforeSave + 1)
    await saveGate.getByRole("alert").waitFor({ state: "visible" })
    assert.equal(await saveGate.isVisible(), true)
    assert.match(await saveGate.getByRole("alert").innerText(), /Settings were not saved.*box rejected/i)
    await saveGate.getByRole("button", { name: "Confirm and save" }).tap()
    assert.equal(state.counts.get("PUT /api/settings"), writesBeforeSave + 2)
    await settings.getByText("All settings saved").waitFor({ state: "visible" })
    coverPhone(phoneCoverage, "room:Settings:save", "Cancel=0; rejected Confirm remains open with cause; retry=1")
    coverPhone(phoneCoverage, "dialog:Review consequential settings changes", "Cancel=0, failed Confirm stays open with cause, retry=1")
    await settings.getByRole("button", { name: "Close", exact: true }).last().tap()
    actionPhases.push("Settings consequence saves complete")

    // Compact global actions remain reachable without leaving the shell.
    await page.getByRole("button", { name: "More actions" }).tap()
    actionPhases.push("Global compact actions starting")
    const moreActions = page.locator('section[aria-label="More actions"]')
    await moreActions.getByRole("button", { name: "Switch box" }).tap()
    const switchBox = page.getByRole("dialog", { name: "Switch box" })
    await switchBox.waitFor({ state: "visible" })
    coverPhone(phoneCoverage, "global:switch box", "phone more-actions touch")
    coverPhone(phoneCoverage, "dialog:Switch box", "opened with touch")
    const currentBox = switchBox.getByRole("button", { name: /127\.0\.0\.1.*Here/i })
    assert.equal(await currentBox.isDisabled(), true, "the current box destination cannot reload itself")
    await page.evaluate(() => window.history.replaceState({}, "", `${window.location.pathname}?proof=phone`))
    await Promise.all([
      page.waitForURL("https://peer-box.example/?proof=phone"),
      switchBox.getByRole("button", { name: /peer-box\.example/i }).tap(),
    ])
    assert.equal(page.url(), "https://peer-box.example/?proof=phone", "the second box opens its canonical root and preserves the original query")
    assert.equal(new URL(page.url()).pathname, "/")
    assert.equal(page.url().includes("/desk"), false)
    coverPhone(phoneCoverage, "global:switch box destination", "current box disabled; peer touched; canonical root preserved ?proof=phone; zero /desk")
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" })
    await neutralizeDevToolbar(page)
    await primaryNav(page).waitFor({ state: "visible" })
    await page.getByText(taskObjective.title).first().waitFor({ state: "visible" })
    await page.getByRole("button", { name: "More actions" }).tap()
    await moreActions.getByRole("button", { name: "Switch box" }).tap()
    await switchBox.waitFor({ state: "visible" })
    await switchBox.getByRole("button", { name: "Close", exact: true }).last().tap()
    await switchBox.waitFor({ state: "detached" })
    await page.getByRole("button", { name: "More actions" }).tap()
    await moreActions.getByRole("button", { name: "New task" }).tap()
    const createTask = page.getByRole("dialog", { name: "Create task" })
    await createTask.getByPlaceholder(/Fix the mobile nav overlap/i).fill("Phone draft consequence proof")
    const taskDetails = createTask.locator("textarea")
    await taskDetails.fill("Keep every phone journey attached to exact browser evidence.")
    await exerciseAssist(createTask, taskDetails, "global:task draft Assist and Undo", "task details", "card")
    await createTask.getByRole("button", { name: "Cancel" }).tap()
    const discardDraft = page.getByRole("dialog", { name: "Discard this task draft?" })
    await discardDraft.getByRole("button", { name: "Keep editing" }).tap()
    await createTask.getByRole("button", { name: "Cancel" }).tap()
    await discardDraft.getByRole("button", { name: "Discard draft" }).tap()
    coverPhone(phoneCoverage, "global:new task", "opened through phone more-actions")
    coverPhone(phoneCoverage, "dialog:Create task", "draft filled")
    coverPhone(phoneCoverage, "dialog:Discard this task draft?", "Keep editing and Discard touched")
    actionPhases.push("Global switch-box and new-task actions complete")

    // Both views of the same shared thread review a stop before cancelling work.
    const chatCancelCount = () => [...state.counts.entries()].filter(([key]) => /^POST \/chat\/runs\/[^/]+\/cancel$/.test(key)).reduce((sum, [, value]) => sum + value, 0)
    const exerciseStopReview = async (stopButton, coverageKey, surfaceLabel) => {
      const before = chatCancelCount()
      const stopButtonBox = await stopButton.boundingBox()
      assert.ok(stopButtonBox && stopButtonBox.width >= 44 && stopButtonBox.height >= 44, `${surfaceLabel} Stop is at least 44x44; got ${JSON.stringify(stopButtonBox)}`)
      await stopButton.tap()
      const stopReview = page.getByRole("dialog", { name: "Stop this agent run?" })
      await stopReview.waitFor({ state: "visible" })
      assert.match(await stopReview.innerText(), /partial response.*can be lost.*Nothing stops until you confirm/is)
      await stopReview.getByRole("button", { name: "Keep running" }).tap()
      assert.equal(chatCancelCount(), before, `${surfaceLabel} Keep running sends zero cancellation requests`)

      await stopButton.tap()
      state.failNextChatCancel = true
      const failedCancel = page.waitForResponse((response) => response.request().method() === "POST" && /^\/chat\/runs\/[^/]+\/cancel$/.test(new URL(response.url()).pathname) && response.status() === 503)
      await stopReview.getByRole("button", { name: "Confirm stop" }).tap()
      await failedCancel
      assert.equal(chatCancelCount(), before + 1, `${surfaceLabel} failed Confirm sends exactly one cancellation request`)
      await stopReview.getByRole("alert").waitFor({ state: "visible" })
      assert.match(await stopReview.getByRole("alert").innerText(), /box rejected cancellation.*selected agent run/i)
      assert.equal(await stopReview.isVisible(), true, `${surfaceLabel} failed stop stays open with the box cause`)
      await stopReview.getByRole("button", { name: "Keep running" }).tap()

      await stopButton.tap()
      const successBaseline = chatCancelCount()
      state.chatCancelDelayMs = 10_000
      const successfulCancel = page.waitForResponse((response) => response.request().method() === "POST" && /^\/chat\/runs\/[^/]+\/cancel$/.test(new URL(response.url()).pathname) && response.status() === 200)
      await touchDoubleTap(page, stopReview.getByRole("button", { name: "Confirm stop" }))
      const stopping = stopReview.getByRole("button", { name: "Stopping…" })
      await stopping.waitFor({ state: "visible" })
      assert.equal(chatCancelCount(), successBaseline + 1, `${surfaceLabel} rapid double Confirm sends exactly one cancellation request`)
      assert.equal(await stopping.isDisabled(), true)
      assert.equal(await stopReview.getByRole("button", { name: "Keep running" }).isDisabled(), true)
      await stopReview.getByRole("button", { name: "Close", exact: true }).tap()
      assert.equal(await stopReview.isVisible(), true, `${surfaceLabel} stop review cannot dismiss while cancellation is pending`)
      await successfulCancel
      state.chatCancelDelayMs = 0
      await stopReview.waitFor({ state: "detached" })
      assert.equal(chatCancelCount(), successBaseline + 1, `${surfaceLabel} completed stop remains exactly one successful request`)
      coverPhone(phoneCoverage, coverageKey, "Keep running=0; named failure stayed open; delayed rapid double Confirm=1; pending controls and Close locked")
    }

    // The attached rail sends, routes, expands, stops a live run, and closes.
    state.holdChatStream = true
    await page.getByRole("button", { name: "Open team thread" }).tap()
    const thread = page.locator('aside[aria-label="Shared team thread"]:visible')
    for (const filter of ["box", "you", "all"]) {
      const filterButton = thread.getByRole("button", { name: filter, exact: true })
      const filterBox = await filterButton.boundingBox()
      assert.ok(filterBox && filterBox.width >= 44 && filterBox.height >= 44, `attached-thread ${filter} filter is at least 44x44; got ${JSON.stringify(filterBox)}`)
      await filterButton.tap()
      await page.waitForFunction((node) => node.className.includes("text-accent"), await filterButton.elementHandle())
    }
    coverPhone(phoneCoverage, "room:Thread:filters", "Box, You, and All filters each had a 44px target, were touched, and exposed selected styling")
    const routeSelector = thread.getByLabel("Route this message to")
    const routeSelectorBox = await routeSelector.boundingBox()
    assert.ok(routeSelectorBox && routeSelectorBox.width >= 44 && routeSelectorBox.height >= 44, `attached-thread route selector is at least 44x44; got ${JSON.stringify(routeSelectorBox)}`)
    await routeSelector.tap()
    await routeSelector.selectOption("codex")
    coverPhone(phoneCoverage, "room:Thread:route selector", "route selector touched and Codex selected")
    const attachedComposer = thread.getByPlaceholder(/Message the team/i)
    await attachedComposer.fill("@codex keep this attached")
    await exerciseAssist(thread, attachedComposer, "room:Thread:attached Assist and Undo", "attached-thread draft", "chat")
    const attachedSend = thread.getByRole("button", { name: "Send message" })
    const attachedSendBox = await attachedSend.boundingBox()
    assert.ok(attachedSendBox && attachedSendBox.width >= 44 && attachedSendBox.height >= 44, `attached-thread Send is at least 44x44; got ${JSON.stringify(attachedSendBox)}`)
    await attachedSend.tap()
    coverPhone(phoneCoverage, "room:Thread:send", "message filled and Send touched")
    const stopRun = thread.getByRole("button", { name: "Stop active run" })
    await stopRun.waitFor({ state: "visible" })
    await exerciseStopReview(stopRun, "room:Thread:stop attached run", "attached thread")
    const closeAttachedThread = thread.getByRole("button", { name: "Close team thread" })
    const closeAttachedThreadBox = await closeAttachedThread.boundingBox()
    assert.ok(closeAttachedThreadBox && closeAttachedThreadBox.width >= 44 && closeAttachedThreadBox.height >= 44, `Close team thread is at least 44x44; got ${JSON.stringify(closeAttachedThreadBox)}`)
    await closeAttachedThread.tap()
    await thread.waitFor({ state: "detached" })
    coverPhone(phoneCoverage, "room:Thread:close", "Close touched and rail detached")
    await page.getByRole("button", { name: "Open team thread" }).tap()
    const reopenedThread = page.locator('aside[aria-label="Shared team thread"]:visible')
    await reopenedThread.waitFor({ state: "visible" })
    const openFullThread = reopenedThread.getByRole("button", { name: "Open full thread" })
    const openFullThreadBox = await openFullThread.boundingBox()
    assert.ok(openFullThreadBox && openFullThreadBox.width >= 44 && openFullThreadBox.height >= 44, `Open full thread is at least 44x44; got ${JSON.stringify(openFullThreadBox)}`)
    const fullThreadSurface = page.getByText("— one conversation, on the box", { exact: true })
    const [fullThreadTouch] = await Promise.all([
      touchTapAndWait(page, openFullThread, fullThreadSurface, "full team thread", 1),
      page.waitForURL((url) => url.searchParams.get("view") === "overview/thread"),
    ])
    coverPhone(phoneCoverage, "room:Thread:expand", "Open full thread touched and full workspace rendered")
    coverPhone(phoneCoverage, "room:Overview:open full thread", fullThreadTouch)
    const fullThreadPanel = fullThreadSurface.locator("xpath=ancestor::section[1]")
    const fullThreadComposer = fullThreadPanel.getByPlaceholder(/Message the team/i)
    const fullThreadRouteChips = fullThreadPanel.locator('button[aria-pressed]')
    assert.equal(await fullThreadRouteChips.count(), 9, "full thread exposes the seven agents plus Everyone and Box route chips")
    for (const label of ["Claude", "Codex", "DeepSeek", "Kimi", "Gemini", "Hermes", "Cursor", "Everyone", "Box"]) {
      const routeChip = fullThreadRouteChips.filter({ hasText: new RegExp(`^${label}$`) })
      assert.equal(await routeChip.count(), 1, `full thread exposes one ${label} route chip`)
      const routeChipBox = await routeChip.boundingBox()
      assert.ok(routeChipBox && routeChipBox.width >= 44 && routeChipBox.height >= 44, `full-thread ${label} route chip is at least 44x44; got ${JSON.stringify(routeChipBox)}`)
      await routeChip.tap()
      assert.equal(await routeChip.getAttribute("aria-pressed"), "true", `full-thread ${label} route chip exposes its selected state`)
      const pressedRouteChips = fullThreadPanel.locator('button[aria-pressed="true"]')
      assert.equal(await pressedRouteChips.count(), 1, `full-thread ${label} is the only selected route chip`)
      assert.equal((await pressedRouteChips.innerText()).trim(), label, `full-thread selected route is exactly ${label}`)
    }
    coverPhone(phoneCoverage, "room:Thread:full-thread route chips", "Claude, Codex, DeepSeek, Kimi, Gemini, Hermes, Cursor, Everyone, and Box each measured >=44, touched, and exposed aria-pressed=true")
    await fullThreadComposer.fill("@hermes prove the full-thread stop review")
    await exerciseAssist(fullThreadPanel, fullThreadComposer, "room:Thread:full-thread Assist and Undo", "full-thread draft", "chat")
    const fullThreadSend = fullThreadPanel.getByRole("button", { name: "Send", exact: true })
    const fullThreadSendBox = await fullThreadSend.boundingBox()
    assert.ok(fullThreadSendBox && fullThreadSendBox.width >= 44 && fullThreadSendBox.height >= 44, `full-thread Send is at least 44x44; got ${JSON.stringify(fullThreadSendBox)}`)
    await fullThreadSend.tap()
    const fullThreadStop = fullThreadPanel.getByRole("button", { name: "Stop active run" })
    await fullThreadStop.waitFor({ state: "visible" })
    await exerciseStopReview(fullThreadStop, "room:Thread:stop full-thread run", "full thread")
    state.holdChatStream = false
    coverPhone(phoneCoverage, "dialog:Stop this agent run?", "both attached and full-thread Stop surfaces exercised Keep running=0, failure-stays-open, and rapid Confirm=1 with pending lock")
    actionPhases.push("Attached team-thread actions complete")

    // Mode is a consequential restart. Cancel preserves Dev; Confirm swaps the
    // information architecture and every Growth destination remains touchable.
    await tapRoom(page, "Overview", true)
    const growthMode = page.getByRole("button", { name: "Growth", exact: true }).first()
    await growthMode.tap()
    const modeGate = page.getByRole("dialog", { name: "Switch to Growth Mode?" })
    await modeGate.getByRole("button", { name: "Cancel" }).tap()
    assert.equal(state.counts.get("POST /api/mode") || 0, 0)
    await growthMode.tap()
    await modeGate.getByRole("button", { name: "Confirm and restart" }).tap()
    assert.equal(state.counts.get("POST /api/mode"), 1)
    await page.getByRole("button", { name: /Explore Growth Mode/i }).tap()
    await primaryNav(page).getByRole("button", { name: "More", exact: true }).waitFor({ state: "visible" })
    assert.equal(await primaryNav(page).getByRole("button", { name: /^Agents(?:\s|$)/i }).count(), 0)
    const growthPhoneActions = await primaryNav(page).getByRole("button").allTextContents().then((items) => items.map((item) => item.trim()))
    assert.deepEqual(growthPhoneActions, [...LIVE_SURFACE_INVENTORY.growthPhonePrimary.map(({ label }) => label), "More"])
    coverPhone(phoneCoverage, "global:Dev/Growth mode", "Cancel=0 Confirm=1 and Growth IA exposed Home, Chat, Board, Loops, and grouped More")
    coverPhone(phoneCoverage, "dialog:Switch mode?", "Switch to Growth Mode Cancel=0 Confirm=1")
    actionPhases.push("Growth mode transition complete")

    const touchedGrowthDestinations = []
    for (const destination of LIVE_SURFACE_INVENTORY.growthPhonePrimary) {
      await primaryNav(page).getByRole("button", { name: destination.label, exact: true }).tap()
      await page.waitForFunction((view) => new URL(window.location.href).searchParams.get("view") === view, destination.view)
      touchedGrowthDestinations.push(`Command Center:${destination.label}`)
    }
    const growthMore = primaryNav(page).getByRole("button", { name: "More", exact: true })
    for (const [groupLabel, destinations] of Object.entries(LIVE_SURFACE_INVENTORY.destinations.Growth).filter(([label]) => label !== "Command Center")) {
      for (const destination of destinations) {
        await growthMore.tap()
        const moreSheet = page.getByRole("dialog", { name: "More Growth destinations" })
        await moreSheet.waitFor({ state: "visible" })
        const group = moreSheet.locator(`[aria-label="${groupLabel}"]`)
        await group.waitFor({ state: "visible" })
        const button = group.getByRole("button", { name: new RegExp(`^${destination.label}(?:\\s|$)`, "i") })
        assert.equal(await button.count(), 1, `Growth ${groupLabel} navigation exposes ${destination.label}`)
        await button.tap()
        await page.waitForFunction((view) => new URL(window.location.href).searchParams.get("view") === view, destination.view)
        touchedGrowthDestinations.push(`${groupLabel}:${destination.label}`)
      }
    }
    await growthMore.tap()
    const moreSheet = page.getByRole("dialog", { name: "More Growth destinations" })
    await moreSheet.getByRole("button", { name: "Open settings and mode" }).tap()
    await page.getByRole("dialog", { name: "Settings" }).waitFor({ state: "visible" })
    await closeDialog(page, "Settings")
    coverPhone(phoneCoverage, "global:primary navigation", { growth: touchedGrowthDestinations })

    state.measurementConnected = true
    await page.goto(`${baseUrl}/?view=growth/attribution`, { waitUntil: "domcontentloaded", timeout: 60_000 })
    await neutralizeDevToolbar(page)
    await page.getByRole("button", { name: "Refresh", exact: true }).last().tap()
    await page.getByText("Review Pipedream-backed connection health and manage the measurement facts stored on this box.", { exact: true }).waitFor({ state: "visible" })
    await page.getByText("Ad-platform credentials are held by Pipedream Connect and are not stored on this box. Measurement data is stored here, in your own cloud.", { exact: true }).waitFor({ state: "visible" })
    assert.equal(await page.locator('input[type="password"]').count(), 0, "phone Attribution exposes no Pipedream credential field")
    assert.equal(await page.getByRole("button", { name: "Connect an ad account", exact: true }).count(), 0, "phone Attribution exposes no connect wizard")
    await page.getByText("act_1001", { exact: true }).waitFor({ state: "visible" })
    const phoneDisconnect = page.getByRole("button", { name: "Disconnect", exact: true })
    const phoneDisconnectBox = await phoneDisconnect.boundingBox()
    assert.ok(phoneDisconnectBox && phoneDisconnectBox.width >= 44 && phoneDisconnectBox.height >= 44, `phone Disconnect is at least 44x44; got ${JSON.stringify(phoneDisconnectBox)}`)
    await phoneDisconnect.tap()
    await page.getByText(/does not revoke OAuth access/i).waitFor({ state: "visible" })
    assert.equal(state.counts.get(`DELETE /measurement/connections/${MEASUREMENT_CONNECTION_ID}`), 1, "phone disconnect sends one exact-connection request")

    const phoneDeleteStoredFacts = page.getByRole("button", { name: "Delete stored facts", exact: true })
    const phoneDeleteBox = await phoneDeleteStoredFacts.boundingBox()
    assert.ok(phoneDeleteBox && phoneDeleteBox.width >= 44 && phoneDeleteBox.height >= 44, `phone stored-facts control is at least 44x44; got ${JSON.stringify(phoneDeleteBox)}`)
    await phoneDeleteStoredFacts.tap()
    const phoneDeleteGate = page.getByRole("dialog", { name: "Delete stored measurement facts?", exact: true })
    await phoneDeleteGate.getByText(/2 stored measurement facts.*permanently deleted/i).waitFor({ state: "visible" })
    const phoneConfirmDelete = phoneDeleteGate.getByRole("button", { name: "Delete 2 stored facts", exact: true })
    const phoneConfirmDeleteBox = await phoneConfirmDelete.boundingBox()
    assert.ok(phoneConfirmDeleteBox && phoneConfirmDeleteBox.width >= 44 && phoneConfirmDeleteBox.height >= 44, `phone fact-delete confirmation is at least 44x44; got ${JSON.stringify(phoneConfirmDeleteBox)}`)
    await phoneConfirmDelete.tap()
    await page.getByText("Deleted 2 stored measurement facts.", { exact: true }).waitFor({ state: "visible" })
    assert.equal(state.counts.get(`GET /measurement/connections/${MEASUREMENT_CONNECTION_ID}/facts`), 1, "phone previews the exact stored-fact count once")
    assert.equal(state.counts.get(`DELETE /measurement/connections/${MEASUREMENT_CONNECTION_ID}/facts`), 1, "phone confirms one exact-connection fact deletion")
    assert.equal(state.measurementFacts.length, 0, "the confirmed phone action removes the two exact facts")
    coverPhone(phoneCoverage, "room:Growth:Attribution disconnect and delete", { disconnectTarget: phoneDisconnectBox, deleteTarget: phoneDeleteBox, confirmTarget: phoneConfirmDeleteBox, previewCount: 2, disconnectRequests: 1, deleteRequests: 1 })
    coverPhone(phoneCoverage, "dialog:Delete stored measurement facts?", "exact count 2 previewed before one confirmed irreversible deletion")
    await screenshot(page, "phone-measurement-delete.png")

    await growthMore.tap()
    const clientWork = page.getByRole("dialog", { name: "More Growth destinations" }).locator('[aria-label="Client work"]')
    await clientWork.getByRole("button", { name: /^Accounts(?:\s|$)/i }).tap()
    const growthRail = page.getByRole("region", { name: "Growth sections" })
    const growthSwipe = await touchHorizontalRail(page, growthRail)
    assert.equal(growthSwipe.moved, true)
    coverPhone(phoneCoverage, "rail:Growth sections", growthSwipe)
    await growthRail.evaluate((node) => { node.scrollLeft = 0 })
    const websiteUrl = page.getByLabel("Website URL for ClaimFlow", { exact: true })
    await websiteUrl.fill("https://claimflow.health")
    const buildDnaButton = page.getByRole("button", { name: "Build Brand DNA from this site", exact: true }).first()
    const buildDnaButtonBox = await buildDnaButton.boundingBox()
    assert.ok(buildDnaButtonBox && buildDnaButtonBox.width >= 44 && buildDnaButtonBox.height >= 44, `Build Brand DNA is at least 44x44; got ${JSON.stringify(buildDnaButtonBox)}`)
    const buildsBefore = state.counts.get("POST /growth/accounts/claimflow/dna/from-url") || 0
    state.growthDnaBuildDelayMs = 1_500
    const buildResponse = page.waitForResponse((response) => response.request().method() === "POST"
      && new URL(response.url()).pathname === "/growth/accounts/claimflow/dna/from-url"
      && response.status() === 200)
    await websiteUrl.press("Enter")
    await websiteUrl.press("Enter")
    await page.getByRole("button", { name: "Building Brand DNA…", exact: true }).waitFor({ state: "visible" })
    assert.equal(state.counts.get("POST /growth/accounts/claimflow/dna/from-url"), buildsBefore + 1, "rapid Enter sends exactly one Brand DNA generation request")
    await buildResponse
    state.growthDnaBuildDelayMs = 0
    const dna = page.getByRole("dialog", { name: /Brand DNA.*ClaimFlow/i })
    await dna.waitFor({ state: "visible" })
    assert.deepEqual(state.growthDnaBuildBodies, [{ accountId: "claimflow", url: "https://claimflow.health" }])
    assert.equal(state.growthDna.claimflow.filter((record) => record.source === "generated").length, 5)
    assert.equal(await dna.getByLabel("Website URL for ClaimFlow", { exact: true }).count(), 1, "the Brand DNA drawer also exposes the URL builder")
    await screenshot(page, "phone-growth-brand-dna-from-url.png")
    coverPhone(phoneCoverage, "room:Growth:accounts", { client: "ClaimFlow", urlField: true, enter: true, rapidSubmit: 1 })
    coverPhone(phoneCoverage, "room:Growth:Brand DNA from URL", { touchTarget: buildDnaButtonBox, writes: 5, source: "https://claimflow.health/", drawerOpened: true })
    const firstDnaAsset = dna.getByRole("region", { name: "Brand DNA sections" }).locator("section").first()
    await firstDnaAsset.getByRole("button", { name: /^(?:Add|Edit)$/ }).tap()
    const dnaDraft = firstDnaAsset.locator("textarea")
    await dnaDraft.fill("Unsaved Brand DNA must survive an accidental close until the operator decides.")
    await exerciseAssist(firstDnaAsset, dnaDraft, "room:Growth:Brand DNA Assist and Undo", "Brand DNA draft", "memory")
    const dnaWritesBeforeDiscard = [...state.counts.entries()].filter(([key]) => /^PUT \/growth\/accounts\/[^/]+\/dna\/[^/]+$/.test(key)).reduce((sum, [, value]) => sum + value, 0)
    await dna.getByRole("button", { name: "Close", exact: true }).last().tap()
    const discardBrandDna = page.getByRole("dialog", { name: "Discard Brand DNA edits?" })
    await discardBrandDna.getByRole("button", { name: "Keep editing" }).tap()
    assert.equal(await dna.isVisible(), true, "keeping Brand DNA edits leaves the drawer open")
    assert.equal(await dnaDraft.inputValue(), "Unsaved Brand DNA must survive an accidental close until the operator decides.")
    await dna.getByRole("button", { name: "Close", exact: true }).last().tap()
    await discardBrandDna.getByRole("button", { name: "Discard edits" }).tap()
    await dna.waitFor({ state: "detached" })
    const dnaWritesAfterDiscard = [...state.counts.entries()].filter(([key]) => /^PUT \/growth\/accounts\/[^/]+\/dna\/[^/]+$/.test(key)).reduce((sum, [, value]) => sum + value, 0)
    assert.equal(dnaWritesAfterDiscard, dnaWritesBeforeDiscard, "discarding an unsaved Brand DNA draft writes nothing")
    coverPhone(phoneCoverage, "room:Growth:Brand DNA", "Brand DNA section opened and edited; dirty Close reviewed before Keep editing or Discard")
    coverPhone(phoneCoverage, "dialog:Discard Brand DNA edits?", "Keep editing preserved typed Brand DNA; Discard closed it with zero PUTs")

    const createAccountButton = page.getByRole("button", { name: "Create client account", exact: true })
    const createAccountButtonBox = await createAccountButton.boundingBox()
    assert.ok(createAccountButtonBox && createAccountButtonBox.width >= 44 && createAccountButtonBox.height >= 44, `Create client account is at least 44x44; got ${JSON.stringify(createAccountButtonBox)}`)
    await createAccountButton.tap()
    const createAccount = page.getByRole("dialog", { name: "Create client account" })
    const clientName = createAccount.getByLabel("Client name", { exact: true })
    const clientIndustry = createAccount.getByLabel("Industry", { exact: true })
    await clientName.fill("New Brand")
    await clientIndustry.fill("Technology")
    const accountWritesBefore = state.counts.get("POST /growth/accounts") || 0

    await createAccount.getByRole("button", { name: "Close", exact: true }).tap()
    const discardAccount = page.getByRole("dialog", { name: "Discard this client account draft?" })
    await discardAccount.getByRole("button", { name: "Keep editing", exact: true }).tap()
    assert.equal(await clientName.inputValue(), "New Brand", "Keep editing preserves the typed client name")
    assert.equal(state.counts.get("POST /growth/accounts") || 0, accountWritesBefore, "closing a dirty client draft writes nothing")
    coverPhone(phoneCoverage, "dialog:Discard this client account draft?", "dirty Close opened review; Keep editing preserved both fields and POST stayed at zero")

    await clientName.press("Enter")
    const createAccountReview = page.getByRole("dialog", { name: "Create this client account?" })
    await createAccountReview.waitFor({ state: "visible" })
    await createAccountReview.getByRole("button", { name: "Cancel", exact: true }).tap()
    await createAccount.waitFor({ state: "visible" })
    assert.equal(state.counts.get("POST /growth/accounts") || 0, accountWritesBefore, "review Cancel creates no account")

    await clientName.press("Enter")
    await createAccountReview.waitFor({ state: "visible" })
    state.growthCreateDelayMs = 1_500
    const createAccountResponse = page.waitForResponse((response) => response.request().method() === "POST"
      && new URL(response.url()).pathname === "/growth/accounts"
      && response.status() === 200)
    const confirmCreate = createAccountReview.getByRole("button", { name: "Confirm create", exact: true })
    await touchDoubleTap(page, confirmCreate)
    await page.waitForFunction((node) => node.disabled, await confirmCreate.elementHandle())
    assert.equal(await createAccountReview.getByRole("button", { name: "Cancel", exact: true }).isDisabled(), true, "Cancel locks while the durable account write is pending")
    assert.equal(state.counts.get("POST /growth/accounts"), accountWritesBefore + 1, "rapid Confirm sends exactly one client-account write")
    await createAccountResponse
    state.growthCreateDelayMs = 0
    const newBrandDna = page.getByRole("dialog", { name: /Brand DNA.*New Brand/i })
    await newBrandDna.waitFor({ state: "visible" })
    assert.equal(state.growthAccounts.length, 2, "the existing first client and the newly created second client both remain in the live account set")
    assert.deepEqual(state.growthAccountBodies, [{ name: "New Brand", industry: "Technology" }], "the second client request preserves its exact name and industry")
    assert.equal(state.growthAccounts[1].industry, "Technology", "the created client keeps the submitted industry in the live account set")
    await newBrandDna.getByRole("button", { name: "Close", exact: true }).last().tap()
    await page.getByText("New Brand", { exact: true }).first().waitFor({ state: "visible" })
    coverPhone(phoneCoverage, "room:Growth:create account", { touchTarget: createAccountButtonBox, existingClient: "ClaimFlow", createdClient: "New Brand", keyboardReview: true, Cancel: 0, rapidConfirm: 1, resultCount: 2 })
    coverPhone(phoneCoverage, "dialog:Create client account", "labeled name and industry accepted touch/keyboard input; Enter opened review")
    coverPhone(phoneCoverage, "dialog:Create this client account?", "Cancel=0; rapid Confirm=1; pending lock; second client drawer opened")

    await page.goto(`${baseUrl}/?view=growth/goals`, { waitUntil: "domcontentloaded", timeout: 60_000 })
    await neutralizeDevToolbar(page)
    await page.locator('[data-growth-tab="goals"]').waitFor({ state: "visible" })
    await page.getByRole("button", { name: "Open objective board card t_objective" }).tap()
    await page.getByRole("dialog", { name: taskObjective.title }).getByRole("button", { name: "Close", exact: true }).last().tap()
    coverPhone(phoneCoverage, "room:Growth:objective links", "objective link touched and canonical board-card modal opened")
    await page.getByRole("button", { name: "Open linked board card t_review" }).tap()
    await page.getByRole("dialog", { name: taskReview.title }).getByRole("button", { name: "Close", exact: true }).last().tap()
    coverPhone(phoneCoverage, "room:Growth:key-result links", "key-result link touched and canonical board-card modal opened")
    const goalsVertical = await exerciseVerticalSurface(page, page.getByRole("button", { name: "Open linked board card t_done" }), "Growth goals")
    await page.goto(`${baseUrl}/?view=growth/autonomy`, { waitUntil: "domcontentloaded", timeout: 60_000 })
    await neutralizeDevToolbar(page)
    await page.locator('[data-growth-tab="autonomy"]').waitFor({ state: "visible" })
    const growthAutonomyWritesBefore = state.counts.get("POST /autonomy") || 0
    const growthPause = page.getByRole("button", { name: "Pause New", exact: true })
    const growthPauseBox = await growthPause.boundingBox()
    assert.ok(growthPauseBox && growthPauseBox.width >= 44 && growthPauseBox.height >= 44, `Growth Pause New is at least 44x44; got ${JSON.stringify(growthPauseBox)}`)
    const growthPauseResponse = page.waitForResponse((response) => response.request().method() === "POST"
      && new URL(response.url()).pathname === "/autonomy"
      && response.status() === 200)
    await growthPause.tap()
    await growthPauseResponse
    assert.equal(state.counts.get("POST /autonomy"), growthAutonomyWritesBefore + 1, "Growth Pause New touch sends exactly one request")
    const growthResume = page.getByRole("button", { name: "Resume", exact: true })
    await growthResume.waitFor({ state: "visible" })
    const growthResumeBox = await growthResume.boundingBox()
    assert.ok(growthResumeBox && growthResumeBox.width >= 44 && growthResumeBox.height >= 44, `Growth Resume is at least 44x44; got ${JSON.stringify(growthResumeBox)}`)
    await growthResume.tap()
    const growthResumeGate = page.getByRole("alertdialog", { name: "Resume autonomy?" })
    await growthResumeGate.getByRole("button", { name: "Cancel", exact: true }).tap()
    assert.equal(state.counts.get("POST /autonomy"), growthAutonomyWritesBefore + 1, "cancelling Growth Resume sends no request")
    await growthResume.tap()
    const growthResumeResponse = page.waitForResponse((response) => response.request().method() === "POST"
      && new URL(response.url()).pathname === "/autonomy"
      && response.status() === 200)
    await growthResumeGate.getByRole("button", { name: "Confirm resume", exact: true }).tap()
    await growthResumeResponse
    assert.equal(state.counts.get("POST /autonomy"), growthAutonomyWritesBefore + 2, "confirming Growth Resume touch sends exactly one additional request")
    await page.getByRole("button", { name: "Pause New", exact: true }).waitFor({ state: "visible" })
    coverPhone(phoneCoverage, "room:Growth:autonomy pause/resume", { Pause: 1, Cancel: 0, Confirm: 1, pauseTarget: growthPauseBox, resumeTarget: growthResumeBox })
    const autonomyVertical = await exerciseVerticalSurface(page, page.getByRole("button", { name: "Open autonomy controls" }), "Growth autonomy")
    await page.getByRole("button", { name: "Open autonomy controls" }).tap()
    await page.locator('[data-system-tab="operations"]').waitFor({ state: "visible" })
    coverPhone(phoneCoverage, "room:Growth:autonomy controls", "Open autonomy controls touched and Systems Operations opened")
    await page.goto(`${baseUrl}/?view=growth/autonomy`, { waitUntil: "domcontentloaded", timeout: 60_000 })
    await neutralizeDevToolbar(page)
    await page.locator('[data-growth-tab="autonomy"]').waitFor({ state: "visible" })
    await page.getByRole("button", { name: "Open Loops and Multi-Loops" }).tap()
    await page.getByRole("heading", { name: "Growth Loops" }).waitFor({ state: "visible" })
    await page.getByText("Parked until default mode", { exact: true }).waitFor({ state: "visible" })
    coverPhone(phoneCoverage, "room:Growth:Loops link", "Open Loops and Multi-Loops touched; cross-mode single Loop rendered Parked until default mode")
    const growthRecipes = page.getByRole("region", { name: "Growth loop recipes" })
    await growthRecipes.scrollIntoViewIfNeeded()
    const growthRecipeSwipe = await touchHorizontalRail(page, growthRecipes)
    assert.equal(growthRecipeSwipe.moved, true)
    coverPhone(phoneCoverage, "rail:Growth loop recipes", growthRecipeSwipe)
    coverPhone(phoneCoverage, "vertical:goals and autonomy", { goals: goalsVertical, autonomy: autonomyVertical })
    actionPhases.push("Growth room controls complete")

    await page.goto(`${baseUrl}/?view=work/board`, { waitUntil: "domcontentloaded", timeout: 60_000 })
    await neutralizeDevToolbar(page)
    await page.locator('[data-work-tab="board"]').waitFor({ state: "visible" })
    await page.getByRole("button", { name: "ClaimFlow", exact: true }).tap()
    coverPhone(phoneCoverage, "room:Board:client filter", "ClaimFlow growth client filter touched")
    await screenshot(page, "phone-06-every-control.png")
    await page.getByRole("button", { name: "Open team thread" }).tap()
    const finalThread = page.locator('aside[aria-label="Shared team thread"]:visible')
    await finalThread.waitFor({ state: "visible" })
    const finalThreadScroller = finalThread.locator(".overflow-y-auto")
    assert.equal(await finalThreadScroller.count(), 1, "the attached thread exposes one transcript scroller")
    const finalThreadOverflow = await finalThreadScroller.evaluate((node) => node.scrollHeight - node.clientHeight)
    assert.ok(finalThreadOverflow > 8, `the attached thread transcript has real vertical overflow; got ${finalThreadOverflow}`)
    await finalThreadScroller.evaluate((node) => { node.scrollTop = 0 })
    await waitForScrollSettled(finalThreadScroller)
    const threadSwipe = await touchSwipe(page, finalThreadScroller, { x: 0, y: -360 })
    assert.equal(threadSwipe.moved, true)
    assert.equal(await finalThread.isVisible(), true, "the attached thread remains visible after its real vertical swipe")
    coverPhone(phoneCoverage, "vertical:team thread", threadSwipe)
    actionPhases.push("Phone action journey complete")

    assert.equal(state.counts.get("GET /sw.js") || 0, 0, "phone control journey never requests the production-owned worker")
    assert.deepEqual(
      diagnostics.expectedHttpFailures.filter((failure) => failure.method === "POST" && failure.pathname === "/api/assist"),
      [{ method: "POST", pathname: "/api/assist", status: 409 }],
      "the one intentional Assist failure is the only failing Assist response",
    )
    await context.tracing.stop({ path: phoneControlsTracePath })
    phoneControlsTracePending = false
    await assertNoErrorOverlay(page, diagnostics)
    await context.close()
    proof.phoneControls = { ...proof.phoneControls, requests: Object.fromEntries(state.counts), diagnostics, productFindings }
    assert.deepEqual(productFindings, [], "phone every-control journey has no missing product controls")
  })

  await t.test("clean-profile phone push enrollment gates browser permission and subscription changes", { timeout: 90_000, skip: assistOnly || selectedViewport === "desktop" || selectedViewport === "phone-navigation" || selectedViewport === "phone-brand-dna" }, async (pushJourney) => {
    const state = createMockState()
    state.pushOriginReset = true
    state.pushSigningKeyReset = true
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, reducedMotion: "reduce" })
    pushJourney.after(async () => { await closeContext(context) })
    assert.deepEqual(await context.cookies(), [], "push enrollment starts in a clean browser profile")
    await installMockPushEnvironment(context)
    const page = await context.newPage()
    page.setDefaultTimeout(30_000)
    await installMockApi(page, baseUrl, state)
    const diagnostics = startDiagnostics(page, "clean-profile phone push enrollment")
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true })
    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 60_000 })
    await neutralizeDevToolbar(page)
    await primaryNav(page).waitFor({ state: "visible", timeout: 60_000 })

    const settings = page.getByRole("dialog", { name: "Settings" })
    await touchTapAndWait(page, page.getByRole("button", { name: "Open settings" }), settings, "clean-profile phone Settings")
    const settingsRail = settings.getByRole("region", { name: "Settings sections" })
    const securityTab = settingsRail.getByRole("button", { name: /^Security(?:\s|$)/i })
    assert.equal(await touchSwipeUntilVisible(page, settingsRail, securityTab), true, "Security is touch-reachable in a clean phone profile")
    await securityTab.tap()
    await settings.getByRole("heading", { name: "Security", exact: true }).waitFor({ state: "visible" })
    await settings.getByText("Notifications are off", { exact: true }).waitFor({ state: "visible" })
    const combinedResetCause = "Notifications from the retired box address were turned off because that address is sealed, and this box replaced its notification signing key. Enable notifications again on this canonical address to keep receiving alerts."
    await settings.getByRole("alert").getByText(combinedResetCause, { exact: true }).waitFor({ state: "visible" })
    await page.waitForFunction(() => window.__agenthostPushProof?.getSubscriptionCalls >= 1)

    const targetBox = async (locator, label) => {
      await locator.scrollIntoViewIfNeeded()
      const box = await locator.boundingBox()
      assert.ok(box && box.width >= 44 && box.height >= 44, `${label} is at least 44x44 at 390px; got ${JSON.stringify(box)}`)
      return box
    }
    const pushProof = () => page.evaluate(() => structuredClone(window.__agenthostPushProof))
    const initialBrowserState = await pushProof()
    assert.equal(initialBrowserState.active, false, "getSubscription returns null in the clean profile")
    assert.equal(initialBrowserState.permission, "default")
    assert.ok([1, 2].includes(state.pushStatusBodies.length), "a clean profile checks status once in production or twice under React Strict Mode")
    assert.equal(state.counts.get("POST /push/status"), state.pushStatusBodies.length, "every clean-profile status request is captured")
    assert.deepEqual(state.pushStatusBodies.map((body) => body.endpoint), Array(state.pushStatusBodies.length).fill(""), "every clean-profile status check reports only the empty endpoint sentinel")

    const enable = settings.getByRole("button", { name: "Enable notifications", exact: true })
    const enableBox = await targetBox(enable, "Enable notifications")
    await enable.tap()
    const enableGate = page.getByRole("dialog", { name: "Enable notifications on this device?" })
    await enableGate.waitFor({ state: "visible" })
    assert.match(await enableGate.innerText(), /ask this browser for notification permission.*register this device with your box/is)
    const enableClose = enableGate.getByRole("button", { name: "Close", exact: true })
    const enableCancel = enableGate.getByRole("button", { name: "Cancel", exact: true })
    const enableConfirm = enableGate.getByRole("button", { name: "Confirm and enable", exact: true })
    const enableGateBoxes = {
      close: await targetBox(enableClose, "Enable-notifications Close"),
      cancel: await targetBox(enableCancel, "Enable-notifications Cancel"),
      confirm: await targetBox(enableConfirm, "Enable-notifications Confirm"),
    }
    await enableClose.tap()
    await enableGate.waitFor({ state: "detached" })
    assert.equal((await pushProof()).permissionRequests, 0, "closing the review requests no permission")
    assert.equal((await pushProof()).browserSubscribeCalls, 0, "closing the review creates no browser subscription")
    assert.equal(state.counts.get("POST /push/subscribe") || 0, 0, "closing the review creates no box subscription")

    await enable.tap()
    await enableGate.getByRole("button", { name: "Cancel", exact: true }).tap()
    await enableGate.waitFor({ state: "detached" })
    const afterEnableCancel = await pushProof()
    assert.equal(afterEnableCancel.permissionRequests, 0, "Cancel requests no browser permission")
    assert.equal(afterEnableCancel.browserSubscribeCalls, 0, "Cancel creates no browser subscription")
    assert.equal(state.counts.get("POST /push/subscribe") || 0, 0, "Cancel creates no box subscription")

    await enable.tap()
    const subscribeResponse = page.waitForResponse((result) => result.request().method() === "POST" && new URL(result.url()).pathname === "/push/subscribe")
    await enableGate.getByRole("button", { name: "Confirm and enable", exact: true }).tap()
    await subscribeResponse
    await settings.getByText("Notifications are on", { exact: true }).waitFor({ state: "visible" })
    const enabledBrowserState = await pushProof()
    assert.equal(enabledBrowserState.permissionRequests, 1, "one Confirm requests browser permission exactly once")
    assert.equal(enabledBrowserState.browserSubscribeCalls, 1, "one Confirm creates one browser subscription")
    assert.equal(state.counts.get("GET /push/key"), 1, "one Confirm fetches one public key")
    assert.equal(state.counts.get("POST /push/subscribe"), 1, "one Confirm registers one box subscription")
    assert.deepEqual(state.pushSubscriptionBodies, [PUSH_SUBSCRIPTION_JSON], "the box receives the exact browser subscription")
    assert.deepEqual(enabledBrowserState.lastSubscribeOptions, {
      userVisibleOnly: true,
      applicationServerKey: [4, ...Array(64).fill(1)],
    }, "the browser subscribes visibly with the exact decoded box public key")
    coverPhone(phoneCoverage, "room:Settings:Enable browser notifications", { touchTarget: enableBox, initial: "off", Close: "permission=0 subscription=0 POST=0", Cancel: "permission=0 subscription=0 POST=0", Confirm: "permission=1 browser subscription=1 POST=1", result: "on" })
    coverPhone(phoneCoverage, "dialog:Enable notifications on this device?", { touchTargets: enableGateBoxes, consequenceCopy: "permission + device registration + lock-screen detail", Close: 0, Cancel: 0, Confirm: 1 })

    const disable = settings.getByRole("button", { name: "Turn off notifications", exact: true })
    const disableBox = await targetBox(disable, "Turn off notifications")
    await disable.tap()
    const disableGate = page.getByRole("dialog", { name: "Turn off notifications on this device?" })
    await disableGate.waitFor({ state: "visible" })
    assert.match(await disableGate.innerText(), /stop alerts on this device.*Other subscribed browsers will keep receiving notifications/is)
    const disableClose = disableGate.getByRole("button", { name: "Close", exact: true })
    const disableCancel = disableGate.getByRole("button", { name: "Cancel", exact: true })
    const disableConfirm = disableGate.getByRole("button", { name: "Confirm and turn off", exact: true })
    const disableGateBoxes = {
      close: await targetBox(disableClose, "Turn-off-notifications Close"),
      cancel: await targetBox(disableCancel, "Turn-off-notifications Cancel"),
      confirm: await targetBox(disableConfirm, "Turn-off-notifications Confirm"),
    }
    await disableClose.tap()
    await disableGate.waitFor({ state: "detached" })
    assert.equal(state.counts.get("POST /push/unsubscribe") || 0, 0, "closing the review removes no subscription")
    assert.equal((await pushProof()).browserUnsubscribeCalls, 0, "closing the review changes no browser subscription")

    await disable.tap()
    await disableGate.getByRole("button", { name: "Cancel", exact: true }).tap()
    await disableGate.waitFor({ state: "detached" })
    assert.equal(state.counts.get("POST /push/unsubscribe") || 0, 0, "Cancel removes no box subscription")
    assert.equal((await pushProof()).browserUnsubscribeCalls, 0, "Cancel removes no browser subscription")

    await disable.tap()
    state.failNextPushUnsubscribe = true
    const failedUnsubscribe = page.waitForResponse((result) => result.request().method() === "POST" && new URL(result.url()).pathname === "/push/unsubscribe" && result.status() === 503)
    await disableGate.getByRole("button", { name: "Confirm and turn off", exact: true }).tap()
    await failedUnsubscribe
    const exactFailure = "the box could not remove this browser notification subscription"
    await disableGate.getByRole("alert").getByText(exactFailure, { exact: true }).waitFor({ state: "visible" })
    assert.equal(await disableGate.isVisible(), true, "a named unsubscribe failure keeps the consequence review open")
    assert.equal(state.counts.get("POST /push/unsubscribe"), 1)
    assert.equal((await pushProof()).browserUnsubscribeCalls, 0, "the browser subscription stays active when the box removal fails")

    state.pushUnsubscribeDelayMs = 1_500
    const successfulUnsubscribeBaseline = state.counts.get("POST /push/unsubscribe") || 0
    const successfulUnsubscribe = page.waitForResponse((result) => result.request().method() === "POST" && new URL(result.url()).pathname === "/push/unsubscribe" && result.status() === 200)
    const successfulConfirm = disableGate.getByRole("button", { name: "Confirm and turn off", exact: true })
    await touchDoubleTap(page, successfulConfirm)
    await page.waitForFunction((node) => node.disabled, await successfulConfirm.elementHandle())
    assert.equal(state.counts.get("POST /push/unsubscribe"), successfulUnsubscribeBaseline + 1, "rapid double Confirm sends exactly one unsubscribe request")
    assert.equal(await disableGate.getByRole("button", { name: "Cancel", exact: true }).isDisabled(), true, "Cancel is locked while unsubscribe is pending")
    await disableGate.getByRole("button", { name: "Close", exact: true }).tap()
    assert.equal(await disableGate.isVisible(), true, "the unsubscribe review cannot dismiss while pending")
    await successfulUnsubscribe
    state.pushUnsubscribeDelayMs = 0
    await settings.getByText("Notifications are off", { exact: true }).waitFor({ state: "visible" })
    const disabledBrowserState = await pushProof()
    assert.equal(disabledBrowserState.browserUnsubscribeCalls, 1, "the successful Confirm removes the browser subscription exactly once")
    assert.equal(disabledBrowserState.active, false)
    assert.deepEqual(state.pushUnsubscriptionBodies, [{ endpoint: PUSH_ENDPOINT }, { endpoint: PUSH_ENDPOINT }], "failure and one retry each target the exact browser endpoint")
    assert.equal(state.counts.get("GET /sw.js") || 0, 0, "clean-profile Next push enrollment never requests the production-owned worker")
    assert.equal(disabledBrowserState.serviceWorkerRegistrations, 0, "bare Next does not register the production worker")
    coverPhone(phoneCoverage, "room:Settings:Turn off browser notifications", { touchTarget: disableBox, Close: "server=0 browser=0", Cancel: "server=0 browser=0", failure: exactFailure, rapidConfirmDelta: 1, browserUnsubscribe: 1, result: "off" })
    coverPhone(phoneCoverage, "dialog:Turn off notifications on this device?", { touchTargets: disableGateBoxes, consequenceCopy: "this device only; other browsers stay subscribed", Close: 0, Cancel: 0, failureStaysOpen: exactFailure, rapidConfirm: 1 })

    await screenshot(page, "phone-08-push-notifications-off.png")
    await context.tracing.stop({ path: path.join(ARTIFACT_DIR, "phone-push-enrollment-trace.zip") })
    await assertNoErrorOverlay(page, diagnostics)
    proof.pushEnrollment = {
      viewport: LIVE_SURFACE_INVENTORY.viewports.phone,
      cleanProfile: true,
      statusRequestEndpoint: "",
      resetState: { originReset: true, signingKeyReset: true, exactCause: combinedResetCause },
      initialBrowserState,
      enabledBrowserState,
      disabledBrowserState,
      subscriptionBodies: state.pushSubscriptionBodies,
      unsubscriptionBodies: state.pushUnsubscriptionBodies,
      requests: Object.fromEntries(state.counts),
      exactFailure,
      diagnostics,
    }
    await context.close()
  })

  await t.test("phone replaces an obsolete VAPID-bound browser subscription before claiming notifications are on", { timeout: 90_000, skip: assistOnly || selectedViewport === "desktop" || selectedViewport === "phone-navigation" || selectedViewport === "phone-brand-dna" }, async (pushJourney) => {
    const state = createMockState()
    state.pushSigningKeyReset = true
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, reducedMotion: "reduce" })
    pushJourney.after(async () => { await closeContext(context) })
    await installMockPushEnvironment(context, { staleSubscription: true })
    const page = await context.newPage()
    page.setDefaultTimeout(30_000)
    await installMockApi(page, baseUrl, state)
    const diagnostics = startDiagnostics(page, "stale notification signing-key replacement")
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true })
    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 60_000 })
    await neutralizeDevToolbar(page)
    await primaryNav(page).waitFor({ state: "visible", timeout: 60_000 })

    const settings = page.getByRole("dialog", { name: "Settings" })
    await touchTapAndWait(page, page.getByRole("button", { name: "Open settings" }), settings, "stale-key phone Settings")
    const settingsRail = settings.getByRole("region", { name: "Settings sections" })
    const securityTab = settingsRail.getByRole("button", { name: /^Security(?:\s|$)/i })
    assert.equal(await touchSwipeUntilVisible(page, settingsRail, securityTab), true)
    await securityTab.tap()
    await settings.getByText("Notifications are off", { exact: true }).waitFor({ state: "visible" })
    const signingResetCause = "This box replaced its notification signing key, so the old browser subscription was turned off. Enable notifications again to create a working subscription."
    await settings.getByRole("alert").getByText(signingResetCause, { exact: true }).waitFor({ state: "visible" })
    const before = await page.evaluate(() => structuredClone(window.__agenthostPushProof))
    assert.equal(before.active, true, "the fixture begins with a real browser subscription bound to the obsolete key")
    assert.equal(before.permission, "granted")
    assert.deepEqual(before.initialApplicationServerKey, STALE_PUSH_PUBLIC_KEY_BYTES)
    assert.ok([1, 2].includes(state.pushStatusBodies.length), "the stale browser endpoint is checked once in production or twice under React Strict Mode")
    assert.equal(state.counts.get("POST /push/status"), state.pushStatusBodies.length, "every stale-key status request is captured")
    assert.deepEqual(state.pushStatusBodies.map((body) => body.endpoint), Array(state.pushStatusBodies.length).fill(PUSH_ENDPOINT), "every stale-key check sends the exact obsolete browser endpoint")

    await settings.getByRole("button", { name: "Enable notifications", exact: true }).tap()
    const enableGate = page.getByRole("dialog", { name: "Enable notifications on this device?" })
    const subscribeResponse = page.waitForResponse((result) => result.request().method() === "POST"
      && new URL(result.url()).pathname === "/push/subscribe"
      && result.status() === 200)
    await touchDoubleTap(page, enableGate.getByRole("button", { name: "Confirm and enable", exact: true }))
    await subscribeResponse
    await settings.getByText("Notifications are on", { exact: true }).waitFor({ state: "visible" })

    const after = await page.evaluate(() => structuredClone(window.__agenthostPushProof))
    assert.equal(after.permissionRequests, 0, "an already granted browser is not asked for permission again")
    assert.equal(after.browserUnsubscribeCalls, 1, "the obsolete key-bound browser subscription is removed exactly once")
    assert.equal(after.browserSubscribeCalls, 1, "one replacement subscription is created with the current box key")
    assert.equal(state.counts.get("GET /push/key"), 1)
    assert.equal(state.counts.get("POST /push/subscribe"), 1, "rapid Confirm persists exactly one replacement subscription")
    assert.deepEqual(after.lastSubscribeOptions, {
      userVisibleOnly: true,
      applicationServerKey: [4, ...Array(64).fill(1)],
    })
    assert.deepEqual(state.pushSubscriptionBodies, [PUSH_SUBSCRIPTION_JSON])
    assert.equal(state.counts.get("GET /sw.js") || 0, 0)
    assert.equal(after.serviceWorkerRegistrations, 0)

    proof.stalePushKeyReplacement = {
      viewport: LIVE_SURFACE_INVENTORY.viewports.phone,
      statusRequestEndpoint: PUSH_ENDPOINT,
      exactCause: signingResetCause,
      before,
      after,
      requests: Object.fromEntries(state.counts),
      diagnostics,
    }
    await screenshot(page, "phone-09-push-signing-key-replaced.png")
    await context.tracing.stop({ path: path.join(ARTIFACT_DIR, "phone-push-signing-key-replacement-trace.zip") })
    await assertNoErrorOverlay(page, diagnostics)
    await context.close()
  })

  await t.test("missing Brain memory deep link names its cause only after a successful observed read", { timeout: 60_000, skip: assistOnly || selectedViewport === "desktop" || selectedViewport === "phone-navigation" || selectedViewport === "phone-brand-dna" }, async (deepLinkJourney) => {
    const state = createMockState()
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, reducedMotion: "reduce" })
    deepLinkJourney.after(async () => { await closeContext(context) })
    const page = await context.newPage()
    page.setDefaultTimeout(30_000)
    await installMockApi(page, baseUrl, state)
    const diagnostics = startDiagnostics(page, "missing Brain memory deep link")
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true })
    const direct = new URL(baseUrl)
    direct.searchParams.set("view", "brain/memory")
    direct.searchParams.set("lane", "core")
    direct.searchParams.set("memory", "missing-memory-proof")
    direct.searchParams.set("proof", "preserved")
    await page.goto(direct.toString(), { waitUntil: "domcontentloaded", timeout: 60_000 })
    await neutralizeDevToolbar(page)
    const exactCause = "Memory missing-memory-proof is not in the current 200-record Brain window. It may have aged out, been removed, or the copied link may be wrong."
    await page.getByText(exactCause, { exact: true }).waitFor({ state: "visible" })
    await page.waitForURL((url) => url.searchParams.get("view") === "brain/memory" && url.searchParams.get("lane") === "core" && url.searchParams.get("proof") === "preserved" && !url.searchParams.has("memory"))
    assert.ok((state.counts.get("GET /brain/api/memories") || 0) >= 1, "the missing-link cause is emitted only after the fixture returns a successful Brain read")
    assert.equal(await page.locator('[role="dialog"]:visible').count(), 0, "an absent record never opens the wrong memory detail")
    assert.equal(new URL(page.url()).pathname, "/", "the canonical shell owns the deep link without a redirect")
    assert.equal(state.counts.get("GET /sw.js") || 0, 0, "the direct Next journey does not request the production-owned worker")
    await screenshot(page, "phone-07-missing-memory-link.png")
    await context.tracing.stop({ path: path.join(ARTIFACT_DIR, "phone-missing-memory-link-trace.zip") })
    await assertNoErrorOverlay(page, diagnostics)
    proof.brainMissingMemoryDeepLink = {
      input: direct.toString(),
      output: page.url(),
      exactCause,
      brainReads: state.counts.get("GET /brain/api/memories") || 0,
      diagnostics,
    }
    await context.close()
  })

  // The aggregate coverage check is only meaningful after a FULL run, so it
  // skips whenever any subset was selected. assistOnly is such a subset, and
  // selectedViewport.length covers every viewport selection rather than the
  // two that happened to exist when each side of this conflict was written.
  await t.test("phone interaction ledger has no unvisited inventory entry", { skip: assistOnly || selectedViewport.length > 0 }, () => {
    const receipt = phoneCoverageReceipt(phoneCoverage)
    proof.phoneInteractionCoverage = receipt
    assert.deepEqual(receipt.missing, [], `every inventoried phone interaction has evidence; missing=${receipt.missing.join(", ")}`)
  })
})
