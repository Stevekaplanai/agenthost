"use strict";

// Foundation B: the gate-side client for the chat-runner socket. gate (uid 999)
// connects /run/agenthost/chat.sock (root:gate 0660) and asks the ROOT server to
// run one chat engine AS AGENT. gate supplies ONLY {engineId, prompt, withContinue,
// sessionId} — never argv/env/bin/flag — so it cannot run arbitrary code as agent.
//
// The returned object is CHILD-PROCESS SHAPED so every existing gate.js call site
// (streaming lineTransform, usage capture, per-run timeout, kill-on-disconnect)
// works UNCHANGED: it exposes .stdout/.stderr (EventEmitters emitting 'data'
// Buffers), fires 'exit'(code,signal) AND 'close'(code,signal) in that order
// (2 of the 5 sites listen only on 'close'), keeps .exitCode live (null until exit),
// and .kill(sig) sends a kill frame. One socket connection per run keeps the mapping
// trivial and means a run's teardown just destroys its own socket.
//
// FAIL-CLOSED: a connect/frame error emits an immediate error-exit so a chat turn
// shows a fast failure, never a hung cursor.

const net = require("node:net");
const { EventEmitter } = require("node:events");
const { encodeFrame, createFrameDecoder, CHAT_SOCKET_PATH } = require("./maintenance-chat-server.js");

let __runSeq = 0;
function nextRunId(prefix = "chatrun") { return String(prefix) + "_" + Date.now().toString(36) + "_" + (++__runSeq).toString(36); }

// Ask ROOT whether an engine can run right now. Returns a Promise<boolean> and
// nothing more — no token, no path, no reason. Root can read the agent's
// credential files; the gate cannot, and after this it still cannot.
//
// Why (Steve, 2026-07-26): board dispatch gates on codex's saved ChatGPT login.
// Under Foundation B the gate (999) gets EACCES opening agent-owned
// ~/.codex/auth.json (0600), so the check was false forever and EVERY codex
// card was silently filtered out of dispatch. Widening the credential to
// group-readable would have handed the network-facing process an OAuth token --
// the precise thing the identity split prevents. This keeps the promise (the
// agents work the board) without spending the invariant to get it.
//
// FAIL CLOSED, and never wedge the caller: a missing socket, a dead broker, a
// malformed reply, or a slow answer all resolve `false` within the timeout.
// boardTick runs every 30s, so a false here costs one cycle, never a hang.
// Resolves { ready, why } — NEVER a bare boolean, and never rejects.
//
// It used to resolve `false` for all six of: the socket could not be opened, the
// socket errored, root closed before replying, a frame would not decode, the 2s
// timeout elapsed, and root genuinely answering "no". Six causes, one value.
//
// That is not a style complaint. gate.js consumes this as:
//
//   .then((ready) => settle(..., ready === true ? "probe reported ready" : "probe reported not ready"))
//   .catch((e)   => settle(false, "probe failed: " + e.message))
//
// and because this promise never rejects, the .catch branch was DEAD CODE. Every
// transport failure rendered as the sentence "probe reported not ready", which
// asserts something this function cannot actually know: that root was reached and
// said no.
//
// Measured cost, 2026-08-11: every engine on the box was undispatchable for
// hours while the audit log repeated "codex is not dispatchable: probe reported
// not ready". Root was reachable the whole time and codex's credential was
// valid; the agent lane was quarantined and the ready handler short-circuits on
// that before consulting engineReady at all. The one line that would have ended
// it in a minute -- "root answered: not ready" versus "the broker never replied"
// -- could not be written, because the distinction was thrown away here. Same
// disease as the 2026-08-08 stderr incident: the diagnosis existed and was
// discarded at the boundary.
//
// Fail-closed is UNCHANGED: every path below still yields ready:false. The only
// thing that changes is that the reason survives.
function askEngineReady(engineId, { socketPath = CHAT_SOCKET_PATH, connect = null, timeoutMs = 2000 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ready, why) => {
      if (done) return;
      done = true;
      try { sock && sock.destroy(); } catch {}
      resolve({ ready: ready === true, why: String(why || "") });
    };
    const timer = setTimeout(
      () => finish(false, "the broker did not reply within " + timeoutMs + "ms"),
      timeoutMs,
    );
    if (timer.unref) timer.unref();
    let sock;
    try { sock = connect ? connect(socketPath) : net.createConnection(socketPath); }
    catch (e) {
      clearTimeout(timer);
      return finish(false, "the broker socket could not be opened: " + errText(e));
    }
    const decoder = createFrameDecoder();
    sock.on("error", (e) => { clearTimeout(timer); finish(false, "the broker socket errored: " + errText(e)); });
    // Closed before replying. Distinct from an error: root accepted and hung up.
    sock.on("close", () => { clearTimeout(timer); finish(false, "the broker closed the connection before replying"); });
    sock.on("data", (chunk) => {
      let frames = [];
      try { frames = decoder.push(chunk); }
      catch (e) { clearTimeout(timer); return finish(false, "the broker sent a frame that would not decode: " + errText(e)); }
      for (const f of frames) {
        if (f && f.t === "ready" && f.engineId === engineId) {
          clearTimeout(timer);
          // The ONLY branch entitled to say what root thinks, because it is the
          // only one that heard from root.
          return finish(f.ready === true, f.ready === true
            ? "root answered: ready"
            : "root answered: NOT ready (its own checks failed, or the shared agent lane is quarantined -- root does not distinguish these either)");
        }
      }
    });
    sock.on("connect", () => {
      try { sock.write(encodeFrame({ t: "ready", engineId })); }
      catch (e) { finish(false, "the ready frame could not be written: " + errText(e)); }
    });
  });
}
function errText(e) { return String((e && (e.code || e.message)) || e).slice(0, 120); }

