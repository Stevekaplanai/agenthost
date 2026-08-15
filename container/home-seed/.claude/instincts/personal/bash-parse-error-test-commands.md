---
id: bash-parse-error-test-commands
trigger: when Bash tool receives e2e-proof or test-event command patterns and parse_error occurs
confidence: 0.75
domain: workflow
source: session-observation
scope: global
project_id: global
project_name: global
---

# Bash Parse Errors on Test/Proof Commands

## Action
Flag Bash parse errors on e2e-proof or test-event command patterns; investigate command format validity before re-issuing. These errors cluster in validation runs and indicate malformed input to the tool.

## Evidence
- Observed 12 times in session e2e-proof-aug3 (2026-08-03)
- Pattern: Sequential parse_error events on Bash tool, commands named `e2e-proof-event-1` through `e2e-proof-event-12`
- Timestamp cluster: 2026-08-03T14:27:34Z to 2026-08-03T14:27:52Z (18 seconds, 12 events)
- All from `C:\Users\User` working directory
- Test/proof event naming suggests intentional test harness

## Remediation
When parse_error occurs on Bash test commands:
1. Verify command format is valid PowerShell or bash syntax, not a placeholder or test identifier
2. Check if the command string is being evaluated as a literal string vs. actual command
3. If pattern repeats, investigate whether the test harness itself has a syntax issue
