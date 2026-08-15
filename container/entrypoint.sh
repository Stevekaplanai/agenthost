#!/bin/bash -p
# Runs as root: verify the volume, prepare the volume-backed home, drop to the agent user.
# Inherited shell options must neither trace nor export the token latch below.
set +x
set +a
set -euo pipefail
unset NODE_OPTIONS NODE_PATH NODE_INSPECT_RESUME_ON_START LD_PRELOAD LD_LIBRARY_PATH BASH_ENV ENV PYTHONPATH PS4
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Hold the write credential only in this root shell until the exact Foundation-B
# boot exec. Shell-local variables are not inherited by any helper below.
unset gate_push_token_present gate_push_token_value
gate_push_token_present=
gate_push_token_value=
if [ "${GIT_PUSH_TOKEN+x}" = x ]; then
    gate_push_token_present=1
    gate_push_token_value="$GIT_PUSH_TOKEN"
fi
unset GIT_PUSH_TOKEN

# The persistent volume must actually be mounted; refuse to run on ephemeral disk.
mountpoint -q /data || { echo "[agenthost] FATAL: /data volume is not mounted"; exit 1; }

mkdir -p /data/home/agent
# The agent's boot state (harness tarball + first-boot markers) lives HERE, under
# the agent home, NOT loose in /data. /data itself must stay root:root 0755 so the
# Foundation B native authority's open_trusted_dirs() guard accepts it
# (maintenance-native.c: /data must be root:root 0755). Anything the agent user
# has to write or delete goes in this dir, which is agent-owned; root can still
# read the markers from here. (2026-07-25: this collision — agent-writable /data
# vs. root-owned /data — was the real Foundation B flip blocker.)
BOOT_DIR=/data/home/agent/.agenthost-boot
mkdir -p "$BOOT_DIR"
# Ownership fix only on first boot; a recursive chown on every boot gets slow as data grows.
if [ ! -f /data/.owned ]; then
    chown -R agent:agent /data/home/agent
    touch /data/.owned
fi
# One-time migration for boxes provisioned before the boot state moved off /data:
# relocate any legacy /data markers + tarball into $BOOT_DIR so this boot doesn't
# look like first-provisioning and re-extract a stale harness or re-run installs.
# Idempotent (only moves what exists), best-effort (a failure just means the agent
# side re-derives the marker), and runs before the staging check below reads them.
for legacy in .harness-extracted .starter-stack .hermes-tools harness.tar.gz; do
    [ -e "/data/$legacy" ] && [ ! -e "$BOOT_DIR/$legacy" ] && mv "/data/$legacy" "$BOOT_DIR/$legacy" 2>/dev/null || true
done
# The harness may arrive as an image layer (Windows fallback: flyctl sftp stdin is unreliable there)
# Copy when the image's tarball is NEWER too, not only when the volume has
# none -- the old guard meant every re-sync after launch day shipped a fresh
# harness that was silently ignored (operator-brain/vault never landed,
# 2026-07-11). start.sh's -nt check then re-extracts the updated tarball.
# Compare against the .harness-extracted marker too: start.sh deletes the
# $BOOT_DIR copy after extraction (no double-storage), so "no copy" no longer
# means "never extracted" -- without the marker check every reboot would re-stage
# the stale image tarball and clobber the agent's synced home.
if [ -f /opt/agenthost/harness.tar.gz ]; then
    stage=yes
    [ -f "$BOOT_DIR/harness.tar.gz" ] && ! [ /opt/agenthost/harness.tar.gz -nt "$BOOT_DIR/harness.tar.gz" ] && stage=
    [ -f "$BOOT_DIR/.harness-extracted" ] && ! [ /opt/agenthost/harness.tar.gz -nt "$BOOT_DIR/.harness-extracted" ] && stage=
    if [ -n "$stage" ]; then
        cp /opt/agenthost/harness.tar.gz "$BOOT_DIR/harness.tar.gz"
    fi
fi
[ -f "$BOOT_DIR/harness.tar.gz" ] && chown agent:agent "$BOOT_DIR/harness.tar.gz"
# /data itself stays root:root 0755 — the Foundation B native authority verifies
# exactly this (maintenance-native.c open_trusted_dirs) and rejects any other
# owner/mode as tampering. The agent no longer writes into /data directly (its
# markers moved to $BOOT_DIR above), so it does not need to own /data. This is
# the fix for the 2026-07-25 flip blocker; the 2026-07-11 stale-harness bug is
# still handled because the .harness-extracted marker now lives in the
# agent-owned $BOOT_DIR, which the agent can always write.
chown root:root /data
chmod 0755 /data

# Operator Creative reviews are gate-only state. The parent lives directly
# under root-owned /data, so the agent cannot rename either ancestor and race a
# privileged sidecar write into another tree.
ARTIFACT_REVIEW_ROOT=/data/agenthost-gate-state
ARTIFACT_REVIEW_DIR="$ARTIFACT_REVIEW_ROOT/artifact-reviews"
AGENTHOST_ARTIFACT_ARCHIVE_DIR="$ARTIFACT_REVIEW_ROOT/artifact-archive"
AUTH_STATE_DIR="$ARTIFACT_REVIEW_ROOT/auth"
LEGACY_AUTH_STATE_DIR=/data/home/agent/.claude/agenthost
QA_RESULT_DIR="$ARTIFACT_REVIEW_ROOT/qa"
QA_EVIDENCE_DIR="$QA_RESULT_DIR/evidence"
AGENTHOST_CODE_MAP_STATE_DIR="$ARTIFACT_REVIEW_ROOT/code-maps"
AGENTHOST_DEEPSEEK_BUDGET_STATE_DIR="$ARTIFACT_REVIEW_ROOT/deepseek-budget"
if [ "${AGENTHOST_FOUNDATION_B:-}" = "1" ]; then
    artifact_review_owner=gate
    auth_transition_mode=foundation
else
    # The flag-off box has no separate gate uid at runtime: gate.js is agent.
    # Preserve that legacy single-identity path without weakening Foundation B.
    artifact_review_owner=agent
    auth_transition_mode=legacy
