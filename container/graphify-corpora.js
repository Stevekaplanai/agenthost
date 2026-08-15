"use strict";

// Trusted server-side registry for Graphify inputs. Browser choices carry only
// opaque ids and display labels; absolute roots are resolved again for every
// run from operator-owned configuration.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const NAMED_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const DYNAMIC_FOLDER_ID_RE = /^f_[a-f0-9]{24}$/;
const HARNESS_FOLDER_ID_RE = /^h_[a-z]+$/;
const MAX_DIRECTORY_CHOICES = 100;
const MAX_TOP_LEVEL_CHOICES = 48;
const MAX_STRUCTURE_INPUTS = 160;

const SKIPPED_DIRECTORY_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".next",
  "build",
  "cache",
  "caches",
  "coverage",
  "dist",
  "graphify-out",
  "history",
  "log",
  "logs",
  "node_modules",
  "session",
  "sessions",
  "temp",
  "tmp",
]);

const CODE_EXTENSIONS = Object.freeze([
  ".bash", ".c", ".cc", ".cjs", ".cpp", ".cs", ".css", ".go", ".h", ".hpp",
  ".html", ".java", ".js", ".json", ".jsx", ".kt", ".md", ".mdx", ".mjs",
  ".php", ".ps1", ".py", ".rb", ".rs", ".scss", ".sh", ".sql", ".swift",
  ".toml", ".ts", ".tsx", ".txt", ".yaml", ".yml",
]);
const CODE_BASENAMES = Object.freeze([
  "Dockerfile", "Gemfile", "LICENSE", "Makefile", "README", "README.md", "Rakefile",
]);
// Arbitrary JSON/YAML beneath a harness can be session or credential material.
// Structured files therefore enter only through the explicit basename list.
const HARNESS_EXTENSIONS = Object.freeze([".md", ".mdx"]);
const HARNESS_BASENAMES = Object.freeze([
  ".mcp.json",
  "AGENTS.md",
  "CLAUDE.md",
  "README",
  "README.md",
  "SKILL.md",
  "config.json",
  "config.yaml",
  "config.yml",
  "installed_plugins.json",
  "known_marketplaces.json",
  "manifest.json",
  "mcp.json",
  "package.json",
  "plugin.json",
  "settings.json",
]);

const POLICIES = Object.freeze({
  harness: Object.freeze({
    extensions: HARNESS_EXTENSIONS,
    allowedBasenames: HARNESS_BASENAMES,
    maxDepth: 8,
    redactInputs: true,
    snapshotKind: "folder",
  }),
  vault: Object.freeze({
    extensions: Object.freeze([".json", ".md", ".mdx", ".txt", ".yaml", ".yml"]),
    allowedBasenames: Object.freeze(["README", "README.md"]),
    maxDepth: 12,
    redactInputs: true,
    snapshotKind: "folder",
  }),
  repository: Object.freeze({
    extensions: CODE_EXTENSIONS,
    allowedBasenames: CODE_BASENAMES,
    maxDepth: 12,
    redactInputs: true,
    snapshotKind: "git",
  }),
  folder: Object.freeze({
    extensions: CODE_EXTENSIONS,
    allowedBasenames: CODE_BASENAMES,
    maxDepth: 10,
    redactInputs: true,
    snapshotKind: "folder",
  }),
});

const HARNESS_SKILL_ROOTS = Object.freeze([
  ".agents/skills",
  ".claude/skills",
  ".codex/skills",
  ".cursor/skills",
  ".gemini/skills",
  ".hermes/skills",
  ".openclaw/skills",
]);
const HARNESS_PLUGIN_ROOTS = Object.freeze([
  ".claude/plugins",
  ".codex/plugins",
  ".cursor/extensions",
  ".gemini/extensions",
  ".hermes/plugins",
  ".openclaw/plugins",
]);
const HARNESS_MCP_FILES = Object.freeze([
  ".claude/mcp.json",
  ".claude/settings.json",
  ".cursor/mcp.json",
  ".gemini/settings.json",
  ".hermes/config.yaml",
  ".hermes/config.yml",
  ".mcp.json",
]);
const HARNESS_MCP_ROOTS = Object.freeze([
  ".claude/mcp-configs",
  ".cursor/mcp-configs",
  ".gemini/mcp-configs",
  ".hermes/mcp-configs",
]);
const HARNESS_DOC_FILES = Object.freeze(["AGENTS.md", "CLAUDE.md", ".claude/CLAUDE.md"]);
const STRUCTURE_BASENAMES = new Set(HARNESS_BASENAMES.map((name) => name.toLowerCase()));

