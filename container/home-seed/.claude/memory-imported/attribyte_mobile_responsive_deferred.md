---
name: attribyte-mobile-responsive-redo-deferred-to-2026-06-07
description: "PR #80 (Attribyte web mobile-responsive) was CLOSED AS STALE on 2026-05-31 (too many merges behind main after the #118-#127 redesign). Steve chose to redo the mobile pass FRESH against current files. Scheduled 2026-06-07: claude -p task + Google Calendar event both set. Don't start before then or without Steve confirming."
metadata: 
  node_type: memory
  type: deferred_task
  created: 2026-05-31
  review_after: 2026-06-07
  originSessionId: 46177cb5-ffda-4d60-a3f4-05eaf2a8a897
---

# Attribyte mobile-responsive redo (deferred to 2026-06-07)

## What happened (2026-05-31)
Steve: "#80 check it, finish it, commit it and merge it." On inspection PR #80
was many merges behind main (app shell restructured around AppLayout;
dashboard + all inner pages reworked in #118-#127). Steve then chose
"Data-Driven now, defer #80" -> close #80 stale, redo mobile fresh. #80 was
closed with an explanatory comment (no work lost; intent captured here).

## Scope of the fresh pass
Original #80 touched: apps/web/src/components/layouts/AppLayout.tsx,
components/ui/dialog.tsx, and pages Attribution, Audiences, Campaigns,
ContactDetail, Integrations, Settings, Simulation, SystemPerformance, Velocity,
auth/Signup. PLUS: re-check the redesigned Dashboard + inner pages (Accounts,
Opportunities, Campaigns, the 6 Insights tabs, Creatives) at mobile widths,
since those are the current surfaces. RE-AUDIT FIRST: much may already be
responsive after the redesign.

Targets: wide tables scroll/stack on narrow viewports; multi-column grids
collapse; date-range picker / insight hero / chart cards do not overflow on
mobile. Test at 375 / 768 / 1280px.

## Process when it fires (standing rules)
- Mockups-first for visual variance (feedback_ui_mockups_before_committing.md).
- Branch suffix -FS6Lj. tsc + CACHE-CLEARED vite build (delete *.tsbuildinfo)
  before claiming green (feedback_tsbuildinfo lesson).
- Screenshot-demo QA across mobile+desktop widths (feedback_screenshot_demo_qa.md);
  auth-gated, so local no-auth harness on the sample-data path if needed.
- Merge only after Steve approves; verify prod Vercel deploy READY.

## Reminders set (dual-channel)
- claude -p scheduled task: attribyte-mobile-responsive-fresh, fires 2026-06-07 10:00 ET.
- Google Calendar event on steve@stevekaplan.ai: 2026-06-07 10:00-10:30 ET.

## Related deferred item
- Nav item consolidation -> 2026-06-14 (attribyte_nav_consolidation_deferred.md).
