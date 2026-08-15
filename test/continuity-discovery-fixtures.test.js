import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// CONT-06 Agent Capability Discovery contract fixtures (hardened 2026-07-22 after a
// two-agent red-team; see docs/continuity/CONT-06-REDTEAM-LOG.md).
// Contract: docs/continuity/DISCOVERY-CONTRACT.md (CONT-06, v1).
//
// The load-bearing correction: a capability result is a discovery OBSERVATION, not an
// authorization to act. Three lethal false-available paths are closed: the isolated
// rung requires the gate's live per-run verdict (never a settings flag or the silent
// shared-~/work fallback); the authenticated rung proves credential-name presence, not
// validity, and a spending/acting capability needs a live validity check; and even a
// fresh cache is not a licence -- consumers re-verify at the point of consequence.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_FILE = path.join(HERE, "fixtures", "discovery-contract-v1.json");
const fixture = JSON.parse(fs.readFileSync(FIXTURE_FILE, "utf8"));

const ARRAYS = [
  "rungCases", "capabilityRequirementCases", "inventoryCases", "enumerationCases",
  "secretInputCases", "freshnessCases", "checkAtUseCases", "conservativeCases",
  "providerReuseCases", "versionCases", "unknownStateCases", "sweepCases",
  "agentCases", "envelopeCases",
];
const allCases = () => ARRAYS.flatMap((k) => fixture[k]);
const byId = (arr) => new Map(fixture[arr].map((k) => [k.id, k]));

// Independent oracle: recompute availability from the rungs a capability requires
// (including the gitMaxRung LEVEL dimension), so no fixture case can silently disagree
// with the ladder it claims to encode.
function deriveState(capability, rungs, requires, opts) {
  const req = requires[capability];
  const failedRungs = req.filter((r) => !rungs[r]);
  if (capability === "gitMaxRung" && failedRungs.length === 0 && opts) {
    // Structural per-agent authoring ceiling: a write rung (>= the write-rung floor) is
    // unavailable to any agent outside gitProposalAuthors, regardless of a generous grant.
    if (opts.gitWriteRungFloor != null && opts.agent && opts.gitProposalAuthors &&
        opts.requestedLevel >= opts.gitWriteRungFloor && !opts.gitProposalAuthors.includes(opts.agent)) {
      return { state: "unavailable", failedRung: "authorized", failedRungs: ["authorized"] };
    }
    if (opts.grantedRungValue < opts.requestedLevel) return { state: "unavailable", failedRung: "authorized", failedRungs: ["authorized"] };
  }
  const failedRung = failedRungs[0] || null;
  return failedRung
    ? { state: "unavailable", failedRung, failedRungs }
    : { state: "available", failedRung: null, failedRungs: [] };
}

test("discovery fixture has one versioned, collision-free catalog", () => {
  assert.equal(fixture.$schema, "agenthost-continuity-discovery-fixtures-v1");
  assert.equal(fixture.contractId, "CONT-06");
  assert.equal(fixture.contractVersion, 1);
  const ids = allCases().map((k) => k.id);
  assert.equal(new Set(ids).size, ids.length, "case IDs must be globally unique");
  assert.ok(ids.length >= 40, "the hardened corpus needs a meaningful surface");
});

test("the ladder is four ordered rungs with literal, contract-pinned failure codes", () => {
  assert.deepEqual(fixture.rungs, ["installed", "authenticated", "isolated", "authorized"]);
  assert.deepEqual(fixture.rungFailureCodes, {
    installed: "NOT_INSTALLED", authenticated: "NOT_AUTHENTICATED",
    isolated: "NOT_ISOLATED", authorized: "NOT_AUTHORIZED",
  });
});

