"use strict";

// Dormant Foundation-B candidate: the §8 fixed-governed-profile compiler
// (BUILD-PLAN Phase 1f, Step 4c infrastructure; ROOT-SERVICE-IPC-CONTRACT §8).
// A profileId selects a compiled, service-owned profile that fixes exactly how a
// governed worker runs: engine binary + argv template, allowed run-kind/engine/
// repo mapping, uid/gid/caps/supplementary-groups/no_new_privs, env allowlist +
// which single inference credential may be injected, workspace under a trusted
// dir handle, read-only + task-scoped writable mounts, network policy, and
// resource/time/output limits + teardown/usage/restart policy.
//
// This module is the COMPILER + validator, not the values: it takes profile
// definitions (Steve's operational decisions — which binary, which uid, which
// credential per engine) + the deployment's allowed repos, validates each against
// the §8 schema, and produces (a) the frozen `catalog` that goes into the
// contract's profileCatalog (so its bytes version-lock the handshake — changing a
// profile re-freezes the digest, exactly the coordinated redeploy §8 demands),
// (b) the `bindings` Set of compiled (profileId,engine,runKind,repoId) tuples the
// protocol's requireProfileBinding checks, (c) `worstCaseFor(profileId)` the
// launcher reserves against, and (d) `profileHealth()` for service.health.
//
// Unknown or mismatched tuples fail closed. Profiles are NEVER mutated over IPC.
// DORMANT: no boot wiring; the concrete definitions + resulting digest are
// Steve's to confirm at activation (4c).

