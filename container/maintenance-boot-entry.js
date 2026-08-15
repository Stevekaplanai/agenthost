"use strict";

// Foundation B activation entry (Phase 1f, Step 4d). entrypoint.sh execs this as
// ROOT ONLY when AGENTHOST_FOUNDATION_B=1 (off by default → this file is never
// run). NOTE: on a container platform (Fly/firecracker, Docker) the PLATFORM's
// init is PID 1 and this runs as a root child of it — the authority invariant is
// uid 0 inside the VM, not literal PID 1 (see maintenance-native.c
// require_root_authority). It assembles the proven pieces into the live root authority and
// runs the accept loop: the root-owned native boundary + the compiled §8
// profiles → the full foundation service per connection → PID 1 serving the
// governed autonomous lane. TWO children (the identity split — see spawn
// builders below): the interactive stack (start.sh as `agent`, unchanged phone
// view) and gate.js directly as the `gate` uid — the only peer the authority
// socket accepts.
//
// FAIL-CLOSED: any assembly fault exits non-zero (the container restarts) — it
// never falls back to an ungoverned launch. require()-safe: the run loop starts
// only when executed as the main script (a load test can require it).
//
// BOX-VERIFIED SEAMS (must be confirmed on the release image + the Step-8 live
// health check, not in the sandbox):
//   1. §8-profile → worker-runtime adaptation (argvTemplate→argv, workspace→
//      worktreeBase). Marked ADAPT below.
//   2. The REPOS→repoId mapping is single-sourced (maintenance-repo-id.js); any
//      future live repoId reference must import it.
//   3. Operator-session digest wiring for live O-class actions comes from the
//      trusted gateway.
//   4. GATE-UID FILE ACCESS: gate.js running as `gate` (not `agent`) must be able
//      to read/write its on-disk state under the agent data home — the /data
//      ownership reconciliation (Phase 1b) governs this; agent-owned 0600 files
//      gate.js reads (e.g. the Hermes dashboard token) are the sharp edge.
//   5. GATE ENV PREP: today start.sh computes env for gate.js in-process (brand,
//      GH token aliases) before its tail exec; under the split gate.js gets
//      PID 1's env instead — confirm gate.js derives what it needs or move the
//      prep into gate.js.
// These are named, not hidden; the boot refuses rather than guesses where it must.

const cp = require("node:child_process");
const path = require("node:path");

const HOME = "/opt/agenthost";
const req = (m) => require(path.join(HOME, m));
const { repoIdsFrom } = require("./maintenance-repo-id.js");

const DATA_HOME = "/data/home/agent";
const PROTECTED_AUTH_STATE_DIR = "/data/agenthost-gate-state/auth";
const AGENT_USER = "agent";
const GATE_USER = "gate";
const WORKTREE_BASE = "/data/maintenance/work"; // root-owned; workers get task-scoped subtrees
const JAIL_UID = Number(process.env.AGENTHOST_WORKER_UID || 10001);
const JAIL_GID = Number(process.env.AGENTHOST_WORKER_GID || 10001);

// Resolve a named user's uid / a named group's gid from /etc/passwd|group (the box
// creates `agent` and `gate` in the Dockerfile; native.c likewise resolves `gate`
// by name). Chat engines drop to `agent`; the chat socket is group-owned by `gate`.
function uidForUser(name, passwd = "/etc/passwd") {
  try { for (const l of require("node:fs").readFileSync(passwd, "utf8").split("\n")) { const p = l.split(":"); if (p[0] === name) return Number(p[2]); } } catch {}
  return null;
}
function gidForGroup(name, group = "/etc/group") {
  try { for (const l of require("node:fs").readFileSync(group, "utf8").split("\n")) { const p = l.split(":"); if (p[0] === name) return Number(p[2]); } } catch {}
  return null;
}
const AGENT_UID = uidForUser("agent") ?? 1001;
const AGENT_GID = gidForGroup("agent") ?? 1001;
const GATE_UID = uidForUser("gate") ?? 999;
function gateGidNumber() { return gidForGroup("gate"); }
let gatePushToken;

