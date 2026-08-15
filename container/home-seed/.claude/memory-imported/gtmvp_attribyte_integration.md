---
name: gtmvp-attribyte-integration-live
description: GTMVP↔Attribyte CPA-guarantee integration is LIVE (not mock) as of 2026-05-30 per Steve
metadata: 
  node_type: memory
  type: project
  originSessionId: 44ef6abf-388b-4d60-b4e2-30d2771464b0
---

**Status: LIVE as of 2026-05-30 (confirmed by Steve).** `ATTRIBYTE_SERVICE_KEY` + `ATTRIBYTE_BASE_URL` are set and synced in GTMVP's Vercel project, the database migration is applied, and GTMVP + Attribyte both confirmed the API connection is live.

**Correction to earlier analysis:** the 2026-05-30 unifying-theory deliverable (and my recap) said "3 pending go-live items / the CPA guarantee runs on mock fixtures." That was STALE — inferred from static code comments (`GTMVP_V0/lib/attribyte/types.ts:18-21` "operator-gated, not done by code") and the fact the client defaults to mock (`client.ts:169`). A repo-reading agent can't see live Vercel env or applied migrations. Do not repeat the "pending / mock fixtures" claim.

**How the switch works:** `lib/attribyte/client.ts:169-172` goes live only when `ATTRIBYTE_MODE=live` AND `ATTRIBYTE_BASE_URL` AND `ATTRIBYTE_SERVICE_KEY` are all set; mock mode never calls the real backend. A confirmed live API call implies `ATTRIBYTE_MODE=live` is set. (GTMVP-side migration that adds the rebuild columns: `supabase/migrations/20260529000000_audit_requests_rebuild_attribyte.sql`.)

**What is genuinely still gated (not a deployment task):** the 20% CPA guarantee can only show a REAL measured result once a real Rebuild client's ad account feeds spend + conversions (`/performance` returns `spend: 0` with no account connected). That happens when the first Rebuild customer onboards.

**Honest-gating now:** OK to say the guarantee is system-enforced by live Attribyte measurement (true today). Do NOT claim a delivered "cut CPA 20%" outcome until a real client's 90-day window has actually run. Related: [[proof-roas-numbers]], [[content-launch-2026-06-01]].

**Connector architecture (Steve, 2026-05-30):** Google + Shopify connect via **Pipedream** on the GTMVP site (namespaced by `externalUserId`; Google account stored on `smart_bidding_audit_leads.pipedream_account_id`, see `app/api/pipedream/`). Facebook via **Supermetrics** (key arriving ~Mon 2026-06-01). NOT Leadsie for this client. First real Rebuild client is partially connected (Google + Shopify confirmed; FB pending Supermetrics).

**Supermetrics finding (discovery 2026-05-30):** a fresh Facebook connection does NOT auto-backfill — the standing transfer loads recent data only; the trailing 90-day history needs a separate, MANUAL, queued backfill (90d fits one batch; trial accounts cap at 14d; FB data settles 4-7 days). **Sequence: connect FB → trigger 90-day backfill → confirm it completed in Attribyte → only then anchor go-live.** Never anchor at connect-time (baseline would freeze over a near-empty window).

**Channel-completeness guard design (corrected, build-ready spec exists):** gate the baseline-freeze in `provisionAttribyteRebuild` (`lib/attribyte/auto-provision.ts:122`) primarily on a new operator attestation column `rebuild_backfill_ready_at` (stamped only after confirming all channels' data is in Attribyte) — connector-agnostic and correct regardless of Pipedream/Supermetrics topology, so we do NOT hard-depend on auto-detecting channels across the spread-out connectors. Auto-detect (Pipedream Google/Shopify + Supermetrics FB) is best-effort panel info, not a hard gate. Plus a `reanchor-rebuild-baseline` helper (clear go-live/baseline/window/status → re-provision). Hand as a PR, never auto-push GTMVP guarantee code.

**Built + PR'd 2026-05-30: PR #218** (https://github.com/GTMVP/GTMVP_V0/pull/218, branch feat/rebuild-baseline-channel-guard). Final design is attestation-primary: `rebuild_backfill_ready_at` is the HARD gate, channel detection from `accounts` is advisory only (avoids deadlocking Pipedream clients), and it refuses to freeze a null baseline (zero spend/conversions). Files: `lib/attribyte/{channel-completeness,auto-provision,reanchor}.ts` + tests, `scripts/reanchor-rebuild-baseline.ts`, admin `rebuild-reanchor` route, migration `20260530000000_rebuild_channel_completeness.sql`. 39 vitest tests passing. Dormant until `rebuild_backfill_ready_at` is set. NOT merged — awaiting Steve's review.
