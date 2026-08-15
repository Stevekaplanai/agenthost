"use strict";
// activity-lib.js -- PURE audit-log humanizer for the Command Center's live
// Activities feed (CONT UI, Steve 2026-07-24: "make Activities a streaming
// section ... not code coming in but coherent updates that look nice: color
// coded | what happened | task number | what is it | who's assigned").
//
// No I/O: it takes ONE parsed audit entry -- the exact shape gate.js's audit()
// writes, {t, event, detail?, eng?, tid?, ip?} -- and returns a display card
//   { t, level, event, title, who, taskId, detail }
// The gate tails audit.log and streams these over SSE; the generated workspace renders them in
// the pipeline-demo card grammar. Kept a separate module so the whole mapping is
// unit-testable without booting the gate, and so the demo/lead-magnet PWA can
// reuse the exact same vocabulary later.
//
// `level` drives the card color, matching the demo Kimi designed:
//   pass -> green (--ok)      a thing that succeeded / completed
//   gate -> amber (--warn)    a thing paused, held, denied, or awaiting a human
//   fail -> red   (--err)     a hard error / failure
//   info -> neutral           routine activity (a run started, a message handled)

// Explicit "what happened" phrasing for the events worth naming well. Anything
// NOT here falls back to a title-cased version of the raw event name, so a new or
// unknown event still reads as plain words -- never raw snake_case code, which is
// the entire point of the feed. Keep phrases short and past-tense.
const LABELS = {
  // chat
  chat_run: "Answered a chat",
  chat_run_team: "Team chat answered",
  chat_run_cancelled: "Chat run cancelled",
  chat_run_interrupted: "Chat run cut off by a restart",
  chat_upload: "File attached in chat",
  multi_run: "Ran the team in parallel",
  // wake / boot
  wake_checkin: "Woke up and checked in",
  wake_skip: "Skipped a wake check-in",
  wake_fail: "Missed a wake check-in",
  boot_wake: "Gateway rebooted — waking the team",
  gateway_shutdown: "Gateway shutting down",
  // autonomy
  autonomy_run: "Started autonomous work",
  autonomy_blocked: "Autonomous work blocked",
  autonomy_claim_failed: "Couldn't claim a task",
  autonomy_claim_quarantined: "Quarantined a stuck task",
  autonomy_claim_quarantine_skipped: "Skipped a task quarantine",
  autonomy_ledger_refused: "Autonomous run refused by the ledger",
  autonomy_await_review_skipped: "Skipped parking a task for review",
  autonomy_handoff_breaker_error: "Handoff circuit-breaker error",
  autonomy_orphan_claim_protected: "Left an orphan task untouched",
  autonomy_orphan_claim_unknown: "Couldn't read an orphan task's claim",
  cron_run: "Ran a scheduled job",
  // channels
  channel_engine_dispatch: "Handled a channel message",
  channel_reply_sent: "Replied on a channel",
  channel_reply_send_failed: "Couldn't send a channel reply",
  channel_reply_untargeted: "Dropped a reply with no target",
  channel_engine_failed: "Channel engine errored",
  channel_engine_empty_reply: "Channel engine returned nothing",
  channel_engine_ineligible: "Channel had no eligible engine",
  channel_rate_limited: "Rate-limited a channel sender",
  channel_consequence_gated: "Held a channel action for confirmation",
  channel_health_unreachable: "A channel went unreachable",
  channel_health_recovered: "A channel recovered",
  channel_health_watch_error: "Channel health check errored",
  // git ladder
  git_proposal_created: "Opened a code-change proposal",
  git_proposal_create_failed: "Couldn't open a proposal",
  git_proposal_blocked: "Blocked a code-change proposal",
  git_review: "Reviewed a code change",
  git_review_blocked: "Blocked a risky merge",
  git_review_merge_blocked: "Blocked a merge",
  git_review_reject: "Rejected a code change",
  git_review_noverdict: "Review returned no verdict",
  git_review_unavailable: "Couldn't run a review",
  // board — the kanban's own event ledger (task_events via board-events-lib),
  // so CLI-path writes the gate never audits still reach the operator's feed.
  board_card_created: "New card on the board",
  board_card_claimed: "Picked up a card",
  board_card_started: "Started working a card",
  board_card_commented: "Commented on a card",
  board_card_blocked: "Card hit a blocker",
  board_card_unblocked: "Card unblocked",
  board_card_moved: "Card changed columns",
  board_card_reassigned: "Card changed hands",
  board_card_done: "Finished a card",
  board_card_archived: "Card archived",
  board_card_update: "Card updated",
  claim_reaped_on_boot: "Released a stale claim from before the reboot",
  // board
  board_runner_error: "Board runner hit an error",
  board_runner_reject: "Board runner rejected a task",
  board_intent_denied: "Denied a board action",
  board_review_promote_failed: "Couldn't promote a reviewed task",
  board_review_approve_failed: "Couldn't approve a reviewed task",
  board_override_expired: "A manual board override expired",
  board_freeze_claim_store_unavailable: "Couldn't reach the claim store to freeze",
  kanban_cli_error: "The board CLI errored",
  kanban_cli_mismatch: "The board CLI is out of sync",
  // mail
  mail_sent: "Sent an email",
  mail_send_fail: "Couldn't send an email",
  mail_subscribed: "Someone subscribed by email",
  mail_unsubscribed: "Someone unsubscribed",
  // access / config
  login_ok: "Signed in",
  login_fail: "Failed sign-in attempt",
  settings_changed: "Changed settings",
  file_upload: "Uploaded a file",
  file_download: "Downloaded a file",
  secret_: "Stored a secret",
  checkout_completed: "Completed checkout",
  continuity_test_attempt: "Ran a continuity self-test",
};

