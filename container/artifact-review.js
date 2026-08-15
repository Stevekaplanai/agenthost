// Creative review state is gate-owned data, never agent-authored artifact data.
// Each sidecar binds one operator decision to the exact SHA-256 of the artifact
// bytes that were reviewed. If the author changes those bytes, the listing no
// longer shows the old decision.
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const REVIEW_STATES = Object.freeze(["approved", "rejected", "changes-requested"]);
const REVIEW_STATE_SET = new Set(REVIEW_STATES);
const SAFE_BASENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,179}\.(?:html|md)$/i;
const CATEGORY_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const CONTENT_VERSION_RE = /^[a-f0-9]{64}$/;
const OPERATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const TASK_ID_RE = /^(?!-)[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SIDECAR_MAX_BYTES = 4096;
const OPERATION_RECEIPT_MAX = 2048;
const OPERATION_RECEIPT_RE = /^[a-f0-9]{64}\.operation\.json$/;
const DEFAULT_REVIEW_DIR = "/data/agenthost-gate-state/artifact-reviews";
const DIGEST_CACHE_MAX = 256;
const artifactDigestCache = new Map();
const HTML_NON_MARKUP_ELEMENTS = new Set([
  "script", "style", "template", "noscript", "title", "textarea", "xmp",
  "iframe", "noembed", "plaintext",
]);

function normalizeReviewState(value) {
  const review = typeof value === "string" ? value.trim().toLowerCase() : "";
  return REVIEW_STATE_SET.has(review) ? review : null;
}

function requireReviewState(value) {
  const review = normalizeReviewState(value);
  if (!review) throw new TypeError("artifact review must be approved, rejected, or changes-requested");
  return review;
}

function validateArtifactBasename(value) {
  const name = typeof value === "string" ? value : "";
  if (!SAFE_BASENAME_RE.test(name) || path.basename(name) !== name) {
    throw new TypeError("artifact name must be a safe ASCII .html or .md basename");
  }
  return name;
}

function validateArtifactContentVersion(value) {
  const version = typeof value === "string" ? value : "";
  if (!CONTENT_VERSION_RE.test(version)) {
    throw new TypeError("artifact content version must be exactly 64 lowercase hexadecimal characters");
  }
  return version;
}

function validateOperationId(value) {
  const operationId = typeof value === "string" ? value : "";
  if (!OPERATION_ID_RE.test(operationId)) {
    throw new TypeError("artifact review operation id must be 16 to 128 safe ASCII characters");
  }
  return operationId;
}

function statValue(stat, precise, fallback) {
  const value = stat[precise] === undefined ? stat[fallback] : stat[precise];
  return String(value);
}

// This opaque token names one kernel-observed file version without revealing
// its inode/timestamps. ctime + inode prevent an agent from rewriting bytes,
// restoring mtime/size, and retaining the token it received from the gate.
function artifactContentVersion(stat) {
  const fields = [
    statValue(stat, "dev", "dev"),
    statValue(stat, "ino", "ino"),
    statValue(stat, "size", "size"),
    statValue(stat, "mtimeNs", "mtimeMs"),
    statValue(stat, "ctimeNs", "ctimeMs"),
    statValue(stat, "birthtimeNs", "birthtimeMs"),
  ];
  return crypto.createHash("sha256").update(`artifact-file-v1\n${fields.join("\n")}`).digest("hex");
}

function artifactVersionChangedError() {
  const error = new Error("artifact changed since this Creative list loaded; refresh and review the new version");
  error.code = "ARTIFACT_VERSION_CHANGED";
  return error;
}

function sameFileVersion(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && statValue(left, "mtimeNs", "mtimeMs") === statValue(right, "mtimeNs", "mtimeMs")
    && statValue(left, "ctimeNs", "ctimeMs") === statValue(right, "ctimeNs", "ctimeMs")
    && statValue(left, "birthtimeNs", "birthtimeMs") === statValue(right, "birthtimeNs", "birthtimeMs");
}

function cacheArtifactDigest(file, stat, digest) {
  artifactDigestCache.delete(file);
  artifactDigestCache.set(file, { stat, digest });
  while (artifactDigestCache.size > DIGEST_CACHE_MAX) {
    artifactDigestCache.delete(artifactDigestCache.keys().next().value);
  }
}

// A cache hit still pins and versions the leaf with O_NOFOLLOW. Only the byte
// read/hash is skipped. ctimeNs + inode make an in-place edit or replacement a
// miss even when an author restores the visible mtime and keeps the same size.
function cachedArtifactSnapshot(rootDir, rawName, maxBytes, expectedVersion = null) {
  const name = validateArtifactBasename(rawName);
  const root = path.resolve(String(rootDir || ""));
  inspectDirectory(root, "artifact root");
  const file = path.join(root, name);
  const cached = artifactDigestCache.get(file);
  if (!cached) return null;

  let leaf;
  try { leaf = fs.lstatSync(file, { bigint: true }); }
  catch { artifactDigestCache.delete(file); return null; }
  if (leaf.isSymbolicLink() || !leaf.isFile() || leaf.size > BigInt(maxBytes)
    || !sameFileVersion(leaf, cached.stat)) {
    artifactDigestCache.delete(file);
    return null;
  }

  let descriptor = null;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || !sameFileVersion(leaf, before)) return null;
    const after = fs.fstatSync(descriptor, { bigint: true });
    const current = fs.lstatSync(file, { bigint: true });
    if (!sameFileVersion(before, after) || current.isSymbolicLink() || !sameFileVersion(after, current)) return null;
    const contentVersion = artifactContentVersion(after);
    if (expectedVersion && contentVersion !== expectedVersion) throw artifactVersionChangedError();
    artifactDigestCache.delete(file);
    artifactDigestCache.set(file, cached);
    return Object.freeze({
      name,
      ext: path.extname(name).toLowerCase(),
      digest: cached.digest,
      contentVersion,
      size: Number(after.size),
      mtimeMs: Number(after.mtimeNs) / 1e6,
    });
  } catch (error) {
    if (error && error.code === "ARTIFACT_VERSION_CHANGED") throw error;
    if (error && (error.code === "ELOOP" || error.code === "EMLINK")) artifactDigestCache.delete(file);
    return null;
  } finally {
    if (descriptor !== null) { try { fs.closeSync(descriptor); } catch {} }
  }
}

