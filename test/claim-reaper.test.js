// Unit + wiring tests for the boot-time claim reaper (claim-store.js
// reapExpiredAtBoot + the gate's construction-time call). Born from the
// launch-morning deadlock of 2026-07-27: four deploy reboots orphaned four
// live claims; the capability-bound recovery path can never recover a
// reboot orphan (its holder died with the machine), so each zombie locked
// its card forever and the dispatcher was denied every 30 seconds for hours.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { ClaimStore } = require("../container/claim-store.js");
const canonicalBoard = require("../container/canonical-board.js");

const T0 = 1_785_000_000_000;
function tempFile() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "claimreap-"));
  return path.join(d, "claims.sqlite");
}

test("an unexpired two-hour in-box claim from before machine boot is reaped and claimable again", () => {
  const file = tempFile();
  const s1 = new ClaimStore(file);
  assert.equal(s1.tryAcquire({ taskId: "t_zombie01", engine: "codex", ttlMs: 2 * 60 * 60_000, nowMs: T0, schedulerGeneration: 1 }).status, "success");
  // Machine reboot: a fresh process constructs a fresh store; the machine boot
  // postdates the claim's acquisition while its two-hour TTL is still live.
  // Pre-reap, fresh claims are denied — the launch-morning deadlock.
  const bootMs = T0 + 30_000;
  const nowMs = T0 + 60_000;
  const s2 = new ClaimStore(file);
  const denied = s2.tryAcquire({ taskId: "t_zombie01", engine: "codex", ttlMs: 60_000, nowMs, schedulerGeneration: 2 });
  assert.notEqual(denied.status, "success", "pre-reap: the zombie denies fresh claims");
  const reaped = s2.reapExpiredAtBoot(nowMs, bootMs);
  assert.equal(reaped.length, 1);
  assert.equal(reaped[0].taskId, "t_zombie01");
  assert.equal(reaped[0].engine, "codex");
  const fresh = s2.tryAcquire({ taskId: "t_zombie01", engine: "codex", ttlMs: 60_000, nowMs, schedulerGeneration: 2 });
  assert.equal(fresh.status, "success", "post-reap: the card is claimable again");
});

test("FOUNDATION-B SAFETY: an expired claim acquired AFTER the machine booted is NEVER reaped (gate-only restart)", () => {
  // Under Foundation B the gate can restart without a machine reboot while a
  // governed worker survives it. The machine-boot cutoff must protect that
  // worker's claim even when its TTL has lapsed — quarantine, exactly as
  // Package 1 always behaved. (Adversarial review finding, 2026-07-27.)
  const file = tempFile();
  const bootMs = T0 - 60 * 60_000; // machine booted an hour BEFORE the claim
  const s1 = new ClaimStore(file);
  assert.equal(s1.tryAcquire({ taskId: "t_survivor1", engine: "codex", ttlMs: 60_000, nowMs: T0, schedulerGeneration: 1 }).status, "success");
  const s2 = new ClaimStore(file); // gate-only restart: same machine boot
  assert.equal(s2.reapExpiredAtBoot(T0 + 3_600_000, bootMs).length, 0,
    "a claim acquired after this machine boot survives the reaper, however expired");
  const denied = s2.tryAcquire({ taskId: "t_survivor1", engine: "claude", ttlMs: 60_000, nowMs: T0 + 3_600_000, schedulerGeneration: 2 });
  assert.notEqual(denied.status, "success", "the possibly-alive worker's card stays protected");
});

test("a live, unexpired claim acquired after machine boot is never reaped", () => {
  const file = tempFile();
  const bootMs = T0 - 60_000;
  const s1 = new ClaimStore(file);
  assert.equal(s1.tryAcquire({ taskId: "t_alive01", engine: "codex", ttlMs: 60 * 60 * 1000, nowMs: T0, schedulerGeneration: 1 }).status, "success");
  const s2 = new ClaimStore(file);
  assert.equal(s2.reapExpiredAtBoot(T0 + 60_000, bootMs).length, 0, "post-boot claims survive the reaper");
  const denied = s2.tryAcquire({ taskId: "t_alive01", engine: "claude", ttlMs: 60_000, nowMs: T0 + 60_000, schedulerGeneration: 2 });
  assert.notEqual(denied.status, "success", "the live claim still protects the card");
});

