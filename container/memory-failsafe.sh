#!/bin/bash
# Last-resort availability guard for the always-on box.
#
# This is deliberately a tiny root-owned shell process instead of another Node
# service. It records a bounded, secret-safe memory trend and asks the
# container main process to checkpoint before Linux reaches the OOM killer.
# Fly's explicit on-failure policy then starts the box cleanly.
set -u

MAIN_PID="${1:-}"
case "$MAIN_PID" in
    ''|*[!0-9]*|0) echo "[agenthost-memory] invalid main PID; guard disabled" >&2; exit 0 ;;
esac

[ "${AGENTHOST_MEMORY_FAILSAFE:-on}" != "off" ] || exit 0

uint_or_default() {
    case "$1" in
        ''|*[!0-9]*) printf '%s\n' "$2" ;;
        *) printf '%s\n' "$1" ;;
    esac
}

MIN_AVAILABLE_KB="$(uint_or_default "${AGENTHOST_MEMORY_FAILSAFE_MIN_AVAILABLE_KB:-}" 393216)"
MIN_SWAP_FREE_KB="$(uint_or_default "${AGENTHOST_MEMORY_FAILSAFE_MIN_SWAP_FREE_KB:-}" 262144)"
EMERGENCY_AVAILABLE_KB="$(uint_or_default "${AGENTHOST_MEMORY_FAILSAFE_EMERGENCY_AVAILABLE_KB:-}" 131072)"
EMERGENCY_SWAP_FREE_KB="$(uint_or_default "${AGENTHOST_MEMORY_FAILSAFE_EMERGENCY_SWAP_FREE_KB:-}" 65536)"
LOW_SAMPLES_REQUIRED="$(uint_or_default "${AGENTHOST_MEMORY_FAILSAFE_CONSECUTIVE_LOW_SAMPLES:-}" 4)"
BOOT_GRACE_SECONDS="$(uint_or_default "${AGENTHOST_MEMORY_FAILSAFE_BOOT_GRACE_SECONDS:-}" 600)"
CHECKPOINT_GRACE_SECONDS="$(uint_or_default "${AGENTHOST_MEMORY_FAILSAFE_CHECKPOINT_GRACE_SECONDS:-}" 3)"
INTERVAL_SECONDS="$(uint_or_default "${AGENTHOST_MEMORY_FAILSAFE_INTERVAL_SECONDS:-}" 15)"
HISTORY_INTERVAL_SECONDS="$(uint_or_default "${AGENTHOST_MEMORY_FAILSAFE_HISTORY_INTERVAL_SECONDS:-}" 3600)"
HISTORY_LIMIT="$(uint_or_default "${AGENTHOST_MEMORY_FAILSAFE_HISTORY_LIMIT:-}" 168)"
TEST_MODE=0
[ "${2:-}" = "--test" ] && TEST_MODE=1
TEST_MAX_SAMPLES=0
[ "$TEST_MODE" = "0" ] || TEST_MAX_SAMPLES="$(uint_or_default "${AGENTHOST_MEMORY_FAILSAFE_TEST_MAX_SAMPLES:-}" 0)"

[ "$LOW_SAMPLES_REQUIRED" -gt 0 ] || LOW_SAMPLES_REQUIRED=4
[ "$HISTORY_LIMIT" -gt 0 ] || HISTORY_LIMIT=168
if [ "$EMERGENCY_AVAILABLE_KB" -ge "$MIN_AVAILABLE_KB" ]; then
    EMERGENCY_AVAILABLE_KB=$((MIN_AVAILABLE_KB / 3))
    [ "$EMERGENCY_AVAILABLE_KB" -gt 0 ] || EMERGENCY_AVAILABLE_KB=1
fi
if [ "$EMERGENCY_SWAP_FREE_KB" -ge "$MIN_SWAP_FREE_KB" ]; then
    EMERGENCY_SWAP_FREE_KB=$((MIN_SWAP_FREE_KB / 4))
    [ "$EMERGENCY_SWAP_FREE_KB" -gt 0 ] || EMERGENCY_SWAP_FREE_KB=1
