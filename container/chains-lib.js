// V2 autonomous handoff -- the CHAIN GUARDS. Pure, dependency-free, unit-tested
// logic that decides whether an autonomous task is allowed to run. gate.js's
// orchestrator (boardTick) calls these; keeping them here (like cron-lib.js)
// makes the safety core testable in isolation.
//
// A "chain" groups a task and its autonomous descendants under one chain_id.
// The guards enforce hard ceilings so an autonomous chain can never loop
// forever, overspend, or ping-pong between engines.
//
// SIZING (Steve, 2026-07-19): the original V2 numbers (6 runs / 45 min / 150K
// tokens / $5) were sized for TINY tasks and choked real work -- one substantial
// Claude turn (read the brief + charter + repo context, draft/review) uses ~260K
// tokens ALONE, so the 150K chain budget was blown on turn 1 and every task got
// blocked ("budget_exhausted:tokens", 4+ times). Raised to fit REAL work: a full
// draft -> independent review -> correction cycle (~3-4 substantial turns) now
// completes without hitting a wall. Still bounded on every axis -- a runaway
// chain still stops; it just has room to finish a real job first.
"use strict";

const MAX_REJECT_CYCLES = 2; // a rejected task may be re-run at most twice before it's blocked
const LIMITS = {
  maxExecs: 10,              // total agent runs per chain (was 6): a draft + up to
                             // 2 corrections, each independently reviewed, needs >6.
  maxLifetimeMs: 90 * 60 * 1000, // 90 min (was 45): real multi-turn work with
                             // reviews needs the wall-clock; run-count is the tighter stop.
  maxTokens: 1200000,        // input+output combined, whole chain (was 150K): fits
                             // ~4-5 real ~260K turns -- a full cycle plus headroom.
  maxCostUsd: 15,            // $ (was $5): the real runaway guard for any METERED
                             // engine; ~4-5 substantial turns. (Claude is subscription,
                             // so this mostly backstops a metered fallback.)
  maxConsecutiveSamePair: 2, // A->B->A->B is fine; a 3rd hop of the same pair is not
  maxHandoffs: 10,           // total handoffs per chain, ANY pattern (was 6, raised
                             // to match maxExecs) -- the backstop for multi-node
                             // cycles (A->B->C->A...) that a pair limit and
                             // objective-hash miss (Hermes red-team #2).
  softStopFraction: 0.8,     // at 80% of any budget: no new children, synthesize
};

// A fresh chain record. `seenHashes` catches repeated objectives (loop guard);
// `hops` is the ordered list of "from->to" engine handoffs for the same-pair check.
function newChain(nowMs) {
  return { execs: 0, tokens: 0, costUsd: 0, startedAt: nowMs, seenHashes: [], hops: [] };
}

// Normalize a task objective for loop-detection hashing: lowercase, collapse
// whitespace, strip trailing punctuation. Same objective + same assignee twice
// in a chain = a loop. Dependency-free FNV-1a hash (no crypto import needed).
function normObjective(text) {
  return String(text || "").toLowerCase().replace(/\s+/g, " ").replace(/[.!?;:,]+$/g, "").trim();
}
function hashObjective(text, assignee) {
  const s = normObjective(text) + "" + String(assignee || "");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16);
}

// Live-configurable $ cap (Phase 1 settings backbone). gate.js feeds the
// operator's setting in at boot and on every change; enforced=false turns the
// $ axis into observe-only (the GATE audits the bypass -- costBypassed below
// is how it knows). This module stays pure: it never reads files; the gate is
// the only writer. Out-of-range values are ignored, so a bad setting can never
// zero the cap. The run/time/token structural axes are deliberately NOT
// configurable here.
let costEnforced = true;
function configureCost(opts) {
  const cap = opts && Number(opts.capUsd);
  if (Number.isFinite(cap) && cap >= 1 && cap <= 100) LIMITS.maxCostUsd = cap;
  if (opts && typeof opts.enforced === "boolean") costEnforced = opts.enforced;
}
function costBypassed(chain) {
  return !costEnforced && Boolean(chain) && chain.costUsd >= LIMITS.maxCostUsd;
}

// Which budget dimensions are at/over a fraction (default 1.0 = exhausted).
// Returns the list of breached dimension names ([] = all clear).
function breaches(chain, nowMs, fraction) {
  const f = fraction == null ? 1 : fraction;
  const out = [];
  if (chain.execs >= LIMITS.maxExecs * f) out.push("executions");
  // Lifetime measures autonomous ACTIVITY, not queue time. A chain that has
  // never executed has spent none of its 45 minutes -- without the execs>0
  // guard, a human-created card that merely SAT on the board >45min became
  // permanently "budget_exhausted:lifetime" and could never start (live
  // incident 2026-07-18: boardTick re-blocked the same ready codex card every
  // 30s forever). recordRun() re-stamps startedAt on the FIRST exec, so once a
  // chain starts running the 45-minute window is real and unchanged.
  if (chain.execs > 0 && nowMs - chain.startedAt >= LIMITS.maxLifetimeMs * f) out.push("lifetime");
  if (chain.tokens >= LIMITS.maxTokens * f) out.push("tokens");
  if (costEnforced && chain.costUsd >= LIMITS.maxCostUsd * f) out.push("cost");
  return out;
}

// The core gate: may this chain run ONE MORE task, assigned to `assignee`, whose
// objective is `objective`, handed off from `fromEngine` (null for a root task)?
// Returns { ok, reason } -- reason is set only when ok is false. Never throws.
function canRun(chain, { assignee, objective, fromEngine }, nowMs) {
  if (!chain) return { ok: true }; // no chain tracking -> not autonomous, allow
  const hard = breaches(chain, nowMs, 1);
  if (hard.length) return { ok: false, reason: "budget_exhausted:" + hard.join(",") };
  // Loop guard: this exact objective+assignee already ran in the chain.
  const hash = hashObjective(objective, assignee);
  if (chain.seenHashes.includes(hash)) return { ok: false, reason: "loop_detected" };
  // Total-handoffs backstop: catches multi-node cycles (A->B->C->A->B->C) that
  // slip past the same-pair check and objective-hash rephrasing (Hermes #2).
  if (fromEngine && chain.hops.length >= LIMITS.maxHandoffs) {
    return { ok: false, reason: "handoff_cap" };
  }
  // Same-pair ping-pong guard: count trailing hops that are the same from->to pair.
  if (fromEngine) {
    const pair = fromEngine + ">" + assignee;
    let trailing = 0;
    for (let i = chain.hops.length - 1; i >= 0 && chain.hops[i] === pair; i--) trailing++;
    if (trailing >= LIMITS.maxConsecutiveSamePair) return { ok: false, reason: "handoff_pingpong" };
  }
  return { ok: true };
}

// Are we in the SOFT zone (>=80% of any budget)? The orchestrator uses this to
// tell the running agent "no new children, wrap up and synthesize."
function inSoftZone(chain, nowMs) {
  return chain ? breaches(chain, nowMs, LIMITS.softStopFraction).length > 0 : false;
}

// Record that a task ran: bump execs, remember its objective hash + the handoff.
// Called AFTER canRun passes and the task is dispatched. On the FIRST exec the
// lifetime clock is re-stamped to now: startedAt was set at chain CREATION,
// which for a human-created card can be long before anything runs -- the 45-min
// window must measure the chain's actual activity (see breaches()).
function recordRun(chain, { assignee, objective, fromEngine }, nowMs) {
  if (!chain) return chain;
  if (chain.execs === 0) chain.startedAt = nowMs == null ? Date.now() : nowMs;
  chain.execs += 1;
  const hash = hashObjective(objective, assignee);
  if (!chain.seenHashes.includes(hash)) chain.seenHashes.push(hash);
  if (fromEngine) chain.hops.push(fromEngine + ">" + assignee);
  return chain;
}

// Add a finished run's token/cost usage to the chain totals.
function recordChainUsage(chain, usage) {
  if (!chain || !usage) return chain;
  chain.tokens += (usage.inputTokens || 0) + (usage.outputTokens || 0);
  if (Number.isFinite(usage.costUsd)) chain.costUsd += usage.costUsd;
  return chain;
}

