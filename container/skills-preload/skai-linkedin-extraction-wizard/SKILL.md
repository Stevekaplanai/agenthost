---
name: skai-linkedin-extraction-wizard
description: Use when sourcing GTMVP-ICP leads — primary engine is Apollo "intent search" (find founders/CMOs at B2B SaaS whose company is actively hiring paid-media/growth roles). Secondary engine is LinkedIn comment harvesting on validated comment-X creator posts. Also covers Close CRM build pattern (lead → contact → task), Apollo enrichment workflow, master deduping, and creator-format validation before spending scrape budget.
---

# GTMVP Lead Sourcing & Outreach Engine

## Overview

Two sourcing engines, ranked by empirical yield:

1. **Apollo intent search** (primary, 6× hit rate) — find decision-makers at B2B SaaS companies that are **actively hiring** paid-media/growth roles. Buyers found *by their buying behavior*, not by who's loudest in comment sections.
2. **LinkedIn comment harvesting** (secondary) — mine "comment WORD" posts on validated creators. Useful but skews toward sellers/practitioners; high-volume but low ICP density.

Both feed a single Close CRM build pattern: lead (company) + contact (person) + LinkedIn-connect task due in 3 days, with a structured WHAT/PAIN/OPENER/HOOK briefing in the lead description.

Validated live (2026-06-06): Apollo intent search yielded 71/71 verified emails, 67 Tier-A — compared to comment harvesting's typical ~17% ICP yield. Intent search is now the primary engine.

---

## Key Gotchas (Read First)

**Apollo intent search:**
- **People search is FREE** but returns obfuscated data (`first_name + title + company.name` only — no `name`, no `linkedin_url`, no email). Search to filter, then **enrich** the winners (1 credit each) to reveal full data.
- **Apollo search is the bottleneck, not credits.** Search returns up to 100/page, max 500 pages. `total_entries` tells you the renewable depth.
- **Industry labels in Apollo are often wrong** for tech companies (e.g. a SaaS shows as "financial services" because its product is fintech). Don't auto-cull by industry — read the company.
- **Apollo's "current employment" can show stale roles** (e.g. someone's LinkedIn says "Marathon Runner @ Self-employed" but their verified email is at the real company). Use email-domain as ground truth for current employer when the title looks off.

**Comment harvesting:**
- **Only ~12% of creators actually run the format.** Always validate by scraping recent posts before spending comment-scrape budget. Most "Confirmed comment-X" labels from research turn out to be false positives.
- **Profile-scraper comment counts are INFLATED** (include replies). True top-level count lives in the comment scraper's `totalComments` field on the first page-1 result.
- **Comment harvests yield mostly peers/agencies** — the audience for paid-media creators (Dekker, Blatner) is *other paid-media practitioners*, not in-house SaaS buyers. Expect ~10-17% ICP density after enrichment.
- **Dedupe against master every time.** Different posts have ~0% overlap; same post re-scraped has full overlap. Always normalize URLs before deduping.

**Outreach (both engines):**
- **Email from gtmvp.com goes to spam** (Resend half-wired on subdomain — DKIM + SPF needed on `mail.gtmvp.com`). Use stevekaplan.ai for outreach until fixed.
- **Instagram = no-go.** B2C audience, comments are username-only (no ICP data), cold DM violates rules. Stay on LinkedIn + email.

---

# ENGINE 1: Apollo Intent Search (PRIMARY)

**The principle:** find buyers *by their buying behavior*. A B2B SaaS that just posted a "Head of Growth / Demand Gen / Performance Marketing / Paid Media" role is telling you (a) they're Series A+ with budget, (b) they're scaling paid, (c) there's a gap right now. Multi-thread the founder + the hiring manager.

## The recipe

### Step 1: Run the free people search

```python
# Tool: mcp__5f383f2b-ee19-4177-a581-54b647ff260c__apollo_mixed_people_api_search
# COST: FREE (search returns obfuscated data; enrichment costs credits later)
{
  "person_titles": [
    "Founder", "CEO", "Co-Founder",
    "CMO", "VP Marketing", "Head of Marketing", "Director of Marketing",
    "Head of Growth", "VP Growth",
    "Head of Demand Generation"
  ],
  "person_seniorities": ["founder", "c_suite", "vp", "head", "director"],
  "organization_num_employees_ranges": ["11,50", "51,200"],   # Series A size
  "q_organization_keyword_tags": ["B2B", "SaaS"],
  "q_organization_job_titles": [                              # THE INTENT FILTER
    "Head of Growth", "Demand Generation",
    "Performance Marketing", "Paid Media", "Growth Marketing Manager"
  ],
  "person_locations": ["United States", "United Kingdom", "Canada"],
  "per_page": 100,
  "page": 1
}
```

