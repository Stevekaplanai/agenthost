---
name: brain-builder
description: Build your global Claude Code brain. Runs a guided intake interview and writes your full ~/.claude/CLAUDE.md + sub-files (brand-voice, icp, offer, what-works). Use when a member wants to set up their content brain for the first time, or when they say "set up my CLAUDE.md", "build my brain", or "help me configure Claude Code for my brand".
---

# Brain Builder — Build Your Global Content Brain

This skill builds your global CLAUDE.md — the file Claude Code reads at the start of every session, in every project. When it knows your voice, your audience, and your offer, everything you create starts from that baseline automatically.

Run this once. Update it as your business evolves.

---

## What We're Building

```
~/.claude/
  CLAUDE.md          ← master file (references the sub-files below)
  brand-voice.md     ← how you write, speak, and what to avoid
  icp.md             ← exactly who you're talking to
  offer.md           ← what you sell and why it works
  what-works.md      ← content intelligence that builds over time
```

---

## Phase 1: The Intake Interview

Tell the member what you're building, then ask these questions **one section at a time**. Wait for their answer before moving to the next section. Use conversational follow-ups if an answer is thin.

### Section 1 — The Offer

Ask:
> "Let's start with what you actually do. What's your offer — and who do you sell it to? Give me the one-sentence version you'd say to someone at a dinner party."

If vague, follow up: "What does someone pay you for specifically? What do they have after working with you that they didn't have before?"

### Section 2 — The Audience

Ask:
> "Who is your ideal client? Describe the person who would be a perfect fit — their role, situation, and what problem they're trying to solve right now."

Follow up if needed: "Are they a business owner, a professional, a creator? What do they struggle with that brought them to you?"

### Section 3 — The Results

Ask:
> "What's the best result you've gotten for a client? Specific numbers, timeline, transformation — the kind of thing you'd put in a testimonial."

If they give a vague answer, push: "Can you give me the before and after? What did their situation look like before, and what changed?"

### Section 4 — The Proof

Ask:
> "What's your credibility? Why should someone believe you can deliver this — your background, track record, or relevant experience."

### Section 5 — The Voice

Ask:
> "How would you describe the way you communicate? Think about how you talk to clients or write messages — the energy, the tone, the vibe. What does it sound like?"

Follow up: "Is there someone whose communication style yours is similar to — a creator, a peer, anyone? And is there a style you'd never want to sound like?"

### Section 6 — The Topics

Ask:
> "What do you actually talk about in your content? List the 4–6 core topics you cover — the things you have genuine opinions on and could talk about for hours."

### Section 7 — The Rules

Ask:
> "What are your content rules? What do you never say, never do, never post about? Any phrases or formats that feel off-brand or cringe to you?"

---

## Phase 2: Generate the Files

Once all sections are complete, tell the member:
> "Got everything I need. Building your brain now."

Then generate each file in full, using the responses from the intake.

---

### File: `~/.claude/brand-voice.md`

Structure this file as:

```markdown
# Brand Voice

## How I Communicate
[3-5 sentences capturing their overall communication style — tone, energy, pacing]

## Voice Markers
[Bullet list of specific things that make their voice theirs — e.g. "Direct and confident, no hedging", "Uses specific numbers over vague claims", "Casual contractions, never formal"]

## What to Avoid
[Bullet list of phrases, formats, or tones they explicitly don't want — e.g. "No corporate speak", "Never humble-brag", "No em-dashes or listicles"]

## Sentence Patterns
[2-3 example sentences written in their voice, drawn from their answers — show Claude what "them" sounds like]
```

---

### File: `~/.claude/icp.md`

Structure this file as:

```markdown
# Ideal Customer Profile

## Primary Avatar
**Role/Situation:** [who they are]
**The problem they have right now:** [specific pain point]
**What they've already tried:** [what hasn't worked for them]
**What they want:** [the transformation / outcome they're after]
**What makes them pull the trigger:** [what tips them toward buying]

## Language They Use
[The actual words and phrases their audience uses — pulled from the intake answers. Write these as if transcribing how the avatar describes their own problem.]

## What They're NOT
[Who this isn't for — the audience segments to avoid speaking to]
```

---

### File: `~/.claude/offer.md`

Structure this file as:

```markdown
# The Offer

## What I Sell
[Product/service name and one-sentence description]

## Who It's For
[Specific person, specific situation]

## The Transformation
**Before:** [their situation before]
**After:** [their situation after]

## Proof Points
[Their best results, client outcomes, credentials — written as punchy facts, not claims]

## The Positioning Line
[One sentence that captures why this is different from what else exists — written in their voice]
```

---

### File: `~/.claude/what-works.md`

Start this file empty with a note:

```markdown
# What Works

This file builds over time. Run /what-works-update after any post that performs well.
Each entry logs what worked and why — so future content can repeat the pattern.

---

[No entries yet — start posting and add wins here.]
```

---

### File: `~/.claude/CLAUDE.md`

This is the master file. It references the sub-files and loads context automatically.

```markdown
# [Their Name] — Content Brain

This file loads every session. Sub-files below are **not auto-loaded** — Claude reads them when the task requires that context.

## Sub-files (read on demand)

- `~/.claude/brand-voice.md` — how I write and speak, what to avoid
- `~/.claude/icp.md` — my ideal client, their language, their problem
- `~/.claude/offer.md` — what I sell, who it's for, proof points
- `~/.claude/what-works.md` — live content intelligence: what's performed and why

## How to Use This Brain

When writing content: read brand-voice.md and icp.md first.
When building offers or CTAs: read offer.md first.
When ideating new content: read what-works.md first.
When in doubt: read all sub-files before responding.

---

## Quick Context

[Write 3-5 sentences summarizing who this person is, what they do, who they serve, and what makes them credible — drawn from the intake. This is the snapshot Claude gets in every session before reading sub-files.]
```

---

## Phase 3: Write the Files

Use the Write tool to create each file at the exact paths:
- `~/.claude/CLAUDE.md`
- `~/.claude/brand-voice.md`
- `~/.claude/icp.md`
- `~/.claude/offer.md`
- `~/.claude/what-works.md`

**Before writing:** Show the member a preview of the CLAUDE.md quick context section and ask: "Does this capture you accurately? Any corrections before I write the files?"

After confirming, write all five files.

**After writing, confirm:**
> "Your brain is built. These five files now load automatically in every Claude Code session. Your voice, your audience, your offer — Claude knows all of it before you type a word.
>
> Two things to do from here:
> 1. Read through each sub-file and add anything I missed — especially specific client quotes, real results numbers, or phrases that are distinctly yours.
> 2. Update what-works.md after your first post that performs — that's where the system starts learning."
