// Phase C slice 3: INBOUND. The desktop pulls box history with a durable
// cursor, because a laptop cannot be pushed to. Driven against a fake box that
// authenticates the request the same way the real one does.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const mesh = require("../desktop/room/room-mesh.js");
const meshContract = require("../container/mesh-contract.js");
const { createRoomServer } = require("../desktop/room/room.js");
const { createTranscript } = require("../desktop/room/transcript.js");

const SECRET = "shared-secret-for-tests";
const CFG = { origin: "https://box.example.fly.dev", selfId: "desktop-1", boxId: "box-1", secret: SECRET };
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

// A fake box that VERIFIES the HMAC exactly as container/gate.js meshReadAuthed
// does — so a mistake in how the desktop signs fails here, not in production.
function fakeBox(pages) {
  const calls = [];
  let i = 0;
  const fetchImpl = async (url, opts) => {
    const u = new URL(url);
    const h = opts.headers || {};
    assert.equal(opts.redirect, "error", "mesh reads must not follow redirects with auth headers");
    const expect = crypto.createHmac("sha256", SECRET)
      .update("GET " + u.pathname + u.search + " " + h["x-mesh-box"] + " " + h["x-mesh-ts"])
      .digest("hex");
    if (h["x-mesh-sig"] !== expect) return { ok: false, status: 401, json: async () => ({ error: "mesh auth required" }) };
    if (Math.abs(Date.now() - Number(h["x-mesh-ts"])) > 120000) return { ok: false, status: 401, json: async () => ({ error: "skew" }) };
    calls.push({
      after: u.searchParams.get("after"),
      offset: u.searchParams.get("offset"),
      seq: u.searchParams.get("seq"),
      anchor: u.searchParams.get("anchor"),
    });
    const page = pages[Math.min(i++, pages.length - 1)];
    return { ok: true, status: 200, json: async () => page };
  };
  return { fetchImpl, calls };
}

const boxEntry = (at, who, text, id, meshSeq = 0) => ({ at, who, text, id: id || null, to: null, meshSeq });

test("the desktop signs the full read target the way the box verifies it", async () => {
  const box = fakeBox([{ boxId: "box-1", entries: [], nextAfter: 0, nextSeq: 17, remaining: 0 }]);
  const page = await mesh.pullFromBox(box.fetchImpl, CFG, 0, 25, 3, 17, HASH_A);
  assert.ok(page, "a correctly signed read must be accepted");
  assert.equal(box.calls[0].after, "0");
  assert.equal(box.calls[0].offset, "3");
  assert.equal(box.calls[0].seq, "17");
  assert.equal(box.calls[0].anchor, HASH_A);
});

test("a wrong secret is refused by the box's own check", async () => {
  const box = fakeBox([{ entries: [] }]);
  const page = await mesh.pullFromBox(box.fetchImpl, { ...CFG, secret: "wrong" }, 0);
  assert.equal(page, null, "an unauthenticated read must return nothing, not throw");
});

test("the cursor persists, so a restart does not re-import the thread", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-cursor-"));
  const f = path.join(dir, "nested", "mesh-cursor.json");
  assert.equal(mesh.readCursor(f, CFG), 0, "no cursor means start from what the box keeps");
  assert.equal(mesh.writeCursor(f, 1234, 0, 5, CFG, HASH_A), true);
  assert.equal(mesh.readCursor(f, CFG), 1234);
  assert.deepEqual(mesh.readCursorState(f, CFG), { after: 1234, offset: 0, seq: 5, anchor: HASH_A });
  assert.equal(mesh.writeCursor(f, 1234, 7, 19, CFG, HASH_B), true);
  assert.deepEqual(mesh.readCursorState(f, CFG), { after: 1234, offset: 7, seq: 19, anchor: HASH_B },
    "the cursor remembers legacy tie progress, durable sequence, and the entry at that sequence");
  fs.writeFileSync(f, "{not json");
  assert.equal(mesh.readCursor(f, CFG), 0, "a corrupt cursor re-imports rather than failing; dedup absorbs it");
});

