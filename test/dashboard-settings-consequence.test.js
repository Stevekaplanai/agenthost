import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const ROOT = path.join(process.cwd(), "dashboard");
const settingsSource = fs.readFileSync(
  path.join(ROOT, "components", "agenthost", "settings.tsx"),
  "utf8",
);
const dashboardRequire = createRequire(path.join(ROOT, "package.json"));
const typescript = dashboardRequire("typescript");

function loadSettingsModule() {
  const javascript = typescript.transpileModule(settingsSource, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
      jsx: typescript.JsxEmit.ReactJSX,
    },
  }).outputText;
  const loaded = { exports: {} };
  const passthrough = ({ children }) => children;
  const icon = () => null;
  const runtime = {
    react: dashboardRequire("react"),
    "react/jsx-runtime": dashboardRequire("react/jsx-runtime"),
    "lucide-react": new Proxy({}, { get: () => icon }),
    "@/lib/api": { testMoonshotProvider: async () => ({}) },
    "@/lib/agenthost-data": {
      ENGINE_ORDER: ["claude", "codex", "deepseek", "kimi", "gemini", "hermes", "cursor"],
      ROSTER: [
        ["claude", "Claude"], ["codex", "Codex"], ["deepseek", "DeepSeek"],
        ["kimi", "Kimi"], ["gemini", "Gemini"], ["hermes", "Hermes"], ["cursor", "Cursor"],
      ].map(([id, name]) => ({ id, name })),
    },
    "@/lib/brand": { getBuyerBrand: () => ({ workspaceName: "AgentHost Workspace" }) },
    "@/lib/utils": { cn: (...values) => values.filter(Boolean).join(" ") },
    "./push-notification-settings": { PushNotificationSettings: passthrough },
    "./two-factor-settings": { TwoFactorSettings: passthrough },
    "./primitives": {
      Btn: passthrough,
      HorizontalRail: passthrough,
      Modal: passthrough,
      MonoLabel: passthrough,
      Toggle: passthrough,
    },
  };
  const localRequire = (id) => Object.hasOwn(runtime, id) ? runtime[id] : dashboardRequire(id);
  new Function("module", "exports", "require", javascript)(loaded, loaded.exports, localRequire);
  return loaded.exports;
}

function settingsFixture() {
  return {
    llm: {
      roster: {
        claude: { active: false, inChat: false },
        codex: { active: true, inChat: true },
      },
    },
    services: {
      ollama: { enabled: false },
      openclaw: { enabled: false },
    },
    providers: {
      moonshot: { enabled: false, modelId: "kimi-k3" },
    },
    channels: {
      telegram: { enabled: false, confirmGate: true, boardContext: false },
      discord: { enabled: false, confirmGate: true, boardContext: false },
    },
    cost: {
      limitsEnabled: true,
      perChainUsd: 15,
      chatDailyUsd: 50,
      chatDailyTokens: 1_000_000,
    },
    schedule: { sleep: { enabled: true, start: "22:00", end: "07:00" } },
    board: { autoDispatch: false, stuckAlerts: true },
    agents: {
      heartbeat: "milestone",
      deepseek: { role: "engineering", limits: { perRunUsd: 1, perDayUsd: 5 } },
      kimi: { role: "research", limits: { perRunUsd: 1, perDayUsd: 5 } },
    },
    git: { autonomyLevel: 2, reviewStrictness: 4, autoCommit: false },
  };
}

test("risky setting changes name their real consequence before persistence", () => {
  const { settingsConsequences } = loadSettingsModule();
  assert.equal(typeof settingsConsequences, "function");
  const saved = settingsFixture();
  saved.channels.telegram.enabled = true;
  const draft = structuredClone(saved);
  draft.cost.limitsEnabled = false;
  draft.channels.telegram.confirmGate = false;
  draft.board.autoDispatch = true;
  draft.git.autonomyLevel = 5;

  const consequences = settingsConsequences(saved, draft);
  assert.equal(consequences.length, 4);
  assert.match(consequences.join("\n"), /spend without these box caps/i);
  assert.match(consequences.join("\n"), /Telegram.*stop asking/i);
  assert.match(consequences.join("\n"), /ready board work.*automatically/i);
  assert.match(consequences.join("\n"), /merge.*independent review/i);
});

