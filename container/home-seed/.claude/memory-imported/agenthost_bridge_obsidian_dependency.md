---
name: agenthost_bridge_obsidian_dependency
description: "Strategic note (Steve, 2026-07-18) — the box↔PC bridge currently depends on Obsidian's REST plugin, but Obsidian is really just a viewer; de-Obsidian path = the agenthost CLI serves the ledger folder itself. Not actionable until the bridge ships to customers."
metadata: 
  node_type: memory
  type: project
  originSessionId: a7596ecb-6d4b-4391-be7e-2eec861cee32
---

**The thought (Steve, 2026-07-18):** The cross-machine bridge (box ↔ PC) runs through the Obsidian Local REST API today, making Obsidian "required or strongly recommended" — but AgentHost ships its own built-in brain precisely so customers DON'T need Obsidian. Tension: the product's bridge is coupled to a third-party app the product otherwise replaces.

**The reframe (agreed in session):** Obsidian is a VIEWER, not the bridge. The bridge = (a) Tailscale transport + (b) a folder of markdown (the ledger) + (c) a small file read/write API. Obsidian only provides (c) today.

**De-Obsidian path when it matters:** the existing `agenthost bridge` PC-side command grows a tiny built-in file server over a plain folder (e.g. `~/AgentHost/brain/`, with `bridge/inbox/`–style conventions replacing `09_Bridge/to-ccd/`). Customers get the bridge with zero Obsidian; Steve keeps pointing his at the vault folder — Obsidian becomes his optional viewer. Positioning: "bring your own notes app, or none." (~small build; the CLI + Tailscale wiring already exist.)

**Trigger to act:** the first time the bridge ships in a customer's hands (or the site/docs would otherwise have to say "requires Obsidian"). Also update the box team-charter's bridge paragraph (container/team-charter.md in Stevekaplanai/agenthost-internal — it names the Obsidian vault API explicitly) when the protocol generalizes.

Related: [[agenthost_v2_autonomy_security_gate]], [[project_agenthost_gateway]]
