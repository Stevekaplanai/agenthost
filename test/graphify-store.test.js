import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
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
} = require("../container/graphify-store.js");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-graphify-store-"));
  const stateRoot = path.join(root, "private");
  const artifactsRoot = path.join(root, "artifacts");
  fs.mkdirSync(stateRoot, { mode: 0o700 });
  fs.mkdirSync(artifactsRoot, { mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, stateRoot, artifactsRoot };
}

function publication(overrides = {}) {
  return {
    target: { id: "repo:Stevekaplanai/agenthost-internal", label: "AgentHost", kind: "repo" },
    folder: { id: "f_0123456789abcdef01234567", label: "All" },
    snapshot: {
      kind: "git",
      value: "174ef8c98003206ad937ae66eccfaf047eeb7dff",
      manifestSha256: "a".repeat(64),
      builtAt: "2026-08-14T12:00:00.000Z",
      derived: true,
    },
    report: "# Graphify snapshot\n\nDerived; source wins.\n",
    graphRaw: JSON.stringify({ directed: true, nodes: [{ id: "one" }], links: [] }),
    html: "<!doctype html><meta charset=utf-8><title>Graphify snapshot</title>",
    counts: { files: 3, inputBytes: 1234, nodes: 1, links: 0 },
    ...overrides,
  };
}

function brandProjection(overrides = {}) {
  return {
    accountId: "acme-1",
    operationId: "01".repeat(16),
    records: [{
      id: "dna-voice",
      account_id: "acme-1",
      asset: "voice",
      source: "client",
      content: "Plain-spoken, direct, and useful.",
      version: 4,
      updated_at: "2026-08-14T12:00:00.000Z",
      schemaVersion: 1,
    }],
    ...overrides,
  };
}

function instrumentDurabilityFs({ stateRoot, artifactsRoot, events = [], failSync = null }) {
  const fsImpl = Object.create(fs);
  const descriptorPaths = new Map();
  const syncCounts = new Map();
  const label = (file) => {
    const resolved = path.resolve(file);
    if (resolved === path.resolve(stateRoot)) return "private-root";
    if (resolved === path.resolve(artifactsRoot)) return "public-root";
    const name = path.basename(resolved);
    if (/^\.pending-[a-f0-9]{32}-[a-f0-9]{16}$/.test(name)) return "private-pending";
    if (/^[a-f0-9]{32}$/.test(name)) return "private-final";
    if (/^\.graphify-.*\.html\.[a-f0-9]{16}\.pending$/.test(name)) return "html-temp";
    if (/^\.graphify-.*\.md\.[a-f0-9]{16}\.pending$/.test(name)) return "markdown-temp";
    if (/^graphify-.*\.html$/.test(name)) return "html-final";
    if (/^graphify-.*\.md$/.test(name)) return "markdown-final";
    return name;
  };
  fsImpl.openSync = (file, flags, mode) => {
    const fd = fs.openSync(file, flags, mode);
    descriptorPaths.set(fd, path.resolve(file));
    events.push(`open:${label(file)}`);
    return fd;
  };
  fsImpl.writeSync = (fd, ...args) => {
    events.push(`write:${label(descriptorPaths.get(fd))}`);
    return fs.writeSync(fd, ...args);
  };
  fsImpl.fsyncSync = (fd) => {
    const entry = label(descriptorPaths.get(fd));
    const occurrence = (syncCounts.get(entry) || 0) + 1;
    syncCounts.set(entry, occurrence);
    events.push(`fsync:${entry}`);
    if (failSync && failSync(entry, occurrence)) {
      const error = new Error(`injected ${entry} durability barrier failure`);
      error.code = "EIO";
      throw error;
    }
    if (process.platform === "win32" && fs.fstatSync(fd).isDirectory()) return;
    return fs.fsyncSync(fd);
  };
  fsImpl.closeSync = (fd) => {
    events.push(`close:${label(descriptorPaths.get(fd))}`);
    descriptorPaths.delete(fd);
    return fs.closeSync(fd);
  };
  fsImpl.renameSync = (from, to) => {
    events.push(`rename:${label(from)}->${label(to)}`);
    return fs.renameSync(from, to);
  };
  return fsImpl;
}

function assertOrdered(events, expected) {
  let cursor = -1;
  for (const item of expected) {
    cursor = events.indexOf(item, cursor + 1);
    assert.notEqual(cursor, -1, `missing ordered durability event ${item}\n${events.join("\n")}`);
  }
}

test("publishes an HTML/Markdown pair while committing JSON only inside the private run", (t) => {
  const { stateRoot, artifactsRoot } = fixture(t);
  const runId = "1".repeat(32);
  const result = publishGraphifyRun({
    stateRoot,
    artifactsRoot,
    ...publication(),
    randomBytes: (length) => Buffer.from(runId, "hex").subarray(0, length),
  });

  assert.equal(result.runId, runId);
  assert.deepEqual(Object.keys(result).sort(), ["artifacts", "counts", "folder", "runId", "snapshot", "target"]);
  assert.deepEqual(Object.keys(result.artifacts).sort(), ["html", "markdown"]);
  for (const [kind, artifact] of Object.entries(result.artifacts)) {
    assert.deepEqual(Object.keys(artifact).sort(), ["downloadUrl", "name", "viewUrl"]);
    assert.match(artifact.name, new RegExp(`^graphify-agenthost-all-${runId}\\.${kind === "html" ? "html" : "md"}$`));
    assert.equal(artifact.viewUrl, `/artifacts/view?p=${encodeURIComponent(artifact.name)}`);
    assert.equal(artifact.downloadUrl, `/artifacts/dl?p=${encodeURIComponent(artifact.name)}`);
    assert.equal(fs.existsSync(path.join(artifactsRoot, artifact.name)), true);
  }
  assert.equal(fs.existsSync(path.join(artifactsRoot, "graph.json")), false);
  assert.equal(fs.readdirSync(artifactsRoot).some((name) => name.endsWith(".json")), false);

  const privateRun = path.join(stateRoot, runId);
  assert.deepEqual(fs.readdirSync(privateRun).sort(), ["graph.json", "manifest.json"]);
  const manifest = JSON.parse(fs.readFileSync(path.join(privateRun, "manifest.json"), "utf8"));
  assert.equal(manifest.runId, runId);
  assert.equal(manifest.derived, true);
  assert.equal(manifest.snapshot.manifestSha256, "a".repeat(64));
  assert.equal(manifest.graph.sha256, crypto.createHash("sha256").update(publication().graphRaw).digest("hex"));
  assert.deepEqual(new Set(committedGraphifyArtifactNames(stateRoot)), new Set([
    result.artifacts.html.name,
    result.artifacts.markdown.name,
  ]));
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(privateRun).mode & 0o077, 0);
    assert.equal(fs.statSync(path.join(privateRun, "graph.json")).mode & 0o177, 0);
  }
});

test("real Brand account labels publish through the shared artifact slugger", (t) => {
  const { stateRoot, artifactsRoot } = fixture(t);
  const runId = "b".repeat(32);
  const result = publishGraphifyRun({
    stateRoot,
    artifactsRoot,
    ...publication({
      target: { id: "brand:acme-1", label: "Acme & Co. (acme-1)", kind: "brand" },
      folder: { id: "brand_all", label: "Brand DNA" },
    }),
    randomBytes: (length) => Buffer.from(runId, "hex").subarray(0, length),
  });

  assert.equal(result.artifacts.html.name, `graphify-acme-co-acme-1-brand-dna-${runId}.html`);
  assert.equal(result.artifacts.markdown.name, `graphify-acme-co-acme-1-brand-dna-${runId}.md`);

  const longName = `${"N".repeat(151)} (acme-1)`;
  assert.equal(longName.length, 160);
  assert.doesNotThrow(() => publishGraphifyRun({
    stateRoot,
    artifactsRoot,
    ...publication({ target: { id: "brand:acme-1", label: longName, kind: "brand" } }),
  }));
});

test("commits a resumable Brand projection before publication and completes it atomically", (t) => {
  const { stateRoot, artifactsRoot } = fixture(t);
  const runId = "c".repeat(32);
  const target = { id: "brand:acme-1", label: "Acme & Co. (acme-1)", kind: "brand" };
  const folder = { id: "brand_all", label: "Brand DNA" };
  const projection = brandProjection();
  const receipt = publishGraphifyRun({
    stateRoot,
    artifactsRoot,
    ...publication({ target, folder }),
    brandProjection: projection,
    randomBytes: (length) => Buffer.from(runId, "hex").subarray(0, length),
  });

  assert.deepEqual(fs.readdirSync(path.join(stateRoot, runId)).sort(), [
    "brand-projection.pending.json",
    "graph.json",
    "manifest.json",
  ]);
  const markerText = fs.readFileSync(path.join(stateRoot, runId, "brand-projection.pending.json"), "utf8");
  assert.doesNotMatch(markerText, /Plain-spoken|direct|useful/, "canonical Brand content is fingerprinted, not copied into resume state");
  const pending = readPendingGraphifyBrandProjection(stateRoot, artifactsRoot, {
    targetId: target.id,
    folderId: folder.id,
    accountId: projection.accountId,
    operationId: projection.operationId,
    records: projection.records,
  });
  assert.equal(pending.state, "pending");
  assert.equal(pending.runId, runId);
  assert.deepEqual(pending.receipt, receipt);
  assert.equal(pending.snapshot.manifestSha256, publication().snapshot.manifestSha256);
  assert.deepEqual(pending.graph, JSON.parse(publication().graphRaw));
  assert.deepEqual(pending.records, [{ account_id: "acme-1", asset: "voice", source: "client" }]);

  assert.equal(completeGraphifyBrandProjection(stateRoot, artifactsRoot, {
    runId, accountId: projection.accountId, operationId: projection.operationId,
  }), true);
  assert.equal(fs.existsSync(path.join(stateRoot, runId, "brand-projection.pending.json")), false);
  assert.equal(fs.existsSync(path.join(stateRoot, runId, "brand-projection.complete.json")), true);
  assert.equal(completeGraphifyBrandProjection(stateRoot, artifactsRoot, {
    runId, accountId: projection.accountId, operationId: projection.operationId,
  }), false, "completion is idempotent after a crash/retry");
  const completed = readPendingGraphifyBrandProjection(stateRoot, artifactsRoot, {
    targetId: target.id,
    folderId: folder.id,
    accountId: projection.accountId,
    operationId: projection.operationId,
    records: projection.records,
  });
  assert.equal(completed.state, "complete");
  assert.equal(completed.runId, runId);
  assert.deepEqual(completed.receipt, receipt);
});

