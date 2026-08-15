---
name: agenthost_cli_mac_parity
description: agenthost-cli deploy path (npx agenthost-cli deploy) audited + fixed for macOS parity 2026-07-19. ZERO blockers found; 6 rough edges all fixed + merged to main. Mac self-serve deploy is now viable — the CLI is no longer a self-serve blocker.
metadata: 
  node_type: memory
  type: project
  review_after: 2026-08-20
  originSessionId: 452be368-6ff3-4a1f-88e5-7a1b61d2820d
  modified: 2026-07-23T00:46:56.735Z
---

**Context (Steve, 2026-07-19):** the whole AgentHost deploy was built + tested from WINDOWS; Mac path never run end-to-end. Steve asked whether to build a self-serve onboarding flow for agenthost.space or keep forcing 1:1 white-glove. Decision reached: **keep white-glove for the Founding 50 (it's what they paid for + those 50 conversations are the spec), build self-serve as the path for the tier AFTER (the $29/mo tier, free-CLI upgraders, cohort #2).**

**Audit result (5-agent workflow, adversarially verified):** the deploy path is genuinely portable. It shells out to only `node`, `flyctl`, `tar`; box build is `--remote-only` (NO local Docker prereq); paths use os.homedir()/path.join. **ZERO hard blockers** for a Mac user. 6 "degraded" rough edges found + ALL FIXED (commit 90abdb9, merged 3d6805f to agenthost-internal main):
1. README now lists prereqs (Node 18+, flyctl install brew+curl, flyctl auth login).
2. src/fly.js flyctlPath() now finds ~/.fly/bin/flyctl on Mac/Linux (was win32-only) — the curl-installer-not-on-PATH-yet gap.
3. scripts/pack.mjs tar: COPYFILE_DISABLE=1 (kills BSD-tar ._* AppleDouble) + .DS_Store excluded at staging AND tar.
4. --migrate-auth on Mac now gives a helpful message (Mac stores Claude creds in KEYCHAIN not ~/.claude/.credentials.json) pointing to the claude setup-token / CLAUDE_CODE_OAUTH_TOKEN box-side path. Did NOT programmatically read Keychain (out of scope/fragile).
5. scripts/pack.mjs symlink handling now bounds deref to inside-the-packed-tree (skips links whose target escapes root, was silently pulling external content).
6. TTY abort already named --yes clearly — no change needed.

Tests 378→380 (2 added, both pass; 20 pre-existing known-Windows-env fails unchanged). All changes are LOCAL CLI-side (README/src/scripts) — ship to customers on the NEXT `npm publish`. **✅ SHIPPED: verified 2026-07-22 — npm `agenthost-cli` = v0.5.1, matches local repo exactly. The Mac-parity fixes are LIVE for customers. Nothing pending here.** No flyctl deploy needed. No site/ files touched (verified — the Vercel deploy the push triggered is identical output).

**REMAINING for actual self-serve onboarding (not yet built):** a web onboarding flow on top of the /welcome page (shipped 2026-07-19, see [[agenthost_founding50_framing_e]] checkout work). Now a SMALL build (web UX on a working deploy), not a deploy rewrite — that was the whole point of this audit. Trigger it when Steve opens the self-serve tier. The #4 Keychain/auth divergence is the one place Mac users' path still differs from Windows even after fixes (they auth on the box, not via --migrate-auth) — the onboarding flow should guide that explicitly.