const ENGINES = new Set(["claude", "codex", "gemini", "hermes"]);
const RUN_KINDS = new Set(["chat", "team_chat", "brain", "loop", "multi_loop", "board_task", "git_ladder", "board_runner", "wake_check", "mail_cycle"]);
const NETWORK = new Set(["none", "git_only", "inference_only", "full"]);
const CREDENTIALS = new Set(["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "HERMES_TOKEN", null]);
const PROFILE_RE = /^[a-z][a-z0-9_.-]{1,63}$/;
const REPO_RE = /^repo_[0-9a-f]{16,64}$/;

class ProfileCatalogError extends Error {
  constructor(code, message) { super(message); this.name = "ProfileCatalogError"; this.code = code; }
}
function fail(code, message) { throw new ProfileCatalogError(code, message); }

function isStrArray(v) { return Array.isArray(v) && v.every((s) => typeof s === "string"); }
function posInt(v) { return Number.isSafeInteger(v) && v > 0; }

// Validate + freeze one profile definition into its canonical compiled form.
function compileProfile(def) {
  if (!def || typeof def !== "object") fail("INVALID_POLICY", "profile must be an object");
  if (typeof def.id !== "string" || !PROFILE_RE.test(def.id)) fail("INVALID_POLICY", "profile.id is malformed");
  if (!ENGINES.has(def.engine)) fail("INVALID_POLICY", `profile ${def.id}: unknown engine`);
  if (!isStrArray(def.argvTemplate) || def.argvTemplate.length === 0) fail("INVALID_POLICY", `profile ${def.id}: argvTemplate must be a non-empty string array`);
  if (!isStrArray(def.runKinds) || def.runKinds.some((k) => !RUN_KINDS.has(k))) fail("INVALID_POLICY", `profile ${def.id}: runKinds contains an unknown kind`);
  if (!isStrArray(def.repos) || def.repos.some((r) => !REPO_RE.test(r))) fail("INVALID_POLICY", `profile ${def.id}: repos malformed`);
  if (!posInt(def.uid) || !posInt(def.gid)) fail("INVALID_POLICY", `profile ${def.id}: uid/gid must be positive integers`);
  if (!Array.isArray(def.caps)) fail("INVALID_POLICY", `profile ${def.id}: caps must be an array`);
  if (!Array.isArray(def.supplementaryGroups) || def.supplementaryGroups.some((g) => !posInt(g))) fail("INVALID_POLICY", `profile ${def.id}: supplementaryGroups must be positive integers`);
  if (def.noNewPrivs !== true) fail("INVALID_POLICY", `profile ${def.id}: noNewPrivs must be true (a governed worker never gains privileges)`);
  if (!isStrArray(def.envAllowlist)) fail("INVALID_POLICY", `profile ${def.id}: envAllowlist must be a string array`);
  if (!CREDENTIALS.has(def.credential ?? null)) fail("INVALID_POLICY", `profile ${def.id}: credential is not an allowed inference credential`);
  if (typeof def.workspace !== "string" || def.workspace.length === 0 || def.workspace.includes("..")) fail("INVALID_POLICY", `profile ${def.id}: workspace must be a symlink-free relative path`);
  if (!isStrArray(def.readOnlyMounts) || !isStrArray(def.writableMounts)) fail("INVALID_POLICY", `profile ${def.id}: mounts must be string arrays`);
  if (!NETWORK.has(def.network)) fail("INVALID_POLICY", `profile ${def.id}: network policy is not in the fixed set`);
  const L = def.limits;
  if (!L || !posInt(L.maxTokenUnits) || !posInt(L.maxCostMicros) || !posInt(L.maxLifetimeMs) || !posInt(L.maxOutputBytes)) {
    fail("INVALID_POLICY", `profile ${def.id}: limits require positive maxTokenUnits/maxCostMicros/maxLifetimeMs/maxOutputBytes`);
  }
  // Canonical compiled form — the exact bytes that enter the contract digest.
  return Object.freeze({
    id: def.id, engine: def.engine, argvTemplate: Object.freeze([...def.argvTemplate]),
    runKinds: Object.freeze([...def.runKinds].sort()), repos: Object.freeze([...def.repos].sort()),
    uid: def.uid, gid: def.gid, caps: Object.freeze([...def.caps].sort()),
    supplementaryGroups: Object.freeze([...def.supplementaryGroups].sort()), noNewPrivs: true,
    envAllowlist: Object.freeze([...def.envAllowlist].sort()), credential: def.credential ?? null,
    workspace: def.workspace, readOnlyMounts: Object.freeze([...def.readOnlyMounts].sort()),
    writableMounts: Object.freeze([...def.writableMounts].sort()), network: def.network,
    limits: Object.freeze({ maxTokenUnits: L.maxTokenUnits, maxCostMicros: L.maxCostMicros, maxLifetimeMs: L.maxLifetimeMs, maxOutputBytes: L.maxOutputBytes }),
  });
}

// createProfileCatalog({ profiles, profileBindingKey })
//   profiles: array of profile definitions (Steve's operational values)
//   profileBindingKey: protocol.profileBindingKey (canonical tuple key)
function createProfileCatalog({ profiles, profileBindingKey } = {}) {
  if (!Array.isArray(profiles)) throw new Error("profile catalog requires a profiles array");
  if (typeof profileBindingKey !== "function") throw new Error("profile catalog requires protocol.profileBindingKey");

  const compiled = profiles.map(compileProfile);
  const ids = new Set();
  for (const p of compiled) { if (ids.has(p.id)) fail("INVALID_POLICY", `duplicate profileId ${p.id}`); ids.add(p.id); }

  // The frozen catalog for the contract's profileCatalog (sorted by id → stable
  // digest regardless of definition order).
  const catalog = Object.freeze([...compiled].sort((a, b) => (a.id < b.id ? -1 : 1)));

  // The (profileId, engine, runKind, repoId) tuples requireProfileBinding checks.
  const bindings = new Set();
  const byId = new Map();
  for (const p of compiled) {
    byId.set(p.id, p);
    for (const runKind of p.runKinds) for (const repoId of p.repos) {
      bindings.add(profileBindingKey(p.id, p.engine, runKind, repoId));
    }
  }

  function worstCaseFor({ profileId } = {}) {
    const p = byId.get(profileId);
    if (!p) fail("PROFILE_UNAVAILABLE", `no compiled profile ${profileId}`);
    return { tokenUnits: p.limits.maxTokenUnits, costMicros: p.limits.maxCostMicros };
  }

  // profileHealth() -> sorted ProfileHealthView[] (service.health). availability
  // is probed by the injected `probe`; absent → available with reasonCode null.
  function profileHealth(probe = null) {
    return catalog.map((p) => {
      const reasonCode = typeof probe === "function" ? (probe(p) ?? null) : null;
      return { id: p.id, available: reasonCode === null, reasonCode };
    });
  }

  return Object.freeze({ catalog, bindings, worstCaseFor, profileHealth, get: (id) => byId.get(id) || null });
}

module.exports = { createProfileCatalog, ProfileCatalogError, compileProfile };