test("cursor and chain state reset when the desktop is paired to a different box", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-repair-state-"));
  const cursorFile = path.join(dir, "mesh-cursor.json");
  const chainFile = path.join(dir, "mesh-chain.json");
  const other = {
    ...CFG,
    origin: "https://replacement.example.fly.dev",
    selfId: "desktop-2",
    boxId: "box-2",
  };

  assert.equal(mesh.writeCursor(cursorFile, 1234, 6, 88, CFG), true);
  assert.equal(mesh.writeChainHead(chainFile, HASH_A, CFG), true);
  assert.deepEqual(mesh.readCursorState(cursorFile, CFG), { after: 1234, offset: 6, seq: 88, anchor: null });
  assert.equal(mesh.readChainHead(chainFile, CFG), HASH_A);
  assert.deepEqual(mesh.readCursorState(cursorFile, other), { after: 0, offset: 0, seq: 0, anchor: null },
    "a new box must not inherit the old box's history position");
  assert.equal(mesh.readChainHead(chainFile, other), null,
    "a new box must not inherit a causal parent it has never seen");
});

test("a restored box can rewind a stale higher sequence cursor", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-seq-reset-"));
  const cursorFile = path.join(dir, "mesh-cursor.json");
  mesh.writeCursor(cursorFile, 9000, 4, 99, CFG, HASH_C);
  const box = fakeBox([{
    boxId: CFG.boxId,
    sequenceReset: true,
    entries: [
      boxEntry(100, "claude", "restored first", "restored-1", 1),
      boxEntry(200, "codex", "restored second", "restored-2", 2),
    ],
    nextAfter: 200,
    nextOffset: 1,
    nextSeq: 2,
    nextAnchor: HASH_A,
    remaining: 0,
  }]);
  const transcript = createTranscript(path.join(dir, "transcript.jsonl"));
  const room = createRoomServer({
    transcript,
    engines: { availability: () => ({ ok: true }), async run() { return { text: "x", usage: null }; } },
    sessionsFile: path.join(dir, "engine-sessions.json"),
    roster: ["claude"], meshConfig: CFG, fetchImpl: box.fetchImpl,
    meshCursorFile: cursorFile, meshChainFile: path.join(dir, "mesh-chain.json"),
  });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));

  assert.equal(await room.pullOnce(), 2);
  assert.equal(box.calls[0].seq, "99");
  assert.equal(box.calls[0].anchor, HASH_C);
  assert.deepEqual(transcript.entries.map((entry) => entry.text), ["restored first", "restored second"]);
  assert.deepEqual(mesh.readCursorState(cursorFile, CFG), { after: 200, offset: 1, seq: 2, anchor: HASH_A },
    "sequenceReset is the one safe case where the durable cursor may move backwards");

  room.server.closeAllConnections();
  await new Promise((resolve) => room.server.close(resolve));
});

test("an equal-sequence restore replaces the old cursor anchor", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-anchor-reset-"));
  const cursorFile = path.join(dir, "mesh-cursor.json");
  mesh.writeCursor(cursorFile, 200, 1, 2, CFG, HASH_C);
  const box = fakeBox([{
    boxId: CFG.boxId,
    sequenceReset: true,
    entries: [
      boxEntry(100, "claude", "replacement first", "replacement-1", 1),
      boxEntry(200, "codex", "replacement second", "replacement-2", 2),
    ],
    nextAfter: 200,
    nextOffset: 1,
    nextSeq: 2,
    nextAnchor: HASH_A,
    remaining: 0,
  }]);
  const room = createRoomServer({
    transcript: createTranscript(path.join(dir, "transcript.jsonl")),
    engines: { availability: () => ({ ok: true }), async run() { return { text: "x", usage: null }; } },
    sessionsFile: path.join(dir, "engine-sessions.json"),
    roster: ["claude"], meshConfig: CFG, fetchImpl: box.fetchImpl,
    meshCursorFile: cursorFile, meshChainFile: path.join(dir, "mesh-chain.json"),
  });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));

  assert.equal(await room.pullOnce(), 2);
  assert.deepEqual(mesh.readCursorState(cursorFile, CFG), { after: 200, offset: 1, seq: 2, anchor: HASH_A },
    "a reset at the same sequence must adopt the replacement history anchor");

  room.server.closeAllConnections();
  await new Promise((resolve) => room.server.close(resolve));
});

