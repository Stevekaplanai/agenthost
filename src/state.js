// Local machine state only -- never migrated, never uploaded. Lets `open`,
// `status`, `logs`, `sync`, `destroy` work without re-typing --app every time,
// and lets `open` reconstruct the one-click login link (Fly secrets can't be
// read back once staged, so the CLI is the only place this password lives
// besides the container itself).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = path.join(os.homedir(), ".agenthost");

function appFile(app) {
  return path.join(DIR, `${app}.json`);
}

export function saveAppState(app, data) {
  fs.mkdirSync(DIR, { recursive: true });
  const existing = loadAppState(app) || {};
  const merged = { ...existing, ...data, app, updatedAt: new Date().toISOString() };
  fs.writeFileSync(appFile(app), JSON.stringify(merged, null, 2));
  saveLastApp(app);
  return merged;
}

export function loadAppState(app) {
  try {
    return JSON.parse(fs.readFileSync(appFile(app), "utf8"));
  } catch {
    return null;
  }
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
