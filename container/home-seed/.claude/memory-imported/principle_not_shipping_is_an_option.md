---
name: principle-not-shipping-is-an-option
description: "The option to not ship is always on the table, and it's cheapest before publication — Steve asked this memorialized 2026-07-27"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: c31bd7e5-94e9-4451-ace0-45acbfbb0957
  modified: 2026-07-27T11:59:08.541Z
---

# Not shipping is always an option — and it's cheapest before publication

Adopted 2026-07-27 (launch day), when Steve was about to post Codex's Control Plane
infographic — a diagram of his real running infrastructure — to an HN/PH audience
actively red-teaming a security-positioned product. Claude recommended holding it;
Steve's response: *"I want to learn from you... Memorialize that somehow."*

**The principle:** Every publication decision has a silent third option beyond
"ship it" and "fix it then ship it": **don't ship it.** That option costs nothing
right up until the moment of publication, and becomes unavailable the moment after.
Every gate in the AgentHost governance stack exists because consequences are
one-way doors — publishing is the archetype.

**Why:** Upside of one post is marginal (one good post among several). Downside of
a bad one is asymmetric (a security embarrassment on the day the entire pitch is
governance). When upside and downside are that lopsided, holding is a *decision*,
not a failure to act.

**How to apply:**
- Before any outward-facing release (post, image, diagram, claim), explicitly ask:
  "is NOT shipping this the best move?" — out loud, as a named option, not a vibe.
- Real infrastructure artifacts (diagrams, screenshots, logs) never ship as-is;
  the *story* is shareable, the *blueprint* is not. If the visual matters, redraw
  a concept version with zero real identifiers, after the underlying code is
  reviewed and merged.
- Copy never runs ahead of code (pairs with Cardinal Rule 11's corollary).
- This does NOT license stalling on reversible work — it applies to one-way doors
  only (publication, deletion, spend, credentials). Rule 4 still governs the
  reversible.

Related: [[feedback-approval-required]] (publishing preapproved — this principle is
the judgment layer that preapproval does NOT remove), Cardinal Rules 2/11/13.
