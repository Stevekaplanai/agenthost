import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(process.cwd(), "dashboard");
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");

const navigation = read("components", "agenthost", "navigation.ts");
const commandCenter = read("components", "agenthost", "command-center.tsx");
const mobile = read("components", "agenthost", "sidebar.tsx");
const runtime = read("lib", "runtime-adapter.ts");
const topBar = read("components", "agenthost", "top-bar.tsx");
const primitives = read("components", "agenthost", "primitives.tsx");
const board = read("components", "agenthost", "full-board.tsx");
const loops = read("components", "agenthost", "loops.tsx");
const globals = read("app", "globals.css");
const layout = read("app", "layout.tsx");
const brand = read("lib", "brand.ts");
const serviceWorkerRegistration = read("components", "agenthost", "service-worker-registration.tsx");

test("semantic routes describe room and destination instead of component state", () => {
  const expected = [
    "overview",
    "overview/thread",
    "work/board",
    "work/files",
    "work/artifacts",
    "work/terminal",
    "work/reviews",
    "growth/brand-dna",
    "growth/campaigns",
    "growth/goals",
    "growth/attribution",
    "growth/creative",
    "growth/autonomy",
    "brain/memory",
    "systems/agents",
    "systems/mesh",
    "systems/loops",
    "systems/operations",
    "systems/inventory",
    "systems/secrets",
  ];
  for (const route of expected) {
    assert.ok(navigation.includes(`route: "${route}"`), `missing stable route ${route}`);
  }
  assert.match(navigation, /export function navFromRoute/);
  assert.match(navigation, /export function routeForNav/);
  assert.match(commandCenter, /setNav\(requested \?\? DEFAULT_NAV\)/,
    "browser Back to a URL without view must restore Overview");
});

