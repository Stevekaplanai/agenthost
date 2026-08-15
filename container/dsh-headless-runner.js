"use strict";

// Runs one audited DeepSeek Harness headless task inside the outer Bubblewrap
// jail. DSH can reach only this loopback HTTP bridge; the bridge can reach only
// the single gate-owned pathname Unix socket mounted into the jail.

const cp = require("node:child_process");
const http = require("node:http");

const DSH_BIN = "/opt/deepseek-harness/apps/cli/lib/bin.js";
const DSH_PATCH = "/opt/agenthost/dsh-secure.patch.yml";
const JAIL_RELAY_SOCKET = "/run/agenthost-dsh/relay.sock";
const BRIDGE_HOST = "127.0.0.1";
const BRIDGE_PORT = 18080;
const WORKSPACE = "/workspace";
// Linux counts the inner task against ARG_MAX when DSH receives its required
// positional argument. 64 KiB stays below the observed 128 KiB single-string
// E2BIG boundary with room for the fixed CLI argv and scrubbed environment.
const MAX_PROMPT_BYTES = 64 * 1024;
const MAX_BRIDGE_REQUEST_BYTES = 1024 * 1024;
const RELAY_TOKEN_HEADER = "x-agenthost-relay-token";
const RELAY_TOKEN_RE = /^[a-f0-9]{64}$/;

function namedError(cause, detail) {
  const error = new Error(cause + (detail ? `: ${String(detail).slice(0, 160)}` : ""));
  error.causeName = cause;
  return error;
}

function buildDshArgv(prompt) {
  return [
    process.execPath,
    DSH_BIN,
    "--profile", "headless",
    "--patch", DSH_PATCH,
    "--",
    String(prompt),
  ];
}

function buildDshEnv(source = process.env) {
  const fixed = [
    "HOME", "DSH_HOME", "PATH", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TERM",
    "NO_COLOR", "DSH_TELEMETRY_DISABLED", "DSH_PERMISSION_MODE", "DSH_TOOLS_MODE", "DEEPSEEK_API_KEY",
  ];
  const env = {};
  for (const name of fixed) {
    if (Object.prototype.hasOwnProperty.call(source, name)) env[name] = String(source[name]);
  }
  return env;
}

function runAsIdentity(source = process.env) {
  const uid = Number(source.DSH_RUN_AS_UID);
  const gid = Number(source.DSH_RUN_AS_GID);
  if (!Number.isInteger(uid) || uid <= 0 || !Number.isInteger(gid) || gid <= 0) {
    throw namedError("dsh_run_identity_invalid");
  }
  return Object.freeze({ uid, gid });
}

async function readPrompt(stream = process.stdin, limit = MAX_PROMPT_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    const value = Buffer.from(chunk);
    total += value.length;
    if (total > limit) throw namedError("dsh_prompt_too_large");
    chunks.push(value);
  }
  const prompt = Buffer.concat(chunks, total).toString("utf8");
  if (!prompt.trim()) throw namedError("dsh_prompt_empty");
  return prompt;
}

async function readRunnerInput(stream = process.stdin) {
  const framed = await readPrompt(stream, MAX_PROMPT_BYTES + 65);
  const newline = framed.indexOf("\n");
  if (newline !== 64) throw namedError("dsh_relay_capability_frame_invalid");
  const relayToken = framed.slice(0, newline);
  if (!RELAY_TOKEN_RE.test(relayToken)) throw namedError("dsh_relay_capability_frame_invalid");
  const prompt = framed.slice(newline + 1);
  if (!prompt.trim()) throw namedError("dsh_prompt_empty");
  if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) throw namedError("dsh_prompt_too_large");
  return Object.freeze({ relayToken, prompt });
}

function relayRequestOptions(headers, length, relayToken) {
  if (!RELAY_TOKEN_RE.test(String(relayToken || ""))) throw namedError("dsh_relay_capability_invalid");
  const contentType = typeof headers["content-type"] === "string"
    ? headers["content-type"].slice(0, 128)
    : "application/json";
  const accept = typeof headers.accept === "string" && headers.accept.includes("text/event-stream")
    ? "text/event-stream"
    : "application/json";
  return {
    socketPath: JAIL_RELAY_SOCKET,
    path: "/chat/completions",
    method: "POST",
    headers: {
      "content-type": contentType,
      accept,
      "content-length": String(length),
      [RELAY_TOKEN_HEADER]: relayToken,
    },
  };
}

function readBridgeBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let failed = false;
    req.on("data", (chunk) => {
      if (failed) return;
      const value = Buffer.from(chunk);
      total += value.length;
      if (total > MAX_BRIDGE_REQUEST_BYTES) {
        failed = true;
        reject(namedError("dsh_bridge_request_too_large"));
        // Keep draining the local request so DSH receives the named 413 rather
        // than an ECONNRESET from destroying its loopback socket.
        if (typeof req.resume === "function") req.resume();
        return;
      }
      chunks.push(value);
    });
    req.once("aborted", () => reject(namedError("dsh_bridge_client_aborted")));
    req.once("error", (error) => reject(namedError("dsh_bridge_request_read_failed", error && error.code)));
    req.once("end", () => { if (!failed) resolve(Buffer.concat(chunks, total)); });
  });
}

function bridgeFailure(res, status, cause) {
  if (res.writableEnded) return;
  const body = JSON.stringify({ error: { message: cause, type: "agenthost_bridge_error" } });
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
    "cache-control": "no-store",
    "x-agenthost-cause": cause,
  });
  res.end(body);
}

function bridgeStreamFailure(res, cause) {
  if (res.writableEnded) return;
  if (!res.headersSent) { bridgeFailure(res, 502, cause); return; }
  res.write(`data: ${JSON.stringify({ error: { message: cause, type: "agenthost_bridge_error" } })}\n\n`);
  res.end();
}

function transportCause(prefix, error) {
  const code = String(error && error.code || "unknown").toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 40);
  return `${prefix}_${code || "unknown"}`;
}

function createLocalBridge({ relayToken, requestImpl = http.request, serverFactory = http.createServer } = {}) {
  if (!RELAY_TOKEN_RE.test(String(relayToken || ""))) throw namedError("dsh_relay_capability_invalid");
  let failureCause = null;
  let resolveFailure;
  const failure = new Promise((resolve) => { resolveFailure = resolve; });
  const markFailed = (error) => {
    if (failureCause) return;
    failureCause = error && error.causeName
      ? error
      : namedError("dsh_bridge_server_failed", error && error.code);
    resolveFailure(failureCause);
  };
  async function handleRequest(req, res) {
    if (req.method !== "POST" || req.url !== "/chat/completions") {
      bridgeFailure(res, 404, "dsh_bridge_route_denied");
      return;
    }
    let body;
    try { body = await readBridgeBody(req); }
    catch (error) {
      bridgeFailure(res, error && error.causeName === "dsh_bridge_request_too_large" ? 413 : 400,
        (error && error.causeName) || "dsh_bridge_request_failed");
      return;
    }

    await new Promise((resolve) => {
      let upstream;
      let upstreamResponse;
      let downstreamClosed = req.aborted === true || res.destroyed === true
        || Boolean(req.socket && req.socket.destroyed === true);
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        res.removeListener("close", onDownstreamClose);
        req.removeListener("aborted", onDownstreamClose);
        resolve();
      };
      const onDownstreamClose = () => {
        downstreamClosed = true;
        const cause = namedError("dsh_bridge_client_disconnected");
        try { if (upstreamResponse && typeof upstreamResponse.destroy === "function") upstreamResponse.destroy(cause); } catch {}
        try { if (upstream && typeof upstream.destroy === "function") upstream.destroy(cause); } catch {}
        finish();
      };
      res.once("close", onDownstreamClose);
      req.once("aborted", onDownstreamClose);
      if (downstreamClosed) { finish(); return; }
      try {
        upstream = requestImpl(relayRequestOptions(req.headers || {}, body.length, relayToken), (relayResponse) => {
          upstreamResponse = relayResponse;
          if (downstreamClosed) {
            try { if (typeof relayResponse.destroy === "function") relayResponse.destroy(); } catch {}
            finish();
            return;
          }
          const status = Number.isInteger(relayResponse.statusCode) ? relayResponse.statusCode : 502;
          const contentType = typeof relayResponse.headers?.["content-type"] === "string"
            ? relayResponse.headers["content-type"].slice(0, 128)
            : "application/json";
          res.writeHead(status, { "content-type": contentType, "cache-control": "no-store", connection: "close" });
          relayResponse.on("data", (chunk) => res.write(chunk));
          relayResponse.once("end", () => { if (!res.writableEnded) res.end(); finish(); });
          relayResponse.once("error", (error) => {
            bridgeStreamFailure(res, transportCause("dsh_bridge_relay_stream_failed", error));
            finish();
          });
        });
      } catch (error) {
        bridgeFailure(res, 502, "dsh_bridge_relay_connect_failed");
        finish();
        return;
      }
      upstream.once("error", (error) => {
        if (!downstreamClosed && !res.headersSent) {
          bridgeFailure(res, 502, transportCause("dsh_bridge_relay_failed", error));
        } else if (!downstreamClosed && !res.writableEnded) {
          bridgeStreamFailure(res, transportCause("dsh_bridge_relay_failed", error));
        }
        finish();
      });
      upstream.end(body);
    });
  }

  let server = null;
  let closePromise = null;
  function listen() {
    if (server) return Promise.reject(namedError("dsh_bridge_already_listening"));
    const created = serverFactory(handleRequest);
    server = created;
    created.maxConnections = 16;
    created.maxHeadersCount = 32;
    created.headersTimeout = 5000;
    created.requestTimeout = 15000;
    created.keepAliveTimeout = 1000;
    return new Promise((resolve, reject) => {
      let pending = true;
      created.on("error", (error) => {
        if (pending) {
          pending = false;
          if (server === created) server = null;
          reject(namedError("dsh_bridge_listen_failed", error && error.code));
          return;
        }
        markFailed(namedError("dsh_bridge_server_failed", error && error.code));
        void close();
      });
      created.listen(BRIDGE_PORT, BRIDGE_HOST, () => {
        if (!pending) return;
        pending = false;
        resolve();
      });
    });
  }
  function close() {
    if (closePromise) return closePromise;
    const closing = server;
    if (!closing) return Promise.resolve();
    let resolveClose;
    const pendingClose = new Promise((resolve) => { resolveClose = resolve; });
    closePromise = pendingClose;
    const done = () => {
      if (server === closing) server = null;
      closePromise = null;
      resolveClose();
    };
    try { closing.close(done); } catch { done(); }
    return pendingClose;
  }
  return Object.freeze({
    listen,
    close,
    failure: () => failure,
    failureCause: () => failureCause && failureCause.causeName,
    _handleRequest: handleRequest,
  });
}

