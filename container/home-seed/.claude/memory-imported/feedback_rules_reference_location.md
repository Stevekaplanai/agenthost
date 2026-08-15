---
name: feedback_rules_reference_location
description: Where moved rules files live after 2026-06-03 system prompt cleanup — reference vs auto-load
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 875fed2a-6d70-4659-bb4f-e1fb69b83394
---

8 rules files moved from `~/.claude/rules/common/` to `~/.claude/reference/common/` on 2026-06-03 to stop auto-loading them every session. They are preserved there for manual lookup.

Files in `~/.claude/reference/common/`:
- `agents.md` — agent orchestration patterns
- `coding-style.md` — code quality standards
- `development-workflow.md` — feature implementation pipeline
- `git-workflow.md` — commit/PR workflow
- `hooks.md` — hook system reference
- `patterns.md` — design patterns
- `security.md` — security checklist
- `testing.md` — TDD and coverage standards

Still auto-loaded (in `~/.claude/rules/common/`):
- `performance.md` — model selection + context window guidance

**Why:** Per the "system prompt = only what's needed every turn" principle. The 8 moved files apply only in specific coding/testing/commit contexts, already covered by corresponding skills (`coding-standards`, `tdd-workflow`, `security-review`, `commit-commands`). Keeping them in auto-load added ~287 lines of noise to every session.

**How to apply:** If a task requires these guidelines, read the file from `~/.claude/reference/common/<name>.md` directly, or invoke the corresponding skill.
