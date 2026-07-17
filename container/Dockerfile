# AgentHost runtime: one agent, one box, always on.
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git tmux curl ca-certificates jq openssh-client python3 python3-pip procps util-linux ripgrep zstd \
    && rm -rf /var/lib/apt/lists/*

# gh CLI (official apt repo; the demo path is "open a PR", gh is how agents do that)
RUN mkdir -p -m 755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
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

RUN useradd -m -s /bin/bash agent

COPY entrypoint.sh /opt/agenthost/entrypoint.sh
COPY start.sh /opt/agenthost/start.sh
COPY gate.js /opt/agenthost/gate.js
COPY push-lib.js /opt/agenthost/push-lib.js
COPY sw.js /opt/agenthost/sw.js
COPY totp.js /opt/agenthost/totp.js
COPY cron-lib.js /opt/agenthost/cron-lib.js
COPY cron.html /opt/agenthost/cron.html
COPY appshell.js /opt/agenthost/appshell.js
COPY chat.html /opt/agenthost/chat.html
COPY cc.html /opt/agenthost/cc.html
COPY theme.css /opt/agenthost/theme.css
COPY icons/ /opt/agenthost/icons/
RUN chmod +x /opt/agenthost/entrypoint.sh /opt/agenthost/start.sh

EXPOSE 8080
ENTRYPOINT ["/opt/agenthost/entrypoint.sh"]
