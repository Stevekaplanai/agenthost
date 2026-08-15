---
name: skai-product-launch-plus-white-paper
description: Full product-launch playbook anchored on a cited, newsjacked whitepaper lead magnet — research fan-out (Hormozi frameworks, current events, scholarship prior-art, LIVE Meta Ad Library competitor check), branded PDF whitepaper, verified-email capture + nurture sequence, competitor whitespace + Andromeda Meta campaign design, and a 30-day whisper-tease-shout content calendar with brand seed graphics. Invoke for "launch <product> with a whitepaper", "run the whitepaper launch playbook", or any GTM push that should lead with a technical/authority asset.
---

# SKAI Product Launch + White Paper

One playbook, six phases, each with a hard gate. Built and proven on the ClaimFlow launch (July 2026). You are the orchestrator: run research in parallel, write the assets yourself, verify every gate before advancing.

**All of Hormozi's source material is attached** in `references/hormozi/` ($100M Offers, $100M Leads, $100M Money Models, $100M Lost Chapters — full PDFs) with pre-distilled framework extractions in `references/hormozi-distilled/` (JSON: core frameworks + whitepaper/email/ad/content hooks per book, each mapped to B2B SaaS launch application). **Read the distilled JSONs first** — only go to the PDFs when a framework needs deeper treatment or the product context differs enough that the distillation doesn't transfer.

## Phase 0 — Brief (inputs to lock before anything runs)

- **Product + URL**, ICP (one sentence, avatar-specific), and the **wedge sentence** (the "compliance is the wedge, attribution is the retention"-style one-liner; if none exists, write it first — every asset hangs off it).
- **The authority concept** for the whitepaper: a genuinely novel or contrarian POV (ClaimFlow example: Poincaré/hyperbolic embeddings applied to attribution). No concept → the whitepaper is a commodity PDF; push back per Cardinal Rule 0.
- **Current-events domain** for newsjacking (regulatory calendar, enforcement actions, platform changes).
- **Honesty boundary**: which claims describe shipped software vs. roadmap. This gets its own research agent in Phase 1.
- Budget scale for ads, and brand tokens (colors, display/body/mono fonts, and where the .woff2 files live).

## Phase 1 — Research fan-out (one Workflow, parallel agents)

Run as a single Workflow with `parallel()`; sonnet-tier agents; structured-output schemas. Streams:

1. **Hormozi frameworks** — read `references/hormozi-distilled/*.json`; escalate to the PDFs (Read with `pages`, ≤15/chunk) only if needed. Output: frameworks + hooks mapped to THIS product.
2. **Current events** — WebSearch/WebFetch, 6–12 dated events with primary-source URLs (regulator sites + trade press), each with "why the ICP cares" + a newsjack angle tied to the wedge sentence. Accuracy is mandatory; these anchor the whitepaper.
3. **Scholarship + prior art** — verify every citation (authors, year, title, venue, URL). Run ≥6 differently-phrased prior-art searches. Output the exact defensible novelty phrasing: *"To our knowledge, the first X — the nearest adjacent work is [cite], which does Y not X."* Never claim absolute priority; always name the nearest neighbor. Flag any citation the agent couldn't independently verify and drop or replace it.
4. **Competitor Meta ads — LIVE, via the user's browser.** Known failure mode: Meta 403-blocks ALL automated access to the Ad Library (WebFetch, Apify rendering browsers, headless anything). Do NOT burn agent budget on it. Use **claude-in-chrome**: open facebook.com/ads/library in the user's real Chrome, type each brand into the search box, click the advertiser Page in the typeahead (keyword search is junk — always select the Page), then `get_page_text` for the full ad inventory. Record per competitor: active-ad count, verbatim themes/hooks, formats, CTAs. The deliverable is **whitespace**: message lanes with observed-zero coverage.
5. **Honesty pass** — an agent reads the actual codebase(s) and returns `honest_claims`: what a public asset CAN truthfully claim and what it MUST NOT claim. This list is binding on every later phase.

