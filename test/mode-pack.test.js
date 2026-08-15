// H1 (Growth Mode ARD, T0.2, ported internally as T0.2b): the pack pipeline
// must ship a pack's agents/, MODE.md, and mode.toml -- not just skills/.
// Before this, a mode pack would stage its skills and silently drop every hat
// definition, so the mode booted with zero agents. Collision policy: the user's
// harness wins and the skip is reported, EXCEPT for content the pack declares
// critical in pack.json -- silently skipping those would strip a gate-critical
// skill, so the pack hard-fails instead, naming the collision.
//
// Every fixture pack is written into a THROWAWAY fake repo (the internal
// convention -- see test/pack-security-invariants.test.js), never into this
// repo's own packs/: a crash mid-test used to leave a stray pack inside the
// tracked worktree that `git add -A` would happily commit, and tests sharing
// one mutable fixture dir made the collision guards flaky.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packFlags, missingPacks, validateRequestedModePacks } from "../src/pack.js";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACK = "t02-mode-fixture";

// A minimal copy of the packer + its two imports, so --pack resolves packs/
// inside the fake repo instead of the real one.
function makeFakeRepo(t, packFiles) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-mode-fixture-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  for (const [from, to] of [
    [["scripts", "pack.mjs"], ["scripts", "pack.mjs"]],
    [["scripts", "pack-lib.mjs"], ["scripts", "pack-lib.mjs"]],
    [["src", "child-env.js"], ["src", "child-env.js"]],
  ]) fs.copyFileSync(path.join(REPO_ROOT, ...from), path.join(repo, ...to));
  for (const [rel, body] of Object.entries(packFiles)) {
    const p = path.join(repo, "packs", PACK, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  return repo;
}

// The default fixture pack: one skill, one hat, both mode files, both critical.
function defaultPackFiles(overrides = {}) {
  return {
    "skills/growth-content/SKILL.md": "---\nname: growth-content\ndescription: fixture\n---\n",
    "agents/media-auditor.md": "---\nname: media-auditor\n---\ndummy hat\n",
    "MODE.md": "# Growth Mode fixture\n",
    "mode.toml": 'name = "growth"\n',
    "pack.json": JSON.stringify({ criticalSkills: ["growth-content"], criticalAgents: ["media-auditor"] }),
    ...overrides,
  };
}

function makeHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-mode-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{}");
  return home;
}

// Internal packer auto-detects Hermes/Codex/OpenClaw (HERMES_HOME et al. ride
// process.env) -- opt out so the fixture home, not this machine, is what's packed.
const ISOLATE = ["--no-hermes", "--no-codex", "--no-openclaw", "--no-discovery"];

function runPack(t, repo, home, extra = ["--pack", PACK], { dryRun = true } = {}) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-mode-out-"));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const res = spawnSync(
    process.execPath,
    [path.join(repo, "scripts", "pack.mjs"), "--out", out, ...(dryRun ? ["--dry-run"] : []), ...ISOLATE, ...extra],
    { encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home } },
  );
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8")); } catch { /* hard-fail runs write no manifest */ }
  let compatReport = null;
  try { compatReport = fs.readFileSync(path.join(out, "compat-report.md"), "utf8"); } catch { /* ditto */ }
  return { res, out, manifest, compatReport };
}

function linkDirectory(t, target, link) {
  try {
    fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
      t.skip(`this machine cannot create a test link: ${error.code}`);
      return false;
    }
    throw error;
  }
}

