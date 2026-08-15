---
name: PDL credits cap → 402 payment_required
description: When prospect-intel returns HTTP 402 with "You have hit your account maximum", PDL is out of monthly credits. NOT an Apollo issue. Don't debug Apollo until PDL credits reset on the billing cycle.
type: feedback
originSessionId: f66c7dbc-5164-4165-a397-3c899bd5aa67
---
When `/api/admin/audits/[id]/prospect-intel` (or its UI) surfaces an error like:

> Prospect Intelligence person lookup failed (HTTP 402): `{"status": 402, "error": {"type": ["payment_required"], "message": "You have hit your account maximum for search (all matches used)"}}`

That's **People Data Labs** (PDL) returning out-of-credits, not Apollo. The pipeline order is PDL → Apollo enrichment, so when PDL fails first, Apollo never runs and `apollo_diagnostic` stays null on the result.

**Why:** Steve's PDL plan has a monthly search-credit cap. Once exhausted, all `/v5/person/search` and `/v5/company/search` calls return HTTP 402 with the payment_required type. Credits typically reset at the start of the billing cycle (was last hit on 2026-05-10, refresh ~Friday).

**How to apply:**

1. **Don't debug Apollo, the merge logic, or the operator UI** when the panel surfaces this 402. The error is upstream of those layers. Apollo could be working perfectly and emails will still be empty because no contacts arrived from PDL.
2. **Tell Steve to either wait for the billing reset OR buy a PDL credit pack** at https://dashboard.peopledatalabs.com/billing.
3. **Confirm before resuming work**: ask Steve to check PDL dashboard for credit balance before re-running, or hit the apollo-debug endpoint (which uses Apollo only and bypasses PDL) to confirm Apollo is healthy on its own.
4. **Don't propose more code fixes** for the prospect-intel pipeline while PDL is over-cap — wait for the credits to refresh, then re-test with the existing fixes (PRs #147 / #148 / #150 / #151) which are already deployed.
