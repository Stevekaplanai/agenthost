---
name: link-gate-no-phantom-assets
description: "HARD GATE on all social/content publishing — never reference an asset (\"link below\", \"the playbook\") unless the URL is in the post at schedule time and resolves; sweep queues mechanically after every scheduling run"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: c31bd7e5-94e9-4451-ace0-45acbfbb0957
  modified: 2026-07-31T16:23:43.028Z
---

# The link gate — no post promises an asset it doesn't carry

**Why:** 2026-07-31 — four already-PUBLISHED AgentHost posts said "the playbook... link
below" with NO link (the asset's location wasn't even known). Steve: *"make sure this
doesn't happen again."* This is the content form of phantom citations: a receipt pointing
at nothing, on the account whose whole thesis is receipts.

**How to apply:**
1. At schedule time, any post referencing an asset must contain the resolving https URL,
   and the URL must return 200 (curl it — check the world, not the copy).
2. Asset doesn't exist yet → the reference doesn't ship. Cut the line or build the asset.
3. After EVERY scheduling run, re-pull the platform queue and mechanically grep all
   scheduled posts for reference-patterns (link below | in the comments | playbook |
   guide | download | grab) lacking an https URL. Zero real flags or the run isn't done.
   Rhetorical keyword uses are fine — judge per post.
4. Canonical rule text lives in
   `C:\Users\User\Projects\ai-money-minute\AGENTHOST-DISTRIBUTION-LOOP.md` (HARD RULES)
   and applies to every posting pipeline on every platform, not just AgentHost content.

Sweep artifact from the day it was created (11 scheduled posts flagged for adjudication):
`C:\Users\User\OneDrive\Documents\Obsidian Vault\07_Claude_Brain\postiz-linkgate-sweep-2026-07-31.md`

Related: [[receipts-not-wins]] [[agenthost-video-engine-2026-07-30]]