test("one Brand operation resumes its persisted snapshot after DNA changes while another operation stays blocked", (t) => {
  const { stateRoot, artifactsRoot } = fixture(t);
  const target = { id: "brand:acme-1", label: "Acme (acme-1)", kind: "brand" };
  const folder = { id: "brand_all", label: "Brand DNA" };
  const firstOperationId = "10".repeat(16);
  const secondOperationId = "20".repeat(16);
  const thirdOperationId = "30".repeat(16);
  const firstProjection = brandProjection({ operationId: firstOperationId });
  const changedRecords = [{
    ...firstProjection.records[0],
    content: "The canonical DNA changed after the original operation began.",
    version: firstProjection.records[0].version + 1,
    updated_at: "2026-08-14T12:05:00.000Z",
  }];
  const first = publishGraphifyRun({
    stateRoot,
    artifactsRoot,
    ...publication({ target, folder }),
    brandProjection: firstProjection,
    randomBytes: (length) => Buffer.from("da".repeat(16), "hex").subarray(0, length),
  });

  const firstPending = readPendingGraphifyBrandProjection(stateRoot, artifactsRoot, {
    targetId: target.id,
    folderId: folder.id,
    accountId: firstProjection.accountId,
    operationId: firstOperationId,
    records: changedRecords,
  });
  assert.equal(firstPending.state, "pending");
  assert.equal(firstPending.runId, first.runId);
  assert.deepEqual(firstPending.records, [{ account_id: "acme-1", asset: "voice", source: "client" }]);
  assert.throws(() => readPendingGraphifyBrandProjection(stateRoot, artifactsRoot, {
    targetId: target.id,
    folderId: folder.id,
    accountId: firstProjection.accountId,
    operationId: secondOperationId,
    records: changedRecords,
  }), { code: "GRAPHIFY_PENDING_MISMATCH" });

  assert.equal(completeGraphifyBrandProjection(stateRoot, artifactsRoot, {
    runId: first.runId,
    accountId: firstProjection.accountId,
    operationId: firstOperationId,
  }), true);
  assert.equal(readPendingGraphifyBrandProjection(stateRoot, artifactsRoot, {
    targetId: target.id,
    folderId: folder.id,
    accountId: firstProjection.accountId,
    operationId: firstOperationId,
    records: changedRecords,
  }).state, "complete");
  assert.equal(readPendingGraphifyBrandProjection(stateRoot, artifactsRoot, {
    targetId: target.id,
    folderId: folder.id,
    accountId: firstProjection.accountId,
    operationId: secondOperationId,
    records: changedRecords,
  }), null, "completed history from another operation cannot become a permanent cache hit");

  const secondProjection = brandProjection({ operationId: secondOperationId, records: changedRecords });
  const second = publishGraphifyRun({
    stateRoot,
    artifactsRoot,
    ...publication({ target, folder }),
    brandProjection: secondProjection,
    randomBytes: (length) => Buffer.from("db".repeat(16), "hex").subarray(0, length),
  });
  assert.notEqual(second.runId, first.runId);
  assert.equal(readPendingGraphifyBrandProjection(stateRoot, artifactsRoot, {
    targetId: target.id,
    folderId: folder.id,
    accountId: secondProjection.accountId,
    operationId: secondOperationId,
    records: secondProjection.records,
  }).runId, second.runId);
  assert.throws(() => readPendingGraphifyBrandProjection(stateRoot, artifactsRoot, {
    targetId: target.id,
    folderId: folder.id,
    accountId: secondProjection.accountId,
    operationId: thirdOperationId,
    records: secondProjection.records,
  }), { code: "GRAPHIFY_PENDING_MISMATCH" });

  const manifest = JSON.parse(fs.readFileSync(path.join(stateRoot, second.runId, "manifest.json"), "utf8"));
  const marker = JSON.parse(fs.readFileSync(path.join(stateRoot, second.runId, "brand-projection.pending.json"), "utf8"));
  assert.equal(manifest.brandProjection.operationId, secondOperationId);
  assert.equal(marker.operationId, secondOperationId);
  assert.throws(() => publishGraphifyRun({
    stateRoot,
    artifactsRoot,
    ...publication({ target, folder }),
    brandProjection: { accountId: secondProjection.accountId, records: secondProjection.records },
  }), /operation id/i);
});

test("a durable server-owned Brand operation lease survives restart and a commit-barrier retry", (t) => {
  const { stateRoot, artifactsRoot } = fixture(t);
  const selection = { targetId: "brand:acme-1", folderId: "brand_all", accountId: "acme-1" };
  const events = [];
  const fsImpl = instrumentDurabilityFs({ stateRoot, artifactsRoot, events });
  const operationId = reserveGraphifyOperation(stateRoot, {
    ...selection,
    fsImpl,
    randomBytes: (length) => Buffer.alloc(length, 0x41),
  });
  assert.equal(operationId, "41".repeat(16));
  assertOrdered(events, [
    "open:lease.json", "write:lease.json", "fsync:lease.json", "close:lease.json",
  ]);
  const renameIndex = events.findIndex((event) => event.startsWith("rename:.pending-brand-operation-")
    && event.includes("->.brand-operation-"));
  const pendingSyncIndex = events.findIndex((event) => event.startsWith("fsync:.pending-brand-operation-"));
  const rootSyncs = events.reduce((indices, event, index) => {
    if (event === "fsync:private-root") indices.push(index);
    return indices;
  }, []);
  assert.ok(pendingSyncIndex > events.indexOf("close:lease.json"), `lease file must close before its temporary directory is synced\n${events.join("\n")}`);
  assert.ok(rootSyncs[0] > pendingSyncIndex, `temporary directory must sync before its root entry\n${events.join("\n")}`);
  assert.ok(renameIndex > rootSyncs[0], `temporary lease must be root-synced before publication\n${events.join("\n")}`);
  assert.ok(rootSyncs.some((index) => index > renameIndex), `published lease must be root-synced\n${events.join("\n")}`);
  assert.equal(reserveGraphifyOperation(stateRoot, {
    ...selection,
    randomBytes: (length) => Buffer.alloc(length, 0x42),
  }), operationId, "a restarted gate recovers the durable lease instead of minting another operation");

  const second = fixture(t);
  const crashFs = instrumentDurabilityFs({
    stateRoot: second.stateRoot,
    artifactsRoot: second.artifactsRoot,
    failSync: (entry, occurrence) => entry === "private-root" && occurrence === 2,
  });
  assert.throws(() => reserveGraphifyOperation(second.stateRoot, {
    ...selection,
    fsImpl: crashFs,
    randomBytes: (length) => Buffer.alloc(length, 0x43),
  }), { code: "GRAPHIFY_OPERATION_LEASE_UNCERTAIN" });
  assert.equal(reserveGraphifyOperation(second.stateRoot, {
    ...selection,
    randomBytes: (length) => Buffer.alloc(length, 0x44),
  }), "43".repeat(16), "retry repairs the uncertain root barrier and keeps the published id");
});

test("concurrent Brand operation reservations converge on the one atomically published lease", (t) => {
  const { stateRoot } = fixture(t);
  const selection = { targetId: "brand:acme-1", folderId: "brand_all", accountId: "acme-1" };
  const fsImpl = Object.create(fs);
  let innerOperationId = null;
  let race = true;
  fsImpl.renameSync = (from, to) => {
    if (race && path.basename(from).startsWith(".pending-brand-operation-")
        && path.basename(to).startsWith(".brand-operation-")) {
      race = false;
      innerOperationId = reserveGraphifyOperation(stateRoot, {
        ...selection,
        fsImpl,
        randomBytes: (length) => Buffer.alloc(length, 0x52),
      });
    }
    return fs.renameSync(from, to);
  };

  const outerOperationId = reserveGraphifyOperation(stateRoot, {
    ...selection,
    fsImpl,
    randomBytes: (length) => Buffer.alloc(length, 0x51),
  });
  assert.equal(innerOperationId, "52".repeat(16));
  assert.equal(outerOperationId, innerOperationId);
  assert.equal(fs.readdirSync(stateRoot).filter((name) => name.startsWith(".brand-operation-")).length, 1);
  assert.equal(fs.readdirSync(stateRoot).some((name) => name.startsWith(".pending-brand-operation-")), false);
});

