---
name: gtmvp_homepage_engine_video
description: The 60-second engine demo video LIVE on the gtmvp.com homepage — source assets + how it was built (for re-edits)
metadata: 
  node_type: memory
  type: project
  originSessionId: a902c679-d176-45f5-891c-65096f2e633d
---

LIVE on the gtmvp.com homepage (PR #236, merged + deployed 2026-06-02): a 60-second narrated engine-demo video sits right under the "Uncover all your wasted spend in 60 seconds" hero. Rendered via `VideoFrame` in `app/(public)/page.tsx`, placed as a plain `<section>` between `EditorialMasthead` and `PlatformStrip`. **Click-to-play with sound** (`autoPlay={false} muted={false} loop={false}` — these props were added to `components/v2/VideoFrame.tsx`, defaulting true so existing usages are unchanged). Repo assets: `public/motion/engine-demo-60s.mp4` (12.5MB, h264 crf26 + faststart) + `engine-demo-poster.jpg` (the "Eight specialized agents. One running engine" frame).

**Source assets + pipeline — all in `C:\Users\User\Downloads\gtmvp-engine-video\`:**
The final cut (`gtmvp-engine-demo-eric-HD.mp4`) = the existing on-brand motion-graphic `engine-walkthrough-60s.mp4` (intro 0-18s + outro 45-60s) intercut with Steve's REAL screen-recordings — operator console (18-30s) + customer audit deliverable (30-45s). Real footage came from Steve's hi-res GIFs (`GTMVP Operator Dashboard Long.gif` / `GTMVP Live Audit Results Long.gif`, 1706x898, in `Downloads`) → converted to `real-operator-hd.mp4` / `real-audit-hd.mp4`. Audio spine = Eric ElevenLabs VO (`vo-eric.mp3`, voice id `cjVigY5qzO86Huf0OWal`) + an AI music bed (`music-bed.mp3`, generated via fal-ai `fal-ai/elevenlabs/music`). Assembled with ffmpeg (installed via `winget install Gyan.FFmpeg`; resolve its path under `%LOCALAPPDATA%\Microsoft\WinGet\Packages` if not on PATH). VO script + storyboard: `voiceover-script.md`.

Voice options also rendered: `vo-brian.mp3` (alt pro voice) and `vo-steve-clone.mp3` (Steve's ElevenLabs clone "Steve Kaplan AI", voice id `8EhD2aAPMDgcGs1PHHCQ`) if a clone-voiced version is ever wanted.

**To re-edit:** re-render the VO (ElevenLabs API, `$env:ELEVENLABS_API_KEY`), regenerate music (fal-ai), or re-cut the ffmpeg concat windows (split motion-graphic + trim/concat the real clips, then amix VO+music over it). The customer audit view is operator-login-gated (automated capture hits the sign-in wall) — Steve screen-records it himself. See [[gtmvp_repo_canonical_paths]].

**Optional polish not yet done** (offered, Steve hasn't requested): crossfades at the two mockup→real cuts, burned-in captions for muted autoplay, or flipping to autoplay-muted-loop.
