#!/usr/bin/env node
// AgentHost packer: read the local Claude Code harness, apply the migration
// manifest (include/exclude/scrub/translate), emit harness.tar.gz + manifest.json
// + compat-report.md. Nothing leaves the machine; this only writes to --out.
//
// Security invariants (these back the product's core promise):
//   1. Credential files are never packed (EXCLUDE_NAMES).
//   2. Secret-bearing values inside packed JSON configs (MCP env blocks, headers,
//      key-shaped fields) are REDACTED before the tarball is written; the report
//      lists what was redacted so the user can re-provide them as Fly secrets.
//   3. All other packed text files are scanned for high-confidence secret shapes
//      and loudly flagged (not mutated -- skills may contain doc examples).
//
// Usage: node scripts/pack.mjs --out <dir> [--dry-run]

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  EXCLUDE_NAMES, EXCLUDE_NAME_RE, PROCESS_JSON, STALE_PATH_RE, SECRET_SHAPES,
  scrubAndTranslate, scanMcpConfig, pruneUnportableHooks,
  matchesHermesExclude, redactHermesConfigYaml, disableWindowsMcpBlocks, redactEnvFile,
} from "./pack-lib.mjs";

const args = process.argv.slice(2);
const outDir = args.includes("--out") ? args[args.indexOf("--out") + 1] : path.join(os.tmpdir(), "agenthost-pack");
const dryRun = args.includes("--dry-run");
// --include <path> (repeatable): extra dirs/files to migrate -- Obsidian vaults,
// hook-script projects, anything your harness reaches for outside ~/.claude.
// Must live under the home directory (that's the only path we can translate).
const includes = [];
for (let i = 0; i < args.length; i++) if (args[i] === "--include") includes.push(args[i + 1]);
// --agent hermes (beta): also pack ~/.hermes per the Hermes Manifest v2.
const packHermes = args.includes("--agent") && args[args.indexOf("--agent") + 1] === "hermes";
// --hermes-only: pack ONLY the Hermes harness, skipping the ~/.claude bulk.
// Use when ADDING Hermes to a box whose Claude harness is already set up and
// must not be overwritten (the tarball extracts as an overlay onto $HOME, so
// packing .claude would replace the box's copy). Implies --agent hermes.
const hermesOnly = args.includes("--hermes-only");
// Hermes optional payloads, default OFF (see the "## Hermes" report section):
const withWhatsapp = args.includes("--with-whatsapp");
const withKanban = args.includes("--with-kanban");
// --pack <name> (repeatable): preload a curated AgentHost skill pack from the
// repo's packs/<name>/skills/ into the staged harness. Packs are our own vetted
// content; they ride the same tarball and land at ~/.claude/skills/ on the box.
const packNames = [];
for (let i = 0; i < args.length; i++) if (args[i] === "--pack") packNames.push(args[i + 1]);

const HOME = os.homedir();
const SRC = path.join(HOME, ".claude");
const CLOUD_HOME = "/data/home/agent";
const STAGING_ROOT = path.join(outDir, "staging");
const STAGING = path.join(STAGING_ROOT, ".claude");

// ---- The manifest -----------------------------------------------------------
const INCLUDE_FILES = ["CLAUDE.md", "settings.json", "keybindings.json", "mcp.json"];
const INCLUDE_DIRS = ["skills", "agents", "commands", "rules", "hooks", "scripts", "mcp-configs"];
// JSON configs that get parsed, scrubbed of secrets, and path-translated:
// (constants + pure logic live in pack-lib.mjs: EXCLUDE_NAMES, PROCESS_JSON, WINPATH_RE, SECRET_SHAPES, REDACTED)

const report = {
  included: [], excluded: [], translated: [], flags: [], mcp: [],
  redactedSecrets: [], possibleSecrets: [], nonHomeWindowsPaths: [],
  totalBytes: 0, fileCount: 0,
};

