// test/measurement-store.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const { openStore } = require("../container/measurement-store.js");

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "meas-")), "m.sqlite");
}

test("a fact round-trips and is scoped to its account", () => {
  const store = openStore(tmpFile());
  store.putFact({ accountId: "acme", provider: "meta_ads",
    metric: "spend", value: 12.5, currency: "USD", observedAt: "2026-08-01T00:00:00.000Z" });
  store.putFact({ accountId: "other", provider: "meta_ads",
    metric: "spend", value: 99, currency: "USD", observedAt: "2026-08-01T00:00:00.000Z" });

  const acme = store.factsFor({ accountId: "acme" });
  assert.equal(acme.length, 1, "an account must never see another account's facts");
  assert.equal(acme[0].value, 12.5);
  assert.equal(acme[0].provider, "meta_ads");
  store.close();
});

test("the card-linked lens is gone, so it cannot return a second copy of a measured day", () => {
  // task_id was in a fact's UNIQUE identity while factsFor did not filter on
  // it, so a card-triggered sync of an already-synced day would have stored a
  // SECOND row and every spend sum would silently double. Nothing produced a
  // taskId, so the lens went rather than shipping half-wired.
  const store = openStore(tmpFile());
  assert.equal(store.factsForTask, undefined,
    "a reader for a column with no writer is a ledger that can only ever answer zero");
  store.close();
});

test("a fact with no account is refused, and says why", () => {
  const store = openStore(tmpFile());
  assert.throws(
    () => store.putFact({ accountId: "", provider: "meta_ads", metric: "spend", value: 1, observedAt: "2026-08-01T00:00:00.000Z" }),
    /accountId is required/,
    "an unscoped fact would be visible to every tenant on this box",
  );
  store.close();
});

test("a fact records which ad account produced it", () => {
  const store = openStore(tmpFile());
  store.putFact({ accountId: "acme", provider: "meta_ads", sourceAccountId: "act_111",
    metric: "spend", value: 10, currency: "USD", observedAt: "2026-08-01T00:00:00.000Z" });
  const [fact] = store.factsFor({ accountId: "acme" });
  assert.equal(fact.sourceAccountId, "act_111",
    "without this, two clients' spend can be summed into one meaningless ROAS");
  assert.equal(fact.currency, "USD");
  store.close();
});

test("facts from two ad accounts stay distinguishable", () => {
  const store = openStore(tmpFile());
  for (const [src, cur, val] of [["act_1", "USD", 10], ["act_2", "GBP", 20]]) {
    store.putFact({ accountId: "acme", provider: "meta_ads", sourceAccountId: src,
      metric: "spend", value: val, currency: cur, observedAt: "2026-08-01T00:00:00.000Z" });
  }
  const facts = store.factsFor({ accountId: "acme" });
  const bySource = Object.fromEntries(facts.map((f) => [f.sourceAccountId, f.currency]));
  assert.deepEqual(bySource, { act_1: "USD", act_2: "GBP" },
    "a caller must be able to refuse to aggregate across currencies");
  store.close();
});

test("facts from two campaigns stay distinct, while one campaign restates in place", () => {
  const store = openStore(tmpFile());
  const base = { accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1",
    metric: "spend", currency: "USD", observedAt: "2026-08-01T00:00:00.000Z" };
  const first = store.putFact({ ...base, campaignId: "cmp_1", campaignName: "Launch", value: 10 });
  store.putFact({ ...base, campaignId: "cmp_2", campaignName: "Retargeting", value: 20 });
  const restated = store.putFact({ ...base, campaignId: "cmp_1", campaignName: "Launch renamed", value: 12 });

  const facts = store.factsFor({ accountId: "acme" });
  assert.equal(facts.length, 2, "campaigns on the same account, metric, and day must not overwrite each other");
  assert.equal(first.id, restated.id, "a restatement of the same campaign must update its existing row");
  const byCampaign = Object.fromEntries(facts.map((f) => [f.campaignId, { name: f.campaignName, value: f.value }]));
  assert.deepEqual(byCampaign, {
    cmp_1: { name: "Launch renamed", value: 12 },
    cmp_2: { name: "Retargeting", value: 20 },
  });
  store.close();
});

