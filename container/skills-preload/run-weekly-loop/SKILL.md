---
name: run-weekly-loop
description: Run one week of The Vibe Stack newsletter production. Use when Steve says "run the weekly loop", "produce this week's issue", "do week N", or wants to generate the next Vibe Stack newsletter bundle. Generates the issue HTML + kill-shot image + social hook video + LinkedIn/X copy, staged for manual paste into beehiiv.
---

# Run Weekly Loop - The Vibe Stack

Produce one complete week of The Vibe Stack newsletter: the issue, the assets, the social copy, all staged to disk for Steve to paste into beehiiv and publish.

## Hard facts (do not relitigate)

- Newsletter: **The Vibe Stack** (free, beehiiv, thevibestacknews.com). Community: **Stack Forge** (skool.com/thevibestack).
- **beehiiv publishing is MANUAL-PASTE.** The beehiiv API is Enterprise-only on Steve's plan. The loop generates everything to disk; Steve pastes the HTML into beehiiv's editor and hits publish. NEVER try to auto-publish to beehiiv.
- **Send slot: Tuesday 9:30am ET.** Default. (Research: Tuesday beats Monday inbox-chaos and mid-week fragmentation for B2B/founder audiences.)
- **Voice (enforce in ALL copy):** first person singular "I", proof before claim, short sentences, direct/builder-coded/contrarian. ASCII ONLY: no em-dashes, no en-dash ranges (write "to"), no arrows, no curly quotes. Numbers carry emphasis. No "leverage/synergize/seamless/empower". No throat-clearing. Sentence-case headlines. NEVER "Claude" in the brand name (body copy only).
- **Brand visuals:** near-black #0B0F14, amber-coral stacked-blocks tower, signal-green `>_`. NO cyan, NO blue.
- The roadmap (which tool each week) lives at `C:\Users\User\Projects\the-vibe-stack\loop\roadmap.json`. The 4 built+public repos are weeks 1-4 (statusbrew, proposalforge, recruiterai, competewatcher). Weeks 5+ are "planned" and gate the loop.

## The steps (do these in order)

### 1. Pick the week
Ask Steve which week, or infer the next un-shipped week. Confirm the tool and dollar figure from roadmap.json.

### 2. Run the build-gate + generator
```
node C:\Users\User\Projects\the-vibe-stack\loop\generate-issue.mjs <weekNumber>
```
- If it EXITS 2 (build gate), the week's repo is not built/public. STOP. Tell Steve: build that product first (use the saaspocolypse build pattern at `the-vibe-stack\BUILD-PATTERN.md`), push it public, set its status to "public" in roadmap.json, then re-run. Do not fabricate a "fork this" issue for a repo that does not exist.
- If it succeeds, it staged `issues\wkNN\wkNN-<repo>.html` (with `{{tokens}}`) and `brief.json`.

### 3. Write the teardown copy (fill the tokens)
Read `issues\wkNN\brief.json`. Fill the four `{{tokens}}` in the HTML, in Steve's voice, grounded in the REAL repo (read the actual repo's README/code if needed - never invent features the repo does not have):
- `{{HEADLINE}}` - the kill-shot headline (e.g. "I rebuilt PandaDoc in a weekend.").
- `{{WHY_PARAGRAPHS}}` - 2 to 3 short paragraphs on why the tool is beatable (what it overcharges for, how small it actually is underneath).
- `{{BUILD_PARAGRAPHS}}` - the teardown: the real parts of the build (read the repo), numbered, what each piece does, where the AI feature is.
- `{{LESSON}}` - one reusable "steal my stack" pattern.
Edit the HTML file in place. Then render a preview PNG (headless Chrome) and confirm it looks right + has zero em-dashes.

### 4. Generate the kill-shot image
Use `brief.json`'s `killShotImagePrompt` with fal.ai `nano-banana-pro` (best typography for the dollar number). Save to `social\wkNN\killshot.png`. Verify the number renders cleanly.

### 5. Generate the social hook video (optional but default-on)
Higgsfield: nano_banana_pro start frame (9:16, the brief's social hook + dollar number) -> animate with kling3_0 (get_cost preflight first, ~10 credits) -> run virality_predictor. Save to `video\wkNN\hook.mp4`. Skip if Steve is low on Higgsfield credits.

### 6. Write the social copy
In Steve's voice, write and save to `social\wkNN\copy.md`:
- A LinkedIn "I replaced a $X tool" post (the validated viral format).
- An X thread (hook tweet + the build moves + repo link).
Tie to the live trend if one is hot.

### 7. Stage + report
Everything lives in `issues\wkNN\` + `social\wkNN\` + `video\wkNN\`. Report to Steve with FULL absolute paths (Cardinal Rule 7) in a table: the issue HTML to paste, the image, the video, the copy. Remind him: paste the HTML into beehiiv, review, publish Tuesday 9:30am ET. Social can auto-schedule via Blotato around the send.

## What the loop does NOT do
- Does NOT publish to beehiiv (manual paste, Enterprise-gated API).
- Does NOT build the product (that is a separate build session; the gate just checks it exists).
- Does NOT invent repo features - read the real repo and describe what is actually there.

## Scaling later
To automate: wrap this in a scheduled `claude -p` / CronCreate that fires Tuesday ~6am ET with the week number, so the bundle is staged before Steve wakes. Per Cardinal Rule 1, pair any schedule with a calendar entry. Not built yet - on-demand for now.
