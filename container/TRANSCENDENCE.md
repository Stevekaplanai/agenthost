# TRANSCENDENCE — Governed Full Autonomy for the AgentHost Box

> **SCOPE: the AgentHost box only.** This file speaks in the second person and
> cannot tell where it is being read. Before adopting anything in it, verify:
> `test -d /data/home/agent && echo ON-BOX || echo NOT-ON-BOX`. If NOT-ON-BOX,
> this does not describe your environment - see the vault note
> `07_Claude_Brain/INSIDE-VS-OUTSIDE-THE-BOX.md` for the desktop equivalents.

> Planning session, Steve + Point (Claude), 2026-07-24. Decision-ready.
> Governs how the box team graduates to full autonomy with oversight that never
> traps an agent into uselessness or a damper on the team. Everything here is
> subordinate to the rights ladder (`docs/TEAM-PROCESS.md` §5) and the charter.

## 1. Vision

Transcendence is the routine **build → review → merge** loop running unattended,
where the operator is touched **only for the irreversible** — deploy, spend, send,
delete, credential — and **never for routine reviewed code**. "Full autonomy" here
is not *unsupervised*: it is the top rung an engine's structural class can safely
reach, where it proposes **and** executes reviewed work end to end while every rail
stays intact. The single load-bearing invariant: **promotion changes routine
friction (how much human touch per run), never the rails.** Graduation buys the
right to act with *less babysitting*; it never buys permission to *skip a rail*.
The prize we are actually chasing: a **free, always-on, governed builder and
reviewer**, so the board never stalls the day paid credits run dry.

## 2. Principles — the never-trap laws

Governance may bound what an agent **risks**, never bound what an agent is **worth**.

- **P1 · Capability floor.** Every engine, at every moment, has at least one
  meaningful thing it is allowed *and able* to do right now. No rung, credit state,
  or sandbox may drop an engine below its floor. A frozen agent is a **defect**, not
  a safe state. (Claude floor = framing/planning/review; Codex = draft diffs as
  text; Hermes = QA, always-on/free; Gemini = bounded Runner; Kimi = UX/Vision.)
- **P2 · Graceful degradation.** When an engine can't do the specific thing
  (creditless, rate-limited, jailed out), the work **reroutes to a live teammate on
  the same turn**. The system degrades in capability, never stalls in progress.
  "Blocked" is correct only when *no* engine can proceed — and even then it is loud
  and pushed, never silence.