test("pack ships agents + MODE.md + mode.toml into the staged harness (H1 landing test)", (t) => {
  const repo = makeFakeRepo(t, defaultPackFiles());
  const { res, out, manifest, compatReport } = runPack(t, repo, makeHome(t));
  assert.equal(res.status, 0, `packer failed: ${res.stderr}`);

  const staged = path.join(out, "staging", ".claude");
  // The dummy agent lands at the exact path the box roster reads (~/.claude/agents/)
  assert.ok(fs.existsSync(path.join(staged, "agents", "media-auditor.md")), "agent staged into .claude/agents/");
  assert.ok(fs.existsSync(path.join(staged, "skills", "growth-content", "SKILL.md")), "skill staged");
  assert.ok(fs.existsSync(path.join(staged, "modes", PACK, "MODE.md")), "MODE.md staged");
  // mode.toml must SURVIVE the structured-config omit pass: it is repo-vetted
  // pack content, not user harness state (still content-audited by the final scans)
  assert.ok(fs.existsSync(path.join(staged, "modes", PACK, "mode.toml")), "mode.toml staged");

  const entry = manifest.packs?.find((p) => p.name === PACK);
  assert.ok(entry, "manifest records the pack");
  assert.deepEqual(entry.agents, ["media-auditor.md"], "manifest records the pack's agents");
  assert.deepEqual(entry.modeFiles.sort(), ["MODE.md", "mode.toml"], "manifest records the mode files");

  // The pack report is the ticket's reachable surface
  assert.match(compatReport, /## Packs/, "compat-report has a Packs section");
  assert.match(compatReport, new RegExp(`${PACK}.*media-auditor`, "s"), "report names the shipped agent");
});

test("critical: true skill collision hard-fails, named (H3 guard)", (t) => {
  const repo = makeFakeRepo(t, defaultPackFiles());
  const home = makeHome(t);
  // Steve's harness really does have a same-named content skill -- simulate it
  const mine = path.join(home, ".claude", "skills", "growth-content");
  fs.mkdirSync(mine, { recursive: true });
  fs.writeFileSync(path.join(mine, "SKILL.md"), "MINE");

  const { res } = runPack(t, repo, home);
  assert.notEqual(res.status, 0, "critical skill collision must fail the pack");
  assert.match(res.stderr, /growth-content/, "failure names the colliding skill");
  assert.match(res.stderr, new RegExp(PACK), "failure names the pack");
});

test("critical agent collision hard-fails too", (t) => {
  const repo = makeFakeRepo(t, defaultPackFiles());
  const home = makeHome(t);
  fs.mkdirSync(path.join(home, ".claude", "agents"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "agents", "media-auditor.md"), "MINE");

  const { res } = runPack(t, repo, home);
  assert.notEqual(res.status, 0, "critical agent collision must fail the pack");
  assert.match(res.stderr, /media-auditor/, "failure names the colliding agent");
});

test("non-critical collision keeps the user's copy and reports the skip", (t) => {
  // Loosen the fixture: nothing critical
  const repo = makeFakeRepo(t, defaultPackFiles({ "pack.json": "{}" }));
  const home = makeHome(t);
  fs.mkdirSync(path.join(home, ".claude", "agents"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "agents", "media-auditor.md"), "MINE — do not overwrite");

  const { res, out, manifest } = runPack(t, repo, home);
  assert.equal(res.status, 0, `packer failed: ${res.stderr}`);
  const staged = path.join(out, "staging", ".claude", "agents", "media-auditor.md");
  assert.equal(fs.readFileSync(staged, "utf8"), "MINE — do not overwrite", "user agent preserved");
  assert.ok(manifest.flags.some((f) => /media-auditor/.test(f) && /yours kept/.test(f)), "agent collision reported");
});

test("a non-array criticalSkills fails loud instead of silently disarming the guard", (t) => {
  // new Set("growth-content") is a set of characters -- has("growth-content")
  // would never match, so a bare-string typo must be rejected outright
  const repo = makeFakeRepo(t, defaultPackFiles({ "pack.json": JSON.stringify({ criticalSkills: "growth-content" }) }));
  const { res } = runPack(t, repo, makeHome(t));
  assert.notEqual(res.status, 0, "non-array criticalSkills must fail the pack");
  assert.match(res.stderr, /criticalSkills must be an array/, "failure names the malformed field");
});

test("a pack with agents but no skills dir still loads", (t) => {
  const files = defaultPackFiles();
  delete files["skills/growth-content/SKILL.md"];
  delete files["pack.json"];
  const repo = makeFakeRepo(t, files);
  const { res, manifest } = runPack(t, repo, makeHome(t));
  assert.equal(res.status, 0, `packer failed: ${res.stderr}`);
  const entry = manifest.packs?.find((p) => p.name === PACK);
  assert.deepEqual(entry?.agents, ["media-auditor.md"], "agents-only pack loads");
  assert.ok(!manifest.flags.some((f) => /not found/.test(f)), "no false not-found flag");
});

// A `!isFile()` skip in the agents loop silently dropped whole subdirectories:
// the pack reported success while shipping none of those hats -- the exact
// zero-hats defect this ticket exists to close.
test("nested agent directories are staged, not silently dropped", (t) => {
  const repo = makeFakeRepo(t, defaultPackFiles({
    "agents/team/nested.md": "---\nname: team\n---\nnested hat\n",
    "pack.json": JSON.stringify({ criticalAgents: ["media-auditor", "team"] }),
  }));
  const { res, out, manifest } = runPack(t, repo, makeHome(t));
  assert.equal(res.status, 0, `packer failed: ${res.stderr}`);
  const staged = path.join(out, "staging", ".claude", "agents");
  assert.ok(fs.existsSync(path.join(staged, "team", "nested.md")), "nested hat staged");
  const entry = manifest.packs?.find((p) => p.name === PACK);
  assert.ok(entry.agents.includes("team"), "manifest records the nested agent dir");
  assert.ok(
    manifest.included.some((e) => /nested\.md$/.test(e)),
    `included lists the nested hat: ${JSON.stringify(manifest.included)}`,
  );
});

test("the packer rejects a top-level agent link instead of copying an external directory", (t) => {
  const repo = makeFakeRepo(t, defaultPackFiles({ "pack.json": "{}" }));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-mode-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, "private.md"), "outside the curated pack\n");
  const link = path.join(repo, "packs", PACK, "agents", "external-hat");
  if (!linkDirectory(t, outside, link)) return;

  const { res } = runPack(t, repo, makeHome(t));
  assert.notEqual(res.status, 0, "a curated pack link must hard-fail, never import its target");
  assert.match(res.stderr, /symbolic link|junction|symlink/i);
});

