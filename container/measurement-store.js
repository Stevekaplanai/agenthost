// container/measurement-store.js
// Measurement facts live in SQLite, not the brain: ad performance is tabular
// time-series and the brain is semantic recall. Precedent is board-claims.sqlite.
"use strict";
const { DatabaseSync } = require("node:sqlite");
const crypto = require("node:crypto");

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

// A connection's public id is derived from the three fields that make up the
// database primary key. The NUL separator cannot appear in any validated id,
// so different triples cannot collapse into the same input string. The
// Pipedream connected-account id is deliberately absent: rotating a credential
// must not rename the ad-account connection, and the route id must never expose
// which credential backs it.
function connectionIdentity(value = {}) {
  const accountId = String(value.accountId || "");
  const provider = String(value.provider || "");
  const sourceAccountId = String(value.sourceAccountId || "");
  if (!accountId) throw new Error("accountId is required");
  if (!ID_RE.test(accountId)) throw new Error("accountId must match " + ID_RE);
  if (!provider) throw new Error("provider is required");
  if (!ID_RE.test(provider)) throw new Error("provider must match " + ID_RE);
  if (!sourceAccountId) throw new Error("sourceAccountId is required");
  if (!ID_RE.test(sourceAccountId)) throw new Error("sourceAccountId must match " + ID_RE);
  return { accountId, provider, sourceAccountId };
}

function connectionId(value) {
  const { accountId, provider, sourceAccountId } = connectionIdentity(value);
  return "mc_" + crypto.createHash("sha256")
    .update(accountId + "\0" + provider + "\0" + sourceAccountId)
    .digest("base64url");
}

// observed_at is a full ISO timestamp, but a caller naturally writes a DAY:
// ?until=2026-08-10. SQLite compares these as strings, so
// "2026-08-10T00:00:00.000Z" <= "2026-08-10" is FALSE and a date-only `until`
// silently dropped the whole day it named -- a short answer with no error,
// which is the exact shape of failure this codebase keeps paying for. A
// date-only bound is therefore widened to the day it means: start-of-day for
// `since`, end-of-day for `until`. A full timestamp is passed through untouched.
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
function exactDay(value) {
  const day = String(value || "");
  if (!DATE_ONLY_RE.test(day)) return null;
  const parsed = new Date(day + "T00:00:00.000Z");
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day ? day : null;
}
function dayBound(value, edge) {
  const v = String(value);
  if (!DATE_ONLY_RE.test(v)) return v;
  return edge === "until" ? v + "T23:59:59.999Z" : v + "T00:00:00.000Z";
}

