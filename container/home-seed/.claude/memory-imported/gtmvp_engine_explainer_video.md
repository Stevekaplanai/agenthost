---
name: gtmvp_engine_explainer_video
description: "Cinematic \"engine assembles\" explainer video for gtmvp.com /engine page — built 2026-06-02, on a branch pending Steve's merge decision"
metadata: 
  node_type: memory
  type: project
  originSessionId: 924c7f3e-9270-4cd7-823f-8e6a5bcd0dca
---

Cinematic 42s engine explainer for GTMVP, built 2026-06-02 (brainstorm -> spec -> plan -> build, all in one session). Distinct from the [[gtmvp_homepage_engine_video]] (that one is a screen-recording product DEMO; this is a stylized brand VISUALIZATION of "8 agents feed one ledger, the operator signs off").

**Concept:** "The engine assembles." 8 labeled brushed-metal hex modules ring a central THE LEDGER core, sodium-amber #FF5B1F on near-black. Beats: power-on -> assemble -> labeled reveal -> feed the ledger -> Diagnostic writes -> operator line -> GTMVP lockup -> free-audit CTA.

**The 8 customer-facing agent labels (from `lib/agents/registry.ts`, A_01-A_08, EXACT):** COMPETITOR, PRODUCT, POSITIONING, OFFER, ANGLES, CHANNELS, DEMAND AND DISCOVERY, TREND PULSE. Center = THE LEDGER. NEVER include A_09 Technical SEO / A_10 Conversion CRO (backend only).

**Outputs (all 42s):** `Downloads\gtmvp-engine-explainer\final\` — engine-16x9.mp4 (/engine + YouTube), engine-9x16.mp4 (Shorts/Reels/LinkedIn), engine-1x1.mp4 (feed), poster-16x9.jpg. Social copy drafts in `social-copy.md` (NOT posted, approval-gated).

**Pipeline (reusable):** higgsfield MCP for stills (`nano_banana_pro`, great at the labels) + motion (`kling3_0` locked over veo3_1 after a look test; both warp small AI text in motion, so the labeled reveal/lockup use ffmpeg zoompan on the STATIC labeled still, never AI-animated text). VO = Steve's CLONED ElevenLabs voice "Steve Kaplan AI" (voice id `8EhD2aAPMDgcGs1PHHCQ`), key in `ELEVENLABS_API_KEY`. Steve INSISTED on his own voice, not a stock one (Eric `cjVigY5qzO86Huf0OWal` was the rejected first pass). Synthesized via the `/with-timestamps` endpoint for exact word times, then beats cut to land each line (Steve's cadence = 35.6s total vs Eric's 42.4s, so all timing differs). Music = reused `Downloads\gtmvp-engine-video\music-bed.mp3`. On-screen text: ffmpeg `drawtext` started SEGFAULTING mid-session (fontconfig init access-violation, even with FONTCONFIG_FILE set), so text is now rendered as transparent PNGs via `make-overlays.ps1` (.NET System.Drawing, per-aspect layouts) and composited with ffmpeg `overlay ... enable='between(t,a,b)'`. PREFER the PNG-overlay path over drawtext on this machine. ffmpeg concat is strict: normalize setsar/fps/format/scale on every input before concat or it errors "Failed to configure output pad."

**Integration:** branch `feat/engine-explainer-video` off origin/main in `Projects\gtmvp-saasw\GTMVP_V0`. Edited `app/(public)/engine/EngineClient.tsx` -> EngineMasthead now passes the video as `mediaSlot` (reuses the existing `VideoFrame` + two-column `EditorialMasthead`, same pattern as the homepage hero). Video at `public/motion/engine-explainer.mp4` + poster. Verified locally (dev server :3003, desktop two-column + mobile stacked, clean compile). **MERGED + DEPLOYED to main** (Steve approved full ship 2026-06-02): commit c500158 added it, efa457a swapped the VO to Steve's voice. Live on gtmvp.com/engine AND gtmvp.com/smart-bidding-audit masthead (commit 78a7f16, auto-merged cleanly on top of a concurrent rewrite of the audit page by another session). Both use the same VideoFrame mediaSlot pattern. Spec+plan docs committed too. Video autoplays MUTED on-site (VO only heard on unmute), so the voice matters most for social/YouTube.