test("a live room pulls box turns into its own thread and advances the cursor", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-live-in-"));
  const cursorFile = path.join(dir, "mesh-cursor.json");
  const box = fakeBox([
    { boxId: "box-1", entries: [boxEntry(2000, "hermes", "the box says hello", "b1", 1)], nextAfter: 2000, nextSeq: 1, nextAnchor: HASH_A, remaining: 0 },
    { boxId: "box-1", entries: [], nextAfter: 2000, nextSeq: 1, nextAnchor: HASH_A, remaining: 0 },
  ]);
  const room = createRoomServer({
    transcript: createTranscript(path.join(dir, "transcript.jsonl")),
    engines: { availability: () => ({ ok: true }), async run() { return { text: "x", usage: null }; } },
    sessionsFile: path.join(dir, "engine-sessions.json"),
    roster: ["claude"],
    meshConfig: CFG,
    fetchImpl: box.fetchImpl,
    meshCursorFile: cursorFile,
  });
  await new Promise((r) => room.server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + room.server.address().port;

  assert.equal(await room.pullOnce(), 1, "the box turn is new");
  const thread = await (await fetch(base + "/room/thread")).json();
  assert.deepEqual(thread.entries.map((e) => e.who), ["box:hermes"]);
  assert.equal(mesh.readCursor(cursorFile), 2000, "the cursor advanced");
  assert.deepEqual(mesh.readCursorState(cursorFile, CFG), { after: 2000, offset: 0, seq: 1, anchor: HASH_A });

  assert.equal(await room.pullOnce(), 0, "a second pull imports nothing new");
  assert.equal(box.calls[1].after, "2000", "and asks from where it left off");
  assert.equal(box.calls[1].offset, "0", "and carries the tie offset stored with that timestamp");
  assert.equal(box.calls[1].seq, "1", "and resumes from the durable sequence, not wall-clock time");
  assert.equal(box.calls[1].anchor, HASH_A, "and proves which entry that sequence referred to");

  room.server.closeAllConnections();
  await new Promise((r) => room.server.close(r));
});

test("a large catch-up skips a self-echo tail but advances across it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-catchup-in-"));
  const cursorFile = path.join(dir, "mesh-cursor.json");
  const normalPage = Array.from({ length: 200 }, (_, i) =>
    boxEntry(1000 + i, "claude", "message-" + (i + 1), "message-" + (i + 1), i + 1));
  const visibleTail = Array.from({ length: 5 }, (_, i) =>
    boxEntry(1200 + i, "claude", "message-" + (201 + i), "message-" + (201 + i), 201 + i));
  const box = fakeBox([
    {
      boxId: "box-1",
      entries: normalPage,
      nextAfter: 1199,
      nextOffset: 1,
      nextSeq: 200,
      nextAnchor: HASH_B,
      remaining: 10,
      catchup: {
        scanned: 210,
        total: 205,
        omitted: 200,
        entries: visibleTail,
        nextAfter: 1209,
        nextOffset: 1,
        nextSeq: 210,
        nextAnchor: HASH_C,
      },
    },
    { boxId: "box-1", entries: [], nextAfter: 1209, nextOffset: 1, nextSeq: 210, nextAnchor: HASH_C, remaining: 0 },
  ]);
  const transcript = createTranscript(path.join(dir, "transcript.jsonl"));
  const room = createRoomServer({
    transcript,
    engines: { availability: () => ({ ok: true }), async run() { return { text: "x", usage: null }; } },
    sessionsFile: path.join(dir, "engine-sessions.json"),
    roster: ["claude"], meshConfig: CFG, fetchImpl: box.fetchImpl,
    meshCursorFile: cursorFile, meshChainFile: path.join(dir, "mesh-chain.json"),
  });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));

  assert.equal(await room.pullOnce(), 6, "one marker plus five recent turns enter the room");
  assert.deepEqual(transcript.entries.map((entry) => entry.text), [
    "(caught up 205 messages from the box; showing the latest 5)",
    "message-201", "message-202", "message-203", "message-204", "message-205",
  ], "none of the 200 compatibility-page turns can leak into engine history");
  assert.deepEqual(mesh.readCursorState(cursorFile, CFG), { after: 1209, offset: 1, seq: 210, anchor: HASH_C },
    "the durable cursor advances across the five suppressed self echoes after the visible tail");

  assert.equal(await room.pullOnce(), 0, "the next poll has no skipped backlog left to import");
  assert.equal(box.calls[1].seq, "210", "the next read starts after the self tail, not after the normal 200-entry page");
  assert.equal(box.calls[1].anchor, HASH_C);

  room.server.closeAllConnections();
  await new Promise((resolve) => room.server.close(resolve));
});

