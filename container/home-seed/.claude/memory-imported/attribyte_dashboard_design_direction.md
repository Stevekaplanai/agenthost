---
name: attribyte-dashboard-design-direction-original-not-claude-design-clone
description: "When the Attribyte dashboard redesign phase begins (after Workstream A/B/C), Claude designs an ORIGINAL dashboard — do NOT clone the Claude Design ui_kit. One dashboard only (no operator toggle). The Claude Design version is reference/critique only: it was plain, charts boring, mock data missing, inner pages barely done."
metadata:
  node_type: memory
  type: design_direction
  created: 2026-05-31
  originSessionId: 7d277528-b1ec-45be-9920-e71596c528e4
---

# Attribyte dashboard redesign — design direction (Steve, 2026-05-31)

## The directive
Steve does NOT want the Claude Design ui_kit used. He wants Claude to CREATE
the dashboard design originally. The Claude Design artifact
(api.anthropic.com/v1/design/h/bCZBzs46My86wPkRLqai9w — authenticated, Claude
cannot fetch it) is reference/feedback ONLY.

## Steve's critique of the Claude Design version (= the anti-spec)
- "Overall it looks very plain."
- "The charts look boring."
- "There is a ton of missing mock data from the designs."
- "Claude design didn't really do many of the inner pages."

So the original design MUST: not be plain, have non-boring/distinctive charts,
be populated with realistic mock/sample data so it never looks empty, and cover
the inner pages too (not just the landing dashboard).

## Hard constraints
- ONE dashboard only. The operator-dashboard TOGGLE is NOT needed — drop it.
- Follow the established design system (docs/DESIGN_SYSTEM.md): brand blue
  #0c8ee9, dark slate sidebar, the shared chart-theme.tsx from Workstream C
  (dark tooltips, no CartesianGrid, brand palette). Build ON the C chart work,
  don't undo it.
- Honor the "User experience overrides everything" + "never show empty states"
  rules: rich sample data, populated charts, no barren tabs.
- No em-dashes in any UI copy (house style).

## Sequencing
This is AFTER Workstream A (nav consolidation — done), C (chart rebrand — done),
and B (walkthroughs/plain-English — in progress as of 2026-05-31). The dashboard
redesign is its own phase, to start once B lands. Steve said "run Workstream B
now, dashboard after."

## Inspiration benchmarks (from earlier this session)
- Warmly (visual warmth/polish), Stiddle (simplicity for non-technical GTM teams,
  lead-with-the-answer). The dashboard should feel like a funded B2B SaaS product,
  not a starter template.
