// Phase C slice 2: the desktop room as a mesh peer, OUTBOUND.
// Every case runs the real signing path from container/mesh-contract.js against
// a fake box, and the signatures are verified with the box's own verify() --
// so a contract change on the box side fails here rather than in production.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const mesh = require("../desktop/room/room-mesh.js");
const meshContract = require("../container/mesh-contract.js");

const SECRET = "shared-secret-for-tests";
const CFG = { origin: "https://box.example.fly.dev", selfId: "desktop-1", boxId: "box-1", secret: SECRET };
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);

function cfgDir({ origin = "https://box.example.fly.dev", selfId = "desktop-1", boxId = "box-1", secret = SECRET, bom = false, partial = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "room-mesh-"));
  fs.mkdirSync(path.join(base, "AgentHost"), { recursive: true });
  const body = partial ? { origin } : { origin, selfId, boxId, secret };
  fs.writeFileSync(path.join(base, "AgentHost", "mesh.json"), (bom ? "﻿" : "") + JSON.stringify(body));
  return base;
}

function fakeBox({ status = 200, receipt, throws = false } = {}) {
  const seen = [];
  const fetchImpl = async (url, opts) => {
    if (throws) throw new TypeError("fetch failed");
    const envelope = JSON.parse(opts.body);
    seen.push({ url, opts, envelope });
    const body = typeof receipt === "function"
      ? receipt(envelope)
      : (receipt === undefined ? { status: "delivered", hash: meshContract.causalHash(envelope) } : receipt);
    return { ok: status === 200, status, json: async () => body };
  };
  return { fetchImpl, seen };
}

const entry = (over = {}) => ({ at: 1785550000000, who: "claude", text: "the desktop said this", id: "run-1-r-claude", ...over });

test("config: reads the paired file, tolerates a PowerShell BOM, refuses partial or http", () => {
  assert.deepEqual(mesh.readMeshConfig(cfgDir()), CFG);
  assert.deepEqual(mesh.readMeshConfig(cfgDir({ bom: true })), CFG, "a BOM must not make the file unreadable");
  assert.equal(mesh.readMeshConfig(cfgDir({ partial: true })), null, "half a config is not a pairing");
  assert.equal(mesh.readMeshConfig(cfgDir({ origin: "http://plain.example" })), null);
  assert.equal(mesh.readMeshConfig(path.join(os.tmpdir(), "no-such-dir-" + Date.now())), null,
    "unpaired is the normal state, not an error");
});

test("the envelope the box receives is valid and correctly signed", async () => {
  const box = fakeBox();
  const out = await mesh.mirrorToBox(box.fetchImpl, CFG, entry());
  assert.equal(out.sent, true);
  const { url, envelope } = box.seen[0];
  assert.equal(url, "https://box.example.fly.dev/mesh/message");
  assert.equal(box.seen[0].opts.redirect, "error", "POST must refuse cross-origin redirects");
  assert.equal(envelope.schema, "agenthost.message.v1");
  assert.equal(envelope.kind, "chat");
  assert.deepEqual(envelope.policy, { capability: "chat.post" });
  assert.equal(envelope.sender_box, "desktop-1");
  assert.equal(envelope.receiver_box, "box-1");

  // Verified with the BOX's own verifier, against the box's own peer map.
  const verified = meshContract.verify(envelope, { "desktop-1": SECRET });
  assert.ok(verified === true || (verified && verified.ok !== false),
    "the box must accept this signature: " + JSON.stringify(verified));

  // And the box's policy must actually permit it.
  const decision = meshContract.policyDecide(envelope);
  assert.equal(decision.allowed, true);
  assert.equal(decision.action, "chat_post");
});

test("the message says who on the desktop said it", async () => {
  const box = fakeBox();
  await mesh.mirrorToBox(box.fetchImpl, CFG, entry({ who: "codex", text: "hello from codex" }));
  assert.equal(box.seen[0].envelope.body.text, "desktop:codex: hello from codex");
});

test("a retry of the same entry reuses the message id, so the box dedups it", async () => {
  const box = fakeBox();
  const e = entry();
  const a = await mesh.mirrorToBox(box.fetchImpl, CFG, e);
  const b = await mesh.mirrorToBox(box.fetchImpl, CFG, e);
  assert.equal(a.messageId, b.messageId,
    "at-least-once delivery is certain; a stable id is what makes it safe");
});

test("nothing loops back, and local bookkeeping stays local", () => {
  assert.equal(mesh.shouldMirror(entry()), true);
  assert.equal(mesh.shouldMirror(entry({ who: "box:box-1" })), false,
    "a message that came FROM the box must never be sent back to it");
  assert.equal(mesh.shouldMirror(entry({ text: "(no reply — timed out after 300s)" })), false,
    "the room's own markers are local UI truth, not box thread content");
  assert.equal(mesh.shouldMirror(entry({ text: "(sent to the box board: \"Launch\" — task 42)" })), false,
    "a local board confirmation must not be echoed into the box conversation");
});

test("an unpaired desktop mirrors nothing and does not complain", async () => {
  const box = fakeBox();
  const out = await mesh.mirrorToBox(box.fetchImpl, null, entry());
  assert.equal(out.sent, false);
  assert.equal(out.reason, "not paired");
  assert.equal(box.seen.length, 0);
});

