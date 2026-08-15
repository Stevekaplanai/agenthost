"use strict";

// Mock `gate` client for the Phase-1a supervisor harness. It performs the
// client half of the version-locked handshake against the root supervisor over
// the maintenance socket, reporting each step on stdout so the harness can
// assert. It is a TEST DOUBLE for the real gate.js connection path — never
// shipped, never wired into any boot path.
//
// Spawned by the harness as uid/gid `gate` so the native SO_PEERCRED check
// accepts it. Prints: "OPEN <gatewayEpoch> <state>", "READY <state>",
// "HB <serviceSeq> <state>", "DONE"; or "ERR <stage> <detail>" on failure.

const net = require("node:net");
const crypto = require("node:crypto");
const path = require("node:path");

const CONTAINER = path.resolve(__dirname, "..", "container");
const protocol = require(path.join(CONTAINER, "maintenance-protocol.js"));
const { MAINTENANCE_CONTRACT } = require(path.join(CONTAINER, "maintenance-contract.js"));

const SOCKET = process.env.AGENTHOST_MAINT_SOCK || "/run/agenthost/maint.sock";
const contractDigest = protocol.contractDigest(MAINTENANCE_CONTRACT);
const rid = () => "req_" + crypto.randomBytes(16).toString("hex");

function out(line) {
  process.stdout.write(line + "\n");
}

// Read exactly one length-prefixed response frame from the socket.
function makeFrameReader(socket) {
  let buffer = Buffer.alloc(0);
  const waiters = [];
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    deliver();
  });
  function deliver() {
    while (buffer.length >= 4) {
      const len = buffer.readUInt32BE(0);
      if (buffer.length < len + 4) return;
      const payload = buffer.subarray(4, len + 4);
      buffer = buffer.subarray(len + 4);
      const waiter = waiters.shift();
      if (waiter) waiter(JSON.parse(payload.toString("utf8")));
    }
  }
  return () => new Promise((resolve) => { waiters.push(resolve); deliver(); });
}

function request(socket, envelope) {
  socket.write(protocol.encodeFrame(envelope, { maxBytes: protocol.REQUEST_MAX_BYTES }));
}

async function main() {
  const socket = net.connect(SOCKET);
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const nextFrame = makeFrameReader(socket);

  // 1. session.open (gateway epoch is null).
  request(socket, {
    v: 1,
    gatewayEpoch: null,
    requestId: rid(),
    deadlineMs: 2000,
    method: "session.open",
    params: { protocolVersion: 1, contractDigest },
  });
  const opened = await nextFrame();
  if (!opened.ok) return out(`ERR open ${opened.code}`), process.exit(1);
  const gatewayEpoch = opened.gatewayEpoch;
  out(`OPEN ${gatewayEpoch} ${opened.data.state}`);

  // 2. session.ready.
  request(socket, {
    v: 1,
    gatewayEpoch,
    requestId: rid(),
    deadlineMs: 5000,
    method: "session.ready",
    params: { contractDigest },
  });
  const ready = await nextFrame();
  if (!ready.ok) return out(`ERR ready ${ready.code}`), process.exit(1);
  out(`READY ${ready.data.state}`);

  // 3. session.heartbeat.
  request(socket, {
    v: 1,
    gatewayEpoch,
    requestId: rid(),
    deadlineMs: 2000,
    method: "session.heartbeat",
    params: { lastServiceSeq: 0 },
  });
  const beat = await nextFrame();
  if (!beat.ok) return out(`ERR heartbeat ${beat.code}`), process.exit(1);
  out(`HB ${beat.data.serviceSeq} ${beat.data.state}`);

  out("DONE");
  // Stay connected so the supervisor's active connection persists until the
  // harness decides to end it (gate-loss test).
  setInterval(() => {}, 1 << 30);
}

main().catch((error) => {
  out(`ERR fatal ${error && error.message}`);
  process.exit(1);
});
