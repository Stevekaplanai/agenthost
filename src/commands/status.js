import * as fly from "../fly.js";
import { resolveApp } from "./resolve-app.js";

export async function statusCommand(flags) {
  const app = resolveApp(flags);
  return fly.stream(["status", "-a", app]);
}