test("an external desktop claim is NEVER reaped by a box reboot", () => {
  const file = tempFile();
  const first = new ClaimStore(file);
  const acquired = first.tryAcquireExternal({
    taskId: "t_desktop_survivor",
    engine: "codex",
    ttlMs: 60_000,
    nowMs: T0,
    schedulerGeneration: 1,
    supervisorId: "desktop-control-plane",
    supervisorToken: "desktop-survivor-secret-".repeat(3),
    roomId: "room-survivor",
    objectiveDigest: "c".repeat(64),
  });
  assert.equal(acquired.status, "success");
  first.transition(acquired.holder, { from: "active", to: "running", nowMs: T0 + 1 });

  const afterBoxReboot = new ClaimStore(file);
  assert.deepEqual(
    afterBoxReboot.reapExpiredAtBoot(T0 + 3_600_000, T0 + 30 * 60_000),
    [],
    "the desktop worker can outlive the box and must remain quarantined for its supervisor",
  );
  const inspected = afterBoxReboot.inspect("t_desktop_survivor");
  assert.equal(inspected.status, "success");
  assert.equal(inspected.claim.claimType, "external");
  assert.equal(inspected.claim.supervisorId, "desktop-control-plane");
});

test("empty, unavailable, or clockless stores return [] — fail closed to the prior quarantine behavior", () => {
  const s = new ClaimStore(tempFile());
  assert.deepEqual(s.reapExpiredAtBoot(T0, T0 - 1), []);
  const broken = new ClaimStore(path.join(os.tmpdir(), "claimreap-definitely-missing-dir-xyz", "nested", "claims.sqlite"));
  assert.deepEqual(broken.reapExpiredAtBoot(T0, T0 - 1), []);
  assert.deepEqual(s.reapExpiredAtBoot(NaN, T0), [], "an invalid clock reaps nothing");
  assert.deepEqual(s.reapExpiredAtBoot(T0, NaN), [], "an unknown machine boot time reaps nothing");
  assert.deepEqual(s.reapExpiredAtBoot(T0, T0 + 999_999), [], "a boot time in the future reaps nothing");
});

