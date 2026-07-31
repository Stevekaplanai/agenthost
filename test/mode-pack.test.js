// H1 (Growth Mode ARD, T0.2): the pack pipeline must ship a pack's agents/,
// MODE.md, and mode.toml -- not just skills/. Before this, a mode pack would
// stage its skills and silently drop every hat definition, so the mode booted
// with zero agents. Collision policy: the user's harness wins and the skip is
// reported, EXCEPT for content the pack declares critical in pack.json --
// silently skipping those would strip a gate-critical skill, so the pack
// hard-fails instead, naming the collision.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACK_MJS = path.join(REPO_ROOT, "scripts", "pack.mjs");
const FIXTURE_PACK = "t02-mode-fixture"; // lives under repo packs/ for the test's lifetime only

function makeFixturePack() {
  const dir = path.join(REPO_ROOT, "packs", FIXTURE_PACK);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "skills", "growth-content"), { recursive: true });
  fs.writeFileSync(path.join(dir, "skills", "growth-content", "SKILL.md"), "---\nname: growth-content\ndescription: fixture\n---\n");
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
  fs.writeFileSync(path.join(dir, "agents", "media-auditor.md"), "---\nname: media-auditor\n---\ndummy hat\n");
  fs.writeFileSync(path.join(dir, "MODE.md"), "# Growth Mode fixture\n");
  fs.writeFileSync(path.join(dir, "mode.toml"), 'name = "growth"\n');
  fs.writeFileSync(path.join(dir, "pack.json"), JSON.stringify({ criticalSkills: ["growth-content"], criticalAgents: ["media-auditor"] }));
  return dir;
}

function makeHome(prefix) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{}");
  return home;
}

function runPack(home, extra) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-pack-out-"));
  const res = spawnSync(process.execPath, [PACK_MJS, "--out", out, "--dry-run", ...extra], {
    encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8")); } catch { /* hard-fail runs write no manifest */ }
  let compatReport = null;
  try { compatReport = fs.readFileSync(path.join(out, "compat-report.md"), "utf8"); } catch { /* ditto */ }
  return { res, out, manifest, compatReport };
}

test("pack ships agents + MODE.md + mode.toml into the staged harness (H1 landing test)", (t) => {
  const packDir = makeFixturePack();
  t.after(() => fs.rmSync(packDir, { recursive: true, force: true }));
  const home = makeHome("agenthost-mode-home-");
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const { res, out, manifest, compatReport } = runPack(home, ["--pack", FIXTURE_PACK]);
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  assert.equal(res.status, 0, `packer failed: ${res.stderr}`);

  const staged = path.join(out, "staging", ".claude");
  // The dummy agent lands at the exact path the box roster reads (~/.claude/agents/)
  assert.ok(fs.existsSync(path.join(staged, "agents", "media-auditor.md")), "agent staged into .claude/agents/");
  assert.ok(fs.existsSync(path.join(staged, "skills", "growth-content", "SKILL.md")), "skill staged");
  assert.ok(fs.existsSync(path.join(staged, "modes", FIXTURE_PACK, "MODE.md")), "MODE.md staged");
  assert.ok(fs.existsSync(path.join(staged, "modes", FIXTURE_PACK, "mode.toml")), "mode.toml staged");

  const entry = manifest.packs?.find((p) => p.name === FIXTURE_PACK);
  assert.ok(entry, "manifest records the pack");
  assert.deepEqual(entry.agents, ["media-auditor.md"], "manifest records the pack's agents");
  assert.deepEqual(entry.modeFiles.sort(), ["MODE.md", "mode.toml"], "manifest records the mode files");

  // The pack report is the ticket's reachable surface
  assert.match(compatReport, /## Packs/, "compat-report has a Packs section");
  assert.match(compatReport, new RegExp(`${FIXTURE_PACK}.*media-auditor`, "s"), "report names the shipped agent");
});

test("critical: true skill collision hard-fails, named (H3 guard)", (t) => {
  const packDir = makeFixturePack();
  t.after(() => fs.rmSync(packDir, { recursive: true, force: true }));
  const home = makeHome("agenthost-mode-home2-");
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  // Steve's harness really does have a same-named content skill -- simulate it
  const mine = path.join(home, ".claude", "skills", "growth-content");
  fs.mkdirSync(mine, { recursive: true });
  fs.writeFileSync(path.join(mine, "SKILL.md"), "MINE");

  const { res, out } = runPack(home, ["--pack", FIXTURE_PACK]);
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  assert.notEqual(res.status, 0, "critical skill collision must fail the pack");
  assert.match(res.stderr, /growth-content/, "failure names the colliding skill");
  assert.match(res.stderr, new RegExp(FIXTURE_PACK), "failure names the pack");
});

test("critical agent collision hard-fails too", (t) => {
  const packDir = makeFixturePack();
  t.after(() => fs.rmSync(packDir, { recursive: true, force: true }));
  const home = makeHome("agenthost-mode-home3-");
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, ".claude", "agents"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "agents", "media-auditor.md"), "MINE");

  const { res, out } = runPack(home, ["--pack", FIXTURE_PACK]);
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  assert.notEqual(res.status, 0, "critical agent collision must fail the pack");
  assert.match(res.stderr, /media-auditor/, "failure names the colliding agent");
});

test("non-critical collision keeps the user's copy and reports the skip", (t) => {
  const packDir = makeFixturePack();
  t.after(() => fs.rmSync(packDir, { recursive: true, force: true }));
  // Loosen the fixture: nothing critical
  fs.writeFileSync(path.join(packDir, "pack.json"), "{}");
  const home = makeHome("agenthost-mode-home4-");
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, ".claude", "agents"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "agents", "media-auditor.md"), "MINE — do not overwrite");

  const { res, out, manifest } = runPack(home, ["--pack", FIXTURE_PACK]);
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  assert.equal(res.status, 0, `packer failed: ${res.stderr}`);
  const staged = path.join(out, "staging", ".claude", "agents", "media-auditor.md");
  assert.equal(fs.readFileSync(staged, "utf8"), "MINE — do not overwrite", "user agent preserved");
  assert.ok(manifest.flags.some((f) => /media-auditor/.test(f) && /yours kept/.test(f)), "agent collision reported");
});

test("a pack with agents but no skills dir still loads", (t) => {
  const packDir = makeFixturePack();
  t.after(() => fs.rmSync(packDir, { recursive: true, force: true }));
  fs.rmSync(path.join(packDir, "skills"), { recursive: true, force: true });
  fs.rmSync(path.join(packDir, "pack.json"), { force: true });
  const home = makeHome("agenthost-mode-home5-");
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const { res, out, manifest } = runPack(home, ["--pack", FIXTURE_PACK]);
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  assert.equal(res.status, 0, `packer failed: ${res.stderr}`);
  const entry = manifest.packs?.find((p) => p.name === FIXTURE_PACK);
  assert.deepEqual(entry?.agents, ["media-auditor.md"], "agents-only pack loads");
  assert.ok(!manifest.flags.some((f) => /not found/.test(f)), "no false not-found flag");
});
