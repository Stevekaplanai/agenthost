# AgentHost

> **Persistent, governed AI agents in infrastructure you control.**

[![npm version](https://img.shields.io/npm/v/agenthost-cli.svg)](https://www.npmjs.com/package/agenthost-cli)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/Stevekaplanai/agenthost.svg)](https://github.com/Stevekaplanai/agenthost)

```bash
npx agenthost-cli
```

One command moves your local AI agent setup to a 24/7 box in **your own** Fly.io account. Skills, memory, CLAUDE.md, MCP servers, and your repos come with it. Your phone gets the live session.

**Hosting is the mechanism. Continuity is the product.**

---

## What it does

- **Runs your agent 24/7** — survives lid-close, sleep, reboots. The box stays up; your context stays alive.
- **Deploys to your cloud** — your Fly.io account, your keys, your data. No AgentHost backend.
- **Governs unattended runs** — budgets, human gates, cross-engine review, audit trails.
- **Works from your phone** — monitor, approve, and steer agents from a mobile PWA.

## Quick start

```bash
# 1. Deploy (detects ~/.claude, packs, creates Fly app, deploys)
npx agenthost-cli
agenthost deploy --org <your-fly-org>

# 2. Open on your phone
agenthost open    # prints a login link

# 3. Manage
agenthost status  # is the box up?
agenthost sync    # push local harness changes
agenthost logs    # tail the box
```

That's it. No AgentHost account, no AgentHost servers. Just your Fly account and your agent.

## Why

Your laptop sleeps. Your agent dies. Your context is gone.

You reopen the laptop, re-explain the task, spend 30 minutes getting back to where you were. Every. Single. Day.

AgentHost fixes this. Your agent lives on a box that doesn't sleep. You close your laptop; the agent keeps working. You open your phone; the agent is still there, holding context, mid-task.

## Features

- 🔄 **Persistent** — agents survive lid-close, sleep, reboots. Context, memory, and work state persist across sessions on a Fly volume.
- 🏛️ **Governed** — budgets, human gates, cross-engine review, and audit trails. You control what unattended agents can and can't do.
- 📱 **Mobile** — monitor and approve from your phone. Installs as a PWA with touch-optimized keys.
- 🔒 **BYO Cloud** — your Fly account, your keys, your data. No AgentHost backend. No third party sees your code.
- 🧠 **Brain Search** — grep your skills, memory, and notes across all sessions. Find what your agent learned last week.
- 🔁 **Loops** — scheduled agents that work while you sleep. Cron-like runs that fire on your box, not your laptop.

## Supported agents

| Agent | Status |
|-------|--------|
| Claude Code | ✅ Stable |
| Codex | ✅ Stable |
| Gemini CLI | ✅ Stable |
| Hermes Agent | ✅ Stable |
| OpenClaw | ✅ Beta |
| Ollama | ✅ Beta |

## Pricing

| Tier | Price | What you get |
|------|-------|-------------|
| **Free** | $0 | BYO cloud, deploy, sync, mobile PWA |
| **Founding Operator** | $29/mo | Governance, loops, brain search, priority support |
| **Founding 50** | $499 lifetime | Everything above, forever. Use code `TOMORROWSHERE`. |

Cloud and model usage are always yours. No markup, no bundling.

→ **[Claim a founding seat →](https://agenthost.space/founders/)**

## FAQ: Why not just script Fly yourself?

You can. The original AgentHost was a PowerShell script that did exactly that. But you'll end up rebuilding:

- **Harness packing** — detecting `~/.claude`, redacting credentials, disabling localhost MCP servers
- **Volume management** — persistent storage for skills, memory, and repos across redeploys
- **Mobile access** — ttyd + HTTPS + PWA manifest + touch keys
- **Sync workflow** — pushing CLAUDE.md and skill changes without a full redeploy
- **Governance layer** — budgets, gates, audit trails

AgentHost is that script, productionized. 46 lines of PowerShell became a CLI, a container, a packer, and a PWA. If you want to build it yourself, the MIT license says go ahead. If you want to ship code instead of infrastructure, `npx agenthost-cli`.

## Links

- **Website:** [agenthost.space](https://agenthost.space)
- **npm:** [agenthost-cli](https://www.npmjs.com/package/agenthost-cli)
- **Docs:** [agenthost.space/docs](https://agenthost.space)

## License

MIT © Steve Kaplan