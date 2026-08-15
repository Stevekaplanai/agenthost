"use strict";

// Dormant Foundation-B candidate: service-created worker containment (BUILD-PLAN
// Phase 1d; ROOT-SERVICE-STATE-MACHINES §9). PID 1 launches each governed worker
// inside a service-created PID namespace as `agent`, so a hostile descendant
// cannot escape teardown with fork, double-fork, or setsid: killing the
// namespace init collapses the whole tree. The launcher retains the containment
// handle (the ns-holding process) and proves descendant absence on teardown.
//
// DORMANT: not wired into any boot path; activation is the atomic,
// separately-gated Phase 1f event. This is the physical spawn the work.start
// transaction injects. It exposes no arbitrary command surface to callers — the
// argv comes only from a compiled fixed profile.

const cp = require("node:child_process");
const fs = require("node:fs");
const { observeChild: observeChildIdentity } = require("./maintenance-child-observe.js");

// Launch `argv` as (uid,gid) inside a fresh PID + mount namespace whose init is
// killed if the handle dies (--kill-child). Returns the containment handle (the
// outer-visible pid holding the namespace). The caller supplies argv only from a
// compiled profile; there is no shell.
function launchContained({ argv, uid, gid } = {}) {
  if (!Array.isArray(argv) || argv.length === 0) throw new Error("launchContained requires a non-empty argv");
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) throw new Error("launchContained requires numeric uid/gid");
  const child = cp.spawn(
    "unshare",
    ["--pid", "--mount", "--fork", "--mount-proc", "--kill-child", "--",
      "setpriv", `--reuid=${uid}`, `--regid=${gid}`, "--clear-groups", "--", ...argv],
    { stdio: "ignore" },
  );
  return { handlePid: child.pid, child };
}

// The direct children of `pid` in this namespace's /proc (used to find the
// namespace init that `unshare --fork` created).
function childrenOf(pid) {
  const kids = [];
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const m = fs.readFileSync(`/proc/${entry}/status`, "utf8").match(/^PPid:\s*(\d+)/m);
      if (m && Number(m[1]) === pid) kids.push(Number(entry));
    } catch { /* gone */ }
  }
  return kids;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Chat-tier containment: preserve the agent's real HOME, cwd, filesystem,
// network, and supplementary groups while putting the entire engine tree in a
// fresh PID namespace. The mount namespace exists only so that namespace-local
// /proc can be mounted; no workspace mount or network namespace is created.
function launchProcessTreeContained({
  argv, uid, gid, cwd, env, stdin = "ignore",
  spawn = cp.spawn,
  childrenOf: listChildren = childrenOf,
  observeChild = observeChildIdentity,
  sleepSync: sleep = sleepSync,
  observeTimeoutMs = 1500,
} = {}) {
  if (!Array.isArray(argv) || argv.length === 0) throw new Error("launchProcessTreeContained requires a non-empty argv");
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) throw new Error("launchProcessTreeContained requires numeric uid/gid");
  if (typeof cwd !== "string" || !cwd.startsWith("/")) throw new Error("launchProcessTreeContained requires an absolute cwd");
  if (!env || typeof env !== "object" || Array.isArray(env)) throw new Error("launchProcessTreeContained requires an env object");
  // "pipe" exists so a caller can hand the engine its prompt over stdin instead
  // of argv. Argv is world-readable in a process list and OS-capped, so any
  // prompt built from attacker-controlled text -- website copy, in Brand DNA's
  // case -- must not travel there.
  if (stdin !== "ignore" && stdin !== "inherit" && stdin !== "pipe") {
    throw new Error("launchProcessTreeContained requires ignore, inherit or pipe stdin");
  }

  let child;
  try {
    child = spawn(
      "unshare",
      [
        "--pid", "--mount", "--fork", "--mount-proc", "--kill-child", "--",
        "setpriv", `--reuid=${uid}`, `--regid=${gid}`, "--init-groups", "--no-new-privs", "--",
        ...argv,
      ],
      {
        cwd,
        env,
        stdio: [stdin, "pipe", "pipe"],
      },
    );
  } catch (error) {
    error.conclusiveNoChild = true;
    throw error;
  }
  if (child && typeof child.on === "function") child.on("error", () => {});
  if (!child || !Number.isInteger(child.pid) || child.pid <= 0) {
    const error = new Error("containment handle was not created");
    error.conclusiveNoChild = true;
    throw error;
  }

  const handle = { handlePid: child.pid, child };
  let namespaceInit = null;
  for (let waited = 0; waited <= observeTimeoutMs; waited += 25) {
    const children = listChildren(handle.handlePid);
    if (children.length > 0) {
      namespaceInit = children[0];
      break;
    }
    if (waited < observeTimeoutMs) sleep(25);
  }
  if (namespaceInit === null) {
    teardown(handle);
    const error = new Error("namespace init was not observed");
    error.terminationUnproven = true;
    error.containmentHandle = handle;
    throw error;
  }

  try {
    return {
      ...handle,
      namespaceIdentity: observeChild(namespaceInit),
    };
  } catch (cause) {
    teardown(handle);
    const error = new Error("namespace init vanished before observation", { cause });
    error.terminationUnproven = true;
    error.containmentHandle = handle;
    throw error;
  }
}