function captureGatePushToken(env = process.env) {
  const token = Object.prototype.hasOwnProperty.call(env, "GIT_PUSH_TOKEN")
    ? env.GIT_PUSH_TOKEN
    : undefined;
  delete env.GIT_PUSH_TOKEN;
  return token;
}

// The deployment's repos -> compiled repoIds, via the SINGLE-SOURCE mapping
// (maintenance-repo-id.js) every live consumer must also use — no drift.
function repoIds() { return repoIdsFrom(process.env.REPOS); }

// ADAPT: §8 compiled profile -> worker-runtime profile shape. Carries the
// SECURITY-BEARING policy through (D2 fix): envAllowlist + credential are what the
// runtime uses to build the worker's scrubbed env; dropping them here is what let
// the jailed worker inherit PID 1's whole secret env. network is threaded for the
// (box-side) selective-egress enforcement.
function toRuntimeProfiles(catalog) {
  const out = {};
  for (const p of catalog) {
    out[p.id] = {
      argv: [...p.argvTemplate],           // OBJECTIVE: {objective} placeholder is delivered box-side (worktree/env), not via argv here
      uid: p.uid, gid: p.gid,
      worktreeBase: WORKTREE_BASE,
      worktreeSizeMb: 64,
      envAllowlist: Array.isArray(p.envAllowlist) ? [...p.envAllowlist] : undefined,
      credential: p.credential,
      network: p.network,
    };
  }
  return out;
}

// THE IDENTITY SPLIT (activation topology). The authority socket accepts ONLY a
// direct child of PID 1 running as the `gate` user (maintenance-native.c:
// SO_PEERCRED uid/gid == gate, peer.pid == the recorded child). So PID 1 spawns
// TWO children:
//   agent stack — the SAME setpriv→start.sh drop as today (repos, tmux, ttyd —
//     the interactive phone view, unchanged), with AGENTHOST_SKIP_GATE=1 so
//     start.sh anchors the stack instead of exec'ing gate.js, and touches
//     $HOME/.agenthost/stack-ready when its prep is done.
//   gate — `node gate.js` directly, as the `gate` uid, spawned ONLY after the
//     ready marker appears (preserving today's "gate starts after prep
//     completes" ordering, since today gate.js IS the tail exec of start.sh).
// Argv builders are pure + exported: the setpriv identity flags are the security
// property, so tests pin them exactly.
function agentStackSpawnArgs() {
  return ["--reuid=agent", "--regid=agent", "--init-groups", "--no-new-privs", "/bin/bash", "-p", path.join(HOME, "start.sh")];
}
function gateSpawnArgs() {
  return ["--reuid=gate", "--regid=gate", "--init-groups", "--no-new-privs", "/usr/local/bin/node", "--disable-sigusr1", path.join(HOME, "gate.js")];
}

// GIT_PUSH_TOKEN is withheld here, and this is the whole point of the identity
// split for the Git ladder. Every interactive lane -- tmux, chat, cron, channel
// replies -- runs inside this stack as `agent`, so anything in this env is
// readable by them (same uid: no /proc barrier, no file mode to hide behind).
// The agent KEEPS GITHUB_TOKEN, on purpose, so `gh`, the GitHub MCP, and cloning
// keep working in the operator's terminal; only the push-capable credential is
// held back, and only the gate child receives it (gateEnv, below, inherits it).
// That is what makes "level 3 commits, it cannot push" a true statement instead
// of a claim. See gate.js gitHubToken() and the A2 red-team FAIL doc.
// USER and LOGNAME must be corrected here, not just HOME. setpriv changes the
// uid; it does not rewrite the environment. So without this the stack runs as
// uid agent while still ANNOUNCING itself as root, and every tool that resolves
// its config directory from USER/LOGNAME -- or calls getpwnam($USER) to find a
// home -- lands on /root, which is drwx------ root root. Observed 2026-08-01:
// codex died on /root/.codex/config.toml (exit 1, surfaced as "skipped -- run
// exited 1"), claude's Bash tool hit EACCES on /root/.claude/session-env/, and
// cursor and hermes failed the same way, while the tmux lane -- which does set
// USER=agent -- kept working. HOME alone is not identity.
function agentStackEnv() {
  const env = { ...process.env, HOME: DATA_HOME, USER: AGENT_USER, LOGNAME: AGENT_USER, AGENTHOST_SKIP_GATE: "1" };
  delete env.GIT_PUSH_TOKEN;
  // The agent-side ttyd backend is a permissioned UNIX socket. Only gate.js
  // needs the operator login credential; giving it to this child lets an engine
  // ask /session to mint an operator cookie for itself.
  delete env.TTYD_PASSWORD;
  delete env.gate_push_token_present;
  delete env.gate_push_token_value;
  for (const name of ["BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS", "PS4", "BASH_XTRACEFD"]) delete env[name];
  return env;
}
function spawnAgentStack() {
  return cp.spawn("/usr/bin/setpriv", agentStackSpawnArgs(), {
    stdio: "inherit",
    env: agentStackEnv(),
  });
}

