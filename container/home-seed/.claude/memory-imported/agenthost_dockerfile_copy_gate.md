---
name: agenthost-dockerfile-copy-gate
description: Any new file in agenthost container/ MUST get a Dockerfile COPY line — missing one crash-looped the live box on 2026-07-20
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 1efbf18e-284b-4976-9884-d1ab9b389cce
  modified: 2026-07-20T23:56:56.608Z
---

# New container/ files need a Dockerfile COPY line — verify the image, not just the code

**What happened (2026-07-20):** A build added `stuck-lib.js` to `C:\Users\User\Projects\agenthost-internal\container\` and a `require()` for it in gate.js. `node --check` passed on everything. But `container/Dockerfile` COPYs an **explicit file list** (lines ~61-80) — the new file wasn't added, so the deployed image lacked it. gate.js threw MODULE_NOT_FOUND at boot → machine crash-looped (exit 1 every ~20s) → Steve's production box DOWN until a hotfix deploy.

**Why:** "code verified locally" ≠ "image contains the code." The Dockerfile is the deploy surface; a new file that isn't COPYed simply doesn't exist on the box. This is Rule 11 applied to deployment: the chain is code → **image** → boot → user.

**How to apply:**
- Any change that ADDS a file to `container/` must add a matching `COPY <file> /opt/agenthost/<file>` line to `container/Dockerfile` in the same diff. Check this explicitly before calling a container build done.
- When delegating container/ builds to subagents, put the Dockerfile-COPY requirement in the prompt.
- Rate-limit note: `scripts/redeploy-box.ps1` got retry/backoff on the chunk upload the same day (Fly Machines API rate-limits rapid /exec calls; same bug still exists in `redeploy-box.sh`, unfixed by choice).
- Recovery path when the box is crash-looping (self-redeploy impossible): render `fly.toml.deploy` locally (`sed 's/AGENTHOST_APP_NAME/agenthost-steve/' fly.toml > fly.toml.deploy`) and run `flyctl deploy -c fly.toml.deploy --remote-only --strategy immediate --yes` from `container/` on the PC — same pipeline the box runs on itself.

Related: [[agenthost-settings-wishlist-roadmap]]
