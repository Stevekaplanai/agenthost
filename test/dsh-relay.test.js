import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import relayMod from "../container/dsh-inference-relay.js";

const {
  createDshInferenceRelay,
  relayCapabilityForRun,
  relaySocketPathForRun,
  DEEPSEEK_UPSTREAM_URL,
  MAX_RESPONSE_BYTES,
} = relayMod;

const TEST_PATH_KEY = Buffer.alloc(32, 0x5a);
const pathKeyOptions = { readPathKey: () => TEST_PATH_KEY };
const createTestRelay = (options) => createDshInferenceRelay({ ...options, ...pathKeyOptions });
const authorizedRequest = (runId, body, options = {}) => request(body, {
  ...options,
  headers: {
    ...(options.headers || {}),
    "x-agenthost-relay-token": relayCapabilityForRun(runId, pathKeyOptions).relayToken,
  },
});

function request(body, { method = "POST", url = "/chat/completions", headers = {} } = {}) {
  const req = Readable.from([Buffer.from(body)]);
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.aborted = false;
  return req;
}

function response() {
  const res = new EventEmitter();
  res.statusCode = null;
  res.headers = null;
  res.body = "";
  res.writableEnded = false;
  res.writeHead = (status, headers) => { res.statusCode = status; res.headers = headers; };
  res.write = (chunk) => { res.body += Buffer.from(chunk).toString("utf8"); return true; };
  res.end = (chunk) => {
    if (chunk !== undefined) res.body += Buffer.from(chunk).toString("utf8");
    res.writableEnded = true;
    res.emit("finish");
  };
  return res;
}

function budgetRecord() {
  const calls = [];
  return {
    calls,
    capability: {
      reserve: async (facts) => {
        calls.push(["reserve", facts]);
        return { reservationId: "reservation-1", maxOutputTokens: 2048 };
      },
      settle: async (facts) => { calls.push(["settle", facts]); },
      cancel: async (facts) => { calls.push(["cancel", facts]); },
    },
  };
}

