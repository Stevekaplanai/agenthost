import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { enrichPullRequestFiles, parseArgs, writePrivateFile } from "../scripts/dashboard-review-attestation.mjs";

const require = createRequire(import.meta.url);
const review = require("../container/review-attestation.js");
const gate = require("../container/gate.js");

function blobSha(bytes) {
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, "utf8");
  return crypto.createHash("sha1").update(`blob ${body.length}\0`).update(body).digest("hex");
}

function dashboardFixture(overrides = {}) {
  const fingerprint = `${"a".repeat(64)}\n`;
  const index = "<!doctype html>\n";
  const manifest = `${JSON.stringify({ version: 1, files: [
    { path: ".source-sha256", sha256: crypto.createHash("sha256").update(fingerprint).digest("hex") },
    { path: "index.html", sha256: crypto.createHash("sha256").update(index).digest("hex") },
  ] }, null, 2)}\n`;
  const tree = {
    sha: "1".repeat(40),
    truncated: false,
    tree: [
      { path: ".export-manifest.json", mode: "100644", type: "blob", sha: blobSha(manifest), size: Buffer.byteLength(manifest) },
      { path: ".source-sha256", mode: "100644", type: "blob", sha: blobSha(fingerprint), size: Buffer.byteLength(fingerprint) },
      { path: "index.html", mode: "100644", type: "blob", sha: blobSha(index), size: Buffer.byteLength(index) },
    ],
  };
  return { tree: { ...tree, ...overrides.tree }, manifest: overrides.manifest ?? manifest, fingerprint: overrides.fingerprint ?? fingerprint };
}

function git(root, args, options = {}) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: options.encoding ?? "utf8",
    input: options.input,
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
}

function exactBlobFixture(t, baseBytes = "old\n", headBytes = "new\n", filename = "src/example.txt", headFilename = filename) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-exact-blob-patch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.name", "AgentHost Test"]);
  git(root, ["config", "user.email", "test@agenthost.invalid"]);
  git(root, ["config", "core.autocrlf", "false"]);
  const absolute = path.join(root, ...filename.split("/"));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, baseBytes);
  git(root, ["add", "--", filename]);
  git(root, ["commit", "--quiet", "-m", "base"]);
  const baseSha = git(root, ["rev-parse", "HEAD"]).trim();
  const baseBlobSha = git(root, ["rev-parse", `${baseSha}:${filename}`]).trim();
  const headAbsolute = path.join(root, ...headFilename.split("/"));
  if (headFilename !== filename) {
    fs.mkdirSync(path.dirname(headAbsolute), { recursive: true });
    git(root, ["mv", "--", filename, headFilename]);
  }
  fs.writeFileSync(headAbsolute, headBytes);
  git(root, ["add", "--", headFilename]);
  git(root, ["commit", "--quiet", "--allow-empty", "-m", "head"]);
  const headSha = git(root, ["rev-parse", "HEAD"]).trim();
  const headBlobSha = git(root, ["rev-parse", `${headSha}:${headFilename}`]).trim();
  return { root, filename: headFilename, previousFilename: filename, baseSha, headSha, baseBlobSha, headBlobSha };
}

function exactAddedBlobFixture(t, headBytes, filename) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-exact-added-patch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.name", "AgentHost Test"]);
  git(root, ["config", "user.email", "test@agenthost.invalid"]);
  git(root, ["config", "core.autocrlf", "false"]);
  git(root, ["commit", "--quiet", "--allow-empty", "-m", "base"]);
  const baseSha = git(root, ["rev-parse", "HEAD"]).trim();
  const absolute = path.join(root, ...filename.split("/"));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, headBytes);
  git(root, ["add", "--", filename]);
  git(root, ["commit", "--quiet", "-m", "head"]);
  const headSha = git(root, ["rev-parse", "HEAD"]).trim();
  const headBlobSha = git(root, ["rev-parse", `${headSha}:${filename}`]).trim();
  return { root, filename, baseSha, headSha, headBlobSha };
}

function exactRemovedBlobFixture(t, baseBytes, filename) {
  const added = exactAddedBlobFixture(t, baseBytes, filename);
  git(added.root, ["rm", "--", filename]);
  git(added.root, ["commit", "--quiet", "-m", "remove"]);
  return {
    root: added.root,
    filename,
    baseSha: added.headSha,
    headSha: git(added.root, ["rev-parse", "HEAD"]).trim(),
    baseBlobSha: added.headBlobSha,
  };
}

function missingPatchFile(fixture, overrides = {}) {
  return {
    filename: fixture.filename,
    status: "modified",
    sha: fixture.headBlobSha,
    additions: 1,
    deletions: 1,
    changes: 2,
    ...overrides,
  };
}