test("every rung/requirement case -- including gitMaxRung -- passes through the same oracle; lowest AND full failedRungs reported", () => {
  for (const k of fixture.rungCases) {
    const oracle = deriveState(k.capability, k.rungs, fixture.capabilityRequires);
    assert.equal(k.expected.state, oracle.state, `${k.id} state must match the ladder`);
    assert.deepEqual(k.expected.failedRungs, oracle.failedRungs, `${k.id} full failedRungs set`);
    if (oracle.state === "unavailable") {
      assert.equal(k.expected.failedRung, oracle.failedRung, `${k.id} lowest failed rung`);
      assert.equal(k.expected.reasonCode, fixture.rungFailureCodes[oracle.failedRung], `${k.id} reason`);
      assert.ok(k.expected.recoveryPath && k.expected.recoveryPath.length > 0, `${k.id} needs a non-empty, rung-specific recovery path`);
    }
  }
  for (const k of fixture.capabilityRequirementCases) {
    const oracle = deriveState(k.capability, k.rungs, fixture.capabilityRequires, {
      requestedLevel: k.requestedLevel, grantedRungValue: k.grantedRungValue,
      agent: k.agent, gitProposalAuthors: fixture.gitProposalAuthors, gitWriteRungFloor: fixture.gitLadderWriteRungFloor,
    });
    assert.equal(k.expected.state, oracle.state, `${k.id} must match the ladder (oracle covers gitMaxRung levels too)`);
    if (k.expected.failedRung) assert.equal(k.expected.failedRung, oracle.failedRung, `${k.id} failedRung`);
  }
  // Structural per-agent authoring ceiling: a non-authoring agent at a write rung is
  // unavailable even with a generous grant -- the ceiling overrides grantedRungValue.
  const structural = byId("capabilityRequirementCases").get("non-codex-agent-write-rung-structurally-unavailable");
  assert.equal(fixture.gitProposalAuthors.includes(structural.agent), false, "the agent is not a proposal author");
  assert.ok(structural.requestedLevel >= fixture.gitLadderWriteRungFloor, "the request is at/above the write-rung floor");
  assert.ok(structural.grantedRungValue >= structural.requestedLevel, "the grant alone would otherwise suffice -> proves the structural ceiling decides");
  assert.equal(structural.expected.state, "unavailable");
  // The latent contradiction the red-team found: gitrung-level-insufficient grants all
  // four booleans true, so only the LEVEL check (not the boolean rungs) makes it fail.
  const insuff = byId("capabilityRequirementCases").get("gitrung-level-insufficient");
  assert.ok(Object.values(insuff.rungs).every(Boolean), "all boolean rungs pass");
  assert.ok(insuff.grantedRungValue < insuff.requestedLevel, "only the level comparison fails it");
});

test("terminal is never an autonomous-execution licence; gitMaxRung is a granted ceiling, not execution-ready", () => {
  const t = byId("capabilityRequirementCases").get("terminal-is-not-an-autonomous-execution-licence");
  assert.equal(t.expected.state, "available");
  assert.equal(t.expected.licensesAutonomousExecution, false);
  const g = byId("capabilityRequirementCases").get("gitrung-level-sufficient");
  assert.equal(g.expected.isExecutionReadyGuarantee, false, "value is a ceiling; a commit/merge still consults the live Git Ladder verdict");
  // Exact boundary: granted == requested is sufficient.
  const boundary = byId("capabilityRequirementCases").get("gitrung-level-exact-boundary");
  assert.equal(boundary.grantedRungValue, boundary.requestedLevel);
  assert.equal(boundary.expected.state, "available");
});

test("inventory never substitutes for a passing rung -- routed through the same oracle", () => {
  const ic = byId("inventoryCases");
  const rich = ic.get("rich-inventory-still-unavailable-without-authorization");
  const oracleRich = deriveState(rich.capability, rich.rungs, fixture.capabilityRequires);
  assert.equal(rich.expected.state, oracleRich.state, "247 skills must not override the ladder");
  assert.equal(rich.expected.inventoryConflatedWithCapability, false);
  const counts = ic.get("inventory-counts-are-display-not-decision");
  const oracleCounts = deriveState(counts.capability, counts.rungs, fixture.capabilityRequires);
  assert.equal(counts.expected.state, oracleCounts.state);
  assert.equal(counts.expected.countsGrantCapability, false);
});

