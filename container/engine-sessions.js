// engine-sessions.js -- durable per-engine chat session identity (router build
// slice 1, 2026-07-31). gate.js keeps the id-keyed engines' session ids
// (Codex thread id, Hermes session id) in an in-memory map so the NEXT turn
// resumes the same conversation. That map used to die with the process: a gate
// restart made Codex silently forget mid-conversation (Claude survives because
// its continuity is the on-disk cwd store). Resume-after-restart is a
// first-class feature of the router, so the map now round-trips through one
// small JSON file on the volume.
//
// Best-effort by design: a disk hiccup degrades to in-memory sessions (exactly
// the pre-persistence behavior), never a failed chat turn. The dead-session
// self-healing in gate.js (drop a cached id whose rollout vanished) applies to
// restored ids the same as live ones, so a stale file can never wedge an
// engine -- worst case is one failed resume that clears itself.

"use strict";

const fs = require("fs");
const path = require("path");

// Read the persisted map. Returns a null-prototype object (same shape gate.js
// always used, so a crafted engine label can't collide with Object.prototype)
// holding only string->string entries; anything else in the file is dropped.
// A missing or corrupt file is a fresh start, never a throw.
function loadEngineSessions(file) {
  const sessions = Object.create(null);
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return sessions; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return sessions;
  for (const [label, id] of Object.entries(raw)) {
    if (typeof label === "string" && label && typeof id === "string" && id && id.length <= 200) {
      sessions[label] = id;
    }
  }
  return sessions;
}

// Persist the map. Atomic tmp+rename (same discipline and win32 fallback as
// gate.js's persistChatRunMeta) so a crash mid-write can't leave a torn file
// that loadEngineSessions would then discard along with every good entry.
function saveEngineSessions(file, sessions) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const body = JSON.stringify(sessions);
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    try { fs.renameSync(tmp, file); }
    catch (e) {
      if (process.platform !== "win32" || (e.code !== "EPERM" && e.code !== "EEXIST")) throw e;
      fs.writeFileSync(file, body, { mode: 0o600 });
      try { fs.unlinkSync(tmp); } catch {}
    }
    return true;
  } catch (e) {
    console.error(`[gate] engine session persistence failed (${e.message})`);
    return false;
  }
}

module.exports = { loadEngineSessions, saveEngineSessions };
