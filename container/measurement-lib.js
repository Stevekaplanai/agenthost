// container/measurement-lib.js
// The Growth room's Attribution view reads these. Read-only by design: taking an
// ad action is spend, and spend gates to the operator under Rule 13.
//
// The store handle is INJECTED (getStore), not opened here. gate.js already
// opens the measurement SQLite file lazily via its own measurementStore()
// helper (used by measurementTick). A second independent openStore() call on
// the same file from this module would be a second handle on one SQLite
// database -- a real hazard, not a style choice -- so this module never calls
// openStore itself; it only imports ID_RE to validate route ids.
"use strict";
const { ID_RE, connectionId } = require("./measurement-store.js");
const { credentialConfig, listConnectedAccounts, createConnectToken } = require("./measurement-credentials.js");
const { PROVIDERS } = require("./measurement-adapters/index.js");

// The trust claim, stated where the operator connects an account -- not
// buried in a doc. The box reads ad data through Pipedream's proxy and never
// receives a platform OAuth token, so "not stored on this box" is literally
// true (see measurement-credentials.js header), not just reassuring.
const DISCLOSURE = "Ad-platform credentials are held by Pipedream Connect and are "
  + "not stored on this box. Measurement data is stored here, in your own cloud.";

// THE ONE BOUND on a Pipedream call, shared by the hourly tick (gate.js
// measurementTick) and by the two operator-facing routes below. It lives here
// rather than in gate.js because the routes had the identical defect the tick
// had already fixed, and a second copy of this device two files apart is
// exactly how the fix failed to reach them.
//
// Resolves rather than rejects, so the caller's existing {ok, why} path reports
// it like any other named failure instead of throwing into a timer.
// onTimeout fires BEFORE the losing branch is abandoned, and is what actually
// cancels the in-flight request. Racing alone left the real call running: it
// resolved later and wrote against a request that had already been answered.
// The callback is guarded because a throw here would replace a clean timeout
// with an unhandled rejection.
function measurementWithTimeout(promise, ms, what, onTimeout) {
  let timer;
  const capped = new Promise((resolve) => {
    timer = setTimeout(() => {
      if (typeof onTimeout === "function") { try { onTimeout(); } catch {} }
      resolve({ ok: false, why: what + " did not answer within " + Math.round(ms / 1000) + "s" });
    }, ms);
  });
  return Promise.race([promise, capped]).finally(() => clearTimeout(timer));
}

// An operator is watching a browser spinner, so the routes are bounded far
// tighter than the tick's 5 minutes -- nobody waits that long for a link.
const PIPEDREAM_ROUTE_TIMEOUT_MS = 30_000;

// Presence checks only, by name -- never a value. credentialConfig's cfg
// carries a non-enumerable clientSecret specifically so this can never leak
// through a payload built from it; statusPayload doesn't serialize cfg at all.
function statusPayload(env = process.env) {
  const c = credentialConfig(env);
  return c.ok
    ? { connected: true, credentialHolder: "pipedream", providers: [...PROVIDERS], disclosure: DISCLOSURE }
    : { connected: false, credentialHolder: "pipedream", providers: [...PROVIDERS], why: c.why, disclosure: DISCLOSURE };
}

const ACCOUNT_RE = /^\/measurement\/accounts\/([^/]+)\/facts$/;
const CONNECTION_RE = /^\/measurement\/connections\/([^/]+)$/;
const CONNECTION_FACTS_RE = /^\/measurement\/connections\/([^/]+)\/facts$/;

// The hourly reader and the operator disconnect route share this exact
// registry. Registering a controller is synchronous and happens immediately
// after the store's enabled re-check, so the request dispatcher cannot run a
// disconnect between the check and registration. Cleanup is identity-checked:
// an older finishing read cannot remove a newer controller for the same row.
const activeConnectionSyncs = new Map();
function trackConnectionSync(connection, controller) {
  const id = connectionId(connection);
  activeConnectionSyncs.set(id, controller);
  return () => {
    if (activeConnectionSyncs.get(id) === controller) activeConnectionSyncs.delete(id);
  };
}

