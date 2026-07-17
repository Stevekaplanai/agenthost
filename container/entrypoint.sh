#!/bin/bash
# Runs as root: verify the volume, prepare the volume-backed home, drop to the agent user.
set -euo pipefail

# The persistent volume must actually be mounted; refuse to run on ephemeral disk.
mountpoint -q /data || { echo "[agenthost] FATAL: /data volume is not mounted"; exit 1; }

mkdir -p /data/home/agent
# Ownership fix only on first boot; a recursive chown on every boot gets slow as data grows.
if [ ! -f /data/.owned ]; then
    chown -R agent:agent /data/home/agent
    touch /data/.owned
fi
# The harness may arrive as an image layer (Windows fallback: flyctl sftp stdin is unreliable there)
# Copy when the image's tarball is NEWER too, not only when the volume has
# none -- the old guard meant every re-sync after launch day shipped a fresh
# harness that was silently ignored (operator-brain/vault never landed,
# 2026-07-11). start.sh's -nt check then re-extracts the updated tarball.
# Compare against the .harness-extracted marker too: start.sh deletes the /data
# copy after extraction (no double-storage), so "no /data copy" no longer means
# "never extracted" -- without the marker check every reboot would re-stage the
# stale image tarball and clobber the agent's synced home.
if [ -f /opt/agenthost/harness.tar.gz ]; then
    stage=yes
    [ -f /data/harness.tar.gz ] && ! [ /opt/agenthost/harness.tar.gz -nt /data/harness.tar.gz ] && stage=
    [ -f /data/.harness-extracted ] && ! [ /opt/agenthost/harness.tar.gz -nt /data/.harness-extracted ] && stage=
    if [ -n "$stage" ]; then
        cp /opt/agenthost/harness.tar.gz /data/harness.tar.gz
    fi
fi
[ -f /data/harness.tar.gz ] && chown agent:agent /data/harness.tar.gz
# /data itself must be agent-writable: start.sh (agent user) records the
# .harness-extracted marker there. Root-owned /data meant the marker could
# never be written, so every boot looked like first provisioning and
# re-extracted a stale harness over the agent's live home (2026-07-11).
chown agent:agent /data

# Codex keeps its session "rollout" files under ~/.codex/sessions; the gate
# (agent user) must be able to WRITE them or `codex exec resume` fails with
# "no rollout found" (multi-turn Codex chat breaks). An `ssh console` session
# lands as root, and running codex there once leaves root-owned dirs under
# ~/.codex that the agent can no longer write into. The first-boot chown above
# is marker-gated so it won't repair that. This targeted chown runs every boot
# -- ~/.codex is small, so it's cheap -- to keep Codex's store agent-writable.
[ -d /data/home/agent/.codex ] && chown -R agent:agent /data/home/agent/.codex

export HOME=/data/home/agent
exec setpriv --reuid=agent --regid=agent --init-groups --no-new-privs /bin/bash /opt/agenthost/start.sh
