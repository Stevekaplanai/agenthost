/*
 * bwrap-escape-probe.c — TEST FIXTURE ONLY (BUILD-PLAN Phase 1e, adversarial
 * proof #8). This is NOT part of the container image and is NEVER installed by
 * any boot path. scripts/bwrap-escape-verify.sh compiles it into a throwaway
 * location, chowns it root:root, and sets it setuid (mode 4755) so it stands in
 * for "an arbitrary setuid-root binary" — which /usr/bin/bwrap is
 * (Dockerfile:36 `chmod 4755 /usr/bin/bwrap`).
 *
 * The kernel-mechanism half of proof #8 turns on one question: under the exact
 * production privilege drop (entrypoint.sh:48
 *   setpriv --reuid=agent --regid=agent --init-groups --no-new-privs ...),
 * does a setuid-root binary still elevate? If no_new_privs neutralizes setuid,
 * then setuid /usr/bin/bwrap cannot self-elevate to a host-capable root context
 * regardless of bwrap's internals — the load-bearing recon contradiction
 * (setuid at Dockerfile:36 vs --no-new-privs at entrypoint.sh:48) resolves in
 * the safe direction. This probe measures exactly that, empirically.
 *
 * It prints one machine-parseable line and exits 0 (so the harness can read the
 * result even when the "read the root-only file" attempt is correctly denied):
 *   PROBE ruid=<n> euid=<n> rgid=<n> egid=<n> read_root_file=<OK|DENIED:errno=..>
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <unistd.h>
#include <sys/types.h>

int main(int argc, char **argv) {
    uid_t ruid = getuid(), euid = geteuid();
    gid_t rgid = getgid(), egid = getegid();

    /* read_root_file: attempt to read a root-owned 0600 file the agent does not
     * own. Success ONLY if this process holds an effective identity able to read
     * it (i.e. setuid actually elevated). */
    const char *rootfile = (argc > 1) ? argv[1] : NULL;
    char status[128];
    if (rootfile == NULL) {
        snprintf(status, sizeof status, "SKIP:no-path");
    } else {
        FILE *f = fopen(rootfile, "r");
        if (f == NULL) {
            snprintf(status, sizeof status, "DENIED:errno=%d", errno);
        } else {
            char buf[16];
            size_t n = fread(buf, 1, sizeof buf, f);
            fclose(f);
            snprintf(status, sizeof status, "OK:read=%zu", n);
        }
    }

    printf("PROBE ruid=%d euid=%d rgid=%d egid=%d read_root_file=%s\n",
           (int)ruid, (int)euid, (int)rgid, (int)egid, status);
    fflush(stdout);
    return 0;
}
