# Steve Kaplan — Memory Index (Active Only)

Last refreshed: 2026-07-31 (compacted; detail lives in topic files)

## 🔴 Current Situation (2026-07-31)

- **[Postiz API gotchas](postiz_api_gotchas.md)** — no update endpoint (edit = delete+recreate), no first-comment support, and **X silently strips full URLs** (use bare domain, no `https://`). Always verify by re-reading the queue; a 201 does not mean it stored what you sent.
- **[Legal name + real city](legal_name_and_location.md)** — **Stephen Lewis Kaplan**, **Lake Worth FL** (NOT Fort Lauderdale). Legal name on anything filed/signed; never take legal facts from the brand profile.
- **[Agent naming](agent_naming_and_claude_identity.md)** — Hermes the Independent (HI) = WINDOWS; King Hermes = WSL; box agents have NO names.
- **🎯 ONE PRODUCT (ADR-2301, Steve 2026-08-01 — "Stop being four stories"):** AgentHost IS the wedge and the only agency-facing sale. **One instance = $1,500/month**, a governed box in the agency's own cloud, shipping with the diagnostic + attribution + marketing agents as **PACKS ON THE INSTANCE**. Attribyte's standalone funnel PARKED (= measurement pack); Synap stays paused (its agents = marketing pack); GTMVP's $3.5-12k Series A SaaS business UNCHANGED and untouched. Model = GoHighLevel (agency tier, per-instance, their growth compounds our MRR). Positioning = **capacity not tools; the night shift; breaks the headcount ceiling.** SUPERSEDES ADR-2211 (Attribyte-as-wedge). Doc: vault `07_Claude_Brain\ADR-2301-one-product-agenthost-is-the-wedge.md`. The older four-product docs carry supersession banners.
- **(historical) GROWTH MODE four-product framing (2026-07-31):** GTMVP diagnoses, Attribyte measures, Synap executes, AgentHost runs it. **Buyer = 2-10 person agencies** (per-client economics) — the buyer decision STANDS; the four-story framing does not. Canonical docs in vault: `07_Claude_Brain\agenthost-product-direction-2026-07-30.md` (north + buyer), `growth-mode-unification-brief.md` (Synap Option-A, domain: agenthost.com NOT owned — use .space), `gtmvp-growth-mode-rebuild-BRIEF.md` (site rebuild: AgentHost skin, /growth-mode anchor, $1,500 diagnostic, 3D Attribution benefit-only wording until patent files).
- **GROWTH BRIDGE — LIVE IN PROD 2026-07-31:** merged `fdfbf18`, Railway verified, migration applied. Remaining = founder items: 5 validation calls (Hermes's script in vault), end-to-end eyeball at https://app.attribyte.xyz, real ad account for CPA proof. Guide: `C:\Users\User\Projects\attribyte\docs\BUILD-GUIDE-2026-07-31-growth-bridge.md`.
- **⚠️ GTMVP working copy LANDMINE:** `C:\Users\User\Projects\gtmvp-saasw\GTMVP_V0` on side branch, 46 behind main, WITH uncommitted changes. Re-baseline always; never discard without Steve's word. Rebuilds use a FRESH clone of `https://github.com/GTMVP/GTMVP_V0.git`.
- **gtmvp.com analytics:** PostHog project 459397 had ZERO events ever; site runs GA4 `G-VHXK45LL4B` via GTM `GTM-5Q6S4QKS`. Steve wiring PostHog through GTM (key in project list). Verify ingestion by state.
- **[ROUTER BUILD — main lane](../../../Projects/agenthost-internal/docs/HANDOFF-2026-07-31-router-build.md)** — connect to RUNTIMES not chat apps; 7 recipients incl. gated Box. Slices 1-2 merged 2026-07-31, slice 6 nearly done same day; acceptance = Steve's kill-the-gateway test + Hermes inside/blind-witness QA (specced in the handoff). Handoff: `C:\Users\User\Projects\agenthost-internal\docs\HANDOFF-2026-07-31-router-build.md`.
- **[AgentHost video engine](agenthost_video_engine_2026-07-30.md)** — 40-clip library; **Ep2 scheduled Thu 7/31 + Ep3 Fri 8/1, both 5:30pm ET** (episode slot; 9am = text narrative). Ep4-9 drafted awaiting review; Ep8 (phantom patent) gates CLEARED. Pipeline = skill **`/agenthost-episode`**. Cold-start: `C:\Users\User\Projects\agenthost-launch\02-videos\HANDOFF-VIDEO-2026-07-30.md`. Keys (ElevenLabs, HeyGen, Postiz +) in `C:\Users\User\.agenthost\`.
- **🏆 [FILED: Provisional 64/122,926 — 2026-07-31](provisional_c_FILED_2026-07-31.md)** — behavioral runaway detection. "Patent pending" earned (never "patented"). EXPIRES 2027-07-31. Patent candidates for counsel: hyperbolic retrieval + hyperbolic/3D-attribution measurement (file BEFORE marketing discloses method) + agent-action provenance (Oct 31 go/no-go). **PROVISIONAL B window: trigger = causal linking ENFORCED in live two-box mesh exchange (informational-only at tip 5572742); Sept 1 hard stop. Dual-channel reminders set 7/31: calendar all-day Aug 25 + Windows task `ProvisionalB-FilingWindow` (script in `C:\Users\User\.agenthost\reminders\`).** Mesh two-box proof NOT done until Hermes's blind-witness log diffs clean — deploy gated on Steve.
- **Codex CLOSED until OpenAI credits return** (37h divergence 7/29-30 consumed Max plan; doctrine rewritten — see `00-DOCTRINE-how-we-work.md`: hour-3 checkpoint mandatory, token budget = consequence, verify intent not just code). Kimi: chat-only on box until Track A slice 3 + spawn path; first rung = copy red-team of the GTMVP rebuild.
- **[LAUNCH NIGHT 2026-07-27 state](agenthost_launch_night_2026-07-27.md)** — npm 0.5.5 live. OPEN: Codex device login on box; bugs B7/B8; JJ IP follow-up. Reliable deploy = `scripts/deploy-box.sh`. Launch result: 118 readers / 68s / 0 conversions (= Ep2's receipt).
- [Phase 3 git-ladder rung 1 — deployed dormant](agenthost_phase3_git_ladder_rung1.md) — autonomy default 0; rungs 2-4 need fd-3 red-team before wiring. NOTE 2026-07-31: router build may supersede parts; check handoff first.
- [AgentHost shipped-platform index] — gateway/engines/V2 autonomy/social-gate/files-panel/mail/site-revamp all SHIPPED Jul 17-18; details in `project_agenthost_gateway.md`, `agenthost_engines_gemini_openclaw.md`, `agenthost_v2_autonomy_security_gate.md`, `agenthost_social_gate_exception.md`, `agenthost_file_retrieval.md`, `agenthost_launch_blockers.md`. Standing: STEVE OWES GEMINI_API_KEY; never kanban write-verbs as root over SSH.
- [CLI Mac-parity fixed 7/19](agenthost_cli_mac_parity.md) — Steve owes `npm publish`. [Founding 50 framing E](agenthost_founding50_framing_e.md) — $1,999 list / TOMORROWSHERE = $499, agenthost.space/founders.
- [legalskillshq decoupled](legalskillshq_repo_decoupled.md) — own repo; STEVE OWES Vercel repoint. NEVER push AgentHost exports to a Vercel-watched repo.
- [AI Money Minute — LIVE daily](project_ai_money_minute_library_engine.md) — 8am ET task; runbook `C:\Users\User\Projects\ai-money-minute\DAILY-LOOP.md`.
- Side ventures (background): [Curb Club](project_curb_club.md) · [Stem-cell deal EVALUATING](stemcellsnow_renova_deal.md) + [Stem Cell Readiness](stemcellsnow_launch_ready.md) · [Click Then Convert rebuild](project_click_then_convert.md) · [Vibe Stack newsletter](steve-newsletter-venture.md) · [Job search](project_job_search.md) (departed NJA 5/27).

## ⏸️ Deferred — do NOT lose

- [GTMVP orchestrator activation](gtmvp_orchestrator_activation.md) — shipped but DORMANT; activation runbook in file.
- [Hermes on local Ollama](hermes_ollama_context_64k.md) — needs 65536 ctx; OAuth fallback dormant.
- [AgentHost bridge de-Obsidian](agenthost_bridge_obsidian_dependency.md) — act when bridge ships to customers.

---

## 🚨 TOP-PRIORITY OPERATING RULES (read before every response)

- **[Reminders carry expiring claims](lesson_reminders_carry_expiring_claims.md)** — a scheduled `claude -p` reminder is a snapshot of beliefs, not facts; verify each claim before acting, and neutralize the file when a premise turns out false.
- **[THE LINK GATE](feedback_link_gate_no_phantom_assets.md)** — no post references an asset ("link below", "the playbook") without its resolving URL in the post at schedule time (curl 200). Mechanical queue grep after every scheduling run. All pipelines.
- **[NEVER touch steve@idkstrategies.com](feedback_calendar_never_idkstrategies.md)** — calendar/invites to steve@stevekaplan.ai only.
- **[MERGES: ask once, then Claude executes](feedback_merge_permission_not_handoff.md)** — never a command handoff. Deploy/publish/consequences still Steve's.
- **[FULL URLS AND FILE PATHS always](feedback_full_urls.md)** — fully qualified, never bare routes.
- **[claude -p, NEVER Anthropic API](feedback_claude_p_over_api.md)** — Max sub for all automation.
- **[FETCH LIVE REPOS FIRST](feedback_fetch_live_repo_first.md)** — re-baseline vs origin/main before any work.
- **[VERIFY CLEAN-BUILD-FROM-ZERO](feedback_verify_clean_build_first.md)** — before feature work.
- **[Artifact URLs: WebFetch, never curl](reference_artifact_urls_fetch_with_webfetch.md)**.
- **[NO ARTIFACTS — local files only, same craft](feedback_no_artifacts_local_only.md)** — Steve 2026-07-28 REVOKES artifacts-over-markdown (`feedback_artifacts_over_markdown.md` superseded): designed interactive HTML built LOCALLY, never hosted.
- **[Ark-AI replaces Hunter + Apollo](ark_ai_verifier_decision.md)** — key `C:\Users\User\.agenthost\ark-ai.key`; Rule 7 gate unchanged.
- **[Supabase migrations = apply autonomously](feedback_supabase_migrations_autonomous.md)** — verify safety first. Attribyte = `kqpllsenlvdgsznptylb`.
- **[container/ files need a Dockerfile COPY line](agenthost_dockerfile_copy_gate.md)** — verify the image contains the file.
- **PatSnap/citation rule (2026-07-31):** every cited patent gets PULLED AND OPENED or treated as nonexistent — PatSnap produced two phantom WOs. Lesson: vault `08_Memory/lesson/patsnap-phantom-citations-2026-07-31.md`.
- **[PS 5.1 handed-off blocks need failure guards](feedback_ps51_command_blocks.md)** — no `&&`; `;` doesn't stop on failure. Chain dependent steps with `if ($?) { }`. Rule 12 companion.

## Token-efficiency defaults (2026-06-06)

- [Extended thinking OFF by default](feedback_extended_thinking_disabled.md) · [ToolSearch on-demand only](feedback_toolsearch_on_demand.md) · [Skill checks for ambiguous work only](feedback_skill_checks_ambiguous_only.md) · [Recap only on major milestones, with 🎉](feedback_recap_major_milestones_only.md)

---

## User Profile

- [Full profile](user_profile.md) — 14 yrs paid media, all built products. [Admin email = steve@stevekaplan.ai](feedback_admin_email.md) for ALL logins/allowlists.
- [ROAS numbers](reference_proof_roas.md) — 3.2x lifetime AVERAGE; 10:1 sustained; 32:1 peak (never as lifetime).
- [Edit brain/brand files freely](feedback_autonomous_brain_edits.md) · [Keep responses concise](feedback_concise_responses.md)

---

# 🟢 Active Projects

## GTMVP
- [Funnel friction map](gtmvp_funnel_friction_map.md) — quiz COLD / Leak Report WARM / $129 audit (→ $1,500 pending Steve's final word in rebuild). 660 contacts Goji Berry 19887.
- [Canonical repo + paths](gtmvp_repo_canonical_paths.md) — `Projects\gtmvp-saasw\GTMVP_V0` (SEE LANDMINE above). Hero `EditorialMasthead` in `app/(public)/page.tsx`.
- Older shipped detail: [Attribyte handoff](gtmvp_attribyte_integration.md) · [homepage video](gtmvp_homepage_engine_video.md) · [explainer](gtmvp_engine_explainer_video.md) · [solvers](gtmvp_solver_applications.md)

## Attribyte
- [Server LLM path](attribyte_server_llm_path.md) — OpenRouter/Kimi for Atlas, NOT claude -p.
- Hyperbolic/Poincaré engine (`packages/hyperbolic`) is WIRED into Atlas (lattice, hierarchy tool, route) — "3D Attribution" is the public name; method words stay off public pages until provisional files.
- Older threads: [honesty PRs #133-135](attribyte_recovered_honesty_prs.md) · [release-prep](attribyte_release_prep.md) · [GTM connector](attribyte_gtm_connector_and_data_explore.md) · [Signal Ledger rebrand](attribyte_design_system_and_utm_facility.md) · [export/date-range status](attribyte_dashboard_export_daterange_status.md)

## Barfliz (background)
- `C:\Users\User\Projects\bippinbarliz-main` · travisbenoit/bippinbarliz · Supabase `yfucglycufjwmcuadace` · Vite+React+TS. After every ship: bump README version, NEXT→SHIPPED, push main. Migrations idempotent; VAPID keys manual.

## stevekaplan.ai
- [GitHub profile README](github_profile_readme.md) — live, corrected proof numbers.

---

# 📚 Key Feedback & Patterns

- [Fix typos silently](feedback_fix_typos_silently.md) — self-corrections that never reached Steve are noise; real corrections still get said plainly.
- [Ask for screenshots/DevTools when stuck](feedback_ask_for_screenshots_and_devtools.md) · [Never blank dashboards](feedback_never_blank_even_when_live.md) · [HTML mockups before UI commits](feedback_ui_mockups_before_committing.md) · [Stop debugging, just fix](feedback_stop_debugging_just_fix.md) · [Higgsfield Studio gate is BY DESIGN](higgsfield_studio_gate.md)
- [PUBLISHING PREAPPROVED, authorized channels only](feedback_approval_required.md) — review optional, never a gate.
- [NO EM DASHES in ANY public copy](feedback_no_em_dashes.md) — en dashes fine. Sweep before delivering paste-ready copy.
- [Video projects: build all the way through](feedback_video_projects_build_through.md) — no sample-clip gates.
- [Not shipping is always an option](principle_not_shipping_is_an_option.md) — one-way-door test before outward releases.
- [Postiz exclusive, Blotato retired](feedback_postiz_exclusive.md) · [Surface unknown unknowns](feedback_surface_unknown_unknowns.md)
- **Receipts, not wins** (Steve 2026-07-30) — every claim ships with evidence; canonical text in `AGENTHOST-DISTRIBUTION-LOOP.md` + brand-voice Signature moves.

---

# 🗂️ Archived

Dated subdirs: **2026-05/** (zxq, AIMM history, case studies, solvers) · **2026-04/** (Synap pause-era, SAASpocolypse, Competitive Intelligence). Also: [Hermes box migration](hermes-box-migration.md).

## 🔒 SECURITY (2026-07-31)

- **Attribyte API-key scope hole — Atlas surface FIXED + LIVE (#241, cf88b6e), 24 routes STILL OPEN.** `api_keys.scopes` was fetched but never enforced; write-only PUBLIC keys (`ab_pub_`, embedded in the browser SDK, harvestable from any customer page source) could read private analytics/CRM/Atlas data on ~25 routes. Cross-tenant clean; this is public-key priv-esc within a workspace. Fix = `requireApiKeyReadScope` (requires `*:read`; secret/machine-tenant keys pass, public keys 403); applied to Atlas + deployed to Railway prod, smoke-verified (health 200, no-key 401). Box's own Atlas access UNAFFECTED (provisioned keys carry analytics:read). **OPEN, Steve's call: apply the same one-line gate to the other ~24 read routes** (accounts, contacts, opportunities, metrics, attribution, campaigns, forecasts, insights, predictions, reports, …) — hole is live there. Finding: `C:\Users\User\Projects\attribyte\docs\SECURITY-FINDING-2026-07-31-apikey-scopes.md`. Caught by reviewing DEPLOYED code, not a stale local clone.

## 🔧 RESOLVED 2026-08-01 — the 2-day GitHub push blocker

- **gate.js only read the GitHub token from `process.env.GITHUB_TOKEN` (a Fly secret), NEVER from the 🔑 store** (`~/.agenthost/secrets.env`). A token placed via the in-product 🔑 button never reached git ops → every push/ls-remote failed "GitHub token is unavailable" for 2 days while the token sat in the store. Fix (PR #174, on main + deployed prod v295 + staging): `gitHubToken()` falls back to `loadBoxSecrets()` for `GITHUB_TOKEN`/`GH_TOKEN`. PROVEN LIVE — box ls-remote to GitHub authenticated. Done from the LAPTOP (deploy = laptop→Fly via `scripts/deploy-box.sh --app <box>`, so the box's GitHub-unreachability is irrelevant to receiving a fix).
- **Box store lives at `/data/home/agent/.agenthost/secrets.env`** (gate.js `HOME_DIR = /data/home/agent`), NOT root's home — SSH `$HOME` checks look at the wrong place. Verify secrets there.
- **GitHub token goes in the BOX store via the 🔑 button (name `GITHUB_TOKEN`), NOT a laptop `.agenthost` file** — those laptop key files are for the desktop room only. gate.js reads the store per-op, so no restart needed.
- OPEN (Steve's): revoke the 2 old exposed GitHub PATs (box now on the new one); rotate Gemini/Kimi/Cursor keys in a restart.