// Capability gate: is this task's action HUMAN-GATED (must wait for operator
// approval, never auto-run)? This is the ONLY code-level action gate on the
// autonomous dispatch path, so it FAILS CLOSED: a task auto-runs ONLY if its
// title reads as clearly read-only/analysis/draft work; ANYTHING else gates.
//
// Why closed, not open: the previous open version (gate only on a keyword
// blocklist) let "ship the release", "roll out to prod", "email the client",
// "push the branch", "make a payment" all auto-run because they matched no
// literal in the list (safety review, 2026-07-18). A blocklist can never be
// complete; an allowlist of safe verbs can. So the default is GATED.
//
// SAFE = the title's leading action verb is one of a small, audited set of
// verbs that do not mutate the outside world or take irreversible/outbound
// action. Draft/write/summarize/plan produce artifacts a human still ships.
// Everything else -- ship, release, push, deploy, merge, delete, remove, send,
// email, post, pay, charge, run, execute, install, restart, migrate, and every
// verb not on the safe list -- is gated.
const SAFE_VERBS = [
  "read", "review", "analyze", "analyse", "audit", "assess", "evaluate", "examine",
  "investigate", "research", "search", "find", "look", "check", "inspect", "trace",
  "summarize", "summarise", "explain", "describe", "compare", "list", "identify",
  "draft", "write", "outline", "plan", "propose", "suggest", "recommend", "brainstorm",
  "sketch", "document", "note", "map", "diagnose", "estimate", "calculate", "compute",
  // "define" (added 2026-07-18): pure framing/analysis -- same class as outline/
  // plan/identify. A live board card ("Define research scope and key questions")
  // was gated only by this verb missing from the audited set.
  "define",
  // "verify"/"validate" (added 2026-07-18): pure verification -- same class as
  // check/review/audit. A live card ("Verify AI trends list is accurate...")
  // was gated only by the verb. The keyword belt still gates any risky body.
  "verify", "validate",
  // "red-team"/"redteam" (added 2026-07-19): adversarial ANALYSIS -- read the
  // artifact, try to break it, report findings. Same read-only class as
  // audit/review. A live card ("Red-team the revised Dev Mode ARD...") sat
  // `ready` forever because the verb was missing -- the exact "why didn't it
  // get picked up" Steve hit. Hyphen/space/joined variants + the keyword belt
  // (which still gates a red-team task whose BODY says deploy/delete/send).
  "red-team", "red team", "redteam",
  // "create"/"generate" (added 2026-07-20): content/file authoring -- same
  // class as write/draft. A live card ("Create dev-mode/stories/E1-S2.md from
  // the drafted non-c...", t_39b2061f) gated twice on the missing verb alone
  // and stalled the Modes epic. The keyword belt still gates any risky body
  // (deploy/delete/pay/send/token...), so authoring-verb leads stay bounded.
  "create", "generate",
  // BUILD VERBS (added 2026-07-26, Steve explicit). Until now SAFE_VERBS held
  // only read-and-write-ABOUT verbs (read/review/analyze/draft/plan/create), so
  // every card that meant CHANGE THE CODE failed closed -- "Implement Pool-Based
  // Routing Logic" sat `ready` forever and Codex looked broken. Steve: "I
  // wanted them to be able to write code and do the things according to the
  // settings that we already have setup."
  //
  // The four verbs before these (define/verify/red-team/create) were each added
  // reactively AFTER a live card stalled on exactly this. Adding the build class
  // as a set, rather than one verb per incident, is the point.
  //
  // Deliberately NOT added -- already in HARD_GATED_RE, so listing them here
  // would be a contradiction that reads as permission: migrate, wire, remove.
  // The belt still hard-gates deploy/delete/spend/send/secrets/shell from the
  // title OR body, so "Implement X and deploy it" still waits for the operator.
  "implement", "build", "fix", "refactor", "add", "update", "change",
  "modify", "rename", "refresh", "extend", "improve", "complete", "finish",
  // REVISION + SETUP verbs, same pass. "Adapt Day 8 showreel copy for X and
  // LinkedIn" -- a pure copywriting card -- gated on `adapt` alone. Rather than
  // add one verb per stalled card (the pattern that produced define/verify/
  // red-team/create as four separate incidents), take the whole class: reworking
  // existing content or config is no more dangerous than writing it fresh, and
  // every one of these was checked against HARD_GATED_RE before landing here.
  "adapt", "adjust", "tune", "polish", "revise", "rework", "edit", "reword",
  "repurpose", "port", "convert", "translate", "format", "clean", "tidy",
  "simplify", "optimize", "optimise", "test", "cover", "stub", "scaffold",
  "prototype", "setup", "configure",
  // Verbs from live board tasks that gated on the missing verb alone:
  "enforce",  // "Mesh: enforce causal-chain continuity"
  "sweep",    // "Competitive sweep — AgentHost"
];
// Match the LONGEST verb first so "red team" isn't shadowed by a shorter prefix.
// Titles that lead with a priority/tag prefix ("P0:", "PWA S2:", "Mesh:",
// "Desktop shell:", "Competitive sweep") never reach the safe verb.
// Strip an optional leading tag (word(s) + colon OR dash/em-dash) before
// matching the safe verb, so "P0: Fix board CLI..." passes like "Fix...".
const SAFE_LEAD_RE = new RegExp("^\\s*(?:please\\s+|can you\\s+|go\\s+)?(?:(?:[A-Za-z0-9]+(?:\\s+[A-Za-z0-9]+)?(?:\\s+[A-Za-z0-9]+)?(?:\\s+[A-Za-z0-9]+)?[:\\-—–]\\s*))?(" +
  SAFE_VERBS.slice().sort((a, b) => b.length - a.length).join("|") + ")\\b", "i");
// Hard-gate keywords: even if a title happens to start with a safe verb, any of
// these anywhere in title+body forces a gate (e.g. "Review and then deploy ...",
// "Draft, then email the client ..."). Belt to the allowlist's suspenders.
// rm/rmdir/mkfs/dd/kill/pkill/npx/vercel/flyctl/"environment variables" added
// 2026-08-09, when the wording allowlist stopped gating the board path. None of
// them were in ANY of the four denylists; the allowlist was covering them BY
// ACCIDENT, because "Tidy up" and "npx vercel --prod" have no recognised safe
// verb and so gated on phrasing rather than on danger. Remove that cover and:
//
//   "Tidy up" / "rm -rf the old worktrees"   -> null
//   "npx vercel --prod"                      -> null
//   "Print the environment variables"        -> null   (HARD_GATED_RE had "env "
//     with a trailing space, which does not match "environment"; NON_SOCIAL_GATED_RE
//     already had "environment variables?" -- the two lists disagreed)
//
// Found by running the removal, not by reasoning about it. Added to all four
// lists because they are the same danger vocabulary in different contexts, and
// divergent copies are their own bug class. These can only ADD a gate.
const GATED_KEYWORDS_RE = /\b(deploy|ship|release|roll ?out|rollout|launch|publish|push|force[- ]?push|merge|rebase|revert|reset|delete|remove|destroy|drop|wipe|purge|truncate|uninstall|tear ?down|teardown|sunset|decommission|send|email|e-mail|dm|message|reply|respond|notify|post|tweet|broadcast|blast|text|call|escalate|pay|payment|charge|refund|wire|transfer|purchase|buy|invoice|subscribe|deposit|withdraw|install|provision|restart|reboot|migrate|seed|apply|execute|run|exec|sudo|rm|rmdir|mkfs|dd|kill|pkill|npx|vercel|flyctl|environment variables?|chmod|chown|curl|wget|ssh|scp|token|secret|credential|password|api[- ]?key|env |\.env)\b/i;

// ---- Two-tier gating (Steve, 2026-07-18) ------------------------------------
// The board wedged because every "Draft ..." card's BODY happened to contain a
// gated word in innocent, descriptive context ("the TEXT of the post", "a test
// RUN", "mentions the DEPLOY"). Scanning the whole body for command-keywords
// gates almost all real drafting work -- the body is where agents write context,
// not commands. Fix: split the keyword set by blast radius.
//
//   HARD  = truly irreversible / high-consequence. Gated if it appears ANYWHERE
//           (title OR body) -- a laundering attempt ("Draft the plan" title,
//           "delete the prod DB" body) STILL gates. Never relaxed.
//   SOFT  = dangerous as a VERB but common as a NOUN/adjective in descriptive
//           copy (text/message/call/run/post/send/email/reply/notify/publish...).
//           These gate only from the TITLE (the human's actual intent), not from
//           an innocent body mention.
// So "Draft the ARD answers (the text describes a deploy step)" -> the body's
// "text"/"deploy"... wait: deploy is HARD, so that STILL gates. Good -- only the
// SOFT words stop gating from the body. "Send the email" as a TITLE still gates
// (send+email are soft-in-title). "delete"/"deploy"/"pay"/"ssh" anywhere gates.
// HARD includes the genuinely-dangerous comms verbs (send/email/dm) -- emailing
// or DMing AS Steve is high-consequence even when buried in a body, so those
// gate from anywhere. SOFT keeps only words that are overwhelmingly innocent
// nouns/adjectives in descriptive bodies (the "text" of a post, a test "run",
// a "message"-passing description, "call to action", "notify"), which gate only
// when they lead the TITLE.
const HARD_GATED_RE = /\b(deploy|ship|release|roll ?out|rollout|launch|push|force[- ]?push|merge|rebase|revert|reset|delete|remove|destroy|drop|wipe|purge|truncate|uninstall|tear ?down|teardown|sunset|decommission|send|email|e-mail|dm|escalate|pay|payment|charge|refund|wire|transfer|purchase|buy|invoice|subscribe|deposit|withdraw|install|provision|restart|reboot|migrat(?:e|es|ed|ing|ion|ions)|seed|sudo|rm|rmdir|mkfs|dd|kill|pkill|npx|vercel|flyctl|environment variables?|chmod|chown|curl|wget|ssh|scp|tokens?|secrets?|credentials?|passwords?|env |\.env|dotenv)\b/i;
// A gate-created Git proposal is the one narrow exception to the generic
// text gate: its Git actions come from the structured proposal record, never
// from words in the card. Keep every non-Git consequence in the hard gate.
const STRUCTURED_GIT_HARD_GATED_RE = /\b(deploy|ship|release|roll ?out|rollout|launch|rebase|revert|reset|delete|remove|destroy|drop|wipe|purge|truncate|uninstall|tear ?down|teardown|sunset|decommission|send|email|e-mail|dm|escalate|pay|payment|charge|refund|wire|transfer|purchase|buy|invoice|subscribe|deposit|withdraw|install|provision|restart|reboot|migrat(?:e|es|ed|ing|ion|ions)|seed|sudo|rm|rmdir|mkfs|dd|kill|pkill|npx|vercel|flyctl|environment variables?|chmod|chown|curl|wget|ssh|scp|tokens?|secrets?|credentials?|passwords?|env |\.env|dotenv)\b/i;
// Secret NAMES gate even mid-token (POSTIZ_API_KEY, MY_SECRET_TOKEN, $API_KEY):
// a word-boundary regex misses them (underscore isn't a boundary), so match the
// key-like suffix anywhere. This is the exfil belt -- kept separate + permissive.
const SECRET_NAME_RE = /(api[_\- ]?keys?|secret[_\- ]?keys?|access[_\- ]?tokens?|[_\-$]tokens?\b|[_\-$]secrets?\b|[_\-$]passwords?\b|private[_\- ]?keys?|id_rsa|\.pem)/i;
// Of the soft words, execute/run/exec name CODE activity. In the autonomous
// jail they remain paused by default, but an operator may review the exact task
// and allow one run. The others name outward communication/publishing and stay
// consequence-gated even under a manual wording override.
// A FILENAME IS NOT A VERB. `\brun\b` matched the "run" inside `run-ledger.js`
// -- a hyphen is a word boundary -- so "Review the changes to run-ledger.js" was
// wording-gated. SOFT_CODE_RE returns "wording" UNCONDITIONALLY, before the
// classifierFollows check, so the engine never got to look at it and the card sat
// `ready` with no way out. Live on 2026-08-10: a real review card stalled on
// exactly this, and the same trap covers run-qa.sh, run-*.mjs, and any future file
// whose name begins with a soft verb.
//
// The lookarounds require the verb to stand alone: not preceded by a word char,
// dot or hyphen, and not followed by one. "run the migration" still gates;
// "run-ledger.js", "scripts/run-qa.sh" and "test-run" do not.
// The lookahead is `[-.]?\w`, not `[-.\w]`, and the difference is a regression
// Kimi caught (MEDIUM, #333): excluding a bare `.` meant "Please run." and
// "execute." -- imperatives ending a sentence -- stopped gating entirely. Only a
// dot or hyphen that CONTINUES into a word is part of a filename.
const SOFT_CODE_RE = /(?<![\w.-])(execute|run|exec)(?![-.]?\w)/i;
const SOFT_OUTWARD_RE = /\b(message|reply|respond|notify|post|tweet|broadcast|blast|text|call|publish)\b/i;

