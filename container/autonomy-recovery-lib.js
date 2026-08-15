"use strict";

// In-memory control for one autonomous worker protected by a durable Phase 4
// claim. It deliberately persists neither a PID nor a recovery capability.
// After Gate restarts, the registry is empty and an expired claim must remain
// quarantined rather than being "recovered" from a saved process identifier.

// Controller state and short-lived scheduler capabilities are intentionally
// module-private. A registry consumer cannot enumerate a holder, child handle,
// PID, or writable-bind evidence from the instance.
const REGISTRY_STATE = new WeakMap();
const RESERVATION_CAPABILITIES = new WeakMap();

function validTaskId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function validHolder(value) {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

function directChild(value) {
  return !!(value && typeof value === "object" &&
    Number.isSafeInteger(value.pid) && value.pid > 0 &&
    typeof value.kill === "function" && typeof value.once === "function");
}

function plainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function snapshotWritableBind(value) {
  if (!plainRecord(value) || typeof value.kind !== "string") return null;
  if (value.kind === "none" || value.kind === "pending") {
    // A read-only run explicitly says no bind existed. A writable run begins
    // pending until Gate has read trusted bwrap status plus /proc evidence.
    return exactKeys(value, ["kind"]) ? Object.freeze({ kind: value.kind }) : null;
  }
  if (value.kind !== "writable" || !exactKeys(value, ["kind", "evidence"]) || !plainRecord(value.evidence)) {
    return null;
  }

  const evidence = value.evidence;
  if (!exactKeys(evidence, ["launcherPid", "sandboxPid", "mountNamespace", "workspaceMount"]) ||
      !Number.isSafeInteger(evidence.launcherPid) || evidence.launcherPid < 2 ||
      !Number.isSafeInteger(evidence.sandboxPid) || evidence.sandboxPid < 2 ||
      evidence.launcherPid === evidence.sandboxPid ||
      typeof evidence.mountNamespace !== "string" || !/^mnt:\[\d+\]$/.test(evidence.mountNamespace) ||
      !plainRecord(evidence.workspaceMount) ||
      !exactKeys(evidence.workspaceMount, ["destination", "writable"]) ||
      evidence.workspaceMount.destination !== "/workspace" || evidence.workspaceMount.writable !== true) {
    return null;
  }

  // Copy every nested value before freezing. The launch code cannot mutate a
  // descriptor after attaching it and redirect a later proof to another mount.
  return Object.freeze({
    kind: "writable",
    evidence: Object.freeze({
      launcherPid: evidence.launcherPid,
      sandboxPid: evidence.sandboxPid,
      mountNamespace: evidence.mountNamespace,
      workspaceMount: Object.freeze({ destination: "/workspace", writable: true }),
    }),
  });
}

function waitForChildExit(child, timeoutMs) {
  const timeout = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : 1_000;
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (typeof child.removeListener === "function") child.removeListener("exit", onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    timer = setTimeout(() => finish(false), timeout);
    child.once("exit", onExit);
  });
}

function failure(reason) {
  return Object.freeze({ ok: false, quarantined: true, reason });
}

function blocked(reason) {
  return Object.freeze({ ok: false, quarantined: false, reason });
}

