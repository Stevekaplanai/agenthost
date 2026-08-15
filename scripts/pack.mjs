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
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { minimalChildEnv } from "../src/child-env.js";
import {
  EXCLUDE_NAMES, EXCLUDE_NAME_RE, EXCLUDE_DIRECTORY_NAME_RE,
  EXCLUDE_STRUCTURED_CARRIER_FILE_RE, AGENT_BACKUP_NAME_RE,
  PROCESS_JSON, STALE_PATH_RE, SECRET_SHAPES,
  scrubAndTranslate, scanMcpConfig, pruneUnportableHooks,
  jsonContainsCredentialValues,
  matchesHermesExclude,
  matchesCodexExclude, packOpenclawConfig,
} from "./pack-lib.mjs";

const args = process.argv.slice(2);
const retiredCredentialMigrationFlag = args.find((arg) =>
  ["--with-whatsapp", "--migrate-auth", "--hermes-secrets-from-local"].some(
    (flag) => arg === flag || arg.startsWith(`${flag}=`)
  )
);
if (retiredCredentialMigrationFlag) {
  console.error(
    `${retiredCredentialMigrationFlag.split("=")[0]} is retired: credential files never migrate. `
    + "Authenticate again on the box or set selected values explicitly as Fly secrets."
  );
  process.exit(1);
}
const outDir = args.includes("--out") ? args[args.indexOf("--out") + 1] : path.join(os.tmpdir(), "agenthost-pack");
const dryRun = args.includes("--dry-run");
// --include <path> (repeatable): extra dirs/files to migrate -- Obsidian vaults,
// hook-script projects, anything your harness reaches for outside ~/.claude.
// Must live under the home directory (that's the only path we can translate).
const includes = [];
for (let i = 0; i < args.length; i++) if (args[i] === "--include") includes.push(args[i + 1]);
// Hermes: packed AUTOMATICALLY when a ~/.hermes harness exists (multi-agent is
// the product -- the migration should pull every engine the developer actually
// runs, not hide Hermes behind a flag). `--agent hermes` still forces it on
// (back-compat / when HERMES_HOME points at a WSL path); `--no-hermes` opts out.
const packHermes = !args.includes("--no-hermes") && (
  (args.includes("--agent") && args[args.indexOf("--agent") + 1] === "hermes")
  || fs.existsSync(process.env.HERMES_HOME || path.join(os.homedir(), ".hermes"))
);
// --hermes-only: pack ONLY the Hermes harness, skipping the ~/.claude bulk.
// Use when ADDING Hermes to a box whose Claude harness is already set up and
// must not be overwritten (the tarball extracts as an overlay onto $HOME, so
// packing .claude would replace the box's copy). Implies --agent hermes.
const hermesOnly = args.includes("--hermes-only");
// Hermes safe optional payload (see the "## Hermes" report section):
const withKanban = args.includes("--with-kanban");
// --pack <name> (repeatable): preload a curated AgentHost pack from the repo's
// packs/<name>/ into the staged harness. Packs are our own vetted content; they
// ride the same tarball. skills/ land at ~/.claude/skills/, agents/ at
// ~/.claude/agents/, and mode files (MODE.md, mode.toml) at ~/.claude/modes/<name>/.
const packNames = [];
for (let i = 0; i < args.length; i++) if (args[i] === "--pack") packNames.push(args[i + 1]);

const HOME = os.homedir();
const SRC = path.join(HOME, ".claude");
const CLOUD_HOME = "/data/home/agent";
const STAGING_ROOT = path.join(outDir, "staging");
// Codex + OpenClaw sources: packed automatically when present (multi-agent),
// each with an opt-out. HOME overrides let the CLI point at a non-default root.
const CODEX_SRC = process.env.CODEX_HOME || path.join(HOME, ".codex");
const packCodex = !args.includes("--no-codex") && !hermesOnly && fs.existsSync(CODEX_SRC);
const OPENCLAW_SRC = process.env.OPENCLAW_HOME || path.join(HOME, ".openclaw");
const packOpenclaw = !args.includes("--no-openclaw") && !hermesOnly && fs.existsSync(OPENCLAW_SRC);
const STAGING = path.join(STAGING_ROOT, ".claude");

// ---- The manifest -----------------------------------------------------------
const INCLUDE_FILES = ["CLAUDE.md", "settings.json", "keybindings.json", "mcp.json"];
const INCLUDE_DIRS = ["skills", "agents", "commands", "rules", "hooks", "scripts", "mcp-configs"];
// JSON configs that get parsed, scrubbed of secrets, and path-translated:
// (constants + pure logic live in pack-lib.mjs: EXCLUDE_NAMES, PROCESS_JSON, WINPATH_RE, SECRET_SHAPES, REDACTED)

const report = {
  included: [], excluded: [], translated: [], flags: [], mcp: [],
  redactedSecrets: [], possibleSecrets: [], nonHomeWindowsPaths: [],
  securityOmissions: [],
  totalBytes: 0, fileCount: 0,
};

// ---- copy with filename-level filtering -------------------------------------
// extraExclude: optional per-agent predicate (e.g. matchesHermesExclude),
// applied ON TOP of the global EXCLUDE_NAMES -- never instead of it.
// root: the top-level dir this copy started from; defaults to `src` on the
// first call and is threaded unchanged through recursion, so it marks the
// boundary of the tree we're allowed to pack (see the symlink check below).
// forbidAgentRoots is used only by --include: agent harness roots must pass
// through their dedicated allowlists, even when a parent directory is included.
const GENERIC_SENSITIVE_ROOTS = new Set([
  "appdata", ".ssh", ".aws", ".gnupg", ".kube", ".docker", ".azure", ".fly",
]);
const GENERIC_SENSITIVE_PATHS = [
  [".config", "gh"],
  [".config", "gcloud"],
  [".config", "fly"],
  [".local", "share", "keyrings"],
];
function isGenericSensitiveFile(name) {
  const lower = name.toLowerCase();
  return lower.startsWith(".env")
    || lower.endsWith(".env")
    || lower === "kubeconfig"
    || lower.endsWith(".kubeconfig")
    || lower.endsWith(".tfstate")
    || lower === ".npmrc" || lower === ".netrc" || lower === ".pypirc"
    || lower === ".pgpass" || lower === ".curlrc"
    || lower === ".terraformrc" || lower === ".gitconfig"
    || lower === ".wgetrc" || lower === ".yarnrc"
    || /^id_.+/i.test(name)
    || /\.(?:pem|key|p12|pfx|jks|keystore|kdbx|gpg|pgp)$/i.test(name);
}
function hasGenericSensitiveStorePath(parts) {
  const lower = parts.map((part) => part.toLowerCase());
  if (lower.some((part) => GENERIC_SENSITIVE_ROOTS.has(part))) return true;
  return GENERIC_SENSITIVE_PATHS.some((needle) =>
    lower.some((_, index) => needle.every((part, offset) => lower[index + offset] === part))
  );
}
function hasGenericSensitivePath(parts) {
  return hasGenericSensitiveStorePath(parts)
    || parts.some((part) => isGenericSensitiveFile(part));
}
const EXCLUDE_NAMES_LOWER = new Set([...EXCLUDE_NAMES].map((name) => name.toLowerCase()));
const SECURITY_EXCLUDE_NAMES = new Set([
  ".claude.json", ".credentials.json", "credentials.json", "auth.json",
  ".npmrc", ".netrc", ".pypirc",
]);
const SAFE_SOURCE_DOC_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".css", ".cts", ".dart", ".fish", ".go", ".h", ".hpp",
  ".html", ".java", ".js", ".jsx", ".kt", ".kts", ".md", ".mdx", ".mjs", ".mts",
  ".php", ".ps1", ".py", ".rb", ".rs", ".rst", ".scss", ".sh", ".sql", ".svelte",
  ".swift", ".ts", ".tsx", ".vue", ".zsh",
]);
const STRUCTURED_CONFIG_EXTENSIONS = new Set([
  ".json", ".yaml", ".yml", ".toml", ".hcl", ".conf", ".config", ".cnf", ".ini",
  ".cfg", ".properties", ".tfvars", ".xml", ".plist", ".jsonc", ".json5",
]);
const PARSERLESS_CONFIG_EXTENSIONS = new Set(
  [...STRUCTURED_CONFIG_EXTENSIONS].filter((ext) => ext !== ".json")
);
const NESTED_ARCHIVE_RE =
  /\.(?:zip|jar|war|ear|whl|egg|apk|ipa|xpi|cab|7z|rar|tar|tgz|tar\.gz|tar\.bz2|tar\.xz|gz|bz2|xz|zst)$/i;
