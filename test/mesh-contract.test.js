// Box Mesh contract (mesh-contract.js) — phase 1 acceptance gates from the
// build plan (09_Bridge to-ccd, 2026-07-31):
//   1. Invalid schema/sender/receiver/expiry/signature/policy rejected BEFORE
//      delivery, each with a stable reason.
//   2. Causal hash is stable under key reordering and changes with content.
//   3. Identity is the KEY, not the field: a forged sender_box fails.
//   4. Policy is a closed table, deny by default.
//   5. Clock skew: bounded tolerance both directions.
// No second machine, no live agent, no I/O — the contract layer is pure.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as mesh from "../container/mesh-contract.js";

const PEERS = { "box-alpha": "secret-alpha", "box-beta": "secret-beta" };
const NOW = Date.parse("2026-07-31T12:00:00Z");

function goodEnvelope(overrides) {
  const base = mesh.buildEnvelope({
    now: NOW - 1000,
    sender_box: "box-alpha",
    receiver_box: "box-beta",
    kind: "chat",
    policy: { capability: "chat.post", scope: "transcript" },
    body: { text: "hello from alpha" },
  }, PEERS["box-alpha"]);
  if (!overrides) return base;
  const e = { ...base, ...overrides };
  // Unless the test is specifically about a broken signature, re-sign so the
  // override under test is the ONLY thing wrong with the envelope.
  if (!("signature" in overrides)) e.signature = mesh.sign(e, PEERS[e.sender_box] || "no-such-secret");
  return e;
}

