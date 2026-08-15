"use strict";

// Operator-only Phase 1 code map. The caller chooses a small, explicit file
// allowlist; this module copies those files into a disposable corpus and gives
// Graphify no credentials, network, repo metadata, or writable source tree.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
const crypto = require("node:crypto");
const { TextDecoder } = require("node:util");
const { buildBwrapReadJail } = require("./chains-lib.js");
const { renderGraphifyHtml } = require("./graphify-html.js");
const {
  hasCredentialShape,
  hasSecretAssignment,
  isSecretKey,
  redactCredentialShapes,
  redactSecretAssignments,
} = require("./graphify-secrets.js");

const GRAPHIFY_IDENTITY = Object.freeze({
  distribution: "graphifyy",
  version: "0.9.42",
  wheelSha256: "d87bec57d5dbca1203ce719f4b4afb83ae5eb6cea1b4af2d62d0c10c1c3e26e6",
  sourceCommit: "7fe58b0b0f3873be9a21c30106b8b8527c353aa6",
});

const GRAPHIFY_LIMITS = Object.freeze({
  maxFiles: 15,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 4 * 1024 * 1024,
  maxReportBytes: 100 * 1024,
  maxGraphBytes: 5 * 1024 * 1024,
  maxNodes: 5000,
  maxRetainedResults: 8,
  maxProcessOutputBytes: 64 * 1024,
  timeoutMs: 60_000,
  killGraceMs: 2_000,
});

// A selected folder is intentionally broader than the original 15-file code
// map, but still hard-bounded. Nothing is silently truncated: the operator can
// choose a narrower named folder when a corpus exceeds either ceiling.
const GRAPHIFY_FOLDER_LIMITS = Object.freeze({
  maxFiles: 512,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  maxReportBytes: 256 * 1024,
  maxGraphBytes: 8 * 1024 * 1024,
  // Public artifacts share gate's existing 8 MiB view/download ceiling.
  maxHtmlBytes: 8 * 1024 * 1024,
  maxNodes: 5000,
  maxProcessOutputBytes: 64 * 1024,
  timeoutMs: 120_000,
  killGraceMs: 2_000,
});

const AGENTHOST_PHASE1_FILES = Object.freeze([
  "container/gate.js",
  "container/engine-adapters.js",
  "container/engine-sessions.js",
  "container/gemini-adapter.js",
  "container/openai-compatible-chat.js",
  "container/deepseek-budget.js",
  "container/chat-governance.js",
  "container/channel-dispatch.js",
  "container/channel-delivery-limiter.js",
  "container/mesh-contract.js",
  "container/mesh-store.js",
  "container/mesh-state.js",
  "container/settings-lib.js",
  "container/mode-lib.js",
  "scripts/dev-local.mjs",
]);

const SENSITIVE_DIRS = new Set([
  ".git", ".claude", ".codex", "data", "dashboard", "node_modules", "graphify-out",
]);
// Runtime code legitimately contains container paths such as /home/agent and
// /data/home/agent. Those are architecture, not a workstation identity. Block
// personal Windows/macOS home paths here; parsed graph path fields get the
// stricter portable-absolute check in validateGraph below.
const PRIVATE_PATH_RE = /(?:[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\\/\s"'`]+|\/Users\/[^/\s"'`]+)/i;
const OUTPUT_PATH_RE = /(?:[A-Za-z]:[\\/]|\/(?:data|home|opt|root|scratch|source|tmp|workspace)(?:\/|\b))/i;
const GRAPHIFY_PACKAGE_DIR = "/opt/agenthost/graphify-python";
const GRAPHIFY_FOLDER_RUNNER = "/opt/agenthost/graphify-folder-extract.py";
const SNAPSHOT_SKIPPED_DIRS = new Set([
  ".git", ".hg", ".svn", ".next", "build", "cache", "caches", "coverage",
  "dist", "graphify-out", "history", "log", "logs", "node_modules", "session",
  "sessions", "temp", "tmp",
]);
const SECRET_CONTAINER_RE = /^(?:auth|credentials?|env|headers?|secrets?)$/i;

const PYTHON_ENTRY = [
  "import sys",
  "sys.path.insert(0, '/graphify')",
  "import importlib.metadata as metadata",
  `expected = '${GRAPHIFY_IDENTITY.version}'`,
  `actual = metadata.version('${GRAPHIFY_IDENTITY.distribution}')`,
  "actual == expected or sys.exit(f'Graphify identity mismatch: expected graphifyy=={expected}, found {actual}')",
  "from graphify.__main__ import main",
  "main()",
].join("; ");

function portableAbsolute(value) {
  return path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("/");
}

function inside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel));
}

function statValue(stat, precise, fallback) {
  return String(stat[precise] === undefined ? stat[fallback] : stat[precise]);
}

function sameFileVersion(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && statValue(left, "mtimeNs", "mtimeMs") === statValue(right, "mtimeNs", "mtimeMs")
    && statValue(left, "ctimeNs", "ctimeMs") === statValue(right, "ctimeNs", "ctimeMs")
    && statValue(left, "birthtimeNs", "birthtimeMs") === statValue(right, "birthtimeNs", "birthtimeMs");
}

function readDescriptorBounded(fd, maxBytes, label) {
  const chunks = [];
  let total = 0;
  while (true) {
    const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - total));
    const count = fs.readSync(fd, chunk, 0, chunk.length, null);
    if (count === 0) break;
    total += count;
    if (total > maxBytes) throw new Error(`${label} exceeds the ${maxBytes}-byte limit`);
    chunks.push(chunk.subarray(0, count));
  }
  return Buffer.concat(chunks, total);
}

function normalizeFiles(files) {
  if (!Array.isArray(files) || files.length < 1) throw new Error("Graphify requires at least one source file");
  if (files.length > GRAPHIFY_LIMITS.maxFiles) {
    throw new Error(`Graphify accepts at most ${GRAPHIFY_LIMITS.maxFiles} source files`);
  }
  const seen = new Set();
  return files.map((raw) => {
    if (typeof raw !== "string" || !raw || raw.includes("\\") || raw.includes("\0") || portableAbsolute(raw)) {
      throw new Error("Graphify source entries must be a safe relative path");
    }
    const relative = path.posix.normalize(raw);
    if (relative !== raw || relative === "." || relative.startsWith("../")) {
      throw new Error("Graphify source entries must be a safe relative path");
    }
    const parts = relative.split("/");
    if (parts.some((part) => SENSITIVE_DIRS.has(part.toLowerCase()))) {
      throw new Error(`Graphify source entry crosses a sensitive directory: ${relative}`);
    }
    if (!/\.(?:js|mjs)$/i.test(relative)) {
      throw new Error(`Graphify Phase 1 accepts only .js and .mjs source: ${relative}`);
    }
    if (seen.has(relative.toLowerCase())) throw new Error(`Graphify source entry is duplicated: ${relative}`);
    seen.add(relative.toLowerCase());
    return relative;
  });
}

function secretForms(values) {
  const forms = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const value = String(raw || "");
    if (value.length < 8) continue;
    forms.add(value);
    forms.add(Buffer.from(value, "utf8").toString("base64"));
    forms.add(Buffer.from(value, "utf8").toString("hex"));
  }
  return [...forms].filter((value) => value.length >= 8).sort((a, b) => b.length - a.length);
}

function inheritedSecretValues(env) {
  const source = env && typeof env === "object" ? env : {};
  return Object.entries(source)
    .filter(([key, value]) => isSecretKey(key)
      && String(value || "").length >= 8)
    .map(([, value]) => String(value));
}

function sensitiveCause(text, forms) {
  let safe = redactSecretAssignments(redactCredentialShapes(text), "[REDACTED]");
  for (const form of forms) safe = safe.split(form).join("[REDACTED]");
  return safe.replace(new RegExp(OUTPUT_PATH_RE.source, "gi"), "<path>").replace(/\s+/g, " ").trim().slice(0, 240);
}

