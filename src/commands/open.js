import { appOrigin, loadOriginState } from "../state.js";
import { resolveApp } from "./resolve-app.js";

export async function openCommand(flags) {
  const app = resolveApp(flags);
  const state = loadOriginState(app);
  const url = appOrigin(app, state);
  console.log(url);
  if (!state?.ttydPassword) {
    console.log("(no saved login on this machine -- use the key shown when you ran `agenthost deploy`)");
  } else {
    console.log("Enter the access key you saved at deploy; credentials are never placed in the URL.");
  }
}
