---
name: skai-video-magic-content-calendar
description: Build a 30-day, daily, raw-record YouTube content calendar end to end for GTMVP (or Steve's brand) — research the foundation, produce a per-row-approved Google Sheet (hook, raw-record script, thumbnail brief, in-sheet approval checkboxes), then generate thumbnails ONLY for approved rows. Use when the request is to plan a YouTube content calendar / a month of videos, build supporting videos for the SEO/AEO clusters, or "video magic." Orchestrates three companion skills: video-hacks, social-media-trends-research, and higgsfield-studio. Approval-gated: no thumbnail is generated until its row is approved.
---

# SKAI: Video Magic Content Calendar

Go from zero to a published-ready, 30-day daily YouTube calendar that shows competence, educates the audience, and ranks for SEO/AEO — then generate the thumbnails for the rows Steve approves. The recording is raw: Steve shoots 1 to 2 takes and uploads, no editing. So every script is written to be delivered straight to camera.

This skill is an **orchestrator**. It runs three companion skills in sequence and adds the calendar + approval + thumbnail layer on top:

- **`video-hacks`** (anthropic-skills:video-hacks) — the YouTube game engine: the 10-attribute Content Scorecard, title and thumbnail patterns, hook structures, Click → Watch → Return. Use it to score and shape every title, hook, and thumbnail.
- **`social-media-trends-research`** — the trend research stack (Google Trends, Reddit, web/social). Use it (fanned out across subagents) to ground topics in rising demand and timely news.
- **`higgsfield-studio`** — the media-generation gate + prompt craft. MUST be invoked before the first `generate_image` each session, or the PreToolUse gate blocks it by design. Use it for the thumbnail prompts and model IDs.

## When to use

- "Give me a month of YouTube ideas / a 30-day video calendar."
- "Build supporting videos for the SEO content we want to rank for."
- "Plan daily YouTube for GTMVP."
- Any time the deliverable is a content calendar that ends in thumbnails + a record-and-upload plan.

## When NOT to use

- A single video or one-off script (use `video-hacks` directly).
- Editing-heavy / produced video (this skill assumes raw 1-2-take delivery).
- Posting or sending anything (this skill never publishes; it plans and stages).

---

## The pipeline (run in this order — the foundation builds)

Steve's rule: **work the steps in order so each builds on the last.** Do not skip ahead to the sheet before the foundation is read.

### Step 0 — Review the repo, existing content, and plans
Before anything, get current. Fetch the live repo if one is in play (never work a stale clone), and inventory what already exists:
- The brand/product site map and live pages (the SEO/AEO clusters the videos will support). For GTMVP: pull `gtmvp.com/sitemap.xml` + `/blog`.
- Recent commits and any content/guides built in the last few days (e.g. `git log --since` on the marketing repo; recent `.md` in `Downloads`, `content-engine`, `docs/seo`).
- Any AEO / page-gap / data-report work already drafted — it reveals which pages need video support and which stats to reuse.

### Step 1 — Read the operating guidelines (.md files first)
Read these before drafting a single line. They are authoritative; never override them with training assumptions.
- `~/.claude/CLAUDE.md` (cardinal rules, execution defaults)
- `~/.claude/brand-voice.md` (voice, the AI-tell ban / no em-dashes, the **LinkedIn playbook**, the **B2B-ROAS rule**: ROAS is the wrong anchor for B2B — lead with CPA / cost per opportunity / pipeline / CAC payback)
- `~/.claude/icp.md` (who the videos talk to: Series A B2B SaaS founders who run their own Google Ads)
- `~/.claude/offer.md` (what each CTA leads to; current naming: **The Leak Report** = the free audit at `/leak-report`, **The Leak Check** = `/leak-check`; "Smart Bidding" names Google's feature only; approved proof set)
- `~/.claude/what-works.md` (proven hooks/angles to reuse, flops to avoid)
- Note any recent renames/directives (check `memory/` for the latest).

### Step 2 — Method + trends (invoke the two research skills; fan out subagents)
1. Invoke **`video-hacks`** to load the scorecard, title/thumbnail/hook patterns, and the Click → Watch → Return frame.
2. Invoke **`social-media-trends-research`**, then **fan out parallel subagents** (one per dimension) so coverage is broad and fast. Proven split:
   - YouTube trends (what's winning now in the niche: formats, titles, thumbnails, lengths)
   - LinkedIn trends (the B2B creator cohort's winning hooks/angles — audience overlaps)
   - Reddit / founder-community pain (verbatim language for hooks and titles)
   - Google Trends + AEO/search shift (rising queries; how AI answer engines change discovery)
   - News / newsjacking (last 2-3 weeks of timely, rideable developments)
   Require each subagent to return **conclusions only** (not raw dumps): top signals with sources+dates, patterns, 5 concrete video angles, and timely stat hooks.
3. Synthesize. Two load-bearing findings to apply by default:
   - **YouTube is the #1 AI-citation surface and long-form (10-20 min) wins the vast majority of those citations; Shorts underperform on views in this niche.** So weight mid-form as the SEO/citation assets and treat Shorts as daily reach + face-on-camera hot takes.
   - **Front-load anything perishable** (a launch, a deadline, a fresh study) into the first days so it's shot while it's still news. Tag each row's perishability.

### Step 3 — Build the YouTube sheet (30 days, with approval built in)
Create a Google Sheet (CSV → `application/vnd.google-apps.spreadsheet` via the Drive connector). **Every row gets its own approval control**, and **no thumbnail is generated until the row is approved.**

Column schema (the v3 standard, plus script + approval):

| Col | Field | Notes |
|---|---|---|
| A | Day | 1-30 |
| B | Date | daily cadence, start the next shoot day |
| C | Day of Week | |
| D | Video Title (Primary) | curiosity-led, scorecard-shaped, short |
| E | Alt Headlines (A/B Test) | 2 variants, `//` separated (split-test per video-hacks) |
| F | Format | `Short · face-cam` or `Mid-form · screen-share` |
| G | Length | Shorts 45-60s; mid-form 8-14 min (10-14 for citation topics) |
| H | SEO Cluster | which site cluster it supports |
| I | Target Keyword | the search/AEO term it owns |
| J | Supporting Page (full URL) | a LIVE page only; full `https://` URL (Ctrl+click-able) |
| K | Hook — First 15 Seconds | spoken, lands the stakes/number in <2s |
| L | Script (raw-record) | see Step 6 style; teleprompter-ready, one idea, 1-2 takes |
| M | YouTube Description | keyword first line, body, CTA full URL, related URL, 3-5 hashtags |
| N | Tags | comma-separated, paste-ready |
| O | Thumbnail Brief (Higgsfield) | one focal idea, <=3-4 words on-screen, brand register |
| P | Trend / Source (2026) | the trend it rides + PERISHABLE / SEMI / EVERGREEN + source |
| Q | CTA | full `https://` URL |
| R | Approved? | **checkbox** (default FALSE) — the gate |
| S | Status | dropdown: Draft / Approved / Shot / Published |

Content rules (from the .md files): no em-dashes; B2B copy uses CPA/pipeline/CAC, not ROAS; every external stat carries a source; full URLs everywhere; supporting pages must exist (if a video needs a page that isn't built, map it to the nearest live page and flag the gap as a page to build).

**Building the approval buttons into the sheet.** The CSV import cannot create checkboxes, so after creating the sheet, add the controls one of two ways:
- **Automated (preferred):** call the Google Sheets API `spreadsheets.batchUpdate` to (1) set the `Approved?` column (R) to boolean checkboxes via a `setDataValidation` request with `condition: { type: "BOOLEAN" }`, and (2) set the `Status` column (S) to a dropdown via `condition: { type: "ONE_OF_LIST", values: ["Draft","Approved","Shot","Published"] }`. Seed column R with `FALSE` so the checkboxes render unchecked.
- **Manual fallback (one-time, 20 seconds):** tell Steve to select column R → Insert → Checkbox, and column S → Data → Data validation → Dropdown. Document this in the hand-off so the sheet is usable immediately.

Present the sheet for **row-by-row approval**. Steve checks the `Approved?` box on the rows he wants. (He can also leave a note in any cell to request a tweak.)

### Step 4 — Approval gate (Steve)
Wait for approval. Steve marks rows `Approved? = TRUE` (and/or Status = Approved). Do not generate thumbnails for unapproved rows. This is a hard gate (matches the standing "approval required before publishing/producing" rule).

### Step 5 — Generate thumbnails for approved rows (Higgsfield + nano_banana_pro)
1. **Invoke `higgsfield-studio` FIRST.** The PreToolUse gate blocks the first `generate_image`/`generate_video` of the session until the skill is consulted — that deny is by design, not a bug. Consult it, then proceed.
2. Read the sheet; select only rows where `Approved? = TRUE`.
3. For each approved row, build the thumbnail from column O using `higgsfield` `generate_image` with the **nano_banana_pro** model (`nano_banana_pro`). Apply the brand register:
   - **GTMVP mid-form / tutorial thumbnails:** dark near-black instrument panel, sodium-amber accent, mono labels, one bold focal number/claim, <=4 words. No face.
   - **Face-cam Shorts:** Steve's face 40-60% of frame, natural emotion, 1-2 bold words, one contrast/cue. (Use his likeness/reference per higgsfield-studio.)
4. Batch by week (7 at a time), organize outputs into a per-week folder, and present them against their rows for a final yes before anything is treated as final. Update Status as rows move to Shot/Published.

### Step 6 — Record + upload (Steve, raw)
Steve records and uploads to YouTube himself: **raw, 1 or 2 takes, no editing.** This constraint shapes column L (Script):
- Write for the ear and for one continuous take. Short sentences. One idea. No "in this video" throat-clearing.
- Hook in the first 2 seconds (the scorecard's first-30-seconds rule, compressed).
- Plant one open loop, pay it off, end on ONE CTA (the video-hacks "one clear CTA" rule).
- Keep Shorts to a single beat (45-60s of spoken copy). Mid-form scripts are sectioned with on-screen cue notes the screen-share follows, so a single take stays on track.
- No reliance on cuts, b-roll, or graphics to carry meaning — if it needs an edit to make sense, rewrite it.

---

## Reminders & guardrails

- **Dual-channel reminders (cardinal):** when a perishable shoot has a real deadline (a launch/news window), set BOTH a scheduled `claude -p` reminder and a Google Calendar entry on `steve@stevekaplan.ai` so the window isn't missed. Write the durable fact to memory with a `review_after` date.
- **Never publish/post.** This skill stages drafts and thumbnails only.
- **Honesty:** real, sourced stats only; no fabricated numbers; approved proof set from `offer.md`.
- **Surgical + simple:** build the requested calendar completely, nothing extra.

## Output artifacts

1. A Google Sheet: 30 rows, the schema above, checkboxes + status dropdown wired in.
2. On approval: thumbnails (nano_banana_pro) for approved rows, organized by week.
3. A short hand-off: what's perishable (shoot first), which supporting pages should be built so videos have a citation home, and any reminders set.

## Companion skills (invoke, don't reimplement)

- `video-hacks` — scoring, titles, thumbnails, hooks, retention.
- `social-media-trends-research` — the trend research stack (fan out subagents).
- `higgsfield-studio` — media-gen gate + prompt craft + model IDs (run before the first generation).
