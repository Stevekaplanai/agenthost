// Mode-tagged Loops (ARD Wave 0, T0.5 / hole H4): a Loop may carry an optional
// `mode` tag. Untagged = fires in every mode (every job that predates Growth
// Mode keeps working); tagged = fires ONLY in its own mode, which is what makes
// `agenthost mode revert` PARK the growth department at the next tick instead of
// leaving it firing on a reverted box.
//
// The acceptance criterion is behavioral, so the two load-bearing tests below
// boot REAL gates with a one-minute schedule and a fast tick and then look at
// what actually ran: on a default box the growth-tagged Loop records no run and
// the untagged one does; on a growth box both run.
// Run: node --test test/gate-mode-loops.test.js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { stopChild } from "./child-process-helper.js";
import { mintOperatorSession } from "./operator-session-helper.js";
const require = createRequire(import.meta.url);
const gate = require("../container/gate.js");
const modeLib = require("../container/mode-lib.js");

const GATE = path.join(import.meta.dirname, "..", "container", "gate.js");
const DASHBOARD = path.join(import.meta.dirname, "..", "dashboard");
const DASHBOARD_COMPONENTS = path.join(DASHBOARD, "components", "agenthost");
const LOOPS_SOURCE = fs.readFileSync(path.join(DASHBOARD_COMPONENTS, "loops.tsx"), "utf8");
const MULTI_LOOPS_SOURCE = fs.readFileSync(path.join(DASHBOARD_COMPONENTS, "multi-loops.tsx"), "utf8");
const SYSTEMS_SOURCE = fs.readFileSync(path.join(DASHBOARD_COMPONENTS, "systems-view.tsx"), "utf8");
const COMMAND_CENTER_SOURCE = fs.readFileSync(path.join(DASHBOARD_COMPONENTS, "command-center.tsx"), "utf8");
const LIVE_SOURCE = fs.readFileSync(path.join(DASHBOARD, "lib", "live.ts"), "utf8");
const API_SOURCE = fs.readFileSync(path.join(DASHBOARD, "lib", "api.ts"), "utf8");
const KEY = "modeloopstestkey";
// 12-char [a-z0-9] ids, the shape CRON_ID_RE accepts off disk.
const UNTAGGED = "untagged0001";
const TAGGED = "growthjob001";

// ---- the predicate ----------------------------------------------------------

test("an untagged Loop runs in every mode (legacy jobs never stop firing)", () => {
  for (const mode of modeLib.MODES) {
    assert.equal(gate.jobRunsInMode({ id: UNTAGGED, cron: "* * * * *" }, mode), true, mode);
  }
  // Empty-string and null tags are "no tag", not "a mode named nothing".
  assert.equal(gate.jobRunsInMode({ mode: "" }, "growth"), true);
  assert.equal(gate.jobRunsInMode({ mode: null }, "default"), true);
});

test("a tagged Loop runs only in its own mode", () => {
  assert.equal(gate.jobRunsInMode({ mode: "growth" }, "growth"), true);
  assert.equal(gate.jobRunsInMode({ mode: "growth" }, "default"), false);
  assert.equal(gate.jobRunsInMode({ mode: "default" }, "growth"), false);
  // An unknown tag matches no mode this box can boot into: it stays parked
  // rather than defaulting to "always fires".
  assert.equal(gate.jobRunsInMode({ mode: "marketing" }, "default"), false);
  assert.equal(gate.jobRunsInMode({ mode: "marketing" }, "growth"), false);
});

// ---- validation accepts the field ------------------------------------------

test("validateCronJob/validateMultiJob accept a known mode and reject an unknown one", () => {
  assert.equal(typeof gate.modeTagInvalid, "function");
  assert.equal(gate.modeTagInvalid({}), null, "absent is fine -- the field is optional");
  for (const mode of modeLib.MODES) assert.equal(gate.modeTagInvalid({ mode }), null, mode);
  assert.match(String(gate.modeTagInvalid({ mode: "marketing" })), /unknown mode/);
  assert.match(String(gate.modeTagInvalid({ mode: 7 })), /unknown mode/);
});

// ---- the generated Loops surface names mode ownership -----------------------
// The retired handwritten page derived mode from a server-stamped body tag.
// The generated dashboard receives the observed mode as a React prop. Single
// Loops name their stored mode; Multi-Loops additionally render the parked
// state when that tag differs from the box's current mode. The HTTP test below
// proves the mode value itself still comes from the authenticated box API.

