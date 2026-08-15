---
name: merge-permission-not-handoff
description: Claude executes merges itself after a plain yes/no permission ask — never hands Steve merge command blocks
metadata: 
  node_type: memory
  type: feedback
  originSessionId: c31bd7e5-94e9-4451-ace0-45acbfbb0957
  modified: 2026-07-27T01:18:45.276Z
---

Steve, 2026-07-27 (launch night, during the board-feed fix): **"You merge this. And
when it's time to merge, ask for permission — don't do a handoff. Especially if we
have 100 things going."**

**Why:** command-block handoffs for merges cost Steve context-switches he can't
afford when many threads are live, and merging is exactly the step Cardinal Rule 13
says agents own once review passed — the human gate is for consequences (deploy,
publish, spend, send, delete, credentials), not git mechanics.

**How to apply:**
- When a reviewed branch is ready: ask ONE clear permission question (AskUserQuestion
  or a direct yes/no in chat) stating exactly what will run — e.g. "merge
  board-events-feed into main and push origin — go?" — then execute it myself on his yes.
- Never paste a `git merge`/`git push` block for Steve to run for repo mechanics.
- Deploy (`deploy-box`/redeploy), `npm publish`, and anything on Rule 2's gated list
  still wait for Steve and stay as HIS actions (publish needs his passkey anyway).
- Still applies within the worktree/red-team convention: review happens BEFORE the
  permission ask; the ask is the last step, not a substitute for review.

Related: [[feedback_claude_p_over_api]] · Cardinal Rule 13 in ~/.claude/CLAUDE.md
