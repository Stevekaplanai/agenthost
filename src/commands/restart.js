import * as fly from "../fly.js";
import { resolveApp } from "./resolve-app.js";

// `agenthost restart` -- reboot the box's container. Clears any transient stuck
// state (a wedged session, a hung process) and re-reads auth on boot. The data
// volume (your brain: memories, skills, cron jobs, credentials) is untouched --
// only the running processes restart. This is the first thing to try when the
// terminal or chat stops responding.
export async function restartCommand(flags) {
  const app = resolveApp(flags);
  const ids = fly.machineIds(app);
  if (!ids.length) {
    console.error(`No machines found for '${app}'. Is the app name right? Try: agenthost fleet`);
    return 1;
  }
  console.log(`Restarting ${app} (${ids.length} machine${ids.length > 1 ? "s" : ""}). Your volume/brain is untouched.`);
  let failed = 0;
  for (const id of ids) {
    const res = fly.restartMachine(app, id);
    if (res.code !== 0) { failed++; console.error(`  ${id}: ${(res.stderr || res.stdout || "restart failed").trim()}`); }
    else console.log(`  ${id}: restarting`);
  }
  if (failed) return 1;
  console.log("Done. Give it ~30s, then reopen the terminal. If it's still stuck, run: agenthost doctor");
}
