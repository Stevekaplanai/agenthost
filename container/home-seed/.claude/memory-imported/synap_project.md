---
name: Synap Marketing OS project
description: SynapMarketing.com - PROJECT PAUSED 2026-04-25 by Steve (sunk-cost decision). Do not propose new feature work without explicit revival. See STATUS block below.
type: project
originSessionId: 14e8009d-5e07-4862-b669-4a2fa6208660
---

## STATUS: PAUSED 2026-04-25

Steve made a deliberate decision to stop work on Synap on 2026-04-25 ("I built this out too much when I had too much time. I don't think this is worth my time anymore at this point."). Project is parked, not abandoned — he said *"maybe I'll come back to it later."*

**If a future session is invoked on this project:**
- Do NOT propose new feature work, scope expansion, or "let's ship the next thing"
- DO surface anything Steve explicitly asks for
- Last work shipped on the pause day: aligned `tier_configs` to match `frontend/src/pages/PricingPage.tsx` (Solo $49 / Starter $99 / Pro $299 / Enterprise Contact Sales) — commit `3a7858b`
- Production state on pause: app is live + healthy, billing 3 active subs from prior cohorts, but **Synap checkouts are non-functional** (Stripe Products `Synap Starter/Growth/Scale` have no Prices, `tier_configs.stripePriceIdMonthly/Annual` are NULL). Steve knows checkouts don't work and chose not to fix it.

