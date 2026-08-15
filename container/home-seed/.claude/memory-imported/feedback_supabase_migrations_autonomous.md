---
name: feedback-supabase-migrations-autonomous
description: "Standing authorization (Steve, 2026-06-06): apply and commit Supabase migrations without asking. Overrides the default 'always ask before running a live-DB migration' gate."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 4b5ba9b2-ecfa-4df2-977e-90edeaecbaae
---

Steve granted standing authorization: **apply and commit Supabase migrations without his approval.** ("You have supabase access you're allowed to commit all migrations without me.")

**Why:** removes the per-migration approval round-trip so DB work isn't bottlenecked on him.

**How to apply:**
- This OVERRIDES the global CLAUDE.md hard-stop ("run a migration on a live DB → always ask") for Supabase migrations. No longer ask first.
- Still **verify safety before applying** — that's diligence, not permission-seeking. Prefer additive/idempotent DDL; read the migration; check current schema state.
- After DDL, consider `get_advisors` (security) to catch missing RLS.

**Attribyte project = `kqpllsenlvdgsznptylb`** ("supabase-attr-byteweb", PG17). Other projects on this account: GTMVP = `swrhibqhjmouiyhbwoae` (supabase-orange-island); also saaspocolypse-giveaway, Project_Hydra, docdoctor, student-ai-detector. Target the right one.

**Migration-log gotcha (verified 2026-06-06):** migrations applied via the MCP `apply_migration` get a FRESH timestamp version (e.g. file `20260605000000_lead_scoring` was recorded in the DB log as `20260606012433 lead_scoring`). So `list_migrations` will NOT line up with the `supabase/migrations/*.sql` file names. **Never decide "is this applied?" by matching the log — inspect the actual schema objects** (`pg_enum`, `information_schema.columns`, `pg_indexes`, `pg_proc`). On 2026-06-06 every recent Attribyte migration was confirmed present in schema EXCEPT `add_ai_assistant_channel` (an `ALTER TYPE channel_type ADD VALUE 'ai_assistant'`), which I then applied. `ALTER TYPE ... ADD VALUE` works inside a txn on PG12+ (the old "not in a transaction" caveat in some migration comments is stale for PG17).

See [[feedback-autonomous-brain-edits]] and [[attribyte-design-system-and-utm-facility]].
