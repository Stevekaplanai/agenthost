import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import recoveryLib from "../container/autonomy-recovery-lib.js";

const { AutonomyRecoveryRegistry } = recoveryLib;

class FakeChild extends EventEmitter {
  constructor(onSignal = () => {}) {
    super();
    this.pid = 321;
    this.exitCode = null;
    this.signalCode = null;
    this.signals = [];
    this._onSignal = onSignal;
  }

  kill(signal) {
    this.signals.push(signal);
    this._onSignal(signal, this);
    return true;
  }

  exit(signal = null) {
    this.signalCode = signal;
    this.exitCode = signal ? null : 0;
    this.emit("exit", this.exitCode, signal);
  }
}

function holder() {
  return Object.freeze({ claimRef: "display-only" });
}

function writableDescriptor({
  launcherPid = 321,
  sandboxPid = 654,
  mountNamespace = "mnt:[4026539999]",
} = {}) {
  return {
    kind: "writable",
    evidence: {
      launcherPid,
      sandboxPid,
      mountNamespace,
      workspaceMount: { destination: "/workspace", writable: true },
    },
  };
}

function reserve(registry, taskId, privateHolder, descriptor = { kind: "pending" }) {
  const result = registry.reserve({ taskId, holder: privateHolder, writableBind: descriptor });
  assert.equal(result.ok, true);
  assert.ok(result.reservation, "the scheduler receives the in-process reservation capability");
  return result;
}

function register(registry, taskId, privateHolder, child, descriptor = { kind: "pending" }) {
  const reservation = reserve(registry, taskId, privateHolder, descriptor);
  assert.equal(registry.attach({
    taskId,
    holder: privateHolder,
    child,
    reservation: reservation.reservation,
  }).ok, true);
  return reservation;
}

function attest(registry, taskId, privateHolder, descriptor = writableDescriptor()) {
  assert.equal(registry.attestWritableBind({ taskId, holder: privateHolder, writableBind: descriptor }).ok, true);
}

test("recovery escalates the captured launcher to KILL and runs durable completion only after bind proof", async () => {
  const child = new FakeChild((signal, self) => {
    if (signal === "SIGKILL") self.exit("SIGKILL");
  });
  const sequence = [];
  let proofInput;
  const registry = new AutonomyRecoveryRegistry({
    proveWritableBindRevoked: async (input) => {
      sequence.push("proof");
      proofInput = input;
      return { ok: true };
    },
  });
  const privateHolder = holder();
  const descriptor = writableDescriptor();
  register(registry, "t_term_then_kill", privateHolder, child);
  attest(registry, "t_term_then_kill", privateHolder, descriptor);
  descriptor.evidence.mountNamespace = "mnt:[4026530000]";
  descriptor.evidence.workspaceMount.writable = false;

  const result = await registry.recover({
    taskId: "t_term_then_kill",
    holder: privateHolder,
    durableCompletion: async () => sequence.push("durable"),
  });

  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(sequence, ["proof", "durable"]);
  assert.deepEqual(proofInput, {
    taskId: "t_term_then_kill",
    writableBinds: [{
      kind: "writable",
      evidence: {
        launcherPid: 321,
        sandboxPid: 654,
        mountNamespace: "mnt:[4026539999]",
        workspaceMount: { destination: "/workspace", writable: true },
      },
    }],
  });
  assert.equal(Object.isFrozen(proofInput.writableBinds), true);
  assert.equal(Object.isFrozen(proofInput.writableBinds[0]), true);
  assert.equal(Object.isFrozen(proofInput.writableBinds[0].evidence), true);
  assert.equal(Object.isFrozen(proofInput.writableBinds[0].evidence.workspaceMount), true);
  assert.deepEqual(Object.keys(result).sort(), ["ok", "quarantined", "usedSigkill", "workerKilled", "workerReaped", "writableBindRevoked"]);
  assert.equal(Object.getOwnPropertyNames(result).includes("acknowledgement"), false);
  assert.equal(typeof registry.acknowledgeRecovery, "undefined");
});

test("mutable ChildProcess fields cannot forge a reap or replace the captured launcher kill method", async () => {
  const child = new FakeChild();
  let proofCalled = false;
  const registry = new AutonomyRecoveryRegistry({
    termTimeoutMs: 1,
    killTimeoutMs: 1,
    waitForExit: async () => true,
    proveWritableBindRevoked: async () => {
      proofCalled = true;
      return { ok: true };
    },
  });
  const privateHolder = holder();
  register(registry, "t_mutable_child", privateHolder, child);
  attest(registry, "t_mutable_child", privateHolder);

  child.pid = 999;
  child.exitCode = 0;
  child.signalCode = "SIGTERM";
  child.kill = () => {
    throw new Error("forged mutable kill method");
  };

  const result = await registry.recover({
    taskId: "t_mutable_child",
    holder: privateHolder,
    durableCompletion: async () => {},
  });

  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(result.reason, "worker_not_reaped");
  assert.equal(proofCalled, false, "mutable public exit fields are not private exit evidence");
});

