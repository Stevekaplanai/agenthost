#!/bin/bash
# tmux-seam.sh -- the gate<->tmux TRUST BOUNDARY for the Foundation B identity split.
#
# WHY THIS EXISTS: under AGENTHOST_FOUNDATION_B=1, gate.js runs as the `gate` uid,
# separate from the `agent` uid that owns the tmux server. That split is the whole
# security property: a compromised gate (it faces the network + untrusted channel
# input) must NOT be able to run code as `agent`. But tmux has no ACLs -- ANY client
# that can reach the tmux server can `send-keys` / `run-shell` = arbitrary code as
# the server's owner. So gate is given NO tmux client capability at all. Instead:
#   - the agent PUBLISHES window state into a file gate can only READ (windows.state)
#   - gate WRITES two fixed verbs into a FIFO the agent drains and RE-VALIDATES here
# The executed tmux command strings live in THIS FILE and are never taken from the
# FIFO. gate can express nothing except "switch to window <validated-name>" and
# "ensure the claude window exists". This is a structural boundary, not a policy one:
# the tmux command language is absent from the gate uid, not filtered.
#
# Runs as the `agent` user (start.sh backgrounds it). Two modes: publish-loop, drain-loop.
set -uo pipefail

SEAM="$HOME/.tmux-seam"
STATE="$SEAM/windows.state"
FIFO="$SEAM/cmd.fifo"
LOG="$SEAM/drain.log"

# --- publisher: agent -> file gate reads ------------------------------------
# Writes "<heartbeat-epoch>\n<name>|<active>\n..." atomically. Unique tmp name per
# cycle (never noclobber-wedges across a crash), swept on entry so a respawn self-
# cleans. mv -f rename is atomic and never follows a destination symlink; gate cannot
# create a symlink in the 2750 seam dir anyway. 1s cadence (30s staleness budget on
# the reader side -- see gate.js SEAM_STALE_MS).
publish_loop() {
  rm -f "$SEAM"/*.tmp 2>/dev/null || true
  local n=0 body tmp
  while true; do
    n=$((n + 1))
    chmod 2750 "$SEAM" 2>/dev/null || true   # defense-in-depth perm re-assert
    tmp="$SEAM/.pub.$$.$RANDOM.$n.tmp"
    if body=$(tmux list-windows -t agent -F '#{window_name}|#{window_active}' 2>/dev/null); then
      { printf '%s\n' "$(date +%s)"; printf '%s\n' "$body"; } > "$tmp" 2>/dev/null \
        && chmod 640 "$tmp" 2>/dev/null \
        && mv -f "$tmp" "$STATE" 2>/dev/null
    fi
    rm -f "$tmp" 2>/dev/null
    sleep 1
  done
}

# --- rate-limited reject path (graft G2) ------------------------------------
# A compromised gate can flood the FIFO. Do NOT append per-line to disk (that is a
# disk-fill amplifier against the volume that holds every credential). Count drops,
# flush at most one line/60s, cap the log, and throttle the read side unconditionally.
DROPS=0
LAST_FLUSH=0
drop() {
  DROPS=$((DROPS + 1))
  local now
  now=$(date +%s)
  if [ $((now - LAST_FLUSH)) -ge 60 ]; then
    printf '%s dropped=%d\n' "$now" "$DROPS" >> "$LOG" 2>/dev/null
    tail -n 200 "$LOG" > "$LOG.t" 2>/dev/null && mv -f "$LOG.t" "$LOG" 2>/dev/null
    DROPS=0
    LAST_FLUSH=$now
  fi
  sleep 0.05
}

# --- drainer: gate -> FIFO the agent executes -------------------------------
# Exactly two verbs. The window name is re-validated HERE (independent of gate.js's
# regex -- do NOT factor them together). new-window's command is a literal in this
# file; zero bytes of it come from the FIFO. exec 3<> keeps the FIFO open RDWR so
# there is no EOF hot-loop and no ENXIO gap between writers. read -n 512 caps a
# hostile long line (fragments fail the case match -> drop).
drain_loop() {
  exec 3<> "$FIFO"
  local line name
  while IFS= read -r -n 512 -u 3 line; do
    case "$line" in
      "ensure-claude")
        if ! tmux list-windows -t agent -F '#{window_name}' 2>/dev/null | grep -qx claude; then
          # -c "$HOME" deliberately, NOT CHAT_CWD: this scratch session must never
          # become the "latest" conversation that chat's -c continues (gate.js:11741).
          # exec bash keeps the window alive after claude exits.
          tmux new-window -t agent -n claude -c "$HOME" 'claude; exec bash' 2>/dev/null
        fi
        tmux select-window -t agent:claude 2>/dev/null
        sleep 0.2
        ;;
      select\ *)
        name="${line#select }"
        # Leading char excluded from '-' so a name can never be read as a tmux
        # option or the '-' last-window token. Independent of gate.js's validator.
        if [[ "$name" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]]; then
          tmux select-window -t "agent:$name" 2>/dev/null
          sleep 0.2
        else
          drop
        fi
        ;;
      *) drop ;;
    esac
  done
}

case "${1:-}" in
  publish-loop) publish_loop ;;
  drain-loop)   drain_loop ;;
  *) echo "usage: tmux-seam.sh publish-loop|drain-loop" >&2; exit 2 ;;
esac
