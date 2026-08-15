import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(process.cwd(), "dashboard");
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");

const commandCenter = read("components", "agenthost", "command-center.tsx");
const navigation = read("components", "agenthost", "navigation.ts");
const sidebar = read("components", "agenthost", "sidebar.tsx");
const topBar = read("components", "agenthost", "top-bar.tsx");
const roomView = read("components", "agenthost", "room-view.tsx");
const threadRail = read("components", "agenthost", "thread-rail.tsx");
const agentHostDir = path.join(ROOT, "components", "agenthost");
const reachableAgentHostSource = fs.readdirSync(agentHostDir)
  .filter((name) => name.endsWith(".tsx") && name !== "agent-profile.tsx")
  .map((name) => fs.readFileSync(path.join(agentHostDir, name), "utf8"))
  .join("\n");

test("the approved Overview shell is the production default and reads live state", () => {
  assert.match(commandCenter, /const DEFAULT_NAV: NavKey = "cc"/);
  assert.match(commandCenter, /nav === "cc"[\s\S]*<RoomView/);
  assert.match(commandCenter, /roster=\{roster\}/);
  assert.match(commandCenter, /board=\{boardState\.board\}/);
  assert.match(commandCenter, /boardProblem=\{boardState\.problem\}/);
  assert.doesNotMatch(commandCenter, /<CcHome/);

  assert.match(roomView, /RosterAgent\[\]/);
  assert.match(roomView, /BoardSnapshot \| null/);
  assert.match(roomView, /boardProblem: string \| null/);
  assert.match(roomView, /onOpenTask: \(task: Task\) => void/);
  assert.match(roomView, /Object\.values\(board\?\.columns \?\? \{\}\)\.flat\(\)/);
});