// Notify ROOT that gate has lost trustworthy proof of agent termination. The
// frame is intentionally fixed: gate cannot choose a root reason and there is
// no inverse/clear operation. Fail soft so reporting cannot crash the gateway.
function sendFixedRootControl(frame, accepts, {
  socketPath = CHAT_SOCKET_PATH, connect = null, timeoutMs = 2000,
} = {}) {
  return new Promise((resolve) => {
    let done = false;
    let sock = null;
    let timer = null;
    const finish = (ok) => {
      if (done) return;
      done = true;
      if (timer !== null) clearTimeout(timer);
      try { if (sock && !sock.destroyed) sock.destroy(); } catch {}
      resolve(ok === true);
    };
    timer = setTimeout(() => finish(false), timeoutMs);
    if (timer.unref) timer.unref();
    try { sock = connect ? connect(socketPath) : net.createConnection(socketPath); }
    catch { finish(false); return; }
    const decoder = createFrameDecoder();
    sock.once("error", () => finish(false));
    sock.once("close", () => finish(false));
    sock.on("data", (chunk) => {
      let frames;
      try { frames = decoder.push(chunk); } catch { finish(false); return; }
      if (frames.some(accepts)) {
        finish(true);
      }
    });
    sock.once("connect", () => {
      try { sock.write(encodeFrame(frame)); }
      catch { finish(false); }
    });
  });
}

function tripRootAgentLaneQuarantine(options = {}) {
  return sendFixedRootControl(
    { t: "quarantine" },
    (frame) => frame && frame.t === "quarantine_ack" && frame.quarantined === true,
    options,
  );
}

// Credentialed Git can continue only after its PID namespace reports terminal.
// If that proof never arrives, ask root to use the existing controlled shutdown
// path. The frame carries no pid, reason, command, or inverse operation.
function requestRootFatalContainment(options = {}) {
  return sendFixedRootControl(
    { t: "fatal_containment" },
    (frame) => frame && frame.t === "fatal_containment_ack" && frame.restarting === true,
    options,
  );
}

