import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as fly from "../fly.js";
import { packHarness } from "../pack.js";
import { saveAppState, loadAppState } from "../state.js";
import { detectHarness, randomPassword, confirm } from "../util.js";
import { stageDeployFiles, cleanupDeployFiles } from "../deploy-container.js";
import { detectAgents, describeAgent } from "../detect.js";
import { buildEnvSecrets } from "../env-secrets.js";
import { enforceLegalMode } from "../legal-mode.js";

const CONTAINER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "container");

export async function deployCommand(flags) {
  const app = flags.app || `agenthost-${os.userInfo().username}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const existing = loadAppState(app);
  const org = flags.org || existing?.org;
  const region = flags.region || existing?.region || "iad";
  const repos = (flags.repos || "").split(",").map((s) => s.trim()).filter(Boolean);
  const dryRun = Boolean(flags["dry-run"]);
  const yes = Boolean(flags.yes);

  if (!org) throw new Error("--org is required the first time you deploy an app (your Fly org slug: `flyctl orgs list`)");

  // Legal Mode gates BEFORE any expensive work: --legal implies the legal skill
  // pack and (on a subscription token) the training-opt-out attestation.
  const legalSecrets = await enforceLegalMode(flags);
  const packs = [...(flags.pack || []), ...(flags.legal && !(flags.pack || []).includes("legal") ? ["legal"] : [])];

  detectHarness();
  for (const line of detectAgents().map(describeAgent).filter(Boolean)) console.log(line);

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthost-pack-"));
  console.log("Packing harness...");
  const { manifest, compatReport } = packHarness({
    outDir,
    dryRun,
    include: flags.include || [],
    agent: flags.agent,
    withWhatsapp: Boolean(flags["with-whatsapp"]),
    withKanban: Boolean(flags["with-kanban"]),
    packs,
  });
  console.log(`Packed ${manifest.files} files (${(manifest.bytes / 1024 / 1024).toFixed(1)} MB). Secrets redacted: ${manifest.redactedSecrets.length}.`);
  for (const p of manifest.packs || []) {
    console.log(`Preloaded pack '${p.name}': ${p.skills.length} skill(s) (${p.skills.join(", ")}).`);
  }
  const disabled = manifest.mcp.filter((m) => m.verdict.startsWith("DISABLED")).length;
  if (disabled) console.log(`${disabled} MCP server(s) disabled (localhost-only, unreachable from the cloud).`);
  if (manifest.hookGaps?.length) {
    console.log(`\n*** ${manifest.hookGaps.length} hook(s) reference paths that will NOT exist on the box:`);
    for (const h of manifest.hookGaps) console.log(`***   ${h}`);
  }
  if (manifest.possibleSecrets.length) {
    console.log(`\n*** ${manifest.possibleSecrets.length} possible secret(s) found in packed files that were NOT auto-redacted.`);
    console.log(`*** Review: ${path.join(outDir, "compat-report.md")}`);
    if (!yes) {
      const ok = await confirm("Continue anyway? [y/N]");
      if (!ok) throw new Error("aborted -- review the compat report and re-run with --yes once you're satisfied");
    }
  }

  let ttydPassword = existing?.ttydPassword;
  if (!ttydPassword) {
    ttydPassword = randomPassword();
    console.log(`\nTerminal login (save this now): agent / ${ttydPassword}`);
  }

  const envSecrets = buildEnvSecrets(repos, flags.env || []);
  const hermesEnvSecrets = flags["hermes-secrets-from-local"] ? readHermesLocalEnv() : {};
  if (flags["hermes-secrets-from-local"]) {
    // Values go laptop -> Fly's encrypted store directly; never printed, never written to disk.
    console.log(`Staging ${Object.keys(hermesEnvSecrets).length} Hermes secret(s) from ~/.hermes/.env as HERMESENV_<KEY>.`);
  }
  const authSecrets = flags["migrate-auth"] ? readLocalCredentials() : {};
  if (flags["migrate-auth"]) {
    // Same invariant-safe path as Hermes secrets: the credentials file is read
    // locally, base64'd, and handed straight to Fly's encrypted store -- it is
    // NEVER placed in the harness tarball, never printed, never written to disk.
    console.log("Staging ~/.claude/.credentials.json (MCP OAuth tokens + agent auth) as the CLAUDE_CREDENTIALS Fly secret. Some host-bound tokens may still need re-auth on the box.");
  }
  const secrets = {
    TTYD_PASSWORD: ttydPassword,
    CLAUDE_CODE_OAUTH_TOKEN: flags["oauth-token"],
    ANTHROPIC_API_KEY: flags["oauth-token"] ? undefined : flags["anthropic-key"],
    GITHUB_TOKEN: flags["github-token"],
    REPOS: repos.length ? repos.join(",") : undefined,
    ...envSecrets,
    ...hermesEnvSecrets,
    ...authSecrets,
    ...legalSecrets,
  };

  if (dryRun) {
    console.log(`\n[dry-run] would create/reuse app '${app}' in org '${org}' (${region})`);
    console.log(`[dry-run] would create/reuse volume 'data' (3GB, ${region})`);
    console.log(`[dry-run] would stage secrets: ${Object.keys(secrets).filter((k) => secrets[k] !== undefined).join(", ")}`);
    console.log(`[dry-run] would run: flyctl deploy -a ${app} -c container/fly.toml.deploy --remote-only`);
    console.log("[dry-run] no changes made to Fly.io");
    return { app, dryRun: true, manifest };
  }

  console.log(`\n== 1/5 app '${app}' (org ${org}) ==`);
  fly.createApp(app, org);

  console.log("== 2/5 volume 'data' ==");
  if (!fly.volumeExists(app)) fly.createVolume(app, region);
  else console.log("volume 'data' already exists, continuing");

  console.log("== 3/5 secrets (staged; apply on deploy) ==");
  await fly.stageSecrets(app, secrets);
  if (!secrets.CLAUDE_CODE_OAUTH_TOKEN && !secrets.ANTHROPIC_API_KEY) {
    console.log("note: no Claude auth passed; container boots a shell. Activate later with:");
    console.log(`  flyctl secrets set CLAUDE_CODE_OAUTH_TOKEN=<claude setup-token output> -a ${app}`);
  }

  console.log("== 4/5 deploy (remote build; harness rides along as an image layer) ==");
  const staged = stageDeployFiles({ containerDir: CONTAINER_DIR, app, harnessTarball: manifest.tarball });
  try {
    const code = await fly.deploy(app, staged.flyTomlDeploy);
    if (code !== 0) throw new Error(`flyctl deploy exited ${code}`);
  } finally {
    cleanupDeployFiles(staged);
  }

  console.log("== 5/5 verify the harness landed ==");
  // -a: start.sh deletes the tarball once extracted, so on a fast boot the
  // proof it landed is the dotfile marker, not the tarball itself.
  const listing = fly.sshConsoleOutput(app, "ls -la /data/ /data/home/agent/");
  console.log(listing);
  if (staged.harnessAttached && !listing.includes("harness.tar.gz") && !listing.includes(".harness-extracted")) {
    console.log("WARNING: harness not visible on the volume (no tarball, no .harness-extracted marker); check `flyctl logs -a " + app + "`");
  }

  saveAppState(app, { org, region, ttydPassword, repos });

  const url = `https://${app}.fly.dev`;
  console.log(`\nURL:   ${url}`);
  console.log(`Open:  ${url}/?key=${ttydPassword}  (sets a cookie once; bookmark or install to your phone home screen)`);
  return { app, url, manifest };
}

