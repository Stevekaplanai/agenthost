// settings-lib.js -- the Phase 1 settings backbone (contract:
// docs/settings-backbone/CONTRACT.md). ONE store, defaults-in-code: the file at
// ~/.agenthost/settings.json holds ONLY explicit overrides, so a missing or
// corrupt file means every default -- which is defined to be EXACTLY today's
// hardcoded behavior. A fresh box behaves byte-identically to before this
// module existed (contract non-negotiable #3).
//
// Pure file+shape logic only: no gate imports, no network, no board access.
// gate.js consumes it (API routes + live honoring); the unit test rig and the
// future Codex settings page consume the same shapes through the gate's API.
//
// Reads are cheap and always fresh: loadSettings() stats the file and re-parses
// only when mtime changed, so consumers (boardTick every 30s, chat per message)
// call it freely and a PUT applies live with no cache to invalidate -- the
// write IS the invalidation.

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const HOME_DIR = process.env.HOME || "/data/home/agent";
// Beside secrets.env per the contract -- but this file must NEVER hold a secret.
const SETTINGS_FILE = path.join(HOME_DIR, ".agenthost", "settings.json");

// Defaults. EVERY value here equals the behavior hardcoded in gate.js /
// chains-lib.js / start.sh today (verified against the code, not the contract's
// first draft -- notably perChainUsd is 15, the real chains-lib cap since
// 2026-07-19, not the $5 the original V2 shipped with).
//
// v2 (2026-07-20): the `services` section. Ollama + OpenClaw are on the box but
// are NOT chat LLMs (Ollama = Hermes's model endpoint; OpenClaw = a messaging
// gateway), so they get an `enabled` flag, not a roster row. Both default true
// because today start.sh starts them whenever present/onboarded. A stored v1
// file (no `services` key) deep-merges forward to these defaults -- no migration
// step needed, and no deployed box breaks.
//
// v3 (2026-07-21): the `git` section -- the Phase 3 git capability ladder.
// autonomyLevel (0-5) controls which rungs are granted: 0-2 = no write,
// 3 = commit-local, 4 = push+PR, 5 = merge after independent review passes.
// reviewStrictness (0-5) is bound into that independent review. Raising or
// lowering it after review requires a fresh review; it never turns a human
// click into the routine code-review layer. autoCommit is the legacy toggle,
// now meaning "commit after task when rung 1 is granted." All default to the
// SAFEST value: no write, independent review,
// no auto-commit. A stored v2 file (no `git` key) deep-merges forward -- a
// deployed box gets the safe defaults with no migration step.
//
// v4 (2026-07-22): the `providers` section -- the Continuity shared provider
// registry (docs/continuity/CONTRACT.md, CONT-01). It holds ONLY the two dormant
// non-secret knobs the contract allows: whether the AgentHost-managed Moonshot
// Kimi-Chat route is enabled, and which allowlisted model it selects. Everything
// security-sensitive (origin, credential NAME, adapter, tool/header/url
// permissions) is code-owned in providers-lib.js and is NOT writable here. The
// route defaults DISABLED, and no Kimi engine exists yet, so a stored v3 file
// deep-merges forward to a dormant Moonshot with zero behavior change and zero
// network traffic -- no deployed box changes.
//
// v5 (2026-07-23): the `channels` section -- CONT-05 chat-app channels. Per
// channel (telegram/discord/whatsapp): an `enabled` flag (default FALSE -- a
// channel is off until the operator configures it, matching "WhatsApp off by
// default" and a safe fresh box) and an `owner` = the transport that carries it.
// The feasibility spike (docs/continuity/CONT-05-RUNTIME-PLAN.md, Phase 2) found
// exactly ONE capable transport per channel: Telegram/Discord broker only through
// OpenClaw (its `before_agent_run` plugin hook -- corrected 2026-07-23 from an
// earlier wrong seam, see the runtime plan), WhatsApp only through Hermes. So `owner`
// is PINNED to that one capable transport and VALIDATION rejects an incapable
// owner -- this is the single-owner-per-channel invariant, enforced structurally
// (one owner field) and by eligibility. It is not a free engine picker (the
// pre-spike contract wording "pickable" is corrected there): the operator's
// control is enable/disable, and the owner is whatever transport can actually
// carry that channel. A stored v4 file (no `channels` key) deep-merges forward to
// all channels off -- no deployed box changes.
//
// v6 (2026-08-13): DeepSeek joins the permanent roster. Kimi is also made
// explicit instead of relying on the historical "missing row means enabled"
// fallback. DeepSeek starts with real, nonzero per-run and per-day ceilings;
// gate.js consumes those ceilings before any DeepSeek provider request. A stored
// v5 file deep-merges forward, preserving every explicit operator override.
const DEFAULTS = {
  v: 6,
  llm: {
    roster: {
      claude: { active: true, inChat: true },
      codex:  { active: true, inChat: true },
      deepseek: { active: true, inChat: true },
      kimi:   { active: true, inChat: true },
      gemini: { active: true, inChat: true },
      hermes: { active: true, inChat: true },
      cursor: { active: true, inChat: true },
    },
  },
  services: {
    ollama:   { enabled: true },
    openclaw: { enabled: true },
  },
  cost: {
    limitsEnabled: true,
    perChainUsd: 15,
    // Daily governance caps for the INTERACTIVE chat path (per local-day). Chat spend
    // accrues in usage.json; once the day's total reaches EITHER cap, a chat turn is
    // gated for re-send confirmation (see container/chat-governance.js). Honored only
    // when limitsEnabled. Subscription chat records ~$0, so the DOLLAR cap is inert on a
    // default box -- the TOKEN cap is the axis that actually bounds subscription usage.
    chatDailyUsd: 25,
    chatDailyTokens: 5000000,
  },
  schedule: {
    sleep: { enabled: false, start: "23:00", end: "07:00" },
  },
  board: {
    autoDispatch: true,
    stuckAlerts: true,
  },
  agents: {
    heartbeat: "milestone",
    kimi: {
      role: "Research",
      limits: { perRunUsd: 0, perDayUsd: 0 },
    },
    deepseek: {
      role: "Engineering",
      limits: { perRunUsd: 1, perDayUsd: 5 },
    },
  },
  git: {
    autonomyLevel: 0,      // 0-5, controls which rungs are granted (0 = no write)
    reviewStrictness: 3,   // 0-5, bound into independent PR review (3 = default)
    autoCommit: false,     // commit after task when rung 1 is granted
  },
  providers: {
    // Dormant Continuity provider config. Only the AgentHost-managed Moonshot
    // route is operator-configurable, and only these two non-secret fields.
    // Disabled by default: no Kimi engine consumes it in CONT-01.
    moonshot: { enabled: false, modelId: "kimi-k3" },
  },
  channels: {
    // confirmGate (2026-07-24, Steve's call for operator-locked channels): when true
    // (the DEFAULT -- fail-safe for anyone who never touches it), a consequential
    // channel message is held for a confirm re-send, same as web chat. An operator
    // whose bot is PRIVATE (transport-level allowFrom locked to their own ids, so
    // every message is provably theirs) can set it false for friction-free chat.
    // ONLY flip this off after locking allowFrom in ~/.openclaw/openclaw.json --
    // on a public bot it is the only floor between a stranger and the engine.
    // The daily spend cap is NOT affected by this flag (separate cost.* controls).
    // boardContext (2026-07-24, Steve's "secret reporter"): when true, a channel
    // turn's prompt is prefixed with a read-only board snapshot so the bot can
    // report on the kanban. Default FALSE, and gate.js honors it ONLY when the
    // channel's transport is allowFrom-locked to the operator (code-enforced
    // precondition -- board state must never flow to an unlocked channel).
    // Read-only by construction: the snapshot is prompt text; channel turns get
    // no board mutation path from this flag.
    telegram: { enabled: false, owner: "openclaw", confirmGate: true, boardContext: false },
    discord:  { enabled: false, owner: "openclaw", confirmGate: true, boardContext: false },
    whatsapp: { enabled: false, owner: "hermes", confirmGate: true, boardContext: false },
  },
};

