---
name: gtmvp-audit-connection-verification
description: "2026-06-03 audit of GTMVP's Smart-Bidding/Leak-Report data connections vs the two AttriByte gotchas (API-version sunset, custom-OAuth-client token export). Core Google Ads path is clear; non-Google enrichment is at-risk (needs a live check). Separate codebase from AttriByte."
metadata: 
  node_type: memory
  type: project
  review_after: 2026-10-01
  originSessionId: b3598747-8d24-4c0e-98d6-6806ee9d4c29
---

**Context:** Steve asked whether gtmvp.com's audit connections are ready + free of the two gotchas AttriByte hit. GTMVP (`Projects\gtmvp-saasw\GTMVP_V0`) is a SEPARATE codebase from AttriByte with its OWN Pipedream stack (`lib/paid-media/pipedream.ts` + `pipedream-proxy.ts`, on the @pipedream/sdk 3.0.8 — uses `client.proxy.get/post`, cleaner than AttriByte's hand-rolled base64 proxyFetch). My session's connector work (AttriByte PRs #177-#184) did NOT touch GTMVP. Verified against origin/main (local was on `feat/leak-report-rebrand`, 4 ahead/1 behind; #267/#268 rebranded "Smart Bidding Audit"→"The Leak Report").

**DECISION 2026-06-03 (Steve) — Meta/Facebook audit data = PIPEDREAM, not Supermetrics.** GTMVP's Meta perf path was Supermetrics REST (currently OFF); Steve decided to pull Meta/Facebook via **Pipedream** instead (Meta Ads Connect proxy → Graph API with `ads_read`/`read_insights`, same proxy pattern as the Google Ads relay). README updated + committed (`018afbb` on branch `feat/leak-report-rebrand`, README.md only, unpushed — rides Steve's branch or cherry-pick): tech-stack now documents the Pipedream paid-media/data-connection layer; `NEXT_PUBLIC_META_AUDIT_ENABLED` gate reflects "Pipedream Meta reader built" (not "Supermetrics read real"); `SUPERMETRICS_API_KEY` marked deprecated. **NEXT BUILD (not done): the Pipedream Meta reader** — a `lib/paid-media/meta.ts` that pulls Meta campaign/insights via `client.proxy` against the Graph API (mirror AttriByte's meta-ads-adapter: current Graph version, ads_read+read_insights scopes, the act_<id> from meta-account.ts). Supermetrics (`supermetrics.ts`, the FA data source) is being retired for Meta.

**GOTCHA 1 — API version sunset: CLEAR.** Google Ads on **v21** (`lib/paid-media/google-ads.ts:20`) — current (v22 latest; v21 in support). NOT the AttriByte v15/v18 sunset. Meta perf data is via **Supermetrics REST** (no `graph.facebook.com`, no Graph version to sunset). P3 (low/non-urgent): calendar a v21→v22 bump before v21's eventual sunset (~late 2026/2027) — single constant.

**GOTCHA 2 — custom-OAuth-client / raw-token-export: IMMUNE for data pulls, AT-RISK for ID resolution.**
- Data pulls (Google Ads via the `googleads.m.pipedream.net` relay; Shopify; CRM Salesforce/Pipedrive/HubSpot/Close) all go through `client.proxy.get/post` → Pipedream injects the credential server-side, NO raw token exported → IMMUNE. Google Ads (the headline audit) fully immune.
- **AT-RISK:** `meta-account.ts:71`, `shopify.ts:71`, `crm.ts:163` call `client.accounts.retrieve(accountId,{includeCredentials:true})` to read ROUTING fields (shop subdomain, SF instance_url, Pipedrive api_domain). NO custom `oauthAppId` is configured anywhere → GTMVP is on Pipedream's DEFAULT client, and `includeCredentials` is exactly what AttriByte found the default client may NOT populate. If empty → Shopify/SF/Pipedrive enrichment **silently no-ops** (every reader is catch→null, degrades to "not connected" — does NOT break the audit). Runtime-unconfirmed.

**Dev token: OK** — GTMVP holds NO Google Ads developer token (no `GOOGLE_ADS_DEVELOPER_TOKEN`); Pipedream's managed Google Ads connector injects its own. Removes that whole failure class (vs AttriByte's dev-token saga). Caveat: depends on Pipedream's dev-token tier/quota — live-run unknown.

**Connect flow: SOUND** — `connect-token` mints under server-derived `sba_${leadId}` (ignores client externalUserId; signed `sba_lead` cookie via verifyLeadOwnership; no IDOR). Proper awaits, graceful catch→null, rate-limited, `withPipedreamRetry`. Actively developed (commits through June 2026), 74 tests across 7 files, no stubs/TODOs in the path. House Google Ads account (`gtmvp_house`) = operator's own, Keyword-Planner-only, separate from per-lead audits.

**Meta audit = OFF by design** (`NEXT_PUBLIC_META_AUDIT_ENABLED` off + `SUPERMETRICS_API_KEY` unset in Vercel). The Facebook panel never appears today.

**NEEDS A LIVE RUN (can't verify statically — auth-gated):** (P1) smoke-test the Google Ads pull — connect one real Google Ads account via the funnel → `/api/pipedream/google-ads/run` — confirms the relay body shape + dev-token tier + v21 responses; THE gate. (P2) confirm `includeCredentials` returns routing fields on the default client for Shopify/SF/Pipedrive, else configure a custom Pipedream OAuth client (`oauthAppId`) for those apps.

**Verdict: core Google Ads audit is ready pending one live smoke test; non-Google enrichment may silently no-op until P2 is confirmed (fails safe). No code changed — verification only.**

Related: [[gtmvp_attribyte_handoff_capi_build]] · [[gtmvp_repo_canonical_paths]] · [[attribyte-tracking-integrations-elevar]]
