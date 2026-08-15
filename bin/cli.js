#!/usr/bin/env node
// agenthost: move your Claude Code harness to a 24/7 box in your own Fly.io
// account. No AgentHost backend -- this CLI talks straight to flyctl.
import { parseFlags } from "../src/argv.js";
import { deployCommand } from "../src/commands/deploy.js";
import { statusCommand } from "../src/commands/status.js";
import { openCommand } from "../src/commands/open.js";
import { logsCommand } from "../src/commands/logs.js";
import { syncCommand } from "../src/commands/sync.js";
import { destroyCommand } from "../src/commands/destroy.js";
import { doctorCommand } from "../src/commands/doctor.js";
import { fleetCommand } from "../src/commands/fleet.js";
import { snapshotCommand } from "../src/commands/snapshot.js";
import { restoreCommand } from "../src/commands/restore.js";
import { restartCommand } from "../src/commands/restart.js";
import { modeCommand } from "../src/commands/mode.js";
import { onboardCommand } from "../src/commands/onboard.js";
import { bridgeCommand, validateBridgePort } from "../src/commands/bridge.js";
import { rotateKeyCommand } from "../src/commands/rotate-key.js";
import { resolveSecretInputs } from "../src/secret-input.js";

const HELP = `agenthost -- your Claude Code harness, on a 24/7 box in your own Fly.io account.

Usage:
  agenthost deploy --org <fly-org> [--app <name>] [--region iad]
                     [--oauth-token-env | --anthropic-key-env]
                     [--github-token-env] [--repos owner/repo,owner2/repo2]
                     [--env-from owner/repo:KEY=AGENTHOST_SECRET_NAME ...] [--include <path> ...]
                     [--pack <name> ...] [--legal [--training-opt-out-verified]]
                     [--agent hermes] [--no-hermes] [--no-codex] [--no-openclaw]
                     [--dry-run] [--yes]
                     (--agent hermes: [--with-kanban])
  agenthost status  [--app <name>]
  agenthost open    [--app <name>]
  agenthost logs    [--app <name>]
  agenthost fleet                                          # every box deployed from this machine
  agenthost doctor  [--app <name>]                         # read-only health checklist
  agenthost restart [--app <name>]                         # reboot the box (clears a stuck session; brain untouched)
  agenthost rotate-key [--app <name>] [--access-key-env] [--recover-missing-state]
                                                            # rotate the operator login key without rebuilding the image
  agenthost mode <growth|revert|status> [--app <name>]     # switch the box's mode: validates the pack, writes the volume,
                                                            # reboots, confirms (revert = back to the default engineering
                                                            # box; status = ask the box, then re-check its pack)
  agenthost snapshot [--app <name>]                        # back up the data volume (your brain)
  agenthost restore [--app <name>] [--list] [--snapshot <id>]  # new volume from a snapshot (non-destructive)
  agenthost sync    [--app <name>] [--include <path> ...] [--github-token-env] [--agent hermes]
                     [--pack <name> ...] [--no-hermes] [--no-codex] [--no-openclaw] [--dry-run]
                     (--agent hermes: [--with-kanban])
  agenthost onboard [--app <name>] [--dry-run]              # guided setup: finds Obsidian vaults + hook scripts,
                                                            # proposes the exact sync --include command, y/N per include
  agenthost bridge <port> [--app <name>] [--token-env | --no-token]
                                                            # publish a local service (vault API, dev server) at a stable
                                                            # public URL via Tailscale Funnel; the box gets BRIDGE_URL/
                                                            # BRIDGE_TOKEN and its agent discovers it via ~/BRIDGE.md
  agenthost bridge --off [--app <name>]                     # close the funnel + clear the box's bridge secrets
  agenthost bridge --status [--app <name>]                  # funnel state + whether the box carries the bridge
  agenthost destroy [--app <name>] [--yes]

Auth: put a value in AGENTHOST_CLAUDE_CODE_OAUTH_TOKEN and pass --oauth-token-env
(subscription-billed, the default), or use AGENTHOST_ANTHROPIC_API_KEY with
--anthropic-key-env (metered fallback). The CLI consumes and deletes that input
before starting pack, Fly, or Tailscale children. If the named variable is unset
in a terminal, AgentHost prompts with input hidden. Neither is required.
Credential and session files never migrate. Secret values are never accepted in argv.

Other secret inputs: --github-token-env uses AGENTHOST_GITHUB_TOKEN; --token-env
uses AGENTHOST_BRIDGE_TOKEN; --env-from owner/repo:KEY=AGENTHOST_SECRET_NAME reads
a dedicated AGENTHOST_SECRET_* variable. Each also falls back to a hidden prompt.
rotate-key reads AGENTHOST_ACCESS_KEY or prompts with input hidden. The key is
staged directly to Fly, never placed in argv, and saved locally only after Fly applies it.

--pack <name>: preload a curated AgentHost skill pack (e.g. --pack legal) onto the box.
--legal: Legal Mode for legal professionals -- preloads the legal pack AND requires that your
Claude usage runs under no-training terms: an API key passes automatically (commercial terms);
a subscription token requires verifying the training opt-out (claude.ai -> Settings -> Privacy)
and attesting with --training-opt-out-verified (or the interactive prompt).

onboard: the guided path -- vaults are read from Obsidian's own registry, hook scripts from
~/.claude/settings.json; nothing is included or deployed without your explicit yes per item.
`;

