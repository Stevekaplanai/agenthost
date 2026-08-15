import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import limiterModule from "../container/channel-delivery-limiter.js";

const { createChannelDeliveryLimiter, createChannelReplyRunner } = limiterModule;

test("OpenClaw channel deliveries run one at a time in FIFO order", async () => {
  let active = 0;
  let peak = 0;
  const started = [];
  const finished = [];
  const limiter = createChannelDeliveryLimiter({
    maxPending: 8,
    run(job, done) {
      active++;
      peak = Math.max(peak, active);
      started.push(job.id);
      setTimeout(() => {
        finished.push(job.id);
        active--;
        done(null);
      }, 20);
    },
  });

  const outcomes = await Promise.all(
    ["a", "b", "c", "d", "e"].map((id) =>
      new Promise((resolve) => {
        assert.equal(limiter.enqueue({ id }, (error) => resolve(error)), true);
      })),
  );

  assert.deepEqual(outcomes, [null, null, null, null, null]);
  assert.equal(peak, 1, "heavy OpenClaw CLI processes never overlap");
  assert.deepEqual(started, ["a", "b", "c", "d", "e"]);
  assert.deepEqual(finished, started, "completion preserves enqueue order");
  assert.deepEqual(limiter.stats(), { active: 0, pending: 0, quarantined: false });
});

test("OpenClaw delivery backlog is bounded instead of growing without limit", async () => {
  let release;
  const limiter = createChannelDeliveryLimiter({
    maxPending: 2,
    run(_job, done) {
      release = done;
    },
  });

  const first = new Promise((resolve) => assert.equal(limiter.enqueue({ id: "active" }, resolve), true));
  const second = new Promise((resolve) => assert.equal(limiter.enqueue({ id: "queued-1" }, resolve), true));
  const third = new Promise((resolve) => assert.equal(limiter.enqueue({ id: "queued-2" }, resolve), true));
  let rejected = null;
  let accepted = null;
  assert.doesNotThrow(() => {
    accepted = limiter.enqueue({ id: "overflow" }, (error) => {
      rejected = error;
      throw new Error("caller bug");
    });
  });
  assert.equal(accepted, false);
  assert.match(rejected, /queue is full/i);
  assert.deepEqual(limiter.stats(), { active: 1, pending: 2, quarantined: false });

  release(null);
  await new Promise((resolve) => setImmediate(resolve));
  release(null);
  await new Promise((resolve) => setImmediate(resolve));
  release(null);
  assert.deepEqual(await Promise.all([first, second, third]), [null, null, null]);
});

