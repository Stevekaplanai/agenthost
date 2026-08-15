// test/measurement-credentials.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { credentialConfig, proxyRequest, listConnectedAccounts, createConnectToken } = require("../container/measurement-credentials.js");

const CFG = { projectId: "p_1", clientId: "c_1", clientSecret: "s_1", environment: "production" };

// A fetch double that records every call in order, so a test can assert not just
// WHAT was sent but in WHICH ORDER -- the OAuth exchange must precede the read.
function recorder(handlers) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    for (const h of handlers) if (String(url).includes(h.match)) return h.reply(calls.length);
    throw new Error("unexpected url " + url);
  };
  return { calls, fetchFn };
}

const okAccounts = { match: "/accounts", reply: () => ({ ok: true, json: async () => ({ data: [{ id: "apn_9" }] }) }) };
const okToken = { match: "/oauth/token", reply: () => ({ ok: true, json: async () => ({ access_token: "BEARER_X", expires_in: 3600 }) }) };
const okProxy = { match: "/proxy/", reply: () => ({ ok: true, json: async () => ({ data: [{ spend: "10" }] }) }) };

test("an unconfigured box refuses and names what is missing", () => {
  const r = credentialConfig({});
  assert.equal(r.ok, false);
  assert.match(r.why, /PIPEDREAM_PROJECT_ID/, "the operator must learn which name to set, not just that it failed");
});

test("a configured box reports ok without echoing any secret", () => {
  const r = credentialConfig({ PIPEDREAM_PROJECT_ID: "p_1", PIPEDREAM_CLIENT_ID: "c_1", PIPEDREAM_CLIENT_SECRET: "s_1" });
  assert.equal(r.ok, true);
  assert.equal(JSON.stringify(r).includes("s_1"), false, "a secret value must never appear in a returned object");
});

test("the OAuth exchange happens FIRST, and every later call carries the bearer", async () => {
  // This is the assertion that would have caught the blocked design: it asserts
  // ORDER, not just presence. A module that skips the exchange fails here even
  // if it happens to send some Authorization header.
  const { calls, fetchFn } = recorder([okToken, okAccounts, okProxy]);
  const r = await proxyRequest({
    cfg: CFG, accountId: "acme", provider: "meta_ads", pipedreamAccountId: "apn_9",
    targetUrl: "https://graph.facebook.com/v21.0/act_1/insights", fetchFn, state: {},
  });
  assert.equal(r.ok, true);
  assert.match(calls[0].url, /\/oauth\/token$/, "the client_credentials exchange must be the first call");
  assert.equal(calls[0].init.method, "POST");
  // The VALUES, not just the grant type. Asserting only grant_type leaves a hole
  // a URL-matching mock cannot see: an implementation that swapped the two fields
  // (client_id: cfg.clientSecret, client_secret: cfg.clientId) would pass every
  // other test in this file and fail only against real Pipedream -- which is the
  // exact class of gap that made the first version of this module ship broken.
  const exchange = JSON.parse(calls[0].init.body);
  assert.equal(exchange.grant_type, "client_credentials");
  assert.equal(exchange.client_id, "c_1", "the client id must be sent as the client id");
  assert.equal(exchange.client_secret, "s_1", "and the secret as the secret -- swapped fields still satisfy a shape-only assertion");
  assert.equal(exchange.scope, "connect:accounts:read connect:tokens:create connect:proxy",
    "the server bearer must not inherit Pipedream's full-access default");
  for (const c of calls.slice(1)) {
    assert.equal(c.init.headers.Authorization, "Bearer BEARER_X", c.url + " must carry the Connect bearer");
    assert.equal(c.init.headers["x-pd-environment"], "production");
  }
});

test("the target URL is proxied base64url, with the resolved connected account", async () => {
  const { calls, fetchFn } = recorder([okToken, okAccounts, okProxy]);
  const target = "https://graph.facebook.com/v21.0/act_1/insights?fields=spend";
  await proxyRequest({ cfg: CFG, accountId: "acme", provider: "meta_ads", pipedreamAccountId: "apn_9", targetUrl: target, fetchFn, state: {} });
  const proxied = calls.find((c) => c.url.includes("/proxy/"));
  assert.ok(proxied, "a proxy call must be made");
  const encoded = Buffer.from(target).toString("base64url");
  assert.ok(proxied.url.includes(encoded), "the target url must be base64url-encoded into the path");
  assert.match(proxied.url, /account_id=apn_9/, "the account id resolved from the accounts call must be used");
  assert.match(proxied.url, /external_user_id=acme/);
});

