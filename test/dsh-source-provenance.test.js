import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const docker = fs.readFileSync(new URL("../container/Dockerfile", import.meta.url), "utf8");
const patch = fs.readFileSync(new URL("../container/dsh-secure.patch.yml", import.meta.url), "utf8");
const entrypoint = fs.readFileSync(new URL("../container/entrypoint.sh", import.meta.url), "utf8");

test("image builds the audited rc.5 source commit and never installs unmatched npm rc.6", () => {
  assert.match(docker, /47f943859bef60e4160492346772ded9b24f765a/);
  assert.match(docker, /FROM node:22-bookworm AS deepseek-harness-build/);
  assert.match(docker, /github\.com\/deepseek-ai\/deepseek-harness\.git/);
  assert.match(docker, /git (?:checkout|switch --detach).*47f943859bef60e4160492346772ded9b24f765a/);
  assert.match(docker, /git rev-parse HEAD/);
  assert.match(docker, /0\.1\.0-rc\.5/);
  assert.match(docker, /pnpm@11\.7\.0/);
  assert.match(docker, /pnpm install --frozen-lockfile/);
  assert.match(docker, /COPY --from=deepseek-harness-build.*\/opt\/deepseek-harness/);
  assert.doesNotMatch(docker, /npm install[^\n]*@deepseek-ai\/dsh/i);
  assert.doesNotMatch(docker, /(?:npm|pnpm) install[^\n]*@deepseek-ai\/dsh@?0\.1\.0-rc\.6/i);
  assert.match(docker, /! grep -R -F '0\.1\.0-rc\.6'/,
    "the built closure itself is checked for the unmatched release");
});

test("immutable deployment patch disables telemetry/web/fanout and pins the local bridge", () => {
  for (const id of [
    "session-telemetry-otel", "command-feedback", "web", "web-search-deepseek", "tool-web",
    "tool-jobs", "subagent", "subagent-spawn-in-process", "subagent-fork-in-process",
    "tool-subagent-control", "tool-subagent-list-agents", "tool-subagent", "tool-subagent-fork",
    "tool-subagent-report", "workflow-worker-thread", "tool-workflow", "tool-ralph",
  ]) {
    assert.match(patch, new RegExp(`- id: ${id}\\n  disabled: true`), `${id} is disabled after user layers`);
  }
  assert.match(patch, /- id: llm-deepseek[\s\S]*?baseURL: http:\/\/127\.0\.0\.1:18080/);
  assert.match(patch, /apiKeyEnv: DEEPSEEK_API_KEY/);
  assert.match(patch, /maxTokens: 8192/);
  assert.match(patch, /maxRetries: 0/);
  assert.match(patch, /id: deepseek-v4-flash/);
  assert.doesNotMatch(patch, /deepseek-v4-pro/,
    "the Flash-priced hard budget must not expose the higher-priced Pro model");
});

test("boot creates a non-listable gate-owned relay directory", () => {
  assert.match(entrypoint, /install -d -o gate -g boxstate -m 2710 \/run\/agenthost-dsh/);
});
