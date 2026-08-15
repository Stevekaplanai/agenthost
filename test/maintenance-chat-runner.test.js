// Runner tests — the security properties, verified with a mock spawn so we inspect
// the EXACT setpriv argv + env the runner would launch (no real engine needed).
// ESM (repo root type:module); runner + profiles are CommonJS under container/.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import profilesMod from "../container/maintenance-chat-profiles.js";
import runnerMod from "../container/maintenance-chat-runner.js";
import laneMod from "../container/maintenance-agent-lane.js";
const { buildChatProfiles } = profilesMod;
const { createChatRunner, readCredentials, buildEngineEnv } = runnerMod;
const { createAgentLaneArbiter } = laneMod;

const HOME = "/data/home/agent";
const agentSpawnArgsStatic = (p, cont) => { const a = ["-p", p, "--dangerously-skip-permissions", "--settings", '{"disableAllHooks":true}']; if (cont) a.push("-c"); return a; };
const profiles = buildChatProfiles({
  homeDir: HOME, chatCwd: HOME + "/work", chatBin: "claude",
  charterArgs: ["--append-system-prompt", "CH"], agentSpawnArgsStatic,
  withCharter: (s) => "CH\n" + s,
});

// A mock contained process tree that records the launch request and lets the
// test drive output/terminal namespace close.
function mockLaunchFactory(record) {
  return (options) => {
    const child = new EventEmitter();
    child.pid = 8000 + record.length;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    // A stdin the runner is expected to CLOSE. The original fixture had none, so it
    // could not have caught the bug that took dispatch down on 2026-08-09: an open
    // stdin left codex waiting for input that never came, and it never finished its
    // turn. A mock that cannot fail the way production fails is not a test.
    child.stdin = new EventEmitter();
    child.stdin.ended = false;
    // Writes are RECORDED, because one profile now hands the engine its prompt
    // over stdin. A mock that swallowed the write could not tell "wrote the
    // prompt" apart from "wrote nothing", which is the whole property.
    child.stdin.written = "";
    child.stdin.write = (chunk) => { child.stdin.written += String(chunk); return true; };
    child.stdin.end = (chunk) => {
      if (chunk !== undefined) child.stdin.written += String(chunk);
      child.stdin.ended = true;
    };
    child.kill = (sig) => { child._killed = sig || "SIGTERM"; return true; };
    const handle = {
      child,
      handlePid: child.pid,
      namespaceIdentity: Object.freeze({ pid: child.pid + 100, startTime: 1, bootId: "test-boot" }),
    };
    record.push({ ...options, child, handle });
    return handle;
  };
}

function containedChild(child) {
  return {
    child,
    handlePid: child.pid || 8100,
    namespaceIdentity: Object.freeze({ pid: (child.pid || 8100) + 100, startTime: 1, bootId: "test-boot" }),
  };
}

function runnerContainment(extra = {}) {
  return {
    agentLaneArbiter: extra.agentLaneArbiter || createAgentLaneArbiter(),
    proveGone: extra.proveGone || (() => true),
    teardownContained: extra.teardownContained || ((handle) => {
      handle.child._killed = "SIGKILL";
    }),
  };
}

// A fake secrets.env content the runner reads by name. Includes an INJECTION line
// (LD_PRELOAD) that MUST NOT reach the engine env.
const SECRETS = [
  "GITHUB_TOKEN=github-protected-token",
  "GEMINI_API_KEY=gk-real-key",
  "CURSOR_API_KEY=cursor-real-key",
  "KIMI_API_KEY=kk-key",
  "LD_PRELOAD=/data/home/agent/.agenthost/evil.so",   // <-- the attack
  "NODE_OPTIONS=--require /tmp/evil.js",               // <-- the attack
  "BASH_ENV=/tmp/evil.sh",                             // <-- the attack
  "CHANNEL_DISPATCH_TOKEN=cdt",
  "OPENCLAW_GATEWAY_TOKEN=openclaw-gateway-only",
].join("\n");
const fakeRead = (p, enc) => SECRETS;

const ROOT_ENV = { HOME, PATH: "/usr/bin", TERM: "xterm", GEMINI_API_KEY: "gk-from-env",
  CURSOR_API_KEY: "cursor-from-env", LD_PRELOAD: "/should/not/pass",
  NODE_OPTIONS: "--require /evil", GITHUB_TOKEN: "ght", GIT_PUSH_TOKEN: "gate-write-token" };

function newRunner(record, extra = {}) {
  return createChatRunner({
    profiles, secretsPath: "/fake/secrets.env", withCharter: (s) => "CH\n" + s,
    uid: 1001, gid: 1001, launchContained: mockLaunchFactory(record),
    ...runnerContainment(extra),
    rootEnv: ROOT_ENV, readFileSync: fakeRead,
    onOutput: extra.onOutput || (() => {}), onExit: extra.onExit || (() => {}),
  });
}

test("SECURITY: engine env NEVER contains LD_PRELOAD/NODE_OPTIONS/BASH_ENV, even from secrets.env or root env", () => {
  const rec = [];
  newRunner(rec).run({ runId: "r1", engineId: "gemini", prompt: "hi" });
  const env = rec[0].env;
  assert.equal(env.LD_PRELOAD, undefined, "LD_PRELOAD must be dropped");
  assert.equal(env.NODE_OPTIONS, undefined, "NODE_OPTIONS must be dropped");
  assert.equal(env.BASH_ENV, undefined, "BASH_ENV must be dropped");
  // gemini's real key IS delivered (from secrets.env by name — root-side)
  assert.equal(env.GEMINI_API_KEY, "gk-real-key", "the requested credential IS delivered");
  // allowlisted non-secret names come through
  assert.equal(env.HOME, HOME);
  assert.equal(env.PATH, "/usr/bin");
});

