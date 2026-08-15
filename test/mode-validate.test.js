// Unit tests for container/mode-validate.js -- the mode-pack validator (ARD
// Wave 0, T0.3, hole H3). The pack contract is written in docs/pack-contract.md;
// this file is the executable half of it. EVERY rule (a-h) gets a GREEN fixture
// that must pass and a RED fixture that must fail with the rule named, because
// a validator that only ever sees good packs is a validator nobody has tested.
// The container subtree is CommonJS while test/ inherits the root's ESM type,
// hence createRequire instead of a bare import.
// Run: node --test test/mode-validate.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const modeValidate = require("../container/mode-validate.js");

const tmp = fs.mkdtempSync(path.join(import.meta.dirname, ".modevalidate-"));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let seq = 0;
// Writes a pack from a {relative path -> contents} map. Object values are
// JSON-stringified; a null value means "leave this file out" (the red fixtures
// for the missing-file rules).
function writePack(files) {
  const dir = path.join(tmp, `pack-${++seq}`);
  for (const [rel, body] of Object.entries(files)) {
    if (body === null) continue;
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body, null, 2));
  }
  return dir;
}

// A three-channel taxonomy: coverage is checked against whatever taxonomy file
// the caller passes, which is exactly why the real 28-channel file is an
// ARGUMENT and not a hardcoded path (the box has no GTMVP repo on it).
const TAXONOMY = { agents: [{ agent_id: "agent_a_1" }, { agent_id: "agent_b_2" }, { agent_id: "agent_c_3" }] };
const taxonomyFile = path.join(tmp, "taxonomy.json");
fs.writeFileSync(taxonomyFile, JSON.stringify(TAXONOMY));

const GOOD_TOML = `# the growth mode's on-box config
name = "growth"
schema_version = "1"

[charter]
addendum = """
The marketing department is on duty.
"""
`;

const GOOD_HAT = `---
name: media-auditor
description: Reviews channel spend.
tools: Read, Write, Grep
---

A hat.
`;

// The baseline every rule's GREEN fixture starts from. Overrides replace a file
// (or drop it with null) so each red test differs from a passing pack in exactly
// one way -- which is what makes a failure attributable to the rule under test.
function goodPack(overrides = {}) {
  return writePack({
    "pack.json": { schema_version: 1, criticalSkills: [], criticalAgents: ["media-auditor"] },
    "mode.toml": GOOD_TOML,
    "MODE.md": "# growth\n\nThe marketing department.\n",
    "agents/media-auditor.md": GOOD_HAT,
    "coverage.json": { agent_a_1: "media-auditor", agent_b_2: "media-auditor", agent_c_3: "media-auditor" },
    ...overrides,
  });
}

const TEST_CHANNEL_IDS = TAXONOMY.agents.map((agent) => agent.agent_id);
const check = (dir, opts = {}) => modeValidate.validatePack(dir, {
  taxonomyFile,
  expectedChannelCount: TEST_CHANNEL_IDS.length,
  expectedChannelIds: TEST_CHANNEL_IDS,
  ...opts,
});
// Every failure names its rule so an operator can look it up in the contract.
const failed = (res, rule) => res.errors.some((e) => e.includes(`rule ${rule}`));
const why = (res) => res.errors.join("\n");

// ---- the baseline itself ----------------------------------------------------

test("a well-formed pack passes every rule", () => {
  const res = check(goodPack());
  assert.equal(res.ok, true, why(res));
  assert.deepEqual(res.errors, []);
});

// ---- rule a: pack.json parses, critical fields are arrays -------------------

test("(a) GREEN: pack.json with array critical fields is accepted", () => {
  const res = check(goodPack({ "pack.json": { schema_version: 1, criticalAgents: ["media-auditor"] } }));
  assert.equal(res.ok, true, why(res));
});

test("(a) RED: pack.json that does not parse is fatal", () => {
  const res = check(goodPack({ "pack.json": "{ schema_version: 1," }));
  assert.equal(res.ok, false);
  assert.ok(failed(res, "a"), why(res));
  assert.match(why(res), /pack\.json/);
});

test("(a) RED: a critical field that is a bare string is fatal, not silently a set of letters", () => {
  const res = check(goodPack({ "pack.json": { schema_version: 1, criticalAgents: "media-auditor" } }));
  assert.equal(res.ok, false);
  assert.ok(failed(res, "a"), why(res));
  assert.match(why(res), /criticalAgents/);
});

