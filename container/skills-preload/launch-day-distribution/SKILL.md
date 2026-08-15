---
name: launch-day-distribution
description: >-
  Product-launch distribution strategy for bootstrapped founders — Product Hunt
  mechanics (featuring truth, listing craft, maker moves), Hacker News Show HN
  tactics, Reddit launch rules per subreddit, the same-day directory matrix, and
  the launch-day operations loop (sweep/reply/log/traffic). Use when launching a
  product on PH/HN/Reddit/directories, planning a launch week, reacting to an
  unfeatured PH launch, choosing where else to submit today, or preparing
  launch assets. Built from Steve Kaplan's Product Launch Playbook (bootstrapped
  edition), verified 2026 research, and the live AgentHost launch (2026-07-27).
---

# Launch-Day Distribution

The one-line thesis: **featuring and front pages are lotteries; distribution
breadth and answer-speed are choices.** Play the choices.

## 1. Product Hunt — the honest mechanics (verified 2026)

- **Featuring is human editorial**, ~10% of launches, judged on Useful / Novel /
  High Craft / Creative. There is NO same-day appeal path — PH's own guidance:
  "reaching out is rarely necessary" and doesn't change outcomes. Do not burn
  launch-day hours chasing it. (help.producthunt.com/…/featuring-guidelines)
- **Unfeatured ≠ dead.** The listing still ranks in search, collects followers,
  and the badge/backlink work. Treat PH as one node, not the launch.
- **Relaunch policy:** 6 months minimum, OR earlier with a "significant update"
  (new app, real new functionality — not pricing/UI tweaks), pre-cleared via
  hello@producthunt.com. Plan the next major release as the featured attempt.
- **Listing craft** (from the inference-sh PH skill, installed alongside):
  tagline ≤60 chars naming outcome not category; gallery 1270×760; a maker
  comment posted within 5 minutes of going live; launch 12:01 AM PT Tue–Thu
  for featured attempts (weekends = less competition but less traffic).
- **Never** buy or coordinate upvotes — detected, vote-stripped, and can kill
  the account. Asking your list to "check out the launch" is fine; asking for
  votes violates PH norms.

## 2. Hacker News — Show HN

- Title formula: "Show HN: <name> – <plain concrete thing it does>". No
  superlatives, no emoji, no marketing verbs. HN's culture rewards the builder
  voice and punishes launch-speak.
- Known dynamics (hn-skill research, 157k Show HN corpus): Show HN posts carry
  a ranking penalty (~0.4x), so comments and early organic upvotes matter more
  than on normal stories. NEVER solicit votes (voting-ring detection kills the
  post silently). Do solicit *questions* from communities you're already in.
- First comment: the maker's technical origin story with an honest limitation
  in it. HN trusts posts that admit what doesn't work yet.
- If the post doesn't take off in hours: that's normal. One reshare is
  acceptable days later; the real HN win is often a later technical blog post.

## 3. Reddit — per-sub rules that actually bite (verified)

- **r/SideProject** — friendliest; instant; format "[Name] - [short desc]".
- **r/selfhosted** — projects **under 3 months old go in the New Project
  Megathread ONLY** (standalone posts auto-removed); flair required
  ("Release (AI)" for AI-built); must be production-ready with docs.
- **r/LocalLLaMA** — the 1/10th self-promo rule (your account's history
  matters); disclose affiliation; **Rule 3 bans posts reading like LLM copy** —
  write a technical writeup (architecture, tradeoffs, numbers) with
  Discussion/Resources flair, not a launch post.
- Silent AutoMod karma/age thresholds exist and are unpublished — if a post
  vanishes, message the mods once, politely; don't repost.

## 4. Same-day directory matrix

| Where | Cost | Speed | Gotcha |
|---|---|---|---|
| Peerlist Launchpad | free | instant, **Mondays only** | complete profile required; no upvote DMs |
| Indie Hackers (product + post) | free | instant | engagement is the ranking |
| r/SideProject | free | instant | format rule above |
| Twelve Tools | free | daily showcase | — |
| Uneed | free queue / $29.99 date-pick | queue unpublished | — |
| There's An AI For That | free lottery / $49–$347 | 1–2 days | prefers brand-new tools |
| Dev Hunt | free | queued | GitHub login; dev tools only |
| Fazier | free / $29+ instant | free ≈15 days | free tier wants a backlink |
| Microlaunch | free / $39 (code LAUNCH20) | Pro = anytime | relaunches need major releases |
| BetaList | paid only | days–weeks | rejects already-launched products — skip on launch day |

Legit paid distribution (no vote-buying): Uneed newsletter $399 / 100-directory
auto-submit $249; Turbo0 ~$17–70 multi-submit (footer badge required);
Submitator $29/~30 directories. Anything selling upvotes = ToS violation, skip.

## 5. The content doctrine (Steve's playbook)

- **One incredible content piece before launch → 200–300 derivatives.** The
  launch is a repurposing event, not a writing event.
- Go live everywhere simultaneously (StreamYard) on launch day.
- Tool bench from the playbook: syften.com (mention monitoring, worth paying
  during launch week), deepgaze.ca (Reddit monitoring), publer.com or Postiz
  (distribution), arcade.software / produktly (interactive demos), PostHog
  (CRO + traffic truth), trackdesk (affiliates), brevo (email/SMS follow-up).

## 6. Launch-day operations loop (proven live, 2026-07-27)

Run a 10-minute sweep loop for the whole launch day:

1. **Sweep** every surface (PH comments, HN thread via
   hn.algolia.com/api/v1/items/<id>, subreddit posts, mention monitor).
2. **Draft replies in the founder's voice** from a pre-built answer bank
   (hard questions answered honestly BEFORE launch); founder pastes on
   surfaces tied to their account.
3. **Log every Q&A pair** in one running note so repeated questions get
   identical answers.
4. **Watch traffic, not vanity:** PostHog web overview per sweep — visitors
   arrive silently before votes/comments do; the traffic curve tells you which
   channel is working while the boards still look dead.
5. **Escalate only on:** security claims, viral comments, first-live moments.
   Everything else is a one-line update. Protect the founder's attention.
6. Audible ping per sweep if the founder wants ambient awareness.

## 7. Priority order when you are NOT featured

1. Post the Show HN (own it all day in comments).
2. Reddit per the rules above (megathread + technical writeup framings).
3. Peerlist (if Monday) + Indie Hackers + Twelve Tools + free queues (Uneed,
   Dev Hunt, TAAFT) — 30 minutes total, compounding backlinks.
4. Email list + social queue (the owned channels outperform the lottery).
5. Ride any live news angle honestly (newsjacking skill).
6. Book the 6-month PH relaunch around the next major release, and make THAT
   one the featured attempt (craft assets to the four criteria).

## Sources

PH featuring guidelines + relaunch policy (help.producthunt.com, official) ·
inference-sh/skills product-hunt-launch (658★) · JanBussieck/hn-skill (Show HN
corpus analysis) · subreddit rules wikis (r/selfhosted, r/LocalLLaMA) · Steve's
Product Launch Playbook (Notion, bootstrapped edition) · AgentHost launch live
telemetry 2026-07-27.
