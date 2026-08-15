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
import { minimalChildEnv } from "./child-env.js";

export function flyctlPath() {
  if (process.env.FLYCTL_PATH) return process.env.FLYCTL_PATH;
  if (process.platform === "win32") {
    const p = path.join(os.homedir(), ".fly", "bin", "flyctl.exe");
    if (fs.existsSync(p)) return p;
  } else {
    // Fly's official Mac/Linux curl installer drops flyctl in ~/.fly/bin but
    // doesn't add it to PATH until the shell is restarted -- so a fresh install
    // resolves to bare "flyctl" and dies with ENOENT. Check the known dir first.
    const p = path.join(os.homedir(), ".fly", "bin", "flyctl");
    if (fs.existsSync(p)) return p;
  }
  return "flyctl"; // resolved via PATH
}

// Runs flyctl and returns {code, stdout, stderr}. Never throws on a non-zero
// exit -- callers decide what's fatal, because flyctl's own exit codes are
// not reliable in every context (see spike-deploy.ps1 header comment).
export function run(args, opts = {}) {
  const { env: _ignoredEnv, ...spawnOpts } = opts;
  const res = spawnSync(flyctlPath(), args, {
    encoding: "utf8",
    ...spawnOpts,
    env: minimalChildEnv({ includeFlyAuth: true }),
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
    const { env: _ignoredEnv, ...spawnOpts } = opts;
    const child = spawn(flyctlPath(), args, {
      stdio: "inherit",
      ...spawnOpts,
      env: minimalChildEnv({ includeFlyAuth: true }),
    });
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

// Upgrade cleanup: old AgentHost releases could stage an encoded Claude
// credentials file under this Fly secret. Inventory and mutation are separate
// so callers can stage the root-side purge control before unsetting its proof.
export function retiredCredentialSecretExists(app, execute = run) {
  const listed = execute(["secrets", "list", "-a", app, "--json"]);
  if (listed.code !== 0) {
    throw new Error(`could not verify the retired credential-file secret:\n${listed.stderr || listed.stdout}`);
  }
  let names;
  try { names = JSON.parse(listed.stdout).map((s) => s.Name || s.name).filter(Boolean); }
  catch {
    throw new Error("could not verify the retired credential-file secret: Fly returned invalid JSON");
  }
  return names.includes("CLAUDE_CREDENTIALS");
}

// `--stage` applies the deletion with the same deploy. Callers invoke this only
// after the matching on-volume purge control has been staged successfully.
export function removeRetiredCredentialSecret(app, execute = run) {
  const res = execute(["secrets", "unset", "CLAUDE_CREDENTIALS", "--stage", "-a", app]);
  if (res.code === 0) return;
  const detail = res.stderr || res.stdout;
  if (/not found|does not exist|no secret/i.test(detail)) return;
  throw new Error(`credential-file secret cleanup failed:\n${detail}`);
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

const FLY_API_RESPONSE_MAX_BYTES = 64 * 1024;
const FLY_API_ERROR_DETAIL_MAX_CHARS = 300;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function redactFlyApiDetail(value, secretValues) {
  let detail = String(value || "unexpected response");
  const secrets = [...new Set(secretValues.map(String).filter(Boolean))]
    .sort((left, right) => right.length - left.length);
  for (const secret of secrets) {
    detail = detail.split(secret).join("[REDACTED]");
  }
  return detail.replace(/[\r\n\t]+/g, " ").trim().slice(0, FLY_API_ERROR_DETAIL_MAX_CHARS);
}

function flyApiErrorDetail(parsed, secretValues) {
  if (Array.isArray(parsed?.errors) && parsed.errors.length > 0) {
    const messages = parsed.errors.map((error) => {
      if (typeof error === "string") return error;
      if (isObject(error) && typeof error.message === "string") return error.message;
      return "GraphQL error without a message";
    });
    return redactFlyApiDetail(messages.join("; "), secretValues);
  }
  if (typeof parsed?.error === "string") return redactFlyApiDetail(parsed.error, secretValues);
  if (isObject(parsed?.error) && typeof parsed.error.message === "string") {
    return redactFlyApiDetail(parsed.error.message, secretValues);
  }
  if (typeof parsed?.message === "string") return redactFlyApiDetail(parsed.message, secretValues);
  return "unexpected response";
}

// Pure + exported for tests. A JSON body alone is not success: Fly must return
// HTTP success and the exact app confirmation requested by our mutation.
export function validateSetSecretsResponse(app, statusCode, raw, secretValues = []) {
  const body = String(raw || "");
  if (Buffer.byteLength(body) > FLY_API_RESPONSE_MAX_BYTES) {
    throw new Error(`Fly API setSecrets failed (HTTP ${statusCode ?? "unknown"}): response exceeded 65536 bytes`);
  }

  let parsed;
  try { parsed = JSON.parse(body); } catch {
    throw new Error(
      `Fly API setSecrets failed (HTTP ${statusCode ?? "unknown"}): invalid JSON response`,
    );
  }

  if (!Number.isInteger(statusCode) || statusCode < 200 || statusCode >= 300) {
    throw new Error(
      `Fly API setSecrets failed (HTTP ${statusCode ?? "unknown"}): `
      + flyApiErrorDetail(parsed, secretValues),
    );
  }
  if (parsed?.errors !== undefined && (!Array.isArray(parsed.errors) || parsed.errors.length > 0)) {
    throw new Error(`Fly API setSecrets failed: ${flyApiErrorDetail(parsed, secretValues)}`);
  }

  const result = parsed?.data?.setSecrets;
  if (!isObject(result) || !isObject(result.app) || result.app.name !== app) {
    throw new Error(
      `Fly API setSecrets failed (HTTP ${statusCode}): response did not confirm setSecrets for '${app}'`,
    );
  }
  return parsed.data;
}

// HTTPS POST to Fly's GraphQL API. For machines (v2) apps, API-set secrets
// apply on the next deploy -- the same semantics as `secrets import --stage`,
// and both deploy and sync run a deploy immediately after staging.
export function stageSecretsViaApi(app, pairsOrObj, {
  request = https.request,
  getAuthToken = flyAuthToken,
} = {}) {
  const pairs = Array.isArray(pairsOrObj)
    ? pairsOrObj
    : Object.entries(pairsOrObj).filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (pairs.length === 0) return;
  const token = getAuthToken();
  const body = JSON.stringify(buildSetSecretsMutation(app, pairs));
  const secretValues = pairs.map(([, value]) => String(value));
  return new Promise((resolve, reject) => {
    const req = request("https://api.fly.io/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 30000,
    }, (res) => {
      const chunks = [];
      let responseBytes = 0;
      let responseTooLarge = false;
      let responseSettled = false;
      const failResponse = (cause) => {
        if (responseSettled) return;
        responseSettled = true;
        reject(new Error(
          `Fly API setSecrets failed (HTTP ${res.statusCode ?? "unknown"}): `
          + redactFlyApiDetail(cause, secretValues),
        ));
      };
      res.on("data", (chunk) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        responseBytes += bytes.length;
        if (responseBytes <= FLY_API_RESPONSE_MAX_BYTES) chunks.push(bytes);
        else responseTooLarge = true;
      });
      res.on("aborted", () => failResponse("response was aborted before completion"));
      res.on("error", (error) => {
        failResponse(`response stream failed: ${error?.message || "unknown response error"}`);
      });
      res.on("close", () => failResponse("response closed before completion"));
      res.on("end", () => {
        if (responseSettled) return;
        responseSettled = true;
        if (responseTooLarge) {
          reject(new Error(
            `Fly API setSecrets failed (HTTP ${res.statusCode ?? "unknown"}): response exceeded 65536 bytes`,
          ));
          return;
        }
        try {
          resolve(validateSetSecretsResponse(
            app,
            res.statusCode,
            Buffer.concat(chunks).toString("utf8"),
            secretValues,
          ));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("timeout", () => { req.destroy(new Error("Fly API setSecrets timed out")); });
    req.on("error", reject);
    req.end(body);
  });
}

export function deployArgs(app, configPath, runtimeEnv = {}) {
  // The Dockerfile COPYs bare filenames (entrypoint.sh, gate.js, ...), so the
  // build context MUST be container/, where those files live. flyctl's first
  // positional arg sets the working directory = build context; without it,
  // context defaults to the shell's cwd (the repo root) and every COPY fails
  // with "not found". configPath already lives in container/, so its dir is it.
  const contextDir = path.dirname(configPath);
  const envArgs = Object.entries(runtimeEnv).flatMap(([name, value]) => ["--env", `${name}=${value}`]);
  return ["deploy", contextDir, "-a", app, "-c", configPath, "--remote-only", ...envArgs];
}

export async function deploy(app, configPath, runtimeEnv = {}) {
  return stream(deployArgs(app, configPath, runtimeEnv));
}

// Applies secrets previously staged through stageSecrets without rebuilding or
// repacking the container. Fly creates one release and restarts the app.
export function deployStagedSecrets(app, execute = run) {
  return execute(["secrets", "deploy", "-a", app]);
}

// Output-parsed, per the Windows lesson: never trust $LASTEXITCODE / exit code here.
//
// `machineId` targets ONE machine through `ssh console --machine <id>`.
// Without it flyctl picks a machine for you, which is fine for a
// read like `df -h` and wrong for a WRITE: Fly volumes are 1:1 with a machine,
// so a per-machine file written through an untargeted console lands on exactly
// one of them. `execute` is injectable the same way secretNames' is, so the
// argument list is testable without a Fly account.
export function sshConsoleOutput(app, command, machineId = null, execute = run) {
  const target = machineId ? ["--machine", String(machineId)] : [];
  const res = execute(["ssh", "console", ...target, "-a", app, "-C", command]);
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
export function secretNames(app, execute = run) {
  const res = execute(["secrets", "list", "-a", app, "--json"]);
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
