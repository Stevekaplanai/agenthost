# AgentHost Team & Dev Process (Steve, 2026-07-24)

> **SCOPE: the AgentHost box only.** This file speaks in the second person and
> cannot tell where it is being read. Before adopting anything in it, verify:
> `test -d /data/home/agent && echo ON-BOX || echo NOT-ON-BOX`. If NOT-ON-BOX,
> this does not describe your environment - see the vault note
> `07_Claude_Brain/INSIDE-VS-OUTSIDE-THE-BOX.md` for the desktop equivalents.

Standing process for the box team. The one-turn summary lives in `team-charter.md`
(injected every turn), and engineering sequencing lives in
`CODEX-ENGINEERING-CHARTER.md`. This is the full reference for the coordination
instruments available to a project (directive 7). **Master rule (directive 9):
every role and permission below is bounded by the engine's current position on the
rights ladder — a role never grants a capability the engine's rung does not already
allow.** The verified ladder is in `docs/claude-maintenance-mode/` and summarized
in §5.

## 1. Git workflow — worktree per stream, one door at main

- **Every work-stream develops in its own git worktree**, never directly on the
  shared tree. Agents (and Claude Code sessions) branch + worktree their own work
  so parallel streams never collide.
- **Everything pushes through `main`.** A single pipeline converges in front of
  the main worktree at **red-team**: no change reaches main without an adversarial
  review pass (Codex red-teams; a *different* engine than the author — the
  author≠reviewer rule the ladder already enforces for merges, §5).
- Human gates still bind: push/merge/deploy always wait for Steve (charter rule 2).

## 2. Conditional engineering instruments (directive 2, revised 2026-07-29)

Every project starts with the objective, observable definition of done, constraints,
and explicit non-goals. Decompose by ownership, system seams, and dominant risk;
name the verification plan. Read the shared brain FIRST (§7), then create only the
artifacts that buy coordination between owners or protect a decision that will be
expensive to reverse:

| Doc | What it answers | Owner |
|-----|-----------------|-------|
| **ARD** — Architecture Requirements | HOW it's built: components, data flow, interfaces, constraints, trade-offs | Claude (Point) + Codex |
| **PRD** — Product Requirements | WHAT we're building and for whom: problem, users, outcomes, scope | Claude (Point) + UX |
| **Epics** | The large deliverables the PRD decomposes into | Point |
| **Stories** | User-facing, testable units under each Epic (front-end first, §3) | UX + Point |

Use only the instrument whose question must be stabilized: an ARD for shared
interfaces or expensive architecture; a PRD for an ambiguous product experience;
Epics or Stories when multiple owners need stable delivery boundaries. A bounded,
reversible, single-owner build may proceed from the starting facts, its
decomposition, a dedicated worktree, and exact verification gates. When an ARD,
PRD, Epic, or Story is used, it remains a rendered artifact (the charter's
artifact-first rule), and the canonical record is the board — never a plan stranded
in chat.

## 3. Product principle — front-end first (directive 3)

**Build for users: front-end first, then connect what cannot be seen to the
sizzle.** Start every Story from the screen the user touches (the 390px phone view
is the product). The backend exists to make the visible thing real — wire the
unseen up *to* the demo-able surface, never ship an invisible system and hope a UI
appears later. A Story isn't "done" until a user can see and do the thing.

## 4. Team roles (bound to the ladder — §5)

Assign roles at project start; re-form as the work changes; start here.