test("the production gate and image both use the delivery limiter", () => {
  const root = path.join(import.meta.dirname, "..");
  const gate = fs.readFileSync(path.join(root, "container", "gate.js"), "utf8");
  const dockerfile = fs.readFileSync(path.join(root, "container", "Dockerfile"), "utf8");

  assert.match(gate, /createChannelDeliveryLimiter\(\{[\s\S]*?run: runChannelReplyWithinAgentLane/);
  assert.match(gate, /channelDeliveryLimiter\.enqueue\(\{ channel, candidates, text \}, cb\)/);
  assert.match(gate, /maxPending: CHANNEL_INFLIGHT_MAX/,
    "delivery backlog stays aligned with the channel turn admission limit");
  assert.match(gate, /launchCandidate:\s*FOUNDATION_B[\s\S]*?runChannelDeliveryViaChatSocket/,
    "a credentialed Foundation-B gate must broker delivery instead of spawning OpenClaw itself");
  assert.ok(/runChannelDeliveryViaChatSocket\(channel, target, channelReplyText\(text\)\)/.test(gate),
    "brokered delivery must use the same 3800-character normalizer as direct delivery");
  assert.match(dockerfile, /COPY channel-delivery-limiter\.js \/opt\/agenthost\/channel-delivery-limiter\.js/);
});

test("a caller callback cannot crash or stall the delivery queue", async () => {
  const completions = [];
  const limiter = createChannelDeliveryLimiter({
    run(job, done) {
      completions.push({ id: job.id, done });
    },
  });

  limiter.enqueue({ id: "first" }, () => { throw new Error("caller bug"); });
  const second = new Promise((resolve) => limiter.enqueue({ id: "second" }, resolve));

  assert.doesNotThrow(() => completions[0].done(null));
  await new Promise((resolve) => setImmediate(resolve));
  completions[1].done(null);
  assert.equal(await second, null);
});

test("an OpenClaw child with no terminal event quarantines the delivery lane", async () => {
  let killed = 0;
  let spawned = 0;
  let quarantineNotice = null;
  const runner = createChannelReplyRunner({
    timeoutMs: 10,
    killGraceMs: 10,
    argsFor: () => ["message", "send"],
    environment: () => ({}),
    spawn() {
      spawned++;
      const child = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => { killed++; return true; };
      return child;
    },
  });
  const limiter = createChannelDeliveryLimiter({
    run: runner,
    maxPending: 2,
    onQuarantine(reason) { quarantineNotice = reason; },
  });

  const first = new Promise((resolve) =>
    assert.equal(limiter.enqueue({ channel: "telegram", candidates: ["one", "fallback"], text: "first" }, resolve), true));
  const queued = new Promise((resolve) =>
    assert.equal(limiter.enqueue({ channel: "telegram", candidates: ["two"], text: "queued" }, resolve), true));
  const outcomes = await Promise.race([
    Promise.all([first, queued]),
    new Promise((_, reject) => setTimeout(() => reject(new Error("quarantine did not settle callers")), 100)),
  ]);

  assert.equal(spawned, 1);
  assert.equal(killed, 1);
  assert.ok(outcomes.every((result) => /quarantined/i.test(result)),
    "the active and pending callers both learn that delivery stopped safely");
  assert.deepEqual(limiter.stats(), { active: 1, pending: 0, quarantined: true });
  assert.match(quarantineNotice, /terminal process event/i,
    "the shared gate can quarantine every other heavyweight lane");

  let rejected = null;
  assert.equal(limiter.enqueue(
    { channel: "telegram", candidates: ["three"], text: "later" },
    (error) => { rejected = error; },
  ), false);
  assert.match(rejected, /quarantined/i);
  assert.equal(spawned, 1, "no fallback or later OpenClaw process starts without reap proof");
});

test("post-spawn setup failure kills the child and quarantines without a replacement", async () => {
  let spawned = 0;
  const killSignals = [];
  const runner = createChannelReplyRunner({
    timeoutMs: 100,
    killGraceMs: 10,
    argsFor: () => ["message", "send"],
    environment: () => ({}),
    spawn() {
      spawned++;
      const child = new EventEmitter();
      child.pid = 4321;
      child.exitCode = null;
      child.signalCode = null;
      child.stderr = {
        on() { throw new Error("stderr listener setup failed"); },
      };
      child.kill = (signal) => {
        killSignals.push(signal);
        return true;
      };
      return child;
    },
  });
  const limiter = createChannelDeliveryLimiter({ run: runner, maxPending: 2 });

  const active = new Promise((resolve) =>
    assert.equal(limiter.enqueue(
      { channel: "telegram", candidates: ["one", "fallback"], text: "first" },
      resolve,
    ), true));
  const queued = new Promise((resolve) =>
    assert.equal(limiter.enqueue(
      { channel: "telegram", candidates: ["two"], text: "queued" },
      resolve,
    ), true));
  const outcomes = await Promise.race([
    Promise.all([active, queued]),
    new Promise((_, reject) => setTimeout(() => reject(new Error("setup failure did not settle callers")), 100)),
  ]);

  assert.equal(spawned, 1, "neither fallback nor queued delivery starts over the unproven child");
  assert.deepEqual(killSignals, ["SIGKILL"]);
  assert.ok(outcomes.every((result) => /quarantined/i.test(result)));
  assert.deepEqual(limiter.stats(), { active: 1, pending: 0, quarantined: true });
});

test("an unproven broker socket loss quarantines without trying a fallback recipient", async () => {
  const attempts = [];
  let child;
  const runner = createChannelReplyRunner({
    timeoutMs: 100,
    killGraceMs: 10,
    launchCandidate(channel, target, text) {
      attempts.push({ channel, target, text });
      child = new EventEmitter();
      child.pid = null;
      child.exitCode = null;
      child.signalCode = null;
      child.terminationProven = false;
      child.stderr = new EventEmitter();
      child.kill = () => true;
      return child;
    },
  });

  const outcome = new Promise((resolve) => runner({
    channel: "discord",
    candidates: ["channel:123", "user:456"],
    text: "hello",
  }, (error, options) => resolve({ error, options })));
  child.emit("exit", null, null);
  child.emit("close", null, null);
  const result = await outcome;

  assert.equal(attempts.length, 1, "uncertain termination must never start the fallback delivery");
  assert.deepEqual(attempts[0], { channel: "discord", target: "channel:123", text: "hello" });
  assert.equal(result.options && result.options.quarantine, true);
  assert.match(result.error, /termination|broker|delivery/i);
});

test("a pre-spawn failure still tries the next delivery candidate", async () => {
  const attempts = [];
  const runner = createChannelReplyRunner({
    timeoutMs: 100,
    argsFor: (_channel, candidate) => ["message", "send", candidate],
    environment: () => ({}),
    spawn(_command, args) {
      attempts.push(args.at(-1));
      if (attempts.length === 1) throw new Error("openclaw was not started");
      const child = new EventEmitter();
      child.pid = 4322;
      child.exitCode = null;
      child.signalCode = null;
      child.stderr = new EventEmitter();
      child.kill = () => true;
      queueMicrotask(() => child.emit("close", 0));
      return child;
    },
  });
  const limiter = createChannelDeliveryLimiter({ run: runner });

  const outcome = await new Promise((resolve) =>
    assert.equal(limiter.enqueue(
      { channel: "telegram", candidates: ["first", "fallback"], text: "hello" },
      resolve,
    ), true));

  assert.equal(outcome, null);
  assert.deepEqual(attempts, ["first", "fallback"]);
  assert.deepEqual(limiter.stats(), { active: 0, pending: 0, quarantined: false });
});

test("an external shared-lane quarantine closes idle OpenClaw delivery too", async () => {
  let spawned = 0;
  const limiter = createChannelDeliveryLimiter({
    run(_job, done) { spawned++; done(null); },
  });

  assert.equal(limiter.quarantine("shared agent lane stopped"), true);
  let result = null;
  assert.equal(limiter.enqueue({ id: "blocked" }, (error) => { result = error; }), false);
  assert.match(result, /quarantined/i);
  assert.equal(spawned, 0);
  assert.deepEqual(limiter.stats(), { active: 0, pending: 0, quarantined: true });
});