test("agent, channel, provider, quiet-hour, Kimi cap, and Git write changes cannot bypass consequence review", () => {
  const { settingsConsequences } = loadSettingsModule();
  const saved = settingsFixture();
  const draft = structuredClone(saved);
  draft.llm.roster.claude.active = true;
  draft.llm.roster.claude.inChat = true;
  draft.services.openclaw.enabled = true;
  draft.providers.moonshot.enabled = true;
  draft.channels.telegram.enabled = true;
  draft.channels.telegram.boardContext = true;
  draft.schedule.sleep.enabled = false;
  draft.agents.kimi.limits.perRunUsd = 2;
  draft.agents.kimi.limits.perDayUsd = 10;
  draft.git.reviewStrictness = 1;
  draft.git.autoCommit = true;

  const message = settingsConsequences(saved, draft).join("\n");
  assert.match(message, /Claude.*eligible.*work.*model spend/i);
  assert.match(message, /Claude.*team conversation/i);
  assert.match(message, /OpenClaw.*enabled/i);
  assert.match(message, /Moonshot.*metered/i);
  assert.match(message, /Telegram.*enabled/i);
  assert.match(message, /Telegram.*board context/i);
  assert.match(message, /quiet hours.*disabled.*autonomous/i);
  assert.match(message, /Kimi.*\$1.*\$2.*\$5.*\$10/i);
  assert.match(message, /review strictness.*4.*1/i);
  assert.match(message, /auto-commit.*enabled/i);
});

test("safe edits do not add a confirmation gate", () => {
  const { settingsConsequences } = loadSettingsModule();
  const saved = settingsFixture();
  const draft = structuredClone(saved);
  draft.git.autonomyLevel = 0;
  assert.deepEqual(settingsConsequences(saved, draft), []);
});

test("a completed save clears only the values that were actually submitted", () => {
  const { pendingEditsAfterSave } = loadSettingsModule();
  assert.deepEqual(
    pendingEditsAfterSave(
      { "git.autoCommit": true, "cost.perChainUsd": 25, "agents.heartbeat": "always" },
      { "git.autoCommit": true, "cost.perChainUsd": 15 },
    ),
    { "cost.perChainUsd": 25, "agents.heartbeat": "always" },
    "an edit made while an earlier save is pending must not be discarded by that response",
  );
});

test("a partial defaults reset reports what applied and the exact stopping cause", async () => {
  const { resetDefaultsSequentially } = loadSettingsModule();
  assert.equal(typeof resetDefaultsSequentially, "function");
  const calls = [];
  const result = await resetDefaultsSequentially(
    ["cost.perChainUsd", "cost.chatDailyUsd", "cost.chatDailyTokens"],
    async (path) => {
      calls.push(path);
      return path === "cost.chatDailyTokens" ? "the settings store refused the final reset" : null;
    },
  );

  assert.deepEqual(calls, ["cost.perChainUsd", "cost.chatDailyUsd", "cost.chatDailyTokens"]);
  assert.deepEqual(result, {
    appliedCount: 2,
    error: "the settings store refused the final reset",
  });
});

test("mixed cost and Kimi limit edits describe every changed number truthfully", () => {
  const { settingsConsequences } = loadSettingsModule();
  const saved = settingsFixture();
  const draft = structuredClone(saved);
  draft.cost.limitsEnabled = false;
  draft.cost.perChainUsd = 25;
  draft.cost.chatDailyUsd = 75;
  draft.cost.chatDailyTokens = 2_000_000;
  draft.agents.kimi.limits.perRunUsd = 2;
  draft.agents.kimi.limits.perDayUsd = 3;

  const message = settingsConsequences(saved, draft).join("\n");
  assert.match(message, /cost limits will be turned off/i);
  assert.match(message, /spending caps will change.*15.*25.*50.*75.*1,000,000.*2,000,000/i);
  assert.match(message, /Kimi spending limits will change.*\$1.*\$2.*\$5.*\$3/i);
  assert.doesNotMatch(message, /Kimi spending limits will increase/i,
    "a lowered daily limit cannot be described as an increase");
});

