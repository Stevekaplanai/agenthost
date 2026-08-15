import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.join(process.cwd(), "dashboard");
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");

const navigation = read("components", "agenthost", "navigation.ts");
const sidebar = read("components", "agenthost", "sidebar.tsx");
const search = read("components", "agenthost", "shell-dialogs.tsx");
const commandCenter = read("components", "agenthost", "command-center.tsx");
const topBar = read("components", "agenthost", "top-bar.tsx");
const settings = read("components", "agenthost", "settings.tsx");

test("the mode-specific room is Agents in Dev and Growth in Growth mode", () => {
  assert.match(navigation, /export function roomAvailableInMode/);
  assert.match(navigation, /room === "growth"[\s\S]*mode === "growth"/);
  assert.match(navigation, /room === "agents"[\s\S]*mode === "dev"/);
  assert.match(sidebar, /roomsForMode\(mode\)\.map/);
  assert.match(sidebar, /roomsForMode\(mode\)\.map/);
});

test("Growth presents the Command Center, client work, and box destinations without changing canonical room ownership", async () => {
  const navigationUrl = `${pathToFileURL(path.join(ROOT, "components", "agenthost", "navigation.ts")).href}?growth-groups=${Date.now()}`;
  const { GROWTH_NAV_GROUPS, navAvailableInMode, roomForNav, searchableDestinations } = await import(navigationUrl);

  assert.deepEqual(
    GROWTH_NAV_GROUPS.map((group) => ({ label: group.label, destinations: group.destinations.map((item) => item.label) })),
    [
      { label: "Command Center", destinations: ["Home", "Workspace", "Board", "Growth Loops"] },
      { label: "Client work", destinations: ["Accounts", "Campaigns", "Creative", "Attribution"] },
      { label: "The box", destinations: ["Brain", "Crew", "Inventory", "Secrets"] },
    ],
  );
  assert.equal(roomForNav("cc"), "overview", "Home remains the canonical Overview destination");
  assert.equal(roomForNav("workspace"), "overview", "Workspace remains the canonical Overview thread");
  assert.equal(roomForNav("board"), "work", "Board remains canonically owned by Work");
  assert.equal(roomForNav("loops"), "systems", "Growth Loops remains canonically owned by Systems");
  assert.equal(roomForNav("campaigns"), "growth");
  assert.equal(roomForNav("profile"), "agents", "Crew remains the existing canonical agent profile");
  assert.equal(roomForNav("secrets"), "systems", "Secrets remains a general box system surface");
  assert.equal(navAvailableInMode("profile", "growth"), true, "Growth can present Crew without reparenting it");

  const growthSearch = searchableDestinations("growth").map((item) => item.key);
  assert.ok(growthSearch.includes("goals"), "Goals and OKRs remain search-reachable");
  assert.ok(growthSearch.includes("autonomy"), "Autonomy remains search-reachable");
  const growthLabels = new Map(searchableDestinations("growth").map((item) => [item.key, item.label]));
  assert.equal(growthLabels.get("cc"), "Home");
  assert.equal(growthLabels.get("workspace"), "Workspace");
  assert.equal(growthLabels.get("loops"), "Growth Loops");
  assert.equal(growthLabels.get("profile"), "Crew");
});

test("Growth search finds the phone-visible Chat alias through the ShellSearch haystack", async () => {
  const navigationUrl = `${pathToFileURL(path.join(ROOT, "components", "agenthost", "navigation.ts")).href}?growth-chat-search=${Date.now()}`;
  const { searchableDestinations } = await import(navigationUrl);
  const matches = searchableDestinations("growth")
    .filter((item) => `${item.room.label} ${item.label} ${item.description}`.toLowerCase().includes("chat"))
    .map((item) => item.key);

  assert.match(search, /`\$\{item\.room\.label\} \$\{item\.label\} \$\{item\.description\}`\.toLowerCase\(\)\.includes\(needle\)/);
  assert.deepEqual(matches, ["workspace"]);
});

test("search and stale URLs honor the active mode-specific room", () => {
  assert.match(search, /mode: ObservedMode/);
  assert.match(search, /searchableDestinations\(mode\)/);
  assert.match(commandCenter, /navAvailableInMode\(requested, shellMode\)/);
  assert.match(commandCenter, /window\.history\.replaceState/);
  assert.match(commandCenter, /<ShellSearch[\s\S]*mode=\{shellMode\}/);
});

test("an unobserved mode unlocks no exclusive room or mode-changing request", async () => {
  const navigationUrl = `${pathToFileURL(path.join(ROOT, "components", "agenthost", "navigation.ts")).href}?unknown-mode=${Date.now()}`;
  const { roomsForMode, shellModeFromServer } = await import(navigationUrl);
  assert.equal(shellModeFromServer(null), null);
  assert.equal(shellModeFromServer("invalid"), null);
  assert.deepEqual(roomsForMode(null).map((room) => room.key), ["overview", "work", "brain", "systems"]);

  const request = commandCenter.match(/function requestModeSwitch[\s\S]*?\n  \}/)?.[0] ?? "";
  assert.match(request, /shellMode === null[\s\S]*?Mode cannot be switched[\s\S]*?return/);
  assert.ok(request.indexOf("return") < request.indexOf("setPendingMode"), "unknown mode can still open the restart confirmation");
  assert.match(topBar, /\{mode \? \([\s\S]*?Mode unavailable/);
  assert.match(settings, /disabled=\{mode === null\}/);
  assert.match(commandCenter, /data-mode=\{shellMode \?\? "unknown"\}/);
});

test("a cold deep link keeps destinations shared by both modes reachable", async () => {
  const navigationUrl = `${pathToFileURL(path.join(ROOT, "components", "agenthost", "navigation.ts")).href}?shared-destination=${Date.now()}`;
  const { navAvailableInMode } = await import(navigationUrl);

  assert.equal(navAvailableInMode("profile", "dev"), true);
  assert.equal(navAvailableInMode("profile", "growth"), true);
  assert.match(commandCenter, /const availableInEveryMode = navAvailableInMode\(requested, "dev"\) && navAvailableInMode\(requested, "growth"\)/);
  assert.match(commandCenter, /shellMode !== null && !navAvailableInMode\(requested, shellMode\)/);
});

test("mode review preserves the Settings draft on Cancel and closes it only after Confirm", () => {
  const request = commandCenter.match(/function requestModeSwitch[\s\S]*?\n  \}/)?.[0] ?? "";
  const confirm = commandCenter.match(/async function confirmModeSwitch[\s\S]*?\n  \}/)?.[0] ?? "";

  assert.doesNotMatch(request, /setSettingsOpen\(false\)/, "opening the review must not unmount the Settings draft");
  assert.match(confirm, /setSettingsOpen\(false\)/, "the confirmed restart closes Settings before changing the box");
  assert.match(commandCenter, /Cancel keeps Settings open and preserves every unsaved edit\./);
  assert.match(commandCenter, /Confirming closes Settings and discards those unsaved edits before the restart begins\./);
});
