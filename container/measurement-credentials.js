// container/measurement-credentials.js
// The ONLY place the box talks to Pipedream.
//
// The box NEVER holds a platform OAuth token. Pipedream Connect stores the
// customer's credential and its proxy attaches it on Pipedream's side, so the
// token never enters this process's memory, logs, or disk. That is deliberate:
// the raw token is only retrievable with a CUSTOM OAuth app, which this build
// does not require, and not holding it is the better security posture anyway.
//
// When Meta and Google move to direct OAuth, this file is what gets replaced.
"use strict";
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const PIPEDREAM_API_HOST = "https://api.pipedream.com/v1";
// The OAuth default is `*`, which grants every protected Pipedream API. This
// box only lists accounts, mints one hosted Connect session, and proxies the
// provider read. Keep the browser token narrower still: it can only complete
// the hosted account-connect flow and expires after fifteen minutes.
const PIPEDREAM_SERVER_SCOPE = "connect:accounts:read connect:tokens:create connect:proxy";
const PIPEDREAM_CONNECT_SCOPE = "connect:accounts:read connect:accounts:write";
const PIPEDREAM_CONNECT_TTL_SECONDS = 15 * 60;
const BOX_SECRETS_DEFAULT_FILE = "/data/agenthost-secrets/secrets.env";
const BOX_SECRETS_MAX_BYTES = 256 * 1024;
const BOX_SECRETS_INJECTED = Symbol.for("agenthost.boxSecretsInjected");
const CONNECTED_ACCOUNT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const CONNECTED_ACCOUNT_LABEL_MAX = 160;

function readBoundedSecrets(descriptor) {
  const chunks = [];
  let total = 0;
  while (total <= BOX_SECRETS_MAX_BYTES) {
    const chunk = Buffer.allocUnsafe(Math.min(16 * 1024, BOX_SECRETS_MAX_BYTES + 1 - total));
    const count = fs.readSync(descriptor, chunk, 0, chunk.length, null);
    if (count === 0) break;
    chunks.push(chunk.subarray(0, count));
    total += count;
  }
  if (total > BOX_SECRETS_MAX_BYTES) throw new Error("BOX_SECRETS_TOO_LARGE");
  return Buffer.concat(chunks, total).toString("utf8");
}

// Our provider ids are NOT Pipedream's app slugs. Attribyte's own map
// (apps/api/src/integrations/pipedream-service.ts) is the source for these.
// An unmapped provider must refuse, never guess: a wrong slug silently matches
// no connected account and reads as "customer has not connected it yet".
const PIPEDREAM_APP_SLUGS = Object.freeze({
  meta_ads: "facebook_marketing_api",
  google_ads: "google_ads",
  linkedin_ads: "linkedin_ads",
  tiktok_ads: "tiktok_marketing_api",
  microsoft_ads: "microsoft_advertising",
});

// Module-private bearer cache. Never exported, never returned, never logged.
// Tests inject their own via `state` rather than reaching in here.
const moduleState = {};
// Re-exchange this far before the stated expiry, so a call cannot start with a
// valid bearer and arrive at Pipedream with an expired one.
const BEARER_SKEW_MS = 60_000;

function bearerConfigIdentity(cfg) {
  return createHash("sha256")
    .update(JSON.stringify([cfg.projectId, cfg.clientId, cfg.clientSecret, cfg.environment]))
    .digest("hex");
}

function redactFailureText(value, secrets) {
  let text = String(value == null ? "" : value);
  const needles = [...new Set((secrets || []).map((secret) => String(secret || "")).filter(Boolean))]
    .sort((a, b) => b.length - a.length);
  for (const needle of needles) {
    if (needle) text = text.split(needle).join("[REDACTED]");
  }
  return text;
}

