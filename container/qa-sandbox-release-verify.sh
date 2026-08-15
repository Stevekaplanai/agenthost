#!/usr/bin/env bash
# Build (unless an image tag is supplied) and execute the Visual QA jail proof
# inside the exact final release image. Docker's default seccomp profile blocks
# Bubblewrap's unprivileged user namespace; Fly does not. The narrow seccomp
# exception here matches the established release-image bwrap proof rather than
# weakening the image or skipping the real jail during docker build.
set -euo pipefail

HERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
IMAGE="${1:-agenthost-qa-sandbox-proof:local}"

if [ "$#" -eq 0 ]; then
  docker build -t "$IMAGE" -f "$HERE/Dockerfile" "$HERE"
fi

# Git Bash must convert the host build context above, but must not rewrite the
# container's /bin/sh entrypoint below into a Windows host path.
export MSYS_NO_PATHCONV=1

docker run --rm --security-opt seccomp=unconfined --entrypoint /bin/sh "$IMAGE" -c '
  set -eu
  install -d -o gate -g gate -m 0700 /data/agenthost-gate-state
  install -d -o gate -g gate -m 0700 /data/agenthost-gate-state/qa
  install -d -o gate -g gate -m 0700 /data/agenthost-gate-state/qa/evidence
  printf "gate-only-canary\n" > /data/agenthost-gate-state/qa-sandbox-canary
  chown gate:gate /data/agenthost-gate-state/qa-sandbox-canary
  chmod 0600 /data/agenthost-gate-state/qa-sandbox-canary
  env -i \
    PATH=/usr/local/bin:/usr/bin:/bin \
    HOME=/data/home/agent \
    USER=gate \
    LOGNAME=gate \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    QA_HOST_SENTINEL=synthetic-host-only-value \
    GIT_PUSH_TOKEN=synthetic-push-token \
    AGENTHOST_QA_CANARY_PATH=/data/agenthost-gate-state/qa-sandbox-canary \
    AGENTHOST_QA_EVIDENCE_ROOT=/data/agenthost-gate-state/qa/evidence \
    QA_KEEP_EVIDENCE=1 \
    /usr/bin/setpriv --reuid=gate --regid=gate --init-groups --no-new-privs -- \
    /usr/local/bin/node --test /opt/agenthost/qa-sandbox-linux.test.js

  baseline=/data/agenthost-gate-state/qa/evidence/baseline-proof.png
  current=/data/agenthost-gate-state/qa/evidence/current-proof.png
  test -s "$baseline" && test -s "$current"
  before_baseline="$(stat -c "%d:%i:%s" "$baseline") $(sha256sum "$baseline")"
  before_current="$(stat -c "%d:%i:%s" "$current") $(sha256sum "$current")"

  if /usr/bin/setpriv --reuid=agent --regid=agent --init-groups --no-new-privs -- \
      /bin/sh -c "printf tamper > $baseline" 2>/dev/null; then
    echo "error: agent uid rewrote the protected QA baseline" >&2; exit 1
  fi
  if /usr/bin/setpriv --reuid=agent --regid=agent --init-groups --no-new-privs -- \
      /bin/sh -c "rm -f $current" 2>/dev/null; then
    echo "error: agent uid unlinked the protected QA current capture" >&2; exit 1
  fi
  if /usr/bin/setpriv --reuid=agent --regid=agent --init-groups --no-new-privs -- \
      /bin/sh -c "mv $baseline ${baseline}.agent-moved" 2>/dev/null; then
    echo "error: agent uid renamed the protected QA baseline" >&2; exit 1
  fi

  after_baseline="$(stat -c "%d:%i:%s" "$baseline") $(sha256sum "$baseline")"
  after_current="$(stat -c "%d:%i:%s" "$current") $(sha256sum "$current")"
  test "$before_baseline" = "$after_baseline"
  test "$before_current" = "$after_current"
  test "$(sha256sum "$baseline" | cut -d " " -f 1)" != "$(sha256sum "$current" | cut -d " " -f 1)"
  echo "QA protected-evidence cross-uid tamper proof: PASS"
'