test("a batch that fails partway writes NOTHING", () => {
  // The sync path's header promises "every failure ... writes nothing". Before
  // putFacts that was only true by luck: the loop committed each fact as it went,
  // so a bad row partway through left the earlier ones behind, looking measured.
  const store = openStore(tmpFile());
  const good = { accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1",
    metric: "spend", value: 10, currency: "USD", observedAt: "2026-08-01T00:00:00.000Z" };
  assert.throws(
    () => store.putFacts([good, { ...good, value: Number.NaN }, { ...good, metric: "revenue" }]),
    /value must be a finite number/,
    "the cause of the rejection must survive the transaction",
  );
  assert.equal(store.factsFor({ accountId: "acme" }).length, 0,
    "the first fact must be rolled back, not left behind as a half-measurement");
  store.close();
});

test("a clean batch writes every row and reports the count", () => {
  const store = openStore(tmpFile());
  const base = { accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1",
    currency: "USD", observedAt: "2026-08-01T00:00:00.000Z" };
  const r = store.putFacts([{ ...base, metric: "spend", value: 10 }, { ...base, metric: "revenue", value: 40 }]);
  assert.equal(r.written, 2);
  assert.equal(store.factsFor({ accountId: "acme" }).length, 2);
  store.close();
});

test("a successful scoped replacement removes omissions and preserves other sources, providers, accounts, and dates", () => {
  const store = openStore(tmpFile());
  const scope = { accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1" };
  const fact = (overrides = {}) => ({
    ...scope, campaignId: "cmp_1", campaignName: "Launch", metric: "spend", value: 10,
    currency: "USD", sourceTimezone: "America/New_York", observedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  });
  store.putFacts([
    fact(),
    fact({ metric: "revenue", value: 100 }),
    fact({ campaignId: "cmp_omitted", campaignName: "Omitted", value: 20 }),
    fact({ sourceAccountId: "act_2", campaignId: "cmp_other_source", campaignName: "Other source", value: 30 }),
    fact({ provider: "google_ads", campaignId: "cmp_other_provider", campaignName: "Other provider", value: 40 }),
    fact({ accountId: "other", campaignId: "cmp_other_account", campaignName: "Other account", value: 50 }),
    fact({ observedAt: "2026-07-31T00:00:00.000Z", campaignId: "cmp_old", campaignName: "Older", value: 60 }),
    fact({ observedAt: "2026-08-02T00:00:00.000Z", campaignId: "cmp_new", campaignName: "Newer", value: 70 }),
  ]);

  const result = store.replaceFacts({
    ...scope,
    since: "2026-08-01",
    until: "2026-08-01",
    facts: [fact({ value: 12 })],
  });
  assert.equal(result.written, 1);

  const acme = store.factsFor({ accountId: "acme" });
  assert.deepEqual(
    acme.filter((row) => row.provider === "meta_ads" && row.sourceAccountId === "act_1"
      && row.observedAt === "2026-08-01T00:00:00.000Z")
      .map((row) => [row.campaignId, row.metric, row.value]),
    [["cmp_1", "spend", 12]],
    "omitted revenue and campaigns in the authoritative range must be removed",
  );
  assert.equal(acme.some((row) => row.sourceAccountId === "act_2"), true);
  assert.equal(acme.some((row) => row.provider === "google_ads"), true);
  assert.equal(acme.some((row) => row.observedAt.startsWith("2026-07-31")), true);
  assert.equal(acme.some((row) => row.observedAt.startsWith("2026-08-02")), true);
  assert.equal(store.factsFor({ accountId: "other" }).length, 1);
  store.close();
});

test("a rejected scoped replacement rolls its deletion back and leaves prior facts unchanged", () => {
  const store = openStore(tmpFile());
  const old = { accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1",
    campaignId: "cmp_1", campaignName: "Launch", metric: "revenue", value: 100,
    currency: "USD", observedAt: "2026-08-01T00:00:00.000Z" };
  store.putFact(old);
  const before = store.factsFor({ accountId: "acme" });

  assert.throws(() => store.replaceFacts({
    accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1",
    since: "2026-08-01", until: "2026-08-01",
    facts: [{ ...old, accountId: "other", value: 999 }],
  }), /outside the requested account, provider, source, or date range/);
  assert.deepEqual(store.factsFor({ accountId: "acme" }), before);
  assert.throws(() => store.replaceFacts({
    accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1",
    since: "2026-02-30", until: "2026-03-01", facts: [],
  }), /real YYYY-MM-DD calendar dates/);
  assert.deepEqual(store.factsFor({ accountId: "acme" }), before);
  store.close();
});

test("only a complete scoped replacement may replace a legacy account-level fact with campaigns", () => {
  const store = openStore(tmpFile());
  const base = { accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1",
    metric: "spend", currency: "USD", sourceTimezone: "America/New_York",
    observedAt: "2026-08-10T00:00:00.000Z" };
  store.putFact({ ...base, value: 999 });

  assert.throws(() => store.putFacts([
    { ...base, campaignId: "cmp_1", campaignName: "One", value: 10 },
  ]), /partial campaign facts cannot replace an existing account-level fact/);
  assert.equal(store.factsFor({ accountId: "acme" })[0].value, 999,
    "an incomplete campaign snapshot must preserve the complete legacy total");

  store.replaceFacts({
    accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1",
    since: "2026-08-10", until: "2026-08-10",
    facts: [
      { ...base, campaignId: "cmp_1", campaignName: "One", value: 10 },
      { ...base, campaignId: "cmp_2", campaignName: "Two", value: 20 },
    ],
  });
  const facts = store.factsFor({ accountId: "acme" });
  assert.equal(facts.length, 2, "the old NULL-campaign row must not double-count the campaign facts");
  assert.equal(facts.some((item) => item.campaignId === null), false);
  assert.equal(facts.reduce((sum, item) => sum + item.value, 0), 30);
  store.close();
});

test("a NULL campaign fact after a campaign fact cannot recreate double counting in one batch", () => {
  const base = { accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1",
    metric: "spend", currency: "USD", sourceTimezone: "America/New_York",
    observedAt: "2026-08-10T00:00:00.000Z" };
  for (const rows of [
    [{ ...base, campaignId: "cmp_1", campaignName: "One", value: 10 }, { ...base, value: 999 }],
    [{ ...base, value: 999 }, { ...base, campaignId: "cmp_1", campaignName: "One", value: 10 }],
  ]) {
    const store = openStore(tmpFile());
    assert.throws(
      () => store.putFacts(rows),
      /campaign-level and account-level facts cannot share the same provider, source, day, and metric/,
      "mixed granularity must be refused before row order can change the outcome",
    );
    assert.deepEqual(store.factsFor({ accountId: "acme" }), [], "the rejected batch must write nothing");
    store.close();
  }
});

test("an account-level fact cannot be added after campaign facts already exist", () => {
  const store = openStore(tmpFile());
  const base = { accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1",
    metric: "spend", currency: "USD", sourceTimezone: "America/New_York",
    observedAt: "2026-08-10T00:00:00.000Z" };
  store.putFact({ ...base, campaignId: "cmp_1", campaignName: "One", value: 10 });
  assert.throws(
    () => store.putFact({ ...base, value: 999 }),
    /account-level fact cannot replace existing campaign-level facts/,
  );
  const facts = store.factsFor({ accountId: "acme" });
  assert.equal(facts.length, 1);
  assert.equal(facts[0].value, 10);
  store.close();
});

test("re-syncing the same day does not duplicate the fact, and takes the restatement", () => {
  // The tick re-reads yesterday EVERY HOUR. Before the identity index this wrote
  // a new row each pass: ~24 rows a day and a ROAS wrong by 24x that still looked
  // entirely plausible. Providers also restate spend for days afterwards, so the
  // correct behaviour is replace, not append.
  const store = openStore(tmpFile());
  const fact = { accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1",
    metric: "spend", value: 10, currency: "USD", observedAt: "2026-08-10T00:00:00.000Z" };
  const first = store.putFact(fact);
  const again = store.putFact(fact);
  store.putFact({ ...fact, value: 12.5 });
  const rows = store.factsFor({ accountId: "acme" });
  assert.equal(rows.length, 1, "three syncs of one day must leave ONE fact");
  assert.equal(rows[0].value, 12.5, "the latest observation wins, rather than being added alongside");
  assert.equal(first.id, again.id, "the returned id must be the row that exists, not a discarded uuid");
  store.close();
});

test("the ad account's timezone persists on the fact, and an old store migrates to hold it", () => {
  // FINDING 4. observedAt asserts a "Z" for a day Meta reports in the ad
  // account's own timezone; the column is what stops two clients in different
  // timezones becoming indistinguishable. It is nullable on purpose -- unknown
  // must stay unknown.
  const file = tmpFile();
  const store = openStore(file);
  const base = { accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1",
    metric: "spend", value: 10, currency: "USD", observedAt: "2026-08-10T00:00:00.000Z" };
  store.putFact({ ...base, sourceTimezone: "America/New_York" });
  store.putFact({ ...base, sourceAccountId: "act_2" });
  const bySource = Object.fromEntries(store.factsFor({ accountId: "acme" }).map((f) => [f.sourceAccountId, f.sourceTimezone]));
  assert.deepEqual(bySource, { act_1: "America/New_York", act_2: null });

  // A restatement must carry the corrected timezone too, not keep the first one.
  store.putFact({ ...base, sourceTimezone: "Europe/London", value: 11 });
  const [updated] = store.factsFor({ accountId: "acme" }).filter((f) => f.sourceAccountId === "act_1");
  assert.equal(updated.sourceTimezone, "Europe/London");
  store.close();

  // Reopening exercises the additive migration branch on an existing file: the
  // column already exists, so ALTER must not run twice and throw.
  const reopened = openStore(file);
  assert.equal(reopened.factsFor({ accountId: "acme" }).length, 2, "an existing store must still be readable");
  reopened.close();
});

test("a date-only `until` includes the whole day it names, rather than dropping it", () => {
  // THE EXACT FAILING CASE. observed_at is "2026-08-10T00:00:00.000Z" and the
  // caller asks for ?until=2026-08-10. String comparison makes
  // "2026-08-10T00:00:00.000Z" <= "2026-08-10" false, so the day the caller
  // explicitly asked for came back empty -- with no error to say so.
  const store = openStore(tmpFile());
  store.putFact({ accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1",
    metric: "spend", value: 10, currency: "USD", observedAt: "2026-08-10T00:00:00.000Z" });
  assert.equal(store.factsFor({ accountId: "acme", until: "2026-08-10" }).length, 1,
    "a date-only until must mean end-of-that-day, not its midnight");
  assert.equal(store.factsFor({ accountId: "acme", since: "2026-08-10", until: "2026-08-10" }).length, 1,
    "a single-day window must contain that day's facts");
  store.close();
});

test("a date-only `since` starts at midnight, and a full timestamp is left alone", () => {
  const store = openStore(tmpFile());
  const base = { accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1",
    metric: "spend", value: 10, currency: "USD" };
  store.putFact({ ...base, observedAt: "2026-08-09T00:00:00.000Z" });
  store.putFact({ ...base, observedAt: "2026-08-10T00:00:00.000Z" });
  assert.equal(store.factsFor({ accountId: "acme", since: "2026-08-10" }).length, 1,
    "since must not swallow the day it names");
  assert.equal(store.factsFor({ accountId: "acme", until: "2026-08-09T12:00:00.000Z" }).length, 1,
    "a full timestamp must be compared exactly as given, never widened");
  store.close();
});

test("a facts table written before source_account_id existed opens, migrates, and gets its identity index", () => {
  // THE FAILING CASE, built by executing the OLDEST schema this file ever wrote
  // rather than by trusting the current one. On a box whose measurement.sqlite
  // predates these columns, CREATE TABLE IF NOT EXISTS is a no-op, so the file
  // keeps the old shape. openStore then names source_account_id in the
  // facts_identity UNIQUE index -- and without a guard for that column it threw
  // "no such column: source_account_id" BEFORE returning a store. gate.js's
  // measurementStore() catches the throw and returns null, so every facts route
  // 500s and every tick fails, on every boot, permanently: a box that can never
  // measure again and whose only symptom is silence.
  const file = tmpFile();
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE facts (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    task_id TEXT,
    provider TEXT NOT NULL,
    metric TEXT NOT NULL,
    value REAL NOT NULL,
    currency TEXT,
    observed_at TEXT NOT NULL,
    captured_at TEXT NOT NULL
  )`);
  old.exec(`CREATE INDEX facts_account ON facts(account_id, observed_at)`);
  old.exec(`CREATE INDEX facts_task ON facts(task_id)`);
  old.exec(`INSERT INTO facts (id, account_id, task_id, provider, metric, value, currency, observed_at, captured_at)
    VALUES ('f_1','acme',NULL,'meta_ads','spend',10,'USD','2026-08-10T00:00:00.000Z','2026-08-10T01:00:00.000Z')`);
  old.close();

  const store = openStore(file);

  // 1. It opened at all -- which is the whole failure.
  const existing = store.factsFor({ accountId: "acme" });
  assert.equal(existing.length, 1, "the facts already on the box must survive the migration");
  assert.equal(existing[0].sourceAccountId, null, "an unmigrated fact has no source account, and must say so rather than invent one");
  assert.equal(existing[0].sourceTimezone, null);
  assert.equal(existing[0].campaignId, null, "an old account-level fact must survive without an invented campaign");
  assert.equal(existing[0].campaignName, null);

  // 2. The identity index actually exists -- not merely "openStore did not
  //    throw". Without it the hourly re-read appends instead of upserting: ~24
  //    rows a day and a ROAS wrong by 24x that still looks plausible.
  const indexes = new Set(
    new DatabaseSync(file).prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name),
  );
  assert.ok(indexes.has("facts_identity"), "the UNIQUE identity index must be created on a migrated store");

  // 3. And it WORKS on the migrated file: both new columns are writable and the
  //    upsert dedupes, so a migrated box behaves exactly like a fresh one.
  const fact = { accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1",
    metric: "spend", value: 5, currency: "USD", sourceTimezone: "America/New_York",
    observedAt: "2026-08-11T00:00:00.000Z" };
  store.putFact(fact);
  store.putFact({ ...fact, value: 7 });
  const migrated = store.factsFor({ accountId: "acme" }).filter((f) => f.sourceAccountId === "act_1");
  assert.equal(migrated.length, 1, "the identity index must dedupe on a migrated store, not only a fresh one");
  assert.equal(migrated[0].value, 7, "the restatement wins");
  assert.equal(migrated[0].sourceTimezone, "America/New_York");
  store.close();
});

test("a pre-campaign store preserves account rows and rebuilds identity around campaign id", () => {
  const file = tmpFile();
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE facts (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, provider TEXT NOT NULL,
    source_account_id TEXT, metric TEXT NOT NULL, value REAL NOT NULL, currency TEXT,
    source_timezone TEXT, observed_at TEXT NOT NULL, captured_at TEXT NOT NULL)`);
  old.exec(`CREATE UNIQUE INDEX facts_identity ON facts(
    account_id, provider, COALESCE(source_account_id,''), metric, observed_at)`);
  old.exec(`INSERT INTO facts (id, account_id, provider, source_account_id, metric, value,
    currency, source_timezone, observed_at, captured_at)
    VALUES ('legacy','acme','meta_ads','act_1','spend',30,'USD','America/New_York',
      '2026-08-10T00:00:00.000Z','2026-08-10T01:00:00.000Z')`);
  old.close();

  const store = openStore(file);
  const [legacy] = store.factsFor({ accountId: "acme" });
  assert.equal(legacy.id, "legacy", "the existing account-level row must not be deleted during migration");
  assert.equal(legacy.campaignId, null);
  assert.equal(legacy.campaignName, null);

  const base = { accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1",
    metric: "spend", currency: "USD", observedAt: "2026-08-11T00:00:00.000Z" };
  store.putFact({ ...base, campaignId: "cmp_1", campaignName: "One", value: 10 });
  store.putFact({ ...base, campaignId: "cmp_2", campaignName: "Two", value: 20 });
  assert.equal(store.factsFor({ accountId: "acme" }).length, 3,
    "the legacy row and two new campaign rows must all remain addressable");

  const check = new DatabaseSync(file);
  const sql = String(check.prepare(
    "SELECT sql FROM sqlite_master WHERE type='index' AND name='facts_identity'",
  ).get().sql);
  assert.match(sql, /campaign_id/, "the migrated identity must include campaign id");
  check.close();
  store.close();
});

