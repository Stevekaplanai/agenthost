#!/bin/bash
# `claw-setup` -- guided OpenClaw onboarding for the AgentHost box.
#
# OpenClaw is the box's multi-channel messaging gateway: people chat an AI agent
# from Telegram / Discord. (WhatsApp stays with HERMES -- one WhatsApp session
# per host, and Hermes already owns it.) This wrapper does the box-correct parts
# for you -- loopback-only gateway, isolated ~/.openclaw state, reuse a model the
# box already has -- then hands you to OpenClaw's guided channel setup, where you
# paste each channel's bot token.
#
# Installed at /usr/local/bin/claw-setup (see Dockerfile). Safe to re-run.
set -u

HOME_DIR="${HOME:-/data/home/agent}"
# OpenClaw's config file is openclaw.json (verified against the box's pinned version
# openclaw@2026.7.1-2: dist paths.js `CONFIG_FILENAME = "openclaw.json"`, and a real
# `openclaw onboard` writes exactly this file). An earlier config.json here was never read
# or written by OpenClaw -- it made the [ -f "$CONFIG" ] check always false (onboard
# re-ran every time) and, worse, start.sh's matching gate never saw a real config so the
# gateway never started. Keep this name in lockstep with start.sh's openclaw window guard.
CONFIG="$HOME_DIR/.openclaw/openclaw.json"

if [ -t 1 ]; then
    B=$'\033[1m'; ACC=$'\033[38;5;209m'; OK=$'\033[38;5;42m'; WARN=$'\033[38;5;214m'; MUT=$'\033[38;5;244m'; R=$'\033[0m'
else
    B=""; ACC=""; OK=""; WARN=""; MUT=""; R=""
fi

if ! command -v openclaw >/dev/null 2>&1; then
    echo "claw-setup: openclaw is not installed on this box." >&2
    exit 1
fi

echo
echo "${B}${ACC}OpenClaw setup -- your box's Telegram/Discord gateway${R}"
echo "${MUT}WhatsApp stays with Hermes. This sets up Telegram + Discord.${R}"
echo

# --- Step 1: model auth --------------------------------------------------------
# Read only OpenClaw's fixed model credential names from the protected store
# before choosing --auth-choice. The file remains data: secret-env.sh validates
# the whole store atomically and never sources or evaluates its contents.
SECRETS_ENV="${AGENTHOST_BOX_SECRETS_FILE:-/data/agenthost-secrets/secrets.env}"
if ! . /opt/agenthost/secret-env.sh; then
    echo "claw-setup: the protected credential loader is unavailable; onboarding stopped before choosing a model." >&2
    exit 1
fi
if ! agenthost_load_secrets_env "$SECRETS_ENV" GEMINI_API_KEY OPENROUTER_API_KEY OLLAMA_API_KEY CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY; then
    echo "claw-setup: the protected model credential store could not be loaded safely; onboarding stopped before choosing a model." >&2
    exit 1
fi

# For the BROKER, OpenClaw does not need a REAL model credential: the channel-broker
# plugin (before_agent_run) suppresses OpenClaw's own agent for every brokered channel
# (Telegram/Discord), and the real answer comes from an AgentHost engine via the
# gate's /internal/channel-dispatch endpoint -- not from a model configured here.
# CAUTION (proven live, 2026-07-23, openclaw@2026.6.33): OpenClaw resolves the agent
# MODEL before it runs the before_agent_run hook. With NO provider key at all, an
# inbound message dies on ProviderAuthError BEFORE the broker ever fires -- so
# "skip" alone silently breaks relay-only mode. start.sh's openclaw window therefore
# exports a placeholder OPENAI_API_KEY (only when no real key exists) purely to get
# past model RESOLUTION; the broker blocks before any model CALL, so the placeholder
# is never actually used on brokered channels (verified: block reply, zero provider
# attempts -- see scripts/verify-openclaw-seam.mjs).
# A real credential, when present, is handed to OpenClaw anyway (harmless; its agent
# is still suppressed for brokered channels, and it's there for any future
# non-brokered use). Order still follows Cardinal Rule 9: a bring-your-own key beats
# the box's Claude subscription (serving CUSTOMERS through a personal plan is
# resale); Ollama cloud (billed to the user's own account) is a fine middle option.
AUTH_CHOICE=""
AUTH_LABEL=""
if [ -n "${GEMINI_API_KEY:-}" ]; then
    AUTH_CHOICE="gemini-api-key"; AUTH_LABEL="Gemini (your GEMINI_API_KEY)"
