---
name: agenthost_control_room_redesign
description: "AgentHost Control Room (renamed from Command Center) is being rebuilt into an accordion mission-control home surface. Data layer DONE+deployed 2026-07-18; the cc.html UI rewrite is HANDED OFF to a fresh session (docs/control-room-rebuild-handoff.md)."
metadata:
  node_type: memory
  type: project
  originSessionId: a7596ecb-6d4b-4391-be7e-2eec861cee32
  review_after: 2026-07-19
---

**RENAME DONE:** Command Center → **Control Room** (nav label in gate.js APPS + cc.html `<title>`; code comments left as-is per Rule 5). Deployed.

**APPROVED DESIGN (mockup Steve signed off): `https://claude.ai/code/artifact/192a9b9a-ac79-483f-9da2-7bce3c67ad85`** — accordion mission-control, phone-first, fills the screen (fixes the old crunched-with-dead-space stacked layout). Structure: (1) **sticky cockpit that NEVER collapses** = big red STOP + budget gauge ($spent/$cap burn bar) + autonomy toggle; (2) **always-visible horizontal-scroll agent-status strip** (5 engines, live state + current action + budget %); (3) **accordion panels** (board/activity/spend/loops/inventory) — tap one → expands full detail, collapses the rest, SCROLLS it under the cockpit. **Board OPEN by default; scroll-into-view on open** (both Steve's explicit choices). 3D tactile tiles (raised top-light-edge + bottom-shadow, press-down on tap, opened tile gets accent glow + rotated chevron). Grounded in a 3-way ICP recon (control-room-icp-recon workflow): the cockpit/kill-switch/budget-gauge is "the reason a control room exists"; keep live stuff above the fold, reference (skills/tools/MCP) collapsed below; add a "while you were away" activity feed; AVOID vanity metrics (lifetime tokens, uptime banners).

**DATA LAYER — DONE + DEPLOYED + VERIFIED LIVE (this session):** New `GET /cc/inventory` → `{agents:[{id,label,installed,routed}], skills:{count,sample}, mcps:[{name,connected}], tools:[names]}`. **Tools = NAMES ONLY, secrets STRIPPED** — the head before "(" of each `permissions.allow` entry, so a token in an arg (`Bash(claude mcp add-env x TOKEN abc)` → `Bash`) can never reach the client; also filtered through autonomyRedactValues. Proven by test + verified live (225 skills, 5 agents, 3 MCPs [obsidian/tolaria/posthog], no COUPLER, no high-entropy strings — only structured `mcp__*` ids). Extended `ccFeed` to surface autonomy_run/await_review/board_review_* so the feed shows real agent work. Other panels already had endpoints: `/board`, `/autonomy` (on + chain budgets), `/cc/state` (usage+feed+windows), `/cron/jobs`. 18/18 CC tests.

**UI REWRITE — HANDED OFF to a fresh session** (Steve's call — 900-line cc.html rewrite is lower-risk in a clean session). Full handoff: **`C:\Users\User\Projects\agenthost-internal\docs\control-room-rebuild-handoff.md`** — lists the approved design, every live endpoint + shape, the working cc.html JS to PRESERVE verbatim (renderBoard, reviewActions ✓/⋯ menu, openDetail, renderAutonomy + STOP toggle, highlightCard deep-link, refresh loop), what's new (accordion shell, agent strip, inventory panel), and the mockup HTML in `<scratchpad>/control-room-v2.html` to lift structure/CSS from. **Task #54 carries this.** OPEN QUESTION for that session: Steve said "remove all the other top tabs and spread the love" — likely means the Control Room's own nav shrinks, NOT that chat/loops become unreachable; ASK before removing nav entries (Rule 3 UX regression risk).

**SECURITY (handled this session):** found a live `COUPLER_ACCESS_TOKEN` in plaintext inside the box's `~/.claude/settings.json` `permissions.allow`. Steve chose REMOVE (not rotate) — deleted the entry (verified zero COUPLER refs remain, timestamped backup made). The tools panel's names-only rule is the permanent guard.

**📥 NEW asks from Steve via the bridge (2026-07-18T21:13Z), captured for the next session:**
1. **Slack-style chat timestamps + day markers** — a time on each message + sticky "Today/Yesterday/Jul 17" dividers as you scroll (chat.html; low lift; do it alongside the Control Room session).
2. **🐛 CODEX BUG (needs real diagnosis):** Codex says it's doing a task but the card never moves to in-progress after 10 min. Classic silent-failure / claim-without-progress — likely Codex auth dead in the read-jail (it's been dormant/out of ChatGPT credits) → it claims but the run hangs/fails and the claim doesn't release. Fix direction: a "claimed but no autonomy_run event in N min → release + re-dispatch" guard, AND verify Codex jail auth is actually live. Check audit log for the stuck card's claim vs autonomy_run events.
3. **Gamify — achievement system like Hermes** (unlock combos → a cool on-screen celebration, NO leaderboard). Explicitly **v1.0.0 / NOT a priority** — backlog.
4. **Native iOS/Android app of the Control Room** — Steve asked the lift. Answer: LOW-MEDIUM because the box UI is already a mobile web app with manifest+SW+push. Options: (a) PWA install-to-home-screen ≈ near-zero extra work, no App Store; (b) Capacitor/Tauri native shell wrapping the same web UI → App Store/Play Store + native push, days not weeks (real cost = Apple review + store rules, not code). Scope it when he wants it.

Related: [[agenthost_engines_gemini_openclaw]], [[agenthost_v2_autonomy_security_gate]], [[project_agenthost_gateway]]