const ZIP_MAGIC = [
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from([0x50, 0x4b, 0x05, 0x06]),
  Buffer.from([0x50, 0x4b, 0x07, 0x08]),
  Buffer.from([0x50, 0x4b, 0x01, 0x02]),
];
const SEVEN_ZIP_MAGIC = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
const RAR_MAGIC = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]);
const CAB_MAGIC = Buffer.from([0x4d, 0x53, 0x43, 0x46, 0x00, 0x00, 0x00, 0x00]);
const ARCHIVE_MAGIC_PREFIXES = [
  Buffer.from([0x1f, 0x8b]),                         // gzip
  SEVEN_ZIP_MAGIC,                                   // 7z
  RAR_MAGIC,                                         // RAR 4/5
  Buffer.from([0x42, 0x5a, 0x68]),                   // bzip2
  Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]), // xz
  Buffer.from([0x28, 0xb5, 0x2f, 0xfd]),             // zstd
  Buffer.from("070701"),                              // cpio newc
  Buffer.from("070702"),                              // cpio newc CRC
  Buffer.from("070707"),                              // cpio portable ASCII
  Buffer.from([0x71, 0xc7]),                         // cpio binary
  Buffer.from([0xc7, 0x71]),                         // cpio binary, swapped
  Buffer.from("!<arch>\n"),                           // ar
  Buffer.from("MSCF"),                                // Windows CAB
];
function bufferHasTarHeader(buffer) {
  if (buffer.length < 512) return false;
  if (buffer.subarray(257, 262).equals(Buffer.from("ustar"))) return true;
  const checksumText = buffer.subarray(148, 156)
    .toString("ascii")
    .replace(/\0.*$/, "")
    .trim();
  if (!/^[0-7]{1,7}$/.test(checksumText)) return false;
  let checksum = 0;
  for (let i = 0; i < 512; i++) {
    checksum += i >= 148 && i < 156 ? 0x20 : buffer[i];
  }
  return checksum === Number.parseInt(checksumText, 8);
}
function bufferHasNestedArchiveMagic(buffer) {
  if (ARCHIVE_MAGIC_PREFIXES.some((magic) =>
    buffer.length >= magic.length && buffer.subarray(0, magic.length).equals(magic)
  )) return true;
  if ([...ZIP_MAGIC, SEVEN_ZIP_MAGIC, RAR_MAGIC, CAB_MAGIC]
    .some((magic) => buffer.indexOf(magic) !== -1)) return true;
  return bufferHasTarHeader(buffer);
}
function fileHasNestedArchiveMagic(file, size) {
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(Math.min(size, 1024 * 1024));
  try {
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return bufferHasNestedArchiveMagic(buffer.subarray(0, bytesRead));
  } finally {
    fs.closeSync(fd);
  }
}
const OPAQUE_STATE_FILE_RE =
  /^(?:(?:config|settings?|state)(?:[._-].*)?\.(?:bin|dat)|.*\.(?:db|db3|s3db|sl3|ldb|mdb|lmdb|rdb|dbm|gdbm|ndb|bdb|kdb|nedb|leveldb|rocksdb|duckdb|realm|sqlite3?|aof|sst))(?:-(?:shm|wal|journal|lock)|\.(?:shm|wal|journal|lock|log|tmp))?$/i;
const RUNTIME_CARRIER_DIRECTORY_RE =
  /^(?:api[._-]?keys?|(?:private|signing)[._-]?keys?|keystores?|tokens?|sessions?|credentials?|creds?|passwords?|secrets?|keyrings?|keychains?|cookies?|history|whatsapp|pairing)(?:[._-].*)?$/i;
const COMMON_BACKUP_SUFFIX_RE =
  /(?:\.(?:bak|backup|old|orig|save|sw[opn]|tmp|copy|rej)(?:\d+|[._-][A-Za-z0-9._-]*)?|\.un~)$/i;
function normalizeSensitiveName(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9.]+/g, "-");
}
function isBackupName(name) {
  return name.endsWith("~")
    || /^#.*#$/.test(name)
    || COMMON_BACKUP_SUFFIX_RE.test(name);
}
function isAlwaysUnsafeName(name) {
  const normalized = normalizeSensitiveName(name);
  const lower = normalized.toLowerCase();
  const rawLower = name.toLowerCase();
  return isBackupName(name)
    || EXCLUDE_NAMES_LOWER.has(rawLower)
    || EXCLUDE_NAMES_LOWER.has(lower)
    || AGENT_BACKUP_NAME_RE.test(normalized)
    || /^login[._-]?data(?:[._-].*)?$/i.test(normalized);
}
function isSecurityUnsafeName(name) {
  const normalized = normalizeSensitiveName(name);
  const rawLower = name.toLowerCase();
  return isBackupName(name)
    || SECURITY_EXCLUDE_NAMES.has(rawLower)
    || SECURITY_EXCLUDE_NAMES.has(normalized.toLowerCase())
    || AGENT_BACKUP_NAME_RE.test(normalized)
    || /^login[._-]?data(?:[._-].*)?$/i.test(normalized);
}
function hasCarrierRole(name) {
  const normalized = normalizeSensitiveName(name);
  return EXCLUDE_NAME_RE.test(normalized)
    || EXCLUDE_DIRECTORY_NAME_RE.test(normalized)
    || EXCLUDE_STRUCTURED_CARRIER_FILE_RE.test(normalized);
}
function isSafeSourceOrDoc(name) {
  return !isBackupName(name)
    && SAFE_SOURCE_DOC_EXTENSIONS.has(path.extname(name).toLowerCase());
}
function isOpaqueStateFile(name) {
  const normalized = normalizeSensitiveName(name);
  return OPAQUE_STATE_FILE_RE.test(normalized);
}
function isNestedArchive(name) {
  return NESTED_ARCHIVE_RE.test(name);
}
function isParserlessConfig(name) {
  return PARSERLESS_CONFIG_EXTENSIONS.has(path.extname(name).toLowerCase());
}
function addSecurityOmission(source, reason) {
  const rel = path.relative(HOME, source).split(path.sep).join("/");
  const item = { path: rel || path.basename(source), reason };
  if (!report.securityOmissions.some((entry) =>
    entry.path === item.path && entry.reason === item.reason
  )) {
    report.securityOmissions.push(item);
  }
}
const PROTECTED_AGENT_ROOTS = new Set([
  ".claude", ".codex", ".hermes", ".openclaw", ".gemini", ".kimi",
]);
function copyFiltered(
  src,
  dest,
  extraExclude = null,
  root = src,
  forbidAgentRoots = false,
  trustedPackageRoot = false,
  allowHermesKanban = false,
) {
  const base = path.basename(src);
  // lstat (not stat) so a symlink is inspected as a link, not its target. A
  // symlink whose target is missing (dangling -- common when a WSL harness is
  // read through a Windows \\wsl.localhost mount, where relative link targets
  // don't traverse) must be skipped with a warning, never crash the whole pack.
  let ls;
  try { ls = fs.lstatSync(src); }
  catch (e) { report.flags.push(`skipped (lstat failed): ${path.relative(HOME, src)} (${e.code || e.message})`); return false; }
  if (ls.isSymbolicLink() && !fs.existsSync(src)) {
    report.flags.push(`dangling symlink skipped: ${path.relative(HOME, src)} -> ${(() => { try { return fs.readlinkSync(src); } catch { return "?"; } })()}`);
    addSecurityOmission(src, "dangling symlink cannot be audited");
    return false;
  }
  // realpath every component, not just POSIX symlinks. Windows directory
  // junctions can otherwise be reported as ordinary directories and escape
  // the dedicated Claude/Hermes allowlist.
  let real;
  let rootReal;
  try {
    real = fs.realpathSync(src);
    rootReal = fs.realpathSync(root);
  } catch (e) {
    report.flags.push(`skipped (path unresolvable): ${path.relative(HOME, src)} (${e.code || e.message})`);
    return false;
  }
  const realRelToRoot = path.relative(rootReal, real);
  if (
    realRelToRoot === ".."
    || realRelToRoot.startsWith(".." + path.sep)
    || path.isAbsolute(realRelToRoot)
  ) {
    report.flags.push(`external symlink or junction skipped (target outside packed tree): ${path.relative(HOME, src)} -> ${real}`);
    addSecurityOmission(src, "external symlink or junction target is outside the packed tree");
    return false;
  }
  let st;
  try { st = fs.statSync(src); }
  catch (e) { report.flags.push(`skipped (stat failed): ${path.relative(HOME, src)} (${e.code || e.message})`); return false; }
  if (st.isFile() && st.nlink > 1) {
    const rel = path.relative(SRC, src);
    const label = rel.startsWith("..") ? path.relative(HOME, src) : rel;
    report.excluded.push(label);
    report.flags.push(`hard-linked file skipped (credential alias cannot be ruled out): ${label}`);
    addSecurityOmission(src, "hard-linked file may alias credential material");
    return false;
  }

  const partsUnderHome = (candidate) => {
    const rel = path.relative(HOME, path.resolve(candidate));
    return rel === "" || rel.startsWith("..") || path.isAbsolute(rel) ? [] : rel.split(path.sep);
  };
  const partsUnderRoot = (candidate, boundary) => {
    const rel = path.relative(path.resolve(boundary), path.resolve(candidate));
    return rel === "" || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)
      ? []
      : rel.split(path.sep);
  };
  const sourceParts = partsUnderHome(src);
  const realParts = partsUnderHome(real);
  const rootSourceParts = partsUnderRoot(src, root);
  const rootRealParts = partsUnderRoot(real, rootReal);
  const relativeNames = [
    base,
    path.basename(real),
    ...rootSourceParts,
    ...rootRealParts,
  ].filter(Boolean);
  const directoryNames = [
    ...partsUnderRoot(path.dirname(src), root),
    ...partsUnderRoot(path.dirname(real), rootReal),
    ...(st.isDirectory() ? [base, path.basename(real)] : []),
  ];
  const carrierDirectoryNames = trustedPackageRoot
    ? directoryNames
    : [
      ...directoryNames,
      ...sourceParts.slice(0, -1),
      ...realParts.slice(0, -1),
    ];
  const leafNames = [base, path.basename(real)];
  const knownScrubbableJson = st.isFile()
    && path.extname(base).toLowerCase() === ".json"
    && (
      (
        path.resolve(root) === path.resolve(SRC)
        && (
          PROCESS_JSON.includes(rootSourceParts.join("/"))
          || rootSourceParts[0]?.toLowerCase() === "mcp-configs"
        )
      )
      || (
        extraExclude === matchesHermesExclude
        && rootSourceParts.join("/").toLowerCase() === "channel_directory.json"
      )
    );
  const alwaysUnsafe = relativeNames.some(isAlwaysUnsafeName);
  const securityAlwaysUnsafe = relativeNames.some(isSecurityUnsafeName);
  const leafCarrier = leafNames.some(hasCarrierRole);
  const runtimeCarrierDirectory = carrierDirectoryNames
    .map(normalizeSensitiveName)
    .some((name) => RUNTIME_CARRIER_DIRECTORY_RE.test(name));
  const directoryCarrier = carrierDirectoryNames.some(hasCarrierRole);
  const unsafeCarrier = st.isFile()
    && (
      (!leafNames.every(isSafeSourceOrDoc) && (leafCarrier || directoryCarrier))
      || runtimeCarrierDirectory
      || (leafCarrier && directoryCarrier)
    );
  const unsupportedStructuredConfig = st.isFile()
    && !knownScrubbableJson
    && leafNames.some(isParserlessConfig);
  const samePath = (left, right) =>
    path.relative(path.resolve(left), path.resolve(right)) === "";
  const governedHermesKanban = allowHermesKanban
    && st.isFile()
    && !ls.isSymbolicLink()
    && samePath(root, HERMES_SRC)
    && samePath(src, path.join(HERMES_SRC, "kanban.db"))
    && samePath(real, path.join(rootReal, "kanban.db"));
  const opaqueStateFile = (st.isFile() || st.isDirectory())
    && !governedHermesKanban
    && leafNames.some(isOpaqueStateFile);
  let nestedArchive = st.isFile() && leafNames.some(isNestedArchive);
  if (st.isFile() && !nestedArchive) {
    try {
      nestedArchive = fileHasNestedArchiveMagic(src, st.size);
    } catch {
      report.flags.push(`file signature unreadable, skipped: ${path.relative(HOME, src)}`);
      nestedArchive = true;
    }
  }
  const agentRootExcluded = forbidAgentRoots
    && [...sourceParts, ...realParts, ...rootSourceParts, ...rootRealParts]
      .some((name) => PROTECTED_AGENT_ROOTS.has(name.toLowerCase()));
  // Security checks are relative to the explicitly packed root. This avoids
  // rejecting a dedicated Hermes harness merely because its parent is
  // %LOCALAPPDATA%, while still catching .env/.ssh/key material nested inside
  // that harness (including when HERMES_HOME is an external WSL/UNC path).
  const sensitiveSourceParts = [base, ...rootSourceParts];
  const sensitiveRealParts = [path.basename(real), ...rootRealParts];
  const genericSensitive = hasGenericSensitivePath(sensitiveSourceParts)
    || hasGenericSensitivePath(sensitiveRealParts);
  const agentSpecificExcluded = extraExclude
    && relativeNames.some((name) => extraExclude(name));
  if (
    alwaysUnsafe
    || unsafeCarrier
    || unsupportedStructuredConfig
    || opaqueStateFile
    || nestedArchive
    || agentRootExcluded
    || genericSensitive
    || agentSpecificExcluded
  ) {
    // Report home-relative for anything outside ~/.claude (.hermes, --include)
    const rel = path.relative(SRC, src);
    report.excluded.push(rel.startsWith("..") ? path.relative(HOME, src) : rel);
    if (unsupportedStructuredConfig) {
      report.flags.push(
        `structured config skipped (no safe parser; recreate on the box): ${path.relative(HOME, src)}`
      );
    }
    if (securityAlwaysUnsafe) {
      addSecurityOmission(src, "credential/session filename or backup");
    } else if (unsafeCarrier) {
      addSecurityOmission(src, "credential/session carrier path");
    } else if (unsupportedStructuredConfig) {
      addSecurityOmission(src, "structured config has no safe parser");
    } else if (opaqueStateFile) {
      addSecurityOmission(src, "opaque config/state database cannot be audited");
    } else if (nestedArchive) {
      addSecurityOmission(src, "nested archive contents cannot be audited");
    } else if (genericSensitive) {
      addSecurityOmission(src, "sensitive credential-store path");
    } else if (agentRootExcluded) {
      addSecurityOmission(src, "agent harness must use its dedicated safe allowlist");
    }
    return false;
  }

  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    let copied = false;
    for (const entry of fs.readdirSync(src).sort()) {
      copied = copyFiltered(
        path.join(src, entry),
        path.join(dest, entry),
        extraExclude,
        root,
        forbidAgentRoots,
        trustedPackageRoot,
        allowHermesKanban,
      ) || copied;
    }
    if (!copied) fs.rmSync(dest, { recursive: true, force: true });
    return copied;
  } else if (st.isFile()) {
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      const after = fs.statSync(src);
      if (
        after.nlink > 1
        || after.dev !== st.dev
        || after.ino !== st.ino
      ) {
        fs.rmSync(dest, { force: true });
        report.flags.push(`source changed or became hard-linked during copy; staged copy removed: ${path.relative(HOME, src)}`);
        addSecurityOmission(src, "source changed or became hard-linked during copy");
        return false;
      }
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
      return true;
    } catch (e) {
      report.flags.push(`unreadable, skipped: ${path.relative(SRC, src)} (${e.code || e.message})`);
      return false;
    }
  }
  return false;
}

