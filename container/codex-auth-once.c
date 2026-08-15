/*
 * AgentHost Codex auth launcher.
 *
 * This wrapper stays OUTSIDE Bubblewrap, closes inherited bind descriptors,
 * makes the child non-dumpable, and owns process-tree cancellation. Production
 * keeps Codex's ChatGPT login persistent so refresh-token rotation can work;
 * the locked inner Codex profile denies the whole state directory to model
 * commands. The legacy one-use mode still watches and removes auth.json.
 */
#define _GNU_SOURCE
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/inotify.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/syscall.h>
#include <signal.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#ifndef CODEX_AUTH_DIR
#define CODEX_AUTH_DIR "/codex"
#endif

#define AUTH_FILE "auth.json"
#define LIFECYCLE_FD_MIN 3
#define LIFECYCLE_FD_MAX 1024
#define LIFECYCLE_BUFFER_MAX 4096
#define SUPERVISOR_POLL_MS 50

static volatile sig_atomic_t stop_signal = 0;

static void request_stop(int signal_number) {
  stop_signal = signal_number;
}

static void install_parent_signal_handlers(void) {
  struct sigaction action;
  memset(&action, 0, sizeof(action));
  action.sa_handler = request_stop;
  sigemptyset(&action.sa_mask);
  action.sa_flags = 0;
  sigaction(SIGTERM, &action, NULL);
  sigaction(SIGINT, &action, NULL);
  sigaction(SIGHUP, &action, NULL);
}

static void restore_default_signal_handlers(void) {
  struct sigaction action;
  memset(&action, 0, sizeof(action));
  action.sa_handler = SIG_DFL;
  sigemptyset(&action.sa_mask);
  sigaction(SIGTERM, &action, NULL);
  sigaction(SIGINT, &action, NULL);
  sigaction(SIGHUP, &action, NULL);
}

static int bind_launcher_to_parent(void) {
  pid_t parent = getppid();
  // The launcher must outlive neither Gate nor its child process group. Unlike
  // the child, it needs a catchable signal so its existing handler can kill and
  // reap the group before it exits. Re-checking ppid closes the prctl race.
  if (parent <= 1) {
    errno = ESRCH;
    return -1;
  }
  if (prctl(PR_SET_PDEATHSIG, SIGTERM) != 0) return -1;
  if (getppid() != parent) {
    errno = ESRCH;
    return -1;
  }
  return 0;
}

static int establish_child_group(pid_t child) {
  for (;;) {
    if (setpgid(child, child) == 0) return 0;
    if (errno == EINTR) continue;
    // The child may have completed its identical setpgid call first.
    if ((errno == EACCES || errno == EPERM) && getpgid(child) == child) return 0;
    return -1;
  }
}

static int listed_fd(const char *value, int fd) {
  if (!value) return 0;
  while (*value) {
    char *end = NULL;
    errno = 0;
    long candidate = strtol(value, &end, 10);
    if (end == value || errno || candidate < 3 || candidate > 1024) return 0;
    if (candidate == fd) return 1;
    if (*end == '\0') return 0;
    if (*end != ',') return 0;
    value = end + 1;
  }
  return 0;
}

static void close_inherited_fds(int keep) {
  struct rlimit limit;
  rlim_t max = getrlimit(RLIMIT_NOFILE, &limit) == 0 ? limit.rlim_cur : 1024;
  if (max == RLIM_INFINITY || max > 4096) max = 4096;
  const char *keep_fds = getenv("CODEX_KEEP_FDS");
  for (int fd = 3; fd < (int)max; ++fd) {
    if (fd != keep && !listed_fd(keep_fds, fd)) close(fd);
  }
}

static const char *auth_dir(void) {
  const char *configured = getenv("CODEX_AUTH_DIR");
  if (configured && configured[0] == '/') return configured;
  return CODEX_AUTH_DIR;
}

static void remove_auth(const char *dir) {
  char path[512];
  int n = snprintf(path, sizeof(path), "%s/%s", dir, AUTH_FILE);
  if (n > 0 && (size_t)n < sizeof(path)) unlink(path);
}

static int keep_persistent_auth(void) {
  const char *value = getenv("CODEX_AUTH_PERSIST");
  return value && strcmp(value, "1") == 0;
}

// Supervised mode is opt-in while the Gate wiring rolls out. In that mode the
// auth launcher, not Node, owns the lifecycle pipes so a writable sandbox can
// never start until this native process has a non-reusable pidfd for its PID
// namespace init.
static int supervised_bwrap_enabled(void) {
  const char *value = getenv("CODEX_BWRAP_SUPERVISE");
  return value && strcmp(value, "1") == 0;
}

struct lifecycle_fds {
  int info_fd;
  int status_fd;
  int block_fd;
};

