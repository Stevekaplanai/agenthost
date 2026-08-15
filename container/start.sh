#!/bin/bash
# Runs as the agent user. Restores the harness, wires credentials, clones repos,
# rebuilds .env files from Fly secrets, starts the agent in tmux, serves it over ttyd.
#
# Env contract (set by the CLI / deploy script as Fly secrets):
#   CLAUDE_CODE_OAUTH_TOKEN - preferred agent auth (claude setup-token output; subscription-billed)
#   ANTHROPIC_API_KEY  - metered fallback auth (one of the two is required for the agent)
#   TTYD_PASSWORD      - required only when this script also starts gate.js;
#                        Foundation B withholds it from the agent stack
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
export AGENTHOST_BOX_SECRETS_FILE="${AGENTHOST_BOX_SECRETS_FILE:-/data/agenthost-secrets/secrets.env}"
# Claude Code is root-installed in the image; the agent user can't self-update
# (persistent "Auto-update failed" otherwise). Updates ship via image redeploys.
export DISABLE_AUTOUPDATER=1
cd "$HOME"

# Agent boot state (harness tarball + first-boot markers) lives here, under the
# agent home, NOT loose in /data -- /data must stay root:root 0755 for the
# Foundation B native authority. entrypoint.sh (root) stages the tarball here and
# migrates any legacy /data markers into this dir before we run.
BOOT_DIR="$HOME/.agenthost-boot"
mkdir -p "$BOOT_DIR"

# 1. Restore the migrated harness. Re-extracts when a newer tarball is uploaded
#    (manual re-upload or `agenthost sync` both just replace the file).
#    The tarball is deleted once extracted -- the contents already live in $HOME,
#    so keeping it would double-store the harness on the volume. entrypoint.sh
#    compares the image tarball against the .harness-extracted marker (not just
#    the $BOOT_DIR copy) so reboots don't re-stage a stale tarball after this delete.
if [ -f "$BOOT_DIR/harness.tar.gz" ]; then
    if [ ! -f "$BOOT_DIR/.harness-extracted" ] || [ "$BOOT_DIR/harness.tar.gz" -nt "$BOOT_DIR/.harness-extracted" ]; then
        echo "[agenthost] restoring harness..."
        if tar -xzf "$BOOT_DIR/harness.tar.gz" -C "$HOME"; then
            touch "$BOOT_DIR/.harness-extracted"
            rm -f "$BOOT_DIR/harness.tar.gz"
        else
            echo "[agenthost] WARN: harness extraction failed; keeping the tarball to retry next boot"
        fi
    else
        rm -f "$BOOT_DIR/harness.tar.gz"
    fi
fi

# 1c. Skip Claude Code's first-run wizard. When the box has auth (an OAuth token
#     or credentials created directly on the box), interactive `claude` STILL runs its onboarding
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