// ---- JSON-aware scrub + path translation -------------------------------------
// Walks parsed JSON. Never does whole-file string surgery, so unrelated values
// (regexes, escaped strings, non-path backslashes) are never touched.
const HOME_VARIANTS = [HOME, HOME.replace(/\\/g, "/"), HOME.replace(/\\/g, "\\\\")];

function omitStagedFile(file, label, reason) {
  const size = fs.statSync(file).size;
  fs.rmSync(file, { force: true });
  report.totalBytes = Math.max(0, report.totalBytes - size);
  report.fileCount = Math.max(0, report.fileCount - 1);
  report.included = report.included.filter((entry) => entry !== label);
  report.flags.push(`${label}: ${reason}; omitted from the pack`);
  const omissionPath = path.relative(STAGING_ROOT, file).split(path.sep).join("/");
  if (!report.securityOmissions.some((entry) => entry.path === omissionPath)) {
    report.securityOmissions.push({ path: omissionPath, reason });
  }
}

function processJsonConfig(file, label) {
  if (!fs.existsSync(file)) return false;
  let obj;
  try { obj = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch {
    omitStagedFile(file, label, "could not parse invalid JSON");
    return false;
  }
  const stats = { translated: 0, nonHome: [] };
  const cleaned = scrubAndTranslate(obj, label, "", stats, HOME_VARIANTS, CLOUD_HOME, report);
  fs.writeFileSync(file, JSON.stringify(cleaned, null, 2));
  if (stats.translated > 0) report.translated.push(`${label} (${stats.translated} values)`);
  for (const p of stats.nonHome) report.nonHomeWindowsPaths.push(`${label}: ${p}`);
  return true;
}

// ---- generic secret scan for everything else ---------------------------------
const MAX_SECRET_SCAN_BYTES = 8 * 1024 * 1024;
const INLINE_CREDENTIAL_SHAPES = [
  [
    "credential-url-parameter",
    /[?&#](?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|credential|authorization|auth|oauth|session|cookie|pairing)=[^&#\s"'<>]+/i,
  ],
  [
    "credential-uri-userinfo",
    /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/@\s<]+@/,
  ],
  [
    "credential-header-literal",
    /(?:^|[\r\n"' ])(?:authorization|proxy-authorization)\s*:\s*(?:basic|bearer)\s+\S+/i,
  ],
];
const INLINE_AUDIT_EXTENSIONS = new Set([
  ".json", ".jsonc", ".json5", ".yaml", ".yml", ".toml", ".conf", ".ini",
  ".cfg", ".properties", ".xml", ".plist",
]);
function findPackedContentFindings(content, entryName) {
  const findings = [];
  if (bufferHasNestedArchiveMagic(content)) findings.push("nested-archive-signature");
  const text = content.toString("utf8");
  for (const [shapeName, re] of SECRET_SHAPES) {
    if (re.test(text)) findings.push(shapeName);
  }
  if (INLINE_AUDIT_EXTENSIONS.has(path.extname(entryName).toLowerCase())) {
    for (const [shapeName, re] of INLINE_CREDENTIAL_SHAPES) {
      if (re.test(text)) findings.push(shapeName);
    }
  }
  return [...new Set(findings)];
}

function omitSuspiciousPackedFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      omitSuspiciousPackedFiles(p);
      continue;
    }
    if (!entry.isFile()) continue;
    const label = path.relative(STAGING_ROOT, p).split(path.sep).join("/");
    const stat = fs.statSync(p);
    if (stat.size > MAX_SECRET_SCAN_BYTES) {
      omitStagedFile(
        p,
        label,
        `file exceeds the ${MAX_SECRET_SCAN_BYTES}-byte secret-audit limit`,
      );
      continue;
    }
    let content;
    try {
      content = fs.readFileSync(p);
    } catch {
      omitStagedFile(p, label, "file could not be read for the final secret audit");
      continue;
    }
    const findings = findPackedContentFindings(content, entry.name);
    if (findings.length) {
      omitStagedFile(
        p,
        label,
        `high-confidence credential/container pattern(s): ${findings.join(", ")}`,
      );
    }
  }
}

function scanForSecrets(
  dir,
  root = dir,
  seenInodes = new Map(),
  labelPrefix = "",
  fingerprint = null,
) {
  for (const entry of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, entry);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      scanForSecrets(p, root, seenInodes, labelPrefix, fingerprint);
    } else if (st.isFile()) {
      const rel = path.relative(root, p).split(path.sep).join("/");
      const precise = fs.statSync(p, { bigint: true });
      const inodeKey = precise.ino === 0n ? null : `${precise.dev}:${precise.ino}`;
      if (precise.nlink > 1n || (inodeKey && seenInodes.has(inodeKey))) {
        report.possibleSecrets.push(`${labelPrefix}${rel} (hard-link-alias)`);
      } else if (inodeKey) {
        seenInodes.set(inodeKey, rel);
      }
      if (st.size <= MAX_SECRET_SCAN_BYTES) {
        try {
          const content = fs.readFileSync(p);
          if (fingerprint) {
            fingerprint.update(`f\0${rel}\0`);
            fingerprint.update(createHash("sha256").update(content).digest("hex"));
          }
          for (const finding of findPackedContentFindings(content, entry)) {
            report.possibleSecrets.push(`${labelPrefix}${rel} (${finding})`);
          }
        } catch {
          report.possibleSecrets.push(`${labelPrefix}${rel} (unreadable-final-scan)`);
        }
      } else {
        report.possibleSecrets.push(`${labelPrefix}${rel} (unscanned-large-file)`);
      }
    }
  }
}

