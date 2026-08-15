---
name: Competitive Intelligence Platform
description: Full-stack competitor monitoring platform built in one session — FastAPI + Next.js + Kimi 2.6 + Docker
type: project
originSessionId: a61a3cad-1e0f-4985-90a0-c60f655e104b
---
## Project: Competitive Intelligence Platform
- Path: C:\Users\User\Projects\competitor-monitor
- GitHub: GTMVP/competitive-intelligence (PRIVATE)
- Deployed: Replit (pending)
- Built: 2026-04-22 in a single session

## Stack
- Backend: Python/FastAPI, SQLAlchemy, Alembic, PostgreSQL, Redis
- Frontend: Next.js 16, React 19, TypeScript, Tailwind v4
- AI: Kimi 2.6 via OpenRouter (moonshotai/kimi-k2.6)
- Scraping: Apify, httpx, Playwright/Chromium
- Design: "Signal Intelligence" dark theme, Instrument Serif + Plus Jakarta Sans

## Key Architecture Decisions
- Modular monolith (not microservices) for speed of shipping
- Kimi 2.6 requires `include_reasoning: false` in OpenRouter calls or content comes back null
- Kimi 2.6 needs max_tokens=4000+ for structured extraction (reasoning burns tokens even when disabled)
- Docker DNS on Windows is flaky — add `dns: [8.8.8.8, 8.8.4.4]` to docker-compose services
- `.env` file must be copied into backend/ directory for pydantic-settings to find it (volume mount overrides)
- pydantic-settings needs `extra: "ignore"` in model_config to not reject unknown env vars
- Auto-scan sources on discovery (don't make users click "Run All")
- Generate initial intelligence events on FIRST scan (don't wait for diffs)
- Alerts tab = inbox of intelligence, not settings page

## API Keys (in .env)
- OPENROUTER_API_KEY: sk-or-v1-129b49... (Steve's key)
- APIFY_API_TOKEN: apify_api_SrrIJI... (Steve's key)
- OPENROUTER_MODEL: moonshotai/kimi-k2.6

## Steve's Account
- Email: steve@stevekaplan.ai
- Workspace: 1d86370b-08a4-46f4-b5ed-1724cced2840
- 8 competitors tracked: Hypersonix, Klue, Crayon, Kompyte, Contify, AlphaSense, Crunchbase, G2