function cancelConnectionSync(connection) {
  const controller = activeConnectionSyncs.get(connectionId(connection));
  if (!controller) return false;
  controller.abort(new Error("measurement connection was disconnected by the operator"));
  return true;
}

// A stored provider cause can name the exact Pipedream connected-account id
// when that credential was revoked or disconnected. That id is useful inside
// the sync boundary, but it is not part of the public connection contract and
// must not escape through lastError or the audit log. Redact only the exact
// value from this row; broad key-shaped scrubbing would destroy the real cause.
function redactConnectionCredential(value, pipedreamAccountId) {
  const message = String(value || "");
  const credentialId = String(pipedreamAccountId || "");
  const exactRedacted = credentialId
    ? message.split(credentialId).join("[credential id redacted]")
    : message;
  // Older stores can retain the previous credential's failure after the row is
  // reconnected with a new credential. The old exact value no longer exists on
  // the row, so recognize only the one legacy sentence this code emitted.
  return exactRedacted
    .replace(/(the recorded [a-z0-9._-]+ credential )'[^'\r\n]{1,64}'(?= is not among)/gi,
      "$1'[credential id redacted]'")
    .slice(0, 500);
}

// The hourly sweep starts from an enabled-row snapshot, but the real network
// boundary re-reads that row because its credential may have rotated. Sanitize
// returned and thrown causes HERE with that exact current id; the sweep then
// also removes any old id that was present on its snapshot.
async function currentCredentialSafeSync(current, start) {
  const safeCause = (value) => redactConnectionCredential(value, current && current.pipedreamAccountId);
  try {
    const result = await start();
    if (!result || typeof result !== "object") return result;
    let sanitized = result;
    if (result.why !== undefined && result.why !== null) {
      sanitized = { ...sanitized, why: safeCause(result.why) };
    }
    if (Array.isArray(result.skippedReasons)) {
      sanitized = { ...sanitized, skippedReasons: result.skippedReasons.map((reason) =>
        typeof reason === "string" ? safeCause(reason) : reason) };
    }
    return sanitized;
  } catch (error) {
    const cause = safeCause((error && error.message) || error)
      || "measurement sync failed without a reported cause";
    throw new Error(cause);
  }
}

function publicConnection(connection) {
  return {
    id: connection.id || connectionId(connection),
    accountId: connection.accountId,
    provider: connection.provider,
    sourceAccountId: connection.sourceAccountId,
    enabled: !!connection.enabled,
    lastSyncedAt: connection.lastSyncedAt || null,
    lastError: connection.lastError
      ? redactConnectionCredential(connection.lastError, connection.pipedreamAccountId)
      : null,
  };
}

// THE CARD-LINKED LENS IS GONE, on purpose. There was a per-card facts route
// (/measurement/accounts/:id/tasks/:tid/facts) reading a task_id that had no
// producer anywhere: the tick passes none and no card-triggered worker exists.
// Worse, task_id was part of a fact's UNIQUE identity while this account lens
// did not filter on it, so the day a card-triggered sync WAS wired the same
// account/day/metric would store a second row and every spend sum would
// silently double -- a plausible wrong number, which is the exact failure this
// pack exists to prevent. Deleted rather than half-wired until something real
// produces a card-linked sync (Cardinal Rules 6 and 18).
//
// The returned shape uses a NAMED id rather than a bare `id`: an earlier draft
// returned {kind, id} and the handler then dropped the account when reading it.
function routeFor(pathname) {
  const value = String(pathname || "");
  let m = ACCOUNT_RE.exec(value);
  if (m && ID_RE.test(m[1])) return { kind: "account", accountId: m[1] };
  m = CONNECTION_FACTS_RE.exec(value);
  if (m) return ID_RE.test(m[1])
    ? { kind: "connection-facts", connectionId: m[1] }
    : { kind: "invalid-connection", connectionId: m[1] };
  m = CONNECTION_RE.exec(value);
  if (m) return ID_RE.test(m[1])
    ? { kind: "connection", connectionId: m[1] }
    : { kind: "invalid-connection", connectionId: m[1] };
  return null;
}