// DeepSeek's outer jail uses Debian's setuid Bubblewrap. Applying
// --no-new-privs before execing bwrap disables jail creation. This fixed-purpose
// launcher accepts Bubblewrap ARGUMENTS, never an executable, and invokes exact
// /usr/bin/bwrap as root. The in-jail bridge stays root so an agent-UID peer
// cannot read its bearer through /proc; that bridge drops only the DSH child to
// agent with no-new-privs after the filesystem/network jail exists. There is no
// generic boolean another caller can use to weaken the normal launcher.
function launchSetuidBwrapProcessTreeContained({
  bwrapArgs, sourceFds = [], uid, gid, cwd, env, stdin = "ignore",
  spawn = cp.spawn,
  childrenOf: listChildren = childrenOf,
  observeChild = observeChildIdentity,
  sleepSync: sleep = sleepSync,
  observeTimeoutMs = 1500,
} = {}) {
  if (!Array.isArray(bwrapArgs) || bwrapArgs.length === 0
      || bwrapArgs.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
    throw new Error("launchSetuidBwrapProcessTreeContained requires non-empty string bwrapArgs");
  }
  if (!Array.isArray(sourceFds) || sourceFds.length > 16
      || sourceFds.some((fd) => !Number.isSafeInteger(fd) || fd < 0)) {
    throw new Error("launchSetuidBwrapProcessTreeContained requires numeric sourceFds");
  }
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) {
    throw new Error("launchSetuidBwrapProcessTreeContained requires numeric uid/gid");
  }
  if (typeof cwd !== "string" || !cwd.startsWith("/")) {
    throw new Error("launchSetuidBwrapProcessTreeContained requires an absolute cwd");
  }
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    throw new Error("launchSetuidBwrapProcessTreeContained requires an env object");
  }
  if (stdin !== "ignore" && stdin !== "inherit" && stdin !== "pipe") {
    throw new Error("launchSetuidBwrapProcessTreeContained requires ignore, inherit or pipe stdin");
  }

  let child;
  try {
    child = spawn(
      "unshare",
      [
        "--pid", "--mount", "--fork", "--mount-proc", "--kill-child", "--",
        "/usr/bin/bwrap", ...bwrapArgs,
      ],
      {
        cwd,
        env,
        // Each supplied directory descriptor is duplicated to child fd 3+n.
        // buildBwrapReadJail uses --bind-fd, so a hostile rename after admission
        // cannot redirect the writable workspace grant.
        stdio: [stdin, "pipe", "pipe", ...sourceFds],
      },
    );
  } catch (error) {
    error.conclusiveNoChild = true;
    throw error;
  }
  if (child && typeof child.on === "function") child.on("error", () => {});
  if (!child || !Number.isInteger(child.pid) || child.pid <= 0) {
    const error = new Error("dsh_containment_handle_not_created");
    error.conclusiveNoChild = true;
    throw error;
  }

  let launcherStderr = "";
  if (child.stderr && typeof child.stderr.on === "function") {
    child.stderr.on("data", (chunk) => {
      if (launcherStderr.length >= 2048) return;
      launcherStderr += String(chunk).slice(0, 2048 - launcherStderr.length);
    });
  }
  const launcherFailureCause = () => {
    const safe = launcherStderr
      .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
      .replace(/\/run\/agenthost-dsh\/[a-f0-9]{40}\.sock/gi, "[relay socket]")
      .replace(/\/data\/home\/agent\/workspaces\/[^\s'\"]+/g, "[private worktree]")
      .replace(/[^\x20-\x7e\r\n\t]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    return safe.slice(0, 240);
  };

  const handle = { handlePid: child.pid, child };
  let namespaceInit = null;
  for (let waited = 0; waited <= observeTimeoutMs; waited += 25) {
    const children = listChildren(handle.handlePid);
    if (children.length > 0) {
      namespaceInit = children[0];
      break;
    }
    if (waited < observeTimeoutMs) sleep(25);
  }
  if (namespaceInit === null) {
    teardown(handle);
    const error = new Error("dsh_namespace_init_not_observed");
    error.terminationUnproven = true;
    error.containmentHandle = handle;
    error.launcherFailureCause = launcherFailureCause;
    throw error;
  }
  try {
    return { ...handle, namespaceIdentity: observeChild(namespaceInit) };
  } catch (cause) {
    teardown(handle);
    const error = new Error("dsh_namespace_init_vanished", { cause });
    error.terminationUnproven = true;
    error.containmentHandle = handle;
    error.launcherFailureCause = launcherFailureCause;
    throw error;
  }
}

// POSIX single-quote a token for safe inclusion in the root setup shell.
function shq(token) { return "'" + String(token).replace(/'/g, "'\\''") + "'"; }

// Launch a contained worker with a private, task-scoped writable worktree: in
// the fresh mount + PID namespace, as root, make propagation private, mount a
// size-capped tmpfs at `worktree`, hand it to the worker, then drop to
// (uid,gid) and exec argv. The worktree's CONTENT lives only inside the mount
// namespace — it never appears on the host and vanishes when the namespace is
// torn down. (The real launcher resolves `worktree` beneath a trusted directory
// handle without symlinks; here it is a fixed path for the proof.)
function launchContainedWithWorktree({ argv, uid, gid, worktree, sizeMb = 16, capture = false, env = null } = {}) {
  if (!Array.isArray(argv) || argv.length === 0) throw new Error("requires a non-empty argv");
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) throw new Error("requires numeric uid/gid");
  if (typeof worktree !== "string" || !worktree.startsWith("/")) throw new Error("requires an absolute worktree path");
  const setup =
    "mount --make-rprivate / 2>/dev/null; " +
    `mkdir -p ${shq(worktree)} && ` +
    `mount -t tmpfs -o size=${Number(sizeMb)}m,mode=0700 tmpfs ${shq(worktree)} && ` +
    `chown ${uid}:${gid} ${shq(worktree)} && ` +
    // cd into the worktree so the worker's cwd is the ONE tree it can write (its
    // HOME is repointed here too by the runtime) — otherwise cwd is `/`, unwritable
    // to the jailed uid, and the engine can't scribble its working files. Paired
    // with the D2 HOME repoint in maintenance-worker-runtime.js.
    `cd ${shq(worktree)} && ` +
    // --no-new-privs on the worker exec (matches the agent/gate spawns): the
    // jailed engine can never gain privileges via a setuid bit. The profile
    // declares noNewPrivs:true; this is where it's enforced on the live path.
    `exec setpriv --reuid=${uid} --regid=${gid} --clear-groups --no-new-privs -- ${argv.map(shq).join(" ")}`;
  // capture: pipe the worker's stdout+stderr back to the caller (they flow up the
  // unshare -> sh -> setpriv exec chain unchanged) so PID 1 can spool governed
  // output. Default stays "ignore" (the escape-proof harnesses don't read output).
  //
  // env: the SCRUBBED child environment (allowlist + the one credential), built by
  // the worker runtime from the §8 profile. setpriv does not clear env, so this env
  // propagates unshare -> sh -> setpriv -> the worker verbatim — it is the ONLY way
  // the worker's env is bounded. When null (the escape-proof harnesses, which run
  // secret-free stubs) the child inherits PID 1's env as before. The governed
  // runtime ALWAYS passes a scrubbed env, so no host secret reaches a real worker.
  const opts = { stdio: capture ? ["ignore", "pipe", "pipe"] : "ignore" };
  if (env) opts.env = env;
  const child = cp.spawn(
    "unshare",
    ["--pid", "--mount", "--fork", "--mount-proc", "--kill-child", "--", "sh", "-c", setup],
    opts,
  );
  return { handlePid: child.pid, child };
}

// Tear down a containment handle. PID 1 SIGKILLs the namespace INIT directly
// (unshare's forked child); when a PID namespace's init dies the kernel reaps
// every remaining process in that namespace — including a double-fork+setsid
// escapee. It then reaps the unshare handle itself.
//
// NOTE (Phase-1d finding): do NOT rely on `unshare --kill-child`
// (PR_SET_PDEATHSIG) for teardown — the kernel CLEARS pdeathsig when `setpriv`
// drops the worker's uid, so a handle-death signal never reaches the ns init.
// Directly killing the retained ns init is the reliable mechanism.
function teardown(handle, {
  listChildren = childrenOf,
  kill = process.kill,
  sleepSync: sleep = sleepSync,
  reapWaitMs = 1500,
} = {}) {
  if (!handle || !Number.isInteger(handle.handlePid)) return false;
  let namespaceInits;
  try { namespaceInits = listChildren(handle.handlePid); } catch { return false; }
  if (namespaceInits.length === 0) {
    try { kill(handle.handlePid, "SIGKILL"); } catch { /* already gone */ }
    return false;
  }
  for (const nsInit of namespaceInits) {
    try { kill(nsInit, "SIGKILL"); } catch { /* already gone */ }
  }
  // Keep the unshare parent alive while it waitpid()s the namespace init. Killing
  // both back-to-back strands the init as an unreaped /proc entry, so strict
  // proveGone() correctly refuses to release the shared root lane.
  for (let waited = 0; waited <= reapWaitMs; waited += 25) {
    let remaining;
    try { remaining = listChildren(handle.handlePid); } catch { return false; }
    if (remaining.length === 0) return true;
    if (waited < reapWaitMs) sleep(25);
  }
  return false;
}

// Count live processes whose cmdline contains `token` (a launch-unique marker),
// visible in this namespace's /proc. Zero proves descendant absence.
function countByToken(token) {
  const needle = Buffer.from(token, "utf8");
  let n = 0;
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let cmdline;
    try { cmdline = fs.readFileSync(`/proc/${entry}/cmdline`); } catch { continue; }
    if (cmdline.includes(needle)) n += 1;
  }
  return n;
}

module.exports = {
  launchContained,
  launchProcessTreeContained,
  launchSetuidBwrapProcessTreeContained,
  launchContainedWithWorktree,
  teardown,
  countByToken,
  childrenOf,
};