// THE BOX'S KEY STORE -- what the in-product 🔑 button writes.
//
// Nothing anywhere provisions PIPEDREAM_* into the gate's environment: not
// fly.toml, not entrypoint.sh, not start.sh, not the CLI. Reading process.env
// alone therefore left this pack's ORIGIN credential with no way in at all,
// and the box would have answered "unset on this box" to an operator who had
// just entered the key on the surface the product told them to use.
//
// That is the 2026-08-01 GitHub-token incident verbatim: gate.js read
// GITHUB_TOKEN from process.env only, so a token pasted into the 🔑 button sat
// in this exact file for two days while every push failed "token is
// unavailable". The message was right about the symptom and wrong about the
// cause, and there was no third place to look.
//
// Standalone callers read FRESH on every call, never cached -- that is what
// makes a key saved through the 🔑 button take effect with no restart. Gate
// callers receive one already-merged env and a private in-process marker, so
// they do not perform a second disk read. The configured path gives tests a
// hermetic store while production stays outside the agent-owned HOME.
//
// Deliberately NOT gitHubToken()'s pattern: that function reads only
// process.env.GIT_PUSH_TOKEN and its comment forbids a store fallback ever
// coming back, because the gate's PUSH credential must be one its own agents
// cannot read or rewrite. PIPEDREAM_* is an ordinary operator credential, like
// GEMINI_API_KEY and KIMI_API_KEY -- both of which do read this store.
function boxSecrets(env) {
  const secretsFile = String(env.AGENTHOST_BOX_SECRETS_FILE || BOX_SECRETS_DEFAULT_FILE);
  const parent = path.dirname(secretsFile);
  const out = {};
  let descriptor = null;
  try {
    const parentStat = fs.lstatSync(parent);
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
      return { ok: false, secrets: {}, error: "the box secret directory is not a regular directory" };
    }
    try {
      const targetStat = fs.lstatSync(secretsFile);
      if (targetStat.isSymbolicLink()) return { ok: false, secrets: {}, error: "the box secret path is a symbolic link" };
      if (!targetStat.isFile()) return { ok: false, secrets: {}, error: "the box secret path is not a regular file" };
      if (targetStat.nlink !== 1) return { ok: false, secrets: {}, error: "the box secret file has multiple hard links" };
    } catch (error) {
      if (error && error.code === "ENOENT") return { ok: true, secrets: {} };
      return { ok: false, secrets: {}, error: "the box secret path could not be inspected safely" };
    }
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    descriptor = fs.openSync(secretsFile, flags);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) return { ok: false, secrets: {}, error: "the box secret path is not a regular file" };
    if (stat.nlink !== 1) return { ok: false, secrets: {}, error: "the box secret file has multiple hard links" };
    if (stat.size > BOX_SECRETS_MAX_BYTES) {
      return { ok: false, secrets: {}, error: "the box secret file exceeds the 256 KiB safety limit" };
    }
    const lines = readBoundedSecrets(descriptor).split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].endsWith("\r") ? lines[index].slice(0, -1) : lines[index];
      if (line === "") continue;
      const split = line.indexOf("=");
      if (split < 0) {
        return { ok: false, secrets: {}, error: `the box secret file has a malformed entry at line ${index + 1}` };
      }
      const name = line.slice(0, split);
      const value = line.slice(split + 1);
      if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(name)) {
        return { ok: false, secrets: {}, error: `the box secret file has an invalid name at line ${index + 1}` };
      }
      if (!value.trim()) {
        return { ok: false, secrets: {}, error: `the box secret ${name} has an empty value` };
      }
      if (/[\0\x01-\x08\x0B-\x1F\x7F]/.test(value)) {
        return { ok: false, secrets: {}, error: `the box secret ${name} contains a forbidden control character` };
      }
      if (Object.prototype.hasOwnProperty.call(out, name)) {
        return { ok: false, secrets: {}, error: `the box secret file contains duplicate name ${name}` };
      }
      if (name === "GIT_PUSH_TOKEN") {
        return { ok: false, secrets: {}, error: "the box secret file contains gate-only name GIT_PUSH_TOKEN" };
      }
      out[name] = value;
    }
    return { ok: true, secrets: out };
  } catch (error) {
    if (error && error.code === "ENOENT") return { ok: true, secrets: {} };
    if (error && (error.code === "ELOOP" || error.code === "EMLINK")) {
      return { ok: false, secrets: {}, error: "the box secret path is a symbolic link" };
    }
    if (error && error.message === "BOX_SECRETS_TOO_LARGE") {
      return { ok: false, secrets: {}, error: "the box secret file exceeds the 256 KiB safety limit" };
    }
    return { ok: false, secrets: {}, error: "the box secret file could not be read safely" };
  } finally {
    if (descriptor !== null) { try { fs.closeSync(descriptor); } catch {} }
  }
}

