---
name: PowerShell 5.1 NativeCommandError handling
description: PS 5.1 wraps native command stderr as ErrorRecords; under ErrorActionPreference=Stop, benign stderr (version output, auth probes) halts the script. Use Test-NativeAuth/Get-NativeOutput helpers.
type: feedback
originSessionId: 14e8009d-5e07-4862-b669-4a2fa6208660
---
On Windows PowerShell 5.1, native executables that write to stderr have their output wrapped into PowerShell ErrorRecords (`NativeCommandError`). With `$ErrorActionPreference = "Stop"` set, these benign stderr writes — `vercel --version`, `railway whoami` when unauth'd, `gh auth status` — terminate the script. Symptoms: red error text mentioning `NativeCommandError`, mid-script abort on a probe that "should be fine."

**Why:** Hit this twice in the Synap CLI bootstrap script (2026-04-25). First fix attempt — adding `2>$null` to native calls — wasn't enough because the wrapping happens at the PS-runtime level before redirection takes effect when running through npm-generated `.ps1` shims (vercel, railway).

**How to apply:** When writing PowerShell scripts that probe native CLIs, do all four:

1. Set `$ErrorActionPreference = "Continue"` at script top (track failures explicitly via try/catch + a `$Failures` array, not via the Stop policy).
2. Wrap native auth/version probes in helpers that locally set `SilentlyContinue` and silence all streams:
   ```powershell
   function Test-NativeAuth { param([scriptblock]$Probe)
       $prev = $ErrorActionPreference; $ErrorActionPreference = "SilentlyContinue"
       try { & $Probe *> $null; return ($LASTEXITCODE -eq 0) }
       catch { return $false } finally { $ErrorActionPreference = $prev }
   }
   function Get-NativeOutput { param([scriptblock]$Probe)
       $prev = $ErrorActionPreference; $ErrorActionPreference = "SilentlyContinue"
       try { return ((& $Probe 2> $null) | Out-String) }
       catch { return "" } finally { $ErrorActionPreference = $prev }
   }
   ```
3. After installing CLIs in-script, refresh `$env:Path` from registry so newly-added shims are detectable in the same run (Scoop/npm don't push PATH into the running session).
4. Validate every PS script with: `powershell -NoProfile -File <script>.ps1` (a real run, not just `[Parser]::ParseFile`) — syntax-clean scripts can still abort on NativeCommandError.

**Reference implementation:** `marketing-ai-platform/scripts/cli-bootstrap.ps1`
