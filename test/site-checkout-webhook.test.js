// If the box is unreachable, Vercel sends Steve a backup purchase alert.
// Stripe may retry the webhook, so that fallback must use one stable provider
// key per checkout session too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { Readable } from "node:stream";
import handler from "../site/api/checkout-webhook.js";

function signedRequest(raw, secret) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", secret).update(timestamp + "." + raw).digest("hex");
  const req = Readable.from([Buffer.from(raw)]);
  req.method = "POST";
  req.headers = { "stripe-signature": `t=${timestamp},v1=${signature}` };
  return req;
}

function responseRecorder() {
  return {
    statusCode: 0,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test("Vercel fallback alert reuses one email idempotency key per Stripe session", async () => {
  const previous = {
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
    CHECKOUT_WEBHOOK_SECRET: process.env.CHECKOUT_WEBHOOK_SECRET,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    BOX_MAIL_URL: process.env.BOX_MAIL_URL,
    fetch: globalThis.fetch,
  };
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  process.env.CHECKOUT_WEBHOOK_SECRET = "checkout_test";
  process.env.RESEND_API_KEY = "resend_test";
  process.env.BOX_MAIL_URL = "https://box.example";

  const providerRequests = [];
  globalThis.fetch = async (url, request) => {
    if (String(url).endsWith("/checkout/complete")) return { ok: false, status: 503 };
    providerRequests.push({ url, request });
    return { ok: true, status: 200 };
  };

  try {
    const raw = JSON.stringify({
      type: "checkout.session.completed",
      data: { object: {
        id: "cs_test_stable",
        amount_total: 49900,
        payment_link: "plink_1Tuab4RrVb92Q7hgj9idHVAd",
        customer_details: { email: "buyer@example.com" },
      } },
    });
    for (let i = 0; i < 2; i++) {
      const res = responseRecorder();
      await handler(signedRequest(raw, process.env.STRIPE_WEBHOOK_SECRET), res);
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.body, { ok: true, delivery: "fallback" });
    }
    assert.equal(providerRequests.length, 2);
    const firstKey = providerRequests[0].request.headers["Idempotency-Key"];
    assert.equal(providerRequests[1].request.headers["Idempotency-Key"], firstKey);
    assert.match(firstKey, /^agenthost-checkout-fallback-[a-f0-9]{32}$/);
    assert.ok(!firstKey.includes("buyer@example.com"));
  } finally {
    globalThis.fetch = previous.fetch;
    for (const [name, value] of Object.entries(previous)) {
      if (name === "fetch") continue;
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

// Foreign-brand checkouts on the shared Stripe account (or app-created
// sessions with no payment link) must be acked and NEVER relayed to the box:
// on 2026-07-26 a ClaudeSkillsHQ $49 subscription triggered an AgentHost
// buyer-welcome email and a false operator order alert through this endpoint.
// The legacy flat $499 link, by contrast, is a REAL AgentHost purchase path
// (unlinked overflow, kept deliberately) and must still relay.
test("foreign checkouts are ignored; all three real AgentHost links still relay", async () => {
  const previous = {
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
    CHECKOUT_WEBHOOK_SECRET: process.env.CHECKOUT_WEBHOOK_SECRET,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    BOX_MAIL_URL: process.env.BOX_MAIL_URL,
    fetch: globalThis.fetch,
  };
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  process.env.CHECKOUT_WEBHOOK_SECRET = "checkout_test";
  process.env.RESEND_API_KEY = "resend_test";
  process.env.BOX_MAIL_URL = "https://box.example";

  let boxCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/checkout/complete")) { boxCalls++; return { ok: true, status: 200, json: async () => ({}) }; }
    return { ok: true, status: 200 };
  };

  const send = async (sessionOverrides) => {
    const raw = JSON.stringify({
      type: "checkout.session.completed",
      data: { object: {
        id: "cs_test_" + Math.random().toString(36).slice(2, 10),
        amount_total: 49900,
        customer_details: { email: "buyer@example.com" },
        ...sessionOverrides,
      } },
    });
    const res = responseRecorder();
    await handler(signedRequest(raw, process.env.STRIPE_WEBHOOK_SECRET), res);
    return res;
  };

  try {
    // Foreign: an app-created subscription session has NO payment_link.
    let res = await send({ payment_link: undefined, amount_total: 4900 });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true, delivery: "foreign_product" });
    // Foreign: another brand's payment link.
    res = await send({ payment_link: "plink_notOneOfOursAtAll000000" });
    assert.deepEqual(res.body, { ok: true, delivery: "foreign_product" });
    assert.equal(boxCalls, 0, "a foreign checkout must never reach the box");
    // Real: coupon link, legacy flat link, operator link all relay.
    for (const plink of [
      "plink_1Tuab4RrVb92Q7hgj9idHVAd",
      "plink_1TuMWgRrVb92Q7hg8EzmNWYZ",
      "plink_1TrRloRrVb92Q7hgvdSsxWUz",
    ]) {
      const before = boxCalls;
      res = await send({ payment_link: plink });
      assert.equal(res.statusCode, 200);
      assert.notDeepEqual(res.body, { ok: true, delivery: "foreign_product" },
        plink + " is a real AgentHost link and must not be treated as foreign");
      assert.equal(boxCalls, before + 1, plink + " must relay to the box");
    }
    // Regression lock: the constants must be plink object ids, never URL slugs
    // (the slug form never matches a real webhook payload).
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("../site/api/checkout-webhook.js", import.meta.url), "utf8");
    assert.ok(!/LINK_ID = "(?!plink_)/.test(src), "every recognized link constant must be a plink_ object id");
  } finally {
    globalThis.fetch = previous.fetch;
    for (const [name, value] of Object.entries(previous)) {
      if (name === "fetch") continue;
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