test("disabled channels and stopped services are never described as already delivering", () => {
  const { settingsConsequences } = loadSettingsModule();
  const saved = settingsFixture();
  const draft = structuredClone(saved);
  draft.channels.telegram.confirmGate = false;
  draft.channels.telegram.boardContext = true;
  draft.channels.discord.enabled = true;

  const message = settingsConsequences(saved, draft).join("\n");
  assert.match(message, /Telegram.*disabled.*will not ask until enabled/i);
  assert.match(message, /Telegram.*disabled.*board context.*will not be shared until enabled/i);
  assert.match(message, /Discord.*once OpenClaw is running/i);
  assert.doesNotMatch(message, /Discord will be enabled\. The box can receive and send/i);
});

test("Cancel cannot save, Confirm owns exactly one save call, and no retired settings route remains", () => {
  const cancelBody = settingsSource.match(/function cancelConsequenceSave\(\) \{([\s\S]*?)\n  \}/)?.[1] ?? "";
  const confirmBody = settingsSource.match(/async function confirmConsequenceSave\(\) \{([\s\S]*?)\n  \}/)?.[1] ?? "";
  assert.ok(cancelBody, "the consequence dialog has no explicit Cancel path");
  assert.doesNotMatch(cancelBody, /onSave\s*\(/, "Cancel sends a settings PUT");
  assert.ok(confirmBody, "the consequence dialog has no explicit Confirm path");
  assert.equal((confirmBody.match(/onSave\s*\(/g) ?? []).length, 1, "Confirm must send exactly one existing settings PUT");
  assert.match(confirmBody, /if \(finishSettingsSave\([\s\S]*?\)\) setPendingConsequenceSave\(null\)/,
    "a failed save must keep the consequence dialog open for retry");
  assert.match(settingsSource, /role="alert"[\s\S]{0,200}Settings were not saved/,
    "a failed consequential save must announce the gate's cause inside the open dialog");
  assert.match(settingsSource, /onClose=\{\(\) => \{ if \(!confirming\) cancelConsequenceSave\(\) \}\}/,
    "Escape and backdrop cannot hide a consequential settings write while it settles");
  assert.doesNotMatch(settingsSource, /href=\{?`?\/settings/, "Settings still links to the retired application");
  assert.match(settingsSource, /Review consequential settings changes/);
  assert.match(settingsSource, /resetAppliedCount > 0[\s\S]{0,240}defaults were applied before reset stopped — \$\{localProblem\}/,
    "a partial defaults reset must name both the applied count and the stopping cause");
  assert.match(settingsSource, /Defaults were not applied — \$\{localProblem\}/,
    "a first-path defaults failure must name its cause inside the still-open confirmation dialog");
  assert.match(settingsSource, /if \(await reset\(pendingReset\.paths\)\) setPendingReset\(null\)/,
    "only a fully successful defaults reset may close the confirmation dialog");
});

test("primary phone settings actions have 44px touch targets", () => {
  assert.match(settingsSource, /size="sm"\s+className="min-h-11"[\s\S]{0,750}Use defaults/);
  assert.match(settingsSource, /size="sm"\s+className="min-h-11"[\s\S]{0,400}Test connection/);
  assert.match(settingsSource, /variant="primary" className="min-h-11"[\s\S]{0,180}Save settings/);
  for (const field of ["function NumberField", "function TextField", "function TimeField", "function SelectField"]) {
    const start = settingsSource.indexOf(field);
    assert.notEqual(start, -1, `${field} is missing`);
    assert.match(settingsSource.slice(start, start + 900), /min-h-11/, `${field} needs a 44px receiving control`);
  }
  assert.match(settingsSource, /className="inline-flex min-h-11 items-center text-accent hover:underline"[\s\S]{0,180}AgentGlass by David Pallares/);
});