test("an unreachable box leaves the cursor and the thread untouched", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-down-in-"));
  const cursorFile = path.join(dir, "mesh-cursor.json");
  mesh.writeCursor(cursorFile, 500, 3, 7, CFG, HASH_C);
  const room = createRoomServer({
    transcript: createTranscript(path.join(dir, "transcript.jsonl")),
    engines: { availability: () => ({ ok: true }), async run() { return { text: "x", usage: null }; } },
    sessionsFile: path.join(dir, "engine-sessions.json"),
    roster: ["claude"],
    meshConfig: CFG,
    fetchImpl: async () => { throw new TypeError("fetch failed"); },
    meshCursorFile: cursorFile,
  });
  await new Promise((r) => room.server.listen(0, "127.0.0.1", r));
  assert.equal(await room.pullOnce(), 0);
  assert.deepEqual(mesh.readCursorState(cursorFile, CFG), { after: 500, offset: 3, seq: 7, anchor: HASH_C },
    "a failed pull must not move the cursor past unseen messages");
  room.server.closeAllConnections();
  await new Promise((r) => room.server.close(r));
});

test("an unpaired desktop never pulls at all", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-unpaired-"));
  let called = false;
  const room = createRoomServer({
    transcript: createTranscript(path.join(dir, "transcript.jsonl")),
    engines: { availability: () => ({ ok: true }), async run() { return { text: "x", usage: null }; } },
    sessionsFile: path.join(dir, "engine-sessions.json"),
    roster: ["claude"],
    meshConfig: null,
    fetchImpl: async () => { called = true; throw new Error("should not be called"); },
    meshCursorFile: path.join(dir, "mesh-cursor.json"),
  });
  await new Promise((r) => room.server.listen(0, "127.0.0.1", r));
  assert.equal(await room.pullOnce(), 0);
  assert.equal(called, false, "unpaired is the normal state and must cost nothing");
  room.server.closeAllConnections();
  await new Promise((r) => room.server.close(r));
});