const argv = process.argv.slice(2);
const [cmd, ...rest] = argv;
const secretValueArgvFlags = [
  "--oauth-token", "--anthropic-key", "--github-token", "--env", "--token", "--access-key",
];
const secretValueArgvFlag = argv.find((arg) =>
  secretValueArgvFlags.some((flag) => arg === flag || arg.startsWith(`${flag}=`))
);
if (secretValueArgvFlag) {
  console.error(
    "Secret values on the command line are not supported. Use --oauth-token-env, " +
    "--anthropic-key-env, --github-token-env, --env-from, --token-env, or --access-key-env with " +
    "the dedicated environment variable named in `agenthost --help`.",
  );
  process.exit(1);
}
const secretSelectorWithValue = argv.find((arg) =>
  [
    "--oauth-token-env", "--anthropic-key-env", "--github-token-env", "--token-env",
    "--access-key-env",
  ].some((flag) => arg.startsWith(`${flag}=`))
);
const secretSelectorFlags = [
  "--oauth-token-env", "--anthropic-key-env", "--github-token-env", "--token-env", "--access-key-env",
];
const secretSelectorWithSeparateValue = argv.some((arg, index) =>
  secretSelectorFlags.includes(arg)
  && argv[index + 1] !== undefined
  && !argv[index + 1].startsWith("-")
);
if (secretSelectorWithValue || secretSelectorWithSeparateValue) {
  console.error(
    "Secret selector flags do not take command-line values. Set the dedicated " +
    "environment variable or pass the flag by itself for a hidden prompt.",
  );
  process.exit(1);
}
// Fail old automation before parsing: once removed from the boolean list, the
// retired switch would otherwise consume the next flag as its value and could
// accidentally turn an intended dry-run into a real deploy.
const retiredMigrationFlags = ["--migrate-auth", "--with-whatsapp", "--hermes-secrets-from-local"];
const retiredMigrationFlag = argv.find((arg) =>
  retiredMigrationFlags.some((flag) => arg === flag || arg.startsWith(`${flag}=`))
);
if (retiredMigrationFlag) {
  console.error(
    retiredMigrationFlag.startsWith("--with-whatsapp")
      ? "WhatsApp session migration is not supported. Link WhatsApp again from the cloud box."
      : retiredMigrationFlag.startsWith("--hermes-secrets-from-local")
        ? "Hermes credential-file migration is not supported. Set each required HERMESENV_<KEY> as an explicit Fly secret."
        : "Credential-file migration is not supported. Re-run deploy with --oauth-token-env " +
          "(preferred) or --anthropic-key-env instead."
  );
  process.exit(1);
}
const knownLongOptions = new Set([
  "--help",
  "--app", "--org", "--region", "--repos", "--agent", "--port", "--snapshot", "--name",
  "--dry-run", "--yes", "--with-kanban", "--hermes-only", "--no-hermes", "--no-codex",
  "--no-openclaw", "--list", "--legal", "--training-opt-out-verified", "--off", "--status",
  "--no-token", "--oauth-token-env", "--anthropic-key-env", "--github-token-env", "--token-env",
  "--access-key-env", "--recover-missing-state",
  "--env-from", "--include", "--pack",
]);
if (argv.some((arg) => arg.startsWith("--") && !knownLongOptions.has(arg))) {
  console.error("Unknown option. Run `agenthost --help` for the supported syntax.");
  process.exit(1);
}
const flags = parseFlags(rest, {
  boolean: [
    "dry-run", "yes", "with-kanban", "hermes-only", "no-hermes", "no-codex",
    "no-openclaw", "list", "legal", "training-opt-out-verified", "off", "status",
    "no-token", "oauth-token-env", "anthropic-key-env", "github-token-env", "token-env",
    "access-key-env", "recover-missing-state",
  ],
  array: ["env-from", "include", "pack"],
});
const positionalCount = flags._?.length ?? 0;
const allowsBridgePort = cmd === "bridge" && !flags.off && !flags.status;
// `agenthost mode <growth|revert|status>` takes its subcommand as a positional
// (same shape as bridge's port), so it never needs a new global boolean flag.
const takesPositional = allowsBridgePort || cmd === "mode";
if (
  (takesPositional && positionalCount > 1)
  || (!takesPositional && positionalCount > 0)
) {
  console.error(
    "Unexpected positional argument. Run `agenthost --help` for the supported syntax.",
  );
  process.exit(1);
}
if (allowsBridgePort) {
  try {
    validateBridgePort(flags._?.[0] ?? flags.port);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

const commands = {
  deploy: deployCommand,
  status: statusCommand,
  open: openCommand,
  logs: logsCommand,
  sync: syncCommand,
  onboard: onboardCommand,
  bridge: bridgeCommand,
  doctor: doctorCommand,
  restart: restartCommand,
  "rotate-key": rotateKeyCommand,
  mode: modeCommand,
  fleet: fleetCommand,
  snapshot: snapshotCommand,
  restore: restoreCommand,
  destroy: destroyCommand,
};

if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
  console.log(HELP);
  process.exit(cmd ? 0 : 1);
}

const fn = commands[cmd];
if (!fn) {
  console.error("Unknown command. Run `agenthost --help` for the supported commands.\n");
  console.log(HELP);
  process.exit(1);
}

try {
  if (cmd === "rotate-key") flags["access-key-env"] = true;
  const code = await fn(await resolveSecretInputs(flags, process.env));
  if (typeof code === "number") process.exit(code);
} catch (e) {
  console.error(`\nerror: ${e.message}`);
  process.exit(1);
}