test("attach requires and atomically consumes the exact current reservation capability", () => {
  const registry = new AutonomyRecoveryRegistry();
  const privateHolder = holder();
  const stale = reserve(registry, "t_reservation", privateHolder, { kind: "none" });
  assert.equal(registry.abortReservation({
    taskId: "t_reservation",
    holder: privateHolder,
    reservation: stale.reservation,
  }).ok, true);

  const current = reserve(registry, "t_reservation", privateHolder, { kind: "none" });
  const child = new FakeChild();
  const staleAttach = registry.attach({
    taskId: "t_reservation",
    holder: privateHolder,
    child,
    reservation: stale.reservation,
  });
  const attached = registry.attach({
    taskId: "t_reservation",
    holder: privateHolder,
    child,
    reservation: current.reservation,
  });
  const reused = registry.attach({
    taskId: "t_reservation",
    holder: privateHolder,
    child: new FakeChild(),
    reservation: current.reservation,
  });

  assert.equal(staleAttach.reason, "reservation_not_attachable");
  assert.equal(attached.ok, true);
  assert.equal(reused.reason, "reservation_not_attachable");
  assert.equal(registry.abortReservation({
    taskId: "t_reservation",
    holder: privateHolder,
    reservation: current.reservation,
  }).reason, "reservation_not_abortable");
});

test("writable attestation binds trusted sandbox telemetry to the immutable launcher snapshot", () => {
  const registry = new AutonomyRecoveryRegistry();
  const privateHolder = holder();
  const child = new FakeChild();
  register(registry, "t_bound_pids", privateHolder, child);

  child.pid = 999;
  const wrongLauncher = registry.attestWritableBind({
    taskId: "t_bound_pids",
    holder: privateHolder,
    writableBind: writableDescriptor({ launcherPid: 999 }),
  });
  const sharedPid = registry.attestWritableBind({
    taskId: "t_bound_pids",
    holder: privateHolder,
    writableBind: writableDescriptor({ launcherPid: 321, sandboxPid: 321 }),
  });
  const accepted = registry.attestWritableBind({
    taskId: "t_bound_pids",
    holder: privateHolder,
    writableBind: writableDescriptor({ launcherPid: 321, sandboxPid: 654 }),
  });

  assert.equal(wrongLauncher.reason, "invalid_writable_bind_attestation");
  assert.equal(sharedPid.reason, "invalid_writable_bind_attestation");
  assert.equal(accepted.ok, true);
});

test("pending evidence can be killed but never attested after the private exit event", async () => {
  const child = new FakeChild((signal, self) => {
    if (signal === "SIGTERM") self.exit("SIGTERM");
  });
  let proofCalled = false;
  const registry = new AutonomyRecoveryRegistry({
    proveWritableBindRevoked: async () => {
      proofCalled = true;
      return { ok: true };
    },
  });
  const privateHolder = holder();
  register(registry, "t_pending", privateHolder, child);
  child.exit("SIGTERM");

  const lateAttestation = registry.attestWritableBind({
    taskId: "t_pending",
    holder: privateHolder,
    writableBind: writableDescriptor(),
  });
  const result = await registry.recover({
    taskId: "t_pending",
    holder: privateHolder,
    durableCompletion: async () => {},
  });

  assert.equal(lateAttestation.reason, "controller_not_attestable");
  assert.equal(result.reason, "writable_bind_not_proven");
  assert.equal(proofCalled, false, "pending evidence never reaches a permissive proof callback");
});

test("read-only runs require explicit none evidence; absent and malformed writable descriptors fail closed", async () => {
  const privateHolder = holder();
  const registry = new AutonomyRecoveryRegistry({
    proveWritableBindRevoked: async (input) => {
      assert.deepEqual(input.writableBinds, [{ kind: "none" }]);
      assert.equal(Object.isFrozen(input.writableBinds[0]), true);
      return { ok: true };
    },
  });
  assert.equal(registry.reserve({ taskId: "t_absent", holder: privateHolder }).reason, "invalid_writable_bind_descriptor");
  assert.equal(registry.reserve({
    taskId: "t_empty",
    holder: privateHolder,
    writableBind: { kind: "writable", evidence: {} },
  }).reason, "invalid_writable_bind_descriptor");

  const child = new FakeChild();
  register(registry, "t_read_only", privateHolder, child, { kind: "none" });
  child.exit();
  const result = await registry.recover({
    taskId: "t_read_only",
    holder: privateHolder,
    durableCompletion: async () => {},
  });

  assert.equal(result.ok, true);
  assert.equal(result.usedSigkill, false);
});

test("an unproven writable bind remains quarantined even after the private exit event", async () => {
  const child = new FakeChild((signal, self) => {
    if (signal === "SIGTERM") self.exit("SIGTERM");
  });
  let durableCalled = false;
  const registry = new AutonomyRecoveryRegistry({
    proveWritableBindRevoked: async () => ({ ok: false, reason: "mount_namespace_still_has_a_sibling" }),
  });
  const privateHolder = holder();
  register(registry, "t_unproven_bind", privateHolder, child);
  attest(registry, "t_unproven_bind", privateHolder);

  const result = await registry.recover({
    taskId: "t_unproven_bind",
    holder: privateHolder,
    durableCompletion: async () => {
      durableCalled = true;
    },
  });

  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.equal(result.reason, "writable_bind_not_proven");
  assert.equal(durableCalled, false);
});

