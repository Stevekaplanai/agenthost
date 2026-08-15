import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const gate = fs.readFileSync(
  path.join(import.meta.dirname, "..", "container", "gate.js"),
  "utf8",
);

test("unreaped agent timeouts quarantine the shared lane instead of launching replacements", () => {
  assert.match(gate, /tripRootAgentLaneQuarantine/,
    "the gate reports an unproven termination to the boot-scoped root latch");
  assert.match(gate, /AGENTHOST_AGENT_LANE_QUARANTINED === "1"/,
    "a replacement gate starts locally quarantined when root retained the latch");
  assert.match(gate, /function quarantineAgentLane\(token, reason\)/,
    "the shared process lane has one explicit fail-safe");
  assert.match(gate, /if \(agentLaneQuarantined\) return;/,
    "the dispatcher cannot launch queued work after quarantine");
  assert.match(gate, /if \(agentLaneQuarantined\)[\s\S]{0,300}controlled box restart/,
    "new human messages fail clearly instead of waiting forever");

  const globalWatchdog = gate.match(
    /const AGENT_HARD_MAX_MS[\s\S]*?\}, 30 \* 1000\)\.unref\(\);/,
  )?.[0] || "";
  assert.match(globalWatchdog, /quarantineAgentLane\(/);
  assert.doesNotMatch(globalWatchdog, /agentRunToken\+\+|agentBusy = false|dispatchAgentSlot/,
    "the last-resort watchdog never force-opens an unproven lane");

  const team = gate.match(/function runTeamSequential[\s\S]*?\r?\n}\r?\n\/\/ One engine's segment/)?.[0] || "";
  assert.match(team, /quarantineAgentLane\(/,
    "a Team segment with no terminal child event quarantines");
  assert.doesNotMatch(team, /setTimeout\(\(\) => advance\(""/,
    "a Team timeout cannot advance to the next heavyweight process");

  const wake = gate.match(/function runWakeRound[\s\S]*?\r?\n}\r?\n\r?\nif \(!WAKE_CHECKIN_OFF/)?.[0] || "";
  assert.match(wake, /quarantineAgentLane\(/,
    "an unattended wake segment with no terminal child event quarantines");
  assert.doesNotMatch(wake, /setTimeout\(\(\) => advance\(""/,
    "wake cannot advance to another engine without reap proof");

  const chat = gate.match(/function runChat[\s\S]*?\r?\n}\r?\n\r?\n\/\/ ---- brain search/)?.[0] || "";
  assert.match(chat, /child\.terminationProven === false[\s\S]*?quarantineAttempt\(/,
    "a lost Foundation-B broker cannot impersonate a reaped 1:1 child");
  assert.match(chat, /quarantineAttempt = \(reason\) =>[\s\S]*?quarantineAgentLane\(token, reason\)/,
    "the chat-path quarantine wrapper delegates to the shared fail-safe");

  const cron = gate.match(/function startCronRun[\s\S]*?\r?\n}\r?\n\r?\nfunction drainCronQueue/)?.[0] || "";
  assert.match(cron, /child\.terminationProven === false[\s\S]*?quarantine/,
    "a scheduled run cannot release after an unproven broker close");
  assert.match(cron, /child\.pid && child\.exitCode === null && child\.signalCode === null/,
    "a post-spawn cron error cannot release the lane");

  const autonomy = gate.match(/function runAutonomousTask[\s\S]*?\r?\n}\r?\n\r?\n\/\/ The autonomous prompt/)?.[0] || "";
  assert.match(autonomy, /if \(!agentLeaseIsLive\(agentToken\)\) return new Promise/,
    "autonomous work cannot launch or resolve after its shared lease is lost");
  assert.match(autonomy, /if \(!autonomousProfileIsJailed\(eng\)\)[\s\S]*?AUTONOMOUS_PROFILE_UNSAFE/,
    "an unattended model cannot launch without locked arguments, a scrubbed environment, and a private jail");
  assert.match(autonomy, /child\.on\("error"[\s\S]*?if \(!child\.pid \|\| child\.exitCode !== null \|\| child\.signalCode !== null\)[\s\S]*?finish\(null\)/,
    "only a pid-less or already-terminal autonomous error may finish");
  assert.match(autonomy, /child\.on\("close"[\s\S]*?child\.terminationProven === false[\s\S]*?quarantineRun\(/,
    "autonomous work releases only from a proven close");

  const channel = gate.match(/function runChannelEngineTurn[\s\S]*?\r?\n}\r?\n\r?\n\/\/ Pure argv builder/)?.[0] || "";
  assert.match(channel, /agentLaneQuarantined[\s\S]*?done\(/,
    "new channel turns fail immediately after quarantine");
  assert.match(channel, /fail\(error\)[\s\S]*?done\(/,
    "already-queued channel turns are drained with a terminal result");

  const delivery = gate.match(/function runChannelReplyWithinAgentLane[\s\S]*?\r?\n}\r?\n\r?\n\/\/ One OpenClaw CLI/)?.[0] || "";
  assert.match(delivery, /acquireAgent\("delivery"\)/,
    "OpenClaw delivery uses the same box-wide admission token as engines");
  assert.match(delivery, /releaseAgent\(token\)[\s\S]*?finish\(error, options\)/,
    "a delivery releases the shared lane only from its terminal callback");
  assert.match(gate, /run:\s*runChannelReplyWithinAgentLane/,
    "the delivery limiter cannot bypass shared scheduler admission");

  assert.equal((gate.match(/if \(!armLedgerAgentRun\(/g) || []).length, 5,
    "every board/review runner checks durable quarantine-handler registration before spawn");
});
