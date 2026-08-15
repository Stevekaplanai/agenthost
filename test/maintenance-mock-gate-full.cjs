"use strict";

// Full-authority mock `gate` client for the Phase-1f activation harness. Unlike
// maintenance-mock-gate.cjs (session.* only), this drives the WHOLE governed lane
// through the real gate-side authority client over the maintenance socket:
// connect → getStop → operator resume STOP → accept a run → launch a jailed
// worker. Prints one line per step so the harness can assert. TEST DOUBLE for the
// real gate.js connection path; never shipped, never wired into any boot path.
//
// Spawned by the harness as uid/gid `gate` so the native SO_PEERCRED check
// accepts it. Env: AGENTHOST_MAINT_SOCK, AGENTHOST_CONTRACT_DIGEST,
// AGENTHOST_OP_SESSION, AGENTHOST_REPO.

const net = require("node:net");
const path = require("node:path");

const CONTAINER = path.resolve(__dirname, "..", "container");
const protocol = require(path.join(CONTAINER, "maintenance-protocol.js"));
const { createAuthorityClient } = require(path.join(CONTAINER, "maintenance-authority-client.js"));
const { createSocketTransport } = require(path.join(CONTAINER, "maintenance-authority-transport.js"));

const SOCKET = process.env.AGENTHOST_MAINT_SOCK || "/run/agenthost/maint.sock";
const CONTRACT_DIGEST = process.env.AGENTHOST_CONTRACT_DIGEST;
const OP_SESSION = process.env.AGENTHOST_OP_SESSION;
const REPO = process.env.AGENTHOST_REPO;
const out = (line) => process.stdout.write(line + "\n");

async function main() {
  const socket = net.connect(SOCKET);
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  const client = createAuthorityClient({ transport: createSocketTransport({ socket, protocol }), protocol, contractDigest: CONTRACT_DIGEST, operatorSessionDigest: OP_SESSION });

  await client.connect();
  out(`OPEN ${client.currentEpoch()}`);

  const stop = await client.getStop();
  out(`STOP ${stop.engaged}`);

  const resumed = await client.resumeStop(stop.version);
  out(`RESUME ${resumed.engaged}`);

  await client.acceptRun({ id: "run_1", kind: "board_task", taskId: "task_1", chainId: "chain_1", profileId: "profile_x", repoId: REPO, workMode: "new", engines: ["claude"], summary: "", nextActions: [], artifacts: [] });
  out("ACCEPT ok");

  const started = await client.startWork({ mode: "new", taskId: "task_1", runId: "run_1", chainId: "chain_1", engine: "claude", profileId: "profile_x", repoId: REPO, objective: "activation smoke" });
  out(`START ${started.worker.state}`);

  out("DONE");
  setInterval(() => {}, 1 << 30); // hold the connection open for the harness
}

main().catch((error) => { out(`ERR ${error && error.code} ${error && error.message}`); process.exit(1); });
