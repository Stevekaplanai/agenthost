#!/bin/bash
set -u

# Cursor's interactive window gets one provider credential, never the whole box
# environment. start.sh crosses an `env -i` exec boundary before this long-lived
# wrapper starts, so even its initial /proc environment contains no Fly secrets.
# Read CURSOR_API_KEY as data: secrets.env values are not shell.
cursor_key=""
secrets_file="${AGENTHOST_BOX_SECRETS_FILE:-/data/agenthost-secrets/secrets.env}"
if [ -r "$secrets_file" ]; then
    while IFS='=' read -r name value; do
        if [ "$name" = "CURSOR_API_KEY" ]; then cursor_key="$value"; fi
    done < "$secrets_file"
fi
[ -n "$cursor_key" ] && export CURSOR_API_KEY="$cursor_key"

while true; do
    /usr/local/bin/cursor-agent --disable-auto-update --trust --mode ask 2>&1
    if [ -n "$cursor_key" ]; then
        echo "[cursor] exited; restarting in 5s, Ctrl-C for a shell"
    else
        echo "[cursor] no API key -- set the CURSOR_API_KEY secret or log in interactively (restarting in 5s, Ctrl-C for a shell)"
    fi
    /usr/bin/sleep 5 || break
done

unset CURSOR_API_KEY cursor_key
exec /bin/bash
