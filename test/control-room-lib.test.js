import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  ccFeedFromLines,
  commandCenterEngineStates,
  consumeTaskOverrides,
  manualOverrideMatches,
  overrideRejectionReason,
  promotePostcondition,
  taskOverrideFingerprint,
} = require("../container/gate.js");

const kanbanBridge = fs.readFileSync(
  path.join(import.meta.dirname, "..", "container", "kanban-bridge.js"),
  "utf8",
);

const NOW = 1_800_000_000_000;

function engineSet(name) {
  const match = kanbanBridge.match(new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]\\)`));
  assert.ok(match, `${name} must remain a literal audited allowlist`);
  return new Set([...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]));
}

test("DeepSeek is accepted by both board assignment and Agent Room lifecycle", () => {
  assert.equal(engineSet("BOARD_ENGINES").has("deepseek"), true);
  assert.equal(engineSet("ROOM_LIFECYCLE_ENGINES").has("deepseek"), true);
});

test("task one-run override is exact, issue-scoped, content-bound, and expires", () => {
  const task = { id: "t_1", title: "Make the dashboard clearer", body: "Keep the current layout" };
  const record = {
    issue: "wording_gate",
    fingerprint: taskOverrideFingerprint(task),
    at: NOW - 1000,
    expiresAt: NOW + 1000,
  };
  assert.equal(manualOverrideMatches(record, task, "wording_gate", NOW), true);
  assert.equal(manualOverrideMatches(record, task, "loop_detector", NOW), false, "one issue cannot bypass another");
  assert.equal(manualOverrideMatches(record, { ...task, body: "Changed instructions" }, "wording_gate", NOW), false,
    "editing the reviewed task invalidates the override");
  assert.equal(manualOverrideMatches(record, task, "wording_gate", NOW + 1001), false, "unused overrides expire after their deadline");
});

test("matching overrides are consumed once when execution starts", () => {
  const task = { id: "t_1", title: "Run the unit tests", body: "" };
  const fingerprint = taskOverrideFingerprint(task);
  const sidecar = { manualOverrides: { t_1: {
    wording_gate: { issue: "wording_gate", fingerprint, at: NOW - 1, expiresAt: NOW + 1000 },
    loop_detector: { issue: "loop_detector", fingerprint, at: NOW - 1, expiresAt: NOW + 1000 },
    consequence_gate: { issue: "consequence_gate", fingerprint, at: NOW - 1, expiresAt: NOW + 1000 },
  } } };
  assert.deepEqual(consumeTaskOverrides(sidecar, task, NOW), ["wording_gate", "loop_detector", "consequence_gate"]);
  assert.equal(sidecar.manualOverrides.t_1, undefined, "the grant cannot authorize a second execution");
  assert.deepEqual(consumeTaskOverrides(sidecar, task, NOW), [], "a second consume is a no-op");
});

test("overrideRejectionReason names fingerprint mismatch and expiry", () => {
  const task = { id: "t_1", title: "Fix the bug", body: "Original" };
  const goodRecord = {
    issue: "wording_gate",
    fingerprint: taskOverrideFingerprint(task),
    at: NOW - 1000,
    expiresAt: NOW + 1000,
  };
  // Matching record: no rejection
  assert.equal(overrideRejectionReason(goodRecord, task, "wording_gate", NOW), null);
  // Fingerprint mismatch: task body changed
  const changedTask = { ...task, body: "Changed instructions" };
  assert.equal(overrideRejectionReason(goodRecord, changedTask, "wording_gate", NOW), "fingerprint mismatch");
  // Expired
  assert.equal(overrideRejectionReason(goodRecord, task, "wording_gate", NOW + 2000), "expired");
  // No record for this issue
  assert.equal(overrideRejectionReason(null, task, "wording_gate", NOW), null);
  // Record for a different issue
  assert.equal(overrideRejectionReason(goodRecord, task, "loop_detector", NOW), null);
});

test("consumeTaskOverrides audits rejected overrides with a reason", () => {
  const task = { id: "t_rej", title: "Rejected task", body: "Original" };
  const fp = taskOverrideFingerprint(task);
  // A record with a WRONG fingerprint — should be rejected, not silently skipped
  const sidecar = { manualOverrides: { t_rej: {
    wording_gate: { issue: "wording_gate", fingerprint: "deadbeef", at: NOW - 1, expiresAt: NOW + 1000 },
  } } };
  const consumed = consumeTaskOverrides(sidecar, task, NOW);
  assert.deepEqual(consumed, [], "a mismatched override is not consumed");
  // The record should still be present (not deleted) so the operator can see it
  assert.ok(sidecar.manualOverrides.t_rej, "the rejected record is not silently deleted");
  assert.ok(sidecar.manualOverrides.t_rej.wording_gate, "wording_gate record survives rejection");
});

test("consumeTaskOverrides audits expired overrides with a reason", () => {
  const task = { id: "t_exp", title: "Expired task", body: "Body" };
  const fp = taskOverrideFingerprint(task);
  const sidecar = { manualOverrides: { t_exp: {
    wording_gate: { issue: "wording_gate", fingerprint: fp, at: NOW - 2000, expiresAt: NOW - 1000 },
  } } };
  const consumed = consumeTaskOverrides(sidecar, task, NOW);
  assert.deepEqual(consumed, [], "an expired override is not consumed");
  assert.ok(sidecar.manualOverrides.t_exp, "the expired record is not silently deleted");
});

test("Promote succeeds only after the task is observed queued or running", () => {
  assert.equal(promotePostcondition({ status: "ready" }), true);
  assert.equal(promotePostcondition({ status: "running" }), true);
  assert.equal(promotePostcondition({ status: "blocked" }), false);
  assert.equal(promotePostcondition(null), false);
});

test("a later confirmed action resolves the older attention row for that exact task", () => {
  const lines = [
    JSON.stringify({ t: "2026-07-21T10:00:00.000Z", event: "autonomy_gated", detail: "codex: Make it", tid: "t_wording" }),
    JSON.stringify({ t: "2026-07-21T10:01:00.000Z", event: "board_loop_detected", detail: "4 cards, key=loop", tid: "t_loop" }),
    JSON.stringify({ t: "2026-07-21T10:02:00.000Z", event: "board_override_granted", detail: "wording_gate", tid: "t_wording" }),
    JSON.stringify({ t: "2026-07-21T10:03:00.000Z", event: "board_review_promote", detail: "t_loop", tid: "t_loop" }),
  ];
  const feed = ccFeedFromLines(lines);
  assert.equal(feed.some((f) => f.bad && f.taskId === "t_wording"), false, "the acknowledged wording alert clears");
  assert.equal(feed.some((f) => f.bad && f.taskId === "t_loop"), false, "the promoted loop representative clears");
  assert.ok(feed.some((f) => /promoted|allowed once/.test(f.what)), "the resolving action remains visible as normal activity");
});

test("an override resolves only its named detector, not every warning on the task", () => {
  const lines = [
    JSON.stringify({ t: "2026-07-21T10:00:00.000Z", event: "autonomy_gated", detail: "codex: Run it", tid: "t_both" }),
    JSON.stringify({ t: "2026-07-21T10:01:00.000Z", event: "board_loop_detected", detail: "4 cards, key=loop", tid: "t_both" }),
    JSON.stringify({ t: "2026-07-21T10:02:00.000Z", event: "board_override_granted", detail: "wording_gate: reviewed", tid: "t_both" }),
  ];
  const feed = ccFeedFromLines(lines);
  assert.equal(feed.some((f) => f.kind === "gated"), false, "the reviewed wording row clears");
  assert.equal(feed.some((f) => f.kind === "loop"), true, "the separate loop warning remains actionable");
});

test("engine status is driven by live activity and capability, never old token totals", () => {
  const states = commandCenterEngineStates({
    observedAt: NOW,
    usage: {
      codex: { in: 5000, out: 100, at: NOW - 5000 },
      claude: { in: 9000, out: 200, at: NOW - 1000 },
    },
    inventory: [
      { id: "claude", installed: true },
      { id: "codex", installed: true },
      { id: "gemini", installed: false },
      { id: "cursor", installed: true },
      { id: "hermes", installed: true },
      { id: "openclaw", installed: true },
    ],
    configured: { claude: true, codex: true, gemini: true, cursor: true, hermes: true },
    activity: { claude: { summary: "Answering chat", startedAt: NOW - 500 } },
    windows: [{ name: "bash", active: true }, { name: "hermes", active: false }],
    ollama: { up: true, loaded: [] },
    services: { ollama: { enabled: true }, openclaw: { enabled: false } },
    cursorAuthenticated: true,
  });

  assert.equal(states.claude.state, "working");
  assert.equal(states.claude.summary, "Answering chat");
  assert.equal(states.codex.state, "ready", "old token totals do not claim a live run");
  assert.equal(states.gemini.state, "not_installed");
  assert.equal(states.cursor.state, "ready");
  assert.equal(states.hermes.state, "ready");
  assert.equal(states.hermes.summary, "Terminal ready");
  assert.equal(states.openclaw.state, "not_configured");
  assert.equal(states.ollama.state, "ready");
  assert.equal(states.term.state, "ready");
  assert.equal(states.codex.observedAt, NOW);
  assert.equal(states.codex.lastActiveAt, NOW - 5000);
});

test("Kimi's roster status follows its live Moonshot route, not a CLI inventory row", () => {
  const ready = commandCenterEngineStates({
    observedAt: NOW,
    kimi: { enabled: true, credentialPresent: true },
  }).kimi;
  assert.equal(ready.state, "ready");
  assert.equal(ready.summary, "Moonshot route ready");

  const disabled = commandCenterEngineStates({
    observedAt: NOW,
    kimi: { enabled: false, credentialPresent: true },
  }).kimi;
  assert.equal(disabled.state, "not_configured");
  assert.equal(disabled.summary, "Moonshot is turned off in Settings");

  const noCredential = commandCenterEngineStates({
    observedAt: NOW,
    kimi: { enabled: true, credentialPresent: false },
  }).kimi;
  assert.equal(noCredential.state, "not_configured");
  assert.equal(noCredential.summary, "KIMI_API_KEY is not configured");
});

test("DeepSeek status distinguishes chat readiness from unattended runner readiness", () => {
  const ready = commandCenterEngineStates({
    observedAt: NOW,
    deepseek: { enabled: true, credentialPresent: true, autonomous: { ready: true, reason: "ready" } },
  }).deepseek;
  assert.equal(ready.state, "ready");
  assert.equal(ready.summary, "ready");

  const chatOnly = commandCenterEngineStates({
    observedAt: NOW,
    deepseek: {
      enabled: true,
      credentialPresent: true,
      autonomous: { ready: false, reason: "DeepSeek does not have a verified isolated workspace" },
    },
  }).deepseek;
  assert.equal(chatOnly.state, "ready", "the fixed API chat route remains usable");
  assert.equal(chatOnly.summary, "Chat ready; unattended blocked: DeepSeek does not have a verified isolated workspace");

  const noKey = commandCenterEngineStates({
    observedAt: NOW,
    deepseek: { enabled: true, credentialPresent: false, autonomous: { ready: false, reason: "DEEPSEEK_API_KEY is not configured" } },
  }).deepseek;
  assert.equal(noKey.state, "not_configured");
  assert.equal(noKey.summary, "key missing");
});

test("Hermes readiness follows the exact interactive terminal window", () => {
  const states = commandCenterEngineStates({
    observedAt: NOW,
    inventory: [{ id: "hermes", installed: true }],
    configured: { hermes: true },
    activity: {},
    windows: [{ name: "shell", active: true }],
  });
  assert.equal(states.hermes.state, "down");
  assert.equal(states.hermes.summary, "Hermes terminal not running");
});
