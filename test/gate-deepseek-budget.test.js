import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mintOperatorSession } from "./operator-session-helper.js";
import { stopChild } from "./child-process-helper.js";

const GATE = path.join(import.meta.dirname, "..", "container", "gate.js");
const KEY = "deepseek-protected-budget-test-key";

async function waitForGate(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("gate did not listen: " + output)), 8_000);
    const onData = (chunk) => {
      output += chunk.toString();
      const match = output.match(/listening on (\d+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve(Number(match[1]));
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`gate exited before listening (${code ?? signal}): ${output}`));
    });
  });
}

async function chat(base, cookie, engine, message, timezone, runId = "", signal) {
  const run = runId ? `&run=${encodeURIComponent(runId)}` : "";
  const response = await fetch(`${base}/chat/stream?engine=${engine}&tz=${timezone}${run}&msg=${encodeURIComponent(message)}`, {
    headers: { cookie }, signal,
  });
  return { status: response.status, text: await response.text() };
}

async function settingsRequest(base, cookie, method, pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      cookie,
      origin: base,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function waitForTrace(file, pattern) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const text = fs.readFileSync(file, "utf8");
    if (pattern.test(text)) return text;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`trace did not contain ${pattern}`);
}

async function waitForRunStatus(base, cookie, runId, expected) {
  const deadline = Date.now() + 5_000;
  let latest = null;
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/chat/runs/${runId}`, { headers: { cookie } });
    assert.equal(response.status, 200);
    latest = await response.json();
    if (latest.status === expected) return latest;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`run ${runId} stayed ${latest?.status || "unknown"}; expected ${expected}`);
}

test("protected direct and Team requests share one UTC daily ceiling", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-deepseek-budget-"));
  const home = path.join(root, "home");
  const settingsDir = path.join(home, ".agenthost");
  const secretsDir = path.join(root, "secrets");
  const secretsFile = path.join(secretsDir, "secrets.env");
  const budgetDir = path.join(root, "protected-budget");
  const authDir = path.join(root, "protected-auth");
  const traceFile = path.join(root, "fetches.jsonl");
  const preload = path.join(root, "deepseek-fetch.cjs");
  let gate;

  try {
    for (const directory of [path.join(home, "work"), settingsDir, secretsDir, budgetDir, authDir]) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(secretsFile, "DEEPSEEK_API_KEY=protected-budget-canary\n", { mode: 0o600 });
    fs.writeFileSync(traceFile, "");
    fs.writeFileSync(path.join(settingsDir, "settings.json"), JSON.stringify({
      llm: { roster: {
        claude: { inChat: false }, codex: { inChat: false }, deepseek: { active: true, inChat: true },
        kimi: { inChat: false }, gemini: { inChat: false }, hermes: { inChat: false }, cursor: { inChat: false },
      } },
      // This file belongs to the interactive agent and is deliberately hostile:
      // its cap values must never become paid-request authority.
      agents: { deepseek: { limits: { perRunUsd: 100, perDayUsd: 1000 } } },
    }));
    fs.writeFileSync(preload, [
      'const fs = require("node:fs");',
      'const realFetch = globalThis.fetch;',
      'globalThis.fetch = async (input, init = {}) => {',
      '  if (String(input) !== "https://api.deepseek.com/v1/chat/completions") return realFetch(input, init);',
      '  const body = JSON.parse(String(init.body || "{}"));',
      '  fs.appendFileSync(process.env.DEEPSEEK_FETCH_TRACE, JSON.stringify(body) + "\\n");',
      '  const frames = `data: {"choices":[{"delta":{"content":"DEEPSEEK_BUDGET_REPLY"}}]}\\n\\ndata: [DONE]\\n\\n`;',
      '  return new Response(frames, { status: 200, headers: { "content-type": "text/event-stream" } });',
      '};',
      '',
    ].join("\n"));

    gate = spawn(process.execPath, ["--require", preload, GATE], {
      env: {
        ...process.env,
        HOME: home,
        TTYD_PASSWORD: KEY,
        AGENTHOST_FOUNDATION_B: "1",
        AGENTHOST_BOX_SECRETS_FILE: secretsFile,
        AGENTHOST_DEEPSEEK_BUDGET_STATE_DIR: budgetDir,
        AGENTHOST_AUTH_STATE_DIR: authDir,
        DEEPSEEK_FETCH_TRACE: traceFile,
        GIT_PUSH_TOKEN: "",
        GATE_PORT: "0",
        CHANNEL_DISPATCH_PORT: "0",
        KANBAN_BRIDGE_PORT: "0",
        WAKE_CHECKIN: "off",
        CHANNEL_HEALTH_WATCH: "off",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const port = await waitForGate(gate);
    const base = `http://127.0.0.1:${port}`;
    const { cookie } = await mintOperatorSession(base, KEY);
    const message = "x".repeat(7_800);

    const limited = await settingsRequest(base, cookie, "PUT", "/api/settings", {
      set: { agents: { deepseek: { limits: { perRunUsd: 0.03, perDayUsd: 0.03 } } } },
    });
    assert.equal(limited.status, 200);
    assert.deepEqual(limited.body.settings.agents.deepseek.limits, { perRunUsd: 0.03, perDayUsd: 0.03 });
    const sharedMirror = JSON.parse(fs.readFileSync(path.join(settingsDir, "settings.json"), "utf8"));
    assert.deepEqual(sharedMirror.agents.deepseek.limits, { perRunUsd: 100, perDayUsd: 1000 },
      "cap-only settings writes never make the gate a writer into the agent-owned mirror");

    // A hostile agent can rewrite its own mirror, including just one cap leaf.
    // The gate must continue to display and enforce the protected pair.
    fs.writeFileSync(path.join(settingsDir, "settings.json"), JSON.stringify({
      llm: { roster: {
        claude: { inChat: false }, codex: { inChat: false }, deepseek: { active: true, inChat: true },
        kimi: { inChat: false }, gemini: { inChat: false }, hermes: { inChat: false }, cursor: { inChat: false },
      } },
      agents: { deepseek: { limits: { perDayUsd: 1000 } } },
    }));
    const visible = await settingsRequest(base, cookie, "GET", "/api/settings");
    assert.equal(visible.status, 200);
    assert.deepEqual(visible.body.settings.agents.deepseek.limits, { perRunUsd: 0.03, perDayUsd: 0.03 });

    const first = await chat(base, cookie, "deepseek", message, -900);
    assert.equal(first.status, 200);
    assert.match(first.text, /DEEPSEEK_BUDGET_REPLY/);
    const afterFirst = fs.readFileSync(traceFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    assert.equal(afterFirst.length, 1);
    assert.equal(afterFirst[0].model, "deepseek-v4-flash");
    assert.ok(Number.isSafeInteger(afterFirst[0].max_tokens) && afterFirst[0].max_tokens > 0);
    assert.equal(Object.hasOwn(afterFirst[0], "max_completion_tokens"), false);

    const second = await chat(base, cookie, "team", message, 900);
    assert.equal(second.status, 200);
    assert.match(second.text, /DeepSeek daily spending limit leaves no safe budget for this request/,
      "opposite browser timezones and a hostile high-cap mirror still hit the protected UTC ceiling");
    assert.equal(fs.readFileSync(traceFile, "utf8").trim().split("\n").filter(Boolean).length, 1,
      "the rejected second request makes no provider fetch");

    const partial = await settingsRequest(base, cookie, "PUT", "/api/settings", {
      set: { agents: { deepseek: { limits: { perRunUsd: 0.03 } } } },
    });
    assert.equal(partial.status, 200);
    assert.deepEqual(partial.body.settings.agents.deepseek.limits, { perRunUsd: 0.03, perDayUsd: 0.03 },
      "a partial operator update merges only with the protected current pair");
    const resetRun = await settingsRequest(base, cookie, "POST", "/api/settings/reset", {
      path: "agents.deepseek.limits.perRunUsd",
    });
    assert.equal(resetRun.status, 200);
    assert.deepEqual(resetRun.body.settings.agents.deepseek.limits, { perRunUsd: 1, perDayUsd: 0.03 },
      "a leaf reset changes only that protected cap");
    const restored = await settingsRequest(base, cookie, "PUT", "/api/settings", {
      set: { agents: { deepseek: { limits: { perRunUsd: 0.03 } } } },
    });
    assert.equal(restored.status, 200);
    assert.deepEqual(restored.body.settings.agents.deepseek.limits, { perRunUsd: 0.03, perDayUsd: 0.03 });

    fs.writeFileSync(path.join(budgetDir, "budget-state.json"), "{ corrupt protected state\n");
    const unavailable = await settingsRequest(base, cookie, "GET", "/api/settings");
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.body.settingsUnavailable, true);
    assert.equal(unavailable.body.restartRequired, true);
    assert.match(unavailable.body.error, /protected spending limits/i);
    const deniedAfterCorruption = await chat(base, cookie, "deepseek", "do not fetch", 0);
    assert.match(deniedAfterCorruption.text, /protected budget state could not be verified/i);
    assert.equal(fs.readFileSync(traceFile, "utf8").trim().split("\n").filter(Boolean).length, 1,
      "corrupt private authority never falls back to the hostile mirror or makes another fetch");
  } finally {
    await stopChild(gate, "SIGKILL");
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("SIGTERM aborts an in-flight Team provider call and durably full-charges it", {
  skip: process.platform === "win32" ? "POSIX signal delivery runs in Linux CI" : false,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-deepseek-shutdown-"));
  const home = path.join(root, "home");
  const settingsDir = path.join(home, ".agenthost");
  const secretsDir = path.join(root, "secrets");
  const secretsFile = path.join(secretsDir, "secrets.env");
  const budgetDir = path.join(root, "protected-budget");
  const authDir = path.join(root, "protected-auth");
  const traceFile = path.join(root, "fetches.jsonl");
  const preload = path.join(root, "deepseek-pending-fetch.cjs");
  const clientAbort = new AbortController();
  let gate;

  try {
    for (const directory of [path.join(home, "work"), settingsDir, secretsDir, budgetDir, authDir]) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(secretsFile, "DEEPSEEK_API_KEY=shutdown-budget-canary\n", { mode: 0o600 });
    fs.writeFileSync(traceFile, "");
    fs.writeFileSync(path.join(settingsDir, "settings.json"), JSON.stringify({
      llm: { roster: {
        claude: { inChat: false }, codex: { inChat: false }, deepseek: { active: true, inChat: true },
        kimi: { inChat: false }, gemini: { inChat: false }, hermes: { inChat: false }, cursor: { inChat: false },
      } },
      agents: { deepseek: { limits: { perRunUsd: 100, perDayUsd: 1000 } } },
    }));
    fs.writeFileSync(preload, [
      'const fs = require("node:fs");',
      'const realFetch = globalThis.fetch;',
      'globalThis.fetch = async (input, init = {}) => {',
      '  if (String(input) !== "https://api.deepseek.com/v1/chat/completions") return realFetch(input, init);',
      '  fs.appendFileSync(process.env.DEEPSEEK_FETCH_TRACE, "start\\n");',
      '  await new Promise((resolve, reject) => {',
      '    const stop = () => {',
      '      fs.appendFileSync(process.env.DEEPSEEK_FETCH_TRACE, "abort\\n");',
      '      const error = new Error("aborted"); error.name = "AbortError"; reject(error);',
      '    };',
      '    if (init.signal && init.signal.aborted) stop();',
      '    else if (init.signal) init.signal.addEventListener("abort", stop, { once: true });',
      '  });',
      '};',
      '',
    ].join("\n"));

    gate = spawn(process.execPath, ["--require", preload, GATE], {
      env: {
        ...process.env,
        HOME: home,
        TTYD_PASSWORD: KEY,
        AGENTHOST_FOUNDATION_B: "1",
        AGENTHOST_BOX_SECRETS_FILE: secretsFile,
        AGENTHOST_DEEPSEEK_BUDGET_STATE_DIR: budgetDir,
        AGENTHOST_AUTH_STATE_DIR: authDir,
        DEEPSEEK_FETCH_TRACE: traceFile,
        GIT_PUSH_TOKEN: "",
        GATE_PORT: "0",
        CHANNEL_DISPATCH_PORT: "0",
        KANBAN_BRIDGE_PORT: "0",
        WAKE_CHECKIN: "off",
        CHANNEL_HEALTH_WATCH: "off",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = new Promise((resolve) => gate.once("exit", (code, signal) => resolve({ code, signal })));
    const port = await waitForGate(gate);
    const base = `http://127.0.0.1:${port}`;
    const { cookie } = await mintOperatorSession(base, KEY);
    const runId = "shutdownbudget01";
    const responsePromise = chat(base, cookie, "team", "write a calm greeting", 0, runId, clientAbort.signal)
      .then((response) => ({ response }), (error) => ({ error }));
    await Promise.race([
      waitForTrace(traceFile, /start/),
      responsePromise.then((result) => {
        if (result.response) throw new Error("Team finished before provider start: " + result.response.text);
        throw result.error;
      }),
    ]);
    assert.equal(gate.kill("SIGTERM"), true);
    const terminal = await Promise.race([
      exited,
      new Promise((_, reject) => setTimeout(() => reject(new Error("gate did not exit after SIGTERM")), 5_000)),
    ]);
    assert.equal(terminal.code, 0, `gate exited via ${terminal.signal || terminal.code}`);
    const response = await Promise.race([
      responsePromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("chat subscriber did not close after gate exit")), 1_000)),
    ]);
    if (response.response) {
      assert.equal(response.response.status, 200);
      assert.match(response.response.text, /gateway restarted before this chat run recorded a trustworthy outcome/i);
    } else {
      assert.match(String(response.error && response.error.message), /terminated|ECONNRESET/i,
        "a live subscriber may observe the transport closing during process exit");
    }
    assert.match(await waitForTrace(traceFile, /abort/), /start\s+abort/,
      "shutdown reaches the Team cancel handler before process exit");

    const eventFile = path.join(home, ".claude", "agenthost", "chat-runs", `${runId}.events.jsonl`);
    const events = fs.readFileSync(eventFile, "utf8").split("\n").filter(Boolean).map(JSON.parse);
    assert.equal(events.filter((event) => String(event.frame || "").includes("event: done")).length, 1,
      "the durable chat transcript records exactly one terminal event");
    assert.match(events.at(-1).frame, /gateway restarted before this chat run recorded a trustworthy outcome/i);

    const saved = JSON.parse(fs.readFileSync(path.join(budgetDir, "budget-state.json"), "utf8"));
    const days = Object.values(saved.days);
    assert.equal(days.length, 1);
    assert.equal(days[0].reservations.length, 0, "the active worst-case reservation was settled");
    assert.ok(days[0].settledUsd > 0, "missing terminal usage was conservatively charged");
  } finally {
    clientAbort.abort();
    await stopChild(gate, "SIGKILL");
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

for (const engine of ["deepseek", "team"]) {
  test(`${engine} Cancel reports protected-accounting failure instead of false success`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `gate-deepseek-cancel-${engine}-`));
    const home = path.join(root, "home");
    const settingsDir = path.join(home, ".agenthost");
    const secretsDir = path.join(root, "secrets");
    const secretsFile = path.join(secretsDir, "secrets.env");
    const budgetDir = path.join(root, "protected-budget");
    const authDir = path.join(root, "protected-auth");
    const traceFile = path.join(root, "fetches.log");
    const preload = path.join(root, "deepseek-pending-fetch.cjs");
    let gate;

    try {
      for (const directory of [path.join(home, "work"), settingsDir, secretsDir, budgetDir, authDir]) {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      }
      fs.writeFileSync(secretsFile, "DEEPSEEK_API_KEY=cancel-budget-canary\n", { mode: 0o600 });
      fs.writeFileSync(traceFile, "");
      fs.writeFileSync(path.join(settingsDir, "settings.json"), JSON.stringify({
        llm: { roster: {
          claude: { inChat: false }, codex: { inChat: false }, deepseek: { active: true, inChat: true },
          kimi: { inChat: false }, gemini: { inChat: false }, hermes: { inChat: false }, cursor: { inChat: false },
        } },
      }));
      fs.writeFileSync(preload, [
        'const fs = require("node:fs");',
        'const realFetch = globalThis.fetch;',
        'globalThis.fetch = async (input, init = {}) => {',
        '  if (String(input) !== "https://api.deepseek.com/v1/chat/completions") return realFetch(input, init);',
        '  fs.appendFileSync(process.env.DEEPSEEK_FETCH_TRACE, "start\\n");',
        '  await new Promise((resolve, reject) => {',
        '    const stop = () => {',
        '      fs.appendFileSync(process.env.DEEPSEEK_FETCH_TRACE, "abort\\n");',
        '      const error = new Error("aborted"); error.name = "AbortError"; reject(error);',
        '    };',
        '    if (init.signal && init.signal.aborted) stop();',
        '    else if (init.signal) init.signal.addEventListener("abort", stop, { once: true });',
        '  });',
        '};',
        '',
      ].join("\n"));
      gate = spawn(process.execPath, ["--require", preload, GATE], {
        env: {
          ...process.env,
          HOME: home,
          TTYD_PASSWORD: KEY,
          AGENTHOST_FOUNDATION_B: "1",
          AGENTHOST_BOX_SECRETS_FILE: secretsFile,
          AGENTHOST_DEEPSEEK_BUDGET_STATE_DIR: budgetDir,
          AGENTHOST_AUTH_STATE_DIR: authDir,
          DEEPSEEK_FETCH_TRACE: traceFile,
          GIT_PUSH_TOKEN: "",
          GATE_PORT: "0",
          CHANNEL_DISPATCH_PORT: "0",
          KANBAN_BRIDGE_PORT: "0",
          WAKE_CHECKIN: "off",
          CHANNEL_HEALTH_WATCH: "off",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const port = await waitForGate(gate);
      const base = `http://127.0.0.1:${port}`;
      const { cookie } = await mintOperatorSession(base, KEY);
      const runId = `cancelbudget${engine}`;
      const responsePromise = chat(base, cookie, engine, "wait until stopped", 0, runId)
        .then((response) => response, (error) => ({ status: 0, text: String(error && error.message || error) }));
      await waitForTrace(traceFile, /start/);

      fs.writeFileSync(path.join(budgetDir, "budget-state.json"), "{ injected WAL failure\n");
      const cancel = await fetch(`${base}/chat/runs/${runId}/cancel`, {
        method: "POST",
        headers: { cookie, origin: base },
      });
      assert.equal(cancel.status, 200);
      const status = await waitForRunStatus(base, cookie, runId, "failed");
      assert.equal(status.status, "failed");
      const response = await Promise.race([
        responsePromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error("cancel response did not terminalize")), 2_000)),
      ]);
      assert.equal(response.status, 200);
      assert.match(response.text, /protected budget state could not be verified; restart is required/i);
      assert.doesNotMatch(response.text, /Chat run cancelled/i);
      assert.match(await waitForTrace(traceFile, /abort/), /start\s+abort/);

      const eventFile = path.join(home, ".claude", "agenthost", "chat-runs", `${runId}.events.jsonl`);
      const events = fs.readFileSync(eventFile, "utf8").split("\n").filter(Boolean).map(JSON.parse);
      const accountingEvents = events.filter((event) => /protected budget state could not be verified/i.test(event.frame));
      assert.equal(accountingEvents.length, 1, "the exact accounting cause terminalizes once");

      const retry = await chat(base, cookie, "deepseek", "must remain denied", 0);
      assert.match(retry.text, /protected budget state could not be verified/i);
      assert.equal(fs.readFileSync(traceFile, "utf8").trim().split("\n").filter((line) => line === "start").length, 1,
        "the poisoned authority makes no retry provider call");
    } finally {
      await stopChild(gate, "SIGKILL");
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
}
