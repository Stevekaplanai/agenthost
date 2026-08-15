"use strict";

// Dormant Foundation-B candidate: the worker runtime adapter (BUILD-PLAN Phase
// 1d). It is the concrete `spawn` the atomic work.start transaction injects,
// bridging the transaction to the real service-created containment + kernel-
// stable child observation:
//   spawn()   -> launch a fixed-profile worker in a private PID + mount
//                namespace with a task-scoped worktree, observe its namespace
//                init as a kernel-stable identity, and return an opaque childRef.
//   alive()   -> verify the exact observed child is still live (reuse-proof).
//   teardown()-> collapse the namespace (reaps the whole tree) and forget it.
//
// The argv comes ONLY from a compiled fixed profile keyed by profileId — there
// is no caller-supplied command. DORMANT: not wired into any boot path;
// activation is the atomic, separately-gated Phase 1f event.

const { launchContainedWithWorktree, teardown, childrenOf } = require("./maintenance-containment.js");
const {
  observeChild: observeChildIdentity,
  verifyAlive: verifyChildAlive,
  proveGone: proveChildGone,
} = require("./maintenance-child-observe.js");

// A blocking sleep so spawn() can synchronously observe the namespace init
// (the work.start transaction calls spawn synchronously and expects either a
// kernel-observed child or a conclusive no-child result).
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Deliver the run objective into a compiled argv by replacing the exact
// `{objective}` argv ELEMENT (never a substring, never a flag) with the
// objective string as its own argument — injection-safe: the objective is one
// argv slot, not shell-interpolated or concatenated. Args without the token are
// unchanged; a missing objective yields an empty string in that slot.
function substituteObjective(argv, objective) {
  if (!Array.isArray(argv)) throw new Error("profile argv must be an array");
  const value = objective == null ? "" : String(objective);
  return argv.map((arg) => (arg === "{objective}" ? value : arg));
}

// A safe minimal env for a jailed worker when a profile declares no explicit
// allowlist — enough to run (PATH/HOME) without carrying any secret.
const DEFAULT_ENV_ALLOWLIST = Object.freeze(["PATH", "HOME", "LANG", "TERM"]);

// Build the worker's scrubbed environment from its compiled §8 profile: ONLY the
// profile's envAllowlist (or the safe default) plus the ONE named credential are
// carried from PID 1's environment; every other secret (ANTHROPIC_API_KEY, the
// GitHub PAT, every ENVF_* repo secret) is dropped. This is the enforcement that
// the frozen profile policy previously only *declared* — without it the jailed
// worker inherited PID 1's entire secret env (the D2 leak). Pure + deterministic:
// unit-tested without Linux.
function scrubbedEnv(profile, source = process.env) {
  const allow = profile && Array.isArray(profile.envAllowlist) && profile.envAllowlist.length
    ? profile.envAllowlist
    : DEFAULT_ENV_ALLOWLIST;
  const out = {};
  for (const key of allow) if (source[key] !== undefined) out[key] = source[key];
  const cred = profile && profile.credential;
  if (cred && source[cred] !== undefined) out[cred] = source[cred];
  return out;
}

