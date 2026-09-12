# AgentHost

> **Release status, August 26, 2026:** `agenthost-cli@0.7.0` is in a seven-day production soak. `1.0.0` is targeted for Monday, August 31, only if the soak completes green. No container changes will land during the soak.

**0.7.0 — the organization era.** The box stops being a toolbox and becomes an organization of frontier and open-weight models that works in modes: **Dev** builds software, **Growth** runs marketing for real — Brand DNA, campaigns, creative, and a measurement pack that records what actually moved — with **Ops** mode arriving next. Six engines from six different companies share one board, so the engine reviewing code is never the mind that wrote it — and the autonomy loop is proven end to end: one engine builds, a different company's engine reviews, the work merges, with the human holding the boundary, not the mouse. Governance is patent-pending (US provisionals 64/122,926 and 64/134,658). Windows, Mac, and Linux all run the same one command.

> **Versioning note.** AgentHost 2.0 is the product generation (GitHub release v2.0.0, “The Team Room”). The CLI package on npm is version 0.7.0 (`npm install -g agenthost-cli`). One is the product line, the other is the installer — both are current.

One command moves your local AI agent setup (Claude Code first, Hermes beta) to a 24/7 box in **your own** Fly.io account. Skills, memories, CLAUDE.md, MCP servers, plugins, and your repos come with it. Your phone gets the whole agent — not just a terminal.

## Quick start