test("Brand operation acknowledgement is compare-and-clear, completion-gated, and idempotent", (t) => {
  const { stateRoot, artifactsRoot } = fixture(t);
  const selection = { targetId: "brand:acme-1", folderId: "brand_all", accountId: "acme-1" };
  const target = { id: selection.targetId, label: "Acme (acme-1)", kind: "brand" };
  const folder = { id: selection.folderId, label: "Brand DNA" };
  const operationId = reserveGraphifyOperation(stateRoot, {
    ...selection,
    randomBytes: (length) => Buffer.alloc(length, 0x61),
  });
  const wrongOperationId = "62".repeat(16);
  assert.equal(acknowledgeGraphifyOperation(stateRoot, artifactsRoot, {
    ...selection, operationId,
  }), false, "a lease without a committed run cannot be acknowledged");
  assert.equal(acknowledgeGraphifyOperation(stateRoot, artifactsRoot, {
    ...selection, operationId: wrongOperationId,
  }), false, "a wrong id cannot clear the lease");

  const firstProjection = brandProjection({ operationId });
  const first = publishGraphifyRun({
    stateRoot,
    artifactsRoot,
    ...publication({ target, folder }),
    brandProjection: firstProjection,
    randomBytes: (length) => Buffer.from("63".repeat(16), "hex").subarray(0, length),
  });
  assert.equal(acknowledgeGraphifyOperation(stateRoot, artifactsRoot, {
    ...selection, operationId,
  }), false, "an unfinished committed run cannot clear the lease");
  assert.equal(completeGraphifyBrandProjection(stateRoot, artifactsRoot, {
    runId: first.runId,
    accountId: selection.accountId,
    operationId,
  }), true);
  assert.equal(acknowledgeGraphifyOperation(stateRoot, artifactsRoot, {
    ...selection, operationId: wrongOperationId,
  }), false, "a completed run still cannot authorize the wrong compare-and-clear id");
  assert.equal(acknowledgeGraphifyOperation(stateRoot, artifactsRoot, {
    ...selection, operationId,
  }), true);
  publishGraphifyRun({
    stateRoot,
    artifactsRoot,
    ...publication({ snapshot: { ...publication().snapshot, builtAt: "2026-08-14T13:00:00.000Z" } }),
    randomBytes: (length) => Buffer.from("66".repeat(16), "hex").subarray(0, length),
    retain: 1,
  });
  assert.equal(fs.existsSync(path.join(stateRoot, first.runId)), false, "acknowledgement releases the retention pin");
  assert.equal(acknowledgeGraphifyOperation(stateRoot, artifactsRoot, {
    ...selection, operationId: wrongOperationId,
  }), false, "an acknowledged tombstone cannot satisfy another operation id");
  assert.equal(acknowledgeGraphifyOperation(stateRoot, artifactsRoot, {
    ...selection, operationId,
  }), true, "a restarted gate recovers a lost acknowledgement even after normal retention");

  const nextOperationId = reserveGraphifyOperation(stateRoot, {
    ...selection,
    randomBytes: (length) => Buffer.alloc(length, 0x64),
  });
  assert.equal(nextOperationId, "64".repeat(16));
  assert.notEqual(nextOperationId, operationId);
  const changedProjection = brandProjection({
    operationId: nextOperationId,
    records: [{ ...firstProjection.records[0], content: "Fresh DNA after acknowledgement.", version: 5 }],
  });
  const next = publishGraphifyRun({
    stateRoot,
    artifactsRoot,
    ...publication({ target, folder }),
    brandProjection: changedProjection,
    randomBytes: (length) => Buffer.from("65".repeat(16), "hex").subarray(0, length),
  });
  assert.notEqual(next.runId, first.runId);
});

test("a stale Brand acknowledgement cannot consume the next operation lease", (t) => {
  const { stateRoot, artifactsRoot } = fixture(t);
  const selection = { targetId: "brand:acme-1", folderId: "brand_all", accountId: "acme-1" };
  const operationId = reserveGraphifyOperation(stateRoot, {
    ...selection,
    randomBytes: (length) => Buffer.alloc(length, 0x91),
  });
  const run = publishGraphifyRun({
    stateRoot,
    artifactsRoot,
    ...publication({
      target: { id: selection.targetId, label: "Acme (acme-1)", kind: "brand" },
      folder: { id: selection.folderId, label: "Brand DNA" },
    }),
    brandProjection: brandProjection({ operationId }),
    randomBytes: (length) => Buffer.from("92".repeat(16), "hex").subarray(0, length),
  });
  completeGraphifyBrandProjection(stateRoot, artifactsRoot, {
    runId: run.runId,
    accountId: selection.accountId,
    operationId,
  });

  const fsImpl = Object.create(fs);
  let raced = false;
  let innerAcknowledged = null;
  let nextOperationId = null;
  fsImpl.renameSync = (from, to) => {
    if (!raced && path.basename(from).startsWith(".brand-operation-")
        && (path.basename(to).startsWith(".acked-brand-operation-")
          || path.basename(to).startsWith(".claim-brand-operation-"))
        && path.basename(to).endsWith(`-${operationId}`)) {
      raced = true;
      innerAcknowledged = acknowledgeGraphifyOperation(stateRoot, artifactsRoot, {
        ...selection, operationId,
      });
      nextOperationId = reserveGraphifyOperation(stateRoot, {
        ...selection,
        randomBytes: (length) => Buffer.alloc(length, 0x93),
      });
    }
    return fs.renameSync(from, to);
  };

  assert.equal(acknowledgeGraphifyOperation(stateRoot, artifactsRoot, {
    ...selection, operationId, fsImpl,
  }), true);
  assert.equal(innerAcknowledged, true);
  assert.equal(nextOperationId, "93".repeat(16));
  assert.equal(reserveGraphifyOperation(stateRoot, {
    ...selection,
    randomBytes: (length) => Buffer.alloc(length, 0x94),
  }), nextOperationId, "the stale acknowledgement must leave the replacement lease active");
  assert.equal(acknowledgeGraphifyOperation(stateRoot, artifactsRoot, {
    ...selection, operationId,
  }), true, "the old acknowledgement remains idempotent without clearing the replacement lease");
});

test("Brand acknowledgement history stays bounded to one durable tombstone per selection", (t) => {
  const { stateRoot, artifactsRoot } = fixture(t);
  const selection = { targetId: "brand:acme-1", folderId: "brand_all", accountId: "acme-1" };
  const target = { id: selection.targetId, label: "Acme (acme-1)", kind: "brand" };
  const folder = { id: selection.folderId, label: "Brand DNA" };
  const operationIds = [];

  for (let index = 0; index < 5; index += 1) {
    const operationId = reserveGraphifyOperation(stateRoot, {
      ...selection,
      randomBytes: (length) => Buffer.alloc(length, 0xa1 + index),
    });
    operationIds.push(operationId);
    const run = publishGraphifyRun({
      stateRoot,
      artifactsRoot,
      ...publication({ target, folder }),
      brandProjection: brandProjection({ operationId }),
      randomBytes: (length) => Buffer.alloc(length, 0xb1 + index),
    });
    completeGraphifyBrandProjection(stateRoot, artifactsRoot, {
      runId: run.runId,
      accountId: selection.accountId,
      operationId,
    });
    assert.equal(acknowledgeGraphifyOperation(stateRoot, artifactsRoot, {
      ...selection, operationId,
    }), true);
    assert.equal(fs.readdirSync(stateRoot).filter((name) => name.startsWith(".acked-brand-operation-")).length, 1);
  }

  assert.equal(acknowledgeGraphifyOperation(stateRoot, artifactsRoot, {
    ...selection, operationId: operationIds[0],
  }), false, "a rotated ancient acknowledgement is no longer presented as current");
  assert.equal(acknowledgeGraphifyOperation(stateRoot, artifactsRoot, {
    ...selection, operationId: operationIds.at(-1),
  }), true, "the latest acknowledgement remains restart-idempotent");
});