test("we never ask Pipedream for the raw credential", async () => {
  // include_credentials only yields a usable token for a CUSTOM OAuth app, which
  // this build deliberately does not require. Asking for it would be a silent
  // dependency on a connection model the customer does not have.
  const { calls, fetchFn } = recorder([okToken, okAccounts, okProxy]);
  await proxyRequest({ cfg: CFG, accountId: "acme", provider: "meta_ads", pipedreamAccountId: "apn_9", targetUrl: "https://x/y", fetchFn, state: {} });
  for (const c of calls) assert.equal(c.url.includes("include_credentials"), false);
});

test("a cached bearer is reused, and a stale one is re-exchanged", async () => {
  const state = {};
  let exchanges = 0;
  const fetchFn = async (url) => {
    if (String(url).includes("/oauth/token")) {
      exchanges += 1;
      return { ok: true, json: async () => ({ access_token: "B" + exchanges, expires_in: 3600 }) };
    }
    if (String(url).includes("/accounts")) return { ok: true, json: async () => ({ data: [{ id: "apn_9" }] }) };
    return { ok: true, json: async () => ({ data: [] }) };
  };
  const args = { cfg: CFG, accountId: "acme", provider: "meta_ads", pipedreamAccountId: "apn_9", targetUrl: "https://x/y", fetchFn, state };
  await proxyRequest({ ...args, now: 1_000 });
  await proxyRequest({ ...args, now: 2_000 });
  assert.equal(exchanges, 1, "a live bearer must be reused, not re-fetched per call");
  await proxyRequest({ ...args, now: 1_000 + 3_600_000 });
  assert.equal(exchanges, 2, "an expired bearer must be exchanged again");
});

test("a live bearer is re-exchanged when any Pipedream auth or scope input rotates", async () => {
  const state = {};
  let exchanges = 0;
  const fetchFn = async (url) => {
    if (String(url).includes("/oauth/token")) {
      exchanges += 1;
      return { ok: true, json: async () => ({ access_token: "B" + exchanges, expires_in: 3600 }) };
    }
    if (String(url).includes("/accounts")) return { ok: true, json: async () => ({ data: [{ id: "apn_9" }] }) };
    return { ok: true, json: async () => ({ data: [] }) };
  };
  const args = {
    accountId: "acme", provider: "meta_ads", pipedreamAccountId: "apn_9",
    targetUrl: "https://x/y", fetchFn, state,
  };
  let cfg = { ...CFG };
  await proxyRequest({ ...args, cfg, now: 1_000 });
  await proxyRequest({ ...args, cfg, now: 2_000 });
  assert.equal(exchanges, 1, "an unchanged live bearer remains reusable");

  let expectedExchanges = 1;
  for (const [field, value] of [
    ["projectId", "p_2"],
    ["clientId", "c_2"],
    ["clientSecret", "s_2"],
    ["environment", "development"],
  ]) {
    cfg = { ...cfg, [field]: value };
    await proxyRequest({ ...args, cfg, now: 3_000 });
    expectedExchanges += 1;
    assert.equal(exchanges, expectedExchanges,
      `rotating ${field} must invalidate an otherwise-live bearer`);
  }
  const cached = JSON.stringify(state.bearer);
  assert.equal(cached.includes("s_1"), false, "the original secret must not be stored in the cache identity");
  assert.equal(cached.includes("s_2"), false, "the replacement secret must not be stored in the cache identity");
});

test("no failure ever carries the bearer or a secret", async () => {
  const fetchFn = async (url) => {
    if (String(url).includes("/oauth/token")) return { ok: true, json: async () => ({ access_token: "BEARER_X", expires_in: 3600 }) };
    return { ok: false, status: 403, text: async () => "account not connected" };
  };
  const r = await proxyRequest({ cfg: CFG, accountId: "acme", provider: "meta_ads", pipedreamAccountId: "apn_9", targetUrl: "https://x/y", fetchFn, state: {} });
  assert.equal(r.ok, false);
  assert.match(r.why, /403/, "Cardinal Rule 16: the refusal names the provider's own cause");
  assert.match(r.why, /account not connected/);
  const dump = JSON.stringify(r);
  assert.equal(dump.includes("BEARER_X"), false, "the Connect bearer must never leak into a returned failure");
  assert.equal(dump.includes("s_1"), false, "nor the client secret");
});

