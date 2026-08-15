---
name: toolsearch-on-demand
description: "Load deferred tool schemas only when actually needed, not preemptively"
metadata: 
  node_type: memory
  type: feedback
  priority: high
  savedDate: 2026-06-06
  originSessionId: 854ba2db-b1b4-4b60-9525-bc41b956162f
---

# ToolSearch: On-Demand Only

**Rule:** Load deferred tool schemas (from MCP servers) ONLY when the task explicitly needs them. Stop preemptive/defensive ToolSearch calls.

**Why:** Every ToolSearch query—even when the tool isn't needed—loads 400+ deferred tool definitions into context (schemas, descriptions, usage notes). This adds 5-8K tokens per session even when the tools go unused. The session reminders already list what's available; there's no need to load their full schemas until called.

**How to apply:**

- **If the task names a tool or data source,** use ToolSearch: `"select:mcp__apollo__*"` or `"web-search"` or `"supabase"`.
- **If the task is ambiguous or you're not sure which MCP is needed,** use a focused keyword search: `"apollo contacts"` or `"calendar meeting"`.
- **If you're about to do something routine** (code edit, file read, basic question), don't load tools preemptively. Tools appear in the deferred list—check there if you need them.
- **When in doubt, read the deferred list in the system reminder.** It tells you what's available; you don't need the full schema until you're about to invoke it.

**Verification:** Before calling ToolSearch, ask: "Would this task actually call a tool from this MCP?" If no, skip it.

**Savings:** ~5-8K tokens per session (second-biggest optimization after disabling extended thinking).