test("the packer rejects a nested link even when its target would otherwise be skipped", (t) => {
  const repo = makeFakeRepo(t, defaultPackFiles({
    "agents/team/AGENT.md": "---\nname: team\n---\n",
    "pack.json": "{}",
  }));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-mode-nested-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, "private.md"), "outside the curated pack\n");
  const link = path.join(repo, "packs", PACK, "agents", "team", "external-reference");
  if (!linkDirectory(t, outside, link)) return;

  const { res } = runPack(t, repo, makeHome(t));
  assert.notEqual(res.status, 0, "links anywhere under a curated pack must hard-fail");
  assert.match(res.stderr, /symbolic link|junction|symlink/i);
});

test("the packer rejects a linked curated-pack root", (t) => {
  const repo = makeFakeRepo(t, defaultPackFiles({ "pack.json": "{}" }));
  const packDir = path.join(repo, "packs", PACK);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-linked-pack-root-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const outsidePack = path.join(outside, PACK);
  fs.cpSync(packDir, outsidePack, { recursive: true });
  fs.rmSync(packDir, { recursive: true, force: true });
  if (!linkDirectory(t, outsidePack, packDir)) return;

  const { res } = runPack(t, repo, makeHome(t));
  assert.notEqual(res.status, 0, "packs/<name> itself may not redirect the packer outside the repository");
  assert.match(res.stderr, /symbolic link|junction|symlink/i);
});

test("a nested leaf cannot impersonate a missing critical directory hat", (t) => {
  const repo = makeFakeRepo(t, defaultPackFiles({
    "agents/other/AGENT.md": "---\nname: other\n---\n",
    "agents/other/references/team.md": "---\nname: team\n---\nunrelated nested leaf\n",
    "pack.json": JSON.stringify({ criticalAgents: ["media-auditor", "team"] }),
  }));
  const { res } = runPack(t, repo, makeHome(t));
  assert.notEqual(res.status, 0, "the critical name must match a top-level staged agent entry");
  assert.match(res.stderr, /critical agent 'team'/, "failure names the missing critical directory hat");
});

test("a critical directory hat without a surviving markdown definition hard-fails", (t) => {
  const repo = makeFakeRepo(t, defaultPackFiles({
    "agents/team/AGENT.md": "# hat\n-----BEGIN OPENSSH PRIVATE KEY-----\nopaque\n",
    "agents/team/references/guide.md": "harmless sidecar\n",
    "pack.json": JSON.stringify({ criticalAgents: ["media-auditor", "team"] }),
  }));
  const { res } = runPack(t, repo, makeHome(t));
  assert.notEqual(res.status, 0, "a sidecar cannot make a directory loadable as an agent");
  assert.match(res.stderr, /critical agent 'team'/);
});

