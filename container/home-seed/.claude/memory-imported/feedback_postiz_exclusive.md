---
name: postiz-exclusive-blotato-retired
description: Social publishing runs exclusively through Postiz (lifetime license); Blotato retired 2026-07-27
metadata: 
  node_type: memory
  type: feedback
  originSessionId: c31bd7e5-94e9-4451-ace0-45acbfbb0957
  modified: 2026-07-27T12:49:06.493Z
---

# Postiz is the only social-publishing pipe — Blotato retired

Steve, 2026-07-27 (launch day): "Disconnect the blotato MCP. We exclusively use
Postiz now. I have a lifetime license and it has all the same features."

**Why:** one pipe, paid once, same features. Blotato's MCP auth had also expired
mid-launch, blocking a YouTube upload at a critical moment.

**How to apply:**
- All scheduled/social posting (YouTube, TikTok, LinkedIn, X, IG) goes through
  Postiz. Never suggest or use Blotato tools even if the connector reappears.
- Local cleanup done 2026-07-27: 8 Blotato entries removed from the
  settings.json permission allowlist. The claude.ai Blotato connector itself is
  removed by Steve at https://claude.ai/settings/connectors (flagged to him).
- Postiz API key lives at `C:\Users\User\.agenthost\postiz.key` — was DEAD as of
  2026-07-27 morning; Steve owes a fresh key from platform.postiz.com → Settings
  → Public API. Until then Postiz calls fail — surface that, don't fall back to
  another platform.
- The AI Money Minute pipeline memory mentions "Blotato + Postiz" — historical;
  Postiz-only going forward.