test("gate gives dashboard tree metadata and its two blobs exact separate byte bounds", () => {
  const source = fs.readFileSync(new URL("../container/gate.js", import.meta.url), "utf8");
  assert.equal(gate.gitReviewResponseWithinCap("x".repeat(300 * 1024), NaN, 16 * 1024 * 1024), true,
    "tree metadata above the ordinary 256 KiB review cap remains reviewable");
  assert.equal(gate.gitReviewResponseWithinCap("", 16 * 1024 * 1024 + 1, 16 * 1024 * 1024), false,
    "the separate tree metadata cap remains finite");
  assert.match(source, /const GIT_REVIEW_TREE_METADATA_CAP = 16 \* 1024 \* 1024/);
  assert.match(source, /async function gitHubRequest\(repo, method, suffix, body, accept, responseCap = GIT_REVIEW_DIFF_CAP\)/);
  assert.match(source, /"\/git\/trees\/" \+ treeSha \+ "\?recursive=1", undefined, undefined, GIT_REVIEW_TREE_METADATA_CAP\)/);

  const manifest = "m".repeat(512 * 1024);
  assert.equal(gate.gitReviewBlobPayload({
    encoding: "base64", size: Buffer.byteLength(manifest), content: Buffer.from(manifest).toString("base64"),
  }, 512 * 1024).ok, true);
  assert.match(gate.gitReviewBlobPayload({
    encoding: "base64", size: Buffer.byteLength(manifest) + 1, content: Buffer.from(`${manifest}m`).toString("base64"),
  }, 512 * 1024).error, /invalid review metadata blob/i);

  const fingerprint = `${"1".repeat(64)}\n`;
  assert.equal(gate.gitReviewBlobPayload({
    encoding: "base64", size: Buffer.byteLength(fingerprint), content: Buffer.from(fingerprint).toString("base64"),
  }, 65).ok, true);
  assert.match(gate.gitReviewBlobPayload({
    encoding: "base64", size: 66, content: Buffer.from(`${"1".repeat(65)}\n`).toString("base64"),
  }, 65).error, /invalid review metadata blob/i);
  assert.match(source, /gitReviewBlobText\(repo, String\(manifest\[0\]\.sha \|\| ""\)\.toLowerCase\(\), GIT_REVIEW_MANIFEST_CAP\)/);
  assert.match(source, /gitReviewBlobText\(repo, String\(fingerprint\[0\]\.sha \|\| ""\)\.toLowerCase\(\), GIT_REVIEW_FINGERPRINT_CAP\)/);
});

