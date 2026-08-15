import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import reviewLib from "../container/artifact-review.js";

const {
  REVIEW_STATES,
  validateArtifactBasename,
  validateArtifactContentVersion,
  readArtifactSnapshot,
  readArtifactHeadSnapshot,
  extractArtifactCategory,
  readArtifactReview,
  artifactAdjustmentFingerprint,
  readArtifactAdjustmentOperation,
  beginArtifactAdjustmentOperation,
  transitionArtifactAdjustmentOperation,
  readArtifactAdjustmentReplay,
  inspectArtifactReview,
  writeArtifactReviewSidecar,
} = reviewLib;

function fixture(t, name = "launch-concept.html", body = [
  "<!doctype html><html><head>",
  '<meta name="agenthost:category" content="creative">',
  "<title>Launch concept</title></head><body>Keep this body.</body></html>",
].join("\n")) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-review-"));
  const artifacts = path.join(root, "artifacts");
  const reviews = path.join(root, "gate-state", "artifact-reviews");
  fs.mkdirSync(artifacts, { recursive: true });
  fs.mkdirSync(reviews, { recursive: true, mode: 0o700 });
  const file = path.join(artifacts, name);
  fs.writeFileSync(file, body);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, artifacts, reviews, file, name };
}

test("review state and artifact basenames have one strict contract", () => {
  assert.deepEqual(REVIEW_STATES, ["approved", "rejected", "changes-requested"]);
  for (const name of ["launch.html", "Launch_2.MD", "a-b.c.html"]) {
    assert.equal(validateArtifactBasename(name), name);
  }
  for (const bad of ["../launch.html", "sub/launch.md", ".hidden.html", "launch.txt", "launch\n.html", "r\u00e9sum\u00e9.html", ""] ) {
    assert.throws(() => validateArtifactBasename(bad), /safe ASCII/);
  }
  assert.equal(validateArtifactContentVersion("a".repeat(64)), "a".repeat(64));
  for (const bad of ["", "A".repeat(64), "a".repeat(63), "g".repeat(64), {}, null]) {
    assert.throws(() => validateArtifactContentVersion(bad), /content version/);
  }
});

test("list metadata and the full snapshot share one opaque file version", (t) => {
  const f = fixture(t);
  const head = readArtifactHeadSnapshot(f.artifacts, f.name, { maxBytes: 1024, headBytes: 64 });
  const snapshot = readArtifactSnapshot(f.artifacts, f.name, {
    maxBytes: 1024,
    expectedVersion: head.contentVersion,
  });
  assert.match(head.contentVersion, /^[a-f0-9]{64}$/);
  assert.equal(snapshot.contentVersion, head.contentVersion);

  fs.appendFileSync(f.file, "\nchanged\n");
  assert.throws(
    () => readArtifactSnapshot(f.artifacts, f.name, { expectedVersion: head.contentVersion }),
    /changed since this Creative list loaded/,
  );
});

test("a path swap after open cannot make a versioned snapshot return replacement bytes", (t) => {
  const f = fixture(t);
  const listed = readArtifactHeadSnapshot(f.artifacts, f.name);
  const originalRead = fs.readSync;
  const replacement = path.join(f.artifacts, "replacement.html");
  const displaced = path.join(f.artifacts, "displaced.html");
  fs.writeFileSync(replacement, "<!doctype html><title>UNREVIEWED REPLACEMENT</title>");
  let swapped = false;
  fs.readSync = function swapAfterOpen(descriptor, ...args) {
    if (!swapped) {
      swapped = true;
      fs.renameSync(f.file, displaced);
      try { fs.symlinkSync(replacement, f.file, "file"); }
      catch {
        fs.copyFileSync(replacement, f.file);
      }
    }
    return originalRead.call(this, descriptor, ...args);
  };
  try {
    assert.throws(
      () => readArtifactSnapshot(f.artifacts, f.name, { expectedVersion: listed.contentVersion }),
      /changed while it was being read/,
    );
  } finally {
    fs.readSync = originalRead;
  }
});