test("(a) RED: critical names cannot escape their skills or agents directory", () => {
  const res = check(goodPack({
    "pack.json": { schema_version: 1, criticalSkills: ["../outside"], criticalAgents: ["media-auditor"] },
  }));
  assert.equal(res.ok, false);
  assert.ok(failed(res, "a"), why(res));
  assert.match(why(res), /criticalSkills[\s\S]*\.\.\/outside/);
});

test("(a) RED: a mode pack cannot hide shipped content behind a symlink or junction", (t) => {
  const pack = goodPack({
    "agents/media-auditor.md": null,
    "agents/media-auditor/AGENT.md": "---\nname: media-auditor\n---\n",
    "linked-payload/fat.md": toolsHat(16),
  });
  const link = path.join(pack, "agents", "media-auditor", "linked");
  try {
    fs.symlinkSync(path.join(pack, "linked-payload"), link, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
      t.skip(`this machine cannot create a test link: ${error.code}`);
      return;
    }
    throw error;
  }
  const res = check(pack);
  assert.equal(res.ok, false, "the validator must inspect or reject every entry the packer can stage");
  assert.ok(failed(res, "a"), why(res));
  assert.match(why(res), /symbolic link|junction|symlink/i);
});

test("(a) RED: the mode-pack root itself cannot be a symlink or junction", (t) => {
  const target = goodPack();
  const linkedPack = path.join(tmp, `linked-pack-${++seq}`);
  try {
    fs.symlinkSync(target, linkedPack, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
      t.skip(`this machine cannot create a test directory link: ${error.code}`);
      return;
    }
    throw error;
  }
  const res = check(linkedPack);
  assert.equal(res.ok, false, "a linked pack root can point outside the curated repository tree");
  assert.ok(failed(res, "a"), why(res));
  assert.match(why(res), /symbolic link|junction|symlink/i);
});

test("(a) RED: a missing pack.json is fatal -- the pack declares its contract there", () => {
  const res = check(goodPack({ "pack.json": null }));
  assert.equal(res.ok, false);
  assert.ok(failed(res, "a"), why(res));
});

// ---- rule b: mode.toml exists and matches the documented subset -------------

test("(b) GREEN: comments, sections, quoted keys and a triple-quoted block all parse", () => {
  const res = check(goodPack());
  assert.equal(res.ok, true, why(res));
});

test("(b) RED: a missing mode.toml is fatal", () => {
  const res = check(goodPack({ "mode.toml": null }));
  assert.equal(res.ok, false);
  assert.ok(failed(res, "b"), why(res));
});

test("(b) RED: a missing MODE.md is fatal before a pack can be synced", () => {
  const res = check(goodPack({ "MODE.md": null }));
  assert.equal(res.ok, false);
  assert.ok(failed(res, "b"), why(res));
  assert.match(why(res), /MODE\.md/);
});

test("(b) RED: a line outside the subset is fatal and names the line number", () => {
  // Arrays are real TOML but NOT in the subset the box can read -- the gate
  // extracts one key with a regex, so anything richer is a promise nothing keeps.
  const res = check(goodPack({ "mode.toml": `name = "growth"\nchannels = ["seo", "ads"]\n` }));
  assert.equal(res.ok, false);
  assert.ok(failed(res, "b"), why(res));
  assert.match(why(res), /line 2/);
});

test("(b) GREEN: the contract's own documented example parses", () => {
  // docs/pack-contract.md §4 prints this verbatim as "what a mode.toml looks
  // like". An operator who copies the documented example and gets a REFUSED
  // switch is being told the contract lies about itself -- so the example is a
  // fixture here, trailing comments and all.
  const doc = fs.readFileSync(path.join(import.meta.dirname, "..", "docs", "pack-contract.md"), "utf8");
  const example = /```toml\r?\n([\s\S]*?)```/.exec(doc);
  assert.ok(example, "docs/pack-contract.md no longer prints a ```toml example");
  const res = check(goodPack({ "mode.toml": example[1] }));
  assert.equal(res.ok, true, why(res));
});