class TargetUnavailableError extends Error {}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function portableAbsolute(value) {
  return path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:/.test(value);
}

function canonicalDirectory(candidate, boundary) {
  const expected = path.resolve(candidate);
  try {
    const stat = fs.lstatSync(expected);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    const real = fs.realpathSync(expected);
    if (!samePath(real, expected)) return null;
    if (boundary && (!inside(boundary, expected) || !inside(boundary, real))) return null;
    return expected;
  } catch {
    return null;
  }
}

function canonicalEntry(candidate, boundary) {
  const expected = path.resolve(candidate);
  try {
    const stat = fs.lstatSync(expected);
    if ((!stat.isDirectory() && !stat.isFile()) || stat.isSymbolicLink()) return null;
    if (stat.isFile() && stat.nlink !== 1) return null;
    const real = fs.realpathSync(expected);
    if (!samePath(real, expected) || !inside(boundary, expected) || !inside(boundary, real)) return null;
    return expected;
  } catch {
    return null;
  }
}

function canonicalHome(ctx) {
  const source = ctx && typeof ctx === "object" ? ctx : {};
  const env = source.env && typeof source.env === "object" ? source.env : process.env;
  const requested = source.homeDir || env.HOME || "/data/home/agent";
  if (typeof requested !== "string" || !path.isAbsolute(requested)) {
    throw new Error("Graphify HOME must be a real non-symlink directory");
  }
  const home = canonicalDirectory(requested);
  if (!home) throw new Error("Graphify HOME must be a real non-symlink directory");
  return { source, env, home };
}

function relativeSegments(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 240
    || value.includes("\\") || value.includes("\0") || portableAbsolute(value)
    || /[*?[\]{}!]/.test(value)) return null;
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === "." || normalized.startsWith("../")) return null;
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".."
    || /[<>:"|\u0000-\u001f\u007f]/.test(segment))) return null;
  return segments;
}

function validLabel(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 80
    && value.trim() === value && !/[\\/\u0000-\u001f\u007f]/.test(value);
}

function parseNamedCorpora(raw) {
  const text = raw === undefined || raw === null || raw === "" ? "[]" : String(raw);
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new Error("Graphify configured corpus JSON is invalid"); }
  if (!Array.isArray(parsed) || parsed.length > 50) {
    throw new Error("Graphify configured corpus JSON must be an array of at most 50 entries");
  }
  const ids = new Set();
  return parsed.map((entry, index) => {
    const position = index + 1;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || typeof entry.id !== "string" || !NAMED_ID_RE.test(entry.id)) {
      throw new Error(`Graphify configured corpus ${position} has an unsafe id`);
    }
    if (!validLabel(entry.label)) {
      throw new Error(`Graphify configured corpus ${position} has an unsafe label`);
    }
    const segments = relativeSegments(entry.path);
    if (!segments) throw new Error(`Graphify configured corpus ${position} has an unsafe relative path`);
    if (ids.has(entry.id)) throw new Error(`Graphify configured corpus ${position} duplicates an id`);
    ids.add(entry.id);
    return { id: entry.id, label: entry.label, segments };
  });
}

function configuredRepositories(raw) {
  return [...new Set(String(raw || "").split(",")
    .map((entry) => entry.trim())
    .filter(safeRepositoryName))];
}

function safeRepositoryName(value) {
  if (!REPO_RE.test(value)) return false;
  return value.split("/").every((segment) => segment !== "." && segment !== ".." && !/[. ]$/.test(segment));
}

