import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { openStore, ID_RE, connectionId } = require("../container/measurement-store.js");
const {
  handleMeasurement,
  trackConnectionSync,
  cancelConnectionSync,
} = require("../container/measurement-lib.js");

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "measurement-delete-")), "m.sqlite");
const connection = (overrides = {}) => ({
  accountId: "acme",
  provider: "meta_ads",
  sourceAccountId: "act_1",
  pipedreamAccountId: "apn_credential_9",
  enabled: true,
  ...overrides,
});

function fact(overrides = {}) {
  return {
    accountId: "acme",
    provider: "meta_ads",
    sourceAccountId: "act_1",
    campaignId: "cmp_1",
    campaignName: "Launch",
    metric: "spend",
    value: 12,
    currency: "USD",
    observedAt: "2026-08-10T00:00:00.000Z",
    ...overrides,
  };
}

function route(store, { method = "GET", audit, cancelConnection } = {}) {
  const sent = [];
  const events = [];
  const sendJson = (_res, status, body) => sent.push({ status, body });
  return {
    sent,
    events,
    run(pathname) {
      return handleMeasurement(
        new URL("http://box" + pathname),
        { method },
        {},
        sendJson,
        () => store,
        undefined,
        {
          audit: audit || ((event, detail) => events.push({ event, detail })),
          cancelConnection,
          env: {},
        },
      );
    },
  };
}

test("a connection id is deterministic, safe, composite, and never the credential id", () => {
  const c = connection();
  const id = connectionId(c);
  assert.equal(id, connectionId({ ...c, pipedreamAccountId: "apn_other" }),
    "credential rotation must not change the public connection identity");
  assert.match(id, ID_RE);
  assert.equal(id.includes(c.pipedreamAccountId), false);
  assert.notEqual(id, connectionId({ ...c, accountId: "other" }));
  assert.notEqual(id, connectionId({ ...c, provider: "google_ads" }));
  assert.notEqual(id, connectionId({ ...c, sourceAccountId: "act_2" }));
});

test("the store previews and deletes only the exact disabled connection triple", () => {
  const store = openStore(tmp());
  const target = connection();
  store.putConnection(target);
  store.putConnection(connection({ sourceAccountId: "act_2", pipedreamAccountId: "apn_2" }));
  store.putFact(fact());
  store.putFact(fact({ metric: "revenue", value: 40 }));
  store.putFact(fact({ sourceAccountId: "act_2", campaignId: "cmp_2" }));
  store.putFact(fact({ accountId: "other", sourceAccountId: "act_1", campaignId: "cmp_3" }));

  assert.equal(store.countFactsForConnection(target), 2);
  assert.throws(
    () => store.deleteFactsForConnection(target),
    (error) => error && error.code === "MEASUREMENT_CONNECTION_ENABLED",
    "facts cannot be deleted while a future read can recreate them",
  );

  const disconnected = store.disconnectConnection(target);
  assert.equal(disconnected.found, true);
  assert.equal(disconnected.connection.enabled, false);
  const deleted = store.deleteFactsForConnection(target);
  assert.deepEqual(deleted, { ok: true, deleted: 2 });
  assert.equal(store.countFactsForConnection(target), 0);
  assert.equal(store.countFactsForConnection(connection({ sourceAccountId: "act_2" })), 1,
    "another ad account on the same client/provider must survive");
  assert.equal(store.factsFor({ accountId: "other" }).length, 1,
    "another client must survive even when its source account id matches");
  store.close();
});

test("disconnect is operator reachable, cancels only that live sync, audits success, and names its limit", () => {
  const store = openStore(tmp());
  const target = connection();
  const other = connection({ sourceAccountId: "act_2", pipedreamAccountId: "apn_2" });
  store.putConnection(target);
  store.putConnection(other);
  const targetController = new AbortController();
  const otherController = new AbortController();
  const releaseTarget = trackConnectionSync(target, targetController);
  const releaseOther = trackConnectionSync(other, otherController);

  const h = route(store, { method: "DELETE", cancelConnection: cancelConnectionSync });
  assert.equal(h.run(`/measurement/connections/${connectionId(target)}`), true);
  assert.equal(h.sent[0].status, 200);
  assert.equal(h.sent[0].body.connection.enabled, false);
  assert.equal(h.sent[0].body.inFlightCancelled, true);
  assert.match(h.sent[0].body.disclosure, /does not revoke/i);
  assert.equal(targetController.signal.aborted, true);
  assert.equal(otherController.signal.aborted, false, "disconnect must not cancel another ad account's read");
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].event, "measurement_connection_disconnected");
  assert.equal(JSON.stringify(h.sent[0].body).includes("apn_credential_9"), false,
    "the credential identifier is not part of the public connection contract");

  releaseTarget();
  releaseOther();
  store.close();
});

test("facts preview names the exact count and deletion audits only after success", () => {
  const store = openStore(tmp());
  const target = connection();
  store.putConnection(target);
  store.putFact(fact());
  const id = connectionId(target);

  const preview = route(store);
  assert.equal(preview.run(`/measurement/connections/${id}/facts`), true);
  assert.deepEqual(preview.sent[0], {
    status: 200,
    body: { connectionId: id, count: 1, enabled: true },
  });
  assert.equal(preview.events.length, 0, "a preview is a read, not a destructive action");

  const refused = route(store, { method: "DELETE" });
  refused.run(`/measurement/connections/${id}/facts`);
  assert.equal(refused.sent[0].status, 409);
  assert.match(refused.sent[0].body.error, /disconnect/i);
  assert.equal(refused.events.length, 0, "a refused delete is not a successful audit event");

  store.disconnectConnection(target);
  const removed = route(store, { method: "DELETE" });
  removed.run(`/measurement/connections/${id}/facts`);
  assert.deepEqual(removed.sent[0], {
    status: 200,
    body: { ok: true, connectionId: id, deleted: 1 },
  });
  assert.equal(removed.events.length, 1);
  assert.equal(removed.events[0].event, "measurement_facts_deleted");
  assert.match(removed.events[0].detail, /1 stored fact/);
  store.close();
});

test("unknown connection ids return 404 and produce no cancellation or success audit", () => {
  const store = openStore(tmp());
  let cancelled = 0;
  const h = route(store, { method: "DELETE", cancelConnection: () => { cancelled += 1; } });
  h.run("/measurement/connections/mc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(h.sent[0].status, 404);
  assert.match(h.sent[0].body.error, /not found/i);
  assert.equal(cancelled, 0);
  assert.equal(h.events.length, 0);
  store.close();
});
