// Root-brokered engine readiness (Steve, 2026-07-26).
//
// THE PROBLEM: board dispatch gates on codex's saved ChatGPT login. Under
// Foundation B the gate (uid 999) gets EACCES opening agent-owned
// ~/.codex/auth.json (0600 agent:agent), so that check was false on every tick
// and EVERY codex card was silently filtered out of dispatch. Proven on the box:
// the gate's own validator returns false as gate, true as agent — same file,
// same code, only the caller's uid differs.
//
// THE REJECTED FIX: chmod the credential group-readable (agent:boxstate 0640).
// That works, and it hands the NETWORK-FACING process an OAuth token it
// currently cannot reach — the exact invariant the identity split exists to
// create, and the one the product's security claim rests on.
//
// THE FIX HERE: root answers the question. The gate asks "is codex ready?" over
// the chat socket root already owns and gets back a BOOLEAN. Root already reads
// this file to launch codex, so answering yes/no about it grants no new
// authority — the verb is strictly narrower than `run`, which the same socket
// already exposes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createChatRunner } from "../container/maintenance-chat-runner.js";
import { createAgentLaneArbiter } from "../container/maintenance-agent-lane.js";
import { askEngineReady } from "../container/maintenance-chat-client.js";

const AUTH = "/home/agent/.codex/auth.json";
const goodAuth = JSON.stringify({
  auth_mode: "chatgpt",
  tokens: { access_token: "a".repeat(40), refresh_token: "r".repeat(30), account_id: "acct" },
});
// A profile set shaped like the real one: codex carries a readyCheck, claude does not.
function profilesWith(readyCheck) {
  return {
    codex: { engineId: "codex", bin: "codex", argvTemplate: ["exec"], promptSentinel: "{prompt}", readyCheck },
    claude: { engineId: "claude", bin: "claude", argvTemplate: ["-p"], promptSentinel: "{prompt}" },
  };
}
function runnerWith(readyCheck, readFileSync) {
  return createChatRunner({
    profiles: profilesWith(readyCheck),
    secretsPath: "/dev/null",
    withCharter: (p) => p,
    readFileSync: readFileSync || (() => goodAuth),
    agentLaneArbiter: createAgentLaneArbiter(),
  });
}

test("an engine with no readyCheck needs no credential and is ready", () => {
  assert.equal(runnerWith(undefined).engineReady("claude"), true);
});

test("an unknown engine is never ready (fail closed)", () => {
  const r = runnerWith(() => true);
  assert.equal(r.engineReady("nope"), false);
  assert.equal(r.engineReady(""), false);
  assert.equal(r.engineReady(undefined), false);
  assert.equal(r.engineReady("../../bin/sh"), false, "a path-shaped id resolves to no profile");
});

test("a readyCheck that throws fails closed rather than propagating", () => {
  const r = runnerWith(() => { throw new Error("boom"); });
  assert.equal(r.engineReady("codex"), false);
});

test("a readyCheck returning a truthy non-true is NOT ready (strict boolean)", () => {
  assert.equal(runnerWith(() => "yes").engineReady("codex"), false, "only === true counts");
  assert.equal(runnerWith(() => 1).engineReady("codex"), false);
  assert.equal(runnerWith(() => true).engineReady("codex"), true);
});

test("engineReady returns ONLY a boolean — never the credential or a reason", () => {
  const r = runnerWith(({ readFileSync }) => JSON.parse(readFileSync(AUTH, "utf8")).auth_mode === "chatgpt");
  const out = r.engineReady("codex");
  assert.equal(typeof out, "boolean", "the gate can never receive token material through this path");
  assert.equal(out, true);
});

// ---- the real codex probe --------------------------------------------------
// Mirrors gate.js readCodexChatGptAuth so the two cannot disagree about "ready".

import { buildChatProfiles } from "../container/maintenance-chat-profiles.js";
const realProfiles = buildChatProfiles({
  homeDir: "/home/agent", chatCwd: "/home/agent/work", chatBin: "claude",
  charterArgs: [], agentSpawnArgsStatic: (p) => ["-p", p], withCharter: (p) => p,
});
const probe = (raw) => realProfiles.codex.readyCheck({ readFileSync: () => raw });

test("the codex probe accepts a valid ChatGPT login", () => {
  assert.equal(probe(goodAuth), true);
});

test("the codex probe rejects every malformed shape", () => {
  assert.equal(probe(""), false, "empty file");
  assert.equal(probe("not json"), false, "unparseable");
  assert.equal(probe(JSON.stringify({ auth_mode: "apikey", tokens: { access_token: "a".repeat(40), refresh_token: "r" } })), false, "wrong auth_mode");
  assert.equal(probe(JSON.stringify({ auth_mode: "chatgpt" })), false, "no tokens");
  assert.equal(probe(JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "short", refresh_token: "r" } })), false, "access_token too short");
  assert.equal(probe(JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "a".repeat(40) } })), false, "no refresh_token");
});

test("the codex probe rejects a login that carries a raw API key", () => {
  // An OPENAI_API_KEY alongside the OAuth tokens means this is not a pure
  // ChatGPT login; gate.js refuses it and so must the probe.
  const withKey = JSON.stringify({
    auth_mode: "chatgpt", OPENAI_API_KEY: "sk-live-key",
    tokens: { access_token: "a".repeat(40), refresh_token: "r".repeat(30) },
  });
  assert.equal(probe(withKey), false);
});

