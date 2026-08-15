// container/measurement-sync.js
// One bounded pull: credentials -> proxy -> adapter -> store. Every failure
// returns a named cause and writes nothing, so a partial sync can never look
// like a real number that nobody measured.
"use strict";
const { credentialConfig, proxyRequest } = require("./measurement-credentials.js");
const SYNC_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function realSyncDay(value) {
  const day = String(value || "");
  if (!SYNC_DAY_RE.test(day)) return null;
  const parsed = new Date(day + "T00:00:00.000Z");
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day ? day : null;
}

// `signal` is threaded all the way down to fetch. Without it the caller's
// timeout only ever won a RACE: the timed-out sync reported failed and
// markConnectionSync recorded the error, and then the real call resolved later
// and putFacts wrote anyway -- facts appearing that the audit trail says never
// arrived. Cancelling means the losing branch stops existing.
async function syncAccount({ store, accountId, adAccountId, pipedreamAccountId, since, until, env, fetchFn = fetch, adapter, signal }) {
  if (!env || typeof env !== "object") {
    return { ok: false, why: "measurement refused because its sanitized credential environment was not supplied" };
  }
  const cfgResult = credentialConfig(env);
  if (!cfgResult.ok) return { ok: false, why: cfgResult.why };

  // The adapter is credential-blind: it gets a function that returns data, and
  // never learns how the call was authenticated. pipedreamAccountId travels with
  // the connection, not with the adapter, because it names WHICH credential this
  // client's connection means -- see proxyRequest for what guessing it cost.
  const request = (targetUrl) => proxyRequest({
    cfg: cfgResult.cfg, accountId, provider: adapter.provider, pipedreamAccountId, targetUrl, fetchFn, signal,
  });

  // The await is INSIDE a try because this function's header promises "every
  // failure returns a named cause" -- and it did not. An adapter that THREW
  // (one malformed provider row was enough) made syncAccount REJECT instead of
  // return, which broke the contract every caller was written against: the
  // tick's outer catch then returned out of its connection loop, skipping every
  // remaining account on the box, hourly, and leaving their last_error stale.
  let got;
  try {
    got = await adapter.fetchFacts({ accountId, adAccountId, since, until, request });
  } catch (e) {
    return { ok: false, why: "the " + adapter.provider + " adapter failed while reading facts (" + String((e && e.message) || e).slice(0, 160) + ")" };
  }
  if (!got || !got.ok) return { ok: false, why: (got && got.why) || "the " + adapter.provider + " adapter returned no result and no reason" };
  if (!Array.isArray(got.facts)) {
    return { ok: false, why: "the " + adapter.provider + " adapter returned success without a facts array, so stored facts were left unchanged" };
  }
  if (got.skipped !== undefined && (!Number.isSafeInteger(got.skipped) || got.skipped < 0)) {
    return { ok: false, why: "the " + adapter.provider + " adapter returned an invalid skipped-row count, so stored facts were left unchanged" };
  }
  const firstDay = realSyncDay(since);
  const lastDay = realSyncDay(until);
  if (!firstDay || !lastDay || firstDay > lastDay) {
    return { ok: false, why: "the " + adapter.provider + " sync range must be real ordered YYYY-MM-DD calendar dates, so stored facts were left unchanged" };
  }
  const sourceAccountId = String(adAccountId || "");
  const outOfScope = got.facts.some((fact) => {
    const observedAt = typeof (fact && fact.observedAt) === "string" ? fact.observedAt : "";
    const observedDay = observedAt.slice(0, 10);
    return String((fact && fact.accountId) || "") !== String(accountId)
      || String((fact && fact.provider) || "") !== String(adapter.provider)
      || String((fact && fact.sourceAccountId) || "") !== sourceAccountId
      || observedAt !== `${observedDay}T00:00:00.000Z`
      || !realSyncDay(observedDay)
      || observedDay < firstDay || observedDay > lastDay;
  });
  if (outOfScope) {
    return { ok: false, why: "the " + adapter.provider + " adapter returned a fact outside the requested account, provider, source, or date range, so none were stored" };
  }

  // One transaction, so a bad row partway through leaves nothing behind, and the
  // rejection comes back as a named cause rather than an unhandled throw -- the
  // caller is a timer, and a raw rejection there is a failure that cannot explain
  // itself.
  // The last gap the signal alone does not close: the fetch could resolve a
  // moment BEFORE the abort fires, and the write would still land after the
  // caller had already recorded the sync as failed. Checking here is what makes
  // "cancelled means nothing was written" true rather than merely likely.
  if (signal && signal.aborted) {
    return { ok: false, why: "the " + adapter.provider + " sync was cancelled before its facts were stored, so none were" };
  }
  try {
    const facts = got.facts;
    // skipped rows mean the provider response is incomplete. Upsert the valid
    // subset, but never prune identities the malformed rows may have described.
    // Only a fully successful response is authoritative enough to replace the
    // exact connection/date slice and remove facts Meta omitted this time.
    const skipped = got.skipped || 0;
    const stored = skipped > 0
      ? store.putFacts(facts)
      : store.replaceFacts({
        accountId, provider: adapter.provider, sourceAccountId,
        since, until, facts,
      });
    // `skipped` is passed through so the tick can say a provider row was dropped
    // rather than reporting a quietly-short count as a healthy sync.
    return { ok: true, written: stored.written, skipped,
      skippedReasons: Array.isArray(got.skippedReasons) ? got.skippedReasons : [] };
  } catch (e) {
    const storageCause = String((e && e.message) || e).slice(0, 160);
    const skipped = got.skipped || 0;
    const skippedReasons = Array.isArray(got.skippedReasons)
      ? got.skippedReasons.filter((reason) => typeof reason === "string" && reason.trim()).slice(0, 8).join("; ").slice(0, 300)
      : "";
    return { ok: false, why: skipped
      ? `sync incomplete: ${skipped} provider row${skipped === 1 ? "" : "s"} skipped${skippedReasons ? `: ${skippedReasons}` : ""}; valid partial facts were not stored (${storageCause})`
      : `the measured facts could not be stored, so none were (${storageCause})` };
  }
}

module.exports = { syncAccount };
