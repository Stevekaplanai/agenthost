import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const ROOT = path.join(process.cwd(), "dashboard");
const source = fs.readFileSync(path.join(ROOT, "components", "agenthost", "agents-view.tsx"), "utf8");
const dashboardRequire = createRequire(path.join(ROOT, "package.json"));
const typescript = dashboardRequire("typescript");

function loadAgentsView() {
  const javascript = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
      jsx: typescript.JsxEmit.ReactJSX,
    },
  }).outputText;
  const React = dashboardRequire("react");
  const hookState = [];
  let hookCursor = 0;
  const ReactRuntime = {
    ...React,
    useMemo(factory) { return factory(); },
    useState(initial) {
      const index = hookCursor;
      hookCursor += 1;
      if (!(index in hookState)) {
        hookState[index] = typeof initial === "function" ? initial() : initial;
      }
      const setState = (next) => {
        hookState[index] = typeof next === "function" ? next(hookState[index]) : next;
      };
      return [hookState[index], setState];
    },
  };
  const actionHandlers = new Map();
  const toggleHandlers = new Map();
  const modalCloseHandlers = new Map();
  const textFromNode = (node) => {
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(textFromNode).join("");
    if (React.isValidElement(node)) return textFromNode(node.props.children);
    return "";
  };
  const Passthrough = ({ children, title, actions, onClick, label, className, disabled }) => {
    if (onClick) actionHandlers.set(textFromNode(children).trim(), onClick);
    return React.createElement(
      "section",
      { className, disabled, "aria-label": label },
      title,
      actions,
      children,
    );
  };
  const Toggle = ({ checked, disabled, label, onChange }) => {
    toggleHandlers.set(label, onChange);
    return React.createElement("button", {
    type: "button",
    "aria-label": label,
    "aria-pressed": checked,
    disabled,
    });
  };
  const Modal = ({ open, title, subtitle, children, footer, onClose }) => {
    if (!open) return null;
    modalCloseHandlers.set(textFromNode(title).trim(), onClose);
    return React.createElement("section", { "data-modal": true }, title, subtitle, children, footer);
  };
  const Icon = () => React.createElement("svg");
  const runtime = {
    react: ReactRuntime,
    "react/jsx-runtime": dashboardRequire("react/jsx-runtime"),
    "lucide-react": new Proxy({}, { get: () => Icon }),
    "@/lib/agenthost-data": {
      ENGINE_ORDER: ["claude", "codex", "deepseek", "kimi", "gemini", "hermes", "cursor"],
    },
    "@/lib/brand": { getBuyerBrand: () => ({ name: "AgentHost" }) },
    "@/lib/utils": { cn: (...values) => values.filter(Boolean).join(" ") },
    "./primitives": {
      Btn: Passthrough,
      HorizontalRail: Passthrough,
      Modal,
      MonoLabel: Passthrough,
      Panel: Passthrough,
      StatusDot: Passthrough,
      Toggle,
    },
  };
  const loaded = { exports: {} };
  new Function("module", "exports", "require", javascript)(
    loaded,
    loaded.exports,
    (id) => Object.hasOwn(runtime, id) ? runtime[id] : dashboardRequire(id),
  );
  return {
    React,
    AgentsView: loaded.exports.AgentsView,
    interactions: { actionHandlers, toggleHandlers, modalCloseHandlers },
    resetHooks() {
      hookCursor = 0;
      actionHandlers.clear();
      toggleHandlers.clear();
      modalCloseHandlers.clear();
    },
  };
}