Result shape: `{ "total_entries": 2066, "people": [...100 obfuscated records...] }`.

`total_entries` is the renewable depth — page 2 = 100 more, page 3 = 100 more, etc.

### Step 2: Parse visible fields, filter to clean ICP

What's visible per record (free tier):
- `first_name`
- `title`
- `organization.name` and `organization.estimated_num_employees` (if present)
- `has_email` (boolean — true means enrichment will return an email)
- `id` (use this to enrich)

What's NOT visible: `last_name` (obfuscated), `name`, `linkedin_url`, `email`, real industry, headline. All require enrichment.

**Filter on visible fields BEFORE spending credits:**
```python
# Keep decision-maker titles (visible field)
DM = ['founder','ceo','co-found','cofound','cmo','chief marketing',
      'vp marketing','head of marketing','head of growth',
      'head of demand','vp growth','director of marketing','demand gen']

# Cull obvious agencies/services/off-ICP by COMPANY NAME signal
AGENCY = ['ppc','seo','web design','digital','agency','outsourcing','recruit',
          'media','creative','ventures','consulting','studios','solutions']
OFFICP = ['health','recruit','outsourcing']
```

Cull aggressively at this stage — every record you enrich costs 1 credit.

### Step 3: Enrich the survivors (1 credit each)

```python
# Tool: mcp__5f383f2b-ee19-4177-a581-54b647ff260c__apollo_people_bulk_match
# Input: array of {"id": "<apollo_id>"} objects, max 10 per call
# COST: 1 credit per match
# Required disclosure:
#   "This will consume N credits. Do you want to proceed?"
```

**Always confirm the credit count with the user before bulk-enriching** unless there's a standing approval (Steve has open license for <100 credits without per-call confirm).

**Apollo enrichment results spill to file** when >10 records. Parse the spill JSON with Python.

### Step 4: Hand-curate before Close

Apollo's auto-industry tags often misclassify B2B SaaS (e.g. a fintech SaaS labeled "financial services," a marketing SaaS labeled "marketing & advertising"). Do **NOT** auto-cull by industry. Manually look at:
- Company name — well-known SaaS? agency-named? recruiter?
- Title — real decision-maker or "advisor / mentor / marathon runner"?
- Employee count — 11-200 is the sweet spot; >2000 = enterprise (different sale)
- Domain — `*.ai`, `*.io`, `*.com` for a tech product usually = legit SaaS

**Off-ICP industries to drop after enrichment**: healthcare/wellness, logistics, construction, recruiting, environmental, real estate, government.

### Step 5: Apollo title quirks — fix before Close

When enrichment returns a "current" employment that looks wrong but the verified email is at the real company, prefer the email-domain:

```python
# Example fixes from past runs:
# Sam Liang showed "Marathon Runner @ Self-employed" but email is sam@otter.ai
# → fix to "CEO & Founder @ Otter.ai"
# Hussam showed a board role but email is halmukhtar@screenmeet.com
# → fix to "Head of Demand Generation @ ScreenMeet"
```

Patch the title/company manually before pushing to Close.

### Why intent search beats comment harvest

| Source | Enriched | Verified email | Tier-A ICP |
|--------|----------|----------------|------------|
| GPT comment harvest (Dekker, 85c) | 60 | ~40 | 1 |
| Master top-63 unenriched | 60 | ~40 | 11 |
| **Apollo intent search** | **71** | **71 (100%)** | **67** |

The intent-search audience is **buyers** (founders/CMOs at SaaS companies hiring paid-media). The comment-harvest audience is **practitioners** (Google Ads freelancers responding to Google Ads creators).

### Renewability

`total_entries` shows the depth. A typical GTMVP intent query (B2B SaaS, 11-200 emp, US/UK/CA, decision-maker titles, hiring paid-media role) yields ~2,000+ matches. Re-run with `page: 2`, `page: 3`, etc. as needed. This is not a one-shot.

