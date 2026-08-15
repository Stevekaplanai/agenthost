// End-to-end secret-store tests against the REAL gate.js. The fixture uses an
// isolated HOME and an OS-selected port, then drives the same authenticated
// HTTP surface the dashboard uses. Values are deliberate canaries: their
// absence from responses, logs, and audit lines is part of the contract.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { stopChild } from "./child-process-helper.js";
import { mintOperatorSession } from "./operator-session-helper.js";

const require = createRequire(import.meta.url);
const { measurementEnv, measurementDepsForPath } = require("../container/gate.js");
const GATE = path.join(import.meta.dirname, "..", "container", "gate.js");
const KEY = "gate-secret-test-key";

const values = {
  alphaOld: "alpha-old-secret-canary",
  alphaNew: "alpha-new-secret-canary",
  zeta: "zeta-secret-canary",
  project: "project-secret-canary",
  client: "client-secret-canary",
  clientSecret: "pipedream-secret-canary",
  environment: "development",
  deepseek: "deepseek-secret-canary",
};

let home;
let secretsDir;
let secretsFile;
let gate;
let base;
let cookie;
let deepseekTrace;
let gateOutput = "";
const responseBodies = [];

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "gatesecret-"));
  fs.mkdirSync(path.join(home, "work"), { recursive: true });
  fs.mkdirSync(path.join(home, ".agenthost"), { recursive: true });
  fs.writeFileSync(path.join(home, ".agenthost", "settings.json"), JSON.stringify({
    llm: { roster: {
      claude: { inChat: false }, codex: { inChat: false }, deepseek: { active: true, inChat: true },
      kimi: { inChat: false }, gemini: { inChat: false }, hermes: { inChat: false }, cursor: { inChat: false },
    } },
  }));
  secretsDir = path.join(home, "box-secrets");
  secretsFile = path.join(secretsDir, "secrets.env");
  fs.mkdirSync(secretsDir);
  let hardeningMarker = null;
  const gateArgs = [GATE];
  deepseekTrace = path.join(home, "deepseek-fetch.jsonl");
  fs.writeFileSync(deepseekTrace, "");
  const preload = path.join(home, "gate-test-preload.cjs");
  const preloadLines = [
    'const fs = require("node:fs");',
    'const originalFetch = global.fetch;',
    'global.fetch = async function (url, options = {}) {',
    '  if (String(url) !== "https://api.deepseek.com/v1/chat/completions") return originalFetch(url, options);',
    '  const body = JSON.parse(String(options.body || "{}"));',
    '  fs.appendFileSync(process.env.DEEPSEEK_FETCH_TRACE, JSON.stringify({ url: String(url), model: body.model, maxCompletionTokens: body.max_completion_tokens, authorized: /^Bearer [^\\s]+$/.test(String((options.headers || {}).Authorization || "")) }) + "\\n");',
    '  const frames = [',
    '    "data: " + JSON.stringify({ choices: [{ delta: { content: "DEEPSEEK_TEST_REPLY" } }] }) + "\\n\\n",',
    '    "data: " + JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 7, completion_tokens: 11 } }) + "\\n\\n",',
    '    "data: [DONE]\\n\\n",',
    '  ].join("");',
    '  return new Response(frames, { status: 200, headers: { "content-type": "text/event-stream" } });',
    '};',
  ];
  if (process.platform === "linux") {
    // A plain source checkout does not contain the release image's native
    // add-on. Preload a probe for that one fixed require so this end-to-end gate
    // still exercises (and proves) the non-dumpable startup call on Linux. The
    // production loader and its fail-closed absolute path remain untouched.
    hardeningMarker = path.join(home, "gate-hardening-called");
    preloadLines.push(...[
      'const Module = require("node:module");',
      "const originalLoad = Module._load;",
      "Module._load = function (request, parent, isMain) {",
      '  if (request === "/opt/agenthost/maintenance-native.node") {',
      "    return { setSelfNonDumpable() {",
      `      fs.writeFileSync(${JSON.stringify(hardeningMarker)}, "called\\n", { flag: "wx" });`,
      "      return true;",
      "    } };",
      "  }",
      "  return Reflect.apply(originalLoad, this, [request, parent, isMain]);",
      "};",
      "",
    ]);
  }
  fs.writeFileSync(preload, preloadLines.join("\n"));
  gateArgs.unshift("--require", preload);
  gate = spawn(process.execPath, gateArgs, {
    env: {
      ...process.env,
      HOME: home,
      AGENTHOST_BOX_SECRETS_FILE: secretsFile,
      TTYD_PASSWORD: KEY,
      AGENT_CHAT_BIN: process.execPath,
      GATE_PORT: "0",
      CHANNEL_DISPATCH_PORT: "0",
      KANBAN_BRIDGE_PORT: "0",
      CHANNEL_HEALTH_WATCH: "off",
      RESEND_API_KEY: "",
      PIPEDREAM_PROJECT_ID: "",
      PIPEDREAM_CLIENT_ID: "",
      PIPEDREAM_CLIENT_SECRET: "",
      PIPEDREAM_ENVIRONMENT: "",
      // The gate owns this credential. Measurement may receive ordinary box
      // secrets, but must never receive this inherited or stored name/value.
      GIT_PUSH_TOKEN: "gate-only-push-token-canary",
      DEEPSEEK_FETCH_TRACE: deepseekTrace,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("gate did not report a port: " + gateOutput)), 5000);
    const onData = (chunk) => {
      gateOutput += chunk.toString();
      const match = gateOutput.match(/listening on (\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    };
    gate.stdout.on("data", onData);
    gate.stderr.on("data", (chunk) => { gateOutput += chunk.toString(); });
    gate.on("exit", () => {
      clearTimeout(timer);
      reject(new Error("gate exited before listening: " + gateOutput));
    });
  });

  base = `http://127.0.0.1:${port}`;
  if (hardeningMarker) {
    assert.equal(fs.readFileSync(hardeningMarker, "utf8"), "called\n",
      "the Linux source-test probe must observe the same startup hardening call as the release native add-on");
  }
  cookie = (await mintOperatorSession(base, KEY)).cookie;
});