function definitionRegistry(ctx) {
  const { source, env, home } = canonicalHome(ctx);
  const reposRaw = source.reposEnv === undefined ? env.REPOS : source.reposEnv;
  const corporaRaw = source.corporaJson === undefined
    ? env.AGENTHOST_GRAPHIFY_CORPORA_JSON
    : source.corporaJson;
  const repositories = configuredRepositories(reposRaw);
  const basenameCounts = new Map();
  for (const repo of repositories) {
    const basename = repo.split("/")[1].toLowerCase();
    basenameCounts.set(basename, (basenameCounts.get(basename) || 0) + 1);
  }

  const definitions = [
    {
      id: "harness",
      label: "Agent harness",
      kind: "harness",
      policy: POLICIES.harness,
      sourceSegments: [],
      boundarySegments: [],
      folderStrategy: "harness",
    },
    {
      id: "vault",
      label: "Obsidian vault",
      kind: "vault",
      policy: POLICIES.vault,
      sourceSegments: ["OneDrive", "Documents", "Obsidian Vault"],
      boundarySegments: [],
      folderStrategy: "directory",
    },
  ];

  for (const repo of [...repositories].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))) {
    const basename = repo.split("/")[1];
    definitions.push({
      id: `repo:${repo}`,
      label: repo,
      kind: "repo",
      policy: POLICIES.repository,
      sourceSegments: ["work", basename],
      boundarySegments: ["work"],
      folderStrategy: "directory",
      repository: repo,
      ambiguous: basenameCounts.get(basename.toLowerCase()) !== 1,
    });
  }

  const named = parseNamedCorpora(corporaRaw)
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const entry of named) {
    definitions.push({
      id: `folder:${entry.id}`,
      label: entry.label,
      kind: "folder",
      policy: POLICIES.folder,
      sourceSegments: ["corpora", ...entry.segments],
      boundarySegments: ["corpora"],
      folderStrategy: "single",
    });
  }
  return { home, definitions };
}

function targetUnavailable(definition, cause) {
  throw new TargetUnavailableError(`Graphify target "${definition.id}" is unavailable: ${cause}`);
}

function resolveDefinitionRoot(home, definition) {
  if (definition.ambiguous) {
    throw new TargetUnavailableError(
      `Graphify repository "${definition.repository}" has an ambiguous local folder name`,
    );
  }
  const boundary = path.resolve(home, ...definition.boundarySegments);
  const candidate = path.resolve(home, ...definition.sourceSegments);
  if (!inside(home, boundary) || !inside(boundary, candidate)) {
    return targetUnavailable(definition, "source root escaped its trusted boundary");
  }
  const root = canonicalDirectory(candidate, boundary);
  if (!root) return targetUnavailable(definition, "source root must be a real non-symlink directory");
  return root;
}

function folderId(targetId, relative) {
  const digest = crypto.createHash("sha256")
    .update("agenthost-graphify-folder\0")
    .update(targetId)
    .update("\0")
    .update(relative)
    .digest("hex")
    .slice(0, 24);
  return `f_${digest}`;
}

function safeDirectoryName(name) {
  return typeof name === "string" && name.length > 0 && name.length <= 80
    && !name.startsWith(".") && !/[\\/\u0000-\u001f\u007f]/.test(name)
    && !SKIPPED_DIRECTORY_NAMES.has(name.toLowerCase());
}

function sortedEntries(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.name.localeCompare(b.name));
  } catch {
    throw new TargetUnavailableError("Graphify source root cannot be read");
  }
}

function safeChildDirectories(root, limit) {
  const result = [];
  for (const entry of sortedEntries(root)) {
    if (result.length >= limit) break;
    if (!entry.isDirectory() || entry.isSymbolicLink() || !safeDirectoryName(entry.name)) continue;
    const candidate = canonicalDirectory(path.join(root, entry.name), root);
    if (candidate) result.push({ name: entry.name, path: candidate });
  }
  return result;
}

function directoryFolders(definition, root) {
  const folders = [{
    browser: { id: folderId(definition.id, "."), label: "All" },
    includeRoots: ["."],
  }];
  const topLevel = safeChildDirectories(root, MAX_TOP_LEVEL_CHOICES);
  for (const first of topLevel) {
    if (folders.length >= MAX_DIRECTORY_CHOICES) break;
    folders.push({
      browser: { id: folderId(definition.id, first.name), label: first.name },
      includeRoots: [first.name],
    });
    for (const second of safeChildDirectories(first.path, MAX_DIRECTORY_CHOICES)) {
      if (folders.length >= MAX_DIRECTORY_CHOICES) break;
      const relative = `${first.name}/${second.name}`;
      folders.push({
        browser: { id: folderId(definition.id, relative), label: `${first.name} — ${second.name}` },
        includeRoots: [relative],
      });
    }
  }
  return folders;
}

