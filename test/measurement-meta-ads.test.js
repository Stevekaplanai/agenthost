// test/measurement-meta-ads.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { provider, fetchFacts } = require("../container/measurement-adapters/meta-ads.js");

// The injected request stands in for Task 2's proxy. It returns the SAME shape
// proxyRequest returns, so this test exercises the real contract between them.
function withAccountTimezone(insightsRequest, timezone = "America/New_York") {
  return async (url) => new URL(String(url)).pathname.endsWith("/insights")
    ? insightsRequest(url)
    : { ok: true, data: { timezone_name: timezone } };
}

function requesting(rows, timezone = "America/New_York") {
  const seen = [];
  const request = async (url) => {
    seen.push(String(url));
    return new URL(String(url)).pathname.endsWith("/insights")
      ? { ok: true, data: { data: rows } }
      : { ok: true, data: { timezone_name: timezone } };
  };
  return {
    request,
    seenUrl: () => seen.find((url) => new URL(url).pathname.endsWith("/insights")) || "",
    accountUrl: () => seen.find((url) => !new URL(url).pathname.endsWith("/insights")) || "",
  };
}

const validRow = (overrides = {}) => ({
  date_start: "2026-08-01",
  campaign_id: "cmp_1",
  campaign_name: "Launch",
  spend: "5.00",
  account_currency: "USD",
  ...overrides,
});

test("the provider id matches the store's provider column", () => {
  assert.equal(provider, "meta_ads");
});

test("campaign insights become spend and revenue facts carrying campaign metadata", async () => {
  const { request } = requesting([
    { date_start: "2026-08-01", campaign_id: "cmp_1", campaign_name: "Launch",
      spend: "12.50", account_currency: "USD",
      action_values: [{ action_type: "purchase", value: "300.00" }] },
  ]);
  const r = await fetchFacts({ accountId: "acme", adAccountId: "act_1", since: "2026-08-01", until: "2026-08-01", request });
  assert.equal(r.ok, true);
  const spend = r.facts.find((f) => f.metric === "spend");
  const revenue = r.facts.find((f) => f.metric === "revenue");
  assert.equal(spend.value, 12.5);
  assert.equal(revenue.value, 300);
  assert.equal(spend.accountId, "acme");
  assert.equal(spend.provider, "meta_ads");
  assert.equal(spend.currency, "USD", "a ROAS built from unknown currencies is not a ROAS");
  assert.equal(spend.sourceAccountId, "act_1");
  assert.equal(revenue.currency, "USD");
  assert.equal(revenue.sourceAccountId, "act_1");
  assert.equal(spend.campaignId, "cmp_1");
  assert.equal(spend.campaignName, "Launch");
  assert.equal(revenue.campaignId, "cmp_1");
  assert.equal(revenue.campaignName, "Launch");
  assert.equal(spend.observedAt, "2026-08-01T00:00:00.000Z");
});

test("Meta website, mobile, and omni purchase values each become revenue", async (t) => {
  for (const [actionType, expected] of [
    ["offsite_conversion.fb_pixel_purchase", 101],
    ["app_custom_event.fb_mobile_purchase", 202],
    ["omni_purchase", 303],
  ]) {
    await t.test(actionType, async () => {
      const { request } = requesting([validRow({
        action_values: [{ action_type: actionType, value: String(expected) }],
      })]);
      const r = await fetchFacts({ accountId: "acme", adAccountId: "act_1", since: "2026-08-01", until: "2026-08-01", request });
      assert.equal(r.ok, true);
      assert.equal(r.facts.find((fact) => fact.metric === "revenue")?.value, expected);
    });
  }
});

test("Meta purchase value precedence chooses one aggregate and never sums overlapping variants", async (t) => {
  await t.test("omni_purchase outranks purchase and leaf variants", async () => {
    const { request } = requesting([validRow({ action_values: [
      { action_type: "offsite_conversion.fb_pixel_purchase", value: "100" },
      { action_type: "app_custom_event.fb_mobile_purchase", value: "200" },
      { action_type: "purchase", value: "300" },
      { action_type: "omni_purchase", value: "400" },
    ] })]);
    const r = await fetchFacts({ accountId: "acme", adAccountId: "act_1", since: "2026-08-01", until: "2026-08-01", request });
    assert.equal(r.ok, true);
    assert.equal(r.facts.filter((fact) => fact.metric === "revenue").length, 1);
    assert.equal(r.facts.find((fact) => fact.metric === "revenue")?.value, 400);
  });

  await t.test("purchase outranks leaf variants when omni_purchase is absent", async () => {
    const { request } = requesting([validRow({ action_values: [
      { action_type: "offsite_conversion.fb_pixel_purchase", value: "100" },
      { action_type: "app_custom_event.fb_mobile_purchase", value: "200" },
      { action_type: "purchase", value: "300" },
    ] })]);
    const r = await fetchFacts({ accountId: "acme", adAccountId: "act_1", since: "2026-08-01", until: "2026-08-01", request });
    assert.equal(r.ok, true);
    assert.equal(r.facts.find((fact) => fact.metric === "revenue")?.value, 300);
  });
});

