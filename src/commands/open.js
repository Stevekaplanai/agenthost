import { loadAppState } from "../state.js";
import { resolveApp } from "./resolve-app.js";

export async function openCommand(flags) {
  const app = resolveApp(flags);
  const state = loadAppState(app);
  const url = `https://${app}.fly.dev`;
  if (state?.ttydPassword) {
    console.log(`${url}/?key=${state.ttydPassword}`);
  } else {
    console.log(url);
    console.log("(no saved login on this machine -- use the key shown when you ran `agenthost deploy`)");
  }
}
