import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const read = (relative) => fs.readFileSync(path.resolve(relative), "utf8");
const addedLines = (patch) => patch
  .split(/\r?\n/)
  .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
  .map((line) => line.slice(1))
  .join("\n");
const mobileConnection = await import(pathToFileURL(path.resolve(
  "control-plane/overlay/web/src/mobile/agenthostMobileConnection.js",
)).href);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test("the AgentGlass adapter brands and unlocks the real phone application", () => {
  const patch = addedLines([
    read("control-plane/patches/10-agenthost-shell.patch"),
    read("control-plane/patches/15-agenthost-mobile-auth-hardening.patch"),
  ].join("\n"));
  const mobileConnection = read(
    "control-plane/overlay/web/src/mobile/agenthostMobileConnection.js",
  );

  assert.match(patch, /Agent<span[^>]*>Host<\/span>/);
  assert.doesNotMatch(patch, /agent<span[^>]*>glass<\/span>/);
  assert.match(patch, /probeAuth/);
  assert.match(patch, /reauthPrompt/);
  assert.match(patch, /Sign in required/);
  assert.match(patch, /Offline/);
  assert.match(patch, /limited/);
  assert.match(patch, /Data unavailable/);
  assert.match(patch, /createCoalescedMobileFastPoll/);
  assert.match(mobileConnection, /rerunRequested/);
  assert.match(mobileConnection, /mobileSensitiveUiVisible/);
  assert.doesNotMatch(patch, /backdropFilter:\s*"blur\((?:1[3-9]|[2-9]\d)px/);
  assert.match(patch, /Built on/);
  assert.match(patch, /David Pallares \(SirAllap\)/);
  assert.match(patch, /MIT licensed/i);
});

test("the generated shell is the one premium AgentHost instrument skin", () => {
  const globals = read("dashboard/app/globals.css");
  const sidebar = read("dashboard/components/agenthost/sidebar.tsx");
  const settings = read("dashboard/components/agenthost/settings.tsx");
  const shell = read("container/dashboard-ui/index.html");
  const gate = read("container/gate.js");

  assert.match(globals, /--background:\s*#0b0d10/);
  assert.match(globals, /--accent:\s*#ff6a3d/);
  assert.match(globals, /--metal-highlight:\s*#8a9396/);
  assert.match(globals, /\.gunmetal-shell\s*\{/);
  assert.match(sidebar, /backdrop-blur-\[12px\]/, "the phone navigation stays within the mobile blur ceiling");

  assert.match(settings, /Interface inspired by/);
  assert.match(settings, /https:\/\/github\.com\/SirAllap\/agentglass/);
  assert.match(settings, /AgentGlass by David Pallares/);
  assert.match(shell, /<title>AgentHost Workspace \| Your governed agent team<\/title>/);
  assert.match(shell, /aria-label="Primary navigation"/);

  assert.equal(fs.existsSync(path.resolve("container/appshell.js")), false);
  assert.doesNotMatch(gate, /agenthost-(?:appshell|nav)\.js|\/apps\.json/);
  assert.doesNotMatch(shell, /agenthost-(?:appshell|nav)\.js|\/apps\.json/);
});

test("slow phone polls coalesce and still publish every slow 401", async () => {
  const firstGate = deferred();
  const secondGate = deferred();
  const firstSessions = deferred();
  const secondSessions = deferred();
  const connectionEvents = [];
  const gateEvents = [];
  const sessionEvents = [];
  let gateCall = 0;
  let sessionCall = 0;
  let sensitiveCleared = false;
  const gates = [firstGate, secondGate];
  const sessions = [firstSessions, secondSessions];
  const poll = mobileConnection.createCoalescedMobileFastPoll({
    gatePending: () => gates[gateCall++].promise,
    sessions: () => sessions[sessionCall++].promise,
    probeAuth: async () => "unauthorized",
    onConnection: (state) => connectionEvents.push(state),
    onGates: (value) => gateEvents.push(value),
    onSessions: (value) => sessionEvents.push(value),
    onUnauthorized: () => { sensitiveCleared = true; },
  });

  const active = poll();
  const repeated = [poll(), poll(), poll()];
  assert.equal(gateCall, 1);
  assert.equal(sessionCall, 1);
  firstGate.reject(new Error("401"));
  firstSessions.resolve(["first session"]);
  secondGate.reject(new Error("401"));
  secondSessions.resolve(["second session"]);
  await Promise.all([active, ...repeated]);

  assert.deepEqual(connectionEvents, ["locked", "locked"]);
  assert.deepEqual(gateEvents, []);
  assert.deepEqual(sessionEvents, [["first session"], ["second session"]]);
  assert.equal(sensitiveCleared, true);
  assert.equal(gateCall, 2);
  assert.equal(sessionCall, 2);
  assert.equal(mobileConnection.mobileSensitiveUi("locked", "cached panel"), null);
  assert.equal(mobileConnection.mobileSensitiveUi("live", "fresh panel"), "fresh panel");
});

test("an active 401 clears open phone surfaces before publishing Locked", async () => {
  let connection = "live";
  let sensitive = { repo: true, pr: true, settings: true };
  const poll = mobileConnection.createCoalescedMobileFastPoll({
    gatePending: async () => { throw new Error("401"); },
    sessions: async () => [],
    probeAuth: async () => "unauthorized",
    onConnection: (state) => { connection = state; },
    onGates: () => {},
    onSessions: () => {},
    onUnauthorized: () => {
      sensitive = { repo: false, pr: false, settings: false };
    },
  });

  await poll();

  assert.equal(connection, "locked");
  assert.deepEqual(sensitive, { repo: false, pr: false, settings: false });
  assert.equal(mobileConnection.mobileSensitiveUi(connection, "cached controls"), null);
});
