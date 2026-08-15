// Box Mesh durable store (mesh-store.js) — phase 1 acceptance gates:
//   - identity is created once and stable across "reboots" (re-reads)
//   - replay protection SURVIVES restart (the on-disk index is the whole point)
//   - one delivered message -> one audit record with one causal-parent link
//   - LOCKED refusal is server-side file state
//   - audit records never contain secret values
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as store from "../container/mesh-store.js";
import * as mesh from "../container/mesh-contract.js";

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "mesh-store-")); }

test("store: box identity is created once and stable forever after", () => {
  const dir = tmpDir();
  const a = store.boxIdentity(dir);
  const b = store.boxIdentity(dir); // simulated reboot: fresh read, same disk
  assert.match(a.boxId, /^box-[0-9a-f]{12}$/);
  assert.equal(a.boxId, b.boxId, "identity must not change across restarts");
});

test("store: replay protection survives a restart, scoped per sender", () => {
  const dir = tmpDir();
  assert.equal(store.seenReceipt(dir, "box-a", "msg-1"), null);
  store.recordSeen(dir, { message_id: "msg-1", sender: "box-a", outcome: "delivered", hash: "a".repeat(64) });
  // "restart": nothing held in memory between calls -- a second read hits disk
  const replay = store.seenReceipt(dir, "box-a", "msg-1");
  assert.equal(replay.outcome, "delivered");
  assert.equal(replay.hash, "a".repeat(64));
  assert.equal(store.seenReceipt(dir, "box-a", "msg-2"), null, "other ids stay unseen");
  // the key is scoped to the sender: a different peer with the SAME id does not
  // collide (red-team 2026-07-31).
  assert.equal(store.seenReceipt(dir, "box-b", "msg-1"), null, "another peer's identical id is not a hit");
});

test("store: LOCKED is file-backed server authority", () => {
  const dir = tmpDir();
  assert.equal(store.isLocked(dir), false);
  assert.equal(store.setLocked(dir, true), true);
  assert.equal(store.isLocked(dir), true);
  assert.equal(store.setLocked(dir, false), true);
  assert.equal(store.isLocked(dir), false);
});

test("store: audit chain links causally per peer pair", () => {
  const dir = tmpDir();
  assert.equal(store.lastChainHash(dir, "box-alpha"), null);
  const h1 = "1".repeat(64), h2 = "2".repeat(64), other = "9".repeat(64);
  store.auditMesh(dir, { event: "mesh_delivered", direction: "in", peer: "box-alpha", message_id: "m1", hash: h1 });
  store.auditMesh(dir, { event: "mesh_delivered", direction: "in", peer: "box-other", message_id: "mx", hash: other });
  store.auditMesh(dir, { event: "mesh_delivered", direction: "out", peer: "box-alpha", message_id: "m2", hash: h2, causal_parent: h1 });
  assert.equal(store.lastChainHash(dir, "box-alpha"), h2, "newest hash for the pair");
  assert.equal(store.lastChainHash(dir, "box-other"), other, "pairs chain independently");
  const rows = store.readAudit(dir, 10);
  assert.equal(rows.length, 3);
  assert.equal(rows[2].causal_parent, h1, "the delivered record links its causal parent");
});

test("store: audit records are field-whitelisted — secrets cannot ride through", () => {
  const dir = tmpDir();
  const row = store.auditMesh(dir, {
    event: "mesh_rejected", peer: "box-alpha", message_id: "m3", reason: "bad_signature",
    // a hostile/buggy caller passing extra fields must not see them persisted
    secret: "hunter2", authorization: "Bearer abc", envelope: { signature: "sig", body: { token: "tok" } },
  });
  const raw = fs.readFileSync(path.join(dir, "audit.jsonl"), "utf8");
  assert.ok(!raw.includes("hunter2") && !raw.includes("Bearer") && !raw.includes("tok"),
    "no unlisted field reaches disk");
  assert.equal(row.reason, "bad_signature");
});

test("store + contract: full local delivery pipeline — one delivery, one audit record, idempotent replay", () => {
  const dir = tmpDir();
  const peers = { "box-alpha": "secret-alpha" };
  const NOW = Date.parse("2026-07-31T12:00:00Z");
  const e = mesh.buildEnvelope({
    now: NOW, sender_box: "box-alpha", receiver_box: "box-beta", kind: "chat",
    policy: { capability: "chat.post", scope: "transcript" }, body: { text: "hi" },
  }, "secret-alpha");

  // Narrow store/contract composition smoke test. The authoritative delivery
  // order and LOCKED behavior run through deliverMeshMessage in mesh-gate.test.
  function deliver(envelope) {
    const fingerprint = mesh.messageFingerprint(envelope);
    const prior = store.seenReceipt(dir, envelope.sender_box, envelope.message_id);
    if (prior) {
      if (prior.fingerprint && prior.fingerprint !== fingerprint) {
        return { status: "rejected", reason: "message_id_conflict" };
      }
      return { status: "duplicate", receipt: prior };
    }
    const r = mesh.acceptEnvelope(envelope, { peers, selfBoxId: "box-beta", now: NOW });
    if (!r.ok) {
      store.auditMesh(dir, { event: "mesh_rejected", peer: envelope.sender_box, message_id: envelope.message_id, reason: r.reason });
      store.recordSeen(dir, { message_id: envelope.message_id, sender: envelope.sender_box, outcome: "rejected", reason: r.reason, fingerprint });
      return { status: "rejected", reason: r.reason };
    }
    store.recordSeen(dir, { message_id: envelope.message_id, sender: envelope.sender_box, outcome: "delivered", hash: r.hash, fingerprint });
    store.auditMesh(dir, { event: "mesh_delivered", direction: "in", peer: envelope.sender_box, message_id: envelope.message_id, hash: r.hash, causal_parent: envelope.causal_parent, kind: envelope.kind });
    return { status: "delivered", hash: r.hash };
  }

  const first = deliver(e);
  assert.equal(first.status, "delivered");
  const replayed = deliver(e);
  assert.equal(replayed.status, "duplicate", "same message id never delivers twice");
  assert.equal(replayed.receipt.hash, first.hash, "the replay returns the original receipt");
  const delivered = store.readAudit(dir, 10).filter((r) => r.event === "mesh_delivered");
  assert.equal(delivered.length, 1, "exactly one durable audit record per delivered message");
});
