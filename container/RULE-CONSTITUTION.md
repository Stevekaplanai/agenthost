# Prod-blocker fix plan + the Rule Constitution (2026-07-24)

> **SCOPE: the AgentHost box only.** This file speaks in the second person and
> cannot tell where it is being read. Before adopting anything in it, verify:
> `test -d /data/home/agent && echo ON-BOX || echo NOT-ON-BOX`. If NOT-ON-BOX,
> this does not describe your environment - see the vault note
> `07_Claude_Brain/INSIDE-VS-OUTSIDE-THE-BOX.md` for the desktop equivalents.

> Born from the red-team NO-GO on the `ca87267` Foundation B activation. Two
> critical defects block the prod flip; both get fixed here with a test that goes
> RED if the fix regresses (per the Rule Constitution below — no theatre). Then
> two governance additions Steve called for: strengths/weaknesses accountability,
> and the rules that write the other rules so they can't break.
>
> Scope note: this is the PLAN (design + acceptance tests). The on-box Claude
> license executes; every change flows through the branch and the
> red-team-before-main pipeline. Nothing here deploys or flips a flag.

---

## PART 1 — The two prod-blocker fixes

### FIX 1 (Defect 1) — a real, wired, in-image `/data` migration so `gate.js` can reach its state

**Plain English:** with the flag on, the backend runs as a new `gate` user, but all
its files belong to the old `agent` user and the two can't read each other's — so
the web login breaks on every reboot, 2FA silently turns off, and the backend
can't read or write its own state. The "migration" that was supposed to fix this
is dormant, unwired, and not even in the shipped image. Build a real one.

**Key design correction — shared access, not ownership transfer.** The interactive
stack (start.sh, as `agent`) AND the backend (gate.js, as `gate`) both need the box
state. Chowning everything to `gate` would just break `agent` instead. The right
primitive is a **shared group**, not moving ownership:

1. **Dockerfile:** create a `boxstate` group; add BOTH `agent` and `gate` to it
   (`usermod -aG boxstate agent gate`). (Fixes the red-team finding that `gate` and
   `agent` share no group.)
2. **A migration step — in the image, wired into the boot, run as root BEFORE
   gate.js starts** (called from `maintenance-boot-entry.js main()` before
   `spawnGate()`, since gate.js computes its cookie secret eagerly at module load,
   `gate.js:1994`). It must:
   - set `group=boxstate`, `g+rw`, and **setgid** on gate.js's state dirs/files
     under the home — enumerate them (the red-team listed the set): `gate.secret`,
     `git-ladder.json`, `board-claims.sqlite`, `usage.json`, `audit.log`,
     `vapid.json`/`push-subs.json`, `2fa.secret`, `secrets.env`,
     `hermes-dashboard.token`, and the `chat-runs`/`runs`/`uploads`/`mail`/
     `artifacts` dirs under `~/.claude/agenthost`;
   - **create missing ones with the shared group**;
   - be **idempotent** (safe every boot) and **chown-in-place** — never relocate a
     pre-existing file (the dormant `safeRelocate` throws on existing files, so it
     cannot be reused as-is);
3. **Reconcile the self-heal.** `entrypoint.sh:59-60` currently forces everything to
   `agent:agent` **owner-only** (`chmod u+rwX`) on every boot — which strips the
   group access. Under the flag it must **preserve `boxstate` group + `g+rw`** on
   the shared state.
