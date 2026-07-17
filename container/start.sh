#!/bin/bash
# Runs as the agent user. Restores the harness, wires credentials, clones repos,
# rebuilds .env files from Fly secrets, starts the agent in tmux, serves it over ttyd.
#
# Env contract (set by the CLI / deploy script as Fly secrets):
#   CLAUDE_CODE_OAUTH_TOKEN - preferred agent auth (claude setup-token output; subscription-billed)
#   ANTHROPIC_API_KEY  - metered fallback auth (one of the two is required for the agent)
#   TTYD_PASSWORD      - required; basic-auth password for the web terminal
#   GITHUB_TOKEN       - optional; fine-grained PAT scoped to the chosen repos
#   REPOS              - optional; comma-separated "owner/name" list, order matters
#   ENVF_<i>__<KEY>    - optional; .env entry KEY for the i-th repo in REPOS
#                        (index-based so repo names with any characters work)
#   BRIDGE_URL         - optional; public URL of a service on the user's desktop
#                        (set by `agenthost bridge`); ~/BRIDGE.md is written so
#                        the agent discovers it
#   BRIDGE_TOKEN       - optional; auth token for BRIDGE_URL (Bearer)
set -uo pipefail

export HOME=/data/home/agent
# Claude Code is root-installed in the image; the agent user can't self-update
# (persistent "Auto-update failed" otherwise). Updates ship via image redeploys.
export DISABLE_AUTOUPDATER=1
cd "$HOME"

# 1. Restore the migrated harness. Re-extracts when a newer tarball is uploaded
#    (manual re-upload or `agenthost sync` both just replace the file).
#    The tarball is deleted once extracted -- the contents already live in $HOME,
#    so keeping it would double-store the harness on the volume. entrypoint.sh
#    compares the image tarball against the .harness-extracted marker (not just
#    the /data copy) so reboots don't re-stage a stale tarball after this delete.
if [ -f /data/harness.tar.gz ]; then
    if [ ! -f /data/.harness-extracted ] || [ /data/harness.tar.gz -nt /data/.harness-extracted ]; then
        echo "[agenthost] restoring harness..."
        if tar -xzf /data/harness.tar.gz -C "$HOME"; then
            touch /data/.harness-extracted
            rm -f /data/harness.tar.gz
        else
            echo "[agenthost] WARN: harness extraction failed; keeping the tarball to retry next boot"
        fi
    else
        rm -f /data/harness.tar.gz
    fi
fi

# 1a. Optional: SEED Claude Code credentials from the CLAUDE_CREDENTIALS Fly
#     secret (opt-in via `deploy --migrate-auth`) -- ONLY on a fresh box that has
#     no ~/.claude/.credentials.json yet. The file travels laptop -> Fly's
#     encrypted store -> here, decoded to 0600.
#
#     CRITICAL: once the box has its own credentials file, NEVER overwrite it.
#     The auth you complete ON the box (browser -> paste-back per MCP) writes real
#     access tokens into this file; the migrated copy usually has none (the
#     laptop keeps live MCP tokens in its OS keychain, which never migrates). An
#     earlier hash-marker guard mis-fired (marker never persisted) and re-restored
#     the tokenless copy on EVERY reboot -- silently wiping every MCP you'd
#     authenticated on the box (all but the most recent). The plain file-exists
#     check below is unconditional and can't mis-fire.
if [ -n "${CLAUDE_CREDENTIALS:-}" ] && [ ! -f "$HOME/.claude/.credentials.json" ]; then
    mkdir -p "$HOME/.claude"
    if printf '%s' "$CLAUDE_CREDENTIALS" | base64 -d > "$HOME/.claude/.credentials.json.tmp" 2>/dev/null; then
        chmod 600 "$HOME/.claude/.credentials.json.tmp"
        mv "$HOME/.claude/.credentials.json.tmp" "$HOME/.claude/.credentials.json"
        echo "[agenthost] seeded ~/.claude/.credentials.json from CLAUDE_CREDENTIALS (fresh box)"
    else
        rm -f "$HOME/.claude/.credentials.json.tmp"
        echo "[agenthost] WARN: CLAUDE_CREDENTIALS was not valid base64; skipped"
    fi
fi