// ---- Social-posting exception (Steve, 2026-07-18; hardened after red-team) --
// Goal: the box can publish/schedule social content unattended when Steve is
// away (its whole reason to exist as a bridge), WITHOUT opening the gate on
// anything genuinely dangerous.
//
// DESIGN (learned the hard way -- a first cut hand-picked a "destructive subset"
// and a red-team found 10 dangerous bypasses: it had dropped run/exec/email/
// push/subscribe/migration/credentials-plural, so an injected "post" task could
// run shell, email as Steve, or exfil .env to LinkedIn). The correct model is
// INVERTED: keep the ENTIRE gated keyword set hard-blocking, and neutralize ONLY
// a tiny, explicit allowlist of pure content/CTA words (the words that just mean
// "put content out on social" or appear in normal marketing copy). Everything
// not on that allowlist -- every deploy/destroy/money/comms-send/shell/secret
// token -- still gates inside a social task.
//
//   SOCIAL_ALLOW_RE = the ONLY tokens neutralized for a social task:
//     publishing verbs: post/publish/tweet/broadcast/blast/share/schedule/queue/
//                       launch/ship/release/announce
//     safe CTA words:   dm/message/reply/respond/text/call/comment/thread/caption
//   NON_SOCIAL_GATED_RE = the full gated set MINUS those, PLUS broadened
//     exfil/infra coverage (plurals: credentials?/tokens?/secrets?/passwords?;
//     migrat(e|ion|ing); dotenv/env var; api[-_ ]key for underscore forms).
//
// So: "Schedule the 30 posts to Postiz" auto-runs; "Post to X and run the deploy"
// gates (run+deploy); "Publish my .env to LinkedIn" gates (.env); "Post to X and
// email every subscriber" gates (email+subscribe); "Queue the migration" gates
// (migration). "Book a call / DM me / comment AGENT" copy still posts (CTA words
// neutralized). Off-brand posts are recoverable; the irreversible stays walled.
//
// Residual (stated honestly, mitigated not eliminated): bare secret-synonym
// nouns like "environment"/"config" aren't lexically gated (over-gating legit
// content-about-environments); the redactSecrets output layer + charter Rule 6
// are the backstop for actual secret VALUES. Channel scoping (post only to the
// two approved accounts) is an instruction-level control in the charter + the
// task's baked integration IDs, not lexical. No per-task post-rate cap; chain
// budgets (6 runs / 45 min / 150K / $5) bound runaway volume.
const NON_SOCIAL_GATED_RE = /\b(deploy|roll ?out|rollout|push|force[- ]?push|merge|rebase|revert|reset|delete|remove|destroy|drop|wipe|purge|truncate|uninstall|tear ?down|teardown|sunset|decommission|send|email|e-mail|notify|escalate|pay|payment|charge|refund|wire|transfer|purchase|buy|invoice|subscribe|deposit|withdraw|install|provision|restart|reboot|migrat(?:e|es|ed|ing|ion|ions)|seed|apply|execute|run|exec|sudo|rm|rmdir|mkfs|dd|kill|pkill|npx|vercel|flyctl|environment variables?|chmod|chown|curl|wget|ssh|scp|tokens?|secrets?|credentials?|passwords?|api[-_ ]?keys?|env |\.env|dotenv|environment variables?|env vars?|private keys?|keychain|id_rsa|\.pem)\b/i;
// Posting intent (what a social task DOES) + social context (WHERE it goes).
// Both must be present, so a generic "publish the report" doesn't qualify.
const POSTING_VERB_RE = /\b(post|posts|posting|publish|publishing|schedule|scheduled|scheduling|queue|queued|tweet|tweeting|broadcast|blast|share|shares|sharing|launch|announce|social)\b/i;
// Social CONTEXT: a platform/destination signal. "X" is disambiguated to real
// signals (to/on X, x.com, tweet) so a stray bare "x" can't make an arbitrary
// task look social. Each alternative carries its own word boundaries.
const SOCIAL_CONTEXT_RE = /(\bpostiz\b|\bsocial media\b|\bsocial post|\bon social\b|\bto social\b|\blinkedin\b|\btwitter\b|\bto x\b|\bon x\b|\bx\.com\b|\btweet|\bcontent calendar\b|\binstagram\b|\btiktok\b|\byoutube\b|\bfacebook\b|\bthreads\b|\bmastodon\b|\bbluesky\b|\bpinterest\b|\bcaption|\bthe feed\b|\bnews feed\b)/i;
// A social task may LEAD with a posting verb (Publish/Schedule/Post/Launch...) --
// inside the social branch that counts as the safe lead. Separate from
// SAFE_VERBS so these verbs never relax the general (non-social) gate.
const SOCIAL_LEAD_RE = /^\s*(?:please\s+|can you\s+|go\s+)?(post|publish|schedule|queue|tweet|share|broadcast|blast|announce|launch|draft|write|prepare|stage)\b/i;
function isSocialPostingTask(hay) {
  return POSTING_VERB_RE.test(hay) && SOCIAL_CONTEXT_RE.test(hay);
}

