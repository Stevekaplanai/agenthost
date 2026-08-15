"use strict";

// Foundation B: the gate-side composition that turns a connected authority
// socket as one persistent sequential session. This is what gate.js reaches for when
// AGENTHOST_FOUNDATION_B=1 — it connects the SO_PEERCRED unix socket to root
// PID 1, runs the version-locked handshake, and drives one unattended run
// through the governed lane (accept → start a jailed worker → stream to eof →
// map the terminal state). Normal completion keeps the session alive; fatal
// connect, handshake, or transport loss destroys and forgets it.
//
// Pure composition over already-proven bricks:
//   maintenance-authority-transport.js  (frame JSON over the stream socket)
//   maintenance-authority-client.js     (handshake, epoch, one-in-flight, methods)
//   maintenance-autonomous-lane.js       (the accept→start→stream→map orchestration)
// The ONE box-only input is the socket itself — injected as connectSocket() so
// every layer above it is unit-tested off the box (test drives it over a real
// in-process unix socket). Production connects /run/agenthost/maint.sock.
//
// FAIL-CLOSED: any connect / handshake / transport / run fault returns not-clean
// with a coded error and NEVER spawns an engine locally — under Foundation B root
// PID 1 is the sole authority for the autonomous lane, so a gate that cannot
// reach it does not run the work itself.
//
// BOX-ONLY PRECONDITION (why the flag cannot yet activate the lane): the native
// listener (maintenance-native.c) accepts ONLY a peer whose uid/gid is the `gate`
// user, but the image today creates only `agent` (Dockerfile) and the boot entry
// drops the gate child to `agent`. Until a `gate` identity exists AND the gate
// child runs as `gate`, connectAuthoritySocket() reaches the socket but the accept
// rejects it (WRONG_UID) — this helper then fail-closes, by design. Resolving that
// identity step is the remaining box-side work before AGENTHOST_FOUNDATION_B=1
// routes real autonomous runs.

const net = require("node:net");
const { createSocketTransport } = require("./maintenance-authority-transport.js");
const { createAuthorityClient } = require("./maintenance-authority-client.js");
const { runGovernedAutonomousTask } = require("./maintenance-autonomous-lane.js");

const SOCKET_PATH = "/run/agenthost/maint.sock"; // must match maintenance-native.c SOCKET_PATH
const WORKER_UID = Number(process.env.AGENTHOST_WORKER_UID || 10001); // mirrors maintenance-boot-entry.js
const WORKER_GID = Number(process.env.AGENTHOST_WORKER_GID || 10001);
const SESSION_FATAL_ERRORS = new Set([
  "UNAUTHORIZED_PEER", "VERSION_MISMATCH", "PROTOCOL_ERROR", "FRAME_TOO_LARGE",
  "TRUNCATED_FRAME", "INFLIGHT_VIOLATION", "UNKNOWN_METHOD", "STALE_EPOCH",
]);

// One scope per socket factory keeps production on one long-lived session while
// giving every injected test seam its own cache and queue. Weak keys ensure a
// completed test's custom factory cannot contaminate another test.
const authoritySessions = new WeakMap();
const authorityQueues = new WeakMap();

// The activated contract digest the gate must PRESENT at the handshake. It is NOT
// maintenance-contract.js's base digest — activation re-freezes the contract with
// the compiled §8 profile catalog (maintenance-boot-entry.js), so the gate must
// reproduce that exact object from the SAME single-source modules and the SAME
// (REPOS, uid/gid) inputs PID 1 used. Computed here, not guessed, so the two sides
// cannot drift. Returns null when the deployment has no REPOS (no profiles to
// compile → nothing to govern). The digest EQUALITY is box-verified at activation.
function activationContractDigest({ reposEnv = process.env.REPOS, workerUid = WORKER_UID, workerGid = WORKER_GID } = {}) {
  const protocol = require("./maintenance-protocol.js");
  const { MAINTENANCE_CONTRACT } = require("./maintenance-contract.js");
  const { buildFoundationProfiles } = require("./maintenance-profiles.js");
  const { createProfileCatalog } = require("./maintenance-profile-catalog.js");
  const { repoIdsFrom } = require("./maintenance-repo-id.js");
  const repos = repoIdsFrom(reposEnv);
  if (repos.length === 0) return null;
  const profiles = buildFoundationProfiles({ repos, workerUid, workerGid });
  const catalog = createProfileCatalog({ profiles, profileBindingKey: protocol.profileBindingKey }).catalog;
  const contract = Object.freeze({ ...MAINTENANCE_CONTRACT, profileCatalog: catalog });
  return protocol.contractDigest(contract);
}

