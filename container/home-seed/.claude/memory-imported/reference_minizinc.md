---
name: minizinc-partially-installed
description: "MiniZinc binary is installed at C:\\Program Files\\MiniZinc but not yet on PATH and the Python bindings aren't in the mcp-solver venv. Three wiring steps remain before /channel-score-style integrations can use it."
metadata: 
  node_type: memory
  type: reference
  originSessionId: d015ae85-f41a-4315-bb08-994a91f55268
---

MiniZinc is partially installed as of 2026-05-19. The binary lives at `C:\Program Files\MiniZinc\minizinc.exe` (alongside the IDE). NOT yet wired to Claude Code.

**Why:** Steve mentioned MiniZinc is installed during the Phase 0 + A1 sprint. MiniZinc is the right solver for assignment-heavy problems (content calendar diversity, large scheduling instances) where Z3's general SMT engine is overkill or slower. The original plan dropped content calendar because MiniZinc was assumed unavailable — that constraint is now lifted.

**How to apply:** When a future task fits MiniZinc better than Z3 (multi-dimensional assignment problems, large discrete optimization with global constraints like all-different, cumulative scheduling), reach for this. To complete the wiring:

1. Add `C:\Program Files\MiniZinc` to user PATH so the binary resolves from any shell.
2. Install MiniZinc Python bindings into the mcp-solver venv:
   ```powershell
   cd C:\Users\User\Projects\mcp-solver; .\.venv\Scripts\Activate.ps1; uv pip install -e ".[mzn]"
   ```
3. Register the MCP server in Claude Code at user scope:
   ```powershell
   claude mcp add solver-mzn -s user -- "C:\Users\User\Projects\mcp-solver\.venv\Scripts\mcp-solver-mzn.exe"
   ```
4. Restart Claude Code so `mcp__solver-mzn__*` tools load.

After wiring, MiniZinc unlocks (per [[gtmvp_solver_applications]]):

- **Content calendar diversity** — 5 pillars × 7 platforms × 14 days assignment with diversity constraints. Was dropped in Phase E of the original plan; now feasible.
- **TAM/SAM/SOM horizon planning with rich dependencies** — original Phase C2 stays in Z3, but if dependency depth grows, MiniZinc handles it cleaner.
- **Influencer assignment** — N influencers × M campaigns × K timeslots with audience-fit + non-overlap constraints.
- **Large-scale set cover** — when /competitor-map candidate pool grows past ~50 candidates, MiniZinc outperforms Z3.

See also: [[mcp-solver-z3-installed]] for Z3 status + [[gtmvp_solver_applications]] for the broader integration roadmap.
