// Local machine state only -- never uploaded. Lets `open`, `status`, `logs`,
// `sync`, and `destroy` work without re-typing --app every time. The saved
// password is never reconstructed into a URL; the credential-free login form
// sends it in a bounded POST body.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = path.join(os.homedir(), ".agenthost");
const O_DIRECTORY = fs.constants.O_DIRECTORY || 0;
const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0;

function appFile(app) {
  return path.join(DIR, `${app}.json`);
}

export function appStatePath(app) {
  return appFile(app);
}

function fsyncDirectory(directory) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    if (!fs.fstatSync(descriptor).isDirectory()) throw new Error("app-state parent is not a directory");
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (process.platform !== "win32" || !["EBADF", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"].includes(error?.code)) {
      throw error;
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function writeJsonAtomic(file, value) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2));
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
    fsyncDirectory(directory);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}

export function saveAppState(app, data) {
  const merged = updateAppState(app, data);
  saveLastApp(app);
  return merged;
}

// Used when an existing app record changes but the command must not also depend
// on the separate last-app pointer being writable (for example, key rotation).
export function updateAppState(app, data) {
  const existing = loadAppState(app) || {};
  const merged = { ...existing, ...data, app, updatedAt: new Date().toISOString() };
  writeJsonAtomic(appFile(app), merged);
  return merged;
}

export function loadAppState(app) {
  try {
    return JSON.parse(fs.readFileSync(appFile(app), "utf8"));
  } catch {
    return null;
  }
}

// Origin-bearing commands must distinguish a box that was never configured
// from state that exists but cannot be trusted. Falling back on a corrupt read
// could send an operator or a redeploy back to a retired hostname.
export function loadOriginState(app, file = appFile(app)) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`Could not read saved state for '${app}': ${error?.code || error?.message || "unknown read failure"}.`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Saved state for '${app}' is not valid JSON.`);
  }
}

// One public origin for every CLI surface. Existing customer boxes have no
// saved origin and keep their Fly hostname; boxes with a custom canonical host
// persist that origin in the same per-app state record.
export function appOrigin(app, state = loadOriginState(app)) {
  if (!state || state.origin === undefined || state.origin === null) {
    return `https://${app}.fly.dev`;
  }
  const value = String(state.origin).trim();
  let url;
  try { url = new URL(value); } catch { /* named below */ }
  if (!url || url.protocol !== "https:" || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`Saved origin for '${app}' must be an absolute HTTPS origin with no credentials, path, query, or fragment.`);
  }
  return url.origin;
}

export function deleteAppState(app) {
  fs.rmSync(appFile(app), { force: true });
}

// Every box this machine has deployed (one JSON per app; config.json is the
// last-app pointer, not a box). dir is injectable for tests.
export function listAppStates(dir = DIR) {
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const f of files) {
    if (!f.endsWith(".json") || f === "config.json") continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (parsed && parsed.app) out.push(parsed);
    } catch {} // unreadable state file: skip, never break the listing
  }
  return out.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
}

function configFile() {
  return path.join(DIR, "config.json");
}

export function saveLastApp(app) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify({ lastApp: app }, null, 2));
}

export function loadLastApp() {
  try {
    return JSON.parse(fs.readFileSync(configFile(), "utf8")).lastApp || null;
  } catch {
    return null;
  }
}
