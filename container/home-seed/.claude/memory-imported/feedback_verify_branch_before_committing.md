---
name: feedback-verify-current-branch-before-committing
description: "Lesson (2026-05-31): ALWAYS run `git status -sb` / `git branch --show-current` and confirm you are on the intended branch BEFORE committing or pushing. In the Attribyte dashboard session, Claude assumed it was on a freshly-created dashboard branch but was actually still on a pre-existing branch (claude/fix-public-key-tracking-snippet-FS6Lj); the `git checkout -b` had silently not taken / been on a different branch. All commits stacked onto the wrong branch, every `git push` said up-to-date for the assumed name, and `gh pr list` returned [] - which Claude initially misread as a network problem. Root cause was never verifying the actual current branch."
metadata: 
  node_type: memory
  type: lesson
  created: 2026-05-31
  status: active
  originSessionId: 46177cb5-ffda-4d60-a3f4-05eaf2a8a897
---

# Verify the current branch before committing/pushing

## What happened (Attribyte dashboard redesign, 2026-05-31)
- Intended to work on a new branch `claude/dashboard-design-directions-FS6Lj`.
- The branch was actually never the checked-out branch (HEAD stayed on the
  earlier `claude/fix-public-key-tracking-snippet-FS6Lj`). All 5 dashboard
  commits stacked onto that earlier branch.
- Symptoms that were MISREAD:
  - `git push origin claude/dashboard-design-directions-FS6Lj` -> "Everything
    up-to-date" (because that remote branch existed at origin/main and local
    HEAD was a *different* branch, nothing to push).
  - `gh pr create` -> "No commits between main and
    claude/dashboard-design-directions-FS6Lj".
  - `gh pr list` -> `[]`.
  - These were initially blamed on a network blip. The real cause was the wrong
    current branch.
- Fix: `git status -sb` revealed the true branch. Created a correctly-named
  branch AT the current HEAD (`git branch <name>`), pushed that, opened the PR.

## The rule
Before ANY commit or push in a multi-branch repo:
1. `git status -sb` (first line shows `## <branch>...<upstream>`) or
   `git branch --show-current`. CONFIRM it matches the intended branch.
2. After `git checkout -b <name>`, verify the switch actually happened (read the
   "Switched to a new branch" line; if a branch by that name already exists the
   checkout fails and you stay put).
3. If a push says "up-to-date" or "Everything up-to-date" when you KNOW you have
   new commits, do NOT assume network. Check `git log --oneline origin/main..HEAD`
   and `git branch --show-current` FIRST.
4. If `gh pr create` says "No commits between main and X," the branch X at origin
   does not contain your commits. Check which branch your commits are actually on
   (`git branch -r --contains <sha>`).

## Related discipline
This compounded with a second self-correction in the same session: do NOT claim
a render/preview succeeded without reading the actual tool result. A blank
screenshot + "No text content found" is a FAILED render, not a success. State
verification status honestly (tsc-clean and build-clean != visually-confirmed).
