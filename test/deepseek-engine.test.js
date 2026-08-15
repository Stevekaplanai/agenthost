import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import gate from "../container/gate.js";
import settings from "../container/settings-lib.js";

const root = path.join(import.meta.dirname, "..");
const gateSource = fs.readFileSync(path.join(root, "container", "gate.js"), "utf8");
const dockerfile = fs.readFileSync(path.join(root, "container", "Dockerfile"), "utf8");
const startSource = fs.readFileSync(path.join(root, "container", "start.sh"), "utf8");

function sourceSet(name) {
  const match = gateSource.match(new RegExp(`const ${name} = (?:new Set\\()?\\[([^\\]]*)\\]\\)?`));
  assert.ok(match, `${name} is declared as a literal collection`);
  return [...match[1].matchAll(/"([a-z0-9_-]+)"/g)].map((entry) => entry[1]);
}

test("DeepSeek is the third member of the exact seven-engine roster and has a terminal", () => {
  assert.deepEqual([...gate.TEAM_ORDER], ["claude", "codex", "deepseek", "kimi", "gemini", "hermes", "cursor"]);
  assert.deepEqual(Object.keys(settings.DEFAULTS.llm.roster), [...gate.TEAM_ORDER]);
  const app = gate.APPS.find((entry) => entry.id === "deepseek");
  assert.ok(app);
  assert.equal(app.tmux, "deepseek");
  assert.match(gateSource, /deepseek:\s*\{[\s\S]*?chatAdapter:\s*"deepseek-chat"/);
});

test("DeepSeek receives Git, autonomous, and Multi rights while Cursor remains excluded", () => {
  for (const setName of ["GIT_CHANGE_ENGINES", "AUTONOMOUS_EXEC_ENGINES", "MULTI_SHOWN_ENGINES"]) {
    const engines = sourceSet(setName);
    assert.ok(engines.includes("deepseek"), `${setName} includes DeepSeek`);
    assert.ok(!engines.includes("cursor"), `${setName} keeps Cursor chat-only`);
  }
  assert.ok(sourceSet("MULTI_SHOWN_ENGINES").includes("kimi"), "Kimi is visible in Multi");
  assert.match(gateSource, /const ENGINE_GIT_MAX_RUNG = Object\.freeze\(\{ deepseek: 1 \}\)/,
    "DeepSeek can commit only inside its private workspace and never push, open, or merge");
});

test("DeepSeek chat is fixed to the official V4 Flash endpoint and spends through the hard budget", () => {
  assert.match(gateSource, /const DEEPSEEK_API_ORIGIN = "https:\/\/api\.deepseek\.com\/v1"/);
  assert.match(gateSource, /const DEEPSEEK_CHAT_MODEL = "deepseek-v4-flash"/);
  const one = gateSource.slice(gateSource.indexOf("function runDeepSeekChat"), gateSource.indexOf("function streamDeepSeekTeam"));
  const budget = gateSource.slice(gateSource.indexOf("function reserveDeepSeekSpend"), gateSource.indexOf("function deepseekBudgetFailure"));
  assert.match(one, /loadBoxSecrets\(\)/, "the protected secret store is reread for each operation");
  assert.match(one, /DEEPSEEK_API_KEY/);
  assert.match(one, /reserveDeepSeekSpend\(/);
  assert.match(budget, /beginDeepSeekBudgetRun/);
  assert.match(one, /maxCompletionTokens:\s*spend\.maxCompletionTokens/);
  assert.match(one, /includeUsage:\s*true/);
  assert.match(one, /makeState:\s*engineAdapters\.deepseekMakeState/);
  assert.match(one, /lineTransform:\s*engineAdapters\.deepseekLineTransform/);
  assert.match(one, /recordUsage\("deepseek"/);
  assert.doesNotMatch(one, /DEEPSEEK_API_KEY.*(?:args|argv)/i);
});

test("DeepSeek Team chat uses the same transport and returns named readiness causes", () => {
  const team = gateSource.slice(gateSource.indexOf("function streamDeepSeekTeam"), gateSource.indexOf("// ---- N2:"));
  assert.match(team, /openAiCompatibleChat\(\{/);
  assert.match(team, /key missing/i);
  assert.match(team, /turned off/i);
  assert.match(team, /timed out/i);
  assert.match(gateSource, /streamDeepSeekTeam\(/);
});

test("Team quarantine propagates a protected-accounting cause and still kills peers", () => {
  const calls = [];
  const cause = gate.quarantineTeamStreams([
    { quarantine() { calls.push("deepseek"); return "protected budget restart required"; } },
    { kill() { calls.push("peer"); } },
    { quarantine() { calls.push("benign"); return null; } },
  ], "original quarantine cause");
  assert.equal(cause, "protected budget restart required");
  assert.deepEqual(calls, ["deepseek", "peer", "benign"]);
  const fanout = gateSource.slice(gateSource.indexOf("function runApiPhase"), gateSource.indexOf("// The CLI phase starts"));
  assert.match(fanout, /const terminalCause = quarantineTeamStreams\(liveStreams, reason\)/);
  assert.match(fanout, /failChatForQuarantine\(res, terminalCause\)/);
});

test("the runtime image includes the DeepSeek budget authority", () => {
  assert.match(dockerfile, /COPY deepseek-budget\.js \/opt\/agenthost\/deepseek-budget\.js/);
});

test("DeepSeek gets an independent private worktree and a keyless workspace terminal", () => {
  assert.match(startSource, /\[ "\$engine" = "deepseek" \][\s\S]{0,120}?make_independent_workspace/);
  assert.match(startSource, /make_worktree deepseek\s+deepseek\/work/);
  const terminal = startSource.slice(startSource.indexOf("#     DeepSeek runs headlessly"), startSource.indexOf("#     Claude workspace shell"));
  assert.match(terminal, /tmux new-window -t agent -n deepseek/);
  assert.match(terminal, /Workspace shell only/);
  assert.doesNotMatch(terminal, /DEEPSEEK_API_KEY|agenthost_load_secrets_env|\bdsh\b[^\n]*2>&1/,
    "the human workspace cannot bypass the governed headless runner or receive its key");
});

test("DeepSeek unattended readiness requires an exact independent deepseek/work checkout", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-deepseek-ready-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const workspace = path.join(home, "workspaces", "deepseek", "agenthost-internal");

  assert.equal(gate.deepseekWorkspaceReadiness("owner/agenthost-internal", home).ready, false,
    "a configured repo without a private checkout is unavailable");

  fs.mkdirSync(path.join(workspace, ".git"), { recursive: true });
  fs.writeFileSync(path.join(workspace, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(workspace, ".git", "index"), "");
  const wrongBranch = gate.deepseekWorkspaceReadiness("owner/agenthost-internal", home);
  assert.equal(wrongBranch.ready, false);
  assert.equal(wrongBranch.reasonCode, "WORKSPACE_UNAVAILABLE");
  assert.match(wrongBranch.summary, /deepseek\/work/);

  fs.rmSync(path.join(workspace, ".git"), { recursive: true, force: true });
  fs.writeFileSync(path.join(workspace, ".git"), "gitdir: ../shared/.git/worktrees/deepseek\n");
  assert.equal(gate.deepseekWorkspaceReadiness("owner/agenthost-internal", home).ready, false,
    "a linked-worktree .git pointer is not an independent checkout");

  fs.rmSync(path.join(workspace, ".git"), { force: true });
  fs.mkdirSync(path.join(workspace, ".git"));
  fs.writeFileSync(path.join(workspace, ".git", "HEAD"), "ref: refs/heads/deepseek/work\n");
  assert.equal(gate.deepseekWorkspaceReadiness("owner/agenthost-internal", home).ready, false,
    "a branch ref without an index is not a materialized workspace");
  fs.writeFileSync(path.join(workspace, ".git", "index"), "");
  const ready = gate.deepseekWorkspaceReadiness("owner/agenthost-internal", home);
  assert.equal(ready.ready, true);
  assert.equal(ready.worktree, fs.realpathSync(workspace));
  assert.deepEqual(ready.artifacts, [{ repo: "agenthost-internal", branch: "deepseek/work" }]);

  const moved = path.join(home, "moved-workspace");
  fs.renameSync(workspace, moved);
  fs.symlinkSync(moved, workspace, "junction");
  assert.equal(gate.deepseekWorkspaceReadiness("owner/agenthost-internal", home).ready, false,
    "a workspace junction is rejected even when its target has the right branch");
});

test("DeepSeek Multi checks API readiness without requiring its code-writing jail", () => {
  const stage = gateSource.slice(gateSource.indexOf("const runStage = (i, prevOutput)"), gateSource.indexOf("const stageRun = eng === \"deepseek\""));
  assert.match(stage, /eng === "deepseek"\s*\?\s*deepseekApiReadiness\(\)/,
    "the text-only Multi lane uses provider readiness");
  assert.match(stage, /providerReadiness\.reason/,
    "a failed Multi stage carries the provider's exact cause");
});

test("real DeepSeek requests refresh provider truth and relay failures stop the contained child", () => {
  const direct = gateSource.slice(gateSource.indexOf("function runDeepSeekChat"), gateSource.indexOf("function streamDeepSeekTeam"));
  const team = gateSource.slice(gateSource.indexOf("function streamDeepSeekTeam"), gateSource.indexOf("// Multi-Loops"));
  const autonomy = gateSource.slice(gateSource.indexOf("async function runDeepSeekAutonomousTask"), gateSource.indexOf("function runAutonomousTask"));
  const observation = gateSource.slice(gateSource.indexOf("function providerObservationInput"), gateSource.indexOf("function handleContinuity"));
  assert.match(direct, /noteDeepseekProviderObservation\(true, true\)/);
  assert.match(team, /noteDeepseekProviderObservation\(true, true\)/);
  assert.match(autonomy, /onFailure\(failure\)[\s\S]*?activeAgentChild\.kill\("SIGKILL"\)/,
    "a relay ledger failure stops the root-contained child instead of letting it keep spending");
  assert.match(autonomy, /noteDeepseekProviderObservation\(true, true\)/);
  assert.match(observation, /\.\.\.\(deepseekProviderObservation \|\| \{\}\)/,
    "the continuity status uses the last real request outcome without a paid probe");
});

test("DeepSeek Stop waits for root terminal proof instead of trusting a kill request", async () => {
  assert.equal(typeof gate.stopChildWithTerminalProof, "function");
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.terminationProven = false;
  let killSignal = null;
  let resolved = false;
  child.kill = (signal) => {
    killSignal = signal;
    setImmediate(() => {
      child.signalCode = signal;
      child.terminationProven = true;
      child.emit("close", null, signal);
    });
    return true;
  };

  const stopped = gate.stopChildWithTerminalProof(child, { timeoutMs: 250 })
    .then((proof) => { resolved = true; return proof; });
  assert.equal(resolved, false, "Stop remains pending after the signal is only queued");
  assert.equal(await stopped, true);
  assert.equal(killSignal, "SIGTERM");

  const unproven = new EventEmitter();
  unproven.exitCode = null;
  unproven.signalCode = null;
  unproven.terminationProven = false;
  unproven.kill = () => true;
  assert.equal(await gate.stopChildWithTerminalProof(unproven, { timeoutMs: 10 }), false,
    "a kill acknowledgement without a root terminal frame fails closed");
});

test("concurrent Stop and shutdown share one proof and cannot pass an accounting-before-exit race", async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.terminationProven = false;
  let kills = 0;
  let finalizes = 0;
  child.kill = () => { kills += 1; return true; };
  const state = {
    runId: "dshautorun-race",
    child,
    stopping: false,
    stopCause: null,
    stopPromise: null,
    lifecycle: { async finalize() { finalizes += 1; } },
  };

  let firstResolved = false;
  let secondResolved = false;
  const first = gate.stopDshRunState(state, { cause: "dsh_operator_stop", timeoutMs: 250 })
    .then((value) => { firstResolved = true; return value; });
  await new Promise((resolve) => setImmediate(resolve));
  const shared = state.stopPromise;
  const secondRaw = gate.stopDshRunState(state, { cause: "dsh_gateway_shutdown", timeoutMs: 250 });
  const second = secondRaw.then((value) => { secondResolved = true; return value; });
  assert.equal(secondRaw, shared, "shutdown joins the exact in-flight Stop proof");
  assert.equal(firstResolved, false);
  assert.equal(secondResolved, false);
  assert.equal(kills, 1);
  assert.equal(finalizes, 1);

  child.signalCode = "SIGTERM";
  child.terminationProven = true;
  child.emit("close", null, "SIGTERM");
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(kills, 1);
  assert.equal(finalizes, 1);
});

test("DeepSeek relay accounting closes and records exactly once across Stop and shutdown", async () => {
  assert.equal(typeof gate.createDshAccountingLifecycle, "function");
  const calls = [];
  const usage = { inputTokens: 11, outputTokens: 7, costUsd: 0.02, plan: "key" };
  const lifecycle = gate.createDshAccountingLifecycle({
    relay: {
      async cancel(cause) { calls.push(["cancel", cause]); },
      async close() { calls.push(["relay.close"]); },
    },
    budget: {
      usage() { calls.push(["usage"]); return usage; },
      close() { calls.push(["budget.close"]); },
    },
    fallbackCostUsd: 0.5,
    record(value) { calls.push(["record", value]); },
    forget() { calls.push(["forget"]); },
  });

  const [fromStop, fromShutdown] = await Promise.all([
    lifecycle.finalize("dsh_operator_stop"),
    lifecycle.finalize("dsh_gateway_shutdown"),
  ]);
  assert.deepEqual(fromStop, usage);
  assert.deepEqual(fromShutdown, usage);
  assert.deepEqual(calls, [
    ["cancel", "dsh_operator_stop"],
    ["relay.close"],
    ["usage"],
    ["budget.close"],
    ["record", usage],
    ["forget"],
  ]);

  const fallback = [];
  const failed = gate.createDshAccountingLifecycle({
    relay: {
      async cancel() { throw new Error("provider cancellation did not settle"); },
      async close() {},
    },
    budget: { usage: () => usage, close() {} },
    fallbackCostUsd: 0.5,
    record(value) { fallback.push(value); },
    forget() {},
  });
  await assert.rejects(failed.finalize("dsh_gateway_shutdown"), /provider cancellation did not settle/);
  assert.deepEqual(fallback, [{ inputTokens: 0, outputTokens: 0, costUsd: 0.5, plan: "key" }],
    "an accounting failure persists the full per-run ceiling before shutdown continues");

  const unsaved = gate.createDshAccountingLifecycle({
    relay: { async cancel() {}, async close() {} },
    budget: { usage: () => usage, close() {} },
    fallbackCostUsd: 0.5,
    record: () => false,
    forget() {},
  });
  assert.deepEqual(await unsaved.finalize("dsh_gateway_shutdown"), usage,
    "display-only usage failure cannot quarantine a run whose private WAL already settled");
});

test("autonomy Stop and graceful shutdown both use the terminal-proven DeepSeek lifecycle", () => {
  const autonomy = gateSource.slice(gateSource.indexOf("function handleAutonomy"), gateSource.indexOf("// The dashboard calls this"));
  const shutdown = gateSource.slice(gateSource.indexOf("function gracefulShutdown"));
  assert.match(autonomy, /await stopActiveDshRuns\("dsh_operator_stop"\)/);
  assert.doesNotMatch(autonomy, /activeAgentChild\.kill\("SIGTERM"\)/,
    "the route cannot answer from an unobserved kill request");
  assert.match(shutdown, /stopActiveDshRuns\("dsh_gateway_shutdown"\)/,
    "SIGTERM closes relay accounting before the process exits");
  assert.doesNotMatch(shutdown, /root did not acknowledge Assist fatal containment/,
    "a DeepSeek shutdown failure must not be mislabeled as Assist");
});

test("every paid DeepSeek lane requires one protected, fail-closed budget authority", () => {
  assert.equal(typeof gate.createDeepSeekBudgetAuthority, "function");
  let touched = 0;
  const unprotected = gate.createDeepSeekBudgetAuthority({
    protectedMode: false,
    state: {
      todayUsd() { touched += 1; return 0; },
      reserve() { touched += 1; },
      settle() { touched += 1; },
      cancel() { touched += 1; },
    },
  });
  assert.equal(unprotected.readiness().ready, false);
  assert.equal(unprotected.readiness().reasonCode, "PROTECTED_BUDGET_UNAVAILABLE");
  assert.throws(() => unprotected.assertReady(), /protected spending controls require Foundation B/i);
  assert.equal(touched, 0, "flag-off mode never reads or mutates the protected ledger");

  const failures = [];
  let reserveCalls = 0;
  const protectedAuthority = gate.createDeepSeekBudgetAuthority({
    protectedMode: true,
    state: {
      todayUsd: () => 0,
      reserve() { reserveCalls += 1; throw new Error("injected parent fsync failure at a private path"); },
      settle() {},
      cancel() {},
    },
    onFailure: (cause) => failures.push(cause),
  });
  assert.throws(() => protectedAuthority.reserve({ id: "r", runId: "run", day: "2026-08-13", reservedUsd: 1 }),
    /protected budget state could not be verified/i);
  assert.equal(protectedAuthority.readiness().ready, false);
  assert.equal(protectedAuthority.readiness().reasonCode, "PROTECTED_BUDGET_UNAVAILABLE");
  assert.throws(() => protectedAuthority.assertReady(), /restart is required/i);
  assert.equal(reserveCalls, 1);
  assert.equal(failures.length, 1, "the first strict-store failure is recorded once");
  assert.doesNotMatch(protectedAuthority.readiness().reason, /private path|fsync/i,
    "the operator cause stays useful without exposing protected filesystem detail");

  const begin = gateSource.slice(gateSource.indexOf("function beginDeepSeekBudgetRun"), gateSource.indexOf("const DSH_STOP_PROOF_MS"));
  assert.match(begin, /deepseekBudgetAuthority\.assertReady\(\)[\s\S]*?deepseekBudgetLedger\.beginRun/,
    "the central guard runs before every direct, Team, or autonomous reservation");
  assert.equal((gateSource.match(/deepseekBudgetLedger\.beginRun\(/g) || []).length, 1,
    "no paid DeepSeek lane bypasses the one protected begin function");
  assert.ok((gateSource.match(/beginDeepSeekBudgetRun\(/g) || []).length >= 3,
    "direct, Team, and autonomous lanes all enter through the protected begin function");
  assert.match(gateSource, /readTodayUsd:\s*\(day\)\s*=>\s*deepseekBudgetAuthority\.todayUsd\(day\)/);
  assert.match(gateSource, /onReserve:\s*\(reservation\)\s*=>\s*deepseekBudgetAuthority\.reserve\(reservation\)/);
  assert.match(gateSource, /onSettle:\s*\(reservation, costUsd\)\s*=>\s*deepseekBudgetAuthority\.settle\(reservation, costUsd\)/);
  assert.match(gateSource, /onCancel:\s*\(reservation\)\s*=>\s*deepseekBudgetAuthority\.cancel\(reservation\)/);
  assert.match(dockerfile, /COPY deepseek-budget-state\.js \/opt\/agenthost\/deepseek-budget-state\.js/);
  const paid = gateSource.slice(gateSource.indexOf("function reserveDeepSeekSpend"), gateSource.indexOf("function deepseekBudgetFailure"));
  assert.match(paid, /tzOffsetMin:\s*0/,
    "browser timezone input cannot split one hard daily ceiling across adjacent dates");
});