function readBoundedDescriptor(descriptor, maxBytes, label) {
  const chunks = [];
  let total = 0;
  while (true) {
    const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - total));
    const count = fs.readSync(descriptor, chunk, 0, chunk.length, null);
    if (count === 0) break;
    total += count;
    if (total > maxBytes) throw new Error(`${label} exceeds the ${maxBytes}-byte limit`);
    chunks.push(chunk.subarray(0, count));
  }
  return Buffer.concat(chunks, total);
}

function inspectDirectory(directory, label) {
  let stat;
  try { stat = fs.lstatSync(directory); }
  catch (error) {
    if (error && error.code === "ENOENT") throw new Error(`${label} is missing`);
    throw new Error(`${label} could not be inspected`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} is not a regular directory`);
  return stat;
}

function readArtifactHeadSnapshot(rootDir, rawName, options = {}) {
  const name = validateArtifactBasename(rawName);
  const root = path.resolve(String(rootDir || ""));
  inspectDirectory(root, "artifact root");
  const file = path.join(root, name);
  const maxBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes >= 0
    ? options.maxBytes
    : 8 * 1024 * 1024;
  const headBytes = Number.isSafeInteger(options.headBytes) && options.headBytes >= 0
    ? Math.min(options.headBytes, maxBytes)
    : Math.min(8192, maxBytes);

  let leaf;
  try { leaf = fs.lstatSync(file, { bigint: true }); }
  catch (error) {
    if (error && error.code === "ENOENT") throw new Error("artifact not found");
    throw new Error(`artifact could not be inspected: ${error.message}`);
  }
  if (leaf.isSymbolicLink()) throw new Error("artifact is a symbolic link");
  if (!leaf.isFile()) throw new Error("artifact is not a regular file");
  if (leaf.size > BigInt(maxBytes)) throw new Error(`artifact exceeds the ${maxBytes}-byte limit`);

  let descriptor = null;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) throw new Error("artifact is not a regular file");
    if (!sameFileVersion(leaf, before)) throw new Error("artifact changed before it could be read; try again");
    if (before.size > BigInt(maxBytes)) throw new Error(`artifact exceeds the ${maxBytes}-byte limit`);
    const length = Math.min(headBytes, Number(before.size));
    const bytes = Buffer.alloc(length);
    const count = length ? fs.readSync(descriptor, bytes, 0, length, 0) : 0;
    const after = fs.fstatSync(descriptor, { bigint: true });
    const current = fs.lstatSync(file, { bigint: true });
    if (!sameFileVersion(before, after) || current.isSymbolicLink() || !sameFileVersion(after, current)) {
      throw new Error("artifact changed while it was being read; try again");
    }
    return Object.freeze({
      name,
      ext: path.extname(name).toLowerCase(),
      text: bytes.subarray(0, count).toString("utf8"),
      contentVersion: artifactContentVersion(after),
      size: Number(after.size),
      mtimeMs: Number(after.mtimeNs) / 1e6,
    });
  } catch (error) {
    if (error && (error.code === "ELOOP" || error.code === "EMLINK")) throw new Error("artifact is a symbolic link");
    throw error;
  } finally {
    if (descriptor !== null) { try { fs.closeSync(descriptor); } catch {} }
  }
}

function readArtifactSnapshot(rootDir, rawName, options = {}) {
  const name = validateArtifactBasename(rawName);
  const root = path.resolve(String(rootDir || ""));
  inspectDirectory(root, "artifact root");
  const file = path.join(root, name);
  const maxBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes >= 0
    ? options.maxBytes
    : 8 * 1024 * 1024;
  const expectedVersion = options.expectedVersion === undefined
    ? null
    : validateArtifactContentVersion(options.expectedVersion);

  let leaf;
  try { leaf = fs.lstatSync(file, { bigint: true }); }
  catch (error) {
    if (error && error.code === "ENOENT") throw new Error("artifact not found");
    throw new Error(`artifact could not be inspected: ${error.message}`);
  }
  if (leaf.isSymbolicLink()) throw new Error("artifact is a symbolic link");
  if (!leaf.isFile()) throw new Error("artifact is not a regular file");
  if (leaf.size > BigInt(maxBytes)) throw new Error(`artifact exceeds the ${maxBytes}-byte limit`);

  let descriptor = null;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) throw new Error("artifact is not a regular file");
    if (!sameFileVersion(leaf, before)) throw new Error("artifact changed before it could be read; try again");
    if (before.size > BigInt(maxBytes)) throw new Error(`artifact exceeds the ${maxBytes}-byte limit`);
    const contentVersion = artifactContentVersion(before);
    if (expectedVersion && contentVersion !== expectedVersion) throw artifactVersionChangedError();
    const bytes = readBoundedDescriptor(descriptor, maxBytes, "artifact");
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (!sameFileVersion(before, after) || BigInt(bytes.length) !== after.size) {
      throw new Error("artifact changed while it was being read; try again");
    }
    const current = fs.lstatSync(file, { bigint: true });
    if (current.isSymbolicLink() || !sameFileVersion(after, current)) {
      throw new Error("artifact changed while it was being read; try again");
    }
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error("artifact is not valid UTF-8");
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    cacheArtifactDigest(file, after, digest);
    return Object.freeze({
      name,
      ext: path.extname(name).toLowerCase(),
      bytes,
      text,
      digest,
      contentVersion,
      size: Number(after.size),
      mtimeMs: Number(after.mtimeNs) / 1e6,
    });
  } catch (error) {
    if (error && (error.code === "ELOOP" || error.code === "EMLINK")) {
      throw new Error("artifact is a symbolic link");
    }
    throw error;
  } finally {
    if (descriptor !== null) { try { fs.closeSync(descriptor); } catch {} }
  }
}

function htmlTagEnd(source, start) {
  let quote = null;
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === ">") return index + 1;
  }
  return -1;
}

// This is intentionally a narrow metadata scanner, not an HTML renderer. It
// sees tags in the real document structure and skips every HTML context where
// markup-looking text is data (including RCDATA and legacy raw-text elements).
function htmlMarkupTags(source, start, end, stop) {
  const tags = [];
  let index = start;
  while (index < end) {
    const open = source.indexOf("<", index);
    if (open < 0 || open >= end) break;
    if (source.startsWith("<!--", open)) {
      const close = source.indexOf("-->", open + 4);
      if (close < 0 || close >= end) return { tags, complete: false, stopped: null };
      index = close + 3;
      continue;
    }
    if (source.startsWith("<!", open) || source.startsWith("<?", open)) {
      const close = source.indexOf(">", open + 2);
      if (close < 0 || close >= end) return { tags, complete: false, stopped: null };
      index = close + 1;
      continue;
    }
    const tagEnd = htmlTagEnd(source, open);
    if (tagEnd < 0 || tagEnd > end) return { tags, complete: false, stopped: null };
    const raw = source.slice(open, tagEnd);
    const match = /^<\s*(\/?)\s*([a-z0-9:-]+)/i.exec(raw);
    if (!match) { index = tagEnd; continue; }
    const tag = { closing: Boolean(match[1]), name: match[2].toLowerCase(), start: open, end: tagEnd, raw };
    if (!tag.closing && HTML_NON_MARKUP_ELEMENTS.has(tag.name)) {
      if (tag.name === "plaintext") return { tags, complete: true, stopped: null };
      const closeRe = new RegExp(`<\\/\\s*${tag.name}\\s*>`, "ig");
      closeRe.lastIndex = tagEnd;
      const close = closeRe.exec(source);
      if (!close || close.index >= end) return { tags, complete: false, stopped: null };
      index = close.index + close[0].length;
      continue;
    }
    tags.push(tag);
    if (stop && stop(tag)) return { tags, complete: true, stopped: tag };
    index = tagEnd;
  }
  return { tags, complete: true, stopped: null };
}

function htmlAttributes(tag) {
  const attrs = new Map();
  const start = /^<\s*[a-z0-9:-]+/i.exec(tag);
  if (!start) return attrs;
  let index = start[0].length;
  while (index < tag.length) {
    while (/\s/.test(tag[index] || "")) index += 1;
    if (index >= tag.length || tag[index] === ">" || tag[index] === "/") break;
    const nameStart = index;
    while (index < tag.length && !/[\s=/>]/.test(tag[index])) index += 1;
    const name = tag.slice(nameStart, index).toLowerCase();
    while (/\s/.test(tag[index] || "")) index += 1;
    let value = "";
    if (tag[index] === "=") {
      index += 1;
      while (/\s/.test(tag[index] || "")) index += 1;
      const quote = tag[index] === '"' || tag[index] === "'" ? tag[index++] : null;
      const valueStart = index;
      if (quote) {
        while (index < tag.length && tag[index] !== quote) index += 1;
        value = tag.slice(valueStart, index);
        if (tag[index] === quote) index += 1;
      } else {
        while (index < tag.length && !/[\s>]/.test(tag[index])) index += 1;
        value = tag.slice(valueStart, index);
      }
    }
    const values = attrs.get(name) || [];
    values.push(value);
    attrs.set(name, values);
  }
  return attrs;
}

function htmlCategory(source) {
  const open = htmlMarkupTags(source, 0, source.length,
    (tag) => !tag.closing && tag.name === "head");
  if (!open.complete || !open.stopped) return null;
  const close = htmlMarkupTags(source, open.stopped.end, source.length,
    (tag) => tag.closing && tag.name === "head");
  // /artifacts intentionally reads only the first 8 KiB. Metadata that was
  // completely parsed before that boundary remains trustworthy even when the
  // closing head is outside the prefix. Crossing into a real body without a
  // closing head is malformed and fails closed.
  if (!close.stopped && close.tags.some((tag) => !tag.closing && tag.name === "body")) return null;
  const head = close.stopped
    ? htmlMarkupTags(source, open.stopped.end, close.stopped.start)
    : { tags: close.tags, complete: true };
  if (!head.complete) return null;
  const values = [];
  for (const tag of head.tags) {
    if (tag.closing || tag.name !== "meta") continue;
    const attrs = htmlAttributes(tag.raw);
    const names = attrs.get("name");
    if (!names || names.length !== 1 || names[0].toLowerCase() !== "agenthost:category") continue;
    const content = attrs.get("content");
    if (!content || content.length !== 1) return null;
    values.push(content[0]);
  }
  if (values.length !== 1) return null;
  const value = values[0].trim().toLowerCase();
  return CATEGORY_RE.test(value) ? value : null;
}

function markdownCategory(source) {
  const body = source.startsWith("\uFEFF") ? source.slice(1) : source;
  const block = /^---[ \t]*\r?\n([\s\S]{0,4000}?)^---[ \t]*(?:\r?\n|$)/m.exec(body);
  if (!block || block.index !== 0) return null;
  const values = [];
  const re = /^category:[ \t]*(?:"([^"]*)"|'([^']*)'|([^\r\n]*?))[ \t]*$/gm;
  let match;
  while ((match = re.exec(block[1]))) values.push(match[1] ?? match[2] ?? match[3] ?? "");
  if (values.length !== 1) return null;
  const value = values[0].trim().toLowerCase();
  return CATEGORY_RE.test(value) ? value : null;
}

function extractArtifactCategory(source, ext) {
  if (typeof source !== "string") return null;
  const kind = String(ext || "").toLowerCase().replace(/^\./, "");
  if (kind === "html") return htmlCategory(source);
  if (kind === "md") return markdownCategory(source);
  return null;
}

function artifactAdjustmentFingerprint(input) {
  const name = validateArtifactBasename(input && input.name);
  const contentVersion = validateArtifactContentVersion(input && input.contentVersion);
  if (!input || input.action !== "request-adjustments") throw new TypeError("artifact adjustment action is invalid");
  if (typeof input.feedback !== "string" || !input.feedback) throw new TypeError("artifact adjustment feedback is required");
  return crypto.createHash("sha256")
    .update(JSON.stringify([name, contentVersion, "request-adjustments", input.feedback]), "utf8")
    .digest("hex");
}

function normalizeAdjustmentRecord(value) {
  if (!value || typeof value !== "object") return null;
  const operationId = typeof value.operation_id === "string" ? value.operation_id : "";
  const requestSha256 = typeof value.request_sha256 === "string" ? value.request_sha256 : "";
  const task = value.task;
  const taskId = task && typeof task.id === "string" ? task.id : "";
  if (!OPERATION_ID_RE.test(operationId) || !CONTENT_VERSION_RE.test(requestSha256)
    || !task || typeof task !== "object" || !TASK_ID_RE.test(taskId)
    || task.title !== "Revise creative artifact" || task.assignee !== "codex") return null;
  return {
    operationId,
    requestSha256,
    task: { id: taskId, title: "Revise creative artifact", assignee: "codex" },
  };
}

function normalizeAdjustmentInput(value) {
  if (!value || typeof value !== "object") throw new TypeError("artifact adjustment replay contract is invalid");
  const operationId = validateOperationId(value.operationId);
  const requestSha256 = validateArtifactContentVersion(value.requestSha256);
  const task = value.task;
  const taskId = task && typeof task.id === "string" ? task.id : "";
  if (!task || typeof task !== "object" || !TASK_ID_RE.test(taskId)
    || task.title !== "Revise creative artifact" || task.assignee !== "codex") {
    throw new TypeError("artifact adjustment task contract is invalid");
  }
  return { operationId, requestSha256, task: { id: taskId, title: task.title, assignee: task.assignee } };
}

function reviewDirectory(options) {
  return path.resolve(String(options.reviewDir || process.env.AGENTHOST_ARTIFACT_REVIEW_DIR || DEFAULT_REVIEW_DIR));
}

function sidecarPath(name, options = {}) {
  const safeName = validateArtifactBasename(name);
  const key = crypto.createHash("sha256").update(safeName, "utf8").digest("hex");
  return path.join(reviewDirectory(options), `${key}.json`);
}

function operationReceiptPath(operationId, options = {}) {
  const safeId = validateOperationId(operationId);
  const key = crypto.createHash("sha256").update(safeId, "utf8").digest("hex");
  return path.join(reviewDirectory(options), `${key}.operation.json`);
}

function boundedCause(value, fallback = "artifact review state could not be read") {
  return String(value && value.message || value || fallback)
    .replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 180) || fallback;
}

function readSidecarRecord(rawName, options = {}) {
  const name = validateArtifactBasename(rawName);
  const directory = reviewDirectory(options);
  try { inspectDirectory(directory, "artifact review directory"); }
  catch (error) { return { exists: false, row: null, error: boundedCause(error) }; }
  const file = sidecarPath(name, options);
  let leaf;
  try { leaf = fs.lstatSync(file); }
  catch (error) {
    return error && error.code === "ENOENT"
      ? { exists: false, row: null, error: null }
      : { exists: false, row: null, error: "artifact review sidecar could not be inspected" };
  }
  if (leaf.isSymbolicLink()) return { exists: true, row: null, error: "artifact review sidecar is a symbolic link" };
  if (!leaf.isFile()) return { exists: true, row: null, error: "artifact review sidecar is not a regular file" };
  if (leaf.size > SIDECAR_MAX_BYTES) {
    return { exists: true, row: null, error: `artifact review sidecar exceeds the ${SIDECAR_MAX_BYTES}-byte limit` };
  }
  let descriptor = null;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(descriptor);
    if (!before.isFile()) return { exists: true, row: null, error: "artifact review sidecar is not a regular file" };
    if (before.size > SIDECAR_MAX_BYTES) {
      return { exists: true, row: null, error: `artifact review sidecar exceeds the ${SIDECAR_MAX_BYTES}-byte limit` };
    }
    if (!sameFileVersion(leaf, before)) {
      return { exists: true, row: null, error: "artifact review sidecar changed while it was being opened" };
    }
    const bytes = readBoundedDescriptor(descriptor, SIDECAR_MAX_BYTES, "artifact review sidecar");
    const after = fs.fstatSync(descriptor);
    if (!sameFileVersion(before, after) || bytes.length !== after.size) {
      return { exists: true, row: null, error: "artifact review sidecar changed while it was being read" };
    }
    let row;
    try { row = JSON.parse(bytes.toString("utf8")); }
    catch { return { exists: true, row: null, error: "artifact review sidecar is not valid JSON" }; }
    const review = normalizeReviewState(row && row.review);
    const adjustment = row && row.adjustment === undefined ? null : normalizeAdjustmentRecord(row && row.adjustment);
    if (!row || row.version !== 1 || row.artifact !== name
      || !CONTENT_VERSION_RE.test(String(row.content_sha256 || "")) || !review
      || (row.adjustment !== undefined && !adjustment)
      || (adjustment && review !== "changes-requested")) {
      return { exists: true, row: null, error: "artifact review sidecar has an invalid contract" };
    }
    return {
      exists: true,
      row: { artifact: name, content_sha256: row.content_sha256, review, adjustment },
      error: null,
    };
  } catch (error) {
    if (error && (error.code === "ELOOP" || error.code === "EMLINK")) {
      return { exists: true, row: null, error: "artifact review sidecar is a symbolic link" };
    }
    return { exists: true, row: null, error: boundedCause(error) };
  }
  finally { if (descriptor !== null) { try { fs.closeSync(descriptor); } catch {} } }
}

function normalizeOperationReceipt(row) {
  if (!row || typeof row !== "object" || row.version !== 1) return null;
  let operationId;
  let artifact;
  let contentVersion;
  let contentDigest;
  try {
    operationId = validateOperationId(row.operation_id);
    artifact = validateArtifactBasename(row.artifact);
    contentVersion = validateArtifactContentVersion(row.content_version);
    contentDigest = validateArtifactContentVersion(row.content_digest);
  } catch { return null; }
  const requestSha256 = typeof row.request_sha256 === "string" ? row.request_sha256 : "";
  if (!CONTENT_VERSION_RE.test(requestSha256)
    || !["pending", "confirmed", "completed", "failed"].includes(row.status)) return null;
  const task = row.task === undefined ? null : normalizeAdjustmentRecord({
    operation_id: operationId,
    request_sha256: requestSha256,
    task: row.task,
  });
  if ((row.status === "pending" && row.task !== undefined)
    || (row.status !== "pending" && !task)) return null;
  return {
    operationId,
    requestSha256,
    artifact,
    contentVersion,
    contentDigest,
    status: row.status,
    task: task ? task.task : null,
  };
}

function readArtifactAdjustmentOperation(input, options = {}) {
  let operationId;
  let requestSha256;
  try {
    operationId = validateOperationId(input && input.operationId);
    requestSha256 = validateArtifactContentVersion(input && input.requestSha256);
  } catch (error) { return { receipt: null, error: boundedCause(error) }; }
  const directory = reviewDirectory(options);
  try { inspectDirectory(directory, "artifact review directory"); }
  catch (error) { return { receipt: null, error: boundedCause(error) }; }
  const file = operationReceiptPath(operationId, options);
  let leaf;
  try { leaf = fs.lstatSync(file); }
  catch (error) {
    return error && error.code === "ENOENT"
      ? { receipt: null, error: null }
      : { receipt: null, error: "artifact adjustment receipt could not be inspected" };
  }
  if (leaf.isSymbolicLink()) return { receipt: null, error: "artifact adjustment receipt is a symbolic link" };
  if (!leaf.isFile() || leaf.nlink !== 1) return { receipt: null, error: "artifact adjustment receipt is not a private regular file" };
  if (leaf.size > SIDECAR_MAX_BYTES) return { receipt: null, error: "artifact adjustment receipt exceeds its safety limit" };
  let descriptor = null;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || !sameFileVersion(leaf, before)) {
      return { receipt: null, error: "artifact adjustment receipt changed while it was opened" };
    }
    const bytes = readBoundedDescriptor(descriptor, SIDECAR_MAX_BYTES, "artifact adjustment receipt");
    const after = fs.fstatSync(descriptor);
    if (!sameFileVersion(before, after) || bytes.length !== after.size) {
      return { receipt: null, error: "artifact adjustment receipt changed while it was read" };
    }
    let row;
    try { row = JSON.parse(bytes.toString("utf8")); }
    catch { return { receipt: null, error: "artifact adjustment receipt is not valid JSON" }; }
    const receipt = normalizeOperationReceipt(row);
    if (!receipt || receipt.operationId !== operationId) {
      return { receipt: null, error: "artifact adjustment receipt has an invalid contract" };
    }
    if (receipt.requestSha256 !== requestSha256) {
      return { receipt: null, error: "artifact review operation id was already used for a different review request" };
    }
    return { receipt, error: null };
  } catch (error) {
    if (error && (error.code === "ELOOP" || error.code === "EMLINK")) {
      return { receipt: null, error: "artifact adjustment receipt is a symbolic link" };
    }
    return { receipt: null, error: boundedCause(error, "artifact adjustment receipt could not be read") };
  } finally { if (descriptor !== null) { try { fs.closeSync(descriptor); } catch {} } }
}

function syncReviewDirectory(directory) {
  if (process.platform === "win32") return;
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function writeOperationReceipt(receipt, options = {}, exclusive = false) {
  const directory = reviewDirectory(options);
  inspectDirectory(directory, "artifact review directory");
  const file = operationReceiptPath(receipt.operationId, options);
  const task = receipt.task || null;
  const row = Buffer.from(JSON.stringify({
    version: 1,
    operation_id: receipt.operationId,
    request_sha256: receipt.requestSha256,
    artifact: receipt.artifact,
    content_version: receipt.contentVersion,
    content_digest: receipt.contentDigest,
    status: receipt.status,
    ...(task ? { task } : {}),
  }) + "\n", "utf8");
  const temp = path.join(directory,
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`);
  let descriptor = null;
  let published = false;
  try {
    descriptor = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(descriptor, row);
    fs.fsyncSync(descriptor);
    if (exclusive) {
      fs.linkSync(temp, file);
      fs.unlinkSync(temp);
    } else {
      const leaf = fs.lstatSync(file);
      if (leaf.isSymbolicLink() || !leaf.isFile() || leaf.nlink !== 1) {
        throw new Error("artifact adjustment receipt is not a private regular file");
      }
      fs.renameSync(temp, file);
    }
    published = true;
    syncReviewDirectory(directory);
    return true;
  } catch (error) {
    if (exclusive && error && error.code === "EEXIST") return false;
    throw new Error(`could not save artifact adjustment receipt: ${error.message}`);
  } finally {
    if (descriptor !== null) { try { fs.closeSync(descriptor); } catch {} }
    if (!published) { try { fs.unlinkSync(temp); } catch {} }
  }
}