fi
gate_state_fatal() {
    echo "[agenthost] FATAL: $1" >&2
    exit 1
}

# Authentication is its own trust domain. The root-only helper runs before any
# agent process starts, retains only a password fingerprint, and replaces the
# whole legacy auth directory without reading its leaves. Foundation activation
# therefore cannot bless an agent-chosen cookie secret or 2FA seed. The first
# protected boot stays login-blocked until TTYD_PASSWORD changes; after that,
# the operator explicitly chooses key-only recovery and re-enrolls 2FA.
: "${TTYD_PASSWORD:?TTYD_PASSWORD secret is required}"
auth_owner_uid="$(id -u "$artifact_review_owner")" \
    || gate_state_fatal "could not resolve the authentication-state uid"
auth_owner_gid="$(id -g "$artifact_review_owner")" \
    || gate_state_fatal "could not resolve the authentication-state gid"
legacy_gate_uid="$(id -u gate)" \
    || gate_state_fatal "could not resolve the legacy gate uid"
legacy_agent_uid="$(id -u agent)" \
    || gate_state_fatal "could not resolve the legacy agent uid"
/usr/local/bin/node /opt/agenthost/maintenance-auth-state.js \
    --mode "$auth_transition_mode" \
    --uid "$auth_owner_uid" \
    --gid "$auth_owner_gid" \
    --root "$ARTIFACT_REVIEW_ROOT" \
    --auth "$AUTH_STATE_DIR" \
    --legacy-auth "$LEGACY_AUTH_STATE_DIR" \
    --legacy-gate-uid "$legacy_gate_uid" \
    --legacy-agent-uid "$legacy_agent_uid" \
    || gate_state_fatal "could not reconcile the protected authentication state"

# Activation and rollback select different uids, but the volume survives both.
# Validate the whole existing tree before root changes any entry: never follow a
# symlink, descend across a filesystem boundary, or chown a hard-linked file.
# PID 1 runs this before either selected uid starts, so the check cannot race a writer.
if [ -e "$ARTIFACT_REVIEW_ROOT" ] || [ -L "$ARTIFACT_REVIEW_ROOT" ]; then
    [ -d "$ARTIFACT_REVIEW_ROOT" ] && [ ! -L "$ARTIFACT_REVIEW_ROOT" ] \
        || gate_state_fatal "private gate-state root is not a regular directory"
    unsafe_gate_state_path="$(find -P "$ARTIFACT_REVIEW_ROOT" -xdev -type l -print -quit)" \
        || gate_state_fatal "could not inspect private gate state for symbolic links"
    [ -z "$unsafe_gate_state_path" ] \
        || gate_state_fatal "refusing symlinked gate-state entry"
    unsafe_gate_state_path="$(find -P "$ARTIFACT_REVIEW_ROOT" -xdev ! -type d ! -type f -print -quit)" \
        || gate_state_fatal "could not inspect private gate-state entry types"
    [ -z "$unsafe_gate_state_path" ] \
        || gate_state_fatal "gate-state entry is neither a directory nor a regular file"
    unsafe_gate_state_path="$(find -P "$ARTIFACT_REVIEW_ROOT" -xdev -type f ! -links 1 -print -quit)" \
        || gate_state_fatal "could not inspect private gate-state link counts"
    [ -z "$unsafe_gate_state_path" ] \
        || gate_state_fatal "gate-state file has multiple hard links"
fi
# The top-level directory is a permanent root-owned, non-listable anchor. The
# selected runtime uid owns only the fixed children, so flag-off can write its
# state without gaining rename authority over auth/qa/review sibling paths.
install -d -o root -g root -m 0711 "$ARTIFACT_REVIEW_ROOT" \
    || gate_state_fatal "could not create the private gate-state root"
for review_dir in "$ARTIFACT_REVIEW_DIR" "$QA_RESULT_DIR" "$QA_EVIDENCE_DIR"; do
    [ ! -L "$review_dir" ] \
        || gate_state_fatal "refusing symlinked artifact review directory $review_dir"
    [ ! -e "$review_dir" ] || [ -d "$review_dir" ] \
        || gate_state_fatal "artifact review path is not a directory: $review_dir"
    install -d -o "$artifact_review_owner" -g "$artifact_review_owner" -m 0700 "$review_dir" \
        || gate_state_fatal "could not create artifact review directory $review_dir"
done

# Archived artifacts are private gate state, never a child of the public broker
# directory. The fixed root-owned anchor prevents the runtime uid from swapping
# this sibling before a privileged boot reconciliation.
[ ! -L "$AGENTHOST_ARTIFACT_ARCHIVE_DIR" ] \
    || gate_state_fatal "refusing symlinked artifact archive directory"
[ ! -e "$AGENTHOST_ARTIFACT_ARCHIVE_DIR" ] || [ -d "$AGENTHOST_ARTIFACT_ARCHIVE_DIR" ] \
    || gate_state_fatal "artifact archive path is not a directory"
install -d -o "$artifact_review_owner" -g "$artifact_review_owner" -m 0700 "$AGENTHOST_ARTIFACT_ARCHIVE_DIR" \
    || gate_state_fatal "could not create the artifact archive directory"

# Graphify writes only beneath this fixed runtime-owned child. The root anchor
# is non-writable, so another state consumer cannot swap the directory entry.
[ ! -L "$AGENTHOST_CODE_MAP_STATE_DIR" ] \
    || gate_state_fatal "refusing symlinked code-map state directory"
[ ! -e "$AGENTHOST_CODE_MAP_STATE_DIR" ] || [ -d "$AGENTHOST_CODE_MAP_STATE_DIR" ] \
    || gate_state_fatal "code-map state path is not a directory"
install -d -o "$artifact_review_owner" -g "$artifact_review_owner" -m 0700 "$AGENTHOST_CODE_MAP_STATE_DIR" \
    || gate_state_fatal "could not create the code-map state directory"

