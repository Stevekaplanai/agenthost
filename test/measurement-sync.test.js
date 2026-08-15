// test/measurement-sync.test.js
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
const { syncAccount } = require("../container/measurement-sync.js");
const adapter = require("../container/measurement-adapters/meta-ads.js");

const ENV = {
  PIPEDREAM_PROJECT_ID: "p_sync_fixture",
  PIPEDREAM_CLIENT_ID: "c_sync_fixture",
  PIPEDREAM_CLIENT_SECRET: "s_sync_fixture",
};
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sync-")), "m.sqlite");

const insightRow = (row, index = 0) => ({
  campaign_id: `cmp_${index + 1}`,
  campaign_name: `Campaign ${index + 1}`,
  account_currency: "USD",
  ...row,
});

const decodedProxyTarget = (url) => Buffer.from(
  new URL(String(url)).pathname.split("/").at(-1),
  "base64url",
).toString("utf8");

// Stands in for the whole Pipedream conversation: exchange, account lookup, proxy.
function pipedream({ insights, proxyFails }) {
  return async (url) => {
    const u = String(url);
    if (u.includes("/oauth/token")) return { ok: true, json: async () => ({ access_token: "B", expires_in: 3600 }) };
    if (u.includes("/accounts")) return { ok: true, json: async () => ({ data: [{ id: "apn_9" }] }) };
    if (proxyFails) return { ok: false, status: 400, text: async () => "(#100) Invalid parameter" };
    if (u.includes("/proxy/")) {
      const target = decodedProxyTarget(u);
      return target.includes("/insights")
        ? { ok: true, json: async () => ({ data: (insights || []).map(insightRow) }) }
        : { ok: true, json: async () => ({ timezone_name: "America/New_York" }) };
    }
    throw new Error("unexpected Pipedream fixture URL: " + u);
  };
}

test("an unconfigured box refuses before making any network call", async () => {
  let called = false;
  const r = await syncAccount({
    store: openStore(tmp()), accountId: "acme", adAccountId: "act_1", pipedreamAccountId: "apn_9",
    since: "2026-08-01", until: "2026-08-01", env: {},
    fetchFn: async () => { called = true; return { ok: true, json: async () => ({}) }; },
    adapter,
  });
  assert.equal(r.ok, false);
  assert.match(r.why, /PIPEDREAM_PROJECT_ID/);
  assert.equal(called, false, "a refusal must not cost a network call");
});

test("a sync without an explicitly sanitized environment fails closed", async () => {
  const r = await syncAccount({
    store: openStore(tmp()), accountId: "acme", adAccountId: "act_1", pipedreamAccountId: "apn_9",
    since: "2026-08-01", until: "2026-08-01", adapter,
    fetchFn: async () => { throw new Error("must not be called"); },
  });
  assert.equal(r.ok, false);
  assert.match(r.why, /sanitized credential environment was not supplied/);
});

test("the scheduled gate tick supplies measurementEnv rather than raw process.env", () => {
  const gate = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");
  const tick = gate.slice(gate.indexOf("async function measurementTick()"), gate.indexOf("// Staggered off", gate.indexOf("async function measurementTick()")));
  assert.match(tick, /env:\s*measurementEnv\(\)/,
    "the hourly path must strip the gate-only push credential before measurement starts");
  assert.doesNotMatch(tick, /env:\s*process\.env/);
});

test("a successful sync writes facts and reports how many", async () => {
  const store = openStore(tmp());
  const r = await syncAccount({
    store, accountId: "acme", adAccountId: "act_1", pipedreamAccountId: "apn_9", since: "2026-08-01", until: "2026-08-01",
    env: ENV, fetchFn: pipedream({ insights: [{ date_start: "2026-08-01", campaign_id: "cmp_1",
      campaign_name: "Launch", spend: "10.00", account_currency: "USD" }] }), adapter,
  });
  assert.equal(r.ok, true);
  assert.equal(r.written, 1);
  const [fact] = store.factsFor({ accountId: "acme" });
  assert.equal(fact.currency, "USD");
  assert.equal(fact.sourceAccountId, "act_1");
  assert.equal(fact.campaignId, "cmp_1");
  assert.equal(fact.campaignName, "Launch");
  store.close();
});