// Landing was only ever checked on collision, so a critical hat that never
// arrived (typo, missing file, security filter) shipped a broken mode quietly.
test("a critical agent that never lands hard-fails, named", (t) => {
  const repo = makeFakeRepo(t, defaultPackFiles({
    "pack.json": JSON.stringify({ criticalAgents: ["media-auditor", "ghost-hat"] }),
  }));
  const { res } = runPack(t, repo, makeHome(t));
  assert.notEqual(res.status, 0, "a missing critical agent must fail the pack");
  assert.match(res.stderr, /ghost-hat/, "failure names the missing agent");
  assert.match(res.stderr, new RegExp(PACK), "failure names the pack");
});

// The content audit deletes a staged file that carries a credential pattern.
// Before reconciliation the manifest still claimed it shipped, and deploy
// printed "Preloaded pack ... 1 agent(s)" for a file not in the tarball.
test("an agent removed by the content audit is dropped from the manifest, not claimed", (t) => {
  const repo = makeFakeRepo(t, {
    "agents/leaky.md": "# hat\n-----BEGIN OPENSSH PRIVATE KEY-----\nopaque\n",
    "MODE.md": "# fixture\n",
    "pack.json": "{}",
  });
  const { res, out, manifest } = runPack(t, repo, makeHome(t));
  assert.equal(res.status, 0, `packer failed: ${res.stderr}`);
  assert.ok(!fs.existsSync(path.join(out, "staging", ".claude", "agents", "leaky.md")), "leaky hat omitted");
  const entry = manifest.packs?.find((p) => p.name === PACK);
  assert.deepEqual(entry.agents, [], "manifest no longer claims the omitted agent");
  assert.ok(!manifest.included.some((e) => /leaky\.md$/.test(e)), "included no longer claims it either");
  assert.ok(
    manifest.flags.some((f) => /leaky/.test(f) && /NOT in this pack/.test(f)),
    `the drop is reported: ${JSON.stringify(manifest.flags)}`,
  );
});

// Same class, but the pack declared it critical: shipping a mode without a
// gate-critical hat is a hard failure, not a flag.
test("a critical agent removed by the content audit hard-fails the pack", (t) => {
  const repo = makeFakeRepo(t, {
    "agents/media-auditor.md": "# hat\n-----BEGIN OPENSSH PRIVATE KEY-----\nopaque\n",
    "pack.json": JSON.stringify({ criticalAgents: ["media-auditor"] }),
  });
  const { res } = runPack(t, repo, makeHome(t));
  assert.notEqual(res.status, 0, "an audited-away critical agent must fail the pack");
  assert.match(res.stderr, /media-auditor/, "failure names the agent");
});

// The SAME failure, one directory deeper. A skill is a folder, and the audit
// deletes files without removing the emptied folder -- so survivorship checked
// by "does skills/<name> exist" stayed true after the skill's only SKILL.md was
// deleted. The hard-fail never fired, the manifest still named the skill, and
// the box got an empty ~/.claude/skills/growth-content/.
test("a critical skill gutted by the content audit hard-fails the pack, empty directory or not", (t) => {
  const repo = makeFakeRepo(t, {
    "skills/growth-content/SKILL.md": "# skill\n-----BEGIN OPENSSH PRIVATE KEY-----\nopaque\n",
    "pack.json": JSON.stringify({ criticalSkills: ["growth-content"] }),
  });
  const { res } = runPack(t, repo, makeHome(t));
  assert.notEqual(res.status, 0, "an audited-away critical skill must fail the pack");
  assert.match(res.stderr, /growth-content/, "failure names the skill");
});

test("a critical skill without SKILL.md still hard-fails when harmless sidecars survive", (t) => {
  const repo = makeFakeRepo(t, {
    "skills/growth-content/SKILL.md": "# skill\n-----BEGIN OPENSSH PRIVATE KEY-----\nopaque\n",
    "skills/growth-content/references/guide.md": "Safe reference material.\n",
    "pack.json": JSON.stringify({ criticalSkills: ["growth-content"] }),
  });
  const { res } = runPack(t, repo, makeHome(t));
  assert.notEqual(res.status, 0, "a sidecar cannot make a skill loadable without its SKILL.md entrypoint");
  assert.match(res.stderr, /growth-content/);
});

