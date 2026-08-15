"use strict";

// Graphify publication has two audiences: operators may open the self-contained
// HTML and Markdown report, while the structural JSON remains private to gate.
// The private manifest is renamed last and is the commit marker for the pair.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const RUN_ID_RE = /^[a-f0-9]{32}$/;
const GRAPHIFY_ARTIFACT_RE = /^graphify-[a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{32}\.(?:html|md)$/;
const GRAPHIFY_PENDING_ARTIFACT_RE = /^\.(graphify-[a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{32}\.(?:html|md))\.[a-f0-9]{16}\.pending$/;
const GRAPHIFY_PENDING_RUN_RE = /^\.pending-[a-f0-9]{32}-[a-f0-9]{16}$/;
const GRAPHIFY_INTEGRITY_CODE = "GRAPHIFY_INTEGRITY";
const GRAPHIFY_COMMITTED_INVALID_CODE = "GRAPHIFY_COMMITTED_INVALID";
const GRAPHIFY_PENDING_MISMATCH_CODE = "GRAPHIFY_PENDING_MISMATCH";
const GRAPHIFY_COMMIT_UNCERTAIN_CODE = "GRAPHIFY_COMMIT_UNCERTAIN";
const GRAPHIFY_OPERATION_LEASE_INVALID_CODE = "GRAPHIFY_OPERATION_LEASE_INVALID";
const GRAPHIFY_OPERATION_LEASE_UNCERTAIN_CODE = "GRAPHIFY_OPERATION_LEASE_UNCERTAIN";
const MANIFEST_VERSION = 1;
const DEFAULT_RETAIN = 8;
const MAX_PRIVATE_GRAPH_BYTES = 8 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_BRAND_PROJECTION_BYTES = 64 * 1024;
const MAX_BRAND_PROJECTION_INPUT_BYTES = 128 * 1024;
const MAX_RECOVERY_CLEANUP_ENTRIES = 32;
const BRAND_PROJECTION_PENDING = "brand-projection.pending.json";
const BRAND_PROJECTION_COMPLETE = "brand-projection.complete.json";
const BRAND_OPERATION_ID_RE = /^[a-f0-9]{32}$/;
const BRAND_OPERATION_LEASE_RE = /^\.brand-operation-([a-f0-9]{64})$/;
const BRAND_OPERATION_LEASE_PENDING_RE = /^\.pending-brand-operation-([a-f0-9]{64})-([a-f0-9]{32})-([a-f0-9]{16})$/;
const BRAND_OPERATION_LEASE_CLAIM_RE = /^\.claim-brand-operation-([a-f0-9]{64})-([a-f0-9]{32})$/;
const BRAND_OPERATION_LEASE_FILE = "lease.json";
const MAX_BRAND_OPERATION_LEASE_BYTES = 4096;
const BRAND_ACCOUNT_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const BRAND_RECORD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const BRAND_ASSETS = new Set(["guidelines", "voice", "intel", "performance", "calls"]);
const BRAND_ASSET_ORDER = new Map([...BRAND_ASSETS].map((asset, index) => [asset, index]));

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function boundedErrorCause(error) {
  const raw = String(error && (error.code || error.message) || "unknown failure");
  return raw
    .replace(/\b(?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*[^\s,;)]+/gi, "credential=<redacted>")
    .replace(/[A-Za-z]:[\\/][^\s\"'()]+/g, "<path>")
    .replace(/(^|[\s(])\/[^\s\"'()]+/g, "$1<path>")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, 160) || "unknown failure";
}

function graphifyIntegrityError(runId, error) {
  if (error && error.code === GRAPHIFY_INTEGRITY_CODE) return error;
  const result = new Error(`Graphify committed run ${runId} failed integrity verification (${boundedErrorCause(error)})`);
  result.code = GRAPHIFY_INTEGRITY_CODE;
  return result;
}

function graphifyCommittedInvalidError(runId, error) {
  const result = new Error(`Graphify run ${runId} was committed but the store failed integrity verification (${boundedErrorCause(error)})`);
  result.code = GRAPHIFY_COMMITTED_INVALID_CODE;
  result.committed = true;
  result.retrySafe = false;
  result.runId = runId;
  return result;
}

function graphifyPendingMismatchError(runId) {
  const result = new Error("Graphify has an unfinished Brand projection for this account and folder from a different operation or source snapshot");
  result.code = GRAPHIFY_PENDING_MISMATCH_CODE;
  result.retrySafe = false;
  result.runId = runId;
  return result;
}

function graphifyCommitUncertainError(runId, error) {
  const result = new Error(`Graphify run ${runId} reached its commit rename but durability could not be proven (${boundedErrorCause(error)})`);
  result.code = GRAPHIFY_COMMIT_UNCERTAIN_CODE;
  result.committed = true;
  result.retrySafe = false;
  result.runId = runId;
  return result;
}

function graphifyOperationLeaseInvalidError(error) {
  if (error && error.code === GRAPHIFY_OPERATION_LEASE_INVALID_CODE) return error;
  const result = new Error(`Graphify Brand operation lease is invalid (${boundedErrorCause(error)})`);
  result.code = GRAPHIFY_OPERATION_LEASE_INVALID_CODE;
  result.retrySafe = false;
  return result;
}

function graphifyOperationLeaseUncertainError(operationId, action, error) {
  const result = new Error(`Graphify Brand operation lease ${action} durability could not be proven (${boundedErrorCause(error)})`);
  result.code = GRAPHIFY_OPERATION_LEASE_UNCERTAIN_CODE;
  result.operationId = operationId;
  result.retrySafe = true;
  return result;
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function validateRoot(root, label, { privateRoot = false, fsImpl = fs } = {}) {
  if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error(`Graphify ${label} must be absolute`);
  let stat;
  try { stat = fsImpl.lstatSync(root); }
  catch (error) { throw new Error(`Graphify ${label} is unavailable (${error.code || error.message})`); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Graphify ${label} must be a real directory`);
  const resolved = path.resolve(root);
  let real;
  try { real = fsImpl.realpathSync(root); }
  catch (error) { throw new Error(`Graphify ${label} cannot be resolved (${error.code || error.message})`); }
  if (real !== resolved) throw new Error(`Graphify ${label} must match its canonical path`);
  if (privateRoot && process.platform !== "win32") {
    if (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
      throw new Error(`Graphify ${label} must be private to the gate identity`);
    }
  }
  return resolved;
}

function safeRecord(record, label, required) {
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error(`Graphify ${label} is invalid`);
  const copy = {};
  for (const key of required) {
    if (typeof record[key] !== "string" || !record[key] || /[\0\r\n]/.test(record[key])) {
      throw new Error(`Graphify ${label}.${key} is invalid`);
    }
    copy[key] = record[key];
  }
  return copy;
}

function safeLabel(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 160
    || value.trim() !== value || /[<>\\/\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("Graphify target and folder labels must be safe artifact labels");
  }
  return value;
}

function safeBrandUrl(value, label) {
  let url;
  try { url = new URL(String(value || "")); }
  catch { throw new Error(`Graphify Brand ${label} is invalid`); }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) {
    throw new Error(`Graphify Brand ${label} is invalid`);
  }
  return url.href;
}

function safeBrandOperationId(value) {
  if (!BRAND_OPERATION_ID_RE.test(value || "")) {
    throw new Error("Graphify Brand operation id must be 32 lowercase hexadecimal characters");
  }
  return value;
}

function safeBrandProvenance(value, asset) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "generated_at,source_url,source_urls") {
    throw new Error(`Graphify Brand ${asset} provenance is invalid`);
  }
  if (!Array.isArray(value.source_urls) || value.source_urls.length > 5) {
    throw new Error(`Graphify Brand ${asset} provenance is invalid`);
  }
  const generated = new Date(String(value.generated_at || ""));
  if (!Number.isFinite(generated.getTime())) throw new Error(`Graphify Brand ${asset} provenance is invalid`);
  return {
    source_url: safeBrandUrl(value.source_url, `${asset} source URL`),
    source_urls: value.source_urls.map((url) => safeBrandUrl(url, `${asset} source URL`)),
    generated_at: generated.toISOString(),
  };
}

function normalizeBrandProjection(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Graphify Brand projection input is invalid");
  }
  safeBrandOperationId(input.operationId);
  if (Object.keys(input).sort().join(",") !== "accountId,operationId,records"
      || !BRAND_ACCOUNT_ID_RE.test(input.accountId || "")
      || !Array.isArray(input.records) || input.records.length < 1 || input.records.length > BRAND_ASSETS.size) {
    throw new Error("Graphify Brand projection input is invalid");
  }
  const assets = new Set();
  const full = input.records.map((record, index) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new Error(`Graphify Brand projection record ${index + 1} is invalid`);
    }
    const expectedKeys = ["account_id", "asset", "content", "id", "schemaVersion", "source", "updated_at", "version"];
    if (record.provenance !== undefined) expectedKeys.push("provenance");
    if (Object.keys(record).sort().join(",") !== expectedKeys.sort().join(",")) {
      throw new Error(`Graphify Brand projection record ${index + 1} is invalid`);
    }
    if (record.account_id !== input.accountId || !BRAND_ASSETS.has(record.asset) || assets.has(record.asset)
        || !BRAND_RECORD_ID_RE.test(record.id || "") || (record.source !== "client" && record.source !== "generated")
        || typeof record.content !== "string" || record.content.length < 1 || Buffer.byteLength(record.content) > 24 * 1024
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(record.content)
        || !Number.isSafeInteger(record.version) || record.version < 0
        || !Number.isSafeInteger(record.schemaVersion) || record.schemaVersion < 1) {
      throw new Error(`Graphify Brand projection record ${index + 1} is invalid`);
    }
    assets.add(record.asset);
    const updated = new Date(String(record.updated_at || ""));
    if (!Number.isFinite(updated.getTime())) throw new Error(`Graphify Brand projection record ${index + 1} is invalid`);
    if (record.source === "client" && record.provenance !== undefined) {
      throw new Error(`Graphify Brand projection record ${index + 1} is invalid`);
    }
    const provenance = record.source === "generated" ? safeBrandProvenance(record.provenance, record.asset) : null;
    return {
      id: record.id,
      account_id: input.accountId,
      asset: record.asset,
      source: record.source,
      content: record.content,
      version: record.version,
      updated_at: updated.toISOString(),
      schemaVersion: record.schemaVersion,
      ...(provenance ? { provenance } : {}),
    };
  }).sort((left, right) => BRAND_ASSET_ORDER.get(left.asset) - BRAND_ASSET_ORDER.get(right.asset));
  const fingerprintSource = JSON.stringify(full);
  if (Buffer.byteLength(fingerprintSource) > MAX_BRAND_PROJECTION_INPUT_BYTES) {
    throw new Error("Graphify Brand projection input exceeds its byte limit");
  }
  return Object.freeze({
    accountId: input.accountId,
    operationId: input.operationId,
    recordsSha256: sha256(fingerprintSource),
    records: Object.freeze(full.map((record) => Object.freeze({
      account_id: input.accountId,
      asset: record.asset,
      source: record.source,
      ...(record.provenance ? { provenance: Object.freeze(record.provenance) } : {}),
    }))),
  });
}

function slug(value) {
  safeLabel(value);
  const result = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  if (!result) throw new Error("Graphify target and folder labels must be safe artifact labels");
  return result;
}

function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new Error("Graphify snapshot is invalid");
  if (snapshot.kind !== "git" && snapshot.kind !== "folder") throw new Error("Graphify snapshot kind is invalid");
  if (typeof snapshot.value !== "string" || !snapshot.value || snapshot.value.length > 160 || /[\0\r\n]/.test(snapshot.value)) {
    throw new Error("Graphify snapshot value is invalid");
  }
  if (!/^[a-f0-9]{64}$/.test(snapshot.manifestSha256 || "")) throw new Error("Graphify snapshot manifest digest is invalid");
  if (typeof snapshot.builtAt !== "string" || !Number.isFinite(Date.parse(snapshot.builtAt))) {
    throw new Error("Graphify snapshot build time is invalid");
  }
  if (snapshot.derived !== true) throw new Error("Graphify snapshots must be marked derived");
  return Object.freeze({
    kind: snapshot.kind,
    value: snapshot.value,
    manifestSha256: snapshot.manifestSha256,
    builtAt: new Date(snapshot.builtAt).toISOString(),
    derived: true,
  });
}

function validateCounts(counts) {
  const result = {};
  for (const key of ["files", "inputBytes", "nodes", "links"]) {
    if (!Number.isSafeInteger(counts && counts[key]) || counts[key] < 0) throw new Error(`Graphify count ${key} is invalid`);
    result[key] = counts[key];
  }
  return Object.freeze(result);
}

function validateGraphBody(graphRaw, counts, label) {
  if (typeof graphRaw !== "string" || !graphRaw) throw new Error(`Graphify ${label} graph must be non-empty text`);
  if (Buffer.byteLength(graphRaw) > MAX_PRIVATE_GRAPH_BYTES) {
    throw new Error(`Graphify ${label} private graph exceeds its byte limit`);
  }
  let graph;
  try { graph = JSON.parse(graphRaw); }
  catch (error) { throw new Error(`Graphify ${label} graph must be valid JSON (${error.message})`); }
  if (!graph || typeof graph !== "object" || Array.isArray(graph)
      || !Array.isArray(graph.nodes) || !Array.isArray(graph.links)) {
    throw new Error(`Graphify ${label} graph must contain nodes and links arrays`);
  }
  if (counts && (graph.nodes.length !== counts.nodes || graph.links.length !== counts.links)) {
    throw new Error(`Graphify ${label} graph counts must match its nodes and links`);
  }
  return graph;
}

function safeArtifactName(value) {
  return typeof value === "string" && GRAPHIFY_ARTIFACT_RE.test(value) && path.basename(value) === value;
}

function pendingArtifactFinalName(value) {
  if (typeof value !== "string" || path.basename(value) !== value) return null;
  const match = GRAPHIFY_PENDING_ARTIFACT_RE.exec(value);
  return match && safeArtifactName(match[1]) ? match[1] : null;
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function readStableFileSnapshot(file, { label, maxBytes, privateFile = false, fsImpl = fs } = {}) {
  let before;
  let fd;
  try {
    before = fsImpl.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
      || before.size < 1 || before.size > maxBytes) {
      throw new Error("not a bounded single-link regular file");
    }
    if (privateFile && process.platform !== "win32"
      && (before.uid !== process.getuid() || (before.mode & 0o077) !== 0)) {
      throw new Error("not private to the gate identity");
    }
    fd = fsImpl.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fsImpl.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || !sameFile(before, opened)) {
      throw new Error("changed before it could be read");
    }
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fsImpl.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count < 1) throw new Error("ended before its declared size");
      offset += count;
    }
    const extra = Buffer.alloc(1);
    if (fsImpl.readSync(fd, extra, 0, 1, offset) !== 0) throw new Error("grew while it was being read");
    const after = fsImpl.fstatSync(fd);
    const current = fsImpl.lstatSync(file);
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1
      || !sameFile(opened, after) || !sameFile(after, current)) {
      throw new Error("changed while it was being read");
    }
    return Object.freeze({ bytes, stat: after });
  } catch (error) {
    throw new Error(`Graphify ${label} is invalid (${error.code || error.message})`);
  } finally {
    if (fd !== undefined) fsImpl.closeSync(fd);
  }
}

function readStableFile(file, options) {
  return readStableFileSnapshot(file, options).bytes;
}

function safeArtifactRecord(record) {
  return !!record && safeArtifactName(record.name) && Number.isSafeInteger(record.bytes)
    && record.bytes >= 1 && record.bytes <= MAX_PRIVATE_GRAPH_BYTES
    && /^[a-f0-9]{64}$/.test(record.sha256 || "");
}

function readCommittedArtifactSnapshot(root, record, kind, fsImpl) {
  if (!safeArtifactRecord(record)) throw new Error(`Graphify committed ${kind} artifact record is invalid`);
  const file = path.join(root, record.name);
  if (!inside(root, file) || path.dirname(file) !== root) {
    throw new Error(`Graphify committed ${kind} artifact escaped its root`);
  }
  const snapshot = readStableFileSnapshot(file, {
    label: `${kind} artifact ${record.name}`,
    maxBytes: MAX_PRIVATE_GRAPH_BYTES,
    fsImpl,
  });
  if (snapshot.bytes.length !== record.bytes || sha256(snapshot.bytes) !== record.sha256) {
    throw new Error(`Graphify committed ${kind} artifact does not match its manifest`);
  }
  return Object.freeze({
    name: record.name,
    bytes: snapshot.bytes,
    size: snapshot.bytes.length,
    mtimeMs: snapshot.stat.mtimeMs,
    sha256: record.sha256,
  });
}

function snapshotCommittedArtifactPair(artifactsRoot, manifest, fsImpl) {
  const root = validateRoot(artifactsRoot, "artifacts root", { fsImpl });
  const html = readCommittedArtifactSnapshot(root, manifest.artifacts && manifest.artifacts.html, "html", fsImpl);
  const markdown = readCommittedArtifactSnapshot(root, manifest.artifacts && manifest.artifacts.markdown, "markdown", fsImpl);
  return Object.freeze({
    runId: manifest.runId,
    artifacts: Object.freeze({ html, markdown }),
  });
}

function artifactPairMatches(artifactsRoot, manifest, fsImpl) {
  try {
    snapshotCommittedArtifactPair(artifactsRoot, manifest, fsImpl);
    return true;
  } catch {
    return false;
  }
}

function readCommittedManifest(stateRoot, runId, fsImpl = fs) {
  if (!RUN_ID_RE.test(runId)) throw new Error("Graphify run id is invalid");
  const runDir = path.join(stateRoot, runId);
  let runStat;
  try { runStat = fsImpl.lstatSync(runDir); }
  catch (error) { throw new Error(`Graphify committed run ${runId} is unavailable (${error.code || error.message})`); }
  if (!runStat.isDirectory() || runStat.isSymbolicLink()) throw new Error(`Graphify committed run ${runId} is not a real directory`);
  const manifestPath = path.join(runDir, "manifest.json");
  let raw;
  try {
    raw = readStableFile(manifestPath, {
      label: `committed manifest ${runId}`,
      maxBytes: MAX_MANIFEST_BYTES,
      privateFile: true,
      fsImpl,
    }).toString("utf8");
  } catch (error) {
    throw new Error(`Graphify committed manifest ${runId} is invalid (${error.code || error.message})`);
  }
  let manifest;
  try { manifest = JSON.parse(raw); }
  catch (error) { throw new Error(`Graphify committed manifest ${runId} is invalid (${error.message})`); }
  if (!manifest || manifest.version !== MANIFEST_VERSION || manifest.runId !== runId || manifest.derived !== true
    || !manifest.artifacts || !safeArtifactName(manifest.artifacts.html && manifest.artifacts.html.name)
    || !safeArtifactName(manifest.artifacts.markdown && manifest.artifacts.markdown.name)) {
    throw new Error(`Graphify committed manifest ${runId} is invalid`);
  }
  const htmlName = manifest.artifacts.html.name;
  const markdownName = manifest.artifacts.markdown.name;
  if (artifactRunId(htmlName) !== runId || artifactRunId(markdownName) !== runId
      || !htmlName.endsWith(".html") || !markdownName.endsWith(".md") || htmlName === markdownName) {
    throw new Error(`Graphify committed manifest ${runId} artifact names do not match their run`);
  }
  return { runDir, manifest, mtimeMs: runStat.mtimeMs };
}

function brandProjectionDescriptor(manifest) {
  const value = manifest && manifest.brandProjection;
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "accountId,bytes,completeName,operationId,pendingName,recordsSha256,sha256,version"
      || value.version !== 1 || !BRAND_ACCOUNT_ID_RE.test(value.accountId || "")
      || !BRAND_OPERATION_ID_RE.test(value.operationId || "")
      || value.pendingName !== BRAND_PROJECTION_PENDING || value.completeName !== BRAND_PROJECTION_COMPLETE
      || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > MAX_BRAND_PROJECTION_BYTES
      || !/^[a-f0-9]{64}$/.test(value.sha256 || "") || !/^[a-f0-9]{64}$/.test(value.recordsSha256 || "")) {
    throw new Error(`Graphify committed Brand projection ${manifest && manifest.runId || "unknown"} is invalid`);
  }
  return value;
}

function canonicalMarkerRecords(records, accountId) {
  if (!Array.isArray(records) || records.length < 1 || records.length > BRAND_ASSETS.size) {
    throw new Error("Graphify pending Brand projection records are invalid");
  }
  const assets = new Set();
  return records.map((record, index) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new Error(`Graphify pending Brand projection record ${index + 1} is invalid`);
    }
    const expectedKeys = ["account_id", "asset", "source"];
    if (record.provenance !== undefined) expectedKeys.push("provenance");
    if (Object.keys(record).sort().join(",") !== expectedKeys.sort().join(",")
        || record.account_id !== accountId || !BRAND_ASSETS.has(record.asset) || assets.has(record.asset)
        || (record.source !== "client" && record.source !== "generated")
        || (record.source === "client" && record.provenance !== undefined)) {
      throw new Error(`Graphify pending Brand projection record ${index + 1} is invalid`);
    }
    assets.add(record.asset);
    const provenance = record.source === "generated" ? safeBrandProvenance(record.provenance, record.asset) : null;
    return {
      account_id: accountId,
      asset: record.asset,
      source: record.source,
      ...(provenance ? { provenance } : {}),
    };
  }).sort((left, right) => BRAND_ASSET_ORDER.get(left.asset) - BRAND_ASSET_ORDER.get(right.asset));
}

function entryState(file, fsImpl) {
  try {
    const stat = fsImpl.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("not a single-link regular file");
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function readBrandProjectionState(record, fsImpl = fs) {
  const descriptor = brandProjectionDescriptor(record.manifest);
  if (!descriptor) return null;
  const pendingPath = path.join(record.runDir, descriptor.pendingName);
  const completePath = path.join(record.runDir, descriptor.completeName);
  if (!inside(record.runDir, pendingPath) || !inside(record.runDir, completePath)
      || path.dirname(pendingPath) !== record.runDir || path.dirname(completePath) !== record.runDir) {
    throw new Error(`Graphify committed Brand projection ${record.manifest.runId} escaped its run directory`);
  }
  const hasPending = entryState(pendingPath, fsImpl);
  const hasComplete = entryState(completePath, fsImpl);
  if (hasPending === hasComplete) {
    throw new Error(`Graphify committed Brand projection ${record.manifest.runId} has an invalid completion state`);
  }
  const file = hasPending ? pendingPath : completePath;
  const bytes = readStableFile(file, {
    label: `${hasPending ? "pending" : "complete"} Brand projection ${record.manifest.runId}`,
    maxBytes: MAX_BRAND_PROJECTION_BYTES,
    privateFile: true,
    fsImpl,
  });
  if (bytes.length !== descriptor.bytes || sha256(bytes) !== descriptor.sha256) {
    throw new Error(`Graphify ${hasPending ? "pending" : "complete"} Brand projection ${record.manifest.runId} does not match its manifest`);
  }
  let marker;
  try { marker = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch (error) { throw new Error(`Graphify ${hasPending ? "pending" : "complete"} Brand projection ${record.manifest.runId} is invalid (${error.message})`); }
  if (!marker || typeof marker !== "object" || Array.isArray(marker)
      || Object.keys(marker).sort().join(",") !== "accountId,folderId,graphSha256,operationId,records,recordsSha256,runId,snapshotManifestSha256,snapshotSha256,targetId,version"
      || marker.version !== 1 || marker.runId !== record.manifest.runId
      || marker.accountId !== descriptor.accountId || marker.operationId !== descriptor.operationId
      || marker.recordsSha256 !== descriptor.recordsSha256
      || marker.targetId !== (record.manifest.target && record.manifest.target.id)
      || marker.folderId !== (record.manifest.folder && record.manifest.folder.id)
      || marker.snapshotManifestSha256 !== (record.manifest.snapshot && record.manifest.snapshot.manifestSha256)
      || marker.snapshotSha256 !== sha256(JSON.stringify(validateSnapshot(record.manifest.snapshot)))
      || marker.graphSha256 !== (record.manifest.graph && record.manifest.graph.sha256)
      || record.manifest.target && record.manifest.target.kind !== "brand"
      || marker.targetId !== `brand:${marker.accountId}`) {
    throw new Error(`Graphify ${hasPending ? "pending" : "complete"} Brand projection ${record.manifest.runId} is invalid`);
  }
  const records = canonicalMarkerRecords(marker.records, marker.accountId);
  return Object.freeze({
    state: hasPending ? "pending" : "complete",
    descriptor,
    marker: Object.freeze({ ...marker, records: Object.freeze(records) }),
    path: file,
  });
}

function normalizeBrandOperationSelection(input) {
  const { targetId, folderId, accountId } = input || {};
  if (!BRAND_ACCOUNT_ID_RE.test(accountId || "") || targetId !== `brand:${accountId}`
      || typeof folderId !== "string" || !folderId || folderId.length > 160 || /[\0\r\n]/.test(folderId)) {
    throw new Error("Graphify Brand operation selection is invalid");
  }
  return Object.freeze({ targetId, folderId, accountId });
}

function brandOperationSelectionSha256(selection) {
  return sha256(JSON.stringify([selection.targetId, selection.folderId, selection.accountId]));
}

function brandOperationLeaseKey(selection, operationId) {
  return JSON.stringify([selection.targetId, selection.folderId, selection.accountId, operationId]);
}

function brandOperationLeaseSha256(selection, operationId) {
  return sha256(brandOperationLeaseKey(selection, operationId));
}

function operationLeaseDirectoryState(directory, fsImpl) {
  let stat;
  try { stat = fsImpl.lstatSync(directory); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("not a real directory");
  if (process.platform !== "win32"
      && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)) {
    throw new Error("not private to the gate identity");
  }
  return stat;
}

function readGraphifyOperationLeaseDirectory(privateRoot, name, expectedHash, fsImpl, expectedOperationId = null) {
  try {
    const directory = path.join(privateRoot, name);
    if (!inside(privateRoot, directory) || path.dirname(directory) !== privateRoot) throw new Error("escaped its root");
    if (!operationLeaseDirectoryState(directory, fsImpl)) return null;
    const entries = fsImpl.readdirSync(directory).sort();
    if (entries.length !== 1 || entries[0] !== BRAND_OPERATION_LEASE_FILE) {
      throw new Error("does not contain exactly one lease record");
    }
    const bytes = readStableFile(path.join(directory, BRAND_OPERATION_LEASE_FILE), {
      label: "Brand operation lease record",
      maxBytes: MAX_BRAND_OPERATION_LEASE_BYTES,
      privateFile: true,
      fsImpl,
    });
    let lease;
    try { lease = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch (error) { throw new Error(`record is not valid JSON (${error.message})`); }
    if (!lease || typeof lease !== "object" || Array.isArray(lease)
        || Object.keys(lease).sort().join(",") !== "accountId,folderId,operationId,sha256,targetId,version"
        || lease.version !== 1 || !/^[a-f0-9]{64}$/.test(lease.sha256 || "")) {
      throw new Error("record shape is invalid");
    }
    const selection = normalizeBrandOperationSelection(lease);
    const operationId = safeBrandOperationId(lease.operationId);
    if (brandOperationSelectionSha256(selection) !== expectedHash
        || lease.sha256 !== brandOperationLeaseSha256(selection, operationId)
        || expectedOperationId && operationId !== expectedOperationId) {
      throw new Error("record does not match its durable name");
    }
    return Object.freeze({ directory, selection, operationId });
  } catch (error) {
    throw graphifyOperationLeaseInvalidError(error);
  }
}

function readGraphifyOperationLease(privateRoot, selection, fsImpl) {
  const selectionHash = brandOperationSelectionSha256(selection);
  const name = `.brand-operation-${selectionHash}`;
  return readGraphifyOperationLeaseDirectory(privateRoot, name, selectionHash, fsImpl);
}

function readAcknowledgedGraphifyOperation(privateRoot, selection, fsImpl) {
  const selectionHash = brandOperationSelectionSha256(selection);
  const name = `.acked-brand-operation-${selectionHash}`;
  return readGraphifyOperationLeaseDirectory(privateRoot, name, selectionHash, fsImpl);
}

function readGraphifyOperationClaim(privateRoot, selection, fsImpl) {
  const selectionHash = brandOperationSelectionSha256(selection);
  let claim = null;
  for (const name of fsImpl.readdirSync(privateRoot)) {
    const match = BRAND_OPERATION_LEASE_CLAIM_RE.exec(name);
    if (!match || match[1] !== selectionHash) continue;
    if (claim) throw graphifyOperationLeaseInvalidError(new Error("selection has multiple acknowledgement claims"));
    const lease = readGraphifyOperationLeaseDirectory(privateRoot, name, selectionHash, fsImpl);
    if (!lease) throw graphifyOperationLeaseInvalidError(new Error("acknowledgement claim disappeared"));
    claim = Object.freeze({ ...lease, expectedOperationId: match[2] });
  }
  return claim;
}

function recoverGraphifyOperationClaim(privateRoot, selection, fsImpl) {
  const active = readGraphifyOperationLease(privateRoot, selection, fsImpl);
  const claim = readGraphifyOperationClaim(privateRoot, selection, fsImpl);
  if (active && claim) {
    throw graphifyOperationLeaseInvalidError(new Error("selection has active and claimed lease records"));
  }
  if (!claim) return active;

  const finalDirectory = path.join(
    privateRoot, `.brand-operation-${brandOperationSelectionSha256(selection)}`,
  );
  try {
    fsImpl.renameSync(claim.directory, finalDirectory);
    fsyncDirectory(fsImpl, privateRoot, "Brand operation lease root after claim recovery");
  } catch (error) {
    const current = readGraphifyOperationLease(privateRoot, selection, fsImpl);
    const remaining = readGraphifyOperationClaim(privateRoot, selection, fsImpl);
    if (current && !remaining && current.operationId === claim.operationId) {
      try { fsyncDirectory(fsImpl, privateRoot, "Brand operation lease root after concurrent claim recovery"); }
      catch (syncError) { throw graphifyOperationLeaseUncertainError(claim.operationId, "claim recovery", syncError); }
      return current;
    }
    if (current || remaining) {
      throw graphifyOperationLeaseInvalidError(new Error("acknowledgement claim recovery conflicted with another lease"));
    }
    throw graphifyOperationLeaseUncertainError(claim.operationId, "claim recovery", error);
  }
  return Object.freeze({ ...claim, directory: finalDirectory });
}

function recoverAcknowledgedGraphifyOperation(privateRoot, selection, operationId, fsImpl) {
  const acknowledged = readAcknowledgedGraphifyOperation(privateRoot, selection, fsImpl);
  if (!acknowledged || acknowledged.operationId !== operationId) return false;
  try {
    fsyncDirectory(fsImpl, acknowledged.directory, "acknowledged Brand operation lease directory");
    fsyncDirectory(fsImpl, privateRoot, "Brand operation lease root after acknowledged retry");
  } catch (error) {
    throw graphifyOperationLeaseUncertainError(operationId, "acknowledgement recovery", error);
  }
  return true;
}

function readGraphifyOperationLeases(privateRoot, fsImpl) {
  const leases = [];
  const selections = new Set();
  for (const name of fsImpl.readdirSync(privateRoot)) {
    const match = BRAND_OPERATION_LEASE_RE.exec(name) || BRAND_OPERATION_LEASE_CLAIM_RE.exec(name);
    if (!match) continue;
    if (selections.has(match[1])) {
      throw graphifyOperationLeaseInvalidError(new Error("selection has multiple active or claimed lease records"));
    }
    const lease = readGraphifyOperationLeaseDirectory(privateRoot, name, match[1], fsImpl);
    if (!lease) throw graphifyOperationLeaseInvalidError(new Error("lease disappeared while it was being inspected"));
    selections.add(match[1]);
    leases.push(lease);
  }
  return leases;
}

function removeGeneratedOperationDirectory(privateRoot, directory, fsImpl) {
  if (!inside(privateRoot, directory) || path.dirname(directory) !== privateRoot) {
    throw graphifyOperationLeaseInvalidError(new Error("cleanup target escaped its root"));
  }
  if (!operationLeaseDirectoryState(directory, fsImpl)) return;
  const entries = fsImpl.readdirSync(directory);
  if (entries.length > 1 || entries.some((name) => name !== BRAND_OPERATION_LEASE_FILE)) {
    throw graphifyOperationLeaseInvalidError(new Error("cleanup target contains unexpected entries"));
  }
  if (entries.length === 1) {
    const stat = fsImpl.lstatSync(path.join(directory, BRAND_OPERATION_LEASE_FILE));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw graphifyOperationLeaseInvalidError(new Error("cleanup target contains an unsafe lease record"));
    }
  }
  fsImpl.rmSync(directory, { recursive: true, force: false });
}

function reserveGraphifyOperation(stateRoot, input = {}) {
  const { fsImpl = fs, randomBytes = crypto.randomBytes } = input;
  const privateRoot = validateRoot(stateRoot, "state root", { privateRoot: true, fsImpl });
  const selection = normalizeBrandOperationSelection(input);
  const existing = recoverGraphifyOperationClaim(privateRoot, selection, fsImpl);
  if (existing) {
    try {
      fsyncDirectory(fsImpl, existing.directory, "Brand operation lease directory");
      fsyncDirectory(fsImpl, privateRoot, "Brand operation lease root");
    } catch (error) {
      throw graphifyOperationLeaseUncertainError(existing.operationId, "recovery", error);
    }
    return existing.operationId;
  }
  const acknowledged = readAcknowledgedGraphifyOperation(privateRoot, selection, fsImpl);

  const operationId = Buffer.from(randomBytes(16)).toString("hex");
  safeBrandOperationId(operationId);
  if (acknowledged && acknowledged.operationId === operationId) {
    throw graphifyOperationLeaseInvalidError(new Error("generated operation id was already acknowledged"));
  }
  const nonce = Buffer.from(randomBytes(8)).toString("hex");
  if (!/^[a-f0-9]{16}$/.test(nonce)) throw new Error("Graphify Brand operation lease nonce is invalid");
  const selectionHash = brandOperationSelectionSha256(selection);
  const finalDirectory = path.join(privateRoot, `.brand-operation-${selectionHash}`);
  const pendingDirectory = path.join(privateRoot, `.pending-brand-operation-${selectionHash}-${operationId}-${nonce}`);
  const body = `${JSON.stringify({
    version: 1,
    ...selection,
    operationId,
    sha256: brandOperationLeaseSha256(selection, operationId),
  })}\n`;
  let committed = false;
  try {
    if (fsImpl.existsSync(pendingDirectory)) throw new Error("Graphify Brand operation lease temporary destination exists");
    fsImpl.mkdirSync(pendingDirectory, { mode: 0o700 });
    writeExclusive(fsImpl, path.join(pendingDirectory, BRAND_OPERATION_LEASE_FILE), body, 0o600);
    fsyncDirectory(fsImpl, pendingDirectory, "Brand operation lease temporary directory");
    fsyncDirectory(fsImpl, privateRoot, "Brand operation lease root after temporary creation");
    fsImpl.renameSync(pendingDirectory, finalDirectory);
    committed = true;
    fsyncDirectory(fsImpl, privateRoot, "Brand operation lease root after publication rename");
    return operationId;
  } catch (error) {
    if (committed) throw graphifyOperationLeaseUncertainError(operationId, "publication", error);
    let winner = null;
    try { winner = recoverGraphifyOperationClaim(privateRoot, selection, fsImpl); }
    catch (leaseError) {
      try { removeGeneratedOperationDirectory(privateRoot, pendingDirectory, fsImpl); } catch {}
      throw leaseError;
    }
    try { removeGeneratedOperationDirectory(privateRoot, pendingDirectory, fsImpl); } catch {}
    if (winner) {
      try { fsyncDirectory(fsImpl, privateRoot, "Brand operation lease root after concurrent publication"); }
      catch (syncError) { throw graphifyOperationLeaseUncertainError(winner.operationId, "concurrent publication", syncError); }
      return winner.operationId;
    }
    throw error;
  }
}

function verifiedCompletedBrandOperation(privateRoot, publicRoot, selection, operationId, fsImpl) {
  const completed = [];
  let pending = false;
  for (const record of committedRuns(privateRoot, fsImpl)) {
    const projection = readBrandProjectionState(record, fsImpl);
    if (!projection || record.manifest.target && record.manifest.target.id !== selection.targetId
        || record.manifest.folder && record.manifest.folder.id !== selection.folderId
        || projection.descriptor.accountId !== selection.accountId
        || projection.descriptor.operationId !== operationId) continue;
    if (projection.state === "pending") pending = true;
    else completed.push(record);
  }
  if (pending || !completed.length) return null;
  const verified = completed.map((record) => {
    receiptFromManifest(record.manifest);
    readCommittedGraph(record, fsImpl);
    snapshotCommittedArtifactPair(publicRoot, record.manifest, fsImpl);
    return record;
  }).sort((left, right) => {
    const leftTime = Date.parse(left.manifest.snapshot && left.manifest.snapshot.builtAt) || left.mtimeMs;
    const rightTime = Date.parse(right.manifest.snapshot && right.manifest.snapshot.builtAt) || right.mtimeMs;
    return rightTime - leftTime || right.manifest.runId.localeCompare(left.manifest.runId);
  });
  return verified[0];
}

function acknowledgeGraphifyOperation(stateRoot, artifactsRoot, input = {}) {
  const { operationId, fsImpl = fs } = input;
  const privateRoot = validateRoot(stateRoot, "state root", { privateRoot: true, fsImpl });
  const publicRoot = validateRoot(artifactsRoot, "artifacts root", { fsImpl });
  const selection = normalizeBrandOperationSelection(input);
  const expectedOperationId = safeBrandOperationId(operationId);
  const lease = recoverGraphifyOperationClaim(privateRoot, selection, fsImpl);
  if (!lease || lease.operationId !== expectedOperationId) {
    if (recoverAcknowledgedGraphifyOperation(
      privateRoot, selection, expectedOperationId, fsImpl,
    )) return true;
    return false;
  }
  const completed = verifiedCompletedBrandOperation(
    privateRoot, publicRoot, selection, expectedOperationId, fsImpl,
  );
  if (!completed) {
    return recoverAcknowledgedGraphifyOperation(
      privateRoot, selection, expectedOperationId, fsImpl,
    );
  }

  const selectionHash = brandOperationSelectionSha256(selection);
  const claimName = `.claim-brand-operation-${selectionHash}-${expectedOperationId}`;
  const claimDirectory = path.join(privateRoot, claimName);
  const acknowledgedDirectory = path.join(privateRoot, `.acked-brand-operation-${selectionHash}`);
  let claimed = false;
  try {
    fsImpl.renameSync(lease.directory, claimDirectory);
    claimed = true;
    fsyncDirectory(fsImpl, privateRoot, "Brand operation lease root after acknowledgement claim");
  } catch (error) {
    const current = recoverGraphifyOperationClaim(privateRoot, selection, fsImpl);
    if (recoverAcknowledgedGraphifyOperation(
      privateRoot, selection, expectedOperationId, fsImpl,
    )) return true;
    if (current && current.operationId !== expectedOperationId) return false;
    if (claimed || current) throw graphifyOperationLeaseUncertainError(expectedOperationId, "acknowledgement claim", error);
    throw graphifyOperationLeaseUncertainError(expectedOperationId, "acknowledgement", error);
  }

  const claimedLease = readGraphifyOperationLeaseDirectory(
    privateRoot, claimName, selectionHash, fsImpl,
  );
  if (!claimedLease) {
    const current = recoverGraphifyOperationClaim(privateRoot, selection, fsImpl);
    if (recoverAcknowledgedGraphifyOperation(
      privateRoot, selection, expectedOperationId, fsImpl,
    )) return true;
    if (current && current.operationId !== expectedOperationId) return false;
    throw graphifyOperationLeaseUncertainError(
      expectedOperationId, "acknowledgement claim", new Error("claim disappeared before validation"),
    );
  }
  if (claimedLease.operationId !== expectedOperationId) {
    const restored = recoverGraphifyOperationClaim(privateRoot, selection, fsImpl);
    if (!restored || restored.operationId !== claimedLease.operationId) {
      throw graphifyOperationLeaseInvalidError(new Error("replacement lease was not restored from a stale acknowledgement"));
    }
    return recoverAcknowledgedGraphifyOperation(
      privateRoot, selection, expectedOperationId, fsImpl,
    );
  }

  try {
    const previous = readAcknowledgedGraphifyOperation(privateRoot, selection, fsImpl);
    if (previous) {
      if (previous.operationId === expectedOperationId) {
        throw graphifyOperationLeaseInvalidError(new Error("active and acknowledged lease records conflict"));
      }
      removeGeneratedOperationDirectory(privateRoot, previous.directory, fsImpl);
      fsyncDirectory(fsImpl, privateRoot, "Brand operation lease root after acknowledgement rotation");
    }
    fsImpl.renameSync(claimDirectory, acknowledgedDirectory);
    fsyncDirectory(fsImpl, privateRoot, "Brand operation lease root after acknowledgement rename");
  } catch (error) {
    if (recoverAcknowledgedGraphifyOperation(
      privateRoot, selection, expectedOperationId, fsImpl,
    )) return true;
    try { recoverGraphifyOperationClaim(privateRoot, selection, fsImpl); }
    catch (recoveryError) { throw recoveryError; }
    throw graphifyOperationLeaseUncertainError(expectedOperationId, "acknowledgement", error);
  }
  return true;
}

function committedRuns(stateRoot, fsImpl = fs) {
  const root = validateRoot(stateRoot, "state root", { privateRoot: true, fsImpl });
  const result = [];
  for (const name of fsImpl.readdirSync(root)) {
    if (!RUN_ID_RE.test(name)) continue;
    result.push(readCommittedManifest(root, name, fsImpl));
  }
  return result;
}

function committedGraphifyArtifactNames(stateRoot, { artifactsRoot = null, fsImpl = fs } = {}) {
  const names = [];
  for (const { manifest } of committedRuns(stateRoot, fsImpl)) {
    if (artifactsRoot && !artifactPairMatches(artifactsRoot, manifest, fsImpl)) continue;
    names.push(manifest.artifacts.html.name, manifest.artifacts.markdown.name);
  }
  return names.sort();
}

function artifactRunId(name) {
  if (!safeArtifactName(name)) return null;
  const match = /-([a-f0-9]{32})\.(?:html|md)$/.exec(name);
  return match ? match[1] : null;
}

function readCommittedGraphifyArtifactPair(stateRoot, artifactsRoot, name, { fsImpl = fs } = {}) {
  const runId = artifactRunId(name);
  if (!runId) return null;
  const root = validateRoot(stateRoot, "state root", { privateRoot: true, fsImpl });
  validateRoot(artifactsRoot, "artifacts root", { fsImpl });
  try { fsImpl.lstatSync(path.join(root, runId)); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    throw graphifyIntegrityError(runId, error);
  }
  let committed;
  try { committed = readCommittedManifest(root, runId, fsImpl); }
  catch (error) { throw graphifyIntegrityError(runId, error); }
  const records = committed.manifest.artifacts || {};
  if (name !== (records.html && records.html.name) && name !== (records.markdown && records.markdown.name)) return null;
  try { return snapshotCommittedArtifactPair(artifactsRoot, committed.manifest, fsImpl); }
  catch (error) { throw graphifyIntegrityError(runId, error); }
}

function readCommittedGraphifyArtifactPairs(stateRoot, artifactsRoot, { fsImpl = fs } = {}) {
  const root = validateRoot(stateRoot, "state root", { privateRoot: true, fsImpl });
  validateRoot(artifactsRoot, "artifacts root", { fsImpl });
  const pairs = [];
  for (const name of fsImpl.readdirSync(root)) {
    if (!RUN_ID_RE.test(name)) continue;
    try {
      const { manifest } = readCommittedManifest(root, name, fsImpl);
      pairs.push(snapshotCommittedArtifactPair(artifactsRoot, manifest, fsImpl));
    } catch (error) { throw graphifyIntegrityError(name, error); }
  }
  return pairs.sort((left, right) => left.runId.localeCompare(right.runId));
}

function readCommittedGraph(record, fsImpl = fs) {
  const { runDir, manifest } = record;
  const graphRecord = manifest.graph;
  if (!graphRecord || graphRecord.name !== "graph.json" || graphRecord.private !== true
      || !Number.isSafeInteger(graphRecord.bytes) || graphRecord.bytes < 1
      || graphRecord.bytes > MAX_PRIVATE_GRAPH_BYTES || !/^[a-f0-9]{64}$/.test(graphRecord.sha256 || "")) {
    throw new Error(`Graphify committed graph ${manifest.runId} is invalid`);
  }
  const graphPath = path.join(runDir, graphRecord.name);
  if (!inside(runDir, graphPath) || path.dirname(graphPath) !== runDir) {
    throw new Error(`Graphify committed graph ${manifest.runId} escaped its run directory`);
  }
  const bytes = readStableFile(graphPath, {
    label: `committed graph ${manifest.runId}`,
    maxBytes: MAX_PRIVATE_GRAPH_BYTES,
    privateFile: true,
    fsImpl,
  });
  if (bytes.length !== graphRecord.bytes || sha256(bytes) !== graphRecord.sha256) {
    throw new Error(`Graphify committed graph ${manifest.runId} does not match its manifest`);
  }
  let raw;
  try { raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch (error) { throw new Error(`Graphify committed graph ${manifest.runId} is invalid (${error.message})`); }
  return validateGraphBody(raw, validateCounts(manifest.counts), `committed ${manifest.runId}`);
}

function receiptFromManifest(manifest) {
  const target = safeRecord(manifest.target, "committed target", ["id", "label", "kind"]);
  const folder = safeRecord(manifest.folder, "committed folder", ["id", "label"]);
  safeLabel(target.label);
  safeLabel(folder.label);
  const snapshot = validateSnapshot(manifest.snapshot);
  const counts = validateCounts(manifest.counts);
  for (const kind of ["html", "markdown"]) {
    if (!safeArtifactRecord(manifest.artifacts && manifest.artifacts[kind])) {
      throw new Error(`Graphify committed ${kind} artifact record is invalid`);
    }
  }
  const artifactResponse = (name) => ({
    name,
    viewUrl: `/artifacts/view?p=${encodeURIComponent(name)}`,
    downloadUrl: `/artifacts/dl?p=${encodeURIComponent(name)}`,
  });
  return {
    runId: manifest.runId,
    target,
    folder,
    snapshot,
    artifacts: {
      html: artifactResponse(manifest.artifacts.html.name),
      markdown: artifactResponse(manifest.artifacts.markdown.name),
    },
    counts,
  };
}

function latestCommittedGraphifyRun(stateRoot, { targetId, fsImpl = fs } = {}) {
  if (typeof targetId !== "string" || !targetId || targetId.length > 160 || /[\0\r\n]/.test(targetId)) {
    throw new Error("Graphify target id is invalid");
  }
  const root = validateRoot(stateRoot, "state root", { privateRoot: true, fsImpl });
  const candidates = committedRuns(root, fsImpl)
    .filter(({ manifest }) => manifest.target && manifest.target.id === targetId)
    .sort((left, right) => {
      const leftTime = Date.parse(left.manifest.snapshot && left.manifest.snapshot.builtAt) || left.mtimeMs;
      const rightTime = Date.parse(right.manifest.snapshot && right.manifest.snapshot.builtAt) || right.mtimeMs;
      return rightTime - leftTime || right.manifest.runId.localeCompare(left.manifest.runId);
    });
  if (!candidates.length) return null;
  const { runDir, manifest } = candidates[0];
  const target = safeRecord(manifest.target, "committed target", ["id", "label", "kind"]);
  const folder = safeRecord(manifest.folder, "committed folder", ["id", "label"]);
  const snapshot = validateSnapshot(manifest.snapshot);
  const counts = validateCounts(manifest.counts);
  const graph = readCommittedGraph({ runDir, manifest }, fsImpl);
  return {
    manifest: Object.freeze({
      version: MANIFEST_VERSION,
      runId: manifest.runId,
      derived: true,
      target: Object.freeze(target),
      folder: Object.freeze(folder),
      snapshot,
      counts,
    }),
    graph,
  };
}

function readPendingGraphifyBrandProjection(stateRoot, artifactsRoot, input = {}) {
  const { targetId, folderId, accountId, operationId, records, fsImpl = fs } = input;
  if (targetId !== `brand:${accountId}` || typeof folderId !== "string" || !folderId || folderId.length > 160
      || /[\0\r\n]/.test(folderId || "")) {
    throw new Error("Graphify pending Brand projection selection is invalid");
  }
  const expected = normalizeBrandProjection({ accountId, operationId, records });
  const privateRoot = validateRoot(stateRoot, "state root", { privateRoot: true, fsImpl });
  const publicRoot = validateRoot(artifactsRoot, "artifacts root", { fsImpl });
  const pendingMatches = [];
  const completedMatches = [];
  let mismatch = null;
  for (const record of committedRuns(privateRoot, fsImpl)) {
    const projection = readBrandProjectionState(record, fsImpl);
    if (!projection) continue;
    const { manifest } = record;
    if (manifest.target && manifest.target.id === targetId
        && manifest.folder && manifest.folder.id === folderId
        && projection.descriptor.accountId === accountId) {
      if (projection.descriptor.operationId === expected.operationId) {
        (projection.state === "pending" ? pendingMatches : completedMatches).push({ record, projection });
      } else if (projection.state === "pending" && !mismatch) mismatch = record;
    }
  }
  if (pendingMatches.length > 1) throw new Error("Graphify found multiple pending Brand projections for the same source snapshot");
  completedMatches.sort((left, right) => {
    const leftTime = Date.parse(left.record.manifest.snapshot && left.record.manifest.snapshot.builtAt) || left.record.mtimeMs;
    const rightTime = Date.parse(right.record.manifest.snapshot && right.record.manifest.snapshot.builtAt) || right.record.mtimeMs;
    return rightTime - leftTime || right.record.manifest.runId.localeCompare(left.record.manifest.runId);
  });
  const pending = pendingMatches[0] || null;
  if (!pending && mismatch) throw graphifyPendingMismatchError(mismatch.manifest.runId);
  const selected = pending || completedMatches[0] || null;
  if (!selected) {
    return null;
  }
  const { record, projection } = selected;
  snapshotCommittedArtifactPair(publicRoot, record.manifest, fsImpl);
  const receipt = receiptFromManifest(record.manifest);
  const graph = readCommittedGraph(record, fsImpl);
  if (projection.state === "complete") {
    fsyncDirectory(fsImpl, record.runDir, "Brand projection run directory");
  }
  return Object.freeze({
    state: projection.state,
    runId: record.manifest.runId,
    receipt,
    snapshot: receipt.snapshot,
    graph,
    records: projection.marker.records,
  });
}

function completeGraphifyBrandProjection(stateRoot, artifactsRoot, input = {}) {
  const { runId, accountId, operationId, fsImpl = fs } = input;
  if (!BRAND_ACCOUNT_ID_RE.test(accountId || "")) throw new Error("Graphify Brand account id is invalid");
  const expectedOperationId = safeBrandOperationId(operationId);
  const privateRoot = validateRoot(stateRoot, "state root", { privateRoot: true, fsImpl });
  const publicRoot = validateRoot(artifactsRoot, "artifacts root", { fsImpl });
  const record = readCommittedManifest(privateRoot, runId, fsImpl);
  const projection = readBrandProjectionState(record, fsImpl);
  if (!projection || projection.descriptor.accountId !== accountId
      || projection.descriptor.operationId !== expectedOperationId
      || record.manifest.target && record.manifest.target.id !== `brand:${accountId}`) {
    throw new Error(`Graphify Brand projection ${runId} does not match the completing operation and account`);
  }
  snapshotCommittedArtifactPair(publicRoot, record.manifest, fsImpl);
  readCommittedGraph(record, fsImpl);
  if (projection.state === "complete") {
    fsyncDirectory(fsImpl, record.runDir, "Brand projection run directory");
    return false;
  }
  const completePath = path.join(record.runDir, projection.descriptor.completeName);
  if (entryState(completePath, fsImpl)) throw new Error(`Graphify Brand projection ${runId} has an invalid completion state`);
  fsImpl.renameSync(projection.path, completePath);
  fsyncDirectory(fsImpl, record.runDir, "Brand projection run directory");
  const completed = readBrandProjectionState(record, fsImpl);
  if (!completed || completed.state !== "complete") throw new Error(`Graphify Brand projection ${runId} could not be marked complete`);
  return true;
}

function generatedLeafState(file, root, fsImpl) {
  if (!inside(root, file) || path.dirname(file) !== root) throw new Error("Graphify cleanup target escaped its root");
  let stat;
  try { stat = fsImpl.lstatSync(file); }
  catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error(`Graphify cleanup refused an unsafe artifact: ${path.basename(file)}`);
  }
  return true;
}

function unlinkGenerated(file, root, fsImpl) {
  if (!generatedLeafState(file, root, fsImpl)) return;
  fsImpl.unlinkSync(file);
}

function removeRun(record, artifactsRoot, fsImpl) {
  fsImpl.rmSync(record.runDir, { recursive: true, force: false });
  for (const kind of ["html", "markdown"]) {
    unlinkGenerated(path.join(artifactsRoot, record.manifest.artifacts[kind].name), artifactsRoot, fsImpl);
  }
}

function inspectGraphifyStore(privateRoot, publicRoot, retain, fsImpl, protectedRunId = null) {
  if (!Number.isSafeInteger(retain) || retain < 0 || retain > 100) throw new Error("Graphify retention is invalid");
  const leasedOperations = new Set(readGraphifyOperationLeases(privateRoot, fsImpl).map((lease) => (
    brandOperationLeaseKey(lease.selection, lease.operationId)
  )));
  const runs = committedRuns(privateRoot, fsImpl).map((record) => {
    const receipt = receiptFromManifest(record.manifest);
    readCommittedGraph(record, fsImpl);
    const projection = readBrandProjectionState(record, fsImpl);
    snapshotCommittedArtifactPair(publicRoot, record.manifest, fsImpl);
    const leasePinned = !!projection && leasedOperations.has(brandOperationLeaseKey({
      targetId: record.manifest.target && record.manifest.target.id,
      folderId: record.manifest.folder && record.manifest.folder.id,
      accountId: projection.descriptor.accountId,
    }, projection.descriptor.operationId));
    return { ...record, receipt, projection, leasePinned };
  }).sort((left, right) => {
    const leftTime = Date.parse(left.receipt.snapshot.builtAt) || left.mtimeMs;
    const rightTime = Date.parse(right.receipt.snapshot.builtAt) || right.mtimeMs;
    return rightTime - leftTime || right.manifest.runId.localeCompare(left.manifest.runId);
  });
  const pinned = [];
  const finished = [];
  for (const run of runs) {
    if ((run.projection && run.projection.state === "pending") || run.leasePinned) pinned.push(run);
    else finished.push(run);
  }
  if (pinned.length > retain) {
    throw new Error(`Graphify has ${pinned.length} unfinished Brand projections or completed unacknowledged operations; finish or repair them before publishing another run`);
  }
  const completedSlots = retain - pinned.length;
  let retainedFinished = finished.slice(0, completedSlots);
  if (protectedRunId) {
    const protectedRun = finished.find(({ manifest }) => manifest.runId === protectedRunId);
    if (!protectedRun && !pinned.some(({ manifest }) => manifest.runId === protectedRunId)) {
      throw new Error(`Graphify protected run ${protectedRunId} is unavailable`);
    }
    if (protectedRun && !retainedFinished.includes(protectedRun)) {
      if (completedSlots < 1) throw new Error(`Graphify protected run ${protectedRunId} has no retention slot`);
      retainedFinished = [protectedRun, ...retainedFinished.filter((run) => run !== protectedRun)].slice(0, completedSlots);
    }
  }
  const retainedSet = new Set([...pinned, ...retainedFinished].map(({ manifest }) => manifest.runId));
  const stale = finished.filter(({ manifest }) => !retainedSet.has(manifest.runId));
  const referenced = new Set();
  const retainedArtifacts = new Set();
  for (const run of runs) {
    for (const kind of ["html", "markdown"]) {
      const name = run.manifest.artifacts[kind].name;
      referenced.add(name);
      if (retainedSet.has(run.manifest.runId)) retainedArtifacts.add(name);
    }
  }
  const orphanArtifacts = [];
  const pendingArtifacts = [];
  let recoveryBudget = MAX_RECOVERY_CLEANUP_ENTRIES;
  for (const name of fsImpl.readdirSync(publicRoot)) {
    const file = path.join(publicRoot, name);
    if (safeArtifactName(name) && !referenced.has(name)) {
      if (recoveryBudget > 0) {
        generatedLeafState(file, publicRoot, fsImpl);
        orphanArtifacts.push(file);
        recoveryBudget -= 1;
      }
    } else if (pendingArtifactFinalName(name)) {
      if (recoveryBudget > 0) {
        generatedLeafState(file, publicRoot, fsImpl);
        pendingArtifacts.push(file);
        recoveryBudget -= 1;
      }
    }
  }
  const pendingRuns = [];
  for (const name of fsImpl.readdirSync(privateRoot)) {
    if (!GRAPHIFY_PENDING_RUN_RE.test(name) && !BRAND_OPERATION_LEASE_PENDING_RE.test(name)) continue;
    if (recoveryBudget < 1) continue;
    const target = path.join(privateRoot, name);
    const stat = fsImpl.lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Graphify pending state is unsafe");
    pendingRuns.push(target);
    recoveryBudget -= 1;
  }
  return { stale, retainedSet, retainedArtifacts, orphanArtifacts, pendingArtifacts, pendingRuns };
}

function applyGraphifyStorePlan(plan, publicRoot, fsImpl) {
  for (const stale of plan.stale) removeRun(stale, publicRoot, fsImpl);
  for (const file of plan.orphanArtifacts) unlinkGenerated(file, publicRoot, fsImpl);
  for (const file of plan.pendingArtifacts) unlinkGenerated(file, publicRoot, fsImpl);
  for (const target of plan.pendingRuns) fsImpl.rmSync(target, { recursive: true, force: false });
}

function prepareGraphifyStore({ stateRoot, artifactsRoot, retain = DEFAULT_RETAIN, fsImpl = fs } = {}) {
  const privateRoot = validateRoot(stateRoot, "state root", { privateRoot: true, fsImpl });
  const publicRoot = validateRoot(artifactsRoot, "artifacts root", { fsImpl });
  const plan = inspectGraphifyStore(privateRoot, publicRoot, retain, fsImpl);
  applyGraphifyStorePlan(plan, publicRoot, fsImpl);
  return { runs: plan.retainedSet.size, artifacts: plan.retainedArtifacts.size };
}

function durabilityBarrierError(label, error) {
  const result = new Error(`Graphify ${label} durability barrier failure (${boundedErrorCause(error)})`);
  result.code = error && error.code || "GRAPHIFY_DURABILITY";
  return result;
}

function fsyncDirectory(fsImpl, directory, label) {
  let fd;
  let failure = null;
  try {
    fd = fsImpl.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0));
    fsImpl.fsyncSync(fd);
  } catch (error) {
    failure = error;
  }
  if (fd !== undefined) {
    try { fsImpl.closeSync(fd); }
    catch (error) { if (!failure) failure = error; }
  }
  if (!failure) return;
  const unsupportedOnWindows = process.platform === "win32"
    && ["EPERM", "EINVAL", "ENOTSUP", "EISDIR"].includes(failure.code)
    && (fd !== undefined || failure.code === "EISDIR");
  if (!unsupportedOnWindows) throw durabilityBarrierError(label, failure);
}

function writeExclusive(fsImpl, file, body, mode) {
  const bytes = Buffer.from(body);
  let fd;
  let failure = null;
  try {
    fd = fsImpl.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
      | (fs.constants.O_NOFOLLOW || 0), mode);
    let offset = 0;
    while (offset < bytes.length) {
      const written = fsImpl.writeSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!Number.isSafeInteger(written) || written < 1) throw new Error("write ended before the complete body");
      offset += written;
    }
    fsImpl.fsyncSync(fd);
  } catch (error) {
    failure = error;
  }
  if (fd !== undefined) {
    try { fsImpl.closeSync(fd); }
    catch (error) { if (!failure) failure = error; }
  }
  if (failure) throw durabilityBarrierError(`temporary file ${path.basename(file)}`, failure);
}

function boundedRetentionWarning(error) {
  const cause = boundedErrorCause(error);
  return `Graphify committed; retention cleanup was deferred (${cause}).`.slice(0, 240);
}

function publishGraphifyRun({
  stateRoot,
  artifactsRoot,
  target,
  folder,
  snapshot,
  report,
  graphRaw,
  html,
  counts,
  brandProjection = null,
  retain = DEFAULT_RETAIN,
  randomBytes = crypto.randomBytes,
  fsImpl = fs,
} = {}) {
  const privateRoot = validateRoot(stateRoot, "state root", { privateRoot: true, fsImpl });
  const publicRoot = validateRoot(artifactsRoot, "artifacts root", { fsImpl });
  const safeTarget = safeRecord(target, "target", ["id", "label", "kind"]);
  const safeFolder = safeRecord(folder, "folder", ["id", "label"]);
  safeLabel(safeTarget.label);
  safeLabel(safeFolder.label);
  const safeSnapshot = validateSnapshot(snapshot);
  const safeCounts = validateCounts(counts);
  const safeBrandProjection = brandProjection === null ? null : normalizeBrandProjection(brandProjection);
  if (safeBrandProjection && (safeTarget.kind !== "brand" || safeTarget.id !== `brand:${safeBrandProjection.accountId}`)) {
    throw new Error("Graphify Brand projection does not match its target");
  }
  if (typeof report !== "string" || !report || typeof graphRaw !== "string" || !graphRaw || typeof html !== "string" || !html) {
    throw new Error("Graphify publication artifacts must be non-empty text");
  }
  if (!Number.isSafeInteger(retain) || retain < 1 || retain > 100) throw new Error("Graphify retention is invalid");
  validateGraphBody(graphRaw, safeCounts, "publication");

  const runId = Buffer.from(randomBytes(16)).toString("hex");
  if (!RUN_ID_RE.test(runId)) throw new Error("Graphify random run id is invalid");
  const stem = `graphify-${slug(safeTarget.label)}-${slug(safeFolder.label)}-${runId}`;
  const htmlName = `${stem}.html`;
  const markdownName = `${stem}.md`;
  const nonce = Buffer.from(randomBytes(8)).toString("hex");
  if (!/^[a-f0-9]{16}$/.test(nonce)) throw new Error("Graphify publication nonce is invalid");
  const privatePending = path.join(privateRoot, `.pending-${runId}-${nonce}`);
  const privateFinal = path.join(privateRoot, runId);
  const htmlPending = path.join(publicRoot, `.${htmlName}.${nonce}.pending`);
  const markdownPending = path.join(publicRoot, `.${markdownName}.${nonce}.pending`);
  const htmlFinal = path.join(publicRoot, htmlName);
  const markdownFinal = path.join(publicRoot, markdownName);
  for (const candidate of [privatePending, privateFinal, htmlPending, markdownPending, htmlFinal, markdownFinal]) {
    if (!inside(path.dirname(candidate), candidate)) throw new Error("Graphify publication destination escaped its root");
  }

  const manifest = {
    version: MANIFEST_VERSION,
    runId,
    derived: true,
    target: safeTarget,
    folder: safeFolder,
    snapshot: safeSnapshot,
    counts: safeCounts,
    graph: { name: "graph.json", bytes: Buffer.byteLength(graphRaw), sha256: sha256(graphRaw), private: true },
    artifacts: {
      html: { name: htmlName, bytes: Buffer.byteLength(html), sha256: sha256(html) },
      markdown: { name: markdownName, bytes: Buffer.byteLength(report), sha256: sha256(report) },
    },
  };
  let brandProjectionText = null;
  if (safeBrandProjection) {
    const marker = {
      version: 1,
      runId,
      accountId: safeBrandProjection.accountId,
      operationId: safeBrandProjection.operationId,
      targetId: safeTarget.id,
      folderId: safeFolder.id,
      snapshotSha256: sha256(JSON.stringify(safeSnapshot)),
      snapshotManifestSha256: safeSnapshot.manifestSha256,
      graphSha256: manifest.graph.sha256,
      recordsSha256: safeBrandProjection.recordsSha256,
      records: safeBrandProjection.records,
    };
    brandProjectionText = `${JSON.stringify(marker)}\n`;
    if (Buffer.byteLength(brandProjectionText) > MAX_BRAND_PROJECTION_BYTES) {
      throw new Error("Graphify Brand projection marker exceeds its byte limit");
    }
    manifest.brandProjection = {
      version: 1,
      accountId: safeBrandProjection.accountId,
      operationId: safeBrandProjection.operationId,
      pendingName: BRAND_PROJECTION_PENDING,
      completeName: BRAND_PROJECTION_COMPLETE,
      bytes: Buffer.byteLength(brandProjectionText),
      sha256: sha256(brandProjectionText),
      recordsSha256: safeBrandProjection.recordsSha256,
    };
  }
  const manifestText = `${JSON.stringify(manifest)}\n`;
  if (Buffer.byteLength(manifestText) > MAX_MANIFEST_BYTES) {
    throw new Error("Graphify private manifest exceeds its byte limit");
  }
  const receipt = receiptFromManifest(manifest);

  // Validate the whole existing store and reserve one slot without deleting it.
  // A replacement is committed before retention can remove any prior good run.
  inspectGraphifyStore(privateRoot, publicRoot, retain - 1, fsImpl);
  for (const candidate of [privatePending, privateFinal, htmlFinal, markdownFinal]) {
    if (fsImpl.existsSync(candidate)) throw new Error("Graphify publication destination already exists");
  }
  for (const pending of [htmlPending, markdownPending]) generatedLeafState(pending, publicRoot, fsImpl);

  let publicHtml = false;
  let publicMarkdown = false;
  let privateCommitted = false;
  try {
    unlinkGenerated(htmlPending, publicRoot, fsImpl);
    unlinkGenerated(markdownPending, publicRoot, fsImpl);
    fsImpl.mkdirSync(privatePending, { mode: 0o700 });
    writeExclusive(fsImpl, path.join(privatePending, "graph.json"), graphRaw, 0o600);
    if (brandProjectionText) {
      writeExclusive(fsImpl, path.join(privatePending, BRAND_PROJECTION_PENDING), brandProjectionText, 0o600);
    }
    writeExclusive(fsImpl, path.join(privatePending, "manifest.json"), manifestText, 0o600);
    writeExclusive(fsImpl, htmlPending, html, 0o600);
    writeExclusive(fsImpl, markdownPending, report, 0o600);
    fsyncDirectory(fsImpl, privatePending, "private pending directory");
    fsyncDirectory(fsImpl, publicRoot, "public artifact directory after temporary creation");
    fsImpl.renameSync(htmlPending, htmlFinal);
    publicHtml = true;
    fsImpl.renameSync(markdownPending, markdownFinal);
    publicMarkdown = true;
    fsyncDirectory(fsImpl, publicRoot, "public artifact directory after publication rename");
    fsImpl.renameSync(privatePending, privateFinal);
    privateCommitted = true;
    fsyncDirectory(fsImpl, privateRoot, "private commit directory");
  } catch (error) {
    if (privateCommitted) throw graphifyCommitUncertainError(runId, error);
    for (const file of [htmlPending, markdownPending, publicHtml ? htmlFinal : null, publicMarkdown ? markdownFinal : null]) {
      if (!file) continue;
      try { unlinkGenerated(file, publicRoot, fsImpl); } catch {}
    }
    try { if (fsImpl.existsSync(privatePending)) fsImpl.rmSync(privatePending, { recursive: true, force: true }); } catch {}
    throw error;
  }
  let retentionPlan;
  try { retentionPlan = inspectGraphifyStore(privateRoot, publicRoot, retain, fsImpl, runId); }
  catch (error) { throw graphifyCommittedInvalidError(runId, error); }
  try { applyGraphifyStorePlan(retentionPlan, publicRoot, fsImpl); }
  catch (error) {
    return { ...receipt, warnings: { retention: boundedRetentionWarning(error) } };
  }
  return receipt;
}

module.exports = {
  GRAPHIFY_ARTIFACT_RE,
  GRAPHIFY_COMMIT_UNCERTAIN_CODE,
  GRAPHIFY_COMMITTED_INVALID_CODE,
  GRAPHIFY_INTEGRITY_CODE,
  GRAPHIFY_OPERATION_LEASE_INVALID_CODE,
  GRAPHIFY_OPERATION_LEASE_UNCERTAIN_CODE,
  GRAPHIFY_PENDING_MISMATCH_CODE,
  acknowledgeGraphifyOperation,
  completeGraphifyBrandProjection,
  committedGraphifyArtifactNames,
  latestCommittedGraphifyRun,
  prepareGraphifyStore,
  publishGraphifyRun,
  readCommittedGraphifyArtifactPair,
  readCommittedGraphifyArtifactPairs,
  readPendingGraphifyBrandProjection,
  reserveGraphifyOperation,
};