test("an unreachable box is ordinary, not an error that reaches the room", async () => {
  const box = fakeBox({ throws: true });
  const out = await mesh.mirrorToBox(box.fetchImpl, CFG, entry());
  assert.equal(out.sent, false);
  assert.match(out.reason, /unreachable/);
});

test("a rejected receipt reports the box's own reason", async () => {
  const box = fakeBox({ receipt: { status: "rejected", reason: "unknown_peer" } });
  const out = await mesh.mirrorToBox(box.fetchImpl, CFG, entry());
  assert.equal(out.sent, false);
  assert.equal(out.reason, "unknown_peer");
});

test("outbound ids are contract-safe hashes and do not collide on a shared long prefix", () => {
  const prefix = "same-prefix/with spaces/" + "x".repeat(80);
  const first = mesh.envelopeFor(CFG, entry({ id: prefix + "A" }));
  const second = mesh.envelopeFor(CFG, entry({ id: prefix + "B" }));
  assert.match(first.message_id, /^desktop-[0-9a-f]{64}$/);
  assert.match(second.message_id, /^desktop-[0-9a-f]{64}$/);
  assert.notEqual(first.message_id, second.message_id,
    "ids that differ after the old truncation boundary must remain distinct");
});

test("a duplicate receipt for a previously rejected id is not reported as sent", async () => {
  const box = fakeBox({ receipt: (envelope) => ({
    status: "duplicate",
    receipt: { message_id: envelope.message_id, outcome: "rejected", reason: "causal_parent_unknown", hash: null },
  }) });
  const out = await mesh.mirrorToBox(box.fetchImpl, CFG, entry());
  assert.equal(out.sent, false);
  assert.equal(out.reason, "causal_parent_unknown");
  assert.equal(out.burned, true, "a rejected id must be replaced before retrying");
});

test("the durable mirror outbox survives restart and gives a burned retry a fresh id", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "room-mesh-outbox-"));
  const file = path.join(dir, "mesh-outbox.jsonl");
  const first = mesh.createMirrorOutbox(file);
  const queued = first.add(entry(), CFG);
  const originalId = mesh.outboxMessageId(queued);

  const restarted = mesh.createMirrorOutbox(file);
  assert.equal(restarted.list().length, 1, "an unsent turn remains queued after restart");
  assert.equal(restarted.list()[0].ready, true);
  assert.deepEqual(restarted.list()[0].target, {
    origin: CFG.origin, selfId: CFG.selfId, boxId: CFG.boxId,
  });
  assert.equal(fs.readFileSync(file, "utf8").includes(SECRET), false,
    "the outbox identifies the pairing without persisting its shared secret");
  restarted.bumpAttempt(queued.key, "stale-chain-head");
  const retry = mesh.createMirrorOutbox(file).list()[0];
  assert.equal(retry.attempt, 1);
  assert.equal(retry.blockedParent, "stale-chain-head");
  assert.notEqual(mesh.outboxMessageId(retry), originalId,
    "the box permanently remembers a rejection, so the healed retry needs a new id");
  restarted.ack(queued.key);
  assert.equal(mesh.createMirrorOutbox(file).list().length, 0);
  assert.equal(fs.readFileSync(file, "utf8").includes(entry().text), false,
    "ack compaction must remove delivered plaintext from disk");
});

test("outbox prepare/ready reconciliation closes both transcript crash gaps", () => {
  const orphanDir = fs.mkdtempSync(path.join(os.tmpdir(), "room-mesh-prepare-orphan-"));
  const orphanFile = path.join(orphanDir, "mesh-outbox.jsonl");
  mesh.createMirrorOutbox(orphanFile).prepare(entry({ id: "orphan" }), CFG);
  const orphanRestart = mesh.createMirrorOutbox(orphanFile);
  assert.equal(orphanRestart.list()[0].ready, false);
  orphanRestart.reconcile([]);
  assert.equal(mesh.createMirrorOutbox(orphanFile).list().length, 0,
    "a prepare that crashed before the transcript write is discarded");

  const durableDir = fs.mkdtempSync(path.join(os.tmpdir(), "room-mesh-prepare-durable-"));
  const durableFile = path.join(durableDir, "mesh-outbox.jsonl");
  const durableEntry = entry({ id: "durable-before-ready" });
  mesh.createMirrorOutbox(durableFile).prepare(durableEntry, CFG);
  const durableRestart = mesh.createMirrorOutbox(durableFile);
  durableRestart.reconcile([durableEntry]);
  assert.equal(mesh.createMirrorOutbox(durableFile).list()[0].ready, true,
    "a transcript-fsynced turn is made sendable after a crash before ready");
});

