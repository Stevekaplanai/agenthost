"use strict";

// Dormant Foundation-B candidate: the root PID-1 authority runner (BUILD-PLAN
// Phase 1f, Step 4d — the process entry the boot edit execs). It owns the
// production accept loop the supervisor comment defers to PID 1: boot (migration
// → stores → listener → first gate), then repeatedly accept the verified gate
// connection, hand it to the supervisor (which delegates the framed loop to a
// fresh full-authority foundation service via `makeService`), and on gate loss
// spawn a replacement and re-accept.
//
// `createAuthorityRunner` is the testable orchestration (fake native + injected
// delay). `bootMain` is the thin production shell: require the root-owned native
// addon, build the supervisor with a `makeService` that constructs the whole
// authority from the native boundary + compiled §8 profiles, and run the loop as
// root PID 1. The native SO_PEERCRED accept + gate identity are proven on real
// Linux by scripts/maintenance-supervisor-verify.sh; this composes them.
//
// DORMANT: imported by no boot path. The entrypoint.sh guard
// (AGENTHOST_FOUNDATION_B=1 → exec node maintenance-boot-main.js) is the gated
// activation edit (CUTOVER-BOOT-EDIT-PLAN), not applied here.

// createAuthorityRunner({ supervisor, delay?, log? })
//   supervisor : createMaintenanceSupervisor({ ..., makeService }) — makeService
//                present so accepted connections serve the full authority.
//   delay      : (ms) => Promise, the accept poll backoff (injectable for tests).
function createAuthorityRunner({ supervisor, delay = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = 20, log = () => {} } = {}) {
  if (!supervisor || typeof supervisor.boot !== "function" || typeof supervisor.acceptGate !== "function" || typeof supervisor.attachConnection !== "function") {
    throw new Error("authority runner requires a supervisor with boot/acceptGate/attachConnection");
  }
  let stopped = false;
  const gateLost = Symbol("gate_lost_before_authority_connection");
  const needsReplacement = () => (
    typeof supervisor.needsGateReplacement === "function"
    && supervisor.needsGateReplacement() === true
  );

  // Poll the non-blocking accept until the verified gate arrives (or stop). A
  // native rejection (bad peer) throws — fatal, surfaced to the caller.
  async function acceptOne() {
    while (!stopped) {
      if (needsReplacement()) return gateLost;
      const conn = supervisor.acceptGate(); // fd | socket | null (native throws on bad peer)
      if (conn !== null && conn !== undefined) {
        if (needsReplacement()) {
          try { if (conn && typeof conn.destroy === "function") conn.destroy(); } catch {}
          return gateLost;
        }
        return conn;
      }
      await delay(pollMs);
    }
    return null;
  }

  // Wait until the current connection ends (gate loss clears it), or stop.
  async function waitConnectionEnd() {
    while (!stopped && supervisor.getConnection() !== null) await delay(pollMs);
  }

  async function run() {
    supervisor.boot(); // spawns the first gate + creates the listener
    while (!stopped) {
      const conn = await acceptOne();
      if (stopped || conn == null) break;
      if (conn === gateLost) {
        log("gate exited before authority connection; spawning quarantined replacement");
        supervisor.startGate();
        continue;
      }
      supervisor.attachConnection(conn);
      log("gate connection attached; serving authority");
      await waitConnectionEnd();
      if (stopped) break;
      // Gate lost: the supervisor revoked + reaped it. Spawn the replacement
      // (new PID/epoch) and loop to re-accept — never adopt an old handle.
      log("gate lost; spawning replacement");
      supervisor.startGate();
    }
  }

  return { run, stop: () => { stopped = true; } };
}

// bootMain — the production shell. Kept dependency-injected so the only untested
// surface is `require(nativeAddonPath)` and process wiring; everything it wires
// is proven. Not called anywhere; the boot edit invokes it as root PID 1.
function bootMain({ require: req, nativeAddonPath, protocol, contract, createStore, createFoundationBoot, policy, structuralLimits, profiles, spawn, recoveryDriver, createMaintenanceSupervisor, spawnGate, operatorSessionDigest, now, log } = {}) {
  const native = req(nativeAddonPath);
  const makeService = () => createFoundationBoot({ native, protocol, contract, policy, structuralLimits, profiles, spawn, recoveryDriver, now }).service;
  const supervisor = createMaintenanceSupervisor({ native, protocol, createStore, contract, spawnGate, makeService, operatorSessionDigest, now, log });
  return createAuthorityRunner({ supervisor, log }).run();
}

module.exports = { createAuthorityRunner, bootMain };