function hashFile(file) {
  const hash = createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function fingerprintTree(root) {
  const hash = createHash("sha256");
  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      const rel = path.relative(root, p).split(path.sep).join("/");
      if (entry.isDirectory()) {
        walk(p);
      } else if (entry.isFile()) {
        hash.update(`f\0${rel}\0`);
        hash.update(hashFile(p));
      } else {
        hash.update(`unsupported\0${rel}\0`);
      }
    }
  };
  walk(root);
  return hash.digest("hex");
}

function measureTree(root) {
  const totals = { files: 0, bytes: 0 };
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) {
        totals.files += 1;
        totals.bytes += fs.statSync(p).size;
      }
    }
  };
  walk(root);
  return totals;
}

function archiveEntryIsUnsafe(rawEntry) {
  const normalized = rawEntry.replaceAll("\\", "/").replace(/^(?:\.\/)+/, "");
  if (!normalized) return false;
  if (
    normalized.startsWith("/")
    || /^[A-Za-z]:/.test(normalized)
    || normalized.split("/").some((part) => part === "..")
  ) return true;
  const parts = normalized.split("/").filter(Boolean);
  const leaf = parts.at(-1) || "";
  const isDirectory = normalized.endsWith("/");
  const directoryNames = isDirectory ? parts : parts.slice(0, -1);
  const leafCarrier = hasCarrierRole(leaf);
  const directoryCarrier = directoryNames.some(hasCarrierRole);
  const runtimeCarrierDirectory = directoryNames
    .map(normalizeSensitiveName)
    .some((name) => RUNTIME_CARRIER_DIRECTORY_RE.test(name));
  const unsafeCarrier = !isDirectory && (
    (!isSafeSourceOrDoc(leaf) && (leafCarrier || directoryCarrier))
    || runtimeCarrierDirectory
    || (leafCarrier && directoryCarrier)
  );
  // Same exemption the staging omit pass grants: a mode.toml THIS run staged
  // from a curated pack is repo-vetted and already content-audited.
  const governedPackModeToml = !isDirectory && packModeTomlEntries.has(normalized);
  const unsupportedStructuredConfig = !isDirectory && isParserlessConfig(leaf) && !governedPackModeToml;
  const normalizedLower = normalized.toLowerCase();
  const isHermesKanbanPath = normalizedLower === ".hermes/kanban.db";
  const governedHermesKanban = withKanban
    && !isDirectory
    && isHermesKanbanPath;
  const invalidHermesKanbanEntry = (
    isHermesKanbanPath
    || normalizedLower.startsWith(".hermes/kanban.db/")
  ) && !governedHermesKanban;
  const opaqueStateFile = !isDirectory
    && !governedHermesKanban
    && isOpaqueStateFile(leaf);
  const nestedArchive = !isDirectory && isNestedArchive(leaf);
  return parts.some(isAlwaysUnsafeName)
    || unsafeCarrier
    || hasGenericSensitivePath(parts)
    || unsupportedStructuredConfig
    || invalidHermesKanbanEntry
    || opaqueStateFile
    || nestedArchive;
}

function isKnownScrubbableArchiveJson(rel) {
  const normalized = rel.replaceAll("\\", "/").replace(/^(?:\.\/)+/, "").toLowerCase();
  return [
    ".claude/settings.json",
    ".claude/keybindings.json",
    ".claude/mcp.json",
    ".hermes/channel_directory.json",
    ".openclaw/openclaw.json",
  ].includes(normalized)
    || (
      normalized.startsWith(".claude/mcp-configs/")
      && normalized.endsWith(".json")
    );
}

function auditArchiveJson(dir, root = dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      auditArchiveJson(p, root);
      continue;
    }
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".json") continue;
    const rel = path.relative(root, p).split(path.sep).join("/");
    if (!isKnownScrubbableArchiveJson(rel)) continue;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      report.possibleSecrets.push(`archive:${rel} (invalid-json)`);
      continue;
    }
    const auditReport = { redactedSecrets: [] };
    const auditStats = { translated: 0, nonHome: [] };
    const cleaned = scrubAndTranslate(
      parsed,
      `archive:${rel}`,
      "",
      auditStats,
      HOME_VARIANTS,
      CLOUD_HOME,
      auditReport,
    );
    if (JSON.stringify(cleaned) !== JSON.stringify(parsed)) {
      report.possibleSecrets.push(`archive:${rel} (unscrubbed-json-credential)`);
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
  if (fs.existsSync(p) && copyFiltered(p, path.join(STAGING, f), null, SRC)) {
    report.included.push(f);
  }
}
for (const d of hermesOnly ? [] : INCLUDE_DIRS) {
  const p = path.join(SRC, d);
  if (fs.existsSync(p) && copyFiltered(p, path.join(STAGING, d), null, SRC)) {
    report.included.push(d + "/");
  }
}
// Plugins: the installed set + marketplaces + plugin data, MINUS the
// regeneratable cache/ (re-downloaded on first use; shipping it is dead weight).
// Plugin manifests/configs still flow through the secret + stale-path scans.
const pluginsSrc = path.join(SRC, "plugins");
if (!hermesOnly && fs.existsSync(pluginsSrc)) {
  if (copyFiltered(pluginsSrc, path.join(STAGING, "plugins"), (base) => base === "cache", SRC)) {
    report.included.push("plugins/ (minus cache)");
  }
}

