// AI Assist must enrich an operator draft, respond through its own fast lane,
// and never trade speed for tool authority. Source contracts below cover the
// route/profile wiring; the lifecycle harness executes the exact runAssist body.

import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import engineAdapters from "../container/engine-adapters.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const gate = fs.readFileSync(path.join(here, "..", "container", "gate.js"), "utf8");
const assistUi = fs.readFileSync(
  path.join(here, "..", "dashboard", "components", "agenthost", "ai-assist.tsx"),
  "utf8",
);
const stopwatch = fs.readFileSync(path.join(here, "..", "scripts", "assist-stopwatch.mjs"), "utf8");
const runAssistSource = (() => {
  const start = gate.indexOf("function runAssist");
  // End at runAssist's OWN closing brace -- the first `}` in column 1 after it,
  // since every brace inside the function is indented. This used to slice to an
  // unrelated comment further down the file, so anything added between the two
  // landed inside the extracted source and the eval below died on it. Brand DNA
  // constants did exactly that. The boundary is now the function, not its
  // neighbours.
  // Line-ending agnostic on purpose: git stores LF, a Windows worktree holds
  // CRLF, and a bare "\n}\n" finds nothing there.
  const close = /\r?\n\}\r?\n/.exec(gate.slice(start));
  const end = close ? start + close.index + close[0].length : -1;
  assert.notEqual(start, -1, "runAssist is gone");
  assert.notEqual(end, -1, "runAssist boundary is gone");
  return gate.slice(start, end);
})();

function assistHarness({ timeoutMs = 100, maxChars = 32, foundationB = true, oauthToken = "" } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.written = "";
  child.stdin.ended = false;
  child.stdin.write = (chunk) => { child.stdin.written += String(chunk); return true; };
  child.stdin.end = (chunk) => {
    if (chunk !== undefined) child.stdin.written += String(chunk);
    child.stdin.ended = true;
  };
  child.terminationProven = true;
  const kills = [];
  child.kill = (signal) => { kills.push(signal); return true; };
  let quarantineHandler = null;
  let releases = 0;
  const context = {
    FOUNDATION_B: foundationB,
    ASSIST_TIMEOUT_MS: timeoutMs,
    ASSIST_MAX_CHARS: maxChars,
    assistLaneQuarantined: false,
    assistLaneQuarantineReason: "",
    activeAssistChild: null,
    acquireAssist: () => 1,
    releaseAssist: () => { if (!context.assistLaneQuarantined) releases += 1; },
    setAssistQuarantineHandler: (_token, handler) => { quarantineHandler = handler; return true; },
    quarantineAssistLane: (_token, reason) => {
      context.assistLaneQuarantined = true;
      context.assistLaneQuarantineReason = String(reason);
      try { child.kill("SIGKILL"); } catch {}
      if (quarantineHandler) quarantineHandler(reason);
      return true;
    },
    runViaChatSocket: () => {
      if (!foundationB) throw new Error("legacy Assist must spawn directly");
      return child;
    },
    devSpawn: (_bin, argv, options) => {
      if (foundationB) throw new Error("Foundation B must not spawn from gate");
      context.legacyLaunch = { argv, options };
      return child;
    },
    assistPrompt: () => "fixed prompt",
    assistSpawnArgs: () => {
      if (foundationB) throw new Error("Foundation B must use the root profile");
      return ["-p", "--safe-mode"];
    },
    assistEnv: () => ({
      CLAUDE_CODE_OAUTH_TOKEN: oauthToken,
      CLAUDE_CODE_DISABLE_THINKING: "1",
      MAX_THINKING_TOKENS: "0",
    }),
    CHAT_BIN: "claude",
    CHAT_CWD: "/work",
    engineAdapters,
    setTimeout,
    clearTimeout,
    Promise,
    String,
    Math,
  };
  const runAssist = vm.runInNewContext(`(${runAssistSource})`, context);
  return { runAssist, child, context, kills, releases: () => releases };
}

