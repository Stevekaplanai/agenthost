---
name: steve-newsletter-venture
description: "The Vibe Stack — SaaSpocalypse teardown venture (newsletter + Skool + weekly open-source rebuilds); Postiz workflow, CTA rules, key locations"
metadata: 
  node_type: memory
  type: project
  originSessionId: 5782ab63-de6a-4a2a-a832-54a5809ba826
---

# The Vibe Stack — newsletter venture

**The play (from `C:\Users\User\Projects\the-vibe-stack\30-DAY-PLAN.md`):** one named-tool SaaSpocalypse teardown per week, hero = the dollar number. Open-source repo is the proof, newsletter is the story, X + LinkedIn are the feeders. Social → newsletter → Skool (only place money lives) → $2,500 Build With Me.

- **Newsletter site:** https://thevibestacknews.com (Next.js + beehiiv custom domain)
- **Community:** https://www.skool.com/thevibestack
- **Project root:** `C:\Users\User\Projects\the-vibe-stack\` (plans, specs, scripts, content bank)
- **Week 1:** Statuspage/StatusBrew ($16K) · **Week 2:** PandaDoc ($20K, ProposalForge — github.com/Stevekaplanai/proposalforge) · **Week 3 (loaded):** Crayon ($60K)

## CTA rule (as of 2026-07-05, refined 2026-07-05)

**"Stack Forge" is a reserved future paid-tier name, NOT dead branding.** Two different things, don't conflate them:
- **Live/social/CTA copy (free tier, right now):** name-agnostic. *"The teardown is free. Build it with me -> skool.com/thevibestack"*. Never say "Stack Forge" in anything public — newsletters, X, LinkedIn, Skool lesson bodies, carousels, video scripts. Ran a full sweep 2026-07-05 across ~55 content files removing stray "Stack Forge" mentions that had leaked into live copy.
- **Strategy docs (internal, locked decision):** "Stack Forge" IS the reserved name for the community once it flips to paid — this supersedes an earlier 2026-06-24 "keep it name-agnostic forever" note in `product-architecture.md`. Locked in `HANDOFF.md`, `product-architecture.md`, `creative-direction/creative-direction-master.md`, `AI-AUTOMATION-BRIDGE.md`. Kit tags/snippet names (`forge-warm`, `cta-stack-forge`, etc. in `templates/kit-tags-setup.md` and `templates/manual-action-checklist.md`) also keep the "forge" naming — those are live technical wiring, not copy.
- **Bottom line:** when the paywall flips, the paid tier gets called "Stack Forge." Until then, every public-facing word says "the community" or nothing. If a future content pass needs the community name in copy, ask which mode (free-tier vs. paid-tier announcement) before choosing.

Note: social copy links to Skool + GitHub directly, NOT thevibestacknews.com (X punishes external links; the newsletter is routed via the repo README + site).

## Postiz workflow

- API key: `C:\Users\User\Projects\the-vibe-stack\.postiz.env` (line `POSTIZ_API_KEY=...`). Load with: `export POSTIZ_API_KEY=$(grep '^POSTIZ_API_KEY=' .postiz.env | cut -d= -f2- | tr -d '\r')`
- **Gotcha:** the `postiz` CLI prefers stored OAuth creds (`C:\Users\User\.postiz\credentials.json`) over the env var. If you get `401 Invalid OAuth token`, run `postiz auth:logout` first — the API key then works.
- Flip draft↔scheduled: `postiz posts:status <id> --status schedule` (scheduled state shows as `QUEUE`).
- Weekly specs + helper scripts: `C:\Users\User\Projects\the-vibe-stack\scripts\` (`postiz.mjs`, `postiz-week*-spec.json`, `postiz-week2-media.mjs` uploads media via `POST /upload-from-url`).
- Channels: X = `cm43474d6000d61zsf26olh3v` ("Steve Kaplan AI"), LinkedIn personal = `cm433m5e5000361zszjorqczr` ("Steve Kaplan").

## Skool lessons — weekly copy-paste system (set up 2026-07-05)

Each week's teardown has a matching 7-lesson Skool course. Paste-ready files (TITLE + BODY blocks per lesson, formatted for Skool's editor): `C:\Users\User\Projects\the-vibe-stack\content-bank\lessons\_paste-ready\<tool>.md`. Week mapping in `content-bank\CALENDAR.md` (Wk1 StatusBrew, Wk2 PandaDoc/proposalforge, Wk3 Crayon/competewatcher, Wk4 Vanta/soc2-dashboard). Paste walkthrough: `skool-classroom-PASTE-GUIDE.md` (project root). **Recurring automation:** scheduled task `skool-stack-forge-cta-check` (Mondays 9am) delivers the current week's file to Steve + checks it for "Stack Forge"; matching weekly Monday all-day Google Calendar event exists. Steve pastes by hand — Skool is login-gated.

## Status 2026-07-05

Week-2 PandaDoc campaign (15 posts, Jul 6–11: 9 X incl. 9-tweet flagship thread Tue 9:30am ET, 5 LinkedIn, 1 8-slide carousel Tue 9:40am, 2 hook videos on the Tue 11:00/11:07am X posts) reviewed and flipped DRAFT → scheduled. Open item: 7 StatusBrew lessons in Skool still show old "Stack Forge" CTA — Steve to fix by hand (nudge folded into the Monday scheduled task + calendar event Mon Jul 6).
