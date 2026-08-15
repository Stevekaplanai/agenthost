// The phone view is the product. This guard freezes the approved five-action
// Growth rail and grouped More sheet while keeping every live destination reachable.
// It reads source text so it stays in the plain Node test suite.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(process.cwd(), "dashboard");
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");

const navigation = read("components", "agenthost", "navigation.ts");
const sidebar = read("components", "agenthost", "sidebar.tsx");
const topBar = read("components", "agenthost", "top-bar.tsx");
const subnav = read("components", "agenthost", "room-subnav.tsx");
const commandCenter = read("components", "agenthost", "command-center.tsx");
const threadRail = read("components", "agenthost", "thread-rail.tsx");
const globals = read("app", "globals.css");
const primitives = read("components", "agenthost", "primitives.tsx");

const ROOM_KEYS = ["overview", "work", "agents", "growth", "brain", "systems"];
const RETAINED_DESTINATIONS = [
  "cc",
  "workspace",
  "board",
  "files",
  "workbench",
  "terminal",
  "reviews",
  "accounts",
  "campaigns",
  "goals",
  "attribution",
  "creative",
  "autonomy",
  "brain",
  "profile",
  "mesh",
  "loops",
  "operator",
  "inventory",
  "secrets",
];

test("each mode's five rooms have one stable model and one desktop rail", () => {
  for (const room of ROOM_KEYS) {
    assert.match(navigation, new RegExp(`key: "${room}"`), `${room} is missing from the room model`);
  }
  assert.match(sidebar, /roomsForMode\(mode\)\.map\(/, "the desktop rail must render from the mode-aware canonical room model");
  assert.match(sidebar, /aria-label="Primary navigation"/);
});

test("phone keeps the same five mode-aware rooms visible in the approved bottom rail", () => {
  assert.match(sidebar, /export function MobileNav/);
  assert.equal((sidebar.match(/roomsForMode\(mode\)\.map\(/g) ?? []).length, 2,
    "desktop and phone must both render the canonical mode-aware room list");
  assert.match(sidebar, /fixed inset-x-0 bottom-0[\s\S]*lg:hidden/);
  assert.match(sidebar, /env\(safe-area-inset-bottom\)/, "the phone navigation must clear the home indicator");
});

test("Growth phone navigation keeps four actions plus More and moves consultative destinations into its sheet", () => {
  assert.match(sidebar, /const GROWTH_MOBILE_PRIMARY = \[[\s\S]*?key: "cc", label: "Home"[\s\S]*?key: "workspace", label: "Chat"[\s\S]*?key: "board", label: "Board"[\s\S]*?key: "loops", label: "Loops"/);
  assert.match(sidebar, /GROWTH_MOBILE_PRIMARY\.map\(/);
  assert.match(sidebar, /<span className="truncate">More<\/span>/);
  assert.match(sidebar, /<Modal[\s\S]*title="More Growth destinations"/);
  assert.match(sidebar, /GROWTH_NAV_GROUPS\.filter\(\(group\) => group\.key !== "command-center"\)\.map/,
    "Client work and The box belong in the phone More sheet, not the fixed rail");
  assert.match(sidebar, /Settings &amp; Mode/);
  assert.match(sidebar, /onClick=\{openSettingsFromMore\}/);
  assert.match(sidebar, /active: NavKey/);
  assert.match(sidebar, /onNavigate: \(key: NavKey\) => void/);
  assert.match(sidebar, /item\.key === active/);
  assert.doesNotMatch(sidebar.match(/<nav[\s\S]*aria-label="Primary navigation"[\s\S]*<\/nav>/)?.[0] ?? "", /overflow-x-auto/,
    "the fixed five-action phone rail must not become a sideways-scrolling destination list");
  assert.match(commandCenter, /<MobileNav[\s\S]*onOpenSettings=\{\(\) => openSettings\(\)\}/);
});

test("Growth More uses the shared modal trap, locks the full background, and hands Settings a persistent focus target", () => {
  assert.match(sidebar, /<Modal[\s\S]*open=\{growthMoreModalOpen\}[\s\S]*title="More Growth destinations"/);
  assert.match(primitives, /role="dialog"[\s\S]*aria-modal="true"[\s\S]*tabIndex=\{-1\}/);
  assert.match(primitives, /window\.addEventListener\("keydown", onKey\)/,
    "Escape and Tab must work globally while the shared modal owns focus");
  assert.match(primitives, /lockModalSiblings\(overlay\)/,
    "the shared modal makes the whole workspace inert, not only the bottom rail");
  assert.match(primitives, /opener\?\.isConnected[\s\S]*opener\.focus\(\)/,
    "the shared modal restores focus only to a persistent opener");
  assert.match(sidebar, /moreButtonRef\.current\?\.focus\(\)[\s\S]*requestAnimationFrame\(onOpenSettings\)/,
    "Settings opens only after focus returns to the persistent More trigger");
  // These were pinned to `growthMoreModalOpen`, the flag for this ONE modal.
  // The condition is now `navSuppressed`, which is that flag OR any other open
  // dialog -- so this guard still protects exactly what it protected, and the
  // widened case has its own test below. Kept as a substring match on the
  // growthMore term so a change that stops covering THIS modal still fails here.
  assert.match(sidebar, /aria-hidden=\{navSuppressed \? true : undefined\}/);
  assert.match(sidebar, /inert=\{navSuppressed \? true : undefined\}/,
    "the bottom navigation must not remain interactive above the modal");
  assert.match(sidebar, /const navSuppressed = growthMoreModalOpen \|\|/,
    "the More sheet must remain one of the cases that suppresses the bottom navigation");
});

test("every retained destination remains reachable inside a room", () => {
  for (const key of RETAINED_DESTINATIONS) {
    assert.match(navigation, new RegExp(`key: "${key}"`), `${key} disappeared from the collapsed shell`);
  }
  assert.match(subnav, /ROOM_DESTINATIONS\[room\]/);
  assert.match(subnav, /onNavigate\(item\.key(?: as NavKey)?\)/);
  assert.match(subnav, /<HorizontalRail/);
});

test("the phone top bar keeps every live shell action reachable", () => {
  assert.match(topBar, /onClick=\{onOpenThread\}/);
  assert.match(topBar, /onClick=\{onOpenSettings\}/);
  assert.match(topBar, /onSwitchMode\("default"\)/);
  assert.match(topBar, /onSwitchMode\("growth"\)/);
  assert.equal((topBar.match(/min-h-11 min-w-11 rounded-md/g) || []).length, 2,
    "both phone mode buttons must receive a full 44 by 44 touch target");
  assert.match(topBar, /aria-label=\{mode \? "Operating mode"/);
  assert.match(topBar, /aria-label="More actions"/);
  assert.match(topBar, /label="More actions"[\s\S]*className="grid md:hidden"/,
    "the overflow must remain available until the standalone box switcher appears");
  for (const label of ["View system health", "Switch box", "New task"]) {
    assert.match(topBar, new RegExp(`label="${label}"`), `${label} must stay reachable on a phone`);
  }
  assert.match(topBar, /label=\{brand\.searchLabel\}/,
    "buyer-branded search must stay reachable on a phone");
});

test("the fixed shell uses the small mobile viewport and a deliberate thread drawer", () => {
  assert.match(commandCenter, /h-\[100svh\]/, "100dvh can hide controls behind mobile browser chrome");
  assert.match(threadRail, /aria-label="Shared team thread"/);
  assert.match(threadRail, /xl:flex/, "the desktop thread rail must remain attached beside every room");
  assert.match(threadRail, /xl:hidden/, "phone and tablet need an explicit thread drawer");
  assert.match(globals, /-webkit-overflow-scrolling:\s*touch/);
  assert.match(globals, /scrollbar-width:\s*thin/);
});

test("the phone navigation steps aside for every dialog, not just one of them", () => {
  // A dialog the app chrome can cover is not modal. The phone's primary
  // navigation is `fixed bottom-0 z-50`, and it covered the bottom ~68px of
  // every open dialog: a control there is visible, enabled, stable -- and eats
  // every touch, because the nav takes it. No visibility assertion can see
  // that; only a real 390px tap can.
  //
  // A z-index CANNOT fix it, and two attempts proving that is why this guard
  // checks `inert` instead. The Modal overlay renders inline, inside whatever
  // stacking context its ancestors create, so neither the Tailwind class nor
  // the inline style syncModalStack applies ever reaches this nav's layer.
  // `inert` works because it removes the nav from pointer handling outright.
  //
  // The tell that this was a class and not an incident: the nav already did
  // exactly this for ONE modal (growthMore), leaving every other dialog
  // exposed -- including to keyboard and screen-reader users, who could still
  // reach the nav behind an open dialog.
  assert.match(primitives, /export function useAnyModalOpen\(\): boolean/,
    "the Modal primitive owns the modal stack, so it must publish whether any dialog is open");
  assert.match(primitives, /function syncModalStack\(\)[\s\S]*?modalOpenListeners\.forEach/,
    "the open signal must fire from the same place the stack changes, or it goes stale");
  assert.ok(
    primitives.indexOf("overlay.style.zIndex") < primitives.indexOf("modalOpenListeners.forEach((listener) => listener())"),
    "stacking must be applied before subscribers are notified, so a throwing subscriber cannot leave overlay z-indexes stale");
  assert.match(sidebar, /const anyModalOpen = useAnyModalOpen\(\)/,
    "the phone navigation must read the shared signal, not one modal's local state");
  assert.match(sidebar, /const navSuppressed = growthMoreModalOpen \|\| anyModalOpen/);
  for (const [attribute, pattern] of [
    ["z-index", /navSuppressed \? "z-30" : "z-50"/],
    ["aria-hidden", /aria-hidden=\{navSuppressed \? true : undefined\}/],
    ["inert", /inert=\{navSuppressed \? true : undefined\}/],
  ]) {
    assert.match(sidebar, pattern,
      `the phone navigation must apply ${attribute} for ANY open dialog; a dialog-specific flag leaves every other dialog exposed`);
  }
});
