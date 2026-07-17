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
import { onboardCommand } from "../src/commands/onboard.js";
import { bridgeCommand } from "../src/commands/bridge.js";

const HELP = `agenthost -- your Claude Code harness, on a 24/7 box in your own Fly.io account.

Usage:
  agenthost deploy --org <fly-org> [--app <name>] [--region iad]
                     [--oauth-token <claude setup-token output>] [--anthropic-key <key>]
                     [--github-token <pat>] [--repos owner/repo,owner2/repo2]
                     [--env owner/repo:KEY=VALUE ...] [--include <path> ...]
                     [--migrate-auth] [--pack <name> ...] [--legal [--training-opt-out-verified]]
                     [--agent hermes] [--dry-run] [--yes]
                     (--agent hermes: [--with-whatsapp] [--with-kanban] [--hermes-secrets-from-local])
  agenthost status  [--app <name>]
  agenthost open    [--app <name>]
  agenthost logs    [--app <name>]
  agenthost fleet                                          # every box deployed from this machine
  agenthost doctor  [--app <name>]                         # read-only health checklist
  agenthost restart [--app <name>]                         # reboot the box (clears a stuck session; brain untouched)
  agenthost snapshot [--app <name>]                        # back up the data volume (your brain)
  agenthost restore [--app <name>] [--list] [--snapshot <id>]  # new volume from a snapshot (non-destructive)
  agenthost sync    [--app <name>] [--include <path> ...] [--migrate-auth] [--github-token <pat>] [--agent hermes] [--dry-run]
                     (--agent hermes: [--with-whatsapp] [--with-kanban])
  agenthost onboard [--app <name>] [--dry-run]              # guided setup: finds Obsidian vaults + hook scripts,
                                                            # proposes the exact sync --include command, y/N per include
  agenthost bridge <port> [--app <name>] [--token <value> | --no-token]
                                                            # publish a local service (vault API, dev server) at a stable
                                                            # public URL via Tailscale Funnel; the box gets BRIDGE_URL/
                                                            # BRIDGE_TOKEN and its agent discovers it via ~/BRIDGE.md
  agenthost bridge --off [--app <name>]                     # close the funnel + clear the box's bridge secrets
  agenthost bridge --status [--app <name>]                  # funnel state + whether the box carries the bridge
  agenthost destroy [--app <name>] [--yes]

Auth: pass --oauth-token (from \`claude setup-token\`, subscription-billed, the default)
or --anthropic-key (metered fallback). Neither is required; the box boots a shell without one.
--migrate-auth: also carry your local ~/.claude/.credentials.json (MCP OAuth tokens + agent
auth) to the box via Fly's encrypted secret store -- opt-in; some host-bound tokens may still
need re-auth on the box (use the mobile terminal's link button to finish those).

--pack <name>: preload a curated AgentHost skill pack (e.g. --pack legal) onto the box.
--legal: Legal Mode for legal professionals -- preloads the legal pack AND requires that your
Claude usage runs under no-training terms: an API key passes automatically (commercial terms);
a subscription token requires verifying the training opt-out (claude.ai -> Settings -> Privacy)
and attesting with --training-opt-out-verified (or the interactive prompt).

onboard: the guided path -- vaults are read from Obsidian's own registry, hook scripts from
~/.claude/settings.json; nothing is included or deployed without your explicit yes per item.
`;

const [cmd, ...rest] = process.argv.slice(2);
const flags = parseFlags(rest, {
  boolean: ["dry-run", "yes", "with-whatsapp", "with-kanban", "hermes-secrets-from-local", "hermes-only", "migrate-auth", "list", "legal", "training-opt-out-verified", "off", "status", "no-token"],
  array: ["env", "include", "pack"],
});

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
  console.error(`Unknown command '${cmd}'.\n`);
  console.log(HELP);
  process.exit(1);
}

try {
  const code = await fn(flags);
  if (typeof code === "number") process.exit(code);
} catch (e) {
  console.error(`\nerror: ${e.message}`);
  process.exit(1);
}
