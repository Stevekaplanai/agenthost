---
name: Postiz direct API pipeline
description: Postiz public REST API recipe for posting threads and video content across Steve's social accounts. Use when Blotato is broken or when posting through Postiz is explicitly requested. Includes auth, endpoints, integration IDs, and the exact JSON schema for threaded X posts with video.
type: reference
---

# Postiz Direct API — Working Pipeline (verified 2026-04-11)

**Use this when Blotato is broken.** First confirmed end-to-end ship: 3-post Artemis congrats thread with AI-generated video card → https://twitter.com/HiSteveKaplan/status/2042819389880447114

## Auth

- Token lives in `C:\Users\User\.claude.json` under `mcpServers.postiz.url` (the URL path suffix IS the token).
- Current token: `a620e7070e3ef223436e25a1329bf880527ada8a688d59399e5023f58cf46979`
- Header format: `Authorization: <token>` — **no `Bearer` prefix**.
- Same token is used by the Postiz MCP server AND the public REST API.

## Base URL

`https://api.postiz.com/public/v1`

## Integrations (active accounts, fetched 2026-04-11)

| Platform | Integration ID | Name | Profile | Status |
|---|---|---|---|---|
| X (Twitter) | `cm43474d6000d61zsf26olh3v` | Steve Kaplan AI | @HiSteveKaplan | ACTIVE — primary for AI Money Minute |
| TikTok | `cm434h1s8000f61zs078fl1ws` | Steve Kaplan | stevekaplanai | ACTIVE |
| YouTube | `cm434hpj9000h61zsh2100b2y` | Stephen Kaplan | — | ACTIVE |
| Facebook | `cm5xxdpwy001uzihyolcbn06h` | Steve Kaplan AI | — | ACTIVE — AI Money Minute page |
| Facebook | `cm43455id000961zs2pz49fiu` | gtmvp.com | — | ACTIVE |
| Facebook | `cma6oihil004img0fvjn0ydu3` | Studentaidetector | — | ACTIVE |
| Instagram | `cm4346knt000b61zsj44klzlo` | GTMVP Inc | @gtmvpinc | ACTIVE |
| Instagram-standalone | `cmc2s8xhe007co00ywn5nmfly` | Student AI Detector | @studentaidetector | ACTIVE |
| LinkedIn-page | `cm433mlfn000561zshys2p1f2` | GTMVP Inc. | @gtmvp | ACTIVE |

**Disabled in Postiz** (heads up — old `ai_money_minute.md` memory references some of these):
- LinkedIn personal `cm433m5e5000361zszjorqczr` Steve Kaplan @stevekaplanai → disabled
- Instagram-standalone `cm7uqdiet005x32h55a8lfyda` Steve Kaplan @docdoctorai → disabled
- Facebook `cm5xxfzey001wzihytuy921zp` DocDoctor AI → disabled

**Gotcha:** AI Money Minute's old Blotato flow used Instagram @stevekaplanai and personal LinkedIn. Neither is connected in Postiz. If going full Postiz, the AI Money Minute IG account is `@gtmvpinc` and LinkedIn is the `gtmvp` company page only.

## Endpoint: POST /public/v1/upload (media)

Multipart upload. **CRITICAL:** always specify MIME type and filename explicitly or Postiz strips the extension and saves as `.bin`, which X/IG/etc. will fail to ingest.

```bash
curl -X POST "https://api.postiz.com/public/v1/upload" \
  -H "Authorization: $POSTIZ_TOKEN" \
  -F "file=@video.mp4;type=video/mp4;filename=video.mp4"
```

Response:
```json
{
  "id": "e122055b-a4c4-4ee1-bff7-149d86b6c5ab",
  "name": "kyuVJV3bfi.mp4",
  "path": "https://uploads.postiz.com/kyuVJV3bfi.mp4",
  "thumbnail": null,
  "alt": null
}
```

Use both `id` and `path` when referencing the media in a post.