# 1c. Skip Claude Code's first-run wizard. When the box has auth (an OAuth token
#     or migrated credentials), interactive `claude` STILL runs its onboarding
#     (theme + login-method) until ~/.claude.json marks it complete -- and that
#     login step launches a browser OAuth flow that can't be finished from a
#     phone, so the terminal dead-ends on a "paste code" screen even though the
#     token already works for `claude -p`. Marking onboarding complete makes
#     interactive claude use the existing auth and drop straight to a prompt.
#     Idempotent, preserves any existing ~/.claude.json, node is always present.
if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] || [ -n "${ANTHROPIC_API_KEY:-}" ] || [ -f "$HOME/.claude/.credentials.json" ]; then
    mkdir -p "$HOME/.claude"
    CLAUDE_JSON="$HOME/.claude.json" node -e '
        const fs = require("fs");
        const f = process.env.CLAUDE_JSON;
        let j = {};
        try { j = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
        if (j.hasCompletedOnboarding === true && j.theme) process.exit(0); // already good
        j.hasCompletedOnboarding = true;
        if (!j.theme) j.theme = "dark";
        const tmp = f + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(j));
        fs.renameSync(tmp, f);
    ' 2>/dev/null && echo "[agenthost] marked Claude onboarding complete (skips the phone-unfriendly login wizard)" \
      || echo "[agenthost] WARN: could not set onboarding flag in ~/.claude.json; interactive login may prompt"
fi

# 1b. Hermes (beta). If the migrated harness includes a Hermes home, wire it up:
#     rebuild .env from HERMESENV_* Fly secrets, install tools on first boot.
#     Any failure WARNs and continues -- Hermes problems never block Claude Code.
HERMES_READY=0
if [ -f "$HOME/.hermes/config.yaml" ]; then
    export HERMES_HOME="$HOME/.hermes"
    # Rebuild ~/.hermes/.env from HERMESENV_<KEY> secrets (the packed copy was
    # redacted; Fly secrets are the source of truth). NUL-delimited read so
    # multi-line values survive intact.
    hermes_env=""
    while IFS= read -r -d '' entry; do
        name="${entry%%=*}"
        value="${entry#*=}"
        case "$name" in
            HERMESENV_*)
                key="${name#HERMESENV_}"
                hermes_env+="$key=$value"$'\n'
                ;;
        esac
    done < <(env -0)
    if [ -n "$hermes_env" ]; then
        if printf '%s' "$hermes_env" > "$HOME/.hermes/.env" && chmod 600 "$HOME/.hermes/.env"; then
            echo "[agenthost] wrote $HOME/.hermes/.env from HERMESENV_* secrets"
        else
            echo "[agenthost] WARN: failed writing $HOME/.hermes/.env"
        fi
    fi
    # First-boot tool install, marker-guarded so later boots skip it.
    if [ ! -f /data/.hermes-tools ]; then
        echo "[agenthost] installing Hermes tools (uv + hermes-agent, first boot)..."
        if curl -LsSf https://astral.sh/uv/install.sh | sh && "$HOME/.local/bin/uv" tool install hermes-agent; then
            touch /data/.hermes-tools
        else
            echo "[agenthost] WARN: Hermes tool install failed; will retry next boot. Claude Code is unaffected."
        fi
    fi
    if [ -f /data/.hermes-tools ]; then
        HERMES_READY=1
    fi
fi

# 1d. Legal Mode posture. Set by `deploy/sync --legal`: records HOW the
#     no-training requirement was satisfied ("api" = API key under commercial
#     terms; "subscription-attested" = user attested the claude.ai training
#     opt-out). Stated at boot so the posture is visible in logs/terminal.
if [ -n "${LEGAL_MODE:-}" ]; then
    echo "[agenthost] LEGAL MODE: $LEGAL_MODE -- outputs are drafts for attorney review; verify citations before use"
    # Brand for the web UI: gate.js keys the Legal Skills HQ skin (body
    # data-brand="legal", /brand.json, chat-first "/") off this. Its own var so
    # the UI never parses the attestation detail string in LEGAL_MODE; exported
    # here because gate.js is exec'd from this shell (step 6) and inherits it.
    export AGENTHOST_BRAND=legal
fi