fi

if [ "$TEST_MODE" = "1" ]; then
    HISTORY_FILE="${AGENTHOST_MEMORY_FAILSAFE_HISTORY_FILE:-/tmp/agenthost-memory-samples.log}"
else
    HISTORY_DIR=/data/agenthost-health
    HISTORY_FILE="$HISTORY_DIR/memory-samples.log"
    if [ -L "$HISTORY_DIR" ] || { [ -e "$HISTORY_DIR" ] && [ ! -d "$HISTORY_DIR" ]; }; then
        echo "[agenthost-memory] unsafe history path; persistent trend disabled" >&2
        HISTORY_FILE=
    else
        mkdir -p -- "$HISTORY_DIR" 2>/dev/null || HISTORY_FILE=
        if [ -n "$HISTORY_FILE" ]; then
            history_owner="$(stat -c %u "$HISTORY_DIR" 2>/dev/null || printf '?')"
            if [ "$history_owner" != "0" ]; then
                echo "[agenthost-memory] untrusted history owner; persistent trend disabled" >&2
                HISTORY_FILE=
            else
                chown root:root "$HISTORY_DIR" 2>/dev/null || true
                chmod 0700 "$HISTORY_DIR" 2>/dev/null || true
                if [ -L "$HISTORY_FILE" ] || { [ -e "$HISTORY_FILE" ] && [ ! -f "$HISTORY_FILE" ]; }; then
                    echo "[agenthost-memory] unsafe history file; persistent trend disabled" >&2
                    HISTORY_FILE=
                elif [ -e "$HISTORY_FILE" ] && [ "$(stat -c %u "$HISTORY_FILE" 2>/dev/null || printf '?')" != "0" ]; then
                    echo "[agenthost-memory] untrusted history file owner; persistent trend disabled" >&2
                    HISTORY_FILE=
                else
                    touch "$HISTORY_FILE" 2>/dev/null || HISTORY_FILE=
                    [ -z "$HISTORY_FILE" ] || chmod 0600 "$HISTORY_FILE" 2>/dev/null || true
                fi
            fi
        fi
    fi
fi

read_meminfo() {
    if [ "$TEST_MODE" = "1" ] && [ -n "${AGENTHOST_MEMORY_FAILSAFE_MEMINFO_CMD:-}" ]; then
        "$AGENTHOST_MEMORY_FAILSAFE_MEMINFO_CMD"
    else
        cat /proc/meminfo
    fi
}

safe_processes() {
    if [ "$TEST_MODE" = "1" ] && [ -n "${AGENTHOST_MEMORY_FAILSAFE_PS_CMD:-}" ]; then
        "$AGENTHOST_MEMORY_FAILSAFE_PS_CMD" -eo pid=,rss=,comm= --sort=-rss
    else
        ps -eo pid=,rss=,comm= --sort=-rss
    fi
}

top_summary() {
    safe_processes 2>/dev/null | awk '
        NR <= 5 {
            gsub(/[^[:alnum:]_.:+-]/, "_", $3)
            printf "%s%s/%s/%s", (NR == 1 ? "" : ";"), $1, $2, $3
        }
    '
}

append_history() {
    [ -n "$HISTORY_FILE" ] || return 0
    event="$1"
    available_kb="$2"
    swap_free_kb="$3"
    history_parent="$(dirname -- "$HISTORY_FILE")"
    [ -d "$history_parent" ] || mkdir -p -- "$history_parent" 2>/dev/null || return 0
    history_tmp="${HISTORY_FILE}.tmp.$$"
    uptime_seconds="$(awk '{ print int($1) }' /proc/uptime 2>/dev/null || printf '0')"
    processes="$(top_summary)"
    {
        tail -n "$((HISTORY_LIMIT - 1))" "$HISTORY_FILE" 2>/dev/null || true
        printf '%s event=%s uptime_s=%s available_kb=%s swap_free_kb=%s top=%s\n' \
            "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$event" "$uptime_seconds" \
            "$available_kb" "$swap_free_kb" "$processes"
    } > "$history_tmp" 2>/dev/null || { rm -f -- "$history_tmp"; return 0; }
    chmod 0600 "$history_tmp" 2>/dev/null || true
    mv -f -- "$history_tmp" "$HISTORY_FILE" 2>/dev/null || rm -f -- "$history_tmp"
}