const route = (() => {
  const start = gate.indexOf('url.pathname === "/api/assist"');
  assert.notEqual(start, -1, "the /api/assist route is gone");
  return gate.slice(start, start + 4200);
})();

const writeAssistEvent = (() => {
  const start = gate.indexOf("function writeAssistEvent");
  const end = gate.indexOf("function settleAssistForShutdown", start);
  assert.notEqual(start, -1, "writeAssistEvent is gone");
  assert.notEqual(end, -1, "writeAssistEvent boundary is gone");
  return vm.runInNewContext(`(${gate.slice(start, end)})`, { JSON, String, Error });
})();

const settleAssistForShutdown = (() => {
  const start = gate.indexOf("function settleAssistForShutdown");
  const end = gate.indexOf("function runAssist", start);
  assert.notEqual(start, -1, "settleAssistForShutdown is gone");
  assert.notEqual(end, -1, "settleAssistForShutdown boundary is gone");
  return vm.runInNewContext(`(${gate.slice(start, end)})`, {
    setTimeout,
    clearTimeout,
    String,
  });
})();

const buildStopwatchEnv = (() => {
  const constantsStart = stopwatch.indexOf("const PRODUCT_ENV_NAMES");
  const functionEnd = stopwatch.indexOf("const draft", constantsStart);
  assert.notEqual(constantsStart, -1, "stopwatch env allowlist is gone");
  assert.notEqual(functionEnd, -1, "stopwatch env helper boundary is gone");
  const source = stopwatch.slice(constantsStart, functionEnd)
    .replace(/function buildStopwatchEnv/, "function buildStopwatchEnv");
  return vm.runInNewContext(`(() => { ${source}; return buildStopwatchEnv; })()`, {
    Object,
    process: { env: {}, platform: "linux" },
  });
})();