const projRoot = path.join(SRC, "projects");
if (!hermesOnly && fs.existsSync(projRoot)) {
  for (const slug of fs.readdirSync(projRoot)) {
    const mem = path.join(projRoot, slug, "memory");
    if (
      fs.existsSync(mem)
      && copyFiltered(mem, path.join(STAGING, "projects", slug, "memory"), null, SRC)
    ) {
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
  if (rel === "") {
    console.error("--include HOME is too broad; choose a narrower project or vault path");
    process.exit(1);
  }
  if (!fs.existsSync(abs)) {
    console.error(`--include path does not exist: ${inc}`);
    process.exit(1);
  }
  let homeReal;
  let includeReal;
  try {
    homeReal = fs.realpathSync(HOME);
    includeReal = fs.realpathSync(abs);
  } catch {
    console.error(`--include path could not be resolved safely: ${inc}`);
    process.exit(1);
  }
  const realRel = path.relative(homeReal, includeReal);
  if (realRel === ".." || realRel.startsWith(".." + path.sep) || path.isAbsolute(realRel)) {
    console.error(`--include resolves outside your home directory (got: ${inc})`);
    process.exit(1);
  }
  const relParts = rel.split(path.sep);
  const realRelParts = realRel.split(path.sep);
  if (hasGenericSensitivePath(relParts) || hasGenericSensitivePath(realRelParts)) {
    console.error(`--include points at a sensitive credential path; choose a narrower project or vault path (got: ${inc})`);
    process.exit(1);
  }
  if (
    PROTECTED_AGENT_ROOTS.has(relParts[0]?.toLowerCase())
    || PROTECTED_AGENT_ROOTS.has(realRelParts[0]?.toLowerCase())
  ) {
    report.excluded.push(rel);
    report.flags.push(
      `--include skipped inside agent harness (${rel}): agent roots use their dedicated safe migration allowlists`
    );
    continue;
  }
  if (copyFiltered(abs, path.join(STAGING_ROOT, ...rel.split(path.sep)), null, abs, true)) {
    report.included.push(`${rel.split(path.sep).join("/")}/ (--include)`);
  }
}

// ---- Hermes (beta, --agent hermes): pack ~/.hermes per the Hermes Manifest v2.
// Staged at staging/.hermes so tar extraction lands it at /data/home/agent/.hermes;
// the box sets HERMES_HOME to that path. Explicit include lists (never "copy
// everything"), with HERMES_EXCLUDE on top of the global excludes. Credential
// files (.env/auth/session/pairing) and config.yaml stay local.
// HERMES_HOME lets you point at a Hermes harness outside the CLI user's home --
// notably the REAL one in WSL (\\wsl.localhost\<distro>\home\<user>\.hermes) when
// running the Windows CLI, since the Windows-native ~/.hermes is usually a stub.
// Matches the var the box itself uses (start.sh sets HERMES_HOME). Falls back to
// ~/.hermes.
const HERMES_SRC = process.env.HERMES_HOME || path.join(HOME, ".hermes");
const HERMES_INCLUDE_FILES = ["SOUL.md", "channel_directory.json"];
const HERMES_INCLUDE_DIRS = ["skills", "memories", "cron", ".agents", "plugins"];
const hermes = { included: [], notes: [], redacted: [], mcp: [] };
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
  fs.mkdirSync(HERMES_STAGING, { recursive: true });
  const redactedBefore = report.redactedSecrets.length;
  const mcpBefore = report.mcp.length;
  for (const f of HERMES_INCLUDE_FILES) {
    const p = path.join(HERMES_SRC, f);
    if (
      fs.existsSync(p)
      && copyFiltered(
        p,
        path.join(HERMES_STAGING, f),
        matchesHermesExclude,
        HERMES_SRC,
      )
    ) {
      hermes.included.push(f);
    }
  }
  for (const d of HERMES_INCLUDE_DIRS) {
    const p = path.join(HERMES_SRC, d);
    if (
      fs.existsSync(p)
      && copyFiltered(p, path.join(HERMES_STAGING, d), matchesHermesExclude, HERMES_SRC)
    ) {
      hermes.included.push(d + "/");
    }
  }
  const hermesAuth = path.join(HERMES_SRC, "auth.json");
  if (fs.existsSync(hermesAuth)) {
    report.excluded.push(path.relative(HOME, hermesAuth));
    addSecurityOmission(hermesAuth, "Hermes authentication credential");
  }
  const hermesEnv = path.join(HERMES_SRC, ".env");
  if (fs.existsSync(hermesEnv)) {
    report.excluded.push(path.relative(HOME, hermesEnv));
    addSecurityOmission(hermesEnv, "Hermes local secret environment file");
    report.flags.push(
      "Hermes .env not migrated: AgentHost does not read credential files; set selected HERMESENV_<KEY> values explicitly"
    );
  }
  const hermesConfig = path.join(HERMES_SRC, "config.yaml");
  if (fs.existsSync(hermesConfig)) {
    report.excluded.push(path.relative(HOME, hermesConfig));
    addSecurityOmission(hermesConfig, "Hermes config may contain credentials and has no safe YAML parser");
    report.flags.push(
      "Hermes config.yaml not migrated: YAML cannot be scrubbed safely without a full parser; recreate it on the cloud box"
    );
  }
  hermes.notes.push("Hermes auth not migrated -- sign in to Hermes again on the cloud box");
  hermes.notes.push("Hermes .env not migrated -- set only the required HERMESENV_<KEY> values explicitly");
  hermes.notes.push("Hermes config.yaml not migrated -- recreate it on the cloud box");
  hermes.notes.push("WhatsApp session not migrated -- scan a fresh QR from the cloud box");
  hermes.notes.push("Hermes channel pairing state not migrated -- pair channels again on the cloud box");
  if (withKanban && fs.existsSync(path.join(HERMES_SRC, "kanban.db"))) {
    if (
      copyFiltered(
        path.join(HERMES_SRC, "kanban.db"),
        path.join(HERMES_STAGING, "kanban.db"),
        matchesHermesExclude,
        HERMES_SRC,
        false,
        false,
        true,
      )
    ) {
      hermes.included.push("kanban.db (--with-kanban)");
    }
  } else {
    hermes.notes.push("fresh kanban.db on the box (safe for parallel local+cloud)");
  }
  report.flags.push("Hermes computer_use tools will fail on a headless cloud box -- disable that toolset in config.yaml if enabled");
  // channel_directory.json is non-auth config, but malformed JSON is omitted
  // rather than packed unchanged. auth.json is never copied at all.
  for (const jf of ["channel_directory.json"]) {
    const p = path.join(HERMES_STAGING, jf);
    if (fs.existsSync(p)) {
      if (!processJsonConfig(p, `.hermes/${jf}`)) hermes.included = hermes.included.filter((entry) => entry !== jf);
    }
  }
  hermes.redacted = report.redactedSecrets.slice(redactedBefore);
  hermes.mcp = report.mcp.slice(mcpBefore);
  report.included.push(".hermes/ (beta)");
}

// ---- Codex (~/.codex): only instructions and prompts. auth.json, config.toml,
// and session/history/log/cache runtime state are always excluded.
const codex = { included: [] };
if (packCodex) {
  const CODEX_STAGING = path.join(STAGING_ROOT, ".codex");
  for (const f of ["AGENTS.md"]) {
    const p = path.join(CODEX_SRC, f);
    if (
      fs.existsSync(p)
      && copyFiltered(p, path.join(CODEX_STAGING, f), matchesCodexExclude, CODEX_SRC)
    ) {
      codex.included.push(f);
    }
  }
  for (const d of ["prompts"]) {
    const p = path.join(CODEX_SRC, d);
    if (
      fs.existsSync(p)
      && copyFiltered(p, path.join(CODEX_STAGING, d), matchesCodexExclude, CODEX_SRC)
    ) {
      codex.included.push(d + "/");
    }
  }
  if (fs.existsSync(path.join(CODEX_SRC, "config.toml"))) {
    report.excluded.push(path.relative(HOME, path.join(CODEX_SRC, "config.toml")));
  }
  if (codex.included.length) report.included.push(".codex/ [" + codex.included.join(", ") + "]");
}

// ---- OpenClaw (~/.openclaw): allowlist the channel/agent/binding config
// (packOpenclawConfig DROPS session material + any unlisted subtree + botToken/
// token/session), scrub survivors as a second net. openclaw.json is the REAL
// filename (NOT config.json).
const openclaw = { included: [], dropped: [] };
if (packOpenclaw) {
  const cfgSrc = path.join(OPENCLAW_SRC, "openclaw.json");
  if (fs.existsSync(cfgSrc)) {
    let configPath = cfgSrc;
    let configAllowed = true;
    try {
      if (fs.lstatSync(cfgSrc).isSymbolicLink()) {
        const rootReal = fs.realpathSync(OPENCLAW_SRC);
        const targetReal = fs.realpathSync(cfgSrc);
        const targetRel = path.relative(rootReal, targetReal);
        if (targetRel === ".." || targetRel.startsWith(".." + path.sep) || path.isAbsolute(targetRel)) {
          report.flags.push(`OpenClaw external symlink skipped: ${cfgSrc} -> ${targetReal}`);
          configAllowed = false;
        } else {
          configPath = targetReal;
        }
      }
      if (configAllowed && fs.statSync(configPath).nlink > 1) {
        report.flags.push(`OpenClaw hard-linked config skipped (credential alias cannot be ruled out): ${cfgSrc}`);
        configAllowed = false;
      }
    } catch (e) {
      report.flags.push(`--openclaw: could not resolve ${cfgSrc} safely (${e.message}); NOT migrated`);
      configAllowed = false;
    }
    try {
      if (!configAllowed) throw null;
      const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
      report.openclawDropped = [];
      const stats = { translated: 0, nonHome: [] };
      const migrated = packOpenclawConfig(raw, stats, HOME_VARIANTS, CLOUD_HOME, report);
      const dest = path.join(STAGING_ROOT, ".openclaw", "openclaw.json");
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const text = JSON.stringify(migrated, null, 2);
      fs.writeFileSync(dest, text);
      report.totalBytes += Buffer.byteLength(text); report.fileCount += 1;
      report.included.push(".openclaw/openclaw.json (allowlisted)");
      openclaw.included.push("openclaw.json");
      openclaw.dropped = (report.openclawDropped || []).slice();
    } catch (e) {
      if (e) report.flags.push(`--openclaw: could not parse ${cfgSrc} (${e.message}); NOT migrated`);
    }
  } else {
    report.flags.push(`OpenClaw dir found at ${OPENCLAW_SRC} but no openclaw.json; nothing migrated`);
  }
}

// scrub + translate the JSON configs (staged copies only; source files untouched)
for (const f of PROCESS_JSON) {
  const p = path.join(STAGING, f);
  processJsonConfig(p, f);
}
const mcpConfDir = path.join(STAGING, "mcp-configs");
if (fs.existsSync(mcpConfDir)) {
  const processMcpJsonTree = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        processMcpJsonTree(p);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) {
        const label = path.relative(STAGING, p).split(path.sep).join("/");
        processJsonConfig(p, label);
      }
    }
  };
  processMcpJsonTree(mcpConfDir);
}

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

// ---- curated packs (--pack <name>) -------------------------------------------
// A pack ships skills/ AND agents/ AND its mode files (MODE.md, mode.toml) --
// shipping only skills silently dropped every hat definition, so a mode pack
// booted with zero agents (Growth Mode ARD, H1; ported from the public repo's
// T0.2 as T0.2b). Copied AFTER harness staging so a pack never overwrites the
// user's own same-named skill or agent (user's harness wins; the collision is
// reported) -- EXCEPT content the pack declares critical in packs/<name>/pack.json
// ({ criticalSkills: [], criticalAgents: [] }): silently skipping those would
// strip a gate-critical skill, so the pack hard-fails instead, naming the collision.
const REPO_ROOT_FOR_PACKS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const packsLoaded = [];
// pack name -> declared critical names, re-checked after the content audits run
const packCriticals = new Map();
// Staged pack mode.toml files, staging-relative with forward slashes.
// .toml is a parserless config, which the staging omit pass and the archive
// audit would both reject -- but these are repo-vetted pack files WE authored,
// not user harness state, so they get the final content audits
// (omitSuspiciousPackedFiles + scanForSecrets) instead of the blanket omit.
const packModeTomlEntries = new Set();

function findCuratedPackLink(dir, root = dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) return path.relative(root, full).replace(/\\/g, "/");
    if (stat.isDirectory()) {
      const nested = findCuratedPackLink(full, root);
      if (nested) return nested;
    }
  }
  return null;
}