test("(b) GREEN: a trailing # comment on a key or a section is ordinary TOML", () => {
  const res = check(goodPack({ "mode.toml": `name = "growth"  # the mode\nschema_version = 1 # major\n\n[charter] # the only section\n` }));
  assert.equal(res.ok, true, why(res));
});

test("(b) GREEN: a # inside a quoted value stays part of the value", () => {
  const res = check(goodPack({ "mode.toml": `name = "growth #1"\n` }));
  assert.equal(res.ok, true, why(res));
});

test("(b) RED: an unterminated triple-quoted block is fatal", () => {
  const res = check(goodPack({ "mode.toml": `name = "growth"\naddendum = """\nnever closed\n` }));
  assert.equal(res.ok, false);
  assert.ok(failed(res, "b"), why(res));
  assert.match(why(res), /addendum/);
});

// ---- rule c: schema_version is an integer and matches the supported major ---

test("(c) GREEN: schema_version 1 is the supported major", () => {
  assert.equal(modeValidate.SUPPORTED_SCHEMA_MAJOR, 1);
  const res = check(goodPack());
  assert.equal(res.ok, true, why(res));
});

test("(c) RED: a future schema_version is fatal and names BOTH versions", () => {
  const res = check(goodPack({ "pack.json": { schema_version: 2, criticalAgents: [] } }));
  assert.equal(res.ok, false);
  assert.ok(failed(res, "c"), why(res));
  assert.match(why(res), /2/);
  assert.match(why(res), /1/);
});

test("(c) RED: a non-integer schema_version is fatal", () => {
  const res = check(goodPack({ "pack.json": { schema_version: "1", criticalAgents: [] } }));
  assert.equal(res.ok, false);
  assert.ok(failed(res, "c"), why(res));
});

// ---- rule d: no [gates] section (the ARD's hardest line) -------------------

test("(d) GREEN: ordinary sections are fine", () => {
  const res = check(goodPack({ "mode.toml": `name = "growth"\n\n[charter]\naddendum = """\nhello\n"""\n` }));
  assert.equal(res.ok, true, why(res));
});

test("(d) RED: a [gates] section is fatal -- consequence gates live outside every mode", () => {
  const res = check(goodPack({ "mode.toml": `name = "growth"\n\n[gates]\nspend = "auto"\n` }));
  assert.equal(res.ok, false);
  assert.ok(failed(res, "d"), why(res));
  assert.match(why(res), /gates/);
});

test("(d) RED: a [gates.spend] subsection is fatal too", () => {
  const res = check(goodPack({ "mode.toml": `name = "growth"\n\n[gates.spend]\nceiling = "none"\n` }));
  assert.equal(res.ok, false);
  assert.ok(failed(res, "d"), why(res));
  assert.match(why(res), /gates\.spend/);
});

// ---- rule e: <= 15 tools per hat -------------------------------------------

const toolsHat = (n) => `---\nname: media-auditor\ndescription: x\ntools: ${Array.from({ length: n }, (_, i) => `Tool${i + 1}`).join(", ")}\n---\n\nbody\n`;

test("(e) GREEN: exactly 15 tools is allowed", () => {
  const res = check(goodPack({ "agents/media-auditor.md": toolsHat(15) }));
  assert.equal(res.ok, true, why(res));
});

test("(e) GREEN: a hat with no tools list inherits and is not counted", () => {
  const res = check(goodPack({ "agents/media-auditor.md": `---\nname: media-auditor\ndescription: x\n---\n\nbody\n` }));
  assert.equal(res.ok, true, why(res));
});

test("(e) RED: 16 tools is fatal and names the hat and the count", () => {
  const res = check(goodPack({ "agents/media-auditor.md": toolsHat(16) }));
  assert.equal(res.ok, false);
  assert.ok(failed(res, "e"), why(res));
  assert.match(why(res), /media-auditor/);
  assert.match(why(res), /16/);
});

// The ceiling has to survive the ways a hat can legitimately be WRITTEN. A guard
// that silently reads zero tools off an unfamiliar-but-valid form is worse than
// no guard at all: it ships an unbounded hat and reports the contract satisfied.

// The YAML block sequence -- the other standard way to write a frontmatter list.
const blockToolsHat = (n) => `---\nname: media-auditor\ndescription: x\ntools:\n${Array.from({ length: n }, (_, i) => `  - Tool${i + 1}`).join("\n")}\n---\n\nbody\n`;