// The single capable transport per channel (feasibility spike, CONT-05 Phase 2).
// `owner` is pinned to this; setting any other owner is rejected. Kept as arrays
// so widening later (e.g. if Hermes gains relay, or we add a transport) is a
// data change here, not a schema rewrite.
const CHANNEL_OWNERS = {
  telegram: ["openclaw"],
  discord:  ["openclaw"],
  whatsapp: ["hermes"],
};

// Is `owner` a transport that can actually carry `channel`? Pure; the VALID
// owner checks and the future dispatcher both read this one source of truth.
function channelOwnerEligible(channel, owner) {
  return Object.prototype.hasOwnProperty.call(CHANNEL_OWNERS, channel)
    && CHANNEL_OWNERS[channel].includes(owner);
}

// The validation schema: dot-path -> check. ONLY these paths may be set via
// saveOverrides; anything else is rejected by NAME (contract: unknown key ->
// {error}). Checks return true or an error string.
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const isBool = (v) => typeof v === "boolean" || "must be true or false";
const VALID = {
  "llm.roster.claude.active": isBool,
  "llm.roster.claude.inChat": isBool,
  "llm.roster.codex.active": isBool,
  "llm.roster.codex.inChat": isBool,
  "llm.roster.deepseek.active": isBool,
  "llm.roster.deepseek.inChat": isBool,
  "llm.roster.kimi.active": isBool,
  "llm.roster.kimi.inChat": isBool,
  "llm.roster.gemini.active": isBool,
  "llm.roster.gemini.inChat": isBool,
  "llm.roster.hermes.active": isBool,
  "llm.roster.hermes.inChat": isBool,
  "llm.roster.cursor.active": isBool,
  "llm.roster.cursor.inChat": isBool,
  "services.ollama.enabled": isBool,
  "services.openclaw.enabled": isBool,
  "cost.limitsEnabled": isBool,
  "cost.perChainUsd": (v) => (typeof v === "number" && Number.isFinite(v) && v >= 1 && v <= 100) || "must be a number from 1 to 100",
  "cost.chatDailyUsd": (v) => (typeof v === "number" && Number.isFinite(v) && v >= 1 && v <= 1000) || "must be a number from 1 to 1000",
  "cost.chatDailyTokens": (v) => (typeof v === "number" && Number.isFinite(v) && v >= 100000 && v <= 1000000000) || "must be a number from 100000 to 1000000000",
  "schedule.sleep.enabled": isBool,
  "schedule.sleep.start": (v) => (typeof v === "string" && HHMM_RE.test(v)) || 'must be "HH:MM" 24-hour time',
  "schedule.sleep.end": (v) => (typeof v === "string" && HHMM_RE.test(v)) || 'must be "HH:MM" 24-hour time',
  "board.autoDispatch": isBool,
  "board.stuckAlerts": isBool,
  "agents.heartbeat": (v) => ["step", "milestone", "final"].includes(v) || 'must be "step", "milestone", or "final"',
  "git.autonomyLevel": (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 5 && Number.isInteger(v)) || "must be an integer from 0 to 5",
  "git.reviewStrictness": (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 5 && Number.isInteger(v)) || "must be an integer from 0 to 5",
  "git.autoCommit": isBool,
  // v4 providers: ONLY these two Moonshot leaves are writable. Any other
  // providers.* path (origin, credentialRef, apiKey, headers, tools, or a
  // different provider id) is rejected by NAME -- the code-owned registry in
  // providers-lib.js is the only place those live.
  "providers.moonshot.enabled": isBool,
  "providers.moonshot.modelId": (v) => v === "kimi-k3" || 'must be "kimi-k3"',
  // v5 agent profiles: per-agent role and spending limits (writable).
  "agents.kimi.role": (v) => (typeof v === "string" && v.length <= 40) || "must be a string (max 40 chars)",
  "agents.kimi.limits.perRunUsd": (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0) || "must be a number >= 0",
  "agents.kimi.limits.perDayUsd": (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0) || "must be a number >= 0",
  // DeepSeek is metered and enabled by default, so zero/unbounded values are
  // rejected: every accepted configuration retains an actual spending ceiling.
  "agents.deepseek.role": (v) => (typeof v === "string" && v.length <= 40) || "must be a string (max 40 chars)",
  "agents.deepseek.limits.perRunUsd": (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0.01 && v <= 100) || "must be a number from 0.01 to 100",
  "agents.deepseek.limits.perDayUsd": (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0.01 && v <= 1000) || "must be a number from 0.01 to 1000",
  // v5 channels. enabled is a plain bool; owner is PINNED to the one capable
  // transport per channel (CHANNEL_OWNERS) -- an incapable owner is rejected, which
  // is how the single-owner-per-channel invariant is enforced at the settings layer.
  "channels.telegram.enabled": isBool,
  "channels.discord.enabled": isBool,
  "channels.whatsapp.enabled": isBool,
  "channels.telegram.confirmGate": isBool,
  "channels.discord.confirmGate": isBool,
  "channels.whatsapp.confirmGate": isBool,
  "channels.telegram.boardContext": isBool,
  "channels.discord.boardContext": isBool,
  "channels.whatsapp.boardContext": isBool,
  "channels.telegram.owner": (v) => channelOwnerEligible("telegram", v) || "telegram can only be owned by openclaw",
  "channels.discord.owner": (v) => channelOwnerEligible("discord", v) || "discord can only be owned by openclaw",
  "channels.whatsapp.owner": (v) => channelOwnerEligible("whatsapp", v) || "whatsapp can only be owned by hermes",
};
// "v" is accepted (and ignored) so a client that echoes the whole GET shape
// back through PUT doesn't earn an unknown-key rejection for the version field.
const IGNORED_PATHS = new Set(["v"]);