trip() {
    reason="$1"
    available_kb="$2"
    swap_free_kb="$3"
    append_history "trip-$reason" "$available_kb" "$swap_free_kb"
    echo "[agenthost-memory] restarting before OOM: reason=$reason available_kb=$available_kb swap_free_kb=$swap_free_kb" >&2
    safe_processes 2>/dev/null | awk 'NR <= 8 { printf "%s %s %s\n", $1, $2, $3 }' >&2
    kill -USR2 -- "$MAIN_PID" 2>/dev/null || true
    checkpoint_wait="$CHECKPOINT_GRACE_SECONDS"
    while [ "$checkpoint_wait" -gt 0 ] && kill -0 "$MAIN_PID" 2>/dev/null; do
        sleep 1
        checkpoint_wait=$((checkpoint_wait - 1))
    done
    if kill -0 "$MAIN_PID" 2>/dev/null; then
        echo "[agenthost-memory] checkpoint deadline exceeded; forcing restart" >&2
        kill -KILL -- "$MAIN_PID" 2>/dev/null || true
    fi
    exit 0
}

[ "$BOOT_GRACE_SECONDS" -eq 0 ] || sleep "$BOOT_GRACE_SECONDS"

low_samples=0
sample_count=0
last_history_at=0
while kill -0 "$MAIN_PID" 2>/dev/null; do
    meminfo="$(read_meminfo 2>/dev/null || true)"
    available_kb="$(printf '%s\n' "$meminfo" | awk '$1 == "MemAvailable:" { print $2; found=1; exit } END { if (!found) exit 1 }' 2>/dev/null || true)"
    swap_free_kb="$(printf '%s\n' "$meminfo" | awk '$1 == "SwapFree:" { print $2; found=1; exit } END { if (!found) exit 1 }' 2>/dev/null || true)"

    case "$available_kb" in
        ''|*[!0-9]*)
            low_samples=0
            echo "[agenthost-memory] MemAvailable unavailable; sample ignored" >&2
            [ "$INTERVAL_SECONDS" -eq 0 ] || sleep "$INTERVAL_SECONDS"
            continue
            ;;
    esac
    case "$swap_free_kb" in
        ''|*[!0-9]*)
            low_samples=0
            echo "[agenthost-memory] SwapFree unavailable; sample ignored" >&2
            [ "$INTERVAL_SECONDS" -eq 0 ] || sleep "$INTERVAL_SECONDS"
            continue
            ;;
    esac
    sample_count=$((sample_count + 1))

    now="$(date +%s)"
    if [ "$HISTORY_INTERVAL_SECONDS" -eq 0 ] || [ $((now - last_history_at)) -ge "$HISTORY_INTERVAL_SECONDS" ]; then
        append_history sample "$available_kb" "$swap_free_kb"
        last_history_at="$now"
    fi

    if [ "$available_kb" -lt "$EMERGENCY_AVAILABLE_KB" ] &&
        [ "$swap_free_kb" -lt "$EMERGENCY_SWAP_FREE_KB" ]; then
        trip emergency "$available_kb" "$swap_free_kb"
    elif [ "$available_kb" -lt "$MIN_AVAILABLE_KB" ] &&
        [ "$swap_free_kb" -lt "$MIN_SWAP_FREE_KB" ]; then
        low_samples=$((low_samples + 1))
        if [ "$low_samples" -ge "$LOW_SAMPLES_REQUIRED" ]; then
            trip sustained "$available_kb" "$swap_free_kb"
        fi
    else
        low_samples=0
    fi

    if [ "$TEST_MAX_SAMPLES" -gt 0 ] && [ "$sample_count" -ge "$TEST_MAX_SAMPLES" ]; then
        exit 0
    fi
    [ "$INTERVAL_SECONDS" -eq 0 ] || sleep "$INTERVAL_SECONDS"
done

exit 0