test("a later post cannot erase an older transcript-fsynced outbox turn", () => {
  const { createRoomServer } = require("../desktop/room/room.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "room-mesh-ready-recovery-"));
  const outboxFile = path.join(dir, "mesh-outbox.jsonl");
  let failOutboxWrites = false;
  const realOpenSync = fs.openSync;
  const transcript = {
    file: path.join(dir, "transcript.jsonl"),
    entries: [],
    seq() { return this.entries.length; },
    append(who, text, opts) {
      const entry = { at: 100 + this.entries.length, who, text, id: opts.id, to: opts.to };
      opts.beforeWrite(entry);
      if (this.entries.length === 0) failOutboxWrites = true;
      opts.afterWrite(entry);
      this.entries.push(entry);
      return entry;
    },
  };
  fs.openSync = function patchedOpenSync(file, flags, ...rest) {
    if (failOutboxWrites && path.resolve(String(file)) === path.resolve(outboxFile) && flags === "a") {
      throw new Error("simulated outbox ready write failure");
    }
    return realOpenSync.call(fs, file, flags, ...rest);
  };
  try {
    const room = createRoomServer({
      transcript,
      engines: { availability: () => ({ ok: true }), async run() { return { text: "unused", usage: null }; } },
      sessionsFile: path.join(dir, "engine-sessions.json"), roster: [],
      meshConfig: CFG, fetchImpl: async () => { throw new TypeError("offline"); },
      meshOutboxFile: outboxFile, meshChainFile: path.join(dir, "mesh-chain.json"),
    });
    room.dispatch("older durable turn", "everyone", "older-turn");
    failOutboxWrites = false;
    room.dispatch("newer durable turn", "everyone", "newer-turn");

    const pending = mesh.createMirrorOutbox(outboxFile).list();
    assert.deepEqual(pending.map((item) => item.entry.id), ["older-turn", "newer-turn"],
      "reconciling the newer post must recover, not acknowledge, the older durable turn");
    assert.ok(pending.every((item) => item.ready), "both durable transcript turns become sendable");
  } finally {
    fs.openSync = realOpenSync;
  }
});

test("pending outbox work is scoped to the exact pairing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "room-mesh-pairing-"));
  const file = path.join(dir, "mesh-outbox.jsonl");
  const item = mesh.createMirrorOutbox(file).add(entry({ id: "pair-a-only" }), CFG);
  assert.equal(mesh.outboxTargetMatches(item, CFG), true);
  assert.equal(mesh.outboxTargetMatches(item, { ...CFG, boxId: "box-2" }), false);
  assert.equal(mesh.outboxTargetMatches(item, { ...CFG, selfId: "desktop-2" }), false);
  assert.equal(mesh.outboxTargetMatches(item, { ...CFG, origin: "https://other.example" }), false);
});

test("a pending turn from an old pairing is never sent to a new box", async () => {
  const { createRoomServer } = require("../desktop/room/room.js");
  const { createTranscript } = require("../desktop/room/transcript.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "room-mesh-repair-"));
  const outboxFile = path.join(dir, "mesh-outbox.jsonl");
  mesh.createMirrorOutbox(outboxFile).add(entry({ id: "old-pair-turn" }), CFG);
  let calls = 0;
  const room = createRoomServer({
    transcript: createTranscript(path.join(dir, "transcript.jsonl")),
    engines: { availability: () => ({ ok: true }), async run() { return { text: "unused", usage: null }; } },
    sessionsFile: path.join(dir, "engine-sessions.json"), roster: [],
    meshConfig: { ...CFG, boxId: "box-2", secret: "different-secret" },
    fetchImpl: async () => { calls++; throw new Error("must not send"); },
    meshOutboxFile: outboxFile, meshChainFile: path.join(dir, "mesh-chain.json"),
  });
  assert.equal(await room.retryMirrors(), 0);
  assert.equal(calls, 0);
  assert.equal(mesh.createMirrorOutbox(outboxFile).list().length, 1,
    "old-pair work remains recoverable without leaking to the new pairing");
});

test("an HTTP failure is reported with its status", async () => {
  const box = fakeBox({ status: 503, receipt: null });
  const out = await mesh.mirrorToBox(box.fetchImpl, CFG, entry());
  assert.equal(out.sent, false);
  assert.match(out.reason, /503/);
});

// SUCCESS MUST BE PROVEN, NOT ASSUMED. The old check only rejected a status it
// RECOGNISED as a failure, so a 200 whose body carried no usable status fell
// through to `{ sent: true }`: nothing was delivered, no hash came back, the
// chain never advanced -- and the room logged a healthy mirror. That false
// success is what kept a chain desync invisible to the operator.
test("a 200 with no recognised status is NOT reported as sent", async () => {
  for (const receipt of [
    null,                                   // body was not JSON at all
    {},                                     // JSON, but nothing we understand
    { ok: true },                           // a shape from some other service
    { status: "queued" },                   // a status we do not know
    { status: 200 },                        // a number, not one of our strings
    { error: "upstream timeout" },          // a proxy's error page, served 200
  ]) {
    const box = fakeBox({ status: 200, receipt });
    const out = await mesh.mirrorToBox(box.fetchImpl, CFG, entry());
    assert.equal(out.sent, false,
      "an unrecognised 200 must never be reported as delivered: " + JSON.stringify(receipt));
    assert.ok(out.reason, "and it must say why");
  }
});

test("an unrecognised 200 does not advance the causal chain", async () => {
  // The other half of the same bug: a false success that also silently leaves
  // the chain where it was would desync us on the very next message.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "room-mesh-nostatus-"));
  const chainFile = path.join(dir, "mesh-chain.json");
  mesh.writeChainHead(chainFile, HASH_A, CFG);
  const box = fakeBox({ status: 200, receipt: { error: "upstream timeout" } });
  const out = await mesh.mirrorToBox(box.fetchImpl, CFG, entry(), { chainFile });
  assert.equal(out.sent, false);
  assert.equal(mesh.readChainHead(chainFile, CFG), HASH_A,
    "a non-delivery must leave the chain exactly where it was");
});

test("a fresh delivery receipt must carry the exact envelope hash", async () => {
  const box = fakeBox({ receipt: { status: "delivered", hash: HASH_A } });
  const out = await mesh.mirrorToBox(box.fetchImpl, CFG, entry());
  assert.equal(out.sent, false);
  assert.match(out.reason, /hash/);
});

test("the undocumented accepted status is not treated as delivery", async () => {
  const fetchImpl = async (_url, opts) => {
    const envelope = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async () => ({
      status: "accepted", hash: meshContract.causalHash(envelope),
    }) };
  };
  const out = await mesh.mirrorToBox(fetchImpl, CFG, entry());
  assert.equal(out.sent, false);
  assert.match(out.reason, /accepted|recognised/);
});

