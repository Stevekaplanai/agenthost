"use strict";

// Server-side adapter from canonical Growth Brand DNA rows to the same staged
// folder contract consumed by runGraphifySnapshot. Browser choices contain no
// filesystem locations, and canonical rows are copied rather than changed.
const fs = require("node:fs");
const path = require("node:path");
const { BRAND_ASSETS, validateSourceUrl } = require("./brand-dna-source.js");
const { hasCredentialShape, hasSecretAssignment } = require("./graphify-secrets.js");

const BRAND_GRAPHIFY_FOLDER_ID = "brand_all";
const BRAND_GRAPHIFY_FOLDER_LABEL = "Brand DNA";
const ACCOUNT_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const RECORD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const PRIVATE_PATH_RE = /(?:[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/]|\/Users\/)/i;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const BIDI_CONTROL_RE = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const TEMP_PREFIX = "graphify-brand-";
const BRAND_ASSET_SET = new Set(BRAND_ASSETS);
const BRAND_ASSET_ORDER = new Map(BRAND_ASSETS.map((asset, index) => [asset, index]));
const BRAND_GRAPHIFY_LIMITS = Object.freeze({
  maxAccounts: 100,
  maxAccountLabelChars: 120,
  maxTargetLabelChars: 160,
  maxRecords: BRAND_ASSETS.length,
  maxContentChars: 12_000,
  // Leaves room beneath the generic runner's 64 KiB per-file metadata cap and
  // the Brand claim projector's 32 KiB metadata preflight.
  maxContentBytes: 24 * 1024,
  maxTotalContentBytes: 48 * 1024,
  maxProvenanceBytes: 4 * 1024,
});

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function safeBrowserLabel(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= BRAND_GRAPHIFY_LIMITS.maxAccountLabelChars
    && value.trim() === value
    && !/[<>\\/\u0000-\u001f\u007f-\u009f]/.test(value)
    && !BIDI_CONTROL_RE.test(value)
    && !hasCredentialShape(value);
}

function normalizedAccounts(accounts) {
  if (!Array.isArray(accounts)) throw new Error("Graphify Brand accounts must be the current server-fetched account list");
  if (accounts.length > BRAND_GRAPHIFY_LIMITS.maxAccounts) throw new Error("Graphify Brand received too many accounts");
  const ids = new Set();
  const result = accounts.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`Graphify Brand account ${index + 1} is invalid`);
    }
    const accountId = raw.account_id;
    if (typeof accountId !== "string" || !ACCOUNT_ID_RE.test(accountId)) {
      throw new Error(`Graphify Brand account ${index + 1} has an unsafe account id`);
    }
    if (!safeBrowserLabel(raw.name)) {
      throw new Error(`Graphify Brand account ${accountId} has an unsafe browser label`);
    }
    if (ids.has(accountId)) throw new Error(`Graphify Brand duplicates account id ${accountId}`);
    ids.add(accountId);
    return { accountId, label: raw.name };
  });
  return result.sort((left, right) => (left.accountId < right.accountId ? -1 : left.accountId > right.accountId ? 1 : 0));
}

function browserTarget(account) {
  const suffix = ` (${account.accountId})`;
  const available = BRAND_GRAPHIFY_LIMITS.maxTargetLabelChars - suffix.length;
  let name = account.label;
  if (name.length > available) {
    name = name.slice(0, available - 1);
    if (/[\ud800-\udbff]$/.test(name)) name = name.slice(0, -1);
    name = `${name.trimEnd()}…`;
  }
  return {
    id: `brand:${account.accountId}`,
    label: `${name}${suffix}`,
    kind: "brand",
    folders: [{ id: BRAND_GRAPHIFY_FOLDER_ID, label: BRAND_GRAPHIFY_FOLDER_LABEL }],
    defaultFolderId: BRAND_GRAPHIFY_FOLDER_ID,
  };
}

function listBrandGraphifyTargets(accounts) {
  return normalizedAccounts(accounts).map(browserTarget);
}