// The recorded authority peer. HOME stays the agent data home for now: gate.js's
// on-disk state lives there and the /data ownership reconciliation (Phase 1b)
// governs what the gate uid may read/write — a named box-verified surface.
// Env prep: today start.sh computes a few things in-process before its tail exec
// of gate.js and the gate inherits them; under the split gate.js gets PID 1's
// env, so faithfully reproduce that derivation here from the SAME deploy inputs
// PID 1 also has (audited by scripts/maintenance-activation-checklist.sh item 2).
// Only AGENTHOST_BRAND needs it — keyed exactly as start.sh keys it, off the
// LEGAL_MODE deploy var (HOME is set below).
function gateEnv({ agentLaneQuarantined = false, pushToken = gatePushToken } = {}) {
  // Same identity rule as agentStackEnv: setpriv changes the uid, never the
  // env, so without these the gate runs as uid gate while still ANNOUNCING
  // itself as root, and every engine it spawns that resolves a home from
  // USER/LOGNAME lands on /root (hermes died on /root/.hermes/.env at wake).
  // HERMES_HOME is pinned outright -- an inherited value must never outrank
  // the data volume, and USER=gate has no usable passwd home to fall back on.
  const env = {
    ...process.env,
    HOME: DATA_HOME,
    USER: GATE_USER,
    LOGNAME: GATE_USER,
    // entrypoint-launcher rebuilds the Foundation process environment from its
    // release allowlist, so entrypoint.sh's derived export cannot cross that
    // boundary. Pin the gate to the protected root-owned auth tree here instead
    // of falling back to the legacy agent-owned directory.
    AGENTHOST_AUTH_STATE_DIR: PROTECTED_AUTH_STATE_DIR,
    // path.posix, not path.join: this is a path INSIDE the Linux container, and
    // path.join takes the separator of whatever machine runs the code. On the box
    // both agree; on a Windows laptop running the suite, path.join yields
    // \data\home\agent\.hermes and the guard below goes red for a reason that has
    // nothing to do with the boot behaviour it is guarding.
    HERMES_HOME: path.posix.join(DATA_HOME, ".hermes"),
  };
  delete env.GIT_PUSH_TOKEN;
  delete env.gate_push_token_present;
  delete env.gate_push_token_value;
  // These variables execute or expose code before gate.js can harden itself.
  // They are never part of the gate contract, so strip them before Node exec.
  for (const name of [
    "NODE_OPTIONS", "NODE_PATH", "NODE_INSPECT_RESUME_ON_START", "NODE_DEBUG", "NODE_DEBUG_NATIVE",
    "GLIBC_TUNABLES", "GCONV_PATH", "LOCPATH", "OPENSSL_CONF", "OPENSSL_MODULES", "OPENSSL_CONF_INCLUDE",
    "BASH_ENV", "ENV", "PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP", "PYTHONINSPECT",
  ]) delete env[name];
  for (const name of Object.keys(env)) if (name.startsWith("LD_")) delete env[name];
  delete env.AGENTHOST_AGENT_LANE_QUARANTINED;
  if (agentLaneQuarantined) env.AGENTHOST_AGENT_LANE_QUARANTINED = "1";
  if (pushToken !== undefined) env.GIT_PUSH_TOKEN = pushToken;
  if (process.env.LEGAL_MODE && !env.AGENTHOST_BRAND) env.AGENTHOST_BRAND = "legal"; // mirrors start.sh §brand
  return env;
}
let activeGateChild = null;
function spawnGate({ agentLaneQuarantined = false } = {}) {
  const child = cp.spawn("/usr/bin/setpriv", gateSpawnArgs(), {
    stdio: "inherit",
    env: gateEnv({ agentLaneQuarantined }),
  });
  activeGateChild = child;
  child.once("exit", () => {
    if (activeGateChild === child) activeGateChild = null;
  });
  return child;
}

