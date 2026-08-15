// Phase 1f: the gate-side authority composition. Exercises the FULL gate stack
// — connectSocket → real framed socket transport → authority client handshake →
// governed lane — over a real in-process unix socket served by serveConnection,
// against a scripted service. This proves the wiring end to end off the box; the
// only thing not exercised here is the native SO_PEERCRED accept + the `gate`
// identity (both box-only). Also locks the fail-closed branches.

import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const protocol = require("../container/maintenance-protocol.js");
const { serveConnection } = require("../container/maintenance-authority-transport.js");
const { runGovernedViaAuthority, activationContractDigest, bindGovernedRun } = require("../container/maintenance-gate-authority.js");
const { MAINTENANCE_CONTRACT } = require("../container/maintenance-contract.js");
const { buildFoundationProfiles } = require("../container/maintenance-profiles.js");
const { createProfileCatalog } = require("../container/maintenance-profile-catalog.js");
const { repoIdsFrom, repoIdFor } = require("../container/maintenance-repo-id.js");

const DIGEST = "sha256:" + "a".repeat(64);
const RUN = { id: "run_1", taskId: "task_1", chainId: "chain_1", profileId: "board_claude", repoId: "repo_" + "a".repeat(16), engine: "claude", summary: "" };

// A scripted foundation service: answers the dispatcher shape { action, response }
// for each method the governed lane uses. `script` overrides per-method data.
function scriptedService(script = {}, onRequest = () => {}) {
  const reply = (data) => ({ action: "reply", response: { v: 1, ok: true, data } });
  return {
    handle: async (req) => {
      onRequest(req);
      switch (req.method) {
        case "session.open": return reply({ contractDigest: DIGEST, gatewayEpoch: 7, ...(script["session.open"] || {}) });
        case "session.ready": return reply({ ready: true, ...(script["session.ready"] || {}) });
        case "run.accept": return reply({ run: req.params.run });
        case "work.start": return reply({ worker: { ref: "wrk_" + "a".repeat(24), version: 1, state: "running" }, workerHandle: "hdl_" + "b".repeat(24) });
        case "work.output.read": return (script["work.output.read"] || defaultOutput)(req);
        case "work.inspect": return reply({ worker: { ref: "wrk_" + "a".repeat(24), state: script.terminalState || "completed" } });
        default: return { action: "close", code: "UNKNOWN_METHOD" };
      }
    },
  };
  function defaultOutput() { return reply({ chunks: [{ seq: 1, text: "hello box" }], nextSeq: 1, eof: true, truncated: false }); }
}

// Stand up a real unix-socket server running serveConnection per connection, and
// return a connectSocket() the helper can use plus a cleanup().
async function bootServer(service) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-gauth-"));
  const sockPath = process.platform === "win32"
    ? `\\\\.\\pipe\\${path.basename(dir)}-s`
    : path.join(dir, "s.sock");
  let connectionCount = 0;
  const serverSockets = new Set();
  const clientSockets = [];
  const server = net.createServer((socket) => {
    connectionCount += 1;
    serverSockets.add(socket);
    socket.once("close", () => serverSockets.delete(socket));
    serveConnection({ socket, service, protocol });
  });
  await new Promise((r) => server.listen(sockPath, r));
  const connectSocket = () => new Promise((resolve, reject) => {
    const s = net.connect(sockPath);
    s.once("connect", () => {
      clientSockets.push(s);
      resolve(s);
    });
    s.once("error", reject);
  });
  const cleanup = () => new Promise((r) => {
    for (const socket of clientSockets) socket.destroy();
    for (const socket of serverSockets) socket.destroy();
    server.close(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} r(); });
  });
  const stats = {
    connectionCount: () => connectionCount,
    activeConnectionCount: () => serverSockets.size,
    clientSockets: () => [...clientSockets],
  };
  return { connectSocket, cleanup, stats };
}

test("full path: connect → handshake → governed run → completed maps to ranClean", async () => {
  const { connectSocket, cleanup } = await bootServer(scriptedService());
  try {
    const res = await runGovernedViaAuthority({ protocol, contractDigest: DIGEST, run: RUN, objective: "do it", connectSocket });
    assert.equal(res.ranClean, true);
    assert.equal(res.text, "hello box");
    assert.equal(res.workerState, "completed");
    assert.equal(res.terminationProven, true);
  } finally { await cleanup(); }
});