// Configuration, not an ad action -- see the read-only note in handleMeasurement.
const CONNECTIONS_PATH = "/measurement/connections";
// THE OPERATOR JOURNEY, in the order it is walked:
//   1. POST /measurement/connect-token       -> open the returned link, connect at Pipedream
//   2. GET  /measurement/available-connections -> see what is now connected, pick one
//   3. POST /measurement/connections          -> record the choice, which the tick then reads
//   4. GET  /measurement/connections          -> what is connected, and which of them is failing
// Before these existed, step 1 and 2 had no surface at all: the only way to get
// a connection was to create a Pipedream connected account out of band and
// hand-post a row, so the whole pack was unreachable (Cardinal Rule 11).
const CONNECT_TOKEN_PATH = "/measurement/connect-token";
const AVAILABLE_PATH = "/measurement/available-connections";

// Validate the whole body and return either a clean connection or a NAMED
// refusal. Separate from the handler so the rules are readable and testable on
// their own, and so every refusal path is forced to carry a cause: "invalid"
// with no reason leaves the operator guessing which of four fields was wrong.
function connectionFromBody(body) {
  const b = (body && typeof body === "object") ? body : {};
  const accountId = String(b.accountId || "");
  if (!accountId) return { ok: false, why: "accountId is required: a connection that is not scoped to one agency client would mix two clients' spend into one meaningless ROAS" };
  if (!ID_RE.test(accountId)) return { ok: false, why: "accountId must match " + ID_RE };
  const provider = String(b.provider || "");
  if (!provider) return { ok: false, why: "provider is required; this box can read: " + PROVIDERS.join(", ") };
  // Refuse rather than accept-and-never-sync. A provider with no adapter saves
  // cleanly and then produces no fact forever, which is indistinguishable from
  // an account that simply had no spend.
  if (!PROVIDERS.includes(provider)) {
    return { ok: false, why: "no adapter is registered for provider '" + provider + "'; this box can read: " + PROVIDERS.join(", ") };
  }
  const sourceAccountId = String(b.sourceAccountId || "");
  if (!sourceAccountId) return { ok: false, why: "sourceAccountId is required: it names WHICH ad account on the provider this connection reads" };
  if (!ID_RE.test(sourceAccountId)) return { ok: false, why: "sourceAccountId must match " + ID_RE };
  // REQUIRED, and it is a different thing from sourceAccountId: that names the
  // ad account on the platform, this names the CREDENTIAL at Pipedream the box
  // reads it through. A client can have two Meta credentials; without this the
  // sync took whichever one Pipedream listed first and could silently read the
  // wrong permitted set. Get the id from GET /measurement/available-connections.
  const pipedreamAccountId = String(b.pipedreamAccountId || "");
  if (!pipedreamAccountId) return { ok: false, why: "pipedreamAccountId is required: it names WHICH connected credential at Pipedream this connection reads through, and a client can have more than one -- list them with GET " + AVAILABLE_PATH };
  if (!ID_RE.test(pipedreamAccountId)) return { ok: false, why: "pipedreamAccountId must match " + ID_RE };
  // Absent means enabled -- connecting an account you did not want synced is not
  // a thing anyone does. Present but not a boolean is refused rather than
  // coerced: the string "false" is truthy, and silently enabling a connection
  // the caller asked to disable is the worst possible reading of that input.
  if (b.enabled !== undefined && typeof b.enabled !== "boolean") {
    return { ok: false, why: "enabled must be true or false when given (a string like \"false\" is refused rather than read as true)" };
  }
  const enabled = b.enabled === undefined ? true : b.enabled;
  return { ok: true, connection: { accountId, provider, sourceAccountId, pipedreamAccountId, enabled } };
}