struct lifecycle_stream {
  int fd;
  char data[LIFECYCLE_BUFFER_MAX + 1];
  size_t used;
  int eof;
};

static int parse_lifecycle_fd(const char *value, int *out) {
  if (!value || !*value || !out) {
    errno = EINVAL;
    return -1;
  }
  char *end = NULL;
  errno = 0;
  long parsed = strtol(value, &end, 10);
  if (errno || end == value || *end || parsed < LIFECYCLE_FD_MIN || parsed > LIFECYCLE_FD_MAX) {
    errno = EINVAL;
    return -1;
  }
  *out = (int)parsed;
  return 0;
}

static int lifecycle_option_matches(const char *arg, const char *name) {
  return strcmp(arg, name) == 0 ||
    (strncmp(arg, name, strlen(name)) == 0 && arg[strlen(name)] == '=');
}

// The command line is produced by buildBwrapReadJail. Refuse alternative
// lifecycle encodings and --args indirection: the supervisor must know every
// capability-bearing descriptor before it starts the setuid helper.
static int parse_supervised_bwrap_args(int argc, char *argv[], struct lifecycle_fds *out) {
  if (!out || argc < 4 || strcmp(argv[1], "/usr/bin/bwrap") != 0) {
    errno = EINVAL;
    return -1;
  }
  int seen_info = 0;
  int seen_status = 0;
  int seen_block = 0;
  int seen_pid_namespace = 0;
  int seen_die_with_parent = 0;
  int separator = 0;
  memset(out, 0, sizeof(*out));
  for (int i = 2; i < argc; ++i) {
    const char *arg = argv[i];
    if (strcmp(arg, "--") == 0) {
      separator = 1;
      if (i + 1 >= argc) {
        errno = EINVAL;
        return -1;
      }
      break;
    }
    if (strcmp(arg, "--unshare-pid") == 0) {
      seen_pid_namespace = 1;
      continue;
    }
    if (strcmp(arg, "--die-with-parent") == 0) {
      seen_die_with_parent = 1;
      continue;
    }
    if (strcmp(arg, "--as-pid-1") == 0 || strcmp(arg, "--args") == 0 ||
        strncmp(arg, "--args=", 7) == 0 || strcmp(arg, "--userns-block-fd") == 0 ||
        strncmp(arg, "--userns-block-fd=", 18) == 0) {
      errno = EINVAL;
      return -1;
    }
    int *slot = NULL;
    int *seen = NULL;
    if (lifecycle_option_matches(arg, "--info-fd")) {
      slot = &out->info_fd;
      seen = &seen_info;
    } else if (lifecycle_option_matches(arg, "--json-status-fd")) {
      slot = &out->status_fd;
      seen = &seen_status;
    } else if (lifecycle_option_matches(arg, "--block-fd")) {
      slot = &out->block_fd;
      seen = &seen_block;
    }
    if (!slot) continue;
    // buildBwrapReadJail uses the two-token form. Reject --name=value so a
    // future Bubblewrap parser cannot reinterpret a descriptor we did not map.
    if (strchr(arg, '=') || *seen || ++i >= argc || strcmp(argv[i], "--") == 0 ||
        parse_lifecycle_fd(argv[i], slot) != 0) {
      errno = EINVAL;
      return -1;
    }
    *seen = 1;
  }
  if (!separator || !seen_info || !seen_status || !seen_block || !seen_pid_namespace ||
      !seen_die_with_parent || out->info_fd == out->status_fd ||
      out->info_fd == out->block_fd || out->status_fd == out->block_fd) {
    errno = EINVAL;
    return -1;
  }
  return 0;
}

