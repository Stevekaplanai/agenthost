// Growth Mode Wave 0, T0.6 -- the regression eval. Every other mode test proves
// one ticket; this one proves the LIFECYCLE, on one box, in order:
//
//   step 1  default  -- no mode file, exactly the box Steve has today
//   step 2  growth   -- the state file + the shipped pack's two on-box mode files
//   step 3  revert   -- `agenthost mode revert`: back to default, pack left deployed
//
// The load-bearing claim is REVERSIBILITY: step 3 must serve byte-identically to
// step 1, or "revert" is a promise the box cannot keep. So each step captures a
// MANIFEST -- the actual bytes of every surface an operator can reach -- from a
// real gate booted on the same HOME, and the steps are compared to each other.
//
// The legal lane rides along at every step (ARD H2: legal is a brand, growth is
// a parallel channel). Its manifest must be identical in all three steps: a
// growth mode file on a legal box may not move one byte of the legal product.
//
// Mode switching here is the FILE the CLI writes (src/commands/mode.js
// buildModeState) plus a fresh boot -- not `fly ssh` and not a real machine
// restart, which no test can reach. That is the honest boundary, and it is the
// same boundary the box itself has: mode is read once, at boot.
// Run: node --test test/mode-regression.test.js
// Report card: node scripts/wave0-eval.mjs -> docs/wave0-eval-report.md
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

const ROOT = path.join(import.meta.dirname, "..");
const GATE = path.join(ROOT, "container", "gate.js");
const PACK = path.join(ROOT, "packs", "growth");
const SHELL = fs.readFileSync(path.join(ROOT, "container", "dashboard-ui", "index.html"), "utf8");
const KEY = "moderegressiontestkey";

// The manifest: every surface whose bytes have to survive a round trip through
// growth. Unauthenticated first (what a browser hits before the cookie wall),
// then the app routes behind it.
//
// The install assets ride through the full lifecycle too. Navigation itself is
// part of the generated shell; the removed handwritten nav and app registry are
// intentionally absent from this manifest and have focused 404 tests.
const UNAUTH = ["/", "/brand.json", "/mode.json", "/manifest.webmanifest", "/sw.js"];
const CANONICAL_AUTHED = ["/audit", "/2fa"];
const RETIRED = ["/cc", "/cc/legacy", "/desk", "/chat", "/cron", "/kanban", "/brain", "/profiles", "/settings"];
const AUTHED = [...CANONICAL_AUTHED, ...RETIRED];
// The HTML pages among them -- the surfaces the <body> stamp lands on.
const PAGES = ["/", ...CANONICAL_AUTHED];

// ---- the lifecycle ----------------------------------------------------------

// Every gate this file starts, whether or not it ever reported a port. before()
// boots six of them in sequence; one that fails to come up throws out of before()
// and the ones already running are never stopped by the happy path -- orphaned
// node processes holding ports until the machine is rebooted. after() still runs
// when before() throws, so this list is the only thing that can reach them.
const spawned = [];

function bootGate(home, extraEnv) {
  const child = spawn("node", [GATE], {
    env: { ...process.env, HOME: home, TTYD_PASSWORD: KEY, AGENT_CHAT_BIN: "/bin/true", GATE_PORT: "0", ...extraEnv },
    stdio: ["ignore", "pipe", "inherit"],
  });
  spawned.push(child);
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

// What the box reads after `agenthost mode <name>`: the state file and, for a
// non-default mode, the two on-box mode files at their real landing path. The
// REAL shipped MODE.md + mode.toml are used. Full agent/skill landing belongs to
// test/mode-pack.test.js; this lifecycle suite does not claim to exercise it.
function deployGrowthPack(home) {
  const dir = path.join(home, ".claude", "modes", "growth");
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ["mode.toml", "MODE.md"]) fs.copyFileSync(path.join(PACK, f), path.join(dir, f));
}
function applyStep(home, step) {
  const file = path.join(home, "mode.json");
  if (step === "default") return fs.rmSync(file, { force: true }); // a box that never switched
  if (step === "growth") {
    deployGrowthPack(home);
    return fs.writeFileSync(file, JSON.stringify(modeLib.buildModeState("growth")));
  }
  // revert writes mode "default" -- it does not delete the file, and it does not
  // unship the pack. Both facts are exactly why this step needs its own capture.
  fs.writeFileSync(file, JSON.stringify(modeLib.buildModeState(modeLib.DEFAULT_MODE)));
}

async function capture(port, cookie) {
  const out = {};
  for (const p of [...UNAUTH, ...AUTHED]) {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      headers: AUTHED.includes(p) ? { cookie } : {},
      redirect: "manual",
    });
    out[p] = { status: res.status, location: res.headers.get("location"), body: await res.text() };
  }
  return out;
}

