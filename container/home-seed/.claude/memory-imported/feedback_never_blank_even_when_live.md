---
name: feedback-never-blank-dashboards-even-when-live
description: "Standing UX rule (Steve, 2026-05-31): dashboards/charts/visualizations should NEVER render blank or barren WHENEVER POSSIBLE, including when the workspace IS connected to live data but a given section is empty or thin. Extends the existing 'never show empty states' build pattern from page-level to SECTION-level, and from disconnected-only to live-too. Applies to Attribyte and all of Steve's products."
metadata: 
  node_type: memory
  type: ux_principle
  created: 2026-05-31
  status: standing
  extends: feedback_build_patterns.md
  originSessionId: 46177cb5-ffda-4d60-a3f4-05eaf2a8a897
---

# Never ship a blank dashboard, even when live

## The rule (Steve, 2026-05-31)
> "I don't want our UX to include blank dashboards whenever possible even when live."

This sharpens the older `feedback_build_patterns.md` rule ("Never show empty
states"). Two upgrades:
1. **Section-level, not just page-level.** A page can be live overall yet have
   one empty chart/section. That section must not render blank either.
2. **Even when live.** The fallback is not only for brand-new / disconnected
   workspaces. A connected workspace with a thin or empty section still gets a
   populated, non-barren view.

## How to satisfy it WITHOUT lying (the honesty guard)
The cardinal honesty rule still holds: never present fabricated numbers as a real
client's data. Resolve the tension per SECTION:

- Section has live data -> render live data. (No label needed.)
- Section is empty -> render rich SAMPLE/preview data so the visualization shows
  in full, BUT carry a clear per-section "Sample" / "Preview" badge on that
  exact section so it can never be mistaken for the client's real numbers.
- Do NOT rely only on a single page-level "showing sample data" pill when a page
  MIXES live and sample sections. In a mixed state, a reader assumes every chart
  is their real data. Each sampled section needs its own visible badge.

So: never blank, always honest. The populated look comes from sample/preview
data; the honesty comes from per-section labeling.

## Decision precedent
Steve consistently values the FULL populated look ("so I can see all of the data
visualizations in the fullest form") over a tasteful empty state. When choosing
between (A) labeled sample/preview viz and (B) a guided empty-state card, prefer
(A) the populated-but-labeled visualization. Reserve guided empty states only for
where sample data would be actively misleading or impossible to shape.

## Implementation notes (Attribyte, PR #122 branch)
- Dashboard already does page-level: empty live payload -> SAMPLE_DASHBOARD +
  "Showing sample data" pill.
- The inner-pages workflow (2026-05-31) does per-DATA-SOURCE substitution: each
  empty hook/endpoint gets its sample counterpart, so sections never blank even
  when other sections on the page are live.
- REMAINING REFINEMENT (do in the final verification pass / future): make the
  "Sample" label per-SECTION, not one page-level pill, so mixed live+sample pages
  stay honest about which specific charts are sample. Track this until done.