function rejectSensitiveText(text, forms, label) {
  const value = String(text || "");
  if (hasCredentialShape(value)) throw new Error(`${label} contains a credential-shaped value`);
  if (forms.some((form) => value.includes(form))) throw new Error(`${label} contains a secret value`);
  if (hasSecretAssignment(value)) throw new Error(`${label} contains an assignment-form credential`);
  if (PRIVATE_PATH_RE.test(value) || value.includes(".graphify_root")) {
    throw new Error(`${label} contains an absolute or private path`);
  }
}

function rejectSensitiveOutput(text, forms, label) {
  rejectSensitiveText(text, forms, label);
  if (OUTPUT_PATH_RE.test(String(text || ""))) throw new Error(`${label} contains an internal absolute path`);
}

function copyAllowlistedSource(sourceRoot, inputDir, files, forms) {
  if (typeof sourceRoot !== "string" || !path.isAbsolute(sourceRoot)) {
    throw new Error("Graphify source root must be absolute");
  }
  const rootStat = fs.lstatSync(sourceRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Graphify source root must be a real directory");
  }
  const canonicalRoot = path.resolve(sourceRoot);
  const realRoot = fs.realpathSync(sourceRoot);
  if (realRoot !== canonicalRoot) throw new Error("Graphify source root must match its canonical source path");
  let totalBytes = 0;
  for (const relative of files) {
    const candidate = path.resolve(realRoot, ...relative.split("/"));
    if (!inside(realRoot, candidate)) throw new Error(`Graphify source escaped its root: ${relative}`);
    let stat;
    try { stat = fs.lstatSync(candidate, { bigint: true }); }
    catch (error) { throw new Error(`Graphify source file is unavailable: ${relative} (${error.code || error.message})`); }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) {
      throw new Error(`Graphify source must be a regular single-link non-symlink file: ${relative}`);
    }
    const realFile = fs.realpathSync(candidate);
    if (!inside(realRoot, realFile)) throw new Error(`Graphify source escaped its root: ${relative}`);
    if (realFile !== candidate) throw new Error(`Graphify source must match its canonical source path: ${relative}`);
    if (stat.size > BigInt(GRAPHIFY_LIMITS.maxFileBytes)) throw new Error(`Graphify source file is too large: ${relative}`);

    const noFollow = fs.constants.O_NOFOLLOW || 0;
    let fd;
    let content;
    try {
      fd = fs.openSync(candidate, fs.constants.O_RDONLY | noFollow);
      const opened = fs.fstatSync(fd, { bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n || !sameFileVersion(stat, opened)) throw new Error("file changed during validation");
      content = readDescriptorBounded(fd, GRAPHIFY_LIMITS.maxFileBytes, `Graphify source ${relative}`);
      const after = fs.fstatSync(fd, { bigint: true });
      const current = fs.lstatSync(candidate, { bigint: true });
      if (!sameFileVersion(opened, after) || current.isSymbolicLink() || !sameFileVersion(after, current)
        || BigInt(content.length) !== after.size) {
        throw new Error("file changed while it was being read");
      }
    } catch (error) {
      throw new Error(`Graphify source could not be safely opened: ${relative} (${error.code || error.message})`);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    totalBytes += content.length;
    if (totalBytes > GRAPHIFY_LIMITS.maxTotalBytes) throw new Error("Graphify source copy exceeds the 4 MiB cap");
    let sourceText;
    try { sourceText = new TextDecoder("utf-8", { fatal: true }).decode(content); }
    catch { throw new Error(`Graphify source is not valid UTF-8 text: ${relative}`); }
    rejectSensitiveText(sourceText, forms, `Graphify source ${relative}`);
    const destination = path.join(inputDir, ...relative.split("/"));
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.writeFileSync(destination, content, { flag: "wx", mode: 0o400 });
  }
  return totalBytes;
}

const GRAPHIFY_MAX_INCLUDE_ROOTS = 160;

function normalizeCorpusPlan(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) throw new Error("Graphify corpus plan is invalid");
  const target = plan.target && typeof plan.target === "object" ? plan.target : {};
  const folder = plan.folder && typeof plan.folder === "object" ? plan.folder : {};
  for (const [label, record, keys] of [
    ["target", target, ["id", "label", "kind"]],
    ["folder", folder, ["id", "label"]],
  ]) {
    for (const key of keys) {
      if (typeof record[key] !== "string" || !record[key] || record[key].length > 160 || /[\0\r\n]/.test(record[key])) {
        throw new Error(`Graphify corpus ${label}.${key} is invalid`);
      }
    }
  }
  if (typeof plan.sourceRoot !== "string" || !path.isAbsolute(plan.sourceRoot)) {
    throw new Error("Graphify corpus source root must be absolute");
  }
  const rootStat = fs.lstatSync(plan.sourceRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Graphify corpus source root must be a real directory");
  const sourceRoot = path.resolve(plan.sourceRoot);
  if (fs.realpathSync(plan.sourceRoot) !== sourceRoot) throw new Error("Graphify corpus source root must match its canonical path");
  // Empty is NOT malformed, and saying so mattered: the operator reads this
  // string. "include roots are invalid" describes the data truthfully and tells
  // them nothing they can act on -- it reads as a bad request when the real
  // condition is an empty selection. The caller should not offer an empty
  // folder at all (graphify-corpora.js drops them), so reaching this is a bug
  // in the caller; it still has to say which bug.
  // THREE distinct conditions, three distinct messages. They used to share one
  // word -- "invalid" -- and the operator reads this string.
  //
  // Live 2026-08-15: Steve picked "Agent harness / All" and got "Graphify
  // corpus include roots are invalid". His harness was fine: 333 skills, real
  // plugins, real MCP configs. The selection simply resolved to 168 roots
  // against a cap of 160. The message let him conclude his harness had never
  // been copied to the box at all, which was false and cost real trust.
  if (!Array.isArray(plan.includeRoots)) {
    throw new Error("Graphify corpus include roots are invalid");
  }
  if (plan.includeRoots.length < 1) {
    throw new Error("Graphify corpus selection is empty: nothing on this box matched that folder, so there is nothing to map");
  }
  if (plan.includeRoots.length > GRAPHIFY_MAX_INCLUDE_ROOTS) {
    throw new Error(
      `Graphify corpus selection is too broad: it resolves to ${plan.includeRoots.length} folders and the limit is `
      + `${GRAPHIFY_MAX_INCLUDE_ROOTS}. Pick a narrower folder -- the parts of this corpus map fine on their own.`,
    );
  }
  const includeRoots = [];
  const seenRoots = new Set();
  for (const raw of plan.includeRoots) {
    if (typeof raw !== "string" || !raw || raw.includes("\\") || raw.includes("\0") || portableAbsolute(raw)) {
      throw new Error("Graphify corpus include root must be a safe relative path");
    }
    const relative = path.posix.normalize(raw);
    if (relative !== raw || relative.startsWith("../") || relative === "..") {
      throw new Error("Graphify corpus include root must be a safe relative path");
    }
    if (!seenRoots.has(relative.toLowerCase())) {
      seenRoots.add(relative.toLowerCase());
      includeRoots.push(relative);
    }
  }
  const normalizePolicyList = (values, kind) => {
    if (!Array.isArray(values) || values.length > 100) throw new Error(`Graphify corpus ${kind} are invalid`);
    const result = [];
    const seen = new Set();
    for (const raw of values) {
      if (typeof raw !== "string" || !raw || raw.length > 80 || /[\\/\0]/.test(raw)) {
        throw new Error(`Graphify corpus ${kind} are invalid`);
      }
      const value = kind === "extensions" ? raw.toLowerCase() : raw;
      if (kind === "extensions" && !/^\.[a-z0-9][a-z0-9._-]*$/.test(value)) {
        throw new Error("Graphify corpus extensions are invalid");
      }
      if (!seen.has(value.toLowerCase())) {
        seen.add(value.toLowerCase());
        result.push(value);
      }
    }
    return result;
  };
  const extensions = normalizePolicyList(plan.extensions, "extensions");
  const allowedBasenames = normalizePolicyList(plan.allowedBasenames, "allowed basenames");
  if (extensions.length + allowedBasenames.length < 1) throw new Error("Graphify corpus has no supported file policy");
  if (!Number.isSafeInteger(plan.maxDepth) || plan.maxDepth < 0 || plan.maxDepth > 32) {
    throw new Error("Graphify corpus max depth is invalid");
  }
  if (typeof plan.redactInputs !== "boolean") throw new Error("Graphify corpus redaction policy is invalid");
  if (plan.snapshotKind !== "git" && plan.snapshotKind !== "folder") throw new Error("Graphify corpus snapshot kind is invalid");
  return {
    target: { id: target.id, label: target.label, kind: target.kind },
    folder: { id: folder.id, label: folder.label },
    sourceRoot,
    includeRoots,
    extensions: new Set(extensions),
    allowedBasenames: new Set(allowedBasenames),
    maxDepth: plan.maxDepth,
    redactInputs: plan.redactInputs,
    snapshotKind: plan.snapshotKind,
  };
}

function selectedCorpusFiles(plan) {
  const result = new Map();
  const rootVersion = fs.lstatSync(plan.sourceRoot, { bigint: true });
  const eligible = (name) => plan.allowedBasenames.has(name) || plan.extensions.has(path.extname(name).toLowerCase());
  const visit = (candidate, depth) => {
    const relative = path.relative(plan.sourceRoot, candidate).split(path.sep).join("/") || ".";
    if (!inside(plan.sourceRoot, candidate)) throw new Error(`Graphify corpus entry escaped its root: ${relative}`);
    let stat;
    try { stat = fs.lstatSync(candidate, { bigint: true }); }
    catch (error) { throw new Error(`Graphify corpus entry is unavailable: ${relative} (${error.code || error.message})`); }
    if (stat.isSymbolicLink()) throw new Error(`Graphify corpus entry is a symbolic link: ${relative}`);
    const real = fs.realpathSync(candidate);
    if (real !== candidate || !inside(plan.sourceRoot, real)) throw new Error(`Graphify corpus entry is not canonical: ${relative}`);
    if (stat.isDirectory()) {
      if (depth > plan.maxDepth) return;
      for (const name of fs.readdirSync(candidate).sort((left, right) => left.localeCompare(right))) {
        if (SNAPSHOT_SKIPPED_DIRS.has(name.toLowerCase())) continue;
        visit(path.join(candidate, name), depth + 1);
      }
      return;
    }
    if (!stat.isFile() || stat.nlink !== 1n || !eligible(path.basename(candidate))) return;
    if (depth > plan.maxDepth + 1) return;
    if (stat.size > BigInt(GRAPHIFY_FOLDER_LIMITS.maxFileBytes)) {
      throw new Error(`Graphify corpus file exceeds the ${GRAPHIFY_FOLDER_LIMITS.maxFileBytes}-byte limit: ${relative}`);
    }
    const key = relative.toLowerCase();
    const prior = result.get(key);
    if (prior && prior.relative !== relative) throw new Error(`Graphify corpus has a case-colliding source path: ${relative}`);
    result.set(key, { candidate, relative, stat });
    if (result.size > GRAPHIFY_FOLDER_LIMITS.maxFiles) {
      throw new Error(`Graphify corpus contains more than ${GRAPHIFY_FOLDER_LIMITS.maxFiles} supported files; choose a narrower folder`);
    }
  };
  for (const relative of plan.includeRoots) {
    const candidate = path.resolve(plan.sourceRoot, ...relative.split("/"));
    if (!inside(plan.sourceRoot, candidate)) throw new Error("Graphify corpus include root escaped its source root");
    visit(candidate, 0);
  }
  if (result.size < 1) throw new Error("Graphify corpus contains no supported files");
  return { rootVersion, files: [...result.values()].sort((left, right) => left.relative.localeCompare(right.relative)) };
}

function replaceSensitiveForms(text, forms) {
  let safe = redactSecretAssignments(text, "[REDACTED]");
  for (const form of forms) safe = safe.split(form).join("[REDACTED]");
  safe = redactCredentialShapes(safe, "[REDACTED]");
  safe = safe.replace(new RegExp(PRIVATE_PATH_RE.source, "gi"), "<home>");
  return safe;
}

function redactAllLeaves(value) {
  if (Array.isArray(value)) return value.map(redactAllLeaves);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).map((key) => [key, redactAllLeaves(value[key])]));
  }
  return "[REDACTED]";
}

