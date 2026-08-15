// Tests for the room -> box-board bridge (desktop/room/room-kanban.js). The
// fetch is injected, so the REAL login->create path runs against a fake box:
// cookie capture, task payload, and every actionable failure message.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { sendToKanban, threadTail } = require("../desktop/room/room-kanban.js");

function cfgWith(opts = {}) {
  const { origin, key } = opts;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "room-kanban-"));
  const localAppData = path.join(base, "lad");
  const agenthostDir = path.join(base, "ah");
  fs.mkdirSync(path.join(localAppData, "AgentHost"), { recursive: true });
  fs.mkdirSync(agenthostDir, { recursive: true });
  if (origin) fs.writeFileSync(path.join(localAppData, "AgentHost", "box.json"), (opts.bom ? "﻿" : "") + JSON.stringify({ origin }));
  if (key) fs.writeFileSync(path.join(agenthostDir, "box-access.key"), key + "\n");
  return { localAppData, agenthostDir };
}

function fakeBox({ grantCookie = true, createStatus = 200, createBody = { task: { id: "t_room1" } } } = {}) {
  const seen = { requests: [] };
  const fetchImpl = async (url, opts) => {
    seen.requests.push({ url, opts });
    if (url.endsWith("/session")) {
      return {
        ok: grantCookie, status: grantCookie ? 204 : 401,
        headers: { get: (h) => (h === "set-cookie" && grantCookie ? "agenthost_auth=cookievalue; Path=/; HttpOnly" : null) },
        json: async () => null,
      };
    }
    return { ok: createStatus === 200, status: createStatus, headers: { get: () => null }, json: async () => createBody };
  };
  return { fetchImpl, seen };
}

const ENTRIES = [
  { who: "steve", to: "everyone", text: "should we ship the room?" },
  { who: "claude", text: "yes — the thread is durable now" },
];

test("happy path: logs in, posts the task with the conversation, returns the task", async () => {
  const cfg = cfgWith({ origin: "https://box.example.fly.dev", key: "sekret" });
  const box = fakeBox();
  const task = await sendToKanban(box.fetchImpl, cfg, "Ship the room", ENTRIES);
  assert.equal(task.id, "t_room1");
  const [login, create] = box.seen.requests;
  assert.equal(login.url, "https://box.example.fly.dev/session");
  assert.equal(login.opts.method, "POST");
  assert.equal(login.opts.headers.Origin, "https://box.example.fly.dev");
  assert.deepEqual(JSON.parse(login.opts.body), { key: "sekret" });
  assert.doesNotMatch(login.url, /sekret|\?key=/);
  assert.equal(login.opts.redirect, "manual");
  assert.equal(create.url, "https://box.example.fly.dev/board/task");
  assert.equal(create.opts.headers.Cookie, "agenthost_auth=cookievalue");
  const payload = JSON.parse(create.opts.body);
  assert.equal(payload.title, "Ship the room");
  assert.ok(payload.body.includes("STEVE: should we ship the room?"));
  assert.ok(payload.body.includes("CLAUDE: yes"));
});

test("failures explain themselves: no box, no key, bad login, box error", async () => {
  const box = fakeBox();
  await assert.rejects(
    () => sendToKanban(box.fetchImpl, cfgWith({ key: "k" }), "t", []),
    /no box named/);
  await assert.rejects(
    () => sendToKanban(box.fetchImpl, cfgWith({ origin: "https://b.fly.dev" }), "t", []),
    /no box access key/);
  const denied = fakeBox({ grantCookie: false });
  await assert.rejects(
    () => sendToKanban(denied.fetchImpl, cfgWith({ origin: "https://b.fly.dev", key: "wrong" }), "t", []),
    /box login failed/);
  const boom = fakeBox({ createStatus: 400, createBody: { error: "title cannot start with a dash" } });
  await assert.rejects(
    () => sendToKanban(boom.fetchImpl, cfgWith({ origin: "https://b.fly.dev", key: "k" }), "-t", []),
    /title cannot start with a dash/);
});

test("a box.json written by PowerShell (UTF-8 BOM) still parses", async () => {
  // Steve's real file has a BOM — PowerShell's Set-Content/Out-File write one
  // by default, and JSON.parse rejects it. Before the strip, a correct-looking
  // box.json read as "no box named".
  const cfg = cfgWith({ origin: "https://box.example.fly.dev", key: "sekret", bom: true });
  const box = fakeBox();
  const task = await sendToKanban(box.fetchImpl, cfg, "BOM task", ENTRIES);
  assert.equal(task.id, "t_room1");
});

test("an http origin is refused (the call carries an authenticated session)", async () => {
  const cfg = cfgWith({ origin: "http://plaintext.example", key: "k" });
  const box = fakeBox();
  await assert.rejects(() => sendToKanban(box.fetchImpl, cfg, "t", []), /no box named/);
});

test("threadTail stays inside the box's 8000-char body cap", () => {
  const entries = Array.from({ length: 30 }, (_, i) => ({ who: "claude", text: ("long ".repeat(200)) + i }));
  const tail = threadTail(entries);
  assert.ok(tail.length <= 8000);
  assert.ok(tail.includes("desktop Agent Room"));
});
