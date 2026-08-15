// Memory capture: agents write what they learn to the team brain.
//
// The finding that forced this feature (2026-08-03): 195 of the brain's 200
// rows were seeded repo documents and ZERO had ever been written by an agent
// about something it learned. Every test here defends a specific way that
// could quietly become true again.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const {
  parseMemoryBlocks,
  captureConfig,
  ENGINE_KEY_VARS,
  MEMORY_SYNTAX_NOTE,
  MEMORY_MAX_CHARS,
} = require("../container/memory-capture.js");

const here = path.dirname(fileURLToPath(import.meta.url));
const gate = fs.readFileSync(path.join(here, "..", "container", "gate.js"), "utf8");
const launcher = fs.readFileSync(path.join(here, "..", "container", "entrypoint-launcher.c"), "utf8");

/* ---------- parsing ---------- */

test("a MEMORY: line is captured", () => {
  const out = parseMemoryBlocks("Work done.\nMEMORY: the deploy script appends to /tmp/ctx.b64 and never truncates it\n");
  assert.equal(out.length, 1);
  assert.equal(out[0].content, "the deploy script appends to /tmp/ctx.b64 and never truncates it");
});

test("one memory per turn -- the flood-control cap is real", () => {
  // The practitioner's first flag: capture's failure mode is a brain full of
  // noise. An engine that emits five lines gets one memory, not five.
  const text = ["MEMORY: one", "MEMORY: two", "MEMORY: three", "MEMORY: four", "MEMORY: five"].join("\n");
  const out = parseMemoryBlocks(text);
  assert.equal(out.length, 1);
  assert.equal(out[0].content, "one");
});

test("no MEMORY: line, no capture -- nothing auto-summarizes", () => {
  assert.deepEqual(parseMemoryBlocks("A long reply about work, with no memory line at all."), []);
  // And the empty-input edges never throw or capture:
  assert.deepEqual(parseMemoryBlocks(""), []);
  assert.deepEqual(parseMemoryBlocks(null), []);
});

test("mid-sentence MEMORY: does not fire -- only a line that starts with it", () => {
  // An engine EXPLAINING the syntax ("you can end with MEMORY: <text>") must
  // not accidentally write that explanation to the brain.
  assert.deepEqual(parseMemoryBlocks("You can end a reply with MEMORY: your lesson here."), []);
  // But leading whitespace is fine -- engines indent.
  assert.equal(parseMemoryBlocks("  MEMORY: indented still counts")[0].content, "indented still counts");
});

test("content is length-capped -- a memory is a lesson, not a transcript", () => {
  const out = parseMemoryBlocks("MEMORY: " + "x".repeat(5000));
  assert.equal(out[0].content.length, MEMORY_MAX_CHARS);
});

test("oversized input returns nothing rather than stalling the event loop", () => {
  // Same ceiling and same reason as parseArtifactBlocks: this runs on EVERY
  // reply, and a 664KB pathological reply once blocked the gate for ~40s.
  assert.deepEqual(parseMemoryBlocks("MEMORY: x\n" + "y".repeat(3 * 1024 * 1024)), []);
});

/* ---------- key mapping ---------- */

test("each engine writes with its OWN key -- attribution comes from the key row", () => {
  const env = { MEMORY_SERVICE_URL: "https://brain.example", MEMORY_KEY_CODEX: "codex-key" };
  const cfg = captureConfig("codex", env);
  assert.equal(cfg.key, "codex-key");
  assert.equal(cfg.url, "https://brain.example");
});

test("an unknown engine is refused BY NAME, never given a borrowed key", () => {
  // A borrowed key stamps the wrong author -- the exact defect the panel
  // recovered from (a lane named "panel"). Refusal with a reason, always.
  const env = { MEMORY_SERVICE_URL: "https://x", MEMORY_KEY_CLAUDE: "k" };
  const cfg = captureConfig("mystery-engine", env);
  assert.ok(cfg.why, "an unknown engine must not silently succeed");
  assert.match(cfg.why, /mystery-engine/);
  assert.equal(cfg.key, undefined);
});

