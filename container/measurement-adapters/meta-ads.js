// container/measurement-adapters/meta-ads.js
// Reads Meta's Insights API and returns Fact-shaped rows.
//
// `request` is injected and opaque: in production it is Pipedream's proxy bound
// to one account, in tests it is a function. This module therefore holds NO
// credential and sets NO authorization header -- if it ever needs one, something
// has gone wrong upstream in Task 2.
//
// It NEVER writes to Meta: spend actions are operator-gated under Rule 13.
"use strict";
const GRAPH = "https://graph.facebook.com/v21.0";
const provider = "meta_ads";
const MAX_PAGES = 100;
const MAX_CURSOR_LENGTH = 2048;
const MAX_PAGING_NEXT_LENGTH = 8192;
const MAX_CAMPAIGN_ID_LENGTH = 255;
const MAX_CAMPAIGN_NAME_LENGTH = 512;
const MAX_TIMEZONE_LENGTH = 255;
const MAX_ACTION_TYPE_LENGTH = 255;

function validatedAfterCursor(paging) {
  const after = paging && paging.cursors ? paging.cursors.after : null;
  if (typeof after !== "string" || after.length === 0) {
    return { ok: false, why: "Meta campaign insights signaled another page without a valid paging.cursors.after cursor" };
  }
  if (after.length > MAX_CURSOR_LENGTH) {
    return { ok: false, why: `Meta campaign insights paging.cursors.after exceeded ${MAX_CURSOR_LENGTH} characters` };
  }
  if (/[\u0000-\u001f\u007f]/.test(after)) {
    return { ok: false, why: "Meta campaign insights paging.cursors.after contained control characters" };
  }
  return { ok: true, cursor: after };
}

function nextPageCursor(paging, page) {
  if (paging == null) return { ok: true, done: true };
  if (typeof paging !== "object" || Array.isArray(paging)) {
    return { ok: false, why: `Meta campaign insights response page ${page} was malformed: paging must be an object` };
  }
  if (!Object.prototype.hasOwnProperty.call(paging, "next") || paging.next == null) {
    return { ok: true, done: true };
  }
  if (typeof paging.next !== "string" || !paging.next.trim()) {
    return { ok: false, why: `Meta campaign insights response page ${page} was malformed: paging.next must be a nonempty string` };
  }
  if (paging.next.length > MAX_PAGING_NEXT_LENGTH) {
    return { ok: false, why: `Meta campaign insights response page ${page} was malformed: paging.next exceeded ${MAX_PAGING_NEXT_LENGTH} characters` };
  }
  if (paging.next !== paging.next.trim() || /[\u0000-\u001f\u007f]/.test(paging.next)) {
    return { ok: false, why: `Meta campaign insights response page ${page} was malformed: paging.next contained control characters or surrounding whitespace` };
  }
  const next = validatedAfterCursor(paging);
  return next.ok ? { ok: true, done: false, cursor: next.cursor } : next;
}

// Meta's insight days are "YYYY-MM-DD". Anything else -- absent, an object, a
// truncated string -- returns null so the caller can SKIP the row rather than
// throw. Deliberately not `new Date(x)` with a validity check: Date is famously
// permissive ("2026-99-99" parses on some inputs), and a shape check is the
// honest test for "did the provider send us the day we asked for".
const META_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
function observedAtFor(dateStart) {
  if (typeof dateStart !== "string" || !META_DAY_RE.test(dateStart)) return null;
  const iso = new Date(dateStart + "T00:00:00.000Z");
  if (Number.isNaN(iso.getTime())) return null;
  const observedAt = iso.toISOString();
  return observedAt.slice(0, 10) === dateStart ? observedAt : null;
}

function cleanText(value, maxLength) {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  if (!clean || clean.length > maxLength || /[\u0000-\u001f\u007f]/.test(clean)) return null;
  return clean;
}