test("a pulled message keeps the time it was said on the box, not the time it arrived", async () => {
  // A desktop offline for an hour then pulling must not stamp an hour of box
  // conversation with one arrival instant — the Replay scrub would show it as
  // a single moment that never happened.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-time-"));
  const anHourAgo = Date.now() - 3600000;
  const box = fakeBox([{ boxId: "box-1", entries: [
    boxEntry(anHourAgo, "claude", "said an hour ago on the box", "t1", 1),
    boxEntry(anHourAgo + 1800000, "codex", "said half an hour ago", "t2", 2),
  ], nextAfter: anHourAgo + 1800000, nextSeq: 2, remaining: 0 }]);
  const room = createRoomServer({
    transcript: createTranscript(path.join(dir, "transcript.jsonl")),
    engines: { availability: () => ({ ok: true }), async run() { return { text: "x", usage: null }; } },
    sessionsFile: path.join(dir, "engine-sessions.json"),
    roster: ["claude"],
    meshConfig: CFG,
    fetchImpl: box.fetchImpl,
    meshCursorFile: path.join(dir, "mesh-cursor.json"),
  });
  await new Promise((r) => room.server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + room.server.address().port;
  assert.equal(await room.pullOnce(), 2);
  const thread = await (await fetch(base + "/room/thread")).json();
  assert.equal(thread.entries[0].at, anHourAgo, "the box's own time is preserved");
  assert.equal(thread.entries[1].at, anHourAgo + 1800000);
  assert.deepEqual(thread.entries.map((e) => e.source), ["box:box-1", "box:box-1"],
    "pulled turns retain one durable source so their causal order survives clock changes");
  assert.ok(thread.entries[1].at - thread.entries[0].at === 1800000,
    "and the half hour between them survives into the timeline");
  room.server.closeAllConnections();
  await new Promise((r) => room.server.close(r));
});

test("a desynced room heals itself from the box's chain head", async () => {
  // The failure this prevents: the chain file is lost or corrupted, every
  // message is then rejected forever, and the only documented remedy is
  // hand-editing JSON. The box reports the last hash it recorded for us, and
  // it accepts ANY hash it knows as a parent, so adopting it puts us back in
  // step on the next poll with no human involved.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-heal-"));
  const chainFile = path.join(dir, "mesh-chain.json");
  mesh.writeChainHead(chainFile, HASH_A, CFG);

  const box = fakeBox([{ boxId: "box-1", entries: [], nextAfter: 0, nextSeq: 0, remaining: 0, chainHead: HASH_B }]);
  const room = createRoomServer({
    transcript: createTranscript(path.join(dir, "transcript.jsonl")),
    engines: { availability: () => ({ ok: true }), async run() { return { text: "x", usage: null }; } },
    sessionsFile: path.join(dir, "engine-sessions.json"),
    roster: ["claude"], meshConfig: CFG, fetchImpl: box.fetchImpl,
    meshCursorFile: path.join(dir, "mesh-cursor.json"), meshChainFile: chainFile,
  });
  await new Promise((r) => room.server.listen(0, "127.0.0.1", r));
  await room.pullOnce();
  assert.equal(mesh.readChainHead(chainFile, CFG), HASH_B,
    "the room adopts what the box will actually accept");
  room.server.closeAllConnections();
  await new Promise((r) => room.server.close(r));
});

test("a box with no chain for us yet leaves the head alone", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-heal-none-"));
  const chainFile = path.join(dir, "mesh-chain.json");
  const box = fakeBox([{ boxId: "box-1", entries: [], nextAfter: 0, nextSeq: 0, remaining: 0, chainHead: null }]);
  const room = createRoomServer({
    transcript: createTranscript(path.join(dir, "transcript.jsonl")),
    engines: { availability: () => ({ ok: true }), async run() { return { text: "x", usage: null }; } },
    sessionsFile: path.join(dir, "engine-sessions.json"),
    roster: ["claude"], meshConfig: CFG, fetchImpl: box.fetchImpl,
    meshCursorFile: path.join(dir, "mesh-cursor.json"), meshChainFile: chainFile,
  });
  await new Promise((r) => room.server.listen(0, "127.0.0.1", r));
  await room.pullOnce();
  assert.equal(mesh.readChainHead(chainFile, CFG), null,
    "no chain yet means the first message correctly uses a null parent");
  room.server.closeAllConnections();
  await new Promise((r) => room.server.close(r));
});

test("a box that has LOST our chain clears our stale head instead of wedging us", async () => {
  // The case the test above does NOT cover: it starts with no chain file at
  // all, so null-stays-null passes whether or not the heal works. The real
  // failure needs a STALE head plus a box reporting none -- /data wiped, the
  // secret re-paired, the box restored from an older image. Adopting only a
  // truthy hash left us holding a parent the box has never heard of, so every
  // message was rejected causal_parent_unknown forever while the log claimed
  // the next pull would fix it. A null parent is precisely what the box
  // accepts in that state, so the heal is to CLEAR.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-heal-wiped-"));
  const chainFile = path.join(dir, "mesh-chain.json");
  mesh.writeChainHead(chainFile, HASH_A, CFG);
  assert.ok(mesh.readChainHead(chainFile, CFG), "precondition: we start out desynced");

  const box = fakeBox([{ boxId: "box-1", entries: [], nextAfter: 0, nextSeq: 0, remaining: 0, chainHead: null }]);
  const room = createRoomServer({
    transcript: createTranscript(path.join(dir, "transcript.jsonl")),
    engines: { availability: () => ({ ok: true }), async run() { return { text: "x", usage: null }; } },
    sessionsFile: path.join(dir, "engine-sessions.json"),
    roster: ["claude"], meshConfig: CFG, fetchImpl: box.fetchImpl,
    meshCursorFile: path.join(dir, "mesh-cursor.json"), meshChainFile: chainFile,
  });
  await new Promise((r) => room.server.listen(0, "127.0.0.1", r));
  await room.pullOnce();
  assert.equal(mesh.readChainHead(chainFile, CFG), null,
    "the stale head must be cleared, or every future message is rejected forever");
  room.server.closeAllConnections();
  await new Promise((r) => room.server.close(r));
});