test("(e) RED: 40 tools written as a YAML block list is counted, not read as zero", () => {
  const res = check(goodPack({ "agents/media-auditor.md": blockToolsHat(40) }));
  assert.equal(res.ok, false, "a block-list tool belt used to pass green");
  assert.ok(failed(res, "e"), why(res));
  assert.match(why(res), /40/);
});

test("(e) GREEN: a short block list is still under the ceiling", () => {
  const res = check(goodPack({ "agents/media-auditor.md": blockToolsHat(3) }));
  assert.equal(res.ok, true, why(res));
});

test("(e) RED: frontmatter behind a UTF-8 BOM is still read (routine on Windows)", () => {
  const res = check(goodPack({ "agents/media-auditor.md": `﻿${toolsHat(40)}` }));
  assert.equal(res.ok, false, "a BOM used to hide the entire frontmatter");
  assert.ok(failed(res, "e"), why(res));
});

test("(e) RED: frontmatter behind a leading blank line is still read", () => {
  const res = check(goodPack({ "agents/media-auditor.md": `\n${toolsHat(40)}` }));
  assert.equal(res.ok, false, "a leading blank line used to hide the entire frontmatter");
  assert.ok(failed(res, "e"), why(res));
});

// ...and the ways a hat can legitimately be LAID OUT. The packer stages a nested
// agent directory as a hat, so the ceiling has to read inside one: registering
// the directory and then skipping every .md in it shipped an unbounded tool belt
// through a green switch.
test("(e) RED: 40 tools inside a nested hat directory is counted, not skipped", () => {
  const res = check(goodPack({
    "agents/media-auditor.md": null,
    "agents/media-auditor/media-auditor.md": toolsHat(40),
  }));
  assert.equal(res.ok, false, "a directory hat used to be registered and then never read");
  assert.ok(failed(res, "e"), why(res));
  assert.match(why(res), /media-auditor/);
  assert.match(why(res), /40/);
});

test("(e) GREEN: a nested hat directory under the ceiling still passes", () => {
  const res = check(goodPack({
    "agents/media-auditor.md": null,
    "agents/media-auditor/media-auditor.md": toolsHat(15),
    "agents/media-auditor/NOTES.txt": "not a hat definition\n",
  }));
  assert.equal(res.ok, true, why(res));
});

test("(e) RED: the ceiling reaches markdown inside deeper nested hat folders", () => {
  const res = check(goodPack({
    "agents/media-auditor.md": null,
    "agents/media-auditor/AGENT.md": "---\nname: media-auditor\n---\n",
    "agents/media-auditor/team/reviewer.md": toolsHat(40),
  }));
  assert.equal(res.ok, false, "the packer recursively stages this file, so the validator must recursively read it");
  assert.ok(failed(res, "e"), why(res));
  assert.match(why(res), /reviewer\.md/);
});

test("(e) RED: one directory hat cannot split more than 15 tools across files", () => {
  const res = check(goodPack({
    "agents/media-auditor.md": null,
    "agents/media-auditor/AGENT.md": toolsHat(8),
    "agents/media-auditor/b.md": `---\nname: media-auditor-b\ntools: ${Array.from({ length: 8 }, (_, i) => `Other${i + 1}`).join(", ")}\n---\n`,
  }));
  assert.equal(res.ok, false, "the limit belongs to the top-level directory hat, not each leaf file");
  assert.ok(failed(res, "e"), why(res));
  assert.match(why(res), /16/);
});

test("(e) RED: deeply nested markdown cannot escape the tool ceiling", () => {
  const deep = `agents/media-auditor/${Array.from({ length: 10 }, (_, i) => `level-${i + 1}`).join("/")}/deep.md`;
  const res = check(goodPack({
    "agents/media-auditor.md": null,
    "agents/media-auditor/AGENT.md": "---\nname: media-auditor\n---\n",
    [deep]: toolsHat(16),
  }));
  assert.equal(res.ok, false, "the packer stages this depth, so the validator must inspect it");
  assert.ok(failed(res, "e"), why(res));
});

// ---- rule f: coverage.json owns every taxonomy channel ---------------------

test("(f) GREEN: every taxonomy channel maps to a hat that exists in the pack", () => {
  const res = check(goodPack());
  assert.equal(res.ok, true, why(res));
});

