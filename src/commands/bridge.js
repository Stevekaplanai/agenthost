import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import https from "node:https";
import path from "node:path";
import * as fly from "../fly.js";
import { resolveApp } from "./resolve-app.js";

// `agenthost bridge <port>` -- connect your box to your desktop. Publishes a
// local port (an Obsidian vault API, a dev server, any local HTTP service) at
// a stable public HTTPS URL via Tailscale Funnel, then hands that URL -- and
// an optional access token -- to the box as Fly secrets (BRIDGE_URL /
// BRIDGE_TOKEN). start.sh writes ~/BRIDGE.md on the box so the agent there
// discovers the bridge on its next boot and can call home.
//
// Security shape (same invariants as everything else):
//   - No AgentHost server in the path: Tailscale carries the traffic, the
//     token goes laptop -> Fly's encrypted store, we never see or store it.
//   - The public URL is reachable by anyone who knows it; the LOCAL SERVICE'S
//     OWN AUTH is the lock (e.g. Obsidian's REST API requires a Bearer key on
//     every real endpoint). The CLI refuses to bridge without --token unless
//     the user passes --no-token to attest the service has its own auth story.
//   - Teardown is one command: `agenthost bridge --off`.

// ---- pure helpers (exported for tests) --------------------------------------

// The "not enabled" response includes a one-click approval URL. Live shape:
//   Funnel is not enabled on your tailnet.
//   To enable, visit:
//
//            https://login.tailscale.com/f/funnel?node=xxxx
export function parseFunnelApprovalUrl(output) {
  if (!/not enabled/i.test(output || "")) return null;
  const m = (output || "").match(/https:\/\/login\.tailscale\.com\/\S+/);
  return m ? m[0] : null;
}

// `tailscale funnel status` live shape (one host block per served URL):
//   https://desktop-xxxx.tailxxxx.ts.net (Funnel on)
//   |-- / proxy http://127.0.0.1:27123
// Returns the public URL whose proxy target matches `port`, else null.
export function parseFunnelUrl(statusOutput, port) {
  let current = null;
  for (const line of (statusOutput || "").split("\n")) {
    const host = line.match(/^(https:\/\/\S+)\s+\(Funnel on\)/);
    if (host) { current = host[1]; continue; }
    if (current && new RegExp(`proxy https?://127\\.0\\.0\\.1:${port}(?:\\D|$)`).test(line)) {
      return current;
    }
  }
  return null;
}

export function validateBridgePort(raw) {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`'${raw}' is not a valid port. Usage: agenthost bridge <port> [--app <name>] [--token <value>]`);
  }
  return port;
}

// ---- tailscale plumbing ------------------------------------------------------

function tailscalePath() {
  if (process.env.TAILSCALE_PATH) return process.env.TAILSCALE_PATH;
  if (process.platform === "win32") {
    const p = path.join("C:", "Program Files", "Tailscale", "tailscale.exe");
    if (fs.existsSync(p)) return p;
  }
  return "tailscale"; // resolved via PATH
}

function ts(args) {
  const res = spawnSync(tailscalePath(), args, { encoding: "utf8" });
  if (res.error) {
    if (res.error.code === "ENOENT") {
      throw new Error(
        "Tailscale is required for the bridge (it carries the tunnel; free for personal use).\n" +
        "  Windows: winget install tailscale.tailscale\n" +
        "  Mac:     brew install tailscale\n" +
        "Then run `tailscale login` once and re-run this command."
      );
    }
    throw res.error;
  }
  return { code: res.status ?? 1, out: (res.stdout || "") + (res.stderr || "") };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// TCP-connect probe: is anything listening locally? Protocol-agnostic on
// purpose (the target may be HTTP or HTTPS); we only care that the funnel
// will have something to proxy to.
function localPortListening(port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port, timeout: timeoutMs });
    sock.on("connect", () => { sock.destroy(); resolve(true); });
    sock.on("timeout", () => { sock.destroy(); resolve(false); });
    sock.on("error", () => resolve(false));
  });
}

// Public-side probe: ANY http response proves the tunnel is live (the status
// code belongs to the user's service, not to us). First-time funnels can take
// a little while to provision certs/DNS, so callers retry.
function publicUrlAnswers(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => { res.resume(); resolve(true); });
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
  });
}

// ---- the command -------------------------------------------------------------

