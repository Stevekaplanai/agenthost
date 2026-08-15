---
name: extended-thinking-disabled
description: Extended thinking disabled by default to save 15-25K tokens per routine session
metadata: 
  node_type: memory
  type: feedback
  priority: high
  savedDate: 2026-06-06
  originSessionId: 854ba2db-b1b4-4b60-9525-bc41b956162f
---

# Extended Thinking Disabled by Default

**Rule:** `alwaysThinkingEnabled: false` in settings.json (set 2026-06-06).

**Why:** Extended thinking reserves up to 31,999 tokens for internal reasoning on EVERY turn, even routine edits, file reads, and tactical work. For 90% of tasks (single-file edits, code reviews, simple builds, document creation), this is overkill and wastes 15-25K tokens per session.

**How to apply:**

- **Leave it OFF by default.** Don't enable globally.
- **Enable per-task only** when genuinely needed:
  - Complex architectural decisions (system design, major refactors)
  - Deep reasoning tasks (multi-file logic flow, tricky debugging)
  - Research + synthesis (adversarial verification, multi-perspective analysis)
  - Use Alt+T / Option+T to toggle within a session if a task needs it mid-conversation.

**Verification:** When tempted to enable, ask: "Does this need me to think through multiple possibilities or trace complex interactions?" If no, leave it off.

**Savings:** ~15-25K tokens per routine session (5-8x impact of other optimizations).
