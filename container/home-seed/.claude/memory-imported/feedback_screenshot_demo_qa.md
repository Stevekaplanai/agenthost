---
name: feedback-screenshot-demo-qa-rule
description: "STANDING rule (Steve, 2026-05-31): after building/changing UI, do not just claim a green build. PREVIEW THE WHOLE THING WITH SCREENSHOTS and assemble them into a single visual demo doc (a contact sheet / HTML or markdown gallery) that serves as BOTH QA and marketing in one shot. Steve reviews pixels, not commit logs. Applies to Attribyte and all of Steve's product UI work."
metadata: 
  node_type: memory
  type: working_preference
  created: 2026-05-31
  status: standing
  originSessionId: 46177cb5-ffda-4d60-a3f4-05eaf2a8a897
---

# Screenshot-demo QA: preview the whole thing, assemble a demo

## The rule (Steve, 2026-05-31)
> "How do we QA this now? I set a rule last time. You're supposed to preview the
> whole thing with screenshots and put them together for me in a demo. QA and
> Marketing in one shot!"

After any meaningful UI build or change, the deliverable is NOT "tsc clean +
Vercel green." It is a VISUAL demo: screenshots of every affected page/screen,
assembled into one artifact Steve can scroll. This doubles as QA (catch visual
bugs like overflow, misalignment, off-brand color) and as marketing material
(a polished gallery of the product).

## What to produce
- One screenshot per page/screen (full page, scrolled if long, or stitched).
- Assembled into a single demo artifact: an HTML contact-sheet/gallery (preferred,
  embeds the PNGs with captions) or a markdown doc referencing them. Commit it
  under docs/ (e.g. docs/demo/<feature>-demo.html) and give Steve the full path
  + the Vercel preview URL.
- Caption each shot (page name, what's notable). Flag anything that looks off.

## How to capture when the app is AUTH-GATED (the recurring blocker)
Claude cannot log in (entering credentials is prohibited). The Vercel preview
redirects to /login. So screenshot the real React pages via a LOCAL no-auth
harness instead:
- Add a temporary harness (preview-pages.html + a tsx entry) that mounts each
  page inside the real providers (QueryClientProvider + BrowserRouter), selected
  by a ?p= query param. Run via `npm run dev` so .env (VITE_SUPABASE_* etc.) is
  loaded and the supabase client initializes (else the page throws at module load
  and renders BLANK, which is the trap hit on 2026-05-31).
- With no session, the pages' react-query hooks / api.get calls return empty or
  error, which triggers the NEVER-BLANK sample-data fallback. So the harness shows
  the fully-populated sample view, which is exactly the marketing-quality state to
  screenshot.
- Wrap in an error boundary AND capture the browser console on any blank screen,
  so a render/module error is diagnosed instead of silently shipping a blank.
- DELETE the harness files when done (they are not app code). Screenshot to disk
  with save_to_disk so they can be embedded/shared.

## Why the local harness, not the deployed preview
Deployed preview = auth wall Claude can't pass. Local harness on the sample path =
the real components, real CSS, real charts, no auth, fully populated. Same code
Vercel ships.

## Lesson that created this note
On the Attribyte dashboard + inner-pages work, Claude reported "tsc clean, Vercel
green" repeatedly but never assembled a screenshot demo, and a real visual bug
(horizontal bar charts overflowing their card on the Analytics page) shipped to
the preview unseen. Steve caught it by eye. Screenshots would have caught it first.
Green build != looks right. Always produce the visual demo.
