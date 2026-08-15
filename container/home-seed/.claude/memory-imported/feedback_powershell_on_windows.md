---
name: Use PowerShell tool, not Bash, for Windows-native CLIs
description: On Windows, route native CLI work through the PowerShell tool — Bash→powershell sandboxes DNS and PATH and silently breaks native binaries
type: feedback
originSessionId: 14e8009d-5e07-4862-b669-4a2fa6208660
---
On Windows machines, default to the **PowerShell tool** (not Bash invoking `powershell -NoProfile -Command "..."`) whenever the work touches native binaries: scoop, stripe, supabase, neonctl, gh, vercel, railway, npm-shimmed CLIs.

**Why:** During the 2026-04-25 Synap CLI bootstrap session, `Bash → powershell -NoProfile -Command "stripe login --complete <url>"` failed with `dial tcp: lookup dashboard.stripe.com: no such host`. Same command via the native PowerShell tool resolved DNS and completed cleanly. The Bash route was sandboxing both DNS and PATH for native binaries — symptoms looked like CLI bugs but were really my tool choice. User explicitly called this out: *"Can't I give you access to powershell?"*

**How to apply:**
- Windows + native CLI install/login/version probe → use `PowerShell` tool
- Windows + filesystem ops, simple scripts, git, Node — Bash is fine
- Each `PowerShell` tool call is a fresh process; PATH from a prior call does NOT persist. Either refresh PATH at the start of each call (`$env:Path = [Environment]::GetEnvironmentVariable('Path','User') + ';' + [Environment]::GetEnvironmentVariable('Path','Machine')`) or use full paths to shims (e.g. `& "$env:USERPROFILE\scoop\shims\stripe.exe"`).
- Never use `&&` chaining — Windows PowerShell 5.1 doesn't support it. Use `;` or `if ($?) { ... }`.
