"use strict";

// Phase 4's durable claim primitive. This file deliberately knows nothing about
// the board, scheduler, or lane pool: it provides the one narrow, atomic fact
// those layers need before they are allowed to launch an engine.
//
// A holder is an in-process capability, not a bearer value. Its private digest
// lives in a WeakMap; JSON responses contain only a display-only claim ref.

const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomBytes, timingSafeEqual } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const LIVE_STATES = new Set(["active", "running", "awaiting_review", "completed"]);
const EXTERNAL_TERMINAL_STATES = new Set(["done", "blocked"]);
const ALLOWED_TRANSITIONS = new Set([
  "active:running",
  "running:awaiting_review",
  "awaiting_review:completed",
]);
const SLEEP = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(milliseconds) {
  Atomics.wait(SLEEP, 0, 0, milliseconds);
}

function isBusy(error) {
  return /SQLITE_BUSY|database is locked|database is busy/i.test(String(error && error.message || error));
}

function opaqueRef() {
  return "clm_" + randomBytes(18).toString("base64url");
}

function digestPrivateToken() {
  // Keep the secret only long enough to derive its durable digest. The private
  // holder object's WeakMap entry is the scheduler's capability thereafter.
  const token = randomBytes(32).toString("base64url");
  return createHash("sha256").update(token).digest("hex");
}

function digestToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

function tokenDigestMatches(expected, token) {
  if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) return false;
  const actual = digestToken(token);
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
}

function publicResponse(status, summary, options = {}) {
  return {
    status,
    summary,
    nextActions: options.nextActions || [],
    artifacts: options.artifacts || [],
    launchPermitted: options.launchPermitted === true,
    ...(options.rootCause ? { rootCause: options.rootCause } : {}),
    ...(options.stopCondition ? { stopCondition: options.stopCondition } : {}),
    ...(options.claim ? { claim: options.claim } : {}),
  };
}