// Events that succeeded / are good news -> the green "pass" level. Everything
// else is classified by suffix heuristics below.
const GOOD = new Set([
  // The STARTS were here and the COMPLETIONS were not, so a Loop that began read
  // as success while the Loop that actually finished read as neutral info. The
  // terminal events only started existing in #384/#385; adding them here is the
  // other half of those changes. (Kimi flagged it on both.)
  "multi_finished", "cron_finished",
  "chat_run", "chat_run_team", "multi_run", "wake_checkin", "boot_wake",
  "autonomy_run", "cron_run", "channel_engine_dispatch", "channel_reply_sent",
  "channel_health_recovered", "git_proposal_created", "git_review", "mail_sent",
  "board_card_claimed", "board_card_started", "board_card_done", "board_card_unblocked",
  "claim_reaped_on_boot",
  "mail_subscribed", "login_ok", "settings_changed", "file_upload", "file_download",
  "secret_", "checkout_completed",
]);

// Classify any event not explicitly GOOD. Precedence: a hard error (fail) beats a
// paused/held state (gate) beats routine (info). Suffix-based so unknown/future
// events still get a sensible color instead of defaulting to a lie.
function levelFor(event) {
  const e = String(event || "");
  if (GOOD.has(e)) return "pass";
  if (/(_fail|_failed|_error|_unreachable|_mismatch|_lost)$/.test(e)) return "fail";
  if (/(_blocked|_denied|_reject|_rejected|_gated|_held|_capped|_expired|_quarantined|_rate_limited|_suppressed|_refused|_untargeted|_skipped|_unrecorded|_unavailable|_ineligible)$/.test(e)) return "gate";
  return "info";
}

// snake_case event -> "Title Case Words" (the fallback title for unmapped events).
function titleize(event) {
  const s = String(event || "").replace(/_+$/, "").replace(/_/g, " ").trim();
  if (!s) return "Activity";
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

// One audit entry -> one display card (or null if the entry is unusable). Never
// throws: a malformed entry just yields null and is skipped by the feed.
function humanizeAudit(entry) {
  if (!entry || typeof entry !== "object") return null;
  const event = String(entry.event || "").trim();
  if (!event) return null;
  return {
    t: entry.t ? String(entry.t) : "",
    level: levelFor(event),
    event,
    title: LABELS[event] || titleize(event),
    who: entry.eng ? String(entry.eng) : "",
    taskId: entry.tid ? String(entry.tid) : "",
    detail: entry.detail ? String(entry.detail) : "",
  };
}

// Parse one raw audit.log line into a card, or null on any parse failure (a
// partial line caught mid-append, or a corrupt entry). Convenience for the tailer.
function cardFromLine(line) {
  const s = String(line || "").trim();
  if (!s) return null;
  let obj = null;
  try { obj = JSON.parse(s); } catch { return null; }
  return humanizeAudit(obj);
}

module.exports = { humanizeAudit, cardFromLine, levelFor, titleize, LABELS, GOOD };
