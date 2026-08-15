// mode-validate.js -- the mode-pack validator (ARD Wave 0, T0.3, hole H3).
// The written contract it enforces is docs/pack-contract.md; this file is the
// executable half. Rules are lettered a-h there and every error message ends
// with its letter, so an operator who sees a failure can look up WHY the rule
// exists instead of guessing.
//
// Two entry points, because a pack has two shapes:
//   validatePack(packDir)    -- the SOURCE pack (packs/<name>/), everything the
//                               contract can check: a-h. Run by `agenthost mode
//                               <name>` BEFORE the switch, so a bad pack never
//                               reaches the box at all.
//   validateModeDir(modeDir) -- the DEPLOYED mode dir (~/.claude/modes/<name>/),
//                               which only carries MODE.md + mode.toml. Rules a,
//                               b, d and g are the ones that layout can carry; the
//                               rest were already proven at switch time.
//   bootMode(mode, root)     -- the gate's boot decision on top of that: a mode
//                               whose deployed dir fails validation boots
//                               DEFAULT instead. It never throws and never
//                               exits (ARD: never crash-loop).
//
// Pure fs + string work, zero dependencies, no network: gate.js requires it
// above the lib-mode guard, and the CLI requires it from ESM through
// createRequire.

"use strict";

const fs = require("fs");
const path = require("path");
const modeLib = require("./mode-lib.js"); // one source of truth for the mode names

// A pack's schema_version is a MAJOR version -- the whole number IS the major.
// A pack from a future major is not "mostly readable", it is a pack this box's
// rules do not describe, so it is refused by name rather than half-honoured.
const SUPPORTED_SCHEMA_MAJOR = 1;
// A hat with a fat tool belt is a hat that will pick the wrong tool. 15 is the
// ceiling the ARD sets for a micro-channel hat.
const MAX_TOOLS_PER_HAT = 15;
const CANONICAL_CHANNEL_IDS = Object.freeze([
  "agent_seo_onpage_001",
  "agent_seo_technical_002",
  "agent_seo_local_003",
  "agent_seo_backlinks_004",
  "agent_seo_interlinking_005",
  "agent_content_blog_006",
  "agent_content_whitepaper_007",
  "agent_content_infographic_008",
  "agent_content_video_009",
  "agent_content_podcast_010",
  "agent_social_organic_011",
  "agent_social_paid_012",
  "agent_social_influencer_013",
  "agent_ads_search_014",
  "agent_ads_display_015",
  "agent_ads_video_016",
  "agent_ads_retargeting_017",
  "agent_email_drip_018",
  "agent_email_newsletter_019",
  "agent_email_transactional_020",
  "agent_pr_press_021",
  "agent_pr_journalist_022",
  "agent_affiliate_recruitment_023",
  "agent_affiliate_performance_024",
  "agent_partnership_comarketing_025",
  "agent_partnership_strategic_026",
  "agent_analytics_attribution_027",
  "agent_analytics_predictive_028",
]);
const EXPECTED_CHANNEL_COUNT = CANONICAL_CHANNEL_IDS.length;
// Public copy never says these (ARD non-negotiable) -- "3D Attribution" is the
// public term. Case-insensitive SUBSTRING matches on purpose: "hyperbolicity"
// and "Poincaré's" have to trip it too. The list lives here, in the enforcing
// code, so a pack can never ship its own looser copy of it.
const BANNED_WORDS = Object.freeze(["poincaré", "poincare", "hyperbolic", "möbius", "mobius", "lattice"]);
// The text files a pack can carry. Anything else (images, binaries) is not copy.
const SCANNED_EXTENSIONS = Object.freeze([".md", ".toml", ".json"]);

// Every read in this file is best-effort: a validator that throws on a weird
// file is a validator that can crash the boot path it guards.
function readText(file) {
  try { return fs.readFileSync(file, "utf8"); }
  catch { return null; }
}
function listDir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return []; }
}
function exists(p) {
  try { fs.statSync(p); return true; }
  catch { return false; }
}

