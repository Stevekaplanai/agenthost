// AgentHost mail engine -- the self-hosted "mini-Kit" (Steve, 2026-07-18).
// The whitepaper nurture list lives HERE, on the box volume, not in an ESP:
// the capture page on agenthost.space verifies the address (MillionVerifier,
// Cardinal Rule 7) and relays the subscriber to the gate with a shared secret;
// the gate's daily tick computes "who signed up N days ago -> send email N"
// and sends through Resend from mail.agenthost.space. Zero dependencies, one
// JSON store file, every transition pure and testable.
//
// Send-once semantics: sends[] is the ledger. dueStep() returns the HIGHEST
// unsent step whose day has arrived -- so a subscriber who is behind gets ONE
// catch-up email (the latest relevant one), never a backlog blast. Earlier
// skipped steps can never send later because "highest due" always wins.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Day offsets of the 10-send whitepaper sequence (EMAIL-PLAN.md section b).
const STEPS = [0, 1, 3, 5, 8, 11, 14, 18, 22, 26];
const DAY_MS = 24 * 60 * 60 * 1000;
// Resend keeps an idempotency key for 24 hours. Stop automatic retries an
// hour early so a slow request or clock edge can never cross that boundary and
// create a second real-world send with the same key.
const DELIVERY_RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;

function genToken() { return crypto.randomBytes(18).toString("hex"); }

function normEmail(e) { return String(e || "").trim().toLowerCase(); }

function emptyStore() { return { subscribers: {}, sends: [], outbox: {}, delivered: {}, lastSeqDay: "" }; }

function loadStore(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!s || typeof s !== "object" || Array.isArray(s)) return emptyStore();
    if (!s.subscribers || typeof s.subscribers !== "object" || Array.isArray(s.subscribers)) s.subscribers = {};
    if (!Array.isArray(s.sends)) s.sends = [];
    if (!s.outbox || typeof s.outbox !== "object" || Array.isArray(s.outbox)) s.outbox = {};
    if (!s.delivered || typeof s.delivered !== "object" || Array.isArray(s.delivered)) s.delivered = {};
    if (typeof s.lastSeqDay !== "string") s.lastSeqDay = "";
    return s;
  } catch { return emptyStore(); }
}

// Atomic write (tmp + rename) so a crash mid-save never truncates the list.
function saveStore(file, store) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(store), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// Upsert by email. A re-submit refreshes qualifiers and verification stamps but
// NEVER resets the sequence clock and never re-fires Day 0 (created: false).
// Only "ok" / "catch_all" ever reach this store -- the relay enforces it, and
// addSubscriber enforces it AGAIN (belt and suspenders, Cardinal Rule 7).
const MV_ALLOWED = new Set(["ok", "catch_all"]);
const MAX_SUBSCRIBERS = 20000; // secret-holder misuse backstop, not a growth plan
function addSubscriber(store, fields, nowMs) {
  const email = normEmail(fields.email);
  if (!email || !email.includes("@") || email.length > 254) return { error: "bad_email" };
  if (!MV_ALLOWED.has(fields.mv_status)) return { error: "unverified" };
  const existing = store.subscribers[email];
  if (existing) {
    if (fields.runs) existing.runs = String(fields.runs).slice(0, 32);
    if (fields.team) existing.team = String(fields.team).slice(0, 32);
    existing.mv_status = fields.mv_status;
    if (fields.mv_verified_at) existing.mv_verified_at = String(fields.mv_verified_at).slice(0, 40);
    // Re-submitting the form after unsubscribing is renewed consent -- the
    // person typed their address into the capture page again. Reactivate.
    // Suppression (bounce/complaint) is NOT consent-based and stays permanent.
    let reactivated = false;
    if (existing.unsubscribed_at && !existing.suppressed_at) {
      existing.unsubscribed_at = null;
      reactivated = true;
    }
    return { sub: existing, created: false, reactivated };
  }
  if (Object.keys(store.subscribers).length >= MAX_SUBSCRIBERS) return { error: "list_full" };
  const sub = {
    email,
    runs: String(fields.runs || "").slice(0, 32),
    team: String(fields.team || "").slice(0, 32),
    mv_status: fields.mv_status,
    mv_verified_at: String(fields.mv_verified_at || new Date(nowMs).toISOString()).slice(0, 40),
    source: String(fields.source || "whitepaper").slice(0, 32),
    created_at: new Date(nowMs).toISOString(),
    unsub_token: genToken(),
    unsubscribed_at: null,
    suppressed_at: null,
    suppress_reason: null,
  };
  store.subscribers[email] = sub;
  return { sub, created: true };
}

function isActive(sub) { return Boolean(sub) && !sub.unsubscribed_at && !sub.suppressed_at; }

function daysSince(iso, nowMs) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t) || t > nowMs) return 0;
  return Math.floor((nowMs - t) / DAY_MS);
}