function resolveBrandGraphifyChoice(accounts, choice) {
  if (!choice || typeof choice !== "object" || Array.isArray(choice)
      || Object.keys(choice).sort().join(",") !== "folderId,targetId") {
    throw new Error("Graphify Brand choice must contain exactly targetId and folderId");
  }
  if (typeof choice.targetId !== "string" || !choice.targetId.startsWith("brand:")
      || !ACCOUNT_ID_RE.test(choice.targetId.slice("brand:".length))) {
    throw new Error("Graphify Brand target choice is invalid");
  }
  if (choice.folderId !== BRAND_GRAPHIFY_FOLDER_ID) {
    throw new Error("Graphify Brand folder choice is invalid");
  }
  const account = normalizedAccounts(accounts)
    .find((candidate) => `brand:${candidate.accountId}` === choice.targetId);
  if (!account) throw new Error("Graphify Brand target is not a current account");
  const listed = browserTarget(account);
  return {
    target: { id: listed.id, label: listed.label, kind: listed.kind },
    folder: { id: BRAND_GRAPHIFY_FOLDER_ID, label: BRAND_GRAPHIFY_FOLDER_LABEL },
    accountId: account.accountId,
  };
}

function normalizedProvenance(value, asset) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Graphify Brand generated ${asset} record requires valid provenance`);
  }
  let rawBytes;
  try { rawBytes = Buffer.byteLength(JSON.stringify(value), "utf8"); }
  catch { throw new Error(`Graphify Brand generated ${asset} record has invalid provenance`); }
  if (rawBytes > BRAND_GRAPHIFY_LIMITS.maxProvenanceBytes) {
    throw new Error(`Graphify Brand generated ${asset} record exceeds the provenance byte limit`);
  }
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "generated_at,source_url,source_urls") {
    throw new Error(`Graphify Brand generated ${asset} record has invalid provenance`);
  }
  let sourceUrl;
  const sourceUrls = [];
  try {
    sourceUrl = validateSourceUrl(value.source_url).href;
    if (!Array.isArray(value.source_urls) || value.source_urls.length > 5) throw new Error("source_urls is invalid");
    for (const raw of value.source_urls) sourceUrls.push(validateSourceUrl(raw).href);
  } catch (error) {
    throw new Error(`Graphify Brand generated ${asset} record has invalid provenance (${String(error.message || error).slice(0, 120)})`);
  }
  const generated = new Date(String(value.generated_at || ""));
  if (!Number.isFinite(generated.getTime())) {
    throw new Error(`Graphify Brand generated ${asset} record has invalid provenance timestamp`);
  }
  const result = { source_url: sourceUrl, source_urls: sourceUrls, generated_at: generated.toISOString() };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > BRAND_GRAPHIFY_LIMITS.maxProvenanceBytes) {
    throw new Error(`Graphify Brand generated ${asset} record exceeds the provenance byte limit`);
  }
  return result;
}

function normalizedRecords(records, accountId) {
  if (!Array.isArray(records) || records.length < 1) {
    throw new Error("Graphify Brand requires at least one canonical Brand DNA record");
  }
  if (records.length > BRAND_GRAPHIFY_LIMITS.maxRecords) {
    throw new Error(`Graphify Brand accepts at most ${BRAND_GRAPHIFY_LIMITS.maxRecords} canonical records`);
  }
  const assets = new Set();
  let totalBytes = 0;
  const result = records.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`Graphify Brand record ${index + 1} is invalid`);
    }
    const asset = raw.asset;
    if (typeof asset !== "string" || !BRAND_ASSET_SET.has(asset)) {
      throw new Error(`Graphify Brand record ${index + 1} has an invalid asset`);
    }
    if (assets.has(asset)) throw new Error(`Graphify Brand duplicates asset ${asset}`);
    assets.add(asset);
    if (raw.source !== "client" && raw.source !== "generated") {
      throw new Error(`Graphify Brand ${asset} record has an invalid source`);
    }
    if (raw.account_id !== accountId) {
      throw new Error(`Graphify Brand ${asset} record has a missing or different account id`);
    }
    if (typeof raw.id !== "string" || !RECORD_ID_RE.test(raw.id)) {
      throw new Error(`Graphify Brand ${asset} record has an invalid id`);
    }
    if (!Number.isSafeInteger(raw.version) || raw.version < 0) {
      throw new Error(`Graphify Brand ${asset} record has an invalid version`);
    }
    if (!Number.isSafeInteger(raw.schemaVersion) || raw.schemaVersion < 1) {
      throw new Error(`Graphify Brand ${asset} record has an invalid schemaVersion`);
    }
    const updated = new Date(String(raw.updated_at || ""));
    if (!Number.isFinite(updated.getTime())) {
      throw new Error(`Graphify Brand ${asset} record has an invalid updated_at`);
    }
    if (typeof raw.content !== "string" || raw.content.length < 1) {
      throw new Error(`Graphify Brand ${asset} record has empty content`);
    }
    if (raw.content.trim() !== raw.content) {
      throw new Error(`Graphify Brand ${asset} record has non-canonical surrounding whitespace`);
    }
    if (CONTROL_RE.test(raw.content)) throw new Error(`Graphify Brand ${asset} record contains a control character`);
    if (Buffer.from(raw.content, "utf8").toString("utf8") !== raw.content) {
      throw new Error(`Graphify Brand ${asset} record is not valid UTF-8 text`);
    }
    if (hasCredentialShape(raw.content)) throw new Error(`Graphify Brand ${asset} record contains a credential-shaped value`);
    if (hasSecretAssignment(raw.content)) throw new Error(`Graphify Brand ${asset} record contains a credential assignment`);
    if (PRIVATE_PATH_RE.test(raw.content)) throw new Error(`Graphify Brand ${asset} record contains a private path`);
    if (raw.content.length > BRAND_GRAPHIFY_LIMITS.maxContentChars) {
      throw new Error(`Graphify Brand ${asset} record exceeds the character limit`);
    }
    const contentBytes = Buffer.byteLength(raw.content, "utf8");
    if (contentBytes > BRAND_GRAPHIFY_LIMITS.maxContentBytes) {
      throw new Error(`Graphify Brand ${asset} record exceeds the byte limit`);
    }
    totalBytes += contentBytes;
    if (totalBytes > BRAND_GRAPHIFY_LIMITS.maxTotalContentBytes) {
      throw new Error("Graphify Brand records exceed the total content byte limit");
    }
    if (raw.source === "client" && raw.provenance !== undefined) {
      throw new Error(`Graphify Brand client ${asset} record cannot carry generated provenance`);
    }
    const provenance = raw.source === "generated" ? normalizedProvenance(raw.provenance, asset) : null;
    return {
      id: raw.id,
      account_id: accountId,
      asset,
      source: raw.source,
      content: raw.content,
      version: raw.version,
      updated_at: updated.toISOString(),
      schemaVersion: raw.schemaVersion,
      ...(provenance ? { provenance } : {}),
    };
  });
  return result.sort((left, right) => BRAND_ASSET_ORDER.get(left.asset) - BRAND_ASSET_ORDER.get(right.asset));
}

function canonicalPrivateRoot(stagingRoot) {
  if (typeof stagingRoot !== "string" || !path.isAbsolute(stagingRoot) || stagingRoot.includes("\0")) {
    throw new Error("Graphify Brand staging root must be a real non-symlink directory");
  }
  const expected = path.resolve(stagingRoot);
  let stat;
  try { stat = fs.lstatSync(expected); }
  catch { throw new Error("Graphify Brand staging root must be a real non-symlink directory"); }
  let real;
  try { real = fs.realpathSync(expected); }
  catch { throw new Error("Graphify Brand staging root must be a real non-symlink directory"); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(real, expected)) {
    throw new Error("Graphify Brand staging root must be a real non-symlink directory");
  }
  if (process.platform !== "win32") {
    if ((stat.mode & 0o077) !== 0) throw new Error("Graphify Brand staging root must be private to the gate user");
    if (typeof process.geteuid === "function" && stat.uid !== process.geteuid()) {
      throw new Error("Graphify Brand staging root must be owned by the gate user");
    }
  }
  return expected;
}

function assertExactTempPath(stagingRoot, jobRoot) {
  const relative = path.relative(stagingRoot, jobRoot);
  if (!relative || relative.includes(path.sep) || !relative.startsWith(TEMP_PREFIX)
      || !inside(stagingRoot, jobRoot)) {
    throw new Error("Graphify Brand cleanup refused a path outside its exact temporary folder");
  }
}

function removeExactTemp(stagingRoot, jobRoot) {
  assertExactTempPath(stagingRoot, jobRoot);
  if (!samePath(canonicalPrivateRoot(stagingRoot), stagingRoot)) {
    throw new Error("Graphify Brand cleanup refused a changed staging root");
  }
  let stat;
  try { stat = fs.lstatSync(jobRoot); }
  catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fs.unlinkSync(jobRoot);
    return;
  }
  if (!samePath(fs.realpathSync(jobRoot), jobRoot)) {
    throw new Error("Graphify Brand cleanup refused a redirected temporary folder");
  }
  fs.rmSync(jobRoot, { recursive: true, force: false });
}

function fileMetadataFor(accountId, record) {
  const confidence = record.source === "client" ? "EXTRACTED" : "INFERRED";
  const claim = {
    account_id: accountId,
    asset: record.asset,
    claim: record.content,
    confidence,
    source: record.source,
  };
  return { account_id: accountId, asset: record.asset, claims: [claim] };
}

function inertMarkdownBody(content) {
  // JSON escapes preserve the exact canonical text when decoded. Escaping the
  // bracket delimiters too keeps AgentHost's supplemental wiki-link scanner
  // from treating examples inside the fenced representation as real edges.
  return JSON.stringify(content)
    .replace(/\[/g, "\\u005b")
    .replace(/\]/g, "\\u005d")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function materializeBrandGraphifyCorpus(input = {}) {
  const choice = resolveBrandGraphifyChoice(input.accounts, {
    targetId: input.targetId,
    folderId: input.folderId,
  });
  const records = normalizedRecords(input.records, choice.accountId);
  const stagingRoot = canonicalPrivateRoot(input.stagingRoot);
  let jobRoot;
  const fileMetadata = {};
  try {
    jobRoot = fs.mkdtempSync(path.join(stagingRoot, TEMP_PREFIX));
    assertExactTempPath(stagingRoot, jobRoot);
    fs.chmodSync(jobRoot, 0o700);
    if (!samePath(canonicalPrivateRoot(stagingRoot), stagingRoot)
        || !samePath(fs.realpathSync(jobRoot), jobRoot)) {
      throw new Error("Graphify Brand staging root changed while its temporary folder was created");
    }
    const brandRoot = path.join(jobRoot, "brand");
    fs.mkdirSync(brandRoot, { recursive: false, mode: 0o700 });
    if (!samePath(fs.realpathSync(brandRoot), brandRoot) || fs.lstatSync(brandRoot).isSymbolicLink()) {
      throw new Error("Graphify Brand destination became a symbolic link");
    }
    for (const record of records) {
      const relative = `brand/${record.asset}.md`;
      const destination = path.join(jobRoot, ...relative.split("/"));
      // The pinned Markdown extractor creates a node for every heading and
      // copies file metadata to every node from that file. A fenced JSON string
      // keeps arbitrary client Markdown as one document node, so one canonical
      // DNA record can never fan out into duplicate projected claims.
      const markdown = ["```text", inertMarkdownBody(record.content), "```", ""].join("\n");
      fs.writeFileSync(destination, markdown, { flag: "wx", mode: 0o600 });
      const stat = fs.lstatSync(destination);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !samePath(fs.realpathSync(destination), destination)) {
        throw new Error(`Graphify Brand destination is not a regular single-link file: ${relative}`);
      }
      fs.utimesSync(destination, new Date(record.updated_at), new Date(record.updated_at));
      fs.chmodSync(destination, 0o400);
      fileMetadata[relative] = fileMetadataFor(choice.accountId, record);
    }
  } catch (error) {
    if (jobRoot) removeExactTemp(stagingRoot, jobRoot);
    throw error;
  }

  let cleaned = false;
  return {
    plan: {
      target: { ...choice.target },
      folder: { ...choice.folder },
      sourceRoot: jobRoot,
      includeRoots: ["brand"],
      extensions: [".md"],
      allowedBasenames: [],
      maxDepth: 1,
      redactInputs: true,
      snapshotKind: "folder",
    },
    fileMetadata,
    cleanup() {
      if (cleaned) return;
      removeExactTemp(stagingRoot, jobRoot);
      cleaned = true;
    },
    accountId: choice.accountId,
    records,
  };
}

module.exports = {
  BRAND_GRAPHIFY_FOLDER_ID,
  BRAND_GRAPHIFY_LIMITS,
  listBrandGraphifyTargets,
  materializeBrandGraphifyCorpus,
  resolveBrandGraphifyChoice,
};
