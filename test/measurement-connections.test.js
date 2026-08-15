// test/measurement-connections.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
// test/ is ESM (package.json is "type": "module"), so a bare top-level
// require() throws before any assertion runs. container/ is CommonJS, so it
// is loaded through the shim. Match test/measurement-credentials.test.js.
const require = createRequire(import.meta.url);
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openStore } = require("../container/measurement-store.js");
const { measurementWithTimeout } = require("../container/gate.js");

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "conn-")), "m.sqlite");

test("a connection round-trips and only enabled ones are offered for sync", () => {
  const store = openStore(tmp());
  store.putConnection({ accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1", enabled: true });
  store.putConnection({ accountId: "acme", provider: "meta_ads", sourceAccountId: "act_2", enabled: false });
  const live = store.connections({ enabled: true });
  assert.equal(live.length, 1);
  assert.equal(live[0].sourceAccountId, "act_1");
  assert.equal(live[0].lastSyncedAt, null, "a connection that has never synced must say so, not read as fresh");
  store.close();
});

test("re-connecting the same ad account updates it rather than duplicating it", () => {
  const store = openStore(tmp());
  store.putConnection({ accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1", enabled: true });
  store.putConnection({ accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1", enabled: false });
  assert.equal(store.connections({}).length, 1, "duplicates would double-count every synced fact");
  assert.equal(store.connections({})[0].enabled, false);
  store.close();
});

test("a failed sync is recorded ON the connection, with its cause", () => {
  // Cardinal Rule 16. A connection that has silently stopped working must be
  // distinguishable from one that has nothing to report.
  const store = openStore(tmp());
  store.putConnection({ accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1", enabled: true });
  store.markConnectionSync({ accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1",
    at: "2026-08-11T00:00:00.000Z", error: "Pipedream refused to read meta_ads (403): account not connected" });
  const [c] = store.connections({});
  assert.match(c.lastError, /account not connected/);
  assert.equal(c.lastSyncedAt, "2026-08-11T00:00:00.000Z", "the attempt time is recorded even on failure");
  store.close();
});

test("a later success clears the previous error", () => {
  const store = openStore(tmp());
  store.putConnection({ accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1", enabled: true });
  store.markConnectionSync({ accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1", at: "2026-08-11T00:00:00.000Z", error: "boom" });
  store.markConnectionSync({ accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1", at: "2026-08-11T01:00:00.000Z", error: null });
  assert.equal(store.connections({})[0].lastError, null, "a stale error would keep reporting a fault that is fixed");
  store.close();
});

// SOURCE-READING, and labelled as such -- NARROWED to what genuinely cannot be
// executed. measurementTick itself sits below gate.js's lib-mode
// `require.main !== module` early return (see kanbanFailureCause's export
// block), so the timer wiring and the busy-flag guard can only be read, never
// run.
//
// Everything this test USED to assert about the sweep's behaviour -- that both
// audit branches fire, that a failure is recorded, that the window is a trailing
// one -- was the dishonest part: those assertions passed with the `await`
// removed, with the loop returning on error, and with a single-day window, which
// is how findings 2 and 3 survived review. That behaviour now lives in
// test/measurement-sweep.test.js, which DRIVES measurementSweep with fakes.
// Grep assertions are not kept as a second opinion on things a real test covers.
//
// The brief for this step used `__dirname`, which does not exist in an ESM
// test file even under the createRequire shim (the shim only patches
// `require`, not the CJS-only globals). Node 22's `import.meta.dirname` is
// the ESM equivalent already used by test/kanban-boot-readiness.test.js.
test("the sync has a real trigger wired into the gate", () => {
  const gate = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");
  assert.match(gate, /setInterval\(measurementTick, MEASUREMENT_TICK_MS\)/,
    "syncAccount with no caller is a library, not a feature (Cardinal Rule 11)");
  assert.match(gate, /if \(measurementTickBusy\) \{/,
    "a slow provider must not stack overlapping syncs");
  assert.match(gate, /this tick was skipped/,
    "a skip caused by a wedged sync must announce itself");
  assert.match(gate, /let measurementBusySince = 0;/,
    "which requires knowing how long it has been busy");
  assert.match(gate, /await measurementSweep\(\{/,
    "and the trigger must reach the sweep that the behavioural tests cover");
});

test("a hung provider is bounded, and the timeout CANCELS the call rather than only racing it", async () => {
  // BEHAVIOURAL, not source-reading: measurementWithTimeout is a hoisted
  // function declaration, so it IS reachable from gate.js's lib-mode export and
  // there is no excuse for grepping it.
  //
  // Found by Kimi/Moonshot as an independent third-vendor review: `finally` only
  // runs when the await SETTLES, so a fetch that never answers (Node's fetch has
  // no default timeout) left the busy flag true for the life of the process.
  // FINDING 6 then showed the fix was only half of one -- the race abandoned the
  // losing branch but never cancelled it, so the real call resolved later and
  // putFacts wrote facts the audit trail had already recorded as failed.
  let aborted = false;
  const neverAnswers = new Promise(() => {});
  const r = await measurementWithTimeout(neverAnswers, 5, "acme/meta_ads", () => { aborted = true; });

  assert.equal(r.ok, false, "a timeout must RESOLVE with a failure, never reject into a timer");
  assert.match(r.why, /acme\/meta_ads did not answer within/,
    "Cardinal Rule 16: the timeout must name WHICH connection hung");
  assert.equal(aborted, true, "the timeout must cancel the in-flight call, or the write still lands later");
});

test("a call that answers in time is untouched, and cancellation is not fired", async () => {
  let aborted = false;
  const r = await measurementWithTimeout(Promise.resolve({ ok: true, written: 3 }), 60_000, "acme/meta_ads", () => { aborted = true; });
  assert.deepEqual(r, { ok: true, written: 3 }, "the real result must pass through unaltered");
  assert.equal(aborted, false, "a healthy call must never be cancelled");
});

test("a cancellation callback that throws cannot turn a timeout into an unhandled rejection", async () => {
  const r = await measurementWithTimeout(new Promise(() => {}), 5, "acme/meta_ads", () => { throw new Error("abort blew up"); });
  assert.equal(r.ok, false);
  assert.match(r.why, /did not answer within/, "the timeout must still report cleanly");
});

test("a gated Loop names itself, so three anonymous approvals a day cannot happen", () => {
  // SOURCE-READING, labelled as such: cronTick sits below gate.js's lib-mode
  // export. MEASURED on the live box 2026-08-11 — cron_approval_required fired at
  // 00:00, 04:00 and 11:00 with byte-identical detail and no job identity, so the
  // operator could not tell which Loop was asking or that two different ones were.
  const gate = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");
  assert.match(gate, /audit\("cron_approval_required", `\$\{job\.name\}: \$\{cause\}`\)/,
    "the approval request must say which Loop it is about");
});

// ---- the reader that makes a dead connection visible ---------------------------

const { handleMeasurement } = require("../container/measurement-lib.js");

function listHarness(store, { method = "GET" } = {}) {
  const sent = [];
  const sendJson = (res, status, body) => sent.push({ status, body });
  return {
    sent,
    run(search = "") {
      const url = new URL("http://box/measurement/connections" + search);
      return handleMeasurement(url, { method }, {}, sendJson, () => store, (req, res, cb) => cb({}));
    },
  };
}

test("a connection that has been failing for days is VISIBLY failing through the route", () => {
  // THE FAILING CASE. last_error and last_synced_at are written on every
  // connection on every hourly tick and had NO reader: this route refused GET,
  // and /measurement/status answers connected:true off the presence of three
  // credential names alone. So the box reported healthy while a client's
  // credential had been revoked for a week and every sync since had failed.
  // The cause existed, correctly worded, in a column nothing could read.
  const store = openStore(tmp());
  store.putConnection({ accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1", pipedreamAccountId: "apn_ok", enabled: true });
  store.putConnection({ accountId: "acme", provider: "meta_ads", sourceAccountId: "act_2", pipedreamAccountId: "apn_dead", enabled: true });
  store.markConnectionSync({ accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1", at: "2026-08-11T00:00:00.000Z", error: null });
  store.markConnectionSync({ accountId: "acme", provider: "meta_ads", sourceAccountId: "act_2", at: "2026-08-11T00:00:00.000Z",
    error: "the recorded meta_ads credential 'apn_dead' is not among the 2 connected accounts for this client" });

  const h = listHarness(store);
  assert.equal(h.run(), true);
  assert.equal(h.sent[0].status, 200);
  const bySource = Object.fromEntries(h.sent[0].body.connections.map((c) => [c.sourceAccountId, c]));

  assert.equal(bySource.act_1.lastError, null, "a healthy connection must not look broken");
  assert.equal(bySource.act_1.lastSyncedAt, "2026-08-11T00:00:00.000Z");
  assert.match(bySource.act_2.lastError, /is not among the 2 connected accounts/,
    "Cardinal Rule 16: the cause the sweep already recorded must be readable by the operator, not only by grepping the audit log");
  assert.doesNotMatch(bySource.act_2.lastError, /apn_dead/,
    "the actionable cause must never publish the credential identifier embedded in the stored failure");
  assert.match(bySource.act_2.lastError, /credential id redacted/);
  assert.equal(bySource.act_2.enabled, true, "and it must be clear the operator did not simply turn it off");
  store.close();
});

test("the list carries ids and status only, never a credential", () => {
  const store = openStore(tmp());
  store.putConnection({ accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1", pipedreamAccountId: "apn_ok", enabled: true });
  store.markConnectionSync({
    accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1",
    at: "2026-08-11T00:00:00.000Z",
    error: "the recorded meta_ads credential 'apn_ok' is not among the 1 connected accounts",
  });
  const h = listHarness(store);
  h.run();
  const [c] = h.sent[0].body.connections;
  assert.deepEqual(Object.keys(c).sort(),
    ["accountId", "enabled", "id", "lastError", "lastSyncedAt", "provider", "sourceAccountId"],
    "a new field on this row would be published to the operator surface, so the shape is pinned");
  const dump = JSON.stringify(h.sent[0].body);
  assert.equal(dump.includes("apn_ok"), false,
    "the public row and its failure cause name the stable connection, never the credential backing it");
  for (const forbidden of ["secret", "token", "clientSecret", "include_credentials", "Bearer"]) {
    assert.equal(dump.includes(forbidden), false, "ABSENCE: " + forbidden + " must never reach a response body");
  }
  store.close();
});

test("the list can be narrowed to one client, and a bad accountId is refused rather than ignored", () => {
  const store = openStore(tmp());
  store.putConnection({ accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1", pipedreamAccountId: "apn_1", enabled: true });
  store.putConnection({ accountId: "other", provider: "meta_ads", sourceAccountId: "act_9", pipedreamAccountId: "apn_9", enabled: true });

  const scoped = listHarness(store);
  scoped.run("?accountId=acme");
  assert.deepEqual(scoped.sent[0].body.connections.map((c) => c.accountId), ["acme"]);

  const all = listHarness(store);
  all.run();
  assert.equal(all.sent[0].body.connections.length, 2, "an operator who cannot remember which client is broken must be able to list them all");

  // Silently ignoring a malformed filter would answer with EVERY client's
  // connections to a caller who asked for one -- a wrong answer, not a refusal.
  const bad = listHarness(store);
  bad.run("?accountId=../etc");
  assert.equal(bad.sent[0].status, 400);
  assert.match(bad.sent[0].body.error, /accountId must match/);
  store.close();
});

test("an unsupported verb on the connections route still names both things it does", () => {
  const store = openStore(tmp());
  const h = listHarness(store, { method: "DELETE" });
  assert.equal(h.run(), true);
  assert.equal(h.sent[0].status, 405);
  assert.match(h.sent[0].body.error, /POST/);
  assert.match(h.sent[0].body.error, /GET/, "a refusal must say what the route DOES do, not only what it will not");
  store.close();
});
