// E2E for the channel health watcher (container/gate.js channelHealthTick),
// added 2026-07-24 after both Telegram AND Discord were enabled + correctly
// configured yet silently dropped every message (gate.js read a stale config
// FILENAME, so ownerReady/credential were always false). Nothing surfaced that
// failure -- the channel showed "enabled/online", the only trace was per-message
// reject lines in the audit log an operator has no reason to read.
//
// The watcher re-runs the dispatcher's own owner-ready + credential preconditions
// for every ENABLED, openclaw-owned channel and audits (+ push-notifies) on the
// TRANSITION into/out of "enabled but every message would reject". This proves:
//   1. an enabled channel that can't actually be reached is flagged (unreachable),
//   2. it recovers once the real openclaw.json + gateway window are present,
//   3. both alerts fire ONCE per transition, not every tick.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { mintOperatorSession } from "./operator-session-helper.js";

const GATE = path.join(import.meta.dirname, "..", "container", "gate.js");
const KEY = "gate-chhealth-test-key";

// The gateway window, published the way production publishes it.
//
// This test used to start a REAL tmux session and skip itself where tmux was
// absent. That stopped testing anything when tmux-seam landed: under Foundation
// B the gate may not invoke tmux at all, so tmuxWindows() no longer shells out
// -- it reads the agent-published seam file (~/.tmux-seam/windows.state, line 1
// a unix-seconds heartbeat, then one `name|active` per window). A real tmux
// session is therefore invisible to the code under test, `ready` never came up,
// and the recovery half failed on every machine that HAD tmux while silently
// skipping on every machine that did not. Same idiom as
// gate-channel-dispatch.test.js, which was migrated at the time.
function seamPublisher(home, windows) {
  const dir = path.join(home, ".tmux-seam");
  fs.mkdirSync(dir, { recursive: true });
  const publish = () => fs.writeFileSync(
    path.join(dir, "windows.state"),
    `${Math.floor(Date.now() / 1000)}\n${windows.map((w) => `${w}|1`).join("\n")}\n`,
  );
  publish();
  // Re-publish inside SEAM_STALE_MS (30s) so a slow suite cannot age the
  // heartbeat out mid-test and read as "tmux is down".
  return setInterval(publish, 1000);
}

const box = {};

before(async () => {
  const home = fs.mkdtempSync(path.join(import.meta.dirname, ".gatechhealth-"));
  fs.mkdirSync(path.join(home, ".agenthost"), { recursive: true, mode: 0o700 });
  // Enabled telegram, owner openclaw -- but deliberately NO ~/.openclaw/openclaw.json
  // yet, so the first sweep must see it as enabled-but-unreachable.
  fs.mkdirSync(path.join(home, ".openclaw"), { recursive: true });

  // Deliberately NO seam file yet either: the first sweep must see BOTH
  // preconditions missing (no gateway window, no credential), which is the
  // "enabled but every message would reject" state the watcher exists to catch.

  const child = spawn("node", [GATE], {
    env: {
      ...process.env, HOME: home, TTYD_PASSWORD: KEY, AGENT_CHAT_BIN: "/bin/true",
      GATE_PORT: "0", CHANNEL_DISPATCH_PORT: "0", CHANNEL_OWNER_READY_TTL_MS: "0",
      // Drive the watcher in ms, not minutes (test seam only).
      CHANNEL_HEALTH_FIRST_MS: "300", CHANNEL_HEALTH_TICK_MS: "300",
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const main = await new Promise((resolve, reject) => {
    let out = "";
    const to = setTimeout(() => reject(new Error("gate did not report its port; got: " + out)), 5000);
    child.stdout.on("data", (c) => {
      out += c.toString();
      const m = out.match(/listening on (\d+)/);
      if (m) { clearTimeout(to); resolve(Number(m[1])); }
    });
    child.on("exit", () => { clearTimeout(to); reject(new Error("gate exited before listening; got: " + out)); });
  });
  box.home = home;
  box.gate = child;
  box.base = `http://127.0.0.1:${main}`;
  box.auditLog = path.join(home, ".claude", "agenthost", "audit.log");
  box.cookie = (await mintOperatorSession(box.base, KEY)).cookie;
  const set = await fetch(`${box.base}/api/settings`, {
    method: "PUT", headers: { cookie: box.cookie, origin: box.base, "Content-Type": "application/json" },
    body: JSON.stringify({ set: { channels: { telegram: { enabled: true, owner: "openclaw" } } } }),
    redirect: "manual",
  });
  assert.equal(set.status, 200, "test setup: could not enable telegram via /api/settings");
});

after(async () => {
  if (box.gate) {
    const exited = new Promise((resolve) => box.gate.once("exit", resolve));
    box.gate.kill("SIGTERM");
    await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
  }
  if (box.seam) clearInterval(box.seam);
  if (box.home) fs.rmSync(box.home, { recursive: true, force: true });
});

function auditEvents() {
  try {
    return fs.readFileSync(box.auditLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}
async function waitForEvent(event, detailIncludes, timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const hit = auditEvents().filter((e) => e.event === event && (!detailIncludes || String(e.detail || "").includes(detailIncludes)));
    if (hit.length) return hit;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for audit event ${event}${detailIncludes ? " ~ " + detailIncludes : ""}`);
}

test("an enabled channel that cannot actually be reached is flagged unreachable (once, not every tick)", async () => {
  const hits = await waitForEvent("channel_health_unreachable", "telegram");
  assert.ok(hits.length >= 1, "the enabled-but-unreachable telegram channel is flagged");
  // Let several more sweeps pass; the transition-dedup means it must NOT re-fire.
  await new Promise((r) => setTimeout(r, 1200));
  const after = auditEvents().filter((e) => e.event === "channel_health_unreachable" && String(e.detail).includes("telegram"));
  assert.equal(after.length, 1, "a persistently-unhealthy channel alerts exactly ONCE, not every tick");
});

test("the channel recovers once the real openclaw.json + gateway window are present", async () => {
  // Both preconditions arrive together: the gateway window (published through
  // the seam, exactly as the agent publishes it in production) and the REAL
  // config filename openclaw.json -- NOT config.json, which is never read.
  box.seam = seamPublisher(box.home, ["openclaw"]);
  fs.writeFileSync(path.join(box.home, ".openclaw", "openclaw.json"), JSON.stringify({
    channels: { telegram: { botToken: "fake-telegram-bot-token-for-a-test-1234567890" } },
  }));
  const hits = await waitForEvent("channel_health_recovered", "telegram");
  assert.ok(hits.length >= 1, "once reachable, the recovery is announced");
});