test("a delivered duplicate receipt must name the retried message", async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({
    status: "duplicate",
    receipt: { message_id: "some-other-message", outcome: "delivered", hash: HASH_A },
  }) });
  const out = await mesh.mirrorToBox(fetchImpl, CFG, entry());
  assert.equal(out.sent, false);
  assert.match(out.reason, /message id/);
});

test("POST and GET mesh requests abort on deadline and a later retry can proceed", async () => {
  let postAborted = false;
  let postCalls = 0;
  const postFetch = async (_url, opts) => {
    postCalls++;
    if (postCalls > 1) {
      const envelope = JSON.parse(opts.body);
      return { ok: true, status: 200, json: async () => ({
        status: "delivered", hash: meshContract.causalHash(envelope),
      }) };
    }
    return new Promise((resolve, reject) => {
      if (!opts.signal) return reject(new Error("missing abort signal"));
      opts.signal.addEventListener("abort", () => {
        postAborted = true;
        const error = new Error("timed out");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    });
  };
  const firstPost = await mesh.mirrorToBox(postFetch, CFG, entry(), { timeoutMs: 10 });
  assert.equal(firstPost.sent, false);
  assert.equal(postAborted, true);
  assert.equal((await mesh.mirrorToBox(postFetch, CFG, entry(), { timeoutMs: 10 })).sent, true);

  let getAborted = false;
  const hangingGet = async (_url, opts) => new Promise((resolve, reject) => {
    if (!opts.signal) return reject(new Error("missing abort signal"));
    opts.signal.addEventListener("abort", () => {
      getAborted = true;
      const error = new Error("timed out");
      error.name = "AbortError";
      reject(error);
    }, { once: true });
  });
  assert.equal(await mesh.pullFromBox(hangingGet, CFG, 0, 10, 0, 0, null, 10), null);
  assert.equal(getAborted, true);
  const page = await mesh.pullFromBox(async () => ({ ok: true, json: async () => ({ entries: [] }) }),
    CFG, 0, 10, 0, 0, null, 10);
  assert.deepEqual(page, { entries: [] });
});

test("every retry pass recovers transcript-fsynced work whose ready write failed", async () => {
  const { createRoomServer } = require("../desktop/room/room.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "room-mesh-ready-poll-"));
  const outboxFile = path.join(dir, "mesh-outbox.jsonl");
  let failReadyWrites = false;
  const realOpenSync = fs.openSync;
  const transcript = {
    file: path.join(dir, "transcript.jsonl"), entries: [],
    seq() { return this.entries.length; },
    append(who, text, opts) {
      const durable = { at: 100, who, text, id: opts.id, to: opts.to };
      opts.beforeWrite(durable);
      failReadyWrites = true;
      opts.afterWrite(durable);
      this.entries.push(durable);
      return durable;
    },
  };
  let calls = 0;
  const fetchImpl = async (_url, opts) => {
    calls++;
    const envelope = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async () => ({
      status: "delivered", hash: meshContract.causalHash(envelope),
    }) };
  };
  fs.openSync = function patchedOpenSync(file, flags, ...rest) {
    if (failReadyWrites && path.resolve(String(file)) === path.resolve(outboxFile) && flags === "a") {
      throw new Error("simulated ready write failure");
    }
    return realOpenSync.call(fs, file, flags, ...rest);
  };
  try {
    const room = createRoomServer({
      transcript,
      engines: { availability: () => ({ ok: true }), async run() { return { text: "unused", usage: null }; } },
      sessionsFile: path.join(dir, "engine-sessions.json"), roster: [],
      meshConfig: CFG, fetchImpl, meshOutboxFile: outboxFile,
      meshChainFile: path.join(dir, "mesh-chain.json"),
    });
    room.dispatch("recover on poll", "everyone", "ready-on-next-poll");
    assert.equal(await room.retryMirrors(), 0, "the write is still failing on the first pass");
    failReadyWrites = false;
    assert.equal(await room.retryMirrors(), 1, "the next ordinary retry must make it ready and deliver it");
    assert.equal(calls, 1);
    assert.equal(mesh.createMirrorOutbox(outboxFile).list().length, 0);
  } finally {
    fs.openSync = realOpenSync;
  }
});

test("an outbox prepare failure refuses the turn before transcript fsync, then retry succeeds", async () => {
  const { createRoomServer } = require("../desktop/room/room.js");
  const { createTranscript } = require("../desktop/room/transcript.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "room-mesh-prepare-fail-"));
  const outboxFile = path.join(dir, "mesh-outbox.jsonl");
  const transcript = createTranscript(path.join(dir, "transcript.jsonl"));
  const realOpenSync = fs.openSync;
  let failPrepare = true;
  let fetchCalls = 0;
  const fetchImpl = async (_url, opts) => {
    fetchCalls++;
    const envelope = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async () => ({
      status: "delivered", hash: meshContract.causalHash(envelope),
    }) };
  };
  fs.openSync = function patchedOpenSync(file, flags, ...rest) {
    if (failPrepare && path.resolve(String(file)) === path.resolve(outboxFile) && flags === "a") {
      throw new Error("simulated outbox prepare failure");
    }
    return realOpenSync.call(fs, file, flags, ...rest);
  };
  try {
    const room = createRoomServer({
      transcript,
      engines: { availability: () => ({ ok: true }), async run() { return { text: "unused", usage: null }; } },
      sessionsFile: path.join(dir, "engine-sessions.json"), roster: [],
      meshConfig: CFG, fetchImpl, meshOutboxFile: outboxFile,
      meshChainFile: path.join(dir, "mesh-chain.json"),
    });
    assert.throws(() => room.dispatch("retry me", "everyone", "prepare-failure"), /prepare failure/);
    assert.equal(transcript.entries.length, 0, "a refused send must not become local-only durable history");
    assert.equal(fetchCalls, 0);

    failPrepare = false;
    assert.deepEqual(room.dispatch("retry me", "everyone", "prepare-failure"), []);
    await room.retryMirrors();
    assert.equal(transcript.entries.length, 1);
    assert.equal(fetchCalls, 1);
    assert.equal(mesh.createMirrorOutbox(outboxFile).list().length, 0);
  } finally {
    fs.openSync = realOpenSync;
  }
});

test("the two protocol success statuses are still accepted", async () => {
  // The allow-list must not be so strict that it breaks working delivery.
  for (const receipt of [
    (envelope) => ({ status: "delivered", hash: meshContract.causalHash(envelope) }),
    (envelope) => ({
      status: "duplicate",
      receipt: { message_id: envelope.message_id, outcome: "delivered", hash: HASH_C },
    }),
  ]) {
    const box = fakeBox({ status: 200, receipt });
    const out = await mesh.mirrorToBox(box.fetchImpl, CFG, entry());
    assert.equal(out.sent, true);
  }
});

test("success-shaped receipts without a valid chain hash stay pending", async () => {
  for (const receipt of [
    () => ({ status: "delivered" }),
    () => ({ status: "delivered", hash: HASH_A.toUpperCase() }),
    (envelope) => ({ status: "duplicate", receipt: { message_id: envelope.message_id, outcome: "delivered" } }),
    (envelope) => ({
      status: "duplicate",
      receipt: { message_id: envelope.message_id, outcome: "delivered", hash: "not-a-hash" },
    }),
  ]) {
    const box = fakeBox({ receipt });
    const out = await mesh.mirrorToBox(box.fetchImpl, CFG, entry());
    assert.equal(out.sent, false);
    assert.match(out.reason, /hash/);
  }
});

test("a delivered turn is not acknowledged when the chain head cannot be persisted", async () => {
  const { createRoomServer } = require("../desktop/room/room.js");
  const { createTranscript } = require("../desktop/room/transcript.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "room-mesh-chain-write-fail-"));
  const blocker = path.join(dir, "not-a-directory");
  fs.writeFileSync(blocker, "block mkdir");
  const outboxFile = path.join(dir, "mesh-outbox.jsonl");
  const box = fakeBox();
  const room = createRoomServer({
    transcript: createTranscript(path.join(dir, "transcript.jsonl")),
    engines: { availability: () => ({ ok: true }), async run() { return { text: "unused", usage: null }; } },
    sessionsFile: path.join(dir, "engine-sessions.json"),
    roster: [], meshConfig: CFG, fetchImpl: box.fetchImpl,
    meshOutboxFile: outboxFile,
    meshChainFile: path.join(blocker, "mesh-chain.json"),
  });
  room.dispatch("must remain pending", "everyone", "chain-write-failure");
  assert.equal(await room.retryMirrors(), 0);
  assert.equal(mesh.createMirrorOutbox(outboxFile).list().length, 1,
    "the outbox must retain a turn until both delivery and chain persistence succeed");
});

test("a live room mirrors its conversation to the box, without depending on it", async () => {
  // The whole path through a REAL booted room: a turn happens, the entry lands
  // locally, and the box receives a signed envelope for it.
  const { createRoomServer } = require("../desktop/room/room.js");
  const { createTranscript } = require("../desktop/room/transcript.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "room-mesh-live-"));
  const box = fakeBox();
  const room = createRoomServer({
    transcript: createTranscript(path.join(dir, "transcript.jsonl")),
    engines: { availability: () => ({ ok: true }), async run() { return { text: "engine answer", usage: null }; } },
    sessionsFile: path.join(dir, "engine-sessions.json"),
    roster: ["claude"],
    meshConfig: CFG,
    fetchImpl: box.fetchImpl,
  });
  await new Promise((r) => room.server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + room.server.address().port;
  await fetch(base + "/room/send", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "does this reach the box?", to: "claude" }),
  });
  // Give the fire-and-forget mirrors a moment.
  for (let i = 0; i < 60 && box.seen.length < 2; i++) await new Promise((r) => setTimeout(r, 25));

  const texts = box.seen.map((s) => s.envelope.body.text);
  assert.ok(texts.some((t) => t.startsWith("desktop:steve: does this reach the box?")),
    "Steve's message reaches the box: " + JSON.stringify(texts));
  assert.ok(texts.some((t) => t.startsWith("desktop:claude: engine answer")),
    "and so does the engine's reply: " + JSON.stringify(texts));

  // The local thread is complete regardless of the mesh.
  const thread = await (await fetch(base + "/room/thread")).json();
  assert.equal(thread.entries.length, 2);
  room.server.closeAllConnections();
  await new Promise((r) => room.server.close(r));
});

test("a box that is down does not affect the local room at all", async () => {
  const { createRoomServer } = require("../desktop/room/room.js");
  const { createTranscript } = require("../desktop/room/transcript.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "room-mesh-down-"));
  const room = createRoomServer({
    transcript: createTranscript(path.join(dir, "transcript.jsonl")),
    engines: { availability: () => ({ ok: true }), async run() { return { text: "still works", usage: null }; } },
    sessionsFile: path.join(dir, "engine-sessions.json"),
    roster: ["claude"],
    meshConfig: CFG,
    fetchImpl: async () => { throw new TypeError("fetch failed"); },
  });
  await new Promise((r) => room.server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + room.server.address().port;
  const res = await fetch(base + "/room/send", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "box is down", to: "claude" }),
  });
  assert.equal(res.status, 200, "a dead box must not fail a local send");
  for (let i = 0; i < 60; i++) {
    const t = await (await fetch(base + "/room/thread")).json();
    if (t.entries.length >= 2) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  const thread = await (await fetch(base + "/room/thread")).json();
  assert.deepEqual(thread.entries.map((e) => e.who), ["steve", "claude"],
    "the conversation completes normally with the box unreachable");
  room.server.closeAllConnections();
  await new Promise((r) => room.server.close(r));
});

test("a turn missed while the box is down is delivered after the room restarts", async () => {
  const { createRoomServer } = require("../desktop/room/room.js");
  const { createTranscript } = require("../desktop/room/transcript.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "room-mesh-restart-retry-"));
  const transcriptFile = path.join(dir, "transcript.jsonl");
  const outboxFile = path.join(dir, "mesh-outbox.jsonl");
  const common = {
    sessionsFile: path.join(dir, "engine-sessions.json"),
    roster: [], meshConfig: CFG,
    meshOutboxFile: outboxFile,
    meshChainFile: path.join(dir, "mesh-chain.json"),
  };
  const offline = createRoomServer({
    ...common,
    transcript: createTranscript(transcriptFile),
    engines: { availability: () => ({ ok: true }), async run() { return { text: "unused", usage: null }; } },
    fetchImpl: async () => { throw new TypeError("fetch failed"); },
  });
  offline.dispatch("persist me", "everyone", "durable-turn");
  await offline.retryMirrors();
  assert.equal(mesh.createMirrorOutbox(outboxFile).list().length, 1,
    "a network failure must leave the local turn durably pending");

  const box = fakeBox();
  const restarted = createRoomServer({
    ...common,
    transcript: createTranscript(transcriptFile),
    engines: { availability: () => ({ ok: true }), async run() { return { text: "unused", usage: null }; } },
    fetchImpl: box.fetchImpl,
  });
  assert.equal(await restarted.retryMirrors(), 1);
  assert.equal(box.seen.length, 1);
  assert.match(box.seen[0].envelope.body.text, /persist me/);
  assert.equal(mesh.createMirrorOutbox(outboxFile).list().length, 0,
    "the outbox acknowledges only after the box proves delivery");
});

test("a long message is clipped inside the contract's body cap", async () => {
  const box = fakeBox();
  await mesh.mirrorToBox(box.fetchImpl, CFG, entry({ text: "x".repeat(40000) }));
  const body = JSON.stringify(box.seen[0].envelope.body);
  assert.ok(body.length < 32 * 1024, "one mesh message is a message, not a payload channel");
});

test("a terminal non-causal rejection does not block later ready turns", async () => {
  const { createRoomServer } = require("../desktop/room/room.js");
  const { createTranscript } = require("../desktop/room/transcript.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "room-mesh-no-hol-"));
  const outboxFile = path.join(dir, "mesh-outbox.jsonl");
  const queue = mesh.createMirrorOutbox(outboxFile);
  queue.add(entry({ id: "expired-first", text: "expired first" }), CFG);
  queue.add(entry({ id: "deliver-second", text: "deliver second" }), CFG);
  const posted = [];
  const fetchImpl = async (_url, opts) => {
    const env = JSON.parse(opts.body);
    posted.push(env);
    if (env.body.text.includes("expired first")) {
      return { ok: false, status: 422, json: async () => ({ status: "rejected", reason: "expired", terminal: true }) };
    }
    return { ok: true, status: 200, json: async () => ({
      status: "delivered", hash: meshContract.causalHash(env),
    }) };
  };
  const room = createRoomServer({
    transcript: createTranscript(path.join(dir, "transcript.jsonl")),
    engines: { availability: () => ({ ok: true }), async run() { return { text: "unused", usage: null }; } },
    sessionsFile: path.join(dir, "engine-sessions.json"),
    roster: [], meshConfig: CFG, fetchImpl,
    meshOutboxFile: outboxFile, meshChainFile: path.join(dir, "mesh-chain.json"),
  });
  assert.equal(await room.retryMirrors(), 1);
  assert.deepEqual(posted.map((env) => env.body.text), [
    "desktop:claude: expired first", "desktop:claude: deliver second",
  ]);
  const pending = mesh.createMirrorOutbox(outboxFile).list();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].entry.id, "expired-first");
  assert.equal(pending[0].attempt, 1, "the terminal id is burned but the later turn still drains");
});

test("a causal rejection heals on pull and retries with a fresh id", async () => {
  const { createRoomServer } = require("../desktop/room/room.js");
  const { createTranscript } = require("../desktop/room/transcript.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "room-mesh-heal-retry-"));
  const outboxFile = path.join(dir, "mesh-outbox.jsonl");
  const chainFile = path.join(dir, "mesh-chain.json");
  mesh.writeChainHead(chainFile, HASH_D, CFG);
  const posted = [];
  const fetchImpl = async (_url, opts) => {
    if (!opts.body) {
      return { ok: true, status: 200, json: async () => ({
        boxId: CFG.boxId, entries: [], nextAfter: 0, nextOffset: 0, nextSeq: 0, chainHead: HASH_A,
      }) };
    }
    const env = JSON.parse(opts.body);
    posted.push(env);
    if (env.causal_parent === HASH_D) {
      return { ok: false, status: 422, json: async () => ({
        status: "rejected", reason: "causal_parent_unknown", terminal: true,
      }) };
    }
    assert.equal(env.causal_parent, HASH_A, "the healed retry must quote the box's head");
    return { ok: true, status: 200, json: async () => ({
      status: "delivered", hash: meshContract.causalHash(env),
    }) };
  };
  const room = createRoomServer({
    transcript: createTranscript(path.join(dir, "transcript.jsonl")),
    engines: { availability: () => ({ ok: true }), async run() { return { text: "unused", usage: null }; } },
    sessionsFile: path.join(dir, "engine-sessions.json"),
    roster: [], meshConfig: CFG, fetchImpl,
    meshOutboxFile: outboxFile, meshChainFile: chainFile,
    meshCursorFile: path.join(dir, "mesh-cursor.json"),
  });
  room.dispatch("heal me", "everyone", "heal-turn");
  assert.equal(await room.retryMirrors(), 0);
  assert.equal(mesh.createMirrorOutbox(outboxFile).list()[0].attempt, 1);
  const rejectedId = posted[0].message_id;
  await room.pullOnce();
  await room.retryMirrors();
  assert.equal(posted.length, 2);
  assert.notEqual(posted[1].message_id, rejectedId,
    "the box permanently remembers the rejection, so retry attempt 1 needs a fresh id");
  assert.equal(mesh.createMirrorOutbox(outboxFile).list().length, 0);
  assert.equal(mesh.readChainHead(chainFile, CFG), meshContract.causalHash(posted[1]));
});

test("a lost causal-rejection response heals, burns the duplicate id, and delivers immediately", async () => {
  const { createRoomServer } = require("../desktop/room/room.js");
  const { createTranscript } = require("../desktop/room/transcript.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "room-mesh-lost-reject-"));
  const outboxFile = path.join(dir, "mesh-outbox.jsonl");
  const chainFile = path.join(dir, "mesh-chain.json");
  mesh.writeChainHead(chainFile, HASH_D, CFG);
  mesh.createMirrorOutbox(outboxFile).add(entry({ id: "lost-rejection", text: "heal after lost rejection" }), CFG);

  const posted = [];
  let rejectedId = null;
  const fetchImpl = async (_url, opts) => {
    if (!opts.body) {
      return { ok: true, status: 200, json: async () => ({
        boxId: CFG.boxId, entries: [], nextAfter: 0, nextOffset: 0, nextSeq: 0, chainHead: HASH_A,
      }) };
    }
    const env = JSON.parse(opts.body);
    posted.push(env);
    if (rejectedId === null) {
      rejectedId = env.message_id;
      assert.equal(env.causal_parent, HASH_D);
      // The box durably rejected this id, but its response disappeared.
      throw new TypeError("response lost after rejection");
    }
    if (env.message_id === rejectedId) {
      return { ok: true, status: 200, json: async () => ({
        status: "duplicate",
        receipt: { message_id: env.message_id, outcome: "rejected", reason: "causal_parent_unknown", hash: null },
      }) };
    }
    assert.equal(env.causal_parent, HASH_A, "the fresh id must use the head learned by the pull");
    return { ok: true, status: 200, json: async () => ({
      status: "delivered", hash: meshContract.causalHash(env),
    }) };
  };
  const room = createRoomServer({
    transcript: createTranscript(path.join(dir, "transcript.jsonl")),
    engines: { availability: () => ({ ok: true }), async run() { return { text: "unused", usage: null }; } },
    sessionsFile: path.join(dir, "engine-sessions.json"),
    roster: [], meshConfig: CFG, fetchImpl,
    meshOutboxFile: outboxFile, meshChainFile: chainFile,
    meshCursorFile: path.join(dir, "mesh-cursor.json"),
  });

  assert.equal(await room.retryMirrors(), 0, "the lost response leaves the original id pending");
  assert.equal(mesh.createMirrorOutbox(outboxFile).list()[0].attempt, 0);
  await room.pullOnce();
  // pullOnce schedules the healed drain itself. Joining the serial queue here
  // proves that drain finished; this second call can correctly report zero.
  await room.retryMirrors();
  assert.equal(posted.length, 3);
  assert.equal(posted[1].message_id, posted[0].message_id, "uncertain delivery first retries the same id");
  assert.notEqual(posted[2].message_id, posted[0].message_id, "the recorded rejection then gets a fresh id");
  assert.equal(mesh.createMirrorOutbox(outboxFile).list().length, 0);
  assert.equal(mesh.readChainHead(chainFile, CFG), meshContract.causalHash(posted[2]));
});

// ---- the causal chain -------------------------------------------------------
// The box requires each message to quote the hash of the previous accepted one;
// a null parent is valid ONLY for the first message ever. Sending null every
// time meant message 1 delivered and every message after it was rejected —
// permanently, since a rejection is recorded against that message id. This fake
// box enforces the chain exactly as container/gate.js does.
function chainedBox() {
  const known = new Set();
  const seen = new Map();
  const sent = [];
  const fetchImpl = async (url, opts) => {
    const env = JSON.parse(opts.body);
    sent.push(env);
    if (seen.has(env.message_id)) {
      const prior = seen.get(env.message_id);
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: "duplicate", receipt: prior }),
      };
    }
    const parent = env.causal_parent || null;
    const ok = parent === null ? known.size === 0 : known.has(parent);
    if (!ok) {
      const rejected = { message_id: env.message_id, outcome: "rejected", reason: "causal_parent_unknown", hash: null };
      seen.set(env.message_id, rejected); // the box records the rejection: this id is burned
      return { ok: false, status: 422, json: async () => ({ status: "rejected", reason: rejected.reason, terminal: true }) };
    }
    const hash = meshContract.causalHash(env);
    known.add(hash);
    seen.set(env.message_id, { message_id: env.message_id, outcome: "delivered", hash });
    return { ok: true, status: 200, json: async () => ({ status: "delivered", hash, action: "chat_post" }) };
  };
  return { fetchImpl, sent, known };
}

function chainFileIn(dir) { return path.join(dir, "mesh-chain.json"); }

test("a whole conversation reaches the box, not just the first message", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-chain-"));
  const chainFile = chainFileIn(dir);
  const box = chainedBox();
  for (let i = 1; i <= 5; i++) {
    const out = await mesh.mirrorToBox(box.fetchImpl, CFG, entry({ id: "m" + i, text: "message " + i }), { chainFile });
    assert.equal(out.sent, true, "message " + i + " must be delivered, not rejected");
  }
  assert.equal(box.sent.length, 5);
  assert.equal(box.sent[0].causal_parent, null, "only the FIRST message may have a null parent");
  for (let i = 1; i < 5; i++) {
    assert.ok(box.sent[i].causal_parent, "message " + (i + 1) + " must quote a parent");
    assert.ok(box.known.has(box.sent[i].causal_parent), "and it must be a hash the box recorded");
  }
});

