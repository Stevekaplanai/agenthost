"use strict";
// board-events-lib.js -- PURE mapper from the kanban's own event ledger
// (task_events rows in ~/.hermes/kanban.db) to the audit-entry shape the
// Command Center's Activities feed already renders ({t, event, detail, eng,
// tid} -- the exact shape gate.js's audit() writes, humanized downstream by
// activity-lib.js).
//
// Why this exists (Steve, 2026-07-26 launch eve): board writes made through
// the hermes CLI in chat turns never pass through the gate, so they never
// reach audit.log -- and the operator's feed is built from audit.log alone.
// Cards were being created, claimed, blocked, and completed with the human
// none the wiser ("I don't see the cards change hands, I don't see them move
// on the board"). task_events is the board's complete, already-written ledger
// of every one of those transitions; this module makes it readable by the
// feed. Observation only: it reads a ledger the board already writes, adds no
// writer, and enforces nothing (TRANSCENDENCE P6).
//
// No I/O: gate.js reads the rows (read-only sqlite) and passes them in. Kept
// a separate module so the whole mapping is unit-testable without booting the
// gate, exactly like activity-lib.js.

// Kanban event kind -> feed event name. Names end in suffixes activity-lib's
// levelFor() already classifies (\_blocked -> gate, etc.). Unknown kinds fall
// through to board_card_update so a new kanban verb still surfaces as plain
// words instead of disappearing.
const KIND_EVENT = {
  created: "board_card_created",
  claimed: "board_card_claimed",
  started: "board_card_started",
  commented: "board_card_commented",
  blocked: "board_card_blocked",
  unblocked: "board_card_unblocked",
  status: "board_card_moved",
  assigned: "board_card_reassigned",
  done: "board_card_done",
  completed: "board_card_done",
  archived: "board_card_archived",
};

const ENGINES = new Set(["claude", "hermes", "codex", "gemini", "kimi", "cursor"]);

function iso(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return "";
  try { return new Date(n * 1000).toISOString(); } catch { return ""; }
}

function parsePayload(raw) {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try { const o = JSON.parse(raw); return o && typeof o === "object" ? o : {}; } catch { return {}; }
}

function clip(s, n) {
  const v = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  return v.length > n ? v.slice(0, n - 1) + "…" : v;
}

// Who acted, for the feed's engine coloring AND the per-engine scope filter in
// The generated workspace filters rows to the selected engine; tagging board events with
// the acting/owning engine is what makes them visible in that default view).
// payload.author wins when it names a real engine (comments); otherwise the
// card's assignee owns the event; otherwise the neutral "board" bucket.
function actorFor(kind, payload, assignee) {
  const author = String((payload && payload.author) || "").toLowerCase();
  if (ENGINES.has(author)) return author;
  const owner = String(assignee || (payload && payload.assignee) || "").toLowerCase();
  if (ENGINES.has(owner)) return owner;
  return "board";
}

// One task_events row (joined with its card's title/assignee) -> one
// audit-shaped entry, or null if the row is unusable. Never throws.
function boardEventEntry(row) {
  if (!row || typeof row !== "object") return null;
  const kind = String(row.kind || "").trim().toLowerCase();
  const tid = String(row.task_id || "").trim();
  if (!kind || !tid) return null;
  const payload = parsePayload(row.payload);
  const title = clip(row.title || "(untitled card)", 48);
  const parts = ["“" + title + "”"];
  if (kind === "created") {
    const to = String(payload.assignee || row.assignee || "").toLowerCase();
    if (to) parts.push("→ " + to);
  } else if (kind === "assigned") {
    const to = String(payload.assignee || payload.to || "").toLowerCase();
    if (to) parts.push("→ " + to);
  } else if (kind === "blocked") {
    if (payload.reason) parts.push(clip(payload.reason, 90));
  } else if (kind === "status") {
    const s = payload.to || payload.status;
    if (s) parts.push("→ " + clip(s, 20));
  }
  return {
    t: iso(row.created_at),
    event: KIND_EVENT[kind] || "board_card_update",
    detail: parts.join(" "),
    eng: actorFor(kind, payload, row.assignee),
    tid,
  };
}

// Rows (any order) -> entries, oldest first, nulls dropped.
function boardEventEntries(rows) {
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const e = boardEventEntry(r);
    if (e) out.push(e);
  }
  out.sort((a, b) => (Date.parse(a.t) || 0) - (Date.parse(b.t) || 0));
  return out;
}

// The human labels for these events live in activity-lib.js's LABELS — one
// vocabulary, one place that renders it. This module only maps rows.

module.exports = { boardEventEntry, boardEventEntries, KIND_EVENT };
