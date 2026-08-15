import * as fly from "../fly.js";
import { deleteAppState } from "../state.js";
import { promptText } from "../util.js";
import { resolveApp } from "./resolve-app.js";

export async function destroyCommand(flags) {
  const app = resolveApp(flags);
  if (!flags.yes) {
    console.log(`This deletes the Fly app '${app}', its volume (your migrated harness), and its secrets. This cannot be undone.`);
    const typed = await promptText(`Type the app name to confirm ("${app}"):`);
    if (typed !== app) throw new Error("aborted -- typed name did not match");
  }
  fly.destroyApp(app);
  deleteAppState(app);
  console.log(`Destroyed '${app}'.`);
}
