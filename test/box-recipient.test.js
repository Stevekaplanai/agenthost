// Box as a chat recipient — the operator lane (router build slice 2).
//
// "Box" is the box itself answering: deterministic server-owned truth (status,
// board, activity, runs, cancel), no CLI spawn, no model, no agent slot, and
// it answers even while an engine holds the lane. The hard invariant from the
// handoff: Box must NEVER silently become an unrestricted shell behind chat —
// the command set is closed and the one mutating verb (cancel) is the exact
// same already-user-reachable durable-run cancellation.
//
// These are source contracts (same pattern as team-transcript.test.js): the
// lane needs a live box to exercise, so the tests pin the wiring and the
// no-shell invariant against the actual gate source.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const gate = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");
const chat = fs.readFileSync(path.join(import.meta.dirname, "..", "dashboard", "components", "agenthost", "workspace-chat.tsx"), "utf8");
const agentData = fs.readFileSync(path.join(import.meta.dirname, "..", "dashboard", "lib", "agenthost-data.ts"), "utf8");

// The whole Box section, bounded by its banner and the next section's banner.
const boxSection = gate.slice(
  gate.indexOf("// ---- Box: the operator lane as a chat recipient"),
  gate.indexOf("// ---- Team chat: one message, every engine answers in turn"),
);

test("box: the section exists and owns every box helper", () => {
  assert.ok(boxSection.length > 0, "the Box section is present");
  for (const fn of ["boxHelpText", "boxStatusText", "boxRunsText", "boxActivityText", "boxBoardText", "boxCancelText", "runBoxChat"]) {
    assert.ok(boxSection.includes("function " + fn), fn + " lives in the Box section");
  }
});

test("box: NEVER a shell — no process spawn or engine argv in the lane", () => {
  // hermesKanban is the one allowed call that reaches a process: it is the
  // gate's existing governed board reader (spawn with fixed argv, no shell).
  assert.ok(!/devSpawn|child_process|execSync|spawnSync|\.args\(/.test(boxSection),
    "the Box lane contains no spawn/exec/argv path of its own");
  assert.ok(!boxSection.includes("acquireAgent"),
    "the Box lane never takes the agent slot");
  const kanbanCalls = boxSection.match(/hermesKanban\(/g) || [];
  assert.strictEqual(kanbanCalls.length, 1, "exactly one governed board read, nothing else");
  // The argv must stay FIXED and read-only. An options object is allowed beside
  // it (caller labelling, 2026-08-11) because it is not argv and never reaches
  // the process -- but the label must be a string LITERAL, so nothing
  // operator- or message-derived can ride into this lane through it.
  assert.match(boxSection, /hermesKanban\(\["list", "--json"\](?:, \{ caller: "[a-zA-Z]+" \})?\)/,
    "and it is the fixed read-only list command, with at most a literal caller label");
  const kanbanArgs = boxSection.match(/hermesKanban\((\[[^\]]*\])/);
  assert.equal(kanbanArgs && kanbanArgs[1], '["list", "--json"]',
    "the argv itself must contain no variable, template, or concatenation");
});

test("box: dispatched before engine resolution, behind the same gates as every turn", () => {
  const dispatch = gate.slice(gate.indexOf("function startChatRun"), gate.indexOf("// ---- Box: the operator lane"));
  assert.ok(dispatch.includes("runBoxChat(msg, req, res, tzOffsetMin);"),
    "startChatRun routes box turns to runBoxChat");
  const boxAt = dispatch.indexOf('engineId === "box"');
  const teamAt = dispatch.indexOf('engineId === "team"');
  const resolveAt = dispatch.indexOf("resolveEngine(engineId)");
  assert.ok(boxAt !== -1 && boxAt < teamAt && boxAt < resolveAt,
    "the box branch sits with the team branch, before resolveEngine (so 'box' can never fall through to claude)");
  const gateAt = dispatch.indexOf("chatGate");
  assert.ok(gateAt !== -1 && gateAt < boxAt, "the consequence/spend gates run before the box branch");
});

test("box: the legal brand is gated server-side, not just by the hidden selector", () => {
  const dispatch = gate.slice(gate.indexOf("function startChatRun"), gate.indexOf("// ---- Box: the operator lane"));
  const boxAt = dispatch.indexOf('engineId === "box"');
  const branch = dispatch.slice(boxAt, dispatch.indexOf("runBoxChat(msg", boxAt));
  assert.ok(branch.includes('BRAND === "legal"'),
    "a direct /chat/stream?engine=box hit on a legal box must not disclose the engine roster");
});

test("box: only the command word is lowercased — a cancel id keeps its case", () => {
  // Run ids are base64url (mixed case); lowercasing the whole message made
  // `cancel <id>` fail on most real ids (red-team finding, 2026-07-31).
  const runner = boxSection.slice(boxSection.indexOf("function runBoxChat"));
  assert.ok(runner.includes("raw.slice(0, firstSpace)).toLowerCase()"),
    "the dispatch word alone is lowercased");
  assert.ok(runner.includes("raw.slice(firstSpace + 1).trim()"),
    "the argument comes from the raw, case-preserved message");
  assert.ok(runner.includes("boxCancelText(arg, req)"), "cancel receives that raw argument");
  assert.ok(!runner.includes("q.slice(6)"), "the lowercased-slice bug stays dead");
});

test("box: answers while the agent lane is busy (never queued)", () => {
  assert.ok(gate.includes('if (agentBusy && engineId !== "box") { queueChatRun('),
    "box turns bypass the busy queue -- the operator lane answers during a run");
});

test("box: turns join the shared transcript with idempotent run-id-derived ids", () => {
  assert.ok(boxSection.includes('appendTeamThread("steve", msg, { id: res && res.runId, to: "box" })'),
    "Steve's box message lands with its recipient");
  assert.ok(boxSection.includes('appendTeamThread("box", reply, { id: res.runId + "-r" })'),
    "the box reply lands under the standard reply id");
});

test("box: cancel is the existing durable-run cancellation, audited the same way", () => {
  assert.ok(boxSection.includes("run.cancel()"), "reuses the durable run's own cancel");
  assert.ok(boxSection.includes('audit("chat_run_cancel_requested", run.meta.id, req, run.meta.engine)'),
    "audited identically to POST /chat/runs/<id>/cancel");
  assert.ok(boxSection.includes("CHAT_RUN_ACTIVE.has(r.meta.status)"),
    "only active runs are cancellable");
});

test("box: closed command set — anything unrecognized answers with help", () => {
  const runner = boxSection.slice(boxSection.indexOf("function runBoxChat")).replace(/\r/g, "");
  assert.ok(runner.trimEnd().endsWith("finish(boxHelpText());\n}"),
    "the router's fall-through is the help text, not execution of the message");
});

test("generated Workspace: Box is selectable outside the real-engine roster", () => {
  const chips = chat.slice(chat.indexOf("export function engineChips"), chat.indexOf("function routeFromText"));
  assert.match(chips, /\.\.\.roster\.map\(\(a\) => \(\{ id: a\.id as string, label: a\.name \}\)\)/,
    "the selector starts with the live engine roster");
  assert.match(chips, /\{ id: "box", label: "Box" \}/,
    "and adds Box as its own selectable recipient");
  const roster = agentData.slice(agentData.indexOf("export const ROSTER"), agentData.indexOf("export const AGENT_IDS"));
  assert.doesNotMatch(roster, /id:\s*"box"/,
    "Box stays out of the six-engine roster, so it gets no engine identity or board lane");
  assert.match(chat, /if \(name === "box"\) return "box"/,
    "a leading @box reaches that same server-owned recipient");
});