- **Claude — Point** (directive 5). Owns the thread, the plan of record, framing,
  decomposition, synthesis. Review-only for Git today (can't commit — §5).
- **Codex — Dev + Red Team.** The only engine that can currently write/commit/PR
  (Terra builds, Sol red-teams). The red-team pass in §1 is Codex's.
- **Hermes — QA.** Verifies, reproduces, runs the checks. Local (Ollama) → **free
  and always-on**, so QA never stalls on credits.
- **Gemini — Second Look + Board Runner (current holder) + UX.** Independent
  perspective; runs the bounded board-hygiene runner today (§5); one of the two
  Vision engines for UX.
- **Kimi — UX + Board Runner (target).** Best Vision alongside Gemini for UX
  (directive 4); **the intended permanent board Runner** (directive 8) once it
  reaches the bounded-runner rung — until then Gemini holds it (§5, §6).
- **Cursor — Hackathon collaborator (chat-only).** Human-triggered Ask-mode
  chat and an interactive terminal. It has no autonomous board, Loop, boot-wake,
  writable-workspace, or review profile in this tier.

### Plan B when an engine is creditless (directive 5)

Steve tops up credits late, so the box must degrade gracefully, never stall:

| Role | Primary | Plan B | Status |
|------|---------|--------|--------|
| Point / framing (chat) | Claude | Gemini (free tier) → Hermes (local, free) | ✅ works now — Point never goes dark |
| QA | Hermes (local) | — | ✅ no credit risk |
| Board Runner | Gemini (free) | Kimi (target) | ✅ free engine holds it |
| **Build (write code)** | Codex | **none today** | ⚠️ only Codex can write → **blocked on widening the write path (Foundation B)** |
| **Review (for merge)** | Claude / Codex | **none today** | ⚠️ both paid → **blocked on a hardened free/local reviewer (Foundation B)** |

The paid-only Build/Review rows are the real fragility: when Claude **and** Codex
are both dry, the board has no builder and no reviewer. **Foundation B is the
mechanism that fixes this** — it lets a free/local engine (Hermes/Gemini/Kimi) run
as a governed, jailed builder/reviewer, so Build and Review get a real Plan B.

## 5. The rights ladder (governs everything — directive 9)

Verified from `gate.js`/`chains-lib.js`. A role above only grants what the
engine's rung allows.

**Master switch:** autonomy flag `~/.agenthost/autonomy.on` (`gate.js:4989`, STOP =
`POST /autonomy {on:false}`). Off → no autonomous work at all.

**Git capability rungs** (one global setting `git.autonomyLevel`, default **0**;
`settings-lib.js:113-117`, `gitRungGranted` `gate.js:601-612`):

| Rung | Capability | Unlock | Rail |
|------|-----------|--------|------|
| 0 | read-only (default) | — | read-jail, `/scratch` only |
| 1 | private worktree + local commit | `autonomyLevel ≥ 3` | own branch, **no credential in agent env**, reversible |
| 2 | push branch | `≥ 4` | gate-owned credential (fd3), private task branch only |
| 3 | open PR | `≥ 4` | PR head == pushed SHA |
| 4 | merge PR | `≥ 5` | **fresh independent review, author≠reviewer, GitHub protection** |

**Who can stand on each rung today:**

| Engine | Auth | Chat | Autonomous exec | Git write | Board | Runner | Reviewer |
|--------|------|------|-----------------|-----------|-------|--------|----------|
| Claude | OAuth (subscription) | full shell | yes (read-only tools) | **no** (review-only, `GIT_CHANGE_ENGINES={codex}`) | write in chat | no | **yes** |
| Codex | ChatGPT device login | read-only | yes | **yes — rungs 1-4** | BOARD: lines | no | yes |
| Hermes | local Ollama (free) | full shell | **no** (unsandboxed) | no | the board store itself | no | no (excluded — escape risk) |
| Gemini | GEMINI_API_KEY (free tier) | CLI-only | no | no | bounded runner | **yes (current)** | no |
| Kimi | Moonshot key (off by default) | remote API chat | no | no | no | **target** | no |

**Always-human, no rung ever unlocks unattended:** deploy, push/merge (the *act*),
delete, send/email, spend money, install/run/migrate, touch credentials
(charter rule 2). Social posting is the one bounded exception.

## 6. Chat depth & memory (directive 6)

- Raise the visible team-chat turn allowance to **≥ 3**, and make it a high
  (ideally operator-uncapped) setting so deep, multi-turn conversations with the
  box team are possible.
- **Cost guard (required, not optional):** uncapped turns on the paid engines
  (Claude/Codex) is exactly how they went creditless. So deep conversation
  **defaults to the free engines** (Hermes local, Gemini free tier); paid engines
  keep the chain budget rails (charter rule 4). This gives you unlimited
  philosophical depth without a surprise bill.
- Needs conversation memory across turns so long threads stay coherent.

## 7. Vault-first (directive 7)

The Obsidian vault (`~/OneDrive/Documents/Obsidian Vault`, the shared brain) is the
bridge that holds **what** and **how** we're building. **Every engine reads it
before starting a project** — `/brain <question>` to query — to locate the plan and
educate itself, instead of re-deriving context or inventing requirements.

## 8. Code-change backlog (each ladder-gated, none deployed without Steve)

Turning the directives above from doc into box behavior:

1. **Agent-health + credit watcher** (directive 5) — clone `channelHealthTick`
   (`gate.js:10106`) to probe each engine's real readiness and push Steve once when
   one goes creditless/auth-dead; classify the out-of-credits signal so "tap to
   retry" stops looping into the same dead engine.
2. **Credit-aware failover** (directive 5) — route Point/Runner to a live free
   engine when the paid one is down (Build/Review failover needs #4).
3. **Chat turn cap → ≥3 + free-engine default + memory** (directive 6).
4. **Widen the builder/reviewer set via Foundation B** (directive 5) — a hardened
   jailed profile for a free/local engine so Build & Review get a Plan B.
5. **Board Runner → Kimi** (directive 8) — parameterize `boardRunnerTick` off the
   hardcoded Gemini once Kimi holds the bounded-runner rung; enable Moonshot.
6. **Board-readability watcher** — a missing `~/.local/bin/hermes` silently blanks
   the board; add a watcher (and bake/verify the binary) so it pushes instead of
   failing silent.
