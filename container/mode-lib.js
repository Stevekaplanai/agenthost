// mode-lib.js -- the Growth Mode registry (ARD Wave 0, T0.1). It answers ONE
// question: which mode did this box boot in? Default (today's engineering box)
// or growth (the marketing department). Legal is NOT a mode -- it is the brand
// skin, derived from env in gate.js, and this file deliberately never touches
// it: growth is a PARALLEL channel (ARD H2).
//
// Where the state lives: /data/mode/mode.json, on the FLY VOLUME (survives
// restart, sync, and redeploy). History: it was /data/mode.json at the volume
// ROOT, root-writable only -- and then POST /api/mode (the operator's switch,
// T0.2) shipped writing from the gate process, which /data's root:root 0755
// made impossible: writeModeState's tmp+rename needs DIRECTORY write, so every
// switch died with EACCES (Steve hit exactly this on 2026-08-02). The fix
// keeps /data itself root:root 0755 (the Foundation B authority verifies
// that): the mode gets its own subdir, owner `agent`, group `boxstate` --
// the SAME shared group gate-state uses -- so gate.js can write it whichever
// uid it runs as (agent on the legacy path, gate under Foundation B).
// entrypoint.sh prepares the dir and migrates the legacy root-owned file
// every boot; reads fall back to the legacy path until that first boot.
//
// The hard rule: this file NEVER throws. A missing, corrupt, hostile, or
// future-versioned mode file boots the box as "default" and NAMES why, because
// a box that crash-loops on its own config is worse than a box in the wrong
// mode (ARD non-negotiable: never crash-loop).
//
// Pure file+shape logic only: no gate imports, no network. gate.js requires it
// above the lib-mode guard so unit tests and the UI rig reach it without
// booting a server.

"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_MODE = "default";
// Two real modes, no plugin architecture (ARD Part 4, cut #5). An unlisted name
// in the file is treated as corruption, not as a mode.
const MODES = Object.freeze(["default", "growth"]);
const SCHEMA_VERSION = 1;

// AGENTHOST_MODE_FILE is the test/dev seam ONLY: unit tests and the spawned-gate
// E2E have no /data. Production never sets it.
const MODE_FILE = process.env.AGENTHOST_MODE_FILE || "/data/mode/mode.json";
// Pre-migration boxes hold their state at the old volume-root path; readable
// by everyone, so a box that has not rebooted through the new entrypoint yet
// still knows its mode.
const LEGACY_MODE_FILE = "/data/mode.json";

// Every rejection funnels through here so callers get one shape back and the
// boot path can log/alert on `reason` instead of guessing.
function defaulted(reason) {
  return { mode: DEFAULT_MODE, setAt: null, setBy: null, reason };
}

// Never throws. A MISSING file is the normal default-mode case (reason null --
// every box that has never switched is in it); anything present but unusable
// defaults too, with a reason a human can act on.
function readModeState(file = MODE_FILE) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch (e) {
    if (e && e.code === "ENOENT") {
      // Only the real production path falls back to the legacy location --
      // the test seam (explicit file argument / AGENTHOST_MODE_FILE) must
      // keep meaning exactly the file it names.
      if (file === MODE_FILE && !process.env.AGENTHOST_MODE_FILE) {
        try { raw = fs.readFileSync(LEGACY_MODE_FILE, "utf8"); }
        catch { return defaulted(null); }
      } else {
        return defaulted(null);
      }
    } else {
      return defaulted(`mode file unreadable (${(e && e.code) || "error"})`);
    }
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { return defaulted("mode file is not valid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return defaulted("mode file is not a JSON object");
  }
  // Strict on the version: the writer always stamps one, so a file without it
  // was hand-edited or written by something else, and a future major is a box
  // running older code than its state -- both are safer as "default + alert".
  if (parsed.schema_version !== SCHEMA_VERSION) {
    return defaulted(`mode file schema_version ${JSON.stringify(parsed.schema_version)} is not ${SCHEMA_VERSION}`);
  }
  if (typeof parsed.mode !== "string" || !MODES.includes(parsed.mode)) {
    return defaulted(`unknown mode ${JSON.stringify(parsed.mode)} (known: ${MODES.join(", ")})`);
  }
  return {
    mode: parsed.mode,
    setAt: typeof parsed.set_at === "string" ? parsed.set_at : null,
    setBy: typeof parsed.set_by === "string" ? parsed.set_by : null,
    reason: null,
  };
}

// Boot-fixed, exactly like gate.js's BRAND: read ONCE at module load so every
// consumer (the APPS/NAV constants built at load, GET /mode.json, the <body>
// stamp) agrees for the life of the process, with zero per-request disk IO.
// Switching modes is a supervised RESTART, never a live toggle.
const ACTIVE = readModeState();

function activeMode() { return ACTIVE.mode; }
// The full boot state, so the boot path can report WHY it fell back.
function activeModeState() { return ACTIVE; }

// The exact on-disk shape `agenthost mode` writes and readModeState() accepts.
// Writer and reader share it so the two can never drift.
function buildModeState(mode, setBy = "cli") {
  return { schema_version: SCHEMA_VERSION, mode, set_at: new Date().toISOString(), set_by: setBy };
}

// The writer. buildModeState() has always existed and named a "cli" setter that
// was never wired, so the mode was readable and unsettable -- the capability
// existed with no way for a human to reach it (Steve's Rule 11). This is that
// missing half, and it is deliberately small: validate, write atomically, return
// the state. It does NOT restart anything. The caller owns that, because the
// gate reads the mode once at boot and holding those two steps together in one
// function would hide a restart inside what looks like a file write.
function writeModeState(mode, setBy = "operator", file = MODE_FILE) {
  if (typeof mode !== "string" || !MODES.includes(mode)) {
    throw new Error("unknown mode: " + String(mode).slice(0, 40));
  }
  const state = buildModeState(mode, setBy);
  const tmp = file + ".tmp";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o644 });
  fs.renameSync(tmp, file); // atomic: a torn mode file fails the boot validator
  return state;
}

module.exports = {
  MODES, DEFAULT_MODE, SCHEMA_VERSION, MODE_FILE,
  readModeState, activeMode, activeModeState, buildModeState, writeModeState,
};