after(async () => {
  await stopChild(gate);
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

async function request(pathname, { auth = true, method = "GET", body } = {}) {
  const headers = {};
  if (auth) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET" && method !== "HEAD") {
    headers.origin = base;
    headers["sec-fetch-site"] = "same-origin";
  }
  const response = await fetch(base + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const text = await response.text();
  responseBodies.push(text);
  let json = null;
  if ((response.headers.get("content-type") || "").includes("application/json")) json = JSON.parse(text);
  return { status: response.status, text, json };
}

async function store(name, value) {
  return request("/secret", { method: "POST", body: { name, value } });
}

async function remove(name, auth = true) {
  return request("/secret", { auth, method: "DELETE", body: { name } });
}

test("measurement gets a fresh merged environment without the gate push credential", () => {
  const inherited = { KEEP_FROM_PROCESS: "yes", PIPEDREAM_PROJECT_ID: "stale", GIT_PUSH_TOKEN: "inherited-push" };
  const stored = { PIPEDREAM_PROJECT_ID: "fresh", PIPEDREAM_CLIENT_ID: "client", GIT_PUSH_TOKEN: "stored-push" };
  const result = measurementEnv(inherited, stored);
  assert.deepEqual(result, {
    KEEP_FROM_PROCESS: "yes",
    PIPEDREAM_PROJECT_ID: "fresh",
    PIPEDREAM_CLIENT_ID: "client",
  });
  assert.equal(Object.prototype.hasOwnProperty.call(result, "GIT_PUSH_TOKEN"), false);
  assert.equal(inherited.GIT_PUSH_TOKEN, "inherited-push", "the fresh merge does not mutate the gate process environment");
});

test("only owned measurement routes load measurement secrets", () => {
  let reads = 0;
  const loadEnv = () => {
    reads += 1;
    return { PIPEDREAM_PROJECT_ID: "project" };
  };

  assert.equal(measurementDepsForPath("/api/capabilities", loadEnv), null);
  assert.equal(measurementDepsForPath("/measurement/not-a-route", loadEnv), null);
  assert.equal(reads, 0, "unrelated and unknown paths never read the measurement credential store");

  for (const pathname of [
    "/measurement/status",
    "/measurement/connections",
    "/measurement/connections/mc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "/measurement/connections/mc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/facts",
    "/measurement/connect-token",
    "/measurement/available-connections",
    "/measurement/accounts/acme/facts",
  ]) {
    assert.deepEqual(measurementDepsForPath(pathname, loadEnv), {
      env: { PIPEDREAM_PROJECT_ID: "project" },
    });
  }
  assert.equal(reads, 7, "each owned measurement route reads the current credentials once");
});

test("library-mode measurementEnv safely reads the configured store without booting the gate", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gatesecret-lib-"));
  const dir = path.join(root, "protected");
  const file = path.join(dir, "secrets.env");
  fs.mkdirSync(dir);
  fs.writeFileSync(file, "PIPEDREAM_PROJECT_ID=p_lib\n");
  const script = [
    `process.env.AGENTHOST_BOX_SECRETS_FILE=${JSON.stringify(file)};`,
    `const {measurementEnv}=require(${JSON.stringify(GATE)});`,
    'const env=measurementEnv({KEEP:"yes",GIT_PUSH_TOKEN:"no"});',
    'process.stdout.write(JSON.stringify({keep:env.KEEP,project:env.PIPEDREAM_PROJECT_ID,push:Object.hasOwn(env,"GIT_PUSH_TOKEN")}));',
  ].join("");
  const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { keep: "yes", project: "p_lib", push: false });
});

