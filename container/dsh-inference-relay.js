"use strict";

// Gate-owned DeepSeek credential relay. The untrusted harness sees only a
// pathname Unix socket and a dummy API key; this process owns the real key,
// fixes the only permitted origin, and asks the gate-owned budget capability
// for admission before every provider request.

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const { normalizeDeepSeekProviderUsage } = require("./deepseek-budget.js");

const DEEPSEEK_UPSTREAM_URL = "https://api.deepseek.com/chat/completions";
const RELAY_DIR = "/run/agenthost-dsh";
const PATH_KEY_FILE = `${RELAY_DIR}/.path-key`;
const RELAY_TOKEN_HEADER = "x-agenthost-relay-token";
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_TOKENS = 8192;
const HARD_REQUEST_MS = 6 * 60 * 1000;
// The gate ledger prices Flash's peak rates. Pro is deliberately absent: its
// peak rates are higher, so admitting it against Flash reservations would make
// the operator's hard USD ceiling false.
const ALLOWED_MODELS = new Set(["deepseek-v4-flash"]);

function namedError(cause, detail) {
  const error = new Error(cause + (detail ? `: ${String(detail).slice(0, 160)}` : ""));
  error.causeName = cause;
  return error;
}

function relayCapabilityForRun(runId, { readPathKey = fs.readFileSync } = {}) {
  if (typeof runId !== "string" || runId.length < 1 || runId.length > 256 || runId.includes("\0")) {
    throw namedError("dsh_relay_run_id_invalid");
  }
  let key;
  try { key = Buffer.from(readPathKey(PATH_KEY_FILE)); }
  catch (error) { throw namedError("dsh_relay_path_key_unavailable", error && error.code); }
  if (key.length !== 32) throw namedError("dsh_relay_path_key_invalid");
  const derive = (purpose) => crypto.createHmac("sha256", key)
    .update(`agenthost-dsh-${purpose}\0${runId}`, "utf8").digest("hex");
  return Object.freeze({
    socketPath: `${RELAY_DIR}/${derive("socket").slice(0, 40)}.sock`,
    relayToken: derive("relay-token"),
  });
}

function relaySocketPathForRun(runId, options) {
  return relayCapabilityForRun(runId, options).socketPath;
}

function validRelayToken(value, expected) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) return false;
  return crypto.timingSafeEqual(Buffer.from(value, "ascii"), Buffer.from(expected, "ascii"));
}

function upstreamTransportCause(error) {
  const value = error && error.cause && error.cause.code || error && error.code;
  const code = typeof value === "string"
    ? value.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 40)
    : "";
  return code ? `dsh_relay_upstream_${code}` : "dsh_relay_upstream_failed";
}

function sendJson(res, status, cause) {
  if (res.writableEnded) return;
  const body = JSON.stringify({ error: { message: cause, type: "agenthost_relay_error" } });
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
    "cache-control": "no-store",
    "x-agenthost-cause": cause,
  });
  res.end(body);
}

function readBody(req, limit = MAX_REQUEST_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let failed = false;
    req.on("data", (chunk) => {
      if (failed) return;
      const value = Buffer.from(chunk);
      total += value.length;
      if (total > limit) {
        failed = true;
        reject(namedError("dsh_relay_request_too_large"));
        // Drain without retaining bytes. Destroying the socket here races the
        // named 413 response and presents DSH with an opaque ECONNRESET.
        if (typeof req.resume === "function") req.resume();
        return;
      }
      chunks.push(value);
    });
    req.once("aborted", () => reject(namedError("dsh_relay_client_aborted")));
    req.once("error", (error) => reject(namedError("dsh_relay_request_read_failed", error && error.code)));
    req.once("end", () => { if (!failed) resolve(Buffer.concat(chunks, total)); });
  });
}