function sentSteps(store, email) {
  const s = new Set();
  for (const x of store.sends) if (x.email === email) s.add(x.step);
  return s;
}

function dueStep(sub, sent, nowMs) {
  if (!isActive(sub)) return null;
  const d = daysSince(sub.created_at, nowMs);
  // Steps at or behind the newest already-sent step are dead forever: without
  // this, a subscriber at day 9 who got Day 8 would receive Day 5 NEXT (an
  // older email after a newer one). Sequences only ever move forward.
  let maxSent = -1;
  for (const s of sent) if (s > maxSent) maxSent = s;
  let due = null;
  for (const s of STEPS) if (s <= d && s > maxSent) due = s;
  return due;
}

function recordSend(store, email, step, resendId, nowMs) {
  if (store.sends.some((send) => send.email === email && send.step === step)) return;
  store.sends.push({ email, step, id: resendId || null, at: new Date(nowMs).toISOString() });
}

// ---- Durable provider outbox ------------------------------------------------
// A provider can accept an email and lose the HTTP response on the way back.
// Persisting this frozen record BEFORE the request gives every retry the same
// body and Resend Idempotency-Key. After the provider's 24-hour guarantee is
// nearly over, the record gates for human reconciliation instead of guessing.
function deliverySpec({ kind, unique, action, email, step = null, payload }) {
  const cleanKind = String(kind || "").trim().toLowerCase();
  const cleanAction = String(action || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  const cleanEmail = normEmail(email);
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(cleanKind)) throw new Error("bad delivery kind");
  if (!cleanAction || cleanAction.length > 48) throw new Error("bad delivery action");
  if (!cleanEmail || !cleanEmail.includes("@") || cleanEmail.length > 254) throw new Error("bad delivery email");
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("bad delivery payload");
  const frozen = JSON.parse(JSON.stringify(payload));
  const raw = JSON.stringify(frozen);
  if (raw.length > 512 * 1024) throw new Error("delivery payload too large");
  const digest = crypto.createHash("sha256")
    .update(cleanKind + "\0" + String(unique || "") + "\0" + cleanAction)
    .digest("hex").slice(0, 32);
  return {
    id: cleanKind + ":" + digest + ":" + cleanAction,
    kind: cleanKind,
    action: cleanAction,
    email: cleanEmail,
    step: Number.isInteger(step) ? step : null,
    idempotency_key: "agenthost-" + cleanKind + "-" + digest + "-" + cleanAction,
    payload: frozen,
    payload_hash: crypto.createHash("sha256").update(raw).digest("hex"),
  };
}

function deliveryState(delivery, nowMs) {
  if (!delivery) return "missing";
  if (delivery.status === "gated") return "gated";
  const first = Date.parse(delivery.first_attempt_at || "");
  if (Number.isFinite(first) && nowMs - first >= DELIVERY_RETRY_WINDOW_MS) return "gated";
  return "pending";
}

function prepareDelivery(store, spec, nowMs) {
  if (store.delivered[spec.id]) return { state: "delivered", delivery: store.delivered[spec.id] };
  const existing = store.outbox[spec.id];
  if (existing) {
    if (deliveryState(existing, nowMs) === "gated" && existing.status !== "gated") {
      existing.status = "gated";
      existing.gated_at = new Date(nowMs).toISOString();
    }
    // The first accepted body wins. This is deliberate: dynamic copy (for
    // example a changing slot count) must not reuse a key with a new payload.
    return { state: deliveryState(existing, nowMs), delivery: existing };
  }
  const delivery = {
    ...spec,
    status: "pending",
    attempts: 0,
    reserved_attempt: null,
    created_at: new Date(nowMs).toISOString(),
    first_attempt_at: null,
    last_attempt_at: null,
    last_error: null,
    gated_at: null,
  };
  store.outbox[delivery.id] = delivery;
  return { state: "pending", delivery };
}

function listOutbox(store, nowMs) {
  return Object.values(store.outbox).map((delivery) => {
    if (deliveryState(delivery, nowMs) === "gated" && delivery.status !== "gated") {
      delivery.status = "gated";
      delivery.gated_at = new Date(nowMs).toISOString();
    }
    return delivery;
  });
}

function reserveDeliveryAttempt(store, id, nowMs) {
  const delivery = store.outbox[id];
  if (!delivery) return { state: store.delivered[id] ? "delivered" : "missing", delivery: store.delivered[id] || null };
  if (deliveryState(delivery, nowMs) === "gated") {
    delivery.status = "gated";
    if (!delivery.gated_at) delivery.gated_at = new Date(nowMs).toISOString();
    return { state: "gated", delivery };
  }
  delivery.attempts = Math.max(0, Number(delivery.attempts) || 0) + 1;
  delivery.reserved_attempt = delivery.attempts;
  delivery.status = "reserved";
  return { state: "reserved", attempt: delivery.attempts, delivery };
}