test("HTML category scanning ignores every non-markup context", () => {
  const fake = '<meta name="agenthost:category" content="report">';
  const source = [
    "<!doctype html><html>",
    `<!-- <head>${fake}</head> -->`,
    `<script>${fake}</script><style>${fake}</style><template>${fake}</template><noscript>${fake}</noscript>`,
    "<head>",
    `<title>${fake}</title>`,
    `<textarea>${fake}</textarea>`,
    `<xmp>${fake}</xmp>`,
    `<iframe>${fake}</iframe>`,
    `<noembed>${fake}</noembed>`,
    '<meta content="creative" name = "agenthost:category">',
    "</head><body>Original</body></html>",
  ].join("\n");
  assert.equal(extractArtifactCategory(source, ".html"), "creative");

  const plaintext = `<html><head><plaintext>${fake}</head><body></body></html>`;
  assert.equal(extractArtifactCategory(plaintext, ".html"), null,
    "plaintext consumes the rest of the document; its fake meta is not markup");
  const duplicate = source.replace("</head><body>", '<meta name="agenthost:category" content="creative"></head><body>');
  assert.equal(extractArtifactCategory(duplicate, ".html"), null,
    "ambiguous duplicate declarations fail closed");
});

test("Markdown category comes only from one closed frontmatter declaration", () => {
  assert.equal(extractArtifactCategory("---\ncategory: creative\n---\n# Body\n", ".md"), "creative");
  assert.equal(extractArtifactCategory("---\ntitle: Notes\n---\ncategory: creative\n", ".md"), null);
  assert.equal(extractArtifactCategory("---\ncategory: creative\ncategory: report\n---\n", ".md"), null);
});

test("a review is an atomic digest-bound sidecar and never mutates the artifact", (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(f.file);
  const snapshot = readArtifactSnapshot(f.artifacts, f.name, { maxBytes: 1024 });
  assert.equal(snapshot.digest, crypto.createHash("sha256").update(before).digest("hex"));
  assert.equal(extractArtifactCategory(snapshot.text, snapshot.ext), "creative");

  assert.equal(writeArtifactReviewSidecar(snapshot, "approved", {
    rootDir: f.artifacts,
    reviewDir: f.reviews,
    maxBytes: 1024,
  }), "approved");
  assert.deepEqual(fs.readFileSync(f.file), before, "the gate changed agent-owned artifact bytes");
  assert.deepEqual(readArtifactReview(snapshot, { reviewDir: f.reviews }), { review: "approved", error: null, stale: false });

  const entries = fs.readdirSync(f.reviews);
  assert.deepEqual(entries, [`${crypto.createHash("sha256").update(f.name).digest("hex")}.json`]);
  const row = JSON.parse(fs.readFileSync(path.join(f.reviews, entries[0]), "utf8"));
  assert.deepEqual(row, {
    version: 1,
    artifact: f.name,
    content_sha256: snapshot.digest,
    review: "approved",
  });
  writeArtifactReviewSidecar(snapshot, "rejected", {
    rootDir: f.artifacts,
    reviewDir: f.reviews,
    maxBytes: 1024,
  });
  assert.deepEqual(readArtifactReview(snapshot, { reviewDir: f.reviews }), { review: "rejected", error: null, stale: false },
    "atomic replacement did not update an existing sidecar");
  assert.deepEqual(fs.readdirSync(f.reviews), entries, "an update left a transaction file behind");
});

test("a saved adjustment can replay one exact operation without another task", (t) => {
  const f = fixture(t);
  const snapshot = readArtifactSnapshot(f.artifacts, f.name);
  const operationId = "review-op-1234567890";
  const feedback = "Make the CTA specific.";
  const requestSha256 = artifactAdjustmentFingerprint({
    name: f.name,
    contentVersion: snapshot.contentVersion,
    action: "request-adjustments",
    feedback,
  });
  const task = { id: "creative-task-1", title: "Revise creative artifact", assignee: "codex" };

  writeArtifactReviewSidecar(snapshot, "changes-requested", {
    rootDir: f.artifacts,
    reviewDir: f.reviews,
    adjustment: { operationId, requestSha256, task },
  });
  assert.deepEqual(readArtifactAdjustmentReplay(snapshot, { operationId, requestSha256 }, { reviewDir: f.reviews }), {
    task,
    error: null,
  });
  assert.match(
    readArtifactAdjustmentReplay(snapshot, { operationId, requestSha256: "0".repeat(64) }, { reviewDir: f.reviews }).error,
    /different review request/,
  );
});