test("(f) RED: an unowned channel is fatal and names the channel", () => {
  const res = check(goodPack({ "coverage.json": { agent_a_1: "media-auditor", agent_b_2: "media-auditor" } }));
  assert.equal(res.ok, false);
  assert.ok(failed(res, "f"), why(res));
  assert.match(why(res), /agent_c_3/);
});

test("(f) RED: a channel the taxonomy does not have is fatal and names it", () => {
  const res = check(goodPack({
    "coverage.json": { agent_a_1: "media-auditor", agent_b_2: "media-auditor", agent_c_3: "media-auditor", agent_ghost_9: "media-auditor" },
  }));
  assert.equal(res.ok, false);
  assert.ok(failed(res, "f"), why(res));
  assert.match(why(res), /agent_ghost_9/);
});

test("(f) RED: a hat that ships no agents/<hat>.md is a phantom agent and is fatal", () => {
  const res = check(goodPack({
    "coverage.json": { agent_a_1: "media-auditor", agent_b_2: "channel-scorer", agent_c_3: "media-auditor" },
  }));
  assert.equal(res.ok, false);
  assert.ok(failed(res, "f"), why(res));
  assert.match(why(res), /channel-scorer/);
});

test("(f) GREEN: a hat staged as a nested agents/<hat>/ directory is a real hat", () => {
  // scripts/pack.mjs deliberately stages nested agent directories (a `!isFile()`
  // skip there was the zero-hats bug the pack pipeline exists to prevent). If
  // the validator disagreed about what a hat IS, a pack the packer ships
  // correctly would be refused at switch time as a phantom agent.
  const res = check(goodPack({
    "agents/media-auditor.md": null,
    "agents/media-auditor/AGENT.md": "---\nname: media-auditor\n---\n\nA hat that lives in a directory.\n",
  }));
  assert.equal(res.ok, true, why(res));
});

test("(f) RED: a directory with sidecars but no markdown definition is not a hat", () => {
  const res = check(goodPack({
    "agents/media-auditor.md": null,
    "agents/media-auditor/NOTES.txt": "reference only\n",
  }));
  assert.equal(res.ok, false);
  assert.ok(failed(res, "f"), why(res));
  assert.match(why(res), /media-auditor/);
});

test("(f) RED: a pack cannot shrink its own taxonomy below the required 28 channels", () => {
  const res = modeValidate.validatePack(goodPack({
    "channel-taxonomy.json": { agents: [{ agent_id: "agent_a_1" }] },
    "coverage.json": { agent_a_1: "media-auditor" },
  }));
  assert.equal(res.ok, false);
  assert.ok(failed(res, "f"), why(res));
  assert.match(why(res), /28/);
});

test("(f) RED: duplicate taxonomy ids cannot masquerade as complete coverage", () => {
  const duplicateTaxonomy = path.join(tmp, `taxonomy-duplicate-${++seq}.json`);
  fs.writeFileSync(duplicateTaxonomy, JSON.stringify({ agents: [
    { agent_id: "agent_a_1" }, { agent_id: "agent_a_1" }, { agent_id: "agent_c_3" },
  ] }));
  const res = modeValidate.validatePack(goodPack(), {
    taxonomyFile: duplicateTaxonomy,
    expectedChannelCount: TEST_CHANNEL_IDS.length,
    expectedChannelIds: TEST_CHANNEL_IDS,
  });
  assert.equal(res.ok, false);
  assert.ok(failed(res, "f"), why(res));
  assert.match(why(res), /duplicate.*agent_a_1/i);
});

test("(f) RED: the right count with one substituted channel is not canonical coverage", () => {
  const substituted = path.join(tmp, `taxonomy-substituted-${++seq}.json`);
  fs.writeFileSync(substituted, JSON.stringify({ agents: [
    { agent_id: "agent_a_1" }, { agent_id: "agent_b_2" }, { agent_id: "agent_rogue_9" },
  ] }));
  const res = modeValidate.validatePack(goodPack({
    "coverage.json": { agent_a_1: "media-auditor", agent_b_2: "media-auditor", agent_rogue_9: "media-auditor" },
  }), {
    taxonomyFile: substituted,
    expectedChannelCount: 3,
    expectedChannelIds: TAXONOMY.agents.map((agent) => agent.agent_id),
  });
  assert.equal(res.ok, false, "28 unique IDs is insufficient when they are not the canonical 28 IDs");
  assert.ok(failed(res, "f"), why(res));
  assert.match(why(res), /agent_c_3/);
  assert.match(why(res), /agent_rogue_9/);
});