**Brainstorm conclusions if Synap is ever revived (preserved so we don't have to re-derive):**
- Customer hypothesis: marketing agencies, 5-50 people. NO validated buying signal — picked from gut because it's who Steve started building for.
- Wedge: *"Run our Google Ads MCC + Facebook Business Manager accounts at half the staffing cost."* Maps to existing 9.5K-LoC OAuth Multi-Tenant System (Phase 8) — strongest moat in the codebase.
- v1 workflow chosen: **Free MCC Audit → paid "fix this for me"** (over daily action queue, weekly reports, campaign launcher, cross-account optimizer).
- Audit lens chosen: **Performance Anomaly Detector** — regressions, spend spikes, broken tracking, disapproved ads. Outbound-led; every audit produces a specific scary finding suitable for cold-email subject lines like *"Your client's pixel has been broken since Apr 11"*.
- DID NOT decide before pause: fix mechanic (alerts only / one-click / autonomous / hybrid / performance-based), pricing model, orchestrator (LangGraph vs openclaw/hermes deep-research was deferred).
- Strategic insight from the brainstorm: **the scope problem isn't the 16 agents** — it's the user-facing surface area (90+ pages, 5 trust tiers shown, 4 pricing tiers, 8 OAuth integrations, 6 attribution models, parallel surfaces for CDP/Content Library/Decisions/Predictions/Sentiment/A/B/Beta). Agents are leverage; surfaces are bloat. If revived, hide ~85% of UI behind feature flags but keep agent code dormant as product-led expansion ammunition.

## Project: Synap Marketing OS (SynapMarketing.com)
- **Path**: C:\Users\User\Projects\marketing-ai-platform
- **GitHub**: GTMVP/marketing-ai-platform
- **Frontend**: synapmarketing.com (Vercel)
- **Backend**: marketing-ai-platform-production.up.railway.app (Railway)
- **n8n**: sim.synapmarketing.com (Agent Studio backend, archived from main UI but infra retained)
- **Version**: v2.0.0 (per README, April 2026)

## Stack (verified 2026-04-25)
- **Frontend**: React 18 + TypeScript + Vite, Tailwind, Framer Motion, TanStack Query, React Router
- **Backend**: Node.js + Express + TypeScript, Prisma ORM
- **Database**: PostgreSQL on **Neon** (primary) — Supabase is documented in `.env.example` for LangGraph checkpointer split but NOT set in Railway prod; checkpointer.ts:64 falls back to DATABASE_URL (Neon) when SUPABASE_DATABASE_URL is unset
- **Cache**: Redis on Upstash
- **Auth**: **Clerk** (NOT Kinde — migration shipped). Kinde references in older docs are stale.
- **AI**: OpenAI + Anthropic Claude + Gemini, orchestrated via LangGraph
- **Payments**: Stripe (live mode uses restricted key `rk_live_...`)
- **Deployment**: Vercel (frontend), Railway (backend), auto-deploy via push to main

## Service IDs / Linkage
- **Vercel**: project `prj_04xsKcb8LEmTmjqN5x1LaYmkXb9o`, team `team_e32haRRbzN2HSWPlLYfncxyb` (`gtmvp`), project name `marketing-ai-platform`
- **Railway**: project `considerate-enthusiasm`, environment `production`, service `marketing-ai-platform`
- **Stripe**: account `acct_1P9AaXRrVb92Q7hg`, display name `GTMVP Inc`

## Scale (verified 2026-04-25)
- 5,083-line Prisma schema, 148 models
- 67 backend route files, 125 frontend pages, 100+ API endpoints
- 16 LangGraph agents across 5 trust tiers (older docs say "28 agents" — that's a stale number)

## Recently shipped (since Nov 2025)
- Phase 8: OAuth multi-tenant (8 platforms, AES-256-GCM, MCC + Business Manager delegation)
- Phase 9a: Brand Intelligence Onboarding Wizard (8-step auto-research, auto-launch on brand creation)
- Phase 9b: Pricing Tier System 90% (Stripe checkout, webhooks, proration, A/B framework)
- Auth migration: Kinde → Clerk
- Mobile responsive, dark theme sweep, auto-create user/agency on Clerk login

## Known concerns (as of 2026-04-25)
1. Project was on a deliberate pause from ~2026-04-06 → 2026-04-25; resumed 2026-04-25. (Don't flag the gap as a deploy issue.)
2. **Pricing tier system is silently broken in production**: `tier_configs` table is empty in the prod DB. Hence `GET /api/v1/tier-checkout/tiers` returns `[]`, `POST /create-session` throws `Tier configuration not found`, and zero Synap checkouts have ever happened despite `PRICING_TIERS_ENABLED=true` and `PRICING_TIER_ROLLOUT_PERCENTAGE=100`. The 3 active subscriptions in Stripe live mode are from OTHER GTMVP products (Student AI Detector, AI Homework Help, etc.), not Synap. Two seed scripts also disagree on prices: `prisma/seed-tier-configs.ts` ($49/$399/$799/$1,999) vs `src/scripts/configure-stripe-products.ts` ($49/$199/$399/$1,999). Synap Stripe Products (`Synap Starter/Growth/Scale`) exist but have `default_price: null`. **User chose 2026-04-25 to defer the fix** until after a scope-reduction brainstorm (target: 16 → 3 agents) so pricing can be redesigned alongside the simpler product instead of patching a tier structure that won't survive.
3. Carryover from older memory worth re-verifying: hardcoded admin email bypass in `backend/src/middleware/auth.ts` (now env-driven and audit-logged as of `56673ca`), manual JWT decoding (already replaced by Clerk), mocked analytics pages (already cleaned up per Phase 13).
4. 19 E2E tests on a 100+ endpoint backend — coverage is well under 80% rule.
5. CURRENT_STATUS.md was 5 months stale; refreshed 2026-04-25 (`a41707b`). Update on every phase boundary.

## Key file paths
- Router: `frontend/src/App.tsx`
- Backend entry: `backend/src/index.ts`
- LangGraph checkpointer: `backend/src/orchestration/langgraph/checkpointer.ts`
- Schema: `backend/prisma/schema.prisma`
- Env example: `backend/.env.example`
- CLI bootstrap (Windows): `scripts/cli-bootstrap.ps1`

## Convention from CLAUDE.md
- Brands tab is the critical seed feeder for campaigns/audiences/agents — treat as foundational
- Compliance + human-in-the-loop is the design center, not multi-user collaboration
- Conventional commit format: `type(scope): description`
- Always push after committing to trigger CI/CD
