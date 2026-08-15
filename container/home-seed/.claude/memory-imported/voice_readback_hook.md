---
name: voice-readback-hook
description: "ElevenLabs TTS Stop hook that speaks Claude's replies aloud — RE-ENABLED 2026-08-02 per Steve; readback voice pinned in the hook, never via the global env var"
metadata: 
  node_type: memory
  type: project
  originSessionId: c31bd7e5-94e9-4451-ace0-45acbfbb0957
  modified: 2026-08-02T18:04:52.366Z
---

**RE-ENABLED 2026-08-02** at Steve's explicit request ("I had you build an alarm...
can you turn that on?"). Supersedes the 2026-06-04 "disabled, do not re-enable"
state. Steve after hearing it: *"I like it. A lot. The whole thing is elegant and
easy to use."*

## Current wiring

- **Script:** `C:\Users\User\.claude\hooks\speak-output.ps1` — reads the last
  assistant TEXT turn from the transcript, strips code blocks / tables / URLs /
  file paths / markdown, sends to ElevenLabs `eleven_turbo_v2_5`, plays via
  `System.Windows.Media.MediaPlayer` at 1.2x. Speaks only cleaned text ≥80 chars,
  capped at 1200.
- **Registration:** a `Stop` hook in `C:\Users\User\.claude\settings.json`,
  timeout 120, synchronous. Pre-change backup: `settings.json.bak-2026-08-02-prevoice`.
- **Toggle:** `/voice` → `~/.claude/hooks/voice-toggle.ps1`, state files in
  `~/.claude/voice-state/` (`<sid>.off`, `all.off`, `solo`). Takes effect LIVE, no
  restart, because the script re-reads state on every Stop event. Default with no
  state files = ON.

## ⚠️ DO NOT change the `ELEVENLABS_VOICE_ID` user environment variable

It is set to `M7o1flfM6xFSyVQukmUp` = **"Steve's Real Voice"** (his clone), set
deliberately on 2026-06-02 so the **AgentHost episode video pipeline narrates in
his voice**. Changing it globally would silently swap the narrator on his videos.

The readback voice is pinned **inside the hook command string itself** —
`$env:ELEVENLABS_VOICE_ID='zZp9y0VzL7J3DmI1Z0U6'` ("Hrp - informational") — so the
two uses stay independent. Steve on hearing his own clone read a reply back to
him: *"don't use my voice that is freaking me out."*

**To change the readback voice:** edit the pinned id in the Stop hook. Never the
env var. Other voices on the account: Sarah `EXAVITQu4vr4xnSDxMaL` (warmer), River
`SAz9YHcvj6GT2YYXdXww` (neutral), Daniel `onwK4e9ZLuTAKqWW03F9` (broadcaster).

## Why it was silent for months (the real root cause)

Everything existed and worked — script, API key, `/voice` toggle — **except the
Stop-hook registration.** `/voice` cheerfully reported `ON` while nothing on the
machine could possibly speak. A control that grants nothing; the same failure
shape as Cardinal Rule 16 and Rule 11 (finished code with no reachable trigger).
Diagnosis took one check: parse `settings.json` and look for `speak-output`.

## If it goes silent again, check in this order

1. Is `speak-output.ps1` still present in `settings.json` → `hooks.Stop`? (This is
   the one that actually bit.)
2. `ELEVENLABS_API_KEY` set as a **User env var** AND inherited by the running
   Claude process — env is frozen at process start, so a newly-set var needs a
   Claude restart. The script is a **silent no-op (exit 0)** without it.
3. ElevenLabs quota not exhausted.
4. Dry run: set `CC_SPEAK_DRYRUN=1` and pipe
   `{"session_id":"<sid>","transcript_path":"<session .jsonl>"}` to the script — it
   prints the cleaned text and skips the API, proving extraction works.
5. Audio device available to the hook process.

## Accepted tradeoff

Synchronous playback pauses each turn ~8-10s while the clip plays. Steve was told
explicitly and accepted it; he can ask for background playback if it starts to
annoy him. Measured: 7.7-10.3s on normal-length replies.

## Knobs

`CC_SPEAK_SPEED` (per-session, clamped 0.5-3.0, default 1.2). Hardened 2026-05-31:
TLS 1.2 forced for PS 5.1; transcript read as UTF-8; Unicode dashes/smart-quotes/
ellipsis normalised via `[char]` code points so the source stays pure ASCII.
Honors [[feedback_no_em_dashes]].

Works in all Claude Code surfaces (terminal, desktop app, IDE extensions) since
they share the hooks engine. Does NOT work in the separate Claude Desktop chat
app, which has no hooks.

Related: [[feedback_concise_responses]] — the readback speaks **prose only**, so
the actual point must live in sentences, never only in a table or code block.