# DeepSeek's hard spending authority is separate from agent-visible usage data.
# The fixed root anchor prevents the agent uid from swapping this gate-owned
# child. It remains gate-owned even while Foundation B is off, so a flag flip
# can never bless an agent-reset spending ledger.
[ ! -L "$AGENTHOST_DEEPSEEK_BUDGET_STATE_DIR" ] \
    || gate_state_fatal "refusing symlinked DeepSeek budget state directory"
[ ! -e "$AGENTHOST_DEEPSEEK_BUDGET_STATE_DIR" ] || [ -d "$AGENTHOST_DEEPSEEK_BUDGET_STATE_DIR" ] \
    || gate_state_fatal "DeepSeek budget state path is not a directory"
install -d -o gate -g gate -m 0700 "$AGENTHOST_DEEPSEEK_BUDGET_STATE_DIR" \
    || gate_state_fatal "could not create the DeepSeek budget state directory"

# Reconcile only the fixed child trees. Never chown the root anchor to either
# runtime uid: directory write permission on the root would let that uid unlink
# or replace protected sibling directories regardless of the siblings' modes.
for private_tree in "$ARTIFACT_REVIEW_DIR" "$AGENTHOST_ARTIFACT_ARCHIVE_DIR" "$QA_RESULT_DIR" "$AGENTHOST_CODE_MAP_STATE_DIR"; do
    find -P "$private_tree" -xdev -type d -print0 \
        | xargs -0 -r chown "$artifact_review_owner:$artifact_review_owner" -- \
        || gate_state_fatal "could not restore private gate-state directory ownership"
    find -P "$private_tree" -xdev -type d -print0 \
        | xargs -0 -r chmod 0700 -- \
        || gate_state_fatal "could not restore private gate-state directory permissions"
    find -P "$private_tree" -xdev -type f -links 1 -print0 \
        | xargs -0 -r chown "$artifact_review_owner:$artifact_review_owner" -- \
        || gate_state_fatal "could not restore private gate-state file ownership"
    find -P "$private_tree" -xdev -type f -links 1 -print0 \
        | xargs -0 -r chmod 0600 -- \
        || gate_state_fatal "could not restore private gate-state file permissions"
done
# The spending ledger never follows the flag-selected review owner. Reconcile
# its fixed tree to gate:gate after the same whole-root no-link/type checks.
deepseek_budget_tree="$AGENTHOST_DEEPSEEK_BUDGET_STATE_DIR"
find -P "$deepseek_budget_tree" -xdev -type d -print0 \
    | xargs -0 -r chown gate:gate -- \
    || gate_state_fatal "could not restore DeepSeek budget directory ownership"
find -P "$deepseek_budget_tree" -xdev -type d -print0 \
    | xargs -0 -r chmod 0700 -- \
    || gate_state_fatal "could not restore DeepSeek budget directory permissions"
find -P "$deepseek_budget_tree" -xdev -type f -links 1 -print0 \
    | xargs -0 -r chown gate:gate -- \
    || gate_state_fatal "could not restore DeepSeek budget file ownership"
find -P "$deepseek_budget_tree" -xdev -type f -links 1 -print0 \
    | xargs -0 -r chmod 0600 -- \
    || gate_state_fatal "could not restore DeepSeek budget file permissions"
chown root:root "$ARTIFACT_REVIEW_ROOT" && chmod 0711 "$ARTIFACT_REVIEW_ROOT" \
    || gate_state_fatal "could not protect the private gate-state root"

unset unsafe_gate_state_path private_tree deepseek_budget_tree auth_transition_mode auth_owner_uid auth_owner_gid legacy_gate_uid legacy_agent_uid
export AGENTHOST_ARTIFACT_ARCHIVE_DIR
export AGENTHOST_ARTIFACT_REVIEW_DIR="$ARTIFACT_REVIEW_DIR"
export AGENTHOST_AUTH_STATE_DIR="$AUTH_STATE_DIR"
export AGENTHOST_CODE_MAP_STATE_DIR
export AGENTHOST_DEEPSEEK_BUDGET_STATE_DIR

# Box secret store: keep the directory entry outside the agent-owned HOME.
# Foundation B gives the gate ownership of the 0750 parent and shares only the
# existing 0660 file with boxstate. The agent can use ordinary credentials but
# cannot rename/swap the file before a privileged gate write. Flag-off keeps the
# same path with the legacy single-uid 0700/0600 ownership model.
BOX_SECRETS_DIR=/data/agenthost-secrets
BOX_SECRETS_FILE="$BOX_SECRETS_DIR/secrets.env"
LEGACY_BOX_SECRETS_DIR=/data/home/agent/.agenthost
LEGACY_BOX_SECRETS_FILE="$LEGACY_BOX_SECRETS_DIR/secrets.env"
box_secrets_fatal() {
    echo "[agenthost] FATAL: $1" >&2
    exit 1
}
[ ! -L "$BOX_SECRETS_DIR" ] \
    || box_secrets_fatal "refusing symlinked box secret directory $BOX_SECRETS_DIR"
[ ! -e "$BOX_SECRETS_DIR" ] || [ -d "$BOX_SECRETS_DIR" ] \
    || box_secrets_fatal "box secret path is not a directory: $BOX_SECRETS_DIR"
if [ "${AGENTHOST_FOUNDATION_B:-}" = "1" ]; then
    box_secrets_owner=gate
    box_secrets_group=boxstate
    box_secrets_dir_mode=0750
    box_secrets_file_mode=0660
else
    box_secrets_owner=agent
    box_secrets_group=agent
    box_secrets_dir_mode=0700
    box_secrets_file_mode=0600
fi
install -d -o "$box_secrets_owner" -g "$box_secrets_group" -m "$box_secrets_dir_mode" "$BOX_SECRETS_DIR" \
    || box_secrets_fatal "could not create the protected box secret directory"

if [ -e "$BOX_SECRETS_FILE" ] || [ -L "$BOX_SECRETS_FILE" ]; then
    [ -f "$BOX_SECRETS_FILE" ] && [ ! -L "$BOX_SECRETS_FILE" ] \
        || box_secrets_fatal "box secret file is not a regular non-symlink file"
    [ "$(stat -c %h -- "$BOX_SECRETS_FILE")" = "1" ] \
        || box_secrets_fatal "box secret file has multiple hard links"
