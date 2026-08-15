import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stopChild } from "./child-process-helper.js";
import { mintOperatorSession } from "./operator-session-helper.js";

const GATE = path.join(import.meta.dirname, "..", "container", "gate.js");
const KEY = "gate-graphify-test-key";
const REPO = "Stevekaplanai/agenthost-internal";
const BROKEN_REPO = "Stevekaplanai/graphify-broken";
const HIDDEN_SECRET = "known-graphify-secret-0123456789";
const SHAPED_SECRET = "sk-ABCDEFGHIJKLMNOPQRSTUVWX";
const ASSIGNED_SECRET = "unknown-graphify-assignment-secret";
const GENERIC_SECRET = "unknown-graphify-generic-secret";
const OPERATION_ID = "01".repeat(16);
let box = {};

function bootGate(home, stateRoot, captureFile, preload, extraEnv = {}) {
  const child = spawn(process.execPath, ["--require", preload, GATE], {
    env: {
      ...process.env,
      HOME: home,
      TTYD_PASSWORD: KEY,
      AGENT_CHAT_BIN: process.execPath,
      GATE_PORT: "0",
      REPOS: `${REPO},${BROKEN_REPO}`,
      AGENTHOST_CODE_MAP_STATE_DIR: stateRoot,
      AGENTHOST_GRAPHIFY_TEST_CAPTURE: captureFile,
      AGENTHOST_GRAPHIFY_KNOWN_SECRET: HIDDEN_SECRET,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const port = new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`gate did not report its port; got: ${out}`)), 5000);
    child.stdout.on("data", (chunk) => {
      out += chunk.toString();
      const match = out.match(/listening on (\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.on("exit", () => {
      clearTimeout(timer);
      reject(new Error(`gate exited before listening; got: ${out}`));
    });
  });
  return { child, port, stderr: () => stderr };
}

before(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gate-graphify-"));
  const stateRoot = path.join(home, ".agenthost", "graphify");
  const captureFile = path.join(home, "capture.json");
  const preload = path.join(home, "graphify-preload.cjs");
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(home, "artifacts"), { recursive: true });
  fs.writeFileSync(preload, String.raw`
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const originalLoad = Module._load;
const TARGETS = [
  { id: "harness", label: "Agent harness", kind: "harness", folders: [{ id: "h_all", label: "All" }], defaultFolderId: "h_all" },
  { id: "repo:${REPO}", label: "${REPO}", kind: "repo", folders: [{ id: "f_111111111111111111111111", label: "All" }], defaultFolderId: "f_111111111111111111111111" },
  { id: "repo:${BROKEN_REPO}", label: "${BROKEN_REPO}", kind: "repo", folders: [{ id: "f_222222222222222222222222", label: "All" }], defaultFolderId: "f_222222222222222222222222" },
];
const BRAND_ACCOUNT = { account_id: "acme", name: "Acme" };
const BRAND_RECORDS = [{
  id: "dna-voice", account_id: "acme", asset: "voice", source: "client",
  content: "Plain-spoken", version: 1, updated_at: "2026-08-14T12:00:00.000Z", schemaVersion: 1,
}];
let capture = {};
let brandListCalls = 0;
let brandProjectionCalls = 0;
let graphifyRuns = 0;
let graphifyPublications = 0;
let brandProjectionCompletions = 0;
let pendingBrandProjection = null;
let completedBrandProjection = null;
let brandOperationLease = null;
let nextBrandOperation = 2;
const acknowledgedBrandOperations = new Set();
function save(next) { capture = { ...capture, ...next }; fs.writeFileSync(process.env.AGENTHOST_GRAPHIFY_TEST_CAPTURE, JSON.stringify(capture)); }
function plan(input) {
  const target = TARGETS.find((item) => item.id === input.targetId);
  const folder = target && target.folders.find((item) => item.id === input.folderId);
  if (!target || !folder) {
    throw new Error("selection " + process.env.AGENTHOST_GRAPHIFY_KNOWN_SECRET + " under /data/private/corpora is unavailable");
  }
  return {
    target: { id: target.id, label: target.label, kind: target.kind },
    folder: { id: folder.id, label: folder.label },
    sourceRoot: path.join(process.env.HOME, "server-owned", target.kind),
    includeRoots: ["."], extensions: [".md"], allowedBasenames: [], maxDepth: 4,
    redactInputs: true, snapshotKind: target.kind === "repo" ? "git" : "folder",
  };
}
Module._load = function (request, parent, isMain) {
  if (parent && /gate\.js$/.test(parent.filename) && request === "./growth-lib.js") {
    const actual = originalLoad.call(this, request, parent, isMain);
    return {
      ...actual,
      config() { return { ok: true, url: "http://brain.invalid", key: "growth" }; },
      async listAccounts() {
        if (process.env.AGENTHOST_GRAPHIFY_ACCOUNT_FAILURE_AFTER_RUN === "1" && graphifyRuns > 0) {
          throw new Error("the current account list is temporarily unavailable");
        }
        return [BRAND_ACCOUNT];
      },
      async listDna(_cfg, accountId) {
        brandListCalls += 1;
        save({ brandListAccountId: accountId, brandListCalls });
        return process.env.AGENTHOST_GRAPHIFY_BRAND_CHANGE_AFTER_FIRST === "1" && brandListCalls > 1
          ? [{ ...BRAND_RECORDS[0], content: "Updated after the first Graphify request", version: 2 }]
          : BRAND_RECORDS;
      },
      async projectGraphifyBrandClaims(options) {
        brandProjectionCalls += 1;
        const priorRunIds = Array.isArray(capture.brandProjectionRunIds) ? capture.brandProjectionRunIds : [];
        save({ brandProjection: options, brandProjectionCalls, brandProjectionRunIds: [...priorRunIds, options.runId] });
        if (process.env.AGENTHOST_GRAPHIFY_BRAND_PARTIAL === "1" && brandProjectionCalls === 1) {
          const error = new Error("Brain claim write refused");
          error.landedCount = 1;
          error.existingCount = 0;
          error.totalClaims = 2;
          throw error;
        }
        return process.env.AGENTHOST_GRAPHIFY_BRAND_PARTIAL === "1"
          ? { ok: true, written: 0, existing: 1, claims: [{ id: "claim-1" }] }
          : { ok: true, written: 1, existing: 0, claims: [{ id: "claim-1" }] };
      },
    };
  }
  if (parent && /gate\.js$/.test(parent.filename) && request === "./graphify-brand-corpus.js") {
    const target = { id: "brand:acme", label: "Acme (acme)", kind: "brand", folders: [{ id: "brand_all", label: "Brand DNA" }], defaultFolderId: "brand_all" };
    return {
      listBrandGraphifyTargets(accounts) {
        save({ brandTargetAccounts: accounts });
        return [target];
      },
      resolveBrandGraphifyChoice(accounts, input) {
        if (accounts[0].account_id !== "acme" || input.targetId !== target.id || input.folderId !== "brand_all") throw new Error("Brand choice unavailable");
        return { target: { id: target.id, label: target.label, kind: target.kind }, folder: target.folders[0], accountId: "acme" };
      },
      materializeBrandGraphifyCorpus(options) {
        save({ brandMaterialize: { accountId: options.records[0].account_id, stagingRoot: options.stagingRoot } });
        return {
          plan: {
            target: { id: target.id, label: target.label, kind: target.kind }, folder: target.folders[0],
            sourceRoot: path.join(options.stagingRoot, "mock-brand"), includeRoots: ["brand"], extensions: [".md"],
            allowedBasenames: [], maxDepth: 1, redactInputs: true, snapshotKind: "folder",
          },
          fileMetadata: { "brand/voice.md": { account_id: "acme", asset: "voice", claims: [{ claim: "Plain-spoken", confidence: "EXTRACTED" }] } },
          accountId: "acme",
          records: options.records,
          cleanup() { save({ brandCleaned: true }); },
        };
      },
    };
  }
  if (parent && /gate\.js$/.test(parent.filename) && request === "./graphify-corpora.js") {
    return {
      listGraphifyTargets(ctx) { save({ registryContext: { homeDir: ctx.homeDir, reposEnv: ctx.reposEnv } }); return TARGETS; },
      resolveGraphifyCorpus(ctx, input) { save({ resolveContext: { homeDir: ctx.homeDir, reposEnv: ctx.reposEnv }, selection: input }); return plan(input); },
    };
  }
  if (parent && /gate\.js$/.test(parent.filename) && request === "./graphify-lib.js") {
    return {
      prepareGraphifyResultRoot(root) { save({ preparedRoot: root }); },
      async runGraphifySnapshot(options) {
        graphifyRuns += 1;
        save({ runOptions: options, graphifyRuns });
        await new Promise((resolve, reject) => {
          let timer = null;
          const abort = () => {
            clearTimeout(timer);
            save({ aborted: true });
            const error = new Error("Graphify was cancelled after the worker stopped");
            error.name = "AbortError";
            error.code = "GRAPHIFY_CANCELLED";
            reject(error);
          };
          if (options.signal && options.signal.aborted) return abort();
          timer = setTimeout(() => {
            if (options.signal) options.signal.removeEventListener("abort", abort);
            resolve();
          }, 100);
          if (options.signal) options.signal.addEventListener("abort", abort, { once: true });
        });
        if (options.plan.target.id === "repo:${BROKEN_REPO}") {
          const error = new Error("worker " + process.env.AGENTHOST_GRAPHIFY_KNOWN_SECRET + " and ${SHAPED_SECRET} under /data/private/graphify did not report a terminal event\npassword=${ASSIGNED_SECRET}");
          error.terminationUnproven = true;
          throw error;
        }
        if (options.plan.target.id === "harness" && process.env.AGENTHOST_GRAPHIFY_GENERIC_FAILURE === "1") {
          throw new Error("Graphify worker returned accessToken: ${GENERIC_SECRET} while parsing /data/private/graphify");
        }
        if (options.plan.target.id === "brand:acme" && process.env.AGENTHOST_GRAPHIFY_BRAND_UNPROVEN === "1") {
          const error = new Error("Brand Graphify worker did not report a terminal event");
          error.terminationUnproven = true;
          throw error;
        }
        const graph = options.plan.target.id === "brand:acme"
          ? { nodes: [{ id: "brand-node", claims: [{ account_id: "acme", asset: "voice", claim: "Plain-spoken", confidence: "EXTRACTED" }] }], links: [] }
          : { nodes: [], links: [] };
        return {
          target: options.plan.target,
          folder: options.plan.folder,
          snapshot: { kind: "folder", value: "2026-08-14T12:00:00.000Z", manifestSha256: "a".repeat(64), builtAt: "2026-08-14T12:01:00.000Z", derived: true },
          counts: { files: 2, inputBytes: 123, nodes: 7, links: 9 },
          graphRaw: JSON.stringify(graph),
          graph,
          report: "# Graph report\n",
          html: "<!doctype html><title>Graph</title>",
        };
      },
    };
  }
  if (parent && /gate\.js$/.test(parent.filename) && request === "./graphify-store.js") {
    return {
      GRAPHIFY_ARTIFACT_RE: /^graphify-[a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{32}\.(?:html|md)$/,
      GRAPHIFY_COMMIT_UNCERTAIN_CODE: "GRAPHIFY_COMMIT_UNCERTAIN",
      GRAPHIFY_COMMITTED_INVALID_CODE: "GRAPHIFY_COMMITTED_INVALID",
      GRAPHIFY_INTEGRITY_CODE: "GRAPHIFY_INTEGRITY",
      GRAPHIFY_OPERATION_LEASE_INVALID_CODE: "GRAPHIFY_OPERATION_LEASE_INVALID",
      GRAPHIFY_OPERATION_LEASE_UNCERTAIN_CODE: "GRAPHIFY_OPERATION_LEASE_UNCERTAIN",
      GRAPHIFY_PENDING_MISMATCH_CODE: "GRAPHIFY_PENDING_MISMATCH",
      reserveGraphifyOperation(_stateRoot, options) {
        save({ brandOperationReservation: options });
        if (brandOperationLease) return brandOperationLease.operationId;
        const operationId = acknowledgedBrandOperations.size
          ? String(nextBrandOperation++).padStart(32, "0")
          : "${OPERATION_ID}";
        brandOperationLease = { ...options, operationId };
        return operationId;
      },
      acknowledgeGraphifyOperation(_stateRoot, _artifactsRoot, options) {
        save({ brandOperationAcknowledgement: options });
        const key = [options.targetId, options.folderId, options.accountId, options.operationId].join("/");
        if (!brandOperationLease) return acknowledgedBrandOperations.has(key);
        if (brandOperationLease.operationId !== options.operationId
            || brandOperationLease.targetId !== options.targetId
            || brandOperationLease.folderId !== options.folderId
            || brandOperationLease.accountId !== options.accountId
            || !completedBrandProjection
            || completedBrandProjection.operationId !== options.operationId) return false;
        acknowledgedBrandOperations.add(key);
        brandOperationLease = null;
        return true;
      },
      committedGraphifyArtifactNames() { return []; },
      latestCommittedGraphifyRun() {
        return {
          manifest: { runId: "f".repeat(32), snapshot: { manifestSha256: "b".repeat(64) } },
          graph: {
            nodes: [
              { id: "vault-a", source_file: "Projects/A.md", source_location: "L1", agenthost_kind: "file" },
              { id: "vault-b", source_file: "Projects/B.md", source_location: "L1", agenthost_kind: "file" },
            ],
            links: [{ source: "vault-a", target: "vault-b", relation: "references", confidence: "EXTRACTED" }],
          },
        };
      },
      prepareGraphifyStore(options) { save({ storeOptions: options }); },
      readPendingGraphifyBrandProjection(_stateRoot, _artifactsRoot, options) {
        save({ brandResumeLookup: options });
        if (process.env.AGENTHOST_GRAPHIFY_PENDING_MISMATCH === "1") {
          const error = new Error("unfinished Brand projection belongs to a different operation or source snapshot");
          error.code = "GRAPHIFY_PENDING_MISMATCH";
          error.retrySafe = false;
          error.runId = "fedcba9876543210fedcba9876543210";
          throw error;
        }
        return pendingBrandProjection || completedBrandProjection;
      },
      completeGraphifyBrandProjection(_stateRoot, _artifactsRoot, options) {
        if (!pendingBrandProjection || options.runId !== pendingBrandProjection.runId) throw new Error("pending Brand projection is missing");
        brandProjectionCompletions += 1;
        save({ brandProjectionCompletions, brandCompletion: options });
        if (process.env.AGENTHOST_GRAPHIFY_COMPLETION_UNCERTAIN === "1") {
          completedBrandProjection = { ...pendingBrandProjection, state: "complete", operationId: options.operationId };
          pendingBrandProjection = null;
          if (brandProjectionCompletions === 1) throw new Error("completion directory fsync was interrupted");
          return false;
        }
        completedBrandProjection = { ...pendingBrandProjection, state: "complete", operationId: options.operationId };
        pendingBrandProjection = null;
        return true;
      },
      publishGraphifyRun(options) {
        graphifyPublications += 1;
        save({ publishOptions: options, graphifyPublications });
        if (process.env.AGENTHOST_GRAPHIFY_COMMITTED_INVALID === "1") {
          const error = new Error("committed run under /data/private contains " + process.env.AGENTHOST_GRAPHIFY_KNOWN_SECRET + " and could not be verified");
          error.code = "GRAPHIFY_COMMITTED_INVALID";
          error.committed = true;
          error.retrySafe = false;
          error.runId = "0123456789abcdef0123456789abcdef";
          throw error;
        }
        if (process.env.AGENTHOST_GRAPHIFY_COMMIT_UNCERTAIN === "1") {
          const error = new Error("commit directory fsync was interrupted");
          error.code = "GRAPHIFY_COMMIT_UNCERTAIN";
          error.committed = true;
          error.retrySafe = false;
          error.runId = "0123456789abcdef0123456789abcdef";
          throw error;
        }
        const receipt = {
          runId: "0123456789abcdef0123456789abcdef",
          target: options.target,
          folder: options.folder,
          snapshot: options.snapshot,
          artifacts: {
            html: { name: "graphify-agent-harness-all-0123456789abcdef0123456789abcdef.html", viewUrl: "/artifacts/view?p=graphify-agent-harness-all-0123456789abcdef0123456789abcdef.html", downloadUrl: "/artifacts/dl?p=graphify-agent-harness-all-0123456789abcdef0123456789abcdef.html" },
            markdown: { name: "graphify-agent-harness-all-0123456789abcdef0123456789abcdef.md", viewUrl: "/artifacts/view?p=graphify-agent-harness-all-0123456789abcdef0123456789abcdef.md", downloadUrl: "/artifacts/dl?p=graphify-agent-harness-all-0123456789abcdef0123456789abcdef.md" },
          },
          counts: options.counts,
        };
        if (options.brandProjection) {
          pendingBrandProjection = {
            state: "pending",
            runId: receipt.runId,
            receipt,
            snapshot: options.snapshot,
            graph: JSON.parse(options.graphRaw),
            records: options.brandProjection.records,
          };
        }
        if (process.env.AGENTHOST_GRAPHIFY_RETENTION_WARNING === "1") {
          receipt.warnings = { retention: "old snapshot cleanup will retry on the next run" };
        }
        return receipt;
      },
    };
  }
  if (parent && /gate\.js$/.test(parent.filename) && request === "./brain-lib.js") {
    const actual = originalLoad.call(this, request, parent, isMain);
    return {
      ...actual,
      config() { return { ok: true, url: "http://brain.invalid", key: "panel", readKey: "steve" }; },
      async brain() {
        return {
          memories: [
            { id: "memory-a", tags: ["src:Projects/A.md", "chunk:0"], metadata: {} },
            { id: "memory-b", tags: ["src:Projects/B.md", "chunk:0"], metadata: {} },
          ],
        };
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
`);

  const { child, port, stderr } = bootGate(home, stateRoot, captureFile, preload);
  box = {
    home,
    stateRoot,
    captureFile,
    gate: child,
    stderr,
    base: `http://127.0.0.1:${await port}`,
  };
  box.cookie = (await mintOperatorSession(box.base, KEY)).cookie;
});

