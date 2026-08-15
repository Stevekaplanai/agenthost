// The self-hosted mail engine. The sequence math decides who gets emailed, so
// every boundary is tested: an off-by-one here either spams a subscriber with
// a backlog blast or silently never sends the ask email.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  STEPS, DELIVERY_RETRY_WINDOW_MS, genToken, emptyStore, loadStore, saveStore, addSubscriber,
  isActive, daysSince, sentSteps, dueStep, recordSend, unsubscribeByToken,
  suppress, sendsToCheck, deliverySpec, deliveryState, prepareDelivery, listOutbox,
  reserveDeliveryAttempt, startDeliveryAttempt, deferDelivery, failDelivery,
  completeDelivery, sendPreparedDelivery, stats,
} from "../container/mail-lib.js";
import { renderEmail, EMAIL_STEPS } from "../container/mail-emails.js";

const T0 = Date.parse("2026-07-18T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const CTX = {
  pdfUrl: "https://agenthost.space/AGENTHOST-BLAST-RADIUS.pdf",
  siteUrl: "https://agenthost.space",
  unsubUrl: "https://agenthost.space/api/unsubscribe?t=abc",
  slotsTaken: 0,
  monthName: "July",
};

function verifiedFields(email) {
  return { email, runs: "laptop", team: "solo", mv_status: "ok", mv_verified_at: new Date(T0).toISOString() };
}

// ---- addSubscriber: the Rule 7 gate lives in the store too -------------------

test("verified subscriber is stored with a token and the clock started", () => {
  const store = emptyStore();
  const r = addSubscriber(store, verifiedFields("A@Example.com "), T0);
  assert.equal(r.created, true);
  assert.equal(r.sub.email, "a@example.com"); // normalized
  assert.match(r.sub.unsub_token, /^[a-f0-9]{36}$/);
  assert.equal(isActive(r.sub), true);
});

test("unverified statuses never enter the store (belt AND suspenders)", () => {
  const store = emptyStore();
  for (const mv of ["pending-verify", "rejected", "", undefined, "valid"]) {
    const r = addSubscriber(store, { email: "x@example.com", mv_status: mv }, T0);
    assert.equal(r.error, "unverified");
  }
  assert.equal(Object.keys(store.subscribers).length, 0);
});

test("re-submit refreshes fields but never resets the clock or re-creates", () => {
  const store = emptyStore();
  const first = addSubscriber(store, verifiedFields("a@example.com"), T0);
  const again = addSubscriber(store, { ...verifiedFields("a@example.com"), runs: "ownbox" }, T0 + 5 * DAY);
  assert.equal(again.created, false);
  assert.equal(again.sub.runs, "ownbox");
  assert.equal(again.sub.created_at, first.sub.created_at);
  assert.equal(again.sub.unsub_token, first.sub.unsub_token);
});

// ---- dueStep: the one-per-day catch-up rule ----------------------------------

test("day 0: step 0 is due immediately, nothing else", () => {
  const store = emptyStore();
  const { sub } = addSubscriber(store, verifiedFields("a@example.com"), T0);
  assert.equal(dueStep(sub, new Set(), T0), 0);
  assert.equal(dueStep(sub, new Set([0]), T0), null);
});

test("a subscriber who fell behind gets ONE catch-up email, the latest due", () => {
  const store = emptyStore();
  const { sub } = addSubscriber(store, verifiedFields("a@example.com"), T0);
  // Day 9 with only Day 0 sent: 1, 3, 5, 8 are all unsent -- highest (8) wins.
  assert.equal(dueStep(sub, new Set([0]), T0 + 9 * DAY), 8);
  // After 8 is sent, day 9 has nothing more due; skipped 1/3/5 can NEVER fire.
  assert.equal(dueStep(sub, new Set([0, 8]), T0 + 9 * DAY), null);
  // Day 11 brings the next real step.
  assert.equal(dueStep(sub, new Set([0, 8]), T0 + 11 * DAY), 11);
});

test("boundary: a step becomes due exactly on its day, not the day before", () => {
  const store = emptyStore();
  const { sub } = addSubscriber(store, verifiedFields("a@example.com"), T0);
  const sent = new Set([0]);
  assert.equal(dueStep(sub, sent, T0 + 1 * DAY - 1), null);
  assert.equal(dueStep(sub, sent, T0 + 1 * DAY), 1);
});

test("sequence completes at day 26 and goes quiet forever", () => {
  const store = emptyStore();
  const { sub } = addSubscriber(store, verifiedFields("a@example.com"), T0);
  assert.equal(dueStep(sub, new Set(STEPS.slice(0, -1)), T0 + 26 * DAY), 26);
  assert.equal(dueStep(sub, new Set(STEPS), T0 + 400 * DAY), null);
});