test("ambiguous Meta purchase values fail closed with a named cause", async (t) => {
  for (const [name, actionValues, cause] of [
    ["duplicate chosen aggregate", [
      { action_type: "omni_purchase", value: "100" },
      { action_type: "omni_purchase", value: "200" },
    ], /duplicate omni_purchase purchase values/],
    ["multiple leaves without an aggregate", [
      { action_type: "offsite_conversion.fb_pixel_purchase", value: "100" },
      { action_type: "app_custom_event.fb_mobile_purchase", value: "200" },
    ], /multiple purchase leaf values without an aggregate/],
  ]) {
    await t.test(name, async () => {
      const { request } = requesting([validRow({ action_values: actionValues })]);
      const r = await fetchFacts({ accountId: "acme", adAccountId: "act_1", since: "2026-08-01", until: "2026-08-01", request });
      assert.equal(r.ok, false);
      assert.match(r.why, cause);
      assert.equal(JSON.stringify(r).includes("revenue"), false, "an ambiguous row must never emit a revenue fact");
    });
  }
});

test("generic offsite_conversion is not silently relabeled as purchase revenue", async () => {
  const { request } = requesting([validRow({
    action_values: [{ action_type: "offsite_conversion", value: "999" }],
  })]);
  const r = await fetchFacts({ accountId: "acme", adAccountId: "act_1", since: "2026-08-01", until: "2026-08-01", request });
  assert.equal(r.ok, true);
  assert.deepEqual(r.facts.map((fact) => fact.metric), ["spend"]);
});

test("malformed non-purchase action values cannot masquerade as a complete no-revenue row", async () => {
  const { request } = requesting([validRow({
    action_values: [{ action_type: "offsite_conversion", value: "" }],
  })]);
  const r = await fetchFacts({ accountId: "acme", adAccountId: "act_1", since: "2026-08-01", until: "2026-08-01", request });
  assert.equal(r.ok, false);
  assert.match(r.why, /invalid action_values value for offsite_conversion/);
});

test("Meta monetary wire values must be bounded nonnegative decimal strings", async (t) => {
  for (const [name, row, cause] of [
    ["hex spend", validRow({ spend: "0x10" }), /invalid spend/],
    ["negative spend", validRow({ spend: "-1.00" }), /invalid spend/],
    ["exponent spend", validRow({ spend: "1e3" }), /invalid spend/],
    ["oversized spend", validRow({ spend: "1234567890123456.00" }), /invalid spend/],
    ["hex purchase", validRow({ action_values: [{ action_type: "purchase", value: "0x10" }] }), /invalid purchase value/],
    ["negative purchase", validRow({ action_values: [{ action_type: "purchase", value: "-1.00" }] }), /invalid purchase value/],
  ]) {
    await t.test(name, async () => {
      const { request } = requesting([row]);
      const r = await fetchFacts({ accountId: "acme", adAccountId: "act_1", since: "2026-08-01", until: "2026-08-01", request });
      assert.equal(r.ok, false);
      assert.match(r.why, cause);
    });
  }
});

test("campaign insights and ad-account timezone use their own documented fields", async () => {
  // Authentication belongs to the proxy. If this module ever sets its own auth
  // header it has started holding a credential, which is the thing Task 2 exists
  // to prevent.
  const { request, seenUrl, accountUrl } = requesting([]);
  await fetchFacts({ accountId: "acme", adAccountId: "act_1", since: "2026-08-01", until: "2026-08-01", request });
  const url = new URL(seenUrl());
  assert.equal(url.hostname, "graph.facebook.com");
  assert.equal(url.searchParams.get("level"), "campaign", "Meta must aggregate rows at campaign level");
  const fields = new Set(String(url.searchParams.get("fields") || "").split(","));
  for (const field of ["campaign_id", "campaign_name", "spend", "action_values", "account_currency"]) {
    assert.ok(fields.has(field), `the insights request must include ${field}`);
  }
  assert.equal(fields.has("account_timezone"), false, "AdsInsights has no account_timezone field");
  const account = new URL(accountUrl());
  assert.equal(account.pathname, "/v21.0/act_1", "timezone belongs to the AdAccount endpoint");
  assert.equal(account.searchParams.get("fields"), "timezone_name");
  assert.equal(fetchFacts.length <= 1, true, "fetchFacts takes one options object; no token parameter");
});