else
    # One-time move from the old agent-home location. Boot runs before the
    # untrusted agent process starts, so the lstat-style shell checks and copy
    # cannot race that uid. Never follow a legacy directory or leaf symlink.
    [ ! -L "$LEGACY_BOX_SECRETS_DIR" ] \
        || box_secrets_fatal "refusing symlinked legacy box secret directory"
    [ ! -e "$LEGACY_BOX_SECRETS_DIR" ] || [ -d "$LEGACY_BOX_SECRETS_DIR" ] \
        || box_secrets_fatal "legacy box secret parent is not a directory"
    if [ -e "$LEGACY_BOX_SECRETS_FILE" ] || [ -L "$LEGACY_BOX_SECRETS_FILE" ]; then
        [ -f "$LEGACY_BOX_SECRETS_FILE" ] && [ ! -L "$LEGACY_BOX_SECRETS_FILE" ] \
            || box_secrets_fatal "legacy box secret file is not a regular non-symlink file"
        [ "$(stat -c %h -- "$LEGACY_BOX_SECRETS_FILE")" = "1" ] \
            || box_secrets_fatal "legacy box secret file has multiple hard links"
        box_secrets_temp="$(mktemp "$BOX_SECRETS_DIR/.secrets.env.migrate.XXXXXX")" \
            || box_secrets_fatal "could not reserve a safe temporary box secret file"
        install -o "$box_secrets_owner" -g "$box_secrets_group" -m "$box_secrets_file_mode" \
            "$LEGACY_BOX_SECRETS_FILE" "$box_secrets_temp" \
            || box_secrets_fatal "could not copy the legacy box secret file into the protected store"
        mv -f -- "$box_secrets_temp" "$BOX_SECRETS_FILE" \
            || box_secrets_fatal "could not publish the migrated box secret file"
        rm -f -- "$LEGACY_BOX_SECRETS_FILE" \
            || box_secrets_fatal "protected box secret migration succeeded but the legacy copy could not be removed"
        echo "[agenthost] migrated the legacy box secret file into the protected store"
    else
        install -o "$box_secrets_owner" -g "$box_secrets_group" -m "$box_secrets_file_mode" \
            /dev/null "$BOX_SECRETS_FILE" \
            || box_secrets_fatal "could not create the box secret file"
    fi
fi
chown "$box_secrets_owner:$box_secrets_group" "$BOX_SECRETS_FILE" \
    || box_secrets_fatal "could not restore box secret file ownership"
chmod "$box_secrets_file_mode" "$BOX_SECRETS_FILE" \
    || box_secrets_fatal "could not restore box secret file permissions"
export AGENTHOST_BOX_SECRETS_FILE="$BOX_SECRETS_FILE"

# Legacy Claude credential purge begin
# Releases before credential-file migration was retired may have restored this
# file onto the persistent volume. Cleanup runs here as root, before the agent
# process starts. Its completion marker lives directly under root-owned /data,
# so the persistent Fly control value cannot make later cloud-native credentials
# get deleted again.
LEGACY_AGENT_HOME=/data/home/agent
LEGACY_CLAUDE_CREDENTIAL_FILE="$LEGACY_AGENT_HOME/.claude/.credentials.json"
LEGACY_CLAUDE_PURGE_MARKER=/data/.agenthost-legacy-claude-credentials-purged-v1
legacy_claude_purge_fatal() {
    echo "[agenthost] FATAL: $1; legacy credential cleanup will retry before the agent starts" >&2
    exit 1
}
if [ "${AGENTHOST_PURGE_LEGACY_CLAUDE_CREDENTIALS:-}" = "1" ]; then
    legacy_claude_purge_complete=
    if [ -e "$LEGACY_CLAUDE_PURGE_MARKER" ] || [ -L "$LEGACY_CLAUDE_PURGE_MARKER" ]; then
        if [ -f "$LEGACY_CLAUDE_PURGE_MARKER" ] \
            && [ ! -L "$LEGACY_CLAUDE_PURGE_MARKER" ] \
            && [ "$(stat -c %u "$LEGACY_CLAUDE_PURGE_MARKER")" = "0" ] \
            && [ "$(stat -c %a "$LEGACY_CLAUDE_PURGE_MARKER")" = "600" ]; then
            legacy_claude_purge_complete=1
        else
            rm -f -- "$LEGACY_CLAUDE_PURGE_MARKER" \
                || legacy_claude_purge_fatal "could not remove an untrusted purge marker"
        fi
    fi
    if [ -z "$legacy_claude_purge_complete" ]; then
        for legacy_parent in /data/home "$LEGACY_AGENT_HOME" "$LEGACY_AGENT_HOME/.claude"; do
            [ ! -L "$legacy_parent" ] \
                || legacy_claude_purge_fatal "refusing to follow symlinked path $legacy_parent"
        done
        [ ! -e "$LEGACY_AGENT_HOME/.claude" ] || [ -d "$LEGACY_AGENT_HOME/.claude" ] \
            || legacy_claude_purge_fatal "Claude harness path is not a directory"
        rm -f -- "$LEGACY_CLAUDE_CREDENTIAL_FILE" \
            || legacy_claude_purge_fatal "could not remove the legacy migrated Claude credential file"
        install -o root -g root -m 0600 /dev/null "$LEGACY_CLAUDE_PURGE_MARKER" \
            || legacy_claude_purge_fatal "credential file was removed but completion could not be recorded"
        echo "[agenthost] removed a legacy migrated Claude credential file"
    fi
fi
unset AGENTHOST_PURGE_LEGACY_CLAUDE_CREDENTIALS
# Legacy Claude credential purge end