after(async () => {
  await stopChild(box.gate);
  if (box.home) fs.rmSync(box.home, { recursive: true, force: true });
});

function request(method, body, route = "/api/graphify") {
  const requestBody = method === "POST" && route === "/api/graphify" && body
    && !Object.hasOwn(body, "operationId")
    ? { ...body, operationId: OPERATION_ID }
    : body;
  return fetch(`${box.base}${route}`, {
    method,
    headers: {
      cookie: box.cookie,
      origin: box.base,
      "sec-fetch-site": "same-origin",
      ...(requestBody === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(requestBody === undefined ? {} : { body: JSON.stringify(requestBody) }),
  });
}

test("Graphify is cookie-walled and exposes only opaque server-approved target and folder choices", async () => {
  assert.equal((await fetch(`${box.base}/api/graphify`)).status, 401);
  assert.equal((await fetch(`${box.base}/api/graphify/operation`, { method: "POST" })).status, 401);
  const response = await request("GET");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.targets.map((target) => target.id), ["harness", `repo:${REPO}`, `repo:${BROKEN_REPO}`, "brand:acme"]);
  assert.deepEqual(body.warnings, []);
  assert.deepEqual(body.targets[0], {
    id: "harness",
    label: "Agent harness",
    kind: "harness",
    folders: [{ id: "h_all", label: "All" }],
    defaultFolderId: "h_all",
  });
  assert.doesNotMatch(JSON.stringify(body), /sourceRoot|includeRoots|[A-Za-z]:[\\/]|\/data\/|\/server-owned\//);
  assert.equal((await request("GET", undefined, "/api/code-map")).status, 404, "the retired route is not a second functional surface");
});

test("the server reserves one durable Brand operation, clears it only after completion, and acknowledges a lost response idempotently", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gate-graphify-operation-"));
  const stateRoot = path.join(home, ".agenthost", "graphify");
  const captureFile = path.join(home, "capture.json");
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(home, "artifacts"), { recursive: true });
  const local = bootGate(home, stateRoot, captureFile, path.join(box.home, "graphify-preload.cjs"));
  try {
    const base = `http://127.0.0.1:${await local.port}`;
    const cookie = (await mintOperatorSession(base, KEY)).cookie;
    const call = (method, body) => fetch(`${base}/api/graphify/operation`, {
      method,
      headers: { cookie, origin: base, "sec-fetch-site": "same-origin", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const selection = { targetId: "brand:acme", folderId: "brand_all" };

    assert.equal((await call("PUT", selection)).status, 405);
    assert.equal((await call("POST", { ...selection, path: "/private" })).status, 400);
    const firstReserve = await call("POST", selection);
    assert.equal(firstReserve.status, 200);
    const { operationId } = await firstReserve.json();
    assert.match(operationId, /^[a-f0-9]{32}$/);
    assert.equal((await (await call("POST", selection)).json()).operationId, operationId,
      "concurrent tabs must converge on the active server lease");

    const forged = await fetch(`${base}/api/graphify`, {
      method: "POST",
      headers: { cookie, origin: base, "sec-fetch-site": "same-origin", "content-type": "application/json" },
      body: JSON.stringify({ ...selection, operationId: "ff".repeat(16) }),
    });
    assert.equal(forged.status, 409);
    assert.equal((await forged.json()).code, "GRAPHIFY_OPERATION_MISMATCH");
    assert.equal(JSON.parse(fs.readFileSync(captureFile, "utf8")).graphifyRuns, undefined,
      "a forged operation reached the Graphify worker before the server lease rejected it");

    const earlyAck = await call("DELETE", { ...selection, operationId });
    assert.equal(earlyAck.status, 409, "an unfinished operation cannot be cleared");

    const generated = await fetch(`${base}/api/graphify`, {
      method: "POST",
      headers: { cookie, origin: base, "sec-fetch-site": "same-origin", "content-type": "application/json" },
      body: JSON.stringify({ ...selection, operationId }),
    });
    assert.equal(generated.status, 200);

    const expectedAck = { ok: true, ...selection, operationId };
    const acknowledged = await call("DELETE", { ...selection, operationId });
    assert.equal(acknowledged.status, 200);
    assert.deepEqual(await acknowledged.json(), expectedAck);
    const lostResponseRetry = await call("DELETE", { ...selection, operationId });
    assert.equal(lostResponseRetry.status, 200);
    assert.deepEqual(await lostResponseRetry.json(), expectedAck);

    const next = await call("POST", selection);
    assert.equal(next.status, 200);
    assert.notEqual((await next.json()).operationId, operationId,
      "a later intentional Generate must receive a fresh operation after acknowledgement");
    const capture = JSON.parse(fs.readFileSync(captureFile, "utf8"));
    assert.deepEqual(capture.brandOperationReservation, { ...selection, accountId: "acme" });
    assert.deepEqual(capture.brandOperationAcknowledgement, { ...selection, accountId: "acme", operationId });
  } finally {
    await stopChild(local.child);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a completed Brand operation can be acknowledged while the live account list is unavailable", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gate-graphify-operation-ack-outage-"));
  const stateRoot = path.join(home, ".agenthost", "graphify");
  const captureFile = path.join(home, "capture.json");
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(home, "artifacts"), { recursive: true });
  const local = bootGate(home, stateRoot, captureFile, path.join(box.home, "graphify-preload.cjs"), {
    AGENTHOST_GRAPHIFY_ACCOUNT_FAILURE_AFTER_RUN: "1",
  });
  try {
    const base = `http://127.0.0.1:${await local.port}`;
    const cookie = (await mintOperatorSession(base, KEY)).cookie;
    const headers = { cookie, origin: base, "sec-fetch-site": "same-origin", "content-type": "application/json" };
    const selection = { targetId: "brand:acme", folderId: "brand_all" };
    const reserved = await fetch(`${base}/api/graphify/operation`, {
      method: "POST", headers, body: JSON.stringify(selection),
    });
    const { operationId } = await reserved.json();
    const generated = await fetch(`${base}/api/graphify`, {
      method: "POST", headers, body: JSON.stringify({ ...selection, operationId }),
    });
    assert.equal(generated.status, 200);
    const acknowledged = await fetch(`${base}/api/graphify/operation`, {
      method: "DELETE", headers, body: JSON.stringify({ ...selection, operationId }),
    });
    assert.equal(acknowledged.status, 200,
      "acknowledgement incorrectly depended on a live Growth account read after the graph was committed");
  } finally {
    await stopChild(local.child);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Brand DNA uses the same Graphify runner and saves provenance-bound claims after publication", async () => {
  const response = await request("POST", { targetId: "brand:acme", folderId: "brand_all" });
  assert.equal(response.status, 200);
  const receipt = await response.json();
  assert.equal(receipt.target.id, "brand:acme");
  const capture = JSON.parse(fs.readFileSync(box.captureFile, "utf8"));
  assert.equal(capture.brandListAccountId, "acme");
  assert.equal(capture.brandMaterialize.accountId, "acme");
  assert.equal(capture.runOptions.plan.target.id, "brand:acme");
  assert.equal(capture.runOptions.fileMetadata["brand/voice.md"].account_id, "acme");
  assert.equal(capture.publishOptions.target.id, "brand:acme");
  assert.equal(capture.brandResumeLookup.operationId, OPERATION_ID);
  assert.equal(capture.publishOptions.brandProjection.operationId, OPERATION_ID);
  assert.equal(capture.brandProjection.accountId, "acme");
  assert.equal(capture.brandProjection.records[0].account_id, "acme");
  assert.equal(capture.brandProjection.graph.nodes[0].claims[0].confidence, "EXTRACTED");
  assert.equal(capture.brandCompletion.operationId, OPERATION_ID);
  assert.deepEqual(Object.keys(capture.brandCompletion).sort(), ["accountId", "operationId", "runId"]);
  assert.equal(capture.brandCleaned, true);
});

test("a partial Brand claim save resumes the same committed run without duplicate artifacts", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gate-graphify-brand-partial-"));
  const stateRoot = path.join(home, ".agenthost", "graphify");
  const captureFile = path.join(home, "capture.json");
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(home, "artifacts"), { recursive: true });
  const local = bootGate(home, stateRoot, captureFile, path.join(box.home, "graphify-preload.cjs"), {
    AGENTHOST_GRAPHIFY_BRAND_PARTIAL: "1",
    AGENTHOST_GRAPHIFY_BRAND_CHANGE_AFTER_FIRST: "1",
  });
  try {
    const base = `http://127.0.0.1:${await local.port}`;
    const cookie = (await mintOperatorSession(base, KEY)).cookie;
    const run = () => fetch(`${base}/api/graphify`, {
      method: "POST",
      headers: { cookie, origin: base, "sec-fetch-site": "same-origin", "content-type": "application/json" },
      body: JSON.stringify({ targetId: "brand:acme", folderId: "brand_all", operationId: OPERATION_ID }),
    });

    const first = await run();
    assert.equal(first.status, 502);
    const failed = await first.json();
    assert.equal(failed.code, "GRAPHIFY_BRAND_PROJECTION_FAILED");
    assert.match(failed.error, /1 Brand DNA claim was confirmed before a later claim failed/i);
    assert.match(failed.error, /Brain claim write refused/i);

    const second = await run();
    assert.equal(second.status, 200);
    const resumed = await second.json();
    assert.equal(resumed.runId, "0123456789abcdef0123456789abcdef");
    const capture = JSON.parse(fs.readFileSync(captureFile, "utf8"));
    assert.equal(capture.graphifyRuns, 1, "resume never starts a second Graphify child");
    assert.equal(capture.graphifyPublications, 1, "resume never publishes a second artifact pair");
    assert.equal(capture.brandProjectionCalls, 2);
    assert.deepEqual(capture.brandProjectionRunIds, [resumed.runId, resumed.runId]);
    assert.equal(capture.brandListCalls, 2, "the retry observes the changed live Brand DNA");
    assert.equal(capture.brandProjection.records[0].content, "Plain-spoken",
      "the same operation resumes its committed source records instead of silently switching snapshots");
    assert.equal(capture.brandProjectionCompletions, 1);
  } finally {
    await stopChild(local.child);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a post-commit verification failure is named and never presented as safe to retry", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gate-graphify-committed-invalid-"));
  const stateRoot = path.join(home, ".agenthost", "graphify");
  const captureFile = path.join(home, "capture.json");
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(home, "artifacts"), { recursive: true });
  const local = bootGate(home, stateRoot, captureFile, path.join(box.home, "graphify-preload.cjs"), {
    AGENTHOST_GRAPHIFY_COMMITTED_INVALID: "1",
  });
  try {
    const base = `http://127.0.0.1:${await local.port}`;
    const cookie = (await mintOperatorSession(base, KEY)).cookie;
    const response = await fetch(`${base}/api/graphify`, {
      method: "POST",
      headers: { cookie, origin: base, "sec-fetch-site": "same-origin", "content-type": "application/json" },
      body: JSON.stringify({ targetId: "harness", folderId: "h_all", operationId: OPERATION_ID }),
    });
    assert.equal(response.status, 503);
    const result = await response.json();
    assert.equal(result.code, "GRAPHIFY_COMMITTED_INVALID");
    assert.equal(result.runId, "0123456789abcdef0123456789abcdef");
    assert.equal(result.retrySafe, false);
    assert.match(result.error, /committed.*could not be verified.*do not retry/i);
    assert.doesNotMatch(result.error, new RegExp(`${HIDDEN_SECRET}|/data/private`));
    const capture = JSON.parse(fs.readFileSync(captureFile, "utf8"));
    assert.equal(capture.graphifyRuns, 1);
    assert.equal(capture.graphifyPublications, 1);
  } finally {
    await stopChild(local.child);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("durability uncertainty and a mismatched pending Brand run are named and never safe to retry", async () => {
  for (const scenario of [
    {
      name: "commit-uncertain",
      env: { AGENTHOST_GRAPHIFY_COMMIT_UNCERTAIN: "1" },
      body: { targetId: "harness", folderId: "h_all" },
      status: 503,
      code: "GRAPHIFY_COMMIT_UNCERTAIN",
      runId: "0123456789abcdef0123456789abcdef",
      error: /commit point.*durability.*do not retry/i,
    },
    {
      name: "pending-mismatch",
      env: { AGENTHOST_GRAPHIFY_PENDING_MISMATCH: "1" },
      body: { targetId: "brand:acme", folderId: "brand_all" },
      status: 409,
      code: "GRAPHIFY_PENDING_MISMATCH",
      runId: "fedcba9876543210fedcba9876543210",
      error: /unfinished Brand graph.*different operation or source snapshot.*do not retry/i,
    },
  ]) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `gate-graphify-${scenario.name}-`));
    const stateRoot = path.join(home, ".agenthost", "graphify");
    const captureFile = path.join(home, "capture.json");
    fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(home, "artifacts"), { recursive: true });
    const local = bootGate(home, stateRoot, captureFile, path.join(box.home, "graphify-preload.cjs"), scenario.env);
    try {
      const base = `http://127.0.0.1:${await local.port}`;
      const cookie = (await mintOperatorSession(base, KEY)).cookie;
      const response = await fetch(`${base}/api/graphify`, {
        method: "POST",
        headers: { cookie, origin: base, "sec-fetch-site": "same-origin", "content-type": "application/json" },
        body: JSON.stringify({ ...scenario.body, operationId: OPERATION_ID }),
      });
      assert.equal(response.status, scenario.status);
      const result = await response.json();
      assert.equal(result.code, scenario.code);
      assert.equal(result.runId, scenario.runId);
      assert.equal(result.retrySafe, false);
      assert.match(result.error, scenario.error);
    } finally {
      await stopChild(local.child);
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
});