---

# ENGINE 2: LinkedIn Comment Harvesting (SECONDARY)

Use when you want fresh names + a warm contextual hook ("saw your X comment on Y's post"). Lower ICP density than intent search but adds a personalization layer.

## The pipeline

### Step 1: Find a post worth harvesting

**Option A — feed a post URL you spotted.**
**Option B — scrape a creator's recent posts** to find their lead-magnet posts:

```python
# Actor: apimaestro/linkedin-profile-posts
# Input: {"username": "<handle>", "limit": 40, "page_number": 1}
```

Detect the format in post text:
```python
import re
def trigger_word(text):
    t = text.lower()
    # comment WORD and I'll send / DM
    m = re.search(r'comment\s+["\']?([a-z0-9]{2,20})["\']?\s+(?:below\s+)?and\s+i.{0,5}(?:ll|will)\s+(?:send|dm|share)', t)
    if m: return m.group(1)
    # just comment WORD
    m = re.search(r'just comment\s+["\']?([a-z0-9]{2,20})["\']', t)
    if m: return m.group(1)
    return None
```

### Step 2: Validate the creator runs the format (before scraping comments)

Scrape the creator's recent 40 posts, regex for trigger word. Watch for false positives:
- Posts *about* commenting strategy ("here's why comment-bait works")
- Self-aware jokes ("comment MINDSET and I'll probably never send it")
- Quotes/mockery of others' lead-magnets

If 0 genuine posts found → drop creator, don't spend comment-scrape budget. **Update `creator_format_validation.csv` so we never re-scrape them.**

### Step 3: Scrape comments (paginated)

```python
# Actor: apimaestro/linkedin-post-comments-replies-engagements-scraper-no-cookies
# Cost: ~$0.005/comment
{
  "postIds": ["<full post URL>"],
  "sortOrder": "most recent",
  "limit": 100,
  "page_number": 1
}
# Keep scraping pages until totalItemCount < 100 on last page
```

### Step 4: Filter, dedupe, score (same as before)

```python
def norm(url):
    return url.lower().replace("https://","").replace("http://","").replace("www.","").rstrip("/").split("?")[0]

# Dedupe vs gtm_commenters.csv master
# ICP-score by headline:
POS_ROLE = [
    (['founder','ceo','co-founder','cofounder'], 3, 'decision-maker'),
    (['cmo','chief marketing','vp marketing','head of marketing','marketing director'], 3, 'marketing-leader'),
    (['head of growth','vp growth','demand gen','head of demand'], 2, 'growth-leader'),
    (['product marketing','pmm','gtm','go-to-market'], 1.5, 'pmm/gtm'),
]
POS_VERTICAL = [(['saas'], 3), (['b2b'], 2), (['series a','series b','startup'], 1.5)]
NEG = [
    (['student','intern','graduate','mba candidate','open to work'], -6),
    (['e-commerce','ecommerce','d2c','shopify','fmcg','consumer'], -3),
    (['link building','ghostwriter','gohighlevel'], -3),
    (['investment bank','real estate','law firm','capital markets','web3','crypto'], -5),
]
```

### Step 5: Enrich the shortlist via Apollo bulk match

```python
# Same Apollo tool as Engine 1, but input is linkedin_url (not id)
{"details": [{"linkedin_url": "https://www.linkedin.com/in/..."}, ...]}
```

### Step 6: Curate

Comment-harvest enrichment typically yields **~10-17% Close-worthy ICP** (lots of agencies/practitioners surface). Don't push the whole batch — hand-pick the in-house B2B SaaS decision-makers.

---

# Close CRM Build Pattern (BOTH ENGINES)

Once you have an enriched, hand-curated list, every ICP target gets the same 3-object Close build.

## STEP 0 (MANDATORY, per Cardinal Rule 6): API-verify every email before push

**No email gets written to Close, Gmail, Resend, Apollo Sequences, or any outreach platform without passing a real-time verification call.** Apollo's `email_status: verified` is NOT enough — re-verify at the moment of push.

