---
name: workflow-schema-structuredoutput-flaky
description: Workflow agent() with schema often fails the StructuredOutput call and aborts the run — omit schema for file-edit tasks
metadata: 
  node_type: memory
  type: reference
  originSessionId: 44ef6abf-388b-4d60-b4e2-30d2771464b0
---

The `Workflow` tool's `agent({schema})` frequently fails with "subagent completed without calling StructuredOutput (after 2 in-conversation nudges)" — EVEN WHEN the agent did the real work. Observed twice on 2026-05-30: the GTMVP/site analysis run (3 of 5 map agents failed) and the stevekaplan.ai rebuild run (7 of 8 build agents failed). Happens on both Opus and Sonnet, so it is NOT model-specific. One failed schema call can abort the whole workflow.

**Key fact:** the agent's file edits PERSIST even when the schema call fails. After a "failed" run, check actual file state (mtimes, grep) before re-running — most of the work is usually done.

**How to apply:**
- For FILE-EDITING workflows, do NOT use schema. The agent's value is the side effect. Have the composer/downstream agent Read the files directly to discover exports/results.
- For DATA-RETURN workflows, keep schemas small and flat, always `.filter(Boolean)` results, and tolerate partial failure. Consider returning plain text and parsing it yourself.
- When a workflow keeps failing on this, finish the remaining work directly (inline edits) rather than re-fighting the schema layer. That is what unblocked the site rebuild. Related: [[autonomous-brain-edits]].

**Throttle MCP-calling workflow agents.** 2026-05-30: a workflow with 20 parallel agents each calling a claude.ai MCP tool (Blotato `update_schedule`) got 16/20 rate-limited ("Server is temporarily limiting requests, not your usage limit"). Re-running the remaining in batches of 3-4 (loop over chunks with `await parallel(batch...)` between) succeeded 16/16, then 5/5. Lesson: when workflow agents call MCP/external APIs, cap concurrency to ~3-4 per batch, not the default ~14. Also: agents doing minimal-diff edits only fix what you flag, so scan comprehensively first (a non-ASCII char census catches every glyph tell: em/en dash, arrow, curly quote, x-multiply, not-equal in one pass).