test("enumerations are bounded at exactly cap and cap+1 for tools, MCPs, and skills, credential-free", () => {
  const ec = byId("enumerationCases");
  const mcp = ec.get("mcp-enumeration-names-only-no-credentials");
  assert.equal(mcp.expected.exposesUrl, false);
  assert.equal(mcp.expected.exposesCredential, false);
  assert.equal(mcp.expected.exposesHeaders, false);
  for (const [kind, cap] of Object.entries({ tools: fixture.enumerationCaps.tools, mcps: fixture.enumerationCaps.mcps, skills: fixture.enumerationCaps.skills })) {
    const atCap = ec.get(`${kind}-at-cap-no-overflow`);
    assert.equal(atCap.cap, cap);
    assert.equal(atCap.expected.shown, cap);
    assert.equal(atCap.expected.overflowDisclosed, false, `${kind} at exactly cap must show no overflow`);
    const overCap = ec.get(`${kind}-over-cap-by-one-summarized`);
    assert.equal(overCap.expected.shown, cap);
    assert.equal(overCap.expected.overflowDisclosed, true, `${kind} at cap+1 must disclose overflow`);
  }
});

test("a seeded secret planted in an MCP name/URL/credential field never survives to any output", () => {
  const sc = byId("secretInputCases");
  const name = sc.get("secret-in-mcp-name-scrubbed");
  assert.equal(name.injectValue, fixture.seededSecret);
  assert.equal(name.expected.enumeratedNameContainsSecret, false);
  assert.equal(name.expected.redactedAsKeyShapedField, true);
  const url = sc.get("secret-in-mcp-url-never-exposed");
  assert.equal(url.expected.resultContainsSecret, false);
  assert.equal(url.expected.urlEverExposed, false);
  const cred = sc.get("secret-in-authenticated-observation-presence-only");
  assert.equal(cred.expected.resultContainsSecret, false);
  assert.equal(cred.expected.exposesPresenceShapeOnly, true);
});

test("staleness has its own code (never mislabeled a timeout), pinned at the exact TTL boundary; fresh yields available", () => {
  const fc = byId("freshnessCases");
  const stale = fc.get("stale-installed-cache-does-not-upgrade-to-available");
  assert.ok(stale.observedMsAgo > stale.cacheTtlMs);
  assert.equal(stale.expected.stale, true);
  assert.equal(stale.expected.state, "unavailable");
  assert.equal(stale.expected.reasonCode, "CHECK_STALE", "staleness must not be mislabeled CHECK_TIMEOUT");
  const boundary = fc.get("cache-exact-ttl-boundary-still-fresh");
  assert.equal(boundary.observedMsAgo, boundary.cacheTtlMs);
  assert.equal(boundary.expected.stale, false, "== TTL is inclusive-fresh");
  const fresh = fc.get("fresh-cache-within-ttl-trusted-and-available");
  assert.equal(fresh.expected.stale, false);
  assert.equal(fresh.expected.state, "available", "a genuinely fresh, rung-passing observation must read available");
  assert.equal(fc.get("cache-hit-avoids-respawn").expected.respawns, false);
  // The revocable rungs are never long-cached.
  const live = fc.get("authenticated-and-authorized-are-not-long-cached");
  assert.equal(live.expected.onLiveRungsList, true);
  assert.ok(fixture.liveRungs.includes(live.rung));
  assert.deepEqual(fixture.liveRungs, ["authenticated", "isolated", "authorized"]);
  // isolated is a per-run LIVE verdict, never a cross-run TTL cache -- isolation can
  // regress silently (worktree fallback to shared ~/work), so a cached proven verdict
  // would license a no-longer-isolated run.
  assert.ok(fixture.liveRungs.includes("isolated"), "isolated must be re-verified live per run");
  assert.equal(fixture.cacheTtlMs.isolated, undefined, "isolated must not be held for a long TTL");
});