export async function bridgeCommand(flags) {
  const app = resolveApp(flags);

  if (flags.status) {
    const st = ts(["funnel", "status"]);
    console.log(st.out.trim() || "(no funnel running)");
    const names = fly.secretNames(app);
    console.log(`\nBox '${app}': BRIDGE_URL ${names.includes("BRIDGE_URL") ? "set" : "not set"}, BRIDGE_TOKEN ${names.includes("BRIDGE_TOKEN") ? "set" : "not set"}`);
    return;
  }

  if (flags.off) {
    console.log("Tearing down the bridge...");
    ts(["funnel", "--https=443", "off"]);
    const res = fly.run(["secrets", "unset", "BRIDGE_URL", "BRIDGE_TOKEN", "-a", app]);
    // "not found" just means they were never set -- that's a clean teardown too.
    if (res.code !== 0 && !/not found|No secrets/i.test(res.stderr || res.stdout)) {
      throw new Error(`could not unset bridge secrets:\n${res.stderr || res.stdout}`);
    }
    console.log(`Bridge off. The funnel is closed and '${app}' no longer carries BRIDGE_URL/BRIDGE_TOKEN.`);
    console.log("The box picks that up on its next restart (agenthost restart).");
    return;
  }

  const port = validateBridgePort(flags._?.[0] ?? flags.port);

  // The public URL is the lock's DOOR; the token is the LOCK. Refuse to open
  // a door with no lock unless the user says their service brings its own.
  const token = flags.token;
  if (!token && !flags["no-token"]) {
    throw new Error(
      "The bridge URL is public -- the local service's own auth is what protects it.\n" +
      "Pass --token <value> (stored only in Fly's encrypted store; the box uses it as BRIDGE_TOKEN),\n" +
      "or pass --no-token if the service on port " + port + " enforces its own authentication."
    );
  }

  if (!(await localPortListening(port))) {
    console.log(`WARNING: nothing is listening on 127.0.0.1:${port} right now. The bridge will be up but dead-ended until that service runs.`);
  }

  // Bring the funnel up. First run on a tailnet needs a one-time approval in
  // the Tailscale admin console -- surface the link and wait, because the
  // approval propagates in seconds and nobody wants to re-run the command.
  console.log(`Publishing 127.0.0.1:${port} via Tailscale Funnel...`);
  let up = ts(["funnel", "--bg", String(port)]);
  const approval = parseFunnelApprovalUrl(up.out);
  if (approval) {
    console.log("\nOne-time step: Funnel needs to be enabled on your tailnet (you must be the admin).");
    console.log(`Open and approve: ${approval}`);
    console.log("(If the page doesn't finish it, add a nodeAttrs entry with attr [\"funnel\"] at login.tailscale.com/admin/acls.)");
    console.log("Waiting for the approval to reach this machine (up to 3 minutes)...");
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      await sleep(5000);
      up = ts(["funnel", "--bg", String(port)]);
      if (!parseFunnelApprovalUrl(up.out)) break;
    }
    if (parseFunnelApprovalUrl(up.out)) {
      throw new Error("Funnel still isn't enabled on the tailnet. Approve it, then re-run: agenthost bridge " + port);
    }
  }
  if (up.code !== 0) throw new Error(`tailscale funnel failed:\n${up.out}`);

  const status = ts(["funnel", "status"]);
  const url = parseFunnelUrl(status.out, port);
  if (!url) throw new Error(`funnel started but no public URL found for port ${port} in:\n${status.out}`);
  console.log(`Public URL: ${url}`);

  // First-time funnels provision certs/DNS lazily; give it a short grace loop.
  let live = false;
  for (let i = 0; i < 6 && !live; i++) {
    live = await publicUrlAnswers(url);
    if (!live) await sleep(5000);
  }
  console.log(live
    ? "Verified: the URL answers from the public internet."
    : "The URL isn't answering yet (first-time cert/DNS setup can lag a minute) -- it usually goes live shortly.");

  // Hand the bridge to the box: values go through Fly's encrypted store (never
  // argv). stageSecrets STAGES -- a plain machine restart does NOT apply staged
  // secrets (found live on the dogfood box: restart left env without
  // BRIDGE_URL). `secrets deploy` is what pushes them into the machines,
  // restarting them; start.sh then writes ~/BRIDGE.md so the agent on the box
  // knows the bridge exists without being told.
  console.log(`Handing the bridge to '${app}'...`);
  fly.stageSecrets(app, { BRIDGE_URL: url, ...(token ? { BRIDGE_TOKEN: token } : {}) });
  const dep = fly.run(["secrets", "deploy", "-a", app]);
  if (dep.code !== 0 && !/no.*staged|already/i.test(dep.stderr || dep.stdout)) {
    throw new Error(`bridge secrets staged but could not be deployed to the box:\n${dep.stderr || dep.stdout}\nRe-run, or apply them with: flyctl secrets deploy -a ${app}`);
  }
  console.log(`Done. '${app}' is restarting with the bridge (its agent will see ~/BRIDGE.md and $BRIDGE_URL${token ? " + $BRIDGE_TOKEN" : ""}).`);
  console.log("\nKeep in mind:");
  console.log(`  - This machine must be on (Tailscale runs the tunnel) and the service on :${port} running.`);
  console.log("  - Turn it off any time: agenthost bridge --off");
  return { url, app };
}