# 1d-2. The box's OWN operating skill ("get into character"). Unlike the starter
#     stack below (first-boot only, user-customisable), this ships in the image
#     and is REFRESHED ON EVERY BOOT, so the manual an agent reads always matches
#     the code it is running. Without it, agents land on a governed box whose
#     charter, cardinal rules, ladders and coordination protocol sit unread on
#     disk beside them -- and improvise in a system they cannot see. Every step
#     is best-effort: this must never block the box from booting.
if [ -d /opt/agenthost/skills-preload ]; then
    mkdir -p "$HOME/.claude/skills"
    for d in /opt/agenthost/skills-preload/*/; do
        [ -d "$d" ] || continue
        _skill_name=$(basename "$d")
        mkdir -p "$HOME/.claude/skills/$_skill_name"
        # Copy the WHOLE skill dir, not just SKILL.md -- a skill whose
        # references/ didn't make it to the box is a broken link, not a skill.
        if cp -rf "$d/." "$HOME/.claude/skills/$_skill_name/" 2>/dev/null; then
            echo "[agenthost] box skill loaded: $_skill_name"
        else
            echo "[agenthost] WARN: could not install box skill $_skill_name (non-blocking)"
        fi
    done
fi

# 1d-3. Seeded operator context: brand voice files, the imported desktop memory
#     silo, and homunculus instincts, refreshed on every boot from the image so
#     the repo stays the source of truth (same contract as the box skill above).
#     Best-effort: never blocks boot.
if [ -d /opt/agenthost/home-seed/.claude ]; then
    mkdir -p "$HOME/.claude"
    if cp -rf /opt/agenthost/home-seed/.claude/. "$HOME/.claude/" 2>/dev/null; then
        echo "[agenthost] operator context seeded: brand/memory/instincts"
    else
        echo "[agenthost] WARN: could not seed operator context (non-blocking)"
    fi
fi

# 1e. Starter stack. On FIRST BOOT ONLY (marker-guarded), install the curated
#     skill set every box ships with -- the "starter stack" the site promises.
#     Skills install two ways: PLUGINS via ~/.claude/settings.json
#     (extraKnownMarketplaces + enabledPlugins), single SKILLS via git clone
#     into ~/.claude/skills, and MCP tools via their own installer. The manifest
#     (container/starter-stack.json, baked into the image) is the source of
#     truth. Everything is MERGE, never clobber: a user's own same-named plugin
#     or skill ALWAYS wins. Every step is best-effort -- a failure WARNs and
#     continues; the starter stack must never block the box from booting.
# EXPORT so every `node -e` child below inherits the manifest path via its
# environment (a plain shell var is NOT inherited; a trailing `VAR=... node`
# assignment lands in argv, not env -- both silently break process.env).
export STARTER_MANIFEST=/opt/agenthost/starter-stack.json
if [ -d "$HOME/.claude" ] && [ -f "$STARTER_MANIFEST" ] && [ ! -f "$BOOT_DIR/.starter-stack" ]; then
    echo "[agenthost] installing the starter stack (first boot)..."
    mkdir -p "$HOME/.claude/skills"
    # (1) Plugins: merge marketplaces + enable flags into settings.json. node is
    #     always present; the user's existing entries are never overwritten.
    SETTINGS="$HOME/.claude/settings.json" node -e '
        const fs = require("fs");
        const man = JSON.parse(fs.readFileSync(process.env.STARTER_MANIFEST, "utf8"));
        const f = process.env.SETTINGS;
        let s = {};
        try { s = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
        if (typeof s !== "object" || !s) s = {};
        s.extraKnownMarketplaces = s.extraKnownMarketplaces || {};
        s.enabledPlugins = s.enabledPlugins || {};
        let added = 0;
        for (const p of (man.plugins || [])) {
            // Register the marketplace only if the user has not already (theirs wins).
            if (!s.extraKnownMarketplaces[p.marketplace]) {
                s.extraKnownMarketplaces[p.marketplace] = { source: { source: "github", repo: p.repo } };
            }
            // Enable the plugin only if the user has no opinion yet (never flip an
            // explicit false back to true -- respect a deliberate disable).
            if (!(p.id in s.enabledPlugins)) { s.enabledPlugins[p.id] = true; added++; }
        }
        const tmp = f + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
        fs.renameSync(tmp, f);
        console.error("[agenthost] starter stack: enabled " + added + " new plugin(s)");
    ' 2>&1 || echo "[agenthost] WARN: starter-stack plugin merge failed; skills unaffected"
    # (2) Single-skill repos: clone into ~/.claude/skills/<dir> unless present.
    node -e 'const m=require(process.env.STARTER_MANIFEST);for(const s of (m.skills||[]))console.log(s.dir+" "+s.repo)' 2>/dev/null | \
    while read -r dir repo; do
        [ -z "$dir" ] && continue
        if [ ! -d "$HOME/.claude/skills/$dir" ]; then
            git clone --depth 1 "https://github.com/$repo" "$HOME/.claude/skills/$dir" >/dev/null 2>&1 \
                && echo "[agenthost] starter skill installed: $dir" \
                || echo "[agenthost] WARN: starter skill clone failed for $repo"
        fi
    done
    # (3) MCP tools: run each install command (best-effort).
    node -e 'const m=require(process.env.STARTER_MANIFEST);for(const x of (m.mcp||[]))console.log(x.install)' 2>/dev/null | \
    while IFS= read -r cmd; do
        [ -z "$cmd" ] && continue
        sh -c "$cmd" >/dev/null 2>&1 && echo "[agenthost] starter MCP installed" \
            || echo "[agenthost] WARN: starter MCP install failed (non-blocking)"
    done
    touch "$BOOT_DIR/.starter-stack"
    echo "[agenthost] starter stack ready -- run 'skills' in the terminal to see it"
fi

# 1b. Hermes (beta). If the migrated harness includes a Hermes home, wire it up:
#     rebuild .env from HERMESENV_* Fly secrets, install tools on first boot.
#     Local config.yaml never migrates; Hermes becomes ready after the operator
#     recreates that file on the box.
#     Any failure WARNs and continues -- Hermes problems never block Claude Code.
HERMES_READY=0
if [ -d "$HOME/.hermes" ]; then
    export HERMES_HOME="$HOME/.hermes"
    # Rebuild ~/.hermes/.env from HERMESENV_<KEY> secrets. AgentHost never reads
    # or packs the local credential file; Fly secrets are the source of truth.
    # NUL-delimited read so
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
    if [ ! -f "$BOOT_DIR/.hermes-tools-0.19.0" ]; then
        echo "[agenthost] installing Hermes tools (uv + hermes-agent, first boot)..."
        if curl -LsSf https://astral.sh/uv/install.sh | sh && "$HOME/.local/bin/uv" tool install --force hermes-agent==0.19.0; then
            touch "$BOOT_DIR/.hermes-tools-0.19.0"
        else
            echo "[agenthost] WARN: Hermes tool install failed; will retry next boot. Claude Code is unaffected."
        fi
    fi
    if [ -f "$BOOT_DIR/.hermes-tools-0.19.0" ] && [ -f "$HOME/.hermes/config.yaml" ]; then
        HERMES_READY=1
    elif [ -f "$BOOT_DIR/.hermes-tools-0.19.0" ]; then
        echo "[agenthost] Hermes installed; create $HOME/.hermes/config.yaml on this box to start it"
    fi
fi

# 1b-seam. Board re-share ticker (Foundation B). Hermes-agent's Python startup
# chmods ~/.hermes back to 0700 (owner-only) AFTER entrypoint's one-shot gate-state
# migration already shared it -- so the gate uid (in the boxstate group) loses the
# ability to TRAVERSE ~/.hermes and the board reads empty (confirmed on the live box
# 2026-07-25: .hermes dir reset to 700 while every other shared root stayed 2770).
# A one-shot fix races Hermes's own startup; instead re-assert group-traversal on a
# timer so the board self-heals within one tick no matter when Hermes resets its dir.
# Runs as `agent` (owns ~/.hermes, so it can chmod it); guarded on the flag so it is
# a no-op with Foundation B off. ONLY ~/.hermes -- .claude is already 0755-traversable
# and holds nothing gate needs shared (credentials never migrate; security-invariant #2).
if [ "${AGENTHOST_FOUNDATION_B:-}" = "1" ]; then
    (
        while true; do
            if [ -d "$HOME/.hermes" ]; then
                # Target: setgid + group rwx (the boxstate group -- which gate is in --
                # must be able to traverse to kanban.db/state.db; setgid keeps new
                # children group-shared). Re-assert only when it has DRIFTED, to avoid
                # needless metadata writes. The drift check is FUNCTIONAL, not a string
                # match on `stat %a` (that output's setgid/leading-zero rendering is not
                # portable): the group is wrong OR the group lacks any of r/w/x. `find`
                # perm masks read the bits directly and are exact.
                grp=$(stat -c '%G' "$HOME/.hermes" 2>/dev/null || echo "")
                has_grwx=$(find "$HOME/.hermes" -maxdepth 0 -perm -g+rwx -perm -2000 2>/dev/null)
                if [ "$grp" != "boxstate" ] || [ -z "$has_grwx" ]; then
                    chgrp boxstate "$HOME/.hermes" 2>/dev/null || true
                    chmod 2770 "$HOME/.hermes" 2>/dev/null || true
                fi
            fi
            # Cadence: FAST through the boot window, cheap after. Hermes's Python
            # startup resets the dir more than once while it comes up, so a flat 30s
            # heal leaves the board unreadable for most of the first two minutes --
            # observed live 2026-07-27, two `hermes kanban` PermissionErrors on
            # /data/home/agent/.hermes/.env 70 seconds apart on the same boot, then
            # none once Hermes settled. 2s for ~3 minutes closes that window to one
            # tick; after that the drift is rare and 30s costs nothing.
            ticks=$((${ticks:-0} + 1))
            if [ "$ticks" -lt 90 ]; then sleep 2; else sleep 30; fi
        done
    ) &
    echo "[agenthost] board re-share ticker up (keeps ~/.hermes group-traversable for the gate uid)"
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
# The dashboard writes GITHUB_TOKEN to the protected box-secret file. Load that
# one named value as data before Git setup so a token saved after deploy is the
# token used for auth setup and fresh clones on the next boot. A malformed store
# is named and ignored atomically by the strict loader; an existing Fly-provided
# GITHUB_TOKEN can still supply the legacy path.
. /opt/agenthost/secret-env.sh
agenthost_load_secrets_env "$AGENTHOST_BOX_SECRETS_FILE" GITHUB_TOKEN \
    || echo "[agenthost] WARN: GitHub credential in the box secret file could not be loaded safely"
if [ -n "${GITHUB_TOKEN:-}" ]; then
    export GH_TOKEN="$GITHUB_TOKEN"
    # The official `github` plugin's MCP (api.githubcopilot.com) authenticates
    # with a PAT read from GITHUB_PERSONAL_ACCESS_TOKEN, not GH_TOKEN -- without
    # this the server MCP always fails "not authenticated" even when a token is
    # provided. Reuse the one GitHub token the user handed us for both git and
    # the MCP, replacing stale aliases after a dashboard-side rotation.
    export GITHUB_PERSONAL_ACCESS_TOKEN="$GITHUB_TOKEN"
    gh auth setup-git || echo "[agenthost] WARN: gh auth setup-git failed; git pushes will not authenticate"
    git config --global user.name  "${GIT_USER_NAME:-agenthost}"
    git config --global user.email "${GIT_USER_EMAIL:-agent@agenthost.space}"
fi

# 3. Clone selected repos (fresh clones; never copied from the laptop).
mkdir -p "$HOME/work"
# outbox: the drop-zone agents write files into for Steve to download from the
# Files panel (gate.js FILE_ROOTS). inbox: the reverse -- files Steve uploads
# from his PC/phone land here for the TEAM to use. artifacts: rendered documents
# (.html self-contained, or .md auto-rendered) served by the Artifacts panel.
# All created every boot.
mkdir -p "$HOME/outbox" "$HOME/inbox" "$HOME/artifacts"
REPO_LIST=()
if [ -n "${REPOS:-}" ]; then
    IFS=',' read -ra REPO_LIST <<< "$REPOS"
    for repo in "${REPO_LIST[@]}"; do
        dir="$HOME/work/$(basename "$repo")"
        if [ ! -d "$dir" ]; then
            echo "[agenthost] cloning $repo..."
            # Same reasoning as the engine workspaces below: the shared checkout
            # is written by both the agent and the gate, so it is shared from the
            # moment it exists rather than from the next boot's repair pass.
            # Non-fatal, and an `if` rather than `&& ... ||` so a config failure
            # cannot print a misleading "clone failed" for a clone that worked.
            #
            # Plain `git`, NOT git_isolation, and that is deliberate: this block
            # is top-level boot code that runs here, while git_isolation() is not
            # defined until ~50 lines below. Calling it would be "command not
            # found" -- silently swallowed by the `|| true` and doing nothing at
            # all, which is the worst possible outcome for a hardening line.
            # (Suggested in review for consistency; rejected on definition order.
            # A local `git config` write cannot be overridden by global config
            # anyway, so isolation buys nothing here.)
            if git clone "https://github.com/$repo" "$dir"; then
                git -C "$dir" config core.sharedRepository group >/dev/null 2>&1 || true
            else
                echo "[agenthost] WARN: clone failed for $repo"
            fi
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

# 4c. Per-engine workspace isolation. Claude/Hermes use linked Git worktrees on
#     branch `<engine>/work`; Codex/Gemini use independent local clones. Their
#     .git directories must live inside /workspace because the autonomous jail
#     intentionally cannot follow a linked-worktree .git pointer back into
#     the shared source checkout. Every engine still edits its own branch, never
#     the shared ~/work copy the human uses.
#
#     Fail-safe: each repo runs in its own guarded subshell -- a failure logs +
#     continues. Gemini then stays outside shared ~/work; the other engines keep
#     their existing fallback. No REPOS / no git repos => clean no-op. Re-runnable
#     every boot: an existing valid workspace is reused, never recreated.
#
#     make_worktree <engine> <branch>: the proven Phase 2 loop body, parameterized.
#     git_isolation keeps boot-time Git from honoring a worktree's hooks, fsmonitor,
#     credential helper, or hostile local/global config. Treat every .git as agent-
#     writable data, not as trusted host configuration.
git_isolation() {
    env -i \
        PATH=/usr/local/bin:/usr/bin:/bin HOME="$HOME" LANG="${LANG:-C.UTF-8}" \
        GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null \
        GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 \
        git -c core.hooksPath=/dev/null -c core.fsmonitor=false \
            -c core.attributesFile=/dev/null -c core.excludesFile=/dev/null \
            -c core.pager=cat -c core.sshCommand= -c credential.helper= \
            -c commit.gpgSign=false -c tag.gpgSign=false "$@"
}

workspace_root_for_engine() {
    local engine="$1" parent="$HOME/workspaces" root="$HOME/workspaces/$1" home_real parent_real root_real
    if [ -e "$parent" ] || [ -L "$parent" ]; then
        [ -d "$parent" ] && [ ! -L "$parent" ] || return 1
    else
        mkdir -- "$parent" || return 1
    fi
    if [ -e "$root" ] || [ -L "$root" ]; then
        [ -d "$root" ] && [ ! -L "$root" ] || return 1
    else
        mkdir -- "$root" || return 1
    fi
    home_real="$(readlink -f -- "$HOME")" || return 1
    parent_real="$(readlink -f -- "$parent")" || return 1
    root_real="$(readlink -f -- "$root")" || return 1
    [ "$parent_real" = "$home_real/workspaces" ] && [ "$root_real" = "$parent_real/$engine" ] || return 1
    printf '%s\n' "$root_real"
}

workspace_path_is_real_child() {
    local root="$1" child="$2" root_real child_real
    [ -d "$root" ] && [ ! -L "$root" ] && [ -d "$child" ] && [ ! -L "$child" ] || return 1
    root_real="$(readlink -f -- "$root")" || return 1
    child_real="$(readlink -f -- "$child")" || return 1
    [ "$root_real" = "$root" ] && [ "$child_real" = "$root_real/${child##*/}" ]
}

