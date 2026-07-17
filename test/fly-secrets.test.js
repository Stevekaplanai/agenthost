// Unit tests for the GraphQL secrets-staging payload (the Windows path --
// flyctl on Windows never sees piped stdin, so stageSecrets posts the same
// setSecrets mutation flyctl itself uses). No network: only the pure builder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSetSecretsMutation } from "../src/fly.js";

test("builds the setSecrets mutation with all pairs in variables", () => {
  // Fixture value derived at runtime (base64 of {"foo":"bar"}) so secret
  // scanners don't flag a high-entropy-looking literal in the test source.
  const fakeCreds = Buffer.from(JSON.stringify({ foo: "bar" })).toString("base64");
  const m = buildSetSecretsMutation("agenthost-steve", [
    ["CLAUDE_CREDENTIALS", fakeCreds],
    ["HERMESENV_OPENAI_API_KEY", "sk-fixture"],
  ]);
  assert.match(m.query, /setSecrets\(input: \$input\)/);
  assert.equal(m.variables.input.appId, "agenthost-steve");
  assert.deepEqual(m.variables.input.secrets, [
    { key: "CLAUDE_CREDENTIALS", value: fakeCreds },
    { key: "HERMESENV_OPENAI_API_KEY", value: "sk-fixture" },
  ]);
});

test("multiline values survive intact (JSON body, not dotenv lines)", () => {
  const pem = "-----BEGIN KEY-----\nabc\ndef\n-----END KEY-----";
  const m = buildSetSecretsMutation("app", [["PEM", pem]]);
  assert.equal(m.variables.input.secrets[0].value, pem, "newlines preserved verbatim");
  // and the whole payload round-trips through JSON (what https.request sends)
  const wire = JSON.parse(JSON.stringify(m));
  assert.equal(wire.variables.input.secrets[0].value, pem);
});

test("non-string values are stringified, keys preserved", () => {
  const m = buildSetSecretsMutation("app", [["N", 42]]);
  assert.deepEqual(m.variables.input.secrets, [{ key: "N", value: "42" }]);
});