test("syncing the same day twice leaves ONE fact, whoever asked for the sync", async () => {
  // What replaced "a sync caused by a card links its facts to that card": that
  // test exercised a taskId parameter with NO producer -- the tick passes none
  // and no card-triggered worker exists -- and it blessed a design where the
  // same account/day/metric could be stored twice, once with a card and once
  // without, while the account lens returned both and summed them. This asserts
  // the property that actually protects the number.
  const store = openStore(tmp());
  const run = () => syncAccount({
    store, accountId: "acme", adAccountId: "act_1", pipedreamAccountId: "apn_9",
    since: "2026-08-01", until: "2026-08-01", env: ENV,
    fetchFn: pipedream({ insights: [{ date_start: "2026-08-01", spend: "10.00", account_currency: "USD" }] }), adapter,
  });
  await run();
  await run();
  const facts = store.factsFor({ accountId: "acme" });
  assert.equal(facts.length, 1, "two syncs of one day must never double the spend");
  assert.equal(facts[0].value, 10);
  store.close();
});

test("a fully successful refresh removes revenue and campaigns the authoritative response omitted", async () => {
  const store = openStore(tmp());
  const run = (insights) => syncAccount({
    store, accountId: "acme", adAccountId: "act_1", pipedreamAccountId: "apn_9",
    since: "2026-08-01", until: "2026-08-01", env: ENV,
    fetchFn: pipedream({ insights }), adapter,
  });

  await run([
    { date_start: "2026-08-01", campaign_id: "cmp_1", campaign_name: "Launch", spend: "10.00",
      action_values: [{ action_type: "omni_purchase", value: "100.00" }] },
    { date_start: "2026-08-01", campaign_id: "cmp_2", campaign_name: "Retargeting", spend: "20.00",
      action_values: [{ action_type: "omni_purchase", value: "200.00" }] },
  ]);
  assert.equal(store.factsFor({ accountId: "acme" }).length, 4);

  store.putFact({ accountId: "acme", provider: "meta_ads", sourceAccountId: "act_2",
    campaignId: "cmp_other_source", campaignName: "Other source", metric: "spend", value: 30,
    currency: "USD", observedAt: "2026-08-01T00:00:00.000Z" });
  store.putFact({ accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1",
    campaignId: "cmp_other_day", campaignName: "Other day", metric: "spend", value: 40,
    currency: "USD", observedAt: "2026-07-31T00:00:00.000Z" });

  const refreshed = await run([
    { date_start: "2026-08-01", campaign_id: "cmp_1", campaign_name: "Launch", spend: "12.00" },
  ]);
  assert.equal(refreshed.ok, true);
  const rows = store.factsFor({ accountId: "acme" });
  const refreshedScope = rows.filter((row) => row.sourceAccountId === "act_1"
    && row.observedAt === "2026-08-01T00:00:00.000Z");
  assert.deepEqual(refreshedScope.map((row) => [row.campaignId, row.metric, row.value]), [
    ["cmp_1", "spend", 12],
  ]);
  assert.equal(refreshedScope.some((row) => row.metric === "revenue"), false,
    "omitted revenue means ROAS is unmeasured, not the stale 100 value");
  assert.equal(rows.some((row) => row.sourceAccountId === "act_2"), true);
  assert.equal(rows.some((row) => row.observedAt.startsWith("2026-07-31")), true);
  store.close();
});

test("a failed refresh leaves the prior authoritative range unchanged", async () => {
  const store = openStore(tmp());
  const options = {
    store, accountId: "acme", adAccountId: "act_1", pipedreamAccountId: "apn_9",
    since: "2026-08-01", until: "2026-08-01", env: ENV, adapter,
  };
  const first = await syncAccount({ ...options, fetchFn: pipedream({ insights: [
    { date_start: "2026-08-01", campaign_id: "cmp_1", campaign_name: "Launch", spend: "10.00",
      action_values: [{ action_type: "omni_purchase", value: "100.00" }] },
  ] }) });
  assert.equal(first.ok, true);
  const before = store.factsFor({ accountId: "acme" });

  const failed = await syncAccount({ ...options, fetchFn: pipedream({ insights: [], proxyFails: true }) });
  assert.equal(failed.ok, false);
  assert.deepEqual(store.factsFor({ accountId: "acme" }), before);

  const malformed = await syncAccount({ ...options, fetchFn: pipedream({ insights: [
    { date_start: "2026-08-01", campaign_id: "cmp_1", campaign_name: "Launch", spend: "10.00",
      action_values: [
        { action_type: "omni_purchase", value: "100.00" },
        { action_type: "omni_purchase", value: "200.00" },
      ] },
  ] }) });
  assert.equal(malformed.ok, false);
  assert.match(malformed.why, /duplicate omni_purchase purchase values/);
  assert.deepEqual(store.factsFor({ accountId: "acme" }), before);
  store.close();
});

