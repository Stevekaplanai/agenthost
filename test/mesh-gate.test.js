// Box Mesh gate wiring (phase 2). The live two-box exchange is a post-deploy,
// human-gated proof (neither box is reachable from CI), so this pins two
// things that DON'T need a second machine:
//   1. deliverMeshMessage — the real inbound pipeline exported from gate.js —
//      run against a temp mesh dir: delivery calls post() exactly once, replay
//      is idempotent, LOCKED refuses, a forged message is rejected, and the
//      audit chain links.
//   2. The route/auth wiring, as source contracts: mesh routes sit before the
//      cookie wall, reads are HMAC-gated, POST runs the contract, deny-by-
//      default kinds never deliver, and the modules are shipped in the image.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  deliverMeshMessage,
  meshSincePage,
  meshPeers,
  meshReadAuthed,
  meshSinceDecision,
  meshSinceRateGate,
  MESH_SINCE_COOLDOWN_MS,
  teamThreadIdDecision,
  readTeamThreadFile,
  retainedTeamThreadLines,
  TEAM_THREAD_KEEP,
  MESH_THREAD_RETENTION_MS,
} from "../container/gate.js";
const gateLib = { meshSincePage };
import * as mesh from "../container/mesh-contract.js";
import * as store from "../container/mesh-store.js";

const gate = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");
const dockerfile = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "Dockerfile"), "utf8");
const dashboardRoot = path.join(import.meta.dirname, "..", "dashboard");
const meshView = fs.readFileSync(path.join(dashboardRoot, "components", "agenthost", "mesh.tsx"), "utf8");
const boardView = fs.readFileSync(path.join(dashboardRoot, "components", "agenthost", "full-board.tsx"), "utf8");
const commandCenter = fs.readFileSync(path.join(dashboardRoot, "components", "agenthost", "command-center.tsx"), "utf8");
const dashboardApi = fs.readFileSync(path.join(dashboardRoot, "lib", "api.ts"), "utf8");
const operatorView = fs.readFileSync(path.join(dashboardRoot, "components", "agenthost", "operator.tsx"), "utf8");

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "mesh-gate-")); }
const PEERS = { "box-alpha": "secret-alpha" };
const NOW = Date.parse("2026-07-31T12:00:00Z");
function chatEnvelope(text, overrides) {
  return mesh.buildEnvelope({
    now: NOW, sender_box: "box-alpha", receiver_box: "box-beta", kind: "chat",
    policy: { capability: "chat.post", scope: "mesh" }, body: { text: text || "hi" },
    ...(overrides || {}),
  }, "secret-alpha");
}

function transcriptReceipt(envelope, hash) {
  return {
    fingerprint: mesh.messageFingerprint(envelope),
    hash,
    causal_parent: envelope.causal_parent || null,
    kind: envelope.kind,
    issued_at: envelope.issued_at,
    expires_at: envelope.expires_at,
  };
}

test("transcript idempotency binds a mesh id to its original durable receipt", () => {
  const id = "mesh-transcript-id";
  const receipt = {
    fingerprint: "a".repeat(64), hash: "b".repeat(64), causal_parent: null,
    kind: "chat", issued_at: "2026-07-31T12:00:00.000Z", expires_at: "2026-07-31T12:05:00.000Z",
  };
  assert.deepEqual(teamThreadIdDecision([], id, receipt), { status: "new", id });
  assert.deepEqual(teamThreadIdDecision([{ id }], id, receipt), { status: "mesh_conflict" },
    "a legacy transcript row cannot be rebound to unverifiable content");
  assert.deepEqual(teamThreadIdDecision([{ id, meshReceipt: receipt }], id, {
    ...receipt, hash: "c".repeat(64),
  }), { status: "mesh_duplicate", receipt },
  "the original receipt wins when a semantic retry has refreshed wire metadata");
  assert.deepEqual(teamThreadIdDecision([{ id, meshReceipt: receipt }], id, {
    ...receipt, fingerprint: "d".repeat(64),
  }), { status: "mesh_conflict" });
  assert.deepEqual(teamThreadIdDecision([{ id }], id, null), { status: "duplicate" },
    "ordinary non-mesh transcript ids keep their existing behavior");
});

test("deliver: a valid chat message delivers, posts once, and audits", () => {
  const dir = tmpDir();
  let posts = [];
  const e = chatEnvelope("hello from alpha");
  const r = deliverMeshMessage(dir, e, { selfBoxId: "box-beta", peers: PEERS, now: NOW, post: (who, text) => posts.push([who, text]) });
  assert.equal(r.status, "delivered");
  assert.deepEqual(posts, [["box:box-alpha", "hello from alpha"]], "delivered exactly once, attributed to the sender box");
  const audit = store.readAudit(dir, 10).filter((x) => x.event === "mesh_delivered");
  assert.equal(audit.length, 1);
  assert.equal(audit[0].hash, r.hash);
});

test("deliver: replay is idempotent — no second post, no second audit record", () => {
  const dir = tmpDir();
  let posts = 0;
  const e = chatEnvelope("once");
  const opts = { selfBoxId: "box-beta", peers: PEERS, now: NOW, post: () => posts++ };
  const first = deliverMeshMessage(dir, e, opts);
  const again = deliverMeshMessage(dir, e, opts);
  assert.equal(first.status, "delivered");
  assert.equal(again.status, "duplicate");
  assert.equal(again.receipt.hash, first.hash);
  assert.equal(posts, 1, "the replay does not post again");
  assert.equal(store.readAudit(dir, 10).filter((x) => x.event === "mesh_delivered").length, 1);
});

test("deliver: one sender cannot reuse a message id for different signed content", () => {
  const dir = tmpDir();
  const posts = [];
  const opts = { selfBoxId: "box-beta", peers: PEERS, now: NOW, post: (_who, text) => posts.push(text) };
  const original = chatEnvelope("original", { message_id: "same-id-different-content" });
  const first = deliverMeshMessage(dir, original, opts);
  assert.equal(first.status, "delivered");
  const saved = store.seenReceipt(dir, "box-alpha", original.message_id);
  assert.match(saved.fingerprint, /^[0-9a-f]{64}$/,
    "the terminal receipt binds the meaning recorded under this id");

  const changed = chatEnvelope("changed", {
    message_id: original.message_id,
    causal_parent: first.hash,
    now: NOW + 1000,
  });
  assert.deepEqual(deliverMeshMessage(dir, changed, opts), {
    status: "rejected", reason: "message_id_conflict", terminal: true,
  });
  assert.deepEqual(posts, ["original"], "changed content never reaches the transcript");
  assert.equal(store.seenReceipt(dir, "box-alpha", original.message_id).fingerprint, saved.fingerprint,
    "the conflict cannot overwrite the original receipt");

  const retry = chatEnvelope("original", {
    message_id: original.message_id,
    causal_parent: "b".repeat(64),
    now: NOW + 1000,
  });
  assert.equal(deliverMeshMessage(dir, retry, opts).status, "duplicate",
    "fresh timestamps and a healed parent do not change the logical message");
});

test("deliver: a terminally rejected id cannot be changed into an allowed message", () => {
  const dir = tmpDir();
  let posts = 0;
  const opts = { selfBoxId: "box-beta", peers: PEERS, now: NOW, post: () => posts++ };
  const denied = mesh.buildEnvelope({
    now: NOW, message_id: "same-rejected-id", sender_box: "box-alpha", receiver_box: "box-beta",
    kind: "control", policy: { capability: "shell.exec" }, causal_parent: null, body: {},
  }, "secret-alpha");
  assert.equal(deliverMeshMessage(dir, denied, opts).reason, "policy_denied");
  assert.match(store.seenReceipt(dir, "box-alpha", denied.message_id).fingerprint, /^[0-9a-f]{64}$/);

  const changed = chatEnvelope("now allowed", { message_id: denied.message_id });
  assert.deepEqual(deliverMeshMessage(dir, changed, opts), {
    status: "rejected", reason: "message_id_conflict", terminal: true,
  });
  assert.equal(posts, 0);
});