test("mesh: a valid signed envelope is accepted with its causal hash and action", () => {
  const r = mesh.acceptEnvelope(goodEnvelope(), { peers: PEERS, selfBoxId: "box-beta", now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.action, "chat_post");
  assert.match(r.hash, /^[0-9a-f]{64}$/);
});

test("mesh: every malformed field is rejected before delivery, with a stable reason", () => {
  const cases = [
    [{ schema: "agenthost.message.v2" }, "bad_schema"],
    [{ message_id: "x" }, "bad_message_id"],
    [{ sender_box: "" }, "bad_sender"],
    [{ receiver_box: "" }, "bad_receiver"],
    [{ receiver_box: "box-gamma" }, "wrong_receiver"],
    [{ issued_at: "not-a-time" }, "bad_issued_at"],
    [{ expires_at: "not-a-time" }, "bad_expires_at"],
    [{ kind: "shell" }, "bad_kind"],
    [{ policy: { nope: true } }, "bad_policy"],
    [{ causal_parent: "zz" }, "bad_causal_parent"],
    [{ body: [] }, "bad_body"],
    [{ signature: "" }, "unsigned"],
  ];
  for (const [overrides, reason] of cases) {
    const r = mesh.acceptEnvelope(goodEnvelope(overrides), { peers: PEERS, selfBoxId: "box-beta", now: NOW });
    assert.equal(r.ok, false, reason + " must reject");
    assert.equal(r.reason, reason);
  }
});

test("mesh: identity is the pinned key — a forged sender or wrong secret fails", () => {
  // sender_box renamed to a peer whose secret did NOT sign the envelope
  const forged = goodEnvelope();
  forged.sender_box = "box-beta";
  assert.equal(mesh.acceptEnvelope(forged, { peers: PEERS, selfBoxId: "box-beta", now: NOW }).reason, "bad_signature");
  // unknown sender: no pinned key at all
  const unknown = goodEnvelope();
  unknown.sender_box = "box-mallory";
  unknown.signature = mesh.sign(unknown, "mallorys-own-secret");
  assert.equal(mesh.acceptEnvelope(unknown, { peers: PEERS, selfBoxId: "box-beta", now: NOW }).reason, "bad_signature");
  // tampered body after signing
  const tampered = goodEnvelope();
  tampered.body = { text: "evil edit" };
  assert.equal(mesh.acceptEnvelope(tampered, { peers: PEERS, selfBoxId: "box-beta", now: NOW }).reason, "bad_signature");
});

test("mesh: expiry honors bounded clock skew in both directions", () => {
  const fresh = goodEnvelope();
  // expired just inside the skew window -> still accepted
  const justExpired = Date.parse(fresh.expires_at) + mesh.SKEW_MS - 1000;
  assert.equal(mesh.acceptEnvelope(fresh, { peers: PEERS, selfBoxId: "box-beta", now: justExpired }).ok, true);
  // expired beyond the window -> rejected
  const longExpired = Date.parse(fresh.expires_at) + mesh.SKEW_MS + 1000;
  assert.equal(mesh.acceptEnvelope(fresh, { peers: PEERS, selfBoxId: "box-beta", now: longExpired }).reason, "expired");
  // issued in the future beyond the window -> rejected
  const early = Date.parse(fresh.issued_at) - mesh.SKEW_MS - 1000;
  assert.equal(mesh.acceptEnvelope(fresh, { peers: PEERS, selfBoxId: "box-beta", now: early }).reason, "future_dated");
});

test("mesh: an envelope's declared lifetime cannot exceed five minutes", () => {
  const boundary = goodEnvelope({
    issued_at: new Date(NOW).toISOString(),
    expires_at: new Date(NOW + 5 * 60 * 1000).toISOString(),
  });
  assert.equal(mesh.acceptEnvelope(boundary, { peers: PEERS, selfBoxId: "box-beta", now: NOW }).ok, true,
    "the documented five-minute lifetime remains valid");

  const tooLong = goodEnvelope({
    issued_at: new Date(NOW).toISOString(),
    expires_at: new Date(NOW + 5 * 60 * 1000 + 1).toISOString(),
  });
  assert.equal(mesh.acceptEnvelope(tooLong, { peers: PEERS, selfBoxId: "box-beta", now: NOW }).reason, "ttl_too_long",
    "a valid signature cannot extend the replay window beyond the protocol maximum");

  const built = mesh.buildEnvelope({
    now: NOW,
    ttlMs: mesh.MAX_TTL_MS + 1,
    sender_box: "box-alpha",
    receiver_box: "box-beta",
    kind: "chat",
    policy: { capability: "chat.post" },
    body: { text: "bounded at the source" },
  }, PEERS["box-alpha"]);
  assert.equal(Date.parse(built.expires_at) - Date.parse(built.issued_at), mesh.MAX_TTL_MS,
    "a caller-supplied TTL is capped at the protocol maximum");
});

test("mesh: policy is a closed table — deny by default", () => {
  for (const kind of ["board", "state", "control"]) {
    const e = goodEnvelope({ kind });
    assert.equal(mesh.acceptEnvelope(e, { peers: PEERS, selfBoxId: "box-beta", now: NOW }).reason, "policy_denied",
      kind + " has no v1 capability and must be denied");
  }
  const wrongCap = goodEnvelope({ policy: { capability: "shell.exec", scope: "..." } });
  assert.equal(mesh.acceptEnvelope(wrongCap, { peers: PEERS, selfBoxId: "box-beta", now: NOW }).reason, "policy_denied");
});

test("mesh: the causal hash is canonical — key order irrelevant, content changes it", () => {
  const e = goodEnvelope();
  const reordered = {};
  for (const k of Object.keys(e).reverse()) reordered[k] = e[k];
  reordered.policy = { scope: e.policy.scope, capability: e.policy.capability }; // nested reorder too
  assert.equal(mesh.causalHash(e), mesh.causalHash(reordered), "field order never changes identity");
  assert.notEqual(mesh.causalHash(e), mesh.causalHash({ ...e, body: { text: "different" } }));
  // the signature itself is excluded from the hash (hash is pre-signature identity)
  assert.equal(mesh.causalHash(e), mesh.causalHash({ ...e, signature: "whatever" }));
});

test("mesh: the message fingerprint binds content but ignores retry metadata", () => {
  const e = goodEnvelope();
  const retry = {
    ...e,
    issued_at: new Date(NOW + 1000).toISOString(),
    expires_at: new Date(NOW + 1000 + mesh.MAX_TTL_MS).toISOString(),
    causal_parent: "a".repeat(64),
    signature: "a refreshed wire signature",
  };
  assert.equal(mesh.messageFingerprint(e), mesh.messageFingerprint(retry),
    "timestamps, chain repair, and signature changes are legitimate retry metadata");
  for (const changed of [
    { ...e, schema: "agenthost.message.v2" },
    { ...e, message_id: "different-message-id" },
    { ...e, sender_box: "box-gamma" },
    { ...e, body: { text: "different" } },
    { ...e, policy: { capability: "chat.post", scope: "different" } },
    { ...e, receiver_box: "box-gamma" },
    { ...e, kind: "control" },
    { ...e, future_signed_field: "different" },
  ]) {
    assert.notEqual(mesh.messageFingerprint(e), mesh.messageFingerprint(changed),
      "signed message meaning must remain bound to its id");
  }
  assert.equal(mesh.messageFingerprint(e), mesh.messageFingerprint({
    ...e,
    policy: { scope: e.policy.scope, capability: e.policy.capability },
  }), "nested key order is not message meaning");
});

test("mesh: canonical signing and fingerprints bind enumerable __proto__ fields", () => {
  const first = goodEnvelope({ body: JSON.parse('{"text":"same","__proto__":{"marker":"first"}}') });
  const second = goodEnvelope({ body: JSON.parse('{"text":"same","__proto__":{"marker":"second"}}') });
  assert.notEqual(mesh.canonical(first), mesh.canonical(second));
  assert.notEqual(mesh.causalHash(first), mesh.causalHash(second));
  assert.notEqual(mesh.messageFingerprint(first), mesh.messageFingerprint(second));
});

test("mesh: buildEnvelope round-trips through acceptEnvelope with a causal parent", () => {
  const parent = mesh.causalHash(goodEnvelope());
  const e = mesh.buildEnvelope({
    now: NOW, sender_box: "box-beta", receiver_box: "box-alpha", kind: "chat",
    policy: { capability: "chat.post", scope: "transcript" },
    causal_parent: parent, body: { text: "reply" },
  }, PEERS["box-beta"]);
  const r = mesh.acceptEnvelope(e, { peers: PEERS, selfBoxId: "box-alpha", now: NOW });
  assert.equal(r.ok, true);
  assert.equal(e.causal_parent, parent);
});

test("mesh: oversized bodies are rejected (a message is not a payload channel)", () => {
  const e = goodEnvelope({ body: { blob: "x".repeat(40 * 1024) } });
  assert.equal(mesh.acceptEnvelope(e, { peers: PEERS, selfBoxId: "box-beta", now: NOW }).reason, "body_too_large");
});