test("(f) RED: a missing coverage.json is fatal", () => {
  const res = check(goodPack({ "coverage.json": null }));
  assert.equal(res.ok, false);
  assert.ok(failed(res, "f"), why(res));
});

test("(f) RED: an unreadable taxonomy is fatal -- coverage cannot be proven", () => {
  const res = modeValidate.validatePack(goodPack(), { taxonomyFile: path.join(tmp, "no-such-taxonomy.json") });
  assert.equal(res.ok, false);
  assert.ok(failed(res, "f"), why(res));
});

// ---- rule g: banned public-copy words --------------------------------------

test("(g) GREEN: copy that stays on the public vocabulary passes", () => {
  const res = check(goodPack({ "MODE.md": "# growth\n\n3D Attribution, in public words.\n" }));
  assert.equal(res.ok, true, why(res));
});

test("(g) RED: a banned word in any pack text file is fatal and names file AND word", () => {
  const res = check(goodPack({ "MODE.md": "# growth\n\nBacked by hyperbolic memory.\n" }));
  assert.equal(res.ok, false);
  assert.ok(failed(res, "g"), why(res));
  assert.match(why(res), /MODE\.md/);
  assert.match(why(res), /hyperbolic/i);
});

test("(g) RED: the scan is case-insensitive and reaches nested files", () => {
  const res = check(goodPack({ "agents/media-auditor.md": GOOD_HAT.replace("A hat.", "A Poincaré hat.") }));
  assert.equal(res.ok, false);
  assert.ok(failed(res, "g"), why(res));
  assert.match(why(res), /media-auditor\.md/);
});

// ---- rule h: critical content must not collide with the operator's harness --

function harness(files) {
  const dir = path.join(tmp, `harness-${++seq}`);
  for (const rel of files) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "x");
  }
  return dir;
}

test("(h) GREEN: a harness with unrelated content is no collision", () => {
  const res = check(goodPack(), { harnessDir: harness(["skills/some-other-skill/SKILL.md", "agents/reviewer.md"]) });
  assert.equal(res.ok, true, why(res));
});

test("(h) RED: a critical agent the operator already has is fatal (the H3 failure)", () => {
  const res = check(goodPack(), { harnessDir: harness(["agents/media-auditor.md"]) });
  assert.equal(res.ok, false);
  assert.ok(failed(res, "h"), why(res));
  assert.match(why(res), /media-auditor/);
});

test("(h) RED: a critical skill the operator already has is fatal (Steve's content-engine)", () => {
  const pack = goodPack({ "pack.json": { schema_version: 1, criticalSkills: ["growth-content"], criticalAgents: [] } });
  const res = check(pack, { harnessDir: harness(["skills/growth-content/SKILL.md"]) });
  assert.equal(res.ok, false);
  assert.ok(failed(res, "h"), why(res));
  assert.match(why(res), /growth-content/);
});

test("(h) with no harness dir the collision rule is simply not run", () => {
  const res = check(goodPack());
  assert.equal(res.ok, true, why(res));
});

// ---- the deployed subset + the boot decision -------------------------------
// On the box only MODE.md and mode.toml land (at ~/.claude/modes/<name>/), so
// boot re-checks the rules that layout can carry: b, d and g.

function modesRoot(files) {
  const dir = path.join(tmp, `modes-${++seq}`);
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  return dir;
}

test("validateModeDir accepts a deployed mode dir that carries only MODE.md + mode.toml", () => {
  const root = modesRoot({ "growth/mode.toml": GOOD_TOML, "growth/MODE.md": "# growth\n" });
  const res = modeValidate.validateModeDir(path.join(root, "growth"));
  assert.equal(res.ok, true, why(res));
});

test("validateModeDir rejects a deployed mode dir missing MODE.md", () => {
  const root = modesRoot({ "growth/mode.toml": GOOD_TOML });
  const res = modeValidate.validateModeDir(path.join(root, "growth"));
  assert.equal(res.ok, false);
  assert.ok(failed(res, "b"), why(res));
  assert.match(why(res), /MODE\.md/);
});

