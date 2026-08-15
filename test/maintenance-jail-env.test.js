// D2 fix — the jailed governed worker must receive ONLY its profile's env
// allowlist + the one named credential, never PID 1's whole secret env. The
// red-team confirmed the leak: the §8 profile's envAllowlist/credential were
// frozen into the contract but enforced NOWHERE — the worker inherited every Fly
// secret. These tests are the RED-on-regress proof that was missing (per Rule
// Constitution R0). Pure env logic — runs anywhere, no Linux needed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { scrubbedEnv } = require("../container/maintenance-worker-runtime.js");
const { buildFoundationProfiles } = require("../container/maintenance-profiles.js");
const { createProfileCatalog } = require("../container/maintenance-profile-catalog.js");
const protocol = require("../container/maintenance-protocol.js");
const { toRuntimeProfiles } = require("../container/maintenance-boot-entry.js");

// A realistic PID-1 env: the allowlisted vars + the credential + a pile of secrets
// that MUST NOT reach a jailed worker.
const SOURCE = {
  PATH: "/usr/bin:/bin", HOME: "/data/home/agent", TERM: "xterm-256color", LANG: "C.UTF-8",
  CLAUDE_CODE_OAUTH_TOKEN: "oat01-the-one-allowed-credential",
  ANTHROPIC_API_KEY: "sk-ant-LEAK", GITHUB_TOKEN: "ghp_LEAK", GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_LEAK2",
  ENVF_0__DATABASE_URL: "postgres://LEAK", ENVF_1__STRIPE_KEY: "sk_live_LEAK",
  TTYD_PASSWORD: "LEAK", KIMI_API_KEY: "LEAK", GEMINI_API_KEY: "LEAK", FLY_API_TOKEN: "LEAK",
};
const SECRETS_THAT_MUST_NOT_LEAK = [
  "ANTHROPIC_API_KEY", "GITHUB_TOKEN", "GITHUB_PERSONAL_ACCESS_TOKEN",
  "ENVF_0__DATABASE_URL", "ENVF_1__STRIPE_KEY", "TTYD_PASSWORD", "KIMI_API_KEY",
  "GEMINI_API_KEY", "FLY_API_TOKEN",
];

test("scrubbedEnv keeps ONLY the allowlist + the one credential", () => {
  const profile = { envAllowlist: ["HOME", "PATH", "TERM", "LANG"], credential: "CLAUDE_CODE_OAUTH_TOKEN" };
  const env = scrubbedEnv(profile, SOURCE);
  assert.deepEqual(Object.keys(env).sort(), ["CLAUDE_CODE_OAUTH_TOKEN", "HOME", "LANG", "PATH", "TERM"]);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "oat01-the-one-allowed-credential"); // the worker can still auth
});

test("scrubbedEnv drops every other secret (the D2 leak, closed)", () => {
  const profile = { envAllowlist: ["HOME", "PATH", "TERM", "LANG"], credential: "CLAUDE_CODE_OAUTH_TOKEN" };
  const env = scrubbedEnv(profile, SOURCE);
  for (const leaked of SECRETS_THAT_MUST_NOT_LEAK) {
    assert.equal(env[leaked], undefined, `${leaked} must NOT reach the jail`);
  }
});

test("a profile with no explicit allowlist still drops secrets (safe default env)", () => {
  const env = scrubbedEnv({}, SOURCE); // no envAllowlist, no credential
  assert.equal(env.PATH, "/usr/bin:/bin"); // still runnable
  assert.equal(env.HOME, "/data/home/agent");
  for (const leaked of [...SECRETS_THAT_MUST_NOT_LEAK, "CLAUDE_CODE_OAUTH_TOKEN"]) {
    assert.equal(env[leaked], undefined, `${leaked} must not appear with no policy`);
  }
});

test("end-to-end: the real board_claude profile → runtime → env is secret-free but has the token", () => {
  const profiles = buildFoundationProfiles({ repos: ["repo_" + "a".repeat(16)], workerUid: 10001, workerGid: 10001 });
  const catalog = createProfileCatalog({ profiles, profileBindingKey: protocol.profileBindingKey }).catalog;
  const rt = toRuntimeProfiles(catalog);
  const board = rt.board_claude;
  // The ADAPT seam must carry the policy (regression guard for the exact drop that caused D2):
  assert.ok(Array.isArray(board.envAllowlist) && board.envAllowlist.length > 0, "envAllowlist must survive toRuntimeProfiles");
  assert.equal(board.credential, "CLAUDE_CODE_OAUTH_TOKEN", "credential must survive toRuntimeProfiles");
  const env = scrubbedEnv(board, SOURCE);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "oat01-the-one-allowed-credential");
  for (const leaked of SECRETS_THAT_MUST_NOT_LEAK) {
    assert.equal(env[leaked], undefined, `${leaked} must NOT reach a real board_claude worker`);
  }
});
