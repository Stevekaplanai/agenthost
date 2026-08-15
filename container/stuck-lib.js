// stuck-lib.js -- the shared stuck-card detector (Steve, 2026-07-19 bridge note).
// ONE definition of "stuck", pure and dependency-free, so every consumer -- the
// gate's 30-minute sweep today, a Gemini board-runner tomorrow -- flags the same
// cards for the same reasons. This module only DETECTS and FORMATS: it never
// touches the board, the sidecar file, or the network. The gate is the only
// dispatcher (team charter); a stuck card gets a human an ALERT, never an
// auto-fix.
//
// Hermes designed the four rules; they're adapted here to the box's REAL data
// model (the kanban is a FLAT task list -- no parent links, no retry counter --
// so rules 1 and 4 read the orchestrator's sidecar, which is where lineage and
// reject counts actually live):
//   1. dependency-blocked: a queued-ish card whose CHAIN-MATE (same sidecar
//      chainId -- the closest thing the flat board has to a parent/dependency)
//      is blocked or frozen. The work it belongs to is stalled upstream.
//   2. heartbeat-stale:    a running card with no heartbeat for 60+ minutes.
//   3. age-stale:          a queued-ish card sitting 4+ hours, never dispatched.
//   4. retry-loop:         sidecar.rejects[id] >= 3 -- review keeps bouncing it,
//                          which is a structural problem, not a transient one.
//
// Cards that are CORRECTLY waiting are excluded from every rule: parked-for-
// review cards (sidecar.humanReview -- they're with Steve, that's the system
// working) and frozen cards (sidecar.frozen -- the team stopped them on
// purpose; "blocked is a first-class success state").

// The queued-ish statuses (mirrors gate.js BOARD_COLUMN's "queued" bucket).
const STUCK_QUEUED_STATUSES = new Set(["triage", "todo", "scheduled", "ready"]);

const HEARTBEAT_STALE_MS = 60 * 60 * 1000;      // rule 2: 60 min without a pulse
const AGE_STALE_MS = 4 * 60 * 60 * 1000;        // rule 3: 4 h queued, never started
const RETRY_LOOP_MIN = 3;                        // rule 4: 3+ review rejects
const STUCK_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000; // re-alert the SAME card+reason after 6 h at most

// Human-facing labels + suggested actions, per the bridge note's alert format.
const STUCK_REASONS = {
  dependency_blocked: { label: "dependency blocked/frozen", action: "unblock" },
  heartbeat_stale:    { label: "no heartbeat",              action: "check worker" },
  age_stale:          { label: "ready too long",            action: "reassign" },
  retry_loop:         { label: "retry loop",                action: "cancel" },
};

// Timestamp helper: the kanban CLI's JSON carries ISO strings; sidecar entries
// carry epoch ms; be liberal in what we accept. Returns ms or 0.
function stuckTs(v) {
  if (typeof v === "number" && isFinite(v)) return v > 1e12 ? v : v * 1000; // ms vs s
  if (typeof v === "string") { const p = Date.parse(v); if (!isNaN(p)) return p; }
  return 0;
}

