# AgentHost.space ↔ agentbox.grok.me gap dig

**For:** Deezyn / Deezyn-3D restage + eng port  
**Captured:** 2026-09-06 (live pages, not local code)  
**Verdict:** [agenthost.space](https://agenthost.space) is a thinner, Geist/orange v0 site. [agentbox.grok.me](https://agentbox.grok.me) is the fuller V2. Most of the *facts* already exist on `.space` inner pages. The homepage, CTAs, type, and interactive patterns do not.

**Do not invent a third look.** Visual target is agentbox.grok.me. Copy the coral, the serif italic emphasis, the pill CTAs, the hardware photography, and the “Book 30 / Strategy Definition” pair. Do not restage into a new Geist-orange or a new “premium dark” invention.

---

## 0. Messaging locks (do not drift)

| Lock | How to apply |
| --- | --- |
| Always **AgentHost.space** | Never bare “AgentHost” as the product name in new copy. Both live sites currently violate this. Fix on the restage. |
| Agents act inside the line; exceptions only | Safe work moves. Spend / send / deploy wait. ALLOW · LIMIT · REVIEW · HUMAN · DENY · STOP. |
| Soft CTA elsewhere = discovery call | Off-site (email, social, decks): discovery. **On-site CTAs must match agentbox:** primary **Book 30 minutes** → `https://calendly.com/gtmvp/agenthost`. Secondary **Strategy Definition** → `#strategy` widget. |
| Title on delivery / never bricked | Founding appliance $3,500. Cloud $1,500 is the same plane, no crate. |
| 30-day proving | Gate the first workflow or the first payment comes back. |
| No invented LinkedIn quotes | Named receipts only, labeled Public / Client-approved / Anon / USPTO. |
| Growth live · Revenue in build | Do not sell RevOps as installed. |

Attribyte Kickstarter is deprioritized. AgentHost.space is full speed.

---

## 1. Where the marketing site lives

**Not in this repo.** This checkout is `stevekaplanai/agenthost` — the public CLI / appliance (`agenthost-cli`). There is no `site/` tree here.

| Surface | Location | Role |
| --- | --- | --- |
| **Live production** | Vercel project `agenthost-growth` (`prj_T8bqROLyhYR2L2JOU6YOcQ7uDwbc`) | Aliases: `agenthost.space`, `www.agenthost.space` |
| **Source repo** | `Stevekaplanai/agenthost-growth` (private, Next.js / v0.app) | Latest prod deploy `dpl_8KCkFVM1SedwUoLFcQ8MDxdfmj7x` on `main` |
| **V2 reference (Grok)** | [https://agentbox.grok.me](https://agentbox.grok.me) | Grok project `01a0727d-81c9-78e3-8c30-cc4d9d54b0a6`. Not a Vercel project in GTMVP. |
| **Not live** | Vercel `agenthost` → `Stevekaplanai/agenthost-internal` | Historical. No `agenthost.space` alias. |
| **Not live** | Vercel `agenthost-space` → `Stevekaplanai/agenthost-space` (TanStack Start) | Preview only. Do not treat as production. |
| **Legacy memory** | `site/` under agenthost-internal | Old marketing tree. Do not edit unless that is still a relay for `/api/subscribe` etc. |

**Eng implication:** close-the-gap work ships from `agenthost-growth`, not this CLI repo. This file is the brief.

---

## 2. Visual lock for Deezyn (copy agentbox, do not invent)

### Tokens — use agentbox, retire `.space` orange/Geist

| Token | agentbox.grok.me **(target)** | agenthost.space **(retire on restage)** |
| --- | --- | --- |
| Background | `#090b0e` | `#07080b` / `#08080a` |
| Text | `#f3efe8` | `#e8eaee` |
| Accent | `#f36c5f` coral | `#ff5c2b` hot orange |
| Button ink | `#160f0c` on coral | `#100603` on orange |
| Card | `#12161b` / border `#2a313a` / radius 16 | `#0e1014` / `#272c34` / radius 21 + inset shadows |
| H1–H3 | **Cormorant Garamond 400**, italic emphasis word in coral | **Geist 600**, no italic lock |
| UI / buttons | **IBM Plex Sans 600**, 16px, pill 9999 | Geist 14px pills |
| Labels / captions | **IBM Plex Mono**, tracked | Geist Mono |
| Logo | Coral diamond + `agenthost` + “Own the machine” | `agenthost` + vertical orange/white mark |
| Nav | Home · About · Pricing · Features · Trust · Team | Modes · Inventory · Control plane · Pricing · The Team (+ cookie bar) |
| Header CTA | **Book 30 minutes** | **Show me the workflow** |
| Theme color | `#090b0e` | `#08080a` |

### Patterns to copy (not redesign)

1. Eyebrow in coral caps (`GOVERNED AI DEPARTMENT`, `THE MACHINE`, `STRATEGY DEFINITION`).
2. H1 with one italic coral word: “Here’s what you *never* do again.”
3. Dual CTA: coral **Book 30 minutes** + ghost **Strategy Definition**.
4. Lime/green mono line under CTAs: **THE MEETING IS THE ASK**.
5. Hardware photo in a dark inset, caption: “Title on delivery. Close the laptop. The department stays on.”
6. Four-up after hero: You choose *the mode* / You connect *the accounts* / You set *the boundaries* / The Box *keeps running*.
7. Sticky footer: `0 / 5 Press a surface. Then name the job.` + the same two CTAs.
8. In-page pills that jump to sections (`The number` · `Two tracks` · `Copilot` · `Features` · `First job`).

### What not to do

- Do not keep Geist + `#ff5c2b` and “just add Strategy Definition.”
- Do not invent a third serif, a gold accent, or a “more premium” palette.
- Do not flatten agentbox interactivity into static cards “for simplicity.”
- Do not put Stripe as the homepage primary. Stripe stays on pricing cards / after the meeting.

---

## 3. Section-by-section: homepage

Homepage length (full-page capture): **agentbox ~12,338px** vs **`.space` ~6,535px**. Same Box photo. Different story.

| Section | agentbox.grok.me | agenthost.space | Gap |
| --- | --- | --- | --- |
| **Hero** | H1 “Here’s what you *never* do again.” Sub: same plane / cancel anytime / titled on delivery / 30-day proving. CTAs Book 30 + Strategy Definition. Caption “Title on delivery. Close the laptop.” | H1 “Your department. Your machine. Your rules.” CTAs **Show me the workflow** (`/build`) + Open the control plane. Price line $3,500. Cookie bar eats first paint. | **Look + CTA + headline.** Facts exist; experience does not. |
| **Mode / accounts / boundaries** | Four-up interactive strip | Missing. Jumps to a “product scenario” workspace still. | **Missing pattern.** |
| **The machine / title on delivery** | Photo grid: ports, desk-at-night, unbox, STOP switch. “Yours on *delivery.*” “Close the laptop. The box stays on.” | Box stand + desk-ui + ports exist, thinner captions. “Close the laptop” appears once later. | **Thinner. Copy the photo sequence and captions from agentbox.** |
| **Sovereign / environment** | Tap-a-layer: Engines · Skills · Memory · Tools+MCPs · Keys vs Policies · Reviews · Loops · Gates · Receipts. `story-cloud.jpg`. | Missing as an interactive layer map. Control-plane page has a 7-layer list. | **Missing UI.** Content can be lifted from `/control-plane`. |
| **Checkout → first run** | 5-step story + `story-checkout.jpg` + cartoons (`cartoon-seat.jpg`, `cartoon-gate.jpg`) | Missing. `/pricing` has a thinner “No fog after Stripe” timeline. | **Missing story + cartoons.** |
| **The stack** | 7 tap-rows with *sentences*: Control plane, Shared Brain and Board, Modes, Policy packs, Execution fabric, Runtime, AgentHost Box. | Homepage: 5-step Ask→Research→Build→Check→Your call. Stack lives on `/control-plane` as a numbered list. | **Wrong pattern.** Port the tap-row, not the list. |
| **Owner buys** | 6 outcomes: Capacity, Service, Founder time, Memory, Next move, Quality | Missing on homepage. Pricing has “why this closes” (6 reasons). | **Different frame.** Use agentbox’s owner outcomes on home. |
| **Capability matrix** | 3 tracks (appliance $3,500 / cloud $1,500 / Enterprise). Preview rows + “34 capabilities. Every cell is a job.” → `/features` | Missing. No `/features` in sitemap. | **Missing page + widget.** |
| **Strategy Definition** | 19-step tap widget (`#strategy`). Door → 30 min discovery → 2-hour SD → Compass holds DNA → Install. Calendar opens itself. | **Absent on homepage.** `/build` is a 3-step team builder (noindex). `/trust` mentions $5,300 SD as a *sold artifact*, not the widget. | **Highest-leverage missing product.** |
| **Named receipts** | Homepage: BarkBox, Iron Neck, Easy Treezy, Tax-software SaaS + Todd Kane line | **Absent on homepage.** Present on `/control-plane`, `/trust`, `/about`. | **Promote, don’t rewrite.** |
| **Before / after** | `hero-panic.jpg` (dying laptop) vs `agentglass.jpg` (Control Room) | Missing | **Missing pair.** |
| **Pricing on home** | Implied in hero + matrix. Full offer on `/pricing`. | Two cards at bottom: $3,500 appliance / $1,500 cloud. CTAs still `/build`. | Prices match. **CTAs do not.** |
| **Watch the product** | “Watch the product before the argument. Plane · Crew · Box” + videos (`/video/control-plane.jpg`, `/video/sting.jpg`) | Same line, stills only (`desk-ui.png`, `box-ports.png`) | **Missing motion.** |
| **Footer** | Title / proving / named receipts / USPTO / Windows+Mac | Similar legal + `/build` | Align CTAs + “AgentHost.space” lock. |

### Hero side-by-side

<img src="/opt/cursor/artifacts/agenthost_space_hero.png" alt="Live agenthost.space homepage hero — Geist, orange, Show me the workflow" />

<img src="/opt/cursor/artifacts/agentbox_grok_me_hero.png" alt="Live agentbox.grok.me homepage hero — Cormorant, coral, Book 30 and Strategy Definition" />

---

## 4. Pricing

Prices already match. The *page* does not.

| | agentbox `/pricing` | agenthost.space `/pricing` |
| --- | --- | --- |
| H1 | “Here’s the price. Here’s what you *never* do again.” Lead number **$1,500** cloud, crate as the other track **$3,500** | “More clients per person…” Lead number **$3,500**. Cloud is “quieter track.” |
| Primary CTA | Book 30 + Strategy Definition. **THE MEETING IS THE ASK** | **Start the appliance** (Stripe) + Show me the workflow |
| “Never again” list | 8 crossed-off Tuesdays | Missing |
| Math | $200 chat / $8–15k seat / $10k+ retainer / **$1,500** | 6 “why this closes” cards + chat-vs-hire-vs-appliance table |
| Two tracks | Cloud $1,500 (list $3,750) + Own the box $3,500 (list $7,000). Stripe links present. | Same Stripe links. Cloud de-emphasized. |
| Copilot key | Interactive: Intent→Decision→Grant→Execution→Verification→Receipt. `box-keys.jpg` | Missing |
| Named receipts | Full set including $5,300 SD, 192 steps, 2,557 steps, 4 provisionals | Missing on this page (on `/trust`) |
| After Stripe | Minutes → same hour desk → same day Steve → Definition call → Compass → crate → 30 days → six-month plane | Shorter: Receipt → Desk → Founder → Crate → Proving → Term |
| Matrix | Full 34-cell table on-page | Missing |
| Strategy widget | Same 19-step `#strategy` | Missing |
| Close | “If it doesn’t gate, you don’t *pay.*” | Stripe again |

**Keep:** both Stripe payment links (`cNi6oJ63Q3C1cY6fM9fAc0k` appliance, `00w7sN63Q5K96zIarPfAc0l` cloud).  
**Change:** homepage and pricing primary is the meeting, not the card.

<img src="/opt/cursor/artifacts/agenthost_space_pricing_hero.png" alt="agenthost.space pricing hero — $3500 first, Stripe primary" />

<img src="/opt/cursor/artifacts/agentbox_grok_me_pricing_hero.png" alt="agentbox.grok.me pricing hero — $1500 lead, Book 30 primary" />

---

## 5. Strategy Definition (the missing product)

agentbox ships a **19-step tap brief** on Home, Pricing, Features, About. First beat:

- `01 / 19 · You` — Who is this for? Agency / in-house / founder / freelance desk
- Brief rail: Door → 30 minutes (calendar opens itself) → 2 hours (Brand DNA written *on the call*, not in a form) → Compass holds DNA → Install + proving
- Last step is name + URL. Then Calendly appears. No second “book” click required.

`.space` substitute is `/build` (“Agency Team Builder”, 3 steps, `noindex`). It asks which *workflow desk* to recommend. It does not name the stuck job, does not write Brand DNA, does not open Calendly.

**Do not restyle `/build` and call it Strategy Definition.** Port the 19-step widget. `/build` can stay as a hidden utility.

<img src="/opt/cursor/artifacts/agentbox_receipts_strategy.png" alt="agentbox Strategy Definition widget — 01 of 19 plus 34-cell matrix teaser" />

---

## 6. Capability matrix + Features

agentbox `/features`:

- H1 “Here’s every *layer.*”
- Tap-row stack (7)
- **34-cell matrix**, filters: All 34 · The offer · Persistence · Governance · Dev Mode · Growth Mode · Enterprise · Service
- Legend: Included · Tier-defining · Configured to scope · Early access
- Tracks: Founding appliance **Box · X1 Pro** / Cloud plane **No crate** / Enterprise **Custom**
- Rooms: Control Room, Inventory, Brain, Control plane, Operate from anywhere (`agentglass.jpg`, `inventory.jpg`, `brain-3d.jpg`, `control-plane.jpg`, `control-flow.jpg`)
- Before/after + 5-step path + 5 “questions the box should answer” (`graphify.jpg`)
- Same `#strategy` widget + sticky CTAs

`.space` has **no `/features`**. Closest pages:

- `/control-plane` — long, good copy, Geist, `/build` CTAs, named receipts already in
- `/growth-mode` — campaign illustrations, different visual language again
- `/collections` — policy-pack inventory

<img src="/opt/cursor/artifacts/agentbox_features_hero.png" alt="agentbox features hero — stack, Book 30, Strategy Definition, tap-rows" />

---

## 7. Named receipts (copy as labeled)

Use these numbers. Do not rewrite. Do not invent quotes.

| Label | Name | Figures | Where on `.space` today |
| --- | --- | --- | --- |
| Public | BarkBox | +204% conversions · +254% ROAS · −31% CPC. Todd Kane, VP Growth. Google PPC, YoY 2019. | `/control-plane`, `/trust`, `/about` — **not homepage** |
| Client-approved | Iron Neck | +41% sales · −59% CPS · +976% ROAS. Aug–Dec 2019 vs 2018. | same |
| Client-approved | Easy Treezy | +86% sales · +104% ROAS · +216% CVR. Holiday 2019 vs 2018. | same |
| Anon | Tax-software SaaS | $256K new revenue · 48% margin in 2 days · +125% YoY | same |
| Sold work | $5,300 · 4 weeks | Strategy Definition. Six exercises. 10+ clients, 2022–2023. | `/control-plane`, `/trust` |
| Process | 192 steps | Onboarding SOP. Check-ins 7 · 14 · 21 · 30 · 44 · 58 · 72. | same |
| Encoded | 2,557 steps | Process library, role-labeled, 2020–2023. | same |
| Filed | 4 provisionals | USPTO August 2026. Filed, **not granted**. Continuity · delegated authority · attribution · governed development. | same |

agentbox `/trust` adds: no invented LinkedIn wall; a *collection kit* (paste only what an operator wrote; Steve reviews). Worth porting.

---

## 8. IA + CTA map

| Route | agentbox | agenthost.space | Action |
| --- | --- | --- | --- |
| `/` | V2 home | Thin editorial home | **Replace with V2 home** |
| `/pricing` | V2 offer | Stripe-first, no matrix/SD | **Restage to V2** |
| `/features` | Stack + 34-cell + rooms | **404 / not in sitemap** | **Add** |
| `/about` | 11-beat product story + SD | Founder/career, `/build` | Restage to V2 about |
| `/trust` | Labeled receipts + LinkedIn kit | Career + receipts + seats, Stripe | Restage chrome; keep facts |
| `/team` | Named seats + board demo | `/agency` exists (different) | Port `/team` or alias |
| Calendly | Everywhere | **None** | **Add** |
| `/build` | — | Team builder, noindex | Keep off primary path |
| `/control-plane` | — | Longest `.space` page | Keep as deep link; restage chrome later |
| `/growth-mode` | — | Long Growth page | Keep; do not let it set the visual |

`.space` extras to leave in the basement (do not delete this pass): `/collections`, `/integrations`, `/vault`, `/revenue`, `/game`, cookie/privacy, Sign in.

---

## 9. Concrete gaps (checklist)

### Missing on `.space` homepage (must ship)

- [ ] Book 30 minutes → Calendly
- [ ] Strategy Definition 19-step widget + “calendar opens itself”
- [ ] Coral/Cormorant/IBM Plex visual system
- [ ] Four-up mode / accounts / boundaries / keeps running
- [ ] Named receipts strip (BarkBox / Iron Neck / Easy Treezy / Tax SaaS)
- [ ] Interactive stack tap-rows
- [ ] Capability-matrix teaser (3 tracks + “See every cell”)
- [ ] Owner-outcomes six
- [ ] Environment layer map + checkout story + cartoons
- [ ] Before/after (`hero-panic` / `agentglass`)
- [ ] Sticky “press a surface → name the job” bar
- [ ] Hero caption “Close the laptop. The department stays on.”
- [ ] Nav: Home / About / Pricing / Features / Trust / Team
- [ ] Wordmark “Own the machine” + coral diamond

### Thinner (exists, wrong place or weaker)

- [ ] Title-on-delivery / never-bricked (present, not the refrain)
- [ ] $3,500 / $1,500 (present; Stripe is the primary instead of the meeting)
- [ ] Receipts (buried on `/trust` and `/control-plane`)
- [ ] Stack (list on `/control-plane`, not tap-rows)
- [ ] Career eras (on `/about` and `/trust`, not V2 about beats)
- [ ] “Watch the product” (stills vs film)

### Missing pages / widgets

- [ ] `/features` with 34-cell matrix
- [ ] Copilot-key interaction on pricing
- [ ] “Never again” eight-item list
- [ ] Rooms filmstrip (Control Room / Inventory / Brain / plane)
- [ ] LinkedIn collection kit on `/trust`

### UI chrome to drop or demote

- [ ] Cookie bar competing with the hero (keep compliance, restage so it does not own first paint)
- [ ] Geist + `#ff5c2b` as the brand
- [ ] “Show me the workflow” as the site primary
- [ ] Inventory mega-nav as the first thing a buyer sees

---

## 10. Assets Deezyn needs (harvest from agentbox, do not redraw)

Copy these files. Recolor/crop only if the lock requires it. **Do not generate a new Box.**

### Hardware (homepage + pricing)

- `https://agentbox.grok.me/img/box-hero.jpg`
- `https://agentbox.grok.me/img/box-ports.jpg`
- `https://agentbox.grok.me/img/box-desk.jpg`
- `https://agentbox.grok.me/img/box-unbox.jpg`
- `https://agentbox.grok.me/img/policies-features.jpg`
- `https://agentbox.grok.me/img/box-keys.jpg` (pricing Copilot)
- `https://agentbox.grok.me/img/desk-ui.png`

### Story / 3D (Deezyn-3D: match these, do not invent)

- `https://agentbox.grok.me/img/story-cloud.jpg`
- `https://agentbox.grok.me/img/story-checkout.jpg`
- `https://agentbox.grok.me/img/story-inside.jpg`
- `https://agentbox.grok.me/img/cartoon-seat.jpg`
- `https://agentbox.grok.me/img/cartoon-gate.jpg`
- `https://agentbox.grok.me/img/hero-panic.jpg`
- `https://agentbox.grok.me/img/agentglass.jpg`
- `https://agentbox.grok.me/img/inventory.jpg`
- `https://agentbox.grok.me/img/brain-3d.jpg`
- `https://agentbox.grok.me/img/control-plane.jpg`
- `https://agentbox.grok.me/img/control-flow.jpg`
- `https://agentbox.grok.me/img/graphify.jpg`
- `https://agentbox.grok.me/img/encoded-desk.jpg`
- `https://agentbox.grok.me/img/destinations.jpg`
- `https://agentbox.grok.me/img/govern.jpg`
- `https://agentbox.grok.me/img/okr.jpg`
- `https://agentbox.grok.me/img/receipt.jpg`

### Motion

- `https://agentbox.grok.me/video/control-plane.jpg` (poster)
- `https://agentbox.grok.me/video/sting.jpg`
- `https://agentbox.grok.me/video/box-story.jpg`

### Chrome

- `https://agentbox.grok.me/og.jpg`
- `https://agentbox.grok.me/favicon.svg`

`.space` already has related stills under `/control-plane/img/` (`box-stand.png`, `desk-ui.png`, `box-ports.png`, `unbox.png`, `stop.png`, `layers.png`). Prefer the **agentbox JPGs** so the restage does not mix two photo grades.

**Deezyn-3D:** only extend `story-*`, `brain-3d`, rooms, and graphify *in the existing camera / material language*. No new chassis. No new mascot.

---

## 11. What design can restage now vs what needs eng

### Design can restage **now** (no eng)

Leave-behinds, decks, ads, OG, email, sales PDFs:

1. Lock tokens (table in §2).
2. Rebuild homepage and pricing frames 1:1 from agentbox screenshots.
3. Place Book 30 + Strategy Definition on every frame.
4. Place the four named receipts with labels.
5. Use agentbox hardware + story images (download the list in §10).
6. Wordmark: diamond + `agenthost` + Own the machine. Product name in body: **AgentHost.space**.
7. Kill Geist/orange in any new leave-behind.

### Needs eng (cannot fake in Figma as the live site)

| Widget | Why eng |
| --- | --- |
| 19-step Strategy Definition + Calendly auto-open | State machine, last-step calendar, brief persistence |
| 34-cell matrix with filters + cell→job | Data table, tap writes the stuck job into SD |
| Stack tap-rows | In-page expand, not a new route |
| Environment layer map | Tap layer / open there |
| Copilot key sequence | Pricing interaction |
| Sticky 0/5 surface counter | Cross-section state |
| Rooms filmstrip | Press-a-room, example-tenant disclaimer |
| LinkedIn collection kit | Local-only paste + Steve review path |
| Cookie restage | Keep lawful; stop covering the hero |

---

## 12. Close-the-gap plan (P50 engineering days)

P50 = focused implementation days in `agenthost-growth`, assuming Deezyn supplies frames from agentbox (not a new system) and copy is lifted, not rewritten.

| Wave | Owner | P50 | Ship |
| --- | --- | --- | --- |
| **0. Lock + harvest** | Deezyn | 0 eng | Token sheet, asset dump from §10, homepage/pricing/features frames traced from agentbox. |
| **1. Chrome + homepage match** | Eng + Deezyn | **3** | Fonts/tokens/logo/nav. Replace `/` with V2 sections that are *static-capable*: hero, four-up, machine photos, receipts, owner outcomes, pricing cards, footer. CTAs → Calendly + `#strategy` placeholder. Cookie restage. Messaging lock pass. |
| **2. Strategy Definition** | Eng | **3** | Port 19-step widget. Last step opens Calendly. Shared on `/`, `/pricing`, `/features`, `/about`. Do not reuse `/build`. |
| **3. Matrix + `/features`** | Eng | **3** | 34 rows, 3 tracks, filters, cell taps feed SD. Rooms + before/after + path. |
| **4. Pricing V2** | Eng | **2** | Never-again list, math, two tracks (Stripe secondary), Copilot key, after-Stripe, matrix embed, SD, “if it doesn’t gate.” |
| **5. About / Trust / Team** | Eng | **2** | Port V2 about beats, trust kit, team seats. Keep `.space` facts. |
| **6. Motion + 3D** | Deezyn-3D + Eng | **1–2** | Drop agentbox posters/films. Only then retouch story/brain if a frame is short. |

**P50 total to “`.space` matches agentbox”:** ~14 engineering days, waves 1–5 sequential-ish (2 and 3 can overlap after wave 1 tokens exist).

**Do not do this pass:** Attribyte, new Growth-mode art direction, rewriting receipts, a third design system, promoting `/build`.

---

## 13. Eng checklist (ship order)

Work in `Stevekaplanai/agenthost-growth`. Preview on Vercel, then `agenthost.space`.

1. **Tokens.** Cormorant Garamond + IBM Plex Sans/Mono. Accent `#f36c5f`. Background `#090b0e`. Remove Geist as the display face.
2. **Chrome.** Diamond wordmark, V2 nav, Book 30 in the header. Demote cookie bar.
3. **Homepage.** Replace section list with V2 order (§3). Lift receipts from `/trust`. Lift stack sentences from `/control-plane`.
4. **Calendly.** `https://calendly.com/gtmvp/agenthost` on every primary.
5. **Strategy Definition.** New shared component. 19 steps. Site/name last. Calendar opens itself. Mount at `#strategy`.
6. **`/features`.** New route. Matrix data as one typed table (appliance / cloud / enterprise).
7. **`/pricing`.** V2 story. Keep both Stripe URLs. Meeting stays primary.
8. **`/about` `/trust` `/team`.** V2 chrome + existing facts.
9. **Copy lint.** “AgentHost.space” not “AgentHost.” Exceptions-only line. Growth live / Revenue in build. Provisionals filed not granted. No invented quotes.
10. **QA.** Desktop 1440 and mobile 390 against the agentbox screenshots in this brief. Every nav CTA pair. Matrix cell → SD. SD last step → Calendly. Stripe still works from pricing cards.

---

## 14. What `.space` already has (do not rediscover)

Lift, don’t rewrite:

- Offer math: $3,500 founding appliance (list $7,000), $1,500 cloud (list $3,750), six-month plane, 30-day proving, never bricked
- Stripe links (both tracks)
- Named receipts + USPTO line
- Career eras (NOC → agency → regulated → compilation)
- ALLOW / LIMIT / REVIEW / HUMAN / DENY / STOP
- “You own the machine. You subscribe to the plane.”
- Control-plane long-form (rooms, modes, connection truth)
- Growth Mode desks (Performance / Delivery / Pipeline) — keep off the V2 home

---

## 15. Sources

Live scrapes + screenshots, 2026-09-06:

- [https://agenthost.space](https://agenthost.space), `/pricing`, `/build`, `/control-plane`, `/growth-mode`, `/trust`, `/about`
- [https://agentbox.grok.me](https://agentbox.grok.me), `/pricing`, `/features`, `/about`, `/trust`, `/team`
- Vercel: `agenthost-growth` aliases `agenthost.space` / `www.agenthost.space`; git `Stevekaplanai/agenthost-growth`
- Styleguides via Context `web-styleguide` on both homepages

Walkthrough artifacts (this brief):

- `agenthost_space_hero.png` / `agentbox_grok_me_hero.png`
- `agenthost_space_pricing_hero.png` / `agentbox_grok_me_pricing_hero.png`
- `agentbox_receipts_strategy.png` / `agentbox_features_hero.png`
- `agenthost_space_hero_mobile.png` / `agentbox_grok_me_hero_mobile.png`
- Full-page: `agenthost_space_fullpage.png` (~6.5k px) vs `agentbox_grok_me_fullpage.png` (~12.3k px)