test("the chain head survives a restart, so the next message is still accepted", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-chain-restart-"));
  const chainFile = chainFileIn(dir);
  const box = chainedBox();
  await mesh.mirrorToBox(box.fetchImpl, CFG, entry({ id: "a1", text: "before restart" }), { chainFile });
  // A restart loses everything in memory; the chain head is on disk.
  const head = mesh.readChainHead(chainFile, CFG);
  assert.ok(head, "the chain head must be persisted");
  const out = await mesh.mirrorToBox(box.fetchImpl, CFG, entry({ id: "a2", text: "after restart" }), { chainFile });
  assert.equal(out.sent, true);
  assert.equal(box.sent[1].causal_parent, head);
});

test("a retry after a lost response resynchronises instead of wedging the chain", async () => {
  // The box accepted it, but the reply never arrived, so we never advanced.
  // Re-sending the same entry returns "duplicate" WITH the hash the box
  // recorded, which puts us back in step.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-chain-retry-"));
  const chainFile = chainFileIn(dir);
  const box = chainedBox();
  const e = entry({ id: "r1", text: "first" });
  await mesh.mirrorToBox(box.fetchImpl, CFG, e, { chainFile });
  mesh.writeChainHead(chainFile, "", CFG); // simulate never having learned the hash
  const again = await mesh.mirrorToBox(box.fetchImpl, CFG, e, { chainFile });
  assert.equal(again.sent, true, "a duplicate is not a failure");
  assert.ok(mesh.readChainHead(chainFile, CFG), "and it restores the chain head");
  const next = await mesh.mirrorToBox(box.fetchImpl, CFG, entry({ id: "r2", text: "second" }), { chainFile });
  assert.equal(next.sent, true, "so the conversation continues");
});

test("a broken chain is reported as desynced rather than silently dropped", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-chain-broken-"));
  const chainFile = chainFileIn(dir);
  const box = chainedBox();
  mesh.writeChainHead(chainFile, HASH_D, CFG);
  const out = await mesh.mirrorToBox(box.fetchImpl, CFG, entry({ id: "b1" }), { chainFile });
  assert.equal(out.sent, false);
  assert.equal(out.reason, "causal_parent_unknown");
  assert.equal(out.desynced, true, "the operator's log must be able to say WHY mirroring stopped");
});