test("an ancient acknowledgement cannot consume a lease after a newer acknowledgement rotates its tombstone", (t) => {
  const { stateRoot, artifactsRoot } = fixture(t);
  const selection = { targetId: "brand:acme-1", folderId: "brand_all", accountId: "acme-1" };
  const target = { id: selection.targetId, label: "Acme (acme-1)", kind: "brand" };
  const folder = { id: selection.folderId, label: "Brand DNA" };
  const firstOperationId = reserveGraphifyOperation(stateRoot, {
    ...selection,
    randomBytes: (length) => Buffer.alloc(length, 0xc1),
  });
  const firstRun = publishGraphifyRun({
    stateRoot,
    artifactsRoot,
    ...publication({ target, folder }),
    brandProjection: brandProjection({ operationId: firstOperationId }),
    randomBytes: (length) => Buffer.alloc(length, 0xc2),
  });
  completeGraphifyBrandProjection(stateRoot, artifactsRoot, {
    runId: firstRun.runId,
    accountId: selection.accountId,
    operationId: firstOperationId,
  });

  const fsImpl = Object.create(fs);
  let raced = false;
  let currentOperationId = null;
  fsImpl.renameSync = (from, to) => {
    if (!raced && path.basename(from).startsWith(".brand-operation-")
        && (path.basename(to).startsWith(".acked-brand-operation-")
          || path.basename(to).startsWith(".claim-brand-operation-"))
        && path.basename(to).endsWith(`-${firstOperationId}`)) {
      raced = true;
      assert.equal(acknowledgeGraphifyOperation(stateRoot, artifactsRoot, {
        ...selection, operationId: firstOperationId,
      }), true);
      const secondOperationId = reserveGraphifyOperation(stateRoot, {
        ...selection,
        randomBytes: (length) => Buffer.alloc(length, 0xc3),
      });
      const secondRun = publishGraphifyRun({
        stateRoot,
        artifactsRoot,
        ...publication({ target, folder }),
        brandProjection: brandProjection({ operationId: secondOperationId }),
        randomBytes: (length) => Buffer.alloc(length, 0xc4),
      });
      completeGraphifyBrandProjection(stateRoot, artifactsRoot, {
        runId: secondRun.runId,
        accountId: selection.accountId,
        operationId: secondOperationId,
      });
      assert.equal(acknowledgeGraphifyOperation(stateRoot, artifactsRoot, {
        ...selection, operationId: secondOperationId,
      }), true);
      currentOperationId = reserveGraphifyOperation(stateRoot, {
        ...selection,
        randomBytes: (length) => Buffer.alloc(length, 0xc5),
      });
    }
    return fs.renameSync(from, to);
  };

  assert.equal(acknowledgeGraphifyOperation(stateRoot, artifactsRoot, {
    ...selection, operationId: firstOperationId, fsImpl,
  }), false);
  assert.equal(currentOperationId, "c5".repeat(16));
  assert.equal(reserveGraphifyOperation(stateRoot, {
    ...selection,
    randomBytes: (length) => Buffer.alloc(length, 0xc6),
  }), currentOperationId, "the ancient acknowledgement must restore the current lease before returning");
  assert.equal(fs.readdirSync(stateRoot).filter((name) => name.startsWith(".acked-brand-operation-")).length, 1);
});

test("an unacknowledged completed Brand operation stays pinned until its lease is cleared", (t) => {
  const { stateRoot, artifactsRoot } = fixture(t);
  const selection = { targetId: "brand:acme-1", folderId: "brand_all", accountId: "acme-1" };
  const operationId = reserveGraphifyOperation(stateRoot, {
    ...selection,
    randomBytes: (length) => Buffer.alloc(length, 0x71),
  });
  const brandRun = publishGraphifyRun({
    stateRoot,
    artifactsRoot,
    ...publication({
      target: { id: selection.targetId, label: "Acme (acme-1)", kind: "brand" },
      folder: { id: selection.folderId, label: "Brand DNA" },
      snapshot: { ...publication().snapshot, builtAt: "2026-08-14T08:00:00.000Z" },
    }),
    brandProjection: brandProjection({ operationId }),
    randomBytes: (length) => Buffer.from("72".repeat(16), "hex").subarray(0, length),
    retain: 2,
  });
  completeGraphifyBrandProjection(stateRoot, artifactsRoot, {
    runId: brandRun.runId,
    accountId: selection.accountId,
    operationId,
  });
  for (let index = 0; index < 3; index += 1) {
    publishGraphifyRun({
      stateRoot,
      artifactsRoot,
      ...publication({ snapshot: { ...publication().snapshot, builtAt: `2026-08-14T1${index}:00:00.000Z` } }),
      randomBytes: (length) => Buffer.from(`8${index}`.repeat(16), "hex").subarray(0, length),
      retain: 2,
    });
  }
  prepareGraphifyStore({ stateRoot, artifactsRoot, retain: 1 });
  assert.equal(fs.existsSync(path.join(stateRoot, brandRun.runId)), true, "the completed but unacknowledged run is pinned");
  assert.equal(acknowledgeGraphifyOperation(stateRoot, artifactsRoot, {
    ...selection, operationId,
  }), true);
  publishGraphifyRun({
    stateRoot,
    artifactsRoot,
    ...publication({ snapshot: { ...publication().snapshot, builtAt: "2026-08-14T14:00:00.000Z" } }),
    randomBytes: (length) => Buffer.from("84".repeat(16), "hex").subarray(0, length),
    retain: 1,
  });
  assert.equal(fs.existsSync(path.join(stateRoot, brandRun.runId)), false, "normal retention resumes after acknowledgement");
});

test("Brand operation leases fail closed on corruption, links, and incomplete public commits", async (t) => {
  for (const mutation of ["corrupt", "hardlink", "symlink", "public pair"]) {
    await t.test(mutation, (subtest) => {
      const { stateRoot, artifactsRoot } = fixture(t);
      const selection = { targetId: "brand:acme-1", folderId: "brand_all", accountId: "acme-1" };
      const operationId = reserveGraphifyOperation(stateRoot, {
        ...selection,
        randomBytes: (length) => Buffer.alloc(length, 0x91),
      });
      const leaseDir = fs.readdirSync(stateRoot).find((name) => name.startsWith(".brand-operation-"));
      const leaseFile = path.join(stateRoot, leaseDir, "lease.json");
      if (mutation === "corrupt") {
        const lease = JSON.parse(fs.readFileSync(leaseFile, "utf8"));
        lease.operationId = "99".repeat(16);
        fs.writeFileSync(leaseFile, `${JSON.stringify(lease)}\n`);
        assert.throws(() => reserveGraphifyOperation(stateRoot, selection), /lease.*invalid/i);
        return;
      }
      if (mutation === "hardlink") {
        fs.linkSync(leaseFile, path.join(stateRoot, "lease-alias.json"));
        assert.throws(() => reserveGraphifyOperation(stateRoot, selection), /lease.*invalid/i);
        return;
      }
      if (mutation === "symlink") {
        const foreign = path.join(stateRoot, "foreign-lease.json");
        fs.writeFileSync(foreign, fs.readFileSync(leaseFile));
        fs.rmSync(leaseFile);
        try { fs.symlinkSync(foreign, leaseFile, "file"); }
        catch (error) {
          if (process.platform === "win32" && (error.code === "EPERM" || error.code === "EACCES")) {
            subtest.skip("Windows account cannot create a file symlink");
            return;
          }
          throw error;
        }
        assert.throws(() => reserveGraphifyOperation(stateRoot, selection), /lease.*invalid/i);
        return;
      }
      const projection = brandProjection({ operationId });
      const receipt = publishGraphifyRun({
        stateRoot,
        artifactsRoot,
        ...publication({
          target: { id: selection.targetId, label: "Acme (acme-1)", kind: "brand" },
          folder: { id: selection.folderId, label: "Brand DNA" },
        }),
        brandProjection: projection,
        randomBytes: (length) => Buffer.from("92".repeat(16), "hex").subarray(0, length),
      });
      completeGraphifyBrandProjection(stateRoot, artifactsRoot, {
        runId: receipt.runId,
        accountId: selection.accountId,
        operationId,
      });
      fs.writeFileSync(path.join(artifactsRoot, receipt.artifacts.html.name), "tampered");
      assert.throws(() => acknowledgeGraphifyOperation(stateRoot, artifactsRoot, {
        ...selection, operationId,
      }), /artifact does not match/i);
      assert.equal(fs.existsSync(path.join(stateRoot, leaseDir)), true, "failed verification cannot clear the lease");
    });
  }
});

test("publication orders durable file and directory barriers before returning its receipt", (t) => {
  const { stateRoot, artifactsRoot } = fixture(t);
  const events = [];
  const fsImpl = instrumentDurabilityFs({ stateRoot, artifactsRoot, events });
  const runId = "ca".repeat(16);
  const target = { id: "brand:acme-1", label: "Acme (acme-1)", kind: "brand" };
  const folder = { id: "brand_all", label: "Brand DNA" };

  const receipt = publishGraphifyRun({
    stateRoot,
    artifactsRoot,
    ...publication({ target, folder }),
    brandProjection: brandProjection(),
    randomBytes: (length) => Buffer.from(runId, "hex").subarray(0, length),
    fsImpl,
  });
  assert.equal(receipt.runId, runId);
  assertOrdered(events, [
    "open:graph.json", "write:graph.json", "fsync:graph.json", "close:graph.json",
    "open:brand-projection.pending.json", "write:brand-projection.pending.json",
    "fsync:brand-projection.pending.json", "close:brand-projection.pending.json",
    "open:manifest.json", "write:manifest.json", "fsync:manifest.json", "close:manifest.json",
    "open:html-temp", "write:html-temp", "fsync:html-temp", "close:html-temp",
    "open:markdown-temp", "write:markdown-temp", "fsync:markdown-temp", "close:markdown-temp",
    "open:private-pending", "fsync:private-pending", "close:private-pending",
    "open:public-root", "fsync:public-root", "close:public-root",
    "rename:html-temp->html-final", "rename:markdown-temp->markdown-final",
    "open:public-root", "fsync:public-root", "close:public-root",
    "rename:private-pending->private-final",
    "open:private-root", "fsync:private-root", "close:private-root",
  ]);
});

