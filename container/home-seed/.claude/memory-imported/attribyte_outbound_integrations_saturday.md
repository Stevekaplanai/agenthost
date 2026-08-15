---
name: attribyte-outbound-integrations-saturday
description: "Deferred to Saturday 2026-06-06 (Steve): build AttriByte's OUTBOUND integrations — Slack, Google Sheets, Webhook. Calendar event set; in-session cron was session-only so this memory is the durable record."
metadata: 
  node_type: memory
  type: project
  review_after: 2026-06-06
  originSessionId: b3598747-8d24-4c0e-98d6-6806ee9d4c29
---

**Steve (2026-06-03) scheduled for Saturday 2026-06-06:** build AttriByte's three OUTBOUND integrations — **Slack** (attribution alerts/reports to a channel), **Google Sheets** (export attribution data rows), **Webhook** (POST events/reports to a customer URL).

- These are **OUTBOUND** (AttriByte SENDS data out) — NOT inbound read-source adapters. Different architecture: a destination/notifier concept. Slack + Google Sheets are Pipedream apps → use `pipedreamService.proxyFetch` to POST on the user's behalf (no custom OAuth client). Webhook = a direct signed POST to a customer URL.
- All three already exist in the integrations catalog (`apps/api/src/routes/integrations.ts` INTEGRATIONS: slack, google_sheets, webhook) with NO implementation.
- They were deferred from the inbound connector buildout (PRs #178–#183: proxy migration + 15 net-new adapters). See [[gtmvp_attribyte_handoff_capi_build]].
- **Dual-channel reminder (Cardinal Rule 1):** GCal event on steve@stevekaplan.ai 2026-06-06 9am ET (id 2gq0fljpm7qmq0v5qegsqngi50) = the reliable channel. The CronCreate fired session-only (durable not supported here), so THIS memory + the calendar are the durable record. If a session opens on/after 2026-06-06, build them (branch `claude/outbound-integrations-FS6Lj`, verify typecheck+vitest, PR to main for Steve's review — customer-facing).

Related: [[gtmvp_attribyte_handoff_capi_build]] · [[attribyte-tracking-integrations-elevar]]
