---
name: attribyte-has-TWO-railway-projects-celebrated-courage-is-prod
description: "Attribyte has two Railway projects both subscribed to the same GitHub repo (Stevekaplanai/attribyte). celebrated-courage is the REAL live prod. truthful-enjoyment is a stale duplicate being paused 2026-05-31, delete ~2026-06-07 if nothing breaks."
metadata:
  node_type: memory
  type: project_fact
  created: 2026-05-31
  review_after: 2026-06-07
  originSessionId: 7d277528-b1ec-45be-9920-e71596c528e4
---

# Attribyte: TWO Railway projects — celebrated-courage is prod

## The fact (verified 2026-05-31)
Attribyte's GitHub repo (Stevekaplanai/attribyte, single remote) is subscribed
to by TWO Railway projects. There is no Railway link committed in the repo
(railway.toml is generic, names no project) so both read the same config.

| Project | Role |
|---|---|
| **celebrated-courage** | THE LIVE PROD. Auto-deploys every merge. api service Online, serves `attribyteapi-production.up.railway.app`, owns the ClickHouse volume. Verified running PR #115 (last merge of the 2026-05-31 session). This is Steve's project. |
| **truthful-enjoyment** | Stale DUPLICATE. Subscribed to same repo but auto-deploy off/failing → had 21 pending (undeployed) changes = the ~20 PRs #96-115 merged this session. Owns no unique state. |

## Why no cross-contamination worry
I (Claude) never commit to Railway projects — I commit to the GitHub repo.
Railway projects subscribe to the repo. All session work landed in
celebrated-courage (the deployer). truthful-enjoyment just accumulated
undeployed commits. The "21 pending" was the tell.

## DB is safe either way
Both projects point at the SAME Supabase (kqpllsenlvdgsznptylb) via env vars.
The database lives in Supabase, NOT Railway. Deleting/pausing a Railway project
does NOT touch the DB.

## Decision (Steve, 2026-05-31)
PAUSE truthful-enjoyment now (stop its services / disconnect GitHub trigger so
it stops accruing + can't serve traffic). DELETE it ~2026-06-07 if nothing
breaks. Reversible-first.

## Custom domain note
Steve is adding api.attribyte.xyz custom domain to celebrated-courage (the
right project). Railway custom domains need BOTH: (1) Namecheap CNAME ->
railway host, AND (2) register the domain in Railway service Settings ->
Networking so Railway routes that hostname. CNAME alone is insufficient.

## Railway MCP auth
The railway MCP plugin token kept expiring this session (whoami -> "Not
authenticated. Run railway login"). A terminal `railway login` did NOT persist
to the MCP server session. If you need Claude to drive Railway (read logs,
add domains, pause services), get the MCP auth working first.