test("a page that OMITS chainHead is not read as 'the box has no chain'", async () => {
  // Absence of the field is not an answer. A truncated body or a proxy that
  // rewrote the response must never be able to wipe a healthy chain head --
  // that would turn a transient network oddity into a desync we caused.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-heal-absent-"));
  const chainFile = path.join(dir, "mesh-chain.json");
  mesh.writeChainHead(chainFile, HASH_A, CFG);

  const box = fakeBox([{ boxId: "box-1", entries: [], nextAfter: 0, nextSeq: 0, remaining: 0 }]);
  const room = createRoomServer({
    transcript: createTranscript(path.join(dir, "transcript.jsonl")),
    engines: { availability: () => ({ ok: true }), async run() { return { text: "x", usage: null }; } },
    sessionsFile: path.join(dir, "engine-sessions.json"),
    roster: ["claude"], meshConfig: CFG, fetchImpl: box.fetchImpl,
    meshCursorFile: path.join(dir, "mesh-cursor.json"), meshChainFile: chainFile,
  });
  await new Promise((r) => room.server.listen(0, "127.0.0.1", r));
  await room.pullOnce();
  assert.equal(mesh.readChainHead(chainFile, CFG), HASH_A,
    "a missing field must leave a working chain untouched");
  room.server.closeAllConnections();
  await new Promise((r) => room.server.close(r));
});

test("a response for the wrong or an unidentified box cannot mutate local state", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-wrong-box-"));
  const cursorFile = path.join(dir, "mesh-cursor.json");
  const chainFile = path.join(dir, "mesh-chain.json");
  const transcript = createTranscript(path.join(dir, "transcript.jsonl"));
  transcript.append("steve", "local history", { id: "local-before-wrong-box", at: 100 });
  mesh.writeCursor(cursorFile, 500, 3, 7, CFG, HASH_C);
  mesh.writeChainHead(chainFile, HASH_A, CFG);
  const box = fakeBox([
    {
      boxId: "some-other-box",
      entries: [boxEntry(600, "claude", "must not import", "wrong-box", 8)],
      nextAfter: 600, nextSeq: 8, remaining: 0, chainHead: HASH_B,
    },
    {
      entries: [boxEntry(700, "claude", "must not import either", "missing-box", 9)],
      nextAfter: 700, nextSeq: 9, remaining: 0, chainHead: null,
    },
  ]);
  const room = createRoomServer({
    transcript,
    engines: { availability: () => ({ ok: true }), async run() { return { text: "x", usage: null }; } },
    sessionsFile: path.join(dir, "engine-sessions.json"),
    roster: ["claude"], meshConfig: CFG, fetchImpl: box.fetchImpl,
    meshCursorFile: cursorFile, meshChainFile: chainFile,
  });
  await new Promise((r) => room.server.listen(0, "127.0.0.1", r));

  assert.equal(await room.pullOnce(), 0);
  assert.equal(await room.pullOnce(), 0);
  assert.deepEqual(transcript.entries.map((entry) => entry.text), ["local history"]);
  assert.deepEqual(mesh.readCursorState(cursorFile, CFG), { after: 500, offset: 3, seq: 7, anchor: HASH_C });
  assert.equal(mesh.readChainHead(chainFile, CFG), HASH_A);

  room.server.closeAllConnections();
  await new Promise((r) => room.server.close(r));
});

