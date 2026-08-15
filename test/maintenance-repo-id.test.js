// Phase 1f Step 4d seam: the single-source REPOS→repoId mapping. Every producer
// and consumer of a maintenance repoId imports this, so the value cannot drift.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import mod from "../container/maintenance-repo-id.js";

const { repoIdFor, repoIdsFrom, REPO_ID_RE } = mod;

test("repoIdFor is deterministic and matches the contract REPO_RE", () => {
  const id = repoIdFor("steve/agenthost");
  assert.match(id, /^repo_[0-9a-f]{32}$/);
  assert.match(id, REPO_ID_RE);
  assert.equal(id, "repo_" + crypto.createHash("sha256").update("steve/agenthost").digest("hex").slice(0, 32));
  assert.equal(repoIdFor(" steve/agenthost "), id, "trims before hashing");
  assert.notEqual(repoIdFor("steve/other"), id);
});

test("repoIdFor fails closed on empty input", () => {
  assert.throws(() => repoIdFor(""), /owner\/name/);
  assert.throws(() => repoIdFor("   "), /owner\/name/);
  assert.throws(() => repoIdFor(null), /owner\/name/);
});

test("repoIdsFrom parses the REPOS env, ignoring blanks and preserving order", () => {
  assert.deepEqual(repoIdsFrom("a/b, c/d"), [repoIdFor("a/b"), repoIdFor("c/d")]);
  assert.deepEqual(repoIdsFrom(" a/b ,, c/d ,"), [repoIdFor("a/b"), repoIdFor("c/d")]);
  assert.deepEqual(repoIdsFrom(""), []);
  assert.deepEqual(repoIdsFrom(undefined), []);
});