test("a failed publication durability barrier returns no receipt or visible half-commit", async (t) => {
  const cases = [
    { name: "file", fail: (entry) => entry === "graph.json" },
    { name: "private pending directory", fail: (entry) => entry === "private-pending" },
    { name: "public temp directory entry", fail: (entry, occurrence) => entry === "public-root" && occurrence === 1 },
    { name: "public final rename", fail: (entry, occurrence) => entry === "public-root" && occurrence === 2 },
    { name: "private commit rename", fail: (entry) => entry === "private-root", commitUncertain: true },
  ];
  for (const entry of cases) {
    await t.test(entry.name, () => {
      const { stateRoot, artifactsRoot } = fixture(t);
      const fsImpl = instrumentDurabilityFs({ stateRoot, artifactsRoot, failSync: entry.fail });
      const publish = () => publishGraphifyRun({
        stateRoot,
        artifactsRoot,
        ...publication(),
        randomBytes: (length) => Buffer.from("cb".repeat(16), "hex").subarray(0, length),
        fsImpl,
      });
      if (entry.commitUncertain) {
        assert.throws(publish, (error) => {
          assert.equal(error.code, "GRAPHIFY_COMMIT_UNCERTAIN");
          assert.equal(error.committed, true);
          assert.equal(error.retrySafe, false);
          return true;
        });
        assert.deepEqual(fs.readdirSync(stateRoot), ["cb".repeat(16)]);
        assert.equal(fs.readdirSync(artifactsRoot).filter((name) => !name.startsWith(".")).length, 2);
      } else {
        assert.throws(publish, /durability barrier failure/i);
        assert.deepEqual(fs.readdirSync(stateRoot), []);
        assert.deepEqual(fs.readdirSync(artifactsRoot), []);
      }
    });
  }
});

test("Brand completion fsyncs the run directory and retries a failed barrier without rewriting", (t) => {
  const { stateRoot, artifactsRoot } = fixture(t);
  const runId = "cc".repeat(16);
  const target = { id: "brand:acme-1", label: "Acme (acme-1)", kind: "brand" };
  const folder = { id: "brand_all", label: "Brand DNA" };
  const projection = brandProjection();
  publishGraphifyRun({
    stateRoot,
    artifactsRoot,
    ...publication({ target, folder }),
    brandProjection: projection,
    randomBytes: (length) => Buffer.from(runId, "hex").subarray(0, length),
  });

  const failedEvents = [];
  const failedFs = instrumentDurabilityFs({
    stateRoot,
    artifactsRoot,
    events: failedEvents,
    failSync: (entry) => entry === "private-final",
  });
  assert.throws(() => completeGraphifyBrandProjection(stateRoot, artifactsRoot, {
    runId,
    accountId: projection.accountId,
    operationId: projection.operationId,
    fsImpl: failedFs,
  }), /durability barrier failure/i);
  assertOrdered(failedEvents, [
    "rename:brand-projection.pending.json->brand-projection.complete.json",
    "open:private-final", "fsync:private-final", "close:private-final",
  ]);
  assert.equal(fs.existsSync(path.join(stateRoot, runId, "brand-projection.complete.json")), true);

  const retryEvents = [];
  const retryFs = instrumentDurabilityFs({ stateRoot, artifactsRoot, events: retryEvents });
  const recovered = readPendingGraphifyBrandProjection(stateRoot, artifactsRoot, {
    targetId: target.id,
    folderId: folder.id,
    accountId: projection.accountId,
    operationId: projection.operationId,
    records: projection.records,
    fsImpl: retryFs,
  });
  assert.equal(recovered.state, "complete");
  assert.equal(recovered.runId, runId);
  assertOrdered(retryEvents, ["open:private-final", "fsync:private-final", "close:private-final"]);
  assert.equal(retryEvents.some((event) => event.startsWith("rename:")), false);
});

test("retains unfinished runs and resumes their exact Brand operation after records change", (t) => {
  const { stateRoot, artifactsRoot } = fixture(t);
  const target = { id: "brand:acme-1", label: "Acme (acme-1)", kind: "brand" };
  const folder = { id: "brand_all", label: "Brand DNA" };
  const projection = brandProjection();
  const pending = publishGraphifyRun({
    stateRoot,
    artifactsRoot,
    ...publication({
      target,
      folder,
      snapshot: { ...publication().snapshot, builtAt: "2026-08-14T11:00:00.000Z" },
    }),
    brandProjection: projection,
    randomBytes: (length) => Buffer.from("d".repeat(32), "hex").subarray(0, length),
  });
  for (let index = 0; index < 4; index += 1) {
    publishGraphifyRun({
      stateRoot,
      artifactsRoot,
      ...publication({ snapshot: { ...publication().snapshot, builtAt: new Date(Date.UTC(2026, 7, 14, 12, 0, index)).toISOString() } }),
      randomBytes: (length) => Buffer.from(index.toString(16).padStart(32, "0"), "hex").subarray(0, length),
      retain: 2,
    });
  }
  prepareGraphifyStore({ stateRoot, artifactsRoot, retain: 2 });
  assert.equal(fs.existsSync(path.join(stateRoot, pending.runId)), true, "an unfinished Brand run is never evicted by ordinary retention");
  const resumed = readPendingGraphifyBrandProjection(stateRoot, artifactsRoot, {
    targetId: target.id,
    folderId: folder.id,
    accountId: projection.accountId,
    operationId: projection.operationId,
    records: [{ ...projection.records[0], content: "Changed after the partial save." }],
  });
  assert.equal(resumed.state, "pending");
  assert.equal(resumed.runId, pending.runId, "changed canonical Brand data resumes the persisted operation");
  assert.throws(() => readPendingGraphifyBrandProjection(stateRoot, artifactsRoot, {
    targetId: target.id,
    folderId: folder.id,
    accountId: "other-account",
    operationId: projection.operationId,
    records: [{ ...projection.records[0], account_id: "other-account" }],
  }), /selection is invalid/i, "another account cannot attach to the pending run");
});

test("a corrupt pending Brand marker fails closed instead of publishing a fresh duplicate run", (t) => {
  const { stateRoot, artifactsRoot } = fixture(t);
  const runId = "e".repeat(32);
  const target = { id: "brand:acme-1", label: "Acme (acme-1)", kind: "brand" };
  const folder = { id: "brand_all", label: "Brand DNA" };
  const projection = brandProjection();
  publishGraphifyRun({
    stateRoot,
    artifactsRoot,
    ...publication({ target, folder }),
    brandProjection: projection,
    randomBytes: (length) => Buffer.from(runId, "hex").subarray(0, length),
  });
  fs.appendFileSync(path.join(stateRoot, runId, "brand-projection.pending.json"), "tampered");
  assert.throws(() => readPendingGraphifyBrandProjection(stateRoot, artifactsRoot, {
    targetId: target.id,
    folderId: folder.id,
    accountId: projection.accountId,
    operationId: projection.operationId,
    records: projection.records,
  }), /pending Brand projection .* does not match its manifest/i);
  assert.throws(() => prepareGraphifyStore({ stateRoot, artifactsRoot }), /pending Brand projection/i);
});

test("Brand resume re-verifies the exact snapshot, private graph, and public pair", async (t) => {
  for (const mutation of ["snapshot", "graph", "public"]) {
    await t.test(mutation, () => {
      const { stateRoot, artifactsRoot } = fixture(t);
      const runId = ({ snapshot: "1", graph: "2", public: "3" })[mutation].repeat(32);
      const target = { id: "brand:acme-1", label: "Acme (acme-1)", kind: "brand" };
      const folder = { id: "brand_all", label: "Brand DNA" };
      const projection = brandProjection();
      const receipt = publishGraphifyRun({
        stateRoot,
        artifactsRoot,
        ...publication({ target, folder }),
        brandProjection: projection,
        randomBytes: (length) => Buffer.from(runId, "hex").subarray(0, length),
      });
      if (mutation === "snapshot") {
        const manifestPath = path.join(stateRoot, runId, "manifest.json");
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        manifest.snapshot.builtAt = "2026-08-14T12:02:00.000Z";
        fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
      } else if (mutation === "graph") {
        fs.writeFileSync(path.join(stateRoot, runId, "graph.json"), JSON.stringify({ nodes: [{ id: "changed" }], links: [] }));
      } else {
        fs.writeFileSync(path.join(artifactsRoot, receipt.artifacts.html.name), "changed public graph");
      }
      assert.throws(() => readPendingGraphifyBrandProjection(stateRoot, artifactsRoot, {
        targetId: target.id,
        folderId: folder.id,
        accountId: projection.accountId,
        operationId: projection.operationId,
        records: projection.records,
      }), mutation === "snapshot" ? /pending Brand projection .* invalid/i
        : mutation === "graph" ? /committed graph .* does not match/i
          : /committed html artifact does not match/i);
    });
  }
});

