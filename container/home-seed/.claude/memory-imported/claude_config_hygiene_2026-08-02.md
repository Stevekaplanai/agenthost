---
name: claude-config-hygiene-2026-08-02
description: "Dead agpatch hooks removed and 59 irrelevant agents archived — what was cut, why, and how to restore"
metadata: 
  node_type: memory
  type: project
  originSessionId: c31bd7e5-94e9-4451-ace0-45acbfbb0957
  modified: 2026-08-02T18:55:54.832Z
---

Two config cleanups on 2026-08-02, both reversible.

## 1. Dead `agpatch` hooks — REMOVED (9 of them)

`settings.json` registered `py "C:\Users\User\AppData\Local\Temp\agpatch\tree\hooks\send_event.py"`
on nine events including `PreToolUse` (matcher `*`, so **once per tool call**) and
`UserPromptSubmit`, where it **blocked Steve's prompts** with
`can't open file ... [Errno 2] No such file or directory`.

Root cause: the path is under **Temp**, which Windows clears. There is no durable
agpatch install anywhere on the machine. Someone had dropped a 28-byte stub
(`import sys; sys.exit(0)`) in to stop the blocking — a band-aid over a dead tool
that would break again on the next Temp clear.

- Removed entries saved to `C:\Users\User\.claude\agpatch-hooks-removed-2026-08-02.json`
- Pre-change backup: `C:\Users\User\.claude\settings.json.bak-2026-08-02-agpatch`
- Five hook events became empty and were deleted: UserPromptSubmit, PostToolUse,
  SubagentStop, PreCompact, SessionEnd.

**Rule going forward: never register a hook whose command lives under Temp.**
If agpatch is ever reinstalled, point hooks at a durable install path.

Side benefit: that PreToolUse hook was spawning a Python process on every single
tool call. Relevant to Steve's recurring "my PC is slow" complaint — see
[[sweep_stale_mcp]] territory.

## 2. Agent descriptions over the 15k limit — 59 agents ARCHIVED

The harness warned at ~16.9k tokens of agent descriptions and advised trimming
`.claude/agents/`. **Trimming descriptions was the wrong fix** — the real problem
was 229 agent files, nearly all third-party bulk packs Steve will never invoke.

Measured: Steve's agents 229 files / ~11,945 tok; active plugin agents ~3-5k.

Archived (moved, NOT deleted) to `C:\Users\User\.claude\agents-archive\`:
- whole folders: `game-development/` (unreal, unity, godot, roblox, blender),
  `spatial-computing/`, `academic/`
- Chinese/Asian market marketing: baidu-seo, bilibili, douyin, kuaishou, weibo,
  xiaohongshu, zhihu, wechat-official-account, china-ecommerce,
  china-market-localization, cross-border-ecommerce, livestream-commerce-coach,
  private-domain-operator
- irrelevant specialists: study-abroad-advisor, government-digital-presales,
  healthcare-marketing-compliance, korean-business-navigator,
  french-consulting-market, civil-engineer, recruitment-specialist,
  supply-chain-strategist, corporate-training-designer,
  cultural-intelligence-strategist
- irrelevant engineering: feishu-integration, wechat-mini-program, solidity,
  embedded-firmware, filament-optimization

Result: 170 files / ~8,926 tok. Saved ~3,019. Estimated grand total ~13.8k
against the 15k limit.

**Restore anything with:** move it back from `agents-archive` into `agents`,
same relative path.

**If the warning returns**, cut deeper rather than shortening descriptions — the
next candidates are the remaining `specialized/` and `engineering/` agents Steve
has never used. Fewer, better-differentiated agents also improve routing.

Token math here is approximate (characters ÷ 4). The authoritative check is
whether the harness warning appears on the next session start.
