---
name: recreate
description: Recreate a piece of content in the member's voice for their niche and audience. Use when a member pastes a dissect brief or raw content and wants to produce their own version. Triggers on "recreate this", "write my version of this", "make this mine", or when a dissect output is pasted with intent to create. Always reads ~/.claude/CLAUDE.md before writing.
---

# Recreate — Make It Yours

You've extracted what's working. Now you make it yours.

This skill takes the mechanism from a dissect brief (or raw content) and recreates it using the member's voice, niche, proof, and audience — producing a platform-ready post with hook variants and a quality check.

---

## Phase 1: Load Context

**Always read `~/.claude/CLAUDE.md` before writing anything.** If it references sub-files (brand-voice.md, icp.md, offer.md), read those too.

If `~/.claude/CLAUDE.md` doesn't exist or is empty, say:
> "I don't have your content brain set up yet. Run /brain-builder first — it takes 5 minutes and everything I write after that will sound like you."

Stop there until they build their brain.

---

## Phase 2: Understand the Input

The member will provide one of:
1. **A /dissect output** — already extracted. Go straight to recreation.
2. **Raw content** — paste of a performing post, video, or thread. Run a quick internal dissect (don't show it) before recreating.
3. **A topic or link** — if they describe what they found without pasting the content, ask for the actual text. One line: "Paste the content and I'll take it from there."

**Clarify the platform if not obvious.** Ask once: "Which platform is this for — LinkedIn, TikTok, or another?" If they don't know, default to LinkedIn.

---

## Phase 3: Recreate

Rebuild the content using the same underlying mechanism — the hook type, structure pattern, and engagement driver — but with:

- The member's niche, topic, and specific context (from CLAUDE.md)
- Their proof points and results (from offer.md and icp.md)
- Their voice and formatting style (from brand-voice.md)
- Their audience's language and pain points (from icp.md)

**The frame stays. The subject matter changes entirely.**

Do not start with a generic hook. The first line must be specific to their context — a real number, a real result, a named transformation, or a concrete scene.

**Platform formatting rules:**

*LinkedIn:*
- One sentence per line. Blank line between every paragraph.
- No markdown bold, no headers, no hashtags in body.
- Short paragraphs (1–3 sentences max).
- Hook is the first 1–2 lines (before "...see more").
- CTA at the end. Optional repost line last.

*TikTok / Short-form script:*
- Hook = first 3 seconds of speech. One line that forces a pause.
- Script format: [HOOK] → [Setup — 5 sec] → [Point 1] → [Point 2] → [Point 3] → [Payoff + CTA]
- Label each section clearly.
- Target length: 45–90 seconds of spoken content (~100–200 words).
- Conversational. No corporate language. Written for the ear, not the eye.

*YouTube hook/title:*
- Title: [Number or intrigue] + [specific benefit or mechanism]. Under 60 characters.
- Hook (spoken intro): First 30 seconds. One bold claim → one story beat → one promise of what they'll get.

---

## Output Format

### RECREATED POST

**Platform:** [LinkedIn / TikTok / YouTube / etc.]

---

[The full recreated post. No intro, no preamble. Just the content, formatted correctly for the platform.]

---

### HOOK VARIANTS

Three alternative opening lines using different hook mechanisms. Member picks the one that fits their voice or combines elements from multiple.

**A — [Hook type]:**
[Opening line]

**B — [Hook type]:**
[Opening line]

**C — [Hook type]:**
[Opening line]

---

### QUALITY CHECK

Run this check against what was written:

**Voice match:** [✓ Sounds like them / ⚠ Needs adjustment]
[If ⚠, say what specifically sounds off — too formal, too generic, missing their energy, etc.]

**ICP match:** [✓ Speaks directly to their audience / ⚠ Too broad or wrong person]
[If ⚠, name what the post is missing — specific pain point, right awareness level, their language.]

**Specificity:** [✓ Has real numbers/proof / ⚠ Still vague]
[If ⚠, tell them exactly what to add — "Replace 'better results' with your actual client outcome."]

**One edit to make it stronger:**
[The single most impactful change they could make right now — specific, not general.]

---

## Phase 4: Handoff

After the output, add one line:

> "Happy with a version? Run /execute to do the final check and get it ready to post."
