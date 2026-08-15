---
name: github-profile-readme
description: GitHub profile repo structure + the rebuilt Brand-Bold README (live 2026-05-31)
metadata: 
  node_type: memory
  type: project
  originSessionId: 63b3383e-0f4a-4d69-8fb4-7295a7b10d4a
---

`github.com/stevekaplanai/stevekaplanai` (canonical owner casing is **Stevekaplanai**; lowercase URLs still resolve) is NOT a plain README repo — it is a full **Next.js app** with `README.md` at the root. That root README is what renders on the GitHub profile. Hosted SVGs live in an `assets/` folder, referenced from the README via `https://raw.githubusercontent.com/stevekaplanai/stevekaplanai/main/assets/...` (returns `image/svg+xml`, served through GitHub's camo proxy).

Rebuilt 2026-05-31 ("Brand-Bold" direction, commit fd2ab86):
- GTMVP is the **hero** — free-audit CTA → https://www.gtmvp.com/smart-bidding-audit, plus the $129 Diagnostic / Rebuild ladder.
- Corrected proof numbers: **3.2x** avg ROAS, **100+** clients, Click Then Convert **2015–2024**.
- Removed the former-employer name and the stale "Director of Marketing" / "by day, by night" framing; reframed as **full-time solo operator & builder**.
- **Pure solo-builder**, no "open to work" signal — consistent with the LinkedIn strategic hold ([[project_job_search]]).

Design carriers: two hand-authored SVGs — `assets/header.svg` (signature banner) + `assets/gtmvp.svg` (flagship card). GitHub strips CSS/JS from READMEs, so all real design lives in those SVGs; the rest is GitHub-safe tables + a cohesive dark+amber badge system.

Working copy: `C:\Users\User\github-readme\` (README.md, assets/, final-preview.html). Cloned repo for pushes: `C:\Users\User\sk-profile-repo`. To edit the profile again, edit there and push to `main`. Honors [[feedback_full_urls]] and [[reference_proof_roas]].