function redactStructured(value) {
  if (Array.isArray(value)) return value.map(redactStructured);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (isSecretKey(key)) result[key] = redactAllLeaves(child);
    else if (SECRET_CONTAINER_RE.test(key)) result[key] = redactAllLeaves(child);
    else result[key] = redactStructured(child);
  }
  return result;
}

function sanitizeMetadataValue(value, forms) {
  if (Array.isArray(value)) return value.map((child) => sanitizeMetadataValue(child, forms));
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, child] of Object.entries(value)) {
      if (isSecretKey(key) || SECRET_CONTAINER_RE.test(key)) result[key] = redactAllLeaves(child);
      else result[key] = sanitizeMetadataValue(child, forms);
    }
    return result;
  }
  return typeof value === "string" ? replaceSensitiveForms(value, forms) : value;
}

function tomlLineEnd(text, start) {
  const lf = text.indexOf("\n", start);
  if (lf === -1) {
    const cr = text.indexOf("\r", start);
    return cr === -1 ? text.length : cr;
  }
  const beforeLf = text.slice(start, lf).indexOf("\r");
  return beforeLf === -1 ? lf : start + beforeLf;
}

function tomlNextLine(text, end) {
  if (text.slice(end, end + 2) === "\r\n") return end + 2;
  return text[end] === "\r" || text[end] === "\n" ? end + 1 : end;
}

function tomlAssignmentPrefixEnd(line) {
  if (/^[ \t]*(?:#|\[|$)/.test(line)) return -1;
  let quote = "";
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (quote === '"' && !escaped && char === "\\") escaped = true;
      else if (!escaped && char === quote) quote = "";
      else escaped = false;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "#") return -1;
    else if (char === "=") {
      let end = index + 1;
      while (end < line.length && /[ \t]/.test(line[end])) end += 1;
      return end;
    }
  }
  return -1;
}

function tomlQuotedEnd(text, start) {
  const quote = text[start];
  const delimiter = text.slice(start, start + 3) === quote.repeat(3) ? quote.repeat(3) : quote;
  const multiline = delimiter.length === 3;
  let cursor = start + delimiter.length;
  while (cursor < text.length) {
    if (!multiline && (text[cursor] === "\r" || text[cursor] === "\n")) return cursor;
    if (text.startsWith(delimiter, cursor)) {
      let slashes = 0;
      if (quote === '"') {
        for (let check = cursor - 1; check >= start && text[check] === "\\"; check -= 1) slashes += 1;
      }
      if (slashes % 2 === 0) return cursor + delimiter.length;
    }
    cursor += 1;
  }
  return text.length;
}

function tomlValueEnd(text, start) {
  let cursor = start;
  while (cursor < text.length && /[ \t]/.test(text[cursor])) cursor += 1;
  const stack = [];
  while (cursor < text.length) {
    const char = text[cursor];
    if (char === '"' || char === "'") {
      cursor = tomlQuotedEnd(text, cursor);
      if (stack.length < 1) return cursor;
      continue;
    }
    if (char === "#") {
      const end = tomlLineEnd(text, cursor);
      if (stack.length < 1) return end;
      cursor = tomlNextLine(text, end);
      continue;
    }
    if (char === "[" || char === "{") stack.push(char);
    else if (char === "]" || char === "}") {
      const expected = char === "]" ? "[" : "{";
      if (stack[stack.length - 1] === expected) stack.pop();
      if (stack.length < 1) return cursor + 1;
    } else if ((char === "\r" || char === "\n") && stack.length < 1) {
      return cursor;
    }
    cursor += 1;
  }
  return text.length;
}