function humanGateReason(task, policy) {
  const title = String((task && task.title) || "");
  // A FILE IS NOT A VERB. Neutralise file-shaped tokens ONCE, here, before any
  // gate regex runs. (FILENAMES-TRIP-THE-HARD-GATES, 2026-08-10.)
  //
  // #333 fixed SOFT_CODE_RE reading the "run" inside `run-ledger.js` as the verb
  // *run*. That was one regex; the same trap is in at least three others, and
  // one of them is HARD:
  //
  //   Review the send-report.mjs changes  -> HARD_GATED_RE matches "send"
  //   Review the post-mortem.sh output    -> SOFT_OUTWARD_RE matches "post"
  //   Review the reply-all.js handler     -> matches "reply"
  //
  // The send-report case is the serious one: HARD_GATED_RE bypasses the engine
  // classifier entirely, so a card that merely MENTIONS such a file gets
  // `consequence`, needs an operator override, and cannot be talked out of it --
  // the dead end #326 removed for `apply`. Reviewing a file is not sending
  // anything, and the gate could not tell a filename from an imperative.
  //
  // Done here rather than by adding lookarounds to each alternation, which would
  // mean hand-editing four long security-critical regexes -- the place a mistake
  // is least recoverable and least visible.
  //
  // ONLY the filename token is replaced, never the verb beside it. So
  // "Send config.json to the client" still reads "send ... to the client" and
  // still hard-gates; only a verb trapped INSIDE a filename stops counting.
  const FILE_TOKEN_RE = /\b[\w-]+\.(?:js|mjs|cjs|ts|tsx|jsx|sh|bash|py|rb|go|rs|json|md|ya?ml|toml|txt|css|html?)\b/gi;
  // Replace once per field and reuse. The first version neutralised `title`
  // separately and then again inside `hay`, running the same regex over the same
  // text twice -- harmless but duplicated, and duplication is where two copies
  // later disagree. (Kimi K3, LOW, #334.)
  // A NOUN IS NOT A VERB EITHER. Same trap as the filename one above, one step
  // out: these regexes were written for imperative card titles and are also fed
  // ordinary English prose, where the same words are nouns.
  //
  // Measured 2026-08-12 by running THIS function over the box's real scheduled
  // Loops. Both classified as `consequence`, and both are strictly read-only:
  //
  //   "Skip anything already reported in the previous RUN."   -> SOFT_CODE_RE
  //   "For each group give ... the actual error TEXT."        -> SOFT_OUTWARD_RE
  //
  // "the previous run" is the last execution of this job, not an instruction to
  // run something. "error text" is words in a log, not texting a human. The
  // possessive defeats SOFT_CODE_RE's lookahead specifically: `run's` leaves
  // `run` followed by an apostrophe, which is not `[-.]?\w`, so the guard that
  // stops `run-ledger` does not stop `run's`.
  //
  // Neutralised HERE, once, before any gate regex runs -- deliberately the same
  // seam and the same discipline as FILE_TOKEN_RE, rather than adding lookarounds
  // to four long security-critical alternations.
  //
  // NARROW ON PURPOSE. Only these exact noun senses are neutralised:
  //   - `run`/`runs` carrying a possessive ("the run's result")
  //   - `text` immediately preceded by a word that makes it a noun
  // Every imperative survives untouched: "run the migration" still gates, "text
  // the client" still gates, and a bare "text" with no qualifier still gates.
  const NOUN_RUN_RE = /\b(runs?)('s|s')/gi;
  // `run` after a determiner is the NOUN "an execution": "the previous run",
  // "each run", "this run". An imperative never reads that way -- "run the
  // migration" has no determiner in front of the verb -- so this cannot swallow
  // one. Added after the possessive-only version left "the previous run" gating.
  const NOUN_RUN_DET_RE = /\b(the|a|an|each|this|that|these|those|every|previous|last|next|first|prior|latest|current|failed|successful|scheduled)(\s+)(runs?)\b/gi;
  const NOUN_TEXT_RE = /\b(error|result|log|output|body|prompt|source|raw|plain|title|label|commit|diff|help|alt)(\s+)text\b/gi;
  const denounce = (s) => String(s)
    .replace(NOUN_RUN_RE, "$1 ")
    .replace(NOUN_RUN_DET_RE, "$1$2execution")
    .replace(NOUN_TEXT_RE, "$1$2content");
  const titleNoFiles = denounce(title.replace(FILE_TOKEN_RE, " file "));
  const bodyNoFiles = denounce(String((task && task.body) || "").replace(FILE_TOKEN_RE, " file "));
  const hay = (titleNoFiles + " " + bodyNoFiles).toLowerCase();
  const structuredGitLadder = Boolean(policy && policy.structuredGitLadder === true);
  // classifierFollows: the caller runs the engine-based consequence classifier
  // after this gate, so the default-path WORDING allowlist is skipped for them.
  //
  // The RELAXATION is opt-in per caller (you must pass classifierFollows to get it);
  // equivalently, the allowlist is opt-OUT. Both phrasings appear in the PR that
  // introduced this and Kimi flagged the contradiction -- so, unambiguously: the
  // SAFE DEFAULT IS TO GATE. A caller that passes nothing keeps failing closed on
  // unknown phrasing. Only a caller that explicitly declares a classifier follows
  // it gives that up. That distinction is the
  // whole point. P0-WORD-LIST-STILL-GATES asked for the line to be removed
  // because a "wording" gate drops a card from the eligible filter BEFORE the
  // classifier ever sees it -- true, and only true of the BOARD path.
  // container/gate.js:7780, the Multi-Loop stage runner, calls isHumanGated
  // directly and never reaches boardTick or the classifier. Deleting the line
  // would have silently widened Multi-Loop autonomy: a stage with an
  // unrecognised verb goes from "gated" to "runs unattended", with nothing
  // downstream to judge it.
  //
  // So the board opts out (the classifier judges consequence there, which is
  // the actual Rule 13 test), and every other caller keeps failing closed on
  // unknown phrasing until a classifier covers them too.
  const classifierFollows = Boolean(policy && policy.classifierFollows === true);
  // Social-posting exception FIRST: a genuine social-publishing task may run
  // unattended -- but ONLY if it carries NO non-social gated keyword. The full
  // gated set (minus the pure content/CTA allowlist baked into NON_SOCIAL_GATED)
  // still hard-blocks, so a "post" card can never launder a deploy/delete/email/
  // shell/secret past the gate. A posting verb in the LEAD counts as the safe
  // lead (Steve wants "Schedule the Postiz queue" to just run).
  if (!structuredGitLadder && isSocialPostingTask(hay)) {
    if (NON_SOCIAL_GATED_RE.test(hay)) return "consequence"; // any non-content danger -> gate
    if (SECRET_NAME_RE.test(hay)) return "consequence";      // secret NAME anywhere (exfil belt)
    const leadOk = SAFE_LEAD_RE.test(title) || SOCIAL_LEAD_RE.test(title);
    if (!leadOk) return "wording"; // must still lead with a safe OR posting verb
    return null;                    // approved: social publishing, no dangerous intent
  }
  // FAIL CLOSED (default path), two-tier:
  //  - HARD keywords (deploy/delete/money/shell/secrets/infra) gate from title
  //    OR body -- laundering-proof, never relaxed.
  //  - SOFT keywords (text/message/call/run/post/send... -- dangerous as verbs,
  //    common as nouns in descriptive bodies) gate only from the TITLE, so an
  //    innocent body mention no longer freezes a legit drafting task.
  //  - The title must still LEAD with an audited safe verb.
  if ((structuredGitLadder ? STRUCTURED_GIT_HARD_GATED_RE : HARD_GATED_RE).test(hay)) return "consequence";
  if (SECRET_NAME_RE.test(hay)) return "consequence"; // a secret NAME anywhere (POSTIZ_API_KEY, $TOKEN)
  // Outward communication remains a consequence. Code-execution wording is an
  // advisory pause: the operator may allow this exact jailed task once, while
  // every hard keyword (deploy/delete/send/credentials/etc.) above still wins.
  // These two read the TITLE, not `hay`, so the filename neutralisation above did
  // not reach them -- "Review the post-mortem.sh output" still hard-gated on the
  // "post" inside the filename. Found by testing the fix rather than trusting it:
  // the token replacement was working perfectly and these lines never saw it.
  //
  // SAFE_LEAD_RE below deliberately keeps the RAW title. It asks which verb the
  // title LEADS with, and rewriting a leading token to " file " would change that
  // question rather than clean its input.
  if (SOFT_OUTWARD_RE.test(titleNoFiles)) return "consequence";
  if (SOFT_CODE_RE.test(titleNoFiles)) return "wording";
  if (!classifierFollows && !SAFE_LEAD_RE.test(title)) return "wording"; // no recognized safe verb -> advisory wording pause
  return null;
}

function isHumanGated(task) {
  return humanGateReason(task) !== null;
}

// A task SPAWNED BY a running task must inherit the parent's chain_id, never
// start a fresh chain -- otherwise splitting work into N children multiplies the
// budget N-fold (Hermes red-team #1). The orchestrator calls this when a run
// proposes children: every child carries the parent's chain_id. A child that
// somehow arrives with no chain_id is adopted into the parent's chain here, so
// there is no path to a fresh budget mid-chain.
function childChainId(parentChainId) {
  return parentChainId; // identity by design -- the guard is that dispatch USES this
}

// ---- Sidecar (chains.json) shape + lineage ----------------------------------
// The Hermes kanban board is a FLAT task list: it persists no chain id, no
// parent link, and no handoff origin. So all chain LINEAGE lives in a sidecar
// file the orchestrator owns. Its shape:
//   { chains: {[chainId]: chainRecord}, taskChain: {[taskId]: chainId},
//     rejects: {[taskId]: count}, lineage: {[taskId]: fromEngine},
//     pending: {[taskId]: {phase, result?, correction?, by, t}} }
// Without taskChain, every task would derive "chain-<own-id>" and per-chain
// budgets would never compose across a handoff (budget multiplication).
// `pending` is the work->review pipeline state (added 2026-07-18): the real
// Hermes CLI has no verb that sets a `review` status, so the orchestrator keeps
// a dispatched task claimed (running) on the board and tracks its own pipeline
// phase here -- phase "review" carries the raw result awaiting an independent
// reviewer; phase "work" carries a reviewer's correction awaiting a bounded
// re-run. Persisted, so a gate restart resumes the pipeline where it left off.

// Normalize any parsed sidecar (incl. an older bare {[chainId]: record} map, or
// junk) into the full shape. Pure -- callers do the file I/O.
function normalizeSidecar(raw) {
  if (!raw || typeof raw !== "object") return { chains: {}, taskChain: {}, rejects: {}, lineage: {}, pending: {}, humanReview: {}, loopAlerts: {}, manualOverrides: {}, handoffReproposals: {}, frozen: {}, stuckAlerts: {}, boardRunner: {} };
  if (!raw.chains && !raw.taskChain) {
    // Legacy bare map: values that look like chain records get lifted into chains.
    const vals = Object.values(raw);
    const looksLikeChains = vals.length > 0 && vals.every((v) => v && typeof v === "object" && "execs" in v);
    return { chains: looksLikeChains ? raw : {}, taskChain: {}, rejects: {}, lineage: {}, pending: {}, humanReview: {}, loopAlerts: {}, manualOverrides: {}, handoffReproposals: {}, frozen: {}, stuckAlerts: {}, boardRunner: {} };
  }
  return {
    chains: raw.chains || {}, taskChain: raw.taskChain || {},
    rejects: raw.rejects || {}, lineage: raw.lineage || {},
    pending: raw.pending || {},
    // humanReview: { taskId: { title, note, at } } -- the "Awaiting Your Review"
    // lane (Steve, 2026-07-18). The gate adds an entry when it parks a card for
    // a HUMAN DECISION (block --kind needs_input: an agent finished something
    // that wants Steve's yes/no, or a task genuinely needs him). The board reads
    // this to show a dedicated column; a phone push fires with title + note.
    // Distinct from `blocked` = engine failures (capability/transient).
    humanReview: raw.humanReview || {},
    // loopAlerts: { clusterKey: { count, at } } -- the duplicate-loop detector's
    // idempotency store (Steve, 2026-07-19). One alert per detected pile-up of
    // near-duplicate cards, NOT one per 30s tick. Keyed by the cluster's token
    // signature (not a task id), so it is self-pruned by the detector when the
    // cluster clears -- it is NOT dropped by pruneSidecar's task-id sweep.
    loopAlerts: raw.loopAlerts || {},
    // manualOverrides: { taskId: { wording_gate|loop_detector: record } }.
    // Each record is bound to the exact task fingerprint and expires after 24h.
    // The dispatcher consumes it only when a real execution attempt starts.
    manualOverrides: raw.manualOverrides || {},
    // handoffReproposals: { signature: count } -- the handoff-reproposal circuit
    // breaker's counter (Steve, 2026-07-20). Keyed by a task's TOKEN SIGNATURE
    // (not a task id -- each re-proposal is a fresh card), so it is pruned by
    // SIGNATURE against the live board (in gate.js's boardTick per-tick sidecar
    // bookkeeping), NOT by pruneSidecar's task-id sweep below.
    handoffReproposals: raw.handoffReproposals || {},
    // frozen: { taskId: { at, reason } } -- cards the team INTENTIONALLY stopped
    // (Steve, 2026-07-19; distinct from `blocked` = waiting/failed). The Hermes
    // CLI has no `frozen` status (kanban_db.py VALID_STATUSES) and direct SQLite
    // writes are off-limits (WAL), so frozen-ness is a gate-side overlay: the
    // card is CLI-`blocked` underneath, this map is what makes it frozen. The
    // board shows a dedicated lane; dispatch/orphan-sweep/stuck-detection all
    // skip these ids.
    frozen: raw.frozen || {},
    // stuckAlerts: { taskId: { reason, at } } -- the stuck-card detector's
    // idempotency store (Steve, 2026-07-19). One alert per card per stuck
    // reason (re-armed on reason change or after the cooldown), NOT one per
    // 30-minute sweep. Pruned by pruneSidecar's task-id sweep.
    stuckAlerts: raw.stuckAlerts || {},
    // boardRunner: { "taskId:action": { at } } -- the Gemini board runner's
    // per-card-per-action cooldown store (Steve, 2026-07-20: Gemini acts on
    // stuck/dup/blocked cards himself). Stops an unblock->re-block->unblock
    // ping-pong: the SAME action on the SAME card runs at most once per
    // cooldown. Keys embed the task id first, so the task-id prune below
    // drops entries for cards that left the board.
    boardRunner: raw.boardRunner || {},
  };
}