for (const name of packNames) {
  if (!/^[a-z0-9-]+$/.test(name || "")) { report.flags.push(`--pack '${name}': invalid pack name (a-z, 0-9, -)`); continue; }
  const packDir = path.join(REPO_ROOT_FOR_PACKS, "packs", name);
  if (!fs.existsSync(packDir)) { report.flags.push(`--pack '${name}': not found (no packs/${name} in this AgentHost install)`); continue; }
  if (fs.lstatSync(packDir).isSymbolicLink()) {
    console.error(`pack '${name}': packs/${name} is a symbolic link or junction -- curated packs may not redirect outside the repository`);
    process.exit(1);
  }
  const linkedEntry = findCuratedPackLink(packDir);
  if (linkedEntry) {
    console.error(`pack '${name}': ${linkedEntry} is a symbolic link or junction -- curated packs may contain only their own regular files and directories`);
    process.exit(1);
  }
  let packMeta = {};
  const packJson = path.join(packDir, "pack.json");
  if (fs.existsSync(packJson)) {
    try { packMeta = JSON.parse(fs.readFileSync(packJson, "utf8")); }
    catch { console.error(`pack '${name}': pack.json is not valid JSON -- fix the pack before packing`); process.exit(1); }
  }
  // Fail loud on a non-array critical field: new Set("name") is a set of
  // CHARACTERS, which would silently disarm the hard-fail guard below.
  for (const field of ["criticalSkills", "criticalAgents"]) {
    if (packMeta[field] !== undefined && !Array.isArray(packMeta[field])) {
      console.error(`pack '${name}': pack.json ${field} must be an array of names -- fix the pack before packing`);
      process.exit(1);
    }
  }
  const criticalSkills = new Set(packMeta.criticalSkills || []);
  const criticalAgents = new Set(packMeta.criticalAgents || []);
  const coveragePath = path.join(packDir, "coverage.json");
  const isModePack = fs.existsSync(path.join(packDir, "mode.toml")) || fs.existsSync(coveragePath);
  let coverageOwners = [];
  if (fs.existsSync(coveragePath)) {
    try {
      const coverage = JSON.parse(fs.readFileSync(coveragePath, "utf8"));
      if (coverage && typeof coverage === "object" && !Array.isArray(coverage)) {
        coverageOwners = [...new Set(Object.values(coverage).filter((value) => typeof value === "string" && value.trim()))];
      }
    } catch { /* the mode-pack preflight reports malformed coverage with rule f */ }
  }
  const loaded = [], loadedAgents = [], modeFiles = [];

  const packSkillsDir = path.join(packDir, "skills");
  if (fs.existsSync(packSkillsDir)) {
    for (const ent of fs.readdirSync(packSkillsDir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const dest = path.join(STAGING, "skills", ent.name);
      if (fs.existsSync(dest)) {
        if (criticalSkills.has(ent.name)) {
          console.error(`pack '${name}': skill '${ent.name}' is critical to this pack but already exists in your harness. A silent skip would strip a gate-critical skill, so this pack refuses to load. Rename your skill or drop --pack ${name}.`);
          process.exit(1);
        }
        report.flags.push(`pack '${name}': skill '${ent.name}' already exists in your harness -- yours kept, pack copy skipped`);
        continue;
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const source = path.join(packSkillsDir, ent.name);
      copyFiltered(source, dest, null, source, false, true);
      const copiedFiles = fs.existsSync(dest)
        ? fs.readdirSync(dest, { recursive: true })
          .map((f) => String(f))
          .filter((f) => fs.statSync(path.join(dest, f)).isFile())
        : [];
      if (copiedFiles.length) {
        loaded.push(ent.name);
        for (const f of copiedFiles) report.included.push(path.join("skills", ent.name, f));
      } else {
        fs.rmSync(dest, { recursive: true, force: true });
      }
    }
  }

  // agents/ lands at .claude/agents/ -- the exact path the box roster reads.
  // Every regular entry is staged, not just plain files: a `!isFile()` skip
  // silently dropped nested agent directories, which is the same zero-hats
  // failure this pipeline exists to prevent. Curated-pack symlinks and
  // junctions hard-fail before this loop; copyFiltered still audits hard links.
  const packAgentsDir = path.join(packDir, "agents");
  if (fs.existsSync(packAgentsDir)) {
    for (const ent of fs.readdirSync(packAgentsDir, { withFileTypes: true })) {
      const dest = path.join(STAGING, "agents", ent.name);
      if (fs.existsSync(dest)) {
        const agentName = ent.name.replace(/\.md$/, "");
        if (criticalAgents.has(agentName) || criticalAgents.has(ent.name)) {
          console.error(`pack '${name}': agent '${agentName}' is critical to this pack but already exists in your harness. Rename your agent or drop --pack ${name}.`);
          process.exit(1);
        }
        report.flags.push(`pack '${name}': agent '${ent.name}' already exists in your harness -- yours kept, pack copy skipped`);
        continue;
      }
      const source = path.join(packAgentsDir, ent.name);
      if (!copyFiltered(source, dest, null, source, false, true)) continue;
      loadedAgents.push(ent.name);
      if (fs.statSync(dest).isDirectory()) {
        for (const f of fs.readdirSync(dest, { recursive: true })) {
          const fp = path.join(dest, String(f));
          if (fs.statSync(fp).isFile()) report.included.push(path.join("agents", ent.name, String(f)));
        }
      } else {
        report.included.push(path.join("agents", ent.name));
      }
    }
  }

  // Mode files land at .claude/modes/<name>/ -- the landing path the pack
  // contract documents, and the one the box READS: gate.js's applyModePack
  // pulls the active mode's `addendum` out of .claude/modes/<active>/mode.toml
  // and appends it to the team charter (T0.3). The older Modes-v2 path
  // (applyMode / ~/modes/active_mode) still runs first and is untouched -- the
  // packer has never created that symlink, which is why this wiring was needed.
  // Copied directly, not via copyFiltered: mode.toml's extension would trip the
  // parserless-config skip meant for un-scrubbable USER configs, and these are
  // our own repo files (still audited by the final content passes below).
  for (const mf of ["MODE.md", "mode.toml"]) {
    const src = path.join(packDir, mf);
    if (!fs.existsSync(src)) continue;
    if (fs.lstatSync(src).isSymbolicLink()) { report.flags.push(`pack '${name}': ${mf} is a symlink -- skipped`); continue; }
    const dest = path.join(STAGING, "modes", name, mf);
    // No collision check here, unlike skills/agents: nothing else ever stages
    // .claude/modes/ (it is not in INCLUDE_DIRS, and --include refuses .claude
    // as a protected agent root), so the user's own mode notes are never in the
    // staged tree to be overwritten. If modes/ is ever added to INCLUDE_DIRS,
    // this loop needs the same "yours kept" guard the other two have.
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    report.fileCount += 1;
    report.totalBytes += fs.statSync(dest).size;
    report.included.push(path.join("modes", name, mf));
    if (mf === "mode.toml") packModeTomlEntries.add(`.claude/modes/${name}/mode.toml`);
    modeFiles.push(mf);
  }

  packsLoaded.push({ name, skills: loaded, agents: loadedAgents, modeFiles, isModePack, coverageOwners });
  packCriticals.set(name, { skills: [...criticalSkills], agents: [...criticalAgents] });
  console.log(`pack '${name}': preloaded ${loaded.length} skill(s), ${loadedAgents.length} agent(s)${modeFiles.length ? `, mode files: ${modeFiles.join(", ")}` : ""}`);
}

// Arbitrary plugin/skill data files must stay byte-for-byte intact: silently
// rewriting marketplace/package/schema JSON corrupts working harnesses. For
// structured formats outside the known config paths above, detect credential
// values and omit the whole file instead.
function omitSuspiciousStructuredFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      omitSuspiciousStructuredFiles(p);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!STRUCTURED_CONFIG_EXTENSIONS.has(ext)) continue;
    const label = path.relative(STAGING_ROOT, p).split(path.sep).join("/");
    // Pack-staged mode.toml is repo-vetted content: it skips the parserless
    // blanket omit and is audited by the final content passes instead.
    if (packModeTomlEntries.has(label)) continue;
    const stat = fs.statSync(p);
    if (stat.size > MAX_SECRET_SCAN_BYTES) {
      omitStagedFile(
        p,
        label,
        `structured file exceeds the ${MAX_SECRET_SCAN_BYTES}-byte audit limit`,
      );
      continue;
    }
    if (ext !== ".json") {
      omitStagedFile(p, label, "structured config has no safe parser");
      continue;
    }
    const text = fs.readFileSync(p, "utf8");
    let suspicious = false;
    try {
      suspicious = jsonContainsCredentialValues(
        JSON.parse(text),
        {
          inDependencyMap: false,
          allowDependencyMaps: entry.name.toLowerCase() === "package.json",
        },
      );
    } catch {
      suspicious = true;
    }
    if (suspicious) {
      omitStagedFile(
        p,
        label,
        "invalid JSON or structured credential value found outside a parser-backed migration policy",
      );
    }
  }
}
omitSuspiciousStructuredFiles(STAGING_ROOT);
// High-confidence credentials in arbitrary source/docs/tests are never
// rewritten because that could corrupt working harness files. Omit each whole
// file with a visible reason, then run the immutable final scan below as the
// race/backstop gate. One suspicious marketplace fixture must not make the
// entire otherwise-safe harness undeployable.
omitSuspiciousPackedFiles(STAGING_ROOT);

