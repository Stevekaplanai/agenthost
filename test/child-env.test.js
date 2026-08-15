import { test } from "node:test";
import assert from "node:assert/strict";
import { minimalChildEnv } from "../src/child-env.js";
import { run as runFly } from "../src/fly.js";

test("minimum child environments omit provider and AgentHost input secrets", () => {
  const source = {
    PATH: "safe-path",
    HOME: "/safe/home",
    USERPROFILE: "C:\\safe\\home",
    TEMP: "C:\\safe\\tmp",
    LANG: "en_US.UTF-8",
    ANTHROPIC_API_KEY: "must-not-inherit",
    GITHUB_TOKEN: "must-not-inherit",
    RANDOM_SECRET: "must-not-inherit",
    AGENTHOST_CLAUDE_CODE_OAUTH_TOKEN: "must-not-inherit",
    AGENTHOST_SECRET_REPO_PRIVATE: "must-not-inherit",
    FLY_API_TOKEN: "fly-auth-only",
    HERMES_HOME: "/safe/hermes",
    CODEX_HOME: "/safe/codex",
    OPENCLAW_HOME: "/safe/openclaw",
  };

  const base = minimalChildEnv({ source });
  assert.equal(base.PATH, "safe-path");
  assert.equal(base.HOME, "/safe/home");
  assert.equal(base.ANTHROPIC_API_KEY, undefined);
  assert.equal(base.GITHUB_TOKEN, undefined);
  assert.equal(base.RANDOM_SECRET, undefined);
  assert.equal(base.AGENTHOST_CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(base.AGENTHOST_SECRET_REPO_PRIVATE, undefined);
  assert.equal(base.FLY_API_TOKEN, undefined);
  assert.equal(base.HERMES_HOME, undefined);

  const harness = minimalChildEnv({ source, includeHarnessHomes: true });
  assert.equal(harness.HERMES_HOME, "/safe/hermes");
  assert.equal(harness.CODEX_HOME, "/safe/codex");
  assert.equal(harness.OPENCLAW_HOME, "/safe/openclaw");
  assert.equal(harness.FLY_API_TOKEN, undefined);

  const flyctl = minimalChildEnv({ source, includeFlyAuth: true });
  assert.equal(flyctl.FLY_API_TOKEN, "fly-auth-only");
  assert.equal(flyctl.ANTHROPIC_API_KEY, undefined);
});

test("fly child processes receive Fly auth but not provider or AgentHost input secrets", (t) => {
  const originals = new Map([
    ["FLYCTL_PATH", process.env.FLYCTL_PATH],
    ["FLY_API_TOKEN", process.env.FLY_API_TOKEN],
    ["ANTHROPIC_API_KEY", process.env.ANTHROPIC_API_KEY],
    ["AGENTHOST_CLAUDE_CODE_OAUTH_TOKEN", process.env.AGENTHOST_CLAUDE_CODE_OAUTH_TOKEN],
    ["AGENTHOST_SECRET_REPO_PRIVATE", process.env.AGENTHOST_SECRET_REPO_PRIVATE],
  ]);
  t.after(() => {
    for (const [key, value] of originals) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  process.env.FLYCTL_PATH = process.execPath;
  process.env.FLY_API_TOKEN = "fly-auth-visible";
  process.env.ANTHROPIC_API_KEY = "provider-secret-hidden";
  process.env.AGENTHOST_CLAUDE_CODE_OAUTH_TOKEN = "input-secret-hidden";
  process.env.AGENTHOST_SECRET_REPO_PRIVATE = "repo-secret-hidden";

  const result = runFly(
    ["-e", "process.stdout.write(JSON.stringify(process.env))"],
    { env: { ...process.env, ANOTHER_SECRET: "caller-env-hidden" } },
  );
  assert.equal(result.code, 0, result.stderr);
  const child = JSON.parse(result.stdout);
  assert.equal(child.FLY_API_TOKEN, "fly-auth-visible");
  assert.equal(child.ANTHROPIC_API_KEY, undefined);
  assert.equal(child.AGENTHOST_CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(child.AGENTHOST_SECRET_REPO_PRIVATE, undefined);
  assert.equal(child.ANOTHER_SECRET, undefined);
});
