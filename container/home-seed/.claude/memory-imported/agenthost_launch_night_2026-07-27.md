---
name: agenthost-launch-night-2026-07-27
description: "Everything shipped and still open from the 0.5.4/0.5.5 + board-feed launch night, with pointers"
metadata: 
  node_type: memory
  type: project
  originSessionId: c31bd7e5-94e9-4451-ace0-45acbfbb0957
  modified: 2026-07-27T11:02:05.306Z
---

# AgentHost launch night (2026-07-26 → 07-27) — full state

**Releases:** npm live at **0.5.5**. v0.5.4 = tag at 31c8013 (shipped WITH the held
placeholder); v0.5.5 = 54f1c02 (restored JJ's credited Biomimetic layer per Steve —
"the canon is incomplete without it"; the standing repo-transfer offer to JJ stands).
`container/OPERATING-PRINCIPLES.md` = the unified canon (17 principles, 5 layers,
ours + Sovereign-OS ideas + butta ideas staged in Layer 5). Verified live on box.
Deck artifact: https://claude.ai/code/artifact/cb7c8b4e-c161-4420-a42e-d41584cb148b

**Board-feed fix (the "I can't see the board" root cause):** the CC Activity feed
was built from audit.log only; chat-turn board writes go through the hermes CLI and
never touch the gate → invisible to Steve by construction. Fix: task_events (the
kanban's own ledger) merged into ccFeed via board-events-lib.js + a 7s read-only
python-sqlite refresher. **The adversarial review caught that v1 was a NO-OP**
(ccFeedFromLines is an if/else chain; board_card_* rows fell through) — fixed,
integration-tested, live-query smoke-tested. Merge `daeb7da`, deployed image
`deployment-01KYGKMFE6Y8QZZGPW98F3SQ66`. Presence fields (last_heartbeat_at etc.)
are Hermes-kernel columns the gate never writes — heartbeat writes + presence chips
= post-launch (Epic A2 first, per both TRANSCENDENCE §7 and the harness audit).

**STILL OPEN (launch morning):**
- **Codex device login** — no `~/.codex/auth.json` on the box; every autonomous
  claim insta-blocks ("device login first"). Steve runs `codex login` in the box web
  terminal + `chmod 600 /data/home/agent/.codex/auth.json`. Until then cards can't
  visibly run.
- B7 (Morning-Briefing output destination — Steve's call), B8 (Gemini EACCES repro).
- JJ Hashemi IP agreement: drafted at
  `C:\Users\User\OneDrive\Documents\Agreements\JJ-Hashemi-IP-Agreement-DRAFT.md`
  (artifact https://claude.ai/code/artifact/8451f0aa-fa42-4d82-b249-5e471769a4fd);
  calendar Jul 29 on steve@stevekaplan.ai: send + attorney review + (courtesy) sign.
  Patent: butta tech does NOT conflict with the planned narrow provisional
  (identity-split boot + leader election); governance layer already ruled out;
  US 12-month clock running since the accidental social launch.

**JJ DE-NAMING (Steve, ~03:45 launch morning): JJ asked that his name stay OFF
public materials until ~end of week (his patent timeline; the private butta repo
would expose it).** Done: canon + README de-named in 0.5.6 (commit 49f0c71, pushed;
zero identifying terms verified — no names, no "Biomimetic", no "butta", no "HRV");
agreement Section 4 flipped to credit-on-JJ's-schedule + repo-stays-private clause
(artifact republished). npm: **DONE + registry-verified 04:38 —
0.5.6 is latest, 0.5.5 UNPUBLISHED (404)**; no public surface carries the names.
Codex device login also DONE (auth.json 0600 on box — autonomous runs unblocked). **STANDING RULE
until JJ says go: JJ's name, Swanson's name, "Biomimetic Blueprint", and "butta"
never appear in ANY public surface (repos, npm, site, social, PH answers). Private
memory/vault references are fine.** When JJ gives the word: restore the named
credit in OPERATING-PRINCIPLES.md Layer 5 + README (the withheld-credit line
promises exactly that).

**Late-night adds (01:00–02:00 launch morning):** approve-on-terminal-card gate fix
+ opt-in tailscaled boot hook deployed (`deployment-01KYH0HFXRYHZKJ75MZDZAT98J`).
**Box is ON the tailnet** (`agenthost-steve` = 100.104.119.92, verified both ends;
state on /data survives deploys). Obsidian bridge verified working end-to-end (rides
the public Funnel URL — post-launch option: flip BRIDGE_URL to the private tailnet
path + close the Funnel). **PUBLISHING RULE CHANGED by Steve: preapproved with
optional review, authorized channels only** (see feedback_approval_required.md —
rewritten). Coupler MCP + its token line removed from settings. Allowlist scan
added 5 read-only patterns; NOTE: settings defaultMode is already "dontAsk".

**LAUNCH-MORNING OUTAGE + RECOVERY (~10:39-11:10 UTC):** ~25 min gateway downtime
(chat/CC/board; public Vercel site unaffected). Cause: desktop Claude and the
Codex "room" session SHARED one working tree — Codex's `require("./kanban-bridge.js")`
in gate.js was swept into Claude's reaper commit (688fe1b) by `git add <file>`,
the module itself never committed (later git-cleaned away), image crashed at load
every boot. Fix: 7ddc92f lazy-requires the bridge (missing module = dormant
feature, booting gateway), committed from an isolated worktree because the shared
tree was being actively reset mid-edit. **STANDING TREE ASSIGNMENT (Steve):
desktop Claude owns C:\Users\User\Projects\agenthost-internal (main); Codex/room
sessions use their OWN worktrees.** Also shipped same window: boot-time zombie-claim
reaper (machine-boot cutoff, Foundation-B-safe per adversarial review) + denial-audit
dedupe. The Codex "Control Plane" room (WSL house ↔ box over tailnet, canonical-board
bridge) was demoed via infographic; its code awaits its own branch + review.

**Operational lessons:**
- `scripts/redeploy-box.sh` (chunk-upload over ssh exec) failed 2× on flaky
  transport at random chunks; **`scripts/deploy-box.sh` (direct
  `flyctl deploy --remote-only` from Steve's machine, which HAS flyctl) is the
  reliable deploy path.**
- Sovereign-OS repo is **MIT (verified 2026-07-26)**; the paper stays CC BY-NC-SA —
  ideas in our own words, code reuse would need attribution (none used).
- Box-Claude mis-resolved "v0.5.4 = af82ed3" without checking the tag — verify tag
  targets before trusting version claims, even from the box.
- Newsjack anchor: OpenAI rogue-agent incident Jul 22 (5 major outlets); drafts in
  the deck, approval-gated per standing social rule.
