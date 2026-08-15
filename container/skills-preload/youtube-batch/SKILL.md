# YouTube Content Batch — Biweekly Cycle

Run this skill every 2 weeks to generate one full week of YouTube content for the Paid Media OS channel.

**Invoke as:** `/youtube-batch`

**Output per run:**
- 1 long-form Teardown script (8-10 min)
- 4 evergreen Shorts scripts (Leak Cuts + Build-in-Public)
- 3 trend-jack Short scripts (filled from TrendJacker + live cross-check)
- Updated `docs/youtube/scripts-hub.html` with all new scripts embedded
- Commits to main

---

## Step 1 — Read the brain files

Before doing anything else, read these four files in full:

- `C:\Users\User\.claude\brand-voice.md`
- `C:\Users\User\.claude\icp.md`
- `C:\Users\User\.claude\offer.md`
- `C:\Users\User\.claude\what-works.md`

Then read the content config:
- `C:\Users\User\Projects\gtmvp-saasw\GTMVP_V0\docs\youtube\content-config.json`

This tells you which week you're on, which long-form topic is next, and which evergreen scripts still need to be written.

---

## Step 2 — Review what-works.md

Scan the YouTube log entries in what-works.md. Report:
- Which lane (Leak Cut / Trend-Jack / Build-in-Public) pulled the most views
- Best-performing hook verbatim
- Any pattern worth replicating this cycle
- Any format or angle that flopped (avoid repeating)

If what-works.md has no YouTube entries yet, skip this step and note it — the first cycle has no data to learn from.

---

## Step 3 — Determine this week's content slate

Read `content-config.json`. The config tells you:
- `current_week`: which week number this is
- `long_form_queue`: the ordered list of long-form topics; use the first `pending` entry
- `evergreen_scripts_remaining`: which evergreen Short slots still need scripts

For weeks 1-2, the full slate is pre-specified in the config. From week 3 onward, the long-form topic is derived from: (a) what-works.md performance data, (b) the Paid Media OS positioning, and (c) a fresh angle the ICP hasn't seen yet.

**Week 3+ long-form topic selection rules:**
- Must be a Google Ads / paid media teardown the creator can show on the demo dashboard
- Must name a specific dollar amount, account-level mistake, or countable metric in the title
- Must not repeat a topic from a prior week
- Pitch 2 options, get a pick before scripting

---

## Step 4 — Get TrendJacker output

Say to the user:
> "Paste your TrendJacker output for this week and I'll cross-check which trends are still climbing."

Wait for the paste. If the user skips this step, fill all 3 trend slots with evergreen Leak Cuts from the overflow bank in the config.

---

## Step 5 — Live trend cross-check (freshness gate)

For each TrendJacker topic that touches paid media, B2B SaaS, Google Ads, or AI in ads:

1. Web search the topic scoped to the last 7 days
2. Check YouTube upload date filter (last 7 days) — is content volume still climbing?
3. Check Reddit r/PPC, r/googleads, r/marketing — active discussion in last 3 days?

**Pass criteria (all three must be true):**
- Volume still climbing (not peaked)
- At least one post/thread with engagement in the last 48 hours
- Not saturated — 3+ large channels have not already posted the identical take

Drop any topic that fails. Replace with the next item on the TrendJacker list, or fall back to an overflow evergreen Leak Cut.

Report the 3 passing topics to the user before scripting.

---

## Step 6 — Script everything

### Voice rules (enforce on every line):
- Sentences under 12 words. Numbers always specific ($45,446 not "about $45K").
- Open confrontationally or declaratively. No warm-up filler.
- No hedging: no might / could / perhaps / I think / maybe.
- No em-dashes in delivered lines. No curly quotes. No AI-giveaway markers.
- No third-party tool names in delivered lines (no "Google Analytics," no competitor names).
- Short closes: Shorts → "Subscribe if you run your own ads." BIP Shorts → "Subscribe if you build things." Long-form → "Free Smart Bidding Audit at gtmvp.com."

### Long-form Teardown script:
- Duration: 8-10 minutes
- Structure: Hook (confrontational, names a $ amount or countable problem) → Who this is for → 3-5 leaks/points with demo dashboard walk-through → CTA
- On-screen: demo dashboard (`docs/youtube/demo-dashboard/demo-dashboard.html`) for the analytical sections, talking head for hook and CTA
- CTA: "Free Smart Bidding Audit at gtmvp.com. Link in the description."
- Save to: `docs/youtube/scripts/week[N]-teardown-[slug].md`

### Evergreen Short scripts (Leak Cuts):
- Duration: ~40 seconds (~90 words spoken)
- Structure: Confrontational opener → show dashboard moment → specific fix stated as imperatives → soft CTA
- Save each to: `docs/youtube/scripts/day[NN]-leak-cut-[slug].md`

