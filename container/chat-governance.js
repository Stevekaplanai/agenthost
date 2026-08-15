// Chat-path governance: the consequence gate + daily spend cap for the INTERACTIVE
// chat path, giving it the governance the autonomous board path already has.
//
// Why this exists: the autonomous board classifies every task and parks a consequential
// one for confirmation, but the interactive chat path spawned the agent immediately (with
// --dangerously-skip-permissions) with NO per-message gate and no spend cap. This closes
// that gap so a "deploy to prod" / "rm -rf" / "send the invoice" typed (or voiced) into
// chat is confirmed before it runs, and chat spend cannot silently blow past the cap.
//
// IMPORTANT — best-effort by design. This is a message-text classifier, and a blocklist
// over free-form natural language is fundamentally leaky (obfuscation, base64, novel
// phrasing, prompt-injection in ingested content can evade it). It raises the floor; it
// is NOT a substitute for the robust fix, which is ACTION-LEVEL permissions (do not run
// chat with --dangerously-skip-permissions; prompt at the tool call). That is a larger
// product decision flagged for the operator. Treat this as defense-in-depth, not a wall.
//
// Design decisions (from the 2026-07-23 red-team):
//   - We do NOT reuse the board's HARD_GATED_RE as-is: the board is a fail-closed
//     ALLOWLIST (gate unless the text leads with a safe verb), which over free-form chat
//     would gate almost every question. Chat needs its own tuned blocklist.
//   - Danger verbs are matched in ANY inflection ("deploying"/"deletes") so a suffix
//     cannot slip past a bare stem.
//   - Raw shell destructive SHAPES are caught (rm -rf, > /dev/, | sh, git push/reset,
//     npm i, docker rm, drop table, mkfs) -- the board never needed these; chat does.
//   - Bare NOUNS the board belt trips on (token/secret/launch/merge/apply/reset/...) are
//     deliberately NOT gated; only AFFIXED secret NAMES (api_key, _token, id_rsa, .pem).
//   - SPEND is capped on TWO axes (dollars AND tokens) because the default box runs on a
//     subscription that records $0 -- a dollars-only cap would be inert there.