async function runHeadless({
  input = process.stdin,
  spawn = cp.spawn,
  bridge,
  env = process.env,
} = {}) {
  const { relayToken, prompt } = await readRunnerInput(input);
  const { uid, gid } = runAsIdentity(env);
  const activeBridge = bridge || createLocalBridge({ relayToken });
  await activeBridge.listen();
  const argv = buildDshArgv(prompt);
  let child;
  try {
    child = spawn("/usr/bin/setpriv", [
      `--reuid=${uid}`,
      `--regid=${gid}`,
      "--init-groups",
      "--no-new-privs",
      "--",
      ...argv,
    ], {
      cwd: WORKSPACE,
      env: buildDshEnv(env),
      stdio: ["ignore", "inherit", "inherit"],
    });
  } catch (error) {
    await activeBridge.close();
    throw namedError("dsh_process_spawn_failed", error && error.code);
  }

  const stop = (signal) => {
    try { child.kill(signal); } catch {}
  };
  const onTerm = () => stop("SIGTERM");
  const onInt = () => stop("SIGINT");
  process.once("SIGTERM", onTerm);
  process.once("SIGINT", onInt);
  try {
    const childResult = new Promise((resolve, reject) => {
      child.once("error", (error) => reject(namedError("dsh_process_failed", error && error.code)));
      child.once("close", (code, signal) => resolve({
        exitCode: Number.isInteger(code) ? code : signal ? 128 : 1,
        signalName: signal || null,
      }));
    });
    const bridgeFailure = typeof activeBridge.failure === "function"
      ? activeBridge.failure().then((error) => {
        stop("SIGTERM");
        throw error;
      })
      : new Promise(() => {});
    return await Promise.race([childResult, bridgeFailure]);
  } finally {
    process.removeListener("SIGTERM", onTerm);
    process.removeListener("SIGINT", onInt);
    await activeBridge.close();
  }
}

if (require.main === module) {
  runHeadless()
    .then(({ exitCode, signalName }) => {
      if (signalName) process.stderr.write(`[dsh-runner] dsh_process_signalled: ${signalName}\n`);
      process.exitCode = exitCode;
    })
    .catch((error) => {
      process.stderr.write(`[dsh-runner] ${(error && error.causeName) || "dsh_runner_failed"}: ${String(error && error.message || error).slice(0, 240)}\n`);
      process.exitCode = 1;
    });
}

module.exports = {
  buildDshArgv,
  buildDshEnv,
  runAsIdentity,
  readPrompt,
  readRunnerInput,
  relayRequestOptions,
  createLocalBridge,
  runHeadless,
  DSH_BIN,
  DSH_PATCH,
  JAIL_RELAY_SOCKET,
  BRIDGE_HOST,
  BRIDGE_PORT,
  WORKSPACE,
  MAX_PROMPT_BYTES,
};