static int set_nonblocking(int fd) {
  int flags = fcntl(fd, F_GETFL);
  if (flags < 0) return -1;
  return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

static int drain_lifecycle_stream(struct lifecycle_stream *stream) {
  for (;;) {
    if (stream->used >= LIFECYCLE_BUFFER_MAX) {
      errno = EOVERFLOW;
      return -1;
    }
    ssize_t read_bytes = read(stream->fd, stream->data + stream->used,
      LIFECYCLE_BUFFER_MAX - stream->used);
    if (read_bytes > 0) {
      if (memchr(stream->data + stream->used, '\0', (size_t)read_bytes)) {
        errno = EPROTO;
        return -1;
      }
      stream->used += (size_t)read_bytes;
      stream->data[stream->used] = '\0';
      continue;
    }
    if (read_bytes == 0) {
      stream->eof = 1;
      return 0;
    }
    if (errno == EINTR) continue;
    if (errno == EAGAIN || errno == EWOULDBLOCK) return 0;
    return -1;
  }
}

// Returns 0 for one complete child-pid member, 1 while the document is still
// incomplete, and -1 for malformed/ambiguous data. The caller waits for info
// EOF and the first JSON-status line before treating the value as authority.
static int extract_child_pid(const char *data, size_t used, pid_t *out) {
  static const char key[] = "\"child-pid\"";
  if (!data || !out || used == 0 || used > LIFECYCLE_BUFFER_MAX) {
    errno = EPROTO;
    return -1;
  }
  const char *match = strstr(data, key);
  if (!match) return 1;
  if (strstr(match + sizeof(key) - 1, key)) {
    errno = EPROTO;
    return -1;
  }
  const char *at = match + sizeof(key) - 1;
  while (isspace((unsigned char)*at)) ++at;
  if (*at != ':') {
    errno = EPROTO;
    return -1;
  }
  ++at;
  while (isspace((unsigned char)*at)) ++at;
  if (!isdigit((unsigned char)*at)) return 1;
  long value = 0;
  while (isdigit((unsigned char)*at)) {
    int digit = *at - '0';
    if (value > (LONG_MAX - digit) / 10) {
      errno = EPROTO;
      return -1;
    }
    value = value * 10 + digit;
    ++at;
  }
  if (value < 2 || value > INT_MAX) {
    errno = EPROTO;
    return -1;
  }
  // The Bubblewrap documents are complete JSON objects. Do not arm from a
  // partial write that happens to contain the digits of a PID.
  if (!strchr(at, '}')) return 1;
  *out = (pid_t)value;
  return 0;
}

static int pidfd_open_exact(pid_t pid) {
#ifdef SYS_pidfd_open
  return (int)syscall(SYS_pidfd_open, pid, 0U);
#else
  (void)pid;
  errno = ENOSYS;
  return -1;
#endif
}

static int pidfd_send_exact(int pidfd, int signal_number) {
#ifdef SYS_pidfd_send_signal
  return (int)syscall(SYS_pidfd_send_signal, pidfd, signal_number, NULL, 0U);
#else
  (void)pidfd;
  (void)signal_number;
  errno = ENOSYS;
  return -1;
#endif
}

static int pidfd_is_readable(int pidfd, int timeout_ms) {
  struct pollfd poll_fd = { .fd = pidfd, .events = POLLIN };
  int ready;
  do {
    ready = poll(&poll_fd, 1, timeout_ms);
  } while (ready < 0 && errno == EINTR);
  if (ready == 0) return 0;
  if (ready < 0 || (poll_fd.revents & (POLLERR | POLLNVAL))) return -1;
  return (poll_fd.revents & (POLLIN | POLLHUP)) ? 1 : 0;
}

static int wait_for_pidfd_exit(int pidfd) {
  for (;;) {
    int exited = pidfd_is_readable(pidfd, SUPERVISOR_POLL_MS);
    if (exited != 0) return exited > 0 ? 0 : -1;
  }
}

// /proc/self/fdinfo/<pidfd> describes the process held by the pidfd itself,
// not a fresh numeric-PID lookup. Requiring NSpid's final component to be 1
// proves this exact handle targets the new PID namespace init.
static int pidfd_targets_new_namespace_init(int pidfd, pid_t expected_pid) {
  char path[64];
  char buffer[LIFECYCLE_BUFFER_MAX + 1];
  int length = snprintf(path, sizeof(path), "/proc/self/fdinfo/%d", pidfd);
  if (length < 0 || (size_t)length >= sizeof(path)) {
    errno = ENAMETOOLONG;
    return -1;
  }
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return -1;
  ssize_t read_bytes;
  do {
    read_bytes = read(fd, buffer, LIFECYCLE_BUFFER_MAX);
  } while (read_bytes < 0 && errno == EINTR);
  int saved_errno = errno;
  close(fd);
  if (read_bytes <= 0 || read_bytes == LIFECYCLE_BUFFER_MAX) {
    errno = read_bytes < 0 ? saved_errno : EPROTO;
    return -1;
  }
  buffer[read_bytes] = '\0';
  int pid_matches = 0;
  int nspid_count = 0;
  long nspid_last = 0;
  char *line = buffer;
  while (*line) {
    char *next = strchr(line, '\n');
    if (next) *next = '\0';
    if (strncmp(line, "Pid:", 4) == 0) {
      char *at = line + 4;
      while (isspace((unsigned char)*at)) ++at;
      char *end = NULL;
      errno = 0;
      long value = strtol(at, &end, 10);
      if (!errno && end != at && value == expected_pid) pid_matches = 1;
    } else if (strncmp(line, "NSpid:", 6) == 0) {
      char *at = line + 6;
      while (*at) {
        while (isspace((unsigned char)*at)) ++at;
        if (!*at) break;
        char *end = NULL;
        errno = 0;
        long value = strtol(at, &end, 10);
        if (errno || end == at || value < 1 || value > INT_MAX) {
          errno = EPROTO;
          return -1;
        }
        nspid_last = value;
        ++nspid_count;
        at = end;
      }
    }
    if (!next) break;
    line = next + 1;
  }
  if (!pid_matches || nspid_count < 2 || nspid_last != 1) {
    errno = EPROTO;
    return -1;
  }
  return 0;
}

static int preflight_pidfd_support(void) {
  int pidfd = pidfd_open_exact(getpid());
  if (pidfd < 0) return -1;
  int result = pidfd_send_exact(pidfd, 0);
  int saved_errno = errno;
  close(pidfd);
  if (result != 0) {
    errno = saved_errno;
    return -1;
  }
  return 0;
}

struct supervised_bwrap {
  pid_t bwrap_pid;
  int info_read;
  int status_read;
  int block_write;
};

static void close_fd(int *fd) {
  if (*fd >= 0) close(*fd);
  *fd = -1;
}

static int lifecycle_target_fd(int fd, const struct lifecycle_fds *fds) {
  return fd == fds->info_fd || fd == fds->status_fd || fd == fds->block_fd;
}

// Duplicate every source before writing any requested descriptor number. That
// prevents an arbitrary ordering such as info=5/status=3/block=4 from making
// one dup2 overwrite another pipe end.
static int duplicate_away_from_lifecycle_targets(int fd, const struct lifecycle_fds *fds) {
  int minimum = LIFECYCLE_FD_MIN;
  for (;;) {
    int duplicate = fcntl(fd, F_DUPFD_CLOEXEC, minimum);
    if (duplicate < 0) return -1;
    if (!lifecycle_target_fd(duplicate, fds)) return duplicate;
    close(duplicate);
    if (duplicate == INT_MAX) {
      errno = EMFILE;
      return -1;
    }
    minimum = duplicate + 1;
  }
}

static void close_source_if_not_target(int fd, const struct lifecycle_fds *fds) {
  if (fd >= 0 && !lifecycle_target_fd(fd, fds)) close(fd);
}

static int install_bwrap_lifecycle_fds(int info_write, int status_write, int block_read,
  const struct lifecycle_fds *fds) {
  int safe_info = duplicate_away_from_lifecycle_targets(info_write, fds);
  if (safe_info < 0) return -1;
  int safe_status = duplicate_away_from_lifecycle_targets(status_write, fds);
  if (safe_status < 0) {
    close(safe_info);
    return -1;
  }
  int safe_block = duplicate_away_from_lifecycle_targets(block_read, fds);
  if (safe_block < 0) {
    close(safe_info);
    close(safe_status);
    return -1;
  }
  int result = 0;
  if (dup2(safe_info, fds->info_fd) < 0 ||
      dup2(safe_status, fds->status_fd) < 0 ||
      dup2(safe_block, fds->block_fd) < 0) result = -1;
  close(safe_info);
  close(safe_status);
  close(safe_block);
  close_source_if_not_target(info_write, fds);
  close_source_if_not_target(status_write, fds);
  close_source_if_not_target(block_read, fds);
  return result;
}

static int spawn_supervised_bwrap(char *argv[], const struct lifecycle_fds *fds,
  struct supervised_bwrap *out) {
  int info_pipe[2] = {-1, -1};
  int status_pipe[2] = {-1, -1};
  int block_pipe[2] = {-1, -1};
  memset(out, 0, sizeof(*out));
  out->bwrap_pid = -1;
  out->info_read = -1;
  out->status_read = -1;
  out->block_write = -1;
  if (pipe2(info_pipe, O_CLOEXEC) != 0 || pipe2(status_pipe, O_CLOEXEC) != 0 ||
      pipe2(block_pipe, O_CLOEXEC) != 0 || set_nonblocking(info_pipe[0]) != 0 ||
      set_nonblocking(status_pipe[0]) != 0) goto failure;
  pid_t child = fork();
  if (child < 0) goto failure;
  if (child == 0) {
    pid_t parent = getppid();
    restore_default_signal_handlers();
    close(info_pipe[0]);
    close(status_pipe[0]);
    close(block_pipe[1]);
    if (install_bwrap_lifecycle_fds(info_pipe[1], status_pipe[1], block_pipe[0], fds) != 0 ||
        prctl(PR_SET_PDEATHSIG, SIGKILL) != 0 || prctl(PR_SET_DUMPABLE, 0) != 0 ||
        getppid() != parent) _exit(70);
    execvp(argv[1], &argv[1]);
    perror("codex-auth-once: supervised bwrap exec");
    _exit(127);
  }
  close(info_pipe[1]);
  close(status_pipe[1]);
  close(block_pipe[0]);
  out->bwrap_pid = child;
  out->info_read = info_pipe[0];
  out->status_read = status_pipe[0];
  out->block_write = block_pipe[1];
  return 0;

failure:
  close_fd(&info_pipe[0]);
  close_fd(&info_pipe[1]);
  close_fd(&status_pipe[0]);
  close_fd(&status_pipe[1]);
  close_fd(&block_pipe[0]);
  close_fd(&block_pipe[1]);
  return -1;
}

static int write_block_gate(int fd) {
  const char byte = '1';
  ssize_t written;
  do {
    written = write(fd, &byte, sizeof(byte));
  } while (written < 0 && errno == EINTR);
  return written == (ssize_t)sizeof(byte) ? 0 : -1;
}

static int wait_direct_bwrap(pid_t child, int *status) {
  int elapsed = 0;
  int sent_kill = 0;
  for (;;) {
    pid_t waited = waitpid(child, status, WNOHANG);
    if (waited == child) return 0;
    if (waited < 0 && errno != EINTR) return -1;
    // This PID remains a direct unreaped child, so this is the only numeric
    // signal in supervised mode and it cannot target a recycled host process.
    if (!sent_kill && elapsed >= 1000) {
      if (kill(child, SIGKILL) != 0 && errno != ESRCH) return -1;
      sent_kill = 1;
    }
    usleep(SUPERVISOR_POLL_MS * 1000);
    elapsed += SUPERVISOR_POLL_MS;
  }
}

static int terminate_armed_bwrap(int pidfd, pid_t bwrap_pid, int *bwrap_status,
  int *bwrap_reaped) {
  if (pidfd_send_exact(pidfd, SIGKILL) != 0 && errno != ESRCH) return -1;
  if (wait_for_pidfd_exit(pidfd) != 0) return -1;
  if (!*bwrap_reaped) {
    if (wait_direct_bwrap(bwrap_pid, bwrap_status) != 0) return -1;
    *bwrap_reaped = 1;
  }
  return 0;
}

// Bubblewrap's --block-fd treats EOF as permission to continue, so terminate
// its direct child before this supervisor exits. The nonzero exit leaves Gate's
// durable claim quarantined; it must never look like a completed run.
static void hold_closed_prearm_gate(pid_t bwrap_pid, int *bwrap_status, int *bwrap_reaped,
  int block_write, const char *reason) {
  fprintf(stderr, "codex-auth-once: supervised Bubblewrap held before arm: %s\n", reason);
  if (!*bwrap_reaped) {
    // The command is still blocked before Bubblewrap's setsid()/exec path.
    // bwrap_pid is direct and unreaped here, so this cannot hit PID reuse.
    if (kill(bwrap_pid, SIGKILL) == 0 || errno == ESRCH) {
      while (waitpid(bwrap_pid, bwrap_status, 0) < 0 && errno == EINTR) {}
      *bwrap_reaped = 1;
    }
  }
  (void)block_write;
  _exit(70);
}

static void hold_after_arm_failure(int pidfd, pid_t bwrap_pid, int *bwrap_status,
  int *bwrap_reaped, const char *reason) {
  fprintf(stderr, "codex-auth-once: supervised Bubblewrap teardown unproven: %s\n", reason);
  for (;;) {
    if (terminate_armed_bwrap(pidfd, bwrap_pid, bwrap_status, bwrap_reaped) == 0) return;
    sleep(1);
  }
}

static int status_child_pid(struct lifecycle_stream *status, pid_t *out) {
  char *newline = memchr(status->data, '\n', status->used);
  if (!newline) return status->eof ? -1 : 1;
  size_t line_length = (size_t)(newline - status->data);
  char saved = status->data[line_length];
  status->data[line_length] = '\0';
  int result = extract_child_pid(status->data, line_length, out);
  status->data[line_length] = saved;
  return result;
}

static int status_from_wait(int status) {
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  return WIFSIGNALED(status) ? 128 + WTERMSIG(status) : 70;
}

static void close_supervised_bwrap(struct supervised_bwrap *process) {
  close_fd(&process->info_read);
  close_fd(&process->status_read);
  close_fd(&process->block_write);
}

static int poll_lifecycle_streams(struct lifecycle_stream *info,
  struct lifecycle_stream *status) {
  struct pollfd poll_fds[2] = {
    { .fd = info->fd, .events = POLLIN },
    { .fd = status->fd, .events = POLLIN },
  };
  int ready;
  do {
    ready = poll(poll_fds, 2, SUPERVISOR_POLL_MS);
  } while (ready < 0 && errno == EINTR);
  return ready < 0 ? -1 : 0;
}

static int cancel_armed_bwrap(int pidfd, struct supervised_bwrap *process,
  int *bwrap_status, int *bwrap_reaped, int signal_number) {
  if (terminate_armed_bwrap(pidfd, process->bwrap_pid, bwrap_status, bwrap_reaped) != 0) {
    hold_after_arm_failure(pidfd, process->bwrap_pid, bwrap_status, bwrap_reaped,
      "pidfd cancellation did not prove the namespace exited");
  }
  close_supervised_bwrap(process);
  close(pidfd);
  return 128 + signal_number;
}

static int run_supervised_bwrap(int argc, char *argv[], const struct lifecycle_fds *fds) {
  (void)argc;
  struct supervised_bwrap process;
  if (spawn_supervised_bwrap(argv, fds, &process) != 0) {
    perror("codex-auth-once: supervised bwrap pipes");
    return 70;
  }
  struct lifecycle_stream info = { .fd = process.info_read, .used = 0, .eof = 0 };
  struct lifecycle_stream status = { .fd = process.status_read, .used = 0, .eof = 0 };
  int bwrap_status = 70;
  int bwrap_reaped = 0;
  int armed = 0;
  int info_ready = 0;
  int status_ready = 0;
  int pidfd = -1;
  pid_t info_pid = -1;
  pid_t status_pid = -1;

  for (;;) {
    int info_drained = drain_lifecycle_stream(&info);
    int status_drained = drain_lifecycle_stream(&status);
    if (!bwrap_reaped) {
      pid_t waited = waitpid(process.bwrap_pid, &bwrap_status, WNOHANG);
      if (waited == process.bwrap_pid) bwrap_reaped = 1;
      else if (waited < 0 && errno != EINTR) {
        if (!armed) hold_closed_prearm_gate(process.bwrap_pid, &bwrap_status, &bwrap_reaped,
          process.block_write, "direct Bubblewrap child cannot be observed");
        hold_after_arm_failure(pidfd, process.bwrap_pid, &bwrap_status, &bwrap_reaped,
          "direct Bubblewrap child cannot be observed");
      }
    }

    if (!armed) {
      if (info_drained != 0 || status_drained != 0) {
        hold_closed_prearm_gate(process.bwrap_pid, &bwrap_status, &bwrap_reaped,
          process.block_write, "lifecycle pipe failed before pidfd arm");
      }
      if (info.eof && !info_ready) {
        int parsed = extract_child_pid(info.data, info.used, &info_pid);
        if (parsed != 0) {
          hold_closed_prearm_gate(process.bwrap_pid, &bwrap_status, &bwrap_reaped,
            process.block_write, "info-fd did not provide one complete child-pid");
        }
        info_ready = 1;
      }
      if (!status_ready) {
        int parsed = status_child_pid(&status, &status_pid);
        if (parsed < 0) {
          hold_closed_prearm_gate(process.bwrap_pid, &bwrap_status, &bwrap_reaped,
            process.block_write, "json-status-fd did not provide one complete child-pid");
        }
        if (parsed == 0) status_ready = 1;
      }
      if (info_ready && status_ready) {
        if (info_pid != status_pid || bwrap_reaped) {
          hold_closed_prearm_gate(process.bwrap_pid, &bwrap_status, &bwrap_reaped,
            process.block_write, "lifecycle child-pid mismatch or early Bubblewrap exit");
        }
        pidfd = pidfd_open_exact(info_pid);
        if (pidfd < 0 || pidfd_is_readable(pidfd, 0) != 0 ||
            pidfd_targets_new_namespace_init(pidfd, info_pid) != 0) {
          if (pidfd >= 0) close(pidfd);
          hold_closed_prearm_gate(process.bwrap_pid, &bwrap_status, &bwrap_reaped,
            process.block_write, "unable to arm a pidfd for the new PID namespace init");
        }
        if (stop_signal) {
          return cancel_armed_bwrap(pidfd, &process, &bwrap_status, &bwrap_reaped, stop_signal);
        }
        if (write_block_gate(process.block_write) != 0) {
          if (terminate_armed_bwrap(pidfd, process.bwrap_pid, &bwrap_status, &bwrap_reaped) != 0) {
            hold_after_arm_failure(pidfd, process.bwrap_pid, &bwrap_status, &bwrap_reaped,
              "the block gate could not be released or revoked safely");
          }
          close_supervised_bwrap(&process);
          close(pidfd);
          return 70;
        }
        close_fd(&process.block_write);
        armed = 1;
      }
      if (stop_signal) {
        if (pidfd >= 0) {
          return cancel_armed_bwrap(pidfd, &process, &bwrap_status, &bwrap_reaped, stop_signal);
        }
        hold_closed_prearm_gate(process.bwrap_pid, &bwrap_status, &bwrap_reaped,
          process.block_write, "parent died before a pidfd could be armed");
      }
      if (bwrap_reaped) {
        hold_closed_prearm_gate(process.bwrap_pid, &bwrap_status, &bwrap_reaped,
          process.block_write, "Bubblewrap exited before a pidfd could be armed");
      }
      if (poll_lifecycle_streams(&info, &status) != 0) {
        hold_closed_prearm_gate(process.bwrap_pid, &bwrap_status, &bwrap_reaped,
          process.block_write, "lifecycle poll failed before pidfd arm");
      }
      continue;
    }

    if (info_drained != 0 || status_drained != 0) {
      if (terminate_armed_bwrap(pidfd, process.bwrap_pid, &bwrap_status, &bwrap_reaped) != 0) {
        hold_after_arm_failure(pidfd, process.bwrap_pid, &bwrap_status, &bwrap_reaped,
          "lifecycle pipe failed after pidfd arm");
      }
      close_supervised_bwrap(&process);
      close(pidfd);
      return 70;
    }
    if (stop_signal) {
      return cancel_armed_bwrap(pidfd, &process, &bwrap_status, &bwrap_reaped, stop_signal);
    }
    int namespace_exited = pidfd_is_readable(pidfd, 0);
    if (namespace_exited < 0) {
      hold_after_arm_failure(pidfd, process.bwrap_pid, &bwrap_status, &bwrap_reaped,
        "pidfd status became unreadable");
      close_supervised_bwrap(&process);
      close(pidfd);
      return 70;
    }
    if (namespace_exited > 0) {
      if (!bwrap_reaped && wait_direct_bwrap(process.bwrap_pid, &bwrap_status) != 0) {
        hold_after_arm_failure(pidfd, process.bwrap_pid, &bwrap_status, &bwrap_reaped,
          "PID namespace exited but Bubblewrap was not reaped");
      }
      bwrap_reaped = 1;
      close_supervised_bwrap(&process);
      close(pidfd);
      return status_from_wait(bwrap_status);
    }
    if (bwrap_reaped) {
      // A monitor exit while the namespace init still lives is never normal.
      // pidfd retains the exact identity, so revoke it without numeric PID use.
      if (terminate_armed_bwrap(pidfd, process.bwrap_pid, &bwrap_status, &bwrap_reaped) != 0) {
        hold_after_arm_failure(pidfd, process.bwrap_pid, &bwrap_status, &bwrap_reaped,
          "Bubblewrap exited while the PID namespace was still live");
      }
      close_supervised_bwrap(&process);
      close(pidfd);
      return 70;
    }
    if (poll_lifecycle_streams(&info, &status) != 0) {
      hold_after_arm_failure(pidfd, process.bwrap_pid, &bwrap_status, &bwrap_reaped,
        "lifecycle poll failed after pidfd arm");
      close_supervised_bwrap(&process);
      close(pidfd);
      return 70;
    }
  }
}

static void process_auth_watch(int watch_fd, const char *dir) {
  if (watch_fd < 0) return;
  struct pollfd poll_fd = { .fd = watch_fd, .events = POLLIN };
  int poll_ready;
  do {
    poll_ready = poll(&poll_fd, 1, SUPERVISOR_POLL_MS);
  } while (poll_ready < 0 && errno == EINTR && !stop_signal);
  if (poll_ready <= 0 || !(poll_fd.revents & POLLIN)) return;
  char buffer[4096] __attribute__((aligned(__alignof__(struct inotify_event))));
  ssize_t used = read(watch_fd, buffer, sizeof(buffer));
  for (char *at = buffer; used > 0 && at < buffer + used;) {
    struct inotify_event *event = (struct inotify_event *)at;
    if (event->len && strcmp(event->name, AUTH_FILE) == 0) remove_auth(dir);
    at += sizeof(*event) + event->len;
  }
}

static int run_supervised_launcher(int argc, char *argv[], const struct lifecycle_fds *fds,
  int watch_fd, const char *dir, int persistent_auth) {
  if (preflight_pidfd_support() != 0) {
    perror("codex-auth-once: pidfd support");
    return 70;
  }
  if (stop_signal) return 128 + stop_signal;
  pid_t supervisor = fork();
  if (supervisor < 0) {
    perror("codex-auth-once: supervised fork");
    return 70;
  }
  if (supervisor == 0) {
    // The parent may die while Bubblewrap is in its privileged setup. This
    // child owns the only block-pipe writer and must keep it open until it has
    // either a pidfd proof or a deliberately quarantined pre-arm failure.
    stop_signal = 0;
    if (watch_fd >= 0) close(watch_fd);
    install_parent_signal_handlers();
    if (bind_launcher_to_parent() != 0) _exit(70);
    _exit(run_supervised_bwrap(argc, argv, fds));
  }

  int status = 70;
  int forwarded_stop = 0;
  for (;;) {
    if (stop_signal && !forwarded_stop) {
      // supervisor is direct and unreaped until waitpid below; this is not a
      // process-group signal and cannot hit a recycled host PID.
      if (kill(supervisor, stop_signal) != 0 && errno != ESRCH) {
        perror("codex-auth-once: signal supervisor");
      }
      forwarded_stop = 1;
    }
    pid_t waited = waitpid(supervisor, &status, WNOHANG);
    if (waited == supervisor) break;
    if (waited < 0 && errno != EINTR) {
      status = 70 << 8;
      break;
    }
    process_auth_watch(watch_fd, dir);
  }
  if (!persistent_auth) remove_auth(dir);
  if (watch_fd >= 0) close(watch_fd);
  if (stop_signal) return 128 + stop_signal;
  return status_from_wait(status);
}

int main(int argc, char *argv[]) {
  if (argc < 2) {
    fprintf(stderr, "codex-auth-once: missing Codex command\n");
    return 64;
  }
  const int supervised = supervised_bwrap_enabled();
  struct lifecycle_fds lifecycle;
  if (supervised && parse_supervised_bwrap_args(argc, argv, &lifecycle) != 0) {
    fprintf(stderr, "codex-auth-once: invalid supervised Bubblewrap command\n");
    return 64;
  }
  const char *dir = auth_dir();
  const int persistent_auth = keep_persistent_auth();
  int watch_fd = -1;
  if (!persistent_auth) {
    watch_fd = inotify_init1(IN_CLOEXEC | IN_NONBLOCK);
    if (watch_fd < 0) {
      perror("codex-auth-once: inotify");
      return 70;
    }
    int watch = inotify_add_watch(watch_fd, dir,
      IN_OPEN | IN_CREATE | IN_MOVED_TO | IN_CLOSE_WRITE);
    if (watch < 0) {
      perror("codex-auth-once: watch auth directory");
      close(watch_fd);
      return 70;
    }
  }
  close_inherited_fds(watch_fd);
  install_parent_signal_handlers();
  if (bind_launcher_to_parent() != 0) {
    perror("codex-auth-once: parent-death");
    if (watch_fd >= 0) close(watch_fd);
    return 70;
  }
  if (supervised) {
    return run_supervised_launcher(argc, argv, &lifecycle, watch_fd, dir, persistent_auth);
  }
  pid_t child = fork();
  if (child < 0) {
    perror("codex-auth-once: fork");
    if (watch_fd >= 0) close(watch_fd);
    return 70;
  }
  if (child == 0) {
    pid_t parent = getppid();
    restore_default_signal_handlers();
    // If Bubblewrap or this launcher dies, the Codex process group must not
    // outlive the board run. The post-prctl parent check closes the fork race.
    if (setpgid(0, 0) != 0
      || prctl(PR_SET_PDEATHSIG, SIGKILL) != 0
      || prctl(PR_SET_DUMPABLE, 0) != 0
      || getppid() != parent) _exit(70);
    execvp(argv[1], &argv[1]);
    perror("codex-auth-once: exec");
    _exit(127);
  }
  int status = 70;
  // Establish the group in the parent too. A cancellation that lands directly
  // after fork is recorded by the handler, then handled only after this group
  // is known to exist; it cannot escape a kill(-child, ... ) race.
  if (establish_child_group(child) != 0) {
    kill(child, SIGKILL);
    while (waitpid(child, &status, 0) < 0 && errno == EINTR) {}
    if (!persistent_auth) remove_auth(dir);
    if (watch_fd >= 0) close(watch_fd);
    return 70;
  }
  for (;;) {
    if (stop_signal) {
      if (kill(-child, stop_signal) != 0) kill(child, stop_signal);
      // A model subprocess can ignore TERM. Do not let it survive the board
      // timeout just because its direct Codex parent already exited.
      usleep(100000);
      if (kill(-child, SIGKILL) != 0) kill(child, SIGKILL);
      while (waitpid(child, &status, 0) < 0 && errno == EINTR) {}
      if (!persistent_auth) remove_auth(dir);
      if (watch_fd >= 0) close(watch_fd);
      return 128 + stop_signal;
    }
    int waited = waitpid(child, &status, WNOHANG);
    if (waited == child) break;
    if (waited < 0 && errno != EINTR) { status = 70 << 8; break; }
    struct pollfd poll_fd = { .fd = watch_fd, .events = POLLIN };
    int poll_ready = poll(watch_fd >= 0 ? &poll_fd : NULL, watch_fd >= 0 ? 1 : 0, 50);
    if (poll_ready > 0 && (poll_fd.revents & POLLIN)) {
      char buffer[4096] __attribute__((aligned(__alignof__(struct inotify_event))));
      ssize_t used = read(watch_fd, buffer, sizeof(buffer));
      for (char *at = buffer; used > 0 && at < buffer + used;) {
        struct inotify_event *event = (struct inotify_event *)at;
        if (event->len && strcmp(event->name, AUTH_FILE) == 0) remove_auth(dir);
        at += sizeof(*event) + event->len;
      }
    }
  }
  if (!persistent_auth) remove_auth(dir);
  if (watch_fd >= 0) close(watch_fd);
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  return WIFSIGNALED(status) ? 128 + WTERMSIG(status) : 70;
}