# 2. GitHub access.
if [ -n "${GITHUB_TOKEN:-}" ]; then
    export GH_TOKEN="$GITHUB_TOKEN"
    # The official `github` plugin's MCP (api.githubcopilot.com) authenticates
    # with a PAT read from GITHUB_PERSONAL_ACCESS_TOKEN, not GH_TOKEN -- without
    # this the server MCP always fails "not authenticated" even when a token is
    # provided. Reuse the one GitHub token the user handed us for both git and
    # the MCP (only export if they haven't already set it explicitly).
    export GITHUB_PERSONAL_ACCESS_TOKEN="${GITHUB_PERSONAL_ACCESS_TOKEN:-$GITHUB_TOKEN}"
    gh auth setup-git || echo "[agenthost] WARN: gh auth setup-git failed; git pushes will not authenticate"
    git config --global user.name  "${GIT_USER_NAME:-agenthost}"
    git config --global user.email "${GIT_USER_EMAIL:-agent@agenthost.space}"
fi

# 3. Clone selected repos (fresh clones; never copied from the laptop).
mkdir -p "$HOME/work"
REPO_LIST=()
if [ -n "${REPOS:-}" ]; then
    IFS=',' read -ra REPO_LIST <<< "$REPOS"
    for repo in "${REPO_LIST[@]}"; do
        dir="$HOME/work/$(basename "$repo")"
        if [ ! -d "$dir" ]; then
            echo "[agenthost] cloning $repo..."
            git clone "https://github.com/$repo" "$dir" || echo "[agenthost] WARN: clone failed for $repo"
        fi
    done
fi

# 4. Rebuild .env files from ENVF_<index>__<KEY> secrets. Regenerated every boot
#    (Fly secrets are the source of truth), NUL-delimited read so multi-line
#    values (PEM keys, JSON blobs) survive intact.
declare -A envfiles
while IFS= read -r -d '' entry; do
    name="${entry%%=*}"
    value="${entry#*=}"
    case "$name" in
        ENVF_*__*)
            idx="${name#ENVF_}"; idx="${idx%%__*}"
            key="${name#ENVF_${idx}__}"
            repo="${REPO_LIST[$idx]:-}"
            [ -n "$repo" ] || { echo "[agenthost] WARN: $name has no matching repo index in REPOS"; continue; }
            d="$(basename "$repo")"
            if [[ "$value" == *$'\n'* ]]; then
                envfiles[$d]+="$key=\"$value\""$'\n'
            else
                envfiles[$d]+="$key=$value"$'\n'
            fi
            ;;
    esac
done < <(env -0)
for d in "${!envfiles[@]}"; do
    if [ -d "$HOME/work/$d" ]; then
        printf '%s' "${envfiles[$d]}" > "$HOME/work/$d/.env"
        echo "[agenthost] wrote $HOME/work/$d/.env"
    else
        echo "[agenthost] WARN: .env entries for '$d' but no such repo dir under ~/work"
    fi
done

# 4b. Bridge discoverability. `agenthost bridge` on the user's desktop sets
#     BRIDGE_URL (+ optional BRIDGE_TOKEN) as Fly secrets; the agent running
#     here can't be told about them mid-session, so a small ~/BRIDGE.md is the
#     surface it discovers on boot. Regenerated every boot (secrets are the
#     source of truth); removed when the bridge is torn down. The token VALUE
#     never lands in the file -- only the env var name to read it from.
if [ -n "${BRIDGE_URL:-}" ]; then
    {
        echo "# Bridge to your operator's desktop"
        echo
        echo "A service on the desktop that deployed this box is reachable at:"
        echo
        echo "    $BRIDGE_URL"
        echo
        if [ -n "${BRIDGE_TOKEN:-}" ]; then
            echo "Authenticate every request with the token in the BRIDGE_TOKEN env var:"
            echo
            echo '    curl -H "Authorization: Bearer $BRIDGE_TOKEN" '"$BRIDGE_URL"
            echo
        fi
        echo "Notes for the agent reading this:"
        echo "- This is the operator's own machine. Treat data behind this URL as theirs: read/write only what the task at hand calls for."
        echo "- The desktop must be on for the bridge to answer; connection errors usually mean the machine or the service is off, not that the URL changed."
        echo "- Managed by 'agenthost bridge' on the desktop; this file is regenerated on every boot."
    } > "$HOME/BRIDGE.md"
    echo "[agenthost] bridge active -> $BRIDGE_URL (see ~/BRIDGE.md)"
else
    rm -f "$HOME/BRIDGE.md"
