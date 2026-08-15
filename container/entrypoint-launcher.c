/*
 * Loader-safe AgentHost root entry boundary.
 *
 * The container runtime starts this statically linked binary before any
 * dynamic loader, shell startup file, language loader, or PATH lookup can see
 * Fly's secret environment. It accepts only two fixed modes:
 *   no arguments  -> protected Bash running entrypoint.sh
 *   foundation    -> protected Node running maintenance-boot-entry.js
 */
#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

#ifndef AGENTHOST_ENTRYPOINT_SCRIPT
#define AGENTHOST_ENTRYPOINT_SCRIPT "/opt/agenthost/entrypoint.sh"
#elif !defined(AGENTHOST_LAUNCHER_TESTING)
#error "AGENTHOST_ENTRYPOINT_SCRIPT may only be overridden in the isolated launcher test build"
#endif

#define BASH_PATH "/usr/bin/bash"
#define NODE_PATH "/usr/local/bin/node"
#define FOUNDATION_SCRIPT "/opt/agenthost/maintenance-boot-entry.js"
#define FOUNDATION_ADDON "/opt/agenthost/maintenance-native.node"
#define MAX_ENV_ENTRIES 4096
#define MAX_ENV_NAME 512
#define MAX_PUSH_TOKEN 4096

extern char **environ;

static const char *const fixed_environment[] = {
  "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  "HOME=/root",
  "USER=root",
  "LOGNAME=root",
  "SHELL=/bin/bash",
  "LANG=C.UTF-8",
  NULL,
};