// ---- pack reconciliation: report what SURVIVED, not what we tried to copy ----
// The audits above delete staged files (a credential pattern in an agent .md,
// for one). Without this pass the manifest and deploy's "Preloaded pack" line
// keep naming a hat that is not in the tarball -- the operator is told a mode
// shipped complete when it did not. And a pack that declares an entry CRITICAL
// must not ship without it, whether it went missing to a typo, the security
// filter, or the audit: same failure the collision guard exists to prevent.
// "It survived" is about CONTENT, not about a path still existing. A skill is a
// DIRECTORY, and the audits delete files without removing the emptied parent --
// so a bare existsSync() on skills/<name> stayed true after the audit deleted
// that skill's only SKILL.md, the skill counted as shipped, and a pack could
// declare it CRITICAL and still exit 0. The agent and mode-file cases were only
// ever correct because those are plain .md files.
function hasContent(p) {
  let st;
  try { st = fs.statSync(p); } catch { return false; }
  if (st.isFile()) return true;
  if (!st.isDirectory()) return false;
  try {
    return fs.readdirSync(p, { withFileTypes: true })
      .some((e) => (e.isDirectory() ? hasContent(path.join(p, e.name)) : true));
  } catch { return false; }
}
function survivedPackEntry(kind, p, name) {
  if (kind === "skill") {
    try { return fs.statSync(path.join(p, "SKILL.md")).isFile(); }
    catch { return false; }
  }
  if (kind === "agent") {
    let stat;
    try { stat = fs.statSync(p); } catch { return false; }
    if (stat.isFile()) return path.extname(p).toLowerCase() === ".md";
    if (!stat.isDirectory()) return false;
    const base = String(name).replace(/\.md$/, "");
    for (const entry of fs.readdirSync(p, { recursive: true })) {
      const file = path.join(p, String(entry));
      let fileStat;
      try { fileStat = fs.statSync(file); } catch { continue; }
      if (!fileStat.isFile() || path.extname(file).toLowerCase() !== ".md") continue;
      let text;
      try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
      const frontmatter = /^\s*---\r?\n([\s\S]*?)\r?\n---/.exec(text);
      if (!frontmatter) continue;
      const nameLine = frontmatter[1].split(/\r?\n/).find((line) => /^name\s*:/.test(line));
      if (nameLine && nameLine.slice(nameLine.indexOf(":") + 1).trim() === base) return true;
    }
    return false;
  }
  return hasContent(p);
}
if (packsLoaded.length) {
  const dropIncluded = (label) => {
    report.included = report.included.filter((entry) => entry !== label && !entry.startsWith(label + path.sep));
  };
  for (const p of packsLoaded) {
    for (const [kind, list, rel] of [
      ["skill", p.skills, (n) => path.join("skills", n)],
      ["agent", p.agents, (n) => path.join("agents", n)],
      ["mode file", p.modeFiles, (n) => path.join("modes", p.name, n)],
    ]) {
      const survivors = list.filter((n) => survivedPackEntry(kind, path.join(STAGING, rel(n)), n));
      for (const gone of list.filter((n) => !survivors.includes(n))) {
        // An audited-away skill leaves its now-EMPTY directory behind
        // (omitStagedFile removes the file, never the parent), so the tarball
        // would still carry ~/.claude/skills/<name>/ with nothing in it while
        // this pass reports it dropped. Remove it: the report and the archive
        // have to say the same thing.
        fs.rmSync(path.join(STAGING, rel(gone)), { recursive: true, force: true });
        dropIncluded(rel(gone));
        report.flags.push(`pack '${p.name}': ${kind} '${gone}' did not survive the content audit -- it is NOT in this pack`);
      }
      list.length = 0;
      list.push(...survivors);
    }
    if (p.isModePack) {
      for (const required of ["MODE.md", "mode.toml"]) {
        if (p.modeFiles.includes(required)) continue;
        console.error(`pack '${p.name}': mandatory mode file '${required}' did not survive the content audit. Shipping this pack would create an unrecoverable mode switch.`);
        process.exit(1);
      }
      for (const owner of p.coverageOwners) {
        const base = String(owner).replace(/\.md$/, "");
        const file = path.join(STAGING, "agents", `${base}.md`);
        const dir = path.join(STAGING, "agents", base);
        if (survivedPackEntry("agent", file, base) || survivedPackEntry("agent", dir, base)) continue;
        console.error(`pack '${p.name}': coverage-owned agent '${base}' did not survive the content audit. Shipping this pack would leave a declared channel owner missing.`);
        process.exit(1);
      }
    }
    const criticals = packCriticals.get(p.name) || { skills: [], agents: [] };
    for (const s of criticals.skills) {
      if (p.skills.includes(s)) continue;
      console.error(`pack '${p.name}': critical skill '${s}' is not in the packed harness (missing from packs/${p.name}/skills, or dropped by the security audit). Shipping this pack without it would boot the mode broken.`);
      process.exit(1);
    }
    for (const a of criticals.agents) {
      // An agent's public identity is its top-level staged entry: either
      // agents/<hat>.md or agents/<hat>/. Recursive leaf basenames are not hats
      // and cannot satisfy another pack's critical declaration.
      const criticalName = String(a).replace(/\.md$/, "");
      if (p.agents.some((n) => String(n).replace(/\.md$/, "") === criticalName)) continue;
      console.error(`pack '${p.name}': critical agent '${a}' is not in the packed harness (missing from packs/${p.name}/agents, or dropped by the security audit). Shipping this pack without it would boot the mode without its hat.`);
      process.exit(1);
    }
  }
}

// Final security gate: inspect every staged payload after all redaction,
// rewrites, hook pruning, and curated-pack copies. No source is trusted enough
// to bypass this last pass. Oversized/unreadable files fail closed.
const finalMetrics = measureTree(STAGING_ROOT);
report.fileCount = finalMetrics.files;
report.totalBytes = finalMetrics.bytes;
const stagingScanFingerprint = createHash("sha256");
scanForSecrets(STAGING_ROOT, STAGING_ROOT, new Map(), "", stagingScanFingerprint);
const stagingFingerprint = stagingScanFingerprint.digest("hex");

const stalePathFiles = findStalePathFiles(STAGING_ROOT).files;

// ---- harness discovery: everything found on this machine that did NOT ride this
// tarball (Steve 2026-07-24: "my MCPs/plugins/skills are sprawled across 10,000
// locations... and our code should do that too"). REPORT-ONLY by design: listing a
// Cursor/Claude-Desktop/user-scope MCP here never migrates it -- ~/.claude.json in
// particular stays excluded per security invariant #2. Discovery reads NAMES and
// PATHS only (scripts/discover-harness.mjs's own tested guarantee), so nothing
// secret can enter the manifest or report through this section. --no-discovery skips.
let discovered = { mcpServers: [], skills: [], plugins: [], instructions: [] };
if (!args.includes("--no-discovery")) {
  try {
    const { discoverHarness } = await import("./discover-harness.mjs");
    const inv = discoverHarness({ cwdWalk: false });
    // A source is "migrated" when this run actually packed that harness root.
    const migrated = (s) => typeof s === "string" && (
      (!hermesOnly && s.startsWith("~/.claude/")) ||               // NOT ~/.claude.json (no trailing slash there)
      (packCodex && s.startsWith("~/.codex/")) ||
      (packHermes && s.startsWith("~/.hermes/")) ||
      (packOpenclaw && s.startsWith("~/.openclaw/")));
    discovered.mcpServers = inv.mcpServers.filter((m) => !migrated(m.source));
    discovered.skills = inv.skills.filter((x) => !migrated(x.source));
    discovered.plugins = inv.plugins.filter((x) => !migrated(x.source));
    discovered.instructions = inv.instructions.filter((f) => !migrated(f.path));
  } catch (e) { report.flags.push(`discovery scan failed (${e.message}); the migrated set is unaffected`); }
}
const discoveredCount = discovered.mcpServers.length + discovered.skills.length
  + discovered.plugins.length + discovered.instructions.length;

let securityBlocked = report.possibleSecrets.length > 0;
if (securityBlocked) {
  report.flags.push(
    `archive blocked: ${report.possibleSecrets.length} possible secret(s) require review; no tarball was written`
  );
}

// tar it. Run tar FROM outDir with relative paths so no absolute path is ever
// handed to it: GNU tar (the tar on the PATH under Git Bash on Windows) reads a
// leading "C:" as a remote SCP host and dies with "Cannot connect to C:". A
// relative -f/-C from cwd sidesteps the drive letter on every tar family (GNU,
// Windows bsdtar, macOS/Linux) with no per-OS flag. Env is preserved so tar is
// still found on the PATH. A tar failure must not prevent the manifest/report.
const tarball = path.join(outDir, "harness.tar.gz");
let tarError = null;
let archiveSha256 = null;
fs.rmSync(tarball, { force: true });
if (!dryRun && !securityBlocked) {
  // COPYFILE_DISABLE=1 stops BSD tar (the system tar on macOS) from writing
  // "._*" AppleDouble companion files (packed extended-attribute metadata) into
  // the archive -- staging-exclusion can't catch these because BSD tar GENERATES
  // them at archive time, not from disk. Harmless on GNU tar (Windows/Linux
  // ignore the var), so it's set unconditionally: simplest correct fix.
  // --exclude=.DS_Store belt-and-suspenders in case one slipped past the staging
  // EXCLUDE_NAMES; it goes BEFORE the "-C staging ." operands because BSD tar
  // requires --exclude ahead of the paths (GNU tar accepts it anywhere), so this
  // ordering is the one both tar families honor.
  try {
    execFileSync("tar", ["-czf", "harness.tar.gz", "--exclude", ".DS_Store", "-C", "staging", "."], {
      cwd: outDir,
      env: minimalChildEnv({ extra: { COPYFILE_DISABLE: "1" } }),
    });
  }
  catch (e) { tarError = e.message; report.flags.push(`tar failed: ${e.message} -- no tarball was written`); }
}

