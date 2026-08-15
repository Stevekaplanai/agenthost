---
name: rules-source-of-truth
description: "Cardinal Rule 17 and the drift checker — which copy of Steve's rules is authoritative, and how to verify the others"
metadata: 
  node_type: memory
  type: project
  originSessionId: c31bd7e5-94e9-4451-ace0-45acbfbb0957
  modified: 2026-08-02T20:30:48.905Z
---

**Cardinal Rule 17 added 2026-08-02: one source of truth per document — sync FROM
it, never TO it.**

## The source of truth for the cardinal rules

```
C:\Users\User\.claude\CLAUDE.md
```

The DESKTOP file. Not the box's, not Hermes's, not AGENTS.md. As of 2026-08-02 it
holds rules **0-17** (eighteen).

## What caused the rule

Hermes synced the rules **from the box** (stale, 0-15) **into** the desktop
reference (current, 0-16), reported "now complete 0-15," and cached it
permanently. Rule 16 was silently deleted from an agent's working knowledge by an
operation whose purpose was to keep it current. Nothing errored, because nothing
was watching which direction was uphill.

## The drift checker

```
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\User\.claude\scripts\rules-drift.ps1
```

Flags: `-IncludeBox` also checks the Fly box over SSH; `-Quiet` prints only drift.
Exit 0 = clean, 1 = drift, 2 = source unreadable.

Reports three things per copy: rules MISSING, rules EXTRA (written downstream
instead of at the source), and rules whose TEXT diverged under the same number.

## Known downstream copies (2026-08-02)

| Copy | State when the checker first ran |
|---|---|
| `C:\Users\User\CLAUDE.md` | 15 rules — missing 15/16/17, text differs on 11/13/14 |
| `C:\Users\User\AGENTS.md` | 9 rules — missing 9-17 |
| Hermes `steve-context\references\global-claude.md` | 17 rules — missing 17 (16 was patched in by hand 2026-08-02) |

**A project's own `CLAUDE.md` is NOT a downstream copy** and must never be added
to the checker's list — `agenthost-internal\CLAUDE.md` contains zero cardinal
rules; it is project law that layers on top. Flagging it produced a false positive
on the first run, and a checker that cries wolf gets ignored.

## The refresh is NOT a blind overwrite — unfinished work

The copies are not pure duplicates. `C:\Users\User\CLAUDE.md` has its own header
and framing; overwriting it wholesale would destroy that. A correct refresh
replaces the **cardinal-rules section only**, leaving each file's surrounding
content intact. That was deliberately left undone on 2026-08-02 rather than done
half-right. Until it happens, three copies are stale and agents reading them are
operating on an older constitution.

Related: [[voice_readback_hook]], [[claude_config_hygiene_2026-08-02]]
