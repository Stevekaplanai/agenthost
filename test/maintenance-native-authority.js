"use strict";

// Real-Linux PID-1 adversarial authority harness for the maintenance native
// boundary (container/maintenance-native.c).
//
// The Foundation B implementation gate is explicit that Windows JavaScript
// tests and source-only review are NOT evidence that Unix ownership, descriptor
// inheritance, and peer credentials behave. This harness produces that evidence
// by running the primitive as the real root PID 1 inside a private PID + mount
// namespace and exercising the authority operations directly.
//
// It is NOT wired into entrypoint.sh, start.sh, gate.js, or the Dockerfile
// runtime image. It is driven only by scripts/maintenance-native-verify.sh,
// which supplies the namespace, the tmpfs-isolated /data and /run, and the
// gate/agent identities. Each invocation runs exactly one CASE, because
// open_trusted_dirs() pins the validated directory handles for the process
// lifetime (by design), so every directory-level fail-closed proof needs a
// fresh PID-1 process.
//
// Usage (via the verify script): node test/maintenance-native-authority.js <case>
// Exit code 0 = PASS, non-zero = FAIL. Skips cleanly (exit 0) if it is not the
// authority context, so a stray `node --test` cannot report a false failure.

import assert from "node:assert/strict";
import cp from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ADDON = process.env.AGENTHOST_MAINTENANCE_NATIVE;
const DATA = "/data";
const MAINT = "/data/maintenance";
const RUNDIR = "/run/agenthost";
const SOCKET = "/run/agenthost/maint.sock";
const FOUNDATION = "/data/maintenance/foundation.ndjson";

function skip(reason) {
  process.stdout.write(`SKIP ${reason}\n`);
  process.exit(0);
}

if (!ADDON) skip("AGENTHOST_MAINTENANCE_NATIVE is not set");
if (process.getuid() !== 0) skip("harness requires root");
if (process.pid !== 1) skip("harness requires PID 1 (run under scripts/maintenance-native-verify.sh)");

const native = require(ADDON);

// ---- tiny reporting harness ---------------------------------------------

