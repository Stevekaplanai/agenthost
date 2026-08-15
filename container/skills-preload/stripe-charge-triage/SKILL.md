---
name: stripe-charge-triage
description: Verify-before-reacting triage for ANY surprising Stripe activity. Use when Steve says "who just paid", "unknown charge", "we mischarged someone", "someone got charged $X", "should I refund this", "did checkout break", "unexpected payment", "customer says they were charged wrong" — or any Stripe amount plus alarm. Pulls the live charge, maps it to the real product, checks it against advertised copy, checks DELIVERY, and only then recommends action. Never refund, never email, never panic before the pipeline completes.
---

# Stripe Charge Triage

> **PRIVATE — NEVER PUBLISH.** This skill names Steve's live Stripe account id,
> brands, and internal operational history. It stays on this machine. If a
> skills repo is ever assembled for publication, this file is excluded.
> (Its sibling `agent-fiscal-sovereignty` is the publishable one — no account
> internals, ideas-only treatment of the cited paper.)

One Stripe account (`acct_1P9AaXRrVb92Q7hg`, statement descriptor **GTMVP.COM**) sells for MANY products: AgentHost, ClaudeSkillsHQ, LegalSkillsHQ, AlphaFlow, GTMVP agency services, plus dormant side products (PromptForge, AI Homework Help, Student AI Detector, Synap…). **A dollar amount alone identifies nothing.** The founding incident (2026-07-26, launch eve): a $49 charge was assumed to be a mischarged AgentHost Founding 50 sale; twenty minutes of live-data triage showed a legitimate ClaudeSkillsHQ Starter $49/mo subscription at exactly the advertised price — and the REAL bug was elsewhere (fulfillment: the customer paid and got nothing).

## Hard facts (do not relitigate)

- **Amount ≠ product.** Identify by price ID, product name/description, subscription/customer metadata (`userId`, `tier`, `subscriptionType`), and `success_url` — never by the number.
- **Verified-legitimate ≠ delivered.** This account's history includes ~9 months of silently failed purchase emails and webhook fulfillment that returns 200 while granting nothing. After proving the charge is right, ALWAYS check what the customer actually received.
- **Every brand charges as GTMVP.COM** on card statements. A confused customer is often reacting to the descriptor, not the amount.
- **Stripe CLI defaults to test mode** (`--live` per command); restricted keys often can't read Checkout Sessions or write. Prefer the Stripe MCP tools (`stripe_api_search` → `stripe_api_details` → `stripe_api_read`).
- **Every claim in your report is tagged `verified` (you pulled the live object / fetched the live page) or `belief` (inference).** A claim about how the system behaves gets its verification alongside, or is labeled belief. (The launch-eve rule, verbatim.)

## The pipeline (each step gates the next)

1. **Pull the live money objects.** Charge → PaymentIntent → invoice/subscription (if recurring) → Customer. Capture: amount, livemode, description, metadata, billing email/phone, payment method, receipt fields.
   `Gate:` raw live objects in hand. Nothing from memory, nothing from the panic message.
2. **Map to the real product.** Resolve the price ID → product (name + description + metadata). If no catalog price matches, the session used ad-hoc `price_data` — find the creating app via metadata/`success_url` (Checkout Session reads may need the dashboard).
   `Gate:` product AND selling site named *from the data*.
3. **Check charged vs advertised.** Fetch that product's live pricing page and read its checkout code if on disk. Match amount, interval, and any coupon math end-to-end (list price − coupon = charged?).
   `Gate:` "charged matches advertised" or the discrepancy stated precisely (which surface says what).
4. **Classify:** `legitimate` / `mispriced` (site vs Stripe mismatch) / `tampered` (client-supplied price paths) / `duplicate` / `fraud-test` (Radar outcome, risk level). Tag every supporting claim verified/belief.
5. **Check delivery.** Did fulfillment actually run? Webhook handler outcome, `profiles.plan` (or the product's equivalent), `email_logs`, receipt sent. A legit charge with failed delivery is the more likely real emergency — fix delivery before drafting any apology.
   `Gate:` what the customer holds right now, stated from data.
6. **Report + act inside the gates.** Give Steve: what happened, who the customer is (email/phone), what they hold, what (if anything) is owed. **Refunds, customer emails, and price changes are consequences — they wait for Steve** unless he has explicitly pre-authorized in this session. Reversible config (enabling phone collection, fixing a redirect) may proceed under standing rules.

## Known failure modes (learned the expensive way)

- **2026-07-26 ($49 "mischarge"):** assumed AgentHost, was ClaudeSkillsHQ Starter at list price — but the customer's plan still read `free` (webhook only fulfilled team/enterprise). The panic was wrong AND the calm answer was incomplete: only step 5 found the real defect.
- **The $199 mystery (Jul 19):** ad-hoc `price_data`, no metadata, no receipt_email — unidentifiable from the catalog, and the customer never got their product (Resend bug). Anonymous ad-hoc charges are a dispute waiting; flag any checkout path that creates them.
- **Test-mode blindness:** a "missing" live charge that's actually a CLI defaulting to test mode.
- **"Customer complained" ≠ "customer was mischarged":** with GTMVP.COM on every statement and a history of silent email failures, the complaint is usually recognition or delivery, not price.

## When NOT to use

- Building or modifying checkout code (that's normal dev work — though its review should cite this skill's step 3/5 checks).
- Routine revenue reporting. This skill is for the *surprise* — the moment before someone reaches for the refund button.