function pruneCompletedOperationReceipts(options = {}) {
  const directory = reviewDirectory(options);
  inspectDirectory(directory, "artifact review directory");
  const names = fs.readdirSync(directory).filter((name) => OPERATION_RECEIPT_RE.test(name));
  if (names.length < OPERATION_RECEIPT_MAX) return;
  const completed = [];
  for (const name of names) {
    const file = path.join(directory, name);
    try {
      const leaf = fs.lstatSync(file);
      if (!leaf.isFile() || leaf.isSymbolicLink() || leaf.nlink !== 1 || leaf.size > SIDECAR_MAX_BYTES) continue;
      const row = JSON.parse(fs.readFileSync(file, "utf8"));
      if (normalizeOperationReceipt(row)?.status === "completed") completed.push({ file, mtimeMs: leaf.mtimeMs });
    } catch {}
  }
  completed.sort((left, right) => left.mtimeMs - right.mtimeMs);
  for (const entry of completed) {
    if (names.length - completed.indexOf(entry) < OPERATION_RECEIPT_MAX) break;
    try { fs.unlinkSync(entry.file); } catch {}
  }
  syncReviewDirectory(directory);
  const remaining = fs.readdirSync(directory).filter((name) => OPERATION_RECEIPT_RE.test(name)).length;
  if (remaining >= OPERATION_RECEIPT_MAX) {
    throw new Error("artifact adjustment receipt limit reached; unresolved operations require operator reconciliation");
  }
}