function safeRelativeEntry(root, relative) {
  const segments = relative.split("/");
  const candidate = canonicalEntry(path.resolve(root, ...segments), root);
  return candidate ? relative : null;
}

function existingSafeEntries(root, relatives) {
  return relatives.map((relative) => safeRelativeEntry(root, relative)).filter(Boolean);
}

function collectStructureInputs(root, baseRelative, output) {
  const base = safeRelativeEntry(root, baseRelative);
  if (!base) return;
  const basePath = path.resolve(root, ...base.split("/"));
  let baseStat;
  try { baseStat = fs.lstatSync(basePath); }
  catch { return; }
  if (baseStat.isFile()) {
    if (STRUCTURE_BASENAMES.has(path.basename(base).toLowerCase())) output.add(base);
    return;
  }

  const walk = (directory, relative, depth) => {
    if (depth > 4 || output.size >= MAX_STRUCTURE_INPUTS) return;
    let entries;
    try { entries = sortedEntries(directory); }
    catch { return; }
    for (const entry of entries) {
      if (output.size >= MAX_STRUCTURE_INPUTS) return;
      const childRelative = `${relative}/${entry.name}`;
      const child = canonicalEntry(path.join(directory, entry.name), root);
      if (!child || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (safeDirectoryName(entry.name)) walk(child, childRelative, depth + 1);
      } else if (entry.isFile() && STRUCTURE_BASENAMES.has(entry.name.toLowerCase())) {
        output.add(childRelative);
      }
    }
  };
  walk(basePath, base, 0);
}

// Must match GRAPHIFY_MAX_INCLUDE_ROOTS in graphify-lib.js. Kept here so a
// folder that the validator would reject is never offered in the first place.
const HARNESS_MAX_INCLUDE_ROOTS = 160;

function harnessInputGroups(root) {
  const skills = existingSafeEntries(root, HARNESS_SKILL_ROOTS);
  const plugins = new Set();
  for (const relative of HARNESS_PLUGIN_ROOTS) collectStructureInputs(root, relative, plugins);
  const mcp = new Set(existingSafeEntries(root, HARNESS_MCP_FILES));
  for (const relative of HARNESS_MCP_ROOTS) collectStructureInputs(root, relative, mcp);
  const docs = existingSafeEntries(root, HARNESS_DOC_FILES);
  return {
    skills: [...new Set(skills)].sort(),
    plugins: [...plugins].sort(),
    mcp: [...mcp].sort(),
    docs: [...new Set(docs)].sort(),
  };
}

function harnessFolders(definition, root) {
  const groups = harnessInputGroups(root);
  const all = [...new Set([...groups.docs, ...groups.skills, ...groups.plugins, ...groups.mcp])].sort();
  const candidates = [
    { browser: { id: "h_all", label: "All" }, includeRoots: all },
    { browser: { id: "h_skills", label: "Skills" }, includeRoots: groups.skills },
    { browser: { id: "h_plugins", label: "Plugins" }, includeRoots: groups.plugins },
    { browser: { id: "h_mcp", label: "MCP configs" }, includeRoots: groups.mcp },
  ];
  // Never OFFER a folder that cannot be graphed -- in EITHER direction.
  //
  // These roots are discovered from what is actually on the box, so the count
  // is whatever the operator happens to have. Both ends failed, and both failed
  // as the same unreadable string, "Graphify corpus include roots are invalid":
  //
  //   empty      a box with no skills/plugins/MCP/docs produced [] and the
  //              picker offered it anyway
  //   too broad  a WELL-STOCKED box overflows the 160-root cap. Live
  //              2026-08-15: Steve's "All" resolved to 168 -- his 333 skills
  //              and real plugins are on the box, and the message let him
  //              conclude they were never copied there.
  //
  // The second one is the worse failure: the tool told a correct operator that
  // his correct setup was invalid. A folder that cannot succeed must not be a
  // choice, and when none can, the target says why instead of appearing.
  const usable = candidates.filter((folder) =>
    folder.includeRoots.length > 0 && folder.includeRoots.length <= HARNESS_MAX_INCLUDE_ROOTS);
  if (!usable.length) {
    const widest = Math.max(...candidates.map((folder) => folder.includeRoots.length));
    targetUnavailable(definition, widest > HARNESS_MAX_INCLUDE_ROOTS
      ? `every harness folder on this box resolves to more than ${HARNESS_MAX_INCLUDE_ROOTS} folders (widest is ${widest})`
      : "this box has no harness skills, plugins, MCP configs or docs to map yet");
  }
  return usable;
}