function openStore(file, options = {}) {
  const db = new DatabaseSync(file);
  // Durability pragmas match claim-store.js to handle concurrent access.
  // busy_timeout default is 5000ms (5s), matching claim-store.js precisely.
  // journal_mode = WAL enables better concurrency than rollback-journal mode.
  // synchronous = FULL ensures durability: fsync on every commit.
  const busyTimeoutMs = Number.isSafeInteger(options.busyTimeoutMs) ? options.busyTimeoutMs : 5_000;
  db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.min(busyTimeoutMs, 60_000))}`);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");
  db.exec(`CREATE TABLE IF NOT EXISTS facts (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    source_account_id TEXT,
    campaign_id TEXT,
    campaign_name TEXT,
    metric TEXT NOT NULL,
    value REAL NOT NULL,
    currency TEXT,
    source_timezone TEXT,
    observed_at TEXT NOT NULL,
    captured_at TEXT NOT NULL
  )`);
  // Additive migration for stores created before these columns existed, same
  // pattern as claim-store.js. CREATE TABLE IF NOT EXISTS is a NO-OP on a file
  // that already has the table, so every column added after a box's store was
  // first written needs a guard here or it simply never appears.
  //
  // BOTH guards, audited against the oldest shape this file ever wrote (facts
  // began as id/account_id/task_id/provider/metric/value/currency/observed_at/
  // captured_at). source_account_id had none, and it is named by the UNIQUE
  // index below: on an existing file openStore added source_timezone, then
  // threw "no such column: source_account_id" while creating the index --
  // before returning. measurementStore() catches that and returns null, so
  // EVERY facts route 500s and every tick fails, on every boot, permanently.
  // A column named by an index must be guaranteed to exist before it.
  const factColumns = new Set(db.prepare("PRAGMA table_info(facts)").all().map((c) => c.name));
  if (!factColumns.has("source_account_id")) db.exec("ALTER TABLE facts ADD COLUMN source_account_id TEXT");
  if (!factColumns.has("source_timezone")) db.exec("ALTER TABLE facts ADD COLUMN source_timezone TEXT");
  if (!factColumns.has("campaign_id")) db.exec("ALTER TABLE facts ADD COLUMN campaign_id TEXT");
  if (!factColumns.has("campaign_name")) db.exec("ALTER TABLE facts ADD COLUMN campaign_name TEXT");
  // The identity index is REPLACED, not merely created, when an existing one
  // names a column that is no longer part of a fact's identity. CREATE ... IF
  // NOT EXISTS is a no-op on a file that already has the index, so a store
  // carrying an old task-aware or pre-campaign index would keep it -- and putFact's ON
  // CONFLICT target, which must match a real unique index EXACTLY, would then
  // fail "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE
  // constraint" on every single write. Campaign NAME is deliberately not
  // identity: Meta can rename a campaign, and that is a restatement rather than
  // a second campaign.
  const identity = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='facts_identity'").get();
  const identitySql = String((identity && identity.sql) || "");
  const rebuildIdentity = !!identity && (/task_id/.test(identitySql) || !/campaign_id/.test(identitySql));
  if (rebuildIdentity) db.exec("DROP INDEX facts_identity");
  // NO identity index has ever existed on this file, so its rows predate the
  // uniqueness rule and may contain exactly the duplicates that rule exists to
  // stop. CREATE UNIQUE INDEX would then throw "UNIQUE constraint failed",
  // openStore would throw, measurementStore() would return null, and every facts
  // route and every hourly tick would fail permanently -- a box bricked by its
  // own upgrade.
  //
  // This is reachable, not hypothetical: an earlier commit on this very branch
  // shipped the hourly tick BEFORE the identity index existed, writing plain
  // INSERTs. Any store built by that build holds ~24 rows per day per metric.
  // (No such database exists on Steve's box today -- I checked before writing
  // this -- but "no instance exists right now" is not a migration guarantee.)
  //
  // MAX(rowid) keeps the LAST row written for each identity, which is the most
  // recent restatement of that day -- the same value the upsert would have
  // converged on had the index been there all along.
  if (!identity || rebuildIdentity) {
    db.exec(`DELETE FROM facts WHERE rowid NOT IN (
      SELECT MAX(rowid) FROM facts
      GROUP BY account_id, provider, COALESCE(source_account_id,''),
        COALESCE(campaign_id,''), metric, observed_at)`);
  }
  // A fact's IDENTITY, not its row id. The sync tick re-reads the same day every
  // hour (providers restate spend for days after the fact), so without this each
  // pass would INSERT another copy: ~24 rows per day, and a ROAS wrong by 24x
  // that looks entirely plausible. COALESCE because SQLite treats NULLs as
  // distinct, which would let every sync of an account with no source id duplicate.
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS facts_identity ON facts(
    account_id, provider, COALESCE(source_account_id,''), COALESCE(campaign_id,''), metric, observed_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS facts_account ON facts(account_id, observed_at)`);
  db.exec(`CREATE TABLE IF NOT EXISTS measurement_connections (
    account_id          TEXT NOT NULL,
    provider            TEXT NOT NULL,
    source_account_id   TEXT NOT NULL,
    pipedream_account_id TEXT,
    enabled             INTEGER NOT NULL DEFAULT 1,
    last_synced_at      TEXT,
    last_error          TEXT,
    PRIMARY KEY (account_id, provider, source_account_id)
  )`);
  // WHICH Pipedream connected-account this row means. Without it the sync had
  // to guess -- it took the FIRST account Pipedream listed for
  // (external_user_id, app) -- so a client with two Meta credentials got a
  // non-deterministic choice unrelated to the ad account the facts belong to,
  // and could silently read the wrong permitted set. Nullable and added by the
  // same additive migration as source_timezone above, so a box whose store
  // predates this column keeps working: an old row simply has no recorded
  // choice, and the sync refuses it by name rather than guessing again.
  const connectionColumns = new Set(db.prepare("PRAGMA table_info(measurement_connections)").all().map((c) => c.name));
  if (!connectionColumns.has("pipedream_account_id")) {
    db.exec("ALTER TABLE measurement_connections ADD COLUMN pipedream_account_id TEXT");
  }

  const row = (r) => ({
    id: r.id, accountId: r.account_id, provider: r.provider,
    sourceAccountId: r.source_account_id, campaignId: r.campaign_id, campaignName: r.campaign_name,
    metric: r.metric, value: r.value, currency: r.currency,
    sourceTimezone: r.source_timezone, observedAt: r.observed_at, capturedAt: r.captured_at,
  });
  const connectionRow = (r) => ({
    id: connectionId({ accountId: r.account_id, provider: r.provider, sourceAccountId: r.source_account_id }),
    accountId: r.account_id, provider: r.provider, sourceAccountId: r.source_account_id,
    pipedreamAccountId: r.pipedream_account_id || null,
    enabled: !!r.enabled, lastSyncedAt: r.last_synced_at, lastError: r.last_error,
  });

  const accountFactExists = db.prepare(`SELECT 1 FROM facts
    WHERE account_id = ? AND provider = ?
      AND COALESCE(source_account_id,'') = COALESCE(?,'')
      AND campaign_id IS NULL AND metric = ? AND observed_at = ? LIMIT 1`);
  const campaignFactExists = db.prepare(`SELECT 1 FROM facts
    WHERE account_id = ? AND provider = ?
      AND COALESCE(source_account_id,'') = COALESCE(?,'')
      AND campaign_id IS NOT NULL AND metric = ? AND observed_at = ? LIMIT 1`);
  const removeFactRange = db.prepare(`DELETE FROM facts
    WHERE account_id = ? AND provider = ?
      AND COALESCE(source_account_id,'') = COALESCE(?,'')
      AND observed_at >= ? AND observed_at <= ?`);
  const connectionForTriple = db.prepare(`SELECT * FROM measurement_connections
    WHERE account_id = ? AND provider = ? AND source_account_id = ?`);
  const disableConnection = db.prepare(`UPDATE measurement_connections SET enabled = 0
    WHERE account_id = ? AND provider = ? AND source_account_id = ?`);
  const countConnectionFacts = db.prepare(`SELECT COUNT(*) AS count FROM facts
    WHERE account_id = ? AND provider = ?
      AND COALESCE(source_account_id,'') = COALESCE(?,'')`);
  const removeConnectionFacts = db.prepare(`DELETE FROM facts
    WHERE account_id = ? AND provider = ?
      AND COALESCE(source_account_id,'') = COALESCE(?,'')`);

  const writeFact = (fact) => {
    const accountId = String((fact && fact.accountId) || "");
    if (!accountId) throw new Error("accountId is required");
    if (!ID_RE.test(accountId)) throw new Error("accountId must match " + ID_RE);
    const provider = String((fact && fact.provider) || "");
    if (!provider) throw new Error("provider is required");
    const metric = String((fact && fact.metric) || "");
    if (!metric) throw new Error("metric is required");
    if (!Number.isFinite(Number(fact.value))) throw new Error("value must be a finite number");
    const observedAt = String((fact && fact.observedAt) || "");
    if (!observedAt) throw new Error("observedAt is required");
    const sourceAccountId = fact.sourceAccountId ? String(fact.sourceAccountId) : null;
    const campaignId = fact.campaignId ? String(fact.campaignId).trim() || null : null;
    const campaignName = fact.campaignName ? String(fact.campaignName).trim() || null : null;

    // A partial provider response reaches putFact(s), while only a complete
    // authoritative response reaches replaceFacts. Never let the partial path
    // erase a complete legacy account total or coexist beside it: refuse the
    // whole transaction and wait for a complete scoped replacement to migrate
    // the slice to campaign granularity.
    if (campaignId !== null) {
      if (accountFactExists.get(accountId, provider, sourceAccountId, metric, observedAt)) {
        throw new Error("partial campaign facts cannot replace an existing account-level fact for the same provider, source, day, and metric");
      }
    } else if (campaignFactExists.get(accountId, provider, sourceAccountId, metric, observedAt)) {
      throw new Error("an account-level fact cannot replace existing campaign-level facts for the same provider, source, day, and metric");
    }

    // UPSERT, so re-syncing a day is idempotent AND absorbs a provider's
    // restatement: the value is replaced, not added alongside. RETURNING id so
    // the caller gets the row that actually exists, not a UUID we minted and
    // then discarded on conflict.
    const written = db.prepare(`INSERT INTO facts
      (id, account_id, provider, source_account_id, campaign_id, campaign_name,
        metric, value, currency, source_timezone, observed_at, captured_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, provider, COALESCE(source_account_id,''), COALESCE(campaign_id,''), metric, observed_at)
      DO UPDATE SET campaign_name = excluded.campaign_name,
        value = excluded.value, currency = excluded.currency,
        source_timezone = excluded.source_timezone, captured_at = excluded.captured_at
      RETURNING id`).get(
      crypto.randomUUID(), accountId, provider, sourceAccountId, campaignId,
      campaignName, metric, Number(fact.value), fact.currency ? String(fact.currency) : null,
      fact.sourceTimezone ? String(fact.sourceTimezone) : null,
      observedAt, new Date().toISOString(),
    );
    return { ok: true, id: written.id };
  };

  const validateBatchGranularity = (rows) => {
    const granularity = new Map();
    for (const fact of rows) {
      const key = JSON.stringify([
        String((fact && fact.accountId) || ""),
        String((fact && fact.provider) || ""),
        fact && fact.sourceAccountId ? String(fact.sourceAccountId) : "",
        String((fact && fact.metric) || ""),
        String((fact && fact.observedAt) || ""),
      ]);
      const level = fact && fact.campaignId && String(fact.campaignId).trim() ? "campaign" : "account";
      const previous = granularity.get(key);
      if (previous && previous !== level) {
        throw new Error("campaign-level and account-level facts cannot share the same provider, source, day, and metric");
      }
      granularity.set(key, level);
    }
  };

  const store = {
    putFact(fact) {
      db.exec("BEGIN");
      try {
        const result = writeFact(fact);
        db.exec("COMMIT");
        return result;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    factsFor({ accountId, since, until } = {}) {
      const a = String(accountId || "");
      if (!a) throw new Error("accountId is required");
      if (!ID_RE.test(a)) throw new Error("accountId must match " + ID_RE);
      const clauses = ["account_id = ?"];
      const args = [a];
      if (since) { clauses.push("observed_at >= ?"); args.push(dayBound(since, "since")); }
      if (until) { clauses.push("observed_at <= ?"); args.push(dayBound(until, "until")); }
      return db.prepare(`SELECT * FROM facts WHERE ${clauses.join(" AND ")} ORDER BY observed_at`)
        .all(...args).map(row);
    },
    putConnection({ accountId, provider, sourceAccountId, pipedreamAccountId, enabled }) {
      const { accountId: a, provider: p, sourceAccountId: s } = connectionIdentity({ accountId, provider, sourceAccountId });
      // Upsert only touches `enabled` and the recorded credential choice:
      // re-enabling a connection must not clear last_synced_at/last_error, or
      // the fix for whatever broke it disappears along with the record that it
      // happened. COALESCE on the credential so a caller that only flips
      // `enabled` cannot silently erase WHICH credential the connection means --
      // that erasure would read as "never connected" and stop every sync.
      db.prepare(`INSERT INTO measurement_connections
        (account_id, provider, source_account_id, pipedream_account_id, enabled)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (account_id, provider, source_account_id)
        DO UPDATE SET enabled = excluded.enabled,
          pipedream_account_id = COALESCE(excluded.pipedream_account_id, measurement_connections.pipedream_account_id)`)
        .run(a, p, s, pipedreamAccountId ? String(pipedreamAccountId) : null, enabled ? 1 : 0);
      return { ok: true };
    },
    connections({ enabled } = {}) {
      if (typeof enabled === "boolean") {
        return db.prepare(`SELECT * FROM measurement_connections WHERE enabled = ?`)
          .all(enabled ? 1 : 0).map(connectionRow);
      }
      return db.prepare(`SELECT * FROM measurement_connections`).all().map(connectionRow);
    },
    connectionFor(value) {
      const { accountId, provider, sourceAccountId } = connectionIdentity(value);
      const found = connectionForTriple.get(accountId, provider, sourceAccountId);
      return found ? connectionRow(found) : null;
    },
    connectionForId(id) {
      const publicId = String(id || "");
      if (!ID_RE.test(publicId)) return null;
      return db.prepare(`SELECT * FROM measurement_connections`).all()
        .map(connectionRow).find((connection) => connection.id === publicId) || null;
    },
    disconnectConnection(value) {
      const { accountId, provider, sourceAccountId } = connectionIdentity(value);
      db.exec("BEGIN IMMEDIATE");
      try {
        const found = connectionForTriple.get(accountId, provider, sourceAccountId);
        if (!found) {
          db.exec("COMMIT");
          return { ok: false, found: false };
        }
        disableConnection.run(accountId, provider, sourceAccountId);
        const disconnected = connectionForTriple.get(accountId, provider, sourceAccountId);
        db.exec("COMMIT");
        return { ok: true, found: true, connection: connectionRow(disconnected) };
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    countFactsForConnection(value) {
      const { accountId, provider, sourceAccountId } = connectionIdentity(value);
      return Number(countConnectionFacts.get(accountId, provider, sourceAccountId).count);
    },
    deleteFactsForConnection(value) {
      const { accountId, provider, sourceAccountId } = connectionIdentity(value);
      db.exec("BEGIN IMMEDIATE");
      try {
        const found = connectionForTriple.get(accountId, provider, sourceAccountId);
        if (!found) {
          const missing = new Error("measurement connection was not found");
          missing.code = "MEASUREMENT_CONNECTION_NOT_FOUND";
          throw missing;
        }
        if (found.enabled) {
          const enabled = new Error("disconnect this ad account before deleting its stored facts; otherwise a future sync can recreate them");
          enabled.code = "MEASUREMENT_CONNECTION_ENABLED";
          throw enabled;
        }
        const result = removeConnectionFacts.run(accountId, provider, sourceAccountId);
        db.exec("COMMIT");
        return { ok: true, deleted: Number(result.changes) };
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    markConnectionSync({ accountId, provider, sourceAccountId, at, error }) {
      const a = String(accountId || "");
      if (!a) throw new Error("accountId is required");
      const p = String(provider || "");
      if (!p) throw new Error("provider is required");
      const s = String(sourceAccountId || "");
      if (!s) throw new Error("sourceAccountId is required");
      const attemptAt = String(at || "");
      if (!attemptAt) throw new Error("at is required");
      db.prepare(`UPDATE measurement_connections SET last_synced_at = ?, last_error = ?
        WHERE account_id = ? AND provider = ? AND source_account_id = ?`).run(
        attemptAt, error ? String(error) : null, a, p, s,
      );
      return { ok: true };
    },
    // ALL OR NOTHING. putFact throwing partway through a day's facts would leave
    // the earlier rows committed, and the sync path's contract -- stated in its own
    // header -- is that a failure writes nothing. Without this, a partial write
    // looks exactly like a real measurement to everything downstream.
    putFacts(facts) {
      const rows = Array.isArray(facts) ? facts : [];
      if (!rows.length) return { ok: true, written: 0 };
      // Refuse mixed granularity before row order can affect the result. A
      // campaign row followed by a NULL-campaign row used to recreate the exact
      // legacy duplicate the campaign row had just removed.
      validateBatchGranularity(rows);
      db.exec("BEGIN");
      try {
        for (const fact of rows) writeFact(fact);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      return { ok: true, written: rows.length };
    },
    // A complete provider response is an authoritative snapshot for exactly
    // this account/provider/source/date range. Delete and rewrite that slice in
    // one transaction so omissions remove stale revenue/campaigns, while a bad
    // replacement rolls the deletion back. The sync path never calls this for
    // partial responses containing skipped provider rows.
    replaceFacts({ accountId, provider, sourceAccountId, since, until, facts } = {}) {
      const a = String(accountId || "");
      if (!a) throw new Error("accountId is required");
      if (!ID_RE.test(a)) throw new Error("accountId must match " + ID_RE);
      const p = String(provider || "");
      if (!p) throw new Error("provider is required");
      const s = String(sourceAccountId || "");
      if (!s) throw new Error("sourceAccountId is required");
      const firstDay = exactDay(since);
      const lastDay = exactDay(until);
      if (!firstDay || !lastDay) throw new Error("since and until must be real YYYY-MM-DD calendar dates");
      if (firstDay > lastDay) throw new Error("since must not be after until");
      if (!Array.isArray(facts)) throw new Error("facts must be an array");
      const from = dayBound(firstDay, "since");
      const through = dayBound(lastDay, "until");
      const rows = facts;
      for (const fact of rows) {
        const observedAt = String((fact && fact.observedAt) || "");
        if (String((fact && fact.accountId) || "") !== a
            || String((fact && fact.provider) || "") !== p
            || String((fact && fact.sourceAccountId) || "") !== s
            || observedAt < from || observedAt > through) {
          throw new Error("a replacement fact is outside the requested account, provider, source, or date range");
        }
      }
      validateBatchGranularity(rows);
      db.exec("BEGIN");
      try {
        removeFactRange.run(a, p, s, from, through);
        for (const fact of rows) writeFact(fact);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      return { ok: true, written: rows.length };
    },
    close() { db.close(); },
  };
  return store;
}

module.exports = { openStore, ID_RE, connectionId };