test("campaign insights page with the opaque after cursor and never forward paging.next credentials", async () => {
  const canary = "NEVER_FORWARD_THIS_ACCESS_TOKEN";
  const seen = [];
  const request = withAccountTimezone(async (url) => {
    seen.push(String(url));
    if (seen.length === 1) {
      return { ok: true, data: { data: [
        validRow({ date_start: "2026-08-01", campaign_id: "cmp_1", campaign_name: "Launch", spend: "12.50" }),
      ], paging: {
        cursors: { after: "opaque-page-2" },
        next: `https://graph.facebook.com/v21.0/act_1/insights?after=opaque-page-2&access_token=${canary}`,
      } } };
    }
    return { ok: true, data: { data: [
      validRow({ date_start: "2026-08-02", campaign_id: "cmp_2", campaign_name: "Retargeting", spend: "7.50" }),
    ] } };
  });

  const r = await fetchFacts({ accountId: "acme", adAccountId: "act_1", since: "2026-08-01", until: "2026-08-02", request });
  assert.equal(r.ok, true);
  assert.equal(seen.length, 2, "a second page must actually be requested");
  const second = new URL(seen[1]);
  assert.equal(second.origin, "https://graph.facebook.com");
  assert.equal(second.pathname, "/v21.0/act_1/insights", "the adapter must rebuild its original target");
  assert.equal(second.searchParams.get("after"), "opaque-page-2");
  assert.equal(second.searchParams.has("access_token"), false, "the next URL's credential must not cross the proxy boundary");
  assert.equal(seen.some((url) => url.includes(canary)), false);
  assert.equal(JSON.stringify(r).includes(canary), false, "the credential must not leak into output either");
  assert.deepEqual(r.facts.map((fact) => fact.campaignId), ["cmp_1", "cmp_2"]);
});

test("campaign insights stop before following a paging cycle", async () => {
  let calls = 0;
  const request = withAccountTimezone(async () => {
    calls += 1;
    return { ok: true, data: { data: [], paging: {
      cursors: { after: "same-cursor" },
      next: "ignored",
    } } };
  });

  const r = await fetchFacts({ accountId: "acme", adAccountId: "act_1", since: "2026-08-01", until: "2026-08-01", request });
  assert.deepEqual(r, { ok: false, why: "Meta campaign insights paging.cursors.after repeated a cursor" });
  assert.equal(calls, 2, "the repeated cursor must not be requested a second time");
});

test("campaign insights reject a next-page signal without an after cursor", async () => {
  const request = withAccountTimezone(async () => ({
    ok: true,
    data: { data: [], paging: { next: "https://graph.facebook.com/ignored" } },
  }));

  const r = await fetchFacts({ accountId: "acme", adAccountId: "act_1", since: "2026-08-01", until: "2026-08-01", request });
  assert.deepEqual(r, {
    ok: false,
    why: "Meta campaign insights signaled another page without a valid paging.cursors.after cursor",
  });
});

test("campaign insights reject an unbounded after cursor", async () => {
  const request = withAccountTimezone(async () => ({
    ok: true,
    data: { data: [], paging: { next: "ignored", cursors: { after: "x".repeat(2049) } } },
  }));

  const r = await fetchFacts({ accountId: "acme", adAccountId: "act_1", since: "2026-08-01", until: "2026-08-01", request });
  assert.deepEqual(r, { ok: false, why: "Meta campaign insights paging.cursors.after exceeded 2048 characters" });
});

test("campaign insights pagination is capped", async () => {
  let calls = 0;
  const request = withAccountTimezone(async () => {
    calls += 1;
    return { ok: true, data: { data: [], paging: {
      cursors: { after: `cursor-${calls}` },
      next: "ignored",
    } } };
  });

  const r = await fetchFacts({ accountId: "acme", adAccountId: "act_1", since: "2026-08-01", until: "2026-08-01", request });
  assert.deepEqual(r, { ok: false, why: "Meta campaign insights pagination exceeded 100 pages" });
  assert.equal(calls, 100);
});

