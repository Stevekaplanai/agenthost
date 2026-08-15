---
name: feedback_artifacts_over_markdown
description: "Steve 2026-07-18 — STRONG standing preference: deliver documents as rendered ARTIFACTS (claude.ai Artifact pages / styled HTML on the box), never plain text or raw markdown, for any project document or deliverable."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: a7596ecb-6d4b-4391-be7e-2eec861cee32
  modified: 2026-07-26T21:42:39.360Z
---

**Steve (2026-07-18):** "Let's move towards artifact based project documents on the box and here. Make it a STRONG preference to have an artifact over plain text or markdown of any kind."

**Why:** Raw .md files make Steve do the rendering in his head; a styled page communicates the same content at a glance (the mockup-vs-plaintext gap he keeps hitting — chat markdown, the calendar, the whitepaper).

**How to apply:**
- **Desktop ("here"):** any substantive deliverable (plans, reports, whitepapers, calendars, briefs, post-mortems) gets published via the Artifact tool as a designed page (brand tokens: #0B0D10/#FF6A3D/mono aesthetic for AgentHost work). The .md source can still live in the repo for versioning — the ARTIFACT is what gets handed to Steve. Load the artifact-design skill before building.
- **Box:** project documents should be served rendered (styled HTML), not raw markdown — a gate /docs route or equivalent is the direction; board task assigned to the team.
- Markdown remains fine for: code-adjacent files (README, comments), source-of-truth files agents parse, and git-versioned working files — but the HUMAN-FACING handoff of any document is the rendered artifact.

**Sharpened 2026-07-26 (launch eve), per Steve: "I don't like markdown files — put my files in a well designed easy to read coherent HTML artifact."** The rule is now a HARD gate, not a preference: writing a .md deliverable and handing Steve its path VIOLATES this rule even if the content is good (it happened repeatedly on launch eve — checklist copy, cross-post drafts, newsletter drafts, LinkedIn copy all shipped as .md and Steve had to push back). The completion test: if Steve is meant to READ it, there must be an Artifact URL (or box-rendered page) in the reply. A .md path alone is an unfinished delivery. Consolidate related deliverables into ONE coherent artifact rather than scattering files.

**Extended 2026-07-26 (same night), per Steve: every artifact is INTERACTIVE — "like we just did" (the launch command deck).** This covers everything that would otherwise have shipped as a .md file. The standard, in tiers:

1. **Baseline (always, no exceptions) — Steve's own stated minimum (2026-07-26): "checkboxes that actually cross out the tasks."** Any task/checklist content gets working checkboxes that strike through and PERSIST (localStorage). Beyond that floor, add what fits the content: a copy button on every block Steve will paste somewhere (posts, commands, email bodies, SQL), collapsible sections for long content, working links (https, full), status chips/tables for state. Inline JS/CSS is fully allowed in artifacts; there is no excuse for an inert wall of text.
2. **Wired actions (when a claude.ai connector can genuinely power them):** buttons that DO the thing via `capabilities: {mcp: ...}` — but only after loading the artifact-capabilities skill, only for connectors available to Steve, and only after observing a real request/response pair for the tool (or telling Steve at publish time that the first click is the live test). A connector-wired artifact cannot be shared publicly — say so when it matters.
3. **The hard guard — no dead controls, ever:** a button, toggle, or input that does nothing is Cardinal Rule 11's copy-matches-code violation in artifact form and is WORSE than plain text. If an action can't be wired (e.g. Postiz has no connector — verified 2026-07-26), don't fake it: give the copy button + a link to the surface where the click is real (the Postiz dashboard pattern). Interactivity is real or absent.

Test before publishing any artifact: *does Steve have to manually select-and-copy text, or hunt for a link, or leave the page to know a state this page could show him?* If yes, it isn't done.

Related: [[ark_ai_verifier_decision]], [[agenthost_v2_autonomy_security_gate]]
