---
name: project-click-then-convert
description: Rebuilding the closed Click Then Convert agency website from a Figma export for the domain (resume credential)
metadata: 
  node_type: memory
  type: project
  review_after: 2026-06-20
  originSessionId: 97c6e705-c8ff-4ab8-bf0d-1f9e4d92cd6e
---

**Click Then Convert** = Steve's performance marketing agency, **2015–2024 (now closed)**. Director of Performance Marketing. $50M+ cumulative ad spend, 100+ clients, 3.2x avg portfolio ROAS, 40% avg CPA reduction on rebuilds. It's a line on Steve's resume + Google Business Profile says "permanently closed." Steve wants SOMETHING credible on the domain (he owns it) so the resume link isn't a dead end.

**Source of truth:** Full Figma site export (225 files) at `C:\Users\User\Downloads\Website - Click Then Convert.zip`, extracted to `C:\Users\User\Projects\click-then-convert\_export\`. Also a `.fig` at `C:\Users\User\Downloads\Website - Click Then Convert.fig` (binary, hard to parse — use the zip export instead). Real assets copied to `Projects\click-then-convert\assets\`.

**Brand palette (ground truth, sampled from renders):** navy `#23335D` / `#153358`, sky blue `#66A0D6`, light blue `#A2CAEC`, coral CTA `#F15F5C`, slate gray `#A1ADBC`, off-whites. Logo = blue circular "click" arc + coral "C" center, wordmark "Click Then Convert" in cool gray (`assets/logo.svg`). Signature decoration = scattered circles/arcs/dots.

**Site structure:** Nav = logo · ABOUT US · WHAT WE DO · CASE STUDIES · BLOG · [GET PROPOSAL coral-outline btn] · phone. Pages in export: Home (`index.png`), About (`about_d.png`), Blog + blog-inner, Case Studies hub (`Casestudy_main_d.png`) + 3 individual (Easy Treezy, Iron Neck, uCars), Landing, 4-step Proposal flow. Home hero: "We converted $12 million into $60 million for our clients last year." Team: **Steve Kaplan (Founder), Ryon Harms (Strategic Advisor), Michael Nelson (Account Manager)**. Case study results: BARK BOX 252% conv, Iron Neck 300% conv rate, uCars.

**SCOPE DECISION (2026-06-06):** Recreate **Home + About + Case Studies hub + 3 individual case studies**. Treatment = **faithful copy + subtle closed note** (banner/footer: "CTC wound down 2024, founder now builds GTMVP"); dead CTAs (GET PROPOSAL etc.) → point to gtmvp.com / stevekaplan.ai instead of broken forms.

**Build:** static HTML (no framework), real exported assets, fully responsive. Output in `C:\Users\User\Projects\click-then-convert\`.

**STATUS (2026-06-06): BUILD COMPLETE + VERIFIED.** 7 pages: index, about, case-studies, case-barkbox, case-ironneck, case-ucars, case-easytreezy + 404.html. Shared `styles.css` (Poppins, brand palette). 56 real Figma assets in `assets/`. README + .gitignore done. Verified: Home/About/Iron-Neck render pixel-faithful in browser; all 7 pages + assets return HTTP 200; exact verbatim copy confirmed on every page. CTAs point to gtmvp.com (agency closed). Closed banner + "2015–2024" footer on every page. Verbatim quirks preserved ("Meet out team", "All rights Reserved.").

**BUG FIXES (2026-06-06, post-review):** Steve flagged Iron Neck hero rendered broken — root cause: used full-page render `CaseStudy_*.png` (1440x3513) as hero bg, squished by object-fit:cover. FIXED: all case study heroes + how-we-did-it photos now use `case_study_*_top.png` (1440x350 real hero strips). Removed orphan full-page renders. Also removed phone number `(800) 390-8350` from nav on all pages per Steve. Iron Neck re-verified rendering correctly in browser.

**DEPLOY PATH:**
1. **GitHub repo — ✅ DONE (2026-06-06).** Live PUBLIC repo: https://github.com/Stevekaplanai/click-then-convert (default branch `main`, gh acct Stevekaplanai). Note: raw `git push` needs `dangerouslyDisableSandbox` (sandbox blocks DNS to github.com); `gh` API works in sandbox.
2. **Vercel — NOT DONE (Steve does in dashboard).** New project from the GitHub repo. Framework preset = **Other**, NO build command, output/root = repo root. It just serves static files. Add the custom domain in Vercel project settings.
3. **DNS — NOT DONE (Steve does at registrar).** Steve owns the domain. Repoint per Vercel's domain instructions: apex → A record `76.76.21.21` (or Vercel's current), `www` → CNAME `cname.vercel-dns.com`. Vercel shows exact values when the domain is added.
Related: [[feedback_full_urls]].