test("relay uses one fixed DeepSeek origin, strips caller auth and settles trusted SSE usage", async () => {
  const runId = "run_relay_01";
  const budget = budgetRecord();
  const upstream = [];
  const fakeFetch = async (url, options) => {
    upstream.push({ url, options, body: JSON.parse(options.body) });
    const sse = [
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":7,"total_tokens":19}}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const relay = createTestRelay({
    runId,
    apiKey: "real-provider-key",
    budget: budget.capability,
    fetchImpl: fakeFetch,
  });
  const req = authorizedRequest(runId, JSON.stringify({
    model: "deepseek-v4-flash",
    messages: [{ role: "user", content: "hi" }],
    stream: true,
    max_tokens: 999999,
  }), { headers: { authorization: "Bearer attacker", "x-forwarded-host": "evil.test" } });
  const res = response();

  await relay._handleRequest(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(upstream.length, 1);
  assert.equal(upstream[0].url, DEEPSEEK_UPSTREAM_URL);
  assert.equal(upstream[0].options.redirect, "manual");
  assert.equal(upstream[0].options.headers.authorization, "Bearer real-provider-key");
  assert.equal(upstream[0].options.headers["x-forwarded-host"], undefined);
  assert.equal(upstream[0].body.max_tokens, 2048, "gate admission clamps model output before spend");
  assert.equal(upstream[0].body.stream_options.include_usage, true);
  assert.equal(budget.calls[0][0], "reserve");
  assert.deepEqual(budget.calls.at(-1), ["settle", {
    reservationId: "reservation-1",
    usage: { promptTokens: 12, outputTokens: 7, totalTokens: 19 },
    trusted: true,
  }]);
});

test("missing provider usage is settled as untrusted so the gate can charge the full reservation", async () => {
  const runId = "run_relay_02";
  const budget = budgetRecord();
  const relay = createTestRelay({
    runId,
    apiKey: "real-provider-key",
    budget: budget.capability,
    fetchImpl: async () => new Response('data: {"choices":[]}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
  });
  const req = authorizedRequest(runId, JSON.stringify({ model: "deepseek-v4-flash", messages: [], stream: true }));
  const res = response();

  await relay._handleRequest(req, res);

  assert.deepEqual(budget.calls.at(-1), ["settle", {
    reservationId: "reservation-1",
    usage: null,
    trusted: false,
  }]);
});

test("a malformed final usage frame invalidates an earlier valid frame and full-charges", async () => {
  const runId = "run_relay_malformed_final_usage";
  const budget = budgetRecord();
  const sse = [
    'data: {"choices":[],"usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":1}}\n\n',
    "data: [DONE]\n\n",
  ].join("");
  const relay = createTestRelay({
    runId,
    apiKey: "real-provider-key",
    budget: budget.capability,
    fetchImpl: async () => new Response(sse, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
  });
  const req = authorizedRequest(runId, JSON.stringify({ model: "deepseek-v4-flash", messages: [], stream: true }));
  const res = response();

  await relay._handleRequest(req, res);

  assert.deepEqual(budget.calls.at(-1), ["settle", {
    reservationId: "reservation-1",
    usage: null,
    trusted: false,
  }]);
});

test("relay rejects alternate paths/models before budget or network authority", async () => {
  const runId = "run_relay_03";
  const budget = budgetRecord();
  let fetched = false;
  const relay = createTestRelay({
    runId,
    apiKey: "real-provider-key",
    budget: budget.capability,
    fetchImpl: async () => { fetched = true; throw new Error("must not fetch"); },
  });

  const wrongPath = response();
  await relay._handleRequest(request("{}", { url: "http://metadata.internal/latest" }), wrongPath);
  assert.equal(wrongPath.statusCode, 404);

  for (const model of ["attacker/model", "deepseek-v4-pro"]) {
    const wrongModel = response();
    await relay._handleRequest(authorizedRequest(runId, JSON.stringify({ model, messages: [], stream: true })), wrongModel);
    assert.equal(wrongModel.statusCode, 400);
    assert.match(wrongModel.body, /dsh_relay_model_denied/);
  }
  assert.equal(fetched, false);
  assert.equal(budget.calls.length, 0);
});

test("relay rejects a discovered socket path without the per-run bearer before budget", async () => {
  const budget = budgetRecord();
  let fetched = false;
  const relay = createTestRelay({
    runId: "run_relay_unauthorized",
    apiKey: "real-provider-key",
    budget: budget.capability,
    fetchImpl: async () => { fetched = true; throw new Error("must not fetch"); },
  });
  const res = response();
  await relay._handleRequest(
    request(JSON.stringify({ model: "deepseek-v4-flash", messages: [], stream: true })),
    res,
  );
  assert.equal(res.statusCode, 403);
  assert.match(res.body, /dsh_relay_capability_denied/);
  assert.equal(budget.calls.length, 0);
  assert.equal(fetched, false);
});

test("operator Stop aborts an in-flight provider request and cancels its reservation", async () => {
  const runId = "run_relay_stop";
  const budget = budgetRecord();
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const relay = createTestRelay({
    runId,
    apiKey: "real-provider-key",
    budget: budget.capability,
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      markStarted();
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  });
  const res = response();
  const handling = relay._handleRequest(
    authorizedRequest(runId, JSON.stringify({ model: "deepseek-v4-flash", messages: [], stream: true })),
    res,
  );
  await started;
  await relay.cancel("dsh_operator_stop");
  await handling;

  const cancels = budget.calls.filter(([name]) => name === "cancel");
  assert.deepEqual(cancels, [["cancel", {
    reservationId: "reservation-1",
    cause: "dsh_operator_stop",
    ambiguous: true,
  }]]);
  assert.equal(res.statusCode, 502);
  assert.match(res.body, /dsh_operator_stop/);
});

test("operator Stop waits for and cancels a budget admission that is still pending", async () => {
  const runId = "run_relay_pending_stop";
  const calls = [];
  let resolveAdmission;
  let markReserveStarted;
  const reserveStarted = new Promise((resolve) => { markReserveStarted = resolve; });
  const admission = new Promise((resolve) => { resolveAdmission = resolve; });
  let fetched = false;
  const relay = createTestRelay({
    runId,
    apiKey: "real-provider-key",
    budget: {
      reserve: async (facts) => { calls.push(["reserve", facts]); markReserveStarted(); return admission; },
      settle: async (facts) => { calls.push(["settle", facts]); },
      cancel: async (facts) => { calls.push(["cancel", facts]); },
    },
    fetchImpl: async () => { fetched = true; throw new Error("must not fetch after Stop"); },
  });
  const res = response();
  const handling = relay._handleRequest(
    authorizedRequest(runId, JSON.stringify({ model: "deepseek-v4-flash", messages: [], stream: true })),
    res,
  );
  await reserveStarted;
  let stopReturned = false;
  const stopping = relay.cancel("dsh_operator_stop").then(() => { stopReturned = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopReturned, false, "Stop must retain authority until the pending reservation settles");

  resolveAdmission({ reservationId: "reservation-pending", maxOutputTokens: 512 });
  await stopping;
  await handling;

  assert.equal(fetched, false);
  assert.deepEqual(calls.filter(([name]) => name === "cancel"), [["cancel", {
    reservationId: "reservation-pending",
    cause: "dsh_operator_stop",
    ambiguous: false,
  }]]);
  assert.equal(res.statusCode, 503);
  assert.match(res.body, /dsh_operator_stop/);
});

test("client disconnect during pending admission cancels before any upstream spend", async () => {
  const runId = "run_relay_pending_disconnect";
  const calls = [];
  let resolveAdmission;
  let markReserveStarted;
  const reserveStarted = new Promise((resolve) => { markReserveStarted = resolve; });
  const admission = new Promise((resolve) => { resolveAdmission = resolve; });
  let fetched = false;
  const relay = createTestRelay({
    runId,
    apiKey: "real-provider-key",
    budget: {
      reserve: async () => { markReserveStarted(); return admission; },
      settle: async (facts) => { calls.push(["settle", facts]); },
      cancel: async (facts) => { calls.push(["cancel", facts]); },
    },
    fetchImpl: async () => { fetched = true; throw new Error("must not fetch"); },
  });
  const res = response();
  const handling = relay._handleRequest(
    authorizedRequest(runId, JSON.stringify({ model: "deepseek-v4-flash", messages: [], stream: true })),
    res,
  );
  await reserveStarted;
  res.emit("close");
  resolveAdmission({ reservationId: "reservation-disconnected", maxOutputTokens: 512 });
  await handling;

  assert.equal(fetched, false);
  assert.deepEqual(calls, [["cancel", {
    reservationId: "reservation-disconnected",
    cause: "dsh_relay_client_disconnected",
    ambiguous: false,
  }]]);
});

test("a disconnect completed before admission is observed without reserving spend", async () => {
  const runId = "run_relay_already_disconnected";
  let reserves = 0;
  const relay = createTestRelay({
    runId,
    apiKey: "real-provider-key",
    budget: {
      reserve: async () => { reserves += 1; throw new Error("must not reserve"); },
      settle: async () => {},
      cancel: async () => {},
    },
    fetchImpl: async () => { throw new Error("must not fetch"); },
  });
  const res = response();
  res.destroyed = true;
  await relay._handleRequest(
    authorizedRequest(runId, JSON.stringify({ model: "deepseek-v4-flash", messages: [], stream: true })),
    res,
  );
  assert.equal(reserves, 0);
});

test("accounting rejection becomes a named fail-closed relay state, never an unhandled promise", async () => {
  const runId = "run_relay_settle_failure";
  const failures = [];
  let fetches = 0;
  const relay = createTestRelay({
    runId,
    apiKey: "real-provider-key",
    budget: {
      reserve: async () => ({ reservationId: "reservation-ledger", maxOutputTokens: 512 }),
      settle: async () => { throw new Error("ledger write failed"); },
      cancel: async () => {},
    },
    onFailure: (failure) => failures.push(failure),
    fetchImpl: async () => {
      fetches += 1;
      return new Response('data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n\n');
    },
  });
  const first = response();
  await relay._handleRequest(
    authorizedRequest(runId, JSON.stringify({ model: "deepseek-v4-flash", messages: [], stream: true })),
    first,
  );
  assert.equal(relay.failureCause(), "dsh_relay_budget_settle_failed");
  assert.deepEqual(failures, [{ runId, cause: "dsh_relay_budget_settle_failed" }]);

  const second = response();
  await relay._handleRequest(
    authorizedRequest(runId, JSON.stringify({ model: "deepseek-v4-flash", messages: [], stream: true })),
    second,
  );
  assert.equal(second.statusCode, 503);
  assert.equal(fetches, 1, "a failed ledger permanently closes this relay to new spend");
});

test("oversized provider streams are actively cancelled before accounting closes", async () => {
  const runId = "run_relay_oversized_response";
  const budget = budgetRecord();
  let readerCancelled = 0;
  const reader = {
    read: async () => ({ done: false, value: Buffer.alloc(MAX_RESPONSE_BYTES + 1) }),
    cancel: async () => { readerCancelled += 1; },
  };
  const relay = createTestRelay({
    runId,
    apiKey: "real-provider-key",
    budget: budget.capability,
    fetchImpl: async () => ({ status: 200, body: { getReader: () => reader } }),
  });
  const res = response();

  await relay._handleRequest(
    authorizedRequest(runId, JSON.stringify({ model: "deepseek-v4-flash", messages: [], stream: true })),
    res,
  );

  assert.equal(readerCancelled, 1, "the provider body must be cancelled, not abandoned");
  assert.deepEqual(budget.calls.at(-1), ["cancel", {
    reservationId: "reservation-1",
    cause: "dsh_relay_response_too_large",
    ambiguous: true,
  }]);
});

test("relay socket names are deterministic, non-enumerating run-id digests", () => {
  const path = relaySocketPathForRun("run with unsafe / characters", pathKeyOptions);
  assert.match(path, /^\/run\/agenthost-dsh\/[a-f0-9]{40}\.sock$/);
  assert.equal(path.includes("unsafe"), false);
  assert.notEqual(path, relaySocketPathForRun("run with unsafe / characters", {
    readPathKey: () => Buffer.alloc(32, 0x6b),
  }), "the pathname is a boot-keyed capability, not a hash of a guessable run id");
});

test("budget denials retain the gate-owned ceiling that refused admission", async (t) => {
  for (const [scope, cause] of [
    ["per-run", "dsh_relay_budget_per_run_denied"],
    ["daily", "dsh_relay_budget_daily_denied"],
  ]) {
    await t.test(scope, async () => {
      const runId = `run_budget_${scope}`;
      const error = new Error("budget denied");
      error.kind = "budget";
      error.scope = scope;
      const relay = createTestRelay({
        runId,
        apiKey: "real-provider-key",
        budget: {
          reserve: async () => { throw error; },
          settle: async () => {},
          cancel: async () => {},
        },
        fetchImpl: async () => { throw new Error("must not fetch"); },
      });
      const res = response();
      await relay._handleRequest(
        authorizedRequest(runId, JSON.stringify({ model: "deepseek-v4-flash", messages: [], stream: true })),
        res,
      );
      assert.equal(res.statusCode, 429);
      assert.match(res.body, new RegExp(cause));
    });
  }
});

test("provider HTTP and transport failures retain bounded operational causes", async (t) => {
  for (const status of [401, 429, 500]) {
    await t.test(String(status), async () => {
      const runId = `run_http_${status}`;
      const relay = createTestRelay({
        runId,
        apiKey: "real-provider-key",
        budget: budgetRecord().capability,
        fetchImpl: async () => new Response("provider refused", { status }),
      });
      const res = response();
      await relay._handleRequest(
        authorizedRequest(runId, JSON.stringify({ model: "deepseek-v4-flash", messages: [], stream: true })),
        res,
      );
      assert.match(res.body, new RegExp(`dsh_relay_upstream_http_${status}`));
    });
  }

  await t.test("transport", async () => {
    const runId = "run_transport_failure";
    const transport = new Error("connection failed");
    transport.cause = Object.assign(new Error("dns"), { code: "ENOTFOUND" });
    const relay = createTestRelay({
      runId,
      apiKey: "real-provider-key",
      budget: budgetRecord().capability,
      fetchImpl: async () => { throw transport; },
    });
    const res = response();
    await relay._handleRequest(
      authorizedRequest(runId, JSON.stringify({ model: "deepseek-v4-flash", messages: [], stream: true })),
      res,
    );
    assert.match(res.body, /dsh_relay_upstream_enotfound/);
  });
});

test("relay bounds clients and fails closed on a post-listen server error", async () => {
  const runId = "run_server_failure";
  const failures = [];
  const server = new EventEmitter();
  let closes = 0;
  server.listen = (_path, callback) => callback();
  server.close = (callback) => { closes += 1; if (callback) callback(); };
  const notFound = () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); };
  const relay = createTestRelay({
    runId,
    apiKey: "real-provider-key",
    budget: budgetRecord().capability,
    serverFactory: () => server,
    lstatSocket: notFound,
    unlinkSocket: () => {},
    chmodSocket: () => {},
    onFailure: (failure) => failures.push(failure),
  });

  await relay.listen();
  assert.equal(server.maxConnections, 16);
  assert.equal(server.maxHeadersCount, 32);
  assert.equal(server.headersTimeout, 5000);
  assert.equal(server.requestTimeout, 15000);
  assert.equal(server.keepAliveTimeout, 1000);

  server.emit("error", Object.assign(new Error("listener failed"), { code: "EIO" }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(relay.failureCause(), "dsh_relay_server_failed");
  assert.deepEqual(failures, [{ runId, cause: "dsh_relay_server_failed" }]);
  assert.equal(closes, 1);
});