test("unsubscribed and suppressed subscribers are never due", () => {
  const store = emptyStore();
  const { sub } = addSubscriber(store, verifiedFields("a@example.com"), T0);
  const email = unsubscribeByToken(store, sub.unsub_token, T0 + DAY);
  assert.equal(email, "a@example.com");
  assert.equal(dueStep(sub, new Set(), T0 + 3 * DAY), null);

  const { sub: sub2 } = addSubscriber(store, verifiedFields("b@example.com"), T0);
  assert.equal(suppress(store, "B@example.com", "bounced", T0), true); // normalizes
  assert.equal(dueStep(sub2, new Set(), T0 + 3 * DAY), null);
});

test("a clock in the future (bad data) counts as day 0, never negative-blasts", () => {
  const store = emptyStore();
  const { sub } = addSubscriber(store, verifiedFields("a@example.com"), T0 + 10 * DAY);
  assert.equal(daysSince(sub.created_at, T0), 0);
  assert.equal(dueStep(sub, new Set(), T0), 0);
});

// ---- unsubscribe token hygiene ----------------------------------------------

test("junk tokens are rejected before scanning the list", () => {
  const store = emptyStore();
  addSubscriber(store, verifiedFields("a@example.com"), T0);
  for (const t of ["", null, "abc", "../../etc", "Z".repeat(36)]) {
    assert.equal(unsubscribeByToken(store, t, T0), null);
  }
});

test("unsubscribe is idempotent and keeps the original timestamp", () => {
  const store = emptyStore();
  const { sub } = addSubscriber(store, verifiedFields("a@example.com"), T0);
  unsubscribeByToken(store, sub.unsub_token, T0 + DAY);
  const firstAt = sub.unsubscribed_at;
  unsubscribeByToken(store, sub.unsub_token, T0 + 9 * DAY);
  assert.equal(sub.unsubscribed_at, firstAt);
});

// ---- store round-trip + corruption safety ------------------------------------

test("store survives a save/load round-trip; corrupt files load empty", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mail-test-"));
  const file = path.join(dir, "store.json");
  const store = emptyStore();
  const { sub } = addSubscriber(store, verifiedFields("a@example.com"), T0);
  recordSend(store, sub.email, 0, "re_123", T0);
  saveStore(file, store);
  const back = loadStore(file);
  assert.equal(back.subscribers["a@example.com"].unsub_token, sub.unsub_token);
  assert.equal(back.sends.length, 1);

  fs.writeFileSync(file, "{corrupt");
  const fallback = loadStore(file);
  assert.deepEqual(fallback, emptyStore());
  fs.rmSync(dir, { recursive: true, force: true });
});

test("sendsToCheck returns only recent sends that have a Resend id", () => {
  const store = emptyStore();
  addSubscriber(store, verifiedFields("a@example.com"), T0);
  recordSend(store, "a@example.com", 0, "re_old", T0 - 100 * DAY);
  recordSend(store, "a@example.com", 1, null, T0); // failed send: no id, no poll
  recordSend(store, "a@example.com", 3, "re_new", T0);
  const due = sendsToCheck(store, T0, 3 * DAY);
  assert.deepEqual(due.map((x) => x.id), ["re_new"]);
});

// ---- provider outbox: crash and duplicate safety ----------------------------

function sampleDelivery(subject = "Welcome") {
  return deliverySpec({
    kind: "nurture",
    unique: "a@example.com",
    action: "step-0",
    email: "a@example.com",
    step: 0,
    payload: { from: "AgentHost <hello@example.com>", to: ["a@example.com"], subject, text: "Hello" },
  });
}

test("delivery is frozen in the durable outbox before a provider attempt", () => {
  const store = emptyStore();
  const first = prepareDelivery(store, sampleDelivery("First body wins"), T0);
  assert.equal(first.state, "pending");
  assert.equal(first.delivery.status, "pending");
  assert.equal(first.delivery.attempts, 0);
  assert.equal(first.delivery.first_attempt_at, null);

  // Dynamic copy may change while a response is unknown. The old body must be
  // reused with the old key; Resend rejects key reuse with a changed payload.
  const retry = prepareDelivery(store, sampleDelivery("Changed later"), T0 + DAY);
  assert.equal(retry.delivery.id, first.delivery.id);
  assert.equal(retry.delivery.payload.subject, "First body wins");
  assert.equal(retry.delivery.idempotency_key, first.delivery.idempotency_key);
});

