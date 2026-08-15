---
name: gtmvp-aeo-push
description: "GTMVP's AEO/GEO push (started 2026-06-02): get GTMVP cited by AI answer engines for paid-media buyer queries. Baseline 0/10. First assets live; off-site kit + page roadmap in flight."
metadata:
  node_type: memory
  type: project
  review_after: 2026-06-03
  originSessionId: aaee7e7b-c384-4bac-bcc8-501c0ebf9bc7
---

Goal: get GTMVP cited by ChatGPT/Claude/Perplexity/Gemini for paid-media buyer queries (Google Ads audit, fix rising CPA, done-for-you Google Ads, fractional CMO vs agency).

**Baseline (fresh, 2026-06-02, replaces the stale 2026-05 audit which was for the retired "GTM strategy / competitive intelligence" positioning):** GTMVP cited **0 / 10** buyer-intent queries. GrowthSpree owns ~5/10 (publishes original data + ranks its own blog); SaaS Hero (saashero.net) is the #1 SOURCE domain LLMs pull from. Full baseline + ranked source list: `GTMVP_V0/docs/seo/aeo-audit-2026-06.md` + `Downloads\gtmvp-aeo\aeo-baseline.md`.

**Key finding:** GTMVP's on-site is ALREADY heavily AEO-built (full Org/Software/Service JSON-LD in app/layout.tsx with the current paid-media entity sentence, 8 vs-* pages, gtm-strategy cluster, state-of-b2b-gtm report, clean sitemap). robots.ts is a DELIBERATE allow-citation/block-training policy — do NOT "fix" it. The real lever is OFF-SITE (listicles/G2/Reddit) + publishing GTMVP's own data assets.

**Shipped LIVE 2026-06-02 (verified Vercel prod READY):**
- llms.txt (PR #259) -> gtmvp.com/llms.txt
- Self-listicle "12 Best B2B SaaS Google Ads Agencies + Audit Tools 2026" (PR #260) -> gtmvp.com/blog/best-b2b-saas-google-ads-agencies-2026. GTMVP honestly at #4; all competitor numbers live-verified; data/blogs.json entry id "13". FAQ is in-body; dedicated FAQPage schema is a FAST-FOLLOW (do when building /lower-cac HowTo schema).

**Drafted, in `Downloads\gtmvp-aeo\` (QA'd, honesty-gated):**
- `off-site-kit.md` — STEVE'S to execute: directory claims (Capterra FIRST -> syndicates GetApp+Software Advice; then G2, Clutch, Product Hunt, Crunchbase, all PPC/Google-Ads categories), 3 editor pitches (SaaS Hero data pitch, B2B Playbook podcast, technology.org), 10 Reddit answers (2 recommend competitors, no GTMVP mention = trust). One [FLAG]: a fractional-CMO price source if Steve wants a hard number.
- `wasted-spend-report.md` — B, ready to ship (circulating benchmarks + Steve's track record; no invented stats).
- `page-gaps.md` — 8 prioritized pages. Tier-1: /google-ads-management-for-b2b-saas (Service+FAQ), /lower-cac-google-ads (Article+HowTo), /google-ads-audit-checklist (HowTo+FAQ).

**Tomorrow (2026-06-03, cron `gtmvp-aeo-tomorrow` + GCal 9am ET set):** Claude builds /lower-cac-google-ads (HowTo schema) + adds the FAQPage schema mechanism; Steve runs the off-site kit.

Honesty rules: only approved proof numbers ($50M+, 3.2x lifetime avg, 10:1 sustained, 47 Diagnostics/NPS 71, 20% action-gated guarantee); every non-GTMVP stat needs a named public source; no em-dashes. Related: [[gtmvp_repo_canonical_paths]] · [[reference_proof_roas]] · [[feedback_full_urls]].
