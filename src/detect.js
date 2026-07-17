// Agent harness detection. One place that knows which local AI agent setups
// exist on this machine and how far AgentHost supports each. deploy prints
// this so users learn what will (and won't) migrate before anything runs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// support: "full" ships today; "beta" packs behind an explicit --agent flag;
// "detect" is presence-reporting only (waitlist).
export const AGENTS = [
  { key: "claude", name: "Claude Code", dir: ".claude", support: "full" },
  { key: "hermes", name: "Hermes", dir: ".hermes", support: "beta" },
  { key: "codex", name: "Codex", dir: ".codex", support: "detect" },
  { key: "openclaw", name: "OpenClaw", dir: ".openclaw", support: "detect" },
];

export function detectAgents(home = os.homedir()) {
  return AGENTS.map((a) => ({
    ...a,
    home: path.join(home, a.dir),
    present: fs.existsSync(path.join(home, a.dir)),
  }));
}

export function describeAgent(a) {
  if (!a.present) return null;
  switch (a.support) {
    case "full":
      return `${a.name}: detected -- full migration`;
    case "beta":
      return `${a.name}: detected -- beta; migrate with --agent ${a.key}`;
    default:
      return `${a.name}: detected -- not yet supported (waitlist: agenthost.space)`;
  }
}

// ---- Obsidian vault registry --------------------------------------------------
// Obsidian keeps a per-machine registry of every vault it has opened, so vaults
// are DETECTED from Obsidian's own record -- never guessed from folder names:
//   Windows:  %APPDATA%/obsidian/obsidian.json
//   Linux:    ~/.config/obsidian/obsidian.json
//   macOS:    ~/Library/Application Support/obsidian/obsidian.json
//             (~/.config is also checked on mac -- some installs use it)
// The file's "vaults" object maps ids -> { path, ts, open }.

export function obsidianRegistryCandidates({ home = os.homedir(), platform = process.platform, appData = process.env.APPDATA } = {}) {
  const out = [];
  if (platform === "win32" && appData) out.push(path.join(appData, "obsidian", "obsidian.json"));
  out.push(path.join(home, ".config", "obsidian", "obsidian.json"));
  if (platform === "darwin") out.push(path.join(home, "Library", "Application Support", "obsidian", "obsidian.json"));
  return out;
}

// Registry text -> array of vault paths. Tolerant by design: bad JSON, a
// missing "vaults" object, or entries without a path yield [] / get skipped --
// onboarding must never crash because Obsidian's file is mid-write or old.
export function parseObsidianVaults(text) {
  let obj;
  try { obj = JSON.parse(text); } catch { return []; }
  const vaults = obj && typeof obj === "object" ? obj.vaults : null;
  if (!vaults || typeof vaults !== "object" || Array.isArray(vaults)) return [];
  return Object.values(vaults)
    .map((v) => (v && typeof v === "object" && typeof v.path === "string" && v.path ? v.path : null))
    .filter(Boolean);
}

// First readable registry wins. Returns { registry, vaults } -- registry null
// when Obsidian isn't installed (vaults then []).
export function detectObsidianVaults({ home = os.homedir(), platform = process.platform, appData = process.env.APPDATA } = {}) {
  for (const reg of obsidianRegistryCandidates({ home, platform, appData })) {
    try {
      if (!fs.existsSync(reg)) continue;
      return { registry: reg, vaults: parseObsidianVaults(fs.readFileSync(reg, "utf8")) };
    } catch { /* unreadable registry: keep looking */ }
  }
  return { registry: null, vaults: [] };
}