test("an adjustment operation is durably pending before task creation and survives process state loss", (t) => {
  const f = fixture(t);
  const snapshot = readArtifactSnapshot(f.artifacts, f.name);
  const operationId = "review-durable-pending-0001";
  const requestSha256 = artifactAdjustmentFingerprint({
    name: f.name,
    contentVersion: snapshot.contentVersion,
    action: "request-adjustments",
    feedback: "Strengthen the proof.",
  });
  const options = { reviewDir: f.reviews };
  const first = beginArtifactAdjustmentOperation({
    operationId,
    requestSha256,
    artifact: f.name,
    contentVersion: snapshot.contentVersion,
    contentDigest: snapshot.digest,
  }, options);
  assert.equal(first.created, true);
  assert.equal(first.receipt.status, "pending");
  const receiptFiles = fs.readdirSync(f.reviews).filter((name) => name.endsWith(".operation.json"));
  assert.equal(receiptFiles.length, 1);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.join(f.reviews, receiptFiles[0])).mode & 0o777, 0o600);
  }

  const afterRestart = beginArtifactAdjustmentOperation({
    operationId,
    requestSha256,
    artifact: f.name,
    contentVersion: snapshot.contentVersion,
    contentDigest: snapshot.digest,
  }, options);
  assert.equal(afterRestart.created, false);
  assert.equal(afterRestart.receipt.status, "pending");
  assert.throws(() => beginArtifactAdjustmentOperation({
    operationId,
    requestSha256: "b".repeat(64),
    artifact: f.name,
    contentVersion: snapshot.contentVersion,
    contentDigest: snapshot.digest,
  }, options), /already used for a different review request/);

  const task = { id: "creative-task-durable", title: "Revise creative artifact", assignee: "codex" };
  transitionArtifactAdjustmentOperation({ operationId, requestSha256, task }, "confirmed", options);
  transitionArtifactAdjustmentOperation({ operationId, requestSha256, task }, "completed", options);
  const completed = readArtifactAdjustmentOperation({ operationId, requestSha256 }, options);
  assert.equal(completed.error, null);
  assert.equal(completed.receipt.status, "completed");
  assert.deepEqual(completed.receipt.task, task);
});

test("rewriting artifact content immediately invalidates its prior approval", (t) => {
  const f = fixture(t);
  const approved = readArtifactSnapshot(f.artifacts, f.name);
  writeArtifactReviewSidecar(approved, "approved", { rootDir: f.artifacts, reviewDir: f.reviews });
  assert.deepEqual(readArtifactReview(approved, { reviewDir: f.reviews }), { review: "approved", error: null, stale: false });

  fs.appendFileSync(f.file, "\n<!-- author revision -->\n");
  const revised = readArtifactSnapshot(f.artifacts, f.name);
  assert.notEqual(revised.digest, approved.digest);
  assert.deepEqual(readArtifactReview(revised, { reviewDir: f.reviews }), {
    review: null,
    error: null,
    stale: true,
  });
  assert.throws(
    () => writeArtifactReviewSidecar(approved, "rejected", { rootDir: f.artifacts, reviewDir: f.reviews }),
    /artifact changed before its review could be saved/,
  );
});

test("fingerprinting refuses symlink, non-regular, oversized, and invalid UTF-8 artifacts", (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.artifacts, "folder.html"));
  assert.throws(() => readArtifactSnapshot(f.artifacts, "folder.html"), /not a regular file/);
  assert.throws(() => readArtifactSnapshot(f.artifacts, f.name, { maxBytes: 8 }), /exceeds the 8-byte limit/);

  fs.writeFileSync(path.join(f.artifacts, "invalid.md"), Buffer.from([0xff, 0xfe, 0xfd]));
  assert.throws(() => readArtifactSnapshot(f.artifacts, "invalid.md"), /not valid UTF-8/);

  const target = path.join(f.artifacts, "target.md");
  const link = path.join(f.artifacts, "link.md");
  fs.writeFileSync(target, "# Target\n");
  try { fs.symlinkSync(target, link, "file"); }
  catch (error) {
    t.diagnostic(`symlink refusal not exercised on this host: ${error.message}`);
    return;
  }
  assert.throws(() => readArtifactSnapshot(f.artifacts, "link.md"), /symbolic link/);
});

test("review state names a symlinked sidecar and never follows or overwrites it", (t) => {
  const f = fixture(t);
  const snapshot = readArtifactSnapshot(f.artifacts, f.name);
  const outside = path.join(f.root, "outside.json");
  fs.writeFileSync(outside, "outside\n");
  const sidecar = path.join(f.reviews, `${crypto.createHash("sha256").update(f.name).digest("hex")}.json`);
  try { fs.symlinkSync(outside, sidecar, "file"); }
  catch (error) {
    t.diagnostic(`sidecar symlink replacement not exercised on this host: ${error.message}`);
    return;
  }
  const state = readArtifactReview(snapshot, { reviewDir: f.reviews });
  assert.equal(state.review, null);
  assert.match(state.error, /symbolic link/);
  assert.throws(
    () => writeArtifactReviewSidecar(snapshot, "rejected", { rootDir: f.artifacts, reviewDir: f.reviews }),
    /symbolic link/,
  );
  assert.equal(fs.readFileSync(outside, "utf8"), "outside\n");
});