function startDeliveryAttempt(store, id, attempt, nowMs) {
  const delivery = store.outbox[id];
  if (!delivery || delivery.reserved_attempt !== attempt) return null;
  const at = new Date(nowMs).toISOString();
  if (!delivery.first_attempt_at) delivery.first_attempt_at = at;
  delivery.last_attempt_at = at;
  delivery.status = "attempting";
  return delivery;
}

function deferDelivery(store, id, message) {
  const delivery = store.outbox[id];
  if (!delivery) return false;
  delivery.status = "pending";
  delivery.reserved_attempt = null;
  delivery.last_error = String(message || "deferred").slice(0, 300);
  return true;
}

function failDelivery(store, id, message) {
  const delivery = store.outbox[id];
  if (!delivery) return false;
  delivery.status = "unknown";
  delivery.reserved_attempt = null;
  delivery.last_error = String(message || "provider outcome unknown").slice(0, 300);
  return true;
}

function completeDelivery(store, id, resendId, nowMs) {
  if (store.delivered[id]) return store.delivered[id];
  const delivery = store.outbox[id];
  if (!delivery) return null;
  const completed = {
    id: delivery.id,
    kind: delivery.kind,
    action: delivery.action,
    email: delivery.email,
    step: delivery.step,
    provider_id: resendId || null,
    at: new Date(nowMs).toISOString(),
  };
  store.delivered[id] = completed;
  delete store.outbox[id];
  if (delivery.kind === "nurture" && Number.isInteger(delivery.step)) {
    recordSend(store, delivery.email, delivery.step, resendId, nowMs);
  }
  return completed;
}

function discardDelivery(store, id) {
  if (!store.outbox[id]) return false;
  delete store.outbox[id];
  return true;
}

function resendRequest(apiKey, delivery) {
  return {
    method: "POST",
    headers: {
      Authorization: "Bearer " + apiKey,
      "Content-Type": "application/json",
      "Idempotency-Key": delivery.idempotency_key,
    },
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify(delivery.payload),
  };
}

async function sendPreparedDelivery(apiKey, delivery, fetchImpl = fetch) {
  try {
    const response = await fetchImpl("https://api.resend.com/emails", resendRequest(apiKey, delivery));
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.id) return { ok: false, status: response.status, error: "provider rejected delivery" };
    return { ok: true, status: response.status, id: data.id };
  } catch (error) {
    return { ok: false, status: 0, error: String((error && error.message) || error) };
  }
}

function unsubscribeByToken(store, token, nowMs) {
  const t = String(token || "");
  if (!/^[a-f0-9]{36}$/.test(t)) return null; // 18 bytes hex; rejects junk before the scan
  for (const sub of Object.values(store.subscribers)) {
    if (sub.unsub_token === t) {
      if (!sub.unsubscribed_at) sub.unsubscribed_at = new Date(nowMs).toISOString();
      return sub.email;
    }
  }
  return null;
}

function suppress(store, email, reason, nowMs) {
  const sub = store.subscribers[normEmail(email)];
  if (!sub || sub.suppressed_at) return false;
  sub.suppressed_at = new Date(nowMs).toISOString();
  sub.suppress_reason = String(reason || "bounce").slice(0, 64);
  return true;
}

// Sends young enough that a bounce/complaint may still surface. The daily tick
// polls Resend for each of these (no webhook needed) and suppresses on bad news.
function sendsToCheck(store, nowMs, lookbackMs) {
  const cutoff = nowMs - lookbackMs;
  return store.sends.filter((x) => x.id && Date.parse(x.at) >= cutoff);
}

function stats(store) {
  let active = 0, unsubbed = 0, suppressed = 0;
  for (const sub of Object.values(store.subscribers)) {
    if (sub.unsubscribed_at) unsubbed++;
    else if (sub.suppressed_at) suppressed++;
    else active++;
  }
  const outbox = Object.values(store.outbox || {});
  return {
    active,
    unsubscribed: unsubbed,
    suppressed,
    total: active + unsubbed + suppressed,
    sends: store.sends.length,
    pending: outbox.filter((delivery) => delivery.status !== "gated").length,
    gated: outbox.filter((delivery) => delivery.status === "gated").length,
  };
}

module.exports = {
  STEPS, MAX_SUBSCRIBERS, DELIVERY_RETRY_WINDOW_MS, genToken, normEmail, emptyStore, loadStore, saveStore, addSubscriber,
  isActive, daysSince, sentSteps, dueStep, recordSend, unsubscribeByToken,
  suppress, sendsToCheck, deliverySpec, deliveryState, prepareDelivery, listOutbox,
  reserveDeliveryAttempt, startDeliveryAttempt, deferDelivery, failDelivery,
  completeDelivery, discardDelivery, resendRequest, sendPreparedDelivery, stats,
};