test("a non-critical skill gutted by the content audit is dropped from the manifest and the staging tree", (t) => {
  const repo = makeFakeRepo(t, {
    "skills/leaky-skill/SKILL.md": "# skill\n-----BEGIN OPENSSH PRIVATE KEY-----\nopaque\n",
    "MODE.md": "# fixture\n",
    "pack.json": "{}",
  });
  const { res, out, manifest } = runPack(t, repo, makeHome(t));
  assert.equal(res.status, 0, `packer failed: ${res.stderr}`);
  const entry = manifest.packs?.find((p) => p.name === PACK);
  assert.deepEqual(entry.skills, [], "manifest no longer claims the gutted skill");
  assert.ok(
    !fs.existsSync(path.join(out, "staging", ".claude", "skills", "leaky-skill")),
    "and the empty directory does not ship either -- the report and the archive agree",
  );
  assert.ok(
    manifest.flags.some((f) => /leaky-skill/.test(f) && /NOT in this pack/.test(f)),
    `the drop is reported: ${JSON.stringify(manifest.flags)}`,
  );
});

// The user's own ~/.claude/modes is NEVER staged (not in INCLUDE_DIRS, and
// --include refuses .claude as a protected agent root), so a pack's mode files
// cannot collide with anything. Pin that assumption: the day modes/ joins the
// packed set, this test fails and the mode loop needs the same "yours kept"
// collision guard skills and agents already have.
test("the user's own ~/.claude/modes is not packed, so mode files cannot collide", (t) => {
  const repo = makeFakeRepo(t, defaultPackFiles({ "pack.json": "{}" }));
  const home = makeHome(t);
  const mine = path.join(home, ".claude", "modes", "my-own-mode");
  fs.mkdirSync(mine, { recursive: true });
  fs.writeFileSync(path.join(mine, "MODE.md"), "MY OWN MODE NOTES");

  const { res, out } = runPack(t, repo, home);
  assert.equal(res.status, 0, `packer failed: ${res.stderr}`);
  const stagedModes = path.join(out, "staging", ".claude", "modes");
  assert.deepEqual(fs.readdirSync(stagedModes), [PACK], "only the pack's own mode dir is staged");
});

// Internal-only guard the public repo doesn't need: this packer re-audits the
// EXACT completed archive (archiveEntryIsUnsafe treats any parserless config,
// .toml included, as forbidden). A staged mode.toml that survives the staging
// pass but gets the archive blocked would ship no tarball at all -- so prove
// the full non-dry-run pipeline emits an archive that carries the mode files.
test("mode.toml rides the real tarball without tripping the archive audit", (t) => {
  const repo = makeFakeRepo(t, defaultPackFiles());
  const { res, out, manifest } = runPack(t, repo, makeHome(t), ["--pack", PACK], { dryRun: false });
  assert.equal(res.status, 0, `packer failed: ${res.stderr}\n${res.stdout}`);
  assert.ok(manifest.tarball, "archive was written (not security-blocked)");
  assert.ok(manifest.archiveSha256, "archive hash bound after the audit");
  const entries = execFileSync("tar", ["-tzf", "harness.tar.gz"], { cwd: out, encoding: "utf8" })
    .split(/\r?\n/).filter(Boolean).map((e) => e.replace(/^(?:\.\/)+/, ""));
  assert.ok(entries.includes(`.claude/modes/${PACK}/mode.toml`), "mode.toml is in the archive");
  assert.ok(entries.includes(`.claude/modes/${PACK}/MODE.md`), "MODE.md is in the archive");
  assert.ok(entries.includes(".claude/agents/media-auditor.md"), "agent is in the archive");
});

// ---- the CLI's side: a pack failure has to REACH the operator ---------------
// pack.mjs reports every --pack problem as a manifest flag and exits 0, and the
// CLI runs it with piped stdio surfaced only on a nonzero exit. So `agenthost
// sync --pack growht` (a typo, or an install predating packs/) printed "Packed N
// files ... Synced." and nothing else -- and the operator then got a green
// `agenthost mode growth` on a box with no hats. These pin the two reads
// src/pack.js does on that manifest before it lets the harness ship.

test("a --pack the install does not have is reported by the packer and read back by the CLI", (t) => {
  const repo = makeFakeRepo(t, defaultPackFiles());
  const { res, manifest } = runPack(t, repo, makeHome(t), ["--pack", "growht"]);
  assert.equal(res.status, 0, "the packer itself still exits 0 -- which is why the CLI has to look");
  assert.deepEqual(manifest.packs, [], "nothing was packed under that name");
  const problems = packFlags(manifest);
  assert.ok(problems.some((f) => /growht/.test(f) && /not found/.test(f)), `the flag is there to print: ${JSON.stringify(manifest.flags)}`);
  assert.deepEqual(missingPacks(["growht"], manifest), ["growht"], "so the CLI fails the sync instead of reporting success");
});

