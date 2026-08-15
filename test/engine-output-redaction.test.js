// THE CREDENTIAL MUST NOT LEAVE ON THE ENGINE'S STDOUT.
//
// The gate cannot open auth.json — that boundary holds, and it is the point of
// the identity split. But a compromised gate does not need to open it. It can
// ask the engine, which runs AS AGENT and must read the file to authenticate, to
// print it; the bytes then return through the ordinary output pipe. No
// permission is broken anywhere in that chain, which is exactly why a
// permission-shaped control cannot catch it.
//
// Root is the only party that can see both the file and the stream, so root is
// where the filter belongs.
//
// MITIGATION, NOT A FIX — asserted here so the limits are recorded rather than
// discovered later:
//   - an arbitrary transformation the model invents (reversed, spelled out,
//     described in prose) is NOT caught;
//   - a value split across two stream chunks is NOT caught, because chunks are
//     filtered independently.
// The real fix is a scoped, short-lived token.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createChatRunner } = require("../container/maintenance-chat-runner.js");

// Deliberately NOT shaped like a real credential. The first version read
// "sk-live-..." and GitGuardian flagged it on every push -- a test fixture that
// trips a secret scanner trains everyone to ignore that scanner, which is worse
// than the fixture being unrealistic. Length is what matters here (the filter
// only takes terms of 20+ chars), not the prefix.
const TOKEN = "EXAMPLE-NOT-A-REAL-TOKEN-0000000000";

function homeWithCredential() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ah-red-"));
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(home, ".codex", "auth.json"),
    JSON.stringify({ tokens: { access_token: TOKEN }, note: "short" }));
  return home;
}

// A child that prints whatever the test asks it to, then exits cleanly.
function childPrinting(text) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    child.stdin = null;
    process.nextTick(() => {
      child.stdout.emit("data", Buffer.from(text, "utf8"));
      child.emit("exit", 0);
    });
    return { child, handle: {} };
  };
}

function captureOutput(home, printed) {
  const seen = [];
  const runner = createChatRunner({
    profiles: { codex: { bin: "/usr/local/bin/codex", argvTemplate: ["exec"], stdin: "ignore" } },
    agentLaneArbiter: { acquire: () => true, release: () => {}, trip: () => {}, isBusy: () => false, isQuarantined: () => false },
    launchContained: childPrinting(printed),
    agentHome: home.split(path.sep).join("/"),
    onOutput: (_id, _stream, text) => seen.push(text),
    onExit: () => {},
  });
  runner.run({ runId: "run_redact", engineId: "codex", prompt: "print it" });
  return seen;
}

test("the credential's literal value never reaches the caller", async () => {
  const home = homeWithCredential();
  const seen = captureOutput(home, "here you go: " + TOKEN + "\n");
  await new Promise((r) => setTimeout(r, 50));

  const all = seen.join("");
  assert.ok(all.length > 0, "the run must actually emit output, or this test proves nothing");
  assert.equal(all.includes(TOKEN), false,
    "the engine's own token must not pass through to a caller that cannot read the file itself");
});

test("a base64 encoding of it is caught too", async () => {
  const home = homeWithCredential();
  const b64 = Buffer.from(TOKEN, "utf8").toString("base64");
  const seen = captureOutput(home, "encoded: " + b64 + "\n");
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(seen.join("").includes(b64), false,
    "redactSecrets covers base64/base64url/hex, so the obvious dodge is closed");
});

test("ordinary output is untouched", async () => {
  const home = homeWithCredential();
  const seen = captureOutput(home, "VERDICT: APPROVE\nnothing secret here\n");
  await new Promise((r) => setTimeout(r, 50));

  const all = seen.join("");
  assert.match(all, /VERDICT: APPROVE/,
    "a filter that eats legitimate output is worse than the leak it prevents");
  assert.match(all, /nothing secret here/);
});

test("a short value in the credential file is NOT used as a filter term", async () => {
  // auth.json above contains note:"short". Redacting on a value that short would
  // corrupt ordinary text everywhere while protecting nothing.
  const home = homeWithCredential();
  const seen = captureOutput(home, "the build is short and clean\n");
  await new Promise((r) => setTimeout(r, 50));

  assert.match(seen.join(""), /short and clean/,
    "only values long enough to be real secrets may become filter terms");
});

test("a missing credential file makes the filter a no-op, never an error", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ah-nored-"));
  const seen = captureOutput(home, "plain output\n");
  await new Promise((r) => setTimeout(r, 50));

  assert.match(seen.join(""), /plain output/,
    "an unreadable credential must not stop a run -- fail open on capability, closed on consequence");
});
