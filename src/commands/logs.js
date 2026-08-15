import * as fly from "../fly.js";
import { resolveApp } from "./resolve-app.js";

export async function logsCommand(flags) {
  const app = resolveApp(flags);
  return fly.stream(["logs", "-a", app]);
}