git_dir_is_real() {
    local repo="$1" repo_real git_dir="$1/.git" git_real
    [ -d "$git_dir" ] && [ ! -L "$git_dir" ] || return 1
    repo_real="$(readlink -f -- "$repo")" || return 1
    git_real="$(readlink -f -- "$git_dir")" || return 1
    [ "$git_real" = "$repo_real/.git" ] || return 1
    [ ! -e "$git_dir/commondir" ] && [ ! -L "$git_dir/commondir" ]
}

git_config_is_safe() {
    local config="$1"
    [ -f "$config" ] && [ ! -L "$config" ] || return 1
    ! grep -Eiq '^[[:space:]]*\[(include|includeif|filter)([[:space:]]|]|\"|\.)' "$config"
}

independent_workspace_is_safe() {
    local root="$1" wt="$2" branch="$3" git_dir="$2/.git" head="$2/.git/HEAD" index="$2/.git/index"
    workspace_path_is_real_child "$root" "$wt" || return 1
    git_dir_is_real "$wt" || return 1
    git_config_is_safe "$git_dir/config" || return 1
    [ ! -e "$git_dir/config.worktree" ] && [ ! -L "$git_dir/config.worktree" ] || return 1
    if [ -n "$branch" ]; then
        [ -f "$head" ] && [ ! -L "$head" ] || return 1
        [ -f "$index" ] && [ ! -L "$index" ] || return 1
        [ "$(cat -- "$head")" = "ref: refs/heads/$branch" ] || return 1
    fi
}

