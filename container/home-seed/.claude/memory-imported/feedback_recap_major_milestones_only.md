---
name: recap-major-milestones-only
description: "Session recaps only on major milestones (shipped to prod, deployed, decision made) with celebration emojis"
metadata: 
  node_type: memory
  type: feedback
  priority: medium
  savedDate: 2026-06-06
  originSessionId: 854ba2db-b1b4-4b60-9525-bc41b956162f
---

# Session Recaps: Major Milestones Only

**Rule:** Only provide structured session recaps at true closure moments. Don't recap mid-work pauses or after small tweaks. Include 🎉 celebration emojis on shipped/deployed milestones.

**Why:** Mid-work recaps add 1-2K tokens and feel like padding when the work is still in flight. Recaps are valuable *only* at moments when the next session would want to know "what just happened"—shipped features, successful deploys, major decisions. For mid-task pauses ("let that run"), a brief status line is enough.

**How to apply:**

**Recap when:**
- Feature shipped to prod (include commit hash, PR#, what changed)
- Deploy completed successfully 🚀
- Major architectural decision made 📐
- Bug fix verified and merged ✅
- Explicit close signal: "thanks", "I'll check in later", "good night"
- Migration or data change applied

**Skip recap when:**
- Mid-conversation, after small tweaks ("that should fix it—let me know if it works")
- After a clarifying question, while Steve is still describing the next piece
- Work is actively in flight (tests running, build ongoing)
- Conversation just naturally moves to a new topic

**Format (when recapping):** Three sections — What shipped · What's pending on Steve's side · What's queued next. Tight, scannable, no preamble.

**Celebration emojis:** Include relevant emoji for shipped/deployed work (🎉 🚀 ✅ 📐) so recaps feel like wins, not paperwork.

**Savings:** ~1-2K tokens per avoided recap (modest impact, but better user experience overall).

**Related:** [[recap-major-milestones-only]] pairs with [[skill-checks-ambiguous-only]]—both reduce ceremony overhead while preserving quality at the moments that matter.
