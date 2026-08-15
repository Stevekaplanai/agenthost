import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const ROOT = path.join(process.cwd(), "dashboard");
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");

const api = read("lib", "api.ts");
const live = read("lib", "live.ts");
const navigation = read("components", "agenthost", "navigation.ts");
const dialogs = read("components", "agenthost", "dialogs.tsx");
const settings = read("components", "agenthost", "settings.tsx");
const agents = read("components", "agenthost", "agents-view.tsx");
const commandCenter = read("components", "agenthost", "command-center.tsx");
const agentHostComponents = path.join(ROOT, "components", "agenthost");
const legacyAgentProfile = path.join(agentHostComponents, "agent-profile.tsx");
const require = createRequire(import.meta.url);
const dashboardRequire = createRequire(path.join(ROOT, "package.json"));
const typescript = dashboardRequire("typescript");
const settingsLib = require(path.join(process.cwd(), "container", "settings-lib.js"));

function loadDashboardModule(source, { append = "", fetchImpl, runtime = {} } = {}) {
  const javascript = typescript.transpileModule(`${source}\n${append}`, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
      jsx: typescript.JsxEmit.ReactJSX,
    },
  }).outputText;
  const loaded = { exports: {} };
  const localRequire = (id) => Object.hasOwn(runtime, id) ? runtime[id] : dashboardRequire(id);
  new Function("module", "exports", "require", "process", "fetch", javascript)(
    loaded,
    loaded.exports,
    localRequire,
    process,
    fetchImpl,
  );
  return loaded.exports;
}

function reactRuntime() {
  const React = dashboardRequire("react");
  const Passthrough = ({ children }) => React.createElement("div", null, children);
  const Icon = () => React.createElement("svg");
  return {
    React,
    runtime: {
      react: React,
      "react/jsx-runtime": dashboardRequire("react/jsx-runtime"),
      "lucide-react": new Proxy({}, { get: () => Icon }),
      "@/lib/agenthost-data": {
        ENGINE_ORDER: ["claude", "codex", "deepseek", "kimi", "gemini", "hermes", "cursor"],
        ROSTER: [
          ["claude", "Claude"], ["codex", "Codex"], ["deepseek", "DeepSeek"],
          ["kimi", "Kimi"], ["gemini", "Gemini"], ["hermes", "Hermes"], ["cursor", "Cursor"],
        ].map(([id, name]) => ({ id, name })),
      },
      "@/lib/api": { testMoonshotProvider: async () => ({}) },
      "@/lib/brand": {
        getBuyerBrand: () => ({
          id: "dev",
          name: "AgentHost",
          workspaceName: "AgentHost Workspace",
          searchLabel: "Search AgentHost",
        }),
      },
      "@/lib/utils": { cn: (...values) => values.filter(Boolean).join(" ") },
      "./two-factor-settings": { TwoFactorSettings: Passthrough },
      "./push-notification-settings": { PushNotificationSettings: Passthrough },
      "./primitives": {
        Btn: Passthrough,
        HorizontalRail: Passthrough,
        Modal: Passthrough,
        MonoLabel: Passthrough,
        Panel: Passthrough,
        StatusDot: Passthrough,
        Toggle: Passthrough,
      },
    },
  };
}

function findElement(node, predicate) {
  if (!node || typeof node !== "object") return null;
  if (predicate(node)) return node;
  const children = Array.isArray(node.props?.children) ? node.props.children : [node.props?.children];
  for (const child of children) {
    const found = findElement(child, predicate);
    if (found) return found;
  }
  return null;
}

test("Dev owns one mode-specific Agents room and Systems no longer duplicates it", () => {
  assert.match(navigation, /key: "agents", label: "Agents"/);
  assert.match(navigation, /agents:\s*\[[\s\S]*key: "profile"[\s\S]*route: "systems\/agents"/);
  const systems = navigation.match(/systems:\s*\[([\s\S]*?)\n\s*\],\n\}/)?.[1] || "";
  assert.doesNotMatch(systems, /key: "profile"/);
  assert.match(commandCenter, /activeRoom === "agents"[\s\S]*<AgentsView/);
  assert.doesNotMatch(commandCenter, /<AgentProfile/);
});

