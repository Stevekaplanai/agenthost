---
name: attribyte_homepage_video
description: "Attribyte marketing homepage final state (demo video in hero, HeroTour in a section, chart fix) + the Tailwind JIT keyframes gotcha"
metadata: 
  node_type: memory
  type: project
  originSessionId: a902c679-d176-45f5-891c-65096f2e633d
---

LIVE on attribyte.xyz (PR #143 squash-merged 2026-06-02): the marketing hero (`apps/marketing/src/pages/home/HomeHero.tsx`) leads with the demo video autoplaying muted/looping **inline** (the GTMVP hero pattern — a `HeroVideo` helper in a browser-chrome frame; `/attribyte-demo.mp4` + `/attribyte-demo-poster.jpg` in `apps/marketing/public/`). The custom `HeroTour` scene-graph animation moved DOWN to the "See AttriByte in action" `DemoSection` in `apps/marketing/src/pages/HomePage.tsx`. Source video was built by the `attribyte-engine-video` Workflow from 2 product GIFs + Eric ElevenLabs VO (voice id `cjVigY5qzO86Huf0OWal`) + fal-ai music; assets/pipeline in `Downloads\attribyte-engine-video`. Steve iterated hero→section→hero: he wants the video IN the hero, playing inline, never forcing fullscreen.

**Learned pattern — Tailwind JIT never emits unreferenced `@keyframes`:** an element animated via `animation: fade-in ... forwards` (from opacity 0) renders BLANK if the `fade-in` keyframes are declared only in `tailwind.config.js` and no `animate-fade-in` utility is used anywhere — Tailwind's JIT only emits keyframes for `animate-*` utilities it sees in scanned content, so the animation points at an undefined keyframe, `forwards` never applies, and the element stays at the from-state (invisible). This made the marketing `DashboardMock` AreaChart (`apps/marketing/src/components/dashboard/charts.tsx`) look empty. Fix: declare the `@keyframes` inline in the component (`<style>{'@keyframes fade-in{from{opacity:0}to{opacity:.92}}'}</style>`), or reference the `animate-*` utility so JIT emits it. [[gtmvp_homepage_engine_video]]
