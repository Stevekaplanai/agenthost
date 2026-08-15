// The real inbound nurture route must persist its provider request before it
// acknowledges the relay. With no Resend key, the request stays in the outbox;
// that makes the persistence boundary observable without sending real email.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { stopChild } from "./child-process-helper.js";
import os from "node:os";

const GATE = path.join(import.meta.dirname, "..", "container", "gate.js");
const SECRET = "mail-outbox-test-secret";
let box = {};

before(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gatemailoutbox-"));
  const child = spawn("node", [GATE], {
    env: {
      ...process.env,
      HOME: home,
      TTYD_PASSWORD: "gate-mail-outbox-test-key",
      AGENT_CHAT_BIN: "/bin/true",
      GATE_PORT: "0",
      MAIL_WEBHOOK_SECRET: SECRET,
      // Blank the live mail key explicitly: the spread above copies the parent
      // environment, and on the box that includes a real RESEND_API_KEY. Same
      // class of leak that mailed Steve fake purchase alerts on 2026-08-02 from
      // gate-checkout-webhook.test.js. A test must never be able to send.
      RESEND_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const port = await new Promise((resolve, reject) => {
    let out = "";
    const timeout = setTimeout(() => reject(new Error("gate did not report its port; got: " + out)), 5000);
    child.stdout.on("data", (chunk) => {
      out += chunk.toString();
      const match = out.match(/listening on (\d+)/);
      if (match) { clearTimeout(timeout); resolve(Number(match[1])); }
    });
    child.on("exit", () => { clearTimeout(timeout); reject(new Error("gate exited before listening; got: " + out)); });
  });
  box = { home, child, base: `http://127.0.0.1:${port}` };
});

after(async () => {
  await stopChild(box.child);
  if (box.home) fs.rmSync(box.home, { recursive: true, force: true });
});

function post(pathname, body = {}) {
  return fetch(box.base + pathname, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Mail-Secret": SECRET },
    body: JSON.stringify(body),
  });
}

function store() {
  return JSON.parse(fs.readFileSync(path.join(box.home, ".agenthost", "mail", "store.json"), "utf8"));
}

test("subscribe acknowledges only after Day 0 is durable and deduplicated", async () => {
  const body = {
    email: "Reader@Example.com",
    runs: "daily",
    team: "solo",
    mv_status: "ok",
    mv_verified_at: "2026-07-21T00:00:00.000Z",
  };
  const first = await post("/mail/subscribe", body);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { ok: true, created: true });

  const firstStore = store();
  assert.equal(Object.keys(firstStore.outbox).length, 1);
  const delivery = Object.values(firstStore.outbox)[0];
  assert.equal(delivery.kind, "nurture");
  assert.equal(delivery.step, 0);
  assert.equal(delivery.status, "pending");
  assert.equal(delivery.attempts, 0, "no provider key means no external attempt occurred");

  const replay = await post("/mail/subscribe", body);
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), { ok: true, created: false });
  assert.equal(Object.keys(store().outbox).length, 1);
});

test("unsubscribe removes an unsent nurture request from recovery", async () => {
  const token = store().subscribers["reader@example.com"].unsub_token;
  const response = await post("/mail/unsub?t=" + token);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  const afterUnsub = store();
  assert.equal(afterUnsub.subscribers["reader@example.com"].unsubscribed_at !== null, true);
  assert.equal(Object.keys(afterUnsub.outbox).length, 0);
});
