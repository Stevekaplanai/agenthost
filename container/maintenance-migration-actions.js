"use strict";

// Dormant Foundation-B candidate: the concrete step actions the Phase-1b
// migration executor injects — safe, idempotent boot-marker relocation and
// legacy-file "untrusted" labeling. These are the real filesystem effects of
// the secure /data migration (STATE-MACHINES §11), kept separate from the
// executor orchestration so they can be proven in isolation.
//
// DORMANT: not wired into entrypoint.sh, start.sh, gate.js, or the runtime
// image, and never run against the live /data. Activation is the atomic,
// separately-gated Phase 1f event.
//
// No-follow safety here uses lstat-based refusal (reject a symlink at the
// source or a non-root/symlink destination parent) as a reviewed candidate.
// DEFERRED: production hardening moves these onto the same root-owned no-follow
// native primitives as the trusted stores, and binds against the real /data
// layout snapshot Steve supplies (the manifest below is a representative
// fixture derived from the actual boot markers, not the final policy).

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

function lstatOrNull(p) {
  try { return fs.lstatSync(p); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

// A destination parent must be an existing real (non-symlink) directory owned
// by root, or the relocation fails closed rather than following a hostile link.
function assertTrustedParent(dir) {
  const st = lstatOrNull(dir);
  if (!st || !st.isDirectory() || st.uid !== 0) {
    const err = new Error(`untrusted relocation parent: ${dir}`);
    err.code = "UNTRUSTED_PARENT";
    throw err;
  }
}

function matches(st, uid, gid, mode) {
  return st && st.uid === uid && st.gid === gid && (st.mode & 0o7777) === mode;
}

// Idempotently relocate one marker from src to dest with the given ownership
// and mode. Re-running after success is a no-op; a symlinked source fails
// closed (no-follow).
function safeRelocate({ src, dest, uid, gid, mode }) {
  const srcStat = lstatOrNull(src);
  const destStat = lstatOrNull(dest);

  // Already relocated: src gone, dest present with the exact identity.
  if (!srcStat && matches(destStat, uid, gid, mode)) return { moved: false };

  if (srcStat && srcStat.isSymbolicLink()) {
    const err = new Error(`refusing to relocate a symlinked marker: ${src}`);
    err.code = "SYMLINK_MARKER";
    throw err;
  }
  if (!srcStat) {
    const err = new Error(`marker missing and destination not in the expected state: ${src}`);
    err.code = "MARKER_MISSING";
    throw err;
  }
  assertTrustedParent(path.dirname(dest));
  if (destStat) {
    const err = new Error(`relocation destination already exists: ${dest}`);
    err.code = "DEST_EXISTS";
    throw err;
  }
  fs.renameSync(src, dest); // renames the entry itself; does not follow a final-component symlink
  fs.chownSync(dest, uid, gid);
  fs.chmodSync(dest, mode);
  const after = lstatOrNull(dest);
  if (!matches(after, uid, gid, mode)) {
    const err = new Error(`relocation did not reach the required identity: ${dest}`);
    err.code = "RELOCATION_UNVERIFIED";
    throw err;
  }
  return { moved: true };
}

function recordDigest(value) {
  return "sha256:" + createHash("sha256").update(String(value), "utf8").digest("hex");
}

function createMigrationActions({ labelsPath } = {}) {
  // Relocate a set of markers as one migration step action. `entries` is
  // [{ src, dest, uid, gid, mode }]. Idempotent across the whole set.
  function relocateMarkersAction(entries) {
    if (!Array.isArray(entries)) throw new Error("relocateMarkersAction requires an entries array");
    return () => entries.map((entry) => ({ dest: entry.dest, ...safeRelocate(entry) }));
  }

  // Record each present legacy file as untrusted in a durable append-only label
  // file, idempotently (a file already labeled is not re-appended).
  function labelLegacyUntrustedAction(files) {
    if (!labelsPath) throw new Error("labelLegacyUntrustedAction requires a labelsPath");
    if (!Array.isArray(files)) throw new Error("labelLegacyUntrustedAction requires a files array");
    return () => {
      const existing = lstatOrNull(labelsPath)
        ? new Set(fs.readFileSync(labelsPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).file))
        : new Set();
      let labeled = 0;
      for (const file of files) {
        if (existing.has(file)) continue;
        if (!lstatOrNull(file)) continue; // only label legacy files that are actually present
        const record = { type: "legacy_label", file, label: "untrusted", fileDigest: recordDigest(file) };
        fs.appendFileSync(labelsPath, JSON.stringify(record) + "\n", { mode: 0o600 });
        existing.add(file);
        labeled += 1;
      }
      return { labeled };
    };
  }

  return Object.freeze({ relocateMarkersAction, labelLegacyUntrustedAction, safeRelocate });
}

module.exports = { createMigrationActions, safeRelocate };
