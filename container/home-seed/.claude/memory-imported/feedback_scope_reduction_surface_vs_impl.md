---
name: When reducing scope, hide surfaces — don't delete code
description: Founders often conflate "simpler product" with "less code." The right move is usually: more code dormant + fewer user-facing surfaces. Don't propose killing engineering work — propose hiding it behind feature flags.
type: feedback
originSessionId: 14e8009d-5e07-4862-b669-4a2fa6208660
---
When Steve says "we should simplify" / "remove features" / "scope creep," the instinct to interpret as "delete code" is often wrong. He pushed back hard on this 2026-04-25 (Synap brainstorm): when I framed scope reduction as "kill 13 of the 16 agents," he correctly called out that I was about to destroy value he already paid to build.

His exact words: *"I don't like the idea of getting rid of all the agents... I'm leaving all my brainwork behind and just turning of 13 agents? Let's brainstorm further but I don't like this direction, there are other things that we change and remove before we start removing the agents."*

**Why:** Asking founders to delete their own work creates emotional resistance and erases optionality. Also: the engineering breadth is often a moat or product-led-expansion ammunition, not bloat. The actual scope problem is almost always user-facing surface area, not implementation breadth.

**The right framing:**
- **User-facing surfaces** (pages, navigation items, settings, pricing tiers, integrations users see, concepts users have to learn) — these create cognitive load and demo confusion. Cut these aggressively.
- **Implementation breadth** (services, agents, modules, libraries) — these are leverage IF hidden behind a clean surface. Apple Watch has hundreds of sensors; users see a clock face. Stripe has thousands of services; developers see `stripe.charges.create()`.

**How to apply** when proposing scope reduction:

1. Default to **hiding** UI surfaces, routes, navigation — keep code dormant. Costs ~$0/month to leave alive.
2. Pick ONE workflow as the v1 surface.
3. Cut visible: pricing tiers, OAuth integrations shown, attribution models exposed, trust-tier concepts users learn, parallel feature surfaces.
4. Keep backend services alive — they become product-led expansion later: *"As your accounts scale, unlock the Brand Intelligence agent."* That's a moat AND a roadmap.

**Anti-patterns to avoid:**
- ❌ "Which 3 of the 16 agents should we keep?" → delete framing, triggers loss aversion
- ✅ "What's the ONE user-facing workflow, and which subset of the existing agents powers it under the hood?" → hide framing, preserves IP

**Detection signal:** when Steve uses the word "brainwork" or expresses attachment to existing engineering, you're heading toward the delete-framing anti-pattern. Reframe to surface-vs-implementation.