test("the empty-draft refusal lives on the server", () => {
  assert.match(route, /trimmed\.length < ASSIST_MIN_CHARS/);
  assert.match(route, /return sendJson\(res, 400,/);
  assert.match(gate, /const ASSIST_MIN_CHARS = \d+/);
});

test("the prompt forbids invention and has a fixed instruction for every surface", () => {
  const prompt = gate.slice(gate.indexOf("const ASSIST_SURFACES"), gate.indexOf("function runAssist"));
  assert.match(prompt, /may NOT invent facts/);
  assert.match(prompt, /may NOT change what I am asking for/);
  assert.match(prompt, /Keep my voice/);
  assert.match(prompt, /Return ONLY the improved text/);
  assert.doesNotMatch(prompt, /close to unchanged/,
    "the old prompt explicitly asked the model for the unchanged result operators disliked");
  for (const required of [
    "Tighten it. Do not pad it.",
    "what must change, where it must change, and how anyone will know it worked",
    "objective and audience",
    "state the durable fact, not the story",
  ]) assert.match(prompt, new RegExp(required));
  for (const surface of ["chat", "card", "campaign", "creative", "memory"]) {
    assert.match(prompt, new RegExp(`${surface}:\\s*\\{`), `${surface} needs its own fixed prompt profile`);
  }
  assert.match(prompt, /ASSIST_SURFACES\[surface\] \|\| /,
    "the caller-supplied surface must resolve through the fixed allowlist");
});

test("every Assist failure carries a cause", () => {
  const code = runAssistSource.replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(code, /stderr\.on\("data",\s*\(\)\s*=>\s*\{\s*\}\)/);
  assert.match(runAssistSource, /4000 \+ \(assistSecrets\[0\]/,
    "the raw stderr tail must keep enough overlap for a secret split at its cap boundary");
  assert.match(runAssistSource, /the engine said: /);
  assert.match(runAssistSource, /engine response exceeded the " \+ ASSIST_MAX_CHARS \+ "-character Assist limit/);
  assert.match(runAssistSource, /another Assist request is already running/);
  assert.match(runAssistSource, /did not answer within /);
  for (const [label, re] of [
    ["busy", /status: 409/],
    ["spawn failure", /status: 500/],
    ["engine failure", /status: 502/],
    ["timeout", /status: 504/],
  ]) assert.match(runAssistSource, re, `the ${label} path needs a distinct status`);
});

test("Assist owns an independent concurrency-one lane", () => {
  assert.match(runAssistSource, /acquireAssist\(\)/);
  assert.doesNotMatch(runAssistSource, /acquireAgent\(/,
    "Assist must never wait behind chat, board, cron or autonomy");
  assert.match(runAssistSource, /releaseAssist\(token\)/);
  const releases = (runAssistSource.match(/releaseAssist\(token\)/g) || []).length;
  assert.ok(releases >= 2, "spawn failure and terminal settle must both release the private lane");
  assert.match(runAssistSource, /let settled = false/);
});

test("Foundation B uses the fixed profile; legacy uses the safe Assist argv and env", () => {
  assert.match(runAssistSource, /const prompt = assistPrompt\(draft, surface\)/);
  assert.match(runAssistSource,
    /if \(FOUNDATION_B\) \{[\s\S]*runViaChatSocket\("claude-assist",\s*prompt/);
  const foundationArm = runAssistSource.match(/if \(FOUNDATION_B\) \{([\s\S]*?)\} else \{/)?.[1] ?? "";
  assert.ok(foundationArm);
  assert.doesNotMatch(foundationArm, /devSpawn|CHAT_BIN|chatEnv/);
  const legacyArm = runAssistSource.match(/\} else \{([\s\S]*?)\n\s*\}/)?.[1] ?? "";
  assert.match(legacyArm, /assistSpawnArgs\(\)/);
  assert.match(legacyArm, /assistEnv\(\)/);
  assert.match(legacyArm, /new Set/);
  assert.match(legacyArm, /sort\(\(a, b\) => b\.length - a\.length\)/);
  assert.doesNotMatch(legacyArm, /agentSpawnArgs|chatEnv/);
  const legacyArgsStart = gate.indexOf("function assistSpawnArgs");
  const legacyArgs = gate.slice(legacyArgsStart, gate.indexOf("// Agent prompts", legacyArgsStart));
  assert.match(legacyArgs, /"--model", "haiku"/);
  assert.match(legacyArgs, /"--effort", "low"/);
  assert.match(legacyArgs, /"--system-prompt"/);
  assert.match(legacyArgs, /"--tools", "", "--strict-mcp-config"/);
  assert.match(legacyArgs, /"--output-format", "stream-json"/);
  assert.match(legacyArgs, /"--safe-mode"/);
  assert.match(legacyArgs, /"--no-session-persistence"/);
  assert.doesNotMatch(legacyArgs, /dangerously-skip-permissions/);
  const legacyEnv = gate.slice(gate.indexOf("const ASSIST_ENV_ALLOWLIST"), gate.indexOf("const CURSOR_CHAT_ENV_ALLOWLIST"));
  assert.match(legacyEnv, /CLAUDE_CODE_OAUTH_TOKEN/);
  assert.match(legacyEnv, /CLAUDE_CODE_DISABLE_THINKING = "1"/);
  assert.match(legacyEnv, /MAX_THINKING_TOKENS = "0"/);
  for (const forbidden of ["ANTHROPIC_API_KEY", "GITHUB_TOKEN", "GIT_PUSH_TOKEN", "REPOS", "NODE_OPTIONS", "BASH_ENV"]) {
    assert.doesNotMatch(legacyEnv, new RegExp(forbidden), `legacy Assist must not receive ${forbidden}`);
  }
});

test("legacy Assist sends its draft only over stdin", () => {
  const run = assistHarness({ foundationB: false });
  const accepted = run.runAssist("private operator draft", "chat", () => {});
  assert.equal(accepted.ok, true);
  assert.equal(run.context.legacyLaunch.argv.includes("fixed prompt"), false);
  assert.equal(Object.values(run.context.legacyLaunch.options.env).includes("fixed prompt"), false);
  assert.deepEqual(run.context.legacyLaunch.options.stdio, ["pipe", "pipe", "pipe"]);
  assert.equal(run.child.stdin.written, "fixed prompt");
  assert.equal(run.child.stdin.ended, true);
  run.child.emit("close", 1);
});

test("the real stopwatch child receives only the production allowlist plus Windows runtime paths", () => {
  const hostile = {
    HOME: "C:/safe-home",
    PATH: "C:/safe-bin",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth-fixture-value",
    SystemRoot: "C:/Windows",
    USERPROFILE: "C:/Users/Test",
    APPDATA: "C:/Users/Test/AppData/Roaming",
    LOCALAPPDATA: "C:/Users/Test/AppData/Local",
    TEMP: "C:/Temp",
    TMP: "C:/Temp",
    ANTHROPIC_API_KEY: "metered-secret",
    GITHUB_TOKEN: "github-secret",
    GIT_PUSH_TOKEN: "push-secret",
    NODE_OPTIONS: "--require C:/evil.js",
    BASH_ENV: "C:/evil.sh",
    CLAUDE_BIN: "C:/evil.exe",
  };
  const env = buildStopwatchEnv(hostile, "win32");
  assert.equal(env.HOME, hostile.HOME);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, hostile.CLAUDE_CODE_OAUTH_TOKEN);
  assert.equal(env.USERPROFILE, hostile.USERPROFILE);
  assert.equal(env.CLAUDE_CODE_DISABLE_THINKING, "1");
  assert.equal(env.MAX_THINKING_TOKENS, "0");
  assert.equal(env.DISABLE_AUTOUPDATER, "1");
  for (const forbidden of ["ANTHROPIC_API_KEY", "GITHUB_TOKEN", "GIT_PUSH_TOKEN", "NODE_OPTIONS", "BASH_ENV", "CLAUDE_BIN"]) {
    assert.equal(env[forbidden], undefined, `stopwatch child must not receive ${forbidden}`);
  }
  assert.doesNotMatch(stopwatch, /\.\.\.process\.env/,
    "the proof must not claim production equivalence while inheriting the desktop's full environment");
});

test("gateway shutdown keeps the legacy Assist lane closed until terminal proof", () => {
  const child = new EventEmitter();
  child.terminationProven = true;
  const kills = [];
  child.kill = (signal) => { kills.push(signal); return true; };
  let proven = 0;
  let unproven = 0;
  settleAssistForShutdown(child, {
    proofMs: 50,
    onProven: () => { proven += 1; },
    onUnproven: () => { unproven += 1; },
  });
  assert.deepEqual(kills, ["SIGKILL"]);
  assert.equal(proven, 0, "requesting a kill must not reopen or restart the gate");
  assert.equal(unproven, 0);
  child.emit("close", null, "SIGKILL");
  assert.equal(proven, 1, "the real close event is the terminal proof");
  assert.equal(unproven, 0);
});

test("unproven Assist shutdown requests a full container restart, never a gate-only replacement", () => {
  const child = new EventEmitter();
  child.terminationProven = false;
  child.kill = () => true;
  let timeoutCallback = null;
  let proven = 0;
  let unproven = 0;
  settleAssistForShutdown(child, {
    proofMs: 50,
    schedule: (callback) => {
      timeoutCallback = callback;
      return { unref() {} };
    },
    clearSchedule() {},
    onProven: () => { proven += 1; },
    onUnproven: () => { unproven += 1; },
  });
  assert.equal(proven, 0);
  assert.equal(unproven, 0);
  timeoutCallback();
  assert.equal(proven, 0);
  assert.equal(unproven, 1);
  assert.match(gate, /ASSIST_FULL_RESTART_EXIT_CODE\s*=\s*76/);
  const startScript = fs.readFileSync(path.join(here, "..", "container", "start.sh"), "utf8");
  assert.match(startScript, /EXIT_CODE" -eq 76[\s\S]*exit 1/,
    "legacy start.sh must hand an unproven Assist tree to Fly instead of starting another gate");
});

test("Assist streams deltas and releases only after proven exit", async () => {
  const success = assistHarness({ maxChars: 8 });
  const deltas = [];
  const successRun = success.runAssist("rough draft", "memory", (text) => deltas.push(text));
  assert.equal(successRun.ok, true);
  const streamEvent = (text) => `${JSON.stringify({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text } },
  })}\n`;
  success.child.stdout.emit("data", streamEvent("impro"));
  success.child.stdout.emit("data", streamEvent("ved text that exceeds the response cap"));
  assert.equal(deltas[0], "impro", "first content must be observable before terminal exit");
  assert.equal(deltas.join(""), "impro", "an over-limit chunk must not be silently truncated into a success");
  assert.deepEqual(success.kills, ["SIGKILL"], "overflow must stop the model instead of spending past the cap");
  success.child.emit("close", null, "SIGKILL");
  const overflow = await successRun.done;
  assert.equal(overflow.ok, false);
  assert.equal(overflow.status, 502);
  assert.match(overflow.why, /response exceeded the 8-character Assist limit/);
  assert.equal(success.releases(), 1);

  const lateCause = assistHarness();
  const lateCauseResult = lateCause.runAssist("rough draft", "memory", () => {}).done;
  lateCause.child.stderr.emit("data", "warning ".repeat(700));
  lateCause.child.stderr.emit("data", "\nOAuth subscription has expired");
  lateCause.child.emit("close", 1);
  assert.match((await lateCauseResult).why, /OAuth subscription has expired/);

  const signalDeath = assistHarness();
  const signalDeathResult = signalDeath.runAssist("rough draft", "memory", () => {}).done;
  signalDeath.child.emit("close", null, "SIGKILL");
  assert.match((await signalDeathResult).why, /terminated by SIGKILL/);

  const timeout = assistHarness({ timeoutMs: 5 });
  let timeoutSettled = false;
  const timeoutResult = timeout.runAssist("rough draft", "memory", () => {}).done.then((result) => {
    timeoutSettled = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(timeout.kills, ["SIGKILL"]);
  assert.equal(timeoutSettled, false, "a kill request is not terminal proof");
  assert.equal(timeout.releases(), 0);
  timeout.child.terminationProven = true;
  timeout.child.emit("close", null);
  assert.equal((await timeoutResult).status, 504);
  assert.equal(timeout.releases(), 1);

  const cancelled = assistHarness();
  const cancelledRun = cancelled.runAssist("rough draft", "card", () => {});
  cancelledRun.cancel();
  assert.deepEqual(cancelled.kills, ["SIGKILL"]);
  assert.equal(cancelled.releases(), 0, "cancellation must retain the private lane until close proves exit");
  cancelled.child.emit("close", null, "SIGKILL");
  assert.equal((await cancelledRun.done).status, 499);
  assert.equal(cancelled.releases(), 1, "proven cancellation reopens the private Assist lane");

  const lost = assistHarness();
  const lostResult = lost.runAssist("rough draft", "memory", () => {}).done;
  lost.child.terminationProven = false;
  lost.child.emit("close", null);
  const quarantined = await lostResult;
  assert.equal(quarantined.status, 503);
  assert.match(quarantined.why, /could not confirm the model process exited/i);
  assert.equal(lost.context.assistLaneQuarantined, true);
  assert.equal(lost.releases(), 0);
});

test("legacy Assist redacts its OAuth secret before parsing output or exposing a cause", async () => {
  const secret = "oauth-secret-with-a-long-distinct-value";
  const streamed = assistHarness({ foundationB: false, oauthToken: secret, maxChars: 128 });
  const deltas = [];
  const streamedRun = streamed.runAssist("rough draft", "chat", (text) => deltas.push(text));
  const event = JSON.stringify({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: `copy ${secret}` } },
  });
  streamed.child.stdout.emit("data", `${event}\n`);
  streamed.child.emit("close", 0);
  const result = await streamedRun.done;
  assert.equal(result.ok, true);
  assert.equal(deltas.join(""), "copy [REDACTED]");
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));

  const failed = assistHarness({ foundationB: false, oauthToken: secret, maxChars: 128 });
  const failedRun = failed.runAssist("rough draft", "chat", () => {});
  failed.child.stderr.emit("data", `subscription rejected ${secret.slice(0, 17)}`);
  failed.child.stderr.emit("data", secret.slice(17));
  failed.child.emit("close", 1);
  const failure = await failedRun.done;
  assert.match(failure.why, /subscription rejected \[REDACTED\]/);
  assert.doesNotMatch(failure.why, new RegExp(secret));

  const spawnFailed = assistHarness({ foundationB: false, oauthToken: secret, maxChars: 128 });
  const spawnFailedRun = spawnFailed.runAssist("rough draft", "chat", () => {});
  spawnFailed.child.emit("error", new Error(`spawn failed with ${secret}`));
  const spawnFailure = await spawnFailedRun.done;
  assert.match(spawnFailure.why, /spawn failed with \[REDACTED\]/);
  assert.doesNotMatch(spawnFailure.why, new RegExp(secret));
});

test("one tap streams a preview, preserves failure input and keeps Undo", () => {
  const enrich = assistUi.slice(
    assistUi.indexOf("async function enrich"),
    assistUi.indexOf("function undo"),
  );
  assert.doesNotMatch(assistUi, /Use AI Assist on this draft\?|Confirm and assist|reviewOpen/);
  assert.match(assistUi, /onClick=\{enrich\}/);
  assert.match(assistUi, /response\.body\.getReader\(\)/);
  assert.match(assistUi, /setPreview\(/);
  assert.match(assistUi, /performance\.now\(\)/);
  assert.match(assistUi, /Undo/);
  assert.match(enrich, /if \(enrichInFlight\.current\) return/);
  assert.match(enrich, /enrichInFlight\.current = true[\s\S]*fetch\("\/api\/assist"/);
  assert.match(enrich, /finally \{[\s\S]*enrichInFlight\.current = false/);
  assert.match(enrich,
    /if \(!completed\)[\s\S]*return[\s\S]*setPrevious\(before\)[\s\S]*onChange\(completed\)/,
    "only a completed answer may replace the draft");
  assert.match(enrich, /completed\.length > maxLength[\s\S]*setProblem\([\s\S]*return[\s\S]*setPrevious\(before\)/,
    "a field-specific maximum must reject the whole model answer before replacing the draft");
  assert.match(enrich, /ASSIST_CLIENT_TIMEOUT_MS[\s\S]*abort\.abort\(\)/,
    "the phone must abort a transport that stalls beyond the server cleanup window");
  assert.match(enrich, /timedOut[\s\S]*did not finish within[\s\S]*unmounting\.current/,
    "a timeout needs a named failure while an unmount stays silent");
  assert.match(enrich, /if \(timedOut\)[\s\S]*return[\s\S]*setPrevious\(before\)/,
    "a deadline race must still reject the whole answer before replacing the draft");
  assert.match(enrich, /clearTimeout\(deadline\)/,
    "a completed request must not leave its abort timer armed");
});

test("the HTTP route streams deltas and a cause-bearing terminal event", () => {
  assert.match(route, /application\/x-ndjson/);
  assert.match(route, /type:\s*"delta"/);
  assert.match(route, /type:\s*"done"/);
  assert.match(route, /type:\s*"error"[\s\S]*error:\s*r\.why/);
  assert.match(route, /res\.on\("close"[\s\S]*run\.cancel\(\)/);
});

test("a response write race is caught and cancels the in-flight Assist run", () => {
  let failures = 0;
  const thrown = {
    destroyed: false,
    writableEnded: false,
    write() { throw new Error("socket closed during write"); },
  };
  assert.equal(writeAssistEvent(thrown, { type: "delta", text: "first" }, () => { failures += 1; }), false);
  assert.equal(failures, 1);

  let callback;
  const asyncFailure = {
    destroyed: false,
    writableEnded: false,
    write(_payload, done) { callback = done; return true; },
  };
  assert.equal(writeAssistEvent(asyncFailure, { type: "delta", text: "first" }, () => { failures += 1; }), true);
  callback(new Error("peer reset"));
  assert.equal(failures, 2, "the write callback must route asynchronous socket failure into cancellation");
});