test("a partial refresh upserts valid rows without pruning facts hidden behind skipped rows", async () => {
  const store = openStore(tmp());
  const options = {
    store, accountId: "acme", adAccountId: "act_1", pipedreamAccountId: "apn_9",
    since: "2026-08-01", until: "2026-08-01", env: ENV, adapter,
  };
  const first = await syncAccount({ ...options, fetchFn: pipedream({ insights: [
    { date_start: "2026-08-01", campaign_id: "cmp_1", campaign_name: "Launch", spend: "10.00",
      action_values: [{ action_type: "omni_purchase", value: "100.00" }] },
    { date_start: "2026-08-01", campaign_id: "cmp_2", campaign_name: "Retargeting", spend: "20.00",
      action_values: [{ action_type: "omni_purchase", value: "200.00" }] },
  ] }) });
  assert.equal(first.ok, true);

  const partial = await syncAccount({ ...options, fetchFn: pipedream({ insights: [
    { date_start: "2026-08-01", campaign_id: "cmp_1", campaign_name: "Launch", spend: "12.00",
      action_values: [{ action_type: "omni_purchase", value: "120.00" }] },
    { date_start: "2026-08-01", campaign_id: {}, campaign_name: "Provider-corrupt row", spend: "999.00" },
  ] }) });
  assert.equal(partial.ok, true);
  assert.equal(partial.skipped, 1);

  const byCampaignMetric = Object.fromEntries(store.factsFor({ accountId: "acme" })
    .map((row) => [`${row.campaignId}/${row.metric}`, row.value]));
  assert.deepEqual(byCampaignMetric, {
    "cmp_1/spend": 12,
    "cmp_1/revenue": 120,
    "cmp_2/spend": 20,
    "cmp_2/revenue": 200,
  }, "an incomplete snapshot may restate visible facts but cannot erase omitted identities");
  store.close();
});

test("a first partial campaign refresh preserves a complete legacy total until a complete replacement arrives", async () => {
  const store = openStore(tmp());
  const legacy = { accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1",
    metric: "spend", value: 999, currency: "USD", sourceTimezone: "America/New_York",
    observedAt: "2026-08-01T00:00:00.000Z" };
  store.putFact(legacy);
  const options = {
    store, accountId: "acme", adAccountId: "act_1", pipedreamAccountId: "apn_9",
    since: "2026-08-01", until: "2026-08-01", env: ENV, adapter,
  };

  const partial = await syncAccount({ ...options, fetchFn: pipedream({ insights: [
    { date_start: "2026-08-01", campaign_id: "cmp_1", campaign_name: "Launch", spend: "10.00" },
    { date_start: "2026-08-01", campaign_id: {}, campaign_name: "Provider-corrupt row", spend: "999.00" },
  ] }) });
  assert.equal(partial.ok, false, "an incomplete snapshot cannot safely migrate granularity");
  assert.match(partial.why, /sync incomplete: 1 provider row skipped/);
  assert.match(partial.why, /missing or invalid campaign_id/);
  assert.match(partial.why, /partial campaign facts cannot replace an existing account-level fact/);
  assert.deepEqual(store.factsFor({ accountId: "acme" }).map((row) => [row.campaignId, row.value]), [[null, 999]],
    "the complete legacy total must remain and the partial campaign subset must not be mixed beside it");

  const complete = await syncAccount({ ...options, fetchFn: pipedream({ insights: [
    { date_start: "2026-08-01", campaign_id: "cmp_1", campaign_name: "Launch", spend: "10.00" },
  ] }) });
  assert.equal(complete.ok, true);
  assert.deepEqual(store.factsFor({ accountId: "acme" }).map((row) => [row.campaignId, row.value]), [["cmp_1", 10]],
    "the complete authoritative replacement may remove the legacy total and migrate to campaign granularity");
  store.close();
});

