// Phase 1f Step 4d: the root boot assembly. Builds the ENTIRE Foundation-B
// authority from an injected native boundary + compiled §8 profiles and serves a
// client over a REAL unix socket — the exact composition PID 1 runs at
// activation, proven from one entry point.

import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import protocol from "../container/maintenance-protocol.js";
import { MAINTENANCE_CONTRACT } from "../container/maintenance-contract.js";
import { createProfileCatalog } from "../container/maintenance-profile-catalog.js";
import { createAuthorityClient } from "../container/maintenance-authority-client.js";
import { createSocketTransport } from "../container/maintenance-authority-transport.js";
import bootMod from "../container/maintenance-boot.js";

const { createFoundationBoot } = bootMod;

const SESS = "sha256:" + "c".repeat(64);
const CONN = "conn-1";
const CLOCK = 1_000_000;
const REPO = "repo_" + "a".repeat(16);
const POLICY = { policyVersion: 1, costLimitEnabled: true, costLimitMicros: 10_000_000 };
const LIMITS = { maxExecs: 5, maxLifetimeMs: 3_600_000, maxTokenUnits: 1_000_000, maxHandoffs: 8, maxConsecutiveSamePair: 2, softStopPermille: 800 };

const PROFILE = {
  id: "profile_x", engine: "claude", argvTemplate: ["claude", "-p", "{objective}"],
  runKinds: ["board_task"], repos: [REPO], uid: 10001, gid: 10001, caps: [], supplementaryGroups: [],
  noNewPrivs: true, envAllowlist: ["HOME", "PATH"], credential: "CLAUDE_CODE_OAUTH_TOKEN",
  workspace: "workspaces/board", readOnlyMounts: ["/opt/agenthost"], writableMounts: ["workspaces/board"],
  network: "inference_only", limits: { maxTokenUnits: 1_000_000, maxCostMicros: 5_000_000, maxLifetimeMs: 3_600_000, maxOutputBytes: 1_048_576 },
};
// The activation contract: base contract re-frozen with the compiled profileCatalog.
const CATALOG = createProfileCatalog({ profiles: [PROFILE], profileBindingKey: protocol.profileBindingKey }).catalog;
const CONTRACT_V2 = Object.freeze({ ...MAINTENANCE_CONTRACT, profileCatalog: CATALOG });
const CONTRACT_DIGEST = protocol.contractDigest(CONTRACT_V2);

function fakeNative() {
  const lines = [];
  return {
    readFoundationJournal: () => (lines.length ? Buffer.from(lines.join("\n") + "\n", "utf8") : null),
    appendFoundationJournalLine: (buf) => { const s = buf.toString("utf8"); if (!s) throw new Error("bad line"); lines.push(s); },
  };
}

function withBootedServer(run) {
  return new Promise((resolve, reject) => {
    const sockPath = path.join(os.tmpdir(), `maint-boot-${process.pid}-${Math.floor(CLOCK)}.sock`);
    const boot = createFoundationBoot({
      native: fakeNative(), protocol, contract: CONTRACT_V2, policy: { ...POLICY }, structuralLimits: LIMITS,
      profiles: [PROFILE], spawn: ({ workerRef }) => ({ childRef: "chld_" + workerRef.slice(4) }),
      recoveryDriver: { recover: () => ({ recovery: null, quarantined: false }) }, now: () => CLOCK,
    });
    const server = net.createServer((socket) => boot.serve(socket, { connectionId: CONN, operatorSessionDigest: SESS }));
    server.on("error", reject);
    server.listen(sockPath, () => {
      const cs = net.connect(sockPath);
      cs.on("connect", async () => {
        const client = createAuthorityClient({ transport: createSocketTransport({ socket: cs, protocol }), protocol, contractDigest: CONTRACT_DIGEST, operatorSessionDigest: SESS });
        try { await run(client, boot); resolve(); } catch (e) { reject(e); } finally { cs.destroy(); server.close(); }
      });
      cs.on("error", reject);
    });
  });
}

test("construction fails closed without native / spawn / recoveryDriver / contract", () => {
  assert.throws(() => createFoundationBoot({ protocol, contract: CONTRACT_V2, policy: POLICY, structuralLimits: LIMITS, spawn: () => {}, recoveryDriver: {} }), /native/);
});

test("boot assembles the whole authority and serves a full activation flow over a socket", async () => {
  await withBootedServer(async (client) => {
    // handshake against the re-frozen (profile-bearing) contract digest
    await client.connect();
    assert.match(client.currentEpoch(), /^gw_[0-9a-f]{32}$/);
    // STOP boots engaged (first_secure) -> operator resume
    assert.equal((await client.getStop()).engaged, true);
    assert.equal((await client.resumeStop(1)).engaged, false);
    // accept + launch a jailed worker against the compiled profile binding
    await client.acceptRun({ id: "run_1", kind: "board_task", taskId: "task_1", chainId: "chain_1", profileId: "profile_x", repoId: REPO, workMode: "new", engines: ["claude"], summary: "", nextActions: [], artifacts: [] });
    const started = await client.startWork({ mode: "new", taskId: "task_1", runId: "run_1", chainId: "chain_1", engine: "claude", profileId: "profile_x", repoId: REPO, objective: "do it" });
    assert.equal(started.worker.state, "running");
    // health reports the profile-bearing digest + the compiled profile
    const health = await client.health();
    assert.equal(health.contractDigest, CONTRACT_DIGEST);
    assert.equal(health.profiles[0].id, "profile_x");
    assert.equal(health.profiles[0].available, true);
  });
});