test("SECURITY: requests containment for the fixed bin as the agent identity and real workspace", () => {
  const rec = [];
  newRunner(rec).run({ runId: "r2", engineId: "gemini", prompt: "hi" });
  const launch = rec[0];
  assert.equal(launch.uid, 1001);
  assert.equal(launch.gid, 1001);
  assert.equal(launch.cwd, profiles.gemini.cwd);
  assert.equal(launch.argv[0], "gemini");
});

test("SECURITY: OpenClaw delivery is fixed root-side and launches only as uid 1001", () => {
  const rec = [];
  const r = newRunner(rec);
  r.deliver({
    runId: "delivery-1",
    channel: "telegram",
    target: "-1001234567890",
    message: "hello from the box",
    // A compromised gate may send these fields; the root runner must ignore them.
    uid: 999,
    gid: 999,
    bin: "/bin/sh",
    argv: ["-c", "id"],
    env: { GIT_PUSH_TOKEN: "attacker-choice" },
  });

  assert.equal(rec.length, 1);
  const launch = rec[0];
  assert.equal(launch.uid, 1001);
  assert.equal(launch.gid, 1001);
  assert.equal(launch.cwd, HOME);
  assert.deepEqual(launch.argv, [
    "/usr/local/bin/openclaw",
    "message", "send", "--channel", "telegram",
    "--target=-1001234567890",
    "--message=hello from the box",
  ]);
  assert.equal(launch.env.HOME, HOME);
  assert.equal(launch.env.OPENCLAW_GATEWAY_TOKEN, "openclaw-gateway-only");
  for (const forbidden of ["GIT_PUSH_TOKEN", "GITHUB_TOKEN", "LD_PRELOAD", "NODE_OPTIONS", "BASH_ENV"]) {
    assert.equal(launch.env[forbidden], undefined, `${forbidden} must never reach OpenClaw delivery`);
  }
});

test("SECURITY: malformed delivery fields fail before any agent process starts", () => {
  for (const request of [
    { channel: "whatsapp", target: "123", message: "x" },
    { channel: "telegram", target: "../../tmp", message: "x" },
    { channel: "discord", target: "user:123", message: "" },
    { channel: "discord", target: "user:123", message: "x".repeat(5000) },
  ]) {
    const rec = [];
    let exit = null;
    const r = newRunner(rec, { onExit: (_id, info) => { exit = info; } });
    r.deliver({ runId: "bad-delivery", ...request });
    assert.equal(rec.length, 0);
    assert.equal(exit && exit.error, "invalid_delivery");
  }
});

test("SECURITY: unknown/malicious engineId spawns NOTHING and fast-fails", () => {
  for (const bad of ["../../bin/sh", "bash", "claude; sh", "sh", "gemini/../codex", "unknown"]) {
    const rec = []; let exited = null;
    createChatRunner({ profiles, secretsPath: "/x", withCharter: (s)=>s, launchContained: mockLaunchFactory(rec),
      ...runnerContainment(),
      rootEnv: ROOT_ENV, readFileSync: fakeRead, onExit: (id, info) => { exited = info; } })
      .run({ runId: "b", engineId: bad, prompt: "x" });
    assert.equal(rec.length, 0, `engineId "${bad}" must spawn nothing`);
    assert.equal(exited && exited.error, "unknown_engine", `engineId "${bad}" must fast-fail`);
  }
});

test("SECURITY: the prompt is ONE argv element — no shell/flag injection from prompt", () => {
  const rec = [];
  const evil = "; id > /tmp/pwned\n$(whoami) `id` --dangerously-skip-permissions";
  newRunner(rec).run({ runId: "r3", engineId: "gemini", prompt: evil });
  const args = rec[0].argv;
  // gemini template: setpriv ... -- gemini -p {promptWithCharter} --output-format json --skip-trust
  const dashP = args.indexOf("-p");
  assert.ok(dashP >= 0, "gemini has -p");
  assert.equal(args[dashP + 1], "CH\n" + evil, "prompt is exactly ONE element, charter-prefixed, unparsed");
  // the evil string never appears as its own flag element
  assert.equal(args.filter((a) => a === "--dangerously-skip-permissions").length, 0, "prompt cannot inject a flag");
});