4. **Wire + de-lie:** add the migration module to the Dockerfile COPY closure;
   call it before `spawnGate()`. Fix the false comment at `entrypoint.sh:71-72`
   ("migration runs inside the supervisor boot" — it doesn't) and the
   `GATE-ROUTING-SPEC` checklist item that verifies "as the agent child" (wrong
   identity — it's the `gate` child now).

Rollback stays clean: flag off → the self-heal re-chowns to `agent`; the shared
group is harmless when off.

**ACCEPTANCE TEST (goes RED if the fix regresses — this is the anti-theatre proof):**
On a **populated** volume (seed agent-owned `0600` `gate.secret`, board DB,
`2fa.secret`, `secrets.env`), boot flag-on and assert: gate.js as `gate` reads its
**existing** cookie secret (login survives a reboot — same cookie, no forced
re-login), reads/writes the board DB, reads `2fa.secret` (**2FA stays ON**), reads
`secrets.env`; the interactive stack still reads/writes its files; **no EACCES on
any gate state**. This is exactly the surface staging's empty volume could not test.

### FIX 2 (Defect 2) — enforce the jail's env allowlist + network policy at spawn

**Plain English:** the locked-down jail is supposed to hand the agent ONE secret
(its Claude token) and block general internet. The shipped code hands it EVERY
secret on the box and leaves the net wide open. The policy is already written into
the signed contract — it's just enforced nowhere. Wire the enforcement.

**Design:**
1. **Carry the policy through the ADAPT seam.** `toRuntimeProfiles()`
   (`maintenance-boot-entry.js:55-62`) currently drops `envAllowlist`, `credential`,
   `network`, `caps`, and the mount lists — pass them into the runtime profile.
2. **Build a scrubbed child env at spawn.** Thread an `env` param through
   `launchContainedWithWorktree` (`maintenance-containment.js:71-75`) into
   `cp.spawn({ …, env })`. Construct it from the profile's `envAllowlist` + the
   single named `credential` ONLY. (This restores the scrubbing the legacy
   direct-spawn path already did — `gate.js:5339-5340` — that the governed path
   regressed.)
3. **Enforce `network: "inference_only"`.** Add a network namespace (`unshare --net`)
   to the containment so general egress is severed; allow only the inference
   endpoint (minimum: `--net` to cut egress; better: an allowlist to the model API
   host). Today containment makes PID+mount namespaces but **no** net namespace.

**ACCEPTANCE TEST (goes RED if a secret leaks):** spawn a governed worker; assert
its env contains ONLY `{HOME,PATH,TERM,LANG}` + the one `CLAUDE_CODE_OAUTH_TOKEN`,
and **NO** `ANTHROPIC_API_KEY` / GitHub PAT / `ENVF_*` repo secrets — the test fails
if any extra secret is present. Assert general egress is blocked (a request to a
non-inference host fails) while inference works. *This is the test whose absence let
1175 green tests miss the leak.*

**After both fixes:** re-run the red-team; only on a clean verdict does the prod
flip (via the approved GitHub Action) become eligible — still your call, still
gated.

---

## PART 2 — Strengths & weaknesses accountability (Transcendence addition)

> "Take their strengths into accountability and their weaknesses — every LLM has
> them. This is just as much part of transcendence as knowing your lane." (Steve.)

Every engine's trust profile — and its persona card — carries a **candid strengths
AND weaknesses list**. The model then does two things with it:
- **Route to strength.** Work goes to the engine whose strength it is (UX→Vision
  engines; framing→Claude; build→Codex; verify→Hermes).
- **Rail at weakness.** Each known weakness gets a *check*, not blind trust — the
  engine is verified precisely where it's weak. Knowing your lane = operate in your
  strength, be checked where you're weak. A weakness is not a demotion; it's where a
  rail belongs.

Candid, first draft (refine on the box with real behavior data):

| Engine | Strengths | Weaknesses → the rail they earn |
|---|---|---|
| **Claude** | Framing, planning, synthesis, careful review, long-context, instruction-following | Verbosity / over-explaining; over-engineering; **flattery + overconfidence** (surfaces as agreeing or reconstructing too readily) → rail: concision checks, and a *different* engine reviews its claims; never let it self-certify. |
| **Codex** | Implementation, writing/editing code, adversarial red-team | Read-only in chat; can go silent after "on it"; terse/opaque diffs → rail: must deliver the artifact in-reply + name the handoff; results carry raw evidence. |
| **Hermes (box, local GLM-5.2)** | QA/verification, always-on, free | Lower capability ceiling than frontier; **unsandboxed = the security surface** → rail: QA/verify only, never autonomous exec/review (its weakness *is* the exclusion's reason). |
| **Gemini** | **Vision (best, w/ Kimi)**, free 24/7, second-look | No jailed profile yet; API-wrapper default alignment; can be inconsistent → rail: Vision/UX + gate-validated bounded actions now; full jail before code-write. |
| **Kimi** | **Vision**, UX | Chat-only, least-integrated, disabled by default → rail: UX/Vision + Board-Runner target; earns the ladder like the others. |

This feeds the persona card's **Strengths** field directly, and gives the routing +
rails a principled basis instead of a flat allow/deny.

---

> **Above this Constitution sit the operator's own Cardinal Rules**
> (`OPERATOR-CARDINAL-RULES.md`). R0–R6 below govern how *agent* rules are
> written; the Cardinal Rules govern how the operator governs the work, and win on
> any conflict (that is Constitution R1 / Cardinal Rule 0).

## PART 3 — The Rule Constitution (the rules that write the rules)

> Steve's rules, born from today: "tons of rules written but it was all theatre and
> an awful lot of overriding my requests." These are the meta-rules every future
> rule/safeguard must pass. They graduate into the charter once blessed. **A rule
> that fails the Constitution does not ship — including a rule in this document.**

**PRIME DIRECTIVE — a guardrail must make an agent MORE competent, not less.**
A guardrail is judged by the competence of the agent operating under it. One that
*manufactures incompetence* — a capable agent that presents as weak because the
rules hobbled it or muddled its own self-model — is as much a defect as one that
lets harm through. Governance that degrades the team it governs has failed, however
safe it looks. Every rule below (R0–R6) exists to serve this directive.
*(Steve's thesis, 2026-07-24: "incapability is incompetence sometimes… if guardrails
are poorly constructed they create incompetence in agents." Evidence: the box's ONLY
real code-writer introduces itself in chat as a read-only helper that "hands writes
to Claude or Hermes" — engines that can't do autonomous writes at all. The rules
didn't just restrict Codex; they gave it a false, diminished identity. That is
manufactured incompetence, and it is a bug of the same severity as an unenforced
rail.)*

**R0 — Enforcement or it doesn't exist (no theatre).** Every rule names three things:
the constraint, the single place that *enforces* it, and a test that goes **RED**
when the constraint is bypassed. Missing any of the three ⇒ theatre ⇒ wire it or
delete it. *(Evidence: Defect 2 — the jail's secret allowlist was frozen into the
signed contract but enforced nowhere, and no test would have caught the leak.)*

**R1 — The operator is never silently overridden.** A rule may refuse, but it must
**say so and why**, in plain language. It may never quietly do something other than
what the operator asked, and rules may never *accumulate* into a "no" the operator
didn't choose. On any conflict between a rule and an operator request, **surface the
conflict** — never resolve it silently against the operator. *(Evidence: "an awful
lot of overriding my requests"; the Gemini exclusion that added up to a permanent no
nobody explicitly chose.)*

**R2 — One rule per intent (no overlap).** A constraint lives in exactly ONE enforced
place. If two rules guard the same thing, merge or delete — overlap is where theatre
hides and where "too many safeguards" is born. *(Evidence: Gemini excluded in three
arrays + prose; four separate readiness gates guarding one "safe to write.")*

**R3 — Every "no" names its "yes."** No permanent restriction without the condition
that lifts it. A rule that only subtracts capability and never has an exit is a
handcuff — attach the unlock or cut it. *(Evidence: "Gemini is not yet…" with no
defined path.)*

**R4 — Load-bearing or gone.** Every rule traces to a specific failure it prevents,
stated in one sentence. If you can't name the failure, it's clutter — remove it.
*(Evidence: accreted overlapping gates no one could justify individually.)*

**R5 — Fail closed on consequences, fail open on capability.** Ambiguity blocks the
**irreversible / outward-facing** (deploy, spend, send, delete, credential).
Ambiguity must **not** block reversible capability — that's how you get
read-only-forever agents. The default protects the operator from *harm*, never from
*usefulness*. *(Evidence: the over-restriction that made "3 idiots with no rights";
this reconciles fail-closed security with the capability floor.)*

**R6 — The set must be checkable as a whole (the rule that keeps the rules from
breaking).** Before a rule ships, test it against the existing set for: **contradiction**
(two rules that can't both hold), **unreachability** (a rule some other rule makes
impossible to satisfy — the trap), and **theatre** (fails R0). A rule that breaks the
set doesn't ship. *(Evidence: today's rule pile was internally inconsistent — code
declared Gemini "more capable" while three arrays said no; constraints were declared
but unenforced. R6 is the self-check that catches exactly that.)*

**How R6 is actually run (not theatre itself):** the charter/settings rules become a
checkable list — a small test/lint that, for each rule, requires an enforcement
pointer + a red-test (R0), flags any capability declared in one place and denied in
another (R2/R6 contradiction), and flags any restriction with no exit condition
(R3). The Constitution is enforced by the same standard it imposes.

---

*Everything here is subordinate to the charter and the rights ladder. No fix or
rule weakens a real rail, the human-gate on the irreversible, or the master STOP —
Part 3 exists to make sure every rail is **real** rather than declared, and that no
stack of rails ever quietly overrides the operator or traps an agent.*
