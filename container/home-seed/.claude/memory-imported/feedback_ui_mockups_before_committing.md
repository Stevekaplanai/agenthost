---
name: feedback-show-html-mockups-before-committing-ui-ux-decisions
description: "CARDINAL working preference (Steve, 2026-05-31): whenever a UI or UX decision might turn out differently than Steve is expecting, build 2-3 distinct standalone HTML mockups (rich mock data, openable by double-click, no build step) and let him REACT to real pixels before committing to one. Then build the chosen direction for real. He explicitly said: 'Whenever there is a UI or UX decision that may turn out differently than I am expecting we should always do this.'"
metadata: 
  node_type: memory
  type: working_preference
  created: 2026-05-31
  status: cardinal
  originSessionId: 46177cb5-ffda-4d60-a3f4-05eaf2a8a897
---

# Show distinct HTML mockups before committing any UI/UX decision

## The rule (Steve's words, 2026-05-31)
> "OK let's do it this is a great way to build. Whenever there is a UI or UX
> decision that may turn out differently than I am expecting we should always
> do this."

When a UI/UX choice has real aesthetic or layout variance (a dashboard, a page
redesign, a new component's look, a layout direction, a chart style, anything
where Steve's mental picture and Claude's output could diverge): do NOT build
one finished thing and hope it lands. Instead:

1. **Produce 2-3 GENUINELY DISTINCT directions** as standalone static HTML files
   (inline CSS, CDN chart lib OK, fully populated with realistic mock data, no
   empty states, openable by double-click, no build step).
2. **Let Steve react to real pixels** and pick one, or cherry-pick pieces across
   them ("the header from A, the insight card from C").
3. **Then build the chosen direction for real** in the actual stack (React, etc.),
   wired to live data, on the established design system.

## Why this works for Steve
He discovers what he likes by SEEING options, not by reading abstract choices or
reacting to a single finished artifact. Cheaper to iterate on HTML than to build
React three times. He steers the aesthetic up front instead of sending Claude
back to redo a finished build. This is the same pattern that produced the
Attribyte dashboard design-directions phase (direction-a-command-center /
direction-b-warm-editorial / direction-c-insight-first in
docs/dashboard-mockups/).

## When to apply
- ANY net-new page or dashboard design.
- A redesign where the look could land differently than expected.
- A distinctive component (charts, hero, nav treatment) with aesthetic variance.

## When NOT to apply (don't over-trigger)
- Mechanical/cosmetic edits with one obvious answer (swap a color token, fix
  spacing, rename a label).
- A change that exactly matches an already-established pattern in the design
  system (just follow the pattern).
- Bug fixes and wiring with no visual judgment call.

## Mechanics that work
- A Workflow with one agent per direction, run in parallel, each writing one
  self-contained HTML file. Bake the brand constraints (DESIGN_SYSTEM.md tokens,
  brand blue #0c8ee9, dark sidebar, no em-dashes, never-empty) into every agent
  prompt so the directions differ in AESTHETIC, not in correctness.
- Put mockups in `docs/dashboard-mockups/` (or `docs/<feature>-mockups/`) so they
  are committable and Steve can reopen them later.
- Give Steve FULL file paths to double-click (cardinal full-path rule).
