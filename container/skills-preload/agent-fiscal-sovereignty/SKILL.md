---
name: agent-fiscal-sovereignty
description: Charter-governed fiscal discipline for AI agents that spend Steve's money or tokens. Use when an agent (or a fleet) will spend real money — ads, API credits, paid tools, cloud resources, purchases — or large token budgets on autonomous runs; when Steve says "give the agents a budget", "how much did the agents spend", "set a spending cap", "can this run unattended without burning money", or when designing any autonomous loop that touches a card, credits, or metered anything. Codifies the Sovereign-OS fiscal-discipline architecture (arXiv 2603.14011) in AgentHost's own terms: budget declared before work, cost estimated before action, spend gated by the human, every cent in an append-only ledger, circuit breakers above it all.
---

# Agent Fiscal Sovereignty

An agent that can spend is an economic actor, and an economic actor without a
constitution is a liability. This skill is the spending counterpart to the
box's git-ladder: **the budget is declared before the work, every spend is
estimated before it happens, gated before it fires, and recorded where it
cannot be edited.** Convergently validated by Sovereign-OS (arXiv 2603.14011,
Yuan et al.) — their charter→plan→approve→ledger→audit chain independently
matches the architecture Steve's rules already enforce for consequences.

## Hard facts (do not relitigate)

- **Spending money is a Rule 2 / Rule 13 consequence.** No trust level, streak,
  or budget surplus ever lets an agent charge a card, buy media, or subscribe
  to a service without the human's explicit grant. Autonomy grows in *how much
  human touch routine work needs* — never in who gates spend.
- **The licence wall:** Sovereign-OS's paper is CC BY-NC-SA and its repo is
  unlicensed. The ideas below are free; their prose is not. Never copy their
  text into any doc, charter, or product copy.
- **Claude workloads bill to the subscription, never a metered API key**
  (Cardinal Rule 9). A metered key appearing in any budget is itself a finding.
- **The box already has hard chain ceilings** (6 runs / 45 min / 150K tokens /
  $5 per chain, 80% soft zone, gate-enforced). This skill does not replace
  them; it governs everything ABOVE a single chain — campaigns, credit packs,
  recurring bills, fleets.
- **A budget without a ledger is a vibe.** If spends aren't written down
  append-only at the moment they happen, the budget is theatre (Constitution
  R0 applies to money exactly as it applies to rails).

## The pipeline (each step gates the next)

1. **Declare the charter numbers BEFORE any work starts.** For the initiative:
   per-action cap, daily cap, total budget/runway, and the named human grant
   that authorized them. Write them where the work lives (the project doc, the
   board card body, the cron prompt) — not in chat history.
   `Gate:` the numbers exist in a durable, referenced location.
2. **Estimate fully-loaded cost before each action.** Tokens + API fees +
   media spend + credits, with the honest overhead (retries, review passes).
   If estimated cost exceeds the action's declared value or would breach a
   cap, the action is skipped and the skip is logged — unprofitable work is
   refused, not attempted thriftily.
   `Gate:` a number, compared against the charter numbers, before execution.
3. **Gate the spend.** Under an explicit pre-authorized cap (e.g. Rule 7's
   "standing approval under 50 verifications/run", a Steve-approved ads
   budget): proceed and record. Anything else — new vendor, cap exceeded,
   card charged, subscription started: **stop and ask, with the estimate and
   the charter numbers in the ask.**
   `Gate:` the authorization (standing or fresh) is named in the record.
4. **Ledger every spend, append-only.** One line per spend at the moment it
   fires: timestamp, what, why, amount, running total vs cap, who authorized.
   Ledger lines are never edited or deleted — corrections are new lines. Keep
   it beside the charter numbers (project doc / board comments / a
   `SPEND-LEDGER.md`).
   `Gate:` running total visible without recomputation.
5. **Circuit breakers above everything.** At 80% of any cap: stop proposing
   new spends, alert the human loudly (push, not a buried log line). At 100%:
   full stop — no "one more call to finish". A breaker trip also demotes:
   the initiative loses unattended-spend privileges until the human re-grants
   (promotion slow and human-signed; demotion instant and automatic).
6. **Reconcile.** On a declared cadence (weekly for ongoing programs, at close
   for campaigns): ledger vs the actual bills (Stripe, Fly, vendor invoices,
   Anthropic usage). Every discrepancy is investigated with
   [stripe-charge-triage](../stripe-charge-triage/SKILL.md) discipline —
   verified against live data or labeled belief, never explained away.

## Known failure modes (learned the expensive way)

- **The shared-account misattribution (2026-07-26):** a $49 ClaudeSkillsHQ
  sale fired an AgentHost order alert because one Stripe account serves many
  brands and a webhook relayed foreign checkouts. Reconciliation must
  attribute by price/product/metadata, never by amount or arrival channel.
- **Token runaway as a money event:** a coaxed or looping chain is a security
  incident AND a spend incident — the box treats near-budget loops as
  stop-and-synthesize, and so does every fleet this skill governs.
- **The quiet metered key:** an SDK example or a "temporary" `ANTHROPIC_API_KEY`
  re-bills subscription-covered work per token. Rule 9 exceptions require
  Steve's written sign-off and a memory entry — otherwise rip it out.
- **Six million tokens of unasked-for work (Attribyte, 2026-06):** scope creep
  is a fiscal event. Step 2's value test exists precisely so "while we're
  here" work fails its own cost screen.

## When NOT to use

- A single interactive session doing normal work under the box's chain
  ceilings — the gate already governs it.
- Personal finance, accounting, or tax questions — different domain entirely.
- Deciding WHETHER something is worth buying strategically — that is Steve's
  business judgment (Rule 13); this skill only ensures the machine can't
  spend before, beyond, or off the books of what he decided.