test("an absent sidecar does not open or hash the artifact", (t) => {
  const f = fixture(t);
  const original = fs.openSync;
  let artifactOpens = 0;
  fs.openSync = function patched(file, ...args) {
    if (path.resolve(String(file)) === path.resolve(f.file)) artifactOpens += 1;
    return original.call(this, file, ...args);
  };
  try {
    assert.deepEqual(reviewLib.inspectArtifactReview(f.artifacts, f.name, { reviewDir: f.reviews }), {
      review: null,
      error: null,
      stale: false,
      snapshot: null,
    });
  } finally {
    fs.openSync = original;
  }
  assert.equal(artifactOpens, 0, "a never-reviewed artifact was synchronously hashed");
});

test("an unchanged reviewed artifact reuses its verified digest, while any rewrite is rehashed", (t) => {
  const f = fixture(t);
  const approved = readArtifactSnapshot(f.artifacts, f.name);
  writeArtifactReviewSidecar(approved, "approved", { rootDir: f.artifacts, reviewDir: f.reviews });

  const originalOpen = fs.openSync;
  const originalRead = fs.readSync;
  const artifactDescriptors = new Set();
  let artifactBytesRead = 0;
  fs.openSync = function patchedOpen(file, ...args) {
    const descriptor = originalOpen.call(this, file, ...args);
    if (path.resolve(String(file)) === path.resolve(f.file)) artifactDescriptors.add(descriptor);
    return descriptor;
  };
  fs.readSync = function patchedRead(descriptor, ...args) {
    const count = originalRead.call(this, descriptor, ...args);
    if (artifactDescriptors.has(descriptor)) artifactBytesRead += count;
    return count;
  };
  try {
    assert.deepEqual(inspectArtifactReview(f.artifacts, f.name, { reviewDir: f.reviews }), {
      review: "approved",
      error: null,
      stale: false,
      snapshot: {
        name: f.name,
        ext: ".html",
        digest: approved.digest,
        contentVersion: approved.contentVersion,
        size: approved.size,
        mtimeMs: approved.mtimeMs,
      },
    });
    assert.equal(artifactBytesRead, 0, "an unchanged reviewed artifact was read and hashed again");

    const before = fs.statSync(f.file);
    const revised = fs.readFileSync(f.file, "utf8").replace("Keep this body.", "Newer body now.");
    assert.equal(Buffer.byteLength(revised), before.size, "fixture rewrite must keep the same visible size");
    fs.writeFileSync(f.file, revised);
    fs.utimesSync(f.file, before.atime, before.mtime);
    artifactBytesRead = 0;

    const stale = inspectArtifactReview(f.artifacts, f.name, { reviewDir: f.reviews });
    assert.equal(stale.review, null);
    assert.equal(stale.stale, true, "same-size content with restored mtime retained the old approval");
    assert.ok(artifactBytesRead >= before.size, "a changed artifact did not receive a fresh bounded hash");
  } finally {
    fs.openSync = originalOpen;
    fs.readSync = originalRead;
  }
});

test("the deployed image creates gate-only review state without changing artifact ownership", () => {
  const container = path.join(import.meta.dirname, "..", "container");
  const dockerfile = fs.readFileSync(path.join(container, "Dockerfile"), "utf8");
  const entrypoint = fs.readFileSync(path.join(container, "entrypoint.sh"), "utf8");
  assert.match(dockerfile, /COPY artifact-review\.js \/opt\/agenthost\/artifact-review\.js/);
  assert.match(entrypoint, /ARTIFACT_REVIEW_ROOT=\/data\/agenthost-gate-state/);
  assert.match(entrypoint, /AGENTHOST_FOUNDATION_B[\s\S]{0,100}artifact_review_owner=gate/);
  assert.match(entrypoint, /install -d -o "\$artifact_review_owner" -g "\$artifact_review_owner" -m 0700 "\$review_dir"/);
  assert.doesNotMatch(entrypoint, /chown agent:boxstate[^\n]*artifacts|chmod g\+rw[^\n]*artifacts/,
    "boot must not grant the privileged gate write access to agent-authored files");
});