function chunkedResponse(chunks, contentLength) {
  const pending = chunks.map((chunk) => chunk instanceof Uint8Array ? chunk : Buffer.from(chunk));
  let pulls = 0;
  let cancels = 0;
  const headers = new Headers({ "content-type": "application/json" });
  if (contentLength !== undefined) headers.set("content-length", String(contentLength));
  const body = new ReadableStream({
    pull(controller) {
      pulls += 1;
      const chunk = pending.shift();
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel() { cancels += 1; },
  }, { highWaterMark: 0 });
  return { response: { headers, body }, stats: () => ({ pulls, cancels }) };
}

test("GitHub response streaming cancels at decoded cap plus one without trusting Content-Length", async () => {
  const source = fs.readFileSync(new URL("../container/gate.js", import.meta.url), "utf8");
  const request = source.slice(source.indexOf("async function gitHubRequest"), source.indexOf("async function gitRepositoryBase"));
  assert.match(request, /await gitHubResponseText\(response, responseCap\)/);
  assert.doesNotMatch(request, /response\.text\(\)/,
    "the request path must enforce the cap before materializing the decoded body");

  const absent = chunkedResponse([
    Buffer.alloc(256 * 1024, 0x61),
    Buffer.from("b"),
    Buffer.from("must-not-be-read"),
  ]);
  assert.deepEqual(await gate.gitHubResponseText(absent.response), {
    error: "GitHub response is too large to review safely",
    oversized: true,
  });
  assert.deepEqual(absent.stats(), { pulls: 2, cancels: 1 },
    "an absent Content-Length must stream only through cap+1, then cancel");

  const invalid = chunkedResponse([Buffer.from("12345678"), Buffer.from("9"), Buffer.from("unread")], "compressed");
  assert.deepEqual(await gate.gitHubResponseText(invalid.response, 8), {
    error: "GitHub response is too large to review safely",
    oversized: true,
  });
  assert.deepEqual(invalid.stats(), { pulls: 2, cancels: 1 },
    "an invalid or compressed Content-Length must not bypass the custom decoded-byte cap");

  const declared = chunkedResponse([Buffer.from("must-not-be-read")], 9);
  assert.deepEqual(await gate.gitHubResponseText(declared.response, 8), {
    error: "GitHub response is too large to review safely",
    oversized: true,
  });
  assert.deepEqual(declared.stats(), { pulls: 0, cancels: 1 },
    "a valid oversized Content-Length may reject early but must still cancel the body");

  const encoded = new TextEncoder().encode('{"value":"é"}');
  const splitAt = encoded.indexOf(0xc3) + 1;
  const valid = chunkedResponse([encoded.subarray(0, splitAt), encoded.subarray(splitAt)]);
  assert.deepEqual(await gate.gitHubResponseText(valid.response, encoded.byteLength), {
    ok: true,
    text: '{"value":"é"}',
  });
});

test("missing GitHub patches are rebuilt only from the verified exact regular blobs", (t) => {
  const fixture = exactBlobFixture(t);
  const [enriched] = enrichPullRequestFiles(
    [missingPatchFile(fixture)],
    fixture.baseSha,
    fixture.headSha,
    { cwd: fixture.root },
  );
  assert.equal(enriched.baseBlobSha, fixture.baseBlobSha);
  assert.equal(enriched.headBlobSha, fixture.headBlobSha);
  assert.equal(enriched.patch, "@@ -1 +1 @@\n-old\n+new\n");
  assert.equal(review.canonicalPullRequestReview([enriched]).ok, true);

  const [zeroCountRecovered] = enrichPullRequestFiles(
    [missingPatchFile(fixture, { additions: 0, deletions: 0, changes: 0 })],
    fixture.baseSha,
    fixture.headSha,
    { cwd: fixture.root },
  );
  assert.deepEqual(
    { additions: zeroCountRecovered.additions, deletions: zeroCountRecovered.deletions, changes: zeroCountRecovered.changes },
    { additions: 1, deletions: 1, changes: 2 },
  );
  assert.equal(review.canonicalPullRequestReview([zeroCountRecovered]).ok, true);

  const supplied = "@@ -1 +1 @@\n-reviewed\n+already";
  const [preserved] = enrichPullRequestFiles(
    [missingPatchFile(fixture, { patch: supplied })],
    fixture.baseSha,
    fixture.headSha,
    { cwd: fixture.root },
  );
  assert.equal(preserved.patch, supplied, "an API-supplied patch must never be replaced");
});

test("missing GitHub patch and zero counts for an added source file are recovered from the exact head blob", (t) => {
  const fixture = exactAddedBlobFixture(
    t,
    "import test from \"node:test\";\nimport assert from \"node:assert/strict\";\ntest(\"stores a graph\", () => assert.ok(true));\n",
    "test/graphify-store.test.js",
  );
  const [enriched] = enrichPullRequestFiles([{
    filename: fixture.filename,
    status: "added",
    sha: fixture.headBlobSha,
    additions: 0,
    deletions: 0,
    changes: 0,
  }], fixture.baseSha, fixture.headSha, { cwd: fixture.root });

  assert.equal(enriched.baseBlobSha, null);
  assert.equal(enriched.headBlobSha, fixture.headBlobSha);
  assert.equal(enriched.patch, "@@ -0,0 +1,3 @@\n+import test from \"node:test\";\n+import assert from \"node:assert/strict\";\n+test(\"stores a graph\", () => assert.ok(true));\n");
  assert.deepEqual(
    { additions: enriched.additions, deletions: enriched.deletions, changes: enriched.changes },
    { additions: 3, deletions: 0, changes: 3 },
  );
  assert.equal(review.canonicalPullRequestReview([enriched]).ok, true);
});

test("missing GitHub patch and zero counts for a removed source file are recovered from the exact base blob", (t) => {
  const fixture = exactRemovedBlobFixture(t, "first line\nsecond line\n", "test/retired-graphify-store.test.js");
  const [enriched] = enrichPullRequestFiles([{
    filename: fixture.filename,
    status: "removed",
    sha: fixture.baseBlobSha,
    additions: 0,
    deletions: 0,
    changes: 0,
  }], fixture.baseSha, fixture.headSha, { cwd: fixture.root });

  assert.equal(enriched.baseBlobSha, fixture.baseBlobSha);
  assert.equal(enriched.headBlobSha, null);
  assert.equal(enriched.patch, "@@ -1,2 +0,0 @@\n-first line\n-second line\n");
  assert.deepEqual(
    { additions: enriched.additions, deletions: enriched.deletions, changes: enriched.changes },
    { additions: 0, deletions: 2, changes: 2 },
  );
  assert.equal(review.canonicalPullRequestReview([enriched]).ok, true);
});

test("exact-blob patch recovery supports renames and ignores Git replacement refs", (t) => {
  const renamed = exactBlobFixture(t, "old\n", "new\n", "src/old.txt", "src/new.txt");
  const [enrichedRename] = enrichPullRequestFiles([missingPatchFile(renamed, {
    status: "renamed",
    previous_filename: renamed.previousFilename,
  })], renamed.baseSha, renamed.headSha, { cwd: renamed.root });
  assert.equal(enrichedRename.patch, "@@ -1 +1 @@\n-old\n+new\n");
  assert.equal(review.canonicalPullRequestReview([enrichedRename]).ok, true);

  const fixture = exactBlobFixture(t);
  const replacementAbsolute = path.join(fixture.root, ...fixture.filename.split("/"));
  fs.writeFileSync(replacementAbsolute, "replacement-base\n");
  git(fixture.root, ["add", "--", fixture.filename]);
  git(fixture.root, ["commit", "--quiet", "-m", "replacement base"]);
  const replacementCommit = git(fixture.root, ["rev-parse", "HEAD"]).trim();
  const replacementBaseBlob = git(fixture.root, ["rev-parse", `${replacementCommit}:${fixture.filename}`]).trim();
  const replacementHeadBlob = git(fixture.root, ["hash-object", "-w", "--stdin"], { input: "replacement-head\n" }).trim();
  git(fixture.root, ["replace", fixture.baseSha, replacementCommit]);
  git(fixture.root, ["replace", fixture.headBlobSha, replacementHeadBlob]);
  const replacedTree = git(fixture.root, ["ls-tree", fixture.baseSha, "--", fixture.filename]);
  assert.match(replacedTree, new RegExp(replacementBaseBlob),
    "the fixture must prove a replacement commit can substitute the selected base tree");
  const replacedDiff = git(fixture.root, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--diff-algorithm=myers",
    "--no-indent-heuristic",
    "--unified=3",
    fixture.baseBlobSha,
    fixture.headBlobSha,
  ]);
  assert.match(replacedDiff, /\+replacement-head/,
    "the fixture must prove a replacement blob can substitute diff input without the guard");
  const [replacementIgnored] = enrichPullRequestFiles(
    [missingPatchFile(fixture)], fixture.baseSha, fixture.headSha, { cwd: fixture.root },
  );
  assert.equal(replacementIgnored.baseBlobSha, fixture.baseBlobSha);
  assert.equal(replacementIgnored.patch, "@@ -1 +1 @@\n-old\n+new\n");
});

