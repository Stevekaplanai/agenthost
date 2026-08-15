---
name: visual-gate
description: This skill should be used when the user asks to "run the visual gate", "capture the evidence", "screenshot this change", "/visual-gate", before merging any change to a visible surface, or when a completion claim is about to be made without rendered proof.
argument-hint: [url or page path, e.g. /pricing — omit to auto-detect from the diff]
allowed-tools: Read, Write, Bash, Glob, Grep
---
<!-- DOWNSTREAM COPY of visual-first-design/skills/visual-gate/SKILL.md (github.com/Stevekaplanai/visual-first-design). Copied 2026-08-15. Refresh from source; do not edit here. -->

# Visual Gate — Produce the Stage Evidence

Capture the visual evidence the current change requires — screenshots at both required viewports, before/after pairs — and emit a manifest a reviewer or a reviewer agent can verify. This is the Build/Change stage of the visual-first contract (see the visual-first-design-skill).

## Steps

1. **Determine what changed and where it renders.** From the argument, or by reading the diff (`git diff main...HEAD --name-only`) and mapping changed files to the pages/routes they affect. If a changed file renders nowhere reachable, that is a finding — report it; there is nothing to screenshot because the work is not wired in.

2. **Capture BEFORE.** Render the unchanged state — the main branch, the deployed URL, or the pre-change commit — at 390px and 1280px:

   ```bash
   mkdir -p visual-evidence/<change-slug>
   npx playwright screenshot --viewport-size=390,844 --full-page "$BEFORE_URL" "visual-evidence/<change-slug>/before-390.png"
   npx playwright screenshot --viewport-size=1280,800 --full-page "$BEFORE_URL" "visual-evidence/<change-slug>/before-1280.png"
   ```

   If the change is brand new (nothing existed before), capture the surrounding page as-is — the pair still shows what the change did to it.

3. **Capture AFTER.** Same two viewports, same routes, same scroll position, from the running changed code (dev server or preview deploy). Same filenames with `after-`.

4. **Verify every file exists.** `ls -la visual-evidence/<change-slug>/` — four PNGs minimum. A capture command that failed silently produces a manifest entry that is a lie; check before writing the manifest.

5. **Write the manifest.** `visual-evidence/<change-slug>/manifest.md`: a table of artifact → absolute path → viewport → source URL → capture timestamp, plus one line naming anything that could NOT be captured and why. The manifest never lists a file that is not on disk.

6. **Deliver.** The before/after pairs (phone pair first), the manifest path, and a one-line plain-language statement of what the pair shows. This evidence rides with the PR — commit `visual-evidence/` on the branch so the reviewer agent and the human can reach it.

## Rules

- 390px and 1280px are the floor, not the ceiling. Add viewports only when the change targets one.
- Before and after must be same-route, same-viewport, same-scroll — otherwise the pair proves nothing.
- The dev server proves the code; only the deployed URL proves the deploy. After a deploy, re-run the AFTER captures against the live URL and add them as `live-390.png` / `live-1280.png`.
- Never write a manifest entry for an artifact that does not exist on disk. An honest "could not capture X because Y" is a valid manifest line; a fabricated entry is the worst possible output.
