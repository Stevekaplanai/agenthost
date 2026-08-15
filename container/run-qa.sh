#!/usr/bin/env bash
# Gate-only Visual QA entrypoint. Public POST /qa/run or the root-local
# agenthost-qa command reserves the shared agent lane before invoking this
# script. Direct/manual execution has no trustworthy way to inspect that lane.
set -euo pipefail
if [ "$#" -ne 3 ] \
  || [ "$1" != "--force" ] \
  || [ "$2" != "--gate-authoritative" ] \
  || [ "$3" != "--token-stdin" ]; then
  echo "error: Visual QA must be launched through public POST /qa/run or the root-only agenthost-qa command so the gate reserves the agent lane." >&2
  exit 3
fi
exec /usr/local/bin/node /opt/agenthost/qa-sandbox.js "$@"
