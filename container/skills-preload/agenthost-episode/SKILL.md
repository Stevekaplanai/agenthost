---
name: agenthost-episode
description: Build and schedule one AgentHost build-in-public video episode end to end — script with receipts, Steve's cloned voice (one-take eleven_v3 + STT split), HeyGen avatar open, clip-library assembly in 4 formats, Postiz scheduling with the link gate. The pipeline proven on Episodes 2-3 (2026-07-30/31).
---

# /agenthost-episode — one episode, script to scheduled

The deep reference is `C:\Users\User\Projects\agenthost-launch\02-videos\HANDOFF-VIDEO-2026-07-30.md`
(pipeline, keys, channel IDs, slot rules). This skill is the operating order. The clip
library is REUSED, never regenerated (`02-videos\clip-library\`, rules in the vault SPEC).

## 0. Gates before anything

- **The receipt test:** what actually happened, and can it be proved? No receipt, no episode.
- **Copy matches code.** No em dashes anywhere. "Receipts, not wins" governs every line.
- Check the story spine + what's queued: `C:\Users\User\Projects\ai-money-minute\AGENTHOST-DISTRIBUTION-LOOP.md`.
- Script format: 7 beats, ~35-40s. Table of VO (numbers spelled out) / subtitle (numerals) /
  library clip. The emotional turn lands on B7 or B4 with a held pause BEFORE it. One close:
  imperative or question, never both. Facts section with per-claim verification, hard gates
  listed if any claim is future-dated. **Steve reviews and locks the script before generation.**

## 1. Voice — ONE continuous take (the "10 takes" fix)

- ElevenLabs "Steve's Real Voice" `M7o1flfM6xFSyVQukmUp`, key `C:\Users\User\.agenthost\elevenlabs.key`.
- Whole script in ONE `eleven_v3` call, `stability: 0.5`, audio tags sparse (2-3 max,
  only on lines that earn them: `[sighs]`, `[quietly]`, `[chuckles]`).
- Split AFTER generation: pro-clone room tone means silence detection fails — transcribe
  with `scribe_v1` (word timestamps) and cut at beat-final words, matched IN ORDER
  (occurrence-based) so repeated words can't misalign. Segments = windows into one take.
- Fallback if the split misbehaves: per-line `eleven_multilingual_v2` (Episode 2's path).

## 2. Avatar open — lipsynced to the same voice

- Upload the line-1 segment: `POST upload.heygen.com/v1/asset` (key `.agenthost\heygen.key`).
- Generate avatar `f1c8272fd01a4936bb824fd1112e316d` with `voice:{type:"audio",audio_asset_id}`,
  background `#0B0D10`, NATIVE dimensions per format (720x1280 / 1280x720 / 1080x1080 /
  1080x1350) — never crop a talking head. Poll `v1/video_status.get`.
  (HeyGen v2 endpoints sunset 2026-10-31 — migrate to v3 before then.)

## 3. Assembly — all four formats

- Engine: `02-videos\posts\ep2-launch-day\build_post_v2_heygen.py`; per-episode driver
  pattern: `posts\ep3-wrong-thing\build_ep3.py` (override BEATS, skip edge-trim on one-take
  segments, GAP 0.10 / BEAT_PAUSE 0.45). Single-format audition: `build_one_format.py`.
- Clips STRETCH to fit, never loop (B5 must never visibly reset). Subtitles lower third.
- Verify with a contact sheet (ffmpeg tile) before sending; Steve's ear is the final gate —
  deliver the 9x16 via SendUserFile and wait for his pass.
- Archive into `posts\<ep-slug>\`: masters, VO segments + full take, timeline.json.

## 4. Schedule — Postiz, with the gates

- Slot: **5:30pm ET** (episodes). 9am ET belongs to the text narrative — never collide.
  Check the queue first (idempotency: same channel+time+first-80-chars = skip).
- Channels: X `cm43474d6000d61zsf26olh3v` (needs `who_can_reply_post`), LinkedIn personal
  `cm433m5e5000361zszjorqczr`, TikTok `cm434h1s8000f61zs078fl1ws` (full settings,
  `autoAddMusic:"yes"` — platform music IS the music strategy; MusicGen is CC-BY-NC, banned),
  YouTube `cm434hpj9000h61zsh2100b2y` (needs `title`+`type`). IG accounts + GTMVP page excluded.
- Different cut per channel, never the same text twice. Upload per-format media first.
- **THE LINK GATE:** any referenced asset must have its resolving URL in the post at
  schedule time (curl 200). No asset, no reference. After scheduling, re-pull the queue and
  grep scheduled posts for reference-patterns without https — zero real flags or not done.
- **Verify by state:** re-list the queue and confirm the posts exist. Never trust the POST response.

## 5. Afterwards

Log the beat (date, surfaces, credits, gaps) to `07_Claude_Brain\agenthost-distribution-log.md`.
Update the episode row in `HANDOFF-VIDEO-2026-07-30.md`.
