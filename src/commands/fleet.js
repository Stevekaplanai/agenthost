import { listAppStates, loadLastApp } from "../state.js";

// `agenthost fleet` -- every box this machine has deployed, at a glance.
// Read-only over local state (~/.agenthost/*.json); no Fly calls, so it's
// instant and works offline. `deploy --app <name>` is how a fleet grows.

// Pure + exported for tests: rows -> printable lines.
export function formatFleet(states, lastApp) {
  if (!states.length) {
    return ["No boxes deployed from this machine yet.", "Start one:  agenthost deploy --org <your-fly-org>"];
  }
  const lines = [];
  for (const s of states) {
    const mark = s.app === lastApp ? "*" : " ";
    const when = String(s.updatedAt || "").slice(0, 16).replace("T", " ");
    const repos = Array.isArray(s.repos) && s.repos.length ? `  repos: ${s.repos.join(",")}` : "";
    lines.push(`${mark} ${s.app}  https://${s.app}.fly.dev  ${s.region || "?"}  ${when}${repos}`);
  }
  lines.push("");
  lines.push("* = default for status/open/logs/sync (pass --app to target another)");
  lines.push("Add a box:  agenthost deploy --app <new-name> --org <your-fly-org>");
  return lines;
}

export async function fleetCommand() {
  const lines = formatFleet(listAppStates(), loadLastApp());
  console.log(lines.join("\n"));
}