test("a completed Brand snapshot is returned after completion durability was uncertain without rerunning or duplicating claims", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gate-graphify-completion-recovery-"));
  const stateRoot = path.join(home, ".agenthost", "graphify");
  const captureFile = path.join(home, "capture.json");
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(home, "artifacts"), { recursive: true });
  const local = bootGate(home, stateRoot, captureFile, path.join(box.home, "graphify-preload.cjs"), {
    AGENTHOST_GRAPHIFY_COMPLETION_UNCERTAIN: "1",
  });
  try {
    const base = `http://127.0.0.1:${await local.port}`;
    const cookie = (await mintOperatorSession(base, KEY)).cookie;
    const request = () => fetch(`${base}/api/graphify`, {
      method: "POST",
      headers: { cookie, origin: base, "sec-fetch-site": "same-origin", "content-type": "application/json" },
      body: JSON.stringify({ targetId: "brand:acme", folderId: "brand_all", operationId: OPERATION_ID }),
    });
    const first = await request();
    assert.equal(first.status, 502);
    assert.equal((await first.json()).code, "GRAPHIFY_BRAND_PROJECTION_STATE_FAILED");
    const second = await request();
    assert.equal(second.status, 200);
    const recovered = await second.json();
    assert.equal(recovered.runId, "0123456789abcdef0123456789abcdef");
    const capture = JSON.parse(fs.readFileSync(captureFile, "utf8"));
    assert.equal(capture.graphifyRuns, 1);
    assert.equal(capture.graphifyPublications, 1);
    assert.equal(capture.brandProjectionCalls, 1);
    assert.equal(capture.brandProjectionCompletions, 1);
  } finally {
    await stopChild(local.child);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a committed graph returns and audits its bounded deferred-retention warning", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gate-graphify-retention-warning-"));
  const stateRoot = path.join(home, ".agenthost", "graphify");
  const captureFile = path.join(home, "capture.json");
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(home, "artifacts"), { recursive: true });
  const local = bootGate(home, stateRoot, captureFile, path.join(box.home, "graphify-preload.cjs"), {
    AGENTHOST_GRAPHIFY_RETENTION_WARNING: "1",
  });
  try {
    const base = `http://127.0.0.1:${await local.port}`;
    const cookie = (await mintOperatorSession(base, KEY)).cookie;
    const response = await fetch(`${base}/api/graphify`, {
      method: "POST",
      headers: { cookie, origin: base, "sec-fetch-site": "same-origin", "content-type": "application/json" },
      body: JSON.stringify({ targetId: "harness", folderId: "h_all", operationId: OPERATION_ID }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.warnings, { retention: "old snapshot cleanup will retry on the next run" });
    const audit = fs.readFileSync(path.join(home, ".claude", "agenthost", "audit.log"), "utf8");
    assert.match(audit, /graphify_retention_deferred.*old snapshot cleanup will retry on the next run/);
  } finally {
    await stopChild(local.child);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Graphify rejects fields and choices that the server registry did not issue before reserving the lane", async () => {
  let response = await request("POST", { targetId: "harness", folderId: "h_all", path: "C:\\private" });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    code: "GRAPHIFY_REQUEST_INVALID",
    error: "the request must contain exactly targetId, folderId, and a 32-character lowercase hexadecimal operationId",
  });

  response = await request("POST", { targetId: "harness", folderId: "h_all", operationId: "NOT-HEX" });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "GRAPHIFY_REQUEST_INVALID");

  response = await request("POST", { targetId: "repo:unconfigured/repo", folderId: "f_000000000000000000000000" });
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.code, "GRAPHIFY_SELECTION_INVALID");
  assert.match(body.error, /selection .* is unavailable/i);
  assert.doesNotMatch(JSON.stringify(body), new RegExp(HIDDEN_SECRET));
  assert.doesNotMatch(JSON.stringify(body), /\/data\/private/);
});

