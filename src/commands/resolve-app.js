import { loadLastApp } from "../state.js";

// Shared by status/open/logs/sync/destroy: use --app if given, else fall
// back to the last app this machine deployed.
export function resolveApp(flags) {
  const app = flags.app || loadLastApp();
  if (!app) throw new Error("no app given and no previous deploy found on this machine -- pass --app <name>");
  return app;
}
