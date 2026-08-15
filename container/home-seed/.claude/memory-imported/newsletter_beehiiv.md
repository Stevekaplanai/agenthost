---
name: Beehiiv newsletter format for AI Money Minute
description: How Steve Kaplan wants AI Money Minute newsletter drafts delivered into Beehiiv — HTML template with filled placeholders, pasted into Beehiiv code/HTML view
type: project
originSessionId: d5fa5843-6dcf-438a-9e1c-d1b975d482dc
---
# Beehiiv Newsletter Delivery — AI Money Minute

Newsletter lives at: `https://aimoneyminute.net`
MCP does NOT have write access to Beehiiv — drafts are delivered to Steve for manual paste.

## Delivery format: FILLED HTML

**Always deliver the newsletter as a complete, filled HTML file** using the Superhuman-inspired template at `C:\Users\User\Projects\ai-money-minute\templates\newsletter.html`. Steve pastes the HTML into Beehiiv's code/HTML view for full styling control.

**Why:** Steve explicitly corrected the plain-text approach on Apr 22, 2026. The HTML template was designed Apr 16, 2026 specifically for Beehiiv's HTML paste mode. Plain text does not render the branded design.

**How to apply:**
1. Read the HTML template from `templates/newsletter.html`
2. Replace all `{{PLACEHOLDER}}` variables with today's content
3. Save the filled HTML to `C:/Users/User/Projects/ai-money-minute/tmp/beehiiv_<YYYY-MM-DD>_<topic>.html`
4. Deliver via Slack DM `D086REL5C11` with: HEADING (plain text), TITLE (plain text), and the file path to the HTML body
5. Steve opens the HTML file and pastes into Beehiiv code view

## Three metadata fields (still needed alongside HTML)

Steve still needs these three fields for Beehiiv's composer header:
1. **HEADING** — short subtitle / pre-title line (plain text, e.g., "Sector Deep Dive — April 22, 2026")
2. **TITLE** — the main post title (plain text, one compelling line)
3. **BODY** — the filled HTML file (file path, NOT inline in Slack)

## CRITICAL: Dollar-sign sanitizer workaround (Slack messages only)

**`$` followed by digits gets stripped in the Slack tool output pipeline.** This affects Slack DM delivery only — NOT the saved HTML file.

Workaround for Slack messages: spell out all dollar amounts in prose. The HTML file itself CAN use `$` signs safely since it's read from disk, not piped through the Slack tool.

## Hero image

Every newsletter needs a hero image. **Use fal.ai Nano Banana (`fal-ai/nano-banana`) for ALL image generation** — Steve's explicit preference as of Apr 12, 2026. Nano Banana renders text in images perfectly (unlike Flux Schnell which garbles it). Ideogram v3 is decent but Nano Banana is the default.

API key: `FAL_KEY` env var in `~/.bashrc`. Model: `fal-ai/nano-banana`. Use `image_size: 'landscape_16_9'` for newsletter heroes.

Prompt style that works well: describe the layout explicitly (title text, subtitle, numbered items with icons, bottom bar with tagline). Specify dark navy + gold color palette for the AI Money Minute brand. Always include "Because money never sleeps. | aimoneyminute.net" in the bottom bar. **Use the newsletter link (aimoneyminute.net) NOT stevekaplan.ai** — Steve's explicit preference as of Apr 12, 2026.

Fallback: Blotato `blotato_create_visual` infographic templates (free but less control over text rendering).

## HTML Template (Superhuman-inspired, Apr 16 2026)

Steve requested the newsletter be redesigned in the style of Superhuman AI's newsletter (Zain Kahn's beehiiv-based newsletter). Template built as full HTML email at `C:\Users\User\Projects\ai-money-minute\templates\newsletter.html`.

**Template sections:** Header (logo text + date) → Gold accent bar → Hero headline/subtitle/read time → Hero image → TODAY'S BRIEFING (TOC with gold arrows) → THE MONEY (3 numbered news items with blue badges) → DEEP DIVE (expanded story + "WHY IT MATTERS" gold callout) → THE DARK SIDE (red label, contrarian story) → TOOL OF THE DAY (dark card) → Engagement poll (3 emoji buttons) → Sign-off ("— Steve Kaplan AI" + "AI Money Minute — Because money never sleeps." in gold italic) → Footer (social links + aimoneyminute.net + unsubscribe).

**Key design decision:** Tagline is "AI Money Minute — Because money never sleeps." NOT "stevekaplan.ai — Because money never sleeps." Steve explicitly rejected the latter.

**Delivery method:** Paste HTML into Beehiiv's code/HTML view for full styling control. All content uses `{{PLACEHOLDER}}` variables that get filled per issue.

**Brand colors in template:** #0A0A0A (dark bg), #0F0F0F (container bg), #2196F3 (blue accent/links/number badges), #D4A745 (gold headers/dividers/callout borders), #FF4444 (Dark Side section label), #FFFFFF (headlines), #E0E0E0 (body text).

## Source of truth for workflow

See `ai_money_minute.md` for the full daily video-first workflow. The newsletter is a downstream deliverable that reuses the same day's deep-dive research — draft the newsletter AFTER the video is approved and the 6-platform cascade is scheduled.