const FOLDER_STRATEGIES = Object.freeze({
  directory: directoryFolders,
  harness: harnessFolders,
  single(definition) {
    return [{
      browser: { id: folderId(definition.id, "."), label: "All" },
      includeRoots: ["."],
    }];
  },
});

function foldersFor(definition, root) {
  const strategy = FOLDER_STRATEGIES[definition.folderStrategy];
  if (!strategy) throw new Error("Graphify corpus registry has an unknown folder strategy");
  try { return strategy(definition, root); }
  catch (error) {
    if (error instanceof TargetUnavailableError) targetUnavailable(definition, error.message.replace(/^Graphify\s+/i, ""));
    throw error;
  }
}

function browserTarget(definition, root) {
  const folders = foldersFor(definition, root);
  return {
    id: definition.id,
    label: definition.label,
    kind: definition.kind,
    folders: folders.map((folder) => ({ ...folder.browser })),
    defaultFolderId: folders[0].browser.id,
  };
}

function validTargetId(value) {
  return value === "harness" || value === "vault"
    || (typeof value === "string" && value.startsWith("repo:") && safeRepositoryName(value.slice(5)))
    || (typeof value === "string" && value.startsWith("folder:") && NAMED_ID_RE.test(value.slice(7)));
}

function validFolderId(value) {
  return typeof value === "string" && (DYNAMIC_FOLDER_ID_RE.test(value) || HARNESS_FOLDER_ID_RE.test(value));
}

function findDefinition(definitions, targetId) {
  if (targetId.startsWith("repo:")) {
    const requested = targetId.slice(5).toLowerCase();
    return definitions.find((definition) => definition.repository?.toLowerCase() === requested) || null;
  }
  return definitions.find((definition) => definition.id === targetId) || null;
}

function listGraphifyTargets(ctx) {
  const { home, definitions } = definitionRegistry(ctx);
  const targets = [];
  for (const definition of definitions) {
    try {
      const root = resolveDefinitionRoot(home, definition);
      targets.push(browserTarget(definition, root));
    } catch (error) {
      if (!(error instanceof TargetUnavailableError)) throw error;
    }
  }
  return targets;
}

function resolveGraphifyCorpus(ctx, input) {
  const targetId = input && typeof input === "object" ? input.targetId : undefined;
  const requestedFolderId = input && typeof input === "object" ? input.folderId : undefined;
  if (!validTargetId(targetId)) throw new Error("Graphify target id is invalid");
  if (!validFolderId(requestedFolderId)) throw new Error("Graphify folder id is invalid");

  const { home, definitions } = definitionRegistry(ctx);
  const definition = findDefinition(definitions, targetId);
  if (!definition) throw new Error(`Graphify target "${targetId}" is not configured`);
  const root = resolveDefinitionRoot(home, definition);
  const folders = foldersFor(definition, root);
  const selected = folders.find((folder) => folder.browser.id === requestedFolderId);
  if (!selected) throw new Error("Graphify folder choice is unavailable");
  if (selected.includeRoots.length < 1) {
    throw new Error(`Graphify folder "${selected.browser.label}" is unavailable: no safe input roots are present`);
  }

  return {
    target: { id: definition.id, label: definition.label, kind: definition.kind },
    folder: { ...selected.browser },
    sourceRoot: root,
    includeRoots: [...selected.includeRoots],
    extensions: [...definition.policy.extensions],
    allowedBasenames: [...definition.policy.allowedBasenames],
    maxDepth: definition.policy.maxDepth,
    redactInputs: definition.policy.redactInputs,
    snapshotKind: definition.policy.snapshotKind,
  };
}

module.exports = {
  listGraphifyTargets,
  resolveGraphifyCorpus,
};