make_independent_workspace() {
    local engine="$1" branch="$2" repo base src wt tmp backup workspace_root branch_exists
    if ! workspace_root="$(workspace_root_for_engine "$engine")"; then
        echo "[agenthost] WARN: $engine workspace root is unsafe; leaving it untouched"
        return 0
    fi
    [ -n "${REPOS:-}" ] || return 0
    for repo in "${REPO_LIST[@]}"; do
        base="$(basename "$repo")"
        src="$HOME/work/$base"
        wt="$workspace_root/$base"
        case "$base" in
            ""|.|..) echo "[agenthost] $engine isolation: invalid repository name '$repo'; skipping"; continue ;;
        esac
        if ! workspace_path_is_real_child "$HOME/work" "$src" || ! git_dir_is_real "$src" \
            || ! git_isolation -C "$src" rev-parse --git-dir >/dev/null 2>&1; then
            echo "[agenthost] $engine isolation: '$base' is not a safe git repo under ~/work; skipping"
            continue
        fi
        (
            set -e
            # This image-owned file is read-only to the agent. Opening it read-only
            # prevents an agent-controlled workspace symlink from redirecting or
            # truncating the lock before provisioning begins.
            exec 9< /opt/agenthost/workspace-provision.lock
            flock -x 9
            workspace_root="$(workspace_root_for_engine "$engine")" || {
                echo "[agenthost] WARN: $engine workspace root changed while waiting for provisioning; leaving it untouched"
                exit 0
            }
            wt="$workspace_root/$base"
            if ! workspace_path_is_real_child "$HOME/work" "$src" || ! git_dir_is_real "$src"; then
                echo "[agenthost] WARN: $engine source checkout is unsafe: $src; skipping"
                exit 0
            fi
            if independent_workspace_is_safe "$workspace_root" "$wt" "$branch"; then
                echo "[agenthost] $engine independent workspace reused: $wt (branch $branch)"
                echo "[agenthost] $engine workspace size: $(du -sh "$wt" 2>/dev/null | cut -f1) ($base)"
                exit 0
            fi
            if independent_workspace_is_safe "$workspace_root" "$wt" "" \
                && [ -f "$wt/.git/index" ] && [ ! -L "$wt/.git/index" ]; then
                echo "[agenthost] WARN: $engine workspace is not on $branch: $wt; preserving it"
                exit 0
            fi
            if [ -e "$wt" ] || [ -L "$wt" ]; then
                # Never run host-side Git against a stale linked, symlinked, or
                # otherwise malformed workspace. Rename it in-place (which does
                # not follow a symlink), preserve it for inspection, then create a
                # fresh independent clone at the canonical path.
                backup="$workspace_root/.${base}.quarantined-$$"
                while [ -e "$backup" ] || [ -L "$backup" ]; do backup="$workspace_root/.${base}.quarantined-$$-$RANDOM"; done
                mv -- "$wt" "$backup"
                echo "[agenthost] WARN: $engine workspace was unsafe; preserved it at $backup and rebuilding $wt"
            fi
            tmp="${wt}.clone-$$"
            while [ -e "$tmp" ] || [ -L "$tmp" ]; do tmp="${wt}.clone-$$-$RANDOM"; done
            cleanup_independent_clone() {
                case "${tmp:-}" in
                    "$HOME/workspaces/$engine/"*.clone-*) [ -d "$tmp" ] && rm -rf -- "$tmp" ;;
                esac
            }
            trap cleanup_independent_clone EXIT
            if git_isolation -C "$src" show-ref --verify --quiet "refs/heads/$branch"; then
                branch_exists=1
                git_isolation clone --no-local --no-checkout --branch "$branch" "$src" "$tmp" >/dev/null
            else
                branch_exists=0
                git_isolation clone --no-local --no-checkout "$src" "$tmp" >/dev/null
            fi
            if ! independent_workspace_is_safe "$workspace_root" "$tmp" ""; then
                echo "[agenthost] WARN: $engine clone has unsafe Git metadata: $base; leaving it untouched"
                exit 1
            fi
            # SHARED FROM BIRTH, not from the next boot.
            #
            # entrypoint.sh repairs existing worktrees so the gate (uid 997) can
            # write the .git trees it commits into -- but entrypoint runs BEFORE
            # this function, so a workspace cloned during THIS boot carried no
            # core.sharedRepository until the NEXT one. In that window a gate
            # commit creates 0644 objects the agent cannot rewrite: the same
            # lockout the repair exists to prevent, pointed the other way.
            #
            # POSITION IS THE WHOLE POINT and I had it wrong first: this must run
            # BEFORE the checkout/reset below. Those commands create or update
            # the engine branch and materialize its index and working tree.
            # Setting sharedRepository after them leaves the Git files they
            # create at 0644 -- the fix would look applied but change nothing
            # that mattered. The clone above is intentionally --no-checkout.
            # (Kimi caught the ordering; the first safety check has already
            # passed, and the second one below still inspects real metadata.)
            #
            # Deliberately non-fatal: an unshared workspace is repaired on the
            # next boot and is never a reason to fail a boot.
            git_isolation -C "$tmp" config core.sharedRepository group >/dev/null 2>&1 || true
            if [ "$branch_exists" = 1 ]; then
                git_isolation -C "$tmp" checkout "$branch" >/dev/null
            else
                git_isolation -C "$tmp" checkout -b "$branch" >/dev/null
            fi
            git_isolation -C "$tmp" reset --hard "$branch" >/dev/null
            if ! independent_workspace_is_safe "$workspace_root" "$tmp" "$branch"; then
                echo "[agenthost] WARN: $engine clone failed independent-workspace verification: $base"
                exit 1
            fi
            [ ! -e "$wt" ] && [ ! -L "$wt" ] || { echo "[agenthost] WARN: $engine workspace appeared while rebuilding: $wt"; exit 1; }
            mv -- "$tmp" "$wt"
            tmp=""
            echo "[agenthost] $engine independent workspace created: $wt (branch $branch)"
            echo "[agenthost] $engine workspace size: $(du -sh "$wt" 2>/dev/null | cut -f1) ($base)"
        ) || {
            if [ "$engine" = "gemini" ]; then
                echo "[agenthost] WARN: Gemini workspace for $base failed; Gemini stays outside shared ~/work"
            else
                echo "[agenthost] WARN: $engine workspace for $base failed; $engine falls back to shared ~/work"
            fi
        }
    done
    return 0
}

make_worktree() {
    local engine="$1" branch="$2" repo base src wt
    if [ "$engine" = "codex" ] || [ "$engine" = "gemini" ] || [ "$engine" = "deepseek" ]; then
        make_independent_workspace "$engine" "$branch"
        return
    fi
    mkdir -p "$HOME/workspaces/$engine"
    [ -n "${REPOS:-}" ] || return 0
    for repo in "${REPO_LIST[@]}"; do
        base="$(basename "$repo")"
        src="$HOME/work/$base"
        wt="$HOME/workspaces/$engine/$base"
        # Skip anything that isn't a git repo (e.g. a clone that failed above).
        if ! git -C "$src" rev-parse --git-dir >/dev/null 2>&1; then
            echo "[agenthost] $engine isolation: '$base' is not a git repo under ~/work; skipping"
            continue
        fi
        (
            set -e
            if git -C "$wt" rev-parse --git-dir >/dev/null 2>&1; then
                # Idempotent path: worktree already exists -> reuse it, just refresh.
                git -C "$wt" fetch --quiet --all 2>/dev/null || true
                echo "[agenthost] $engine worktree reused: $wt (branch $branch)"
            else
                # First time: create the isolated worktree on branch <engine>/work.
                # Prune any stale registration pointing at a now-gone path, then
                # add -b if the branch is new, else check out the existing branch.
                git -C "$src" worktree prune 2>/dev/null || true
                if git -C "$src" show-ref --verify --quiet "refs/heads/$branch"; then
                    git -C "$src" worktree add "$wt" "$branch" >/dev/null
                else
                    git -C "$src" worktree add -b "$branch" "$wt" >/dev/null
                fi
                echo "[agenthost] $engine worktree created: $wt (branch $branch)"
            fi
            # Disk honesty: the working tree is the only added weight (the object
            # store is shared with ~/work).
            echo "[agenthost] $engine worktree size: $(du -sh "$wt" 2>/dev/null | cut -f1) ($base)"
        ) || echo "[agenthost] WARN: $engine worktree for $base failed; $engine falls back to shared ~/work"
    done
}

