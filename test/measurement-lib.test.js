// test/measurement-lib.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
// test/ is ESM (package.json is "type": "module"), so a bare top-level
// require() throws before any assertion runs. container/ is CommonJS, so it
// is loaded through the shim. Match test/measurement-credentials.test.js.
const require = createRequire(import.meta.url);
const { routeFor, handleMeasurement } = require("../container/measurement-lib.js");
const { PROVIDERS } = require("../container/measurement-adapters/index.js");

test("account facts route parses the account id", () => {
  assert.deepEqual(routeFor("/measurement/accounts/acme/facts"), { kind: "account", accountId: "acme" });
});

test("the card-linked facts route is not served, because nothing produces a card-linked fact", () => {
  // Deleted rather than left half-wired. task_id was part of a fact's UNIQUE
  // identity while the account lens below did not filter on it, so the day a
  // card-triggered sync was wired the same account/day/metric would have stored
  // a SECOND row and every spend sum would silently double. Nothing produced
  // one, so the whole lens went (Cardinal Rules 6 and 18).
  assert.equal(routeFor("/measurement/accounts/acme/tasks/t_42/facts"), null);
  assert.equal(routeFor("/measurement/tasks/t_42/facts"), null,
    "and the unscoped shape was never served either -- it would hand a card's facts to anyone who knows its id");
});

test("an unknown path is not claimed, so the gate can fall through", () => {
  assert.equal(routeFor("/measurement/nope"), null);
  assert.equal(routeFor("/growth/accounts"), null);
});

test("a path-traversal id is refused rather than reaching the store", () => {
  assert.equal(routeFor("/measurement/accounts/..%2F..%2Fetc/facts"), null);
});

// ---- handleMeasurement itself -------------------------------------------------
// Review of Task 5 found every test above exercises routeFor ONLY, so a handler
// that returned {facts: []} for everything would pass the entire file. That
// matters here specifically: the defect an independent reviewer blocked in an
// earlier draft of this task -- dropping the account when reading facts --
// lives in the HANDLER, not the router. Testing the router alone cannot see it.

function harness({ store = {}, method = "GET", getStore } = {}) {
  const sent = [];
  const sendJson = (res, status, body) => sent.push({ status, body });
  const calls = [];
  const spyStore = {
    factsFor(args) { calls.push(["factsFor", args]); return store.factsFor ? store.factsFor(args) : []; },
  };
  return {
    sent, calls,
    run(pathname, search = "") {
      const url = new URL("http://box" + pathname + search);
      return handleMeasurement(url, { method }, {}, sendJson,
        getStore || (() => spyStore));
    },
  };
}

test("the deleted card-linked path is not claimed, so it cannot answer with an empty ledger", () => {
  // It must fall through UNCLAIMED rather than return {facts: []}. An empty
  // 200 would read as "this card earned nothing", which is a measurement, not
  // an absence.
  const h = harness();
  assert.equal(h.run("/measurement/accounts/acme/tasks/t_42/facts"), false);
  assert.deepEqual(h.calls, [], "and it must never reach the store");
  assert.deepEqual(h.sent, []);
});

test("the account route passes its window through to the store", () => {
  const h = harness();
  h.run("/measurement/accounts/acme/facts", "?since=2026-08-01&until=2026-08-02");
  assert.deepEqual(h.calls, [["factsFor", { accountId: "acme", since: "2026-08-01", until: "2026-08-02" }]]);
});

test("an absent window is undefined, not an empty string the store would filter on", () => {
  const h = harness();
  h.run("/measurement/accounts/acme/facts");
  assert.deepEqual(h.calls[0][1], { accountId: "acme", since: undefined, until: undefined });
});

test("a write attempt is refused with a reason, and never reaches the store", () => {
  const h = harness({ method: "POST" });
  assert.equal(h.run("/measurement/accounts/acme/facts"), true);
  assert.equal(h.sent[0].status, 405);
  assert.match(h.sent[0].body.error, /read-only/);
  assert.deepEqual(h.calls, [], "a refused write must not touch the store at all");
});

