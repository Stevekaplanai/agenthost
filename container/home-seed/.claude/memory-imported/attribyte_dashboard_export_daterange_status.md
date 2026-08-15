---
name: attribyte-dashboard-export-daterange-status
description: Status of the Attribyte dashboard Export + date-range scheduled-task to-do — mostly already shipped; only TrendCard Day/Week/Month re-bucketing remains a stub
metadata: 
  node_type: memory
  type: project
  review_after: 2026-06-16
  originSessionId: c081bb44-0f56-4b80-b3af-53b95f744662
---

The scheduled task `attribyte-wire-export-and-daterange` (reminder written 2026-05-31, when both controls were visual-only stubs) is now **largely obsolete** — the work shipped at some point after the reminder.

**Verified live state (2026-06-09, repo `C:\Users\User\Projects\attribyte`):**

1. **Export — DONE.** `apps/web/src/pages/DashboardPage.tsx:211-220` has a real `handleExport` (builds CSV via `buildDashboardCsv`, downloads via `downloadTextFile`). Button is wired (`onClick={handleExport}`, line 273). Real module `apps/web/src/lib/dashboard-export.ts` exists.
2. **Date-range picker — DONE.** `dateRange` state (line 122), `load()` effect depends on `[dateRange]` and threads `rangeQuery(rangeWindow(dateRange))` into all four fetches (lines 144-195), bare paths preserved. Real `DateRangeMenu` control wired to `setDateRange` (line 267). Real module `apps/web/src/lib/dashboard-range.ts` exists.
3. **TrendCard Day/Week/Month re-bucketing — STILL A STUB.** `apps/web/src/components/dashboard/overview/TrendCard.tsx:43` — `const [range, setRange] = useState('Week')` is set but never read; chart data derives only from `trends`. FieldHelp copy (line 65-67) admits it's "visual only." Subtitle hardcoded "last 30 days" (line 61). This is the only remaining piece of the original to-do.

**Did NOT implement** — scheduled run, Steve absent, task file explicitly says "confirm with Steve first." Reported instead. See [[feedback_verify_clean_build_first]] and the Attribyte stale-clone lesson behind Cardinal Rule 4.

**Decision Steve owes:** (a) close the task as mostly-done and leave TrendCard intentionally visual, or (b) green-light wiring just the TrendCard re-bucket (small, scoped change in TrendCard + a re-bucketing helper, no API change — bucket the existing daily `trends` rows into weeks/months client-side).
