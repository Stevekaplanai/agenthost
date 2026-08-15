// test/measurement-sweep.test.js
// BEHAVIOURAL coverage of the measurement sweep -- the thing that had none.
//
// Why this file exists at all: measurementTick's only tests were SOURCE-READING
// assertions in test/measurement-connections.test.js that matched strings in
// gate.js. Those tests pass with the `await` removed, with the loop `return`ing
// on the first error, and with a single-day window -- which is precisely how
// findings 2 and 3 survived every per-task review. A test that reads source
// proves the source SAYS something; only a test that runs the code proves it
// DOES something.
//
// measurementSweep is now a hoisted function exported from gate.js's lib-mode
// block, taking store/adapters/window/sync/audit as parameters, so it can be
// driven here with fakes and no SQLite, no network, and no timers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
// test/ is ESM (package.json is "type": "module"), so a bare top-level
// require() throws before any assertion runs. container/ is CommonJS, so it is
// loaded through the shim; import.meta.dirname is the ESM equivalent of the
// CJS-only __dirname, which the shim does NOT provide.
const require = createRequire(import.meta.url);
const { measurementSweep, completedMeasurementSyncRange } = require("../container/gate.js");
const { publicConnection, currentCredentialSafeSync } = require("../container/measurement-lib.js");

// A fake store that records what the sweep did to it. Only the two methods the
// sweep actually calls, so an accidental new dependency shows up as a TypeError
// rather than passing silently against an over-generous double.
function fakeStore(connections) {
  const marks = [];
  return {
    marks,
    connections({ enabled }) {
      assert.equal(enabled, true, "the sweep must ask for ENABLED connections only");
      return connections;
    },
    markConnectionSync(m) { marks.push(m); return { ok: true }; },
  };
}

function recorder() {
  const events = [];
  return { events, audit: (event, detail) => events.push({ event, detail }) };
}

const conn = (accountId, sourceAccountId, provider = "meta_ads") =>
  ({ accountId, provider, sourceAccountId, enabled: true });

const ADAPTERS = { meta_ads: { provider: "meta_ads" } };
const WINDOW = { since: "2026-08-04", until: "2026-08-10" };

test("zero enabled connections AUDITS ITSELF as idle rather than going quiet", async () => {
  // FINDING 1b. Nothing wrote a connection, so this was the real state of every
  // box: the loop body never ran and the tick audited NOTHING. An inert
  // pipeline looked exactly like a healthy quiet one, hourly, forever -- and
  // that silence is why finding 1 went unnoticed in the first place.
  const store = fakeStore([]);
  const rec = recorder();
  let synced = 0;
  const r = await measurementSweep({
    store, adapters: ADAPTERS, ...WINDOW, audit: rec.audit,
    sync: async () => { synced += 1; return { ok: true, written: 1 }; },
  });

  assert.equal(synced, 0);
  assert.deepEqual(r, { connections: 0, ok: 0, failed: 0 });
  assert.equal(rec.events.length, 1, "an idle sweep must say exactly one thing, not nothing");
  assert.equal(rec.events[0].event, "measurement_sync_idle");
  assert.match(rec.events[0].detail, /0 enabled connections/,
    "the audit must NAME the count, so 'idle' cannot be confused with 'working'");
  assert.match(rec.events[0].detail, /2026-08-04\.\.2026-08-10/, "and say which window produced nothing");
});

test("a connection disabled after the enabled snapshot is re-checked before any provider read", async () => {
  const c = conn("acme", "act_1");
  const marks = [];
  const events = [];
  let synced = 0;
  const store = {
    connections: () => [c],
    connectionFor: () => ({ ...c, enabled: false }),
    markConnectionSync: (value) => marks.push(value),
  };
  const result = await measurementSweep({
    store, adapters: ADAPTERS, ...WINDOW,
    audit: (event, detail) => events.push({ event, detail }),
    sync: async () => { synced += 1; return { ok: true, written: 1 }; },
  });
  assert.equal(synced, 0, "a stale enabled snapshot must not start a provider read");
  assert.equal(marks.length, 0);
  assert.deepEqual(result, { connections: 1, ok: 0, failed: 0 });
  assert.equal(events[0].event, "measurement_sync_skipped");
  assert.match(events[0].detail, /disabled before/);
});