const homes = {};
const manifests = { default: {}, growth: {}, revert: {} };

before(async () => {
  // The `.gate` prefix is load-bearing, not decoration: .gitignore covers
  // test/.gate*/, and the old `.moderegr-` prefix fell outside it -- an
  // interrupted run left 136 scratch homes sitting untracked in the worktree.
  for (const lane of ["dev", "legal"]) homes[lane] = fs.mkdtempSync(path.join(import.meta.dirname, `.gate-moderegr-${lane}-`));
  for (const step of ["default", "growth", "revert"]) {
    const boxes = [];
    for (const lane of ["dev", "legal"]) {
      applyStep(homes[lane], step);
      const env = { AGENTHOST_MODE_FILE: path.join(homes[lane], "mode.json") };
      if (lane === "legal") env.LEGAL_MODE = "api";
      const b = bootGate(homes[lane], env);
      boxes.push({ lane, child: b.child, port: await b.port });
    }
    for (const box of boxes) {
      const base = `http://127.0.0.1:${box.port}`;
      const { cookie } = await mintOperatorSession(base, KEY);
      manifests[step][box.lane] = await capture(box.port, cookie);
      await stopChild(box.child);
    }
  }
});

after(async () => {
  // stopChild is a no-op on an already-exited child, so re-stopping the boxes
  // the happy path already stopped costs nothing and covers the path where
  // before() threw partway through.
  for (const child of spawned) await stopChild(child);
  for (const home of Object.values(homes)) fs.rmSync(home, { recursive: true, force: true });
});

const json = (m, p) => JSON.parse(m[p].body);
// Remove the growth stamp FROM THE BODY TAG ONLY. Several pages and the nav
// script quote the attribute in their own comments to document the mechanism; a
// blunt string strip eats those too and invents a difference that isn't there.
const unstamp = (body) => body.replace(/(<body)\s+data-mode="growth"/, "$1");

// ---- step 1: default is the box that was here before Wave 0 -----------------

test("step 1 default: GET /mode.json reports default", () => {
  assert.deepEqual(json(manifests.default.dev, "/mode.json"), { mode: "default" });
});

test("step 1 default: the generated shell's install assets are served", () => {
  assert.equal(manifests.default.dev["/manifest.webmanifest"].status, 200);
  assert.equal(manifests.default.dev["/sw.js"].status, 200);
  assert.doesNotMatch(manifests.default.dev["/"].body, /agenthost-(?:nav|appshell)\.js|\/apps\.json/);
});

test("step 1 default: no served page carries a data-mode stamp", () => {
  // The BODY TAG of an HTML page is the question: the nav script and several
  // pages name the attribute in their own comments, which is documentation of
  // the mechanism, not a stamp by it.
  for (const p of PAGES) assert.doesNotMatch(manifests.default.dev[p].body, /<body[^>]*data-mode/, p);
});

test("step 1 default: canonical entries serve the shell and deleted roots are retired", () => {
  for (const p of CANONICAL_AUTHED) {
    assert.equal(manifests.default.dev[p].status, 200, p);
    assert.equal(manifests.default.dev[p].body, manifests.default.dev[CANONICAL_AUTHED[0]].body, p);
  }
  for (const p of RETIRED) {
    assert.equal(manifests.default.dev[p].status, 410, p);
    assert.equal(manifests.default.dev[p].location, null, p);
    assert.notEqual(manifests.default.dev[p].body, SHELL, p);
  }
});

// ---- step 2: growth is on -- allowlist, /mode.json, badge stamp -------------

test("step 2 growth: GET /mode.json reports growth (the shipped mode files passed the boot validator)", () => {
  assert.deepEqual(json(manifests.growth.dev, "/mode.json"), { mode: "growth" });
});

test("step 2 growth: login is stamped and the generated shell reads live mode instead of forking its bytes", () => {
  assert.match(manifests.growth.dev["/"].body, /<body[^>]*data-mode="growth"/, "/");
  for (const p of CANONICAL_AUTHED) {
    assert.equal(manifests.growth.dev[p].status, 200, p);
    assert.equal(manifests.growth.dev[p].body, manifests.growth.dev[CANONICAL_AUTHED[0]].body, `${p} must stay one generated shell across modes`);
  }
});

test("step 2 growth: the login stamp is the only server-rendered page-byte change", () => {
  assert.equal(unstamp(manifests.growth.dev["/"].body), manifests.default.dev["/"].body, "/");
});

