---
name: visual-report
description: This skill should be used when the user asks to "write the completion report", "report this done", "/visual-report", or when any unit of visible work is about to be reported complete to a product manager or non-developer operator.
argument-hint: [change slug or PR number — omit to use the current branch]
allowed-tools: Read, Bash, Glob, Grep
---
<!-- DOWNSTREAM COPY of visual-first-design/skills/visual-report/SKILL.md (github.com/Stevekaplanai/visual-first-design). Copied 2026-08-15. Refresh from source; do not edit here. -->

# Visual Report — Compose the Completion Report

Assemble the completion report in the visual-first contract shape, verifying every artifact it references actually exists before a single line is written. This is the Done stage of the visual-first contract (see the visual-first-design-skill).

## Steps

1. **Inventory the evidence.** Glob `visual-evidence/<slug>/` for the expected artifacts: before/after pairs at 390px and 1280px, live captures if deployed, the manifest. Confirm each file exists and is non-empty.

2. **If anything is missing, produce it first.** Run the visual-gate steps for the missing artifacts. Do not write the report around a gap, do not describe a screenshot that was never taken, do not substitute "tests pass" for a missing capture. The report waits for the evidence, never the reverse.

3. **Write the report in this exact order:**

   1. **The visual, first.** Before/after pair (phone first), then the live or preview URL.
   2. **What changed, in plain language.** One short paragraph or 3–5 bullets. No file lists up top, no jargon, no diff talk.
   3. **Where it lives.** The https URL and the absolute file paths, each copy-pasteable on the reader's actual device — a URL clicks everywhere including a phone; a path serves the desktop reader.
   4. **What was verified, with the proof named.** "Checked live at 390px and 1280px — captures above." Verification is the agent's job; the visuals prove it happened. Never hand the reviewer a verification task disguised as a report.
   5. **At most one question**, only if a real decision remains. Zero questions is the normal case for finished work.

4. **Deliver on the reader's surface.** If the operator reads from a phone, images and https links lead; file paths follow for the desk session later.

## Rules

- The report's first screen-height is visuals and plain language. A reviewer who reads only that far must already know whether the work is right.
- Every referenced artifact was verified on disk in step 1 this session — referencing evidence from memory of having made it is how fabrication happens.
- One report per unit of work. Batching five changes into one report buries the one the reviewer would have failed.
