import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stopChild } from "./child-process-helper.js";
import { mintOperatorSession } from "./operator-session-helper.js";

const SOURCE_CONTAINER = path.join(import.meta.dirname, "..", "container");
const KEY = "gate-quarantine-behavior-key";

function events(text) {
  return text.split("\n\n").map((block) => {
    let event = "message";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) data += line.slice(6);
    }
    return { event, data };
  }).filter((entry) => entry.data);
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse);
  } catch {
    return [];
  }
}

async function waitFor(fn, message, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

function patchNoTerminalEventFixture(gateFile, { shortenRunTimeout = true, teamCancel = false } = {}) {
  let source = fs.readFileSync(gateFile, "utf8");
  if (shortenRunTimeout) {
    const timeout = "const CHAT_RUN_TIMEOUT_MS = 12 * 60 * 1000;";
    assert.equal(source.split(timeout).length - 1, 1, "fixture found the production chat timeout");
    source = source.replace(timeout, "const CHAT_RUN_TIMEOUT_MS = 50;");

    const outerTimeout = "CHAT_RUN_TIMEOUT_MS + 15000";
    assert.equal(source.split(outerTimeout).length - 1, 2, "fixture found Team and wake reap watchdogs");
    source = source.replaceAll(outerTimeout, "CHAT_RUN_TIMEOUT_MS + 50");
  }

  const start = source.indexOf("function runOneTeamTurn");
  const end = source.indexOf("// ---- Wake-up check-in", start);
  assert.ok(start >= 0 && end > start, "fixture found runOneTeamTurn");
  const section = source.slice(start, end);
  const kill = 'try { child.kill("SIGKILL"); } catch {}';
  const timerStart = section.indexOf("timer = setTimeout");
  const timerKill = section.indexOf(kill, timerStart);
  assert.ok(timerStart >= 0 && timerKill > timerStart, "fixture found the Team timeout kill");
  const faultedSection = section.slice(0, timerKill)
    + "try { /* fault injection: kill produced no terminal event */ } catch {}"
    + section.slice(timerKill + kill.length);
  source = source.slice(0, start)
    + faultedSection
    + source.slice(end);

  if (teamCancel) {
    const teamStart = source.indexOf("function runOneTeamTurn");
    const teamEnd = source.indexOf("// ---- Wake-up check-in", teamStart);
    const teamSection = source.slice(teamStart, teamEnd);
    const cancelKill = 'try { child.kill("SIGKILL"); } catch {}';
    const cancelHandler = 'res.on("close", () => {';
    const handlerAt = teamSection.indexOf(cancelHandler);
    const killAt = teamSection.indexOf(cancelKill, handlerAt);
    assert.ok(handlerAt >= 0 && killAt > handlerAt, "fixture found the Team cancellation kill");
    const grace = "}, 3000);";
    assert.equal(teamSection.slice(handlerAt).split(grace).length - 1, 1,
      "fixture found the Team cancellation reap grace");
    const faultedTeam = teamSection.slice(0, killAt)
      + "try { /* fault injection: Team cancel kill produced no terminal event */ } catch {}"
      + teamSection.slice(killAt + cancelKill.length);
    source = source.slice(0, teamStart)
      + faultedTeam.replace(grace, "}, 75);")
      + source.slice(teamEnd);
  }

  const runChatStart = source.indexOf("function runChat");
  const runChatEnd = source.indexOf("// ---- brain search", runChatStart);
  assert.ok(runChatStart >= 0 && runChatEnd > runChatStart, "fixture found runChat");
  const runChat = source.slice(runChatStart, runChatEnd);
  const cancelGrace = "}, 3000);\n    cancelReapWatchdog.unref();";
  assert.equal(runChat.split(cancelGrace).length - 1, 1, "fixture found the chat cancellation reap grace");
  const cancelKill = 'active.kill(eng.sigterm ? "SIGTERM" : "SIGKILL");';
  assert.equal(runChat.split(cancelKill).length - 1, 1, "fixture found the chat cancellation kill");
  source = source.slice(0, runChatStart)
    + runChat
      .replace(cancelGrace, "}, 75);\n    cancelReapWatchdog.unref();")
      .replace(cancelKill, "/* fault injection: cancellation kill produced no terminal event */")
    + source.slice(runChatEnd);
  fs.writeFileSync(gateFile, source);
}

function createFixture(tag, { wake = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `agenthost-quarantine-${tag}-`));
  const home = path.join(root, "home");
  const container = path.join(root, "container");
  const trace = path.join(root, "children.jsonl");
  const wrapper = path.join(root, "never-exits.mjs");
  fs.mkdirSync(path.join(home, "work"), { recursive: true });
  fs.mkdirSync(path.join(home, ".agenthost"), { recursive: true });
  fs.writeFileSync(path.join(home, ".agenthost", "settings.json"), JSON.stringify({
    llm: {
      roster: {
        claude: { active: true, inChat: true },
        hermes: { active: true, inChat: true },
        codex: { active: false, inChat: false },
        gemini: { active: false, inChat: false },
        kimi: { active: false, inChat: false },
        cursor: { active: false, inChat: false },
      },
    },
  }));
  fs.writeFileSync(trace, "");
  fs.writeFileSync(wrapper, [
    'import fs from "node:fs";',
    `const trace = ${JSON.stringify(trace)};`,
    'const bin = String(process.argv[2] || "").replace(/\\\\/g, "/").split("/").at(-1).toLowerCase();',
    'const engine = bin.includes("claude") ? "claude" : bin.includes("hermes") ? "hermes" : bin;',
    'const record = (phase) => fs.appendFileSync(trace, JSON.stringify({ phase, engine, pid: process.pid, at: Date.now() }) + "\\n");',
    'record("start");',
    'process.on("SIGTERM", () => record("ignored_sigterm"));',
    'process.on("SIGINT", () => record("ignored_sigint"));',
    'setInterval(() => {}, 1000);',
    "",
  ].join("\n"));
  fs.cpSync(SOURCE_CONTAINER, container, { recursive: true });
  fs.writeFileSync(path.join(container, "team-charter.md"), "# Quarantine behavior test\n");
  const gateFile = path.join(container, "gate.js");
  patchNoTerminalEventFixture(gateFile, {
    shortenRunTimeout: tag !== "cancel" && tag !== "team-cancel",
    teamCancel: tag === "team-cancel",
  });
  return { root, home, container, gateFile, trace, wrapper, wake };
}