// The chain a task belongs to: the explicit mapping if the orchestrator recorded
// one when it created the task (a child inherits its parent's chain), else a
// fresh root chain keyed by the task's own id. The ONLY place a chainId is
// derived -- so there is no path to a mid-chain fresh budget.
function chainIdFor(sidecar, taskId) {
  return (sidecar.taskChain && sidecar.taskChain[taskId]) || ("chain-" + taskId);
}

// Prune finished/aged chains and sidecar entries so the file can't grow unbounded
// on a box running autonomy for weeks. Stale = older than 2x max lifetime; entries
// for tasks no longer on the board are dropped; total chains capped at `cap`
// (oldest-first). Mutates and returns `sidecar`.
function pruneSidecar(sidecar, liveTaskIds, nowMs, cap) {
  const limit = cap || 200;
  const staleAfter = 2 * LIMITS.maxLifetimeMs;
  for (const [cid, c] of Object.entries(sidecar.chains)) {
    if (c && typeof c.startedAt === "number" && nowMs - c.startedAt > staleAfter) delete sidecar.chains[cid];
  }
  for (const map of [sidecar.taskChain, sidecar.rejects, sidecar.lineage, sidecar.pending || {}, sidecar.humanReview || {}, sidecar.frozen || {}, sidecar.stuckAlerts || {}, sidecar.manualOverrides || {}]) {
    for (const tid of Object.keys(map)) {
      if (!liveTaskIds.has(String(tid))) delete map[tid];
    }
  }
  // A live task's unused override still has a hard 24-hour ceiling. Records are
  // nested by issue so granting one detector never overwrites or authorizes the
  // other. Drop malformed/expired records and then empty task buckets.
  for (const [tid, issues] of Object.entries(sidecar.manualOverrides || {})) {
    if (!issues || typeof issues !== "object") { delete sidecar.manualOverrides[tid]; continue; }
    for (const [issue, rec] of Object.entries(issues)) {
      if (!rec || typeof rec.expiresAt !== "number" || rec.expiresAt <= nowMs) delete issues[issue];
    }
    if (!Object.keys(issues).length) delete sidecar.manualOverrides[tid];
  }
  // boardRunner keys are "taskId:action" -- prune by the task-id prefix.
  for (const key of Object.keys(sidecar.boardRunner || {})) {
    if (!liveTaskIds.has(String(key).split(":")[0])) delete sidecar.boardRunner[key];
  }
  // Stale pipeline state: a pending entry whose phase hasn't advanced in 2x the
  // chain lifetime is orphaned (its run died without cleanup) -- drop it so the
  // task can be re-considered rather than wedged forever.
  for (const [tid, p] of Object.entries(sidecar.pending || {})) {
    if (p && typeof p.t === "number" && nowMs - p.t > staleAfter) delete sidecar.pending[tid];
  }
  const ids = Object.keys(sidecar.chains);
  if (ids.length > limit) {
    ids.sort((a, b) => (sidecar.chains[a].startedAt || 0) - (sidecar.chains[b].startedAt || 0));
    for (const cid of ids.slice(0, ids.length - limit)) delete sidecar.chains[cid];
  }
  return sidecar;
}

// Parse HANDOFF: <engine> :: <title> lines an autonomous run proposes. Returns
// [{ to, title }] for valid engines only, capped at 3. This is how a child task
// is born -- the ORCHESTRATOR creates it (inheriting the parent's chain), never
// the agent directly, so every child is chain-tracked and budget-bound.
const HANDOFF_RE = /^\s*HANDOFF:\s*(claude|codex|deepseek|kimi|gemini|hermes)\s*::\s*(.+?)\s*$/gim;
function parseHandoffs(text) {
  const out = [];
  let m;
  HANDOFF_RE.lastIndex = 0;
  while ((m = HANDOFF_RE.exec(String(text || ""))) && out.length < 3) {
    const title = m[2].trim();
    if (title) out.push({ to: m[1].toLowerCase(), title: title.slice(0, 200) });
  }
  return out;
}

// ---- Claude autonomous-execution SANDBOX ------------------------------------
// V2 lets claude auto-EXECUTE queued board tasks (not just codex) -- but ONLY
// through a locked-down profile, never the chat args (which carry
// --dangerously-skip-permissions + the full box env). The chat path stays
// byte-for-byte unchanged; this is a SEPARATE profile used only by the
// autonomous board dispatcher. Every layer here was verified on the live box
// (agenthost-steve, claude-code 2.1.212): a run built this way, told to escape
// via bash/git-push/curl/secret-print AND via the installed skills/MCP, returned
// ESCAPE_RESULT: BLOCKED and created no artifact.
//
// Why claude (not hermes): hermes keeps its secrets in ~/.hermes/.env on DISK
// (an env scrub can't hide them) and exposes a terminal/whatsapp toolset with no
// read-only flag, so it stays review-only. Codex keeps its own --sandbox
// read-only. Only claude gains a safe exec path here.

// The env a sandboxed claude child is allowed to see. VERIFIED on the box:
// `claude -p` authenticates with ONLY the OAuth token (+ PATH/HOME); without the
// token it fails "Not logged in". Build by ALLOW-LIST from {} so a newly-added
// Fly secret is dropped by DEFAULT (fail-closed) -- a hypothetical tool escape
// finds NO Fly secret to exfiltrate (GITHUB_TOKEN, TTYD_PASSWORD, OLLAMA_API_KEY,
// every HERMESENV_* key, and crucially ANTHROPIC_API_KEY which would meter-bill
// against Rule 9 -- all absent). LANG is carried for correct text handling; TERM
// is forced to "dumb". This resolves the Cardinal-Rule-9 tension: keep exactly
// the one token inference needs, drop everything else.
const CLAUDE_SANDBOX_ENV_KEYS = ["PATH", "HOME", "CLAUDE_CODE_OAUTH_TOKEN", "LANG"];
function sandboxedClaudeEnv(fullEnv) {
  return allowlistEnv(fullEnv, CLAUDE_SANDBOX_ENV_KEYS);
}

// Codex autonomous env: codex auths from its on-disk ~/.codex config (NOT an env
// token), so it needs HOME but NO token var. Same fail-closed allow-list -> every
// Fly secret dropped, so even codex's read-only sandbox can't Read a secret out
// of its own environ. The Git config lock is added from constants, never copied
// from the parent: an agent-writable .git/config cannot enable hooks, fsmonitor,
// credentials, or a custom ssh command in the Codex parent process. codex is NOT
// tmpfs-HOME'd (that would hide ~/.codex and break its auth) -- the PID namespace
// hides the PARENT's /proc, and the env scrub empties codex's OWN environ.
const CODEX_SANDBOX_ENV_KEYS = ["PATH", "HOME", "LANG"];
const CODEX_GIT_LOCK_ENV = Object.freeze({
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_CONFIG_COUNT: "9",
  GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/dev/null",
  GIT_CONFIG_KEY_1: "core.fsmonitor", GIT_CONFIG_VALUE_1: "",
  GIT_CONFIG_KEY_2: "credential.helper", GIT_CONFIG_VALUE_2: "",
  GIT_CONFIG_KEY_3: "core.sshCommand", GIT_CONFIG_VALUE_3: "",
  GIT_CONFIG_KEY_4: "core.attributesFile", GIT_CONFIG_VALUE_4: "/dev/null",
  GIT_CONFIG_KEY_5: "core.excludesFile", GIT_CONFIG_VALUE_5: "/dev/null",
  GIT_CONFIG_KEY_6: "commit.gpgSign", GIT_CONFIG_VALUE_6: "false",
  GIT_CONFIG_KEY_7: "tag.gpgSign", GIT_CONFIG_VALUE_7: "false",
  GIT_CONFIG_KEY_8: "core.pager", GIT_CONFIG_VALUE_8: "cat",
});
function sandboxedCodexEnv(fullEnv) {
  return { ...allowlistEnv(fullEnv, CODEX_SANDBOX_ENV_KEYS), ...CODEX_GIT_LOCK_ENV };
}

