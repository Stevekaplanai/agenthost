import * as fly from "../fly.js";
import { resolveApp } from "./resolve-app.js";
import { loadAppState } from "../state.js";

// `agenthost snapshot` -- take a point-in-time snapshot of the box's data
// volume (your whole ~/.claude harness, cron history, credentials). Fly keeps
// snapshots ~5 days; this is the "my brain is safe" button.
export async function snapshotCommand(flags) {
  const app = resolveApp(flags);
  const volId = fly.dataVolumeId(app);
  if (!volId) throw new Error(`no data volume found for '${app}' (has it been deployed?)`);
  console.log(`Snapshotting volume ${volId} on '${app}'...`);
  fly.createSnapshot(volId);
  // Show what's now available so the user has an id for restore.
  const snaps = fly.snapshotsJson(volId).slice(-5);
  console.log("\nSnapshots (most recent last):");
  for (const s of snaps) {
    console.log(`  ${s.id || s.ID}   ${s.created_at || s.createdAt || ""}   ${s.size || s.Size || ""}`);
  }
  console.log(`\nRestore later with:\n  agenthost restore --app ${app} --snapshot <id>`);
}