test("an invalid chain head rejects the whole page without corrupting state", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-invalid-head-"));
  const cursorFile = path.join(dir, "mesh-cursor.json");
  const chainFile = path.join(dir, "mesh-chain.json");
  const transcript = createTranscript(path.join(dir, "transcript.jsonl"));
  transcript.append("steve", "safe local turn", { id: "safe-local-turn", at: 100 });
  mesh.writeCursor(cursorFile, 500, 2, 7, CFG, HASH_C);
  mesh.writeChainHead(chainFile, HASH_A, CFG);
  const box = fakeBox([{
    boxId: "box-1",
    entries: [boxEntry(600, "claude", "must not land", "bad-head-entry", 8)],
    nextAfter: 600,
    nextSeq: 8,
    remaining: 0,
    chainHead: "not-a-valid-chain-hash",
  }]);
  const room = createRoomServer({
    transcript,
    engines: { availability: () => ({ ok: true }), async run() { return { text: "x", usage: null }; } },
    sessionsFile: path.join(dir, "engine-sessions.json"),
    roster: ["claude"], meshConfig: CFG, fetchImpl: box.fetchImpl,
    meshCursorFile: cursorFile, meshChainFile: chainFile,
  });
  await new Promise((r) => room.server.listen(0, "127.0.0.1", r));

  assert.equal(await room.pullOnce(), 0);
  assert.deepEqual(transcript.entries.map((entry) => entry.text), ["safe local turn"]);
  assert.deepEqual(mesh.readCursorState(cursorFile, CFG), { after: 500, offset: 2, seq: 7, anchor: HASH_C });
  assert.equal(mesh.readChainHead(chainFile, CFG), HASH_A);

  room.server.closeAllConnections();
  await new Promise((r) => room.server.close(r));
});

test("a stale pull cannot wipe a chain head earned while its response was in flight", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-heal-race-"));
  const chainFile = path.join(dir, "mesh-chain.json");
  let releasePull;
  const pullBody = new Promise((resolve) => { releasePull = resolve; });
  const sent = [];
  const hashes = [];
  const fetchImpl = async (url, opts) => {
    const u = new URL(url);
    if (u.pathname === "/mesh/since") {
      return { ok: true, status: 200, json: async () => pullBody };
    }
    const envelope = JSON.parse(opts.body);
    sent.push(envelope);
    const hash = meshContract.causalHash(envelope);
    hashes.push(hash);
    return { ok: true, status: 200, json: async () => ({ status: "delivered", hash }) };
  };
  const room = createRoomServer({
    transcript: createTranscript(path.join(dir, "transcript.jsonl")),
    engines: { availability: () => ({ ok: true }), async run() { return { text: "unused", usage: null }; } },
    sessionsFile: path.join(dir, "engine-sessions.json"),
    roster: [], meshConfig: CFG, fetchImpl,
    meshCursorFile: path.join(dir, "mesh-cursor.json"), meshChainFile: chainFile,
  });

  const pulling = room.pullOnce();
  room.dispatch("first local turn", "everyone", "race-first");
  for (let i = 0; i < 100 && mesh.readChainHead(chainFile, CFG) !== hashes[0]; i++) {
    await new Promise((r) => setTimeout(r, 2));
  }
  assert.equal(mesh.readChainHead(chainFile, CFG), hashes[0], "precondition: the mirror earned a fresh head");

  releasePull({ boxId: "box-1", entries: [], nextAfter: 0, nextSeq: 0, remaining: 0, chainHead: null });
  await pulling;
  assert.equal(mesh.readChainHead(chainFile, CFG), hashes[0],
    "the older null snapshot must not overwrite a head earned after the request began");

  room.dispatch("second local turn", "everyone", "race-second");
  for (let i = 0; i < 100 && sent.length < 2; i++) await new Promise((r) => setTimeout(r, 2));
  assert.equal(sent[1].causal_parent, hashes[0], "the next turn continues the live chain");
  room.server.closeAllConnections();
  await new Promise((r) => room.server.close(r));
});

