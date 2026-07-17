// `agenthost onboard` -- the guided path from "installed the CLI" to "a box
// that carries everything the harness reaches for". Customers can't be asked
// to hand-build --include commands, so this wizard:
//   1. detects the harness (src/detect.js -- same detector deploy prints),
//   2. finds Obsidian vaults from Obsidian's own registry (never folder-name
//      guessing -- see detectObsidianVaults in src/detect.js),
//   3. finds settings.json hook commands that reach OUTSIDE ~/.claude, reusing
//      pack-lib's shipped hook-gap extractor (imported, not duplicated),
//   4. prints the exact `agenthost sync --include ...` command it proposes,
//   5. asks y/N PER include -- nothing is ever auto-included -- then one final
//      y/N on the full command before calling the sync flow in-process.
// --dry-run prints the plan and stops before any prompt or deploy.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractCloudHomePaths } from "../../scripts/pack-lib.mjs";
import { detectAgents, describeAgent, detectObsidianVaults } from "../detect.js";
import { confirm } from "../util.js";
import { syncCommand } from "./sync.js";
import { loadLastApp } from "../state.js";

// ---- pure helpers (exported for test/onboard.test.js) -------------------------

// Walk any hooks-shaped structure and normalize every string leaf. Lets us feed
// Windows backslash hook commands to pack-lib's forward-slash path extractor.
function normalizeStringLeaves(node, fn) {
  if (Array.isArray(node)) return node.map((v) => normalizeStringLeaves(v, fn));
  if (node !== null && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = normalizeStringLeaves(v, fn);
    return out;
  }
  return typeof node === "string" ? fn(node) : node;
}

// Home-relative, forward-slash paths referenced by settings.json hook commands
// that live OUTSIDE ~/.claude -- exactly the things sync won't carry unless
// --include'd. Reuses extractCloudHomePaths (the hook-gap detector pack.mjs
// ships) by pointing it at the LOCAL home instead of the cloud home.
export function hookScriptRefs(settings, home) {
  const homeFwd = String(home).replace(/\\/g, "/").replace(/\/+$/, "");
  const hooks = normalizeStringLeaves(settings?.hooks ?? {}, (s) => s.replace(/\\/g, "/"));
  return extractCloudHomePaths(hooks, homeFwd)
    .map((p) => p.slice(homeFwd.length + 1))
    .filter((rel) => !rel.startsWith(".claude/"));
}

function defaultStat(abs) {
  try { return fs.statSync(abs).isDirectory() ? "dir" : "file"; } catch { return null; }
}

// Build the --include proposal list from detected vaults + hook-referenced
// paths. `statPath` (abs -> "dir" | "file" | null) is injectable so tests need
// no real disk. Each proposal is { include, reason } where `include` is the
// HOME-RELATIVE forward-slash path handed to sync --include (pack.mjs resolves
// relative includes against home -- the documented contract).
// Vaults outside the home directory CANNOT migrate (pack.mjs only translates
// home paths); they land in `skipped` with the reason, never silently dropped.
export function buildIncludeProposals({ home, vaultPaths = [], hookRefs = [], statPath = defaultStat }) {
  const proposals = [];
  const skipped = [];
  const seen = new Set();
  const propose = (rel, reason) => {
    const key = rel.split(path.sep).join("/");
    if (seen.has(key)) return;
    seen.add(key);
    proposals.push({ include: key, reason });
  };

  for (const vp of vaultPaths) {
    const abs = path.resolve(vp);
    const rel = path.relative(home, abs);
    if (rel === "") { skipped.push({ path: vp, reason: "is your entire home directory -- too broad to migrate" }); continue; }
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      skipped.push({ path: vp, reason: "outside your home directory -- sync can only migrate home-relative paths" });
      continue;
    }
    if (statPath(abs) === null) { skipped.push({ path: vp, reason: "in Obsidian's registry but missing on disk" }); continue; }
    propose(rel, "Obsidian vault");
  }

  for (const ref of hookRefs) {
    const abs = path.join(home, ...ref.split("/"));
    const kind = statPath(abs);
    if (kind === null) { skipped.push({ path: ref, reason: "referenced by a settings.json hook but missing on disk" }); continue; }
    if (kind === "dir") { propose(ref, "referenced by a settings.json hook"); continue; }
    // A script file: propose its containing directory (hook scripts usually
    // import siblings) -- unless it sits directly in home, then just the file.
    const parent = ref.split("/").slice(0, -1).join("/");
    if (parent) propose(parent, `contains ${ref.split("/").pop()} (referenced by a settings.json hook)`);
    else propose(ref, "referenced by a settings.json hook");
  }

  // Drop proposals nested inside another proposal -- the ancestor's copy
  // already carries them (a vault that contains a hook script yields one line).
  const kept = proposals.filter((p) => !proposals.some((q) => q !== p && (p.include + "/").startsWith(q.include + "/")));
  return { proposals: kept, skipped };
}

