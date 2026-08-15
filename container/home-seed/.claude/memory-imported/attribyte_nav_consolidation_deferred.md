---
name: attribyte-nav-item-consolidation-deferred-to-2026-06-14
description: "Deferred task (Steve, 2026-05-31): the Attribyte left-nav was grouped into 5 GROUPS by Workstream A, but the per-ITEM count is still ~8-12. Steve wants the item count consolidated toward ~5 primary destinations, but NOT now: scheduled 2 weeks out (2026-06-14). claude -p task + Google Calendar event both set. Do not start before then or without Steve confirming."
metadata: 
  node_type: memory
  type: deferred_task
  created: 2026-05-31
  review_after: 2026-06-14
  originSessionId: 46177cb5-ffda-4d60-a3f4-05eaf2a8a897
---

# Attribyte nav item consolidation (deferred to 2026-06-14)

## What Steve said (2026-05-31)
> "weren't we going to 5 tabs we went from 8-12 but I don't want to do a refactor
> for that. This has been a very long session. But I thought that that was in
> your original scope for this plan and we discussed it at least. Maybe it was
> not in there. Let's schedule it for 2 weeks out."

## Actual state
- Workstream A (PR #118) grouped the 9 flat sidebar tabs into 5 nav GROUPS:
  Overview / Insights / Pipeline / Connect / Settings, in
  apps/web/src/components/layouts/AppLayout.tsx. That was group-level.
- The per-ITEM count is still ~8-12 individual nav items. The "5 tabs" Steve
  remembers was the group count; he now wants the visible item count reduced too.
- Arguably implied by the simplification plan (Stiddle "4-verb IA, not 9 nouns")
  but the per-item reduction was never explicitly executed.

## The deferred task
Reduce individual top-level nav items toward ~5 primary destinations by nesting
secondary analysis surfaces (Measurement, Velocity, Predictions, Simulation,
Advanced Analytics, Attribution) under fewer parents or behind in-page sub-tabs.
NEVER delete routes (hide surfaces, keep engineering dormant; every page stays
reachable).

## Process when it fires (honor standing rules)
1. UI/UX decision with variance -> build 2-3 HTML mockups, let Steve react BEFORE
   implementing (feedback_ui_mockups_before_committing.md).
2. Keep dark slate sidebar + brand-blue active indicator + mobile drawer.
3. Branch suffix -FS6Lj. tsc + CACHE-CLEARED vite build (delete *.tsbuildinfo)
   before claiming green. Then a screenshot demo (feedback_screenshot_demo_qa.md).

## Reminders set (dual-channel, per cardinal rule)
- claude -p scheduled task: attribyte-nav-tab-consolidation, fires 2026-06-14 10:00 ET.
- Google Calendar event on steve@stevekaplan.ai: 2026-06-14 10:00-10:30 ET.