test("a failed OAuth exchange refuses before any account read", async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(String(url));
    return { ok: false, status: 401, text: async () => "bad client credentials" };
  };
  const r = await proxyRequest({ cfg: CFG, accountId: "acme", provider: "meta_ads", pipedreamAccountId: "apn_9", targetUrl: "https://x/y", fetchFn, state: {} });
  assert.equal(r.ok, false);
  assert.match(r.why, /401/);
  assert.equal(calls.length, 1, "a bad exchange must not be followed by a doomed account read");
});

test("an OAuth failure that reflects credentials is redacted before reaching the caller", async () => {
  const reflected = `bad client c_1 with secret s_1 and bearer BEARER_X`;
  const fetchFn = async () => ({ ok: false, status: 401, text: async () => reflected });
  const r = await proxyRequest({
    cfg: CFG, accountId: "acme", provider: "meta_ads", pipedreamAccountId: "apn_9",
    targetUrl: "https://x/y", fetchFn, state: { bearer: { token: "BEARER_X", expiresAt: 0 } }, now: 1,
  });
  assert.equal(r.ok, false);
  assert.match(r.why, /401/);
  assert.match(r.why, /\[REDACTED\]/);
  assert.equal(r.why.includes("c_1"), false, "the Pipedream client id is treated as credential material too");
  assert.equal(r.why.includes("s_1"), false, "the client secret never reaches an operator response or audit cause");
  assert.equal(r.why.includes("BEARER_X"), false, "a reflected cached bearer is removed too");
});

test("a proxy failure that reflects credentials, bearer, or the chosen connected-account id is redacted", async () => {
  const fetchFn = async (url) => {
    if (String(url).includes("/oauth/token")) {
      return { ok: true, json: async () => ({ access_token: "BEARER_X", expires_in: 3600 }) };
    }
    if (String(url).includes("/accounts")) return { ok: true, json: async () => ({ data: [{ id: "apn_9" }] }) };
    return { ok: false, status: 502, text: async () => "upstream echoed c_1 s_1 BEARER_X Bearer BEARER_X for account_id apn_9 while reading insights" };
  };
  const r = await proxyRequest({
    cfg: CFG, accountId: "acme", provider: "meta_ads", pipedreamAccountId: "apn_9",
    targetUrl: "https://x/y", fetchFn, state: {},
  });
  assert.equal(r.ok, false);
  assert.match(r.why, /502/);
  assert.match(r.why, /while reading insights/, "the useful upstream cause must survive exact-value redaction");
  for (const canary of ["c_1", "s_1", "BEARER_X", "apn_9"]) assert.equal(r.why.includes(canary), false);
});

test("a Connect-token failure cannot reflect the raw bearer without its prefix", async () => {
  const rawBearer = "CONNECT_BEARER_RAW_CANARY";
  const fetchFn = async (url) => {
    if (String(url).includes("/oauth/token")) {
      return { ok: true, json: async () => ({ access_token: rawBearer, expires_in: 3600 }) };
    }
    return { ok: false, status: 502, text: async () => `provider reflected ${rawBearer}` };
  };
  const r = await createConnectToken({
    cfg: CFG, accountId: "acme", provider: "meta_ads", fetchFn, state: {},
  });
  assert.equal(r.ok, false);
  assert.match(r.why, /502/);
  assert.match(r.why, /\[REDACTED\]/);
  assert.equal(r.why.includes(rawBearer), false);
});

test("the browser Connect token is short-lived and limited to account connection", async () => {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("/oauth/token")) {
      return { ok: true, json: async () => ({ access_token: "BEARER_X", expires_in: 3600 }) };
    }
    return { ok: true, json: async () => ({
      token: "CONNECT_X",
      connect_link_url: "https://pipedream.com/connect/abc",
      expires_at: "2026-08-12T12:15:00Z",
    }) };
  };
  const result = await createConnectToken({
    cfg: CFG,
    accountId: "acme",
    provider: "meta_ads",
    allowedOrigins: ["https://box.example"],
    fetchFn,
    state: {},
  });
  assert.equal(result.ok, true);
  const request = calls.find((call) => call.url.includes("/connect/") && call.url.endsWith("/tokens"));
  assert.ok(request, "the Connect-token request must be made");
  const body = JSON.parse(request.init.body);
  assert.equal(body.scope, "connect:accounts:read connect:accounts:write",
    "the browser must not receive connect:* authority");
  assert.equal(body.expires_in, 900, "the browser token should expire after fifteen minutes, not four hours");
});