test("the generated Loops UI names tagged jobs and marks cross-mode Multi-Loops parked", () => {
  assert.match(LOOPS_SOURCE, /mode: "dev" \| "growth"/, "the generated Loops view requires an observed mode");
  assert.match(LOOPS_SOURCE, /\{j\.mode && \(/, "a tagged single Loop renders a mode badge");
  assert.match(LOOPS_SOURCE, /\{j\.mode\}/, "the badge uses the stored mode value as React text");
  assert.match(LOOPS_SOURCE, /const currentMode = mode === "growth" \? "growth" : "default"/,
    "single Loops compares each stored job to the observed current mode");
  assert.match(LOOPS_SOURCE, /parked\s*\? `Parked until \$\{j\.mode\} mode`/,
    "single Loops names the stored mode instead of claiming a parked schedule will run next");

  assert.match(MULTI_LOOPS_SOURCE, /const currentMode = mode === "growth" \? "growth" : "default"/,
    "the generated Multi-Loop view translates the observed UI mode to the stored mode contract");
  assert.match(MULTI_LOOPS_SOURCE, /const parked = Boolean\(job\.mode && job\.mode !== currentMode\)/,
    "one predicate decides whether a tagged Multi-Loop can run in this mode");
  assert.match(MULTI_LOOPS_SOURCE, /parked \? "border-yellow-500\/35 opacity-80" : "border-line"/,
    "a parked card is visibly distinct");
  assert.match(MULTI_LOOPS_SOURCE, /parked \? `Parked until \$\{job\.mode\} mode` : timeLabel\(job\.nextRunAt\)/,
    "the parked state names the mode that will reactivate it");
  assert.match(MULTI_LOOPS_SOURCE, /job\.mode \? `\$\{job\.mode\} only` : "runs in every mode"/,
    "the mode badge distinguishes tagged jobs from legacy all-mode jobs");
  assert.doesNotMatch(`${LOOPS_SOURCE}\n${MULTI_LOOPS_SOURCE}`, /dangerouslySetInnerHTML/,
    "mode names stay React text rather than injected markup");
});

test("the generated shell carries the authenticated mode API value into both Loop renderers", () => {
  assert.match(API_SOURCE, /export function fetchMode[\s\S]{0,160}?getJson\("\/api\/mode"\)/,
    "the dashboard API reads the box mode endpoint");
  assert.match(LIVE_SOURCE, /export function useMode\(\)[\s\S]{0,180}?usePolled\(fetchMode, 60000\)[\s\S]{0,120}?mode: data\?\.mode \?\? null/,
    "the live hook returns the observed API mode");
  assert.match(COMMAND_CENTER_SOURCE, /const \{ mode: serverMode, problem: modeProblem, refetch: refetchMode \} = useMode\(\)/,
    "the generated shell consumes that hook");
  assert.match(COMMAND_CENTER_SOURCE, /const shellMode = shellModeFromServer\(serverMode\)/,
    "an unobserved mode remains unknown in the dashboard vocabulary");
  assert.match(COMMAND_CENTER_SOURCE, /activeRoom === "systems"[\s\S]{0,180}?<SystemsView[\s\S]{0,160}?mode=\{shellMode\}/,
    "the observed mode reaches the Systems room");
  assert.match(SYSTEMS_SOURCE, /tab === "loops"[\s\S]{0,160}?<Loops[\s\S]{0,80}?mode=\{mode\}/,
    "Systems passes that same value into single Loops");
  assert.match(LOOPS_SOURCE, /<MultiLoops[\s\S]{0,100}?mode=\{mode\}/,
    "Loops passes that same value into Multi-Loops");
});

// ---- the real box -----------------------------------------------------------

const boxes = {};
function seedJobs(home) {
  const dir = path.join(home, ".claude", "agenthost", "cron");
  fs.mkdirSync(dir, { recursive: true });
  const base = { cron: "* * * * *", prompt: "say hi", tzOffsetMin: 0, createdAt: new Date().toISOString() };
  fs.writeFileSync(path.join(dir, "jobs.json"), JSON.stringify([
    { id: UNTAGGED, name: "untagged loop", ...base },
    { id: TAGGED, name: "growth loop", ...base, mode: "growth" },
  ]));
}

function bootGate(home, extraEnv) {
  const child = spawn("node", [GATE], {
    env: {
      ...process.env, HOME: home, TTYD_PASSWORD: KEY, AGENT_CHAT_BIN: "/bin/true",
      GATE_PORT: "0", AGENTHOST_SCHEDULER_TICK_MS: "200", ...extraEnv,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const port = new Promise((resolve, reject) => {
    let out = "";
    const to = setTimeout(() => reject(new Error("gate did not report its port; got: " + out)), 15000);
    child.stdout.on("data", (c) => {
      out += c.toString();
      const m = out.match(/listening on (\d+)/);
      if (m) { clearTimeout(to); resolve(Number(m[1])); }
    });
    child.on("exit", () => { clearTimeout(to); reject(new Error("gate exited before listening; got: " + out)); });
  });
  return { child, port };
}

const authed = (box, p, init) => {
  const origin = `http://127.0.0.1:${box.port}`;
  return fetch(`${origin}${p}`, { ...init, headers: { cookie: box.cookie, origin, "sec-fetch-site": "same-origin", ...(init && init.headers) }, redirect: "manual" });
};
const runsFor = async (box, id) => (await (await authed(box, `/cron/runs?job=${id}`)).json()).runs;

// Poll until the scheduler has had a real chance to fire (the tick is 200ms and
// the run record is written after the spawn fails), then look at the ledger of
// what ran. Returns as soon as the expected job has run so the suite stays fast.
async function waitForRun(box, id, ms = 12000) {
  const until = Date.now() + ms;
  for (;;) {
    const runs = await runsFor(box, id);
    if (runs.length) return runs;
    if (Date.now() > until) return runs;
    await new Promise((r) => setTimeout(r, 250));
  }
}

before(async () => {
  for (const name of ["dflt", "growth"]) {
    const home = fs.mkdtempSync(path.join(import.meta.dirname, `.modeloops-${name}-`));
    seedJobs(home);
    const env = {};
    if (name === "dflt") {
      env.AGENTHOST_MODE_FILE = path.join(home, "absent.json"); // no /data on a dev machine
    } else {
      const file = path.join(home, "mode.json");
      fs.writeFileSync(file, JSON.stringify(modeLib.buildModeState("growth")));
      env.AGENTHOST_MODE_FILE = file;
      const dir = path.join(home, ".claude", "modes", "growth");
      fs.mkdirSync(dir, { recursive: true });
      for (const packFile of ["mode.toml", "MODE.md"]) {
        fs.copyFileSync(path.join(import.meta.dirname, "..", "packs", "growth", packFile), path.join(dir, packFile));
      }
    }
    const b = bootGate(home, env);
    boxes[name] = { home, child: b.child, port: await b.port };
    const base = `http://127.0.0.1:${boxes[name].port}`;
    boxes[name].cookie = (await mintOperatorSession(base, KEY)).cookie;
  }
});

after(async () => {
  for (const b of Object.values(boxes)) {
    if (b.child) await stopChild(b.child);
    fs.rmSync(b.home, { recursive: true, force: true });
  }
});

test("a default box fires the untagged Loop and never the growth-tagged one (revert parks it)", async () => {
  const untagged = await waitForRun(boxes.dflt, UNTAGGED);
  assert.ok(untagged.length >= 1, "the untagged Loop ran on a default box");
  assert.deepEqual(await runsFor(boxes.dflt, TAGGED), [], "the growth Loop did not run, not even a skip record");
});

test("a growth box fires both -- the tag matches, so the department is live", async () => {
  assert.ok((await waitForRun(boxes.growth, TAGGED)).length >= 1, "the growth Loop ran on a growth box");
  assert.ok((await waitForRun(boxes.growth, UNTAGGED)).length >= 1, "and the untagged one still runs");
});

test("a Loop created on a growth box is stamped growth and reaches the generated Loops data", async () => {
  const res = await authed(boxes.growth, "/cron/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "new growth loop", cron: "0 7 * * *", prompt: "brief me", tzOffsetMin: 0 }),
  });
  assert.equal(res.status, 200);
  const created = (await res.json()).job;
  assert.equal(created.mode, "growth");
  const listed = (await (await authed(boxes.growth, "/cron/jobs")).json()).jobs.find((j) => j.id === created.id);
  assert.equal(listed.mode, "growth", "GET /cron/jobs hands the tag to the generated Loops surface");
});

test("a Loop created on a default box carries no tag at all (today's jobs.json shape)", async () => {
  const res = await authed(boxes.dflt, "/cron/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "plain loop", cron: "0 7 * * *", prompt: "brief me", tzOffsetMin: 0 }),
  });
  assert.equal(res.status, 200);
  const created = (await res.json()).job;
  assert.equal("mode" in created, false);
});

test("the generated Loops shell reads each box's mode from the authenticated API", async () => {
  const growthPage = await (await authed(boxes.growth, "/cron")).text();
  const defaultPage = await (await authed(boxes.dflt, "/cron")).text();
  assert.equal(growthPage, defaultPage, "mode does not fork the generated shell bytes");
  assert.doesNotMatch(growthPage, /<body[^>]*data-mode=/, "the retired server-stamped page is not back");

  const growthMode = await (await authed(boxes.growth, "/api/mode")).json();
  const defaultMode = await (await authed(boxes.dflt, "/api/mode")).json();
  assert.equal(growthMode.mode, "growth", "the client receives the mode that parks or runs tagged Loops");
  assert.equal(defaultMode.mode, "default", "the default box reports its actual mode to the same client");
});
