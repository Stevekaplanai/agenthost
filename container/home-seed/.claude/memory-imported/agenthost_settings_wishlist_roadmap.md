---
name: agenthost-settings-wishlist-roadmap
description: "Steve's 2026-07-20 mandate to make the full settings panel real, the 4 safety decisions he locked, and the 5-phase build sequence"
metadata: 
  node_type: memory
  type: project
  originSessionId: 1efbf18e-284b-4976-9884-d1ab9b389cce
  modified: 2026-07-20T23:37:58.478Z
---

# AgentHost settings wish list → platform roadmap (Steve, 2026-07-20)

**The mandate:** Steve wants the full 27-setting panel (Hermes's mockup at `C:\Users\User\Projects\agenthost-site-revamp\site\settings.html`) to become REAL — "make a wish territory," valuation edge for launch. Feasibility map found only 2/27 wire cleanly; 18 need new backend. Steve said build it all anyway, phased.

**The 4 decisions Steve locked (these override earlier flags):**
1. **Git push for agents: APPROVED.** "The box does what you can do" — full ladder to GitHub push, governed by Autonomy Level + Review Strictness settings (branch-first; merge gated by strictness). Per-engine fine-grained PATs.
2. **Compliance "Relaxed" DEFINED:** the charter's outer limits, never outside them. Stretches interpretation, not rules; evolves as charter evolves.
3. **Mode switching: APPROVED as a Control Room control** with a "restarts and reconfigures the box" warning. Implementation: mode moves from deploy-time env (`AGENTHOST_BRAND`) to a `/data` config file read at boot + supervised restart. Switching INTO Legal Mode must still prompt the training-opt-out attestation.
4. **Locked behaviors: wire all 5 for real** (cost transparency, skill autoload, output language, achievements, snapshot interval) — no "LOCKED always-on" copy without enforcing code.

**Build sequence (why-ordered, published as artifact https://claude.ai/code/artifact/976d81c5-a898-4135-89df-0d8e579719c2):**
- Phase 0 (in flight): stuck-card detector + frozen status BUILT 2026-07-20 (stuck-lib.js + gate.js + freeze UI in cc/chat, local uncommitted, awaiting deploy); Gemini board runner **WRITE-ENABLED** (Steve reversed read-only same day: Gemini changes stuck/dup/blocked cards himself, condition = sees everyone's chat; gate still executes the verbs; GEMINI_API_KEY verified live; headless needs GEMINI_CLI_TRUST_WORKSPACE=true); action buttons verified working.
- Phase 1: settings backbone — settings store on /data + API + gate.js honors values + quick-win settings + the 5 locked behaviors. THE ENABLER.
- Phase 2: per-engine workspace isolation — **Codex gets his own space first** (Steve's explicit call). Prereq for everything after.
- Phase 3: git capability ladder (commit → branch push → PR → merge), settings-governed.
- Phase 4: parallel agents (box currently runs EXACTLY ONE agent at a time — gate.js:1238) + sub-agent delegation. The hard rewire; deliberately after 2+3.
- Phase 5: mode switching, daily spend limit, dead man's switch, webhooks, fallback model, personality, memory TTL, priority queue, multi-user Team Access (hardest of this bucket).

**Invariant:** the gate stays the only dispatcher; every new capability flows through gate.js rails (human-gate, budgets, review, audit). Copy matches code — settings appear in the live panel only when the backend exists.

**Split:** Claude = backbone/wiring/design; Codex = builds + red-team; Hermes = dashboard UI + QA; Gemini = board runner; Steve owes GEMINI_API_KEY + phase greenlights.
