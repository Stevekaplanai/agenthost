---
name: cardinal-rule-fetch-live-repos-before-any-work
description: "When Steve points at a live/remote repo, git fetch and re-baseline against origin BEFORE researching, planning, or building. Never run work against a stale local clone."
metadata: 
  node_type: memory
  type: feedback
  severity: cardinal
  created: 2026-05-30
  originSessionId: 46177cb5-ffda-4d60-a3f4-05eaf2a8a897
---

# CARDINAL RULE: If Steve sends a live repo, USE IT (fetch first)

## The rule
Before doing ANY research, planning, code assessment, or implementation against a
repository that has a remote: **`git fetch origin` and compare local vs origin/main FIRST.**
If local is behind, reset/pull to the real current state before spending any tokens.
Never assume the local clone is current.

## Why this exists (2026-05-30, the expensive lesson)
During Attribyte Phase 1, Claude ran a 5-agent gap-analysis fan-out (~3.7M tokens)
plus a full integrity-fix workflow (~2.7M tokens) against a LOCAL clone that was
**~50 commits behind origin/main**. An autonomous agent the Attribyte platform itself
launched (recommendation-triggered: "Handle insufficient data scenario results") had
already shipped REAL implementations of nearly everything Phase 1 "fixed":
- #92 real ridge + bayesian MMM (we only "disclosed OLS as heuristic")
- #87 real NNLS synthetic control + permutation p-values (we only "gated it off")
- #89 real budget optimization + MAPE confidence intervals
- #88 removed Math.random from predictions
- #85 Stripe billing, #93 Atlas insight cards wired

Result: the entire Phase 1 code effort was wasted motion. It was only caught at the
`git push` rejection (non-fast-forward). Had Claude force-pushed, it would have
REVERTED real Bayesian regression back to a heuristic stub. Tokens + time burned;
nothing of value from the code work survived (only the additive docs/DECISIONS.md +
trust-kit were kept).

## The discipline that saved it (keep doing this)
- Verified before the irreversible push instead of force-pushing.
- Reset onto their work, never over it.

## What to do every time, going forward
1. `git fetch origin` immediately when a repo is named/handed over.
2. `git log main..origin/main --oneline` — if anything is there, re-baseline first.
3. THEN research/plan/build against the real current state.
4. For Attribyte specifically: the platform can auto-launch its own agents that commit
   to main. Always assume main may have moved. Fetch before every work session.

## One-line version
**Steve hands you a live repo = fetch it and work against origin, not a stale local clone. Always.**