test("a successful Meta page with no data field fails with the missing-data cause", async () => {
  const request = withAccountTimezone(async () => ({ ok: true, data: { paging: {} } }));
  const r = await fetchFacts({ accountId: "acme", adAccountId: "act_1", since: "2026-08-01", until: "2026-08-01", request });
  assert.deepEqual(r, {
    ok: false,
    why: "Meta campaign insights response page 1 was malformed: data is missing",
  });
});

test("a successful Meta page with non-array data fails with the wrong-shape cause", async () => {
  const request = withAccountTimezone(async () => ({ ok: true, data: { data: { campaign_id: "cmp_1" } } }));
  const r = await fetchFacts({ accountId: "acme", adAccountId: "act_1", since: "2026-08-01", until: "2026-08-01", request });
  assert.deepEqual(r, {
    ok: false,
    why: "Meta campaign insights response page 1 was malformed: data must be an array",
  });
});

test("malformed paging cannot masquerade as a complete final page", async (t) => {
  for (const [paging, cause] of [
    ["truncated", /paging must be an object/],
    [{ next: "" }, /paging.next must be a nonempty string/],
    [{ next: "x".repeat(8193), cursors: { after: "next-page" } }, /paging.next exceeded 8192 characters/],
    [{ next: "https://graph.facebook.com/next\n", cursors: { after: "next-page" } }, /paging.next contained control characters/],
  ]) {
    await t.test(JSON.stringify(paging), async () => {
      const request = withAccountTimezone(async () => ({ ok: true, data: { data: [validRow()], paging } }));
      const r = await fetchFacts({ accountId: "acme", adAccountId: "act_1", since: "2026-08-01", until: "2026-08-01", request });
      assert.equal(r.ok, false);
      assert.match(r.why, cause);
    });
  }
});

test("impossible calendar dates are skipped instead of normalized into a different day", async () => {
  const { request } = requesting([
    validRow({ date_start: "2026-02-30" }),
    validRow({ date_start: "2026-04-31", campaign_id: "cmp_2" }),
    validRow({ date_start: "2026-04-30", campaign_id: "cmp_3" }),
  ]);
  const r = await fetchFacts({ accountId: "acme", adAccountId: "act_1", since: "2026-02-01", until: "2026-04-30", request });
  assert.equal(r.ok, true);
  assert.deepEqual(r.facts.map((item) => item.observedAt), ["2026-04-30T00:00:00.000Z"]);
  assert.equal(r.skipped, 2);
  assert.deepEqual(r.skippedReasons, ["2 rows had an invalid date_start"]);
});

test("an all-malformed campaign page is refused with field-specific counted causes", async () => {
  const { request } = requesting([
    validRow({ campaign_id: undefined }),
    validRow({ campaign_id: {} }),
    validRow({ campaign_name: [] }),
    validRow({ spend: "" }),
    validRow({ account_currency: {} }),
    validRow({ action_values: [{ action_type: "purchase", value: [] }] }),
  ]);
  const r = await fetchFacts({ accountId: "acme", adAccountId: "act_1", since: "2026-08-01", until: "2026-08-01", request });
  assert.equal(r.ok, false, "an all-malformed page must not clear the connection error as a healthy empty sync");
  assert.match(r.why, /returned 6 malformed rows/);
  for (const cause of ["campaign_id", "campaign_name", "spend", "account_currency", "purchase value"]) {
    assert.match(r.why, new RegExp(cause));
  }
  assert.equal(JSON.stringify(r).includes("[object Object]"), false);
});

test("a missing currency is refused, not guessed or stored as measured", async () => {
  const { request } = requesting([validRow({ date_start: "2026-08-02", account_currency: undefined })]);
  const r = await fetchFacts({ accountId: "acme", adAccountId: "act_1", since: "2026-08-02", until: "2026-08-02", request });
  assert.equal(r.ok, false);
  assert.match(r.why, /1 malformed row.*account_currency/);
});

test("a day with no purchases reports spend and no revenue, never a zero it did not measure", async () => {
  const { request } = requesting([validRow({ date_start: "2026-08-02" })]);
  const r = await fetchFacts({ accountId: "acme", adAccountId: "act_1", since: "2026-08-02", until: "2026-08-02", request });
  assert.equal(r.facts.length, 1);
  assert.equal(r.facts[0].metric, "spend");
});

