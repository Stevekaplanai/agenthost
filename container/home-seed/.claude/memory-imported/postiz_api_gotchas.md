---
name: postiz-api-gotchas
description: "Hard-won Postiz public API facts — no update endpoint, no first comment, and X silently strips full URLs"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 3c97a91a-28db-4cd8-b0d4-9d825fd2b1fb
  modified: 2026-07-31T18:01:32.078Z
---

Learned 2026-07-31 during the link-gate rebuild. All verified against the live API.

**1. There is NO update endpoint.** Postiz public API v1 supports create, list, delete,
delete-by-group, and change-status. No PUT/PATCH; a single-post GET 404s. **Editing a
scheduled post means delete + recreate.** Back up the full post JSON to disk first, and
prove the create payload on a `type: "draft"` throwaway before deleting anything real.

**2. There is NO first-comment / thread support.** LinkedIn's entire settings schema is
`__type`, `post_as_images_carousel`, `carousel_name`. Postiz's own docs state that multiple
`value[]` entries do NOT create threads or comments. Comments on published posts must be
added by hand in the platform UI.

**3. ⚠️ The X provider SILENTLY STRIPS full URLs.** A post body containing
`https://agenthost.space/whitepaper.html` is accepted (HTTP 201) and stored with the URL
REMOVED — no error, no warning. Position does not matter (trailing line or inline, both
stripped). **Fix: use a bare domain with no protocol** — `agenthost.space/whitepaper.html`
survives intact and X linkifies it anyway. Verified by probe. LinkedIn does NOT do this;
it keeps full URLs fine.

**4. X length is validated on RAW characters**, not X's own t.co rule (which counts any URL
as 23). A 293-char body with a 39-char URL is rejected `{"statusCode":400,"message":"post is
too long"}` even though X itself would count it as 277. Budget the full URL length.

**5. Always verify by re-reading the queue.** A 201 does not mean the content stored is the
content sent (see #3). Re-list and assert on the stored body.

**6. Encoding:** back up with Python/UTF-8, not PowerShell `ConvertTo-Json | Out-File`, which
mangled every em dash into U+FFFD. Rebuilding from that backup would have published mojibake.

Working tooling lives at
`C:\Users\User\Projects\agenthost-launch\04-social\linkgate-rebuild-2026-07-31\rebuild.py`
(staged: backup / test / delete / verify-delete / create / verify-create).

Related: [[feedback-no-em-dashes]] · [[feedback-postiz-exclusive]]
