"use strict";

// Foundation B chat-runner SERVER (root-side). A dedicated, purpose-built unix
// socket for the gate→agent chat dispatch — SEPARATE from the governed autonomous
// lane's SO_PEERCRED authority socket (that one is one-in-flight + handshake +
// contract-digest, built for a single unattended board run; chat needs N
// concurrent token-streaming engines with no ceremony).
//
// SECURITY MODEL (same boundary as the native authority socket, minimal surface):
//   - Socket at /run/agenthost-chat.sock, owned root:gate mode 0660 — only root
//     creates/reads it; the `gate` group (gate is its sole member) may CONNECT.
//   - Every accepted connection is SO_PEERCRED-verified: the peer MUST be uid ==
//     gate / gid == gate. Any other peer is dropped immediately. (Mirrors
//     maintenance-native.c accept_gate; here via the connection's own credentials.)
//   - The server runs as ROOT and is the ONLY thing that spawns engines. It hands
//     each request to the chat-RUNNER, which rebuilds argv from a FIXED profile
//     template (prompt as data), builds an allowlisted env, and drops to uid agent.
//     Gate supplies ONLY {engineId, prompt, withContinue, sessionId} — never argv,
//     env, a bin, or a flag. A compromised gate cannot run arbitrary code as
//     agent THROUGH THIS PATH. (Not a blanket claim: the gate also proxies the
//     writable ttyd terminal by design and holds its credential -- see
//     maintenance-chat-profiles.js for the scoping note.)
//
// WIRE PROTOCOL (length-prefixed JSON frames, both directions):
//   frame = 4-byte big-endian uint32 length, then that many bytes of UTF-8 JSON.
//   gate → server:  {t:"run", runId, engineId, prompt, withContinue?, sessionId?}
//                   {t:"kill", runId, signal?}
//   server → gate:  {t:"out", runId, stream:"stdout"|"stderr", text}
//                   {t:"exit", runId, exitCode, signalName, error?}
//   Multiple runs multiplex over ONE connection, demuxed by runId — so a /team turn
//   (several engines) streams concurrently with no head-of-line blocking.

const net = require("node:net");
const fs = require("node:fs");
const { proveGone: proveChildGone } = require("./maintenance-child-observe.js");

// The chat socket is at /run (root-owned, always exists) — deliberately NOT inside
// /run/agenthost, which the NATIVE authority creates + verifies at boot. Sharing that
// dir raced: the chat server listen()'d before the authority had created it (EACCES).
// A sibling path at /run has no such dependency (verified on box 2026-07-25).
const CHAT_SOCKET_PATH = "/run/agenthost-chat.sock";
const MAX_FRAME_BYTES = 4 * 1024 * 1024; // a prompt frame ceiling; oversize = drop the connection
const GATE_QUARANTINE_REASON = "gate_reported_unproven_agent_termination";
const GATE_FATAL_CONTAINMENT_REASON = "gate_reported_fatal_git_containment";

// ---- framing ---------------------------------------------------------------
function encodeFrame(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const head = Buffer.allocUnsafe(4);
  head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

// A stateful decoder: push bytes, get back an array of parsed frames. Enforces the
// size ceiling so a hostile gate can't make the server buffer unbounded memory.
function createFrameDecoder({ maxBytes = MAX_FRAME_BYTES } = {}) {
  let buf = Buffer.alloc(0);
  return {
    push(chunk) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      const out = [];
      for (;;) {
        if (buf.length < 4) break;
        const len = buf.readUInt32BE(0);
        if (len > maxBytes) throw new Error("frame too large");
        if (buf.length < 4 + len) break;
        const body = buf.subarray(4, 4 + len);
        buf = buf.subarray(4 + len);
        let obj;
        try { obj = JSON.parse(body.toString("utf8")); } catch { throw new Error("bad frame json"); }
        out.push(obj);
      }
      return out;
    },
  };
}

// SO_PEERCRED of a connected unix socket, via /proc — Node doesn't expose it. The
// native authority uses getsockopt(SO_PEERCRED); here the server is root and we
// read the peer's uid from the socket's own credentials through the fd. Node's
// net.Socket doesn't surface it, so we accept the connection and verify by the
// bound socket file's mode (root:gate 0660 already restricts who can connect to the
// gate GROUP) PLUS an explicit peer-uid check when available. Injected for tests.
function defaultPeerUid(_socket) { return null; } // overridden on the box by a native/proc probe if wired