elif [ -n "${OPENROUTER_API_KEY:-}" ]; then
    AUTH_CHOICE="openrouter-api-key"; AUTH_LABEL="OpenRouter (your OPENROUTER_API_KEY)"
elif [ -n "${OLLAMA_API_KEY:-}" ]; then
    # Requires the actual cloud credential. The old check looked for
    # ~/.ollama/id_ed25519 -- but that keypair is minted automatically by the
    # LOCAL ollama daemon on first boot, so every fresh box "had ollama cloud"
    # a few minutes after starting and onboard died on the missing
    # OLLAMA_API_KEY (hit for real 2026-07-23, same failure shape as the
    # anthropic-cli binary-vs-credential trap below).
    AUTH_CHOICE="ollama-cloud"; AUTH_LABEL="Ollama cloud (GLM, billed to your Ollama account)"
elif command -v claude >/dev/null 2>&1 \
     && { [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] || [ -n "${ANTHROPIC_API_KEY:-}" ] \
          || [ -f "$HOME_DIR/.claude/.credentials.json" ]; }; then
    # Last resort: the box's Claude subscription. The binary alone is NOT enough --
    # it is baked into every image, so checking `command -v` picked this branch on
    # every fresh box and onboard then died on "requires Claude CLI auth on this
    # host" (hit for real 2026-07-23, fresh volume). Only pick it when a credential
    # actually exists; otherwise fall through to relay-only skip, which works with
    # no model at all. Fine for Steve's OWN use; do NOT use this to serve paying
    # customers (that's subscription resale -- Rule 9).
    AUTH_CHOICE="anthropic-cli"; AUTH_LABEL="Claude CLI (box subscription -- your OWN use only, not customers)"
fi

if [ -z "$AUTH_CHOICE" ]; then
    # No model credential -- fine for the broker: start.sh's gateway window supplies a
    # placeholder key so model RESOLUTION succeeds (required before the hook runs);
    # the broker blocks before any model CALL, so the placeholder is never used.
    AUTH_CHOICE="skip"
    AUTH_LABEL="none -- relay-only (broker suppresses OpenClaw's own agent; placeholder key from start.sh)"
    echo "${MUT}No box model credential found -- onboarding OpenClaw in relay-only mode${R}"
    echo "${MUT}(the broker answers via AgentHost's engines, so no real model key is needed here).${R}"
    echo "${MUT}Want OpenClaw's own agent to answer some channel? Set GEMINI_API_KEY (free tier)${R}"
    echo "${MUT}via the key panel and re-run.${R}"
fi
echo "Model for OpenClaw agents: ${OK}${AUTH_LABEL}${R}"

# --- Step 1b: broker credentials (generated once by the gate) -----------------
# Both credentials live in the dashboard-managed protected store. claw-setup used
# to grep and append that file itself, which could interleave with POST /secret and
# leave duplicate or lost entries. Ask the loopback-only gate endpoint for one
# fixed generate-if-absent operation instead. The request carries no name or value;
# the gate serializes it with dashboard writes and performs the checked, atomic,
# durable replacement. It returns names only, never either token.
PROVISION_PORT="${CHANNEL_DISPATCH_PORT:-8091}"
case "$PROVISION_PORT" in
    ''|*[!0-9]*) echo "claw-setup: CHANNEL_DISPATCH_PORT must be a number from 1 to 65535." >&2; exit 1 ;;