// Hermes autonomous env: Hermes authenticates via API keys in ~/.hermes/.env
// (NOT OAuth). The sandbox must carry the model API key so `hermes chat -q`
// can reach its provider, but DROP every Fly secret (TTYD_PASSWORD, GITHUB_TOKEN,
// TTYD_PASSWORD, every HERMESENV_ key). The Git lock env is the same as Codex's
// — no agent-writable .git/config can enable hooks, credentials, or ssh.
const HERMES_SANDBOX_ENV_KEYS = [
  "PATH", "HOME", "LANG",
  "OPENROUTER_API_KEY",   // Hermes's primary model provider
  "ANTHROPIC_API_KEY",    // fallback provider (if configured)
  "GOOGLE_API_KEY",       // Google API (Gemini via google-genai)
  "GEMINI_API_KEY",       // Gemini API key (Hermes config uses provider: gemini)
  "GLM_API_KEY",          // fallback provider (if configured)
  "TERM",                 // terminal type (Hermes checks TERM for output formatting)
];
function sandboxedHermesEnv(fullEnv) {
  return { ...allowlistEnv(fullEnv, HERMES_SANDBOX_ENV_KEYS), ...CODEX_GIT_LOCK_ENV };
}

// Gemini's sandbox env allowlist: only model API keys, no host secrets.
const GEMINI_SANDBOX_ENV_KEYS = [
  "PATH", "HOME", "LANG",
  "GEMINI_API_KEY",        // Gemini API key (primary)
  "GOOGLE_API_KEY",        // Google API key (alternate)
];
function sandboxedGeminiEnv(fullEnv) {
  return { ...allowlistEnv(fullEnv, GEMINI_SANDBOX_ENV_KEYS), ...CODEX_GIT_LOCK_ENV };
}

// Kimi's sandbox env allowlist: only the Moonshot API key, no host secrets.
const KIMI_SANDBOX_ENV_KEYS = [
  "PATH", "HOME", "LANG",
  "KIMI_API_KEY",          // Moonshot API key (primary)
];
function sandboxedKimiEnv(fullEnv) {
  return { ...allowlistEnv(fullEnv, KIMI_SANDBOX_ENV_KEYS), ...CODEX_GIT_LOCK_ENV };
}

// Shared allow-list env builder (fail-closed: start from {}, copy only named
// keys, force TERM=dumb). A newly-added Fly secret is dropped by default.
function allowlistEnv(fullEnv, keys) {
  const src = fullEnv || {};
  const out = Object.create(null);
  for (const k of keys) {
    if (src[k] != null) out[k] = src[k];
  }
  out.TERM = "dumb";
  return out;
}