test("step 2 growth: deleted application roots remain 410 with no compatibility UI", () => {
  for (const p of RETIRED) {
    assert.equal(manifests.growth.dev[p].status, 410, p);
    assert.equal(manifests.growth.dev[p].location, null, p);
    assert.notEqual(manifests.growth.dev[p].body, SHELL, p);
  }
});

// ---- step 3: revert -- the whole point of the eval --------------------------

test("step 3 revert: GET /mode.json reports default again", () => {
  assert.deepEqual(json(manifests.revert.dev, "/mode.json"), { mode: "default" });
});

test("step 3 revert: every captured surface is byte-identical to step 1", () => {
  // One assert over the whole manifest on purpose: a diff anywhere -- a stray
  // stamp, a moved tab, a route that stayed redirected -- fails it by name.
  assert.deepEqual(manifests.revert.dev, manifests.default.dev);
});

test("step 3 revert: the growth mode files are still deployed, and still change nothing", () => {
  for (const file of ["MODE.md", "mode.toml"]) {
    assert.ok(fs.existsSync(path.join(homes.dev, ".claude", "modes", "growth", file)),
      `revert leaves ${file} on the volume -- switching back must not need a redeploy`);
  }
  assert.equal(manifests.revert.dev["/manifest.webmanifest"].body, manifests.default.dev["/manifest.webmanifest"].body);
  assert.equal(manifests.revert.dev["/sw.js"].body, manifests.default.dev["/sw.js"].body);
});

// ---- the gates: legal and brand do not move, at any step --------------------

test("gates: a growth mode file moves nothing on a legal box except the mode stamp (H2)", () => {
  // The mode channel is allowed to answer for itself and stamp login. Everything else -- every byte
  // of every page, every status, every redirect -- has to be the legal box that
  // was here before Growth Mode existed.
  const legalSurfaces = (m) => Object.fromEntries(Object.entries(m)
    .filter(([p]) => p !== "/mode.json")
    .map(([p, r]) => [p, { ...r, body: unstamp(r.body) }]));
  assert.deepEqual(legalSurfaces(manifests.growth.legal), legalSurfaces(manifests.default.legal), "a growth mode file changed a legal box");
  assert.deepEqual(legalSurfaces(manifests.revert.legal), legalSurfaces(manifests.default.legal));
});

test("gates: /brand.json answers the same at every step, on both lanes", () => {
  for (const step of ["default", "growth", "revert"]) {
    assert.deepEqual(json(manifests[step].dev, "/brand.json"), { brand: "dev" }, step);
    assert.deepEqual(json(manifests[step].legal, "/brand.json"), { brand: "legal" }, step);
  }
});

test("gates: the legal login stamp survives while only canonical entries use the shell", () => {
  for (const step of ["default", "growth", "revert"]) {
    assert.match(manifests[step].legal["/"].body, /<body[^>]*data-brand="legal"/, step);
    for (const p of CANONICAL_AUTHED) {
      assert.equal(manifests[step].legal[p].status, 200, `${step} ${p}`);
      assert.equal(manifests[step].legal[p].location, null, `${step} ${p}`);
      assert.equal(manifests[step].legal[p].body, manifests[step].legal[CANONICAL_AUTHED[0]].body, `${step} ${p}`);
    }
    for (const p of RETIRED) assert.equal(manifests[step].legal[p].status, 410, `${step} ${p}`);
  }
});

test("gates: the shipped growth mode.toml declares no consequence gates", () => {
  // The non-negotiable stated as an assertion over the artifact that ships: no
  // mode file may claim spend/send/deploy/delete/credentials. The validator
  // enforces this at boot; here it is checked on the bytes in the repo.
  for (const f of fs.readdirSync(PACK)) {
    if (!/\.(toml|json|md)$/.test(f)) continue;
    assert.doesNotMatch(fs.readFileSync(path.join(PACK, f), "utf8"), /^\s*\[gates(\.|])/m, f);
  }
});

// ---- the loops half of the revert promise -----------------------------------
// Behavioral proof (a real box, a real tick, a real run record) is T0.5's
// gate-mode-loops suite. Here the predicate itself is pinned, because it is what
// makes revert PARK the department instead of leaving it firing.

test("loops: a growth-tagged Loop fires only in growth", () => {
  assert.equal(gate.jobRunsInMode({ mode: "growth" }, "growth"), true);
  assert.equal(gate.jobRunsInMode({ mode: "growth" }, "default"), false);
});

test("loops: an untagged Loop fires in every mode (nothing that predates Wave 0 stops)", () => {
  for (const mode of modeLib.MODES) assert.equal(gate.jobRunsInMode({ id: "legacyjob0001" }, mode), true, mode);
});
