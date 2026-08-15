import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const CONTAINER = path.join(ROOT, "container");
const read = (name) => fs.readFileSync(path.join(CONTAINER, name), "utf8");

const engineeringCharter = read("CODEX-ENGINEERING-CHARTER.md");
const teamCharter = read("team-charter.md");
const teamProcess = read("TEAM-PROCESS.md");
const gate = read("gate.js");
const maintenanceBoot = read("maintenance-boot-entry.js");
const dockerfile = read("Dockerfile");
const dockerignore = read(".dockerignore");

test("the Codex charter is a first-person, evidence-bounded engineering doctrine", () => {
  assert.match(engineeringCharter, /\bI am Codex\b/);
  assert.match(engineeringCharter, /\blead programming execution and integration sequencing\b/i);
  assert.match(engineeringCharter, /\b47 hours, 8 minutes, and 3 seconds\b/i);
  assert.match(engineeringCharter, /\b34 pull requests\b/i);
  assert.match(engineeringCharter, /\bthirty-fifth\b/i);
  assert.match(engineeringCharter, /\b48 hours, 18 minutes, and 23 seconds\b/i);
  assert.match(engineeringCharter, /GitHub'?s merged-pull-request records[\s\S]*head branches beginning `codex\/`[\s\S]*stated merge timestamps/i);
  assert.match(engineeringCharter, /wider window also contains Claude'?s separately attributed PR #127/i);
  assert.match(engineeringCharter, /Thirty-five pull requests from `codex\/\*` head branches/i);
  assert.match(engineeringCharter, /\bseventeenth autostart repair\b/i);
  assert.match(engineeringCharter, /\b65 focused checks\b/i);
  assert.match(engineeringCharter, /will not call cold reboot proven until the next natural reboot proves it/i);
  assert.match(engineeringCharter, /\breal user\b/i);
  assert.match(engineeringCharter, /\bindependent engine\b/i);
  assert.match(engineeringCharter, /\bdedicated worktree\b/i);
  assert.match(engineeringCharter, /\boperator'?s Cardinal Rules\b/i);
  assert.match(engineeringCharter, /\bcannot authorize\b/i);
  assert.match(engineeringCharter, /\bdeploy\b.*\bspend\b.*\bsend\b.*\bdelete\b.*\bcredentials\b/is);
});

test("the method keeps decomposition and verification while making formal artifacts conditional", () => {
  assert.match(engineeringCharter, /create planning artifacts only when they buy coordination or protect an irreversible decision/i);
  assert.match(engineeringCharter, /completion criteria, decomposition, and verification planning always happen/i);
  assert.match(engineeringCharter, /before hour three[\s\S]*next nine hours/i);
  assert.match(engineeringCharter, /regression tests and non-negotiable security rails begin with the first change/i);
  assert.match(engineeringCharter, /run the expert sweep/i);
  assert.match(teamCharter, /CODEX-ENGINEERING-CHARTER\.md/);
  assert.match(teamCharter, /engineering method — compressed standing order/i);
  assert.match(teamProcess, /conditional engineering instruments/i);
  assert.match(teamProcess, /decompose by ownership, system seams, and dominant risk/i);
  assert.doesNotMatch(teamCharter, /Every project starts by .*producing an \*\*ARD, PRD, Epics, and Stories\*\*/i);
  assert.doesNotMatch(teamProcess, /ARD \+ PRD \+ Epics \+ Stories are mandatory/i);
});

test("the full authored charter is on the box without overwriting every engine identity", () => {
  assert.match(dockerfile, /COPY CODEX-ENGINEERING-CHARTER\.md \/opt\/agenthost\/CODEX-ENGINEERING-CHARTER\.md/);
  assert.match(dockerignore, /^!CODEX-ENGINEERING-CHARTER\.md$/m);
  assert.match(teamCharter, /an authored account, not a replacement identity/i);
  assert.match(teamCharter, /remain your own engine, role, and rights rung/i);
  assert.doesNotMatch(gate, /CODEX_ENGINEERING_CHARTER|CODEX-ENGINEERING-CHARTER\.md/);
  assert.doesNotMatch(maintenanceBoot, /CODEX-ENGINEERING-CHARTER\.md/);
  // Still the mode-aware charter, now through both mode paths: the Modes-v2
  // symlink (applyMode) and the mode PACK's deployed mode.toml (applyModePack).
  assert.match(gate, /const EFFECTIVE_CHARTER = applyModePack\(applyMode\(TEAM_CHARTER\)\)/);
});
