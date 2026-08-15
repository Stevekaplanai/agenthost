// test/measurement-connect-journey.test.js
//
// Two findings from Codex's independent review, tested behaviourally:
//
// FINDING A -- credential selection was ARBITRARY. proxyRequest took
// list.data.data[0]: the first connected account Pipedream happened to return
// for (external_user_id, app). A client with two Meta credentials therefore got
// a non-deterministic one, unrelated to the ad account whose facts were being
// stored, and could silently read the wrong permitted set. Nothing anywhere
// reported it.
//
// FINDING B -- nothing on the box could CREATE a Pipedream connection, so the
// whole pack was unreachable: the only way in was to make a connected account
// out of band and hand-post a config row (Cardinal Rule 11, third instance in
// this build).
//
// Every test here asserts ORDER and ABSENCE, not just shape: a mocked fetch can
// be satisfied by an implementation that calls the right URLs in the wrong
// sequence, or that also calls one it must never call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

// test/ is ESM ("type": "module"), container/ is CommonJS. Same shim every
// other measurement test uses; import.meta.dirname replaces the CJS __dirname.
const require = createRequire(import.meta.url);
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { openStore } = require("../container/measurement-store.js");
const { proxyRequest, listConnectedAccounts, createConnectToken } = require("../container/measurement-credentials.js");
const { syncAccount } = require("../container/measurement-sync.js");
const adapter = require("../container/measurement-adapters/meta-ads.js");
const { handleMeasurement, connectionFromBody } = require("../container/measurement-lib.js");

const CFG = { projectId: "p_1", clientId: "c_1", clientSecret: "s_1", environment: "production" };
const ENV = { PIPEDREAM_PROJECT_ID: "p_1", PIPEDREAM_CLIENT_ID: "c_1", PIPEDREAM_CLIENT_SECRET: "s_1" };
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "journey-")), "m.sqlite");

// THE CLIENT WITH TWO META CREDENTIALS. This is the whole finding in one
// fixture: Pipedream lists both, in this order, every time.
const TWO_META = [
  { id: "apn_first", name: "Acme Brand A" },
  { id: "apn_second", name: "Acme Brand B" },
];

// A fetch double that records every call IN ORDER, so a test can assert the
// sequence and the absence of calls, not merely that some request was made.
function recorder({ accounts = TWO_META, insights = [], tokens } = {}) {
  const calls = [];
  const fetchFn = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, init: init || {} });
    if (u.includes("/oauth/token")) return { ok: true, json: async () => ({ access_token: "BEARER_X", expires_in: 3600 }) };
    if (u.includes("/tokens")) return { ok: true, json: async () => (tokens || { token: "ctok_live_1", expires_at: "2026-08-11T01:00:00Z", connect_link_url: "https://pipedream.com/_static/connect.html?token=ctok_live_1" }) };
    if (u.includes("/accounts")) return { ok: true, json: async () => ({ data: accounts }) };
    if (u.includes("/proxy/")) {
      const target = Buffer.from(new URL(u).pathname.split("/").at(-1), "base64url").toString("utf8");
      return target.includes("/insights")
        ? { ok: true, json: async () => ({ data: insights }) }
        : { ok: true, json: async () => ({ timezone_name: "America/New_York" }) };
    }
    throw new Error("unexpected url " + u);
  };
  const urls = () => calls.map((c) => c.url);
  return { calls, urls, fetchFn };
}

const accountIdOf = (proxyUrl) => new URL(proxyUrl).searchParams.get("account_id");

// ---- FINDING A: the recorded credential, and only it ---------------------------