test("the dead standalone AgentProfile component stays deleted and unreachable", () => {
  assert.equal(fs.existsSync(legacyAgentProfile), false,
    "agent-profile.tsx must not return after AgentsView became the only profile surface");
  const reachableSource = fs.readdirSync(agentHostComponents)
    .filter((name) => /\.tsx?$/.test(name))
    .map((name) => fs.readFileSync(path.join(agentHostComponents, name), "utf8"))
    .join("\n");
  assert.doesNotMatch(reachableSource, /from ["']\.\/agent-profile["']|<AgentProfile/,
    "no generated dashboard component may import or render the deleted page");
});

test("the dashboard consumes the existing typed settings and observed profile APIs", () => {
  for (const marker of [
    "export interface AgentHostSettings",
    "export interface SettingsPayload",
    "export interface AgentProfilePayload",
    "fetchSettings",
    "updateSettings",
    "resetSettings",
    "fetchAgentProfiles",
  ]) assert.ok(api.includes(marker), `${marker} is missing from the API contract`);
  assert.match(api, /return putJson\("\/api\/settings", \{ set: set \}\)/);
  assert.match(api, /\/api\/settings\/reset/);
  assert.match(api, /\/profiles\/data/);
  assert.match(live, /export function useSettings/);
  assert.match(live, /export function useAgentProfiles/);
});

test("every JSON transport rejects a successful empty or malformed response with its cause", async () => {
  const requests = [
    ["GET", (client) => client.fetchMode()],
    ["POST", (client) => client.setMode("dev")],
    ["PUT", (client) => client.updateSettings({ board: { autoDispatch: true } })],
    ["DELETE", (client) => client.deleteCronJob("job-1")],
    ["GET", (client) => client.fetchGrowthAccounts()],
    ["POST", (client) => client.createGrowthAccount({ name: "Test account" })],
    ["PUT", (client) => client.putGrowthDna("account-1", "brand", { content: "test", source: "client" })],
    ["GET", (client) => client.fetchMemories()],
  ];
  const badBodies = [
    ["", /empty response body; expected JSON/],
    ["{not-json", /malformed JSON/],
  ];

  for (const [body, cause] of badBodies) {
    for (const [method, request] of requests) {
      const client = loadDashboardModule(api, {
        fetchImpl: async (_url, init = {}) => {
          assert.equal(init.method ?? "GET", method);
          return { ok: true, status: 200, text: async () => body };
        },
      });
      await assert.rejects(request(client), cause, `${method} accepted an invalid successful response`);
    }
  }
});

test("Growth and Brain keep their explicit unconfigured 503 behavior", async () => {
  const response = {
    ok: false,
    status: 503,
    text: async () => JSON.stringify({ configured: false, error: "the brain is offline" }),
  };
  const growthClient = loadDashboardModule(api, { fetchImpl: async () => response });
  assert.deepEqual(await growthClient.fetchGrowthAccounts(), {
    configured: false,
    error: "the brain is offline",
  });

  const memoryClient = loadDashboardModule(api, { fetchImpl: async () => response });
  await assert.rejects(
    memoryClient.fetchMemories(),
    (error) => error?.name === "BrainNotConfigured" && error.message === "the brain is offline",
  );
});

test("Settings contains every legacy section as a real in-app control surface", () => {
  const legacy = [
    ["roster-title", "LLM Roster"],
    ["services-title", "Box Services"],
    ["channels-title", "Channels"],
    ["cost-title", "Cost & Budget"],
    ["schedule-title", "Schedule"],
    ["board-title", "Board"],
    ["git-ladder-title", "Git Ladder"],
    ["reporting-title", "Agent Reporting"],
    ["about-title", "About"],
  ];
  for (const [anchor, label] of legacy) {
    assert.ok(settings.includes(`anchor: "${anchor}"`), `${label} has no in-app pane`);
    assert.ok(settings.includes(`label: "${label}"`), `${label} was renamed or omitted`);
  }
  assert.match(dialogs, /<SettingsWorkspace/);
  assert.match(settings, /min-h-0 min-w-0 w-full flex-col overflow-hidden/);
  assert.match(settings, /className="w-full min-w-0 shrink-0 border-b/);
  assert.match(settings, /onSave\(patchFrom\(payload\.settings, draft\)\)/);
  assert.match(settings, /const PANE_RESET_PATHS/);
  assert.doesNotMatch(settings, /"services-title": "services"/);
  assert.match(settings, /resetPaths\.length === 0/);
  for (const path of [
    "llm.roster.claude.active",
    "services.openclaw.enabled",
    "channels.telegram.enabled",
    "cost.limitsEnabled",
    "schedule.sleep.enabled",
    "board.autoDispatch",
    "git.autonomyLevel",
    "agents.heartbeat",
  ]) assert.ok(settings.includes(`"${path}"`), `${path} is not wired into Settings`);
});

test("section default buttons use only resettable leaf keys from the existing backend contract", () => {
  const paths = [
    "llm.roster.claude.active", "llm.roster.cursor.inChat",
    "agents.kimi.role", "agents.kimi.limits.perRunUsd", "agents.kimi.limits.perDayUsd",
    "services.ollama.enabled", "services.openclaw.enabled",
    "providers.moonshot.enabled", "providers.moonshot.modelId",
    "channels.telegram.enabled", "channels.telegram.confirmGate", "channels.telegram.boardContext",
    "channels.discord.enabled", "channels.discord.confirmGate", "channels.discord.boardContext",
    "channels.whatsapp.enabled", "channels.whatsapp.confirmGate", "channels.whatsapp.boardContext",
    "cost.limitsEnabled", "cost.perChainUsd", "cost.chatDailyUsd", "cost.chatDailyTokens",
    "schedule.sleep.enabled", "schedule.sleep.start", "schedule.sleep.end",
    "board.autoDispatch", "board.stuckAlerts",
    "git.autonomyLevel", "git.reviewStrictness", "git.autoCommit",
    "agents.heartbeat",
  ];
  for (const settingPath of paths) assert.ok(settings.includes(`"${settingPath}"`), `${settingPath} is not covered by the reset map`);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-settings-reset-"));
  const file = path.join(directory, "settings.json");
  try {
    for (const settingPath of paths) {
      const result = settingsLib.resetPath(settingPath, file);
      assert.equal(result.error, undefined, `${settingPath} is not accepted by the backend reset contract`);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Dev agent onboarding is driven by observed capability reasons and real controls", () => {
  for (const code of [
    "NOT_INSTALLED",
    "NOT_WIRED",
    "NOT_APPROVED",
    "NO_CREDENTIAL",
    "DISABLED",
    "NOT_RUNNING",
  ]) assert.ok(agents.includes(code), `missing plain-language mapping for ${code}`);
  for (const capability of ["chat", "terminal", "unattended", "review"]) {
    assert.ok(agents.includes(`key: "${capability}"`), `missing ${capability} readiness`);
  }
  assert.match(agents, /const capability = profile \? profile\.capabilities\[key\] : undefined/);
  assert.match(agents, /function capabilityReason\([\s\S]*CAPABILITY_REASONS\[reason\]/);
  assert.match(agents, /capability\?\.reasonCode[\s\S]*capabilityReason\(capability\.reasonCode, brand\.name\)/);
  assert.match(agents, /settings\.llm\.roster\[agent\.id\]/);
  assert.match(agents, /onUpdateSettings/);
  assert.match(commandCenter, /onOpenThread=/);
  assert.match(commandCenter, /onOpenTerminal=/);
  assert.match(commandCenter, /onUpdateSettings=/);
  assert.doesNotMatch(agents, /Runs read-only by design|only engine wired to Telegram|Unattended runs are not enabled|not an Agent Room participant/);
});

test("Dev agent onboarding renders an omitted capability as unavailable instead of throwing", () => {
  const { React, runtime } = reactRuntime();
  const { renderToStaticMarkup } = dashboardRequire("react-dom/server");
  const module = loadDashboardModule(agents, { runtime });
  const html = renderToStaticMarkup(React.createElement(module.AgentsView, {
    roster: [{
      id: "codex",
      name: "Codex",
      role: "Build + review",
      color: "#60a5fa",
      status: "online",
      statusDetail: "Observed and ready",
    }],
    board: null,
    profiles: [{
      id: "codex",
      label: "Codex",
      installed: true,
      routed: true,
      capabilities: {
        chat: { state: "available" },
        terminal: { state: "available" },
        review: { state: "unavailable", reasonCode: "NOT_APPROVED" },
      },
      todaySpend: { tokens: 0, cost: 0 },
    }],
    profilesProblem: null,
    profilesObservedAt: null,
    settings: null,
    settingsProblem: null,
    settingsSaving: false,
    onRefresh() {},
    onOpenThread() {},
    onOpenTerminal() {},
    async onUpdateSettings() { return null; },
  }));

  assert.match(html, /Independent board work/);
  assert.match(html, /not reported/);
  assert.match(html, /The box did not report this capability/);
  assert.match(html, /2\/4 capabilities/);
});

test("NumberField ignores blank and intermediate invalid values until a real number exists", () => {
  const { runtime } = reactRuntime();
  const module = loadDashboardModule(settings, {
    append: "export { NumberField };",
    runtime,
  });
  const changes = [];
  const tree = module.NumberField({
    label: "Budget per chain",
    value: 12,
    min: 1,
    onChange: (value) => changes.push(value),
  });
  const input = findElement(tree, (candidate) => candidate.type === "input");
  assert.ok(input, "NumberField did not render its number input");

  for (const value of ["", "-", "1e"]) input.props.onChange({ target: { value } });
  assert.deepEqual(changes, [], "an intermediate invalid value became a settings edit");
  input.props.onChange({ target: { value: "0" } });
  assert.deepEqual(changes, [], "a value below the published minimum became a settings edit");
  input.props.onChange({ target: { value: "2.5" } });
  assert.deepEqual(changes, [2.5]);
});

test("unsupported prototype toggles are not presented as working settings", () => {
  for (const falseControl of [
    "Broadcast notices to all agents",
    "Sanitized status projection",
    "Auto-recover stale ownership",
    "Start at login",
    "6 configured peers",
  ]) {
    assert.doesNotMatch(settings, new RegExp(falseControl, "i"));
  }
});
