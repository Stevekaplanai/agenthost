"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DASHBOARD_REVIEW_EVIDENCE_TYPE = "dashboard-generated-v1";
const DASHBOARD_REPRO_CONTEXT = "agenthost/dashboard-reproducibility-v1";
const DASHBOARD_REPRO_DESCRIPTION_PREFIX = "dashboard-review-v1:";
const DASHBOARD_REPRO_WORKFLOW = ".github/workflows/dashboard-reproducibility.yml";
const DASHBOARD_REPRO_PUBLISH_WORKFLOW = ".github/workflows/dashboard-reproducibility-publish.yml";
const DASHBOARD_TRUST_ANCHORS = Object.freeze([
  DASHBOARD_REPRO_WORKFLOW,
  DASHBOARD_REPRO_PUBLISH_WORKFLOW,
  "scripts/dashboard-review-attestation.mjs",
  "container/review-attestation.js",
  "scripts/dashboard-source-fingerprint.mjs",
  "scripts/build-dashboard.mjs",
  ".gitattributes",
  ".gitmodules",
]);

const GENERATED_PREFIX = "container/dashboard-ui/";
const MANIFEST_PATH = ".export-manifest.json";
const FINGERPRINT_PATH = ".source-sha256";
const HEX40 = /^[a-f0-9]{40}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const REPOSITORY = /^[a-z0-9_.-]{1,100}\/[a-z0-9_.-]{1,100}$/i;
const REGULAR_MODES = new Set(["100644", "100755"]);
const MAX_PR_FILES = 299;
const MAX_SOURCE_TEXT_BYTES = 256 * 1024;
const MAX_SOURCE_REVIEW_BYTES = 8 * 1024 * 1024;
const MAX_TREE_ENTRIES = 4096;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TREE_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 512 * 1024;

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function gitBlobSha(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  return crypto.createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function safePath(value, label = "path") {
  if (typeof value !== "string" || value.length < 1 || value.length > 1024) {
    throw new TypeError(`${label} is not a bounded string`);
  }
  // Keep signed review paths printable ASCII. Git permits invisible Unicode
  // controls and bidi overrides that can make reviewed text name a different
  // path than the reviewer sees; this protocol deliberately refuses them.
  if (value !== value.normalize("NFC") || !/^[\x20-\x7e]+$/.test(value)
    || value.includes("\\") || value.startsWith("/") || value.endsWith("/")) {
    throw new TypeError(`${label} is unsafe`);
  }
  const parts = value.split("/");
  if (parts.some((part) => part.length < 1 || part.length > 255 || part === "." || part === "..")) {
    throw new TypeError(`${label} is unsafe`);
  }
  return value;
}

function integer(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new TypeError(`${label} is invalid`);
  return value;
}

function lowercaseHex(value, pattern, label) {
  const normalized = typeof value === "string" ? value.toLowerCase() : "";
  if (!pattern.test(normalized)) throw new TypeError(`${label} is invalid`);
  return normalized;
}

function validateChangedFileModes(file, status) {
  const baseMode = file.baseMode === null ? null : file.baseMode;
  const headMode = file.headMode === null ? null : file.headMode;
  if (!(baseMode === null || REGULAR_MODES.has(baseMode)) || !(headMode === null || REGULAR_MODES.has(headMode))) {
    throw new TypeError(`${file.filename || "file"} has an unsafe mode`);
  }
  if (status === "added" && (baseMode !== null || !REGULAR_MODES.has(headMode))) throw new TypeError(`${file.filename} has invalid added-file modes`);
  if (status === "removed" && (!REGULAR_MODES.has(baseMode) || headMode !== null)) throw new TypeError(`${file.filename} has invalid removed-file modes`);
  if ((status === "modified" || status === "renamed") && (!REGULAR_MODES.has(baseMode) || baseMode !== headMode)) {
    throw new TypeError(`${file.filename} has a forbidden mode change`);
  }
  const baseType = file.baseType === null ? null : file.baseType;
  const headType = file.headType === null ? null : file.headType;
  if (!(baseType === null || baseType === "blob") || !(headType === null || headType === "blob")) {
    throw new TypeError(`${file.filename || "file"} has an unsafe type`);
  }
  if (status === "added" && (baseType !== null || headType !== "blob")) throw new TypeError(`${file.filename} has invalid added-file types`);
  if (status === "removed" && (baseType !== "blob" || headType !== null)) throw new TypeError(`${file.filename} has invalid removed-file types`);
  if ((status === "modified" || status === "renamed") && (baseType !== "blob" || headType !== "blob")) {
    throw new TypeError(`${file.filename} has invalid file types`);
  }
  return { baseMode, headMode, baseType, headType };
}

function changedFileRecord(file) {
  if (!file || typeof file !== "object" || Array.isArray(file)) throw new TypeError("pull request file is invalid");
  const filename = safePath(file.filename, "pull request filename");
  const status = typeof file.status === "string" ? file.status : "";
  if (!new Set(["added", "removed", "modified", "renamed"]).has(status)) throw new TypeError(`${filename} has unsupported status`);
  const previousFilename = status === "renamed" ? safePath(file.previous_filename, "previous filename") : null;
  if (status !== "renamed" && file.previous_filename !== undefined && file.previous_filename !== null) {
    throw new TypeError(`${filename} has unexpected rename metadata`);
  }
  const generated = filename.startsWith(GENERATED_PREFIX)
    && (!previousFilename || previousFilename.startsWith(GENERATED_PREFIX));
  const { baseMode, headMode, baseType, headType } = validateChangedFileModes(file, status);
  const baseBlobSha = file.baseBlobSha === null ? null : lowercaseHex(file.baseBlobSha, HEX40, `${filename} base blob SHA`);
  const headBlobSha = file.headBlobSha === null ? null : lowercaseHex(file.headBlobSha, HEX40, `${filename} head blob SHA`);
  if (status === "added" && (baseBlobSha !== null || headBlobSha === null)) throw new TypeError(`${filename} has invalid added-file blob identities`);
  if (status === "removed" && (baseBlobSha === null || headBlobSha !== null)) throw new TypeError(`${filename} has invalid removed-file blob identities`);
  if ((status === "modified" || status === "renamed") && (baseBlobSha === null || headBlobSha === null)) {
    throw new TypeError(`${filename} has incomplete blob identities`);
  }
  const githubBlobSha = lowercaseHex(file.sha, HEX40, `${filename} GitHub blob SHA`);
  if (githubBlobSha !== (status === "removed" ? baseBlobSha : headBlobSha)) {
    throw new TypeError(`${filename} GitHub blob SHA does not match the exact commit tree`);
  }
  const additions = integer(file.additions, `${filename} additions`, 10_000_000);
  const deletions = integer(file.deletions, `${filename} deletions`, 10_000_000);
  const changes = integer(file.changes, `${filename} changes`, 10_000_000);
  if (changes !== additions + deletions) throw new TypeError(`${filename} has inconsistent change counts`);
  if (!generated && typeof file.patch !== "string") throw new TypeError(`${filename} is missing a complete text patch`);
  if (generated && file.patch !== undefined && typeof file.patch !== "string") throw new TypeError(`${filename} patch is invalid`);
  const patch = generated ? "" : file.patch;
  if (!generated && Buffer.byteLength(patch) > MAX_SOURCE_TEXT_BYTES) throw new TypeError(`${filename} patch exceeds the per-file review limit`);
  if (!generated && patch) {
    const lines = patch.split("\n");
    let inHunk = false;
    let patchAdditions = 0;
    let patchDeletions = 0;
    for (const line of lines) {
      if (line.startsWith("@@")) {
        inHunk = true;
      } else if (inHunk && line.startsWith("+")) {
        patchAdditions += 1;
      } else if (inHunk && line.startsWith("-")) {
        patchDeletions += 1;
      }
    }
    if (patchAdditions !== additions || patchDeletions !== deletions) throw new TypeError(`${filename} patch counts are incomplete`);
  }
  return {
    path: filename,
    status,
    previousPath: previousFilename,
    blobSha: githubBlobSha,
    baseBlobSha,
    headBlobSha,
    baseMode,
    headMode,
    baseType,
    headType,
    additions,
    deletions,
    changes,
    patch: generated ? "" : patch,
    generated,
  };
}

function canonicalPullRequestReview(files) {
  try {
    if (!Array.isArray(files) || files.length < 1 || files.length > MAX_PR_FILES) {
      throw new TypeError(`pull request file list must contain 1-${MAX_PR_FILES} files`);
    }
    const records = files.map(changedFileRecord).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const seen = new Set();
    for (const record of records) {
      const folded = record.path.toLowerCase();
      if (seen.has(folded)) throw new TypeError(`pull request file paths contain a case duplicate: ${record.path}`);
      seen.add(folded);
    }
    const sourceFiles = [];
    const generatedFiles = [];
    for (const record of records) {
      if (record.generated) {
        const { patch: _patch, generated: _generated, ...metadata } = record;
        generatedFiles.push(metadata);
      } else {
        const { generated: _generated, ...source } = record;
        sourceFiles.push(source);
      }
    }
    const sourceText = `agenthost-source-review-v1\n${sourceFiles.map((file) => JSON.stringify(file)).join("\n")}${sourceFiles.length ? "\n" : ""}`;
    if (Buffer.byteLength(sourceText) > MAX_SOURCE_REVIEW_BYTES) throw new TypeError("canonical source review exceeds the aggregate review size limit");
    return { ok: true, sourceDiffSha256: sha256(sourceText), sourceText, sourceFiles, generatedFiles };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function validateDashboardTree(treeJson, manifestText, fingerprintText) {
  if (!treeJson || typeof treeJson !== "object" || treeJson.truncated !== false || !Array.isArray(treeJson.tree)) {
    throw new TypeError("dashboard Git tree is missing or truncated");
  }
  const treeSha = lowercaseHex(treeJson.sha, HEX40, "dashboard tree SHA");
  if (treeJson.tree.length < 2 || treeJson.tree.length > MAX_TREE_ENTRIES) throw new TypeError("dashboard Git tree entry count is invalid");
  if (typeof manifestText !== "string" || Buffer.byteLength(manifestText) > MAX_MANIFEST_BYTES) throw new TypeError("dashboard manifest is too large or invalid");
  if (typeof fingerprintText !== "string" || !/^[a-f0-9]{64}\n$/.test(fingerprintText)) throw new TypeError("dashboard fingerprint has an invalid shape");

  const entries = new Map();
  const folded = new Set();
  let totalBytes = 0;
  for (const raw of treeJson.tree) {
    if (!raw || typeof raw !== "object") throw new TypeError("dashboard Git tree entry is invalid");
    const entryPath = safePath(raw.path, "dashboard Git tree path");
    const key = entryPath.toLowerCase();
    if (folded.has(key)) throw new TypeError(`dashboard Git tree contains a case duplicate: ${entryPath}`);
    folded.add(key);
    const entrySha = lowercaseHex(raw.sha, HEX40, `${entryPath} Git object SHA`);
    if (raw.type === "tree" && raw.mode === "040000") {
      if (raw.size !== undefined) throw new TypeError(`${entryPath} directory unexpectedly has a size`);
      entries.set(entryPath, { path: entryPath, mode: "040000", type: "tree", sha: entrySha });
      continue;
    }
    if (raw.type !== "blob" || raw.mode !== "100644") throw new TypeError(`${entryPath} has an unsafe Git type or mode`);
    const size = integer(raw.size, `${entryPath} size`, MAX_FILE_BYTES);
    totalBytes += size;
    if (totalBytes > MAX_TREE_BYTES) throw new TypeError("dashboard Git tree exceeds the total byte limit");
    entries.set(entryPath, { path: entryPath, mode: "100644", type: "blob", sha: entrySha, size });
  }
  for (const entry of entries.values()) {
    const parts = entry.path.split("/");
    for (let i = 1; i < parts.length; i += 1) {
      const parent = parts.slice(0, i).join("/");
      if (entries.get(parent)?.type !== "tree") throw new TypeError(`dashboard Git tree is missing directory metadata for ${parent}`);
    }
  }

  const manifestEntry = entries.get(MANIFEST_PATH);
  const fingerprintEntry = entries.get(FINGERPRINT_PATH);
  if (manifestEntry?.type !== "blob" || fingerprintEntry?.type !== "blob") throw new TypeError("dashboard Git tree is missing its manifest or fingerprint blob");
  if (manifestEntry.size !== Buffer.byteLength(manifestText) || manifestEntry.sha !== gitBlobSha(manifestText)) throw new TypeError("dashboard manifest blob does not match the Git tree");
  if (fingerprintEntry.size !== Buffer.byteLength(fingerprintText) || fingerprintEntry.sha !== gitBlobSha(fingerprintText)) throw new TypeError("dashboard fingerprint blob does not match the Git tree");

  let manifest;
  try { manifest = JSON.parse(manifestText); }
  catch (error) { throw new TypeError(`dashboard manifest is unreadable: ${error.message}`); }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)
      || Object.keys(manifest).sort().join(",") !== "files,version"
      || manifest.version !== 1 || !Array.isArray(manifest.files)) {
    throw new TypeError("dashboard manifest has an unsupported shape");
  }
  const manifestPaths = new Set();
  const manifestFolded = new Set();
  for (const file of manifest.files) {
    if (!file || typeof file !== "object" || Array.isArray(file) || Object.keys(file).sort().join(",") !== "path,sha256") {
      throw new TypeError("dashboard manifest contains an invalid entry");
    }
    const filePath = safePath(file.path, "dashboard manifest path");
    if (filePath === MANIFEST_PATH) throw new TypeError("dashboard manifest must not list itself");
    const key = filePath.toLowerCase();
    if (manifestFolded.has(key)) throw new TypeError(`dashboard manifest contains a duplicate path: ${filePath}`);
    manifestFolded.add(key);
    manifestPaths.add(filePath);
    lowercaseHex(file.sha256, HEX64, `${filePath} content SHA-256`);
  }
  const blobPaths = [...entries.values()].filter((entry) => entry.type === "blob" && entry.path !== MANIFEST_PATH).map((entry) => entry.path).sort();
  const listedPaths = [...manifestPaths].sort();
  if (JSON.stringify(blobPaths) !== JSON.stringify(listedPaths)) throw new TypeError("dashboard manifest membership does not match the Git tree");
  if (!manifestPaths.has(FINGERPRINT_PATH) || !manifestPaths.has("index.html")) throw new TypeError("dashboard manifest is missing its fingerprint or entry page");

  return Object.freeze({
    treeSha,
    manifestBlobSha: manifestEntry.sha,
    fingerprintBlobSha: fingerprintEntry.sha,
    fingerprint: fingerprintText.slice(0, -1),
    fileCount: blobPaths.length + 1,
    totalBytes,
  });
}

function dashboardMetadata(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} dashboard metadata is invalid`);
  return {
    treeSha: lowercaseHex(value.treeSha, HEX40, `${label} dashboard tree SHA`),
    manifestBlobSha: lowercaseHex(value.manifestBlobSha, HEX40, `${label} dashboard manifest blob SHA`),
    fingerprintBlobSha: lowercaseHex(value.fingerprintBlobSha, HEX40, `${label} dashboard fingerprint blob SHA`),
    fingerprint: lowercaseHex(value.fingerprint, HEX64, `${label} dashboard fingerprint`),
    fileCount: integer(value.fileCount, `${label} dashboard file count`, MAX_TREE_ENTRIES),
    totalBytes: integer(value.totalBytes, `${label} dashboard byte count`, MAX_TREE_BYTES),
  };
}

function dashboardAttestationRecord(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("dashboard attestation input is invalid");
  const repository = typeof input.repository === "string" ? input.repository.toLowerCase() : "";
  if (!REPOSITORY.test(repository)) throw new TypeError("repository is invalid");
  const pullRequest = integer(input.pullRequest, "pull request number", 2_147_483_647);
  if (pullRequest < 1) throw new TypeError("pull request number is invalid");
  const workflowRunId = typeof input.workflowRunId === "string" ? input.workflowRunId : String(input.workflowRunId || "");
  if (!/^[1-9][0-9]{0,19}$/.test(workflowRunId)) throw new TypeError("workflow run id is invalid");
  const workflowRunAttempt = integer(input.workflowRunAttempt, "workflow run attempt", 1_000_000);
  if (workflowRunAttempt < 1) throw new TypeError("workflow run attempt is invalid");
  return Object.freeze({
    type: DASHBOARD_REVIEW_EVIDENCE_TYPE,
    context: DASHBOARD_REPRO_CONTEXT,
    workflow: DASHBOARD_REPRO_WORKFLOW,
    repository,
    pullRequest,
    baseSha: lowercaseHex(input.baseSha, HEX40, "base commit SHA"),
    headSha: lowercaseHex(input.headSha, HEX40, "head commit SHA"),
    sourceDiffSha256: lowercaseHex(input.sourceDiffSha256, HEX64, "source diff SHA-256"),
    baseDashboard: dashboardMetadata(input.baseDashboard, "base"),
    headDashboard: dashboardMetadata(input.headDashboard, "head"),
    workflowRunId,
    workflowRunAttempt,
  });
}

function dashboardAttestationSha256(input) {
  return sha256(`${JSON.stringify(dashboardAttestationRecord(input))}\n`);
}

function directoryLedger(root) {
  const absoluteRoot = path.resolve(root);
  const ledger = [];
  const folded = new Set();
  let totalBytes = 0;

  function walk(directory, relativeDirectory = "") {
    const names = fs.readdirSync(directory).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    for (const name of names) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      safePath(relativePath, "dashboard directory path");
      const key = relativePath.toLowerCase();
      if (folded.has(key)) throw new TypeError(`dashboard directory contains a case duplicate: ${relativePath}`);
      folded.add(key);
      const absolutePath = path.join(directory, name);
      const stat = fs.lstatSync(absolutePath);
      if (stat.isSymbolicLink()) throw new TypeError(`dashboard directory contains a symbolic link: ${relativePath}`);
      if (stat.isDirectory()) {
        ledger.push({ path: relativePath, mode: "040000", size: 0, sha256: null });
        walk(absolutePath, relativePath);
      } else if (stat.isFile()) {
        if (stat.size > MAX_FILE_BYTES) throw new TypeError(`dashboard file exceeds the byte limit: ${relativePath}`);
        totalBytes += stat.size;
        if (totalBytes > MAX_TREE_BYTES) throw new TypeError("dashboard directory exceeds the total byte limit");
        const mode = (stat.mode & 0o111) === 0 ? "100644" : "100755";
        ledger.push({ path: relativePath, mode, size: stat.size, sha256: sha256(fs.readFileSync(absolutePath)) });
      } else {
        throw new TypeError(`dashboard directory contains an unsupported entry: ${relativePath}`);
      }
      if (ledger.length > MAX_TREE_ENTRIES) throw new TypeError("dashboard directory exceeds the entry limit");
    }
  }
  const rootStat = fs.lstatSync(absoluteRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new TypeError("dashboard comparison root is not a real directory");
  walk(absoluteRoot);
  return ledger;
}

function compareDashboardDirectories(committed, rebuilt) {
  try {
    const committedLedger = directoryLedger(committed);
    const rebuiltLedger = directoryLedger(rebuilt);
    const length = Math.max(committedLedger.length, rebuiltLedger.length);
    for (let index = 0; index < length; index += 1) {
      const left = committedLedger[index];
      const right = rebuiltLedger[index];
      if (JSON.stringify(left) !== JSON.stringify(right)) {
        const entryPath = left?.path || right?.path || "unknown";
        return { ok: false, error: `rebuilt dashboard differs at ${entryPath}` };
      }
    }
    const digest = sha256(`${JSON.stringify(committedLedger)}\n`);
    return { ok: true, digest, fileCount: committedLedger.filter((entry) => entry.mode !== "040000").length };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

module.exports = {
  DASHBOARD_REVIEW_EVIDENCE_TYPE,
  DASHBOARD_REPRO_CONTEXT,
  DASHBOARD_REPRO_DESCRIPTION_PREFIX,
  DASHBOARD_REPRO_WORKFLOW,
  DASHBOARD_REPRO_PUBLISH_WORKFLOW,
  DASHBOARD_TRUST_ANCHORS,
  canonicalPullRequestReview,
  validateDashboardTree,
  dashboardAttestationRecord,
  dashboardAttestationSha256,
  compareDashboardDirectories,
};