# Codex keeps its session "rollout" files under ~/.codex/sessions; the gate
# (agent user) must be able to WRITE them or `codex exec resume` fails with
# "no rollout found" (multi-turn Codex chat breaks). An `ssh console` session
# lands as root, and running codex there once leaves root-owned dirs under
# ~/.codex that the agent can no longer write into. The first-boot chown above
# is marker-gated so it won't repair that. This targeted chown runs every boot
# -- ~/.codex is small, so it's cheap -- to keep Codex's store agent-writable.
# NOTE: this chowns the DIRECTORY TREE (files inside .codex) to agent:boxstate
# (NOT agent:agent) so the gate (uid 999, group boxstate) can write to Codex's
# SQLite state files. Category C below (line ~197) then sets the .codex DIRECTORY
# ITSELF to agent:boxstate 2770 so the gate can write to it. Both are needed and
# deliberately ordered: this runs first (tree), Category C runs after (dir).
# Reordering Category C before this line would revert the directory to
# agent:agent, silently re-breaking Codex (PR #258, 2026-08-08).
# The recursive chown uses agent:boxstate (not agent:agent) so state files created
# by the gate retain the boxstate group across reboots. auth.json remains 0600
# agent-owned — the group doesn't grant read access to a 0600 file, so the
# security invariant (gate cannot read credentials) is preserved.
[ -d /data/home/agent/.codex ] && chown -R agent:boxstate /data/home/agent/.codex
# Ownership self-heal, every boot (hit for real 2026-07-23): an operator who ever
# runs the stack -- or any tool -- from a root ssh console leaves root-owned files
# scattered through the agent home. gate.js's atomic rewrites (tmp+rename) make
# this especially sticky: gate.secret becomes root-owned (agent gate can't read OR
# re-persist it -> cookies reset -> forced re-login on every restart), secrets.env
# and ~/.agenthost break claw-setup and the key panel, ~/.openclaw bricks
# re-onboarding ("Permission denied" with no sudo under --no-new-privs), and a
# root-owned ~/artifacts empties the Artifacts panel even though the files are
# still on disk. The first-boot chown above is marker-gated and never repairs any
# of this. This sweep touches ONLY wrong-owned entries (a stat pass, no mass
# metadata writes -- unlike a blanket chown -R, it stays cheap as the home grows),
# then restores owner read/write where a root-created mode still blocks the agent
# (the -perm guard also keeps chmod off symlinks).
find /data/home/agent \! -user agent -exec chown -h agent:agent {} + 2>/dev/null || true
find /data/home/agent \! -type l \! -perm -u+rw -exec chmod u+rwX {} + 2>/dev/null || true

# Gate-uid files: the gate process runs as user 'gate', not 'agent'.
# The find sweep above reclaims everything under /data/home/agent as agent:agent,
# which silently breaks the gate's ability to read its own state files
# (gate.secret, vapid.json, push-subs.json). Without these, cookie auth fails
# and web push notifications are silently disabled. Restore gate ownership.
# ── Gate-uid ownership restoration (after the boot sweep above) ──────────────
# The sweep at line 139 reclaims everything under /data/home/agent as
# agent:agent, stripping the boxstate group. The gate runs as user 'gate'
# (created --no-create-home, Dockerfile line 175) and is in group boxstate
# (Dockerfile line 180). Three categories of paths need restoration every boot:
#
#   A. Gate-only state files (gate:gate, mode set by gate.js write — 0600 for
#       gate.secret/vapid.json, default umask for push-subs.json)
#   B. Shared state files  (agent:boxstate 0660)
#   C. Shared directories   (agent:boxstate 2770 setgid, so new files inherit boxstate)
#   D. Git repo internals   (agent:boxstate g+rwX, gate creates branch refs)
#
# Without this, the gate silently loses access on every reboot — push
# notifications die, board claims break, git worktrees fail. Each was found
# separately over 24h (PRs #247-249); this block replaces them with one
# exhaustive restoration so a fourth path doesn't require a fourth PR.
GATE_STATE_DIR="/data/home/agent/.claude/agenthost"

# A. Gate-only state files — the gate is the sole reader/writer.
#
# The chmod is not belt-and-braces, it is the half that was missing. Measured on
# the live box 2026-08-11: gate.secret was `gate:boxstate 0660` and the agent
# (uid 1001, in boxstate) could READ it — 65 bytes, confirmed by hand. That file
# is one half of the session-cookie HMAC, so any jailed engine holding it can
# mint operator cookies, and every consequence gate on this box rests on that
# cookie.
#
# This loop had always restored the OWNER and never the MODE, so a file that
# reached 0660 stayed 0660 forever. The widener was
# maintenance-gate-state-migration.js, which walks this very directory and ORs
# g+rw onto every file in it; that is now fixed at the source, and this line is
# the boot-time floor in case anything else ever widens them again. 2fa.secret is
# included here even though it does not exist yet, so it is born closed.
# `[ -f ]` is TRUE for a symlink pointing at a regular file, and this runs as
# ROOT inside a directory the agent can write. Without the `! -L` guard an
# agent-planted symlink named gate.secret would make root chown and chmod 0600
# whatever it points at -- and adding the chmod above is exactly what turns that
# from an ownership nuisance into arbitrary-file destruction. `chown -h` matches
# the sweep at ~line 150 and the .git repair below. (Kimi, security review.)
for gf in vapid.json push-subs.json; do
  if [ -f "$GATE_STATE_DIR/$gf" ] && [ ! -L "$GATE_STATE_DIR/$gf" ]; then
    chown -h gate:gate "$GATE_STATE_DIR/$gf" 2>/dev/null || true
    chmod 0600 "$GATE_STATE_DIR/$gf" 2>/dev/null || true
  fi
done

# B. Shared state files — both agent and gate read/write. The boot sweep
# strips boxstate from the group, dropping the gate to other-read-only.
# Restore the sanctioned shared pattern (agent:boxstate 0660) matching
# mode.json at line 198. The glob covers -shm and -wal.
chown agent:boxstate "$GATE_STATE_DIR/board-claims.sqlite"* 2>/dev/null || true
chmod 0660 "$GATE_STATE_DIR/board-claims.sqlite"* 2>/dev/null || true

