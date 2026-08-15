---
name: cardinal-rule-verify-a-project-s-foundation-builds-clean-before-building-on-it
description: "Before starting feature work on any existing repo with a database or deploy pipeline, run the pre-flight checklist. A from-zero clean build is the foundation gate. Never build on a foundation you haven't verified compiles from scratch."
metadata: 
  node_type: memory
  type: feedback
  severity: cardinal
  created: 2026-05-30
  originSessionId: 46177cb5-ffda-4d60-a3f4-05eaf2a8a897
---

# CARDINAL RULE: Verify the foundation builds clean from zero BEFORE building on it

## The rule
Before ANY feature/research/design work on an existing project that has a database
or a deploy pipeline, run a **PRE-FLIGHT CHECK**. The single most important gate:
**can the schema/app build from a clean slate (zero state)?** If it can't, the
foundation is broken — STOP and fix the foundation first. Do not design or build
features on top of a foundation you have not verified compiles from scratch.

## The expensive lesson (2026-05-30, Attribyte)
We spent a long, winding session + ~6M tokens designing the Journey/Pipeline epic,
fixing "integrity" surfaces, and trying to live-test a privacy gate — all of which
quietly assumed a working database could be stood up. It couldn't. The moment we
tried to create a test DB (Supabase preview branch, then local Docker), the
migration chain failed. Diagnosis found **8+ structural conflicts**: an
`organizations` table referenced by 21 foreign keys but never created by any
migration, duplicate table definitions (dashboards, audit_logs, etc.) with
divergent columns, a name bug (workspace_users vs workspace_members), a
materialized view referencing non-existent columns, and an ordering bug
(privacy_compliance.sql ALTERs attribution_results 4 months before it's created).

Root cause: **prod was bootstrapped via `supabase db push`** (dumps final state
directly), so the sequential migration chain was NEVER run start-to-finish and
accumulated invisible drift. Everything downstream (live test, Journey/Pipeline
build) was gated on a foundation that didn't exist. Caught late, at great cost.

The fix is NOT file-by-file repair of 30 broken migrations — it's a **baseline
reset**: `supabase db dump` prod's real schema → ONE clean baseline migration →
archive the broken chain. (See gtmvp/attribyte DECISIONS.md.)

## PRE-FLIGHT CHECKLIST — run BEFORE starting work on an existing repo
1. **Fetch + re-baseline** vs origin/main (see feedback_fetch_live_repo_first.md). Local clones go stale; platforms can auto-commit.
2. **Build from zero.** Stand up the DB/app on a CLEAN slate (e.g. `npx supabase start` against empty, fresh `npm install && build`). If it fails → foundation is broken → fix it FIRST, before any feature work.
3. **How was prod bootstrapped?** `db push` (dump) vs sequential migrations. db-push = high drift risk = the chain is probably untested = run step 2 with extra suspicion.
4. **Deploy trigger.** Does main auto-deploy? What applies migrations to prod? (Vercel git-integration deploys the app; migrations are usually a SEPARATE step — know which.)
5. **Other committers.** Can the platform or another agent commit to this repo? (Attribyte's platform auto-launches agents that push to main.)
6. **Test target exists + works.** Confirm a non-prod test environment (local docker / preview branch) actually builds BEFORE promising any live test.

## One-line version
**Step 1 of any DB/deploy project is: prove it builds from zero. A green from-zero build is the foundation. Don't design or build on an unverified foundation.**