async function boot(fixture) {
  const gate = spawn(process.execPath, [fixture.gateFile], {
    env: {
      ...process.env,
      AGENTHOST_FOUNDATION_B: "0",
      HOME: fixture.home,
      TTYD_PASSWORD: KEY,
      AGENT_CHAT_BIN: "fake-claude",
      AGENTHOST_DEV_WRAP: fixture.wrapper,
      WAKE_CHECKIN: fixture.wake ? "on" : "off",
      WAKE_CHECKIN_DELAY_MS: "20",
      GATE_PORT: "0",
      CHANNEL_DISPATCH_PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  gate.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  gate.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const port = await waitFor(() => {
    const match = stdout.match(/listening on (\d+)/);
    return match && Number(match[1]);
  }, () => `gate did not bind\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  const base = `http://127.0.0.1:${port}`;
  const { cookie } = await mintOperatorSession(base, KEY);
  return { gate, base, cookie, stderr: () => stderr };
}

async function cleanup(fixture, gate) {
  await stopChild(gate, "SIGKILL");
  for (const row of readJsonl(fixture.trace)) {
    if (!Number.isInteger(row.pid)) continue;
    try { process.kill(row.pid, "SIGKILL"); } catch {}
  }
  fs.rmSync(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

test("cancel without terminal process proof fails durably and never starts the queued replacement", async () => {
  const fixture = createFixture("cancel");
  let gate;
  try {
    const live = await boot(fixture);
    gate = live.gate;
    const firstId = "cancelunreaped01";
    const secondId = "aftercancel001";
    const first = await fetch(
      `${live.base}/chat/stream?run=${firstId}&engine=hermes&msg=${encodeURIComponent("hold until cancelled")}`,
      { headers: { cookie: live.cookie } },
    );
    await waitFor(() => readJsonl(fixture.trace).length === 1, "the first child did not start");

    await fetch(`${live.base}/chat/runs/${firstId}/cancel`, {
      method: "POST",
      headers: { cookie: live.cookie },
    });
    const second = await fetch(
      `${live.base}/chat/stream?run=${secondId}&engine=claude&msg=${encodeURIComponent("must never spawn")}`,
      { headers: { cookie: live.cookie } },
    );

    const firstEvents = events(await first.text());
    const secondEvents = events(await second.text());
    const firstStatus = await (await fetch(`${live.base}/chat/runs/${firstId}`, {
      headers: { cookie: live.cookie },
    })).json();
    const secondStatus = await (await fetch(`${live.base}/chat/runs/${secondId}`, {
      headers: { cookie: live.cookie },
    })).json();

    assert.equal(firstStatus.status, "failed",
      "an unproven cancellation is a restart-required failure, not a completed cancellation");
    const firstDone = JSON.parse(firstEvents.find((entry) => entry.event === "done").data);
    assert.equal(firstDone.recovery, "restart_box", JSON.stringify(firstEvents));
    assert.match(firstDone.error, /confirm|quarantin|restart/i);
    assert.equal(secondStatus.status, "failed", "the queued replacement terminalizes instead of waiting forever");
    const secondDone = JSON.parse(secondEvents.find((entry) => entry.event === "done").data);
    assert.equal(secondDone.recovery, "restart_box");
    assert.equal(readJsonl(fixture.trace).filter((row) => row.phase === "start").length, 1,
      "no replacement heavyweight child starts without exit/close proof");
  } finally {
    if (gate) await cleanup(fixture, gate);
    else fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Team Chat quarantines an unreaped segment before the next engine and records failure", async () => {
  const fixture = createFixture("team");
  let gate;
  try {
    const live = await boot(fixture);
    gate = live.gate;
    const runId = "teamunreaped01";
    const response = await fetch(
      `${live.base}/chat/stream?run=${runId}&engine=team&msg=${encodeURIComponent("prove no Team overlap")}`,
      { headers: { cookie: live.cookie } },
    );
    const body = events(await response.text());
    const done = JSON.parse(body.find((entry) => entry.event === "done").data);
    const status = await (await fetch(`${live.base}/chat/runs/${runId}`, {
      headers: { cookie: live.cookie },
    })).json();
    await waitFor(
      () => readJsonl(fixture.trace).some((row) => row.phase === "start"),
      "the first Team child did not reach the test wrapper",
    );
    const starts = readJsonl(fixture.trace).filter((row) => row.phase === "start");

    assert.deepEqual(starts.map((row) => row.engine), ["claude"],
      `Hermes never starts while Claude has no terminal process event; events=${JSON.stringify(body)} stderr=${live.stderr()}`);
    assert.equal(status.status, "failed");
    assert.equal(done.recovery, "restart_box");
    assert.match(done.error, /quarantin|confirm|restart/i);
  } finally {
    if (gate) await cleanup(fixture, gate);
    else fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Team Chat cancel quarantines an unreaped segment quickly and never starts queued work", async () => {
  const fixture = createFixture("team-cancel");
  let gate;
  try {
    const live = await boot(fixture);
    gate = live.gate;
    const firstId = "teamcancel001";
    const secondId = "afterteamcan1";
    const first = await fetch(
      `${live.base}/chat/stream?run=${firstId}&engine=team&msg=${encodeURIComponent("hold Team until cancelled")}`,
      { headers: { cookie: live.cookie } },
    );
    await waitFor(() => readJsonl(fixture.trace).length === 1, "the first Team child did not start");

    await fetch(`${live.base}/chat/runs/${firstId}/cancel`, {
      method: "POST",
      headers: { cookie: live.cookie },
    });
    const second = await fetch(
      `${live.base}/chat/stream?run=${secondId}&engine=claude&msg=${encodeURIComponent("must stay queued")}`,
      { headers: { cookie: live.cookie } },
    );

    const firstEvents = events(await first.text());
    const secondEvents = events(await second.text());
    const firstDone = JSON.parse(firstEvents.find((entry) => entry.event === "done").data);
    const secondDone = JSON.parse(secondEvents.find((entry) => entry.event === "done").data);
    assert.equal(firstDone.recovery, "restart_box");
    assert.equal(secondDone.recovery, "restart_box");
    assert.equal(readJsonl(fixture.trace).filter((row) => row.phase === "start").length, 1,
      "Team cancellation never overlaps the unreaped child with queued work");
  } finally {
    if (gate) await cleanup(fixture, gate);
    else fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("wake quarantine cannot launch the next engine and terminalizes its durable run", async () => {
  const fixture = createFixture("wake", { wake: true });
  let gate;
  try {
    const live = await boot(fixture);
    gate = live.gate;
    const ledgerFile = path.join(fixture.home, ".claude", "agenthost", "runs", "runs.jsonl");
    const failedWake = await waitFor(() => {
      const rows = readJsonl(ledgerFile).filter((row) => row.run && row.run.kind === "wake_check");
      return rows.at(-1)?.run?.status === "failed" ? rows.at(-1).run : null;
    }, "wake run did not terminalize after quarantine");
    await waitFor(
      () => readJsonl(fixture.trace).some((row) => row.phase === "start"),
      "the first wake child did not reach the test wrapper",
    );
    const starts = readJsonl(fixture.trace).filter((row) => row.phase === "start");

    assert.deepEqual(starts.map((row) => row.engine), ["claude"],
      `wake does not start Hermes while Claude has no terminal process event; ledger=${JSON.stringify(failedWake)} stderr=${live.stderr()}`);
    assert.match(failedWake.summary, /quarantin|did not confirm/i);
    assert.deepEqual(failedWake.next_actions, [{ id: "restart_box", label: "Restart box" }]);
  } finally {
    if (gate) await cleanup(fixture, gate);
    else fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