```python
# Hunter.io (preferred — Steve has the API key)
# GET https://api.hunter.io/v2/email-verifier?email=<email>&api_key=<HUNTER_API_KEY>
# Read response.data.result: "deliverable" | "undeliverable" | "risky" | "unknown"
# Read response.data.status: "valid" | "invalid" | "accept_all" | "webmail" | "disposable" | "unknown"

# MillionVerifier (fallback)
# GET https://api.millionverifier.com/api/v3/?api=<MV_API_KEY>&email=<email>
# Read response.resultcode: 1=good, 2=catch_all, 3=unknown, 4=invalid, 5=disposable
```

**Routing logic:**

| Verifier result | Action |
|---|---|
| `valid` / `deliverable` | PUSH to Close. Stamp `email_verification_status=valid`, `email_verification_date=YYYY-MM-DD` |
| `accept_all` / `catch_all` | PUSH but tag contact `risky-catchall`. Steve decides per-account |
| `risky` / `unknown` / `webmail` | DO NOT push. Hold in `_pending_verify.csv` |
| `invalid` / `undeliverable` / `disposable` | DROP. Never push to Close at all |

**Bulk:** Hunter bulk endpoint max 500/call; MillionVerifier max 10K/call. Always show Steve the credit cost before any batch over 50. Standing approval under 50.

**If verifier API is down/rate-limited:** hold in `_pending_verify.csv`. Do NOT fall back to pushing unverified. Set a CronCreate + Calendar entry per Cardinal Rule 1 to retry within 24 hours.

**Re-verification:** any contact whose stored verification is older than 90 days must be re-verified before any new send.

## Per-target Close build

### 1. Lead (company)

```python
mcp__ca1f5e7e-4dff-46fc-a72c-35c226c09163__create_lead(
  name="<Company>",
  status_id="stat_jr7WFCZgfSf9lTln8xM4cBiJ673wiEFjLIt3c3Wun2o",  # Potential
  url="<website>",
  description=BRIEFING  # WHAT/PAIN/OPENER/HOOK template below
)
```

### 2. Contact (person on that lead)

```python
mcp__ca1f5e7e-4dff-46fc-a72c-35c226c09163__create_contact(
  lead_id=<lead_id from step 1>,
  name="<Full Name>",
  title="<Title>",
  emails=[{"type": "office", "email": "<verified email>"}],
  urls=[{"type": "url", "url": "<LinkedIn URL>"}]
)
```

### 3. LinkedIn-connect task

```python
mcp__ca1f5e7e-4dff-46fc-a72c-35c226c09163__create_task(
  lead_id=<lead_id>,
  contact_id=<contact_id>,
  text="<task text — see template>",
  due_date="<today+3 days>",
  send_notification=False
)
```

### Multi-threaded accounts

When the enrichment surfaces multiple people at the same company (founder + head of demand gen), **create ONE lead + N contacts on it**, not N separate leads. Each contact gets its own task. Note "Multi-threaded account: X + Y on this lead" in the briefing.

## Lead briefing template (WHAT/PAIN/OPENER/HOOK)

```
WHAT: B2B SaaS — <industry>, ~<emp> employees, ~<revenue> revenue. Series A/scale-up stage.

PAIN: <Role-aware pain. Founder/CEO if leader is founder; Marketing leader if demand-gen/growth head.>

OPENER: <One-sentence opening conversation. References the hook signal (intent: "saw you're hiring for X" / comment: "saw your X comment on Y's post").>

HOOK: <The relevance angle + the Leak Report offer. Closes with SOURCE: <intent search or commenter source>, <date>. Verified email.>
```

**Two PAIN variants by role:**

```python
def is_founder(title):
    return any(k in title.lower() for k in ['founder','ceo','chief executive'])

FOUNDER_PAIN = ("Founder/CEO at a Series-A-stage B2B SaaS that's actively hiring for paid media/growth — "
                "which means they're about to pour budget into Google/LinkedIn. Classic pain: scaling paid "
                "before the account structure and tracking are right, so early spend underperforms and CAC creeps.")

FOUNDER_HOOK = ("Founder hiring a paid-media/growth role RIGHT NOW = in-market. The Leak Report gives an "
                "independent 22-dimension read before they scale spend behind a new hire.")

LEADER_PAIN = ("Marketing/demand-gen leader at a B2B SaaS scaling paid — the company is actively hiring more "
               "paid-media headcount, so budget is growing. Pain: proving paid drives qualified pipeline (not "
               "just MQLs) and finding structural waste before scaling.")

LEADER_HOOK = ("Owns paid media at a B2B SaaS that's hiring MORE paid headcount = budget expanding now. "
               "The Leak Report is an independent 22-dimension audit of Google + LinkedIn spend.")
```

