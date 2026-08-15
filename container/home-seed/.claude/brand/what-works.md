# What Works

> A living log of what Steve's audience actually responds to. **Append, don't rewrite.**
> This file gets read before brainstorming new content and updated after every meaningful publish.

## How to use this file

**Before drafting a new piece:**
1. Skim "Proven hooks," "Proven angles," and "Proven formats" for patterns to reuse.
2. Check "Recent wins" for fresh templates.
3. Check "Recent flops" to avoid repeating mistakes.

**After publishing:**
1. Wait for the piece to settle (24–72h depending on platform).
2. Append a new entry under "Log" with: date, platform, link, format, hook, headline metric, takeaway.
3. If the piece overperformed or underperformed by a clear margin, also update the relevant pattern section.

**Definition of "worked":**
- LinkedIn: *[set your bar — e.g. "200+ reactions OR a high-quality DM"]*
- TikTok: *[set your bar — e.g. "10k+ views in 24h OR strong save/share ratio"]*
- YouTube: *[set your bar — e.g. "CTR > 5% AND retention > 40%"]*
- X: *[set your bar]*
- Newsletter: *[set your bar — e.g. "open rate > X%, click rate > Y%"]*

## Proven hooks

> First lines / opening seconds that consistently pull people in. Add the verbatim hook + why it worked.

- *[hook + why]*
- *[hook + why]*

## Proven angles

> Topical or rhetorical frames that resonate.

- *[angle — e.g. "Behind-the-scenes of a real build, with the numbers"]*
- *[angle — e.g. "Contrarian take on a trending tool, backed by what you actually shipped"]*
- *[angle]*

## Proven formats

> Structures that perform.

- *[format — e.g. "LinkedIn: 1-line hook → 3-line context → bullets → 1-line close"]*
- *[format — e.g. "TikTok: pattern interrupt + hook in first 1.5s, payoff at 8s, CTA at end"]*
- *[format]*

## Recent wins

> The 5 most recent pieces that performed. Drop the oldest as new ones come in.

| Date | Platform | Link | Why it worked |
|---|---|---|---|
| | | | |

## Recent flops

> Pieces that underperformed *and* you understood why. Useful for avoiding the same trap.

| Date | Platform | Link | What went wrong |
|---|---|---|---|
| | | | |

## Themes that resonate

> Topic clusters where Steve's audience consistently shows up.

- *[theme]*
- *[theme]*

## Themes that don't (yet)

> Topics that haven't landed — could be wrong audience, wrong angle, or just early. Note the hypothesis.

- *[theme + hypothesis]*

## Log

> Chronological append-only record. **Most recent entries on top.**

### Template (copy this for each new entry)

```
### YYYY-MM-DD — [Platform] — [1-line description]
- Link: [URL]
- Format: [post / video / thread / newsletter]
- Hook: "[verbatim first line or first 2 sec]"
- Metric: [X views / Y reactions / Z replies / N% open rate]
- Performed: [above bar / at bar / below bar]
- Takeaway: [1 sentence — what would you reuse, what would you change]
```

---

## Content idea bank — sharp hot takes (added 2026-06-04)

> Stored as raw material for posts, scripts, hooks. Each one is a contrarian fact most of the ICP doesn't know. Pull directly into LinkedIn one-liners, YouTube Short hooks, blog intros.

### GTM / ABM / Attribution — 10 things most people don't know

1. **Most attribution is storytelling, not math.** Last-click, first-click, linear are arbitrary rules. MMM and incrementality tests are the only real measurement; everything else is bookkeeping.
2. **ABM doesn't beat demand gen — it hides the demand gen that's actually working.** Most ABM wins trace to a brand campaign or content piece that warmed the account months earlier. ABM gets the last-touch credit.
3. **"Influenced pipeline" is the most-abused metric in B2B.** If 10 channels each "influenced" a deal, the sum exceeds 100% of pipeline. Nobody catches it because nobody ties it back to a single deal.
4. **Smart Bidding doesn't optimize for revenue. It optimizes for whatever you told it was a conversion.** B2B accounts with form-fill as the primary conversion buy tons of useless form fills. Algorithm working perfectly, on the wrong target.
5. **Only 5% of an ABM target list is in-market at any time.** 500-account list = ~25 buying anything this quarter, maybe 3 buying you. Budgets get spread across 100% of the list; the converters were already going to.
6. **Sales cycles destroy attribution windows.** Google Ads defaults to 30-day attribution; B2B SaaS cycles average 84 days. Google literally cannot see most of your conversions. ROAS report is wrong by design.
7. **First-touch makes content look heroic. Last-click makes paid search look broken.** Same data, opposite conclusions. The metric you pick decides who gets the budget — before any analysis happens.
8. **The biggest GTM lie is "we are product-led."** Most "PLG" companies have sales-assisted motions doing the actual revenue work. Anything over $10K ACV is almost never truly PLG.
9. **CAC payback is more honest than LTV:CAC.** LTV is a forecast with compounding errors. Payback is a fact you can read off the books in 12 months. Healthy: <18 months. Most Series A's quietly run 30+.
10. **Closed-lost carries the highest-value attribution signal — and nobody uses it.** Why a deal didn't close tells you which channel sends wrong-fit traffic. Feeding CRM Closed-Lost reasons back to ad platforms as negative signal would fix half of paid-media waste.

### ML / LLMs — 10 concepts with simple illustrations

1. **Tokens are the unit, not words.** LLM doesn't see "strawberry," it sees `["straw", "berry"]`. That's why it miscounts the letter "r" — it never sees individual letters. *Picture:* Lego studs aren't atoms.
2. **Embeddings turn meaning into geometry.** Every token becomes a point in high-dim space; similar meanings cluster. "King" - "man" + "woman" ≈ "queen." *Picture:* a star map where Italy and Rome sit close.
3. **Attention is "what should I look at right now?"** When predicting the next word, the model weighs each previous word. "The cat sat on the ___" leans on "cat" and "on," ignores "the." *Picture:* a spotlight sweeping back across the sentence.
4. **Next-token prediction is the entire job.** Everything — reasoning, code, conversation — emerges from doing one task at superhuman scale. *Picture:* autocomplete on steroids.
5. **Context window = short-term memory.** Everything inside influences the prediction; everything outside is forgotten. No persistent memory between conversations unless something writes it back in. *Picture:* a whiteboard.
6. **Pretraining → fine-tuning → RLHF.** Pretrain: read the internet, learn language. Fine-tune: teach it to follow instructions. RLHF: humans rate, model learns preferences. *Picture:* baby → school → manners class.
7. **Temperature controls randomness.** Temp=0 always picks the top guess; temp=1 samples the distribution. Higher = more creative and more unhinged. *Picture:* a dial.
8. **Transformers process the whole input in parallel.** Older RNNs read one word at a time; transformers look at everything at once. That's why ChatGPT is fast, and why context windows have a hard ceiling (quadratic compute). *Picture:* glancing at a whole page instead of finger-tracing word by word.
9. **Hallucination is architectural, not a bug.** The model predicts plausible next tokens. Plausible-sounding fiction is mathematically identical to plausible-sounding fact without grounding. RAG fixes it by handing real source text. *Picture:* a smooth talker at a party the room can't fact-check.
10. **Mixture of Experts (MoE) routes each token to specialists.** Big models (GPT-4, Claude, Mixtral) are a router plus expert sub-networks. Each token goes to the 2-4 most relevant experts. *Picture:* hospital triage routing each patient to the right specialist.

---

*[entries below as content ships]*
