// mesh-contract.js -- the Box Mesh message contract (agenthost.message.v1).
// Phase 1 of the box-mesh build (09_Bridge to-ccd plan, 2026-07-31): the PURE
// half of the mesh -- envelope validation, expiry with bounded clock skew,
// canonical causal hashing, HMAC signing/verification, and the policy decision
// point. No I/O, no globals, no clock reads (callers pass `now`), so every
// acceptance gate is unit-testable without a second machine or a live agent.
//
// Design decisions (docs/MESH-PHASE-0-NOTE.md has the full rationale):
// - Identity is the KEY, not the field: verify() looks up the pinned secret
//   for the peer the envelope names; an unknown or mismatched sender fails
//   verification. The envelope's sender_box alone is never trusted.
// - Clock skew: two boxes, two clocks. +-SKEW_MS tolerance on issued_at and
//   expires_at; both timestamps ride into the audit record.
// - Policy: a CLOSED table, deny by default. v1 delivers exactly one shape --
//   kind "chat" with capability "chat.post" -- everything else is denied even
//   when the envelope is otherwise valid.
// - Secrets never enter the envelope or the audit record; the signature is an
//   HMAC computed FROM a secret, which is not recoverable from it.

"use strict";

const crypto = require("crypto");

const SCHEMA = "agenthost.message.v1";
const KINDS = new Set(["chat", "board", "state", "control"]);
const SKEW_MS = 120 * 1000; // bounded clock-skew tolerance between boxes
const MAX_TTL_MS = 5 * 60 * 1000; // maximum declared lifetime; SKEW_MS remains separate tolerance
const MAX_BODY_BYTES = 32 * 1024; // one mesh message is a message, not a payload channel

// Canonical form: JSON with lexicographically sorted keys at every level and
// the signature field excluded. Both the HMAC and the causal hash are computed
// over this form, so field order on the wire can never change identity.
function canonical(envelope) {
  const strip = { ...envelope };
  delete strip.signature;
  const sortKeys = (v) => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === "object") {
      const out = Object.create(null);
      for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sortKeys(strip));
}

function causalHash(envelope) {
  return crypto.createHash("sha256").update(canonical(envelope)).digest("hex");
}

// Stable meaning bound to a sender's message_id. Retries legitimately refresh
// wire timestamps and may adopt a repaired chain parent, so those transport
// fields (and the resulting signature) are excluded. Every other signed field,
// including future extension fields, remains bound and cannot change silently.
function messageFingerprint(envelope) {
  const semantic = { ...envelope };
  delete semantic.signature;
  delete semantic.issued_at;
  delete semantic.expires_at;
  delete semantic.causal_parent;
  return crypto.createHash("sha256")
    .update("agenthost.message.fingerprint.v1\0")
    .update(canonical(semantic))
    .digest("hex");
}

function sign(envelope, secret) {
  return crypto.createHmac("sha256", String(secret)).update(canonical(envelope)).digest("hex");
}

// peers: { "<box-id>": "<shared-secret>" }. Returns true only when the
// envelope's own sender_box resolves to a pinned secret AND the signature
// matches under that secret (timing-safe compare).
function verify(envelope, peers) {
  if (!envelope || typeof envelope !== "object") return false;
  const secret = peers && typeof peers === "object" ? peers[String(envelope.sender_box || "")] : null;
  if (typeof secret !== "string" || !secret) return false;
  const sig = String(envelope.signature || "");
  let expect;
  // canonical() recursively visits untrusted JSON. A deeply nested extra field
  // must fail authentication, not escape the request callback and kill gate.js.
  try { expect = sign(envelope, secret); } catch { return false; }
  if (sig.length !== expect.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect)); } catch { return false; }
}

