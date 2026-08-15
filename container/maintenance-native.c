#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <limits.h>
#include <node_api.h>
#include <pwd.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

#ifndef O_PATH
#define O_PATH 010000000
#endif
#ifndef SYS_pidfd_open
#define SYS_pidfd_open 434
#endif

#define JOURNAL_MAX_BYTES (1024U * 1024U)
#define LINE_MAX_BYTES (512U * 1024U)
#define MAINTENANCE_DIR "/data/maintenance"
#define SOCKET_PATH "/run/agenthost/maint.sock"

static int data_fd = -1;
static int maintenance_fd = -1;
static int listener_fd = -1;
static int active_gate_fd = -1;
static int gate_pid = -1;
static int gate_pidfd = -1;
static unsigned long long gate_start_time = 0;

static napi_value fail(napi_env env, const char *code, const char *message) {
  napi_throw_error(env, code, message);
  return NULL;
}

static napi_value fail_errno(napi_env env, const char *code, const char *what) {
  char message[256];
  snprintf(message, sizeof(message), "%s: %s", what, strerror(errno));
  return fail(env, code, message);
}

// The authority guard. Requires ROOT (uid 0) — NOT PID 1. On a container
// platform (Fly/firecracker, Docker, k8s) the platform runs its OWN init as
// PID 1 and launches our entrypoint as a child, so getpid()==1 is never true and
// was a sandbox-only assumption. The real invariant is uid 0: the durable stores
// and the authority socket are root-owned (0660 root:gate), so only a root
// process can create/read them; the socket then verifies its peer by SO_PEERCRED
// (exact `gate` uid/gid + the recorded direct-child pid). The firecracker VM is
// the isolation boundary; inside it the only root processes are the platform init
// (trusted) and this authority. "Runs as root inside the VM" is the property;
// "PID 1" is not load-bearing.
static int require_root_authority(napi_env env) {
  if (geteuid() != 0) {
    fail(env, "NATIVE_NOT_AUTHORITY", "native authority calls require root");
    return -1;
  }
  return 0;
}

static int verify_stat(int fd, uid_t uid, gid_t gid, mode_t mode, int regular) {
  struct stat st;
  if (fstat(fd, &st) != 0 || st.st_uid != uid || st.st_gid != gid ||
      (st.st_mode & 07777) != mode || (regular && !S_ISREG(st.st_mode)) ||
      (!regular && !S_ISDIR(st.st_mode))) {
    errno = EACCES;
    return -1;
  }
  if (regular && st.st_nlink != 1) {
    errno = ELOOP;
    return -1;
  }
  return 0;
}

static int verify_directory_fd(int fd, uid_t uid, gid_t gid, mode_t mode) {
  return verify_stat(fd, uid, gid, mode, 0);
}

