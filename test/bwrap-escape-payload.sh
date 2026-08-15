#!/bin/sh
# bwrap-escape-payload.sh — TEST FIXTURE ONLY (BUILD-PLAN Phase 1e, adversarial
# proof #8). Runs *inside* the production bwrap read-jail as its `--` command and
# attempts to break out. It emits one line per sub-claim:
#     CLAIM <name> <PASS|FAIL> <detail>
# where PASS means the escape was DENIED (the safe outcome) and FAIL means the
# escape SUCCEEDED (a real breach). It changes nothing on the host and never
# self-certifies — the orchestrator (test/bwrap-escape-authority.js) parses these
# lines and the signed evidence records them.
#
# The jail clears the environment (--clearenv) and binds only /usr /bin /lib*
# /usr/local, a small /etc allowlist, tmpfs /hm /tmp, /proc, /dev, and the single
# writable task worktree. So absolute paths only; assume no PATH, no $EUID.
#
# UNVERIFIED IN THE BUILD SANDBOX: the build sandbox has no setuid /usr/bin/bwrap
# (it is baked only into the release image at Dockerfile:36), so this payload is
# authored to run on a Fly machine built from the exact release image and has NOT
# been executed here. Treat every CLAIM as pending until that run.
set -u
# The jail runs with --clearenv, so establish a PATH over the bound /usr and /bin
# (BWRAP_RO_DEFAULT) before invoking any external tool.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Read /proc/self/status without awk: the jail binds /usr but NOT
# /etc/alternatives, so Ubuntu's /usr/bin/awk (an alternatives symlink) dangles
# inside the jail. grep + `set --` use only real binaries that are bound.
# "Uid: real effective saved fs" -> effective is field 3 after the label.
eff_uid() { set -- $(grep '^Uid:' /proc/self/status 2>/dev/null); echo "${3:-}"; }
# "CapEff: <hex>" -> the hex is field 2 after the label.
cap_eff() { set -- $(grep '^CapEff:' /proc/self/status 2>/dev/null); echo "${2:-}"; }
emit() { printf 'CLAIM %s %s %s\n' "$1" "$2" "$3"; }

# A claim that must FAIL an action to be safe: pass CMD; PASS if it does NOT
# succeed (non-zero exit or produced no reachable resource).
denied() { # name, human, command...
  name="$1"; human="$2"; shift 2
  if "$@" >/dev/null 2>&1; then emit "$name" FAIL "SUCCEEDED unexpectedly: $human"
  else emit "$name" PASS "denied: $human"; fi
}

claim_host_root() {
  e="$(eff_uid)"; c="$(cap_eff)"
  if [ "${e:-x}" = "0" ]; then emit host_root.euid FAIL "effective uid is 0 inside the jail"
  else emit host_root.euid PASS "effective uid=${e:-unknown} (not root)"; fi
  # Empty CapEff => no capabilities => mount/module-load denied by construction.
  if [ "${c:-x}" = "0000000000000000" ] || [ "${c:-x}" = "0" ]; then
    emit host_root.caps PASS "CapEff=${c} (no capabilities)"
  else
    emit host_root.caps FAIL "CapEff=${c} (holds capabilities)"
  fi
  # A root-owned file that is NOT in the bind allowlist must be unreadable.
  denied host_root.read_shadow "read /etc/shadow (not bound)" cat /etc/shadow
  denied host_root.remount "remount / read-write" mount -o remount,rw /
  denied host_root.newmount "mount a fresh tmpfs at /mnt" mount -t tmpfs none /mnt
  if [ -x /sbin/insmod ] || [ -x /usr/sbin/insmod ]; then
    denied host_root.insmod "load a kernel module" sh -c 'insmod /dev/null'
  else
    emit host_root.insmod PASS "insmod absent in jail; CapEff has no CAP_SYS_MODULE"
  fi
}