// ---- pure helpers -----------------------------------------------------------

function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k of Object.keys(over || {})) {
    const b = out[k], o = over[k];
    out[k] = b && o && typeof b === "object" && typeof o === "object" && !Array.isArray(b) && !Array.isArray(o)
      ? deepMerge(b, o)
      : o;
  }
  return out;
}

// Flatten a partial object into [path, value] leaf pairs ("llm.roster.codex.active").
function leafPaths(obj, prefix) {
  const out = [];
  for (const k of Object.keys(obj || {})) {
    const p = prefix ? prefix + "." + k : k;
    const v = obj[k];
    if (v && typeof v === "object" && !Array.isArray(v)) out.push(...leafPaths(v, p));
    else out.push([p, v]);
  }
  return out;
}

// Validate a partial `set` object. Returns { ok: true, paths } or { error }.
function validateSet(partial) {
  const leaves = leafPaths(partial, "");
  if (!leaves.length) return { error: "nothing to set" };
  const paths = [];
  for (const [p, v] of leaves) {
    if (IGNORED_PATHS.has(p)) continue;
    const check = VALID[p];
    if (!check) return { error: "unknown key: " + p };
    const r = check(v);
    if (r !== true) return { error: p + " " + r };
    paths.push(p);
  }
  if (!paths.length) return { error: "nothing to set" };
  return { ok: true, paths };
}

