---
name: gtmvp-claymation-video
description: "GTMVP 40s claymation ad — built 2026-06-02, full Higgsfield+ffmpeg pipeline, delivered for review (not yet published)."
metadata: 
  node_type: memory
  type: project
  originSessionId: c05a1dfa-ac3d-4c54-8b7b-02647bce635d
---

Built 2026-06-02. A 40-second 9:16 claymation brand ad for GTMVP. Story: Series A founder dumbfounded by CPA at 11pm, tries everything, visits gtmvp.com, free Smart Bidding Audit (60s) -> $129 Diagnostic (24h) -> 3-week Rebuild -> "Go to Market with GTMVP." Cold-grey-to-sodium-amber (#FF5B1F) color arc = the offer ladder resolving. Founder wears an amber lanyard cord (the "dormant ember" that becomes the GTMVP glow).

**Final + all assets:** `C:\Users\User\Downloads\gtmvp-claymation\`
- `gtmvp-claymation-9x16.mp4` — the deliverable (1080x1920, ~40s, 26MB).
- `beat1.mp4`..`beat7.mp4` — the 7 animated clips. `beat2.jpg`/`beat*.png` etc. — the 7 keyframe stills.
- `vo-1.mp3`..`vo-7.mp3` — Eric ElevenLabs VO. `build_video.py` — the whole assembler (concat -> caption PNG overlays -> VO timed to beats -> ducked music -> mux). Re-run it after swapping any clip/VO to rebuild.
- `contact-sheet.png` (7 keyframes), `qa-montage.png` (final frames).

**Pipeline (reusable):** Higgsfield `nano_banana_pro` stills (Beat 1 as the character reference anchor for beats 2-7) -> `seedance_2_0` i2v 1080p (54 credits/6s clip) -> ffmpeg via `imageio_ffmpeg`. Music bed reused from `Downloads\gtmvp-engine-video\music-bed.mp3`. VO = ElevenLabs "Eric" (`cjVigY5qzO86Huf0OWal`); Steve's cloned voice "Steve Kaplan AI" = `8EhD2aAPMDgcGs1PHHCQ` (swap option). ELEVENLABS_API_KEY lives at User-scope env (read via `[Environment]::GetEnvironmentVariable(...,'User')`, NOT inherited by the running process).

**Cost:** ~400 Higgsfield credits (7 video clips dominate). Workspace `6f737e37-35e7-4f78-b2be-990cd3cecf39` (the funded private one) must be SELECTED via `select_workspace` or generations hit an empty context and "run out of credits" falsely.

**Status:** PUBLISHED 2026-06-02 (Steve approved) to YouTube Shorts (https://www.youtube.com/watch?v=XRbiaIK67DY), Instagram Reel (https://www.instagram.com/reel/DZFn3A8CvwO/), TikTok (https://www.tiktok.com/@stevekaplanai/video/7646814061316918541) via Blotato. Posted public with AI-disclosure flags (isAiGenerated / containsSyntheticMedia = true). Platform-native captions per brand-voice (ASCII, proof-stacked). Not cross-posted to LinkedIn/Twitter (available if wanted). Built via the [[higgsfield-studio-gate]] skill+gate.
