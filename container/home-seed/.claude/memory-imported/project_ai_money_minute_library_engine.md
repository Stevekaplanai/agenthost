---
name: project-ai-money-minute-library-engine
description: "AI Money Minute rebuilt 2026-07-09 on Higgsfield LIBRARY MODE + Postiz — 29-clip branded library, ~5 cr/day, daily scheduled task ai-money-minute-daily at 8am ET"
metadata: 
  node_type: memory
  type: project
  originSessionId: 09714e4a-634b-4250-ab55-59b978aa0c5d
---

AI Money Minute was rebuilt 2026-07-09 (Blotato retired, newsletter dropped). Architecture: **library mode** — 29 pre-generated branded 10s clips (charcoal #0A0A0A / electric blue #2196F3 / gold #D4A745, flat 2D vector, no text) reused daily; only narration (seed_audio preset Sterling `dc382508-c8bd-443c-8cb2-46e57b8d2e6f`), burned subtitles (anton), and assembly are fresh. Daily cost ~5 Higgsfield credits; monthly refresh (6 oldest clips, 1st run of month) ~102. Fits inside the Plus plan's 1,000 credits/mo grant (deposits on the 2nd) — $0 beyond the ~$44 subscription Steve already pays.

- Runbook (single source of truth): `C:\Users\User\Projects\ai-money-minute\DAILY-LOOP.md`
- Clip manifest: `C:\Users\User\Projects\ai-money-minute\state\clip-library.json` (tags: hook/numbers/funding/infra/dark/ipo/ahead/cta; media_id = the assembler input, filled on first use)
- Scheduled task: `ai-money-minute-daily`, cron 0 8 * * * ET (fires ~8:01 AM)
- Postiz channels: YouTube `cm434hpj9000h61zsh2100b2y`, X `cm43474d6000d61zsf26olh3v`, TikTok `cm434h1s8000f61zs078fl1ws`. LinkedIn banned by rule; IG/FB not connected for this brand.
- First library-mode episode (Dark Side Thursday 2026-07-09) shipped end-to-end: video + Slack draft + 3 queued posts.

**Hard-won API facts (already baked into the doc):** `explainer_video` items take `{video:{id:<media_id>},audio:{id:<media_id>}}` — media ids from `media_import_url`, NOT generation job ids (job ids 404). kling3_0_turbo needs explicit `aspect_ratio:"9:16"` (doesn't inherit the still's framing). X posts need `--settings '{"who_can_reply_post":"everyone"}'` and ≤270 raw chars each. TikTok settings require `privacy_level`/`comment`/`autoAddMusic` and support `video_made_with_ai:true`.

Related: [[feedback-video-projects-build-through]]