static int open_trusted_dirs(void) {
  if (data_fd >= 0 && maintenance_fd >= 0) return 0;
  if (data_fd >= 0) { close(data_fd); data_fd = -1; }
  data_fd = open("/data", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (data_fd < 0 || verify_directory_fd(data_fd, 0, 0, 0755) != 0) { if (data_fd >= 0) close(data_fd); data_fd = -1; return -1; }
  maintenance_fd = openat(data_fd, "maintenance", O_RDONLY | O_DIRECTORY |
                          O_NOFOLLOW | O_CLOEXEC);
  if (maintenance_fd < 0 || verify_directory_fd(maintenance_fd, 0, 0, 0700) != 0) { if (maintenance_fd >= 0) close(maintenance_fd); maintenance_fd = -1; close(data_fd); data_fd = -1; return -1; }
  return 0;
}

static int open_leaf(const char *name, int flags, int *created) {
  if (created) *created = 0;
  int fd;
  if (created && (flags & O_CREAT)) {
    // Distinguish creation from opening an existing leaf so the caller can make
    // the new directory entry durable. Single-threaded root PID 1 owns this
    // 0700 directory, so there is no create race to lose between the two opens.
    fd = openat(maintenance_fd, name, (flags & ~O_CREAT) | O_CLOEXEC | O_NOFOLLOW, 0600);
    if (fd < 0 && errno == ENOENT) {
      fd = openat(maintenance_fd, name, flags | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
      if (fd >= 0) *created = 1;
    }
  } else {
    fd = openat(maintenance_fd, name, flags | O_CLOEXEC | O_NOFOLLOW, 0600);
  }
  if (fd < 0) return -1;
  if (verify_stat(fd, 0, 0, 0600, 1) != 0) {
    close(fd);
    return -1;
  }
  return fd;
}

static int write_all(int fd, const unsigned char *data, size_t length) {
  size_t at = 0;
  while (at < length) {
    ssize_t used = write(fd, data + at, length - at);
    if (used < 0 && errno == EINTR) continue;
    if (used <= 0) return -1;
    at += (size_t)used;
  }
  return 0;
}

static int valid_line(const unsigned char *data, size_t length) {
  if (length == 0 || length > LINE_MAX_BYTES) { errno = EFBIG; return -1; }
  for (size_t i = 0; i < length; i++) {
    if (data[i] == '\n' || data[i] == '\r' || data[i] == 0) { errno = EINVAL; return -1; }
  }
  return 0;
}

static napi_value undefined(napi_env env) {
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

static int get_buffer(napi_env env, napi_callback_info info, void **data, size_t *length) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1) {
    fail(env, "INVALID_REQUEST", "expected one Buffer");
    return -1;
  }
  bool is_buffer = false;
  if (napi_is_buffer(env, argv[0], &is_buffer) != napi_ok || !is_buffer ||
      napi_get_buffer_info(env, argv[0], data, length) != napi_ok) {
    fail(env, "INVALID_REQUEST", "expected one Buffer");
    return -1;
  }
  return 0;
}

static napi_value open_stores(napi_env env, napi_callback_info info) {
  (void)info;
  if (require_root_authority(env) != 0) return NULL;
  if (open_trusted_dirs() != 0) return fail_errno(env, "STORE_UNAVAILABLE", "open trusted stores");
  return undefined(env);
}

static napi_value read_journal(napi_env env, napi_callback_info info) {
  (void)info;
  if (require_root_authority(env) != 0) return NULL;
  if (open_trusted_dirs() != 0) return fail_errno(env, "STORE_UNAVAILABLE", "open trusted stores");
  int fd = open_leaf("foundation.ndjson", O_RDONLY, NULL);
  if (fd < 0 && errno == ENOENT) { napi_value null_value; napi_get_null(env, &null_value); return null_value; }
  if (fd < 0) return fail_errno(env, "STORE_UNAVAILABLE", "open foundation journal");
  struct stat st;
  if (fstat(fd, &st) != 0 || st.st_size < 0 || st.st_size > JOURNAL_MAX_BYTES) {
    close(fd); errno = EFBIG; return fail_errno(env, "STORE_UNAVAILABLE", "read foundation journal");
  }
  size_t length = (size_t)st.st_size;
  unsigned char *buffer = length ? malloc(length) : NULL;
  if (length && !buffer) { close(fd); errno = ENOMEM; return fail_errno(env, "STORE_UNAVAILABLE", "allocate journal"); }
  size_t at = 0;
  while (at < length) {
    ssize_t used = read(fd, buffer + at, length - at);
    if (used < 0 && errno == EINTR) continue;
    if (used <= 0) { free(buffer); close(fd); errno = EIO; return fail_errno(env, "STORE_UNAVAILABLE", "read foundation journal"); }
    at += (size_t)used;
  }
  close(fd);
  napi_value result;
  napi_status status = napi_create_buffer_copy(env, length, buffer, NULL, &result);
  free(buffer);
  if (status != napi_ok) return fail(env, "STORE_UNAVAILABLE", "create journal Buffer");
  return result;
}

static napi_value append_leaf(napi_env env, napi_callback_info info, const char *name) {
  if (require_root_authority(env) != 0) return NULL;
  void *data = NULL; size_t length = 0;
  if (get_buffer(env, info, &data, &length) != 0) return NULL;
  if (valid_line(data, length) != 0) return fail_errno(env, "INVALID_REQUEST", "invalid journal line");
  if (open_trusted_dirs() != 0) return fail_errno(env, "STORE_UNAVAILABLE", "open trusted stores");
  int created = 0;
  int fd = open_leaf(name, O_WRONLY | O_APPEND | O_CREAT, &created);
  if (fd >= 0) { struct stat st; if (fstat(fd, &st) != 0 || st.st_size < 0 || (uint64_t)st.st_size + length + 1 > JOURNAL_MAX_BYTES) { close(fd); errno = EFBIG; fd = -1; } }
  if (fd < 0 || write_all(fd, data, length) != 0 || write_all(fd, (unsigned char *)"\n", 1) != 0 || fdatasync(fd) != 0) {
    if (fd >= 0) close(fd);
    return fail_errno(env, "STORE_UNAVAILABLE", "append journal");
  }
  // A newly created leaf's directory entry is not durable until the parent
  // directory is synced; fail closed if that cannot be proven.
  if (created && fsync(maintenance_fd) != 0) {
    close(fd);
    return fail_errno(env, "STORE_UNAVAILABLE", "sync journal directory");
  }
  close(fd);
  return undefined(env);
}

static napi_value append_foundation(napi_env env, napi_callback_info info) {
  return append_leaf(env, info, "foundation.ndjson");
}

static napi_value append_quarantine(napi_env env, napi_callback_info info) {
  return append_leaf(env, info, "quarantine.ndjson");
}

static int gate_group(gid_t *gid) {
  struct group *group = getgrnam("gate");
  if (!group) { errno = ENOENT; return -1; }
  *gid = group->gr_gid;
  return 0;
}

static int verify_path_stat(const char *path, uid_t uid, gid_t gid, mode_t mode, int socket_type) {
  struct stat st;
  if (lstat(path, &st) != 0 || st.st_uid != uid || st.st_gid != gid ||
      (st.st_mode & 07777) != mode || (socket_type ? !S_ISSOCK(st.st_mode) : !S_ISDIR(st.st_mode))) {
    errno = EACCES; return -1;
  }
  return 0;
}

static napi_value create_listener(napi_env env, napi_callback_info info) {
  (void)info;
  if (require_root_authority(env) != 0) return NULL;
  gid_t gid;
  if (gate_group(&gid) != 0) return fail_errno(env, "SOCKET_UNAVAILABLE", "find gate group");
  int created = mkdir("/run/agenthost", 0750) == 0;
  if (!created && errno != EEXIST) return fail_errno(env, "SOCKET_UNAVAILABLE", "create runtime directory");
  if (created && (chown("/run/agenthost", 0, gid) != 0 || chmod("/run/agenthost", 0750) != 0)) return fail_errno(env, "SOCKET_UNAVAILABLE", "secure runtime directory");
  if (verify_path_stat("/run/agenthost", 0, gid, 0750, 0) != 0) return fail_errno(env, "SOCKET_UNAVAILABLE", "validate runtime directory");
  struct stat stale;
  if (lstat(SOCKET_PATH, &stale) == 0) {
    if (stale.st_uid != 0 || stale.st_gid != gid || (stale.st_mode & 07777) != 0660 || !S_ISSOCK(stale.st_mode)) {
      errno = EACCES; return fail_errno(env, "SOCKET_UNAVAILABLE", "unsafe stale socket");
    }
    if (unlink(SOCKET_PATH) != 0) return fail_errno(env, "SOCKET_UNAVAILABLE", "remove stale socket");
  } else if (errno != ENOENT) return fail_errno(env, "SOCKET_UNAVAILABLE", "inspect socket path");
  listener_fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
  if (listener_fd < 0) return fail_errno(env, "SOCKET_UNAVAILABLE", "create socket");
  struct sockaddr_un address;
  memset(&address, 0, sizeof(address)); address.sun_family = AF_UNIX;
  size_t socket_length = strlen(SOCKET_PATH);
  if (socket_length >= sizeof(address.sun_path)) { close(listener_fd); listener_fd = -1; errno = ENAMETOOLONG; return fail_errno(env, "SOCKET_UNAVAILABLE", "authority socket path"); }
  memcpy(address.sun_path, SOCKET_PATH, socket_length + 1);
  if (bind(listener_fd, (struct sockaddr *)&address, sizeof(address)) != 0 ||
      chown(SOCKET_PATH, 0, gid) != 0 || chmod(SOCKET_PATH, 0660) != 0 ||
      listen(listener_fd, 1) != 0) {
    close(listener_fd); listener_fd = -1; unlink(SOCKET_PATH);
    return fail_errno(env, "SOCKET_UNAVAILABLE", "bind authority socket");
  }
  return undefined(env);
}

static int proc_start_time(pid_t pid, unsigned long long *start) {
  char path[64]; char line[4096];
  snprintf(path, sizeof(path), "/proc/%ld/stat", (long)pid);
  int fd = open(path, O_RDONLY | O_CLOEXEC); if (fd < 0) return -1;
  ssize_t used = read(fd, line, sizeof(line) - 1); close(fd);
  if (used <= 0) return -1;
  line[used] = 0;
  char *end = strrchr(line, ')'); if (!end || end[1] != ' ') return -1;
  char *cursor = end + 3; unsigned long long value = 0;
  for (int field = 4; field <= 22; field++) {
    while (*cursor == ' ') cursor++;
    char *next = NULL; errno = 0; value = strtoull(cursor, &next, 10);
    if (next == cursor || errno) return -1;
    if (field == 22) { *start = value; return 0; }
    cursor = next;
  }
  return -1;
}

static napi_value record_gate(napi_env env, napi_callback_info info) {
  if (require_root_authority(env) != 0) return NULL;
  size_t argc = 1; napi_value argv[1]; int32_t pid_value;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1 || napi_get_value_int32(env, argv[0], &pid_value) != napi_ok || pid_value <= 0) return fail(env, "INVALID_REQUEST", "gate pid is invalid");
  unsigned long long start;
  if (proc_start_time((pid_t)pid_value, &start) != 0) return fail_errno(env, "SOCKET_UNAVAILABLE", "inspect gate child");
  siginfo_t child = {0};
  if (waitid(P_PID, (id_t)pid_value, &child, WEXITED | WNOHANG | WNOWAIT) != 0 || child.si_pid != 0) return fail(env, "WRONG_PID", "gate pid is not a live direct child");
  int fd = (int)syscall(SYS_pidfd_open, (pid_t)pid_value, 0);
  if (fd < 0 && errno != ENOSYS) return fail_errno(env, "SOCKET_UNAVAILABLE", "pin gate pid");
  if (gate_pidfd >= 0) close(gate_pidfd);
  gate_pidfd = fd >= 0 ? fd : -1;
  gate_pid = pid_value; gate_start_time = start;
  return undefined(env);
}

