// --pack legal: the packer preloads the repo's curated legal skills into the
// staged harness, without clobbering a user's same-named skill, and every skill
// carries its disclaimer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACK_MJS = path.join(REPO_ROOT, "scripts", "pack.mjs");
const PACK_DIR = path.join(REPO_ROOT, "packs", "legal", "skills");

function runPack(home, extra) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-pack-out-"));
  const res = spawnSync(process.execPath, [PACK_MJS, "--out", out, "--dry-run", ...extra], {
    encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  return { res, out, manifest: JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8")) };
}

test("the three core v0 skills exist", () => {
  const skills = fs.readdirSync(PACK_DIR);
  for (const s of ["contract-drafting-engine", "contract-review-redline", "uspto-trademark-filing"]) {
    assert.ok(skills.includes(s), `missing core pack skill ${s}`);
  }
});

test("EVERY legal pack skill carries frontmatter + the UPL-safe disclaimer", () => {
  // Count-agnostic: covers any skill added to the pack (by hand or by an agent).
  const skills = fs.readdirSync(PACK_DIR, { withFileTypes: true }).filter((e) => e.isDirectory());
  assert.ok(skills.length >= 3, "expected at least the 3 v0 skills");
  for (const e of skills) {
    const p = path.join(PACK_DIR, e.name, "SKILL.md");
    assert.ok(fs.existsSync(p), `${e.name} missing SKILL.md`);
    const md = fs.readFileSync(p, "utf8");
    const flat = md.replace(/\s+/g, " "); // disclaimers are hard-wrapped
    assert.match(md, /^---\nname:/, `${e.name} missing SKILL.md frontmatter`);
    assert.match(md, /^description:/m, `${e.name} missing frontmatter description`);
    assert.match(md, /## Disclaimer/, `${e.name} missing disclaimer`);
    assert.match(flat, /not a substitute for the judgment of a licensed attorney/, `${e.name} missing UPL-safe disclaimer language`);
    assert.match(flat, /draft for attorney review/i, `${e.name} missing the "draft for attorney review" posture`);
  }
});

test("--pack legal preloads the skills into the staged harness", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-legal-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ model: "claude-fable-5" }));

  const { manifest, out } = runPack(home, ["--pack", "legal"]);
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));

  const staged = path.join(out, "staging", ".claude", "skills");
  assert.ok(fs.existsSync(path.join(staged, "contract-drafting-engine", "SKILL.md")), "drafting skill staged");
  assert.ok(fs.existsSync(path.join(staged, "uspto-trademark-filing", "SKILL.md")), "trademark skill staged");
  const onDisk = fs.readdirSync(PACK_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
  assert.ok(manifest.packs?.some((p) => p.name === "legal" && p.skills.length === onDisk), "manifest records all legal pack skills");
});

test("--pack legal never clobbers a user's own same-named skill", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-legal-home2-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const mine = path.join(home, ".claude", "skills", "contract-review-redline");
  fs.mkdirSync(mine, { recursive: true });
  fs.writeFileSync(path.join(mine, "SKILL.md"), "MINE — do not overwrite");
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{}");

  const { manifest, out } = runPack(home, ["--pack", "legal"]);
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));

  const staged = path.join(out, "staging", ".claude", "skills", "contract-review-redline", "SKILL.md");
  assert.equal(fs.readFileSync(staged, "utf8"), "MINE — do not overwrite", "user skill preserved");
  assert.ok(manifest.flags.some((f) => /already exists in your harness/.test(f)), "collision reported");
});

test("--pack with an unknown name is flagged, not fatal", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-legal-home3-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{}");

  const { res, manifest, out } = runPack(home, ["--pack", "nope-not-real"]);
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  assert.equal(res.status, 0, "unknown pack does not crash the packer");
  assert.ok(manifest.flags.some((f) => /not found/.test(f)), "unknown pack reported");
});