test("exact-blob patch recovery rejects absent, malformed, mismatched, binary, and oversized reviews", (t) => {
  const fixture = exactBlobFixture(t);
  const enrich = (file) => enrichPullRequestFiles([file], fixture.baseSha, fixture.headSha, { cwd: fixture.root });
  assert.throws(() => enrich(missingPatchFile(fixture, {
    status: "added",
    sha: fixture.headBlobSha,
    additions: 1,
    deletions: 0,
    changes: 1,
  })), /base commit already contains added/i);
  assert.throws(() => enrich(missingPatchFile(fixture, {
    status: "removed",
    sha: fixture.baseBlobSha,
    additions: 0,
    deletions: 1,
    changes: 1,
  })), /head commit still contains removed/i);
  assert.throws(() => enrich(missingPatchFile(fixture, { additions: "1" })), /additions|counts/i);
  assert.throws(() => enrich(missingPatchFile(fixture, { changes: 3 })), /counts/i);
  assert.throws(() => enrich(missingPatchFile(fixture, { additions: 2, changes: 3 })), /counts|incomplete/i);

  const binary = exactBlobFixture(t, Buffer.from([0x61, 0x00, 0x0a]), Buffer.from([0x62, 0x00, 0x0a]), "src/binary.bin");
  assert.throws(() => enrichPullRequestFiles(
    [missingPatchFile(binary)], binary.baseSha, binary.headSha, { cwd: binary.root },
  ), /binary|hunk/i);

  const unchanged = exactBlobFixture(t, "same\n", "same\n", "src/unchanged.txt");
  assert.throws(() => enrichPullRequestFiles(
    [missingPatchFile(unchanged, { sha: unchanged.headBlobSha })],
    unchanged.baseSha,
    unchanged.headSha,
    { cwd: unchanged.root },
  ), /hunk|nonzero/i);

  const oversized = exactBlobFixture(t, "old\n", `${"x".repeat(256 * 1024)}\n`, "src/oversized.txt");
  assert.throws(() => enrichPullRequestFiles(
    [missingPatchFile(oversized, { sha: oversized.headBlobSha })],
    oversized.baseSha,
    oversized.headSha,
    { cwd: oversized.root },
  ), /limit|large|exceed/i);
});

