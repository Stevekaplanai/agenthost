---
name: zxq Upwork Lead-Gen Dashboard
description: Autonomous Upwork-prospecting system — scrape, enrich, email, LinkedIn-DM. Live at zxq.stevekaplan.ai.
type: project
originSessionId: f66c7dbc-5164-4165-a397-3c899bd5aa67
---
## What it is

A fully autonomous outreach pipeline replacing Steve's blocked Upwork applications:
**Apify scrapes Upwork → Claude Haiku extracts companies → Apollo enriches contacts → Gmail API sends email + Chrome extension drains LinkedIn queue → 3-touch follow-up sequences → reply detection.**

## Key locations

- **Repo**: `C:\Users\User\Projects\zxq-dashboard` · github.com/Stevekaplanai/zxq-dashboard (private)
- **Live URL**: `https://zxq-dashboard.vercel.app` (will be `zxq.stevekaplan.ai` once Namecheap CNAME lands)
- **Pipeline scripts**: `C:\Users\User\Projects\upwork-scraper-data\` (Python helpers + state queries — pipeline itself is now Vercel-cron only)
- **Chrome extension**: `C:\Users\User\Projects\zxq-dashboard\extension\`

## Stack

- Next.js 16 (proxy.ts not middleware.ts, async searchParams) · React 19 · TypeScript · Tailwind 4
- Neon Postgres via Drizzle ORM (project: `neon-aureolin-lantern` on Vercel Marketplace)
- Vercel Pro · 6 cron entries in `vercel.json` (pipeline, autopilot, check-replies, process-sequences)
- Anthropic Haiku 4.5 (drafts) · Apollo Pro (enrichment) · Gmail API OAuth (sends)
- Apify Starter `$50/mo` cap → 2 scrapes/day max

## Cron architecture (all UTC in vercel.json)

```
0 7,13 ET   = 11,17 UTC      Apify scrape
:10 same    = 11:10/17:10    Vercel /api/cron/pipeline
:40 same    = 11:40/17:40    Vercel /api/cron/autopilot — sends email + queues LinkedIn
*/15        = every 15 min   /api/cron/check-replies (Gmail thread polling)
0 * * * *   = hourly         /api/cron/process-sequences (day +4 / +9 follow-ups)
```

## Auth/security model

- **Vercel SSO disabled** — was blocking crons (307-redirect to /login). Removed via Vercel API.
- **App-level password gate** in `proxy.ts` for the dashboard UI (cookie-based; password in Vercel `DASHBOARD_PASSWORD`).
- **Cron auth** via `CRON_SECRET` Bearer header (matches `process.env.CRON_SECRET`).
- **Extension auth** via `LINKEDIN_EXT_TOKEN` Bearer header. Same value lives in Vercel env AND extension Options page.
- **Bypass list in `proxy.ts`**: `/api/cron/*`, `/api/gmail/*`, `/api/linkedin/*`, `/login`, `/api/login`, static.

## Daily cap math

- `AUTOPILOT_PER_RUN_CAP=9` × 2 fires/day = **18 initial sends/day max** (`AUTOPILOT_DAILY_CAP=18`)
- Each initial send queues 2 follow-ups → steady-state ~36-50 emails/day total
- LinkedIn queued at same cadence; extension's local cap defends-in-depth

## Quality gates (autopilot)

- `AUTOPILOT_MIN_FIT_SCORE=14` (Steve-fit keyword score)
- `AUTOPILOT_MIN_CLIENT_SPEND=10000` ($10K+ Upwork client total spend)
- `AUTOPILOT_MIN_CLIENT_FEEDBACK=4` (4.0★+)
- `AUTOPILOT_LOOKBACK_DAYS=2` (consider yesterday's enriched leads too)
- 30-day email + LinkedIn-URL dedup

## Dashboard views

- **Actionable** (default) — has email or LinkedIn, status new/viewed
- **Sent** — status contacted/replied/won
- **Dead** — status=dead OR no contactable details
- **All** — no filter

## Background routine

`trig_01NVU2w6A7mWayJdufnEoKD6` — one-time run scheduled (was for May 5, may have fired or expired). Designed to commit a `docs/autopilot-review-YYYY-MM-DD.md` PR after 48hr of activity.

## How to apply when Steve asks about this project

- Don't reinvent — the pipeline + autopilot + sequences + Chrome extension already cover the full loop
- For new ICP rules, change the system prompt in `app/api/cron/autopilot/route.ts` + `app/api/draft/route.ts` (both must stay in sync)
- For volume changes: env vars, not code (AUTOPILOT_DAILY_CAP, _PER_RUN_CAP, _MIN_FIT_SCORE)
- For LinkedIn issues: check `extension/content.js` selectors first — LinkedIn DOM shifts occasionally
- Don't auto-promote outreach status to "viewed" or "contacted" until an actual send fires (caused a real bug — see feedback_outreach_status_bug.md if it was saved)
