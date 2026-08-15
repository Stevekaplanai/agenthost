---
name: visual-first-design-skill
description: >-
  Use when building or changing anything a human will see or judge — UI, pages,
  dashboards, emails, documents — on a team where the reviewer is a product
  manager or non-developer technical operator, especially in autonomous or
  agent-driven CI/CD. Also use when reporting completion of such work, when a
  request is visually ambiguous, or when tempted to call something done because
  tests pass. Engine-agnostic — applies to Claude, Codex, Hermes, Kimi, Gemini,
  DeepSeek, or any agent harness.
---
<!-- DOWNSTREAM COPY of visual-first-design/skills/visual-first-design-skill/SKILL.md (github.com/Stevekaplanai/visual-first-design). Copied 2026-08-15. Refresh from source; do not edit here. -->

# Visual-First Development

The deliverable is the pixels, not the diff. The person steering this work cannot read code — they can read a screen, usually a phone screen. So the unit of communication at **every** pipeline stage is a visual artifact they can judge in under two minutes, not a summary of what the code does.

This inverts the default agent workflow. Agents review code; the human reviews consequences. A human gate that shows a file list to a non-coder is a rubber stamp. A human gate that shows a before/after screenshot is a real gate — the reviewer can actually fail it.

## The Visual Contract

Every stage emits a visual **before** the next stage starts. The gate question is what the reviewer answers from their phone.

| Stage | Visual artifact required | Gate question |
|---|---|---|
| **Intent** | A mock of the final result — static HTML, rendered image, or annotated sketch — BEFORE any implementation. If the request is ambiguous, 2–3 labeled mock options. | "Is this what you meant?" |
| **Build** | Screenshots of the real running result at 390px (phone) and ~1280px (desktop). Phone first. | "Does it look right?" |
| **Change** | Before/after pair, same viewport, same scroll position. | "Is after better?" |
| **Deploy** | Preview or live URL + a post-deploy screenshot taken from the deployed surface, not the dev server. | "Is it really live?" |
| **Done** | The completion report (shape below). | "Anything left for me?" |

The intent mock is the highest-leverage artifact in the pipeline. A mock costs minutes; a built-then-rejected feature costs the whole build plus a round-trip. When the request could reasonably go two ways, render both — a reviewer picks between two images in seconds, but a prose question sits unanswered for hours.

## Evidence rules

- **An artifact exists only if a tool produced it this session.** If no screenshot command ran, there is no screenshot, and writing "screenshot attached" is fabricating evidence — the single worst failure this skill exists to prevent.
- Every visual is delivered as a reachable thing: an attached image, an absolute file path, or an https URL. "Available on request" is not delivery.
- 390px phone + desktop is the minimum set for anything responsive. A single viewport proves a single viewport.
- Changes ship with before/after pairs. The pair is what makes a two-minute phone review possible; cutting it doesn't save time, it moves the time into a clarification round-trip.
- Post-deploy proof comes from the deployed URL. The dev server proves the code works; only the live surface proves the deploy worked.

Universal fallback when no richer browser tool is available (works on any engine with a shell):

```bash
npx playwright screenshot --viewport-size=390,844 --full-page "$URL" after-mobile.png
```

## Completion report — the shape

The report IS, in order:

1. **The visual, first.** Before/after or final screenshots, then the live/preview URL.
2. **What changed, in plain language.** One short paragraph or 3–5 bullets. No file lists up top, no jargon, no diff talk.
3. **Where it lives.** URL and absolute paths, each copy-pasteable.
4. **What was verified, with the proof named** — "checked live at 390px and 1280px, screenshots above" — verification is the agent's job; the visual is proof it happened, not a task handed to the reviewer.
5. **At most one question**, only if a real decision remains.

## Non-screen work

Work with no UI still gets a legible artifact: the API response rendered as a table, the log line that proves the job ran, the dashboard number that moved, a diagram of the flow. The reviewer gates on something they can see, or there is no gate.

## Rationalizations — all of these mean stop

| Excuse | Reality |
|---|---|
| "Tests already validate responsive behavior" | Tests assert DOM and logic. Only rendered pixels prove rendering. |
| "I'll screenshot at the end" | End-only visuals surface direction errors after the build is paid for. Mock first. |
| "The request was clear enough to skip the mock" | Placement, density, and tone are never in the ticket. Two minutes of mock beats a rebuilt section. |
| "Deadline — cut the before/after" | The pair is the fast path. Cutting it trades 1 minute now for a round-trip later. |
| "It's backend, nothing visual" | Then show the visible consequence. Something observable changed or the work isn't done. |
| "The reviewer can verify from the screenshot" | The screenshot is proof you verified. Handing verification to the reviewer is shipping unverified work. |
| "Screenshot attached" (no tool ran) | Fabricated evidence. Worse than no screenshot — it teaches the reviewer to trust proof that isn't there. |

## Red flags — stop and produce the visual

- About to write a completion report whose first section is a file list
- Referencing a screenshot no tool call produced
- Implementation started and the reviewer has not yet seen what the result will look like
- One viewport captured for a responsive surface
- "Done" claimed with the deployed URL never opened