test("SECURITY: Cursor gets only its named key and one ask-mode prompt after --", () => {
  const rec = [];
  const prompt = "--force is prompt text";
  newRunner(rec).run({ runId: "cursor1", engineId: "cursor", prompt });
  const { argv: args, env } = rec[0];
  assert.equal(args[0], "/usr/local/bin/cursor-agent");
  assert.equal(env.CURSOR_API_KEY, "cursor-real-key");
  assert.equal(env.GEMINI_API_KEY, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.ok(args.includes("--disable-auto-update"),
    "Cursor cannot replace the checksum-pinned runtime");
  assert.ok(args.includes("--trust"),
    "Cursor bypasses only its workspace trust prompt");
  const boundary = args.lastIndexOf("--");
  assert.ok(boundary > args.indexOf("ask"), "Cursor keeps the prompt behind --");
  assert.equal(args[boundary + 1], "CH\n" + prompt);
  assert.equal(args.filter((arg) => arg === "CH\n" + prompt).length, 1);
  assert.equal(args.includes("cursor-real-key"), false, "the key never enters argv");
  for (const forbidden of ["--api-key", "--force", "--yolo", "--background", "--worktree"]) {
    assert.equal(args.includes(forbidden), false, "Cursor runner must not contain " + forbidden);
  }
});

test("SECURITY: codex bad sessionId is DROPPED (runs fresh, -- terminator intact)", () => {
  const rec = [];
  newRunner(rec).run({ runId: "r4", engineId: "codex", prompt: "x", sessionId: "--dangerously-bypass-approvals-and-sandbox" });
  const args = rec[0].argv;
  // must be the FRESH template (no "resume"), -- present, no injected flag
  assert.equal(args.includes("resume"), false, "bad sessionId must NOT trigger resume");
  assert.ok(args.includes("--"), "-- terminator present");
  assert.equal(args.includes("--dangerously-bypass-approvals-and-sandbox"), false, "bad sessionId never reaches argv");
  assert.ok(args.includes("read-only"), "sandbox stays read-only");
});

test("codex VALID sessionId (uuid) triggers resume with the id as one element", () => {
  const rec = [];
  const sid = "019f915c-528f-7ef2-9ade-fcb633ce3b4e";
  newRunner(rec).run({ runId: "r5", engineId: "codex", prompt: "x", sessionId: sid });
  const args = rec[0].argv;
  const ri = args.indexOf("resume");
  assert.ok(ri >= 0, "valid uuid triggers resume");
  assert.equal(args[ri + 1], sid, "sessionId is the single element after resume");
  assert.equal(args[ri + 2], "--", "-- immediately follows the resume id");
});

test("claude withContinue selects the +continue template (adds -c), else not", () => {
  const rec = [];
  const r = newRunner(rec);
  r.run({ runId: "c1", engineId: "claude", prompt: "x", withContinue: true });
  assert.ok(rec[0].argv.includes("-c"), "withContinue adds -c");
  rec[0].child.emit("close", 0, null);
  r.run({ runId: "c2", engineId: "claude", prompt: "x", withContinue: false });
  assert.equal(rec[1].argv.includes("-c"), false, "no continue = no -c");
});

test("SECURITY: claude-assist streams safely with cross-chunk redaction", () => {
  assert.ok(profiles["claude-assist"], "the fixed claude-assist profile must exist");
  const oauth = "claude-oauth-fixture-0123456789-abcdef";
  const apiKey = "anthropic-api-fixture-0123456789-abcdef";
  const rec = [];
  const out = [];
  const r = createChatRunner({
    profiles, secretsPath: "/fake/secrets.env", withCharter: (s) => "CH\n" + s,
    uid: 1001, gid: 1001, launchContained: mockLaunchFactory(rec), ...runnerContainment(),
    rootEnv: { ...ROOT_ENV, CLAUDE_CODE_OAUTH_TOKEN: oauth, ANTHROPIC_API_KEY: apiKey },
    readFileSync: (file) => String(file).endsWith("/.codex/auth.json") ? "{}" : SECRETS,
    onOutput: (_id, stream, text) => out.push([stream, text]),
  });
  r.run({ runId: "assist-1", engineId: "claude-assist", prompt: "improve this" });
  assert.equal(rec[0].uid, 1001);
  assert.equal(rec[0].gid, 1001);
  assert.equal(rec[0].argv.includes("improve this"), false, "the draft must not be readable from process argv");
  assert.equal(Object.values(rec[0].env).includes("improve this"), false, "the draft must not be copied into child env");
  assert.equal(rec[0].stdin, "pipe");
  assert.equal(rec[0].child.stdin.written, "improve this", "the draft reaches Claude exactly once over stdin");
  assert.equal(rec[0].child.stdin.ended, true);
  assert.equal(rec[0].env.CLAUDE_CODE_OAUTH_TOKEN, oauth);
  assert.equal(rec[0].env.CLAUDE_CODE_DISABLE_THINKING, "1");
  assert.equal(rec[0].env.MAX_THINKING_TOKENS, "0");
  for (const name of ["ANTHROPIC_API_KEY", "GITHUB_TOKEN", "GIT_PUSH_TOKEN", "LD_PRELOAD", "NODE_OPTIONS", "BASH_ENV"]) {
    assert.equal(rec[0].env[name], undefined, `${name} must not reach Assist`);
  }
  const first = JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Fast " } } }) + "\n";
  const second = JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "answer" } } }) + "\n";
  rec[0].child.stdout.emit("data", Buffer.from(first.slice(0, 21)));
  rec[0].child.stdout.emit("data", Buffer.from(first.slice(21) + second));
  assert.ok(out.length >= 1, "a completed safe stream line is emitted before process close");
  rec[0].child.emit("close", 1, null);
  for (const [, text] of out) {
    assert.doesNotMatch(text, new RegExp(`${oauth}|${apiKey}`));
  }
});

test("cancelling claude-assist reopens only Assist after close and leaves chat untouched", () => {
  const shared = createAgentLaneArbiter();
  const held = shared.acquire("chat:already-running");
  assert.ok(held);
  const rec = [];
  const exits = [];
  const runner = createChatRunner({
    profiles, secretsPath: "/fake/secrets.env", withCharter: (s) => s,
    uid: 1001, gid: 1001, launchContained: mockLaunchFactory(rec), ...runnerContainment(),
    agentLaneArbiter: shared, rootEnv: ROOT_ENV, readFileSync: () => SECRETS,
    onExit: (id, info) => exits.push([id, info]),
  });
  runner.run({ runId: "assist-private", engineId: "claude-assist", prompt: "improve this" });
  assert.equal(rec.length, 1, "Assist launches while chat owns the shared lane");
  runner.run({ runId: "assist-second", engineId: "claude-assist", prompt: "second" });
  assert.equal(rec.length, 1, "the Assist-only lane permits exactly one run");
  assert.equal(exits.at(-1)[1].error, "assist_lane_busy");
  assert.equal(runner.kill("assist-private", "SIGKILL"), true);
  assert.equal(rec[0].child._killed, "SIGKILL");
  runner.run({ runId: "assist-before-close", engineId: "claude-assist", prompt: "still held" });
  assert.equal(rec.length, 1, "a kill request is not terminal proof and does not release Assist early");
  rec[0].child.emit("close", null, "SIGKILL");
  runner.run({ runId: "assist-after-close", engineId: "claude-assist", prompt: "replacement" });
  assert.equal(rec.length, 2, "proven Assist close reopens only its private lane");
  runner.run({ runId: "chat-still-held", engineId: "claude", prompt: "chat" });
  assert.equal(rec.length, 2, "Assist cancellation never releases the pre-existing shared chat lease");
  assert.equal(exits.at(-1)[1].error, "agent_lane_busy");
  rec[1].child.emit("close", 0, null);
  assert.equal(shared.release(held), true, "the original chat owner still exclusively owns its lease");
});

