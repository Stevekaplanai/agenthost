# Build the tiny native Codex launcher separately, so the runtime image does
# not carry a compiler for credential isolation and process-tree cancellation.
FROM gcc:14-bookworm AS codex-auth-once-build
WORKDIR /build
COPY codex-auth-once.c ./
RUN gcc -O2 -Wall -Wextra -Werror -Wl,-z,relro,-z,now -o codex-auth-once codex-auth-once.c

# Root-owned maintenance authority boundary. The runtime carries only the
# fixed-purpose addon; compilation and its load/authority guard stay in this
# disposable build stage.
FROM node:22-bookworm AS maintenance-native-build
WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev \
    && rm -rf /var/lib/apt/lists/*
COPY Dockerfile entrypoint.sh entrypoint-launcher.c entrypoint-launcher.test.js ./
RUN gcc -O2 -Wall -Wextra -Werror -std=c17 -D_FORTIFY_SOURCE=3 -fstack-protector-strong \
    -fPIE -static-pie -Wl,-z,relro,-z,now,-z,noexecstack \
    -o entrypoint-launcher entrypoint-launcher.c
RUN ! readelf -lW entrypoint-launcher | grep -q ' INTERP ' \
    && ! readelf -dW entrypoint-launcher | grep -q ' NEEDED ' \
    && install -d -o root -g root -m 0755 /opt/agenthost \
    && install -o root -g root -m 0555 entrypoint.sh /opt/agenthost/entrypoint.sh \
    && AGENTHOST_ENTRYPOINT_LAUNCHER=/build/entrypoint-launcher node --test entrypoint-launcher.test.js
COPY maintenance-native.c ./
COPY maintenance-native.test.js ./
RUN gcc -shared -fPIC -O2 -Wall -Wextra -Werror -std=c17 -DNAPI_VERSION=8 \
    -Wl,-z,relro,-z,now,-z,noexecstack -I/usr/local/include/node \
    -o maintenance-native.node maintenance-native.c
RUN node --test maintenance-native.test.js

# DeepSeek Harness is built from the exact audited source commit. npm rc.6 did
# not match that audit and is deliberately never installed or resolved here.
# Match the runtime's Node major so native workspace dependencies (notably
# node-pty) cannot be built for Node 24 and then loaded by Node 22. The audited
# source explicitly supports Node ^22.19.0.
FROM node:22-bookworm AS deepseek-harness-build
WORKDIR /src
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN git init . \
    && git remote add origin https://github.com/deepseek-ai/deepseek-harness.git \
    && git fetch --depth=1 origin 47f943859bef60e4160492346772ded9b24f765a \
    && git checkout --detach 47f943859bef60e4160492346772ded9b24f765a \
    && test "$(git rev-parse HEAD)" = "47f943859bef60e4160492346772ded9b24f765a" \
    && node -e 'const p=require("./package.json"),c=require("./apps/cli/package.json"); if(p.version!=="0.1.0-rc.5"||c.version!=="0.1.0-rc.5") process.exit(1)'
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate \
    && test "$(pnpm --version)" = "11.7.0"
RUN pnpm install --frozen-lockfile
RUN pnpm run build
# pnpm deploy of the CLI alone omits peer-only Cordis packages that its runtime
# imports dynamically, while a production prune removes the root postinstall's
# own tool before pnpm re-runs that hook. Preserve the exact frozen workspace
# closure and its already-built Node-22 native modules; only Git metadata is
# discarded from the shipped image.
RUN rm -rf .git \
    && test "$(node apps/cli/lib/bin.js --version)" = "0.1.0-rc.5" \
    && ! grep -R -F '0.1.0-rc.6' package.json apps/cli/package.json node_modules/@deepseek-ai 2>/dev/null

# Graphify Phase 1 is a local, code-only structure map. Build its Python
# closure from one immutable base image and a complete hash lock; no optional
# LLM, document, server, hook, or visualization extras enter the runtime.
FROM python:3.11-slim-bookworm@sha256:2e32f7d302adc1c37428355c1e646897c0c53f4fd60b6a551245fb90ee129f91 AS graphify-python
ARG GRAPHIFY_WHEEL_URL=https://files.pythonhosted.org/packages/42/85/8815079c028dbd0ce79259e3156767a7884805c7775185e5750249b63704/graphifyy-0.9.42-py3-none-any.whl
ARG GRAPHIFY_WHEEL_SHA256=d87bec57d5dbca1203ce719f4b4afb83ae5eb6cea1b4af2d62d0c10c1c3e26e6
COPY graphify-requirements-linux-x86_64-py311.txt /tmp/graphify-requirements.txt
RUN python -m pip download --disable-pip-version-check --no-deps --only-binary=:all: --dest /tmp "$GRAPHIFY_WHEEL_URL" \
    && echo "$GRAPHIFY_WHEEL_SHA256  /tmp/graphifyy-0.9.42-py3-none-any.whl" | sha256sum -c -
RUN python -m pip install --disable-pip-version-check --no-cache-dir --only-binary=:all: \
      --require-hashes --find-links=/tmp --target /opt/agenthost/graphify-python \
      -r /tmp/graphify-requirements.txt \
    && python -c "import importlib.metadata as m,sys; sys.path.insert(0,'/opt/agenthost/graphify-python'); assert m.version('graphifyy') == '0.9.42'" \
    && install -d -m 0555 /opt/agenthost/licenses/graphify \
    && cp /opt/agenthost/graphify-python/graphifyy-0.9.42.dist-info/licenses/LICENSE \
          /opt/agenthost/graphify-python/graphifyy-0.9.42.dist-info/licenses/LICENSE-MIT \
          /opt/agenthost/graphify-python/graphifyy-0.9.42.dist-info/licenses/NOTICE \
          /opt/agenthost/licenses/graphify/ \
    && chmod -R a-w /opt/agenthost/graphify-python /opt/agenthost/licenses/graphify \
    && rm -f /tmp/graphifyy-0.9.42-py3-none-any.whl

# AgentHost runtime: one agent, one box, always on.
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git tmux curl ca-certificates jq openssh-client python3 python3-pip procps iproute2 util-linux ripgrep zstd ffmpeg \
    bubblewrap sqlite3 chromium fonts-liberation \
    && rm -rf /var/lib/apt/lists/*
# bubblewrap: the V2 autonomy read-jail (buildSandboxWrapper). It was once a
# runtime install, which a redeploy silently erased and every autonomous run
# died with "bwrap: not found" (live incident 2026-07-18) -- it must be BAKED.
# ffmpeg: ~25 preloaded video/media skills (hyperframes, embedded-captions,
# music-to-video) are unreachable without it -- same defect class as bwrap.
# sqlite3: sanctioned read-only board queries for sandboxed agents (charter).
# chromium + fonts-liberation: N3 (visual QA agent) needs a real browser ON THE
# BOX -- the phone-ui tests run in GitHub Actions, not here, so nothing in the
# image could take a screenshot. Verified absent 2026-08-09: chromium,
# chromium-browser, google-chrome and chrome were all missing and there was no
# Playwright cache, which is exactly the prerequisite the N3 brief said to check
# before building. BAKED rather than installed at runtime for the same reason as
# bwrap above: a redeploy erases a runtime install and the failure arrives later,
# somewhere else. fonts-liberation is not optional -- without it a headless
# screenshot renders tofu boxes instead of text, which is worse than no
# screenshot because it looks like a real visual regression.
#
# HEADROOM, measured on the live box 2026-08-09, not estimated: 3916 MB total,
# 1768 MB available, /data 61% used with 3.7 GB free and 7.4 GB free on /. Disk
# is a non-issue. RAM is not: a headless Chromium is 500 MB-1 GB resident, which
# is 30-60% of remaining headroom while engines are running. So whatever drives
# this browser MUST take the existing agent lane (acquireAgent) rather than run
# alongside an engine, and must not introduce a second scheduler. Adding the
# binary is safe; running it unscheduled is the part that would OOM the box.
# Codex nests its own command sandbox inside AgentHost's filesystem jail. The
# outer Bubblewrap must not consume a user namespace, so use Bubblewrap's
# standard setuid mode for that outer mount/PID jail.
RUN chmod 4755 /usr/bin/bwrap

# Prove the browser is CALLABLE, not merely installed. `apt-get install chromium`
# succeeding says the package resolved; it does not say a binary exists on PATH and
# runs. A transitional/dummy package, a rename, or a PATH change would all install
# cleanly and leave N3 failing at runtime with the same 'no browser' symptom this
# commit exists to remove -- discovered on the box, days later, by whoever is on
# call. Failing the BUILD is the cheap end of that trade. (Kimi K3 raised this
# reviewing PR #277; same lesson as the container/ COPY gate.)
RUN chromium --version

# gh CLI (official apt repo; the demo path is "open a PR", gh is how agents do that)
RUN mkdir -p -m 755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Tailscale: BAKED IN, DORMANT BY DEFAULT (2026-07-26).
#
# The desktop bridge (gate.js `/bridge/*`, and the team charter's "hand work to
# a PC-side session") was designed around Tailscale + the Obsidian Local REST
# API, but Tailscale was never actually installed -- git history for container/
# has no trace of it. So every engine was told it had a live link to the
# operator's PC that did not exist, and work "handed to the PC side" went
# nowhere, silently. Baking it is the first half of making that true.
#
# It installs but does NOT connect by default. Arming is operator-opt-in
# (2026-07-27): entrypoint.sh starts tailscaled (userspace networking, state on
# /data/tailscale) ONLY when the /data/tailscale directory exists — created the
# first time the operator runs the one-time `tailscale up` bring-up in a root
# console. No dir -> fully dormant, exactly as before. The node identity lives
# on the persistent volume, so the box rejoins the tailnet on every boot after
# that single approval. There is still NO secret-based auto-connect handler.
#
# NOTE the bridge does NOT need this. `agenthost bridge` reaches the desktop over
# a public HTTPS URL (BRIDGE_URL, written to ~/BRIDGE.md by start.sh). Tailscale
# is for the future private-network path, not the bridge that ships today.
#
# Baked, never runtime-installed: bubblewrap taught us that lesson the hard way
# (a redeploy erased it and every autonomous run died with "bwrap: not found").
RUN mkdir -p -m 755 /etc/apt/keyrings \
    && curl -fsSL https://pkgs.tailscale.com/stable/debian/bookworm.noarmor.gpg -o /etc/apt/keyrings/tailscale-archive-keyring.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/tailscale-archive-keyring.gpg] https://pkgs.tailscale.com/stable/debian bookworm main" > /etc/apt/sources.list.d/tailscale.list \
    && apt-get update && apt-get install -y --no-install-recommends tailscale \
    && rm -rf /var/lib/apt/lists/*

# ttyd: the web terminal (pinned static binary, checksum-verified)
RUN curl -fsSL https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64 -o /usr/local/bin/ttyd \
    && echo "8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55  /usr/local/bin/ttyd" | sha256sum -c - \
    && chmod +x /usr/local/bin/ttyd

RUN npm install -g @anthropic-ai/claude-code

# Codex CLI (OpenAI) -- a second agent engine, reachable as a terminal app in
# the switcher. Baked in so it survives reboots; the user authenticates it
# interactively once (codex login) -- creds land on the volume under ~/.codex.
RUN npm install -g @openai/codex

# Gemini CLI (Google) -- chat-router engine (huge base, free tier). Headless like
# Codex: `gemini -p <msg> --output-format json` = one turn. Auth via GEMINI_API_KEY
# from the box secret store; never baked. Version-pinned.
RUN npm install -g @google/gemini-cli@0.51.0
RUN npm install -g @moonshot-ai/kimi-code

# Cursor Agent (Anysphere) -- chat-tier CLI. Install the exact official Linux
# package system-wide: Cursor's moving installer writes into root's ~/.local
# during this image stage, which the runtime `agent` user cannot reach. The
# archive version and SHA-256 were verified 2026-07-29; `--version` makes the
# image build prove that the extracted executable actually starts.
RUN curl -fsSL -o /tmp/cursor-agent.tar.gz https://downloads.cursor.com/lab/2026.07.23-e383d2b/linux/x64/agent-cli-package.tar.gz \
    && echo "702ad595213bee5df0268be9f80a19f29fcceaa2a42fc55e39f2b5199051f0c4  /tmp/cursor-agent.tar.gz" | sha256sum -c - \
    && install -d -m 0755 /usr/local/lib/cursor-agent/2026.07.23-e383d2b \
    && tar -xzf /tmp/cursor-agent.tar.gz --strip-components=1 -C /usr/local/lib/cursor-agent/2026.07.23-e383d2b \
    && ln -s /usr/local/lib/cursor-agent/2026.07.23-e383d2b/cursor-agent /usr/local/bin/cursor-agent \
    && rm /tmp/cursor-agent.tar.gz \
    && /usr/local/bin/cursor-agent --disable-auto-update --version

# OpenClaw -- self-hosted multi-channel messaging gateway (Telegram/Discord/
# WhatsApp -> AI agent). Own daemon on localhost:18789, isolated from Hermes.
# Node 22.23.x satisfies its range. Version-pinned.
RUN npm install -g openclaw@2026.7.1-2

# Ollama: the local endpoint (127.0.0.1:11434, never exposed by the gate) that
# proxies Ollama CLOUD models -- Hermes and other agents on the box get an
# OpenAI-compatible LLM (glm-5.2:cloud) without a local GPU, billed to the
# user's own Ollama account. No model runs on this CPU box, so the GPU backends
# in the 3.6GB release bundle are dead weight: the GPU dirs are dropped in the
# same layer (~42MB kept: bin/ollama + libggml-base + the libggml-cpu-*
# variants, which the daemon still links even in cloud-proxy mode). Pinned +
# checksum-verified like ttyd above.
RUN curl -fsSL -o /tmp/ollama.tar.zst https://github.com/ollama/ollama/releases/download/v0.32.1/ollama-linux-amd64.tar.zst \
    && echo "83b1f22841eb7f6c4900c6797f960ebaa09466874442ea5b8ae3da6980d3914c  /tmp/ollama.tar.zst" | sha256sum -c - \
    && tar --zstd -xf /tmp/ollama.tar.zst -C /usr/local \
    && rm -rf /tmp/ollama.tar.zst /usr/local/lib/ollama/cuda_* /usr/local/lib/ollama/vulkan /usr/local/lib/ollama/rocm* /usr/local/lib/ollama/mlx* \
    && /usr/local/bin/ollama --version

# Migrated harnesses reference `python`; Debian only ships `python3`.
RUN ln -s /usr/bin/python3 /usr/local/bin/python

# The gate's board reader/writer must not execute the agent-owned uv launcher.
# Pin the same Hermes CLI version currently used by the interactive stack, but
# install this copy root-side so an agent cannot replace the program the gate
# invokes while it holds the push credential.
RUN python3 -m pip install --no-cache-dir --break-system-packages hermes-agent==0.19.0 \
    && test "$(command -v hermes)" = "/usr/local/bin/hermes" \
    && mv /usr/local/bin/hermes /usr/local/bin/hermes-agent \
    && chown root:root /usr/local/bin/hermes-agent \
    && chmod 0555 /usr/local/bin/hermes-agent
COPY hermes-gate-wrapper.sh /usr/local/bin/hermes
RUN chown root:root /usr/local/bin/hermes && chmod 0555 /usr/local/bin/hermes

# The passwd home MUST match where the agent's files actually live. entrypoint.sh
# builds the real home on the /data volume at /data/home/agent; useradd -m would
# leave passwd pointing at an empty /home/agent. Any tool that resolves its config
# directory by asking the system for the user's home -- rather than reading $HOME --
# then looks in the wrong place. On 2026-08-01 that took out codex, claude's Bash
# tool, cursor and hermes for a full day, surfacing only as "(skipped -- run exited
# 1)". Setting $HOME correctly is not enough on its own; the user database has to
# agree with it. /home/agent is left in place as a harmless empty directory.
RUN useradd -m -s /bin/bash agent \
    && usermod -d /data/home/agent agent \
    && install -d -o root -g root -m 0755 /opt/agenthost \
    && install -o root -g root -m 0444 /dev/null /opt/agenthost/workspace-provision.lock

# Foundation B identities (INERT while AGENTHOST_FOUNDATION_B is unset — nothing
# runs as these users until activation):
#   gate  — the ONLY peer the root authority socket accepts (maintenance-native.c
#           verifies SO_PEERCRED uid/gid == getpwnam/getgrnam("gate")). At
#           activation PID 1 spawns gate.js directly as gate, split from the
#           agent-uid interactive stack, so uncontained harness-run code cannot
#           share the gate's uid. Jailed unattended engines retain the numeric
#           uid but have private PID/filesystem boundaries.
#   maintworker (uid/gid 10001) — the reserved jail identity governed workers are
#           dropped to (§8 profiles / AGENTHOST_WORKER_UID default). No login, no
#           home; the worker's only writable path is its task-scoped worktree.
RUN groupadd --system gate \
    && useradd --system --gid gate --no-create-home --shell /usr/sbin/nologin gate \
    && groupadd --gid 10001 maintworker \
    && useradd --uid 10001 --gid maintworker --no-create-home --shell /usr/sbin/nologin maintworker \
    && groupadd --system boxstate \
    && usermod -aG boxstate agent \
    && usermod -aG boxstate gate
# boxstate — the SHARED group (D1 fix). Both `agent` (interactive stack) and `gate`
# (the backend under Foundation B) belong to it, so gate.js can reach the box state
# it owns on the /data volume without transferring ownership away from agent (which
# would break the interactive stack instead). The boot-entry migration applies this
# group + g+rw + setgid to gate's state trees before gate.js starts.

COPY entrypoint.sh /opt/agenthost/entrypoint.sh
COPY memory-failsafe.sh /opt/agenthost/memory-failsafe.sh
COPY start.sh /opt/agenthost/start.sh
COPY secret-env.sh /opt/agenthost/secret-env.sh
COPY cursor-terminal.sh /opt/agenthost/cursor-terminal.sh
COPY tmux-seam.sh /opt/agenthost/tmux-seam.sh
COPY gate.js /opt/agenthost/gate.js
COPY openai-compatible-chat.js /opt/agenthost/openai-compatible-chat.js
COPY deepseek-budget.js /opt/agenthost/deepseek-budget.js
COPY deepseek-budget-state.js /opt/agenthost/deepseek-budget-state.js
COPY dsh-inference-relay.js /opt/agenthost/dsh-inference-relay.js
COPY dsh-headless-runner.js /opt/agenthost/dsh-headless-runner.js
COPY dsh-secure.patch.yml /opt/agenthost/dsh-secure.patch.yml
COPY --from=deepseek-harness-build --chown=root:root /src/ /opt/deepseek-harness/
COPY --from=graphify-python /opt/agenthost/graphify-python /opt/agenthost/graphify-python
COPY --from=graphify-python /opt/agenthost/licenses/graphify /opt/agenthost/licenses/graphify
COPY graphify-lib.js /opt/agenthost/graphify-lib.js
COPY graphify-secrets.js /opt/agenthost/graphify-secrets.js
COPY graphify-html.js /opt/agenthost/graphify-html.js
COPY graphify-store.js /opt/agenthost/graphify-store.js
COPY graphify-corpora.js /opt/agenthost/graphify-corpora.js
COPY graphify-brand.js /opt/agenthost/graphify-brand.js
COPY graphify-brand-corpus.js /opt/agenthost/graphify-brand-corpus.js
COPY graphify-brain.js /opt/agenthost/graphify-brain.js
COPY graphify-folder-extract.py /opt/agenthost/graphify-folder-extract.py
RUN install -o root -g root -m 0444 /dev/null /opt/agenthost/dsh-empty.env \
    && chown root:root /opt/agenthost/dsh-inference-relay.js /opt/agenthost/dsh-headless-runner.js /opt/agenthost/dsh-secure.patch.yml \
    && chmod 0444 /opt/agenthost/dsh-inference-relay.js /opt/agenthost/dsh-headless-runner.js /opt/agenthost/dsh-secure.patch.yml \
        /opt/agenthost/graphify-lib.js /opt/agenthost/graphify-secrets.js /opt/agenthost/graphify-html.js /opt/agenthost/graphify-store.js \
        /opt/agenthost/graphify-corpora.js /opt/agenthost/graphify-brand.js /opt/agenthost/graphify-brand-corpus.js \
        /opt/agenthost/graphify-brain.js /opt/agenthost/graphify-folder-extract.py \
    && python3 -I -c "import sys,importlib.metadata as m; sys.path.insert(0,'/opt/agenthost/graphify-python'); assert m.version('graphifyy') == '0.9.42'; import graphify"
COPY review-attestation.js /opt/agenthost/review-attestation.js
# The box's own operating skill, refreshed into ~/.claude/skills on every boot by
# start.sh (§1d-2). Without this COPY the preload silently no-ops.
COPY skills-preload/ /opt/agenthost/skills-preload/

# Operator context seed (brand voice, imported desktop memory, homunculus
# instincts), refreshed into ~/.claude on every boot by start.sh (§1d-3).
COPY home-seed/ /opt/agenthost/home-seed/
COPY zip-store.js /opt/agenthost/zip-store.js
COPY --from=codex-auth-once-build /build/codex-auth-once /usr/local/bin/codex-auth-once
COPY --from=maintenance-native-build --chown=root:root /build/entrypoint-launcher /opt/agenthost/entrypoint-launcher
COPY --from=maintenance-native-build --chown=root:root /build/maintenance-native.node /opt/agenthost/maintenance-native.node
COPY --chown=root:root git-credential-agenthost /usr/local/bin/agenthost-git-credential
COPY --chown=root:root git-fd3-crossuid.test.js /opt/agenthost/git-fd3-crossuid.test.js
COPY push-lib.js /opt/agenthost/push-lib.js
COPY sw.js /opt/agenthost/sw.js
COPY totp.js /opt/agenthost/totp.js
COPY cron-lib.js /opt/agenthost/cron-lib.js
COPY chains-lib.js /opt/agenthost/chains-lib.js
COPY chat-governance.js /opt/agenthost/chat-governance.js
COPY channel-dispatch.js /opt/agenthost/channel-dispatch.js
COPY channel-delivery-limiter.js /opt/agenthost/channel-delivery-limiter.js
# The OpenClaw channel broker ships as a plugin DIRECTORY (openclaw.plugin.json manifest +
# package.json + index.js + sibling adapter). OpenClaw's loader requires a manifest dir --
# a bare .js in plugins.load.paths is silently ignored. claw-setup points load.paths here.
COPY openclaw-channel-broker/ /opt/agenthost/openclaw-channel-broker/
COPY openclaw-plugin-config.js /opt/agenthost/openclaw-plugin-config.js
COPY claim-store.js /opt/agenthost/claim-store.js
COPY --chown=root:root maintenance-protocol.js /opt/agenthost/maintenance-protocol.js
COPY --chown=root:root maintenance-store.js /opt/agenthost/maintenance-store.js
COPY --chown=root:root maintenance-service.js /opt/agenthost/maintenance-service.js
# Foundation B activation closure (DORMANT until AGENTHOST_FOUNDATION_B=1): the
# exact transitive require set of maintenance-boot-entry.js (root PID-1 authority)
# + maintenance-gate-authority.js (the gate-side delegate). Root-owned like the
# other maintenance modules; /opt/agenthost is already root:root 0755, so shipping
# these changes nothing while the flag is off. Regenerate this list with
# `node scripts/maintenance-require-closure.mjs` whenever a module is added/removed.
COPY --chown=root:root maintenance-agent-lane.js /opt/agenthost/maintenance-agent-lane.js
COPY --chown=root:root maintenance-audit-store.js /opt/agenthost/maintenance-audit-store.js
COPY --chown=root:root maintenance-auth-state.js /opt/agenthost/maintenance-auth-state.js
COPY --chown=root:root maintenance-authority-client.js /opt/agenthost/maintenance-authority-client.js
COPY --chown=root:root maintenance-authority-transport.js /opt/agenthost/maintenance-authority-transport.js
COPY --chown=root:root maintenance-autonomous-lane.js /opt/agenthost/maintenance-autonomous-lane.js
COPY --chown=root:root maintenance-boot-entry.js /opt/agenthost/maintenance-boot-entry.js
COPY --chown=root:root maintenance-boot-main.js /opt/agenthost/maintenance-boot-main.js
COPY --chown=root:root maintenance-boot-reconciler.js /opt/agenthost/maintenance-boot-reconciler.js
COPY --chown=root:root maintenance-boot.js /opt/agenthost/maintenance-boot.js
COPY --chown=root:root maintenance-budget-store.js /opt/agenthost/maintenance-budget-store.js
COPY --chown=root:root maintenance-child-observe.js /opt/agenthost/maintenance-child-observe.js
COPY --chown=root:root maintenance-claims-store.js /opt/agenthost/maintenance-claims-store.js
COPY --chown=root:root maintenance-containment.js /opt/agenthost/maintenance-containment.js
COPY --chown=root:root maintenance-contract.js /opt/agenthost/maintenance-contract.js
COPY --chown=root:root maintenance-foundation-service.js /opt/agenthost/maintenance-foundation-service.js
COPY --chown=root:root maintenance-gate-authority.js /opt/agenthost/maintenance-gate-authority.js
COPY --chown=root:root maintenance-journal-adapter.js /opt/agenthost/maintenance-journal-adapter.js
COPY --chown=root:root maintenance-method-dispatch.js /opt/agenthost/maintenance-method-dispatch.js
COPY --chown=root:root maintenance-operator-authority.js /opt/agenthost/maintenance-operator-authority.js
COPY --chown=root:root maintenance-operator-effects.js /opt/agenthost/maintenance-operator-effects.js
COPY --chown=root:root maintenance-operator-gateway.js /opt/agenthost/maintenance-operator-gateway.js
COPY --chown=root:root maintenance-operator-handlers.js /opt/agenthost/maintenance-operator-handlers.js
COPY --chown=root:root maintenance-output-spool.js /opt/agenthost/maintenance-output-spool.js
COPY --chown=root:root maintenance-profile-catalog.js /opt/agenthost/maintenance-profile-catalog.js
COPY --chown=root:root maintenance-profiles.js /opt/agenthost/maintenance-profiles.js
COPY --chown=root:root maintenance-recovery-driver.js /opt/agenthost/maintenance-recovery-driver.js
COPY --chown=root:root maintenance-recovery-request.js /opt/agenthost/maintenance-recovery-request.js
COPY --chown=root:root maintenance-recovery-store.js /opt/agenthost/maintenance-recovery-store.js
COPY --chown=root:root maintenance-repo-id.js /opt/agenthost/maintenance-repo-id.js
COPY --chown=root:root maintenance-gate-state-migration.js /opt/agenthost/maintenance-gate-state-migration.js
COPY --chown=root:root maintenance-run-events.js /opt/agenthost/maintenance-run-events.js
COPY --chown=root:root maintenance-runs-store.js /opt/agenthost/maintenance-runs-store.js
COPY --chown=root:root maintenance-stop-store.js /opt/agenthost/maintenance-stop-store.js
COPY --chown=root:root maintenance-supervisor.js /opt/agenthost/maintenance-supervisor.js
COPY --chown=root:root maintenance-trusted-stores.js /opt/agenthost/maintenance-trusted-stores.js
COPY --chown=root:root maintenance-work-launch.js /opt/agenthost/maintenance-work-launch.js
COPY --chown=root:root maintenance-work-service.js /opt/agenthost/maintenance-work-service.js
COPY --chown=root:root maintenance-worker-registry.js /opt/agenthost/maintenance-worker-registry.js
COPY --chown=root:root maintenance-worker-runtime.js /opt/agenthost/maintenance-worker-runtime.js
# Foundation B chat-runner: gate dispatches chat engines that run AS AGENT via the
# root chat-runner socket. profiles/runner/server are root-side (the security core);
# client is required by gate.js. Root-owned like the other maintenance modules.
COPY --chown=root:root maintenance-chat-profiles.js /opt/agenthost/maintenance-chat-profiles.js
COPY --chown=root:root maintenance-chat-runner.js /opt/agenthost/maintenance-chat-runner.js
COPY --chown=root:root maintenance-chat-server.js /opt/agenthost/maintenance-chat-server.js
COPY --chown=root:root maintenance-chat-client.js /opt/agenthost/maintenance-chat-client.js
COPY stuck-lib.js /opt/agenthost/stuck-lib.js
COPY engine-adapters.js /opt/agenthost/engine-adapters.js
COPY gemini-adapter.js /opt/agenthost/gemini-adapter.js
COPY engine-sessions.js /opt/agenthost/engine-sessions.js
COPY mesh-contract.js /opt/agenthost/mesh-contract.js
COPY mesh-store.js /opt/agenthost/mesh-store.js
COPY mesh-state.js /opt/agenthost/mesh-state.js
COPY settings-lib.js /opt/agenthost/settings-lib.js
COPY mode-lib.js /opt/agenthost/mode-lib.js
COPY growth-lib.js /opt/agenthost/growth-lib.js
COPY brand-dna-source.js /opt/agenthost/brand-dna-source.js
COPY inventory-lib.js /opt/agenthost/inventory-lib.js
# The Measurement Pack. gate.js requires measurement-lib.js at TOP LEVEL, so a
# missing COPY here does not degrade measurement -- it throws on require and the
# whole gate fails to boot. Same lesson as run-qa.sh and board-actions.js above,
# which is why these lines are commented rather than left to be inferred.
COPY measurement-store.js /opt/agenthost/measurement-store.js
COPY measurement-credentials.js /opt/agenthost/measurement-credentials.js
COPY measurement-sync.js /opt/agenthost/measurement-sync.js
COPY measurement-lib.js /opt/agenthost/measurement-lib.js
COPY measurement-adapters/ /opt/agenthost/measurement-adapters/
COPY mode-validate.js /opt/agenthost/mode-validate.js
COPY run-ledger.js /opt/agenthost/run-ledger.js
COPY providers-lib.js /opt/agenthost/providers-lib.js
COPY mail-lib.js /opt/agenthost/mail-lib.js
COPY mail-emails.js /opt/agenthost/mail-emails.js
COPY activity-lib.js /opt/agenthost/activity-lib.js
COPY board-events-lib.js /opt/agenthost/board-events-lib.js
COPY canonical-board.js /opt/agenthost/canonical-board.js
COPY kanban-bridge.js /opt/agenthost/kanban-bridge.js
COPY team-charter.md /opt/agenthost/team-charter.md
COPY CODEX-ENGINEERING-CHARTER.md /opt/agenthost/CODEX-ENGINEERING-CHARTER.md
# Governance docs the charter points agents at. Ship them to the box (docs/ is
# NOT in the deploy payload — only container/ is), so a box agent that follows
# the charter's references can actually read them at /opt/agenthost/*.md.
COPY OPERATOR-CARDINAL-RULES.md /opt/agenthost/OPERATOR-CARDINAL-RULES.md
COPY TEAM-PROCESS.md /opt/agenthost/TEAM-PROCESS.md
COPY RULE-CONSTITUTION.md /opt/agenthost/RULE-CONSTITUTION.md
COPY TRANSCENDENCE.md /opt/agenthost/TRANSCENDENCE.md
COPY OPERATING-PRINCIPLES.md /opt/agenthost/OPERATING-PRINCIPLES.md
# N4 board actions. Without this COPY the module is absent from the image and the
# /board/task/:id/action route dies with MODULE_NOT_FOUND -- the container/-file-
# not-in-the-image trap this repo has hit before.
COPY board-actions.js /opt/agenthost/board-actions.js
# Creative approvals live in digest-bound gate-owned sidecars. The gate needs
# this helper to fingerprint artifacts and atomically publish that state.
COPY artifact-review.js /opt/agenthost/artifact-review.js
# Visual QA agent (N3). The outer launcher pins the shared screenshot root and
# builds the fail-closed Bubblewrap jail; qa-runner.sh, qa-agent.js and the route
# config are copied into a private staging directory before that jail starts.
COPY qa-agent.js /opt/agenthost/qa-agent.js
COPY qa-routes.json /opt/agenthost/qa-routes.json
COPY qa-runner.sh /opt/agenthost/qa-runner.sh
COPY qa-sandbox.js /opt/agenthost/qa-sandbox.js
COPY qa-sandbox-linux.test.js /opt/agenthost/qa-sandbox-linux.test.js
COPY qa-control-linux.test.js /opt/agenthost/qa-control-linux.test.js
COPY run-qa.sh /opt/agenthost/run-qa.sh
COPY qa-control.sh /usr/local/bin/agenthost-qa
# The one-surface workspace shell (Next.js static export). Built LOCALLY by
# scripts/build-dashboard.mjs from dashboard/ and committed into the container
# context, because the deploy pipe tars container/ alone (redeploy-box.ps1) and
# deliberately stays free of an in-image Node build. gate.js serves these exact
# bytes at every human-facing page entry; APIs keep their existing subpaths.
COPY dashboard-ui/ /opt/agenthost/dashboard-ui/
COPY brain-lib.js /opt/agenthost/brain-lib.js
COPY memory-capture.js /opt/agenthost/memory-capture.js
COPY theme.css /opt/agenthost/theme.css
COPY starter-stack.json /opt/agenthost/starter-stack.json
COPY skills.sh /usr/local/bin/skills
COPY claw-setup.sh /usr/local/bin/claw-setup
COPY icons/ /opt/agenthost/icons/
# Normalize modes AFTER every COPY: the deploy pipeline tars container/ on
# Windows (redeploy-box.ps1, Windows tar.exe has no Unix modes), so COPY'd files
# land world-writable (666). OpenClaw refuses to load a plugin from a
# world-writable path (hit live 2026-07-25: agenthost-channel-broker blocked,
# killing channel dispatch), and any other path-mode guard trips the same way.
# go-w fixes the class, never touches +x bits; the specific chmods below then
# re-assert the executables.
RUN chmod -R go-w /opt/agenthost /usr/local/bin/skills /usr/local/bin/claw-setup \
    && chmod +x /opt/agenthost/entrypoint.sh /opt/agenthost/memory-failsafe.sh /opt/agenthost/start.sh /opt/agenthost/cursor-terminal.sh /usr/local/bin/skills /usr/local/bin/claw-setup \
    && chmod 0555 /opt/agenthost/entrypoint-launcher /usr/local/bin/agenthost-git-credential /usr/local/bin/agenthost-qa /opt/agenthost/maintenance-native.node \
    && test "$(stat -c '%u:%g:%a' /opt/agenthost/entrypoint-launcher)" = "0:0:555" \
    && test "$(stat -c '%u:%g:%a' /usr/local/bin/hermes)" = "0:0:555" \
    && test "$(stat -c '%u:%g:%a' /usr/local/bin/hermes-agent)" = "0:0:555" \
    && setpriv --reuid=agent --regid=agent --clear-groups --no-new-privs /bin/sh -c 'test ! -w /usr/local/bin/hermes && test ! -w /usr/local/bin/hermes-agent' \
    && timeout 20s node --test /opt/agenthost/git-fd3-crossuid.test.js \
    && timeout 20s node --test /opt/agenthost/qa-control-linux.test.js

EXPOSE 8080
ENTRYPOINT ["/opt/agenthost/entrypoint-launcher"]
