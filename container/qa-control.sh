#!/usr/bin/env bash
# Root-local Visual QA control. This intentionally carries no operator cookie,
# access key, 2FA seed, or reusable token: filesystem ownership of the fixed
# Foundation-B Unix socket is the authorization boundary.
set -euo pipefail

[ "$(id -u)" -eq 0 ] \
  || { echo "error: agenthost-qa is root-only; use a root Fly console" >&2; exit 77; }

SOCKET=/run/agenthost-qa/control.sock
[ -S "$SOCKET" ] \
  || { echo "error: gate-private QA control is unavailable at $SOCKET" >&2; exit 69; }

case "${1:-run}" in
  run)
    method=POST
    route=/qa/run
    ;;
  result)
    method=GET
    route=/qa/result
    ;;
  *)
    echo "usage: agenthost-qa [run|result]" >&2
    exit 64
    ;;
esac

if curl_result="$(curl --silent --show-error \
  --unix-socket "$SOCKET" \
  --request "$method" \
  --write-out $'\n%{http_code}' \
  "http://localhost$route")"; then
  :
else
  exit "$?"
fi
case "$curl_result" in
  *$'\n'*) ;;
  *) echo "error: gate-private QA returned no HTTP status" >&2; exit 65 ;;
esac
http_code="${curl_result##*$'\n'}"
response="${curl_result%$'\n'*}"
printf '%s\n' "$response"

status="$(printf '%s' "$response" | jq -er '.status | strings')" \
  || { echo "error: gate-private QA returned invalid status JSON" >&2; exit 65; }
case "$http_code" in
  2??) ;;
  *) exit 2 ;;
esac
case "$status" in
  clean) exit 0 ;;
  changed) exit 1 ;;
  *) exit 2 ;;
esac