// Body rules for POST /measurement/connect-token, separate for the same reason
// connectionFromBody is: every refusal is forced to carry a cause.
function connectTokenFromBody(body) {
  const b = (body && typeof body === "object") ? body : {};
  const accountId = String(b.accountId || "");
  if (!accountId) return { ok: false, why: "accountId is required: the Connect token is scoped to one agency client, and that scope is what makes the resulting connection findable later" };
  if (!ID_RE.test(accountId)) return { ok: false, why: "accountId must match " + ID_RE };
  const provider = String(b.provider || "");
  if (!provider) return { ok: false, why: "provider is required; this box can read: " + PROVIDERS.join(", ") };
  if (!PROVIDERS.includes(provider)) {
    return { ok: false, why: "no adapter is registered for provider '" + provider + "'; this box can read: " + PROVIDERS.join(", ") };
  }
  // Optional, and passed straight to Pipedream. Refused when present but the
  // wrong type rather than coerced -- a redirect built from an object would send
  // the operator to the string "[object Object]" and look like a Pipedream fault.
  const request = { accountId, provider };
  for (const name of ["successRedirectUri", "errorRedirectUri"]) {
    if (b[name] === undefined) continue;
    if (typeof b[name] !== "string" || !b[name]) return { ok: false, why: name + " must be a non-empty string when given" };
    request[name] = b[name];
  }
  if (b.allowedOrigins !== undefined) {
    if (!Array.isArray(b.allowedOrigins) || b.allowedOrigins.some((o) => typeof o !== "string" || !o)) {
      return { ok: false, why: "allowedOrigins must be an array of non-empty strings when given" };
    }
    request.allowedOrigins = b.allowedOrigins;
  }
  return { ok: true, request };
}

// The query rules for GET /measurement/available-connections. Returns the cause
// of refusal, or null when the query is usable -- same "every refusal names its
// own field" discipline as connectionFromBody, in the shape a GET needs.
function availableQueryRefusal(accountId, provider) {
  if (!accountId) return "accountId is required: connected credentials are listed per agency client";
  if (!ID_RE.test(accountId)) return "accountId must match " + ID_RE;
  if (!provider) return "provider is required; this box can read: " + PROVIDERS.join(", ");
  if (!PROVIDERS.includes(provider)) {
    return "no adapter is registered for provider '" + provider + "'; this box can read: " + PROVIDERS.join(", ");
  }
  return null;
}