fi

# 5. Start the agent inside tmux. If it crashes, restart it; Ctrl-C drops to a shell.
#    Auth: CLAUDE_CODE_OAUTH_TOKEN (subscription token from `claude setup-token`,
#    preferred) or ANTHROPIC_API_KEY (metered fallback); without either, boot a shell.
AGENT_CMD="${AGENT_CMD:-claude --dangerously-skip-permissions}"
if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
    echo "[agenthost] No ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN set; starting a plain shell."
    AGENT_CMD="bash"
fi
tmux new-session -d -s agent -c "$HOME/work" \
    "bash -lc 'while true; do $AGENT_CMD; echo \"[agenthost] agent exited; restarting in 3s (Ctrl-C for a shell)\"; sleep 3 || break; done; exec bash'"
# Mouse mode: NECESSARY but not sufficient for phone scrolling. Verified in the
# sandbox (tmux 3.4): this exact line exits 0 and `show-options -g mouse` says
# "mouse on" (-t is ignored when -g is present, harmlessly). With it, WHEEL
# events from xterm.js enter copy-mode scrollback -- that's desktop. TOUCH
# drags, however, are never converted to mouse-scroll reports by ttyd's
# xterm.js at all (proven with CDP touch against real ttyd 1.7.7-era builds:
# pane_in_mode stayed 0). The phone half of the fix is appshell.js's
# touch->wheel bridge (wireTouchScroll), which needs this option on.
tmux set-option -t agent -g mouse on

# 5a. Terminal apps: extra tmux windows the app switcher can jump to (the gate's
#     APPS list; a tab links /?window=<name> and appshell selects that window).
#     Codex (OpenAI) is baked into the image; run it in a window, dropping to a
#     shell if it exits or isn't logged in yet (so you can `codex login` there).
#     Guarded on the binary existing so a build without it just skips the window.
if command -v codex >/dev/null 2>&1; then
    tmux new-window -t agent -n codex \
        "bash -lc 'while true; do codex 2>&1; echo \"[codex] exited (run codex login to authenticate); restarting in 5s, Ctrl-C for a shell\"; sleep 5 || break; done; exec bash'" \
        || echo "[agenthost] WARN: could not start codex window"
fi

#     Ollama (cloud proxy): serves 127.0.0.1:11434 for every agent on the box
#     -- the gate never exposes it. No model runs on this CPU; the daemon
#     forwards :cloud-tagged models (glm-5.2:cloud, Hermes's LLM) to Ollama's
#     cloud GPUs, billed to the user's own Ollama account. Cloud auth is the
#     Ed25519 keypair at ~/.ollama/id_ed25519 REGISTERED to an ollama.com
#     account (via a one-time `ollama signin`); the local proxy signs each
#     request with it. There is no API-key env var for the proxy path -- until
#     the key is registered, cloud calls 401 but the daemon runs fine.
#     OLLAMA_HOST is pinned to loopback explicitly (like ttyd/hermes below) so
#     an agent-writable dotfile can't flip the default bind to 0.0.0.0 and
#     expose the unauthenticated API across Fly's private network.
#     OLLAMA_CONTEXT_LENGTH=64000 because Hermes needs >=64k and Ollama
#     otherwise silently clamps the window tiny regardless of the client ask.
#     Started BEFORE Hermes so this bundled server owns the port (Hermes
#     otherwise spawns a bare binary that can't reach cloud).
if command -v ollama >/dev/null 2>&1; then
    tmux new-window -t agent -n ollama \
        "bash -lc 'export OLLAMA_HOST=127.0.0.1:11434 OLLAMA_CONTEXT_LENGTH=64000 OLLAMA_MAX_LOADED_MODELS=1 OLLAMA_NUM_PARALLEL=1; while true; do ollama serve 2>&1; echo \"[ollama] exited; restarting in 5s\"; sleep 5; done'" \
        || echo "[agenthost] WARN: could not start ollama window"
    # Optional LOCAL model: set the OLLAMA_LOCAL_MODEL Fly secret (e.g.
    # llama3.2:1b) and the box pulls it onto the volume on boot and serves it
    # from its own CPU -- no cloud account needed. Off by default: unset means
    # pure cloud-proxy (the glm-5.2:cloud path above). Sized for small boxes:
    # a 2GB machine handles ~0.5-1b quantized models; bigger needs more RAM.
    # Guards: wait until the API answers (no blind sleep race), skip with a
    # WARN when /data has <2GB free (a failed pull leaves partial blobs on the
    # same volume everything else writes to), and re-try on the next boot.
    if [ -n "${OLLAMA_LOCAL_MODEL:-}" ]; then
        (
            for _ in $(seq 1 30); do
                curl -sf http://127.0.0.1:11434/api/version >/dev/null 2>&1 && break
                sleep 2
            done
            if ollama list 2>/dev/null | grep -qF "$OLLAMA_LOCAL_MODEL"; then
                echo "[agenthost] local model $OLLAMA_LOCAL_MODEL already present"
            elif [ "$(df -k /data | awk 'NR==2 {print $4}')" -lt 2097152 ]; then
                echo "[agenthost] WARN: skipping local model pull ($OLLAMA_LOCAL_MODEL): <2GB free on /data"
            else
                ollama pull "$OLLAMA_LOCAL_MODEL" \
                    || echo "[agenthost] WARN: local model pull failed; retrying next boot"
            fi
        ) >> "$HOME/.ollama-localmodel.log" 2>&1 &
    fi