# C. Shared directories — restore boxstate group + setgid so NEW files
# created inside inherit boxstate (the gate can then write them). The
# sweep strips both the group and the setgid bit, making this essential
# every boot, not just once.
#
# Named tradeoff: .codex holds auth.json (Codex's ChatGPT device login).
# Setting it to agent:boxstate 2770 lets the gate (uid 999) create and
# replace files inside, including the credential. The gate still cannot
# READ auth.json (0600, agent-owned) and the locked permission profile
# still denies /codex to model-launched commands. The agent already owns
# this directory (0755), so group-write does not widen the agent-side
# blast radius — it gives the trusted gate access the less-trusted agent
# already has. See 2026-08-08-f4-codex-jail-findings.md §3.
# The agent-home Visual QA tree is for manual/cron diagnostics only. It is
# intentionally non-authoritative because the agent can rewrite it. Gate-triggered
# POST /qa/run stores baselines/current captures under the 0700 QA_EVIDENCE_DIR
# created above, which the Foundation-B agent uid cannot traverse or replace.
mkdir -p /data/home/agent/qa-screenshots
for sd in \
  "$GATE_STATE_DIR" \
  "$GATE_STATE_DIR/chat-runs" \
  "$GATE_STATE_DIR/cron" \
  "$GATE_STATE_DIR/mesh" \
  "$GATE_STATE_DIR/channel-sessions" \
  "/data/home/agent/.hermes" \
  "/data/home/agent/.codex" \
  "/data/home/agent/qa-screenshots" \
  "/data/home/agent/workspaces"
do
  [ -d "$sd" ] && { chown agent:boxstate "$sd" 2>/dev/null || true; chmod 2770 "$sd" 2>/dev/null || true; }
done
# Manual screenshot subdirs are created at runtime. Keep their legacy shared
# treatment for compatibility, but never consume this tree as gate evidence.
#
# DIRECTORIES ONLY -- the FILES are deliberately left alone. Group-write on the
# directory is all a manual caller needs. The authoritative baselines/current
# files and result JSON are both outside this shared tree under QA_RESULT_DIR.
find /data/home/agent/qa-screenshots -mindepth 1 -type d \
  -exec chown agent:boxstate {} + -exec chmod 2770 {} + 2>/dev/null || true
# Per-engine workspace subdirs (claude, codex, hermes, gemini, kimi, cursor)
for ed in /data/home/agent/workspaces/*; do
  [ -d "$ed" ] && { chown agent:boxstate "$ed" 2>/dev/null || true; chmod 2770 "$ed" 2>/dev/null || true; }
done

# D. Git repo .git directory — the gate creates worktrees for proposals from
# the main checkout. safe.directory (below) fixes the "dubious ownership" error
# but NOT permission-denied on ref creation. Restore agent:boxstate + group
# write on .git. Only .git — working tree files stay agent:agent.
MAIN_REPO_GIT="/data/home/agent/work/agenthost-internal/.git"
if [ -d "$MAIN_REPO_GIT" ]; then
  chown -R agent:boxstate "$MAIN_REPO_GIT" 2>/dev/null || true
  chmod -R g+rwX "$MAIN_REPO_GIT" 2>/dev/null || true
fi

# ...AND THE ENGINE WORKTREES, which is where the commits actually happen.
#
# The block above has only ever covered the MAIN checkout. But gitLadder's
# commitLocal runs from gate.js -- as uid 997 -- against
# /data/home/agent/workspaces/<engine>/<repo>, and that path was never in this
# section. So auto-commit failed for EVERY engine, every time, from the day the
# setting was turned on (2026-08-10):
#
#   git_rung1_commit: codex FAILED hardened commit agenthost-internal:
#   fatal: Unable to create '/workspace/.git/index.lock': Permission denied
#
# Measured on the box 2026-08-11 -- the groups tell the whole story:
#   .git       agent:systemd-network (gid 998) mode 775
#   boxstate   gid 996, members agent + gate
#   gate       uid 997, groups 997 + 996
# gate is not in 998, so it falls through to `other` (r-x) and cannot create
# index.lock. `agent` can, because agent owns it. That asymmetry is the entire
# bug, and it is the same shape as the QA capture failure fixed earlier today:
# the gate spawns work into a tree owned by the agent and is not a member of the
# group that would let it write.
#
# The 998/systemd-network group is itself an accident -- a gid that belongs to no
# one on this box -- so these trees were group-owned by nobody. Per-task clones
# land as agent:agent 755, which is equally unwritable by gate. Both are repaired
# here; the working tree stays agent-owned, only .git is shared, exactly as above.
#
# Filtered on `! -group boxstate` rather than a blanket chown -R: a full clone's
# .git is tens of thousands of files and there is one per engine per task, so an
# unconditional recursive chown would grow into real boot latency. After the
# first repair this walks the tree and changes nothing.
# A ONE-TIME REPAIR IS NOT ENOUGH, and this is the half that would have decayed
# silently. Repairing the group only fixes the files that exist NOW. Git creates
# new objects, refs and index files constantly, as whichever uid is committing:
# gate commits as gid 997, so without setgid its new objects land group `gate`
# and the AGENT is locked out of them until the next boot re-chowns. The bug
# would come back inverted, between reboots, and look like a different bug.
#
# So hand the maintenance to git instead of re-deriving it here every boot.
# `core.sharedRepository=group` is git's own answer to a repo written by more
# than one user: it creates objects group-writable and sets setgid on the
# directories it makes, permanently and without a boot sweep. The chown/chmod
# below then only has to fix what predates it. (Kimi found the setgid gap in
# review; core.sharedRepository is the git-native form of its fix.)
#
# chown -h and the symlink skip are not cosmetic: this runs as ROOT, and the
# agent can place a symlink inside its own .git. Without -h, root would follow
# it and chown the target. Line ~150 above already uses -h for exactly this
# reason; this block now matches it.
#
# shareRepoConfig carries two corrections Kimi made on the second pass, both of
# which apply to .git/config specifically and neither of which the loop above
# covers:
#   - .git/config is a FILE the agent can replace with a symlink, and this runs
#     as root, so it gets the same guard as everything else here.
#   - `git config --file` run by root leaves the file ROOT-OWNED, which would
#     silently break any later `git config` write by agent or gate. Git only
#     needs to READ sharedRepository, so this would not have failed loudly -- it
#     would have failed the next time something tried to set a config value.
#     Ownership goes back immediately.
#
# KNOWN RESIDUAL, stated rather than papered over: start.sh creates fresh clones
# AFTER this block runs, so a brand-new worktree carries no sharedRepository
# until the next boot repairs it. In that window a gate commit can still create
# a 0644 file the agent cannot rewrite. It self-heals on reboot and it is
# strictly better than the current state (where nothing is ever shared), but the
# complete fix is `-c core.sharedRepository=group` on the clone commands
# themselves in start.sh. Left out deliberately: that is a different file with
# its own review, and folding it in here would widen an entrypoint fix into a
# boot-sequence change.
shareRepoConfig() {
  local _cfg
  _cfg="$1/config"
  [ -f "$_cfg" ] && [ ! -L "$_cfg" ] || return 0
  git config --file "$_cfg" core.sharedRepository group 2>/dev/null || true
  chown agent:boxstate "$_cfg" 2>/dev/null || true
  chmod g+rw "$_cfg" 2>/dev/null || true
}
for wt_git in /data/home/agent/workspaces/*/*/.git; do
  [ -d "$wt_git" ] || continue
  find "$wt_git" \! -group boxstate -exec chown -h agent:boxstate {} + 2>/dev/null || true
  find "$wt_git" \! -type l \! -perm -g+w -exec chmod g+rwX {} + 2>/dev/null || true
  find "$wt_git" -type d \! -perm -g+s -exec chmod g+s {} + 2>/dev/null || true
  shareRepoConfig "$wt_git"