# Disk guard: six engines x N repos of working trees. The object store is shared
# (cheap) but each working tree is real bytes. Skip isolation entirely when /data
# is low on space (<2GB free) rather than risk filling the volume everything else
# writes to -- mirrors the OLLAMA_LOCAL_MODEL guard below. Gemini then stays
# outside shared ~/work; the existing engine-terminal fallback is unchanged.
# Retried on the next boot.
if [ -n "${REPOS:-}" ] && [ "$(df -k /data 2>/dev/null | awk 'NR==2 {print $4}')" -lt 2097152 ] 2>/dev/null; then
    echo "[agenthost] WARN: skipping per-engine workspace isolation: <2GB free on /data (Gemini stays outside shared ~/work)"
else
    ws_before_k="$(du -sk "$HOME/workspaces" 2>/dev/null | cut -f1 || echo 0)"
    make_worktree codex  codex/work
    make_worktree claude claude/work
    make_worktree hermes hermes/work
    make_worktree gemini gemini/work
    make_worktree kimi   kimi/work
    make_worktree deepseek deepseek/work
    ws_after_k="$(du -sk "$HOME/workspaces" 2>/dev/null | cut -f1 || echo 0)"
    echo "[agenthost] workspace isolation total: $(du -sh "$HOME/workspaces" 2>/dev/null | cut -f1) (added ~$(( (ws_after_k - ws_before_k) / 1024 ))MB this boot)"
fi

# 4d. Agent Memory Service. Each agent on the box gets a per-agent API key that
#     scopes their reads/writes to their own memories + shared memories. Keys
#     are written to ~/.memory.env (0600) so any agent shell can source it.
#     The service URL is a Fly secret; keys are minted by the seeder script
#     and passed as MEMORY_KEY_<ENGINE> secrets. Never logged.
if [ -n "${MEMORY_SERVICE_URL:-}" ]; then
    mkdir -p "$HOME/.agenthost"
    # Write a single file all agents can source; each agent reads its own key.
    {
        echo "# Agent Memory Service — source this file to get your key"
        echo "# Usage: source ~/.memory.env && curl -H \"Authorization: Bearer \$MEMORY_API_KEY\" \$MEMORY_SERVICE_URL/memory?q=..."
        echo "MEMORY_SERVICE_URL=$MEMORY_SERVICE_URL"
        for engine_key in CODEX CLAUDE HI KH KIMI GEMINI CURSOR STEVE; do
            var="MEMORY_KEY_${engine_key}"
            val="${!var:-}"
            if [ -n "$val" ]; then
                echo "MEMORY_KEY_${engine_key}=$val"
            fi
        done
    } > "$HOME/.memory.env"
    chmod 600 "$HOME/.memory.env"
    echo "[agenthost] memory service wired -> $MEMORY_SERVICE_URL (keys in ~/.memory.env)"
fi

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
# pane_in_mode stayed 0). The generated shell's terminal frame translates the
# phone gesture, and it still needs this tmux option on.
tmux set-option -t agent -g mouse on

# 5b. tmux seam (Foundation B identity split). The gate uid must NEVER hold a tmux
#     client capability -- a tmux client can send-keys/run-shell = arbitrary code as
#     `agent` (incl. typing into the live claude window). So the agent PUBLISHES the
#     window list to a file gate can only read, and CONSUMES two fixed verbs
#     (select <name>, ensure-claude) from a FIFO gate can only write; the executed
#     tmux commands live in tmux-seam.sh, never in the FIFO. Runs in BOTH flag
#     states: flag-off gate.js IS this stack (agent uid), so it proves only the
#     plumbing -- the split is proven by the flag-on negative tests, not here.
#     Loops are backgrounded OUTSIDE tmux on purpose (must not appear as windows).
#     Permission arithmetic is the security argument -- do not relax any bit:
#       dir  agent:boxstate 2750 -> gate can traverse+list, NOT create/unlink/rename
#       state agent:boxstate 0640 -> gate reads, cannot write
#       fifo  agent:boxstate 0620 -> gate writes only, cannot read/drain
SEAM_DIR="$HOME/.tmux-seam"
if [ -p "$SEAM_DIR/cmd.fifo" ] && pgrep -f 'tmux-seam.sh drain-loop' >/dev/null 2>&1; then
    echo "[agenthost] tmux seam already live; leaving it alone (mid-uptime re-run)"
else
    rm -rf "$SEAM_DIR"
    mkdir -p "$SEAM_DIR"
    getent group boxstate >/dev/null 2>&1 && { chgrp boxstate "$SEAM_DIR" || echo "[agenthost] WARN: tmux seam dir chgrp failed"; }
    chmod 2750 "$SEAM_DIR"
    mkfifo -m 0620 "$SEAM_DIR/cmd.fifo"
    getent group boxstate >/dev/null 2>&1 && { chgrp boxstate "$SEAM_DIR/cmd.fifo" || echo "[agenthost] WARN: tmux seam fifo chgrp failed"; }
    chmod 0620 "$SEAM_DIR/cmd.fifo"
    ( while true; do bash /opt/agenthost/tmux-seam.sh publish-loop; sleep 1; done ) &
    ( while true; do bash /opt/agenthost/tmux-seam.sh drain-loop;   sleep 1; done ) &
    echo "[agenthost] tmux seam up ($SEAM_DIR)"
fi

# A plain bash window, always present: until 2026-07-20 every tmux window ran
# an agent CLI, so the ONLY path to a bare shell on the box was quitting the
# agent and hitting Ctrl-C inside the 3s restart countdown -- undiscoverable,
# and impossible on a phone. The app switcher's "shell" tab targets this.
tmux new-window -t agent -n shell \
    "bash -lc 'while true; do bash -l; echo \"[agenthost] shell exited; reopening in 1s (Ctrl-C to stop)\"; sleep 1 || break; done'" \
    || echo "[agenthost] WARN: could not start shell window"