test("deliver: legacy unbound receipts stay burned without reprocessing", () => {
  const dir = tmpDir();
  let posts = 0;
  const opts = { selfBoxId: "box-beta", peers: PEERS, now: NOW, post: () => posts++ };
  store.recordSeen(dir, {
    message_id: "legacy-delivered", sender: "box-alpha", outcome: "delivered", hash: "c".repeat(64),
  });
  store.recordSeen(dir, {
    message_id: "legacy-rejected", sender: "box-alpha", outcome: "rejected", reason: "policy_denied",
  });

  assert.equal(deliverMeshMessage(dir, chatEnvelope("changed", { message_id: "legacy-delivered" }), opts).status,
    "duplicate");
  assert.equal(deliverMeshMessage(dir, chatEnvelope("changed", { message_id: "legacy-rejected" }), opts).status,
    "duplicate");
  assert.equal(posts, 0, "a legacy row cannot safely be rebound to new content");
  const repaired = store.readAudit(dir, 10).find((row) => row.message_id === "legacy-delivered");
  assert.deepEqual({
    causal_parent: repaired.causal_parent,
    kind: repaired.kind,
    issued_at: repaired.issued_at,
    expires_at: repaired.expires_at,
  }, { causal_parent: null, kind: null, issued_at: null, expires_at: null },
  "repair never invents original metadata from an unbound retry");
});

test("deliver: audit repair uses the original delivery metadata", () => {
  const dir = tmpDir();
  const opts = { selfBoxId: "box-beta", peers: PEERS, now: NOW, post: () => true };
  const original = chatEnvelope("repair me", { message_id: "repair-original-metadata" });
  assert.equal(deliverMeshMessage(dir, original, opts).status, "delivered");
  fs.unlinkSync(path.join(dir, "audit.jsonl"));

  const retry = chatEnvelope("repair me", {
    message_id: original.message_id,
    now: NOW + 1000,
    causal_parent: "d".repeat(64),
  });
  assert.equal(deliverMeshMessage(dir, retry, opts).status, "duplicate");
  const repaired = store.readAudit(dir, 10)[0];
  assert.deepEqual({
    causal_parent: repaired.causal_parent,
    kind: repaired.kind,
    issued_at: repaired.issued_at,
    expires_at: repaired.expires_at,
  }, {
    causal_parent: original.causal_parent,
    kind: original.kind,
    issued_at: original.issued_at,
    expires_at: original.expires_at,
  });
});

test("deliver: transcript retention still rejects changed content after the seen row is gone", () => {
  const dir = tmpDir();
  const original = chatEnvelope("original retained turn", { message_id: "retained-id-conflict" });
  const first = deliverMeshMessage(dir, original, {
    selfBoxId: "box-beta", peers: PEERS, now: NOW, post: () => true,
  });
  assert.equal(first.status, "delivered");
  fs.unlinkSync(path.join(dir, "seen.jsonl"));
  const durable = transcriptReceipt(original, first.hash);
  const changed = chatEnvelope("changed retained turn", {
    message_id: original.message_id,
    now: NOW - mesh.MAX_TTL_MS - mesh.SKEW_MS - 1,
  });
  const result = deliverMeshMessage(dir, changed, {
    selfBoxId: "box-beta", peers: PEERS, now: NOW,
    lookupTranscript: () => ({ status: "mesh_conflict" }),
    post: () => assert.fail("a retained id is decided before time/causal checks or append"),
  });
  assert.deepEqual(result, { status: "rejected", reason: "message_id_conflict", terminal: true });
  assert.equal(store.seenReceipt(dir, "box-alpha", original.message_id), null,
    "the conflict cannot bind a fresh receipt over the retained turn");
  assert.equal(store.readAudit(dir, 10).filter((row) => row.event === "mesh_delivered").length, 1);
  assert.equal(durable.hash, first.hash);
});

test("deliver: transcript retention restores the original receipt after the seen row is gone", () => {
  const dir = tmpDir();
  const original = chatEnvelope("original retained turn", { message_id: "retained-id-retry" });
  const first = deliverMeshMessage(dir, original, {
    selfBoxId: "box-beta", peers: PEERS, now: NOW, post: () => true,
  });
  assert.equal(first.status, "delivered");
  fs.unlinkSync(path.join(dir, "seen.jsonl"));
  fs.unlinkSync(path.join(dir, "audit.jsonl"));
  store.setLocked(dir, true);
  const durable = transcriptReceipt(original, first.hash);
  const result = deliverMeshMessage(dir, original, {
    selfBoxId: "box-beta", peers: PEERS,
    now: NOW + mesh.MAX_TTL_MS + mesh.SKEW_MS + 1,
    lookupTranscript: () => ({ status: "mesh_duplicate", receipt: durable }),
    post: () => assert.fail("a retained replay is restored before time, lock, causal, or append"),
  });
  assert.equal(result.status, "duplicate");
  assert.equal(result.receipt.hash, first.hash, "the original causal hash wins over the rebuilt retry hash");
  assert.equal(store.seenReceipt(dir, "box-alpha", original.message_id).hash, first.hash,
    "the durable receipt index is restored from transcript truth");
  assert.equal(store.readAudit(dir, 10).filter((row) => row.event === "mesh_delivered").length, 1,
    "the missing original delivery audit is restored exactly once");
});

test("deliver: transcript ids include the full message id and sender identity", () => {
  const dir = tmpDir();
  const peers = { "box-alpha": "secret-alpha", "box-gamma": "secret-gamma" };
  const postedIds = [];
  const signed = (sender, secret, messageId, causalParent = null) => mesh.buildEnvelope({
    now: NOW, message_id: messageId, sender_box: sender, receiver_box: "box-beta", kind: "chat",
    policy: { capability: "chat.post", scope: "mesh" }, causal_parent: causalParent,
    body: { text: "same visible turn" },
  }, secret);
  const opts = {
    selfBoxId: "box-beta", peers, now: NOW,
    post: (_who, _text, postId) => { postedIds.push(postId); return true; },
  };

  const alpha = deliverMeshMessage(dir, signed("box-alpha", "secret-alpha", "shared-id"), opts);
  assert.equal(alpha.status, "delivered");
  assert.equal(deliverMeshMessage(dir, signed("box-gamma", "secret-gamma", "shared-id"), opts).status, "delivered");
  assert.notEqual(postedIds[0], postedIds[1], "two peers cannot collide by choosing the same message id");

  const prefix = "x".repeat(95);
  const first = deliverMeshMessage(dir, signed("box-alpha", "secret-alpha", prefix + "aaaaa", alpha.hash), opts);
  assert.equal(first.status, "delivered");
  const second = deliverMeshMessage(dir, signed("box-alpha", "secret-alpha", prefix + "bbbbb", first.hash), opts);
  assert.equal(second.status, "delivered");
  assert.notEqual(postedIds[2], postedIds[3],
    "same-peer ids that differ only after character 95 must remain distinct transcript ids");
});

test("deliver: LOCKED refuses a valid message and leaves no receipt", () => {
  const dir = tmpDir();
  store.setLocked(dir, true);
  let posts = 0;
  const e = chatEnvelope("while locked");
  const r = deliverMeshMessage(dir, e, { selfBoxId: "box-beta", peers: PEERS, now: NOW, post: () => posts++ });
  assert.equal(r.status, "locked");
  assert.equal(posts, 0);
  assert.equal(store.seenReceipt(dir, "box-alpha", e.message_id), null, "a locked refusal is not a delivery");
  assert.equal(store.readAudit(dir, 100).length, 0,
    "a refused poll must not spend a row in the file that also preserves the causal chain");
});

test("deliver: a message already handled remains a duplicate while LOCKED", () => {
  const dir = tmpDir();
  let posts = 0;
  const envelope = chatEnvelope("already delivered");
  const opts = { selfBoxId: "box-beta", peers: PEERS, now: NOW, post: () => posts++ };
  assert.equal(deliverMeshMessage(dir, envelope, opts).status, "delivered");
  store.setLocked(dir, true);
  assert.equal(deliverMeshMessage(dir, envelope, opts).status, "duplicate");
  assert.equal(posts, 1);
  assert.equal(store.readAudit(dir, 100).length, 1, "the replay adds no lock-refusal noise");
});