static napi_value accept_gate(napi_env env, napi_callback_info info) {
  (void)info;
  if (require_root_authority(env) != 0) return NULL;
  if (listener_fd < 0 || gate_pid <= 0) return fail(env, "SOCKET_UNAVAILABLE", "authority listener is not ready");
  int fd = accept4(listener_fd, NULL, NULL, SOCK_CLOEXEC | SOCK_NONBLOCK);
  if (fd < 0) return NULL;
  if (active_gate_fd >= 0) { close(fd); return fail(env, "SECOND_CONNECTION", "second gate connection rejected"); }
  struct ucred peer; socklen_t length = sizeof(peer);
  if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &peer, &length) != 0) { close(fd); return fail_errno(env, "WRONG_PEER", "read gate credentials"); }
  struct passwd *gate = getpwnam("gate"); struct group *group = getgrnam("gate");
  if (!gate || !group || peer.pid != gate_pid || peer.uid != gate->pw_uid || peer.gid != group->gr_gid) { close(fd); return fail(env, peer.pid != gate_pid ? "WRONG_PID" : (peer.uid != (gate ? gate->pw_uid : 0) ? "WRONG_UID" : "WRONG_GID"), "gate peer rejected"); }
  if (gate_pidfd >= 0) { struct pollfd probe = { gate_pidfd, POLLIN | POLLHUP | POLLERR, 0 }; if (poll(&probe, 1, 0) != 0 || (probe.revents & (POLLIN | POLLHUP | POLLERR))) { close(fd); return fail(env, "WRONG_PID", "gate process is no longer alive"); } }
  else { unsigned long long current; if (proc_start_time((pid_t)gate_pid, &current) != 0 || current != gate_start_time) { close(fd); return fail(env, "WRONG_PID", "gate pid identity changed"); } }
  active_gate_fd = fd;
  napi_value result; napi_create_int32(env, fd, &result); return result;
}