test("a store carrying the OLD task-aware identity index has it rebuilt, or every write fails", () => {
  // The second migration in this file, and the same class of bug as the missing
  // ALTER above. CREATE UNIQUE INDEX ... IF NOT EXISTS is a NO-OP on a file that
  // already has facts_identity, so a store built by an earlier build keeps the
  // index that names task_id -- while putFact's ON CONFLICT target no longer
  // does. SQLite requires that target to match a real unique index EXACTLY, so
  // the mismatch fails "ON CONFLICT clause does not match any PRIMARY KEY or
  // UNIQUE constraint" on EVERY write: a store that opens cleanly and can never
  // record a fact again.
  const file = tmpFile();
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE facts (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, task_id TEXT, provider TEXT NOT NULL,
    source_account_id TEXT, metric TEXT NOT NULL, value REAL NOT NULL, currency TEXT,
    source_timezone TEXT, observed_at TEXT NOT NULL, captured_at TEXT NOT NULL)`);
  old.exec(`CREATE UNIQUE INDEX facts_identity ON facts(
    account_id, provider, COALESCE(source_account_id,''), metric, observed_at, COALESCE(task_id,''))`);
  old.close();

  const store = openStore(file);
  const fact = { accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1",
    metric: "spend", value: 10, currency: "USD", observedAt: "2026-08-10T00:00:00.000Z" };
  store.putFact(fact);
  store.putFact({ ...fact, value: 12.5 });
  const rows = store.factsFor({ accountId: "acme" });
  assert.equal(rows.length, 1, "the rebuilt index must still dedupe the hourly re-read");
  assert.equal(rows[0].value, 12.5);

  const sql = String(new DatabaseSync(file)
    .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='facts_identity'").get().sql);
  assert.equal(/task_id/.test(sql), false, "the stale index must be replaced, not left beside a mismatched ON CONFLICT");
  store.close();
});

test("identity is per account, per source account and per metric -- and a card cannot split it", () => {
  // The dedup must not over-merge (two clients or two ad accounts are genuinely
  // different facts) and must not UNDER-merge either: a taskId on the fact must
  // no longer be able to store a second copy of an already-measured day, which
  // is what would have doubled every spend sum.
  const store = openStore(tmpFile());
  const base = { provider: "meta_ads", metric: "spend", value: 5, currency: "USD", observedAt: "2026-08-10T00:00:00.000Z" };
  store.putFact({ ...base, accountId: "acme", sourceAccountId: "act_1" });
  store.putFact({ ...base, accountId: "acme", sourceAccountId: "act_2" });
  store.putFact({ ...base, accountId: "acme", sourceAccountId: "act_1", taskId: "t_1" });
  store.putFact({ ...base, accountId: "other", sourceAccountId: "act_1" });
  assert.equal(store.factsFor({ accountId: "acme" }).length, 2,
    "a different source account is a different fact; a card is NOT -- it would double the day");
  assert.equal(store.factsFor({ accountId: "other" }).length, 1, "and accounts stay isolated");
  store.close();
});

// A store written by an EARLIER commit on this branch, where the hourly tick
// shipped before the identity index existed and wrote plain INSERTs. Such a file
// holds the very duplicates the index forbids, so creating that index would throw
// "UNIQUE constraint failed" -> openStore throws -> measurementStore() returns
// null -> every facts route and every tick fails permanently. A box bricked by its
// own upgrade, and silent about why.
//
// Raised by the independent reviewer (Kimi/Moonshot) against the migration fix,
// which handled missing COLUMNS but not pre-existing duplicate ROWS.
test("a pre-index store full of duplicate rows still opens, and keeps the newest of each", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "measurement-preindex-"));
  const file = path.join(dir, "measurement.sqlite");

  // Build the OLD shape by hand: the real table, no facts_identity index at all.
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE facts (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, task_id TEXT, provider TEXT NOT NULL,
    source_account_id TEXT, metric TEXT NOT NULL, value REAL NOT NULL, currency TEXT,
    observed_at TEXT NOT NULL, captured_at TEXT NOT NULL)`);
  // Three hourly re-reads of the same day, as the pre-index tick really wrote them.
  for (const [i, value] of [[1, 10], [2, 20], [3, 30]]) {
    old.prepare(`INSERT INTO facts (id, account_id, task_id, provider, source_account_id,
      metric, value, currency, observed_at, captured_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run("f" + i, "acct_1", null, "meta_ads", "act_9", "spend", value, "USD",
        "2026-08-10", "2026-08-10T0" + i + ":00:00Z");
  }
  old.close();

  const store = openStore(file);   // must not throw
  const facts = store.factsFor({ accountId: "acct_1" });
  assert.equal(facts.length, 1, "the duplicates are collapsed to one row");
  assert.equal(facts[0].value, 30, "and the row kept is the LAST written — the freshest restatement");

  const check = new DatabaseSync(file);
  const idx = check
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='facts_identity'").get();
  assert.ok(idx, "the identity index now exists, so the next tick upserts instead of duplicating");
  check.close();
  try { store.close(); } catch {}

  fs.rmSync(dir, { recursive: true, force: true });
});