test("a disconnect during an in-flight read prevents that cancelled read from rewriting connection health", async () => {
  const c = conn("acme", "act_1");
  let enabled = true;
  const marks = [];
  const events = [];
  const store = {
    connections: () => [c],
    connectionFor: () => ({ ...c, enabled }),
    markConnectionSync: (value) => marks.push(value),
  };
  const result = await measurementSweep({
    store, adapters: ADAPTERS, ...WINDOW,
    audit: (event, detail) => events.push({ event, detail }),
    sync: async () => {
      enabled = false;
      return { ok: false, why: "provider request was aborted" };
    },
  });
  assert.equal(marks.length, 0,
    "operator cancellation must not be recorded later as a fresh sync failure on the disabled row");
  assert.deepEqual(result, { connections: 1, ok: 0, failed: 0 });
  assert.equal(events[0].event, "measurement_sync_skipped");
  assert.match(events[0].detail, /disabled while/);
});

test("one connection failing does not stop the next -- the whole sweep still runs", async () => {
  // FINDING 2, layer 3. syncAccount REJECTED (rather than returning {ok,why})
  // when an adapter threw, the rejection hit the tick's single outer catch, and
  // that catch RETURNED out of the for-loop. Result: one malformed provider row
  // on the first account silently skipped every other client on the box, every
  // hour, with their last_error left stale and reading as healthy.
  const store = fakeStore([conn("acme", "act_1"), conn("beta", "act_2"), conn("gamma", "act_3")]);
  const rec = recorder();
  const attempted = [];
  const r = await measurementSweep({
    store, adapters: ADAPTERS, ...WINDOW, audit: rec.audit,
    sync: async ({ connection }) => {
      attempted.push(connection.accountId);
      // The exact shape of the original defect: a REJECTION, not a returned failure.
      if (connection.accountId === "acme") throw new RangeError("Invalid time value");
      return { ok: true, written: 2 };
    },
  });

  assert.deepEqual(attempted, ["acme", "beta", "gamma"],
    "every connection after the failure must still be attempted");
  assert.deepEqual(r, { connections: 3, ok: 2, failed: 1 });
});

test("a per-connection error is RECORDED on that connection, with its cause", async () => {
  // The other half of the same defect: markConnectionSync never ran for the
  // skipped connections, so last_error stayed stale -- a connection that had
  // stopped working kept reporting whatever it said last time.
  const store = fakeStore([conn("acme", "act_1"), conn("beta", "act_2")]);
  const rec = recorder();
  await measurementSweep({
    store, adapters: ADAPTERS, ...WINDOW, audit: rec.audit,
    sync: async ({ connection }) => (connection.accountId === "acme"
      ? { ok: false, why: "Pipedream refused to read meta_ads (403): account not connected" }
      : { ok: true, written: 2 }),
  });

  assert.equal(store.marks.length, 2, "EVERY connection's outcome must be recorded, not just the healthy ones");
  const [bad, good] = store.marks;
  assert.equal(bad.accountId, "acme");
  assert.match(bad.error, /account not connected/, "Cardinal Rule 16: the recorded cause must be the real one");
  assert.equal(typeof bad.at, "string", "the attempt time is recorded even on failure");
  assert.equal(good.accountId, "beta");
  assert.equal(good.error, null, "a success must CLEAR the previous error, not leave a fixed fault reported");
});

test("a credential identifier is redacted before a sync failure is persisted or audited", async () => {
  const credentialId = "apn_private_credential_9";
  const c = { ...conn("acme", "act_1"), pipedreamAccountId: credentialId };
  const store = fakeStore([c]);
  const rec = recorder();
  await measurementSweep({
    store, adapters: ADAPTERS, ...WINDOW, audit: rec.audit,
    sync: async () => ({
      ok: false,
      why: `the recorded meta_ads credential '${credentialId}' is not among the 2 connected accounts for this client`,
    }),
  });

  assert.equal(store.marks.length, 1);
  assert.equal(store.marks[0].error.includes(credentialId), false,
    "the credential id must not be written into last_error");
  assert.match(store.marks[0].error, /credential id redacted/);
  assert.equal(JSON.stringify(rec.events).includes(credentialId), false,
    "the credential id must not be written into the audit trail");
  assert.match(rec.events[0].detail, /credential id redacted/);
});