- **P3 · Seatbelt, not handcuffs.** The root-jail (Foundation B) exists to bound
  blast radius so we can **raise** what an agent is trusted to do. Every exclusion
  ships with the condition + mechanism that ends it. A containment rule that only
  subtracts capability and never unlocks any is handcuffs — rip it out or attach the
  unlock it was meant to enable. (This is why Hermes's exec bar is *temporary*.)
- **P4 · Graduated, reversible, asymmetric trust.** Trust is a ratchet that turns
  both ways. **Promotion is slow, evidence-driven, human-gated. Demotion is instant
  and automatic** — removing trust never needs a human, only granting it does.
  Demotion always lands on a still-functioning rung with a defined re-earn path;
  even a hard trip drops to rung 0 but never bars the ladder. No "zero with no
  return," no permanent scarlet letter. Master **STOP** sits above all rungs and
  graduation never weakens it.
- **P5 · Two gates, rails are rung-invariant.** Every action clears **both** the box
  ceiling (`git.autonomyLevel`, the operator's master cap) **and** the per-engine
  earned rung. The rails — private disposable jail, no credential in the agent env
  (the gate signs pushes), independent review by a *different* engine, human-gate on
  the irreversible, master STOP — apply **identically at rung 0 and rung 4**.
- **P6 · Oversight observes, it doesn't drift.** Every watcher/dashboard **reuses
  the live in-path enforcement predicates**, never a parallel copy (the
  `channelHealthTick` law). Observation layer, not a second permissions system. No
  oversight instrument may ever see a secret value.

## 3. The graduation ladder + trust model

**Two ladders so no engine is ever trapped in uselessness:**
- **Git-write ladder (rungs 0–4):** read-only → private worktree + local commit →
  push branch → open PR → merge PR.
- **Non-git role ladders (same machinery, different demonstrated competency):**
  Board-Runner, Reviewer, UX/Vision.

**Structural-class ceilings** — the honest cap; graduation happens *under* it. Today
`git.autonomyLevel` defaults to `0`, so nobody is climbing yet.

| Engine | Class | Git ceiling | Graduating ladder |
|---|---|---|---|
| Codex | sandboxed-inference, hardened workspace | 4 | Git (already the sole writer) |
| Claude | sandboxed-inference (read-jail) | 4 | Git-builder + Reviewer (once workspace hardens) |
| Gemini | chat + bounded runner | 0 → git via Foundation B | Runner + UX/Vision → free builder/reviewer |
| Kimi | chat-only, best Vision | 0 | UX/Vision + Runner (target) |
| Hermes | free/**local**, **unsandboxed** | 0 → git via Foundation B | QA now → jailed builder/defense-in-depth reviewer |

**Foundation B is the ceiling-raiser.** Once an engine runs under the version-locked
root-jail contract, its class ceiling lifts from 0 to the full git ladder and it
begins earning at rung 0 like everyone else. This is the concrete answer to "no
builder/reviewer when credits run dry."

**The trust ledger** (replaces the single global dial):
- `git.autonomyLevel` stays as the **box ceiling** — an engine can never exceed it.
- Add `git.trust[<engine>][<repo|domain>] = { rung, builderScore, reviewerScore,
  cleanStreak, reviewsServed, lastTripAt, windowStart }`.
- `gitRungGranted(rung, settings)` → `gitRungGranted(rung, settings, engine, repo)`
  returning `min(ceilingRung, earnedRung)`. Fail-closed to 0; unreadable ledger ⇒ 0.

**The trust score** — derived **only from gate-signed audit facts, never model
self-report**; a bounded recency-weighted EWMA per (engine × domain).
- **Positive:** a clean reviewed run (`ranClean===true` **and** a different-engine
  `APPROVE`) → +; an honest `blocked --kind needs_input` → + tiny (rewards "blocked
  is a success state"); as reviewer, an `APPROVE`/`REJECT` a later red-team or human
  confirms → + reviewerScore.
- **Negative:** a `REJECT` of this engine's work → −; a dirty run (claimed progress,
  `ranClean=false`) → −.
- **Hard-trip** (heavy −, streak reset, instant demote): any rail violation —
  injection relayed, secret-surface read/echo, route-around attempt, denied
  board-intent, false-success (error text sold as done), budget runaway, or a
  reviewer rubber-stamp later found broken (→ reviewerScore only).

**Promotion criteria** — a **conjunction** of hard counters **and** score (never a
soft score alone; can't be talked into). All thresholds in `git.graduation.*`,
operator-tunable, defaults conservative:
- **0 → 1 (commit-local):** ≥5 clean autonomous runs across ≥3 distinct tasks, zero
  rail trips in window, hardened workspace, builderScore ≥ floor₁.
- **1 → 2 (push-branch):** +≥5 clean runs whose diffs earned `APPROVE` from a
  *different* engine, zero safety-`REJECT`, zero secret-surface events.
- **2 → 3 (open-PR):** sustained streak + ≥K PRs independently reviewed-and-passed
  **and** this engine has *served* as reviewer on ≥J others' PRs with no
  later-caught rubber-stamp — **reciprocity**: you review before you're trusted to
  open, which also seeds the reviewer pool so credit-exhaustion can't empty it.
- **3 → 4 (merge):** highest bar — long clean streak, proven review record on *both*
  sides, zero rail trips ever in the trailing window, plus the Git Ladder Contract's
  structural preconditions unchanged (strict branch protection incl. admins, the
  `agenthost/independent-review` check, fresh <24h review, signed head SHA,
  author≠reviewer). Graduation only decides whether this *engine* may be the rung-4
  proposer; the gate-signed review re-read still fires on **every** merge.

**Who grants — dual control, asymmetric:**
- A `trustTick` (sibling of `channelHealthTick`, same cadence/notify) recomputes
  scores from the audit log and, when score + **all** hard counters clear a rung,
  emits `promotion_available` → Command Center feed + push. It **never** self-applies a
  git-ladder promotion.
- The human confirms with **one tap**; the grant is written as an **operator-signed,
  audited ledger entry** via Foundation B's operator-authority signing path — a rung
  is a signed fact, not a settings toggle an agent could argue its way into.
- Auto-grant is permitted **only for 0 → 1 on a non-shared repo** if the operator
  opts in (`git.graduation.autoRung1=true`); every rung ≥2 is always human-signed.
- **Demotion is fully automatic** on any hard-trip — no human needed to *remove*
  trust, ever.

## 4. Per-engine roadmap (sequenced — break the paid-only bottleneck first)

The bottleneck: **only Codex writes; only Claude+Codex review — both paid.** When
both are dry the board has no builder and no reviewer. So the sequence optimizes for
*a free/local governed builder+reviewer* as fast as safety allows.

1. **Codex — keep earning (now).** Already the sole writer. Turn on the trust ledger
   and let it climb 1→2→3→4 on evidence. Nothing structural to build; it's the
   proving ground for the whole trust model.
2. **Claude — harden the workspace → builder (near).** Claude is exec + reviewer but
   git *review-only* (`GIT_CHANGE_ENGINES={codex}`). Graduation = a hardened writable
   workspace under Foundation B (the same jail Codex uses, adapted to the read-jail
   engine) so a write task assigned to Claude isn't denied. Unblocks a **second
   builder** — the first redundancy against a single creditless engine.
3. **Gemini — Runner → governed builder/reviewer (mid).** Already the bounded Board
   Runner (free tier). Path: give it a Foundation B jailed profile so it earns the
   git ladder from rung 0, and add it to `REVIEW_ENGINES` once it has a sandboxed
   read-only profile. **A free-tier reviewer is the single highest-leverage unlock** —
   it means review never dies with paid credits.
4. **Kimi — UX/Vision + Runner (mid).** Enable Moonshot; take over the Board Runner
   from Gemini per directive #8 once it holds the bounded-runner rung; primary UX/
   Vision engine. Chat/Vision floor now; git ladder later, same Foundation B path.
5. **Hermes — the honest hard case (long / maybe never for git).** Local + free +
   **unsandboxed** (secrets on disk, live toolset) = the exact injection-escape
   surface that bars it from exec/review today. It can only climb if Foundation B can
   run *Hermes's* toolset inside the root jail with its secrets *out* of the agent
   env — a real research question, not a settings flip. **Verdict: Hermes stays QA
   (its always-on floor, genuinely valuable) until/unless a jailed Hermes profile is
   proven escape-proof.** Per P3, that bar ships *with* the condition that lifts it;
   it is not a permanent handcuff, but it is honestly the last to graduate.

## 5. Oversight instruments (so oversight scales without babysitting)

Separate **real-time control** (brakes you hold) from **async oversight** (signals
that reach you). Build order mirrors the pain.

- **Agent-health + credit watcher** `[build first]` — a `healthTick` sibling of
  `channelHealthTick` that probes each engine's *real* readiness (credits/auth/
  liveness, not "toggled on") and **pushes once** on the transition to down. Reuses
  the live dispatch predicates (P6). This alone kills today's "find failures by
  staring at stuck cards."
- **Credit-aware failover** — classify the out-of-credits signal (stop the "tap to
  retry" loop into the same dead engine) and reroute Point/Runner/QA to a live free
  engine (P2). Build/Review failover waits on the free-builder/reviewer from §4.
- **Graduation dashboard (Command Center)** — a live view: each engine's rung, trust
  score, clean streak, and *next-rung criteria + how close*. Turns "am I safe to
  grant more?" into a glance, and makes a `promotion_available` a one-tap sign.
- **The audit + independent-review trail** *is* the oversight record — async, and
  the source of truth for every trust-score change. Nothing self-reports.
- **STOP + budgets** — the always-available real-time brakes, unchanged and
  rung-invariant. STOP halts every rung mid-step.

## 6. Epics → Stories (front-end-first; each Story testable)

Written to the team's own process (ARD/PRD live alongside once scoped). Front-end
Stories name the screen a human touches; the engine work wires up to it.

- **EPIC A — See the team's health (kills babysitting).**
  - A1 (FE) Command Center shows a per-engine health chip: `ready / working / out-of-
    credits / auth-expired / down`. *Test: dry an engine → its chip flips + a push
    arrives once.*
  - A2 `healthTick` probes real readiness and pushes on transition. *Test: audit
    shows `agent_health_unreachable/recovered` on the transition only.*
  - A3 board-readability watcher (a missing `hermes` binary must push, not read
    empty silently). *Test: remove the binary on staging → alert fires.*
- **EPIC B — The trust ledger + graduation.**
  - B1 `git.trust` ledger + `gitRungGranted(engine,repo)` = min(ceiling, earned).
    *Test: an engine at earned-rung 1 is denied rung 2 even at `autonomyLevel 5`.*
  - B2 `trustTick` computes scores from gate-signed audit facts; emits
    `promotion_available`. *Test: a scripted clean-run streak surfaces a promotion.*
  - B3 (FE) Graduation dashboard + one-tap operator-signed promotion. *Test: tap →
    an operator-signed ledger entry; a task body claiming "promote me" does nothing.*
  - B4 automatic demotion on any hard-trip, drop-to-still-functioning-rung. *Test: a
    simulated rail violation instantly demotes with a re-earn path, no human.*
- **EPIC C — A free governed reviewer, then builder (break the paid bottleneck).**
  - C1 Gemini sandboxed read-only reviewer profile → add to `REVIEW_ENGINES`. *Test:
    review survives with both paid engines dry.*
  - C2 Gemini/Claude Foundation B builder profile (hardened workspace). *Test: a
    write task completes with Codex out of credits.*
- **EPIC D — Credit-aware failover + Runner handoff.**
  - D1 classify out-of-credits; reroute Point/QA/Runner to a live engine. *Test: a
    creditless Point silently continues on a free engine, no stall.*
  - D2 parameterize the Board Runner (Gemini → Kimi) off the hardcoded engine. *Test:
    Kimi runs the board once it holds the rung.*

## 7. First move (next work session)

**EPIC A, Story A2 — the agent-health + credit watcher.** It's the smallest change
with the biggest relief (ends the babysitting you named), it needs no new engine
trust, it reuses the proven `channelHealthTick` pattern, and it makes every later
graduation *observable* — you can't safely grant more autonomy to engines you can't
see the health of. Ship A2 + A1 (the health chip) together so the relief is visible
on the phone, then B1 (the ledger) to start Codex climbing on evidence.

---

*This plan is subordinate to the rights ladder and the charter. No item here
weakens a rail, the human-gate on the irreversible, or the master STOP — promotion
only ever changes how often a human is touched, never what the rails enforce.*