// The exact command the wizard proposes -- pasteable as-is. Includes are
// quoted so paths with spaces survive every shell we care about.
export function formatSyncCommand({ app, includes = [] }) {
  const parts = ["agenthost sync"];
  if (app) parts.push("--app", app);
  for (const inc of includes) parts.push("--include", JSON.stringify(inc));
  return parts.join(" ");
}

// ---- the wizard ----------------------------------------------------------------

// env is injectable for tests ({ home, platform, appData }); flags may carry
// --app / --dry-run plus anything sync understands (forwarded on confirm).
export async function onboardCommand(flags, env = {}) {
  const home = env.home ?? os.homedir();
  const platform = env.platform ?? process.platform;
  const appData = env.appData ?? process.env.APPDATA;
  const dryRun = Boolean(flags["dry-run"]);

  console.log("agenthost onboard -- find what your harness reaches for, build the sync that carries it.\n");

  // 1. Which agent harnesses live here (same detector deploy prints).
  const agents = detectAgents(home);
  for (const line of agents.map(describeAgent).filter(Boolean)) console.log("  " + line);
  const claude = agents.find((a) => a.key === "claude");
  if (!claude?.present) {
    console.error(`\nNo Claude Code harness found at ${path.join(home, ".claude")}. Install Claude Code, run it once, then re-run onboard.`);
    return 1;
  }

  // 2. Obsidian vaults, from Obsidian's own registry.
  const { registry, vaults } = detectObsidianVaults({ home, platform, appData });
  console.log(registry
    ? `\nObsidian registry: ${registry} -- ${vaults.length} vault(s) on record`
    : "\nNo Obsidian registry found -- skipping vault detection.");

  // 3. Hook commands in settings.json that reach outside ~/.claude.
  let hookRefs = [];
  const settingsPath = path.join(home, ".claude", "settings.json");
  if (fs.existsSync(settingsPath)) {
    try { hookRefs = hookScriptRefs(JSON.parse(fs.readFileSync(settingsPath, "utf8")), home); }
    catch { console.log(`Could not parse ${settingsPath} -- skipping the hook scan.`); }
  }
  if (hookRefs.length) console.log(`Hooks reference ${hookRefs.length} path(s) outside ~/.claude.`);

  // 4. The proposal.
  const { proposals, skipped } = buildIncludeProposals({ home, vaultPaths: vaults, hookRefs });
  for (const s of skipped) console.log(`  cannot include ${s.path}: ${s.reason}`);

  const app = flags.app || loadLastApp() || null;
  console.log("\nProposed command:\n");
  console.log("  " + formatSyncCommand({ app, includes: proposals.map((p) => p.include) }) + "\n");
  for (const p of proposals) console.log(`  --include "${p.include}"  (${p.reason})`);
  if (!proposals.length) console.log("  (nothing outside ~/.claude detected -- a plain sync covers you)");

  if (dryRun) {
    console.log("\n[dry-run] plan only -- nothing was packed or deployed.");
    return 0;
  }
  if (!app) {
    console.log("\nNo deployed box found on this machine. Deploy first (agenthost deploy --org <fly-org>),");
    console.log("or re-run with --app <name>. The --include flags above work on deploy too.");
    return 1;
  }
  if (!process.stdin.isTTY) {
    console.log("\nNot an interactive terminal, so nothing will be included or run without your explicit yes.");
    console.log("Re-run from a terminal, use --dry-run to see the plan, or paste the command above yourself.");
    return 1;
  }

  // 5. y/N per include. Explicit yes required; anything else leaves it out.
  const confirmed = [];
  for (const p of proposals) {
    if (await confirm(`Include ${p.include} -- ${p.reason}? [y/N]`)) confirmed.push(p.include);
    else console.log(`  leaving out ${p.include}`);
  }
  // Includes the user typed on the onboard command line are already explicit.
  for (const inc of flags.include || []) if (!confirmed.includes(inc)) confirmed.push(inc);

  // 6. One final gate on the exact command, then the real sync flow in-process.
  const finalCmd = formatSyncCommand({ app, includes: confirmed });
  console.log(`\nWill run: ${finalCmd}`);
  if (!(await confirm("Run it now? [y/N]"))) {
    console.log("Nothing run. Paste the command above whenever you're ready.");
    return 0;
  }
  return syncCommand({ ...flags, app, include: confirmed });
}