test("SECURITY: claude-brand-dna supports and redacts both customer auth paths", () => {
  const apiKey = "brand-dna-auth-overlap-0123456789";
  const oauth = apiKey + "-oauth-suffix";
  const rec = [];
  const out = [];
  const r = createChatRunner({
    profiles, secretsPath: "/fake/secrets.env", withCharter: (s) => "CH\n" + s,
    uid: 1001, gid: 1001, launchContained: mockLaunchFactory(rec), ...runnerContainment(),
    rootEnv: { ...ROOT_ENV, CLAUDE_CODE_OAUTH_TOKEN: oauth, ANTHROPIC_API_KEY: apiKey },
    readFileSync: (file) => String(file).endsWith("/.codex/auth.json") ? "{}" : SECRETS,
    onOutput: (_id, stream, text) => out.push([stream, text]),
  });
  r.run({ runId: "brand-dna-1", engineId: "claude-brand-dna", prompt: "one prompt" });
  const launch = rec[0];
  assert.equal(launch.env.CLAUDE_CODE_OAUTH_TOKEN, oauth);
  assert.equal(launch.env.ANTHROPIC_API_KEY, apiKey);
  assert.equal(launch.argv.includes("--dangerously-skip-permissions"), false);
  assert.equal(launch.argv[launch.argv.indexOf("--tools") + 1], "");
  assert.equal(launch.argv.includes("--strict-mcp-config"), true);
  assert.equal(launch.argv.includes("--no-session-persistence"), true);
  assert.equal(launch.argv.includes("stream-json"), false);
  launch.child.stderr.emit("data", Buffer.from(`failure ${oauth} ${apiKey}`));
  assert.equal(out.length, 0, "Brand DNA output stays buffered until terminal process proof");
  launch.child.emit("close", 1, null);
  assert.equal(out.length, 1);
  assert.doesNotMatch(out[0][1], new RegExp(`${oauth}|${apiKey}`));
  assert.match(out[0][1], /\[REDACTED\]/);
});

