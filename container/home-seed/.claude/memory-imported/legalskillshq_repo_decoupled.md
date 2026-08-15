---
name: legalskillshq_repo_decoupled
description: legalskillshq.com decoupled from the shared public agenthost repo (2026-07-17) after an AgentHost export broke it. Legal now has its OWN repo Stevekaplanai/legalskillshq. NEVER push AgentHost exports to a Vercel-watched repo.
metadata: 
  node_type: memory
  type: project
  originSessionId: a7596ecb-6d4b-4391-be7e-2eec861cee32
---

**The incident (2026-07-17):** legalskillshq.com's Vercel project (`site-legal`, team GTMVP Inc `team_e32haRRbzN2HSWPlLYfncxyb`, project `prj_qwCu86nKy9LVLGnfZxOjYkdoGvWA`) was git-connected to the PUBLIC repo `github.com/Stevekaplanai/agenthost` (repoId 1296391682) and auto-deployed its `main` to PRODUCTION. That repo was once a monorepo with the legal site under `site-legal/` (Vercel root dir = site-legal/). AgentHost's public export (v0.3.3/0.4.0/0.4.1, author "AgentHost <agent@agenthost.space>") replaced the whole repo with AgentHost-only code → Vercel deployed AgentHost's README/CLI to legalskillshq.com → broke it. Steve rolled legalskillshq back (left the 3 AgentHost-titled prod deployments alone) and asked to fix + prevent recurrence.

**NOTE:** today's gateway commits went to `agenthost-INTERNAL` (private dev repo), NOT the public `agenthost` repo, so they did NOT cause this — the break was the earlier v0.4.x release cycle. But the coupling was a latent trap: any future AgentHost export to the public repo's main would re-break legal.

**THE FIX (done):** legalskillshq now has its OWN private repo **`github.com/Stevekaplanai/legalskillshq`** (static HTML site, the `site-legal/` files at root, from agenthost-internal). export-public.mjs hardened with a prominent DO-NOT-push-over-a-Vercel-watched-repo warning (commit cbbe521).

**STEVE STILL OWES (Vercel dashboard, ~1 min):** repoint the `site-legal` Vercel project's Git connection from `Stevekaplanai/agenthost` → `Stevekaplanai/legalskillshq`, and CLEAR the "Root Directory" setting (files are now at the new repo's root, not in site-legal/). Until he does, legal still watches the shared repo. Reminder set.

**RESOLVED 2026-07-19 (Steve, manually):** Steve disconnected `site-legal` from ALL GitHub repos then reconnected it to `Stevekaplanai/legalskillshq`. Vercel API corroborates: project updatedAt = 2026-07-19 morning, and no new deploy fired. The API summary doesn't expose the git-link target, so the DEFINITIVE test is the next AgentHost public-repo export: legalskillshq.com must NOT redeploy. If it does, something deeper is wrong (Steve's words: "a different problem that I can't see or fix over here"). Until one export passes clean, keep treating public-repo pushes as needing a post-push check of legalskillshq.com.

**RULES GOING FORWARD:**
- The legal site source of truth is now `Stevekaplanai/legalskillshq`. The copy in `agenthost-internal/site-legal/` is a working copy; if edited there, sync to the new repo.
- NEVER push an AgentHost public export to any repo a Vercel project deploys from, except agenthost.space's own. Confirm the target repo's Vercel watchers first.
- agenthost.space (the AgentHost marketing site) is a SEPARATE concern — lives under `site/` historically, not `site-legal/`.