// Build the bound run the governed lane needs, mapping this deployment's values
// to the §8 profile the same way PID 1 froze them:
//   engine → profileId  (the profile whose `engine` matches; null if none — e.g.
//                         gemini/codex/hermes have no profile yet → not governed)
//   repo   → repoId      (repoIdFor(owner/name); falls back to the first configured
//                         repo when the run names none — a single-repo first
//                         activation is the minimal surface, box-verified for multi-repo)
// Returns null when the run cannot be bound (unknown engine, or no repos) — the
// caller then runs the legacy direct-spawn path (fail-closed to today's behavior).
function bindGovernedRun({ engine, runId, taskId, chainId, repo, kind = "board_task", summary = "", reposEnv = process.env.REPOS, workerUid = WORKER_UID, workerGid = WORKER_GID } = {}) {
  const { buildFoundationProfiles } = require("./maintenance-profiles.js");
  const { repoIdsFrom, repoIdFor } = require("./maintenance-repo-id.js");
  const repos = repoIdsFrom(reposEnv);
  if (repos.length === 0 || !engine || !runId || !taskId || !chainId) return null;
  let profiles;
  try { profiles = buildFoundationProfiles({ repos, workerUid, workerGid }); }
  catch { return null; }
  const profile = profiles.find((p) => p.engine === engine);
  if (!profile) return null; // engine has no governed profile → not our lane
  let repoId = null;
  try { repoId = repo ? repoIdFor(repo) : repos[0]; } catch { repoId = repos[0]; }
  if (!profile.repos.includes(repoId)) repoId = repos[0]; // keep the binding inside the profile's repos
  return { id: runId, kind, taskId, chainId, profileId: profile.id, repoId, engine, summary: String(summary || "") };
}

// Production socket factory: connect the unix socket, resolve once open, and
// fail-closed (coded) on any connect error so the caller never hangs.
function connectAuthoritySocket(socketPath = SOCKET_PATH) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = net.connect(socketPath);
    socket.once("connect", () => { settled = true; resolve(socket); });
    socket.once("error", (e) => { if (settled) return; try { socket.destroy(); } catch {} reject(Object.assign(e || new Error("connect failed"), { code: (e && e.code) || "SOCKET_UNAVAILABLE" })); });
  });
}

function queueAuthorityRun(connectSocket, run) {
  const previous = authorityQueues.get(connectSocket) || Promise.resolve();
  const current = previous.then(run, run);
  const tail = current.then(() => undefined, () => undefined);
  authorityQueues.set(connectSocket, tail);
  return current.finally(() => {
    if (authorityQueues.get(connectSocket) === tail) authorityQueues.delete(connectSocket);
  });
}

function sessionMatches(session, { protocol, contractDigest, operatorSessionDigest, now }) {
  return session.protocol === protocol &&
    session.contractDigest === contractDigest &&
    session.operatorSessionDigest === operatorSessionDigest &&
    session.now === now;
}

function destroySocket(socket) {
  try { socket.destroy(); } catch { /* already gone */ }
}

function invalidateAuthoritySession(connectSocket, session) {
  if (authoritySessions.get(connectSocket) === session) authoritySessions.delete(connectSocket);
  destroySocket(session.socket);
}

// runGovernedViaAuthority({ protocol, contractDigest, operatorSessionDigest?,
//   run, objective, opts?, connectSocket?, now? })
//   -> { ranClean, text, workerState, terminationProven, error? }
async function runGovernedViaAuthority({
  protocol, contractDigest, operatorSessionDigest = null,
  run, objective, opts = {}, connectSocket = connectAuthoritySocket, now = Date.now,
} = {}) {
  if (typeof connectSocket !== "function") {
    return { ranClean: false, text: "", workerState: null, terminationProven: true, error: "SOCKET_UNAVAILABLE" };
  }
  return queueAuthorityRun(connectSocket, async () => {
    const config = { protocol, contractDigest, operatorSessionDigest, now };
    let session = authoritySessions.get(connectSocket);
    if (session && (!sessionMatches(session, config) || session.socket.destroyed)) {
      invalidateAuthoritySession(connectSocket, session);
      session = null;
    }

    if (!session) {
      let socket;
      try { socket = await connectSocket(); }
      catch (e) { return { ranClean: false, text: "", workerState: null, terminationProven: true, error: (e && e.code) || "SOCKET_UNAVAILABLE" }; }
      let client;
      try {
        const transport = createSocketTransport({ socket, protocol });
        client = createAuthorityClient({ transport, protocol, contractDigest, operatorSessionDigest, now });
        await client.connect(); // §2.1 version-locked handshake; throws fail-closed on version/digest mismatch
      } catch (e) {
        destroySocket(socket);
        return { ranClean: false, text: "", workerState: null, terminationProven: true, error: (e && e.code) || "HANDSHAKE_FAILED" };
      }
      session = { socket, client, ...config };
      authoritySessions.set(connectSocket, session);
      const invalidate = () => invalidateAuthoritySession(connectSocket, session);
      socket.on("error", invalidate);
      socket.on("close", invalidate);
    }
    let result;
    try {
      result = await runGovernedAutonomousTask({ client: session.client, run, objective, opts, now });
    } catch (e) {
      const error = (e && e.code) || "GOVERNED_RUN_FAILED";
      invalidateAuthoritySession(connectSocket, session);
      return { ranClean: false, text: "", workerState: null, terminationProven: false, error };
    }
    if (result && SESSION_FATAL_ERRORS.has(result.error)) invalidateAuthoritySession(connectSocket, session);
    return result;
  });
}

module.exports = { runGovernedViaAuthority, connectAuthoritySocket, activationContractDigest, bindGovernedRun, SOCKET_PATH };
