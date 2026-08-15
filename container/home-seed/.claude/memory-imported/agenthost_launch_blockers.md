---
name: agenthost-launch-blockers
description: "AgentHost launch blocker status as of 2026-07-18 — email DNS DONE+verified, self-hosted mail engine SHIPPED on the box (Kit killed), Day 0 delivery proven live, Pixel+CAPI reminder set for 2026-07-25"
metadata: 
  node_type: memory
  type: project
  originSessionId: a7596ecb-6d4b-4391-be7e-2eec861cee32
---

AgentHost launch blocker status (2026-07-18):

- **Email sending domain: DONE.** `mail.agenthost.space` created in Resend (domain id `71bf544a-1ea0-44fb-a74f-628703bdf5fd`, us-east-1) and fully VERIFIED (DKIM + SPF TXT + SPF MX all green). DNS lives on Namecheap (registrar-servers NS). Gotchas learned: (1) the namecheap MCP's `add_dns_record` silently loses MX records — Namecheap requires `EmailType=MX` on setHosts, which the MCP doesn't send; fix is a direct API setHosts call with the full record list + EmailType=MX (creds at `C:\Users\User\.namecheap-mcp\config.properties`). (2) `list_domains` pagination didn't show agenthost.space but `get_dns_hosts` works on it directly. (3) Sequential add_dns_record calls can race their own read-modify-write — verify with get_dns_hosts after each write. DMARC `_dmarc.mail` = `v=DMARC1; p=none;` (monitoring mode; tighten to quarantine later). Resend key used: `RESEND_API_KEY` in `C:\Users\User\Projects\stevekaplanai-site\.env.local`.
- **Pixel + CAPI: deferred to 2026-07-25 per Steve.** Dual-channel reminders set: scheduled task `agenthost-pixel-capi-reminder` (fires 2026-07-25 09:30 ET) + Google Calendar event `kc54agmf8v947vs8qr557rfblc` on steve@stevekaplan.ai. Blocks Andromeda Meta campaign activation.
- **ESP: RESOLVED — self-hosted "mini-Kit" SHIPPED 2026-07-18 (Steve: "build our own mini version of Kit").** The list + 10-send sequence live ON THE BOX: `container/mail-lib.js` (store + forward-only dueStep math), `container/mail-emails.js` (all 10 sends from EMAIL-PLAN), gate routes `/mail/subscribe` `/mail/unsub` `/mail/pending` (X-Mail-Secret, pre-auth) + `/mail/stats` (cookie), daily tick ≥13:00 UTC (bounce-poll-before-send, per-mutation fresh load→save, per-send persistence, in-flight guard). Vercel relays: `site/api/subscribe.js` (MV verify → box; hashed-only logging) + `site/api/unsubscribe.js` (RFC 8058 one-click). An 18-agent adversarial review confirmed 15 issues; ALL fixed pre-deploy. **E2E proven live**: steve@stevekaplan.ai subscribed through the deployed box → Day 0 delivered from steve@mail.agenthost.space (Resend `last_event: delivered`). Steve is subscriber #1 and will receive the full drip (dogfood). NOTE: Supabase was rejected ($10/mo/project on his org); Kit's MCP IS writeable (Vibe Stack acct, 1k cap) but unused.
- **Secrets wiring:** `MAIL_WEBHOOK_SECRET` — desktop copy at `C:\Users\User\.agenthost\mail-webhook.secret`, Fly secret on agenthost-steve, Vercel env (project gtmvp/agenthost) alongside `MILLIONVERIFIER_API_KEY` (both set via CLI 2026-07-18; Steve owes NO env-var setup anymore). Box secrets file has `FOUNDING_SLOTS_TAKEN=0` (true; update via 🔑 as boxes sell — Day 22 HOLDS if it's ever missing). `RESEND_API_KEY` also a Fly secret.
- **Known gap until the site deploys** (still gated on npm v0.5.0 publish): the unsubscribe link + capture page live on agenthost.space and 404 until that deploy. The box side is fully live.
- Remaining Steve-side blockers: Founding Operator price, Meta Pixel/CAPI (7/25), npm v0.5.0 publish → site deploy.

Related: [[ark_ai_verifier_decision]], [[agenthost_v2_autonomy_security_gate]], [[agenthost_site_revamp_gated]]
