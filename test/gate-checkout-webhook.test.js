// POST /checkout/complete: the Founding 50 / Founding Operator purchase relay
// (Steve, 2026-07-19). agenthost.space's Vercel checkout-webhook.js verifies
// the Stripe signature, then relays here with X-Checkout-Secret so the box
// can send the buyer a welcome email and Steve a purchase alert. Same
// shared-secret pattern as /mail/subscribe (mailSecretOk); these tests boot
// the REAL gate and check the auth gate, the happy path, and that the secret
// never appears in a log line.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { stopChild } from "./child-process-helper.js";

const GATE = path.join(import.meta.dirname, "..", "container", "gate.js");
const SECRET = "checkout-test-secret";
let box = {};

function bootGate(home) {
  const child = spawn("node", [GATE], {
    env: {
      ...process.env,
      HOME: home,
      TTYD_PASSWORD: "gate-checkout-test-key",
      AGENT_CHAT_BIN: "/bin/true",
      GATE_PORT: "0",
      CHECKOUT_WEBHOOK_SECRET: SECRET,
      // RESEND_API_KEY blanked EXPLICITLY, never merely "left unset". The spread
      // above copies the parent environment, so on a machine that HAS a live key
      // -- the box does, entrypoint-launcher passes it through -- the child
      // inherited it and these fixtures sent REAL email. On 2026-08-02 that put
      // "New Founding 50 purchase: buyer@example.com" and "New AgentHost
      // purchase: mystery@example.com" in Steve's actual inbox, from the box's
      // own sender, for purchases that never happened. The temp HOME does isolate
      // the secrets file (HOME_DIR honours process.env.HOME) and the audit log,
      // but an outbound API call escapes the sandbox regardless -- and the
      // operator-alert recipient is hardcoded to a real address.
      // The route must still succeed here: no key -> both sends fail fast and
      // audit it, which is exactly what the assertions below check.
      RESEND_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const port = new Promise((resolve, reject) => {
    let out = "";
    const to = setTimeout(() => reject(new Error("gate did not report its port; got: " + out)), 5000);
    child.stdout.on("data", (c) => {
      out += c.toString();
      const m = out.match(/listening on (\d+)/);
      if (m) { clearTimeout(to); resolve(Number(m[1])); }
    });
    child.on("exit", () => { clearTimeout(to); reject(new Error("gate exited before listening; got: " + out)); });
  });
  return { child, port };
}

before(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gatecheckout-"));
  const { child, port } = bootGate(home);
  box.home = home;
  box.gate = child;
  box.base = `http://127.0.0.1:${await port}`;
});

after(async () => {
  await stopChild(box.gate);
  if (box.home) fs.rmSync(box.home, { recursive: true, force: true });
});

function post(pathname, body, headers) {
  return fetch(box.base + pathname, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function auditLines() {
  try {
    return fs.readFileSync(path.join(box.home, ".claude", "agenthost", "audit.log"), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function mailStore() {
  return JSON.parse(fs.readFileSync(path.join(box.home, ".agenthost", "mail", "store.json"), "utf8"));
}

test("POST /checkout/complete with no X-Checkout-Secret header -> 401", async () => {
  const r = await post("/checkout/complete", { email: "buyer@example.com", amount: 499 });
  assert.equal(r.status, 401);
});

test("POST /checkout/complete with a wrong secret -> 401", async () => {
  const r = await post("/checkout/complete", { email: "buyer@example.com", amount: 499 }, { "X-Checkout-Secret": "not-the-secret" });
  assert.equal(r.status, 401);
});

test("POST /checkout/complete with no email -> 400", async () => {
  const r = await post("/checkout/complete", { amount: 499 }, { "X-Checkout-Secret": SECRET });
  assert.equal(r.status, 400);
});

test("POST /checkout/complete with no Stripe session id -> 400", async () => {
  const r = await post("/checkout/complete", { email: "buyer@example.com", amount: 499 }, { "X-Checkout-Secret": SECRET });
  assert.equal(r.status, 400);
});

test("POST /checkout/complete with a valid secret -> 200, records checkout_completed, never logs the secret", async () => {
  const r = await post(
    "/checkout/complete",
    { email: "Buyer@Example.com", amount: 499, product: "founding-50", stripeSessionId: "cs_test_123", purchasedAt: "2026-07-19T00:00:00.000Z" },
    { "X-Checkout-Secret": SECRET }
  );
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(data.ok, true);

  // The box acknowledges only after BOTH consequence-bearing messages are in
  // its durable outbox. Replaying the same Stripe session reuses those exact
  // records instead of creating another buyer email or operator alert.
  const firstStore = mailStore();
  assert.equal(Object.keys(firstStore.outbox).length, 2);
  assert.deepEqual(new Set(Object.values(firstStore.outbox).map((delivery) => delivery.action)), new Set(["buyer-welcome", "operator-alert"]));
  const frozenPayloads = Object.fromEntries(Object.values(firstStore.outbox).map((delivery) => [delivery.id, JSON.stringify(delivery.payload)]));
  const replay = await post(
    "/checkout/complete",
    { email: "Buyer@Example.com", amount: 499, product: "founding-50", stripeSessionId: "cs_test_123", purchasedAt: "2099-01-01T00:00:00.000Z" },
    { "X-Checkout-Secret": SECRET }
  );
  assert.equal(replay.status, 200);
  const replayStore = mailStore();
  assert.equal(Object.keys(replayStore.outbox).length, 2);
  for (const delivery of Object.values(replayStore.outbox)) assert.equal(JSON.stringify(delivery.payload), frozenPayloads[delivery.id]);

  // Give the fire-and-forget email sends (which will fail fast -- no
  // RESEND_API_KEY -- and audit that failure) a beat to land.
  await new Promise((resolve) => setTimeout(resolve, 100));

  const lines = auditLines();
  const completed = lines.find((l) => l.event === "checkout_completed");
  assert.ok(completed, "checkout_completed was audited");
  assert.match(completed.detail, /buyer@example\.com \$499/);

  // The secret must never appear in any audit line.
  const raw = JSON.stringify(lines);
  assert.ok(!raw.includes(SECRET), "the checkout secret never appears in the audit log");

  // No RESEND_API_KEY -> both sends fail fast and audit it, but the route
  // itself already returned 200 above (never blocks on Resend).
  const mailFails = lines.filter((l) => l.event === "checkout_mail_fail");
  assert.ok(mailFails.length >= 1, "missing RESEND_API_KEY is audited, not thrown");
});

test("operator alert subject names the ACTUAL product: founding-operator -> 'New Founding Operator purchase'", async () => {
  const r = await post(
    "/checkout/complete",
    { email: "op-buyer@example.com", amount: 1999, product: "founding-operator", stripeSessionId: "cs_test_op_1", purchasedAt: "2026-07-26T00:00:00.000Z" },
    { "X-Checkout-Secret": SECRET }
  );
  assert.equal(r.status, 200);
  const alerts = Object.values(mailStore().outbox).filter((d) => d.action === "operator-alert");
  assert.ok(
    alerts.some((d) => d.payload.subject === "New Founding Operator purchase: op-buyer@example.com"),
    "a founding-operator purchase must not be announced as a Founding 50 one; got subjects: " + alerts.map((d) => d.payload.subject).join(" | ")
  );
  // The buyer welcome is product-aware too: a founding-operator buyer must not
  // be welcomed to the Founding 50 (different offer, different price).
  const welcome = Object.values(mailStore().outbox).find(
    (d) => d.action === "buyer-welcome" && d.payload.to.includes("op-buyer@example.com")
  );
  assert.ok(welcome, "a buyer-welcome was queued for the founding-operator buyer");
  assert.equal(welcome.payload.subject, "You're in: AgentHost Founding Operator");
  assert.ok(!welcome.payload.text.includes("Founding 50"), "the operator welcome never mentions the Founding 50");
  assert.ok(welcome.payload.text.includes("$29/mo"), "the operator welcome names the $29/mo founding operator seat");
  assert.ok(welcome.payload.text.includes("https://agenthost.space/welcome"), "the operator welcome points at the setup page");
});

test("operator alert subject falls back to a neutral label when product is missing/unknown", async () => {
  const r = await post(
    "/checkout/complete",
    { email: "mystery@example.com", amount: 42, stripeSessionId: "cs_test_noproduct_1" },
    { "X-Checkout-Secret": SECRET }
  );
  assert.equal(r.status, 200);
  const alerts = Object.values(mailStore().outbox).filter((d) => d.action === "operator-alert");
  assert.ok(
    alerts.some((d) => d.payload.subject === "New AgentHost purchase: mystery@example.com"),
    "an unknown product should read 'New AgentHost purchase', never claim a specific tier"
  );
  // Buyer welcome for a missing/unknown product: neutral, tier-claim-free,
  // same setup pointer.
  const welcome = Object.values(mailStore().outbox).find(
    (d) => d.action === "buyer-welcome" && d.payload.to.includes("mystery@example.com")
  );
  assert.ok(welcome, "a buyer-welcome was queued for the unknown-product buyer");
  assert.equal(welcome.payload.subject, "You're in: AgentHost");
  assert.ok(!welcome.payload.text.includes("Founding"), "the neutral welcome claims no founding tier");
  assert.ok(welcome.payload.text.includes("https://agenthost.space/welcome"), "the neutral welcome points at the setup page");
});

test("GET /checkout/complete (wrong method) -> 404 (route only matches POST)", async () => {
  const r = await fetch(box.base + "/checkout/complete", { headers: { "X-Checkout-Secret": SECRET } });
  assert.equal(r.status, 404);
});