// getStore: a zero-arg function returning the shared store (or null if it could
// not be opened) -- gate.js passes its own measurementStore() helper so this
// handler and measurementTick share the one cached handle.
// readJsonBody: gate.js's own body parser, injected rather than reimplemented
// so the size cap, the JSON error text and the object-shape check are identical
// to every other POST route on the box.
// deps: the Pipedream calls, the environment, and the route time budget,
// injected so the two connect routes can be driven by a test with a fake
// instead of the network -- timeoutMs exists only so a test can prove the
// bound fires without waiting 30 real seconds. gate.js passes none of them and
// gets the real ones.
function handleMeasurement(url, req, res, sendJson, getStore, readJsonBody, deps = {}) {
  const env = deps.env || process.env;
  const pipedream = deps.pipedream || { listConnectedAccounts, createConnectToken };
  const timeoutMs = Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : PIPEDREAM_ROUTE_TIMEOUT_MS;
  const audit = typeof deps.audit === "function" ? deps.audit : () => {};
  const cancelConnection = typeof deps.cancelConnection === "function" ? deps.cancelConnection : cancelConnectionSync;
  // A Pipedream call is a promise inside a synchronous dispatcher. Its rejection
  // must become a named 500, never an unhandled rejection that answers nothing:
  // a request that hangs forever is the silence Rule 16 exists to stop.
  //
  // BOUNDED AND CANCELLED, with the tick's device rather than a second one.
  // Node's fetch has no default timeout, so a Pipedream endpoint that accepts
  // the connection and never answers left `res` never ended: the operator's
  // browser spun until its OWN timeout and showed a bare network error, every
  // retry leaked another pending promise and another held socket, and nothing
  // was audited or logged -- on the route the whole operator journey starts
  // with. The timeout RESOLVES so a response is always sent, and the abort
  // CANCELS so the losing branch stops existing instead of settling later
  // against a request that was already answered.
  //
  // `start` takes the signal rather than receiving a promise already in flight:
  // the signal has to reach the call, and a caller that built the promise first
  // would have nothing to cancel.
  const settle = (start, what, onOk) => {
    const controller = new AbortController();
    measurementWithTimeout(
      Promise.resolve(start(controller.signal)), timeoutMs, "Pipedream", () => controller.abort(),
    ).then((r) => {
      if (!r || !r.ok) return sendJson(res, 502, { error: what + ": " + ((r && r.why) || "Pipedream returned no result and no reason") });
      onOk(r);
    }).catch((e) => sendJson(res, 500, { error: what + ": " + String((e && e.message) || e).slice(0, 160) }));
  };

  // STEP 1 of the journey. Mints a Pipedream Connect token scoped to this
  // client and returns the hosted link the operator opens to connect their ad
  // account. Nothing on the box could do this before, which is why the pack had
  // no reachable starting point at all.
  if (url.pathname === CONNECT_TOKEN_PATH) {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "getting a Connect token is a POST to " + CONNECT_TOKEN_PATH });
      return true;
    }
    if (typeof readJsonBody !== "function") {
      sendJson(res, 500, { error: "measurement cannot read a request body here: no body parser was provided to the handler" });
      return true;
    }
    readJsonBody(req, res, (body) => {
      const parsed = connectTokenFromBody(body);
      if (!parsed.ok) return sendJson(res, 400, { error: parsed.why });
      const c = credentialConfig(env);
      if (!c.ok) return sendJson(res, 503, { error: c.why });
      settle(
        (signal) => pipedream.createConnectToken({ cfg: c.cfg, ...parsed.request, signal }),
        "a Connect token could not be created",
        // The token is a short-lived credential. It is returned because the
        // operator's browser needs it, and it is never logged or audited --
        // this response body is the only place it may appear.
        (r) => sendJson(res, 200, {
          token: r.token, expiresAt: r.expiresAt, connectLinkUrl: r.connectLinkUrl, disclosure: DISCLOSURE,
        }),
      );
    });
    return true;
  }

  // STEP 2. What has this client ACTUALLY connected? Id and human label only --
  // never a credential field, and never include_credentials (see
  // measurement-credentials.js). This is how the operator picks the right one
  // when a client has two credentials for the same provider.
  if (url.pathname === AVAILABLE_PATH) {
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "listing what a client has connected is a GET to " + AVAILABLE_PATH });
      return true;
    }
    const accountId = String(url.searchParams.get("accountId") || "");
    const provider = String(url.searchParams.get("provider") || "");
    const why = availableQueryRefusal(accountId, provider);
    if (why) {
      sendJson(res, 400, { error: why });
      return true;
    }
    const c = credentialConfig(env);
    if (!c.ok) {
      sendJson(res, 503, { error: c.why });
      return true;
    }
    settle(
      (signal) => pipedream.listConnectedAccounts({ cfg: c.cfg, accountId, provider, signal }),
      "the connected " + provider + " accounts could not be listed",
      (r) => sendJson(res, 200, { connections: r.accounts }),
    );
    return true;
  }

  // Connections are CONFIGURATION -- naming which ad account a client's box
  // should read. That is not an ad action and costs nothing, so the read-only
  // refusal below deliberately does not apply here. Nothing wrote a connection
  // before this route existed, so store.connections({enabled:true}) returned []
  // forever and the whole pipeline was inert with no surface to fix it from.
  if (url.pathname === CONNECTIONS_PATH) {
    // STEP 4, and the one that closes the loop. last_synced_at and last_error
    // are written on EVERY connection on EVERY hourly tick and had no reader at
    // all: this route refused GET, and /measurement/status answers
    // connected:true off the presence of three credential names alone, so it
    // says a client is connected while their credential has been revoked for a
    // week and every sync has failed since. Silence and success looked
    // identical, which is the failure Cardinal Rule 16 exists to stop -- and
    // there was also no way to ENUMERATE connections, so disabling one meant
    // remembering the exact accountId/provider/sourceAccountId triple.
    //
    // Ids and status ONLY. connectionRow already returns exactly this shape and
    // carries no credential: pipedreamAccountId is an identifier naming WHICH
    // connected account at Pipedream the row means, never a token -- the box
    // never holds a platform credential at all (measurement-credentials.js).
    if (req.method === "GET") {
      // accountId is OPTIONAL here, unlike the facts routes. Facts are scoped
      // because mixing two clients' spend produces a meaningless ROAS; this is
      // the operator's own configuration list, and an operator who cannot
      // remember which client is broken is exactly who needs to read it.
      const accountId = String(url.searchParams.get("accountId") || "");
      if (accountId && !ID_RE.test(accountId)) {
        sendJson(res, 400, { error: "accountId must match " + ID_RE });
        return true;
      }
      const store = getStore();
      if (!store) {
        sendJson(res, 500, { error: "measurement store is not available" });
        return true;
      }
      try {
        const all = store.connections({});
        const visible = accountId ? all.filter((c) => c.accountId === accountId) : all;
        sendJson(res, 200, { connections: visible.map(publicConnection) });
      } catch (e) {
        sendJson(res, 500, { error: "the connections could not be read: " + String((e && e.message) || e).slice(0, 160) });
      }
      return true;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "connecting an ad account is a POST to " + CONNECTIONS_PATH + ", and listing them is a GET" });
      return true;
    }
    if (typeof readJsonBody !== "function") {
      sendJson(res, 500, { error: "measurement cannot read a request body here: no body parser was provided to the handler" });
      return true;
    }
    const store = getStore();
    if (!store) {
      sendJson(res, 500, { error: "measurement store is not available" });
      return true;
    }
    readJsonBody(req, res, (body) => {
      const parsed = connectionFromBody(body);
      if (!parsed.ok) return sendJson(res, 400, { error: parsed.why });
      try {
        store.putConnection(parsed.connection);
        const saved = typeof store.connectionFor === "function"
          ? store.connectionFor(parsed.connection)
          : parsed.connection;
        sendJson(res, 200, { ok: true, connection: publicConnection(saved || parsed.connection) });
      } catch (e) {
        sendJson(res, 500, { error: "the connection could not be saved: " + String((e && e.message) || e).slice(0, 160) });
      }
    });
    return true;
  }
  // Claim the path first, THEN check the method. Matching on method here would
  // leave POST /measurement/status unclaimed, falling silently through to the
  // rest of the gate while every sibling route refuses a write with a reason.
  const isStatus = url.pathname === "/measurement/status";
  const route = isStatus ? null : routeFor(url.pathname);
  if (!isStatus && !route) return false;
  if (route && route.kind === "invalid-connection") {
    sendJson(res, 400, { error: "connection id must match " + ID_RE });
    return true;
  }
  if (route && (route.kind === "connection" || route.kind === "connection-facts")) {
    const store = getStore();
    if (!store) {
      sendJson(res, 500, { error: "measurement store is not available" });
      return true;
    }
    let connection;
    try {
      connection = store.connectionForId(route.connectionId);
    } catch (e) {
      sendJson(res, 500, { error: "the measurement connection could not be read: " + String((e && e.message) || e).slice(0, 160) });
      return true;
    }
    if (!connection) {
      sendJson(res, 404, { error: "measurement connection '" + route.connectionId + "' was not found on this box" });
      return true;
    }
    if (route.kind === "connection") {
      if (req.method !== "DELETE") {
        sendJson(res, 405, { error: "disconnecting an ad account is a DELETE to " + CONNECTIONS_PATH + "/:id" });
        return true;
      }
      try {
        const result = store.disconnectConnection(connection);
        if (!result.found) {
          sendJson(res, 404, { error: "measurement connection '" + route.connectionId + "' was not found on this box" });
          return true;
        }
        const inFlightCancelled = !!cancelConnection(connection);
        audit("measurement_connection_disconnected",
          `${connection.accountId}/${connection.provider}/${connection.sourceAccountId}: future reads stopped; in-flight read cancelled=${inFlightCancelled}`);
        sendJson(res, 200, {
          ok: true,
          connection: publicConnection(result.connection),
          inFlightCancelled,
          disclosure: "Future reads from this ad account are stopped on this box. This does not revoke OAuth access at the ad platform or credential provider.",
        });
      } catch (e) {
        sendJson(res, 500, { error: "the measurement connection could not be disconnected: " + String((e && e.message) || e).slice(0, 160) });
      }
      return true;
    }
    if (req.method === "GET") {
      try {
        sendJson(res, 200, {
          connectionId: route.connectionId,
          count: store.countFactsForConnection(connection),
          enabled: !!connection.enabled,
        });
      } catch (e) {
        sendJson(res, 500, { error: "the stored measurement facts could not be counted: " + String((e && e.message) || e).slice(0, 160) });
      }
      return true;
    }
    if (req.method !== "DELETE") {
      sendJson(res, 405, { error: "previewing stored facts is a GET and deleting them is a DELETE to " + CONNECTIONS_PATH + "/:id/facts" });
      return true;
    }
    try {
      const removed = store.deleteFactsForConnection(connection);
      audit("measurement_facts_deleted",
        `${connection.accountId}/${connection.provider}/${connection.sourceAccountId}: ${removed.deleted} stored fact${removed.deleted === 1 ? "" : "s"} deleted`);
      sendJson(res, 200, { ok: true, connectionId: route.connectionId, deleted: removed.deleted });
    } catch (e) {
      if (e && e.code === "MEASUREMENT_CONNECTION_ENABLED") {
        sendJson(res, 409, { error: String(e.message) });
      } else if (e && e.code === "MEASUREMENT_CONNECTION_NOT_FOUND") {
        sendJson(res, 404, { error: String(e.message) });
      } else {
        sendJson(res, 500, { error: "the stored measurement facts could not be deleted: " + String((e && e.message) || e).slice(0, 160) });
      }
    }
    return true;
  }
  // FACTS AND STATUS ONLY. The connections route above returned already, so
  // this refusal is unchanged in strength for everything it still covers: a
  // fact is a measurement of money that was spent, and writing one by hand
  // would let a number nobody measured enter the ledger.
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "measurement facts are read-only; recording an ad action is spend and gates to the operator" });
    return true;
  }
  if (isStatus) {
    // `env`, not process.env. This route defaulted to the real environment
    // while every sibling route used the injected one, so a test that supplied
    // a fake env got the developer's own -- and this status could pass or fail
    // on whatever happened to be exported in the shell that ran it.
    sendJson(res, 200, statusPayload(env));
    return true;
  }
  const store = getStore();
  if (!store) {
    sendJson(res, 500, { error: "measurement store is not available" });
    return true;
  }
  try {
    const facts = store.factsFor({
      accountId: route.accountId,
      since: url.searchParams.get("since") || undefined,
      until: url.searchParams.get("until") || undefined,
    });
    sendJson(res, 200, { facts });
  } catch (e) {
    sendJson(res, 500, { error: "measurement could not be read: " + String((e && e.message) || e).slice(0, 160) });
  }
  return true;
}

module.exports = {
  routeFor, handleMeasurement, statusPayload, connectionFromBody, connectTokenFromBody,
  availableQueryRefusal, measurementWithTimeout, publicConnection,
  trackConnectionSync, cancelConnectionSync, redactConnectionCredential, currentCredentialSafeSync,
  CONNECTIONS_PATH, CONNECT_TOKEN_PATH, AVAILABLE_PATH,
};
