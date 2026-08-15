import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const FIXTURE_FILE = path.join(import.meta.dirname, "fixtures", "frontend-collapse-contract-v1.json");
const contract = JSON.parse(fs.readFileSync(FIXTURE_FILE, "utf8"));
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");
const sourceText = (source) => read(...source.path.split("/"));

function assertSource(source, label) {
  assert.ok(source?.path, `${label} has no source path`);
  assert.ok(source?.contains, `${label} has no source marker`);
  assert.equal(fs.existsSync(path.join(ROOT, ...source.path.split("/"))), true, `${label} cites missing source ${source.path}`);
  assert.ok(sourceText(source).includes(source.contains), `${label} source marker is not present in ${source.path}: ${source.contains}`);
}

const REQUIRED_CAPABILITIES = [
  "shared-team-thread",
  "agent-conversation",
  "push-notification-entry",
  "gated-backlog-reminder",
  "canonical-board",
  "artifacts",
  "terminal",
  "reviews",
  "files",
  "brain-memories",
  "brain-lobes-nodes",
  "learning-skills-experiments",
  "mesh",
  "agents",
  "parallel-agent-lanes",
  "inventory",
  "loops",
  "multi-loops",
  "pause-resume-autonomy",
  "stop-room",
  "broadcast",
  "settings",
  "mode",
  "growth-accounts-brand-dna",
  "goals-okrs",
  "growth-operating-surfaces",
];

