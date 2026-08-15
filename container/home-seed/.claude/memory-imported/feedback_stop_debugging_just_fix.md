---
name: stop-debugging-just-fix
description: "When Steve reports something is broken, fix it immediately — don't add logging, debug endpoints, or ask clarifying questions. Ship the fix."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: d015ae85-f41a-4315-bb08-994a91f55268
---

When Steve says something is still broken, fix the root cause and ship. Do NOT:
- Add logging and ask him to check logs
- Create debug endpoints and ask him to hit them
- Ask him to clarify what "wrong" means
- Add diagnostic tooling as a first step

**Why:** Steve said "and don't ask again" twice in one session (2026-05-21) when I kept adding debug infrastructure instead of fixing the actual problem. He wants the fix shipped, not a diagnostic conversation.

**How to apply:** On "X is broken" → trace the most likely root cause from the code, fix it, commit, push. If there are multiple plausible causes, fix ALL of them in one pass rather than fixing one and asking Steve to test. The cost of fixing something that wasn't broken is low; the cost of another round-trip is high.

Related: [[feedback_no_reverify_confirmed_items]]