// Memory-pressure restart is deliberately a different lane from an ordinary
// gate loss. Stop the authority runner first so it cannot launch a replacement,
// then let the active gate checkpoint its durable stores. The root wrapper
// exits non-zero after that checkpoint (or after a short bounded fallback), so
// Fly restarts the whole machine instead of leaving a half-recovered process
// tree running.
function createMemoryPressureShutdown({
  runner,
  getGateChild,
  exit = (code) => process.exit(code),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  graceMs = 3000,
} = {}) {
  if (!runner || typeof runner.stop !== "function" || typeof getGateChild !== "function") {
    throw new Error("memory-pressure shutdown requires runner.stop and getGateChild");
  }
  let stopping = false;
  let finished = false;
  let timer = null;

  return function memoryPressureShutdown() {
    if (stopping) return;
    stopping = true;
    runner.stop();

    const child = getGateChild();
    const finish = () => {
      if (finished) return;
      finished = true;
      if (timer !== null) clearTimer(timer);
      exit(1);
    };
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      finish();
      return;
    }

    child.once("exit", finish);
    timer = setTimer(finish, graceMs);
    if (timer && typeof timer.unref === "function") timer.unref();
    try {
      if (child.kill("SIGUSR2") === false) finish();
    } catch {
      finish();
    }
  };
}

// Fly signals this root supervisor, not the uid-dropped gate child. Quiesce the
// authority loop first so a gate loss cannot start a replacement, then forward
// the exact platform signal and require the child's exit event as terminal
// proof. This is only the graceful path; abrupt termination is covered by each
// durable store's write-ahead contract.
function createPlatformSignalShutdown({
  runner,
  getGateChild,
  exit = (code) => process.exit(code),
  writeFailure = (message) => process.stderr.write(message),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  graceMs = 25_000,
} = {}) {
  if (!runner || typeof runner.stop !== "function" || typeof getGateChild !== "function") {
    throw new Error("platform shutdown requires runner.stop and getGateChild");
  }
  let stopping = false;
  let finished = false;
  let timer = null;

  return function platformSignalShutdown(signal) {
    if (stopping) return;
    stopping = true;
    const safeSignal = signal === "SIGINT" ? "SIGINT" : "SIGTERM";

    const finish = (code, reason = "") => {
      if (finished) return;
      finished = true;
      if (timer !== null) clearTimer(timer);
      if (code !== 0) {
        const bounded = String(reason || "gate terminal proof unavailable")
          .replace(/[\r\n]+/g, " ")
          .slice(0, 120);
        try { writeFailure(`[maint] FATAL platform ${safeSignal} shutdown failed: ${bounded}\n`); } catch {}
      }
      exit(code);
    };

    try {
      runner.stop();
    } catch (error) {
      finish(1, `root admission did not stop: ${(error && error.message) || error}`);
      return;
    }

    let child;
    try {
      child = getGateChild();
    } catch (error) {
      finish(1, `gate child lookup failed: ${(error && error.message) || error}`);
      return;
    }
    const finishFromChild = (code = child && child.exitCode, childSignal = child && child.signalCode) => {
      if (code === 0) finish(0);
      else finish(1, childSignal
        ? `gate exited from ${childSignal} before graceful checkpoint proof`
        : `gate exited ${code === null ? "without a status" : `with status ${code}`} before graceful checkpoint proof`);
    };
    if (!child) {
      finish(0);
      return;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      finishFromChild();
      return;
    }

    child.once("exit", finishFromChild);
    timer = setTimer(
      () => finish(1, `gate terminal proof timed out after ${graceMs}ms`),
      graceMs,
    );
    if (timer && typeof timer.unref === "function") timer.unref();
    try {
      if (child.kill(safeSignal) === false) {
        if (child.exitCode !== null || child.signalCode !== null) finishFromChild();
        else finish(1, `gate rejected ${safeSignal} forwarding before terminal proof`);
      }
    } catch (error) {
      if (child.exitCode !== null || child.signalCode !== null) finishFromChild();
      else finish(1, `gate ${safeSignal} forwarding failed: ${(error && error.message) || error}`);
    }
  };
}

