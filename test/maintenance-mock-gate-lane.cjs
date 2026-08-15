"use strict";

// Checklist mock `gate` client: drives the WHOLE governed autonomous lane to its
// TERMINAL state through the production gate-side stack — the real socket
// transport, the real authority client, and the REAL lane module
// (maintenance-autonomous-lane.js: accept → start → stream-to-eof → terminal
// mapping). Where maintenance-mock-gate-full.cjs stops at "worker running", this
// one proves the round trip a real board task takes: the jailed stub engine's
// stdout streams back through work.output.read, the observed exit completes the
// worker, and the lane returns { ranClean: true, text }. Also probes the
// gate-uid 0600 sharp edge (checklist item 1). TEST DOUBLE; never shipped.
//
// Spawned by the harness as uid/gid `gate`. Env: AGENTHOST_MAINT_SOCK,
// AGENTHOST_CONTRACT_DIGEST, AGENTHOST_OP_SESSION, AGENTHOST_REPO,
// AGENTHOST_PROBE_0600 (path to an agent-owned 0600 file).

const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");

const CONTAINER = path.resolve(__dirname, "..", "container");
const protocol = require(path.join(CONTAINER, "maintenance-protocol.js"));
const { createAuthorityClient } = require(path.join(CONTAINER, "maintenance-authority-client.js"));
const { createSocketTransport } = require(path.join(CONTAINER, "maintenance-authority-transport.js"));
const { runGovernedAutonomousTask } = require(path.join(CONTAINER, "maintenance-autonomous-lane.js"));

const SOCKET = process.env.AGENTHOST_MAINT_SOCK || "/run/agenthost/maint.sock";
const CONTRACT_DIGEST = process.env.AGENTHOST_CONTRACT_DIGEST;
const OP_SESSION = process.env.AGENTHOST_OP_SESSION;
const REPO = process.env.AGENTHOST_REPO;
const PROBE = process.env.AGENTHOST_PROBE_0600;
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

  // The REAL lane module, end to end: run.accept + work.start, stream
  // work.output.read to eof, map the terminal work.inspect state.
  const run = { id: "run_1", kind: "board_task", taskId: "task_1", chainId: "chain_1", profileId: "profile_x", repoId: REPO, engine: "claude", summary: "" };
  const res = await runGovernedAutonomousTask({ client, run, objective: "checklist objective", opts: { pollMs: 50, maxWaitMs: 30_000 } });
  out(`LANE ranClean=${res.ranClean} state=${res.workerState} err=${res.error || "none"}`);
  out(`TEXT ${JSON.stringify((res.text || "").trim())}`);

  // Checklist item 1 sharp edge: this process runs as `gate`; an agent-owned
  // 0600 file must be unreadable across the identity split.
  if (PROBE) {
    try { fs.readFileSync(PROBE); out("PROBE0600 readable"); }
    catch (e) { out(`PROBE0600 denied ${e.code}`); }
  }

  out("DONE");
  setInterval(() => {}, 1 << 30); // hold the connection open for the harness
}

main().catch((error) => { out(`ERR ${error && error.code} ${error && error.message}`); process.exit(1); });
