---
name: gtmvp_repo_canonical_paths
description: The canonical GTMVP marketing repo path + which component is the LIVE homepage hero (two false starts cost time on 2026-06-01)
metadata: 
  node_type: memory
  type: project
  originSessionId: a902c679-d176-45f5-891c-65096f2e633d
---

**Canonical GTMVP marketing repo:** `C:\Users\User\Projects\gtmvp-saasw\GTMVP_V0` (on `main`, remote `github.com/GTMVP/GTMVP_V0`, deploys gtmvp.com via Vercel). The top-level duplicate `C:\Users\User\Projects\GTMVP_V0` was DELETED 2026-06-01 (stale engine-work checkout; all work was on origin). If it reappears, it's a re-clone, not the source of truth.

**The LIVE homepage hero is `EditorialMasthead` in `app/(public)/page.tsx`** — the shared masthead used at the top of every public page. It is NOT `components/v2/Hero.tsx`; that v2 Hero only renders on the internal `/design` styleguide (`app/design/page.tsx`, unlisted, a living component showcase — do not delete it). Editing v2 Hero does nothing to the live homepage. Always confirm a page actually imports a component before assuming it's live.

**Routes:** `/smart-bidding-audit` = the free connected audit (~60s, "Run the free connected audit"). `/audit` = the $129 Diagnostic. The masthead CTAs already lead with the free audit.

**Reusable:** a `VideoFrame` v2 component exists (shown in the `/design` styleguide) for the planned engine-demo video slot in the homepage restructure.

**Homepage restructure status (2026-06-01, review_after 2026-06-02):** Mockup at `C:\Users\User\Downloads\gtmvp-restructure-mockup.html`. Spine: Products (free Smart Bidding Audit + GTMVP MCP Server, one-liner "GTM motion starts with the GTMVP MCP Server. Install now with one line of code." + placeholder `npx -y @gtmvp/mcp-server`) -> [VIDEO slot] -> Pricing (5 tiers, 8-agent engine demoted to a Rebuild line-item) -> Guarantees. Hero already live (PR #221 merged). Video PULLED from the mockup pending Steve's recording; calendar event + scheduled task `gtmvp-engine-video-followup` both fire 2026-06-02. Restructure NOT yet built into the live Next.js page — mockup-first, awaiting Steve's react.

Cardinal rule [[feedback_fetch_live_repo_first]] applied here paid off twice in one session: local `main` was 1 commit behind origin on a clean fetch.

**DB MIGRATION STATE (2026-06-01):** The GTMVP orchestrator/audit Supabase is `swrhibqhjmouiyhbwoae` (the `supabase link` target; holds `audit_requests` + the orchestrator tables). On 2026-06-01 it was **6 migrations behind `main`** — its GTMVP-side rebuild/attribyte columns on `audit_requests` had never been applied. Pushed all 6 (enable_rls_all_tables, prune_retired_statuses, audit_requests_rebuild_attribyte, smart_bidding_audit_results, smart_bidding_unsubscribe, rebuild_channel_completeness) via the Supabase MCP `apply_migration` + reconciled the recorded versions to the file versions (apply_migration stamps today's timestamp, not the file's — fix by UPDATE-ing `supabase_migrations.schema_migrations.version`). Schema verified. NOTE: the older memory claim "attribyte migration applied 5/30" was about **Attribyte's own DB `kqpllsenlvdgsznptylb`**, not this one. RLS is now on across all public tables here; the app uses `service_role` (RLS-bypassing) so that's safe.

**CONTENDED WORKING DIR (2026-06-01):** The `gtmvp-saasw\GTMVP_V0` MAIN checkout is used concurrently by another process/agent — observed an external `git checkout feat/mcc-account-picker` mid-edit that clobbered uncommitted working-tree changes (reflog confirmed). Repo has ~50 branches + active worktrees (`+`-prefixed, `neiljesani-/*`, `claude/*`, `worktree-*`). **For any local edits here, use an isolated `git worktree` off origin/main, commit + push fast** — do not trust the main checkout's working tree to survive between tool calls. GitHub API from this env is also intermittently flaky (gh pr create failed ~3x with "error connecting"; retried fine). Blog-engine fix shipped (PR #223 merged); OAuth-token swap is draft PR #224 (gated on Steve adding the CLAUDE_CODE_OAUTH_TOKEN secret).