test("the AdAccount timezone is carried on every fact, and absent is refused with cause", async () => {
  // FINDING 4. observedAt stamps a "Z" for a day Meta reports in the AD
  // ACCOUNT's timezone. The offset cannot be verified without live credentials,
  // so the honest move is to RECORD the timezone rather than assert a UTC
  // conversion nobody tested. Without this column two clients in different
  // timezones produce identically-stamped facts and nothing says they differ.
  const withTz = requesting([validRow()]);
  const a = await fetchFacts({ accountId: "acme", adAccountId: "act_1", since: "2026-08-01", until: "2026-08-01", request: withTz.request });
  assert.equal(a.facts[0].sourceTimezone, "America/New_York");
  assert.equal(new URL(withTz.accountUrl()).searchParams.get("fields"), "timezone_name",
    "the timezone is fetched from the AdAccount object, not invented in Insights fixtures");

  const withoutTz = requesting([validRow()], "");
  const b = await fetchFacts({ accountId: "acme", adAccountId: "act_1", since: "2026-08-01", until: "2026-08-01", request: withoutTz.request });
  assert.equal(b.ok, false, "an unknown timezone must never be guessed as UTC");
  assert.match(b.why, /ad account response.*timezone_name/i);
});

test("a malformed AdAccount timezone response fails before requesting Insights", async (t) => {
  for (const [name, data, cause] of [
    ["missing body", null, /data must be an object/],
    ["array body", [], /data must be an object/],
    ["missing timezone", {}, /timezone_name/],
    ["invalid timezone", { timezone_name: "Mars/Olympus_Mons" }, /timezone_name/],
  ]) {
    await t.test(name, async () => {
      let calls = 0;
      const request = async () => { calls += 1; return { ok: true, data }; };
      const result = await fetchFacts({ accountId: "acme", adAccountId: "act_1", since: "2026-08-01", until: "2026-08-01", request });
      assert.equal(result.ok, false);
      assert.match(result.why, cause);
      assert.equal(calls, 1, "an invalid AdAccount response must not spend an Insights request");
    });
  }
});

test("a malformed date_start skips ONE row instead of throwing away the whole call", async () => {
  // FINDING 2, layer 1. `new Date(String(undefined) + "T00:00:00.000Z").toISOString()`
  // throws RangeError: Invalid time value. That rejection escaped fetchFacts,
  // escaped syncAccount (which awaited it outside any try), and hit the tick's
  // outer catch -- which RETURNED out of the connection loop, so every remaining
  // account on the box was skipped, every hour, because of one bad row.
  const { request } = requesting([
    validRow({ date_start: "2026-08-01", spend: "10.00" }),
    validRow({ date_start: undefined, spend: "99.00" }),            // date_start absent
    validRow({ date_start: "not-a-date", spend: "98.00" }),        // garbage
    validRow({ date_start: { nope: true }, spend: "97.00" }),       // not even a string
    validRow({ date_start: "2026-08-02", spend: "20.00" }),
  ]);
  const r = await fetchFacts({ accountId: "acme", adAccountId: "act_1", since: "2026-08-01", until: "2026-08-02", request });
  assert.equal(r.ok, true, "one unusable row must not fail the call");
  assert.deepEqual(r.facts.map((f) => f.value), [10, 20], "the good rows must survive intact");
  assert.equal(r.skipped, 3, "and the drop must be counted, not silent");
  assert.deepEqual(r.skippedReasons, ["3 rows had an invalid date_start"]);
  for (const f of r.facts) {
    assert.equal(typeof f.observedAt, "string");
    assert.equal(Number.isNaN(Date.parse(f.observedAt)), false, "no invented or invalid date may be written");
  }
});

const WHY = "Pipedream refused to read meta_ads (400): (#100) Invalid parameter";
test("a refused call carries the reason it was given, unaltered", async () => {
  const request = withAccountTimezone(async () => ({ ok: false, why: WHY }));
  const r = await fetchFacts({ accountId: "acme", adAccountId: "act_1", since: "2026-08-01", until: "2026-08-01", request });
  assert.equal(r.ok, false);
  // EQUALITY, not a substring match. "Unaltered" is the claim, and a substring
  // assertion would still pass if this layer re-wrapped the message around it --
  // which is exactly how a cause gets diluted one layer at a time.
  assert.equal(r.why, WHY, "Cardinal Rule 16: the cause must survive this layer byte for byte");
});
