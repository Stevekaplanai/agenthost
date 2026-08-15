#!/usr/bin/env bash
# Inner Visual QA runner. This file is staged read-only at /opt/qa and is only
# reached through qa-sandbox.js's allowlist Bubblewrap filesystem/PID jail.
set -euo pipefail

umask 002
ROOT=/qa-output
CONFIG=/opt/qa/qa-routes.json
FORCE=
AUTHORITATIVE=
TOKEN_STDIN=
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=--force ;;
    --gate-authoritative) AUTHORITATIVE=1 ;;
    --token-stdin) TOKEN_STDIN=1 ;;
    *) echo "error: unknown QA runner argument: $arg" >&2; exit 3 ;;
  esac
done

[ "$FORCE" = "--force" ] && [ -n "$AUTHORITATIVE" ] && [ -n "$TOKEN_STDIN" ] \
  || { echo "error: Visual QA must be launched by the gate through POST /qa/run or root-only agenthost-qa" >&2; exit 3; }
[ "$ROOT" = "/qa-output" ] \
  || { echo "error: authoritative QA was not given its descriptor-pinned output mount" >&2; exit 3; }

command -v chromium >/dev/null 2>&1 || {
  echo "error: chromium is not on PATH inside the QA jail. It is baked into the image;" >&2
  echo "       if it is missing here, the image or sandbox runtime allowlist changed." >&2
  exit 3
}
[ -f "$CONFIG" ] || { echo "error: no jailed route config at $CONFIG" >&2; exit 3; }
[ -d "$ROOT" ] && [ -w "$ROOT" ] \
  || { echo "error: the descriptor-pinned QA output directory is unavailable at $ROOT" >&2; exit 3; }

# The gate explicitly says stdin carries the short-lived read-only render token.
# Keep it a shell variable, never export it. A second fixed stdin pipe hands the
# one line to Node, so neither Node nor Chromium/curl exposes it in argv/environ.
QA_RENDER_TOKEN=
IFS= read -r QA_RENDER_TOKEN || QA_RENDER_TOKEN=

printf "%s\n" "$QA_RENDER_TOKEN" | QA_CONFIG_PATH="$CONFIG" QA_ROOT="$ROOT" node -e '
  process.on("uncaughtException", (e) => { console.error("qa runner crashed: " + (e && e.message ? e.message : e)); process.exit(4); });
  const qa = require("/opt/qa/qa-agent.js");
  const fs = require("fs");
  const renderToken = fs.readFileSync(0, "utf8").replace(/\r?\n$/, "");
  const cfg = JSON.parse(fs.readFileSync(process.env.QA_CONFIG_PATH, "utf8"));
  const out = qa.runQaPass(cfg, {
    rootDir: process.env.QA_ROOT,
    renderToken,
  });
  console.log(out.summary);
  for (const r of out.results) {
    console.log("  " + r.status.padEnd(18) + r.target + (r.detail ? "  -- " + r.detail : ""));
  }
  if (out.failedCount > 0) process.exit(2);
  if (out.changedCount > 0) process.exit(1);
' || RC=$?
exit "${RC:-0}"