// ---- copy with filename-level filtering -------------------------------------
// extraExclude: optional per-agent predicate (e.g. matchesHermesExclude),
// applied ON TOP of the global EXCLUDE_NAMES -- never instead of it.
function copyFiltered(src, dest, extraExclude = null) {
  const base = path.basename(src);
  if (EXCLUDE_NAMES.has(base) || EXCLUDE_NAME_RE.test(base) || (extraExclude && extraExclude(base))) {
    // Report home-relative for anything outside ~/.claude (.hermes, --include)
    const rel = path.relative(SRC, src);
    report.excluded.push(rel.startsWith("..") ? path.relative(HOME, src) : rel);
    return;
  }
  // lstat (not stat) so a symlink is inspected as a link, not its target. A
  // symlink whose target is missing (dangling -- common when a WSL harness is
  // read through a Windows \\wsl.localhost mount, where relative link targets
  // don't traverse) must be skipped with a warning, never crash the whole pack.
  // A resolvable symlink falls through to statSync below and is copied as its
  // (dereferenced) content.
  let ls;
  try { ls = fs.lstatSync(src); }
  catch (e) { report.flags.push(`skipped (lstat failed): ${path.relative(HOME, src)} (${e.code || e.message})`); return; }
  if (ls.isSymbolicLink() && !fs.existsSync(src)) {
    report.flags.push(`dangling symlink skipped: ${path.relative(HOME, src)} -> ${(() => { try { return fs.readlinkSync(src); } catch { return "?"; } })()}`);
    return;
  }
  let st;
  try { st = fs.statSync(src); }
  catch (e) { report.flags.push(`skipped (stat failed): ${path.relative(HOME, src)} (${e.code || e.message})`); return; }
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) copyFiltered(path.join(src, entry), path.join(dest, entry), extraExclude);
  } else if (st.isFile()) {
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      // Windows checkouts ship CRLF; bash on the cloud box chokes on \r
      // ("$'\r': command not found", every hook blocked). Normalize shell
      // scripts only -- other text is copied byte-for-byte.
      if (base.endsWith(".sh")) {
        const text = fs.readFileSync(dest, "utf8");
        if (text.includes("\r\n")) fs.writeFileSync(dest, text.replace(/\r\n/g, "\n"));
      }
      report.totalBytes += st.size;
      report.fileCount += 1;
      if (base.endsWith(".ps1")) report.flags.push(`PowerShell script (won't run on Linux): ${path.relative(SRC, src)}`);
    } catch (e) {
      report.flags.push(`unreadable, skipped: ${path.relative(SRC, src)} (${e.code || e.message})`);
    }
  }
}

// ---- JSON-aware scrub + path translation -------------------------------------
// Walks parsed JSON. Never does whole-file string surgery, so unrelated values
// (regexes, escaped strings, non-path backslashes) are never touched.
const HOME_VARIANTS = [HOME, HOME.replace(/\\/g, "/"), HOME.replace(/\\/g, "\\\\")];