function beginArtifactAdjustmentOperation(input, options = {}) {
  const operationId = validateOperationId(input && input.operationId);
  const requestSha256 = validateArtifactContentVersion(input && input.requestSha256);
  const artifact = validateArtifactBasename(input && input.artifact);
  const contentVersion = validateArtifactContentVersion(input && input.contentVersion);
  const contentDigest = validateArtifactContentVersion(input && input.contentDigest);
  pruneCompletedOperationReceipts(options);
  const receipt = { operationId, requestSha256, artifact, contentVersion, contentDigest, status: "pending", task: null };
  if (writeOperationReceipt(receipt, options, true)) return { receipt, created: true };
  const prior = readArtifactAdjustmentOperation({ operationId, requestSha256 }, options);
  if (prior.error) throw new Error(prior.error);
  return { receipt: prior.receipt, created: false };
}

function transitionArtifactAdjustmentOperation(input, status, options = {}) {
  if (!["confirmed", "completed", "failed"].includes(status)) throw new TypeError("artifact adjustment receipt status is invalid");
  const operationId = validateOperationId(input && input.operationId);
  const requestSha256 = validateArtifactContentVersion(input && input.requestSha256);
  const prior = readArtifactAdjustmentOperation({ operationId, requestSha256 }, options);
  if (prior.error || !prior.receipt) throw new Error(prior.error || "artifact adjustment receipt is missing");
  const task = normalizeAdjustmentInput({ operationId, requestSha256, task: input.task }).task;
  if (prior.receipt.status === "completed") return prior.receipt;
  if ((status === "confirmed" && prior.receipt.status !== "pending" && prior.receipt.status !== "confirmed")
    || ((status === "completed" || status === "failed") && prior.receipt.status !== "confirmed")) {
    throw new Error("artifact adjustment receipt has an invalid transition");
  }
  if (prior.receipt.task && JSON.stringify(prior.receipt.task) !== JSON.stringify(task)) {
    throw new Error("artifact adjustment receipt task does not match its confirmed task");
  }
  const receipt = { ...prior.receipt, status, task };
  writeOperationReceipt(receipt, options, false);
  return receipt;
}

