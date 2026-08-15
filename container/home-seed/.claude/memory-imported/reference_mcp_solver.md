---
name: mcp-solver-z3-installed
description: "Z3 constraint/SMT solver available via MCP at user scope. Use for provably-optimal decisions when LLM-reasoning would be slow or wrong — scheduling, allocation, verification, optimization."
metadata: 
  node_type: memory
  type: reference
  originSessionId: d015ae85-f41a-4315-bb08-994a91f55268
---

`solver-z3` MCP server is installed at user scope and connected. Tools are `mcp__solver-z3__{clear_model, add_item, replace_item, delete_item, get_model, solve_model}`.

**Why:** Steve installed it 2026-05-19 after the smoke test (`[0, 1, 3]` correct for a 3-of-6 picking problem maximizing total fit). LLMs are bad at constraint problems — they hand-wave, miss feasibility, can't prove optimality. Z3 produces SAT/UNSAT + a model in milliseconds for problems that take hours of LLM thinking. When the problem fits, the solver is 100x faster and provably correct.

**How to apply:** Reach for the solver when the task has any of these shapes:

- **Pick K of N maximizing Σ score under hard constraints** (zxq daily slate, ICP segment selection, GTMVP channel mix)
- **Assignment problem** (content calendar: 5 pillars × 7 days × 4 platforms with diversity constraints)
- **Verification / counterexample** ("prove this Postgres RLS policy can't leak X to role Y" → Z3 finds a leak or proves none exists)
- **Mixed int + bool + real optimization** (pricing tiers × customer segments × margin floors)
- **Boolean SAT** (which subset of GTMVP agents to fire for this prospect given dependency DAG)
- **MaxSAT** (find max-consistent subset when stored lessons / instincts contradict)

Do NOT use it for:
- Fuzzy / opinion problems ("rank these 10 hooks by virality") — LLM stays better
- Problems with no clear constraint structure
- One-off arithmetic (just compute it inline)

Paths:
- Repo: `C:\Users\User\Projects\mcp-solver`
- Z3 binary: `C:\Users\User\Projects\mcp-solver\.venv\Scripts\mcp-solver-z3.exe`
- MCP registration: `~/.claude.json` user scope, server name `solver-z3`

Other backends available if needed (PySAT/MaxSAT/MiniZinc/ASP) but only Z3 is currently registered. MiniZinc would need a separate ~500MB system install for assignment-heavy problems that Z3 handles less elegantly.

See also: [[gtmvp_solver_applications]] — concrete integration spots for the constraint solver across the GTMVP agent suite.
