---
name: research
description: Surface what's getting traction in a member's niche and rank the best content opportunities. Use when a member pastes TrendJacker output, describes their niche and wants research done, or says "find what's working", "research my niche", "what should I post about", or "help me find content ideas". Can also run web searches if no TrendJacker output is provided.
---

# Research — Find What's Actually Working

The research phase is the foundation of the whole content engine. You're not looking for inspiration — you're looking for proof. High engagement, heated comments, big view counts. That's your raw material.

This skill takes TrendJacker output or a niche description and surfaces the best content opportunities, ranked by potential.

---

## Phase 1: Load Context

Read `~/.claude/CLAUDE.md` before doing anything. You need to understand:
- Their niche and topic focus
- Their audience (from icp.md if referenced)
- Their offer (from offer.md if referenced)

This shapes which signals matter and which don't. A viral post about crypto is worthless to a leadership coach.

---

## Phase 2: Get the Input

**If the member pastes TrendJacker output:** Accept it directly. This is the ideal input — already aggregated signal across platforms. Move to Phase 3.

**If the member describes their niche without data:** Run web searches across Reddit and YouTube. These are reliably indexed and give strong signal. Use these search patterns:

- Reddit: `site:reddit.com [niche keyword]` — try 2–3 keyword variations. Look for threads with high comment counts (debate and resonance) or significant upvotes. Recent threads preferred.
- YouTube: `[niche keyword] site:youtube.com` — look for videos with strong view counts published in the last 30–90 days from non-celebrity creators. Non-celebrity is the priority — those are the hooks that are actually achievable.

Note: LinkedIn posts are not reliably indexed by web search. Members who want LinkedIn signal should use TrendJacker, which scrapes it directly.

**If nothing specific is provided:** Ask one question: "What's your niche? Give me the 2–3 keywords someone would search to find your content."

---

## Phase 3: Rank and Analyze

Review all content pieces and identify the top 5–7 opportunities. Rank them by:

1. Engagement signal strength (comments > reactions > views for this purpose — comments mean debate and resonance)
2. Relevance to the member's audience and niche (use their CLAUDE.md context)
3. Recreatability — can the mechanism be extracted and transferred to their context?

Exclude: celebrity/influencer content (mechanism not recreatable at their level), news-dependent content (expires fast), anything requiring major production.

---

## Output Format

### RESEARCH BRIEF — [Their Niche]

**Signal summary:** [1–2 sentences on what the overall research shows — what themes are getting traction right now, what kind of content is dominating]

---

**Top Content Opportunities**

For each of the top 5–7 pieces, output this block:

---

**[#]. [Platform] — [Content title or first line, truncated to ~80 chars]**

Engagement: [stats — e.g., "847 comments, 2.1K reactions" or "480K views, 4.2K likes"]

Why it's performing: [2–3 sentences. Be specific. What emotion or tension is it triggering? What's the mechanism?]

Your angle: [1 sentence. How could they take the same mechanism and apply it to their niche, audience, and proof?]

Difficulty to recreate: [Easy / Medium / Hard — based on how much they'd need to change vs. translate]

---

After all 5–7 entries, add:

### RECOMMENDED STARTING POINT

**Best opportunity:** [Name the #1 pick and why — the one with the strongest signal + clearest translation path for their specific context]

**Why this one:** [2–3 sentences on why this opportunity fits their niche, their voice, and their audience better than the others]

---

## Closing Note

After the output, add one line:

> "Pick the one that resonates most — or tell me which you want to go deeper on. Then run /dissect on it and we'll pull out exactly what to recreate."