test("Graphify publishes only a receipt while a concurrent request gets the named shared-lane cause", async () => {
  const selection = { targetId: "harness", folderId: "h_all" };
  const first = request("POST", selection);
  await new Promise((resolve) => setTimeout(resolve, 25));
  const busy = await request("POST", selection);
  assert.equal(busy.status, 409);
  const busyBody = await busy.json();
  assert.equal(busyBody.code, "AGENT_LANE_BUSY");
  assert.equal(typeof busyBody.error, "string");

  const response = await first;
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.runId, "0123456789abcdef0123456789abcdef");
  assert.deepEqual(body.counts, { files: 2, inputBytes: 123, nodes: 7, links: 9 });
  assert.equal(body.artifacts.html.name.endsWith(".html"), true);
  assert.equal(body.artifacts.markdown.name.endsWith(".md"), true);
  assert.equal(body.snapshot.manifestSha256, "a".repeat(64));
  assert.doesNotMatch(JSON.stringify(body), /graphRaw|privateGraph|sourceRoot|includeRoots|<!doctype|# Graph report|[A-Za-z]:[\\/]|\/data\//);

  const capture = JSON.parse(fs.readFileSync(box.captureFile, "utf8"));
  assert.equal(capture.storeOptions.stateRoot, box.stateRoot);
  assert.equal(capture.storeOptions.artifactsRoot, path.join(box.home, "artifacts"));
  assert.equal(capture.runOptions.plan.sourceRoot, path.join(box.home, "server-owned", "harness"));
  assert.equal(capture.publishOptions.graphRaw, "{\"nodes\":[],\"links\":[]}");
  assert.equal(capture.registryContext.homeDir, box.home);
  assert.equal(capture.resolveContext.homeDir, box.home);
});