// Gate-loss reconciliation: PID 1 revokes the active connection and the
// recorded direct-child identity so a replacement gate (new PID, new epoch)
// can be recorded and accepted. Without this the first accepted gate latches
// active_gate_fd for the process lifetime and every replacement is refused as
// a second connection until the container restarts.
static napi_value revoke_active_gate(napi_env env, napi_callback_info info) {
  (void)info;
  if (require_root_authority(env) != 0) return NULL;
  if (active_gate_fd >= 0) { close(active_gate_fd); active_gate_fd = -1; }
  if (gate_pidfd >= 0) { close(gate_pidfd); gate_pidfd = -1; }
  gate_pid = -1;
  gate_start_time = 0;
  return undefined(env);
}

// Environment scrubbing is not enough for a same-uid helper: without this, a
// compromised child could inspect its gate parent through /proc. This operation
// only reduces the current process's authority, so it deliberately works after
// the gate has dropped from root to its dedicated uid.
static napi_value set_self_non_dumpable(napi_env env, napi_callback_info info) {
  (void)info;
  if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0) {
    return fail_errno(env, "PROCESS_HARDENING_FAILED", "set process non-dumpable");
  }
  int dumpable = prctl(PR_GET_DUMPABLE, 0, 0, 0, 0);
  if (dumpable != 0) {
    if (dumpable >= 0) errno = EPERM;
    return fail_errno(env, "PROCESS_HARDENING_FAILED", "verify process non-dumpable");
  }
  napi_value result;
  if (napi_get_boolean(env, true, &result) != napi_ok) {
    return fail(env, "PROCESS_HARDENING_FAILED", "return process hardening result");
  }
  return result;
}

#define DECLARE(name, fn) { name, NULL, fn, NULL, NULL, NULL, napi_default, NULL }
static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    DECLARE("openTrustedStores", open_stores),
    DECLARE("readFoundationJournal", read_journal),
    DECLARE("appendFoundationJournalLine", append_foundation),
    DECLARE("appendQuarantineJournalLine", append_quarantine),
    DECLARE("createAuthorityListener", create_listener),
    DECLARE("recordDirectGateChild", record_gate),
    DECLARE("acceptVerifiedGate", accept_gate),
    DECLARE("revokeActiveGate", revoke_active_gate),
    DECLARE("setSelfNonDumpable", set_self_non_dumpable),
  };
  if (napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties) != napi_ok) return NULL;
  return exports;
}

NAPI_MODULE_INIT() { return init(env, exports); }
