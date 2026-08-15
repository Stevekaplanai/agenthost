---
name: a-not-found-error-can-be-a-masked-bad-column-select
description: "When a service throws 'X not found' but the row provably EXISTS, suspect a bad column in the .select() that made supabase .single() return {data:null, error}, which a naive `if (error || !data) throw NotFound` then mis-reports as not-found. Read the select column list against the real schema."
metadata:
  node_type: memory
  type: feedback
  severity: high
  created: 2026-05-31
  originSessionId: 7d277528-b1ec-45be-9920-e71596c528e4
---

# A "not found" error can be a MASKED bad-column select error

## The bug (2026-05-31, Attribyte committee panel)
The committee panel reported "Opportunity <uuid> not found in workspace" for an
opportunity that PROVABLY existed (verified by direct SQL: 1 row, right
workspace). Root cause was NOT a missing row. It was:

  supabaseAdmin.from('opportunities').select('id, ..., closed_at').single()

`closed_at` does not exist on the table (real column: close_date). Supabase
returned {data: null, error: <column does not exist>}. The handler guard was:

  if (oppError || !opp) throw new Error(`Opportunity ${id} not found in workspace`)

So a COLUMN error got rethrown as a NOT-FOUND message. The misleading message
sent me chasing id-mismatch and PostgREST-embed theories (one of which I even
shipped as a wrong fix, #113) before reading the actual select column list.

## The rule
When a "<thing> not found" error fires but you can prove the row EXISTS:
1. Don't trust the message. A `{data:null}` from supabase has TWO causes:
   genuinely-absent row, OR a query error (bad column, bad RLS, bad cast).
2. Read the `.select('...')` column list and diff it against the REAL schema
   (information_schema.columns). A single non-existent column nulls the whole row.
3. Fix the guard too if you own it: log `oppError` separately from `!opp` so a
   query error never again masquerades as not-found:
     if (oppError) throw new Error(`query failed: ${oppError.message}`)
     if (!opp) throw new NotFoundError(...)

## Generalizes
Any ORM/query builder that returns null-on-error (supabase .single(),
.maybeSingle(), some Prisma findFirst patterns) will turn a schema mistake into
a domain-level "not found". The column list is the first thing to check, not the
last. Verify select columns against live schema the moment you add a new query
against an existing table.
