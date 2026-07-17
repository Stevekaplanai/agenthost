# AgentHost

One command moves your local AI agent setup (Claude Code first, Hermes beta) to a 24/7 box in **your own** Fly.io account. Skills, memories, CLAUDE.md, MCP servers, plugins, and your repos come with it. Your phone gets the whole agent — not just a terminal.

## Quick start

```
npm install -g agenthost-cli       # or: npx agenthost-cli <command>
agenthost deploy --org <your-fly-org>
```

`deploy` detects your local `~/.claude` harness, packs and redacts it, creates (or reuses) the Fly app + volume, stages your secrets, and deploys. It prints a URL and a one-time login link when it's done. Add `--dry-run` to see exactly what it would do without touching Fly.

Open the link on your phone and add it to your home screen: it installs as a full-screen app.

## What the box does

- **Terminal, from anywhere.** Your real tmux session over HTTPS, with a touch key bar (ctrl/esc/tab/arrows) that doesn't fight the phone keyboard, pinch-free text sizing, and a 🔗 button that rebuilds wrapped OAuth/login URLs so you can open or copy them in one tap.
- **Chat, not terminal cosplay.** A message thread that runs `claude` on the box. Talk to it with the 🎤 (voice input) where the browser supports it.
- **`/brain <query>`.** Greps your skills, memories, and notes on the box, then the agent summarizes the hits with file citations. Bring an Obsidian vault or any folder with `--include <path>`.
- **Scheduled agents.** The `/cron` page schedules `claude -p` prompts (one-tap "morning briefing at 7am" template). Runs happen while you sleep; history is kept per job.
- **Push notifications.** Enable the 🔔 and your phone buzzes when a scheduled run or a chat finishes — sent by your box directly (VAPID web push), no vendor backend.
- **Optional 2FA + audit log.** Turn on TOTP at `/2fa` (any authenticator app); every login, chat, and cron run lands in `/audit`.
- **The Bridge (new in 0.4.0).** `agenthost bridge <port>` connects your box back to your desktop: it publishes a local service (an Obsidian vault's REST API, a dev server, anything HTTP) at a stable public URL via Tailscale Funnel, and hands that URL + your access token to the box as encrypted secrets. The agent on the box finds `~/BRIDGE.md` on its next boot and can call home — read your vault, hit your local tools, hand work back to your desktop Claude. Two agents, one brain, both directions.
- **Every engine in one chat thread (new in 0.5.0).** The chat isn't just `claude` anymore — a segmented control picks who answers each turn: **Claude** (`claude -p`), **Hermes** (GLM-5.2 via the box's Ollama), or **Codex** (OpenAI's CLI). Every reply is tagged in-thread with who answered and what the turn cost. `@mention` another engine to route one turn to it, or tap a handoff chip when one engine suggests another — you approve every handoff. `/brain` answers on whichever engine is selected, from the same shared notes.
- **Command Center (new in 0.5.0).** The top nav is three tabs — **Command Center · Chat · Loops** — and Command Center is where the engines live: a switcher with a live status panel per engine (Hermes's dashboard state, Codex's session, Ollama's loaded models, the raw terminal's tmux windows), plus a cross-engine activity feed of everything happening across the box, newest first. Tap a feed row to jump to that engine. The raw terminal is still one tap away — it just moved from a top-level tab into Command Center.
- **Ollama for cloud models — or local ones (new in 0.5.0).** Ollama ships in the image (CPU build, ~100MB — the GPU payload is stripped) and serves on the box at `127.0.0.1:11434`, never exposed to the internet. It's an OpenAI-compatible endpoint that proxies Ollama's **cloud** models (GLM, Qwen, and friends) — so agents on the box get a capable LLM without a local GPU, billed to your own Ollama account. On a Hermes box this is Hermes's brain: it's pre-wired to `glm-5.2:cloud` (~1M context). Bring your Ollama API key (`--hermes-secrets-from-local` carries it up). Prefer a model that runs **on the box itself** — free, private, no account? Set one secret and reboot: `flyctl secrets set OLLAMA_LOCAL_MODEL=llama3.2:1b -a <your-app>` — the box pulls it onto the volume (with free-space guards) and serves it from its own CPU. A 2GB machine handles ~1b-class quantized models for light work; scale the machine for bigger ones. Models survive reboots; both modes share the same endpoint.

## The Bridge: your box ↔ your desktop

Your box already has a public, login-gated URL — anything on your desktop can reach it (the chat endpoint included). The bridge completes the other direction:

```
agenthost bridge 27123 --token <your service's API key>
```

That takes a service listening on your desktop (port 27123 is where an Obsidian Local REST API vault lives, to pick a non-random example) and gives your box a stable HTTPS URL for it. What that unlocks is up to you:

- The box agent reads and writes the same Obsidian vault your desktop Claude uses — a genuinely shared brain, not two diverging copies.
- Cloud runs that end by writing results somewhere your desktop automation picks up; desktop sessions that queue work the box executes overnight.
- Loops: a scheduled box run reads the vault, works, writes back; your desktop agent reacts on its next session. Hand work back and forth without you in the middle.

Honest prerequisites and properties:

- **Tailscale** (free for personal use) runs the tunnel on your desktop — install it, log in once; first bridge on a tailnet asks you to click one approval link. No Tailscale on the box side, and no AgentHost server anywhere in the path.
- The public URL is reachable by anyone who knows it, so **the local service's own auth is the lock**. The CLI refuses to bridge without `--token` unless you explicitly pass `--no-token` to say your service brings its own. The token travels laptop → your Fly encrypted store, never on a command line, never through us.
- Your desktop has to be on for the bridge to answer. The URL survives reboots.
- `agenthost bridge --off` closes the tunnel and clears the box's bridge secrets. `agenthost bridge --status` shows both ends.

## Commands

```
agenthost deploy              # detect, pack, redact, deploy to YOUR Fly account
agenthost sync                # re-pack + push local harness changes (skills, CLAUDE.md, memory, plugins)
agenthost status              # is the box up?
agenthost open                # print the login link
agenthost logs                # tail the box's logs
agenthost doctor              # read-only health checklist (harness, auth, gate, disk)
agenthost snapshot            # back up the data volume (your whole brain)
agenthost restore --list      # list snapshots; --snapshot <id> restores into a NEW volume
agenthost bridge <port>       # publish a desktop service to your box (see: The Bridge)
agenthost destroy             # tear the app, volume, and secrets down
```

Useful flags (full reference: `agenthost --help`):

- `--include <path>` (repeatable) — bring extra home-relative folders (an Obsidian vault, scripts your hooks call).
- `--migrate-auth` — opt-in: carry your local `~/.claude/.credentials.json` (MCP OAuth tokens + agent auth) to the box via your Fly account's encrypted secret store. Off by default; some host-bound tokens may still need one re-auth on the box (the 🔗 button makes that painless).
- `--agent hermes` — beta: migrate a Hermes home alongside Claude Code (`--hermes-secrets-from-local` stages its `.env` as encrypted secrets).

Auth for the cloud agent: `--oauth-token <claude setup-token output>` (subscription-billed, the default) or `--anthropic-key <key>` (metered fallback). Neither is required to deploy; the box just boots a shell until you set one.

## What's new

**0.5.0 — the gateway.** The box became a multi-engine gateway: Claude, Hermes (GLM-5.2 via the box's Ollama), and Codex now answer in one chat thread, each turn tagged in-thread with who answered and its cost, with `@mention` routing and tap-to-approve handoffs. A new **Command Center** screen (the top nav is now Command Center · Chat · Loops) gives each engine a live status panel and shows a cross-engine activity feed; the raw terminal, Hermes's dashboard (`/hermes`), Codex, and Ollama all live inside it. Ollama ships in the image (CPU-only build, GPU payload stripped, localhost only) as an OpenAI-compatible endpoint for its cloud models, pre-wired as Hermes's LLM (`glm-5.2:cloud`, ~1M context) via your own Ollama account — or set `OLLAMA_LOCAL_MODEL` to run a model on the box itself.

**0.4.0 — the Bridge.** `agenthost bridge` connects your box to your desktop (see above). Built the way everything here is built: no AgentHost server sees your traffic or your token, teardown is one command, and the box agent discovers the bridge by itself.

**0.3.3** closed out launch week: the packer now strips hooks whose binaries don't exist on the box (no more phantom `command not found` at session start) and hardened its credential-pattern redaction; the harness tarball is deleted from the volume after extraction instead of being stored twice; chat history interleaves correctly on reload and no longer shows an empty "typing" bubble while your message is still queued behind another run; plus the phone keyboard/viewport fixes.

## Security model

There is no AgentHost backend. The CLI drives `flyctl`; secrets go from your machine into Fly's encrypted secret store; credential files are never packed into the migration tarball. The one exception is explicit and opt-in: `--migrate-auth` sends your credentials file laptop → your Fly vault directly (over HTTPS, values never on the command line, never through any AgentHost server — none exists). The cloud agent authenticates with a value you hand over explicitly: your `claude setup-token` output (`CLAUDE_CODE_OAUTH_TOKEN`, subscription-billed — the default) or your own `ANTHROPIC_API_KEY`.

The terminal is behind a per-box login (hardened cookie, optional TOTP 2FA), and `/audit` shows every login and run. `agenthost destroy` removes the app, volume, and secrets.

## Layout

- `bin/cli.js` + `src/` — the `agenthost` CLI (deploy/sync/status/open/logs/doctor/snapshot/restore/destroy); `npm test` runs the fast, dependency-free unit tests
- `container/` — the runtime image: Claude Code in tmux served by ttyd, a zero-dependency gate (`gate.js`) that does cookie/2FA auth, the chat + cron + brain endpoints, web push (RFC 8291/8292 in plain Node crypto), and the phone app shell
- `scripts/pack.mjs` (+ `scripts/pack-lib.mjs` for its pure logic) — the migration packer: include/exclude/redact/path-translate for `~/.claude` (and `~/.hermes`), emits `harness.tar.gz` + a cloud-compatibility report (localhost MCP servers get disabled and listed, hooks that reference unmigrated paths get flagged with the exact `--include` to fix them)