// runViaChatSocket(engineId, prompt, { withContinue, sessionId, stdio, socketPath?, connect? })
//   -> a ChildProcess-shaped object: { stdout, stderr, on/once, exitCode, kill, pid:null, runId }
function runViaChatSocket(engineId, prompt, {
  withContinue = false, sessionId = null,
  socketPath = CHAT_SOCKET_PATH, connect = null,
  requestFrame = null, runIdPrefix = "chatrun", requestedRunId = null,
} = {}) {
  if (requestedRunId !== null
      && (typeof requestedRunId !== "string" || !requestedRunId || requestedRunId.length > 128 || requestedRunId.includes("\0"))) {
    throw new TypeError("requestedRunId must be a non-empty string of at most 128 characters");
  }
  const runId = requestedRunId || nextRunId(runIdPrefix);
  const fake = new EventEmitter();
  fake.stdout = new EventEmitter();
  fake.stderr = new EventEmitter();
  fake.exitCode = null;
  fake.signalCode = null;
  fake.terminationProven = false;
  fake.pid = null;
  fake.runId = runId;

  let settled = false;
  let socket = null;
  let runRequested = false;

  const emitCause = (cause) => {
    const text = String((cause && cause.message) || cause || "").replace(/\s+/g, " ").trim().slice(0, 2048);
    if (text) fake.stderr.emit("data", Buffer.from(text, "utf8"));
  };

  const finish = (code, signal, terminationProven) => {
    if (settled) return; settled = true;
    fake.exitCode = code;
    fake.signalCode = signal || null;
    fake.terminationProven = terminationProven === true;
    // exit THEN close, matching child_process order (sites listen on either).
    fake.emit("exit", code, signal || null);
    fake.emit("close", code, signal || null);
    try { if (socket) socket.destroy(); } catch {}
  };

  fake.kill = (sig) => {
    if (settled) return true;
    if (!runRequested) {
      finish(null, sig || "SIGTERM", true);
      return true;
    }
    try { if (socket && !socket.destroyed) socket.write(encodeFrame({ t: "kill", runId, signal: sig || "SIGTERM" })); } catch {}
    return true;
  };

  const doConnect = connect || (() => net.connect(socketPath));
  try { socket = doConnect(); }
  catch (e) {
    queueMicrotask(() => { emitCause(e); finish(null, null, true); });
    return fake;
  }

  const dec = createFrameDecoder();
  socket.on("connect", () => {
    if (settled) return;
    try {
      // Conservatively treat a successfully queued run frame as potentially
      // launched before write: a synchronous or partial write failure is not
      // proof that root did not receive enough bytes to launch it.
      runRequested = true;
      // requestFrame selects the ROOT verb. It carries PARAMETERS only -- never a
      // bin, a flag or a mount -- because root authors every command line it runs.
      //
      // A frame that NAMES its own type (anything but "delivery") is forwarded
      // as-is, so a new root verb costs no client edit. `autonomous`
      // (P0-BUILD-CODEX-AUTHOR) is the first: it adds a worktree PATH, which root
      // validates before composing anything.
      //
      // engineId and prompt are seeded from this call's own arguments because
      // gate.js passes them positionally and names only the worktree in the frame;
      // without the seed the frame would arrive at root missing two required
      // fields and be refused as bad_request. The frame may still override them,
      // and runId is stamped LAST because the client owns it and nothing on the
      // wire may rename a live run.
      socket.write(encodeFrame(
        requestFrame && typeof requestFrame.t === "string" && requestFrame.t !== "delivery"
          ? { engineId, prompt, ...requestFrame, runId }
          : requestFrame
            ? { t: "delivery", runId, channel: requestFrame.channel, target: requestFrame.target, message: requestFrame.message }
            : { t: "run", runId, engineId, prompt, withContinue: !!withContinue, sessionId: sessionId ?? null }));
    } catch (e) {
      emitCause(e);
      finish(null, null, !runRequested);
    }
  });
  socket.on("data", (chunk) => {
    let frames;
    try { frames = dec.push(chunk); }
    catch (e) { emitCause("root agent runner sent an unreadable response: " + String((e && e.message) || e)); finish(null, null, !runRequested); return; }
    for (const f of frames) {
      if (!f || f.runId !== runId) continue;
      if (f.t === "out") {
        const emitter = f.stream === "stderr" ? fake.stderr : fake.stdout;
        emitter.emit("data", Buffer.from(String(f.text || ""), "utf8"));
      } else if (f.t === "exit") {
        if (f.error) emitCause(f.error);
        finish(f.exitCode ?? null, f.signalName ?? null, true);
      }
    }
  });
  // A lost broker connection ends the local proxy, but if the run request may
  // have reached root it does NOT prove the root-side child exited.
  socket.once("error", (e) => { emitCause(e); finish(null, null, !runRequested); });
  socket.once("close", () => finish(fake.exitCode, fake.signalCode, !runRequested));

  return fake;
}

function runChannelDeliveryViaChatSocket(channel, target, message, options = {}) {
  return runViaChatSocket(null, null, {
    ...options,
    requestFrame: { channel, target, message },
    runIdPrefix: "delivery",
  });
}

module.exports = { runViaChatSocket, runChannelDeliveryViaChatSocket, askEngineReady, tripRootAgentLaneQuarantine, requestRootFatalContainment, nextRunId };