static const char *const allowed_names[] = {
  "AGENT_CMD",
  "AGENT_CHAT_HOOKS",
  "AGENTHOST_BRAND",
  "AGENTHOST_CANONICAL_HOST",
  "AGENTHOST_FOUNDATION_B",
  "AGENTHOST_MEMORY_FAILSAFE",
  "AGENTHOST_MEMORY_FAILSAFE_BOOT_GRACE_SECONDS",
  "AGENTHOST_MEMORY_FAILSAFE_CHECKPOINT_GRACE_SECONDS",
  "AGENTHOST_MEMORY_FAILSAFE_CONSECUTIVE_LOW_SAMPLES",
  "AGENTHOST_MEMORY_FAILSAFE_EMERGENCY_AVAILABLE_KB",
  "AGENTHOST_MEMORY_FAILSAFE_EMERGENCY_SWAP_FREE_KB",
  "AGENTHOST_MEMORY_FAILSAFE_HISTORY_INTERVAL_SECONDS",
  "AGENTHOST_MEMORY_FAILSAFE_HISTORY_LIMIT",
  "AGENTHOST_MEMORY_FAILSAFE_INTERVAL_SECONDS",
  "AGENTHOST_MEMORY_FAILSAFE_MIN_AVAILABLE_KB",
  "AGENTHOST_MEMORY_FAILSAFE_MIN_SWAP_FREE_KB",
  "AGENTHOST_MESH_PEERS",
  "AGENTHOST_PURGE_LEGACY_CLAUDE_CREDENTIALS",
  "AGENTHOST_SCHEDULER_TICK_MS",
  "ANTHROPIC_API_KEY",
  "BOARD_LOOP_ALERT",
  "BOARD_RUNNER",
  "BOARD_STUCK_ALERT",
  "BRIDGE_TOKEN",
  "BRIDGE_URL",
  "CHANNEL_DISPATCH_PORT",
  "CHANNEL_DISPATCH_TOKEN",
  "CHANNEL_HEALTH_WATCH",
  "CHECKOUT_WEBHOOK_SECRET",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "COLORTERM",
  "CURSOR_API_KEY",
  "DISCORD_BOT_TOKEN",
  "FLY_ALLOC_ID",
  "FLY_APP_NAME",
  "FLY_IMAGE_REF",
  "FLY_MACHINE_ID",
  "FLY_PROCESS_GROUP",
  "FLY_PUBLIC_IP",
  "FLY_REGION",
  "FLY_VM_MEMORY_MB",
  "GEMINI_API_KEY",
  "GITHUB_PERSONAL_ACCESS_TOKEN",
  "GITHUB_TOKEN",
  "GIT_PUSH_TOKEN",
  "GIT_USER_EMAIL",
  "GIT_USER_NAME",
  "HOSTNAME",
  "KANBAN_BRIDGE_LIFECYCLE_TOKEN",
  "KANBAN_BRIDGE_PORT",
  "KANBAN_BRIDGE_READ_TOKEN",
  "KANBAN_BRIDGE_USER",
  "KANBAN_BRIDGE_WRITE_TOKEN",
  "KIMI_API_KEY",
  "LEGAL_MODE",
  "MAIL_WEBHOOK_SECRET",
  "MAINT_DEBUG",
  /* The brain. Fly had all three deployed and the gate still reported "the
     brain is not connected yet" -- this allowlist was dropping them before
     the gate ever started, so /brain/api/memories answered 503 configured
     false and Brand DNA sat in demo mode. Verified on the live box
     2026-08-03: secrets present in `flyctl secrets list`, absent from the
     gate's env. GATE_KEY is non-admin (growth); PANEL_KEY is admin-scoped
     (the brain panel). The split is deliberate least privilege -- pass both
     through, keep them distinct. */
  "MEMORY_GATE_KEY",
  /* The engines' own keys, so a MEMORY: line an engine emits is filed under
     THAT engine's name -- the service takes the author from the key row and
     never from the request (deliberate: it stops one agent writing as
     another). Without these the gate cannot capture agent memories at all;
     with a shared key it would capture them under the wrong author, which is
     the exact defect the panel recovered from (Steve: "what is panel?"). */
  "MEMORY_KEY_CLAUDE",
  "MEMORY_KEY_CODEX",
  "MEMORY_KEY_CURSOR",
  "MEMORY_KEY_GEMINI",
  "MEMORY_KEY_HI",
  "MEMORY_KEY_KH",
  "MEMORY_KEY_KIMI",
  /* Steve's own key, so a memory HE types in the panel is filed under HIS
     name (2026-08-03: panel writes used to land in a lane called "panel").
     Reads act as Steve too; only DELETE keeps the admin PANEL_KEY. */
  "MEMORY_KEY_STEVE",
  "MEMORY_PANEL_KEY",
  "MEMORY_SERVICE_URL",
  "MOONSHOT_API_KEY",
  "NODE_ENV",
  "OLLAMA_API_KEY",
  "OLLAMA_LOCAL_MODEL",
  "OPENAI_API_KEY",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENROUTER_API_KEY",
  "PORT",
  "POSTHOG_PERSONAL_API_KEY",
  "POSTIZ_API_KEY",
  "PRIMARY_REGION",
  "REPOS",
  "RESEND_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "TERM",
  "TTYD_PASSWORD",
  "TZ",
  "WAKE_CHECKIN",
  NULL,
};

static int fail(const char *message, int code) {
  size_t length = strlen(message);
  while (length > 0) {
    ssize_t written = write(STDERR_FILENO, message, length);
    if (written < 0) {
      if (errno == EINTR) continue;
      break;
    }
    message += written;
    length -= (size_t)written;
  }
  return code;
}

static bool valid_environment_name(const char *name, size_t length) {
  if (length == 0 || length > MAX_ENV_NAME) return false;
  if (!((name[0] >= 'A' && name[0] <= 'Z') || name[0] == '_')) return false;
  for (size_t index = 1; index < length; index += 1) {
    char value = name[index];
    if (!((value >= 'A' && value <= 'Z') || (value >= '0' && value <= '9') || value == '_')) return false;
  }
  return true;
}

static bool has_prefix(const char *name, size_t length, const char *prefix) {
  size_t prefix_length = strlen(prefix);
  return length > prefix_length && memcmp(name, prefix, prefix_length) == 0;
}

