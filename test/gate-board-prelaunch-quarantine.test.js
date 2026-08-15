import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { stopChild } from "./child-process-helper.js";

const SOURCE_CONTAINER = path.join(import.meta.dirname, "..", "container");
const KEY = "gate-board-prelaunch-quarantine-key";
const TASK_ID = "prelaunchlease01";
const REPO = "Stevekaplanai/agenthost-internal";
const BASE_SHA = "a".repeat(40);

function replaceOnce(source, needle, replacement, label) {
  assert.equal(source.split(needle).length - 1, 1, `fixture found ${label}`);
  return source.replace(needle, replacement);
}

function patchGateFixture(gateFile) {
  let source = fs.readFileSync(gateFile, "utf8");
  source = replaceOnce(
    source,
    "const AGENT_HARD_MAX_MS = 16 * 60 * 1000;",
    "const AGENT_HARD_MAX_MS = 1500;",
    "the production agent hard ceiling",
  );
  source = replaceOnce(
    source,
    "}, 30 * 1000).unref();",
    "}, 20).unref();",
    "the production hard-ceiling watchdog interval",
  );
  source = replaceOnce(
    source,
    "setTimeout(() => setInterval(boardTick, 30 * 1000), 15 * 1000);",
    "setTimeout(() => boardTick(), 20);",
    "the production board scheduler",
  );
  source = replaceOnce(
    source,
    "const prepared = await prepareGitProposal(gitProposal);",
    "const prepared = await new Promise((resolve) => setTimeout(() => resolve({ ok: true, change: gitProposal }), 4500));",
    "the asynchronous Git proposal preparation boundary",
  );
  source = replaceOnce(
    source,
    "if (!FOUNDATION_B) return codexAuthLauncherAvailable(HOME_DIR);",
    "if (!FOUNDATION_B) return true;",
    "the direct-mode Codex readiness check",
  );
  source = replaceOnce(
    source,
    "const p = spawn(HERMES_BIN, [\"kanban\", ...args], {",
    "const p = spawn(process.execPath, [process.env.AGENTHOST_TEST_HERMES, \"kanban\", ...args], {",
    "the Hermes Kanban process boundary",
  );
  source = replaceOnce(
    source,
    "env: hermesKanbanEnv(),",
    "env: { ...hermesKanbanEnv(), AGENTHOST_TEST_BOARD_FILE: process.env.AGENTHOST_TEST_BOARD_FILE, AGENTHOST_TEST_BOARD_OPS: process.env.AGENTHOST_TEST_BOARD_OPS, AGENTHOST_TEST_ENV_TRACE: process.env.AGENTHOST_TEST_ENV_TRACE },",
    "the test-only board fixture inputs",
  );
  source = replaceOnce(
    source,
    "function runAutonomousTask(eng, prompt, opts) {",
    [
      "function runAutonomousTask(eng, prompt, opts) {",
      "  if (process.env.AGENTHOST_TEST_ENGINE_WRAPPER) {",
      "    const wrapped = spawn(process.execPath, [process.env.AGENTHOST_TEST_ENGINE_WRAPPER, String(eng && eng.label || \"unknown\")], {",
      "      env: process.env, stdio: [\"ignore\", \"pipe\", \"pipe\"],",
      "    });",
      "    return new Promise((resolve) => {",
      "      wrapped.once(\"error\", () => resolve({ ranClean: false, text: \"wrapper failed\" }));",
      "      wrapped.once(\"close\", () => resolve({ ranClean: true, text: \"unexpected engine start\" }));",
      "    });",
      "  }",
      "",
    ].join("\n"),
    "the autonomous engine wrapper boundary",
  );
  fs.writeFileSync(gateFile, source);
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function waitFor(check, message, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-board-prelaunch-"));
  const home = path.join(root, "home");
  const container = path.join(root, "container");
  const agenthostDir = path.join(home, ".claude", "agenthost");
  const settingsDir = path.join(home, ".agenthost");
  const boardFile = path.join(root, "board.json");
  const boardOpsFile = path.join(root, "board-ops.jsonl");
  const hermesEnvTraceFile = path.join(root, "hermes-env.jsonl");
  const engineTraceFile = path.join(root, "engine-starts.jsonl");
  const fakeHermes = path.join(root, "fake-hermes.mjs");
  const engineWrapper = path.join(root, "engine-wrapper.mjs");

  fs.mkdirSync(path.join(home, "work"), { recursive: true });
  fs.mkdirSync(agenthostDir, { recursive: true });
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(path.join(agenthostDir, "autonomy.on"), "on\n");
  fs.writeFileSync(path.join(settingsDir, "settings.json"), JSON.stringify({
    llm: {
      roster: {
        claude: { active: false, inChat: false },
        hermes: { active: false, inChat: false },
        codex: { active: true, inChat: true },
        gemini: { active: false, inChat: false },
        kimi: { active: false, inChat: false },
        cursor: { active: false, inChat: false },
      },
    },
    board: { autoDispatch: true, stuckAlerts: false },
    schedule: { sleep: { enabled: false, start: "23:00", end: "07:00" } },
    git: { autonomyLevel: 3, reviewStrictness: 3, autoCommit: false },
  }));

  const task = {
    id: TASK_ID,
    title: "Add a deterministic lease regression fixture",
    body: "Verify local lease behavior with deterministic fixture data.",
    status: "ready",
    assignee: "codex",
    created_at: Date.now(),
  };
  fs.writeFileSync(boardFile, JSON.stringify({ task }));
  fs.writeFileSync(boardOpsFile, "");
  fs.writeFileSync(hermesEnvTraceFile, "");
  fs.writeFileSync(engineTraceFile, "");

  const change = {
    v: 1,
    taskId: TASK_ID,
    repo: REPO,
    engine: "codex",
    branch: `codex/task-${TASK_ID}`,
    baseRef: "main",
    baseSha: BASE_SHA,
    status: "prepared",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  fs.writeFileSync(path.join(agenthostDir, "git-ladder.json"), JSON.stringify({
    v: 1,
    changes: { [TASK_ID]: change },
  }));
  const worktree = path.join(home, "workspaces", "codex", `agenthost-internal--task-${TASK_ID}`);
  fs.mkdirSync(path.join(worktree, ".git"), { recursive: true });

  fs.writeFileSync(fakeHermes, [
    'import fs from "node:fs";',
    "const boardFile = process.env.AGENTHOST_TEST_BOARD_FILE;",
    "const opsFile = process.env.AGENTHOST_TEST_BOARD_OPS;",
    'fs.appendFileSync(process.env.AGENTHOST_TEST_ENV_TRACE, JSON.stringify({ push: Boolean(process.env.GIT_PUSH_TOKEN), github: Boolean(process.env.GITHUB_TOKEN), gh: Boolean(process.env.GH_TOKEN), sentinel: Boolean(process.env.AGENTHOST_TEST_SENTINEL) }) + "\\n");',
    'const args = process.argv.slice(2);',
    'const verb = args[0] === "kanban" ? String(args[1] || "") : "";',
    'const rest = args.slice(2);',
    'const state = JSON.parse(fs.readFileSync(boardFile, "utf8"));',
    'fs.appendFileSync(opsFile, JSON.stringify({ verb, args: rest, at: Date.now() }) + "\\n");',
    'if (verb === "list") process.stdout.write(JSON.stringify([state.task]));',
    'else if (verb === "claim") { state.task.status = "running"; fs.writeFileSync(boardFile, JSON.stringify(state)); process.stdout.write("claimed\\n"); }',
    'else if (verb === "block") { state.task.status = "blocked"; state.task.blocked_reason = String(rest[1] || ""); fs.writeFileSync(boardFile, JSON.stringify(state)); process.stdout.write("blocked\\n"); }',
    'else if (verb === "show") process.stdout.write(`id: ${state.task.id}\\nstatus: ${state.task.status}\\n`);',
    'else if (verb === "-h") process.stdout.write("list create claim complete comment block show heartbeat\\n");',
    'else process.stdout.write("ok\\n");',
    "",
  ].join("\n"));
  fs.writeFileSync(engineWrapper, [
    'import fs from "node:fs";',
    'fs.appendFileSync(process.env.AGENTHOST_TEST_ENGINE_TRACE, JSON.stringify({ engine: process.argv[2], at: Date.now() }) + "\\n");',
    "",
  ].join("\n"));

  fs.cpSync(SOURCE_CONTAINER, container, { recursive: true });
  const gateFile = path.join(container, "gate.js");
  patchGateFixture(gateFile);
  return {
    root,
    home,
    container,
    gateFile,
    agenthostDir,
    boardFile,
    boardOpsFile,
    hermesEnvTraceFile,
    engineTraceFile,
    fakeHermes,
    engineWrapper,
  };
}

async function boot(fixture) {
  const gate = spawn(process.execPath, [fixture.gateFile], {
    env: {
      ...process.env,
      HOME: fixture.home,
      TTYD_PASSWORD: KEY,
      REPOS: REPO,
      AGENTHOST_FOUNDATION_B: "0",
      AGENTHOST_TEST_HERMES: fixture.fakeHermes,
      AGENTHOST_TEST_BOARD_FILE: fixture.boardFile,
      AGENTHOST_TEST_BOARD_OPS: fixture.boardOpsFile,
      AGENTHOST_TEST_ENV_TRACE: fixture.hermesEnvTraceFile,
      GIT_PUSH_TOKEN: "sentinel-push",
      GITHUB_TOKEN: "sentinel-agent",
      GH_TOKEN: "sentinel-agent",
      AGENTHOST_TEST_SENTINEL: "must-not-reach-hermes",
      AGENTHOST_TEST_ENGINE_WRAPPER: fixture.engineWrapper,
      AGENTHOST_TEST_ENGINE_TRACE: fixture.engineTraceFile,
      BOARD_LOOP_ALERT: "off",
      BOARD_STUCK_ALERT: "off",
      WAKE_CHECKIN: "off",
      GATE_PORT: "0",
      CHANNEL_DISPATCH_PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  gate.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  gate.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  await waitFor(
    () => /listening on \d+/.test(stdout),
    `gate did not bind\nstdout:\n${stdout}\nstderr:\n${stderr}`,
  );
  return { gate, stdout: () => stdout, stderr: () => stderr };
}

test("an accepted board run that loses its lane during async pre-launch work is quarantined without starting an engine", async () => {
  const fixture = createFixture();
  let gate;
  try {
    const live = await boot(fixture);
    gate = live.gate;
    const ledgerFile = path.join(fixture.agenthostDir, "runs", "runs.jsonl");
    let outcome;
    try {
      outcome = await waitFor(() => {
        const run = readJsonl(ledgerFile)
          .map((event) => event.run)
          .filter((candidate) => candidate
            && candidate.kind === "git_ladder"
            && candidate.artifacts.some((artifact) => artifact.type === "board_task" && artifact.id === TASK_ID))
          .at(-1);
        const sidecar = readJson(path.join(fixture.agenthostDir, "chains.json"), {});
        const board = readJson(fixture.boardFile);
        return run?.status === "failed"
          && sidecar?.humanReview?.[TASK_ID]
          && board?.task?.status === "blocked"
          ? { run, sidecar, board }
          : null;
      }, "pre-launch run did not quarantine");
    } catch (error) {
      throw new Error([
        error.message,
        `stdout:\n${live.stdout()}`,
        `stderr:\n${live.stderr()}`,
        `board operations: ${JSON.stringify(readJsonl(fixture.boardOpsFile))}`,
        `board: ${JSON.stringify(readJson(fixture.boardFile))}`,
        `sidecar: ${JSON.stringify(readJson(path.join(fixture.agenthostDir, "chains.json")))}`,
        `ledger: ${JSON.stringify(readJsonl(ledgerFile))}`,
        `audit: ${fs.existsSync(path.join(fixture.agenthostDir, "audit.log")) ? fs.readFileSync(path.join(fixture.agenthostDir, "audit.log"), "utf8") : ""}`,
      ].join("\n"));
    }

    assert.equal(readJsonl(fixture.engineTraceFile).length, 0,
      "the autonomous engine wrapper is never invoked after the shared lease is quarantined");
    assert.equal(outcome.run.status, "failed");
    assert.deepEqual(outcome.run.next_actions, [{ id: "restart_box", label: "Restart box" }]);
    assert.match(outcome.run.summary, /shared agent lane was quarantined|private Git workspace/i);
    assert.match(outcome.sidecar.humanReview[TASK_ID].note, /^claim quarantine:/);
    assert.match(outcome.board.task.blocked_reason, /claim quarantine:.*no engine was launched/i);

    const operations = readJsonl(fixture.boardOpsFile);
    const hermesEnv = readJsonl(fixture.hermesEnvTraceFile);
    assert.ok(hermesEnv.length > 0, "the board helper was actually invoked");
    assert.ok(hermesEnv.every((row) => !row.push && !row.github && !row.gh && !row.sentinel),
      "the board helper never receives the gate push token or arbitrary parent environment");
    assert.equal(operations.filter((operation) => operation.verb === "claim").length, 1,
      "the card is claimed only once");
    assert.equal(operations.filter((operation) => operation.verb === "block").length, 1,
      "the unresolved card receives one operator-visible quarantine");
    assert.equal(operations.filter((operation) => ["reclaim", "release"].includes(operation.verb)).length, 0,
      "quarantine never masquerades as a safe reclaim or release");

    const database = new DatabaseSync(path.join(fixture.agenthostDir, "board-claims.sqlite"), { readOnly: true });
    try {
      const claim = database.prepare("SELECT task_id, state FROM claims WHERE task_id = ?").get(TASK_ID);
      assert.equal(claim?.state, "running",
        "the unresolved durable claim remains non-releasable; the sidecar and board carry its quarantine");
    } finally {
      database.close();
    }
    assert.match(live.stderr(), /agent lane quarantined; no replacement process will start/i);
  } finally {
    if (gate) await stopChild(gate, "SIGKILL");
    fs.rmSync(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
