---
name: agenthost_social_gate_exception
description: "AgentHost box — the ONE exception to the fail-closed human-gate: genuine social-posting tasks auto-run unattended (Steve, 2026-07-18). Red-team-hardened; every other dangerous keyword still gates."
metadata: 
  node_type: memory
  type: project
  originSessionId: a7596ecb-6d4b-4391-be7e-2eec861cee32
---

**Why it exists (Steve, 2026-07-18):** the box's purpose is to act for Steve when he's away from his PC — a bridge between him and the work. Publishing social content is the first thing it must do unattended. He explicitly wanted the posting step NOT to gate to him. Chose the middle path (over "remove all gates"): a NARROW social-posting exception, keeping every genuinely-dangerous action gated.

**The design (in `container/chains-lib.js`, `isHumanGated`):** INVERTED from the first (broken) cut. Keep the ENTIRE gated keyword set hard-blocking; neutralize ONLY a tiny explicit allowlist of pure content/CTA words (post/publish/tweet/broadcast/share/schedule/queue/launch/announce + dm/message/reply/text/call/comment/caption). A task auto-runs iff `isSocialPostingTask(hay)` (POSTING_VERB_RE ∧ SOCIAL_CONTEXT_RE) is true AND `NON_SOCIAL_GATED_RE` (the full gated set minus the allowlist, plus broadened exfil coverage) does NOT match. `NON_SOCIAL_GATED_RE` keeps: deploy/destroy/drop/wipe, push/force-push/merge/migrat(e|ion), install/provision/restart, run/exec/curl/wget/ssh/scp/sudo, **send/email/notify/escalate**, pay/wire/transfer/subscribe/invoice, tokens?/secrets?/credentials?/passwords?/api[-_ ]key/.env/dotenv/env-var/private-key/.pem.

**⚠️ THE LESSON — first cut had 10 red-team bypasses.** I initially hand-picked a "DESTRUCTIVE subset" and DROPPED run/exec/email/push/subscribe/migration/credentials-plural → an injected "post" task could run shell, email as Steve, or exfil .env to LinkedIn. An 18→15-agent adversarial workflow caught it (verify phase got killed by the 5-hour session limit, so I verified the 12 attack claims by executing the real `isHumanGated` against each: 10 wrongly auto-ran). Fix = the inversion above. **Rule for any future gate edit: NEVER hand-curate a "safe/dangerous" subset by hand — invert (keep-all-minus-allowlist) and add an ENUMERATION test.** `test/chains-lib.test.js` now has: the 12-attack red-team regression guard, an enumeration invariant (every dangerous keyword gates inside a social task), and the CTA-allowlist cases. 43/43 chains-lib, verified 6/6 on the DEPLOYED box gate.

**Intentional over-gate:** "apply now" GATES (apply = real infra verb: apply a migration). Fine — the ~6 Shout-phase "apply now" conversion asks get a human glance; the ~24 give-phase posts flow unattended.

**Honest residuals (mitigated, not eliminated; in the charter):** (a) bare secret-synonym nouns (environment/config) aren't lexically gated — redactSecrets output layer + Rule 6 backstop actual secret VALUES; (b) channel scoping (post only to X @HiSteveKaplan + LinkedIn personal, the two Steve approved) is instruction-level in the charter + the task's baked integration IDs, NOT lexical — the gate can't see which channel; (c) no per-task post-rate cap — chain budgets (6 runs/45min/150K/$5) bound runaway volume.

**Postiz channel IDs (Steve-approved, 2026-07-18):** X @HiSteveKaplan = `cm43474d6000d61zsf26olh3v` (provider "x"); LinkedIn personal = `cm433m5e5000361zszjorqczr` (provider "linkedin"). NEVER: GTMVP page (linkedin-page), Instagram (x2), YouTube, TikTok, Student AI Detector. New Postiz key stored on box (verified authenticating, HTTP 200, 7 integrations).

Related: [[agenthost_v2_autonomy_security_gate]], [[agenthost_file_retrieval]], [[agenthost_launch_blockers]]
