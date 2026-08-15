---
name: gtmvp-orchestrator-activation
description: Runbook to flip ON the GTMVP autonomous orchestrator engine post-launch. It is ALREADY SHIPPED to prod but dormant behind two gates. Do NOT activate during the cold-email launch week.
metadata: 
  node_type: memory
  type: project
  created: 2026-05-30
  originSessionId: 46177cb5-ffda-4d60-a3f4-05eaf2a8a897
---

# GTMVP Orchestrator — Activation Runbook

> **Status as of 2026-05-30: LIVE in prod code, DORMANT (safe).** The 8-agent autonomous engine shipped to `main` of `GTMVP/GTMVP_V0` via PR **#177** (2026-05-23). It does NOT run because both activation gates are closed. Do not activate until the cold-email launch settles.

> **DEFERRAL 2026-06-06 (review_after: 2026-06-29).** The scheduled "activate today" reminder fired June 6, but the gate failed: we were still inside BOTH the SAASpocolypse cold-email launch (May 23–June 17) and the GTMVP content launch (Blotato, June 1–26). Live re-verified safe that day: `autonomous_windows` = 0 open / 3 total, latest created 2026-05-24 — unchanged, nothing ran. Activation deferred to the first calm window. Dual-channel reminder reset for **Mon June 29, 2026, 9 AM ET** (scheduled task `gtmvp-orchestrator-activation` re-armed + GCal event on steve@stevekaplan.ai). PR #178's `migrationDatabaseUrl()` ReferenceError is still an open blocker if the rollout script is used.

> **REMINDER FIRED 2026-06-29 (this run).** Scheduled task `gtmvp-orchestrator-activation` fired as planned. Both blackout windows are now CALENDAR-CLEAR: SAASpocolypse ended June 17 (12 days ago), GTMVP/Blotato content launch ended June 26 (3 days ago). **Could NOT live-verify the gate this run** — the run was headless ("don't ask mode"), so the Supabase `execute_sql` read (orchestrator safety check on `swrhibqhjmouiyhbwoae`), the scheduled-tasks list, and the GCal read were all permission-denied, and no working Resend MCP tool was available to confirm the SAASpocolypse sends actually wrapped (Resend key was invalid 2026-06-06 — status unknown). So: the reminder is delivered, but the live SAFE re-verification still owes a confirmation from Steve in an interactive session before any gate flips. **Next action is Steve's:** in a normal (interactive) session, (1) confirm SAASpocolypse cold-email has fully wrapped in Resend, (2) re-run the Supabase safety query to confirm `autonomous_windows` still 0 open, then walk the ACTIVATION SEQUENCE below starting tiny (a05_angles, ~$0.50 smoke window). DO NOT flip gates from a headless run.