test("a malformed successful adapter result cannot erase an existing authoritative range", async () => {
  const store = openStore(tmp());
  const prior = { accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1",
    campaignId: "cmp_1", campaignName: "Launch", metric: "revenue", value: 100,
    currency: "USD", observedAt: "2026-08-01T00:00:00.000Z" };
  store.putFact(prior);
  const before = store.factsFor({ accountId: "acme" });

  const result = await syncAccount({
    store, accountId: "acme", adAccountId: "act_1", pipedreamAccountId: "apn_9",
    since: "2026-08-01", until: "2026-08-01", env: ENV,
    fetchFn: pipedream({ insights: [] }),
    adapter: { provider: "meta_ads", fetchFacts: async () => ({ ok: true, facts: null, skipped: 0 }) },
  });
  assert.equal(result.ok, false);
  assert.match(result.why, /success without a facts array/);
  assert.deepEqual(store.factsFor({ accountId: "acme" }), before);
  store.close();
});

test("partial adapter facts outside the exact requested scope are rejected without writes", async (t) => {
  const base = { accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1",
    campaignId: "cmp_1", campaignName: "Launch", metric: "spend", value: 10,
    currency: "USD", observedAt: "2026-08-01T00:00:00.000Z" };
  for (const [name, changed] of [
    ["account", { accountId: "other" }],
    ["provider", { provider: "google_ads" }],
    ["source", { sourceAccountId: "act_2" }],
    ["date", { observedAt: "2026-07-31T00:00:00.000Z" }],
    ["date shape", { observedAt: "2026-08-01garbage" }],
  ]) {
    await t.test(name, async () => {
      const store = openStore(tmp());
      const result = await syncAccount({
        store, accountId: "acme", adAccountId: "act_1", pipedreamAccountId: "apn_9",
        since: "2026-08-01", until: "2026-08-01", env: ENV,
        fetchFn: pipedream({ insights: [] }),
        adapter: { provider: "meta_ads", fetchFacts: async () => ({
          ok: true, skipped: 1, facts: [{ ...base, ...changed }],
        }) },
      });
      assert.equal(result.ok, false);
      assert.match(result.why, /outside the requested account, provider, source, or date range/);
      assert.deepEqual(store.factsFor({ accountId: "acme" }), []);
      if (name === "account") assert.deepEqual(store.factsFor({ accountId: "other" }), []);
      store.close();
    });
  }
});

test("malformed paging preserves the previously stored authoritative range", async () => {
  const store = openStore(tmp());
  const options = {
    store, accountId: "acme", adAccountId: "act_1", pipedreamAccountId: "apn_9",
    since: "2026-08-01", until: "2026-08-01", env: ENV, adapter,
  };
  const first = await syncAccount({ ...options, fetchFn: pipedream({ insights: [
    { date_start: "2026-08-01", campaign_id: "cmp_1", campaign_name: "Launch", spend: "10.00" },
    { date_start: "2026-08-01", campaign_id: "cmp_2", campaign_name: "Retargeting", spend: "20.00" },
  ] }) });
  assert.equal(first.ok, true);
  const before = store.factsFor({ accountId: "acme" });

  let insightsCalls = 0;
  const malformedPaging = async (url) => {
    const u = String(url);
    if (u.includes("/oauth/token")) return { ok: true, json: async () => ({ access_token: "B", expires_in: 3600 }) };
    if (u.includes("/accounts")) return { ok: true, json: async () => ({ data: [{ id: "apn_9" }] }) };
    const target = decodedProxyTarget(u);
    if (!target.includes("/insights")) {
      return { ok: true, json: async () => ({ timezone_name: "America/New_York" }) };
    }
    insightsCalls += 1;
    return { ok: true, json: async () => ({ data: [insightRow({
      date_start: "2026-08-01", campaign_id: "cmp_1", campaign_name: "Launch", spend: "12.00",
    })], paging: "truncated" }) };
  };
  const failed = await syncAccount({ ...options, fetchFn: malformedPaging });
  assert.equal(failed.ok, false);
  assert.match(failed.why, /paging must be an object/);
  assert.equal(insightsCalls, 1);
  assert.deepEqual(store.factsFor({ accountId: "acme" }), before);
  store.close();
});