test("frontend collapse contract is pinned to the independently approved baseline", () => {
  assert.equal(contract.$schema, "agenthost-frontend-collapse-contract-v1");
  assert.equal(contract.contractVersion, 1);
  assert.equal(contract.baseline.commit, "b53cf45893b2b8f86d179097478e9708fed12516");
  assert.equal(contract.baseline.branch, "codex/frontend-collapse-step0");
  assert.equal(contract.redTeam.status, "PASS");
  assert.equal(contract.redTeam.round, 2);
  assert.equal(contract.redTeam.taskId, "CLAUDE-REDTEAM-FRONTEND-COLLAPSE-2026-08-08");
  assertSource(contract.redTeam.evidence, "red-team verdict");
  const verdict = sourceText(contract.redTeam.evidence);
  assert.match(verdict, /^# Superseded by the final zero-legacy route decision/m);
  assert.match(verdict, /^## Historical verdict: PASS/m);
  assert.match(verdict, /round: 2/);
  assert.equal(contract.dependencies.pr264, "merged");
});

test("the machine-readable capability ledger is complete, unique, and honest", () => {
  const ids = contract.capabilities.map((item) => item.id);
  assert.deepEqual(ids, REQUIRED_CAPABILITIES);
  assert.equal(new Set(ids).size, ids.length);

  const allowed = new Set(["live", "derived", "bridge", "sample", "contract_gate", "mixed"]);
  for (const item of contract.capabilities) {
    assert.ok(item.currentTruth, `${item.id} must state the current truth`);
    assert.ok(item.finalHome, `${item.id} must have one final home`);
    assert.ok(item.treatment, `${item.id} must say how it is handled`);
    assert.ok(allowed.has(item.state), `${item.id} has unknown state ${item.state}`);
    if (["live", "derived", "bridge", "mixed"].includes(item.state)) {
      assert.ok(item.proofSources?.length, `${item.id} claims working behavior without proof sources`);
      for (const sourceId of item.proofSources) {
        assert.ok(contract.sources[sourceId], `${item.id} cites unknown proof source ${sourceId}`);
        assertSource(contract.sources[sourceId], `${item.id}/${sourceId}`);
      }
    }
    if (item.state === "contract_gate") {
      assert.ok(item.blockedBy, `${item.id} needs the decision or implementation that blocks it`);
    }
  }
});

test("every final desktop room has a named phone entry point", () => {
  assert.deepEqual(contract.rooms.map((room) => room.id), ["overview", "work", "growth", "brain", "systems"]);
  const phoneLabels = [];
  for (const room of contract.rooms) {
    assert.deepEqual(Object.keys(room.desktopEntry), ["source", "label", "destination"]);
    assert.deepEqual(Object.keys(room.phoneEntry), ["kind", "source", "label", "destination"]);
    assert.ok(["tab", "sheet"].includes(room.phoneEntry.kind), `${room.id} has unsupported phone entry ${room.phoneEntry.kind}`);
    assert.ok(room.desktopEntry.source && room.desktopEntry.label && room.desktopEntry.destination, `${room.id} desktop entry is incomplete`);
    assert.ok(room.phoneEntry.source && room.phoneEntry.label && room.phoneEntry.destination, `${room.id} phone entry is incomplete`);
    assert.equal(room.phoneEntry.destination, room.desktopEntry.destination, `${room.id} desktop and phone entries disagree`);
    phoneLabels.push(room.phoneEntry.label);
  }
  assert.equal(new Set(phoneLabels).size, phoneLabels.length, "phone room labels must be unique");
});

test("all ten settings panes stay reachable inside the desktop and phone workspace", () => {
  const settings = read("dashboard", "components", "agenthost", "settings.tsx");
  const expected = [
    ["mode", "Mode", "mode-title"],
    ["llm-roster", "LLM Roster", "roster-title"],
    ["box-services", "Box Services", "services-title"],
    ["channels", "Channels", "channels-title"],
    ["cost-budget", "Cost & Budget", "cost-title"],
    ["schedule", "Schedule", "schedule-title"],
    ["board", "Board", "board-title"],
    ["git-ladder", "Git Ladder", "git-ladder-title"],
    ["agent-reporting", "Agent Reporting", "reporting-title"],
    ["about", "About", "about-title"],
  ];
  assert.deepEqual(contract.settingsSections.map(({ id, label, anchor }) => [id, label, anchor]), expected);
  for (const section of contract.settingsSections) {
    assert.equal(section.desktopEntry, `Settings & Mode > ${section.label}`);
    assert.equal(section.phoneEntry, `Settings & Mode sheet > ${section.label}`);
    assert.equal(section.destination, `SettingsWorkspace:${section.anchor}`);
    assertSource(section.source, `settings/${section.id}`);
    assert.ok(settings.includes(`anchor: "${section.anchor}"`), `the current Settings modal omits ${section.label}`);
    assert.ok(settings.includes(`label: "${section.label}"`), `the current Settings modal renames ${section.label}`);
  }
  assert.match(settings, /SETTINGS_SECTIONS\.map\(\(item\) =>/);
  assert.match(settings, /onClick=\{\(\) => setPane\(item\.anchor\)\}/);
  for (const section of contract.settingsSections) {
    assert.ok(settings.includes(`pane === "${section.anchor}"`), `${section.label} has a navigation control but no in-app pane`);
  }
});

test("tasks, objectives, artifacts, memories, agents, settings, and terminal have one destination contract", () => {
  const links = Object.fromEntries(contract.linkContracts.map((item) => [item.id, item]));
  assert.deepEqual(Object.keys(links), ["task", "objective", "artifact", "memory", "agent", "settings", "terminal"]);

  for (const link of Object.values(links)) {
    assert.ok(link.destination, `${link.id} has no destination`);
    assert.ok(link.identifier, `${link.id} does not say which identity survives navigation`);
    assert.ok(link.failureBehavior, `${link.id} does not name what happens when the target is unavailable`);
    assert.equal(link.preserveContext, true, `${link.id} is allowed to drop its target identity`);
    assert.ok(link.desktopEntry, `${link.id} has no desktop entry`);
    assert.ok(link.phoneEntry, `${link.id} has no phone entry`);
  }
  assert.equal(links.task.destination, "/?task=:encodedTaskId");
  assert.equal(links.objective.destination, "Work / Board / task detail");
  assert.equal(links.objective.substrate, "canonical-board");
  assert.equal(links.terminal.destination, "/terminal/");
  assert.equal(links.terminal.desktopEntry, "Work > Terminal");
  assert.equal(links.terminal.phoneEntry, "Work tab > Terminal");
});

test("the current source still contains the live witnesses named by the link contract", () => {
  const commandCenter = read("dashboard", "components", "agenthost", "command-center.tsx");
  const workbench = read("dashboard", "components", "agenthost", "workbench.tsx");
  const brainApi = read("dashboard", "lib", "api.ts");
  const workspace = read("dashboard", "components", "agenthost", "workspace-chat.tsx");
  const sidebar = read("dashboard", "components", "agenthost", "sidebar.tsx");
  const gate = read("container", "gate.js");

  assert.match(commandCenter, /new URLSearchParams\(window\.location\.search\)/);
  assert.match(commandCenter, /params\.get\("task"\)/);
  assert.match(commandCenter, /setNav\("board"\)/);
  assert.match(commandCenter, /if \(hit\) setOpenTask\(hit\)/);
  assert.match(workbench, /artifactViewUrl\(f\.name\)/);
  assert.match(brainApi, /\/brain\/api\/memories\?limit=\$\{Math\.min\(200, Math\.max\(1, limit\)\)\}/);
  assert.match(workspace, /onOpenAgent\(a\.id\)/);
  assert.match(sidebar, /onClick=\{onOpenSettings\}/);
  assert.match(sidebar, /export function MobileNav/);
  assert.match(sidebar, /onClick=\{onOpenSettings\}/);
  assert.match(gate, /const terminalHttpRoute = req\.method === "GET" && \(requestTarget\.pathname === "\/terminal\/" \|\| requestTarget\.pathname === "\/terminal\/token"\)/);
});

test("every notification family is classified and every Step 8 destination is live", () => {
  const gate = read("container", "gate.js");
  assert.deepEqual(contract.pushEntry.genericFamilies.map((item) => item.id), ["gated-backlog"]);
  assert.deepEqual(contract.pushEntry.linkedTaskFamilies.map((item) => item.id), [
    "wording-gate",
    "approval-needed",
    "autonomous-failure",
    "review-ready",
    "handoff-proposed",
    "awaiting-human",
  ]);
  assert.deepEqual(contract.pushEntry.contextualFamilies.map((item) => item.id), [
    "agent-finished",
    "chat-approval-needed",
    "board-write-denied",
    "task-auto-approved-no-reviewer",
    "task-approved-api-fallback",
    "task-auto-approved-api-fallback",
    "task-auto-approved-no-verdict",
    "frozen-card-held-review",
    "task-done",
    "frozen-card-held-git-review",
    "pull-request-ready",
  ]);
  assert.deepEqual(contract.pushEntry.systemFamilies.map((item) => item.id), [
    "loop-finished-legacy",
    "loop-run-status",
    "push-test",
    "mode-boot-failure",
  ]);

  const allFamilies = [
    ...contract.pushEntry.genericFamilies,
    ...contract.pushEntry.linkedTaskFamilies,
    ...contract.pushEntry.contextualFamilies,
    ...contract.pushEntry.systemFamilies,
  ];
  const pushPayloadCallCount = [...gate.matchAll(/\bpushPayload\(/g)].length - 1;
  assert.equal(
    pushPayloadCallCount,
    allFamilies.length - contract.pushEntry.genericFamilies.length,
    "a pushPayload call was added or removed without updating the notification inventory",
  );
  for (const family of allFamilies) {
    assert.ok(gate.includes(family.sourceMarker), `${family.id} push is no longer enumerable at its recorded source marker`);
    if (family.contextMarker) assert.ok(gate.includes(family.contextMarker), `${family.id} context marker is no longer present`);
    assert.ok(family.currentDestination, `${family.id} has no current destination`);
    assert.ok(family.requiredDestination, `${family.id} has no required destination`);
    if (family.status === "live") assert.equal(family.currentDestination, family.requiredDestination);
    if (family.status === "known-gap-before-cutover") {
      assert.equal(family.mustFixBy, "step-8-before-cutover");
    }
  }
  assert.equal(contract.pushEntry.genericFamilies[0].requiredDestination, "/?view=work%2Fboard");
  for (const family of contract.pushEntry.linkedTaskFamilies) {
    assert.equal(family.requiredDestination, "/?task=:encodedTaskId");
    assert.equal(family.status, "live");
  }
  for (const family of contract.pushEntry.contextualFamilies.filter((item) => item.context === "task")) {
    assert.equal(family.requiredDestination, "/?task=:encodedTaskId");
    assert.equal(family.status, "live");
  }
  assert.equal(allFamilies.filter((family) => family.status === "known-gap-before-cutover").length, 0);
  assert.deepEqual(contract.pushEntry.retiredPathPolicy, {
    paths: ["/cc", "/cc/legacy", "/desk", "/chat", "/cron", "/kanban", "/brain", "/profiles", "/settings"],
    status: 410,
    redirect: false,
    servesShell: false,
  });
});

test("the final route contract has one shell and no handwritten rollback surface", () => {
  const phases = Object.fromEntries(contract.routePhases.map((phase) => [phase.id, phase]));
  assert.deepEqual(Object.keys(phases), ["final"]);
  assert.deepEqual(phases.final.routes, {
    "/": "generated-dashboard-200",
    "/audit": "generated-dashboard-200",
    "/2fa": "generated-dashboard-200",
    "/cc": "retired-410",
    "/cc/legacy": "retired-410",
    "/desk": "retired-410",
    "/chat": "retired-410",
    "/cron": "retired-410",
    "/kanban": "retired-410",
    "/brain": "retired-410",
    "/profiles": "retired-410",
    "/settings": "retired-410",
  });

  const gate = read("container", "gate.js");
  assert.match(gate, /const SHELL_ENTRY_PATHS = new Set\(\["\/", "\/audit", "\/2fa"\]\)/);
  assert.match(gate, /const RETIRED_UI_PATHS = new Set\(\[[\s\S]*?"\/cc"[\s\S]*?"\/desk"[\s\S]*?"\/settings"/);
  assert.match(gate, /SHELL_ENTRY_PATHS\.has\(url\.pathname\)[\s\S]*?serveDashboardDocument\(res\)/);
  assert.match(gate, /retiredUiPath[\s\S]*?writeHead\(410/);
  assert.doesNotMatch(gate, /AGENTHOST_CC_TARGET|\bCC_HTML\b|res\.end\(CC_HTML\)/);
});

test("truth fixtures never collapse degraded or down into healthy", () => {
  assert.deepEqual(contract.truthStates.map((item) => item.state), ["healthy", "degraded", "down"]);
  for (const item of contract.truthStates) {
    assert.ok(!Number.isNaN(Date.parse(item.observedAt)), `${item.state} lacks an observation time`);
    if (item.state === "healthy") assert.equal(item.cause, null);
    else assert.ok(item.cause, `${item.state} must name its cause`);
  }
});

test("every Growth and Brain surface is labeled live, derived, sample, or gated", () => {
  const allowed = new Set(["live", "derived", "sample", "contract_gate"]);
  const required = {
    growth: ["brand-dna", "goals", "okrs", "autonomy", "campaigns", "creative", "calendar", "intel", "attribution"],
    brain: ["memory", "lobes-and-nodes", "learning", "skills", "experiments"],
  };

  for (const [area, ids] of Object.entries(required)) {
    const surfaces = contract.surfaceTruth[area];
    assert.deepEqual(surfaces.map((item) => item.id), ids);
    for (const item of surfaces) {
      assert.ok(allowed.has(item.state), `${area}/${item.id} has unknown state ${item.state}`);
      assert.ok(item.label, `${area}/${item.id} needs visible truth copy`);
      if (item.state === "sample") assert.match(item.label, /sample/i);
      if (item.state === "contract_gate") assert.ok(item.blockedBy);
      if (["live", "derived"].includes(item.state)) assert.ok(item.proof?.length);
    }
  }
});