done
# The main checkout carries the identical latent defect -- the block above it
# chowns but never sets setgid, so it decays the same way. Same one-line cure,
# applied where the same reasoning applies. (Also Kimi's, in the same review.)
if [ -d "$MAIN_REPO_GIT" ]; then
  find "$MAIN_REPO_GIT" -type d \! -perm -g+s -exec chmod g+s {} + 2>/dev/null || true
  shareRepoConfig "$MAIN_REPO_GIT"
fi

# Git safe.directory — must use --system (writes /etc/gitconfig, read by every
# user) NOT --global: entrypoint runs as root, HOME not exported until line ~197,
# gate user created --no-create-home. --global writes /root/.gitconfig which
# gate never reads. Named tradeoff: "*" disables git's ownership check box-wide;
# defensible inside a single-tenant jail.
git config --system --add safe.directory "*" 2>/dev/null || true

# Growth/Dev mode switch, every boot (Steve hit the EACCES this repairs on
# 2026-08-02): POST /api/mode writes the mode with tmp+rename, which needs
# DIRECTORY write -- and /data stays root:root 0755 on purpose (Foundation B
# verifies it). So the mode lives in its own subdir shared exactly like the
# gate-state trees: owner agent, group boxstate (both the legacy `agent` gate
# and the Foundation-B `gate` uid are members), setgid so the tmp file
# inherits the group. Migrates the legacy root-owned /data/mode.json once;
# mode-lib reads fall back to the legacy path until this has run.
install -d -o agent -g boxstate -m 2770 /data/mode 2>/dev/null || install -d -o agent -g agent -m 0770 /data/mode
if [ ! -f /data/mode/mode.json ] && [ -f /data/mode.json ]; then
    cp -p /data/mode.json /data/mode/mode.json || true
fi
chown agent:boxstate /data/mode/mode.json 2>/dev/null || true
chmod 0660 /data/mode/mode.json 2>/dev/null || true

# Fix 2026-08-05: the .claude/ parent directory must be group-traversable by
# the `gate` uid (group boxstate) so gate.js can reach .claude/agenthost/mesh/
# and .claude/agenthost/ttyd/. Without group traverse on .claude/, readState()
# catches EACCES and returns {locked:true} (fail-closed), permanently locking
# the entire box. This is a SURGICAL fix: only the directory itself gets
# group boxstate + g+x (traverse) — files inside (including .credentials.json)
# stay 0600 owner-only and are NOT shared. The recursive shareTree in
# maintenance-gate-state-migration.js is deliberately NOT used here because it
# would make .credentials.json group-readable (security invariant #2).
CLAUDE_DIR="/data/home/agent/.claude"
if [ -d "$CLAUDE_DIR" ]; then
    chgrp boxstate "$CLAUDE_DIR" 2>/dev/null || true
    chmod 750 "$CLAUDE_DIR" 2>/dev/null || true
fi

export HOME=/data/home/agent

# Keep a runaway workload from taking the whole box through the kernel OOM
# killer. The root guard records only secret-safe process names/RSS and, after
# sustained critical pressure, asks this entrypoint PID to checkpoint via
# SIGUSR2, with SIGKILL only as a bounded fallback. Both exec paths below
# preserve that PID, so Fly sees a non-zero main-process exit and applies the
# explicit on-failure restart policy. Set AGENTHOST_MEMORY_FAILSAFE=off only as
# a temporary operator recovery switch.
/opt/agenthost/memory-failsafe.sh "$$" &

