---
name: ALWAYS USE FULL URLS AND FILE PATHS — TOP-PRIORITY RULE
description: NEVER use shorthand, partial URLs, relative paths, or bare site routes. Every URL must be fully qualified and clickable. Steve has reaffirmed this multiple times.
type: feedback
originSessionId: 8aeb469c-7c94-4c34-9852-ef808ac41538
---
**THIS IS A TOP-PRIORITY OPERATING RULE.** Steve has reaffirmed it three times across sessions, including: "It's a cardinal rule now. Please obey it." (2026-05-09a) and "I keep telling you to send me complete URL's... It's a top rule in your memory" (2026-05-09b).

Always use full URLs and absolute paths when referencing any location:

| Bad (shorthand / partial / relative)         | Good (full)                                                           |
|-----------------------------------------------|------------------------------------------------------------------------|
| `/stack-auditor`                              | `https://www.gtmvp.com/stack-auditor`                                  |
| `/audits/[id]/view/findings/keywords`         | `https://www.gtmvp.com/audits/c2cedf41-.../view/findings/keywords`    |
| `/api/admin/env-check`                        | `https://www.gtmvp.com/api/admin/env-check`                            |
| `/api/admin/audits/[id]/apollo-debug`         | `https://www.gtmvp.com/api/admin/audits/c2cedf41-.../apollo-debug`    |
| `owner/repo`                                  | `https://github.com/Stevekaplanai/repo-name`                           |
| `README.md`                                   | `C:\Users\User\Projects\saaspocolypse-boilerplate\README.md`           |

**Why:** Steve wants clickable, unambiguous, no-edit-required references. Shorthand or partial paths are harder to act on. He often reads the message on a different device or in a different window from where the work is happening, so he needs to copy a full URL and click it without piecing it together.

**How to apply:**

1. **Every URL in every response must be fully qualified.** Domain + protocol + full path. No exceptions.
2. **When the audit ID, repo name, file path, or other variable parameter is known from the conversation, substitute it in.** Never leave `[id]` or `<placeholder>` or `<your-audit-id>` for Steve to fill in — substitute the actual value if you know it.
3. **Even when the URL just appeared in tool output or earlier in the same response, repeat it in full** when you reference it again. Don't say "the env-check endpoint" — say `https://www.gtmvp.com/api/admin/env-check`.
4. **Internal routes still need the domain prefix.** `/audits/...` is NOT acceptable. Always `https://www.gtmvp.com/audits/...`.
5. **Test before sending: would Steve be able to Ctrl+click each URL and have it open?** If any URL requires editing, rewrite.
