---
name: steve-timezone-est
description: "Steve is in EST/EDT (America/New_York) — how to compute his local time correctly, and why the shell gets it wrong"
metadata: 
  node_type: memory
  type: user
  originSessionId: c31bd7e5-94e9-4451-ace0-45acbfbb0957
  modified: 2026-08-03T02:27:45.396Z
---

**Steve is in Eastern Time (America/New_York), always.** Lake Worth FL. All his
app settings are set to EST. He has said this three times; the third time
(2026-08-02, ~10:17pm his time) was "mark it in your records."

## How to get his time RIGHT

- **UTC minus 4 during daylight time (roughly Mar-Nov), UTC minus 5 in winter.**
  Do the arithmetic from a UTC timestamp; do not trust the shell.
- **The Git Bash sandbox on his machine has NO timezone database.**
  `TZ="America/New_York" date` silently returns GMT — it does not error, it just
  ignores the TZ. Verified 2026-08-03 02:27 UTC. A silent wrong answer, Rule 16
  shaped. Use PowerShell if a tool must convert:
  `[TimeZoneInfo]::ConvertTimeBySystemTimeZoneId((Get-Date).ToUniversalTime(),'Eastern Standard Time')`
  — or just subtract 4 by hand.
- Git commit dates with `--date=format-local:` DO work in repos (git carries its
  own tz handling) — that path was verified correct on 2026-08-02.

## Why this matters beyond politeness

- On 2026-08-02 I told him twice it was "nearly sunrise" / "4am" when it was
  ~10pm. Wrong time = wrong advice ("go to sleep") and wrong urgency framing.
- **Timestamps are evidence he explicitly asked me to use** ("Check time stamps
  for clues. You never do that."). Using them requires converting them
  correctly. Deploy logs, Vercel builds, commit times: all UTC unless stated.
- He works late; a late clock reading is not a signal to wind the session down.
  Never infer his schedule from my own broken clock.

Related: [[legal_name_and_location]] (Lake Worth FL), Cardinal Rule 16 (a tool
that silently returns the wrong answer is worse than one that errors).