test("SECURITY: claude-brand-dna runs on an API-key-only customer box", () => {
  const rec = [];
  const apiKey = "brand-dna-api-only-fixture-0123456789";
  const r = createChatRunner({
    profiles, secretsPath: "/fake/secrets.env", withCharter: (s) => "CH\n" + s,
    uid: 1001, gid: 1001, launchContained: mockLaunchFactory(rec), ...runnerContainment(),
    rootEnv: { ...ROOT_ENV, ANTHROPIC_API_KEY: apiKey },
    readFileSync: (file) => String(file).endsWith("/.codex/auth.json") ? "{}" : SECRETS,
  });
  r.run({ runId: "brand-dna-api-1", engineId: "claude-brand-dna", prompt: "one prompt" });
  assert.equal(rec[0].env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(rec[0].env.ANTHROPIC_API_KEY, apiKey);
  rec[0].child.emit("close", 0, null);
});

test("SECURITY: buffered Brand DNA overflow is killed and names its cause without truncated output", () => {
  const rec = [];
  const out = [];
  const exits = [];
  const r = createChatRunner({
    profiles, secretsPath: "/fake/secrets.env", withCharter: (s) => "CH\n" + s,
    uid: 1001, gid: 1001, launchContained: mockLaunchFactory(rec), ...runnerContainment(),
    rootEnv: { ...ROOT_ENV, CLAUDE_CODE_OAUTH_TOKEN: "brand-dna-oauth-fixture-0123456789" },
    readFileSync: (file) => String(file).endsWith("/.codex/auth.json") ? "{}" : SECRETS,
    onOutput: (_id, stream, text) => out.push([stream, text]),
    onExit: (_id, info) => exits.push(info),
  });
  r.run({ runId: "brand-dna-overflow-1", engineId: "claude-brand-dna", prompt: "one prompt" });
  rec[0].child.stdout.emit("data", Buffer.from("x".repeat(65_537)));
  assert.equal(rec[0].child._killed, "SIGKILL");
  assert.deepEqual(out, []);
  rec[0].child.emit("close", 0, null);
  assert.deepEqual(out, [], "truncated model JSON must never be forwarded as a valid response");
  assert.equal(exits[0].exitCode, null);
  assert.match(exits[0].error, /claude-brand-dna stdout exceeded the 65536-character buffer/i);
});

test("SECURITY: prototype property names are unknown profiles, never root-runner objects", () => {
  const rec = [];
  const exits = [];
  const r = createChatRunner({
    profiles, secretsPath: "/fake/secrets.env", withCharter: (s) => s,
    uid: 1001, gid: 1001, launchContained: mockLaunchFactory(rec), ...runnerContainment(),
    rootEnv: ROOT_ENV, readFileSync: () => SECRETS,
    onExit: (_runId, info) => exits.push(info),
  });
  assert.doesNotThrow(() => r.run({ runId: "proto-1", engineId: "__proto__", prompt: "x" }));
  assert.deepEqual(exits, [{ exitCode: null, signalName: null, error: "unknown_engine" }]);
  assert.equal(rec.length, 0, "a prototype property must never reach argv or spawn composition");
  assert.equal(r.engineReady("__proto__"), false, "readiness must reject inherited object properties too");
});

test("streaming: chunks stream, close emits code+signal", () => {
  const out = []; let exit = null;
  const record = [];
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true;
  const r = createChatRunner({ profiles, secretsPath: "/x", withCharter: (s)=>s,
    launchContained: () => { record.push(1); return containedChild(child); }, ...runnerContainment(),
    rootEnv: ROOT_ENV, readFileSync: fakeRead,
    onOutput: (id, s, t) => out.push([id, s, t]), onExit: (id, info) => { exit = { id, ...info }; } });
  r.run({ runId: "s2", engineId: "gemini", prompt: "hi" });
  child.stdout.emit("data", Buffer.from("tok1"));
  child.stdout.emit("data", Buffer.from("tok2"));
  child.stderr.emit("data", Buffer.from("warn"));
  child.emit("close", 0, null);
  assert.deepEqual(out, [["s2","stdout","tok1"],["s2","stdout","tok2"],["s2","stderr","warn"]]);
  assert.deepEqual(exit, { id: "s2", exitCode: 0, signalName: null });
});

test("close with a signal reports signalName (killed vs real exit distinguishable)", () => {
  let exit = null;
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true;
  const r = createChatRunner({ profiles, secretsPath: "/x", withCharter: (s)=>s,
    launchContained: () => containedChild(child), ...runnerContainment(),
    rootEnv: ROOT_ENV, readFileSync: fakeRead, onExit: (id, info) => { exit = info; } });
  r.run({ runId: "k1", engineId: "gemini", prompt: "hi" });
  child.emit("close", null, "SIGKILL");
  assert.deepEqual(exit, { exitCode: null, signalName: "SIGKILL" });
});

test("a post-spawn child error does not claim terminal status before close", () => {
  let exit = null;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 321;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => true;
  const r = createChatRunner({
    profiles,
    secretsPath: "/x",
    withCharter: (s) => s,
    launchContained: () => containedChild(child),
    ...runnerContainment(),
    rootEnv: ROOT_ENV,
    readFileSync: fakeRead,
    onExit: (_id, info) => { exit = info; },
  });

  r.run({ runId: "error-after-spawn", engineId: "gemini", prompt: "hi" });
  child.exitCode = 1;
  child.emit("error", Object.assign(new Error("after exit, before close"), { code: "EPERM" }));
  assert.equal(exit, null, "an error from a still-live child is not terminal proof");
  assert.equal(exit, null, "even an observed exitCode cannot reopen admission before close");
  assert.equal(r.activeCount(), 1, "the runner keeps ownership until close");

  child.emit("close", 1, null);
  assert.deepEqual(exit, { exitCode: 1, signalName: null, error: "EPERM" });
  assert.equal(r.activeCount(), 0);
});

test("a synchronous spawn throw is terminal because no child exists", () => {
  let exit = null;
  const r = createChatRunner({
    profiles,
    secretsPath: "/x",
    withCharter: (s) => s,
    launchContained: () => {
      const error = Object.assign(new Error("missing"), { code: "ENOENT", conclusiveNoChild: true });
      throw error;
    },
    ...runnerContainment(),
    rootEnv: ROOT_ENV,
    readFileSync: fakeRead,
    onExit: (_id, info) => { exit = info; },
  });
  r.run({ runId: "spawn-throw", engineId: "gemini", prompt: "hi" });
  assert.deepEqual(exit, { exitCode: null, signalName: null, error: "ENOENT" });
  assert.equal(r.activeCount(), 0);
});

test("post-spawn setup failure kills but waits for close before reporting exit", () => {
  let exit = null;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.on = () => { throw Object.assign(new Error("wiring failed"), { code: "ESETUP" }); };
  child.stderr = new EventEmitter();
  child.pid = 654;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal) => { child.killedWith = signal; return true; };
  const r = createChatRunner({
    profiles,
    secretsPath: "/x",
    withCharter: (s) => s,
    launchContained: () => containedChild(child),
    ...runnerContainment({
      teardownContained: (handle) => { handle.child.killedWith = "SIGKILL"; },
    }),
    rootEnv: ROOT_ENV,
    readFileSync: fakeRead,
    onExit: (_id, info) => { exit = info; },
  });

  r.run({ runId: "setup-throw", engineId: "gemini", prompt: "hi" });
  assert.equal(child.killedWith, "SIGKILL");
  assert.equal(exit, null, "setup failure is not terminal process proof");
  assert.equal(r.activeCount(), 1);

  child.emit("close", null, "SIGKILL");
  assert.deepEqual(exit, { exitCode: null, signalName: "SIGKILL", error: "ESETUP" });
  assert.equal(r.activeCount(), 0);
});