test("credential rotation redacts the old snapshot and exact current id from returned and thrown sync causes", async () => {
  const oldId = "apn_old_private_1";
  const currentId = "apn_new_private_2";
  const snapshot = { ...conn("acme", "act_1"), pipedreamAccountId: oldId };
  const current = { ...snapshot, pipedreamAccountId: currentId };

  for (const mode of ["returned", "thrown"]) {
    const marks = [];
    const rec = recorder();
    const store = {
      connections: () => [snapshot],
      connectionFor: () => current,
      markConnectionSync: (value) => marks.push(value),
    };
    const upstream = `Pipedream refused to read meta_ads (502): account_id ${currentId} could not read insights after replacing ${oldId}`;
    await measurementSweep({
      store, adapters: ADAPTERS, ...WINDOW, audit: rec.audit,
      sync: async () => currentCredentialSafeSync(current, async () => {
        if (mode === "thrown") throw new Error(upstream);
        return { ok: false, why: upstream };
      }),
    });

    assert.equal(marks.length, 1, `${mode} failure records one current connection outcome`);
    assert.match(marks[0].error, /Pipedream refused to read meta_ads \(502\).*could not read insights/,
      `${mode} failure keeps its bounded actionable upstream cause`);
    const publicRow = publicConnection({ ...current, lastError: marks[0].error });
    for (const surface of [marks[0].error, JSON.stringify(publicRow), JSON.stringify(rec.events)]) {
      assert.equal(surface.includes(oldId), false, `${mode} failure must not expose the old snapshot credential`);
      assert.equal(surface.includes(currentId), false, `${mode} failure must not expose the freshly re-read credential`);
    }
  }
});

test("a thrown failure is recorded on the connection too, not only audited", async () => {
  const store = fakeStore([conn("acme", "act_1")]);
  const rec = recorder();
  await measurementSweep({
    store, adapters: ADAPTERS, ...WINDOW, audit: rec.audit,
    sync: async () => { throw new Error("socket hang up"); },
  });
  assert.equal(store.marks.length, 1);
  assert.match(store.marks[0].error, /socket hang up/);
  assert.match(rec.events[0].detail, /socket hang up/);
});

test("BOTH audit branches fire, so success and failure are each visible", async () => {
  // Rule 16: silence and success must never look alike. A sweep that audited
  // only failures would make a working box indistinguishable from a dead one.
  const store = fakeStore([conn("acme", "act_1"), conn("beta", "act_2")]);
  const rec = recorder();
  await measurementSweep({
    store, adapters: ADAPTERS, ...WINDOW, audit: rec.audit,
    sync: async ({ connection }) => (connection.accountId === "acme"
      ? { ok: true, written: 14 }
      : { ok: false, why: "the provider returned nothing" }),
  });

  const byEvent = rec.events.map((e) => e.event);
  assert.deepEqual(byEvent, ["measurement_sync_ok", "measurement_sync_failed"]);
  assert.match(rec.events[0].detail, /acme\/meta_ads\/act_1: 14 facts/,
    "a success must name which connection and how many facts");
  assert.match(rec.events[1].detail, /beta\/meta_ads\/act_2: the provider returned nothing/);
});

test("the TRAILING WINDOW is what gets requested, not a single day", async () => {
  // FINDING 3. Meta's default 7-day-click attribution keeps adding purchase
  // value to day D for a week, ALL of it after D+1. Syncing only yesterday
  // meant none of those restatements was ever re-read: spend came out right,
  // revenue came out low, and the ROAS was a plausible wrong number.
  const store = fakeStore([conn("acme", "act_1")]);
  const rec = recorder();
  const asked = [];
  await measurementSweep({
    store, adapters: ADAPTERS, ...WINDOW, audit: rec.audit,
    sync: async ({ since, until }) => { asked.push({ since, until }); return { ok: true, written: 7 }; },
  });

  assert.equal(asked.length, 1, "a range must be ONE bounded call, not seven separate ones");
  assert.deepEqual(asked[0], { since: "2026-08-04", until: "2026-08-10" });
  const days = (Date.parse(asked[0].until + "T00:00:00Z") - Date.parse(asked[0].since + "T00:00:00Z")) / 86400000 + 1;
  assert.equal(days, 7, "7 days is the honest floor for Meta's default attribution window");
});

