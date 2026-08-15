"use strict";

// Dormant Foundation-B candidate: kernel-stable child observation (BUILD-PLAN
// Phase 1d; ROOT-SERVICE-STATE-MACHINES §9). A recorded PID integer alone never
// authorizes a signal: PID 1 pins each governed child by (pid, /proc start time,
// boot id), so a reused PID belonging to an impostor is rejected. Where
// supported a pidfd is the primary handle; this start-time + boot-id identity is
// the portable fallback the contract names.
//
// Pure /proc reads — no mutation, no privilege, no wiring into any boot path.
// Activation is the atomic, separately-gated Phase 1f event.

const fs = require("node:fs");

function bootId() {
  return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
}

// Field 22 (1-indexed) of /proc/<pid>/stat is the process start time in clock
// ticks since boot. comm (field 2) may contain spaces/parens, so parse after
// the final ") ".
function startTime(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  const tail = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
  const value = Number(tail[19]); // field 22 == index (22 - 3) into the post-comm tail
  if (!Number.isInteger(value) || value < 0) throw new Error("could not parse start time");
  return value;
}

// Record a kernel-stable identity for a live pid. Throws if the pid is not
// currently observable.
function observeChild(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("observeChild requires a positive pid");
  return Object.freeze({ pid, startTime: startTime(pid), bootId: bootId() });
}

// True only if the SAME process is still alive: the pid exists, its start time
// matches, and the boot id is unchanged. A dead pid, a reused pid (different
// start time), or a post-reboot identity (different boot id) all return false —
// so a signal is never sent to an impostor that reused the number.
function verifyAlive(identity) {
  if (!identity || typeof identity !== "object") return false;
  if (identity.bootId !== bootId()) return false;
  let current;
  try { current = startTime(identity.pid); } catch { return false; }
  return current === identity.startTime;
}

// Positive terminal proof for a previously observed process. Absence (ENOENT /
// ESRCH), PID reuse, or a completed reboot proves the old identity is gone.
// Any other /proc uncertainty is thrown so callers quarantine instead of
// treating an unreadable process as dead.
function proveGone(identity, {
  readBootId = bootId,
  readStartTime = startTime,
} = {}) {
  if (!identity || !Number.isInteger(identity.pid) || !Number.isInteger(identity.startTime) ||
      typeof identity.bootId !== "string" || !identity.bootId) {
    throw new Error("proveGone requires an observed child identity");
  }
  const currentBootId = readBootId();
  if (currentBootId !== identity.bootId) return true;
  try {
    return readStartTime(identity.pid) !== identity.startTime;
  } catch (error) {
    if (error && (error.code === "ENOENT" || error.code === "ESRCH")) return true;
    throw error;
  }
}

module.exports = { observeChild, verifyAlive, proveGone, bootId, startTime };
