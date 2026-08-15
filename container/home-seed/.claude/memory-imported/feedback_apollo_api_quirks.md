---
name: Apollo API quirks (plan tiering, deprecation, key inheritance)
description: Five real gotchas discovered during the zxq autopilot build. Save hours next time someone integrates Apollo.
type: feedback
originSessionId: f66c7dbc-5164-4165-a397-3c899bd5aa67
---
Five things that bit during the zxq autopilot integration. Each cost ~30+ minutes of debugging.

## 1. API keys inherit the plan they were created under, NOT the current account plan

**Why:** Even after upgrading to Pro, an API key issued during Free-tier days will keep returning `error_code: API_INACCESSIBLE` on paid endpoints.

**How to apply:** When user upgrades Apollo plan, **regenerate the API key**. Look for "Master key" toggle in Apollo Settings → Integrations → API. Confirm new key works on `/mixed_people/api_search` before declaring success.

## 2. Cloudflare blocks Python `urllib` via TLS fingerprint

**Why:** `api.apollo.io` returns `403 Error 1010 — browser signature` to Python's stdlib HTTP client. `requests` and `httpx` hit the same wall. Mozilla User-Agent doesn't help — they fingerprint the TLS handshake.

**How to apply:** Shell out to `curl` (different TLS fingerprint, accepted). Pattern in `apollo_client.py` `_curl_post`. Same applies if you ever build Apollo integrations in Python again.

## 3. `/mixed_people/search` is DEPRECATED for API callers

**Why:** Apollo silently switched to `/mixed_people/api_search`. The old endpoint returns "deprecated for API callers" error. New endpoint returns OBFUSCATED data — `name=null`, `last_name_obfuscated`, but `first_name`, `title`, `id`, `has_email` flag.

**How to apply:**
- Search uses `/mixed_people/api_search` — returns metadata only, no email
- To reveal: call `/people/match` with the `id` from search → returns full record (1 credit per call)
- Total flow per lead: search (free) → reveal top 1-2 high-`has_email` candidates (1-2 credits)

## 4. `/organizations/enrich` requires DOMAIN, not name

**Why:** Calling `/organizations/enrich` with `organization_name` only returns `422: Required parameter 'domain' missing`. The endpoint is domain-only.

**How to apply:**
- Have a domain → use `/organizations/enrich` (free on most plans)
- Have only a name → use `/mixed_companies/search` with `q_organization_name` (Pro+ feature)

## 5. Free plan tier blocks search endpoints

**Why:** Free Apollo plan only allows `/organizations/enrich` (domain → metadata). Everything else returns `API_INACCESSIBLE`. Basic plan ($49/mo) unlocks `/people/match`. Pro plan unlocks all `/mixed_*_search` endpoints with credit-based reveals.

**How to apply:** When user reports "it doesn't work," ask their plan tier first. If Free, the answer is upgrade or accept manual web-UI lookups. Don't waste time debugging.

## Reference implementation

The full working flow lives in `C:\Users\User\Projects\zxq-dashboard\lib\apollo.ts` (TypeScript) and `C:\Users\User\Projects\upwork-scraper-data\apollo_client.py` (Python). Both handle these five gotchas correctly.