function attachPrivateCapability(response, name, capability) {
  Object.defineProperty(response, name, {
    value: capability,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return Object.freeze(response);
}

function publicSuccess() {
  return Object.freeze({ ok: true, quarantined: false });
}

function recoverySuccess(usedSigkill) {
  return Object.freeze({
    ok: true,
    quarantined: false,
    workerKilled: true,
    workerReaped: true,
    writableBindRevoked: true,
    usedSigkill: usedSigkill === true,
  });
}

function finalizationSuccess() {
  return Object.freeze({ ok: true, quarantined: false, workerReaped: true, writableBindRevoked: true });
}

class AutonomyRecoveryRegistry {
  constructor(options = {}) {
    REGISTRY_STATE.set(this, {
      records: new Map(),
      waitForExit: typeof options.waitForExit === "function" ? options.waitForExit : waitForChildExit,
      proveWritableBindRevoked: typeof options.proveWritableBindRevoked === "function"
        ? options.proveWritableBindRevoked
        : async () => ({ ok: false }),
      termTimeoutMs: Number.isSafeInteger(options.termTimeoutMs) && options.termTimeoutMs > 0 ? options.termTimeoutMs : 1_000,
      killTimeoutMs: Number.isSafeInteger(options.killTimeoutMs) && options.killTimeoutMs > 0 ? options.killTimeoutMs : 1_000,
    });
  }

  // Reserve immediately before spawn. The returned reservation is a private,
  // non-bearer capability used only to abort a spawn that never produced a
  // direct ChildProcess. attach() invalidates it synchronously.
  reserve(request = {}) {
    const source = request && typeof request === "object" ? request : {};
    const { taskId, holder, writableBind } = source;
    if (!validTaskId(taskId) || !validHolder(holder)) return failure("invalid_recovery_controller");
    const descriptor = snapshotWritableBind(writableBind);
    if (!descriptor || (descriptor.kind !== "none" && descriptor.kind !== "pending")) {
      return failure("invalid_writable_bind_descriptor");
    }
    const state = REGISTRY_STATE.get(this);
    if (state.records.has(taskId)) return failure("controller_already_tracked");

    const reservation = Object.freeze({});
    const record = {
      taskId,
      holder,
      child: null,
      state: "reserved",
      writableBind: descriptor,
      reservation,
      usedSigkill: false,
    };
    state.records.set(taskId, record);
    RESERVATION_CAPABILITIES.set(reservation, { registry: this, record, taskId, holder });
    return attachPrivateCapability({ ok: true, quarantined: false }, "reservation", reservation);
  }

  // Abort is valid only before a child has been attached. No task/holder-only
  // method can drop a reservation after spawn begins.
  abortReservation(request = {}) {
    const source = request && typeof request === "object" ? request : {};
    const { taskId, holder, reservation } = source;
    if (!validTaskId(taskId) || !validHolder(holder)) return failure("invalid_recovery_controller");
    const state = REGISTRY_STATE.get(this);
    const record = state.records.get(taskId);
    const privateReservation = RESERVATION_CAPABILITIES.get(reservation);
    if (!record || !privateReservation || privateReservation.registry !== this ||
        privateReservation.record !== record || privateReservation.taskId !== taskId ||
        privateReservation.holder !== holder || record.holder !== holder ||
        record.state !== "reserved" || record.child !== null || record.reservation !== reservation) {
      return failure("reservation_not_abortable");
    }
    RESERVATION_CAPABILITIES.delete(reservation);
    record.reservation = null;
    state.records.delete(taskId);
    return publicSuccess();
  }

  // Attach only the direct ChildProcess returned synchronously by spawn(). The
  // first attach has no later validation branch: accepting the direct child
  // immediately invalidates the abort capability and closes the spawn gap.
  attach(request = {}) {
    const source = request && typeof request === "object" ? request : {};
    const { taskId, holder, child } = source;
    if (!validTaskId(taskId) || !validHolder(holder)) return failure("invalid_recovery_controller");
    if (!directChild(child)) return failure("invalid_direct_child");
    const state = REGISTRY_STATE.get(this);
    const record = state.records.get(taskId);
    if (!record) return failure("no_live_controller");
    const reservation = source.reservation;
    const privateReservation = RESERVATION_CAPABILITIES.get(reservation);
    if (!privateReservation || privateReservation.registry !== this ||
        privateReservation.record !== record || privateReservation.taskId !== taskId ||
        privateReservation.holder !== holder || record.reservation !== reservation) {
      return failure("reservation_not_attachable");
    }
    if (record.holder !== holder || record.state !== "reserved" || record.child !== null) {
      return failure("controller_not_attachable");
    }

    record.child = child;
    record.launcherPid = child.pid;
    record.kill = child.kill.bind(child);
    record.reaped = false;
    record.onExit = () => { record.reaped = true; };
    child.once("exit", record.onExit);
    record.state = "tracked";
    record.reservation = null;
    if (reservation) RESERVATION_CAPABILITIES.delete(reservation);
    return publicSuccess();
  }

  // Replace a pending descriptor only while the same direct child remains
  // visibly live. A status event that arrives after child exit cannot attest a
  // bind for recovery because it may describe stale or recycled host state.
  attestWritableBind(request = {}) {
    const source = request && typeof request === "object" ? request : {};
    const { taskId, holder, writableBind } = source;
    if (!validTaskId(taskId) || !validHolder(holder)) return failure("invalid_recovery_controller");
    const state = REGISTRY_STATE.get(this);
    const record = state.records.get(taskId);
    if (!record) return failure("no_live_controller");
    if (record.holder !== holder || record.state !== "tracked" || !directChild(record.child) || record.reaped) {
      return failure("controller_not_attestable");
    }
    const descriptor = snapshotWritableBind(writableBind);
    if (record.writableBind.kind !== "pending" || !descriptor || descriptor.kind !== "writable" ||
        descriptor.evidence.launcherPid !== record.launcherPid) {
      return failure("invalid_writable_bind_attestation");
    }
    record.writableBind = descriptor;
    return publicSuccess();
  }

  async _waitForObservedExit(state, record, timeoutMs) {
    if (record.reaped) return true;
    try {
      // An injected wait helper is not evidence by itself. Node's direct child
      // handle must show an exit before a worker is considered reaped.
      return await state.waitForExit(record.child, timeoutMs) === true && record.reaped;
    } catch (_) {
      return false;
    }
  }

  _signal(record, signal) {
    try {
      // ChildProcess#kill targets this direct handle. Never replace this with
      // process.kill(pid), a negative process group, or a persisted PID.
      return record.kill(signal) === true || record.reaped;
    } catch (_) {
      return record.reaped;
    }
  }

  _forget(state, record) {
    if (record.child && record.onExit && typeof record.child.removeListener === "function") {
      record.child.removeListener("exit", record.onExit);
    }
    state.records.delete(record.taskId);
  }

  async _proof(state, record) {
    try {
      // A pending writable bind is never enough. It must remain quarantined
      // even if an injected callback would otherwise claim success.
      if (record.writableBind.kind === "pending") return false;
      const proof = await state.proveWritableBindRevoked({
        taskId: record.taskId,
        writableBinds: Object.freeze([record.writableBind]),
      });
      return !!(proof && proof.ok === true);
    } catch (_) {
      return false;
    }
  }

  // Normal completion cannot discard an exited child without proving its bind
  // is gone. This is separate from recovery acknowledgement below.
  async finalize(request = {}) {
    const source = request && typeof request === "object" ? request : {};
    const { taskId, holder } = source;
    if (!validTaskId(taskId) || !validHolder(holder)) return failure("invalid_recovery_controller");
    const state = REGISTRY_STATE.get(this);
    const record = state.records.get(taskId);
    if (!record) return failure("no_live_controller");
    if (record.holder !== holder) return failure("holder_mismatch");
    if (record.state === "tracked") {
      if (!directChild(record.child)) return blocked("controller_not_finalizable");
      if (!record.reaped) return blocked("child_not_observed_reaped");
      record.state = "finalizing";
      if (!await this._proof(state, record)) {
        record.state = "quarantined";
        return failure("writable_bind_not_proven");
      }
      record.state = "finalized";
    }
    if (record.state !== "finalized") return blocked("controller_not_finalizable");
    if (typeof source.durableCompletion !== "function") return failure("durable_completion_required");
    try {
      await source.durableCompletion();
    } catch (_) {
      return failure("durable_completion_failed");
    }
    this._forget(state, record);
    return finalizationSuccess();
  }

  // Stop one tracked worker, prove it was reaped and its bind is gone, then
  // retain the proof until Gate has durably recorded and reclaimed the claim.
  async recover(request = {}) {
    const source = request && typeof request === "object" ? request : {};
    const { taskId, holder } = source;
    if (!validTaskId(taskId) || !validHolder(holder)) return failure("invalid_recovery_controller");
    const state = REGISTRY_STATE.get(this);
    const record = state.records.get(taskId);
    if (!record || record.state === "reserved") return failure("no_live_controller");
    if (record.holder !== holder) return failure("holder_mismatch");
    if (record.state === "quarantined") return failure("recovery_quarantined");
    if (record.state === "recovering" || record.state === "finalizing") return failure("recovery_in_progress");
    if (record.state === "proved") {
      if (typeof source.durableCompletion !== "function") return failure("durable_completion_required");
      try {
        await source.durableCompletion();
      } catch (_) {
        return failure("durable_completion_failed");
      }
      this._forget(state, record);
      return recoverySuccess(record.usedSigkill);
    }
    if (record.state !== "tracked" || !directChild(record.child)) {
      record.state = "quarantined";
      return failure("no_live_controller");
    }

    record.state = "recovering";
    const child = record.child;
    let usedSigkill = false;
    let reaped = record.reaped;

    if (!reaped) {
      if (!this._signal(record, "SIGTERM")) {
        record.state = "quarantined";
        return failure("worker_could_not_be_terminated");
      }
      reaped = await this._waitForObservedExit(state, record, state.termTimeoutMs);
    }
    if (!reaped) {
      usedSigkill = true;
      if (!this._signal(record, "SIGKILL")) {
        record.state = "quarantined";
        return failure("worker_could_not_be_terminated");
      }
      reaped = await this._waitForObservedExit(state, record, state.killTimeoutMs);
    }
    if (!reaped) {
      record.state = "quarantined";
      return failure("worker_not_reaped");
    }
    if (!await this._proof(state, record)) {
      record.state = "quarantined";
      return failure("writable_bind_not_proven");
    }

    record.state = "proved";
    record.usedSigkill = usedSigkill;
    if (typeof source.durableCompletion !== "function") return failure("durable_completion_required");
    try {
      await source.durableCompletion();
    } catch (_) {
      return failure("durable_completion_failed");
    }
    this._forget(state, record);
    return recoverySuccess(usedSigkill);
  }
}

module.exports = { AutonomyRecoveryRegistry, waitForChildExit };