test("deliver: a stale signed envelope is recorded once while LOCKED, then deduplicated", () => {
  const dir = tmpDir();
  store.setLocked(dir, true);
  const expired = chatEnvelope("expired", {
    message_id: "expired-while-locked",
    now: NOW - mesh.MAX_TTL_MS - mesh.SKEW_MS - 1,
  });
  const opts = { selfBoxId: "box-beta", peers: PEERS, now: NOW, post: () => assert.fail("must not post") };
  assert.deepEqual(deliverMeshMessage(dir, expired, opts), {
    status: "rejected", reason: "expired", terminal: true,
  });
  for (let i = 0; i < 10; i++) assert.equal(deliverMeshMessage(dir, expired, opts).status, "duplicate");
  assert.equal(store.readAudit(dir, 100).filter((row) => row.event === "mesh_rejected").length, 1);
  assert.equal(store.seenReceipt(dir, "box-alpha", expired.message_id).reason, "expired");
});

test("deliver: a forged/denied message is rejected and never posts", () => {
  const dir = tmpDir();
  let posts = 0;
  const opts = { selfBoxId: "box-beta", peers: PEERS, now: NOW, post: () => posts++ };
  // tampered body after signing
  const forged = chatEnvelope("real"); forged.body = { text: "evil" };
  assert.equal(deliverMeshMessage(dir, forged, opts).reason, "bad_signature");
  // a control-kind message: valid signature, denied by policy
  const control = mesh.buildEnvelope({ now: NOW, sender_box: "box-alpha", receiver_box: "box-beta", kind: "control", policy: { capability: "shell.exec", scope: "mesh" }, body: {} }, "secret-alpha");
  assert.equal(deliverMeshMessage(dir, control, opts).reason, "policy_denied");
  assert.equal(posts, 0, "nothing forged or denied ever reaches the transcript");
});

test("deliver: replay lookup runs AFTER signature verification (red-team #2)", () => {
  const dir = tmpDir();
  const opts = { selfBoxId: "box-beta", peers: PEERS, now: NOW, post: () => {} };
  const e = chatEnvelope("real one");
  assert.equal(deliverMeshMessage(dir, e, opts).status, "delivered");
  // a bare, UNSIGNED envelope reusing the seen id must NOT fish the receipt:
  // it fails signature verification before the replay short-circuit.
  const bareReplay = { message_id: e.message_id, sender_box: "box-alpha" };
  const r = deliverMeshMessage(dir, bareReplay, opts);
  assert.notEqual(r.status, "duplicate", "unsigned replay must not return a receipt");
  assert.ok(r.reason === "bad_signature" || r.reason === "bad_schema", "it is rejected pre-replay");
});

test("deliver: unauthenticated input writes NOTHING to the durable stores (DoS)", () => {
  const dir = tmpDir();
  const opts = { selfBoxId: "box-beta", peers: PEERS, now: NOW, post: () => {} };
  // a flood of malformed/forged requests must not grow the audit or seen files
  for (let i = 0; i < 5; i++) deliverMeshMessage(dir, { message_id: "junk-" + i, sender_box: "box-alpha", signature: "nope" }, opts);
  assert.equal(store.readAudit(dir, 100).length, 0, "no durable audit rows from unauthenticated input");
  assert.equal(store.seenReceipt(dir, "box-alpha", "junk-0"), null, "no seen-index entries from unauthenticated input");
});

test("deliver: a deeply nested envelope is rejected instead of crashing the gate", () => {
  const dir = tmpDir();
  let nested = {};
  for (let i = 0; i < 6000; i++) nested = { a: nested };
  const envelope = {
    schema: mesh.SCHEMA,
    message_id: "deep-policy-attack",
    sender_box: "box-alpha",
    receiver_box: "box-beta",
    issued_at: new Date(NOW).toISOString(),
    expires_at: new Date(NOW + 60000).toISOString(),
    kind: "chat",
    policy: { capability: "chat.post", nested },
    causal_parent: null,
    body: { text: "still a small body" },
    signature: "not-a-valid-signature",
  };
  const opts = { selfBoxId: "box-beta", peers: PEERS, now: NOW, post: () => assert.fail("must not deliver") };
  assert.doesNotThrow(() => deliverMeshMessage(dir, envelope, opts),
    "untrusted nesting must fail closed, never escape the request callback");
  assert.equal(deliverMeshMessage(dir, envelope, opts).reason, "bad_signature");
});

test("deliver: a deeply nested timestamp is rejected before Date.parse can recurse", () => {
  const dir = tmpDir();
  let nested = "date";
  for (let i = 0; i < 10000; i++) nested = [nested];
  const envelope = chatEnvelope("nested date");
  envelope.issued_at = nested;
  const opts = { selfBoxId: "box-beta", peers: PEERS, now: NOW, post: () => assert.fail("must not post") };
  assert.doesNotThrow(() => deliverMeshMessage(dir, envelope, opts));
  assert.equal(deliverMeshMessage(dir, envelope, opts).reason, "bad_issued_at");
});

test("deliver: a transcript failure is never recorded or receipted as delivered", () => {
  const dir = tmpDir();
  const envelope = chatEnvelope("disk is full");
  const failed = deliverMeshMessage(dir, envelope, {
    selfBoxId: "box-beta", peers: PEERS, now: NOW, post: () => false,
  });
  assert.deepEqual(failed, { status: "error", reason: "post_failed" });
  assert.equal(store.seenReceipt(dir, "box-alpha", envelope.message_id), null);
  assert.equal(store.readAudit(dir, 10).filter((row) => row.event === "mesh_delivered").length, 0);
  const retried = deliverMeshMessage(dir, envelope, {
    selfBoxId: "box-beta", peers: PEERS, now: NOW, post: () => true,
  });
  assert.equal(retried.status, "delivered", "the same id remains retryable after storage recovers");
});

// The same DoS invariant, but on the LOCKED path -- which used to audit BEFORE
// authenticating, so it was the one hole left in "unauthenticated input writes
// nothing". Locked is the state a box is in precisely when it is under attack.
test("deliver: unauthenticated input writes NOTHING while LOCKED either", () => {
  const dir = tmpDir();
  store.setLocked(dir, true);
  const opts = { selfBoxId: "box-beta", peers: PEERS, now: NOW, post: () => {} };
  for (let i = 0; i < 5; i++) deliverMeshMessage(dir, { message_id: "junk-" + i, sender_box: "box-alpha", signature: "nope" }, opts);
  assert.equal(store.readAudit(dir, 100).length, 0, "a locked box must not audit anonymous traffic");
  // A real peer gets the refusal, but no row: lock state itself is the durable
  // operator-visible record and audit.jsonl is also the causal chain store.
  const r = deliverMeshMessage(dir, chatEnvelope("while locked"), opts);
  assert.equal(r.status, "locked");
  assert.equal(store.readAudit(dir, 100).length, 0);
});

// The consequence the finding was actually about: audit.jsonl is ALSO the
// causal chain store (knownChainHashes reads it) and it self-prunes to the last
// 5000 rows. So an anonymous audit-flood was not merely noise -- it EVICTED the
// recorded delivery hashes, after which every genuine message is rejected as
// causal_parent_unknown and the two machines can never talk again. This runs
// the real attack volume against the real function.
test("deliver: an authenticated replay flood while LOCKED cannot erase the causal chain", () => {
  const dir = tmpDir();
  const opts = { selfBoxId: "box-beta", peers: PEERS, now: NOW, post: () => {} };
  // A genuine first message, so the box has a chain hash for this peer.
  const first = deliverMeshMessage(dir, chatEnvelope("the real one"), opts);
  assert.equal(first.status, "delivered");
  assert.ok(store.knownChainHashes(dir, "box-alpha").has(first.hash), "the chain starts out known");

  // Now lock the box and replay one genuinely signed, still-new message past
  // the prune threshold (AUDIT_KEEP is 5000, pruned above 2x that).
  store.setLocked(dir, true);
  const blocked = chatEnvelope("blocked but retryable", {
    message_id: "locked-authenticated-replay",
    causal_parent: first.hash,
  });
  for (let i = 0; i < 10100; i++) {
    assert.equal(deliverMeshMessage(dir, blocked, opts).status, "locked");
  }
  store.setLocked(dir, false);

  assert.ok(store.knownChainHashes(dir, "box-alpha").has(first.hash),
    "the delivered hash must survive the flood, or the mesh is permanently deaf");

  // And prove it end-to-end: the next genuine message, quoting that parent,
  // is still accepted. This is the property a row count alone would not catch.
  const second = deliverMeshMessage(dir, blocked, opts);
  assert.equal(second.status, "delivered", "the refused message remains retryable and the chain accepts it after unlock");
});