test("the Brain reads only the path-free latest private vault projection", async () => {
  assert.equal((await fetch(`${box.base}/brain/api/graph`)).status, 401);
  const response = await request("GET", undefined, "/brain/api/graph");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.graph.snapshot, "b".repeat(64));
  assert.deepEqual(body.graph.nodes.map((node) => node.memoryId), ["memory-a", "memory-b"]);
  assert.equal(body.graph.edges.length, 1);
  assert.deepEqual(Object.keys(body.graph.edges[0]).sort(), ["confidence", "relation", "source", "target"]);
  assert.doesNotMatch(JSON.stringify(body), /Projects\/|vault-a|vault-b|source_file|content|graph\.json|[A-Za-z]:[\\/]|\/data\//);

  const wrongMethod = await request("POST", {}, "/brain/api/graph");
  assert.equal(wrongMethod.status, 405);
  assert.equal((await wrongMethod.json()).code, "BRAIN_GRAPH_METHOD_INVALID");
});

test("invalid selection text is never copied into the protected audit", async () => {
  const canary = "GRAPHIFY_AUDIT_INJECTION_CANARY";
  const response = await request("POST", { targetId: `missing\n${canary}`, folderId: "h_all" });
  assert.equal(response.status, 409);
  const audit = fs.readFileSync(path.join(box.home, ".claude", "agenthost", "audit.log"), "utf8");
  assert.doesNotMatch(audit, new RegExp(canary));
  assert.doesNotMatch(box.stderr(), new RegExp(canary));
});