# Foundation B activation gate (Phase 1f). OFF by default: with the flag unset,
# this is byte-for-behavior identical to before -- root drops to the agent and
# start.sh becomes PID 1, exactly as today. With AGENTHOST_FOUNDATION_B=1, root
# STAYS root and runs the maintenance authority (NOT PID 1 — the platform's init
# is PID 1; the native guard requires uid 0, not pid 1). boot-entry spawns TWO
# children: the interactive stack (start.sh, as `agent`, phone view unchanged) and
# gate.js directly as the `gate` uid. Root repairs persisted shared state before
# the agent starts. After this boot's writers finish, start.sh repeats that
# migration as the unprivileged agent before publishing stack-ready. Root never
# walks an agent-writable tree while that uid is live. Both passes fail closed.
# Tailscale (opt-in, root phase — Steve, 2026-07-27): join the operator's
# tailnet when, and only when, the operator has initialized it once with a
# manual `tailscale up` in a root console. The /data/tailscale state dir is
# both the opt-in flag and the persistence: absent -> fully dormant (the
# Dockerfile's baked-dormant invariant holds); present -> tailscaled resumes
# the saved node identity on every boot, no re-auth. Userspace networking:
# no TUN device needed on Fly; inbound tailnet access (laptop -> box) works
# transparently, outbound-to-tailnet would need the SOCKS5 proxy on :1055
# and nothing is wired to use it yet.
# DSH's real provider key remains in gate. Its per-run Unix sockets live in a
# root-created, non-listable directory: gate may create/unlink entries, while
# the jailed agent can only traverse to the one socket root bind-mounts for it.
[ ! -L /run/agenthost-qa ] || { echo "[agenthost] FATAL: refusing symlinked QA control directory" >&2; exit 1; }
if [ "${AGENTHOST_FOUNDATION_B:-}" = "1" ]; then
    [ ! -e /run/agenthost-qa ] || [ -d /run/agenthost-qa ] \
        || { echo "[agenthost] FATAL: QA control path is not a directory" >&2; exit 1; }
    install -d -o gate -g gate -m 0700 /run/agenthost-qa \
        || { echo "[agenthost] FATAL: could not create the gate-private QA control directory" >&2; exit 1; }
fi
[ ! -L /run/agenthost-dsh ] || { echo "[agenthost] FATAL: refusing symlinked DSH relay directory" >&2; exit 1; }
if [ "${AGENTHOST_FOUNDATION_B:-}" = "1" ]; then
    install -d -o gate -g boxstate -m 2710 /run/agenthost-dsh
    dsh_path_key_group=gate
else
    install -d -o agent -g agent -m 0700 /run/agenthost-dsh
    dsh_path_key_group=agent
fi
dsh_path_key_tmp="$(mktemp /run/.agenthost-dsh-path-key.XXXXXX)"
head -c 32 /dev/urandom > "$dsh_path_key_tmp"
chown root:"$dsh_path_key_group" "$dsh_path_key_tmp"
chmod 0640 "$dsh_path_key_tmp"
mv -fT "$dsh_path_key_tmp" /run/agenthost-dsh/.path-key
[ -f /run/agenthost-dsh/.path-key ] && [ ! -L /run/agenthost-dsh/.path-key ] \
    || { echo "[agenthost] FATAL: DSH relay path key is not a regular file" >&2; exit 1; }
unset dsh_path_key_tmp dsh_path_key_group

if [ -x /usr/sbin/tailscaled ] && [ -d /data/tailscale ]; then
    mkdir -p /var/run/tailscale
    /usr/sbin/tailscaled --state=/data/tailscale/tailscaled.state \
        --socket=/var/run/tailscale/tailscaled.sock \
        --tun=userspace-networking --socks5-server=localhost:1055 \
        >/var/log/tailscaled.log 2>&1 &
fi

if [ "${AGENTHOST_FOUNDATION_B:-}" = "1" ]; then
    # The root-pinned Hermes board CLI imports startup/config code even for a
    # read-only list. Give the gate uid a private runtime home so agent-planted
    # .env/config/bin/plugin files can never execute in the gate identity.
    [ ! -L /run/agenthost-gate-hermes ] || { echo "[agenthost] FATAL: refusing symlinked gate Hermes home" >&2; exit 1; }
    install -d -o gate -g gate -m 0700 /run/agenthost-gate-hermes
    # The native authority's trusted store must exist as root:root 0700 before it
    # boots (maintenance-native.c open_trusted_dirs verifies /data/maintenance is
    # root:root 0700 and rejects anything else). Nothing else provisions it, so
    # create + enforce it here in the root phase. Idempotent: chown/chmod every
    # boot so a stray-owned dir (e.g. left by a root ssh console) self-heals
    # rather than failing the authority closed. /data/maintenance/work is the
    # worker worktree base (maintenance-boot-entry.js); root owns it, workers get
    # task-scoped subtrees under it.
    mkdir -p /data/maintenance/work
    chown root:root /data/maintenance /data/maintenance/work
    chmod 0700 /data/maintenance
    # The stack-ready marker lives on the PERSISTENT /data volume and start.sh
    # never deletes it, so from the second boot onward waitForStackReady()
    # (maintenance-boot-entry.js) would find a stale marker and return true on its
    # first poll -- spawning gate.js while start.sh is still cloning repos and
    # before tmux + the gate<->tmux seam exist. Clear it here every boot so the
    # marker means "THIS boot's prep finished", which is what boot-entry assumes.
    rm -f /data/home/agent/.agenthost/stack-ready
    if [ -n "$gate_push_token_present" ]; then
        GIT_PUSH_TOKEN="$gate_push_token_value" exec /opt/agenthost/entrypoint-launcher foundation
    fi
    exec /opt/agenthost/entrypoint-launcher foundation
fi
# No identity split on this path: gate.js is the tail exec of start.sh and runs as
# `agent`, the SAME uid as tmux, chat, cron, and the channel lanes. A "gate-only"
# push credential would therefore be readable by exactly the agents it is withheld
# from, and the write rungs would claim an isolation the box does not have. Drop it
# outright so the token does not exist anywhere on a box that cannot hold it apart:
# gitHubToken() then returns null and rungs 2-4 fail closed. No split, no governed
# write -- the honest state. (GITHUB_TOKEN is untouched: the agent is SUPPOSED to
# have it for gh/MCP/clone. See gate.js gitHubToken().)
[ ! -L /run/agenthost-gate-hermes ] || { echo "[agenthost] FATAL: refusing symlinked Hermes runtime home" >&2; exit 1; }
install -d -o agent -g agent -m 0700 /run/agenthost-gate-hermes
unset GIT_PUSH_TOKEN
exec setpriv --reuid=agent --regid=agent --init-groups --no-new-privs /bin/bash -p /opt/agenthost/start.sh