test("gate wires the reaper at store construction and dedupes denial audits per episode", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");
  const reap = src.indexOf("boardClaimStore.reapExpiredAtBoot");
  assert.notEqual(reap, -1, "boot reconciliation remains wired");
  for (const dependency of ["const AUDIT_FILE", "const AUDIT_MAX_BYTES", "const TASK_ID_RE"]) {
    const initialized = src.indexOf(dependency);
    assert.notEqual(initialized, -1, `${dependency} remains defined`);
    assert.ok(initialized < reap, `${dependency} initializes before boot reconciliation can audit`);
  }
  assert.match(src.slice(reap, reap + 900), /audit\("claim_reaped_on_boot"/,
    "the committed reap writes its forensic receipt synchronously");
  assert.ok(/new ClaimStore\(BOARD_CLAIM_FILE\);[\s\S]{0,1200}reapExpiredAtBoot\(Date\.now\(\), machineBootMs\)/.test(src),
    "the reaper runs immediately after construction with the machine-boot cutoff");
  assert.ok(/\/proc\/uptime/.test(src), "the cutoff comes from the machine's real uptime, not the process's");
  assert.ok(/claim_reaped_on_boot/.test(src), "every reap lands in the audit log");
  assert.ok(/deniedClaimAudited\.has\(/.test(src) && /deniedClaimAudited\.delete\(/.test(src),
    "denial audits fire on transition and clear on a successful claim");
});

test("real Linux gate records a boot-reaped claim after audit initialization", {
  skip: process.platform !== "linux",
  timeout: 10_000,
}, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claimreap-gate-"));
  const agenthostDir = path.join(home, ".claude", "agenthost");
  const claimFile = path.join(agenthostDir, "board-claims.sqlite");
  const auditFile = path.join(agenthostDir, "audit.log");
  fs.mkdirSync(agenthostDir, { recursive: true });

  const uptimeSec = parseFloat(fs.readFileSync("/proc/uptime", "utf8").split(" ")[0]);
  const machineBootMs = Date.now() - uptimeSec * 1000;
  const taskId = "t_boot_audit";
  const claims = new ClaimStore(claimFile);
  assert.equal(claims.tryAcquire({
    taskId,
    engine: "codex",
    ttlMs: 60_000,
    nowMs: Math.floor(machineBootMs) - 10_000,
    schedulerGeneration: 1,
  }).status, "success");
  const database = new DatabaseSync(claimFile);
  database.prepare("UPDATE claims SET expires_at = ? WHERE task_id = ?").run("not-a-date", taskId);
  database.close();

  let stdout = "";
  let stderr = "";
  const gate = spawn(process.execPath, [path.join(import.meta.dirname, "..", "container", "gate.js")], {
    cwd: path.join(import.meta.dirname, ".."),
    env: {
      ...process.env,
      HOME: home,
      TTYD_PASSWORD: "claim-reaper-test-only",
      GATE_PORT: "0",
      CHANNEL_DISPATCH_PORT: "0",
      KANBAN_BRIDGE_PORT: "0",
      WAKE_CHECKIN: "off",
      AGENTHOST_CANONICAL_HOST: "app.agenthost.space",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  gate.stdout.on("data", (chunk) => { stdout += chunk; });
  gate.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => gate.once("exit", (code, signal) => resolve({ code, signal })));

  try {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (fs.existsSync(auditFile) && fs.readFileSync(auditFile, "utf8").includes("claim_reaped_on_boot")) break;
      if (gate.exitCode !== null) throw new Error(`gate exited before the audit receipt (stdout=${stdout.slice(-300)} stderr=${stderr.slice(-300)})`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(fs.existsSync(auditFile), "the real gate created the audit log");
    const entries = fs.readFileSync(auditFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(entries.some((entry) => entry.event === "claim_reaped_on_boot" && entry.tid === taskId),
      "the committed reap has a structured forensic receipt");
    assert.ok(entries.some((entry) => entry.event === "claim_reaped_on_boot" && /recorded lease expiry unknown/.test(entry.detail || "")),
      "a corrupt persisted expiry cannot crash the gate or suppress the receipt");
    assert.doesNotMatch(stderr, /\[gate\] audit:/, "boot reconciliation emitted no audit initialization error");
    assert.equal(new ClaimStore(claimFile).inspect(taskId).rootCause, "claim_not_found",
      "the same real boot removed the stale claim");
  } finally {
    if (gate.exitCode === null) gate.kill("SIGTERM");
    let stopTimer;
    const stopped = await Promise.race([
      exited.then(() => true),
      new Promise((resolve) => { stopTimer = setTimeout(() => resolve(false), 2_000); }),
    ]);
    clearTimeout(stopTimer);
    if (!stopped && gate.exitCode === null) {
      gate.kill("SIGKILL");
      await exited;
    }
    fs.rmSync(home, { recursive: true, force: true });
    assert.ok(stopped, "gate subprocess stopped within 2 seconds");
  }
});

test("reboot reconciliation seam sends a running card with a reaped pre-boot claim to quarantine, never relaunch", () => {
  const claimFile = tempFile();
  const taskId = "t_reboot_flow";
  const claims = new ClaimStore(claimFile);
  const acquired = claims.tryAcquire({
    taskId,
    engine: "codex",
    ttlMs: 2 * 60 * 60_000,
    nowMs: T0,
    schedulerGeneration: 1,
  });
  assert.equal(acquired.status, "success");
  assert.equal(claims.transition(acquired.holder, {
    from: "active",
    to: "running",
    nowMs: T0 + 1,
  }).status, "success");

  const nowMs = T0 + 60_000;
  const reaped = claims.reapExpiredAtBoot(nowMs, T0 + 30_000);
  assert.equal(reaped.length, 1);
  assert.equal(claims.inspect(taskId).rootCause, "claim_not_found");

  const runningCard = { id: taskId, title: "Continue the interrupted build", status: "running", assignee: "codex" };
  const protection = canonicalBoard.orphanProtection(
    runningCard,
    new Set(),
    { readable: true, kind: "none", claim: null },
    nowMs,
  );
  assert.equal(protection, "orphan",
    "the real reconciliation classifier routes the now-ownerless running card to quarantine");

  // boardTick and quarantineBoardClaim are intentionally private to gate.js.
  // Pin the wiring from the real classifier outcome through the existing
  // quarantine mutation without adding a production export solely for tests.
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "container", "gate.js"), "utf8");
  const sweep = src.slice(src.indexOf("const tracked = new Set"), src.indexOf("writeChains(s);", src.indexOf("const tracked = new Set")) + "writeChains(s);".length);
  assert.match(sweep, /protection === "durable"[\s\S]*?continue[\s\S]*?noClaimOrphans\.push\(\{ task: t, reason \}\)/,
    "only a real orphan reaches the no-claim quarantine queue");
  assert.match(src, /for \(const orphan of noClaimOrphans\) quarantineBoardClaim\(orphan\.task, orphan\.reason, \{ requireNoClaim: true \}\)/,
    "the orphan queue is handed to the existing no-claim quarantine boundary");

  const quarantine = src.slice(src.indexOf("function quarantineBoardClaim"), src.indexOf("function boardTaskIsTerminal"));
  assert.match(quarantine, /sidecar\.humanReview\[id\][\s\S]*?writeChains\(sidecar\)/,
    "quarantine persists the card into human review");
  assert.match(quarantine, /forceBlock\(id,[\s\S]*?"needs_input"\)/,
    "quarantine blocks the visible card for operator input");
  assert.doesNotMatch(quarantine, /\b(?:tryAcquire|reclaim|startGate|runBoardAgent|spawn)\s*\(/,
    "quarantine has no claim, reclaim, engine, or replacement-launch path");
});
