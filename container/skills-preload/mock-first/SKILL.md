---
name: mock-first
description: This skill should be used when the user asks to "mock this first", "show me options before building", "render the intent", "/mock-first", or when any visually ambiguous build request arrives and the visual-first contract requires an intent mock before implementation.
argument-hint: <feature request, e.g. "add a testimonials section to the homepage">
allowed-tools: Read, Write, Bash, Glob, Grep
---
<!-- DOWNSTREAM COPY of visual-first-design/skills/mock-first/SKILL.md (github.com/Stevekaplanai/visual-first-design). Copied 2026-08-15. Refresh from source; do not edit here. -->

# Mock First — Render the Intent Before Building It

Produce 2–3 labeled visual mock options for a requested feature BEFORE any implementation, so the reviewer picks a direction from images instead of answering prose questions. This is the Intent stage of the visual-first contract (see the visual-first-design-skill).

## Steps

1. **Identify the ambiguous axes.** Read the request and name what it does not specify: placement, layout, density, count, tone, imagery. Two or three axes maximum — the ones that would most change the result.

2. **Read the real design system.** Pull actual tokens from the target codebase — colors, fonts, spacing, existing components — so mocks look like the product, not like a wireframe kit. A mock in the wrong brand tests nothing.

3. **Build 2–3 static HTML mocks.** One self-contained HTML file per option in `visual-evidence/<feature-slug>/`, named `mock-a.html`, `mock-b.html`, `mock-c.html`. Each option takes a genuinely different position on the ambiguous axes — not three spacings of the same idea. Populate with realistic content, never lorem ipsum.

4. **Screenshot every mock at 390px.** Phone viewport is the gate; desktop refinement is build-stage work.

   ```bash
   npx playwright screenshot --viewport-size=390,844 --full-page "file://$PWD/visual-evidence/<feature-slug>/mock-a.html" "visual-evidence/<feature-slug>/mock-a-390.png"
   ```

   Verify each PNG exists afterwards (`ls -la visual-evidence/<feature-slug>/`). A screenshot that was not captured does not exist and must not be referenced.

5. **Present the options.** Deliver: the screenshots (attached or as absolute paths), one line per option stating the position it takes, and one question: "Which one?" No implementation detail, no file lists.

6. **STOP.** Implementation does not start until an option is picked. If the operator is away, deliver the options through a channel that reaches their phone and wait. The chosen mock becomes the build target, and its "before" state (current page without the feature) gets captured now as the baseline for the build stage's before/after pair.

## Rules

- Options differ in substance, not styling trivia. If two mocks answer the ambiguous axes identically, delete one.
- Three options maximum. A reviewer on a phone picks between three images in seconds; five is a chore.
- Real brand, real content, real viewport. The mock's job is to be mistakable for the finished feature.
- Never skip to building because the request "seems clear." Placement, density, and tone are never in the ticket.
