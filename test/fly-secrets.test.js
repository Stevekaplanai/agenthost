// Unit tests for the GraphQL secrets-staging payload (the Windows path --
// flyctl on Windows never sees piped stdin, so stageSecrets posts the same
// setSecrets mutation flyctl itself uses). No network: only the pure builder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  buildSetSecretsMutation,
  removeRetiredCredentialSecret,
  retiredCredentialSecretExists,
  stageSecretsViaApi,
  validateSetSecretsResponse,
} from "../src/fly.js";

function interruptedResponseRequest(interruption, secret) {
  return (_url, _options, onResponse) => {
    const request = new EventEmitter();
    request.destroy = (error) => request.emit("error", error);
    request.end = () => {
      const response = new EventEmitter();
      response.statusCode = 200;
      onResponse(response);
      response.emit("data", Buffer.from('{"data":'));
      if (interruption === "error") {
        response.emit("error", new Error(`socket reset near ${secret}`));
      } else {
        response.emit(interruption);
      }
      response.emit("close");
    };
    return request;
  };
}

async function within(milliseconds, promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("stageSecretsViaApi stayed pending")), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("builds the setSecrets mutation with all pairs in variables", () => {
  const m = buildSetSecretsMutation("agenthost-steve", [
    ["CLAUDE_CODE_OAUTH_TOKEN", "oauth-fixture"],
    ["HERMESENV_OPENAI_API_KEY", "sk-fixture"],
  ]);
  assert.match(m.query, /setSecrets\(input: \$input\)/);
  assert.equal(m.variables.input.appId, "agenthost-steve");
  assert.deepEqual(m.variables.input.secrets, [
    { key: "CLAUDE_CODE_OAUTH_TOKEN", value: "oauth-fixture" },
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

test("setSecrets response requires HTTP success and the requested app confirmation", () => {
  const data = validateSetSecretsResponse(
    "fixture-app",
    200,
    JSON.stringify({
      data: { setSecrets: { release: null, app: { name: "fixture-app" } } },
    }),
  );
  assert.equal(data.setSecrets.app.name, "fixture-app");

  for (const body of [
    null,
    {},
    { data: null },
    { data: { setSecrets: null } },
    { data: { setSecrets: [] } },
    { data: { setSecrets: { app: null } } },
    { data: { setSecrets: { app: { name: "other-app" } } } },
  ]) {
    assert.throws(
      () => validateSetSecretsResponse("fixture-app", 200, JSON.stringify(body)),
      /did not confirm setSecrets for 'fixture-app'/,
    );
  }
});

test("setSecrets response rejects non-2xx JSON with a bounded redacted cause", () => {
  const secret = "access-key-response-fixture";
  for (const [status, body, cause] of [
    [401, { error: `unauthorized near ${secret}` }, /HTTP 401.*unauthorized.*\[REDACTED\]/i],
    [500, { message: "Fly backend unavailable" }, /HTTP 500.*backend unavailable/i],
  ]) {
    assert.throws(
      () => validateSetSecretsResponse("fixture-app", status, JSON.stringify(body), [secret]),
      (error) => {
        assert.match(error.message, cause);
        assert.doesNotMatch(error.message, new RegExp(secret));
        assert.ok(error.message.length < 400);
        return true;
      },
    );
  }
});

test("setSecrets response redacts overlapping secret values longest-first", () => {
  const shortSecret = "access-key";
  const longSecret = "access-key-secret";
  assert.throws(
    () => validateSetSecretsResponse(
      "fixture-app",
      401,
      JSON.stringify({ error: `rejected ${longSecret}` }),
      [shortSecret, longSecret, shortSecret],
    ),
    (error) => {
      assert.match(error.message, /rejected \[REDACTED\]/i);
      assert.doesNotMatch(error.message, /access-key|\[REDACTED\]-secret/i);
      return true;
    },
  );
});

test("setSecrets response rejects GraphQL errors and oversized or invalid bodies", () => {
  const secret = "access-key-graphql-fixture";
  assert.throws(
    () => validateSetSecretsResponse(
      "fixture-app",
      200,
      JSON.stringify({ errors: [{ message: `permission denied for ${secret}` }], data: null }),
      [secret],
    ),
    (error) => {
      assert.match(error.message, /permission denied for \[REDACTED\]/i);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );
  assert.throws(
    () => validateSetSecretsResponse("fixture-app", 200, `not-json-${secret}`, [secret]),
    (error) => {
      assert.match(error.message, /invalid JSON response/i);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );
  assert.throws(
    () => validateSetSecretsResponse("fixture-app", 200, "x".repeat(65537)),
    /response exceeded 65536 bytes/i,
  );
});

test("setSecrets staging rejects interrupted response streams instead of hanging", async () => {
  const secret = "access-key-partial-response-fixture";
  for (const interruption of ["aborted", "error", "close"]) {
    await assert.rejects(
      within(250, stageSecretsViaApi(
        "fixture-app",
        { TTYD_PASSWORD: secret },
        {
          getAuthToken: () => "fly-token-fixture",
          request: interruptedResponseRequest(interruption, secret),
        },
      )),
      (error) => {
        assert.doesNotMatch(error.message, /stayed pending/i);
        assert.match(error.message, /Fly API setSecrets failed \(HTTP 200\)/i);
        assert.match(error.message, interruption === "error"
          ? /response stream failed: socket reset near \[REDACTED\]/i
          : new RegExp(`response (?:was aborted|closed) before completion`, "i"));
        assert.doesNotMatch(error.message, new RegExp(secret));
        return true;
      },
    );
  }
});

test("setSecrets stream failures redact overlapping values longest-first", async () => {
  const shortSecret = "access-key";
  const longSecret = "access-key-secret";
  await assert.rejects(
    within(250, stageSecretsViaApi(
      "fixture-app",
      [["SHORT", shortSecret], ["LONG", longSecret]],
      {
        getAuthToken: () => "fly-token-fixture",
        request: interruptedResponseRequest("error", longSecret),
      },
    )),
    (error) => {
      assert.match(error.message, /socket reset near \[REDACTED\]/i);
      assert.doesNotMatch(error.message, /access-key|\[REDACTED\]-secret/i);
      return true;
    },
  );
});

test("inventory proves whether the retired credential-file secret exists without mutating Fly", () => {
  const calls = [];
  const result = retiredCredentialSecretExists("fixture-app", (args) => {
    calls.push(args);
    return {
      code: 0,
      stdout: JSON.stringify([{ Name: "CLAUDE_CREDENTIALS" }, { Name: "SAFE_SECRET" }]),
      stderr: "",
    };
  });

  assert.deepEqual(calls, [["secrets", "list", "-a", "fixture-app", "--json"]]);
  assert.equal(result, true);
});

test("retired cleanup does not stage a purge when Fly proves the secret is absent", () => {
  const calls = [];
  const result = retiredCredentialSecretExists("fixture-app", (args) => {
    calls.push(args);
    return { code: 0, stdout: JSON.stringify([{ Name: "SAFE_SECRET" }]), stderr: "" };
  });

  assert.deepEqual(calls, [["secrets", "list", "-a", "fixture-app", "--json"]]);
  assert.equal(result, false);
});

test("retired cleanup fails closed when the Fly secret inventory cannot be read", () => {
  assert.throws(
    () => retiredCredentialSecretExists("fixture-app", () => ({
      code: 1,
      stdout: "",
      stderr: "permission denied",
    })),
    /could not verify.*retired credential-file secret[\s\S]*permission denied/i,
  );
});

test("retired secret cleanup only stages the unset and surfaces unexpected Fly failures", () => {
  const calls = [];
  removeRetiredCredentialSecret("fixture-app", (args) => {
    calls.push(args);
    return { code: 0, stdout: "", stderr: "" };
  });
  assert.deepEqual(calls, [
    ["secrets", "unset", "CLAUDE_CREDENTIALS", "--stage", "-a", "fixture-app"],
  ]);

  assert.throws(
    () => removeRetiredCredentialSecret("fixture-app", () => {
      return { code: 1, stdout: "", stderr: "permission denied" };
    }),
    /credential-file secret cleanup failed[\s\S]*permission denied/i,
  );
});