function reconcileArtifactAdjustmentOperation(input, options = {}) {
  const operationId = validateOperationId(input && input.operationId);
  const requestSha256 = validateArtifactContentVersion(input && input.requestSha256);
  const current = readArtifactAdjustmentOperation({ operationId, requestSha256 }, options);
  if (current.error || !current.receipt) {
    return { receipt: current.receipt, reviewSaved: false, error: current.error };
  }
  const receipt = current.receipt;
  if (receipt.status === "completed") return { receipt, reviewSaved: true, error: null };
  if (receipt.status !== "confirmed") return { receipt, reviewSaved: false, error: null };
  const sidecar = readSidecarRecord(receipt.artifact, options);
  if (sidecar.error) return { receipt, reviewSaved: false, error: sidecar.error };
  const adjustment = sidecar.row && sidecar.row.adjustment;
  const taskMatches = adjustment && receipt.task
    && adjustment.task.id === receipt.task.id
    && adjustment.task.title === receipt.task.title
    && adjustment.task.assignee === receipt.task.assignee;
  const reviewSaved = Boolean(sidecar.exists && sidecar.row
    && sidecar.row.content_sha256 === receipt.contentDigest
    && sidecar.row.review === "changes-requested"
    && adjustment && adjustment.operationId === operationId
    && adjustment.requestSha256 === requestSha256
    && taskMatches);
  if (!reviewSaved) return { receipt, reviewSaved: false, error: null };
  try {
    const completed = transitionArtifactAdjustmentOperation({
      operationId,
      requestSha256,
      task: receipt.task,
    }, "completed", options);
    return { receipt: completed, reviewSaved: true, error: null };
  } catch (error) {
    return { receipt, reviewSaved: true, error: boundedCause(error, "artifact adjustment completion receipt could not be saved") };
  }
}

