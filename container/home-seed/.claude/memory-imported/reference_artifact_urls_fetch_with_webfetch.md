---
name: reference-artifact-urls-fetch-with-webfetch
description: "claude.ai artifact URLs ARE readable — use WebFetch (not curl), and Artifact action:\"list\" to find the URL"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 51953092-34e5-43d4-b152-6c38d1bfa3ec
  modified: 2026-07-26T04:04:59.468Z
---

A `https://claude.ai/code/artifact/{uuid}` URL can be read in full with the
**WebFetch** tool, which authenticates as Steve via his claude.ai login. It
returns the complete page source, including designs embedded as a `MOCKUP_HTML`
JS string assigned to an `iframe.srcdoc`.

**curl does NOT work** on these URLs — it gets the single-page-app loader shell
or a Cloudflare 403. That symptom reads as *"the artifact is only a loader
page"* or *"served to you as a public (non-member) reader"*, which is easy to
misdiagnose as "this artifact is unfetchable."

Use `Artifact` with `action: "list"` to find an artifact's URL when you only
know roughly what it was called.

**Why this is worth remembering:** on 2026-07-26 two full AgentHost sessions
were spent rebuilding the Command Center from a prose transcription because a
prior session concluded the design artifact could not be fetched. It always
could. Before recording "X can't be fetched," check whether the right tool for
that surface was ever tried.

Related: [[project-agenthost-command-center-design]]