claim_reach_stores() {
  # The trusted stores and socket are NOT in the jail bind set, so they must not
  # even be reachable from inside.
  denied stores.stat_data "stat /data/maintenance" test -e /data/maintenance
  denied stores.read_journal "read the maintenance journal" cat /data/maintenance/journal
  denied stores.write_data "write into /data/maintenance" sh -c 'echo x > /data/maintenance/x'
  denied stores.rename_data "rename inside /data/maintenance" mv /data/maintenance/journal /data/maintenance/j2
  # NB: plain `rm`, never `rm -f` — `-f` exits 0 on a missing target and would
  # falsely read as a successful delete.
  denied stores.delete_data "delete inside /data/maintenance" rm /data/maintenance/journal
  denied stores.socket_exists "reach /run/agenthost/maint.sock" test -S /run/agenthost/maint.sock
  if command -v node >/dev/null 2>&1; then
    if node -e 'const n=require("net");const s=n.connect("/run/agenthost/maint.sock");s.on("connect",()=>process.exit(0));s.on("error",()=>process.exit(3));setTimeout(()=>process.exit(3),800);' >/dev/null 2>&1; then
      emit stores.socket_connect FAIL "connect() to maint.sock succeeded"
    else
      emit stores.socket_connect PASS "connect() to maint.sock refused/unreachable"
    fi
  else
    emit stores.socket_connect PASS "node absent to attempt connect; socket not bound into jail"
  fi
}

claim_jail_breakout() {
  # --unshare-pid: only the jail's own PIDs are visible, not the host's hundreds.
  n="$(ls -1 /proc 2>/dev/null | grep -c '^[0-9]\+$')"
  if [ "${n:-999}" -le 8 ]; then emit jail.pid_isolation PASS "only ${n} PIDs visible (isolated PID namespace)"
  else emit jail.pid_isolation FAIL "${n} PIDs visible (host PID namespace leaked)"; fi
  # Paths outside the explicit binds must be absent/unreachable.
  for p in /root /home /opt/agenthost /data /run/agenthost; do
    if [ -e "$p" ]; then emit "jail.path$(echo "$p" | tr / _)" FAIL "reachable outside binds: $p"
    else emit "jail.path$(echo "$p" | tr / _)" PASS "absent outside binds: $p"; fi
  done
  # --new-session / --die-with-parent / --chdir /scratch hold under fork/double-
  # fork/setsid: the setsid escapee still sees the same isolated PID namespace.
  m="$(setsid sh -c 'ls -1 /proc 2>/dev/null | grep -c "^[0-9]\+$"' 2>/dev/null)"
  if [ "${m:-999}" -le 8 ]; then emit jail.setsid_confined PASS "setsid child still isolated (${m} PIDs)"
  else emit jail.setsid_confined FAIL "setsid child escaped to ${m} PIDs"; fi
}

# Count network interfaces other than loopback, from the netns's own /proc/net/dev
# (awk-free: only interface lines contain a colon; the name is the token before it).
net_iface_count_nonlo() {
  c=0
  while IFS= read -r line; do
    case "$line" in *:*) : ;; *) continue ;; esac
    set -- ${line%%:*}; nm="${1:-}"
    [ -z "$nm" ] && continue
    [ "$nm" = "lo" ] && continue
    c=$((c + 1))
  done < /proc/net/dev
  echo "$c"
}

# git-jail path: gate.js prepends --unshare-net so a hostile Git config/attribute
# gets no outbound channel. Prove the jail's network namespace has only loopback.
claim_net_isolated() {
  n="$(net_iface_count_nonlo)"
  if [ "${n:-9}" -eq 0 ] 2>/dev/null; then
    emit net.no_external PASS "only loopback in the netns (${n} external ifaces) — --unshare-net holds"
  else
    emit net.no_external FAIL "${n} external interface(s) visible — git jail network not isolated"
  fi
}

claim_writable_mount() {
  # Read-only binds must reject writes.
  denied wmount.usr_ro "write into read-only /usr bind" sh -c 'echo x > /usr/.escape'
  denied wmount.bin_ro "write into read-only /bin bind" sh -c 'echo x > /bin/.escape'
  # A bind-mount of a host path outside the worktree must fail (no CAP_SYS_ADMIN
  # over the host mount namespace).
  denied wmount.bind_host "bind-mount /usr onto /mnt" mount --bind /usr /mnt
}

case "${1:-all}" in
  host_root) claim_host_root ;;
  reach_stores) claim_reach_stores ;;
  jail_breakout) claim_jail_breakout ;;
  writable_mount) claim_writable_mount ;;
  net_isolated) claim_net_isolated ;;
  all) claim_host_root; claim_reach_stores; claim_jail_breakout; claim_writable_mount ;;
  *) echo "unknown mode: ${1:-}" >&2; exit 2 ;;
esac