const CREDENTIAL_NAMES = ["PIPEDREAM_PROJECT_ID", "PIPEDREAM_CLIENT_ID", "PIPEDREAM_CLIENT_SECRET"];

function credentialConfig(env = process.env) {
  const injected = env && env[BOX_SECRETS_INJECTED];
  if (injected && injected.error) {
    return { ok: false, why: "measurement cannot read the box key store safely (" + injected.error + ")" };
  }
  // The gate hands us an already-merged, freshly-read env and marks it above.
  // Standalone callers perform the same bounded no-follow read here.
  const loaded = injected ? { ok: true, secrets: {} } : boxSecrets(env || {});
  if (!loaded.ok) {
    return { ok: false, why: "measurement cannot read the box key store safely (" + loaded.error + ")" };
  }
  const stored = loaded.secrets;
  // The store wins over the environment, matching GEMINI_API_KEY and
  // KIMI_API_KEY: the 🔑 panel is the surface the operator was TOLD to use, so
  // a key saved there has to take effect rather than losing silently to a stale
  // value that was set once and forgotten. Trimmed because a store line carries
  // whatever whitespace was pasted with it.
  const read = (name) => String(stored[name] || env[name] || "").trim();
  const missing = CREDENTIAL_NAMES.filter((name) => !read(name));
  if (missing.length) {
    // BOTH places, named. "unset on this box" alone sent the operator looking
    // for a third location that does not exist.
    return { ok: false, why: "measurement is not connected yet -- unset on this box: " + missing.join(", ")
      + "; checked both this box's environment and the key store the 🔑 button writes ("
      + String((env && env.AGENTHOST_BOX_SECRETS_FILE) || BOX_SECRETS_DEFAULT_FILE) + ")" };
  }
  const cfg = {
    projectId: read("PIPEDREAM_PROJECT_ID"),
    clientId: read("PIPEDREAM_CLIENT_ID"),
    environment: String(stored.PIPEDREAM_ENVIRONMENT || env.PIPEDREAM_ENVIRONMENT || "production"),
  };
  // clientSecret stays on cfg -- proxyRequest's OAuth exchange needs it -- but
  // non-enumerable, so it never appears in a JSON.stringify of this result
  // (a log line, a debug dump, a returned response body).
  Object.defineProperty(cfg, "clientSecret", { value: read("PIPEDREAM_CLIENT_SECRET"), enumerable: false });
  return { ok: true, cfg };
}

