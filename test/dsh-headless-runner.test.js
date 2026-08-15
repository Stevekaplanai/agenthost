import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import runnerMod from "../container/dsh-headless-runner.js";

const {
  buildDshArgv,
  readPrompt,
  readRunnerInput,
  relayRequestOptions,
  createLocalBridge,
  runHeadless,
  DSH_BIN,
  DSH_PATCH,
  JAIL_RELAY_SOCKET,
  MAX_PROMPT_BYTES,
} = runnerMod;

const TEST_RELAY_TOKEN = "a".repeat(64);

test("headless runner owns the exact CLI/profile/patch argv", () => {
  assert.deepEqual(buildDshArgv("--not-a-launcher-flag"), [
    process.execPath,
    DSH_BIN,
    "--profile", "headless",
    "--patch", DSH_PATCH,
    "--",
    "--not-a-launcher-flag",
  ]);
  for (const prompt of ["--patch=/workspace/evil.yml", "--profile=web"]) {
    assert.deepEqual(buildDshArgv(prompt).slice(-2), ["--", prompt],
      "known Commander options remain positional task text");
  }
  assert.equal(DSH_BIN, "/opt/deepseek-harness/apps/cli/lib/bin.js");
  assert.equal(DSH_PATCH, "/opt/agenthost/dsh-secure.patch.yml");
});

test("headless runner rejects empty and oversized prompt input with named causes", async () => {
  await assert.rejects(() => readPrompt(Readable.from([])), /dsh_prompt_empty/);
  await assert.rejects(() => readPrompt(Readable.from([Buffer.alloc(1025)]), 1024), /dsh_prompt_too_large/);
  assert.equal(await readPrompt(Readable.from(["one", " two"])), "one two");
  assert.equal(MAX_PROMPT_BYTES, 64 * 1024, "the stdin cap stays below Linux's single-argv E2BIG boundary");
});

test("runner consumes the relay capability frame before forming DSH task text", async () => {
  const framed = await readRunnerInput(Readable.from([`${TEST_RELAY_TOKEN}\n--patch=/workspace/evil.yml`]));
  assert.equal(framed.relayToken, TEST_RELAY_TOKEN);
  assert.equal(framed.prompt, "--patch=/workspace/evil.yml");
  assert.equal(buildDshArgv(framed.prompt).includes(TEST_RELAY_TOKEN), false);
  await assert.rejects(
    () => readRunnerInput(Readable.from([`not-a-token\nprompt`])),
    /dsh_relay_capability_frame_invalid/,
  );
});

test("local bridge always targets the mounted relay socket and never forwards DSH authorization", () => {
  const options = relayRequestOptions({
    "content-type": "application/json",
    accept: "text/event-stream",
    authorization: "Bearer dummy",
    host: "attacker",
    "x-forwarded-for": "127.0.0.1",
  }, 42, TEST_RELAY_TOKEN);
  assert.equal(options.socketPath, JAIL_RELAY_SOCKET);
  assert.equal(options.path, "/chat/completions");
  assert.equal(options.method, "POST");
  assert.deepEqual(options.headers, {
    "content-type": "application/json",
    accept: "text/event-stream",
    "content-length": "42",
    "x-agenthost-relay-token": TEST_RELAY_TOKEN,
  });
});

test("local bridge destroys its Unix-socket request when the DSH client disconnects", async () => {
  let created;
  let markCreated;
  const requestCreated = new Promise((resolve) => { markCreated = resolve; });
  const bridge = createLocalBridge({
    relayToken: TEST_RELAY_TOKEN,
    requestImpl: () => {
      const upstream = new EventEmitter();
      upstream.end = () => {};
      upstream.destroyCount = 0;
      upstream.destroy = (error) => {
        upstream.destroyCount += 1;
        setImmediate(() => upstream.emit("error", error));
      };
      created = upstream;
      markCreated();
      return upstream;
    },
  });
  const req = Readable.from([Buffer.from("{}")]);
  req.method = "POST";
  req.url = "/chat/completions";
  req.headers = { "content-type": "application/json" };
  const res = new EventEmitter();
  res.headersSent = false;
  res.writableEnded = false;
  res.writeHead = () => { res.headersSent = true; };
  res.write = () => true;
  res.end = () => { res.writableEnded = true; };

  const handling = bridge._handleRequest(req, res);
  await requestCreated;
  res.emit("close");
  await handling;

  assert.equal(created.destroyCount, 1,
    "a dead downstream must not leave a billable relay request running");
});

test("local bridge observes a completed disconnect before opening the billable relay", async () => {
  let requests = 0;
  const bridge = createLocalBridge({
    relayToken: TEST_RELAY_TOKEN,
    requestImpl: () => { requests += 1; throw new Error("must not open relay"); },
  });
  const req = Readable.from([Buffer.from("{}")]);
  req.method = "POST";
  req.url = "/chat/completions";
  req.headers = { "content-type": "application/json" };
  const res = new EventEmitter();
  res.destroyed = true;
  res.headersSent = false;
  res.writableEnded = false;
  res.writeHead = () => { res.headersSent = true; };
  res.write = () => true;
  res.end = () => { res.writableEnded = true; };

  await bridge._handleRequest(req, res);
  assert.equal(requests, 0);
});