test("two sequential governed runs reuse one connection and handshake without destroying it", async () => {
  let handshakeCount = 0;
  const service = scriptedService({}, (req) => {
    if (req.method === "session.open") handshakeCount += 1;
  });
  const { connectSocket, cleanup, stats } = await bootServer(service);
  try {
    const first = await runGovernedViaAuthority({ protocol, contractDigest: DIGEST, run: RUN, objective: "first", connectSocket });
    const second = await runGovernedViaAuthority({
      protocol,
      contractDigest: DIGEST,
      run: { ...RUN, id: "run_2", taskId: "task_2", chainId: "chain_2" },
      objective: "second",
      connectSocket,
    });
    assert.equal(first.ranClean, true);
    assert.equal(second.ranClean, true);
    assert.equal(stats.connectionCount(), 1);
    assert.equal(handshakeCount, 1);
    assert.equal(stats.activeConnectionCount(), 1);
    assert.equal(stats.clientSockets()[0].destroyed, false);
  } finally { await cleanup(); }
});

test("overlapping governed runs serialize on the persistent authority session", async () => {
  let releaseFirstOutput;
  let signalFirstOutput;
  let blockFirstOutput = true;
  let handshakeCount = 0;
  const firstOutputStarted = new Promise((resolve) => { signalFirstOutput = resolve; });
  const firstOutputReleased = new Promise((resolve) => { releaseFirstOutput = resolve; });
  const service = scriptedService({
    "work.output.read": async () => {
      if (blockFirstOutput) {
        blockFirstOutput = false;
        signalFirstOutput();
        await firstOutputReleased;
      }
      return { action: "reply", response: { v: 1, ok: true, data: { chunks: [{ seq: 1, text: "serialized" }], nextSeq: 1, eof: true, truncated: false } } };
    },
  }, (req) => {
    if (req.method === "session.open") handshakeCount += 1;
  });
  const { connectSocket, cleanup, stats } = await bootServer(service);
  try {
    const firstPending = runGovernedViaAuthority({ protocol, contractDigest: DIGEST, run: RUN, objective: "first", connectSocket });
    await firstOutputStarted;
    const secondPending = runGovernedViaAuthority({
      protocol,
      contractDigest: DIGEST,
      run: { ...RUN, id: "run_concurrent", taskId: "task_concurrent", chainId: "chain_concurrent" },
      objective: "second",
      connectSocket,
    });
    await new Promise((resolve) => setImmediate(resolve));
    releaseFirstOutput();
    const [first, second] = await Promise.all([firstPending, secondPending]);
    assert.equal(first.ranClean, true);
    assert.equal(second.ranClean, true);
    assert.equal(stats.connectionCount(), 1);
    assert.equal(handshakeCount, 1);
  } finally { await cleanup(); }
});

test("a failed terminal worker state is surfaced as not-clean with its text", async () => {
  const { connectSocket, cleanup } = await bootServer(scriptedService({ terminalState: "failed" }));
  try {
    const res = await runGovernedViaAuthority({ protocol, contractDigest: DIGEST, run: RUN, objective: "x", connectSocket });
    assert.equal(res.ranClean, false);
    assert.equal(res.workerState, "failed");
    assert.equal(res.text, "hello box");
    assert.equal(res.terminationProven, true);
  } finally { await cleanup(); }
});

test("a contract-digest mismatch fails closed at the handshake (no run)", async () => {
  const { connectSocket, cleanup, stats } = await bootServer(scriptedService({ "session.open": { contractDigest: "sha256:" + "b".repeat(64) } }));
  try {
    const res = await runGovernedViaAuthority({ protocol, contractDigest: DIGEST, run: RUN, objective: "x", connectSocket });
    assert.equal(res.ranClean, false);
    assert.equal(res.error, "VERSION_MISMATCH");
    assert.equal(res.terminationProven, true);
    assert.equal(stats.clientSockets()[0].destroyed, true);
  } finally { await cleanup(); }
});

