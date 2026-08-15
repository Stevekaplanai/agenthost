---
name: Stripe CLI gotchas (live mode, restricted keys, multi-product accounts)
description: Stripe CLI defaults to test mode; live ops need --live on every command, restricted keys often lack write perms, and shared accounts need filtering when investigating activity.
type: feedback
originSessionId: 14e8009d-5e07-4862-b669-4a2fa6208660
---
The Stripe CLI has several non-obvious behaviors that bite repeatedly when working with live mode or shared accounts. Steve has many products in one GTMVP account (`acct_1P9AaXRrVb92Q7hg`) so most of these come up often.

**Why:** Burned ~30 minutes on the 2026-04-25 Synap session debugging "no live webhook found" and "0% conversion rate" — both rooted in the gotchas below. The user explicitly noticed I should be using these tools more efficiently.

**How to apply:**

1. **Always pass `--live` on EVERY command for production work.** The flag is per-command, not session-wide. `webhook_endpoints retrieve <id>` without `--live` fails with:
   > `No such webhook endpoint: '<id>' — a similar object exists in live mode, but a test mode key was used to make this request.`
   When you see that error, the command is correct but missing `--live`.

2. **Restricted live keys (`rk_live_...`) often lack write permissions** for webhooks, products, prices. Symptom: `list` / `retrieve` work, but `create` / `update` / `delete` returns:
   > `The provided key '...' does not have the required permissions for this endpoint`
   Fix: Stripe Dashboard → Developers → API keys → edit restricted key → grant `Webhook Endpoints: Write`, `Products: Write`, etc. Or do the one-time op in the Dashboard UI.

3. **Updating a webhook URL via `webhook_endpoints update --url ...` does NOT rotate the signing secret.** Safe operation — environments holding `STRIPE_WEBHOOK_SECRET` keep working.

4. **Non-TTY interactive flows emit JSON, not prompts.** `stripe login` in a backgrounded process prints `{"browser_url": "...", "verification_code": "...", "next_step": "stripe login --complete <url>"}`. Tokens expire in minutes — pair fast or regenerate.

5. **Multi-product Stripe accounts:** `subscriptions list`, `customers list`, `checkout sessions list` return EVERYTHING across the account. For Steve's GTMVP account, that includes Synap + Student AI Detector + AI Homework Help + ClaudeSkillsHQ + ProductDescriptions + DocDoctor + PromptForge. To scope, filter by `success_url`/`cancel_url` substring or by metadata fields the specific product writes. Total session counts are NOT a single product's session count.

6. **`stripe trigger` is test-mode only** — there's no `--live` equivalent. To send real production-style events to a live webhook, use the Dashboard's "Send test webhook" button on the live endpoint.

7. **Stripe CLI shows test-mode keys in plaintext via `config --list`** but redacts live keys (`***`). Test-mode `sk_test_...` printed in transcripts has limited blast radius (no real money) but rotate from the Dashboard if you want extra paranoia.
