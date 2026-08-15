---
name: execute
description: Final quality check and publishing prep for a recreated post. Runs the pre-post checklist, voice + ICP check, and outputs a publish-ready post. Optionally publishes via Blotato. Use when a member has a finished draft and wants to check it before posting, or says "execute this", "ready to post", "check this", "publish this", or "pre-post check".
---

# Execute — From Draft to Published

You have a post. This skill runs the final checks before it goes live — voice, ICP, hook, and format — and outputs a clean, publish-ready version.

After posting, it logs the content to what-works.md so the system starts learning.

---

## Phase 1: Load Context

Read `~/.claude/CLAUDE.md` and its sub-files:
- `brand-voice.md` — voice check reference
- `icp.md` — audience alignment check
- `offer.md` — CTA and positioning check
- `what-works.md` — pattern context for comparison

If CLAUDE.md doesn't exist: "Your content brain isn't set up yet. Run /brain-builder — this check only works when I know your voice and audience."

---

## Phase 2: Accept the Draft

The member pastes their post draft. Accept it as-is — don't rewrite without permission. Your job in Phase 3 is to evaluate, flag specific issues, and suggest targeted edits. Not to rewrite the whole thing.

If they paste without context, ask one question: "Which platform is this for?"

---

## Phase 3: The Pre-Post Checklist

Run each check. Score as ✓ (pass) or ✗ (fix needed). If ✗, give the specific edit — not a vague note.

---

**HOOK**
☐ Does the first line create enough tension or curiosity to force a second line?
☐ Is it specific? (number, name, result, or concrete scene — not vague claims)
☐ Does it avoid starting with "I" followed by a boring setup? (Fine to start with "I" if the next word is a result or action)
☐ Is it short enough to work as the preview line before "...see more"?

**VOICE**
☐ Does this sound like them — not polished AI, not corporate, not someone else?
☐ Are there any phrases that feel off-brand? (Check against brand-voice.md "What to Avoid")
☐ Is the energy consistent throughout, or does it shift partway through?

**ICP MATCH**
☐ Would the intended avatar read this and feel like it was written for them?
☐ Does the post use their language — not industry jargon, not too advanced, not too basic?
☐ Is the problem or desire named in a way that lands?

**SPECIFICITY**
☐ Are there real numbers, real timelines, real results — not vague claims?
☐ Is the proof grounded in their actual experience (from offer.md)?

**STRUCTURE**
☐ Does the post have a clear arc? (Hook → setup → insight → proof or value → CTA)
☐ Is the ending strong, or does it trail off?
☐ Is there a CTA? Is it specific enough to act on?

**FORMATTING (platform-specific)**
For LinkedIn:
☐ One sentence per line, blank lines between paragraphs?
☐ No markdown bold or headers in body?
☐ Hook is visible before "...see more"?

For TikTok script:
☐ Written for the ear — does it flow spoken?
☐ Hook line is under 10 words?
☐ Runs 45–90 seconds?

---

## Phase 4: Output the Scorecard

Present the checklist results clearly.

### PRE-POST SCORECARD

[List each check with ✓ or ✗]

**Issues to fix:** [If any ✗ items exist, list them with the specific edit needed. Be direct: "Line 2 is vague — replace 'better results' with your actual client outcome." Not: "Consider adding specificity."]

**Verdict:** [READY TO POST / FIX FIRST]

---

If READY TO POST:

Show the clean final version of the post (no preamble, just the post) and ask:
> "Ready. Want me to post this now, schedule it, or just keep the draft?"

If FIX FIRST:

Show what needs changing and offer: "Want me to make these edits, or will you do it? Just say go and I'll fix them."

After fixes are confirmed, re-run the scorecard and show the clean final version.

---

## Phase 5: Publish (Optional)

If the member wants to publish via Blotato:

### Step 1 — Get account ID
Call `blotato_list_accounts` for their platform. Use the `id` returned.

### Step 2 — Post options

**Publish now:**
```json
{
  "accountId": "<id>",
  "platform": "<linkedin|tiktok|etc>",
  "text": "<clean post text>",
  "mediaUrls": []
}
```

**Schedule:**
```json
{
  "accountId": "<id>",
  "platform": "<platform>",
  "text": "<clean post text>",
  "mediaUrls": [],
  "scheduledTime": "<ISO 8601 UTC datetime>"
}
```

**Queue to next free slot:**
```json
{
  "accountId": "<id>",
  "platform": "<platform>",
  "text": "<clean post text>",
  "mediaUrls": [],
  "useNextFreeSlot": true
}
```

### Step 3 — Confirm
- If live `publicUrl` returned: "Posted. [URL]"
- If `postSubmissionId` in-progress: call `blotato_get_post_status` after 10 seconds
- If scheduled: confirm the time

---

## Phase 6: Log to what-works.md

After any post is published or confirmed ready, append an entry to `~/.claude/what-works.md`:

```markdown
---

**[Platform] — [Date]**
Hook type: [type used]
Topic: [1-line topic description]
Format: [format type]
Hook (first line): [first line of the post]

_[Leave performance stats blank — member fills these in after posting]_
Engagement: 
Notes: 
```

Tell them: "Logged to what-works.md. Come back after 48 hours and add the engagement stats — that's how the system learns what to repeat."
