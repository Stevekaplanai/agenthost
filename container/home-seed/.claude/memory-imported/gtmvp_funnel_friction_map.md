---
name: gtmvp-funnel-friction-map
description: "GTMVP's 3 lead-magnet tiers ranked by friction — the free Leak Report needs OAuth (warm-only), the $129 audit needs no account access, the quiz needs nothing"
metadata: 
  node_type: memory
  type: project
  review_after: 2026-09-01
  originSessionId: e96f74e1-486f-4a9d-a109-d82b2daa4930
---

GTMVP has three lead-magnet tiers and they are **friction-inverted** for cold outreach. Mapped 2026-06-13 when Steve flagged the Leak Report can't be sent without the prospect's participation.

| Tier | URL | Requires | Friction | Right audience |
|---|---|---|---|---|
| **GTM Health Score** | `/gtm-health-score` | 12 quiz answers. No email, no account. | ZERO | COLD — the right cold lead magnet |
| **Leak Report** (free "Smart Bidding Report") | `/leak-report` | **OAuth connect Google Ads, read-only** (`SmartBiddingOnboarding` component) | HIGH | WARM only — nobody OAuths a stranger |
| **$129 GTM Audit** | `/audit` | Pay $129. **No account OAuth** — 8 agents run vs their public site/competitors/ad libraries, 40-pg brief in 24h | Money, not access | COLD-capable (the paid conversion) |

**The key insight:** the FREE thing (Leak Report) needs the MOST trust (account access), and the no-account-access thing ($129 audit) costs money. Classic funnel inversion. The cold path that actually works is **quiz → $129 audit** — neither needs OAuth. The Leak Report is a WARM second-touch tool, offered after someone engages (did the quiz, replied to a DM, booked a call), when "connect read-only, 60s, revoke anytime" is a reasonable ask.

**Consequence for outbound (the 660 Goji Berry contacts in campaign 19887):** the connect note promises a "free Leak Report" but that's the OAuth tier. The Step 2 DM deliberately bridges to the zero-friction quiz instead, and the account-level Leak Report is repositioned as a Step 3 / reply-triggered warm touch. DM drafts (with the warm second-touch copy) live at `C:\Users\User\gtmvp-leads\_goji_step2_dm_drafts.md`.

**/audit has NO Calendly by design** — its FAQ explicitly says "Not for the Diagnostic. Pay $129, no calls." Calendly lives on `/pricing`, homepage `DiscoveryCallReveal`, `/no-nonsense-audit/b`, and `AuditReportEditorial` (post-audit upsell to the $3,500-12K/mo Rebuild service). Do not add Calendly to /audit — it contradicts the self-serve positioning.

Related: [[gtmvp_attribyte_integration]], [[project_click_then_convert]]
