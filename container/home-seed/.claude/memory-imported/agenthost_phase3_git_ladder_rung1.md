---
name: agenthost-phase3-git-ladder-rung1
description: "AgentHost Phase 3 git-ladder rung 1 (commit-local) — passed on-box Linux red-team gate 2026-07-21, deployed dormant (autonomy default 0). Rungs 2-4 still stubbed."
metadata: 
  node_type: memory
  type: project
  review_after: 2026-08-15
  originSessionId: b7ef5684-d2c5-4de6-86af-a135ce5a46dd
  modified: 2026-07-21T07:21:27.612Z
---

**AgentHost Phase 3 git-ladder — RUNG 1 (commit-local) GATE PASSED + DEPLOYED (dormant), 2026-07-21.**

The hard gate held: the git-ladder test suite ran **on the actual Linux box** (agenthost-steve on Fly), **15/15 pass, 0 skipped**. The two that matter: `REAL JAIL: only the selected worktree is writable on the host` (the jail-bind scope test — host-RCE writable-jail closure confirmed on real Linux, not just theory) and `credential helper receives the token on fd 3, never through env` (fd-3 token broker verified). The deal was honored: nothing dangerous deployed until an adversarial check passed first (Cardinal Rule 13).

**What shipped:** merged branch `phase-3-git-ladder` → `settings-backbone` (`--no-ff`, unioned the hardened code with the PASS/FAIL docs + Phase 5 stub — disjoint files, zero conflicts). Hardened files: `container/gate.js`, `container/git-credential-agenthost`, `container/Dockerfile`, `container/settings-lib.js`, `test/git-ladder.test.js`. Deployed from settings-backbone to agenthost-steve. **Autonomy stays default 0 — rung 1 is present but DORMANT; Steve opts in per-use.** Branch NOT yet merged to main (deployed direct from settings-backbone by Steve's choice 2026-07-21).

**Bug the on-box run caught (real, not artifact):** `container/git-credential-agenthost` was tracked in git as `100644` (non-executable); only the Dockerfile's runtime `chmod +x` made it runnable in the container, so a raw checkout / the test hit `Permission denied`. Fixed by setting the exec bit in git itself (`git update-index --chmod=+x` → `100755`, commit `8c7fda5`). Now correct at source — checkout, test, and container alike; Dockerfile chmod is now redundant belt-and-suspenders.

**DO NOT wire rungs 2-4 (push/PR/merge) without their OWN red-team of the fd-3 token broker.** They are correctly guarded stubs — return `{error:"not yet wired"}` + audit event (test: "rungs 2-4 refuse explicitly and emit an audit-ready event"). Phase 4 (parallel agents) and Phase 5 (safe subagent spawning) are planned in `docs/` for after Phase 3 lands.

**How the box code updates:** via DEPLOY (container image), NOT a git pull — the box does not clone this internal repo for its own runtime code. To run tests on the box: `flyctl ssh console -a agenthost-steve`, then clone the branch from GitHub into /tmp with a runtime token and `node --test test/git-ladder.test.js`.

**Also on settings-backbone (same session, riding on top of rung 1):** Control Room "problem-card recovery menu" feature (commit `d5bdd45`, Codex-built, clean — own 2 tests pass) + a surgical follow-up (commit `3230625`) fixing 4 PRE-EXISTING red UI tests (NOT caused by the feature): board tile default-open (`cc.html` `tile`→`tile open`), chat.html re-add `#brand` as a SHRINKABLE/ellipsized item at phone width (element exists so legal-brand JS doesn't crash, WITHOUT reintroducing the 5-button 390px header squeeze — Steve's history warning), + 2 stale test strings (terminal→claude label, `/`→`/?window=shell`). 62/62 UI checks green (widths+labels validated both brands @390/375/360, per Steve — not just the green count). Team model proven: Claude diagnosed (2 real bugs, 2 stale tests) → Codex built → Claude reviewed → human deploys. Branch NOT on main yet (deployed direct). `docs/handoff-cc-ui-test-fixes.md` has the full fix brief incl. the header-history trap.

**LEAKED TOKEN (2026-07-21) — RESOLVED:** a live classic GitHub PAT (`ghp_...`) was embedded in the origin remote URL and printed to a session. Steve ROTATED it same-day (revoked old, fresh fine-grained PAT stored via credential helper, not in git config). Reminders removed. Closed.

Repo: `C:\Users\User\Projects\agenthost-internal` (GitHub Stevekaplanai/agenthost-internal, private). Team model: Claude=point/review, Codex=build/red-team, Hermes=QA, git=shared board. See [[agenthost_v2_autonomy_security_gate]], [[agenthost_social_gate_exception]].
