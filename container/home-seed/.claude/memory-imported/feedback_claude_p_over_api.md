---
name: claude-p-over-api
description: Cardinal rule — always use claude -p (Max subscription) instead of Anthropic API credits. GLM 5.1 via wafer.ai for fast API needs.
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 9dfc7370-4b27-4f92-8dd1-7a7e74183c34
---

Always use `claude -p` instead of the Anthropic API SDK for any LLM calls in scripts, hooks, and automation. Steve's Max subscription covers it — no reason to burn prepaid API credits.

**Why:** Anthropic API credits ran out silently around 2026-05-16, breaking operator-brain capture for 4+ days with no visible warning. The credit-based approach is fragile and unnecessary.

**How to apply:** Any time a script, hook, or automation needs an LLM call:
1. Default to `claude -p --model haiku` (fast, covered by Max subscription)
2. If a fast external API is needed (e.g., real-time, high-throughput, or when claude -p can't be used), use **GLM 5.1 via wafer.ai**
3. Never import `anthropic` SDK or use `ANTHROPIC_API_KEY` for automated calls
4. Treat this as a cardinal rule — same tier as [[feedback_full_urls]]