test("an unopenable store degrades with a named cause instead of throwing", () => {
  const h = harness({ getStore: () => null });
  assert.equal(h.run("/measurement/accounts/acme/facts"), true);
  assert.equal(h.sent[0].status, 500);
  assert.match(h.sent[0].body.error, /not available/);
});

test("a store that throws names the cause and does not leak a stack", () => {
  const h = harness({ store: { factsFor() { throw new Error("database is locked"); } } });
  h.run("/measurement/accounts/acme/facts");
  assert.equal(h.sent[0].status, 500);
  assert.match(h.sent[0].body.error, /database is locked/, "Cardinal Rule 16");
  assert.equal(h.sent[0].body.error.includes("at Object"), false, "a stack frame must not reach the response");
});

test("an unclaimed path falls through so the gate can keep routing", () => {
  const h = harness();
  assert.equal(h.run("/growth/accounts"), false);
  assert.deepEqual(h.sent, [], "falling through must not also send a response");
});

// ---- POST /measurement/connections --------------------------------------------
// FINDING 1. putConnection had no caller outside its own test, so
// store.connections({enabled:true}) returned [] forever: the tick's loop body
// never ran, nothing was ever synced, and there was no surface a human could
// reach to fix it. A pipeline nobody can start is not a feature (Cardinal Rule
// 11) -- it is a library with an hourly timer pointed at nothing.

function connectHarness({ putConnection, method = "POST" } = {}) {
  const sent = [];
  const saved = [];
  const sendJson = (res, status, body) => sent.push({ status, body });
  const store = {
    putConnection(c) {
      saved.push(c);
      if (putConnection) return putConnection(c);
      return { ok: true };
    },
  };
  // Stands in for gate.js's readJsonBody: hands the parsed object to the
  // callback exactly as the real one does after its size and shape checks.
  const readJsonBody = (req, res, cb) => cb(req.body);
  return {
    sent, saved,
    run(body, opts = {}) {
      const url = new URL("http://box/measurement/connections");
      return handleMeasurement(url, { method, body }, {}, sendJson,
        opts.getStore || (() => store),
        "readJsonBody" in opts ? opts.readJsonBody : readJsonBody);
    },
  };
}

