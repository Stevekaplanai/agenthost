---
name: stemcellsnow-launch-ready
description: Stem Cell Readiness full GTM package built and site deployed; July 1 launch with 7 people-side blockers remaining
metadata: 
  node_type: memory
  type: project
  review_after: 2026-06-27
  originSessionId: 0f4c5c2a-bdb6-4657-b268-c38f04fb6689
---

Stem Cell Readiness (the marketing arm for stemcellsnow.com / Dr. James Padula) — full go-to-market package BUILT 2026-06-11. See [[stemcellsnow_renova_deal]] for the deal background ("Stem Cell Readiness" is the finalized brand, NOT "Renova").

**What's done and where:** `C:\Users\User\Projects\stemcellsnow\`
- `site/` — 5-page site (homepage + knee/hip/shoulder/spine), "warm kitchen-table" design for the 68-78 audience (Fraunces + Source Sans 3, OKLCH palette, large type). **Deployed to https://stemcellreadiness.vercel.app** (Vercel team `gtmvp`, project `stemcellreadiness`). Update with `vercel deploy --yes` from the site folder. Old futuristic version preserved at `site/index-bioluminescence.html`.
- `assets/` — 14 images + 8 videos via Higgsfield/Fal, all QA'd. See `ASSET_MANIFEST.md`.
- `marketing/` — 7 GTM docs: 01-google-ads, 02-meta-ads, 03-email-nurture (7 emails), 04-tracking-setup, 05-youtube-scripts, 06-operations-playbook, 07-launch-checklist, + README.

**7 people-side blockers before July 1 launch** (from `marketing/07-launch-checklist.md`):
1. Real domain + DNS, swap Final URLs off the vercel.app preview
2. Replace AI-generated Dr. Padula imagery with real photos OR documented consent (depicts a real named physician — legal + trust)
3. Real pricing into cost sections (site currently says "a fraction")
4. Wire booking form to real intake (currently mailto to bookings@stemcellreadiness.com)
5. SPF/DKIM/DMARC on sending domain before any nurture email
6. Install GTM + the `generate_lead` dataLayer push (deck 04), verify a test lead BEFORE any ad spend
7. Replace the "23 patients declined last month" stat with the real verified number (falsifiable claim)

**Why:** high-scrutiny medical category. Strategy is honesty: no outcome promises, no fabricated testimonials, "$0 if you're not a candidate" + refusal discipline + PRP-vs-MSC (1-5x vs 10-50x) are the three load-bearing messages. Google/Meta both restrict stem-cell ads, so all ad copy leads with "free assessment / second opinion," never a cure claim.

**How to apply:** dual-channel reminder set for 2026-06-27 (cal event on steve@stevekaplan.ai + CronCreate, though cron flagged session-only so this memory is the durable backstop). When this surfaces, walk Steve through the blockers; ads are built from decks 01/02 but stay OFF until tracking verified.