# 5a. Terminal apps: extra tmux windows the app switcher can jump to (the gate's
#     APPS list; a tab links /?window=<name> and appshell selects that window).
#     Codex (OpenAI) is baked into the image; run it in a window, dropping to a
#     shell if it exits or isn't logged in yet (so you can `codex login` there).
#     Guarded on the binary existing so a build without it just skips the window.
if command -v codex >/dev/null 2>&1; then
    # Phase 2: open Codex IN its own isolated workspace (the codex/work worktree
    # of the primary repo -- first entry in REPOS) when it exists, else fall back
    # to the shared ~/work (today's behavior: no REPOS, or worktree creation
    # failed above). Only this window's cwd changes; all others stay on ~/work.
    codex_cwd="$HOME/work"
    if [ ${#REPO_LIST[@]} -gt 0 ]; then
        primary_wt="$HOME/workspaces/codex/$(basename "${REPO_LIST[0]}")"
        [ -d "$primary_wt" ] && codex_cwd="$primary_wt"
    fi
    # The restart notice only blames LOGIN when auth is actually missing --
    # otherwise a clean quit (Ctrl-C/Ctrl-D) printed "run codex login to
    # authenticate", which reads as an auth failure and alarmed Steve when
    # Codex was fine (investigation 2026-07-18). Conditional on ~/.codex/auth.json.
    tmux new-window -t agent -n codex -c "$codex_cwd" \
        "bash -lc 'while true; do codex 2>&1; if [ -s \"\$HOME/.codex/auth.json\" ]; then echo \"[codex] exited; restarting in 5s, Ctrl-C for a shell\"; else echo \"[codex] not logged in -- run: codex login (restarting in 5s, Ctrl-C for a shell)\"; fi; sleep 5 || break; done; exec bash'" \
        || echo "[agenthost] WARN: could not start codex window"
fi

#     DeepSeek runs headlessly through the gate-owned relay and jail. This is a
#     workspace terminal only: it intentionally loads no provider credential
#     and never launches dsh outside the governed autonomous path.
deepseek_cwd="$HOME"
deepseek_root="$HOME/workspaces/deepseek"
if [ -d "$deepseek_root" ] && [ ! -L "$deepseek_root" ]; then
    for repo in "${REPO_LIST[@]}"; do
        candidate="$deepseek_root/$(basename "$repo")"
        if independent_workspace_is_safe "$deepseek_root" "$candidate" "deepseek/work"; then
            deepseek_cwd="$candidate"
            break
        fi
    done
fi
tmux new-window -t agent -n deepseek -c "$deepseek_cwd" \
    "bash -lc 'echo \"[deepseek] Workspace shell only. Start governed DeepSeek work from AgentHost; no interactive key or dsh process is loaded here.\"; exec bash'" \
    || echo "[agenthost] WARN: could not start deepseek workspace window"

#     Claude workspace shell (Phase 2.5, Decision A). A SEPARATE window opening in
#     Claude's isolated worktree (~/workspaces/claude/<primary repo>) -- a plain
#     shell for working/committing on branch claude/work without touching the
#     shared ~/work. Window 0 (the main "claude" terminal tab) is DELIBERATELY
#     left on ~/work so the human's terminal stays where they expect it; this is
#     an ADDITIONAL surface, not a move. Only created when the worktree exists
#     (REPOS set + isolation succeeded above); otherwise skipped entirely.
if [ ${#REPO_LIST[@]} -gt 0 ]; then
    claude_ws="$HOME/workspaces/claude/$(basename "${REPO_LIST[0]}")"
    if [ -d "$claude_ws" ]; then
        tmux new-window -t agent -n claude-ws -c "$claude_ws" \
            "bash -lc 'echo \"[agenthost] Claude workspace (branch claude/work) -- isolated from ~/work\"; exec bash'" \
            || echo "[agenthost] WARN: could not start claude-ws window"
    fi
fi

#     Gemini (Google) is baked in too -- an interactive terminal window alongside
#     its chat-router engine. It reads GEMINI_API_KEY from the box secret store
#     (the window loads it); with no key it starts and prompts for auth. Drops
#     to a shell on exit so the operator can configure it.
if command -v gemini >/dev/null 2>&1; then
    # The interactive gemini CLI reads GEMINI_API_KEY from its ENVIRONMENT, but
    # the box secret store is a FILE ($AGENTHOST_BOX_SECRETS_FILE), not exported
    # into this shell -- so the window must load it itself (chat works because
    # gate.js injects the secret per-spawn via chatEnv(); the terminal window
    # had no such path and fell to the interactive Google sign-in prompt). The
    # trusted loader exports each strict NAME=value entry as data into the window so
    # Gemini picks up GEMINI_API_KEY and auto-selects the API-key auth method.
    # Same conditional-notice fix as codex: only mention the missing key when
    # GEMINI_API_KEY is actually unset; a clean quit gets a neutral notice.
    gemini_cwd="$HOME"
    gemini_root="$HOME/workspaces/gemini"
    if [ -d "$gemini_root" ] && [ ! -L "$gemini_root" ]; then
        gemini_root_real="$(readlink -f "$gemini_root" 2>/dev/null || true)"
        if [ -n "$gemini_root_real" ]; then
            for repo in "${REPO_LIST[@]}"; do
                candidate="$gemini_root/$(basename "$repo")"
                if independent_workspace_is_safe "$gemini_root" "$candidate" "gemini/work"; then
                    gemini_cwd="$candidate"
                    break
                fi
            done
        fi
    fi
    if [ "$gemini_cwd" = "$HOME" ] && [ ${#REPO_LIST[@]} -gt 0 ]; then
        echo "[agenthost] WARN: Gemini workspace unavailable; opening Gemini outside shared ~/work"
    fi
    tmux new-window -t agent -n gemini -c "$gemini_cwd" \
        "bash -lc '. /opt/agenthost/secret-env.sh; agenthost_load_secrets_env \"\$AGENTHOST_BOX_SECRETS_FILE\" GEMINI_API_KEY || { echo \"[agenthost] WARN: Gemini was not started because the box secret file could not be loaded safely\"; exec bash; }; while true; do gemini 2>&1; if [ -n \"\${GEMINI_API_KEY:-}\" ]; then echo \"[gemini] exited; restarting in 5s, Ctrl-C for a shell\"; else echo \"[gemini] no API key -- set the GEMINI_API_KEY secret (restarting in 5s, Ctrl-C for a shell)\"; fi; sleep 5 || break; done; exec bash'" \
        || echo "[agenthost] WARN: could not start gemini window"
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
# 5d. Kimi Code CLI — chat-only engine with a workspace (CONT-03).
#     Kimi runs interactively in its own tmux window. The workspace exists but
#     autoJail is false — no autonomous work until a later package passes
#     workspace isolation review. MOONSHOT_API_KEY from the box secret store.
if command -v kimi >/dev/null 2>&1; then
    kimi_ws="$HOME/workspaces/kimi"
    mkdir -p "$kimi_ws"
    tmux new-window -t agent -n kimi -c "$kimi_ws" \
        "bash -lc '. /opt/agenthost/secret-env.sh; agenthost_load_secrets_env \"\$AGENTHOST_BOX_SECRETS_FILE\" MOONSHOT_API_KEY || { echo \"[agenthost] WARN: Kimi was not started because the box secret file could not be loaded safely\"; exec bash; }; while true; do kimi 2>&1; if [ -n \"\${MOONSHOT_API_KEY:-}\" ]; then echo \"[kimi] exited; restarting in 5s, Ctrl-C for a shell\"; else echo \"[kimi] no API key -- set the MOONSHOT_API_KEY secret (restarting in 5s, Ctrl-C for a shell)\"; fi; sleep 5 || break; done; exec bash'" \
        || echo "[agenthost] WARN: could not start kimi window"
fi

#     Cursor (Anysphere) is baked in as a human-driven terminal and chat engine.
#     This block deliberately creates no Cursor worktree or autonomous runner:
#     the terminal opens in HOME, and the operator chooses what to do there.
#     CURSOR_API_KEY comes from the same box secret file as the fixed chat path.
if [ -x /usr/local/bin/cursor-agent ]; then
    tmux new-window -t agent -n cursor -c "$HOME" \
        /usr/bin/env -i HOME=/data/home/agent PATH=/usr/local/bin:/usr/bin:/bin TERM=screen USER=agent LOGNAME=agent SHELL=/bin/bash \
        AGENTHOST_BOX_SECRETS_FILE="$AGENTHOST_BOX_SECRETS_FILE" \
        /opt/agenthost/cursor-terminal.sh \
        || echo "[agenthost] WARN: could not start cursor window"
fi

# service_enabled <name>: reads services.<name>.enabled from the settings store
# (~/.agenthost/settings.json, the settings-lib file). Returns 0 (enabled) unless
# the flag is EXPLICITLY false -- so a missing file, a corrupt file, a missing
# key, or node-not-present all fail OPEN to today's behavior (contract #3). This
# is a NEXT-BOOT control by design: the settings page toggles the preference; it
# takes effect here on restart, never as a live kill (killing Ollama mid-turn
# would break Hermes). node is always present in this image.
service_enabled() {
    local name="$1"
    SETTINGS_NAME="$name" node -e '
        const fs = require("fs");
        const name = process.env.SETTINGS_NAME;
        const f = (process.env.HOME || "/data/home/agent") + "/.agenthost/settings.json";
        try {
            const s = JSON.parse(fs.readFileSync(f, "utf8"));
            // Only an explicit false disables; anything else -> enabled.
            if (s && s.services && s.services[name] && s.services[name].enabled === false) process.exit(1);
        } catch {}
        process.exit(0);
    ' 2>/dev/null
}

if command -v ollama >/dev/null 2>&1 && service_enabled ollama; then
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
elif command -v ollama >/dev/null 2>&1; then
    # Installed but disabled by settings.services.ollama.enabled=false. Flag the
    # consequence loudly: Hermes's local inference endpoint won't exist this boot.
    echo "[agenthost] ollama disabled by settings; Hermes local inference will be unavailable"
fi

# 5b. Hermes interactive agent window. The standalone Hermes web dashboard was
#     retired from the operator origin, so do not keep its daemon, token, or
#     restart loop alive behind a route that no longer exists. The normal Hermes
#     CLI remains a first-class tmux window and restarts like the other engines;
#     messaging gateway setup stays an explicit terminal action.
if [ "$HERMES_READY" = 1 ]; then
    tmux new-window -t agent -n hermes \
        "bash -lc 'export PATH=\"\$HOME/.local/bin:\$PATH\"; export HOME=$HOME HERMES_HOME=$HOME/.hermes; cd $HOME; while true; do hermes 2>&1; echo \"[hermes] exited; restarting in 5s, Ctrl-C for a shell\"; sleep 5 || break; done; exec bash -l'" \
        || echo "[agenthost] WARN: could not start Hermes agent window"
elif [ -d "$HOME/.hermes" ]; then
    echo "[agenthost] WARN: Hermes harness present but config/tools are not ready; skipping Hermes agent window"
fi

# 5c. OpenClaw (multi-channel messaging gateway): a SEPARATE agent people reach
#     from Telegram/Discord (WhatsApp stays with Hermes -- one WhatsApp session
#     per host). Its own daemon on localhost:18789, its own state dir
#     (~/.openclaw), fully isolated from Hermes. Baked into the image; runs only
#     when the operator has onboarded it (config present) so an unconfigured box
#     doesn't spin a dead daemon. Per-channel bot tokens + a model API key come
#     from the box secret store; the gateway window loads it through the SAME
#     strict NAME=value data parser as the gemini/kimi windows --
#     without that, CHANNEL_DISPATCH_TOKEN would be set on the box but invisible
#     to the channel broker plugin's `process.env` (the plugin reads it directly;
#     see openclaw-channel-broker/index.js), silently breaking the plugin's auth
#     to gate.js's /internal/channel-dispatch endpoint even though the secret is
#     configured correctly.
#     The window drops to a shell if the daemon exits or isn't set up yet, so the
#     operator can run `openclaw onboard` there. OPENCLAW_HOST pinned to loopback
#     (defense-in-depth like ollama/ttyd) so a dotfile can't expose :18789 on
#     Fly's private network.
mkdir -p "$HOME/.openclaw"
# The settings gate (service_enabled openclaw) is ADDITIONAL to the existing
# command-v/config guards -- an operator's explicit enabled=false suppresses the
# window; a missing/false-free setting file leaves today's behavior untouched.
if command -v openclaw >/dev/null 2>&1 && ! service_enabled openclaw; then
    echo "[agenthost] openclaw disabled by settings; messaging gateway will not start"
elif command -v openclaw >/dev/null 2>&1 && [ -f "$HOME/.openclaw/openclaw.json" ]; then
    # OPENAI_API_KEY placeholder (only when no real key exists): OpenClaw's embedded
    # runner resolves the agent MODEL before it runs the before_agent_run hook -- with
    # no provider key at all, an inbound message dies on ProviderAuthError BEFORE the
    # channel-broker plugin ever fires, so relay-only mode silently breaks (proven live
    # against openclaw@2026.6.33: no key -> hook never fires; any key -> hook fires and
    # blocks BEFORE the key is ever used, so the placeholder is never exercised on
    # brokered channels; see scripts/verify-openclaw-seam.mjs and
    # docs/continuity/CONT-05-SEAM-FINDINGS-2026-07-23.md). A real key from secrets.env
    # (loaded just before) always wins over the placeholder.
    tmux new-window -t agent -n openclaw \
        "bash -lc 'export HOME=$HOME OPENCLAW_HOST=127.0.0.1; cd $HOME; . /opt/agenthost/secret-env.sh; agenthost_load_secrets_env \"\$AGENTHOST_BOX_SECRETS_FILE\" OPENCLAW_GATEWAY_TOKEN CHANNEL_DISPATCH_TOKEN GEMINI_API_KEY OPENROUTER_API_KEY OLLAMA_API_KEY CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY OPENAI_API_KEY || { echo \"[agenthost] WARN: OpenClaw was not started because the box secret file could not be loaded safely\"; exec bash; }; export OPENAI_API_KEY=\"\${OPENAI_API_KEY:-agenthost-relay-placeholder-never-used}\"; while true; do openclaw gateway 2>&1 | tee -a $HOME/.openclaw/gateway-boot.log; echo \"[openclaw] gateway exited; restarting in 5s (Ctrl-C for a shell)\"; sleep 5 || break; done; exec bash'" \
        || echo "[agenthost] WARN: could not start openclaw window"
elif command -v openclaw >/dev/null 2>&1; then
    # Installed but not onboarded: give it a window with a shell so the operator
    # can run `openclaw onboard` to set up Telegram/Discord channels + a model key.
    tmux new-window -t agent -n openclaw \
        "bash -lc 'export HOME=$HOME; cd $HOME; echo \"[openclaw] not yet configured. Run: claw-setup  (guided Telegram/Discord setup; WhatsApp = use Hermes)\"; exec bash'" \
        || echo "[agenthost] WARN: could not start openclaw onboarding window"
fi

# 6. Serve the tmux session to any browser. ttyd binds loopback only; the gate
#    on :8080 does cookie/link auth (browser Basic-Auth prompts break on phones:
#    WebKit drops Authorization on WebSocket upgrades).
if [ "${AGENTHOST_SKIP_GATE:-}" != "1" ]; then
    : "${TTYD_PASSWORD:?TTYD_PASSWORD secret is required}"
fi
# Until 2026-07-27 ttyd listened on loopback TCP with NO credential at all, so
# ANY process on the box could open its socket and type as the agent: arbitrary
# code as agent, no auth. It now listens on a UNIX SOCKET instead, and the
# kernel's file permissions are the access check.
#
# Why a socket and not `-c user:password`: argv is world-readable through
# /proc/<pid>/cmdline (verified on the live box: -r--r--r--), so a credential
# passed on the command line is readable by every uid it is meant to exclude --
# including the gate uid. A password in argv would have been decoration. The
# socket carries no secret at all, so there is nothing to leak.
#
# Two independent gates, either one sufficient:
#   dir    agent:boxstate 0750 -> only agent + the boxstate group can traverse
#   socket agent:boxstate (-U) -> only agent + the boxstate group can connect
# Everything else on the box, whatever uid it runs as, has no path to the TTY.
#
# SCOPE, stated honestly: the gate is IN the boxstate group because proxying
# this terminal is its job -- handing an authenticated human a writable terminal
# as the agent is the product. So this does NOT make a compromised gate
# harmless. What it removes is every OTHER local process's free path.
TTYD_SOCK_DIR="$HOME/.claude/agenthost/ttyd"
TTYD_SOCK="$TTYD_SOCK_DIR/ttyd.sock"
mkdir -p "$TTYD_SOCK_DIR"
chmod 750 "$TTYD_SOCK_DIR"
getent group boxstate >/dev/null 2>&1 && { chgrp boxstate "$TTYD_SOCK_DIR" || echo "[agenthost] WARN: ttyd socket dir chgrp failed"; }
rm -f "$TTYD_SOCK"   # a stale socket file from the previous boot blocks the bind
# Client options: 15px mono reads well on phones; background matches the
# brand base (#0B0D10) so the app-shell chrome and terminal are seamless.
ttyd -i "$TTYD_SOCK" -U "agent:boxstate" --writable --base-path /terminal \
    -t fontSize=15 \
    -t 'theme={"background":"#0B0D10"}' \
    tmux attach-session -t agent &
# Foundation B split (DORMANT: AGENTHOST_SKIP_GATE is set ONLY by the flag-on
# boot entry, never by the default entrypoint path): under root PID-1 authority,
# gate.js is spawned by PID 1 directly as the `gate` user AFTER this stack is
# ready — the authority socket accepts only that exact recorded child. This
# script then owns just the agent-side stack (repos, tmux, ttyd): it signals
# readiness (PID 1 waits for the marker before spawning gate.js, preserving
# today's "gate starts after prep completes" ordering) and anchors the stack.
if [ "${AGENTHOST_SKIP_GATE:-}" = "1" ]; then
    # Finish the shared-state handoff as the unprivileged owner after this boot's
    # writers have run. Root performs the persisted-state pass before spawning
    # us; this second pass carries no authority beyond `agent`, so a rename or
    # symlink race inside the agent-owned home cannot redirect a privileged
    # chown/chmod. Gate-only authentication state is outside HOME and untouched.
    HOME="$HOME" node -e '
      const { migrateGateState } = require("/opt/agenthost/maintenance-gate-state-migration.js");
      migrateGateState({ home: process.env.HOME, log: (message) => process.stderr.write(`[agenthost] gate-state: ${message}\n`) });
    ' || { echo "[agenthost] FATAL: could not prepare shared gate state" >&2; exit 1; }
    mkdir -p "$HOME/.agenthost"
    : > "$HOME/.agenthost/stack-ready"
    echo "[agenthost] agent stack ready; gate.js is spawned by PID 1 (Foundation B)"
    exec sleep infinity
fi
unset NODE_OPTIONS NODE_PATH NODE_INSPECT_RESUME_ON_START LD_PRELOAD LD_LIBRARY_PATH
# Mode switch restart loop: when gate.js exits for a mode switch (SIGTERM),
# it exits with code 75 so this loop restarts it immediately (2 seconds)
# instead of waiting for Fly to restart the whole machine (3-5 minutes).
# Exit 0 = deliberate stop, do NOT restart. Any other non-zero = crash, restart.
# BEGIN FLAG-OFF GATE SUPERVISOR
gate_child_pid=""
gate_shutdown_requested=0
gate_shutdown_signal=""
gate_signal_forwarded=0
forward_gate_signal_to_child() {
    [ "$gate_signal_forwarded" -eq 0 ] || return 0
    if [ -n "${gate_child_pid:-}" ] && kill -0 "$gate_child_pid" 2>/dev/null; then
        gate_signal_forwarded=1
        local signal="$gate_shutdown_signal"
        kill -s "$signal" "$gate_child_pid" \
            || echo "[agenthost] WARN: could not forward $signal to gate.js pid $gate_child_pid" >&2
    fi
}
forward_gate_signal() {
    local signal="$1"
    [ "$gate_shutdown_requested" -eq 0 ] || return 0
    gate_shutdown_requested=1
    gate_shutdown_signal="$signal"
    forward_gate_signal_to_child
}
wait_for_gate_child() {
    local status
    while true; do
        wait "$gate_child_pid"
        status=$?
        # A trapped TERM/INT interrupts wait while the child is still alive.
        # Keep waiting until Bash has reaped the child, preserving every real
        # exit code including 127 instead of treating one value as a sentinel.
        if ! kill -0 "$gate_child_pid" 2>/dev/null; then
            EXIT_CODE=$status
            return
        fi
    done
}
trap 'forward_gate_signal TERM' TERM
trap 'forward_gate_signal INT' INT
while true; do
    if [ "$gate_shutdown_requested" -eq 1 ]; then
        echo "[agenthost] $gate_shutdown_signal shutdown arrived while gate.js was stopped; not restarting"
        exit 0
    fi
    node --disable-sigusr1 /opt/agenthost/gate.js &
    gate_child_pid=$!
    # Close the narrow race between the pre-spawn check and recording the pid.
    [ "$gate_shutdown_requested" -eq 0 ] || forward_gate_signal_to_child
    wait_for_gate_child
    if [ "$gate_shutdown_requested" -eq 1 ]; then
        gate_child_pid=""
        if [ "$EXIT_CODE" -eq 0 ]; then
            echo "[agenthost] gate.js completed the $gate_shutdown_signal shutdown cleanly"
            exit 0
        fi
        echo "[agenthost] gate.js failed during $gate_shutdown_signal shutdown (exit $EXIT_CODE)" >&2
        exit "$EXIT_CODE"
    fi
    gate_child_pid=""
    if [ "$EXIT_CODE" -eq 0 ]; then
        echo "[agenthost] gate.js exited cleanly (exit 0) — not restarting"
        break
    fi
    if [ "$EXIT_CODE" -eq 76 ]; then
        echo "[agenthost] gate.js could not prove an Assist process stopped — requesting a full container restart" >&2
        exit 1
    fi
    if [ "$EXIT_CODE" -eq 75 ]; then
        echo "[agenthost] gate.js exited (code 75 — mode switch) — restarting in 2s"
    else
        echo "[agenthost] gate.js exited (code $EXIT_CODE — crash recovery) — restarting in 2s"
    fi
    sleep 2
    if [ "$gate_shutdown_requested" -eq 1 ]; then
        echo "[agenthost] $gate_shutdown_signal shutdown arrived during gate.js restart backoff; not restarting"
        exit 0
    fi
done
# END FLAG-OFF GATE SUPERVISOR