function setPath(obj, dotPath, value) {
  const keys = dotPath.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!cur[keys[i]] || typeof cur[keys[i]] !== "object") cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

function deletePath(obj, dotPath) {
  const keys = dotPath.split(".");
  const parents = [];
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!cur || typeof cur !== "object") return;
    parents.push(cur);
    cur = cur[keys[i]];
  }
  if (cur && typeof cur === "object") delete cur[keys[keys.length - 1]];
  // Prune now-empty parent objects so the overrides file stays minimal.
  for (let i = parents.length - 1; i >= 0; i--) {
    const p = parents[i], k = keys[i];
    if (p[k] && typeof p[k] === "object" && !Object.keys(p[k]).length) delete p[k];
  }
}

// ---- file I/O (never throws out) -------------------------------------------

// mtime-keyed cache so per-message/per-tick reads don't re-parse an unchanged file.
let cacheMtime = -1;
let cacheOverrides = {};

function readOverrides(file) {
  const f = file || SETTINGS_FILE;
  let st = null;
  try { st = fs.statSync(f); } catch { cacheMtime = -1; cacheOverrides = {}; return {}; }
  if (f === SETTINGS_FILE && st.mtimeMs === cacheMtime) return cacheOverrides;
  let parsed = {};
  try {
    const raw = JSON.parse(fs.readFileSync(f, "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) parsed = raw;
    else console.error("[settings] overrides file is not an object; running on defaults");
  } catch (e) {
    // Corrupt file must never change behavior (contract #3): log + defaults.
    console.error("[settings] could not parse " + f + " (" + ((e && e.message) || e) + "); running on defaults");
    parsed = {};
  }
  if (f === SETTINGS_FILE) { cacheMtime = st.mtimeMs; cacheOverrides = parsed; }
  return parsed;
}

function writeOverrides(overrides, file) {
  const f = file || SETTINGS_FILE;
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  const tmp = path.join(path.dirname(f), `.${path.basename(f)}.${process.pid}.${crypto.randomBytes(12).toString("hex")}.tmp`);
  let descriptor = null;
  let renamed = false;
  try {
    descriptor = fs.openSync(tmp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(overrides, null, 2) + "\n");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    const leaf = fs.lstatSync(tmp);
    if (!leaf.isFile() || leaf.isSymbolicLink() || Number(leaf.nlink) !== 1) {
      throw new Error("temporary settings file is not a private regular file");
    }
    fs.renameSync(tmp, f);
    renamed = true;
  } finally {
    if (descriptor !== null) { try { fs.closeSync(descriptor); } catch {} }
    if (!renamed) { try { fs.unlinkSync(tmp); } catch {} }
  }
  if (f === SETTINGS_FILE) { cacheMtime = -1; } // next read re-stats
}

// ---- public API -------------------------------------------------------------

// The full effective settings (defaults deep-merged with file overrides).
// Never throws; worst case is pure defaults.
function loadSettings(file) {
  try { return deepMerge(DEFAULTS, readOverrides(file)); }
  catch { return deepMerge(DEFAULTS, {}); }
}

// The three-way split the UI needs for "modified" badges.
function getEffective(file) {
  const overrides = (() => { try { return readOverrides(file); } catch { return {}; } })();
  return { settings: deepMerge(DEFAULTS, overrides), defaults: deepMerge(DEFAULTS, {}), overrides };
}

// Validate + deep-merge a partial into the overrides file (atomic write).
// Returns { ok, paths, settings } or { error }. Throws never.
function saveOverrides(partial, file) {
  try {
    if (!partial || typeof partial !== "object" || Array.isArray(partial)) return { error: "expected an object" };
    const v = validateSet(partial);
    if (v.error) return { error: v.error };
    const overrides = deepMerge(readOverrides(file), {});
    for (const p of v.paths) {
      const val = p.split(".").reduce((o, k) => (o == null ? o : o[k]), partial);
      setPath(overrides, p, val);
    }
    writeOverrides(overrides, file);
    return { ok: true, paths: v.paths, settings: loadSettings(file) };
  } catch (e) {
    return { error: "could not save: " + String((e && e.message) || e) };
  }
}

// Remove one override path ("cost.perChainUsd") or everything ("*").
function resetPath(dotPath, file) {
  try {
    const p = String(dotPath || "");
    if (p === "*") { writeOverrides({}, file); return { ok: true, paths: ["*"] }; }
    if (!VALID[p]) return { error: "unknown key: " + p };
    const overrides = deepMerge(readOverrides(file), {});
    deletePath(overrides, p);
    writeOverrides(overrides, file);
    return { ok: true, paths: [p] };
  } catch (e) {
    return { error: "could not reset: " + String((e && e.message) || e) };
  }
}

// Is box-local wall-clock time inside the sleep window? Handles windows that
// cross midnight ("23:00" -> "07:00"). Pure on its args for testability;
// callers pass minutes-since-midnight in the box's local time.
function inSleepWindow(sleep, minutesNow) {
  if (!sleep || !sleep.enabled) return false;
  const toMin = (s) => { const m = HHMM_RE.exec(String(s || "")); return m ? Number(m[1]) * 60 + Number(s.slice(3, 5)) : null; };
  const start = toMin(sleep.start), end = toMin(sleep.end);
  if (start == null || end == null || start === end) return false;
  return start < end
    ? minutesNow >= start && minutesNow < end
    : minutesNow >= start || minutesNow < end; // crosses midnight
}

module.exports = {
  DEFAULTS, SETTINGS_FILE,
  loadSettings, getEffective, saveOverrides, resetPath, inSleepWindow,
  // CONT-05 channels: single source of truth for owner eligibility.
  CHANNEL_OWNERS, channelOwnerEligible,
  // exported for the unit test rig
  deepMerge, validateSet, leafPaths, setPath, deletePath,
};