test("the authenticated secret surface validates, stores, updates, lists, and never discloses values", async (t) => {
  const settingsFile = path.join(home, ".agenthost", "settings.json");
  const settingsBefore = fs.readFileSync(settingsFile);
  const flagOffSettings = await request("/api/settings");
  assert.equal(flagOffSettings.status, 200);
  assert.deepEqual(flagOffSettings.json.settings.agents.deepseek.limits, { perRunUsd: 1, perDayUsd: 5 },
    "flag-off display uses immutable protected defaults, never agent-written cap values");
  for (const attempt of [
    ["/api/settings", { method: "PUT", body: { set: { agents: { deepseek: { limits: { perRunUsd: 9 } } } } } }],
    ["/api/settings/reset", { method: "POST", body: { path: "agents.deepseek.limits.perRunUsd" } }],
    ["/api/settings/reset", { method: "POST", body: { path: "*" } }],
  ]) {
    const refused = await request(attempt[0], attempt[1]);
    assert.equal(refused.status, 503);
    assert.equal(refused.json.restartRequired, true);
    assert.match(refused.json.error, /protected spending limits/i);
    assert.deepEqual(fs.readFileSync(settingsFile), settingsBefore,
      "a refused protected-cap operation leaves the shared settings mirror byte-identical");
  }

  const unauthStatus = await request("/secret/status", { auth: false });
  assert.equal(unauthStatus.status, 401, "stored names are behind the operator cookie");
  const unauthWrite = await request("/secret", {
    auth: false,
    method: "POST",
    body: { name: "ALPHA_TOKEN", value: values.alphaOld },
  });
  assert.equal(unauthWrite.status, 401, "the write is behind the same cookie wall");
  const unauthDelete = await remove("DEEPSEEK_API_KEY", false);
  assert.equal(unauthDelete.status, 401, "secret removal is behind the same cookie wall");

  const empty = await request("/secret/status");
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.json, { ok: true, secrets: [] });

  const gateOnly = await store("GIT_PUSH_TOKEN", "must-never-enter-the-shared-store");
  assert.equal(gateOnly.status, 400);
  assert.match(gateOnly.json.error, /gate-only/);
  assert.equal(fs.existsSync(secretsFile), false,
    "refusing the gate credential must not create the agent-readable store");
  const gateOnlyDelete = await remove("GIT_PUSH_TOKEN");
  assert.equal(gateOnlyDelete.status, 400);
  assert.match(gateOnlyDelete.json.error, /gate-only/);

  const nul = await store("NUL_TOKEN", "left\0right");
  assert.equal(nul.status, 400);
  assert.match(nul.json.error, /null character/);
  assert.equal(fs.existsSync(secretsFile), false,
    "a value that cannot enter a child environment must not create the store");

  const symlinkVictim = path.join(home, "symlink-victim.txt");
  fs.writeFileSync(symlinkVictim, "victim must stay intact\n");
  let symlinkCreated = false;
  try {
    fs.symlinkSync(symlinkVictim, secretsFile, "file");
    symlinkCreated = true;
  } catch (error) {
    t.diagnostic(`symlink attack not exercised on this host: ${error.message}`);
  }
  if (symlinkCreated) {
    const planted = await store("PLANTED_TOKEN", "must-not-follow-the-link");
    assert.equal(planted.status, 409);
    assert.match(planted.json.error, /symbolic link/);
    assert.equal(fs.readFileSync(symlinkVictim, "utf8"), "victim must stay intact\n");
    fs.unlinkSync(secretsFile);
  }

  let hardlinkCreated = false;
  try {
    fs.linkSync(symlinkVictim, secretsFile);
    hardlinkCreated = true;
  } catch (error) {
    t.diagnostic(`hard-link attack not exercised on this host: ${error.message}`);
  }
  if (hardlinkCreated) {
    const hardlinked = await request("/secret/status");
    assert.equal(hardlinked.status, 500);
    assert.match(hardlinked.json.error, /multiple hard links/);
    assert.equal(hardlinked.text.includes("victim must stay intact"), false);
    fs.unlinkSync(secretsFile);
  }

  fs.writeFileSync(secretsFile, "A=" + "x".repeat(256 * 1024));
  const tooLargeToRead = await request("/secret/status");
  assert.equal(tooLargeToRead.status, 500);
  assert.match(tooLargeToRead.json.error, /256 KiB/);
  fs.unlinkSync(secretsFile);

  fs.writeFileSync(secretsFile, "this-is-not-an-entry\n");
  const malformed = await request("/secret/status");
  assert.equal(malformed.status, 500);
  assert.match(malformed.json.error, /malformed entry at line 1/);
  assert.equal(malformed.text.includes("this-is-not-an-entry"), false,
    "a corrupt line's contents never become an error message");

  const duplicateFirst = "duplicate-first-secret-canary";
  const duplicateSecond = "duplicate-second-secret-canary";
  fs.writeFileSync(secretsFile, `DUPLICATE_TOKEN=${duplicateFirst}\nDUPLICATE_TOKEN=${duplicateSecond}\n`);
  const duplicate = await request("/secret/status");
  assert.equal(duplicate.status, 500);
  assert.match(duplicate.json.error, /duplicate name DUPLICATE_TOKEN/);
  assert.equal(duplicate.text.includes(duplicateFirst), false);
  assert.equal(duplicate.text.includes(duplicateSecond), false);

  fs.writeFileSync(secretsFile, "EMPTY_TOKEN=\n");
  const emptyEntry = await request("/secret/status");
  assert.equal(emptyEntry.status, 500);
  assert.match(emptyEntry.json.error, /EMPTY_TOKEN has an empty value/);
  assert.equal(emptyEntry.text.includes('"present":true'), false,
    "NAME= is corrupt, never a configured credential");

  const diskControlValue = "control-secret-canary\rhidden";
  fs.writeFileSync(secretsFile, `CONTROL_TOKEN=${diskControlValue}\n`);
  const controlEntry = await request("/secret/status");
  assert.equal(controlEntry.status, 500);
  assert.match(controlEntry.json.error, /CONTROL_TOKEN contains a forbidden control character/);
  assert.equal(controlEntry.text.includes(diskControlValue), false);

  const diskPushValue = "stored-push-secret-canary";
  fs.writeFileSync(secretsFile, `GIT_PUSH_TOKEN=${diskPushValue}\n`);
  const storedGateOnly = await request("/secret/status");
  assert.equal(storedGateOnly.status, 500);
  assert.match(storedGateOnly.json.error, /gate-only name GIT_PUSH_TOKEN/);
  assert.equal(storedGateOnly.text.includes(diskPushValue), false);
  fs.unlinkSync(secretsFile);

  const badName = await store("bad-name", "not-stored");
  assert.equal(badName.status, 400);
  assert.match(badName.json.error, /name must be/i);

  const oversize = await store("OVERSIZE_TOKEN", "x".repeat(4097));
  assert.equal(oversize.status, 400);
  assert.match(oversize.json.error, /4096/);

  const newline = await store("NEWLINE_TOKEN", "must-be-refused\n");
  assert.equal(newline.status, 400, "a pasted line break is refused, even at the edge of the value");
  assert.match(newline.json.error, /line break/i);

  const control = await store("CONTROL_TOKEN", "left\u0001right");
  assert.equal(control.status, 400);
  assert.match(control.json.error, /control character/i);

  let saved = await store("ZETA_TOKEN", values.zeta);
  assert.deepEqual(saved.json, { ok: true, name: "ZETA_TOKEN", updated: false });
  saved = await store("ALPHA_TOKEN", values.alphaOld);
  assert.deepEqual(saved.json, { ok: true, name: "ALPHA_TOKEN", updated: false });
  saved = await store("alpha_token", values.alphaNew);
  assert.deepEqual(saved.json, { ok: true, name: "ALPHA_TOKEN", updated: true }, "names keep the existing uppercase normalization");
  saved = await store("DEEPSEEK_API_KEY", values.deepseek);
  assert.deepEqual(saved.json, { ok: true, name: "DEEPSEEK_API_KEY", updated: false });
  const deepseekChat = await request("/chat/stream?engine=deepseek&msg=hello");
  assert.equal(deepseekChat.status, 200);
  assert.match(deepseekChat.text, /DeepSeek protected spending controls require Foundation B\./,
    "flag-off chat names the protected-budget requirement instead of spending");
  const deepseekCalls = fs.readFileSync(deepseekTrace, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  assert.deepEqual(deepseekCalls, [],
    "a stored key cannot reach the provider while the gate-owned spending ledger is unavailable");
  const deepseekTeam = await request("/chat/stream?engine=team&msg=hello");
  assert.equal(deepseekTeam.status, 200);
  assert.match(deepseekTeam.text, /DeepSeek protected spending controls require Foundation B\./,
    "flag-off Team chat names the same protected-budget requirement");
  assert.equal(fs.readFileSync(deepseekTrace, "utf8"), "",
    "direct and Team paths both issue zero provider fetches without protected spending state");
  const removed = await remove("deepseek_api_key");
  assert.deepEqual(removed.json, { ok: true, name: "DEEPSEEK_API_KEY", deleted: true });
  const removedAgain = await remove("DEEPSEEK_API_KEY");
  assert.equal(removedAgain.status, 404);
  assert.equal(removedAgain.json.error, "DEEPSEEK_API_KEY is not stored on this box");
  const missingDeepSeek = await request("/chat/stream?engine=deepseek&msg=hello");
  assert.equal(missingDeepSeek.status, 200);
  assert.match(missingDeepSeek.text, /DeepSeek key missing — add DEEPSEEK_API_KEY in Secrets\./,
    "removing the key is reflected by the reachable chat route immediately");

  for (const [name, value] of [
    ["PIPEDREAM_PROJECT_ID", values.project],
    ["PIPEDREAM_CLIENT_ID", values.client],
    ["PIPEDREAM_CLIENT_SECRET", values.clientSecret],
    ["PIPEDREAM_ENVIRONMENT", values.environment],
  ]) {
    saved = await store(name, value);
    assert.deepEqual(saved.json, { ok: true, name, updated: false });
  }

  const stored = Object.fromEntries(fs.readFileSync(secretsFile, "utf8").trim().split("\n").map((line) => {
    const split = line.indexOf("=");
    return [line.slice(0, split), line.slice(split + 1)];
  }));
  assert.deepEqual(stored, {
    ZETA_TOKEN: values.zeta,
    ALPHA_TOKEN: values.alphaNew,
    PIPEDREAM_PROJECT_ID: values.project,
    PIPEDREAM_CLIENT_ID: values.client,
    PIPEDREAM_CLIENT_SECRET: values.clientSecret,
    PIPEDREAM_ENVIRONMENT: values.environment,
  });
  assert.equal(Object.values(stored).includes(values.alphaOld), false, "an update replaces the old value");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(secretsFile).mode & 0o777, 0o600, "the deployed store is readable only by its owner");
  }

  const status = await request("/secret/status");
  assert.equal(status.status, 200);
  assert.deepEqual(status.json, {
    ok: true,
    secrets: [
      { name: "ALPHA_TOKEN", present: true },
      { name: "PIPEDREAM_CLIENT_ID", present: true },
      { name: "PIPEDREAM_CLIENT_SECRET", present: true },
      { name: "PIPEDREAM_ENVIRONMENT", present: true },
      { name: "PIPEDREAM_PROJECT_ID", present: true },
      { name: "ZETA_TOKEN", present: true },
    ],
  }, "status is sorted and reports presence only");

  const measurement = await request("/measurement/status");
  assert.equal(measurement.status, 200);
  assert.equal(measurement.json.connected, true,
    "Pipedream values stored after boot configure measurement on the very next read");

  const auditFile = path.join(home, ".claude", "agenthost", "audit.log");
  const audit = fs.readFileSync(auditFile, "utf8");
  assert.match(audit, /"event":"secret_added"/);
  assert.match(audit, /"event":"secret_updated"/);
  assert.match(audit, /"event":"secret_deleted"/);
  assert.match(audit, /DEEPSEEK_API_KEY/);
  assert.match(audit, /ALPHA_TOKEN/);
  assert.match(audit, /PIPEDREAM_CLIENT_SECRET/);

  const forbidden = [
    values.alphaOld, values.alphaNew, values.zeta, values.project, values.client, values.clientSecret,
    values.deepseek, duplicateFirst, duplicateSecond, diskControlValue, diskPushValue,
  ];
  const publicOutput = responseBodies.join("\n") + "\n" + audit + "\n" + gateOutput;
  for (const value of forbidden) {
    assert.equal(publicOutput.includes(value), false, `the value for ${value.slice(0, 8)}... never reaches a response, log, or audit line`);
  }
});