test("failed completion remains resumable and unfinished capacity fails closed", (t) => {
  const { stateRoot, artifactsRoot } = fixture(t);
  const target = { id: "brand:acme-1", label: "Acme (acme-1)", kind: "brand" };
  const folder = { id: "brand_all", label: "Brand DNA" };
  const projection = brandProjection();
  const first = publishGraphifyRun({
    stateRoot,
    artifactsRoot,
    ...publication({ target, folder }),
    brandProjection: projection,
    retain: 2,
    randomBytes: (length) => Buffer.from("4".repeat(32), "hex").subarray(0, length),
  });
  const fsImpl = Object.create(fs);
  fsImpl.renameSync = (from, to) => {
    if (path.basename(from) === "brand-projection.pending.json") throw new Error("completion rename refused");
    return fs.renameSync(from, to);
  };
  assert.throws(() => completeGraphifyBrandProjection(stateRoot, artifactsRoot, {
    runId: first.runId,
    accountId: projection.accountId,
    operationId: projection.operationId,
    fsImpl,
  }), /completion rename refused/);
  assert.ok(readPendingGraphifyBrandProjection(stateRoot, artifactsRoot, {
    targetId: target.id, folderId: folder.id, accountId: projection.accountId,
    operationId: projection.operationId, records: projection.records,
  }));
  assert.equal(completeGraphifyBrandProjection(stateRoot, artifactsRoot, {
    runId: first.runId, accountId: projection.accountId,
    operationId: projection.operationId,
  }), true);

  const changed = brandProjection({ records: [{ ...projection.records[0], content: "A second unfinished snapshot." }] });
  publishGraphifyRun({
    stateRoot,
    artifactsRoot,
    ...publication({ target, folder }),
    brandProjection: changed,
    retain: 2,
    randomBytes: (length) => Buffer.from("5".repeat(32), "hex").subarray(0, length),
  });
  const third = brandProjection({ records: [{ ...projection.records[0], content: "A third unfinished snapshot." }] });
  publishGraphifyRun({
    stateRoot,
    artifactsRoot,
    ...publication({ target, folder }),
    brandProjection: third,
    retain: 2,
    randomBytes: (length) => Buffer.from("6".repeat(32), "hex").subarray(0, length),
  });
  const fourth = brandProjection({ records: [{ ...projection.records[0], content: "No capacity remains." }] });
  assert.throws(() => publishGraphifyRun({
    stateRoot,
    artifactsRoot,
    ...publication({ target, folder }),
    brandProjection: fourth,
    retain: 2,
  }), /unfinished Brand projections/i);
});

test("the private manifest is the commit marker and failed publication leaves no visible half-pair", (t) => {
  const { stateRoot, artifactsRoot } = fixture(t);
  let renameCount = 0;
  const fsImpl = Object.create(fs);
  fsImpl.renameSync = (from, to) => {
    renameCount += 1;
    if (renameCount === 3) throw new Error("private commit rename failed");
    return fs.renameSync(from, to);
  };

  assert.throws(() => publishGraphifyRun({
    stateRoot,
    artifactsRoot,
    ...publication({
      target: { id: "brand:acme-1", label: "Acme (acme-1)", kind: "brand" },
      folder: { id: "brand_all", label: "Brand DNA" },
    }),
    brandProjection: brandProjection(),
    fsImpl,
  }), /private commit rename failed/);
  assert.deepEqual(fs.readdirSync(artifactsRoot), []);
  assert.deepEqual(fs.readdirSync(stateRoot), []);
});

test("preflights every publication body, graph shape, and final receipt before mutating the store", async (t) => {
  const oversized = "x".repeat((8 * 1024 * 1024) + 1);
  const cases = [
    { name: "malformed graph JSON", overrides: { graphRaw: "not-json" }, error: /valid JSON/i },
    { name: "missing graph links", overrides: { graphRaw: JSON.stringify({ nodes: [] }) }, error: /nodes and links/i },
    {
      name: "graph count mismatch",
      overrides: { graphRaw: JSON.stringify({ nodes: [], links: [] }) },
      error: /counts must match/i,
    },
    { name: "oversized HTML", overrides: { html: oversized }, error: /html artifact record is invalid/i },
    { name: "oversized Markdown", overrides: { report: oversized }, error: /markdown artifact record is invalid/i },
    {
      name: "oversized private graph",
      overrides: { graphRaw: JSON.stringify({ nodes: [{ id: "one" }], links: [], padding: oversized }) },
      error: /private graph exceeds/i,
    },
    {
      name: "oversized private manifest",
      overrides: { target: { id: `repo:${"a".repeat(70 * 1024)}`, label: "AgentHost", kind: "repo" } },
      error: /manifest exceeds/i,
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, () => {
      const { stateRoot, artifactsRoot } = fixture(t);
      const existing = publishGraphifyRun({
        stateRoot,
        artifactsRoot,
        ...publication({ snapshot: { ...publication().snapshot, builtAt: "2026-08-14T11:00:00.000Z" } }),
        randomBytes: (length) => Buffer.from("a".repeat(32), "hex").subarray(0, length),
        retain: 1,
      });
      const nextRunId = "b".repeat(32);
      const nonce = "c".repeat(16);
      const stem = `graphify-agenthost-all-${nextRunId}`;
      const hiddenHtml = path.join(artifactsRoot, `.${stem}.html.${nonce}.pending`);
      const hiddenMarkdown = path.join(artifactsRoot, `.${stem}.md.${nonce}.pending`);
      fs.writeFileSync(hiddenHtml, "unfinished html");
      fs.writeFileSync(hiddenMarkdown, "unfinished markdown");

      assert.throws(() => publishGraphifyRun({
        stateRoot,
        artifactsRoot,
        ...publication(entry.overrides),
        randomBytes: (length) => length === 16
          ? Buffer.from(nextRunId, "hex")
          : Buffer.from(nonce, "hex"),
        retain: 1,
      }), entry.error);

      assert.equal(fs.existsSync(path.join(stateRoot, existing.runId)), true, "the prior committed run remains");
      assert.equal(fs.existsSync(path.join(stateRoot, nextRunId)), false, "the rejected run is never committed");
      assert.equal(fs.readFileSync(hiddenHtml, "utf8"), "unfinished html", "preflight does not reclaim staging files");
      assert.equal(fs.readFileSync(hiddenMarkdown, "utf8"), "unfinished markdown", "preflight does not reclaim staging files");
      assert.equal(fs.existsSync(path.join(artifactsRoot, existing.artifacts.html.name)), true);
      assert.equal(fs.existsSync(path.join(artifactsRoot, existing.artifacts.markdown.name)), true);
    });
  }
});

test("a failed replacement commit never prunes older valid runs", (t) => {
  const { stateRoot, artifactsRoot } = fixture(t);
  const existing = [];
  for (let index = 1; index <= 2; index += 1) {
    existing.push(publishGraphifyRun({
      stateRoot,
      artifactsRoot,
      ...publication({ snapshot: { ...publication().snapshot, builtAt: `2026-08-14T1${index}:00:00.000Z` } }),
      randomBytes: (length) => Buffer.from(String(index).repeat(32), "hex").subarray(0, length),
      retain: 2,
    }));
  }
  const fsImpl = Object.create(fs);
  fsImpl.openSync = (file, flags, mode) => {
    if (path.basename(file).endsWith(".pending")) throw new Error("replacement write refused");
    return fs.openSync(file, flags, mode);
  };

  assert.throws(() => publishGraphifyRun({
    stateRoot,
    artifactsRoot,
    ...publication({ snapshot: { ...publication().snapshot, builtAt: "2026-08-14T13:00:00.000Z" } }),
    randomBytes: (length) => Buffer.from("3".repeat(32), "hex").subarray(0, length),
    retain: 2,
    fsImpl,
  }), /replacement write refused/);

  assert.deepEqual(fs.readdirSync(stateRoot).sort(), existing.map(({ runId }) => runId).sort());
  for (const receipt of existing) {
    assert.equal(fs.existsSync(path.join(artifactsRoot, receipt.artifacts.html.name)), true);
    assert.equal(fs.existsSync(path.join(artifactsRoot, receipt.artifacts.markdown.name)), true);
  }
});

test("a stale-run unlink failure is recoverable because its private commit marker is removed first", (t) => {
  const { stateRoot, artifactsRoot } = fixture(t);
  const stale = publishGraphifyRun({
    stateRoot,
    artifactsRoot,
    ...publication({ snapshot: { ...publication().snapshot, builtAt: "2026-08-14T10:00:00.000Z" } }),
    randomBytes: (length) => Buffer.from("1a".repeat(16), "hex").subarray(0, length),
  });
  const retained = publishGraphifyRun({
    stateRoot,
    artifactsRoot,
    ...publication({ snapshot: { ...publication().snapshot, builtAt: "2026-08-14T11:00:00.000Z" } }),
    randomBytes: (length) => Buffer.from("2b".repeat(16), "hex").subarray(0, length),
  });
  let unlinks = 0;
  const fsImpl = Object.create(fs);
  fsImpl.unlinkSync = (file) => {
    unlinks += 1;
    if (unlinks === 2) throw new Error("cleanup unlink refused");
    return fs.unlinkSync(file);
  };

  assert.throws(() => prepareGraphifyStore({ stateRoot, artifactsRoot, retain: 1, fsImpl }), /cleanup unlink refused/);
  assert.equal(fs.existsSync(path.join(stateRoot, stale.runId)), false, "the stale commit marker is gone before public cleanup");
  assert.equal(fs.existsSync(path.join(stateRoot, retained.runId)), true);
  assert.doesNotThrow(() => prepareGraphifyStore({ stateRoot, artifactsRoot, retain: 1 }));
  assert.equal(fs.existsSync(path.join(artifactsRoot, stale.artifacts.html.name)), false);
  assert.equal(fs.existsSync(path.join(artifactsRoot, stale.artifacts.markdown.name)), false);
  assert.equal(fs.existsSync(path.join(artifactsRoot, retained.artifacts.html.name)), true);
  assert.equal(fs.existsSync(path.join(artifactsRoot, retained.artifacts.markdown.name)), true);
});