test("provider retries carry one stable Idempotency-Key and exact request body", async () => {
  const store = emptyStore();
  const prepared = prepareDelivery(store, sampleDelivery(), T0).delivery;
  const calls = [];
  const provider = async (url, request) => {
    calls.push({ url, request });
    return { ok: true, status: 200, json: async () => ({ id: "re_same" }) };
  };

  const first = await sendPreparedDelivery("secret", prepared, provider);
  const retry = await sendPreparedDelivery("secret", prepared, provider);
  assert.deepEqual(first, { ok: true, status: 200, id: "re_same" });
  assert.deepEqual(retry, first);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://api.resend.com/emails");
  assert.equal(calls[0].request.headers["Idempotency-Key"], prepared.idempotency_key);
  assert.equal(calls[1].request.headers["Idempotency-Key"], prepared.idempotency_key);
  assert.equal(calls[1].request.body, calls[0].request.body);
  assert.ok(!calls[0].request.headers["Idempotency-Key"].includes("a@example.com"), "provider key contains no raw email");
});

test("an unknown provider outcome retries inside 23 hours then gates closed", () => {
  const store = emptyStore();
  const delivery = prepareDelivery(store, sampleDelivery(), T0).delivery;
  const reserved = reserveDeliveryAttempt(store, delivery.id, T0);
  assert.equal(reserved.attempt, 1);
  assert.ok(startDeliveryAttempt(store, delivery.id, 1, T0));
  assert.equal(failDelivery(store, delivery.id, "socket closed"), true);
  assert.equal(deliveryState(store.outbox[delivery.id], T0 + DELIVERY_RETRY_WINDOW_MS - 1), "pending");

  const retry = reserveDeliveryAttempt(store, delivery.id, T0 + DELIVERY_RETRY_WINDOW_MS - 1);
  assert.equal(retry.attempt, 2);
  deferDelivery(store, delivery.id, "test reset");
  const listed = listOutbox(store, T0 + DELIVERY_RETRY_WINDOW_MS);
  assert.equal(listed[0].status, "gated");
  assert.equal(reserveDeliveryAttempt(store, delivery.id, T0 + DELIVERY_RETRY_WINDOW_MS).state, "gated");
});

test("a reservation with no provider call does not start the retry horizon", () => {
  const store = emptyStore();
  const delivery = prepareDelivery(store, sampleDelivery(), T0).delivery;
  reserveDeliveryAttempt(store, delivery.id, T0);
  deferDelivery(store, delivery.id, "lifecycle ledger unavailable");
  assert.equal(deliveryState(store.outbox[delivery.id], T0 + 30 * DAY), "pending");
});

test("provider success atomically closes the outbox and records nurture once", () => {
  const store = emptyStore();
  const delivery = prepareDelivery(store, sampleDelivery(), T0).delivery;
  reserveDeliveryAttempt(store, delivery.id, T0);
  startDeliveryAttempt(store, delivery.id, 1, T0);
  completeDelivery(store, delivery.id, "re_123", T0 + 1);
  completeDelivery(store, delivery.id, "re_123", T0 + 2);
  assert.equal(store.outbox[delivery.id], undefined);
  assert.equal(store.delivered[delivery.id].provider_id, "re_123");
  assert.deepEqual([...sentSteps(store, "a@example.com")], [0]);
  assert.equal(store.sends.length, 1);
});

test("stats counts each subscriber and outbox state once", () => {
  const store = emptyStore();
  const a = addSubscriber(store, verifiedFields("a@example.com"), T0).sub;
  addSubscriber(store, verifiedFields("b@example.com"), T0);
  const c = addSubscriber(store, verifiedFields("c@example.com"), T0).sub;
  unsubscribeByToken(store, a.unsub_token, T0);
  suppress(store, c.email, "bounced", T0);
  const pending = prepareDelivery(store, sampleDelivery(), T0).delivery;
  const gated = deliverySpec({
    kind: "checkout", unique: "cs_123", action: "buyer-welcome", email: "buyer@example.com",
    payload: { to: ["buyer@example.com"], subject: "Welcome" },
  });
  prepareDelivery(store, gated, T0);
  reserveDeliveryAttempt(store, gated.id, T0);
  startDeliveryAttempt(store, gated.id, 1, T0);
  listOutbox(store, T0 + DELIVERY_RETRY_WINDOW_MS);
  assert.ok(pending);
  assert.deepEqual(stats(store), { active: 1, unsubscribed: 1, suppressed: 1, total: 3, sends: 0, pending: 1, gated: 1 });
});