test("our provider id is translated to Pipedream's app slug", async () => {
  // Pipedream does NOT know "meta_ads". Attribyte's own map calls it
  // "facebook_marketing_api". Sending our id would silently match no account.
  const { calls, fetchFn } = recorder([okToken, okAccounts, okProxy]);
  await proxyRequest({ cfg: CFG, accountId: "acme", provider: "meta_ads", pipedreamAccountId: "apn_9", targetUrl: "https://x/y", fetchFn, state: {} });
  const accounts = calls.find((c) => c.url.includes("/accounts"));
  assert.match(accounts.url, /app=facebook_marketing_api/);
  assert.equal(accounts.url.includes("app=meta_ads"), false);
});

test("an unmapped provider is refused rather than guessed", async () => {
  const r = await proxyRequest({
    cfg: CFG, accountId: "acme", provider: "not_a_provider", targetUrl: "https://x/y",
    fetchFn: async () => { throw new Error("must not be called"); }, state: {},
  });
  assert.equal(r.ok, false);
  assert.match(r.why, /no Pipedream app slug/);
});

test("a cfg that lost its secret to a spread says SO, not that Pipedream refused us", async () => {
  // clientSecret is non-enumerable, so {...cfg} silently produces a cfg with no
  // secret. Without the guard this reports a 401 as "Pipedream rejected this
  // box's credentials" -- blaming the provider for our own dropped field.
  const { cfg } = credentialConfig({ PIPEDREAM_PROJECT_ID: "p_1", PIPEDREAM_CLIENT_ID: "c_1", PIPEDREAM_CLIENT_SECRET: "s_1" });
  assert.equal(cfg.clientSecret, "s_1", "the real cfg must still carry it");
  const copied = { ...cfg };
  assert.equal(copied.clientSecret, undefined, "this is the hazard being guarded, stated out loud");
  const r = await proxyRequest({
    cfg: copied, accountId: "acme", provider: "meta_ads", pipedreamAccountId: "apn_9", targetUrl: "https://x/y",
    fetchFn: async () => { throw new Error("must not reach the network"); }, state: {},
  });
  assert.equal(r.ok, false);
  assert.match(r.why, /client secret is missing/, "Cardinal Rule 16: the failure names OUR cause, not the provider's");
});

test("a customer who has not connected the platform is told exactly that", async () => {
  const fetchFn = async (url) => {
    if (String(url).includes("/oauth/token")) return { ok: true, json: async () => ({ access_token: "B", expires_in: 3600 }) };
    return { ok: true, json: async () => ({ data: [] }) };
  };
  const r = await proxyRequest({ cfg: CFG, accountId: "acme", provider: "meta_ads", pipedreamAccountId: "apn_9", targetUrl: "https://x/y", fetchFn, state: {} });
  assert.equal(r.ok, false);
  assert.match(r.why, /no connected meta_ads account/);
});

// ---- the credential's actual origin ------------------------------------------

test("a PIPEDREAM key entered through the box's key store is FOUND, not reported unset", () => {
  // Nothing provisions PIPEDREAM_* into the gate's environment -- no fly.toml,
  // entrypoint.sh, start.sh or CLI path sets these names -- so the 🔑 button's
  // store is the only surface an operator can actually install them through.
  // Reading process.env alone reproduced the 2026-08-01 GitHub-token incident
  // exactly: the box says "unset" while the key sits in the store it told the
  // operator to use, and there is no third place to look.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "boxsecrets-"));
  const secretsDir = path.join(home, "protected");
  const secretsFile = path.join(secretsDir, "secrets.env");
  fs.mkdirSync(secretsDir);
  fs.writeFileSync(secretsFile,
    "PIPEDREAM_PROJECT_ID=p_store\nPIPEDREAM_CLIENT_ID=c_store\nPIPEDREAM_CLIENT_SECRET=s_store\n");

  // HOME only -- NOTHING in the environment carries a PIPEDREAM name, which is
  // the real box's state.
  const r = credentialConfig({ AGENTHOST_BOX_SECRETS_FILE: secretsFile });
  assert.equal(r.ok, true, "a key in the store the product told the operator to use must reach the code that needs it");
  assert.equal(r.cfg.projectId, "p_store");
  assert.equal(r.cfg.clientId, "c_store");
  assert.equal(r.cfg.clientSecret, "s_store", "the secret must be readable by the OAuth exchange");
  assert.equal(JSON.stringify(r).includes("s_store"), false,
    "ABSENCE: reading it from the store must not make it enumerable and leakable");
});