// Tools the autonomous claude run may use / may NEVER use. plan mode already
// blocks all execution/writes; the allow/deny pair is cheap defense in depth.
// Read/Grep/Glob let the run do useful analysis; the mount namespace (below) is
// what actually hides the secrets Read could otherwise reach. NOTE: only REAL
// claude 2.1.212 tool names -- a bogus name just emits a harmless warning.
const CLAUDE_ALLOW_TOOLS = ["Read", "Grep", "Glob"];
const CLAUDE_DENY_TOOLS = ["Bash", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch", "Task", "KillShell", "BashOutput", "SlashCommand"];

// The exact claude argv for a sandboxed autonomous run. Ordering is load-bearing
// (box-verified footgun): the prompt MUST come via `-p` FIRST and the VARIADIC
// flags (--mcp-config, --allowedTools, --disallowedTools) MUST come LAST --
// otherwise claude parses the prompt words as tool names and errors. Layers, all
// box-verified:
//   --permission-mode plan   -> model reasons + proposes, cannot exec/write/network
//   --setting-sources ""     -> load NO user/project/local settings (no starter-stack plugins)
//   --strict-mcp-config + --mcp-config {} -> load ZERO MCP servers (no CodeGraph/Stripe/Supabase...)
//   --add-dir <scratch>      -> the run's writable throwaway; plus the sanitized
//                               read-only repo stage (/repo) when one is mounted
//   --allowedTools / --disallowedTools -> read-only tool set, exec/net/write denied
//   --settings {disableAllHooks} -> same speed fix as the chat path
//   --output-format stream-json --verbose -> so usageFrom() can bill the chain budget
function claudeAutonomousArgs(prompt, scratch, repoDir) {
  const args = [
    "-p", String(prompt == null ? "" : prompt),
    "--permission-mode", "plan",
    "--setting-sources", "",
    "--strict-mcp-config",
    "--settings", '{"disableAllHooks":true}',
    "--output-format", "stream-json", "--include-partial-messages", "--verbose",
  ];
  // Variadic flags LAST (see ordering note above):
  args.push("--mcp-config", '{"mcpServers":{}}');
  if (scratch) args.push("--add-dir", String(scratch));
  // The sanitized repo stage (bound read-only in the jail). Passed only when a
  // stage was actually mounted -- claude errors at startup on a missing add-dir.
  if (repoDir) args.push("--add-dir", String(repoDir));
  args.push("--allowedTools", ...CLAUDE_ALLOW_TOOLS);
  args.push("--disallowedTools", ...CLAUDE_DENY_TOOLS);
  return args;
}

// READ-JAIL: run an autonomous engine in a fresh root that contains ONLY an
// allowlist of paths, so every secret-bearing path is simply ABSENT -- not
// "hidden" (a mask), but confined (an allowlist). This is the architecturally-
// correct fix two red-teams (2026-07-17) demanded: the earlier tmpfs-over-HOME
// approach MASKED reads (hide HOME, scrub env) but the allowlisted Read tool was
// never path-CONFINED, so out-of-HOME secrets (or a future /run/secrets) stayed
// readable. The jail inverts it: build an empty root, bind ONLY system libs +
// /dev essentials + a fresh /proc + a writable scratch/HOME + (optionally) the
// engine's own auth dir and the specific repo subtree it needs; chroot in; exec.
//   `/home`, `/opt/agenthost`, `/run`, every other engine's creds, the repo .env
//   -- all ABSENT (box-verified: `ls /` shows only the allowlist; /home = "No
//   such file"). claude STILL auths (OAuth token via env) and returns real plans.
// Namespaces: --user --map-root-user (unprivileged mounts) --mount (own mount
// table) --pid --fork --mount-proc (fresh /proc; parent processes invisible so
// /proc/<gatepid>/{environ,root,fd} are gone). NO --net (inference needs it).
// The child's OWN /proc/self/environ still holds the OAuth token (irreducible --
// inference needs it in env); plan-mode-can't-act + redactSecrets are its
// backstops. Pure string-building; caller spawns { bin:"unshare", args:[...] }.
//
// opts: { home (writable HOME inside the jail, default "/home"),
//         roBinds  (absolute paths bound READ-ONLY into the jail; default the
//                   system dirs below), the engine's auth dir + repo subtree go here,
//         devNodes (/dev entries to bind; default null/zero/urandom/random),
//         requiredRwBindAt ([{src,dest}] mounts that must succeed or abort),
//         claudeBin (the engine binary path, bound via its parent dir in roBinds) }
// System dirs bound whole (read-only): libs + binaries. NOT /etc -- see below.
const JAIL_RO_DEFAULT = ["/usr", "/bin", "/sbin", "/lib", "/lib64"];
// Codex creates its OWN command sandbox. Its outer filesystem jail therefore
// must leave the user namespace available for that inner sandbox; Bubblewrap's
// setuid mode gives us a separate mount/PID namespace without consuming it.
// /sbin is folded into /usr on the runtime image, so the shorter allowlist is
// sufficient here while keeping this wrapper's surface explicit.
const BWRAP_RO_DEFAULT = ["/usr", "/bin", "/lib", "/lib64", "/usr/local"];
// /etc is bound SELECTIVELY, not whole: the run needs TLS certs (ssl,
// ca-certificates), DNS (resolv.conf, nsswitch.conf, hosts) and user lookups
// (passwd, group) + the dynamic-linker config -- but NOT /etc/shadow, /etc/gshadow,
// /etc/security/opasswd (password hashes) or anything else. Box-verified: claude
// auths + runs with only these; /etc/shadow is absent from the jail.
const JAIL_ETC_DIRS = ["/etc/ssl", "/etc/ca-certificates", "/etc/ld.so.conf.d"];
const JAIL_ETC_FILES = ["/etc/ca-certificates.conf", "/etc/resolv.conf", "/etc/nsswitch.conf", "/etc/hosts", "/etc/passwd", "/etc/group", "/etc/ld.so.cache", "/etc/ld.so.conf"];
const JAIL_DEV_DEFAULT = ["null", "zero", "urandom", "random"];
function buildReadJail(engineBin, engineArgs, opts) {
  const o = opts || {};
  const home = o.home || "/home";
  // roBinds: absolute source paths bound READ-ONLY at the SAME path inside the
  // jail (system dirs). roBindsAt: [{src, dest}] pairs to bind a source at a
  // DIFFERENT, neutral path inside the jail (e.g. the repo at "/repo", so the
  // jail never re-creates the real "/home/agent/..." layout). The engine is told
  // to read the repo at `dest`.
  const roBinds = Array.isArray(o.roBinds) && o.roBinds.length ? o.roBinds : JAIL_RO_DEFAULT;
  const roBindsAt = Array.isArray(o.roBindsAt) ? o.roBindsAt.filter((b) => b && b.src && b.dest) : [];
  const devNodes = Array.isArray(o.devNodes) && o.devNodes.length ? o.devNodes : JAIL_DEV_DEFAULT;
  const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
  const J = "$J"; // jail root, set in the script (a mktemp dir)
  const lines = [];
  // The child sh runs with the scrubbed engine env (a minimal PATH). The setup
  // tools (mount at /usr/bin, chroot at /usr/sbin) may be outside that PATH, so
  // set a complete PATH for the SETUP phase. chroot then hands the engine its own
  // env (the parent spawn's), so this setup PATH does not leak into the engine.
  lines.push("export PATH=/usr/sbin:/sbin:/usr/bin:/bin:/usr/local/bin");
  lines.push('J=$(mktemp -d /tmp/ah-jail-XXXXXX)');
  lines.push("mkdir -p " + J + "/proc " + J + "/dev " + J + home + " " + J + "/tmp 2>/dev/null || true");
  // Bind each allowed dir READ-ONLY into the jail (only dirs that exist).
  for (const d of roBinds) {
    if (!d) continue;
    const dj = J + d;
    lines.push("[ -e " + q(d) + " ] && { mkdir -p " + dj + " 2>/dev/null; mount --bind " + q(d) + " " + dj + " 2>/dev/null && mount -o remount,ro,bind " + dj + " 2>/dev/null; } || true");
  }
  // Selective /etc (TLS + DNS + user-lookup only; NOT shadow/gshadow). mkdir /etc
  // in the jail, then bind the specific dirs/files.
  lines.push("mkdir -p " + J + "/etc 2>/dev/null || true");
  for (const d of JAIL_ETC_DIRS) {
    const dj = J + d;
    lines.push("[ -d " + q(d) + " ] && { mkdir -p " + dj + " 2>/dev/null; mount --bind " + q(d) + " " + dj + " 2>/dev/null && mount -o remount,ro,bind " + dj + " 2>/dev/null; } || true");
  }
  for (const f of JAIL_ETC_FILES) {
    const fj = J + f;
    lines.push("[ -f " + q(f) + " ] && { touch " + fj + " 2>/dev/null; mount --bind " + q(f) + " " + fj + " 2>/dev/null && mount -o remount,ro,bind " + fj + " 2>/dev/null; } || true");
  }
  // Bind sources at neutral dests (repo -> /repo, auth dir -> a clean path).
  for (const b of roBindsAt) {
    const dj = J + b.dest;
    lines.push("[ -e " + q(b.src) + " ] && { mkdir -p " + dj + " 2>/dev/null; mount --bind " + q(b.src) + " " + dj + " 2>/dev/null && mount -o remount,ro,bind " + dj + " 2>/dev/null; } || true");
  }
  // rwBindAt: [{src,dest}] bound READ-WRITE (the run's scratch dir, so Write/Edit
  // land in a real host dir the orchestrator cleans up -- inside the jail at a
  // neutral path like /scratch).
  const rwBindAt = Array.isArray(o.rwBindAt) ? o.rwBindAt.filter((b) => b && b.src && b.dest) : [];
  for (const b of rwBindAt) {
    const dj = J + b.dest;
    lines.push("[ -e " + q(b.src) + " ] && { mkdir -p " + dj + " 2>/dev/null; mount --bind " + q(b.src) + " " + dj + " 2>/dev/null; } || true");
  }
  // requiredRwBindAt is for capability-bearing mounts such as the one selected
  // Rung 1 worktree. Never start the engine if the source vanished or the bind
  // failed: its inner write mode and the outer jail must not disagree.
  const requiredRwBindAt = Array.isArray(o.requiredRwBindAt) ? o.requiredRwBindAt : [];
  if (o.requiredRwBindAt !== undefined && !Array.isArray(o.requiredRwBindAt)) lines.push("exit 73");
  for (const b of requiredRwBindAt) {
    const valid = b && typeof b.src === "string" && b.src.startsWith("/") && !b.src.includes("\0")
      && typeof b.dest === "string" && /^\/(?:[a-zA-Z0-9._-]+\/?)+$/.test(b.dest)
      && !b.dest.split("/").some((part) => part === "." || part === "..");
    if (!valid) { lines.push("exit 73"); continue; }
    const dj = J + b.dest;
    lines.push("[ -d " + q(b.src) + " ] || exit 73");
    lines.push("mkdir -p " + dj + " 2>/dev/null || exit 73");
    lines.push("mount --bind " + q(b.src) + " " + dj + " 2>/dev/null || exit 73");
  }
  // /proc fresh (reflects the child's PID namespace only).
  lines.push("mount -t proc proc " + J + "/proc 2>/dev/null || true");
  // /dev essentials (device nodes claude/node need; bind the real ones).
  for (const dev of devNodes) {
    const name = String(dev).replace(/[^a-z0-9]/gi, "");
    if (!name) continue;
    lines.push("touch " + J + "/dev/" + name + " 2>/dev/null; mount --bind /dev/" + name + " " + J + "/dev/" + name + " 2>/dev/null || true");
  }
  // Writable tmpfs for HOME and /tmp inside the jail (ephemeral, wiped on exit).
  lines.push("mount -t tmpfs none " + J + home + " 2>/dev/null || true");
  lines.push("mount -t tmpfs none " + J + "/tmp 2>/dev/null || true");
  // Enter the jail and exec the engine (env is passed by the parent spawn, but we
  // set HOME here so it points inside the jail).
  const execArgs = [q(engineBin), ...engineArgs.map(q)].join(" ");
  lines.push("exec chroot " + J + " " + execArgs);
  return {
    bin: "unshare",
    args: ["--user", "--map-root-user", "--mount", "--pid", "--fork", "--mount-proc", "sh", "-c", lines.join("\n")],
    home,
  };
}

// Build Codex's OUTER allowlist jail. Unlike buildReadJail it deliberately
// does NOT unshare a user namespace: Codex's inner workspace-write sandbox
// needs to create one for itself. The image installs /usr/bin/bwrap setuid so
// this outer mount/PID jail remains available to the unprivileged agent user.
//
// This wrapper keeps the filesystem boundary (only explicit binds exist) while
// Codex's own sandbox remains responsible for tool-write and tool-network
// limits. `--clearenv` is load-bearing: only the already-scrubbed engine env
// supplied by the caller enters the jail.
function buildBwrapReadJail(engineBin, engineArgs, opts) {
  const o = opts || {};
  const args = ["--die-with-parent", "--new-session", "--unshare-pid", "--clearenv"];
  // DSH is the first caller whose outer jail owns the complete network policy:
  // loopback remains for its in-jail HTTP bridge, while every real interface is
  // absent. This option can only tighten the generic builder.
  if (o.unshareNet === true) args.push("--unshare-net");
  // The DSH bridge must start as root only long enough to consume its protected
  // relay capability and drop the Harness child. DAC_OVERRIDE lets uid 0 open
  // the gate:boxstate 0660 relay socket without joining the untrusted agent's
  // supplementary groups; KILL lets it stop the now-agent-uid child. Every
  // other effective capability is removed before bridge JavaScript runs.
  if (o.dshRootBridgeCapabilities === true) {
    args.push(
      "--cap-drop", "ALL",
      "--cap-add", "CAP_SETUID",
      "--cap-add", "CAP_SETGID",
      "--cap-add", "CAP_DAC_OVERRIDE",
      "--cap-add", "CAP_KILL",
    );
  }
  // Bubblewrap reports lifecycle facts over these descriptors. Treat each as a
  // capability-bearing extra stdio slot, never a string or stdin/stdout/stderr.
  // The native auth launcher replaces these inherited descriptor numbers with
  // private pipes: infoFd supplies the initial child PID, jsonStatusFd supplies
  // lifecycle events, and blockFd holds the command before it can exec.
  const hasInfoFd = Object.prototype.hasOwnProperty.call(o, "infoFd");
  const hasJsonStatusFd = Object.prototype.hasOwnProperty.call(o, "jsonStatusFd");
  const hasBlockFd = Object.prototype.hasOwnProperty.call(o, "blockFd");
  const infoFd = o.infoFd;
  const jsonStatusFd = o.jsonStatusFd;
  const blockFd = o.blockFd;
  const validLifecycleFd = (fd) => Number.isSafeInteger(fd) && fd >= 3 && fd <= 1024;
  if (hasInfoFd !== hasJsonStatusFd || hasInfoFd !== hasBlockFd
    || (hasInfoFd && !validLifecycleFd(infoFd))
    || (hasJsonStatusFd && !validLifecycleFd(jsonStatusFd))
    || (hasBlockFd && !validLifecycleFd(blockFd))
    || (hasInfoFd && (infoFd === jsonStatusFd || infoFd === blockFd || jsonStatusFd === blockFd))) {
    return { bin: "/usr/bin/false", args: [] };
  }
  if (hasInfoFd) args.push("--info-fd", String(infoFd));
  if (hasJsonStatusFd) args.push("--json-status-fd", String(jsonStatusFd));
  if (hasBlockFd) args.push("--block-fd", String(blockFd));
  const validDest = (dest) => typeof dest === "string"
    && /^\/(?:[a-zA-Z0-9._-]+\/?)+$/.test(dest)
    && !dest.split("/").some((part) => part === "." || part === "..");
  const validSource = (src) => typeof src === "string" && src.startsWith("/") && !src.includes("\0");
  const addDir = (dest) => { if (validDest(dest)) args.push("--dir", dest); };
  const addParentDir = (dest) => {
    const parent = dest.slice(0, dest.lastIndexOf("/")) || "/";
    if (parent !== "/") addDir(parent);
  };
  const env = o.env && typeof o.env === "object" ? o.env : {};
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || String(value).includes("\0")) continue;
    args.push("--setenv", key, String(value));
  }

  const roBinds = Array.isArray(o.roBinds) && o.roBinds.length ? o.roBinds : BWRAP_RO_DEFAULT;
  for (const src of roBinds) {
    if (!validSource(src)) continue;
    addDir(src);
    args.push("--ro-bind-try", src, src);
  }
  addDir("/etc");
  for (const src of JAIL_ETC_DIRS) {
    addDir(src);
    args.push("--ro-bind-try", src, src);
  }
  for (const src of JAIL_ETC_FILES) args.push("--ro-bind-try", src, src);

  const roBindsAt = Array.isArray(o.roBindsAt) ? o.roBindsAt : [];
  for (const bind of roBindsAt) {
    if (!bind || !validSource(bind.src) || !validDest(bind.dest)) continue;
    addDir(bind.dest);
    args.push("--ro-bind-try", bind.src, bind.dest);
  }
  const rwBindAt = Array.isArray(o.rwBindAt) ? o.rwBindAt : [];
  for (const bind of rwBindAt) {
    if (!bind || !validSource(bind.src) || !validDest(bind.dest)) continue;
    addDir(bind.dest);
    args.push("--bind-try", bind.src, bind.dest);
  }
  const requiredRwBindAt = Array.isArray(o.requiredRwBindAt) ? o.requiredRwBindAt : [];
  if (o.requiredRwBindAt !== undefined && !Array.isArray(o.requiredRwBindAt)) return { bin: "/usr/bin/false", args: [] };
  for (const bind of requiredRwBindAt) {
    if (!bind || !validSource(bind.src) || !validDest(bind.dest)) return { bin: "/usr/bin/false", args: [] };
    addDir(bind.dest);
    // Do not use --bind-try here: a selected Rung 1 grant must fail closed if
    // its source disappeared before the engine starts.
    args.push("--bind", bind.src, bind.dest);
  }
  // Security-fixed Bubblewrap accepts an already-open directory descriptor.
  // This is stronger than --bind /proc/self/fd/N: the latter re-resolves a
  // magic link and recreates the same-UID rename race fixed by CVE-2024-42472.
  const requiredRwBindFdAt = Array.isArray(o.requiredRwBindFdAt) ? o.requiredRwBindFdAt : [];
  if (o.requiredRwBindFdAt !== undefined && !Array.isArray(o.requiredRwBindFdAt)) return { bin: "/usr/bin/false", args: [] };
  for (const bind of requiredRwBindFdAt) {
    if (!bind || !validLifecycleFd(bind.fd) || !validDest(bind.dest)) return { bin: "/usr/bin/false", args: [] };
    addDir(bind.dest);
    args.push("--bind-fd", String(bind.fd), bind.dest);
  }
  // Required read-only overlays come AFTER the writable workspace. Ordering is
  // load-bearing for /workspace/.env: mounting the workspace later would reveal
  // the checkout's real dotenv file again.
  const requiredRoBindAt = Array.isArray(o.requiredRoBindAt) ? o.requiredRoBindAt : [];
  if (o.requiredRoBindAt !== undefined && !Array.isArray(o.requiredRoBindAt)) return { bin: "/usr/bin/false", args: [] };
  for (const bind of requiredRoBindAt) {
    if (!bind || !validSource(bind.src) || !validDest(bind.dest)) return { bin: "/usr/bin/false", args: [] };
    addParentDir(bind.dest);
    args.push("--ro-bind", bind.src, bind.dest);
  }
  // These telemetry descriptors are needed by Bubblewrap's outer monitor, not
  // the model. Close them in the sandbox command before it execs the engine.
  const closeFds = Array.isArray(o.closeFds)
    ? [...new Set(o.closeFds.filter((fd) => Number.isInteger(fd) && fd >= 3 && fd <= 1024))].sort((a, b) => a - b)
    : [];
  closeFds.push(...requiredRwBindFdAt.map((bind) => bind.fd));
  if (hasInfoFd) closeFds.push(infoFd);
  if (hasJsonStatusFd) closeFds.push(jsonStatusFd);
  if (hasBlockFd) closeFds.push(blockFd);
  closeFds.sort((a, b) => a - b);
  for (let i = closeFds.length - 1; i > 0; i--) {
    if (closeFds[i] === closeFds[i - 1]) closeFds.splice(i, 1);
  }
  const command = closeFds.length
    ? ["/bin/sh", "-c", closeFds.map((fd) => "exec " + fd + "<&-").join("; ") + '; exec "$@"', "agenthost-fd-close", engineBin, ...engineArgs]
    : [engineBin, ...engineArgs];
  addDir("/hm"); args.push("--tmpfs", "/hm");
  addDir("/tmp"); args.push("--tmpfs", "/tmp");
  if (o.dshRootBridgeCapabilities === true) {
    // Root-invoked bwrap creates tmpfs roots as root:root 0755. The bridge then
    // drops DSH to agent, so make only these isolated ephemeral mounts writable;
    // no host path or credential directory receives the relaxed mode.
    args.push("--chmod", "01777", "/hm", "--chmod", "01777", "/tmp");
  }
  // The auth watcher runs OUTSIDE this PID namespace. This fresh procfs thus
  // exposes only Codex and its inner tool sandbox, never the watcher's open
  // directory handles or the host gate process.
  addDir("/proc"); args.push("--proc", "/proc");
  addDir("/dev"); args.push("--dev", "/dev");
  const chdir = o.chdir === undefined ? "/scratch" : o.chdir;
  if (!validDest(chdir)) return { bin: "/usr/bin/false", args: [] };
  if (chdir === "/scratch") addDir("/scratch");
  args.push("--chdir", chdir, "--", ...command);
  return { bin: "/usr/bin/bwrap", args };
}

