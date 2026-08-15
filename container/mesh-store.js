// mesh-store.js -- the Box Mesh's durable state (phase 1 of the box-mesh
// build). Everything the contract layer (mesh-contract.js) deliberately can't
// hold because it must survive a reboot:
//
// - box identity: created once, stable forever after (a mesh peer that changes
//   identity on every boot can never be pinned).
// - idempotency index: ON DISK, because replay protection that lives in memory
//   resets on restart and then accepts every replayed message (red-team sweep
//   flag #1). The gate binds each sender/message_id to a semantic fingerprint;
//   an exact retry returns its recorded receipt, changed meaning conflicts, and
//   legacy unbound rows stay burned -- one delivery, one audit record, ever.
// - audit chain: append-only JSONL; each record carries the envelope's causal
//   hash and the causal_parent it linked to, and continuity is now ENFORCED:
//   an inbound causal_parent must be a hash this box actually recorded for that
//   peer (or null for a genuinely first message), so a fabricated or forked
//   parent is rejected rather than chained. NO secret values ever land here -- records hold ids, hashes,
//   timestamps, reasons, and short summaries only.
// - LOCKED flag: a file. Server-side authority the phase-3 state stream will
//   build on; phase 1 only needs "a message sent while LOCKED is refused".
//
// All functions take the mesh dir explicitly (no module-level path state), so
// tests run against temp dirs and the gate passes AGENTHOST_DIR/mesh.

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
// LOCKED authority lives in mesh-state.js (phase 3), which owns the monotonic
// epoch. The store's isLocked/setLocked delegate there so the box has exactly
// ONE source of truth for "is the box locked" across message delivery and every
// surface.
const meshState = require("./mesh-state.js");

const IDENTITY_FILE = "identity.json";
const SEEN_FILE = "seen.jsonl";
const AUDIT_FILE = "audit.jsonl";
const SEEN_KEEP = 2000; // replay window; far beyond CHAT-scale traffic, still bounded
const AUDIT_KEEP = 5000; // bounded audit retention so malformed traffic can't grow the file without limit (red-team DoS)

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); }

// Stable box identity, created on first read. The id is public (peers pin it);
// nothing secret lives in the identity file.
function boxIdentity(dir) {
  const file = path.join(dir, IDENTITY_FILE);
  try {
    const id = JSON.parse(fs.readFileSync(file, "utf8"));
    if (id && typeof id.boxId === "string" && id.boxId) return id;
  } catch {}
  const fresh = {
    boxId: "box-" + crypto.randomBytes(6).toString("hex"),
    createdAt: new Date().toISOString(),
    schema: "agenthost.identity.v1",
  };
  try {
    ensureDir(dir);
    fs.writeFileSync(file, JSON.stringify(fresh), { mode: 0o600, flag: "wx" });
    return fresh;
  } catch {
    // Lost a creation race or the disk refused: re-read; if that also fails,
    // return the fresh identity un-persisted (degraded but functional).
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fresh; }
  }
}

// Delegated to mesh-state (the epoch-bearing authority). Kept as thin wrappers
// so existing callers/tests are unchanged while there is one lock truth.
function isLocked(dir) { return meshState.isLocked(dir); }
function setLocked(dir, locked) {
  try { meshState.transition(dir, locked ? "lock" : "unlock", Date.now()); return true; }
  catch { return false; }
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

// Replay check: the recorded receipt for a (sender, message_id), or null. The
// key is scoped to the SENDER (red-team 2026-07-31): a global message_id key
// let two legitimate peers collide on the same id -- the second suppressed --
// and made one peer's id namespace an unauthenticated probe surface for the
// other. Matching (sender, id) keeps each peer's replay space its own.
function seenReceipt(dir, sender, messageId) {
  const rows = readJsonl(path.join(dir, SEEN_FILE));
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].message_id === messageId && rows[i].sender === sender) return rows[i];
  }
  return null;
}

// Record a message's terminal outcome. Append-then-prune, same discipline as
// the team thread; the prune keeps the newest SEEN_KEEP rows.
function recordSeen(dir, receipt) {
  try {
    ensureDir(dir);
    const file = path.join(dir, SEEN_FILE);
    fs.appendFileSync(file, JSON.stringify(receipt) + "\n", { mode: 0o600 });
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    if (lines.length > SEEN_KEEP * 2) fs.writeFileSync(file, lines.slice(-SEEN_KEEP).join("\n") + "\n");
    return true;
  } catch { return false; }
}

// The last audit hash for a peer pair -- the causal_parent for the next
// outbound message to that peer.
function lastChainHash(dir, peerBoxId) {
  const rows = readJsonl(path.join(dir, AUDIT_FILE));
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].peer === peerBoxId && typeof rows[i].hash === "string") return rows[i].hash;
  }
  return null;
}

// Every hash this box has recorded for a peer. Continuity enforcement accepts
// a causal_parent only if it appears here (or null, for a genuinely first
// message) — so a fabricated or forked parent is rejected, while legitimate
// concurrent traffic, whose parent may not be the very newest hash by arrival
// time, still passes.
function knownChainHashes(dir, peerBoxId) {
  const out = new Set();
  for (const row of readJsonl(path.join(dir, AUDIT_FILE))) {
    if (row.peer === peerBoxId && typeof row.hash === "string" && row.hash) out.add(row.hash);
  }
  return out;
}

// One audit record per mesh event. `entry` must already be secret-free (the
// contract layer never puts key material in an envelope; this layer records
// ids/hashes/reasons only -- enforced by the shape below, which whitelists
// fields instead of spreading the caller's object).
function auditMesh(dir, entry) {
  try {
    ensureDir(dir);
    const row = {
      t: new Date(Number.isFinite(entry.now) ? entry.now : Date.now()).toISOString(),
      event: String(entry.event || "mesh_event"),
      dir: entry.direction === "out" ? "out" : "in",
      peer: String(entry.peer || "unknown"),
      message_id: entry.message_id ? String(entry.message_id).slice(0, 100) : null,
      hash: entry.hash || null,
      causal_parent: entry.causal_parent || null,
      kind: entry.kind || null,
      reason: entry.reason || null,
      issued_at: entry.issued_at || null,
      expires_at: entry.expires_at || null,
      summary: entry.summary ? String(entry.summary).slice(0, 200) : null,
    };
    const file = path.join(dir, AUDIT_FILE);
    fs.appendFileSync(file, JSON.stringify(row) + "\n", { mode: 0o600 });
    // Bounded retention: append-then-prune (same discipline as seen.jsonl) so a
    // flood of authenticated-but-rejected events can't grow the file without
    // limit. Unauthenticated/malformed input never reaches here -- the delivery
    // path only audits after signature verification (red-team DoS mitigation).
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    if (lines.length > AUDIT_KEEP * 2) fs.writeFileSync(file, lines.slice(-AUDIT_KEEP).join("\n") + "\n");
    return row;
  } catch { return null; }
}

function readAudit(dir, limit) {
  const rows = readJsonl(path.join(dir, AUDIT_FILE));
  return rows.slice(-(Number.isFinite(limit) ? limit : 50));
}

module.exports = {
  boxIdentity,
  isLocked,
  setLocked,
  seenReceipt,
  recordSeen,
  lastChainHash,
  knownChainHashes,
  auditMesh,
  readAudit,
};