// Structural validation only (no key material, no clock): every required
// v1 field present and sane. Returns { ok: true } or { ok: false, reason }.
// Reasons are stable strings -- they become audit rows and test assertions.
function validateShape(envelope, selfBoxId) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return { ok: false, reason: "bad_envelope" };
  if (envelope.schema !== SCHEMA) return { ok: false, reason: "bad_schema" };
  const id = envelope.message_id;
  if (typeof id !== "string" || id.length < 8 || id.length > 100 || !/^[A-Za-z0-9_.:-]+$/.test(id)) return { ok: false, reason: "bad_message_id" };
  if (typeof envelope.sender_box !== "string" || !envelope.sender_box) return { ok: false, reason: "bad_sender" };
  if (typeof envelope.receiver_box !== "string" || !envelope.receiver_box) return { ok: false, reason: "bad_receiver" };
  if (selfBoxId && envelope.receiver_box !== selfBoxId) return { ok: false, reason: "wrong_receiver" };
  if (typeof envelope.issued_at !== "string" || !Number.isFinite(Date.parse(envelope.issued_at))) return { ok: false, reason: "bad_issued_at" };
  if (typeof envelope.expires_at !== "string" || !Number.isFinite(Date.parse(envelope.expires_at))) return { ok: false, reason: "bad_expires_at" };
  if (!KINDS.has(envelope.kind)) return { ok: false, reason: "bad_kind" };
  if (!envelope.policy || typeof envelope.policy !== "object" || typeof envelope.policy.capability !== "string") return { ok: false, reason: "bad_policy" };
  if (envelope.causal_parent !== null && !(typeof envelope.causal_parent === "string" && /^[0-9a-f]{64}$/.test(envelope.causal_parent))) return { ok: false, reason: "bad_causal_parent" };
  if (!envelope.body || typeof envelope.body !== "object" || Array.isArray(envelope.body)) return { ok: false, reason: "bad_body" };
  try { if (Buffer.byteLength(JSON.stringify(envelope.body)) > MAX_BODY_BYTES) return { ok: false, reason: "body_too_large" }; } catch { return { ok: false, reason: "bad_body" }; }
  if (typeof envelope.signature !== "string" || !envelope.signature) return { ok: false, reason: "unsigned" };
  return { ok: true };
}

// Time validity under bounded skew. `now` is injected (never read here) so
// tests own the clock.
function validateTime(envelope, now) {
  const issued = Date.parse(envelope.issued_at);
  const expires = Date.parse(envelope.expires_at);
  if (issued > now + SKEW_MS) return { ok: false, reason: "future_dated" };
  if (expires < now - SKEW_MS) return { ok: false, reason: "expired" };
  if (expires <= issued) return { ok: false, reason: "expires_before_issued" };
  if (expires - issued > MAX_TTL_MS) return { ok: false, reason: "ttl_too_long" };
  return { ok: true };
}

// The policy decision point: a CLOSED table, deny by default. v1's only
// deliverable action is a chat post into the shared transcript. Everything
// else -- including structurally valid board/state/control messages -- is
// denied here until its phase lands. Adding a capability is an explicit new
// row in this table plus tests, never a fallthrough.
const POLICY_TABLE = Object.freeze({
  "chat|chat.post": Object.freeze({ action: "chat_post" }),
});
function policyDecide(envelope) {
  const row = POLICY_TABLE[envelope.kind + "|" + envelope.policy.capability];
  if (!row) return { allowed: false, reason: "policy_denied" };
  return { allowed: true, action: row.action };
}

// Full acceptance pipeline for an inbound envelope, in rejection-priority
// order (shape -> receiver -> signature -> time -> policy). Locked and
// duplicate checks are the STORE's job (they need disk state); the caller runs
// them around this. Returns { ok, reason?, action?, hash }.
function acceptEnvelope(envelope, opts) {
  const o = opts || {};
  const shape = validateShape(envelope, o.selfBoxId);
  if (!shape.ok) return { ok: false, reason: shape.reason };
  if (!verify(envelope, o.peers)) return { ok: false, reason: "bad_signature" };
  const time = validateTime(envelope, Number.isFinite(o.now) ? o.now : Date.now());
  if (!time.ok) return { ok: false, reason: time.reason };
  const policy = policyDecide(envelope);
  if (!policy.allowed) return { ok: false, reason: policy.reason };
  return { ok: true, action: policy.action, hash: causalHash(envelope) };
}

// Build + sign an outbound envelope. ttlMs bounds expiry; causal_parent is the
// last audit hash for this peer pair (the store supplies it).
function buildEnvelope(fields, secret) {
  const now = Number.isFinite(fields.now) ? fields.now : Date.now();
  const ttlMs = Number.isFinite(fields.ttlMs) ? Math.min(fields.ttlMs, MAX_TTL_MS) : MAX_TTL_MS;
  const envelope = {
    schema: SCHEMA,
    message_id: fields.message_id || crypto.randomBytes(12).toString("base64url"),
    sender_box: fields.sender_box,
    receiver_box: fields.receiver_box,
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + ttlMs).toISOString(),
    kind: fields.kind,
    policy: fields.policy,
    causal_parent: fields.causal_parent || null,
    body: fields.body || {},
  };
  envelope.signature = sign(envelope, secret);
  return envelope;
}

module.exports = {
  SCHEMA,
  SKEW_MS,
  MAX_TTL_MS,
  canonical,
  causalHash,
  messageFingerprint,
  sign,
  verify,
  validateShape,
  validateTime,
  policyDecide,
  acceptEnvelope,
  buildEnvelope,
};