// The mode.toml SUBSET, parsed line by line. Deliberately not a TOML library:
// the box reads exactly one key out of this file with a regex (gate.js
// applyMode extracts addendum = """..."""), so a pack that declares richer TOML
// is declaring config nothing will ever read. The subset is: blank lines,
// `# comments`, `[section]` / `[section.sub]` headers, `key = "value"`,
// `key = <integer>`, and `key = """ ... """` blocks.
function parseModeToml(text) {
  const sections = [];
  const errors = [];
  const lines = text.split(/\r?\n/);
  let openBlock = null; // key whose """ block we are inside
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const n = i + 1;
    if (openBlock !== null) { if (/"""\s*$/.test(line)) openBlock = null; continue; }
    if (!line || line.startsWith("#")) continue;
    let m = /^\[([A-Za-z0-9_.-]+)\]\s*(?:#.*)?$/.exec(line);
    if (m) { sections.push(m[1]); continue; }
    m = /^([A-Za-z0-9_-]+)\s*=\s*"""(.*)$/.exec(line);
    if (m) { if (!/"""\s*$/.test(m[2])) openBlock = m[1]; continue; }
    // A trailing `# comment` is accepted on a section or a value line -- it is
    // ordinary TOML, it is what the documented example in the contract looks
    // like, and the box's regex read never sees it. Matched only AFTER a
    // complete value so a `#` inside a quoted string stays part of the string.
    if (/^[A-Za-z0-9_-]+\s*=\s*("[^"]*"|-?\d+)\s*(?:#.*)?$/.test(line)) continue;
    errors.push(`line ${n} (${line.slice(0, 60)}) is not in the mode.toml subset`);
  }
  if (openBlock !== null) errors.push(`the """ block opened by '${openBlock}' is never closed`);
  return { sections, errors };
}

// A hat's tools come from its YAML frontmatter `tools:` key. NO tools key means
// the hat inherits the harness default -- that is not an unbounded belt, it is
// "whatever the box allows", so it is not counted.
//
// Three authoring forms all have to count, because a ceiling that returns GREEN
// on a form it cannot read is worse than no ceiling: the comma list this repo
// documents, the YAML block sequence (`tools:` then `- Read` lines), and either
// of those in a file whose frontmatter does not start at byte 0 -- a UTF-8 BOM
// or a leading blank line, both routine on Windows. (JS `\s` already includes
// U+FEFF, so the leading `\s*` covers the BOM and the blank line in one.)
function frontmatterTools(text) {
  if (!text) return null;
  const m = /^\s*---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  const lines = m[1].split(/\r?\n/);
  const at = lines.findIndex((l) => /^tools:/.test(l));
  if (at < 0) return null;
  const inline = lines[at].slice("tools:".length).trim();
  if (inline) return inline.split(",").map((t) => t.trim()).filter(Boolean);
  // Block sequence: every following `- item` line, until the list ends.
  const items = [];
  for (let i = at + 1; i < lines.length; i++) {
    const item = /^\s*-\s+(.*\S)\s*$/.exec(lines[i]);
    if (!item) break;
    items.push(item[1]);
  }
  return items;
}

function frontmatterName(text) {
  if (!text) return null;
  const match = /^\s*---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return null;
  const line = match[1].split(/\r?\n/).find((entry) => /^name\s*:/.test(entry));
  if (!line) return null;
  const name = line.slice(line.indexOf(":") + 1).trim();
  return name || null;
}

function hasAgentDefinition(agentsRoot, name) {
  const base = String(name || "").replace(/\.md$/, "");
  const flat = path.join(agentsRoot, `${base}.md`);
  try { if (fs.statSync(flat).isFile()) return true; } catch { /* try directory form */ }
  const dir = path.join(agentsRoot, base);
  try { if (!fs.statSync(dir).isDirectory()) return false; } catch { return false; }
  return textFiles(dir)
    .filter((file) => path.extname(file).toLowerCase() === ".md")
    .some((file) => frontmatterName(readText(file)) === base);
}

// Every .md/.toml/.json under the pack, recursively, as absolute paths.
function textFiles(dir, out = []) {
  for (const ent of listDir(dir)) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) textFiles(full, out);
    else if (ent.isFile() && SCANNED_EXTENSIONS.includes(path.extname(ent.name).toLowerCase())) out.push(full);
  }
  return out;
}

function checkNoLinks(dir, root, fail) {
  for (const ent of listDir(dir)) {
    const full = path.join(dir, ent.name);
    let stat = null;
    try { stat = fs.lstatSync(full); }
    catch {
      fail("a", `${path.relative(root, full).replace(/\\/g, "/")} cannot be inspected`);
      continue;
    }
    if (stat.isSymbolicLink()) {
      fail("a", `${path.relative(root, full).replace(/\\/g, "/")} is a symbolic link or junction -- mode packs must contain only their own regular files and directories`);
    } else if (stat.isDirectory()) {
      checkNoLinks(full, root, fail);
    }
  }
}

// ---- the rules --------------------------------------------------------------
// Each helper takes the same `fail(rule, message)` so the two entry points share
// the rules they have in common instead of drifting apart.

function checkModeToml(file, label, fail) {
  const text = readText(file);
  if (text === null) { fail("b", `${label} is missing -- a mode pack must ship one`); return; }
  const parsed = parseModeToml(text);
  for (const e of parsed.errors) fail("b", `${label}: ${e} (see docs/pack-contract.md)`);
  for (const s of parsed.sections) {
    if (s === "gates" || s.startsWith("gates.")) {
      fail("d", `${label} declares a [${s}] section -- the consequence gates (spend, send, deploy, delete, credentials) live OUTSIDE every mode and no pack may re-declare or loosen them`);
    }
  }
}

function checkBannedWords(dir, fail) {
  for (const file of textFiles(dir)) {
    const text = readText(file);
    if (text === null) continue;
    const lower = text.toLowerCase();
    for (const word of BANNED_WORDS) {
      if (lower.includes(word)) {
        fail("g", `${path.relative(dir, file).replace(/\\/g, "/")} says "${word}" -- that vocabulary never ships in public-facing copy ("3D Attribution" is the public term)`);
      }
    }
  }
}

// ---- entry point 1: the source pack (rules a-h) -----------------------------

function validatePack(packDir, opts = {}) {
  const name = path.basename(packDir);
  const errors = [];
  const fail = (rule, msg) => errors.push(`pack '${name}': ${msg} (rule ${rule})`);

  // A link is content the packer may dereference but the recursive copy and
  // tool scans can see differently. Mode packs are repo-owned source trees and
  // need no links, so fail closed instead of trying to make every consumer
  // reproduce filesystem-specific symlink and junction behavior.
  let rootStat = null;
  try { rootStat = fs.lstatSync(packDir); }
  catch { fail("a", "the mode-pack directory cannot be inspected"); }
  if (rootStat?.isSymbolicLink()) {
    fail("a", "the mode-pack directory is a symbolic link or junction");
  } else if (rootStat?.isDirectory()) {
    checkNoLinks(packDir, packDir, fail);
  }
  if (errors.length) return { ok: false, errors };

  // (a) pack.json parses, and the fields the collision guard reads are arrays.
  let meta = null;
  const packJson = readText(path.join(packDir, "pack.json"));
  if (packJson === null) {
    fail("a", "pack.json is missing -- every mode pack declares its contract there");
  } else {
    try { meta = JSON.parse(packJson); }
    catch { fail("a", "pack.json is not valid JSON -- fix the pack before switching"); }
    if (meta !== null && (typeof meta !== "object" || Array.isArray(meta))) {
      fail("a", "pack.json is not a JSON object");
      meta = null;
    }
  }
  if (meta) {
    for (const field of ["criticalSkills", "criticalAgents"]) {
      // Same guard the packer carries: new Set("name") is a set of CHARACTERS,
      // which would silently disarm the collision hard-fail below.
      if (meta[field] !== undefined && !Array.isArray(meta[field])) {
        fail("a", `pack.json ${field} must be an array of names`);
        continue;
      }
      for (const raw of meta[field] || []) {
        const name = field === "criticalAgents" && typeof raw === "string" && raw.endsWith(".md")
          ? raw.slice(0, -3)
          : raw;
        if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) {
          fail("a", `pack.json ${field} contains invalid name ${JSON.stringify(raw)} -- use only letters, numbers, underscore and hyphen`);
        }
      }
    }
  }

  // (c) schema_version: present, an integer, and this box's major.
  if (meta) {
    const v = meta.schema_version;
    if (!Number.isInteger(v)) {
      fail("c", `pack.json schema_version must be an integer, got ${JSON.stringify(v)}`);
    } else if (v !== SUPPORTED_SCHEMA_MAJOR) {
      fail("c", `pack.json schema_version ${v} is not the supported major ${SUPPORTED_SCHEMA_MAJOR} -- this AgentHost cannot read that pack`);
    }
  }

  // (b) + (d) the mode.toml subset, and no consequence gates in it.
  if (readText(path.join(packDir, "MODE.md")) === null) {
    fail("b", "MODE.md is missing -- every mode pack must ship its operator-facing charter");
  }
  checkModeToml(path.join(packDir, "mode.toml"), "mode.toml", fail);

  // (e) per-hat tool ceiling. A hat is any regular agents/ entry the PACKER
  // stages: plain .md files and nested agent directories. Curated-pack links
  // hard-fail under rule a. (scripts/pack.mjs: a `!isFile()` skip there was the
  // same zero-hats bug this pipeline exists to prevent). Disagreeing with the
  // packer about what a hat is would fail rule f on a pack that ships correctly
  // and let that hat's tool belt go unchecked.
  // The ceiling follows the hat wherever its frontmatter lives. A DIRECTORY hat
  // used to be registered and then skipped -- no .md inside it was ever read --
  // so agents/fat-hat/fat-hat.md declaring 40 tools validated GREEN while the
  // identical agents/fat-hat.md correctly failed. Same defect class as the
  // BOM/YAML-block forms below: a ceiling that returns GREEN on a shape it
  // cannot read is worse than no ceiling.
  const hats = new Set();
  const agentsDir = path.join(packDir, "agents");
  const checkHatFiles = (hat, files) => {
    const tools = new Set();
    const sources = [];
    for (const file of files) {
      const declared = frontmatterTools(readText(file));
      if (!declared) continue;
      for (const tool of declared) tools.add(tool);
      sources.push(`agents/${path.relative(agentsDir, file).replace(/\\/g, "/")}`);
    }
    if (tools.size > MAX_TOOLS_PER_HAT) {
      fail("e", `hat '${hat}' declares ${tools.size} tools across ${sources.join(", ")} (the ceiling is ${MAX_TOOLS_PER_HAT}) -- a hat with a fat tool belt picks the wrong tool`);
    }
  };
  for (const ent of listDir(agentsDir)) {
    if (ent.isDirectory()) {
      const hatDir = path.join(agentsDir, ent.name);
      const files = textFiles(hatDir).filter((p) => path.extname(p).toLowerCase() === ".md");
      const definitions = files.filter((file) => frontmatterName(readText(file)) === ent.name);
      if (!definitions.length) {
        fail("f", `agents/${ent.name}/ has no markdown definition whose frontmatter says 'name: ${ent.name}' -- sidecars alone are not a hat`);
        continue;
      }
      hats.add(ent.name);
      checkHatFiles(ent.name, files);
      continue;
    }
    if (!ent.name.endsWith(".md")) continue;
    const hat = ent.name.replace(/\.md$/, "");
    hats.add(hat);
    checkHatFiles(hat, [path.join(agentsDir, ent.name)]);
  }

  // (f) coverage.json owns every channel in the taxonomy, and every owner is a
  //     hat this pack actually ships (no phantom agents).
  //     The taxonomy path is an ARGUMENT: the box has no GTMVP checkout, so the
  //     pack ships its own snapshot and callers may point at the source of truth.
  const taxonomyFile = opts.taxonomyFile || path.join(packDir, "channel-taxonomy.json");
  let ids = null;
  const taxonomyText = readText(taxonomyFile);
  if (taxonomyText === null) {
    fail("f", `channel taxonomy ${taxonomyFile} is unreadable -- channel coverage cannot be proven`);
  } else {
    try {
      const parsed = JSON.parse(taxonomyText);
      ids = Array.isArray(parsed && parsed.agents) ? parsed.agents.map((a) => a && a.agent_id).filter(Boolean) : null;
    } catch { ids = null; }
    if (!ids || !ids.length) fail("f", `channel taxonomy ${taxonomyFile} has no agents[] with agent_id values`);
    else {
      const expectedIds = Array.isArray(opts.expectedChannelIds) ? opts.expectedChannelIds : CANONICAL_CHANNEL_IDS;
      const expectedCount = Number.isInteger(opts.expectedChannelCount) ? opts.expectedChannelCount : expectedIds.length;
      if (ids.length !== expectedCount) {
        fail("f", `channel taxonomy must contain exactly ${expectedCount} agent_id values, got ${ids.length} -- a pack cannot shrink its own coverage universe`);
      }
      const seen = new Set();
      const duplicates = new Set();
      for (const id of ids) { if (seen.has(id)) duplicates.add(id); else seen.add(id); }
      if (duplicates.size) fail("f", `channel taxonomy has duplicate agent_id values: ${[...duplicates].join(", ")}`);
      const expected = new Set(expectedIds);
      const missingCanonical = expectedIds.filter((id) => !seen.has(id));
      const unexpectedCanonical = [...seen].filter((id) => !expected.has(id));
      if (missingCanonical.length || unexpectedCanonical.length) {
        fail("f", `channel taxonomy does not match the canonical roster${missingCanonical.length ? `; missing: ${missingCanonical.join(", ")}` : ""}${unexpectedCanonical.length ? `; unexpected: ${unexpectedCanonical.join(", ")}` : ""}`);
      }
    }
  }
  const coverageText = readText(path.join(packDir, "coverage.json"));
  let coverage = null;
  if (coverageText === null) {
    fail("f", "coverage.json is missing -- every channel must name the hat that owns it");
  } else {
    try { coverage = JSON.parse(coverageText); }
    catch { fail("f", "coverage.json is not valid JSON"); }
    if (coverage !== null && (typeof coverage !== "object" || Array.isArray(coverage))) {
      fail("f", "coverage.json must be an object mapping agent_id -> hat name");
      coverage = null;
    }
  }
  if (ids && coverage) {
    const owned = new Set(Object.keys(coverage));
    const missing = ids.filter((id) => !owned.has(id));
    if (missing.length) fail("f", `coverage.json leaves ${missing.length} channel(s) unowned: ${missing.join(", ")}`);
    const known = new Set(ids);
    const unknown = Object.keys(coverage).filter((id) => !known.has(id));
    if (unknown.length) fail("f", `coverage.json names ${unknown.length} channel(s) the taxonomy does not have: ${unknown.join(", ")}`);
    for (const [id, hat] of Object.entries(coverage)) {
      if (typeof hat !== "string" || !hat.trim()) fail("f", `coverage.json entry '${id}' does not name a hat`);
      else if (!hats.has(hat)) fail("f", `coverage.json gives '${id}' to hat '${hat}', which this pack does not ship (no agents/${hat}.md and no agents/${hat}/) -- a phantom agent owns nothing`);
    }
  }

  // (g) banned public-copy vocabulary anywhere in the pack's text.
  checkBannedWords(packDir, fail);

  // (h) critical content must not collide with the operator's own harness. The
  //     packer keeps the USER's copy on a collision, so a critical skill/agent
  //     that collides is silently dropped -- which is how a mode boots without
  //     the very hat it depends on (H3: Steve's harness already has a
  //     content-engine skill). Refuse the switch instead.
  if (opts.harnessDir && meta) {
    for (const skill of meta.criticalSkills || []) {
      if (exists(path.join(opts.harnessDir, "skills", String(skill)))) {
        fail("h", `critical skill '${skill}' already exists in your harness -- the packer would keep YOURS and drop the pack's. Rename yours, or rename the pack's.`);
      }
    }
    for (const agent of meta.criticalAgents || []) {
      const base = String(agent).replace(/\.md$/, "");
      if (exists(path.join(opts.harnessDir, "agents", `${base}.md`)) || exists(path.join(opts.harnessDir, "agents", base))) {
        fail("h", `critical agent '${base}' already exists in your harness -- the packer would keep YOURS and drop the pack's. Rename yours, or rename the pack's.`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

// ---- entry point 2: the deployed mode dir + the boot decision ---------------

function validateModeDir(modeDir) {
  const name = path.basename(modeDir);
  const errors = [];
  const fail = (rule, msg) => errors.push(`mode '${name}': ${msg} (rule ${rule})`);
  let rootStat = null;
  try { rootStat = fs.lstatSync(modeDir); }
  catch { fail("a", "the deployed mode directory cannot be inspected"); }
  if (rootStat?.isSymbolicLink()) {
    fail("a", "the deployed mode directory is a symbolic link or junction");
  } else if (rootStat?.isDirectory()) {
    checkNoLinks(modeDir, modeDir, fail);
  }
  if (errors.length) return { ok: false, errors };
  if (readText(path.join(modeDir, "MODE.md")) === null) {
    fail("b", "MODE.md is missing -- the deployed mode pack is incomplete");
  }
  checkModeToml(path.join(modeDir, "mode.toml"), "mode.toml", fail);
  checkBannedWords(modeDir, fail);
  return { ok: errors.length === 0, errors };
}

// What the gate calls at boot. Returns the mode to actually run in, plus the
// reasons if that is not the requested one. Default never touches the disk. A
// non-default mode is honoured only when its deployed pack is present, readable,
// and valid; otherwise the box fails closed to default and the caller alerts.
function bootMode(requested, modesRoot) {
  try {
    if (requested === modeLib.DEFAULT_MODE) return { mode: requested, errors: [] };
    const dir = path.join(String(modesRoot || ""), requested);
    let deployed = false;
    try { deployed = fs.statSync(dir).isDirectory(); } catch { deployed = false; }
    if (!deployed) {
      return { mode: modeLib.DEFAULT_MODE, errors: [`mode '${requested}': deployed mode pack is missing or unreadable (rule b)`] };
    }
    const res = validateModeDir(dir);
    return res.ok ? { mode: requested, errors: [] } : { mode: modeLib.DEFAULT_MODE, errors: res.errors };
  } catch (error) {
    return { mode: modeLib.DEFAULT_MODE, errors: [`mode '${requested}': validation failed closed (${error?.message || "unknown error"}) (rule b)`] };
  }
}

module.exports = {
  SUPPORTED_SCHEMA_MAJOR, MAX_TOOLS_PER_HAT, CANONICAL_CHANNEL_IDS, EXPECTED_CHANNEL_COUNT, BANNED_WORDS,
  hasAgentDefinition, validatePack, validateModeDir, bootMode,
};