test("the store wins over a stale environment value, and whitespace is trimmed", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "boxsecrets-"));
  const secretsDir = path.join(home, "protected");
  const secretsFile = path.join(secretsDir, "secrets.env");
  fs.mkdirSync(secretsDir);
  fs.writeFileSync(secretsFile, "PIPEDREAM_PROJECT_ID=p_fresh  \n");
  const r = credentialConfig({
    AGENTHOST_BOX_SECRETS_FILE: secretsFile,
    PIPEDREAM_PROJECT_ID: "p_stale", PIPEDREAM_CLIENT_ID: "c_1", PIPEDREAM_CLIENT_SECRET: "s_1",
  });
  assert.equal(r.ok, true);
  assert.equal(r.cfg.projectId, "p_fresh",
    "the 🔑 panel is the surface the operator was told to use, so saving there must take effect");
  assert.equal(r.cfg.clientId, "c_1", "a name absent from the store still falls back to the environment");
});

test("a credential absent from BOTH sources refuses, and says both were checked", () => {
  // Rule 16: the cause has to be actionable. "unset on this box" alone sent the
  // operator hunting for a location that does not exist.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "boxsecrets-"));
  const secretsDir = path.join(home, "protected");
  fs.mkdirSync(secretsDir);
  const r = credentialConfig({ AGENTHOST_BOX_SECRETS_FILE: path.join(secretsDir, "secrets.env") });
  assert.equal(r.ok, false);
  assert.match(r.why, /PIPEDREAM_PROJECT_ID/, "which name is missing");
  assert.match(r.why, /environment/, "and that the environment was checked");
  assert.match(r.why, /secrets\.env/, "and that the key store was checked, so the operator knows where to put it");
});

test("standalone credential reads fail closed on a symlinked, nonregular, or oversized store", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "boxsecrets-unsafe-"));
  const secretsDir = path.join(home, "protected");
  const secretsFile = path.join(secretsDir, "secrets.env");
  fs.mkdirSync(secretsDir);
  const victim = path.join(home, "victim.env");
  fs.writeFileSync(victim, "PIPEDREAM_PROJECT_ID=must_not_be_read\n");
  let linked = false;
  try {
    fs.symlinkSync(victim, secretsFile, "file");
    linked = true;
  } catch (error) {
    t.diagnostic(`symlink case not available on this host: ${error.message}`);
  }
  if (linked) {
    const symlinked = credentialConfig({ AGENTHOST_BOX_SECRETS_FILE: secretsFile });
    assert.equal(symlinked.ok, false);
    assert.match(symlinked.why, /symbolic link/);
    fs.unlinkSync(secretsFile);
  }

  fs.linkSync(victim, secretsFile);
  const hardlinked = credentialConfig({ AGENTHOST_BOX_SECRETS_FILE: secretsFile });
  assert.equal(hardlinked.ok, false);
  assert.match(hardlinked.why, /multiple hard links/);
  fs.unlinkSync(secretsFile);

  fs.mkdirSync(secretsFile);
  const nonregular = credentialConfig({ AGENTHOST_BOX_SECRETS_FILE: secretsFile });
  assert.equal(nonregular.ok, false);
  assert.match(nonregular.why, /not a regular file/);
  fs.rmdirSync(secretsFile);

  fs.writeFileSync(secretsFile, "A=" + "x".repeat(256 * 1024));
  const oversized = credentialConfig({ AGENTHOST_BOX_SECRETS_FILE: secretsFile });
  assert.equal(oversized.ok, false);
  assert.match(oversized.why, /256 KiB/);
});

test("the bounded reader catches a file that grows after fstat on the same inode", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "boxsecrets-grow-"));
  const secretsDir = path.join(home, "protected");
  const secretsFile = path.join(secretsDir, "secrets.env");
  fs.mkdirSync(secretsDir);
  fs.writeFileSync(secretsFile,
    "PIPEDREAM_PROJECT_ID=p\nPIPEDREAM_CLIENT_ID=c\nPIPEDREAM_CLIENT_SECRET=s\n");

  const realReadSync = fs.readSync;
  let grew = false;
  fs.readSync = function (...args) {
    if (!grew) {
      grew = true;
      fs.appendFileSync(secretsFile, "x".repeat(256 * 1024 + 1));
    }
    return realReadSync.apply(this, args);
  };
  try {
    const result = credentialConfig({ AGENTHOST_BOX_SECRETS_FILE: secretsFile });
    assert.equal(result.ok, false);
    assert.match(result.why, /256 KiB/,
      "a pre-read size check is insufficient when the writable inode grows during the read");
  } finally {
    fs.readSync = realReadSync;
  }
});