// LEGACY mask wrapper (tmpfs-over-HOME). Kept for reference / the codex path until
// it moves to buildReadJail. Prefer buildReadJail (allowlist) over this (mask).
function buildSandboxWrapper(claudeBin, claudeArgs, opts) {
  const o = opts || {};
  const home = o.home || "";
  const tmpfsHome = o.tmpfsHome !== false;
  const keepDirs = (tmpfsHome && Array.isArray(o.keepDirs)) ? o.keepDirs.filter(Boolean) : [];
  const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
  const mnts = [];
  if (home && tmpfsHome) {
    keepDirs.forEach((d, i) => {
      const hold = "/tmp/.ah-keep-" + i;
      mnts.push("mkdir -p " + q(hold) + " 2>/dev/null || true");
      mnts.push("[ -e " + q(d) + " ] && mount --bind " + q(d) + " " + q(hold) + " 2>/dev/null || true");
    });
    mnts.push("mount -t tmpfs none " + q(home) + " 2>/dev/null || true");
    mnts.push("mkdir -p " + q(home) + " 2>/dev/null || true");
    keepDirs.forEach((d, i) => {
      const hold = "/tmp/.ah-keep-" + i;
      mnts.push("mkdir -p " + q(d) + " 2>/dev/null || true");
      mnts.push("mount --bind " + q(hold) + " " + q(d) + " 2>/dev/null || true");
    });
  }
  const execLine = "exec " + [q(claudeBin), ...claudeArgs.map(q)].join(" ");
  const script = mnts.join("; ") + (mnts.length ? "; " : "") + execLine;
  return {
    bin: "unshare",
    // --pid --fork --mount-proc: fresh PID namespace + its own /proc, so the
    // parent processes' /proc/<pid>/{environ,root,fd} are unreachable. --fork is
    // REQUIRED with --pid (unshare must fork so the child becomes PID 1 of the
    // new namespace); --mount-proc remounts /proc to reflect it.
    args: ["--user", "--map-root-user", "--mount", "--pid", "--fork", "--mount-proc", "sh", "-c", script],
    home,
  };
}

// Redact secret VALUES from a run's text output before it is persisted to the
// board / pushed to subscribers. The board + notifications are a lower-trust
// surface than the box. The OAuth token MUST stay in the sandboxed run's env for
// inference, and /proc/self/environ can't be hidden (a tmpfs over /proc breaks
// node), so the ONE surviving exfil channel is a model coaxed into EMITTING the
// token into its output text. This strips: the raw secret values, their base64
// and hex ENCODINGS (the obvious evasions of a raw-value match), and common
// token shapes. Not provably complete against every novel encoding -- it is the
// last of several layers (plan mode blocks acting on it; the model refuses), the
// residue of the Rule-9 tension -- but it closes the plausible evasions.
const TOKEN_SHAPE_RE = /\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g;
function redactSecrets(text, secretValues) {
  let s = String(text == null ? "" : text);
  const vals = Array.isArray(secretValues) ? secretValues : [];
  const forms = new Set();
  for (const v of vals) {
    const val = String(v || "");
    if (val.length < 8) continue; // don't redact trivially-short values (false positives)
    forms.add(val);
    // base64 + base64url encodings (padded and unpadded), and lowercase hex.
    try {
      const b64 = Buffer.from(val, "utf8").toString("base64");
      forms.add(b64);
      forms.add(b64.replace(/=+$/, ""));                 // unpadded
      forms.add(b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")); // base64url
      forms.add(Buffer.from(val, "utf8").toString("hex"));
    } catch { /* Buffer may be unavailable in some envs -- raw value still redacted */ }
  }
  // Longer values must go first. If one credential is the prefix of another,
  // replacing the short value first would expose the long value's suffix.
  for (const f of [...forms].sort((left, right) => right.length - left.length || left.localeCompare(right))) {
    if (!f || f.length < 8) continue;
    const esc = f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    s = s.replace(new RegExp(esc, "g"), "[REDACTED]");
  }
  s = s.replace(TOKEN_SHAPE_RE, "[REDACTED]");
  return s;
}

module.exports = {
  LIMITS, MAX_REJECT_CYCLES,
  newChain, normObjective, hashObjective, breaches, configureCost, costBypassed,
  canRun, inSoftZone, recordRun, recordChainUsage, childChainId,
  isHumanGated, humanGateReason, normalizeSidecar, chainIdFor, pruneSidecar, parseHandoffs,
  CLAUDE_SANDBOX_ENV_KEYS, sandboxedClaudeEnv,
  CODEX_SANDBOX_ENV_KEYS, CODEX_GIT_LOCK_ENV, sandboxedCodexEnv,
  HERMES_SANDBOX_ENV_KEYS, sandboxedHermesEnv,
  GEMINI_SANDBOX_ENV_KEYS, sandboxedGeminiEnv,
  KIMI_SANDBOX_ENV_KEYS, sandboxedKimiEnv,
  CLAUDE_ALLOW_TOOLS, CLAUDE_DENY_TOOLS, claudeAutonomousArgs,
  buildReadJail, buildBwrapReadJail, buildSandboxWrapper, redactSecrets,
};
