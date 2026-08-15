---
name: attribyte_server_llm_path
description: "Attribyte's server-side LLM path is OpenRouter/Kimi (Atlas), NOT claude -p — and that's correct, not a cardinal-rule violation"
metadata: 
  node_type: memory
  type: project
  originSessionId: a902c679-d176-45f5-891c-65096f2e633d
---

In Attribyte (`apps/api`, deployed on Railway), all server-side LLM calls go through the **Atlas subsystem**: `apps/api/src/atlas/llm/openrouter-client.ts` — OpenRouter, default model `moonshotai/kimi-k2.6:free`, gated on `OPENROUTER_API_KEY`, with graceful degrade (`isAtlasConfigured()`).

**Why this is NOT a violation of [[feedback_claude_p_over_api]]:** `claude -p` needs the Claude CLI + Max-sub auth on the machine. A deployed Railway server has neither, so `claude -p` cannot run server-side. The cardinal rule's intent — never burn Anthropic API credits; use GLM/Kimi via wafer.ai/OpenRouter for server LLM — is satisfied by Atlas. Do NOT "fix" Attribyte server LLM code to call `claude -p` or `@anthropic-ai/sdk`; reuse the Atlas OpenRouter client.

The insights engine (`apps/web/src/lib/insights.ts`) is deterministic + templated and documents an "LLM POLISH SEAM." The polish layer shipped 2026-06-01 (PR #131): `apps/api/src/atlas/llm/polish-insight.ts` rewords templated insights with a number-preservation honesty guard + template fallback. Wired to Attribution, Creative Quadrant, Measurement. Merging #131 needs a Railway API redeploy (new `/api/v1/insights/summary` endpoint); frontend falls back to template if the endpoint 404s, so out-of-order deploy won't break.