test("exact-blob patch recovery rejects non-regular blobs and trust anchors remain blocked", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-nonregular-patch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.name", "AgentHost Test"]);
  git(root, ["config", "user.email", "test@agenthost.invalid"]);
  const baseBlobSha = git(root, ["hash-object", "-w", "--stdin"], { input: "old-target\n" }).trim();
  git(root, ["update-index", "--add", "--cacheinfo", `120000,${baseBlobSha},link.txt`]);
  git(root, ["commit", "--quiet", "-m", "base"]);
  const baseSha = git(root, ["rev-parse", "HEAD"]).trim();
  const headBlobSha = git(root, ["hash-object", "-w", "--stdin"], { input: "new-target\n" }).trim();
  git(root, ["update-index", "--cacheinfo", `120000,${headBlobSha},link.txt`]);
  git(root, ["commit", "--quiet", "-m", "head"]);
  const headSha = git(root, ["rev-parse", "HEAD"]).trim();
  assert.throws(() => enrichPullRequestFiles([{
    filename: "link.txt",
    status: "modified",
    sha: headBlobSha,
    additions: 1,
    deletions: 1,
    changes: 2,
  }], baseSha, headSha, { cwd: root }), /regular|mode|type/i);

  const filesJson = path.join(root, "files.json");
  fs.writeFileSync(filesJson, JSON.stringify([{
    filename: "scripts/dashboard-review-attestation.mjs",
    status: "modified",
    sha: headBlobSha,
    additions: 1,
    deletions: 1,
    changes: 2,
  }]));
  assert.throws(() => execFileSync(process.execPath, [
    fileURLToPath(new URL("../scripts/dashboard-review-attestation.mjs", import.meta.url)),
    "source",
    "--repository", "owner/repo",
    "--pull-request", "411",
    "--base-sha", baseSha,
    "--head-sha", headSha,
    "--pr-files", filesJson,
    "--output", path.join(root, "source.txt"),
  ], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), /dashboard review trust anchor/i);
});