// --- consequence classifier (chat-tuned) ---------------------------------------------
// One inflection group covers both stem styles: full verbs (deploy -> deploy/deploys/
// deployed/deploying via e?s / e?d / ing) and e-less stems for e-ending verbs (delet ->
// delete/deletes/deleted/deleting via e / e?s="es" / e?d="ed" / ing). So a suffix can
// never slip a danger verb past a bare stem.
const INFL = "(?:e?s|e?d|ing|e)?";
// Danger verb stems (take INFL). e-ending verbs use their e-less stem.
const STEMS = [
  "deploy", "redeploy", "delet", "destroy", "remov", "wip", "purg", "truncat",
  "uninstall", "decommission", "push", "rebas", "reboot", "restart", "migrat",
  "provision", "escalat", "send", "email", "pay", "charg", "refund", "purchas",
  "invoic", "subscrib", "deposit", "withdraw", "buy", "install", "reinstall",
];
// Literals that take no inflection (shell commands, fixed phrases, irregular pasts).
const LITERALS = [
  "rollout", "roll ?out", "force[- ]?push", "teardown", "tear ?down",
  "shutdown", "shut ?down", "halt", "poweroff", "power ?off", "e-mail", "dm",
  "sent", "paid", "bought",
  "sudo", "chmod", "chown", "curl", "wget", "ssh", "scp",
  "rm", "mv", "dd", "mkfs\\w*", "killall", "pkill", "kill", "wipefs", "shred", "fdisk", "mkswap",
];
const ALWAYS_RE = new RegExp("\\b(?:(?:" + STEMS.join("|") + ")" + INFL + "|" + LITERALS.join("|") + ")\\b", "i");
// Raw shell / tool destructive shapes (order-independent; anchored on structure, not a
// bare word, so they do not fire on prose).
const SHELL_SHAPE_RE = /(\brm\s+-|\bgit\s+(?:push|reset|rebase|revert|clean|reflog)\b|\bnpm\s+(?:i|install|uninstall|publish)\b|\bdocker\s+(?:rm|stop|kill|system\s+prune)\b|\bdrop\s+(?:table|database|db|schema|collection|index)\b|\bmerge\b[^\n]*\b(?:main|master|branch|pr|pull request|prod|production)\b|>\s*\/dev\/|\|\s*(?:sh|bash|zsh)\b|:\(\)\s*\{)/i;
// AFFIXED secret NAMES only -- never bare "token"/"secret" (those are everyday LLM/dev
// words). Mirrors chains-lib SECRET_NAME_RE's affixed forms.
const SECRET_NAME_RE = /(api[_\- ]?keys?|secret[_\- ]?keys?|access[_\- ]?tokens?|[_\-$]tokens?\b|[_\-$]secrets?\b|[_\-$]passwords?\b|private[_\- ]?keys?|id_rsa|\.pem)/i;

// Is a danger WORD sitting in a context where it's a spec, not an action? Skips
// code fences, quote lines, and QUOTED config values (TOML/JSON: key = "deploy",
// key = ["deploy"]). Does NOT skip shell assignments (TOKEN=$(...)) or prose --
// those lack a quote/bracket right after the '='. Fixes the loop where a PRD spec
// containing gated_keywords = ["deploy","push"] kept getting gated. (Hermes v2,
// folded 2026-07-25; structural shell/secret checks below still fire regardless.)
const CHAT_CODE_FENCE_RE = /```[\s\S]*?```/g;
function isSpecContext(text, matchIndex) {
  let inFence = false;
  text.replace(CHAT_CODE_FENCE_RE, (block, offset) => {
    if (matchIndex >= offset && matchIndex < offset + block.length) inFence = true;
    return "";
  });
  if (inFence) return true;
  const lineStart = text.lastIndexOf("\n", matchIndex - 1) + 1;
  if (text.slice(lineStart, lineStart + 5).trim().startsWith(">")) return true;
  const ctx = text.slice(Math.max(0, matchIndex - 60), matchIndex + 60);
  const eq = ctx.indexOf("=");
  if (eq >= 0 && /[\w.-]+\s*=\s*["'\[]/.test(ctx)) {
    const v = ctx.slice(eq + 1).trimStart();
    if (v.startsWith('"') || v.startsWith("'") || v.startsWith("[")) return true;
  }
  return false;
}

// Best-effort: is this chat message a HARD consequence (dangerous / outbound / spend /
// exfil)? Structural signals (shell shapes, secret names) fire unconditionally. Danger
// WORDS fire only in action context -- not inside code/quote/quoted-config (a spec, not
// an action). Never throws.
function isChatConsequence(msg) {
  const t = String(msg == null ? "" : msg);
  if (SHELL_SHAPE_RE.test(t) || SECRET_NAME_RE.test(t)) return true;
  const re = new RegExp(ALWAYS_RE.source, ALWAYS_RE.flags.includes("g") ? ALWAYS_RE.flags : ALWAYS_RE.flags + "g");
  let m;
  while ((m = re.exec(t)) !== null) {
    if (!isSpecContext(t, m.index)) return true;
    if (m.index === re.lastIndex) re.lastIndex++; // guard against zero-width match loop
  }
  return false;
}

function consequenceVerdict(msg) {
  const consequential = isChatConsequence(msg);
  return { consequential, reason: consequential ? "consequence" : null };
}

// --- daily spend cap (two axes: dollars AND tokens) ----------------------------------
// overCap iff limits are on AND today's spend already >= a configured cap on EITHER axis.
// `>=` so exactly-at-cap gates. The token axis is the one that bites on a subscription
// box (which records $0). A zero/absent cap on an axis disables that axis (never gates).
function spendVerdict(today, caps, limitsEnabled) {
  if (limitsEnabled === false) return { overCap: false, axis: null };
  const usdCap = caps && Number.isFinite(caps.usdCents) && caps.usdCents > 0 ? caps.usdCents : null;
  const tokCap = caps && Number.isFinite(caps.tokens) && caps.tokens > 0 ? caps.tokens : null;
  const usdOver = usdCap != null && Number.isFinite(today && today.usdCents) && today.usdCents >= usdCap;
  const tokOver = tokCap != null && Number.isFinite(today && today.tokens) && today.tokens >= tokCap;
  if (usdOver) return { overCap: true, axis: "usd" };
  if (tokOver) return { overCap: true, axis: "tokens" };
  return { overCap: false, axis: null };
}

// --- combined gate -------------------------------------------------------------------
// `confirmed` short-circuits both checks (the operator re-sent after the floor delay).
// Consequence is checked before spend. Returns { action:"run" } or
// { action:"gate", code, reason, message } with the phone-facing chat text.
function chatGate({ msg, today, caps, limitsEnabled, confirmed }) {
  if (confirmed) return { action: "run" };
  const c = consequenceVerdict(msg);
  if (c.consequential) {
    return {
      action: "gate", code: "CHAT_CONSEQUENCE_CONFIRM", reason: c.reason,
      message: "⚠ This reads as a consequential action (deploy / delete / send / install / shell / spend / credentials). It was NOT run. Re-send the same message to confirm, or rephrase it to something read-only.",
    };
  }
  const s = spendVerdict(today, caps, limitsEnabled);
  if (s.overCap) {
    const which = s.axis === "usd"
      ? "$" + ((caps.usdCents || 0) / 100).toFixed(2) + "/day"
      : (caps.tokens || 0).toLocaleString() + " tokens/day";
    return {
      action: "gate", code: "CHAT_SPEND_CONFIRM", reason: "daily_cap:" + s.axis,
      message: "⚠ You have reached your daily chat governance cap (" + which + "). This turn was NOT run. Re-send to spend beyond it for today, or raise the cap (cost.chatDailyUsd / cost.chatDailyTokens) in settings.",
    };
  }
  return { action: "run" };
}

// --- confirm window ------------------------------------------------------------------
// A gated message is remembered by a stable (engine, message) key; a re-send of the same
// key confirms ONLY when it lands in the window [floor, window] -- the floor stops an
// instant flaky-phone double-send (or a script) from auto-confirming; the operator must
// have had time to read the warning. Internal whitespace is collapsed so a re-type with
// different spacing still matches.
function confirmKey(msg, engine) {
  return String(engine == null ? "" : engine) + " " + String(msg == null ? "" : msg).trim().replace(/\s+/g, " ");
}
// dt in [floorMs, windowMs] -> a deliberate confirmation. Below the floor (too fast) or
// above the window (stale) -> not a confirmation.
function isConfirmingResend(pendingMs, nowMs, floorMs, windowMs) {
  if (![pendingMs, nowMs, floorMs, windowMs].every(Number.isFinite)) return false;
  const dt = nowMs - pendingMs;
  return dt >= floorMs && dt <= windowMs;
}
// Still worth remembering (could yet confirm): 0 <= dt <= windowMs. Used to prune.
function isFreshPending(pendingMs, nowMs, windowMs) {
  if (![pendingMs, nowMs, windowMs].every(Number.isFinite)) return false;
  const dt = nowMs - pendingMs;
  return dt >= 0 && dt <= windowMs;
}

module.exports = {
  isChatConsequence, consequenceVerdict, spendVerdict, chatGate,
  confirmKey, isConfirmingResend, isFreshPending,
};