test("an unreadable credential is not ready (EACCES must not throw)", () => {
  const boom = realProfiles.codex.readyCheck({
    readFileSync: () => { const e = new Error("EACCES: permission denied"); e.code = "EACCES"; throw e; },
  });
  assert.equal(boom, false, "the exact failure the gate hits today — must be a clean false");
});

// ---- the wire ---------------------------------------------------------------

test("the server exposes a `ready` verb that answers with a boolean", async () => {
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../container/maintenance-chat-server.js", import.meta.url), "utf8"));
  assert.match(src, /f\.t === "ready"/, "the server handles the verb");
  assert.match(src, /send\(\{ t: "ready", engineId, ready: ok \}\)/, "and replies with a bare boolean");
  assert.match(src, /runner\.engineReady\(engineId\)/, "delegating to the runner");
});

// These used to read askEngineReady's SOURCE and assert that the strings
// `sock.on("error"` and `setTimeout(... finish(false)` appeared in it. That
// passes whether or not the function works, and it passed throughout the
// 2026-08-11 outage in which every engine on the box was undispatchable for
// hours while the log insisted "probe reported not ready" -- a sentence
// asserting root had been reached and said no, when the code could not tell
// that from a dead socket. Source text is not behaviour; drive the function.
function fakeSocket(script) {
  const sock = new EventEmitter();
  sock.destroyed = false;
  sock.written = [];
  sock.write = (b) => { sock.written.push(b); return true; };
  sock.destroy = () => { sock.destroyed = true; };
  setImmediate(() => script(sock));
  return sock;
}
function readyFrame(engineId, ready) {
  const body = Buffer.from(JSON.stringify({ t: "ready", engineId, ready }));
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  return Buffer.concat([head, body]);
}

test("a ready answer and a not-ready answer both come back attributed to ROOT", async () => {
  const yes = await askEngineReady("codex", {
    connect: () => fakeSocket((s) => { s.emit("connect"); s.emit("data", readyFrame("codex", true)); }),
  });
  assert.equal(yes.ready, true);
  assert.match(yes.why, /root answered/i, "a positive answer names who answered it");

  const no = await askEngineReady("codex", {
    connect: () => fakeSocket((s) => { s.emit("connect"); s.emit("data", readyFrame("codex", false)); }),
  });
  assert.equal(no.ready, false);
  assert.match(no.why, /root answered/i, "and only the branch that HEARD root may claim root said no");
});

test("every transport failure fails closed AND names a cause distinct from root saying no", async () => {
  const cases = {
    "could not open": { connect: () => { throw new Error("ENOENT"); } },
    "socket errored": { connect: () => fakeSocket((s) => s.emit("error", new Error("ECONNREFUSED"))) },
    "closed early": { connect: () => fakeSocket((s) => { s.emit("connect"); s.emit("close"); }) },
    "never replied": { connect: () => fakeSocket(() => {}), timeoutMs: 30 },
    "undecodable": {
      connect: () => fakeSocket((s) => {
        s.emit("connect");
        const head = Buffer.alloc(4);
        head.writeUInt32BE(5);
        s.emit("data", Buffer.concat([head, Buffer.from("{ nope")]));
      }),
    },
  };

  // askEngineReady unrefs its own timer ON PURPOSE -- an asserted property, so
  // the probe can never hold the gate process open. A consequence for THIS test:
  // a fake socket registers no handles, so in the "never replied" case nothing
  // keeps the event loop alive, it drains, and the promise never settles. Node
  // reports that as "Promise resolution is still pending but the event loop has
  // already resolved". It passed locally only because unrelated handles happened
  // to be open, and failed in CI, which is the honest environment. The test must
  // supply its own liveness rather than the production code giving up a property
  // it is right to have.
  const keepAlive = setInterval(() => {}, 5);
  const whys = [];
  for (const [name, opts] of Object.entries(cases)) {
    const r = await askEngineReady("codex", opts);
    assert.equal(r.ready, false, name + " must fail CLOSED");
    assert.ok(r.why && r.why.length > 0, name + " must carry a cause");
    assert.doesNotMatch(
      r.why,
      /root answered/i,
      name + " never reached root, so it must not claim root answered anything -- this exact lie cost hours on 2026-08-11",
    );
    whys.push(r.why);
  }
  clearInterval(keepAlive);

  assert.equal(new Set(whys).size, whys.length,
    "each transport failure must be DISTINGUISHABLE; collapsing them is the defect itself");
});

test("askEngineReady never rejects, so the caller's error branch is not silently dead code", async () => {
  // gate.js has a .catch on this chain. If this function rejected, fine -- but it
  // resolves, and the contract must be explicit either way, because a .catch that
  // can never run reads as handled error paths that do not exist.
  const r = await askEngineReady("codex", { connect: () => { throw new Error("boom"); } });
  assert.deepEqual(Object.keys(r).sort(), ["ready", "why"], "always a tagged result, never a bare boolean");
});

test("the dispatcher serves a cached answer and refreshes in the background", async () => {
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../container/gate.js", import.meta.url), "utf8"));
  const fn = src.slice(src.indexOf("function codexCredentialReady"), src.indexOf("const MAX_REJECT_CYCLES"));
  assert.match(fn, /if \(id !== "codex"\) return true/, "only codex gates on a credential");
  assert.match(fn, /if \(!FOUNDATION_B\) return codexAuthLauncherAvailable/, "flag-off still reads it directly (gate IS agent)");
  assert.match(fn, /return hit \? hit\.ready : false/, "unknown means NOT ready — fail closed");
  assert.match(src, /const ENGINE_READY_TTL_MS/, "the cache expires so a fresh login is picked up");
});