**Gate:** all streams returned; research saved to `<repo>/marketing/research/*.json`; novelty phrasing locked; honest-claims list in hand.

## Phase 2 — The whitepaper

Structure (the persuasion spine is Hormozi's Value Equation; the skeleton is a problems→solutions list):

1. **Title by M-A-G-I-C** (magnet/avatar/goal/interval/container) with an authority-signal main title.
2. **Executive summary** — wedge sentence, the two arguments (technical + practical), the novelty claim.
3. **"Why now"** — the newsjack table: date | event | what it means for the reader. Calendar first, math later.
4. **Status quo + where it breaks** — name what ships today honestly, then the structural critique.
5. **The concept's lineage** — history + verified citations; include ≥1 current-year citation proving the concept is a live research area (the "tied to AI current events" beat).
6. **The application case** — why this concept, this industry; include the hedged novelty claim with nearest-neighbor citation.
7. **"What we built / what we're building"** — bounded by the honest-claims list; include an explicit what-we-will-not-claim paragraph (radical verifiability IS the sales pitch for skeptical buyers).
8. **Why this market** — the Starving Crowd four checks (pain/purchasing power/targetable/growing) argued with the research.
9. **Self-audit section** — 5 diagnostic questions (reveal-a-problem lead-magnet mechanics).
10. **Close = stacked offer**: named bonuses with jobs ("built for your compliance officer"), a real guarantee, honest capacity-based scarcity, one CTA. Then full references + a fine-print integrity footer (sample-data disclosure, novelty hedge, forward-looking labels).

Voice: plain language, lead with the concrete, no banned-word hype, explain any math in analogies. ~4,000–5,500 words.

**PDF pipeline** (adapt `references/pipelines/build-pdf.mjs`): `npx marked --gfm` → wrap in print-CSS shell with brand fonts embedded base64 from the token woff2s → `chrome.exe --headless=new --no-pdf-header-footer --print-to-pdf`. Verify typography by screenshotting the HTML (`--screenshot`) and Reading the PNG — don't ship unverified.

**Gate:** markdown + branded PDF exist; every citation verified; every claim inside the honesty boundary; screenshot check passed.

## Phase 3 — Email plan

- **Mechanism before copy**: capture page gating the PDF (email + 2–3 qualifying fields = the friction dial), server-side **email verification at submit** (Hunter — Cardinal Rule 7 is absolute: nothing unverified enters any sending platform), push to Kit/ConvertKit with tags, dedicated sending subdomain with SPF/DKIM/DMARC. Deliver the PDF on-page too — the gate is a toll, not a hostage.
- **Sequence** (Day 0,1,3,5,8,11,14,18,22,26): deliver-everything → one-small-action → story-with-stakes → the calendar/deadlines → reframe ("vendor handles that" ≠ answer) → the concept in 60 seconds → **first ask** (pilot + guarantee, menu CTA) → unselling/objections → honest capacity status → 9-word re-engage. Give:ask ≥ 4:1. All urgency real (regulatory dates, true capacity) — never manufactured.
- Post-sequence: monthly pure-value calendar email + two-sided referral ask (dense-network niches compound referrals faster than ads).
- Money-model staging (from $100M Money Models): whitepaper = attraction → pilot = upsell → feature-light tier = downsell → subscription = continuity. Sell only the next step in each email. Consider Founding-cohort lifetime rate + real one-time setup fee (Lost Chapters continuity mechanics).
- Cold outreach is a separate lane and never enters the warm ESP list.

**Gate:** EMAIL-PLAN.md with full copy for all sends + measurement targets; capture-page build task created (it blocks ads).

## Phase 4 — Meta ads (whitespace report + Andromeda design)

**Whitespace report** from Phase 1's live observations: table of competitor | active count | verbatim themes | formats/CTAs, then the whitespace list (angles with observed-zero coverage), then budget: small-launch default **$50/day**, CPL target with explicit **scale trigger** (2 weeks under target + 1 pilot call) and **kill/fix trigger** (CPL 1.5× target = creative problem, not budget problem).

**Andromeda campaign** (named for Meta's Oct-2025 ranking engine, whose #1 lever is creative diversity — >60%-similar creatives get suppressed):

- **1 campaign, Advantage+ on, CBO · 6 ad sets = customer-journey stages** (Unaware → Problem-aware → Solution-aware → Product-aware/retargeting → Decision → Advocacy) · **5 ads per ad set = E-E-A-T angles**: Experience ×2 (founder-voice + customer-scenario), Expertise, Authoritativeness, Trustworthiness.
- **30 distinct concepts, zero variants.** Fatigued ad → new concept, not a recolor.
- Each ad brief: angle, hook line, format, CTA, destination. No creative production in this phase.
- Phased activation: cold stages first (they build the retargeting pool), retargeting at pool ≥1k, decision stage at scale trigger, advocacy only when real testimonials exist (never fabricate — leave the slot empty).
- Prerequisites checklist: capture page live, Pixel + CAPI deduplicated Lead/Schedule events, domain verified, seeded social pages. Check Special Ad Category applicability honestly (B2B software usually isn't; regulated-industry vocabulary may still trip review — keep creative explicitly B2B).

**Gate:** both docs exist; budget has scale AND kill triggers; every ad brief traces to a whitespace angle or E-E-A-T slot.

## Phase 5 — 30-day content calendar + seed graphics

- **Arc:** Days 1–10 Whisper (problem + build-in-public, zero pitch) → 11–20 Tease (asset reveal, capture opens, limiting-beliefs series) → 21–30 Shout (pilot cohort, founding rate, countdown, referral). Give:ask ≥ 4:1 across the month.
- Voice: **"How I," never "How to."** One post/day written once, adapted per platform. Community/group posts are pure value, no links unless asked.
- Repurposing rule: organic winners (≥3× median saves/shares) become the next paid ad concepts.
- **Seed graphics** (adapt `references/pipelines/build-graphics.mjs`): ~10 cards, 1080×1350, brand tokens, HTML → `chrome --headless=new --screenshot`. Standard set: manifesto/wedge card, enforcement stat, regulatory timeline, checklist, two-column comparison, concept illustration (hand-drawn SVG beats stock), self-audit chain, guarantee card, whitepaper cover, countdown card. **Read the rendered PNGs and fix spacing collisions before delivering** — footer/caption crowding is the recurring bug.

**Gate:** calendar table complete (every row: phase, hook→substance, format+asset, CTA); all graphics rendered AND visually verified.

## Phase 6 — Completion

- Deliverables table with **complete absolute paths for every artifact** (Cardinal Rule 8 — hard gate).
- Create tasks for the build steps that block launch (capture page, pixel, sending domain).
- Update project memory with what shipped and what's pending.
- If the whitepaper makes roadmap claims, ensure the roadmap build is a tracked task — the paper's credibility depends on the engine becoming real.

## Known failure modes (learned the expensive way)

- **Meta Ad Library**: automated access is dead (403). Real logged-in Chrome via claude-in-chrome works. Keyword search ≠ advertiser search — always click the Page in the typeahead.
- **Font files by hash**: never assume a .woff2's identity from its filename — verify family/subfamily in the capture's fonts-manifest.json before embedding.
- **Novelty claims**: unhedged "first ever" is a falsification magnet. Always "to our knowledge" + name the nearest adjacent work.
- **Honesty drift**: marketing pressure blurs shipped vs. roadmap. The Phase 1 honest-claims list is binding; re-check every asset against it before delivering.
- **Agent-tool prompt strings don't expand `$(cat ...)`** — inline the content or have agents Read files themselves.