## Why this exists
Found during a read-only recon workflow on 2026-05-30. Steve almost merged 6 stale PRs (#171-#176) thinking the engine wasn't shipped — it was. Those 6 were closed as "shipped via #177." This runbook captures how to actually turn the engine ON, deliberately, later.

## The two gates (BOTH must be active for any agent to run or spend)

### Gate 1 — `ORCHESTRATOR_AGENTS` env var (Vercel prod)
- Lives in Vercel project **gtmvp-v0**, team **GTMVP Inc** (`team_e32haRRbzN2HSWPlLYfncxyb`), scope `gtmvp`. Set in BOTH Preview + Production.
- **Marked Sensitive** → cannot be viewed in the Vercel dashboard UI. Value unknown as of 2026-05-30 (set ~6 days prior). `vercel env pull` can decrypt it locally but the auto-mode classifier blocks dumping the full prod env — to read it, Steve reveals/sets it himself or explicitly authorizes a scoped pull.
- **Semantics** (from `lib/audit/orchestrator/handlers/index.ts` → `getEnabledAgentIds()`):
  - empty / whitespace → `[]` → **agents OFF**
  - comma-separated agent IDs → those agents enabled
- **Valid agent IDs:** `a02_product_taxonomy`, `a03_positioning`, `a05_angles`, `a06_channels`, `a07_keywords_serp`, `a08_trend_pulse`, `a09_technical_seo`, `a10_conversion_cro`. Short forms `a02`/`a03`/`a05`/`a06`/`a07`/`a08`/`a09`/`a10` also map correctly.

### Gate 2 — an open `autonomous_windows` row (Supabase)
- **Supabase project: orange-island**, ref/id **`swrhibqhjmouiyhbwoae`** (ACTIVE_HEALTHY, us-east-1). This is GTMVP_V0's DB.
- Director + runner crons are window-gated: no `status='open'` row → they no-op regardless of the env var.
- **State 2026-05-30:** `open_windows: 0`, `total_windows: 3`, latest window created 2026-05-24. → dormant.
- **This is the real day-to-day killswitch.** Closed window = nothing runs even if the env var holds a full agent list.

## What's live but idle right now
5 cron routes registered in `main`'s `vercel.json` (firing on schedule but no-op while gates closed):
- `/api/cron/orchestrator-director` (*/5)
- `/api/cron/orchestrator-runner` (*/5)
- `/api/cron/orchestrator-window-closer` (*/2)
- `/api/cron/orchestrator-runs-reaper` (*/15)
- `/api/cron/orchestrator-window-recompute` (*/10)
- (plus `/api/cron/agent-a07-keywords-serp-daily`)
- `*/2` cadence implies a Vercel Pro/Enterprise plan — confirm tier so these aren't silently erroring.
- `CRON_SECRET` env var exists → use it to probe cron routes (the in-repo `scripts/orchestrator-dry-run.mjs` already does this).

## Cost when live
~$20-25 per half-day window. A_07 (keywords/SERP) is the expensive one at ~$1.50/run. Start tiny.

## ⚠️ Blocker before activation: PR #178 is buggy
- PR **#178** ("chore(orchestrator): agent-run rollout script + zero-touch docs") is the ONLY open orchestrator PR with net-new content (based on `main`, not draft).
- **Bug:** `scripts/orchestrator-rollout.mjs` line ~94 calls `migrationDatabaseUrl()` which is **never defined** in the file → guaranteed `ReferenceError` on first run. Cursor Bugbot skipped it, so CI never caught it.
- **Fix before using:** define `migrationDatabaseUrl()` to read a direct DB URL from env (e.g. `SUPABASE_DB_URL` / `DATABASE_URL`). Its sibling scripts (`seed-orchestrator-window.mjs`, `orchestrator-dry-run.mjs`) are already in `main`.
- The migrations (`20260522170000_orchestrator_phase_1*.sql`) are already applied in main, so any re-run of the script MUST be idempotent. The script shells `psql` with the service-role key against the direct prod DB URL — privileged; run only against non-prod first.
- Docs in #178 describe a rollout #177 already performed — decide if they're still wanted, or just close #178 after extracting the bug-fixed script (or discarding it).

## ACTIVATION SEQUENCE (post-launch, calm session — not launch week)
1. **Reveal/confirm `ORCHESTRATOR_AGENTS`** value (Steve, via Vercel dashboard or authorized `vercel env pull`). Decide the agent list. Keep empty = stays off.
2. **Fix #178's script** (the `migrationDatabaseUrl` ReferenceError) if you intend to use it. Run only against a non-prod DB first.
3. **Verify CI the real way** — no GitHub Actions test/typecheck gate exists; run `pnpm vitest run lib/audit/orchestrator/` + `tsc` on the orchestrator tree locally against `main` (the only thing in prod).
4. **Probe cron routes** with `CRON_SECRET` → confirm they return 200/no-op and aren't erroring every few minutes.
5. **Open a tiny smoke window:** ~0.1h, ~$0.50 budget, ONE low-risk agent (`a05_angles`). Set `ORCHESTRATOR_AGENTS=a05_angles`, open one `autonomous_windows` row.
6. **Watch the digest** (HITL digest output). Confirm it ran, produced output, spent roughly what was budgeted.
7. **Scale** per `docs/ORCHESTRATOR_ROLLOUT.md` (already in main) — add agents/budget incrementally.

## TO STOP / EMERGENCY OFF
- Close the open `autonomous_windows` row (Gate 2), **or**
- Set `ORCHESTRATOR_AGENTS` to empty (Gate 1).
- Either alone halts all agent execution.

## Key refs
- Repo: `GTMVP/GTMVP_V0` (auto-deploys to prod via Vercel on every push to `main`)
- Local clone: `C:\Users\User\Projects\gtmvp-saasw\GTMVP_V0`
- Engine code: `lib/audit/orchestrator/` (+ `handlers/`, `engine-agents/a07/`)
- Rollout doc already in main: `docs/ORCHESTRATOR_ROLLOUT.md`
- GitHub issue tracking this: see GTMVP_V0 issues ("Activate orchestrator engine (post-launch)")