// --migrate-auth: read the LOCAL ~/.claude/.credentials.json (Claude Code's
// MCP OAuth tokens + agent auth) and stage it, base64'd, as the CLAUDE_CREDENTIALS
// Fly secret. start.sh decodes it back to ~/.claude/.credentials.json (0600).
// This is the ONE explicit, opt-in exception to "credential files never
// migrate": the file still never enters the harness tarball; it goes laptop ->
// Fly's encrypted store directly, exactly like the Hermes secrets flow.
export function readLocalCredentials(home = os.homedir()) {
  const credPath = path.join(home, ".claude", ".credentials.json");
  if (!fs.existsSync(credPath)) {
    throw new Error(`--migrate-auth: ${credPath} not found (nothing to migrate; log in / auth an MCP locally first)`);
  }
  const raw = fs.readFileSync(credPath); // Buffer; may hold non-UTF8-safe bytes
  try { JSON.parse(raw.toString("utf8")); }
  catch { throw new Error(`--migrate-auth: ${credPath} is not valid JSON; refusing to migrate a corrupt credentials file`); }
  return { CLAUDE_CREDENTIALS: raw.toString("base64") };
}

// --hermes-secrets-from-local: read the LOCAL ~/.hermes/.env and stage each
// non-comment KEY=value as Fly secret HERMESENV_<KEY>. Values are kept raw
// (they round-trip back into ~/.hermes/.env on the box) and are never printed
// or written to disk -- laptop -> Fly's encrypted store only (core invariant).
function readHermesLocalEnv() {
  const envPath = path.join(os.homedir(), ".hermes", ".env");
  if (!fs.existsSync(envPath)) {
    throw new Error(`--hermes-secrets-from-local: ${envPath} not found`);
  }
  const secrets = {};
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1);
    // Multi-line quoted value (PEM key, JSON blob): gather continuation lines
    // so the whole credential reaches Fly, not just its first line.
    const q = value.trim()[0];
    if ((q === '"' || q === "'") && value.trim().indexOf(q, 1) === -1) {
      const parts = [value];
      while (i + 1 < lines.length) {
        i++; parts.push(lines[i]);
        if (lines[i].includes(q)) break;
      }
      value = parts.join("\n");
    }
    // Strip surrounding quotes so the value round-trips as Hermes wrote it.
    const t = value.trim();
    if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0]) value = t.slice(1, -1);
    secrets[`HERMESENV_${key}`] = value;
  }
  return secrets;
}
