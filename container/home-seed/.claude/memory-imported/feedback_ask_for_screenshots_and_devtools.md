---
name: feedback-ask-for-screenshots-and-devtools-when-stuck
description: "STANDING rule (Steve, 2026-05-31): when a UI bug is reported and Claude cannot reproduce it (auth-gated app, harness blank, viewport caps too narrow, etc.), ASK Steve for a screenshot + browser DevTools (Console + Network tab) BEFORE shipping a speculative fix. Steve: 'Please request these in the future if it'll help troubleshoot.' One round-trip with real evidence beats three rounds of guessing."
metadata: 
  node_type: memory
  type: working_preference
  created: 2026-05-31
  status: standing
  originSessionId: 90ef0f0f-dc2b-475d-a0b9-344ffd5959db
---

# Ask for screenshots + DevTools when a UI bug can't be reproduced

## The rule (Steve, 2026-05-31)
> "Here are screenshots, still not working in any tab. Please request these in
> the future if it'll help troubleshoot."

When a UI bug is reported in a Steve-owned auth-gated app (Attribyte, GTMVP,
etc.) and Claude cannot reproduce it (auth wall blocks the deployed preview,
local no-auth harness renders blank, the screenshot tool caps too narrow to hit
the bug, etc.), the right next move is NOT another speculative code-path fix.
The right move is to ASK Steve in a tight, specific way for:
1. A SCREENSHOT of the broken view (full page, scrolled if needed).
2. The browser DevTools Console (any red errors / stack traces).
3. The browser DevTools Network tab for the relevant API call (status code,
   response body shape).

One round-trip with real evidence beats three rounds of "tsc clean + ship + Steve
still sees the bug + try again."

## How to ask
Tight and specific. Tell Steve exactly what to open and what to look for:

> Open DevTools (F12) on the Data-Driven tab. In:
> - **Console** — any red error messages?
> - **Network** — the request to `/analytics/data-driven-attribution` — status
>   code, and what does the response body look like?

NOT: "send me logs" / "what do you see" — those force Steve to figure out what's
relevant. Name the surface, name the network path, name the columns to check.

## When NOT to ask
- The bug is reproducible in Claude's own tools (HTML mockup, public preview,
  local harness that actually works).
- Steve has already provided the info needed.
- The fix is trivial / mechanical (typo, color swap, removed onClick).

## The Attribyte 2026-05-31 case (what triggered this)
Steve reported Data-Driven and Velocity tabs were empty. Three rounds of
"react-query timing" fixes shipped (#127, #128, #129) — all wrong direction.
Bug was actually: API succeeded and returned rows with all-zero values
(shapleyValue: 0, totalConversions: 0). `isEmptyList(rows)` returned false
because rows existed. The chart faithfully rendered zeros. Visually empty.
A single DevTools screenshot from Steve (Network 200, payload showing
channel names "direct", "display" not in the sample + all-zero values) made
the bug obvious in one read. #130 fixed it: added per-section `hasUsableX`
detectors that escalate "rows exist but no signal" to the sample fallback.

Lesson: **the never-blank rule needs 3 fallback triggers, not 2:**
1. Hook returned empty array.
2. Hook errored / data undefined.
3. Hook succeeded but data is all-zero.
This is the same shape of guard for any "live-vs-sample" data layer Claude
builds going forward.
