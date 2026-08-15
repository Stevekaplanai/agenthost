// Phase 1f Step 4c: the concrete §8 profile definitions for the governed
// autonomous lane. Proves they compile through the real §8 compiler, produce the
// exact binding tuples the protocol checks, and yield a deterministic re-frozen
// contract digest for a given (repos, uid) deployment input.

import { test } from "node:test";
import assert from "node:assert/strict";
import protocol from "../container/maintenance-protocol.js";
import { MAINTENANCE_CONTRACT } from "../container/maintenance-contract.js";
import { createProfileCatalog } from "../container/maintenance-profile-catalog.js";
import profilesMod from "../container/maintenance-profiles.js";

const { buildFoundationProfiles, AUTONOMOUS_RUN_KINDS } = profilesMod;
const REPO_A = "repo_" + "a".repeat(16);
const REPO_B = "repo_" + "b".repeat(16);

const compile = (repos, uid) => createProfileCatalog({ profiles: buildFoundationProfiles({ repos, workerUid: uid }), profileBindingKey: protocol.profileBindingKey });

test("requires the deployment's repos", () => {
  assert.throws(() => buildFoundationProfiles({}), /repos/);
  assert.throws(() => buildFoundationProfiles({ repos: [] }), /repos/);
});

test("the claude board profile compiles through the real §8 compiler", () => {
  const cat = compile([REPO_A]);
  assert.equal(cat.catalog.length, 1);
  const p = cat.catalog[0];
  assert.equal(p.id, "board_claude");
  assert.equal(p.engine, "claude");
  assert.equal(p.noNewPrivs, true);
  assert.equal(p.network, "inference_only");
  assert.equal(p.credential, "CLAUDE_CODE_OAUTH_TOKEN");
  assert.deepEqual(p.caps, []);
});

test("bindings cover every autonomous run kind over every deployment repo", () => {
  const cat = compile([REPO_A, REPO_B], 10001);
  for (const repo of [REPO_A, REPO_B]) {
    for (const kind of AUTONOMOUS_RUN_KINDS) {
      assert.ok(cat.bindings.has(protocol.profileBindingKey("board_claude", "claude", kind, repo)), `${kind}@${repo}`);
    }
  }
  // a chat kind is NOT bound (autonomous lane only)
  assert.ok(!cat.bindings.has(protocol.profileBindingKey("board_claude", "claude", "chat", REPO_A)));
});

test("worstCaseFor exposes the compiled ceilings the launcher reserves against", () => {
  const cat = compile([REPO_A]);
  assert.deepEqual(cat.worstCaseFor({ profileId: "board_claude" }), { tokenUnits: 2_000_000, costMicros: 10_000_000 });
});

test("the re-frozen contract digest is deterministic for a given (repos, uid) input", () => {
  const d1 = protocol.contractDigest({ ...MAINTENANCE_CONTRACT, profileCatalog: compile([REPO_A, REPO_B], 10001).catalog });
  const d2 = protocol.contractDigest({ ...MAINTENANCE_CONTRACT, profileCatalog: compile([REPO_B, REPO_A], 10001).catalog });
  assert.equal(d1, d2, "repo order must not change the digest");
  const d3 = protocol.contractDigest({ ...MAINTENANCE_CONTRACT, profileCatalog: compile([REPO_A], 10002).catalog });
  assert.notEqual(d1, d3, "a different repo set or uid is a different (re-frozen) contract");
});