test("a missing key names the missing thing, not 'failed'", () => {
  const cfg = captureConfig("claude", { MEMORY_SERVICE_URL: "https://x" });
  assert.match(cfg.why, /MEMORY_KEY_CLAUDE/);
  const noUrl = captureConfig("claude", { MEMORY_KEY_CLAUDE: "k" });
  assert.match(noUrl.why, /MEMORY_SERVICE_URL/);
});

test("every engine with a key mapping is allowlisted in the launcher", () => {
  // entrypoint-launcher.c filters the gate's env. A key var missing from that
  // allowlist is stripped before the gate boots -- the same trap that made the
  // brain report "not connected" with all three secrets deployed, and then
  // again with MEMORY_KEY_STEVE. This is the guard that stops round three.
  for (const varName of Object.values(ENGINE_KEY_VARS)) {
    assert.ok(
      launcher.includes(`"${varName}"`),
      `${varName} is mapped in memory-capture.js but NOT in entrypoint-launcher.c's allowlist -- ` +
        "the launcher will strip it and every capture for that engine will fail with 'not reaching the gate'",
    );
  }
});

/* ---------- the instruction reaches the engines (Rule 11) ---------- */

test("the charter every engine receives actually teaches the syntax", () => {
  // A parser nobody knows about is an unreachable feature. The note must ride
  // EFFECTIVE_CHARTER (all CLI engines) and Kimi's HTTP system message.
  assert.match(MEMORY_SYNTAX_NOTE, /MEMORY: /);
  assert.ok(
    gate.includes("applyModePack(applyMode(TEAM_CHARTER)) + memCapture.MEMORY_SYNTAX_NOTE"),
    "EFFECTIVE_CHARTER no longer carries the MEMORY syntax note -- engines are never told the syntax exists",
  );
  const kimiSystem = gate.match(/You are Kimi[^\n]*/);
  assert.ok(kimiSystem, "Kimi's system message is gone -- did its HTTP path move?");
  assert.match(
    kimiSystem[0],
    /MEMORY_SYNTAX_NOTE/,
    "Kimi never sees the charter; without the note in its own system message it cannot capture memories",
  );
});

test("the note teaches restraint, not volume", () => {
  // The instruction is half the flood control. If it stops saying "most turns
  // need none", agents will write a memory every turn and bury the brain.
  assert.match(MEMORY_SYNTAX_NOTE, /most turns need none/);
  assert.match(MEMORY_SYNTAX_NOTE, /Never put secrets/);
});

/* ---------- wiring (every reply path captures) ---------- */

test("every reply path that writes artifacts also captures memories", () => {
  // The four finished-turn processing sites, including the shared Team outcome
  // path. A path that writes artifacts but skips capture is an engine whose
  // learning silently vanishes -- the exact 195/200 state this feature exists
  // to end.
  const artifactCalls = (gate.match(/writeArtifacts\(parseArtifactBlocks\(/g) || []).length;
  const captureCalls = (gate.match(/captureMemories\(memCapture\.parseMemoryBlocks\(/g) || []).length;
  assert.ok(artifactCalls >= 4, `expected at least 4 artifact call sites, found ${artifactCalls} -- did the reply paths move?`);
  assert.equal(
    captureCalls,
    artifactCalls,
    `writeArtifacts is called ${artifactCalls} times but captureMemories only ${captureCalls} -- some engine's replies are never scanned for MEMORY: lines`,
  );
});

test("captured memories are shared, or Steve cannot see them", () => {
  // The brain page reads as Steve (shared + HIS private). A private agent
  // memory would be captured and then invisible to the one person the brain
  // page exists for -- Rule 11's unreachable feature, one layer down.
  const call = gate.match(/captureMemories[\s\S]{0,900}?scope:\s*"(\w+)"/);
  assert.ok(call, "cannot find the capture POST body in gate.js");
  assert.equal(call[1], "shared", "captured memories must be scope:shared -- private ones never reach the brain page");
});

test("a capture that cannot happen is audited with its reason (Rule 16)", () => {
  const fn = gate.match(/function captureMemories[\s\S]{0,1400}/);
  assert.ok(fn, "captureMemories is gone from gate.js");
  assert.match(fn[0], /audit\("memory_capture_failed"/, "a failed capture must land in the audit log with its reason");
  assert.match(fn[0], /audit\("memory_captured"/, "a successful capture must be visible in the audit log too");
});