test("the attached ThreadRail is one live thread on desktop and in the phone drawer", () => {
  assert.match(commandCenter, /const \[desktopThreadOpen, setDesktopThreadOpen\] = useState\(true\)/);
  assert.match(commandCenter, /window\.matchMedia\("\(min-width: 1280px\)"\)\.matches/);
  assert.match(commandCenter, /if \(isDesktop\) \{[\s\S]*setDesktopThreadOpen\(true\)[\s\S]*return[\s\S]*setMobileThreadOpen\(true\)/);
  assert.doesNotMatch(commandCenter, /setDesktopThreadOpen\(true\)\s*setMobileThreadOpen\(true\)/);
  assert.match(commandCenter, /<ThreadRail[\s\S]*messages=\{chat\.messages\}[\s\S]*busy=\{chat\.busy\}[\s\S]*problem=\{chat\.problem\}/);
  assert.match(commandCenter, /onSend=\{chat\.send\}/);
  assert.equal((commandCenter.match(/observedAt=\{chat\.observedAt\}/g) ?? []).length, 2);
  assert.match(commandCenter, /chatObservedAt=\{chat\.observedAt\}/);
  assert.match(commandCenter, /mobile[\s\S]*messages=\{chat\.messages\}/);

  assert.match(threadRail, /ChatMessage\[\]/);
  assert.match(threadRail, /RosterAgent\[\]/);
  assert.match(threadRail, /import \{ ThreadMessage \} from "\.\/thread-message"/);
  assert.match(threadRail, /onOpenAgent\?: \(id: AgentId\) => void/);
  assert.match(threadRail, /onOpenTask\?: \(id: string\) => void/);
  assert.match(threadRail, /onOpenCause\?: \(cause: string\) => void/);
  assert.match(threadRail, /visibleProblem &&/);
  assert.match(threadRail, /disabled=\{busy\}/);
  assert.match(threadRail, /observedAt: number \| null/);
  assert.match(threadRail, /observedAt === null/);
  assert.match(roomView, /chatObservedAt: number \| null/);
  assert.match(roomView, /chatObservedAt === null/);
  assert.doesNotMatch(roomView, /No team-thread error reported/);
});

test("desktop keeps the grouped Growth rail while phone uses the approved action bar and More sheet", () => {
  assert.match(sidebar, /export function MobileNav/);
  assert.equal((sidebar.match(/roomsForMode\(mode\)\.map\(/g) ?? []).length, 2);
  assert.equal((sidebar.match(/GROWTH_NAV_GROUPS\.map\(/g) ?? []).length, 1);
  assert.match(navigation, /label: "Command Center"[\s\S]*label: "Client work"[\s\S]*label: "The box"/);
  assert.match(sidebar, /GROWTH_MOBILE_PRIMARY\.map\(/);
  assert.match(sidebar, /<Modal[\s\S]*title="More Growth destinations"/);
  assert.match(sidebar, /Settings &amp; Mode/);
  assert.match(sidebar, /lg:hidden/);
  assert.match(commandCenter, /import \{ MobileNav, Sidebar/);
  assert.doesNotMatch(commandCenter, /from "\.\/mobile-nav"/);
  assert.match(commandCenter, /<MobileNav[\s\S]*active=\{nav\}[\s\S]*onNavigate=\{navigate\}[\s\S]*onOpenSettings=\{\(\) => openSettings\(\)\}/);
});

test("Growth renders once with the live client-work tabs", () => {
  assert.match(commandCenter, /import \{ GrowthView, type GrowthTab \} from "\.\/growth-view"/);
  assert.match(commandCenter, /brand: "accounts"/);
  assert.match(commandCenter, /campaigns: "campaigns"/);
  assert.match(commandCenter, /goals: "goals"/);
  assert.match(commandCenter, /autonomy: "autonomy"/);
  assert.equal((commandCenter.match(/<GrowthView/g) ?? []).length, 1);
  assert.match(commandCenter, /activeRoom === "growth"[\s\S]*<GrowthView/);
  assert.match(commandCenter, /activeRoom !== "growth"[\s\S]*<RoomSubnav/);

  for (const retired of ["CreativeStudio", "Calendar", "IntelFeed", "Attribution", "Accounts"]) {
    assert.doesNotMatch(commandCenter, new RegExp(`import \\{ ${retired} \\}`));
  }
  assert.doesNotMatch(commandCenter, /nav === "(?:creative|calendar|intel|reports|accounts)"/);
});

test("Dev Agents renders once as the live control room without legacy escapes", () => {
  assert.match(commandCenter, /import \{ AgentsView \} from "\.\/agents-view"/);
  assert.doesNotMatch(commandCenter, /import \{ AgentProfile \}/);
  assert.equal((commandCenter.match(/<AgentsView/g) ?? []).length, 1);
  assert.match(commandCenter, /activeRoom === "agents"[\s\S]*<AgentsView/);
  assert.match(commandCenter, /activeRoom !== "agents"[\s\S]*<RoomSubnav/);
  assert.match(commandCenter, /onOpenThread=\{openAgentThread\}/);
  assert.match(commandCenter, /onOpenTerminal=\{openAgentTerminal\}/);
  assert.doesNotMatch(commandCenter, /<AgentProfile/);
  assert.doesNotMatch(reachableAgentHostSource, /from ["']\.\/agent-profile["']|<AgentProfile/,
    "the legacy full-page AgentProfile must have no reachable import or render path");
});

test("the transplanted shell keeps real controls and rejects prototype claims", () => {
  for (const marker of [
    "onSwitchMode",
    "onOpenSettings",
    "onOpenThread",
    "onOpenSearch",
    "onOpenBoxes",
    "onNewTask",
    "healthState",
    "healthCause",
  ]) {
    assert.ok(topBar.includes(marker), `${marker} disappeared from the live top-bar contract`);
  }

  assert.match(commandCenter, /params\.get\("task"\)/);
  assert.match(commandCenter, /if \(hit\) setOpenTask\(hit\)/);
  assert.match(commandCenter, /<SettingsModal/);
  assert.match(commandCenter, /const modeSwitchLock = useRef\(false\)/);
  assert.match(commandCenter, /if \(!pendingMode \|\| modeSwitchLock\.current\) return/);

  const transplanted = [commandCenter, sidebar, topBar, roomView, threadRail].join("\n");
  for (const forbidden of [
    "TASKS",
    "CHAT",
    "Prototype workspace changed",
    "Fixture:",
    "No live box restart in this prototype",
    "Production app untouched",
    "538 tools and skills",
  ]) {
    assert.equal(transplanted.includes(forbidden), false, `prototype-only claim leaked into production: ${forbidden}`);
  }
});