// ---- source contracts: route + auth wiring ----------------------------------

test("gate: mesh routes are box-to-box, before the cookie wall", () => {
  const meshBefore = gate.indexOf("if (handleMesh(req, res, url)) return;");
  const cookieWall = gate.indexOf("if (!terminalCapabilityRequest && !authed(req)) {", gate.indexOf("if (handleCheckout(req, res, url)) return;"));
  assert.ok(meshBefore !== -1 && meshBefore < cookieWall, "handleMesh runs before the login cookie wall");
});

test("gate: read routes are HMAC-gated, POST runs the contract pipeline", () => {
  const fn = gate.slice(gate.indexOf("function handleMesh"), gate.indexOf("function sendMeshMessage"));
  assert.ok(fn.includes("meshReadAuthed(req, url)"), "reads require the per-peer HMAC proof");
  assert.ok(fn.includes("deliverMeshMessage(MESH_DIR, envelope"), "POST runs the full delivery pipeline");
  assert.ok(fn.includes('sendJson(res, 503, { error: "mesh has no configured peers" })'),
    "no peers configured -> 503, never a crash");
  // the read auth itself is a real HMAC compare, not a placeholder
  const auth = gate.slice(gate.indexOf("function meshReadAuthed"), gate.indexOf("function deliverMeshMessage"));
  assert.ok(auth.includes("crypto.timingSafeEqual"), "read auth is a timing-safe HMAC compare");
  assert.ok(auth.includes("SKEW_MS"), "read auth is replay-bounded by a timestamp within the skew window");
});

