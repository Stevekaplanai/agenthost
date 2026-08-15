---
name: gtmvp-solver-applications
description: "Constraint-solver integration roadmap for the GTMVP 8-agent intelligence engine. Each entry is a concrete agent whose output quality changes from \"ranked list\" to \"provably-optimal recommendation with hard constraints surfaced.\""
metadata: 
  node_type: memory
  type: project
  originSessionId: d015ae85-f41a-4315-bb08-994a91f55268
---

GTMVP currently outputs ranked lists (channels scored 1-28, SWOT items prioritized, competitors mapped). The constraint solver upgrade turns these into **provably-optimal recommendations under explicit founder constraints** — the kind of step-change in output quality that makes GTMVP genuinely differentiated from generic LLM-driven GTM tools.

**Why:** Steve's positioning for GTMVP rests on rigor — eight specialized agents that don't hand-wave. Adding constraint-solving moves output from "here's a ranking" to "here's the unique optimal mix given your budget/team/timeline, and here's mathematical proof no better mix exists." For B2B SaaS founders flying blind on attribution, that's the difference between intelligence and BI-theater.

**How to apply:** When a GTMVP agent's output is currently a ranked list with implicit tradeoffs, model those tradeoffs as a constraint problem and call `mcp__solver-z3__solve_model`. Surface the constraints to the user so they can adjust and re-solve.

---

## Tier 1 — ship-first candidates (highest leverage, smallest scope)

### 1. `/channel-score` → optimal channel mix (not just ranked channels)

**Current:** marketing-channel-scoring outputs 28 channels ranked by ICP fit with a "sequenced rollout plan."

**With solver:** Founder inputs (a) monthly marketing budget, (b) headcount, (c) channel-specific time-to-traction expectations. Solver returns the **weekly budget allocation** across channels that maximizes predicted pipeline coverage subject to:
- Total budget ≤ cap
- No more than 40% of budget on any single channel (diversification)
- Channels with dependencies (e.g. content marketing needs an editor on staff) only activated if dependency satisfied
- Minimum viable spend per activated channel (sub-$3K/mo on Google Ads is wasted)

**Differentiator:** Most channel-mix advice is "do these 5 things." GTMVP says "do exactly this split, here's why no better split exists, here's what would unlock if you added $X to headcount."

---

### 2. `/positioning-pass` → whitespace verification

**Current:** Extracts current positioning, identifies vague/commoditized claims, proposes 3 sharper alternatives.

**With solver:** Encode competitor positioning as points in N-dimensional space (price, audience-sophistication, feature-depth, channel-fit, etc.). Find positioning vectors that are (a) maximally distant from competitors (whitespace), (b) within the founder's defensibility envelope (constraints like "founder background = technical → can't credibly claim no-code positioning"), and (c) addressable from a marketing/sales standpoint.

**Differentiator:** Z3 PROVES whitespace exists by producing a positioning vector with measured distance. Or proves it doesn't exist, forcing the founder to confront crowded markets honestly.

---

### 3. SWOT → top-K strategic priorities under capacity

**Current:** swot-analysis ranks strategic priorities; founder picks "top 3."

**With solver:** N candidate priorities × M SWOT items they address. Founder inputs weekly hours available. Solver picks the K priorities that maximize weighted SWOT coverage subject to:
- Total hours required ≤ founder capacity
- At least one priority addresses each critical threat (T) in SWOT
- At most 1 "new initiative" per month (avoid context-switching)

**Differentiator:** Goes from "here are 7 ranked priorities, you pick 3" to "here are the 3 priorities, here's what gets dropped, here's the SWOT items left uncovered."

---

## Tier 2 — bigger swings, more design work

### 4. `/gtm-audit` synthesis under inconsistent inputs

When the 8 sub-agent outputs contradict (channel scorer says "go heavy LinkedIn ads", brand-strategist says "your ICP isn't on LinkedIn"), use MaxSAT to find the largest consistent subset of recommendations. Today these conflicts get hand-waved by the synthesis step.

### 5. Competitor war-gaming (∃∀ quantification)

Encode: given competitor's possible reactions, find a sequence of GTM moves that wins under worst-case competitor response. Z3 handles `∃ my-moves ∀ their-responses : I-win`. Output: "play move A first, here's the proof no competitor response gets above X% counter-share."

### 6. TAM/SAM/SOM horizon planning with dependencies

Horizons (0-3mo / 3-12mo / 12mo+) × N opportunities, each with prerequisites. Find feasible roadmap respecting capacity and dependency DAG. Output: ordered initiatives per horizon with explicit critical path.

### 7. Porter's Five Forces → strategic response packaging

Given scored forces and N candidate responses (each affects 1-3 forces with varying cost), find min-cost set bringing all forces below threshold. Closes the loop from "here are your 5 forces scored" to "here's the cheapest package of moves that defangs them."

---

## Tier 3 — content engine adjacencies

### 8. Content calendar diversity (better fit for MiniZinc but Z3 works)

5 content pillars × 7 platforms × 14 days. Constraints: no pillar repeats within 3 days same platform, minimum coverage per pillar per platform per week, format-platform fit rules. Solver produces the calendar; founder edits.

### 9. ICP segment selection (Tier 1 candidate adjacent)

Multi-criteria ICP segment scoring + budget/sales-capacity constraints. Solver picks the Pareto-optimal slice of segments to target this quarter.

---

## Ship status (as of 2026-05-19)

| Phase | Integration | Status |
|-------|------------|--------|
| Phase 0 + A1 | Foundation + `/channel-score` optimal allocation | **Shipped** (commit `eb616f6`) |
| A2 | `/positioning-pass` whitespace verification | **Shipped** (commit `42a2458`, pending solver live test) |
| A3 | `/competitor-map` cluster cover | **Shipped** (commit `42a2458`, pending solver live test) |
| B1 | SWOT priorities under founder capacity | **Shipped** (commit `dc22a3e`, pending solver live test) |
| C1 | Porter's response packaging | **Shipped** (commit `dc22a3e`, pending solver live test) |
| C2 | TAM/SAM/SOM horizons | **Shipped** (commit `dc22a3e`, pending solver live test) |
| D0 | Schema tightening for synthesis | Queued (gating D1) |
| D1 | `/gtm-audit` MaxSAT synthesis | Gated on D0 + PySAT |
| E1 | Competitor war-gaming | Stretch |
| E2 | Content calendar diversity (MiniZinc) | Stretch, MiniZinc wiring pending |

See [[mcp-solver-z3-installed]] for tool reference + when not to use the solver.
