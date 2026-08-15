---
name: skill-checks-ambiguous-only
description: "Invoke skills only for ambiguous, multi-step, or genuinely novel tasks. Skip for routine/tactical work."
metadata: 
  node_type: memory
  type: feedback
  priority: high
  savedDate: 2026-06-06
  originSessionId: 854ba2db-b1b4-4b60-9525-bc41b956162f
---

# Skill Checks: Ambiguous + Complex Work Only

**Rule:** Reserve skill invocations for tasks that are genuinely ambiguous, multi-step, or novel. For tactical work you've seen before, execute directly without skill overhead.

**Why:** The `using-superpowers` skill and related gating are designed to ensure you approach *novel* problems systematically. But invoking a skill for every change (even single-file edits, code reviews, simple builds) adds unnecessary context overhead—reading the skill, following checklists, waiting for feedback—even when the path is already clear.

**How to apply:**

**Invoke a skill when:**
- The request is ambiguous and could be solved multiple valid ways
- It's a multi-step problem with complex dependencies (design system overhaul, large refactor)
- It's novel—something you haven't tackled before in this context
- Steve explicitly names a skill ("use /brainstorming" or "run the debugging flow")

**Skip skill checks when:**
- The task is tactical and the path is obvious ("add a button", "fix typo", "update config")
- Steve has already named the approach ("bump the version number", "add validation to the form")
- It's a repeat of work you've done before in this session or recent context
- A single tool/skill wouldn't materially change the execution path

**Verification:** Before invoking a skill, ask: "If I skipped this skill, would I end up doing something materially different or worse?" If no, skip it.

**Savings:** ~0.5-1.5K tokens per avoided skill invocation (lower impact than thinking/ToolSearch, but compounds across many small tasks).

**Related:** [[skill-checks-ambiguous-only]] pairs with [[recap-major-milestones-only]]—both reduce ceremony overhead for routine work while preserving rigor where it matters.