// ---- the emails themselves ---------------------------------------------------

test("every sequence step renders with a subject and both bodies", () => {
  assert.deepEqual(EMAIL_STEPS, STEPS);
  for (const step of STEPS) {
    const msg = renderEmail(step, CTX);
    assert.ok(msg.subject.length > 4, "step " + step + " subject");
    assert.ok(msg.text.length > 40, "step " + step + " text");
    assert.ok(msg.html.includes("<div"), "step " + step + " html");
  }
  assert.equal(renderEmail(99, CTX), null);
});

test("every email carries a visible unsubscribe link (Day 26 included)", () => {
  for (const step of STEPS) {
    const msg = renderEmail(step, CTX);
    assert.ok(msg.text.includes(CTX.unsubUrl), "step " + step + " text unsub");
    assert.ok(msg.html.includes(CTX.unsubUrl), "step " + step + " html unsub");
  }
});

test("no em-dashes anywhere in email copy (standing voice rule)", () => {
  for (const step of STEPS) {
    const msg = renderEmail(step, CTX);
    assert.ok(!msg.text.includes("—"), "step " + step + " has an em-dash");
  }
});

test("Day 22 send rule: zero slots claimed states the honest variant", () => {
  const zero = renderEmail(22, { ...CTX, slotsTaken: 0 });
  assert.ok(zero.text.includes("hasn't filled and I won't pretend otherwise"));
  assert.ok(zero.subject.includes("10 of 10 boxes left"));
  const three = renderEmail(22, { ...CTX, slotsTaken: 3, monthName: "August" });
  assert.ok(three.text.includes("7 of 10 slots remain for August"));
  assert.ok(three.subject.includes("7 of 10 boxes left"));
  // Values outside 0-10 clamp instead of printing nonsense.
  const wild = renderEmail(22, { ...CTX, slotsTaken: 99 });
  assert.ok(wild.text.includes("0 of 10 slots remain"));
});

test("Day 22 fails HONEST when the slot count is unknown: null, never 'all open'", () => {
  // An unset FOUNDING_SLOTS_TAKEN must hold the send, not fabricate scarcity.
  // (mailCtxFor maps an absent secret to NaN and a junk value via Number().)
  for (const missing of [undefined, NaN, Number("seven")]) {
    assert.equal(renderEmail(22, { ...CTX, slotsTaken: missing }), null);
  }
  // Every other step still renders without a count.
  for (const step of STEPS.filter((s) => s !== 22)) {
    assert.ok(renderEmail(step, { ...CTX, slotsTaken: NaN }), "step " + step);
  }
});

test("no double spaces in any rendered email text", () => {
  for (const step of STEPS) {
    const msg = renderEmail(step, { ...CTX, slotsTaken: 4 });
    assert.ok(!/ {2}/.test(msg.text), "step " + step + " has a double space");
  }
});

test("re-subscribing after unsubscribe reactivates (renewed consent); suppression stays", () => {
  const store = emptyStore();
  const { sub } = addSubscriber(store, verifiedFields("a@example.com"), T0);
  unsubscribeByToken(store, sub.unsub_token, T0 + DAY);
  const back = addSubscriber(store, verifiedFields("a@example.com"), T0 + 2 * DAY);
  assert.equal(back.reactivated, true);
  assert.equal(isActive(back.sub), true);
  // A bounced address is dead no matter how many times the form is submitted.
  const { sub: b } = addSubscriber(store, verifiedFields("b@example.com"), T0);
  suppress(store, b.email, "bounced", T0);
  const retry = addSubscriber(store, verifiedFields("b@example.com"), T0 + DAY);
  assert.equal(retry.reactivated, false);
  assert.equal(isActive(retry.sub), false);
});

test("Day 0 links the PDF; Day 14 and 18 link the site", () => {
  assert.ok(renderEmail(0, CTX).text.includes(CTX.pdfUrl));
  assert.ok(renderEmail(14, CTX).text.includes(CTX.siteUrl));
  assert.ok(renderEmail(18, CTX).text.includes(CTX.siteUrl));
});

test("html escapes markup but keeps URLs clickable", () => {
  const msg = renderEmail(1, CTX);
  assert.ok(!/<script/i.test(msg.html));
  assert.ok(msg.html.includes('<a href="' + CTX.unsubUrl + '"'));
});

test("tokens are unique and well-formed", () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const t = genToken();
    assert.match(t, /^[a-f0-9]{36}$/);
    assert.ok(!seen.has(t));
    seen.add(t);
  }
});