test("SIGTERM aborts and terminal-proves an active Graphify run before gate exit", {
  skip: process.platform === "win32" ? "Windows does not deliver SIGTERM to the Node shutdown handler" : false,
}, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gate-graphify-shutdown-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const stateRoot = path.join(home, ".agenthost", "graphify");
  const captureFile = path.join(home, "capture.json");
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(home, "artifacts"), { recursive: true });
  const local = bootGate(home, stateRoot, captureFile, path.join(box.home, "graphify-preload.cjs"));
  const base = `http://127.0.0.1:${await local.port}`;
  const cookie = (await mintOperatorSession(base, KEY)).cookie;
  const pending = fetch(`${base}/api/graphify`, {
    method: "POST",
    headers: { cookie, origin: base, "sec-fetch-site": "same-origin", "content-type": "application/json" },
    body: JSON.stringify({ targetId: "harness", folderId: "h_all", operationId: OPERATION_ID }),
  }).catch(() => null);
  const startedBy = Date.now() + 3_000;
  while (Date.now() < startedBy) {
    try {
      if (JSON.parse(fs.readFileSync(captureFile, "utf8")).runOptions) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(JSON.parse(fs.readFileSync(captureFile, "utf8")).runOptions.plan.target.id, "harness");

  const exited = new Promise((resolve) => local.child.once("exit", (code, signal) => resolve({ code, signal })));
  assert.equal(local.child.kill("SIGTERM"), true);
  const terminal = await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error("gate did not exit after Graphify shutdown")), 5_000)),
  ]);
  await pending;
  assert.deepEqual(terminal, { code: 0, signal: null });
  const capture = JSON.parse(fs.readFileSync(captureFile, "utf8"));
  assert.equal(capture.aborted, true);
  assert.equal(capture.publishOptions, undefined, "a cancelled Graphify run must never publish");
});