fi

# 5b. Hermes WEB DASHBOARD on :9119 (only when the harness shipped a Hermes home
#     and the tools installed). The gate reverse-proxies it at /hermes so it's an
#     app in the switcher, reachable from the phone. We run `hermes dashboard`,
#     NOT `hermes gateway run`: the messaging gateway dies on a missing WhatsApp
#     bridge (bridge script isn't in the uv-installed package, and platforms are
#     loaded from channel/auth state, not just config) -- the dashboard has no
#     such dependency and starts clean. Messaging platforms need interactive
#     QR/bridge setup; do that from the terminal later if wanted. Both windows
#     are backgrounded in a tmux window so a crash is visible but never blocks
#     the terminal (step 6). Failures WARN only.
if [ "$HERMES_READY" = 1 ]; then
    # The dashboard's /api/* routes require a session token (Bearer or ?token=);
    # without HERMES_DASHBOARD_SESSION_TOKEN it mints a RANDOM one the browser
    # can't know, so the SPA's API calls 401 and the UI shows "gateway failed to
    # load". Set a KNOWN token, shared with the gate via a 0600 file, so the gate
    # can inject the Bearer header when it proxies /hermes -> the SPA authorizes.
    HDASH_TOKEN_FILE="$HOME/.claude/agenthost/hermes-dashboard.token"
    if [ ! -s "$HDASH_TOKEN_FILE" ]; then
        mkdir -p "$HOME/.claude/agenthost"
        head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$HDASH_TOKEN_FILE"
        chmod 600 "$HDASH_TOKEN_FILE"
    fi
    HDASH_TOKEN="$(cat "$HDASH_TOKEN_FILE")"
    tmux new-window -t agent -n hermes \
        "bash -lc 'export PATH=\"\$HOME/.local/bin:\$PATH\"; export HOME=$HOME HERMES_HOME=$HOME/.hermes HERMES_DASHBOARD_SESSION_TOKEN=$HDASH_TOKEN; cd $HOME; while true; do hermes dashboard --host 127.0.0.1 --port 9119 --no-open 2>&1 | tee -a $HOME/.hermes/dashboard-boot.log; echo \"[hermes] dashboard exited; restarting in 5s\"; sleep 5; done'" \
        || echo "[agenthost] WARN: could not start Hermes dashboard window"
elif [ -f "$HOME/.hermes/config.yaml" ]; then
    echo "[agenthost] WARN: Hermes harness present but tools not installed; skipping dashboard window"
fi

# 6. Serve the tmux session to any browser. ttyd binds loopback only; the gate
#    on :8080 does cookie/link auth (browser Basic-Auth prompts break on phones:
#    WebKit drops Authorization on WebSocket upgrades).
: "${TTYD_PASSWORD:?TTYD_PASSWORD secret is required}"
# Client options: 15px mono reads well on phones; background matches the
# brand base (#0B0D10) so the app-shell chrome and terminal are seamless.
ttyd -p 7681 -i 127.0.0.1 --writable \
    -t fontSize=15 \
    -t 'theme={"background":"#0B0D10"}' \
    tmux attach-session -t agent &
exec node /opt/agenthost/gate.js