## Task text template

```
LinkedIn connect + email <Name> (<Title>, <Company>). In-market signal: <Company> is hiring for paid media / growth.
Connect note refs them scaling paid; email Leak Report from stevekaplan.ai. Verified email: <email>.
```

## Status ID

Potential = `stat_jr7WFCZgfSf9lTln8xM4cBiJ673wiEFjLIt3c3Wun2o` (this is the Close lead status ID for "Potential")

## Bulk-build execution

For batches of 40+ targets, **inline parallel batches of ~10** work reliably. Workflow-based fan-out has failed in practice (subagents got stuck on schema enforcement). Pattern that works:

0. **Pre-step (mandatory):** verify ALL emails via Hunter/MillionVerifier first. Drop `invalid`, hold `risky`/`unknown` in `_pending_verify.csv`, tag `accept_all` as `risky-catchall`. Only `valid` records proceed to step 1.
1. Round 1: create 10 leads in parallel → save IDs to `_lead_ids.json`
2. Round 2: create next 10 leads → append to `_lead_ids.json`
3. ... repeat until all leads created
4. Then: create contacts in batches of 10, save to `_contact_ids.json` — **only verified emails attached**
5. Then: create tasks in batches of 10

**Always persist IDs to a JSON file on disk** after each batch so a fresh session can pick up where you left off.

---

## Outreach Channel Priority (both engines feed this)

1. **LinkedIn** (manual, ~15-20/day) — native channel, warm, no deliverability risk. Connect note under 280 chars.
2. **Email from stevekaplan.ai** — healthy domain (Resend fully wired), plain text, no link in first touch.
3. **Email from gtmvp.com** — DO NOT use until Resend on `mail.gtmvp.com` is fully provisioned (DKIM + SPF needed).
4. **Cold call** — only for top whales (founders with real ad spend); Apollo direct-dial credits may be depleted.
5. **Instagram** — NO-GO (B2C audience, no ICP data in comments, cold DM against rules).

## Connect note templates

**Intent-search variant:**
```
Hi <First> — noticed <Company> is scaling paid media. I build paid-media systems for B2B SaaS
(audit + buildout). Happy to send a free 22-point Leak Report on your Google/LinkedIn setup if useful.
```

**Comment-harvest variant:**
```
Hi <First>, saw your <TRIGGER> comment on <CREATOR>'s post. I built the paid-media version: a free
leak report on your Google Ads. Want me to send it?
```

