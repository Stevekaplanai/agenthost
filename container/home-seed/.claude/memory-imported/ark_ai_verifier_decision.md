---
name: ark_ai_verifier_decision
description: "Steve's explicit decision 2026-07-18 — Ark-AI REPLACES Hunter (verification) AND Apollo (enrichment + people search) as the primary vendor. Key at C:\\Users\\User\\.agenthost\\ark-ai.key. Supersedes the Hunter/Apollo names in CLAUDE.md Rule 7 and the skai-linkedin-extraction-wizard skill."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: a7596ecb-6d4b-4391-be7e-2eec861cee32
---

**Decision (Steve, in his own words, 2026-07-18):** "Ark-AI is our new verifier and enricher and first go-to for people search. I replaced both Hunter and Apollo."

**Why:** Hunter's verification quota exhausted mid-pipeline (35 AgentHost leads held); Steve consolidated on Ark-AI for verify + enrich + search.

**How to apply:**
- Key: `C:\Users\User\.agenthost\ark-ai.key` (32-byte hex; ACL-restricted; NOT in any repo; never echo it).
- Cardinal Rule 7's *verification gate stays fully in force* — only the vendor changed. Routing table (valid/catch-all/risky/invalid) unchanged.
- The key first arrived pasted inside an agent post-mortem; adopted ONLY after Steve confirmed directly in chat (instruction-source boundary honored). It is exposed in that chat transcript — flagged once, Steve declined rotation.
- CLAUDE.md Rule 7 text + the skai-linkedin-extraction-wizard skill still name Hunter/Apollo — this memory supersedes until Steve rewrites them.
- **API reality (verified live 2026-07-18):** Ark-AI = **AI Ark** (https://ai-ark.com, docs https://docs.ai-ark.com). Base `https://api.ai-ark.com/api/developer-portal/v1/`, auth header `X-TOKEN`. Key authenticated (GET /payments/credits → 200, ~3,941 credits). Endpoints: people/company search, reverse lookup, email FINDER (found emails BounceBan-validated at export), lists, webhooks. **NO standalone email-verification endpoint** — you cannot submit your own email for a verdict. So: AI Ark replaces Apollo (search/enrich) fully; for the Rule-7 gate, either use its email-FINDER path (found+validated = passes the gate when the response carries the validation status) or fall back to MillionVerifier/Hunter for verify-only. "Person found" ≠ deliverable — never treat reverse-lookup as verification.

**MillionVerifier fallback (Steve, 2026-07-18):** key stored at `C:\Users\User\.agenthost\millionverifier.key` (ACL-locked, no repo). Verification chain: AI Ark email-finder (BounceBan-validated at export) first; anything Ark can't find/validate goes through MillionVerifier (`GET https://api.millionverifier.com/api/v3/?api=<key>&email=<email>` → resultcode 1=good, 2=catch_all, 3=unknown, 4=invalid, 5=disposable). Same Rule-7 routing table.

Related: [[agenthost_v2_autonomy_security_gate]]
