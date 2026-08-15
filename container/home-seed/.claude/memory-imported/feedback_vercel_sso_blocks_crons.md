---
name: Vercel SSO + Authentication blocks Vercel Cron jobs
description: Counterintuitive Vercel behavior — when Standard Protection is on for a project, it 307-redirects scheduled crons to the SSO login page. Crons silently fail.
type: feedback
originSessionId: f66c7dbc-5164-4165-a397-3c899bd5aa67
---
## What broke

Vercel cron jobs were "firing" (visible in logs) but returning HTTP 307 redirects to the Vercel SSO login page instead of executing the route handler. Every cron path looked like `responseStatusCode: 307` from `serverless-middleware` source. Looked like the crons were running but they were just bouncing off auth.

## Why

Vercel's "Standard Protection" / Vercel Authentication intercepts ALL incoming requests at the edge BEFORE the route handler runs. This is meant to gate preview deployments and private projects. Crons hit the SSO wall too — even though Vercel docs claim "cron jobs bypass deployment protection."

## Fix

**Disable SSO at the project level** if app-level auth is sufficient. Via Vercel REST API:

```bash
TOKEN=<from ~/AppData/Roaming/com.vercel.cli/Data/auth.json or `vercel login`>
curl -X PATCH "https://api.vercel.com/v9/projects/{projectId}?teamId={teamId}" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"ssoProtection":null}'
```

Or via dashboard: Project → Settings → Deployment Protection → toggle off.

**Then** add an app-level password gate (e.g., `proxy.ts` cookie check) for the dashboard UI, with explicit bypass for cron paths:

```ts
// proxy.ts (Next.js 16 — note: it's proxy.ts, NOT middleware.ts)
if (
  path === "/login" ||
  path === "/api/login" ||
  path.startsWith("/api/cron/") ||  // <-- crons need this
  path.startsWith("/api/gmail/") ||
  path.startsWith("/api/linkedin/") ||
  // ...
) return NextResponse.next();
```

Cron route handlers verify their own auth via `Authorization: Bearer ${process.env.CRON_SECRET}`.

## How to detect this fast

If a Vercel cron "fires" but does no work, check the runtime logs (`vercel logs --json`) for the cron path. If you see HTTP 307 with `source: serverless-middleware`, that's SSO bouncing it. The actual route handler never ran.

## Same trap for in-app middleware

Even after disabling Vercel SSO, the app's own `proxy.ts` (Next.js 16) / `middleware.ts` (Next.js ≤15) can do the same thing — redirect cron paths to a login page. Always allowlist `/api/cron/*` in the proxy.

## Reference

- Real instance: zxq-dashboard project (May 8, 2026). 4 days of autopilot crons silently bounced.
- Fix shipped in commits e1cfc1a (Vercel SSO disable) and a5ccff0 (proxy.ts bypass list).