test("post-commit retention failure returns the committed receipt with a bounded warning", (t) => {
  const { stateRoot, artifactsRoot } = fixture(t);
  const stale = publishGraphifyRun({
    stateRoot,
    artifactsRoot,
    ...publication({ snapshot: { ...publication().snapshot, builtAt: "2026-08-14T10:00:00.000Z" } }),
    randomBytes: (length) => Buffer.from("3c".repeat(16), "hex").subarray(0, length),
    retain: 1,
  });
  const nextRunId = "4d".repeat(16);
  const fsImpl = Object.create(fs);
  fsImpl.rmSync = (target, options) => {
    if (path.basename(target) === stale.runId) throw new Error("stale removal refused token=hidden-value C:\\private\\store");
    return fs.rmSync(target, options);
  };

  const committed = publishGraphifyRun({
    stateRoot,
    artifactsRoot,
    ...publication({ snapshot: { ...publication().snapshot, builtAt: "2026-08-14T11:00:00.000Z" } }),
    randomBytes: (length) => Buffer.from(nextRunId, "hex").subarray(0, length),
    retain: 1,
    fsImpl,
  });
  assert.equal(committed.runId, nextRunId);
  assert.deepEqual(Object.keys(committed.warnings || {}), ["retention"]);
  assert.match(committed.warnings.retention, /committed.*deferred.*stale removal refused/i);
  assert.doesNotMatch(committed.warnings.retention, /hidden-value|C:\\private/i);
  assert.ok(committed.warnings.retention.length <= 240);
  assert.equal(fs.existsSync(path.join(stateRoot, nextRunId)), true);
  assert.equal(fs.existsSync(path.join(artifactsRoot, committed.artifacts.html.name)), true);
  assert.equal(fs.existsSync(path.join(artifactsRoot, committed.artifacts.markdown.name)), true);

  assert.doesNotThrow(() => prepareGraphifyStore({ stateRoot, artifactsRoot, retain: 1 }));
  assert.equal(fs.existsSync(path.join(stateRoot, stale.runId)), false);
  assert.equal(fs.existsSync(path.join(stateRoot, nextRunId)), true);
});

test("post-commit integrity failure is typed as committed-invalid, never a cleanup warning", (t) => {
  const { stateRoot, artifactsRoot } = fixture(t);
  const runId = "5e".repeat(16);
  const fsImpl = Object.create(fs);
  fsImpl.renameSync = (from, to) => {
    const result = fs.renameSync(from, to);
    if (path.basename(to) === runId) {
      fs.writeFileSync(path.join(to, "graph.json"), JSON.stringify({ nodes: [], links: [] }));
    }
    return result;
  };

  assert.throws(() => publishGraphifyRun({
    stateRoot,
    artifactsRoot,
    ...publication(),
    randomBytes: (length) => Buffer.from(runId, "hex").subarray(0, length),
    fsImpl,
  }), (error) => {
    assert.equal(error.code, "GRAPHIFY_COMMITTED_INVALID");
    assert.equal(error.committed, true);
    assert.equal(error.retrySafe, false);
    assert.equal(error.runId, runId);
    assert.match(error.message, /committed.*integrity/i);
    return true;
  });
  assert.equal(fs.existsSync(path.join(stateRoot, runId)), true, "the typed error is honest that the commit marker landed");
});

test("retention validates every committed receipt, private graph, projection state, and public pair before deleting anything", async (t) => {
  for (const mutation of ["receipt", "graph", "projection", "public pair"]) {
    await t.test(mutation, () => {
      const { stateRoot, artifactsRoot } = fixture(t);
      const receipts = [];
      const projection = brandProjection();
      const firstOptions = mutation === "projection" ? {
        target: { id: "brand:acme-1", label: "Acme (acme-1)", kind: "brand" },
        folder: { id: "brand_all", label: "Brand DNA" },
      } : {};
      const first = publishGraphifyRun({
        stateRoot,
        artifactsRoot,
        ...publication({
          ...firstOptions,
          snapshot: { ...publication().snapshot, builtAt: "2026-08-14T10:00:00.000Z" },
        }),
        ...(mutation === "projection" ? { brandProjection: projection } : {}),
        randomBytes: (length) => Buffer.from("4".repeat(32), "hex").subarray(0, length),
      });
      receipts.push(first);
      if (mutation === "projection") {
        completeGraphifyBrandProjection(stateRoot, artifactsRoot, {
          runId: first.runId,
          accountId: projection.accountId,
          operationId: projection.operationId,
        });
      }
      for (let index = 5; index <= 6; index += 1) {
        receipts.push(publishGraphifyRun({
          stateRoot,
          artifactsRoot,
          ...publication({ snapshot: { ...publication().snapshot, builtAt: `2026-08-14T1${index - 4}:00:00.000Z` } }),
          randomBytes: (length) => Buffer.from(String(index).repeat(32), "hex").subarray(0, length),
        }));
      }

      if (mutation === "receipt") {
        const manifestPath = path.join(stateRoot, first.runId, "manifest.json");
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        manifest.counts.nodes = -1;
        fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
      } else if (mutation === "graph") {
        fs.appendFileSync(path.join(stateRoot, first.runId, "graph.json"), "tampered");
      } else if (mutation === "projection") {
        fs.appendFileSync(path.join(stateRoot, first.runId, "brand-projection.complete.json"), "tampered");
      } else {
        fs.appendFileSync(path.join(artifactsRoot, first.artifacts.html.name), "tampered");
      }

      assert.throws(() => prepareGraphifyStore({ stateRoot, artifactsRoot, retain: 2 }), /Graphify/i);
      assert.deepEqual(
        fs.readdirSync(stateRoot).filter((name) => /^[a-f0-9]{32}$/.test(name)).sort(),
        receipts.map(({ runId }) => runId).sort(),
        "no run is deleted after any candidate fails validation",
      );
      for (const receipt of receipts) {
        assert.equal(fs.existsSync(path.join(artifactsRoot, receipt.artifacts.html.name)), true);
        assert.equal(fs.existsSync(path.join(artifactsRoot, receipt.artifacts.markdown.name)), true);
      }
    });
  }
});

test("a committed manifest cannot borrow another run's public artifact pair", (t) => {
  const { stateRoot, artifactsRoot } = fixture(t);
  const stale = publishGraphifyRun({
    stateRoot,
    artifactsRoot,
    ...publication({ snapshot: { ...publication().snapshot, builtAt: "2026-08-14T10:00:00.000Z" } }),
    randomBytes: (length) => Buffer.from("a1".repeat(16), "hex").subarray(0, length),
  });
  const retained = publishGraphifyRun({
    stateRoot,
    artifactsRoot,
    ...publication({ snapshot: { ...publication().snapshot, builtAt: "2026-08-14T11:00:00.000Z" } }),
    randomBytes: (length) => Buffer.from("b2".repeat(16), "hex").subarray(0, length),
  });
  const staleManifestPath = path.join(stateRoot, stale.runId, "manifest.json");
  const staleManifest = JSON.parse(fs.readFileSync(staleManifestPath, "utf8"));
  const retainedManifest = JSON.parse(fs.readFileSync(path.join(stateRoot, retained.runId, "manifest.json"), "utf8"));
  staleManifest.artifacts = retainedManifest.artifacts;
  fs.writeFileSync(staleManifestPath, `${JSON.stringify(staleManifest)}\n`);

  assert.throws(() => prepareGraphifyStore({ stateRoot, artifactsRoot, retain: 1 }), /artifact names do not match/i);
  assert.equal(fs.existsSync(path.join(stateRoot, stale.runId)), true);
  assert.equal(fs.existsSync(path.join(stateRoot, retained.runId)), true);
  assert.equal(fs.existsSync(path.join(artifactsRoot, retained.artifacts.html.name)), true);
  assert.equal(fs.existsSync(path.join(artifactsRoot, retained.artifacts.markdown.name)), true);
});

test("abandoned hidden publication leaves are reclaimed in bounded batches", (t) => {
  const { stateRoot, artifactsRoot } = fixture(t);
  const total = 64;
  for (let index = 0; index < total; index += 1) {
    const runId = index.toString(16).padStart(32, "0");
    const name = `.graphify-recovery-all-${runId}.html.${"d".repeat(16)}.pending`;
    fs.writeFileSync(path.join(artifactsRoot, name), "abandoned");
  }

  prepareGraphifyStore({ stateRoot, artifactsRoot });
  const afterFirst = fs.readdirSync(artifactsRoot).filter((name) => name.endsWith(".pending"));
  assert.equal(afterFirst.length, 32, "one request removes only the fixed recovery batch");
  prepareGraphifyStore({ stateRoot, artifactsRoot });
  assert.equal(fs.readdirSync(artifactsRoot).filter((name) => name.endsWith(".pending")).length, 0);
});