test("canonicalPullRequestReview hashes every source patch but omits generated patches", () => {
  const result = review.canonicalPullRequestReview([
    { filename: "container/dashboard-ui/index.html", status: "modified", sha: "2".repeat(40), baseBlobSha: "1".repeat(40), headBlobSha: "2".repeat(40), baseMode: "100644", headMode: "100644", baseType: "blob", headType: "blob", additions: 1, deletions: 1, changes: 2, patch: "GENERATED-BYTES" },
    { filename: "dashboard/app/page.tsx", status: "renamed", previous_filename: "dashboard/app/old.tsx", sha: "3".repeat(40), baseBlobSha: "0".repeat(40), headBlobSha: "3".repeat(40), baseMode: "100644", headMode: "100644", baseType: "blob", headType: "blob", additions: 1, deletions: 1, changes: 2, patch: "@@ -1 +1 @@\n-old\n+new" },
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.sourceFiles.length, 1);
  assert.equal(result.generatedFiles.length, 1);
  assert.match(result.sourceText, /dashboard\/app\/old\.tsx/);
  assert.match(result.sourceText, /@@ -1 \+1 @@/);
  assert.doesNotMatch(result.sourceText, /GENERATED-BYTES/);
  assert.equal(Object.hasOwn(result.generatedFiles[0], "patch"), false);
  assert.equal(result.sourceDiffSha256, crypto.createHash("sha256").update(result.sourceText).digest("hex"));
});

test("canonicalPullRequestReview counts source lines that resemble diff headers inside hunks", () => {
  const result = review.canonicalPullRequestReview([{
    filename: "src/counter.js",
    status: "modified",
    sha: "7".repeat(40),
    baseBlobSha: "8".repeat(40),
    headBlobSha: "7".repeat(40),
    baseMode: "100644",
    headMode: "100644",
    baseType: "blob",
    headType: "blob",
    additions: 1,
    deletions: 1,
    changes: 2,
    patch: "@@ -1 +1 @@\n---counter\n+++counter",
  }]);
  assert.equal(result.ok, true, result.error);
});

test("canonicalPullRequestReview is order independent and fails closed on unsafe or incomplete source files", () => {
  const a = { filename: "z.txt", status: "modified", sha: "4".repeat(40), baseBlobSha: "6".repeat(40), headBlobSha: "4".repeat(40), baseMode: "100644", headMode: "100644", baseType: "blob", headType: "blob", additions: 1, deletions: 0, changes: 1, patch: "@@ -0,0 +1 @@\n+z" };
  const b = { filename: "a.txt", status: "added", sha: "5".repeat(40), baseBlobSha: null, headBlobSha: "5".repeat(40), baseMode: null, headMode: "100644", baseType: null, headType: "blob", additions: 1, deletions: 0, changes: 1, patch: "@@ -0,0 +1 @@\n+a" };
  assert.equal(review.canonicalPullRequestReview([a, b]).sourceDiffSha256, review.canonicalPullRequestReview([b, a]).sourceDiffSha256);
  assert.match(review.canonicalPullRequestReview([{ ...a, filename: "../z.txt" }]).error, /unsafe/i);
  assert.match(review.canonicalPullRequestReview([{ ...a, filename: "safe\u202Etxt.js" }]).error, /unsafe/i);
  assert.match(review.canonicalPullRequestReview([{ ...a, patch: undefined }]).error, /patch/i);
  assert.match(review.canonicalPullRequestReview([a, { ...a, filename: "Z.TXT" }]).error, /case/i);
  assert.match(review.canonicalPullRequestReview([{ ...a, headMode: "100755" }]).error, /mode/i);
  assert.match(review.canonicalPullRequestReview([{ ...a, baseMode: "120000", headMode: "120000" }]).error, /mode/i);
  assert.match(review.canonicalPullRequestReview([{ ...a, baseType: "tree", headType: "tree" }]).error, /type/i);
  assert.match(review.canonicalPullRequestReview([{ ...a, headBlobSha: "e".repeat(40) }]).error, /exact commit tree/i);
  assert.match(review.canonicalPullRequestReview([{ ...a, additions: 2, changes: 2 }]).error, /counts/i);
  assert.match(review.canonicalPullRequestReview([{
    ...a,
    additions: 0,
    deletions: 0,
    changes: 0,
    patch: undefined,
  }]).error, /patch/i);
  const generatedWithoutPatch = review.canonicalPullRequestReview([{
    ...a,
    filename: "container/dashboard-ui/_next/static/chunks/huge.js",
    patch: undefined,
  }]);
  assert.equal(generatedWithoutPatch.ok, true, generatedWithoutPatch.error);
  assert.equal(Object.hasOwn(generatedWithoutPatch.generatedFiles[0], "patch"), false);
});

test("canonicalPullRequestReview permits bounded multi-file source batches above 256 KiB", () => {
  const files = ["a", "b", "c"].map((name, index) => ({
    filename: `${name}.txt`,
    status: "modified",
    sha: String(index + 1).repeat(40),
    baseBlobSha: String(index + 4).repeat(40),
    headBlobSha: String(index + 1).repeat(40),
    baseMode: "100644",
    headMode: "100644",
    baseType: "blob",
    headType: "blob",
    additions: 1,
    deletions: 0,
    changes: 1,
    patch: `@@ -0,0 +1 @@\n+${name}${"x".repeat(200 * 1024)}`,
  }));
  const result = review.canonicalPullRequestReview(files);
  assert.equal(result.ok, true, result.error);
  assert.ok(Buffer.byteLength(result.sourceText) > 512 * 1024);
  assert.equal(result.sourceDiffSha256, review.canonicalPullRequestReview([...files].reverse()).sourceDiffSha256);
});

test("validateDashboardTree binds manifest and fingerprint blobs to one safe complete tree", () => {
  const fixture = dashboardFixture();
  const metadata = review.validateDashboardTree(fixture.tree, fixture.manifest, fixture.fingerprint);
  assert.deepEqual(metadata, {
    treeSha: "1".repeat(40),
    manifestBlobSha: blobSha(fixture.manifest),
    fingerprintBlobSha: blobSha(fixture.fingerprint),
    fingerprint: "a".repeat(64),
    fileCount: 3,
    totalBytes: Buffer.byteLength(fixture.manifest) + Buffer.byteLength(fixture.fingerprint) + Buffer.byteLength("<!doctype html>\n"),
  });
});

test("validateDashboardTree rejects truncation, traversal, case aliases, unsafe modes, and manifest drift", () => {
  const fixture = dashboardFixture();
  assert.throws(() => review.validateDashboardTree({ ...fixture.tree, truncated: true }, fixture.manifest, fixture.fingerprint), /truncated/i);
  for (const entry of [
    { path: "../escape", mode: "100644", type: "blob", sha: "6".repeat(40), size: 1 },
    { path: "link", mode: "120000", type: "blob", sha: "6".repeat(40), size: 1 },
    { path: "program", mode: "100755", type: "blob", sha: "6".repeat(40), size: 1 },
    { path: "vendor", mode: "160000", type: "commit", sha: "6".repeat(40) },
  ]) {
    assert.throws(() => review.validateDashboardTree({ ...fixture.tree, tree: [...fixture.tree.tree, entry] }, fixture.manifest, fixture.fingerprint));
  }
  assert.throws(() => review.validateDashboardTree({ ...fixture.tree, tree: [...fixture.tree.tree, { ...fixture.tree.tree[2], path: "INDEX.HTML" }] }, fixture.manifest, fixture.fingerprint), /case/i);
  assert.throws(() => review.validateDashboardTree(fixture.tree, fixture.manifest.replace("index.html", "missing.html"), fixture.fingerprint), /manifest/i);
  assert.throws(() => review.validateDashboardTree(fixture.tree, fixture.manifest, `${"b".repeat(64)}\n`), /blob|fingerprint/i);
});

test("dashboard attestation is canonical and binds exact review and workflow identities", () => {
  const dashboard = review.validateDashboardTree(...Object.values(dashboardFixture()));
  const input = {
    repository: "Stevekaplanai/agenthost-internal",
    pullRequest: 406,
    baseSha: "7".repeat(40),
    headSha: "8".repeat(40),
    sourceDiffSha256: "9".repeat(64),
    baseDashboard: dashboard,
    headDashboard: dashboard,
    workflowRunId: "17345678901",
    workflowRunAttempt: 2,
  };
  const record = review.dashboardAttestationRecord(input);
  assert.equal(record.type, review.DASHBOARD_REVIEW_EVIDENCE_TYPE);
  assert.equal(record.context, review.DASHBOARD_REPRO_CONTEXT);
  assert.equal(record.workflow, review.DASHBOARD_REPRO_WORKFLOW);
  assert.equal(review.DASHBOARD_REPRO_DESCRIPTION_PREFIX, "dashboard-review-v1:");
  assert.equal(record.repository, "stevekaplanai/agenthost-internal");
  assert.equal(record.workflowRunId, "17345678901");
  assert.equal(review.dashboardAttestationSha256(input), crypto.createHash("sha256").update(`${JSON.stringify(record)}\n`).digest("hex"));
  assert.notEqual(review.dashboardAttestationSha256(input), review.dashboardAttestationSha256({ ...input, workflowRunAttempt: 3 }));
  assert.ok(review.DASHBOARD_TRUST_ANCHORS.includes("scripts/dashboard-source-fingerprint.mjs"));
});

test("compareDashboardDirectories compares path, mode, and bytes without returning content", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-dashboard-attestation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const committed = path.join(root, "committed");
  const rebuilt = path.join(root, "rebuilt");
  for (const dir of [committed, rebuilt]) {
    fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(dir, "index.html"), "private-content\n");
    fs.writeFileSync(path.join(dir, "assets", "app.js"), "console.log(1)\n");
  }
  const same = review.compareDashboardDirectories(committed, rebuilt);
  assert.equal(same.ok, true);
  assert.match(same.digest, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(same).includes("private-content"), false);
  fs.writeFileSync(path.join(rebuilt, "index.html"), "different\n");
  const changed = review.compareDashboardDirectories(committed, rebuilt);
  assert.equal(changed.ok, false);
  assert.match(changed.error, /index\.html/);
  assert.equal(JSON.stringify(changed).includes("different"), false);
});

