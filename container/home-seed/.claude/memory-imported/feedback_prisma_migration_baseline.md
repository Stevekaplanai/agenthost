---
name: Prisma migration baseline when DB was bootstrapped via db push
description: When 'prisma migrate status' lists ALL migrations as unapplied but the app is running with data, the DB was bootstrapped via 'prisma db push' and the tracking table is empty. Baseline by marking each migration as applied without re-running.
type: feedback
originSessionId: 14e8009d-5e07-4862-b669-4a2fa6208660
---
**Symptom:** `prisma migrate status` against production reports "Following migrations have not yet been applied" with the entire `prisma/migrations/` directory listed, BUT the app is live, has data, and the schema clearly exists.

**Root cause:** The schema was originally bootstrapped via `prisma db push` (or `migrate dev` then a manual `db push`), which doesn't write rows to the `_prisma_migrations` tracking table. Prisma believes no migrations have run; running `migrate deploy` would attempt to re-create existing tables and fail or corrupt data. Quiet but lethal architectural debt — every future migration would fail until baselined.

**Why:** Caught on 2026-04-25 in the Synap project. The DB had 37 unapplied migrations per Prisma but a fully-deployed schema with real data and active users. Standard `migrate deploy` would have been destructive.

**How to apply:**

1. **Diagnose first** — confirm schema actually matches before baselining (read-only operation):
   ```
   railway run --service <name> npx prisma migrate diff \
     --from-schema-datasource prisma/schema.prisma \
     --to-schema-datamodel prisma/schema.prisma \
     --exit-code
   ```
   - Exit 0 → no drift, safe to baseline
   - Exit 2 → real drift, fix schema before baselining
   - Other → connectivity or config error, don't proceed

2. **Baseline via a tiny script** that loops `prisma/migrations/*` directories and calls `prisma migrate resolve --applied <name>` for each. Make it idempotent — Prisma errors with "already recorded as applied" on rerun, which the script should catch and treat as success. Reference implementation: `marketing-ai-platform/backend/src/scripts/baseline-migrations.ts` (commit `8e1b156`).

3. **Verify after** — `prisma migrate status` should report "Database schema is up to date!"

4. **Going forward** — `prisma migrate deploy` works normally for every new migration after baseline.

**Detection heuristic:** If you see a partial fix in package.json like `"db:migrate:resolve": "prisma migrate resolve --applied <one_specific_migration> || true"`, someone hit this issue before but only patched a single migration. The general baseline script is the proper fix.