test("a --pack name the packer refuses is surfaced the same way", (t) => {
  const repo = makeFakeRepo(t, defaultPackFiles());
  const { manifest } = runPack(t, repo, makeHome(t), ["--pack", "Growth Mode"]);
  assert.ok(packFlags(manifest).some((f) => /invalid pack name/.test(f)), JSON.stringify(manifest.flags));
  assert.deepEqual(missingPacks(["Growth Mode"], manifest), ["Growth Mode"]);
});

test("a pack that DID ship is not reported missing, and content-audit drops are printed", (t) => {
  const repo = makeFakeRepo(t, {
    "agents/leaky.md": "# hat\n-----BEGIN OPENSSH PRIVATE KEY-----\nopaque\n",
    "MODE.md": "# fixture\n",
    "pack.json": "{}",
  });
  const { manifest } = runPack(t, repo, makeHome(t));
  assert.deepEqual(missingPacks([PACK], manifest), [], "the pack shipped, so the sync proceeds");
  assert.ok(
    packFlags(manifest).some((f) => /leaky/.test(f) && /NOT in this pack/.test(f)),
    "but the operator is told what the audit took out of it",
  );
});

test("the flag filter ignores everything that is not about a pack", () => {
  const manifest = { flags: ["Hermes config.yaml not migrated", "PowerShell script (won't run on Linux): x.ps1"] };
  assert.deepEqual(packFlags(manifest), []);
  assert.deepEqual(packFlags({}), [], "a manifest with no flags is not a crash");
  assert.deepEqual(missingPacks([], {}), []);
});

test("sync/deploy preflight refuses an invalid mode pack before it can replace an active one", (t) => {
  const repo = makeFakeRepo(t, defaultPackFiles({
    "pack.json": JSON.stringify({ schema_version: 2, criticalSkills: [], criticalAgents: ["media-auditor"] }),
    "channel-taxonomy.json": JSON.stringify({ agents: [{ agent_id: "paid_search" }] }),
    "coverage.json": JSON.stringify({ paid_search: "media-auditor" }),
  }));
  assert.throws(
    () => validateRequestedModePacks([PACK], { repoRoot: repo, harnessDir: path.join(makeHome(t), ".claude") }),
    /schema_version 2.*supported major 1/s,
  );
});

test("a mode pack hard-fails when the audit removes a coverage-owned non-critical hat", (t) => {
  const repo = makeFakeRepo(t, {
    "agents/leaky.md": "# hat\n-----BEGIN OPENSSH PRIVATE KEY-----\nopaque\n",
    "MODE.md": "# fixture\n",
    "mode.toml": 'name = "fixture"\n',
    "coverage.json": JSON.stringify({ agent_fixture_001: "leaky" }),
    "pack.json": "{}",
  });
  const { res } = runPack(t, repo, makeHome(t));
  assert.notEqual(res.status, 0, "a mode pack may not survive with one of its authored hats audited away");
  assert.match(res.stderr, /agent 'leaky'.*content audit|content audit.*agent 'leaky'/s);
});

test("a mode pack hard-fails when the audit removes mandatory MODE.md", (t) => {
  const repo = makeFakeRepo(t, {
    "agents/media-auditor.md": "---\nname: media-auditor\n---\n",
    "MODE.md": "# fixture\n-----BEGIN OPENSSH PRIVATE KEY-----\nopaque\n",
    "mode.toml": 'name = "fixture"\n',
    "coverage.json": JSON.stringify({ agent_fixture_001: "media-auditor" }),
    "pack.json": "{}",
  });
  const { res } = runPack(t, repo, makeHome(t));
  assert.notEqual(res.status, 0, "a mode pack may not survive with MODE.md audited away");
  assert.match(res.stderr, /MODE\.md.*content audit|content audit.*MODE\.md/s);
});

test("sync/deploy preflight leaves ordinary skills-only packs on their existing path", (t) => {
  const repo = makeFakeRepo(t, { "skills/plain/SKILL.md": "---\nname: plain\n---\n" });
  assert.doesNotThrow(
    () => validateRequestedModePacks([PACK], { repoRoot: repo, harnessDir: path.join(makeHome(t), ".claude") }),
  );
});