test("an unreachable socket fails closed with a coded error, never runs locally", async () => {
  const connectSocket = () => Promise.reject(Object.assign(new Error("no such socket"), { code: "ENOENT" }));
  const res = await runGovernedViaAuthority({ protocol, contractDigest: DIGEST, run: RUN, objective: "x", connectSocket });
  assert.equal(res.ranClean, false);
  assert.equal(res.error, "ENOENT");
  assert.equal(res.terminationProven, true);
});

test("a lost authority connection after work.start cannot claim the worker stopped", async () => {
  let dropNextOutput = true;
  let handshakeCount = 0;
  const service = scriptedService({
    "work.output.read": () => {
      if (dropNextOutput) {
        dropNextOutput = false;
        return { action: "close", code: "TEST_DROP" };
      }
      return { action: "reply", response: { v: 1, ok: true, data: { chunks: [{ seq: 1, text: "recovered" }], nextSeq: 1, eof: true, truncated: false } } };
    },
  }, (req) => {
    if (req.method === "session.open") handshakeCount += 1;
  });
  const { connectSocket, cleanup, stats } = await bootServer(service);
  try {
    const lost = await runGovernedViaAuthority({ protocol, contractDigest: DIGEST, run: RUN, objective: "x", connectSocket });
    const recovered = await runGovernedViaAuthority({
      protocol,
      contractDigest: DIGEST,
      run: { ...RUN, id: "run_3", taskId: "task_3", chainId: "chain_3" },
      objective: "retry",
      connectSocket,
    });
    assert.equal(lost.ranClean, false);
    assert.equal(lost.terminationProven, false);
    assert.equal(recovered.ranClean, true);
    assert.equal(recovered.text, "recovered");
    assert.equal(stats.connectionCount(), 2);
    assert.equal(handshakeCount, 2);
  } finally { await cleanup(); }
});

// --- the two activation derivations: the gate must reproduce PID 1's values ---

test("activationContractDigest reproduces the boot's re-frozen digest exactly", () => {
  const reposEnv = "acme/api, acme/web";
  // Independently recompute the way maintenance-boot-entry.js does it.
  const repos = repoIdsFrom(reposEnv);
  const profiles = buildFoundationProfiles({ repos, workerUid: 10001, workerGid: 10001 });
  const catalog = createProfileCatalog({ profiles, profileBindingKey: protocol.profileBindingKey }).catalog;
  const expected = protocol.contractDigest(Object.freeze({ ...MAINTENANCE_CONTRACT, profileCatalog: catalog }));
  assert.equal(activationContractDigest({ reposEnv }), expected);
  assert.match(activationContractDigest({ reposEnv }), /^sha256:[0-9a-f]{64}$/);
});

test("activationContractDigest is null with no REPOS (nothing to govern)", () => {
  assert.equal(activationContractDigest({ reposEnv: "" }), null);
});

test("bindGovernedRun maps a claude board run to the board_claude profile + a valid repoId", () => {
  const reposEnv = "acme/api, acme/web";
  const bound = bindGovernedRun({ engine: "claude", runId: "run_9", taskId: "task_9", chainId: "chain_9", repo: "acme/api", summary: "do it", reposEnv });
  assert.equal(bound.profileId, "board_claude");
  assert.equal(bound.repoId, repoIdFor("acme/api"));
  assert.equal(bound.engine, "claude");
  assert.equal(bound.id, "run_9");
});

test("bindGovernedRun returns null for an engine with no governed profile (fail-closed to legacy)", () => {
  assert.equal(bindGovernedRun({ engine: "gemini", runId: "r", taskId: "t", chainId: "c", reposEnv: "acme/api" }), null);
  assert.equal(bindGovernedRun({ engine: "claude", runId: "r", taskId: "t", chainId: "c", reposEnv: "" }), null);
});

test("bindGovernedRun keeps the repoId inside the profile's repos when the run names an unknown repo", () => {
  const reposEnv = "acme/api";
  const bound = bindGovernedRun({ engine: "claude", runId: "r", taskId: "t", chainId: "c", repo: "someone/else", reposEnv });
  assert.equal(bound.repoId, repoIdsFrom(reposEnv)[0]);
});
