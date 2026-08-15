---
name: cardinal-rule-verify-route-is-MOUNTED-not-just-imported-and-fingerprint-the-live-deploy
description: "When an API route 404s in prod but the code looks correct, check that the router is MOUNTED (app.use), not just imported. Imports can survive a merge while the mount line is dropped. And never trust 'deploy succeeded' - fingerprint the live commit via /health."
metadata:
  node_type: memory
  type: feedback
  severity: cardinal
  created: 2026-05-31
  originSessionId: 7d277528-b1ec-45be-9920-e71596c528e4
---

# CARDINAL RULE: A route 404 in prod = check MOUNT, not just import. And fingerprint the live deploy.

## The expensive lesson (2026-05-31, Attribyte opportunities route)
GET /api/v1/opportunities 404'd in prod for HOURS across ~6 "redeploys".
I repeatedly assumed it was Railway deploy lag and waited/nudged. Root cause
was a one-line CODE bug: in apps/api/src/index.ts the router was
`import`ed (line 49) but the `app.use('/api/v1/opportunities', opportunitiesRouter)`
MOUNT line was dropped during the #107 merge. The import surviving while the
mount vanished made every grep for "opportunitiesRouter" look fine (1 hit) and
tsc stayed green (an unused import is not an error). So the code "looked
correct" on origin/main while the route genuinely wasn't wired into Express.

## Two hard rules this produced

### 1. A 404 on a route whose file exists = verify it is MOUNTED, not just imported.
- `grep -c "xRouter" index.ts` should be **2** (import + app.use), not 1.
- An unused import is NOT a tsc error, so a dropped mount passes typecheck.
- Express 404 (NOT_FOUND from notFoundHandler) = route not registered.
  401 = auth middleware ran (route IS registered, just gated).
  500 = handler ran and threw. Read the status code; it tells you the layer.
- Merges can drop a line from a multi-line block (here: 3 app.use lines on the
  same path collapsed to 2) while leaving the import. Always re-grep the MOUNT
  after any merge that touched index.ts.

### 2. Never trust "deploy succeeded" - fingerprint the live commit.
The single most useful debugging move all session: add the running git SHA to
the unauthenticated /health endpoint:
  commit: process.env.RAILWAY_GIT_COMMIT_SHA || 'unknown'
(Railway injects RAILWAY_GIT_COMMIT_SHA; Vercel has VERCEL_GIT_COMMIT_SHA;
generic GIT_COMMIT_SHA/SOURCE_COMMIT as fallbacks.) Then `curl /health` tells
you EXACTLY which commit is serving. This instantly distinguishes:
  - "deploy is stale / still building" (commit field = old SHA), from
  - "deploy is fresh but the route is genuinely broken" (commit = new SHA, route still 404s).
Without the fingerprint I burned hours unable to tell deploy-lag from code-bug.
Bake a commit-SHA into /health on every deployed service from day one.

## Bonus: unauthenticated curl can't distinguish 404-from-missing-route vs
401-from-auth-on-a-sibling-router mounted on the same base path. When multiple
routers share a base (e.g. committeeRouter + opportunitiesRouter both at
/api/v1/opportunities), an unauth probe hits the first router's auth middleware
and returns 401 regardless. Use an AUTHENTICATED request (real session token)
or the browser to get the true status.
