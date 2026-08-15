// Phase 1f Step 4c: the §8 profile-catalog compiler. Validates the schema, the
// derived binding tuples (against the REAL protocol.profileBindingKey), the
// worst-case reservation, and that the frozen catalog is digest-stable regardless
// of definition order (so the same profiles always produce the same re-frozen
// contract digest).

import { test } from "node:test";
import assert from "node:assert/strict";
import protocol from "../container/maintenance-protocol.js";
import catMod from "../container/maintenance-profile-catalog.js";

const { createProfileCatalog, compileProfile } = catMod;
const REPO = "repo_" + "a".repeat(16);

const CLAUDE = {
  id: "profile_claude_board", engine: "claude", argvTemplate: ["claude", "-p", "{objective}"],
  runKinds: ["board_task"], repos: [REPO], uid: 10001, gid: 10001, caps: [], supplementaryGroups: [],
  noNewPrivs: true, envAllowlist: ["HOME", "PATH"], credential: "CLAUDE_CODE_OAUTH_TOKEN",
  workspace: "workspaces/board", readOnlyMounts: ["/opt/agenthost"], writableMounts: ["workspaces/board"],
  network: "inference_only", limits: { maxTokenUnits: 1_000_000, maxCostMicros: 5_000_000, maxLifetimeMs: 3_600_000, maxOutputBytes: 1_048_576 },
};
const HERMES = { ...CLAUDE, id: "profile_hermes_board", engine: "hermes", credential: "HERMES_TOKEN", argvTemplate: ["hermes", "run"] };

const mk = (profiles) => createProfileCatalog({ profiles, profileBindingKey: protocol.profileBindingKey });

test("compiles profiles and derives the exact protocol binding tuples", () => {
  const cat = mk([CLAUDE, HERMES]);
  assert.equal(cat.catalog.length, 2);
  assert.ok(cat.bindings.has(protocol.profileBindingKey("profile_claude_board", "claude", "board_task", REPO)));
  assert.ok(cat.bindings.has(protocol.profileBindingKey("profile_hermes_board", "hermes", "board_task", REPO)));
  assert.ok(!cat.bindings.has(protocol.profileBindingKey("profile_claude_board", "gemini", "board_task", REPO)));
});

test("worstCaseFor returns the profile's compiled ceilings; unknown fails closed", () => {
  const cat = mk([CLAUDE]);
  assert.deepEqual(cat.worstCaseFor({ profileId: "profile_claude_board" }), { tokenUnits: 1_000_000, costMicros: 5_000_000 });
  assert.throws(() => cat.worstCaseFor({ profileId: "nope" }), (e) => e.code === "PROFILE_UNAVAILABLE");
});

test("the frozen catalog is digest-stable regardless of definition order", () => {
  const a = protocol.canonicalize(mk([CLAUDE, HERMES]).catalog);
  const b = protocol.canonicalize(mk([HERMES, CLAUDE]).catalog);
  assert.equal(a, b, "profile order must not change the catalog bytes (=> stable re-frozen digest)");
});

test("profileHealth reports availability from the injected probe", () => {
  const cat = mk([CLAUDE, HERMES]);
  const health = cat.profileHealth((p) => (p.engine === "hermes" ? "binary_missing" : null));
  assert.deepEqual(health.find((h) => h.id === "profile_claude_board"), { id: "profile_claude_board", available: true, reasonCode: null });
  assert.deepEqual(health.find((h) => h.id === "profile_hermes_board"), { id: "profile_hermes_board", available: false, reasonCode: "binary_missing" });
});

test("schema fails closed: no_new_privs must be true, credential must be allowed, uid positive", () => {
  assert.throws(() => compileProfile({ ...CLAUDE, noNewPrivs: false }), (e) => e.code === "INVALID_POLICY");
  assert.throws(() => compileProfile({ ...CLAUDE, credential: "SOME_RANDOM_KEY" }), (e) => e.code === "INVALID_POLICY");
  assert.throws(() => compileProfile({ ...CLAUDE, uid: 0 }), (e) => e.code === "INVALID_POLICY");
  assert.throws(() => compileProfile({ ...CLAUDE, workspace: "../escape" }), (e) => e.code === "INVALID_POLICY");
  assert.throws(() => compileProfile({ ...CLAUDE, network: "wide_open" }), (e) => e.code === "INVALID_POLICY");
});

test("duplicate profile ids fail closed", () => {
  assert.throws(() => mk([CLAUDE, { ...CLAUDE }]), (e) => e.code === "INVALID_POLICY");
});

test("a compiled profile plugs into the contract profileCatalog and produces a stable digest", () => {
  const cat = mk([CLAUDE, HERMES]);
  const contractV2 = { protocolVersion: 1, methodSchemas: {}, responseSchemas: {}, errorCatalog: [], profileCatalog: cat.catalog };
  const d1 = protocol.contractDigest(contractV2);
  const d2 = protocol.contractDigest({ ...contractV2, profileCatalog: mk([HERMES, CLAUDE]).catalog });
  assert.equal(d1, d2, "same profiles => same re-frozen contract digest");
});