function normalizeRequest(body, admittedMaxTokens) {
  let parsed;
  try { parsed = JSON.parse(body.toString("utf8")); }
  catch { throw namedError("dsh_relay_request_json_invalid"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw namedError("dsh_relay_request_shape_invalid");
  }
  if (!ALLOWED_MODELS.has(parsed.model)) throw namedError("dsh_relay_model_denied");
  if (!Array.isArray(parsed.messages)) throw namedError("dsh_relay_messages_invalid");
  if (parsed.stream !== true) throw namedError("dsh_relay_stream_required");
  if (!Number.isSafeInteger(admittedMaxTokens) || admittedMaxTokens < 1) {
    throw namedError("dsh_relay_budget_admission_invalid");
  }
  const requested = Number.isSafeInteger(parsed.max_tokens) && parsed.max_tokens > 0
    ? parsed.max_tokens
    : admittedMaxTokens;
  return {
    ...parsed,
    model: parsed.model,
    stream: true,
    max_tokens: Math.min(requested, admittedMaxTokens, MAX_OUTPUT_TOKENS),
    stream_options: { include_usage: true },
  };
}

function usageFromEvent(line) {
  if (!line.startsWith("data:")) return undefined;
  const data = line.slice(5).trim();
  if (!data || data === "[DONE]") return undefined;
  let value;
  try { value = JSON.parse(data); } catch { return null; }
  if (!value || typeof value !== "object" || !Object.hasOwn(value, "usage")) return undefined;
  const usage = normalizeDeepSeekProviderUsage(value && value.usage);
  if (!usage) return null;
  return {
    promptTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
  };
}

function createDshInferenceRelay({
  runId,
  apiKey,
  budget,
  // Test seam only. The URL passed to this function is still the module's fixed
  // constant; callers cannot provide an alternate origin.
  fetchImpl = globalThis.fetch,
  serverFactory = http.createServer,
  readPathKey = fs.readFileSync,
  lstatSocket = fs.lstatSync,
  unlinkSocket = fs.unlinkSync,
  chmodSocket = fs.chmodSync,
  onFailure = () => {},
  socketPath = relaySocketPathForRun(runId, { readPathKey }),
} = {}) {
  if (typeof apiKey !== "string" || apiKey.length < 1) throw namedError("dsh_relay_api_key_missing");
  if (!budget || typeof budget.reserve !== "function" || typeof budget.settle !== "function"
      || typeof budget.cancel !== "function") throw namedError("dsh_relay_budget_capability_invalid");
  if (typeof fetchImpl !== "function") throw namedError("dsh_relay_transport_invalid");
  if (typeof onFailure !== "function") throw namedError("dsh_relay_failure_sink_invalid");
  const capability = relayCapabilityForRun(runId, { readPathKey });
  if (socketPath !== capability.socketPath) throw namedError("dsh_relay_socket_path_not_fixed");

  const active = new Set();
  let server = null;
  let closePromise = null;
  let cancelledCause = null;
  let failureCause = null;

  function markFailed(cause) {
    if (failureCause) return;
    failureCause = /^dsh_[a-z0-9_]{1,80}$/.test(String(cause))
      ? String(cause)
      : "dsh_relay_internal_failed";
    cancelledCause = failureCause;
    try { onFailure(Object.freeze({ runId, cause: failureCause })); } catch {}
  }

  function finalize(record, method, facts) {
    if (!record || !record.reservationId) return Promise.resolve();
    if (record.finalization) return record.finalization;
    record.finalization = (async () => {
      try {
        if (method === "settle") await budget.settle({ reservationId: record.reservationId, ...facts });
        else await budget.cancel({ reservationId: record.reservationId, ...facts });
      } catch {
        throw namedError(method === "settle"
          ? "dsh_relay_budget_settle_failed"
          : "dsh_relay_budget_cancel_failed");
      } finally {
        active.delete(record);
      }
    })();
    return record.finalization;
  }

  async function handleRequestInner(req, res) {
    if (cancelledCause) { sendJson(res, 503, cancelledCause); return; }
    if (req.method !== "POST" || req.url !== "/chat/completions") {
      sendJson(res, 404, "dsh_relay_route_denied");
      return;
    }
    if (!validRelayToken(req.headers && req.headers[RELAY_TOKEN_HEADER], capability.relayToken)) {
      sendJson(res, 403, "dsh_relay_capability_denied");
      return;
    }

    let raw;
    try { raw = await readBody(req); }
    catch (error) {
      sendJson(res, error && error.causeName === "dsh_relay_request_too_large" ? 413 : 400,
        (error && error.causeName) || "dsh_relay_request_read_failed");
      return;
    }

    let preview;
    try { preview = JSON.parse(raw.toString("utf8")); }
    catch { sendJson(res, 400, "dsh_relay_request_json_invalid"); return; }
    if (!preview || typeof preview !== "object" || Array.isArray(preview)
        || !ALLOWED_MODELS.has(preview.model) || !Array.isArray(preview.messages) || preview.stream !== true) {
      const cause = !preview || typeof preview !== "object" || Array.isArray(preview)
        ? "dsh_relay_request_shape_invalid"
        : !ALLOWED_MODELS.has(preview.model)
          ? "dsh_relay_model_denied"
          : !Array.isArray(preview.messages)
            ? "dsh_relay_messages_invalid"
            : "dsh_relay_stream_required";
      sendJson(res, 400, cause);
      return;
    }

    // Stop may arrive while the request body is still being read. Re-check at
    // the last point before admission so no new reservation can begin after it.
    if (cancelledCause) { sendJson(res, 503, cancelledCause); return; }

    let clientDisconnected = req.aborted === true || res.destroyed === true
      || Boolean(req.socket && req.socket.destroyed === true);
    const record = {
      reservationId: null,
      admissionPromise: null,
      controller: null,
      finalization: null,
      upstreamStarted: false,
    };
    const onDisconnect = () => {
      clientDisconnected = true;
      if (record.controller && !record.controller.signal.aborted) {
        record.controller.abort(namedError("dsh_relay_client_disconnected"));
      }
    };
    res.once("close", onDisconnect);
    if (clientDisconnected) {
      res.removeListener("close", onDisconnect);
      return;
    }
    active.add(record);
    record.admissionPromise = (async () => {
      const admission = await budget.reserve({
        runId,
        model: preview.model,
        requestBytes: raw.length,
        maxOutputTokens: Number.isSafeInteger(preview.max_tokens) && preview.max_tokens > 0
          ? Math.min(preview.max_tokens, MAX_OUTPUT_TOKENS)
          : MAX_OUTPUT_TOKENS,
      });
      if (!admission || typeof admission.reservationId !== "string" || !admission.reservationId
          || !Number.isSafeInteger(admission.maxOutputTokens) || admission.maxOutputTokens < 1) {
        throw namedError("dsh_relay_budget_admission_invalid");
      }
      record.reservationId = admission.reservationId;
      return admission;
    })();

    let admission;
    let reader = null;
    try {
      admission = await record.admissionPromise;
    } catch (error) {
      active.delete(record);
      res.removeListener("close", onDisconnect);
      const budgetScope = error && error.kind === "budget"
        ? error.scope === "per-run"
          ? "dsh_relay_budget_per_run_denied"
          : error.scope === "daily"
            ? "dsh_relay_budget_daily_denied"
            : null
        : null;
      const cause = cancelledCause || (error && error.causeName) || budgetScope || "dsh_relay_budget_denied";
      sendJson(res, cancelledCause ? 503 : cause === "dsh_relay_budget_admission_invalid" ? 500 : 429, cause);
      return;
    }

    if (cancelledCause || clientDisconnected) {
      const cause = cancelledCause || "dsh_relay_client_disconnected";
      await finalize(record, "cancel", { cause, ambiguous: false });
      res.removeListener("close", onDisconnect);
      if (!clientDisconnected) sendJson(res, 503, cause);
      return;
    }

    let outbound;
    try { outbound = normalizeRequest(raw, admission.maxOutputTokens); }
    catch (error) {
      await finalize(record, "cancel", { cause: error.causeName || "dsh_relay_request_invalid", ambiguous: false });
      sendJson(res, 400, error.causeName || "dsh_relay_request_invalid");
      return;
    }

    const controller = new AbortController();
    record.controller = controller;
    const hardTimer = setTimeout(() => controller.abort(namedError("dsh_relay_upstream_timeout")), HARD_REQUEST_MS);
    if (typeof hardTimer.unref === "function") hardTimer.unref();
    try {
      record.upstreamStarted = true;
      const upstream = await fetchImpl(DEEPSEEK_UPSTREAM_URL, {
        method: "POST",
        redirect: "manual",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify(outbound),
        signal: controller.signal,
      });
      if (!upstream || typeof upstream.status !== "number" || !upstream.body) {
        throw namedError("dsh_relay_upstream_response_invalid");
      }
      if (upstream.status < 200 || upstream.status >= 300) {
        const status = Number.isInteger(upstream.status) && upstream.status >= 100 && upstream.status <= 599
          ? upstream.status
          : "invalid";
        throw namedError(`dsh_relay_upstream_http_${status}`);
      }

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "close",
      });
      reader = upstream.body.getReader();
      let total = 0;
      let pending = "";
      let usage;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        total += chunk.length;
        if (total > MAX_RESPONSE_BYTES) throw namedError("dsh_relay_response_too_large");
        pending += chunk.toString("utf8");
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() || "";
        for (const line of lines) {
          const candidate = usageFromEvent(line);
          if (candidate !== undefined) usage = candidate;
        }
        res.write(chunk);
      }
      if (pending) {
        const candidate = usageFromEvent(pending);
        if (candidate !== undefined) usage = candidate;
      }
      if (!res.writableEnded) res.end();
      await finalize(record, "settle", { usage: usage || null, trusted: Boolean(usage) });
    } catch (error) {
      const cause = controller.signal.aborted
        ? ((controller.signal.reason && controller.signal.reason.causeName) || "dsh_relay_cancelled")
        : ((error && error.causeName) || upstreamTransportCause(error));
      if (!controller.signal.aborted) controller.abort(namedError(cause));
      if (reader && typeof reader.cancel === "function") {
        try { await reader.cancel(namedError(cause)); } catch {}
      }
      await finalize(record, "cancel", { cause, ambiguous: record.upstreamStarted });
      if (!res.headersSent) sendJson(res, 502, cause);
      else if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: { message: cause, type: "agenthost_relay_error" } })}\n\n`);
        res.end();
      }
    } finally {
      clearTimeout(hardTimer);
      res.removeListener("close", onDisconnect);
    }
  }

  async function handleRequest(req, res) {
    try { await handleRequestInner(req, res); }
    catch (error) {
      const cause = (error && error.causeName) || "dsh_relay_internal_failed";
      markFailed(cause);
      if (!res.headersSent) sendJson(res, 500, cause);
      else if (!res.writableEnded) res.end();
    }
  }

  function listen() {
    if (server) return Promise.reject(namedError("dsh_relay_already_listening"));
    try {
      const existing = lstatSocket(socketPath);
      if (!existing.isSocket()) throw namedError("dsh_relay_socket_path_occupied");
      unlinkSocket(socketPath);
    } catch (error) {
      if (error && error.code !== "ENOENT") return Promise.reject(error);
    }
    const created = serverFactory(handleRequest);
    server = created;
    created.maxConnections = 16;
    created.maxHeadersCount = 32;
    created.headersTimeout = 5000;
    created.requestTimeout = 15000;
    created.keepAliveTimeout = 1000;
    return new Promise((resolve, reject) => {
      let pending = true;
      let failed = false;
      created.on("error", (error) => {
        if (pending) {
          pending = false;
          if (server === created) server = null;
          reject(namedError("dsh_relay_listen_failed", error && error.code));
          return;
        }
        if (failed) return;
        failed = true;
        markFailed("dsh_relay_server_failed");
        void (async () => {
          try { await cancel("dsh_relay_server_failed"); } catch {}
          try { await close(); } catch {}
        })();
      });
      created.listen(socketPath, () => {
        if (!pending) return;
        pending = false;
        try { chmodSocket(socketPath, 0o660); }
        catch (error) {
          created.close();
          if (server === created) server = null;
          reject(namedError("dsh_relay_socket_mode_failed", error && error.code));
          return;
        }
        resolve(socketPath);
      });
    });
  }

  async function cancel(cause = "dsh_relay_cancelled") {
    const namedCause = /^dsh_[a-z0-9_]{1,80}$/.test(String(cause)) ? String(cause) : "dsh_relay_cancelled";
    cancelledCause = namedCause;
    const work = [];
    for (const record of active) {
      if (record.controller) record.controller.abort(namedError(namedCause));
      work.push((async () => {
        try { await record.admissionPromise; }
        catch { active.delete(record); return; }
        await finalize(record, "cancel", { cause: namedCause, ambiguous: record.upstreamStarted });
      })());
    }
    const results = await Promise.allSettled(work);
    if (results.some((result) => result.status === "rejected")) {
      markFailed("dsh_relay_cancel_accounting_failed");
      throw namedError("dsh_relay_cancel_accounting_failed");
    }
  }

  function close() {
    if (closePromise) return closePromise;
    const closing = server;
    let resolveClose;
    const pendingClose = new Promise((resolve) => { resolveClose = resolve; });
    closePromise = pendingClose;
    const done = () => {
      if (server === closing) server = null;
      closePromise = null;
      try {
        const stat = lstatSocket(socketPath);
        if (stat.isSocket()) unlinkSocket(socketPath);
      } catch {}
      resolveClose();
    };
    if (!closing) { done(); return pendingClose; }
    try { closing.close(done); } catch { done(); }
    return pendingClose;
  }

  return Object.freeze({
    socketPath,
    listen,
    cancel,
    close,
    failureCause: () => failureCause,
    _handleRequest: handleRequest,
  });
}

module.exports = {
  createDshInferenceRelay,
  relayCapabilityForRun,
  relaySocketPathForRun,
  DEEPSEEK_UPSTREAM_URL,
  RELAY_DIR,
  PATH_KEY_FILE,
  RELAY_TOKEN_HEADER,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  MAX_OUTPUT_TOKENS,
};