test("gate: deny-by-default — only chat.post has a delivery side effect", () => {
  const fn = gate.slice(gate.indexOf("function deliverMeshMessage"), gate.indexOf("function handleMesh"));
  assert.ok(fn.includes('decision.action === "chat_post"'), "the post side effect is gated on the one allowed action");
  // no other action string is wired to a side effect in the delivery fn
  assert.ok(!/action === "(shell|board|state|control)/.test(fn), "no other action reaches a side effect");
});

test("dockerfile: all three mesh modules ship in the image", () => {
  assert.ok(dockerfile.includes("COPY mesh-contract.js /opt/agenthost/mesh-contract.js"));
  assert.ok(dockerfile.includes("COPY mesh-store.js /opt/agenthost/mesh-store.js"));
  assert.ok(dockerfile.includes("COPY mesh-state.js /opt/agenthost/mesh-state.js"));
});

// ---- phase 3: the state stream is cookie-authed and server-authoritative ----

test("gate: the state stream lives on the cookie-authed /cc surface, not the HMAC /mesh routes", () => {
  const cc = gate.slice(gate.indexOf("function handleCommandCenter"), gate.indexOf("function handleCommandCenter") + 1);
  // routes are inside handleCommandCenter, which runs AFTER the cookie wall
  const ccBody = gate.slice(gate.indexOf("function handleCommandCenter"), gate.indexOf("if (handleCommandCenter(req, res, url)) return;"));
  assert.ok(ccBody.includes('url.pathname === "/cc/mesh-state"'), "snapshot route exists on /cc");
  assert.ok(ccBody.includes('url.pathname === "/cc/mesh-state/stream"'), "SSE stream route exists on /cc");
  assert.ok(ccBody.includes('url.pathname === "/cc/mesh-state/lock"'), "lock route exists on /cc");
  const wall = gate.indexOf("if (!terminalCapabilityRequest && !authed(req)) {", gate.indexOf("if (handleCheckout(req, res, url)) return;"));
  const ccCall = gate.indexOf("if (handleCommandCenter(req, res, url)) return;");
  assert.ok(wall !== -1 && ccCall > wall, "the /cc surface is dispatched after the login cookie wall");
});

test("gate: a LOCKED transition is broadcast to every open surface", () => {
  const ccBody = gate.slice(gate.indexOf("function handleCommandCenter"), gate.indexOf("if (handleCommandCenter(req, res, url)) return;"));
  assert.ok(ccBody.includes("if (r.changed) {") && ccBody.includes("broadcastMeshState();"),
    "a real transition pushes to all subscribers");
  const bcast = gate.slice(gate.indexOf("function broadcastMeshState"), gate.indexOf("function broadcastMeshState") + 400);
  assert.ok(bcast.includes("meshStateSubs") && bcast.includes("event: state"),
    "broadcast writes the state event to the subscriber set");
});

test("gate: unlock refuses a stale client (cannot move the server back from LOCKED)", () => {
  const ccBody = gate.slice(gate.indexOf("function handleCommandCenter"), gate.indexOf("if (handleCommandCenter(req, res, url)) return;"));
  assert.ok(ccBody.includes("meshState.canUnlock(meshState.readState(MESH_DIR)"),
    "unlock checks epoch currency via canUnlock (NOT canAct, which could never unlock a locked box)");
  assert.ok(!ccBody.includes("meshState.canAct(meshState.readState(MESH_DIR)"),
    "the canAct-unlock-deadlock bug stays dead");
  assert.ok(ccBody.includes('sendJson(res, 409, { error: "reconnect required"'),
    "a stale unlock is rejected with reconnect, not applied");
});

test("the generated STOP control stays independent of mesh lock state", () => {
  assert.match(operatorView, /pause new is the stop switch/i,
    "the operator surface names the safety control");
  assert.match(operatorView, /changeAutonomy\(false\)/,
    "the control reaches its live mutation");
  assert.doesNotMatch(operatorView, /mesh\?\.state|LOCKED/,
    "mesh lock presentation cannot disable the way out");
});

test("gate: the operator can bootstrap identity without anonymous mesh writes", () => {
  // Pairing needs both box ids before peer traffic can flow. The authenticated
  // /cc route owns that bootstrap; the public mesh router must authenticate
  // before it creates or reads identity state.
  const fn = gate.slice(gate.indexOf("function handleMesh"), gate.indexOf("function sendMeshMessage"));
  const idAt = fn.indexOf("meshStore.boxIdentity(MESH_DIR)");
  const peersGuardAt = fn.indexOf('sendJson(res, 503, { error: "mesh has no configured peers" })');
  const authAt = fn.indexOf("if (!meshReadAuthed(req, url))");
  assert.ok(idAt !== -1 && peersGuardAt !== -1 && authAt !== -1 && idAt > peersGuardAt && idAt > authAt,
    "the public mesh router creates identity only after peer configuration and authentication");
  const ccBody = gate.slice(gate.indexOf("function handleCommandCenter"), gate.indexOf("if (handleCommandCenter(req, res, url)) return;"));
  assert.ok(ccBody.includes('url.pathname === "/cc/mesh-identity"'),
    "the operator can read this box's id from the authenticated dashboard surface");
  const idRoute = ccBody.slice(ccBody.indexOf('url.pathname === "/cc/mesh-identity"'), ccBody.indexOf('url.pathname === "/cc/mesh-identity"') + 900);
  // Peer secrets are never served: the route reports only how MANY peers are
  // configured (a count), never the map's values.
  assert.ok(idRoute.includes("Object.keys(meshPeers()).length"), "peer state is exposed as a count");
  assert.ok(!/Object\.values\(meshPeers|meshPeers\(\)\[/.test(idRoute), "no peer secret value is ever read into the response");
});

test("the generated Mesh surface renders observed LOCKED and unavailable states (Rule 11)", () => {
  assert.match(meshView, /const locked = observedState === "LOCKED"/);
  assert.match(meshView, /problem \? "Mesh unavailable" : locked \? "Mesh locked" : live \? "Mesh live"/,
    "the state is legible without relying on color");
  assert.match(meshView, /Mesh could not be read[\s\S]*\{problem\}/,
    "a lost observation names the read failure");
});

// ---- phase B5: the Box Mesh panel -----------------------------------------

test("mesh panel: reports only what the box RECORDED — no invented liveness", () => {
  const ccBody = gate.slice(gate.indexOf("function handleCommandCenter"), gate.indexOf("if (handleCommandCenter(req, res, url)) return;"));
  const route = ccBody.slice(ccBody.indexOf('url.pathname === "/cc/mesh"'), ccBody.indexOf('url.pathname === "/cc/mesh-identity"'));
  assert.ok(route.includes("lastContactAt"), "reports last contact, a fact it has");
  // Strip comments: the route's own rationale names the thing it refuses to do.
  const code = route.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  assert.ok(!/reachable|isUp|online|ping|probe/i.test(code),
    "must NOT claim a peer is up — this box cannot know that without contacting it");
  assert.ok(route.includes("meshStore.readAudit(MESH_DIR"), "counts come from the durable audit chain");
  assert.ok(route.includes('taskAssociation: "none"'), "says plainly that mesh events carry no task link");
});

test("mesh panel: peer SECRETS are never served, only names", () => {
  const ccBody = gate.slice(gate.indexOf("function handleCommandCenter"), gate.indexOf("if (handleCommandCenter(req, res, url)) return;"));
  const route = ccBody.slice(ccBody.indexOf('url.pathname === "/cc/mesh"'), ccBody.indexOf('url.pathname === "/cc/mesh-identity"'));
  assert.ok(route.includes("Object.keys(meshPeers())"), "peer NAMES only");
  assert.ok(!/Object\.values\(meshPeers|meshPeers\(\)\[/.test(route), "no secret value is ever read into the response");
});

test("mesh panel: a reachable generated surface renders it (Rule 11)", () => {
  assert.match(dashboardApi, /return getJson\("\/cc\/mesh"\)/,
    "the generated client consumes the endpoint");
  assert.match(meshView, /No peers configured/,
    "an unpaired box says so instead of rendering an empty table");
  assert.match(meshView, /Mesh could not be read/,
    "a failed fetch says unavailable, never a blank panel");
  assert.match(meshView, /The causal chain between this box and its peers/,
    "the panel explains the observed chain");
  assert.match(gate, /reason: "causal_parent_unknown"/,
    "and the server actually enforces unknown-parent rejection");
});

// ---- the board page (/kanban) ----------------------------------------------

test("board entry is served by the one generated shell", () => {
  assert.match(gate, /const SHELL_ENTRY_PATHS = new Set\(\[[\s\S]*?"\/kanban"[\s\S]*?\]\)/,
    "the compatibility URL reaches the generated shell");
  assert.doesNotMatch(gate, /const KANBAN_HTML\b/, "the runtime no longer loads a second board document");
  const dockerfile = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "Dockerfile"), "utf8");
  assert.ok(!dockerfile.includes("COPY kanban.html /opt/agenthost/kanban.html"), "the legacy board document is not shipped");
});

test("board page: reads the SAME /board projection — no second source of truth", () => {
  assert.match(dashboardApi, /return getJson\("\/board"\)/,
    "consumes the canonical projection");
  assert.match(boardView, /board\.columns\[lane\.id\]/,
    "every generated lane derives from that projection");
  assert.doesNotMatch(boardView, /hermes kanban|kanban list/,
    "never queries the board CLI itself");
});

test("board page exposes the server's awaiting lane without inventing another queue", () => {
  assert.match(boardView, /const FLOW: LaneId\[\] = \["queued", "running", "awaiting", "review", "done", "blocked"\]/);
  assert.match(boardView, /board\.columns\[lane\.id\]/);
});

test("board page: every card is deep-linkable so a push can land on it", () => {
  assert.match(dashboardApi, /return `\$\{BASE\}\/\?task=\$\{encodeURIComponent\(id\)\}`/,
    "the canonical helper builds an encoded task link");
  assert.match(commandCenter, /new URLSearchParams\(window\.location\.search\)/);
  assert.match(commandCenter, /const wanted = params\.get\("task"\)/);
  assert.match(commandCenter, /setOpenTask\(hit\)/,
    "the deep link opens the generated task detail");
  assert.match(gate, /url: "\/\?task=" \+ encodeURIComponent\(String\(task\.id\)\)/,
    "task pushes deep-link to the generated shell");
});

test("board page: an unavailable board says so rather than showing an empty board", () => {
  assert.match(boardView, /board is unavailable on the box right now/i,
    "explicit unavailable copy");
  assert.match(boardView, /shownBoard\.available === false/,
    "honours the projection's own availability flag");
});

// ---- hardening: LOCKED is a data barrier, and the chain is enforced --------

test("hardening: LOCKED refuses sensitive reads server-side (423), not just dims", () => {
  // Phase 3 only SIGNALLED locked; the server still served every value, so a
  // client that lost authority could still hold live box data.
  const ccBody = gate.slice(gate.indexOf("function handleCommandCenter"), gate.indexOf("if (handleCommandCenter(req, res, url)) return;"));
  assert.ok(ccBody.includes("meshState.isLocked(MESH_DIR)"), "the sensitive reads are gated on the lock");
  assert.ok(ccBody.includes("(state|inventory|mesh)"), "and the gate covers state, inventory and mesh");
  assert.match(ccBody, /sendJson\(res, 423, \{[\s\S]{0,80}error: "locked"/, "and refused with 423");
  assert.match(ccBody, /audit\("cc_read_refused_locked"/, "each refusal is audited");
});

test("hardening: LOCKED never blocks the way OUT of locked, or the STOP switch", () => {
  const ccBody = gate.slice(gate.indexOf("function handleCommandCenter"), gate.indexOf("if (handleCommandCenter(req, res, url)) return;"));
  const guard = ccBody.slice(ccBody.indexOf("meshState.isLocked(MESH_DIR)"), ccBody.indexOf("meshState.isLocked(MESH_DIR)") + 400);
  // mesh-state (how a client learns it is locked and unlocks) must NOT match.
  assert.ok(!/mesh-state/.test(guard), "the state stream and unlock route stay reachable while locked");
  assert.ok(!/autonomy/.test(guard), "the STOP/autonomy controls stay reachable while locked");
});

test("hardening: the generated Mesh UI refuses publishing while LOCKED", () => {
  assert.match(meshView, /const canPublish = Boolean\(mesh && live && !problem/,
    "a locked snapshot cannot enable the mutation");
  assert.match(meshView, /locked \? "this box is locked"/,
    "a race from review to submit names the lock as the cause");
});

test("hardening: a fabricated causal parent is rejected, a first message is not", () => {
  const fn = gate.slice(gate.indexOf("function deliverMeshMessage"), gate.indexOf("function handleMesh"));
  assert.match(fn, /meshStore\.knownChainHashes\(dir, sender\)/, "the parent is checked against recorded hashes");
  assert.match(fn, /claimedParent === null \? known\.size === 0 : known\.has\(claimedParent\)/,
    "null is valid ONLY as a genuinely first message; otherwise the parent must be known");
  // and it must NOT be strict last-hash equality, which would reject legitimate
  // concurrent traffic between two boxes each advancing their own chain
  assert.ok(!/claimedParent !== expectedParent/.test(fn), "not strict last-hash equality");
});

// ---- unauthenticated remote crash via inherited object keys ----------------
// A plain object inherits Object.prototype, so meshPeers()["constructor"] was a
// truthy FUNCTION. meshReadAuthed's `if (!secret)` guard passed, and
// crypto.createHmac threw on a non-string key. There is no try/catch around the
// request listener and no uncaughtException handler, so the gate EXITED — one
// anonymous GET /mesh/identity took the whole box down, repeatedly.
// These call the REAL meshPeers() and meshReadAuthed() out of gate.js. The
// previous version asserted on the source text and then rebuilt the map with a
// COPY of the implementation inlined in the test -- which proves the copy is
// safe, not the shipped function. A copy cannot regress when the original does.
function withPeers(raw, fn) {
  const prev = process.env.AGENTHOST_MESH_PEERS;
  process.env.AGENTHOST_MESH_PEERS = raw;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.AGENTHOST_MESH_PEERS;
    else process.env.AGENTHOST_MESH_PEERS = prev;
  }
}
const ATTACK_KEYS = ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf"];

test("an inherited object key cannot be mistaken for a peer secret", () => {
  withPeers('{"box-alpha":"secret-alpha"}', () => {
    const map = meshPeers();
    assert.equal(map["box-alpha"], "secret-alpha", "a real peer still resolves");
    for (const key of ATTACK_KEYS) {
      assert.ok(!map[key], key + " must not resolve to anything");
      assert.doesNotThrow(() => { if (map[key]) crypto.createHmac("sha256", map[key]); },
        key + " must never reach createHmac");
    }
  });
  // A non-string secret in the JSON is dropped rather than passed through.
  withPeers('{"box-beta":{"nested":"object"}}', () => assert.ok(!meshPeers()["box-beta"]));
  withPeers('{"box-beta":12345}', () => assert.ok(!meshPeers()["box-beta"]));
  withPeers("not json at all", () => assert.deepEqual(Object.keys(meshPeers()), []));
  withPeers('["an","array"]', () => assert.deepEqual(Object.keys(meshPeers()), []));
});

// The crash itself, through the real auth function. meshReadAuthed is what the
// anonymous GET actually reached; a source assertion could never prove it stops
// throwing, and a throw here EXITS the gate (no try/catch around the request
// listener, no uncaughtException handler) -- taking terminal, chat, Command
// Center and the phone view down with it.
test("an anonymous request with a prototype key is refused, not crashed", () => {
  withPeers('{"box-alpha":"secret-alpha"}', () => {
    const url = new URL("https://box.example/mesh/identity");
    for (const key of ATTACK_KEYS) {
      const req = { headers: { "x-mesh-box": key, "x-mesh-ts": String(Date.now()), "x-mesh-sig": "deadbeef" } };
      let out;
      assert.doesNotThrow(() => { out = meshReadAuthed(req, url); }, key + " must not throw out of the gate");
      assert.equal(out, false, key + " must not authenticate");
    }
    // A request with no mesh headers at all is simply refused.
    assert.equal(meshReadAuthed({ headers: {} }, url), false);
  });
});

test("a correctly signed read still authenticates, and a tampered one does not", () => {
  withPeers('{"box-alpha":"secret-alpha"}', () => {
    const url = new URL("https://box.example/mesh/since?after=5");
    const ts = Date.now();
    const sign = (p, box, t) => crypto.createHmac("sha256", "secret-alpha")
      .update("GET " + p + " " + box + " " + t).digest("hex");
    const ok = { headers: { "x-mesh-box": "box-alpha", "x-mesh-ts": String(ts), "x-mesh-sig": sign("/mesh/since?after=5", "box-alpha", ts) } };
    assert.equal(meshReadAuthed(ok, url), true, "the real signing recipe must still pass");
    assert.equal(meshReadAuthed(ok, new URL("https://box.example/mesh/since?after=6")), false,
      "the signed proof cannot be replayed with a different cursor");
    // Wrong secret, wrong path, and a stale timestamp are each refused.
    const badSig = { headers: { ...ok.headers, "x-mesh-sig": sign("/mesh/identity", "box-alpha", ts) } };
    assert.equal(meshReadAuthed(badSig, url), false, "a signature for another path must not pass");
    const stale = ts - 10 * 60 * 1000;
    const old = { headers: { "x-mesh-box": "box-alpha", "x-mesh-ts": String(stale), "x-mesh-sig": sign("/mesh/since?after=5", "box-alpha", stale) } };
    assert.equal(meshReadAuthed(old, url), false, "outside the skew window it is replay, not auth");
  });
});

// ---- /mesh/since: the READ half of the pipe (phase C) -----------------------
// A peer that cannot be pushed to (a desktop behind NAT that sleeps) asks the
// box what it has said since it last looked. The paging is pure, so these run
// it for real rather than asserting on the shape of the source.

test("mesh/since returns entries after the cursor, oldest first", () => {
  const { meshSincePage } = gateLib;
  const thread = [
    { at: 300, who: "claude", text: "third" },
    { at: 100, who: "steve", text: "first" },
    { at: 200, who: "codex", text: "second" },
  ];
  const page = meshSincePage(thread, 100);
  assert.deepEqual(page.entries.map((e) => e.text), ["second", "third"],
    "strictly after the cursor, in the order they happened");
  assert.equal(page.nextAfter, 300);
  assert.equal(page.remaining, 0);
});

test("mesh/since pages a backlog instead of dumping it", () => {
  const { meshSincePage } = gateLib;
  const thread = Array.from({ length: 500 }, (_, i) => ({ at: 1000 + i, who: "claude", text: "m" + i }));
  const first = meshSincePage(thread, 0, 2);
  assert.equal(first.entries.length, 2);
  assert.equal(first.remaining, 498, "the peer is told there is more, so it keeps paging");
  const next = meshSincePage(thread, first.nextAfter, 2);
  assert.equal(next.entries[0].text, "m2", "paging resumes exactly where it stopped");

  // An absurd limit is capped, so one call can never return an unbounded page.
  assert.equal(meshSincePage(thread, 0, 99999).entries.length, 200);
  assert.equal(meshSincePage(thread, 0).entries.length, 200, "and the default is the cap");
});

test("mesh/since catch-up skips a self-echo tail without leaving the cursor behind", () => {
  const thread = Array.from({ length: 210 }, (_, i) => ({
    meshSeq: i + 1,
    at: 1000 + i,
    who: i < 205 ? "claude" : "box:desktop-1",
    text: "message-" + (i + 1),
    id: "message-" + (i + 1),
  }));

  const page = meshSincePage(thread, 0, 200, 0, 0, "desktop-1", null);
  assert.equal(page.entries.length, 200, "the compatibility page remains available to older desktops");
  assert.deepEqual(page.catchup.entries.map((entry) => entry.text),
    ["message-201", "message-202", "message-203", "message-204", "message-205"],
    "the bounded catch-up contains the latest five NON-self turns");
  assert.deepEqual({
    scanned: page.catchup.scanned,
    total: page.catchup.total,
    omitted: page.catchup.omitted,
    nextAfter: page.catchup.nextAfter,
    nextOffset: page.catchup.nextOffset,
    nextSeq: page.catchup.nextSeq,
  }, {
    scanned: 210,
    total: 205,
    omitted: 200,
    nextAfter: 1209,
    nextOffset: 1,
    nextSeq: 210,
  }, "the catch-up cursor advances across the suppressed self-echo tail");
  assert.match(page.catchup.nextAnchor, /^[0-9a-f]{64}$/);
});

test("mesh/since retains recent history without feeding it all into agent prompts", () => {
  const dir = tmpDir();
  const file = path.join(dir, "team-thread.jsonl");
  const recentStart = NOW - MESH_THREAD_RETENTION_MS + 1000;
  const recent = Array.from({ length: 260 }, (_, i) => ({
    at: recentStart + i,
    who: "claude",
    text: "recent-" + i,
    id: "recent-" + i,
  }));
  fs.writeFileSync(file, recent.map((e) => JSON.stringify(e)).join("\n") + "\n");

  assert.equal(readTeamThreadFile(file, TEAM_THREAD_KEEP).length, 120,
    "agent prompts keep their existing 120-entry context window");
  const meshHistory = readTeamThreadFile(file);
  assert.equal(meshHistory.length, 260, "the mesh can still catch up through retained recent history");
  const first = meshSincePage(meshHistory, 0);
  const second = meshSincePage(meshHistory, first.nextAfter, undefined, first.nextOffset);
  assert.equal(first.entries.length, 200);
  assert.equal(first.remaining, 60);
  assert.equal(second.entries.length, 60);
  assert.equal(second.entries.at(-1).text, "recent-259");

  const old = Array.from({ length: 150 }, (_, i) => JSON.stringify({
    at: NOW - MESH_THREAD_RETENTION_MS - 1000 - i,
    who: "claude",
    text: "old-" + i,
  }));
  const kept = retainedTeamThreadLines([...old, ...recent.map((e) => JSON.stringify(e))], NOW);
  assert.equal(kept.length, 260, "pruning prefers recent entries before applying its floor and caps");
  assert.ok(kept.every((line) => !line.includes('"old-')));
});

test("mesh/since pages tied milliseconds without skipping or breaking the cap", () => {
  const thread = [
    { at: 100, who: "claude", text: "first" },
    { at: 200, who: "claude", text: "same-ms-a" },
    { at: 200, who: "codex", text: "same-ms-b" },
    { at: 300, who: "hermes", text: "last" },
  ];
  const first = meshSincePage(thread, 0, 2, 0);
  assert.deepEqual(first.entries.map((e) => e.text), ["first", "same-ms-a"]);
  assert.equal(first.entries.length, 2, "the advertised page cap stays a hard cap");
  assert.equal(first.nextAfter, 200);
  assert.equal(first.nextOffset, 1, "the cursor records how much of the tied millisecond was consumed");
  const second = meshSincePage(thread, first.nextAfter, 2, first.nextOffset);
  assert.deepEqual(second.entries.map((e) => e.text), ["same-ms-b", "last"],
    "the rest of the tied millisecond is delivered on the next page");

  const hugeTie = Array.from({ length: 5000 }, (_, i) => ({ at: 400, who: "claude", text: "tie-" + i }));
  const capped = meshSincePage(hugeTie, 0, 200, 0);
  assert.equal(capped.entries.length, 200, "a pathological tie still cannot expand the response cap");
  assert.equal(capped.nextOffset, 200);
  assert.equal(capped.remaining, 4800);
});

test("mesh/since can deliver a late append at the cursor's same millisecond", () => {
  const before = [
    { at: 100, who: "claude", text: "first" },
    { at: 200, who: "claude", text: "same-ms-a" },
    { at: 200, who: "codex", text: "same-ms-b" },
  ];
  const first = meshSincePage(before, 0, 2, 0);
  const afterAppend = [...before, { at: 200, who: "hermes", text: "late-same-ms" }];
  const second = meshSincePage(afterAppend, first.nextAfter, 2, first.nextOffset);
  assert.deepEqual(second.entries.map((e) => e.text), ["same-ms-b", "late-same-ms"],
    "an entry appended after page one must not vanish behind a timestamp-only cursor");
});

test("mesh/since floors fractional limits instead of crashing on a fractional array index", () => {
  const thread = [
    { at: 100, who: "claude", text: "first" },
    { at: 200, who: "codex", text: "second" },
  ];
  assert.doesNotThrow(() => meshSincePage(thread, 0, 1.5, 0));
  assert.equal(meshSincePage(thread, 0, 1.5, 0).entries.length, 1);
});

test("mesh/since sequence paging cannot be jumped by a future display timestamp", () => {
  const thread = [
    { meshSeq: 1, at: 9999999999999, who: "claude", text: "future clock" },
    { meshSeq: 2, at: 100, who: "codex", text: "said later with a normal clock" },
  ];
  const first = meshSincePage(thread, 0, 1, 0, 0);
  const second = meshSincePage(thread, first.nextAfter, 1, first.nextOffset, first.nextSeq,
    "desktop-1", first.nextAnchor);
  assert.deepEqual(first.entries.map((e) => e.text), ["future clock"]);
  assert.deepEqual(second.entries.map((e) => e.text), ["said later with a normal clock"]);
  assert.equal(second.nextSeq, 2);
});

test("mesh/since resets a cursor above a restored box's current sequence", () => {
  const restored = [
    { meshSeq: 1, at: 100, who: "claude", text: "restored first" },
    { meshSeq: 2, at: 200, who: "codex", text: "restored second" },
  ];
  const page = meshSincePage(restored, 9000, 200, 4, 99, "desktop-1", "d".repeat(64));
  assert.equal(page.sequenceReset, true);
  assert.deepEqual(page.entries.map((entry) => entry.text), ["restored first", "restored second"]);
  assert.equal(page.nextSeq, 2, "the replacement history starts a lower durable sequence");
  assert.match(page.nextAnchor, /^[0-9a-f]{64}$/);
});

test("mesh/since resets when a restored box reuses the cursor sequence for different content", () => {
  const before = [
    { meshSeq: 1, at: 100, who: "claude", text: "old sequence one" },
    { meshSeq: 2, at: 200, who: "codex", text: "old sequence two" },
  ];
  const prior = meshSincePage(before, 0, 1, 0, 0, "desktop-1", null);
  const restored = [
    { meshSeq: 1, at: 300, who: "hermes", text: "replacement sequence one" },
    { meshSeq: 2, at: 400, who: "claude", text: "replacement sequence two" },
  ];
  const page = meshSincePage(restored, prior.nextAfter, 200, prior.nextOffset,
    prior.nextSeq, "desktop-1", prior.nextAnchor);
  assert.equal(page.sequenceReset, true);
  assert.deepEqual(page.entries.map((entry) => entry.text),
    ["replacement sequence one", "replacement sequence two"],
    "the reused seq cannot hide replacement history behind the old anchor");
});

test("mesh/since resets when restored history changes before an identical cursor row", () => {
  const before = [
    { meshSeq: 1, at: 100, who: "claude", text: "one" },
    { meshSeq: 2, at: 200, who: "codex", text: "old two" },
    { meshSeq: 3, at: 300, who: "hermes", text: "same cursor row" },
  ];
  const prior = meshSincePage(before, 0, 200, 0, 0, "desktop-1", null);
  const restored = [
    { meshSeq: 1, at: 100, who: "claude", text: "one" },
    { meshSeq: 2, at: 250, who: "codex", text: "replacement two" },
    { meshSeq: 3, at: 300, who: "hermes", text: "same cursor row" },
    { meshSeq: 4, at: 400, who: "claude", text: "four" },
  ];
  const page = meshSincePage(restored, prior.nextAfter, 200, prior.nextOffset,
    prior.nextSeq, "desktop-1", prior.nextAnchor);
  assert.equal(page.sequenceReset, true);
  assert.deepEqual(page.entries.map((entry) => entry.text),
    ["one", "replacement two", "same cursor row", "four"],
    "the cursor anchor proves the full retained prefix, not only the cursor row");
});

test("mesh/since safely replays a nonzero sequence cursor that has no anchor", () => {
  const history = [
    { meshSeq: 1, at: 100, who: "claude", text: "one" },
    { meshSeq: 2, at: 200, who: "codex", text: "two" },
  ];
  const page = meshSincePage(history, 200, 200, 1, 2, "desktop-1", null);
  assert.equal(page.sequenceReset, true);
  assert.deepEqual(page.entries.map((entry) => entry.text), ["one", "two"]);
});

test("mesh/since never serves an entry whose timestamp cannot advance the cursor", () => {
  const { meshSincePage } = gateLib;
  const page = meshSincePage([
    { who: "ghost", text: "no timestamp" },
    { at: 500, who: "claude", text: "real" },
  ], 0);
  assert.deepEqual(page.entries.map((e) => e.text), ["real"],
    "an untimestamped entry would be re-served forever, since the cursor could never pass it");
  assert.equal(page.nextAfter, 500);
});

test("mesh/since on an empty or fully-consumed thread leaves the cursor where it was", () => {
  const { meshSincePage } = gateLib;
  assert.deepEqual(meshSincePage([], 0), {
    entries: [], nextAfter: 0, nextOffset: 0, nextSeq: null, nextAnchor: null, remaining: 0,
  });
  const page = meshSincePage([{ at: 100, who: "claude", text: "old" }], 100);
  assert.deepEqual(page.entries, []);
  assert.equal(page.nextAfter, 100, "no messages must not rewind the peer's cursor");
});

// ---- the /mesh/since DECISION, run rather than grepped ----------------------
// This replaces a set of assert.match() calls over the text of gate.js. Those
// could only prove a word was still present, so a deliberate re-break of the
// fix they guarded passed every one of them. meshSinceDecision is the same
// function the live route calls, so these run the real gate order.

function decide(over) {
  const calls = { rate: 0, thread: 0, chain: 0 };
  const out = meshSinceDecision({
    authed: true, locked: false, rawAfter: null, rawLimit: null, boxId: "box-beta",
    takeRateSlot: () => { calls.rate++; return { allowed: true, retryAfterSeconds: 0 }; },
    loadThread: () => { calls.thread++; return over && over.thread ? over.thread : []; },
    loadChain: () => { calls.chain++; return over && over.chain ? over.chain : []; },
    ...(over || {}),
  });
  return { out, calls };
}

test("mesh/since: an unauthenticated read is refused, audited, and costs nothing", () => {
  const { out, calls } = decide({ authed: false });
  assert.equal(out.code, 401);
  assert.deepEqual(out.body, { error: "mesh auth required" });
  assert.equal(out.auditEvent, "mesh_auth_fail", "a failed read auth is still worth a record");
  assert.equal(calls.rate, 0, "anonymous traffic must not consume a configured peer's quota");
  assert.equal(calls.thread, 0, "an anonymous caller must never make the box read the transcript");
  assert.equal(calls.chain, 0, "nor the audit file");
});

test("mesh/since: LOCKED refuses the read, and does NOT disclose lock state to a stranger", () => {
  const locked = decide({ locked: true });
  assert.equal(locked.out.code, 423, "the lock stops the conversation LEAVING the box too");
  assert.equal(locked.calls.rate, 0, "a locked poll does not consume the first post-unlock read");
  assert.equal(locked.calls.thread, 0, "a locked box must not serve or even load the thread");
  assert.ok(!locked.out.auditEvent, "a refused poll must not spend an audit row — that file IS the chain store");

  // Auth is decided BEFORE lock, so an anonymous caller cannot tell a locked
  // box from an unlocked one: both answer 401, never 423.
  const anonLocked = decide({ authed: false, locked: true });
  assert.equal(anonLocked.out.code, 401, "authenticate first, then disclose lock state");
});

test("mesh/since: a bad cursor is a 400, and an absent one means from the beginning", () => {
  for (const bad of ["-1", "abc", "NaN", "Infinity", "1e999"]) {
    const { out, calls } = decide({ rawAfter: bad });
    assert.equal(out.code, 400, bad + " is not a millisecond timestamp");
    assert.equal(calls.rate, 0, "invalid input does not consume a valid peer's quota");
  }
  for (const empty of [null, undefined, "", "   "]) {
    const { out } = decide({ rawAfter: empty, thread: [{ at: 5, who: "claude", text: "hi" }] });
    assert.equal(out.code, 200);
    assert.equal(out.body.entries.length, 1, "a missing cursor serves from the beginning");
  }
  for (const bad of ["-1", "1.5", "abc", "Infinity"]) {
    assert.equal(decide({ rawOffset: bad }).out.code, 400, bad + " is not a valid tie offset");
  }
  for (const bad of ["-1", "1.5", "abc", "9007199254740992"]) {
    assert.equal(decide({ rawSeq: bad }).out.code, 400, bad + " is not a valid sequence cursor");
  }
});

test("mesh/since: a history read failure returns 503 instead of escaping the gate", () => {
  const out = meshSinceDecision({
    authed: true, locked: false, rawAfter: null, rawLimit: null, rawOffset: null, rawSeq: "0",
    boxId: "box-beta", takeRateSlot: () => ({ allowed: true, retryAfterSeconds: 0 }),
    loadThread: () => { throw new Error("disk failed"); }, loadChain: () => [],
  });
  assert.equal(out.code, 503);
  assert.deepEqual(out.body, { error: "mesh history unavailable" });
});

test("mesh/since: an authenticated read pages the thread and reports the peer's own chain head", () => {
  const { out, calls } = decide({
    rawAfter: "100", rawLimit: "1",
    thread: [{ at: 100, who: "a", text: "old" }, { at: 200, who: "b", text: "mid" }, { at: 300, who: "c", text: "new" }],
    chain: ["hash-one", "hash-two"],
  });
  assert.equal(out.code, 200);
  assert.equal(calls.rate, 1);
  assert.equal(calls.thread, 1);
  assert.deepEqual(out.body.entries.map((e) => e.text), ["mid"], "strictly after the cursor, capped by limit");
  assert.equal(out.body.nextAfter, 200);
  assert.equal(out.body.remaining, 1, "the peer is told to keep paging");
  assert.equal(out.body.chainHead, "hash-two", "the LAST hash recorded for this peer");
  assert.equal(out.body.boxId, "box-beta");
});

test("mesh/since: no chain for this peer reports null, which is a real answer", () => {
  // The desktop CLEARS its stale head on null (room.js), so this must be null
  // and never simply absent — an omitted field means "the box did not say".
  const { out } = decide({ chain: [] });
  assert.equal(out.body.chainHead, null);
  assert.ok(Object.prototype.hasOwnProperty.call(out.body, "chainHead"),
    "chainHead must always be present, so the peer can distinguish null from missing");
});

test("mesh/since: the cooldown is per peer, has no burst, and denial never extends it", () => {
  const slots = new Map();
  const t0 = 1_000_000;
  assert.deepEqual(meshSinceRateGate(slots, "box-alpha", t0), { allowed: true, retryAfterSeconds: 0 });
  assert.deepEqual(meshSinceRateGate(slots, "box-alpha", t0 + 1), {
    allowed: false, retryAfterSeconds: 15,
  });
  assert.deepEqual(meshSinceRateGate(slots, "box-beta", t0 + 1), { allowed: true, retryAfterSeconds: 0 },
    "one paired box cannot spend another box's read slot");
  assert.equal(meshSinceRateGate(slots, "box-alpha", t0 + MESH_SINCE_COOLDOWN_MS - 1).allowed, false,
    "a denied replay must not push the original deadline forward");
  assert.deepEqual(meshSinceRateGate(slots, "box-alpha", t0 + MESH_SINCE_COOLDOWN_MS), {
    allowed: true, retryAfterSeconds: 0,
  }, "the ordinary 20-second desktop poll remains comfortably outside the cooldown");
  meshSinceRateGate(slots, "box-gamma", t0 + MESH_SINCE_COOLDOWN_MS + 1);
  assert.equal(slots.has("box-beta"), false, "inactive expired peers are pruned from the bounded map");
});

test("mesh/since: rate denial happens before either expensive history read", () => {
  const denied = decide({
    takeRateSlot: () => ({ allowed: false, retryAfterSeconds: 7 }),
  });
  assert.deepEqual(denied.out, {
    code: 429,
    body: { error: "too many mesh history requests" },
    retryAfterSeconds: 7,
  });
  assert.equal(denied.calls.thread, 0);
  assert.equal(denied.calls.chain, 0);

  for (const takeRateSlot of [undefined, () => { throw new Error("limiter failed"); }]) {
    const out = meshSinceDecision({
      authed: true, locked: false, rawAfter: null, rawLimit: null,
      boxId: "box-beta", takeRateSlot, loadThread: () => assert.fail("must not read"),
      loadChain: () => assert.fail("must not read"),
    });
    assert.equal(out.code, 503, "a missing or failed limiter must fail closed");
  }
});

test("the /mesh/since route wires the real decision, and the read half never writes", () => {
  // The one thing that genuinely cannot be run without booting the gate: that
  // the ROUTE delegates to the function tested above rather than re-deciding.
  const handleMeshAt = gate.indexOf("function handleMesh");
  const from = gate.indexOf('if (req.method === "GET" && url.pathname === "/mesh/since")', handleMeshAt);
  assert.ok(from > 0, "the route must exist");
  const next = gate.indexOf("if (url.pathname ===", from + 50);
  const block = gate.slice(from, next > from ? next : from + 2000);
  assert.match(block, /meshSinceDecision\(\{/, "the route must delegate to the tested decision");
  const beforeRoute = gate.slice(handleMeshAt, from);
  assert.match(beforeRoute, /if \(!meshReadAuthed\(req, url\)\)/, "the real HMAC check runs before any identity or history read");
  assert.match(block, /authed: true/, "the decision receives the already-proven HMAC result");
  assert.match(block, /locked: meshStore\.isLocked\(MESH_DIR\)/, "and the real lock state");
  assert.match(block, /takeRateSlot:/, "and a per-peer rate slot before loading history");
  assert.match(block, /Retry-After/, "a throttled peer is told when its next poll is safe");
  assert.ok(!/appendTeamThread|writeFileSync/.test(block), "the read half must never write");
});