esac
PROVISION_PORT=$((10#$PROVISION_PORT))
if (( PROVISION_PORT < 1 || PROVISION_PORT > 65535 )); then
    echo "claw-setup: CHANNEL_DISPATCH_PORT must be a number from 1 to 65535." >&2
    exit 1
fi
PROVISION_RESPONSE="$(mktemp "${TMPDIR:-/tmp}/agenthost-openclaw-provision.XXXXXX")" || {
    echo "claw-setup: could not create a temporary response file for credential provisioning." >&2
    exit 1
}
trap 'rm -f -- "$PROVISION_RESPONSE"' EXIT
if ! PROVISION_HTTP="$(curl --silent --show-error --request POST \
    --noproxy '*' \
    --connect-timeout 2 --max-time 10 \
    --header 'X-AgentHost-OpenClaw-Setup: 1' \
    --output "$PROVISION_RESPONSE" \
    --write-out '%{http_code}' \
    "http://127.0.0.1:${PROVISION_PORT}/internal/openclaw-secrets/ensure")"; then
    echo "claw-setup: the governance gate could not provision OpenClaw credentials; nothing was reported as saved." >&2
    exit 1
fi
if [ "$PROVISION_HTTP" != "200" ]; then
    PROVISION_CAUSE="$(head -c 2048 "$PROVISION_RESPONSE" | tr '\r\n' ' ')"
    if [ -n "$PROVISION_CAUSE" ]; then
        echo "claw-setup: the governance gate refused OpenClaw credential provisioning: $PROVISION_CAUSE" >&2
    else
        echo "claw-setup: the governance gate refused OpenClaw credential provisioning with HTTP $PROVISION_HTTP and no cause." >&2
    fi
    exit 1
fi
rm -f -- "$PROVISION_RESPONSE"
trap - EXIT

# Load the value only after the gate has acknowledged its durable write. The
# strict data loader rejects malformed/duplicate stores atomically, so a failed
# or raced read cannot turn into a false "ready" message or a partial environment.
if ! agenthost_load_secrets_env "$SECRETS_ENV" OPENCLAW_GATEWAY_TOKEN CHANNEL_DISPATCH_TOKEN; then
    echo "claw-setup: the gate provisioned credentials but the protected store could not be loaded safely; nothing was reported as ready." >&2
    exit 1
fi
echo "${MUT}Gateway and channel-dispatch authentication are ready in the protected box secret store.${R}"

# --- Step 2: onboard auth + gateway (non-interactive, box-correct) ------------
# Loopback-only gateway (never exposed on Fly's private net), token auth from a
# SecretRef env (OPENCLAW_GATEWAY_TOKEN, minted in Step 1b) so no token is written to
# a config file, isolated ~/.openclaw workspace. --skip-channels: channels are the
# interactive step below (each needs a token you paste). --install-daemon so the
# gateway stays alive (start.sh also supervises the window).
if [ -f "$CONFIG" ]; then
    echo "${MUT}OpenClaw already onboarded ($CONFIG). Skipping to channels.${R}"
else
    echo "Onboarding OpenClaw (gateway on 127.0.0.1, isolated state)..."
    if openclaw onboard \
        --non-interactive --accept-risk \
        --auth-choice "$AUTH_CHOICE" \
        --gateway-bind loopback \
        --gateway-auth token \
        --gateway-token-ref-env OPENCLAW_GATEWAY_TOKEN \
        --suppress-gateway-token-output \
        --install-daemon \
        --skip-channels; then
        echo "${OK}Gateway configured.${R}"
    else
        echo "${WARN}onboard failed -- run it yourself to see the prompt:${R}"
        echo "  ${MUT}openclaw onboard --auth-choice $AUTH_CHOICE --gateway-bind loopback --skip-channels${R}"
        exit 1
    fi
fi

# --- Step 2b: wire the AgentHost channel broker plugin into openclaw.json -----
# The broker's decision core (channel-dispatch.js, via gate.js's own
# /internal/channel-dispatch endpoint) does nothing until OpenClaw actually calls
# it. This enables the before_agent_run plugin hook for THIS box: registers the
# plugin's load path, enables the entry, and opts it into raw conversation access
# (required -- non-bundled plugins must ask for before_agent_run access
# explicitly per OpenClaw's own config type). Safe to re-run: the merge
# (openclaw-plugin-config.js) only ever touches this plugin's own keys.
#
# PLUGIN_DIR is a DIRECTORY, not a bare .js file: OpenClaw's loader requires an
# openclaw.plugin.json manifest (+ package.json) alongside the entry and SILENTLY
# IGNORES a bare .js path in plugins.load.paths ("plugin manifest not found").
# Verified against openclaw@2026.7.1-2 -- a bare path meant the plugin never
# loaded and channels bypassed the gate with no error.
PLUGIN_DIR="/opt/agenthost/openclaw-channel-broker"
if [ -f "$PLUGIN_DIR/openclaw.plugin.json" ]; then
    if node /opt/agenthost/openclaw-plugin-config.js "$CONFIG" "$PLUGIN_DIR"; then
        echo "${OK}Channel broker plugin enabled${R} -- Telegram/Discord messages now route through the governance gate."
    else
        echo "${WARN}Could not enable the channel broker plugin -- Telegram/Discord messages will bypass governance until this is fixed.${R}"
    fi
else
    echo "${WARN}Channel broker plugin not found at $PLUGIN_DIR -- rebuild the box image to pick it up.${R}"
fi

# --- Step 3: channels (the human step -- paste your bot tokens) ---------------
echo
echo "${B}Next: connect a channel.${R} OpenClaw opens a guided setup where you paste"
echo "each channel's bot token. Get a token first:"
echo "  ${ACC}Telegram${R}  ${MUT}-> message @BotFather, /newbot, copy the token${R}"
echo "  ${ACC}Discord${R}   ${MUT}-> Discord Developer Portal -> New Application -> Bot ->${R}"
echo "            ${MUT}copy token, and turn ON 'Message Content Intent'${R}"
echo "  ${WARN}(WhatsApp: use the Hermes tab instead -- not OpenClaw on this box.)${R}"
echo
printf "Open guided channel setup now? [Y/n] "
read -r ans
case "$ans" in
    [Nn]*) echo "Skipped. Run ${B}openclaw channels add${R} when ready." ;;
    *)     openclaw channels add ;;
esac

# --- Step 4: hand the just-written channel config to the gate (Foundation B) ---
# The protected secret file is already gate:boxstate 0660 from root boot and is
# intentionally NOT chmodded here: the agent may edit the file but cannot rename
# its gate-owned parent. openclaw.json is still agent-created, so share that
# config with boxstate now to avoid a dead channel until the next reboot.
if [ "${AGENTHOST_FOUNDATION_B:-}" = "1" ] && getent group boxstate >/dev/null 2>&1; then
    if [ -d "$HOME_DIR/.openclaw" ]; then
        chgrp boxstate "$HOME_DIR/.openclaw" 2>/dev/null && chmod g+rwxs "$HOME_DIR/.openclaw" 2>/dev/null || true
    fi
    if [ -f "$CONFIG" ]; then
        chgrp boxstate "$CONFIG" 2>/dev/null && chmod g+rw "$CONFIG" 2>/dev/null || true
    fi
    echo "${MUT}Shared channel config with the governance gate (no reboot needed).${R}"
fi

echo
echo "${MUT}After adding a channel, restart the openclaw tmux window so the gateway${R}"
echo "${MUT}picks it up. Check status: ${R}${B}openclaw channels status${R}"