test("a cold New York account at 02:00 UTC fetches the timezone-safe union needed for seven local days", () => {
  assert.deepEqual(
    completedMeasurementSyncRange(Date.parse("2026-08-12T02:00:00.000Z")),
    { since: "2026-08-04", until: "2026-08-12" },
    "August 4 must be fetched before New York filters out its partial August 11",
  );

  // SOURCE-READING only for the unreachable timer wiring: the range arithmetic
  // itself is behaviourally exercised above.
  const fs = require("node:fs");
  const path = require("node:path");
  const gate = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");
  assert.match(gate, /completedMeasurementSyncRange\(\)/,
    "the scheduled tick must use the same timezone-safe union as the tested helper");
});

test("a provider with no adapter fails THAT connection and the sweep carries on", async () => {
  const store = fakeStore([conn("acme", "act_1", "google_ads"), conn("beta", "act_2")]);
  const rec = recorder();
  const attempted = [];
  const r = await measurementSweep({
    store, adapters: ADAPTERS, ...WINDOW, audit: rec.audit,
    sync: async ({ connection }) => { attempted.push(connection.accountId); return { ok: true, written: 1 }; },
  });

  assert.deepEqual(attempted, ["beta"], "an unsyncable provider must not be handed to an adapter that does not exist");
  assert.deepEqual(r, { connections: 2, ok: 1, failed: 1 });
  assert.match(rec.events[0].detail, /no adapter is registered/);
  assert.match(store.marks[0].error, /no adapter is registered/,
    "the connection itself must say why it is not syncing, or it looks merely quiet");
});

test("a sync returning nothing at all is a named failure, never a silent success", async () => {
  const store = fakeStore([conn("acme", "act_1")]);
  const rec = recorder();
  const r = await measurementSweep({
    store, adapters: ADAPTERS, ...WINDOW, audit: rec.audit,
    sync: async () => undefined,
  });
  assert.deepEqual(r, { connections: 1, ok: 0, failed: 1 });
  assert.match(rec.events[0].detail, /no result and no reason/);
});

test("a store that cannot record the outcome still lets the sweep finish", async () => {
  // markConnectionSync is a SQLite write and can throw. If that escaped, the
  // code meant to RECORD a per-connection failure would itself abort the sweep
  // -- reintroducing finding 2 through the back door.
  const store = fakeStore([conn("acme", "act_1"), conn("beta", "act_2")]);
  store.markConnectionSync = (m) => {
    store.marks.push(m);
    if (m.accountId === "acme") throw new Error("database is locked");
    return { ok: true };
  };
  const rec = recorder();
  const attempted = [];
  const r = await measurementSweep({
    store, adapters: ADAPTERS, ...WINDOW, audit: rec.audit,
    sync: async ({ connection }) => { attempted.push(connection.accountId); return { ok: true, written: 1 }; },
  });

  assert.deepEqual(attempted, ["acme", "beta"], "a failed bookkeeping write must not skip the remaining clients");
  assert.equal(r.connections, 2);
  assert.equal(rec.events.some((e) => /could not be recorded on the connection/.test(e.detail)), true,
    "and the bookkeeping failure must name itself rather than vanish");
});

test("a skipped provider row is reported on the success line, not absorbed", async () => {
  // A sync can succeed while having dropped unusable rows. Reporting the count
  // is what stops a quietly-short week reading as a healthy one.
  const store = fakeStore([conn("acme", "act_1")]);
  const rec = recorder();
  await measurementSweep({
    store, adapters: ADAPTERS, ...WINDOW, audit: rec.audit,
    sync: async () => ({ ok: true, written: 5, skipped: 2,
      skippedReasons: ["1 row had an invalid date_start", "1 row had a missing or invalid campaign_id"] }),
  });
  assert.equal(rec.events[0].event, "measurement_sync_ok");
  assert.match(rec.events[0].detail, /2 provider rows skipped/);
  assert.match(rec.events[0].detail, /invalid date_start/);
  assert.match(rec.events[0].detail, /campaign_id/);
  assert.equal(store.marks.length, 1);
  assert.match(store.marks[0].error, /sync incomplete: 2 provider rows skipped/,
    "a partial success must remain visibly degraded instead of clearing connection health");
  assert.match(store.marks[0].error, /invalid date_start/);
  assert.match(store.marks[0].error, /campaign_id/);
});