function redactTomlLeaves(sourceText) {
  const chunks = [];
  let cursor = 0;
  while (cursor < sourceText.length) {
    const lineEnd = tomlLineEnd(sourceText, cursor);
    const prefixEnd = tomlAssignmentPrefixEnd(sourceText.slice(cursor, lineEnd));
    if (prefixEnd === -1) {
      const next = tomlNextLine(sourceText, lineEnd);
      chunks.push(sourceText.slice(cursor, next));
      cursor = next;
      continue;
    }
    const valueStart = cursor + prefixEnd;
    const valueEnd = tomlValueEnd(sourceText, valueStart);
    const finalLineEnd = tomlLineEnd(sourceText, valueEnd);
    const next = tomlNextLine(sourceText, finalLineEnd);
    chunks.push(sourceText.slice(cursor, valueStart), '"[REDACTED]"', sourceText.slice(finalLineEnd, next));
    cursor = next;
  }
  return chunks.join("");
}

function sanitizedCorpusText(relative, sourceText, forms, redactInputs) {
  if (!redactInputs) {
    rejectSensitiveText(sourceText, forms, `Graphify corpus source ${relative}`);
    return sourceText;
  }
  const extension = path.extname(relative).toLowerCase();
  let safe = sourceText;
  if (extension === ".json") {
    try { safe = `${JSON.stringify(redactStructured(JSON.parse(sourceText)), null, 2)}\n`; }
    catch (error) { throw new Error(`Graphify corpus JSON is invalid: ${relative} (${error.message})`); }
  } else if (extension === ".toml") {
    safe = redactTomlLeaves(sourceText);
  } else if ([".yaml", ".yml"].includes(extension)) {
    safe = sourceText.split(/\r?\n/).map((line) => {
      const match = line.match(/^(\s*[^#;\s][^:=\r\n]{0,120}\s*[:=]\s*).*$/);
      return match ? `${match[1]}"[REDACTED]"` : line;
    }).join("\n");
    if (/\r?\n$/.test(sourceText)) safe += "\n";
  }
  safe = replaceSensitiveForms(safe, forms);
  rejectSensitiveText(safe, forms, `Graphify corpus source ${relative}`);
  return safe;
}

function safeFileMetadata(fileMetadata, allowedFiles, forms) {
  const source = fileMetadata && typeof fileMetadata === "object" && !Array.isArray(fileMetadata) ? fileMetadata : {};
  const result = {};
  for (const [relative, metadata] of Object.entries(source)) {
    if (!allowedFiles.has(relative) || !metadata || typeof metadata !== "object" || Array.isArray(metadata)) continue;
    const raw = JSON.stringify(metadata);
    if (Buffer.byteLength(raw) > 64 * 1024) throw new Error(`Graphify metadata is too large: ${relative}`);
    const scrubbed = sanitizeMetadataValue(metadata, forms);
    const safeRaw = JSON.stringify(scrubbed);
    if (Buffer.byteLength(safeRaw) > 64 * 1024) throw new Error(`Graphify metadata is too large: ${relative}`);
    rejectSensitiveText(safeRaw, forms, `Graphify metadata ${relative}`);
    result[relative] = scrubbed;
  }
  return result;
}

function materializeCorpusSnapshot(plan, inputDir, forms, { fileMetadata = null } = {}) {
  const selected = selectedCorpusFiles(plan);
  let inputBytes = 0;
  let maxMtimeMs = 0;
  const manifestEntries = [];
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  // Files the box is not PERMITTED to read are skipped and named, never fatal.
  // Everything else in this loop still fails the whole snapshot closed.
  //
  // That distinction is the entire point. This path is TOCTOU-hardened on
  // purpose -- O_NOFOLLOW, nlink, "changed during validation", realpath
  // recheck -- and those conditions are ATTACK-SHAPED, so aborting is right.
  // EACCES is not. It is a stable, benign fact: this process is not allowed to
  // open that file, and no retry will ever change it.
  //
  // Treating the two the same made one private note destroy an entire map.
  // Live 2026-08-15, from Steve's phone: one 0600 agent-owned file in his
  // vault (User-Preference-Secret-Handling.md) returned the whole run as
  // HTTP 500 GRAPHIFY_FAILED. The gate runs as uid 997; that file is owned by
  // agent. It was never going to be readable, and the correct answer was never
  // to widen its permissions -- a graph tool has no business ingesting a file
  // called Secret-Handling, and loosening 0600 to make a map work would be
  // repairing the wrong end of the problem.
  //
  // No bytes are read either way. The only difference is whether the operator
  // gets their map, and whether they are told what was left out of it.
  const unreadable = [];
  for (const record of selected.files) {
    let fd;
    let bytes;
    try {
      fd = fs.openSync(record.candidate, fs.constants.O_RDONLY | noFollow);
      const opened = fs.fstatSync(fd, { bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n || !sameFileVersion(record.stat, opened)) throw new Error("file changed during validation");
      bytes = readDescriptorBounded(fd, GRAPHIFY_FOLDER_LIMITS.maxFileBytes, `Graphify corpus ${record.relative}`);
      const after = fs.fstatSync(fd, { bigint: true });
      const current = fs.lstatSync(record.candidate, { bigint: true });
      if (!sameFileVersion(opened, after) || current.isSymbolicLink() || !sameFileVersion(after, current)
        || fs.realpathSync(record.candidate) !== record.candidate || BigInt(bytes.length) !== after.size) {
        throw new Error("file changed while it was being read");
      }
      record.opened = after;
    } catch (error) {
      // EACCES ONLY. EPERM was here too and has been dropped: on open() it can
      // signal an LSM/capability denial or an immutable-file condition, which
      // are ANOMALY-shaped, not the plain "this uid may not read this file"
      // fact that makes skipping safe. If EPERM ever needs to survive, it
      // should arrive with its own argument. (Kimi, PR #424.)
      const denied = error && error.code === "EACCES";
      if (denied) {
        if (fd !== undefined) { fs.closeSync(fd); fd = undefined; }
        record.skipped = error.code;
        unreadable.push({ relative: record.relative, code: error.code });
        continue;
      }
      throw new Error(`Graphify corpus source could not be safely opened: ${record.relative} (${error.code || error.message})`);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    let sourceText;
    try { sourceText = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new Error(`Graphify corpus source is not valid UTF-8: ${record.relative}`); }
    const safeText = sanitizedCorpusText(record.relative, sourceText, forms, plan.redactInputs);
    const safeBytes = Buffer.from(safeText, "utf8");
    inputBytes += safeBytes.length;
    if (inputBytes > GRAPHIFY_FOLDER_LIMITS.maxTotalBytes) {
      throw new Error(`Graphify corpus exceeds the ${GRAPHIFY_FOLDER_LIMITS.maxTotalBytes}-byte input limit; choose a narrower folder`);
    }
    const destination = path.join(inputDir, ...record.relative.split("/"));
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.writeFileSync(destination, safeBytes, { flag: "wx", mode: 0o400 });
    const mtimeMs = Number(record.opened.mtimeNs === undefined ? record.opened.mtimeMs : record.opened.mtimeNs / 1000000n);
    maxMtimeMs = Math.max(maxMtimeMs, mtimeMs);
    manifestEntries.push({ relative: record.relative, bytes: safeBytes.length, sha256: crypto.createHash("sha256").update(safeBytes).digest("hex") });
  }
  // Recheck every source only after the complete copy; changing an early file
  // while a later one is copied invalidates the whole snapshot.
  const currentRoot = fs.lstatSync(plan.sourceRoot, { bigint: true });
  if (!sameFileVersion(selected.rootVersion, currentRoot) || fs.realpathSync(plan.sourceRoot) !== plan.sourceRoot) {
    throw new Error("Graphify corpus root changed while the snapshot was copied");
  }
  for (const record of selected.files) {
    // A skipped file was never opened, so it has no record.opened to compare
    // against and nothing of it reached the snapshot. Re-checking it here would
    // dereference undefined and turn the skip back into the failure it replaced.
    if (record.skipped) continue;
    const current = fs.lstatSync(record.candidate, { bigint: true });
    if (current.isSymbolicLink() || !sameFileVersion(record.opened, current) || fs.realpathSync(record.candidate) !== record.candidate) {
      throw new Error(`Graphify corpus source changed during the snapshot: ${record.relative}`);
    }
  }
  // A corpus where NOTHING could be read is not a partial success, it is a
  // failed one wearing a warning. Say so rather than handing back an empty map.
  if (!manifestEntries.length && unreadable.length) {
    throw new Error(
      `Graphify could not read any of the ${unreadable.length} selected file(s); this box is not permitted to open them `
      + `(${unreadable.slice(0, 3).map((entry) => `${entry.relative} ${entry.code}`).join(", ")})`,
    );
  }
  const metadata = safeFileMetadata(fileMetadata, new Set(manifestEntries.map((entry) => entry.relative)), forms);
  const metadataText = `${JSON.stringify({ version: 1, files: metadata })}\n`;
  const manifestText = manifestEntries.map((entry) => `${entry.relative}\0${entry.bytes}\0${entry.sha256}\n`).join("")
    + `.agenthost-corpus.json\0${Buffer.byteLength(metadataText)}\0${crypto.createHash("sha256").update(metadataText).digest("hex")}\n`;
  const manifestSha256 = crypto.createHash("sha256").update(manifestText).digest("hex");
  fs.writeFileSync(path.join(inputDir, ".agenthost-corpus.json"), metadataText, {
    flag: "wx", mode: 0o400,
  });
  return { files: manifestEntries, inputBytes, manifestSha256, maxMtimeMs, unreadable };
}

function buildGraphifyCommand({ stage, inputDir, scratchDir, packageDir = GRAPHIFY_PACKAGE_DIR, buildJail = buildBwrapReadJail } = {}) {
  if (stage !== "extract" && stage !== "cluster") throw new Error("Graphify stage must be extract or cluster");
  for (const [label, value] of [["input", inputDir], ["scratch", scratchDir], ["package", packageDir]]) {
    if (typeof value !== "string" || !value.startsWith("/") || value.includes("\0")) {
      throw new Error(`Graphify ${label} directory must be an absolute POSIX path`);
    }
  }
  const graphifyArgs = stage === "extract"
    ? ["extract", "/source", "--code-only", "--max-workers", "1", "--out", "/scratch", "--force"]
    : ["cluster-only", "/scratch", "--no-viz", "--max-concurrency", "1"];
  const childEnv = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: "/hm",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TMPDIR: "/tmp",
    PYTHONNOUSERSITE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
  };
  const jail = buildJail("/usr/bin/python3", ["-I", "-c", PYTHON_ENTRY, ...graphifyArgs], {
    env: childEnv,
    roBindsAt: [
      { src: inputDir, dest: "/source" },
      { src: packageDir, dest: "/graphify" },
    ],
    requiredRwBindAt: [{ src: scratchDir, dest: "/scratch" }],
  });
  if (!jail || jail.bin !== "/usr/bin/bwrap" || !Array.isArray(jail.args)) {
    throw new Error("Graphify networkless sandbox command could not be built");
  }
  return {
    bin: jail.bin,
    args: ["--unshare-net", ...jail.args],
    cwd: "/tmp",
    env: { PATH: childEnv.PATH, LANG: childEnv.LANG, LC_ALL: childEnv.LC_ALL },
  };
}

function buildGraphifySnapshotCommand({
  stage,
  inputDir,
  scratchDir,
  packageDir = GRAPHIFY_PACKAGE_DIR,
  runnerScript = GRAPHIFY_FOLDER_RUNNER,
  buildJail = buildBwrapReadJail,
} = {}) {
  if (stage !== "extract" && stage !== "cluster") throw new Error("Graphify snapshot stage must be extract or cluster");
  for (const [label, value] of [["input", inputDir], ["scratch", scratchDir], ["package", packageDir]]) {
    if (typeof value !== "string" || !value.startsWith("/") || value.includes("\0")) {
      throw new Error(`Graphify snapshot ${label} directory must be an absolute POSIX path`);
    }
  }
  if (typeof runnerScript !== "string" || !runnerScript.startsWith("/") || runnerScript.includes("\0")) {
    throw new Error("Graphify snapshot runner must be an absolute POSIX path");
  }
  const childEnv = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: "/hm",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TMPDIR: "/tmp",
    PYTHONNOUSERSITE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
  };
  const args = stage === "extract"
    ? ["-I", "/runner/graphify-folder-extract.py", "/source", "/scratch/graphify-out/graph.json"]
    : ["-I", "-c", PYTHON_ENTRY, "cluster-only", "/scratch", "--no-viz", "--max-concurrency", "1"];
  const roBindsAt = [
    { src: inputDir, dest: "/source" },
    { src: packageDir, dest: "/graphify" },
  ];
  if (stage === "extract") roBindsAt.push({ src: runnerScript, dest: "/runner/graphify-folder-extract.py" });
  const jail = buildJail("/usr/bin/python3", args, {
    env: childEnv,
    roBindsAt,
    requiredRwBindAt: [{ src: scratchDir, dest: "/scratch" }],
  });
  if (!jail || jail.bin !== "/usr/bin/bwrap" || !Array.isArray(jail.args)) {
    throw new Error("Graphify snapshot networkless sandbox command could not be built");
  }
  return {
    bin: jail.bin,
    args: ["--unshare-net", ...jail.args],
    cwd: "/tmp",
    env: { PATH: childEnv.PATH, LANG: childEnv.LANG, LC_ALL: childEnv.LC_ALL },
  };
}

function graphifyCancellationError(message, { conclusiveNoChild = false, terminationUnproven = false } = {}) {
  const error = new Error(message);
  error.name = "AbortError";
  error.code = "GRAPHIFY_CANCELLED";
  error.cancelled = true;
  if (conclusiveNoChild) error.conclusiveNoChild = true;
  if (terminationUnproven) error.terminationUnproven = true;
  return error;
}

function assertAbortSignal(signal) {
  if (signal == null) return;
  if (typeof signal !== "object" || typeof signal.aborted !== "boolean"
    || typeof signal.addEventListener !== "function" || typeof signal.removeEventListener !== "function") {
    throw new Error("Graphify cancellation signal must be an AbortSignal");
  }
}

function throwIfGraphifyAborted(signal, message, options) {
  assertAbortSignal(signal);
  if (signal && signal.aborted) throw graphifyCancellationError(message, options);
}

function runBoundedCommand(command, {
  spawn = cp.spawn,
  timeoutMs = GRAPHIFY_LIMITS.timeoutMs,
  killGraceMs = GRAPHIFY_LIMITS.killGraceMs,
  maxOutputBytes = GRAPHIFY_LIMITS.maxProcessOutputBytes,
  signal = null,
} = {}) {
  assertAbortSignal(signal);
  if (signal && signal.aborted) {
    return Promise.reject(graphifyCancellationError("Graphify process was cancelled before start", { conclusiveNoChild: true }));
  }
  return new Promise((resolve, reject) => {
    let child = null;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let killTimer = null;
    let timer = null;
    let started = false;
    let terminal = null;
    let killFailure = "";
    let spawning = true;
    let listeningForAbort = false;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (listeningForAbort) signal.removeEventListener("abort", onAbort);
      listeningForAbort = false;
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const succeed = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const boundedReason = (value) => String(value || "").replace(/\s+/g, " ").trim().slice(0, 240);
    const lastOutputCause = () => stderr.trim().split(/\r?\n/).filter(Boolean).at(-1)
      || stdout.trim().split(/\r?\n/).filter(Boolean).at(-1)
      || "";
    const withTerminationDetails = (message) => {
      const details = [lastOutputCause(), killFailure].filter(Boolean).join("; ");
      return details ? `${message}: ${details}` : message;
    };
    const latchTerminal = (kind, cause = null) => {
      if (terminal) return false;
      terminal = { kind, cause };
      return true;
    };
    const terminalError = ({ unproven = false } = {}) => {
      if (terminal.kind === "cancelled") {
        return graphifyCancellationError(withTerminationDetails(unproven
          ? "Graphify process cancellation was requested but the child did not close"
          : "Graphify process was cancelled"), { terminationUnproven: unproven });
      }
      if (terminal.kind === "timeout") {
        const error = new Error(withTerminationDetails(`Graphify process timed out after ${timeoutMs}ms${unproven ? " and did not close" : ""}`));
        if (unproven) error.terminationUnproven = true;
        return error;
      }
      if (terminal.kind === "overflow") {
        const error = new Error(withTerminationDetails(`Graphify process output exceeded ${maxOutputBytes} bytes${unproven ? " and the child did not close" : ""}`));
        if (unproven) error.terminationUnproven = true;
        return error;
      }
      const cause = boundedReason(terminal.cause && (terminal.cause.message || terminal.cause)) || "no lifecycle cause was reported";
      const error = new Error(withTerminationDetails(`Graphify process failed after start${unproven ? " and did not close" : ""}: ${cause}`), {
        cause: terminal.cause,
      });
      if (unproven) error.terminationUnproven = true;
      return error;
    };
    const unprovenError = () => {
      return terminalError({ unproven: true });
    };
    const waitForCloseOrQuarantine = () => {
      if (killTimer) return;
      killTimer = setTimeout(() => fail(unprovenError()), killGraceMs);
    };
    const terminateChild = () => {
      let delivered;
      try { delivered = child.kill("SIGKILL"); }
      catch (cause) {
        const reason = boundedReason([cause && cause.code, cause && (cause.message || cause)].filter(Boolean).join(": "));
        if (!killFailure) killFailure = `SIGKILL failed${reason ? `: ${reason}` : ""}`;
        return;
      }
      if (delivered === false && !killFailure) {
        killFailure = "SIGKILL was not delivered (child.kill returned false)";
      }
    };
    const beginTermination = (kind, cause = null) => {
      if (!latchTerminal(kind, cause)) return false;
      if (timer) clearTimeout(timer);
      waitForCloseOrQuarantine();
      terminateChild();
      return true;
    };
    function onAbort() {
      if (settled || !latchTerminal("cancelled")) return;
      if (timer) clearTimeout(timer);
      if (!child) {
        if (spawning) return;
        fail(graphifyCancellationError("Graphify process was cancelled before start", { conclusiveNoChild: true }));
        return;
      }
      waitForCloseOrQuarantine();
      terminateChild();
    }
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
      listeningForAbort = true;
      if (signal.aborted) {
        onAbort();
        if (settled) return;
      }
    }
    try {
      child = spawn(command.bin, command.args, {
        cwd: command.cwd,
        env: command.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (cause) {
      spawning = false;
      if (terminal && terminal.kind === "cancelled") {
        fail(graphifyCancellationError("Graphify process was cancelled before start", { conclusiveNoChild: true }));
        return;
      }
      const error = new Error(`Graphify process did not start: ${cause.message || cause}`, { cause });
      error.conclusiveNoChild = true;
      fail(error);
      return;
    }
    spawning = false;
    if (!child || typeof child.on !== "function" || typeof child.kill !== "function"
      || !child.stdout || typeof child.stdout.on !== "function"
      || !child.stderr || typeof child.stderr.on !== "function") {
      if (child && typeof child.kill === "function") terminateChild();
      const error = terminal && terminal.kind === "cancelled"
        ? graphifyCancellationError(withTerminationDetails("Graphify process cancellation was requested but spawn returned no observable child lifecycle"), { terminationUnproven: true })
        : new Error(withTerminationDetails("Graphify process started without observable stdout, stderr, or lifecycle events"));
      error.terminationUnproven = true;
      fail(error);
      return;
    }
    started = Number.isInteger(child.pid) && child.pid > 0;
    const append = (current, chunk) => (current + String(chunk || "")).slice(-maxOutputBytes);
    child.on("spawn", () => { started = true; });
    child.stdout.on("data", (chunk) => {
      const overflow = Buffer.byteLength(stdout) + Buffer.byteLength(chunk) > maxOutputBytes;
      stdout = append(stdout, chunk);
      if (overflow) beginTermination("overflow");
    });
    child.stderr.on("data", (chunk) => {
      const overflow = Buffer.byteLength(stderr) + Buffer.byteLength(chunk) > maxOutputBytes;
      stderr = append(stderr, chunk);
      if (overflow) beginTermination("overflow");
    });
    child.on("error", (cause) => {
      if (settled) return;
      if (!terminal && !started && !(Number.isInteger(child.pid) && child.pid > 0)) {
        const error = new Error(`Graphify process did not start: ${cause.message || cause}`, { cause });
        error.conclusiveNoChild = true;
        fail(error);
        return;
      }
      beginTermination("lifecycle", cause);
    });
    child.on("close", (code, exitSignal) => {
      if (settled) return;
      if (terminal) return fail(terminalError());
      const ownCause = lastOutputCause();
      if (code !== 0) return fail(new Error(`Graphify process exited ${code == null ? exitSignal || "without a code" : code}${ownCause ? `: ${ownCause}` : ""}`));
      succeed({ stdout, stderr });
    });
    if (terminal) {
      waitForCloseOrQuarantine();
      terminateChild();
      return;
    }
    timer = setTimeout(() => beginTermination("timeout"), timeoutMs);
  });
}

function readBounded(file, maxBytes, label) {
  let stat;
  try { stat = fs.lstatSync(file, { bigint: true }); }
  catch (error) { throw new Error(`${label} was not produced (${error.code || error.message})`); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} is not a regular file`);
  if (stat.size < 1n || stat.size > BigInt(maxBytes)) throw new Error(`${label} exceeds its output cap or is empty`);
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !sameFileVersion(stat, opened)) throw new Error(`${label} changed before it could be read`);
    const bytes = readDescriptorBounded(fd, maxBytes, label);
    const after = fs.fstatSync(fd, { bigint: true });
    const current = fs.lstatSync(file, { bigint: true });
    if (!sameFileVersion(opened, after) || current.isSymbolicLink() || !sameFileVersion(after, current)
      || BigInt(bytes.length) !== after.size) {
      throw new Error(`${label} changed while it was being read`);
    }
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new Error(`${label} is not valid UTF-8`); }
  } catch (error) {
    if (error && (error.code === "ELOOP" || error.code === "EMLINK")) throw new Error(`${label} is a symbolic link`);
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function validateGraph(raw, allowedFiles, forms) {
  rejectSensitiveOutput(raw, forms, "Graphify graph.json");
  let graph;
  try { graph = JSON.parse(raw); }
  catch (error) { throw new Error(`Graphify graph.json is invalid JSON (${error.message})`); }
  if (!graph || typeof graph !== "object" || !Array.isArray(graph.nodes) || !Array.isArray(graph.links)) {
    throw new Error("Graphify graph.json is missing nodes or links");
  }
  if (graph.nodes.length > GRAPHIFY_LIMITS.maxNodes) throw new Error("Graphify graph.json exceeds the 5000-node cap");
  const allowed = new Set(allowedFiles);
  const inspect = (record) => {
    if (!record || typeof record !== "object") return;
    for (const [key, value] of Object.entries(record)) {
      if (typeof value !== "string" || !/(?:file|path|root|location|origin)$/i.test(key)) continue;
      const relative = value.replace(/\\/g, "/");
      if (portableAbsolute(value) || relative.includes("../")) {
        throw new Error("Graphify graph.json contains an absolute or private path");
      }
      if (key === "source_file" && !allowed.has(relative)) {
        throw new Error(`Graphify graph.json names a non-allowlisted source file: ${relative}`);
      }
    }
  };
  graph.nodes.forEach(inspect);
  graph.links.forEach(inspect);
  if (Array.isArray(graph.hyperedges)) graph.hyperedges.forEach(inspect);
  return graph;
}

function gitSnapshotCommit(sourceRoot, { spawnSync = cp.spawnSync } = {}) {
  const options = {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 128 * 1024,
    env: {
      PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
  };
  const base = ["--no-optional-locks", "-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`, "-C", sourceRoot];
  const status = spawnSync("git", [...base, "status", "--porcelain=v1", "--untracked-files=normal"], options);
  if (!status || status.status !== 0 || status.error || String(status.stdout || "").trim()) return null;
  const head = spawnSync("git", [...base, "rev-parse", "--verify", "HEAD^{commit}"], options);
  if (!head || head.status !== 0 || head.error) return null;
  const commit = String(head.stdout || "").trim().toLowerCase();
  return /^[a-f0-9]{40,64}$/.test(commit) ? commit : null;
}

function allowedGraphSources(files) {
  const result = new Set(["."]);
  for (const file of files) {
    result.add(file);
    let parent = path.posix.dirname(file);
    while (parent && parent !== ".") {
      result.add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  return result;
}

function validateSnapshotGraph(raw, files, forms, snapshot) {
  rejectSensitiveOutput(raw, forms, "Graphify graph.json");
  let graph;
  try { graph = JSON.parse(raw); }
  catch (error) { throw new Error(`Graphify graph.json is invalid JSON (${error.message})`); }
  if (!graph || typeof graph !== "object" || !Array.isArray(graph.nodes) || !Array.isArray(graph.links)) {
    throw new Error("Graphify graph.json is missing nodes or links");
  }
  if (graph.nodes.length < 1) throw new Error("Graphify graph.json contains no nodes");
  if (graph.nodes.length > GRAPHIFY_FOLDER_LIMITS.maxNodes) {
    throw new Error(`Graphify graph.json exceeds the ${GRAPHIFY_FOLDER_LIMITS.maxNodes}-node interactive HTML limit; choose a narrower folder`);
  }
  const sources = allowedGraphSources(files);
  const ids = new Set();
  const inspect = (record) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("Graphify graph.json contains an invalid record");
    for (const [key, value] of Object.entries(record)) {
      if (typeof value !== "string" || !/(?:file|path|root|location|origin)$/i.test(key)) continue;
      const relative = value.replace(/\\/g, "/");
      if (portableAbsolute(value) || relative === ".." || relative.startsWith("../") || relative.includes("/../")) {
        throw new Error("Graphify graph.json contains an absolute or private path");
      }
      if (key === "source_file" && !sources.has(relative)) {
        throw new Error(`Graphify graph.json names a non-snapshot source file: ${relative}`);
      }
    }
  };
  for (const node of graph.nodes) {
    inspect(node);
    const id = node && typeof node.id === "string" ? node.id : "";
    if (!id || ids.has(id)) throw new Error("Graphify graph.json contains a missing or duplicate node id");
    ids.add(id);
  }
  for (const link of graph.links) {
    inspect(link);
    if (!ids.has(String(link.source || "")) || !ids.has(String(link.target || ""))) {
      throw new Error("Graphify graph.json contains a link to a missing node");
    }
    const confidence = String(link.confidence || "").toUpperCase();
    link.confidence = ["EXTRACTED", "INFERRED", "AMBIGUOUS"].includes(confidence) ? confidence : "AMBIGUOUS";
  }
  if (Array.isArray(graph.hyperedges)) graph.hyperedges.forEach(inspect);
  graph.graph = graph.graph && typeof graph.graph === "object" && !Array.isArray(graph.graph) ? graph.graph : {};
  graph.graph.agenthost_snapshot = snapshot;
  return graph;
}

function publicGraphifyReport(report, plan, snapshot, forms) {
  let safe = replaceSensitiveForms(report, forms);
  safe = safe.replace(new RegExp(OUTPUT_PATH_RE.source, "gi"), "<path>");
  rejectSensitiveOutput(safe, forms, "Graphify GRAPH_REPORT.md");
  const clean = (value) => String(value || "").replace(/[\r\n|]/g, " ").trim().slice(0, 160);
  return [
    "# Graphify snapshot",
    "",
    `- Target: ${clean(plan.target.label)}`,
    `- Folder: ${clean(plan.folder.label)}`,
    `- ${snapshot.kind === "git" ? "Commit" : "Folder mtime"}: ${clean(snapshot.value)}`,
    `- Manifest SHA-256: ${snapshot.manifestSha256}`,
    `- Built: ${snapshot.builtAt}`,
    "- Derived snapshot: source files and explicit links win on disagreement.",
    "",
    safe.trim(),
    "",
  ].join("\n");
}

async function runGraphifySnapshot({
  plan: rawPlan,
  secretValues = inheritedSecretValues(process.env),
  fileMetadata = null,
  packageDir = GRAPHIFY_PACKAGE_DIR,
  runnerScript = GRAPHIFY_FOLDER_RUNNER,
  tmpRoot = os.tmpdir(),
  buildCommand = buildGraphifySnapshotCommand,
  execute = runBoundedCommand,
  renderHtml = renderGraphifyHtml,
  now = () => new Date(),
  getGitCommit = gitSnapshotCommit,
  signal = null,
} = {}) {
  throwIfGraphifyAborted(signal, "Graphify snapshot was cancelled before start", { conclusiveNoChild: true });
  const plan = normalizeCorpusPlan(rawPlan);
  const forms = secretForms(secretValues);
  const beforeCommit = plan.snapshotKind === "git" ? getGitCommit(plan.sourceRoot) : null;
  const jobRoot = fs.mkdtempSync(path.join(tmpRoot, "agenthost-graphify-folder-"));
  const inputDir = path.join(jobRoot, "source");
  const scratchDir = path.join(jobRoot, "scratch");
  fs.mkdirSync(inputDir, { mode: 0o700 });
  fs.mkdirSync(scratchDir, { mode: 0o700 });
  let terminationUnproven = false;
  try {
    const materialized = materializeCorpusSnapshot(plan, inputDir, forms, { fileMetadata });
    const afterCommit = beforeCommit ? getGitCommit(plan.sourceRoot) : null;
    const gitCommit = beforeCommit && afterCommit === beforeCommit ? beforeCommit : null;
    const built = now();
    if (!(built instanceof Date) || !Number.isFinite(built.getTime())) throw new Error("Graphify build clock is invalid");
    const snapshot = Object.freeze({
      kind: gitCommit ? "git" : "folder",
      value: gitCommit || new Date(materialized.maxMtimeMs).toISOString(),
      manifestSha256: materialized.manifestSha256,
      builtAt: built.toISOString(),
      derived: true,
      // Named in the receipt the operator actually reads. Returning this from
      // materializeCorpusSnapshot was not enough -- the caller used only
      // maxMtimeMs and manifestSha256, so skipped files went nowhere and the
      // map looked complete. A partial corpus that cannot say what is missing
      // is worse than the total failure this replaced. (Kimi, PR #424.)
      ...(materialized.unreadable.length ? {
        unreadable: materialized.unreadable.map((entry) => entry.relative).slice(0, 20),
        unreadableCount: materialized.unreadable.length,
      } : {}),
    });
    for (const stage of ["extract", "cluster"]) {
      throwIfGraphifyAborted(signal, `Graphify ${stage} was cancelled before start`, { conclusiveNoChild: true });
      let command;
      try { command = buildCommand({ stage, inputDir, scratchDir, packageDir, runnerScript }); }
      catch (error) { throw new Error(`Graphify ${stage} setup failed: ${sensitiveCause(error.message, forms)}`); }
      try {
        await execute(command, {
          stage,
          inputDir,
          scratchDir,
          timeoutMs: GRAPHIFY_FOLDER_LIMITS.timeoutMs,
          killGraceMs: GRAPHIFY_FOLDER_LIMITS.killGraceMs,
          maxOutputBytes: GRAPHIFY_FOLDER_LIMITS.maxProcessOutputBytes,
          signal,
        });
        throwIfGraphifyAborted(signal, `Graphify ${stage} was cancelled after child close`);
      } catch (error) {
        const words = error && error.stderr ? error.stderr : error && error.message ? error.message : error;
        const cancelled = Boolean(error && (error.cancelled || error.code === "GRAPHIFY_CANCELLED" || error.name === "AbortError"));
        const wrapped = new Error(`Graphify ${stage} ${cancelled ? "cancelled" : "failed"}: ${sensitiveCause(words, forms) || "no cause was reported"}`, { cause: error });
        if (cancelled) {
          wrapped.name = "AbortError";
          wrapped.code = "GRAPHIFY_CANCELLED";
          wrapped.cancelled = true;
        }
        if (error && error.terminationUnproven) {
          wrapped.terminationUnproven = true;
          terminationUnproven = true;
        }
        if (error && error.conclusiveNoChild) wrapped.conclusiveNoChild = true;
        throw wrapped;
      }
    }
    const output = path.join(scratchDir, "graphify-out");
    const rawReport = readBounded(path.join(output, "GRAPH_REPORT.md"), GRAPHIFY_FOLDER_LIMITS.maxReportBytes, "Graphify GRAPH_REPORT.md");
    const rawGraph = readBounded(path.join(output, "graph.json"), GRAPHIFY_FOLDER_LIMITS.maxGraphBytes, "Graphify graph.json");
    const fileNames = materialized.files.map((entry) => entry.relative);
    const graph = validateSnapshotGraph(rawGraph, fileNames, forms, snapshot);
    const graphRaw = JSON.stringify(graph);
    if (Buffer.byteLength(graphRaw) > GRAPHIFY_FOLDER_LIMITS.maxGraphBytes) throw new Error("Graphify stamped graph.json exceeds its output cap");
    const report = publicGraphifyReport(rawReport, plan, snapshot, forms);
    if (Buffer.byteLength(report) > GRAPHIFY_FOLDER_LIMITS.maxReportBytes) throw new Error("Graphify stamped report exceeds its output cap");
    const html = renderHtml({
      graph,
      title: `${plan.target.label} — ${plan.folder.label}`,
      targetLabel: plan.target.label,
      folderLabel: plan.folder.label,
      snapshot,
    });
    if (typeof html !== "string" || !html || Buffer.byteLength(html) > GRAPHIFY_FOLDER_LIMITS.maxHtmlBytes) {
      throw new Error("Graphify interactive HTML exceeds its output cap or is empty");
    }
    rejectSensitiveOutput(html, forms, "Graphify interactive HTML");
    return {
      target: plan.target,
      folder: plan.folder,
      snapshot,
      counts: {
        files: materialized.files.length,
        inputBytes: materialized.inputBytes,
        nodes: graph.nodes.length,
        links: graph.links.length,
      },
      graph,
      graphRaw,
      report,
      html,
    };
  } finally {
    if (!terminationUnproven) fs.rmSync(jobRoot, { recursive: true, force: true });
  }
}

function validatePrivateResultRoot(parent) {
  let parentStat;
  try { parentStat = fs.lstatSync(parent); }
  catch (error) { throw new Error(`Graphify result parent is unavailable (${error.code || error.message})`); }
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error("Graphify result parent must be a real directory");
  if (process.platform !== "win32" && (parentStat.uid !== process.getuid() || (parentStat.mode & 0o077) !== 0)) {
    throw new Error("Graphify result parent must be private to the gate identity");
  }
}

function validateResultDestination(resultDir) {
  if (typeof resultDir !== "string" || !path.isAbsolute(resultDir)) throw new Error("Graphify result directory must be absolute");
  const name = path.basename(resultDir);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(name)) throw new Error("Graphify result directory name is unsafe");
  const parent = path.dirname(resultDir);
  validatePrivateResultRoot(parent);
  if (fs.existsSync(resultDir)) throw new Error("Graphify result directory already exists");
}

function prepareGraphifyResultRoot(resultRoot) {
  validatePrivateResultRoot(resultRoot);
  const results = [];
  for (const name of fs.readdirSync(resultRoot)) {
    if (!/^[a-f0-9]{32}$/.test(name)) continue;
    const target = path.join(resultRoot, name);
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Graphify retained result is not a real directory: ${name}`);
    }
    results.push({ name, target, mtimeMs: stat.mtimeMs });
  }
  results.sort((left, right) => right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name));
  for (const stale of results.slice(GRAPHIFY_LIMITS.maxRetainedResults - 1)) {
    fs.rmSync(stale.target, { recursive: true, force: false });
  }
}

function publishResult(resultDir, report, graphRaw) {
  validateResultDestination(resultDir);
  fs.mkdirSync(resultDir, { mode: 0o700 });
  try {
    fs.writeFileSync(path.join(resultDir, "GRAPH_REPORT.md"), report, { flag: "wx", mode: 0o600 });
    fs.writeFileSync(path.join(resultDir, "graph.json"), graphRaw, { flag: "wx", mode: 0o600 });
  } catch (error) {
    fs.rmSync(resultDir, { recursive: true, force: true });
    throw error;
  }
}

async function runGraphifyCodeMap({
  sourceRoot,
  resultDir,
  files = AGENTHOST_PHASE1_FILES,
  secretValues = inheritedSecretValues(process.env),
  packageDir = GRAPHIFY_PACKAGE_DIR,
  tmpRoot = os.tmpdir(),
  buildCommand = buildGraphifyCommand,
  execute = runBoundedCommand,
} = {}) {
  const allowedFiles = normalizeFiles(files);
  const forms = secretForms(secretValues);
  validateResultDestination(resultDir);
  const jobRoot = fs.mkdtempSync(path.join(tmpRoot, "agenthost-graphify-"));
  const inputDir = path.join(jobRoot, "source");
  const scratchDir = path.join(jobRoot, "scratch");
  fs.mkdirSync(inputDir, { mode: 0o700 });
  fs.mkdirSync(scratchDir, { mode: 0o700 });
  let terminationUnproven = false;
  try {
    const inputBytes = copyAllowlistedSource(sourceRoot, inputDir, allowedFiles, forms);
    for (const stage of ["extract", "cluster"]) {
      let command;
      try { command = buildCommand({ stage, inputDir, scratchDir, packageDir }); }
      catch (error) { throw new Error(`Graphify ${stage} setup failed: ${sensitiveCause(error.message, forms)}`); }
      try { await execute(command, { stage, inputDir, scratchDir }); }
      catch (error) {
        const words = error && error.stderr ? error.stderr : error && error.message ? error.message : error;
        const wrapped = new Error(`Graphify ${stage} failed: ${sensitiveCause(words, forms) || "no cause was reported"}`, { cause: error });
        if (error && error.terminationUnproven) {
          wrapped.terminationUnproven = true;
          terminationUnproven = true;
        }
        if (error && error.conclusiveNoChild) wrapped.conclusiveNoChild = true;
        throw wrapped;
      }
    }
    const output = path.join(scratchDir, "graphify-out");
    const report = readBounded(path.join(output, "GRAPH_REPORT.md"), GRAPHIFY_LIMITS.maxReportBytes, "Graphify GRAPH_REPORT.md");
    const graphRaw = readBounded(path.join(output, "graph.json"), GRAPHIFY_LIMITS.maxGraphBytes, "Graphify graph.json");
    rejectSensitiveOutput(report, forms, "Graphify GRAPH_REPORT.md");
    const graph = validateGraph(graphRaw, allowedFiles, forms);
    publishResult(resultDir, report, graphRaw);
    return {
      report,
      reportPath: path.join(resultDir, "GRAPH_REPORT.md"),
      privateGraphPath: path.join(resultDir, "graph.json"),
      fileCount: allowedFiles.length,
      inputBytes,
      nodeCount: graph.nodes.length,
      linkCount: graph.links.length,
    };
  } finally {
    // Never mutate a directory beneath a process whose death was not observed.
    // The gate must quarantine the shared lane; a box restart clears this /tmp.
    if (!terminationUnproven) fs.rmSync(jobRoot, { recursive: true, force: true });
  }
}

module.exports = {
  GRAPHIFY_IDENTITY,
  GRAPHIFY_LIMITS,
  GRAPHIFY_FOLDER_LIMITS,
  AGENTHOST_PHASE1_FILES,
  buildGraphifyCommand,
  buildGraphifySnapshotCommand,
  gitSnapshotCommit,
  materializeCorpusSnapshot,
  prepareGraphifyResultRoot,
  runBoundedCommand,
  runGraphifyCodeMap,
  runGraphifySnapshot,
};