// Graph Insights sends money as decimal strings. Keep that wire contract
// narrow: Number("0x10"), Number("1e3"), and Number("-1") are all finite, but
// none is an honest nonnegative Meta money value for this adapter. Fifteen
// integer digits and six decimal places also keep provider input bounded.
const META_MONEY_RE = /^(?:0|[1-9]\d{0,14})(?:\.\d{1,6})?$/;
function providerNumber(value) {
  if (typeof value !== "string" || !META_MONEY_RE.test(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function validTimezone(value) {
  const timezone = cleanText(value, MAX_TIMEZONE_LENGTH);
  if (!timezone) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
    return timezone;
  } catch {
    return null;
  }
}

function summarizedSkips(skips) {
  return Array.from(skips, ([reason, count]) => `${count} row${count === 1 ? "" : "s"} ${reason}`);
}

// Meta can return the same purchase value at several aggregation levels in one
// action_values array. Summing them would count one purchase more than once.
// Prefer the broadest single aggregate, then the generic aggregate, then one
// unambiguous platform leaf. Generic offsite_conversion is deliberately absent:
// it includes conversions other than purchases.
const PURCHASE_LEAF_TYPES = new Set([
  "offsite_conversion.fb_pixel_purchase",
  "app_custom_event.fb_mobile_purchase",
]);
const PURCHASE_AGGREGATE_TYPES = ["omni_purchase", "purchase"];
function purchaseValueFor(actionValues) {
  if (!Array.isArray(actionValues)) return { ok: true, value: null };
  const recognized = [];
  for (const action of actionValues) {
    if (!action || typeof action !== "object" || Array.isArray(action)) {
      return { ok: false, why: "had an invalid action_values entry" };
    }
    const actionType = cleanText(action.action_type, MAX_ACTION_TYPE_LENGTH);
    if (!actionType) return { ok: false, why: "had an invalid action_values action_type" };
    const value = providerNumber(action.value);
    if (value === null) {
      const purchaseType = PURCHASE_AGGREGATE_TYPES.includes(actionType) || PURCHASE_LEAF_TYPES.has(actionType);
      return { ok: false, why: purchaseType
        ? `had an invalid purchase value for ${actionType}`
        : `had an invalid action_values value for ${actionType}` };
    }
    recognized.push({ action_type: actionType, value });
  }
  for (const aggregate of PURCHASE_AGGREGATE_TYPES) {
    const matches = recognized.filter((action) => action.action_type === aggregate);
    if (!matches.length) continue;
    if (matches.length > 1) return { ok: false, why: `had duplicate ${aggregate} purchase values` };
    return { ok: true, value: matches[0].value };
  }
  const leaves = recognized.filter((action) => PURCHASE_LEAF_TYPES.has(action.action_type));
  if (leaves.length > 1) {
    return { ok: false, why: "had multiple purchase leaf values without an aggregate" };
  }
  if (!leaves.length) return { ok: true, value: null };
  return { ok: true, value: leaves[0].value };
}

async function fetchFacts({ accountId, adAccountId, since, until, request }) {
  // AdsInsights does not expose the ad account's timezone. It belongs to the
  // AdAccount object as `timezone_name`, so read that exact field once through
  // the same credential-bound proxy before requesting campaign rows.
  const accountUrl = `${GRAPH}/${encodeURIComponent(adAccountId)}?fields=timezone_name`;
  const account = await request(accountUrl);
  if (!account.ok) return { ok: false, why: account.why };
  if (!account.data || typeof account.data !== "object" || Array.isArray(account.data)) {
    return { ok: false, why: "Meta ad account response was malformed: data must be an object" };
  }
  const sourceTimezone = validTimezone(account.data.timezone_name);
  if (!sourceTimezone) {
    return { ok: false, why: "Meta ad account response had a missing or invalid timezone_name" };
  }

  const baseUrl = `${GRAPH}/${encodeURIComponent(adAccountId)}/insights`
    + `?fields=campaign_id,campaign_name,spend,action_values,account_currency`
    + `&level=campaign&time_increment=1`
    + `&time_range=${encodeURIComponent(JSON.stringify({ since, until }))}`;

  const rows = [];
  const seenCursors = new Set();
  let cursor = null;
  for (let page = 1; ; page += 1) {
    if (page > MAX_PAGES) {
      return { ok: false, why: `Meta campaign insights pagination exceeded ${MAX_PAGES} pages` };
    }
    const pageUrl = new URL(baseUrl);
    if (cursor !== null) pageUrl.searchParams.set("after", cursor);

    const res = await request(pageUrl.href);
    // The cause is already named by whoever made the call. Passing it through
    // unaltered beats re-wrapping it in a vaguer sentence of our own.
    if (!res.ok) return { ok: false, why: res.why };
    if (!res.data || typeof res.data !== "object"
        || !Object.prototype.hasOwnProperty.call(res.data, "data")) {
      return { ok: false, why: `Meta campaign insights response page ${page} was malformed: data is missing` };
    }
    if (!Array.isArray(res.data.data)) {
      return { ok: false, why: `Meta campaign insights response page ${page} was malformed: data must be an array` };
    }
    rows.push(...res.data.data);

    const next = nextPageCursor(res.data.paging, page);
    if (!next.ok) return next;
    if (next.done) break;
    if (seenCursors.has(next.cursor)) {
      return { ok: false, why: "Meta campaign insights paging.cursors.after repeated a cursor" };
    }
    seenCursors.add(next.cursor);
    cursor = next.cursor;
  }

  const facts = [];
  let skipped = 0;
  const skipCounts = new Map();
  const skip = (reason) => {
    skipped += 1;
    skipCounts.set(reason, (skipCounts.get(reason) || 0) + 1);
  };
  for (const r of rows) {
    if (!r || typeof r !== "object" || Array.isArray(r)) {
      skip("were not objects");
      continue;
    }
    // WHAT IS ASSUMED, AND WHAT IS UNVERIFIED -- stated plainly rather than
    // implied by a trailing "Z".
    //
    // ASSUMED: date_start names a calendar DAY ("2026-08-10"), and the ISO
    // string below is a stable, sortable KEY for that day. Every read path
    // treats it as a day key, and the identity index dedupes on it, so the key
    // only has to be consistent -- which it is.
    //
    // UNVERIFIED: which timezone that day is measured in. Meta reports insight
    // days in the AD ACCOUNT's own timezone, so this "Z" is NOT a justified UTC
    // claim -- two clients in different timezones produce identically-stamped
    // facts for genuinely different 24-hour spans. Confirming Meta's exact
    // boundary semantics needs live credentials nobody on this branch has, so
    // rather than invent a conversion that cannot be tested, the account's
    // reported timezone is CARRIED ALONGSIDE the fact (sourceTimezone) and the
    // offset stays an open, recorded question instead of a silent wrong answer.
    const observedAt = observedAtFor(r.date_start);
    // An unparseable date_start SKIPS the row. `new Date("undefined...").toISOString()`
    // throws RangeError, and this loop sits outside any try in the sync path, so one
    // malformed provider row used to reject the whole call and -- via the tick's outer
    // catch -- skip every REMAINING connection, hourly, for every account on the box.
    // Skipping is not silent: the count comes back with the result (see below).
    if (!observedAt) { skip("had an invalid date_start"); continue; }
    const campaignId = cleanText(r.campaign_id, MAX_CAMPAIGN_ID_LENGTH);
    if (!campaignId) { skip("had a missing or invalid campaign_id"); continue; }
    const campaignName = cleanText(r.campaign_name, MAX_CAMPAIGN_NAME_LENGTH);
    if (!campaignName) { skip("had a missing or invalid campaign_name"); continue; }
    const spend = providerNumber(r.spend);
    if (spend === null) { skip("had a missing or invalid spend"); continue; }
    const currency = cleanText(r.account_currency, 3);
    if (!currency || !/^[A-Z]{3}$/.test(currency)) {
      skip("had a missing or invalid account_currency");
      continue;
    }
    if (r.action_values != null && !Array.isArray(r.action_values)) {
      skip("had invalid action_values");
      continue;
    }
    const purchase = purchaseValueFor(r.action_values);
    if (!purchase.ok) { skip(purchase.why); continue; }
    const base = { accountId, provider, sourceAccountId: String(adAccountId),
      campaignId, campaignName, currency, sourceTimezone, observedAt };
    facts.push({ ...base, metric: "spend", value: spend });
    // Absent purchases means NOT MEASURED, not zero. Writing 0 here would report
    // a number nobody observed.
    if (purchase.value !== null) {
      facts.push({ ...base, metric: "revenue", value: purchase.value });
    }
  }
  // `skipped` travels with a partial success so malformed provider rows show up
  // in the audit instead of looking like a thin week. If EVERY row was
  // malformed, fail closed: clearing the connection error and reporting an
  // empty healthy sync would make malformed data indistinguishable from no ads.
  const skippedReasons = summarizedSkips(skipCounts);
  if (rows.length > 0 && skipped === rows.length) {
    return { ok: false, why: `Meta campaign insights returned ${skipped} malformed row${skipped === 1 ? "" : "s"}: ${skippedReasons.join("; ")}` };
  }
  return { ok: true, facts, skipped, skippedReasons };
}

module.exports = { provider, fetchFacts };