**Peer/agency variant** (when they sell what you sell — don't pitch, compare notes):
```
Hi <Name>, saw your <TRIGGER> comment on <CREATOR>'s post. I built paid-media tooling too ($50M+ managed).
Curious how you're using <AI/tool> at <Company>. Happy to compare notes.
```

---

## Files to Maintain

```
gtmvp-leads/                              ← permanent folder (not in a worktree)
  # MASTER DATA
  gtm_commenters.csv                      ← master dedup list (all comment-harvest sources)
  combined_outreach_master.csv            ← Apollo lookalike export + commenter targets

  # CREATOR VALIDATION (comment-harvest engine)
  creators_all.csv                        ← all creators + format-confirmed status
  creator_seed_list.csv                   ← original ranked seed
  creator_format_validation.csv           ← empirical YES/NO on who runs comment-X

  # ENRICHED OUTPUTS
  gtm_enriched_shortlist.csv              ← historical commenter enrichment
  _enriched_63_results.csv                ← per-batch Apollo enrichment output
  _intent_enriched_results.csv            ← intent-search Apollo enrichment output

  # CLOSE BUILD STAGING
  _close_chains.json                      ← per-company { lead, [people] } chains
  _close_payloads.json                    ← flat list of lead+contact+task payloads
  _lead_ids.json                          ← persisted lead IDs after each batch
  _contact_ids.json                       ← persisted contact IDs after each batch

  # MANUAL WORKLIST
  linkedin_manual_worklist.csv            ← ready-to-paste connect notes

  # INDEX
  INDEX.md                                ← map of everything, updated per session
```

Keep master in a **permanent folder** (not inside a git worktree — worktrees get cleaned up).

---

## Actors + Tools Reference

| Tool | Actor/ID | Cost | Use |
|---|---|---|---|
| **Apollo intent people search** | `apollo_mixed_people_api_search` | **FREE** | Find decision-makers by hiring intent (PRIMARY engine) |
| **Apollo bulk enrich** | `apollo_people_bulk_match` | 1 credit/match | Reveal email/LinkedIn/full data on intent-search winners or comment-harvest shortlists |
| Scrape creator posts | `apimaestro/linkedin-profile-posts` | ~free | Find lead-magnet posts (comment-harvest engine) |
| Scrape post comments | `apimaestro/linkedin-post-comments-replies-engagements-scraper-no-cookies` | ~$0.005/comment | Harvest commenters |
| Close lead | `mcp__ca1f5e7e-...__create_lead` | free | Create company lead with briefing |
| Close contact | `mcp__ca1f5e7e-...__create_contact` | free | Attach person to lead |
| Close task | `mcp__ca1f5e7e-...__create_task` | free | LinkedIn-connect reminder due in 3 days |
| Gmail draft (fallback only) | `mcp__6aa1ae96-...__create_draft` | free | Email drafts if not using Close-managed cadence |

---

## Creator Findings (Empirically Validated)

### Comment-X format — confirmed YES (harvest these)
- `outboundphd` (Eric Nowoslawski) — GTM/Clay/outbound. 428c "your favorite restaurant" post. **GTM/marketing-ops SaaS audience.**
- `adriaan-dekker-google-ads-freelancer-rotterdam` — Google Ads. 119c "Script/Pmax" post, 85c "GPT" post. **Audience = Google Ads practitioners (peers, not buyers).** Use sparingly.
- `dianewiredu` — Messaging/copy. 34c "drop a comment". P3, low volume.
- `devinreed` — Content/LinkedIn growth. 8c "Guide". P3, very low volume.

### Comment-X format — confirmed NO (do NOT re-scrape)
False positives validated 2026-06-06: **Adam Robinson** (`retentionadam`) and **Tommy Clark** (`tclarkmedia`) were seeded as TOP6 "Confirmed" but 40-post audits show no keyword-gate format — they use engagement-bait ("drop in the comments") and waitlist links, not comment-X.

Other validated NO: Pierre Herubel, Dave Gerhardt, Gaetano DiNardi, AJ Wilcox, Anthony Blatner (despite earlier seeding), Katelyn Bourgoin (reshares only), Aakash Gupta (wrong-profile resolution), Silvio Perez, Justin Rowe, Tas Bober (criticizes comment-gating), Sam Kuehnle, Ashley Lewin, Kyle Poyar, Anthony Pierri, Emily Kramer, Daniel Murray, Jordan Crawford, Matteo Tittarelli, Vivek Goel, Kevin Hjorslev, Liam Moroney, Brendan Hufford, Barry Hott, Brett McHale, Kyle Coleman, Natalie Marcotullio, Ross Simmonds, Miles McNair, Justin Welsh, Amanda Natividad, Maja Voje, Peep Laja, Bob Meijer, Chris Walker (pivoted out of B2B), Thibaut Souyris (pivoted out of B2B). Update `creator_format_validation.csv` whenever a new false positive is confirmed.

### Audience-quality lesson

Even validated comment-X creators have audiences skewed by their content:
- **Eric Nowoslawski** → GTM engineers / Clay users / outbound ops. Good for Steve.
- **Adriaan Dekker** → Google Ads freelancers / agency practitioners. Off-ICP for Steve (peers, not buyers).
- **Diane Wiredu / Devin Reed** → adjacent fits (messaging, content). Low volume.

**This is why intent search beats comment harvest.** Intent search finds buyers regardless of what creator they follow.

---

## Decision flowchart

```
Need more ICP pipeline?
├─ Want fresh, high-density buyer pool? → Engine 1: Apollo intent search
│   └─ Re-run with page+1 to mine the next 100 (renewable to ~2000+)
└─ Want personalization layer + warm hook? → Engine 2: Comment harvest
    ├─ Validated creator with fresh trigger post? → scrape comments, enrich top scorers
    └─ No fresh trigger post on validated creators? → SKIP, just use intent search
```

When in doubt: **intent search.** It's free to query, 6× higher yield after enrichment, and the depth is renewable across multiple pages.