test("failed recovery durable completion retains the proved controller and blocks a fresh reservation", async () => {
  const child = new FakeChild((signal, self) => {
    if (signal === "SIGTERM") self.exit("SIGTERM");
  });
  let proofCalls = 0;
  let completionCalls = 0;
  const registry = new AutonomyRecoveryRegistry({
    proveWritableBindRevoked: async () => {
      proofCalls += 1;
      return { ok: true };
    },
  });
  const privateHolder = holder();
  register(registry, "t_recovery_durable", privateHolder, child);
  attest(registry, "t_recovery_durable", privateHolder);

  const failed = await registry.recover({
    taskId: "t_recovery_durable",
    holder: privateHolder,
    durableCompletion: async () => {
      completionCalls += 1;
      throw new Error("durable claim transaction failed");
    },
  });
  const blockedReserve = registry.reserve({
    taskId: "t_recovery_durable",
    holder: holder(),
    writableBind: { kind: "none" },
  });
  const completed = await registry.recover({
    taskId: "t_recovery_durable",
    holder: privateHolder,
    durableCompletion: async () => {
      completionCalls += 1;
    },
  });
  const freshReserve = registry.reserve({
    taskId: "t_recovery_durable",
    holder: holder(),
    writableBind: { kind: "none" },
  });

  assert.equal(failed.reason, "durable_completion_failed");
  assert.equal(blockedReserve.reason, "controller_already_tracked");
  assert.equal(completed.ok, true);
  assert.equal(freshReserve.ok, true);
  assert.equal(proofCalls, 1, "retrying durable completion does not erase or recreate recovery proof");
  assert.equal(completionCalls, 2);
});

test("normal finalization also retains proof until its durable callback completes", async () => {
  const child = new FakeChild();
  let proofCalls = 0;
  let completionCalls = 0;
  const registry = new AutonomyRecoveryRegistry({
    proveWritableBindRevoked: async () => {
      proofCalls += 1;
      return { ok: true };
    },
  });
  const privateHolder = holder();
  register(registry, "t_finalize_durable", privateHolder, child);
  attest(registry, "t_finalize_durable", privateHolder);
  child.exit();

  const failed = await registry.finalize({
    taskId: "t_finalize_durable",
    holder: privateHolder,
    durableCompletion: async () => {
      completionCalls += 1;
      throw new Error("durable normal completion failed");
    },
  });
  const blockedReserve = registry.reserve({
    taskId: "t_finalize_durable",
    holder: holder(),
    writableBind: { kind: "none" },
  });
  const reportedSuccessOnly = await registry.finalize({
    taskId: "t_finalize_durable",
    holder: privateHolder,
    durableCompleted: true,
  });
  const completed = await registry.finalize({
    taskId: "t_finalize_durable",
    holder: privateHolder,
    durableCompletion: async () => {
      completionCalls += 1;
    },
  });

  assert.equal(failed.reason, "durable_completion_failed");
  assert.equal(blockedReserve.reason, "controller_already_tracked");
  assert.equal(reportedSuccessOnly.reason, "durable_completion_required");
  assert.equal(completed.ok, true);
  assert.equal(proofCalls, 1);
  assert.equal(completionCalls, 2);
});

test("registry state is nonenumerable and there is no generic release or acknowledgement path", () => {
  const registry = new AutonomyRecoveryRegistry();
  const privateHolder = holder();
  const result = reserve(registry, "t_private", privateHolder);

  assert.deepEqual(Reflect.ownKeys(registry), [], "all registry state lives in module-private WeakMaps");
  assert.equal(registry._records, undefined);
  assert.equal(JSON.stringify(registry).includes("display-only"), false);
  assert.deepEqual(Object.keys(result).sort(), ["ok", "quarantined"]);
  assert.equal(JSON.stringify(result).includes("reservation"), false);
  assert.equal(Object.keys(result.reservation).length, 0, "the reservation capability carries no bearer fields");
  assert.equal(typeof registry.release, "undefined");
  assert.equal(typeof registry.acknowledgeRecovery, "undefined");
});

test("a restart cannot resurrect a controller from a private holder or saved task id", async () => {
  const child = new FakeChild();
  const originalGate = new AutonomyRecoveryRegistry();
  const privateHolder = holder();
  register(originalGate, "t_restart", privateHolder, child);

  const restartedGate = new AutonomyRecoveryRegistry();
  const result = await restartedGate.recover({
    taskId: "t_restart",
    holder: privateHolder,
    durableCompletion: async () => {},
  });

  assert.equal(result.reason, "no_live_controller");
  assert.deepEqual(child.signals, [], "a new Gate never rehydrates or signals an old PID");
});