test("an unproven Graphify stop quarantines the lane without returning secrets or a private path", async () => {
  const response = await request("POST", {
    targetId: `repo:${BROKEN_REPO}`,
    folderId: "f_222222222222222222222222",
  });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.code, "GRAPHIFY_TERMINATION_UNPROVEN");
  assert.match(body.error, /shared agent lane is quarantined until restart/);
  assert.match(body.error, /worker .* did not report a terminal event/,
    "the response must preserve the worker's bounded terminal-proof cause");
  assert.doesNotMatch(body.error, new RegExp(HIDDEN_SECRET));
  assert.doesNotMatch(body.error, new RegExp(SHAPED_SECRET));
  assert.doesNotMatch(body.error, new RegExp(ASSIGNED_SECRET));
  assert.doesNotMatch(body.error, /\/data\/private/);
  assert.match(body.error, /REDACTED|private path/);

  const runBeforeRetry = JSON.parse(fs.readFileSync(box.captureFile, "utf8")).runOptions;
  const retry = await request("POST", { targetId: "harness", folderId: "h_all" });
  assert.equal(retry.status, 409);
  assert.equal((await retry.json()).code, "AGENT_LANE_BUSY");
  assert.deepEqual(JSON.parse(fs.readFileSync(box.captureFile, "utf8")).runOptions, runBeforeRetry,
    "a quarantined retry may re-resolve opaque ids but never starts Graphify");
  const audit = fs.readFileSync(path.join(box.home, ".claude", "agenthost", "audit.log"), "utf8");
  for (const output of [box.stderr(), audit]) {
    assert.doesNotMatch(output, new RegExp(HIDDEN_SECRET));
    assert.doesNotMatch(output, new RegExp(SHAPED_SECRET));
    assert.doesNotMatch(output, new RegExp(ASSIGNED_SECRET));
    assert.doesNotMatch(output, /\/data\/private/);
    assert.match(output, /REDACTED|private path/);
  }
});