test("measurement refuses malformed, duplicate, and empty store entries without disclosing values", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "boxsecrets-corrupt-"));
  const secretsDir = path.join(home, "protected");
  const secretsFile = path.join(secretsDir, "secrets.env");
  fs.mkdirSync(secretsDir);
  const env = {
    AGENTHOST_BOX_SECRETS_FILE: secretsFile,
    PIPEDREAM_PROJECT_ID: "p_env", PIPEDREAM_CLIENT_ID: "c_env", PIPEDREAM_CLIENT_SECRET: "s_env",
  };
  const cases = [
    { text: "not-an-entry\n", cause: /malformed entry at line 1/, values: ["not-an-entry"] },
    {
      text: "DUP_TOKEN=duplicate-value-one\nDUP_TOKEN=duplicate-value-two\n",
      cause: /duplicate name DUP_TOKEN/,
      values: ["duplicate-value-one", "duplicate-value-two"],
    },
    { text: "EMPTY_TOKEN=\n", cause: /EMPTY_TOKEN has an empty value/, values: [] },
    {
      text: "CONTROL_TOKEN=control-secret-canary\rhidden\n",
      cause: /CONTROL_TOKEN contains a forbidden control character/,
      values: ["control-secret-canary", "hidden"],
    },
    {
      text: "GIT_PUSH_TOKEN=stored-push-secret-canary\n",
      cause: /gate-only name GIT_PUSH_TOKEN/,
      values: ["stored-push-secret-canary"],
    },
  ];
  for (const fixture of cases) {
    fs.writeFileSync(secretsFile, fixture.text);
    const result = credentialConfig(env);
    assert.equal(result.ok, false, "a corrupt store never falls back to process values and pretends to be connected");
    assert.match(result.why, fixture.cause);
    for (const value of fixture.values) assert.equal(result.why.includes(value), false);
  }
});

test("a gate-injected measurement env is consumed without rereading disk", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "boxsecrets-injected-"));
  const unsafePath = path.join(home, "directory-not-a-file");
  fs.mkdirSync(unsafePath);
  const env = {
    AGENTHOST_BOX_SECRETS_FILE: unsafePath,
    PIPEDREAM_PROJECT_ID: "p_injected",
    PIPEDREAM_CLIENT_ID: "c_injected",
    PIPEDREAM_CLIENT_SECRET: "s_injected",
  };
  Object.defineProperty(env, Symbol.for("agenthost.boxSecretsInjected"), {
    value: { error: "" }, enumerable: false,
  });
  const result = credentialConfig(env);
  assert.equal(result.ok, true, "the already-merged env must not hit the unsafe disk path a second time");
  assert.equal(result.cfg.projectId, "p_injected");
});

test("the connected-accounts read asks for a full page rather than the API default", () => {
  // It reads ONE page and follows no cursor. Asking for the largest page
  // Pipedream allows is what keeps a real client's credential inside it; past
  // that, proxyRequest refuses by name and a count equal to the limit is the
  // signal that the page was full.
  const { calls, fetchFn } = recorder([okToken, okAccounts, okProxy]);
  return proxyRequest({
    cfg: CFG, accountId: "acme", provider: "meta_ads", pipedreamAccountId: "apn_9",
    targetUrl: "https://x/y", fetchFn, state: {},
  }).then(() => {
    const list = calls.map((c) => c.url).find((u) => u.includes("/accounts?"));
    assert.equal(new URL(list).searchParams.get("limit"), "100",
      "without a limit the API default page could omit a credential the operator recorded");
  });
});

test("a malformed Pipedream connected account fails with a named cause before it reaches the picker", async () => {
  for (const row of [
    { id: {} },
    { id: "contains spaces" },
    { id: "apn_9", name: {} },
    { id: "apn_9", name: "line\nbreak" },
  ]) {
    const fetchFn = async (url) => {
      if (String(url).includes("/oauth/token")) return { ok: true, json: async () => ({ access_token: "BEARER_X", expires_in: 3600 }) };
      return { ok: true, json: async () => ({ data: [row] }) };
    };
    const result = await listConnectedAccounts({
      cfg: CFG, accountId: "acme", provider: "meta_ads", fetchFn, state: {},
    });
    assert.equal(result.ok, false);
    assert.match(result.why, /Pipedream returned a malformed connected account at row 1/);
    assert.equal(result.why.includes("[object Object]"), false);
  }
});