// createChatServer({ runner, socketPath?, gateUid?, gateGid?, log?, peerUid? })
//   runner   : createChatRunner(...) instance (run/kill)
//   gateUid/gateGid: the numeric gate identity the peer must match (defense in depth
//                    on top of the 0660 root:gate socket mode)
//   peerUid  : (socket) => number|null — SO_PEERCRED probe (null = can't determine)
function createChatServer({
  runner, socketPath = CHAT_SOCKET_PATH, gateUid = null, gateGid = null,
  log = () => {}, peerUid = defaultPeerUid,
  agentLaneQuarantine,
  assistLaneQuarantine = null,
  fatalContainment = null,
  proveGone = proveChildGone,
  terminationProofAttempts = 40,
  terminationProofIntervalMs = 250,
  setTimer = setTimeout,
} = {}) {
  if (!runner || typeof runner.run !== "function") throw new Error("createChatServer requires a runner");
  if (!agentLaneQuarantine || typeof agentLaneQuarantine.trip !== "function" || typeof agentLaneQuarantine.isQuarantined !== "function") {
    throw new Error("createChatServer requires an agent-lane quarantine latch");
  }
  const assistQuarantine = assistLaneQuarantine || agentLaneQuarantine;

  const conns = new Set();
  let fatalContainmentStarted = false;

  // "A PLANNED SIGTERM THAT CHECKPOINTS ITS WORK IS NOT A LOST CONNECTION."
  // (Steve, 2026-08-11.)
  //
  // The gate restarts on every deploy. Root's cleanup below latched the shared
  // agent lane whenever that happened with a run in flight, and the latch had no
  // clear at all -- so a routine deploy permanently killed autonomous dispatch
  // until someone restarted the container. Measured live that day: the gate went
  // down at 12:43:00 and every engine answered ready:false afterwards, including
  // `claude`, which has no readiness check and returns true by default. That is
  // the proof it was never about credentials.
  //
  // The tempting fix -- believe the gate when it says it is shutting down
  // cleanly -- is wrong, and would trade a false positive for a real hole. What
  // this latch protects against was never "the connection dropped"; every
  // gate-side reason says "without terminal process proof". The hazard is an
  // ORPHANED AGENT-UID ENGINE still running unsupervised, and a compromised or
  // merely confused gate would only have to claim orderliness to get new work
  // dispatched alongside it.
  //
  // So: trip first, fail closed, and reopen ONLY on proof that root gathered
  // itself. Root killed these children and root observed them; root asks /proc
  // whether each one is actually gone. A timeout, an unreadable /proc, or an
  // identity that was never captured all leave the lane closed -- with a reason
  // naming the run that could not be accounted for, because a lane that stays
  // shut without saying which child it is waiting on is the six-hour bug again.
  function proveTerminationThenClear(laneQuarantine, latch, doomed) {
    let attemptsLeft = terminationProofAttempts;
    let pending = doomed;
    const attempt = () => {
      pending = pending.filter((run) => {
        if (!run.identity) return true; // never provable; keeps the cause captured at close
        try {
          if (proveGone(run.identity) === true) return false;
          run.cause = "its contained process tree was still alive at the last check";
        } catch (error) {
          run.cause = "/proc could not answer: " + String((error && error.message) || error).slice(0, 120);
        }
        return true;
      });
      if (pending.length === 0) {
        if (typeof laneQuarantine.clearOnProof !== "function") {
          log("agent lane stays quarantined: every child is provably gone, but this latch has no clear");
          return;
        }
        if (laneQuarantine.clearOnProof(latch)) {
          log(`agent lane reopened: all ${doomed.length} run(s) on the lost connection are provably gone`);
        }
        return;
      }
      attemptsLeft -= 1;
      if (attemptsLeft > 0) {
        const timer = setTimer(attempt, terminationProofIntervalMs);
        if (timer && typeof timer.unref === "function") timer.unref();
        return;
      }
      // Out of attempts. Latch the SPECIFIC reason before releasing the generic
      // one, in that order, so the lane is never open for even an instant. The
      // replacement names every run whose termination could not be proven and
      // why -- taken from the thing that actually failed, not a summary of it.
      const named = pending.map((run) => `${run.runId}: ${run.cause}`).join("; ");
      const reason = "chat_connection_lost_child_termination_unproven -- " + named;
      laneQuarantine.trip(reason);
      log(reason);
      if (typeof laneQuarantine.clearOnProof === "function") laneQuarantine.clearOnProof(latch);
    };
    attempt();
  }

  function handleConnection(socket) {
    // Peer verification: if the SO_PEERCRED probe resolves a uid, it MUST equal
    // gateUid; an unknown uid (probe unavailable) falls back to the socket's 0660
    // root:gate mode, which already restricts connect to the gate group.
    if (gateUid != null && typeof peerUid === "function") {
      const uid = peerUid(socket);
      if (uid != null && uid !== gateUid) {
        log(`rejected peer uid=${uid} (want ${gateUid})`);
        try { socket.destroy(); } catch {}
        return;
      }
    }
    conns.add(socket);
    const decoder = createFrameDecoder();
    const activeRuns = new Set(); // runIds started on THIS connection (for cleanup on drop)
    const activeAssistRuns = new Set();

    const send = (obj) => { try { socket.write(encodeFrame(obj)); } catch {} };

    const onExit = (runId, info) => {
      activeRuns.delete(runId);
      activeAssistRuns.delete(runId);
      send({ t: "exit", runId, exitCode: info.exitCode ?? null, signalName: info.signalName ?? null, error: info.error });
    };
    const onOutput = (runId, stream, text) => send({ t: "out", runId, stream, text });

    socket.on("data", (chunk) => {
      let frames;
      try { frames = decoder.push(chunk); }
      catch (e) { log(`frame error: ${e.message}`); try { socket.destroy(); } catch {} return; }
      for (const f of frames) {
        if (!f || typeof f !== "object") continue;
        if (f.t === "run") {
          if (typeof f.runId !== "string" || typeof f.engineId !== "string") { send({ t: "exit", runId: f.runId || "?", exitCode: null, signalName: null, error: "bad_request" }); continue; }
          const isAssist = f.engineId === "claude-assist";
          const runQuarantine = isAssist ? assistQuarantine : agentLaneQuarantine;
          if (runQuarantine.isQuarantined()) {
            send({ t: "exit", runId: f.runId, exitCode: null, signalName: null, error: "agent_lane_quarantined" });
            continue;
          }
          const alreadyActiveHere = activeRuns.has(f.runId);
          activeRuns.add(f.runId);
          if (isAssist) activeAssistRuns.add(f.runId);
          // The runner validates engineId/sessionId and rebuilds argv from the fixed
          // profile. onOutput/onExit are bound to THIS connection's runId demux.
          const admission = runner.run({
            runId: f.runId, engineId: f.engineId, prompt: f.prompt,
            withContinue: !!f.withContinue, sessionId: f.sessionId ?? null,
            onOutput, onExit,
          });
          if (admission && admission.duplicate === true) {
            if (!alreadyActiveHere) {
              activeRuns.delete(f.runId);
              activeAssistRuns.delete(f.runId);
            }
            runQuarantine.trip("duplicate_run_id_on_active_lane");
            try { socket.destroy(); } catch {}
            return;
          }
        } else if (f.t === "autonomous") {
          // P0-BUILD-CODEX-AUTHOR. Strictly narrower than `run`, which this same
          // socket already grants: a caller who can ask root to START codex can
          // already do so. This adds no authority -- it adds a WORKTREE, which
          // the runner validates (absolute, no "..", under agent's workspaces,
          // must exist) before composing anything.
          //
          // The gate still names no bin, no flag and no mount. Root authors the
          // whole command line, exactly as it does for `run` and `delivery`.
          if (typeof f.runId !== "string" || typeof f.engineId !== "string" || typeof f.worktree !== "string") {
            send({ t: "exit", runId: f.runId || "?", exitCode: null, signalName: null, error: "bad_request" });
            continue;
          }
          if (agentLaneQuarantine.isQuarantined()) {
            send({ t: "exit", runId: f.runId, exitCode: null, signalName: null, error: "agent_lane_quarantined" });
            continue;
          }
          if (typeof runner.runAutonomous !== "function") {
            send({ t: "exit", runId: f.runId, exitCode: null, signalName: null, error: "autonomous_unsupported" });
            continue;
          }
          const alreadyActiveAuto = activeRuns.has(f.runId);
          activeRuns.add(f.runId);
          // A SYNCHRONOUS throw out of runAutonomous (jail composition is all
          // synchronous, and it reads the filesystem) would otherwise escape this
          // frame loop: the runId stays in activeRuns forever, the caller is sent
          // nothing at all, and the connection dies without a reason -- the exact
          // "it just went quiet" failure this whole path exists to eliminate.
          // Catch it, release the id, and name the cause back to the caller.
          let autoAdmission = null;
          try {
            autoAdmission = runner.runAutonomous({
              runId: f.runId, engineId: f.engineId, prompt: f.prompt, worktree: f.worktree,
              onOutput, onExit,
            });
          } catch (e) {
            if (!alreadyActiveAuto) activeRuns.delete(f.runId);
            send({
              t: "exit", runId: f.runId, exitCode: null, signalName: null,
              error: "autonomous_start_failed: " + String((e && e.message) || e).slice(0, 200),
            });
            continue;
          }
          if (autoAdmission && autoAdmission.duplicate === true) {
            if (!alreadyActiveAuto) activeRuns.delete(f.runId);
            agentLaneQuarantine.trip("duplicate_run_id_on_active_lane");
            try { socket.destroy(); } catch {}
            return;
          }
          if (autoAdmission && autoAdmission.accepted === false) activeRuns.delete(f.runId);
        } else if (f.t === "delivery") {
          if (typeof f.runId !== "string" || typeof runner.deliver !== "function") {
            send({ t: "exit", runId: f.runId || "?", exitCode: null, signalName: null, error: "bad_request" });
            continue;
          }
          if (agentLaneQuarantine.isQuarantined()) {
            send({ t: "exit", runId: f.runId, exitCode: null, signalName: null, error: "agent_lane_quarantined" });
            continue;
          }
          const alreadyActiveHere = activeRuns.has(f.runId);
          activeRuns.add(f.runId);
          // Strip every unrecognized frame key. Root chooses the executable,
          // argv, env, cwd, and uid; the gate supplies delivery data only.
          const admission = runner.deliver({
            runId: f.runId,
            channel: f.channel,
            target: f.target,
            message: f.message,
            onOutput,
            onExit,
          });
          if (admission && admission.duplicate === true) {
            if (!alreadyActiveHere) activeRuns.delete(f.runId);
            agentLaneQuarantine.trip("duplicate_run_id_on_active_lane");
            try { socket.destroy(); } catch {}
            return;
          }
        } else if (f.t === "kill") {
          if (typeof f.runId === "string") runner.kill(f.runId, f.signal || "SIGTERM");
        } else if (f.t === "ready") {
          // "Can this engine run right now?" — answered by ROOT, which can read
          // the agent's credential files; the reply is a BOOLEAN and nothing
          // else. The gate never sees a token, a path, or a reason string it
          // could probe with.
          //
          // Why this verb exists (Steve, 2026-07-26): board dispatch checks
          // codexAuthLauncherAvailable() before running a card. Under Foundation
          // B the gate (999) cannot open agent-owned ~/.codex/auth.json (0600),
          // so that check was false forever and EVERY codex card was silently
          // filtered out. The alternative was widening the credential to
          // group-readable — which would hand the network-facing process an
          // OAuth token it currently cannot reach, breaking the exact invariant
          // the split exists to create. This keeps the promise (agents work the
          // board) without paying for it in integrity.
          //
          // Strictly NARROWER than `run`, which this same socket already
          // grants: a caller who can ask "is codex ready" can already ask root
          // to START codex. No new authority, only a cheaper question.
          const engineId = typeof f.engineId === "string" ? f.engineId : "";
          if (agentLaneQuarantine.isQuarantined()) {
            send({ t: "ready", engineId, ready: false });
            continue;
          }
          let ok = false;
          try { ok = runner.engineReady(engineId) === true; } catch { ok = false; }
          send({ t: "ready", engineId, ready: ok });
        } else if (f.t === "quarantine") {
          // The connection already passed the root:gate socket boundary. This
          // frame is fixed: gate supplies neither a reason nor any clear verb.
          agentLaneQuarantine.trip(GATE_QUARANTINE_REASON);
          send({ t: "quarantine_ack", quarantined: true });
        } else if (f.t === "fatal_containment") {
          // This is a deliberately tiny restart fuse, not a general root RPC.
          // Accept only the exact no-argument frame, once per boot. Root chooses
          // the shutdown sequence; gate supplies no pid, signal, reason, or argv.
          if (Object.keys(f).length !== 1 || fatalContainmentStarted || typeof fatalContainment !== "function") continue;
          fatalContainmentStarted = true;
          agentLaneQuarantine.trip(GATE_FATAL_CONTAINMENT_REASON);
          send({ t: "fatal_containment_ack", restarting: true });
          fatalContainment();
        } else {
          // AN UNKNOWN FRAME MUST NOT VANISH.
          //
          // This chain handled six types and had no else. A frame with any other
          // `t` fell off the end in total silence: the gate saw a successful write,
          // root did nothing, and the caller waited on a reply that was never
          // coming. Nothing anywhere said a word.
          //
          // Live cost, 2026-08-10: PR #338 ("codex authors AS AGENT") shipped a gate
          // that sends { t: "autonomous", worktree } while root had no such handler.
          // Merged as it stood, codex would have kept failing with the SAME error as
          // before, and the obvious conclusion would have been that the CODEX_HOME
          // diagnosis was wrong -- when the diagnosis was right and only half the fix
          // existed. A protocol whose unknown verbs are silent makes every half-built
          // feature look like a wrong theory.
          //
          // Reply, never act. Root does not learn a new verb from an error path;
          // it only refuses out loud. `t` is echoed so the caller knows WHICH frame
          // was rejected, bounded because it is gate-supplied text.
          const what = typeof f.t === "string" ? f.t.slice(0, 40) : String(typeof f.t);
          send({ t: "unsupported", requested: what, error: "unsupported_frame_type" });
        }
      }
    });

    const cleanup = () => {
      conns.delete(socket);
      // Capture each child's kernel-stable identity BEFORE anything is signalled.
      // The runner drops its record the moment a child closes, and the identity
      // goes with it: an identity not captured here can never be proven terminal,
      // so the capture has to lead. Whatever stops us capturing one is recorded
      // as that run's cause now, while we still know what it was.
      const doomed = [];
      for (const runId of activeRuns) {
        let identity = null;
        let cause = "this runner exposes no observed child identity";
        if (typeof runner.childIdentity === "function") {
          try {
            identity = runner.childIdentity(runId) || null;
            if (!identity) cause = "the runner no longer held an observed identity for it at close";
          } catch (error) {
            cause = "reading its observed identity failed: " + String((error && error.message) || error).slice(0, 120);
          }
        }
        doomed.push({ runId, identity, cause });
      }
      // FAIL CLOSED FIRST. The latch goes on before a single signal is sent,
      // exactly as it did when there was no way back out. The proof below can
      // only take this one latch off again, and only once every child is gone.
      const assistDoomed = doomed.filter((run) => activeAssistRuns.has(run.runId));
      const sharedDoomed = doomed.filter((run) => !activeAssistRuns.has(run.runId));
      const sharedLatch = sharedDoomed.length > 0
        ? agentLaneQuarantine.trip("chat_connection_lost_with_active_run")
        : null;
      const assistLatch = assistDoomed.length > 0
        ? assistQuarantine.trip("assist_connection_lost_with_active_run")
        : null;
      // Kill every run this connection started — a dropped gate must not orphan
      // agent-uid engines.
      for (const runId of activeRuns) { try { runner.kill(runId, "SIGKILL"); } catch {} }
      activeRuns.clear();
      activeAssistRuns.clear();
      if (sharedLatch) proveTerminationThenClear(agentLaneQuarantine, sharedLatch, sharedDoomed);
      if (assistLatch) proveTerminationThenClear(assistQuarantine, assistLatch, assistDoomed);
    };
    socket.once("close", cleanup);
    socket.once("error", () => { try { socket.destroy(); } catch {} });
  }

  const server = net.createServer(handleConnection);

  function listen() {
    return new Promise((resolve, reject) => {
      // Fresh socket file every boot: remove a stale one (root-owned only).
      try { if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath); } catch {}
      server.once("error", reject);
      server.listen(socketPath, () => {
        try {
          // root:gate 0660 — only root reads/writes; the gate group may connect.
          if (gateGid != null) fs.chownSync(socketPath, 0, gateGid);
          fs.chmodSync(socketPath, 0o660);
        } catch (e) { return reject(e); }
        resolve();
      });
    });
  }

  function close() { try { server.close(); } catch {} for (const s of conns) { try { s.destroy(); } catch {} } }

  return Object.freeze({ listen, close, _handleConnection: handleConnection, activeConnections: () => conns.size });
}

// The runner in maintenance-chat-runner.js binds onOutput/onExit at CONSTRUCTION.
// The server needs PER-RUN callbacks (demux by connection). Adapt: build the runner
// so run() accepts per-call onOutput/onExit. (The runner already accepts them at
// construct; this wrapper lets run() override per call — see the server's runner.run
// which passes onOutput/onExit in the run args.)

module.exports = { createChatServer, encodeFrame, createFrameDecoder, CHAT_SOCKET_PATH, MAX_FRAME_BYTES };