function installPlatformSignalHandlers(target, platformSignalShutdown) {
  if (!target || typeof target.on !== "function" || typeof platformSignalShutdown !== "function") {
    throw new Error("platform signal handlers require an event target and shutdown callback");
  }
  const onSigterm = () => platformSignalShutdown("SIGTERM");
  const onSigint = () => platformSignalShutdown("SIGINT");
  target.on("SIGTERM", onSigterm);
  target.on("SIGINT", onSigint);
  return Object.freeze({ onSigterm, onSigint });
}

// Poll for the agent stack's ready marker (injected fs/delay → unit-testable).
// Fail-closed on timeout: better a restart loop than a gate booted against a
// half-prepared stack.
async function waitForStackReady({ markerPath = path.join(DATA_HOME, ".agenthost", "stack-ready"), fsMod = require("node:fs"), delay = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = 500, timeoutMs = 600_000, now = Date.now } = {}) {
  const t0 = now();
  for (;;) {
    if (fsMod.existsSync(markerPath)) return true;
    if (now() - t0 > timeoutMs) throw new Error(`agent stack never became ready (no ${markerPath} after ${timeoutMs}ms)`);
    await delay(pollMs);
  }
}

// Bind the autonomous runtime to the same root lease used by chat. A successful
// spawn retains its opaque lease until the runtime reports the containment
// handle's terminal close; only a conclusive no-child error may release early.
function createSharedAgentLaneSpawn({
  agentLaneArbiter,
  spawn,
  proveTerminal = () => false,
  onTerminal = () => {},
} = {}) {
  if (!agentLaneArbiter || typeof agentLaneArbiter.acquire !== "function" ||
      typeof agentLaneArbiter.release !== "function" || typeof agentLaneArbiter.isQuarantined !== "function") {
    throw new Error("shared agent lane requires the root arbiter");
  }
  if (typeof spawn !== "function") throw new Error("shared agent lane requires spawn");
  const leases = new Map();

  function start(args = {}) {
    const workerRef = args.workerRef;
    const lease = agentLaneArbiter.acquire(`work:${workerRef || "unknown"}`);
    if (!lease) {
      const error = new Error(agentLaneArbiter.isQuarantined()
        ? "the root agent lane is quarantined"
        : "the root agent lane is occupied");
      error.code = agentLaneArbiter.isQuarantined() ? "GLOBAL_QUARANTINE" : "LANE_BUSY";
      error.conclusiveNoChild = true;
      throw error;
    }
    try {
      const result = spawn(args);
      leases.set(workerRef, lease);
      return result;
    } catch (error) {
      if (error && error.conclusiveNoChild === true) {
        agentLaneArbiter.release(lease);
      } else {
        agentLaneArbiter.trip("autonomous_spawn_termination_unproven");
      }
      throw error;
    }
  }

  function releaseAfterTerminal(workerRef) {
    const lease = leases.get(workerRef);
    if (!lease) return false;
    if (agentLaneArbiter.release(lease)) {
      leases.delete(workerRef);
      return true;
    }
    agentLaneArbiter.trip("autonomous_lane_release_rejected");
    return false;
  }

  function completeAfterOuterClose(workerRef, info) {
    if (!leases.has(workerRef)) return false;
    let terminalProven = false;
    try { terminalProven = proveTerminal(workerRef) === true; } catch {}
    if (!terminalProven) {
      agentLaneArbiter.trip("autonomous_namespace_terminal_unproven");
      return false;
    }
    try {
      onTerminal(workerRef, info);
    } catch {
      agentLaneArbiter.trip("autonomous_terminal_sink_failed");
      return false;
    }
    return releaseAfterTerminal(workerRef);
  }

  return Object.freeze({ spawn: start, completeAfterOuterClose });
}