// detectStuckCards({ tasks, sidecar, heartbeatAt, nowMs }) -> [{ id, title,
// reason, label, action }], one entry per stuck card, worst reason first
// (retry_loop > dependency_blocked > heartbeat_stale > age_stale -- a card in a
// retry loop is also old; report the structural cause, not the symptom).
//   tasks       -- the `hermes kanban list --json` array (id/title/status/...).
//   sidecar     -- the normalized chains sidecar (taskChain/rejects/humanReview/
//                  frozen/pending).
//   heartbeatAt -- { taskId: ms of last heartbeat } for RUNNING cards, best-
//                  effort (the caller fetches these via `show --json`; a card
//                  with no entry falls back to started_at/created_at).
//   nowMs       -- the caller's clock (injectable so tests are deterministic).
function detectStuckCards(opts) {
  const tasks = Array.isArray(opts && opts.tasks) ? opts.tasks : [];
  const sc = (opts && opts.sidecar) || {};
  const hb = (opts && opts.heartbeatAt) || {};
  const now = (opts && opts.nowMs) || 0;
  const taskChain = sc.taskChain || {};
  const rejects = sc.rejects || {};
  const parked = new Set(Object.keys(sc.humanReview || {}));
  const frozen = new Set(Object.keys(sc.frozen || {}));
  const pending = sc.pending || {};

  // Chains with a blocked or frozen member, for rule 1. A frozen card counts as
  // a stalled upstream even though its kanban status stays `blocked` (the CLI
  // has no frozen verb -- frozen-ness lives in the sidecar overlay).
  const stalledChains = new Set();
  for (const t of tasks) {
    const id = String(t.id);
    if (String(t.status) === "blocked" || frozen.has(id)) {
      const cid = taskChain[id];
      if (cid) stalledChains.add(cid);
    }
  }

  const out = [];
  for (const t of tasks) {
    const id = String(t.id);
    if (parked.has(id) || frozen.has(id)) continue; // correctly waiting -- never "stuck"
    const status = String(t.status || "").toLowerCase();
    const queuedIsh = STUCK_QUEUED_STATUSES.has(status);
    let reason = null;

    // Rule 4 first: structural beats positional.
    if ((rejects[id] || 0) >= RETRY_LOOP_MIN) reason = "retry_loop";
    // Rule 1: queued-ish, and a chain-mate is blocked/frozen.
    else if (queuedIsh && taskChain[id] && stalledChains.has(taskChain[id])) reason = "dependency_blocked";
    // Rule 2: running with a stale (or absent) pulse.
    else if (status === "running") {
      const last = hb[id] || stuckTs(t.started_at) || stuckTs(t.created_at);
      if (last && now - last >= HEARTBEAT_STALE_MS) reason = "heartbeat_stale";
    }
    // Rule 3: queued-ish, old, and genuinely never dispatched (no started_at,
    // no pipeline phase in flight).
    else if (queuedIsh && !stuckTs(t.started_at) && !pending[id]) {
      const born = stuckTs(t.created_at);
      if (born && now - born >= AGE_STALE_MS) reason = "age_stale";
    }

    if (reason) out.push({ id, title: String(t.title || "(untitled)"), reason, label: STUCK_REASONS[reason].label, action: STUCK_REASONS[reason].action });
  }
  const rank = { retry_loop: 0, dependency_blocked: 1, heartbeat_stale: 2, age_stale: 3 };
  return out.sort((a, b) => rank[a.reason] - rank[b.reason]);
}

// stuckAlertDelta(prevAlerts, found, nowMs) -> { toAlert, nextAlerts }. The
// idempotency step (mirrors loopAlerts): a card stuck for 6 hours must NOT
// re-alert every 30-minute sweep. A card alerts when it's newly stuck, its
// REASON changed (a real state change worth a fresh ping), or the cooldown
// elapsed. Cards no longer stuck are pruned, which re-arms them. Pure --
// the caller persists nextAlerts to the sidecar.
function stuckAlertDelta(prevAlerts, found, nowMs) {
  const prev = prevAlerts || {};
  const nextAlerts = {};
  const toAlert = [];
  for (const c of found) {
    const p = prev[c.id];
    const fire = !p || p.reason !== c.reason || nowMs - (p.at || 0) >= STUCK_ALERT_COOLDOWN_MS;
    nextAlerts[c.id] = fire ? { reason: c.reason, at: nowMs } : p;
    if (fire) toAlert.push(c);
  }
  return { toAlert, nextAlerts };
}

// formatStuckAlert(cards) -> the multi-line alert body from the bridge note.
function formatStuckAlert(cards) {
  const lines = ["🟡 STUCK CARD ALERT (" + cards.length + " card" + (cards.length === 1 ? "" : "s") + ")"];
  cards.forEach((c, i) => {
    lines.push((i + 1) + ". " + c.id + " — \"" + c.title.slice(0, 60) + "\"");
    lines.push("   Reason: " + c.label);
    lines.push("   Action: " + c.action);
  });
  return lines.join("\n");
}

module.exports = {
  detectStuckCards, stuckAlertDelta, formatStuckAlert, stuckTs,
  HEARTBEAT_STALE_MS, AGE_STALE_MS, RETRY_LOOP_MIN, STUCK_ALERT_COOLDOWN_MS, STUCK_REASONS,
};
