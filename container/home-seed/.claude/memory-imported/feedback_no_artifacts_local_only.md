---
name: feedback-no-artifacts-local-only
description: "Steve revoked artifact publishing on 2026-07-28 — every deliverable is built as a local file on his machine, never a hosted page"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: c31bd7e5-94e9-4451-ace0-45acbfbb0957
  modified: 2026-07-29T00:31:57.662Z
---

**Steve, 2026-07-28 — this REVOKES and REPLACES the prior "artifacts over markdown" rule.**

> "Unfortunately your company was involved in some big news about leaking said artifacts.
> So I'm gonna have to ask you not to make those anymore. I want you to make everything
> exactly like you are. Just it has to be on my machine even if it's scrubbed."

**Do not publish artifacts.** No hosted pages, no shared URLs, no exceptions — including
for things that feel obviously harmless.

**Why:** Steve found AgentHost build documents he had shared sitting at 29 and 39 views.
Nothing damning in them, but they were internal build docs, and he has no way to know
whether search engines keep indexing content after it's deleted from an account. For a
solo operator whose only real moat is unshipped work, that exposure is not worth any
amount of convenience.

**What replaces it — the quality bar does NOT drop:**
- Build the exact same thing: designed, interactive HTML with real working controls,
  copy buttons, collapsibles, stateful checklists, considered typography and palette.
  He explicitly said "make everything exactly like you are." The craft stays.
- Write it as a **local file on his machine**, then deliver the path per Cardinal Rule 8
  (absolute path in a copy-paste block, plus `explorer /select, "..."` to open it) and
  attach the file to chat with SendUserFile where possible.
- Scrubbed is fine and encouraged — no secrets, no credentials, no private repo internals,
  no collaborator names, in local files too. Local is not a licence to be careless.
- A good scratch location for one-offs is the session scratchpad; anything he'll want
  again goes somewhere durable he chooses.

**Do not** suggest publishing as an option, or ask "want me to publish this too."
The answer is no, standing.

Related: [[feedback_full_urls]] (paths still get delivered completely), and the
now-superseded artifacts-over-markdown preference.
