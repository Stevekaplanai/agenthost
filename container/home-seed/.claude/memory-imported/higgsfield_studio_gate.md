---
name: higgsfield-studio-gate
description: "Higgsfield builds are gated behind the higgsfield-studio skill — the gate is intentional, not a bug; don't remove it."
metadata: 
  node_type: memory
  type: project
  originSessionId: c05a1dfa-ac3d-4c54-8b7b-02647bce635d
---

Built 2026-06-02 (replaced the rejected Higgsfield `/sync-agents` data-export flow, which Steve killed because it would have exfiltrated his confidential memory to a 3rd party).

**Two pieces, both global (`~/.claude`):**
1. **Skill** `~/.claude/skills/higgsfield-studio/SKILL.md` — reference for Higgsfield media generation: real model IDs (image: nano_banana_pro, soul_2, ms_image/DTC Ads, etc.; video: seedance_2_0, kling3_0, veo3_1, marketing_studio_video, higgsfield_preset), prompt structure, `get_cost` preflight, viral presets, and the run-`virality_predictor`-before-publish workflow. Grounded in live `models_explore`/`presets_show` data, not invented.
2. **Hook** `~/.claude/hooks/higgsfield-studio-gate.py` — two PreToolUse entries in `settings.json`: one matches `mcp__higgsfield__generate_image|mcp__higgsfield__generate_video`, one matches `Skill`. First Higgsfield generation each session is **denied** until the `higgsfield-studio` skill is invoked (sets a per-session flag in tempdir); afterward all builds pass. Fails open on any script error.

**Behavior to expect:** the first `generate_image`/`generate_video` in a fresh session returns a deny with "run the higgsfield-studio skill before generating." That is the gate working as designed — invoke `/higgsfield-studio`, then retry. Do NOT treat it as a broken tool.

Verified live 2026-06-02: gate blocked a real call, skill consult cleared it, retry passed (get_cost, 0 spend). Existing PreToolUse `*` observe.sh hook and all other hooks preserved.

Steve's intent: "always call at least 1 skill before building with higgsfield because there are some really useful ones." Pull Higgsfield's value INTO Claude Code (its MCP tools are already native here) rather than pushing his data out. Related: [[feedback_claude_p_over_api]] (keep automation in-house).