test("BLOCKERS B1-B3: a result is an observation, not an authorization -- three false-available paths are closed", () => {
  const cc = byId("checkAtUseCases");
  // B3: fresh available still requires re-verification at the point of consequence.
  const b3 = cc.get("fresh-available-still-not-an-authorization-to-act");
  assert.equal(b3.discoveryFresh, true);
  assert.equal(b3.revokedAfterDiscoveryBeforeUse, true);
  assert.equal(b3.expected.mustReverifyAtConsequence, true);
  assert.equal(b3.expected.consequenceProceedsOnStaleAuthorization, false);
  // B2: authenticated is presence, not validity.
  const b2 = cc.get("authenticated-presence-not-validity");
  assert.equal(b2.credentialNamePresent, true);
  assert.equal(b2.credentialValid, false);
  assert.equal(b2.expected.authenticatedRungPassesOnPresenceAlone, false);
  assert.equal(b2.expected.requiresLiveValidityForSpendingActingCapability, true);
  // B1: isolated requires the gate's live per-run verdict, never a settings flag,
  // and the silent shared-~/work fallback must not read as isolated.
  const b1a = cc.get("isolated-requires-live-per-run-verdict-not-settings-flag");
  assert.equal(b1a.settingsClaimIsolated, true);
  assert.equal(b1a.gateLiveVerdict, "unproven");
  assert.equal(b1a.expected.reasonCode, "NOT_ISOLATED", "a settings flag must not override the gate's live verdict");
  const b1b = cc.get("isolated-fallback-to-shared-work-is-not-proven");
  assert.equal(b1b.fellBackToSharedWork, true);
  assert.equal(b1b.expected.reasonCode, "NOT_ISOLATED");
  // Isolation scope is disclosed: Codex-only; every other agent fails isolated by scope.
  const scoped = cc.get("non-codex-agent-isolated-always-fails-by-scope");
  assert.equal(scoped.agent, "claude");
  assert.equal(scoped.expected.reasonCode, "NOT_ISOLATED");
  assert.deepEqual(fixture.isolationScope.supportedAgents, ["codex"]);
  assert.equal(fixture.isolationScope.failsOpenToSharedWork, true);
});

test("timeout, malformed, unreachable-source, and settings-mismatch all fail conservatively; mismatch is per-capability, never a whole-result error", () => {
  const cc = byId("conservativeCases");
  assert.equal(cc.get("check-timeout-fails-rung-conservatively").expected.reasonCode, "CHECK_TIMEOUT");
  const mal = cc.get("malformed-cli-output-unknown-not-optimistic");
  assert.equal(mal.expected.runtimeVersion, "unknown");
  assert.equal(mal.expected.reasonCode, "CHECK_MALFORMED");
  // Unreachable source is distinct from a source cleanly reporting a negative.
  const unreachable = cc.get("source-unreachable-distinct-from-clean-negative");
  assert.equal(unreachable.expected.reasonCode, "SOURCE_UNREACHABLE");
  const cleanNegative = byId("rungCases").get("authenticated-not-isolated");
  assert.notEqual(cleanNegative.expected.reasonCode, "SOURCE_UNREACHABLE");
  // Settings-vs-reality: per-capability warning, never a whole-result error.
  const mism = cc.get("settings-say-enabled-reality-says-no-per-capability-warning");
  assert.equal(mism.expected.reasonCode, "SETTINGS_REALITY_MISMATCH");
  assert.equal(mism.expected.discrepancyDisclosed, true);
  assert.equal(mism.expected.envelopeStatus, "warning");
  assert.equal(mism.expected.wholeResultErrored, false);
});

test("availableModels reuses the CONT-01 observation; no second provider probe", () => {
  const r = byId("providerReuseCases").get("available-models-reuses-cont01-no-second-probe");
  assert.equal(r.reusesCont01Observation, true);
  assert.equal(r.expected.secondProviderProbeMade, false);
});

