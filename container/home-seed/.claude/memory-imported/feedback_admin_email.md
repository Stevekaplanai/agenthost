---
name: Use steve@stevekaplan.ai for admin/login addresses
description: Default admin/login email for Steve is steve@stevekaplan.ai, NOT the outlook.com address pulled from Claude session context
type: feedback
originSessionId: f66c7dbc-5164-4165-a397-3c899bd5aa67
---
When provisioning auth, magic links, admin allowlists, Cloudflare Access policies, Vercel team invites, or any login surface for Steve, always use `steve@stevekaplan.ai`.

**Why:** The `stevekaplan@outlook.com` address surfaces in Claude's session context (from his Claude.ai login) but Steve never told Claude to use it. It's not his working address. Using it without confirmation broke trust.

**How to apply:**
1. Default to `steve@stevekaplan.ai` for any new auth setup, allowlist, or admin email.
2. Never auto-pull the email from `userEmail` system context for outbound configuration without explicit confirmation.
3. If the working address is unclear for a specific platform, ask before configuring.