test("two Meta credentials for one client each resolve to THEIR OWN credential", async () => {
  // THE test for finding A. Under the old data[0] behaviour the second case
  // reads through apn_first -- the wrong client's permitted set -- and nothing
  // reports it. Both directions are asserted so a fix that merely reverses the
  // arbitrary pick (last instead of first) fails too.
  for (const chosen of ["apn_first", "apn_second"]) {
    const { urls, calls, fetchFn } = recorder();
    const r = await proxyRequest({
      cfg: CFG, accountId: "acme", provider: "meta_ads", pipedreamAccountId: chosen,
      targetUrl: "https://graph.facebook.com/v21.0/act_1/insights", fetchFn, state: {},
    });
    assert.equal(r.ok, true, chosen + " must resolve");
    // ORDER: exchange, then list, then proxy. A proxy call before the list would
    // mean the recorded id was never verified against what Pipedream has.
    assert.match(urls()[0], /\/oauth\/token$/, "the client_credentials exchange must come first");
    assert.match(urls()[1], /\/accounts\?/, "the connected accounts must be read before the proxy call");
    assert.match(urls()[2], /\/proxy\//, "and the proxy call last");
    assert.equal(calls.length, 3, "no extra calls");
    assert.equal(accountIdOf(urls()[2]), chosen,
      "the credential the operator RECORDED must be the one forwarded, not the one Pipedream listed first");
  }
});

test("the recorded credential is used even when it is not the one Pipedream lists first", async () => {
  // Stated as its own case because it is the single assertion that fails against
  // the old implementation. If this passes and the above is deleted, the finding
  // is still covered.
  const { urls, fetchFn } = recorder();
  await proxyRequest({
    cfg: CFG, accountId: "acme", provider: "meta_ads", pipedreamAccountId: "apn_second",
    targetUrl: "https://x/y", fetchFn, state: {},
  });
  const proxied = urls().find((u) => u.includes("/proxy/"));
  assert.equal(accountIdOf(proxied), "apn_second");
  assert.equal(accountIdOf(proxied) === TWO_META[0].id, false,
    "data[0] is exactly the defect: the first listed account must never be the answer by default");
});

test("a recorded credential that is no longer connected refuses by name, and never calls the proxy", async () => {
  // Disconnected, revoked, or re-created at Pipedream. Falling back to data[0]
  // here would be the same bug wearing a recovery costume: it would read the
  // wrong client's data at exactly the moment the right one went away.
  const { urls, fetchFn } = recorder();
  const r = await proxyRequest({
    cfg: CFG, accountId: "acme", provider: "meta_ads", pipedreamAccountId: "apn_revoked",
    targetUrl: "https://x/y", fetchFn, state: {},
  });
  assert.equal(r.ok, false);
  assert.match(r.why, /apn_revoked/, "Cardinal Rule 16: the refusal must name the credential that is missing");
  assert.match(r.why, /not among the 2 connected accounts/, "and say what it was compared against");
  assert.equal(urls().some((u) => u.includes("/proxy/")), false,
    "ABSENCE: a doomed provider read must not be attempted");
});

test("a connection with no recorded credential refuses before touching the network", async () => {
  let called = false;
  const r = await proxyRequest({
    cfg: CFG, accountId: "acme", provider: "meta_ads",
    targetUrl: "https://x/y", state: {},
    fetchFn: async () => { called = true; throw new Error("must not reach the network"); },
  });
  assert.equal(r.ok, false);
  assert.match(r.why, /does not record WHICH connected account/);
  assert.match(r.why, /pipedreamAccountId/, "the operator must learn what to supply, not just that it failed");
  assert.equal(called, false, "a refusal must not cost a network call");
});

test("no refusal on this path ever carries the bearer", async () => {
  const { fetchFn } = recorder();
  const r = await proxyRequest({
    cfg: CFG, accountId: "acme", provider: "meta_ads", pipedreamAccountId: "apn_gone",
    targetUrl: "https://x/y", fetchFn, state: {},
  });
  assert.equal(JSON.stringify(r).includes("BEARER_X"), false);
  assert.equal(JSON.stringify(r).includes("s_1"), false);
});

test("the recorded credential survives the store and reaches the proxy end to end", async () => {
  // The full path finding A actually breaks in production: two connections for
  // one client, stored, read back, synced. Nothing here is mocked except
  // Pipedream itself.
  const store = openStore(tmp());
  store.putConnection({ accountId: "acme", provider: "meta_ads", sourceAccountId: "act_a", pipedreamAccountId: "apn_first", enabled: true });
  store.putConnection({ accountId: "acme", provider: "meta_ads", sourceAccountId: "act_b", pipedreamAccountId: "apn_second", enabled: true });

  const used = [];
  for (const c of store.connections({ enabled: true })) {
    const { urls, fetchFn } = recorder({ insights: [{ date_start: "2026-08-01",
      campaign_id: "cmp_1", campaign_name: "Launch", spend: "10.00",
      account_currency: "USD" }] });
    const r = await syncAccount({
      store, accountId: c.accountId, adAccountId: c.sourceAccountId,
      pipedreamAccountId: c.pipedreamAccountId,
      since: "2026-08-01", until: "2026-08-01", env: ENV, fetchFn, adapter,
    });
    assert.equal(r.ok, true, "the sync must succeed for " + c.sourceAccountId);
    used.push([c.sourceAccountId, accountIdOf(urls().find((u) => u.includes("/proxy/")))]);
  }
  assert.deepEqual(used, [["act_a", "apn_first"], ["act_b", "apn_second"]],
    "each ad account must be read through ITS OWN credential -- mixing them is the wrong permitted set, silently");
  store.close();
});

test("a stored connection carries its credential back out, and re-recording changes it", () => {
  const store = openStore(tmp());
  store.putConnection({ accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1", pipedreamAccountId: "apn_first", enabled: true });
  assert.equal(store.connections({})[0].pipedreamAccountId, "apn_first");
  // The operator picked the wrong one and fixed it.
  store.putConnection({ accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1", pipedreamAccountId: "apn_second", enabled: true });
  assert.equal(store.connections({}).length, 1);
  assert.equal(store.connections({})[0].pipedreamAccountId, "apn_second", "a corrected choice must actually take");
  // And a caller that only flips `enabled` must not erase the choice -- that
  // erasure would read as "never connected" and stop every sync silently.
  store.putConnection({ accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1", enabled: false });
  assert.equal(store.connections({})[0].pipedreamAccountId, "apn_second");
  store.close();
});

test("a store written before this column existed still opens, and says it has no choice recorded", () => {
  // The additive-migration claim, executed rather than asserted in prose. A box
  // that has been running since before this fix has rows with no credential; it
  // must load and then refuse by name, never throw "no such column" hourly.
  const file = tmp();
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE measurement_connections (
    account_id TEXT NOT NULL, provider TEXT NOT NULL, source_account_id TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1, last_synced_at TEXT, last_error TEXT,
    PRIMARY KEY (account_id, provider, source_account_id))`);
  old.exec(`INSERT INTO measurement_connections (account_id, provider, source_account_id, enabled)
    VALUES ('acme','meta_ads','act_1',1)`);
  old.close();

  const store = openStore(file);
  const [c] = store.connections({ enabled: true });
  assert.equal(c.pipedreamAccountId, null, "an unmigrated row has no recorded choice, and must say so rather than invent one");
  store.close();
});

// ---- FINDING B: the operator journey exists ------------------------------------

test("a Connect token is minted for THIS client, and the link points at the app", async () => {
  const { calls, urls, fetchFn } = recorder();
  const r = await createConnectToken({
    cfg: CFG, accountId: "acme", provider: "meta_ads", fetchFn, state: {},
    successRedirectUri: "https://box.example/measurement/connected",
    errorRedirectUri: "https://box.example/measurement/failed",
    allowedOrigins: ["https://box.example"],
  });
  assert.equal(r.ok, true);
  assert.match(urls()[0], /\/oauth\/token$/, "ORDER: our own bearer is obtained first");
  assert.match(urls()[1], /\/connect\/p_1\/tokens$/, "then the Connect token is created under the project");
  assert.equal(calls[1].init.method, "POST");

  const body = JSON.parse(calls[1].init.body);
  assert.equal(body.external_user_id, "acme",
    "scoping to the SAME id measurement uses is what makes the connection findable afterwards");
  assert.equal(body.success_redirect_uri, "https://box.example/measurement/connected");
  assert.equal(body.error_redirect_uri, "https://box.example/measurement/failed");
  assert.deepEqual(body.allowed_origins, ["https://box.example"]);

  assert.equal(r.token, "ctok_live_1", "the browser cannot open the hosted UI without it");
  assert.match(r.connectLinkUrl, /app=facebook_marketing_api/,
    "the hosted UI must be pointed at the app, or the operator lands on a chooser for 2000 apps");
  assert.equal(r.connectLinkUrl.includes("app=meta_ads"), false, "our provider id is not Pipedream's slug");
});

test("a Connect token response missing either half refuses rather than half-answering", async () => {
  const noLink = recorder({ tokens: { token: "ctok_1" } });
  const a = await createConnectToken({ cfg: CFG, accountId: "acme", provider: "meta_ads", fetchFn: noLink.fetchFn, state: {} });
  assert.equal(a.ok, false);
  assert.match(a.why, /nothing for the operator to open/);

  const noToken = recorder({ tokens: { connect_link_url: "https://pipedream.com/x" } });
  const b = await createConnectToken({ cfg: CFG, accountId: "acme", provider: "meta_ads", fetchFn: noToken.fetchFn, state: {} });
  assert.equal(b.ok, false);
});

test("listing what a client has connected returns an id and a label -- and NOTHING else", async () => {
  // The operator's picker. If a credential field could ride along here it would
  // be the one place in the pack where a platform token reaches the box, which
  // would make /measurement/status's disclosure a false claim.
  const { urls, fetchFn } = recorder({
    accounts: [
      { id: "apn_first", name: "Acme Brand A", credentials: { oauth_access_token: "PLATFORM_TOKEN" }, external_id: "acme" },
      { id: "apn_second", name: null, external_id: "acme-b" },
    ],
  });
  const r = await listConnectedAccounts({ cfg: CFG, accountId: "acme", provider: "meta_ads", fetchFn, state: {} });
  assert.equal(r.ok, true);
  assert.deepEqual(r.accounts, [
    { id: "apn_first", label: "Acme Brand A" },
    { id: "apn_second", label: "acme-b" },
  ], "an unnamed credential still needs something a human can tell apart");
  const dump = JSON.stringify(r);
  assert.equal(dump.includes("PLATFORM_TOKEN"), false, "a platform token must never survive this call");
  assert.equal(dump.includes("credentials"), false);
  for (const u of urls()) {
    assert.equal(u.includes("include_credentials"), false,
      "ABSENCE: asking for raw credentials would break the box-never-holds-a-token guarantee");
  }
});

// ---- the routes, which is what makes any of this reachable ---------------------

function routeHarness({ method = "GET", body, pipedream = {}, env = ENV, timeoutMs } = {}) {
  const sent = [];
  const sendJson = (res, status, payload) => { sent.push({ status, body: payload }); };
  const readJsonBody = (req, res, cb) => cb(req.body);
  const seen = [];
  const fake = {
    createConnectToken(args) { seen.push(["createConnectToken", args]); return pipedream.createConnectToken ? pipedream.createConnectToken(args) : Promise.resolve({ ok: true, token: "ctok_1", expiresAt: null, connectLinkUrl: "https://pipedream.com/x?app=facebook_marketing_api" }); },
    listConnectedAccounts(args) { seen.push(["listConnectedAccounts", args]); return pipedream.listConnectedAccounts ? pipedream.listConnectedAccounts(args) : Promise.resolve({ ok: true, accounts: [{ id: "apn_first", label: "Acme Brand A" }] }); },
  };
  return {
    sent, seen,
    run(pathname, search = "") {
      const url = new URL("http://box" + pathname + search);
      return handleMeasurement(url, { method, body }, {}, sendJson, () => ({}), readJsonBody, { env, pipedream: fake, timeoutMs });
    },
  };
}

test("POST /measurement/connect-token hands the operator a link, and never logs the token", async () => {
  // A published Connect token is a live credential for that client's connection
  // flow. It goes to the authenticated operator's browser and nowhere else.
  const logged = [];
  const real = { log: console.log, error: console.error, warn: console.warn };
  for (const k of Object.keys(real)) console[k] = (...a) => logged.push(a.join(" "));
  let h;
  try {
    h = routeHarness({ method: "POST", body: { accountId: "acme", provider: "meta_ads" } });
    assert.equal(h.run("/measurement/connect-token"), true);
    await new Promise((r) => setImmediate(r));
  } finally {
    for (const k of Object.keys(real)) console[k] = real[k];
  }
  assert.equal(h.sent[0].status, 200);
  assert.equal(h.sent[0].body.token, "ctok_1", "the browser needs it, so it is returned");
  assert.match(h.sent[0].body.connectLinkUrl, /pipedream\.com/);
  assert.match(h.sent[0].body.disclosure, /not stored on this box/i, "the trust claim travels with the step that needs it");
  assert.equal(h.seen[0][1].accountId, "acme");
  assert.equal(logged.join("|").includes("ctok_1"), false, "ABSENCE: a credential must never reach a log line");
});

test("connect-token refuses a bad body by name, and never calls Pipedream", async () => {
  const cases = [
    [{ provider: "meta_ads" }, /accountId is required/],
    [{ accountId: "../etc", provider: "meta_ads" }, /accountId must match/],
    [{ accountId: "acme" }, /provider is required/],
    [{ accountId: "acme", provider: "google_ads" }, /no adapter is registered/],
    [{ accountId: "acme", provider: "meta_ads", successRedirectUri: 7 }, /successRedirectUri must be a non-empty string/],
    [{ accountId: "acme", provider: "meta_ads", allowedOrigins: "https://box" }, /allowedOrigins must be an array/],
  ];
  for (const [body, expected] of cases) {
    const h = routeHarness({ method: "POST", body });
    assert.equal(h.run("/measurement/connect-token"), true);
    assert.equal(h.sent[0].status, 400, JSON.stringify(body));
    assert.match(h.sent[0].body.error, expected);
    assert.deepEqual(h.seen, [], "a refused body must not cost a Pipedream call");
  }
});

test("an unconfigured box says WHICH secret is missing instead of failing at Pipedream", async () => {
  const h = routeHarness({ method: "POST", body: { accountId: "acme", provider: "meta_ads" }, env: {} });
  h.run("/measurement/connect-token");
  assert.equal(h.sent[0].status, 503);
  assert.match(h.sent[0].body.error, /PIPEDREAM_PROJECT_ID/);
  assert.deepEqual(h.seen, []);
});

test("a Pipedream failure on either connect route is reported with its own cause", async () => {
  const tok = routeHarness({
    method: "POST", body: { accountId: "acme", provider: "meta_ads" },
    pipedream: { createConnectToken: () => Promise.resolve({ ok: false, why: "Pipedream refused to create a Connect token (401): bad client" }) },
  });
  tok.run("/measurement/connect-token");
  await new Promise((r) => setImmediate(r));
  assert.equal(tok.sent[0].status, 502);
  assert.match(tok.sent[0].body.error, /401/);

  // A REJECTION, not a refusal: without the catch this answers nothing at all.
  const thrown = routeHarness({
    method: "POST", body: { accountId: "acme", provider: "meta_ads" },
    pipedream: { createConnectToken: () => Promise.reject(new Error("socket hang up")) },
  });
  thrown.run("/measurement/connect-token");
  await new Promise((r) => setImmediate(r));
  assert.equal(thrown.sent[0].status, 500);
  assert.match(thrown.sent[0].body.error, /socket hang up/, "a hung request that answers nothing is the silence Rule 16 forbids");
});

test("GET /measurement/available-connections is how the operator picks between two", async () => {
  const h = routeHarness({
    pipedream: { listConnectedAccounts: () => Promise.resolve({ ok: true, accounts: [{ id: "apn_first", label: "Acme Brand A" }, { id: "apn_second", label: "Acme Brand B" }] }) },
  });
  assert.equal(h.run("/measurement/available-connections", "?accountId=acme&provider=meta_ads"), true);
  await new Promise((r) => setImmediate(r));
  assert.equal(h.sent[0].status, 200);
  assert.deepEqual(h.sent[0].body.connections, [
    { id: "apn_first", label: "Acme Brand A" },
    { id: "apn_second", label: "Acme Brand B" },
  ]);
  assert.deepEqual(h.seen[0][1].accountId, "acme");
});

test("available-connections refuses a missing or unusable query by name", () => {
  const cases = [
    ["?provider=meta_ads", /accountId is required/],
    ["?accountId=../etc&provider=meta_ads", /accountId must match/],
    ["?accountId=acme", /provider is required/],
    ["?accountId=acme&provider=google_ads", /no adapter is registered/],
  ];
  for (const [search, expected] of cases) {
    const h = routeHarness();
    assert.equal(h.run("/measurement/available-connections", search), true);
    assert.equal(h.sent[0].status, 400, search);
    assert.match(h.sent[0].body.error, expected);
    assert.deepEqual(h.seen, [], "a refused query must not cost a Pipedream call");
  }
});

test("both new routes are claimed for every method, so a wrong verb cannot fall through", () => {
  const post = routeHarness({ method: "POST" });
  assert.equal(post.run("/measurement/available-connections", "?accountId=acme&provider=meta_ads"), true);
  assert.equal(post.sent[0].status, 405);
  assert.match(post.sent[0].body.error, /GET/);

  const get = routeHarness({ method: "GET" });
  assert.equal(get.run("/measurement/connect-token"), true);
  assert.equal(get.sent[0].status, 405);
  assert.match(get.sent[0].body.error, /POST/);
});

test("recording a connection without naming the credential is refused, not stored", () => {
  // The route half of finding A. Accepting this would put a row in the table
  // that the tick can only ever refuse -- inert, and looking like a quiet client.
  const r = connectionFromBody({ accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1" });
  assert.equal(r.ok, false);
  assert.match(r.why, /pipedreamAccountId is required/);
  assert.match(r.why, /available-connections/, "the refusal must point at the route that answers it");

  const bad = connectionFromBody({ accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1", pipedreamAccountId: "../etc" });
  assert.equal(bad.ok, false);
  assert.match(bad.why, /pipedreamAccountId must match/);

  const good = connectionFromBody({ accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1", pipedreamAccountId: "apn_first" });
  assert.equal(good.ok, true);
  assert.equal(good.connection.pipedreamAccountId, "apn_first", "the choice must reach the store, not be validated and dropped");
});

// ---- a Pipedream that never answers ------------------------------------------

test("a Pipedream that never answers still gets a named 502, on BOTH connect routes", async () => {
  // THE FAILING CASE, and the double MUST never settle: Node's fetch has no
  // default timeout, so the ordinary failure is not a 5xx but a hung LB that
  // accepts the connection and says nothing. Before the bound, `settle`'s
  // .then/.catch never ran, sendJson was never called, and `res` was never
  // ended -- the operator's browser spun until its own timeout and showed a bare
  // network error, with nothing audited and nothing logged, on the route the
  // whole operator journey starts with. A double that RESOLVES proves none of
  // this; this test would hang forever against the old code.
  const started = [];
  const neverAnswers = (args) => { started.push(args); return new Promise(() => {}); };

  const token = routeHarness({
    method: "POST", body: { accountId: "acme", provider: "meta_ads" },
    pipedream: { createConnectToken: neverAnswers }, timeoutMs: 5,
  });
  assert.equal(token.run("/measurement/connect-token"), true);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(token.sent.length, 1, "a hung provider must still produce exactly one response");
  assert.equal(token.sent[0].status, 502);
  assert.match(token.sent[0].body.error, /a Connect token could not be created: Pipedream did not answer within/,
    "Cardinal Rule 16: the refusal must name what was being done AND that it timed out");

  const available = routeHarness({
    method: "GET", pipedream: { listConnectedAccounts: neverAnswers }, timeoutMs: 5,
  });
  assert.equal(available.run("/measurement/available-connections", "?accountId=acme&provider=meta_ads"), true);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(available.sent.length, 1);
  assert.equal(available.sent[0].status, 502);
  assert.match(available.sent[0].body.error, /the connected meta_ads accounts could not be listed: Pipedream did not answer within/);

  // And the bound CANCELS rather than only racing: without a live signal the
  // real call keeps running and settles later against a request already answered.
  assert.equal(started.length, 2, "both routes must have actually called Pipedream");
  for (const args of started) {
    assert.ok(args.signal, "the route must hand Pipedream a signal -- the plumbing existed and only the caller never used it");
    assert.equal(args.signal.aborted, true, "the timeout must abort the in-flight call, not merely stop waiting for it");
  }
});

test("a Pipedream call that answers in time is untouched, and is never aborted", async () => {
  const seenSignals = [];
  const h = routeHarness({
    method: "GET",
    pipedream: {
      listConnectedAccounts: (args) => {
        seenSignals.push(args.signal);
        return Promise.resolve({ ok: true, accounts: [{ id: "apn_first", label: "Acme Brand A" }] });
      },
    },
  });
  assert.equal(h.run("/measurement/available-connections", "?accountId=acme&provider=meta_ads"), true);
  await new Promise((r) => setImmediate(r));
  assert.equal(h.sent[0].status, 200, "a healthy call must be completely unaffected by the bound");
  assert.deepEqual(h.sent[0].body.connections, [{ id: "apn_first", label: "Acme Brand A" }]);
  assert.equal(seenSignals[0].aborted, false, "a healthy call must never be cancelled");
});