test("reclaims only safe same-name hidden publication leaves", (t) => {
  const { root, stateRoot, artifactsRoot } = fixture(t);
  const runId = "7".repeat(32);
  const nonce = "8".repeat(16);
  const stem = `graphify-agenthost-all-${runId}`;
  const hiddenHtml = path.join(artifactsRoot, `.${stem}.html.${nonce}.pending`);
  const hiddenMarkdown = path.join(artifactsRoot, `.${stem}.md.${nonce}.pending`);
  fs.writeFileSync(hiddenHtml, "abandoned html");
  fs.writeFileSync(hiddenMarkdown, "abandoned markdown");

  const receipt = publishGraphifyRun({
    stateRoot,
    artifactsRoot,
    ...publication(),
    randomBytes: (length) => length === 16 ? Buffer.from(runId, "hex") : Buffer.from(nonce, "hex"),
  });
  assert.equal(receipt.runId, runId);
  assert.equal(fs.existsSync(hiddenHtml), false);
  assert.equal(fs.existsSync(hiddenMarkdown), false);
  assert.equal(fs.readFileSync(path.join(artifactsRoot, receipt.artifacts.html.name), "utf8"), publication().html);

  const linkedRunId = "9".repeat(32);
  const linkedStem = `graphify-agenthost-all-${linkedRunId}`;
  const linkedPending = path.join(artifactsRoot, `.${linkedStem}.html.${nonce}.pending`);
  const alias = path.join(root, "linked-pending-alias");
  fs.writeFileSync(linkedPending, "do not unlink");
  fs.linkSync(linkedPending, alias);
  assert.throws(() => publishGraphifyRun({
    stateRoot,
    artifactsRoot,
    ...publication(),
    randomBytes: (length) => length === 16 ? Buffer.from(linkedRunId, "hex") : Buffer.from(nonce, "hex"),
  }), /unsafe artifact/i);
  assert.equal(fs.readFileSync(linkedPending, "utf8"), "do not unlink");
  assert.equal(fs.readFileSync(alias, "utf8"), "do not unlink");
  assert.equal(fs.existsSync(path.join(stateRoot, linkedRunId)), false);
});

test("only manifest-bound graph artifacts are visible and stale/orphan pairs are reclaimed", (t) => {
  const { stateRoot, artifactsRoot } = fixture(t);
  const results = [];
  for (let index = 0; index < 10; index += 1) {
    const runId = index.toString(16).padStart(32, "0");
    const result = publishGraphifyRun({
      stateRoot,
      artifactsRoot,
      ...publication({ snapshot: { ...publication().snapshot, builtAt: new Date(Date.UTC(2026, 7, 14, 12, 0, index)).toISOString() } }),
      randomBytes: (length) => Buffer.from(runId, "hex").subarray(0, length),
      retain: 8,
    });
    results.push(result);
  }
  fs.writeFileSync(path.join(artifactsRoot, `graphify-orphan-all-${"f".repeat(32)}.html`), "orphan");
  fs.writeFileSync(path.join(artifactsRoot, `graphify-orphan-all-${"f".repeat(32)}.md`), "orphan");
  fs.writeFileSync(path.join(artifactsRoot, "ordinary-report.md"), "keep");

  prepareGraphifyStore({ stateRoot, artifactsRoot, retain: 8 });

  const committed = fs.readdirSync(stateRoot).filter((name) => /^[a-f0-9]{32}$/.test(name)).sort();
  assert.deepEqual(committed, results.slice(2).map((entry) => entry.runId).sort());
  const visible = committedGraphifyArtifactNames(stateRoot);
  assert.equal(visible.length, 16);
  for (const stale of results.slice(0, 2)) {
    assert.equal(fs.existsSync(path.join(artifactsRoot, stale.artifacts.html.name)), false);
    assert.equal(fs.existsSync(path.join(artifactsRoot, stale.artifacts.markdown.name)), false);
  }
  assert.equal(fs.existsSync(path.join(artifactsRoot, `graphify-orphan-all-${"f".repeat(32)}.html`)), false);
  assert.equal(fs.readFileSync(path.join(artifactsRoot, "ordinary-report.md"), "utf8"), "keep");
});

test("public visibility requires both published files to match the private manifest", (t) => {
  const { stateRoot, artifactsRoot } = fixture(t);
  const result = publishGraphifyRun({ stateRoot, artifactsRoot, ...publication() });
  assert.deepEqual(new Set(committedGraphifyArtifactNames(stateRoot, { artifactsRoot })), new Set([
    result.artifacts.html.name,
    result.artifacts.markdown.name,
  ]));

  fs.appendFileSync(path.join(artifactsRoot, result.artifacts.html.name), "tampered");
  assert.deepEqual(committedGraphifyArtifactNames(stateRoot, { artifactsRoot }), []);
});

test("returns the exact verified pair bytes so a later public-file swap cannot change the response", (t) => {
  const { stateRoot, artifactsRoot } = fixture(t);
  const original = publication();
  const result = publishGraphifyRun({ stateRoot, artifactsRoot, ...original });

  const pair = readCommittedGraphifyArtifactPair(stateRoot, artifactsRoot, result.artifacts.html.name);
  assert.equal(pair.runId, result.runId);
  assert.equal(pair.artifacts.html.name, result.artifacts.html.name);
  assert.equal(pair.artifacts.html.bytes.toString("utf8"), original.html);
  assert.equal(pair.artifacts.markdown.bytes.toString("utf8"), original.report);
  assert.equal(pair.artifacts.html.sha256, crypto.createHash("sha256").update(original.html).digest("hex"));

  fs.writeFileSync(path.join(artifactsRoot, result.artifacts.html.name), "attacker replacement");
  assert.equal(pair.artifacts.html.bytes.toString("utf8"), original.html,
    "the response buffer remains the descriptor-verified bytes, not a reopened path");
  assert.throws(() => readCommittedGraphifyArtifactPair(stateRoot, artifactsRoot, result.artifacts.html.name), {
    code: "GRAPHIFY_INTEGRITY",
  }, "a later request names committed corruption instead of reporting an ordinary miss");
  assert.throws(() => readCommittedGraphifyArtifactPairs(stateRoot, artifactsRoot), {
    code: "GRAPHIFY_INTEGRITY",
  });

  const absentName = `graphify-agenthost-all-${"f".repeat(32)}.html`;
  assert.equal(readCommittedGraphifyArtifactPair(stateRoot, artifactsRoot, absentName), null,
    "a canonical name with no committed run remains an ordinary miss");
  assert.equal(readCommittedGraphifyArtifactPair(stateRoot, artifactsRoot, "ordinary-report.html"), null);
});

test("verified pair reads reject linked public leaves", (t) => {
  const { root, stateRoot, artifactsRoot } = fixture(t);
  const result = publishGraphifyRun({ stateRoot, artifactsRoot, ...publication() });
  const htmlPath = path.join(artifactsRoot, result.artifacts.html.name);
  const alias = path.join(root, "html-hardlink");
  fs.linkSync(htmlPath, alias);

  assert.throws(() => readCommittedGraphifyArtifactPair(stateRoot, artifactsRoot, result.artifacts.html.name), {
    code: "GRAPHIFY_INTEGRITY",
  });
  fs.unlinkSync(alias);
  assert.equal(readCommittedGraphifyArtifactPair(stateRoot, artifactsRoot, result.artifacts.html.name).runId, result.runId);
});

test("reads only the latest digest-bound private graph for an exact target", (t) => {
  const { stateRoot, artifactsRoot } = fixture(t);
  const older = publication({
    target: { id: "vault", label: "Brain Vault", kind: "vault" },
    snapshot: { ...publication().snapshot, builtAt: "2026-08-14T10:00:00.000Z" },
    graphRaw: JSON.stringify({ nodes: [{ id: "older" }], links: [] }),
  });
  const newer = publication({
    target: { id: "vault", label: "Brain Vault", kind: "vault" },
    snapshot: { ...publication().snapshot, builtAt: "2026-08-14T11:00:00.000Z" },
    graphRaw: JSON.stringify({ nodes: [{ id: "newer" }], links: [] }),
  });
  publishGraphifyRun({ stateRoot, artifactsRoot, ...older });
  const receipt = publishGraphifyRun({ stateRoot, artifactsRoot, ...newer });

  const loaded = latestCommittedGraphifyRun(stateRoot, { targetId: "vault" });
  assert.equal(loaded.manifest.runId, receipt.runId);
  assert.equal(loaded.manifest.target.id, "vault");
  assert.deepEqual(loaded.graph.nodes, [{ id: "newer" }]);
  assert.equal(latestCommittedGraphifyRun(stateRoot, { targetId: "missing" }), null);

  fs.writeFileSync(path.join(stateRoot, receipt.runId, "graph.json"), JSON.stringify({ nodes: [{ id: "changed" }], links: [] }));
  assert.throws(() => latestCommittedGraphifyRun(stateRoot, { targetId: "vault" }), /does not match its manifest/i);
});

test("unsafe labels, paths, roots, and corrupt committed manifests fail closed", (t) => {
  const { root, stateRoot, artifactsRoot } = fixture(t);
  for (const label of ["../escape", "C:\\private", "bad/name", "<script>"]) {
    assert.throws(() => publishGraphifyRun({
      stateRoot,
      artifactsRoot,
      ...publication({ target: { id: "x", kind: "folder", label } }),
    }), /safe artifact label/i);
  }
  assert.throws(() => publishGraphifyRun({
    stateRoot: path.join(root, "missing"),
    artifactsRoot,
    ...publication(),
  }), /state root is unavailable/i);

  const corrupt = path.join(stateRoot, "e".repeat(32));
  fs.mkdirSync(corrupt);
  fs.writeFileSync(path.join(corrupt, "manifest.json"), "not-json");
  assert.throws(() => committedGraphifyArtifactNames(stateRoot), /committed manifest .* invalid/i);
  assert.throws(() => readCommittedGraphifyArtifactPair(
    stateRoot,
    artifactsRoot,
    `graphify-agenthost-all-${"e".repeat(32)}.html`,
  ), { code: "GRAPHIFY_INTEGRITY" });
  assert.throws(() => readCommittedGraphifyArtifactPairs(stateRoot, artifactsRoot), {
    code: "GRAPHIFY_INTEGRITY",
  });
});