test("a connection can actually be created, which is what makes the tick do anything", () => {
  const h = connectHarness();
  assert.equal(h.run({ accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1", pipedreamAccountId: "apn_9", enabled: true }), true);
  assert.deepEqual(h.saved, [{ accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1", pipedreamAccountId: "apn_9", enabled: true }]);
  assert.equal(h.sent[0].status, 200);
  assert.equal(h.sent[0].body.ok, true);
});

test("a connection defaults to enabled, and an explicit false is honoured", () => {
  const on = connectHarness();
  on.run({ accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1", pipedreamAccountId: "apn_9" });
  assert.equal(on.saved[0].enabled, true, "connecting an account you did not want synced is not a thing anyone does");

  const off = connectHarness();
  off.run({ accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1", pipedreamAccountId: "apn_9", enabled: false });
  assert.equal(off.saved[0].enabled, false);
});

test("a non-boolean enabled is refused rather than coerced", () => {
  // The string "false" is TRUTHY. Coercing it would silently ENABLE a
  // connection the caller explicitly asked to switch off.
  const h = connectHarness();
  h.run({ accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1", pipedreamAccountId: "apn_9", enabled: "false" });
  assert.equal(h.sent[0].status, 400);
  assert.match(h.sent[0].body.error, /true or false/);
  assert.deepEqual(h.saved, [], "a refused body must never reach the store");
});

test("every refusal names WHICH field was wrong, and none of them reach the store", () => {
  const cases = [
    [{ provider: "meta_ads", sourceAccountId: "act_1", pipedreamAccountId: "apn_9" }, /accountId is required/],
    [{ accountId: "../etc", provider: "meta_ads", sourceAccountId: "act_1", pipedreamAccountId: "apn_9" }, /accountId must match/],
    [{ accountId: "acme", sourceAccountId: "act_1", pipedreamAccountId: "apn_9" }, /provider is required/],
    [{ accountId: "acme", provider: "meta_ads" }, /sourceAccountId is required/],
    [{ accountId: "acme", provider: "meta_ads", sourceAccountId: "act 1/../x" }, /sourceAccountId must match/],
  ];
  for (const [body, expected] of cases) {
    const h = connectHarness();
    assert.equal(h.run(body), true);
    assert.equal(h.sent[0].status, 400, JSON.stringify(body));
    assert.match(h.sent[0].body.error, expected, "Cardinal Rule 16: a refusal must say what was wrong");
    assert.deepEqual(h.saved, [], "an invalid connection must not be stored");
  }
});

test("a provider with no adapter is refused, and the refusal lists what this box CAN read", () => {
  // Accepting it would save cleanly and then sync nothing forever -- inert, and
  // indistinguishable from a client that simply had no spend.
  const h = connectHarness();
  h.run({ accountId: "acme", provider: "google_ads", sourceAccountId: "act_1", pipedreamAccountId: "apn_9" });
  assert.equal(h.sent[0].status, 400);
  assert.match(h.sent[0].body.error, /no adapter is registered for provider 'google_ads'/);
  for (const p of PROVIDERS) assert.match(h.sent[0].body.error, new RegExp(p));
  assert.deepEqual(h.saved, [], "a provider nothing can sync must not be stored");
});

test("the route is claimed for any method, so an unsupported verb cannot fall through unanswered", () => {
  // GET is now a real reader (see test/measurement-connections.test.js), so the
  // verb that must still be claimed-and-refused is one the route does not serve.
  const h = connectHarness({ method: "DELETE" });
  assert.equal(h.run({}), true, "an unclaimed path would fall silently through the rest of the gate");
  assert.equal(h.sent[0].status, 405);
  assert.match(h.sent[0].body.error, /POST/);
  assert.match(h.sent[0].body.error, /GET/, "and the refusal must name both things the route does do");
});

test("facts stay read-only even though connections accept a write", () => {
  // The read-only guarantee is not weakened: a FACT is a measurement of money
  // that was spent, and writing one by hand would put a number nobody measured
  // into the ledger. A connection is configuration.
  const h = harness({ method: "POST" });
  assert.equal(h.run("/measurement/accounts/acme/facts"), true);
  assert.equal(h.sent[0].status, 405);
  assert.match(h.sent[0].body.error, /read-only/);
  assert.deepEqual(h.calls, []);

  const s = harness({ method: "POST" });
  assert.equal(s.run("/measurement/status"), true, "status must stay claimed and refused, not fall through");
  assert.equal(s.sent[0].status, 405);
});

test("an unopenable store, and a missing body parser, each degrade with a named cause", () => {
  const noStore = connectHarness();
  noStore.run({ accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1", pipedreamAccountId: "apn_9" }, { getStore: () => null });
  assert.equal(noStore.sent[0].status, 500);
  assert.match(noStore.sent[0].body.error, /not available/);

  const noParser = connectHarness();
  noParser.run({ accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1", pipedreamAccountId: "apn_9" }, { readJsonBody: undefined });
  assert.equal(noParser.sent[0].status, 500);
  assert.match(noParser.sent[0].body.error, /no body parser/,
    "a miswired handler must say so, not answer 200 having stored nothing");
});

test("a store that throws while saving names the cause and does not leak a stack", () => {
  const h = connectHarness({ putConnection: () => { throw new Error("database is locked"); } });
  h.run({ accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1", pipedreamAccountId: "apn_9" });
  assert.equal(h.sent[0].status, 500);
  assert.match(h.sent[0].body.error, /database is locked/);
  assert.equal(h.sent[0].body.error.includes("at Object"), false);
});