// Short-lived Connect access token. This is OUR credential with Pipedream, not
// the customer's platform credential -- but it is still a secret, so it is
// cached privately and never appears in any returned value.
async function connectBearer({ cfg, fetchFn, state, now, signal }) {
  // clientSecret is non-enumerable on cfg, so a spread or clone -- `{...cfg}`,
  // `structuredClone(cfg)`, `JSON.parse(JSON.stringify(cfg))` -- drops it with no
  // error. Without this check the exchange would send an undefined secret and
  // Pipedream would answer 401, and we would report "Pipedream rejected this
  // box's credentials": provider-blame for our own bug. Name the real cause.
  if (!cfg.clientSecret) {
    return { ok: false, why: "the Pipedream client secret is missing from this config -- it is non-enumerable, so copying cfg by spread or clone drops it silently" };
  }
  // A live rotation must take effect immediately, not after the old bearer's
  // hour-long TTL. Only the digest is retained; raw config values are not.
  const configIdentity = bearerConfigIdentity(cfg);
  const cached = state.bearer;
  if (cached && cached.token && cached.configIdentity === configIdentity
    && cached.expiresAt - BEARER_SKEW_MS > now) return { ok: true, token: cached.token };
  let res;
  try {
    res = await fetchFn(`${PIPEDREAM_API_HOST}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        scope: PIPEDREAM_SERVER_SCOPE,
      }),
      signal,
    });
  } catch (e) {
    if (wasAborted(e, signal)) return { ok: false, why: "authenticating with Pipedream was cancelled because the call exceeded its time budget" };
    return { ok: false, why: "could not reach Pipedream for authentication ("
      + redactFailureText((e && e.message) || e, [cfg.projectId, cfg.clientId, cfg.clientSecret, cached && cached.token]).slice(0, 120) + ")" };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { ok: false, why: "Pipedream rejected this box's credentials (" + res.status + "): "
      + redactFailureText(body, [cfg.projectId, cfg.clientId, cfg.clientSecret, cached && cached.token]).slice(0, 160) };
  }
  const data = await res.json().catch(() => null);
  const token = data && data.access_token;
  if (!token) return { ok: false, why: "Pipedream returned no access token" };
  const ttlMs = Math.max(0, Number(data.expires_in || 3600) * 1000);
  state.bearer = { token, expiresAt: now + ttlMs, configIdentity };
  return { ok: true, token };
}

// An abort must arrive as a NAMED cause, never as a raw rejection: the caller
// is a timer, and "AbortError" on its own reads like a bug rather than the
// deliberate cancellation it is.
function wasAborted(e, signal) {
  return !!((signal && signal.aborted) || (e && (e.name === "AbortError" || e.name === "TimeoutError")));
}

// The accounts read, given a bearer that has already been obtained. Returns the
// connected-account ID and a human LABEL and nothing else -- never a credential
// field, and the URL never carries include_credentials (which only yields a
// usable token for a CUSTOM OAuth app this build deliberately does not require).
//
// ONE PAGE, deliberately, and this is its limit. Pipedream paginates this
// endpoint with a cursor; this build asks for the largest page it allows and
// does not follow a cursor. A client with MORE than `limit` connected accounts
// for a SINGLE provider would have a credential beyond the first page, and
// proxyRequest would refuse it by name -- "is not among the N connected
// accounts" -- and keep refusing hourly. That refusal is at least honest and
// self-naming (Rule 16), and N equal to the limit is the signal that the page
// was full. Follow the cursor when a real client is anywhere near it; a
// two-Meta-credential client, which is the case this pack was built for, is
// two orders of magnitude away.
async function readConnectedAccounts({ cfg, accountId, slug, headers, fetchFn, signal, limit = 100, failureSecrets = [] }) {
  const listUrl = `${PIPEDREAM_API_HOST}/connect/${cfg.projectId}/accounts`
    + `?external_user_id=${encodeURIComponent(accountId)}&app=${encodeURIComponent(slug)}`
    + `&limit=${encodeURIComponent(limit)}`;
  const list = await readJson(fetchFn, listUrl, { headers, signal }, "list connected accounts",
    [headers.Authorization, ...failureSecrets]);
  if (!list.ok) return list;
  if (!list.data || !Array.isArray(list.data.data)) {
    return { ok: false, why: "Pipedream returned a malformed connected-accounts list" };
  }
  const rows = list.data.data;
  const accounts = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row || typeof row !== "object" || typeof row.id !== "string"
        || !CONNECTED_ACCOUNT_ID_RE.test(row.id)) {
      return { ok: false, why: `Pipedream returned a malformed connected account at row ${index + 1}: id must match ${CONNECTED_ACCOUNT_ID_RE}` };
    }
    const candidate = row.name === undefined || row.name === null || row.name === ""
      ? (row.external_id === undefined || row.external_id === null || row.external_id === "" ? row.id : row.external_id)
      : row.name;
    if (typeof candidate !== "string" || candidate.length === 0
        || candidate.length > CONNECTED_ACCOUNT_LABEL_MAX || candidate !== candidate.trim()
        || /[\u0000-\u001f\u007f]/.test(candidate)) {
      return { ok: false, why: `Pipedream returned a malformed connected account at row ${index + 1}: label must be clean text no longer than ${CONNECTED_ACCOUNT_LABEL_MAX} characters` };
    }
    accounts.push({ id: row.id, label: candidate });
  }
  return { ok: true, accounts };
}

// The operator-facing list: which credentials has this client actually connected
// for this provider? This is how a human picks the right one when there are two.
// It is the ONLY thing standing between the operator and the arbitrary choice
// that used to be made for them.
async function listConnectedAccounts({ cfg, accountId, provider, fetchFn = fetch, state = moduleState, now = Date.now(), signal }) {
  const slug = PIPEDREAM_APP_SLUGS[String(provider)];
  if (!slug) return { ok: false, why: "no Pipedream app slug is mapped for provider '" + provider + "'" };
  const auth = await connectBearer({ cfg, fetchFn, state, now, signal });
  if (!auth.ok) return { ok: false, why: auth.why };
  const headers = { Authorization: "Bearer " + auth.token, "x-pd-environment": cfg.environment };
  return readConnectedAccounts({ cfg, accountId, slug, headers, fetchFn, signal,
    failureSecrets: [auth.token, cfg.projectId, cfg.clientId, cfg.clientSecret] });
}

// Mint a short-lived Connect token so the operator's browser can open
// Pipedream's hosted UI and connect an ad account. Scoped to
// external_user_id = accountId -- the SAME id the rest of measurement uses --
// which is what makes the resulting connection findable by
// listConnectedAccounts afterwards. Shape follows Attribyte's proven
// implementation (apps/api/src/integrations/pipedream-service.ts,
// createConnectToken): POST /tokens, then point the hosted UI at the app.
//
// The returned token IS a credential. It goes back to the authenticated
// operator because the browser needs it, and it is never logged or audited.
async function createConnectToken({ cfg, accountId, provider, successRedirectUri, errorRedirectUri, allowedOrigins, fetchFn = fetch, state = moduleState, now = Date.now(), signal }) {
  const slug = PIPEDREAM_APP_SLUGS[String(provider)];
  if (!slug) return { ok: false, why: "no Pipedream app slug is mapped for provider '" + provider + "'" };
  const auth = await connectBearer({ cfg, fetchFn, state, now, signal });
  if (!auth.ok) return { ok: false, why: auth.why };
  const headers = {
    Authorization: "Bearer " + auth.token,
    "x-pd-environment": cfg.environment,
    "Content-Type": "application/json",
  };
  // JSON.stringify drops undefined keys, so an absent redirect is simply not sent.
  const body = JSON.stringify({
    external_user_id: String(accountId),
    success_redirect_uri: successRedirectUri,
    error_redirect_uri: errorRedirectUri,
    allowed_origins: allowedOrigins,
    scope: PIPEDREAM_CONNECT_SCOPE,
    expires_in: PIPEDREAM_CONNECT_TTL_SECONDS,
  });
  const created = await readJson(
    fetchFn, `${PIPEDREAM_API_HOST}/connect/${cfg.projectId}/tokens`,
    { method: "POST", headers, body, signal }, "create a Connect token",
    [headers.Authorization, auth.token, cfg.projectId, cfg.clientId, cfg.clientSecret],
  );
  if (!created.ok) return created;
  const token = created.data && created.data.token;
  const link = created.data && created.data.connect_link_url;
  // Half an answer is worse than a refusal: without the link the operator has
  // nothing to open, and without the token the link cannot authenticate.
  if (!token || !link) {
    return { ok: false, why: "Pipedream returned no Connect token or no connect link, so there is nothing for the operator to open" };
  }
  const connectLinkUrl = link + (String(link).includes("?") ? "&" : "?") + "app=" + encodeURIComponent(slug);
  return { ok: true, token, expiresAt: (created.data && created.data.expires_at) || null, connectLinkUrl };
}

async function proxyRequest({ cfg, accountId, provider, pipedreamAccountId, targetUrl, method = "GET", fetchFn = fetch, state = moduleState, now = Date.now(), signal }) {
  const slug = PIPEDREAM_APP_SLUGS[String(provider)];
  if (!slug) {
    return { ok: false, why: "no Pipedream app slug is mapped for provider '" + provider + "'" };
  }
  // WHICH credential. This used to be list.data.data[0] -- the first account
  // Pipedream happened to return for (external_user_id, app) -- so a client with
  // two Meta credentials got an arbitrary one, unrelated to the ad account whose
  // facts were being stored, and could read the wrong permitted set with nothing
  // anywhere reporting it. There is no fallback on purpose: an unrecorded choice
  // refuses, it does not guess.
  const chosen = String(pipedreamAccountId || "");
  if (!chosen) {
    return { ok: false, why: "this " + provider + " connection does not record WHICH connected account it means, so no credential can be chosen without guessing -- re-record it with POST /measurement/connections including pipedreamAccountId" };
  }

  const auth = await connectBearer({ cfg, fetchFn, state, now, signal });
  if (!auth.ok) return { ok: false, why: auth.why };
  const headers = { Authorization: "Bearer " + auth.token, "x-pd-environment": cfg.environment };

  // The recorded choice is still VERIFIED against what Pipedream currently has:
  // a credential that was disconnected, revoked, or re-created has an id that no
  // longer resolves, and forwarding it would fail deep inside the provider call
  // with a cause nobody could act on.
  const listed = await readConnectedAccounts({
    cfg, accountId, slug, headers, fetchFn, signal,
    failureSecrets: [auth.token, cfg.projectId, cfg.clientId, cfg.clientSecret],
  });
  if (!listed.ok) return listed;
  if (!listed.accounts.length) return { ok: false, why: "no connected " + provider + " account for this workspace" };
  if (!listed.accounts.some((a) => a.id === chosen)) {
    return { ok: false, why: "the recorded " + provider + " credential '" + chosen + "' is not among the " + listed.accounts.length + " connected accounts for this client -- it was disconnected, revoked, or belongs to someone else; pick it again from GET /measurement/available-connections" };
  }

  const proxyUrl = `${PIPEDREAM_API_HOST}/connect/${cfg.projectId}/proxy/${Buffer.from(String(targetUrl)).toString("base64url")}`
    + `?external_user_id=${encodeURIComponent(accountId)}&account_id=${encodeURIComponent(chosen)}`;
  const proxied = await readJson(fetchFn, proxyUrl, { method, headers, signal }, "read " + provider,
    [headers.Authorization, auth.token, cfg.projectId, cfg.clientId, cfg.clientSecret, chosen]);
  if (!proxied.ok) return proxied;
  return { ok: true, data: proxied.data };
}

// One place that turns a fetch outcome into either data or a named cause.
// Cardinal Rule 16: a failure carries the provider's own words, bounded.
async function readJson(fetchFn, url, init, what, secrets = []) {
  let res;
  try {
    res = await fetchFn(url, init);
  } catch (e) {
    if (wasAborted(e, init && init.signal)) {
      return { ok: false, why: "the call to " + what + " was cancelled because it exceeded its time budget" };
    }
    return { ok: false, why: "could not reach Pipedream to " + what + " ("
      + redactFailureText((e && e.message) || e, secrets).slice(0, 120) + ")" };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { ok: false, why: "Pipedream refused to " + what + " (" + res.status + "): "
      + redactFailureText(body, secrets).slice(0, 160) };
  }
  const data = await res.json().catch(() => null);
  if (!data) return { ok: false, why: "Pipedream returned an unreadable body for " + what };
  return { ok: true, data };
}

module.exports = { credentialConfig, proxyRequest, listConnectedAccounts, createConnectToken, PIPEDREAM_APP_SLUGS };