test("a normal Graphify failure names its cause without returning an unknown credential assignment", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gate-graphify-generic-failure-"));
  const stateRoot = path.join(home, ".agenthost", "graphify");
  const captureFile = path.join(home, "capture.json");
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(home, "artifacts"), { recursive: true });
  const local = bootGate(home, stateRoot, captureFile, path.join(box.home, "graphify-preload.cjs"), {
    AGENTHOST_GRAPHIFY_GENERIC_FAILURE: "1",
  });
  try {
    const base = `http://127.0.0.1:${await local.port}`;
    const cookie = (await mintOperatorSession(base, KEY)).cookie;
    const response = await fetch(`${base}/api/graphify`, {
      method: "POST",
      headers: { cookie, origin: base, "sec-fetch-site": "same-origin", "content-type": "application/json" },
      body: JSON.stringify({ targetId: "harness", folderId: "h_all", operationId: OPERATION_ID }),
    });
    assert.equal(response.status, 500);
    const result = await response.json();
    assert.equal(result.code, "GRAPHIFY_FAILED");
    assert.match(result.error, /Graphify worker returned/);
    assert.match(result.error, /REDACTED/);
    assert.doesNotMatch(result.error, new RegExp(GENERIC_SECRET));
    assert.doesNotMatch(result.error, /\/data\/private/);
    const audit = fs.readFileSync(path.join(home, ".claude", "agenthost", "audit.log"), "utf8");
    for (const output of [audit, local.stderr()]) {
      assert.doesNotMatch(output, new RegExp(GENERIC_SECRET));
      assert.doesNotMatch(output, /\/data\/private/);
    }
  } finally {
    await stopChild(local.child);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("an unproven Brand worker still removes the separate gate staging copy", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gate-graphify-brand-unproven-"));
  const stateRoot = path.join(home, ".agenthost", "graphify");
  const captureFile = path.join(home, "capture.json");
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(home, "artifacts"), { recursive: true });
  const local = bootGate(home, stateRoot, captureFile, path.join(box.home, "graphify-preload.cjs"), {
    AGENTHOST_GRAPHIFY_BRAND_UNPROVEN: "1",
  });
  try {
    const base = `http://127.0.0.1:${await local.port}`;
    const cookie = (await mintOperatorSession(base, KEY)).cookie;
    const response = await fetch(`${base}/api/graphify`, {
      method: "POST",
      headers: { cookie, origin: base, "sec-fetch-site": "same-origin", "content-type": "application/json" },
      body: JSON.stringify({ targetId: "brand:acme", folderId: "brand_all", operationId: OPERATION_ID }),
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "GRAPHIFY_TERMINATION_UNPROVEN");
    assert.equal(JSON.parse(fs.readFileSync(captureFile, "utf8")).brandCleaned, true);
  } finally {
    await stopChild(local.child);
    fs.rmSync(home, { recursive: true, force: true });
  }
});
