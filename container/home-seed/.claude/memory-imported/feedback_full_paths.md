---
name: Always use full paths and platform names
description: When referencing files, URLs, or locations, always include complete paths and specify which platform/service they're on
type: feedback
originSessionId: c96f2e67-4999-4448-91f6-1c90aee53c3f
---
Always use complete file paths and full URLs when telling Steve where something is. Also specify which platform or service it's on.

**Why:** Steve works across multiple repos, services, and platforms. Abbreviated paths or missing platform context wastes his time figuring out where to go.

**How to apply:**
- Files: Use full path like `C:\Users\User\Projects\stevekaplanai-site\app\api\route.ts`
- URLs: Use full URL like `https://stevekaplan.ai/saaspocolypse/admin.html`
- Services: Say "in the Vercel dashboard" or "in Supabase SQL Editor" or "on GitHub at github.com/Stevekaplanai/repo"
- Never say just "the migration file" — say "the migration SQL file at `C:\Users\User\Projects\stevekaplanai-site\app\api\saaspocolypse-share\migration.sql` — run it in the Supabase SQL Editor at https://supabase.com/dashboard"