test("the caller's abort signal reaches fetch itself, so a timeout can cancel the call", async () => {
  // FINDING 6. The tick raced a timer against the sync, but nothing cancelled
  // the underlying request. The timed-out sync reported failed and its error was
  // written to the connection -- then the real call resolved later and putFacts
  // wrote anyway, producing facts the audit trail says never arrived. A race is
  // not a cancellation; the signal has to reach fetch.
  const controller = new AbortController();
  const seen = [];
  const store = openStore(tmp());
  const r = await syncAccount({
    store, accountId: "acme", adAccountId: "act_1", pipedreamAccountId: "apn_9", since: "2026-08-01", until: "2026-08-01", env: ENV,
    signal: controller.signal,
    fetchFn: async (url, init) => {
      seen.push(init && init.signal);
      const u = String(url);
      if (u.includes("/oauth/token")) return { ok: true, json: async () => ({ access_token: "B", expires_in: 3600 }) };
      if (u.includes("/accounts")) return { ok: true, json: async () => ({ data: [{ id: "apn_9" }] }) };
      const target = decodedProxyTarget(u);
      return target.includes("/insights")
        ? { ok: true, json: async () => ({ data: [insightRow({ date_start: "2026-08-01", spend: "10.00" })] }) }
        : { ok: true, json: async () => ({ timezone_name: "America/New_York" }) };
    },
    adapter,
  });
  assert.equal(r.ok, true);
  assert.equal(seen.length > 0, true, "the proxy conversation must actually have happened");
  for (const s of seen) {
    assert.equal(s, controller.signal, "EVERY hop must carry the caller's signal, or the un-signalled one is the hang");
  }
  store.close();
});

test("an aborted sync names cancellation as the cause and writes NOTHING", async () => {
  // The harm this closes: without cancellation the losing branch of the race
  // still resolves and still writes. Aborting mid-flight must produce a named
  // failure and an empty store, not a silent write behind the audit's back.
  const controller = new AbortController();
  const store = openStore(tmp());
  const r = await syncAccount({
    store, accountId: "acme", adAccountId: "act_1", pipedreamAccountId: "apn_9", since: "2026-08-01", until: "2026-08-01", env: ENV,
    signal: controller.signal,
    fetchFn: async (url, init) => {
      const u = String(url);
      if (u.includes("/oauth/token")) return { ok: true, json: async () => ({ access_token: "B", expires_in: 3600 }) };
      // Abort mid-conversation, exactly as the tick's timeout would.
      controller.abort();
      const err = new Error("This operation was aborted");
      err.name = "AbortError";
      if (init && init.signal && init.signal.aborted) throw err;
      return { ok: true, json: async () => ({ data: [] }) };
    },
    adapter,
  });
  assert.equal(r.ok, false, "a cancelled sync must not report success");
  assert.match(r.why, /cancelled/, "Cardinal Rule 16: an abort must name itself, not surface as AbortError");
  assert.equal(store.factsFor({ accountId: "acme" }).length, 0, "a cancelled sync must write nothing at all");
  store.close();
});

