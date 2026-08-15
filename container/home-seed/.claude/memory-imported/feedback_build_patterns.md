---
name: Build patterns from Competitive Intelligence project
description: Lessons learned building a full-stack AI SaaS product in one session with Steve
type: feedback
originSessionId: a61a3cad-1e0f-4985-90a0-c60f655e104b
---
## Never show empty states — generate value immediately
When a user adds data (competitor, source, etc.), the system should immediately produce useful output. Don't make users wait for a second scan/cycle/comparison to see results. Use AI extraction on first scan to populate insights right away.

**Why:** Steve was frustrated that the alerts tab was empty and insights had no data even after sources were scanned. The second-scan-for-diffs model left users with nothing to see.

**How to apply:** For any monitoring/tracking product, generate "initial intelligence" events on first data capture. Use LLM extraction to turn raw data into structured insights immediately.

## "Alerts" means inbox, not settings
When users click an "Alerts" tab, they expect to see alerts that happened — not configuration for alert rules. Settings go behind a gear icon.

**Why:** Steve explicitly said "when I see Alerts I expect to see alerts, not settings."

**How to apply:** Any tab named after a noun (Alerts, Reports, Messages) should show instances of that thing, not configuration. Settings are always secondary.

## Auto-run everything — minimize manual steps
After adding a competitor, sources should auto-discover AND auto-scan. No "Run All" button needed for the first pass.

**Why:** Steve asked "why do I have to go in and run all?" — every manual step is friction.

**How to apply:** Chain operations automatically: add competitor -> discover sources -> queue fetch jobs. The user should see results appearing, not buttons to click.

## Kill jargon — use human language
"Ready for diff" means nothing to users. "Monitoring" or "First scan complete — watching for changes" communicates the same thing in plain language.

**Why:** Steve asked "What does Ready for diff mean?"

**How to apply:** Audit every status message, label, and badge for technical terms. Replace with outcome-oriented language.

## Kimi 2.6 via OpenRouter quirks
- Must send `include_reasoning: false` or content returns null (reasoning consumes the entire token budget)
- Needs max_tokens=4000+ even for short JSON extraction
- Tool calling works but requires non-streaming first pass, then stream the final response
- Status updates during tool execution vastly improve UX over a single "thinking" spinner

**How to apply:** Any Kimi 2.6 integration should set include_reasoning: false and high max_tokens by default.

## Docker DNS on Windows Desktop is unreliable
Containers intermittently fail DNS resolution. Add explicit Google DNS to docker-compose services that make outbound HTTP calls.

**How to apply:** Always add `dns: [8.8.8.8, 8.8.4.4]` to docker-compose services that call external APIs.

## Conversion-oriented landing page design
Steve wanted "a website that speaks to our audience" — not feature lists but benefit-driven copy, outcome metrics, persona cards with pain quotes, and a clear CTA flow. The "Signal Intelligence" dark theme with editorial serif fonts (Instrument Serif) + clean body (Plus Jakarta Sans) tested well.

**How to apply:** When building SaaS landing pages, lead with the problem, show outcomes not features, include social proof via persona cards, and end with urgency CTA.