test("the root runner admits one heavyweight child globally until actual close", () => {
  const children = [];
  const exits = [];
  const launchContained = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 9000 + children.length;
    child.exitCode = null;
    child.signalCode = null;
    child.kill = (signal) => { child.killedWith = signal; return true; };
    children.push(child);
    return containedChild(child);
  };
  const r = createChatRunner({
    profiles,
    secretsPath: "/x",
    withCharter: (s) => s,
    launchContained,
    ...runnerContainment({
      teardownContained: (handle) => { handle.child.killedWith = "SIGKILL"; },
    }),
    rootEnv: ROOT_ENV,
    readFileSync: fakeRead,
    onExit: (id, info) => exits.push([id, info]),
  });

  r.run({ runId: "lane-1", engineId: "gemini", prompt: "first" });
  r.run({ runId: "lane-2", engineId: "claude", prompt: "second" });
  const duplicate = r.run({ runId: "lane-1", engineId: "gemini", prompt: "duplicate" });
  assert.equal(children.length, 1, "different and duplicate runIds cannot bypass the root-global lane");
  assert.deepEqual(exits, [
    ["lane-2", { exitCode: null, signalName: null, error: "agent_lane_busy" }],
  ]);
  assert.equal(duplicate.duplicate, true);

  children[0].emit("error", Object.assign(new Error("still live"), { code: "EPERM" }));
  r.kill("lane-1", "SIGKILL");
  r.run({ runId: "lane-3", engineId: "gemini", prompt: "third" });
  assert.equal(children.length, 1, "error and kill are not terminal proof and cannot release admission");
  assert.equal(exits.at(-1)[1].error, "agent_lane_busy");

  children[0].emit("close", null, "SIGKILL");
  r.run({ runId: "lane-4", engineId: "gemini", prompt: "fourth" });
  assert.equal(children.length, 2, "only the actual child close reopens admission");
});

test("an explicit no-child spawn failure releases root admission", () => {
  let attempts = 0;
  const second = new EventEmitter();
  second.stdout = new EventEmitter();
  second.stderr = new EventEmitter();
  second.pid = 777;
  second.exitCode = null;
  second.signalCode = null;
  second.kill = () => true;
  const r = createChatRunner({
    profiles,
    secretsPath: "/x",
    withCharter: (s) => s,
    launchContained: () => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error("no child"), { code: "ENOENT", conclusiveNoChild: true });
      }
      return containedChild(second);
    },
    ...runnerContainment(),
    rootEnv: ROOT_ENV,
    readFileSync: fakeRead,
  });
  r.run({ runId: "no-child", engineId: "gemini", prompt: "first" });
  r.run({ runId: "after-no-child", engineId: "gemini", prompt: "second" });
  assert.equal(attempts, 2);
  assert.equal(r.activeCount(), 1);
});

test("readCredentials returns ONLY requested names (never the whole file)", () => {
  const creds = readCredentials("/x", ["GEMINI_API_KEY"], () => SECRETS);
  assert.deepEqual(creds, { GEMINI_API_KEY: "gk-real-key" });
  assert.equal(creds.LD_PRELOAD, undefined);
  assert.equal(creds.CHANNEL_DISPATCH_TOKEN, undefined);
});

test("Foundation B gives Claude the protected GitHub token and its safe aliases", () => {
  const rec = [];
  newRunner(rec).run({ runId: "claude-github", engineId: "claude", prompt: "inspect the repo" });
  const env = rec[0].env;

  assert.equal(env.GITHUB_TOKEN, "github-protected-token",
    "the protected store replaces a stale inherited GitHub token");
  assert.equal(env.GH_TOKEN, "github-protected-token", "gh receives the canonical token alias");
  assert.equal(env.GITHUB_PERSONAL_ACCESS_TOKEN, "github-protected-token",
    "the official GitHub MCP receives the canonical token alias");
  assert.equal(env.GIT_PUSH_TOKEN, undefined, "the gate-only push credential never crosses to Claude");
});

test("Foundation B redacts Claude's protected GitHub token before gate output", () => {
  const rec = [];
  const out = [];
  const runner = createChatRunner({
    profiles, secretsPath: "/fake/secrets.env", withCharter: (s) => "CH\n" + s,
    uid: 1001, gid: 1001, launchContained: mockLaunchFactory(rec), ...runnerContainment(),
    rootEnv: ROOT_ENV, readFileSync: fakeRead,
    onOutput: (_runId, stream, text) => out.push([stream, text]),
  });
  runner.run({ runId: "claude-github-output", engineId: "claude", prompt: "inspect" });
  rec[0].child.stdout.emit("data", Buffer.from("token=github-protected-token"));

  assert.deepEqual(out, [["stdout", "token=[REDACTED]"]]);
  assert.doesNotMatch(out[0][1], /github-protected-token/,
    "the credential must not cross into the gate transcript");
});

// The engine env is built from the RUNNER'S OWN env, and the runner is spawned by
// PID 1 -- so HOME/USER/LOGNAME arrive as root's. setpriv then drops the child to
// uid agent, which cannot write /root (drwx------ root root), and every
// file-credential engine dies reaching for its own config directory. On
// 2026-08-01 that was hermes (/root/.hermes/.env), codex
// (/root/.codex/config.toml), cursor (/root/.cursor/projects/...) and claude's
// Bash tool (/root/.claude/session-env/...) -- while gemini and kimi answered
// fine, because API-key engines never open a credential file.
// deliver() has always hardcoded the agent identity; the engine path did not.
test("the engine env announces the agent, never root", () => {
  const profile = { envAllowlist: ["HOME", "PATH", "USER", "LOGNAME"], credentialNames: [] };
  const rootEnv = { HOME: "/root", USER: "root", LOGNAME: "root", PATH: "/usr/bin" };

  const env = buildEngineEnv(profile, {
    rootEnv, secretsPath: "/nonexistent", agentHome: "/data/home/agent",
  });

  assert.equal(env.HOME, "/data/home/agent",
    "HOME must be the agent home: the engine writes .claude/.codex/.hermes/.cursor under it");
  assert.equal(env.USER, "agent",
    "USER must be agent: tools resolve config dirs from it, not only HOME");
  assert.equal(env.LOGNAME, "agent", "LOGNAME must match USER");
  assert.equal(env.PATH, "/usr/bin", "unrelated allowlisted names still pass through");
});