test("a sync already aborted before storing refuses to write the facts it fetched", async () => {
  // The residual gap a signal alone leaves: the fetch resolves a moment BEFORE
  // the abort fires, so the write would land after the caller recorded failure.
  const controller = new AbortController();
  const store = openStore(tmp());
  const r = await syncAccount({
    store, accountId: "acme", adAccountId: "act_1", pipedreamAccountId: "apn_9", since: "2026-08-01", until: "2026-08-01", env: ENV,
    signal: controller.signal,
    fetchFn: pipedream({ insights: [{ date_start: "2026-08-01", spend: "10.00", account_currency: "USD" }] }),
    adapter: {
      provider: "meta_ads",
      // Resolves normally, then the budget runs out an instant later.
      fetchFacts: async () => {
        controller.abort();
        return { ok: true, facts: [{ accountId: "acme", provider: "meta_ads", sourceAccountId: "act_1", metric: "spend", value: 10, currency: "USD", observedAt: "2026-08-01T00:00:00.000Z" }] };
      },
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.why, /cancelled before its facts were stored/);
  assert.equal(store.factsFor({ accountId: "acme" }).length, 0,
    "this is the exact defect: facts appearing that the audit trail says failed");
  store.close();
});

test("an adapter that THROWS returns a named cause instead of rejecting", async () => {
  // FINDING 2, layer 2. The header of measurement-sync.js promises "every
  // failure returns a named cause and writes nothing". The fetchFacts await sat
  // OUTSIDE any try, so a throwing adapter made syncAccount REJECT -- breaking
  // the contract every caller was written against, including the hourly tick.
  const store = openStore(tmp());
  const r = await syncAccount({
    store, accountId: "acme", adAccountId: "act_1", pipedreamAccountId: "apn_9", since: "2026-08-01", until: "2026-08-01", env: ENV,
    fetchFn: pipedream({ insights: [] }),
    adapter: { provider: "meta_ads", fetchFacts: async () => { throw new RangeError("Invalid time value"); } },
  });
  assert.equal(r.ok, false, "a throwing adapter must RESOLVE with a failure, never reject");
  assert.match(r.why, /Invalid time value/, "Cardinal Rule 16: the real cause must survive");
  assert.match(r.why, /meta_ads/, "and it must name which adapter failed");
  assert.equal(store.factsFor({ accountId: "acme" }).length, 0, "a failure writes nothing");
  store.close();
});

test("an adapter that returns nothing at all is still a named failure", async () => {
  const store = openStore(tmp());
  const r = await syncAccount({
    store, accountId: "acme", adAccountId: "act_1", pipedreamAccountId: "apn_9", since: "2026-08-01", until: "2026-08-01", env: ENV,
    fetchFn: pipedream({ insights: [] }),
    adapter: { provider: "meta_ads", fetchFacts: async () => undefined },
  });
  assert.equal(r.ok, false);
  assert.match(r.why, /no result and no reason/, "a bare falsy result must not read as success");
  store.close();
});

test("a real malformed provider row survives the whole sync path end to end", async () => {
  // The integration the per-layer tests cannot see: a garbage date_start from
  // the provider must land as a stored good row plus a reported skip, not as a
  // rejection that takes the rest of the box's connections down with it.
  const store = openStore(tmp());
  const r = await syncAccount({
    store, accountId: "acme", adAccountId: "act_1", pipedreamAccountId: "apn_9", since: "2026-08-01", until: "2026-08-02", env: ENV,
    fetchFn: pipedream({ insights: [
      { date_start: "2026-08-01", spend: "10.00", account_currency: "USD" },
      { spend: "99.00", account_currency: "USD" },
    ] }),
    adapter,
  });
  assert.equal(r.ok, true);
  assert.equal(r.written, 1);
  assert.equal(r.skipped, 1, "the dropped row must be reported, not absorbed");
  store.close();
});

test("an all-malformed provider page stays a named failed sync and writes nothing", async () => {
  const store = openStore(tmp());
  const r = await syncAccount({
    store, accountId: "acme", adAccountId: "act_1", pipedreamAccountId: "apn_9",
    since: "2026-08-01", until: "2026-08-01", env: ENV,
    fetchFn: pipedream({ insights: [{ date_start: "2026-08-01", campaign_id: {}, spend: "" }] }),
    adapter,
  });
  assert.equal(r.ok, false, "an invalid page must not clear connection health as an empty success");
  assert.match(r.why, /malformed row.*campaign_id/);
  assert.equal(store.factsFor({ accountId: "acme" }).length, 0);
  store.close();
});

test("an adapter failure is surfaced, not swallowed, and writes nothing", async () => {
  const store = openStore(tmp());
  const r = await syncAccount({
    store, accountId: "acme", adAccountId: "act_1", pipedreamAccountId: "apn_9", since: "2026-08-01", until: "2026-08-01",
    env: ENV, fetchFn: pipedream({ insights: [], proxyFails: true }), adapter,
  });
  assert.equal(r.ok, false);
  assert.match(r.why, /Invalid parameter/);
  assert.equal(store.factsFor({ accountId: "acme" }).length, 0);
  store.close();
});