test("local bridge names a mid-stream Unix relay failure instead of clean EOF", async () => {
  const relayResponse = new EventEmitter();
  relayResponse.statusCode = 200;
  relayResponse.headers = { "content-type": "text/event-stream" };
  const bridge = createLocalBridge({
    relayToken: TEST_RELAY_TOKEN,
    requestImpl: (_options, callback) => {
      const upstream = new EventEmitter();
      upstream.end = () => callback(relayResponse);
      return upstream;
    },
  });
  const req = Readable.from([Buffer.from("{}")]);
  req.method = "POST";
  req.url = "/chat/completions";
  req.headers = { "content-type": "application/json" };
  const res = new EventEmitter();
  res.headersSent = false;
  res.writableEnded = false;
  res.body = "";
  res.writeHead = () => { res.headersSent = true; };
  res.write = (chunk) => { res.body += String(chunk); return true; };
  res.end = () => { res.writableEnded = true; };

  const handling = bridge._handleRequest(req, res);
  await new Promise((resolve) => setImmediate(resolve));
  const failure = new Error("socket broke");
  failure.code = "EPIPE";
  relayResponse.emit("error", failure);
  await handling;

  assert.match(res.body, /dsh_bridge_relay_stream_failed_epipe/);
});

test("local bridge bounds loopback clients and contains post-listen server errors", async () => {
  const server = new EventEmitter();
  let closes = 0;
  server.listen = (_port, _host, callback) => callback();
  server.close = (callback) => { closes += 1; if (callback) callback(); };
  const bridge = createLocalBridge({
    relayToken: TEST_RELAY_TOKEN,
    serverFactory: () => server,
  });

  await bridge.listen();
  assert.equal(server.maxConnections, 16);
  assert.equal(server.maxHeadersCount, 32);
  assert.equal(server.headersTimeout, 5000);
  assert.equal(server.requestTimeout, 15000);
  assert.equal(server.keepAliveTimeout, 1000);

  const failure = new Error("listener failed");
  failure.code = "EIO";
  server.emit("error", failure);
  const named = await bridge.failure();
  assert.equal(named.causeName, "dsh_bridge_server_failed");
  assert.equal(bridge.failureCause(), "dsh_bridge_server_failed");
  assert.equal(closes, 1);
});

test("root bridge drops only the Harness child and scrubs its identity controls", async () => {
  const child = new EventEmitter();
  child.kill = () => true;
  let launch;
  const bridge = {
    listen: async () => {},
    close: async () => {},
    failure: () => new Promise(() => {}),
  };
  const env = {
    HOME: "/hm",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    DEEPSEEK_API_KEY: "agenthost-relay-not-a-real-key",
    DSH_RUN_AS_UID: "1001",
    DSH_RUN_AS_GID: "1002",
  };
  const running = runHeadless({
    input: Readable.from([`${TEST_RELAY_TOKEN}\nmake the change`]),
    bridge,
    env,
    spawn: (bin, args, options) => {
      launch = { bin, args, options };
      setImmediate(() => child.emit("close", 0, null));
      return child;
    },
  });

  assert.deepEqual(await running, { exitCode: 0, signalName: null });
  assert.equal(launch.bin, "/usr/bin/setpriv");
  assert.deepEqual(launch.args.slice(0, 6), [
    "--reuid=1001", "--regid=1002", "--init-groups", "--no-new-privs", "--", process.execPath,
  ]);
  assert.deepEqual(launch.args.slice(5), buildDshArgv("make the change"));
  assert.equal(Object.hasOwn(launch.options.env, "DSH_RUN_AS_UID"), false);
  assert.equal(Object.hasOwn(launch.options.env, "DSH_RUN_AS_GID"), false);
  assert.equal(JSON.stringify(launch).includes(TEST_RELAY_TOKEN), false);
});

test("a post-listen bridge failure stops the dropped child and exits named", async () => {
  const child = new EventEmitter();
  const kills = [];
  child.kill = (signal) => { kills.push(signal); return true; };
  let failBridge;
  let closes = 0;
  const bridgeFailure = new Promise((resolve) => { failBridge = resolve; });
  const bridge = {
    listen: async () => {},
    close: async () => { closes += 1; },
    failure: () => bridgeFailure,
  };
  const running = runHeadless({
    input: Readable.from([`${TEST_RELAY_TOKEN}\nmake the change`]),
    bridge,
    env: { DSH_RUN_AS_UID: "1001", DSH_RUN_AS_GID: "1001" },
    spawn: () => child,
  });
  await new Promise((resolve) => setImmediate(resolve));
  failBridge(Object.assign(new Error("dsh_bridge_server_failed"), {
    causeName: "dsh_bridge_server_failed",
  }));

  await assert.rejects(running, /dsh_bridge_server_failed/);
  assert.deepEqual(kills, ["SIGTERM"]);
  assert.equal(closes, 1);
});