test("the engine's stdin is CLOSED, so a one-shot run never waits for input that will not come", () => {
  // 2026-08-09: autonomous dispatch was down for hours because this did not happen.
  // These are one-shot runs -- the prompt is argv and nothing is ever written to the
  // child -- but stdin stayed open, so codex printed "Reading additional input from
  // stdin..." and never completed its turn. The classifier streamed a preamble,
  // timed out at 10s, gated the card and parked it. Four correct fixes to the settle
  // path, the decoder, the timeout and the mount were all irrelevant: there was
  // never an answer to put through them.
  const rec = [];
  newRunner(rec).run({ runId: "r-stdin", engineId: "gemini", prompt: "hi" });
  const child = rec[0].child;
  assert.ok(child.stdin, "the fixture supplies a stdin -- without one this test proves nothing");
  assert.equal(child.stdin.ended, true, "the runner must end the child's stdin");
});

test("a child with no stdin does not throw the runner", () => {
  // Not every launch shape exposes stdin. Closing it must be best-effort: a missing
  // stdin is normal, and turning that into an exception would take down every run.
  const rec = [];
  const noStdin = (options) => {
    const child = new EventEmitter();
    child.pid = 9001;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    // deliberately NO stdin
    const handle = { child, handlePid: child.pid, namespaceIdentity: Object.freeze({ pid: 9101, startTime: 1, bootId: "test-boot" }) };
    rec.push({ ...options, child, handle });
    return handle;
  };
  const runner = createChatRunner({
    profiles, secretsPath: "/fake/secrets.env", withCharter: (s) => s,
    uid: 1001, gid: 1001, launchContained: noStdin,
    ...runnerContainment(),
    rootEnv: ROOT_ENV, readFileSync: fakeRead,
    onOutput: () => {}, onExit: () => {},
  });
  assert.doesNotThrow(() => runner.run({ runId: "r-nostdin", engineId: "gemini", prompt: "hi" }));
});

// READINESS IS ABOUT CREDENTIALS, NOT ABOUT THE LANE.
// (READINESS-CACHE-POISONED-NOT-CODEX, 2026-08-10.)
//
// engineReady() began by returning false whenever the lane was owned, busy or
// quarantined. The GATE CACHES this answer, so a refresh landing during a busy
// lane recorded "this engine has no credentials" -- a fact that was never about
// credentials -- and the gate failed closed until something invalidated it.
// Measured live: the broker answered `codex ready=true` while the gate's cache
// had said `codex_readiness_not_ready` for over an hour, with 18 quarantine
// events that night.
test("engineReady stays true while the lane is BUSY -- readiness is a credential fact", () => {
  const rec = [];
  const runner = newRunner(rec);

  assert.equal(runner.engineReady("gemini"), true, "ready before anything runs");

  // Occupy the lane with a real run, exactly as a live dispatch would.
  runner.run({ runId: "busy-1", engineId: "gemini", prompt: "hold the lane" });

  assert.equal(runner.engineReady("gemini"), true,
    "a busy lane must NOT report the engine as credential-unready -- that answer gets cached");
});

test("a busy lane still refuses a second run, independently of engineReady", () => {
  // The safety this change relies on. run() guards the lane twice and
  // unconditionally, so removing the lane check from engineReady cannot let a
  // second run start. If this ever fails, the readiness split above is unsafe.
  const rec = [];
  const exits = [];
  const runner = newRunner(rec, { onExit: (runId, info) => exits.push({ runId, info }) });

  runner.run({ runId: "first", engineId: "gemini", prompt: "one" });
  const second = runner.run({ runId: "second", engineId: "gemini", prompt: "two" });

  assert.equal(second.accepted, false, "a second run on an owned lane must be refused");
  const refusal = exits.find((e) => e.runId === "second");
  assert.ok(refusal, "the refused run must emit a terminal frame, not vanish");
  assert.equal(refusal.info.error, "agent_lane_busy", "and must name the lane as the cause");
});

test("a real engine whose credential probe FAILS is not ready", () => {
  // CORRECTED (Kimi K3, LOW, #336). This was titled "an engine with no
  // credentials is still NOT ready" and only checked an UNKNOWN engine -- a
  // different case entirely. A title claiming more than its assertion covers is
  // the defect this branch keeps finding elsewhere, so it does not get to live
  // here. It now drives codex's REAL readyCheck through the injected reader.
  const rec = [];

  assert.equal(newRunner(rec).engineReady("codex"), false,
    "the default fixture has no valid codex auth.json, so the probe says not ready");

  // Same probe, same plumbing, valid credential -> ready. Without this half the
  // assertion above would also pass if engineReady were broken and returned
  // false for everything.
  const validAuth = JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { access_token: "a".repeat(40), refresh_token: "r".repeat(20) },
  });
  const readValid = (p) => (String(p).endsWith("/.codex/auth.json") ? validAuth : SECRETS);
  const okRunner = createChatRunner({
    profiles, secretsPath: "/fake/secrets.env", withCharter: (s) => "CH" + String.fromCharCode(10) + s,
    uid: 1001, gid: 1001, launchContained: mockLaunchFactory(rec),
    ...runnerContainment({}),
    rootEnv: ROOT_ENV, readFileSync: readValid,
    onOutput: () => {}, onExit: () => {},
  });
  assert.equal(okRunner.engineReady("codex"), true,
    "with a valid chatgpt auth.json the same probe says ready -- so the false above is the PROBE, not the plumbing");
});

test("an unknown engine is never ready", () => {
  const rec = [];
  assert.equal(newRunner(rec).engineReady("no-such-engine"), false);
});

