// Thin, cross-platform wrapper around the flyctl binary. Mirrors the
// hard-won lessons in scripts/spike-deploy.ps1 exactly (see comments there):
// stderr carries routine warnings (never treat it as fatal), and `fly ssh
// console` exit codes are unreliable on Windows, so callers that need to
// confirm something landed must parse stdout, not trust the exit code.
import { spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";

export function flyctlPath() {
  if (process.env.FLYCTL_PATH) return process.env.FLYCTL_PATH;
  if (process.platform === "win32") {
    const p = path.join(os.homedir(), ".fly", "bin", "flyctl.exe");
    if (fs.existsSync(p)) return p;
  }
  return "flyctl"; // resolved via PATH
}

// Runs flyctl and returns {code, stdout, stderr}. Never throws on a non-zero
// exit -- callers decide what's fatal, because flyctl's own exit codes are
// not reliable in every context (see spike-deploy.ps1 header comment).
export function run(args, opts = {}) {
  const res = spawnSync(flyctlPath(), args, {
    encoding: "utf8",
    ...opts,
  });
  if (res.error) {
    if (res.error.code === "ENOENT") {
      throw new Error(
        `flyctl not found (looked for '${flyctlPath()}'). Install it: https://fly.io/docs/flyctl/install/`
      );
    }
    throw res.error;
  }
  return { code: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

// Streams output live (status/logs/deploy) instead of buffering. Resolves
// with the exit code; rejects only on a genuine spawn failure (missing binary).
export function stream(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(flyctlPath(), args, { stdio: "inherit", ...opts });
    child.on("error", (e) => {
      if (e.code === "ENOENT") {
        reject(new Error(`flyctl not found (looked for '${flyctlPath()}'). Install it: https://fly.io/docs/flyctl/install/`));
      } else reject(e);
    });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

export function appExists(app) {
  const res = run(["status", "-a", app]);
  return res.code === 0;
}

export function createApp(app, org) {
  const res = run(["apps", "create", app, "--org", org]);
  if (res.code === 0) return { created: true };
  if (appExists(app)) return { created: false, reused: true };
  // Fly app names are a GLOBAL namespace: the default agenthost-<username>
  // can be taken by someone else's app, which reads as a confusing failure.
  const detail = res.stderr || res.stdout;
  const hint = /taken|already|unavailable/i.test(detail)
    ? `\nThe name '${app}' is taken on Fly (app names are global). Re-run with --app <something-unique>, e.g. --app ${app}-${Math.random().toString(36).slice(2, 6)}`
    : "";
  throw new Error(`app '${app}' could not be created and does not exist:\n${detail}${hint}`);
}

export function volumeExists(app, name = "data") {
  const res = run(["volumes", "list", "-a", app]);
  if (res.code !== 0) throw new Error(`flyctl volumes list failed:\n${res.stderr || res.stdout}`);
  return res.stdout.includes(name);
}

export function createVolume(app, region, name = "data", sizeGb = 3) {
  const res = run(["volumes", "create", name, "--size", String(sizeGb), "--region", region, "-a", app, "--yes"]);
  if (res.code !== 0) throw new Error(`flyctl volumes create failed:\n${res.stderr || res.stdout}`);
}

// secrets: plain object of KEY -> value. Staged (applied on next deploy).
// Values must never ride argv (visible in the process table via ps/wmic for the
// life of the call) and never touch disk. Two transports honor that:
//   1. `secrets import` reading KEY=value pairs from STDIN -- works on
//      Linux/macOS, but flyctl on WINDOWS never sees piped stdin (same lesson
//      as `fly ssh sftp shell` in spike-deploy.ps1: it ran with empty input and
//      died with "requires at least one SECRET=VALUE pair" on Steve's machine).
//   2. Fly's GraphQL API over HTTPS, values in the JSON body -- used directly
//      on win32 and as the fallback if the stdin path fails anywhere else.
export function stageSecrets(app, secrets) {
  const pairs = Object.entries(secrets).filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (pairs.length === 0) return;
  if (process.platform === "win32") return stageSecretsViaApi(app, pairs);
  // dotenv-ish: KEY=value, one per line; multi-line values wrapped in double
  // quotes with embedded newlines preserved (flyctl secrets import parses this).
  const input = pairs.map(([k, v]) =>
    String(v).includes("\n") ? `${k}="${String(v).replace(/"/g, '\\"')}"` : `${k}=${v}`
  ).join("\n") + "\n";
  const res = run(["secrets", "import", "--stage", "-a", app], { input });
  if (res.code !== 0) {
    // Empty-stdin symptom on an exotic platform: fall through to the API path
    // before giving up. Any other failure is surfaced as-is.
    if (/at least one SECRET=VALUE/i.test(res.stderr || res.stdout)) return stageSecretsViaApi(app, pairs);
    throw new Error(`flyctl secrets import failed:\n${res.stderr || res.stdout}`);
  }
}

// The token flyctl itself is logged in with; no new auth surface.
function flyAuthToken() {
  const res = run(["auth", "token"]);
  const token = (res.stdout || "").trim();
  if (res.code !== 0 || !token) {
    throw new Error(`could not read the flyctl auth token (is flyctl logged in?):\n${res.stderr || res.stdout}`);
  }
  return token;
}

// Pure + exported for tests: the exact GraphQL payload flyctl's own
// `secrets set` sends. Secret values live in the JSON body only.
export function buildSetSecretsMutation(app, pairs) {
  return {
    query: `mutation($input: SetSecretsInput!) {
      setSecrets(input: $input) { release { id } app { name } }
    }`,
    variables: { input: { appId: app, secrets: pairs.map(([key, value]) => ({ key, value: String(value) })) } },
  };
}

// HTTPS POST to Fly's GraphQL API. For machines (v2) apps, API-set secrets
// apply on the next deploy -- the same semantics as `secrets import --stage`,
// and both deploy and sync run a deploy immediately after staging.
export function stageSecretsViaApi(app, pairsOrObj) {
  const pairs = Array.isArray(pairsOrObj)
    ? pairsOrObj
    : Object.entries(pairsOrObj).filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (pairs.length === 0) return;
  const token = flyAuthToken();
  const body = JSON.stringify(buildSetSecretsMutation(app, pairs));
  return new Promise((resolve, reject) => {
    const req = https.request("https://api.fly.io/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 30000,
    }, (res) => {
      let out = "";
      res.on("data", (c) => { out += c; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(out);
          if (parsed.errors?.length) return reject(new Error(`Fly API setSecrets failed: ${parsed.errors.map((e) => e.message).join("; ")}`));
          resolve(parsed.data);
        } catch {
          reject(new Error(`Fly API setSecrets: unexpected response (HTTP ${res.statusCode}): ${out.slice(0, 300)}`));
        }
      });
    });
    req.on("timeout", () => { req.destroy(new Error("Fly API setSecrets timed out")); });
    req.on("error", reject);
    req.end(body);
  });
}

export async function deploy(app, configPath) {
  // The Dockerfile COPYs bare filenames (entrypoint.sh, gate.js, ...), so the
  // build context MUST be container/, where those files live. flyctl's first
  // positional arg sets the working directory = build context; without it,
  // context defaults to the shell's cwd (the repo root) and every COPY fails
  // with "not found". configPath already lives in container/, so its dir is it.
  const contextDir = path.dirname(configPath);
  return stream(["deploy", contextDir, "-a", app, "-c", configPath, "--remote-only"]);
}

// Output-parsed, per the Windows lesson: never trust $LASTEXITCODE / exit code here.
export function sshConsoleOutput(app, command) {
  const res = run(["ssh", "console", "-a", app, "-C", command]);
  return res.stdout || "";
}

export function destroyApp(app) {
  const res = run(["apps", "destroy", app, "--yes"]);
  if (res.code !== 0) throw new Error(`flyctl apps destroy failed:\n${res.stderr || res.stdout}`);
}

// Machine IDs for an app (JSON is stable across flyctl versions; the plain-text
// table isn't). Empty list on any error so callers degrade gracefully.
export function machineIds(app) {
  const res = run(["machines", "list", "-a", app, "--json"]);
  if (res.code !== 0) return [];
  try { return JSON.parse(res.stdout).map((m) => m.id || m.ID).filter(Boolean); }
  catch { return []; }
}

// Restart one machine in place. `fly machine restart <id> -a <app>` reboots the
// container (fresh gate + agent, volume untouched) -- the fix for a wedged
// session or a transient stuck state. Per-id form works on every flyctl version.
export function restartMachine(app, id) {
  return run(["machine", "restart", id, "-a", app]);
}

// ---- doctor + snapshot/restore helpers --------------------------------------

// Secret NAMES only (flyctl never prints values). Used by `doctor` to confirm
// auth is configured without ever touching secret contents.
export function secretNames(app) {
  const res = run(["secrets", "list", "-a", app, "--json"]);
  if (res.code !== 0) return null; // caller reports "couldn't read secrets"
  try { return JSON.parse(res.stdout).map((s) => s.Name || s.name).filter(Boolean); }
  catch { return null; }
}

export function volumesJson(app) {
  const res = run(["volumes", "list", "-a", app, "--json"]);
  if (res.code !== 0) throw new Error(`flyctl volumes list failed:\n${res.stderr || res.stdout}`);
  try { return JSON.parse(res.stdout); } catch { return []; }
}

// The 'data' volume id (or the first volume) — snapshots are per-volume.
export function dataVolumeId(app) {
  const vols = volumesJson(app);
  const data = vols.find((v) => (v.name || v.Name) === "data") || vols[0];
  return data ? (data.id || data.ID) : null;
}

export function createSnapshot(volumeId) {
  const res = run(["volumes", "snapshots", "create", volumeId]);
  if (res.code !== 0) throw new Error(`flyctl volume snapshot failed:\n${res.stderr || res.stdout}`);
  return res.stdout;
}

export function snapshotsJson(volumeId) {
  const res = run(["volumes", "snapshots", "list", volumeId, "--json"]);
  if (res.code !== 0) throw new Error(`flyctl snapshots list failed:\n${res.stderr || res.stdout}`);
  try { return JSON.parse(res.stdout); } catch { return []; }
}

// Restore = create a NEW volume from a snapshot (never overwrites the live one).
export function createVolumeFromSnapshot(app, name, snapshotId, region, sizeGb = 3) {
  const res = run(["volumes", "create", name, "--snapshot-id", snapshotId,
    "--region", region, "--size", String(sizeGb), "-a", app, "--yes"]);
  if (res.code !== 0) throw new Error(`flyctl volume create-from-snapshot failed:\n${res.stderr || res.stdout}`);
  return res.stdout;
}
