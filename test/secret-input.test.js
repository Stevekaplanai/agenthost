import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSecretInputs } from "../src/secret-input.js";

test("secret inputs are consumed from dedicated environment variables and deleted", async () => {
  const env = {
    AGENTHOST_CLAUDE_CODE_OAUTH_TOKEN: "oauth-fixture",
    AGENTHOST_ANTHROPIC_API_KEY: "anthropic-fixture",
    AGENTHOST_GITHUB_TOKEN: "github-fixture",
    AGENTHOST_BRIDGE_TOKEN: "bridge-fixture",
    AGENTHOST_SECRET_REPO_PRIVATE: "repo-fixture=with-equals",
    UNRELATED: "kept",
  };
  const resolved = await resolveSecretInputs({
    "oauth-token-env": true,
    "anthropic-key-env": true,
    "github-token-env": true,
    "token-env": true,
    "env-from": ["owner/repo:PRIVATE=AGENTHOST_SECRET_REPO_PRIVATE"],
  }, env);

  assert.equal(resolved["oauth-token"], "oauth-fixture");
  assert.equal(resolved["anthropic-key"], "anthropic-fixture");
  assert.equal(resolved["github-token"], "github-fixture");
  assert.equal(resolved.token, "bridge-fixture");
  assert.deepEqual(resolved.env, ["owner/repo:PRIVATE=repo-fixture=with-equals"]);
  assert.equal(env.UNRELATED, "kept");
  for (const key of [
    "AGENTHOST_CLAUDE_CODE_OAUTH_TOKEN",
    "AGENTHOST_ANTHROPIC_API_KEY",
    "AGENTHOST_GITHUB_TOKEN",
    "AGENTHOST_BRIDGE_TOKEN",
    "AGENTHOST_SECRET_REPO_PRIVATE",
  ]) {
    assert.equal(env[key], undefined, `${key} must be deleted before child processes`);
  }
});

test("unselected dedicated secret inputs are still removed before child processes", async () => {
  const env = {
    AGENTHOST_CLAUDE_CODE_OAUTH_TOKEN: "must-not-inherit",
    AGENTHOST_SECRET_UNUSED: "must-not-inherit",
    PATH: "safe-path",
  };
  const resolved = await resolveSecretInputs({}, env);
  assert.deepEqual(resolved, {});
  assert.equal(env.AGENTHOST_CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(env.AGENTHOST_SECRET_UNUSED, undefined);
  assert.equal(env.PATH, "safe-path");
});

test("missing and malformed environment-backed inputs fail without echoing supplied text", async () => {
  const secretLookingSource = "literal-secret-that-must-not-echo";
  for (const [flags, env] of [
    [{ "oauth-token-env": true }, {}],
    [{ "env-from": [`owner/repo:KEY=${secretLookingSource}`] }, {}],
    [{ "env-from": [`malformed-${secretLookingSource}`] }, {}],
    [{ "env-from": ["owner/repo:KEY=AGENTHOST_SECRET_MISSING"] }, {}],
  ]) {
    await assert.rejects(
      () => resolveSecretInputs(flags, env, async () => {
        throw new Error("noninteractive secret input required");
      }),
      (error) => {
        assert.ok(!error.message.includes(secretLookingSource));
        return true;
      },
    );
  }
});

test("missing environment values fall back to a no-echo prompt boundary", async () => {
  const prompts = [];
  const resolved = await resolveSecretInputs(
    {
      "oauth-token-env": true,
      "env-from": ["owner/repo:PRIVATE=AGENTHOST_SECRET_REPO_PRIVATE"],
    },
    {},
    async (prompt) => {
      prompts.push(prompt);
      return prompts.length === 1 ? "prompted-oauth" : "prompted-repo";
    },
  );
  assert.equal(resolved["oauth-token"], "prompted-oauth");
  assert.deepEqual(resolved.env, ["owner/repo:PRIVATE=prompted-repo"]);
  assert.equal(prompts.length, 2);
});