// Inspect the exact completed archive, not only the mutable staging directory.
// A before/after staging fingerprint catches any mutation during tar creation;
// archive listing + extraction then re-run the name, inode, content-shape, and
// JSON scrub gates against the bytes that would actually be deployed.
if (!dryRun && !tarError && !securityBlocked) {
  const findingsBeforeArchiveAudit = report.possibleSecrets.length;
  let auditDir = null;
  try {
    if (fingerprintTree(STAGING_ROOT) !== stagingFingerprint) {
      report.possibleSecrets.push("harness.tar.gz (staging-mutated-during-archive)");
    }
    const archiveHashBefore = hashFile(tarball);
    const entries = execFileSync("tar", ["-tzf", "harness.tar.gz"], {
      cwd: outDir,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: minimalChildEnv(),
    }).split(/\r?\n/).filter(Boolean);
    for (const entry of entries) {
      if (archiveEntryIsUnsafe(entry)) {
        report.possibleSecrets.push(`archive:${entry} (forbidden-carrier-path)`);
      }
    }
    const verboseEntries = execFileSync("tar", ["-tvzf", "harness.tar.gz"], {
      cwd: outDir,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: minimalChildEnv(),
    }).split(/\r?\n/).filter(Boolean);
    if (verboseEntries.some((line) => !/^[d-]/.test(line.trimStart()))) {
      report.possibleSecrets.push("harness.tar.gz (non-regular-archive-entry)");
    }
    if (report.possibleSecrets.length > findingsBeforeArchiveAudit) {
      throw new Error("exact archive failed path/type/fingerprint policy before extraction");
    }

    // Same relative-from-cwd rule as the -czf call above, for the same reason
    // plus a second one: GNU tar also C-escapes the -C argument, so an absolute
    // Windows temp path like ...\Temp\agenthost-pack-XXXX turns "\a" into BEL
    // and tar dies with "Cannot open". Every non-dry-run pack then failed the
    // post-archive audit and shipped no tarball. Pass the BASENAME with cwd
    // already at outDir: no drive letter, no backslashes, no escapes.
    auditDir = fs.mkdtempSync(path.join(outDir, ".archive-audit-"));
    execFileSync("tar", ["-xzf", "harness.tar.gz", "-C", path.basename(auditDir)], {
      cwd: outDir,
      maxBuffer: 64 * 1024 * 1024,
      env: minimalChildEnv(),
    });
    if (fingerprintTree(auditDir) !== stagingFingerprint) {
      report.possibleSecrets.push("harness.tar.gz (archive-tree-does-not-match-staging)");
    }
    if (hashFile(tarball) !== archiveHashBefore) {
      report.possibleSecrets.push("harness.tar.gz (archive-mutated-during-audit)");
    }
    scanForSecrets(auditDir, auditDir, new Map(), "archive:");
    auditArchiveJson(auditDir);
    const archiveHashAfter = hashFile(tarball);
    if (archiveHashAfter !== archiveHashBefore) {
      report.possibleSecrets.push("harness.tar.gz (archive-mutated-before-hash-bind)");
    } else {
      archiveSha256 = archiveHashAfter;
    }
  } catch (e) {
    report.possibleSecrets.push("harness.tar.gz (post-archive-audit-failed)");
    report.flags.push(`post-archive security audit failed (${e.message}); archive removed`);
  } finally {
    if (auditDir) fs.rmSync(auditDir, { recursive: true, force: true });
  }
  if (report.possibleSecrets.length > findingsBeforeArchiveAudit) {
    securityBlocked = true;
    archiveSha256 = null;
    fs.rmSync(tarball, { force: true });
    report.flags.push(
      `archive blocked after exact-tar audit: ${report.possibleSecrets.length - findingsBeforeArchiveAudit} finding(s); tarball removed`
    );
  }
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
  securityOmissions: report.securityOmissions,
  flags: report.flags,
  mcp: report.mcp,
  hookGaps,
  removedHooks,
  packs: packsLoaded,
  filesWithStalePaths: stalePathFiles,
  codex,
  openclaw,
  discovered,
  tarball: dryRun || tarError || securityBlocked ? null : tarball,
  archiveSha256,
};
fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

// ---- per-engine migration summary: the "look how much we brought" moment.
// Counts staged, non-secret artifacts per engine so the first command's output
// SHOWS the multi-agent workspace instead of just asserting it. Counts are
// derived from the staged tree (what actually shipped), never from the source.
function stagedCount(rel) {
  const p = path.join(STAGING_ROOT, rel);
  try {
    let n = 0;
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name)); else n++;
    } };
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p); else if (st.isFile()) n = 1;
    return n;
  } catch { return 0; }
}
const engineSummary = [
  { name: "Claude Code", on: !hermesOnly && fs.existsSync(SRC), parts: [
    [stagedCount(".claude/skills"), "skills"], [stagedCount(".claude/agents"), "agents"],
    [stagedCount(".claude/commands"), "commands"], [report.mcp.length, "MCP servers"],
  ] },
  { name: "Codex", on: packCodex && codex.included.length > 0, parts: [
    [stagedCount(".codex/prompts"), "prompts"],
    [codex.included.includes("AGENTS.md") ? 1 : 0, "AGENTS.md"],
  ] },
  { name: "Hermes", on: packHermes && fs.existsSync(HERMES_SRC), emptyLabel: "safe tools bootstrap staged", parts: [
    [stagedCount(".hermes/skills"), "skills"], [stagedCount(".hermes/memories"), "memories"],
    [hermes.mcp.length, "MCP servers"],
  ] },
  { name: "OpenClaw", on: packOpenclaw && openclaw.included.length > 0, parts: [
    [openclaw.included.length, "config"], [openclaw.dropped.length, "fields dropped (secrets/session)"],
  ] },
];

const disabled = report.mcp.filter(m => m.verdict.startsWith("DISABLED"));
const lines = [
  "# Cloud compatibility report",
  "",
  "## Multi-agent workspace migrated",
  ...engineSummary.map((e) => {
    const parts = e.parts.filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`);
    return `- ${e.on ? "✓" : "—"} ${e.name}: ${e.on ? (parts.join(", ") || e.emptyLabel || "config") : "not found on this machine"}`;
  }),
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
  "## Files intentionally left local for security",
  ...(report.securityOmissions.length
    ? report.securityOmissions.map(({ path: omittedPath, reason }) => `- ${omittedPath}: ${reason}`)
    : ["- none"]),
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
  ...(packsLoaded.length ? [
    "## Packs",
    ...packsLoaded.map(p => `- ${p.name}: ${p.skills.length} skill(s) [${p.skills.join(", ") || "none"}], ${p.agents.length} agent(s) [${p.agents.join(", ") || "none"}]${p.modeFiles.length ? `, mode files: ${p.modeFiles.join(", ")}` : ""}`),
    "",
  ] : []),
  ...(packHermes ? [
    "## Hermes",
    `Included from ~/.hermes: ${hermes.included.join(", ") || "none found"}`,
    ...hermes.notes.map(n => `- ${n}`),
    "",
    "### Hermes MCP servers",
    "- not inspected or migrated because config.yaml is excluded; recreate them on the cloud box",
    "",
    "### Hermes secrets redacted (re-provide via fly secrets)",
    ...(hermes.redacted.length ? hermes.redacted.map(s => `- ${s}`) : ["- none found"]),
    "",
    "### Hermes notes",
    "- Hermes computer_use tools will fail on a headless cloud box -- disable that toolset in config.yaml if enabled",
    "- run 'hermes gateway status' after boot to verify platforms connected",
    "",
  ] : []),
  ...(packCodex && codex.included.length ? [
    "## Codex",
    `Included from ~/.codex: ${codex.included.join(", ")}`,
    "- auth.json (OpenAI/ChatGPT credential) was NOT migrated -- re-auth on the box (`codex login`) or set OPENAI_API_KEY as a Fly secret",
    "- config.toml was NOT migrated -- reconfigure providers and MCP servers on the box with explicit secret values",
    "",
  ] : []),
  ...(discoveredCount ? [
    "## Also on this machine, NOT in this tarball (discovered, report-only)",
    "Your harness sprawls across more tools than the migrated set. Nothing below was",
    "packed (user-scope ~/.claude.json never migrates -- it holds credentials; other",
    "tools' configs aren't consumed by the box). To bring an MCP over: add it to",
    "~/.claude/mcp.json locally and re-pack, then re-supply its token as a Fly secret.",
    ...(discovered.mcpServers.length ? ["", "### MCP servers found elsewhere",
      ...discovered.mcpServers.map((m) => `- ${m.name} [${m.transport}] <- ${m.source}`)] : []),
    ...(discovered.skills.length ? ["", "### Skills found elsewhere",
      ...discovered.skills.map((s) => `- ${s.name} <- ${s.source}`)] : []),
    ...(discovered.plugins.length ? ["", "### Plugins found elsewhere",
      ...discovered.plugins.map((p) => `- ${p.name} <- ${p.source}`)] : []),
    ...(discovered.instructions.length ? ["", "### Instruction files found elsewhere",
      ...discovered.instructions.map((f) => `- ${f.path}`)] : []),
    "",
  ] : []),
  ...(packOpenclaw && openclaw.included.length ? [
    "## OpenClaw",
    `Included from ~/.openclaw: ${openclaw.included.join(", ")} (allowlisted -- channels, agents, bindings, UI)`,
    "- botToken / token / session / gateway auth were DROPPED -- re-add channels on the box (`claw-setup`), tokens go to Fly secrets",
    `- ${openclaw.dropped.length} field(s) dropped by the allowlist (session material + anything unlisted):`,
    ...(openclaw.dropped.length ? openclaw.dropped.slice(0, 40).map(d => `  - ${d}`) : ["  - none"]),
    ...(openclaw.dropped.length > 40 ? [`  - ...and ${openclaw.dropped.length - 40} more (full list in manifest.json openclaw.dropped)`] : []),
    "",
  ] : []),
  "## Flags",
  ...(report.flags.length ? report.flags.map(f => `- ${f}`) : ["- none"]),
];
fs.writeFileSync(path.join(outDir, "compat-report.md"), lines.join("\n"));

console.log(`\nPacked ${report.fileCount} files, ${(report.totalBytes / 1024 / 1024).toFixed(1)} MB`);
console.log(`Secrets redacted from configs: ${report.redactedSecrets.length}`);
if (report.possibleSecrets.length) {
  console.error(`\narchive blocked: ${report.possibleSecrets.length} possible secret(s) found in packed files.`);
  console.error(`Review ${path.join(outDir, "compat-report.md")}; no tarball was written.`);
}
if (removedHooks.length) {
  console.log(`\n*** ${removedHooks.length} unportable hook(s) removed from the CLOUD settings.json (your local file is untouched):`);
  for (const h of removedHooks) console.log(`***   ${h}`);
}
console.log(`MCP servers scanned: ${report.mcp.length} (${disabled.length} disabled as unreachable from the cloud)`);
console.log(`Output: ${outDir}`);
if (dryRun) console.log("(dry run: no tarball written)");
if (securityBlocked) process.exit(1);
if (tarError) { console.error(`\ntar failed: ${tarError}`); process.exit(1); }