let failures = 0;
let passed = 0;
function check(label, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ok   ${label}\n`);
  } catch (error) {
    failures += 1;
    process.stdout.write(`  FAIL ${label}: ${error && error.message}\n`);
  }
}

function throwsCode(fn, code, label, msgIncludes) {
  check(label, () => {
    let thrown = null;
    try {
      fn();
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown, `expected throw with code ${code}, got success`);
    assert.equal(thrown.code, code, `expected code ${code}, got ${thrown.code} (${thrown.message})`);
    if (msgIncludes) {
      assert.ok(
        String(thrown.message).includes(msgIncludes),
        `expected message to include "${msgIncludes}", got "${thrown.message}"`,
      );
    }
  });
}

function sh(command) {
  return cp.execSync(command, { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
}

function statLine(path) {
  return sh(`stat -c '%U:%G %a %F' ${path}`);
}

// ---- shared filesystem setup --------------------------------------------

// Isolate /data and /run on tmpfs inside this namespace so nothing touches the
// host and cleanup is automatic on namespace exit.
function mountIsolated() {
  cp.execSync(`mount -t tmpfs tmpfs ${DATA}`);
  cp.execSync(`chmod 0755 ${DATA}`); // tmpfs defaults to 1777; the primitive requires 0755.
  cp.execSync(`mount -t tmpfs tmpfs /run`);
}

function makeTrustedDirs() {
  fs.mkdirSync(MAINT);
  fs.chmodSync(MAINT, 0o700); // umask-proof
}

function ids(name) {
  const uid = Number(sh(`id -u ${name}`));
  const gid = Number(sh(`id -g ${name}`));
  return { uid, gid };
}

// Pre-create the runtime dir with an explicit owner/group/mode so tests can
// prove create_listener's validation of a *pre-existing* /run/agenthost.
function makeRuntimeDir(owner, group, mode) {
  fs.mkdirSync(RUNDIR);
  fs.chmodSync(RUNDIR, mode);
  fs.chownSync(RUNDIR, ids(owner).uid, ids(group).gid);
}

// Count listening TCP sockets in this (isolated, under `unshare --net`) network
// namespace by reading the kernel tables directly — no dependency on `ss`,
// which could be absent and make the proof pass vacuously. st==0A is LISTEN.
function tcpListenerCount() {
  let count = 0;
  for (const path of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text;
    try {
      text = fs.readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length > 3 && cols[3] === "0A") count += 1;
    }
  }
  return count;
}

// The socket descriptors PID 1 currently holds, by fd number.
function listSocketFds() {
  return fs.readdirSync("/proc/1/fd").filter((fd) => {
    try {
      return fs.readlinkSync(`/proc/1/fd/${fd}`).startsWith("socket:");
    } catch {
      return false;
    }
  });
}

// The open-file flags for a PID-1 descriptor (octal), from /proc/1/fdinfo.
function fdinfoFlags(fd) {
  const match = fs.readFileSync(`/proc/1/fdinfo/${fd}`, "utf8").match(/flags:\s*(\d+)/);
  if (!match) throw new Error(`no flags line in fdinfo for fd ${fd}`);
  return parseInt(match[1], 8);
}

// Leave a real AF_UNIX socket file at `path` (a node child binds it and exits
// without unlinking), then set the requested owner/mode, so tests can drive
// create_listener's stale-socket branch with an actual socket inode.
function plantUnixSocket(path, { owner = "root", group = "root", mode = 0o660 } = {}) {
  cp.spawnSync(process.execPath, ["-e", `require('net').createServer().listen(${JSON.stringify(path)}, () => process.exit(0));`], { stdio: "ignore" });
  fs.chownSync(path, ids(owner).uid, ids(group).gid);
  fs.chmodSync(path, mode);
}

// Spawn a child that drops to the requested identity and runs `body`. `groups`,
// `gid`, `uid` are applied in the privilege-safe order (groups, gid, uid).
function spawnAs({ groups, gid, uid, body }) {
  const prelude =
    (groups ? `process.setgroups(${JSON.stringify(groups)});` : "") +
    (gid ? `process.setgid(${JSON.stringify(gid)});` : "") +
    (uid ? `process.setuid(${JSON.stringify(uid)});` : "");
  return cp.spawn(process.execPath, ["-e", prelude + body], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// A child that connects to the authority socket as the given identity and, on
// success, writes "C" and stays alive so the parent can accept it.
function connectingPeer(identity) {
  const body =
    `const net=require('net');` +
    `const s=net.connect(${JSON.stringify(SOCKET)},()=>{process.stdout.write('C')});` +
    `s.on('error',e=>{process.stdout.write('E:'+e.code);process.exit(9)});` +
    `setInterval(()=>{},1e6);`;
  return spawnAs({ ...identity, body });
}

// A live direct child that does nothing (used to prove WRONG_PID: its pid is
// recorded while a different peer connects).
function sleeperPeer(identity) {
  return spawnAs({ ...identity, body: `setInterval(()=>{},1e6);` });
}

function firstStdout(child, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("peer timeout")), timeoutMs);
    child.stdout.once("data", (data) => {
      clearTimeout(timer);
      resolve(data.toString());
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`peer exited early (${code})`));
    });
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Poll the non-blocking accept until it returns a descriptor, throws a peer
// rejection, or the attempts are exhausted (EAGAIN returns null).
async function acceptOutcome() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const fd = native.acceptVerifiedGate();
      if (fd !== undefined && fd !== null) return { fd };
    } catch (error) {
      return { code: error.code };
    }
    await delay(20);
  }
  return { code: "NO_PENDING_CONNECTION" };
}

// ---- cases ---------------------------------------------------------------

const cases = {
  // Adversarial proof surface for the trusted stores: happy path plus every
  // leaf-level fail-closed rule (re-validated on each call, so one process).
  stores_ok() {
    mountIsolated();
    makeTrustedDirs();

    check("openTrustedStores succeeds on root:root 0755 /data + root 0700 maintenance", () => {
      native.openTrustedStores();
    });
    check("readFoundationJournal returns null when absent", () => {
      assert.equal(native.readFoundationJournal(), null);
    });
    check("append then read round-trips exactly one line", () => {
      native.appendFoundationJournalLine(Buffer.from('{"x":1}'));
      assert.equal(native.readFoundationJournal().toString(), '{"x":1}\n');
    });
    check("quarantine journal append is accepted", () => {
      native.appendQuarantineJournalLine(Buffer.from('{"q":1}'));
    });
    throwsCode(() => native.appendFoundationJournalLine(Buffer.from("a\nb")), "INVALID_REQUEST", "reject embedded newline");
    throwsCode(() => native.appendFoundationJournalLine(Buffer.from("a\rb")), "INVALID_REQUEST", "reject carriage return");
    throwsCode(() => native.appendFoundationJournalLine(Buffer.from("a\0b")), "INVALID_REQUEST", "reject NUL byte");
    throwsCode(() => native.appendFoundationJournalLine(Buffer.from("")), "INVALID_REQUEST", "reject empty line");
    throwsCode(() => native.appendFoundationJournalLine(Buffer.alloc(512 * 1024 + 1, 0x61)), "INVALID_REQUEST", "reject oversized line");

    // Leaf-level fail-closed: the directory handles stay valid, but the leaf is
    // re-verified (O_NOFOLLOW + owner/type/mode/nlink) on every access.
    fs.rmSync(FOUNDATION);
    fs.symlinkSync("/tmp/evil", FOUNDATION);
    throwsCode(() => native.readFoundationJournal(), "STORE_UNAVAILABLE", "reject symlinked journal leaf (read)");
    throwsCode(() => native.appendFoundationJournalLine(Buffer.from("{}")), "STORE_UNAVAILABLE", "reject symlinked journal leaf (append)");
    fs.rmSync(FOUNDATION);

    fs.writeFileSync(FOUNDATION, "{}\n", { mode: 0o600 });
    fs.chmodSync(FOUNDATION, 0o644);
    throwsCode(() => native.readFoundationJournal(), "STORE_UNAVAILABLE", "reject wrong-mode journal leaf");
    fs.chmodSync(FOUNDATION, 0o600);

    const agent = ids("agent");
    fs.chownSync(FOUNDATION, agent.uid, agent.gid);
    throwsCode(() => native.readFoundationJournal(), "STORE_UNAVAILABLE", "reject wrong-owner journal leaf");
    fs.chownSync(FOUNDATION, 0, 0);

    fs.linkSync(FOUNDATION, `${MAINT}/hardlink`);
    throwsCode(() => native.readFoundationJournal(), "STORE_UNAVAILABLE", "reject hardlinked journal leaf (nlink>1)");
    fs.rmSync(`${MAINT}/hardlink`);
  },

  store_dir_bad_mode() {
    mountIsolated();
    makeTrustedDirs();
    fs.chmodSync(DATA, 0o777);
    throwsCode(() => native.openTrustedStores(), "STORE_UNAVAILABLE", "reject /data with wrong mode 0777");
  },

  store_dir_bad_owner() {
    mountIsolated();
    makeTrustedDirs();
    const agent = ids("agent");
    fs.chownSync(MAINT, agent.uid, agent.gid);
    throwsCode(() => native.openTrustedStores(), "STORE_UNAVAILABLE", "reject agent-owned maintenance dir");
  },

  store_dir_bad_mode2() {
    mountIsolated();
    makeTrustedDirs();
    fs.chmodSync(MAINT, 0o750);
    throwsCode(() => native.openTrustedStores(), "STORE_UNAVAILABLE", "reject maintenance dir with wrong mode 0750");
  },

  store_dir_symlink() {
    mountIsolated();
    // maintenance is a symlink to a world-writable dir: O_NOFOLLOW must reject.
    fs.symlinkSync("/tmp", MAINT);
    throwsCode(() => native.openTrustedStores(), "STORE_UNAVAILABLE", "reject symlinked maintenance dir (O_NOFOLLOW)");
  },

  store_dir_notdir() {
    mountIsolated();
    fs.writeFileSync(MAINT, "not a directory");
    fs.chmodSync(MAINT, 0o700);
    fs.chownSync(MAINT, 0, 0);
    throwsCode(() => native.openTrustedStores(), "STORE_UNAVAILABLE", "reject regular file where maintenance dir expected");
  },

  // Adversarial proof #1: an agent-uid process cannot open, replace, rename,
  // delete, chmod, or truncate the trusted store or its parent. This is an OS
  // ownership proof (no native call needed) — the primitive relies on it.
  agent_cannot_touch() {
    mountIsolated();
    makeTrustedDirs();
    native.openTrustedStores();
    native.appendFoundationJournalLine(Buffer.from('{"seed":1}'));

    const agent = { groups: [], gid: "agent", uid: "agent" };
    const attempts = {
      "open journal for read": `fs.readFileSync(${JSON.stringify(FOUNDATION)})`,
      "open journal for write": `fs.writeFileSync(${JSON.stringify(FOUNDATION)},'x')`,
      "truncate journal": `fs.truncateSync(${JSON.stringify(FOUNDATION)},0)`,
      "unlink journal": `fs.unlinkSync(${JSON.stringify(FOUNDATION)})`,
      "chmod journal": `fs.chmodSync(${JSON.stringify(FOUNDATION)},0o666)`,
      "create sibling in maintenance": `fs.writeFileSync(${JSON.stringify(MAINT + "/planted")},'x')`,
      "rename maintenance dir": `fs.renameSync(${JSON.stringify(MAINT)},${JSON.stringify(DATA + "/stolen")})`,
      "chmod maintenance dir": `fs.chmodSync(${JSON.stringify(MAINT)},0o777)`,
    };
    for (const [label, op] of Object.entries(attempts)) {
      check(`agent uid is denied: ${label}`, () => {
        const result = spawnSyncAs(agent, `const fs=require('fs');try{${op};process.stdout.write('LEAK')}catch(e){process.stdout.write('DENIED:'+e.code)}`);
        assert.match(result, /^DENIED:(EACCES|EPERM|ENOENT)$/, `expected denial, got ${result}`);
      });
    }
    // The seeded journal is intact and unchanged after every hostile attempt.
    check("journal survives all agent-uid attempts", () => {
      assert.equal(native.readFoundationJournal().toString(), '{"seed":1}\n');
    });
  },

  // Adversarial proof #2 + #3: socket ownership/modes, no TCP listener, exact
  // SO_PEERCRED validation, close-on-exec of BOTH the listener and the accepted
  // descriptor, second-connection rejection without disturbing the active one,
  // and gate-loss revoke + replacement.
  async socket_peers() {
    mountIsolated();
    makeTrustedDirs();
    native.openTrustedStores();

    const socketsBefore = new Set(listSocketFds());
    native.createAuthorityListener();
    const newListenerFds = listSocketFds().filter((fd) => !socketsBefore.has(fd));

    check("runtime dir is root:gate 0750 directory", () => {
      assert.equal(statLine(RUNDIR), "root:gate 750 directory");
    });
    check("socket is root:gate 0660 socket", () => {
      assert.equal(statLine(SOCKET), "root:gate 660 socket");
    });
    check("no TCP listener exists in the namespace", () => {
      assert.equal(tcpListenerCount(), 0, "unexpected TCP listener present");
    });
    check("listener descriptor carries O_CLOEXEC in fdinfo", () => {
      assert.ok(newListenerFds.length >= 1, "no new socket descriptor after createAuthorityListener");
      for (const fd of newListenerFds) {
        assert.equal(fdinfoFlags(fd) & 0o2000000, 0o2000000, `listener fd ${fd} is not close-on-exec`);
      }
    });
    check("listener descriptor does not leak into an exec'd engine process", () => {
      const probe = newListenerFds.map((fd) => `test -e /proc/self/fd/${fd} && echo LEAK`).join("; ");
      const seen = cp.spawnSync("sh", ["-c", `{ ${probe}; } 2>/dev/null; echo DONE`], { encoding: "utf8" }).stdout.trim();
      assert.equal(seen, "DONE", "a listener descriptor leaked across exec");
    });

    // Negative peers reject before the active connection is set, so they run in
    // this one process. Each pulls exactly one pending connection.

    // agent uid is not in the gate group: it cannot even reach the 0660 socket.
    const agentPeer = connectingPeer({ groups: [], gid: "agent", uid: "agent" });
    const agentSignal = await firstStdout(agentPeer).catch((e) => e.message);
    agentPeer.kill();
    check("agent-uid peer is refused connection to the socket", () => {
      assert.match(agentSignal, /^E:EACCES/, `expected connect EACCES, got ${agentSignal}`);
    });

    // Wrong uid: a root peer can open the socket (owner rw) but its uid != gate.
    await withPeer(connectingPeer({ groups: [] }), async (peer) => {
      native.recordDirectGateChild(peer.pid);
      const outcome = await acceptOutcome();
      check("wrong-uid peer rejected as WRONG_UID", () => assert.equal(outcome.code, "WRONG_UID"));
    });

    // Wrong gid: supplementary gate membership grants socket access, but the
    // primary egid reported by SO_PEERCRED is agent, not gate.
    await withPeer(connectingPeer({ groups: ["gate"], gid: "agent", uid: "gate" }), async (peer) => {
      native.recordDirectGateChild(peer.pid);
      const outcome = await acceptOutcome();
      check("wrong-gid peer rejected as WRONG_GID", () => assert.equal(outcome.code, "WRONG_GID"));
    });

    // Wrong pid: a gate peer connects, but a different live direct child's pid
    // is the recorded one.
    {
      const sleeper = sleeperPeer({ groups: ["gate"], gid: "gate", uid: "gate" });
      await withPeer(connectingPeer({ groups: [], gid: "gate", uid: "gate" }), async (peer) => {
        native.recordDirectGateChild(sleeper.pid);
        const outcome = await acceptOutcome();
        check("mismatched-pid peer rejected as WRONG_PID", () => assert.equal(outcome.code, "WRONG_PID"));
      });
      sleeper.kill();
    }

    // Happy path: the exact gate peer is accepted.
    let acceptedFd = null;
    await withPeer(connectingPeer({ groups: [], gid: "gate", uid: "gate" }), async (peer) => {
      native.recordDirectGateChild(peer.pid);
      const outcome = await acceptOutcome();
      check("exact gate peer is accepted", () => {
        assert.equal(outcome.code, undefined, `unexpected rejection ${outcome.code}`);
        assert.equal(typeof outcome.fd, "number");
      });
      acceptedFd = outcome.fd;

      if (acceptedFd !== null) {
        check("accepted descriptor carries O_CLOEXEC in fdinfo", () => {
          assert.equal(fdinfoFlags(acceptedFd) & 0o2000000, 0o2000000, "O_CLOEXEC bit not set");
        });
        check("accepted descriptor does not leak into an exec'd engine process", () => {
          const seen = cp.spawnSync("sh", ["-c", `test -e /proc/self/fd/${acceptedFd} && echo LEAK || echo GONE`], { encoding: "utf8" }).stdout.trim();
          assert.equal(seen, "GONE", "descriptor leaked across exec");
        });

        // A second connection is rejected WITHOUT disturbing the active one.
        await withPeer(connectingPeer({ groups: [], gid: "gate", uid: "gate" }), async () => {
          const second = await acceptOutcome();
          check("second connection rejected as SECOND_CONNECTION", () => assert.equal(second.code, "SECOND_CONNECTION"));
          check("the healthy active connection survives the rejected second", () => {
            assert.ok(fs.existsSync(`/proc/1/fd/${acceptedFd}`), "active connection descriptor was closed");
          });
        });
      }
    });

    // Gate loss: revoke clears the latch and closes the active fd, and a
    // replacement gate (new pid) is then accepted — proving the mandatory
    // replacement-epoch path is reachable without a container restart.
    check("revokeActiveGate closes the active descriptor", () => {
      assert.ok(acceptedFd !== null && fs.existsSync(`/proc/1/fd/${acceptedFd}`), "precondition: active fd open");
      native.revokeActiveGate();
      assert.ok(!fs.existsSync(`/proc/1/fd/${acceptedFd}`), "active descriptor was not closed by revoke");
    });
    await withPeer(connectingPeer({ groups: [], gid: "gate", uid: "gate" }), async (peer) => {
      native.recordDirectGateChild(peer.pid);
      const outcome = await acceptOutcome();
      check("replacement gate is accepted after revoke", () => {
        assert.equal(outcome.code, undefined, `unexpected rejection ${outcome.code}`);
        assert.equal(typeof outcome.fd, "number");
      });
    });
  },

  // Adversarial proof #4: a stale non-socket at the fixed socket path fails
  // closed. The runtime dir is pre-created as the exact root:gate 0750 so
  // create_listener's directory validation passes and the stale-socket TYPE
  // branch is actually reached (not short-circuited by a dir-mode mismatch).
  stale_socket() {
    mountIsolated();
    makeRuntimeDir("root", "gate", 0o750);
    fs.writeFileSync(SOCKET, "not a socket");
    throwsCode(() => native.createAuthorityListener(), "SOCKET_UNAVAILABLE", "reject non-socket at the fixed socket path", "unsafe stale socket");
  },

  // Adversarial proof #4 (continued): an exact root:gate 0660 stale socket is
  // safely unlinked and rebound; wrong-owner/wrong-mode stale sockets are not.
  stale_socket_replaced() {
    mountIsolated();
    makeRuntimeDir("root", "gate", 0o750);

    plantUnixSocket(SOCKET, { owner: "agent", group: "agent", mode: 0o660 });
    throwsCode(() => native.createAuthorityListener(), "SOCKET_UNAVAILABLE", "reject agent-owned stale socket", "unsafe stale socket");
    fs.rmSync(SOCKET);

    plantUnixSocket(SOCKET, { owner: "root", group: "gate", mode: 0o666 });
    throwsCode(() => native.createAuthorityListener(), "SOCKET_UNAVAILABLE", "reject wrong-mode stale socket", "unsafe stale socket");
    fs.rmSync(SOCKET);

    plantUnixSocket(SOCKET, { owner: "root", group: "gate", mode: 0o660 });
    check("exact root:gate 0660 stale socket is unlinked and rebound", () => {
      native.createAuthorityListener();
      assert.equal(statLine(SOCKET), "root:gate 660 socket");
    });
  },

  // Adversarial proof #2: create_listener validates a PRE-EXISTING runtime dir
  // and refuses to adopt a hostile one (it only re-secures a dir it created).
  runtime_dir_bad() {
    mountIsolated();
    makeRuntimeDir("agent", "agent", 0o777);
    throwsCode(() => native.createAuthorityListener(), "SOCKET_UNAVAILABLE", "reject agent-owned world-writable runtime dir", "validate runtime directory");
  },

  runtime_dir_bad_group() {
    mountIsolated();
    makeRuntimeDir("root", "root", 0o750); // right owner/mode, wrong group
    throwsCode(() => native.createAuthorityListener(), "SOCKET_UNAVAILABLE", "reject wrong-group runtime dir", "validate runtime directory");
  },

  // Adversarial proof #2 / SS §9: a gate that dies after being recorded but
  // before accept is rejected by the pidfd liveness re-check — a recorded PID
  // integer alone never authorizes.
  async gate_dies_before_accept() {
    mountIsolated();
    makeTrustedDirs();
    native.openTrustedStores();
    native.createAuthorityListener();

    const peer = connectingPeer({ groups: [], gid: "gate", uid: "gate" });
    const signal = await firstStdout(peer).catch((e) => e.message);
    check("gate peer connected before being killed", () => assert.match(signal, /^C/));
    native.recordDirectGateChild(peer.pid);
    peer.kill("SIGKILL");
    await new Promise((resolve) => peer.on("exit", resolve));
    await delay(75); // let the kernel mark the pidfd readable

    const outcome = await acceptOutcome();
    check("gate that died before accept is rejected as WRONG_PID", () => assert.equal(outcome.code, "WRONG_PID"));
  },

  // Adversarial proof #4: the 1 MiB whole-file journal cap fails closed on both
  // append (unbounded growth) and read (unbounded malloc from a corrupt file).
  journal_size_caps() {
    mountIsolated();
    makeTrustedDirs();
    native.openTrustedStores();

    // Each line is just under LINE_MAX (512 KiB), so it passes per-line
    // validation; the whole-file cap must stop growth past 1 MiB.
    const line = Buffer.alloc(512 * 1024 - 1, 0x61);
    let appended = 0;
    let capped = false;
    for (let i = 0; i < 6; i += 1) {
      try {
        native.appendFoundationJournalLine(line);
        appended += 1;
      } catch (error) {
        capped = error.code === "STORE_UNAVAILABLE";
        break;
      }
    }
    check("append fails closed at the 1 MiB journal cap", () => {
      assert.ok(capped, "expected a STORE_UNAVAILABLE at the cap");
      assert.ok(appended >= 1 && appended <= 2, `capped after ${appended} appends`);
    });

    // A corrupt/oversized on-disk journal must not drive an unbounded read.
    fs.rmSync(FOUNDATION);
    fs.writeFileSync(FOUNDATION, Buffer.alloc(1024 * 1024 + 1, 0x63), { mode: 0o600 });
    throwsCode(() => native.readFoundationJournal(), "STORE_UNAVAILABLE", "reject reading a journal larger than 1 MiB");
  },
};

// spawnSync variant of spawnAs for one-shot agent-uid probes.
function spawnSyncAs({ groups, gid, uid }, body) {
  const prelude =
    (groups ? `process.setgroups(${JSON.stringify(groups)});` : "") +
    (gid ? `process.setgid(${JSON.stringify(gid)});` : "") +
    (uid ? `process.setuid(${JSON.stringify(uid)});` : "");
  return cp.spawnSync(process.execPath, ["-e", prelude + body], { encoding: "utf8" }).stdout.trim();
}

// Run `fn(peer)` once the peer has signalled a live connection ("C"), then
// tear the peer down.
async function withPeer(peer, fn) {
  try {
    const signal = await firstStdout(peer).catch((e) => `ERR:${e.message}`);
    if (!signal.startsWith("C")) {
      failures += 1;
      process.stdout.write(`  FAIL peer did not connect: ${signal}\n`);
      return;
    }
    await fn(peer);
  } finally {
    peer.kill();
  }
}

// ---- dispatch ------------------------------------------------------------

async function main() {
  const name = process.argv[2] || process.env.MAINT_CASE;
  if (!name || !cases[name]) {
    process.stdout.write(`unknown case: ${name}\navailable: ${Object.keys(cases).join(", ")}\n`);
    process.exit(2);
  }
  process.stdout.write(`CASE ${name}\n`);
  await cases[name]();
  process.stdout.write(`CASE ${name}: ${failures === 0 ? "PASS" : "FAIL"} (${passed} ok, ${failures} failed)\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  process.stdout.write(`HARNESS ERROR: ${error && error.stack}\n`);
  process.exit(3);
});
