"use strict";
// Board card actions: the small, exact set of transitions the board can actually
// perform, and how each maps to `hermes kanban` argv.
//
// WHY THIS IS A VERB LIST AND NOT A COLUMN MODEL
//
// The N4 brief specifies drag-and-drop between five columns. The board has no such
// operation. `hermes kanban` exposes VERBS -- promote, block, unblock, complete,
// archive -- each with its own arguments, and there is no "set this card's column"
// anywhere in the CLI. Building drag-to-any-column would mean inventing transitions
// the board does not have: the drop would either do nothing or do something other
// than what the column implies, and it would look like it worked either way.
//
// So the UI exposes what exists. That is smaller, it cannot misrepresent the board,
// and every action a human can tap is one the CLI will actually accept.
//
// Every signature below was read from `hermes kanban <verb> --help` on the live box
// on 2026-08-09 rather than assumed -- including that `block` takes --kind from a
// fixed set, `unblock` takes --reason (not a positional), and `complete` takes
// --result. Encoding a flag that does not exist produces a usage screen and an
// exit 0-ish failure that reads like success, which is the failure class this
// project has spent two days removing.

// Free-text a human may attach. Bounded because it becomes an argv element and ends
// up in the audit log; long text there is a readability problem, not a safety one.
const REASON_MAX = 500;

// `block --kind` is a CLOSED set in the CLI. Sending anything else makes argparse
// print usage and exit non-zero, which the caller would surface as a generic
// failure rather than "that is not a valid kind" -- so validate it here where the
// message can be specific.
const BLOCK_KINDS = ["capability", "dependency", "needs_input", "transient"];

const ACTIONS = {
  // task_id [reason ...]  -- reason is POSITIONAL for promote.
  promote: { verb: "promote", reason: "positional", label: "Promote" },
  // task_id [reason ...] [--kind ...]
  block: { verb: "block", reason: "positional", kind: true, label: "Block" },
  // task_ids ... [--reason REASON]  -- reason is a FLAG here, not positional.
  unblock: { verb: "unblock", reason: "flag:--reason", label: "Unblock" },
  // task_ids ... [--result RESULT]
  complete: { verb: "complete", reason: "flag:--result", label: "Complete" },
  // task_ids ...   (no reason accepted at all)
  archive: { verb: "archive", reason: null, label: "Archive" },
};

function actionNames() { return Object.keys(ACTIONS); }

// Returns { args } for hermesKanban(), or { error } with a message an operator can
// act on. Never throws, never partially builds: a rejected action must not reach
// the CLI at all.
function boardActionArgs(taskId, action, opts) {
  const id = String(taskId == null ? "" : taskId);
  // The board charset INCLUDES "-", so a bare shape check would accept an id like
  // "-x" and hand argparse a flag instead of a task. Caught by its own test rather
  // than in production: the same argv-injection vector the create route closes on
  // titles, arriving through the id instead. Leading dash is refused separately
  // from the shape so the message says which rule was broken.
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    return { error: "task id must match the board's id shape" };
  }
  if (id.startsWith("-")) {
    return { error: "task id cannot start with a dash" };
  }
  const name = String(action == null ? "" : action).trim().toLowerCase();
  const spec = Object.prototype.hasOwnProperty.call(ACTIONS, name) ? ACTIONS[name] : null;
  if (!spec) {
    return { error: "action must be one of: " + actionNames().join(", ") };
  }

  const rawReason = opts && typeof opts.reason === "string" ? opts.reason.trim() : "";
  if (rawReason.length > REASON_MAX) {
    return { error: "reason must be " + REASON_MAX + " characters or fewer" };
  }
  // A leading dash would be parsed as one of the CLI's own flags -- the same argv
  // injection the create route already rejects on titles. Verified there:
  // title="--max-runtime" hits the usage screen, not a task. spawn uses an argv
  // array and never a shell, so this is the remaining vector.
  if (rawReason.startsWith("-")) {
    return { error: "reason cannot start with a dash" };
  }
  if (rawReason && spec.reason === null) {
    return { error: spec.verb + " does not take a reason" };
  }

  const args = [spec.verb, id];

  if (spec.kind) {
    const kind = opts && typeof opts.kind === "string" ? opts.kind.trim().toLowerCase() : "";
    if (kind) {
      if (!BLOCK_KINDS.includes(kind)) {
        return { error: "kind must be one of: " + BLOCK_KINDS.join(", ") };
      }
      args.push("--kind", kind);
    }
  }

  if (rawReason) {
    if (spec.reason === "positional") args.push(rawReason);
    else if (typeof spec.reason === "string" && spec.reason.startsWith("flag:")) {
      args.push(spec.reason.slice("flag:".length), rawReason);
    }
  }
  return { args };
}

module.exports = { ACTIONS, BLOCK_KINDS, REASON_MAX, actionNames, boardActionArgs };
