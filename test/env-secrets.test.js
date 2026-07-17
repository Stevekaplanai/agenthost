import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEnvSecrets } from "../src/env-secrets.js";

test("buildEnvSecrets maps repo:KEY=VALUE onto the ENVF_<index>__<KEY> contract start.sh expects", () => {
  const out = buildEnvSecrets(["a/one", "b/two"], ["a/one:FOO=bar", "b/two:BAZ=qux"]);
  assert.deepEqual(out, { ENVF_0__FOO: "bar", ENVF_1__BAZ: "qux" });
});

test("buildEnvSecrets preserves '=' characters inside the value", () => {
  const out = buildEnvSecrets(["a/one"], ["a/one:URL=https://x.example/?a=b"]);
  assert.equal(out.ENVF_0__URL, "https://x.example/?a=b");
});

test("buildEnvSecrets rejects a repo not present in --repos", () => {
  assert.throws(() => buildEnvSecrets(["a/one"], ["b/two:FOO=bar"]), /isn't in --repos/);
});

test("buildEnvSecrets rejects a malformed --env value", () => {
  assert.throws(() => buildEnvSecrets(["a/one"], ["not-valid"]), /must be/);
});

test("buildEnvSecrets returns an empty object with no --env flags", () => {
  assert.deepEqual(buildEnvSecrets(["a/one"], []), {});
});