test("the container image includes the attestation verifier used by gate.js", () => {
  const dockerfile = fs.readFileSync(new URL("../container/Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /COPY review-attestation\.js \/opt\/agenthost\/review-attestation\.js/);
});

test("source command requires explicit identity inputs and writes private bytes verbatim", (t) => {
  const args = parseArgs([
    "source",
    "--repository", "owner/repo",
    "--pull-request", "406",
    "--base-sha", "1".repeat(40),
    "--head-sha", "2".repeat(40),
    "--pr-files", "files.json",
    "--output", "source.txt",
  ]);
  assert.equal(args.command, "source");
  assert.throws(() => parseArgs(["source", "--repository", "owner/repo"]), /missing --pull-request/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-source-package-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, "source.txt");
  writePrivateFile(output, "agenthost-source-review-v1\n");
  assert.equal(fs.readFileSync(output, "utf8"), "agenthost-source-review-v1\n");
  assert.throws(() => writePrivateFile(output, "replacement"), /EEXIST/);
  if (process.platform !== "win32") assert.equal(fs.statSync(output).mode & 0o777, 0o600);
});

test("status publication is isolated from the read-only pull request workflow", () => {
  const producer = fs.readFileSync(new URL("../.github/workflows/dashboard-reproducibility.yml", import.meta.url), "utf8");
  const publisher = fs.readFileSync(new URL("../.github/workflows/dashboard-reproducibility-publish.yml", import.meta.url), "utf8");
  assert.match(producer, /pull_request:/);
  assert.match(producer, /permissions:\s*\n\s+contents: read/);
  assert.match(producer, /pull-requests: read/);
  assert.doesNotMatch(producer, /statuses:\s*write/);
  assert.doesNotMatch(producer, /\/statuses\//);
  assert.doesNotMatch(producer, /\bcp -a\b/);
  assert.match(producer, /cp -RP --no-preserve=mode,ownership,timestamps \/source\/dashboard \/work\/repo\/dashboard/);
  assert.match(producer, /cp -RP --no-preserve=mode,ownership,timestamps \/source\/container\/dashboard-ui \/work\/repo\/container\/dashboard-ui/);
  assert.match(producer, /cp -RP --no-preserve=mode,ownership,timestamps \/work\/repo\/container\/dashboard-ui\/\. \/output\//);
  assert.match(publisher, /workflow_run:/);
  assert.match(publisher, /statuses: write/);
  assert.match(publisher, /pull-requests: read/);
  assert.match(publisher, /pulls\/\$\{PR_NUMBER\}\/files\?per_page=100/);
  assert.match(publisher, /steps\.evidence\.outputs\.description/);
  assert.match(publisher, /reject unsafe review inputs before touching artifacts/);
  assert.match(publisher, /dashboard-review-attestation\.mjs" source/);
  assert.ok(publisher.indexOf("reject unsafe review inputs before touching artifacts") < publisher.indexOf("download evidence from the triggering read-only run"));
  assert.match(publisher, /enforce the expanded evidence bound/);
  assert.match(publisher, /test "\$\{size\}" -le 65536/);
  assert.match(publisher, /invalidate any older reproducibility success/);
  assert.match(publisher, /-f state=failure/);
  assert.match(publisher, /unverified-\$\{CONCLUSION\}-attempt-\$\{RUN_ATTEMPT\}/);
  assert.match(publisher, /if: steps\.identity\.outputs\.conclusion == 'success'/);
  assert.doesNotMatch(publisher, /check out the exact untrusted head/);
  assert.doesNotMatch(publisher, /git fetch --no-tags origin/,
    "the credential-free trusted checkout must not attempt a second private-repo fetch");
  assert.match(publisher, /git cat-file -e "\$\{\{ steps\.identity\.outputs\.head_sha \}\}\^\{commit\}"/);
  assert.match(producer, /actions\/checkout@11d5960a326750d5838078e36cf38b85af677262/);
  assert.match(publisher, /actions\/checkout@11d5960a326750d5838078e36cf38b85af677262/);
  assert.match(producer, /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/);
  assert.match(publisher, /actions\/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093/);
  assert.match(producer, /node:22-bookworm@sha256:0557ac14e0d45d02ed563067b82856ca5e7aa3437fa28d98d4350ea9c3d9494a/);
  assert.match(producer, /--user 1000:1000/);
  assert.match(producer, /--cap-drop ALL --security-opt no-new-privileges/);
  assert.match(producer, /--pids-limit 256 --memory 2g --cpus 2 --read-only/);
  assert.match(producer, /--network none/);
  assert.match(producer, /name: dashboard-review-evidence-\$\{\{ github\.run_attempt \}\}/);
  assert.match(publisher, /name: dashboard-review-evidence-\$\{\{ steps\.identity\.outputs\.run_attempt \}\}/);
  assert.match(publisher, /"dashboard-review-evidence-" \+ \$attempt/);
  const artifactStep = publisher.slice(publisher.indexOf("require one small unexpired evidence artifact"), publisher.indexOf("download evidence from the triggering read-only run"));
  assert.match(artifactStep, /RUN_ATTEMPT: \$\{\{ steps\.identity\.outputs\.run_attempt \}\}/);
  assert.match(publisher, /group: dashboard-reproducibility-publish-\$\{\{ github\.event\.workflow_run\.head_sha \}\}/);
  assert.match(publisher, /EVENT_RUN_ATTEMPT: \$\{\{ github\.event\.workflow_run\.run_attempt \}\}/);
  const successStep = publisher.slice(publisher.indexOf("publish the digest-bound status on the exact head"));
  assert.match(successStep, /fresh-workflow-run\.json/);
  assert.match(successStep, /fresh-workflow-history\.json/);
  assert.match(successStep, /max_by\(\.id\)/);
  assert.ok(successStep.indexOf("fresh-workflow-history.json") < successStep.indexOf("-f state=success"));
  const trustedBaseStep = publisher.slice(
    publisher.indexOf("prove the exact base belongs to the trusted default branch"),
    publisher.indexOf("reject unsafe review inputs before touching artifacts"),
  );
  assert.match(trustedBaseStep, /git cat-file -e "\$\{BASE_SHA\}\^\{commit\}"/);
  assert.match(trustedBaseStep, /git cat-file -e "origin\/\$\{DEFAULT_BRANCH\}\^\{commit\}"/);
  assert.match(trustedBaseStep, /git merge-base --is-ancestor "\$BASE_SHA" "origin\/\$DEFAULT_BRANCH"/);
  assert.match(trustedBaseStep, /::error::review base \$\{BASE_SHA\} is not an ancestor of origin\/\$\{DEFAULT_BRANCH\}/);
  assert.doesNotMatch(trustedBaseStep, /git rev-parse "origin\/\$\{DEFAULT_BRANCH\}"/,
    "a valid PR base may be behind the current default-branch tip");
  const ancestryCheck = trustedBaseStep.indexOf('git merge-base --is-ancestor "$BASE_SHA" "origin/$DEFAULT_BRANCH"');
  for (const objectCheck of [
    'git cat-file -e "${BASE_SHA}^{commit}"',
    'git cat-file -e "origin/${DEFAULT_BRANCH}^{commit}"',
    'git cat-file -e "${{ steps.identity.outputs.head_sha }}^{commit}"',
  ]) {
    assert.ok(trustedBaseStep.indexOf(objectCheck) < ancestryCheck,
      `the publisher must run ${objectCheck} before checking ancestry`);
  }
  assert.match(publisher, /HEAD_SHA: \$\{\{ steps\.identity\.outputs\.head_sha \}\}/);
  assert.match(publisher, /RUN_ID: \$\{\{ github\.event\.workflow_run\.id \}\}/);
  assert.match(publisher, /RUN_ATTEMPT: \$\{\{ steps\.identity\.outputs\.run_attempt \}\}/);
});
