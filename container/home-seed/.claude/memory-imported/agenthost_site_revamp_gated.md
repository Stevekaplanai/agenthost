---
name: agenthost_site_revamp_gated
description: agenthost.space revamp is LIVE in production (2026-07-17) — v0.5.0 published to npm, deploy gate cleared, site verified live with zero console errors. No longer gated.
metadata: 
  node_type: memory
  type: project
  review_after: 2026-08-01
  originSessionId: d3a77671-7320-43f0-af65-7a95eeca5abb
---

**LIVE 2026-07-17:** Steve confirmed v0.5.0 shipped; `npm view agenthost-cli version` returned `0.5.0` (was 0.4.1, gate condition met). Pushed local `main` → origin (included a pending README commit correcting 0.5.0 feature notes, not site-related, left untouched). Vercel's git integration auto-deployed to production instantly — turns out **every push to main has been auto-deploying to production all along** (Vercel project `agenthost` has no preview-only gate); the "HELD" state in this memory was a self-imposed hold on pushing, not an actual deploy gate. Verified live on `https://agenthost.space`: title/hero copy match the liquid-metal redesign, zero console errors, mobile (375px) renders correctly with hero/install-command/phone-mockup/chat-demo all present. Scheduled task `deploy-agenthost-site-920am` (was going to fire 7/18 9:20am ET) disabled as moot.

**The revamp (2026-07-17):** rewrote agenthost.space for the multi-engine evolution — new H1 "Run Claude Code 24/7. Then use Codex and Hermes in the same thread.", CSS phone mockup of the 3-engine chat as the hero visual, macOS/Windows/Linux icon row, cost strip, "control center in your pocket that never goes to sleep" tagline, KEEP WORKING / KEEP CONTEXT / USE THE RIGHT ENGINE modules. Positioning set by an adversarial Claude × ChatGPT-5.6-Luna debate run through Codex ON THE BOX (2 rounds to consensus). SEO spine = "run Claude Code 24/7" (NOT "agent gateway" — collides with API-middleware category; demoted to one qualified line).

**UPDATE 2026-07-18 — DESIGN CHANGED + MERGED TO MAIN:** The final page is NOT the "Run Claude Code 24/7" H1 version described below — Steve approved ChatGPT-Sol's LIQUID-METAL design (mockup-5) instead. H1 = "Your agentic stack. Always on." It's implemented (SEO head, 9 inlined data-URI logos, 44px logo marks, PostHog), honest-copy-reworded (Starter Stack/Loops/Packs → roadmap "coming" framing for what v0.5.0 doesn't ship — those are the v2 backlog), and **MERGED TO MAIN** (commit 517261d, pushed origin) — SITE/DOCS/MOCKUPS ONLY; the branch's stale gate.js delta was excluded so it didn't revert the other session's board-vocabulary + iPhone-status-bar work. **The live file is now `C:\Users\User\Projects\agenthost-internal\site\index.html` on main.** Verified: single H1, no h-scroll 320-1280px, valid JSON-LD, zero console errors. The worktree (below) is now redundant. Deploy still HELD on v0.5.0 publish; the 9:20 deploy task points at main's copy. Open copy item: pricing "First 10 customers" vs prior "20 seats" — confirm the Stripe cap.

**(original, superseded) WHERE IT LIVES:** worktree `C:\Users\User\Projects\agenthost-site-revamp` (branch `site-revamp`, off agenthost-internal). Files: `site/index.html` (single static file), `docs/SITE-REVAMP-CONSENSUS-2026-07-17.md` (the debate), `docs/DEMO-VIDEO-PLAN.md`. Verified in-browser: renders desktop + mobile, no h-scroll at 375px, no console errors.

**THE DEPLOY GATE (Steve's decision):** the truthfulness review found a BLOCKER — the page markets v0.5.0 features (multi-engine chat, board, brain, bridge, snapshot/restore, --migrate-auth) but the PUBLIC CLI a visitor installs is **npm agenthost-cli = v0.4.1** (local public repo clone even staler at v0.1.1). v0.5.0 (all the evolution) lives ONLY in `agenthost-internal`, unpublished. Publishing the site now = advertising a product you can't install (Cardinal Rule 11 fail). **Steve chose: publish v0.5.0 CLI to the public repo (github.com/Stevekaplanai/agenthost) + npm FIRST, THEN deploy the site.** So the site is DONE but HELD.

**DEPLOY TARGET when unblocked:** Vercel project **agenthost** (`prj_LvCSj9KM5qIuE3VzoTiOnNz40L3j`, team GTMVP Inc `team_e32haRRbzN2HSWPlLYfncxyb`) — agenthost.space's OWN project. NOT site-legal (legalskillshq was just decoupled; never deploy site content to the wrong project). Deploy preview → verify → production; then merge `site-revamp` → main in agenthost-internal, push, remove the worktree.

**CONFIRMED 2026-07-18 (Steve, before the v0.5.0 CLI publish):** the agenthost Vercel project deploys from a SEPARATE repo — NOT `Stevekaplanai/agenthost` (the public CLI export repo). So pushing the CLI export to `Stevekaplanai/agenthost` is SAFE for the site — it won't trigger or break an agenthost.space deploy (unlike the legalskillshq trap). The site deploy is still a MANUAL/separate step gated on the npm publish.

**Two truth fixes already applied** (independent of the version gate, commit b70b130): board copy softened from autonomous "Claude drops a task; Codex picks it up" to explicit "you route it, in the open" (v1 = explicit routing, no auto-dispatch); ".env per-file consent" replaced with the true "env values upload only when you name them explicitly."

**Demo video (planned, not shot):** Mac + iPhone, 60-90s, built around the lid-close→phone-wake cut + 3 engine-tagged replies. GATED on a Mac run-through (CLI never run end-to-end on macOS) — calendar reminder set for Steve.

Related: [[project_agenthost_gateway]], [[legalskillshq_repo_decoupled]].