function attachPrivate(response, name, value) {
  Object.defineProperty(response, name, {
    value,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return response;
}

function unavailableResponse() {
  return publicResponse("error", "Claim store is unavailable; no engine may start.", {
    rootCause: "claim_store_unavailable",
    nextActions: ["Restore or inspect the claim store, then retry through the scheduler."],
    stopCondition: "Do not launch an engine.",
  });
}

function invalidRequest(summary) {
  return publicResponse("error", summary, {
    rootCause: "invalid_claim_request",
    nextActions: ["Correct the server-owned claim request before retrying."],
    stopCondition: "Do not launch an engine.",
  });
}

function staleHolderResponse() {
  return publicResponse("error", "Claim holder is stale or no longer owns this task.", {
    rootCause: "stale_holder",
    nextActions: ["Stop this worker and inspect the current scheduler claim."],
    stopCondition: "Do not change task state or launch another engine.",
  });
}

function validateTaskId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function validateEngine(value) {
  return typeof value === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(value);
}

function validateSupervisorToken(value) {
  return typeof value === "string" && value.length >= 32 && value.length <= 512
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function normalizeNow(value) {
  const now = value === undefined ? Date.now() : Number(value);
  return Number.isSafeInteger(now) && now >= 0 ? now : null;
}

function normalizeClaimRequest(request) {
  const source = request || {};
  const nowMs = normalizeNow(source.nowMs);
  const ttlMs = Number(source.ttlMs === undefined ? 60_000 : source.ttlMs);
  const generation = Number(source.schedulerGeneration === undefined ? 0 : source.schedulerGeneration);
  if (!validateTaskId(source.taskId)) return { error: "A valid task id is required." };
  if (!validateEngine(source.engine)) return { error: "A valid engine name is required." };
  if (nowMs === null) return { error: "A valid server time is required." };
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 24 * 60 * 60 * 1000) {
    return { error: "Claim TTL must be between one second and one day." };
  }
  if (!Number.isSafeInteger(generation) || generation < 0) {
    return { error: "Scheduler generation must be a non-negative integer." };
  }
  return { taskId: source.taskId, engine: source.engine, nowMs, ttlMs, generation };
}

function normalizeRecoveryRequest(request) {
  const source = request || {};
  const nowMs = normalizeNow(source.nowMs);
  if (nowMs === null) return { error: "A valid server time is required." };
  return { nowMs };
}

function normalizeExternalIdentity(request, options = {}) {
  const source = request || {};
  const nowMs = normalizeNow(source.nowMs);
  if (!validateTaskId(source.taskId)) return { error: "A valid task id is required." };
  if (options.claimId !== false
    && (typeof source.claimId !== "string" || !/^clm_[A-Za-z0-9_-]{12,120}$/.test(source.claimId))) {
    return { error: "A valid external claim id is required." };
  }
  if (!validateTaskId(source.supervisorId)) return { error: "A valid supervisor id is required." };
  if (!validateSupervisorToken(source.supervisorToken)) return { error: "A valid supervisor capability is required." };
  if (!validateTaskId(source.roomId)) return { error: "A valid room id is required." };
  if (nowMs === null) return { error: "A valid server time is required." };
  if (options.objective === true
    && (typeof source.objectiveDigest !== "string" || !/^[a-f0-9]{64}$/.test(source.objectiveDigest))) {
    return { error: "A valid objective digest is required." };
  }
  return {
    taskId: source.taskId,
    ...(options.claimId === false ? {} : { claimId: source.claimId }),
    supervisorId: source.supervisorId,
    supervisorToken: source.supervisorToken,
    roomId: source.roomId,
    ...(options.objective === true ? { objectiveDigest: source.objectiveDigest } : {}),
    nowMs,
  };
}

function externalSupervisorMismatch() {
  return publicResponse("error", "External claim belongs to another supervisor or room.", {
    rootCause: "external_supervisor_mismatch",
    nextActions: ["Use the original room supervisor and its private capability."],
    stopCondition: "Do not renew, recover, or replace this claim.",
  });
}

function externalClaimExpired(claimRef) {
  return publicResponse("error", `External claim ${claimRef} has expired and requires recovery.`, {
    rootCause: "external_claim_expired",
    nextActions: ["Kill and reap the old worker, revoke its writable bind, then recover with the original supervisor capability."],
    stopCondition: "Do not revive or replace this external worker.",
    artifacts: [{ type: "claim", id: claimRef }],
  });
}

class ClaimStore {
  constructor(file, options = {}) {
    this.file = String(file || "");
    this.busyTimeoutMs = Number.isSafeInteger(options.busyTimeoutMs) ? options.busyTimeoutMs : 5_000;
    this.maxBusyRetries = Number.isSafeInteger(options.maxBusyRetries) ? options.maxBusyRetries : 12;
    this._holders = new WeakMap();
    this._recoveries = new WeakMap();
    this._db = null;
    this._initError = false;

    try {
      if (!this.file || !fs.existsSync(path.dirname(this.file))) throw new Error("claim store directory unavailable");
      this._db = new DatabaseSync(this.file);
      this._db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.min(this.busyTimeoutMs, 60_000))}`);
      // Durability pragmas belong on EVERY connection, so they are set here and
      // not in _createSchema() -- which is skipped entirely under
      // `initialize: false`.
      //
      // journal_mode is persisted in the database header, so re-stating it is
      // idempotent; it matters for a FRESH file opened without initialization,
      // which would otherwise sit in rollback-journal mode with different crash
      // semantics than the rest of the box assumes.
      this._db.exec("PRAGMA journal_mode = WAL");
      // synchronous is NOT persisted -- it is per-connection and reverts to the
      // library default on every open. Nothing set it, so the claim store's
      // durability was an inherited default rather than a stated invariant, and
      // an upstream default change (or a stray `PRAGMA synchronous=NORMAL`)
      // would weaken it silently with no test to catch it. FULL fsyncs the WAL
      // on every commit, which is what "a durable claim" has to mean when the
      // board is the accountability layer (ADR-2302).
      this._db.exec("PRAGMA synchronous = FULL");
      if (options.initialize !== false) this._createSchema();
    } catch (_) {
      this._initError = true;
      try { this._db && this._db.close(); } catch (_) { /* fail closed */ }
      this._db = null;
    }
  }

  _createSchema() {
    this._db.exec("PRAGMA journal_mode = WAL");
    this._transaction(() => {
      this._db.exec(`
        CREATE TABLE IF NOT EXISTS claims (
          task_id TEXT PRIMARY KEY,
          claim_ref TEXT NOT NULL UNIQUE,
          token_digest TEXT NOT NULL,
          engine TEXT NOT NULL,
          acquired_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          scheduler_generation INTEGER NOT NULL,
          state TEXT NOT NULL,
          version INTEGER NOT NULL,
          recovery_killed_at INTEGER,
          recovery_reaped_at INTEGER,
          recovery_bind_revoked_at INTEGER,
          claim_type TEXT NOT NULL DEFAULT 'in_box',
          supervisor_id TEXT,
          supervisor_token_digest TEXT,
          room_id TEXT,
          objective_digest TEXT,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS claims_state_expiry_idx ON claims(state, expires_at);
        CREATE TABLE IF NOT EXISTS external_claim_receipts (
          task_id TEXT NOT NULL,
          claim_ref TEXT NOT NULL,
          supervisor_id TEXT NOT NULL,
          supervisor_token_digest TEXT NOT NULL,
          room_id TEXT NOT NULL,
          terminal_status TEXT NOT NULL,
          released_at INTEGER NOT NULL,
          PRIMARY KEY (task_id, claim_ref)
        );
      `);
      const columns = new Set(
        this._db.prepare("PRAGMA table_info(claims)").all().map((column) => column.name),
      );
      const additions = [
        ["claim_type", "TEXT NOT NULL DEFAULT 'in_box'"],
        ["supervisor_id", "TEXT"],
        ["supervisor_token_digest", "TEXT"],
        ["room_id", "TEXT"],
        ["objective_digest", "TEXT"],
      ];
      for (const [name, type] of additions) {
        if (!columns.has(name)) this._db.exec(`ALTER TABLE claims ADD COLUMN ${name} ${type}`);
      }
    });
  }

  _transaction(work) {
    let lastError;
    for (let attempt = 0; attempt <= this.maxBusyRetries; attempt += 1) {
      let begun = false;
      try {
        this._db.exec("BEGIN IMMEDIATE");
        begun = true;
        const value = work();
        this._db.exec("COMMIT");
        return value;
      } catch (error) {
        lastError = error;
        if (begun) {
          try { this._db.exec("ROLLBACK"); } catch (_) { /* fail closed below */ }
        }
        if (!isBusy(error) || attempt === this.maxBusyRetries) throw error;
        sleepSync(Math.min(5 * (attempt + 1), 50));
      }
    }
    throw lastError;
  }

  _claimRow(taskId) {
    return this._db.prepare(`
      SELECT task_id, claim_ref, token_digest, engine, acquired_at, expires_at,
             scheduler_generation, state, version, recovery_killed_at,
             recovery_reaped_at, recovery_bind_revoked_at, claim_type,
             supervisor_id, supervisor_token_digest, room_id, objective_digest,
             updated_at
      FROM claims WHERE task_id = ?
    `).get(taskId);
  }

  _externalReceiptRow(taskId, claimRef) {
    return this._db.prepare(`
      SELECT task_id, claim_ref, supervisor_id, supervisor_token_digest,
             room_id, terminal_status, released_at
      FROM external_claim_receipts
      WHERE task_id = ? AND claim_ref = ?
    `).get(taskId, claimRef);
  }

  _externalReceiptForRoom(taskId) {
    return this._db.prepare(`
      SELECT task_id, claim_ref, supervisor_id, supervisor_token_digest,
             room_id, terminal_status, released_at
      FROM external_claim_receipts
      WHERE task_id = ?
      ORDER BY released_at DESC
      LIMIT 1
    `).get(taskId);
  }

  _privateHolder(row) {
    const holder = Object.freeze({ claimRef: row.claim_ref });
    this._holders.set(holder, {
      taskId: row.task_id,
      claimRef: row.claim_ref,
      tokenDigest: row.token_digest,
      version: row.version,
      claimType: row.claim_type || "in_box",
      supervisorId: row.supervisor_id || null,
      supervisorTokenDigest: row.supervisor_token_digest || null,
      roomId: row.room_id || null,
      objectiveDigest: row.objective_digest || null,
    });
    return holder;
  }

  _privateRecovery(row) {
    const recovery = Object.freeze({ claimRef: row.claim_ref });
    this._recoveries.set(recovery, {
      taskId: row.task_id,
      claimRef: row.claim_ref,
      version: row.version,
      claimType: row.claim_type || "in_box",
      supervisorId: row.supervisor_id || null,
      supervisorTokenDigest: row.supervisor_token_digest || null,
      roomId: row.room_id || null,
      objectiveDigest: row.objective_digest || null,
    });
    return recovery;
  }

  _claimArtifact(claimRef) {
    return [{ type: "claim", id: claimRef }];
  }

  _acquiredResponse(row, holder) {
    const response = publicResponse("success",
      `${row.engine} claimed task ${row.task_id} until ${new Date(row.expires_at).toISOString()}.`, {
        artifacts: this._claimArtifact(row.claim_ref),
        launchPermitted: true,
      });
    return attachPrivate(response, "holder", holder);
  }

  health() {
    if (!this._db || this._initError) return unavailableResponse();
    try {
      const row = this._db.prepare("SELECT 1 AS healthy FROM claims LIMIT 1").get();
      if (row && row.healthy !== 1) throw new Error("unexpected health result");
      return publicResponse("success", "Claim store is healthy.", {
        nextActions: [],
        artifacts: [{ type: "claim_store", id: this.file }],
      });
    } catch (_) {
      return unavailableResponse();
    }
  }

  inspect(taskId) {
    if (!this._db || this._initError) return unavailableResponse();
    if (!validateTaskId(taskId)) return invalidRequest("A valid task id is required.");
    try {
      const row = this._claimRow(taskId);
      if (!row) {
        return publicResponse("warning", `No claim exists for task ${taskId}.`, {
          rootCause: "claim_not_found",
          nextActions: ["Claim the queued task through the scheduler before launching work."],
          artifacts: [],
        });
      }
      return publicResponse("success", `Claim ${row.claim_ref} is ${row.state}.`, {
        artifacts: this._claimArtifact(row.claim_ref),
        claim: {
          taskId: row.task_id,
          engine: row.engine,
          acquiredAt: row.acquired_at,
          expiresAt: row.expires_at,
          schedulerGeneration: row.scheduler_generation,
          state: row.state,
          claimType: row.claim_type || "in_box",
          ...(row.claim_type === "external" ? {
            supervisorId: row.supervisor_id,
            roomId: row.room_id,
            objectiveDigest: row.objective_digest,
          } : {}),
          recovery: {
            workerKilled: row.recovery_killed_at !== null,
            workerReaped: row.recovery_reaped_at !== null,
            writableBindRevoked: row.recovery_bind_revoked_at !== null,
          },
        },
      });
    } catch (_) {
      return unavailableResponse();
    }
  }

  // Gate-only holder check for async scheduler callbacks. Unlike inspect(),
  // this proves the non-serializable holder still matches the durable row's
  // private digest and version, so an old worker cannot pass after recovery
  // replaces the claim. It deliberately returns only a boolean.
  isCurrent(holder, request = {}) {
    if (!this._db || this._initError) return false;
    const privateHolder = this._holders.get(holder);
    const source = request || {};
    const nowMs = normalizeNow(source.nowMs === undefined ? Date.now() : source.nowMs);
    const taskId = source.taskId === undefined ? privateHolder && privateHolder.taskId : source.taskId;
    const state = source.state;
    if (!privateHolder || nowMs === null || taskId !== privateHolder.taskId || (state !== undefined && typeof state !== "string")) return false;
    try {
      return this._transaction(() => {
        const row = this._claimRow(privateHolder.taskId);
        return !!(row && row.claim_ref === privateHolder.claimRef && row.token_digest === privateHolder.tokenDigest &&
          row.version === privateHolder.version && LIVE_STATES.has(row.state) && row.expires_at > nowMs &&
          (state === undefined || row.state === state));
      });
    } catch (_) {
      return false;
    }
  }

  tryAcquire(request) {
    if (!this._db || this._initError) return unavailableResponse();
    const input = normalizeClaimRequest(request);
    if (input.error) return invalidRequest(input.error);
    try {
      return this._transaction(() => {
        const existing = this._claimRow(input.taskId);
        if (existing) {
          if (LIVE_STATES.has(existing.state) && existing.expires_at > input.nowMs) {
            return publicResponse("error", `Task ${input.taskId} is already claimed.`, {
              rootCause: "already_claimed",
              nextActions: ["Wait for the current claim to release or enter verified recovery."],
              stopCondition: "Do not launch an engine.",
            });
          }
          if (LIVE_STATES.has(existing.state)) {
            return publicResponse("error", `Task ${input.taskId} has an expired claim awaiting recovery.`, {
              rootCause: "expired_claim_requires_recovery",
              nextActions: ["Kill and reap the old worker, revoke its writable bind, then reclaim through recovery."],
              stopCondition: "Do not launch an engine.",
              artifacts: this._claimArtifact(existing.claim_ref),
            });
          }
          if (existing.state === "recovering") {
            return publicResponse("error", `Task ${input.taskId} is quarantined for claim recovery.`, {
              rootCause: "recovery_in_progress",
              nextActions: ["Finish verified recovery before requesting a replacement claim."],
              stopCondition: "Do not launch an engine.",
              artifacts: this._claimArtifact(existing.claim_ref),
            });
          }
          return publicResponse("error", `Task ${input.taskId} has an invalid claim record.`, {
            rootCause: "claim_record_invalid",
            nextActions: ["Inspect and repair the claim store before retrying."],
            stopCondition: "Do not launch an engine.",
          });
        }

        const row = {
          task_id: input.taskId,
          claim_ref: opaqueRef(),
          token_digest: digestPrivateToken(),
          engine: input.engine,
          acquired_at: input.nowMs,
          expires_at: input.nowMs + input.ttlMs,
          scheduler_generation: input.generation,
          state: "active",
          version: 1,
          claim_type: "in_box",
          supervisor_id: null,
          supervisor_token_digest: null,
          room_id: null,
          objective_digest: null,
          updated_at: input.nowMs,
        };
        this._db.prepare(`
          INSERT INTO claims (
            task_id, claim_ref, token_digest, engine, acquired_at, expires_at,
            scheduler_generation, state, version, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          row.task_id, row.claim_ref, row.token_digest, row.engine, row.acquired_at,
          row.expires_at, row.scheduler_generation, row.state, row.version, row.updated_at,
        );
        return this._acquiredResponse(row, this._privateHolder(row));
      });
    } catch (_) {
      return unavailableResponse();
    }
  }

  // External workers can outlive this gateway process and even the box. Their
  // durable row therefore carries a type plus the exact desktop supervisor,
  // room, objective, and a digest of a room-private capability. The capability
  // is supplied by the supervisor so a lost create response never loses the
  // only recovery authority.
  tryAcquireExternal(request) {
    if (!this._db || this._initError) return unavailableResponse();
    const claim = normalizeClaimRequest(request);
    if (claim.error) return invalidRequest(claim.error);
    const identity = normalizeExternalIdentity(request, { claimId: false, objective: true });
    if (identity.error) return invalidRequest(identity.error);
    try {
      return this._transaction(() => {
        const existing = this._claimRow(claim.taskId);
        if (existing) {
          if (LIVE_STATES.has(existing.state) && existing.expires_at > claim.nowMs) {
            return publicResponse("error", `Task ${claim.taskId} is already claimed.`, {
              rootCause: "already_claimed",
              nextActions: ["Reattach with the original supervisor capability or wait for verified recovery."],
              stopCondition: "Do not launch another engine.",
              artifacts: this._claimArtifact(existing.claim_ref),
            });
          }
          return publicResponse("error", `Task ${claim.taskId} has protected scheduler ownership.`, {
            rootCause: existing.state === "recovering"
              ? "recovery_in_progress"
              : "expired_claim_requires_recovery",
            nextActions: ["Recover the existing claim through its current owner."],
            stopCondition: "Do not launch another engine.",
            artifacts: this._claimArtifact(existing.claim_ref),
          });
        }

        const row = {
          task_id: claim.taskId,
          claim_ref: opaqueRef(),
          token_digest: digestPrivateToken(),
          engine: claim.engine,
          acquired_at: claim.nowMs,
          expires_at: claim.nowMs + claim.ttlMs,
          scheduler_generation: claim.generation,
          state: "active",
          version: 1,
          claim_type: "external",
          supervisor_id: identity.supervisorId,
          supervisor_token_digest: digestToken(identity.supervisorToken),
          room_id: identity.roomId,
          objective_digest: identity.objectiveDigest,
          updated_at: claim.nowMs,
        };
        this._db.prepare(`
          INSERT INTO claims (
            task_id, claim_ref, token_digest, engine, acquired_at, expires_at,
            scheduler_generation, state, version, claim_type, supervisor_id,
            supervisor_token_digest, room_id, objective_digest, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          row.task_id, row.claim_ref, row.token_digest, row.engine, row.acquired_at,
          row.expires_at, row.scheduler_generation, row.state, row.version,
          row.claim_type, row.supervisor_id, row.supervisor_token_digest,
          row.room_id, row.objective_digest, row.updated_at,
        );
        return this._acquiredResponse(row, this._privateHolder(row));
      });
    } catch (_) {
      return unavailableResponse();
    }
  }

  _externalRowMatches(row, input) {
    return !!(row
      && row.claim_type === "external"
      && row.claim_ref === input.claimId
      && row.supervisor_id === input.supervisorId
      && row.room_id === input.roomId
      && tokenDigestMatches(row.supervisor_token_digest, input.supervisorToken));
  }

  _externalReceiptMatches(row, input) {
    return !!(row
      && row.claim_ref === input.claimId
      && row.supervisor_id === input.supervisorId
      && row.room_id === input.roomId
      && tokenDigestMatches(row.supervisor_token_digest, input.supervisorToken));
  }

  _insertExternalReceipt(row, terminalStatus, releasedAt) {
    this._db.prepare(`
      INSERT INTO external_claim_receipts (
        task_id, claim_ref, supervisor_id, supervisor_token_digest,
        room_id, terminal_status, released_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.task_id,
      row.claim_ref,
      row.supervisor_id,
      row.supervisor_token_digest,
      row.room_id,
      terminalStatus,
      releasedAt,
    );
  }

  inspectExternalReceipt(request = {}) {
    if (!this._db || this._initError) return unavailableResponse();
    const input = normalizeExternalIdentity(request);
    if (input.error) return invalidRequest(input.error);
    try {
      const row = this._externalReceiptRow(input.taskId, input.claimId);
      if (!row) {
        return publicResponse("warning", "No terminal receipt exists for this external claim.", {
          rootCause: "external_receipt_not_found",
          stopCondition: "Do not clear local quarantine.",
        });
      }
      if (!this._externalReceiptMatches(row, input)) return externalSupervisorMismatch();
      if (!EXTERNAL_TERMINAL_STATES.has(row.terminal_status)) {
        return publicResponse("error", "External claim receipt has an invalid terminal state.", {
          rootCause: "claim_record_invalid",
          stopCondition: "Do not clear local quarantine.",
        });
      }
      return {
        ...publicResponse("success", `External claim ${row.claim_ref} is already terminal.`, {
          artifacts: this._claimArtifact(row.claim_ref),
        }),
        receipt: {
          taskId: row.task_id,
          claimId: row.claim_ref,
          supervisorId: row.supervisor_id,
          roomId: row.room_id,
          status: row.terminal_status,
          releasedAt: row.released_at,
        },
      };
    } catch (_) {
      return unavailableResponse();
    }
  }

  inspectExternalReceiptForRoom(request = {}) {
    if (!this._db || this._initError) return unavailableResponse();
    const input = normalizeExternalIdentity(request, { claimId: false });
    if (input.error) return invalidRequest(input.error);
    try {
      const row = this._externalReceiptForRoom(input.taskId);
      if (!row) {
        return publicResponse("warning", "No terminal receipt exists for this external room.", {
          rootCause: "external_receipt_not_found",
          stopCondition: "Do not create replacement ownership without checking the canonical task.",
        });
      }
      if (row.supervisor_id !== input.supervisorId
          || row.room_id !== input.roomId
          || !tokenDigestMatches(row.supervisor_token_digest, input.supervisorToken)
          || !EXTERNAL_TERMINAL_STATES.has(row.terminal_status)) {
        return externalSupervisorMismatch();
      }
      return {
        ...publicResponse("success", `External claim ${row.claim_ref} is already terminal.`, {
          artifacts: this._claimArtifact(row.claim_ref),
        }),
        receipt: {
          taskId: row.task_id,
          claimId: row.claim_ref,
          supervisorId: row.supervisor_id,
          roomId: row.room_id,
          status: row.terminal_status,
          releasedAt: row.released_at,
        },
      };
    } catch (_) {
      return unavailableResponse();
    }
  }

  // A fresh gateway may adopt only the SAME still-live external lease. The
  // version CAS invalidates every holder from the previous process, while the
  // expiry remains untouched: reattach is continuity, never lease revival.
  reattachExternal(request) {
    if (!this._db || this._initError) return unavailableResponse();
    const input = normalizeExternalIdentity(request);
    if (input.error) return invalidRequest(input.error);
    try {
      return this._transaction(() => {
        const row = this._claimRow(input.taskId);
        if (!this._externalRowMatches(row, input)) return externalSupervisorMismatch();
        if (!LIVE_STATES.has(row.state)) {
          return publicResponse("error", `External claim ${row.claim_ref} is already recovering.`, {
            rootCause: "external_recovery_required",
            nextActions: ["Resume recovery with the original supervisor capability."],
            stopCondition: "Do not renew or replace this claim.",
            artifacts: this._claimArtifact(row.claim_ref),
          });
        }
        if (row.expires_at <= input.nowMs) return externalClaimExpired(row.claim_ref);
        const changed = this._db.prepare(`
          UPDATE claims SET version = version + 1, updated_at = ?
          WHERE task_id = ? AND claim_ref = ? AND version = ?
            AND claim_type = 'external' AND expires_at > ?
        `).run(input.nowMs, row.task_id, row.claim_ref, row.version, input.nowMs);
        if (changed.changes !== 1) return staleHolderResponse();
        const attached = { ...row, version: row.version + 1, updated_at: input.nowMs };
        const response = publicResponse("success",
          `External claim ${row.claim_ref} reattached to supervisor ${row.supervisor_id}.`, {
            artifacts: this._claimArtifact(row.claim_ref),
            claim: {
              taskId: row.task_id,
              engine: row.engine,
              expiresAt: row.expires_at,
              state: row.state,
              claimType: "external",
              supervisorId: row.supervisor_id,
              roomId: row.room_id,
              objectiveDigest: row.objective_digest,
            },
          });
        return attachPrivate(response, "holder", this._privateHolder(attached));
      });
    } catch (_) {
      return unavailableResponse();
    }
  }

  isExternalCurrent(holder, request = {}) {
    const privateHolder = this._holders.get(holder);
    const input = normalizeExternalIdentity({
      ...request,
      claimId: privateHolder && privateHolder.claimRef,
    });
    if (input.error || !privateHolder
      || privateHolder.claimType !== "external"
      || privateHolder.supervisorId !== input.supervisorId
      || privateHolder.roomId !== input.roomId
      || !tokenDigestMatches(privateHolder.supervisorTokenDigest, input.supervisorToken)) {
      return false;
    }
    return this.isCurrent(holder, request);
  }

  // Recovery after a gateway restart does not depend on an in-memory holder.
  // The exact persisted external capability atomically invalidates the prior
  // holder/recovery and may proceed only after lease expiry. A recovering row
  // can be resumed by the same supervisor after another restart.
  beginExternalRecovery(request = {}) {
    if (!this._db || this._initError) return unavailableResponse();
    const input = normalizeExternalIdentity(request);
    if (input.error) return invalidRequest(input.error);
    try {
      return this._transaction(() => {
        const row = this._claimRow(input.taskId);
        if (!this._externalRowMatches(row, input)) return externalSupervisorMismatch();
        if (LIVE_STATES.has(row.state) && row.expires_at > input.nowMs) {
          return publicResponse("error", `External claim ${row.claim_ref} is still live.`, {
            rootCause: "claim_not_expired",
            nextActions: ["Keep the current lease or wait for it to expire."],
            stopCondition: "Do not recover or replace a live worker.",
            artifacts: this._claimArtifact(row.claim_ref),
          });
        }
        if (!LIVE_STATES.has(row.state) && row.state !== "recovering") {
          return publicResponse("error", `External claim ${row.claim_ref} cannot enter recovery.`, {
            rootCause: "claim_record_invalid",
            stopCondition: "Do not recover or replace this worker.",
            artifacts: this._claimArtifact(row.claim_ref),
          });
        }
        const changed = this._db.prepare(`
          UPDATE claims SET state = 'recovering', version = version + 1, updated_at = ?
          WHERE task_id = ? AND claim_ref = ? AND version = ?
            AND claim_type = 'external'
            AND (state = 'recovering' OR expires_at <= ?)
        `).run(input.nowMs, row.task_id, row.claim_ref, row.version, input.nowMs);
        if (changed.changes !== 1) return staleHolderResponse();
        const recovering = {
          ...row,
          state: "recovering",
          version: row.version + 1,
          updated_at: input.nowMs,
        };
        const response = publicResponse("warning",
          `External claim ${row.claim_ref} is quarantined for supervisor recovery.`, {
            nextActions: ["Kill and reap the worker, revoke its writable bind, and record all three facts."],
            stopCondition: "Do not launch an engine until recovery is complete.",
            artifacts: this._claimArtifact(row.claim_ref),
          });
        return attachPrivate(response, "recovery", this._privateRecovery(recovering));
      });
    } catch (_) {
      return unavailableResponse();
    }
  }

  transition(holder, request) {
    if (!this._db || this._initError) return unavailableResponse();
    const privateHolder = this._holders.get(holder);
    const source = request || {};
    const nowMs = normalizeNow(source.nowMs);
    const from = source.from;
    const to = source.to;
    if (!privateHolder) return staleHolderResponse();
    if (nowMs === null || !ALLOWED_TRANSITIONS.has(`${from}:${to}`)) {
      return invalidRequest("A valid claim state transition is required.");
    }
    try {
      return this._transaction(() => {
        const row = this._claimRow(privateHolder.taskId);
        if (!row || row.claim_ref !== privateHolder.claimRef || row.token_digest !== privateHolder.tokenDigest ||
            row.version !== privateHolder.version || row.state !== from) {
          return staleHolderResponse();
        }
        if (row.expires_at <= nowMs) {
          return publicResponse("error", `Claim ${row.claim_ref} has expired and requires recovery.`, {
            rootCause: "claim_expired",
            nextActions: ["Kill and reap the old worker, revoke its writable bind, then recover the claim."],
            stopCondition: "Do not advance task state or launch an engine.",
            artifacts: this._claimArtifact(row.claim_ref),
          });
        }
        const update = this._db.prepare(`
          UPDATE claims SET state = ?, version = version + 1, updated_at = ?
          WHERE task_id = ? AND claim_ref = ? AND token_digest = ? AND version = ? AND state = ?
        `).run(to, nowMs, row.task_id, row.claim_ref, row.token_digest, row.version, from);
        if (update.changes !== 1) return staleHolderResponse();
        this._holders.set(holder, { ...privateHolder, version: privateHolder.version + 1 });
        return publicResponse("success", `Claim ${row.claim_ref} advanced to ${to}.`, {
          artifacts: this._claimArtifact(row.claim_ref),
        });
      });
    } catch (_) {
      return unavailableResponse();
    }
  }

  // A live external scheduler proves continued ownership with a heartbeat.
  // Renewal is capability-bound to the same private in-process holder as every
  // state transition: the public claim ref is deliberately not a bearer token.
  renew(holder, request = {}) {
    if (!this._db || this._initError) return unavailableResponse();
    const privateHolder = this._holders.get(holder);
    const nowMs = normalizeNow(request.nowMs);
    const ttlMs = Number(request.ttlMs);
    if (!privateHolder) return staleHolderResponse();
    if (nowMs === null || !Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 24 * 60 * 60 * 1000) {
      return invalidRequest("A valid server time and claim TTL are required.");
    }
    try {
      return this._transaction(() => {
        const row = this._claimRow(privateHolder.taskId);
        if (!row || row.claim_ref !== privateHolder.claimRef || row.token_digest !== privateHolder.tokenDigest ||
            row.version !== privateHolder.version || !LIVE_STATES.has(row.state)) {
          return staleHolderResponse();
        }
        if (row.expires_at <= nowMs) {
          return publicResponse("error", `Claim ${row.claim_ref} has expired and requires recovery.`, {
            rootCause: "claim_expired",
            nextActions: ["Stop the external worker and complete verified recovery before replacing it."],
            stopCondition: "Do not renew or replace this claim directly.",
            artifacts: this._claimArtifact(row.claim_ref),
          });
        }
        const expiresAt = nowMs + ttlMs;
        const changed = this._db.prepare(`
          UPDATE claims
          SET expires_at = ?, version = version + 1, updated_at = ?
          WHERE task_id = ? AND claim_ref = ? AND token_digest = ? AND version = ? AND state = ?
        `).run(
          expiresAt, nowMs, row.task_id, row.claim_ref, row.token_digest,
          row.version, row.state,
        );
        if (changed.changes !== 1) return staleHolderResponse();
        this._holders.set(holder, { ...privateHolder, version: privateHolder.version + 1 });
        return publicResponse("success",
          `Claim ${row.claim_ref} renewed until ${new Date(expiresAt).toISOString()}.`, {
            artifacts: this._claimArtifact(row.claim_ref),
            claim: {
              taskId: row.task_id,
              engine: row.engine,
              expiresAt,
              state: row.state,
            },
          });
      });
    } catch (_) {
      return unavailableResponse();
    }
  }

  release(holder, request = {}) {
    if (!this._db || this._initError) return unavailableResponse();
    const privateHolder = this._holders.get(holder);
    const nowMs = normalizeNow(request.nowMs);
    if (!privateHolder) return staleHolderResponse();
    if (nowMs === null) return invalidRequest("A valid server time is required.");
    try {
      return this._transaction(() => {
        const row = this._claimRow(privateHolder.taskId);
        if (!row || row.claim_ref !== privateHolder.claimRef || row.token_digest !== privateHolder.tokenDigest ||
            row.version !== privateHolder.version || !LIVE_STATES.has(row.state)) {
          return staleHolderResponse();
        }
        if (row.expires_at <= nowMs) {
          return publicResponse("error", `Claim ${row.claim_ref} has expired and requires recovery.`, {
            rootCause: "claim_expired",
            nextActions: ["Recover the expired claim before allocating new work."],
            stopCondition: "Do not release or replace this claim directly.",
            artifacts: this._claimArtifact(row.claim_ref),
          });
        }
        const deleted = this._db.prepare(`
          DELETE FROM claims
          WHERE task_id = ? AND claim_ref = ? AND token_digest = ? AND version = ?
        `).run(row.task_id, row.claim_ref, row.token_digest, row.version);
        if (deleted.changes !== 1) return staleHolderResponse();
        this._holders.delete(holder);
        return publicResponse("success", `Claim ${row.claim_ref} released.`, {
          artifacts: this._claimArtifact(row.claim_ref),
        });
      });
    } catch (_) {
      return unavailableResponse();
    }
  }

  // A terminal external release is one atomic durable fact: the live claim is
  // replaced by an exact supervisor-capability receipt. If the HTTP response
  // or desktop marker cleanup is interrupted, that same supervisor can safely
  // prove the already-finished release without reviving or duplicating work.
  releaseExternalTerminal(holder, request = {}) {
    if (!this._db || this._initError) return unavailableResponse();
    const privateHolder = this._holders.get(holder);
    const nowMs = normalizeNow(request.nowMs);
    const terminalStatus = String(request.status || "");
    if (!privateHolder || privateHolder.claimType !== "external") return staleHolderResponse();
    if (nowMs === null || !EXTERNAL_TERMINAL_STATES.has(terminalStatus)) {
      return invalidRequest("A valid external terminal release is required.");
    }
    try {
      return this._transaction(() => {
        const row = this._claimRow(privateHolder.taskId);
        if (!row || row.claim_type !== "external"
            || row.claim_ref !== privateHolder.claimRef
            || row.token_digest !== privateHolder.tokenDigest
            || row.version !== privateHolder.version
            || !LIVE_STATES.has(row.state)) {
          return staleHolderResponse();
        }
        if (row.expires_at <= nowMs) return externalClaimExpired(row.claim_ref);
        this._insertExternalReceipt(row, terminalStatus, nowMs);
        const deleted = this._db.prepare(`
          DELETE FROM claims
          WHERE task_id = ? AND claim_ref = ? AND token_digest = ? AND version = ?
            AND claim_type = 'external'
        `).run(row.task_id, row.claim_ref, row.token_digest, row.version);
        if (deleted.changes !== 1) return staleHolderResponse();
        this._holders.delete(holder);
        return publicResponse("success", `External claim ${row.claim_ref} released as ${terminalStatus}.`, {
          artifacts: this._claimArtifact(row.claim_ref),
        });
      });
    } catch (_) {
      return unavailableResponse();
    }
  }

  // Boot-time reconciliation (2026-07-27, hardened same day per adversarial
  // review). Recovery below is capability-bound to the in-memory holder, so
  // an in-box claim orphaned by a MACHINE reboot is unrecoverable through beginRecovery
  // forever: the only authorized process died with the machine. The safety
  // proof deliberately does NOT rest on process topology (under Foundation B
  // the gate is an independently-restartable child, so "the gate constructed a
  // fresh store" no longer implies "the old worker is dead"). Instead it rests
  // on the MACHINE BOOT CUTOFF the caller supplies: a claim ACQUIRED before
  // the current machine boot cannot have a live IN-BOX worker, because every
  // process,
  // namespace, and writable bind died with the previous machine — that is a
  // fact of the reboot, not an assumption about who restarts whom. External
  // desktop workers are explicitly excluded: they can outlive a box reboot and
  // remain bound to their persisted supervisor capability. Every in-box claim
  // acquired before the current machine boot is dead regardless of remaining
  // TTL; an in-box claim acquired after this machine booted is NEVER reaped:
  // a gate-only restart leaves it quarantined exactly as Package 1 always has
  // (the still-possibly-alive worker keeps its protection).
  // Reaping deletes the row (mirroring release()); the caller records each
  // reap in the append-only audit log, where the trail belongs. Live incident
  // this ends: four launch-morning reboots left four zombie claims, the
  // dispatcher was denied every 30s for hours, and the queue head deadlocked.
  // CONTRACT: call exactly once, immediately after construction, before any
  // scheduler tick or claim is issued, with machineBootMs derived from the
  // machine's real uptime (not the process's). Unknown boot time reaps
  // nothing (fail closed).
  reapExpiredAtBoot(nowMs, machineBootMs) {
    if (!this._db || this._initError) return [];
    const now = normalizeNow(nowMs);
    const bootMs = normalizeNow(machineBootMs);
    if (now === null || bootMs === null || bootMs > now) return [];
    try {
      return this._transaction(() => {
        const states = [...LIVE_STATES, "recovering"];
        const rows = this._db.prepare(`
          SELECT task_id, claim_ref, engine, state, expires_at FROM claims
          WHERE claim_type = 'in_box'
            AND state IN (${states.map(() => "?").join(", ")})
            AND acquired_at < ?
        `).all(...states, bootMs);
        if (!rows.length) return [];
        const del = this._db.prepare("DELETE FROM claims WHERE task_id = ? AND claim_ref = ?");
        for (const row of rows) del.run(row.task_id, row.claim_ref);
        return rows.map((r) => ({ taskId: r.task_id, claimRef: r.claim_ref, engine: r.engine, state: r.state, expiresAt: r.expires_at }));
      });
    } catch (_) {
      return []; // fail closed: an unreapable store keeps its quarantine, as before
    }
  }

  // Recovery is deliberately capability-bound. The durable row tells a fresh
  // scheduler that a claim is quarantined; it never grants that scheduler the
  // authority to adopt or reclaim the old worker. Only the process that still
  // owns this exact in-memory holder can start recovery.
  beginRecovery(holder, request = {}) {
    if (!this._db || this._initError) return unavailableResponse();
    const privateHolder = this._holders.get(holder);
    const input = normalizeRecoveryRequest(request);
    if (!privateHolder) return staleHolderResponse();
    if (input.error) return invalidRequest(input.error);
    try {
      return this._transaction(() => {
        const row = this._claimRow(privateHolder.taskId);
        if (!row || row.claim_ref !== privateHolder.claimRef || row.token_digest !== privateHolder.tokenDigest ||
            row.version !== privateHolder.version || !LIVE_STATES.has(row.state)) {
          return staleHolderResponse();
        }
        if (row.expires_at > input.nowMs) {
          return publicResponse("error", `Claim ${row.claim_ref} is not eligible for recovery.`, {
            rootCause: "claim_not_expired",
            nextActions: ["Keep the live claim in place until it expires or is released by its holder."],
            stopCondition: "Do not launch an engine.",
            artifacts: this._claimArtifact(row.claim_ref),
          });
        }
        const changed = this._db.prepare(`
          UPDATE claims SET state = 'recovering', version = version + 1, updated_at = ?
          WHERE task_id = ? AND claim_ref = ? AND token_digest = ? AND version = ? AND state = ? AND expires_at <= ?
        `).run(input.nowMs, row.task_id, row.claim_ref, row.token_digest, row.version, row.state, input.nowMs);
        if (changed.changes !== 1) return staleHolderResponse();
        const recovering = { ...row, state: "recovering", version: row.version + 1 };
        this._holders.delete(holder);
        const response = publicResponse("warning", `Expired claim ${row.claim_ref} is quarantined for recovery.`, {
          nextActions: ["Kill and reap the old worker, revoke its writable bind, and record all three facts."],
          stopCondition: "Do not launch an engine until recovery is complete.",
          artifacts: this._claimArtifact(row.claim_ref),
        });
        return attachPrivate(response, "recovery", this._privateRecovery(recovering));
      });
    } catch (_) {
      return unavailableResponse();
    }
  }

  recordRecovery(recovery, request = {}) {
    if (!this._db || this._initError) return unavailableResponse();
    const privateRecovery = this._recoveries.get(recovery);
    const nowMs = normalizeNow(request.nowMs);
    const workerKilled = request.workerKilled === true;
    const workerReaped = request.workerReaped === true;
    const writableBindRevoked = request.writableBindRevoked === true;
    if (!privateRecovery) return staleHolderResponse();
    if (nowMs === null || (!workerKilled && !workerReaped && !writableBindRevoked)) {
      return invalidRequest("Record at least one verified recovery action with a valid server time.");
    }
    try {
      return this._transaction(() => {
        const row = this._claimRow(privateRecovery.taskId);
        if (!row || row.claim_ref !== privateRecovery.claimRef || row.version !== privateRecovery.version || row.state !== "recovering") {
          return staleHolderResponse();
        }
        const changed = this._db.prepare(`
          UPDATE claims
          SET recovery_killed_at = CASE WHEN ? THEN COALESCE(recovery_killed_at, ?) ELSE recovery_killed_at END,
              recovery_reaped_at = CASE WHEN ? THEN COALESCE(recovery_reaped_at, ?) ELSE recovery_reaped_at END,
              recovery_bind_revoked_at = CASE WHEN ? THEN COALESCE(recovery_bind_revoked_at, ?) ELSE recovery_bind_revoked_at END,
              updated_at = ?
          WHERE task_id = ? AND claim_ref = ? AND version = ? AND state = 'recovering'
        `).run(
          workerKilled ? 1 : 0, nowMs,
          workerReaped ? 1 : 0, nowMs,
          writableBindRevoked ? 1 : 0, nowMs,
          nowMs, row.task_id, row.claim_ref, row.version,
        );
        if (changed.changes !== 1) return staleHolderResponse();
        const current = this._claimRow(row.task_id);
        const complete = current.recovery_killed_at !== null && current.recovery_reaped_at !== null && current.recovery_bind_revoked_at !== null;
        return publicResponse(complete ? "success" : "warning",
          complete ? `Recovery proof for claim ${row.claim_ref} is complete.` : `Recovery proof for claim ${row.claim_ref} is incomplete.`, {
            nextActions: complete
              ? ["Reclaim the task through this recovery handle before launching work."]
              : ["Record the remaining kill, reap, and writable-bind revocation facts."],
            stopCondition: "Do not launch an engine until recovery is complete and reclaimed.",
            artifacts: this._claimArtifact(row.claim_ref),
          });
      });
    } catch (_) {
      return unavailableResponse();
    }
  }

  // A supervised external worker may be intentionally abandoned instead of
  // replaced. The same private recovery capability must prove kill, reap, and
  // writable-bind revocation before its durable row can be deleted.
  releaseRecovered(recovery, request = {}) {
    if (!this._db || this._initError) return unavailableResponse();
    const privateRecovery = this._recoveries.get(recovery);
    const nowMs = normalizeNow(request.nowMs);
    if (!privateRecovery) return staleHolderResponse();
    if (nowMs === null) return invalidRequest("A valid server time is required.");
    try {
      return this._transaction(() => {
        const row = this._claimRow(privateRecovery.taskId);
        if (!row || row.claim_ref !== privateRecovery.claimRef ||
            row.version !== privateRecovery.version || row.state !== "recovering") {
          return staleHolderResponse();
        }
        if (row.recovery_killed_at === null || row.recovery_reaped_at === null ||
            row.recovery_bind_revoked_at === null) {
          return publicResponse("error", `Recovery for claim ${row.claim_ref} is not proven complete.`, {
            rootCause: "recovery_incomplete",
            nextActions: ["Record successful worker kill, reap, and writable-bind revocation before releasing it."],
            stopCondition: "Do not remove or replace this claim.",
            artifacts: this._claimArtifact(row.claim_ref),
          });
        }
        const deleted = this._db.prepare(`
          DELETE FROM claims
          WHERE task_id = ? AND claim_ref = ? AND version = ? AND state = 'recovering'
        `).run(row.task_id, row.claim_ref, row.version);
        if (deleted.changes !== 1) return staleHolderResponse();
        this._recoveries.delete(recovery);
        return publicResponse("success", `Recovered claim ${row.claim_ref} released.`, {
          artifacts: this._claimArtifact(row.claim_ref),
        });
      });
    } catch (_) {
      return unavailableResponse();
    }
  }

  releaseExternalRecovered(recovery, request = {}) {
    if (!this._db || this._initError) return unavailableResponse();
    const privateRecovery = this._recoveries.get(recovery);
    const nowMs = normalizeNow(request.nowMs);
    const terminalStatus = String(request.status || "");
    if (!privateRecovery || privateRecovery.claimType !== "external") return staleHolderResponse();
    if (nowMs === null || !EXTERNAL_TERMINAL_STATES.has(terminalStatus)) {
      return invalidRequest("A valid external recovery release is required.");
    }
    try {
      return this._transaction(() => {
        const row = this._claimRow(privateRecovery.taskId);
        if (!row || row.claim_type !== "external"
            || row.claim_ref !== privateRecovery.claimRef
            || row.version !== privateRecovery.version
            || row.state !== "recovering") {
          return staleHolderResponse();
        }
        if (row.recovery_killed_at === null || row.recovery_reaped_at === null
            || row.recovery_bind_revoked_at === null) {
          return publicResponse("error", `Recovery for claim ${row.claim_ref} is not proven complete.`, {
            rootCause: "recovery_incomplete",
            nextActions: ["Record successful worker kill, reap, and writable-bind revocation before releasing it."],
            stopCondition: "Do not remove or replace this claim.",
            artifacts: this._claimArtifact(row.claim_ref),
          });
        }
        this._insertExternalReceipt(row, terminalStatus, nowMs);
        const deleted = this._db.prepare(`
          DELETE FROM claims
          WHERE task_id = ? AND claim_ref = ? AND version = ? AND state = 'recovering'
            AND claim_type = 'external'
        `).run(row.task_id, row.claim_ref, row.version);
        if (deleted.changes !== 1) return staleHolderResponse();
        this._recoveries.delete(recovery);
        return publicResponse("success", `Recovered external claim ${row.claim_ref} released as ${terminalStatus}.`, {
          artifacts: this._claimArtifact(row.claim_ref),
        });
      });
    } catch (_) {
      return unavailableResponse();
    }
  }

  reclaim(recovery, request) {
    if (!this._db || this._initError) return unavailableResponse();
    const privateRecovery = this._recoveries.get(recovery);
    const input = normalizeClaimRequest(request);
    if (!privateRecovery) return staleHolderResponse();
    if (input.error) return invalidRequest(input.error);
    if (privateRecovery.taskId !== input.taskId) {
      return invalidRequest("Recovery may only reclaim its original task id.");
    }
    try {
      return this._transaction(() => {
        const row = this._claimRow(input.taskId);
        if (!row || row.claim_ref !== privateRecovery.claimRef || row.version !== privateRecovery.version || row.state !== "recovering") {
          return staleHolderResponse();
        }
        if (row.recovery_killed_at === null || row.recovery_reaped_at === null || row.recovery_bind_revoked_at === null) {
          return publicResponse("error", `Recovery for claim ${row.claim_ref} is not proven complete.`, {
            rootCause: "recovery_incomplete",
            nextActions: ["Record successful worker kill, reap, and writable-bind revocation before reclaiming."],
            stopCondition: "Do not launch an engine.",
            artifacts: this._claimArtifact(row.claim_ref),
          });
        }
        const replacement = {
          task_id: input.taskId,
          claim_ref: opaqueRef(),
          token_digest: digestPrivateToken(),
          engine: input.engine,
          acquired_at: input.nowMs,
          expires_at: input.nowMs + input.ttlMs,
          scheduler_generation: input.generation,
          state: "active",
          version: row.version + 1,
          claim_type: "in_box",
          supervisor_id: null,
          supervisor_token_digest: null,
          room_id: null,
          objective_digest: null,
          updated_at: input.nowMs,
        };
        const changed = this._db.prepare(`
          UPDATE claims
          SET claim_ref = ?, token_digest = ?, engine = ?, acquired_at = ?, expires_at = ?,
              scheduler_generation = ?, state = ?, version = ?, recovery_killed_at = NULL,
              recovery_reaped_at = NULL, recovery_bind_revoked_at = NULL,
              claim_type = 'in_box', supervisor_id = NULL,
              supervisor_token_digest = NULL, room_id = NULL,
              objective_digest = NULL, updated_at = ?
          WHERE task_id = ? AND claim_ref = ? AND version = ? AND state = 'recovering'
        `).run(
          replacement.claim_ref, replacement.token_digest, replacement.engine, replacement.acquired_at,
          replacement.expires_at, replacement.scheduler_generation, replacement.state, replacement.version,
          replacement.updated_at, row.task_id, row.claim_ref, row.version,
        );
        if (changed.changes !== 1) return staleHolderResponse();
        this._recoveries.delete(recovery);
        return this._acquiredResponse(replacement, this._privateHolder(replacement));
      });
    } catch (_) {
      return unavailableResponse();
    }
  }

  // Fold the WAL back into the database and truncate it before closing.
  //
  // Nothing in container/ ever checkpointed: SQLite's autocheckpoint only runs
  // after a commit AND only when no other connection holds a read lock, so a
  // long-lived gate connection can defer it indefinitely. Observed on the box
  // 2026-08-08: board-claims.sqlite-wal at 3,790,432 bytes against a 28,672-byte
  // database -- roughly 130x the data it describes, all of it living only in the
  // sidecar file.
  //
  // That is not a correctness bug on its own (WAL recovery is crash-safe, and
  // synchronous=FULL above means each commit is already fsynced). It is a
  // fragility multiplier: recovery has to replay the whole log, reads scan it,
  // and the committed state has no representation in the main file that a
  // backup or a file-copy would capture. A graceful close should hand back a
  // database that stands on its own.
  //
  // Best-effort by design -- a checkpoint that cannot run must never prevent the
  // close, or a wedged reader would leak the handle instead of just the disk.
  checkpoint(mode = "TRUNCATE") {
    if (!this._db) return false;
    try { this._db.exec(`PRAGMA wal_checkpoint(${mode === "PASSIVE" ? "PASSIVE" : "TRUNCATE"})`); return true; }
    catch (_) { return false; }
  }

  close() {
    if (!this._db) return;
    this.checkpoint("TRUNCATE");
    try { this._db.close(); } catch (_) { /* closing is best effort; future calls fail closed */ }
    this._db = null;
    this._initError = true;
  }
}

module.exports = { ClaimStore };