test("runtime upgrade/downgrade re-observes the version", () => {
  const vc = byId("versionCases");
  assert.equal(vc.get("runtime-upgrade-changes-observation").expected.observedVersion, "sonnet-5");
  assert.equal(vc.get("runtime-downgrade-changes-observation").expected.observedVersion, "sonnet-4");
});

test("'unknown' (presence undeterminable) is distinct from 'unavailable' (a rung provably failed)", () => {
  const u = byId("unknownStateCases").get("presence-undeterminable-yields-unknown-not-unavailable-optimistic");
  assert.equal(u.expected.state, "unknown");
});

test("a multi-agent sweep is independent per agent, and a rung flip between discoveries changes the result", () => {
  const sc = byId("sweepCases");
  assert.equal(sc.get("multi-agent-sweep-mixed-availability").expected.independentPerAgentResults, true);
  const flip = sc.get("rung-flips-between-discoveries");
  assert.equal(flip.discoveryN.state, "available");
  assert.equal(flip.discoveryNplus1.state, "unavailable");
  assert.equal(flip.expected.flipsToUnavailable, true);
});

test("unknown agents are rejected; kimi's baseline is conservative-unavailable", () => {
  const ac = byId("agentCases");
  assert.equal(ac.get("unknown-agent-rejected").expected.errorCode, "AGENT_UNKNOWN");
  const kimi = ac.get("kimi-conservative-unavailable-baseline");
  assert.equal(kimi.expected.state, "unavailable");
  assert.equal(kimi.expected.failedRung, "installed");
  assert.deepEqual(fixture.knownAgents, ["claude", "codex", "gemini", "hermes", "kimi"]);
  assert.equal(fixture.knownAgents.includes("openclaw"), false);
});

test("every declared code is exercised, and every envelope is deterministic", () => {
  const codesOnCases = new Set([
    ...allCases().map((k) => k.code).filter(Boolean),
    ...allCases().map((k) => k.expected && k.expected.reasonCode).filter(Boolean),
    ...allCases().map((k) => k.expected && k.expected.errorCode).filter(Boolean),
  ]);
  for (const c of fixture.codes) assert.ok(codesOnCases.has(c), `code ${c} is never exercised`);
  for (const c of codesOnCases) assert.ok(fixture.codes.includes(c), `undeclared code ${c}`);
  for (const k of fixture.envelopeCases) {
    const env = k.expected;
    assert.ok(["success", "warning", "error"].includes(env.status));
    assert.ok(typeof env.summary === "string" && env.summary.length > 0 && env.summary.length <= 200, `${k.id}`);
    assert.ok(Array.isArray(env.next_actions) && Array.isArray(env.artifacts));
    if (env.status === "error") {
      assert.equal(env.error.code, k.code, `${k.id}: error.code must match the case code`);
      assert.ok(env.error.retry.length > 0 && env.error.stopCondition.length > 0, `${k.id} triplet`);
    }
  }
  // The flagship example is corrected: it must not claim Claude is cleared for
  // unattended coding (Claude cannot pass the isolated rung today).
  const flagship = byId("envelopeCases").get("envelope-success-capability-result");
  assert.equal(/unattended coding/.test(flagship.expected.summary), false, "must not claim Claude is cleared for unattended coding");
});

test("every observation carries observedAt/stale semantics, box-clock only", () => {
  for (const o of fixture.observations) assert.ok(typeof o === "string" && o.length > 0);
  assert.deepEqual(fixture.observations, [
    "runtimeVersion", "installedTools", "connectedMcps", "availableModels",
    "loadedSkills", "workspace", "approvedActions",
  ]);
});

test("seeded credential never appears in any expected output", () => {
  const secret = fixture.seededSecret;
  const expectedOnly = JSON.stringify(allCases().map((k) => k.expected ?? null));
  assert.equal(expectedOnly.includes(secret), false);
});
