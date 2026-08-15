import * as fly from "../fly.js";
import { resolveApp } from "./resolve-app.js";
import { loadAppState } from "../state.js";

// `agenthost restore` -- restore is deliberately NON-destructive: it creates a
// NEW volume from a snapshot and tells you how to point the machine at it. It
// never overwrites or deletes your live volume, so a botched restore can't cost
// you the current state. `--list` shows the snapshots you can pick from.
export async function restoreCommand(flags) {
  const app = resolveApp(flags);
  const volId = fly.dataVolumeId(app);
  if (!volId) throw new Error(`no data volume found for '${app}'`);

  if (flags.list || !flags.snapshot) {
    const snaps = fly.snapshotsJson(volId);
    if (!snaps.length) { console.log(`No snapshots for '${app}'. Take one with: agenthost snapshot --app ${app}`); return; }
    console.log(`Snapshots for '${app}' (volume ${volId}):\n`);
    for (const s of snaps) {
      console.log(`  ${s.id || s.ID}   ${s.created_at || s.createdAt || ""}   ${s.size || s.Size || ""}`);
    }
    if (!flags.snapshot) {
      console.log(`\nRestore one into a new volume with:\n  agenthost restore --app ${app} --snapshot <id>`);
      return;
    }
  }

  const region = flags.region || loadAppState(app)?.region || "iad";
  const newName = flags.name || `data_restore`;
  console.log(`Creating a new volume '${newName}' from snapshot ${flags.snapshot} (${region})...`);
  console.log("(non-destructive: your current 'data' volume is untouched)");
  fly.createVolumeFromSnapshot(app, newName, flags.snapshot, region);

  console.log(`\nDone. A new volume '${newName}' now holds the restored harness.`);
  console.log("To boot the box from it, swap the machine's mount to the new volume:");
  console.log(`  1. flyctl machine list -a ${app}          # find the machine id`);
  console.log(`  2. flyctl machine update <id> -a ${app} \\`);
  console.log(`       --vm-memory 2048 --volume ${newName}:/data   # remount + restart`);
  console.log(`  3. verify with: agenthost doctor --app ${app}`);
  console.log(`\nWhen you're happy, remove the old volume in the Fly dashboard (or keep it as a spare).`);
}