**Before you deploy** you need three things (`deploy` shells out to `flyctl` and won't work without them):

- **Node >=18**
- **flyctl installed** — [fly.io/docs/flyctl/install](https://fly.io/docs/flyctl/install/). On Mac: `brew install flyctl`. On Mac/Linux without Homebrew: `curl -L https://fly.io/install.sh | sh`.
- **`flyctl auth login`** done (authenticates you to your Fly.io account).

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
- **Scheduled agents.** Workspace → Systems → Loops schedules recurring agent prompts. Runs happen while you sleep; history is kept per job.
- **Push notifications.** Enable the 🔔 and your phone buzzes when a scheduled run or a chat finishes — sent by your box directly (VAPID web push), no vendor backend.
- **Optional 2FA + audit log.** Turn on TOTP in Workspace → Settings → Security; every login and agent run lands in Systems → Activity. `/2fa` and `/audit` are native deep links into those same rooms, not separate applications.
- **The Bridge (new in 0.4.0).** `agenthost bridge <port>` connects your box back to your desktop: it publishes a local service (an Obsidian vault's REST API, a dev server, anything HTTP) at a stable public URL via Tailscale Funnel, and hands that URL + your access token to the box as encrypted secrets. The agent on the box finds `~/BRIDGE.md` on its next boot and can call home — read your vault, hit your local tools, hand work back to your desktop Claude. Two agents, one brain, both directions.
- **Every engine in one chat thread (new in 0.5.0).** The chat isn't just `claude` anymore — a segmented control picks who answers each turn: **Claude** (`claude -p`), **Hermes** (GLM-5.2 via the box's Ollama), or **Codex** (OpenAI's CLI). Every reply is tagged in-thread with who answered and what the turn cost. `@mention` another engine to route one turn to it, or tap a handoff chip when one engine suggests another — you approve every handoff. `/brain` answers on whichever engine is selected, from the same shared notes.
- **One Workspace.** The live navigation is **Overview · Work · Growth · Brain · Systems**. The shared thread stays attached across rooms; Work owns Board, Files, Artifacts, Reviews, and the real terminal; Systems owns observed Agents, Mesh, Loops, Operations, Inventory, and Activity. There is no second Box Console or compatibility application.
- **Ollama for cloud models — or local ones (new in 0.5.0).** Ollama ships in the image (CPU build, ~100MB — the GPU payload is stripped) and serves on the box at `127.0.0.1:11434`, never exposed to the internet. It's an OpenAI-compatible endpoint that proxies Ollama's **cloud** models (GLM, Qwen, and friends) — so agents on the box get a capable LLM without a local GPU, billed to your own Ollama account. To use it as Hermes's brain, add `HERMESENV_OLLAMA_API_KEY` in your app's Fly dashboard under Secrets, configure Hermes from the box terminal to use the local Ollama endpoint and your chosen model, then run `agenthost restart --app <your-app>` so the Hermes dashboard starts with that box-local config. AgentHost never reads Hermes's local `.env` or `config.yaml`, so it does not silently carry that provider wiring across. Prefer a model that runs **on the box itself** — free, private, no account? Set one secret and reboot: `flyctl secrets set OLLAMA_LOCAL_MODEL=llama3.2:1b -a <your-app>` — the box pulls it onto the volume (with free-space guards) and serves it from its own CPU. A 2GB machine handles ~1b-class quantized models for light work; scale the machine for bigger ones. Models survive reboots; both modes share the same endpoint.

## The Bridge: your box ↔ your desktop

Your box already has a public, login-gated URL — anything on your desktop can reach it (the chat endpoint included). The bridge completes the other direction:

```
agenthost bridge 27123 --token-env
```

That takes a service listening on your desktop (port 27123 is where an Obsidian Local REST API vault lives, to pick a non-random example) and gives your box a stable HTTPS URL for it. What that unlocks is up to you:

- The box agent reads and writes the same Obsidian vault your desktop Claude uses — a genuinely shared brain, not two diverging copies.
- Cloud runs that end by writing results somewhere your desktop automation picks up; desktop sessions that queue work the box executes overnight.
- Loops: a scheduled box run reads the vault, works, writes back; your desktop agent reacts on its next session. Hand work back and forth without you in the middle.

Honest prerequisites and properties:

- **Tailscale** (free for personal use) runs the tunnel on your desktop — install it, log in once; first bridge on a tailnet asks you to click one approval link. No Tailscale on the box side, and no AgentHost server anywhere in the path.
- The public URL is reachable by anyone who knows it, so **the local service's own auth is the lock**. The CLI refuses to bridge without `--token-env` unless you explicitly pass `--no-token` to say your service brings its own. `--token-env` reads `AGENTHOST_BRIDGE_TOKEN` for automation or prompts with input hidden. The token travels laptop → your Fly encrypted store, never on a command line, never through us.
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
- Detected Hermes, Codex, and OpenClaw safe files migrate automatically alongside Claude Code. Use `--no-hermes`, `--no-codex`, or `--no-openclaw` to opt an agent out. AgentHost never reads Hermes's local `.env` or `config.yaml`; add each required `HERMESENV_<KEY>` in your app's Fly dashboard under Secrets, create `/data/home/agent/.hermes/config.yaml` from the box terminal, then run `agenthost restart --app <your-app>` so Hermes starts with it. Auth, session, and pairing files never migrate.

Auth for the cloud agent: run with `--oauth-token-env` (subscription-billed, the default) or `--anthropic-key-env` (metered fallback). In a terminal, AgentHost prompts with input hidden. For automation, set `AGENTHOST_CLAUDE_CODE_OAUTH_TOKEN` or `AGENTHOST_ANTHROPIC_API_KEY`; the CLI consumes and deletes the input before it starts pack, Fly, or Tailscale children. Neither is required to deploy; the box just boots a shell until you set one.

## What's new

**0.5.6 — attribution in the canon is now at its authors' request.** The staged layer adopted from a collaborator's published framework stays in full; the named credit is deliberately withheld at the authors' own request and lands the moment they say the word. Docs-only; no functional change.

**0.5.5 — the canon is complete: the collaborator layer restored.** 0.5.4 shipped its Layer 5 with a held placeholder; this release restores the full section — graded consequences, evidence-graded claims, self-calibrating thresholds, frozen-identity hashing, adaptation-variance monitoring — as staged candidates.

**0.5.4 — the Operating Principles, unified.** The box now ships one canon — `/opt/agenthost/OPERATING-PRINCIPLES.md` — that states every governing principle once and points to the code that enforces it: the operator gates consequences, not code; a guardrail must make an agent more competent, not less; enforcement or it doesn't exist. It blends what we built with the ideas worth taking from convergent outside work (Sovereign-OS, arXiv 2603.14011 — ideas in our own words, with the lineage credited), and stages the next wave (capability leases, review rubrics, evidence grades, charter integrity hashing) honestly as candidates rather than pretending they're enforced. Docs-only release: no gate code changed.

**0.5.3 — launch-morning fixes on every customer box.** Bridge status reads the same secrets the boot script writes; checkout emails and operator alerts name the product actually bought (a shared Stripe account was crediting every sale to AgentHost); Gemini's charter now hard-declares it cannot read the board, so it stops reporting board state from memory.

**0.5.2 — the agents actually run, and the Command Center shows it.** Autonomous dispatch works: the gateway could not read the agent-owned Codex credential, so it silently judged Codex "not ready" and quietly dropped every card — it now asks the process that owns the credential instead of being handed the secret, so nothing crosses the identity boundary. Agent profile cards carry real buttons computed from live box state rather than a hardcoded "unavailable". The **Command Center** is rebuilt: an engine switcher, a live panel for the selected engine (its gateway, what it is working on, and how long it has been at it), that engine's board cards as a summary, and **Activity · Today** as one timeline — tap a row to jump to its engine, or open a card in place to act on it. A page-wide crash is fixed too: a poll was dying on an element that no longer existed, which quietly reported a perfectly healthy box as offline.

**0.5.1 — macOS parity.** The deploy path was audited end to end on a Mac; six rough edges in `agenthost deploy` fixed.

**0.5.0 — historical gateway milestone.** This release note describes the retired 0.5.0 pages; the current product serves one Workspace at `/`, and `/hermes` is deliberately gone. At the time, the box became a multi-engine gateway: Claude, Hermes, and Codex answered in one chat thread, each turn tagged with who answered and its cost, with `@mention` routing and tap-to-approve handoffs. Ollama shipped in the image (CPU-only build, GPU payload stripped, localhost only) as an OpenAI-compatible endpoint for its cloud models.

**0.4.0 — the Bridge.** `agenthost bridge` connects your box to your desktop (see: The Bridge). Built the way everything here is built: no AgentHost server sees your traffic or your token, teardown is one command, and the box agent discovers the bridge by itself.

**0.3.3** closed out launch week: the packer now strips hooks whose binaries don't exist on the box (no more phantom `command not found` at session start) and hardened its credential-pattern redaction; the harness tarball is deleted from the volume after extraction instead of being stored twice; chat history interleaves correctly on reload and no longer shows an empty "typing" bubble while your message is still queued behind another run; plus the phone keyboard/viewport fixes.

## Roadmap

The public roadmap is at [agenthost.space/roadmap](https://agenthost.space/roadmap/). It follows one clear sequence: **Backlog → Planned → In progress → Shipped**. “Shipped” means the capability is available; items without dates are direction, not a delivery promise.

The current focus is a shared provider layer, a durable team inbox, and safer provider controls. Planned next: Kimi Chat, agent profiles, and channel configuration. Voice, intelligent routing, and portable audit exports remain in the backlog until the foundation is ready.

## Security model

There is no AgentHost backend. The CLI drives `flyctl`; secrets go from your machine into Fly's encrypted secret store. Credential and session files never migrate: they are excluded from the harness pack and the CLI has no credential-file upload path. The cloud agent authenticates only with a value you hand over explicitly: your `claude setup-token` output (`CLAUDE_CODE_OAUTH_TOKEN`, subscription-billed — the default) or your own `ANTHROPIC_API_KEY`.

The terminal is behind a per-box login (hardened cookie, optional TOTP 2FA), and `/audit` shows every login and run. `agenthost destroy` removes the app, volume, and secrets.

## Layout

- `bin/cli.js` + `src/` — the `agenthost` CLI (deploy/sync/status/open/logs/doctor/snapshot/restore/destroy); `npm test` runs the fast, dependency-free unit tests
- `container/` — the runtime image: Claude Code in tmux served by ttyd, a zero-dependency gate (`gate.js`) that does cookie/2FA auth, the chat + cron + brain endpoints, web push (RFC 8291/8292 in plain Node crypto), and the phone app shell
- `scripts/pack.mjs` (+ `scripts/pack-lib.mjs` for its pure logic) — the migration packer: include/exclude/redact/path-translate for safe files from `~/.claude`, `~/.hermes`, `~/.codex`, and `~/.openclaw`; emits `harness.tar.gz` + a cloud-compatibility report (localhost MCP servers get disabled and listed, hooks that reference unmigrated paths get flagged with the exact `--include` to fix them)