function readArtifactReview(snapshot, options = {}) {
  const name = validateArtifactBasename(snapshot && snapshot.name);
  if (!/^[a-f0-9]{64}$/.test(String(snapshot.digest || ""))) {
    return { review: null, error: "artifact snapshot has an invalid content digest", stale: false };
  }
  const state = readSidecarRecord(name, options);
  if (state.error || !state.exists) return { review: null, error: state.error, stale: false };
  return state.row.content_sha256 === snapshot.digest
    ? { review: state.row.review, error: null, stale: false }
    : { review: null, error: null, stale: true };
}

// Listing uses this entrypoint. It checks the tiny gate-owned sidecar first and
// fingerprints the artifact only when review state actually exists. Thus a
// directory of 200 fresh 8 MiB artifacts costs bounded head reads, not 1.6 GiB
// of synchronous hashing on the request thread.
function inspectArtifactReview(rootDir, rawName, options = {}) {
  let name;
  try { name = validateArtifactBasename(rawName); }
  catch (error) { return { review: null, error: boundedCause(error), stale: false, snapshot: null } }
  const state = readSidecarRecord(name, options);
  if (state.error || !state.exists) return { review: null, error: state.error, stale: false, snapshot: null };
  try {
    const maxBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes >= 0
      ? options.maxBytes
      : 8 * 1024 * 1024;
    const expectedVersion = options.expectedVersion === undefined
      ? null
      : validateArtifactContentVersion(options.expectedVersion);
    const snapshot = cachedArtifactSnapshot(rootDir, name, maxBytes, expectedVersion)
      || readArtifactSnapshot(rootDir, name, { maxBytes, ...(expectedVersion ? { expectedVersion } : {}) });
    const result = state.row.content_sha256 === snapshot.digest
      ? { review: state.row.review, error: null, stale: false }
      : { review: null, error: null, stale: true };
    return { ...result, snapshot };
  } catch (error) {
    return { review: null, error: boundedCause(error), stale: false, snapshot: null };
  }
}

