---
name: cardinal-rule-13-gate-consequences
description: Cardinal Rule 13 (2026-07-21) — the operator gates consequences not code; agent-review is the code-safety layer
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 1efbf18e-284b-4976-9884-d1ab9b389cce
  modified: 2026-07-21T05:14:35.939Z
---

# CARDINAL RULE 13: The operator gates consequences, not code

Added 2026-07-21 during AgentHost Phase 3 (git-ladder) design. Now in BOTH CLAUDE.md files
(global `~/.claude/CLAUDE.md` = full detail; project `C:\Users\User\CLAUDE.md` = condensed).
Rule count is now 0–13 (fourteen cardinal rules).

**The rule (Codex-refined headline):** "The operator gates consequences, not code.
Independently reviewed code merges autonomously. The human steers by plain-English intent
and intervenes only where business judgment is required."

**Why:** Steve cannot review code (not a programmer). A human gate staffed by someone who
can't evaluate the diff is a rubber stamp with latency, not safety. So agent review (a
different engine adversarially checking another's work) IS the code-safety layer — the human
gate is for CONSEQUENCES (deploy/spend/send/delete/credentials — Rule 2's list, unchanged),
where his business judgment is the relevant skill.

**How to apply:**
- Reviewed code (tests pass + independent engine approved) merges to a branch WITHOUT asking
  Steve to read a diff. Don't make him rubber-stamp merges.
- Still hard-gate every consequence in Rule 2's list. Rule 13 removes the FAKE gate, keeps
  every REAL one — the human gate gets sharper, not weaker.
- Steve steers by plain-English comment on a PR → the box turns it into a fix-task. Never
  hand him a diff or a merge conflict; resolve git mechanics for him.
- Never let an agent merge UNREVIEWED code or write straight to shared/main.

**On the box:** enforced by the git-ladder settings (Autonomy Level + Review Standard). Default
target = Level 5 / Standard review = reviewed code merges autonomously. Related:
[[agenthost-settings-wishlist-roadmap]]. Phase 3 UI mockups (Codex, v2) approved 2026-07-21 —
headline "Merge reviewed code automatically", "Your gate is consequence" green anchor.