static bool allowed_pattern(const char *name, size_t length) {
  if (has_prefix(name, length, "HERMESENV_")) return valid_environment_name(name, length);
  if (!has_prefix(name, length, "ENVF_")) return false;
  if (length > MAX_ENV_NAME) return false;

  size_t index = strlen("ENVF_");
  size_t digits = 0;
  while (index < length && name[index] >= '0' && name[index] <= '9') {
    index += 1;
    digits += 1;
  }
  if (digits == 0 || index + 2 >= length || name[index] != '_' || name[index + 1] != '_') return false;
  index += 2;
  if (!((name[index] >= 'A' && name[index] <= 'Z')
    || (name[index] >= 'a' && name[index] <= 'z') || name[index] == '_')) return false;
  for (; index < length; index += 1) {
    char value = name[index];
    if (!((value >= 'A' && value <= 'Z') || (value >= 'a' && value <= 'z')
      || (value >= '0' && value <= '9') || value == '_')) return false;
  }
  return true;
}

static bool allowed_exact(const char *name, size_t length) {
  for (size_t index = 0; allowed_names[index]; index += 1) {
    size_t candidate_length = strlen(allowed_names[index]);
    if (candidate_length == length && memcmp(name, allowed_names[index], length) == 0) return true;
  }
  return false;
}

static bool same_environment_name(const char *left, const char *right) {
  const char *left_equal = strchr(left, '=');
  const char *right_equal = strchr(right, '=');
  if (!left_equal || !right_equal) return false;
  size_t left_length = (size_t)(left_equal - left);
  return left_length == (size_t)(right_equal - right) && memcmp(left, right, left_length) == 0;
}

static bool valid_push_token(const char *value) {
  size_t length = strnlen(value, MAX_PUSH_TOKEN + 1);
  if (length == 0 || length > MAX_PUSH_TOKEN) return false;
  for (size_t index = 0; index < length; index += 1) {
    unsigned char byte = (unsigned char)value[index];
    if (byte < 0x21 || byte > 0x7e) return false;
  }
  return true;
}

static const char *environment_value(const char *name) {
  size_t name_length = strlen(name);
  for (size_t index = 0; environ[index]; index += 1) {
    const char *equal = strchr(environ[index], '=');
    if (equal && (size_t)(equal - environ[index]) == name_length
      && memcmp(environ[index], name, name_length) == 0) {
      return environ[index] + name_length + 1;
    }
  }
  return NULL;
}

static bool foundation_enabled(void) {
  const char *value = environment_value("AGENTHOST_FOUNDATION_B");
  return value && strcmp(value, "1") == 0;
}

static int construct_environment(char *output[MAX_ENV_ENTRIES], bool include_push_token) {
  size_t used = 0;
  for (size_t index = 0; fixed_environment[index]; index += 1) output[used++] = (char *)fixed_environment[index];

  for (size_t index = 0; environ[index]; index += 1) {
    const char *equal = strchr(environ[index], '=');
    if (!equal) continue;
    size_t name_length = (size_t)(equal - environ[index]);
    if (!allowed_exact(environ[index], name_length) && !allowed_pattern(environ[index], name_length)) continue;
    if (name_length == strlen("GIT_PUSH_TOKEN") && memcmp(environ[index], "GIT_PUSH_TOKEN", name_length) == 0) {
      if (!include_push_token || !valid_push_token(equal + 1)) continue;
    }
    if (used + 1 >= MAX_ENV_ENTRIES) return -1;
    for (size_t previous = 0; previous < used; previous += 1) {
      if (same_environment_name(output[previous], environ[index])) return -1;
    }
    output[used++] = environ[index];
  }
  output[used] = NULL;
  return 0;
}