test("the runtime seam owns browser and box switching behavior", () => {
  assert.match(runtime, /export interface RuntimeAdapter/);
  assert.match(runtime, /BoxWebAdapter/);
  assert.match(runtime, /CommandCenterAdapter/);
  assert.match(runtime, /MobileAdapter/);
  assert.match(runtime, /agenthost_fleet/);
  assert.match(runtime, /window\.location\.hostname/,
    "the dashboard and terminal shell must share the existing hostname-only fleet registry");
  assert.match(runtime, /window\.location\.assign\(/, "selecting a box must reload that box's observed state");
  assert.match(runtime, /window\.location\.assign\(`\$\{protocol\}\/\/\$\{host\}\/\$\{window\.location\.search\}`\)/,
    "box switching must enter the new shell at its canonical root without a legacy route alias");
  assert.doesNotMatch(runtime, /startsWith\("\/desk"\)|:\s*"\/desk"/,
    "box switching must not preserve or create the retired desk entry path");
  assert.match(runtime, /credentials are never copied between boxes/i);
});

test("the framed workspace does not draw a second desktop rail", () => {
  assert.match(commandCenter, /useIsFramed\(\)/);
  assert.match(commandCenter, /\{!framed && \(/);
  assert.match(commandCenter, /bg-background\/75 xl:hidden/,
    "the attached thread backdrop must disappear at the same breakpoint as its rail");
});

test("global shell controls stay visible and truthful", () => {
  for (const marker of [
    "onSwitchMode",
    "onOpenBoxes",
    "onOpenSearch",
    "onOpenSettings",
    "onOpenThread",
    "healthState",
    "healthCause",
    "observedAt",
  ]) {
    assert.ok(topBar.includes(marker), `${marker} is missing from the top bar contract`);
  }
});

test("one reusable horizontal rail supports touch and keyboard", () => {
  assert.match(primitives, /export function HorizontalRail/);
  for (const key of ["ArrowRight", "ArrowLeft", "PageDown", "PageUp", "Home", "End"]) {
    assert.ok(primitives.includes(`"${key}"`), `horizontal rail omits ${key}`);
  }
  assert.match(globals, /\.phone-scroll/);
  assert.match(globals, /scroll-snap-type:\s*x mandatory/);
  assert.match(globals, /touch-action:\s*pan-x pan-y/);
  assert.match(board, /<HorizontalRail label="Board status lanes"/);
  assert.match(board, /<HorizontalRail label="Board agent swimlanes"/);
  assert.match(loops, /<HorizontalRail label=\{`\$\{mode/);
});

test("the shared modal names itself, contains focus, and restores the page on close", () => {
  assert.match(primitives, /const titleId = useId\(\)/);
  assert.match(primitives, /document\.addEventListener\("focusin", rememberExternalFocus\)/);
  assert.match(primitives, /document\.addEventListener\("pointerdown", rememberExternalPointer\)/);
  assert.match(primitives, /document\.addEventListener\("keydown", rememberExternalKey\)/);
  assert.match(primitives, /lastExternalInteractionRef\.current = externalTarget\(event\.target\)/);
  assert.match(primitives, /rememberedInteraction\?\.isConnected && rememberedInteraction !== document\.body/);
  assert.match(primitives, /role="dialog"[\s\S]*aria-modal="true"[\s\S]*tabIndex=\{-1\}/);
  assert.match(primitives, /aria-labelledby=\{titleId\}/);
  assert.match(primitives, /aria-describedby=\{subtitle \? subtitleId : undefined\}/);
  assert.match(primitives, /getClientRects\(\)\.length > 0/);
  assert.match(primitives, /requestAnimationFrame\(\(\) => \{[\s\S]*first\.focus\(\)[\s\S]*dialogRef\.current\?\.focus\(\)/);

  assert.match(primitives, /event\.key === "Escape"[\s\S]*onCloseRef\.current\(\)/);
  assert.match(primitives, /min-h-11 min-w-11[\s\S]*aria-label="Close"/,
    "every shared modal Close control must have a 44px phone target");
  assert.match(primitives, /!dialogRef\.current\?\.contains\(document\.activeElement\)[\s\S]*first\.focus\(\)/);
  assert.match(primitives, /event\.shiftKey && document\.activeElement === first[\s\S]*last\.focus\(\)/);
  assert.match(primitives, /!event\.shiftKey && document\.activeElement === last[\s\S]*first\.focus\(\)/);

  assert.match(primitives, /element\.setAttribute\("inert", ""\)/);
  assert.match(primitives, /element\.setAttribute\("aria-hidden", "true"\)/);
  assert.match(primitives, /const modalSiblingLocks = new WeakMap/);
  assert.match(primitives, /if \(lock\) lock\.count \+= 1/);
  assert.match(primitives, /lock\.count -= 1[\s\S]*if \(lock\.count > 0\) return/);
  assert.match(primitives, /underlyingEntry\?\.returnFocus \?\? opener/);
  assert.match(primitives, /else element\.removeAttribute\("inert"\)/);
  assert.match(primitives, /if \(lock\.ariaHidden === null\) element\.removeAttribute\("aria-hidden"\)/);
  assert.match(primitives, /else element\.setAttribute\("aria-hidden", lock\.ariaHidden\)/);
  assert.match(primitives, /window\.requestAnimationFrame\(\(\) => \{[\s\S]*window\.requestAnimationFrame\(\(\) => \{[\s\S]*opener\?\.isConnected && !opener\.closest\("\[inert\]"\)[\s\S]*opener\.focus\(\)/);
  assert.match(primitives, /returnFocus\?\.isConnected && !returnFocus\.closest\("\[inert\]"\)[\s\S]*returnFocus\.focus\(\)/);
});

test("the production source carries the approved AgentHost gunmetal language", () => {
  assert.match(globals, /--background:\s*#0b0d10/i);
  assert.match(globals, /--accent:\s*#ff6a3d/i);
  assert.match(globals, /\.gunmetal-shell/);
  assert.match(globals, /\.gunmetal-panel/);
  assert.match(globals, /\.gunmetal-rail/);
  assert.match(layout, /title: `\$\{DEFAULT_BUYER_BRAND\.workspaceName\}/);
  assert.match(brand, /workspaceName: ["']AgentHost Workspace["']/);
  assert.doesNotMatch(layout, /generator:\s*['"]v0\.app/);
});

test("shared switches keep a 44px phone target around the compact visual track", () => {
  assert.match(primitives, /role="switch"[\s\S]*min-h-11 min-w-11/,
    "the switch button itself must be a 44px touch target");
  assert.match(primitives, /aria-hidden="true"[\s\S]{0,120}h-5 w-9/,
    "the compact 36x20 visual track stays separate from the touch target");
});

test("body-level browser-extension attributes cannot cover the prototype with a hydration overlay", () => {
  assert.match(layout, /<body[^>]*suppressHydrationWarning/,
    "the body must tolerate attributes injected by Grammarly and similar extensions before React starts");
});

test("the generated shell owns the canonical app worker and manifest", () => {
  assert.match(layout, /manifest:\s*["']\/manifest\.webmanifest["']/);
  assert.doesNotMatch(layout, /manifest:\s*["']\/manifest\.json["']/);
  assert.match(layout, /<ServiceWorkerRegistration\s*\/?>/);
  const workerRegistration = fs.readFileSync(
    path.join(ROOT, "components", "agenthost", "service-worker-registration.tsx"),
    "utf8",
  );
  assert.match(workerRegistration, /registration\.installing \?\? registration\.waiting/);
  assert.match(workerRegistration, /worker\.state === "activated"/);
  assert.match(workerRegistration, /did not activate within 4 seconds/);
  assert.match(serviceWorkerRegistration, /getRegistrations\(\)/);
  assert.match(serviceWorkerRegistration, /window\.top !== window\.self[\s\S]*"serviceWorker" in navigator/,
    "an opaque or nested app frame must never touch the browser's app-worker authority");
  assert.match(serviceWorkerRegistration, /pathname === TRUSTED_WORKER_PATH[\s\S]*trustedRegistration = registration[\s\S]*registration\.unregister\(\)/);
  assert.match(serviceWorkerRegistration, /process\.env\.NODE_ENV === ["']production["']/,
    "the standalone Next prototype must clean stale workers without requesting a worker it cannot serve");
  assert.match(serviceWorkerRegistration, /if \(!registerTrustedWorker\) \{[\s\S]*trustedRegistration[\s\S]*development server does not install it[\s\S]*register\(TRUSTED_WORKER_PATH/);
  assert.match(serviceWorkerRegistration, /register\(TRUSTED_WORKER_PATH/);
  assert.match(serviceWorkerRegistration, /updateViaCache:\s*["']none["']/);
  assert.match(serviceWorkerRegistration, /could not install its trusted app worker: \$\{cause\}/,
    "worker registration failures must name the browser's cause");
});