function processJsonConfig(file, label) {
  if (!fs.existsSync(file)) return;
  let obj;
  try { obj = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { report.flags.push(`could not parse ${label}; packed unmodified -- REVIEW IT FOR SECRETS MANUALLY`); return; }
  const stats = { translated: 0, nonHome: [] };
  const cleaned = scrubAndTranslate(obj, label, "", stats, HOME_VARIANTS, CLOUD_HOME, report);
  fs.writeFileSync(file, JSON.stringify(cleaned, null, 2));
  if (stats.translated > 0) report.translated.push(`${label} (${stats.translated} values)`);
  for (const p of stats.nonHome) report.nonHomeWindowsPaths.push(`${label}: ${p}`);
}

// ---- generic secret scan for everything else ---------------------------------
function scanForSecrets(dir, processedSet) {
  for (const entry of fs.readdirSync(dir)) {
    const p = path.join(dir, entry);
    const st = fs.statSync(p);
    if (st.isDirectory()) scanForSecrets(p, processedSet);
    else if (st.size < 512 * 1024 && !processedSet.has(p)) {
      try {
        const text = fs.readFileSync(p, "utf8");
        for (const [shapeName, re] of SECRET_SHAPES) {
          if (re.test(text)) report.possibleSecrets.push(`${path.relative(STAGING_ROOT, p)} (${shapeName})`);
        }
      } catch { /* binary; skip */ }
    }
  }
}

// Files (packed as-is, never mutated) that still contain machine-specific
// paths -- Windows drive letters or WSL /mnt/<drive>/ mounts. Listed by name
// in the compat report so the user knows exactly what to review, instead of
// the bare count this used to be.
function findStalePathFiles(dir, results = { files: [] }) {
  for (const entry of fs.readdirSync(dir)) {
    const p = path.join(dir, entry);
    const st = fs.statSync(p);
    if (st.isDirectory()) findStalePathFiles(p, results);
    else if (st.size < 512 * 1024) {
      try { if (STALE_PATH_RE.test(fs.readFileSync(p, "utf8"))) results.files.push(path.relative(STAGING_ROOT, p)); }
      catch { /* binary or unreadable; skip */ }
    }
  }
  return results;
}

// ---- run --------------------------------------------------------------------
// --hermes-only skips the Claude harness entirely (add-Hermes-without-touching-
// -Claude); otherwise the Claude harness is required and packed.
if (hermesOnly) {
  if (!packHermes) { console.error("--hermes-only requires --agent hermes"); process.exit(1); }
  console.log("*** --hermes-only: packing ONLY the Hermes harness; the box's Claude harness is left untouched.");
}
if (!hermesOnly && !fs.existsSync(SRC)) {
  console.error(`No Claude Code harness found at ${SRC}`);
  process.exit(1);
}
fs.rmSync(path.join(outDir, "staging"), { recursive: true, force: true });
fs.mkdirSync(STAGING, { recursive: true });

for (const f of hermesOnly ? [] : INCLUDE_FILES) {
  const p = path.join(SRC, f);
  if (fs.existsSync(p)) { copyFiltered(p, path.join(STAGING, f)); report.included.push(f); }
}
for (const d of hermesOnly ? [] : INCLUDE_DIRS) {
  const p = path.join(SRC, d);
  if (fs.existsSync(p)) { copyFiltered(p, path.join(STAGING, d)); report.included.push(d + "/"); }
}
// Plugins: the installed set + marketplaces + plugin data, MINUS the
// regeneratable cache/ (re-downloaded on first use; shipping it is dead weight).
// Plugin manifests/configs still flow through the secret + stale-path scans.
const pluginsSrc = path.join(SRC, "plugins");
if (!hermesOnly && fs.existsSync(pluginsSrc)) {
  copyFiltered(pluginsSrc, path.join(STAGING, "plugins"), (base) => base === "cache");
  report.included.push("plugins/ (minus cache)");
}

const projRoot = path.join(SRC, "projects");
if (!hermesOnly && fs.existsSync(projRoot)) {
  for (const slug of fs.readdirSync(projRoot)) {
    const mem = path.join(projRoot, slug, "memory");
    if (fs.existsSync(mem)) {
      copyFiltered(mem, path.join(STAGING, "projects", slug, "memory"));
      report.included.push(`projects/${slug}/memory/`);
    }
  }
}

// ---- extra includes (--include): vaults, brain scripts, anything home-relative.
// Staged at the same home-relative path, so hook commands that were already
// translated to /data/home/agent/<rel> resolve on the box with no extra work.
for (const inc of includes) {
  // "~" reaches us literally from PowerShell/cmd (no shell expansion for args).
  const expanded = inc === "~" || inc.startsWith("~/") || inc.startsWith("~\\")
    ? path.join(HOME, inc.slice(1)) : inc;
  // Bare relative paths resolve against HOME, not CWD -- the documented
  // contract is "home-relative", and resolving against CWD made
  // `--include Projects/operator-brain` fail unless run from the home dir
  // (bit Steve on 2026-07-11; the error even said "inside your home directory").
  const abs = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(HOME, expanded);
  const rel = path.relative(HOME, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    console.error(`--include must point inside your home directory (got: ${inc})`);
    process.exit(1);
  }
  if (!fs.existsSync(abs)) {
    console.error(`--include path does not exist: ${inc}`);
    process.exit(1);
  }
  copyFiltered(abs, path.join(STAGING_ROOT, ...rel.split(path.sep)));
  report.included.push(`${rel.split(path.sep).join("/")}/ (--include)`);
}

// ---- Hermes (beta, --agent hermes): pack ~/.hermes per the Hermes Manifest v2.
// Staged at staging/.hermes so tar extraction lands it at /data/home/agent/.hermes;
// the box sets HERMES_HOME to that path. Explicit include lists (never "copy
// everything"), HERMES_EXCLUDE on top of the global excludes, and targeted
// line-surgery redaction of config.yaml/.env on the STAGED copies only.
// HERMES_HOME lets you point at a Hermes harness outside the CLI user's home --
// notably the REAL one in WSL (\\wsl.localhost\<distro>\home\<user>\.hermes) when
// running the Windows CLI, since the Windows-native ~/.hermes is usually a stub.
// Matches the var the box itself uses (start.sh sets HERMES_HOME). Falls back to
// ~/.hermes.
const HERMES_SRC = process.env.HERMES_HOME || path.join(HOME, ".hermes");
const HERMES_INCLUDE_FILES = ["config.yaml", ".env", "SOUL.md", "auth.json", "channel_directory.json"];
const HERMES_INCLUDE_DIRS = ["skills", "memories", "cron", "pairing", ".agents", "plugins"];
const hermes = { included: [], notes: [], redacted: [], mcp: [] };
const processedHermes = new Set(); // staged .hermes files already scrubbed (skip in generic scan)
if (packHermes) {
  if (process.platform === "win32" && !process.env.HERMES_HOME) {
    const twoHomes = "Windows-native Hermes (%LOCALAPPDATA%\\hermes) is often a setup stub -- the real harness usually lives in WSL. Set HERMES_HOME to the WSL path (e.g. \\\\wsl.localhost\\Ubuntu\\home\\<user>\\.hermes) or run this from WSL to migrate the real one.";
    console.log(`\n*** ${twoHomes}`);
    report.flags.push(twoHomes);
  }
  if (!fs.existsSync(HERMES_SRC)) {
    console.error(`--agent hermes: no Hermes harness found at ${HERMES_SRC}`);
    process.exit(1);
  }
  const HERMES_STAGING = path.join(STAGING_ROOT, ".hermes");
  const redactedBefore = report.redactedSecrets.length;
  const mcpBefore = report.mcp.length;
  for (const f of HERMES_INCLUDE_FILES) {
    const p = path.join(HERMES_SRC, f);
    if (fs.existsSync(p)) { copyFiltered(p, path.join(HERMES_STAGING, f), matchesHermesExclude); hermes.included.push(f); }
  }
  for (const d of HERMES_INCLUDE_DIRS) {
    const p = path.join(HERMES_SRC, d);
    if (fs.existsSync(p)) { copyFiltered(p, path.join(HERMES_STAGING, d), matchesHermesExclude); hermes.included.push(d + "/"); }
  }
  // Optional payloads, default OFF:
  if (withWhatsapp && fs.existsSync(path.join(HERMES_SRC, "whatsapp"))) {
    copyFiltered(path.join(HERMES_SRC, "whatsapp"), path.join(HERMES_STAGING, "whatsapp"), matchesHermesExclude);
    hermes.included.push("whatsapp/ (--with-whatsapp)");
  } else {
    hermes.notes.push("WhatsApp session not migrated -- scan a fresh QR from the cloud box");
  }
  if (withKanban && fs.existsSync(path.join(HERMES_SRC, "kanban.db"))) {
    copyFiltered(path.join(HERMES_SRC, "kanban.db"), path.join(HERMES_STAGING, "kanban.db"), matchesHermesExclude);
    hermes.included.push("kanban.db (--with-kanban)");
  } else {
    hermes.notes.push("fresh kanban.db on the box (safe for parallel local+cloud)");
  }
  // config.yaml: targeted redaction + windows-MCP disable (staged copy only).
  const stagedConfig = path.join(HERMES_STAGING, "config.yaml");
  if (fs.existsSync(stagedConfig)) {
    let text = fs.readFileSync(stagedConfig, "utf8");
    text = redactHermesConfigYaml(text, report);
    text = disableWindowsMcpBlocks(text, report);
    fs.writeFileSync(stagedConfig, text);
  }
  report.flags.push("Hermes computer_use tools will fail on a headless cloud box -- disable that toolset in config.yaml if enabled");
  // auth.json / channel_directory.json: JSON, so run the same structural
  // scrubber Claude configs get (env/headers blocks + key-shaped fields like
  // api_key/token/refresh_token). Skipping this shipped auth.json's credential
  // pool verbatim -- the worst leak the audit found.
  for (const jf of ["auth.json", "channel_directory.json"]) {
    const p = path.join(HERMES_STAGING, jf);
    if (fs.existsSync(p)) { processJsonConfig(p, `.hermes/${jf}`); processedHermes.add(p); }
  }
  // .env: every value redacted; keys re-provided as HERMESENV_* Fly secrets
  // (deploy --hermes-secrets-from-local stages them laptop -> Fly directly).
  const stagedEnv = path.join(HERMES_STAGING, ".env");
  if (fs.existsSync(stagedEnv)) {
    const { text } = redactEnvFile(fs.readFileSync(stagedEnv, "utf8"), report);
    fs.writeFileSync(stagedEnv, text);
  }
  hermes.redacted = report.redactedSecrets.slice(redactedBefore);
  hermes.mcp = report.mcp.slice(mcpBefore);
  report.included.push(".hermes/ (beta)");
}

// scrub + translate the JSON configs (staged copies only; source files untouched)
const processed = new Set();
for (const f of PROCESS_JSON) {
  const p = path.join(STAGING, f);
  processJsonConfig(p, f);
  processed.add(p);
}
const mcpConfDir = path.join(STAGING, "mcp-configs");
if (fs.existsSync(mcpConfDir)) {
  for (const entry of fs.readdirSync(mcpConfDir)) {
    if (entry.endsWith(".json")) {
      const p = path.join(mcpConfDir, entry);
      processJsonConfig(p, `mcp-configs/${entry}`);
      processed.add(p);
    }
  }
}

// scan everything else for secret shapes (flag, never mutate) -- the WHOLE
// staging tree, so --include'd vaults and .hermes are covered too. Already-
// scrubbed Hermes JSON files are in processedHermes; the redacted config.yaml
// and .env are re-scanned deliberately as a leak backstop.
for (const p of processedHermes) processed.add(p);
scanForSecrets(STAGING_ROOT, processed);

// ---- hook portability: prune unportable hooks from the CLOUD settings.json.
// This was launch night's "15 stop hook errors", then the 2026-07-10 sync
// flood: Windows-only hooks (C:/ paths, PowerShell, %APPDATA%) and hooks whose
// scripts aren't migrated can never run on the box, and every sync re-delivered
// them. Same treatment localhost MCP servers get -- dead config never ships;
// the report names the hook, why it was removed, and the fix. The user's LOCAL
// settings.json is never touched (we edit the staged copy only).
const hookGaps = [];      // missing-target subset (sync/deploy print these as --include fixes)
const removedHooks = [];  // every removed hook, with reason + fix
try {
  const stagedSettingsPath = path.join(STAGING, "settings.json");
  const staged = JSON.parse(fs.readFileSync(stagedSettingsPath, "utf8"));
  const { hooks: cleanedHooks, removed } = pruneUnportableHooks(
    staged.hooks, CLOUD_HOME,
    (rel) => fs.existsSync(path.join(STAGING_ROOT, ...rel.split("/"))),
  );
  for (const r of removed) {
    const cmd = r.command.length > 100 ? r.command.slice(0, 100) + "..." : r.command;
    const label = `[${r.event}${r.matcher ? ` / ${r.matcher}` : ""}] hook \`${cmd}\``;
    if (r.missingRel) {
      const localPath = path.join(HOME, ...r.missingRel.split("/"));
      const line = `${label}: ${r.reason} -- removed from the cloud settings.json; to keep it, re-pack with: --include "${localPath}"`;
      removedHooks.push(line);
      hookGaps.push(line);
    } else {
      removedHooks.push(`${label}: ${r.reason} -- removed from the cloud settings.json; your local file is untouched`);
    }
  }
  if (removed.length) {
    staged.hooks = cleanedHooks;
    fs.writeFileSync(stagedSettingsPath, JSON.stringify(staged, null, 2));
  }
} catch { /* no staged settings.json or unparseable; nothing to prune */ }

// MCP compatibility scan (global ~/.claude.json is report-only, never migrated:
// it holds machine state and auth material)
for (const [label, p] of [
  ["~/.claude/mcp.json", path.join(SRC, "mcp.json")],
  ["~/.claude.json (report-only, not migrated)", path.join(HOME, ".claude.json")],
  ["~/.claude/settings.json", path.join(SRC, "settings.json")],
]) {
  if (fs.existsSync(p)) {
    try { scanMcpConfig(label, JSON.parse(fs.readFileSync(p, "utf8")), report); }
    catch { report.flags.push(`could not parse ${label} for MCP scan`); }
  }
}

// ---- curated skill packs (--pack <name>) -------------------------------------
// Copied AFTER harness staging so a pack never overwrites the user's own skill
// of the same name (user's harness wins; the collision is reported instead).
const REPO_ROOT_FOR_PACKS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const packsLoaded = [];
for (const name of packNames) {
  if (!/^[a-z0-9-]+$/.test(name || "")) { report.flags.push(`--pack '${name}': invalid pack name (a-z, 0-9, -)`); continue; }
  const packSkillsDir = path.join(REPO_ROOT_FOR_PACKS, "packs", name, "skills");
  if (!fs.existsSync(packSkillsDir)) { report.flags.push(`--pack '${name}': not found (no packs/${name}/skills in this AgentHost install)`); continue; }
  const loaded = [];
  for (const ent of fs.readdirSync(packSkillsDir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const dest = path.join(STAGING, "skills", ent.name);
    if (fs.existsSync(dest)) { report.flags.push(`pack '${name}': skill '${ent.name}' already exists in your harness -- yours kept, pack copy skipped`); continue; }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(path.join(packSkillsDir, ent.name), dest, { recursive: true });
    loaded.push(ent.name);
    for (const f of fs.readdirSync(dest, { recursive: true })) {
      const fp = path.join(dest, String(f));
      if (fs.statSync(fp).isFile()) { report.fileCount++; report.totalBytes += fs.statSync(fp).size; report.included.push(path.join("skills", ent.name, String(f))); }
    }
  }
  packsLoaded.push({ name, skills: loaded });
  console.log(`pack '${name}': preloaded ${loaded.length} skill(s): ${loaded.join(", ") || "(none)"}`);
}

const stalePathFiles = findStalePathFiles(STAGING_ROOT).files;

// tar it. Run tar FROM outDir with relative paths so no absolute path is ever
// handed to it: GNU tar (the tar on the PATH under Git Bash on Windows) reads a
// leading "C:" as a remote SCP host and dies with "Cannot connect to C:". A
// relative -f/-C from cwd sidesteps the drive letter on every tar family (GNU,
// Windows bsdtar, macOS/Linux) with no per-OS flag. Env is preserved so tar is
// still found on the PATH. A tar failure must not prevent the manifest/report.
const tarball = path.join(outDir, "harness.tar.gz");
let tarError = null;
if (!dryRun) {
  try { execFileSync("tar", ["-czf", "harness.tar.gz", "-C", "staging", "."], { cwd: outDir }); }
  catch (e) { tarError = e.message; report.flags.push(`tar failed: ${e.message} -- no tarball was written`); }
}

// ---- outputs ----------------------------------------------------------------
const manifest = {
  packedAt: new Date().toISOString(),
  source: SRC,
  files: report.fileCount,
  bytes: report.totalBytes,
  included: report.included,
  excluded: report.excluded,
  translated: report.translated,
  redactedSecrets: report.redactedSecrets,
  possibleSecrets: report.possibleSecrets,
  nonHomeWindowsPaths: report.nonHomeWindowsPaths,
  flags: report.flags,
  mcp: report.mcp,
  hookGaps,
  removedHooks,
  packs: packsLoaded,
  filesWithStalePaths: stalePathFiles,
  tarball: dryRun || tarError ? null : tarball,
};
fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

const disabled = report.mcp.filter(m => m.verdict.startsWith("DISABLED"));
const lines = [
  "# Cloud compatibility report",
  "",
  `Packed ${report.fileCount} files (${(report.totalBytes / 1024 / 1024).toFixed(1)} MB) from ${SRC}`,
  `Included: ${report.included.join(", ")}`,
  `Credential files excluded: ${report.excluded.length ? report.excluded.join(", ") : "none found"}`,
  `Path-translated configs: ${report.translated.join(", ") || "none"}`,
  `Files still containing machine-specific paths (Windows or WSL /mnt; packed as-is, listed below): ${stalePathFiles.length}`,
  "",
  "## Secrets redacted from packed configs (re-provide via fly secrets to re-enable)",
  ...(report.redactedSecrets.length ? report.redactedSecrets.map(s => `- ${s}`) : ["- none found"]),
  "",
  "## Possible secrets detected in other packed files (NOT redacted -- review before shipping)",
  ...(report.possibleSecrets.length ? report.possibleSecrets.map(s => `- ${s}`) : ["- none found"]),
  "",
  "## Machine-specific paths in configs, outside the home directory (left as-is, will not resolve in the cloud)",
  ...(report.nonHomeWindowsPaths.length ? report.nonHomeWindowsPaths.map(s => `- ${s}`) : ["- none found"]),
  "",
  "## Packed files still containing machine-specific paths (not mutated -- these are free-text files; review any that matter)",
  ...(stalePathFiles.length ? stalePathFiles.slice(0, 50).map(f => `- ${f}`) : ["- none found"]),
  ...(stalePathFiles.length > 50 ? [`- ...and ${stalePathFiles.length - 50} more (full list in manifest.json filesWithStalePaths)`] : []),
  "",
  "## MCP servers",
  ...report.mcp.map(m => `- [${m.verdict}] ${m.name} (${m.source})`),
  "",
  "## Hooks removed from the cloud settings.json (could never run on the box; your local file is untouched)",
  ...(removedHooks.length ? removedHooks.map(h => `- ${h}`) : ["- none found"]),
  "",
  ...(packHermes ? [
    "## Hermes",
    `Included from ~/.hermes: ${hermes.included.join(", ") || "none found"}`,
    ...hermes.notes.map(n => `- ${n}`),
    "",
    "### Hermes MCP servers (config.yaml)",
    ...(hermes.mcp.length ? hermes.mcp.map(m => `- [${m.verdict}] ${m.name}`) : ["- none found"]),
    "",
    "### Hermes secrets redacted (re-provide via fly secrets)",
    ...(hermes.redacted.length ? hermes.redacted.map(s => `- ${s}`) : ["- none found"]),
    "",
    "### Hermes notes",
    "- Hermes computer_use tools will fail on a headless cloud box -- disable that toolset in config.yaml if enabled",
    "- run 'hermes gateway status' after boot to verify platforms connected",
    "",
  ] : []),
  "## Flags",
  ...(report.flags.length ? report.flags.map(f => `- ${f}`) : ["- none"]),
];
fs.writeFileSync(path.join(outDir, "compat-report.md"), lines.join("\n"));

console.log(`\nPacked ${report.fileCount} files, ${(report.totalBytes / 1024 / 1024).toFixed(1)} MB`);
console.log(`Secrets redacted from configs: ${report.redactedSecrets.length}`);
if (report.possibleSecrets.length) {
  console.log(`\n*** WARNING: ${report.possibleSecrets.length} possible secret(s) found in packed files (not redacted).`);
  console.log(`*** Review the "Possible secrets" section of compat-report.md before this tarball goes anywhere.`);
}
if (removedHooks.length) {
  console.log(`\n*** ${removedHooks.length} unportable hook(s) removed from the CLOUD settings.json (your local file is untouched):`);
  for (const h of removedHooks) console.log(`***   ${h}`);
}
console.log(`MCP servers scanned: ${report.mcp.length} (${disabled.length} disabled as unreachable from the cloud)`);
console.log(`Output: ${outDir}`);
if (dryRun) console.log("(dry run: no tarball written)");
if (tarError) { console.error(`\ntar failed: ${tarError}`); process.exit(1); }
