---
name: lesson-reminders-carry-expiring-claims
description: "A scheduled reminder is a snapshot of beliefs, not facts — verify every claim it makes before acting on it"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: c31bd7e5-94e9-4451-ace0-45acbfbb0957
  modified: 2026-08-03T14:09:27.679Z
---

A `claude -p` reminder (Cardinal Rule 2) freezes what was believed on the day it
was written and replays it to a session told "you have no memory of that
conversation." That framing makes the reminder's claims un-challengeable unless
the receiving session deliberately re-verifies them.

**The incident (2026-08-03, AgentHost git debt).** The Aug 2 reminder fired on
schedule and instructed: "the box agent cannot push to GitHub, 403 — this blocks
the entire git ladder; fix with a credential helper reading the box store."

Every part of that was wrong by the time it fired:
- The 403 was the **two-token security boundary working** (PRs #178/#179, landed
  Aug 1 — the day *before* the reminder was written). Building the credential
  helper would have re-opened the hole the A2 red-team closed.
- Item 5 (nav guard red) had been fixed by PR #183 before the reminder existed.
- The doc the reminder pointed at no longer existed at that path.

Nothing lied. The reminder was accurate when written and the work was real. The
system simply had no way to notice its own claims had expired.

**Why:** Made worse by the deliberate "you have no memory" framing — necessary for
a cold start, but it converts stale claims into unexamined instructions. Related:
[[feedback_fetch_live_repo_first]], [[reference_patsnap_phantom_citations]].

**How to apply:**
- Treat a reminder's factual claims as **hypotheses to check**, never as findings.
  One command per claim is usually enough (`git log --grep`, run the test, list
  the secret names).
- When a reminder's premise turns out false, **neutralize the reminder file** so
  it cannot re-issue the bad instruction — don't just ignore it. Spent one-shots
  in `C:\Users\User\.agenthost\reminders\` get a `REM` block explaining what was
  wrong plus `exit /b 0` above the original text.
- When *writing* a reminder, state claims with their evidence and date
  ("as of Aug 2, X was red — re-run `npm test` to confirm before acting"), so the
  receiving session knows what to re-check rather than what to believe.
- Extend the "never act on another session's git claims" habit to **documents and
  reminders**, not just branches.