test("AgentsView is an integration-ready live room, not the recovered fixture", () => {
  for (const contract of [
    "roster: RosterAgent[]",
    "board: BoardSnapshot | null",
    "profiles: AgentProfileRecord[] | null",
    "profilesProblem: string | null",
    "profilesObservedAt: number | null",
    "settings: AgentHostSettings | null",
    "settingsProblem: string | null",
    "settingsSaving: boolean",
    "onRefresh: () => void",
    "onOpenThread: (id: AgentId) => void",
    "onOpenTerminal: (id: AgentId) => void",
    "onUpdateSettings: (patch: Record<string, unknown>) => Promise<string | null>",
  ]) assert.ok(source.includes(contract), `missing live prop contract: ${contract}`);

  assert.match(source, /profiles\?\.find\(\(item\) => item\.id === agent\.id\)/);
  assert.match(source, /settings\.llm\.roster\[agent\.id\]/);
  assert.match(source, /profile\.capabilities\[key\]/);
  assert.match(source, /onOpenThread\(agent\.id\)/);
  assert.match(source, /onOpenTerminal\(agent\.id\)/);
  assert.match(source, /onUpdateSettings\(patch\)/);
  assert.match(source, /<StatusDot status=\{agent\.status\}/,
    "status dots must render the observed roster status");
  assert.doesNotMatch(source, /<StatusDot status=["']/,
    "the room must not hard-code a health dot");

  for (const prototypeOnly of [
    /\bAGENTS\b/,
    /READY_CAPABILITIES/,
    /createInitialParticipation/,
    /changed locally in the prototype/i,
    /Fixture only/i,
    /Prototype records/i,
  ]) assert.doesNotMatch(source, prototypeOnly);
  assert.doesNotMatch(source, /function levelFor|function badgesFor/,
    "the room must not invent levels or badges from locally authored thresholds");
  assert.doesNotMatch(source, /href=["']\/chat/);
  assert.doesNotMatch(source, /\/?\?window=/);
  assert.doesNotMatch(source, /window\.location/);
  assert.doesNotMatch(source, /window\.confirm/);

  assert.match(source, /gunmetal-toolbar flex shrink-0 flex-col gap-3[\s\S]*sm:flex-row sm:items-center/,
    "the room header must stack on phones and become a row only when it fits");
  assert.match(source, /className="w-full whitespace-nowrap sm:ml-auto sm:w-auto"/,
    "the refresh control must not crush the phone header");
  assert.match(source, /className="min-h-11 w-full whitespace-nowrap"[\s\S]{0,400}Open team thread/,
    "the selected-agent thread action must have a 44px phone target");
  assert.match(source, /className="min-h-11 w-full whitespace-nowrap"[\s\S]{0,400}Open Work terminal/,
    "the selected-agent terminal action must have a 44px phone target");
});

test("AgentsView renders observed readiness and invokes real controls", async () => {
  const { React, AgentsView, interactions, resetHooks } = loadAgentsView();
  const { renderToStaticMarkup } = dashboardRequire("react-dom/server");
  const done = {
    id: "t_done",
    title: "Closed task",
    status: "done",
    lane: "done",
    actions: [],
    transitions: [],
    destinations: { details: "", chat: "" },
    assignee: "claude",
  };
  const running = { ...done, id: "t_running", title: "Running task", status: "running", lane: "running" };
  const review = { ...done, id: "t_review", title: "Review task", status: "review", lane: "review" };
  const roster = [{
    id: "claude",
    name: "Claude",
    role: "Build + refactor",
    color: "#ff6a3d",
    status: "running",
    statusDetail: "Working from the observed box state",
    currentTask: "Running task",
    turnsToday: 7,
    tokensIn: 1200,
    tokensOut: 400,
    repo: "agenthost-internal",
    branch: "codex/example",
    lastActiveAt: Date.now(),
    observedAt: Date.now(),
  }];
  const profiles = [{
    id: "claude",
    label: "Claude",
    installed: true,
    routed: true,
    color: null,
    bin: "claude",
    chatAdapter: "claude",
    autoJail: true,
    role: null,
    provider: "subscription OAuth",
    fallback: null,
    capabilities: {
      chat: { state: "available" },
      terminal: { state: "unavailable", reasonCode: "NO_CREDENTIAL" },
      unattended: { state: "available" },
      review: { state: "unavailable", reasonCode: "NOT_APPROVED" },
    },
    runtimeState: "running",
    workspace: "/data/home/agent/work",
    isolationStatus: "jailed",
    autonomyLevel: 1,
    todaySpend: { tokens: 1600, cost: 0 },
    limits: null,
  }];
  const settings = {
    llm: { roster: { claude: { active: true, inChat: true } } },
    providers: { moonshot: { enabled: false, modelId: "kimi-k3" } },
  };
  const board = {
    available: true,
    lanes: [],
    columns: { queued: [], running: [running], awaiting: [], review: [review], done: [done], blocked: [] },
    tasks: [running, review, done],
  };
  const openedThreads = [];
  const openedTerminals = [];
  const settingsPatches = [];

  resetHooks();
  const html = renderToStaticMarkup(React.createElement(AgentsView, {
    roster,
    board,
    profiles,
    profilesProblem: null,
    profilesObservedAt: Date.now(),
    settings,
    settingsProblem: null,
    settingsSaving: false,
    onRefresh() {},
    onOpenThread(id) { openedThreads.push(id); },
    onOpenTerminal(id) { openedTerminals.push(id); },
    async onUpdateSettings(patch) {
      settingsPatches.push(patch);
      return null;
    },
  }));

  assert.match(html, /Development agents/);
  assert.match(html, /Observed profiles and settings from this box/);
  assert.match(html, /2\/4 capabilities/);
  assert.match(html, /NO_CREDENTIAL/);
  assert.match(html, /The required login or credential is missing/);
  assert.match(html, /NOT_APPROVED/);
  assert.match(html, /This engine is not approved for this kind of work/);
  assert.match(html, /1 closed/);
  assert.match(html, /1 running/);
  assert.match(html, />review<\/section><\/div><p[^>]*>1<\/p>/);
  assert.match(html, /Building and refactoring across many files at once/);
  assert.match(html, /Will keep going when a shorter answer would do/);
  assert.match(html, /Available for work/);
  assert.match(html, /In team chat/);
  assert.match(html, /Turning this off stops new eligible work from routing to this engine/);
  assert.match(html, /Turning this off removes this engine from normal team conversation routing/);
  assert.match(html, /Open team thread/);
  assert.match(html, /Open Work terminal/);
  assert.match(html, /Interactive terminal unavailable[\s\S]*The required login or credential is missing/);
  assert.match(html, /disabled=""[\s\S]{0,180}Open Work terminal/,
    "an unavailable terminal must not look or behave like a live action");
  assert.doesNotMatch(html, /href="\/chat/);
  assert.doesNotMatch(html, /\/?\?window=/);

  interactions.actionHandlers.get("Open team thread")();
  assert.deepEqual(openedThreads, ["claude"]);
  assert.deepEqual(openedTerminals, [], "the unavailable terminal must send no navigation callback");
  assert.deepEqual(settingsPatches, []);
});

test("AgentsView separates control failures from roster cause and waits for profiles", () => {
  const { React, AgentsView, resetHooks } = loadAgentsView();
  const { renderToStaticMarkup } = dashboardRequire("react-dom/server");
  resetHooks();
  const html = renderToStaticMarkup(React.createElement(AgentsView, {
    roster: [{
      id: "claude",
      name: "Claude",
      role: "Build + refactor",
      color: "#ff6a3d",
      status: "idle",
      statusDetail: "Idle according to the observed roster",
    }],
    board: null,
    profiles: null,
    profilesProblem: "profile request failed",
    profilesObservedAt: null,
    settings: null,
    settingsProblem: "settings request failed",
    settingsSaving: false,
    onRefresh() {},
    onOpenThread() {},
    onOpenTerminal() {},
    async onUpdateSettings() { return null; },
  }));

  assert.match(html, /Capabilities[\s\S]{0,300}waiting/);
  assert.match(html, /Agent controls degraded:[\s\S]{0,200}profile request failed/);
  assert.match(html, /Observed cause:[\s\S]{0,200}Idle according to the observed roster/);
  assert.doesNotMatch(html, /Observed cause:[\s\S]{0,200}request failed/);
});

test("Available-for-work enable requires in-app confirmation before one update", async () => {
  const { React, AgentsView, interactions, resetHooks } = loadAgentsView();
  const { renderToStaticMarkup } = dashboardRequire("react-dom/server");
  const settingsPatches = [];
  const props = {
    roster: [{
      id: "claude",
      name: "Claude",
      role: "Build + refactor",
      color: "#ff6a3d",
      status: "idle",
      statusDetail: "Ready but not currently assigned",
    }],
    board: null,
    profiles: null,
    profilesProblem: null,
    profilesObservedAt: null,
    settings: {
      llm: { roster: { claude: { active: false, inChat: true } } },
      providers: { moonshot: { enabled: false, modelId: "kimi-k3" } },
    },
    settingsProblem: null,
    settingsSaving: false,
    onRefresh() {},
    onOpenThread() {},
    onOpenTerminal() {},
    async onUpdateSettings(patch) {
      settingsPatches.push(patch);
      return null;
    },
  };
  const render = () => {
    resetHooks();
    return renderToStaticMarkup(React.createElement(AgentsView, props));
  };

  let html = render();
  assert.match(html, /Turning this on can dispatch eligible queued work/);
  interactions.toggleHandlers.get("Available for work")(true);
  assert.deepEqual(settingsPatches, [], "opening the confirmation must not write settings");

  html = render();
  assert.match(html, /Eligible queued work may dispatch to Claude/);
  assert.match(html, /model spend may resume/);
  interactions.actionHandlers.get("Cancel")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(settingsPatches, [], "Cancel must send zero updates");
  assert.doesNotMatch(render(), /Eligible queued work may dispatch to Claude/);

  interactions.toggleHandlers.get("Available for work")(true);
  render();
  interactions.actionHandlers.get("Confirm availability")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(settingsPatches, [
    { llm: { roster: { claude: { active: true } } } },
  ], "Confirm must send exactly one enable update");
});

test("team-chat and paid Moonshot enablement require in-app confirmation before one update", async () => {
  const { renderToStaticMarkup } = dashboardRequire("react-dom/server");

  for (const scenario of [
    {
      id: "claude",
      name: "Claude",
      toggle: "In team chat",
      confirm: "Confirm team chat",
      consequence: /Claude will join normal team conversation routing.*model spend/i,
      settings: {
        llm: { roster: { claude: { active: true, inChat: false } } },
        providers: { moonshot: { enabled: false, modelId: "kimi-k3" } },
      },
      patch: { llm: { roster: { claude: { inChat: true } } } },
    },
    {
      id: "kimi",
      name: "Kimi",
      toggle: "Moonshot route enabled",
      confirm: "Confirm Moonshot",
      consequence: /metered Moonshot provider requests/i,
      settings: {
        llm: { roster: {} },
        providers: { moonshot: { enabled: false, modelId: "kimi-k3" } },
      },
      patch: { providers: { moonshot: { enabled: true } } },
    },
  ]) {
    const { React, AgentsView, interactions, resetHooks } = loadAgentsView();
    const updates = [];
    const props = {
      roster: [{
        id: scenario.id,
        name: scenario.name,
        role: "Agent",
        color: "#ff6a3d",
        status: "idle",
        statusDetail: "Observed idle",
      }],
      board: null,
      profiles: null,
      profilesProblem: null,
      profilesObservedAt: null,
      settings: scenario.settings,
      settingsProblem: null,
      settingsSaving: false,
      onRefresh() {},
      onOpenThread() {},
      onOpenTerminal() {},
      async onUpdateSettings(patch) { updates.push(patch); return null; },
    };
    const render = () => {
      resetHooks();
      return renderToStaticMarkup(React.createElement(AgentsView, props));
    };

    render();
    interactions.toggleHandlers.get(scenario.toggle)(true);
    assert.deepEqual(updates, [], `${scenario.toggle} wrote before confirmation`);
    const confirmation = render();
    assert.match(confirmation, scenario.consequence);
    interactions.actionHandlers.get("Cancel")();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(updates, [], `${scenario.toggle} Cancel wrote settings`);

    render();
    interactions.toggleHandlers.get(scenario.toggle)(true);
    render();
    interactions.actionHandlers.get(scenario.confirm)();
    interactions.actionHandlers.get(scenario.confirm)();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(updates, [scenario.patch], `${scenario.toggle} confirmation must write exactly once`);
  }
});

test("work, team-chat, and Moonshot OFF paths review exact before/after consequences before one update", async () => {
  const { renderToStaticMarkup } = dashboardRequire("react-dom/server");

  for (const scenario of [
    {
      id: "claude",
      name: "Claude",
      toggle: "Available for work",
      title: "Stop new work from routing to Claude?",
      confirm: "Confirm stop new work",
      before: /Before[\s\S]*New eligible work can route to Claude/i,
      after: /After[\s\S]*New eligible work stops routing to Claude[\s\S]*Work already running is not cancelled/i,
      settings: {
        llm: { roster: { claude: { active: true, inChat: true } } },
        providers: { moonshot: { enabled: false, modelId: "kimi-k3" } },
      },
      patch: { llm: { roster: { claude: { active: false } } } },
      failure: "the gate refused work disablement",
    },
    {
      id: "claude",
      name: "Claude",
      toggle: "In team chat",
      title: "Remove Claude from team chat?",
      confirm: "Confirm remove from chat",
      before: /Before[\s\S]*Claude can join normal team conversation routing/i,
      after: /After[\s\S]*Claude stops receiving normal team conversation turns[\s\S]*Work availability does not change/i,
      settings: {
        llm: { roster: { claude: { active: true, inChat: true } } },
        providers: { moonshot: { enabled: false, modelId: "kimi-k3" } },
      },
      patch: { llm: { roster: { claude: { inChat: false } } } },
      failure: "the gate refused team-chat disablement",
    },
    {
      id: "kimi",
      name: "Kimi",
      toggle: "Moonshot route enabled",
      title: "Disable the Moonshot route for Kimi?",
      confirm: "Confirm disable Moonshot",
      before: /Before[\s\S]*Kimi can start future Moonshot provider requests/i,
      after: /After[\s\S]*Future Kimi provider replies stop[\s\S]*request already in flight is not cancelled/i,
      settings: {
        llm: { roster: {} },
        providers: { moonshot: { enabled: true, modelId: "kimi-k3" } },
      },
      patch: { providers: { moonshot: { enabled: false } } },
      failure: "the gate refused Moonshot disablement",
    },
  ]) {
    const { React, AgentsView, interactions, resetHooks } = loadAgentsView();
    const updates = [];
    let releaseFirst;
    let attempt = 0;
    const props = {
      roster: [{
        id: scenario.id,
        name: scenario.name,
        role: "Agent",
        color: "#ff6a3d",
        status: "idle",
        statusDetail: "Observed idle",
      }],
      board: null,
      profiles: null,
      profilesProblem: null,
      profilesObservedAt: null,
      settings: scenario.settings,
      settingsProblem: null,
      settingsSaving: false,
      onRefresh() {},
      onOpenThread() {},
      onOpenTerminal() {},
      async onUpdateSettings(patch) {
        updates.push(patch);
        attempt += 1;
        if (attempt === 1) return new Promise((resolve) => { releaseFirst = () => resolve(scenario.failure); });
        return null;
      },
    };
    const render = () => {
      resetHooks();
      return renderToStaticMarkup(React.createElement(AgentsView, props));
    };

    render();
    interactions.toggleHandlers.get(scenario.toggle)(false);
    assert.deepEqual(updates, [], `${scenario.toggle} wrote before review`);
    let confirmation = render();
    assert.match(confirmation, scenario.before);
    assert.match(confirmation, scenario.after);
    interactions.actionHandlers.get("Cancel")();
    assert.deepEqual(updates, [], `${scenario.toggle} Cancel wrote settings`);
    assert.doesNotMatch(render(), scenario.before);

    interactions.toggleHandlers.get(scenario.toggle)(false);
    render();
    interactions.actionHandlers.get(scenario.confirm)();
    interactions.actionHandlers.get(scenario.confirm)();
    assert.deepEqual(updates, [scenario.patch], `${scenario.toggle} rapid Confirm must synchronously collapse to one update`);

    confirmation = render();
    assert.match(confirmation, /disabled=""/, "confirmation controls must lock while the write is in flight");
    interactions.modalCloseHandlers.get(scenario.title)();
    assert.match(render(), scenario.before, "the modal backdrop/Close path dismissed an in-flight write");

    releaseFirst();
    await new Promise((resolve) => setImmediate(resolve));
    const failed = render();
    assert.match(failed, new RegExp(scenario.failure));
    assert.match(failed, scenario.before, "a failed OFF write closed its consequence modal");

    interactions.actionHandlers.get(scenario.confirm)();
    interactions.actionHandlers.get(scenario.confirm)();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(updates, [scenario.patch, scenario.patch], `${scenario.toggle} retry must issue exactly one new update`);
    assert.doesNotMatch(render(), scenario.before, "a successful OFF write did not close its modal");
  }
});

test("agent-control confirmation keeps and announces the box cause", async () => {
  const { React, AgentsView, interactions, resetHooks } = loadAgentsView();
  const { renderToStaticMarkup } = dashboardRequire("react-dom/server");
  const props = {
    roster: [{ id: "claude", name: "Claude", role: "Agent", color: "#ff6a3d", status: "idle", statusDetail: "Observed idle" }],
    board: null,
    profiles: null,
    profilesProblem: null,
    profilesObservedAt: null,
    settings: {
      llm: { roster: { claude: { active: true, inChat: false } } },
      providers: { moonshot: { enabled: false, modelId: "kimi-k3" } },
    },
    settingsProblem: null,
    settingsSaving: false,
    onRefresh() {}, onOpenThread() {}, onOpenTerminal() {},
    async onUpdateSettings() { return "the gate refused team-chat enablement"; },
  };
  const render = () => { resetHooks(); return renderToStaticMarkup(React.createElement(AgentsView, props)); };

  render();
  interactions.toggleHandlers.get("In team chat")(true);
  render();
  interactions.actionHandlers.get("Confirm team chat")();
  await new Promise((resolve) => setImmediate(resolve));
  const failed = render();
  assert.match(failed, /role="alert"/);
  assert.match(failed, /the gate refused team-chat enablement/);

  assert.match(source, /onClose=\{\(\) => \{ if \(!confirmingControl\) setPendingEnableId\(null\) \}\}/,
    "availability confirmation cannot close while its write is in flight");
  assert.match(source, /disabled=\{confirmingControl\} onClick=\{\(\) => setPendingEnableId\(null\)\}/,
    "availability Cancel must lock while Confirm is in flight");
  assert.equal((source.match(/setControlProblem\(null\)/g) ?? []).length >= 4, true,
    "each control journey must clear a previous operation's failure before opening");
});