function readArtifactAdjustmentReplay(snapshot, input, options = {}) {
  const name = validateArtifactBasename(snapshot && snapshot.name);
  if (!CONTENT_VERSION_RE.test(String(snapshot.digest || ""))) {
    return { task: null, error: "artifact snapshot has an invalid content digest" };
  }
  let operationId;
  let requestSha256;
  try {
    operationId = validateOperationId(input && input.operationId);
    requestSha256 = validateArtifactContentVersion(input && input.requestSha256);
  } catch (error) {
    return { task: null, error: boundedCause(error) };
  }
  const state = readSidecarRecord(name, options);
  if (state.error) return { task: null, error: state.error };
  if (!state.exists || state.row.content_sha256 !== snapshot.digest || state.row.review !== "changes-requested") {
    return { task: null, error: null };
  }
  const adjustment = state.row.adjustment;
  if (!adjustment || adjustment.operationId !== operationId) return { task: null, error: null };
  if (adjustment.requestSha256 !== requestSha256) {
    return { task: null, error: "artifact review operation id was already used for a different review request" };
  }
  return { task: adjustment.task, error: null };
}

function writeArtifactReviewSidecar(snapshot, value, options = {}) {
  const review = requireReviewState(value);
  const name = validateArtifactBasename(snapshot && snapshot.name);
  const current = readArtifactSnapshot(options.rootDir, name, { maxBytes: options.maxBytes });
  if (current.digest !== snapshot.digest) throw new Error("artifact changed before its review could be saved; try again");

  const prior = readSidecarRecord(name, options);
  if (prior.error) throw new Error(prior.error);

  const adjustment = options.adjustment === undefined ? null : normalizeAdjustmentInput(options.adjustment);
  if (adjustment && review !== "changes-requested") {
    throw new TypeError("artifact adjustment replay state requires changes-requested review");
  }

  const directory = reviewDirectory(options);
  inspectDirectory(directory, "artifact review directory");
  const file = sidecarPath(name, options);
  const row = Buffer.from(JSON.stringify({
    version: 1,
    artifact: name,
    content_sha256: current.digest,
    review,
    ...(adjustment ? {
      adjustment: {
        operation_id: adjustment.operationId,
        request_sha256: adjustment.requestSha256,
        task: adjustment.task,
      },
    } : {}),
  }) + "\n", "utf8");
  const temp = path.join(directory,
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`);
  let descriptor = null;
  let renamed = false;
  try {
    descriptor = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(descriptor, row);
    fs.fsyncSync(descriptor);
    fs.renameSync(temp, file);
    renamed = true;
    // Durably publish the rename on Linux. Some platforms cannot open a
    // directory descriptor, so the file fsync remains the portable floor.
    if (process.platform !== "win32") {
      const directoryFd = fs.openSync(directory, fs.constants.O_RDONLY);
      try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    }
  } catch (error) {
    throw new Error(`could not save artifact review: ${error.message}`);
  } finally {
    if (descriptor !== null) { try { fs.closeSync(descriptor); } catch {} }
    if (!renamed) { try { fs.unlinkSync(temp); } catch {} }
  }
  return review;
}

module.exports = {
  REVIEW_STATES,
  normalizeReviewState,
  validateArtifactBasename,
  validateArtifactContentVersion,
  validateArtifactReviewOperationId: validateOperationId,
  readArtifactHeadSnapshot,
  readArtifactSnapshot,
  extractArtifactCategory,
  artifactAdjustmentFingerprint,
  readArtifactAdjustmentOperation,
  beginArtifactAdjustmentOperation,
  transitionArtifactAdjustmentOperation,
  reconcileArtifactAdjustmentOperation,
  readArtifactReview,
  readArtifactAdjustmentReplay,
  inspectArtifactReview,
  writeArtifactReviewSidecar,
};
