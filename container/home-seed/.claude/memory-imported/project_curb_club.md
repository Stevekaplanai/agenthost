---
name: project-curb-club
description: "Curb Club — premium bin-cleaning membership (Fort Lauderdale 33308); site live, $50k pitch to Noel Kellert + partner Mon 2026-07-06"
metadata: 
  node_type: memory
  type: project
  review_after: 2026-07-07
  originSessionId: 7ff346a9-6e94-4c13-bb03-a216de54af3b
---

**Curb Club** — premium residential trash-bin-cleaning MEMBERSHIP club, ZIP 33308 (Coral Ridge, Imperial Point, Bermuda Riviera). Country-club brand: hunter green #1F3A2F / ivory #F5EDE0 / gold #C4A572, Fraunces + Inter + JetBrains Mono, "members not customers," never "trash/garbage" in visible copy, never lead with price. Tiers: Standard $34/mo · Estate $54/mo · Founders $329/yr · $1 initiation.

**Website (built + deployed 2026-07-02):**
- Code: `C:\Users\User\Projects\curbclub` · repo https://github.com/Stevekaplanai/curbclub · Vercel project gtmvp/curbclub
- LIVE: https://curbclub.vercel.app — **the canonical URL for now.** Steve deliberately deferred the curbclub.net DNS repoint (2026-07-02, "don't feel like messing with DNS right now") — don't nag; when he's ready: A @ → 76.76.21.21, CNAME www → cname.vercel-dns.com at Namecheap, or whitelist IP 99.10.184.5 in Namecheap API settings and Claude can do it
- Zip-expansion SEO architecture: add a ZIP to `data/zips.ts` → page/sitemap/footer/form auto-generate. FAQPage JSON-LD on every page.
- Invitation form → FormSubmit → steve@stevekaplan.ai. **One-time activation click required** (email sent 2026-07-02); until clicked, submissions are lost.

**Monday 2026-07-06 pitch — $50k or $100k from Noel Kellert + Pete** (ex-NJA top closers, "starving to close," money to invest; Noel is 57, Steve worked with him at NJA):
- Notion pitch pack (refactored 2026-07-02 per Steve — "say less, answer the 4 investor questions, 2 scenarios side by side, TOC + linked pages"): HQ hub https://app.notion.com/p/36641202dff6817ca16fc755b634cbf3 → 📊 The Deal https://app.notion.com/p/39241202dff681fd91b9f64274961a95 → 🗺️ The Plan https://app.notion.com/p/39241202dff68188b391ec955ded4e6c → 🎯 The Market https://app.notion.com/p/39241202dff6812498c0f5896c72bcda → 🎨 Brand https://app.notion.com/p/39241202dff681999195ef6044e13bd9
- **Two scenarios only:** $50k "own the ZIP" (breakeven M6–7, ~$250–300k run-rate M12) / $100k "own the corridor" ($50k plan + rig #2 + 3-ZIP marketing velocity; breakeven M5–6, ~$400–480k). $25k self-funded path RETIRED. $20k = one-line stress note only.
- **The owner scenario is the centerpiece:** 3 owners + 1 tech = profitable all-in Month 6 (January 2027) — exactly when moving booking season opens; reps then pivot phone hours to the moving venture. Phone-first sales motion (assoc boards, property managers, realtors, <15-min inbound callbacks); commissions $60/$90/$110 + $2/mo residual.
- ⚠️ Refactor incident: old Finance/90-Day/Diligence/Brand pages went to Notion TRASH (replace_content on HQ deleted children referenced only by markdown links — always use <page> embeds for children). Recreated fresh; trash copies safe to purge. ARPU fix + §27-193 fix are baked into the new pages.
- **Demo video rendered + ON THE SITE HERO:** C:\Users\User\Projects\videos\curbclub-promo\renders\video.mp4 (52s "Join the Club" brand film; Steve approved, then requested quieter mix — BGM ducked 0.8→0.15, SFX 0.35→0.15 in index.html data-volume attrs, re-rendered 2026-07-03). Live on homepage hero at https://curbclub.vercel.app (public/media/curb-club-film.mp4 + film-poster.jpg, gold-framed video card). Video project: C:\Users\User\Projects\videos\curbclub-promo (HyperFrames; edit STORYBOARD.md/frames + re-render to iterate). Vercel has curbclub.net ALIASED to the project already — the moment DNS is pointed at Namecheap, the domain just works.

**Moving-business context (Noel's deal):** 75/25 split with a moving company, ~$6k avg job, wanted Steve at ~$1,600 CPA. Research verdict: July = booking-season tail (leads convert Sept–Oct = 9%/7% of annual volume); $1,600 CPA is 2.5–4x the $114–600 industry benchmark; next full-season window **Jan–Mar 2027**. Pitch line: moving in January, Curb Club today.

- **Pitch deck (2026-07-03):** 11-slide PowerPoint recommending the \$100k program, brand-styled (green/ivory/gold, Century Schoolbook/Calibri/Courier New), speaker notes on every slide. Source + generator: `C:\Users\User\Projects\curbclub-pitch\` (gen-deck.cjs — edit + `node gen-deck.cjs` to iterate). File: `C:\Users\User\Projects\curbclub-pitch\Curb-Club-Partner-Deck.pptx`. Hosted at unguessable URL https://curbclub.vercel.app/deck/curb-club-partner-brief-k7m3x9.pptx (robots-disallowed), linked in a callout at the very top of Curb Club HQ in Notion. Deck includes equipment-financing slide (rigs \$28–43k new / \$10–18k used, financeable ~\$500–900/mo, maintenance in opex — "the trucks never eat the raise").
- FormSubmit bug found+fixed 2026-07-03: origin-less server requests silently rejected inside HTTP 200; action now sends Origin/Referer + checks body.success. Activation email re-sent — Steve must click "Activate Form" from formsubmit.co email.

Related: [[user-profile]]. Reminders set: calendar event Sun 2026-07-05 10:00 ET + scheduled task `curbclub-pre-pitch-check` (Sun 09:00).