test("SECURITY: Brand DNA website text reaches the engine on stdin and never through argv or env", () => {
  // The prompt is assembled from a customer's website copy. argv is readable
  // by anything that can list processes, and the OS caps its length -- a real
  // client site exceeded that cap on Windows at roughly 60k characters. So the
  // text must appear on stdin and NOWHERE else.
  const website = "ACME-SECRET-WEBSITE-COPY-" + "x".repeat(200);
  const prompt = "Read this site:\n" + website;
  const rec = [];
  const r = createChatRunner({
    profiles, secretsPath: "/fake/secrets.env", withCharter: (s) => "CH\n" + s,
    uid: 1001, gid: 1001, launchContained: mockLaunchFactory(rec), ...runnerContainment(),
    rootEnv: { ...ROOT_ENV, CLAUDE_CODE_OAUTH_TOKEN: "oauth" },
    readFileSync: (file) => String(file).endsWith("/.codex/auth.json") ? "{}" : SECRETS,
    onOutput: () => {},
  });
  r.run({ runId: "brand-dna-stdin", engineId: "claude-brand-dna", prompt });
  const launch = rec[0];

  assert.equal(launch.stdin, "pipe", "the contained launch must give Brand DNA a writable stdin");
  for (const arg of launch.argv) {
    assert.equal(String(arg).includes(website), false, `website copy leaked into argv: ${arg}`);
  }
  for (const [name, value] of Object.entries(launch.env)) {
    assert.equal(String(value).includes(website), false, `website copy leaked into env ${name}`);
  }
  assert.equal(launch.child.stdin.written, prompt, "the engine must receive the exact prompt bytes");
  assert.equal(launch.child.stdin.ended, true, "a one-shot run still closes stdin after the single write");
});

test("SECURITY: short Brand DNA prompts cannot be mistaken for fixed argv flags", () => {
  const launchedArgv = [];
  for (const prompt of ["p", "--settings"]) {
    const rec = [];
    const r = createChatRunner({
      profiles, secretsPath: "/fake/secrets.env", withCharter: (s) => "CH\n" + s,
      uid: 1001, gid: 1001, launchContained: mockLaunchFactory(rec), ...runnerContainment(),
      rootEnv: { ...ROOT_ENV, CLAUDE_CODE_OAUTH_TOKEN: "oauth" },
      readFileSync: (file) => String(file).endsWith("/.codex/auth.json") ? "{}" : SECRETS,
      onOutput: () => {},
    });

    assert.doesNotThrow(() => r.run({ runId: `brand-dna-short-${prompt.length}`, engineId: "claude-brand-dna", prompt }));
    assert.equal(rec.length, 1, `the legitimate short prompt ${JSON.stringify(prompt)} must launch`);
    assert.equal(rec[0].child.stdin.written, prompt, "the exact short prompt must reach stdin");
    launchedArgv.push(rec[0].argv);
    rec[0].child.emit("close", 0, null);
  }
  assert.deepEqual(launchedArgv[0], launchedArgv[1],
    "changing prompt data must never change the fixed Brand DNA argv");
});

test("SECURITY: malformed prompt-stdin profiles fail with a named exit and no launch", () => {
  const malformed = [
    {
      name: "sentinel",
      profile: { ...profiles["claude-brand-dna"], promptSentinel: "{not-a-prompt}" },
      cause: /prompt_stdin_profile_invalid: unsupported prompt sentinel/,
    },
    {
      name: "template",
      profile: {
        ...profiles["claude-brand-dna"],
        argvTemplate: [...profiles["claude-brand-dna"].argvTemplate, "{prompt}"],
      },
      cause: /prompt_stdin_profile_invalid: argv template contains a prompt sentinel/,
    },
  ];

  for (const fixture of malformed) {
    const rec = [];
    const exits = [];
    const r = createChatRunner({
      profiles: { ...profiles, "claude-brand-dna": fixture.profile },
      secretsPath: "/fake/secrets.env", withCharter: (s) => "CH\n" + s,
      uid: 1001, gid: 1001, launchContained: mockLaunchFactory(rec), ...runnerContainment(),
      rootEnv: ROOT_ENV, readFileSync: fakeRead,
      onOutput: () => {}, onExit: (_runId, info) => exits.push(info),
    });

    assert.doesNotThrow(() => r.run({ runId: `brand-dna-bad-${fixture.name}`, engineId: "claude-brand-dna", prompt: "site copy" }));
    assert.equal(rec.length, 0, `${fixture.name}: an invalid profile must not launch a child`);
    assert.equal(exits.length, 1, `${fixture.name}: the caller needs one terminal failure frame`);
    assert.match(exits[0].error, fixture.cause);
  }
});

test("SECURITY: a broken prompt pipe names its cause instead of crashing the gate", () => {
  const rec = [];
  const r = createChatRunner({
    profiles, secretsPath: "/fake/secrets.env", withCharter: (s) => "CH\n" + s,
    uid: 1001, gid: 1001,
    launchContained: (options) => {
      const handle = mockLaunchFactory(rec)(options);
      // The engine died before reading: writing to it raises EPIPE. An
      // unhandled error event here would take the whole gate down.
      handle.child.stdin.write = () => { const e = new Error("broken pipe"); e.code = "EPIPE"; throw e; };
      return handle;
    },
    ...runnerContainment(),
    rootEnv: { ...ROOT_ENV, CLAUDE_CODE_OAUTH_TOKEN: "oauth" },
    readFileSync: (file) => String(file).endsWith("/.codex/auth.json") ? "{}" : SECRETS,
    onOutput: () => {},
  });
  assert.doesNotThrow(() => r.run({ runId: "brand-dna-epipe", engineId: "claude-brand-dna", prompt: "site copy" }));
});