async function main() {
  gatePushToken = captureGatePushToken();
  const protocol = req("maintenance-protocol.js");
  const native = require(path.join(HOME, "maintenance-native.node"));
  const { MAINTENANCE_CONTRACT } = req("maintenance-contract.js");
  const { buildFoundationProfiles } = req("maintenance-profiles.js");
  const { createProfileCatalog } = req("maintenance-profile-catalog.js");
  const { createWorkerRuntime } = req("maintenance-worker-runtime.js");
  const { createRecoveryDriver } = req("maintenance-recovery-driver.js");
  const { createMaintenanceStore } = req("maintenance-store.js");
  const { createMaintenanceSupervisor, createAgentLaneArbiter } = req("maintenance-supervisor.js");
  const { createFoundationBoot } = req("maintenance-boot.js");
  const { createAuthorityRunner } = req("maintenance-boot-main.js");
  const { migrateGateState } = req("maintenance-gate-state-migration.js");

  const repos = repoIds();
  if (repos.length === 0) throw new Error("Foundation B activation requires REPOS");
  const policy = { policyVersion: 1, costLimitEnabled: true, costLimitMicros: 10_000_000 };
  const structuralLimits = { maxExecs: 5, maxLifetimeMs: 3_600_000, maxTokenUnits: 1_000_000, maxHandoffs: 8, maxConsecutiveSamePair: 2, softStopPermille: 800 };
  const profiles = buildFoundationProfiles({ repos, workerUid: JAIL_UID, workerGid: JAIL_GID });
  const catalog = createProfileCatalog({ profiles, profileBindingKey: protocol.profileBindingKey }).catalog;
  const contract = Object.freeze({ ...MAINTENANCE_CONTRACT, profileCatalog: catalog });
  // Root must not open a path below the agent-owned HOME: protecting only the
  // final leaf cannot stop an intermediate-directory swap. Emit one bounded
  // structured line to the container log instead. Never throws: a recording
  // failure must not stop the latch from latching.
  const appendRootAudit = (event, detail) => {
    const safeDetail = String(detail || "").replace(/[\r\n]+/g, " ").slice(0, 300);
    const line = JSON.stringify({ t: new Date().toISOString(), event, detail: safeDetail });
    try { process.stderr.write("[agent-lane] " + line + "\n"); } catch {}
  };
  const agentLaneArbiter = createAgentLaneArbiter({
    record: (reason) => appendRootAudit("agent_lane_quarantined_by_root", reason),
    // A lane latch being released is worth reading -- but the message states ONLY
    // what is true. The arbiter tells us whether the lane is STILL held by
    // another latch; it does not know why the clear happened (child-termination
    // proof is the caller's fact, not the arbiter's). So: never claim children
    // were proven gone here, and never say "dispatch is possible again" while a
    // different reason still holds the lane -- that was the Rule-16 lie the whole
    // change exists to stop, reproduced in its own recorder.
    recordClear: (reason, info) => appendRootAudit(
      info && info.stillQuarantined ? "agent_lane_latch_released_by_root" : "agent_lane_reopened_by_root",
      info && info.stillQuarantined
        ? `${reason} -- released, but the lane stays quarantined for another reason`
        : `${reason} -- released; no other latch is held, so dispatch is possible again`),
  });
  // AI Assist is deliberately independent from chat/board/cron admission so a
  // compose helper remains responsive while the team is working. It still has
  // exactly one opaque lease and its own fail-closed quarantine: uncertainty in
  // one Assist run never opens a replacement, but also never freezes the team.
  const assistLaneArbiter = createAgentLaneArbiter({
    record: (reason) => appendRootAudit("assist_lane_quarantined_by_root", reason),
    recordClear: (reason, info) => appendRootAudit(
      info && info.stillQuarantined ? "assist_lane_latch_released_by_root" : "assist_lane_reopened_by_root",
      info && info.stillQuarantined
        ? `${reason} -- released, but the Assist lane stays quarantined for another reason`
        : `${reason} -- released; no other Assist latch is held`),
  });

  // REAL fixed-profile launch/reap (Phase 1d, proven on real Linux), with the
  // captured worker output + observed exit dispatched to the CURRENT service's
  // sinks (one gate connection at a time — the native boundary enforces it — so
  // the latest boot's spool/settle is the active sink; a fresh connection's boot
  // re-subscribes itself).
  const workerEvents = { current: null };
  let autonomousLane = null;
  const runtime = createWorkerRuntime({
    profiles: toRuntimeProfiles(catalog),
    onOutput: (workerRef, text) => { const s = workerEvents.current; if (s) s.onOutput(workerRef, text); },
    onExit: (workerRef, info) => {
      if (autonomousLane) autonomousLane.completeAfterOuterClose(workerRef, info);
    },
  });
  autonomousLane = createSharedAgentLaneSpawn({
    agentLaneArbiter,
    spawn: (args) => runtime.spawn(args),
    proveTerminal: (workerRef) => runtime.proveTerminal(workerRef),
    onTerminal: (workerRef, info) => {
      const s = workerEvents.current;
      if (s) s.onExit(workerRef, info);
    },
  });
  const spawn = (args) => autonomousLane.spawn(args);

  const operatorSessionDigest = null; // set by the trusted gateway once operator-auth lands live (§5 O-class)

  const makeService = ({ connectionId }) => createFoundationBoot({
    native, protocol, contract, policy, structuralLimits, profiles, spawn,
    // Recovery driver is built inside boot over that service's own stores, using
    // the shared runtime's REAL teardown + liveness (Phase 1d, proven on real Linux).
    teardownWorker: (workerRef) => runtime.teardown(workerRef),
    verifyGone: (workerRef) => runtime.proveTerminal(workerRef),
    subscribeWorkerEvents: (sinks) => { workerEvents.current = sinks; },
    globalQuarantine: () => agentLaneArbiter.isQuarantined(),
    now: Date.now,
  }).service;

  const supervisor = createMaintenanceSupervisor({
    native, protocol, createStore: (o) => createMaintenanceStore(o), contract,
    spawnGate, makeService, operatorSessionDigest, agentLaneQuarantine: agentLaneArbiter,
    log: (m) => process.env.MAINT_DEBUG && process.stderr.write(`[maint] ${m}\n`),
  });
  const runner = createAuthorityRunner({ supervisor });
  const memoryPressureShutdown = createMemoryPressureShutdown({
    runner,
    getGateChild: () => activeGateChild,
  });
  const platformSignalShutdown = createPlatformSignalShutdown({
    runner,
    getGateChild: () => activeGateChild,
  });

  // Bring up the interactive stack first (the phone view), wait for its ready
  // marker, THEN start the authority loop (which spawns gate.js as `gate`) —
  // the same ordering today's single exec chain guarantees.
  // Root must never recursively chown/chmod an agent-writable tree while the
  // agent is live. Repair persisted shared state before spawning that uid;
  // agent-side writers preserve the sanctioned group modes for new boot files.
  migrateGateState({ home: DATA_HOME, log: (m) => process.env.MAINT_DEBUG && process.stderr.write(`[maint] gate-state: ${m}\n`) });

  const stack = spawnAgentStack();
  stack.once("exit", (code) => process.stderr.write(`[maint] agent stack exited (${code}) — interactive view down; gate authority continues\n`));
  await waitForStackReady();

  // D1 fix: NOW that the agent stack has written its state (login secret, board
  // DB, 2FA, dashboard token, key panel, file panel), share those trees to the
  // `boxstate` group so gate.js — spawned as the `gate` uid by the authority
  // runner below — can read/write them. Runs post-ready ON PURPOSE: the files
  // must exist so shareEntry chmod's them group-readable in place (setgid alone
  // shares only the GROUP of NEW files, never relaxes an existing 0600 mode —
  // the red-team's D1 finding). Fail-closed: a migration fault rejects out of
  // main() (the container restarts) rather than booting a gate that can't reach
  // its state. Idempotent, so the every-boot re-share is safe and cheap.
  // Chat-runner: the root-side dispatcher that lets gate run chat engines AS AGENT
  // without gate being able to run arbitrary code as agent. Started AFTER the agent
  // stack is ready (its home + creds exist) and BEFORE the authority runner spawns
  // gate below (so gate never races a not-yet-listening chat socket). The engine
  // spawns as agent (JAIL-free: chat needs agent's REAL home, unlike a §8 worker).
  // Fail-open on the chat socket only: if it can't start, gate fails each chat fast
  // (fail-closed client) rather than crash-looping the whole authority — chat being
  // down must not take the board/authority down with it.
  try {
    const { buildChatProfiles } = req("maintenance-chat-profiles.js");
    const { createChatRunner } = req("maintenance-chat-runner.js");
    const { createChatServer } = req("maintenance-chat-server.js");
    // Reuse gate.js's OWN charter helpers so the profiles cannot drift from the real
    // chat invocation (gate.js exports these when required as a module).
    const gateLib = req("gate.js");
    // The charter the agent stack wrote is on the shared boxstate group now; read it
    // the same way gate.js does (team-charter.md next to gate.js), fail-soft to "".
    let charter = "";
    try { charter = require("node:fs").readFileSync(path.join(HOME, "team-charter.md"), "utf8").trim(); } catch {}
    const claudeCharterArgs = gateLib.claudeCharterArgs ? gateLib.claudeCharterArgs(charter) : [];
    // agentSpawnArgsStatic: gate.js agentSpawnArgs with hooks HARDCODED disabled (never
    // read the gate-influenceable AGENT_CHAT_HOOKS). Reproduce it explicitly.
    const agentSpawnArgsStatic = (prompt, withContinue) => {
      const a = ["-p", prompt, "--dangerously-skip-permissions", "--settings", '{"disableAllHooks":true}'];
      if (withContinue) a.push("-c");
      return a;
    };
    const chatProfiles = buildChatProfiles({
      homeDir: DATA_HOME,
      chatCwd: path.join(DATA_HOME, "work"),
      chatBin: "claude",
      charterArgs: claudeCharterArgs,
      agentSpawnArgsStatic,
      withCharter: (prompt) => gateLib.withCharter(charter, prompt),
    });
    const gateGid = gateGidNumber();
    const chatRunner = createChatRunner({
      profiles: chatProfiles,
      secretsPath: process.env.AGENTHOST_BOX_SECRETS_FILE || "/data/agenthost-secrets/secrets.env",
      withCharter: (prompt) => gateLib.withCharter(charter, prompt),
      uid: AGENT_UID, gid: AGENT_GID,
      agentHome: DATA_HOME,
      agentLaneArbiter,
      assistLaneArbiter,
    });
    const chatServer = createChatServer({
      runner: chatRunner,
      gateUid: GATE_UID,
      gateGid,
      agentLaneQuarantine: supervisor.getAgentLaneQuarantine(),
      assistLaneQuarantine: assistLaneArbiter,
      fatalContainment: memoryPressureShutdown,
      log: (m) => process.env.MAINT_DEBUG && process.stderr.write(`[chat] ${m}\n`),
    });
    await chatServer.listen();
    process.stderr.write("[maint] chat-runner socket listening (gate can dispatch engines as agent)\n");
  } catch (e) {
    process.stderr.write(`[maint] WARN chat-runner failed to start (chat will fail-closed per turn): ${(e && e.stack) || e}\n`);
  }

  process.on("SIGUSR2", memoryPressureShutdown);
  // Keep both platform handlers installed for the whole drain. runner.stop()
  // makes runner.run() resolve before the gate's bounded checkpoint finishes;
  // removing a once-listener there would let a second platform signal take
  // Node's default immediate-exit path and bypass terminal proof.
  installPlatformSignalHandlers(process, platformSignalShutdown);
  return await runner.run();
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[maint] FATAL activation fault (fail-closed): ${error && error.stack || error}\n`);
    process.exit(1);
  });
}

module.exports = {
  repoIds,
  toRuntimeProfiles,
  agentStackSpawnArgs,
  gateSpawnArgs,
  waitForStackReady,
  agentStackEnv,
  gateEnv,
  createMemoryPressureShutdown,
  createPlatformSignalShutdown,
  installPlatformSignalHandlers,
  createSharedAgentLaneSpawn,
  captureGatePushToken,
};