test("validateModeDir rejects a linked MODE.md path instead of following it", (t) => {
  const root = modesRoot({ "growth/mode.toml": GOOD_TOML, "outside-mode/charter.md": "# hyperbolic\n" });
  try {
    fs.symlinkSync(
      path.join(root, "outside-mode"),
      path.join(root, "growth", "MODE.md"),
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
      t.skip(`this machine cannot create a test directory link: ${error.code}`);
      return;
    }
    throw error;
  }
  const res = modeValidate.validateModeDir(path.join(root, "growth"));
  assert.equal(res.ok, false);
  assert.match(why(res), /symbolic link|junction|symlink/i);
});

test("bootMode: default mode never touches the disk and never falls back", () => {
  assert.deepEqual(modeValidate.bootMode("default", path.join(tmp, "nope")), { mode: "default", errors: [] });
});

test("bootMode: a mode with no deployed pack fails closed to default", () => {
  const res = modeValidate.bootMode("growth", modesRoot({ "other/mode.toml": GOOD_TOML }));
  assert.equal(res.mode, "default");
  assert.match(res.errors.join("\n"), /growth[\s\S]*(missing|unreadable)/i);
});

test("bootMode: a valid deployed mode dir boots that mode", () => {
  const res = modeValidate.bootMode("growth", modesRoot({ "growth/mode.toml": GOOD_TOML, "growth/MODE.md": "# growth\n" }));
  assert.equal(res.mode, "growth");
  assert.deepEqual(res.errors, []);
});

test("bootMode: a deployed mode missing MODE.md fails closed to default", () => {
  const res = modeValidate.bootMode("growth", modesRoot({ "growth/mode.toml": GOOD_TOML }));
  assert.equal(res.mode, "default");
  assert.match(res.errors.join("\n"), /MODE\.md/);
});

test("bootMode: a linked deployed mode directory fails closed to default", (t) => {
  const root = modesRoot({ "outside/mode.toml": GOOD_TOML, "outside/MODE.md": "# growth\n" });
  try {
    fs.symlinkSync(path.join(root, "outside"), path.join(root, "growth"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
      t.skip(`this machine cannot create a test directory link: ${error.code}`);
      return;
    }
    throw error;
  }
  const res = modeValidate.bootMode("growth", root);
  assert.equal(res.mode, "default");
  assert.match(res.errors.join("\n"), /symbolic link|junction|symlink/i);
});

test("bootMode: a deployed mode smuggling [gates] boots DEFAULT and says why", () => {
  const res = modeValidate.bootMode("growth", modesRoot({ "growth/mode.toml": `name = "growth"\n[gates]\nspend = "auto"\n` }));
  assert.equal(res.mode, "default", "a pack that re-declares the consequence gates must not run");
  assert.ok(res.errors.length);
  assert.ok(failed(res, "d"), why(res));
});

test("bootMode: banned copy in a deployed MODE.md boots DEFAULT", () => {
  const res = modeValidate.bootMode("growth", modesRoot({
    "growth/mode.toml": GOOD_TOML, "growth/MODE.md": "# growth\n\nhyperbolic memory\n",
  }));
  assert.equal(res.mode, "default");
  assert.ok(failed(res, "g"), why(res));
});

test("bootMode never throws and never honors an unverified mode, whatever the modes root is", () => {
  for (const root of [null, undefined, "", 42, path.join(tmp, "taxonomy.json")]) {
    const res = modeValidate.bootMode("growth", root);
    assert.equal(res.mode, "default");
    assert.ok(res.errors.length);
  }
});

// ---- the shipped growth pack ------------------------------------------------
// The stub Wave 1 fills in has to be green against the REAL 28-channel taxonomy,
// or `agenthost mode growth` refuses to switch (that is the wiring, not a drill).

test("the shipped packs/growth stub passes the validator green, all 28 channels owned", () => {
  const packDir = path.join(import.meta.dirname, "..", "packs", "growth");
  const res = modeValidate.validatePack(packDir);
  assert.equal(res.ok, true, why(res));
  const coverage = JSON.parse(fs.readFileSync(path.join(packDir, "coverage.json"), "utf8"));
  assert.equal(Object.keys(coverage).length, 28);
});
