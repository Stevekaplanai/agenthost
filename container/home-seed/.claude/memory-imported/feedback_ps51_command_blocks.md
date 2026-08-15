---
name: ps51-command-blocks-need-failure-guards
description: "Handed-off PowerShell blocks — Windows PowerShell 5.1 has NO && and ; does not stop on failure; chain dependent steps with if ($?) { } or -ErrorAction Stop"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: c31bd7e5-94e9-4451-ace0-45acbfbb0957
  modified: 2026-07-31T23:19:52.272Z
---

# PowerShell 5.1 command blocks need failure guards

**Why (Steve, 2026-07-31, during the Rust/Tauri install):** Steve's shell is Windows
PowerShell 5.1. `&&` is a parser error there, and `;` runs the next command EVEN IF the
previous one failed — so a handed-off block like `cd X; git pull; claude "..."` launches
the session against a stale tree when the pull fails. Silent wrong-state execution, the
exact failure Cardinal Rule 12 exists to prevent.

**How to apply — every command block handed to Steve (Rule 12 companion):**
- Chain dependent native commands with `if ($?) { ... }`:
  `cd C:\path; if ($?) { git pull origin main }; if ($?) { claude "..." }`
- For cmdlets, `-ErrorAction Stop` promotes failures to terminating.
- `;` alone is ONLY for genuinely independent steps where a prior failure doesn't matter.

**2026-07-31 — the incomplete-application failure (do not repeat):** a handoff block
`Set-Location -Path X -ErrorAction Stop; git pull origin main; npm publish` was given for a
release. The `git pull` failed (unfinished merge), but `-ErrorAction Stop` binds ONLY to the
cmdlet it's on (`Set-Location`) — it does NOTHING for native exes like `git`/`npm`. The bare
`;` chained through the failed pull and `npm publish` ran against the un-updated tree.
Nothing shipped only because npm's own duplicate-version guard rejected it. **Rule: EVERY
native-command dependency gets its own `if ($?)` guard — `-ErrorAction Stop` on one cmdlet
does not protect the native commands after it.** Also: never put a `git pull` in a publish
handoff when the target working tree may be dirty/mid-merge; publish from a clean worktree
or fresh checkout instead, so there is nothing to pull.
- This applies to HANDED-OFF blocks; Claude's own PowerShell tool calls already follow the
  5.1 rules in the tool docs — the gap was forgetting them at the handoff boundary.

Related: [[link-gate-no-phantom-assets]] (same class: the gap between knowing a rule and
enforcing it at the boundary where it ships).