test("echo suppression uses sender identity, not the message's words", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-echo-identity-"));
  const cursorFile = path.join(dir, "mesh-cursor.json");
  const box = fakeBox([{ boxId: "box-1", entries: [
    boxEntry(1000, "box:desktop-1", "desktop:steve: our own mirrored turn", "mesh:desktop-own", 1),
    boxEntry(2000, "claude", "desktop: this is genuine box content", "box-native", 2),
  ], nextAfter: 2000, nextSeq: 2, remaining: 0, chainHead: null }]);
  const room = createRoomServer({
    transcript: createTranscript(path.join(dir, "transcript.jsonl")),
    engines: { availability: () => ({ ok: true }), async run() { return { text: "x", usage: null }; } },
    sessionsFile: path.join(dir, "engine-sessions.json"),
    roster: ["claude"], meshConfig: CFG, fetchImpl: box.fetchImpl,
    meshCursorFile: cursorFile, meshChainFile: path.join(dir, "mesh-chain.json"),
  });
  await new Promise((r) => room.server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + room.server.address().port;
  assert.equal(await room.pullOnce(), 1, "only our own structurally identified echo is skipped");
  const thread = await (await fetch(base + "/room/thread")).json();
  assert.deepEqual(thread.entries.map((e) => e.text), ["desktop: this is genuine box content"]);
  assert.equal(mesh.readCursor(cursorFile), 2000, "the real box message is imported before the cursor advances");
  room.server.closeAllConnections();
  await new Promise((r) => room.server.close(r));
});

test("tied legacy messages without ids stay distinct through their mesh sequence", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-tied-idless-"));
  const cursorFile = path.join(dir, "mesh-cursor.json");
  const tiedAt = 1700000000000;
  const box = fakeBox([{
    boxId: "box-1",
    entries: [
      boxEntry(tiedAt, "claude", "same words at the same instant", null, 41),
      boxEntry(tiedAt, "claude", "same words at the same instant", null, 42),
    ],
    nextAfter: tiedAt,
    nextOffset: 2,
    nextSeq: 42,
    nextAnchor: HASH_A,
    remaining: 0,
  }]);
  const transcript = createTranscript(path.join(dir, "transcript.jsonl"));
  const room = createRoomServer({
    transcript,
    engines: { availability: () => ({ ok: true }), async run() { return { text: "x", usage: null }; } },
    sessionsFile: path.join(dir, "engine-sessions.json"),
    roster: ["claude"], meshConfig: CFG, fetchImpl: box.fetchImpl,
    meshCursorFile: cursorFile, meshChainFile: path.join(dir, "mesh-chain.json"),
  });
  await new Promise((r) => room.server.listen(0, "127.0.0.1", r));

  assert.equal(await room.pullOnce(), 2, "both exact-looking messages are real events and must import");
  assert.equal(transcript.entries.length, 2);
  assert.notEqual(transcript.entries[0].id, transcript.entries[1].id,
    "meshSeq keeps same-time, same-text legacy events from collapsing into one id");
  assert.deepEqual(mesh.readCursorState(cursorFile, CFG), { after: tiedAt, offset: 2, seq: 42, anchor: HASH_A });

  room.server.closeAllConnections();
  await new Promise((r) => room.server.close(r));
});

test("the LIVE room thread is ordered by when things were said, not when they arrived", async () => {
  // This was fixed behind the Replay button but not in the room you actually
  // use, so a box reply from twenty minutes ago sat below something typed a
  // second ago.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-live-order-"));
  const t0 = Date.now() - 60000;
  const box = fakeBox([{ boxId: "box-1", entries: [
    boxEntry(t0 + 20000, "hermes", "the box said this in the middle", "o1", 1),
  ], nextAfter: t0 + 20000, nextSeq: 1, remaining: 0 }]);
  const transcript = createTranscript(path.join(dir, "transcript.jsonl"));
  transcript.append("steve", "typed first", { to: "claude", at: t0 });
  transcript.append("steve", "typed last", { to: "claude", at: t0 + 40000 });
  const room = createRoomServer({
    transcript,
    engines: { availability: () => ({ ok: true }), async run() { return { text: "x", usage: null }; } },
    sessionsFile: path.join(dir, "engine-sessions.json"),
    roster: ["claude"], meshConfig: CFG, fetchImpl: box.fetchImpl,
    meshCursorFile: path.join(dir, "mesh-cursor.json"), meshChainFile: path.join(dir, "mesh-chain.json"),
  });
  await new Promise((r) => room.server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + room.server.address().port;
  await room.pullOnce();
  const thread = await (await fetch(base + "/room/thread")).json();
  assert.deepEqual(thread.entries.map((e) => e.text),
    ["typed first", "the box said this in the middle", "typed last"],
    "the pulled message belongs where it was SAID, in the live view too");
  room.server.closeAllConnections();
  await new Promise((r) => room.server.close(r));
});