static bool trusted_directory(const char *path) {
  int fd = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return false;
  struct stat state;
  bool trusted = fstat(fd, &state) == 0 && S_ISDIR(state.st_mode)
    && state.st_uid == 0 && state.st_gid == 0 && (state.st_mode & 0022) == 0;
  close(fd);
  return trusted;
}

static bool trusted_file(const char *path, bool executable) {
  int fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return false;
  struct stat state;
  bool trusted = fstat(fd, &state) == 0 && S_ISREG(state.st_mode)
    && state.st_uid == 0 && state.st_gid == 0 && state.st_nlink == 1
    && (state.st_mode & 0022) == 0 && (!executable || (state.st_mode & 0100) != 0);
  close(fd);
  return trusted;
}

static bool trusted_boot_paths(void) {
  return trusted_directory("/") && trusted_directory("/usr") && trusted_directory("/usr/bin")
    && trusted_directory("/opt") && trusted_directory("/opt/agenthost")
    && trusted_file(BASH_PATH, true) && trusted_file(AGENTHOST_ENTRYPOINT_SCRIPT, false);
}

static bool trusted_foundation_paths(void) {
  return trusted_directory("/") && trusted_directory("/usr") && trusted_directory("/usr/local")
    && trusted_directory("/usr/local/bin") && trusted_directory("/opt")
    && trusted_directory("/opt/agenthost") && trusted_file(NODE_PATH, true)
    && trusted_file(FOUNDATION_SCRIPT, false) && trusted_file(FOUNDATION_ADDON, false);
}

static int close_inherited_descriptors(void) {
#ifdef SYS_close_range
  if (syscall(SYS_close_range, 3U, ~0U, 0U) == 0) return 0;
  if (errno != ENOSYS && errno != EINVAL) return -1;
#endif
  struct rlimit limit;
  if (getrlimit(RLIMIT_NOFILE, &limit) != 0) return -1;
  rlim_t maximum = limit.rlim_cur == RLIM_INFINITY ? 1048576 : limit.rlim_cur;
  if (maximum > 1048576) maximum = 1048576;
  for (int fd = 3; (rlim_t)fd < maximum; fd += 1) close(fd);
  return 0;
}

int main(int argc, char *argv[]) {
  if (geteuid() != 0) return fail("agenthost-entrypoint: root authority required\n", 70);

  bool foundation_mode = argc == 2 && strcmp(argv[1], "foundation") == 0;
  if (argc != 1 && !foundation_mode) return fail("agenthost-entrypoint: invalid fixed mode\n", 64);
  if (foundation_mode && !foundation_enabled()) {
    return fail("agenthost-entrypoint: Foundation B is not enabled\n", 70);
  }

  char *safe_environment[MAX_ENV_ENTRIES];
  bool include_push_token = foundation_mode || foundation_enabled();
  if (construct_environment(safe_environment, include_push_token) != 0) {
    return fail("agenthost-entrypoint: invalid release environment\n", 70);
  }
  if (close_inherited_descriptors() != 0 || prctl(PR_SET_DUMPABLE, 0L, 0L, 0L, 0L) != 0) {
    return fail("agenthost-entrypoint: process hardening failed\n", 70);
  }

  if (foundation_mode) {
    if (!trusted_foundation_paths()) return fail("agenthost-entrypoint: unsafe Foundation path\n", 70);
    char *const node_argv[] = { (char *)NODE_PATH, (char *)FOUNDATION_SCRIPT, NULL };
    execve(NODE_PATH, node_argv, safe_environment);
    return fail("agenthost-entrypoint: Foundation exec failed\n", 127);
  }

  if (!trusted_boot_paths()) return fail("agenthost-entrypoint: unsafe boot path\n", 70);
  char *const bash_argv[] = { (char *)BASH_PATH, "-p", (char *)AGENTHOST_ENTRYPOINT_SCRIPT, NULL };
  execve(BASH_PATH, bash_argv, safe_environment);
  return fail("agenthost-entrypoint: boot exec failed\n", 127);
}
