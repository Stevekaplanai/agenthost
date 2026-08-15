#!/bin/bash

# Load selected credentials from the protected NAME=value store as data. The
# file is never sourced or evaluated: quoted export assignments preserve
# metacharacters literally, and callers name the exact credentials they need.
agenthost_load_secrets_env() {
    local secrets_file="${1:-}"
    shift || true
    local line="" name="" value="" line_number=0 index declaration flags
    local -a names=()
    local -a values=()
    local -A seen=()
    local -A allowed=()

    if [ -z "$secrets_file" ]; then
        echo "[agenthost] WARN: box secret file path is empty; no box secrets were loaded" >&2
        return 1
    fi
    for name in "$@"; do
        if [[ ! "$name" =~ ^[A-Z][A-Z0-9_]{1,55}_(API_KEY|TOKEN|SECRET)$ ]]; then
            echo "[agenthost] WARN: requested box secret name $name is not a credential selector; no box secrets were loaded" >&2
            return 1
        fi
        allowed["$name"]=1
    done
    if [ -L "$secrets_file" ]; then
        echo "[agenthost] WARN: box secret file is a symbolic link; no box secrets were loaded" >&2
        return 1
    fi
    [ -e "$secrets_file" ] || return 0
    if [ ! -f "$secrets_file" ] || [ ! -r "$secrets_file" ]; then
        echo "[agenthost] WARN: box secret file is not a readable regular file; no box secrets were loaded" >&2
        return 1
    fi

    while IFS= read -r line || [ -n "$line" ]; do
        line_number=$((line_number + 1))
        line="${line%$'\r'}"
        [ -z "$line" ] && continue
        case "$line" in
            *=*) ;;
            *)
                echo "[agenthost] WARN: box secret file has a malformed entry at line $line_number; no box secrets were loaded" >&2
                return 1
                ;;
        esac

        name="${line%%=*}"
        value="${line#*=}"
        if [[ ! "$name" =~ ^[A-Z][A-Z0-9_]{2,63}$ ]]; then
            echo "[agenthost] WARN: box secret file has an invalid name at line $line_number; no box secrets were loaded" >&2
            return 1
        fi
        if [ "$name" = "GIT_PUSH_TOKEN" ]; then
            echo "[agenthost] WARN: box secret file contains gate-only name GIT_PUSH_TOKEN; no box secrets were loaded" >&2
            return 1
        fi
        if [ -z "${value//[[:space:]]/}" ]; then
            echo "[agenthost] WARN: box secret $name has an empty value; no box secrets were loaded" >&2
            return 1
        fi
        if [ -n "${seen[$name]+present}" ]; then
            echo "[agenthost] WARN: box secret file contains duplicate name $name; no box secrets were loaded" >&2
            return 1
        fi

        seen["$name"]=1
        if [ -n "${allowed[$name]+selected}" ]; then
            names+=("$name")
            values+=("$value")
        fi
    done < "$secrets_file"

    # Preflight every selected target before changing the caller's environment.
    # Bash readonly, array, integer, case-converting, and nameref variables can
    # reject or transform an assignment. Refuse the whole load before exporting
    # the first value so a corrupt caller state can never produce a partial env.
    for index in "${!names[@]}"; do
        name="${names[$index]}"
        if declaration="$(declare -p "$name" 2>/dev/null)"; then
            flags=""
            if [[ "$declaration" =~ ^declare\ -([^[:space:]]+) ]]; then
                flags="${BASH_REMATCH[1]}"
            fi
            if [ "$flags" != "-" ] && [ "$flags" != "x" ]; then
                echo "[agenthost] WARN: box secret $name cannot replace the existing shell variable safely; no box secrets were loaded" >&2
                return 1
            fi
        fi
    done

    for index in "${!names[@]}"; do
        export "${names[$index]}=${values[$index]}" || {
            echo "[agenthost] WARN: box secret ${names[$index]} could not enter the environment" >&2
            return 1
        }
    done
}
