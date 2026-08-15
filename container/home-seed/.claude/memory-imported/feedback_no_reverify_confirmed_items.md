---
name: no-reverify-confirmed-items
description: Never list as pending something Steve has already confirmed is done — specifically Vercel env vars and other infrastructure Steve manages directly.
metadata: 
  node_type: memory
  type: feedback
  originSessionId: d015ae85-f41a-4315-bb08-994a91f55268
---

Never re-list items as "pending on your side" when Steve has already confirmed they're done. Specifically: Vercel env vars, Supabase secrets, and other infra Steve manages in dashboards. If Steve confirms it, remove it from the pending list and don't resurface it.

**Why:** Steve confirmed Vercel secrets were active and I listed them as pending anyway — caused visible frustration.

**How to apply:** Before writing a "pending on Steve's side" section in a session recap, check whether Steve already confirmed the item earlier in the session or in a prior message.
