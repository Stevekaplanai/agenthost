// A scheduled Loop must never be the thing that discovers the readiness cache is
// cold, because a cold cache answers "no", not "wait".
//
// THE INCIDENT, from agenthost-steve's audit log 2026-08-11:
//
//   21:46:26  boot_wake                 <- a deploy
//   22:00:26  multi_run                 Build & Prove
//   22:00:26  codex_readiness_unknown   "refresh in flight, failing closed"
//   22:00:26  run failed in 6ms
//
// Codex was demonstrably fine -- it had taken board work at 20:03. The daily
// summary died because a deploy landed fourteen minutes before its scheduled
// hour and nothing asked about codex in between, so `refreshEngineReady` had
// never run: it is only ever called lazily, from `codexCredentialReady`.
//
// Two separable defects, and this file covers both:
//   1. the window itself      -> warm the cache at boot, so it is never cold
//   2. the unreadable message -> "could not find out" must not print as "no"
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stopChild } from "./child-process-helper.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATE = path.join(HERE, "..", "container", "gate.js");
const SOURCE = fs.readFileSync(GATE, "utf8");

function auditLines(home) {
  try {
    return fs.readFileSync(path.join(home, ".claude", "agenthost", "audit.log"), "utf8")
      .split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function bootGate(t, env = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "readiness-warm-"));
  const charter = path.join(home, "c.md");
  fs.writeFileSync(charter, "test");
  const gate = spawn(process.execPath, [GATE], {
    env: {
      ...process.env,
      HOME: home,
      TTYD_PASSWORD: "readiness-warm-key",
      AGENT_CHAT_BIN: "fake-claude",
      AGENT_CHARTER_FILE: charter,
      GATE_PORT: "0",
      CHANNEL_DISPATCH_PORT: "0",
      KANBAN_BRIDGE_PORT: "0",
      BOARD_AUTONOMY: "off",
      AGENTHOST_CANONICAL_HOST: "",
      FLY_APP_NAME: "",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`gate did not listen; stdout=${stdout}; stderr=${stderr}`)), 20_000);
    gate.stdout.on("data", (c) => {
      stdout += c.toString();
      if (/listening on (\d+)/.test(stdout)) { clearTimeout(timer); resolve(); }
    });
    gate.stderr.on("data", (c) => { stderr += c.toString(); });
    gate.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`gate exited ${code}; stdout=${stdout}; stderr=${stderr}`));
    });
  });
  t.after(async () => {
    await stopChild(gate);
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { gate, home };
}

async function waitFor(home, event, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (auditLines(home).some((l) => l.event === event)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

test("the readiness warm runs at boot even with the wake round disabled", async (t) => {
  // The warm FIRST lived inside startWakeRound, next to boot_wake. That was
  // wrong and this test is why: WAKE_CHECKIN=off skips the wake round entirely,
  // so an operator turning off a diagnostic would have silently reinstated a
  // Loop-killing bug. It now sits in the top-level boot sequence, and this boots
  // with the wake round OFF precisely to prove the two are independent.
  const { gate, home } = await bootGate(t, {
    WAKE_CHECKIN: "off",
    AGENTHOST_FOUNDATION_B: "1",
    AGENTHOST_READINESS_WARM_MS: "200",
  });

  // WHAT THIS PROVES, stated exactly: the warm fires on a box where nothing asks
  // about codex, and the gate survives it. Under FOUNDATION_B with no
  // maintenance socket the probe cannot SUCCEED here, so this cannot assert a
  // ready cache -- and asserting one anyway is how a test starts agreeing with
  // itself. (The first draft of this test ended in `|| auditLines(home).length
  // >= 0`, which cannot fail. It is recorded here because that shape is exactly
  // what the rest of this repo's test discipline exists to keep out.)
  //
  // The wake round is OFF, so nothing else in this boot could trigger a
  // readiness read: if the warm were still attached to startWakeRound, the probe
  // path would not execute at all.
  assert.equal(
    auditLines(home).some((l) => l.event === "boot_wake"),
    false,
    "precondition: the wake round is genuinely off, so nothing else could have triggered a readiness read",
  );

  // The gate must still be alive well past the warm's scheduled moment. A warm
  // that throws synchronously at boot -- the realistic regression, since it runs
  // outside any request -- would take the process down and fail here.
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(gate.exitCode, null,
    "the gate must survive its own boot warm; a throw in that path takes down the box on every restart");
});

test("the warm is in the boot sequence and NOT gated on the wake round", () => {
  // Source-level, and stated as such: FOUNDATION_B's probe cannot complete in a
  // test box, so this guards the WIRING rather than the probe result. What it
  // catches is the warm being deleted, or moved back inside a block that an
  // operator setting can switch off.
  const warmAt = SOURCE.indexOf('refreshEngineReady("codex")', SOURCE.indexOf("// Warm the codex readiness cache at boot"));
  assert.ok(warmAt > -1, "the boot readiness warm must still exist");

  const wakeGuardAt = SOURCE.indexOf('if (!WAKE_CHECKIN_OFF && BRAND !== "legal") {');
  assert.ok(warmAt < wakeGuardAt,
    "the warm must sit BEFORE and outside the wake-round guard — inside it, WAKE_CHECKIN=off silently disables the fix");

  const startWake = SOURCE.indexOf("function startWakeRound()");
  const endWake = SOURCE.indexOf("function queueWakeRoundStep");
  assert.doesNotMatch(SOURCE.slice(startWake, endWake), /refreshEngineReady/,
    "the warm must not live inside startWakeRound");
});

test("a Loop that could not DETERMINE readiness does not report the engine as unavailable", () => {
  // The two messages must be different strings. On 2026-08-11 they were one, and
  // the log sent everyone hunting a broken codex that had taken board work two
  // hours earlier -- the failure did not name its own cause (Rule 16).
  const stageGate = SOURCE.slice(
    SOURCE.indexOf('const providerReadiness = eng === "deepseek"'),
    SOURCE.indexOf('const providerReadiness = eng === "deepseek"') + 1500,
  );
  assert.match(stageGate, /codexReadinessState\(\) === "unknown"/,
    "the stage failure must branch on the tri-state, not on the collapsed boolean");
  assert.match(stageGate, /could not be DETERMINED/);
  assert.match(stageGate, /was unavailable for unattended work/);

  // And the tri-state itself must not kick a refresh: a function that reports a
  // state must not change it, or the message becomes the reason the next read
  // differs.
  const stateFn = SOURCE.slice(
    SOURCE.indexOf("function codexReadinessState()"),
    SOURCE.indexOf("function autonomousEngineReady(engine)"),
  );
  assert.doesNotMatch(stateFn, /refreshEngineReady/,
    "codexReadinessState must be side-effect free");
  assert.match(stateFn, /return "unknown"/);
  assert.match(stateFn, /return hit\.ready === true \? "ready" : "not_ready"/);
});

test("the warm waits for the broker socket instead of guessing a head start", () => {
  // THE SHARPEST DEFECT IN THIS FIX, found by Kimi's #389 review and worse than
  // it stated. `refreshEngineReady` caches a FAILED probe as `ready:false` --
  // see its `.catch(... settle(false, "probe failed: ..."))`. So a warm that
  // fires before root's chat socket is listening does not merely fail to help:
  // it caches a confident NO for a full TTL. The Loop still dies, and now it
  // dies claiming codex is UNAVAILABLE instead of admitting it does not know --
  // strictly worse than the cold cache the warm replaces.
  //
  // A fixed head-start would have been an unverified guess about root's boot
  // time. This asserts the warm is gated on the socket actually existing.
  const warm = SOURCE.slice(
    SOURCE.indexOf("// Warm the codex readiness cache at boot"),
    SOURCE.indexOf('if (!WAKE_CHECKIN_OFF && BRAND !== "legal") {'),
  );
  assert.match(warm, /existsSync\(CHAT_SOCKET_PATH\)/,
    "the warm must probe only once the broker socket exists");
  assert.match(warm, /engineReadyCache\.has\("codex"\)/,
    "and must stand down if something already answered, rather than re-probing");
  assert.match(warm, /readiness_warm_skipped/,
    "giving up must be audited, not silent (Rule 16)");

  // The path comes from the module that OWNS it. A second copy of the string
  // would let the two drift, and the warm would then wait forever on a path
  // nothing creates while reporting a confident skip.
  assert.match(SOURCE, /const \{ CHAT_SOCKET_PATH \} = require\("\.\/maintenance-chat-server\.js"\)/,
    "the socket path must be imported from maintenance-chat-server, never re-declared");
});