// createWorkerRuntime({ profiles, observeTimeoutMs?, onOutput?, onExit? })
//   onOutput(workerRef, text)                  — governed worker stdout/stderr,
//     delivered as it arrives (PID 1 spools it for work.output.read).
//   onExit(workerRef, { exitCode, signalName })— the containment chain finished
//     (fires on stream close, after all output was delivered). The engine's exit
//     status propagates up the unshare -> sh -> setpriv exec chain unchanged.
// Both are optional; without them behavior is exactly as before (output ignored).
function createWorkerRuntime({
  profiles,
  observeTimeoutMs = 1500,
  onOutput = null,
  onExit = null,
  launchContained = launchContainedWithWorktree,
  listChildren = childrenOf,
  observeChild = observeChildIdentity,
  verifyAlive = verifyChildAlive,
  proveGone = proveChildGone,
  teardownContained = teardown,
  sleepSync: sleep = sleepSync,
} = {}) {
  if (!profiles || typeof profiles !== "object") throw new Error("worker runtime requires a compiled profile catalog");
  const workers = new Map(); // workerRef -> { handle, identity }
  const terminalProofs = new Set(); // lets recovery + outer-close consume one proof in either order
  const capture = typeof onOutput === "function" || typeof onExit === "function";

  function spawn({ workerRef, profileId, objective } = {}) {
    const profile = profiles[profileId];
    if (!profile) { const e = new Error("profile unavailable"); e.conclusiveNoChild = true; throw e; }
    const worktree = `${profile.worktreeBase}/${workerRef}`;
    // OBJECTIVE DELIVERY: the run objective reaches the jailed engine as a single
    // argv element (e.g. `claude -p {objective}`) — a fixed, injection-safe
    // substitution (the objective is never concatenated into a flag or shell).
    const argv = substituteObjective(profile.argv, objective);
    // SECURITY (D2 fix): the worker gets a scrubbed env — only its profile's
    // allowlist + the one credential — so no other host secret enters the jail.
    const env = scrubbedEnv(profile);
    // COMPETENCE (D2 fix, red-team follow-up): repoint HOME to the task-scoped
    // worktree — the ONLY tree the worker uid owns/can write. scrubbedEnv carries
    // PID 1's HOME (/data/home/agent), which is agent-owned and unwritable to the
    // jailed uid, so `claude -p` (writes ~/.claude state + ~/.claude.json) would
    // EACCES and the worker couldn't run at all. A guardrail that makes the agent
    // incompetent is a defect of equal severity to the leak — this closes it. The
    // launcher also cd's into the worktree so the worker's cwd is writable too.
    env.HOME = worktree;
    const handle = launchContained({ argv, uid: profile.uid, gid: profile.gid, worktree, sizeMb: profile.worktreeSizeMb || 16, capture, env });
    const child = handle && handle.child;
    if (child && typeof child.on === "function") child.on("error", () => {});
    if (!handle || !Number.isInteger(handle.handlePid) || handle.handlePid <= 0) {
      const e = new Error("containment handle was not created");
      e.conclusiveNoChild = true;
      throw e;
    }

    // Synchronously observe the namespace init (unshare's direct child). If it
    // never appears, tear down but retain uncertainty: cp.spawn already returned
    // a real outer handle, so only a positive namespace absence proof can ever
    // authorize a refund/replacement.
    const deadline = observeTimeoutMs;
    let nsInit = null;
    for (let waited = 0; waited < deadline; waited += 25) {
      const kids = listChildren(handle.handlePid);
      if (kids.length) { nsInit = kids[0]; break; }
      sleep(25);
    }
    if (deadline === 0) {
      const kids = listChildren(handle.handlePid);
      if (kids.length) nsInit = kids[0];
    }
    if (nsInit === null) {
      teardownContained(handle);
      const e = new Error("no child was observed");
      e.terminationUnproven = true;
      e.containmentHandle = handle;
      throw e;
    }
    let identity;
    try {
      identity = observeChild(nsInit);
    } catch (cause) {
      teardownContained(handle);
      const e = new Error("child vanished before observation", { cause });
      e.terminationUnproven = true;
      e.containmentHandle = handle;
      throw e;
    }
    const observedHandle = { ...handle, namespaceIdentity: identity };
    terminalProofs.delete(workerRef);
    workers.set(workerRef, { handle: observedHandle, identity });
    // Wire the sinks only for a successfully observed worker (a failed observe
    // tears the handle down above and never reports a child). Node buffers pipe
    // data internally until a 'data' listener attaches, so output emitted before
    // this point is not lost. 'close' (not 'exit') fires after both stdio
    // streams flushed, so onExit is guaranteed to arrive AFTER the last onOutput.
    if (capture) {
      if (typeof onOutput === "function") {
        if (child.stdout) child.stdout.on("data", (d) => onOutput(workerRef, d.toString("utf8")));
        if (child.stderr) child.stderr.on("data", (d) => onOutput(workerRef, d.toString("utf8")));
      }
      if (typeof onExit === "function") {
        child.once("close", (code, signal) => onExit(workerRef, { exitCode: code, signalName: signal || null }));
      }
    }
    return { childRef: `child_${identity.pid}_${identity.startTime}` };
  }

  function alive(workerRef) {
    const w = workers.get(workerRef);
    return w ? verifyAlive(w.identity) : false;
  }

  function proveTerminal(workerRef) {
    if (terminalProofs.has(workerRef)) return true;
    const w = workers.get(workerRef);
    if (!w) throw new Error("worker terminal proof requires an observed worker");
    if (proveGone(w.identity) !== true) return false;
    workers.delete(workerRef);
    terminalProofs.add(workerRef);
    return true;
  }

  function teardownWorker(workerRef) {
    const w = workers.get(workerRef);
    if (!w) return false;
    return teardownContained(w.handle);
  }

  return Object.freeze({
    spawn,
    alive,
    proveTerminal,
    teardown: teardownWorker,
    count: () => workers.size,
  });
}

module.exports = { createWorkerRuntime, substituteObjective, scrubbedEnv, DEFAULT_ENV_ALLOWLIST };