### Build-in-Public Short script:
- Duration: ~40 seconds
- Hook: what Steve shipped on GTMVP this week (read the recent git log or ask Steve)
- Close: "Subscribe if you build things."
- Save to: `docs/youtube/scripts/day[NN]-bip-[slug].md`

### Trend-Jack Short scripts (3):
Use this prompt template for each:
> "Write a 40-second YouTube Short script for this trend: [TOPIC]. Voice: Steve Kaplan brand voice (see brand-voice.md). Open contrarian: name what most founders get wrong about this. Land on what it does to their Google Ads CAC or pipeline. Specific numbers required. Close with: 'Free Smart Bidding Audit at gtmvp.com. Subscribe if you run your own ads.' Rules: sentences under 12 words, no hedging, no em-dashes, no curly quotes, no AI giveaway markers."

Save each to: `docs/youtube/scripts/day[NN]-trend-jack-[slug].md`

---

## Step 7 — Voice check every script

Before committing, verify each script:
- [ ] Contrarian opener, no warm-up
- [ ] At least one specific number in the body
- [ ] No hedging words anywhere
- [ ] No em-dashes in spoken lines
- [ ] CTA names the URL
- [ ] Correct close ("run your own ads" for Leak Cuts, "build things" for BIP)

---

## Step 8 — Update scripts-hub.html

The scripts hub at `docs/youtube/scripts-hub.html` must be updated to include all new scripts for the week. Read the existing file, then add the new scripts to the sidebar and embed their content in the JS data arrays. Maintain all existing scripts — just append the new ones.

---

## Step 9 — Update content-config.json

After scripting is complete, update the config:
- Increment `current_week`
- Mark the used long-form topic as `done`
- Remove used evergreen scripts from `evergreen_scripts_remaining`
- Append any new overflow evergreen topics discovered during the week

---

## Step 10 — Posting schedule

Output the posting schedule for the week:

| Day | Post | Lane |
|---|---|---|
| Day 1 | [first Leak Cut Short] | Leak Cut |
| Day 2 | [second Leak Cut Short] + Long-form Teardown | Leak Cut + Long-form |
| Day 3 | Trend-Jack #1 | Trend-Jack |
| Day 4 | [third Leak Cut Short] | Leak Cut |
| Day 5 | Build-in-Public Short | BIP |
| Day 6 | Trend-Jack #2 | Trend-Jack |
| Day 7 | Trend-Jack #3 | Trend-Jack |

---

## Step 11 — Commit and push

```bash
git add docs/youtube/scripts/ docs/youtube/scripts-hub.html docs/youtube/content-config.json
git commit -m "content(youtube): Week [N] scripts + trend-jacks"
git push origin main
```

---

## Step 12 — Log reminder

Tell the user:
> "After each video settles (48-72h), open what-works.md and append the result using the template in the batch-shoot checklist. That data feeds the next cycle's Step 2."

---

## Overflow Leak Cut bank

Topics to use when trend slots fall short or for extra Leak Cut Shorts:
- "The negative keyword list almost no founder builds" (Day 10 in the 14-day plan)
- "The one conversion event that predicts revenue" (Day 13)
- "Why your Quality Score doesn't matter (and what does)"
- "The match type setting that's costing you 30% of your budget"
- "You're measuring CPA wrong — here's the number that actually matters"
- "The one Google Ads report founders never open"
- "Why your remarketing list is almost certainly empty"

---

## Reference files

- Brand voice: `C:\Users\User\.claude\brand-voice.md`
- ICP: `C:\Users\User\.claude\icp.md`
- Offer: `C:\Users\User\.claude\offer.md`
- What works: `C:\Users\User\.claude\what-works.md`
- Design spec: `C:\Users\User\Projects\gtmvp-saasw\GTMVP_V0\docs\superpowers\specs\2026-05-29-youtube-14day-plan-design.md`
- Demo dashboard: `C:\Users\User\Projects\gtmvp-saasw\GTMVP_V0\docs\youtube\demo-dashboard\demo-dashboard.html`
- Scripts hub: `C:\Users\User\Projects\gtmvp-saasw\GTMVP_V0\docs\youtube\scripts-hub.html`
- Content config: `C:\Users\User\Projects\gtmvp-saasw\GTMVP_V0\docs\youtube\content-config.json`
- Batch-shoot checklist: `C:\Users\User\Projects\gtmvp-saasw\GTMVP_V0\docs\youtube\checklists\batch-shoot-checklist.md`
- JIT trend workflow: `C:\Users\User\Projects\gtmvp-saasw\GTMVP_V0\docs\youtube\checklists\jit-trend-fill-workflow.md`