## Endpoint: POST /public/v1/posts (create/publish)

Required fields: `type`, `date`, `shortLink`, `tags`, `posts[]`.

- `type`: `"now"` (publish immediately) or `"schedule"` (use `date` in future)
- `date`: ISO 8601 UTC string — required even for `"now"` posts
- Each post needs `integration.id`, `value[]`, and `settings.__type` matching the platform

### Platform-specific settings requirements (learned the hard way)

**X (Twitter)** — requires `who_can_reply_post` (validation error if missing):
```json
"settings": {
  "__type": "x",
  "who_can_reply_post": "everyone",
  "active_thread_finisher": false
}
```
Allowed values for `who_can_reply_post`: `everyone`, `following`, `mentionedUsers`, `subscribers`, `verified`.

Other platforms likely have their own required settings — discover via 400 error messages (Postiz returns explicit validation errors listing missing fields).

### Threads

For X, Bluesky, Threads, LinkedIn: put multiple items in `value[]`. Each item is one post in the thread. Each item can have its own `image[]` array.

### Full working example (3-post X thread with video on post 1)

```json
{
  "type": "now",
  "date": "2026-04-11T04:25:00.000Z",
  "shortLink": false,
  "tags": [],
  "posts": [
    {
      "integration": { "id": "cm43474d6000d61zsf26olh3v" },
      "value": [
        {
          "content": "Post 1 text with hook 🧵",
          "image": [
            {
              "id": "e122055b-a4c4-4ee1-bff7-149d86b6c5ab",
              "path": "https://uploads.postiz.com/kyuVJV3bfi.mp4"
            }
          ]
        },
        { "content": "Post 2 text", "image": [] },
        { "content": "Post 3 text with CTA\n\n#Hashtags", "image": [] }
      ],
      "settings": {
        "__type": "x",
        "who_can_reply_post": "everyone",
        "active_thread_finisher": false
      }
    }
  ]
}
```

Success response:
```json
[{"postId":"cmnttqg7w00opqz0y4zv5wopc","integration":"cm43474d6000d61zsf26olh3v"}]
```

## Endpoint: GET /public/v1/posts (verify / list)

**Required** query params: `startDate`, `endDate` (ISO 8601), `display` (`day`|`week`|`month`).

```bash
curl "https://api.postiz.com/public/v1/posts?startDate=2026-04-11T00:00:00Z&endDate=2026-04-12T00:00:00Z&display=day" \
  -H "Authorization: $POSTIZ_TOKEN"
```

Returned post object includes:
- `state`: `QUEUE` | `PUBLISHED` | `ERROR` (states I've observed)
- `releaseURL`: the live platform URL (once published)
- `releaseId`: the platform's native post ID

Published posts show up within ~5-10 seconds of a `type: "now"` call.

## Video generation recipe (when you need a quick content video)

When Blotato visual is broken, fall back to local ffmpeg + PIL:

1. Generate a 1080×1920 PNG title card with PIL (fonts: `C:/Windows/Fonts/arialbd.ttf`).
2. Convert to MP4 with a subtle zoompan for motion:
```
ffmpeg -y -loop 1 -i card.png -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 \
  -c:v libx264 -t 6 -pix_fmt yuv420p \
  -vf "scale=1080:1920,zoompan=z='min(zoom+0.0008,1.1)':d=150:s=1080x1920:fps=25" \
  -c:a aac -shortest -movflags +faststart out.mp4
```
ffmpeg binary path: `python -c "import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())"`

6-sec output is typically <1 MB — well under any platform limit.

## Brand colors (keep consistent with AI Money Minute)

- Background: `#0A0A0A`
- Blue accent: `#2196F3`
- Gold: `#D4A745`
- White: `#FFFFFF`
- Muted gray: `#9CA3AF`

## Working directory for temp assets

`C:\Users\User\Projects\ai-money-minute\tmp\` — safe to treat as scratch space for cards/videos/JSON payloads.
